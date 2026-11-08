import type { WaitingDTO, WaitingReadingDTO } from "./apiTypes";
import { countPendingProposals } from "./chat";
import { landableBranches } from "./land";
import { listRunsPage } from "./orchestrator";
import { listTasks } from "./tasks";

/** How far back "failed recently" reaches: the runs page's own recent band. */
export const FAILED_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * One count, or why there is none.
 *
 * Each read is caught on its own, because a strip that went blank when the
 * branches' git call failed would also hide a run waiting for review. The
 * failure is returned as `unknown` rather than rethrown or counted as zero:
 * zero tells the operator nothing is waiting, which is the one thing a read that
 * did not happen cannot say.
 */
async function reading(
  count: () => { count: number; complete?: boolean } | Promise<{ count: number; complete?: boolean }>,
): Promise<WaitingReadingDTO> {
  try {
    const { count: n, complete = true } = await count();
    return complete ? { state: "exact", count: n } : { state: "floor", count: n };
  } catch (err) {
    return { state: "unknown", reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * What is waiting on the operator, one count per place they act on it.
 *
 * Every figure is read through the query its own page lists by — `listRunsPage`
 * for the runs, `listTasks` for the board, `landableBranches` for the branches
 * page's tick boxes — so a count here and the rows behind its link are one
 * answer rather than two derivations that drift. `limit: 1` because only the
 * `total` is wanted.
 */
export async function readWaiting(now: number): Promise<WaitingDTO> {
  const failedSince = now - FAILED_WINDOW_MS;
  const [needsReview, failedRecently, branches, proposals, tasks] = await Promise.all([
    reading(() => ({ count: listRunsPage({ statuses: ["needs-review"], limit: 1 }).total })),
    reading(() => ({
      count: listRunsPage({ statuses: ["failed"], settledAfter: failedSince, limit: 1 }).total,
    })),
    reading(landableBranches),
    reading(() => ({ count: countPendingProposals() })),
    reading(() => ({ count: listTasks({ status: "open", operatorOnly: true, limit: 1 }).total })),
  ]);
  return { needsReview, failedRecently, branches, proposals, tasks, failedSince };
}
