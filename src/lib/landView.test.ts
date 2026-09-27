import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { purgeLabel, purgeSheetText } from "./landView";

/**
 * The sentences the Land card and the branches page put in front of a press
 * that cannot be undone. Each wrong answer renders as a perfectly ordinary
 * sentence — see the module's own note — so it is pinned here rather than in
 * a screenshot.
 */

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
