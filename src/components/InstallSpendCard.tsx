"use client";

import Link from "next/link";
// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime, so a tested component has to import the
// way `Meter` and `RecentBlocksCard` already do.
import type { InstallSpendDTO } from "../lib/apiTypes";
import { fmtUSD } from "../lib/format";
import { Meter } from "./Meter";
import { Card, CardTitle } from "./ui/Card";
import { Hint } from "./ui/Hint";

/**
 * The one ceiling on the dashboard that is about the *install* rather than
 * about a window Anthropic enforces, so it sits outside the meters: its span is
 * a rolling 24 hours, its figures are money this app recorded spending rather
 * than our price table over every transcript on the machine, and the two must
 * never be added.
 *
 * Always shown — with no ceiling configured the meter is the hatched
 * indeterminate one, which is this app's standing answer to a reading with no
 * denominator, and the hint is where the operator finds out the limit exists at
 * all.
 *
 * ## Which of the two figures each part prints
 *
 * `spentUSD` is the measured floor and `spentGuardUSD` adds killed cycles'
 * reconciled estimates and what telemetry says the cycles in flight have cost
 * so far, so the second is over the first whenever anything is running — the
 * ordinary state. The bar draws the split the way every other meter does, solid
 * to the measured figure and hatched out to the guard's, and the head reports
 * both as percentages.
 *
 * The line under it therefore has to print the **measured** figure, or the two
 * printed dollar amounts divide out to the upper reading and the meter's own
 * head contradicts its detail. The guard's figure is named beside it rather
 * than in place of it, in the wording the workflow instance page already uses.
 *
 * ## Why the over-count caveat is not in the branch
 *
 * `spentGuardUSD` is an over-count by construction — a run still going, or one
 * that finished inside the window, counts its whole spend — which
 * `installBudget.ts` calls the safe direction for a ceiling and the wrong one
 * for a report. It used to be explained only where a limit was configured,
 * which is the branch an install does *not* ship in, so the shipped default
 * printed the over-count with the caveat stripped. It is one sentence for both
 * branches now, and what differs between them is only what there is to do about
 * it.
 */
export function InstallSpendCard({ install }: { install: InstallSpendDTO }) {
  const { limitUSD, spentUSD, spentGuardUSD, windowHours } = install;

  return (
    <Card className="mb-4">
      <CardTitle>This install, last {windowHours} hours</CardTitle>
      <Meter
        label="Spent by everything this app runs"
        fraction={limitUSD === null ? null : spentUSD / limitUSD}
        upperFraction={limitUSD === null ? null : spentGuardUSD / limitUSD}
        unknownHint="no install limit set"
        detail={
          limitUSD === null
            ? `${fmtUSD(spentUSD)} measured, up to ${fmtUSD(spentGuardUSD)} counting cycles in flight`
            : `${fmtUSD(spentUSD)} of ${fmtUSD(limitUSD)}; the guard reads ${fmtUSD(spentGuardUSD)}`
        }
      />
      <Hint>
        Runs, workflow blocks and chat turns together. A run still going, or one
        that finished inside the window, counts its whole spend towards the
        guard&rsquo;s figure — which over-counts rather than under-counts, the
        safe direction for a ceiling and the wrong one for a report.{" "}
        {limitUSD === null ? (
          <>
            Every guard in this app bounds one run, one workflow or one chat
            turn. Nothing bounds the total until you{" "}
            <Link href="/settings">set an install limit</Link>.
          </>
        ) : (
          <>
            Not comparable with the meters above: those measure every transcript
            on this machine against Anthropic&rsquo;s windows.
          </>
        )}
      </Hint>
    </Card>
  );
}
