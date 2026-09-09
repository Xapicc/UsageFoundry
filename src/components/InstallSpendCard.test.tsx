import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { InstallSpendDTO } from "../lib/apiTypes";
import { InstallSpendCard } from "./InstallSpendCard";

/**
 * One card, two figures, and the whole risk is that they are not the same one.
 *
 * The card drew its bar from `spentUSD` and printed `spentGuardUSD` under it,
 * so the head and the line beneath it were two different readings of the same
 * window with nothing saying which was which: at $5 measured, $8 guarded and a
 * $10 ceiling the head read "50.0% – 80.0%" over "$8.00 of $10.00", and a
 * reader dividing the two printed dollar figures landed on the upper band.
 *
 * The second fault is in the branch this app ships in. With no limit set the
 * line read "$X spent" — `spentGuardUSD`, which `installBudget.ts` calls the
 * safe direction for a ceiling and the wrong one for a report — while the
 * sentence explaining the over-count rendered only in the *other* branch.
 *
 * Both are silent: every figure is present and right, both branches typecheck,
 * and the only symptom is a number that means something other than what it
 * says.
 *
 * The first fault is pinned on the *pair* rather than on either string: the
 * amount the line leads with, over the ceiling it names, must be the fraction
 * the bar was given. A test that only pinned the string would pass again the
 * next time the two are wired apart.
 */

function install(over: Partial<InstallSpendDTO> = {}): InstallSpendDTO {
  // Far enough apart that every wrong pairing lands on a different string:
  // 5/10 is 50.0% and 8/10 is 80.0%.
  return {
    spentUSD: 5,
    spentGuardUSD: 8,
    limitUSD: 10,
    windowHours: 24,
    ...over,
  };
}

/** React writes `<!-- -->` between adjacent text nodes; the copy is one string. */
function render(over: Partial<InstallSpendDTO> = {}): string {
  return renderToStaticMarkup(
    <InstallSpendCard install={install(over)} />,
  ).replaceAll("<!-- -->", "");
}

/** The percentage `aria-valuenow` claims, which is what the bar is drawn to. */
function drawnPercent(html: string): number {
  const found = html.match(/aria-valuenow="(\d+)"/);
  assert.ok(found, "the meter must claim a value when a ceiling is set");
  return Number(found[1]);
}

/** The first dollar amount in the line under the bar. */
function printedUSD(html: string): number {
  const detail = html.split('role="progressbar"')[1];
  const found = detail.match(/\$([\d,]+\.\d\d)/);
  assert.ok(found, "the detail line must print an amount");
  return Number(found[1].replace(/,/g, ""));
}

test("the drawn fraction and the printed amount are the same figure", () => {
  const html = render();
  const limit = 10;
  assert.equal(
    printedUSD(html) / limit,
    drawnPercent(html) / 100,
    "the amount under the bar must be the amount the bar was drawn to",
  );
  assert.equal(printedUSD(html), 5, "the measured figure, not the guard's");
});

test("the line under the bar prints the measured figure, not the guard's", () => {
  const html = render();
  assert.match(html, /\$5\.00 of \$10\.00/);
  // The guard's figure is named rather than dropped: the hatched band out to
  // 80% has to be explicable, and a run refused above the visible bar is what
  // `Meter`'s upper reading exists for.
  assert.match(html, /the guard reads \$8\.00/);
});

test("the head's two percentages are the two figures the line names", () => {
  const html = render();
  assert.match(html, /50\.0%/);
  assert.match(html, /80\.0%/);
});

test("with no limit the line says what each figure is", () => {
  // The shipped default. "$8.00 spent" was an over-count wearing a
  // measurement's label, on the one branch whose caveat had been left behind
  // in the other.
  const html = render({ limitUSD: null });
  assert.match(html, /\$5\.00 measured/);
  assert.match(html, /up to \$8\.00 counting cycles in flight/);
  assert.doesNotMatch(html, /\$8\.00 spent/);
  // No denominator, so no percentage to disagree with — but the same figure
  // still leads the line, or switching the limit off silently changes which
  // reading "spent" means.
  assert.equal(printedUSD(html), 5);
});

test("a fully settled window names no second figure", () => {
  // Nothing running and nothing killed, which is what an idle install reads:
  // `Meter` draws no band for an equal upper reading, so a second amount here
  // would be money with nothing on the bar to explain it — two measurements
  // that happen to agree rather than one.
  const capped = render({ spentGuardUSD: 5 });
  assert.doesNotMatch(capped, /guard reads/);
  assert.match(capped, /\$5\.00 of \$10\.00/);

  const uncapped = render({ spentGuardUSD: 5, limitUSD: null });
  assert.doesNotMatch(uncapped, /up to/);
  assert.match(uncapped, /\$5\.00 measured/);
});

test("the over-count caveat renders in both branches", () => {
  // A run alive inside the window contributes its *whole* spend to both
  // figures, because `runs.spent_usd` is one figure per run and this app
  // records no per-hour breakdown of it.
  for (const limitUSD of [10, null]) {
    const html = render({ limitUSD });
    assert.match(
      html,
      /counts its whole spend/,
      `limitUSD=${limitUSD}: the over-count must be stated`,
    );
    assert.match(
      html,
      /upper bound/,
      `limitUSD=${limitUSD}: named as a bound on the window`,
    );
    assert.match(
      html,
      /over-counts rather than under-counts/,
      `limitUSD=${limitUSD}: the caveat belongs to the figure, not to the branch`,
    );
  }
});

test("no limit still draws the hatch rather than a reading", () => {
  const html = render({ limitUSD: null });
  assert.match(html, /no install limit set/);
  assert.doesNotMatch(html, /aria-valuenow/);
});
