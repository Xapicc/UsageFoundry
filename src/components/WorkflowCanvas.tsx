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
  bodyRegions,
  edgeGeometry,
  sectionOf,
  freeSpot,
  layoutBounds,
  linkKey,
  resolveLinkRelease,
  type BlockDraft,
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
 * Each of the five has both routes:
 *   add     — drag a block off the palette, or press Enter on it
 *   link    — drag from a block's Link handle onto another, or take the handle
 *             and then the target in two presses, by pointer or by Enter
 *   repeat  — the same two gestures on a loop's Repeat handle, which draws the
 *             one link that says what that loop repeats
 *   unlink  — Delete or Backspace on the link's own control or on the canvas
 *             while it is selected, or Remove in the inspector beside it
 *   remove  — Delete or Backspace on the block's name or on the canvas while it
 *             is selected, or Remove in the inspector
 *
 * Repeat is the link tool's own gestures drawing a link with a different
 * condition on it, down to `resolveLinkRelease` deciding both releases: a
 * handle that arms itself at the press, a drag that reaches another block, and
 * a click-in-place that arms or disarms. What it draws is the `repeats` link,
 * which says where the section starts; the rest of the section is the ordinary
 * links after that block, so there is nothing else to tick and nothing here
 * that writes a membership list. Reaching the block the loop already repeats
 * removes that link again, because the gesture that drew it is the one an
 * operator will reach for to undo it.
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
  loop: "Repeats a task",
};

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
 * the operator's own checkout. A loop block wears the warn tint for the
 * orchestrator's reason read one level along: it too starts runs nobody approves
 * one by one, however many its pass cap allows.
 */
const CARD_REST: Record<WorkflowNodeKind, string> = {
  run: "border-line shadow-e1",
  orchestrator: "border-warn-line shadow-e1",
  merge: "border-accent-line shadow-e1",
  loop: "border-warn-line shadow-e1",
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
 * `repeats` is a tone of its own and not a variant of `chosen`.
 *
 * It is the one arrow on this surface that is not a dependency — nothing waits
 * for the block it points at — and drawn like the others the picture would say
 * the section starts *after* the loop. So it takes the loop's own warn hue,
 * which is the colour the region round its section is drawn in, and the dash
 * pattern below. The tone survives selection for the same reason a block's kind
 * survives it: what an arrow *means* may not stop being visible at the moment
 * somebody looks at it, so selection is a ring on the chip and a width, and the
 * stroke keeps saying which relation this is.
 */
type LinkTone = "chosen" | "unchosen" | "selected" | "repeats";

const LINK_STROKE: Record<LinkTone, string> = {
  chosen: "stroke-line-strong",
  unchosen: "stroke-warn",
  selected: "stroke-accent",
  repeats: "stroke-warn",
};
const LINK_FILL: Record<LinkTone, string> = {
  chosen: "fill-line-strong",
  unchosen: "fill-warn",
  selected: "fill-accent",
  repeats: "fill-warn",
};
const LINK_CHIP: Record<LinkTone, string> = {
  chosen: "border-line bg-surface text-ink-muted shadow-e1",
  unchosen: "border-warn-line bg-surface text-warn shadow-e1",
  selected: "border-accent-line bg-surface text-accent shadow-e1 ring-[3px] ring-ring",
  repeats: "border-warn-line border-dashed bg-surface text-warn shadow-e1",
};

/**
 * The dash the containment arrow is drawn with, matching the region's own
 * border. `undefined` is a solid line, which every dependency keeps.
 */
const LINK_DASH: Partial<Record<LinkTone, string>> = {
  repeats: "6 4",
};

/** A hairline, and one step up for the edge that is selected. Nothing shouts. */
const LINK_WIDTH: Record<LinkTone, number> = {
  chosen: 1.25,
  unchosen: 1.25,
  selected: 2,
  repeats: 1.25,
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
   * Draw `loopId`'s “repeats” link to `firstId`, or remove the one already
   * pointing there. What the loop repeats is that block and everything linked
   * after it, so this is the whole of what the handle sets.
   */
  onRepeat: (loopId: string, firstId: string) => void;
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
  /** The same, for the Repeat handle. See `startRepeat`. */
  const repeatArmedBeforePress = useRef<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [place, setPlace] = useState<PlaceState | null>(null);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  /** The loop whose section is being assembled, armed exactly like `linkFrom`. */
  const [repeatFrom, setRepeatFrom] = useState<string | null>(null);
  const [pointerAt, setPointerAt] = useState<Point | null>(null);

  const bounds = layoutBounds(positions);
  const width = Math.max(bounds.width, MIN_W);
  const height = Math.max(bounds.height, MIN_H);

  const linkSource = blocks.find((b) => b.id === linkFrom);
  const linkOrigin = linkFrom === null ? undefined : positions.get(linkFrom);
  const linking = linkSource !== undefined && linkOrigin !== undefined;

  const repeatSource = blocks.find((b) => b.id === repeatFrom);
  const repeatOrigin =
    repeatFrom === null ? undefined : positions.get(repeatFrom);
  const repeating = repeatSource !== undefined && repeatOrigin !== undefined;

  /**
   * The area drawn round each loop's section, derived rather than stored.
   *
   * Memoised because it walks the graph once per loop and a drag re-renders
   * this component on every pointer move — and the derivation is what has to
   * keep up with the hand, since the region tracks the box being dragged.
   */
  const regions = useMemo(
    () => bodyRegions(blocks, links, positions),
    [blocks, links, positions],
  );
  /**
   * Which loop repeats a block and where in the pass it sits, so a card can
   * mark itself and a press on it can undo the link that put it there.
   */
  const repeatedBy = useMemo(() => {
    const owner = new Map<string, { loopId: string; mark: string }>();
    for (const region of regions) {
      region.memberIds.forEach((id, index) =>
        owner.set(id, {
          loopId: region.loopId,
          mark: sectionMark(index, region.memberIds.length),
        }),
      );
    }
    return owner;
  }, [regions]);
  /** The block each loop's “repeats” link points at, or nothing. */
  const repeatsFirst = useMemo(() => {
    const first = new Map<string, string>();
    for (const l of links) {
      if (l.edge === "repeats" && !first.has(l.from)) first.set(l.from, l.to);
    }
    return first;
  }, [links]);

  // A block that has gone takes the half-drawn link with it, or the next choice
  // lands an edge on something that is no longer there.
  useEffect(() => {
    if (linkFrom !== null && !blocks.some((b) => b.id === linkFrom)) {
      setLinkFrom(null);
    }
  }, [blocks, linkFrom]);

  // The same for a section being assembled, and one case more: a loop whose
  // kind was switched in the inspector is still on the canvas but no longer has
  // a section, so a press on the next block would name a body nothing reads.
  useEffect(() => {
    if (
      repeatFrom !== null &&
      !blocks.some((b) => b.id === repeatFrom && b.kind === "loop")
    ) {
      setRepeatFrom(null);
    }
  }, [blocks, repeatFrom]);

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
    setRepeatFrom(null);
    setPointerAt(null);
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
      setLinkFrom(null);
      onConnect(gesture.from, gesture.to);
      return;
    }
    setLinkFrom(gesture.kind === "arm" ? gesture.from : null);
  }

  /** The keyboard's and assistive technology's route through the handle. */
  function toggleLink(id: string) {
    setRepeatFrom(null);
    if (linkFrom === null) setLinkFrom(id);
    else if (linkFrom === id) setLinkFrom(null);
    else chooseTarget(id);
  }

  function chooseTarget(id: string): boolean {
    if (linkFrom === null || linkFrom === id) return false;
    onConnect(linkFrom, id);
    setLinkFrom(null);
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Repeating a section                                              */
  /* ---------------------------------------------------------------- */

  function startRepeat(event: ReactPointerEvent<HTMLButtonElement>, id: string) {
    event.stopPropagation();
    handledByPointer.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    repeatArmedBeforePress.current = repeatFrom;
    setRepeatFrom(id);
    setLinkFrom(null);
    setPointerAt(null);
  }

  function moveRepeat(event: ReactPointerEvent<HTMLButtonElement>) {
    if (repeatFrom === null) return;
    setPointerAt(pointIn(event.clientX, event.clientY));
  }

  function cancelRepeat() {
    repeatArmedBeforePress.current = null;
    setPointerAt(null);
  }

  function endRepeat(event: ReactPointerEvent<HTMLButtonElement>, id: string) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setPointerAt(null);
    handledByPointer.current = true;
    const armedBefore = repeatArmedBeforePress.current;
    repeatArmedBeforePress.current = null;
    const releasedOver = blockAt(pointIn(event.clientX, event.clientY));
    // `resolveLinkRelease` and not a second copy of its three branches: the
    // gesture is the same one over a different relation, and the bug it was
    // written for — the press overwriting the source the release still needed
    // — is reachable through this handle in exactly the same way.
    const gesture = resolveLinkRelease(id, armedBefore, releasedOver);
    if (gesture.kind === "connect") {
      // Disarmed on the way out, exactly as `endLink` is: a loop has one
      // “repeats” link, so the gesture is over. Assembling the rest of the
      // section is the ordinary Link handle, block to block.
      setRepeatFrom(null);
      onRepeat(gesture.from, gesture.to);
      return;
    }
    setRepeatFrom(gesture.kind === "arm" ? gesture.from : null);
  }

  /** The keyboard's and assistive technology's route through that handle. */
  function toggleRepeat(id: string) {
    setLinkFrom(null);
    if (repeatFrom === null) setRepeatFrom(id);
    else if (repeatFrom === id) setRepeatFrom(null);
    else chooseMember(id);
  }

  /**
   * A press on a block while a loop's Repeat handle is armed.
   *
   * A toggle rather than an add, because the link it draws leaves the loop
   * rather than the block under the pointer, and hunting for a chip in the
   * middle of a curve to press Delete on is not the gesture anybody reaches for
   * to undo a press they just made. The handle says which of the two it will do
   * before it is pressed.
   */
  function chooseMember(id: string): boolean {
    if (repeatFrom === null || repeatFrom === id) return false;
    onRepeat(repeatFrom, id);
    setRepeatFrom(null);
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
    if (event.key === "Escape" && (linkFrom !== null || repeatFrom !== null)) {
      setLinkFrom(null);
      setRepeatFrom(null);
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
        {(Object.keys(KIND_LABEL) as WorkflowNodeKind[]).map((kind) => (
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
        <span className="ml-auto text-xs tabular-nums text-ink-muted">
          {blocks.length} block{blocks.length === 1 ? "" : "s"} · {links.length}{" "}
          link{links.length === 1 ? "" : "s"}
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

      {repeating && (
        <div className="border-b border-line bg-inset px-3 py-1.5 text-xs text-ink-muted">
          Choosing what{" "}
          <strong className="font-semibold text-ink">
            {label(repeatSource)}
          </strong>{" "}
          repeats — choose the block each pass starts at. The rest of the
          section is whatever is linked after it. Escape stops.
        </div>
      )}

      {/* The mode is a fact about the whole surface and a screen reader has no
          other way to learn it: the strip above is nowhere near the handle that
          was just pressed. */}
      <p className="sr-only" role="status" aria-live="polite">
        {linking
          ? `Linking from ${label(linkSource)}. Choose the block that starts after it, or press Escape.`
            : repeating
              ? `Choosing what ${label(repeatSource)} repeats. Choose the block each pass starts at; the rest of the section is whatever is linked after it. Press Escape to stop.`
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
              setRepeatFrom(null);
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

          {/* Under the edges and the cards, and inert: a press has to reach
              the surface beneath it, which is what clears the selection, and
              a region that swallowed one would make the area round a section
              the one part of the canvas a click does nothing on.

              `aria-hidden` because it states nothing a screen reader cannot
              already reach: which loop repeats a block is in that block's own
              name button, and the section in order is in the inspector. A
              landmark here would be a third place saying it. */}
          {regions.map((region) => {
            const owner = blocks.find((b) => b.id === region.loopId);
            return (
              <div
                key={region.loopId}
                aria-hidden
                style={{
                  left: region.x,
                  top: region.y,
                  width: region.width,
                  height: region.height,
                }}
                // The loop card's own `border-warn-line`, so the area reads as
                // belonging to the block that owns it rather than as a second
                // thing on the canvas. Dashed and at 5% fill because it is
                // behind the cards: a solid edge at a card's own weight would
                // read as a box somebody could select.
                className={`pointer-events-none absolute rounded-xl border border-dashed
                  border-warn-line bg-warn/5 ${
                    repeatFrom === region.loopId ? "ring-[3px] ring-ring" : ""
                  }`}
              >
                <span className="absolute left-2.5 top-1 truncate text-2xs font-semibold text-warn">
                  Repeated by {label(owner)} · {region.memberIds.length} block
                  {region.memberIds.length === 1 ? "" : "s"} in order
                </span>
              </div>
            );
          })}

          <svg
            className="pointer-events-none absolute left-0 top-0"
            width={width}
            height={height}
            aria-hidden
          >
            {links.map((link) => {
              const from = positions.get(link.from);
              const to = positions.get(link.to);
              if (!from || !to) return null;
              const geometry = edgeGeometry(from, to);
              const tone = linkTone(link, selection);
              return (
                <g key={linkKey(link)}>
                  <path
                    d={geometry.d}
                    fill="none"
                    strokeWidth={LINK_WIDTH[tone]}
                    strokeDasharray={LINK_DASH[tone]}
                    className={LINK_STROKE[tone]}
                  />
                  <path
                    d={`M ${geometry.tip.x} ${geometry.tip.y} l -8 -4.5 l 0 9 z`}
                    className={LINK_FILL[tone]}
                  />
                </g>
              );
            })}

            {linking && pointerAt && (
              <path
                d={`M ${linkOrigin.x + NODE_W} ${linkOrigin.y + NODE_H / 2} L ${pointerAt.x} ${pointerAt.y}`}
                fill="none"
                strokeWidth={1.25}
                strokeDasharray="5 4"
                className="stroke-accent"
              />
            )}

            {/* From the middle of the loop rather than its right edge, which is
                where a link leaves: a section is not a thing that runs after
                the loop, and a line leaving the same point as an edge would
                say it was. */}
            {repeating && pointerAt && (
              <path
                d={`M ${repeatOrigin.x + NODE_W / 2} ${repeatOrigin.y + NODE_H / 2} L ${pointerAt.x} ${pointerAt.y}`}
                fill="none"
                strokeWidth={1.25}
                strokeDasharray="2 5"
                strokeLinecap="round"
                className="stroke-warn"
              />
            )}
          </svg>

          {links.map((link) => {
            const from = positions.get(link.from);
            const to = positions.get(link.to);
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
                aria-label={
                  link.edge === "repeats"
                    ? `${label(source)} repeats ${label(target)} and the section linked after it. Delete removes this link.`
                    : `${label(target)} starts after ${label(source)}, ${
                        EDGE_CHIP_LABEL[link.edge]
                      }${link.continueBranch ? ", carries on its branch" : ""}. Delete removes this link.`
                }
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

          {blocks.map((block) => {
            const at = positions.get(block.id);
            if (!at) return null;
            const selected =
              selection?.kind === "block" && selection.id === block.id;
            const armed = linkFrom === block.id;
            const inSection = repeatedBy.get(block.id);
            const owner = blocks.find((b) => b.id === inSection?.loopId);
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
                    } ${CARD_REST[block.kind]} ${selected ? CARD_SELECTED : ""}`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (claimArmed(block.id)) return;
                      onSelect({ kind: "block", id: block.id });
                    }}
                    onKeyDown={(event) => blockKeys(event, block.id)}
                    aria-label={`${label(block)} — ${KIND_LABEL[block.kind]}${
                      owner && inSection
                        ? `. Repeated by ${label(owner)}, ${inSection.mark}${
                            // The fact the whole section is ordered for. Said
                            // here and in the block's own statement, and
                            // nowhere in between: a middle block would be
                            // claiming it if the clause were unconditional.
                            inSection.mark.startsWith("last") ||
                            inSection.mark === "the only one"
                              ? " — its DONE ends the loop"
                              : ""
                          }`
                        : ""
                    }${
                      linking && !armed ? ". Starts after " + label(linkSource) : ""
                    }${
                      repeating && repeatFrom !== block.id
                        ? repeatsFirst.get(repeatFrom!) === block.id
                          ? `. Stop ${label(repeatSource)} repeating from here`
                          : `. Start what ${label(repeatSource)} repeats here`
                        : ""
                    }. Delete removes this block.`}
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
                    {/* The section's order, on the card rather than on the
                        region behind it: the members may be anywhere on the
                        surface, so a mark drawn on the area would name a
                        corner and not a block. The slot is the one a run block
                        had nothing in. */}
                    {inSection && block.kind === "run" ? (
                      <Badge tone="warn">{inSection.mark}</Badge>
                    ) : block.kind === "orchestrator" ? (
                      <Badge tone="warn">up to {block.fanOut || "?"}</Badge>
                    ) : block.kind === "merge" ? (
                      <Badge tone={block.mergeAutoResolve ? "warn" : "accent"}>
                        {block.mergeStrategy}
                        {block.mergeAutoResolve ? " · AI resolve" : ""}
                      </Badge>
                    ) : block.kind === "loop" ? (
                      /* In the badge slot rather than beside the Link handle:
                         the card is a fixed NODE_W, and three controls in one
                         row put the third past the edge at every name length.
                         What the slot held for a loop was nothing. */
                      <button
                        type="button"
                        onPointerDown={(event) => startRepeat(event, block.id)}
                        onPointerMove={moveRepeat}
                        onPointerUp={(event) => endRepeat(event, block.id)}
                        onPointerCancel={cancelRepeat}
                        onClick={() => {
                          if (claimedByPointer()) return;
                          toggleRepeat(block.id);
                        }}
                        aria-pressed={repeatFrom === block.id}
                        aria-label={
                          repeatFrom === block.id
                            ? `Stop choosing what ${label(block)} repeats`
                            : `Choose the block ${label(block)} repeats from`
                        }
                        // The Link handle's recipe exactly, down to the
                        // stretched `::after` on the label — see the comment
                        // on that button for why the target cannot sit on this
                        // element and why the box stays at --control-h.
                        className={`uf-button ${
                          repeatFrom === block.id ? "uf-button-primary" : ""
                        } ui-transition inline-flex min-h-[var(--control-h)] cursor-pointer
                          max-md:relative touch-none items-center rounded-sm border px-2 py-1
                          text-2xs font-semibold ${
                            repeatFrom === block.id
                              ? "border-warn-line bg-warn/10 text-ink"
                              : "border-line bg-bezel text-ink-muted shadow-e1 hover:bg-bezel-hover hover:text-ink"
                          }`}
                      >
                        <span
                          className="max-md:after:absolute max-md:after:-inset-y-[6px]
                            max-md:after:-inset-x-[3px] max-md:after:content-['']"
                        >
                          {repeatFrom === block.id ? "Done" : "Repeat"}
                        </span>
                      </button>
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
          const incoming = links.filter((link) => link.to === block.id);
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
                    if (!claimArmed(block.id)) {
                      onSelect({ kind: "block", id: block.id });
                    }
                  }}
                  aria-label={
                    repeating && repeatFrom !== block.id
                      ? repeatsFirst.get(repeatFrom!) === block.id
                        ? `Stop ${label(repeatSource)} repeating from ${label(block)}`
                        : `Start what ${label(repeatSource)} repeats at ${label(block)}`
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
                      /* The region's sentence at a width the region is not
                         drawn at, and the card's own mark with it: the two
                         questions a section has to answer are the same at both
                         widths, and there is no region here to draw them on. */
                      <span className="text-warn">
                        {" "}
                        · repeated by {label(owner)}, {inSection.mark}
                      </span>
                    )}
                  </span>
                  {block.kind !== "merge" && block.mountId ? (
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
                {block.kind === "loop" && (
                  // No pointer sequence on this one: there is nothing at this
                  // width to drag onto, so it is the two-press route only —
                  // which is the route the keyboard takes above the breakpoint
                  // too, through the same `toggleRepeat`.
                  <button
                    type="button"
                    onClick={() => toggleRepeat(block.id)}
                    aria-pressed={repeatFrom === block.id}
                    className={`uf-button ${
                      repeatFrom === block.id ? "uf-button-primary" : ""
                    } ui-transition min-h-11 shrink-0 cursor-pointer rounded-md border px-3
                      text-xs ${
                        repeatFrom === block.id
                          ? "border-warn-line bg-warn/10 text-warn"
                          : "border-line text-ink-muted hover:bg-inset"
                      }`}
                  >
                    {repeatFrom === block.id ? "Done" : "Repeat"}
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
                          {link.edge === "repeats" ? "inside " : "after "}
                          {from ? label(from) : link.from} ·{" "}
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
        {/* Only where there is one: on a graph with no loop this names a
            control nothing on the canvas has. */}
        {blocks.some((b) => b.kind === "loop") && (
          <span>Repeat on a loop links it to the block its pass starts at</span>
        )}
        <span className="md:hidden">
          Remove is in the panel below — there is no undo
        </span>
      </div>
    </div>
  );
}

/** What a block is called on screen before it has been given a name. */
function label(block: { name: string; id: string } | undefined): string {
  if (!block) return "a block that is gone";
  return block.name.trim() || block.id;
}

function linkTone(link: LinkDraft, selection: CanvasSelection | null): LinkTone {
  // Ahead of the selection test, unlike the other two: see `LINK_TONE`'s note.
  if (link.edge === "repeats") return "repeats";
  if (
    selection?.kind === "link" &&
    selection.from === link.from &&
    selection.to === link.to
  ) {
    return "selected";
  }
  return link.edge === "" ? "unchosen" : "chosen";
}

/**
 * Where a block sits in the section it belongs to, in the words the region
 * marks it with.
 *
 * "Which of these runs first" and "whose DONE ends the loop" are the two
 * questions a drawn region cannot answer on its own — the members may be
 * anywhere on the surface, and the arrows between them are the same arrows
 * everything else on the canvas is drawn with. So the first and the last are
 * named rather than numbered, and everything between them is numbered rather
 * than named: a middle block's position is a fact about the order, and the two
 * ends are facts about what the loop does.
 */
function sectionMark(index: number, size: number): string {
  if (size === 1) return "the only one";
  if (index === 0) return `first of ${size}`;
  if (index === size - 1) return `last of ${size}`;
  return `${index + 1} of ${size}`;
}
