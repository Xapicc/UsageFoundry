import { parseCertificationVerdict } from "./localCertification";

/**
 * What a workflow's review block does with one branch, decided one step at a
 * time — pure, so every rule can be tested without a repository or a model.
 *
 * A review block takes the runs its incoming links resolve to and gives each
 * branch the frontier review `review.ts` already runs, asked for an APPROVE or
 * REJECT on the tip it was shown. An approval passes the branch on to whatever
 * follows — normally a merge block. A rejection sends it back for a fix — a run
 * that carries the same branch on, on the same provider, briefed with the
 * review — and it is reviewed again, up to the block's `fixRounds`. A branch
 * still not approved after the last round is **set aside**: it is not merged,
 * the block does not fail, and the tasks the branch was for are marked
 * needs-frontier so a local-model pass does not take them on again.
 *
 * Every way of getting this wrong is silent in a direction that costs: an
 * approval read out of a hedge lands work nobody signed off on; a rejection
 * read as a failure of the block stops a loop that should have carried on; a
 * fix round past the cap is a billed run nobody agreed to.
 */

/** What becomes of one branch after a review settles. */
export type ReviewStep =
  | { kind: "approve" }
  /** Start fix round `round` (1-based) on this branch. */
  | { kind: "fix"; round: number }
  | {
      kind: "set-aside";
      reason: string;
      /**
       * Whether the tasks the branch was for get the needs-frontier mark. Only
       * when a frontier model rejected the work: a review that could not run is
       * not a judgement on the model that did it.
       */
      needsFrontier: boolean;
    };

/** One settled review, reduced to what the decision reads. */
export interface SettledReview {
  status: "completed" | "failed";
  /** The review's markdown, which carries the verdict. */
  text: string | null;
  error: string | null;
}

export function nextReviewStep(
  review: SettledReview,
  roundsUsed: number,
  fixRounds: number,
): ReviewStep {
  if (review.status === "failed") {
    return {
      kind: "set-aside",
      reason: `the review could not finish: ${review.error ?? "no reason recorded"}`,
      needsFrontier: false,
    };
  }
  const verdict = parseCertificationVerdict(review.text);
  if (verdict === "approve") return { kind: "approve" };
  if (roundsUsed < fixRounds) return { kind: "fix", round: roundsUsed + 1 };
  const why =
    verdict === "reject" ? "rejected" : "given no clear APPROVE or REJECT";
  return {
    kind: "set-aside",
    reason:
      fixRounds === 0
        ? `${why} by the frontier review`
        : `still ${why} after ${roundsUsed} fix round(s)`,
    needsFrontier: true,
  };
}

/** What becomes of one branch after its fix run settles. */
export type FixStep =
  | { kind: "review" }
  | { kind: "set-aside"; reason: string; needsFrontier: boolean };

/**
 * Whether a fix run left something worth reviewing again.
 *
 * A fix that completed or asked for review is reviewed — the review, not the
 * run's own word, decides. One that failed is the model not managing even the
 * fix, which is what needs-frontier is for. One the operator stopped, or that
 * never started, is a person or this app intervening, and says nothing about
 * the model, so it is set aside unmarked.
 */
export function afterFixRun(
  status: string,
  iterations: number,
): FixStep {
  if ((status === "completed" || status === "needs-review") && iterations > 0) {
    return { kind: "review" };
  }
  if (status === "failed") {
    return {
      kind: "set-aside",
      reason: "the fix run failed",
      needsFrontier: true,
    };
  }
  return {
    kind: "set-aside",
    reason:
      iterations === 0
        ? `the fix run ended ${status} before it did any work`
        : `the fix run was ${status}`,
    needsFrontier: false,
  };
}

/**
 * The brief a fix run is started with: the original brief, then the review.
 *
 * The original first because it is still the task — the fix is part of doing
 * it, not a new one — and the review under its own heading because it is the
 * reason this run exists. It is told it stands on the previous attempt's
 * commits, since a fix run carries the branch on rather than starting over.
 */
export function fixRunPrompt(
  originalPrompt: string,
  reviewText: string,
  round: number,
  fixRounds: number,
): string {
  return [
    originalPrompt.trim(),
    "",
    `## A frontier review rejected this work (fix round ${round} of ${fixRounds})`,
    "",
    "The branch you are on already holds the previous attempt. Carry it on:",
    "fix every point the review below makes, commit, and change nothing it",
    "does not ask for. A second review reads the branch when you finish.",
    "",
    "<review>",
    reviewText.trim(),
    "</review>",
  ].join("\n");
}

/** How a finished review block describes itself, for its row and its page. */
export function reviewBlockSummary(
  items: readonly { branch: string; status: string; note: string | null }[],
): string {
  const approved = items.filter((i) => i.status === "approved").length;
  const aside = items.filter((i) => i.status === "set-aside");
  if (items.length === 0) return "There was no branch to review.";
  if (aside.length === 0) return `Approved all ${approved} branch(es).`;
  return (
    `Approved ${approved} of ${items.length} branch(es); set aside ` +
    aside.map((i) => `${i.branch} — ${i.note ?? "no reason recorded"}`).join("; ") +
    "."
  );
}
