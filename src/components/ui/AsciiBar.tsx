"use client";

import { useLayoutEffect, useRef, useState } from "react";

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
 * It is U+2573 and not `?` because an ASCII mark would draw at half the width of
 * the blocks around it — see the character-art bullet in
 * `docs/agent/conventions.md` for the measurement — so an unknown bar would be
 * half the length of a bar with a reading, on the same card.
 *
 * `aria-hidden`, and every caller keeps its real figure as text elsewhere in the
 * markup. A screen reader must get "62.0%", never twenty block characters: the
 * bar is a picture of a number, and the number is somewhere it can be read.
 *
 * It takes the width of the box it is in, by measuring itself once — see
 * `fittedCells` for why that cannot be a constant and `useFittedCells` for what
 * makes the measurement safe to act on.
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

/**
 * A bar below this many cells has stopped being a picture of a percentage: one
 * cell is more than an eighth of the reading, and the three runs the band needs
 * cannot all be told apart. It is a floor against a container narrower than any
 * this app has — the narrowest a meter lands in today is the run inspector's
 * 21rem column — and not a width any call site is expected to hit. Below it the
 * bar keeps its cells and hangs over the edge, which `contain: inline-size` on
 * the track makes visible rather than silent.
 */
const MIN_CELLS = 8;

/**
 * How many cells fit in `availablePx`, given what one cell and the two brackets
 * around them actually measured.
 *
 * Measured, rather than budgeted against a constant, because **the width of a
 * cell is not a property of this app**. It ships no font on purpose, so the face
 * that answers for the block range is the reader's: measured in this container's
 * Chromium, `█` is one full em on the app's own `--family-mono`, and the
 * VisualEdit handoff of 2026-09-11 caught a `default` meter 141px wide — 18
 * glyphs at 7.83px, which is 0.602em, the face there having covered the range at
 * the monospace advance instead. A fixed count budgeted against either of those
 * is 40% wrong on the other, and wrong in the direction nobody sees: the bar is
 * simply short, in a card several times its width, which is what was reported.
 *
 * `Math.floor` and not a round: this is the count that *fits*, and a cell over
 * is a bar hanging out of its card. The brackets are subtracted rather than
 * counted as two cells because they are ASCII and draw at half a block here —
 * assuming them is the same mistake one glyph smaller.
 */
export function fittedCells(
  availablePx: number,
  cellPx: number,
  bracketsPx: number,
): number | null {
  // `!(x > 0)` and not `x <= 0`, so a NaN out of an unlaid-out box is refused
  // rather than propagated into a cell count.
  if (!(availablePx > 0) || !(cellPx > 0) || !Number.isFinite(bracketsPx)) {
    return null;
  }
  return Math.max(MIN_CELLS, Math.floor((availablePx - Math.max(bracketsPx, 0)) / cellPx));
}

/**
 * How long a resize is given to stop before the bar is re-fitted.
 *
 * The bar is re-fitted when a drag *ends*, not while it is happening: a meter
 * stepping through every resolution between two widths reads as flicker, and a
 * bar that is briefly the wrong length is the better of those two. Long enough
 * to sit out a window drag, short enough that a sidebar collapse — which is one
 * transition and the common way a card's width changes here — lands before the
 * eye returns to the meter.
 */
const RESIZE_SETTLE_MS = 120;

/**
 * The cell count this bar should draw: `cells` until it has measured itself, and
 * what fits the box it is in after that.
 *
 * Three things make a measured count safe to act on here, and all three are
 * load-bearing:
 *
 *   - **It cannot feed back.** `.uf-meter` carries `contain: inline-size`
 *     (globals.css), so the track's width is computed as if it were empty — the
 *     bar cannot be consulted for the width it is then fitted to. Belt and
 *     braces on top of that: a width already fitted for is never fitted again,
 *     so nothing here can oscillate even in a box without the containment.
 *   - **It settles once.** The count is a pure function of a width that does not
 *     move, so the first measurement is the answer; `fittedFor` is what stops a
 *     re-render from asking again.
 *   - **What it measures is what is drawn.** `cellPx` comes from dividing the
 *     drawn run by the number of cells in it rather than from a probe element in
 *     a font nobody asserted was the same one.
 *
 * The measurement is refused, leaving the caller's own count standing, whenever
 * there is nothing laid out to measure — which is every meter under the default
 * skin, where `.uf-ascii` is `display: none` and no bar is drawn to be wrong.
 * That is also why the observer watches the track rather than a window event:
 * turning the skin on changes the track's height and nothing else, and that is
 * the moment a bar that has never been measurable becomes measurable.
 */
function useFittedCells(
  barRef: React.RefObject<HTMLSpanElement | null>,
  runsRef: React.RefObject<HTMLSpanElement | null>,
  cells: number,
): number {
  const [fitted, setFitted] = useState<number | null>(null);
  const fittedFor = useRef<number | null>(null);
  const drawn = fitted ?? cells;

  useLayoutEffect(() => {
    const bar = barRef.current;
    const runs = runsRef.current;
    const track = bar?.parentElement;
    if (!bar || !runs || !track) return;

    const fit = () => {
      const available = track.clientWidth;
      if (fittedFor.current === available) return;
      const runsPx = runs.getBoundingClientRect().width;
      if (runsPx <= 0) return;
      const next = fittedCells(
        available,
        runsPx / drawn,
        bar.getBoundingClientRect().width - runsPx,
      );
      if (next === null) return;
      // Only once a measurement has actually produced a count, so a bar that was
      // hidden when it was asked is asked again the next time the box moves.
      fittedFor.current = available;
      setFitted(next);
    };

    // Once before observing, because the first measurement is the one the first
    // frame needs — the same shape `observeCanvasSize` uses.
    fit();
    let pending: number | undefined;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(pending);
      pending = window.setTimeout(fit, RESIZE_SETTLE_MS);
    });
    observer.observe(track);
    return () => {
      window.clearTimeout(pending);
      observer.disconnect();
    };
  }, [barRef, runsRef, drawn]);

  return drawn;
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
  /**
   * What to draw until the bar has measured itself: the server's render, the
   * default skin, and any box that cannot be measured. Chosen by the caller
   * against the *narrowest* width it has to sit in, because it is the count
   * standing at the moment nothing has been measured and a bar that overflowed
   * then would do it in the one frame nobody can fit.
   */
  cells: number;
  /** The measured run's own colour. Never reaches the band or the track. */
  fillClassName?: string;
  className?: string;
}) {
  const barRef = useRef<HTMLSpanElement>(null);
  const runsRef = useRef<HTMLSpanElement>(null);
  const drawn = useFittedCells(barRef, runsRef, cells);
  const runs = meterCells(fraction, upperFraction, drawn);

  return (
    <span
      ref={barRef}
      aria-hidden="true"
      // `display` is left to globals.css, which states it in both directions —
      // a Tailwind display utility here would be a second answer to the same
      // question in a different file. `whitespace-pre` because a run of blocks
      // is one word to the line breaker only by accident, and `leading-none` is
      // what keeps a bar the height of one row.
      className={`uf-ascii ${TRACK_TONE} select-none whitespace-pre leading-none ${className}`}
    >
      [
      {/* The cells, and only the cells, in one box: dividing this by the count
          inside it is what gives the drawn advance of a cell, and subtracting it
          from the bar gives the two brackets. Both have to come off the glyphs
          actually on the page — that is the whole point of measuring rather than
          budgeting — and the brackets are not the same width as a cell. */}
      <span ref={runsRef}>
        {runs === null ? (
          <span className={BAND_TONE}>{NO_CEILING.repeat(drawn)}</span>
        ) : (
          <>
            <span className={fillClassName}>{FILLED.repeat(runs.filled)}</span>
            <span className={BAND_TONE}>{BAND.repeat(runs.band)}</span>
            {EMPTY.repeat(runs.empty)}
          </>
        )}
      </span>
      ]
    </span>
  );
}
