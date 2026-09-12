import { NextResponse } from "next/server";
import { addTaskDep, depsForTask, removeTaskDep } from "../../../../../lib/taskDeps";
import { getTask } from "../../../../../lib/tasks";
import { auditMutation } from "../../../../../lib/requestLog";
import type { TaskDepsDTO } from "../../../../../lib/apiTypes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * What a task waits for, and what waits for it.
 *
 * Behind the app's ordinary gate, so the only actor that can reach this route is
 * the operator — `OPERATOR`'s rule on the two routes beside it, with one thing
 * on top that is specific to this table. **Adding an edge has three doors and
 * removing one has this door only.** A chat turn and a work cycle can draw a
 * dependency through their own MCP surfaces; neither of them has a tool that
 * takes one away, and the gate on that is not a refusal to be found in a pure
 * function — it is that the tool does not exist. A model silently undoing an
 * ordering the operator drew is the quiet reversal the rest of this board's
 * rules exist to prevent, and it is quieter here than anywhere else on the
 * board: an edge that has been removed leaves nothing behind saying it was ever
 * there.
 *
 * Nothing on this route gates anything. An edge is advisory — the reply says
 * how many of a task's dependencies are still in the way, and no status, no
 * claim and no press anywhere is refused on the strength of it.
 */

/**
 * One task's edges, both directions.
 *
 * A task that is not there is a **404** rather than an empty neighbourhood, the
 * comments route's split and its reason: the two are answers to different
 * questions, and a surface that collapsed them would draw "nothing is blocking
 * this" against a task the operator has deleted.
 *
 * The same shape `GET /api/tasks/[id]` already carries on `deps`. It is here as
 * well because the two are asked at different moments — a board row is drawn
 * from the page fetch, where a press that changed an edge needs the
 * neighbourhood back without re-reading the whole task — and answering with one
 * shape from both is `chatDTO`'s rule.
 */
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!getTask(id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const body: TaskDepsDTO = depsForTask(id);
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}

/**
 * Draw an edge: this task waits for the one named in `dependsOn`.
 *
 * One 404 and one 400, told apart by `taskDeps.ts` rather than here, exactly as
 * `TaskWriteResult` already splits them on the routes beside this one. The two
 * refusals worth knowing are a self-edge and a loop, and the second names the
 * loop it found so the operator can see which edge to break.
 *
 * A repeated write is **not** an error: the primary key makes the insert
 * idempotent and the reply says `created: false`, because a caller told nothing
 * cannot tell "I drew this" from "this was already drawn".
 *
 * An edge **across projects** is allowed and is not a special case. A task in
 * one folder blocking one in another is the ordering an operator most needs
 * shown, and the neighbourhood in the reply names the project each end is in.
 */
async function postHandler(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const raw = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const dependsOn = typeof raw.dependsOn === "string" ? raw.dependsOn.trim() : "";
  if (!dependsOn) {
    return NextResponse.json(
      { error: "A dependency needs a dependsOn: the id of the task this one waits for." },
      { status: 400 },
    );
  }

  const written = addTaskDep(id, dependsOn);
  if (!written.ok) {
    return NextResponse.json(
      { error: written.error },
      { status: written.kind === "missing" ? 404 : 400 },
    );
  }
  return NextResponse.json({ created: written.created, deps: depsForTask(id) });
}

/**
 * Take an edge away. The operator's door, and the only one there is.
 *
 * The id travels in the body rather than the path, `branches/queue`'s shape: an
 * edge is a pair and neither half of it identifies the row on its own, so a
 * second path segment would be a route whose two ids are ordered by convention.
 *
 * An edge that is not there is a **404** rather than a silent success, which is
 * the asymmetry with the POST above. A repeated add is a caller restating
 * something true; a remove that found nothing means the row the press was drawn
 * against has changed underneath it, and a board told "done" would redraw itself
 * as though the press had landed.
 */
async function deleteHandler(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const raw = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const dependsOn = typeof raw.dependsOn === "string" ? raw.dependsOn.trim() : "";
  if (!dependsOn) {
    return NextResponse.json(
      { error: "Removing a dependency needs a dependsOn: the id of the task it named." },
      { status: 400 },
    );
  }

  const removed = removeTaskDep(id, dependsOn);
  if (!removed.ok) {
    return NextResponse.json(
      { error: removed.error },
      { status: removed.kind === "missing" ? 404 : 400 },
    );
  }
  return NextResponse.json({ deps: depsForTask(id) });
}

/** Wrapped so the request that changed something is on the audit log. */
export const POST = auditMutation(postHandler);
/** Wrapped so the request that changed something is on the audit log. */
export const DELETE = auditMutation(deleteHandler);
