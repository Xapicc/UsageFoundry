import { db } from "./db";
import { addTaskComment, MAX_TASK_COMMENT, type TaskComment } from "./taskComments";
import { getTask, updateTask, type Task, type TaskWriteResult } from "./tasks";

/**
 * A run putting back a task it cannot finish, with the reason on the task.
 *
 * Its own module because it is the one write that touches both tables: the
 * move is `updateTask`'s and the reason is a note, and `tasks.ts` must not
 * import `taskComments.ts` (the dependency runs one way, see that module's
 * header) while `taskComments.ts` must not call `updateTask` (a note moves
 * nothing). A function here depends on both and is depended on by the route.
 *
 * **One transaction, and that is the reason this is a function rather than two
 * calls in the route.** A release that opened the task and lost the reason is
 * the failure to avoid: the next run picks the task up with nothing saying what
 * was tried, and does it again. So the move and the note commit together or not
 * at all, and a note the store refuses rolls the move back.
 *
 * **No authority of its own.** Who may release is `taskTransitionRefusal`'s
 * `claimed → open`, asked through `updateTask` against the row's own
 * `claimed_by_run_id`; who may mark the task operator-only is
 * `operatorOnlyRefusal`, asked by the same call. The one check here is that
 * the task is `claimed` at all, because `open → open` is not a move and that
 * rule allows it for anybody — without it any run could write a "released"
 * note on any open task.
 */

/** What the note says before the run's own words, so the thread can be read at a glance. */
const RELEASED = "Released — this run could not finish the task and put it back as open.";
const RELEASED_FOR_OPERATOR =
  "Released and marked operator-only — this needs something no run in this container has.";

/**
 * Characters of a reason: whatever keeps the note it becomes inside
 * `MAX_TASK_COMMENT`, so a reason the tool accepted is never refused by the
 * comment store for a length the caller never typed.
 */
export const MAX_RELEASE_REASON = MAX_TASK_COMMENT - RELEASED_FOR_OPERATOR.length - 2;

export interface ReleaseRequest {
  reason: string;
  operatorOnly: boolean;
}

export type TaskReleaseResult =
  | { ok: true; task: Task; comment: TaskComment }
  | { ok: false; kind: "missing" | "refused"; error: string };

/** Thrown inside the transaction to roll the move back; never escapes this module. */
class NoteRefused extends Error {
  readonly result: TaskReleaseResult & { ok: false };
  constructor(result: TaskReleaseResult & { ok: false }) {
    super(result.error);
    this.result = result;
  }
}

/**
 * The reason, or why it cannot be one. Pure: the whole of the door's arithmetic.
 */
export function readReleaseReason(
  raw: string,
): { ok: true; reason: string } | { ok: false; error: string } {
  const reason = raw.trim();
  if (!reason) {
    return {
      ok: false,
      error:
        "release_task needs a reason: what you tried and what stopped you. It " +
        "is written on the task for the next run or the operator, and a " +
        "release with no reason sends them to try the same thing again.",
    };
  }
  if (reason.length > MAX_RELEASE_REASON) {
    return {
      ok: false,
      error:
        `A release reason is at most ${MAX_RELEASE_REASON} characters and this ` +
        `one is ${reason.length}. Say what blocked you; put anything longer in ` +
        "a task of its own with create_task.",
    };
  }
  return { ok: true, reason };
}

/**
 * Release `taskId` from `runId`, writing `reason` on it and, if asked, marking
 * it operator-only — all of it or none of it.
 */
export function releaseTask(
  taskId: string,
  runId: string,
  request: ReleaseRequest,
): TaskReleaseResult {
  const reason = readReleaseReason(request.reason);
  if (!reason.ok) return { ok: false, kind: "refused", error: reason.error };

  const actor = { kind: "run", runId } as const;
  const note = `${request.operatorOnly ? RELEASED_FOR_OPERATOR : RELEASED}\n\n${reason.reason}`;

  const release = db().transaction((): TaskReleaseResult => {
    const task = getTask(taskId);
    if (!task) return { ok: false, kind: "missing", error: "No such task." };
    // No title: this answers for whatever id it is handed, and the title of a
    // task the run does not hold is a read past what a run token is bounded to.
    // The MCP door refuses those first (`notHeldByRun`); this keeps the next
    // caller from reopening it.
    if (task.status === "open") {
      return {
        ok: false,
        kind: "refused",
        error:
          "This task is already open and held by no run, so there is nothing " +
          "to release. Only a task this run holds can be released.",
      };
    }

    const moved: TaskWriteResult = updateTask(
      taskId,
      request.operatorOnly ? { status: "open", operatorOnly: true } : { status: "open" },
      actor,
    );
    if (!moved.ok) return moved;

    const written = addTaskComment(taskId, { body: note }, actor);
    if (!written.ok) throw new NoteRefused(written);

    return { ok: true, task: moved.task, comment: written.comment };
  });

  try {
    return release();
  } catch (error) {
    if (error instanceof NoteRefused) return error.result;
    throw error;
  }
}
