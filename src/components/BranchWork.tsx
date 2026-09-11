"use client";

// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime, so a tested component has to import the
// way src/lib and RunHandoff.tsx already do.
import type { BranchSummaryDTO } from "../lib/apiTypes";

/**
 * What the branches table says about work sitting in a run's own checkout.
 *
 * Out of the page and under a test because `uncommitted` is three-valued and
 * the row used to read it as two: `!!b.uncommitted` is false for `0` and false
 * for `null`, so "we looked and it was clean" and "we could not look" drew the
 * same blank cell. The second is routine rather than exotic — `branchInventory`
 * probes only the first `MAX_PENDING_PROBES` rows in page order and leaves the
 * rest null, so on a busy install it is deterministically the later rows — and
 * drawing it as clean is the reading the cell exists to prevent: a run that
 * could not commit reading as a run that did nothing.
 *
 * `heldByCheckout` is what separates the two nulls. Nothing holding the branch
 * has nothing to report, and that row stays blank; a held row with no count is
 * a probe that was skipped or a `git status` that failed, and says so.
 *
 * The State column's `min-w` (`src/app/branches/page.tsx`) is sized to fit
 * either string on one line, so `text-balance` below is not doing the
 * column's job for it — it is what keeps a phrase like "in the checkout"
 * together on one line if a count long enough to overflow that floor
 * anyway (a checkout with thousands of uncommitted paths) forces a wrap,
 * rather than leaving the browser's default greedy fill to break it
 * mid-phrase.
 */
export function UncommittedNote({ branch }: { branch: BranchSummaryDTO }) {
  if (branch.uncommitted === null) {
    if (!branch.heldByCheckout) return null;
    // Muted, not `warn`: it is the absence of a reading rather than work at
    // risk, and a row that shouts on every capped probe is a row nobody reads.
    // The wording is the storage table's own — the page must not grow a second
    // name for a status it could not get.
    return (
      <div className="mt-1 text-balance text-2xs uppercase tracking-wide text-ink-muted">
        Checkout could not be read
      </div>
    );
  }
  if (branch.uncommitted === 0) return null;
  return (
    <div className="mt-1 text-balance text-2xs font-semibold uppercase tracking-wide text-warn">
      {branch.uncommitted} uncommitted in the checkout
    </div>
  );
}

/**
 * Whether the row offers Commit — the one action that saves what is in the
 * checkout, and what frees the slot.
 *
 * Offered on an unreadable count as well as on a positive one, for the reason
 * the note above exists: withholding it there hides the only door out of the
 * state, on a row that still offers Purge and Delete. Not offered when nothing
 * holds the branch, because there is then no checkout to commit from.
 */
export function offersCommit(branch: BranchSummaryDTO): boolean {
  return (
    branch.exists && !branch.active && branch.heldByCheckout && branch.uncommitted !== 0
  );
}
