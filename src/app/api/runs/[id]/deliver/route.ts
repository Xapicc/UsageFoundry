import { NextResponse } from "next/server";
// Relative, not "@/…", for the reason `src/app/api/settings/route.ts` gives:
// `deliverRun.test.ts` loads this route, and nothing rewrites the alias there.
import { readDeliveryFields } from "../../../../../lib/delivery";
import { readJsonObject } from "../../../../../lib/http";
import { deliverRun } from "../../../../../lib/land";
import { getRun } from "../../../../../lib/orchestrator";
import { auditMutation } from "../../../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Push this run's branch and open a pull request for it.
 *
 * One press, one run, and nothing in the run loop reaches this: delivery is the
 * only thing here that leaves the machine, and an outward-facing action taken
 * by a loop is a different product from one taken by a person.
 *
 * The title and body are optional. When given they are used verbatim, because
 * the operator standing at the button is better placed to describe the change
 * than a template built from the prompt, but `{}` still works, since needing to
 * write a title is a reason not to press it. The body itself is checked before
 * anything runs, `readDeliveryFields` says why, so a malformed one is a 400
 * with nothing pushed rather than a 500 after the push.
 */
async function postHandler(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!getRun(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const fields = readDeliveryFields(read.body);
  if (!fields.ok) return NextResponse.json({ error: fields.error }, { status: 400 });

  const outcome = await deliverRun(id, fields.value);
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.reason }, { status: 400 });
  }
  return NextResponse.json({ ok: true, url: outcome.url, number: outcome.number });
}

/** Wrapped so the request that published something is on the audit log. */
export const POST = auditMutation(postHandler);
