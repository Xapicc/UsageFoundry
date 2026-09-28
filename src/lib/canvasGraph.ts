import type {
  MergeStrategyDTO,
  TaskPriorityDTO,
  TaskStatusDTO,
  WorkflowEdgeDTO,
  WorkflowNodeDTO,
  WorkflowNodeKind,
} from "./apiTypes";

/**
 * The canvas's own model: a draft graph, and where its blocks sit on screen.
 *
 * **Coordinates are not in the graph, and that is what this file is for.** The
 * obvious home for them is `WorkflowNode`, and it is the wrong one twice over:
 * `normalizeWorkflowInput` builds each node from a fixed list of fields, so an
 * `x`/`y` written by the editor would be dropped on the way through and the
 * drag would silently not persist; and if it were let through, moving a block
 * two inches would rewrite the object `topologicalOrder` reads, bump
 * `updated_at`, and make a cosmetic gesture indistinguishable from a change to
 * what runs. So the graph is left exactly as it was and a position is a *view*
 * of it, held per browser and reconciled here.
 *
 * The consequence is that every graph has a readable layout whether or not
 * anyone has ever dragged it — `autoLayout` derives one from the edges — and a
 * graph saved before the canvas existed opens with no migration at all, so
 * there is nothing that could lose an edge on the way in. What it costs is that
 * a layout does not travel between browsers or operators; the arrangement does,
 * because it is derived from the graph, and only the hand-placed override does
 * not.
 *
 * Everything here is pure and client-safe: no `node:` import, nothing that
 * opens SQLite. `src/lib` is also what `tsconfig.test.json` compiles, which is
 * why the canvas's decisions live here rather than beside the component.
 */

export interface Point {
  x: number;
  y: number;
}

/**
 * A rectangle on the surface, which is what an edge actually leaves and arrives
 * at.
 *
 * Not every end of a link is a block box any more: a loop is drawn as the frame
 * round the blocks it repeats, so a link into or out of one leaves the *frame*.
 * A `Point` plus the fixed `NODE_W`/`NODE_H` cannot say that, and an edge drawn
 * to the loop's own invisible box would arrive at a corner of the frame with
 * nothing in it.
 */
export interface Box extends Point {
  width: number;
  height: number;
}

/** A block's box, which is the fixed one every card is drawn at. */
export function nodeBox(at: Point): Box {
  return { x: at.x, y: at.y, width: NODE_W, height: NODE_H };
}

/** A block as it is being edited. Every value a string, as a form holds them. */
export interface BlockDraft {
  id: string;
  name: string;
  kind: WorkflowNodeKind;
  /** `""` is "no template", which is a real answer: the guards in Settings. */
  templateId: string;
  mountId: string;
  folder: string;
  task: string;
  promptOverride: string;
  /**
   * The saved agent this block's child may hand a subtask to, by id.
   *
   * `""` is "no specialist", which is a real answer and the ordinary block —
   * the same shape `templateId` uses one field up, and for the same reason: a
   * `<select>` holds the absence as an empty option rather than as a null.
   */
  agentId: string;
  /** Orchestrator blocks only, held as typed so a blank field stays blank. */
  fanOut: string;
  /** Merge blocks only: how each branch is put onto its target. */
  mergeStrategy: MergeStrategyDTO;
  /** Merge blocks only: whether a conflict may be reconciled by a model. */
  mergeAutoResolve: boolean;
  /**
   * Loop blocks only: how many passes it may take, held as typed.
   *
   * A string like `fanOut` beside it, and for the same reason — a blank field
   * has to stay blank rather than becoming a number nobody chose, so that the
   * server's own refusal is what the operator reads.
   */
  maxPasses: string;
  /** Loop blocks only: everything its passes may spend together. `""` is off. */
  maxLoopCostUSD: string;
  /**
   * Loop blocks only: the workspace whose board the condition counts. `""` is
   * the condition switched off, which is what the picker's first option says.
   *
   * The absence lives on the mount rather than on a switch beside it, which is
   * `templateId`'s shape two fields up: a `<select>` already has somewhere to
   * put "none", and a second control whose only job is to grey out three others
   * is one more thing that can disagree with them.
   */
  stopWhenTasksMountId: string;
  /**
   * The project within that workspace. `""` is the mount root.
   *
   * Two fields for what the panel offers as **one** control, because the wire
   * has two and the board names a project by the pair: a folder alone is
   * ambiguous across mounts. The picker encodes the pair into its option value
   * and writes both back, so the draft holds what a save would store rather
   * than an encoding only this surface can read.
   */
  stopWhenTasksFolder: string;
  /** Whether folders under that one count towards the same project. */
  stopWhenTasksIncludeSubfolders: boolean;
  /** Which states are counted: `"open"` or `"open,claimed"`, as picked. */
  stopWhenTasksStatuses: string;
  /** The numbers it stops at, any one of which ends the loop. */
  stopWhenTasksThresholds: ThresholdDraft[];
}

/** One of a board condition's numbers, held as the panel holds it. */
export interface ThresholdDraft {
  /** `"any"` for the project whole, or a priority. */
  priority: string;
  /** How many may be left. Held as typed, so a cleared field stays clear. */
  atMost: string;
}

/**
 * There is deliberately **no `bodyNodeIds` on a block draft.**
 *
 * What a loop repeats is stated by the links and read back out of them by
 * `sectionOf` — the `repeats` link says where the section starts, the section's
 * own links say what is in it and in what order. A field here as well would be
 * a second way to set one fact, which is exactly what this surface had while
 * the order came from the links and the membership came from a switch per
 * block. `draftToGraph` derives the list the wire carries, so the graph a save
 * sends states both and cannot disagree with itself.
 */

/**
 * A drawn edge.
 *
 * `edge` is `""` until the operator picks a condition, and it stays `""` all
 * the way onto the wire. Neither condition is a safe default — `on-success`
 * terminates a chain the operator meant to run regardless and `on-finish`
 * starts a run on top of a dependency that crashed — so the draft carries the
 * absence rather than papering over it, and `normalizeWorkflowInput` names the
 * two blocks it is about.
 */
export interface LinkDraft {
  from: string;
  to: string;
  /**
   * `repeats` is only ever drawn out of a loop block, and it states what that
   * loop contains rather than what waits for what. See `EDGE_OPTION_LABEL`.
   */
  edge: "" | "on-success" | "on-finish" | "repeats";
  continueBranch: boolean;
}

/**
 * What the layout and the section walks actually read off a link.
 *
 * Wider than `LinkDraft` on purpose: `resolveLayout` is handed a saved graph's
 * `WorkflowEdgeDTO[]` as well as a draft's links, and neither walk reads
 * `continueBranch`. The `edge` is optional because a caller that has none is
 * handing over dependencies only, which is what a link with no `repeats` on it
 * already means here.
 */
export interface GraphLink {
  from: string;
  to: string;
  edge?: string;
}

export interface CanvasDraft {
  blocks: BlockDraft[];
  links: LinkDraft[];
}

/**
 * What goes over the wire.
 *
 * `edge` is a bare string rather than the DTO's union, because an unanswered
 * picker is a legal draft and an illegal graph — the server is what says so,
 * and it can only say so about a graph it was sent.
 */
export interface WireGraph {
  nodes: WorkflowNodeDTO[];
  edges: Array<{
    from: string;
    to: string;
    edge: string;
    continueBranch: boolean;
  }>;
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

/** The block box. Fixed, so a long task cannot reflow the whole arrangement. */
export const NODE_W = 232;
export const NODE_H = 116;

/** Room for the edge to leave one box and arrive at the next. */
const COL_STRIDE = NODE_W + 96;
const ROW_STRIDE = NODE_H + 28;

/** Kept off the surface edge, so a box at the origin still has a drop shadow. */
export const CANVAS_PAD = 24;

/** One link's identity, for a React key and for what is selected. */
export function linkKey(link: { from: string; to: string }): string {
  return `${link.from} ${link.to}`;
}

/**
 * How deep each id sits: the longest path to it from an id nothing points at,
 * and zero for everything with no predecessor among `ids`.
 *
 * **The relaxation is bounded by the number of ids rather than run to a fixed
 * point, and the bound is load-bearing.** A cycle never settles and both callers
 * have to be able to draw one — refusing a loop is the server's decision, and it
 * can only make it about a graph it has been sent, so between the second click
 * and the answer there is a cyclic graph on screen. A body is worse: it is
 * assembled a block at a time, so it is disjoint, forked or cyclic for as long
 * as it takes to finish assembling, and an unbounded loop here would be a frozen
 * tab that throws nothing and typechecks.
 *
 * A link naming something outside `ids` is ignored, which is what lets a body
 * pass its own members and the *whole* graph's links: an edge arriving from
 * outside a section says nothing about the order of the section.
 */
function longestPathRank(
  ids: readonly string[],
  links: readonly { from: string; to: string }[],
): Map<string, number> {
  const known = new Set(ids);
  const incoming = new Map<string, string[]>();
  for (const id of ids) incoming.set(id, []);

  const seen = new Set<string>();
  for (const link of links) {
    if (!known.has(link.from) || !known.has(link.to)) continue;
    if (link.from === link.to) continue;
    const key = linkKey(link);
    if (seen.has(key)) continue;
    seen.add(key);
    incoming.get(link.to)!.push(link.from);
  }

  const rank = new Map<string, number>(ids.map((id) => [id, 0]));
  for (let pass = 0; pass < ids.length; pass++) {
    let moved = false;
    for (const id of ids) {
      const from = incoming.get(id)!;
      if (from.length === 0) continue;
      let deepest = 0;
      for (const other of from) {
        deepest = Math.max(deepest, rank.get(other)! + 1);
      }
      if (deepest > rank.get(id)!) {
        rank.set(id, deepest);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return rank;
}

/**
 * The links, plus one from each member of a section to whatever runs after its
 * loop.
 *
 * What a link *out* of a frame means is "after the whole loop", and the depth
 * it is ranked at has to say that: ranked off the loop alone, a block that runs
 * after a four-block section is laid out in the column beside that section's
 * first member, and the arrow to it leaves the frame's right edge and doubles
 * back left — which reads as running *before* the blocks it waits for. The
 * synthetic links are not a claim about the graph and never leave this
 * function: they are the arrangement the frame already implies.
 *
 * Bounded like everything else on this path — one link per (member, successor)
 * pair — and `longestPathRank`'s own relaxation is what absorbs a cycle among
 * them.
 */
function pastTheFrames(
  blocks: readonly { id: string; kind?: WorkflowNodeKind }[],
  links: readonly GraphLink[],
): Array<{ from: string; to: string }> {
  const loops = blocks.filter((b) => b.kind === "loop");
  if (loops.length === 0) return [...links];
  const extra: Array<{ from: string; to: string }> = [];
  for (const loop of loops) {
    const members = sectionOf(loop.id, blocks, links);
    if (members.length === 0) continue;
    const after = links
      .filter((l) => l.from === loop.id && l.edge !== "repeats")
      .map((l) => l.to);
    for (const member of members) {
      for (const target of after) extra.push({ from: member, to: target });
    }
  }
  return [...links, ...extra];
}

/**
 * Where the blocks go when nobody has said.
 *
 * Layered left to right by the longest path from a block with nothing in front
 * of it, which is the arrangement the graph already implies: everything in
 * column 0 starts immediately, and several of them is the parallel case — there
 * is nothing else to draw for it and nothing to call it.
 *
 * The depths come from `longestPathRank`, which is where the bound on the
 * relaxation and the reason it is load-bearing are written down.
 *
 * It **still draws a graph it has not validated**: a cycle is legal to draw and
 * the server is the only authority on refusing one, so this is on screen
 * between the second click and the answer and may not iterate on the graph's
 * shape. `longestPathRank`'s relaxation is bounded for that reason.
 *
 * The first row is dropped by a frame's strip where the graph holds a loop.
 * That strip is where a loop's name, its pass cap and its endings are written —
 * it is the whole of how a loop is drawn — and a frame round a member at the
 * very top has nowhere to put it, so it is drawn over the member's own card.
 * The condition is the kind rather than actual membership, because it has to
 * hold for a frame put round these blocks *next*, and a layout that jumped the
 * moment somebody pressed Repeat would move every card away from the hand.
 */
export function autoLayout(
  blocks: readonly { id: string; kind?: WorkflowNodeKind }[],
  links: readonly GraphLink[],
): Map<string, Point> {
  const rank = longestPathRank(
    blocks.map((b) => b.id),
    pastTheFrames(blocks, links),
  );
  const topPad =
    CANVAS_PAD + (blocks.some((b) => "kind" in b && b.kind === "loop")
      ? BODY_PAD + BODY_LABEL_H
      : 0);

  // Grouped in declaration order, so two reads of one graph stack a column the
  // same way round — the property `topologicalOrder` needs of its tie-break,
  // for the smaller reason that a layout which reshuffles on every render is
  // one nobody can point at.
  const columns = new Map<number, string[]>();
  for (const b of blocks) {
    const depth = rank.get(b.id)!;
    const column = columns.get(depth);
    if (column) column.push(b.id);
    else columns.set(depth, [b.id]);
  }

  const at = new Map<string, Point>();
  for (const [depth, members] of columns) {
    members.forEach((id, row) => {
      at.set(id, {
        x: CANVAS_PAD + depth * COL_STRIDE,
        y: topPad + row * ROW_STRIDE,
      });
    });
  }
  return at;
}

/** A stored coordinate that would put a block where nobody could reach it. */
function usable(p: Point | undefined): p is Point {
  return (
    p !== undefined &&
    Number.isFinite(p.x) &&
    Number.isFinite(p.y) &&
    p.x >= 0 &&
    p.y >= 0
  );
}

/**
 * Where every block is right now: what was dragged, and the derived spot for
 * everything else.
 *
 * Total by construction, and it has to be — a block with no entry would render
 * at the origin underneath whatever is already there, which is a block the
 * operator cannot see and can still start an agent. A stored entry naming a
 * block that has since been deleted is dropped, and one that is off the surface
 * or not a number falls back to the derived position rather than being honoured.
 */
export function resolveLayout(
  blocks: readonly { id: string; kind?: WorkflowNodeKind }[],
  links: readonly GraphLink[],
  stored: Readonly<Record<string, Point>> | null,
): Map<string, Point> {
  const derived = autoLayout(blocks, links);
  const at = new Map<string, Point>();
  for (const b of blocks) {
    const saved = stored?.[b.id];
    at.set(b.id, usable(saved) ? { x: saved.x, y: saved.y } : derived.get(b.id)!);
  }
  return at;
}

/** How big the surface has to be to hold everything on it. */
export function layoutBounds(positions: ReadonlyMap<string, Point>): {
  width: number;
  height: number;
} {
  let right = 0;
  let bottom = 0;
  for (const p of positions.values()) {
    right = Math.max(right, p.x + NODE_W);
    bottom = Math.max(bottom, p.y + NODE_H);
  }
  return { width: right + CANVAS_PAD, height: bottom + CANVAS_PAD };
}

/**
 * Where a block goes when it is added without a pointer to place it.
 *
 * Under everything, at the left margin: a new block waits for nothing, and
 * column 0 is where the layout puts everything that waits for nothing.
 */
export function freeSpot(positions: ReadonlyMap<string, Point>): Point {
  let bottom = -ROW_STRIDE + CANVAS_PAD;
  for (const p of positions.values()) bottom = Math.max(bottom, p.y);
  return { x: CANVAS_PAD, y: bottom + ROW_STRIDE };
}

/* ------------------------------------------------------------------ */
/* The section a loop repeats                                          */
/* ------------------------------------------------------------------ */

/**
 * One loop's body, in the order a pass would create it.
 *
 * The client's reading of what `loopBody` decides on the server, and the two
 * must agree: this is the order the inspector numbers the section in and the
 * order `BlockStatement` reads it out, which is the sentence a press of Run is
 * approved against. They agree because both order the members by the body's
 * **own** edges and nothing else — `loopBody` through `topologicalOrder`, this
 * through `longestPathRank` — and because `graphRefusal` has already refused
 * every body that is not a chain, where a chain has exactly one such order.
 *
 * A body that is not a chain yet is the ordinary state of one being assembled,
 * and it gets a deterministic answer rather than a refusal: rank first,
 * declaration order second. The refusal is the server's to write and is already
 * on screen under the canvas, so a second opinion here would be a second set of
 * rules to keep in step.
 *
 * An id naming no block is dropped, because nothing can be drawn or numbered
 * for it. Nothing here can produce one — `sectionOf`, its only caller, walks
 * blocks that are on the canvas — but the guard stays: it is what the *server*
 * refuses by name, and a list that half-exists is worse to draw than one that
 * does not.
 */
export function bodyOrder(
  bodyNodeIds: readonly string[],
  blocks: readonly { id: string }[],
  links: readonly { from: string; to: string }[],
): string[] {
  const known = new Set(blocks.map((b) => b.id));
  const members: string[] = [];
  const seen = new Set<string>();
  for (const id of bodyNodeIds) {
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    members.push(id);
  }
  if (members.length < 2) return members;

  const rank = longestPathRank(
    members,
    links.filter((l) => seen.has(l.from) && seen.has(l.to)),
  );
  return members
    .map((id, index) => ({ id, index, depth: rank.get(id)! }))
    .sort((a, b) => a.depth - b.depth || a.index - b.index)
    .map((m) => m.id);
}

/**
 * The blocks one loop repeats, in the order a pass will create them.
 *
 * **This must agree with `resolveSections` and `loopBody` on the server**, and
 * the agreement is what the whole mechanism rests on: this is the section the
 * canvas draws a region round, the inspector reads out and `BlockStatement`
 * prices the worst case from, and `draftToGraph` sends it as `bodyNodeIds` —
 * so a second reading here would save a graph stating one thing and showing
 * another. It agrees because both walk the same two steps: the `repeats` link
 * names the first block, and everything linked after it along ordinary links is
 * in. The loop is never a member however the links run, for the server's
 * reason — a member linked back to its own loop is refused there by name, and
 * swallowing the loop into its own section here would hide the link that says
 * so.
 *
 * Duplicated rather than imported because this file is reached from a
 * `"use client"` component and `workflowGraph.ts` reads templates, settings and
 * the workspace mounts. The refusals stay the server's alone: a body that is
 * not a chain yet is the ordinary state of one being assembled, and it gets a
 * deterministic order here rather than a second opinion about whether it is
 * legal.
 *
 * Bounded by the link count rather than run to a fixed point, for
 * `longestPathRank`'s reason below: a cycle is legal to *draw*, and a walk that
 * did not terminate would hang the tab between two clicks.
 */
export function sectionOf(
  loopId: string,
  blocks: readonly { id: string }[],
  links: readonly GraphLink[],
): string[] {
  const door = links.find((l) => l.from === loopId && l.edge === "repeats");
  if (!door) return [];
  return reachedFrom(door.to, loopId, blocks, links);
}

/**
 * The section a `repeats` link to `entryId` would name, in pass order.
 *
 * Split out because the Repeat gesture has to answer the same question one
 * gesture *before* the link exists — the frame it is about to draw is the one
 * an operator is agreeing to — and a second walk would be a second rule about
 * what a section holds.
 *
 * `excludeId` is the loop itself where there is one, for `sectionOf`'s reason:
 * a member linked back to its own loop is refused on the server by name, and
 * swallowing the loop into its own section here would hide the link that says
 * so. The Repeat gesture has no loop yet and excludes nothing.
 */
function reachedFrom(
  entryId: string,
  excludeId: string,
  blocks: readonly { id: string }[],
  links: readonly GraphLink[],
): string[] {
  const known = new Set(blocks.map((b) => b.id));
  const ordinary = links.filter((l) => l.edge !== "repeats");
  const members: string[] = [];
  const seen = new Set<string>([excludeId]);
  const queue = [entryId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (known.has(id)) members.push(id);
    for (const l of ordinary) {
      if (l.from === id) queue.push(l.to);
    }
  }
  return bodyOrder(members, blocks, ordinary);
}

/**
 * The links a saved graph would be drawn with, with a `repeats` link put back
 * where one is only implied.
 *
 * The compatibility rule at the door of the editor. A workflow saved before the
 * link existed — or built through the API, which may still state the section as
 * a list — carries `bodyNodeIds` and no link, and this surface derives
 * membership from the links alone: opened and saved again it would lose the
 * section in silence. So the link is **materialised on the way in**, from the
 * list the graph already carries, and the operator sees the arrow that states
 * what their workflow has always done.
 *
 * The first block of the section is the one nothing inside it links to, which
 * for a saved graph is exact — `graphRefusal` has already established that the
 * members form a chain. A section that somehow is not one falls back to the
 * order the list is in, because a link that starts somewhere is better than a
 * section that vanishes, and the server refuses the graph either way.
 *
 * Taking the signature `draftSignature` is compared against with it: both the
 * mount snapshot and every later reading run through here, so a materialised
 * link is not a change and an untouched page does not open dirty.
 */
export function linksOfGraph(
  nodes: readonly WorkflowNodeDTO[],
  edges: readonly WorkflowEdgeDTO[],
): LinkDraft[] {
  const links: LinkDraft[] = edges.map((e) => ({
    from: e.from,
    to: e.to,
    edge: e.edge,
    continueBranch: e.continueBranch,
  }));
  for (const node of nodes) {
    if (node.kind !== "loop") continue;
    const body = node.bodyNodeIds ?? [];
    if (body.length === 0) continue;
    if (links.some((l) => l.from === node.id && l.edge === "repeats")) continue;
    const inside = new Set(body);
    const first =
      body.find((id) => !edges.some((e) => e.to === id && inside.has(e.from))) ??
      body[0];
    links.push({
      from: node.id,
      to: first,
      edge: "repeats",
      continueBranch: false,
    });
  }
  return links;
}

/**
 * The gap between a member's box and the region drawn round the section.
 *
 * `CANVAS_PAD` is what a region has to fit inside: the sheet is sized by
 * `layoutBounds`, which leaves exactly that much past the furthest box, so a
 * pad wider than it would put the region's own edge off the surface.
 */
const BODY_PAD = 14;

/**
 * The strip along the top of a frame that holds its name, its caps and the two
 * ends of the pass.
 *
 * Two rows, because a frame is the whole of what a loop draws now: the card
 * that used to carry the name and the pass cap is gone, and an operator who
 * cannot read them off the frame cannot read them off the canvas at all.
 */
const BODY_LABEL_H = 44;

/**
 * The box an empty frame is drawn at, round the loop's own position.
 *
 * A loop with nothing in it is a graph the server refuses — but it is also the
 * ordinary state of one whose last member was just deleted, and a frame that
 * vanished at that moment would leave the loop on the canvas with nothing to
 * select it by and nothing to delete it with. Sized to a block, so the empty
 * frame reads as a place something goes.
 */
const EMPTY_BODY_W = NODE_W;
const EMPTY_BODY_H = NODE_H;

/** A loop's section, as an area on the surface. */
export interface BodyRegion {
  /** The loop the area belongs to. */
  loopId: string;
  /** Its members, in the order a pass would create them. */
  memberIds: string[];
  /**
   * The block each pass starts at, and the merge block it lands through.
   *
   * Both null on a frame with nothing in it; `exitId` alone is null on a
   * section that does not end at a merge block, which is a graph the server
   * refuses by name — so the frame says the exit is missing rather than naming
   * the wrong block as the place the work lands.
   */
  entryId: string | null;
  exitId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The merge block a pass lands through, or null where there is not exactly one.
 *
 * The client's reading of the rule `graphRefusal` enforces — a section is one
 * way in and one way out, and the way out must be a merge block, because that
 * is what makes a pass's work visible to the next one. Read rather than
 * asserted: this surface draws graphs the server has not judged yet, so a
 * section with two sinks or a sink that lands nothing has **no** exit to mark,
 * and the frame says so rather than picking one.
 */
export function sectionExit(
  memberIds: readonly string[],
  blocks: readonly { id: string; kind: WorkflowNodeKind }[],
  links: readonly LinkDraft[],
): string | null {
  const inside = new Set(memberIds);
  const sinks = memberIds.filter(
    (id) =>
      !links.some(
        (l) => l.edge !== "repeats" && l.from === id && inside.has(l.to),
      ),
  );
  if (sinks.length !== 1) return null;
  return blocks.find((b) => b.id === sinks[0])?.kind === "merge"
    ? sinks[0]
    : null;
}

/**
 * Where each loop's section is drawn, derived from the graph and the layout.
 *
 * **No coordinate of its own**, for this file's standing reason: a region the
 * operator could place would be an `x`/`y` on a node, which `normalizeWorkflowInput`
 * drops on the way through — so the drag would silently not persist. What
 * bounds the area is where its members already are, which is a view of the
 * graph and is already reconciled.
 *
 * Clamped to the surface rather than allowed to run off it. A member dragged
 * against the top edge leaves no room for the label strip, and the honest cost
 * of the clamp is that the label then sits under that member's card — the cards
 * are drawn after the regions, so what is lost is the label rather than the
 * block. The alternative is moving somebody's block to make room, which this
 * file may not do.
 *
 * In `blocks` order, so two renders of one graph stack overlapping regions the
 * same way round and React sees stable keys.
 */
export function bodyRegions(
  blocks: readonly { id: string; kind: WorkflowNodeKind }[],
  links: readonly LinkDraft[],
  positions: ReadonlyMap<string, Point>,
): BodyRegion[] {
  const regions: BodyRegion[] = [];
  for (const block of blocks) {
    if (block.kind !== "loop") continue;
    const memberIds = sectionOf(block.id, blocks, links);
    const at = memberIds
      .map((id) => positions.get(id))
      .filter((p): p is Point => p !== undefined);

    // Nothing in it yet: the frame is drawn round the loop's own coordinate,
    // which `resolveLayout` gives every block whether or not it is drawn as
    // one. See `EMPTY_BODY_W` — a frame that disappeared here would take the
    // only thing on the canvas that can select or delete the loop with it.
    const own = positions.get(block.id) ?? { x: CANVAS_PAD, y: CANVAS_PAD };
    let left = at.length === 0 ? own.x : Infinity;
    let top = at.length === 0 ? own.y : Infinity;
    let right = at.length === 0 ? own.x + EMPTY_BODY_W : -Infinity;
    let bottom = at.length === 0 ? own.y + EMPTY_BODY_H : -Infinity;
    for (const p of at) {
      left = Math.min(left, p.x);
      top = Math.min(top, p.y);
      right = Math.max(right, p.x + NODE_W);
      bottom = Math.max(bottom, p.y + NODE_H);
    }
    const x = Math.max(0, left - BODY_PAD);
    const y = Math.max(0, top - BODY_PAD - BODY_LABEL_H);
    regions.push({
      loopId: block.id,
      memberIds,
      entryId: memberIds[0] ?? null,
      exitId: sectionExit(memberIds, blocks, links),
      x,
      y,
      width: right + BODY_PAD - x,
      height: bottom + BODY_PAD - y,
    });
  }
  return regions;
}

/** How far past the furthest frame edge the sheet has to reach. */
export function regionBounds(regions: readonly BodyRegion[]): {
  width: number;
  height: number;
} {
  let right = 0;
  let bottom = 0;
  for (const r of regions) {
    right = Math.max(right, r.x + r.width);
    bottom = Math.max(bottom, r.y + r.height);
  }
  return { width: right + CANVAS_PAD, height: bottom + CANVAS_PAD };
}

/* ------------------------------------------------------------------ */
/* The frame gestures                                                  */
/* ------------------------------------------------------------------ */

/**
 * What a block is called on screen before it has been given a name.
 *
 * One copy, reached by the canvas, the inspector and the sentences below, for
 * the reason those sentences exist at all: a refusal that names a frame has to
 * name it the way the frame's own label does, or it is pointing at something
 * the operator cannot find. Answers for a block that is gone, because a
 * gesture resolved against a stale selection can still reach one.
 */
export function blockLabel(
  block: { name: string; id: string } | undefined,
): string {
  if (!block) return "a block that is gone";
  return block.name.trim() || block.id;
}

/**
 * A link between two blocks of one section, with the two answers it may not be
 * asked for.
 *
 * Inside a section a link is drawn *only if it completes*: a pass has to land
 * what it produced, so a member that did not finish is not something the rest
 * of the section carries on from. (One drawn before the frame keeps its own,
 * which the server honours — see `sectionLinkStatement`.) The branch is the *second* link's question at both
 * ends, because a run holds one ref. Two links carrying one block's branch is
 * refused at Save by name, so the first way out of a block carries its branch
 * and each later one cuts its own and leaves it for the section's merge block,
 * which is what a fork means. A block carrying two branches is refused the same
 * way, so the first way *in* carries one and each later one hands nothing on,
 * which is what two halves meeting again at one run means.
 *
 * **Only a run block has a branch at either end.** The other three are refused
 * by name — an orchestrator decides and spends nothing on disk, a merge block
 * writes into somebody else's checkout and cuts none, and a loop holds no ref
 * at all — so a link that reaches one carries no branch however few there are
 * already. Without that test the Put in gesture writes a graph the server
 * refuses, over a control the operator was never shown.
 *
 * One definition because three callers draw one of these: the Link handle, and
 * the two frame gestures that put a block inside a frame or splice one out.
 */
export function sectionLink(
  from: string,
  to: string,
  links: readonly LinkDraft[],
  blocks: readonly { id: string; kind: WorkflowNodeKind }[] = [],
): LinkDraft {
  const runs = (id: string) =>
    blocks.length === 0 ||
    blocks.find((b) => b.id === id)?.kind === "run";
  return {
    from,
    to,
    edge: "on-success",
    continueBranch:
      runs(from) &&
      runs(to) &&
      !links.some(
        (l) => (l.from === from || l.to === to) && l.continueBranch,
      ),
  };
}

/**
 * The links once a block's kind has changed.
 *
 * `sectionLink` tests the kind at both ends when it mints a link, and a kind
 * picked afterwards has to be answered the same way: a branch carried into or
 * out of a block that is no longer a run is refused at Save by name, and inside
 * a section the panel offers no switch to take it off. So a block that stops
 * being a run stops carrying a branch on every link of a section it is in.
 *
 * Outside a section the branch is left exactly as it was. There the panel shows
 * the switch the operator set it with, and the refusal names the block, so they
 * can turn it off where they turned it on; clearing it here would rewrite a
 * choice they were shown, and would not give it back if the kind went back.
 */
export function linksWithKind(
  blockId: string,
  kind: WorkflowNodeKind,
  blocks: readonly { id: string; kind: WorkflowNodeKind }[],
  links: readonly LinkDraft[],
): LinkDraft[] {
  if (kind === "run") return [...links];
  const members = new Set(
    blocks
      .filter((b) => b.kind === "loop")
      .flatMap((b) => sectionOf(b.id, blocks, links)),
  );
  return links.map((l) =>
    l.continueBranch &&
    (l.from === blockId || l.to === blockId) &&
    members.has(l.from)
      ? { ...l, continueBranch: false }
      : l,
  );
}

/**
 * How a link panel's first sentence ends for the condition drawn, or null while
 * the link has none. Read inside a sentence, so its own words rather than
 * `EDGE_OPTION_LABEL`'s, and one table for a link inside a section and outside
 * one, so the two are described alike.
 */
export function conditionClause(edge: LinkDraft["edge"]): string | null {
  if (edge === "on-success") return ", only if it completes.";
  if (edge === "on-finish") return ", once it finishes either way.";
  return null;
}

/** What the panel for a link inside a section says after its opening words. */
export interface SectionLinkStatement {
  /** Ends the sentence that names both blocks and the section. */
  clause: string;
  branch: string;
  refusal: string | null;
}

/** The two blocks a link inside a section joins, as its panel names them. */
export interface SectionLinkEnds {
  from: string;
  to: string;
  fromKind: WorkflowNodeKind;
  toKind: WorkflowNodeKind;
  /** The block whose branch the target carries through another link, if any. */
  carriedFrom: string | undefined;
}

/**
 * What the panel for a link inside a section says about it, where it offers no
 * control to change it.
 *
 * **The condition drawn, not the one `sectionLink` mints.** A link drawn before
 * its blocks were framed, or saved that way, keeps its own, and the server
 * honours an *either way* link inside a section as drawn. The panel used to
 * state *only if it completes* for every one and call anything else refused,
 * with the advice to redraw it — and a redrawn link is minted *only if it
 * completes*, so the advice replaced the operator's choice in silence. Only a
 * link with no condition is refused, and redrawing that overwrites nothing.
 *
 * The branch is per link, because a run holds one ref: `sectionLink` hands the
 * first way out of a block its branch and the first way into one the branch it
 * carries. Where the target carries another link's, saying it cuts its own
 * would tell the operator this link's work is somewhere it is not.
 *
 * **The kinds decide before the switch does**, because only a run has a branch
 * at either end. A merge block cuts none: it lands what its links resolve to,
 * which through an orchestrator is the runs that block started, and through
 * another merge block is nothing. An orchestrator works in no checkout, so a
 * link into or out of one hands no branch over.
 */
export function sectionLinkStatement(
  link: Pick<LinkDraft, "edge" | "continueBranch">,
  ends: SectionLinkEnds,
): SectionLinkStatement {
  const clause = conditionClause(link.edge);
  return {
    clause: clause ?? ".",
    branch: sectionLinkBranch(link, ends),
    refusal:
      clause === null
        ? "This link has no condition, so the graph is refused. Remove it and draw it again."
        : null,
  };
}

function sectionLinkBranch(
  link: Pick<LinkDraft, "continueBranch">,
  ends: SectionLinkEnds,
): string {
  const { from, to, fromKind, toKind, carriedFrom } = ends;
  if (toKind === "merge") {
    if (fromKind === "run") return `${to} lands ${from}'s branch.`;
    if (fromKind === "orchestrator") {
      return `${to} lands the branches of the runs ${from} starts.`;
    }
    return "No branch is handed over.";
  }
  if (toKind !== "run") return "No branch is handed over.";
  if (fromKind !== "run") {
    return `No branch is handed over: ${to} cuts its own, and the section's merge block lands it.`;
  }
  if (link.continueBranch) return `${to} commits onto ${from}'s branch.`;
  if (carriedFrom !== undefined) {
    return `${to} carries on ${carriedFrom}'s branch, not ${from}'s.`;
  }
  return `${to} cuts its own branch, and the section's merge block lands it.`;
}

/**
 * What a press on a block leaves marked.
 *
 * The arithmetic of the Repeat gesture, apart from the four routes that reach
 * it: a press replaces what was marked, and a press with a modifier held adds
 * to it — or takes the block back out, because the gesture that marked one is
 * the one an operator will reach for to unmark it. Pure and here rather than
 * inside the canvas's `setMarked`, because every way of getting it wrong is
 * silent: an id marked twice makes "Repeat 3 blocks" a frame round two, and a
 * press that appended where it should have replaced frames a section the
 * operator never pointed at. `resolveRepeat` below is what then reads it.
 */
export function markedAfterPress(
  marked: readonly string[],
  id: string,
  extend: boolean,
): string[] {
  if (!extend) return [id];
  return marked.includes(id)
    ? marked.filter((other) => other !== id)
    : [...marked, id];
}

/** What pressing Repeat over a selection would do, or why it would do nothing. */
export type RepeatGesture =
  | { kind: "repeat"; entryId: string; memberIds: string[] }
  | { kind: "refused"; because: string };

/**
 * Which block a frame drawn round this selection would start at.
 *
 * **The selection picks the entry and the links decide the membership**, which
 * is the whole of why this is one small function and not a membership list.
 * What a loop repeats is the `repeats` link and everything linked after the
 * block it names — so a frame is *made* by naming one block, and the members
 * that appear are whatever the graph already says follow it. A gesture that
 * wrote a list instead would be a second statement of one fact, and the two
 * would disagree the first time somebody drew a link.
 *
 * The entry is `bodyOrder`'s first, which is the order the inspector numbers
 * the section in and the order a pass creates it in. So selecting a chain and
 * selecting only its head do the same thing, and neither depends on which block
 * was clicked first.
 *
 * The two refusals are about the *gesture* and not about the graph: a loop
 * inside a loop and a block already inside a frame are both refused by name on
 * the server, and this says so before drawing something whose only outcome is
 * that refusal. Everything else — a section that lands nothing, a member linked
 * to from outside — is left to `graphRefusal`, which is already on screen under
 * the canvas.
 */
export function resolveRepeat(
  selectedIds: readonly string[],
  blocks: readonly { id: string; name: string; kind: WorkflowNodeKind }[],
  links: readonly LinkDraft[],
): RepeatGesture {
  type Chosen = { id: string; name: string; kind: WorkflowNodeKind };
  const chosen = selectedIds
    .map((id) => blocks.find((b) => b.id === id))
    .filter((b): b is Chosen => b !== undefined);
  if (chosen.length === 0) {
    return { kind: "refused", because: "Choose the blocks to repeat first." };
  }
  const nested = chosen.find((b) => b.kind === "loop");
  if (nested) {
    return {
      kind: "refused",
      because: `${blockLabel(nested)} is a loop, and a loop cannot be inside another one.`,
    };
  }
  for (const block of blocks) {
    if (block.kind !== "loop") continue;
    const already = sectionOf(block.id, blocks, links);
    const taken = chosen.find((b) => already.includes(b.id));
    if (taken) {
      return {
        kind: "refused",
        because: `${blockLabel(taken)} is already repeated by ${blockLabel(block)}.`,
      };
    }
  }
  const entryId = bodyOrder(
    chosen.map((b) => b.id),
    blocks,
    links.filter((l) => l.edge !== "repeats"),
  )[0];
  return {
    kind: "repeat",
    entryId,
    // What the frame will actually hold once the link is drawn, which is not
    // always what was selected: a block linked after the selection joins the
    // section, and one the selection never reaches does not. The caller draws
    // the frame, so this is what it will draw.
    memberIds: reachedFrom(entryId, "", blocks, links),
  };
}

/**
 * The links with one more block inside a frame.
 *
 * "Put it inside" is a gesture on the frame, so it has to be answered in the
 * one thing a frame is made of. Three shapes, and each is the obvious reading
 * of the frame it is applied to:
 *
 *   - an empty frame — the block becomes what each pass starts at
 *   - a frame that lands through a merge block — the block runs beside what is
 *     already there and that merge block lands it too, which is the fan a
 *     section is allowed and the shape `sectionLink` sets the branch for
 *     - unless the entry *is* that merge block, where running beside it would
 *       mean landing before the work: the block goes in front of it instead
 *   - anything else — the block is linked after the section's last member,
 *     because there is no exit yet to land it through
 *
 * Returns null when the gesture cannot mean anything: the block is the loop,
 * another loop, or already a member.
 */
export function linksWithMember(
  loopId: string,
  blockId: string,
  blocks: readonly { id: string; kind: WorkflowNodeKind }[],
  links: readonly LinkDraft[],
): LinkDraft[] | null {
  const block = blocks.find((b) => b.id === blockId);
  if (!block || block.kind === "loop" || blockId === loopId) return null;
  const members = sectionOf(loopId, blocks, links);
  if (members.includes(blockId)) return null;

  if (members.length === 0) {
    return [
      ...links.filter((l) => !(l.from === loopId && l.edge === "repeats")),
      { from: loopId, to: blockId, edge: "repeats", continueBranch: false },
    ];
  }

  const entryId = members[0];
  const exitId = sectionExit(members, blocks, links);
  if (exitId !== null && block.kind !== "merge") {
    if (exitId === entryId) {
      return [
        ...links.filter((l) => !(l.from === loopId && l.edge === "repeats")),
        { from: loopId, to: blockId, edge: "repeats", continueBranch: false },
        sectionLink(blockId, exitId, links, blocks),
      ];
    }
    const withEntry = [...links, sectionLink(entryId, blockId, links, blocks)];
    return [...withEntry, sectionLink(blockId, exitId, withEntry, blocks)];
  }
  return [...links, sectionLink(members[members.length - 1], blockId, links, blocks)];
}

/**
 * The links with one block taken out of a frame, and the rest of it still in.
 *
 * Spliced rather than merely cut. Membership is the forward walk from the
 * entry, so cutting a middle block's links would take everything after it out
 * of the frame as well — the operator asked for one block and would lose four,
 * which is the kind of silent loss this app has no undo for. So each
 * predecessor inside the section is linked to each successor inside it.
 *
 * The entry is the same rule with the loop standing in as the predecessor,
 * except that a loop has exactly one `repeats` link: it is re-pointed at the
 * first successor in pass order, and the rest are linked after that one so they
 * stay in the frame. With no successor at all the link goes, and the frame is
 * empty — which is the state it was in before anything was put in it.
 *
 * Returns null when the block is not in this frame, so the caller can leave the
 * links exactly as they were rather than writing an identical array.
 */
export function linksWithoutMember(
  loopId: string,
  memberId: string,
  blocks: readonly { id: string; kind: WorkflowNodeKind }[],
  links: readonly LinkDraft[],
): LinkDraft[] | null {
  const members = sectionOf(loopId, blocks, links);
  if (!members.includes(memberId)) return null;
  const inside = new Set(members);

  const ordinary = links.filter((l) => l.edge !== "repeats");
  const predecessors = ordinary
    .filter((l) => l.to === memberId && inside.has(l.from))
    .map((l) => l.from);
  const successors = bodyOrder(
    ordinary.filter((l) => l.from === memberId && inside.has(l.to)).map((l) => l.to),
    blocks,
    ordinary,
  );

  let next = links.filter(
    (l) =>
      !(
        (l.from === memberId && inside.has(l.to)) ||
        (l.to === memberId && inside.has(l.from)) ||
        (l.from === loopId && l.to === memberId && l.edge === "repeats")
      ),
  );

  if (memberId === members[0]) {
    const [first, ...rest] = successors;
    if (first !== undefined) {
      next = [
        ...next,
        { from: loopId, to: first, edge: "repeats", continueBranch: false },
      ];
      for (const other of rest) next = [...next, sectionLink(first, other, next, blocks)];
    }
    return next;
  }

  for (const from of predecessors) {
    for (const to of successors) {
      if (next.some((l) => l.from === from && l.to === to)) continue;
      next = [...next, sectionLink(from, to, next, blocks)];
    }
  }
  return next;
}

/**
 * Why a link may not be drawn where the pointer let go, or null.
 *
 * The one rule this surface states in its own words rather than waiting for
 * `graphRefusal` to state it, and the reason is the gesture: a link from
 * outside a frame to a block inside it is refused at Save, and by then the
 * operator has drawn an arrow, watched it appear, and has to work out which of
 * the two ends the sentence is about. Said at the release it names the frame to
 * link to instead, which is the thing they actually meant — a link into the
 * frame runs before the whole loop.
 *
 * Nothing else is answered here. Whether the section lands anything, whether
 * the graph has a cycle and whether a member may be a loop are all the server's,
 * and a second copy of them would be a second set to keep in step.
 */
export function linkRefusal(
  from: string,
  to: string,
  blocks: readonly { id: string; name: string; kind: WorkflowNodeKind }[],
  links: readonly LinkDraft[],
): string | null {
  for (const block of blocks) {
    if (block.kind !== "loop") continue;
    const members = sectionOf(block.id, blocks, links);
    if (!members.includes(to)) continue;
    if (from === block.id || members.includes(from)) continue;
    return (
      `${blockLabel(blocks.find((b) => b.id === to))} is repeated by ` +
      `${blockLabel(block)}, so nothing outside can start it. Link to ` +
      `${blockLabel(block)} instead — that runs before the whole loop.`
    );
  }
  return null;
}

/**
 * The most runs one loop may create, over every pass it is allowed.
 *
 * **An orchestrator member's fan-out is spent again on every pass**, and that
 * is the whole reason this is arithmetic rather than a member count: a section
 * of one orchestrator at a fan-out of 5 over 4 passes is twenty-four runs
 * nobody approves one by one, and "4 passes of 1 block" says four. The
 * orchestrator's own deciding turn is one of them: it is a headless child
 * spawned and billed on every pass, whatever it goes on to emit. A merge
 * member starts nothing of its own.
 *
 * Null where the figure cannot be stated — no pass cap, or an orchestrator
 * member with no fan-out typed — because both are refused at Save and a number
 * that quietly read the blank as zero would be approving an unbounded press of
 * Run on the operator's behalf. One definition, and `normalizeWorkflowInput`
 * refuses against this same function rather than its own copy: the editor's
 * statement, the saved workflow's page and the `MAX_LOOP_RUNS` refusal are one
 * promise about money, and two copies of the arithmetic let the editor state
 * "up to 60 runs" over a graph Save refused at 72.
 */
export function worstCaseRuns(
  passes: number | null,
  members: readonly {
    kind: WorkflowNodeKind;
    fanOut: number | null;
    fixRounds?: number | null;
  }[],
): number | null {
  if (passes === null || !Number.isInteger(passes) || passes <= 0) return null;
  let perPass = 0;
  // Branches a review member could send back: every run the pass can cut one
  // on — a run member's own, and each run an orchestrator member may emit. Its
  // deciding turn cuts none.
  let branches = 0;
  for (const member of members) {
    if (member.kind === "run") {
      perPass += 1;
      branches += 1;
    } else if (member.kind === "orchestrator") {
      const fanOut = member.fanOut;
      if (fanOut === null || !Number.isInteger(fanOut) || fanOut <= 0) {
        return null;
      }
      perPass += 1 + fanOut;
      branches += fanOut;
    }
  }
  // A review member starts a fix run per rejected branch per round, so at
  // worst every branch the pass cut is sent back every round. Its reviews are
  // billed too, but they are not runs and this figure counts runs.
  for (const member of members) {
    if (member.kind !== "review") continue;
    const rounds = member.fixRounds ?? 0;
    if (!Number.isInteger(rounds) || rounds < 0) return null;
    perPass += rounds * branches;
  }
  return passes * perPass;
}

export interface EdgeGeometry {
  /** An SVG cubic, leaving the source's right edge and arriving at the left. */
  d: string;
  /** Where the condition control sits, on the curve rather than beside it. */
  mid: Point;
  /**
   * Where the curve arrives. The arrowhead is drawn here as a plain triangle
   * pointing right rather than by an SVG marker: a marker cannot take the
   * path's own stroke colour in every browser (`context-stroke` is
   * unimplemented in Chromium), and the curve's end tangent is horizontal by
   * construction, so there is no orientation to work out.
   */
  tip: Point;
}

export function edgeGeometry(from: Box, to: Box): EdgeGeometry {
  const x0 = from.x + from.width;
  const y0 = from.y + from.height / 2;
  const x1 = to.x;
  const y1 = to.y + to.height / 2;
  // A link that runs backwards — legal to draw, refused as a loop by the server
  // — would otherwise leave and arrive along the same line and read as nothing.
  const reach = Math.max(56, Math.abs(x1 - x0) / 2);
  const cx0 = x0 + reach;
  const cx1 = x1 - reach;
  return {
    d: `M ${x0} ${y0} C ${cx0} ${y0}, ${cx1} ${y1}, ${x1} ${y1}`,
    // The cubic at t=0.5, which is on the curve; the average of the endpoints
    // is not, and on a backwards link it is nowhere near it.
    mid: {
      x: (x0 + 3 * cx0 + 3 * cx1 + x1) / 8,
      y: (y0 + 3 * y0 + 3 * y1 + y1) / 8,
    },
    tip: { x: x1, y: y1 },
  };
}

/* ------------------------------------------------------------------ */
/* Linking two blocks                                                  */
/* ------------------------------------------------------------------ */

/** What a release on a Link handle does to the half-drawn link. */
export type LinkGesture =
  | { kind: "connect"; from: string; to: string }
  | { kind: "arm"; from: string }
  | { kind: "disarm" };

/**
 * What a press-and-release on one block's Link handle means.
 *
 * The handle answers two gestures through one control — drag it onto another
 * block, or click it — and with a link already armed from somewhere else it
 * relabels itself **Link here**, which is a third. Deciding all three at the
 * release is what keeps them one gesture: the press cannot know yet which it
 * is, and every attempt to decide it there ends up discarding a state the
 * release still needs. It did: the source armed from the other block was
 * overwritten on every press, so the one control the interface labels for
 * completing a link re-armed it from the target instead, and clicking **Link
 * here** on every block in the graph never drew an edge.
 *
 * `armedBefore` is therefore what was armed when the press *began*, not what is
 * armed now — the handle arms itself at `pointerdown` so a drag out of it draws
 * from the right block, and this is the state that survives that.
 *
 * The click-in-place branch is `toggleLink`'s decision, which is the keyboard's
 * route through the same handle and was already right; the point of this
 * function is that the pointer reaches it too.
 */
export function resolveLinkRelease(
  pressed: string,
  armedBefore: string | null,
  releasedOver: string | null,
): LinkGesture {
  // Released on another block: a drag out of this handle, so this handle's own
  // block is the source whatever was armed before it.
  if (releasedOver !== null && releasedOver !== pressed) {
    return { kind: "connect", from: pressed, to: releasedOver };
  }
  // Released on bare canvas: a drag that arrived nowhere. The mode stays armed
  // from the handle that was pressed, so the operator can finish with a click
  // rather than having to start the gesture again.
  if (releasedOver === null) return { kind: "arm", from: pressed };
  // Back where it started, which is a click on the handle.
  if (armedBefore === null) return { kind: "arm", from: pressed };
  if (armedBefore === pressed) return { kind: "disarm" };
  return { kind: "connect", from: armedBefore, to: pressed };
}

/* ------------------------------------------------------------------ */
/* Draft to wire                                                       */
/* ------------------------------------------------------------------ */

/**
 * The draft as the save and validate routes read it.
 *
 * Nothing here supplies a value the operator has not given. A blank fan-out
 * goes over as `0` and a blank condition as `""`, and both are refused by name
 * — which is the point: the canvas shows `normalizeWorkflowInput`'s own
 * sentence, so there is one place that decides what a workflow may be.
 */
export function draftToGraph(draft: CanvasDraft): WireGraph {
  const nodes: WorkflowNodeDTO[] = draft.blocks.map((b) => {
    // The two kinds that start no child of their own send none of the six fields
    // that describe one. For a merge block the server coerces them away anyway;
    // for a loop every one of them is refused **by name** — it frames the blocks
    // it repeats and each of those names its own — so a block switched from run
    // to loop with a task still typed would otherwise be unsavable over controls
    // the panel is about to stop showing. Either way this is the same treatment
    // `mergeStrategy`, `fanOut` and `stopWhenTasks` below get: a value only ever
    // goes over the wire for the kind that holds it.
    const startsNoRun = b.kind === "merge" || b.kind === "loop";
    return {
      id: b.id,
      name: b.name.trim(),
      kind: b.kind,
      templateId: startsNoRun ? null : b.templateId || null,
      mountId: startsNoRun ? "" : b.mountId,
      folder: startsNoRun ? "" : b.folder,
      task: startsNoRun ? "" : b.task,
      promptOverride: startsNoRun ? null : b.promptOverride.trim() || null,
      agentId: startsNoRun ? null : b.agentId || null,
      fanOut: b.kind === "orchestrator" ? Number(b.fanOut) : null,
      // Sent only for the kind that holds them, so switching a block back to a run
      // cannot leave a merge setting on the wire for the server to ignore — the
      // treatment `fanOut` beside them already gets.
      mergeStrategy: b.kind === "merge" ? b.mergeStrategy : null,
      mergeAutoResolve: b.kind === "merge" && b.mergeAutoResolve,
      // Same treatment one kind along. A blank pass cap goes over as `0` and is
      // refused by name — which is the point, since a loop with no terminus is
      // the one thing `normalizeWorkflowInput` will not save — and a blank spend
      // cap goes over as null, because that one really is off.
      maxPasses: b.kind === "loop" ? Number(b.maxPasses) : null,
      maxLoopCostUSD:
        b.kind === "loop" && b.maxLoopCostUSD !== ""
          ? Number(b.maxLoopCostUSD)
          : null,
      // Sent only by the kind that holds it, and here that is what keeps a
      // *refusal* off the wire rather than a value the server ignores — a board
      // condition on anything but a loop is refused by name, so a block switched
      // from loop to run with a project still picked would otherwise be unsavable
      // over a control the panel no longer shows. `agentId` above takes the same
      // treatment for the same reason.
      stopWhenTasks:
        b.kind === "loop" && b.stopWhenTasksMountId !== ""
          ? {
              mountId: b.stopWhenTasksMountId,
              folder: b.stopWhenTasksFolder,
              includeSubfolders: b.stopWhenTasksIncludeSubfolders,
              statuses: b.stopWhenTasksStatuses
                .split(",")
                .filter((s) => s !== "") as TaskStatusDTO[],
              thresholds: b.stopWhenTasksThresholds.map((t) => ({
                priority: t.priority as TaskPriorityDTO | "any",
                // A cleared field goes over as `NaN` rather than as `Number("")`'s
                // 0, so it is refused by name instead of quietly becoming "until
                // there are none left" — which is a real setting, and the one
                // nobody would notice being chosen for them.
                atMost: t.atMost === "" ? Number.NaN : Number(t.atMost),
              })),
            }
          : null,
      // Derived from the links rather than held on the draft, and sent *as well
      // as* them: the links are what state a section and the list is the server's
      // cross-check on them. It cannot disagree with itself, because the list is
      // read out of the links it is sent beside. A block that is not a loop names
      // nothing, which is what `normalizeNode` refuses by name on every other
      // kind.
      bodyNodeIds:
        b.kind === "loop" ? sectionOf(b.id, draft.blocks, draft.links) : [],
    };
  });
  const edges = draft.links.map((l) => ({
    from: l.from,
    to: l.to,
    edge: l.edge,
    continueBranch: l.continueBranch,
  }));
  return { nodes, edges };
}

/**
 * The whole request a save sends: the graph, and what the graph does not carry.
 *
 * Held as the editor holds it — `maxInstanceCostUSD` a string because `""` is
 * how a number field says "off", the two fractions already through
 * `pctSubmit` — so that the body on the wire and the body a dirty check reads
 * are the same object rather than two derivations of one.
 */
export interface WorkflowDraftBody {
  name: string;
  graph: WireGraph;
  instanceBudget: {
    maxInstanceCostUSD: string;
    maxSessionFraction: number | null;
    maxWeeklyFraction: number | null;
  };
}

/**
 * What a save would store, as one string two drafts are compared by.
 *
 * The editor's dirty check is this against the signature taken when the page
 * mounted, and a whole-body comparison rather than a field-by-field diff
 * because one Save commits the whole graph: there is no partial state to
 * describe and nothing on screen that could describe it.
 *
 * **What it sees is exactly what a save would keep**, because it reads
 * `draftToGraph`'s output rather than the drafts behind it. A fan-out typed
 * into a block that is not an orchestrator is dropped by both, so it is not
 * work anybody can lose, and prompting over it would teach the operator to
 * dismiss the dialog — which is the same reasoning the guard is registered only
 * while there is something to lose.
 *
 * **The layout is deliberately absent**, for this file's own reason: a position
 * is a view of the graph rather than part of it, `writeLayout` has already
 * persisted it per browser, and a dragged box survives the tab that a typed
 * task does not. The name is trimmed because `normalizeWorkflowInput` trims it,
 * so a trailing space is not a change a save would preserve.
 */
export function draftSignature(body: WorkflowDraftBody): string {
  return JSON.stringify({
    name: body.name.trim(),
    graph: body.graph,
    instanceBudget: body.instanceBudget,
  });
}
