import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, afterEach, describe, it } from "node:test";

/**
 * A run that asks for a stack, driven through the real run loop: the park at
 * the cycle boundary, the release, and the resumed cycle's argv.
 *
 * Every step of it fails silently. A park that charges the cycle that asked
 * ends a run on the default cap of one the moment it resumes, having waited a
 * restart for nothing. A park placed below the cycle-cap check never happens on
 * that cap at all — the run completes instead, and the request sits on Settings
 * for a run that is already over. A release that re-queues without the notice
 * sends "continue the task" into a conversation whose last turn was "I am
 * waiting for cargo". And a resumed cycle whose argv lacks the new stack's grant
 * is refused `cargo` with "This command requires approval" while the cycle ends
 * `success` having run nothing, which is the quiet failure `stacks.ts` records
 * for an ungranted binary at `acceptEdits`.
 *
 * `orchestrator.test.ts` cannot say any of it because nothing there spawns, so
 * this is `parksAndRefunds.test.ts`'s harness: a stubbed child, the real loop,
 * and the row each segment leaves. Its own file for that file's reasons —
 * `config.ts` fixes `DATA_DIR` at load and `spawn` is replaced for the life of
 * the process — and one more: `reconcileOnBoot` acts on every row there is.
 *
 * The restart between the park and the resume is simulated, not performed: the
 * applier's receipts are read from a directory this file writes, and
 * `stackGrants()`'s per-process cache is reset and re-primed from it, which is
 * exactly what a new process reading the receipts the boot wrote does.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-stack-wait-")));
fs.mkdirSync(path.join(tmp, "claude", "projects"), { recursive: true });

process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
// Pinned rather than left to fall back to CLAUDE_HOME: the pre-cycle guard
// reaches `planUsage()`, which sends a request when it finds an OAuth token.
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
  reconcileOnBoot,
  releaseDependents,
  releaseStackWaits,
  reopenRun,
  resumeRun,
  stopRun,
} = require("./orchestrator") as typeof import("./orchestrator");
const { readReceipts, stackGrants } = require("./stacks") as typeof import("./stacks");
const { declineStackRequest, recordStackRequest, stackRequestsOfRun, stackWaitOf } =
  require("./stackRequests") as typeof import("./stackRequests");
const { db } = require("./db") as typeof import("./db");
const settings = require("./settings") as typeof import("./settings");
const tasks = require("./tasks") as typeof import("./tasks");
const interrupts = (globalThis as unknown as {
  __ufInterrupts: Map<string, import("./orchestrator").Interrupt>;
}).__ufInterrupts;

const receiptsDir = path.join(tmp, "receipts");
fs.mkdirSync(receiptsDir, { recursive: true });

/** What the receipts say after "the restart": write one, as the applier would. */
function writeReceipt(name: string, status: "ok" | "failed", bins: string[]): void {
  fs.writeFileSync(
    path.join(receiptsDir, `${name}.json`),
    JSON.stringify({
      name,
      digest: "0".repeat(64),
      status,
      appliedAt: "2026-10-01T00:00:00Z",
      bin: status === "ok" ? bins.map((bin) => ({ name: bin, path: `/var/lib/uf-stacks/bin/${bin}` })) : [],
      deny: [],
      error: status === "ok" ? null : { text: "stack terraform: sha256 mismatch\nmore", bytes: 40 },
    }),
  );
}

/** A new process reading the receipts the boot wrote: the grants cache is per process. */
function restartReadsReceipts(): void {
  (globalThis as unknown as { __ufStackGrants: { value: unknown } }).__ufStackGrants.value = null;
  stackGrants(receiptsDir);
}

/** The process before any stack: an empty grant, cached. */
restartReadsReceipts();

/**
 * What each work cycle does: optionally ask for a stack while it runs, the way
 * an agent's `request_stack` call lands mid-cycle, and then reply.
 */
interface Cycle {
  ask?: { name: string; binaries: string[] };
  /** Anything else that lands while the child runs, after the request does. */
  during?: () => void;
  /** What the cycle's `result` event reports as spent. */
  cost?: number;
  /** The provider turns the cycle away at the wall: no work, no spend, exit 1. */
  refuse?: boolean;
  /**
   * The provider turns a later turn of the cycle away with this text, after
   * `turns` turns, spending `cost`. More than one turn means an edit was made
   * first. Exit 1.
   */
  refuseMidCycle?: { text: string; turns: number };
  reply: string;
}

let script: Cycle[] = [];
let scriptedRun = "";
/** The argv each spawn was handed, in order. */
let argvs: string[][] = [];

const childProcess = require("node:child_process") as Record<string, unknown>;
const realSpawn = childProcess.spawn as (...args: unknown[]) => unknown;

childProcess.spawn = (command: unknown, ...rest: unknown[]) => {
  if (command !== config.CLAUDE_BIN) return realSpawn(command, ...rest);
  argvs.push([...(rest[0] as string[])]);
  const step = script.shift() ?? { reply: "The stub ran out of script." };
  if (step.ask) {
    const outcome = recordStackRequest({
      runId: scriptedRun,
      input: { ...step.ask, reason: "The task builds a Rust crate.", draft: null },
      receipts: readReceipts(receiptsDir).receipts,
      waitsSoFar: getRun(scriptedRun)!.stack_waits,
    });
    assert.equal(outcome.kind, "filed", `the stub's request was not filed: ${outcome.kind}`);
  }
  step.during?.();

  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    // No pid, so `signalTree` never reaches `process.kill(-pid)`.
    pid: undefined as number | undefined,
    kill: () => true,
  });
  // After `runIteration` has attached its listeners, which it does once
  // `spawn` has returned.
  setImmediate(() => {
    if (step.refuseMidCycle) {
      const { text, turns } = step.refuseMidCycle;
      const say = (event: object) =>
        stdout.write(`${JSON.stringify({ ...event, session_id: "sess-stack" })}\n`);
      say({ type: "system", subtype: "init" });
      if (turns > 1) {
        say({
          type: "assistant",
          message: {
            model: "claude-sonnet-4-5",
            content: [{ type: "tool_use", id: "tu1", name: "Edit", input: { file_path: "a.ts", old_string: "x", new_string: "y" } }],
          },
        });
        say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] } });
      }
      say({ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text }] } });
      say({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        num_turns: turns,
        result: text,
        total_cost_usd: step.cost ?? 0,
      });
      stdout.end();
      child.emit("exit", 1, null);
      child.emit("close", 1, null);
      return;
    }
    if (step.refuse) {
      stdout.write(
        `${JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "Claude AI usage limit reached|1786400000",
        })}\n`,
      );
      stdout.end();
      child.emit("exit", 1, null);
      child.emit("close", 1, null);
      return;
    }
    stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "sess-stack" })}\n`);
    stdout.write(
      `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: step.reply, total_cost_usd: step.cost ?? 0, session_id: "sess-stack" })}\n`,
    );
    stdout.end();
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  });
  return child;
};

after(() => {
  childProcess.spawn = realSpawn;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function start(
  folder: string,
  cycles: Cycle[],
  // The default cap, which is the case the refund exists for.
  budget: { maxIterations: number; maxRunCostUSD?: number; maxDurationMinutes?: number } = {
    maxIterations: 1,
  },
): string {
  fs.mkdirSync(path.join(tmp, "workspace", folder), { recursive: true });
  script = [...cycles];
  argvs = [];
  const run = createRun({
    folder,
    mountId: null,
    prompt: "build the crate",
    budget,
    origin: "form",
  });
  scriptedRun = run.id;
  return run.id;
}

/** Wait for the segment in flight to end, however it ends. */
async function settled(id: string): Promise<NonNullable<ReturnType<typeof getRun>>> {
  for (let i = 0; i < 1_000; i++) {
    const row = getRun(id)!;
    if (row.status !== "queued" && row.status !== "running") return row;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`run ${id} never left running`);
}

/** A one-commit repository at `folder`, which is what makes a run there isolate onto a branch. */
function makeRepo(folder: string): void {
  const repo = path.join(tmp, "workspace", folder);
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", ...args], {
      cwd: repo,
    });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
}

/** The values one variadic flag carries, up to the next flag. */
function flagValues(args: string[], flag: string): string[] {
  const at = args.indexOf(flag);
  if (at === -1) return [];
  const rest = args.slice(at + 1);
  const end = rest.findIndex((a) => a.startsWith("--"));
  return end === -1 ? rest : rest.slice(0, end);
}

describe("a run that asks for a stack", () => {
  it("parks at the boundary on the default cap, refunded, and resumes granted once installed", async () => {
    const id = start("asks-for-rust", [
      { ask: { name: "rust", binaries: ["cargo"] }, reply: "DONE" },
      { reply: "DONE" },
    ]);

    const parked = await settled(id);
    // `DONE` in the same reply as the request is the case the placement is
    // for: below the park, it completes the run with the request still pending.
    assert.equal(parked.status, "waiting-for-stack", parked.stop_reason ?? "");
    assert.equal(parked.iterations, 0, "the cycle that asked was charged, so the cap ends the resume");
    assert.equal(parked.stack_waits, 1);
    assert.equal(parked.pause_count, 1, "ensureWorktree reads this as having worked before");
    assert.notEqual(parked.paused_at, null, "the wait has to be an open park, or it counts as worked time");
    assert.equal(parked.finished_at, null);
    assert.equal(parked.reported_done, 0, "a DONE said without the tool is not recorded as one");
    assert.equal(parked.ending_code, null, "a park is not an ending");

    // Nothing is installed yet, so a sweep keeps it waiting.
    assert.deepEqual(releaseStackWaits(readReceipts(receiptsDir).receipts), { released: 0, waiting: 1 });
    assert.equal(getRun(id)!.status, "waiting-for-stack");

    writeReceipt("rust", "ok", ["cargo", "rustc"]);
    restartReadsReceipts();
    assert.deepEqual(releaseStackWaits(readReceipts(receiptsDir).receipts), { released: 1, waiting: 0 });

    const done = await settled(id);
    assert.equal(done.status, "completed", done.stop_reason ?? "");
    assert.equal(argvs.length, 2);
    assert.equal(done.paused_at, null, "the claim closes the park");
    assert.deepEqual(stackWaitOf(id), [], "a released run is waiting on nothing");

    const resumed = argvs[1];
    assert.equal(resumed[resumed.indexOf("--resume") + 1], "sess-stack", "it resumes the same session");
    assert.ok(
      flagValues(resumed, "--allowedTools").includes("Bash(cargo:*)"),
      "the resumed cycle is not granted the binary it waited for",
    );
    assert.ok(
      !flagValues(argvs[0], "--allowedTools").includes("Bash(cargo:*)"),
      "the control: the first cycle, before the stack, had no grant for it",
    );
    const prompt = resumed[resumed.indexOf("--") + 1];
    assert.match(prompt, /installed/);
    assert.match(prompt, /cargo, rustc/);
  });

  it("stays waiting on a failed receipt, and Stop ends the wait and closes the park", async () => {
    const id = start("asks-for-terraform", [
      { ask: { name: "terraform", binaries: ["terraform"] }, reply: "Waiting for terraform." },
    ]);
    assert.equal((await settled(id)).status, "waiting-for-stack");

    writeReceipt("terraform", "failed", []);
    assert.deepEqual(releaseStackWaits(readReceipts(receiptsDir).receipts), { released: 0, waiting: 1 });
    assert.equal(getRun(id)!.status, "waiting-for-stack", "a failed install must not release the run");

    assert.equal(stopRun(id), "cancelled");
    const stopped = getRun(id)!;
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.paused_at, null);
    assert.deepEqual(stackWaitOf(id), []);
    const [request] = stackRequestsOfRun(id);
    assert.equal(request.state, "pending", "stopping one run does not answer the request");
  });

  it("goes back to work told so when the operator declines", async () => {
    const id = start("asks-for-zig", [
      { ask: { name: "zig", binaries: ["zig"] }, reply: "Waiting for zig." },
      { reply: "Carried on without it. DONE" },
    ]);
    assert.equal((await settled(id)).status, "waiting-for-stack");

    const [request] = stackRequestsOfRun(id);
    assert.equal(declineStackRequest(request.id), true);
    assert.equal(declineStackRequest(request.id), false, "a second press changes nothing");
    releaseStackWaits(readReceipts(receiptsDir).receipts);

    const done = await settled(id);
    assert.equal(done.status, "completed", done.stop_reason ?? "");
    const prompt = argvs[1][argvs[1].indexOf("--") + 1];
    assert.match(prompt, /declined/);
    assert.match(prompt, /NEEDS_REVIEW/);
  });

  it("survives a boot however long it has waited, where a paused run would not", async () => {
    const id = start("asks-for-go", [
      { ask: { name: "golang", binaries: ["go"] }, reply: "Waiting for go." },
    ]);
    assert.equal((await settled(id)).status, "waiting-for-stack");
    // A week ago, far past any `resumeGraceHours`: the restart is what it is
    // waiting for, so its age is not a reason to close it out.
    db().prepare("UPDATE runs SET paused_at = ? WHERE id = ?").run(Date.now() - 7 * 86_400_000, id);

    await reconcileOnBoot();
    const kept = getRun(id)!;
    assert.equal(kept.status, "waiting-for-stack", kept.stop_reason ?? "");
    assert.equal(kept.restart_closed, 0);
    stopRun(id);
  });

  it("parks at a cycle the context ceiling cut, refunded once, without spawning another", async () => {
    const id = start("asks-at-the-ceiling", [
      {
        ask: { name: "zig-ceiling", binaries: ["zig"] },
        // What `checkContextCeilings` leaves for the boundary when the cycle
        // that asked also crossed the ceiling. The ceiling ends cycles about
        // fifty times for every two natural boundaries on this install, so this
        // is the common way a request meets the end of its cycle.
        during: () =>
          interrupts.set(scriptedRun, {
            kind: "prune",
            reason: "This work cycle's context reached the ceiling.",
            pause: false,
            at: Date.now(),
          }),
        reply: "Asked for zig; stopping here until it is installed.",
      },
      { reply: "Carried on without zig, in a cycle that should never have been spawned." },
    ]);

    const parked = await settled(id);
    assert.equal(parked.status, "waiting-for-stack", parked.stop_reason ?? "");
    // The early end used to `continue` past the park: a second billed cycle,
    // spent without the tool and refunded too, so invisible against the cap.
    assert.equal(argvs.length, 1, "the run was spawned again before it parked");
    // One cycle, one refund. Refunded by both rungs it reads -1, and charged
    // it ends the resume on the default cap.
    assert.equal(parked.iterations, 0);
    assert.equal(parked.early_ends, 1);
    assert.equal(parked.stack_waits, 1);
    stopRun(id);
  });
});

/**
 * A run chained behind one that paid for a cycle, was parked for a stack, and
 * was stopped while it waited.
 *
 * The park refunds the cycle that asked, so the row ends `stopped` with
 * `iterations = 0` and the cost already spent. `edgeSatisfied` read that zero
 * as "never ran a work cycle", so the dependent was `blocked` with that
 * sentence about a run that had worked and paid, "Try again" re-blocked it at
 * once, and the only way out restarted the dependency's agent. The install-wide
 * hold is set so that a dependent the fix lets through stays `waiting` rather
 * than spawning the stub, which is also what makes "released" observable.
 */
describe("a dependent behind a run a stack wait refunded", () => {
  const { setNewWorkPaused } = settings;
  let seq = 0;
  const dependents: string[] = [];

  /** A parked at its first cycle's end, B chained behind it, then A stopped. */
  async function chainedBehindStoppedPark(
    edge: "on-finish" | "on-success",
    parentCycle: (seq: number) => Cycle = (n) => ({
      ask: { name: `zig-refunded-${n}`, binaries: ["zig"] },
      cost: 0.42,
      reply: "Waiting for zig.",
    }),
  ) {
    seq += 1;
    const parentId = start(`refunded-parent-${seq}`, [parentCycle(seq)]);
    const parked = await settled(parentId);
    assert.ok(
      parked.status === "waiting-for-stack" || parked.status === "paused",
      `the parent did not park: ${parked.status} ${parked.stop_reason ?? ""}`,
    );
    assert.equal(parked.iterations, 0, "the premise: the refund put the counter back to zero");
    assert.equal(parked.pause_count, 1, "the premise: a park, so pause_count is no evidence of work");
    // After the park, not before: the hold also keeps the parent itself queued.
    setNewWorkPaused(true);

    fs.mkdirSync(path.join(tmp, "workspace", `refunded-child-${seq}`), { recursive: true });
    const child = createRun({
      folder: `refunded-child-${seq}`,
      mountId: null,
      prompt: "build on the crate",
      budget: { maxIterations: 1 },
      origin: "form",
      dependsOn: [{ runId: parentId, edge }],
    });
    dependents.push(child.id);
    assert.equal(child.status, "waiting", "the dependency has not settled yet");

    assert.equal(stopRun(parentId), "cancelled");
    assert.equal(getRun(parentId)!.status, "stopped");
    return { parentId, childId: child.id };
  }

  // Stopped before the hold lifts, and on failure too: a dependent left
  // `waiting` is released the moment the hold clears and spawns the stub into
  // whichever test runs next.
  afterEach(() => {
    for (const id of dependents.splice(0)) stopRun(id);
    setNewWorkPaused(false);
  });

  it("on-finish: waits for the hold rather than being blocked as if nothing had run", async () => {
    const { parentId, childId } = await chainedBehindStoppedPark("on-finish");
    const child = getRun(childId)!;
    assert.equal(getRun(parentId)!.spent_usd, 0.42, "the premise: the cycle that asked was paid for");
    assert.equal(
      child.status,
      "waiting",
      `a run that worked and paid was read as never having run a cycle: ${child.stop_reason ?? ""}`,
    );
    assert.doesNotMatch(child.stop_reason ?? "", /without running a work cycle/);
    assert.equal(getRun(parentId)!.iterations, 0, "the refund itself is unchanged");
  });

  it("on-success: still blocked, and told the true thing: it ended stopped", async () => {
    const { parentId, childId } = await chainedBehindStoppedPark("on-success");
    const child = getRun(childId)!;
    assert.equal(child.status, "blocked");
    assert.match(
      child.stop_reason ?? "",
      new RegExp(`only after run ${parentId.slice(0, 8)} succeeded \\(on-success\\); it ended stopped`),
    );
    assert.doesNotMatch(child.stop_reason ?? "", /without running a work cycle/);
  });

  // The reason the answer is the three refund counters and not `pause_count`,
  // which `ensureWorktree` reads: a provider refusal parks the run and refunds
  // its cycle too, and in that cycle nothing was done.
  it("control: a run the provider refused at the wall and that was stopped still ran nothing", async () => {
    const { parentId, childId } = await chainedBehindStoppedPark("on-finish", () => ({
      refuse: true,
      reply: "",
    }));
    const parent = getRun(parentId)!;
    assert.equal(parent.refusal_pauses, 1, "the premise: this park is the provider's refusal");
    assert.equal(parent.spent_usd, 0);
    const child = getRun(childId)!;
    assert.equal(child.status, "blocked", child.stop_reason ?? "");
    assert.match(child.stop_reason ?? "", /ended stopped without running a work cycle/);
  });
});

/**
 * A run chained behind one whose cycle worked and paid, met the provider's
 * refusal on a later turn of it, and was stopped before it ran again.
 *
 * Both refusals the loop survives refund the cycle — the wall by parking, a
 * transient error by retrying after a backoff — and neither was counted where
 * `ranWorkCycle` reads, on the premise that the provider turned the cycle away
 * before any work. A wall is met by whichever turn crosses the allowance, and a
 * 529 after the CLI's own retries by any turn, so the dependent was blocked
 * "without running a work cycle" behind a run that had edited a file and paid.
 */
describe("a dependent behind a run the provider refused after it worked", () => {
  const { setNewWorkPaused } = settings;
  let seq = 0;
  const dependents: string[] = [];
  const WALL = "Claude AI usage limit reached|1786400000";
  const OVERLOADED =
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';

  /** On-finish behind `parentId`, under the hold, so a released one stays `waiting`. */
  function dependentOf(parentId: string): string {
    setNewWorkPaused(true);
    fs.mkdirSync(path.join(tmp, "workspace", `refused-child-${seq}`), { recursive: true });
    const child = createRun({
      folder: `refused-child-${seq}`,
      mountId: null,
      prompt: "build on a.ts",
      budget: { maxIterations: 1 },
      origin: "form",
      dependsOn: [{ runId: parentId, edge: "on-finish" }],
    });
    dependents.push(child.id);
    assert.equal(child.status, "waiting", "the dependency has not settled yet");
    return child.id;
  }

  /** A's one cycle meets a transient error, and A is stopped in the backoff before the retry. */
  async function stoppedInBackoff(refusal: { text: string; turns: number }, cost: number) {
    seq += 1;
    const parentId = start(`retried-parent-${seq}`, [{ refuseMidCycle: refusal, cost, reply: "" }]);
    const backingOff = db().prepare(
      "SELECT 1 FROM run_events WHERE run_id = ? AND kind = 'error' AND json_extract(payload, '$.retrying') = 1",
    );
    for (let i = 0; i < 1_000 && !backingOff.get(parentId); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(backingOff.get(parentId), "the premise: the loop is waiting to retry");
    const childId = dependentOf(parentId);
    assert.notEqual(stopRun(parentId), "not-active");
    const parent = await settled(parentId);
    assert.equal(parent.status, "stopped", parent.stop_reason ?? "");
    assert.equal(argvs.length, 1, "the premise: stopped before the retry spawned");
    // The pass the loop's `finally` ran, run again so the answer cannot depend
    // on whether that one had finished when the row turned `stopped`.
    releaseDependents();
    return { parentId, childId };
  }

  function assertReleased(parentId: string, childId: string): void {
    const parent = getRun(parentId)!;
    assert.equal(parent.iterations, 0, "the premise: the refund put the counter back to zero");
    assert.equal(parent.spent_usd, 0.37, "the premise: the cycle was paid for");
    const child = getRun(childId)!;
    assert.equal(
      child.status,
      "waiting",
      `a run that worked and paid was read as never having run a cycle: ${child.stop_reason ?? ""}`,
    );
  }

  afterEach(() => {
    for (const id of dependents.splice(0)) stopRun(id);
    setNewWorkPaused(false);
  });

  it("wall: parked, then stopped, and the on-finish dependent is released", async () => {
    seq += 1;
    const parentId = start(`walled-parent-${seq}`, [
      { refuseMidCycle: { text: WALL, turns: 7 }, cost: 0.37, reply: "" },
    ]);
    const parked = await settled(parentId);
    assert.equal(parked.status, "paused", parked.stop_reason ?? "");
    assert.equal(parked.refusal_pauses, 1, "the premise: this park is the provider's refusal");
    const childId = dependentOf(parentId);
    assert.equal(stopRun(parentId), "cancelled");
    assertReleased(parentId, childId);
  });

  it("transient error: stopped during the retry's backoff, and the dependent is released", async () => {
    const { parentId, childId } = await stoppedInBackoff({ text: OVERLOADED, turns: 7 }, 0.37);
    assertReleased(parentId, childId);
  });

  // The turn count is not the evidence of work: the pinned CLI reports
  // `num_turns: 1` for an API error on a cycle's first turn, having done
  // nothing (`docs/verification/run-lifecycle-resume-and-transcripts.md`,
  // 2026-10-06). What it spent is.
  it("control: a transient error that spent nothing on its one turn still ran nothing", async () => {
    const { parentId, childId } = await stoppedInBackoff({ text: OVERLOADED, turns: 1 }, 0);
    assert.equal(getRun(parentId)!.spent_usd, 0);
    const child = getRun(childId)!;
    assert.equal(child.status, "blocked", child.stop_reason ?? "");
    assert.match(child.stop_reason ?? "", /ended stopped without running a work cycle/);
  });
});

/**
 * A run whose refunded cycle worked and paid, and which its own spending limit
 * then refuses before the next cycle, ended `blocked`: the pre-cycle guard
 * chose between `blocked` and `stopped` on `iterations === 0`, and every refund
 * puts the counter back to zero. `blocked` is the status for nothing ran and
 * nothing was spent, and the row beside it said `$0.37` spent.
 */
describe("a run its guard refuses after a refunded cycle that worked", () => {
  const OVERLOADED =
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
  let seq = 0;

  /** One cycle that edits, costs `cost`, then meets a 529; the retry's backoff then reaches the guard. */
  async function refusedByCostLimit(turns: number, cost: number, repo = false) {
    seq += 1;
    const folder = `cost-limited-${seq}`;
    if (repo) makeRepo(folder);
    const parentId = start(
      folder,
      [{ refuseMidCycle: { text: OVERLOADED, turns }, cost, reply: "" }],
      { maxIterations: 1, maxRunCostUSD: 0.3 },
    );
    // The retry backoff is 5-7.5s; the guard then reads the cycle's spend.
    for (let i = 0; i < 1_500 && ["queued", "running"].includes(getRun(parentId)!.status); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return getRun(parentId)!;
  }

  it("ends stopped, because it ran a work cycle and spent", async () => {
    const parent = await refusedByCostLimit(7, 0.37);
    assert.equal(parent.spent_usd, 0.37, "the premise: the cycle was paid for");
    assert.equal(parent.iterations, 0, "the premise: the refund put the counter back to zero");
    assert.match(parent.stop_reason ?? "", /spending limit/, "the premise: the cost limit refused it");
    assert.equal(
      parent.status,
      "stopped",
      `blocked says nothing ran and nothing was spent: ${parent.stop_reason ?? ""}`,
    );
  });

  // The card is emitted unawaited once the run is over, and only for a run that
  // has a branch worth describing. `iterations > 0` read this one as never
  // having started, so the branch its refunded cycle worked on got no card.
  it("still ends with its handoff card, the branch having been worked on", async () => {
    const parent = await refusedByCostLimit(7, 0.37, true);
    assert.equal(parent.isolation, "worktree", "the premise: the run has a branch");
    assert.equal(parent.iterations, 0, "the premise: the refund put the counter back to zero");
    const card = db().prepare("SELECT 1 FROM run_events WHERE run_id = ? AND kind = 'handoff'");
    for (let i = 0; i < 300 && !card.get(parent.id); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(card.get(parent.id), "a run that worked on a branch ended without describing it");
  });

  // A run refused before its first cycle did nothing, which is what `blocked`
  // says. The time limit is the guard that can refuse one: `0` is "off" for the
  // spending limit, and a time limit smaller than any elapsed minute is not.
  it("control: a run refused before it spent anything or spawned a child still ends blocked", async () => {
    seq += 1;
    const id = start(`cost-limited-${seq}`, [], { maxIterations: 1, maxDurationMinutes: 1e-9 });
    const row = await settled(id);
    assert.equal(row.iterations, 0);
    assert.equal(row.spent_usd, 0);
    assert.equal(argvs.length, 0, "the premise: no child ever spawned");
    assert.equal(row.status, "blocked", row.stop_reason ?? "");
  });
});

/**
 * A second run set to continue a branch whose first continuer worked, had the
 * cycle it worked in refunded, and was stopped.
 *
 * Admission refuses a second continuer, because two runs committing to one
 * branch leave the chain with no last link, and lets one through beside a
 * continuer that ended having run nothing. It told those apart by `iterations
 * > 0` alone, which the refund puts back to zero, so the second run was admitted
 * on top of the first one's commits.
 *
 * The endings are written rather than driven: the refund that leaves them is
 * what the cases above drive through a real park, and the question here is only
 * what admission reads off the rows. The folder is a real repository because a
 * released continuer is planned onto its predecessor's branch at creation.
 */
describe("a second run continuing a branch whose continuer was refunded", () => {
  const { setNewWorkPaused } = settings;
  let seq = 0;
  const made: string[] = [];

  function create(
    folder: string,
    dependsOn: Array<{ runId: string; continueBranch: boolean; edge?: "on-success" | "on-finish" | "on-failure" }>,
  ): string {
    const run = createRun({
      folder,
      mountId: null,
      prompt: "carry on",
      budget: { maxIterations: 1 },
      origin: "form",
      dependsOn: dependsOn.map((d) => ({ ...d, edge: d.edge ?? ("on-finish" as const) })),
    });
    made.push(run.id);
    return run.id;
  }

  /** A finished predecessor and a first continuer of it, stopped at zero cycles. */
  function stoppedContinuer(counter: string) {
    seq += 1;
    // The whole case under the hold, so no run is promoted into a spawn.
    setNewWorkPaused(true);
    const folder = `rival-${seq}`;
    makeRepo(folder);
    const predecessor = create(folder, []);
    assert.equal(getRun(predecessor)!.isolation, "worktree", "the premise: the predecessor has a branch");
    db().prepare("UPDATE runs SET status = 'completed', iterations = 1 WHERE id = ?").run(predecessor);
    const first = create(folder, [{ runId: predecessor, continueBranch: true }]);
    db()
      .prepare(`UPDATE runs SET status = 'stopped', iterations = 0, ${counter} = 1 WHERE id = ?`)
      .run(first);
    return { folder, predecessor, first };
  }

  afterEach(() => {
    for (const id of made.splice(0)) stopRun(id);
    setNewWorkPaused(false);
  });

  it("refuses the second, naming the first, whichever refund left it at zero", () => {
    for (const counter of ["stack_waits", "guard_refunds", "early_ends", "worked_refunds"]) {
      const { folder, predecessor, first } = stoppedContinuer(counter);
      assert.throws(
        () => create(folder, [{ runId: predecessor, continueBranch: true }]),
        new RegExp(
          `Run ${first.slice(0, 8)} is already set to continue run ${predecessor.slice(0, 8)}'s branch \\(it is stopped\\)`,
        ),
        `a continuer with a refunded cycle (${counter}) was read as one that never ran`,
      );
    }
  });

  // `pause_count` is not the answer for the reason it is not in `edgeSatisfied`:
  // a provider refusal refunds a cycle that was turned away before any work, so
  // a continuer refused at the wall and stopped put nothing on the branch.
  it("control: admits the second beside a continuer the provider refused at the wall", () => {
    const { folder, predecessor, first } = stoppedContinuer("refusal_pauses");
    db().prepare("UPDATE runs SET pause_count = 1 WHERE id = ?").run(first);
    assert.doesNotThrow(() => create(folder, [{ runId: predecessor, continueBranch: true }]));
  });

  // The one pair admission lets share a branch: an on-success continuer and an
  // on-failure one, both still waiting on a predecessor that has not ended. The
  // rows are what `branchRivalOf` reads the opposite condition off.
  describe("beside a sibling waiting on the opposite condition", () => {
    const orch = require("./orchestrator") as typeof import("./orchestrator");
    const land = require("./land") as typeof import("./land");

    function waitingPair() {
      seq += 1;
      setNewWorkPaused(true);
      const folder = `pair-${seq}`;
      makeRepo(folder);
      const predecessor = create(folder, []);
      assert.equal(getRun(predecessor)!.isolation, "worktree", "the premise: the predecessor has a branch");
      const success = create(folder, [{ runId: predecessor, edge: "on-success", continueBranch: true }]);
      const fixer = create(folder, [{ runId: predecessor, edge: "on-failure", continueBranch: true }]);
      return { folder, predecessor, success, fixer };
    }

    it("admits both, each recorded as continuing the predecessor", () => {
      const { predecessor, success, fixer } = waitingPair();
      for (const id of [success, fixer]) {
        assert.equal(getRun(id)!.status, "waiting", id);
        assert.equal(getRun(id)!.continues_run, predecessor, id);
      }
    });

    it("refuses a third continuer whatever condition it waits on", () => {
      const { folder, predecessor, success, fixer } = waitingPair();
      // Each overlaps one half of the pair, and a run it overlaps is named.
      // on-finish overlaps both, and which of the two is named is not decided.
      const overlapped = {
        "on-success": [success],
        "on-failure": [fixer],
        "on-finish": [success, fixer],
      } as const;
      for (const edge of ["on-success", "on-failure", "on-finish"] as const) {
        const named = overlapped[edge].map((id) => id.slice(0, 8)).join("|");
        assert.throws(
          () => create(folder, [{ runId: predecessor, edge, continueBranch: true }]),
          new RegExp(`Run (${named}) is already set to continue run ${predecessor.slice(0, 8)}'s branch`),
          edge,
        );
      }
    });

    it("starts only the fixer when the predecessor fails", () => {
      const { predecessor, success, fixer } = waitingPair();
      db()
        .prepare("UPDATE runs SET status = 'failed', iterations = 1, finished_at = ? WHERE id = ?")
        .run(Date.now(), predecessor);
      // The hold kept the pair from being promoted while it was built; a release
      // pass does nothing under it, and admission queues without promoting.
      setNewWorkPaused(false);
      orch.releaseDependents();
      assert.equal(getRun(fixer)!.status, "queued", getRun(fixer)!.stop_reason ?? "");
      assert.equal(getRun(fixer)!.worktree_branch, getRun(predecessor)!.worktree_branch);
      assert.equal(getRun(success)!.status, "blocked");
      assert.equal(getRun(success)!.ending_code, "dependency");
      // The success run is the older row and is still on the branch's books, so
      // this is the readers' case: the chain has to follow the continuer that
      // can still commit, and the branch has one owner.
      assert.deepEqual(
        land.chainRuns(getRun(predecessor)!).map((r) => r.id),
        [predecessor, fixer],
      );
      assert.equal(land.branchOwnerOf(getRun(fixer)!), fixer);
    });

    it("starts only the success run when the predecessor completes, the fixer being not needed", () => {
      const { predecessor, success, fixer } = waitingPair();
      db()
        .prepare("UPDATE runs SET status = 'completed', iterations = 1, finished_at = ? WHERE id = ?")
        .run(Date.now(), predecessor);
      setNewWorkPaused(false);
      orch.releaseDependents();
      assert.equal(getRun(success)!.status, "queued", getRun(success)!.stop_reason ?? "");
      assert.equal(getRun(fixer)!.status, "not-needed");
      assert.equal(getRun(fixer)!.ending_code, "not_needed");
      assert.deepEqual(
        land.chainRuns(getRun(predecessor)!).map((r) => r.id),
        [predecessor, success],
      );
      assert.equal(land.branchOwnerOf(getRun(success)!), success);
    });

    it("refuses to release the fixer onto a branch the success run already worked on", () => {
      // A completed predecessor picked up and ended failed meets the other
      // condition after all, by which time its success continuer has committed.
      const { predecessor, success, fixer } = waitingPair();
      db().prepare("UPDATE runs SET status = 'completed', iterations = 1 WHERE id = ?").run(success);
      db()
        .prepare("UPDATE runs SET status = 'failed', iterations = 1, finished_at = ? WHERE id = ?")
        .run(Date.now(), predecessor);
      // The hold kept the pair from being promoted while it was built; a release
      // pass does nothing under it, and admission queues without promoting.
      setNewWorkPaused(false);
      orch.releaseDependents();
      const row = getRun(fixer)!;
      assert.equal(row.status, "failed");
      assert.equal(row.ending_code, "error");
      assert.match(row.stop_reason ?? "", new RegExp(`Run ${success.slice(0, 8)} already carries on run ${predecessor.slice(0, 8)}'s branch`));
    });
  });

  // The third door onto a branch. A continuer released and then stopped before
  // its first cycle holds a workspace, so a pick-up queues it directly rather
  // than through the release pass — and admission has meanwhile read it as
  // holding nothing, which is what lets another continuer on.
  describe("picked up again having run nothing", () => {
    const RAISED = { maxIterations: 5, maxDurationMinutes: 60 };

    function settle(id: string, status: "completed" | "failed"): void {
      db()
        .prepare("UPDATE runs SET status = ?, iterations = 1, finished_at = ? WHERE id = ?")
        .run(status, Date.now(), id);
    }

    /** A release pass, which does nothing under the hold the case is built under. */
    function releasePass(): void {
      setNewWorkPaused(false);
      releaseDependents();
      setNewWorkPaused(true);
    }

    /** A completed predecessor, and an on-success continuer released onto its branch and stopped at zero cycles. */
    function stoppedBeforeStart() {
      seq += 1;
      setNewWorkPaused(true);
      const folder = `pick-up-${seq}`;
      makeRepo(folder);
      const predecessor = create(folder, []);
      assert.equal(getRun(predecessor)!.isolation, "worktree", "the premise: the predecessor has a branch");
      settle(predecessor, "completed");
      const success = create(folder, [{ runId: predecessor, edge: "on-success", continueBranch: true }]);
      assert.equal(getRun(success)!.status, "queued", "the premise: released at creation");
      assert.notEqual(getRun(success)!.work_dir, null, "the premise: it holds a workspace, so it skips waiting");
      assert.equal(stopRun(success), "cancelled");
      assert.equal(getRun(success)!.iterations, 0);
      return { folder, predecessor, success };
    }

    it("control: queues it on the branch when no other run has taken it", () => {
      const { predecessor, success } = stoppedBeforeStart();
      assert.deepEqual(reopenRun(success, RAISED), { ok: true });
      assert.equal(getRun(success)!.status, "queued");
      assert.equal(getRun(success)!.worktree_branch, getRun(predecessor)!.worktree_branch);
    });

    it("refuses it, naming the continuer admitted onto the branch and worked since", () => {
      const { folder, predecessor, success } = stoppedBeforeStart();
      const second = create(folder, [{ runId: predecessor, edge: "on-success", continueBranch: true }]);
      assert.equal(
        getRun(second)!.worktree_branch,
        getRun(predecessor)!.worktree_branch,
        "the premise: admission let a second continuer onto the branch",
      );
      settle(second, "completed");
      const outcome = reopenRun(success, RAISED);
      assert.equal(outcome.ok, false, "queued beside a run that already carries the branch on");
      assert.match(
        outcome.ok ? "" : outcome.reason,
        new RegExp(`Run ${second.slice(0, 8)} carries on run ${predecessor.slice(0, 8)}'s branch now \\(it is completed\\)`),
      );
      assert.equal(getRun(success)!.status, "stopped");
    });

    it("refuses the success run behind a predecessor picked up and failed, whose fixer took the branch", () => {
      seq += 1;
      setNewWorkPaused(true);
      const folder = `pick-up-pair-${seq}`;
      makeRepo(folder);
      const predecessor = create(folder, []);
      const success = create(folder, [{ runId: predecessor, edge: "on-success", continueBranch: true }]);
      const fixer = create(folder, [{ runId: predecessor, edge: "on-failure", continueBranch: true }]);
      settle(predecessor, "completed");
      releasePass();
      assert.equal(getRun(success)!.status, "queued");
      assert.equal(getRun(fixer)!.status, "not-needed");
      assert.equal(stopRun(success), "cancelled");
      // Picked up and failed this time, so the fixer is needed after all.
      assert.deepEqual(reopenRun(predecessor, RAISED), { ok: true });
      assert.equal(getRun(fixer)!.status, "waiting", "the premise: the fixer is revived");
      settle(predecessor, "failed");
      releasePass();
      assert.equal(getRun(fixer)!.status, "queued", getRun(fixer)!.stop_reason ?? "");
      settle(fixer, "completed");
      const outcome = reopenRun(success, RAISED);
      assert.equal(outcome.ok, false, "queued behind a failed predecessor onto the branch its fixer committed to");
      assert.match(
        outcome.ok ? "" : outcome.reason,
        new RegExp(`Run ${fixer.slice(0, 8)} carries on run ${predecessor.slice(0, 8)}'s branch now`),
      );
      assert.equal(getRun(success)!.status, "stopped");
    });

    it("refuses it behind a predecessor picked up and failed, with no other run on the branch", () => {
      const { predecessor, success } = stoppedBeforeStart();
      assert.deepEqual(reopenRun(predecessor, RAISED), { ok: true });
      settle(predecessor, "failed");
      const outcome = reopenRun(success, RAISED);
      assert.equal(outcome.ok, false, "queued as a success run behind a failure");
      assert.match(
        outcome.ok ? "" : outcome.reason,
        new RegExp(`Set to start only after run ${predecessor.slice(0, 8)} succeeded \\(on-success\\); it ended failed`),
      );
      assert.equal(getRun(success)!.status, "stopped");
    });

    // The same pick-up for a run that carries no branch: nothing is shared, so
    // `branchRivalOf` has nothing to say, and the only thing left to re-ask is
    // the dependency condition itself.
    describe("with no branch handed over", () => {
      /** A completed predecessor, and a plain on-success dependent released onto it and stopped at zero cycles. */
      function stoppedPlainDependent() {
        seq += 1;
        setNewWorkPaused(true);
        const folder = `pick-up-plain-${seq}`;
        makeRepo(folder);
        const predecessor = create(folder, []);
        settle(predecessor, "completed");
        const dependent = create(folder, [{ runId: predecessor, edge: "on-success", continueBranch: false }]);
        assert.equal(getRun(dependent)!.status, "queued", "the premise: released at creation");
        assert.notEqual(getRun(dependent)!.work_dir, null, "the premise: it holds a workspace, so it skips waiting");
        assert.equal(getRun(dependent)!.continues_run, null, "the premise: it shares no branch");
        assert.equal(stopRun(dependent), "cancelled");
        assert.equal(getRun(dependent)!.iterations, 0);
        return { folder, predecessor, dependent };
      }

      it("control: queues it while the predecessor it waited for is still completed", () => {
        const { dependent } = stoppedPlainDependent();
        assert.deepEqual(reopenRun(dependent, RAISED), { ok: true });
        assert.equal(getRun(dependent)!.status, "queued");
      });

      it("refuses it behind a predecessor picked up and failed", () => {
        const { predecessor, dependent } = stoppedPlainDependent();
        assert.deepEqual(reopenRun(predecessor, RAISED), { ok: true });
        settle(predecessor, "failed");
        const outcome = reopenRun(dependent, RAISED);
        assert.equal(outcome.ok, false, "queued as an on-success run behind a failed dependency");
        assert.match(
          outcome.ok ? "" : outcome.reason,
          new RegExp(`Set to start only after run ${predecessor.slice(0, 8)} succeeded \\(on-success\\); it ended failed`),
        );
        assert.equal(getRun(dependent)!.status, "stopped");
      });

      it("refuses it, saying to wait, while the predecessor picked up is still running", () => {
        const { predecessor, dependent } = stoppedPlainDependent();
        assert.deepEqual(reopenRun(predecessor, RAISED), { ok: true });
        assert.equal(getRun(predecessor)!.status, "queued", "the premise: the predecessor is back in the queue");
        const outcome = reopenRun(dependent, RAISED);
        assert.equal(outcome.ok, false, "queued beside the dependency it was ordered behind");
        assert.match(outcome.ok ? "" : outcome.reason, new RegExp(`Run ${predecessor.slice(0, 8)} is queued`));
        assert.equal(getRun(dependent)!.status, "stopped");
      });

      it("asks every edge of a fan-in, not only the one that names the branch", () => {
        seq += 1;
        setNewWorkPaused(true);
        const folder = `pick-up-fan-in-${seq}`;
        makeRepo(folder);
        const first = create(folder, []);
        const second = create(folder, []);
        settle(first, "completed");
        settle(second, "completed");
        const continuer = create(folder, [
          { runId: first, edge: "on-success", continueBranch: true },
          { runId: second, edge: "on-success", continueBranch: false },
        ]);
        assert.equal(getRun(continuer)!.status, "queued", "the premise: released at creation");
        assert.equal(getRun(continuer)!.continues_run, first, "the premise: the branch is the first one's");
        assert.equal(stopRun(continuer), "cancelled");
        // The edge that names the branch still holds; the other one does not.
        assert.deepEqual(reopenRun(second, RAISED), { ok: true });
        settle(second, "failed");
        const outcome = reopenRun(continuer, RAISED);
        assert.equal(outcome.ok, false, "queued behind a failed dependency on an edge that hands over no branch");
        assert.match(
          outcome.ok ? "" : outcome.reason,
          new RegExp(`Set to start only after run ${second.slice(0, 8)} succeeded \\(on-success\\); it ended failed`),
        );
        assert.equal(getRun(continuer)!.status, "stopped");
      });
    });
  });
});

/**
 * A task check started in a cycle that ends in a park, whose verdict lands while
 * the run is parked.
 *
 * The boundary acts only on a verdict that finished inside the cycle it closes,
 * so that a verdict buys a cycle once — and a park breaks out above the boundary,
 * which reads nothing. The first boundary after the resume then read from the
 * resumed cycle's start, and a `not-finished` that landed during the wait was
 * older than that: no pushback, no cycle, and the run ended `completed` still
 * holding the task the validator had just judged unfinished.
 */
describe("a task check left in flight by a park", () => {
  let seq = 0;

  /** What `complete_task` leaves when the check is on: the task claimed, a check running. */
  function claimAndValidate(runId: string): { taskId: string; reviewId: string } {
    seq += 1;
    const parsed = tasks.normalizeTaskInput(
      { title: `Ship the crate ${seq}`, body: "the brief" },
      { origin: "operator", createdByRunId: null },
    );
    if (!parsed.ok) throw new Error(parsed.error);
    const created = tasks.createTask(parsed.value);
    if (!created.ok) throw new Error(created.error);
    const claimed = tasks.updateTask(created.task.id, { status: "claimed" }, { kind: "run", runId });
    if (!claimed.ok) throw new Error(claimed.error);
    const reviewId = `review-parked-${seq}`;
    db()
      .prepare(
        `INSERT INTO run_reviews (id, run_id, kind, created_at, finished_at, status, text, verdict, task_id)
         VALUES (?, ?, 'validate', ?, NULL, 'running', NULL, NULL, ?)`,
      )
      .run(reviewId, runId, Date.now(), created.task.id);
    return { taskId: created.task.id, reviewId };
  }

  function verdictLands(reviewId: string): void {
    const text = [
      "```json",
      JSON.stringify({ verdict: "not-finished", reason: "PARKED-MARKER the tests were never written" }),
      "```",
    ].join("\n");
    db()
      .prepare(
        "UPDATE run_reviews SET status='completed', finished_at=?, text=?, verdict='not-finished' WHERE id=?",
      )
      .run(Date.now(), text, reviewId);
  }

  /** How the first cycle ends besides claiming the task, and how the run is handed back. */
  type Park = "stack" | "ceiling" | "guard";

  async function scenario(folder: string, park: Park, verdictDuringPark: boolean) {
    settings.saveSettings({ validateTaskCompletion: true, maxValidationCycles: 2 });
    let handles: { taskId: string; reviewId: string } | null = null;
    const ask = park === "stack" || park === "ceiling" ? { name: `zig-${folder}`, binaries: ["zig"] } : undefined;
    const id = start(folder, [
      {
        ask,
        during: () => {
          handles = claimAndValidate(scriptedRun);
          if (park === "ceiling") {
            interrupts.set(scriptedRun, {
              kind: "prune",
              reason: "This work cycle's context reached the ceiling.",
              pause: false,
              at: Date.now(),
            });
          }
          if (park === "guard") {
            interrupts.set(scriptedRun, {
              kind: "guard",
              reason: "Paused: this run reached its share of the 5-hour window.",
              code: "session_fraction",
              pause: true,
              // An hour out, so the sweeper never hands it back on its own.
              resumeAt: Date.now() + 3_600_000,
              at: Date.now(),
            });
          }
        },
        reply: "Called complete_task.",
      },
      {
        during: () => {
          if (!verdictDuringPark) verdictLands(handles!.reviewId);
        },
        reply: "Carried on. DONE",
      },
      { reply: "Wrote the tests. DONE" },
    ]);

    const parked = await settled(id);
    assert.equal(parked.status, park === "guard" ? "paused" : "waiting-for-stack", parked.stop_reason ?? "");
    if (verdictDuringPark) verdictLands(handles!.reviewId);
    // Later than the verdict by a clock tick, so the resumed cycle's start
    // cannot share its millisecond and admit it by accident.
    await new Promise((r) => setTimeout(r, 20));
    if (park === "guard") {
      assert.equal(resumeRun(id), "requeued");
    } else {
      const [request] = stackRequestsOfRun(id);
      assert.equal(declineStackRequest(request.id), true);
      releaseStackWaits(readReceipts(receiptsDir).receipts);
    }

    const done = await settled(id);
    const task = tasks.getTask(handles!.taskId)!;
    const prompts = argvs.map((args) => args[args.indexOf("--") + 1]);
    return { done, task, prompts };
  }

  function assertVerdictBoughtACycle(r: Awaited<ReturnType<typeof scenario>>, expected: number): void {
    assert.equal(
      r.prompts.length,
      expected,
      `the verdict was dropped: ${r.prompts.length} spawns, run ${r.done.status} (${r.done.stop_reason}), ` +
        `task ${r.task.status} and claimed by ${r.task.claimedByRunId === r.done.id ? "this run" : r.task.claimedByRunId}`,
    );
    assert.match(r.prompts[expected - 1], /PARKED-MARKER/, "the granted cycle was not shown the evidence");
    assert.equal(r.done.validation_cycles, 1, "a verdict buys one cycle");
  }

  it("control: a verdict that lands in the resumed cycle buys a cycle", async () => {
    assertVerdictBoughtACycle(await scenario("verdict-after-resume", "stack", false), 3);
  });

  it("acts on a verdict that landed while the run waited for a stack", async () => {
    assertVerdictBoughtACycle(await scenario("verdict-during-stack-wait", "stack", true), 3);
  });

  it("acts on a verdict that landed while a ceiling-cut cycle's park waited", async () => {
    assertVerdictBoughtACycle(await scenario("verdict-during-ceiling-park", "ceiling", true), 3);
  });

  it("acts on a verdict that landed while a guard had the run paused", async () => {
    assertVerdictBoughtACycle(await scenario("verdict-during-guard-pause", "guard", true), 3);
  });

  /**
   * The same claim made in a cycle that ended `needs-review`, which sits above
   * the boundary and so ends without waiting for the check, and the run picked
   * up by the operator. A pick-up is a fresh segment, but the boundary read the
   * verdict by when it finished alone: one that landed after the pick-up's
   * first spawn overrode that cycle's DONE and bought a cycle out of
   * `maxValidationCycles`, where the same verdict landing a moment before the
   * pick-up bought nothing.
   */
  describe("and by a needs-review ending, then picked up", () => {
    async function pickedUp(folder: string, verdictAfterPickupSpawn: boolean) {
      settings.saveSettings({ validateTaskCompletion: true, maxValidationCycles: 2 });
      let handles: { taskId: string; reviewId: string } | null = null;
      const id = start(folder, [
        {
          during: () => {
            handles = claimAndValidate(scriptedRun);
          },
          reply: "Called complete_task, then hit a wall I cannot pass.\nNEEDS_REVIEW",
        },
        {
          during: () => {
            if (verdictAfterPickupSpawn) verdictLands(handles!.reviewId);
          },
          reply: "Answered the operator's note.\nDONE",
        },
        { reply: "Wrote the tests.\nDONE" },
      ]);
      const first = await settled(id);
      assert.equal(first.status, "needs-review", first.stop_reason ?? "");
      if (!verdictAfterPickupSpawn) verdictLands(handles!.reviewId);
      // A clock tick, so the pick-up cannot share the claim's millisecond.
      await new Promise((r) => setTimeout(r, 20));
      const picked = reopenRun(id, { maxIterations: 2 }, "Use the other compiler and carry on.");
      assert.equal(picked.ok, true, JSON.stringify(picked));
      const done = await settled(id);
      const prompts = argvs.map((args) => args[args.indexOf("--") + 1]);
      assert.equal(
        prompts.length,
        2,
        `the previous segment's verdict bought the pick-up a cycle: run ${done.status} (${done.stop_reason})`,
      );
      assert.doesNotMatch(prompts[1], /PARKED-MARKER/);
      assert.equal(done.status, "completed", done.stop_reason ?? "");
      assert.equal(done.validation_cycles, 0);
    }

    it("control: a verdict that landed before the pick-up buys nothing", async () => {
      await pickedUp("needs-review-verdict-before-pickup", false);
    });

    it("a verdict that lands after the pick-up's first spawn buys nothing either", async () => {
      await pickedUp("needs-review-verdict-after-pickup", true);
    });

    /**
     * The check from the cycle before the pick-up is still reading when the
     * pick-up's cycle ends. Its verdict is never acted on, so the boundary
     * used to wait out its ten minutes for nothing, holding the run's folder
     * and slot while its dependents and the runs queued behind it waited.
     */
    it("is not held at the pick-up's first boundary by a check still reading from before it", async () => {
      settings.saveSettings({ validateTaskCompletion: true, maxValidationCycles: 2 });
      // An array rather than a variable the closure assigns, which the compiler
      // narrows to null at every later read.
      const claims: { taskId: string; reviewId: string }[] = [];
      const id = start("needs-review-check-still-reading", [
        {
          during: () => {
            claims.push(claimAndValidate(scriptedRun));
          },
          reply: "Called complete_task, then hit a wall I cannot pass.\nNEEDS_REVIEW",
        },
        { reply: "Answered the operator's note.\nDONE" },
      ]);
      try {
        const first = await settled(id);
        assert.equal(first.status, "needs-review", first.stop_reason ?? "");
        // A clock tick, so the pick-up cannot share the claim's millisecond.
        await new Promise((r) => setTimeout(r, 20));
        const pickedAt = Date.now();
        const picked = reopenRun(id, { maxIterations: 2 }, "Use the other compiler and carry on.");
        assert.equal(picked.ok, true, JSON.stringify(picked));

        const done = await settled(id);
        const elapsed = Date.now() - pickedAt;
        assert.equal(done.status, "completed", done.stop_reason ?? "");
        assert.equal(argvs.length, 2);
        assert.equal(done.validation_cycles, 0);
        // The boundary polls every two seconds and waits eleven minutes for a
        // check that never answers, so any wait at all is far past this.
        assert.ok(elapsed < 6_000, `the pick-up's boundary waited ${elapsed}ms for the old check`);
        const row = db()
          .prepare("SELECT status FROM run_reviews WHERE id = ?")
          .get(claims[0].reviewId) as { status: string };
        assert.equal(row.status, "running", "the old check settled, so nothing was left to wait for");
      } finally {
        // A failing case leaves the boundary polling this row; settle it so the
        // wait ends rather than holding the test process open.
        for (const claim of claims) {
          db()
            .prepare("UPDATE run_reviews SET status='failed', finished_at=? WHERE id=?")
            .run(Date.now(), claim.reviewId);
        }
      }
    });
  });
});
