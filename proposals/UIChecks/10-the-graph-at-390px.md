# The workflow graph at 390px, measured, and what replaced it

Not a proposal. This is a decision already taken and shipped, written down
here because it is the one place in this app where a mobile pass concluded
that a surface could not be made to work under a thumb and gave the narrow
viewport something else instead. The rule it departs from is
`docs/agent/conventions.md`'s — *every mobile rule is additive, a `max-md:`
override rather than a rewritten desktop rule*. A `max-md:hidden` on the
sheet and a second list beside it is additive in the letter and a different
surface in the spirit, so the grounds are owed.

Everything below was measured on 2026-09-10 against the built app at 390×844
with `isMobile` and `hasTouch`, on the graph the editor ships against: six
blocks, six links, one of each block kind.

## What the sheet actually gave a phone

| | Measured |
|---|---|
| Scroll region, at 390px | **356 × 352** |
| Sheet inside it | **1592 × 420** |
| Fraction of the sheet's width visible | **22%** |
| Blocks visible at once, of six | **1**, plus the gap to the next |
| `NODE_W` / `COL_STRIDE`, `src/lib/canvasGraph.ts:119` | 232 / 328 |

The arithmetic was already written down above the canvas before this pass and
was already right: 358px of pane against a `COL_STRIDE` of 328 holds one
column. What had not been drawn out is what that leaves. A graph read one
node at a time through a two-axis pan is not a graph — the whole of what a
node diagram is for is the shape of the thing, and the shape is the part that
does not fit. What was left was a picker: a way to reach a block so the panel
below it could be edited, costing a pan in two directions per block, with no
way to see how far there was left to go.

## What was there before, and why it was not enough

The file was already the best-treated on the surface — fifteen responsive
classes against `WorkflowEditor.tsx`'s two — and none of them were wrong:

- A `md:hidden` note saying the arrangement is a larger screen's, and where
  the block you tapped is edited. It is honest and it stays, reworded.
- Keyboard hints split behind `max-md:hidden`, so a phone is not told to
  press Enter.
- `max-md:max-h-[22rem]` tightening the region's `62vh` cap, so a nested
  scroller did not fill the phone and read as the end of the page — which is
  exactly where the inspector holding the block's guards is.

That last one answers a real problem and answers it well. It could not answer
the other one, and the two pull opposite ways: `overflow-auto` on a sheet at
least 640px wide is the whole of what keeps the *pane* from scrolling
sideways, so it cannot be given up, and keeping it is what makes reaching the
sixth block a pan. There is no cap that fixes a viewport four times too
narrow.

## What was rejected

**Scaling the sheet to fit.** Six blocks across 1592px into 356px is a
transform of 0.22. `NODE_W` 232 becomes 52px and the 13px name inside it
becomes 3px. The graph would be present and unreadable, and the node hit
target would be 52 × 26 against a 44px floor. This is the option that looks
like it works in a screenshot and fails in a hand.

**Pinch and drag.** A real pan/zoom gesture is buildable and would still be
answering the wrong question: at any zoom that makes a name legible the
window holds one node, and at any zoom that holds six nothing is legible.
It also has to fight the page's own scroll, and the page under it is the
inspector — the thing a reader is going *to*.

**A vertical-only relayout.** One column of six nodes, panned in one axis, is
a list drawn with more chrome and worse density than a list. If the answer is
a list, ship a list.

## What shipped

Below `md` the sheet is `max-md:hidden` and a `<ul>` of the blocks takes its
place, in the sheet's own reading order — column then row, off `positions`
rather than re-derived, so the list and the canvas never disagree about which
block is first. A block the layout has not placed yet sorts last rather than
being dropped: below the breakpoint the list is the only way to reach it.

Every gesture the sheet still offered a finger has a route in the list:

| Gesture | On the sheet | In the list |
|---|---|---|
| Select a block | tap the card | tap the row |
| Arm a link | **Link** on the card | **Link** on the row |
| Complete a link | tap the target card | tap the target row |
| Select a link | tap the chip on the edge | tap the incoming chip on the row |
| Add a block | tap in **Add** | tap in **Add** — it joins the end |
| Remove | the panel below | unchanged |

Only the arrangement is gone, and the arrangement is what the note above the
canvas already declined to offer a finger. Nothing in the list writes: it
calls the same `onSelect` the canvas does, so what a node may hold, how a
workflow instantiates and how an instance's status is derived are untouched.

## What this does not settle

The list is a fallback, not a graph. A reader at 390px can see which block
runs after which, one edge at a time, and cannot see that two branches
rejoin — the shape is still the part that does not fit, and this does not
pretend otherwise. If that turns out to matter, the next thing to try is a
one-line summary of the shape above the list ("6 blocks, 2 branches, joins at
*Fan out*") rather than a smaller drawing of it.

Nothing here is checked by a test. `npm run smoke-pages` asserts a 200, no
console error and no sideways scroll at 390px and 1280px, which catches the
sheet coming back and catches the list overflowing; it says nothing about
whether a tap selects, which is the whole of what the list is for. That gap
is `01-what-a-check-would-have-to-catch.md`'s subject and this file does not
narrow it.
