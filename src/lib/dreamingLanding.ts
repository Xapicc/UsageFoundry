import {
  claimPendingLanding,
  dropPendingLanding,
  markLandingAttempted,
  pendingLandings,
  type PendingLanding,
} from "./dreamingLedger";
import { commitPending, landState } from "./land";
import { enqueue, isQueueActive, latestQueueRowFor } from "./mergeQueue";
import { TERMINAL_STATUSES, getRun, type RunRow } from "./orchestrator";
import { getSettings } from "./settings";

/**
 * Getting a Dreaming night's branch into the vault, and only then claiming it.
 *
 * A night whose vault is a repository works on a branch of its own, so its notes
 * reach the vault by a land and not by being written. Two things follow, and
 * both fail silently. The signatures cannot be claimed when the run starts: a
 * claim says "a note was written", and a refused land would leave a suppressed
 * signature with no note behind it, never retried. And nothing in the run loop
 * lands a branch by itself, so something has to carry it from "the run ended" to
 * "the merge queue has it" without an operator, which is what Dreaming already
 * does today by writing into the vault directly.
 *
 * Driven from the nightly timer's tick and from the start of each night, never
 * from the run loop: a Dreaming-shaped branch in the orchestrator's cycle
 * handling is this feature reaching into the loop every other feature is careful
 * not to touch. The state it works from is `dreaming_pending`, which survives a
 * restart, and everything it asks of the run is read from `runs` and
 * `merge_queue`, so a settle that was interrupted is simply run again.
 */

export type Settled =
  /** The branch is in the vault, or there was nothing on it to put there. */
  | { kind: "claimed"; claimed: number }
  /** Let go without claiming: the notes were discarded, so a later night may write them. */
  | { kind: "dropped"; why: string }
  /** The branch was put in the merge queue by this pass. */
  | { kind: "queued"; batchId: string }
  | { kind: "waiting"; why: string };

export interface SettleReport {
  runId: string;
  night: string;
  result: Settled;
}

const state = globalThis as unknown as { __ufDreamingSettling?: boolean };

/**
 * Walk every pending night once and move each as far as it can go.
 *
 * `revisit` is the difference between the two callers. The minute tick leaves a
 * branch alone once it has been tried, because the usual reason a land fails is
 * the operator's checkout (uncommitted edits, another branch) and nothing the
 * tick does within the hour changes that, and retrying would fill the queue's
 * history with a refusal a minute. The start of the next night sets it, which is
 * one more try per day and the first one after the operator has had a day to put
 * the checkout right.
 *
 * Returns without doing anything when another settle is under way: the two
 * callers can overlap (a manual press during a tick), and the work is idempotent
 * only up to the awaits in `attempt`.
 */
export async function settleDreamingLandings(opts: {
  revisit: boolean;
  now?: number;
}): Promise<SettleReport[]> {
  if (state.__ufDreamingSettling) return [];
  state.__ufDreamingSettling = true;
  try {
    const now = opts.now ?? Date.now();
    const reports: SettleReport[] = [];
    for (const pending of pendingLandings()) {
      reports.push({
        runId: pending.runId,
        night: pending.night,
        result: await settleOne(pending, opts.revisit, now),
      });
    }
    return reports;
  } finally {
    state.__ufDreamingSettling = false;
  }
}

async function settleOne(p: PendingLanding, revisit: boolean, now: number): Promise<Settled> {
  const run = getRun(p.runId);
  if (!run) {
    dropPendingLanding(p.runId);
    return { kind: "dropped", why: "its run has been deleted" };
  }
  if (!TERMINAL_STATUSES.includes(run.status)) {
    return { kind: "waiting", why: "its run is still going" };
  }

  // Somebody else's land counts: an operator who pressed Land on the run page
  // put the notes in the vault as surely as the queue would have.
  if (run.landed_at !== null) return claim(p, now);

  const queued = latestQueueRowFor(run.id);
  if (queued) {
    if (isQueueActive(queued.status)) {
      return { kind: "waiting", why: "its branch is in the merge queue" };
    }
    if (queued.status === "landed" || queued.status === "already-landed") {
      return claim(p, now);
    }
  }

  if (p.attemptedAt !== null && !revisit) {
    return { kind: "waiting", why: "its last land was refused, and the next night tries again" };
  }
  return attempt(p, run, now);
}

/** Commit what the agent left, then put the branch in the merge queue. */
async function attempt(p: PendingLanding, run: RunRow, now: number): Promise<Settled> {
  // Before the awaits, so a throw below cannot leave the tick retrying every
  // minute for as long as the cause lasts.
  markLandingAttempted(p.runId, now);

  let read = await landState(run.id);
  // No branch to read means nothing was ever going to be written into the vault
  // by landing it, which is today's "the run ended" case: claimed.
  if (!read) return claim(p, now);
  if (!read.branchExists) {
    dropPendingLanding(p.runId);
    return { kind: "dropped", why: "its branch no longer exists" };
  }
  if (read.merged || read.landedUnchanged) return claim(p, now);

  const leftover = read.pending !== null && read.pending.count > 0;

  // An operator who stopped the night decided it should not write, and an
  // isolated run is the first kind of Dreaming run that can honour that: before,
  // whatever it had written was already in the vault. So a stopped night's
  // branch is left for the operator (landed by hand, which claims it, or
  // purged, which lets it go) and is not landed on their behalf.
  if (run.status === "stopped" && (leftover || read.ahead !== 0)) {
    return { kind: "waiting", why: "the night was stopped, so its branch is left for you to land or purge" };
  }

  if (leftover) {
    if (read.pending!.merging) {
      return { kind: "waiting", why: "its checkout is in the middle of a merge" };
    }
    // The agent is granted `git commit` and told to use it, so this is the
    // fallback and not the path: work left uncommitted would read as "no
    // commits of its own" at the land and be lost to the night.
    const committed = await commitPending(
      run.id,
      `Dreaming ${p.night}: notes for ${p.selected.length} recurring failure${p.selected.length === 1 ? "" : "s"}`,
    );
    if (!committed.ok) {
      return { kind: "waiting", why: `what it left uncommitted could not be committed: ${committed.reason}` };
    }
    const reread = await landState(run.id);
    if (!reread) return { kind: "waiting", why: "its branch could not be read after committing" };
    read = reread;
  }

  if (read.ahead === null) {
    return { kind: "waiting", why: "git could not count the commits on its branch" };
  }
  // The run wrote nothing, which the ledger records as it always has: attempted,
  // no file. Not retried, because that is how a night that found every item
  // already covered ends, and retrying it would pay for it again every night.
  if (read.ahead === 0) return claim(p, now);

  // `autoResolve: false`: a resolution is a paid agent, and what a night may
  // spend is `dreamingMaxCostUSD` and nothing else.
  const queued = enqueue([run.id], { strategy: getSettings().landStrategy, autoResolve: false });
  if (!queued.ok) return { kind: "waiting", why: queued.reason };
  return { kind: "queued", batchId: queued.batchId };
}

function claim(p: PendingLanding, now: number): Settled {
  return { kind: "claimed", claimed: claimPendingLanding(p.runId, now) };
}
