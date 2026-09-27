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
 * Which counter each park is charged to, driven through the real run loop.
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

const { createRun, getRun, MAX_PAUSES_PER_RUN, resumeRun, stopRun } =
  require("./orchestrator") as typeof import("./orchestrator");

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
 */
type Cycle = "guard-pause" | "refusal";

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
