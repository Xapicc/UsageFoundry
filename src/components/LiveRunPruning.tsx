// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime, so a tested component has to import the
// way `LiveRunFigures` and `RunPruning` already do.
import type { LiveRunDTO } from "../lib/apiTypes";
import { fmtTokens, fmtUSD, signedUSD } from "../lib/format";

const SUB = "mt-0.5 text-xs tabular-nums text-ink-muted";
const FIGURE = "text-sm font-semibold tabular-nums";

/**
 * What context pruning has done for a running run so far, on its `/runs/live`
 * tile: what it saved, what that cost, and the net.
 *
 * **Not spend.** It is the value of an intervention against the same work
 * without the prune, so it is a block of its own under the context meter, in
 * the smaller figure, under a label that says so — a dollar figure one row
 * below two others invites a reader to add them. A sibling of `LiveRunFigures`
 * rather than a third figure in it, because that component's rule, two money
 * figures and never a sum, would stop being true of its contents.
 *
 * **The halves are shown, not only the net**: a net near zero is either a prune
 * that did nothing or one that saved and cost about the same.
 *
 * Qualified the way `RunPruning` qualifies the run page's figure. Unsettled
 * prunes have a cost not charged yet, so the lost half is a dash with words and
 * never `$0.00`, and the net is a ceiling and says "at most". Unpriced prunes
 * are in neither half, so the count says how many the money covers; when that is
 * none of them the money is unknown rather than zero and prints as dashes (the
 * run page prints `+$0.00` there, beside the same count). A run that has not
 * pruned is `null` on the wire and a dash here, as `LiveRunFigures` draws a run
 * with no telemetry.
 *
 * A live run's figure grows as its later turns happen, so a prune made a moment
 * ago can read negative, and the count of prunes says "so far".
 */
export function LiveRunPruning({ pruning }: { pruning: LiveRunDTO["pruning"] }) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-semibold text-ink">Context pruning — not spend</div>
      {pruning ? <Figures pruning={pruning} /> : <NoPrune />}
    </div>
  );
}

function NoPrune() {
  return (
    <>
      <div className={FIGURE}>—</div>
      <div className={SUB}>no prune yet</div>
    </>
  );
}

function Figures({
  pruning,
}: {
  pruning: NonNullable<LiveRunDTO["pruning"]>;
}) {
  const { prunes, pricedPrunes, unsettledPrunes, tokensRemoved } = pruning;
  const priced = pricedPrunes > 0;
  const lostSettled = unsettledPrunes === 0 || pruning.invalidationUSD > 0;

  return (
    <>
      <div className="mt-1 grid grid-cols-3 gap-3">
        <div className="min-w-0">
          <div className="text-xs text-ink-muted">Saved</div>
          <div className={FIGURE}>
            {priced ? `+${fmtUSD(pruning.cacheSavedUSD)}` : "—"}
          </div>
          <div className={SUB}>re-reads avoided</div>
        </div>
        <div className="min-w-0">
          <div className="text-xs text-ink-muted">Lost</div>
          {/* The same three readings as `PruneSavingsRows`' restart row: a cost
              charged, a cost not charged yet, and a cost measured as nothing.
              The second and third are both a 0 on the wire. */}
          <div className={FIGURE}>
            {!priced || !lostSettled
              ? "—"
              : pruning.invalidationUSD > 0
                ? `−${fmtUSD(pruning.invalidationUSD)}`
                : "none"}
          </div>
          <div className={SUB}>
            {priced && !lostSettled ? "not settled yet" : "restarts paid for"}
          </div>
        </div>
        <div className="min-w-0">
          {/* Bound to the figure it qualifies, and ahead of it: the reader has
              to know the sign of the error before they read the number. */}
          <div className="text-xs text-ink-muted">
            {unsettledPrunes > 0 ? "Net, at most" : "Net"}
          </div>
          <div className={FIGURE}>{priced ? signedUSD(pruning.netUSD) : "—"}</div>
        </div>
      </div>
      <div className={SUB}>
        {fmtTokens(tokensRemoved)} tokens removed over {prunes}{" "}
        {prunes === 1 ? "prune" : "prunes"} so far
        {/* The tokens cover every prune and the money does not, so the two
            denominators are printed apart, as `RunPruning` prints them. */}
        {pricedPrunes < prunes && (
          <>
            {" "}
            &middot; money over {pricedPrunes} of {prunes}
          </>
        )}
      </div>
    </>
  );
}
