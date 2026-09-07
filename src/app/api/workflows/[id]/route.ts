import { NextResponse } from "next/server";
import {
  currentKnowledge,
  deleteWorkflow,
  findInstances,
  folderRefusal,
  getWorkflow,
  liveBlocksOf,
  liveRunsOf,
  normalizeWorkflowInput,
  updateWorkflow,
} from "../../../../lib/workflows";
import { instanceDTO, workflowDTO } from "../dto";
import { auditMutation } from "../../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * The graph, plus one page of the presses of Run it has had.
 *
 * `offset` and `limit` are what make the history reachable rather than only its
 * newest page, which is `/api/branches`' principle and now the last list route
 * in the tree that was not holding to it: this answered with `listInstances`'
 * newest twenty for as long as it existed, so the page above it could not have
 * paged however it was written.
 *
 * `total` and `offset` travel back because the page states which slice it is
 * showing, and the count has to be over every instance rather than over what
 * arrived — a Next button that may or may not do anything is the same dead end
 * one press along. `limit` is the effective one, after clamping, since that is
 * the step the page's own controls move by.
 */
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const workflow = getWorkflow(id);
  if (!workflow) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const params = new URL(req.url).searchParams;
  const page = findInstances({
    workflowId: id,
    limit: Number(params.get("limit") ?? 20),
    offset: Number(params.get("offset") ?? 0),
  });
  return NextResponse.json({
    workflow: workflowDTO(workflow),
    instances: page.instances.map(instanceDTO),
    total: page.total,
    offset: page.offset,
    limit: page.limit,
  });
}

async function putHandler(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!getWorkflow(id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = normalizeWorkflowInput(body, currentKnowledge());
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const missing = folderRefusal(parsed.value.graph);
  if (missing) return NextResponse.json({ error: missing }, { status: 400 });

  try {
    const workflow = updateWorkflow(id, parsed.value);
    if (!workflow) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ workflow: workflowDTO(workflow) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}

/**
 * Deleting takes the workflow's instance records with it and no run.
 *
 * Refused while runs it started are still going, because those records are the
 * only thing saying where those runs came from — and the operator watching a
 * chain of six run rows advance has no other way back to the graph that made
 * them. Nothing is stopped on their behalf: ending a run is the Runs page's
 * decision, not a side effect of tidying a list.
 */
async function deleteHandler(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const workflow = getWorkflow(id);
  if (!workflow) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const live = liveRunsOf(id);
  const liveBlocks = liveBlocksOf(id);
  if (live.length + liveBlocks > 0) {
    return NextResponse.json(
      {
        error:
          `${live.length} run(s) and ${liveBlocks} block(s) started by this ` +
          "workflow have not finished yet. Deleting it now would leave them " +
          "with nothing saying what they are part of, and a block still " +
          "deciding would lose the graph it is deciding for. Wait for them, or " +
          "stop that run of the workflow.",
      },
      { status: 400 },
    );
  }

  return NextResponse.json({ deleted: deleteWorkflow(id) });
}

/** Wrapped so the request that changed something is on the audit log. */
export const PUT = auditMutation(putHandler);
/** Wrapped so the request that changed something is on the audit log. */
export const DELETE = auditMutation(deleteHandler);
