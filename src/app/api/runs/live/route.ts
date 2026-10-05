import { activeRuns, describeFolder, type RunRow } from "@/lib/orchestrator";
import { telemetrySpendSince } from "@/lib/otlp";
import { contextOccupancy, pruneSavingsByRun } from "@/lib/contextPruning";
import { contextForTile } from "@/lib/liveStream";
import { jsonMaybeGzipped } from "@/lib/http";
import { parseRunAgent } from "@/lib/agents";
import { getLocalSignIn } from "@/lib/localProvider";
import { resolveLiveModel } from "@/lib/format";
import {
  clipListPrompt,
  type LiveRunDTO,
  type LiveRunsDTO,
  type PruneSavingsDTO,
} from "@/lib/apiTypes";

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
 * and `contextOccupancy`'s indexed reads, which scan no transcript.
 *
 * What it costs once per poll, however many runs are running: what pruning has
 * netted each of them, from `pruneSavingsByRun` over all of them at once. That
 * is the function the runs list calls, so a tile prints the number the run's
 * own page does; reading the receipts here instead would be the disagreement it
 * exists to prevent. Two indexed reads (`prune_receipts` and `fork_attempts`),
 * and then a transcript scan **only if one of these runs has pruned**, because
 * pricing counts the turns after each cut out of it. A poll with no pruned run
 * reads no transcript. The scan is the one the run loop makes before every
 * cycle and the runs list makes on its own poll: callers that overlap share
 * it, and one that finds no transcript grown answers from a memo. It is
 * called once for the page and not once per run, which is what keeps this
 * poll's cost from growing with the number of running runs.
 *
 * With nothing running it reads one small table and nothing else, and the page
 * does not poll it then.
 */
export async function GET(req: Request) {
  const runs = activeRuns().filter((r) => r.status === "running");
  const pruned = await pruneSavingsByRun(runs.map((r) => r.id));
  const body: LiveRunsDTO = {
    runs: runs.map((r) => liveRun(r, pruned.get(r.id) ?? null)),
  };
  return jsonMaybeGzipped(req, body);
}

function liveRun(r: RunRow, pruning: PruneSavingsDTO | null): LiveRunDTO {
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
    model: resolveLiveModel({
      model: r.model,
      provider: r.provider,
      agentModel: parseRunAgent(r.agent)?.model ?? null,
      localModel: r.provider === "local" ? (getLocalSignIn()?.model ?? null) : null,
    }),
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
    pruning,
  };
}
