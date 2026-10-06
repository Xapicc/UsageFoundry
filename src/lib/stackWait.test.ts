import assert from "node:assert/strict";
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

const { createRun, getRun, reconcileOnBoot, releaseStackWaits, resumeRun, stopRun } =
  require("./orchestrator") as typeof import("./orchestrator");
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

function start(folder: string, cycles: Cycle[]): string {
  fs.mkdirSync(path.join(tmp, "workspace", folder), { recursive: true });
  script = [...cycles];
  argvs = [];
  const run = createRun({
    folder,
    mountId: null,
    prompt: "build the crate",
    // The default cap, which is the case the refund exists for.
    budget: { maxIterations: 1 },
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
});
