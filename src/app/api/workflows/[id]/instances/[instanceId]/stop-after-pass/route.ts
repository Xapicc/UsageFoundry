import { NextResponse } from "next/server";
import { getInstance, setLoopStopAfter } from "@/lib/workflows";
import { instanceDTO } from "../../../../dto";
import { readJsonObject } from "../../../../../../../lib/http";
import { auditMutation } from "../../../../../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; instanceId: string }> };

/**
 * Ask one looping loop to end after the pass it is on, or take that back.
 *
 * Beside `stop` and not behind it: this is not a halt. `stop` closes the whole
 * instance's door and signals every member; this records a number on one loop
 * block and signals nothing, so the pass in flight finishes and lands before the
 * loop ends. The two never share a code path, and Stop pressed as well wins —
 * `setLoopStopAfter` refuses once the instance is halted.
 *
 * One block per press, named by `nodeId`, for `pick-up`'s reason: a control that
 * decided which loops to end would be deciding for the operator.
 */
async function postHandler(req: Request, ctx: Ctx) {
  const { id, instanceId } = await ctx.params;

  const instance = getInstance(instanceId);
  if (!instance || instance.workflowId !== id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const { nodeId, stop } = read.body;
  if (typeof nodeId !== "string" || typeof stop !== "boolean") {
    return NextResponse.json(
      { error: "Expected { nodeId: string, stop: boolean }." },
      { status: 400 },
    );
  }

  const outcome = setLoopStopAfter(instanceId, nodeId, stop);
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  }

  return NextResponse.json({ instance: instanceDTO(getInstance(instanceId)!) });
}

/** Wrapped so the request that changed something is on the audit log. */
export const POST = auditMutation(postHandler);
