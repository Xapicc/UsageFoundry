import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
// Type-only, so it is erased rather than hoisted above the environment setup
// below — `tasks.test.ts`' reason, and the same reason the values come through
// `require`.
import type { TaskActor } from "./tasks";

/**
 * Who a note says wrote it, and what a thread refuses to be handed.
 *
 * Two rules, both pure, and both silent in the way this repository's test bar
 * names. **The author rule** is the load-bearing one: a note is a sentence
 * somebody later acts on, so a run's note recorded as the operator's is an
 * agent's guess read as an instruction, and an operator's note carrying a run id
 * is a thread asserting a run said something it did not. Neither throws, neither
 * fails a typecheck, and both render as an ordinary note. **The body rule** is
 * the smaller half and fails the same way in the other direction: an empty note
 * stored is a row on a thread with nothing in it, which reads as a person having
 * written and said nothing.
 *
 * The last section reaches the database, on the grounds `tasks.test.ts`' own
 * writes earned: three of this feature's decisions are not in a pure function
 * and no pure function can reach them. A comment that bumped `tasks.updated_at`
 * would reorder the board and read as a move; a cap that dropped the newest note
 * rather than the oldest would hide the one thing a run reading a thread needs;
 * and a thread outliving its task is orphaned prose no surface can place.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-task-comments-")));
const ws = path.join(tmp, "ws");
fs.mkdirSync(path.join(ws, "RepoOne"), { recursive: true });

process.env.WORKSPACE_ROOTS = `Main=${ws}`;
process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
// Pinned rather than left to fall back to CLAUDE_HOME, `tasks.test.ts`' reason:
// an ambient CLAUDE_CONFIG_DIR holding an OAuth token would make a unit test
// talk to Anthropic on the operator's own credential.
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");
// Nothing here spawns, and this is the second lock on that door.
process.env.CLAUDE_BIN = path.join(tmp, "no-such-claude");
process.env.CODEX_BIN = path.join(tmp, "no-such-codex");
process.env.CODEX_HOME = path.join(tmp, "codex");

// `require`, not `import`: imports are hoisted above the environment setup
// above, and `orchestrator.ts` — which `tasks.ts` takes its folder resolution
// from — reads WORKSPACE_ROOTS once at load.
const {
  MAX_TASK_COMMENT,
  addTaskComment,
  commentAuthor,
  listTaskComments,
  normalizeTaskCommentInput,
} = require("./taskComments") as typeof import("./taskComments");
const { createTask, deleteTask, getTask } = require("./tasks") as typeof import("./tasks");
const { db } = require("./db") as typeof import("./db");

const RUN = "11111111-2222-3333-4444-555555555555";

const ACTORS: Record<string, TaskActor> = {
  operator: { kind: "operator" },
  chat: { kind: "chat" },
  block: { kind: "block" },
  run: { kind: "run", runId: RUN },
};

/* ------------------------------------------------------------------ */
/* The author rule                                                     */
/* ------------------------------------------------------------------ */

test("the author is the actor's kind, and only a run carries a run id", () => {
  for (const [name, actor] of Object.entries(ACTORS)) {
    const { author, authorRunId } = commentAuthor(actor);
    assert.equal(author, name, `${name} should be recorded as ${name}`);
    // The half that is not about the word: a run id beside an operator's note
    // would be a thread claiming a run said something a person typed, and the
    // three non-run kinds have no id to carry in the first place.
    assert.equal(
      authorRunId,
      name === "run" ? RUN : null,
      `${name} should ${name === "run" ? "carry" : "carry no"} run id`,
    );
  }
});

test("the author rule survives the door: a body cannot name its own author", () => {
  // The failure this closes is the quiet one — a chat turn writing a note as
  // though the operator had typed it, which is the single distinction the
  // column exists to hold. Refused by name rather than dropped, because a
  // caller whose field was silently ignored believes it took effect.
  for (const field of ["author", "authorRunId", "createdAt"] as const) {
    const refused = normalizeTaskCommentInput(
      { body: "a note", [field]: field === "createdAt" ? 0 : "operator" },
      ACTORS.chat,
    );
    assert.equal(refused.ok, false, `${field} should be refused`);
    assert.ok(
      !refused.ok && refused.error.includes(field),
      `${field}'s refusal must name it: ${!refused.ok && refused.error}`,
    );
  }

  // An absent one is not a refusal, or every ordinary write would be one.
  const written = normalizeTaskCommentInput({ body: "a note" }, ACTORS.chat);
  assert.ok(written.ok);
  assert.equal(written.value.author, "chat");
  assert.equal(written.value.authorRunId, null);
});

test("the recorded author is the actor's, never the one a run asserts", () => {
  // A run sending somebody else's identity is refused rather than believed, and
  // the actor the door was given is what lands on the row.
  const refused = normalizeTaskCommentInput(
    { body: "a note", authorRunId: "99999999-8888-7777-6666-555555555555" },
    ACTORS.run,
  );
  assert.equal(refused.ok, false);

  const written = normalizeTaskCommentInput({ body: "a note" }, ACTORS.run);
  assert.ok(written.ok);
  assert.equal(written.value.author, "run");
  assert.equal(written.value.authorRunId, RUN);
});

/* ------------------------------------------------------------------ */
/* The body rule                                                       */
/* ------------------------------------------------------------------ */

test("a body is trimmed, non-empty and within the cap", () => {
  for (const empty of ["", "   ", "\n\t ", undefined, null]) {
    const refused = normalizeTaskCommentInput({ body: empty }, ACTORS.operator);
    assert.equal(refused.ok, false, `${JSON.stringify(empty)} should be refused`);
    // A refusal nobody can act on is the same as no refusal at all, so every
    // one of them has to be a sentence rather than a code.
    assert.ok(
      !refused.ok && refused.error.length > 20,
      "an empty body's refusal is not a sentence",
    );
  }

  const trimmed = normalizeTaskCommentInput({ body: "  a note  " }, ACTORS.operator);
  assert.ok(trimmed.ok);
  assert.equal(trimmed.value.body, "a note");

  // The boundary in both directions. Trimming happens *before* the measurement,
  // so trailing whitespace cannot push a legal note over the cap.
  const atCap = normalizeTaskCommentInput(
    { body: `${"x".repeat(MAX_TASK_COMMENT)}   ` },
    ACTORS.operator,
  );
  assert.ok(atCap.ok, "a note of exactly the cap, plus trailing space, is legal");
  assert.equal(atCap.value.body.length, MAX_TASK_COMMENT);

  const overCap = normalizeTaskCommentInput(
    { body: "x".repeat(MAX_TASK_COMMENT + 1) },
    ACTORS.operator,
  );
  assert.equal(overCap.ok, false);
  assert.ok(
    !overCap.ok && overCap.error.includes(String(MAX_TASK_COMMENT)),
    "the refusal must say what the cap is",
  );
});

/* ------------------------------------------------------------------ */
/* The three the pure functions cannot reach                           */
/* ------------------------------------------------------------------ */

function seedTask(title: string): string {
  const created = createTask({
    title,
    body: "the brief",
    priority: "normal",
    origin: "operator",
    mountId: null,
    folder: null,
    createdByRunId: null,
    parentTaskId: null,
  });
  assert.ok(created.ok, "seed task should be created");
  return created.task.id;
}

test("a comment does not move the task, and in particular does not bump updated_at", () => {
  const id = seedTask("unmoved");
  const before = getTask(id)!;

  // Rolled back rather than waited out: `updated_at` is milliseconds, so a
  // same-millisecond write would pass this test whatever the code did.
  db().prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(1, id);

  const written = addTaskComment(id, { body: "a note" }, ACTORS.operator);
  assert.ok(written.ok);

  const after = getTask(id)!;
  // The whole of decision three: the board sorts on `updated_at`, so a note
  // that touched it would reorder the board and read as a move.
  assert.equal(after.updatedAt, 1, "a comment must not bump updated_at");
  assert.equal(after.status, before.status);
  assert.equal(after.priority, before.priority);
  assert.equal(after.claimedByRunId, before.claimedByRunId);
  assert.equal(after.closedAt, before.closedAt);
});

test("a capped thread reads oldest first and loses its oldest end", () => {
  const id = seedTask("threaded");
  for (let n = 0; n < 5; n += 1) {
    const written = addTaskComment(id, { body: `note ${n}` }, ACTORS.operator);
    assert.ok(written.ok);
    // Written straight, because five inserts inside one millisecond would tie
    // on `created_at` and the order under test would be the tiebreak instead.
    db()
      .prepare("UPDATE task_comments SET created_at = ? WHERE id = ?")
      .run(1_000 + n, written.comment.id);
  }

  const whole = listTaskComments(id, 10);
  assert.equal(whole.total, 5);
  assert.deepEqual(
    whole.comments.map((c) => c.body),
    ["note 0", "note 1", "note 2", "note 3", "note 4"],
  );

  const clipped = listTaskComments(id, 2);
  // The direction that matters: what a cap drops is what has already been
  // answered, never the note somebody wrote a minute ago — which is the only
  // one a run acting on this thread needs.
  assert.deepEqual(
    clipped.comments.map((c) => c.body),
    ["note 3", "note 4"],
  );
  // And the clip is never silent, on a shortened diff's rule.
  assert.equal(clipped.total, 5);
  assert.equal(clipped.limit, 2);
});

test("a deleted task takes its thread with it, and leaves every other thread standing", () => {
  const doomed = seedTask("doomed");
  const kept = seedTask("kept");
  assert.ok(addTaskComment(doomed, { body: "on the doomed one" }, ACTORS.operator).ok);
  assert.ok(addTaskComment(kept, { body: "on the kept one" }, ACTORS.operator).ok);

  assert.ok(deleteTask(doomed, ACTORS.operator).ok);

  // The one way a comment goes away — `ON DELETE CASCADE`, which is inert
  // unless `PRAGMA foreign_keys` is on, and that is what this asserts.
  assert.equal(listTaskComments(doomed, 10).total, 0);
  assert.equal(listTaskComments(kept, 10).total, 1);

  // And a note on a task that is not there is refused as `missing` rather than
  // dying on the foreign key as an opaque SQLite error.
  const written = addTaskComment(doomed, { body: "too late" }, ACTORS.operator);
  assert.equal(written.ok, false);
  assert.equal(!written.ok && written.kind, "missing");
});
