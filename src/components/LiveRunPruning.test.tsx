import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PruneSavingsDTO } from "../lib/apiTypes";
import { LiveRunPruning } from "./LiveRunPruning";

/**
 * What pruning has done for a running run, on its tile.
 *
 * Every failure here is silent and reads as a measurement: a run that never
 * pruned drawn as `+$0.00` says pruning earned nothing where it never ran; an
 * unsettled prune's cost drawn as `$0.00` says the edits were free; a net over
 * prunes that were only partly priced, printed bare, is a total that omits some
 * of its own subject. `RunPruning.test.tsx` holds the same three for the run
 * page, and a tile that draws them differently would disagree with it.
 */

function pruning(over: Partial<PruneSavingsDTO> = {}): PruneSavingsDTO {
  return {
    prunes: 4,
    pricedPrunes: 4,
    unsettledPrunes: 0,
    tokensRemoved: 40_000,
    turnsAfter: 9,
    cacheSavedUSD: 1.2,
    invalidationUSD: 0.3,
    netUSD: 0.9,
    ...over,
  };
}

const text = (html: string) =>
  html.replaceAll("<!-- -->", "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const render = (value: PruneSavingsDTO | null) =>
  text(renderToStaticMarkup(<LiveRunPruning pruning={value} />));

test("a run that has not pruned is a dash with words and never a zero", () => {
  const html = render(null);
  assert.match(html, /no prune yet/);
  assert.doesNotMatch(html, /\$0\.00/);
  assert.doesNotMatch(html, /\+\$/);
});

test("a settled run shows both halves and the net, signed", () => {
  const html = render(pruning());
  assert.match(html, /Saved \+\$1\.20/);
  // U+2212, the minus `signedUSD` prints, and not a hyphen.
  assert.match(html, /Lost −\$0\.30/);
  assert.match(html, /Net \+\$0\.90/);
  assert.doesNotMatch(html, /at most/);
  assert.doesNotMatch(html, /not settled/);
  assert.doesNotMatch(html, /money over/);
  assert.match(html, /tokens removed over 4 prunes so far/);
});

test("a net that has lost more than it saved reads negative", () => {
  const html = render(pruning({ cacheSavedUSD: 0, invalidationUSD: 0.4, netUSD: -0.4 }));
  assert.match(html, /Net −\$0\.40/);
});

test("a settled cost of nothing says none, which is not the unsettled dash", () => {
  const html = render(pruning({ invalidationUSD: 0, netUSD: 1.2 }));
  assert.match(html, /Lost none/);
  assert.doesNotMatch(html, /not settled/);
});

test("unsettled prunes make the net a ceiling and the lost half not a figure", () => {
  const html = render(pruning({ unsettledPrunes: 3, invalidationUSD: 0, netUSD: 1.2 }));
  assert.match(html, /Net, at most \+\$1\.20/, "the figure still prints, qualified");
  assert.match(html, /not settled yet/);
  assert.match(html, /Lost —/);
  assert.doesNotMatch(html, /Lost none/);
  assert.doesNotMatch(html, /\$0\.00/);
});

test("an unsettled run with some cost already charged shows what was charged", () => {
  const html = render(pruning({ unsettledPrunes: 1, invalidationUSD: 0.3, netUSD: 0.9 }));
  assert.match(html, /Lost −\$0\.30/);
  assert.match(html, /Net, at most/);
  assert.doesNotMatch(html, /not settled yet/);
});

test("prunes the money does not cover are counted apart from the tokens", () => {
  const html = render(pruning({ pricedPrunes: 2 }));
  assert.match(html, /tokens removed over 4 prunes/);
  assert.match(html, /money over 2 of 4/);
  // A coverage gap is not a ceiling.
  assert.doesNotMatch(html, /at most/);
});

test("no priced prune at all is unknown money and never a zero", () => {
  const html = render(
    pruning({ pricedPrunes: 0, cacheSavedUSD: 0, invalidationUSD: 0, netUSD: 0 }),
  );
  assert.match(html, /money over 0 of 4/);
  assert.doesNotMatch(html, /\$0\.00/);
  assert.doesNotMatch(html, /\+\$/);
  assert.match(html, /Saved — /);
  assert.match(html, /Net —/);
});

test("it is labelled as not spend in every state", () => {
  for (const value of [null, pruning(), pruning({ unsettledPrunes: 1 })]) {
    assert.match(render(value), /Context pruning — not spend/);
  }
});

test("one prune is not pluralised", () => {
  assert.match(render(pruning({ prunes: 1, pricedPrunes: 1 })), /over 1 prune so far/);
});
