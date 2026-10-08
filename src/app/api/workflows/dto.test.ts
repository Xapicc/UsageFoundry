import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WorkflowEdge } from "../../../lib/workflowGraph";
import { passMemberId } from "../../../lib/passIds";
import { instanceWaiter } from "./dto";

/**
 * What the instance page is told each member waits for.
 *
 * The wait used to be a bare node id, so "after Build, Test" read the same for
 * a link that starts the next run only if the first completes and one that
 * starts it either way — the one half of an edge that decides whether the member
 * runs at all. Nothing about dropping it throws, and the page still looks right.
 * The cases are the three places a wait comes from — a saved edge, a section's
 * edge inside a pass, and a creator with no edge — because each takes a
 * different branch and only the first two have a condition to keep.
 */

const link = (
  from: string,
  to: string,
  edge: WorkflowEdge["edge"],
): WorkflowEdge => ({ from, to, edge, continueBranch: false });

describe("instanceWaiter", () => {
  it("keeps the condition of every edge into a block, in the graph's order", () => {
    const waitsFor = instanceWaiter({
      nodes: [
        { id: "build", kind: "run" },
        { id: "lint", kind: "run" },
        { id: "ship", kind: "run" },
      ],
      edges: [link("build", "ship", "on-success"), link("lint", "ship", "on-finish")],
    });

    assert.deepEqual(waitsFor("ship", null), [
      { nodeId: "build", edge: "on-success" },
      { nodeId: "lint", edge: "on-finish" },
    ]);
  });

  it("does not report a loop's containment link as something the block waits for", () => {
    const waitsFor = instanceWaiter({
      nodes: [
        { id: "loop", kind: "loop" },
        { id: "a", kind: "run" },
      ],
      edges: [link("loop", "a", "repeats")],
    });

    // The loop creates `a` once per pass, so there is nothing to wait for and
    // no condition: the only wait is the creator, with none claimed for it.
    assert.deepEqual(waitsFor("a", "loop"), [{ nodeId: "loop", edge: null }]);
    assert.deepEqual(waitsFor("a", null), []);
  });

  it("gives a pass member its own predecessor's condition, not the loop's", () => {
    const waitsFor = instanceWaiter({
      nodes: [
        { id: "loop", kind: "loop" },
        { id: "a", kind: "run" },
        { id: "m", kind: "merge" },
      ],
      edges: [link("loop", "a", "repeats"), link("a", "m", "on-finish")],
    });

    assert.deepEqual(waitsFor(passMemberId("loop", 2, "m"), "loop"), [
      { nodeId: "a", edge: "on-finish" },
    ]);
    // The section's entry has no predecessor inside it, so it waits for the
    // loop that made it and says nothing about a condition.
    assert.deepEqual(waitsFor(passMemberId("loop", 2, "a"), "loop"), [
      { nodeId: "loop", edge: null },
    ]);
  });

  it("names the deciding block for a run it emitted, with no condition", () => {
    const waitsFor = instanceWaiter({
      nodes: [{ id: "decide", kind: "orchestrator" }],
      edges: [],
    });

    assert.deepEqual(waitsFor("decide#fix-parser", "decide"), [
      { nodeId: "decide", edge: null },
    ]);
  });

  it("is empty for a block that starts first", () => {
    const waitsFor = instanceWaiter({ nodes: [{ id: "root", kind: "run" }], edges: [] });
    assert.deepEqual(waitsFor("root", null), []);
  });
});
