"use client";

// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime, so a tested component has to import the
// way `RecentBlocksCard` and `Meter` already do.
import Link from "next/link";
import { Meter } from "./Meter";
import { Card, CardTitle } from "./ui/Card";
import { Hint } from "./ui/Hint";
import type { InstallSpendDTO } from "../lib/apiTypes";
import { fmtUSD } from "../lib/format";

/**
 * The one ceiling on the dashboard that is about the *install* rather than
 * about a window Anthropic enforces, which is why it sits outside the meters:
 * its span is a rolling 24 hours, its figures are money this app recorded
 * spending rather than our price table over every transcript on the machine,
 * and the two must never be added.
 *
 * Always shown — with no ceiling configured the meter is the hatched
 * indeterminate one, which is this app's standing answer to a reading with no
 * denominator, and the hint is where the operator finds out the limit exists at
 * all.
 *
 * Its own component rather than a block of `src/app/page.tsx` because the card
 * draws two figures that must agree, and there was no way to assert that from a
 * page whose every reading arrives over a fetch.
 */
export function InstallSpendCard({ install }: { install: InstallSpendDTO }) {
  return (
    <Card className="mb-4">
      <CardTitle>This install, last {install.windowHours} hours</CardTitle>
      <Meter
        label="Spent by everything this app runs"
        fraction={
          install.limitUSD === null ? null : install.spentUSD / install.limitUSD
        }
        upperFraction={
          install.limitUSD === null
            ? null
            : install.spentGuardUSD / install.limitUSD
        }
        unknownHint="no install limit set"
        detail={
          install.limitUSD === null
            ? `${fmtUSD(install.spentGuardUSD)} spent`
            : `${fmtUSD(install.spentGuardUSD)} of ${fmtUSD(install.limitUSD)}`
        }
      />
      <Hint>
        {install.limitUSD === null ? (
          <>
            Every guard in this app bounds one run, one workflow or one chat
            turn. Nothing bounds the total until you{" "}
            <Link href="/settings">set an install limit</Link>.
          </>
        ) : (
          <>
            Runs, workflow blocks and chat turns together. A run still going, or
            one that finished inside the window, counts its whole spend — which
            over-counts rather than under-counts, because this is a limit. Not
            comparable with the meters above: those measure every transcript on
            this machine against Anthropic&rsquo;s windows.
          </>
        )}
      </Hint>
    </Card>
  );
}
