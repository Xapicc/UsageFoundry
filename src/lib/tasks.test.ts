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
  recordRunForTask,
  runLinksForTasks,
  taskDTO,
  taskForRun,
  taskRefusal,
  taskDeletionRefusal,
  MAX_RUN_TASKS,
  taskListItemDTO,
  tasksForRun,
  taskTransitionRefusal,
  updateTask,
} = require("./tasks") as typeof import("./tasks");
const { MAX_TASK_RUN_LINKS } = require("./apiTypes") as typeof import("./apiTypes");
const { db } = require("./db") as typeof import("./db");

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
    ["t-open", { title: "Open one", status: "open" as const }],
    ["t-done", { title: "Closed one", status: "done" as const }],
    ["t-dropped", { title: "Dropped one", status: "dropped" as const }],
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
    recordRunForTask(run, task.id);
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
  recordRunForTask(run, task.id);

  assert.equal(taskForRun(run)?.title, task.title);
  assert.equal(deleteTask(task.id, { kind: "operator" }).ok, true);

  // Three states rather than two, which is why the id is not a foreign key: a
  // run whose task has gone is not a run that never had one, and a surface
  // collapsing them loses the provenance the column exists to hold.
  const orphan = taskForRun(run);
  assert.equal(orphan?.id, task.id);
  assert.equal(orphan?.title, null);
  assert.equal(orphan?.status, null);
  assert.equal(taskForRun(seedRun("run-off-no-task")), null);
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
