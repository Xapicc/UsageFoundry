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
  linkRefusal,
  linksOfGraph,
  linksWithKind,
  linksWithMember,
  linksWithoutMember,
  markedAfterPress,
  resolveLayout,
  resolveLinkRelease,
  resolveRepeat,
  sectionExit,
  sectionLink,
  sectionLinkStatement,
  sectionOf,
  worstCaseRuns,
  type BlockDraft,
  type CanvasDraft,
  type LinkDraft,
  type WorkflowDraftBody,
} from "./canvasGraph";
import type {
  WorkflowEdgeDTO,
  WorkflowNodeDTO,
  WorkflowNodeKind,
} from "./apiTypes";
import { MAX_LOOP_PASSES, MAX_LOOP_RUNS } from "./apiTypes";
import { normalizeWorkflowInput } from "./workflowGraph";

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
    stopWhenTasksIncludeSubfolders: false,
    stopWhenTasksStatuses: "open",
    stopWhenTasksThresholds: [{ priority: "any", atMost: "0" }],
    provider: "",
    fixRounds: "1",
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
      what: "stopWhenTasksIncludeSubfolders",
      base: { kind: "loop", maxPasses: "3", stopWhenTasksMountId: "work" },
      edit: { stopWhenTasksIncludeSubfolders: true },
    },
    {
      what: "a threshold's number",
      base: { kind: "loop", maxPasses: "3", stopWhenTasksMountId: "work" },
      edit: { stopWhenTasksThresholds: [{ priority: "any", atMost: "4" }] },
    },
    {
      what: "a threshold added beside the first",
      base: { kind: "loop", maxPasses: "3", stopWhenTasksMountId: "work" },
      edit: {
        stopWhenTasksThresholds: [
          { priority: "any", atMost: "0" },
          { priority: "normal", atMost: "5" },
        ],
      },
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

/**
 * The section a loop repeats is drawn rather than typed, so every change to it
 * is a change to the *links* — and the dirty check has to see each one, or a
 * section assembled and not saved leaves the page with no dialog at all.
 *
 * Four separate cases because they move the signature by two different routes:
 * the link itself is on the wire, and `bodyNodeIds` is derived from it. A
 * reading that dropped either would still pass one of them.
 */
test("every change to a drawn section moves the signature", () => {
  const blocks = [
    block("l", { kind: "loop", maxPasses: "3" }),
    block("b"),
    block("c"),
  ];
  const repeats = link("l", "b", { edge: "repeats" });
  const chain = link("b", "c", { edge: "on-success", continueBranch: true });
  const bare = signature(blocks);
  const started = signature(blocks, [repeats]);
  const chained = signature(blocks, [repeats, chain]);

  assert.notEqual(started, bare, "the “repeats” link is the section");
  assert.notEqual(chained, started, "a block chained on joins the section");
  assert.notEqual(
    signature(blocks, [link("l", "c", { edge: "repeats" })]),
    started,
    "the section starting somewhere else is a different section",
  );
  // The derived list goes over the wire beside the links, so a save keeps it.
  const wire = draftToGraph({ blocks, links: [repeats, chain] });
  assert.deepEqual(wire.nodes[0].bodyNodeIds, ["b", "c"]);
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
    {
      stopWhenTasksMountId: "work",
      stopWhenTasksThresholds: [{ priority: "any", atMost: "3" }],
    },
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

const loop = (id: string) => block(id, { kind: "loop", maxPasses: "3" });

/** The link that states containment: `loopId` repeats `firstId` and on. */
const repeats = (loopId: string, firstId: string) =>
  link(loopId, firstId, { edge: "repeats" });

/** A link of the one kind a section's own links may be. */
const chain = (from: string, to: string) =>
  link(from, to, { edge: "on-success", continueBranch: true });

test("a body is ordered by its own edges, not by the order it was walked in", () => {
  const blocks = [loop("l"), block("a"), block("b"), block("c")];
  const links = [link("a", "b"), link("b", "c")];
  assert.deepEqual(bodyOrder(["c", "a", "b"], blocks, links), ["a", "b", "c"]);
});

test("a body ignores the edges that reach it from outside", () => {
  // The “repeats” link is the only way in and the loop block is the way out, so
  // neither says anything about the order within the section.
  const blocks = [loop("l"), block("a"), block("b"), block("z")];
  const links = [link("l", "a"), link("a", "b"), link("b", "l"), link("z", "b")];
  assert.deepEqual(bodyOrder(["a", "b"], blocks, links), ["a", "b"]);
});

test("a body that is not a chain yet still gets an order, and terminates", () => {
  const blocks = [loop("l"), block("a"), block("b"), block("c")];
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
  // ranked as far as the edges reach and declaration order breaks the tie.
  assert.deepEqual(
    bodyOrder(["c", "b", "a"], blocks, [link("a", "b"), link("a", "c")]),
    ["a", "c", "b"],
  );
  // Nothing linked at all: every member ranks 0, so the tie-break is the whole
  // answer and it is the order the walk reached them in.
  assert.deepEqual(bodyOrder(["c", "b"], blocks, []), ["c", "b"]);
});

test("a body drops what it names twice and what it names at all", () => {
  const blocks = [loop("l"), block("a")];
  assert.deepEqual(bodyOrder(["a", "a"], blocks, []), ["a"]);
  assert.deepEqual(
    bodyOrder(["a", "gone"], blocks, []),
    ["a"],
    "an id naming no block cannot be drawn or numbered; the server refuses it by name",
  );
});

test("a region encloses its members and belongs to the loop", () => {
  const blocks = [loop("l"), block("a"), block("b"), block("z")];
  const links = [repeats("l", "a"), chain("a", "b")];
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
  const blocks = [loop("l"), block("a")];
  const [region] = bodyRegions(
    blocks,
    [repeats("l", "a")],
    new Map([["a", { x: 0, y: 0 }]]),
  );
  assert.equal(region.x, 0);
  assert.equal(region.y, 0);
  assert.ok(region.width > NODE_W && region.height > NODE_H);
});

test("a region fits inside the surface its members size", () => {
  // `layoutBounds` sizes the sheet from the boxes alone, so a region wider than
  // `CANVAS_PAD` past the furthest one would have its own edge clipped.
  const blocks = [loop("l"), block("a"), block("b")];
  const at = new Map([
    ["a", { x: 24, y: 24 }],
    ["b", { x: 400, y: 300 }],
  ]);
  const bounds = layoutBounds(at);
  const [region] = bodyRegions(
    blocks,
    [repeats("l", "a"), chain("a", "b")],
    at,
  );
  assert.ok(region.x + region.width <= bounds.width);
  assert.ok(region.y + region.height <= bounds.height);
});

test("a loop with nothing in it still draws a frame, and another kind does not", () => {
  const at = new Map([
    ["l", { x: 0, y: 0 }],
    ["a", { x: 400, y: 0 }],
  ]);
  // The frame is the *whole* of how a loop is drawn — it has no card — so a
  // frame that vanished the moment its last member was deleted would leave the
  // loop in the graph with nothing on the canvas to select or delete it by, and
  // the only way out would be leaving the editor and losing the draft.
  const [empty, ...rest] = bodyRegions([loop("l"), block("a")], [], at);
  assert.equal(rest.length, 0);
  assert.deepEqual(empty.memberIds, []);
  assert.equal(empty.entryId, null);
  assert.equal(empty.exitId, null);
  assert.ok(
    empty.width >= NODE_W && empty.height >= NODE_H,
    "sized like a block, so it reads as a place something goes",
  );

  // A “repeats” link out of a block that is not a loop is refused by the server
  // rather than drawn: a frame round it would say the graph was savable.
  assert.deepEqual(
    bodyRegions([block("l"), block("a")], [repeats("l", "a")], at),
    [],
  );
});

/* ------------------------------------------------------------------ */
/* What the links say a loop repeats                                   */
/* ------------------------------------------------------------------ */

/**
 * The client's half of the one mechanism, and it has to agree with
 * `resolveSections` exactly: this is the section the canvas draws, the
 * inspector reads out, and `draftToGraph` sends as `bodyNodeIds` beside the
 * links it was derived from. A reading that differs from the server's saves a
 * graph stating one thing and showing another — and the operator approves the
 * showing.
 */
test("a section is the “repeats” link's target and everything after it", () => {
  const blocks = [loop("l"), block("a"), block("b"), block("c")];
  const links = [repeats("l", "a"), chain("a", "b"), chain("b", "c")];
  assert.deepEqual(sectionOf("l", blocks, links), ["a", "b", "c"]);
});

test("an ordinary link out of a loop is not what says what it repeats", () => {
  // A loop with no “repeats” link frames nothing, whatever else leaves it: an
  // ordinary link from a loop is what runs *after* the whole loop, and reading
  // one as containment would put the block after the loop inside it — running
  // once per pass instead of once, billed, with the frame agreeing.
  const blocks = [loop("l"), block("a")];
  assert.deepEqual(sectionOf("l", blocks, [chain("l", "a")]), []);
});

test("a section stops at the loop and at another loop's own link", () => {
  // Two facts one walk has to get right. A member linked back to its loop is a
  // mistake the server names; swallowing the loop into its own section here
  // would draw a frame round it instead. And a second loop drawn inside a
  // section contributes its own members to its own section, not to this one —
  // the nesting is then refused by name rather than silently flattened.
  const blocks = [loop("l"), block("a"), loop("k"), block("z")];
  const links = [
    repeats("l", "a"),
    chain("a", "k"),
    link("k", "l"),
    repeats("k", "z"),
  ];
  assert.deepEqual(sectionOf("l", blocks, links), ["a", "k"]);
  assert.deepEqual(sectionOf("k", blocks, links), ["z"]);
});

test("a section being drawn round a cycle terminates", () => {
  // A cycle is legal to *draw*: the server refuses it and can only answer about
  // a graph it has been sent, so this runs between the second click and the
  // answer. An unbounded walk there is a frozen tab.
  const blocks = [loop("l"), block("a"), block("b")];
  const links = [repeats("l", "a"), chain("a", "b"), chain("b", "a")];
  assert.deepEqual([...sectionOf("l", blocks, links)].sort(), ["a", "b"]);
});

test("a saved graph's section arrives as a link even when it was a list", () => {
  // The compatibility rule at the door of the editor. Every workflow saved
  // before the link existed carries the list and no link, and this surface
  // derives membership from the links alone — so opened and saved again it
  // would lose the section in silence.
  const nodes = [
    { id: "l", kind: "loop", bodyNodeIds: ["b", "a"] },
    { id: "a", kind: "run", bodyNodeIds: [] },
    { id: "b", kind: "run", bodyNodeIds: [] },
  ] as unknown as WorkflowNodeDTO[];
  const edges = [
    { from: "a", to: "b", edge: "on-success", continueBranch: true },
  ] as WorkflowEdgeDTO[];

  const links = linksOfGraph(nodes, edges);
  const door = links.filter((l) => l.edge === "repeats");
  assert.equal(door.length, 1, "one link, whatever order the list was in");
  assert.deepEqual(
    { from: door[0].from, to: door[0].to, continueBranch: door[0].continueBranch },
    { from: "l", to: "a", continueBranch: false },
    "it starts at the block nothing inside the section links to",
  );
  assert.deepEqual(
    sectionOf("l", [{ id: "l" }, { id: "a" }, { id: "b" }], links),
    ["a", "b"],
    "and the derived section is the list it was built from",
  );
});

test("a graph that already carries the link is not given a second one", () => {
  const nodes = [
    { id: "l", kind: "loop", bodyNodeIds: ["a"] },
    { id: "a", kind: "run", bodyNodeIds: [] },
  ] as unknown as WorkflowNodeDTO[];
  const links = linksOfGraph(nodes, [
    { from: "l", to: "a", edge: "repeats", continueBranch: false },
  ] as WorkflowEdgeDTO[]);
  assert.equal(links.filter((l) => l.edge === "repeats").length, 1);
});

/* ------------------------------------------------------------------ */
/* What the editor sends is what the server accepts                    */
/* ------------------------------------------------------------------ */

/**
 * The one assertion that spans both halves of a save.
 *
 * `draftToGraph` and `normalizeWorkflowInput` are written apart and reviewed
 * apart, and the failure when they drift is the worst one this surface has: a
 * graph the operator drew, that the canvas draws back correctly, that no door
 * will accept — with the refusal naming a field the panel is no longer showing
 * them. A loop is where they drift, because it is the kind whose fields the
 * server refuses **by name** rather than coercing away: a draft switched from
 * run to loop still holds the task, workspace, template and agent it had, the
 * controls for them are still on screen, and only `draftToGraph` dropping them
 * keeps the graph savable.
 */
test("a drawn section survives the editor's own serialisation", () => {
  const blocks = [
    // Every field a loop is refused for, left on the draft as a switch of kind
    // leaves them. None of them may reach the wire.
    block("l", {
      kind: "loop",
      maxPasses: "3",
      task: "left over from when this was a run block",
      templateId: "tpl-1",
      agentId: "agent-1",
      folder: "sub/dir",
      promptOverride: "be brief",
    }),
    block("a"),
    block("m", { kind: "merge" }),
  ];
  const links = [
    link("l", "a", { edge: "repeats" }),
    link("a", "m", { edge: "on-success" }),
  ];
  const wire = draftToGraph({ blocks, links });

  const loop = wire.nodes[0];
  assert.equal(loop.task, "");
  assert.equal(loop.templateId, null);
  assert.equal(loop.agentId, null);
  assert.equal(loop.mountId, "");
  assert.equal(loop.folder, "");
  assert.equal(loop.promptOverride, null);
  // The two it does keep, so the drop above is by kind and not by accident.
  assert.equal(loop.maxPasses, 3);
  assert.deepEqual(loop.bodyNodeIds, ["a", "m"]);

  const saved = normalizeWorkflowInput(
    { name: "Nightly maintenance", graph: wire },
    {
      templates: new Map([["tpl-1", { name: "Isolated", isolate: true }]]),
      mountIds: ["main"],
      defaultIsolate: true,
      agents: new Map([["agent-1", { name: "Reviewer", usable: true }]]),
    },
  );
  assert.ok(saved.ok, saved.ok ? "" : saved.error);
  assert.deepEqual(saved.value.graph.nodes[0].bodyNodeIds, ["a", "m"]);
});

/* ------------------------------------------------------------------ */
/* The frame gestures                                                  */
/* ------------------------------------------------------------------ */

/**
 * A loop is drawn as a frame and made by one, so these five functions are the
 * whole of what that gesture writes — and every one of them fails silently.
 *
 * `markedAfterPress` is the half in front of `resolveRepeat`: what a press on a
 * block leaves marked, which is what Repeat is then pointed at. It is asserted
 * here rather than through the canvas because marking is client state and this
 * suite has no DOM — see the paragraph in `docs/agent/testing.md` — and the
 * gesture that reaches it is on `docs/verification.md`'s by-hand list.
 *
 * `resolveRepeat` picks the block a frame starts at out of a selection: picking
 * the wrong one frames a *different* section, and the picture is consistent
 * with itself either way because membership is derived from whatever it picked.
 * `linksWithoutMember` splices rather than cuts, and the failure is the one
 * this app has no undo for — an operator takes one block out and four leave
 * with it. `worstCaseRuns` is the number a press of Run is approved against and
 * the one an operator cannot compute in their head, because an orchestrator
 * member's fan-out is spent again on every pass. `linkRefusal` is the only rule
 * this surface states in its own words rather than waiting for the server.
 */

test("what runs after a loop is laid out past its whole section", () => {
  // Ranked off the loop alone, `after` lands in the column beside the
  // section's first member: the arrow to it then leaves the frame's right edge
  // and doubles back left, which reads as running *before* the blocks it
  // waits for. Nothing throws and the graph is correct — only the picture is
  // the opposite of what it says.
  const blocks = [
    loop("l"),
    block("a"),
    block("b"),
    block("m", { kind: "merge" }),
    block("after"),
  ];
  const at = autoLayout(blocks, [
    repeats("l", "a"),
    chain("a", "b"),
    chain("b", "m"),
    chain("l", "after"),
  ]);
  assert.ok(
    at.get("after")!.x > at.get("m")!.x,
    "past the block the section lands through, not beside its first member",
  );
});

test("a press marks one block, and marks another only with a modifier held", () => {
  // The plain press replaces whatever was marked, however much of it there
  // was: an operator who marked three and then pressed a fourth block alone
  // has pointed Repeat at that fourth block, and a frame round the previous
  // three would appear over a surface saying otherwise.
  assert.deepEqual(markedAfterPress(["a", "b", "c"], "d", false), ["d"]);
  assert.deepEqual(markedAfterPress([], "a", false), ["a"]);
  // Held, it adds — appended, so the order is the order they were pressed in
  // even though `resolveRepeat` does not read it.
  assert.deepEqual(markedAfterPress(["a"], "b", true), ["a", "b"]);
  // Twice on the same block takes it back out: the gesture that marked one is
  // the one an operator reaches for to unmark it, and the alternative is a
  // second id in the list that draws one outline and counts as two blocks.
  assert.deepEqual(markedAfterPress(["a", "b"], "a", true), ["b"]);
  assert.deepEqual(markedAfterPress(["a"], "a", true), []);
  // Never in place: this is React state, and a list mutated under `setMarked`
  // is a re-render that never comes.
  const before = ["a", "b"];
  markedAfterPress(before, "c", true);
  markedAfterPress(before, "a", true);
  assert.deepEqual(before, ["a", "b"]);
});

test("a frame starts at the first block of the selection in pass order", () => {
  const blocks = [block("a"), block("b"), block("c")];
  const links = [chain("a", "b"), chain("b", "c")];
  // Whatever order they were marked in: the entry is a fact about the links,
  // and a frame that started wherever the pointer landed first would repeat a
  // section the operator never drew.
  for (const marked of [["a", "b", "c"], ["c", "b", "a"], ["b", "c", "a"]]) {
    const gesture = resolveRepeat(marked, blocks, links);
    assert.equal(gesture.kind, "repeat");
    assert.equal(gesture.kind === "repeat" && gesture.entryId, "a");
  }
});

test("a frame holds what the links reach, not what was marked", () => {
  const blocks = [block("a"), block("b"), block("c")];
  const links = [chain("a", "b"), chain("b", "c")];
  // Marking the head alone is the whole gesture — the rest follows the links —
  // and that is also the route below the breakpoint, where there is no modifier
  // to hold. So this must agree with marking all three.
  const head = resolveRepeat(["a"], blocks, links);
  assert.deepEqual(head.kind === "repeat" && head.memberIds, ["a", "b", "c"]);
  // And a block the selection never reaches is not in it, however it was
  // marked: `c` is behind `b`, which is not linked from `a` here.
  const split = resolveRepeat(["a", "c"], blocks, [chain("b", "c")]);
  assert.deepEqual(split.kind === "repeat" && split.memberIds, ["a"]);
});

test("Repeat refuses a loop and a block already framed, by name", () => {
  const blocks = [loop("l"), block("a"), block("b")];
  const links = [repeats("l", "a"), chain("a", "b")];
  // Both are refused on the server too. Said here because the alternative is
  // drawing a frame whose only outcome is that refusal — and because the
  // sentence has to name the block, or the operator is hunting for which of
  // four they marked is the problem.
  const nested = resolveRepeat(["l"], blocks, links);
  assert.equal(nested.kind, "refused");
  assert.match(nested.kind === "refused" ? nested.because : "", /\bl\b/);

  const taken = resolveRepeat(["b"], blocks, links);
  assert.equal(taken.kind, "refused");
  assert.match(taken.kind === "refused" ? taken.because : "", /\bl\b/);

  const nothing = resolveRepeat([], blocks, links);
  assert.equal(nothing.kind, "refused");
});

test("a frame marks the block a pass starts at and the one that lands it", () => {
  const blocks = [loop("l"), block("a"), block("m", { kind: "merge" })];
  const links = [repeats("l", "a"), chain("a", "m")];
  const at = new Map([
    ["l", { x: 0, y: 0 }],
    ["a", { x: 100, y: 100 }],
    ["m", { x: 400, y: 100 }],
  ]);
  const [region] = bodyRegions(blocks, links, at);
  assert.equal(region.entryId, "a", "what runs first");
  assert.equal(region.exitId, "m", "where the work lands");
  // The frame is the members' bounding box grown by the padding and the strip,
  // so it encloses both and starts above and left of them.
  assert.ok(region.x < 100 && region.y < 100);
  assert.ok(region.x + region.width >= 400 + NODE_W);
  assert.ok(region.y + region.height >= 100 + NODE_H);
});

test("a section that does not end at one merge block has no exit to mark", () => {
  const blocks = [
    loop("l"),
    block("a"),
    block("b"),
    block("m", { kind: "merge" }),
  ];
  const at = new Map(
    ["l", "a", "b", "m"].map((id) => [id, { x: 0, y: 0 }] as const),
  );
  // Two sinks: the graph is refused by the server, and until it answers the
  // frame may not name one of them as the place the pass lands. A promise
  // about where an operator's work ends up is not one to guess at.
  const forked = bodyRegions(
    blocks,
    [repeats("l", "a"), chain("a", "b"), chain("a", "m")],
    at,
  );
  assert.equal(forked[0].exitId, null);
  // One sink, but not a merge block: same answer, same reason.
  const unlanded = bodyRegions(
    blocks,
    [repeats("l", "a"), chain("a", "b")],
    at,
  );
  assert.equal(unlanded[0].exitId, null);
});

test("a block put in a frame that lands runs beside the section, not after it", () => {
  const blocks = [
    loop("l"),
    block("a"),
    block("m", { kind: "merge" }),
    block("b"),
  ];
  const links = [repeats("l", "a"), chain("a", "m")];
  const next = linksWithMember("l", "b", blocks, links);
  assert.ok(next !== null);
  assert.deepEqual(sectionOf("l", blocks, next), ["a", "b", "m"]);
  // The exit still lands it, or the pass would end with this block's work
  // stranded on a branch nothing merges.
  assert.equal(sectionExit(["a", "b", "m"], blocks, next), "m");
  // And it cuts its own branch rather than claiming `a`'s, which is already
  // carried by the link to `m`: two links carrying one block's branch is
  // refused at Save by name.
  const fork = next.find((l) => l.from === "a" && l.to === "b");
  assert.equal(fork?.continueBranch, false);
});

test("a link into a member that holds no branch never carries one", () => {
  // Only a run block has a branch at either end — an orchestrator decides and
  // writes nothing to disk. Handing it one is refused at Save by name, and the
  // Put in gesture would be writing that refusal over a control the operator
  // was never shown.
  const blocks = [
    loop("l"),
    block("a"),
    block("m", { kind: "merge" }),
    block("d", { kind: "orchestrator" }),
  ];
  const next = linksWithMember("l", "d", blocks, [
    repeats("l", "a"),
    chain("a", "m"),
  ]);
  assert.ok(next !== null);
  assert.equal(
    next.find((x) => x.from === "a" && x.to === "d")?.continueBranch,
    false,
  );
  assert.equal(
    next.find((x) => x.from === "d" && x.to === "m")?.continueBranch,
    false,
  );
});

/**
 * The server's answer to a drawn graph, where every block's guards isolate.
 *
 * The branch cases below assert this rather than the flag on one link, because
 * the defect is a refusal: the in-section panel offers no switch for the
 * branch, so a link the editor mints carrying one the server will not accept is
 * a graph the operator cannot save and cannot see why.
 */
function saved(draft: CanvasDraft) {
  return normalizeWorkflowInput(
    { name: "Nightly maintenance", graph: draftToGraph(draft) },
    {
      templates: new Map(),
      mountIds: ["main"],
      defaultIsolate: true,
      agents: new Map(),
    },
  );
}

/** What the Link tool writes for each drag inside a frame, one after another. */
function drawnInside(
  blocks: readonly BlockDraft[],
  links: LinkDraft[],
  drags: ReadonlyArray<readonly [string, string]>,
): LinkDraft[] {
  return drags.reduce(
    (prev, [from, to]) => [...prev, sectionLink(from, to, prev, blocks)],
    links,
  );
}

test("a fan-in drawn inside a frame carries one branch into the block it meets at", () => {
  const blocks = [
    loop("l"),
    block("e"),
    block("a"),
    block("b"),
    block("j"),
    block("m", { kind: "merge" }),
  ];
  const links = drawnInside(blocks, [repeats("l", "e")], [
    ["e", "a"],
    ["e", "b"],
    ["a", "j"],
    ["b", "j"],
    ["j", "m"],
  ]);
  // A run can continue one branch. Carrying both is refused at Save as “j is
  // set to carry on two branches”, over a switch this panel does not show.
  assert.equal(links.filter((l) => l.to === "j" && l.continueBranch).length, 1);
  // So `j` carries on `a`'s branch and `m` lands `j`, and `b` reaches the exit
  // through `j` with its own branch landed by nothing. The refusal names the
  // link that lands it, and once that is drawn the graph saves.
  const refused = saved({ blocks, links });
  assert.ok(!refused.ok, "a fan-in that strands b's branch was saved");
  assert.match(refused.error, /Nothing lands “b”'s branch/);
  assert.match(refused.error, /Link “b” to “m” as well/);
  const result = saved({ blocks, links: drawnInside(blocks, links, [["b", "m"]]) });
  assert.ok(result.ok, result.ok ? "" : result.error);
});

test("taking out the block two branches met at leaves one branch carried", () => {
  const blocks = [
    loop("l"),
    block("e"),
    block("a"),
    block("b"),
    block("x"),
    block("y"),
    block("m", { kind: "merge" }),
  ];
  const links = drawnInside(blocks, [repeats("l", "e")], [
    ["e", "a"],
    ["e", "b"],
    ["a", "x"],
    ["b", "x"],
    ["x", "y"],
    ["y", "m"],
    // What lands `b`'s branch, which `x` does not carry on.
    ["b", "m"],
  ]);
  const next = linksWithoutMember("l", "x", blocks, links);
  assert.ok(next !== null);
  // The splice links both predecessors to what followed, and only the first
  // of them may hand its branch on.
  assert.equal(next.filter((l) => l.to === "y" && l.continueBranch).length, 1);
  const result = saved({ blocks, links: next });
  assert.ok(result.ok, result.ok ? "" : result.error);
});

test("a member switched away from a run block stops carrying a branch", () => {
  const blocks = [
    loop("l"),
    block("e"),
    block("b"),
    block("c"),
    block("m", { kind: "merge" }),
  ];
  const links = drawnInside(blocks, [repeats("l", "e")], [
    ["e", "b"],
    ["b", "c"],
    ["c", "m"],
    // What lands `e`'s branch once `b` is no longer a run to carry it on.
    ["e", "m"],
    // And what lands the runs `b` starts once it is an orchestrator: `c`
    // starts fresh rather than carrying their branches on.
    ["b", "m"],
  ]);
  for (const kind of ["orchestrator", "merge"] as const) {
    const switched = blocks.map((b) => (b.id === "b" ? { ...b, kind } : b));
    // What the kind picker used to leave behind: “b” has no checkout, so a
    // branch handed to it is refused by name.
    assert.equal(saved({ blocks: switched, links }).ok, false);

    const next = linksWithKind("b", kind, switched, links);
    assert.equal(next.some((l) => l.continueBranch), false);
    const result = saved({ blocks: switched, links: next });
    assert.ok(result.ok, `${kind}: ${result.ok ? "" : result.error}`);
  }
});

test("a kind change leaves a branch the operator set outside a frame alone", () => {
  // Outside a section the panel shows the switch, so a branch that no longer
  // fits is refused at Save by name and the operator turns it off where they
  // turned it on — clearing it here would rewrite a choice they were shown.
  const blocks = [block("a"), block("b", { kind: "orchestrator" })];
  const links = [link("a", "b", { edge: "on-success", continueBranch: true })];
  assert.deepEqual(linksWithKind("b", "orchestrator", blocks, links), links);
});

/**
 * The in-section link panel offers no control, so this sentence is the whole of
 * what an operator learns about the link — and they act on it. It used to call
 * an “either way” link refused and say to draw it again, and a link drawn again
 * is minted *only if it completes*: following the advice blocked the member
 * whenever the one before it failed, which is what the link was drawn to avoid.
 */
test("an either-way link inside a section is stated as drawn, not refused", () => {
  const names = {
    from: "a",
    to: "b",
    fromKind: "run",
    toKind: "run",
    carriedFrom: undefined,
  } as const;
  const either = sectionLinkStatement(
    link("a", "b", { edge: "on-finish" }),
    names,
  );
  assert.match(either.clause, /either way/);
  assert.doesNotMatch(either.clause, /only if it completes/);
  assert.equal(either.refusal, null);
  // The server's side of the same claim, so the panel is not merely agreeing
  // with itself.
  const blocks = [loop("l"), block("a"), block("b"), block("m", { kind: "merge" })];
  const result = saved({
    blocks,
    links: [
      repeats("l", "a"),
      link("a", "b", { edge: "on-finish", continueBranch: true }),
      link("b", "m", { edge: "on-success" }),
    ],
  });
  assert.ok(result.ok, result.ok ? "" : result.error);

  const minted = sectionLinkStatement(link("a", "b", { edge: "on-success" }), names);
  assert.match(minted.clause, /only if it completes/);
  assert.equal(minted.refusal, null);
  // Only a link nobody gave a condition is refused, and redrawing it
  // overwrites no choice.
  const unanswered = sectionLinkStatement(link("a", "b"), names);
  assert.match(unanswered.refusal ?? "", /refused/);
});

test("a fan-in's second link names the branch its target carries instead", () => {
  const second = sectionLinkStatement(link("c", "b", { edge: "on-success" }), {
    from: "c",
    to: "b",
    fromKind: "run",
    toKind: "run",
    carriedFrom: "a",
  });
  assert.match(second.branch, /carries on a's branch, not c's/);
  assert.doesNotMatch(second.branch, /cuts its own/);
});

/**
 * Since a kind change away from run clears the branch on a block's section
 * links, a member switched to merge or orchestrator shows this sentence on every
 * one of its links, and it used to say that block cuts a branch, which neither
 * kind does.
 */
test("a link into a merge or orchestrator member says what happens to the branch", () => {
  const ends = (fromKind: WorkflowNodeKind, toKind: WorkflowNodeKind) => ({
    from: "a",
    to: "m",
    fromKind,
    toKind,
    carriedFrom: undefined,
  });
  const edge = link("a", "m", { edge: "on-success" });

  assert.equal(
    sectionLinkStatement(edge, ends("run", "merge")).branch,
    "m lands a's branch.",
  );
  assert.equal(
    sectionLinkStatement(edge, ends("orchestrator", "merge")).branch,
    "m lands the branches of the runs a starts.",
  );
  for (const [fromKind, toKind] of [
    ["run", "orchestrator"],
    ["merge", "merge"],
  ] as const) {
    const said = sectionLinkStatement(edge, ends(fromKind, toKind)).branch;
    assert.equal(said, "No branch is handed over.", `${fromKind} to ${toKind}`);
  }
  // Out of an orchestrator into a run: the run still cuts its own, but nothing
  // is carried onto it.
  const fromDecider = sectionLinkStatement(edge, ends("orchestrator", "run"));
  assert.match(fromDecider.branch, /^No branch is handed over: m cuts its own/);
});

test("a block put in an empty frame becomes what each pass starts at", () => {
  const blocks = [loop("l"), block("a")];
  const next = linksWithMember("l", "a", blocks, []);
  assert.ok(next !== null);
  assert.deepEqual(sectionOf("l", blocks, next), ["a"]);
  // A loop has at most one “repeats” link — two is a refusal the server writes
  // and not one this gesture has any way to mean.
  assert.equal(next.filter((l) => l.edge === "repeats").length, 1);
});

test("taking a middle block out keeps the rest of the frame", () => {
  const blocks = [
    loop("l"),
    block("a"),
    block("b"),
    block("m", { kind: "merge" }),
  ];
  const links = [repeats("l", "a"), chain("a", "b"), chain("b", "m")];
  const next = linksWithoutMember("l", "b", blocks, links);
  assert.ok(next !== null);
  // Cut rather than spliced, this would be ["a"] — the operator asked for one
  // block and lost two, with no undo in this app to get them back.
  assert.deepEqual(sectionOf("l", blocks, next), ["a", "m"]);
  assert.equal(sectionExit(["a", "m"], blocks, next), "m");
});

test("taking the entry out moves the frame onto what followed it", () => {
  const blocks = [
    loop("l"),
    block("a"),
    block("b"),
    block("m", { kind: "merge" }),
  ];
  const links = [repeats("l", "a"), chain("a", "b"), chain("b", "m")];
  const next = linksWithoutMember("l", "a", blocks, links);
  assert.ok(next !== null);
  assert.deepEqual(sectionOf("l", blocks, next), ["b", "m"]);
  assert.equal(next.filter((l) => l.edge === "repeats").length, 1);

  // The last one out leaves the frame empty rather than leaving a link to a
  // block that is no longer in it.
  const emptied = linksWithoutMember("l", "b", blocks, [repeats("l", "b")]);
  assert.deepEqual(emptied, []);
  // A block that was never in it is not a write at all, so the caller can leave
  // the links exactly as they were.
  assert.equal(
    linksWithoutMember("l", "z", [...blocks, block("z")], links),
    null,
  );
});

test("the worst case counts a review member's fix runs for every branch a pass cuts", () => {
  // A review member sends each rejected branch back for a fix every round, so
  // at worst every branch the pass cut is fixed every round: a run member's
  // own and each run an orchestrator member may emit, never its deciding turn.
  // Left out, the editor would state a pass of three branches with two fix
  // rounds as three runs and the bill would say nine.
  assert.equal(
    worstCaseRuns(2, [
      { kind: "run", fanOut: null },
      { kind: "orchestrator", fanOut: 2 },
      { kind: "review", fanOut: null, fixRounds: 2 },
      { kind: "merge", fanOut: null },
    ]),
    2 * (1 + 3 + 2 * 3),
  );
  assert.equal(
    worstCaseRuns(1, [
      { kind: "run", fanOut: null },
      { kind: "review", fanOut: null, fixRounds: 0 },
    ]),
    1,
  );
});

test("the worst case counts a fan-out again on every pass", () => {
  // The number an operator cannot do in their head, and the one a press of Run
  // is approved against: four passes of one block reads as four runs and is
  // twenty-four when that block decides — its fan-out of five, and its own
  // deciding turn, which is a spawned and billed child on every pass.
  assert.equal(
    worstCaseRuns(4, [{ kind: "orchestrator", fanOut: 5 }]),
    24,
  );
  assert.equal(
    worstCaseRuns(3, [
      { kind: "run", fanOut: null },
      { kind: "orchestrator", fanOut: 2 },
      // A merge member starts nothing of its own.
      { kind: "merge", fanOut: null },
    ]),
    12,
  );
  // Both blanks are refused at Save, and a figure that read either as zero
  // would be approving an unbounded press of Run on the operator's behalf.
  assert.equal(worstCaseRuns(null, [{ kind: "run", fanOut: null }]), null);
  assert.equal(
    worstCaseRuns(4, [{ kind: "orchestrator", fanOut: null }]),
    null,
  );
  assert.equal(worstCaseRuns(0, [{ kind: "run", fanOut: null }]), null);
});

test("the worst case the editor states is the one Save refuses at", () => {
  // Two copies of this arithmetic once disagreed by the deciding turn: the
  // editor stated "up to 60 runs" over a section Save refused at 72, so the
  // number an operator approved was not the number that was enforced. Every
  // pass cap is tried, so the crossing is pinned from both sides.
  for (let passes = 1; passes <= MAX_LOOP_PASSES; passes++) {
    const blocks = [
      block("l", { kind: "loop", maxPasses: String(passes) }),
      block("o", { kind: "orchestrator", fanOut: "5" }),
      block("m", { kind: "merge" }),
    ];
    const wire = draftToGraph({
      blocks,
      links: [repeats("l", "o"), link("o", "m", { edge: "on-success" })],
    });
    // Read off the wire graph the way `/workflows/[id]`'s loop row reads it.
    const loopNode = wire.nodes.find((n) => n.id === "l")!;
    const stated = worstCaseRuns(
      loopNode.maxPasses,
      loopNode.bodyNodeIds.map((id) => wire.nodes.find((n) => n.id === id)!),
    );
    assert.ok(stated !== null, `${passes} pass(es) state no figure`);

    const saved = normalizeWorkflowInput(
      { name: "Fan-out loop", graph: wire },
      {
        templates: new Map(),
        mountIds: ["main"],
        defaultIsolate: true,
        agents: new Map(),
      },
    );
    if (stated > MAX_LOOP_RUNS) {
      assert.ok(!saved.ok, `${passes} pass(es) state ${stated} and must be refused`);
      assert.match(saved.error, new RegExp(`which is ${stated} runs`));
    } else {
      assert.ok(saved.ok, saved.ok ? "" : `${passes} pass(es): ${saved.error}`);
    }
  }
});

test("a link into a frame is refused at the release, naming the frame", () => {
  const blocks = [loop("l"), block("a"), block("b"), block("z")];
  const links = [repeats("l", "a"), chain("a", "b")];
  const refusal = linkRefusal("z", "b", blocks, links);
  assert.ok(refusal !== null);
  // The frame is what the operator meant, so the sentence has to name it: the
  // server's own refusal is about the graph and leaves them working out which
  // of the arrow's two ends it is talking about.
  assert.match(refusal, /\bl\b/);

  // A link *out* of the frame is what runs after the loop, and a link between
  // two members is how a section is assembled. Neither is refused here.
  assert.equal(linkRefusal("b", "z", blocks, links), null);
  assert.equal(linkRefusal("a", "b", blocks, links), null);
  assert.equal(linkRefusal("l", "a", blocks, links), null);
  assert.equal(linkRefusal("z", "l", blocks, links), null);
});

test("a frame built and a member moved are both changes a save would keep", () => {
  // The dirty check is `draftSignature` against the snapshot the page opened
  // with, and nothing else raises the dialog — so a gesture it cannot see is a
  // graph that leaves the page without a word.
  const base: CanvasDraft = {
    blocks: [block("a"), block("m", { kind: "merge" }), block("b")],
    links: [chain("a", "m")],
  };
  const body = (draft: CanvasDraft): WorkflowDraftBody => ({
    name: "nightly",
    graph: draftToGraph(draft),
    instanceBudget: {
      maxInstanceCostUSD: "",
      maxSessionFraction: null,
      maxWeeklyFraction: null,
    },
  });

  const framed: CanvasDraft = {
    blocks: [...base.blocks, loop("l")],
    links: [...base.links, repeats("l", "a")],
  };
  assert.notEqual(draftSignature(body(base)), draftSignature(body(framed)));

  // Putting a block in changes the links *and* `bodyNodeIds`; taking it out
  // again has to land back on the signature it started from, or an operator who
  // undid their own gesture by hand is prompted over a graph that is identical.
  const withB = {
    ...framed,
    links: linksWithMember("l", "b", framed.blocks, framed.links)!,
  };
  assert.notEqual(draftSignature(body(framed)), draftSignature(body(withB)));
  assert.ok(
    draftToGraph(withB).nodes.some(
      (n) => n.id === "l" && n.bodyNodeIds.includes("b"),
    ),
    "the cross-check the server is sent has to move with the links",
  );
  const withoutB = {
    ...withB,
    links: linksWithoutMember("l", "b", withB.blocks, withB.links)!,
  };
  assert.equal(
    draftSignature(body(withoutB)),
    draftSignature(body(framed)),
    "putting a block in and taking it out again is not a change",
  );
});
