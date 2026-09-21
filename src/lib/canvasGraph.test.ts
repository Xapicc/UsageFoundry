import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  NODE_H,
  NODE_W,
  autoLayout,
  bodyOrder,
  bodyRegions,
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
    stopWhenTasksMountId: "",
    stopWhenTasksFolder: "",
    stopWhenTasksStatuses: "open",
    stopWhenTasksAtMost: "0",
    bodyNodeIds: [],
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
    {
      what: "stopWhenTasksMountId",
      base: { kind: "loop", maxPasses: "3" },
      edit: { stopWhenTasksMountId: "work" },
    },
    // The three behind the mount, each on a base that has the condition on —
    // with it off they are carried by nothing, which is the case below.
    {
      what: "stopWhenTasksFolder",
      base: { kind: "loop", maxPasses: "3", stopWhenTasksMountId: "work" },
      edit: { stopWhenTasksFolder: "backlog" },
    },
    {
      what: "stopWhenTasksStatuses",
      base: { kind: "loop", maxPasses: "3", stopWhenTasksMountId: "work" },
      edit: { stopWhenTasksStatuses: "open,claimed" },
    },
    {
      what: "stopWhenTasksAtMost",
      base: { kind: "loop", maxPasses: "3", stopWhenTasksMountId: "work" },
      edit: { stopWhenTasksAtMost: "4" },
    },
    // The section a loop repeats, which is the whole of "repeat a section" and
    // is assembled one block at a time with nothing else on the page changing.
    // Without it a body put together and not saved leaves with no dialog at all.
    {
      what: "bodyNodeIds",
      base: { kind: "loop", maxPasses: "3" },
      edit: { bodyNodeIds: ["b"] },
    },
    {
      what: "a block added to the body",
      base: { kind: "loop", maxPasses: "3", bodyNodeIds: ["b"] },
      edit: { bodyNodeIds: ["b", "c"] },
    },
    {
      what: "a block taken out of the body",
      base: { kind: "loop", maxPasses: "3", bodyNodeIds: ["b", "c"] },
      edit: { bodyNodeIds: ["b"] },
    },
    // The order on the wire is the order the operator marked them in. It is not
    // what decides a pass — the body's own edges are — but it is a change a save
    // would keep, so leaving over it must still ask.
    {
      what: "the order of the body",
      base: { kind: "loop", maxPasses: "3", bodyNodeIds: ["b", "c"] },
      edit: { bodyNodeIds: ["c", "b"] },
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
    // A board condition a run block still holds from before its kind was
    // switched. It is not merely dropped by a save — it is *refused* by one,
    // so prompting about it would offer to save a graph that cannot be saved.
    { stopWhenTasksMountId: "work", stopWhenTasksAtMost: "3" },
    // And a section, one field along and for the same reason: a run block that
    // names blocks to repeat is refused by name.
    { bodyNodeIds: ["b"] },
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

/* ------------------------------------------------------------------ */
/* The section a loop repeats                                          */
/* ------------------------------------------------------------------ */

/**
 * Two silent failures, and they are the ones the operator approves against.
 *
 * The order is what the inspector numbers the section in and what
 * `BlockStatement` reads out, and it has to be the order a pass will actually
 * create the runs in — `loopBody`'s, which is the body's own edges. An order
 * read off the list instead looks exactly like a section that ran and runs it
 * backwards. And a body being assembled is disjoint, forked or cyclic for as
 * long as it takes to assemble, so an order that only terminates on a chain is
 * a frozen tab while somebody is drawing one.
 *
 * The region is the other: it has no stored coordinate by design, so if it is
 * not derived correctly from the layout there is nothing to fall back on.
 */

const loop = (id: string, bodyNodeIds: string[]) =>
  block(id, { kind: "loop", maxPasses: "3", bodyNodeIds });

test("a body is ordered by its own edges, not by the order it was marked in", () => {
  const blocks = [loop("l", ["c", "a", "b"]), block("a"), block("b"), block("c")];
  const links = [link("a", "b"), link("b", "c")];
  assert.deepEqual(bodyOrder(["c", "a", "b"], blocks, links), ["a", "b", "c"]);
});

test("a body ignores the edges that reach it from outside", () => {
  // The loop block is the only door in and out, so its own edges to the first
  // and last member say nothing about the order within the section.
  const blocks = [loop("l", ["a", "b"]), block("a"), block("b"), block("z")];
  const links = [link("l", "a"), link("a", "b"), link("b", "l"), link("z", "b")];
  assert.deepEqual(bodyOrder(["a", "b"], blocks, links), ["a", "b"]);
});

test("a body that is not a chain yet still gets an order, and terminates", () => {
  const blocks = [loop("l", ["a", "b", "c"]), block("a"), block("b"), block("c")];
  // A cycle among the members is legal to *draw* — the server refuses it and
  // can only answer about a graph it has been sent — so this must return rather
  // than spin, and return the same thing twice. Which order a cycle gets is not
  // a promise: it is whatever the bounded relaxation reached, and the sentence
  // the operator reads is the refusal under the canvas, not this.
  const cyclic = [link("a", "b"), link("b", "a")];
  const once = bodyOrder(["a", "b", "c"], blocks, cyclic);
  assert.deepEqual([...once].sort(), ["a", "b", "c"], "every member, once");
  assert.deepEqual(bodyOrder(["a", "b", "c"], blocks, cyclic), once);

  // A fork, which is the ordinary state of a section half assembled: it is
  // ranked as far as the edges reach and the marking order breaks the tie.
  assert.deepEqual(
    bodyOrder(["c", "b", "a"], blocks, [link("a", "b"), link("a", "c")]),
    ["a", "c", "b"],
  );
  // Nothing linked at all: every member ranks 0, so the tie-break is the whole
  // answer and it is the order the operator marked them in.
  assert.deepEqual(bodyOrder(["c", "b"], blocks, []), ["c", "b"]);
});

test("a body drops what it names twice and what it names at all", () => {
  const blocks = [loop("l", []), block("a")];
  assert.deepEqual(bodyOrder(["a", "a"], blocks, []), ["a"]);
  assert.deepEqual(
    bodyOrder(["a", "gone"], blocks, []),
    ["a"],
    "an id naming no block cannot be drawn or numbered; the server refuses it by name",
  );
});

test("a region encloses its members and belongs to the loop", () => {
  const blocks = [loop("l", ["a", "b"]), block("a"), block("b"), block("z")];
  const links = [link("a", "b")];
  const at = new Map([
    ["l", { x: 100, y: 400 }],
    ["a", { x: 500, y: 400 }],
    ["b", { x: 900, y: 600 }],
    ["z", { x: 100, y: 900 }],
  ]);
  const [region, ...rest] = bodyRegions(blocks, links, at);
  assert.equal(rest.length, 0, "one region per loop that repeats a section");
  assert.equal(region.loopId, "l");
  assert.deepEqual(region.memberIds, ["a", "b"]);
  // Every member's box is inside it, and the loop's own box is not.
  assert.ok(region.x < 500 && region.y < 400);
  assert.ok(region.x + region.width > 900 + NODE_W);
  assert.ok(region.y + region.height > 600 + NODE_H);
  assert.ok(region.x > 100 + NODE_W, "the loop block itself is outside");
});

test("a region against the top left corner stays on the surface", () => {
  // A member can be dragged to the origin, and a region that started above or
  // left of it would be drawn off the sheet — which scrolls from 0, so what is
  // lost is the region rather than the scrollbar.
  const blocks = [loop("l", ["a"]), block("a")];
  const [region] = bodyRegions(blocks, [], new Map([["a", { x: 0, y: 0 }]]));
  assert.equal(region.x, 0);
  assert.equal(region.y, 0);
  assert.ok(region.width > NODE_W && region.height > NODE_H);
});

test("a region fits inside the surface its members size", () => {
  // `layoutBounds` sizes the sheet from the boxes alone, so a region wider than
  // `CANVAS_PAD` past the furthest one would have its own edge clipped.
  const blocks = [loop("l", ["a", "b"]), block("a"), block("b")];
  const at = new Map([
    ["a", { x: 24, y: 24 }],
    ["b", { x: 400, y: 300 }],
  ]);
  const bounds = layoutBounds(at);
  const [region] = bodyRegions(blocks, [], at);
  assert.ok(region.x + region.width <= bounds.width);
  assert.ok(region.y + region.height <= bounds.height);
});

test("a loop with no section is not a region, and neither is another kind", () => {
  const at = new Map([
    ["l", { x: 0, y: 0 }],
    ["a", { x: 400, y: 0 }],
  ]);
  assert.deepEqual(bodyRegions([loop("l", []), block("a")], [], at), []);
  // A body on a block that is not a loop is refused by the server rather than
  // drawn: a region round it would say the graph was savable.
  assert.deepEqual(
    bodyRegions([block("l", { bodyNodeIds: ["a"] }), block("a")], [], at),
    [],
  );
});
