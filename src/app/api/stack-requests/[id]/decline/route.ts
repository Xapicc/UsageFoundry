import { NextResponse } from "next/server";
import { releaseStackWaits } from "../../../../../lib/orchestrator";
import { declineStackRequest, stackRequest } from "../../../../../lib/stackRequests";
import { auditMutation } from "../../../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Decline a stack a run asked for, and hand back every run waiting on it.
 *
 * The one write the operator makes on a request, and the only answer besides
 * installing — which is not a button, because a stack is installed by writing a
 * `stack.json` on the host and restarting, and nothing here may do either
 * (`docs/agent/security/stacks.md`). The release runs here rather than waiting
 * for the sweeper's next tick so the page that pressed it sees the run move.
 *
 * A request that is no longer pending is a 200 carrying `declined: false`, the
 * resume route's shape: a second press and a press on a request somebody else
 * has just declined are both a state the page has to render, not an error.
 */
async function postHandler(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!stackRequest(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const declined = declineStackRequest(id);
  if (declined) releaseStackWaits();
  return NextResponse.json({ ok: declined, declined });
}

/** Wrapped so the request that changed something is on the audit log. */
export const POST = auditMutation(postHandler);
