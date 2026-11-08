import { NextResponse } from "next/server";
// Relative, not "@/…" — see the note in the login route.
import { codexGuardSnapshot } from "../../../lib/codexAccount";
import {
  allRefusedMessage,
  fleetGuardWindows,
  fleetState,
  reopenFleet,
  setFleetPaused,
  stopFleet,
  type FleetGuardSnapshots,
} from "../../../lib/fleet";
import { currentSnapshot } from "../../../lib/orchestrator";
import { ENFORCEMENT_MODES, policyNumberRefusal } from "../../../lib/budget";
import { optionalObjectField, readJsonObject } from "../../../lib/http";
import { auditMutation, recordDurableMutation } from "../../../lib/requestLog";

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
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const body = read.body;
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
    const budgetField = optionalObjectField(body, "budget");
    if (!budgetField.ok) {
      return NextResponse.json({ error: budgetField.error }, { status: 400 });
    }
    const rawBudget = budgetField.value ?? {};
    // Checked here because `reopenFleet` adds it to each run's own count, and
    // a zero or a word there would come back as twenty-five refusals telling
    // the operator to raise a limit they never typed.
    const more = rawBudget.moreIterations;
    if (
      more !== undefined &&
      more !== null &&
      !(typeof more === "number" && Number.isInteger(more) && more >= 1)
    ) {
      return NextResponse.json(
        {
          error: `More work cycles must be a whole number of at least 1, or blank for no cycle limit; got ${JSON.stringify(more)}.`,
        },
        { status: 400 },
      );
    }
    // Narrowed rather than trusted, for the reason given in `POST /api/runs`:
    // `reopenFleet` spreads the wire over each stored blob, and `normalizePolicy`
    // reads an unknown mode as the default, so a typo here would swap every
    // picked-up run's chosen enforcement for `between-cycles`.
    if (rawBudget.enforcement !== undefined && rawBudget.enforcement !== null) {
      const candidate = String(rawBudget.enforcement);
      if (!(ENFORCEMENT_MODES as readonly string[]).includes(candidate)) {
        return NextResponse.json(
          { error: `Unknown enforcement mode: ${candidate}` },
          { status: 400 },
        );
      }
    }
    // Before the fold in `reopenFleet`, for the reason given in `POST
    // /api/runs/[id]/reopen`: "5O", "$5" and -5 would put every run in the batch
    // back with no spending limit and answer 200 — once for the whole selection
    // rather than for one run. `moreIterations` is not one of the fields this
    // reads; the check above is its own.
    const numberRefusal = policyNumberRefusal(rawBudget);
    if (numberRefusal) {
      return NextResponse.json({ error: numberRefusal }, { status: 400 });
    }
    // The readings a fraction guard in the batch will be judged against,
    // fetched here because `reopenFleet` awaits nothing — see its docblock —
    // and only the ones some run needs: the sheet sends no fraction, so this
    // is usually nothing and no transcript scan is paid for. The provider's
    // windows are asked for as `POST /api/runs/[id]/reopen` asks, one reading
    // per provider rather than one per run.
    const windows = fleetGuardWindows(ids, rawBudget);
    const snapshots: FleetGuardSnapshots = {};
    if (windows.includes("claude")) snapshots.claude = await currentSnapshot();
    if (windows.includes("codex")) snapshots.codex = await codexGuardSnapshot();
    const report = reopenFleet(ids, rawBudget, snapshots);
    // A batch where every id was refused is a 400 for the same reason an empty
    // list is: a 200 with nothing started is indistinguishable from a batch that
    // worked, and the page clears its selection on `res.ok`.
    if (report.reopened.length === 0) {
      return NextResponse.json(
        { error: allRefusedMessage(report.refused), report },
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
