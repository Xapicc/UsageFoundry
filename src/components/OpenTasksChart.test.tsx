import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  OpenTasksChart,
  openTaskSeries,
  type OpenTasksPoint,
} from "./OpenTasksChart";
// The component's own formatter, so the label's date cannot drift from what is
// rendered by asserting against a second spelling of the same day.
import { fmtDate } from "../lib/format";

/**
 * Every failure here draws an ordinary-looking line:
 *
 *  - Days cut in UTC rather than the browser's zone. In Berlin a task filed at
 *    half past midnight lands on the day before, and the chart moves every
 *    change two hours early with nothing to show it did.
 *  - Days measured as `now - n * 86_400_000`. The week a clock change falls in
 *    has one 23- or 25-hour day, so every earlier sample is an hour off
 *    midnight.
 *  - Open at an instant decided with the wrong inequality. A task closed at a
 *    sample instant is closed at it; one filed at it is open at it.
 *  - A flat series scaled by its own zero range, which is `NaN` in every
 *    coordinate and draws nothing at all over figures that still look right.
 *
 * The zone is pinned for the file so the day boundaries are asserted as UTC
 * instants — the thing a wrong cut would move — rather than against a local
 * constructor that would move with it. `node --test` runs each file in its own
 * process, so this reaches no other test.
 */
process.env.TZ = "Europe/Berlin";

const HOUR = 3_600_000;
/** Sunday 27 September 2026, 15:00 CEST (UTC+2). */
const NOW = Date.UTC(2026, 8, 27, 13, 0);

/** The last millisecond of a Berlin day in September, as a UTC instant. */
function endOfSeptemberDay(day: number): number {
  // Midnight CEST starting the next day is 22:00 UTC on this one.
  return Date.UTC(2026, 8, day, 22, 0) - 1;
}

function task(createdAt: number, closedAt: number | null = null) {
  return { createdAt, closedAt };
}

test("samples the end of each of the last seven local days and now", () => {
  const series = openTaskSeries([], NOW);
  assert.deepEqual(
    series.map((point) => point.at),
    [20, 21, 22, 23, 24, 25, 26].map(endOfSeptemberDay).concat(NOW),
  );
});

test("an empty board is zero on every day, not an empty series", () => {
  assert.deepEqual(
    openTaskSeries([], NOW).map((point) => point.open),
    [0, 0, 0, 0, 0, 0, 0, 0],
  );
});

test("counts a task by when it was filed and when it was closed", () => {
  const counts = (tasks: ReturnType<typeof task>[]) =>
    openTaskSeries(tasks, NOW).map((point) => point.open);
  const midday = (day: number) => Date.UTC(2026, 8, day, 10, 0);

  // Filed on the 23rd: absent before it, present from its own day on.
  assert.deepEqual(counts([task(midday(23))]), [0, 0, 0, 1, 1, 1, 1, 1]);
  // Open before the window and closed on the 24th.
  assert.deepEqual(
    counts([task(midday(1), midday(24))]),
    [1, 1, 1, 1, 0, 0, 0, 0],
  );
  // Closed before the window began: never counted.
  assert.deepEqual(counts([task(midday(1), midday(10))]), [0, 0, 0, 0, 0, 0, 0, 0]);
  // Open since before the window and still open: counted every day.
  assert.deepEqual(counts([task(midday(1))]), [1, 1, 1, 1, 1, 1, 1, 1]);
  // Filed today: only the point at now has it.
  assert.deepEqual(counts([task(NOW - HOUR)]), [0, 0, 0, 0, 0, 0, 0, 1]);
});

test("a close at a sample instant is closed there, a filing is open there", () => {
  const at = endOfSeptemberDay(23);
  const [closed, filed] = [task(Date.UTC(2026, 8, 1), at), task(at)].map(
    (one) => openTaskSeries([one], NOW).map((point) => point.open),
  );
  assert.deepEqual(closed, [1, 1, 1, 0, 0, 0, 0, 0]);
  assert.deepEqual(filed, [0, 0, 0, 1, 1, 1, 1, 1]);
});

test("a day ends at local midnight, not at UTC midnight", () => {
  // 00:30 CEST on the 21st, which is still the 20th in UTC.
  const justAfterMidnight = Date.UTC(2026, 8, 20, 22, 30);
  assert.deepEqual(
    openTaskSeries([task(justAfterMidnight)], NOW).map((point) => point.open),
    [0, 1, 1, 1, 1, 1, 1, 1],
  );
  // And 23:30 CEST on the 20th is still the 20th's.
  const justBeforeMidnight = Date.UTC(2026, 8, 20, 21, 30);
  assert.equal(
    openTaskSeries([task(justBeforeMidnight)], NOW)[0].open,
    1,
  );
});

test("the week a clock change falls in keeps every sample on midnight", () => {
  // Summer time ends at 03:00 CEST on Sunday 25 October 2026, so the 25th is
  // 25 hours long. Tuesday the 27th, 12:00 CET (UTC+1).
  const now = Date.UTC(2026, 9, 27, 11, 0);
  const ats = openTaskSeries([], now).map((point) => point.at);
  // Before the change a Berlin midnight is 22:00 UTC, after it 23:00 UTC.
  const cest = (day: number) => Date.UTC(2026, 9, day, 22, 0) - 1;
  const cet = (day: number) => Date.UTC(2026, 9, day, 23, 0) - 1;
  assert.deepEqual(ats, [
    cest(20),
    cest(21),
    cest(22),
    cest(23),
    cest(24),
    cet(25),
    cet(26),
    now,
  ]);
});

function point(open: number, day: number): OpenTasksPoint {
  return { at: endOfSeptemberDay(day), open };
}

function seriesOf(counts: number[]): OpenTasksPoint[] {
  return counts.map((open, i) =>
    i === counts.length - 1 ? { at: NOW, open } : point(open, 20 + i),
  );
}

test("the chart states every count in its label", () => {
  const counts = [140, 142, 141, 145, 150, 152, 153, 155];
  const html = renderToStaticMarkup(<OpenTasksChart series={seriesOf(counts)} />);
  assert.match(html, /role="img"/);
  const label = `Open tasks at the end of each day from ${fmtDate(endOfSeptemberDay(20))} to now: ${counts.join(", ")}`;
  assert.ok(
    html.includes(`aria-label="${label}"`),
    `expected aria-label "${label}" in ${html}`,
  );
});

test("the current count and the week's change are printed beside the line", () => {
  const up = renderToStaticMarkup(
    <OpenTasksChart series={seriesOf([140, 142, 141, 145, 150, 152, 153, 155])} />,
  );
  assert.match(up, />155<\/span>/);
  assert.match(up, /\+15 over 7 days/);

  const down = renderToStaticMarkup(
    <OpenTasksChart series={seriesOf([9, 9, 8, 8, 7, 7, 6, 6])} />,
  );
  assert.match(down, /−3 over 7 days/);

  const flat = renderToStaticMarkup(
    <OpenTasksChart series={seriesOf([4, 5, 3, 4, 4, 4, 4, 4])} />,
  );
  assert.match(flat, /unchanged over 7 days/);
});

test("a flat series, zero included, draws a line rather than NaN", () => {
  for (const open of [0, 12]) {
    const html = renderToStaticMarkup(
      <OpenTasksChart series={seriesOf(Array(8).fill(open))} />,
    );
    assert.doesNotMatch(html, /NaN/, `flat at ${open}`);
    assert.match(html, /<path d="M3 \d/, `flat at ${open} draws a path`);
  }
});

test("says the counts are rebuilt rather than recorded", () => {
  const html = renderToStaticMarkup(<OpenTasksChart series={seriesOf(Array(8).fill(1))} />);
  assert.match(html, /Rebuilt from when each task was filed and closed/);
});
