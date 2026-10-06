import type {
  ContextPrunerDTO,
  NetBound,
  PruneActivityDTO,
  PruneSavingsDTO,
  RunListItemDTO,
} from "./apiTypes";
import { signedUSD } from "./format";

/**
 * How the two engines are named on screen.
 *
 * By what they do to the conversation, never by module name: `legacy`,
 * `winnow` and `cozempic` are all names for the same two behaviours, and none
 * of them tells a first-time reader which one edits their transcript. The
 * settings page reads this rather than keeping its own copy, so the engine is
 * named identically in the three places it now appears.
 */
export const PRUNE_ENGINE_LABEL: Record<ContextPrunerDTO["engine"], string> = {
  legacy: "Edit in place",
  winnow: "Fork",
};

/**
 * Which way a pruning net can still move, which is how it is labelled.
 *
 * Two counts, two opposite errors. An unsettled prune's cost has not been
 * charged, so the net can only come down: `at most`. An unmeasured removal has
 * credited no saving, so the net can only go up: `at least`. With both
 * outstanding the figure is bounded on neither side, and it is called not
 * final rather than given a direction it does not have. Every surface that
 * prints a pruning net reads this, so that one run's figure is not a ceiling
 * on one screen and a floor on the next.
 */
export function netBound(
  savings: Pick<PruneSavingsDTO, "unsettledPrunes" | "unmeasuredPrunes">,
): NetBound {
  if (savings.unsettledPrunes > 0) {
    return savings.unmeasuredPrunes > 0 ? "not final" : "at most";
  }
  return savings.unmeasuredPrunes > 0 ? "at least" : "exact";
}

export interface PruneStatement {
  kind: "activity";
  /** The whole sentence. Complete per variant, never assembled at a call site. */
  text: string;
  /** `warn` is a fault an operator can fix; `neutral` is standing context. */
  severity: "neutral" | "warn";
}

/**
 * What is running, in one sentence that is never absent.
 *
 * Split from `pruneStatement` below, and the split is the whole point. That one
 * answers "what happened in this span" and is allowed to say nothing when the
 * money beside it already has. This one answers "what is switched on", which no
 * figure carries and which was therefore missing from every screen: an install
 * with fourteen prunes on the card still could not tell you which of the two
 * engines made them or whether the tool was still present.
 *
 * Never null, and that is deliberate. An absent line is the ambiguity this
 * whole module exists to remove.
 */
export function prunerLine(pruner: ContextPrunerDTO): string {
  const engine = PRUNE_ENGINE_LABEL[pruner.engine].toLowerCase();
  if (pruner.state === "off") {
    return (
      "Context pruning is switched off, so nothing is removed from a run's " +
      "conversation between work cycles."
    );
  }
  if (pruner.state === "unavailable") {
    return (
      `Context pruning is switched on (${engine}), but ${
        pruner.detail ?? "the tool behind it could not be found"
      }. Nothing has been removed at any cycle boundary.`
    );
  }
  return `Context pruning is on, ${engine}.`;
}

/** True where `prunerLine` describes a fault an operator can act on. */
export function prunerIsFault(pruner: ContextPrunerDTO): boolean {
  return pruner.state === "unavailable";
}

/** `3 ended in a cut`, or null when the count is zero and the clause is dropped. */
function clause(n: number, phrase: string): string | null {
  return n > 0 ? `${n} ${phrase}` : null;
}

/**
 * What happened at this span's cycle boundaries, or null when nothing did.
 *
 * `noFigureReason`'s rule one mechanism over: the outcomes call for different
 * actions — a rebuild, a wait, or nothing at all because the arithmetic said so
 * — so they may not share a sentence, and none of them may be `$0.00`.
 *
 * Null in exactly two cases, and neither is ambiguous once `prunerLine` sits
 * beside it: no boundary was reached in the span, or every one of them cut and
 * the figures already say so. A caption restating its own number is noise on the
 * one card built to carry that number.
 */
export function pruneStatement(
  activity: PruneActivityDTO | null | undefined,
): PruneStatement | null {
  if (!activity || activity.boundaries === 0) return null;
  if (activity.cut === activity.boundaries) return null;

  const clauses = [
    clause(activity.cut, "ended in a cut"),
    clause(activity.declined, "left alone on the payback test"),
    clause(activity.nothing, "where nothing was worth removing"),
    clause(activity.refused, "refused by the fork engine"),
    clause(activity.unavailable, "where winnow was not installed"),
    clause(activity.failed, "that could not be read"),
  ].filter((c): c is string => c !== null);

  const detail = activity.lastDetail ? ` Most recently: ${activity.lastDetail}` : "";
  return {
    kind: "activity",
    // A fault only where an operator has something to fix. A decline is the
    // gate working, and a run of them is not a warning.
    severity: activity.unavailable + activity.failed > 0 ? "warn" : "neutral",
    text:
      `${activity.boundaries} cycle ` +
      `${activity.boundaries === 1 ? "boundary" : "boundaries"} in this span: ` +
      `${clauses.join(", ")}.${detail}`,
  };
}

/**
 * `RunListItemDTO`'s pruning fields, from one run's summed savings.
 *
 * Nothing at all for a run that never pruned, and no bound beside a final
 * net, so the common row costs the poll what it did before.
 */
export function prunedNetFields(
  savings: PruneSavingsDTO | undefined,
): Pick<RunListItemDTO, "prunedNetUSD" | "prunedNetBound"> {
  if (!savings) return {};
  if (savings.pricedPrunes === 0) {
    return { prunedNetUSD: savings.netUSD, prunedNetBound: "unpriced" };
  }
  const bound = netBound(savings);
  return bound === "exact"
    ? { prunedNetUSD: savings.netUSD }
    : { prunedNetUSD: savings.netUSD, prunedNetBound: bound };
}

const PRUNED_NET_MARK: Record<
  Exclude<NetBound, "exact">,
  { mark: string; meaning: string }
> = {
  "at most": { mark: "≤", meaning: "at most: a prune's cost is not settled yet" },
  "at least": { mark: "≥", meaning: "at least: a fork's removal is not measured yet" },
  "not final": {
    mark: "~",
    meaning: "not final: a prune's cost is unsettled and a fork's removal unmeasured",
  },
};

/**
 * The runs list's Pruning cell: what it prints, and what its mark means.
 *
 * Three readings that must not share a glyph: a dash is a run that never
 * pruned, `?` is pruning whose money is unknown, and a signed figure is money.
 */
export function prunedNetCell(
  row: Pick<RunListItemDTO, "prunedNetUSD" | "prunedNetBound">,
): { text: string; meaning: string | null } {
  if (row.prunedNetUSD === undefined) return { text: "—", meaning: null };
  if (row.prunedNetBound === "unpriced") {
    return {
      text: "?",
      meaning: "pruned on a model with no price here, so what it netted is unknown",
    };
  }
  const figure = signedUSD(row.prunedNetUSD);
  if (!row.prunedNetBound) return { text: figure, meaning: null };
  const { mark, meaning } = PRUNED_NET_MARK[row.prunedNetBound];
  return { text: `${mark} ${figure}`, meaning };
}
