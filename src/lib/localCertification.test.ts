import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  certificationRefusal,
  isFrontierReviewModel,
  NOT_REQUIRED,
  parseCertificationVerdict,
  type CertificationState,
  type CertifyingReview,
} from "./localCertification";

/**
 * The rule that holds a local model's branch until a frontier model approves it.
 *
 * Every way of getting it wrong is silent in the direction that matters: the
 * Land button works when it should not, and nothing throws. So the parser is
 * pinned on the hedged answers it must *not* read as approval, and the refusal
 * on every state an approval can go stale in — above all a branch that moved
 * after the review, which is the one a person is least likely to notice.
 */

const TIP = "a".repeat(40);

const approved: CertifyingReview = {
  id: "rev-1",
  status: "completed",
  verdict: "approve",
  headSha: TIP,
  model: null,
};

const needing = (review: CertifyingReview | null, tip: string | null = TIP): CertificationState => ({
  required: true,
  localRuns: ["localrun-1234"],
  tip,
  review,
});

describe("parseCertificationVerdict", () => {
  it("reads the two words under the last Verdict heading", () => {
    assert.equal(parseCertificationVerdict("## Summary\nfine\n\n## Verdict\nAPPROVE\n"), "approve");
    assert.equal(parseCertificationVerdict("## Verdict\n\n  **REJECT**  \n"), "reject");
    assert.equal(parseCertificationVerdict("## verdict\n`approve`"), "approve");
  });

  it("reads no verdict out of a hedge", () => {
    for (const hedge of [
      "## Verdict\nAPPROVE with caveats",
      "## Verdict\nI would approve this",
      "## Verdict\nAPPROVE / REJECT",
      "## Verdict\n",
      "APPROVE",
      "## Summary\nVerdict: APPROVE",
    ]) {
      assert.equal(parseCertificationVerdict(hedge), null, hedge);
    }
    assert.equal(parseCertificationVerdict(null), null);
  });

  it("takes the last heading, so an echoed instruction is not the answer", () => {
    const text = "## Verdict\nAPPROVE\n\n(quoted from the prompt)\n\n## Verdict\nREJECT\n";
    assert.equal(parseCertificationVerdict(text), "reject");
  });
});

describe("isFrontierReviewModel", () => {
  it("accepts the CLI default and a priced Claude model that is not a Haiku", () => {
    assert.equal(isFrontierReviewModel(null), true);
    assert.equal(isFrontierReviewModel("claude-opus-5-5"), true);
    assert.equal(isFrontierReviewModel("claude-sonnet-5"), true);
  });

  it("refuses a Haiku and an id no price table places", () => {
    assert.equal(isFrontierReviewModel("claude-haiku-4-5-20251001"), false);
    assert.equal(isFrontierReviewModel("qwen3-coder-30b"), false);
  });
});

describe("certificationRefusal", () => {
  it("says nothing for a branch no local model touched", () => {
    assert.equal(certificationRefusal(NOT_REQUIRED, "land"), null);
    assert.equal(certificationRefusal(NOT_REQUIRED, "deliver"), null);
  });

  it("lets an approving frontier review of the current tip through, on both exits", () => {
    assert.equal(certificationRefusal(needing(approved), "land"), null);
    assert.equal(certificationRefusal(needing(approved), "deliver"), null);
  });

  it("holds a branch with no review, naming the local run and the exit", () => {
    const land = certificationRefusal(needing(null), "land");
    assert.match(land ?? "", /local model wrote \(run localrun\)/);
    assert.match(land ?? "", /cannot be landed/);
    assert.match(certificationRefusal(needing(null), "deliver") ?? "", /cannot be delivered/);
  });

  it("holds a branch that moved after it was approved", () => {
    const moved = "b".repeat(40);
    assert.match(
      certificationRefusal(needing(approved, moved), "land") ?? "",
      /review was of aaaaaaaa, and the branch is at bbbbbbbb now/,
    );
  });

  it("holds while the review runs, after it failed, and when it recorded no commit", () => {
    for (const review of [
      { ...approved, status: "running" as const },
      { ...approved, status: "failed" as const },
      { ...approved, headSha: null },
    ]) {
      assert.notEqual(certificationRefusal(needing(review), "land"), null, JSON.stringify(review));
    }
    assert.notEqual(certificationRefusal(needing(approved, null), "land"), null);
  });

  it("holds a rejection and a review that gave no verdict", () => {
    assert.match(
      certificationRefusal(needing({ ...approved, verdict: "reject" }), "land") ?? "",
      /rejected/,
    );
    for (const verdict of [null, "finished", "APPROVE"]) {
      assert.match(
        certificationRefusal(needing({ ...approved, verdict }), "land") ?? "",
        /did not end in a clear APPROVE or REJECT/,
        String(verdict),
      );
    }
  });

  it("holds an approval from a model that is not a frontier one", () => {
    assert.match(
      certificationRefusal(needing({ ...approved, model: "claude-haiku-4-5" }), "land") ?? "",
      /not a frontier model/,
    );
  });
});
