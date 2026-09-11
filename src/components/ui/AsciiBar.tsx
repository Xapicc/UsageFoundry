"use client";

/**
 * The ascii skin's level indicator, as characters rather than as a filled box:
 *
 *     [██████████▒▒▒░░░░░░░]
 *
 * `█` is what was measured, `▒` is the span this app estimated on top of it,
 * `░` is headroom, and a whole bar of `▒` is a reading with no ceiling to
 * measure against. That is the same three-way split `Meter` already draws in
 * pixels — solid fill, hatched band, empty track, hatched whole — so no call
 * site has to learn a second vocabulary, and a reader who has seen one skin can
 * read the other.
 *
 * `aria-hidden`, and every caller keeps its real figure as text elsewhere in the
 * markup. A screen reader must get "62.0%", never twenty block characters: the
 * bar is a picture of a number, and the number is somewhere it can be read.
 *
 * Whether any of it is drawn is `globals.css`'s decision, keyed on
 * `:root[data-skin="ascii"]`. This component branches on nothing.
 */

const FILLED = "█";
const BAND = "▒";
const EMPTY = "░";

/**
 * The three runs of characters, or `null` for a reading with no ceiling.
 *
 * Exported and tested on its own because it is the one piece of arithmetic in
 * this treatment, and every way of getting it wrong is silent: the bar still
 * draws, the page still typechecks, and the figure beside it still reads
 * correctly while the picture of it does not.
 *
 * Three properties it has to hold, none of which a naive `Math.round` does:
 *
 *   - No ceiling is `null` and not a cell count. `DEFAULTS` carries no ceiling
 *     on purpose (`docs/agent/metering.md`), and both ways of rounding absence
 *     into a number are lies in opposite directions — an empty bar reads "0%
 *     used, plenty left" and a full one reads "100%, and fine".
 *   - A reading above zero fills at least one cell, and a reading below the
 *     ceiling leaves at least one empty. Rounding alone paints 0.4% as empty
 *     and 99.6% as full at 20 cells, which is precisely the reading an operator
 *     would act on. A true 0 and a true 1 keep their own ends.
 *   - A band that genuinely exceeds the fill occupies a cell even when the two
 *     round together. The band is the only thing on screen explaining a guard
 *     that refuses a run above the visible bar, so it may not round away.
 */
export function meterCells(
  fraction: number | null,
  upperFraction: number | null | undefined,
  cells: number,
): { filled: number; band: number; empty: number } | null {
  if (fraction === null || !Number.isFinite(fraction)) return null;

  const filled = fillCells(fraction, cells);

  // `> fraction` against the raw readings, the same test `Meter` makes before
  // it draws a band at all: equal values are the normal, fully-priced case.
  const hasBand =
    upperFraction !== null &&
    upperFraction !== undefined &&
    Number.isFinite(upperFraction) &&
    upperFraction > fraction;

  // The fill never gives way to the band, so a reading at the ceiling stays a
  // full bar and the band is what is lost — which is also what happens in
  // pixels, where a band the same width as the fill is painted over by it.
  const bandEnd = hasBand
    ? Math.max(fillCells(upperFraction, cells), Math.min(cells, filled + 1))
    : filled;

  return { filled, band: bandEnd - filled, empty: cells - bandEnd };
}

/** How many of `cells` a single 0–1 reading covers, both ends kept. */
function fillCells(fraction: number, cells: number): number {
  const clamped = Math.min(Math.max(fraction, 0), 1);
  if (clamped <= 0) return 0;
  if (clamped >= 1) return cells;
  return Math.min(cells - 1, Math.max(1, Math.round(clamped * cells)));
}

export function AsciiBar({
  fraction,
  upperFraction,
  cells,
  className = "",
}: {
  fraction: number | null;
  upperFraction?: number | null;
  /** Fixed, and chosen by the caller against the width it has to sit in. */
  cells: number;
  className?: string;
}) {
  const runs = meterCells(fraction, upperFraction, cells);
  const body = runs
    ? FILLED.repeat(runs.filled) + BAND.repeat(runs.band) + EMPTY.repeat(runs.empty)
    : BAND.repeat(cells);

  return (
    <span
      aria-hidden="true"
      // `display` is left to globals.css, which states it in both directions —
      // a Tailwind display utility here would be a second answer to the same
      // question in a different file. `tabular-nums` is pointless on blocks and
      // `leading-none` is what keeps a bar the height of one row.
      className={`uf-ascii select-none whitespace-pre leading-none ${className}`}
    >
      [{body}]
    </span>
  );
}
