"use client";

/**
 * The ascii skin's panel edge, as characters rather than as a CSS border:
 *
 *     ┌──────────────────────────┐
 *     │  …                       │
 *     └──────────────────────────┘
 *
 * It is `absolute inset-0` over its parent's padding box and draws nothing that
 * takes part in layout, which is the point: a surface wearing one is the same
 * size, in the same place, with its contents on the same lines, whichever skin
 * is on. An edge that sat in flow would add two rows to every card in the app
 * the moment the skin was switched, and the switch is one click on the toolbar.
 *
 * No label is welded into the top edge, which is the one part of the reference
 * vocabulary this does not carry. Nothing in this kit is handed its own title:
 * `Card` takes `CardTitle` as a *child*, so the frame cannot see it — and the
 * reference welds an uppercase label, which is what `docs/agent/conventions.md`
 * refuses for a section heading here ("nothing shouts"). The heading stays a
 * real `<h2>` inside the box, where it is also the accessible name the frame
 * must never become.
 *
 * `aria-hidden`, and that is not politeness: a screen reader reading four
 * hundred `─` characters aloud is the failure this whole treatment is one
 * mistake away from. Nothing in here may ever carry text a reader needs.
 *
 * Whether any of it is drawn is `globals.css`'s decision, keyed on
 * `:root[data-skin="ascii"]` — see the block there. This component branches on
 * nothing.
 */

/**
 * Deliberately longer than any box this can land in, and clipped by
 * `overflow: hidden`, so an edge ends on a whole glyph at every width instead
 * of being cut through one — which is the whole reason the fills are strings
 * and not a repeated background.
 *
 * 400 is both counts: ~2800px of columns and ~5200px of rows at the 13px
 * monospace the frame is set in. A box past either loses the tail of that edge
 * rather than drawing a wrong one, which is the failure to prefer — but it is
 * silent, so anything in this app that can grow past 5200px of card wants
 * checking by eye rather than assuming.
 */
const FILL = 400;
const H_FILL = "─".repeat(FILL);
const V_FILL = "│".repeat(FILL);

/**
 * Which of the two tones the skin retuned `--border` and `--border-strong` to.
 *
 * They are the *text* ramp — under this skin a frame is set as characters, so
 * the border tokens are text colours in practice — and the split is the one
 * measured beside them in `globals.css`: `faint` clears 3:1 on every surface in
 * both schemes, `strong` clears 4.5:1. A frame is a graphical object, so faint
 * is the floor and strong is the step above it.
 */
export type AsciiFrameTone = "faint" | "strong";

const TONE: Record<AsciiFrameTone, string> = {
  faint: "text-ink-faint",
  strong: "text-ink-muted",
};

export function AsciiFrame({ tone = "faint" }: { tone?: AsciiFrameTone }) {
  return (
    <span
      aria-hidden="true"
      // `display` is deliberately absent: `.uf-ascii` states it in both
      // directions from globals.css, and a Tailwind display utility here would
      // be a second answer to the same question in a different file.
      // `-0.5em` and not `inset-0`, which is what this shipped at. A
      // box-drawing glyph's stroke runs down the *middle* of its em box, so a
      // frame laid flush inside the surface draws its line half a character in
      // from the edge it is replacing: measured on `/agents` in dark, the card
      // surface began at x=16 and the stroke stood at x=23, leaving a 7px band
      // of card outside its own border on all four sides — a light halo around
      // every box in the app, in both schemes. Pulled out by half, the stroke
      // lands where the 1px border was. The half that then hangs outside is the
      // glyph's empty side, so nothing is drawn there and nothing is clipped:
      // `AsciiEdge` below is the same correction for a single edge.
      className={`uf-ascii uf-ascii-frame pointer-events-none absolute -inset-[0.5em] select-none flex-col overflow-hidden text-sm leading-none ${TONE[tone]}`}
    >
      <span className="flex">
        <span>┌</span>
        <span className="min-w-0 flex-1 overflow-hidden">{H_FILL}</span>
        <span>┐</span>
      </span>
      {/* The side columns are taken out of flow inside this one, so the
          frame's height is the parent's and never 400 rows of `│`. `break-all`
          is what puts one glyph on each line: the box is exactly one character
          wide, so every break lands between two of them.

          `1em` and not `1ch`, which is the width this shipped at and was wrong
          in a way only a rendered page shows. `ch` is the advance of `0` — an
          ASCII glyph, so half an em on the fallback face that answers for
          U+2500–257F here (docs/agent/conventions.md's character-art bullet).
          A `│` is a full em with its stroke down the middle, so a box half that
          wide clipped the left column's stroke off entirely and left the right
          column's standing 7px inside the corners it was supposed to join. */}
      <span className="relative min-h-0 flex-1">
        <span className="absolute inset-y-0 left-0 w-[1em] overflow-hidden break-all">
          {V_FILL}
        </span>
        <span className="absolute inset-y-0 right-0 w-[1em] overflow-hidden break-all">
          {V_FILL}
        </span>
      </span>
      <span className="flex">
        <span>└</span>
        <span className="min-w-0 flex-1 overflow-hidden">{H_FILL}</span>
        <span>┘</span>
      </span>
    </span>
  );
}

/**
 * One edge of a surface rather than a box around it, for the two separators the
 * shell draws: the source list's right-hand edge and the toolbar's underline.
 *
 * It is here and not in a file of its own because it is the same decision as
 * `AsciiFrame` twice over — the same two fills, the same tone ramp, the same
 * `aria-hidden`, the same out-of-flow-so-nothing-reflows rule — and a second
 * copy of them somewhere else is how two frames come to disagree.
 *
 * The half-em offset is the whole of what is different. A box-drawing glyph's
 * stroke runs down the *middle* of its em box, so a 1em box sitting flush
 * against the host's edge would draw its line half a character inside the
 * boundary it is replacing, and the toolbar's underline would float above the
 * pane instead of dividing it. Pulled out by half, the stroke lands exactly
 * where the 1px border was. The half that hangs over the neighbour is the
 * glyph's empty side, so nothing is drawn there.
 */
export function AsciiEdge({
  side,
  tone = "faint",
}: {
  side: "right" | "bottom";
  tone?: AsciiFrameTone;
}) {
  const common = `uf-ascii pointer-events-none absolute select-none overflow-hidden text-sm leading-none ${TONE[tone]}`;

  // `display` is left to globals.css for `AsciiFrame`'s reason — and an
  // absolutely positioned box computes its `inline` to `block` anyway, so the
  // one declaration there covers both of these without a modifier class.
  if (side === "bottom") {
    return (
      <span aria-hidden="true" className={`${common} inset-x-0 -bottom-[0.5em] whitespace-nowrap`}>
        {H_FILL}
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`${common} inset-y-0 -right-[0.5em] w-[1em] break-all`}
    >
      {V_FILL}
    </span>
  );
}
