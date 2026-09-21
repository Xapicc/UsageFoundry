"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { WorkflowNodeKind } from "@/lib/apiTypes";
import {
  NODE_H,
  NODE_W,
  blockLabel,
  bodyRegions,
  edgeGeometry,
  freeSpot,
  layoutBounds,
  linkKey,
  linkRefusal,
  nodeBox,
  regionBounds,
  resolveLinkRelease,
  resolveRepeat,
  type BlockDraft,
  type Box,
  type LinkDraft,
  type Point,
} from "@/lib/canvasGraph";
import { EDGE_CHIP_LABEL } from "@/lib/format";
import { isTextEntry } from "@/components/shell/shortcuts";
import { Badge } from "@/components/ui/Badge";
import { Empty } from "@/components/ui/Card";

/**
 * The surface a workflow is drawn on.
 *
 * It owns the gestures and nothing else: where a block sits, what links what and
 * what is selected all live in `WorkflowEditor`, and every rule about what a
 * workflow may *be* lives on the server. This file decides only how a pointer
 * and a keyboard reach the same four actions — add a block, link two, remove a
 * link, remove a block — because a canvas that needs a mouse excludes an
 * operator, and this one starts billed agents.
 *
 * Each of the six has both routes:
 *   add     — drag a block off the palette, or press Enter on it
 *   link    — drag from a block's Link handle onto another, or take the handle
 *             and then the target in two presses, by pointer or by Enter
 *   repeat  — mark the blocks and press Repeat, which puts a frame round them
 *   member  — the link tool's two gestures on a frame's own handle, which puts
 *             a block inside that frame or takes one out
 *   unlink  — Delete or Backspace on the link's own control or on the canvas
 *             while it is selected, or Remove in the inspector beside it
 *   remove  — Delete or Backspace on the block's name or on the canvas while it
 *             is selected, or Remove in the inspector
 *
 * **A loop is drawn as the frame round the blocks it repeats, and has no card.**
 * What an operator approves is what they can see, and the thing a loop is now is
 * a boundary round a section rather than a block that does work — a card beside
 * its members would draw it as a seventh block in a graph of six. Everything a
 * card carried it carries in the frame's own strip: the name, the pass cap, the
 * endings, a Link handle for what runs before and after it, and the handle that
 * puts a block in or takes one out.
 *
 * **Nothing here stores a rectangle.** The frame is `bodyRegions`' reading of
 * where the members already are, and membership is the `repeats` link plus the
 * ordinary links after the block it names — so marking blocks and pressing
 * Repeat writes one link, and the frame that appears is the graph's own answer
 * rather than a second statement of it. A position is a per-browser view and may
 * not reach `WorkflowNode`; a frame computed from positions inherits that for
 * free, where a stored rectangle would have had to be kept out of the save by
 * hand.
 *
 * The membership handle is the link tool's gestures over a different relation,
 * down to `resolveLinkRelease` deciding both releases: a handle that arms itself
 * at the press, a drag that reaches a block, and a click-in-place that arms or
 * disarms. Reaching a block the frame already holds takes it out again, because
 * the gesture that put it in is the one an operator will reach for to undo it.
 *
 * Delete is the *only* destructive gesture here and there is deliberately no
 * undo: this app has no undo model, and a ⌘Z that put a block back but not the
 * links that came with it, or not the position it was dragged to, would be
 * worse than the absence — the operator would stop checking. What stands in for
 * one is that nothing on this canvas has been saved yet: the graph on the server
 * is whatever Save last sent, so leaving the editor discards a mistake whole.
 *
 * Pointer and keyboard reach those through *different* events on the same
 * controls, and `handledByPointer` is what keeps them from both firing: a
 * captured pointer sequence still dispatches a `click` at the end, so the
 * keyboard's handler would add a second block or re-arm a link that had just
 * been drawn. The `click` handler stays because it is also what a screen reader
 * or voice control dispatches, with no pointer events in front of it.
 *
 * Nothing here animates position. A dragged block follows the pointer exactly,
 * which is why it is an inline `left`/`top` with no transition on it —
 * `ui-transition` deliberately omits `transform` and `width`, and a block that
 * eased into place would lag the hand holding it.
 */

export type CanvasSelection =
  | { kind: "block"; id: string }
  | { kind: "link"; from: string; to: string };

/** What a block of each kind is called, wherever one is named. */
export const KIND_LABEL: Record<WorkflowNodeKind, string> = {
  run: "Runs a task",
  orchestrator: "Decides what to run",
  merge: "Lands the branches",
  // Not "repeats a task": a loop holds no task of its own any more, and the
  // model refuses the field by name. What it repeats is the section inside it.
  loop: "Repeats a section",
};

/** A kind that is drawn as a card. A loop is drawn as its frame — see above. */
type CardKind = Exclude<WorkflowNodeKind, "loop">;

/**
 * The card's edge, per kind, as one complete string each.
 *
 * The border colour and the elevation are decided together rather than half in
 * a shared string: two class strings setting one property under one variant
 * resolve by Tailwind's own sort order, which is not a contract.
 *
 * An orchestrator block wears the warn tint permanently, which is what the tint
 * is for — it starts runs with no approval, and that is a standing fact about
 * the block rather than a conditional alarm. A merge block wears the accent one
 * for the milder version of the same fact: it is the only block that writes into
 * the operator's own checkout.
 *
 * Typed against `CardKind` rather than every kind, so a loop drawn as a card
 * again is a type error rather than a picture that quietly contradicts the
 * model: the warn tint a loop used to wear is on its frame now, where the pass
 * cap it bounds is also written.
 */
const CARD_REST: Record<CardKind, string> = {
  run: "border-line shadow-e1",
  orchestrator: "border-warn-line shadow-e1",
  merge: "border-accent-line shadow-e1",
};

/**
 * Selection is a halo *around* the card, never its border.
 *
 * Replacing the border was the previous treatment and it cost the one thing the
 * border is for: selecting an orchestrator block painted its permanent warn edge
 * accent, so the block that starts agents with no approval stopped saying so at
 * exactly the moment somebody was looking at it. A ring is drawn outside the box
 * and sets a different property, so both facts are on screen at once and neither
 * class string can outrank the other.
 */
const CARD_SELECTED = "ring-[3px] ring-ring";

/**
 * Every arrow on this surface is a dependency, and there are three tones.
 *
 * The containment arrow that used to be a fourth is not drawn at all now: the
 * frame *is* how containment is said, and an arrow from a loop to the block its
 * pass starts at would be a second, contradictory picture of it — read as "the
 * section runs after the loop", which is precisely what a loop no longer is.
 * `DRAWN` below is where that is enforced, once.
 */
type LinkTone = "chosen" | "unchosen" | "selected";

const LINK_STROKE: Record<LinkTone, string> = {
  chosen: "stroke-line-strong",
  unchosen: "stroke-warn",
  selected: "stroke-accent",
};
const LINK_FILL: Record<LinkTone, string> = {
  chosen: "fill-line-strong",
  unchosen: "fill-warn",
  selected: "fill-accent",
};
const LINK_CHIP: Record<LinkTone, string> = {
  chosen: "border-line bg-surface text-ink-muted shadow-e1",
  unchosen: "border-warn-line bg-surface text-warn shadow-e1",
  selected: "border-accent-line bg-surface text-accent shadow-e1 ring-[3px] ring-ring",
};

/** A hairline, and one step up for the edge that is selected. Nothing shouts. */
const LINK_WIDTH: Record<LinkTone, number> = {
  chosen: 1.25,
  unchosen: 1.25,
  selected: 2,
};

/** How far a block moves per arrow key, and per arrow key with Shift held. */
const STEP = 24;
const FINE_STEP = 8;

/** A pointer that travelled less than this was a click, not a drag. */
const DRAG_SLOP = 6;

/** The smallest surface, so an empty canvas is still a place to drop onto. */
const MIN_W = 640;
const MIN_H = 420;

interface DragState {
  id: string;
  /** Pointer offset within the block, so it does not jump to its own corner. */
  dx: number;
  dy: number;
  /** Still false at the release means it was a click on the card, not a drag. */
  moved: boolean;
}

interface PlaceState {
  kind: WorkflowNodeKind;
  /** Where the press began, so a click can be told from a drag. */
  originX: number;
  originY: number;
  /** Where it has been dragged to, or null while it is still a click. */
  at: Point | null;
}

function isDeleteKey(key: string): boolean {
  return key === "Delete" || key === "Backspace";
}

export function WorkflowCanvas({
  blocks,
  links,
  positions,
  selection,
  full,
  onSelect,
  onMove,
  onAddBlock,
  onConnect,
  onRemoveLink,
  onRemoveBlock,
  onRepeat,
  onFrameMember,
}: {
  blocks: readonly BlockDraft[];
  links: readonly LinkDraft[];
  positions: ReadonlyMap<string, Point>;
  selection: CanvasSelection | null;
  /** The graph is at `MAX_WORKFLOW_NODES`, so nothing more may be added. */
  full: boolean;
  onSelect: (next: CanvasSelection | null) => void;
  onMove: (id: string, at: Point) => void;
  onAddBlock: (kind: WorkflowNodeKind, at: Point) => void;
  onConnect: (from: string, to: string) => void;
  onRemoveLink: (from: string, to: string) => void;
  onRemoveBlock: (id: string) => void;
  /**
   * Put a frame round the section that starts at `entryId`.
   *
   * The entry and nothing else, because that is the whole of what containment
   * is: the loop the editor mints gets one `repeats` link to this block, and
   * the members are whatever the graph already links after it. A list of
   * members would be a second statement of one fact.
   */
  onRepeat: (entryId: string) => void;
  /**
   * Put `blockId` inside `loopId`'s frame, or take it out if it is already in.
   *
   * One call for both directions, because it is one gesture: the handle says
   * which of the two a press will do before it is pressed, and the links that
   * carry it out are `linksWithMember`/`linksWithoutMember` in the editor.
   */
  onFrameMember: (loopId: string, blockId: string) => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const handledByPointer = useRef(false);
  /**
   * What was armed when the press on a Link handle began.
   *
   * A ref rather than state because the press itself arms the handle it is on —
   * so that a drag out of it draws from the block being dragged from — and the
   * release still has to be able to tell that gesture from a click on **Link
   * here**, which completes the link the *other* block armed.
   */
  const armedBeforePress = useRef<string | null>(null);
  /** The same, for a frame's membership handle. See `startFrame`. */
  const frameArmedBeforePress = useRef<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [place, setPlace] = useState<PlaceState | null>(null);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  /** The frame taking a member, armed exactly like `linkFrom`. */
  const [frameFrom, setFrameFrom] = useState<string | null>(null);
  const [pointerAt, setPointerAt] = useState<Point | null>(null);
  /**
   * The blocks a frame would go round, and the selected one is always among
   * them.
   *
   * Canvas state rather than the editor's `selection`, which names exactly one
   * thing because the inspector shows exactly one thing. Marking is what lets
   * an operator *see* what Repeat is about to enclose before pressing it, which
   * is the only reason to mark at all: membership is derived from the links, so
   * marking the head block alone would frame the same section. That is also the
   * route below the breakpoint, where there is no modifier to hold.
   */
  const [marked, setMarked] = useState<string[]>([]);
  /**
   * Why the last gesture did nothing, or null.
   *
   * Said here rather than left to the refusal under the canvas, and that is the
   * whole point of it: `graphRefusal` answers about a graph, so a link drawn
   * into a frame is an arrow the operator watched appear and then a sentence
   * about one of its two ends. Cleared by the next gesture of any kind, because
   * a stale reason beside a canvas that has moved on is worse than none.
   */
  const [notice, setNotice] = useState<string | null>(null);

  const linkSource = blocks.find((b) => b.id === linkFrom);
  const linkOrigin = linkFrom === null ? undefined : positions.get(linkFrom);
  const linking = linkSource !== undefined && linkOrigin !== undefined;

  const frameSource = blocks.find((b) => b.id === frameFrom);

  /**
   * The frame round each loop's section, derived rather than stored.
   *
   * Memoised because it walks the graph once per loop and a drag re-renders
   * this component on every pointer move — and the derivation is what has to
   * keep up with the hand, since the frame tracks the box being dragged.
   */
  const regions = useMemo(
    () => bodyRegions(blocks, links, positions),
    [blocks, links, positions],
  );
  const frameOrigin = regions.find((r) => r.loopId === frameFrom);
  const framing = frameSource !== undefined && frameOrigin !== undefined;

  /**
   * Which loop repeats a block and where in the pass it sits, so a card can
   * mark itself and a press on it can take it back out again.
   */
  const repeatedBy = useMemo(() => {
    const owner = new Map<string, { loopId: string; mark: string }>();
    for (const region of regions) {
      region.memberIds.forEach((id, index) =>
        owner.set(id, {
          loopId: region.loopId,
          mark: sectionMark(
            index,
            region.memberIds.length,
            id === region.exitId,
          ),
        }),
      );
    }
    return owner;
  }, [regions]);

  /**
   * The links that are drawn, which is every dependency and no containment.
   *
   * One filter, named, because three places walk the links to draw something —
   * the curves, the chips and the narrow list's incoming chips — and a
   * containment arrow that survived in any one of them would be the picture
   * contradicting the frame beside it. See `LinkTone`.
   */
  const drawn = useMemo(
    () => links.filter((l) => l.edge !== "repeats"),
    [links],
  );

  /** Every block that is drawn as a card, which is every block but the loops. */
  const cards = useMemo(
    () =>
      blocks.filter(
        (b): b is BlockDraft & { kind: CardKind } => b.kind !== "loop",
      ),
    [blocks],
  );

  /**
   * The rectangle an arrow leaves or arrives at, which is not always a card.
   *
   * A link to a loop is a link to the whole frame — that is what "runs before
   * the loop" means — so the arrow has to reach the frame's edge. Drawn at the
   * loop's own invisible box it would end at a corner of the frame with nothing
   * in it, which reads as pointing at the first member rather than at the
   * section.
   */
  const boxOf = useCallback(
    (id: string): Box | null => {
      const region = regions.find((r) => r.loopId === id);
      if (region) return region;
      const at = positions.get(id);
      return at ? nodeBox(at) : null;
    },
    [positions, regions],
  );

  /** The box the half-drawn link leaves, which is a frame's for a loop. */
  const linkBox = linkFrom === null ? null : boxOf(linkFrom);

  /** The whole surface has to hold the frames, not only the cards inside them. */
  const bounds = layoutBounds(positions);
  const frameBounds = regionBounds(regions);
  const width = Math.max(bounds.width, frameBounds.width, MIN_W);
  const height = Math.max(bounds.height, frameBounds.height, MIN_H);

  // A block that has gone takes the half-drawn link with it, or the next choice
  // lands an edge on something that is no longer there.
  useEffect(() => {
    if (linkFrom !== null && !blocks.some((b) => b.id === linkFrom)) {
      setLinkFrom(null);
    }
  }, [blocks, linkFrom]);

  // The same for a frame taking a member, and one case more: a loop whose kind
  // was switched in the inspector is still in the graph but is not drawn as a
  // frame any more, so a press on the next block would put it inside nothing.
  useEffect(() => {
    if (
      frameFrom !== null &&
      !blocks.some((b) => b.id === frameFrom && b.kind === "loop")
    ) {
      setFrameFrom(null);
    }
  }, [blocks, frameFrom]);

  // A marked block that has been deleted would keep Repeat enabled over a
  // selection with nothing in it, and `resolveRepeat` would then frame whatever
  // was left of it rather than refusing.
  useEffect(() => {
    setMarked((current) => {
      const live = current.filter((id) => blocks.some((b) => b.id === id));
      return live.length === current.length ? current : live;
    });
  }, [blocks]);

  const pointIn = useCallback((clientX: number, clientY: number): Point => {
    const rect = sheetRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: clientX - rect.left, y: clientY - rect.top };
  }, []);

  const overSheet = useCallback((clientX: number, clientY: number): boolean => {
    const rect = sheetRef.current?.getBoundingClientRect();
    if (!rect) return false;
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    );
  }, []);

  /** Which block is under a point, for a link dropped rather than clicked. */
  const blockAt = useCallback(
    (p: Point): string | null => {
      for (const block of blocks) {
        const at = positions.get(block.id);
        if (!at) continue;
        if (
          p.x >= at.x &&
          p.x <= at.x + NODE_W &&
          p.y >= at.y &&
          p.y <= at.y + NODE_H
        ) {
          return block.id;
        }
      }
      return null;
    },
    [blocks, positions],
  );

  /* ---------------------------------------------------------------- */
  /* Moving a block                                                    */
  /* ---------------------------------------------------------------- */

  function startDrag(event: ReactPointerEvent<HTMLDivElement>, id: string) {
    // The buttons on the card are the keyboard's whole route in; a press on one
    // has to reach it rather than being swallowed as the start of a drag.
    if ((event.target as HTMLElement).closest("button")) return;
    const at = positions.get(id);
    if (!at) return;
    const p = pointIn(event.clientX, event.clientY);
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ id, dx: p.x - at.x, dy: p.y - at.y, moved: false });
  }

  function moveDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drag) return;
    const p = pointIn(event.clientX, event.clientY);
    const next = {
      x: Math.max(0, p.x - drag.dx),
      y: Math.max(0, p.y - drag.dy),
    };
    if (!drag.moved) {
      const at = positions.get(drag.id);
      const travelled = at
        ? Math.hypot(next.x - at.x, next.y - at.y)
        : DRAG_SLOP + 1;
      if (travelled <= DRAG_SLOP) return;
      setDrag({ ...drag, moved: true });
    }
    onMove(drag.id, next);
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drag) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const { id, moved } = drag;
    setDrag(null);
    // A press that went nowhere is a click on the card, and the whole card is
    // the target: the name is a button because the keyboard needs one, not
    // because it is the only place worth aiming at.
    if (moved) return;
    if (claimArmed(id)) return;
    onSelect({ kind: "block", id });
  }

  function nudge(id: string, dx: number, dy: number) {
    const at = positions.get(id);
    if (!at) return;
    onMove(id, { x: Math.max(0, at.x + dx), y: Math.max(0, at.y + dy) });
  }

  /* ---------------------------------------------------------------- */
  /* Adding a block                                                    */
  /* ---------------------------------------------------------------- */

  function addAtFreeSpot(kind: WorkflowNodeKind) {
    onAddBlock(kind, freeSpot(positions));
  }

  function startPlace(
    event: ReactPointerEvent<HTMLButtonElement>,
    kind: WorkflowNodeKind,
  ) {
    if (full) return;
    handledByPointer.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    setPlace({
      kind,
      originX: event.clientX,
      originY: event.clientY,
      at: null,
    });
  }

  function movePlace(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!place) return;
    const travelled = Math.hypot(
      event.clientX - place.originX,
      event.clientY - place.originY,
    );
    if (place.at === null && travelled <= DRAG_SLOP) return;
    setPlace({ ...place, at: pointIn(event.clientX, event.clientY) });
  }

  function endPlace(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!place) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const dropped = place.at;
    const kind = place.kind;
    const onCanvas = overSheet(event.clientX, event.clientY);
    setPlace(null);
    handledByPointer.current = true;
    // A press that never travelled is a click, and a click still adds the block
    // — a palette that appears to do nothing unless you think to drag is a
    // palette half the operators cannot use.
    if (dropped === null) {
      addAtFreeSpot(kind);
      return;
    }
    // Released away from the surface: nothing is added, and the ghost that was
    // following the pointer has already gone.
    if (!onCanvas) return;
    onAddBlock(kind, {
      x: Math.max(0, dropped.x - NODE_W / 2),
      y: Math.max(0, dropped.y - NODE_H / 2),
    });
  }

  /* ---------------------------------------------------------------- */
  /* Linking two blocks                                               */
  /* ---------------------------------------------------------------- */

  function startLink(event: ReactPointerEvent<HTMLButtonElement>, id: string) {
    event.stopPropagation();
    handledByPointer.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    // Remembered rather than discarded. The handle arms itself so a drag out of
    // it draws from this block, and overwriting the armed source with no record
    // of it is what made a click on **Link here** re-arm the link from the
    // target instead of completing it.
    armedBeforePress.current = linkFrom;
    setLinkFrom(id);
    // One tool at a time. Both relations are "press a handle, then a block",
    // so two armed at once would make the next press on a card ambiguous —
    // and the press that resolved it would be the one nobody expected.
    setFrameFrom(null);
    setPointerAt(null);
    setNotice(null);
  }

  function moveLink(event: ReactPointerEvent<HTMLButtonElement>) {
    if (linkFrom === null) return;
    setPointerAt(pointIn(event.clientX, event.clientY));
  }

  function cancelLink() {
    // The gesture was taken away, so the press it belonged to is over: a later
    // release that never had a press in front of it must not read this.
    armedBeforePress.current = null;
    setPointerAt(null);
  }

  function endLink(event: ReactPointerEvent<HTMLButtonElement>, id: string) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setPointerAt(null);
    // Set either way, before anything else: this pointer sequence has already
    // armed the mode at its `pointerdown`, and the `click` that follows would
    // otherwise reach `toggleLink` and re-arm a link this release has just
    // drawn, or disarm one it has just armed.
    handledByPointer.current = true;
    const armedBefore = armedBeforePress.current;
    armedBeforePress.current = null;
    // Read off this event rather than off the last move: they are at the same
    // place, and one of them is state that may not have flushed.
    const releasedOver = blockAt(pointIn(event.clientX, event.clientY));
    const gesture = resolveLinkRelease(id, armedBefore, releasedOver);
    if (gesture.kind === "connect") {
      connect(gesture.from, gesture.to);
      return;
    }
    setLinkFrom(gesture.kind === "arm" ? gesture.from : null);
  }

  /** The keyboard's and assistive technology's route through the handle. */
  function toggleLink(id: string) {
    setFrameFrom(null);
    setNotice(null);
    if (linkFrom === null) setLinkFrom(id);
    else if (linkFrom === id) setLinkFrom(null);
    else chooseTarget(id);
  }

  function chooseTarget(id: string): boolean {
    if (linkFrom === null || linkFrom === id) return false;
    connect(linkFrom, id);
    return true;
  }

  /**
   * Draw the link, or say why it cannot be drawn where it was let go.
   *
   * The arm is dropped either way, because the gesture is over either way: an
   * operator who has been told the frame is what to link to has to be able to
   * start again from the frame, and a handle still armed from the refused
   * attempt would make their next press complete the same refusal.
   */
  function connect(from: string, to: string) {
    setLinkFrom(null);
    const refusal = linkRefusal(from, to, blocks, links);
    if (refusal !== null) {
      setNotice(refusal);
      return;
    }
    setNotice(null);
    onConnect(from, to);
  }

  /* ---------------------------------------------------------------- */
  /* Putting blocks in a frame                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Mark a block, or make it the only marked one.
   *
   * Both routes land here: a shift-, ⌘- or ctrl-click on a card, and Shift+Enter
   * on the same card's name button, because a `<button>`'s `click` carries the
   * modifier either way. So the keyboard reaches the Repeat gesture through the
   * control the pointer reaches it through, rather than through a key nobody
   * would guess.
   */
  function markBlock(id: string, extend: boolean) {
    setNotice(null);
    setMarked((current) => {
      if (!extend) return [id];
      return current.includes(id)
        ? current.filter((other) => other !== id)
        : [...current, id];
    });
  }

  /** Put a frame round what is marked, or say why that would mean nothing. */
  function repeatMarked() {
    const gesture = resolveRepeat(marked, blocks, links);
    if (gesture.kind === "refused") {
      setNotice(gesture.because);
      return;
    }
    setNotice(null);
    setMarked([]);
    onRepeat(gesture.entryId);
  }

  function startFrame(event: ReactPointerEvent<HTMLButtonElement>, id: string) {
    event.stopPropagation();
    handledByPointer.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    frameArmedBeforePress.current = frameFrom;
    setFrameFrom(id);
    setLinkFrom(null);
    setPointerAt(null);
    setNotice(null);
  }

  function moveFrame(event: ReactPointerEvent<HTMLButtonElement>) {
    if (frameFrom === null) return;
    setPointerAt(pointIn(event.clientX, event.clientY));
  }

  function cancelFrame() {
    frameArmedBeforePress.current = null;
    setPointerAt(null);
  }

  function endFrame(event: ReactPointerEvent<HTMLButtonElement>, id: string) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setPointerAt(null);
    handledByPointer.current = true;
    const armedBefore = frameArmedBeforePress.current;
    frameArmedBeforePress.current = null;
    const releasedOver = blockAt(pointIn(event.clientX, event.clientY));
    // `resolveLinkRelease` and not a second copy of its three branches: the
    // gesture is the same one over a different relation, and the bug it was
    // written for — the press overwriting the source the release still needed
    // — is reachable through this handle in exactly the same way.
    const gesture = resolveLinkRelease(id, armedBefore, releasedOver);
    if (gesture.kind === "connect") {
      chooseMember(gesture.to, gesture.from);
      return;
    }
    setFrameFrom(gesture.kind === "arm" ? gesture.from : null);
  }

  /** The keyboard's and assistive technology's route through that handle. */
  function toggleFrame(id: string) {
    setLinkFrom(null);
    setNotice(null);
    if (frameFrom === null) setFrameFrom(id);
    else if (frameFrom === id) setFrameFrom(null);
    else chooseMember(id);
  }

  /**
   * A press on a block while a frame's own handle is armed.
   *
   * Stays armed afterwards, unlike every other gesture here: a section is
   * usually assembled a block at a time, and a handle that disarmed itself
   * after one would make "put these three in" three round trips to a control at
   * the top of the frame. Escape and a second press on the handle both end it,
   * and the strip above the canvas says so while it is armed.
   */
  function chooseMember(id: string, loopId = frameFrom): boolean {
    if (loopId === null || loopId === id) return false;
    // The loop of a frame cannot go inside another — `resolveRepeat` refuses
    // the same thing at the other gesture, and the server refuses it by name.
    const block = blocks.find((b) => b.id === id);
    if (block?.kind === "loop") {
      setNotice(`${blockLabel(block)} is a loop, and a loop cannot be inside another one.`);
      return true;
    }
    setNotice(null);
    setFrameFrom(loopId);
    onFrameMember(loopId, id);
    return true;
  }

  /** Whichever tool is armed has first claim on a press on a block. */
  function claimArmed(id: string): boolean {
    return chooseTarget(id) || chooseMember(id);
  }

  function claimedByPointer(): boolean {
    if (!handledByPointer.current) return false;
    handledByPointer.current = false;
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Keys                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Delete, for whatever the inspector beside this is showing.
   *
   * The two controls that carry an identity of their own — a block's name and a
   * link's condition chip — handle this themselves and stop it here, so the
   * *focused* thing always wins over the *selected* one on the rare occasion
   * they disagree (Tab moves focus without selecting). This handler is what
   * covers the ordinary case: click a block, press Delete, with focus nowhere in
   * particular.
   *
   * `preventDefault` is not cosmetic — Backspace outside a text field is the
   * browser's own Back on more than one engine, and losing the whole draft to it
   * is a worse outcome than the one this key is for.
   */
  function surfaceKeys(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (
      event.key === "Escape" &&
      (linkFrom !== null || frameFrom !== null || notice !== null)
    ) {
      setLinkFrom(null);
      setFrameFrom(null);
      setNotice(null);
      event.stopPropagation();
      return;
    }
    if (!isDeleteKey(event.key) || selection === null) return;
    // Nothing on this surface is a text field today. The guard is here because
    // the day one arrives, the failure is a swallowed keystroke that looks like
    // a dropped character — see `shortcuts.ts`, where the same rule is stated.
    if (isTextEntry(event.target)) return;
    event.preventDefault();
    if (selection.kind === "block") onRemoveBlock(selection.id);
    else onRemoveLink(selection.from, selection.to);
  }

  function blockKeys(event: ReactKeyboardEvent<HTMLButtonElement>, id: string) {
    if (isDeleteKey(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      onRemoveBlock(id);
      return;
    }
    const step = event.shiftKey ? FINE_STEP : STEP;
    switch (event.key) {
      case "ArrowLeft":
        nudge(id, -step, 0);
        break;
      case "ArrowRight":
        nudge(id, step, 0);
        break;
      case "ArrowUp":
        nudge(id, 0, -step);
        break;
      case "ArrowDown":
        nudge(id, 0, step);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  /* ---------------------------------------------------------------- */
  /* Render                                                            */
  /* ---------------------------------------------------------------- */

  // The order the narrow viewport's list reads the graph in: the sheet's own,
  // column then row, so a reader who has seen the canvas on a screen finds the
  // same first block here. A block the layout has not placed yet sorts last
  // rather than being dropped — the list is the only way to reach it below the
  // breakpoint, so it may not be the thing that hides it.
  const narrowOrder = [...blocks].sort((a, b) => {
    const pa = positions.get(a.id);
    const pb = positions.get(b.id);
    if (!pa || !pb) return pa ? -1 : pb ? 1 : 0;
    return pa.x - pb.x || pa.y - pb.y;
  });

  return (
    // The frame: a toolbar strip, the surface, and a footer that says what the
    // gestures are. Clipped, so the recessed surface takes the frame's corners
    // rather than squaring them off inside it.
    <div
      className="overflow-hidden rounded-lg border border-line bg-surface shadow-e2"
      onKeyDown={surfaceKeys}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-2.5 py-2">
        <span className="text-xs font-medium text-ink-muted">Add</span>
        {(Object.keys(KIND_LABEL) as WorkflowNodeKind[])
          .filter((kind) => kind !== "loop")
          .map((kind) => (
            <button
              key={kind}
              type="button"
              disabled={full}
              onPointerDown={(event) => startPlace(event, kind)}
              onPointerMove={movePlace}
              onPointerUp={endPlace}
              onPointerCancel={() => setPlace(null)}
              onClick={() => {
                if (claimedByPointer()) return;
                addAtFreeSpot(kind);
              }}
              // 44px below the shell's breakpoint, stated in the same string as
              // the pointer's height for `Button`'s SIZE-map reason. These are
              // hand-rolled rather than `Button`s — they carry a pointer sequence
              // of their own — so the floor the kit applies once has to be
              // repeated here, and it is the only route a finger has to the
              // palette. `uf-button` for the same reason and the same cost: the
              // kit's hook class is inert in the default skin and is the only
              // thing that puts a hand-rolled control inside the ascii skin's
              // `[ … ]`, which these four were the last unbracketed buttons on
              // their page for want of.
              className="uf-button ui-transition inline-flex min-h-[var(--control-h)] max-md:min-h-11
                cursor-grab touch-none select-none items-center rounded-sm border border-line
                bg-bezel px-2.5 text-sm font-medium text-ink shadow-e1
                not-disabled:hover:bg-bezel-hover not-disabled:active:shadow-press
                disabled:cursor-not-allowed disabled:opacity-50"
            >
              {KIND_LABEL[kind]}
            </button>
          ))}
        {/* The gesture that makes a loop, and the only one: there is no Loop in
            the palette above, because a loop with nothing inside it is a graph
            the server refuses and a palette that offers one is a palette that
            offers a refusal. Disabled with nothing marked rather than hidden —
            the control is how an operator learns the gesture exists, and its
            hint below says what to mark. */}
        <span className="ml-3 text-xs font-medium text-ink-muted">Repeat</span>
        <button
          type="button"
          disabled={marked.length === 0 || full}
          onClick={repeatMarked}
          aria-describedby={notice === null ? undefined : NOTICE_ID}
          className="uf-button ui-transition inline-flex min-h-[var(--control-h)] max-md:min-h-11
            cursor-pointer select-none items-center rounded-sm border border-warn-line
            bg-bezel px-2.5 text-sm font-medium text-ink shadow-e1
            not-disabled:hover:bg-bezel-hover not-disabled:active:shadow-press
            disabled:cursor-not-allowed disabled:opacity-50"
        >
          {marked.length <= 1
            ? "These blocks"
            : `These ${marked.length} blocks`}
        </button>
        <span className="ml-auto text-xs tabular-nums text-ink-muted">
          {blocks.length} block{blocks.length === 1 ? "" : "s"} · {drawn.length}{" "}
          link{drawn.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* Said plainly rather than worked around, and the arithmetic that says
          so is unchanged: a 390px window is about 358px of pane against a
          `NODE_W` of 232 and a `COL_STRIDE` of 328, so the sheet holds exactly
          one block and the gap to the next — measured at 356×352 over a
          1592×420 sheet, 22% of its width. What that leaves is not a graph a
          thumb can read but a picker showing one of six blocks behind a
          two-axis pan, so below the breakpoint the sheet is replaced by the
          list under it rather than capped and scrolled. Placing blocks against
          each other is still what this declines to pretend at; reaching the
          sixth of them is what the list stops charging for. `md:hidden` rather
          than a JS width test: the shell already owns the app's one
          `matchMedia`, and a second would be a second boundary to keep in
          step. */}
      <p className="border-b border-line bg-inset px-3 py-1.5 text-xs text-ink-muted md:hidden">
        A graph is arranged on a larger screen. Here the blocks are listed in
        the order it runs them — tap one to edit it in the panel below.
      </p>

      {linking && (
        <div className="border-b border-line bg-inset px-3 py-1.5 text-xs text-ink-muted">
          Linking from{" "}
          <strong className="font-semibold text-ink">{label(linkSource)}</strong>{" "}
          — choose the block that starts after it. Escape cancels.
        </div>
      )}

      {framing && (
        <div className="border-b border-line bg-inset px-3 py-1.5 text-xs text-ink-muted">
          Putting blocks inside{" "}
          <strong className="font-semibold text-ink">
            {label(frameSource)}
          </strong>{" "}
          — choose one to put in, or one already in it to take out. Escape
          stops.
        </div>
      )}

      {/* The refusal a gesture earned, beside the gestures rather than under
          the canvas with the graph's: this one is about the arrow that was just
          drawn and reads as an answer only while that is what happened. */}
      {notice !== null && (
        <div
          id={NOTICE_ID}
          className="border-b border-warn-line bg-warn/10 px-3 py-1.5 text-xs text-ink"
        >
          {notice}
        </div>
      )}

      {/* The mode is a fact about the whole surface and a screen reader has no
          other way to learn it: the strip above is nowhere near the handle that
          was just pressed. The refusal is announced here too and not only in
          the strip, because a pointer user is looking at the block they
          released over rather than at the top of the canvas. */}
      <p className="sr-only" role="status" aria-live="polite">
        {notice !== null
          ? notice
          : linking
            ? `Linking from ${label(linkSource)}. Choose the block that starts after it, or press Escape.`
            : framing
              ? `Putting blocks inside ${label(frameSource)}. Choose a block to put in, or one already in it to take out. Press Escape to stop.`
              : ""}
      </p>

      {/* `tabIndex={-1}` is what makes the Delete above reachable at all. A
          React `onKeyDown` on the frame only sees keys that bubble from a
          *focused descendant*, and pressing a block's card focuses nothing — the
          card is a plain div, so `activeElement` stays `<body>` and the key never
          enters this subtree. Pressing inside a focusable region focuses the
          region, so this is the one attribute that connects "click a block, press
          Delete" to the handler written for it. Out of the tab order, and a
          pointer press yields `:focus` rather than `:focus-visible`, so nothing
          draws a ring. */}
      {/* `max-md:hidden` and not a tightened cap. The cap that used to stand
          here — 22rem, three block-heights — was answering the right problem,
          that a nested scroller filling a phone reads as the end of the page
          when the inspector holding the block's guards is under it. It could
          not answer the other one: `overflow-auto` on a sheet at least 640px
          wide is what keeps the *pane* from scrolling sideways, so a reader at
          390px pans two axes through a window onto 22% of the graph's width to
          reach the sixth block. Hiding the sheet costs the arrangement, which
          this surface already declines to offer a finger; the list below keeps
          every gesture that was left. */}
      <div
        tabIndex={-1}
        className="relative max-h-[62vh] overflow-auto bg-inset max-md:hidden"
      >
        <div
          ref={sheetRef}
          className="dot-grid relative"
          style={{ width, height }}
          onPointerDown={(event) => {
            // A press on the surface itself rather than on a block: clear what
            // the inspector is showing, and drop out of link mode for anyone
            // who did not find Escape.
            if (event.target === event.currentTarget) {
              onSelect(null);
              setLinkFrom(null);
              setFrameFrom(null);
            }
          }}
        >
          {blocks.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <Empty>
                <div className="font-medium text-ink">No blocks yet</div>
                <div className="mt-1">Drag one from Add, or press Enter on it</div>
              </Empty>
            </div>
          )}

          {/* Under the edges and the cards. The *body* of a frame stays inert,
              so a press in the space between two members still reaches the
              surface and clears the selection — the area round a section may
              not be the one part of the canvas a click does nothing on. Its
              strip is not: that is where the loop's name, its caps, its
              endings and its two handles are, and it is the whole of what a
              loop is drawn as. */}
          {regions.map((region) => {
            const owner = blocks.find((b) => b.id === region.loopId);
            if (!owner) return null;
            const selected =
              selection?.kind === "block" && selection.id === region.loopId;
            const armed = linkFrom === region.loopId;
            return (
              <div
                key={region.loopId}
                style={{
                  left: region.x,
                  top: region.y,
                  width: region.width,
                  height: region.height,
                }}
                // The warn tint the loop's card used to wear, on the thing that
                // replaced it: this is still the boundary that decides how many
                // billed runs one press of Run may start. Dashed and at 5% fill
                // because the cards are drawn on top of it — a solid edge at a
                // card's own weight would read as a box somebody could drag.
                className={`pointer-events-none absolute rounded-xl border border-dashed
                  border-warn-line bg-warn/5 ${
                    frameFrom === region.loopId || selected
                      ? "ring-[3px] ring-ring"
                      : ""
                  }`}
              >
                <div className="pointer-events-auto absolute inset-x-0 top-0 flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2 py-1">
                  <button
                    type="button"
                    onClick={() => {
                      if (claimArmed(region.loopId)) return;
                      onSelect({ kind: "block", id: region.loopId });
                    }}
                    onKeyDown={(event) => {
                      if (!isDeleteKey(event.key)) return;
                      event.preventDefault();
                      event.stopPropagation();
                      onRemoveBlock(region.loopId);
                    }}
                    // The frame's whole sentence in one label, because a screen
                    // reader meets this before any of the members and the two
                    // questions a drawn frame cannot answer aloud are which
                    // block starts a pass and which one lands it.
                    aria-label={`${label(owner)} — repeats ${
                      region.memberIds.length
                    } block${region.memberIds.length === 1 ? "" : "s"}, ${
                      region.entryId === null
                        ? "nothing in it yet"
                        : `starting at ${label(
                            blocks.find((b) => b.id === region.entryId),
                          )}`
                    }${
                      region.exitId === null
                        ? region.memberIds.length === 0
                          ? ""
                          : ". No merge block to land a pass through"
                        : `, landing through ${label(
                            blocks.find((b) => b.id === region.exitId),
                          )}`
                    }. ${passCapLabel(owner)}, ${endingLabel(owner)}.${
                      linking && !armed ? ` Starts after ${label(linkSource)}.` : ""
                    } Delete removes this frame and leaves its blocks.`}
                    className="ui-transition -my-0.5 cursor-pointer rounded-sm border border-transparent
                      bg-transparent px-1 py-0.5 text-left text-2xs font-semibold text-warn
                      hover:bg-fill-hover"
                  >
                    <span className="block truncate">{label(owner)}</span>
                  </button>

                  {/* The three facts a card used to carry, in the order an
                      operator asks them: how big a pass is, how many passes,
                      and what makes it stop. Never abbreviated away — this is
                      the sentence a press of Run is approved against and the
                      inspector's copy of it is one click further off. */}
                  <span className="text-2xs text-warn" aria-hidden>
                    {region.memberIds.length} block
                    {region.memberIds.length === 1 ? "" : "s"} in order ·{" "}
                    {passCapLabel(owner)} · {endingLabel(owner)}
                  </span>

                  <span className="ml-auto flex items-center gap-1.5">
                    <button
                      type="button"
                      onPointerDown={(event) => startFrame(event, region.loopId)}
                      onPointerMove={moveFrame}
                      onPointerUp={(event) => endFrame(event, region.loopId)}
                      onPointerCancel={cancelFrame}
                      onClick={() => {
                        if (claimedByPointer()) return;
                        toggleFrame(region.loopId);
                      }}
                      aria-pressed={frameFrom === region.loopId}
                      aria-label={
                        frameFrom === region.loopId
                          ? `Stop putting blocks inside ${label(owner)}`
                          : `Put a block inside ${label(owner)}`
                      }
                      // The Link handle's recipe, and the same note applies to
                      // the stretched `::after` on the label: see that button.
                      className={`uf-button ${
                        frameFrom === region.loopId ? "uf-button-primary" : ""
                      } ui-transition inline-flex min-h-[var(--control-h)] cursor-pointer
                        max-md:relative touch-none items-center rounded-sm border px-2 py-0.5
                        text-2xs font-semibold ${
                          frameFrom === region.loopId
                            ? "border-warn-line bg-warn/10 text-ink"
                            : "border-line bg-bezel text-ink-muted shadow-e1 hover:bg-bezel-hover hover:text-ink"
                        }`}
                    >
                      <span
                        className="max-md:after:absolute max-md:after:-inset-y-[6px]
                          max-md:after:-inset-x-[3px] max-md:after:content-['']"
                      >
                        {frameFrom === region.loopId ? "Done" : "Put in"}
                      </span>
                    </button>

                    {/* A frame's own Link handle, which is the only way to say
                        what runs before and after the whole loop: a link drawn
                        to a member is refused, and this is what the refusal
                        names. */}
                    <button
                      type="button"
                      onPointerDown={(event) => startLink(event, region.loopId)}
                      onPointerMove={moveLink}
                      onPointerUp={(event) => endLink(event, region.loopId)}
                      onPointerCancel={cancelLink}
                      onClick={() => {
                        if (claimedByPointer()) return;
                        toggleLink(region.loopId);
                      }}
                      aria-pressed={armed}
                      aria-label={
                        armed
                          ? `Cancel linking from ${label(owner)}`
                          : linking
                            ? `Start ${label(owner)} after ${label(linkSource)}`
                            : `Link from ${label(owner)}`
                      }
                      className={`uf-button ${armed ? "uf-button-primary" : ""} ui-transition
                        inline-flex min-h-[var(--control-h)] cursor-pointer max-md:relative
                        touch-none items-center rounded-sm border px-2 py-0.5 text-2xs font-semibold
                        ${
                          armed
                            ? "border-accent-line bg-accent-dim text-ink"
                            : "border-line bg-bezel text-ink-muted shadow-e1 hover:bg-bezel-hover hover:text-ink"
                        }`}
                    >
                      <span
                        className="max-md:after:absolute max-md:after:-inset-y-[6px]
                          max-md:after:-inset-x-[3px] max-md:after:content-['']"
                      >
                        {armed ? "Cancel" : linking ? "Link here" : "Link"}
                      </span>
                    </button>
                  </span>
                </div>

                {region.memberIds.length === 0 && (
                  <span
                    aria-hidden
                    className="absolute inset-x-0 bottom-3 text-center text-2xs text-warn"
                  >
                    Nothing in it yet — Put in
                  </span>
                )}
              </div>
            );
          })}

          <svg
            className="pointer-events-none absolute left-0 top-0"
            width={width}
            height={height}
            aria-hidden
          >
            {drawn.map((link) => {
              const from = boxOf(link.from);
              const to = boxOf(link.to);
              if (!from || !to) return null;
              const geometry = edgeGeometry(from, to);
              const tone = linkTone(link, selection);
              return (
                <g key={linkKey(link)}>
                  <path
                    d={geometry.d}
                    fill="none"
                    strokeWidth={LINK_WIDTH[tone]}
                    className={LINK_STROKE[tone]}
                  />
                  <path
                    d={`M ${geometry.tip.x} ${geometry.tip.y} l -8 -4.5 l 0 9 z`}
                    className={LINK_FILL[tone]}
                  />
                </g>
              );
            })}

            {/* Off whatever the armed handle belongs to, which is a frame's
                right edge when the link is leaving the whole loop. */}
            {linking && pointerAt && linkBox !== null && (
              <path
                d={`M ${linkBox.x + linkBox.width} ${linkBox.y + linkBox.height / 2} L ${pointerAt.x} ${pointerAt.y}`}
                fill="none"
                strokeWidth={1.25}
                strokeDasharray="5 4"
                className="stroke-accent"
              />
            )}

            {/* From the middle of the frame rather than its right edge, which
                is where a link leaves: putting a block inside is not a thing
                that runs after the loop, and a line leaving the same point as
                an edge would say it was. */}
            {framing && pointerAt && (
              <path
                d={`M ${frameOrigin.x + frameOrigin.width / 2} ${frameOrigin.y + frameOrigin.height / 2} L ${pointerAt.x} ${pointerAt.y}`}
                fill="none"
                strokeWidth={1.25}
                strokeDasharray="2 5"
                strokeLinecap="round"
                className="stroke-warn"
              />
            )}
          </svg>

          {drawn.map((link) => {
            const from = boxOf(link.from);
            const to = boxOf(link.to);
            if (!from || !to) return null;
            const { mid } = edgeGeometry(from, to);
            const tone = linkTone(link, selection);
            const source = blocks.find((b) => b.id === link.from);
            const target = blocks.find((b) => b.id === link.to);
            return (
              <button
                key={linkKey(link)}
                type="button"
                onClick={() =>
                  onSelect({ kind: "link", from: link.from, to: link.to })
                }
                onKeyDown={(event) => {
                  if (!isDeleteKey(event.key)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  onRemoveLink(link.from, link.to);
                }}
                aria-label={`${label(target)} starts after ${label(source)}, ${
                  EDGE_CHIP_LABEL[link.edge]
                }${link.continueBranch ? ", carries on its branch" : ""}. Delete removes this link.`}
                style={{ left: mid.x, top: mid.y }}
                // 44px below the breakpoint, beside the pointer's height for
                // the palette's reason. It grows about the curve's midpoint
                // rather than downwards from it — the chip is centred on the
                // edge by a translate — so the link it labels does not move.
                className={`ui-transition absolute z-10 inline-flex min-h-[var(--control-h)]
                  max-md:min-h-11 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center
                  gap-1.5 whitespace-nowrap rounded-pill border px-2.5 py-1 text-2xs font-semibold
                  ${LINK_CHIP[tone]}`}
              >
                {EDGE_CHIP_LABEL[link.edge]}
                {link.continueBranch && <span className="text-accent">· branch</span>}
              </button>
            );
          })}

          {cards.map((block) => {
            const at = positions.get(block.id);
            if (!at) return null;
            const selected =
              selection?.kind === "block" && selection.id === block.id;
            const armed = linkFrom === block.id;
            const inSection = repeatedBy.get(block.id);
            const owner = blocks.find((b) => b.id === inSection?.loopId);
            const isMarked = marked.includes(block.id);
            return (
              <div
                key={block.id}
                style={{ left: at.x, top: at.y, width: NODE_W, height: NODE_H }}
                className="absolute"
              >
                <div
                  onPointerDown={(event) => startDrag(event, block.id)}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  className={`ui-transition flex h-full touch-none select-none flex-col
                    rounded-lg border bg-surface p-2.5 ${
                      drag?.id === block.id ? "cursor-grabbing" : "cursor-grab"
                    } ${CARD_REST[block.kind]} ${selected ? CARD_SELECTED : ""} ${
                      // Marked and selected are different facts and are drawn
                      // differently: the ring says "the inspector is showing
                      // this", the offset one says "Repeat would enclose this".
                      // Both at once is the ordinary state of the gesture.
                      isMarked ? "outline outline-2 outline-offset-2 outline-warn-line" : ""
                    }`}
                >
                  <button
                    type="button"
                    // One handler for the pointer and the keyboard, because a
                    // `<button>`'s click carries `shiftKey` whether it came
                    // from a mouse or from Shift+Enter — so the modifier that
                    // marks a second block is the same gesture on both, and
                    // neither needs a key of its own to learn.
                    onClick={(event) => {
                      if (claimArmed(block.id)) return;
                      markBlock(
                        block.id,
                        event.shiftKey || event.metaKey || event.ctrlKey,
                      );
                      onSelect({ kind: "block", id: block.id });
                    }}
                    onKeyDown={(event) => blockKeys(event, block.id)}
                    aria-pressed={isMarked}
                    aria-label={`${label(block)} — ${KIND_LABEL[block.kind]}${
                      owner && inSection
                        ? `. Repeated by ${label(owner)}, ${inSection.mark}`
                        : ""
                    }${
                      linking && !armed ? ". Starts after " + label(linkSource) : ""
                    }${
                      framing
                        ? inSection?.loopId === frameFrom
                          ? `. Take out of ${label(frameSource)}`
                          : `. Put inside ${label(frameSource)}`
                        : ""
                    }. Shift and Enter together marks it for Repeat. Delete removes this block.`}
                    className="ui-transition -mx-1 mb-1 cursor-pointer rounded-sm border
                      border-transparent bg-transparent px-1 py-0.5 text-left text-sm
                      font-medium text-ink hover:bg-fill-hover"
                  >
                    <span className="block truncate">{label(block)}</span>
                  </button>

                  <div className="mono truncate text-ink-muted">
                    {block.kind === "merge"
                      ? "every branch in front of it"
                      : `${block.mountId || "—"} / ${block.folder || "."}`}
                  </div>
                  <div className="mt-0.5 flex-1 overflow-hidden text-xs leading-snug text-ink-faint">
                    <span className="line-clamp-2">
                      {block.kind === "merge"
                        ? "Puts each branch onto the target its run recorded."
                        : block.task.trim() || "No task yet"}
                    </span>
                  </div>

                  <div className="mt-1 flex items-center justify-between gap-2">
                    {/* Where in the pass this block sits, on the card rather
                        than on the frame behind it: the members may be anywhere
                        on the surface, so a mark drawn on the frame would name
                        a corner and not a block. Entry and exit are named
                        rather than numbered — see `sectionMark` — because those
                        are the two questions a drawn frame cannot answer. */}
                    {/* A member's mark and its kind's own figure are both on
                        the badge, never one instead of the other: an
                        orchestrator's fan-out is what a pass costs and a merge
                        block's strategy is what it does to the operator's
                        checkout, and neither stops being true for being inside
                        a frame. */}
                    {inSection || block.kind !== "run" ? (
                      <Badge
                        tone={
                          block.kind === "merge" &&
                          !block.mergeAutoResolve &&
                          !inSection
                            ? "accent"
                            : "warn"
                        }
                      >
                        {[
                          inSection?.mark,
                          block.kind === "orchestrator"
                            ? `up to ${block.fanOut || "?"}`
                            : null,
                          block.kind === "merge"
                            ? `${block.mergeStrategy}${
                                block.mergeAutoResolve ? " · AI resolve" : ""
                              }`
                            : null,
                        ]
                          .filter((part) => part)
                          .join(" · ")}
                      </Badge>
                    ) : (
                      <span />
                    )}
                    <button
                      type="button"
                      onPointerDown={(event) => startLink(event, block.id)}
                      onPointerMove={moveLink}
                      onPointerUp={(event) => endLink(event, block.id)}
                      onPointerCancel={cancelLink}
                      onClick={() => {
                        if (claimedByPointer()) return;
                        toggleLink(block.id);
                      }}
                      aria-pressed={armed}
                      aria-label={
                        armed
                          ? `Cancel linking from ${label(block)}`
                          : linking
                            ? `Start ${label(block)} after ${label(linkSource)}`
                            : `Link from ${label(block)}`
                      }
                      // `Switch`'s recipe, and the one control here that needs
                      // it: the card is a fixed NODE_H, so a 44px *box* would
                      // take the twelve pixels the task preview above it is
                      // drawn in. So the box stays at --control-h and the
                      // target comes from a stretched `::after` the layout
                      // never sees — 6px past the chip top and bottom, 3px
                      // each side, which lands inside the `gap-2` to the badge
                      // beside it and the card's own p-2.5, so no two targets
                      // on a card can touch. `max-md:relative` rather than a
                      // bare one, so the containing block this creates does
                      // not exist above the breakpoint either.
                      //
                      // The target sits on the *label's* `::after` and not this
                      // element's, which is the price of `uf-button`: the ascii
                      // skin draws its closing bracket in `.uf-button::after`,
                      // and that block is unlayered, so it outranks the utility
                      // outright — one element cannot be both. The rectangle is
                      // unchanged, because an absolutely positioned pseudo of a
                      // static child resolves against the same containing block
                      // the button's own would have.
                      // `uf-button-primary` for the armed state, because the
                      // fill that state is drawn with is gone under the skin
                      // and the accent has to survive it as a text colour.
                      className={`uf-button ${armed ? "uf-button-primary" : ""} ui-transition
                        inline-flex min-h-[var(--control-h)] cursor-pointer max-md:relative
                        touch-none items-center rounded-sm border px-2 py-1 text-2xs font-semibold
                        ${
                          armed
                            ? "border-accent-line bg-accent-dim text-ink"
                            : "border-line bg-bezel text-ink-muted shadow-e1 hover:bg-bezel-hover hover:text-ink"
                        }`}
                    >
                      <span
                        className="max-md:after:absolute max-md:after:-inset-y-[6px]
                          max-md:after:-inset-x-[3px] max-md:after:content-['']"
                      >
                        {armed ? "Cancel" : linking ? "Link here" : "Link"}
                      </span>
                    </button>
                  </div>
                </div>
              </div>
            );
          })}

          {place?.at && (
            <div
              aria-hidden
              style={{
                left: place.at.x - NODE_W / 2,
                top: place.at.y - NODE_H / 2,
                width: NODE_W,
                height: NODE_H,
              }}
              className="pointer-events-none absolute rounded-lg border border-dashed border-accent bg-accent-dim/40"
            />
          )}
        </div>
      </div>

      {/* The narrow viewport's reading of the same graph. Order is the sheet's
          own — left to right, then top to bottom — so the list and the canvas
          never disagree about which block comes first, and it is read off
          `positions` rather than re-derived, because the arrangement is the
          operator's and a second ordering rule would drift from it. Every
          gesture the sheet still offered a finger has a route here: the row
          selects, the row completes an armed link the way a card does, Link
          arms one, and an incoming link is a chip that selects it for the
          panel below. Nothing here writes: it is the same `onSelect` the
          canvas calls, so what a node holds and what an instance does with it
          are untouched. */}
      <ul className="border-t border-line md:hidden">
        {narrowOrder.length === 0 && (
          /* The sheet carried this sentence and is hidden here, so the list
             owes it: an empty new workflow would otherwise be a rule between
             the note and the footer and nothing else. */
          <li className="px-2.5 py-4">
            <Empty>
              <div className="font-medium text-ink">No blocks yet</div>
              <div className="mt-1">Tap one in Add</div>
            </Empty>
          </li>
        )}
        {narrowOrder.map((block) => {
          const selected =
            selection?.kind === "block" && selection.id === block.id;
          const armed = linkFrom === block.id;
          const inSection = repeatedBy.get(block.id);
          const owner = blocks.find((b) => b.id === inSection?.loopId);
          const incoming = drawn.filter((link) => link.to === block.id);
          const isLoop = block.kind === "loop";
          const region = regions.find((r) => r.loopId === block.id);
          return (
            <li
              key={block.id}
              className="border-b border-line px-2.5 py-2 last:border-b-0"
            >
              <div className="flex flex-wrap items-start gap-2">
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    if (claimArmed(block.id)) return;
                    // No modifier exists at this width, so a tap marks one
                    // block and Repeat frames it with everything linked after
                    // it. That is the whole gesture here — see `marked`.
                    markBlock(block.id, false);
                    onSelect({ kind: "block", id: block.id });
                  }}
                  aria-label={
                    framing && frameFrom !== block.id
                      ? inSection?.loopId === frameFrom
                        ? `Take ${label(block)} out of ${label(frameSource)}`
                        : `Put ${label(block)} inside ${label(frameSource)}`
                      : undefined
                  }
                  className={`ui-transition min-h-11 min-w-32 flex-1 cursor-pointer rounded-md px-2 py-1.5 text-left ${
                    selected ? "bg-accent-dim" : "hover:bg-inset"
                  }`}
                >
                  <span className="block text-sm font-medium text-ink">
                    {label(block)}
                  </span>
                  <span className="mt-0.5 block text-xs text-ink-faint">
                    {KIND_LABEL[block.kind]}
                    {owner && inSection && (
                      /* The frame's sentence at a width the frame is not drawn
                         at, and the card's own mark with it: the two questions
                         a section has to answer are the same at both widths,
                         and there is no frame here to draw them on. */
                      <span className="text-warn">
                        {" "}
                        · repeated by {label(owner)}, {inSection.mark}
                      </span>
                    )}
                    {isLoop && region && (
                      /* The frame's own strip, for the same reason: at this
                         width a loop is a row like any other, and the two caps
                         and the endings are what it is. */
                      <span className="text-warn">
                        {" "}
                        · {region.memberIds.length} block
                        {region.memberIds.length === 1 ? "" : "s"} in order ·{" "}
                        {passCapLabel(block)} · {endingLabel(block)}
                      </span>
                    )}
                  </span>
                  {block.kind !== "merge" && !isLoop && block.mountId ? (
                    /* `truncate` for the card's reason: a folder is the one
                       fact on this row with no length a reader can predict,
                       and four wrapped lines of it would bury the name above
                       it. The whole path is one tap away in the panel. */
                    <span className="mono mt-0.5 block truncate text-xs text-ink-muted">
                      {block.mountId} / {block.folder || "."}
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  onClick={() => toggleLink(block.id)}
                  aria-pressed={armed}
                  // The same control as the card's below the breakpoint, so it
                  // takes the same two hook classes: this is the Link the ascii
                  // skin reaches at 390px, where the canvas is not drawn at all
                  // and the card's own never renders.
                  className={`uf-button ${armed ? "uf-button-primary" : ""} ui-transition
                    min-h-11 shrink-0 cursor-pointer rounded-md border px-3 text-xs ${
                      armed
                        ? "border-accent-line bg-accent-dim text-accent"
                        : "border-line text-ink-muted hover:bg-inset"
                    }`}
                >
                  {linkFrom !== null && !armed ? "Link here" : "Link"}
                </button>
                {isLoop && (
                  // No pointer sequence on this one: there is nothing at this
                  // width to drag onto, so it is the two-press route only —
                  // which is the route the keyboard takes above the breakpoint
                  // too, through the same `toggleFrame`.
                  <button
                    type="button"
                    onClick={() => toggleFrame(block.id)}
                    aria-pressed={frameFrom === block.id}
                    className={`uf-button ${
                      frameFrom === block.id ? "uf-button-primary" : ""
                    } ui-transition min-h-11 shrink-0 cursor-pointer rounded-md border px-3
                      text-xs ${
                        frameFrom === block.id
                          ? "border-warn-line bg-warn/10 text-warn"
                          : "border-line text-ink-muted hover:bg-inset"
                      }`}
                  >
                    {frameFrom === block.id ? "Done" : "Put in"}
                  </button>
                )}
              </div>
              {incoming.length > 0 && (
                <ul className="mt-1 flex flex-wrap gap-1.5 pl-2">
                  {incoming.map((link) => {
                    const from = blocks.find((b) => b.id === link.from);
                    return (
                      <li key={linkKey(link)}>
                        <button
                          type="button"
                          onClick={() =>
                            onSelect({
                              kind: "link",
                              from: link.from,
                              to: link.to,
                            })
                          }
                          className={`ui-transition min-h-11 max-w-full cursor-pointer rounded-lg border px-2.5 py-1 text-left text-xs ${
                            LINK_CHIP[linkTone(link, selection)]
                          }`}
                        >
                          after {from ? label(from) : link.from} ·{" "}
                          {EDGE_CHIP_LABEL[link.edge]}
                          {link.continueBranch && (
                            <span className="text-accent"> · branch</span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      {/* The gestures, and which half of each exists depends on the input:
          "press Enter" and "Delete" name keys a phone does not have, where the
          panel below the canvas is the route a finger takes to those same two
          acts. Both spellings are rendered and one is hidden rather than
          branched on in JS — `AppShell` owns the app's one `matchMedia` and a
          second would be a second boundary to keep in step — so the line above
          the breakpoint is unchanged character for character. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-line px-2.5 py-1.5 text-xs text-ink-faint">
        <span>
          {full ? (
            "This workflow is full"
          ) : (
            <>
              <span className="max-md:hidden">
                Drag a block onto the canvas, or press Enter to place it
              </span>
              <span className="md:hidden">
                Tap one in Add — it joins the end of the list
              </span>
            </>
          )}
        </span>
        <span className="max-md:hidden">
          Delete removes what is selected — there is no undo
        </span>
        {/* Unconditional, unlike the line it replaced: Repeat is how a loop is
            *made* now, so a graph with no loop in it is exactly the graph whose
            operator has not found the gesture yet. */}
        <span className="max-md:hidden">
          Repeat frames the marked blocks — Shift-click marks another
        </span>
        <span className="md:hidden">
          Repeat frames the tapped block and everything linked after it
        </span>
        <span className="md:hidden">
          Remove is in the panel below — there is no undo
        </span>
      </div>
    </div>
  );
}

/**
 * What a block is called on screen before it has been given a name.
 *
 * `blockLabel` under a shorter name, because this file says it forty times in
 * JSX and the long one is what the refusals in `canvasGraph.ts` are built from
 * — one definition, so a sentence that names a frame names it the way the
 * frame's own strip does.
 */
const label = blockLabel;

/** How many passes a loop may take, in the frame's own words. */
function passCapLabel(loop: BlockDraft): string {
  const cap = Number(loop.maxPasses);
  if (!Number.isInteger(cap) || cap <= 0) return "no pass cap yet";
  return `at most ${cap} pass${cap === 1 ? "" : "es"}`;
}

/**
 * What ends this loop, shortest first.
 *
 * The two caps and the board condition, never the DONE: every run member
 * reporting the work complete is what ends *any* loop and is not a fact about
 * this one, so the frame states the endings an operator chose. The inspector's
 * `BlockStatement` is where all four are said together.
 */
function endingLabel(loop: BlockDraft): string {
  const spend = loop.maxLoopCostUSD.trim();
  const parts: string[] = [];
  if (spend !== "") parts.push(`$${spend} across them`);
  if (loop.stopWhenTasksMountId !== "") parts.push("a board condition");
  return parts.length === 0 ? "no other ending" : `stops on ${parts.join(" or ")}`;
}

/** Where the canvas's own refusal is written, for the control it refused. */
const NOTICE_ID = "workflow-canvas-notice";

function isSelectedLink(
  link: LinkDraft,
  selection: CanvasSelection | null,
): boolean {
  return (
    selection?.kind === "link" &&
    selection.from === link.from &&
    selection.to === link.to
  );
}

function linkTone(link: LinkDraft, selection: CanvasSelection | null): LinkTone {
  if (isSelectedLink(link, selection)) return "selected";
  return link.edge === "" ? "unchosen" : "chosen";
}

/**
 * Where a block sits in the pass, in the words the frame marks it with.
 *
 * "What runs first" and "where the work lands" are the two questions a drawn
 * frame cannot answer on its own — the members may be anywhere inside it, and
 * the arrows between them are the same arrows everything else on the canvas is
 * drawn with. So the entry and the exit are **named** rather than numbered, and
 * everything between them is numbered rather than named: a middle block's
 * position is a fact about the order, and the two ends are facts about what a
 * pass is.
 *
 * "Lands the pass" rather than "last of 3", because that is what the exit *is*
 * — the merge block a pass's work becomes visible to the next pass through.
 * Ordinal for the last member of a section that ends anywhere else, which is a
 * graph the server refuses: the mark may not claim a landing that is not there.
 */
function sectionMark(index: number, size: number, isExit: boolean): string {
  if (isExit) return index === 0 ? "the whole pass" : "lands the pass";
  if (index === 0) return "starts a pass";
  if (index === size - 1) return `last of ${size}`;
  return `${index + 1} of ${size}`;
}
