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
 */

export type CheckoutWriter = "resolution" | "commit" | "purge";

const writers = ((globalThis as unknown as {
  __ufCheckoutWriters?: Map<string, CheckoutWriter>;
}).__ufCheckoutWriters ??= new Map<string, CheckoutWriter>());

/**
 * Take the run's checkout for `writer`, or name who already has it.
 *
 * Check and take are one call so that they are one turn — `createRun`'s
 * folder-claim property. A caller that asks anything else before it must ask
 * it in that same turn, with no `await` in between.
 */
export function claimCheckout(runId: string, writer: CheckoutWriter): CheckoutWriter | null {
  const holder = writers.get(runId);
  if (holder) return holder;
  writers.set(runId, writer);
  return null;
}

/** Only ever called by the caller `claimCheckout` returned null to. */
export function releaseCheckout(runId: string): void {
  writers.delete(runId);
}

export function checkoutWriter(runId: string): CheckoutWriter | null {
  return writers.get(runId) ?? null;
}
