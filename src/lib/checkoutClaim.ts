/**
 * Who is writing to a finished run's checkout from outside a work cycle.
 *
 * A conflict resolution being set up and a Commit pressed on the Land card
 * both write into the run's own slot, and a Purge removes it, and none of them
 * is a run, so `activeRuns()` does not see them. Each has git calls to make
 * before anything durable says it is there — the resolution's `run_reviews`
 * row comes after its merge, and a commit and a purge write no row at all — so
 * this claim is the only thing that can answer for that stretch. Two of them at
 * once is the markers reaching the branch: a merge opened under a Commit's
 * `add -A` is staged and committed, conflict markers included, as a two-parent
 * merge that then lands as a fast-forward. Or it is a billed resolution child
 * spawned into a checkout a Purge then force-removes.
 *
 * Its own module because `reopenRun` has to read it as well, and `land.ts`,
 * which takes it, imports `orchestrator.ts`. It imports nothing, so both can.
 * On `globalThis` for the reason `landing` in `land.ts` is.
 *
 * Keyed on the run's branch in its repository, never on the run. A
 * `continueBranch` chain shares one branch and, through the slot
 * `planWorkspace` hands down, one checkout, so a claim taken under the pressed
 * run's id left every other link's doors open: a Purge on one link's card
 * force-removed the slot under a resolution started from another's, and two
 * links' Commit and Resolve took two keys and raced exactly as one run's did
 * before this claim existed. The branch is the right key rather than the slot
 * path, because git gives a branch to one worktree at a time — so it names the
 * checkout a resolution opens its merge in, slot or throwaway — and because a
 * slot is reused by an unrelated run once its own is terminal, which shares
 * nothing with it. A branch is minted from one run's id and handed on only
 * along its chain, so the key is the chain's and nobody else's.
 */

export type CheckoutWriter = "resolution" | "commit" | "purge";

/** The columns of a run's row the claim is keyed on. */
export interface CheckoutOwner {
  id: string;
  repo_root: string | null;
  worktree_branch: string | null;
}

const writers = ((globalThis as unknown as {
  __ufCheckoutWriters?: Map<string, CheckoutWriter>;
}).__ufCheckoutWriters ??= new Map<string, CheckoutWriter>());

/**
 * A run with no branch recorded has no checkout of its own to share, and keeps
 * its own key: every door refuses it once it asks, and until then it must not
 * collide with anyone.
 */
function keyOf(run: CheckoutOwner): string {
  return run.repo_root && run.worktree_branch
    ? `branch\0${run.repo_root}\0${run.worktree_branch}`
    : `run\0${run.id}`;
}

/**
 * Take the run's checkout for `writer`, or name who already has it.
 *
 * Check and take are one call so that they are one turn — `createRun`'s
 * folder-claim property. A caller that asks anything else before it must ask
 * it in that same turn, with no `await` in between.
 */
export function claimCheckout(run: CheckoutOwner, writer: CheckoutWriter): CheckoutWriter | null {
  const key = keyOf(run);
  const holder = writers.get(key);
  if (holder) return holder;
  writers.set(key, writer);
  return null;
}

/** Only ever called by the caller `claimCheckout` returned null to. */
export function releaseCheckout(run: CheckoutOwner): void {
  writers.delete(keyOf(run));
}

export function checkoutWriter(run: CheckoutOwner): CheckoutWriter | null {
  return writers.get(keyOf(run)) ?? null;
}
