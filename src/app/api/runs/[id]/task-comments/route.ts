import { NextResponse } from "next/server";
import { getRun } from "@/lib/orchestrator";
import { tasksLinkedToRun } from "@/lib/tasks";
import {
  commentCountsForTasks,
  newestCommentsForTasks,
  taskCommentDTO,
} from "@/lib/taskComments";
import { jsonMaybeGzipped } from "@/lib/http";
import { MAX_RUN_TASK_NOTES, type RunTaskNotesDTO } from "@/lib/apiTypes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The newest notes on every board task this run was started for.
 *
 * A route of its own rather than a field on `/api/runs/[id]`, for the reason
 * `agent-cost` beside it gives: that payload is polled every three seconds for
 * the life of a run, and this one carries prose. Keyed on the **run** rather
 * than taking a list of task ids, so the thread a caller can ask for is exactly
 * the thread the run is linked to and a second request is never the answer to
 * having more than one.
 *
 * Two queries whatever the run names, not two per task — `newestCommentsForTasks`
 * and `commentCountsForTasks` both take the list. `total` is counted over the
 * table rather than over the reply, on the shortened-diff rule the thread route
 * already follows: a block showing three of nine and saying nothing reports a
 * conversation that begins where it does not.
 *
 * A task the operator has deleted is **absent** from the reply rather than
 * present and empty. The run page already draws the link itself and says "a task
 * since deleted" for it; an entry here would be this route answering for rows
 * `ON DELETE CASCADE` removed.
 */
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  // A run that is not there is a 404 and never an empty list, the split
  // `/api/tasks/[id]/comments` makes for a missing task and for its reason: the
  // two are answers to different questions, and a surface handed the second for
  // the first says nobody has commented.
  if (!getRun(id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const taskIds = tasksLinkedToRun(id)
    .filter((task) => task.title !== null)
    .map((task) => task.id);
  const newest = newestCommentsForTasks(taskIds, MAX_RUN_TASK_NOTES);
  const counts = commentCountsForTasks(taskIds);

  const tasks: RunTaskNotesDTO[] = taskIds.map((taskId) => ({
    taskId,
    newest: (newest.get(taskId) ?? []).map(taskCommentDTO),
    total: counts.get(taskId) ?? 0,
  }));

  // Gzipped for the thread route's reason: a note is prose and nothing here
  // clips one. `Cache-Control` at the call site, since the helper knows nothing
  // about caching.
  return jsonMaybeGzipped(req, { tasks }, { headers: { "Cache-Control": "no-store" } });
}
