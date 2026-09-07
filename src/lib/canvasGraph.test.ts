import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  NODE_H,
  NODE_W,
  autoLayout,
  draftSignature,
  draftToGraph,
  freeSpot,
  layoutBounds,
  resolveLayout,
  resolveLinkRelease,
  type BlockDraft,
  type CanvasDraft,
  type LinkDraft,
  type WorkflowDraftBody,
} from "./canvasGraph";

/**
 * Three decisions on the canvas fail silently, and each one is here.
 *
 * A condition the operator never chose must reach the wire unchosen: filled in
 * with either value it is wrong half the time, and both ways of being wrong are
 * a billed agent — `on-success` terminates a chain that was meant to run
 * regardless, `on-finish` starts a run on top of a dependency that crashed. It
 * typechecks either way and nothing on the page would say.
 *
 * The layout has to survive a cycle, because a cycle is legal to *draw*: the
 * server is the authority on refusing one and can only answer about a graph it
 * has been sent, so a loop is on screen between the second click and the
 * answer. An unbounded relaxation there is a frozen tab, which no test of the
 * refusal itself would catch.
 *
 * And every block has to have a position. One without would render at the
 * origin under whatever is already there — invisible, still saved, still able
 * to start an agent.
 */

function block(id: string, over: Partial<BlockDraft> = {}): BlockDraft {
  return {
    id,
    name: id,
    kind: "run",
    templateId: "",
    mountId: "main",
    folder: "",
    task: "do the thing",
    promptOverride: "",
    agentId: "",
    fanOut: "3",
    mergeStrategy: "merge",
    mergeAutoResolve: false,
    maxPasses: "",
    maxLoopCostUSD: "",
    ...over,
  };
}

function link(from: string, to: string, over: Partial<LinkDraft> = {}): LinkDraft {
  return { from, to, edge: "", continueBranch: false, ...over };
}

/* ------------------------------------------------------------------ */
/* The condition is the operator's, or it is absent                     */
/* ------------------------------------------------------------------ */

test("a link with no condition reaches the wire with none", () => {
  const draft: CanvasDraft = {
    blocks: [block("a"), block("b")],
    links: [link("a", "b")],
  };
  const wire = draftToGraph(draft);
  assert.equal(wire.edges.length, 1);
  assert.equal(wire.edges[0].edge, "", "an unanswered picker must not default");
  assert.equal(wire.edges[0].continueBranch, false);
});

test("a chosen condition and hand-over survive unchanged", () => {
  const wire = draftToGraph({
    blocks: [block("a"), block("b")],
    links: [link("a", "b", { edge: "on-finish", continueBranch: true })],
  });
  assert.deepEqual(wire.edges[0], {
    from: "a",
    to: "b",
    edge: "on-finish",
    continueBranch: true,
  });
});

test("a fan-out cap is carried only by the block that has one", () => {
  const wire = draftToGraph({
    blocks: [
      block("a"),
      block("b", { kind: "orchestrator", fanOut: "4" }),
      // Blank rather than absent: the operator cleared the field, and the
      // refusal naming the block is what has to come back.
      block("c", { kind: "orchestrator", fanOut: "" }),
    ],
    links: [],
  });
  assert.equal(wire.nodes[0].fanOut, null, "a run block states no cap");
  assert.equal(wire.nodes[1].fanOut, 4);
  assert.ok(
    wire.nodes[2].fanOut === null || (wire.nodes[2].fanOut ?? 0) < 1,
    "a blank cap must not arrive as a number the server would accept",
  );
});

test("no template is null on the wire, not an empty string", () => {
  const wire = draftToGraph({
    blocks: [block("a"), block("b", { templateId: "tpl-1" })],
    links: [],
  });
  assert.equal(wire.nodes[0].templateId, null);
  assert.equal(wire.nodes[1].templateId, "tpl-1");
});

test("an agent is carried by the kinds that spawn a child, and by no other", () => {
  // The merge case is why this is here rather than left to the server. That
  // block spawns nothing, so naming an agent on it is *refused* — not
  // dropped, because an agent the operator believes is in play and that no
  // process is ever given is the fault the whole registry exists to end. A
  // block switched from run to merge with an agent still picked would therefore
  // be unsavable over a control the inspector no longer shows, which is a dead
  // end rather than a refusal anyone can act on.
  const wire = draftToGraph({
    blocks: [
      block("a", { agentId: "agent-1" }),
      block("b", { kind: "orchestrator", agentId: "agent-1" }),
      block("c", { kind: "merge", agentId: "agent-1" }),
      block("d"),
    ],
    links: [],
  });
  assert.equal(wire.nodes[0].agentId, "agent-1");
  assert.equal(wire.nodes[1].agentId, "agent-1", "a deciding turn may have one");
  assert.equal(wire.nodes[2].agentId, null, "a merge block never sends one");
  assert.equal(wire.nodes[3].agentId, null, "and none is null, not an empty id");
});

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

test("a chain is laid out left to right, one column per step", () => {
  const blocks = [block("a"), block("b"), block("c")];
  const at = autoLayout(blocks, [link("a", "b"), link("b", "c")]);
  assert.ok(at.get("a")!.x < at.get("b")!.x);
  assert.ok(at.get("b")!.x < at.get("c")!.x);
});

test("blocks that wait for nothing share the first column", () => {
  // The parallel case, which is not a concept — it is what the graph says when
  // two blocks have nothing in front of them.
  const at = autoLayout([block("a"), block("b")], []);
  assert.equal(at.get("a")!.x, at.get("b")!.x);
  assert.notEqual(at.get("a")!.y, at.get("b")!.y);
});

test("a fan-in sits past the deepest thing it waits for", () => {
  const blocks = [block("a"), block("b"), block("c"), block("d")];
  const at = autoLayout(blocks, [
    link("a", "b"),
    link("b", "d"),
    link("c", "d"),
  ]);
  assert.ok(at.get("d")!.x > at.get("b")!.x);
  assert.ok(at.get("d")!.x > at.get("c")!.x);
});

test("a cycle is laid out rather than looped over", () => {
  const blocks = [block("a"), block("b"), block("c"), block("d")];
  const at = autoLayout(blocks, [
    link("a", "b"),
    link("b", "c"),
    link("c", "a"),
    link("a", "d"),
  ]);
  assert.equal(at.size, 4, "every block in a loop still gets a place");
  const seen = new Set(Array.from(at.values(), (p) => `${p.x},${p.y}`));
  assert.equal(seen.size, 4, "no two blocks may occupy one spot");
});

test("a block pointing at itself is drawn, not counted as a step", () => {
  const at = autoLayout([block("a")], [link("a", "a")]);
  assert.deepEqual(at.get("a"), { x: 24, y: 24 });
});

test("every block has a position, whatever was stored", () => {
  const blocks = [block("a"), block("b"), block("c")];
  const at = resolveLayout(blocks, [link("a", "b")], {
    a: { x: 500, y: 300 },
    // A block that has since been deleted, and a coordinate that is not one.
    gone: { x: 10, y: 10 },
    b: { x: Number.NaN, y: 0 },
    c: { x: -40, y: 12 },
  });
  assert.equal(at.size, 3);
  assert.deepEqual(at.get("a"), { x: 500, y: 300 }, "a dragged block stays put");
  assert.ok(Number.isFinite(at.get("b")!.x), "an unusable entry falls back");
  assert.ok(at.get("c")!.x >= 0, "a block may not be placed off the surface");
  assert.equal(at.has("gone"), false);
});

test("no stored layout at all is the same as a fresh graph", () => {
  const blocks = [block("a"), block("b")];
  const links = [link("a", "b")];
  assert.deepEqual(
    Array.from(resolveLayout(blocks, links, null)),
    Array.from(autoLayout(blocks, links)),
  );
});

test("the surface is big enough for the block furthest out", () => {
  const at = resolveLayout([block("a")], [], { a: { x: 900, y: 400 } });
  const { width, height } = layoutBounds(at);
  assert.ok(width >= 900 + NODE_W);
  assert.ok(height >= 400 + NODE_H);
});

test("a block added without a pointer lands clear of the others", () => {
  const at = resolveLayout([block("a"), block("b")], [], null);
  const spot = freeSpot(at);
  for (const p of at.values()) {
    assert.ok(spot.y > p.y, "a new block must not land on an existing one");
  }
});

test("an empty canvas still offers somewhere to put the first block", () => {
  const spot = freeSpot(new Map());
  assert.ok(spot.x >= 0 && spot.y >= 0);
});

/* ------------------------------------------------------------------ */
/* The Link handle                                                     */
/* ------------------------------------------------------------------ */

/**
 * Three gestures reach one control, and telling them apart is the whole of what
 * this decides. Getting it wrong is silent in the direction that matters: the
 * handle relabels itself **Link here**, the operator clicks it, the banner
 * changes to name a different block and no edge is drawn — a canvas that reads
 * as working and cannot connect two blocks by the one button labelled for it.
 * Nothing throws and the graph that is saved is simply smaller than the one on
 * screen.
 */

test("clicking Link here completes the link the other block armed", () => {
  // Armed from a, pressed and released on b's own handle. The direction is the
  // whole point: b starts after a, not the other way round.
  assert.deepEqual(resolveLinkRelease("b", "a", "b"), {
    kind: "connect",
    from: "a",
    to: "b",
  });
});

test("dragging out of a handle links from that handle's block", () => {
  // Even with another block armed: the pointer left this handle, so this block
  // is the source and the armed one is abandoned.
  assert.deepEqual(resolveLinkRelease("b", "a", "c"), {
    kind: "connect",
    from: "b",
    to: "c",
  });
  assert.deepEqual(resolveLinkRelease("b", null, "c"), {
    kind: "connect",
    from: "b",
    to: "c",
  });
});

test("clicking a handle with nothing armed arms it", () => {
  assert.deepEqual(resolveLinkRelease("a", null, "a"), {
    kind: "arm",
    from: "a",
  });
});

test("clicking the armed block's own handle disarms it", () => {
  // The same handle reads "Cancel" while it is armed, and that is what it does.
  assert.deepEqual(resolveLinkRelease("a", "a", "a"), { kind: "disarm" });
});

test("a drag that arrives nowhere leaves the handle armed", () => {
  // Released over bare canvas: nothing is connected and nothing is lost, so the
  // link can still be finished with a click on the target.
  assert.deepEqual(resolveLinkRelease("b", null, null), {
    kind: "arm",
    from: "b",
  });
  assert.deepEqual(resolveLinkRelease("b", "a", null), {
    kind: "arm",
    from: "b",
  });
});

test("no gesture on a handle ever links a block to itself", () => {
  // The server refuses a self-edge, but it can only answer about a graph it was
  // sent, and one drawn on the canvas is one the operator has to undo by hand.
  for (const armed of [null, "a", "b"]) {
    for (const over of [null, "a", "b"]) {
      const gesture = resolveLinkRelease("a", armed, over);
      if (gesture.kind !== "connect") continue;
      assert.notEqual(gesture.from, gesture.to, `armed=${armed} over=${over}`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* What leaving the page would destroy                                 */
/* ------------------------------------------------------------------ */

/**
 * The editor prompts before an exit only while `draftSignature` says the graph
 * has moved, so the failure is silent in both directions and neither shows on
 * the page. A value the signature cannot see is a block, a prompt or a link
 * discarded by a press on the sidebar with no dialog at all — the graph is the
 * one thing in this app nobody can retype in a minute. A value it sees that a
 * save would not keep is the opposite failure and costs more than it looks: a
 * dialog raised over a page with nothing to lose is a dialog the operator
 * learns to dismiss, and the next one they dismiss is the real one.
 */
function signature(
  blocks: BlockDraft[],
  links: LinkDraft[] = [],
  over: Partial<WorkflowDraftBody["instanceBudget"]> = {},
  name = "Nightly maintenance",
): string {
  return draftSignature({
    name,
    graph: draftToGraph({ blocks, links }),
    instanceBudget: {
      maxInstanceCostUSD: "20",
      maxSessionFraction: null,
      maxWeeklyFraction: null,
      ...over,
    },
  });
}

test("two drafts holding the same graph sign identically", () => {
  const one = signature([block("a"), block("b")], [link("a", "b")]);
  const two = signature([block("a"), block("b")], [link("a", "b")]);
  assert.equal(one, two);
});

test("every value a block's kind carries moves the signature", () => {
  const carried: Array<{
    what: string;
    base: Partial<BlockDraft>;
    edit: Partial<BlockDraft>;
  }> = [
    { what: "name", base: {}, edit: { name: "renamed" } },
    { what: "kind", base: {}, edit: { kind: "merge" } },
    { what: "templateId", base: {}, edit: { templateId: "tpl-1" } },
    { what: "mountId", base: {}, edit: { mountId: "other" } },
    { what: "folder", base: {}, edit: { folder: "sub/dir" } },
    { what: "task", base: {}, edit: { task: "something else entirely" } },
    { what: "promptOverride", base: {}, edit: { promptOverride: "be brief" } },
    { what: "agentId", base: {}, edit: { agentId: "agent-1" } },
    {
      what: "fanOut",
      base: { kind: "orchestrator" },
      edit: { fanOut: "5" },
    },
    {
      what: "mergeStrategy",
      base: { kind: "merge" },
      edit: { mergeStrategy: "squash" },
    },
    {
      what: "mergeAutoResolve",
      base: { kind: "merge" },
      edit: { mergeAutoResolve: true },
    },
    {
      what: "maxPasses",
      base: { kind: "loop", maxPasses: "3" },
      edit: { maxPasses: "4" },
    },
    {
      what: "maxLoopCostUSD",
      base: { kind: "loop", maxPasses: "3" },
      edit: { maxLoopCostUSD: "5" },
    },
  ];
  for (const { what, base, edit } of carried) {
    assert.notEqual(
      signature([block("a", { ...base, ...edit })]),
      signature([block("a", base)]),
      `a change to ${what} would be discarded without a prompt`,
    );
  }
});

test("a value the block's kind does not carry is not unsaved work", () => {
  const dropped: Array<Partial<BlockDraft>> = [
    { fanOut: "9" },
    { mergeStrategy: "squash" },
    { mergeAutoResolve: true },
    { maxPasses: "7" },
    { maxLoopCostUSD: "12" },
  ];
  for (const edit of dropped) {
    assert.equal(
      signature([block("a", { kind: "run", ...edit })]),
      signature([block("a", { kind: "run" })]),
      `${JSON.stringify(edit)} is dropped by a save and must not prompt`,
    );
  }
  // The same rule one kind along: a merge block cannot name a specialist, so
  // one left over from before the kind was switched is not work either.
  assert.equal(
    signature([block("a", { kind: "merge", agentId: "agent-1" })]),
    signature([block("a", { kind: "merge" })]),
  );
});

test("a link's condition and its branch flag are both work", () => {
  const blocks = [block("a"), block("b")];
  const bare = signature(blocks, [link("a", "b")]);
  assert.notEqual(signature(blocks, [link("a", "b", { edge: "on-success" })]), bare);
  assert.notEqual(signature(blocks, [link("a", "b", { continueBranch: true })]), bare);
  assert.notEqual(signature(blocks, []), bare);
});

test("the workflow name and each of its limits are work", () => {
  const blocks = [block("a")];
  const bare = signature(blocks);
  assert.notEqual(signature(blocks, [], {}, "Something else"), bare);
  assert.notEqual(signature(blocks, [], { maxInstanceCostUSD: "40" }), bare);
  assert.notEqual(signature(blocks, [], { maxSessionFraction: 0.5 }), bare);
  assert.notEqual(signature(blocks, [], { maxWeeklyFraction: 0.5 }), bare);
});

test("whitespace either side of the name is not work", () => {
  // `normalizeWorkflowInput` trims it, so a trailing space is not a change a
  // save would preserve — and a prompt over one is a prompt over nothing.
  assert.equal(
    signature([block("a")], [], {}, "  Nightly maintenance "),
    signature([block("a")]),
  );
});
