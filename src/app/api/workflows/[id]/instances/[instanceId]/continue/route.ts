import { NextResponse } from "next/server";
import { continueGate, getInstance } from "@/lib/workflows";
import { instanceDTO } from "../../../../dto";
import { readJsonObject } from "../../../../../../../lib/http";
import { auditMutation } from "../../../../../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; instanceId: string }> };

/**
 * Let one held gate through.
 *
 * Beside `stop` and `pick-up`, and the only way past a gate other than `stop`:
 * a gate exists so that a person decides, so nothing a model, a schedule or the
 * scheduler's own timer can reach calls `continueGate`. One block per press,
 * named by `nodeId`, for `pick-up`'s reason — a control that decided which gates
 * to open would be deciding for the operator.
 *
 * Stop is the other half of the decision and is not repeated here: it is
 * `POST …/stop`, which halts through `stopInstance` like every other halt.
 */
async function postHandler(req: Request, ctx: Ctx) {
  const { id, instanceId } = await ctx.params;

  const instance = getInstance(instanceId);
  if (!instance || instance.workflowId !== id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const { nodeId } = read.body;
  if (typeof nodeId !== "string") {
    return NextResponse.json({ error: "Expected { nodeId: string }." }, { status: 400 });
  }

  const outcome = continueGate(instanceId, nodeId);
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  }

  return NextResponse.json({ instance: instanceDTO(getInstance(instanceId)!) });
}

/** Wrapped so the request that changed something is on the audit log. */
export const POST = auditMutation(postHandler);
