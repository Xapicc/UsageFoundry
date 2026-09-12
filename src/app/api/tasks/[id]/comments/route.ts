import { NextResponse } from "next/server";
import {
  addTaskComment,
  listTaskComments,
  taskCommentDTO,
} from "../../../../../lib/taskComments";
import { getTask, type TaskActor } from "../../../../../lib/tasks";
import { auditMutation } from "../../../../../lib/requestLog";
import { jsonMaybeGzipped } from "../../../../../lib/http";
import { MAX_TASK_COMMENTS, type TaskCommentListDTO } from "../../../../../lib/apiTypes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * One task's thread of notes.
 *
 * Behind the app's ordinary gate, so the only actor that can reach this route is
 * the operator — a value here rather than a lookup, `OPERATOR`'s rule on the
 * route beside it: a route that could be persuaded to write as another author
 * kind would make the recorded author a claim, which is the one thing the column
 * exists not to be. A chat turn and a work cycle reach the thread through their
 * own door carrying their own credential, not through a field on this one's
 * body.
 */
const OPERATOR: TaskActor = { kind: "operator" };

/**
 * The whole thread, oldest first.
 *
 * No `offset` and no `limit` off the query, which is the departure from
 * `/api/tasks` worth stating: a thread is read from the top rather than paged,
 * so the one figure a caller needs is whether `total` exceeded what came back.
 * The cap is `MAX_TASK_COMMENTS` and what it drops is the **oldest** end — see
 * `listTaskComments`, and `TaskCommentListDTO` for why an offset would have to
 * count from the other one.
 *
 * A task that is not there is a **404** rather than an empty thread, because the
 * two are the answers to different questions and a surface that collapsed them
 * would draw an empty comment box against a task the operator has deleted.
 */
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!getTask(id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const thread = listTaskComments(id, MAX_TASK_COMMENTS);
  const body: TaskCommentListDTO = {
    comments: thread.comments.map(taskCommentDTO),
    total: thread.total,
    limit: thread.limit,
  };
  // Gzipped rather than plain for the board listing's reason: a thread is prose
  // and nothing here clips a note. `Cache-Control` at the call site, since the
  // helper knows nothing about caching.
  return jsonMaybeGzipped(req, body, { headers: { "Cache-Control": "no-store" } });
}

/**
 * Write a note on a task.
 *
 * Append-only: there is no `PATCH` and no `DELETE` on this route, and their
 * absence is the design rather than work left over — a comment goes away only
 * when its task does, through `ON DELETE CASCADE`.
 *
 * It moves nothing. Nothing on this path calls `updateTask`, so the task keeps
 * its status, its priority and — deliberately — its `updated_at`: that column
 * means the task moved and the board sorts on it, so a note would reorder the
 * board and read as a move.
 *
 * One 404 and one 400, told apart by `taskComments.ts` rather than here, exactly
 * as `TaskWriteResult` already splits them on the route beside this one.
 */
async function postHandler(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const raw = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const written = addTaskComment(id, raw, OPERATOR);
  if (!written.ok) {
    return NextResponse.json(
      { error: written.error },
      { status: written.kind === "missing" ? 404 : 400 },
    );
  }
  return NextResponse.json({ comment: taskCommentDTO(written.comment) });
}

/** Wrapped so the request that changed something is on the audit log. */
export const POST = auditMutation(postHandler);
