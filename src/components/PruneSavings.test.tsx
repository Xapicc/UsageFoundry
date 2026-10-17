import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ContextPrunerDTO,
  PruneActivityDTO,
  PruneSavingsDTO,
} from "../lib/apiTypes";
import { PruneSavingsRows } from "./PruneSavings";

/**
 * The dashboard's pruning band, one span at a time. A prune on a model with no
 * price here is in `prunes` and in neither half of the money, so its dollars
 * are 0 on the wire, and printed bare they read "+$0.00 saved, nothing paid —
 * measured": a confident claim that pruning earned nothing, which is the one
 * thing an unpriced reading cannot say. The runs list prints `?` for the same
 * run, so the two screens disagreed about one number.
 */

const PRUNER: ContextPrunerDTO = {
  state: "ready",
  engine: "legacy",
  detail: null,
  minColdAgeSeconds: null,
};

const EVERY_BOUNDARY_CUT: PruneActivityDTO = {
  boundaries: 3,
  cut: 3,
  nothing: 0,
  declined: 0,
  refused: 0,
  unavailable: 0,
  failed: 0,
  lastDetail: null,
};

function savings(over: Partial<PruneSavingsDTO> = {}): PruneSavingsDTO {
  return {
    prunes: 3,
    pricedPrunes: 3,
    unsettledPrunes: 0,
    unmeasuredPrunes: 0,
    tokensRemoved: 300_000,
    turnsAfter: 36,
    cacheSavedUSD: 0.8,
    invalidationUSD: 0,
    netUSD: 0.8,
    ...over,
  };
}

/** React writes `<!-- -->` between adjacent text nodes; the copy is one string. */
function render(span: PruneSavingsDTO): string {
  return renderToStaticMarkup(
    <PruneSavingsRows
      label="This week"
      savings={span}
      pruner={PRUNER}
      activity={EVERY_BOUNDARY_CUT}
    />,
  )
    .replaceAll("<!-- -->", "")
    .replace(/<[^>]+>/g, " ");
}

test("a span whose prunes nothing could price is unknown money, never +$0.00", () => {
  // What `sumPruneSavings` returns for three Claude Haiku 5.5 cuts: counted,
  // tokens measured, every dollar field 0 because `netReceipt` had no rate.
  const text = render(
    savings({ pricedPrunes: 0, cacheSavedUSD: 0, invalidationUSD: 0, netUSD: 0 }),
  );
  assert.doesNotMatch(text, /\$0\.00/);
  assert.doesNotMatch(text, /nothing — measured/);
  assert.match(text, /300\.0k tokens\s+over 3 prunes/, "the tokens are a measurement and stay");
  assert.match(text, /unknown/);
});

test("an unmeasured fork on an unpriced model says nothing about a net", () => {
  const text = render(
    savings({
      pricedPrunes: 0,
      unmeasuredPrunes: 1,
      cacheSavedUSD: 0,
      invalidationUSD: 0,
      netUSD: 0,
    }),
  );
  assert.match(text, /1 of 3 prunes have a removal not measured yet\./);
  assert.doesNotMatch(text, /net above/);
});

test("money that covers some of the prunes says how many", () => {
  const text = render(savings({ prunes: 4, pricedPrunes: 2 }));
  assert.match(text, /\+\$0\.80/, "the priced half still prints");
  assert.match(text, /Money covers 2 of 4 prunes/);
});

test("money that covers every prune carries no coverage line", () => {
  // The control: a band that always hedged would satisfy the two cases above.
  const text = render(savings());
  assert.match(text, /Net\s+\+\$0\.80/);
  assert.doesNotMatch(text, /Money covers/);
  assert.doesNotMatch(text, /unknown/);
});
