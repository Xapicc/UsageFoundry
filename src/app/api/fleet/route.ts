import { NextResponse } from "next/server";
import {
  fleetState,
  reopenFleet,
  setFleetPaused,
  stopFleet,
} from "@/lib/fleet";
import { auditMutation, recordDurableMutation } from "@/lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The install-wide controls: what is in flight, stop it, hold new work, put it
 * back.
 *
 * One route with an action rather than four paths, which is `POST
 * /api/runs/[id]/land`'s shape and for its reason: these are four presses on one
 * card, they share one answer (`state`, so the card re-renders off the response
 * rather than a second request), and a caller that gets the action wrong should
 * find out here rather than at a 404.
 *
 * Authenticated by `middleware.ts` like every other route under `/api` — the
 * one exemption is `/api/mcp`, and it is not widened for this.
 */
export async function GET() {
  return NextResponse.json({ state: fleetState() });
}

async function postHandler(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action ?? "");

  if (action === "stop") {
    // Synchronous from the first instance to the last run; see `stopFleet`.
    const report = stopFleet();
    // Durable, and only when it landed on something. This is the widest single
    // press in the app — every run in flight and every started instance — and
    // the runs themselves record it as `FLEET_CAUSE`, which says what happened
    // to each and never that one press did all of them at once. A stop over an
    // idle install changed nothing and gets the request line only.
    const touched =
      report.signalled.length +
      report.cancelled.length +
      report.blocked.length +
      report.instances.length;
    if (touched > 0) {
      recordDurableMutation(req, "warn", "fleet.stopped", {
        signalled: report.signalled.length,
        cancelled: report.cancelled.length,
        blocked: report.blocked.length,
        instances: report.instances.length,
      });
    }
    return NextResponse.json({ report, state: fleetState() });
  }

  if (action === "pause" || action === "resume") {
    setFleetPaused(action === "pause");
    // Unconditional, unlike the branches around it, because there is no no-op
    // press to exclude: resuming an install that is already running still
    // releases dependents and promotes the queue. What bounds these rows is
    // that the press is behind the gate and made by a person.
    recordDurableMutation(
      req,
      "info",
      action === "pause" ? "fleet.paused" : "fleet.resumed",
    );
    return NextResponse.json({ state: fleetState() });
  }

  if (action === "reopen") {
    // The ids the page displayed, explicitly. There is deliberately no "reopen
    // every failed run" selector on the wire: a run that reached a terminal
    // state between the render and the click must not be swept into a reopen
    // nobody saw, which is the rule `POST /api/chat/[id]/approve` follows.
    const raw = body.runIds;
    const ids = Array.isArray(raw) ? raw.map((v) => String(v)).filter(Boolean) : [];
    if (ids.length === 0) {
      return NextResponse.json(
        { error: "Name the runs to pick up. An empty list starts nothing." },
        { status: 400 },
      );
    }
    const report = reopenFleet(ids, body.budget);
    // A batch where every id was refused is a 400 for the same reason an empty
    // list is: a 200 with nothing started is indistinguishable from a batch that
    // worked, and the page clears its selection on `res.ok`.
    if (report.reopened.length === 0) {
      return NextResponse.json(
        {
          error: report.refused[0]?.reason ?? "None of those runs could be picked up.",
          report,
        },
        { status: 400 },
      );
    }
    recordDurableMutation(req, "info", "fleet.reopened", {
      reopened: report.reopened.length,
      refused: report.refused.length,
    });
    return NextResponse.json({ report, state: fleetState() });
  }

  return NextResponse.json(
    { error: `Unknown action: ${action || "(none)"}` },
    { status: 400 },
  );
}

/**
 * Wrapped like every other mutating route behind the gate: these four presses
 * are the widest controls in the app — one of them ends every run in flight —
 * and nothing recorded that any of them was made. The wrapper is the *request*
 * line and catches the refusals; the calls above are the durable half, on
 * `ops_events`, because a fleet stop has to still be findable after twenty
 * thousand ordinary requests have gone through `request_log`.
 */
export const POST = auditMutation(postHandler);
