"use client";

// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime, so a tested component has to import the
// way `Meter` and `RecentBlocksCard` already do.
import type { ContextPrunerDTO, PruneSavingsDTO } from "../lib/apiTypes";
import { fmtTokens, fmtUSD } from "../lib/format";
import { Stat } from "./ui/Card";
import { Notice } from "./ui/Notice";
import { type PruneStatement, prunerLine } from "../lib/pruneStatement";

/**
 * One run's pruning figures, for the region that carries its cost readings.
 *
 * A component rather than JSX inside the run page because the qualifications
 * below are the whole point of it and they are conditional: the page renders
 * this at most once and never in a test, so the states that need saying — a
 * net that is a ceiling, money that covers part of what is counted — had no
 * way of being checked. The `Section` around it stays on the page, which is
 * where that page's other regions define their own.
 *
 * ## The two things this must never imply
 *
 * It is **not spend**, and nothing here may be added to the three readings
 * above it. It is the value of an intervention against a counterfactual: the
 * same work without the prune.
 *
 * And it is only as final as what has been settled behind it. `unsettledPrunes`
 * are priced prunes whose invalidation cost has not been charged yet — already
 * in the saving, not yet in what buying it cost — so a total carrying them can
 * only come down, and printing it bare is the upper bound wearing a net's
 * clothes that `PruneSavingsRows` exists to refuse. An *unpriced* prune is the
 * other fault and is not the same one: it is missing from both halves, so the
 * money is incomplete rather than high, and the count says which of the prunes
 * beside it the money actually covers.
 */
export function RunPruning({
  savings,
  statement,
  pruner,
}: {
  savings: PruneSavingsDTO | null;
  statement: PruneStatement | null;
  pruner: ContextPrunerDTO | null;
}) {
  return (
    <>
      {savings && (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <Stat>
              {savings.netUSD >= 0 ? "+" : "−"}
              {fmtUSD(Math.abs(savings.netUSD))}
            </Stat>
            <div className="text-xs tabular-nums text-ink-muted">
              {/* Bound to the figure it sits beside, on the same baseline, and
                  ahead of the token count: the reader has to know the sign of
                  the error before they read the number, not after. */}
              {savings.unsettledPrunes > 0 && <>at most &middot; </>}
              {fmtTokens(savings.tokensRemoved)} tokens removed over{" "}
              {savings.prunes} {savings.prunes === 1 ? "prune" : "prunes"}
              {/* The token count covers every prune and the money does not, so
                  the two denominators are printed apart rather than the money's
                  being quietly borrowed for both. */}
              {savings.pricedPrunes < savings.prunes && (
                <>
                  {" "}
                  &middot; money over {savings.pricedPrunes} of {savings.prunes}
                </>
              )}
            </div>
          </div>
          <p className="mt-2 text-xs leading-snug text-ink-muted">
            What later turns did not have to re-read, less what the edits cost.
            Not spend, and never added to the figures above.
          </p>
          {savings.unsettledPrunes > 0 && (
            <p className="mt-2 text-xs leading-snug text-ink-muted">
              A prune at a cycle boundary pays nothing only if a plain resume
              would have rewritten its prefix anyway, and that is decided by
              resumes with no prune before them. Until enough of those have been
              seen, the net above is a ceiling.
            </p>
          )}
          {savings.pricedPrunes < savings.prunes && (
            <p className="mt-2 text-xs leading-snug text-ink-muted">
              {/* Names its own subject rather than saying "the rest": the count
                  it refers back to is three lines up, past two other
                  qualifications. */}
              The prunes the money does not cover ran on a model with no price
              here, so what they saved is unknown rather than nothing.
            </p>
          )}
        </>
      )}
      {/* `quiet` here against full strength on the dashboard: by the time a
          finished run is being read this is history, and the place a rebuild is
          prompted is the install-wide card. */}
      {/* What this run's own boundaries did, where they did anything but cut. */}
      {statement?.severity === "warn" ? (
        <Notice tone="warn" quiet className="mt-2">
          {statement.text}
        </Notice>
      ) : (
        statement && (
          <p className="mt-2 text-xs leading-snug text-ink-muted">
            {statement.text}
          </p>
        )
      )}
      {/* And what is switched on, always — the figures above name neither the
          engine nor whether the tool is still there, so a run page without this
          line left both unanswerable. */}
      {pruner && (
        <p className="mt-2 text-xs leading-snug text-ink-muted">
          {prunerLine(pruner)}
        </p>
      )}
    </>
  );
}
