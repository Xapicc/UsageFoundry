import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InstallSpendCard } from "./InstallSpendCard";
import type { InstallSpendDTO } from "../lib/apiTypes";

/**
 * One card, two figures, and the whole risk is that they are not the same one.
 *
 * `spentUSD` is the measured floor — every figure a CLI itself reported — and
 * `spentGuardUSD` adds killed cycles' reconciled estimates and what telemetry
 * says the cycles in flight have cost so far. The bar is drawn from the first
 * and the hatched band out to the second, which is the split every other meter
 * here makes; the dollar line under the bar was printing the second on its own,
 * so the card said "18.0%" above "$18.00 of $100.00" while the bar stood at
 * 12%. Nothing throws, nothing fails a typecheck, and both numbers are real —
 * they are just answers to different questions, and an operator reconciling the
 * card against Settings has no way to tell which one they are reading.
 *
 * The assertions are on the *pair*: the amount the line leads with, over the
 * ceiling it names, must be the fraction the bar was given. A test that only
 * pinned the string would pass again the next time the two are wired apart.
 */

function install(over: Partial<InstallSpendDTO> = {}): InstallSpendDTO {
  return {
    // Far enough apart that every wrong pairing lands on a different string:
    // 12/100 is 12.0% and 18/100 is 18.0%.
    spentUSD: 12,
    spentGuardUSD: 18,
    limitUSD: 100,
    windowHours: 24,
    ...over,
  };
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
  const html = renderToStaticMarkup(<InstallSpendCard install={install()} />);
  const limit = 100;
  assert.equal(
    printedUSD(html) / limit,
    drawnPercent(html) / 100,
    "the amount under the bar must be the amount the bar was drawn to",
  );
  assert.equal(printedUSD(html), 12, "the measured figure, not the guard's");
});

test("with no ceiling set the line still leads with the drawn figure", () => {
  // No denominator, so no percentage to disagree with — but the same figure
  // feeds the line, or switching the limit off silently changes what "spent"
  // means.
  const html = renderToStaticMarkup(
    <InstallSpendCard install={install({ limitUSD: null })} />,
  );
  assert.equal(printedUSD(html), 12);
});

test("the guard's higher figure is named as the guard's, never as spend", () => {
  // It is drawn as a hatched band past the fill, so it has to be sayable in
  // money too — a run refused at a threshold the visible bar has not reached is
  // otherwise unexplainable from this card.
  const html = renderToStaticMarkup(<InstallSpendCard install={install()} />);
  assert.match(html, /guard reads \$18\.00/);
});

test("a fully settled window says nothing about a guard figure", () => {
  // The ordinary case. A second amount equal to the first is noise, and reads
  // as two measurements that happen to agree rather than as one.
  const html = renderToStaticMarkup(
    <InstallSpendCard install={install({ spentGuardUSD: 12 })} />,
  );
  assert.doesNotMatch(html, /guard reads/);
  assert.match(html, /\$12\.00 of \$100\.00/);
});

test("the whole-run over-count is stated whether or not a limit is set", () => {
  // A run alive inside the window contributes its *whole* spend, because
  // `runs.spent_usd` is one figure per run and this app records no per-hour
  // breakdown of it. That makes every amount on this card an upper bound on the
  // window rather than the window's own share, and the caveat used to live only
  // in the branch that has a ceiling — while the branch without one printed a
  // dollar figure just the same.
  for (const limitUSD of [100, null]) {
    const html = renderToStaticMarkup(
      <InstallSpendCard install={install({ limitUSD })} />,
    );
    assert.match(
      html,
      /counts its whole spend/,
      `limit ${limitUSD}: the over-count must be stated`,
    );
    assert.match(html, /upper bound/, `limit ${limitUSD}: named as a bound`);
  }
});
