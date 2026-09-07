import { NextResponse } from "next/server";
import {
  MAX_INGEST_BODY_BYTES,
  parseLogsPayload,
  readCappedBody,
  recordTelemetry,
  runForIngestToken,
} from "@/lib/otlp";

/**
 * OTLP/HTTP-JSON logs receiver.
 *
 * Claude Code appends the signal suffix to whatever base endpoint it is given,
 * so `OTEL_EXPORTER_OTLP_ENDPOINT=http://host/api/otlp` lands here — verified
 * against a captured POST from CLI v2.1.226, which also confirmed the body is
 * plain `application/json` with no compression. Nothing needs to be added to
 * `package.json` to read it.
 *
 * `src/middleware.ts` exempts this path and the route authenticates itself, for
 * the reason `/api/mcp` does: the credential it takes is not `UF_AUTH_TOKEN`.
 * The exporter used to carry that one — the app's master token, in the agent's
 * own environment, in a variable `env` prints — and it now carries a capability
 * minted per run and revoked when that run's loop ends. **If the check below is
 * ever removed, the exemption in `middleware.ts` makes this an open write into
 * `otlp_requests`; keep the two together.** An open one would matter: a
 * pre-inserted `request_id` is silently dropped by the `INSERT OR IGNORE` in
 * `recordTelemetry`, which understates the figure a live spending guard reads.
 *
 * The run id comes from the **token**, not from the payload's `uf.run_id`. The
 * attribute is still stamped, so a captured payload says which run it claims to
 * be, but a record cannot move spend onto a run whose credential it does not
 * hold.
 *
 * Deliberately **not** wrapped in `auditMutation`. It is the one mutating route
 * whose callers are this app's own children, delivering at-least-once every few
 * seconds per run — at 25 runs that is thousands of audit rows an hour saying
 * nothing an operator would ever read, and it would push the burst somebody is
 * actually looking for out of a bounded table. What it writes is one
 * `otlp_requests` row keyed on a request id, and the run page and the status
 * endpoint both report on that.
 *
 * Past authentication the response is 200 for anything this route *read*. A
 * batch exporter retries on failure, and a malformed or unrecognised record is
 * not something a retry will fix — it would just cost the same batch again on a
 * loop. An unauthenticated caller is the opposite case and gets a 401: retrying
 * is the right thing for it to do, and answering 200 while dropping the batch
 * would report success for telemetry that never arrived.
 *
 * The one other refusal is a body over `MAX_INGEST_BODY_BYTES`, which is a 413
 * because it is neither of those: the batch was never read, so 200 would be the
 * same false report, and it will be refused at that size on every retry.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const header = req.headers.get("authorization") ?? "";
  const runId = runForIngestToken(
    header.startsWith("Bearer ") ? header.slice(7) : "",
  );
  if (!runId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Bounded at the read rather than after the parse: this path is exempt
    // from the edge gate, so nothing upstream of here has decided how much
    // this process will hold, and `req.json()` would have buffered and parsed
    // the whole body before any check on its size could run. `MAX_INGEST_BODY_BYTES`
    // carries the number and how it was derived.
    const body = await readCappedBody(req);
    if (!body.ok) {
      // Answered before anything durable is written — `recordTelemetry` is not
      // reached and this route is not wrapped in `auditMutation` — for the
      // reason `/api/logout` states: an exempted path's own refusal must not
      // spend a capped table's window on behalf of a caller that passed
      // nothing. Anything added above this line inherits that.
      //
      // 413 rather than the blanket 200 below, and it names the limit: a batch
      // exporter should not retry a body this app will refuse at the same size
      // every time, and an operator reading it has to be able to tell a size
      // refusal from a payload this route could not parse.
      return NextResponse.json(
        { error: "Payload too large", limitBytes: MAX_INGEST_BODY_BYTES },
        { status: 413 },
      );
    }

    const rows = parseLogsPayload(JSON.parse(body.text));
    const inserted = recordTelemetry(rows.map((r) => ({ ...r, runId })));
    return NextResponse.json({ partialSuccess: {}, seen: rows.length, inserted });
  } catch {
    return NextResponse.json({ partialSuccess: {} });
  }
}
