import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { FilterSavingsDTO, PruneSavingsDTO } from "../lib/apiTypes";
import { ContextControlAside } from "./ContextControl";

/**
 * The tile prints `PruneSavingsDTO.netUSD`, and two of that DTO's fields exist
 * only to say what the figure is not. `PruneSavingsRows` renders both; this
 * card rendered neither, so the same number that reads "at most" in the band
 * lower down read as a settled net at the top of the dashboard.
 *
 * It earns a test on this repo's usual grounds — the failure is silent. Every
 * field is present, the arithmetic is right, and nothing throws or fails a
 * typecheck; the only symptom is a saving reported as final that has not
 * finished being checked, which is the one direction this card was built not
 * to mislead in.
 */

const NOTHING_FILTERED: FilterSavingsDTO = {
  results: 0,
  pricedResults: 0,
  deferredOnly: 0,
  fallbackKeyed: 0,
  tokensRemoved: 0,
  turnsAfter: 0,
  cacheWriteAvoidedUSD: 0,
  uncachedSendUSD: 0,
  cacheReadAvoidedUSD: 0,
  netUSD: 0,
  running: false,
  ledger: "missing",
  session: {
    results: 0,
    pricedResults: 0,
    deferredOnly: 0,
    fallbackKeyed: 0,
    tokensRemoved: 0,
    turnsAfter: 0,
    cacheWriteAvoidedUSD: 0,
    uncachedSendUSD: 0,
    cacheReadAvoidedUSD: 0,
    netUSD: 0,
  },
  weekly: {
    results: 0,
    pricedResults: 0,
    deferredOnly: 0,
    fallbackKeyed: 0,
    tokensRemoved: 0,
    turnsAfter: 0,
    cacheWriteAvoidedUSD: 0,
    uncachedSendUSD: 0,
    cacheReadAvoidedUSD: 0,
    netUSD: 0,
  },
  requests: 0,
  unjoinedRequests: 0,
  totalFrom: null,
};

function savings(over: Partial<PruneSavingsDTO> = {}): PruneSavingsDTO {
  return {
    prunes: 4,
    pricedPrunes: 4,
    unsettledPrunes: 0,
    tokensRemoved: 40_000,
    turnsAfter: 9,
    cacheSavedUSD: 1.2,
    invalidationUSD: 0,
    netUSD: 1.2,
    ...over,
  };
}

/** React writes `<!-- -->` between adjacent text nodes; the copy is one string. */
function render(pruning: PruneSavingsDTO): string {
  return renderToStaticMarkup(
    <ContextControlAside
      filter={NOTHING_FILTERED}
      pruning={pruning}
      pruningFrom={null}
      session={pruning}
      weekly={pruning}
    />,
  ).replaceAll("<!-- -->", "");
}

test("an unsettled net is marked as a ceiling on every span", () => {
  const html = render(
    savings({ prunes: 4, pricedPrunes: 2, unsettledPrunes: 3, netUSD: 1.2 }),
  );
  assert.match(html, /\+\$1\.20/, "the figure itself still prints");
  assert.match(html, /This week, at most/);
  assert.match(html, /This 5-hour window, at most/);
  assert.match(html, /All time, at most/);
});

test("money that covers part of the prunes says how much", () => {
  const html = render(
    savings({ prunes: 4, pricedPrunes: 2, unsettledPrunes: 3, netUSD: 1.2 }),
  );
  assert.match(html, /Money covers 2 of 4 prunes/);
});

test("a settled, fully priced net is not qualified", () => {
  // The other half of the invariant: a card that always hedges says nothing.
  const html = render(savings());
  assert.doesNotMatch(html, /at most/);
  assert.doesNotMatch(html, /Money covers/);
  assert.match(html, /This week/);
});

test("an unpriced prune is a coverage gap and not a ceiling", () => {
  // The two fields fail differently. An unsettled prune is in the saving and
  // not yet in its cost, so the net is high; an unpriced one is in neither, so
  // the net is incomplete. Marking the second "at most" would claim a sign the
  // reading does not carry.
  const html = render(savings({ prunes: 4, pricedPrunes: 2 }));
  assert.match(html, /Money covers 2 of 4 prunes/);
  assert.doesNotMatch(html, /at most/);
});

test("a span with no prunes carries neither qualification", () => {
  const html = render(
    savings({
      prunes: 0,
      pricedPrunes: 0,
      unsettledPrunes: 0,
      tokensRemoved: 0,
      turnsAfter: 0,
      cacheSavedUSD: 0,
      netUSD: 0,
    }),
  );
  assert.doesNotMatch(html, /at most/);
  assert.doesNotMatch(html, /Money covers/);
});
