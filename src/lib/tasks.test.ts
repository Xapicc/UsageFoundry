import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
// Type-only, so it is erased rather than hoisted above the environment setup
// below — `orchestrator.test.ts`'s reason, and the same reason the values come
// through `require`.
import type { Task, TaskActor, TaskStatus } from "./tasks";

/**
 * The taskboard's authority model, its door, and the three writes no pure
 * function reaches.
 *
 * A wrong edge in `taskTransitionRefusal` does not throw, does not fail a
 * typecheck and leaves a board that looks exactly right — it just closes work
 * nobody did, or refuses a move the operator is entitled to make and leaves
 * them with no way to say the work is finished. The two directions are not
 * symmetrical and both are here: an edge admitted that should not be is a task
 * marked done by something that did not do it, and an edge refused that should
 * not be is a backlog nobody can clear.
 *
 * The matrix below is the whole rule rather than a sample of it, deliberately.
 * It is one function over four statuses and four actor kinds, so 64 assertions
 * is the entire behaviour, and an edit that *adds* an edge fails here rather
 * than shipping. The cases after it are the ones a matrix cannot state, because
 * they are about identity rather than about the pair.
 *
 * The last section reaches the database, on the grounds the parked sweeper's
 * own writes earned: the status *effects* are not in the pure function and no
 * pure function can reach them, and each is silent in the same way — an
 * operator's completion that recorded a run id would put one on work no run
 * did, and a re-open that left `completed_by_run_id` standing is a row
 * contradicting its own status on every surface that draws it.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-tasks-")));
const ws = path.join(tmp, "ws");
fs.mkdirSync(path.join(ws, "RepoOne", "sub"), { recursive: true });
fs.mkdirSync(path.join(tmp, "outside"), { recursive: true });

// A symlink inside the mount pointing out of it: the case the *second*
// containment check exists for, and the one a lexical check alone would admit.
fs.symlinkSync(path.join(tmp, "outside"), path.join(ws, "escape"));

process.env.WORKSPACE_ROOTS = `Main=${ws}`;
process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
// Pinned rather than left to fall back to CLAUDE_HOME, `orchestrator.test.ts`'
// reason: an ambient CLAUDE_CONFIG_DIR holding an OAuth token would make a unit
// test talk to Anthropic on the operator's own credential.
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");
// Nothing here spawns, and this is the second lock on that door: a regression
// that got as far as a spawn is a failed test rather than a billed one.
process.env.CLAUDE_BIN = path.join(tmp, "no-such-claude");
process.env.CODEX_BIN = path.join(tmp, "no-such-codex");
process.env.CODEX_HOME = path.join(tmp, "codex");

// `require`, not `import`: imports are hoisted above the environment setup
// above, and `orchestrator.ts` — which `tasks.ts` takes its folder resolution
// from — reads WORKSPACE_ROOTS once at load.
const {
  TASK_PRIORITIES,
  TASK_STATUSES,
  clampTaskOffset,
  createTask,
  deleteTask,
  getTask,
  listTasks,
  normalizeTaskInput,
  normalizeTaskListQuery,
  normalizeTaskPatch,
  operatorOnlyRefusal,
  readTaskLinks,
  recordRunTasks,
  runLinksForTasks,
  taskDTO,
  taskRefusal,
  tasksLinkedToRun,
  tasksMentionedIn,
  taskDeletionRefusal,
  MAX_RUN_TASKS,
  taskListItemDTO,
  tasksForRun,
  taskTransitionRefusal,
  updateTask,
} = require("./tasks") as typeof import("./tasks");
const { MAX_TASK_RUN_LINKS } = require("./apiTypes") as typeof import("./apiTypes");
const { db } = require("./db") as typeof import("./db");
const { releaseTask, MAX_RELEASE_REASON } =
  require("./taskRelease") as typeof import("./taskRelease");
const { listTaskComments } = require("./taskComments") as typeof import("./taskComments");
const { claimTasksForRun } = require("./orchestrator") as typeof import("./orchestrator");

/**
 * A `runs` row with nothing on it but the columns the insert refuses to be
 * without.
 *
 * Written straight rather than through `createRun`, and that is the point being
 * kept rather than a shortcut: this file is about the board, and a board test
 * that reached the orchestrator would be claiming a folder, taking a
 * concurrency slot and spawning a child to answer a question about one column.
 * The link is a record — nothing on the run reads it — so a row is all it needs.
 */
function seedRun(id: string, createdAt = Date.now()): string {
  db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, created_at, budget)
       VALUES (?, ?, 'seeded', 'queued', ?, '{}')`,
    )
    .run(id, path.join(tmp, "repo"), createdAt);
  return id;
}

/** The id is `slug(label)` and never the label — `parseMounts` in `config.ts`. */
const MOUNT = "main";

/* ------------------------------------------------------------------ */
/* The rule                                                            */
/* ------------------------------------------------------------------ */

const HOLDER = "11111111-2222-3333-4444-555555555555";
const STRANGER = "99999999-8888-7777-6666-555555555555";

const ACTORS: Record<string, TaskActor> = {
  operator: { kind: "operator" },
  chat: { kind: "chat" },
  block: { kind: "block" },
  run: { kind: "run", runId: HOLDER },
};

/**
 * Which actor kinds may make each move, with the run acting as the holder.
 *
 * Every pair not named here is refused for every actor. `from === to` is not a
 * move and is allowed for all four, which is what lets an update restate a
 * status it is not changing.
 */
const ALLOWED: Record<string, readonly string[]> = {
  "open->claimed": ["operator", "chat", "block", "run"],
  "open->done": ["operator"],
  "open->dropped": ["operator"],
  "claimed->open": ["operator", "run"],
  "claimed->done": ["operator", "run"],
  "claimed->dropped": ["operator"],
  "done->open": ["operator"],
  "dropped->open": ["operator"],
};

test("the whole transition matrix: every edge, every actor kind", () => {
  for (const from of TASK_STATUSES) {
    for (const to of TASK_STATUSES) {
      for (const [name, actor] of Object.entries(ACTORS)) {
        const refusal = taskTransitionRefusal({
          from,
          to,
          actor,
          claimedByRunId: HOLDER,
          claimRunId: HOLDER,
        });

        const expected =
          from === to || (ALLOWED[`${from}->${to}`] ?? []).includes(name);
        const where = `${name}: ${from} -> ${to}`;

        if (expected) {
          assert.equal(refusal, null, `${where} should be allowed, got: ${refusal}`);
        } else {
          assert.notEqual(refusal, null, `${where} should be refused`);
          // A refusal nobody can act on is the same as no refusal at all, so
          // every one of them has to be a sentence rather than a code.
          assert.ok(
            typeof refusal === "string" && refusal.length > 20,
            `${where} refusal is not a sentence: ${refusal}`,
          );
        }
      }
    }
  }
});

test("a run completes only the task claimed in its own name", () => {
  // The case the whole rule exists for: a work cycle that read the board and
  // picked the wrong id out of the list. Nothing throws, and the board would
  // otherwise say work happened that nobody did.
  const refusal = taskTransitionRefusal({
    from: "claimed",
    to: "done",
    actor: { kind: "run", runId: STRANGER },
    claimedByRunId: HOLDER,
  });
  assert.ok(refusal, "a run must not complete another run's task");
  assert.match(refusal!, new RegExp(STRANGER.slice(0, 8)));
  assert.match(refusal!, new RegExp(HOLDER.slice(0, 8)));

  assert.equal(
    taskTransitionRefusal({
      from: "claimed",
      to: "done",
      actor: { kind: "run", runId: HOLDER },
      claimedByRunId: HOLDER,
    }),
    null,
  );
});

test("a claimed row holding no run id completes for nobody", () => {
  // Reachable from a row written before this column meant anything, and the
  // wrong answer is the expensive one: two nulls comparing equal would let any
  // run close any orphaned claim.
  assert.ok(
    taskTransitionRefusal({
      from: "claimed",
      to: "done",
      actor: { kind: "run", runId: HOLDER },
      claimedByRunId: null,
    }),
  );
});

test("a run must claim before it can complete", () => {
  const refusal = taskTransitionRefusal({
    from: "open",
    to: "done",
    actor: { kind: "run", runId: HOLDER },
    claimedByRunId: null,
  });
  assert.ok(refusal, "an open task has no holder, so no run may complete it");
  assert.match(refusal!, /[Cc]laim/);
});

test("a claim names the run that holds it", () => {
  for (const claimRunId of [undefined, null, "", "   "]) {
    assert.ok(
      taskTransitionRefusal({
        from: "open",
        to: "claimed",
        actor: { kind: "operator" },
        claimedByRunId: null,
        claimRunId,
      }),
      `a claim of ${JSON.stringify(claimRunId)} should be refused`,
    );
  }

  // The operator and a chat turn may claim on a run's behalf — a proposal that
  // is about to start a run names the run it will start.
  assert.equal(
    taskTransitionRefusal({
      from: "open",
      to: "claimed",
      actor: { kind: "chat" },
      claimedByRunId: null,
      claimRunId: HOLDER,
    }),
    null,
  );

  // A run may not claim for somebody else.
  assert.ok(
    taskTransitionRefusal({
      from: "open",
      to: "claimed",
      actor: { kind: "run", runId: STRANGER },
      claimedByRunId: null,
      claimRunId: HOLDER,
    }),
  );
});

test("only the holder or the operator releases a claim", () => {
  assert.equal(
    taskTransitionRefusal({
      from: "claimed",
      to: "open",
      actor: { kind: "run", runId: HOLDER },
      claimedByRunId: HOLDER,
    }),
    null,
  );
  assert.ok(
    taskTransitionRefusal({
      from: "claimed",
      to: "open",
      actor: { kind: "run", runId: STRANGER },
      claimedByRunId: HOLDER,
    }),
  );
  for (const kind of ["chat", "block"] as const) {
    assert.ok(
      taskTransitionRefusal({
        from: "claimed",
        to: "open",
        actor: { kind },
        claimedByRunId: HOLDER,
      }),
      `${kind} must not release another run's claim`,
    );
  }
});

test("a model-driven actor never moves a task to done", () => {
  for (const kind of ["chat", "block"] as const) {
    for (const from of ["open", "claimed"] as const) {
      const refusal = taskTransitionRefusal({
        from,
        to: "done",
        actor: { kind },
        claimedByRunId: HOLDER,
      });
      assert.ok(refusal, `${kind} must not complete a ${from} task`);
      assert.match(refusal!, /[Cc]ompletion belongs to/);
    }
  }
});

test("a terminal task is re-opened before it is anything else", () => {
  const closed: TaskStatus[] = ["done", "dropped"];
  for (const from of closed) {
    for (const to of ["claimed", ...closed] as TaskStatus[]) {
      if (to === from) continue;
      assert.ok(
        taskTransitionRefusal({
          from,
          to,
          actor: { kind: "operator" },
          claimedByRunId: null,
          claimRunId: HOLDER,
        }),
        `${from} -> ${to} must go through open, even for the operator`,
      );
    }
  }
});

test("only the operator deletes", () => {
  assert.equal(taskDeletionRefusal({ kind: "operator" }), null);
  for (const actor of [
    { kind: "chat" } as const,
    { kind: "block" } as const,
    { kind: "run", runId: HOLDER } as const,
  ]) {
    const refusal = taskDeletionRefusal(actor);
    assert.ok(refusal, `${actor.kind} must not delete a task`);
    // A refusal has to point at what may be done instead, or the next attempt
    // is the same one.
    assert.match(refusal!, /drop/);
  }
});

/* ------------------------------------------------------------------ */
/* The door                                                            */
/* ------------------------------------------------------------------ */

const CREATION = { origin: "operator", createdByRunId: null } as const;

test("a task needs a title and a brief", () => {
  for (const body of [
    {},
    { title: "   ", body: "b" },
    { title: "t" },
    { title: "t", body: " " },
  ]) {
    const parsed = normalizeTaskInput(body, CREATION);
    assert.equal(parsed.ok, false, `${JSON.stringify(body)} should be refused`);
  }

  const ok = normalizeTaskInput({ title: " Ship it ", body: " the brief " }, CREATION);
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.value.title, "Ship it");
  assert.equal(ok.ok && ok.value.body, "the brief");
  // Absent is `normal`: a missing priority must not become a ranking this app
  // invented on the operator's behalf.
  assert.equal(ok.ok && ok.value.priority, "normal");
  assert.equal(ok.ok && ok.value.origin, "operator");
});

test("origin, createdByRunId and status are refused by name at a create", () => {
  // Silently dropping any of these leaves the caller believing it took effect —
  // and an origin off the wire is a chat turn filing work as the operator.
  for (const [field, value] of [
    ["origin", "operator"],
    ["createdByRunId", HOLDER],
    ["status", "done"],
  ] as const) {
    const parsed = normalizeTaskInput({ title: "t", body: "b", [field]: value }, CREATION);
    assert.equal(parsed.ok, false, `${field} should be refused`);
    assert.match(
      !parsed.ok ? parsed.error : "",
      new RegExp(field === "status" ? "open" : field),
    );
  }
});

test("an unknown priority says what was expected and what was seen", () => {
  const parsed = normalizeTaskInput({ title: "t", body: "b", priority: "P1" }, CREATION);
  assert.equal(parsed.ok, false);
  assert.match(!parsed.ok ? parsed.error : "", /P1/);
  for (const priority of TASK_PRIORITIES) {
    assert.match(!parsed.ok ? parsed.error : "", new RegExp(priority));
  }
});

/* ------------------------------------------------------------------ */
/* Folder validation — both containment checks, through the real one   */
/* ------------------------------------------------------------------ */

test("a mount and a folder arrive together or not at all", () => {
  // Half a pair is a folder this app cannot say which root proved it, or a
  // project claim with nothing under it. Both would store and neither would
  // answer the query the pair exists for.
  const noFolder = normalizeTaskInput({ title: "t", body: "b", mountId: MOUNT }, CREATION);
  assert.equal(noFolder.ok, false);
  assert.match(!noFolder.ok ? noFolder.error : "", new RegExp(MOUNT));

  const noMount = normalizeTaskInput({ title: "t", body: "b", folder: "RepoOne" }, CREATION);
  assert.equal(noMount.ok, false);
  assert.match(!noMount.ok ? noMount.error : "", /RepoOne/);

  const neither = normalizeTaskInput({ title: "t", body: "b" }, CREATION);
  assert.equal(neither.ok, true);
  assert.equal(neither.ok && neither.value.mountId, null);
  assert.equal(neither.ok && neither.value.folder, null);

  // Explicit nulls are the same "neither", and this is the shape a caller that
  // *computes* the pair sends: `create_task` on a work cycle fills it from the
  // run's own row and drops both when the run's folder is under no mount the
  // app currently has. If an explicit null read as a claim, that run would have
  // every task it filed refused for half a pair it never named — over a field
  // its schema does not have, so with nothing it could do about it.
  const nulls = normalizeTaskInput(
    { title: "t", body: "b", mountId: null, folder: null },
    CREATION,
  );
  assert.equal(nulls.ok, true);
  assert.equal(nulls.ok && nulls.value.mountId, null);
  assert.equal(nulls.ok && nulls.value.folder, null);
});

test("a folder inside the mount is stored as the canonical absolute path", () => {
  // The same shape `runs.folder` holds, which is what makes "tasks for the
  // folder I am working in" an equality between two paths proved the same way.
  const parsed = normalizeTaskInput(
    { title: "t", body: "b", mountId: MOUNT, folder: path.join(ws, "RepoOne", "sub") },
    CREATION,
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ok && parsed.value.folder, path.join(ws, "RepoOne", "sub"));
  assert.equal(parsed.ok && parsed.value.mountId, MOUNT);
});

test("a folder outside its mount is refused, by both containment checks", () => {
  const cases: Array<[string, string, RegExp]> = [
    // Lexical, before any syscall: the refusal says "outside the mount" rather
    // than whatever ENOENT the bogus path happens to produce.
    [MOUNT, path.join(tmp, "outside"), /outside/i],
    [MOUNT, "../outside", /outside/i],
    // After realpath: a symlink *inside* the mount pointing out of it, which
    // the lexical check alone admits.
    [MOUNT, path.join(ws, "escape"), /outside/i],
    // No such folder at all.
    [MOUNT, "NoSuchRepo", /No such folder/i],
    // A mount id nothing is configured under.
    ["not-a-mount", path.join(ws, "RepoOne"), /No such workspace mount/i],
  ];

  for (const [mountId, folder, expected] of cases) {
    const parsed = normalizeTaskInput({ title: "t", body: "b", mountId, folder }, CREATION);
    assert.equal(parsed.ok, false, `${mountId}:${folder} should be refused`);
    // What was expected and what was seen: the refusal names the path or the
    // mount the caller asked for, or it is not one they can act on.
    assert.match(!parsed.ok ? parsed.error : "", expected);
  }
});

test("a patch narrows its closed sets and leaves absent keys alone", () => {
  const empty = normalizeTaskPatch({});
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.ok && empty.value, {});

  // An unknown status is refused rather than dropped: dropping it answers
  // "mark this done" with a 200 and a board that did not move.
  const bad = normalizeTaskPatch({ status: "finished" });
  assert.equal(bad.ok, false);
  assert.match(!bad.ok ? bad.error : "", /finished/);

  const good = normalizeTaskPatch({ status: "done", priority: "urgent", parentTaskId: null });
  assert.equal(good.ok, true);
  assert.equal(good.ok && good.value.status, "done");
  assert.equal(good.ok && good.value.priority, "urgent");
  // `null` is a real value here — unlinking a parent — and must survive as one.
  assert.equal(good.ok && good.value.parentTaskId, null);
  assert.equal(good.ok && "title" in good.value, false);

  assert.equal(normalizeTaskPatch({ origin: "chat" }).ok, false);
});

/* ------------------------------------------------------------------ */
/* The board's own query                                               */
/* ------------------------------------------------------------------ */

test("a board request read off a query string", () => {
  // Every value arrives as a string that may be blank, a word or negative, and
  // each wrong answer is a board that looks like an answer. A one-row page is
  // a far worse reply to a typo'd limit than the ordinary page.
  for (const limit of [undefined, 0, -5, Number.NaN, "abc" as unknown as number]) {
    assert.equal(normalizeTaskListQuery({ limit }).limit, 100, `limit ${limit}`);
  }
  assert.equal(normalizeTaskListQuery({ limit: 5000 }).limit, 300);
  assert.equal(normalizeTaskListQuery({ limit: 25 }).limit, 25);

  assert.equal(normalizeTaskListQuery({ offset: -3 }).offset, 0);
  assert.equal(normalizeTaskListQuery({ offset: 12 }).offset, 12);

  // A blank parameter is no filter, not a filter for the empty string — which
  // would answer every board request with nothing.
  const blank = normalizeTaskListQuery({ mountId: "  ", folder: "" });
  assert.equal(blank.mountId, null);
  assert.equal(blank.folder, null);
  assert.equal(blank.status, null);
  assert.equal(blank.origin, null);
  assert.equal(blank.priority, null);

  // Narrowed at the route, as `status` and `origin` are: an unknown word is a
  // 400 there rather than a filter dropped here, because a parameter deciding
  // which rows exist must not widen in silence.
  assert.equal(normalizeTaskListQuery({ priority: "urgent" }).priority, "urgent");

  // Off unless it is exactly `true`: a stored condition written before the
  // field existed carries `undefined`, and the exact folder match is what it
  // meant — a widened count is a backlog nobody was shown.
  for (const raw of [undefined, null, 0, "", "true"]) {
    assert.equal(
      normalizeTaskListQuery({
        includeSubfolders: raw as unknown as boolean,
      }).includeSubfolders,
      false,
      String(raw),
    );
  }
  assert.equal(
    normalizeTaskListQuery({ includeSubfolders: true }).includeSubfolders,
    true,
  );
});

test("an offset past the end lands on the last row rather than on nothing", () => {
  assert.equal(clampTaskOffset(0, 0), 0);
  assert.equal(clampTaskOffset(-3, 100), 0);
  assert.equal(clampTaskOffset(5, 100), 5);
  assert.equal(clampTaskOffset(500, 10), 9);
  assert.equal(clampTaskOffset(500, 0), 0);
});

/* ------------------------------------------------------------------ */
/* The writes no pure function reaches                                 */
/* ------------------------------------------------------------------ */

/** Through the real door, so a fixture cannot store what a request could not. */
function file(over: Record<string, unknown> = {}): Task {
  const parsed = normalizeTaskInput({ title: "T", body: "the brief", ...over }, CREATION);
  if (!parsed.ok) throw new Error(`fixture refused at the door: ${parsed.error}`);
  const created = createTask(parsed.value);
  if (!created.ok) throw new Error(`fixture refused by the store: ${created.error}`);
  return created.task;
}

test("a completion records the run that did it, and the operator's records none", () => {
  const byRun = file();
  assert.equal(
    updateTask(byRun.id, { status: "claimed" }, { kind: "run", runId: HOLDER }).ok,
    true,
  );
  const done = updateTask(byRun.id, { status: "done" }, { kind: "run", runId: HOLDER });
  assert.equal(done.ok, true);
  assert.equal(done.ok && done.task.completedByRunId, HOLDER);
  assert.equal(done.ok && done.task.claimedByRunId, HOLDER);
  assert.ok(done.ok && done.task.closedAt !== null, "a closed task carries closed_at");

  // A person is not a run, and inventing one would put a run id on work no run
  // did — which is the column's only claim.
  const byOperator = file();
  const opDone = updateTask(byOperator.id, { status: "done" }, { kind: "operator" });
  assert.equal(opDone.ok, true);
  assert.equal(opDone.ok && opDone.task.completedByRunId, null);

  // Dropped is closed and completed by nobody.
  const dropped = updateTask(file().id, { status: "dropped" }, { kind: "operator" });
  assert.equal(dropped.ok && dropped.task.completedByRunId, null);
  assert.ok(dropped.ok && dropped.task.closedAt !== null);
});

test("a re-open clears both run columns and closed_at", () => {
  const task = file();
  updateTask(task.id, { status: "claimed" }, { kind: "run", runId: HOLDER });
  updateTask(task.id, { status: "done" }, { kind: "run", runId: HOLDER });

  const reopened = updateTask(task.id, { status: "open" }, { kind: "operator" });
  assert.equal(reopened.ok, true);
  // A task that is open while naming the run that completed it is a row
  // contradicting its own status on every surface that draws the board.
  assert.equal(reopened.ok && reopened.task.claimedByRunId, null);
  assert.equal(reopened.ok && reopened.task.completedByRunId, null);
  assert.equal(reopened.ok && reopened.task.closedAt, null);
});

test("a refused move writes nothing", () => {
  const task = file();
  updateTask(task.id, { status: "claimed" }, { kind: "run", runId: HOLDER });
  const before = getTask(task.id)!;

  const refused = updateTask(
    task.id,
    { status: "done", title: "renamed" },
    { kind: "run", runId: STRANGER },
  );
  assert.equal(refused.ok, false);

  // The whole update is refused, not just its status half: a title that landed
  // while the move was refused is a partial write nothing would report.
  const after = getTask(task.id)!;
  assert.deepEqual(after, before);
});

test("a missing task is told apart from a refused one", () => {
  const missing = updateTask("no-such-id", { title: "x" }, { kind: "operator" });
  assert.equal(missing.ok, false);
  assert.equal(!missing.ok && missing.kind, "missing");

  assert.equal(deleteTask("no-such-id", { kind: "operator" }).ok, false);
  const refused = deleteTask(file().id, { kind: "run", runId: HOLDER });
  assert.equal(!refused.ok && refused.kind, "refused");
});

test("deleting a parent keeps its children and clears only the link", () => {
  const parent = file();
  const child = file({ parentTaskId: parent.id });
  assert.equal(getTask(child.id)!.parentTaskId, parent.id);

  assert.equal(deleteTask(parent.id, { kind: "operator" }).ok, true);
  // ON DELETE SET NULL: losing the link is the right loss, losing the task is
  // not — a task filed by a run while it worked another is still work.
  assert.equal(getTask(parent.id), null);
  assert.equal(getTask(child.id)!.parentTaskId, null);

  // A parent that is not there is refused rather than stored as a dangling id.
  const orphan = normalizeTaskInput({ title: "t", body: "b", parentTaskId: parent.id }, CREATION);
  assert.equal(orphan.ok, true, "the door does not check existence; the store does");
  const created = orphan.ok
    ? createTask(orphan.value)
    : assert.fail("unreachable");
  assert.equal(created.ok, false);
  assert.equal(!created.ok && created.kind, "refused");
});

test("the board orders by priority before recency, whatever the write order", () => {
  // The order the CASE exists for: an index on the stored word would supply a
  // lexical run — high, low, normal, urgent — that the planner would happily
  // use to produce a board sorted wrong.
  const folder = path.join(ws, "RepoOne");
  for (const priority of ["low", "urgent", "normal", "high"]) {
    file({ priority, mountId: MOUNT, folder });
  }

  const page = listTasks({ mountId: MOUNT, folder });
  assert.deepEqual(
    page.tasks.map((t) => t.priority),
    ["urgent", "high", "normal", "low"],
  );
  assert.equal(page.total, 4);

  // The folder filter is an equality on the stored canonical path.
  assert.equal(listTasks({ mountId: MOUNT, folder: path.join(ws, "sub") }).total, 0);
});

test("the listing clips the brief and the detail DTO does not", () => {
  const long = file({ body: "x".repeat(500) });
  const whole = taskDTO(getTask(long.id)!);
  const row = taskListItemDTO(getTask(long.id)!);

  assert.equal(whole.body.length, 500);
  // The marked length rather than one character over it, so a clipped brief
  // cannot be read as a whole one.
  assert.equal(row.body.length, 200);
  assert.ok(row.body.endsWith("…"));
});

/* ------------------------------------------------------------------ */
/* Naming a task from somewhere else                                   */
/* ------------------------------------------------------------------ */

test("an id that is not on the board is refused, and a closed task is not", () => {
  // The failure this closes is the quiet one and it is why the function
  // exists: three doors name a task from outside `tasks.ts`, and an id they
  // dropped instead of refusing produces a proposal that said "for the
  // flaky-auth task" and is bit-for-bit one that named none.
  const board = new Map([
    ["t-open", { title: "Open one", status: "open" as const, operatorOnly: false }],
    ["t-done", { title: "Closed one", status: "done" as const, operatorOnly: false }],
    ["t-dropped", { title: "Dropped one", status: "dropped" as const, operatorOnly: false }],
  ]);

  assert.equal(taskRefusal("t-open", board), null);
  // Closed is *not* refused, and the asymmetry with `agentRefusal` is the
  // decision under test: an agent that has gone changes what the run is, where
  // a closed task changes nothing about it — refusing here would be this
  // function deciding on the operator's behalf that work off closed work may
  // not happen.
  assert.equal(taskRefusal("t-done", board), null);
  assert.equal(taskRefusal("t-dropped", board), null);

  const missing = taskRefusal("t-gone", board);
  assert.ok(missing, "an unknown id is refused rather than dropped");
  // By name, so a model that mistyped an id can see which one — the property
  // `agentRefusal` is written for and the one a generic "not found" loses.
  assert.match(missing!, /t-gone/);
  assert.match(missing!, /list_tasks/);

  // An empty board refuses everything rather than admitting everything, which
  // is the direction a `.size === 0` shortcut would have got wrong.
  assert.ok(taskRefusal("t-open", new Map()));
});

test("the runs started for a task are counted whole and listed capped", () => {
  const task = file();
  const other = file({ title: "Untouched" });

  // Eight, against a cap of five: the count is the figure a row reports and
  // the list is what fits beside it. A row that showed five and said nothing
  // would report a task worked eight times as one worked five.
  // Distinct `created_at` values, because "newest first" is what the query
  // orders on and the id beside it is a tiebreak for determinism rather than a
  // second ordering. Eight rows written in one millisecond would be testing the
  // tiebreak and calling it the order.
  const ids: string[] = [];
  for (let n = 0; n < 8; n += 1) {
    const run = seedRun(`run-for-task-${n}`, Date.now() + n);
    recordRunTasks(run, [task.id]);
    ids.push(run);
  }

  const links = runLinksForTasks([task.id, other.id]);
  assert.equal(links.get(task.id)?.runCount, 8);
  assert.equal(links.get(task.id)?.runIds.length, MAX_TASK_RUN_LINKS);
  // Absent rather than a zeroed entry, so "no runs" and "not asked about" are
  // one answer — there is nothing to tell apart, since the link is written at
  // the creation and never later.
  assert.equal(links.get(other.id), undefined);
  // Newest first, so the five a row draws are the five that matter.
  assert.deepEqual(links.get(task.id)?.runIds, ids.slice(-5).reverse());

  // The link is a record and moves nothing: eight runs later the task is still
  // open, unclaimed and unclosed. A status derived from a run here is the rule
  // this whole feature is built to not have.
  const after = getTask(task.id)!;
  assert.equal(after.status, "open");
  assert.equal(after.claimedByRunId, null);
  assert.equal(after.completedByRunId, null);
});

test("a run whose task was deleted still names it", () => {
  const task = file();
  const run = seedRun("run-outliving-its-task");
  recordRunTasks(run, [task.id]);

  assert.equal(tasksLinkedToRun(run)[0]?.title, task.title);
  assert.equal(deleteTask(task.id, { kind: "operator" }).ok, true);

  // Three states rather than two, which is why the id is not a foreign key: a
  // run whose task has gone is not a run that never had one, and a surface
  // collapsing them loses the provenance the link exists to hold.
  const [orphan] = tasksLinkedToRun(run);
  assert.equal(orphan?.id, task.id);
  assert.equal(orphan?.title, null);
  assert.equal(orphan?.status, null);
  assert.deepEqual(tasksLinkedToRun(seedRun("run-off-no-task")), []);
});

test("a run is linked to every task it was started for, in the order named", () => {
  // The defect this replaced: one column, so a run started for three tasks
  // recorded one, claimed one and could close one, and the other two stayed
  // open after the work was done.
  const first = file({ title: "First of three" });
  const second = file({ title: "Second of three" });
  const third = file({ title: "Third of three" });
  const run = seedRun("run-for-three");
  recordRunTasks(run, [second.id, first.id, third.id]);

  assert.deepEqual(
    tasksLinkedToRun(run).map((t) => t.title),
    ["Second of three", "First of three", "Third of three"],
  );
  // And each task's own row sees the run, which is the board's read.
  const links = runLinksForTasks([first.id, second.id, third.id]);
  for (const task of [first, second, third]) {
    assert.deepEqual(links.get(task.id)?.runIds, [run], task.title);
  }
});

/* ------------------------------------------------------------------ */
/* A brief that names work its run is not linked to                    */
/* ------------------------------------------------------------------ */

const OPEN_ID = "a9648b09-41bf-42a4-86e8-892d3df9603e";
const CLAIMED_ID = "4b697254-4341-40eb-a78f-c27a3c386c65";
const DONE_ID = "dfa89779-71cd-41d5-bae3-7c417807a96d";
const SHORT_ID = "0f146cc6-1c9a-4a8e-9d0e-5b2f1f2c0e11";

const BRIEFED = new Map([
  [OPEN_ID, { title: "The merge tool opens with no conflicts in it", status: "open" as const, operatorOnly: false }],
  [CLAIMED_ID, { title: "Shell.run deadlocks forever on a loud child", status: "claimed" as const, operatorOnly: false }],
  [DONE_ID, { title: "git diff on a conflicted repo traps the app", status: "done" as const, operatorOnly: false }],
  [SHORT_ID, { title: "Fix the README", status: "open" as const, operatorOnly: false }],
]);

test("a task is named by its whole id, its eight-character prefix, or its whole title", () => {
  const named = (text: string) => tasksMentionedIn(text, BRIEFED).map((t) => t.id);

  assert.deepEqual(named(`Board tasks ${OPEN_ID} and more.`), [OPEN_ID]);
  assert.deepEqual(named(`See task a9648b09 first.`), [OPEN_ID]);
  // Quoted the way a chat quotes one, in curly quotes and a different case,
  // with a backtick the title does not have: all one spelling.
  assert.deepEqual(named("- “the merge tool opens with NO conflicts in it”"), [OPEN_ID]);
  assert.deepEqual(named("`Shell.run` deadlocks forever on a loud child"), [CLAIMED_ID]);

  // A prefix inside a longer hex run is a commit sha or another id, not this.
  assert.deepEqual(named("commit a9648b09c1 fixed it"), []);
  // A closed task named is context, and a short title is a phrase any brief
  // can contain.
  assert.deepEqual(named("Unlike git diff on a conflicted repo traps the app, ..."), []);
  assert.deepEqual(named("Then fix the README."), []);
});

test("a brief naming an open task its run does not link is refused, naming the task", () => {
  const brief = "Two board tasks:\n- “The merge tool opens with no conflicts in it”\n- Shell.run deadlocks forever on a loud child";

  const refused = readTaskLinks({ taskIds: [OPEN_ID] }, brief, BRIEFED);
  assert.equal(refused.ok, false);
  const reason = refused.ok ? "" : refused.reason;
  assert.match(reason, new RegExp(CLAIMED_ID), "the task left out is named by id");
  assert.doesNotMatch(reason, new RegExp(OPEN_ID), "the linked one is not");
  assert.match(reason, /relatedTaskIds/, "and the way to say it is context");

  // Named with no link at all is the same failure, and the commonest shape.
  assert.equal(readTaskLinks({}, brief, BRIEFED).ok, false);

  const linked = readTaskLinks({ taskIds: [OPEN_ID, CLAIMED_ID] }, brief, BRIEFED);
  assert.deepEqual(linked, { ok: true, taskIds: [OPEN_ID, CLAIMED_ID] });

  const context = readTaskLinks(
    { taskIds: [OPEN_ID], relatedTaskIds: [CLAIMED_ID] },
    brief,
    BRIEFED,
  );
  assert.deepEqual(context, { ok: true, taskIds: [OPEN_ID] }, "context is not linked");
});

test("the task link fields are refused by name when they cannot mean what was sent", () => {
  const reason = (fields: Record<string, unknown>) => {
    const read = readTaskLinks(fields, "no tasks named here", BRIEFED);
    return read.ok ? null : read.reason;
  };

  // The field this replaced: silently ignored, a caller believes it linked.
  assert.match(reason({ taskId: OPEN_ID }) ?? "", /taskIds/);
  assert.match(reason({ taskIds: OPEN_ID }) ?? "", /list/);
  assert.match(reason({ taskIds: ["t-gone"] }) ?? "", /t-gone/);
  assert.match(reason({ relatedTaskIds: ["t-gone"] }) ?? "", /t-gone/);
  assert.match(
    reason({ taskIds: [OPEN_ID], relatedTaskIds: [OPEN_ID] }) ?? "",
    /both/,
  );
  // One past what `list_my_tasks` shows of what a run holds.
  const tooMany = Array.from({ length: MAX_RUN_TASKS + 1 }, () => OPEN_ID).map(
    (id, n) => `${id.slice(0, -2)}${String(n).padStart(2, "0")}`,
  );
  const board = new Map(tooMany.map((id) => [id, { title: id, status: "open" as const, operatorOnly: false }]));
  const capped = readTaskLinks({ taskIds: tooMany }, "", board);
  assert.match(capped.ok ? "" : capped.reason, new RegExp(`at most ${MAX_RUN_TASKS}`));

  // Repeats are a restatement, not a second link, and order is kept.
  assert.deepEqual(
    readTaskLinks({ taskIds: [CLAIMED_ID, OPEN_ID, CLAIMED_ID] }, "", BRIEFED),
    { ok: true, taskIds: [CLAIMED_ID, OPEN_ID] },
  );
});

/* ------------------------------------------------------------------ */
/* What a work cycle may see of the board                              */
/* ------------------------------------------------------------------ */

/**
 * `tasksForRun` is where "not the whole board" is actually decided, and every
 * way it can go wrong is silent. It feeds an MCP tool result rather than a page:
 * nothing throws if it returns a stranger's task, nothing looks wrong if it
 * returns another project's backlog, and the only reader is a model that will
 * treat whatever arrives as the truth about what it holds.
 *
 * The three failures are separate assertions because they fail apart. Widening
 * `held` past `claimed_by_run_id` hands a run ids it cannot complete but will
 * try to; widening `openInFolder` past the folder turns a tool scoped to one
 * project into a read of the operator's whole backlog; and losing the count
 * turns a clipped list into a silent one, which is how the run files the
 * duplicate it read the list to avoid.
 */
test("a run sees the tasks it holds and the open ones where it is working", () => {
  const here = path.join(ws, "RepoOne");
  const elsewhere = path.join(ws, "RepoOne", "sub");
  const mine = seedRun("run-with-a-board");
  const theirs = seedRun("run-with-its-own");

  const held = file({ mountId: MOUNT, folder: here });
  updateTask(held.id, { status: "claimed" }, { kind: "run", runId: mine });
  const strangers = file({ mountId: MOUNT, folder: here });
  updateTask(strangers.id, { status: "claimed" }, { kind: "run", runId: theirs });
  const openHere = file({ mountId: MOUNT, folder: here });
  const openThere = file({ mountId: MOUNT, folder: elsewhere });

  const seen = tasksForRun(mine, here);

  assert.deepEqual(
    seen.held.map((t: Task) => t.id),
    [held.id],
    "held is keyed on claimed_by_run_id and nothing else",
  );

  const openIds = seen.openInFolder.map((t: Task) => t.id);
  assert.ok(openIds.includes(openHere.id));
  assert.ok(
    !openIds.includes(openThere.id),
    "a task in another folder is another project's business",
  );
  // Claimed is not open, whoever holds it: a run reading a claimed task as
  // something nobody is doing files a second brief for work already running.
  assert.ok(!openIds.includes(strangers.id));
  assert.ok(!openIds.includes(held.id));

  // A run that has completed its task must still see it, or a board that took
  // the write looks like one that lost it.
  updateTask(held.id, { status: "done" }, { kind: "run", runId: mine });
  const after = tasksForRun(mine, here);
  assert.deepEqual(
    after.held.map((t: Task) => t.status),
    ["done"],
    "held carries every status, not just the ones a run may still move",
  );
});

test("a run with no folder gets no board rather than all of it", () => {
  const run = seedRun("run-with-no-folder");
  const held = file({ mountId: MOUNT, folder: path.join(ws, "RepoOne") });
  updateTask(held.id, { status: "claimed" }, { kind: "run", runId: run });

  // The failure this pins is the tempting one: treating a null folder as "no
  // filter" is one `WHERE` clause away and turns the narrow tool into a read of
  // every open task in the install.
  const seen = tasksForRun(run, null);
  assert.deepEqual(seen.openInFolder, []);
  assert.equal(seen.openInFolderTotal, 0);
  assert.deepEqual(
    seen.held.map((t: Task) => t.id),
    [held.id],
    "what a run holds does not depend on it having a folder",
  );
});

test("a clipped board says how much it left out", () => {
  // Its own folder, because the count is of the folder rather than of this
  // test: sharing one with an earlier case makes the assertion a running total
  // that changes whenever a test above it files something.
  const folder = path.join(ws, "RepoOne", "long");
  fs.mkdirSync(folder, { recursive: true });
  const total = MAX_RUN_TASKS + 3;
  for (let i = 0; i < total; i += 1) file({ mountId: MOUNT, folder, title: `open ${i}` });

  const seen = tasksForRun(seedRun("run-reading-a-long-board"), folder);
  assert.equal(seen.openInFolder.length, MAX_RUN_TASKS);
  assert.equal(
    seen.openInFolderTotal,
    total,
    "the count is of what exists, not of what was returned",
  );
});

/* ------------------------------------------------------------------ */
/* Operator-only: who moves the flag, and what it refuses              */
/* ------------------------------------------------------------------ */

/**
 * `operatorOnlyRefusal` as a matrix, `taskTransitionRefusal`'s reason: both
 * ways of getting it wrong are silent. A model allowed to clear the flag starts
 * a run on work the operator was told needs a Mac, and the run spends its whole
 * budget finding that out again; one refused where it should be allowed is a
 * run that cannot say the blocker is the environment, so the next run is
 * started on the same wall.
 *
 * The run acts as the row's holder (`holding`) or as somebody else
 * (`stranger`). "release" is the one write a run may mark in: `claimed → open`
 * of the task the row says it holds.
 */
test("the operator-only matrix: every actor, set and clear, at a create and at an edit", () => {
  const actors: Record<string, TaskActor> = {
    operator: { kind: "operator" },
    holding: { kind: "run", runId: HOLDER },
    stranger: { kind: "run", runId: STRANGER },
    chat: { kind: "chat" },
    block: { kind: "block" },
  };
  const release = { from: "claimed", to: "open", claimedByRunId: HOLDER } as const;

  const cases: Array<{
    what: string;
    from: boolean | null;
    to: boolean;
    move: typeof release | null;
    allowed: readonly string[];
  }> = [
    // Filing. Clearing at a create is filing agent work, which is the default.
    { what: "file marked", from: null, to: true, move: null,
      allowed: ["operator", "holding", "stranger", "chat"] },
    { what: "file unmarked", from: null, to: false, move: null,
      allowed: ["operator", "holding", "stranger", "chat", "block"] },
    // Marking an existing task, in the write that releases it and outside one.
    { what: "mark while releasing", from: false, to: true, move: release,
      allowed: ["operator", "holding"] },
    { what: "mark alone", from: false, to: true, move: null,
      allowed: ["operator"] },
    // Clearing: the operator's alone, whatever else the write does.
    { what: "clear while releasing", from: true, to: false, move: release,
      allowed: ["operator"] },
    { what: "clear alone", from: true, to: false, move: null,
      allowed: ["operator"] },
    // Restating the flag the row already has is not a change.
    { what: "restate marked", from: true, to: true, move: null,
      allowed: ["operator", "holding", "stranger", "chat", "block"] },
  ];

  for (const c of cases) {
    for (const [name, actor] of Object.entries(actors)) {
      const refusal = operatorOnlyRefusal({ actor, from: c.from, to: c.to, move: c.move });
      const where = `${name}: ${c.what}`;
      if (c.allowed.includes(name)) {
        assert.equal(refusal, null, `${where} should be allowed, got: ${refusal}`);
      } else {
        assert.ok(
          typeof refusal === "string" && refusal.length > 20,
          `${where} should be refused with a sentence, got: ${refusal}`,
        );
      }
    }
  }

  // The stranger's refusal is the holder rule's own sentence rather than a
  // second copy of it, which is the only thing that keeps the two in step.
  assert.equal(
    operatorOnlyRefusal({ actor: actors.stranger, from: false, to: true, move: release }),
    taskTransitionRefusal({
      from: "claimed",
      to: "open",
      actor: actors.stranger,
      claimedByRunId: HOLDER,
    }),
  );
});

test("nothing claims an operator-only task, and the refusal names the flag", () => {
  for (const [name, actor] of Object.entries(ACTORS)) {
    const refusal = taskTransitionRefusal({
      from: "open",
      to: "claimed",
      actor,
      claimedByRunId: null,
      claimRunId: HOLDER,
      operatorOnly: true,
    });
    assert.match(refusal ?? "", /operator-only/, `${name} claimed an operator-only task`);
    assert.match(refusal ?? "", /operator clears/, "and says who can undo it");
  }
  // Every other edge is untouched by the flag: an operator-only task is still
  // open, and the operator still closes and drops it the ordinary way.
  for (const to of ["done", "dropped"] as const) {
    assert.equal(
      taskTransitionRefusal({
        from: "open",
        to,
        actor: { kind: "operator" },
        claimedByRunId: null,
        operatorOnly: true,
      }),
      null,
    );
  }
});

test("the flag is a boolean at both doors, and absent is agent work", () => {
  const filed = normalizeTaskInput({ title: "T", body: "b" }, CREATION);
  assert.equal(filed.ok && filed.value.operatorOnly, false);
  const marked = normalizeTaskInput({ title: "T", body: "b", operatorOnly: true }, CREATION);
  assert.equal(marked.ok && marked.value.operatorOnly, true);

  // "false" is truthy: coerced, it would mark a task the caller said not to.
  for (const seen of ["false", "true", 1, 0]) {
    const atCreate = normalizeTaskInput({ title: "T", body: "b", operatorOnly: seen }, CREATION);
    assert.equal(atCreate.ok, false, `create took ${JSON.stringify(seen)}`);
    assert.match(atCreate.ok ? "" : atCreate.error, /operatorOnly/);
    const atEdit = normalizeTaskPatch({ operatorOnly: seen });
    assert.equal(atEdit.ok, false, `edit took ${JSON.stringify(seen)}`);
  }

  const untouched = normalizeTaskPatch({ title: "x" });
  assert.equal(untouched.ok && "operatorOnly" in untouched.value, false);
  const cleared = normalizeTaskPatch({ operatorOnly: false });
  assert.equal(cleared.ok && cleared.value.operatorOnly, false);
});

test("the store asks the flag's rule at a create and at an edit", () => {
  const byChat = normalizeTaskInput(
    { title: "Sign the macOS build", body: "Needs Xcode.", operatorOnly: true },
    { origin: "chat", createdByRunId: null },
  );
  const filed = byChat.ok ? createTask(byChat.value) : assert.fail("door refused");
  assert.equal(filed.ok && filed.task.operatorOnly, true, "a chat may file one marked");

  const byBlock = normalizeTaskInput(
    { title: "T", body: "b", operatorOnly: true },
    { origin: "block", createdByRunId: null },
  );
  const refused = byBlock.ok ? createTask(byBlock.value) : assert.fail("door refused");
  assert.equal(refused.ok, false, "a block may not");

  const task = file();
  const byChatEdit = updateTask(task.id, { operatorOnly: true }, { kind: "chat" });
  assert.equal(byChatEdit.ok, false, "a chat may not mark a task already there");
  assert.equal(getTask(task.id)?.operatorOnly, false, "and nothing was written");

  const byOperator = updateTask(task.id, { operatorOnly: true }, { kind: "operator" });
  assert.equal(byOperator.ok && byOperator.task.operatorOnly, true);

  const claim = updateTask(task.id, { status: "claimed" }, { kind: "run", runId: HOLDER });
  assert.equal(claim.ok, false, "no run claims it");
  assert.equal(getTask(task.id)?.status, "open");

  const byRunClear = updateTask(task.id, { operatorOnly: false }, { kind: "run", runId: HOLDER });
  assert.equal(byRunClear.ok, false, "a run may not clear it");

  // Cleared and claimed in one press is a claim on agent work: the rule reads
  // the flag as the write leaves it.
  const both = updateTask(
    task.id,
    { operatorOnly: false, status: "claimed", claimRunId: HOLDER },
    { kind: "operator" },
  );
  assert.equal(both.ok, true, both.ok ? "" : both.error);
  assert.equal(both.ok && both.task.claimedByRunId, HOLDER);
});

test("a board request narrows on the flag, and says nothing when it is not asked", () => {
  const folder = path.join(ws, "RepoOne", "lanes");
  fs.mkdirSync(folder, { recursive: true });
  const agents = file({ mountId: MOUNT, folder, title: "agent work" });
  const operators = file({ mountId: MOUNT, folder, title: "operator work", operatorOnly: true });

  const ids = (operatorOnly?: boolean | null) =>
    listTasks({ mountId: MOUNT, folder, operatorOnly }).tasks.map((t: Task) => t.id).sort();

  assert.deepEqual(ids(true), [operators.id]);
  assert.deepEqual(ids(false), [agents.id]);
  assert.deepEqual(ids(null), [agents.id, operators.id].sort());
  assert.deepEqual(ids(undefined), [agents.id, operators.id].sort());
  assert.equal(listTasks({ mountId: MOUNT, folder, operatorOnly: true }).total, 1);
  assert.equal(normalizeTaskListQuery({}).operatorOnly, null);
});

test("a brief may name an operator-only task as context and never as work", () => {
  const RESERVED = "c0ffee00-1111-4222-8333-444455556666";
  const board = new Map([
    ...BRIEFED,
    [RESERVED, { title: "Notarise the macOS installer by hand", status: "open" as const, operatorOnly: true }],
  ]);
  const brief = "Build the Linux half. The macOS half is “Notarise the macOS installer by hand”.";

  const asWork = readTaskLinks({ taskIds: [RESERVED] }, brief, board);
  assert.equal(asWork.ok, false);
  const reason = asWork.ok ? "" : asWork.reason;
  assert.match(reason, /operator-only/);
  assert.match(reason, /relatedTaskIds/, "and names the way to say it is context");

  assert.deepEqual(
    readTaskLinks({ relatedTaskIds: [RESERVED] }, brief, board),
    { ok: true, taskIds: [] },
  );
  // The mention rule is not loosened for it: named and in neither list is
  // still the silent bundle that rule exists for.
  assert.equal(readTaskLinks({}, brief, board).ok, false);
});

/* ------------------------------------------------------------------ */
/* Releasing a task: the move, the reason and the flag, together       */
/* ------------------------------------------------------------------ */

/** A task claimed by `runId`, filed through the real door. */
function claimedBy(runId: string, over: Record<string, unknown> = {}): Task {
  const task = file(over);
  const claimed = updateTask(task.id, { status: "claimed" }, { kind: "run", runId });
  if (!claimed.ok) throw new Error(`fixture claim refused: ${claimed.error}`);
  return claimed.task;
}

test("the holder releases: the task is open, unclaimed, and carries the reason", () => {
  const task = claimedBy(HOLDER);
  const released = releaseTask(task.id, HOLDER, {
    reason: "  The build needs Xcode and this container is Linux arm64.  ",
    operatorOnly: false,
  });
  assert.equal(released.ok, true, released.ok ? "" : released.error);

  const row = getTask(task.id)!;
  assert.equal(row.status, "open");
  assert.equal(row.claimedByRunId, null);
  assert.equal(row.operatorOnly, false, "a plain release leaves the flag alone");

  const thread = listTaskComments(task.id, 10).comments;
  assert.equal(thread.length, 1);
  assert.equal(thread[0].author, "run");
  assert.equal(thread[0].authorRunId, HOLDER, "signed by the run that let it go");
  assert.match(thread[0].body, /Released/);
  assert.match(thread[0].body, /needs Xcode and this container is Linux arm64\.$/);

  // Released means released: the run no longer holds it and cannot close it.
  assert.equal(
    updateTask(task.id, { status: "done" }, { kind: "run", runId: HOLDER }).ok,
    false,
  );
});

test("a release asked for operator-only marks the task, and no run claims it after", () => {
  const task = claimedBy(HOLDER);
  const released = releaseTask(task.id, HOLDER, {
    reason: "Needs a signed-in Apple ID on a Mac.",
    operatorOnly: true,
  });
  assert.equal(released.ok, true, released.ok ? "" : released.error);
  assert.equal(getTask(task.id)?.operatorOnly, true);
  assert.match(listTaskComments(task.id, 10).comments[0].body, /operator-only/);

  const again = updateTask(task.id, { status: "claimed" }, { kind: "run", runId: STRANGER });
  assert.equal(again.ok, false);
});

test("a refused release writes nothing: a stranger, no reason, or a task nobody holds", () => {
  const task = claimedBy(HOLDER);
  const unchanged = () => {
    const row = getTask(task.id)!;
    assert.equal(row.status, "claimed");
    assert.equal(row.claimedByRunId, HOLDER);
    assert.equal(row.operatorOnly, false);
    assert.equal(listTaskComments(task.id, 10).total, 0);
  };

  const byStranger = releaseTask(task.id, STRANGER, { reason: "not mine", operatorOnly: true });
  assert.equal(byStranger.ok, false);
  assert.match(byStranger.ok ? "" : byStranger.error, /cannot release/);
  unchanged();

  for (const reason of ["", "   \n  "]) {
    const empty = releaseTask(task.id, HOLDER, { reason, operatorOnly: false });
    assert.equal(empty.ok, false);
    assert.match(empty.ok ? "" : empty.error, /reason/);
    unchanged();
  }

  const long = releaseTask(task.id, HOLDER, {
    reason: "x".repeat(MAX_RELEASE_REASON + 1),
    operatorOnly: false,
  });
  assert.equal(long.ok, false);
  unchanged();
  // The longest reason allowed still fits the note it becomes, flag and all.
  const longest = releaseTask(task.id, HOLDER, {
    reason: "x".repeat(MAX_RELEASE_REASON),
    operatorOnly: true,
  });
  assert.equal(longest.ok, true, longest.ok ? "" : longest.error);

  // Open and held by nobody: `open → open` is not a move and the transition
  // rule allows it for anyone, so without this a run could sign a "released"
  // note on any open task on the board.
  const open = file();
  const nobody = releaseTask(open.id, HOLDER, { reason: "never held it", operatorOnly: false });
  assert.equal(nobody.ok, false);
  assert.equal(listTaskComments(open.id, 10).total, 0);

  const missing = releaseTask("no-such-task", HOLDER, { reason: "r", operatorOnly: false });
  assert.equal(!missing.ok && missing.kind, "missing");
});

test("a release whose note cannot be written does not open the task", () => {
  const task = claimedBy(HOLDER);
  // Forced at the store rather than injected, so what is under test is the
  // real function's transaction and not a seam made for the test.
  db().exec(
    `CREATE TRIGGER refuse_task_comments BEFORE INSERT ON task_comments
       BEGIN SELECT RAISE(ABORT, 'forced for the test'); END`,
  );
  try {
    assert.throws(
      () => releaseTask(task.id, HOLDER, { reason: "blocked", operatorOnly: true }),
      /forced for the test/,
    );
  } finally {
    db().exec("DROP TRIGGER refuse_task_comments");
  }

  const row = getTask(task.id)!;
  assert.equal(row.status, "claimed", "the move rolled back with the note");
  assert.equal(row.claimedByRunId, HOLDER);
  assert.equal(row.operatorOnly, false, "and so did the flag");
  assert.equal(listTaskComments(task.id, 10).total, 0);
});

test("a run started for an operator-only task logs the refused claim and carries on", () => {
  const run = seedRun("run-started-for-operator-work");
  const reserved = file({ title: "Plug the device in", operatorOnly: true });
  const ordinary = file({ title: "The part a run can do" });
  recordRunTasks(run, [reserved.id, ordinary.id]);

  assert.doesNotThrow(() => claimTasksForRun(run));

  assert.equal(getTask(reserved.id)?.status, "open");
  assert.equal(getTask(reserved.id)?.claimedByRunId, null);
  assert.equal(getTask(ordinary.id)?.claimedByRunId, run, "the rest are still claimed");

  const lines = (
    db()
      .prepare("SELECT payload FROM run_events WHERE run_id = ? AND kind = 'log'")
      .all(run) as Array<{ payload: string }>
  ).map((row) => String(JSON.parse(row.payload).message));
  assert.ok(
    lines.some((line) => /could not claim/.test(line) && /operator-only/.test(line)),
    `the refusal is on the run's log: ${JSON.stringify(lines)}`,
  );
  const status = db().prepare("SELECT status FROM runs WHERE id = ?").get(run) as {
    status: string;
  };
  assert.equal(status.status, "queued", "a refused claim is a log line, never a failure");
});

/**
 * Last in the file, because it reopens the database: a boot against a `tasks`
 * table from before the column is what an existing install does once, and the
 * rows it already holds must come back as agent work rather than refuse to
 * read or read as something nobody filed.
 */
test("an install from before the flag reads every old row as agent work", () => {
  const before = file({ title: "filed before the upgrade" });
  db().exec("ALTER TABLE tasks DROP COLUMN operator_only");
  db()
    .prepare(
      `INSERT INTO tasks (id, title, body, status, priority, origin, created_at, updated_at)
       VALUES ('pre-flag-row', 'written by the old build', 'b', 'open', 'normal',
               'operator', 1, 1)`,
    )
    .run();

  const g = globalThis as { __ufDb?: { close(): void } };
  g.__ufDb?.close();
  delete g.__ufDb;

  assert.equal(getTask("pre-flag-row")?.operatorOnly, false);
  assert.equal(getTask(before.id)?.operatorOnly, false);
  // And the column is back as the new build writes it, not merely readable.
  const marked = updateTask("pre-flag-row", { operatorOnly: true }, { kind: "operator" });
  assert.equal(marked.ok && marked.task.operatorOnly, true);
});
