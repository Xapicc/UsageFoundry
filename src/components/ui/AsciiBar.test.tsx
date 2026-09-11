import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AsciiBar, fittedCells, meterCells } from "./AsciiBar";
import { Meter } from "../Meter";

/**
 * The fraction-to-cell conversion, which is the whole of the arithmetic this
 * skin adds and is the kind this repo tests: a wrong cell count draws a
 * perfectly plausible bar. Nothing throws, nothing fails a typecheck, and the
 * figure printed beside the bar goes on being right — so the only reader who
 * would catch it is one who counted the blocks.
 *
 * The three failures worth naming, all of them from rounding alone:
 *   `Math.round(0.004 * 20)` is 0, so a window that has been used draws empty.
 *   `Math.round(0.996 * 20)` is 20, so a window with headroom draws full at the
 *     exact moment an operator is deciding whether to start another run.
 *   An unknown ceiling rounds to *something*, and every something is a lie —
 *     `DEFAULTS` carries no ceiling on purpose (docs/agent/metering.md).
 */

const CELLS = 20;

/**
 * The bar as a reader of the *screen* sees it: the runs are separate spans, so
 * that only the measured one takes the severity colour, and the markup between
 * them is not part of the picture.
 */
function barText(markup: string): string {
  return markup.replace(/<[^>]*>/g, "");
}

test("a true zero fills nothing and a true one fills everything", () => {
  assert.deepEqual(meterCells(0, null, CELLS), { filled: 0, band: 0, empty: 20 });
  assert.deepEqual(meterCells(1, null, CELLS), { filled: 20, band: 0, empty: 0 });
});

test("a reading just above zero still shows a cell", () => {
  // 0.4% of 20 cells rounds to none. An operator reading an empty bar concludes
  // the window is untouched, which is the reading the pixel meter's own
  // MIN_VISIBLE_PX floor exists to prevent.
  assert.equal(meterCells(0.004, null, CELLS)?.filled, 1);
  assert.equal(meterCells(0.0001, null, CELLS)?.filled, 1);
});

test("a reading just below the ceiling still shows an empty cell", () => {
  assert.equal(meterCells(0.996, null, CELLS)?.filled, 19);
  assert.equal(meterCells(0.9999, null, CELLS)?.filled, 19);
});

test("no ceiling is not a cell count", () => {
  assert.equal(meterCells(null, null, CELLS), null);
  assert.equal(meterCells(Number.NaN, null, CELLS), null);
  assert.equal(meterCells(Number.POSITIVE_INFINITY, null, CELLS), null);
});

test("a reading outside 0–1 is clamped rather than overrunning the track", () => {
  // Spend past an install ceiling is a real state, and it arrives here as a
  // fraction above 1. More cells than the bar has would render as a bar wider
  // than every other bar on the page.
  assert.deepEqual(meterCells(1.4, null, CELLS), { filled: 20, band: 0, empty: 0 });
  assert.deepEqual(meterCells(-0.2, null, CELLS), { filled: 0, band: 0, empty: 20 });
});

test("the three runs always account for every cell", () => {
  for (const f of [0, 0.001, 0.25, 0.5, 0.749, 0.9, 0.999, 1]) {
    for (const upper of [null, 0.3, 0.5, 0.9, 1]) {
      for (const cells of [8, 16, 24, 32]) {
        const runs = meterCells(f, upper, cells);
        assert.ok(runs);
        assert.equal(
          runs.filled + runs.band + runs.empty,
          cells,
          `${f}/${upper} at ${cells} cells`,
        );
        assert.ok(runs.band >= 0 && runs.empty >= 0, `${f}/${upper} at ${cells}`);
      }
    }
  }
});

test("a band that exceeds the fill takes a cell even when the two round together", () => {
  // The band is the only thing on screen explaining a guard that refuses a run
  // above the visible bar (see Meter's own docstring). Rounded away, the head
  // shows a range the track contradicts.
  const runs = meterCells(0.4, 0.41, CELLS);
  assert.equal(runs?.filled, 8);
  assert.equal(runs?.band, 1);
});

test("a band at or below the fill is not drawn", () => {
  // The normal, fully-priced case.
  assert.equal(meterCells(0.4, 0.4, CELLS)?.band, 0);
  assert.equal(meterCells(0.4, 0.2, CELLS)?.band, 0);
  assert.equal(meterCells(0.4, null, CELLS)?.band, 0);
  assert.equal(meterCells(0.4, undefined, CELLS)?.band, 0);
  assert.equal(meterCells(0.4, Number.NaN, CELLS)?.band, 0);
});

test("a full bar gives the band no room rather than surrendering a filled cell", () => {
  // A guard reading above a window already at its ceiling. In pixels the band
  // is painted over by the fill and is invisible; the characters say the same
  // thing rather than drawing 95% for a window at 100%.
  assert.deepEqual(meterCells(1, 1.3, CELLS), { filled: 20, band: 0, empty: 0 });
});

test("the drawn string is the cell counts and nothing else", () => {
  const html = renderToStaticMarkup(
    <AsciiBar fraction={0.25} upperFraction={0.5} cells={CELLS} />,
  );
  assert.equal(barText(html), "[█████▒▒▒▒▒░░░░░░░░░░]");
});

test("no ceiling draws no level at all, rather than a level nobody can read", () => {
  // A full bar, an empty bar and a zero are all measurements, and so is any
  // shade between them — at 16 cells the hatch the pixel meter uses for this
  // differs from an empty track by two tones of grey. A struck-out track
  // cannot be mistaken for a quantity.
  const html = renderToStaticMarkup(<AsciiBar fraction={null} cells={CELLS} />);
  assert.equal(barText(html), `[${"╳".repeat(20)}]`);
  assert.doesNotMatch(html, /[█▒░]/, "no run of the bar may read as a reading");
});

test("an unknown bar is the same width as a bar with a reading", () => {
  // Not cosmetic and not free: the blocks come from a fallback face at one
  // glyph per em while ASCII keeps the monospace advance, so a `?` track is
  // half the length of a `█` one. A meter that changed width when its ceiling
  // was unset would do it beside meters that did not, on the same card.
  const unknown = barText(renderToStaticMarkup(<AsciiBar fraction={null} cells={CELLS} />));
  const known = barText(renderToStaticMarkup(<AsciiBar fraction={0.5} cells={CELLS} />));
  assert.equal(unknown.length, known.length);
  // Same length is necessary and not sufficient: it is the same length in
  // *characters*, and an ASCII mark would draw that at half the width. The mark
  // has to come from the same U+2500-U+259F range the fills do, which is what
  // makes the character count and the drawn width the same question.
  for (const glyph of unknown.slice(1, -1)) {
    const code = glyph.codePointAt(0) ?? 0;
    assert.ok(
      code >= 0x2500 && code <= 0x259f,
      `U+${code.toString(16)} is not from the block the fills are drawn from`,
    );
  }
});

test("only the measured run takes the caller's colour", () => {
  // The band is this app's own estimate and the track is headroom; neither is
  // the reading, and a bar tinted end to end by severity presents all three as
  // one measurement. Same split the pixel meter makes, where the hatch and the
  // track are drawn off the border ramp and only the fill is `bg-danger`.
  const html = renderToStaticMarkup(
    <AsciiBar
      fraction={0.4}
      upperFraction={0.8}
      cells={CELLS}
      fillClassName="text-danger"
    />,
  );
  const fill = /<span class="text-danger">([^<]*)<\/span>/.exec(html);
  assert.ok(fill, "the fill is its own span");
  assert.match(fill[1], /^█+$/, "and nothing but blocks is inside it");
});

test("the characters are hidden at the root, not one run at a time", () => {
  // Same rule and same placement as AsciiFrame: a reader that reached this gets
  // "full block" twenty times in place of the percentage beside it.
  const html = renderToStaticMarkup(<AsciiBar fraction={0.5} cells={CELLS} />);
  assert.match(html, /^<span aria-hidden="true"/);
});

/**
 * The pair, in the component that owns the reading: a meter draws its bar in
 * both skins at once and `globals.css` turns one off, so both have to be out of
 * the accessibility tree and the figure has to survive either way.
 */
test("a meter's blocks never reach the accessibility tree", () => {
  const html = renderToStaticMarkup(<Meter label="Session" fraction={0.62} />);
  const bar = /<span aria-hidden="true"[^>]*>\[.*?\]<\/span>/s.exec(html);
  assert.ok(bar, "the bar is in the DOM under both skins");
  assert.match(barText(bar[0]), /^\[[█▒░]+\]$/);
  assert.doesNotMatch(
    html.replace(bar[0], ""),
    /[█▒░]/,
    "and every block character it draws is inside that one hidden span",
  );
  // The number is still text, and still the value the widget reports.
  assert.match(html, /62\.0%/);
  assert.match(html, /aria-valuenow="62"/);
});

test("a meter with no ceiling draws the hatch in both skins and claims no number", () => {
  const html = renderToStaticMarkup(<Meter label="Session" fraction={null} />);
  assert.match(html, /hatched/, "the pixel skin's indeterminate fill");
  assert.match(barText(html), /\[\u2573+\]/, "and the ascii skin's");
  assert.doesNotMatch(html, /[█▒░]/);
  assert.doesNotMatch(html, /aria-valuenow/);
});

test("an unknown bar is not tinted by severity in either skin", () => {
  // `severityFor(null)` is "ok", so the short-circuit has to be made twice —
  // once for the fill class and once for the text colour the characters take.
  const html = renderToStaticMarkup(<Meter label="Session" fraction={null} />);
  assert.doesNotMatch(html, /bg-ok|bg-warn|bg-danger/);
  assert.doesNotMatch(html, /text-ok|text-warn|text-danger/);
});

test("each size draws its own width before it has measured itself", () => {
  // What the server sends and what the default skin holds. The bar fits itself
  // to its box after one layout pass, so these are the counts standing in the
  // frame where nothing has been measured — and the frame a bar may not
  // overflow in, because it is the one no measurement can save.
  const cells = (size: "compact" | "default" | "hero") => {
    const html = renderToStaticMarkup(
      <Meter label="w" fraction={1} size={size} />,
    );
    return /\[(█+)\]/.exec(barText(html))?.[1].length;
  };
  assert.equal(cells("compact"), 12);
  assert.equal(cells("default"), 16);
  assert.equal(cells("hero"), 20);
  // 326px is the narrowest card a meter lands in (Meter's SIZE map has the
  // arithmetic) and an em is 13px at `text-sm`, so the widest a cell can draw
  // is 13px. The brackets are counted as cells, which is a further 13px of
  // slack, because they measured half that.
  for (const size of ["compact", "default", "hero"] as const) {
    const drawn = cells(size) ?? 0;
    assert.ok((drawn + 2) * 13 <= 326, `${size} overflows before it is fitted`);
  }
});

/**
 * The other half of the arithmetic, and the half that decides a width rather
 * than a reading. It fails the same way `meterCells` does — silently. A count
 * one too high draws a bar that hangs out of its card, which `contain:
 * inline-size` keeps from widening the column, so nothing moves and nothing
 * throws; a count that collapses to zero draws `[]`.
 */
test("a fitted count is the count that fits, never the one that rounds", () => {
  // 300px of room, 13px a cell, 13px of brackets: 22 cells is 286 and 23 is 299
  // *plus* the brackets, which is over. `Math.round` would take it.
  assert.equal(fittedCells(300, 13, 13), 22);
  assert.equal(fittedCells(299, 13, 13), 22);
  assert.equal(fittedCells(298, 13, 13), 21);
  // The same box, read by a browser whose face covers the block range at the
  // monospace advance — the 2026-09-11 handoff's 0.602em. A count budgeted for
  // the first is 40% short here, which is the report this fitting answers.
  assert.equal(fittedCells(300, 7.83, 15.66), 36);
});

test("a box too narrow to say anything keeps a readable bar", () => {
  // Below eight cells one cell is more than an eighth of the reading. The bar
  // overhangs instead, which the track's containment makes visible.
  assert.equal(fittedCells(40, 13, 13), 8);
  assert.equal(fittedCells(1, 13, 13), 8);
});

test("a box that was never laid out is not a cell count", () => {
  // Every meter under the default skin measures zero, and so does one inside a
  // `display: none` ancestor. Rounding that into a count is a bar drawn to a
  // width nobody measured; `null` is what leaves the caller's own count up.
  assert.equal(fittedCells(0, 13, 13), null);
  assert.equal(fittedCells(300, 0, 13), null);
  assert.equal(fittedCells(Number.NaN, 13, 13), null);
  assert.equal(fittedCells(300, Number.NaN, 13), null);
  assert.equal(fittedCells(300, 13, Number.NaN), null);
});

test("a meter whose band the head cannot spell draws no band in either skin", () => {
  // The head drops an unspellable band, and so must the track — in pixels and
  // in characters. A hatch nothing explains is the same defect one step
  // quieter, and it would be quieter still in a skin where the hatch is a
  // character the reader has to count.
  const html = renderToStaticMarkup(
    <Meter label="Spend" fraction={0.4} upperFraction={0.8} value="$3.20" />,
  );
  assert.doesNotMatch(html, /hatched/);
  assert.doesNotMatch(html, /▒/);
});
