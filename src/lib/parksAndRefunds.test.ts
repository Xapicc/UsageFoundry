import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, it } from "node:test";
import type { BudgetPolicy } from "./budget";
import type { Interrupt } from "./orchestrator";

/**
 * Which counter each park and each refund is charged to, driven through the
 * real run loop.
 *
 * `MAX_PAUSES_PER_RUN` bounds how many refusals one run may wait out, and the
 * count it reads is written in exactly one place: the `paused` branch of
 * `startRun`'s ending. A guard park and a refusal park reach that branch
 * identically, so which of them advances the count is decided by a flag set
 * several hundred lines earlier — and both ways of getting it wrong are silent.
 * Charged for guard parks, a run that stepped aside at its own 5-hour guard is
 * failed at its first real wall "out of waits" it never took. Never charged at
 * all, a misread refusal re-parks for ever.
 *
 * The refund of a cycle the live guard cut is the same kind of silence from
 * the other side. It is taken in the post-cycle checkpoint and counted in a
 * frame that every cut ends, so a bound kept anywhere but the row is a bound
 * that resets at each park — and a run that is always cut, always refunded and
 * always parked never reaches its cycle cap. What that looks like from outside
 * is an ordinary parked run. The context ceiling's early end is the same refund
 * on a count of its own, and it was held in exactly such a frame.
 *
 * `orchestrator.test.ts` cannot say either, because nothing there spawns: it
 * pins `CLAUDE_BIN` at a path that does not exist precisely so a regression
 * reaching a spawn is a failed test rather than a billed one. So this drives
 * whole segments of a real run against `shutdown.test.ts`'s stubbed child, and
 * reads the row each one leaves.
 *
 * Its own file for that file's reasons: `config.ts` fixes `DATA_DIR` and
 * `CLAUDE_HOME` at module load, and `child_process.spawn` is replaced here for
 * the life of the process, which is not something to leave standing in a file
 * other cases share.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-parks-")));
fs.mkdirSync(path.join(tmp, "claude", "projects"), { recursive: true });

process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
// Pinned rather than left to fall back to CLAUDE_HOME, `cycleDeadline.test.ts`'s
// rule: an ambient one puts a real OAuth token within reach of anything here
// that reads plan usage.
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");
process.env.WORKSPACE_ROOT = path.join(tmp, "workspace");
delete process.env.WORKSPACE_ROOTS;
// A path that does not exist, so a spawn the stub below fails to catch is a
// failed test rather than a billed one.
process.env.CLAUDE_BIN = path.join(tmp, "no-such-claude");

const config = require("./config") as typeof import("./config");
assert.equal(
  config.DATA_DIR,
  process.env.DATA_DIR,
  "config was already loaded by another test file in this process — refusing to " +
    "run against the real database",
);

const {
  createRun,
  getRun,
  MAX_EARLY_ENDS_PER_RUN,
  MAX_PAUSES_PER_RUN,
  reopenRun,
  resumeRun,
  stopRun,
} = require("./orchestrator") as typeof import("./orchestrator");
const { db } = require("./db") as typeof import("./db");

/**
 * What the stubbed child does on one work cycle.
 *
 * `guard-pause` is what `liveGuardTick` leaves when a `live-resume` run crosses
 * its 5-hour fraction: a pause on the interrupt map and a child that dies
 * without a `result`. Written to the map directly rather than reached through
 * the ticker, because a real crossing needs a 5-hour reading, a numeric ceiling
 * and a tick that lands inside the cycle — and what is under test is what the
 * loop charges for the park, not how the ticker decided on it.
 *
 * `refusal` is the CLI's own account of the wall: a non-success `result` whose
 * text `isUsageLimit` matches, and a non-zero exit.
 *
 * `prune` is what `checkContextCeilings` leaves when a cycle crosses the context
 * ceiling, for `guard-pause`'s reason: the `prune` interrupt, the one kind the
 * loop carries on from.
 */
type Cycle = "guard-pause" | "refusal" | "prune";

/** The cycles still to come, for the one run a case has in flight. */
let script: Cycle[] = [];
let scriptedRun = "";
/** Work cycles spawned for that run. */
let spawned = 0;

function interrupts(): Map<string, Interrupt> {
  return (globalThis as unknown as { __ufInterrupts: Map<string, Interrupt> })
    .__ufInterrupts;
}

/**
 * The interrupt a scripted cycle ends on, or null for one that ends by itself.
 *
 * A script that has run out ends the run as an operator stop, so a loop that
 * spawned more cycles than the case expected settles `stopped` — a status the
 * case can assert against — rather than holding the test open.
 */
function interruptFor(step: Cycle | undefined): Interrupt | null {
  const at = Date.now();
  if (step === "refusal") return null;
  if (step === "guard-pause") {
    return {
      kind: "guard",
      reason: "Paused: this run reached its share of the 5-hour window.",
      code: "session_fraction",
      pause: true,
      // An hour out, so the sweeper never hands the run back on its own and
      // every un-park in a case is the one the case asked for.
      resumeAt: at + 3_600_000,
      at,
    };
  }
  if (step === "prune") {
    return {
      kind: "prune",
      reason: "This work cycle was ended here to be pruned.",
      pause: false,
      at,
    };
  }
  return { kind: "operator", reason: "The stub ran out of script.", pause: false, at };
}

const childProcess = require("node:child_process") as Record<string, unknown>;
const realSpawn = childProcess.spawn as (...args: unknown[]) => unknown;

childProcess.spawn = (command: unknown, ...rest: unknown[]) => {
  if (command !== config.CLAUDE_BIN) return realSpawn(command, ...rest);
  spawned += 1;
  const step = script.shift();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    // No pid, so `signalTree` skips `process.kill(-pid)` — `shutdown.test.ts`'s
    // reason: in a test runner that could signal a real process group.
    pid: undefined as number | undefined,
    kill: () => true,
  });
  // After `runIteration` has attached its handlers, which it does on the turn
  // `spawn` returns in.
  setImmediate(() => {
    const interrupt = interruptFor(step);
    if (interrupt) interrupts().set(scriptedRun, interrupt);
    if (step === "refusal") {
      stdout.write(
        `${JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "Claude AI usage limit reached|1786400000",
        })}\n`,
      );
    }
    const code = step === "refusal" ? 1 : null;
    stdout.end();
    stderr.end();
    child.emit("exit", code, code === null ? "SIGTERM" : null);
    child.emit("close", code, code === null ? "SIGTERM" : null);
  });
  return child;
};

after(() => {
  childProcess.spawn = realSpawn;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Start one run in a folder of its own, scripted cycle by cycle. */
function start(folder: string, cycles: Cycle[], budget: Partial<BudgetPolicy>): string {
  fs.mkdirSync(path.join(tmp, "workspace", folder), { recursive: true });
  script = [...cycles];
  spawned = 0;
  const run = createRun({
    folder,
    mountId: null,
    prompt: "do the thing",
    budget,
    origin: "form",
  });
  scriptedRun = run.id;
  return run.id;
}

/** Wait for the segment in flight to end, however it ends. */
async function settled(id: string): Promise<void> {
  for (let i = 0; i < 1_000; i++) {
    const status = getRun(id)?.status;
    if (status !== "queued" && status !== "running") return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`run ${id} never left running`);
}

/** Un-park, as the operator's Resume does and the sweeper does once due. */
function unpark(id: string): void {
  assert.equal(resumeRun(id), "requeued", "the run was not parked when it was handed back");
}

describe("which parks spend the refusal allowance", () => {
  it("does not charge a park at the run's own guard to it", async () => {
    const id = start(
      "guard-parks",
      [...Array<Cycle>(MAX_PAUSES_PER_RUN).fill("guard-pause"), "refusal"],
      { maxIterations: 5, enforcement: "live-resume" },
    );

    for (let park = 1; park <= MAX_PAUSES_PER_RUN; park++) {
      await settled(id);
      const row = getRun(id)!;
      assert.equal(row.status, "paused", `guard park ${park}: ${row.stop_reason}`);
      assert.equal(row.pause_count, park, "every park still counts as having parked");
      unpark(id);
    }

    await settled(id);
    const row = getRun(id)!;
    assert.equal(
      row.status,
      "paused",
      "a run that stepped aside at its own guard was failed at its first real " +
        `refusal for waits it never took: ${row.stop_reason}`,
    );
    assert.match(row.stop_reason ?? "", /Waiting for it to refill/);
    assert.equal(row.refusal_pauses, 1, "one refusal waited out, and only one");
    assert.equal(row.pause_count, MAX_PAUSES_PER_RUN + 1);
    stopRun(id);
  });

  it("still ends a run that has waited out every refusal it may", async () => {
    // The control, and the half that makes the first case mean anything: a
    // refusal branch that advanced nothing would pass it too, and would re-park
    // a misread refusal for ever.
    const id = start(
      "refusals",
      Array<Cycle>(MAX_PAUSES_PER_RUN + 1).fill("refusal"),
      { maxIterations: 5 },
    );

    for (let park = 1; park <= MAX_PAUSES_PER_RUN; park++) {
      await settled(id);
      const row = getRun(id)!;
      assert.equal(row.status, "paused", `refusal ${park}: ${row.stop_reason}`);
      assert.equal(row.refusal_pauses, park);
      unpark(id);
    }

    await settled(id);
    const row = getRun(id)!;
    assert.equal(row.status, "failed", `still parking: ${row.stop_reason}`);
    assert.match(row.stop_reason ?? "", /Out of waits/);
    assert.equal(spawned, MAX_PAUSES_PER_RUN + 1);
  });
});

describe("what bounds the refund of a cycle the live guard cut", () => {
  it("ends a run whose every cycle is cut, at its cycle cap", async () => {
    // The run the unbounded refund could not end: `live-resume`, a cycle cap
    // and no time limit, and a task longer than its guard's share of a window
    // — so the live guard cuts every cycle, every cut was refunded, and
    // `iterations` never reached `maxIterations`. A run spending limit would
    // still have ended it; this one has none, which the terminus rule allows.
    const id = start(
      "every-cycle-cut",
      Array<Cycle>(MAX_PAUSES_PER_RUN + 3).fill("guard-pause"),
      { maxIterations: 1, enforcement: "live-resume" },
    );

    // Handed back for as long as it keeps parking, with room for two parks
    // more than the bound allows, so an unbounded refund reads as a run that
    // is still parking rather than as a test that never returns.
    for (let park = 0; park < MAX_PAUSES_PER_RUN + 3; park++) {
      await settled(id);
      if (getRun(id)!.status !== "paused") break;
      unpark(id);
    }

    await settled(id);
    const row = getRun(id)!;
    // Matched on the cycle cap's own sentence and not on the status alone: the
    // pre-cycle guard ends a capped run `stopped`, which is also what the stub
    // ends a run on when its script runs out.
    assert.match(
      row.stop_reason ?? "",
      /Used all 1 work cycle allowed/,
      `${row.status} after ${spawned} billed cycles, none of them charged: ${row.stop_reason}`,
    );
    assert.equal(
      spawned,
      MAX_PAUSES_PER_RUN + 1,
      "one work cycle, plus one refunded cut for each the bound allows",
    );
    assert.equal(row.iterations, 1, "the cut past the bound is the cycle the cap counted");
    assert.equal(row.guard_refunds, MAX_PAUSES_PER_RUN);
  });

  it("ends the run at a charged cut that reaches its cap, rather than parking it", async () => {
    // Past the bound the cut stays charged, and on a cap of 1 that charge is
    // the run's last cycle. Parked anyway, it held its folder until the
    // sweeper next looked — up to a whole window — only to end it then on the
    // same verdict. So the segment the charged cut ends is not handed back
    // here: the run has to leave `paused` by itself.
    const id = start(
      "cut-at-cap",
      Array<Cycle>(MAX_PAUSES_PER_RUN + 1).fill("guard-pause"),
      { maxIterations: 1, enforcement: "live-resume" },
    );

    for (let park = 1; park <= MAX_PAUSES_PER_RUN; park++) {
      await settled(id);
      const row = getRun(id)!;
      assert.equal(row.status, "paused", `refunded cut ${park}: ${row.stop_reason}`);
      unpark(id);
    }

    await settled(id);
    const row = getRun(id)!;
    assert.equal(
      row.status,
      "stopped",
      `the charged cut parked a run its cycle cap had already ended: ${row.stop_reason}`,
    );
    assert.match(row.stop_reason ?? "", /Used all 1 work cycle allowed/);
    assert.equal(row.resume_at, null, "nothing is scheduled to look at it again");
    assert.equal(spawned, MAX_PAUSES_PER_RUN + 1);
    assert.equal(row.iterations, 1);
    assert.equal(row.guard_refunds, MAX_PAUSES_PER_RUN);
  });

  it("still parks a charged cut that a task check's grant keeps under the cap", async () => {
    // The control, and it pins the widened cap as well: a check that compared
    // against `maxIterations` alone, or that ended every cut past the bound,
    // would end this run with a granted cycle still unspent.
    const id = start(
      "cut-under-granted-cap",
      Array<Cycle>(MAX_PAUSES_PER_RUN + 1).fill("guard-pause"),
      { maxIterations: 1, enforcement: "live-resume" },
    );

    for (let park = 1; park <= MAX_PAUSES_PER_RUN; park++) {
      await settled(id);
      const row = getRun(id)!;
      assert.equal(row.status, "paused", `refunded cut ${park}: ${row.stop_reason}`);
      // Written while parked, where the loop is not reading it, and read off
      // the row by every pass after the un-park, as a real grant is.
      if (park === 1) {
        db().prepare("UPDATE runs SET validation_cycles = 1 WHERE id = ?").run(id);
      }
      unpark(id);
    }

    await settled(id);
    const row = getRun(id)!;
    assert.equal(row.status, "paused", `ended with a granted cycle unspent: ${row.stop_reason}`);
    assert.equal(row.iterations, 1, "the cut past the bound is still charged");
    assert.equal(row.guard_refunds, MAX_PAUSES_PER_RUN);
    stopRun(id);
  });
});

describe("what bounds the refund of a cycle the context ceiling ended", () => {
  it("still counts the early ends a run had before it parked", async () => {
    // Every early end the bound allows, then a park and an un-park — the
    // segment boundary that used to restart the count at zero — then one more
    // crossing, which is past the bound and must be charged.
    const id = start(
      "early-ends",
      [...Array<Cycle>(MAX_EARLY_ENDS_PER_RUN).fill("prune"), "guard-pause", "prune"],
      { maxIterations: 1, enforcement: "live-resume" },
    );

    await settled(id);
    const parked = getRun(id)!;
    assert.equal(parked.status, "paused", `the fixture never parked: ${parked.stop_reason}`);
    assert.equal(
      parked.iterations,
      0,
      "the early ends inside the bound, and the cut, were all refunded",
    );
    unpark(id);

    await settled(id);
    const row = getRun(id)!;
    assert.match(
      row.stop_reason ?? "",
      /Used all 1 work cycle allowed/,
      `the crossing after the park was refunded as though it were the first, so the ` +
        `run carried on: ${row.status} after ${spawned} cycles, ${row.stop_reason}`,
    );
    assert.equal(spawned, MAX_EARLY_ENDS_PER_RUN + 2);
    assert.equal(row.iterations, 1, "the crossing past the bound is the cycle the cap counted");
    assert.equal(row.early_ends, MAX_EARLY_ENDS_PER_RUN);
  });
});

describe("what a work cycle refused before its spawn is charged", () => {
  // A `local` run on an install that is signed out of the local provider: the
  // loop refuses the cycle with no child ever existing. Charged, a one-cycle run
  // cannot be picked up the way its own stop reason says to, and every pick-up
  // burns a cycle; with the message cleared, the operator's note is lost
  // although nothing ever received it.
  function startLocal(folder: string, maxIterations: number): string {
    fs.mkdirSync(path.join(tmp, "workspace", folder), { recursive: true });
    script = [];
    spawned = 0;
    const run = createRun({
      folder,
      mountId: null,
      prompt: "do the thing",
      provider: "local",
      model: "qwen3",
      budget: { maxIterations },
      origin: "form",
    });
    scriptedRun = run.id;
    return run.id;
  }

  it("charges no work cycle for a spawn that never happened", async () => {
    const id = startLocal("refused-one-cycle", 1);
    await settled(id);
    const row = getRun(id)!;
    assert.equal(row.status, "failed", `the refusal was not reached: ${row.stop_reason}`);
    assert.match(row.stop_reason ?? "", /local provider is signed out/);
    assert.equal(spawned, 0, "precondition: no child was spawned");
    assert.equal(
      row.iterations,
      0,
      `the row records ${row.iterations} work cycle(s); picking it up as its stop ` +
        `reason says answers: ${JSON.stringify(reopenRun(id, { maxIterations: 1 }))}`,
    );
  });

  it("keeps the pick-up note for the cycle that actually carries it", async () => {
    const id = startLocal("refused-note", 5);
    await settled(id);
    const reopened = reopenRun(id, { maxIterations: 5 }, "Please only touch README.md");
    assert.equal(reopened.ok, true, JSON.stringify(reopened));
    assert.equal(getRun(id)!.follow_up, "Please only touch README.md");

    await settled(id);
    const row = getRun(id)!;
    assert.equal(row.status, "failed", `the refusal was not reached: ${row.stop_reason}`);
    assert.match(row.stop_reason ?? "", /signed out/);
    assert.equal(spawned, 0, "precondition: no child was spawned");
    assert.equal(
      row.follow_up,
      "Please only touch README.md",
      `the note was cleared although no cycle carried it; iterations now ${row.iterations}`,
    );
    assert.equal(row.iterations, 0);
  });
});
