import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Task } from "./tasks";

/**
 * A run closing several tasks while one is being checked.
 *
 * A run is checked one task at a time, and a second `complete_task` used to be
 * closed unchecked. Briefs that wanted every close read answered that by telling
 * their runs to close one task per turn, a turn is a work cycle, and runs holding
 * more tasks than cycles ended `completed` with the rest still claimed by them —
 * on the board, a finished run working tasks it had finished. So the second
 * claim now waits its turn and is checked when the first settles, and this
 * drives that through the real path: a real repository and branch,
 * `completeTaskWithValidation` as `complete_task` calls it, and a stand-in
 * `claude` that reads until it is told to answer `finished`, or is signalled.
 *
 * Its own file, with `DATA_DIR` named before the first import, for
 * `loopMergeOwnership.test.ts`'s reason.
 */

let validation: typeof import("./validation");
let review: typeof import("./review");
let orchestrator: typeof import("./orchestrator");
let tasks: typeof import("./tasks");
let settings: typeof import("./settings");
let database: typeof import("./db");
let diffModule: typeof import("./diff");
let root: string;

const MOUNT_DIR = "validation-queue-mount";
const BRANCH = "uf/validation-queue";
const repoRoot = () => path.join(root, MOUNT_DIR, "repo");
const control = (name: "started" | "answer") => path.join(root, `stub-${name}`);

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });

/**
 * A `claude` that reads until `answer` exists or it is signalled, then answers
 * `finished`. `started` gets a line per child, which is how a case counts them.
 */
function writeStub(dir: string): string {
  const stub = path.join(dir, "claude-stub.js");
  const verdict = JSON.stringify({
    verdict: "finished",
    reason: "the change the task names is on the branch",
    evidence: [],
  });
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(control("started"))}, String(process.pid) + "\\n");
const answer = () => {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "\`\`\`json\\n" + ${JSON.stringify(verdict)} + "\\n\`\`\`", total_cost_usd: 0.02 }) + "\\n");
  process.exit(0);
};
process.on("SIGINT", answer);
setInterval(() => {
  if (fs.existsSync(${JSON.stringify(control("answer"))})) answer();
}, 20);
setTimeout(() => process.exit(9), 30000);
`,
    { mode: 0o755 },
  );
  return stub;
}

before(async () => {
  // `realpathSync`, which `resolveInMount` checks containment against.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-validation-queue-")));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  // `planUsage` looks for an OAuth token here, and a unit test must not send a
  // request on the operator's own credential.
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, MOUNT_DIR);
  process.env.WORKSPACE_ROOTS = "";
  process.env.CLAUDE_BIN = writeStub(root);
  fs.mkdirSync(path.join(root, "claude", "projects"), { recursive: true });

  fs.mkdirSync(repoRoot(), { recursive: true });
  git(repoRoot(), "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repoRoot(), "a.txt"), "one\n");
  git(repoRoot(), "add", "-A");
  git(repoRoot(), "commit", "-q", "-m", "first");
  git(repoRoot(), "checkout", "-q", "-b", BRANCH);
  fs.writeFileSync(path.join(repoRoot(), "a.txt"), "two\n");
  git(repoRoot(), "commit", "-q", "-am", "the tasks' change");
  git(repoRoot(), "checkout", "-q", "main");

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );
  assert.equal(config.CLAUDE_BIN, process.env.CLAUDE_BIN);

  database = await import("./db");
  settings = await import("./settings");
  tasks = await import("./tasks");
  validation = await import("./validation");
  review = await import("./review");
  orchestrator = await import("./orchestrator");
  diffModule = await import("./diff");
  settings.saveSettings({ validateTaskCompletion: true });
});

after(() => {
  // A failing case leaves its stub reading; let it go rather than wait out the
  // backstop.
  fs.writeFileSync(control("answer"), "");
  const open = (globalThis as { __ufDb?: { close(): void } }).__ufDb;
  open?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  for (const name of ["started", "answer"] as const) {
    fs.rmSync(control(name), { force: true });
  }
});

let seq = 0;

/** A run on its own branch, in the status the case needs. */
function worktreeRun(status: "running" | "paused"): string {
  const runId = `run-queue-${(seq += 1)}`;
  const base = git(repoRoot(), "rev-parse", "main").trim();
  database
    .db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                         created_at, isolation, repo_root, worktree_branch, worktree_base,
                         worktree_base_branch, worktree_path)
       VALUES (?, ?, 'change a', ?, '{}', 5, 1, ?, 'worktree', ?, ?, ?, 'main', ?)`,
    )
    .run(runId, repoRoot(), status, Date.now(), repoRoot(), BRANCH, base, repoRoot());
  return runId;
}

/** Filed through the real door and claimed by the run, as a started run's are. */
function heldTask(runId: string, title: string): Task {
  const parsed = tasks.normalizeTaskInput(
    { title, body: "change a.txt" },
    { origin: "operator", createdByRunId: null },
  );
  if (!parsed.ok) throw new Error(`fixture refused at the door: ${parsed.error}`);
  const created = tasks.createTask(parsed.value);
  if (!created.ok) throw new Error(`fixture refused by the store: ${created.error}`);
  const claimed = tasks.updateTask(created.task.id, { status: "claimed" }, { kind: "run", runId });
  if (!claimed.ok) throw new Error(`fixture claim refused: ${claimed.error}`);
  return claimed.task;
}

/** `tick` 0 polls on `setImmediate`, for a state that lasts only a diff read. */
async function until(what: string, ready: () => boolean, tick = 20): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!ready()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => (tick === 0 ? setImmediate(resolve) : setTimeout(resolve, tick)));
  }
}

const childrenStarted = () =>
  fs.existsSync(control("started"))
    ? fs.readFileSync(control("started"), "utf8").trim().split("\n").length
    : 0;

const checksOf = (runId: string) => review.listReviews(runId, "validate");

function logLines(runId: string): string[] {
  return (
    database
      .db()
      .prepare("SELECT payload FROM run_events WHERE run_id = ? AND kind = 'log' ORDER BY id")
      .all(runId) as { payload: string }[]
  ).map((row) => (JSON.parse(row.payload) as { message: string }).message);
}

describe("a second complete_task while the first is being checked", () => {
  it("is queued and checked after the first, rather than closed unchecked", async () => {
    const runId = worktreeRun("running");
    const first = heldTask(runId, "First task");
    const second = heldTask(runId, "Second task");
    const since = Date.now();

    // Together, as a model's parallel tool calls arrive: the second is asked
    // while the first is still reading its diff, before any row names it.
    const [a, b] = await Promise.all([
      validation.completeTaskWithValidation(first.id, runId),
      validation.completeTaskWithValidation(second.id, runId),
    ]);
    assert.equal(a.kind, "checking", JSON.stringify(a));
    assert.deepEqual(
      b.kind === "queued" ? { kind: b.kind, ahead: b.ahead } : b,
      { kind: "queued", ahead: 1 },
      "the second claim was not queued behind the first",
    );
    await until("the first check to start", () => childrenStarted() === 1);

    const waiting = tasks.getTask(second.id)!;
    assert.equal(waiting.status, "claimed", "the second task was closed without being checked");
    assert.equal(waiting.claimedByRunId, runId);
    assert.equal(checksOf(runId).length, 1, "two checks of one run were started at once");
    assert.equal(validation.validationInFlight(runId), true);

    // The boundary has to wait out the queue as well as the check reading, or
    // the run would end with the second verdict still to come.
    let boundaryDone = false;
    const boundary = validation
      .validationAtBoundary(runId, since, () => false)
      .then((answer) => {
        boundaryDone = true;
        return answer;
      });

    fs.writeFileSync(control("answer"), "");
    assert.equal(await boundary, null);
    assert.ok(boundaryDone);

    for (const task of [first, second]) {
      const closed = tasks.getTask(task.id)!;
      assert.equal(closed.status, "done", `${task.title} was not closed`);
      assert.equal(closed.completedByRunId, runId);
    }
    const checks = checksOf(runId);
    assert.equal(checks.length, 2);
    assert.deepEqual(
      checks.map((row) => [row.task_id, row.verdict]).sort(),
      [
        [first.id, "finished"],
        [second.id, "finished"],
      ].sort(),
      "a task closed on a null verdict was closed unchecked",
    );
    assert.equal(childrenStarted(), 2);
  });

  it("is not checked or closed once the operator has stopped the run", async () => {
    const runId = worktreeRun("paused");
    const first = heldTask(runId, "First task, then Stop");
    const second = heldTask(runId, "Second task, then Stop");

    const a = await validation.completeTaskWithValidation(first.id, runId);
    assert.equal(a.kind, "checking", JSON.stringify(a));
    await until("the first check to start", () => childrenStarted() === 1);
    const b = await validation.completeTaskWithValidation(second.id, runId);
    assert.equal(b.kind, "queued", JSON.stringify(b));

    assert.equal(orchestrator.stopRun(runId), "cancelled");
    await until(
      "the first check to settle",
      () => checksOf(runId).every((row) => row.status !== "running"),
    );
    await until("the queue to empty", () => !validation.validationInFlight(runId));
    // Grace for a wrongly started child to announce itself.
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(childrenStarted(), 1, "a queued check was started for a stopped run");
    assert.equal(checksOf(runId).length, 1);
    for (const task of [first, second]) {
      const held = tasks.getTask(task.id)!;
      assert.equal(held.status, "claimed", `${task.title} was closed after the Stop`);
      assert.equal(held.claimedByRunId, runId);
    }
    assert.ok(
      logLines(runId).some(
        (line) => line.includes("Second task, then Stop") && /stopped/i.test(line),
      ),
      logLines(runId).join("\n"),
    );
  });

  it("are all closed when checks are switched off while they wait", async () => {
    const runId = worktreeRun("running");
    const first = heldTask(runId, "First task, then checks off");
    const second = heldTask(runId, "Second task, closed with checks off");
    const third = heldTask(runId, "Third task, closed with checks off");
    assert.equal((await validation.completeTaskWithValidation(first.id, runId)).kind, "checking");
    await until("the first check to start", () => childrenStarted() === 1);
    assert.equal((await validation.completeTaskWithValidation(second.id, runId)).kind, "queued");
    assert.equal((await validation.completeTaskWithValidation(third.id, runId)).kind, "queued");

    settings.saveSettings({ validateTaskCompletion: false });
    try {
      fs.writeFileSync(control("answer"), "");
      // Each close has to hand the turn on: the first queued claim closed and
      // the drain stopped there, so the rest stayed claimed until a boot.
      for (const task of [second, third]) {
        await until(
          `${task.title} to close`,
          () => tasks.getTask(task.id)!.status === "done",
        );
      }
    } finally {
      settings.saveSettings({ validateTaskCompletion: true });
    }

    for (const task of [second, third]) {
      assert.equal(tasks.getTask(task.id)!.completedByRunId, runId);
    }
    assert.equal(validation.validationInFlight(runId), false);
    assert.equal(childrenStarted(), 1, "a queued claim was checked with checks switched off");
  });

  it("is closed on the run's word when a restart leaves it queued", () => {
    const runId = worktreeRun("running");
    const task = heldTask(runId, "Queued across a restart");
    // What a dead process leaves: the row, and no settle that would start it.
    database
      .db()
      .prepare("INSERT INTO validation_queue (run_id, task_id, asked_at) VALUES (?, ?, ?)")
      .run(runId, task.id, Date.now());

    validation.closeQueuedValidations();

    const closed = tasks.getTask(task.id)!;
    assert.equal(closed.status, "done", "a claim a restart left queued stayed claimed for good");
    assert.equal(closed.completedByRunId, runId);
    assert.equal(validation.validationInFlight(runId), false);
    assert.ok(
      logLines(runId).some((line) => /restarted before this task could be checked/.test(line)),
      logLines(runId).join("\n"),
    );
  });
});

/** The old process's two checks, both written and neither reading, before a case asserts. */
const settled = (runId: string) =>
  until("both checks to settle", () =>
    checksOf(runId).length === 2 && checksOf(runId).every((row) => row.status !== "running"));

/** `instrumentation.ts`'s boot reconcile, in its order, for a process that died. */
function bootAsInstrumentationDoes(): void {
  validation.closeStrandedValidations(review.reconcileReviewsOnBoot());
  validation.closeQueuedValidations();
}

/**
 * The drain used to delete a claim's queue row and then await the diff read and
 * the window scan before `startAssist` wrote its check row, so a process killed
 * in between left neither row for the boot to find, and the task stayed claimed
 * by a run that had been told its claim was queued. Each case runs the boot's
 * closers inside that window, then lets the old process's check settle so it
 * cannot start a child in the next case.
 */
describe("a queued claim the drain has taken, before its check row exists", () => {
  it("is closed by the next boot if the process dies there", async () => {
    const runId = worktreeRun("running");
    const first = heldTask(runId, "First task, then a crash");
    const second = heldTask(runId, "Second task, taken off the queue");
    assert.equal((await validation.completeTaskWithValidation(first.id, runId)).kind, "checking");
    await until("the first check to start", () => childrenStarted() === 1);
    assert.equal((await validation.completeTaskWithValidation(second.id, runId)).kind, "queued");

    fs.writeFileSync(control("answer"), "");
    const starting = (globalThis as { __ufValidationStarting?: Map<string, string> })
      .__ufValidationStarting!;
    await until("the drain to take the second claim", () => starting.get(runId) === second.id, 0);
    bootAsInstrumentationDoes();
    const afterBoot = tasks.getTask(second.id)!;
    await settled(runId);

    assert.equal(afterBoot.status, "done", "a claim between its queue row and its check row stayed claimed");
    assert.equal(afterBoot.completedByRunId, runId);
  });

  it("is closed by the next boot if the process dies while its diff is read", async () => {
    const runId = worktreeRun("paused");
    const first = heldTask(runId, "First task, parked");
    const second = heldTask(runId, "Second task, read when the first settles");
    assert.equal((await validation.completeTaskWithValidation(first.id, runId)).kind, "checking");
    await until("the first check to start", () => childrenStarted() === 1);
    assert.equal((await validation.completeTaskWithValidation(second.id, runId)).kind, "queued");

    // Held rather than polled for, so the boot lands inside the read every time.
    const realRunDiff = diffModule.runDiff;
    let releaseDiff!: () => void;
    const held = new Promise<void>((resolve) => (releaseDiff = resolve));
    let reads = 0;
    // A module's exports are writable under the CommonJS this suite compiles
    // to, and `validation.ts` reads `runDiff` off them at each call.
    const writable = diffModule as { runDiff: typeof realRunDiff };
    writable.runDiff = async (id: string) => {
      reads += 1;
      await held;
      return realRunDiff(id);
    };
    let afterBoot: Task;
    try {
      fs.writeFileSync(control("answer"), "");
      await until("the second claim's diff read to begin", () => reads === 1);
      bootAsInstrumentationDoes();
      afterBoot = tasks.getTask(second.id)!;
    } finally {
      writable.runDiff = realRunDiff;
      releaseDiff();
    }
    await settled(runId);

    assert.equal(afterBoot.status, "done", "a claim whose diff was being read stayed claimed");
    assert.equal(afterBoot.completedByRunId, runId);
    assert.ok(
      logLines(runId).some((line) => /restarted before this task could be checked/.test(line)),
      logLines(runId).join("\n"),
    );
  });
});
