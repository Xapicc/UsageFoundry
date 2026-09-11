"use client";

/**
 * The ascii skin's level indicator, as characters rather than as a filled box:
 *
 *     [██████████▒▒▒░░░░░░░]
 *
 * `█` is what was measured, `▒` is the span this app estimated on top of it,
 * `░` is headroom, and `╳` is a reading with no ceiling to measure against.
 * The first three are `Meter`'s own split drawn in pixels — solid fill, hatched
 * band, empty track — so no call site has to learn a second vocabulary.
 *
 * The fourth is the one place this skin says *more* than the pixel meter rather
 * than the same thing in characters. There, no ceiling is the hatch at full
 * width: the same texture as the band, distinguished from it only by covering
 * the whole track, which is as close to a reading as a non-reading can look. A
 * shade character here would inherit exactly that, and at 16 cells the
 * difference between "hatched whole" and "empty" is two tones of grey. A row of
 * `╳` is struck-out rather than filled and cannot be read as a level at all,
 * which is the property that matters — a meter with no ceiling must not become
 * a full bar, an empty bar or a zero, and `DEFAULTS` ships without one on
 * purpose (docs/agent/metering.md).
 *
 * It is a box-drawing character and not `?` for a reason that is invisible from
 * the source and was measured in the browser: on a stack that falls back for
 * U+2500–259F — which is every stack this app ships, since `globals.css`
 * deliberately downloads no font — the blocks arrive from a second face at one
 * advance width per glyph while ASCII keeps the monospace face's own. Here that
 * is 14px against 7px at `font-size: 14px`. A `?` track is therefore *half the
 * length* of a `█` one, so a meter would change width when its ceiling was
 * unset, on the same card as meters that did not. `╳` is U+2573, out of the
 * same block as the frame's own glyphs, and measures the same 14px.
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
const NO_CEILING = "╳";

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

/**
 * Three tones, because the pixel meter has three and they carry the split
 * `docs/agent/metering.md` calls shown-versus-guard: only the solid fill is the
 * measurement, so only the solid fill takes the severity colour. The band is
 * `--border-strong`'s tone, which is what the pixel hatch is drawn in, and the
 * track is the quiet one — a bar whose headroom was tinted amber would read as
 * a second, larger reading in the same colour as the first.
 */
const BAND_TONE = "text-ink-muted";
const TRACK_TONE = "text-ink-faint";

export function AsciiBar({
  fraction,
  upperFraction,
  cells,
  fillClassName = "",
  className = "",
}: {
  fraction: number | null;
  upperFraction?: number | null;
  /** Fixed, and chosen by the caller against the width it has to sit in. */
  cells: number;
  /** The measured run's own colour. Never reaches the band or the track. */
  fillClassName?: string;
  className?: string;
}) {
  const runs = meterCells(fraction, upperFraction, cells);

  return (
    <span
      aria-hidden="true"
      // `display` is left to globals.css, which states it in both directions —
      // a Tailwind display utility here would be a second answer to the same
      // question in a different file. `whitespace-pre` because a run of blocks
      // is one word to the line breaker only by accident, and `leading-none` is
      // what keeps a bar the height of one row.
      className={`uf-ascii ${TRACK_TONE} select-none whitespace-pre leading-none ${className}`}
    >
      [
      {runs === null ? (
        <span className={BAND_TONE}>{NO_CEILING.repeat(cells)}</span>
      ) : (
        <>
          <span className={fillClassName}>{FILLED.repeat(runs.filled)}</span>
          <span className={BAND_TONE}>{BAND.repeat(runs.band)}</span>
          {EMPTY.repeat(runs.empty)}
        </>
      )}
      ]
    </span>
  );
}
