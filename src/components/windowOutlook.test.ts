import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fmtDateTime } from "../lib/format";
import {
  fmtInstant,
  fmtLeft,
  fmtSpan,
  isProjectable,
  outlookLine,
  windowOutlook,
  type OutlookWindow,
} from "./windowOutlook";

/**
 * The dashboard's answer to "does it run out before it resets", for each
 * window against its own reset. Every way it goes wrong renders a plausible
 * line: a run-out set against the other window's reset tells the operator to
 * wait for a reset that frees nothing, a window with no basis printed as
 * "lasts to reset" claims a projection nobody made, a projection made before a
 * reset printed after it describes a window that is gone, and a margin or a
 * remainder rounded across its boundary states the opposite of the reading.
 * None of it throws.
 */

const NOW = 1_791_400_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const session = (over: Partial<OutlookWindow> = {}): OutlookWindow => ({
  resetsAt: NOW + 2 * HOUR,
  projectable: true,
  projectedAt: null,
  ...over,
});
const weekly = (over: Partial<OutlookWindow> = {}): OutlookWindow => ({
  resetsAt: NOW + 3 * DAY,
  projectable: true,
  projectedAt: null,
  ...over,
});

test("no projection: each window with a basis lasts, a trailing week is not projected to run out", () => {
  const s = windowOutlook(session(), NOW);
  const w = windowOutlook(weekly({ resetsAt: null }), NOW);
  assert.deepEqual(s, { kind: "lasts", trailing: false });
  assert.deepEqual(w, { kind: "lasts", trailing: true });
  assert.equal(outlookLine(s, "$4.10/h", NOW), "Lasts to reset at $4.10/h");
  assert.equal(outlookLine(w, null, NOW), "Not projected to run out");
});

test("a window with nothing to project against says so instead of 'lasts'", () => {
  const o = windowOutlook(session({ projectable: false }), NOW);
  assert.equal(o.kind, "nothing-to-project");
  assert.equal(outlookLine(o, "$4.10/h", NOW), "Nothing to project against");
});

test("a week that runs out inside the session prints its own line against its own reset", () => {
  // The case the snapshot's one instant could not attribute: before the
  // session's reset, with both windows projectable. It printed "Session or
  // week runs out … before this reset" and gave the week no line.
  const s = windowOutlook(session(), NOW);
  const w = windowOutlook(weekly({ projectedAt: NOW + 50 * MIN }), NOW);
  assert.deepEqual(s, { kind: "lasts", trailing: false });
  assert.deepEqual(w, {
    kind: "runs-out",
    at: NOW + 50 * MIN,
    inMs: 50 * MIN,
    beforeResetMs: 3 * DAY - 50 * MIN,
  });
  assert.match(outlookLine(w, "$4.10/h", NOW), /^Runs out ~.* \(in 50m\) at \$4\.10\/h — 2d 23h before reset$/);
});

test("both windows running out each print their own instant and margin", () => {
  const s = windowOutlook(session({ projectedAt: NOW + 40 * MIN }), NOW);
  const w = windowOutlook(weekly({ projectedAt: NOW + 5 * HOUR }), NOW);
  assert.match(outlookLine(s, "$4.10/h", NOW), /^Runs out ~.* \(in 40m\) at \$4\.10\/h — 1h 20m before reset$/);
  assert.match(outlookLine(w, null, NOW), /^Runs out ~.* \(in 5h\) — 2d 19h before reset$/);
});

test("a window with no basis says so while the other runs out", () => {
  const s = windowOutlook(session({ projectable: false }), NOW);
  const w = windowOutlook(weekly({ projectedAt: NOW + 50 * MIN }), NOW);
  assert.equal(s.kind, "nothing-to-project");
  assert.equal(w.kind, "runs-out");
});

test("a projection equal to the reset runs out, at about the reset", () => {
  const o = windowOutlook(session({ projectedAt: NOW + 2 * HOUR }), NOW);
  assert.equal(o.kind === "runs-out" && o.beforeResetMs, 0);
  assert.match(outlookLine(o, null, NOW), /\(in 2h\) — about when it resets$/);
  // One minute short is a margin, and is printed as one.
  const early = windowOutlook(session({ projectedAt: NOW + 2 * HOUR - MIN }), NOW);
  assert.match(outlookLine(early, null, NOW), / — 1m before reset$/);
});

test("a projection already past is 'now', and the margin runs from now", () => {
  const o = windowOutlook(session({ projectedAt: NOW - 10 * MIN }), NOW);
  assert.deepEqual(o, {
    kind: "runs-out",
    at: NOW,
    inMs: 0,
    beforeResetMs: 2 * HOUR,
  });
  assert.equal(outlookLine(o, "$9.00/h", NOW), "Runs out now at $9.00/h — 2h before reset");
});

test("a window that has reset says so, over a projection made before it", () => {
  const o = windowOutlook(session({ resetsAt: NOW - MIN, projectedAt: NOW - 2 * MIN }), NOW);
  assert.equal(o.kind, "reset");
  assert.equal(outlookLine(o, null, NOW), "Reset since this reading");
  // A reset at exactly now has happened.
  assert.equal(windowOutlook(session({ resetsAt: NOW }), NOW).kind, "reset");
});

test("a trailing week that runs out has no margin", () => {
  const o = windowOutlook(weekly({ resetsAt: null, projectedAt: NOW + 30 * HOUR }), NOW);
  assert.equal(o.kind === "runs-out" && o.beforeResetMs, null);
  assert.match(outlookLine(o, null, NOW), /^Runs out ~.* \(in 1d 6h\)$/);
});

test("projectable mirrors what buildSnapshot projects against", () => {
  assert.equal(isProjectable({ fractionMetric: "plan", planFraction: 0.4 }), true);
  assert.equal(isProjectable({ fractionMetric: "plan", planFraction: 0 }), false);
  // A model-scoped wall standing in for a missing figure: no candidate.
  assert.equal(isProjectable({ fractionMetric: "plan", planFraction: null }), false);
  assert.equal(isProjectable({ fractionMetric: "cost", planFraction: null }), true);
  assert.equal(isProjectable({ fractionMetric: "tokens", planFraction: null }), true);
  assert.equal(isProjectable({ fractionMetric: null, planFraction: null }), false);
});

test("spans round to the minute, then to the hour from a day", () => {
  assert.equal(fmtSpan(29_999), "<1m");
  assert.equal(fmtSpan(30_000), "1m");
  assert.equal(fmtSpan(-5 * MIN), "<1m");
  assert.equal(fmtSpan(59 * MIN + 29_999), "59m");
  assert.equal(fmtSpan(59 * MIN + 30_000), "1h");
  assert.equal(fmtSpan(HOUR + 10 * MIN), "1h 10m");
  assert.equal(fmtSpan(DAY - 31_000), "23h 59m");
  assert.equal(fmtSpan(DAY - 30_000), "1d");
  assert.equal(fmtSpan(DAY + 29 * MIN), "1d");
  assert.equal(fmtSpan(DAY + 30 * MIN), "1d 1h");
  assert.equal(fmtSpan(3 * DAY + 4 * HOUR), "3d 4h");
});

test("what is left never rounds to the opposite of the reading", () => {
  assert.equal(fmtLeft(null), null);
  assert.equal(fmtLeft(Number.NaN), null);
  assert.equal(fmtLeft(0.62), "38% left");
  assert.equal(fmtLeft(0), "100% left");
  assert.equal(fmtLeft(0.004), ">99% left");
  assert.equal(fmtLeft(0.996), "<1% left");
  assert.equal(fmtLeft(1), "0% left");
  assert.equal(fmtLeft(1.04), "0% left");
});

test("an instant is a time today and a date with a time from tomorrow", () => {
  // Local wall-clock dates, so this holds in whatever zone the suite runs in.
  const now = new Date(2026, 10, 8, 9, 0).getTime();
  const time = (t: number) =>
    new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const lastMinuteToday = new Date(2026, 10, 8, 23, 59).getTime();
  const midnight = new Date(2026, 10, 9, 0, 0).getTime();
  assert.equal(fmtInstant(lastMinuteToday, now), time(lastMinuteToday));
  assert.equal(fmtInstant(midnight, now), fmtDateTime(midnight));
  assert.notEqual(fmtInstant(midnight, now), time(midnight));
});
