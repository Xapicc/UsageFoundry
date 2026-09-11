// Relative rather than aliased, which is what every route beside a tested
// module here does: `node --test` runs the compiled output, and nothing
// resolves `@/` there.
import { NextResponse } from "next/server";
import {
  createTask,
  isTaskOrigin,
  isTaskStatus,
  listTasks,
  normalizeTaskInput,
  runLinksForTasks,
  taskDTO,
  taskListItemDTO,
} from "../../../lib/tasks";
import { commentCountsForTasks } from "../../../lib/taskComments";
import { auditMutation } from "../../../lib/requestLog";
import { jsonMaybeGzipped } from "../../../lib/http";
import type { TaskListDTO } from "../../../lib/apiTypes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The taskboard: one board across every mount.
 *
 * Operator-facing and behind the app's ordinary gate, like every other route
 * here. The tokens that let a run or a chat turn write to this table are not
 * this route's business and are deliberately absent — nothing on this path
 * grants a capability, and `origin` is fixed to `operator` below rather than
 * read off the body, which is the whole of what stops a request deciding who
 * filed a task.
 */

/**
 * One page of the board: `?offset=`, `?limit=`, `?status=`, `?origin=`,
 * `?mountId=`, `?folder=`.
 *
 * The narrowing happens in the query rather than in a reader over an
 * already-capped page, and an unknown `status` or `origin` is a **400** rather
 * than a dropped filter — `/api/runs`' rule, and both of these decide *which
 * rows exist*. Quietly answering "every task" to "show me the claimed ones" is
 * a board that looks like an answer, which on a backlog reads as an absence of
 * work rather than as a failed filter.
 *
 * `mountId` and `folder` are matched against the stored columns exactly as they
 * are held, so the value to filter on is the `folder` this route already handed
 * back. They are not re-resolved: a read of the board must not start failing
 * because a mount is briefly unavailable.
 *
 * `total` is beside the rows for `RunListDTO`'s reason — counted over every
 * matching row rather than over the page, so the board can say what it is a
 * slice of.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;

  // A blank `status=` is every status, not a status named "". The board's own
  // "All" submits exactly that.
  const askedStatus = params.get("status");
  const status = askedStatus && isTaskStatus(askedStatus) ? askedStatus : null;
  if (askedStatus && status === null) {
    return NextResponse.json(
      { error: `Unknown task status: ${askedStatus}` },
      { status: 400 },
    );
  }

  const askedOrigin = params.get("origin");
  const origin = askedOrigin && isTaskOrigin(askedOrigin) ? askedOrigin : null;
  if (askedOrigin && origin === null) {
    return NextResponse.json(
      { error: `Unknown task origin: ${askedOrigin}` },
      { status: 400 },
    );
  }

  const page = listTasks({
    offset: Number(params.get("offset") ?? 0),
    limit: Number(params.get("limit") ?? 0),
    status,
    origin,
    mountId: params.get("mountId"),
    folder: params.get("folder"),
  });

  // One query for the whole page rather than one per row: the board polls
  // every ten seconds and a page is up to `MAX_TASK_PAGE` rows, so the per-row
  // read this replaces is an N+1 running on a timer.
  const links = runLinksForTasks(page.tasks.map((t) => t.id));
  // One `GROUP BY` for the whole page, on the same grounds: the count is drawn
  // on every row and a per-row read would be a second N+1 on the same timer.
  const comments = commentCountsForTasks(page.tasks.map((t) => t.id));

  const body: TaskListDTO = {
    tasks: page.tasks.map((t) =>
      taskListItemDTO(t, links.get(t.id), comments.get(t.id)),
    ),
    total: page.total,
    offset: page.offset,
    limit: page.limit,
  };
  // Gzipped rather than plain: a board is prose, and a page of three hundred
  // clipped briefs is the shape `jsonMaybeGzipped` exists for. `Cache-Control`
  // written at the call site, since the helper knows nothing about caching.
  return jsonMaybeGzipped(req, body, { headers: { "Cache-Control": "no-store" } });
}

/**
 * File a task. Always `open`, and always as the operator.
 *
 * `origin` is supplied here rather than taken off the body — see `TaskCreation`
 * in `tasks.ts` — and a body that names one is refused by name so that a caller
 * who tried is told, rather than having it silently ignored.
 */
async function postHandler(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const parsed = normalizeTaskInput(body, { origin: "operator", createdByRunId: null });
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const created = createTask(parsed.value);
  if (!created.ok) {
    return NextResponse.json({ error: created.error }, { status: 400 });
  }
  return NextResponse.json({ task: taskDTO(created.task) });
}

/** Wrapped so the request that changed something is on the audit log. */
export const POST = auditMutation(postHandler);
