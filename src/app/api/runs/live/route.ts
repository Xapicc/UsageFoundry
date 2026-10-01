import { activeRuns, describeFolder, type RunRow } from "@/lib/orchestrator";
import { telemetrySpendSince } from "@/lib/otlp";
import { contextOccupancy } from "@/lib/contextPruning";
import { contextForTile } from "@/lib/liveStream";
import { jsonMaybeGzipped } from "@/lib/http";
import { clipListPrompt, type LiveRunDTO, type LiveRunsDTO } from "@/lib/apiTypes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The figures on `/runs/live`'s tiles: spend, telemetry and context for every
 * running run, in one answer.
 *
 * **A poll rather than frames on the page's stream**, because these are
 * readings and not events. The run page draws the same split — its row and its
 * context on a 3s poll, its log over SSE — and a reading on a poll corrects
 * itself on the next one, where a reading pushed down a stream is only as good
 * as the last frame that arrived. It also keeps the figures compressible, which
 * a stream must never be.
 *
 * What it costs, per running run per poll: one indexed aggregate over
 * `otlp_requests` (the query the live-guard tick already makes for that run),
 * and `contextOccupancy`'s indexed reads, which scan no transcript. Nothing
 * here reads a transcript or builds a usage snapshot. With nothing running it
 * reads one small table and nothing else, and the page does not poll it then.
 */
export async function GET(req: Request) {
  const runs = activeRuns().filter((r) => r.status === "running");
  const body: LiveRunsDTO = { runs: runs.map(liveRun) };
  return jsonMaybeGzipped(req, body);
}

function liveRun(r: RunRow): LiveRunDTO {
  const { mountLabel, relPath } = describeFolder(r.folder);
  // The cycle in flight's own start, never the run's: the cycles before it have
  // already reported their cost into `spent_usd`, and reading from the run's
  // start would show that money twice — once in each figure.
  const spend =
    r.active_started_at === null
      ? null
      : telemetrySpendSince(r.id, r.active_started_at);
  const context = contextOccupancy(r.id);
  return {
    id: r.id,
    prompt: clipListPrompt(r.prompt),
    folder: r.folder,
    work_dir: r.work_dir,
    mountLabel,
    relPath,
    provider: r.provider,
    started_at: r.started_at,
    iterations: r.iterations,
    active_iteration: r.active_iteration,
    max_iterations: r.max_iterations,
    validation_cycles: r.validation_cycles,
    spent_usd: r.spent_usd,
    // Zero requests is "nothing arrived", which is not "$0": most runs export
    // no telemetry at all unless a setting or a mid-cycle guard asks for it.
    cycleTelemetry: spend !== null && spend.requests > 0 ? spend : null,
    context: context ? contextForTile(context) : null,
  };
}
