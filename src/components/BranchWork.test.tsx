import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UncommittedNote, offersCommit } from "./BranchWork";
import type { BranchSummaryDTO } from "../lib/apiTypes";

/**
 * What a branch row says about its checkout, and which door it offers.
 *
 * The failure this pins is silent in both halves. `uncommitted` is three-valued
 * and the row read it with `!!`, so an unread checkout drew exactly what a
 * clean one draws — no throw, no type error, and a page that looks right while
 * telling the operator a run wrote nothing. The gate on Commit read it the same
 * way, which took the one action that saves the work off a row that kept Purge
 * and Delete. Neither is visible from anywhere except the rendered row.
 */
function branch(over: Partial<BranchSummaryDTO> = {}): BranchSummaryDTO {
  return {
    runId: "run-1",
    runStatus: "completed",
    branch: "uf/example",
    target: "main",
    repoRoot: "/workspace/Example",
    repoLabel: "Example",
    createdAt: 1_700_000_000_000,
    ahead: 0,
    merged: false,
    landedUnchanged: false,
    uncommitted: 0,
    heldByCheckout: true,
    exists: true,
    active: false,
    landedAt: null,
    prompt: "do the thing",
    ...over,
  };
}

test("an unread checkout does not render as a clean one", () => {
  const unread = renderToStaticMarkup(
    <UncommittedNote branch={branch({ uncommitted: null })} />,
  );
  const clean = renderToStaticMarkup(
    <UncommittedNote branch={branch({ uncommitted: 0 })} />,
  );

  assert.equal(clean, "", "a checkout git reported clean says nothing");
  assert.notEqual(unread, clean, "an unread checkout must not draw a clean one");
  assert.match(unread, /could not be read/i);
});

test("a checkout nothing holds says nothing, unread or not", () => {
  // The third null: no worktree holds the branch, so there was never a status
  // to read. Saying "could not be read" here would be the new lie.
  assert.equal(
    renderToStaticMarkup(
      <UncommittedNote branch={branch({ uncommitted: null, heldByCheckout: false })} />,
    ),
    "",
  );
});

test("a counted checkout still names the number", () => {
  const markup = renderToStaticMarkup(
    <UncommittedNote branch={branch({ uncommitted: 3 })} />,
  );
  assert.match(markup, /3 uncommitted in the checkout/);
  assert.match(markup, /text-warn/, "work at risk keeps the warning tone");
});

test("Commit is offered on an unread checkout, not withheld by it", () => {
  assert.equal(offersCommit(branch({ uncommitted: null })), true);
  assert.equal(offersCommit(branch({ uncommitted: 2 })), true);
  assert.equal(offersCommit(branch({ uncommitted: 0 })), false);
  assert.equal(
    offersCommit(branch({ uncommitted: null, heldByCheckout: false })),
    false,
    "nothing holds the branch, so there is no checkout to commit from",
  );
  assert.equal(offersCommit(branch({ uncommitted: 2, active: true })), false);
  assert.equal(offersCommit(branch({ uncommitted: 2, exists: false })), false);
});
