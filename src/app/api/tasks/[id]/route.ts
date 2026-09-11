import { NextResponse } from "next/server";
import {
  deleteTask,
  getTask,
  normalizeTaskPatch,
  runLinksForTasks,
  taskDTO,
  updateTask,
  type Task,
  type TaskActor,
} from "../../../../lib/tasks";
import { commentCountsForTasks } from "../../../../lib/taskComments";
import { auditMutation } from "../../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * One task on the board.
 *
 * Behind the app's ordinary gate, so the only actor that can reach this route
 * is the operator — which is stated once here rather than being read off
 * anything. That is the whole reason a *value* rather than a lookup: a route
 * that could be persuaded to act as another actor kind would be a route around
 * `taskTransitionRefusal`, and the way to add a run's or a chat turn's access
 * later is a door of its own that carries its own credential, not a field on
 * this one's body.
 */
const OPERATOR: TaskActor = { kind: "operator" };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const task = getTask(id);
  if (!task) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ task: withLinks(task) });
}

/**
 * The two reads a task DTO is drawn from, in one place.
 *
 * Both handlers below answer with the same row and `chatDTO`'s rule applies to
 * the count as much as to the links: two routes answering about the same task
 * must not answer differently, and a `commentCount` present on the GET and
 * absent from the PATCH would have the editor lose the count it was drawn with
 * on every save.
 */
function withLinks(task: Task) {
  return taskDTO(
    task,
    runLinksForTasks([task.id]).get(task.id),
    commentCountsForTasks([task.id]).get(task.id),
  );
}

/**
 * Edit a task, and move it if the body says so.
 *
 * `PATCH` rather than `PUT` because most presses on a board change one thing —
 * a status, a priority — and a wholesale replace would make every one of them a
 * read-modify-write against a row that may have moved since it was drawn. An
 * absent key is "leave it alone" throughout.
 *
 * Two different 400s and one 404, and telling them apart is `tasks.ts`' job
 * rather than this route's: `missing` is a row that is not there, `refused` is
 * a request the rule declined, and both arrive as a sentence naming something
 * the operator can change.
 */
async function patchHandler(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const parsed = normalizeTaskPatch(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const updated = updateTask(id, parsed.value, OPERATOR);
  if (!updated.ok) {
    return NextResponse.json(
      { error: updated.error },
      { status: updated.kind === "missing" ? 404 : 400 },
    );
  }
  // The same shape the GET answers with, so the editor that saved does not
  // lose the links it was drawn with — `chatDTO`'s rule: two routes answering
  // about the same row must not answer differently.
  return NextResponse.json({ task: withLinks(updated.task) });
}

/**
 * Remove a task. Nothing that is running is affected — a task holds no folder,
 * no slot and no child — and a task filed under this one keeps its own row,
 * losing only the link.
 */
async function deleteHandler(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const removed = deleteTask(id, OPERATOR);
  if (!removed.ok) {
    return NextResponse.json(
      { error: removed.error },
      { status: removed.kind === "missing" ? 404 : 400 },
    );
  }
  return NextResponse.json({ ok: true });
}

/** Wrapped so the request that changed something is on the audit log. */
export const PATCH = auditMutation(patchHandler);
/** Wrapped so the request that changed something is on the audit log. */
export const DELETE = auditMutation(deleteHandler);
