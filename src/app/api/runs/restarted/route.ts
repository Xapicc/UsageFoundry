import { NextResponse } from "next/server";
// Relative, not "@/…" — see the note in the claude-auth login route.
import type { GuardSnapshots } from "../../../../lib/budget";
import { codexGuardSnapshot } from "../../../../lib/codexAccount";
import {
  currentSnapshot,
  reopenRestartClosed,
  restartClosedGuardWindows,
  restartClosedRuns,
} from "../../../../lib/orchestrator";
import { auditMutation, recordDurableMutation } from "../../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The runs a restart closed out, and one press to pick them all up.
 *
 * A restart used to leave every in-flight run `failed` with the only route back
 * being the run page, one at a time, each asking for a budget at the door.
 * Twenty-five runs is twenty-five pages, and nothing in the product said they
 * were sitting there — the count went to a `console.warn` in a container log.
 *
 * A static segment beside `[id]`, which Next resolves in favour of the static
 * one. Nothing can collide with it: run ids are UUIDs.
 */
export async function GET() {
  const runs = restartClosedRuns();
  return NextResponse.json({
    count: runs.length,
    runs: runs.map((r) => ({ id: r.id, prompt: r.prompt, status: r.status })),
  });
}

/**
 * Each under the guards it already carried — see `reopenRestartClosed` for why
 * that is the right budget here and a re-entered one is not.
 *
 * A refusal per run rather than one for the batch: `reopenRun` checks the
 * carried-forward guards at the door, so a run that really had used up its
 * cycles is refused by name, and reporting that as "the batch failed" would
 * hide the ones that did start. That includes a run whose stored fraction guard
 * has no reading to measure against: it stays `restart_closed`, named in
 * `refused`, rather than going back to work with the guard unread.
 */
async function postHandler(req: Request) {
  // The readings a stored fraction guard will be judged against, fetched here
  // because `reopenRestartClosed` awaits nothing, and only the ones some run
  // needs: no fraction guard in the list means no transcript scan, as at
  // `POST /api/fleet`.
  const windows = restartClosedGuardWindows();
  const snapshots: GuardSnapshots = {};
  if (windows.includes("claude")) snapshots.claude = await currentSnapshot();
  if (windows.includes("codex")) snapshots.codex = await codexGuardSnapshot();
  const outcome = reopenRestartClosed(snapshots);
  // Durable and only when the press reached a run. This is a bulk start of
  // billed children, and the count is the fact — the per-run detail is already
  // on each run's own events, and a press over an empty list changed nothing.
  if (outcome.reopened > 0 || outcome.refused.length > 0) {
    recordDurableMutation(req, "info", "runs.restart_closed_reopened", {
      reopened: outcome.reopened,
      refused: outcome.refused.length,
    });
  }
  return NextResponse.json({ ok: true, ...outcome });
}

/**
 * Wrapped like every other mutating route behind the gate. One press here can
 * start twenty-five billed agents and nothing said it had been made.
 */
export const POST = auditMutation(postHandler);
