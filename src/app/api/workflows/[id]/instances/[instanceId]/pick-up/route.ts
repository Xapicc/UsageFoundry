import { NextResponse } from "next/server";
import {
  getInstance,
  leaveRunBehind,
  resumeLoop,
  retryMergeBlock,
} from "@/lib/workflows";
import { instanceDTO } from "../../../../dto";
import { auditMutation } from "../../../../../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; instanceId: string }> };

/**
 * Carry a stuck workflow run on, one named obstacle at a time.
 *
 * Resuming a run is deliberately not here: it is `reopenRun`, on the run's own
 * page, with the budget and the note that door asks for — and reopening a run
 * already wakes what its ending wrote off in the workflow, loops included. What
 * is here is what no other page can do: carry the graph on *without* a run, run
 * a failed merge block again, and carry on a loop whose stuck pass has since
 * cleared.
 *
 * Each names one run or one block, never "everything stuck": a pick-up starts
 * unattended agents, and a control that decided which obstacles to step over
 * would be the bulk pick-up `needs-review` is kept out of on the runs page.
 */
async function postHandler(req: Request, ctx: Ctx) {
  const { id, instanceId } = await ctx.params;

  const instance = getInstance(instanceId);
  if (!instance || instance.workflowId !== id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = (await req.json().catch(() => null)) as
    | { action?: unknown; runId?: unknown; nodeId?: unknown }
    | null;
  const outcome =
    body?.action === "leave-behind" && typeof body.runId === "string"
      ? leaveRunBehind(instanceId, body.runId)
      : body?.action === "retry-merge" && typeof body.nodeId === "string"
        ? retryMergeBlock(instanceId, body.nodeId)
        : body?.action === "resume-loop" && typeof body.nodeId === "string"
          ? resumeLoop(instanceId, body.nodeId)
          : null;
  if (outcome === null) {
    return NextResponse.json(
      {
        error:
          'Expected { action: "leave-behind", runId }, { action: "retry-merge", nodeId }' +
          ' or { action: "resume-loop", nodeId }.',
      },
      { status: 400 },
    );
  }
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  }

  return NextResponse.json({ instance: instanceDTO(getInstance(instanceId)!) });
}

/** Wrapped so the request that changed something is on the audit log. */
export const POST = auditMutation(postHandler);
