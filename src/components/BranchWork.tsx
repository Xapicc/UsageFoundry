"use client";

// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime, so a tested component has to import the
// way src/lib and RunHandoff.tsx already do.
import type { BranchSummaryDTO } from "../lib/apiTypes";
import { Button } from "./ui/Button";

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
  return (
    <>
      <CountNote branch={branch} />
      {/* Why the row has no Commit, where the button would have been the
          only way to find out. "Mid-merge" is `RunLand`'s word for the same
          checkout, not a new one; the fix is on the run's own card, which the
          branch name links to. Drawn whatever the count, because a merge whose
          paths are all staged is still one. A stopped rebase or bisect is the
          other such state, and its own word: `git merge --abort` is not what
          ends it, and the card names what does. Drawn whatever the count, as a
          bisect over a clean tree has none. */}
      {branch.merging && (
        <div className="mt-1 text-balance text-2xs font-semibold uppercase tracking-wide text-warn">
          Mid-merge, so no Commit
        </div>
      )}
      {branch.operation && (
        <div className="mt-1 text-balance text-2xs font-semibold uppercase tracking-wide text-warn">
          Mid-{branch.operation}, so no Commit
          {(branch.merged || branch.landedUnchanged) && " or Delete"}
        </div>
      )}
    </>
  );
}

function CountNote({ branch }: { branch: BranchSummaryDTO }) {
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
 *
 * Nor on a checkout seen mid-merge, which `commitRefusal` refuses and the Land
 * card does not draw a button for: a Commit there would put the half-done merge
 * on the branch. The same for one stopped mid-rebase or mid-bisect, which
 * detaches HEAD and so has no branch to commit to. Withheld only on a positive
 * reading — `merging` false and `operation` null are also what an unprobed row
 * says, and that row keeps its door.
 */
export function offersCommit(branch: BranchSummaryDTO): boolean {
  return (
    branch.exists &&
    !branch.active &&
    branch.heldByCheckout &&
    !branch.merging &&
    !branch.operation &&
    branch.uncommitted !== 0
  );
}

/**
 * The row's Commit button, or nothing where `offersCommit` withholds it.
 *
 * Drawn here rather than in the page so the rule is pinned where the button
 * is: a gate that answers correctly beside a page that draws the button anyway
 * would pass a test of the gate alone.
 */
export function CommitAction({
  branch,
  working,
  onCommit,
}: {
  branch: BranchSummaryDTO;
  working: boolean;
  onCommit: () => void;
}) {
  if (!offersCommit(branch)) return null;
  return (
    <Button variant="secondary" className="min-w-[92px]" onClick={onCommit} disabled={working}>
      {working ? "Working…" : "Commit"}
    </Button>
  );
}
