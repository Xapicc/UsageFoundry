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

/** A status verdict on one branch: approved, or set aside and never marked. */
export type StatusVerdict =
  | { kind: "approve" }
  | { kind: "set-aside"; reason: string; needsFrontier: false };

/**
 * A review block whose verdict source is `status` judges a branch by how its
 * run ended, with no model: `completed` is approved, and every other ending is
 * set aside naming it.
 *
 * Never needs-frontier. That mark says a frontier model turned the work down,
 * and here no model looked: a run that asked for review or failed may have been
 * stopped by anything — a missing credential, a flaky test — and marking its
 * tasks would keep a local pass off work nobody judged beyond it. `null` is a
 * run whose row is gone, which is no verdict on anything either.
 */
export function statusVerdict(status: string | null): StatusVerdict {
  if (status === "completed") return { kind: "approve" };
  return {
    kind: "set-aside",
    reason:
      status === null
        ? "its run has been deleted"
        : `its run ended ${status} rather than completed`,
    needsFrontier: false,
  };
}

/** A command verdict on one branch: approved, or set aside and never marked. */
export type CommandVerdict =
  | { kind: "approve" }
  | { kind: "set-aside"; reason: string; needsFrontier: false };

/**
 * A review block whose verdict source is `command` judges a branch by its
 * verify command: a pass is approved, and everything else is set aside.
 *
 * Everything else includes a timeout and a command that never ran — a slot a
 * later run took over, uncommitted edits, a branch that moved under it — for
 * `landVerdict`'s reason: "could not check" read as a pass hands on a branch
 * nothing looked at. A command that ran says how it ended on the first line and
 * carries the tail of what it printed on the lines after it, so the instance
 * page can show the failure and the block's note can stay one line a branch.
 *
 * Never needs-frontier, `statusVerdict`'s reason: no model judged the work, and
 * a red test suite is not evidence a local model cannot do the task.
 */
export function commandVerdict(outcome: {
  ran: boolean;
  passed: boolean;
  /** How a command that ran ended — see `VerifyOutcome` — or `""`. */
  ending: string;
  tail: string;
  /** Why it could not run, read when `ending` is `""`. */
  reason: string;
}): CommandVerdict {
  if (outcome.passed && outcome.ran) return { kind: "approve" };
  // `landVerdict`'s answer for a blank command is a pass that never ran — no
  // gate configured. Save refuses a blank one here, so this is a row nothing
  // validated, and it is the one "pass" that must not hand a branch on.
  if (outcome.passed) {
    return {
      kind: "set-aside",
      reason: "it could not be verified: the block has no verify command to run",
      needsFrontier: false,
    };
  }
  const tail = outcome.tail.trim();
  return {
    kind: "set-aside",
    reason: outcome.ending
      ? `its verify command ${outcome.ending}` + (tail ? `\n${tail}` : ", and printed nothing")
      : `it could not be verified: ${outcome.reason}`,
    needsFrontier: false,
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
 *
 * "Never started" is asked before "failed", because a run that fails before
 * its first work cycle — the local provider signed out, the worktree not made,
 * the Codex rules refused — ends `failed` with no model ever asked anything.
 * `iterations` is `ranWorkCycle`'s count, refunded cycles included, so a fix
 * whose only cycle worked and was then handed back still counts as having run.
 */
export function afterFixRun(
  status: string,
  iterations: number,
): FixStep {
  if ((status === "completed" || status === "needs-review") && iterations > 0) {
    return { kind: "review" };
  }
  if (status === "failed" && iterations > 0) {
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

/**
 * A branch's note as the block's summary names it: the first line, because a
 * verify command's output follows that line on lines of its own and is on the
 * branch's own row of the instance page.
 */
function firstLine(note: string | null): string | null {
  return note === null ? null : note.split("\n", 1)[0];
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
    aside.map((i) => `${i.branch} — ${firstLine(i.note) ?? "no reason recorded"}`).join("; ") +
    "."
  );
}
