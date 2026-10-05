import { randomUUID } from "node:crypto";
import path from "node:path";
import { db } from "./db";
import { describeFolder, resolveWorkspaceFolder } from "./orchestrator";
import type {
  RunTaskDTO,
  TaskDepsDTO,
  TaskDTO,
  TaskListItemDTO,
  TaskOriginDTO,
  TaskPriorityDTO,
  TaskStatusDTO,
} from "./apiTypes";
// The board figures live with the DTOs they bound, so the page that asks for a
// whole board and the query that caps one read the same number.
import {
  MAX_LIST_TASK_BODY,
  MAX_TASK_PAGE,
  MAX_TASK_RUN_LINKS,
} from "./apiTypes";

/**
 * The taskboard: one board across every mount, and the only module that
 * touches the `tasks` table.
 *
 * **A task is not a run.** `agents.ts`' rule one table over, and here it is the
 * thing that keeps the board out of every decision the orchestrator makes: a
 * row here claims no folder, consumes no concurrency slot, spawns nothing, is
 * invisible to `activeRuns()`, and no guard, budget or sweep reads it. What it
 * holds is a *brief* — the text a future agent is handed when somebody decides
 * the work is worth doing — and three nullable run ids that are records of what
 * happened rather than handles anything acts on.
 *
 * **The transition rule is a pure function and it is the point of this file.**
 * `taskTransitionRefusal` decides which status may move to which *and which
 * actor kind may make that move*, and every way of getting it wrong is silent:
 * a wrong edge closes work nobody did, and the board, the row and the log all
 * read as if it had been done. That is the bar `docs/agent/testing.md` states,
 * and it is why the rule is a function over plain data rather than a set of
 * checks spread across the doors that call it. There is exactly one writer of
 * `status` here (`updateTask`), and it asks that function before it writes.
 *
 * The invariants this file establishes are written out in
 * `docs/agent/taskboard.md`. The three worth knowing before editing anything:
 * `claimed` is a record of which run holds a task and **never** a lease — there
 * is no clock on this path and adding one is the change the doc argues against;
 * a model-driven actor (`chat`, `block`) may put work on the board and may
 * never take it off; and a `mount_id`/`folder` pair is proved against the app's
 * own mount list at the door rather than trusted, through the same
 * `resolveWorkspaceFolder` a run is confined by.
 */

/* ------------------------------------------------------------------ */
/* The closed sets                                                     */
/* ------------------------------------------------------------------ */

/**
 * Where a task can be.
 *
 * Four, and the pair of terminal words is deliberate rather than one status
 * with a reason beside it: `done` is work that happened and `dropped` is work
 * that was decided against, and a board that conflated them would answer "what
 * did this install get done" with a number that includes everything abandoned.
 */
export const TASK_STATUSES = ["open", "claimed", "done", "dropped"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * How urgent, as a closed set of words rather than a number.
 *
 * A free integer is a scale nobody can read back: `7` means whatever the person
 * who typed it meant, two surfaces round it differently, and a board sorted on
 * it cannot say what a bucket is. Four words are what a person actually holds
 * in their head about a backlog. What the word costs is one index that cannot
 * carry it — see `idx_tasks_board` in `db.ts` and the `ORDER BY` below.
 */
export const TASK_PRIORITIES = ["urgent", "high", "normal", "low"] as const;

export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/**
 * The board's order as SQL, derived from the closed set rather than restated.
 *
 * The array above *is* the order — urgent first — so writing the ranks out a
 * second time would be a fact in two places, and the way it would go wrong is
 * a board silently sorted by a stale copy. The only thing interpolated here is
 * a compile-time literal from that array; nothing off a request reaches it.
 *
 * The `ELSE` is the rank of `normal`, which is `rowToTask`'s reading of an
 * unrecognised priority written in one place: a row from a future build sorts
 * where it renders rather than off one end of the board.
 */
const PRIORITY_RANK_SQL = `CASE priority ${TASK_PRIORITIES.map(
  (priority, rank) => `WHEN '${priority}' THEN ${rank}`,
).join(" ")} ELSE ${TASK_PRIORITIES.indexOf("normal")} END`;

/**
 * Who put a task on the board.
 *
 * Recorded rather than derived, and it is the same four values as `TaskActor`
 * below without being the same thing: this is a fact about how the row came to
 * exist, where an actor is who is asking to change one *now*. An operator reads
 * a board differently when a run filed the item, and neither the run ids nor
 * `created_at` can answer that — a task filed by the operator on behalf of a
 * run would carry the same columns.
 */
export const TASK_ORIGINS = ["operator", "chat", "block", "run"] as const;

export type TaskOrigin = (typeof TASK_ORIGINS)[number];

/**
 * Who is asking to move a task, in the terms the rule is written in.
 *
 * A discriminated union rather than a string plus an optional run id, because
 * the one rule that needs an identity — a run may complete only what it holds —
 * is unstateable without one, and an actor kind of `"run"` carrying no run id
 * is a shape that must not be representable. The two model-driven kinds carry
 * nothing: what they are refused is refused on the kind alone.
 */
export type TaskActor =
  | { kind: "operator" }
  | { kind: "chat" }
  | { kind: "block" }
  | { kind: "run"; runId: string };

/* ------------------------------------------------------------------ */
/* What a task is                                                      */
/* ------------------------------------------------------------------ */

export interface Task {
  id: string;
  title: string;
  /** The brief a future agent reads with no other context. */
  body: string;
  status: TaskStatus;
  priority: TaskPriority;
  origin: TaskOrigin;
  /** Null together with `folder`: a task tied to no project. */
  mountId: string | null;
  /** Canonical absolute path, the shape `runs.folder` holds. */
  folder: string | null;
  createdByRunId: string | null;
  /** Which run holds it. A record, never a lease — see the docblock above. */
  claimedByRunId: string | null;
  /**
   * The operator holds it themselves. A `claimed` task has exactly one holder,
   * this or `claimedByRunId`, and neither is set on a task that is not claimed.
   */
  claimedByOperator: boolean;
  completedByRunId: string | null;
  /** Set when a run filed this while working another. */
  parentTaskId: string | null;
  /**
   * Work no run in this container can do, left on the board for the operator.
   * Not a status: an operator-only task is still `open`. See
   * `operatorOnlyRefusal` for who may set and clear it.
   */
  operatorOnly: boolean;
  /**
   * A local model could not get this past a frontier review, so no local-model
   * run may take it on. Not a status, operator-only's shape one lane over: set
   * by a workflow's review block when it sets a branch aside, or by the
   * operator; cleared by the operator alone. See `needsFrontierRefusal`.
   */
  needsFrontier: boolean;
  createdAt: number;
  updatedAt: number;
  /** When it reached `done` or `dropped`, and null again if it left. */
  closedAt: number | null;
}

/** Everything a create supplies, after the door has proved it. */
export interface TaskInput {
  title: string;
  body: string;
  priority: TaskPriority;
  origin: TaskOrigin;
  mountId: string | null;
  folder: string | null;
  createdByRunId: string | null;
  parentTaskId: string | null;
  operatorOnly: boolean;
}

/**
 * The two fields a caller supplies rather than a request body.
 *
 * `permissionMode`'s treatment in `POST /api/runs`, in the other direction: the
 * narrowing there is against a list, and here it is against the wire itself.
 * An origin that arrived in a body would be a chat turn able to file work as
 * though the operator had typed it, which is the one thing the column exists to
 * tell apart — so neither of these is ever read off `raw`, and a body carrying
 * either is refused by name rather than ignored.
 */
export interface TaskCreation {
  origin: TaskOrigin;
  /** The run that filed it, when one did. */
  createdByRunId: string | null;
}

export type TaskNormalization =
  | { ok: true; value: TaskInput }
  | { ok: false; error: string };

/**
 * A refusal that is about the request, not about the row it names.
 *
 * `missing` is the caller's 404 and `refused` its 400: the two are told apart
 * here rather than at the route so that three doors — this app's own, a chat
 * tool and a work cycle's — cannot each decide differently what a task that is
 * not there means.
 */
export type TaskWriteResult =
  | { ok: true; task: Task }
  | { ok: false; kind: "missing" | "refused"; error: string };

/* ------------------------------------------------------------------ */
/* The transition rule — pure, and the reason this file has a test     */
/* ------------------------------------------------------------------ */

/** A proposed move, in the terms `taskTransitionRefusal` decides on. */
export interface TaskTransition {
  from: TaskStatus;
  to: TaskStatus;
  actor: TaskActor;
  /** `claimed_by_run_id` as the row holds it, never as a caller asserts it. */
  claimedByRunId: string | null;
  /**
   * `claimed_by_operator` as the row holds it. Absent reads as not held by the
   * operator; `updateTask`, the one writer of `status`, always passes it.
   */
  claimedByOperator?: boolean;
  /**
   * The run that will hold it, when `to` is `claimed`. Empty is the operator
   * claiming the task for themselves, which only the operator may do.
   */
  claimRunId?: string | null;
  /**
   * `operator_only` as it will stand after the write this move is part of.
   * Absent reads as agent work; `updateTask`, the one writer of `status`,
   * always passes it.
   */
  operatorOnly?: boolean;
}

const COMPLETION_BELONGS_TO =
  "Completion belongs to the run that did the work, or to the operator.";

/**
 * Why this actor may not make this move, or null when it may.
 *
 * **Pure, total, and the whole of the board's authority model.** Total in the
 * sense that matters: it never throws, and every refusal names something the
 * asker could change. `agentRefusal`'s shape, for `agentRefusal`'s reason — the
 * same sentence has to be readable at three different doors (the operator's
 * route, a chat tool, a work cycle) and one wording is what stops them
 * disagreeing about the same move.
 *
 * The edges are few enough to state, and every absent edge is refused:
 *
 *   - `open → claimed`     any actor, and the claim names the run that holds it;
 *                          or the operator, holding it themselves. While the
 *                          task is operator-only, only that second kind
 *   - `open → done`        operator only; a run claims first
 *   - `open → dropped`     operator only
 *   - `claimed → open`     operator, or the run that holds it (releasing)
 *   - `claimed → done`     operator, or the run that holds it
 *   - `claimed → dropped`  operator only
 *   - `done → open`        operator only (re-opening)
 *   - `dropped → open`     operator only
 *
 * Five decisions inside that are worth stating rather than deducing.
 *
 * **A run may complete only the task it holds.** Not "a task", and not "a task
 * claimed by some run": the row's own `claimed_by_run_id` has to be this run.
 * The failure this closes is the expensive one on the whole feature — a work
 * cycle that read the board, picked the wrong id out of a list and marked it
 * done. Nothing throws, the board says the work happened, and the task nobody
 * did is gone from every view an operator looks at.
 *
 * **`chat` and `block` may never move a task to `done`.** They are the two
 * model-driven actors, they may both put work on the board, and neither of them
 * *does* work — an orchestrator block decides and emits, a chat turn proposes.
 * The brief names `chat`; `block` is refused on the same ground and not by
 * omission, because "completion belongs to the run that did the work" excludes
 * anything that is not that run by construction.
 *
 * **A terminal task is re-opened before it is anything else.** There is no
 * `done → dropped` and no `dropped → done`, so the set of edges stays small
 * enough to read, and the operator's re-open is the one door back.
 *
 * **`from === to` is not a move.** An update that restates the status a row
 * already has changes nothing and is allowed for any actor; it is the caller's
 * job not to apply a move's effects when nothing moved, which `updateTask`
 * does by only calling this when the status actually differs.
 *
 * **A claim names its holder, and the operator can be one.** The operator
 * claiming a task says "I am doing this myself": the board shows who holds it,
 * and nothing points a run at it. That is the whole of what an operator-only
 * task is waiting for, so the operator may claim one; what the flag still
 * refuses is a claim naming a *run*, because no run here can do the work and a
 * claim on one is a run spending its budget finding that out. A claim naming
 * nobody is the operator's alone — from anyone else it is the record of a
 * holder that does not exist, and nothing would ever release it. The claim is
 * taken from `open` only: a task a run holds is released first and claimed
 * second, so taking work off a run is two presses the operator can see, never
 * a side effect of one. A task already claimed when the flag is set keeps its
 * claim: the claim is a record, and taking it off is a release.
 *
 * **Nothing but the operator moves a task the operator holds** — not to
 * release it, complete it, drop it, or claim it again, and this one is checked
 * before `from === to` on purpose. A run re-claims its tasks at every pick-up
 * and resume, and against the operator's claim that restated `claimed` would
 * otherwise be an allowed no-op the run's log could only report as held by
 * nobody; refused, the sentence it logs says who has the task.
 */
export function taskTransitionRefusal(transition: TaskTransition): string | null {
  const { from, to, actor, claimedByRunId } = transition;

  if (transition.claimedByOperator && from === "claimed" && actor.kind !== "operator") {
    return operatorHolderRefusal(actor, to);
  }

  if (from === to) return null;

  const closed = from === "done" || from === "dropped";
  if (closed && to !== "open") {
    return (
      `This task is already ${from}. Re-open it first — a ${from} task moves ` +
      `back to open and nowhere else, so nothing can be closed twice under ` +
      `two different words.`
    );
  }

  if (to === "open") {
    if (actor.kind === "operator") return null;
    if (closed) {
      return (
        `Only the operator re-opens a ${from} task. ${COMPLETION_BELONGS_TO} ` +
        `Undoing it is theirs alone.`
      );
    }
    // `claimed → open`: releasing a claim. The holder may put it back.
    if (actor.kind === "run") {
      return actor.runId === claimedByRunId
        ? null
        : holderRefusal(actor.runId, claimedByRunId, "release");
    }
    return (
      `A ${actor.kind} cannot release another run's claim. Ask the operator, ` +
      `or let the run that holds it put it back.`
    );
  }

  if (to === "claimed") {
    const claimRunId = (transition.claimRunId ?? "").trim();
    if (!claimRunId) {
      if (actor.kind === "operator") return null;
      return (
        `A claim is the record of who holds the task, so a ${actor.kind} has to ` +
        "name the run that will. Only the operator claims a task without one, " +
        "for themselves. Nothing here expires a claim, and a claim naming " +
        "nobody could never be released."
      );
    }
    if (transition.operatorOnly) {
      return (
        "This task is marked operator-only: it needs something no run in this " +
        "container has, so no run may claim it. The operator may claim it for " +
        "themselves, or clear the mark on the board if a run should take it " +
        "after all."
      );
    }
    if (actor.kind === "run" && actor.runId !== claimRunId) {
      return (
        `A run claims a task for itself. This one is run ${short(actor.runId)} ` +
        `and the claim names run ${short(claimRunId)}.`
      );
    }
    return null;
  }

  if (to === "dropped") {
    if (actor.kind === "operator") return null;
    return (
      `Only the operator drops a task. Dropping is a decision that the work ` +
      `should not be done at all, which is not a judgement a ${actor.kind} ` +
      `makes on the operator's backlog — release it instead, or say why in a ` +
      `task of its own.`
    );
  }

  // to === "done"
  if (actor.kind === "operator") return null;
  if (actor.kind !== "run") {
    return (
      `A ${actor.kind} can put work on the board and cannot take it off. ` +
      `${COMPLETION_BELONGS_TO}`
    );
  }
  if (from !== "claimed") {
    return (
      `A run completes the task it holds, and this one is ${from}. Claim it ` +
      `first, so the board says who is doing it before it says it is done.`
    );
  }
  return actor.runId === claimedByRunId
    ? null
    : holderRefusal(actor.runId, claimedByRunId, "complete");
}

/**
 * The one wording for "the operator holds this", whatever the asker wanted to
 * do with it. Its own sentence rather than `holderRefusal`'s, which would read
 * the null run column as nobody holding the task.
 */
function operatorHolderRefusal(
  actor: Exclude<TaskActor, { kind: "operator" }>,
  to: TaskStatus,
): string {
  const verb = { claimed: "claim", open: "release", done: "complete", dropped: "drop" }[to];
  const who = actor.kind === "run" ? `Run ${short(actor.runId)}` : `A ${actor.kind}`;
  return (
    `${who} cannot ${verb} this task: the operator holds it and is doing it ` +
    "themselves. Only the operator moves a task they hold — leave a comment " +
    "if there is something they should know."
  );
}

/** The one wording for "you are not the run that holds this". */
function holderRefusal(
  askerRunId: string,
  claimedByRunId: string | null,
  verb: "release" | "complete",
): string {
  const held = claimedByRunId
    ? `run ${short(claimedByRunId)} holds it`
    : "nobody holds it";
  return (
    `Run ${short(askerRunId)} cannot ${verb} this task: ${held}. A run may ` +
    `${verb} only the task claimed in its own name.`
  );
}

/**
 * Whether a task goes back to `open` because the work that claimed or closed it
 * was rejected by a workflow's review block, or why it stays where it is.
 *
 * The one move off the transition table that is not made by an actor asking,
 * and it is narrow on purpose. A review block sets a branch aside when a
 * frontier model still rejects it after the last fix round; the task that
 * branch was for is then claimed by, or closed as done by, a run whose work was
 * never merged — a claim nobody is working and a tick nobody earned. So the
 * task is reopened **only** when the run holding it is one of the rejected
 * runs: a task another run holds or closed, one the operator holds, and one the
 * operator dropped, are someone's decision about different work, and are left
 * alone. Pure, so the rule is tested apart from the write.
 */
export function rejectedWorkReopen(
  task: Pick<Task, "status" | "claimedByRunId" | "claimedByOperator" | "completedByRunId">,
  rejectedRunIds: readonly string[],
): { reopen: true } | { reopen: false; why: string } {
  if (task.status === "open") return { reopen: false, why: "it is already open" };
  if (task.status === "dropped") {
    return { reopen: false, why: "the operator dropped it" };
  }
  if (task.status === "claimed" && task.claimedByOperator) {
    return { reopen: false, why: "the operator holds it" };
  }
  const holder = task.status === "claimed" ? task.claimedByRunId : task.completedByRunId;
  if (holder !== null && rejectedRunIds.includes(holder)) return { reopen: true };
  return {
    reopen: false,
    why:
      task.status === "claimed"
        ? "another run holds it"
        : "it was closed by the operator or by another run",
  };
}

/**
 * Reopen a task whose work a review block rejected, when `rejectedWorkReopen`
 * says so. The move's effects are `updateTask`'s re-opening ones — both run
 * columns and `closed_at` cleared — and the write is guarded on the status and
 * holder it was decided against, the operator's claim included, so a task moved
 * in between is left as it is.
 */
export function reopenRejectedTask(
  id: string,
  rejectedRunIds: readonly string[],
):
  | { ok: true; task: Task; reopened: true }
  | { ok: true; task: Task; reopened: false; why: string }
  | { ok: false; error: string } {
  const task = getTask(id);
  if (!task) return { ok: false, error: "No such task." };
  const decision = rejectedWorkReopen(task, rejectedRunIds);
  if (!decision.reopen) return { ok: true, task, reopened: false, why: decision.why };
  const changed = db()
    .prepare(
      `UPDATE tasks
          SET status = 'open', claimed_by_run_id = NULL, claimed_by_operator = 0,
              completed_by_run_id = NULL, closed_at = NULL, updated_at = ?
        WHERE id = ? AND status = ?
          AND COALESCE(claimed_by_run_id, '') = ?
          AND claimed_by_operator = ?
          AND COALESCE(completed_by_run_id, '') = ?`,
    )
    .run(
      Date.now(),
      id,
      task.status,
      task.claimedByRunId ?? "",
      task.claimedByOperator ? 1 : 0,
      task.completedByRunId ?? "",
    ).changes;
  if (changed === 0) {
    return { ok: true, task: getTask(id) ?? task, reopened: false, why: "it moved while this was deciding" };
  }
  return { ok: true, task: getTask(id)!, reopened: true };
}

/**
 * Why this actor may not set or clear `needs_frontier`, or null when it may.
 *
 * `operatorOnlyRefusal`'s rule without the claim half: anyone may mark a task
 * as beyond the local model, and only the operator may take the mark off. A
 * model clearing it would be a local run put straight back on work a frontier
 * review already turned down.
 */
export function needsFrontierRefusal(
  actor: TaskActor,
  from: boolean,
  to: boolean,
): string | null {
  if (from === to || actor.kind === "operator" || to) return null;
  return (
    "Only the operator clears needs-frontier. If a local model could do this " +
    "after all, say so in a comment and let the operator decide."
  );
}

/** A proposed change to `operator_only`, in the terms `operatorOnlyRefusal` decides on. */
export interface OperatorOnlyChange {
  actor: TaskActor;
  /** The flag as the row holds it, or null when the task is being filed. */
  from: boolean | null;
  to: boolean;
  /**
   * The status move the same write makes, read off the row — null at a create.
   * A run may set the flag only in the write that releases its claim, and this
   * is how the rule sees that write rather than taking a caller's word for it.
   */
  move: {
    from: TaskStatus;
    to: TaskStatus;
    claimedByRunId: string | null;
    claimedByOperator: boolean;
  } | null;
}

/**
 * Why this actor may not set or clear `operator_only` here, or null when it may.
 *
 * `taskTransitionRefusal`'s shape and the same kind of rule: pure, total, one
 * wording for every door. It sits beside that function rather than inside it
 * because the flag is not a status, and it answers for every door that writes
 * the flag — `createTask` and `updateTask` both ask it before they write.
 *
 *   - the operator sets and clears it on any task, at a create and at an edit.
 *   - a chat or a run may file a new task already marked.
 *   - a run may mark a task it holds, and only in the write that releases it —
 *     `release_task`. The holder check is `taskTransitionRefusal`'s own, asked
 *     here for the release the write makes, so there is one of it.
 *   - a block may do neither: it has no door that files a task, and nobody
 *     reads its turn to weigh the claim that a blocker is outside this box.
 *   - **only the operator clears it.** A model may move work into the
 *     operator's lane and never out of it — the board's "may put work on, never
 *     take it off" applied to this flag. Cleared by a model, it is a run started
 *     on something the operator was told needed them.
 *
 * Why a chat may file one marked and may not mark one already there: a chat
 * filing a task is writing down what it was just told, with the operator at the
 * keyboard; marking an existing task is a judgement that the work cannot be done
 * here, and the only actor that has earned it is the run that tried.
 */
export function operatorOnlyRefusal(change: OperatorOnlyChange): string | null {
  const { actor, from, to } = change;

  if (from === to || (from === null && !to)) return null;
  if (actor.kind === "operator") return null;

  if (!to) {
    return (
      `Only the operator clears operator-only. A ${actor.kind} may move work ` +
      `into the operator's lane and never out of it — if a run could do this ` +
      `after all, say so in a comment and let the operator decide.`
    );
  }

  if (actor.kind === "block") {
    return (
      "An orchestrator block cannot mark a task operator-only. Nobody is " +
      "reading this workflow to weigh the claim that the work cannot be done " +
      "here — say so in the block's output and let the operator decide."
    );
  }

  if (from === null) return null;

  if (actor.kind === "chat") {
    return (
      "A chat cannot mark an existing task operator-only: that the work cannot " +
      "be done in this container is for the run that tried or for the " +
      "operator to say. Write what you know on the task with comment_on_task."
    );
  }

  const move = change.move;
  if (!move || move.from !== "claimed" || move.to !== "open") {
    return (
      "A run marks a task operator-only only as it releases it: call " +
      "release_task on the task you hold, with operatorOnly set and the reason " +
      "the blocker is outside this container."
    );
  }
  return taskTransitionRefusal({
    from: move.from,
    to: move.to,
    actor,
    claimedByRunId: move.claimedByRunId,
    claimedByOperator: move.claimedByOperator,
    operatorOnly: from,
  });
}

/**
 * Why this actor may not delete a task, or null when it may.
 *
 * Its own function rather than a fifth status, because deleting is not a place
 * a task can be: it is the row going away, and the board is the operator's
 * backlog. Every other actor here reaches this table through a model's decision
 * and none of them may destroy a row a person wrote — `dropped` is what a
 * machine's "this should not happen" looks like, and it is still on the board.
 */
export function taskDeletionRefusal(actor: TaskActor): string | null {
  if (actor.kind === "operator") return null;
  return (
    `Only the operator deletes a task. A ${actor.kind} that thinks a task ` +
    `should not happen asks for it to be dropped, which leaves the row on the ` +
    `board where somebody can disagree with it.`
  );
}

/** Enough of a run id to name it in a sentence, `agentRefusal`'s clip. */
function short(id: string): string {
  return id.slice(0, 8);
}

/* ------------------------------------------------------------------ */
/* Naming a task from somewhere else — pure                            */
/* ------------------------------------------------------------------ */

/**
 * The two fields a refusal is written from, which is all a caller naming a
 * task needs to be told about it.
 *
 * `AgentFacts`' shape and its reason: the whole row is not what decides whether
 * an id may be named, and passing one would make every caller of the rule below
 * carry a `Task`.
 */
export interface TaskFacts {
  title: string;
  status: TaskStatus;
  /** Refused in `taskIds`: a run linked to it would claim it. */
  operatorOnly: boolean;
  /** Refused in `taskIds` for a local-model run. See `readTaskLinks`. */
  needsFrontier: boolean;
  /** Refused in `taskIds`: the operator is doing it themselves. */
  claimedByOperator: boolean;
}

/**
 * Why this id may not be named as the task a run is for, or null when it may.
 *
 * Pure, `agentRefusal`'s shape and its reason: three doors name a task from
 * outside this module — `propose_run`, an orchestrator block's `emit_runs`, and
 * whatever run 4/4 gives a work cycle — and one wording is what stops them
 * disagreeing about an id that is not there.
 *
 * **An unknown id is refused rather than dropped.** The failure it closes is the
 * quiet one: a proposal that said "for the flaky-auth task" and silently carried
 * no task is bit-for-bit a proposal that named none, and the operator approves a
 * card whose provenance line is simply absent. That is `agentRefusal`'s own
 * argument, and it applies here with a smaller consequence and the same shape.
 *
 * **A closed task is not refused**, and the asymmetry with `agentRefusal` is
 * deliberate. An agent that has gone changes *what the run is*; a task that is
 * `done` or `dropped` changes nothing about the run at all — the link is a
 * record of what prompted the work, and refusing it here would be this function
 * deciding on the operator's behalf that work off a closed task may not happen.
 * What the caller gets instead is the status, said back in the tool's own reply,
 * so a model that named a dropped task can see that it did.
 */
export function taskRefusal(
  taskId: string,
  knowledge: ReadonlyMap<string, TaskFacts>,
  /**
   * Whether the caller could have left the id out. True for the one door that
   * reads it off an optional list — a proposal's or an emission's `taskIds` —
   * where "a run that names no task is the ordinary run" is true. False where
   * the id is the point of the call (`get_task`, `comment_on_task`,
   * `add_task_dependency`): "or leave it out" there is advice the tool cannot
   * take.
   */
  options: { mayOmit?: boolean } = {},
): string | null {
  if (knowledge.has(taskId)) return null;
  const refusal = `No task with id "${taskId}" is on the board. Call list_tasks for the ids`;
  return options.mayOmit === false
    ? `${refusal}.`
    : `${refusal}, or leave it out — a run that names no task is the ordinary run.`;
}

/** Characters in a task id: `randomUUID()`, hyphens included. */
export const TASK_ID_LENGTH = 36;

const TASK_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Longest stretch of a refused id a sentence echoes back. */
const MAX_ECHOED_TASK_ID = 40;

/**
 * Why this string cannot be a task id, or null when it is shaped like one.
 *
 * Pure, and it decides **nothing about the board**: it is asked before any
 * lookup, and its answer is the same on every install and for every id of the
 * same shape. That is the whole of why a work cycle may be told it — a run's
 * refusals for "not yours" and "not there" are one sentence so that they cannot
 * be used to probe which ids exist (`taskVisibleToRun`), and a sentence about an
 * id's *length* gives a prober nothing. It is also the only refusal that points
 * at the real cause of the commonest mistake: an id cut to its first eight
 * characters, copied out of a brief that abbreviated it. Looked up as written,
 * that id is on no row, and every other refusal here would tell the caller it
 * is out of scope or not on the board, which sends it to re-read the wrong
 * list. A shortened id is never matched to a task — resolving a prefix is a
 * guess about which task was meant, made on a surface that writes.
 *
 * Lowercase only, because `randomUUID` writes lowercase and the lookup is a
 * case-sensitive `WHERE id = ?`: admitting an upper-case id here would let it
 * through to a miss whose sentence names the wrong cause.
 */
export function taskIdShapeRefusal(taskId: string): string | null {
  if (TASK_ID_SHAPE.test(taskId)) return null;
  if (taskId.length === 0) {
    return `A task id is ${TASK_ID_LENGTH} characters and this one is empty.`;
  }
  const seen =
    taskId.length > MAX_ECHOED_TASK_ID ? `${taskId.slice(0, MAX_ECHOED_TASK_ID)}…` : taskId;
  const form = "lowercase hex digits in groups of 8-4-4-4-12, joined by hyphens";
  return taskId.length === TASK_ID_LENGTH
    ? `"${seen}" is ${TASK_ID_LENGTH} characters but is not shaped like a task id: ${form}.`
    : `"${seen}" is ${taskId.length} characters; a task id is ${TASK_ID_LENGTH}: ${form}. ` +
        "A shortened id is never matched to a task.";
}

/**
 * Characters a title needs before a brief quoting it counts as naming the task.
 *
 * Below this a title is a phrase an unrelated brief can contain by accident —
 * "Update the README" — and a refusal it caused would teach a model to reword
 * text rather than to link work. Every title the run briefs that bundled tasks
 * quoted was longer than twice this.
 */
export const MIN_MENTIONED_TITLE = 24;

/**
 * One spelling for text a model copied: case, curly quotes, backticks, the
 * `&amp;` a filed title can carry, and runs of whitespace are not differences.
 */
function mentionForm(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[“”„]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/`/g, "")
    .replace(/\s+/g, " ");
}

const UUID_PREFIX = /^[0-9a-f]{8}$/;

/**
 * The open or claimed tasks this text names, by id or by title, in board order.
 *
 * An id counts whole or by its first eight characters standing alone, because
 * that is how a person and a model both abbreviate one. A title counts when the
 * whole of it appears, and only past `MIN_MENTIONED_TITLE`. Closed tasks are
 * never reported: naming finished work is context, not a claim to do it.
 */
export function tasksMentionedIn(
  text: string,
  knowledge: ReadonlyMap<string, TaskFacts>,
): Array<{ id: string; title: string }> {
  const haystack = mentionForm(text);
  const found: Array<{ id: string; title: string }> = [];
  for (const [id, facts] of knowledge) {
    if (facts.status !== "open" && facts.status !== "claimed") continue;
    const lowerId = id.toLowerCase();
    const prefix = lowerId.slice(0, 8);
    const byId =
      haystack.includes(lowerId) ||
      (UUID_PREFIX.test(prefix) &&
        new RegExp(`(?<![0-9a-f])${prefix}(?![0-9a-f])`).test(haystack));
    const title = mentionForm(facts.title).trim();
    const byTitle = title.length >= MIN_MENTIONED_TITLE && haystack.includes(title);
    if (byId || byTitle) found.push({ id, title: facts.title });
  }
  return found;
}

/** What a proposal or an emission said about the tasks its run is for. */
export type TaskLinkReading =
  | { ok: true; taskIds: string[] }
  | { ok: false; reason: string };

/**
 * Read `taskIds` and `relatedTaskIds` off a proposal or a spec, refusing a brief
 * that names board work its run would not be linked to.
 *
 * **The last check is why this function exists.** A run claims the tasks it is
 * linked to when it starts and `complete_task` refuses every other, so a task
 * written into a brief and left out of the link is work the run does and the
 * board never hears about: it stays open, with nothing anywhere saying why.
 * That happened to ten tasks in one batch, and to a dozen more before it, every
 * time a chat bundled "Board tasks A, B and C" into one run and linked A. So a
 * brief naming an open or claimed task — by id or by whole title — must account
 * for it: in `taskIds` if this run is to do it, in `relatedTaskIds` if it is
 * only context. Refused rather than linked automatically, because "do not touch
 * the task another run holds" names a task too, and a claim written off that
 * sentence would be this app deciding what the run is for.
 *
 * `taskId`, the single field this replaced, is refused by name: a caller still
 * sending it would otherwise believe it linked something.
 *
 * `text` is everything the run will be handed — title, brief, prompt override.
 */
export function readTaskLinks(
  fields: { taskIds?: unknown; relatedTaskIds?: unknown; taskId?: unknown },
  text: string,
  knowledge: ReadonlyMap<string, TaskFacts>,
  /**
   * Whether the run these links are for goes to the local model. A task marked
   * needs-frontier is refused for one by name, where the refusal can still be
   * acted on, rather than claimed by a run that will be set aside again.
   */
  opts: { localRun?: boolean } = {},
): TaskLinkReading {
  if (fields.taskId !== undefined && fields.taskId !== null) {
    return {
      ok: false,
      reason:
        "taskId was replaced by taskIds, a list: name every board task this " +
        "run is for there.",
    };
  }

  const taskIds = idList(fields.taskIds, "taskIds");
  if (!taskIds.ok) return taskIds;
  const related = idList(fields.relatedTaskIds, "relatedTaskIds");
  if (!related.ok) return related;

  // `MAX_RUN_TASKS` because that is what `list_my_tasks` shows of what a run
  // holds: a run linked to more could claim a task it is never shown.
  if (taskIds.ids.length > MAX_RUN_TASKS) {
    return {
      ok: false,
      reason:
        `One run may be for at most ${MAX_RUN_TASKS} tasks and this names ` +
        `${taskIds.ids.length}. Split the work across runs.`,
    };
  }

  for (const id of [...taskIds.ids, ...related.ids]) {
    const problem = taskRefusal(id, knowledge);
    if (problem) return { ok: false, reason: problem };
  }

  // Refused here rather than left to the claim, which would refuse it too: a
  // claim refusal is a log line on a run that has already started, so the run
  // would be spent on work the operator marked as theirs. `relatedTaskIds` is
  // the way out, and the mention check below still holds a brief that names
  // one to account for it.
  const reserved = taskIds.ids.find((id) => knowledge.get(id)?.operatorOnly);
  if (reserved) {
    return {
      ok: false,
      reason:
        `“${knowledge.get(reserved)?.title ?? reserved}” (${reserved}) is ` +
        "marked operator-only: it needs something no run in this container " +
        "has, so no run may claim it. Take it out of taskIds. If the brief " +
        "only mentions it, put it in relatedTaskIds; if a run should work it " +
        "after all, the operator clears the mark on the board first.",
    };
  }

  // The same refusal for the same reason: a run linked to a task the operator
  // holds would start, fail to claim it, and do the work anyway.
  const operatorHeld = taskIds.ids.find((id) => knowledge.get(id)?.claimedByOperator);
  if (operatorHeld) {
    return {
      ok: false,
      reason:
        `“${knowledge.get(operatorHeld)?.title ?? operatorHeld}” (${operatorHeld}) ` +
        "is held by the operator, who is doing it themselves, so no run may " +
        "claim it. Take it out of taskIds. If the brief only mentions it, put it " +
        "in relatedTaskIds; if a run should work it, the operator releases it on " +
        "the board first.",
    };
  }

  const frontier = opts.localRun
    ? taskIds.ids.find((id) => knowledge.get(id)?.needsFrontier)
    : undefined;
  if (frontier) {
    return {
      ok: false,
      reason:
        `“${knowledge.get(frontier)?.title ?? frontier}” (${frontier}) is marked ` +
        "needs-frontier: a local model's work on it was already rejected by a " +
        "frontier review, so no local-model run may take it on. Leave it out, or " +
        "name it in relatedTaskIds if the brief only mentions it.",
    };
  }

  const both = taskIds.ids.find((id) => related.ids.includes(id));
  if (both) {
    return {
      ok: false,
      reason:
        `“${knowledge.get(both)?.title ?? both}” is in both taskIds and ` +
        "relatedTaskIds. It is either work this run does or context it is " +
        "told about, not both.",
    };
  }

  const accounted = new Set([...taskIds.ids, ...related.ids]);
  const unlinked = tasksMentionedIn(text, knowledge).filter((t) => !accounted.has(t.id));
  if (unlinked.length > 0) {
    return {
      ok: false,
      reason:
        "The brief names board tasks this run is not linked to: " +
        `${unlinked.map((t) => `“${t.title}” (${t.id})`).join(", ")}. A run ` +
        "claims only the tasks in taskIds and can close only those, so a task " +
        "left out stays open on the board after the run has done the work. " +
        "Put every task this run is to work in taskIds. A task named only as " +
        "context — one this run must not work — goes in relatedTaskIds.",
    };
  }

  return { ok: true, taskIds: taskIds.ids };
}

/** A list of ids off the wire, trimmed and de-duplicated in order. */
function idList(
  raw: unknown,
  field: string,
): { ok: true; ids: string[] } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) return { ok: true, ids: [] };
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
    return { ok: false, reason: `${field} has to be a list of task ids from list_tasks.` };
  }
  const ids = [...new Set((raw as string[]).map((id) => id.trim()).filter(Boolean))];
  return { ok: true, ids };
}

/**
 * The board as a caller naming a task sees it: id to the two fields above.
 *
 * The impure half `taskRefusal` is kept clean of, `currentAgentKnowledge`'s
 * split. Every row rather than a page of one, because this answers "is this id
 * on the board" and a page would answer it wrongly for anything past the page.
 */
export function currentTaskKnowledge(): Map<string, TaskFacts> {
  const rows = db()
    .prepare(
      "SELECT id, title, status, operator_only, needs_frontier, claimed_by_operator FROM tasks",
    )
    .all() as Array<{
    id: string;
    title: string;
    status: string;
    operator_only: number;
    needs_frontier: number;
    claimed_by_operator: number;
  }>;
  return new Map(
    rows.map((row) => [
      row.id,
      {
        title: row.title,
        status: isTaskStatus(row.status) ? row.status : ("open" as TaskStatus),
        operatorOnly: row.operator_only === 1,
        needsFrontier: row.needs_frontier === 1,
        claimedByOperator: row.claimed_by_operator === 1,
      },
    ]),
  );
}

/* ------------------------------------------------------------------ */
/* Validation at the door                                              */
/* ------------------------------------------------------------------ */

/** Characters of a title. A title is a line; the brief is the `body`. */
export const MAX_TASK_TITLE = 200;

/**
 * Characters of a brief.
 *
 * It is a prompt-shaped field — a future agent is handed it as the whole of
 * what it knows — so the ceiling is `runs.prompt`-shaped rather than
 * label-shaped. What it bounds is one row of a table nothing sweeps.
 */
export const MAX_TASK_BODY = 20_000;

/**
 * The title and the brief, trimmed, or the one sentence saying why not.
 *
 * Shared by the create door and by `updateTask` rather than written at each,
 * because they are the same rule and two copies of a refusal are two wordings
 * that drift — an edit that loosened one would leave the other refusing what
 * its neighbour accepts, which is a board that takes a task on one press and
 * refuses the same text on the next.
 */
function readText(
  field: "title" | "body",
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  const value = String(raw ?? "").trim();
  const max = field === "title" ? MAX_TASK_TITLE : MAX_TASK_BODY;

  if (!value) {
    return {
      ok: false,
      error:
        field === "title"
          ? "A task needs a title."
          : "A task needs a body. It is the brief an agent is handed months " +
            "from now with nothing else to go on, and a title alone is not one.",
    };
  }
  if (value.length > max) {
    return {
      ok: false,
      error:
        field === "title"
          ? `A task title is at most ${max} characters. The brief goes in the body.`
          : `A task body is at most ${max} characters.`,
    };
  }
  return { ok: true, value };
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  // `includes` rather than `in`, which walks the prototype chain and would
  // answer yes to `constructor` — `isRunStatus`' reason, for a value that
  // likewise arrives off a query string.
  return TASK_STATUSES.includes(value as TaskStatus);
}

export function isTaskPriority(value: unknown): value is TaskPriority {
  return TASK_PRIORITIES.includes(value as TaskPriority);
}

export function isTaskOrigin(value: unknown): value is TaskOrigin {
  return TASK_ORIGINS.includes(value as TaskOrigin);
}

/**
 * Prove a `mount_id`/`folder` pair against the app's own mount list.
 *
 * **Nullable together is the rule, and half a pair is refused rather than
 * stored.** A row carrying a folder and no mount is a path this app cannot say
 * which root it was proved inside, and a row carrying a mount and no folder is
 * a project claim with nothing under it; both would read as a valid task and
 * neither would answer the one query the pair exists for.
 *
 * The resolution is `resolveWorkspaceFolder`, unchanged and not re-implemented,
 * which is where `docs/agent/security.md`'s two containment checks live — the
 * lexical one before any syscall and the second after `realpathSync`, because a
 * symlink inside a mount can still point out of it. Reusing it is what keeps a
 * task's folder the same kind of proved path a run's is, and what stops a
 * second, looser resolver existing in this app at all. What is stored is the
 * canonical absolute path it returns, so a work cycle asking "tasks for the
 * folder I am in" compares two values that were resolved the same way.
 *
 * This is the one part of the door that touches the filesystem. A mount that is
 * absent right now refuses the task with the sentence `resolveInMount` wrote,
 * which names the mount and the path — the same refusal the new-run form shows.
 *
 * Exported for the one *reader* that has to canonicalise a folder rather than
 * be handed one: a loop block's board condition holds a path within its mount,
 * where every other caller is already comparing the absolute path this returned
 * when the task was filed. Reusing this is what keeps the two sides of that
 * comparison resolved the same way, which is the whole of why the condition
 * counts anything at all.
 */
export function resolveTaskFolder(
  rawMountId: unknown,
  rawFolder: unknown,
): { ok: true; mountId: string | null; folder: string | null } | { ok: false; error: string } {
  const mountId = rawMountId === null || rawMountId === undefined ? "" : String(rawMountId).trim();
  const folder = rawFolder === null || rawFolder === undefined ? "" : String(rawFolder).trim();

  if (!mountId && !folder) return { ok: true, mountId: null, folder: null };

  if (!mountId || !folder) {
    return {
      ok: false,
      error:
        `A task names a mount and a folder together or neither. This one has ` +
        `${mountId ? `mount "${mountId}" and no folder` : `folder "${folder}" and no mount`}. ` +
        `Leave both out for a task that is not tied to a project.`,
    };
  }

  try {
    return { ok: true, mountId, folder: resolveWorkspaceFolder(folder, mountId) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Read a task off the wire, refusing anything the board could not answer for.
 *
 * `normalizeAgentInput`'s shape: it never throws, and every refusal names
 * something the asker can change, because three different doors have to be able
 * to show it — a form, a chat tool's error and a work cycle's tool result.
 *
 * Three fields are refused *by name* rather than ignored, and they are the ones
 * a caller could plausibly send. `origin` and `createdByRunId` come from the
 * `TaskCreation` the caller supplies, never from the body: an origin off the
 * wire is a chat turn able to file work as though a person had typed it, which
 * is the single distinction that column exists to hold. `status` is refused
 * because a task is filed **open** — there is no such thing as filing work that
 * is already done, and a create that could set a terminal status would be a
 * route around `taskTransitionRefusal` that no test of that function would ever
 * see. Refused rather than dropped, on `normalizeAgentInput`'s grounds: a
 * caller whose field was silently ignored believes it took effect.
 */
export function normalizeTaskInput(
  raw: unknown,
  creation: TaskCreation,
): TaskNormalization {
  const o = (raw ?? {}) as Record<string, unknown>;

  for (const field of ["origin", "createdByRunId", "status"] as const) {
    if (o[field] === undefined || o[field] === null) continue;
    return { ok: false, error: refusedField(field) };
  }

  const title = readText("title", o.title);
  if (!title.ok) return { ok: false, error: title.error };

  const body = readText("body", o.body);
  if (!body.ok) return { ok: false, error: body.error };

  // Absent is `normal`, which is the only default that says nothing: a missing
  // priority meaning `high` or `low` would be this app deciding on the
  // operator's behalf how much a task they never ranked matters.
  const rawPriority = o.priority === undefined || o.priority === null ? "normal" : o.priority;
  if (!isTaskPriority(rawPriority)) {
    return { ok: false, error: unknownValue("priority", rawPriority, TASK_PRIORITIES) };
  }

  const folder = resolveTaskFolder(o.mountId, o.folder);
  if (!folder.ok) return { ok: false, error: folder.error };

  const parentTaskId =
    o.parentTaskId === undefined || o.parentTaskId === null
      ? null
      : String(o.parentTaskId).trim() || null;

  // Absent is agent work, which is what every task filed before the flag
  // existed was. Who may file one marked is `operatorOnlyRefusal`, asked by
  // `createTask` so the rule is not a property of this door alone.
  const operatorOnly =
    o.operatorOnly === undefined || o.operatorOnly === null ? false : o.operatorOnly;
  if (typeof operatorOnly !== "boolean") {
    return { ok: false, error: notAFlag(operatorOnly) };
  }

  return {
    ok: true,
    value: {
      title: title.value,
      body: body.value,
      priority: rawPriority,
      origin: creation.origin,
      mountId: folder.mountId,
      folder: folder.folder,
      createdByRunId: creation.createdByRunId,
      parentTaskId,
      operatorOnly,
    },
  };
}

/**
 * Refused rather than coerced: `"false"` is truthy, so a coercion would mark a
 * task operator-only when the caller said the opposite.
 */
function notAFlag(seen: unknown): string {
  return `operatorOnly must be true or false; got ${JSON.stringify(seen)}.`;
}

/** Why a field that is recorded rather than claimed cannot be sent. */
function refusedField(field: "origin" | "createdByRunId" | "status"): string {
  if (field === "status") {
    return (
      "A task is filed open. A status cannot be set when the task is created — " +
      "moving one is a separate decision with its own rule about who may make " +
      "it, and a create that carried a status would go around that rule."
    );
  }
  return (
    `A task's ${field} is recorded, not claimed: it comes from whoever is ` +
    `filing the task and never from the request. Remove it.`
  );
}

/** "Unknown x: y. Expected one of …" — the shape every refusal here takes. */
function unknownValue(field: string, seen: unknown, allowed: readonly string[]): string {
  return (
    `Unknown task ${field}: ${JSON.stringify(seen)}. Expected one of ` +
    `${allowed.join(", ")}.`
  );
}

/**
 * Read an edit off the wire, narrowing every closed set before it reaches the
 * row.
 *
 * The half of the door `normalizeTaskInput` is the other half of, and the
 * asymmetry between them is deliberate. A create refuses `status` outright,
 * because a task is filed open; an edit is where a status legitimately arrives,
 * and an unknown one is a **400** rather than a value dropped — `/api/runs`'
 * rule, that a parameter deciding which rows exist must never widen quietly.
 * Dropping an unrecognised status would answer "mark this done" with a silent
 * no-op and a 200, which reads exactly like a board that worked.
 *
 * An absent key is "leave it alone" throughout, which is why every field is
 * tested against `undefined` and never against falsiness: `null` is a real
 * value on `mountId`, `folder` and `parentTaskId`, and `""` on a title is a
 * refusal rather than a no-op.
 *
 * `origin` and `createdByRunId` are refused here for the reason they are
 * refused at a create — they record how a row came to exist, and an edit that
 * could rewrite them would let a chat turn relabel its own task as the
 * operator's. `completedByRunId` and `claimedByRunId` are not on this list at
 * all: they are written by the transition, never by a patch, so a body naming
 * one is refused as an unknown field would be — by having no effect and no way
 * to reach the row.
 */
export function normalizeTaskPatch(
  raw: unknown,
): { ok: true; value: TaskPatch } | { ok: false; error: string } {
  const o = (raw ?? {}) as Record<string, unknown>;
  const patch: TaskPatch = {};

  for (const field of ["origin", "createdByRunId"] as const) {
    if (o[field] === undefined || o[field] === null) continue;
    return { ok: false, error: refusedField(field) };
  }

  if (o.title !== undefined) patch.title = String(o.title ?? "");
  if (o.body !== undefined) patch.body = String(o.body ?? "");

  if (o.priority !== undefined) {
    if (!isTaskPriority(o.priority)) {
      return { ok: false, error: unknownValue("priority", o.priority, TASK_PRIORITIES) };
    }
    patch.priority = o.priority;
  }

  if (o.status !== undefined) {
    if (!isTaskStatus(o.status)) {
      return { ok: false, error: unknownValue("status", o.status, TASK_STATUSES) };
    }
    patch.status = o.status;
  }

  if (o.claimRunId !== undefined) {
    patch.claimRunId = o.claimRunId === null ? null : String(o.claimRunId);
  }

  // The pair moves together: naming either one asks for both to be re-proved,
  // which is what stops an edit leaving a folder behind under a new mount.
  if (o.mountId !== undefined) patch.mountId = o.mountId === null ? null : String(o.mountId);
  if (o.folder !== undefined) patch.folder = o.folder === null ? null : String(o.folder);

  if (o.parentTaskId !== undefined) {
    patch.parentTaskId = o.parentTaskId === null ? null : String(o.parentTaskId);
  }

  if (o.operatorOnly !== undefined) {
    if (typeof o.operatorOnly !== "boolean") {
      return { ok: false, error: notAFlag(o.operatorOnly) };
    }
    patch.operatorOnly = o.operatorOnly;
  }

  if (o.needsFrontier !== undefined) {
    if (typeof o.needsFrontier !== "boolean") {
      return {
        ok: false,
        error: `needsFrontier must be true or false; got ${JSON.stringify(o.needsFrontier)}.`,
      };
    }
    patch.needsFrontier = o.needsFrontier;
  }

  return { ok: true, value: patch };
}

/* ------------------------------------------------------------------ */
/* Reading the board                                                   */
/* ------------------------------------------------------------------ */

/** Rows a board request gets when it names no size, or names an unreadable one. */
const DEFAULT_TASK_PAGE = 100;

export interface TaskListQuery {
  /** Rows to skip. Clamped into the list rather than refused. */
  offset?: number;
  /** Rows to take. Absent, zero, negative or unreadable is `DEFAULT_TASK_PAGE`. */
  limit?: number;
  /** One status, or null for every status. Narrowed by the caller. */
  status?: TaskStatus | null;
  /** One origin, or null for every origin. Narrowed by the caller. */
  origin?: TaskOrigin | null;
  /** One priority, or null for every priority. Narrowed by the caller. */
  priority?: TaskPriority | null;
  /** A mount id, matched exactly against the column. */
  mountId?: string | null;
  /** A canonical absolute folder, matched exactly against the column. */
  folder?: string | null;
  /** Only operator-only tasks, only agent work, or null for both. */
  operatorOnly?: boolean | null;
  /**
   * Whether `folder` also matches everything filed under it.
   *
   * Off by default, which is how the board itself groups a project: a task on
   * `…/terraServe/docs` is not a task on `…/terraServe`. Anything but `true`
   * reads as off, so a caller that says nothing gets the exact match it always
   * got.
   */
  includeSubfolders?: boolean;
}

/** A board request in the terms the query below is written in. */
export interface TaskListFilters {
  offset: number;
  limit: number;
  status: TaskStatus | null;
  origin: TaskOrigin | null;
  priority: TaskPriority | null;
  mountId: string | null;
  folder: string | null;
  operatorOnly: boolean | null;
  includeSubfolders: boolean;
}

export interface TaskListPage {
  tasks: Task[];
  /** Tasks matching the filter, counted over the table rather than the page. */
  total: number;
  /** Where this page starts, after the clamp below. */
  offset: number;
  /** The page size actually applied, after `MAX_TASK_PAGE`. */
  limit: number;
}

/**
 * What a board request actually asks for.
 *
 * Pure, and separated from the query for `normalizeRunListQuery`'s reason: every
 * value arrives off a query string, so every one can be missing, blank, a word
 * or a negative number, and each wrong answer is a board that looks like an
 * answer rather than an error. A limit that is missing, zero, negative or
 * unreadable is the ordinary page rather than the smallest legal one, because a
 * one-row board is a far worse answer to a typo.
 *
 * `status`, `origin` and `priority` arrive already narrowed — the route refuses
 * an unknown one with a 400 rather than dropping it, on `/api/runs`' rule that a
 * parameter deciding *which rows exist* must not silently widen. `mountId` and
 * `folder` are matched against the stored columns and are deliberately **not**
 * re-resolved here: the folder a caller filters on is the canonical path the
 * board already handed it, and a second resolution on a read path would make
 * listing a board fail when a mount is briefly absent.
 */
export function normalizeTaskListQuery(query: TaskListQuery = {}): TaskListFilters {
  const askedLimit = Math.floor(Number(query.limit));
  const limit =
    Number.isFinite(askedLimit) && askedLimit > 0
      ? Math.min(MAX_TASK_PAGE, askedLimit)
      : DEFAULT_TASK_PAGE;

  const askedOffset = Math.floor(Number(query.offset));
  const offset = Number.isFinite(askedOffset) && askedOffset > 0 ? askedOffset : 0;

  const mountId = (query.mountId ?? "").trim();
  const folder = (query.folder ?? "").trim();

  return {
    offset,
    limit,
    status: query.status ?? null,
    origin: query.origin ?? null,
    priority: query.priority ?? null,
    mountId: mountId || null,
    folder: folder || null,
    operatorOnly: typeof query.operatorOnly === "boolean" ? query.operatorOnly : null,
    // `=== true` rather than truthiness: a stored condition written before the
    // field existed carries `undefined` here, and the exact match is what it
    // meant.
    includeSubfolders: query.includeSubfolders === true,
  };
}

/**
 * An offset past the end, pulled back onto the last page.
 *
 * `clampRunOffset`'s decision: clamped rather than refused, because that is
 * what pressing Next on a board which shrank under you produces.
 */
export function clampTaskOffset(offset: number, total: number): number {
  return Math.min(Math.max(0, Math.floor(offset) || 0), Math.max(0, total - 1));
}

/* ------------------------------------------------------------------ */
/* Storage — the only module that touches the table                    */
/* ------------------------------------------------------------------ */

interface TaskRow {
  id: string;
  title: string;
  body: string;
  status: string;
  priority: string;
  origin: string;
  mount_id: string | null;
  folder: string | null;
  created_by_run_id: string | null;
  claimed_by_run_id: string | null;
  claimed_by_operator: number;
  completed_by_run_id: string | null;
  parent_task_id: string | null;
  operator_only: number;
  needs_frontier: number;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

const COLUMNS = `id, title, body, status, priority, origin, mount_id, folder,
  created_by_run_id, claimed_by_run_id, claimed_by_operator, completed_by_run_id,
  parent_task_id, operator_only, needs_frontier, created_at, updated_at, closed_at`;

/**
 * A stored row as the rest of the app sees it.
 *
 * Pure — it takes the row rather than reading one — and it has a job beyond
 * renaming columns, `rowToAgent`'s: a row outlives the build that wrote it. A
 * status, priority or origin this build does not recognise is read as the
 * safest thing it could have meant rather than passed through, because every
 * reader downstream is typed against the closed set and would otherwise carry a
 * word no `switch` has a case for. `open` and `normal` are those defaults: an
 * unreadable status showing as open puts the task back in front of somebody,
 * where showing it as done would hide it.
 */
export function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    status: isTaskStatus(row.status) ? row.status : "open",
    priority: isTaskPriority(row.priority) ? row.priority : "normal",
    origin: isTaskOrigin(row.origin) ? row.origin : "operator",
    mountId: row.mount_id,
    folder: row.folder,
    createdByRunId: row.created_by_run_id,
    claimedByRunId: row.claimed_by_run_id,
    claimedByOperator: row.claimed_by_operator === 1,
    completedByRunId: row.completed_by_run_id,
    parentTaskId: row.parent_task_id,
    operatorOnly: row.operator_only === 1,
    needsFrontier: row.needs_frontier === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

export function getTask(id: string): Task | null {
  const row = db()
    .prepare(`SELECT ${COLUMNS} FROM tasks WHERE id = ?`)
    .get(id) as TaskRow | undefined;
  return row ? rowToTask(row) : null;
}

/**
 * A stored folder as the literal half of a `LIKE`.
 *
 * `likeNeedle` in `orchestrator.ts` escapes the same three characters for the
 * same reason, and this one differs only in being anchored: it is a prefix, so
 * it is not wrapped in `%` on the left. Both `%` and `_` are ordinary
 * characters in a directory name, and unescaped a project called `a_b` would
 * count `axb`'s tasks as its own.
 */
function likePrefix(folder: string): string {
  return folder.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * A run's search text as a `LIKE` needle matching anywhere in a column.
 *
 * `likePrefix`'s escape, unanchored at both ends. A run searching for `100%` or
 * `snake_case` is looking for the task that says so, and the wildcards left in
 * would answer with tasks that hold neither — a list that reads as "already
 * filed" for work nobody wrote down.
 */
function likeContains(text: string): string {
  return `%${likePrefix(text)}%`;
}

/**
 * One page of the board.
 *
 * The order is the board's: priority first, then the most recently moved. It is
 * a `CASE` over the priority word rather than an indexed column, and the reason
 * is written out beside `idx_tasks_board` in `db.ts` — an index on the stored
 * word would supply a lexical order that is not this one, which is worse than
 * no index at all. `id` breaks the final tie so two tasks written in the same
 * millisecond cannot swap places between two reads of the same page.
 *
 * **The subtree match carries the separator, and that is the whole of it.**
 * `folder LIKE '/workspace/UsageFoundry%'` also matches
 * `/workspace/UsageFoundryWeb`, which is a different project with a different
 * backlog — and the failure is silent in the direction that keeps a loop
 * running, since a project counted too full never reaches the number it was
 * told to stop at.
 */
export function listTasks(query: TaskListQuery = {}): TaskListPage {
  const filters = normalizeTaskListQuery(query);

  const where: string[] = [];
  const args: unknown[] = [];
  if (filters.status) {
    where.push("status = ?");
    args.push(filters.status);
  }
  if (filters.origin) {
    where.push("origin = ?");
    args.push(filters.origin);
  }
  if (filters.priority) {
    where.push("priority = ?");
    args.push(filters.priority);
  }
  if (filters.mountId) {
    where.push("mount_id = ?");
    args.push(filters.mountId);
  }
  if (filters.operatorOnly !== null) {
    where.push("operator_only = ?");
    args.push(filters.operatorOnly ? 1 : 0);
  }
  if (filters.folder) {
    if (filters.includeSubfolders) {
      where.push("(folder = ? OR folder LIKE ? ESCAPE '\\')");
      args.push(filters.folder, `${likePrefix(filters.folder + path.sep)}%`);
    } else {
      where.push("folder = ?");
      args.push(filters.folder);
    }
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = (
    db()
      .prepare(`SELECT COUNT(*) AS n FROM tasks ${clause}`)
      .get(...args) as { n: number }
  ).n;

  const offset = clampTaskOffset(filters.offset, total);
  const rows = db()
    .prepare(
      `SELECT ${COLUMNS} FROM tasks ${clause}
         ORDER BY ${PRIORITY_RANK_SQL}, updated_at DESC, id
         LIMIT ? OFFSET ?`,
    )
    .all(...args, filters.limit, offset) as TaskRow[];

  return { tasks: rows.map(rowToTask), total, offset, limit: filters.limit };
}

/**
 * How many rows either half of a run's own view of the board may carry.
 *
 * Far below `MAX_TASK_PAGE`, and the difference is who reads it. The board's
 * page is drawn for a person who scrolls; this is a tool result a work cycle
 * pays for by the token on every cycle that calls it, inside a context the
 * pruner already spends money keeping down. A run does not need the backlog —
 * it needs the task it is holding and enough of what is open beside it to file
 * a duplicate-free one.
 */
export const MAX_RUN_TASKS = 20;

/** What a work cycle may see of the board: its own, and what is open beside it. */
export interface RunTasks {
  /** Every task this run's row is claimed by, whatever status it now has. */
  held: Task[];
  /** Open tasks filed against the folder the run is working in, matching the query if one was given. */
  openInFolder: Task[];
  /** Every row `openInFolder` was cut from, so a clip at `MAX_RUN_TASKS` is never silent. */
  openInFolderTotal: number;
}

/**
 * The board as one run sees it — not the board.
 *
 * Two queries rather than a filter on `listTasks`, because the two halves answer
 * different questions and neither is a page of the same list. `held` is keyed on
 * `claimed_by_run_id` and carries **every** status, which is deliberate: a run
 * that has already completed its task must be able to see that it did, or a
 * second `complete_task` on the same id reads as a board that lost the write.
 * `openInFolder` is what the run may file against without duplicating something
 * already written down.
 *
 * A run whose folder is null — a task tied to no project, or a run outside every
 * mount — gets an empty `openInFolder` rather than the whole board. Widening
 * "the folder I am in" to "everything" is how a tool scoped to one project
 * becomes a tool that reads the operator's entire backlog.
 *
 * The count is separate from the rows for the reason a shortened diff names the
 * files it left out: a run shown twenty of sixty open tasks and told nothing
 * files the duplicate it was reading the list to avoid.
 *
 * **The count alone did not stop that, and `query` is what does.** Nine runs on
 * one project filed the same task, each having read twenty rows beside a count
 * of 69 to 99 (`proposals/CrossSessionCommunication/00-problem.md` §3): told the
 * list was short, a run still had no way to read the rest. A query narrows
 * `openInFolder` to the open tasks in the folder whose title or brief contains
 * it, so the one matching task is found whatever its place in the board's order,
 * and `openInFolderTotal` then counts the matches. It folds case the way
 * SQLite's built-in `LIKE` does, which is ASCII only. `held` is never narrowed:
 * what a run holds is not a search result, and a run that searched for
 * something else and found its own task missing would read the claim as lost.
 */
export function tasksForRun(
  runId: string,
  folder: string | null,
  query: string | null = null,
): RunTasks {
  const held = (
    db()
      .prepare(
        `SELECT ${COLUMNS} FROM tasks
          WHERE claimed_by_run_id = ?
          ORDER BY ${PRIORITY_RANK_SQL}, updated_at DESC, id
          LIMIT ?`,
      )
      .all(runId, MAX_RUN_TASKS) as TaskRow[]
  ).map(rowToTask);

  if (!folder) return { held, openInFolder: [], openInFolderTotal: 0 };

  const where = ["status = 'open'", "folder = ?"];
  const args: unknown[] = [folder];
  if (query) {
    const needle = likeContains(query);
    where.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
    args.push(needle, needle);
  }
  const clause = where.join(" AND ");

  const openInFolderTotal = (
    db()
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${clause}`)
      .get(...args) as { n: number }
  ).n;

  const openInFolder = (
    db()
      .prepare(
        `SELECT ${COLUMNS} FROM tasks
          WHERE ${clause}
          ORDER BY ${PRIORITY_RANK_SQL}, updated_at DESC, id
          LIMIT ?`,
      )
      .all(...args, MAX_RUN_TASKS) as TaskRow[]
  ).map(rowToTask);

  return { held, openInFolder, openInFolderTotal };
}

/**
 * One task a run may read whole, or null — `tasksForRun`'s two `WHERE` clauses
 * as a predicate on one id, and nothing wider.
 *
 * The predicate rather than membership of the lists, so the open task
 * twenty-first in its folder is readable too: `openInFolderTotal` has already
 * told the run it exists, and the cap is about what a listing costs by the
 * token, not about what the run may see. What must not change is the scope
 * itself — a held task in any status, or an open one in this run's own folder —
 * because this is the door that returns a brief whole, and one that answered
 * for a claimed task in the same folder would hand a run the brief another run
 * is working from.
 *
 * The null folder is its own branch rather than left to SQL: `folder = NULL` is
 * never true, so one query would be narrow today, but "no folder" read as "no
 * filter" is the widening `tasksForRun` names, and a later `IS ?` would make it
 * without failing anything.
 *
 * One null for "not yours" and "not there", deliberately: a caller that could
 * tell them apart could probe the rest of the board for ids.
 */
export function taskVisibleToRun(
  runId: string,
  folder: string | null,
  taskId: string,
): Task | null {
  const row = (
    folder
      ? db()
          .prepare(
            `SELECT ${COLUMNS} FROM tasks
              WHERE id = ?
                AND (claimed_by_run_id = ? OR (status = 'open' AND folder = ?))`,
          )
          .get(taskId, runId, folder)
      : db()
          .prepare(`SELECT ${COLUMNS} FROM tasks WHERE id = ? AND claimed_by_run_id = ?`)
          .get(taskId, runId)
  ) as TaskRow | undefined;
  return row ? rowToTask(row) : null;
}

/**
 * File a task. Always `open`, and always with `closed_at` null.
 *
 * A `parentTaskId` that names nothing is refused rather than stored as a
 * dangling link: the column exists so a run that noticed something while
 * working another task leaves a trail back, and a trail to a row that is not
 * there is worse than none.
 */
export function createTask(input: TaskInput): TaskWriteResult {
  const flagRefusal = operatorOnlyRefusal({
    actor: filedBy(input),
    from: null,
    to: input.operatorOnly,
    move: null,
  });
  if (flagRefusal) return { ok: false, kind: "refused", error: flagRefusal };

  if (input.parentTaskId && !getTask(input.parentTaskId)) {
    return {
      ok: false,
      kind: "refused",
      error: `No such task to file this under: ${input.parentTaskId}`,
    };
  }

  const id = randomUUID();
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO tasks
         (id, title, body, status, priority, origin, mount_id, folder,
          created_by_run_id, claimed_by_run_id, completed_by_run_id,
          parent_task_id, operator_only, created_at, updated_at, closed_at)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL)`,
    )
    .run(
      id,
      input.title,
      input.body,
      input.priority,
      input.origin,
      input.mountId,
      input.folder,
      input.createdByRunId,
      input.parentTaskId,
      input.operatorOnly ? 1 : 0,
      now,
      now,
    );
  return { ok: true, task: getTask(id)! };
}

/**
 * Who is filing, as the actor the flag's rule is written against.
 *
 * Read off the origin rather than taken as a separate argument, because the
 * origin already *is* who filed it — recorded from the door, never off the
 * wire — and a second parameter would be a second answer that could disagree.
 */
function filedBy(input: TaskInput): TaskActor {
  return input.origin === "run"
    ? { kind: "run", runId: input.createdByRunId ?? "" }
    : { kind: input.origin };
}

/**
 * What an update may change.
 *
 * An absent key is "leave it", which is why every one of these is optional and
 * `null` is a real value on the three that are nullable. The mount and the
 * folder move together or not at all, so they are read as a pair here exactly
 * as they are at a create.
 */
export interface TaskPatch {
  title?: string;
  body?: string;
  priority?: TaskPriority;
  mountId?: string | null;
  folder?: string | null;
  parentTaskId?: string | null;
  status?: TaskStatus;
  /**
   * The run that will hold it when `status` moves to `claimed`. Absent from the
   * operator, it is the operator claiming the task for themselves.
   */
  claimRunId?: string | null;
  /** Who may change it is `operatorOnlyRefusal`, asked against the row. */
  operatorOnly?: boolean;
  /** Who may change it is `needsFrontierRefusal`. */
  needsFrontier?: boolean;
}

/**
 * Every column `updateTask`'s `UPDATE` sets besides `updated_at`. A column
 * added to that statement and not here is skipped whenever it is the only
 * thing a patch changes.
 */
const WRITTEN_TASK_FIELDS = [
  "title",
  "body",
  "status",
  "priority",
  "mountId",
  "folder",
  "claimedByRunId",
  "claimedByOperator",
  "completedByRunId",
  "parentTaskId",
  "operatorOnly",
  "needsFrontier",
  "closedAt",
] as const satisfies readonly (keyof Task)[];

/**
 * Edit a task, and move it if the patch says so.
 *
 * One writer rather than an `updateTask` beside a `moveTask`, because the two
 * would each need the row they are acting on and a caller sequencing them would
 * be reading it twice — with a status decided against the first read and
 * written against the second. Everything here reads the row once and the move
 * is checked against *that* row's `claimed_by_run_id`, never against one a
 * caller asserted.
 *
 * The status effects are the other half of the rule and they only fire when the
 * status actually changes:
 *
 *   - into `claimed`: the claim names its holder — the run, or the operator
 *     with no run id beside it, never both — and `closed_at` is cleared.
 *   - into `done`: `completed_by_run_id` is the acting run, or null when the
 *     operator marked it — a person is not a run and inventing one would put a
 *     run id on work no run did.
 *   - into `dropped`: `closed_at` is set and `completed_by_run_id` is left
 *     alone, because nobody completed it.
 *   - out of `claimed` into anything, the operator's claim is cleared: unlike
 *     the run column, which `tasksForRun` reads to show a run what it closed,
 *     nothing reads the operator's claim on a task that is no longer claimed,
 *     and a set flag on a closed task would be a holder the board cannot draw.
 *   - into `open`: both run columns are cleared. A task that is open while
 *     naming the run that completed it is a contradiction the board would have
 *     to explain on every surface that draws it, and a re-open is the operator
 *     saying the work is not done. The mutation itself is on the request log.
 */
export function updateTask(
  id: string,
  patch: TaskPatch,
  actor: TaskActor,
): TaskWriteResult {
  const task = getTask(id);
  if (!task) return { ok: false, kind: "missing", error: "No such task." };

  const next: Task = { ...task };

  if (patch.title !== undefined) {
    const title = readText("title", patch.title);
    if (!title.ok) return { ok: false, kind: "refused", error: title.error };
    next.title = title.value;
  }

  if (patch.body !== undefined) {
    const body = readText("body", patch.body);
    if (!body.ok) return { ok: false, kind: "refused", error: body.error };
    next.body = body.value;
  }

  // The closed sets are not re-checked here: `normalizeTaskPatch` is the door
  // every request comes through, and an internal caller is typed against them.
  if (patch.priority !== undefined) next.priority = patch.priority;

  if (patch.mountId !== undefined || patch.folder !== undefined) {
    const resolved = resolveTaskFolder(
      patch.mountId !== undefined ? patch.mountId : task.mountId,
      patch.folder !== undefined ? patch.folder : task.folder,
    );
    if (!resolved.ok) return { ok: false, kind: "refused", error: resolved.error };
    next.mountId = resolved.mountId;
    next.folder = resolved.folder;
  }

  if (patch.parentTaskId !== undefined) {
    const parent = patch.parentTaskId === null ? null : patch.parentTaskId.trim() || null;
    if (parent === id) {
      return { ok: false, kind: "refused", error: "A task cannot be filed under itself." };
    }
    if (parent && !getTask(parent)) {
      return { ok: false, kind: "refused", error: `No such task to file this under: ${parent}` };
    }
    next.parentTaskId = parent;
  }

  // Before the status, because the claim rule reads the flag as this write
  // leaves it: an operator clearing the mark and claiming in one press is a
  // claim on agent work, and one setting it and claiming is refused.
  if (patch.operatorOnly !== undefined) {
    const refusal = operatorOnlyRefusal({
      actor,
      from: task.operatorOnly,
      to: patch.operatorOnly,
      move:
        patch.status === undefined
          ? null
          : {
              from: task.status,
              to: patch.status,
              claimedByRunId: task.claimedByRunId,
              claimedByOperator: task.claimedByOperator,
            },
    });
    if (refusal) return { ok: false, kind: "refused", error: refusal };
    next.operatorOnly = patch.operatorOnly;
  }

  if (patch.needsFrontier !== undefined) {
    const refusal = needsFrontierRefusal(actor, task.needsFrontier, patch.needsFrontier);
    if (refusal) return { ok: false, kind: "refused", error: refusal };
    next.needsFrontier = patch.needsFrontier;
  }

  const now = Date.now();

  // A run claiming for itself need not name itself, which is what makes
  // `claim` a one-argument call for the actor that makes it most often.
  const claimRunId =
    (patch.claimRunId ?? (actor.kind === "run" ? actor.runId : null) ?? "").trim() || null;

  // Asked even when the status is restated rather than moved, because one
  // restatement is refused: a non-operator's claim on a task the operator holds.
  // Every other `from === to` is answered null by the rule.
  if (patch.status !== undefined) {
    const refusal = taskTransitionRefusal({
      from: task.status,
      to: patch.status,
      actor,
      claimedByRunId: task.claimedByRunId,
      claimedByOperator: task.claimedByOperator,
      claimRunId,
      operatorOnly: next.operatorOnly,
    });
    if (refusal) return { ok: false, kind: "refused", error: refusal };
  }

  if (patch.status !== undefined && patch.status !== task.status) {
    next.status = patch.status;
    next.claimedByOperator = false;
    if (patch.status === "claimed") {
      // A claim naming no run is the operator's own, which the rule above
      // allows to the operator alone.
      next.claimedByRunId = claimRunId;
      next.claimedByOperator = claimRunId === null;
      next.closedAt = null;
    } else if (patch.status === "done") {
      next.completedByRunId = actor.kind === "run" ? actor.runId : null;
      next.closedAt = now;
    } else if (patch.status === "dropped") {
      next.closedAt = now;
    } else {
      next.claimedByRunId = null;
      next.completedByRunId = null;
      next.closedAt = null;
    }
  }

  // A patch that changes nothing is not written, because the write is what
  // stamps `updated_at` and that column is the board's record that the task
  // moved. `claimTasksForRun` re-claims on every segment of a run, and each
  // re-claim used to lift every task it holds to the top of Claimed.
  if (!WRITTEN_TASK_FIELDS.some((field) => next[field] !== task[field])) {
    return { ok: true, task };
  }

  db()
    .prepare(
      `UPDATE tasks
          SET title = ?, body = ?, status = ?, priority = ?, mount_id = ?,
              folder = ?, claimed_by_run_id = ?, claimed_by_operator = ?,
              completed_by_run_id = ?, parent_task_id = ?, operator_only = ?,
              needs_frontier = ?, updated_at = ?, closed_at = ?
        WHERE id = ?`,
    )
    .run(
      next.title,
      next.body,
      next.status,
      next.priority,
      next.mountId,
      next.folder,
      next.claimedByRunId,
      next.claimedByOperator ? 1 : 0,
      next.completedByRunId,
      next.parentTaskId,
      next.operatorOnly ? 1 : 0,
      next.needsFrontier ? 1 : 0,
      now,
      next.closedAt,
      id,
    );

  return { ok: true, task: getTask(id)! };
}

/**
 * Remove a task. The operator's alone — `taskDeletionRefusal` says why.
 *
 * A child filed under it keeps its own row: the foreign key is
 * `ON DELETE SET NULL`, so what is lost is the link and never the work.
 */
export function deleteTask(id: string, actor: TaskActor): TaskWriteResult {
  const refusal = taskDeletionRefusal(actor);
  if (refusal) return { ok: false, kind: "refused", error: refusal };

  const task = getTask(id);
  if (!task) return { ok: false, kind: "missing", error: "No such task." };

  db().prepare("DELETE FROM tasks WHERE id = ?").run(id);
  return { ok: true, task };
}

/* ------------------------------------------------------------------ */
/* The link between a task and the runs started for it                 */
/* ------------------------------------------------------------------ */

/**
 * Record the tasks a run was started for, in the order they were named.
 *
 * **A record, and the whole of what the link does here.** It writes `run_tasks`
 * and moves nothing: the tasks keep the status they had, and when the run
 * finishes nothing here closes them — a run can complete and still not have
 * done the thing, so completion stays with the run that did the work, in its
 * own name, or with the operator. See `taskTransitionRefusal`. The claim is the
 * run's own, made when it starts.
 *
 * The SQL is here rather than in `createRun`, and that is a boundary rather
 * than a convenience: `orchestrator.ts` decides what a run may do and what it
 * costs, and nothing in its loop, its guards, its occupancy or its budget reads
 * this table. A run that carries task ids and one that does not are the same
 * run.
 *
 * **It is called from inside `createRun`'s transaction and from nowhere else,
 * which is a correctness rule rather than a preference.** Written by a caller
 * after `createRun` returned, it lands too late to be seen: that function ends
 * by promoting, and `startRun` reaches `claimTasksForRun` with no `await` in
 * between, so the run's own claim reads no links and files nothing — the board
 * shows `open` for work already in flight, the run's log says nothing at all,
 * and the run can then never complete those tasks, because a run may complete
 * only what was claimed in its own name. Whether it bites depends on whether the
 * run started or queued, which is exactly the kind of intermittence this file
 * exists to keep out.
 *
 * The ids are written whether or not the rows are still there. They are not
 * foreign keys for that reason — the operator may delete a task at any point —
 * and a dangling id reads as "a task since deleted", which is what
 * `tasksLinkedToRun` answers and what every surface says.
 */
export function recordRunTasks(runId: string, taskIds: readonly string[]): void {
  const insert = db().prepare(
    "INSERT OR IGNORE INTO run_tasks (run_id, task_id, position) VALUES (?, ?, ?)",
  );
  taskIds.forEach((taskId, position) => insert.run(runId, taskId, position));
}

/**
 * The tasks a run was started for, in the order they were named; empty for a
 * run that names none.
 *
 * `title` and `status` are null together where the id names nothing any more,
 * which is a third answer rather than a missing one: a run whose task was
 * deleted is not a run that never had one, and a surface that collapsed the two
 * would quietly lose the provenance the link exists to hold.
 */
export function tasksLinkedToRun(runId: string): RunTaskDTO[] {
  const rows = db()
    .prepare(
      `SELECT rt.task_id AS id, t.title AS title, t.status AS status
         FROM run_tasks rt LEFT JOIN tasks t ON t.id = rt.task_id
        WHERE rt.run_id = ?
        ORDER BY rt.position`,
    )
    .all(runId) as Array<{ id: string; title: string | null; status: string | null }>;
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status !== null && isTaskStatus(row.status) ? row.status : null,
  }));
}

/** What one board row says about the runs started for it. */
export interface TaskRunLinks {
  /** Newest first, capped at `MAX_TASK_RUN_LINKS`. */
  runIds: string[];
  /** Runs naming this task, which may exceed `runIds.length`. */
  runCount: number;
}

/**
 * The runs started for each of these tasks, in one query rather than one each.
 *
 * A board draws a hundred rows a poll, so the per-row read this replaces is the
 * N+1 the listing route would otherwise run every ten seconds. The ids are
 * capped and the count is not, for the reason a shortened diff names the files
 * it left out: a row that showed three of eleven runs and said nothing would
 * report a task worked eleven times as one worked three times.
 */
export function runLinksForTasks(
  taskIds: readonly string[],
): Map<string, TaskRunLinks> {
  const links = new Map<string, TaskRunLinks>();
  if (taskIds.length === 0) return links;

  const placeholders = taskIds.map(() => "?").join(", ");
  const rows = db()
    .prepare(
      `SELECT r.id AS id, rt.task_id AS task_id
         FROM run_tasks rt JOIN runs r ON r.id = rt.run_id
        WHERE rt.task_id IN (${placeholders})
        ORDER BY r.created_at DESC, r.id`,
    )
    .all(...taskIds) as Array<{ id: string; task_id: string }>;

  for (const row of rows) {
    const entry = links.get(row.task_id) ?? { runIds: [], runCount: 0 };
    if (entry.runIds.length < MAX_TASK_RUN_LINKS) entry.runIds.push(row.id);
    entry.runCount += 1;
    links.set(row.task_id, entry);
  }
  return links;
}

/* ------------------------------------------------------------------ */
/* The wire                                                            */
/* ------------------------------------------------------------------ */

/**
 * One task as every route answers for it.
 *
 * Here rather than in either route, `runAgentDTO`'s reason: both of them answer
 * with a task and two copies of "what a task says about its folder" would be two
 * payloads that could split the same path differently. `describeFolder` is the
 * one splitter, and it is the same one the runs list uses.
 *
 * `links` is passed rather than read, so the listing can ask about a whole page
 * in one query where the single-task route asks about one; both go through
 * `runLinksForTasks`. Absent is **no runs named this task**, which is the same
 * answer the query gives for a task nothing was started for — the two are not
 * told apart because there is nothing to tell apart: the link is written when
 * the run is created and never later.
 *
 * `commentCount` is passed for the same reason and read through
 * `commentCountsForTasks`. It is an argument rather than a call so that nothing
 * in `tasks.ts` imports `taskComments.ts`: the dependency between the two runs
 * one way, and a read here would close the loop for a number that is drawn
 * beside a row rather than decided on.
 *
 * `deps` is the third of those and `taskDeps.ts` is the third module on the
 * far side of that one-way dependency. Absent is a task with no edges either
 * way, and the empty neighbourhood is written here rather than imported for
 * exactly that reason — a `NO_TASK_DEPS` taken from `taskDeps.ts` would close
 * the loop for five zeroes. What it must never become is a *read*: the board
 * asks about a whole page in one query, and a call here would be an N+1 on a
 * ten-second poll.
 */
export function taskDTO(
  task: Task,
  links?: TaskRunLinks,
  commentCount?: number,
  deps?: TaskDepsDTO,
): TaskDTO {
  const placed = task.folder ? describeFolder(task.folder) : null;
  return {
    runIds: links?.runIds ?? [],
    runCount: links?.runCount ?? 0,
    commentCount: commentCount ?? 0,
    deps: deps ?? {
      dependsOn: [],
      dependsOnCount: 0,
      dependents: [],
      dependentCount: 0,
      blockedByCount: 0,
    },
    id: task.id,
    title: task.title,
    body: task.body,
    status: task.status as TaskStatusDTO,
    priority: task.priority as TaskPriorityDTO,
    origin: task.origin as TaskOriginDTO,
    mountId: task.mountId,
    mountLabel: placed?.mountLabel ?? null,
    folder: task.folder,
    relPath: placed?.relPath ?? null,
    createdByRunId: task.createdByRunId,
    claimedByRunId: task.claimedByRunId,
    claimedByOperator: task.claimedByOperator,
    completedByRunId: task.completedByRunId,
    parentTaskId: task.parentTaskId,
    operatorOnly: task.operatorOnly,
    needsFrontier: task.needsFrontier,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    closedAt: task.closedAt,
  };
}

/**
 * One row of the board's listing: the whole task with the brief clipped.
 *
 * `clipPrompt`'s shape in `/api/runs` — `MAX_LIST_TASK_BODY - 1` plus the
 * ellipsis, so a clipped value is the marked length rather than one character
 * over it and cannot be read as a whole brief.
 */
export function taskListItemDTO(
  task: Task,
  links?: TaskRunLinks,
  commentCount?: number,
  deps?: TaskDepsDTO,
): TaskListItemDTO {
  const dto = taskDTO(task, links, commentCount, deps);
  return {
    ...dto,
    body:
      dto.body.length <= MAX_LIST_TASK_BODY
        ? dto.body
        : `${dto.body.slice(0, MAX_LIST_TASK_BODY - 1)}…`,
  };
}
