import { resolvePrice } from "./pricing";

/**
 * Whether a branch a local model wrote may leave its run, and in whose words.
 *
 * A local model is the one provider here whose work nobody has any reason to
 * trust yet, so its branches do not land and are not delivered until a
 * frontier model has read them and said yes. The frontier model is the
 * existing review assist and nothing new: `review.ts` already spawns
 * `CLAUDE_BIN` against the plan in `--permission-mode plan` for any run, and
 * `assistModel` hands a local run's review the Claude default rather than the
 * local model's id. What this module adds is a verdict that review can be held
 * to, and the one decision reading it.
 *
 * Pure, so the rule can be tested without a repository: every way of getting it
 * wrong is a button that works when it should not, and nothing throws.
 */

/** What an approving review has to say, exactly. */
export type CertificationVerdict = "approve" | "reject";

/**
 * The review row this decision reads, reduced to what it reads.
 *
 * `headSha` is what the reviewer was shown, written when the review started —
 * `startAssist`'s rule — so a branch that moved during the review is judged
 * against the commit it was actually shown.
 */
export interface CertifyingReview {
  id: string;
  status: "running" | "completed" | "failed";
  verdict: string | null;
  headSha: string | null;
  model: string | null;
}

export type CertificationState =
  | { required: false }
  | {
      required: true;
      /** The runs on this branch that were spawned against the local provider. */
      localRuns: string[];
      /** The branch tip as it stands now, or null when git could not say. */
      tip: string | null;
      /** The latest review of the run that owns the branch, or none. */
      review: CertifyingReview | null;
    };

export const NOT_REQUIRED: CertificationState = { required: false };

/**
 * The fourth heading a certifying review is asked for.
 *
 * Asked for in words the parser below reads strictly, and the strictness is
 * the point: a verdict hedged into "APPROVE, with caveats" is not an approval,
 * and a parser that found the word in it would land work the reviewer did not
 * sign off on.
 */
export const CERTIFICATION_PROMPT_LINES: readonly string[] = [
  "",
  "## Verdict",
  "One line, exactly `APPROVE` or `REJECT`, and nothing else on it.",
  "This work was written by a local model and cannot be merged until you approve it.",
  "Approve only if you would merge it yourself as it stands: it does what the task",
  "asked, nothing in the diff is wrong or unsafe, and nothing it needs is missing.",
  "If the diff above was cut short, read the files it left out before approving;",
  "if you could not, REJECT. Anything short of an approval is REJECT, with the",
  "reason under Risks.",
];

/**
 * The verdict a review's text states, or null when it states none.
 *
 * The *last* `## Verdict` heading, because a reviewer quoting the instructions
 * back would otherwise be read by its quote; and the first non-blank line under
 * it, with emphasis and code marks stripped, compared whole. Null is a real
 * answer — no verdict — and certifies nothing.
 */
export function parseCertificationVerdict(
  text: string | null,
): CertificationVerdict | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  let heading = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s{0,3}#{1,6}\s*verdict\s*#*\s*$/i.test(lines[i]!)) {
      heading = i;
      break;
    }
  }
  if (heading < 0) return null;
  const answer = lines
    .slice(heading + 1)
    .map((line) => line.trim())
    .find((line) => line !== "");
  if (answer === undefined) return null;
  const word = answer.replace(/[*_`]/g, "").trim().toUpperCase();
  if (word === "APPROVE") return "approve";
  if (word === "REJECT") return "reject";
  return null;
}

/**
 * Whether a review that ran on `model` counts as a frontier model's.
 *
 * Null is the CLI's own default on the operator's plan, which is a frontier
 * model — an assumption about the plan, not something this app measured. A
 * named model has to be one `pricing.ts` places, which is what makes it a
 * Claude model this app knows rather than an id that happens to parse, and
 * not a Haiku, which is the small tier and not the frontier one.
 */
export function isFrontierReviewModel(model: string | null): boolean {
  if (model === null) return true;
  if (resolvePrice(model) === null) return false;
  return !model.toLowerCase().includes("haiku");
}

/** How a refusal names the exit it refuses — `land.ts`'s `EXIT_WORDS` in small. */
const EXIT_DONE: Record<"land" | "deliver", string> = {
  land: "landed",
  deliver: "delivered",
};

const short = (sha: string) => sha.slice(0, 8);

/**
 * Why this branch may not leave by `exit` until a frontier model approves it,
 * or null when it may.
 *
 * The review has to be of the tip as it stands. An approval of an earlier
 * commit certifies that commit and nothing added after it — including a
 * conflict resolution, which is a frontier model's work but was not reviewed as
 * part of the whole.
 */
export function certificationRefusal(
  state: CertificationState,
  exit: "land" | "deliver",
): string | null {
  if (!state.required) return null;
  const done = EXIT_DONE[exit];
  const who = state.localRuns.map((id) => id.slice(0, 8)).join(", ");
  const review = state.review;

  if (!review) {
    return (
      `This branch carries work a local model wrote (run ${who}), so it cannot be ${done} ` +
      "until a frontier model has reviewed it. Press Review on this run; a review that " +
      "approves the branch as it stands unlocks it."
    );
  }
  if (review.status === "running") {
    return `A frontier review of this branch is running. It can be ${done} once that review approves it.`;
  }
  if (review.status === "failed") {
    return "The last review of this branch failed before it reached a verdict. Review it again.";
  }
  if (!state.tip) {
    return "Could not read this branch's tip, so there is no way to tell whether the review covers it.";
  }
  if (review.headSha !== state.tip) {
    return (
      `The last review was of ${review.headSha ? short(review.headSha) : "an unrecorded commit"}, ` +
      `and the branch is at ${short(state.tip)} now. Review it again.`
    );
  }
  if (!isFrontierReviewModel(review.model)) {
    return (
      `The last review ran on ${review.model}, which is not a frontier model. ` +
      "Set a frontier default model in Settings and review it again."
    );
  }
  const verdict = verdictOf(review.verdict);
  if (verdict === "reject") {
    return (
      "The frontier review rejected this work; its reasons are on the review card. " +
      "Fix them in a run that carries this branch on, then review it again."
    );
  }
  if (verdict !== "approve") {
    return "The frontier review did not end in a clear APPROVE or REJECT, so nothing is certified. Review it again.";
  }
  return null;
}

/** The stored column, narrowed: anything but the two words is no verdict. */
function verdictOf(stored: string | null): CertificationVerdict | null {
  return stored === "approve" || stored === "reject" ? stored : null;
}
