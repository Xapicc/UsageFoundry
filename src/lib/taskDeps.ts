import { db } from "./db";
import { describeFolder, dependencyCycle } from "./orchestrator";
import { getTask, type TaskStatus } from "./tasks";
import {
  MAX_TASK_DEP_LINKS,
  type TaskDepRefDTO,
  type TaskDepsDTO,
  type TaskStatusDTO,
} from "./apiTypes";

/**
 * "This task waits for that one": the ordering an operator can see, and the one
 * thing on this board that describes work without deciding anything about it.
 *
 * Its own module rather than a sixth section of `tasks.ts`, on
 * `taskComments.ts`' grounds and for its reason: that file is already the closed
 * sets, the transition rule, the door, the storage and the wire for one table,
 * and a second table's write door, loop detector and two-directional reads
 * pushed into it would bury `taskTransitionRefusal` — the function it exists to
 * make findable. The dependency runs one way only: this module reads `getTask`
 * and the status union, and nothing in `tasks.ts` imports this one. That is why
 * a neighbourhood reaches `taskDTO` as an **argument** rather than a read,
 * exactly as `TaskRunLinks` and the comment count already do.
 *
 * Four decisions are written out in `docs/agent/taskboard.md`, and the first of
 * them is the one every other line here depends on:
 *
 * **An edge is advisory. It gates nothing.** There is no new status, no new
 * refusal and no task made unclaimable because something it waits for is open.
 * A task whose dependencies are not all `done` is *shown* as blocked —
 * `blockedByCount`, derived at read time, never stored — and every actor that
 * could claim, start, comment on or close it before still can.
 * `taskTransitionRefusal` is untouched and is still the whole of the board's
 * authority model. Nothing in this file may consult it, extend it, or become a
 * second answer to it.
 *
 * **One kind of edge, and no column for a condition.** `run_deps` carries
 * `on-success`/`on-finish` because it gates a start and something is waiting on
 * the answer. This one gates nothing, so there is nothing for a condition to
 * decide and a kind would be a field every reader had to branch on for no
 * behaviour.
 *
 * **`parent_task_id` is a different relation and stays one.** A run filed a task
 * while working another: that is provenance, not "this blocks that". Nothing
 * here reads it and nothing here writes it.
 *
 * **Adding is a write three doors can make; removing is the operator's alone.**
 * The gate is that only one door exists for it — `DELETE /api/tasks/[id]/deps`,
 * behind the app's ordinary gate — and neither MCP surface has a tool for it. A
 * model silently undoing a link the operator drew is the quiet reversal the rest
 * of this board's rules exist to prevent, and it would be invisible: an edge
 * that is gone leaves nothing behind saying it was ever there.
 */

/* ------------------------------------------------------------------ */
/* What an edge is                                                     */
/* ------------------------------------------------------------------ */

/** The stored pair, and the whole of it: there is no third column to read. */
export interface TaskDepPair {
  /** The task that waits. */
  taskId: string;
  /** The task it waits for. */
  dependsOn: string;
}

/**
 * `TaskWriteResult`'s split, for its reason, plus the one thing an edge write
 * answers that a task write does not.
 *
 * `missing` is the caller's 404 and `refused` its 400, told apart here rather
 * than at a door so that three of them cannot each decide differently what a
 * task that is not there means. `created` is false when the edge was already
 * on the board: a repeated write is **not** an error — the primary key makes the
 * insert idempotent — but a caller that is told nothing cannot tell "I drew
 * this" from "this was already drawn", and a model retrying a tool call needs
 * to.
 */
export type TaskDepWriteResult =
  | { ok: true; taskId: string; dependsOn: string; created: boolean }
  | { ok: false; kind: "missing" | "refused"; error: string };

/* ------------------------------------------------------------------ */
/* The refusals — pure, and the reason this file has a test            */
/* ------------------------------------------------------------------ */

/**
 * Whether a dependency is still in the way.
 *
 * `done` clears an edge and nothing else does. `dropped` deliberately still
 * blocks: a task somebody decided should not happen has not been *done*, and the
 * ordering its dependent was given still says it comes first. Reading `dropped`
 * as satisfied would quietly mark a dependent ready on the strength of work
 * nobody did, which is the same class of failure as a board that closes a task
 * nothing worked — and unlike that one it would be invisible, since the reading
 * is drawn as a word rather than stored. What the operator gets instead is the
 * dependency's own status beside it, so the thing in the way names itself and
 * the edge can be removed.
 */
export function depIsBlocking(status: TaskStatus | TaskStatusDTO): boolean {
  return status !== "done";
}

/**
 * Why an edge cannot be written, or null.
 *
 * **Pure, and both halves fail silently.** A self-edge stores happily, reads
 * back as a task waiting for itself, and renders as a row permanently blocked by
 * nothing a person can act on. A loop is worse and quieter: every task in it
 * shows as blocked for ever, each one pointing at the next, and no surface
 * anywhere is in a position to notice that the set as a whole can never clear.
 * Neither throws and neither fails a typecheck.
 *
 * The loop test is `dependencyCycle` and deliberately not a second walker.
 * That function is agnostic about what the ids are — `workflowGraph.ts` already
 * hands it canvas node ids — so "what counts as a cycle" has one definition and
 * one test in this app however many kinds of thing turn out to wait for each
 * other. It is given the stored edges **plus the proposed one**: the graph on
 * disk is acyclic because this door is the only thing that writes it, so any
 * loop the walker finds is one this write would create. A loop found that does
 * not contain the new edge is a second writer having appeared, and refusing it
 * is still right — it names a real loop that a person needs to break.
 *
 * `describe` turns an id into what to call it in the sentence. The refusal has
 * to name the loop it found, and a list of UUIDs is not a name: the door passes
 * titles, and the default keeps the function usable — and testable — with
 * nothing but ids.
 */
export function taskDepRefusal(
  taskId: string,
  dependsOn: string,
  edges: readonly TaskDepPair[],
  describe: (id: string) => string = (id) => id,
): string | null {
  if (taskId === dependsOn) {
    return (
      "A task cannot depend on itself. An edge is an ordering between two " +
      "briefs, and a task waiting for itself is one that can never be shown as " +
      "ready however much work is done on it."
    );
  }

  // `runId` is the walker's name for a node and is read as nothing else; see
  // `DependencyNodeLink`.
  const loop = dependencyCycle(
    [...edges, { taskId, dependsOn }].map((e) => ({
      runId: e.taskId,
      dependsOn: e.dependsOn,
    })),
  );
  if (!loop) return null;

  return (
    `That would make a loop: ${loop.map(describe).join(" → ")}. Every task in ` +
    `a loop waits for another one for ever, so none of them can ever be shown ` +
    `as ready. Remove an edge somewhere in it first.`
  );
}

/**
 * One task's neighbourhood, from its two lists of neighbours.
 *
 * **Pure, and the derived reading is the whole point of it.** `blockedByCount`
 * is counted over **every** dependency and the lists are then capped, which is
 * the order that matters: counted over the capped list instead, a task waiting
 * on twelve things with the first ten done would report itself ready. Nothing
 * stores this number and nothing enforces it — a blocked task is drawn as
 * blocked and is otherwise an ordinary row.
 *
 * The cap drops the **done** end of `dependsOn`, which is the mirror of a
 * clipped thread losing its oldest note and is there for the same reason: what
 * survives a clip has to be what a reader can act on, and a list of four
 * finished dependencies beside a `blockedByCount` of three names nothing. The
 * partition is stable, so within each half the caller's order — the order the
 * edges were drawn — is kept. `dependents` are not re-ordered: nothing about a
 * task waiting for this one is more urgent than another, and the edge's own age
 * is the only ordering that is not an opinion.
 */
export function depNeighbourhood(
  dependsOn: readonly TaskDepRefDTO[],
  dependents: readonly TaskDepRefDTO[],
  limit: number = MAX_TASK_DEP_LINKS,
): TaskDepsDTO {
  const capped = Math.max(0, Math.floor(limit) || 0);
  const blocking = dependsOn.filter((d) => depIsBlocking(d.status));
  const cleared = dependsOn.filter((d) => !depIsBlocking(d.status));

  return {
    dependsOn: [...blocking, ...cleared].slice(0, capped),
    dependsOnCount: dependsOn.length,
    dependents: dependents.slice(0, capped),
    dependentCount: dependents.length,
    blockedByCount: blocking.length,
  };
}

/** What a task with no edges either way reads as. */
export const NO_TASK_DEPS: TaskDepsDTO = depNeighbourhood([], []);

/* ------------------------------------------------------------------ */
/* Storage — the only module that touches the table                    */
/* ------------------------------------------------------------------ */

/** Every edge on the board, which is what the loop test has to walk. */
export function allTaskDeps(): TaskDepPair[] {
  return (
    db()
      .prepare("SELECT task_id, depends_on FROM task_deps")
      .all() as Array<{ task_id: string; depends_on: string }>
  ).map((row) => ({ taskId: row.task_id, dependsOn: row.depends_on }));
}

/**
 * Draw an edge: this task waits for that one.
 *
 * The one writer, and it moves nothing — no `UPDATE tasks` here, on
 * `addTaskComment`'s rule and for its reason: `updated_at` means the task moved
 * and the board sorts on it, so drawing an edge would reorder the board and read
 * as somebody having worked on the task.
 *
 * Both ends are read only to answer whether they are there, which is the
 * `missing` a door turns into a 404 — an insert against a deleted id would
 * otherwise be refused by the foreign key as an opaque SQLite error rather than
 * as a sentence somebody can act on.
 *
 * `ON CONFLICT DO NOTHING` rather than a read followed by an insert: the primary
 * key is what makes a repeated write idempotent, and a check-then-insert is a
 * window in which a second door writes the same pair. `created` is read off
 * `changes` for the same reason — it is the statement's own answer to whether
 * this call was the one that wrote the row, rather than a second read's guess.
 *
 * No actor. Three doors write this and all three write the same fact, so there
 * is nothing to record and nothing to refuse on: what is gated is **removal**,
 * and it is gated by there being exactly one door for it.
 */
export function addTaskDep(taskId: string, dependsOn: string): TaskDepWriteResult {
  if (!getTask(taskId)) {
    return { ok: false, kind: "missing", error: "No such task." };
  }
  if (!getTask(dependsOn)) {
    return { ok: false, kind: "missing", error: "No such task to depend on." };
  }

  const refusal = taskDepRefusal(taskId, dependsOn, allTaskDeps(), (id) => {
    const task = getTask(id);
    return task ? `“${task.title}”` : id;
  });
  if (refusal) return { ok: false, kind: "refused", error: refusal };

  const written = db()
    .prepare(
      `INSERT INTO task_deps (task_id, depends_on, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(task_id, depends_on) DO NOTHING`,
    )
    .run(taskId, dependsOn, Date.now());

  return { ok: true, taskId, dependsOn, created: written.changes > 0 };
}

/**
 * Remove an edge. The operator's, and only through the route.
 *
 * An edge that is not there is a **404** rather than a silent success, which is
 * the asymmetry with `addTaskDep` above and is deliberate. A repeated *add* is a
 * caller restating something true, where a remove that found nothing means the
 * row the press was drawn against has changed underneath it — a second door
 * removed the edge, or the task did — and a board told "done" would redraw
 * itself as though the press had landed. `deleteTask`'s split one table over.
 */
export function removeTaskDep(taskId: string, dependsOn: string): TaskDepWriteResult {
  const removed = db()
    .prepare("DELETE FROM task_deps WHERE task_id = ? AND depends_on = ?")
    .run(taskId, dependsOn);

  if (removed.changes === 0) {
    return {
      ok: false,
      kind: "missing",
      error: "There is no such dependency. It may have been removed already.",
    };
  }
  return { ok: true, taskId, dependsOn, created: false };
}

/** The columns every neighbour ref is built from, whichever end it came off. */
interface NeighbourRow {
  /** The task the edge is being reported *for*. */
  anchor: string;
  id: string;
  title: string;
  status: string;
  mount_id: string | null;
  folder: string | null;
}

const NEIGHBOUR_COLUMNS =
  "t.id AS id, t.title AS title, t.status AS status, t.mount_id AS mount_id, t.folder AS folder";

/**
 * A neighbouring task as the wire describes it.
 *
 * `describeFolder` is the one splitter and it is the same one `taskDTO` uses, so
 * a task drawn as a row and the same task drawn as somebody else's dependency
 * cannot disagree about which project it is in. The stored `mount_id` travels
 * rather than the resolved one, `taskDTO`'s choice: a mount the operator renamed
 * leaves the task where it was filed and the label is what goes null.
 */
function neighbourRef(row: NeighbourRow): TaskDepRefDTO {
  const placed = row.folder ? describeFolder(row.folder) : null;
  return {
    id: row.id,
    title: row.title,
    status: row.status as TaskStatusDTO,
    mountId: row.mount_id,
    mountLabel: placed?.mountLabel ?? null,
    relPath: placed?.relPath ?? null,
  };
}

/**
 * Both ends of every edge touching these tasks, in two queries rather than two
 * per task.
 *
 * `runLinksForTasks`' shape and its reason: the board draws up to
 * `MAX_TASK_PAGE` rows on a ten-second poll, so the per-row read this replaces
 * is an N+1 running on a timer. Two queries rather than one because the two
 * directions are two different joins — `idx_task_deps_depends_on` exists for the
 * second of them — and a union would give the planner one shape to satisfy both
 * ends with.
 *
 * Every edge is read even though the lists are capped, because the counts
 * beside them are not and `blockedByCount` in particular has to be exact: the
 * number is what a surface says "blocked" on the strength of, and one counted
 * over a capped list would report a task as ready while something it waits on is
 * still open. A task with no edges either way is **absent** from the map rather
 * than present as an empty neighbourhood, which is what lets the caller's
 * `?? NO_TASK_DEPS` be the one place the default is written.
 */
export function depsForTasks(taskIds: readonly string[]): Map<string, TaskDepsDTO> {
  const deps = new Map<string, TaskDepsDTO>();
  if (taskIds.length === 0) return deps;

  const placeholders = taskIds.map(() => "?").join(", ");
  // Ordered by the edge's own age, which is the order they were drawn in and
  // the only one here that is not an opinion. `depNeighbourhood` partitions
  // `dependsOn` on top of it and leaves `dependents` exactly as read.
  const forward = db()
    .prepare(
      `SELECT d.task_id AS anchor, ${NEIGHBOUR_COLUMNS}
         FROM task_deps d JOIN tasks t ON t.id = d.depends_on
        WHERE d.task_id IN (${placeholders})
        ORDER BY d.created_at, t.id`,
    )
    .all(...taskIds) as NeighbourRow[];

  const back = db()
    .prepare(
      `SELECT d.depends_on AS anchor, ${NEIGHBOUR_COLUMNS}
         FROM task_deps d JOIN tasks t ON t.id = d.task_id
        WHERE d.depends_on IN (${placeholders})
        ORDER BY d.created_at, t.id`,
    )
    .all(...taskIds) as NeighbourRow[];

  const dependsOn = new Map<string, TaskDepRefDTO[]>();
  const dependents = new Map<string, TaskDepRefDTO[]>();
  for (const [rows, into] of [
    [forward, dependsOn],
    [back, dependents],
  ] as const) {
    for (const row of rows) {
      const list = into.get(row.anchor);
      if (list) list.push(neighbourRef(row));
      else into.set(row.anchor, [neighbourRef(row)]);
    }
  }

  for (const id of new Set([...dependsOn.keys(), ...dependents.keys()])) {
    deps.set(id, depNeighbourhood(dependsOn.get(id) ?? [], dependents.get(id) ?? []));
  }
  return deps;
}

/** One task's neighbourhood, for the doors that answer about one task. */
export function depsForTask(taskId: string): TaskDepsDTO {
  return depsForTasks([taskId]).get(taskId) ?? NO_TASK_DEPS;
}
