import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PruneSavingsDTO } from "../lib/apiTypes";
import { RunPruning } from "./RunPruning";

/**
 * The run page printed this DTO's `netUSD` as a headline and the **full**
 * prune count beside it, while the money behind that figure may cover only
 * `pricedPrunes` of them and may still owe an invalidation cost nobody has
 * settled. Both faults are silent: every field is present and the arithmetic
 * is right, so the only symptom is a saving reported as final and complete
 * when it is neither.
 */

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
function render(over: Partial<PruneSavingsDTO> = {}): string {
  return renderToStaticMarkup(
    <RunPruning savings={savings(over)} statement={null} pruner={null} />,
  ).replaceAll("<!-- -->", "");
}

test("an unsettled net is marked as a ceiling beside the figure", () => {
  const html = render({ prunes: 4, pricedPrunes: 2, unsettledPrunes: 3 });
  assert.match(html, /\+\$1\.20/, "the figure itself still prints");
  assert.match(html, /at most/);
});

test("the prune count beside the money says how many it covers", () => {
  const html = render({ prunes: 4, pricedPrunes: 2, unsettledPrunes: 3 });
  // The tokens are removed by every prune and the money covers two of them, so
  // the two denominators are printed apart rather than sharing one.
  assert.match(html, /tokens removed over 4 prunes/);
  assert.match(html, /money over 2 of 4/);
});

test("a settled, fully priced net is not qualified", () => {
  const html = render();
  assert.doesNotMatch(html, /at most/);
  assert.doesNotMatch(html, /money over/);
  assert.match(html, /tokens removed over 4 prunes/);
});

test("an unpriced prune is a coverage gap and not a ceiling", () => {
  const html = render({ pricedPrunes: 2 });
  assert.match(html, /money over 2 of 4/);
  assert.doesNotMatch(html, /at most/);
});
