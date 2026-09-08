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

/** A ledger this app can read, with money on both halves of the sum. */
const FILTERING: FilterSavingsDTO = (() => {
  const window = {
    results: 12,
    pricedResults: 12,
    deferredOnly: 0,
    fallbackKeyed: 0,
    tokensRemoved: 90_000,
    turnsAfter: 30,
    cacheWriteAvoidedUSD: 0.6,
    uncachedSendUSD: 0.3,
    cacheReadAvoidedUSD: 0.1,
    netUSD: 0.4,
  };
  return {
    ...window,
    running: true,
    ledger: "read" as const,
    session: window,
    weekly: window,
    requests: 12,
    unjoinedRequests: 0,
    totalFrom: null,
  };
})();

/** React writes `<!-- -->` between adjacent text nodes; the copy is one string. */
function render(
  pruning: PruneSavingsDTO,
  filter: FilterSavingsDTO = NOTHING_FILTERED,
): string {
  return renderToStaticMarkup(
    <ContextControlAside
      filter={filter}
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

/**
 * The card adds two mechanisms that overlap by construction, and
 * `docs/agent/conventions.md` allows that sum on one condition: the card says
 * it is added to nothing beside it, and prints the overstatement. It did
 * neither, which left the one figure on this page that is *not* spend sitting
 * beside three that are with nothing marking the difference.
 */

test("the sum is footnoted as not spend, always", () => {
  assert.match(render(savings()), /added to nothing beside it/);
  assert.match(
    render(savings(), FILTERING),
    /added to nothing beside it/,
    "the standing half of the footnote does not depend on the filter",
  );
});

test("the overstatement is printed where the two halves overlap", () => {
  const html = render(savings(), FILTERING);
  assert.match(html, /overlap/);
  assert.match(html, /4% where it was measured/);
});

test("no overlap, no overstatement", () => {
  // The mirror of the fault this card was fixed for: a caveat asserting an
  // error that is not there. With the filter's half absent the sum is one
  // mechanism's own figure and is not high.
  const html = render(savings());
  assert.doesNotMatch(html, /overlap/);
  assert.doesNotMatch(html, /4%/);

  const noPrunes = render(
    savings({ prunes: 0, pricedPrunes: 0, netUSD: 0, tokensRemoved: 0 }),
    FILTERING,
  );
  assert.doesNotMatch(noPrunes, /overlap/);
});
