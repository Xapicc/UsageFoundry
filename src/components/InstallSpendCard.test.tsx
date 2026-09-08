import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { InstallSpendDTO } from "../lib/apiTypes";
import { InstallSpendCard } from "./InstallSpendCard";

/**
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
 */

function install(over: Partial<InstallSpendDTO> = {}): InstallSpendDTO {
  return { spentUSD: 5, spentGuardUSD: 8, limitUSD: 10, windowHours: 24, ...over };
}

/** React writes `<!-- -->` between adjacent text nodes; the copy is one string. */
function render(over: Partial<InstallSpendDTO> = {}): string {
  return renderToStaticMarkup(
    <InstallSpendCard install={install(over)} />,
  ).replaceAll("<!-- -->", "");
}

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
});

test("the over-count caveat renders in both branches", () => {
  for (const limitUSD of [10, null]) {
    const html = render({ limitUSD });
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
