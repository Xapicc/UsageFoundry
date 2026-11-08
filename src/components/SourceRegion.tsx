import type { ReactNode } from "react";

/**
 * A named band of cards, and the one reading every card in it is drawn from.
 *
 * `/` and `/usage` between them carry three readings of overlapping money — our
 * price table over every transcript on the machine, what runs this app started
 * reported spending, and Claude Code's own per-request telemetry — and any sum
 * of two of them double-counts. That prohibition used to be defended by a
 * paragraph at the foot of each card, so every card that landed had to
 * re-derive it and six of the eight landed with a separate feature. As a
 * boundary it is structural: a new card lands in the band whose source it
 * reads, and a total drawn across one is visibly wrong rather than merely
 * undocumented. Each card keeps its own footnote, which is now belt as well as
 * braces. Both pages render this one component, so a band means the same thing
 * on either.
 *
 * **No figure, meter, badge, total or comparison may be drawn at this level.**
 * A number beside a band's name is a number about two cards at once, which is
 * the arithmetic the bands exist to make impossible.
 *
 * A `div` with an `h2` in it, never a `<section>`: `section + section
 * { margin-top: 24px }` is still in the legacy layer and would fire between
 * every pair of these, which reads as a spacing decision somebody made rather
 * than as a stylesheet rule nobody meant to trigger. `Card` documents the same
 * trap from the other side.
 */
export function SourceRegion({
  heading,
  statement,
  children,
}: {
  heading: string;
  /** Where the figures below come from, in one sentence. Never a figure. */
  statement: string;
  children: ReactNode;
}) {
  return (
    <div className="mt-6">
      <h2 className="text-sm font-semibold text-ink">{heading}</h2>
      <p className="mt-0.5 mb-3 max-w-[68ch] text-xs text-ink-muted">
        {statement}
      </p>
      {children}
    </div>
  );
}
