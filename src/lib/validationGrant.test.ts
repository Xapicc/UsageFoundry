import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, it } from "node:test";

/**
 * Whether the work cycle a task check grants is actually run.
 *
 * `validationAtBoundary` answering `not-finished` buys a run one cycle past
 * `maxIterations`, and the post-cycle cap check honoured that — but the loop
 * then went round to the pre-cycle guard, which read the unwidened cap and
 * ended the run before the granted cycle spawned. On the default cap of 1 that
 * was every run the check ever sent back: the verdict paid for, the grant
 * spent on the row, the task left open and claimed, and a log saying "giving
 * it another work cycle" directly above "used all 1 work cycle". Nothing
 * threw, and each guard site read correctly on its own; only the loop as a
 * whole could show that the two disagreed, so it is the loop that is driven.
 *
 * What stands in for what, and why the line is drawn there:
 *
 * - **The child is a fake**, `shutdown.test.ts`'s device: `child_process.spawn`
 *   is replaced on the module object `orchestrator.ts` calls it through, for
 *   `CLAUDE_BIN` only. `CLAUDE_BIN` stays a path that does not exist, so a
 *   regression that reached a real spawn is a failed test rather than a billed
 *   one.
 * - **The verdict is a fake**, `contextCeilingRace.test.ts`'s device for
 *   `ceilingCut`: `validationAtBoundary` is replaced on the module the loop
 *   imports it from. Its own gates — the ceiling on grants, the verdict's
 *   freshness, the task still being claimed — are `validation.test.ts`'s
 *   subject; what is pinned here is what the loop does with a grant once it
 *   has one. `recordValidationCycle` is left real, because the row it writes is
 *   the guard's input and faking it would test the fake.
 *
 * Its own file with the environment set before anything is required, because
 * `config.ts` fixes `DATA_DIR` and `CLAUDE_HOME` at module load and this runs
 * whole run loops against a database no other case shares.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-validation-grant-")));
fs.mkdirSync(path.join(tmp, "claude", "projects"), { recursive: true });
fs.mkdirSync(path.join(tmp, "workspace", "project"), { recursive: true });

process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
// Pinned rather than left to fall back to CLAUDE_HOME: the pre-cycle guard
// reaches `planUsage()`, which sends a request when it finds an OAuth token.
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");
process.env.WORKSPACE_ROOT = path.join(tmp, "workspace");
delete process.env.WORKSPACE_ROOTS;
process.env.CLAUDE_BIN = path.join(tmp, "no-such-claude");

const config = require("./config") as typeof import("./config");
assert.equal(
  config.DATA_DIR,
  process.env.DATA_DIR,
  "config was already loaded by another test file in this process — refusing to " +
    "run against the real database",
);

const { createRun, currentSnapshot, getRun } =
  require("./orchestrator") as typeof import("./orchestrator");
const { evaluateBudget } = require("./budget") as typeof import("./budget");
const validation = require("./validation") as typeof import("./validation");
type LiveGuard = {
  policy: import("./budget").BudgetPolicy;
  progress: () => import("./budget").RunProgress;
};

/**
 * What each work cycle's agent says last, one entry per spawn, in order.
 *
 * `DONE` is the agent claiming the task is finished, which is the claim the
 * check exists to question; anything else is a cycle that simply ran.
 */
let replies: string[] = [];
/** What each boundary's check answers, one entry per boundary; empty is none. */
let verdicts: Array<{ pushback: string; reason: string } | null> = [];
let spawned = 0;
/** The live guard as the fake child found it registered, per spawn. */
let liveAtSpawn: Array<LiveGuard | undefined> = [];

const realValidationAtBoundary = validation.validationAtBoundary;
(validation as { validationAtBoundary: unknown }).validationAtBoundary = async () =>
  verdicts.shift() ?? null;

const childProcess = require("node:child_process") as Record<string, unknown>;
const realSpawn = childProcess.spawn as typeof import("node:child_process").spawn;

childProcess.spawn = (command: string, ...rest: unknown[]) => {
  if (command !== config.CLAUDE_BIN) {
    return (realSpawn as (...a: unknown[]) => unknown)(command, ...rest);
  }
  spawned += 1;
  const reply = replies.shift() ?? "Still working.";
  const guards = (globalThis as unknown as { __ufLiveGuards?: Map<string, LiveGuard> })
    .__ufLiveGuards;
  liveAtSpawn.push(guards ? [...guards.values()][0] : undefined);

  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    // No pid, so `signalTree` never reaches `process.kill(-pid)`.
    pid: undefined as number | undefined,
    kill() {
      return true;
    },
  });
  // After `runIteration` has attached its listeners, which it does once
  // `spawn` has returned.
  setImmediate(() => {
    stdout.write(
      `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: reply, total_cost_usd: 0 })}\n`,
    );
    stdout.end();
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  });
  return child;
};

after(() => {
  childProcess.spawn = realSpawn;
  (validation as { validationAtBoundary: unknown }).validationAtBoundary =
    realValidationAtBoundary;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Start a run the way the form does and wait for its loop to settle it. */
async function settle(
  budget: Record<string, unknown>,
): Promise<NonNullable<ReturnType<typeof getRun>>> {
  const run = createRun({
    folder: "project",
    mountId: null,
    prompt: "finish the task",
    budget,
    origin: "form",
  });
  for (let i = 0; i < 500; i++) {
    const row = getRun(run.id);
    if (row && row.status !== "queued" && row.status !== "running") return row;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`run ${run.id} never settled; it is ${getRun(run.id)?.status}`);
}

describe("a work cycle a task check granted past the cycle cap", () => {
  it("is spawned, and the run ends on that cycle's own outcome", async () => {
    spawned = 0;
    replies = ["DONE", "DONE"];
    verdicts = [{ pushback: "Add the missing test.", reason: "the test is missing" }];

    const row = await settle({ maxIterations: 1 });

    assert.equal(
      spawned,
      2,
      "the pre-cycle guard read the unwidened cap and ended the run before the " +
        "cycle it had just been granted could start",
    );
    assert.equal(row.iterations, 2);
    assert.equal(row.validation_cycles, 1, "the grant is recorded on the row");
    assert.equal(row.status, "completed");
    assert.equal(
      row.stop_reason,
      "Agent reported the task complete.",
      "the run must end on what the granted cycle did, not on the cap",
    );
  });

  it("ends at the widened cap, and says where the extra cycle came from", async () => {
    spawned = 0;
    replies = ["DONE", "Still working."];
    verdicts = [{ pushback: "Add the missing test.", reason: "the test is missing" }];

    const row = await settle({ maxIterations: 1 });

    assert.equal(spawned, 2);
    assert.equal(row.status, "completed");
    assert.match(
      row.stop_reason ?? "",
      /Used all 2 work cycles .* the 1 it was given and 1 more the check on its task granted/,
    );
  });

  it("still ends at the cap it was given when nothing was granted", async () => {
    // The control. A loop that ignored the cap entirely would pass both cases
    // above, so this pins that the cap still binds without a grant.
    spawned = 0;
    replies = ["Still working."];
    verdicts = [];

    const row = await settle({ maxIterations: 1 });

    assert.equal(spawned, 1);
    assert.equal(row.status, "completed");
    assert.equal(row.stop_reason, "Used all 1 work cycle allowed for this run.");
  });

  it("keeps the live guard reading the granted cycle as inside its cap", async () => {
    // `iterations` is checked first and is not live-enforceable, so a live
    // guard that read the granted cycle as over its cap would skip the run on
    // every tick and leave that cycle's time and spend unguarded mid-flight.
    spawned = 0;
    liveAtSpawn = [];
    replies = ["DONE", "DONE"];
    verdicts = [{ pushback: "Add the missing test.", reason: "the test is missing" }];

    const row = await settle({ maxIterations: 1, enforcement: "live" });

    assert.equal(spawned, 2);
    assert.equal(row.status, "completed");
    const granted = liveAtSpawn[1];
    assert.ok(granted, "the granted cycle was spawned with no live guard registered");
    const verdict = evaluateBudget(
      granted.policy,
      await currentSnapshot(),
      granted.progress(),
    );
    assert.notEqual(
      verdict.allowed ? null : verdict.code,
      "iterations",
      "the live guard read the cycle it was watching as past the cap that admitted it",
    );
  });
});
