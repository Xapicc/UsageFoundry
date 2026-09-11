"use client";

import type { CSSProperties } from "react";

/**
 * The wordmark and the product mark, drawn as block characters for the ascii
 * skin. Taken from the marketing site (`UsageFoundryWeb`'s `lib/ascii.ts` and
 * `components/Ascii.tsx`), which already had both the art and the way of sizing
 * it: a column count in as a CSS variable, and the art scaled to fill whatever
 * container it was given.
 *
 * One thing had to change on the way across, and it is the reason this is not
 * just the site's file copied. **There, a gap in the art is a space.** The site
 * ships a font cut for this, drawn to one advance width across ASCII and the
 * block range alike, so a space and a `█` are the same width and a row of them
 * is a grid. This app downloads no font on purpose and every stack it ships
 * falls back for U+2580–259F: measured in this container's Chromium on the
 * app's own `--family-mono`, a space is 0.5em and a `█` is 1.0em — so the site's
 * rows, pasted here, would draw every gap at half a cell and every letter in a
 * different place.
 *
 * Two glyphs away from being the same trap: `░` measures 1.0em here and `▀`
 * measures 0.709em, which says the block range is answered by more than one
 * face and that no blank character can be *assumed* to match `█`. So a gap is
 * a `█` nobody can see — `text-transparent` on the run — and every cell in the
 * art is then literally the same glyph in the same face, whichever face that
 * turns out to be. The grid holds without anything being measured again.
 *
 * `aria-hidden` without exception, and this is the one rule here that is not
 * about looks: the wordmark is the app's name, so it is exactly the art a later
 * edit would be tempted to let carry it. It may not. The accessible name is the
 * real text beside it — in the shell that is the sidebar's own "UsageFoundry"
 * label, which stays in the markup under both skins and is what the collapsed
 * rail keeps as `sr-only`.
 *
 * Whether any of it is drawn is `globals.css`'s decision, keyed on
 * `:root[data-skin="ascii"]`. This component branches on nothing.
 */

/** A run of cells along one row. `ink` is drawn; the rest is spacing. */
interface Run {
  ink: boolean;
  cells: string;
}

export interface AsciiArt {
  /** Width of every row, in cells. The renderer divides its container by this. */
  cols: number;
  rows: Run[][];
}

const INK = "█";

/**
 * Splits each row into runs, and **throws** on a row that is neither the art's
 * full width nor deliberately blank.
 *
 * Padding a short row instead is the obvious thing and it is wrong here. The
 * art is a hand-typed wall of identical-looking characters, so a row one cell
 * short is invisible in the source; padded, it is invisible in the render too,
 * because nothing shears and nothing throws — that row's right edge just
 * quietly moves. Since every input is a module-level constant, refusing means
 * the typo cannot reach a page: it takes the build down at import.
 *
 * An empty row is the exception and is spelled `""` — the band between USAGE
 * and FOUNDRY. It is the one blank that is a decision rather than a slip, and
 * being empty rather than short is what makes it tell itself apart.
 */
function toArt(rows: readonly string[]): AsciiArt {
  const cols = rows.reduce((widest, row) => Math.max(widest, row.length), 0);
  return {
    cols,
    rows: rows.map((row, y) => {
      if (row.length !== cols && row.length !== 0) {
        throw new Error(
          `ascii art row ${y} is ${row.length} cells wide, expected ${cols} (or 0 for a blank row)`,
        );
      }
      const runs: Run[] = [];
      for (const character of row.padEnd(cols, " ")) {
        const ink = character === INK;
        const last = runs[runs.length - 1];
        if (last && last.ink === ink) last.cells += INK;
        else runs.push({ ink, cells: INK });
      }
      return runs;
    }),
  };
}

/** 5 rows tall, 6 cells per letter, 1 cell apart. */
const USAGE_ROWS = [
  "█    █ ██████ ██████ ██████ ██████",
  "█    █ █      █    █ █      █     ",
  "█    █ ██████ ██████ █  ███ █████ ",
  "█    █      █ █    █ █    █ █     ",
  "██████ ██████ █    █ ██████ ██████",
];

const FOUNDRY_ROWS = [
  "██████ ██████ █    █ █    █ █████  ██████ █    █",
  "█      █    █ █    █ ██   █ █    █ █    █  █  █ ",
  "█████  █    █ █    █ █ ██ █ █    █ ██████   ██  ",
  "█      █    █ █    █ █   ██ █    █ █  ██    ██  ",
  "█      ██████ ██████ █    █ █████  █    █   ██  ",
];

/**
 * The product's mark — the three rising bars of `public/icon.svg` — transcribed
 * to characters, 11 cells wide so it fills the notch to the right of the
 * shorter word. `USAGE` (34) + gutter (3) + this (11) is exactly the 48 cells
 * `FOUNDRY` needs, which is what makes the block read as one object rather than
 * as two stacked words.
 */
const MARK_ROWS = [
  "        ███",
  "        ███",
  "    ███ ███",
  "    ███ ███",
  "███ ███ ███",
];

export const WORDMARK = toArt([
  ...USAGE_ROWS.map((row, i) => `${row}   ${MARK_ROWS[i]}`),
  "",
  ...FOUNDRY_ROWS,
]);

/**
 * The same three bars again at the size the sidebar's brand strip has for them,
 * where the SVG mark is 22px square.
 *
 * One cell per bar rather than the three the block above uses, because the art
 * is square-celled and the strip's is a *height* budget: 5 cells wide at 22px
 * tall is 36px across, where the 11-cell version would be 81px and would take
 * the room the name needs beside it.
 */
export const MARK = toArt(["    █", "  █ █", "█ █ █"]);

/**
 * Character art at whatever size its container gives it.
 *
 * `--ascii-cols` goes in here and `globals.css` divides the container's width
 * by it — by `cols`, with no advance factor, because a cell here is one full em
 * (see the note at the top of this file, and the character-art bullet in
 * `docs/agent/conventions.md`). The site's own rule divides by `cols × 0.6`,
 * which is *its* font's advance and would come out two thirds too small here.
 *
 * `cap` is an upper bound in px, for the case where the container is wide
 * enough that fitting it would make the art the loudest thing on the page.
 */
export function AsciiArt({
  art,
  cap = 18,
  className = "",
}: {
  art: AsciiArt;
  cap?: number;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={`uf-ascii uf-ascii-art select-none ${className}`}
      style={
        { "--ascii-cols": art.cols, "--ascii-cap": `${cap}px` } as CSSProperties
      }
    >
      <pre>
        {art.rows.map((runs, y) => (
          // Index keys: the art is a constant and no row ever moves.
          <span key={y} className="block">
            {runs.map((run, i) => (
              <span key={i} className={run.ink ? undefined : "text-transparent"}>
                {run.cells}
              </span>
            ))}
          </span>
        ))}
      </pre>
    </div>
  );
}
