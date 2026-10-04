import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Task } from "./tasks";

/**
 * What a finished completion check does to the board, against a real database.
 *
 * `validation.test.ts` pins the pure decisions; this pins the writes they feed,
 * because both ways the validator has gone wrong here leave a task claimed by a
 * run that has finished with it, and nothing anywhere says so. A second task's
 * check hid the first one's `not-finished` at the boundary, so the run ended
 * `completed` without the pushback or the grant it was owed; and a check that
 * never reached its settle — a restart mid-check, or a spawn that threw before
 * a child existed — closed nothing, where every other way of having no verdict
 * closes the task on the run's own word.
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
let root: string;

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-validation-settle-")));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, "workspace");
  process.env.WORKSPACE_ROOTS = "";
  // Nothing here should start a child; a `claude` that does not exist makes a
  // regression that gets that far a failed test rather than a billed one. The
  // one case that reaches `spawn` is built to throw before a child exists.
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );

  database = await import("./db");
  settings = await import("./settings");
  tasks = await import("./tasks");
  validation = await import("./validation");
  review = await import("./review");
  orchestrator = await import("./orchestrator");
  settings.saveSettings({ validateTaskCompletion: true, maxValidationCycles: 2 });
});

after(() => {
  const open = (globalThis as { __ufDb?: { close(): void } }).__ufDb;
  open?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  const db = database.db();
  for (const table of ["run_events", "run_reviews", "tasks", "runs"]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${(seq += 1)}`;

function runRow(): string {
  const runId = nextId("run");
  database
    .db()
    .prepare(
      "INSERT INTO runs (id, folder, prompt, status, budget, created_at) VALUES (?,?,?,?,?,?)",
    )
    .run(runId, path.join(root, "workspace"), "work", "running", "{}", Date.now());
  return runId;
}

/** Filed through the real door and claimed by the run, as a started run's are. */
function heldTask(runId: string, title: string): Task {
  const parsed = tasks.normalizeTaskInput(
    { title, body: "the brief" },
    { origin: "operator", createdByRunId: null },
  );
  if (!parsed.ok) throw new Error(`fixture refused at the door: ${parsed.error}`);
  const created = tasks.createTask(parsed.value);
  if (!created.ok) throw new Error(`fixture refused by the store: ${created.error}`);
  const claimed = tasks.updateTask(
    created.task.id,
    { status: "claimed" },
    { kind: "run", runId },
  );
  if (!claimed.ok) throw new Error(`fixture claim refused: ${claimed.error}`);
  return claimed.task;
}

function validateRow(o: {
  runId: string;
  taskId: string;
  createdAt: number;
  finishedAt: number | null;
  status: "running" | "completed" | "failed";
  verdict: "finished" | "not-finished" | null;
  reason?: string;
}): string {
  const id = nextId("review");
  const text =
    o.verdict === null
      ? null
      : ["```json", JSON.stringify({ verdict: o.verdict, reason: o.reason ?? "" }), "```"].join(
          "\n",
        );
  database
    .db()
    .prepare(
      `INSERT INTO run_reviews (id, run_id, kind, created_at, finished_at, status, text,
                                verdict, task_id)
       VALUES (?, ?, 'validate', ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, o.runId, o.createdAt, o.finishedAt, o.status, text, o.verdict, o.taskId);
  return id;
}

function logLines(runId: string): string[] {
  return (
    database
      .db()
      .prepare("SELECT payload FROM run_events WHERE run_id = ? AND kind = 'log' ORDER BY id")
      .all(runId) as { payload: string }[]
  ).map((row) => (JSON.parse(row.payload) as { message: string }).message);
}

/* ------------------------------------------------------------------ */

describe("validationAtBoundary with more than one task", () => {
  it("pushes back on a task judged unfinished after another task was checked", async () => {
    const runId = runRow();
    const a = heldTask(runId, "Add the migration");
    const b = heldTask(runId, "Write the changelog");
    const since = Date.now() - 60_000;
    validateRow({
      runId,
      taskId: a.id,
      createdAt: since + 1_000,
      finishedAt: since + 2_000,
      status: "completed",
      verdict: "not-finished",
      reason: "no file under src/lib/migrations/",
    });
    // B's check came back later in the same cycle and its settle closed B.
    validateRow({
      runId,
      taskId: b.id,
      createdAt: since + 3_000,
      finishedAt: since + 4_000,
      status: "completed",
      verdict: "finished",
    });
    assert.ok(tasks.updateTask(b.id, { status: "done" }, { kind: "run", runId }).ok);

    const held = await validation.validationAtBoundary(runId, since, () => false);
    assert.ok(held, "A's verdict was dropped because B's row is newer");
    assert.match(held.pushback, /Add the migration/);
    assert.match(held.pushback, /no file under src\/lib\/migrations\//);
    assert.doesNotMatch(held.pushback, /Write the changelog/);
  });

  it("names every unfinished task in one pushback, and each in the spent line", async () => {
    const runId = runRow();
    const since = Date.now() - 60_000;
    let at = since;
    for (const title of ["First task", "Second task"]) {
      const task = heldTask(runId, title);
      validateRow({
        runId,
        taskId: task.id,
        createdAt: (at += 1_000),
        finishedAt: (at += 1_000),
        status: "completed",
        verdict: "not-finished",
        reason: `${title} is missing its test`,
      });
    }

    const held = await validation.validationAtBoundary(runId, since, () => false);
    assert.ok(held);
    assert.match(held.pushback, /First task[\s\S]*Second task/);
    assert.match(held.reason, /First task is missing its test.*Second task is missing its test/);

    // The grant is the boundary's, so the limit is reached by boundaries and
    // not by how many tasks each one named.
    database.db().prepare("UPDATE runs SET validation_cycles = 2 WHERE id = ?").run(runId);
    assert.equal(await validation.validationAtBoundary(runId, since, () => false), null);
    const spent = logLines(runId).filter((line) => line.includes("extra work cycles"));
    assert.equal(spent.length, 1, logLines(runId).join("\n"));
    assert.match(spent[0]!, /“First task” and “Second task” were checked/);
  });
});

describe("a check that never reached its settle", () => {
  it("closes the task as the run when a restart cut the check off", () => {
    const runId = runRow();
    const task = heldTask(runId, "Ship the retry ladder");
    validateRow({
      runId,
      taskId: task.id,
      createdAt: Date.now() - 5_000,
      finishedAt: null,
      status: "running",
      verdict: null,
    });

    validation.closeStrandedValidations(review.reconcileReviewsOnBoot());

    const after = tasks.getTask(task.id);
    assert.equal(after?.status, "done", "the settle died with the old process");
    assert.equal(after?.completedByRunId, runId);
    const row = database
      .db()
      .prepare("SELECT status, verdict FROM run_reviews WHERE task_id = ?")
      .get(task.id) as { status: string; verdict: string | null };
    // Null stays null: closed unchecked, never checked and passed.
    assert.deepEqual({ ...row }, { status: "failed", verdict: null });
  });

  it("leaves a task the operator moved while it was being checked", () => {
    const runId = runRow();
    const task = heldTask(runId, "Released mid-check");
    validateRow({
      runId,
      taskId: task.id,
      createdAt: Date.now() - 5_000,
      finishedAt: null,
      status: "running",
      verdict: null,
    });
    assert.ok(tasks.updateTask(task.id, { status: "open" }, { kind: "operator" }).ok);

    validation.closeStrandedValidations(review.reconcileReviewsOnBoot());

    assert.equal(tasks.getTask(task.id)?.status, "open");
  });

  it("settles through after when the child cannot even be spawned", async () => {
    // `startAssist`'s `.catch` wrote the row and skipped `after`, which for a
    // validation is the only thing that closes the task. A prompt carrying a
    // NUL byte is one way `spawn` throws before a child exists.
    const runId = runRow();
    const run = orchestrator.getRun(runId)!;
    const settled: import("./review").AssistResult[] = [];
    const started = review.startAssist({
      run,
      kind: "validate",
      cwd: root,
      permissionMode: "plan",
      prompt: "a prompt with a \0 in it",
      after: async (result) => {
        settled.push(result);
      },
    });
    assert.ok(started.ok);

    const deadline = Date.now() + 5_000;
    while (review.getAssist(started.id)?.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(review.getAssist(started.id)?.status, "failed");
    assert.deepEqual(
      settled.map((result) => result.status),
      ["failed"],
    );
  });
});
