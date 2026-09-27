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

/** When and how this run was last landed, as `runs` recorded it. */
export interface LandedRecord {
  at: number;
  into: string | null;
  strategy: string | null;
}

/**
 * The one state line on the Land card.
 *
 * - `landed`: "Merged into X on <date>" is the whole of it.
 * - `moved`: this run was landed once and its branch is no longer what was
 *   landed. The refusal, when there is one, is what the card says, and the
 *   earlier land is a quieter line beneath it.
 * - `refusal`: why Land is not offered.
 * - `none`: Land is offered and nothing needs saying.
 */
export type LandCardLine =
  | { kind: "landed"; landed: LandedRecord }
  | { kind: "moved"; landed: LandedRecord; refusal: string | null }
  | { kind: "refusal"; refusal: string }
  | { kind: "none" };

export function landCardLine(
  s: Pick<
    LandStateDTO,
    | "landedAt"
    | "landedInto"
    | "landedStrategy"
    | "merged"
    | "landedUnchanged"
    | "branchExists"
    | "blocked"
  >,
): LandCardLine {
  if (s.landedAt !== null) {
    const landed = { at: s.landedAt, into: s.landedInto, strategy: s.landedStrategy };
    // `landed_at` is written once and never cleared, and a landed run can be
    // reopened and commit again. "Merged" is the state only while the landed
    // work is still the whole branch, or there is no branch left to have moved.
    // After that it is history: Land is withheld or offered again, Purge is
    // offered beside it, and the sentence saying why is the one that matters.
    if (s.merged || s.landedUnchanged || !s.branchExists) return { kind: "landed", landed };
    return { kind: "moved", landed, refusal: s.blocked };
  }
  return s.blocked === null ? { kind: "none" } : { kind: "refusal", refusal: s.blocked };
}

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
