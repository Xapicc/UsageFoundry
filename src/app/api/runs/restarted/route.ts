import { NextResponse } from "next/server";
import { reopenRestartClosed, restartClosedRuns } from "@/lib/orchestrator";
import { auditMutation, recordDurableMutation } from "@/lib/requestLog";

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
 * hide the ones that did start.
 */
async function postHandler(req: Request) {
  const outcome = reopenRestartClosed();
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
