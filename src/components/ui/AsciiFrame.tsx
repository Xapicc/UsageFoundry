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
      className={`uf-ascii uf-ascii-frame pointer-events-none absolute inset-0 select-none flex-col overflow-hidden text-sm leading-none ${TONE[tone]}`}
    >
      <span className="flex">
        <span>┌</span>
        <span className="min-w-0 flex-1 overflow-hidden">{H_FILL}</span>
        <span>┐</span>
      </span>
      {/* The side columns are taken out of flow inside this one, so the
          frame's height is the parent's and never 400 rows of `│`. `break-all`
          is what puts one glyph on each line: the box is exactly one character
          wide, so every break lands between two of them. */}
      <span className="relative min-h-0 flex-1">
        <span className="absolute inset-y-0 left-0 w-[1ch] overflow-hidden break-all">
          {V_FILL}
        </span>
        <span className="absolute inset-y-0 right-0 w-[1ch] overflow-hidden break-all">
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
