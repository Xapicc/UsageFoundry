import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  afterFixRun,
  fixRunPrompt,
  nextReviewStep,
  reviewBlockSummary,
} from "./reviewBlock";

/**
 * What a workflow's review block does with one branch, step by step.
 *
 * Each rule fails silently in a direction that costs: an approval read out of a
 * hedge lands work nobody signed off on; a fix round past the cap is a billed
 * run nobody agreed to; a review that could not run, read as a rejection, marks
 * the operator's tasks as beyond the local model for a reason that had nothing
 * to do with it.
 */

const review = (verdict: string) => ({
  status: "completed" as const,
  text: `## Summary\nIt does the task.\n\n## Verdict\n${verdict}\n`,
  error: null,
});

describe("nextReviewStep", () => {
  it("passes an approved branch on", () => {
    assert.deepEqual(nextReviewStep(review("APPROVE"), 0, 2), { kind: "approve" });
  });

  it("sends a rejection back for the next fix round while rounds are left", () => {
    assert.deepEqual(nextReviewStep(review("REJECT"), 0, 2), { kind: "fix", round: 1 });
    assert.deepEqual(nextReviewStep(review("REJECT"), 1, 2), { kind: "fix", round: 2 });
  });

  it("sets a branch aside and marks its tasks once the last round is used", () => {
    const step = nextReviewStep(review("REJECT"), 2, 2);
    assert.equal(step.kind, "set-aside");
    assert.equal(step.kind === "set-aside" && step.needsFrontier, true);
    assert.match(step.kind === "set-aside" ? step.reason : "", /after 2 fix round/);
  });

  it("never starts a fix round on a block with none", () => {
    const step = nextReviewStep(review("REJECT"), 0, 0);
    assert.equal(step.kind, "set-aside");
  });

  it("reads a hedged verdict as no approval", () => {
    assert.deepEqual(nextReviewStep(review("APPROVE with caveats"), 0, 1), {
      kind: "fix",
      round: 1,
    });
    const last = nextReviewStep(review("looks fine"), 1, 1);
    assert.equal(last.kind, "set-aside");
    assert.match(last.kind === "set-aside" ? last.reason : "", /no clear APPROVE or REJECT/);
  });

  it("sets aside a review that could not run without blaming the model", () => {
    const step = nextReviewStep({ status: "failed", text: null, error: "timed out" }, 0, 2);
    assert.deepEqual(step, {
      kind: "set-aside",
      reason: "the review could not finish: timed out",
      needsFrontier: false,
    });
  });
});

describe("afterFixRun", () => {
  it("reviews a fix that finished or asked for review", () => {
    assert.deepEqual(afterFixRun("completed", 1), { kind: "review" });
    assert.deepEqual(afterFixRun("needs-review", 2), { kind: "review" });
  });

  it("marks the tasks when the model could not manage even the fix", () => {
    assert.deepEqual(afterFixRun("failed", 1), {
      kind: "set-aside",
      reason: "the fix run failed",
      needsFrontier: true,
    });
  });

  it("does not blame the model for a fix a person stopped or that never started", () => {
    for (const [status, iterations] of [["stopped", 1], ["blocked", 0], ["completed", 0]] as const) {
      const step = afterFixRun(status, iterations);
      assert.equal(step.kind, "set-aside", status);
      assert.equal(step.kind === "set-aside" && step.needsFrontier, false, status);
    }
  });
});

describe("fixRunPrompt and reviewBlockSummary", () => {
  it("keeps the original brief first and the review under its own heading", () => {
    const prompt = fixRunPrompt("Do the task.", "## Risks\nThe default hides a bug.", 1, 2);
    assert.ok(prompt.startsWith("Do the task."));
    assert.match(prompt, /fix round 1 of 2/);
    assert.match(prompt, /<review>\n## Risks\nThe default hides a bug.\n<\/review>$/);
  });

  it("names every branch it set aside and why", () => {
    assert.equal(reviewBlockSummary([]), "There was no branch to review.");
    assert.equal(
      reviewBlockSummary([{ branch: "a", status: "approved", note: null }]),
      "Approved all 1 branch(es).",
    );
    assert.equal(
      reviewBlockSummary([
        { branch: "a", status: "approved", note: null },
        { branch: "b", status: "set-aside", note: "still rejected after 2 fix round(s)" },
      ]),
      "Approved 1 of 2 branch(es); set aside b — still rejected after 2 fix round(s).",
    );
  });
});
