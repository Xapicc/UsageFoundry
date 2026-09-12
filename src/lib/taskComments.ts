import { randomUUID } from "node:crypto";
import { db } from "./db";
import { getTask, type TaskActor } from "./tasks";
import type { TaskCommentAuthorDTO, TaskCommentDTO } from "./apiTypes";

/**
 * Notes on a task: the only thing three different parties can say about a brief
 * without changing it.
 *
 * Its own module rather than a fifth section of `tasks.ts`, and the reason is
 * the one `fileCostNotice.ts` sits beside `orchestrator.ts` for: `tasks.ts` is
 * already the closed sets, the transition rule, the door, the storage and the
 * wire for one table, and a second table's validation, author rule and listing
 * pushed into it would bury `taskTransitionRefusal` — which is the function that
 * file exists to make findable. The dependency runs one way only: this module
 * reads `getTask` and the `TaskActor` union, and nothing in `tasks.ts` imports
 * this one. That is why a comment count reaches `taskDTO` as an **argument**
 * rather than a read, exactly as `TaskRunLinks` already does.
 *
 * Four decisions are written out in `docs/agent/taskboard.md` and every one of
 * them fails silently:
 *
 * **Append-only.** There is no edit and no delete. A comment goes away only when
 * its task does, through `ON DELETE CASCADE`. A thread three parties write to is
 * a record of what was said, and an edit would leave a run acting on text that
 * is no longer there with nothing anywhere saying so.
 *
 * **The author is recorded, never claimed.** It comes from the door the write
 * arrived at — `origin` and `created_by_run_id`'s rule on the row it hangs off —
 * and a body carrying one is refused *by name* rather than ignored. For a run,
 * the id is the capability token's; no tool takes a run id.
 *
 * **A comment moves nothing.** It never claims, never closes, never changes a
 * status or a priority, and it deliberately does not touch `tasks.updated_at`:
 * that column means the task moved and the board sorts on it, so a note would
 * reorder the board and read as a move. Nothing here calls `updateTask` and
 * nothing here may.
 *
 * **A clipped thread loses its oldest end.** The rows come back oldest first,
 * which is how a thread reads, but a cap takes from the *front* — the note that
 * changes what a run does is the one just written, and a cap that dropped the
 * newest would hide exactly what the feature exists for.
 */

/* ------------------------------------------------------------------ */
/* The closed set                                                      */
/* ------------------------------------------------------------------ */

/**
 * Who wrote a note.
 *
 * The same four words as `TASK_ORIGINS` and deliberately not that constant. An
 * origin is a fact about how a *task* came to exist and is written once at a
 * create; an author is a fact about one row of a thread, and the two tables move
 * independently. What sharing them would cost is the thing `rowToTask` guards
 * against one table over: every reader here is typed against this set, and a
 * widening made for one table would silently admit a word the other's `switch`
 * has no case for.
 */
export const TASK_COMMENT_AUTHORS = ["operator", "chat", "block", "run"] as const;

export type TaskCommentAuthor = (typeof TASK_COMMENT_AUTHORS)[number];

export function isTaskCommentAuthor(value: unknown): value is TaskCommentAuthor {
  // `includes` rather than `in`, which walks the prototype chain — `isTaskStatus`'
  // reason, for a value that likewise arrives off a stored row.
  return TASK_COMMENT_AUTHORS.includes(value as TaskCommentAuthor);
}

/* ------------------------------------------------------------------ */
/* What a comment is                                                   */
/* ------------------------------------------------------------------ */

export interface TaskComment {
  id: string;
  taskId: string;
  author: TaskCommentAuthor;
  /** The run that wrote it, and null for every other author. */
  authorRunId: string | null;
  body: string;
  createdAt: number;
}

/** Everything a write supplies, after the door below has proved it. */
export interface TaskCommentInput {
  author: TaskCommentAuthor;
  authorRunId: string | null;
  body: string;
}

export type TaskCommentNormalization =
  | { ok: true; value: TaskCommentInput }
  | { ok: false; error: string };

/**
 * `TaskWriteResult`'s split, for its reason.
 *
 * `missing` is the caller's 404 and `refused` its 400, told apart here rather
 * than at the route so that three doors — the operator's, a chat tool and a work
 * cycle's — cannot each decide differently what a task that is not there means.
 */
export type TaskCommentWriteResult =
  | { ok: true; comment: TaskComment }
  | { ok: false; kind: "missing" | "refused"; error: string };

/* ------------------------------------------------------------------ */
/* Validation at the door — pure, and the reason this file has a test  */
/* ------------------------------------------------------------------ */

/**
 * Characters of a note.
 *
 * Half `MAX_TASK_BODY`, and the difference is what each field is for: a brief is
 * the whole of what a future agent is handed, where a note is what somebody adds
 * to one that is already written. A ceiling this far above any real note is a
 * bound on a pathological write rather than a limit anybody meets.
 */
export const MAX_TASK_COMMENT = 10_000;

/**
 * How many notes one tool result carries.
 *
 * Far below what a route answers with, `MAX_RUN_TASKS`' split and its reason: a
 * page is drawn for a person who scrolls, where this is a tool result an agent
 * pays for by the token on every call. Bodies are **not** clipped inside it,
 * which is the one place this departs from `bodyPreview` beside it — a work
 * cycle has no `get_task` and therefore no second call that would return the
 * rest, so a clipped note is an instruction it can never finish reading.
 */
export const MAX_TOOL_TASK_COMMENTS = 10;

/**
 * Who is writing, in the terms the row records.
 *
 * **Pure, and the whole of the author rule.** Both ways of getting it wrong are
 * silent and both are visible only as a name on a note somebody later acts on: a
 * run's note recorded as the operator's is an agent's guess read as an
 * instruction, and an operator's note carrying a run id is a thread that says a
 * run said something it did not. The `TaskActor` union is what makes the second
 * unrepresentable — `authorRunId` is derivable from the actor and can be read
 * from nowhere else.
 */
export function commentAuthor(actor: TaskActor): {
  author: TaskCommentAuthor;
  authorRunId: string | null;
} {
  return {
    author: actor.kind,
    authorRunId: actor.kind === "run" ? actor.runId : null,
  };
}

/**
 * Read a note off the wire, refusing anything the thread could not answer for.
 *
 * `normalizeTaskInput`'s shape: it never throws, and every refusal names
 * something the asker can change, because three doors have to be able to show it
 * — a form, a chat tool's error and a work cycle's tool result.
 *
 * Three fields are refused **by name** rather than dropped, on
 * `normalizeAgentInput`'s grounds that a caller whose field was silently ignored
 * believes it took effect. `author` and `authorRunId` are recorded from the
 * actor, and a body that could name either would be a chat turn writing a note
 * as though the operator had typed it — the single distinction those columns
 * exist to hold. `createdAt` is refused for a reason of this table's own: the
 * thread is ordered by it, so a write that chose its own timestamp could place a
 * note before ones that answer it, and a reader would have no way to tell.
 */
export function normalizeTaskCommentInput(
  raw: unknown,
  actor: TaskActor,
): TaskCommentNormalization {
  const o = (raw ?? {}) as Record<string, unknown>;

  for (const field of ["author", "authorRunId", "createdAt"] as const) {
    if (o[field] === undefined || o[field] === null) continue;
    return { ok: false, error: refusedField(field) };
  }

  const body = String(o.body ?? "").trim();
  if (!body) {
    return {
      ok: false,
      error:
        "A comment needs a body. It is what you have to say about this task " +
        "to whoever reads it next, and an empty note is one they cannot act on.",
    };
  }
  if (body.length > MAX_TASK_COMMENT) {
    return {
      ok: false,
      error:
        `A comment is at most ${MAX_TASK_COMMENT} characters and this one is ` +
        `${body.length}. Anything longer than that is a brief — file it as a ` +
        `task of its own.`,
    };
  }

  return { ok: true, value: { ...commentAuthor(actor), body } };
}

/** Why a field that is recorded rather than claimed cannot be sent. */
function refusedField(field: "author" | "authorRunId" | "createdAt"): string {
  if (field === "createdAt") {
    return (
      "A comment's createdAt is recorded, not claimed: the thread is read in " +
      "that order, so a note that chose its own timestamp could be placed " +
      "before the ones answering it. Remove it."
    );
  }
  return (
    `A comment's ${field} is recorded, not claimed: it comes from whoever is ` +
    `writing the comment and never from the request. Remove it.`
  );
}

/* ------------------------------------------------------------------ */
/* Storage — the only module that touches the table                    */
/* ------------------------------------------------------------------ */

interface TaskCommentRow {
  id: string;
  task_id: string;
  author: string;
  author_run_id: string | null;
  body: string;
  created_at: number;
}

const COLUMNS = "id, task_id, author, author_run_id, body, created_at";

/**
 * A stored row as the rest of the app sees it.
 *
 * Pure, and `rowToTask`'s job beyond renaming columns: a row outlives the build
 * that wrote it, so an author this build does not recognise is read as the
 * safest thing it could have meant rather than passed through to readers typed
 * against the closed set. `operator` is that default — a note shown as a
 * person's is one somebody weighs for themselves, where showing an unreadable
 * author as `run` would dress it as something an agent is entitled to act on.
 */
export function rowToTaskComment(row: TaskCommentRow): TaskComment {
  return {
    id: row.id,
    taskId: row.task_id,
    author: isTaskCommentAuthor(row.author) ? row.author : "operator",
    authorRunId: row.author_run_id,
    body: row.body,
    createdAt: row.created_at,
  };
}

/**
 * Write a note on a task.
 *
 * The one writer, and it moves nothing: there is no `UPDATE tasks` here, not on
 * `updated_at` and not on anything else. The task is read only to answer whether
 * it is there, which is the `missing` a route turns into a 404 — an insert
 * against a deleted id would otherwise be refused by the foreign key as an
 * opaque SQLite error rather than as a sentence.
 */
export function addTaskComment(
  taskId: string,
  raw: unknown,
  actor: TaskActor,
): TaskCommentWriteResult {
  const parsed = normalizeTaskCommentInput(raw, actor);
  if (!parsed.ok) return { ok: false, kind: "refused", error: parsed.error };

  if (!getTask(taskId)) {
    return { ok: false, kind: "missing", error: "No such task." };
  }

  const id = randomUUID();
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO task_comments
         (id, task_id, author, author_run_id, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, taskId, parsed.value.author, parsed.value.authorRunId, parsed.value.body, now);

  return {
    ok: true,
    comment: {
      id,
      taskId,
      author: parsed.value.author,
      authorRunId: parsed.value.authorRunId,
      body: parsed.value.body,
      createdAt: now,
    },
  };
}

/** One task's thread, and what a cap left out of it. */
export interface TaskCommentThread {
  /** Oldest first. Clipped at the **old** end when `total` exceeds `limit`. */
  comments: TaskComment[];
  /** Notes on this task, counted over the table rather than over the reply. */
  total: number;
  /** The cap actually applied. */
  limit: number;
}

/**
 * One thread, oldest first, with the oldest dropped when it does not fit.
 *
 * The `ORDER BY` is descending and the rows are reversed, which is deliberate
 * rather than a way of avoiding a subquery: the reply is read top to bottom in
 * the order the notes were written, and the ones a cap has to lose are the ones
 * already answered. A cap taking from the other end would hide the note somebody
 * wrote a minute ago, which is the only one a run acting on this thread needs.
 *
 * `total` travels beside the rows on a shortened diff's rule: a reader shown ten
 * of forty and told nothing reads a thread that begins where it does not.
 */
export function listTaskComments(taskId: string, limit: number): TaskCommentThread {
  const capped = Math.max(0, Math.floor(limit) || 0);

  const total = (
    db()
      .prepare("SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ?")
      .get(taskId) as { n: number }
  ).n;

  if (capped === 0) return { comments: [], total, limit: capped };

  const rows = db()
    .prepare(
      `SELECT ${COLUMNS} FROM task_comments
        WHERE task_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(taskId, capped) as TaskCommentRow[];

  return { comments: rows.reverse().map(rowToTaskComment), total, limit: capped };
}

/**
 * How many notes each of these tasks carries, in one query rather than one each.
 *
 * `runLinksForTasks`' shape and its reason: the board draws up to `MAX_TASK_PAGE`
 * rows and polls every ten seconds, so the per-row read this replaces is an N+1
 * running on a timer. A task with no notes is **absent** from the map rather
 * than present as zero, which is what lets the caller's `?? 0` be the one place
 * the default is written.
 */
export function commentCountsForTasks(
  taskIds: readonly string[],
): Map<string, number> {
  const counts = new Map<string, number>();
  if (taskIds.length === 0) return counts;

  const placeholders = taskIds.map(() => "?").join(", ");
  const rows = db()
    .prepare(
      `SELECT task_id, COUNT(*) AS n FROM task_comments
        WHERE task_id IN (${placeholders})
        GROUP BY task_id`,
    )
    .all(...taskIds) as Array<{ task_id: string; n: number }>;

  for (const row of rows) counts.set(row.task_id, row.n);
  return counts;
}

/* ------------------------------------------------------------------ */
/* The wire                                                            */
/* ------------------------------------------------------------------ */

/**
 * One comment as every route answers for it.
 *
 * Here rather than in either route, `taskDTO`'s reason: two copies of "what a
 * note says about who wrote it" would be two payloads that could disagree about
 * the one field the whole append-only design rests on.
 */
export function taskCommentDTO(comment: TaskComment): TaskCommentDTO {
  return {
    id: comment.id,
    taskId: comment.taskId,
    author: comment.author as TaskCommentAuthorDTO,
    authorRunId: comment.authorRunId,
    body: comment.body,
    createdAt: comment.createdAt,
  };
}
