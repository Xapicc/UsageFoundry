import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CommitAction, UncommittedNote, offersCommit } from "./BranchWork";
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
    merging: false,
    operation: null,
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

test("a checkout left mid-merge draws no Commit, and the row says why", () => {
  // `commitRefusal` refuses it — a Commit would put the half-done merge and its
  // conflict markers on the branch — and the Land card already draws no button
  // there. The row drew one anyway, so the refusal was only found by pressing.
  const midMerge = branch({ uncommitted: 3, merging: true });
  const commit = (b: BranchSummaryDTO) =>
    renderToStaticMarkup(<CommitAction branch={b} working={false} onCommit={() => {}} />);

  assert.match(commit(branch({ uncommitted: 3 })), />Commit</, "the ordinary row lost its Commit");
  assert.equal(commit(midMerge), "", "a mid-merge checkout was offered Commit");
  assert.equal(
    commit(branch({ uncommitted: null, merging: true })),
    "",
    "an unread count does not bring Commit back on a checkout seen mid-merge",
  );

  const note = renderToStaticMarkup(<UncommittedNote branch={midMerge} />);
  assert.match(note, /3 uncommitted in the checkout/);
  assert.match(note, /mid-merge/i, "the row does not say why Commit is missing");
  assert.match(
    renderToStaticMarkup(<UncommittedNote branch={branch({ uncommitted: 0, merging: true })} />),
    /mid-merge/i,
    "a merge with nothing left to stage is still a merge",
  );
});

test("a checkout left mid-rebase draws no Commit, and the row names the rebase", () => {
  // `commitRefusal` refuses it too, naming the rebase and the command that ends
  // it; the row drew Commit anyway, so the refusal was found by pressing. Not
  // "mid-merge": `git merge --abort` is the wrong way out of a rebase, and the
  // two states are told apart by what the row says.
  const midRebase = branch({ uncommitted: 1, operation: "rebase" });
  const commit = (b: BranchSummaryDTO) =>
    renderToStaticMarkup(<CommitAction branch={b} working={false} onCommit={() => {}} />);

  assert.equal(commit(midRebase), "", "a checkout mid-rebase was offered Commit");
  assert.equal(
    commit(branch({ uncommitted: null, operation: "bisect" })),
    "",
    "an unread count does not bring Commit back on a checkout seen mid-bisect",
  );
  assert.equal(offersCommit(midRebase), false);

  const note = renderToStaticMarkup(<UncommittedNote branch={midRebase} />);
  assert.match(note, /mid-rebase/i, "the row does not say why Commit is missing");
  assert.doesNotMatch(note, /merge/i, "a rebase was described as a merge");
  assert.match(
    renderToStaticMarkup(
      <UncommittedNote branch={branch({ uncommitted: 0, operation: "bisect" })} />,
    ),
    /mid-bisect/i,
    "a bisect over a clean tree is still a bisect",
  );
});
