import type { LandStateDTO } from "./apiTypes";

/**
 * What the Land card and the branches page draw about landing, decided where a
 * test can reach it.
 *
 * Every function here is a choice between sentences, and each one's wrong
 * answer is a sentence that renders perfectly well: a card that says a branch
 * is merged while it holds work that is not, or a confirmation that states a
 * commit count nobody measured. Nothing throws and nothing fails to typecheck,
 * so the decision lives outside the components that render it.
 */

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * The confirming button of a purge. It names the count only when there is one:
 * "Purge 0 commits" on the one press in this app that destroys committed work
 * tells the operator there is nothing to lose.
 */
export function purgeLabel(ahead: number | null): string {
  return ahead === null ? "Purge branch" : `Purge ${plural(ahead, "commit")}`;
}

/**
 * What the Land card's purge sheet says goes. `pending` is the run's own
 * checkout as `landState` read it — null when nothing is uncommitted there,
 * unreadable when `git status` failed, which is not the same as clean.
 */
export function purgeSheetText(
  ahead: number | null,
  pending: Pick<NonNullable<LandStateDTO["pending"]>, "count" | "readable"> | null,
): string {
  const commits = ahead === null ? "its commits" : `its ${plural(ahead, "commit")}`;
  const uncommitted = !pending
    ? ""
    : pending.readable
      ? ` and ${plural(pending.count, "uncommitted path")}`
      : " and whatever is uncommitted in its checkout";

  return [
    `This deletes the branch, ${commits}${uncommitted}, and its checkout.`,
    ahead === null ? "How many commits that is could not be counted." : null,
    pending && !pending.readable ? "Its checkout's status could not be read." : null,
    "None of it is recoverable from here.",
  ]
    .filter(Boolean)
    .join(" ");
}
