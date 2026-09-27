import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { landCardLine, purgeLabel, purgeSheetText } from "./landView";

/**
 * The sentences the Land card and the branches page put in front of a press
 * that cannot be undone. Each wrong answer renders as a perfectly ordinary
 * sentence — see the module's own note — so it is pinned here rather than in
 * a screenshot.
 */

describe("landCardLine", () => {
  const landedRun = {
    landedAt: Date.UTC(2026, 8, 20, 9, 0),
    landedInto: "main",
    landedStrategy: "merge",
    merged: true,
    landedUnchanged: false,
    branchExists: true,
    blocked: "Already in main — there is nothing left to land.",
  };
  const onFeature =
    "Your checkout is on feature-x, and this work belongs on main. Switch to it first.";

  it("says merged while the landed work is still the whole branch", () => {
    assert.equal(landCardLine(landedRun).kind, "landed");
    // A squash leaves no ancestry, and the recorded tip is what stands in for it.
    assert.equal(
      landCardLine({ ...landedRun, merged: false, landedUnchanged: true }).kind,
      "landed",
    );
  });

  it("shows the refusal once a reopened run has put new commits on the branch", () => {
    // The card used to say only "Merged into main" here, with Land withheld and
    // no sentence saying why — and Purge offered under it.
    const line = landCardLine({
      ...landedRun,
      merged: false,
      landedUnchanged: false,
      blocked: onFeature,
    });
    assert.deepEqual(line, {
      kind: "moved",
      refusal: onFeature,
      landed: { at: landedRun.landedAt, into: "main", strategy: "merge" },
    });
  });

  it("keeps the earlier land as history when the new commits can be landed", () => {
    const line = landCardLine({ ...landedRun, merged: false, blocked: null });
    assert.equal(line.kind, "moved");
    assert.equal(line.kind === "moved" && line.refusal, null);
  });

  it("says merged for a landed branch that has since been deleted", () => {
    // The ordinary end of a run: land, then Delete. "Branch … no longer
    // exists" would be true and would bury the one fact worth keeping.
    const line = landCardLine({
      ...landedRun,
      merged: false,
      branchExists: false,
      blocked: "Branch uf/x no longer exists.",
    });
    assert.equal(line.kind, "landed");
  });

  it("gives a run that never landed its refusal, or nothing", () => {
    const never = { ...landedRun, landedAt: null, landedInto: null, landedStrategy: null };
    assert.deepEqual(landCardLine({ ...never, merged: false, blocked: onFeature }), {
      kind: "refusal",
      refusal: onFeature,
    });
    assert.deepEqual(landCardLine({ ...never, merged: false, blocked: null }), { kind: "none" });
  });
});

describe("purgeLabel", () => {
  it("names the count it was given", () => {
    assert.equal(purgeLabel(3), "Purge 3 commits");
    assert.equal(purgeLabel(1), "Purge 1 commit");
  });

  it("names no count when none could be taken", () => {
    // "Purge 0 commits" on an uncountable branch tells the operator the one
    // irreversible press here costs nothing.
    assert.equal(purgeLabel(null), "Purge branch");
  });
});

describe("purgeSheetText", () => {
  it("says what goes", () => {
    assert.equal(
      purgeSheetText(3, { count: 2, readable: true }),
      "This deletes the branch, its 3 commits and 2 uncommitted paths, and its checkout. None of it is recoverable from here.",
    );
    assert.equal(
      purgeSheetText(1, null),
      "This deletes the branch, its 1 commit, and its checkout. None of it is recoverable from here.",
    );
  });

  it("says a commit count could not be taken, and states none", () => {
    const text = purgeSheetText(null, null);
    assert.match(text, /its commits, and its checkout/);
    assert.match(text, /could not be counted/);
    assert.doesNotMatch(text, /\d/);
  });

  it("does not read an unreadable checkout as zero paths", () => {
    const text = purgeSheetText(2, { count: 0, readable: false });
    assert.doesNotMatch(text, /0 uncommitted/);
    assert.match(text, /whatever is uncommitted in its checkout/);
    assert.match(text, /could not be read/);
  });
});
