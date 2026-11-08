import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  fmtLeft,
  fmtSpan,
  isProjectable,
  outlookLine,
  windowOutlooks,
  type OutlookWindow,
} from "./windowOutlook";

/**
 * The dashboard's answer to "does it run out before it resets", set against
 * the right window's reset. Every way it goes wrong renders a plausible line:
 * the week's run-out printed as the session's tells the operator to wait for a
 * reset that frees nothing, a window with no basis printed as "lasts to reset"
 * claims a projection nobody made, and a margin or a remainder rounded across
 * its boundary states the opposite of the reading. None of it throws.
 */

const NOW = 1_791_400_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const session = (over: Partial<OutlookWindow> = {}): OutlookWindow => ({
  resetsAt: NOW + 2 * HOUR,
  projectable: true,
  ...over,
});
const weekly = (over: Partial<OutlookWindow> = {}): OutlookWindow => ({
  resetsAt: NOW + 3 * DAY,
  projectable: true,
  ...over,
});

test("no projection: each window with a basis lasts, a trailing week is not projected to run out", () => {
  const o = windowOutlooks(null, NOW, session(), weekly({ resetsAt: null }));
  assert.deepEqual(o.session, { kind: "lasts", trailing: false });
  assert.deepEqual(o.weekly, { kind: "lasts", trailing: true });
  assert.equal(outlookLine(o.session, "$4.10/h"), "Lasts to reset at $4.10/h");
  assert.equal(outlookLine(o.weekly, null), "Not projected to run out");
});

test("a window with nothing to project against says so instead of 'lasts'", () => {
  const o = windowOutlooks(null, NOW, session({ projectable: false }), weekly({ projectable: false }));
  assert.equal(o.session.kind, "nothing-to-project");
  assert.equal(o.weekly.kind, "nothing-to-project");
  assert.equal(outlookLine(o.session, "$4.10/h"), "Nothing to project against");
});

test("an instant past the session's reset can only be the week's", () => {
  const at = NOW + 5 * HOUR;
  const o = windowOutlooks(at, NOW, session(), weekly());
  assert.deepEqual(o.session, { kind: "lasts", trailing: false });
  assert.deepEqual(o.weekly, {
    kind: "runs-out",
    at,
    inMs: 5 * HOUR,
    beforeResetMs: 3 * DAY - 5 * HOUR,
    certain: true,
  });
  assert.match(outlookLine(o.weekly, null) ?? "", /^Runs out ~.* \(in 5h\) — 2d 19h before reset$/);
});

test("before the session's reset with both windows projectable, it is named as either", () => {
  const at = NOW + 50 * MIN;
  const o = windowOutlooks(at, NOW, session(), weekly());
  assert.equal(o.session.kind, "runs-out");
  assert.equal(o.session.kind === "runs-out" && o.session.certain, false);
  assert.deepEqual(o.weekly, { kind: "named-in-session-line" });
  assert.equal(outlookLine(o.weekly, null), null);
  assert.match(
    outlookLine(o.session, "$4.10/h") ?? "",
    /^Session or week runs out ~.* \(in 50m\) at \$4\.10\/h — 1h 10m before this reset$/,
  );
});

test("the only projectable window owns the instant, whichever one it is", () => {
  const at = NOW + 50 * MIN;
  const sessionOnly = windowOutlooks(at, NOW, session(), weekly({ projectable: false }));
  assert.equal(sessionOnly.session.kind === "runs-out" && sessionOnly.session.certain, true);
  assert.equal(sessionOnly.weekly.kind, "nothing-to-project");

  const weeklyOnly = windowOutlooks(at, NOW, session({ projectable: false }), weekly());
  assert.equal(weeklyOnly.session.kind, "nothing-to-project");
  assert.equal(weeklyOnly.weekly.kind === "runs-out" && weeklyOnly.weekly.certain, true);
});

test("a projection equal to the reset runs out, at about the reset", () => {
  const o = windowOutlooks(NOW + 2 * HOUR, NOW, session(), weekly({ projectable: false }));
  assert.equal(o.session.kind === "runs-out" && o.session.beforeResetMs, 0);
  assert.match(outlookLine(o.session, null) ?? "", /\(in 2h\) — about when it resets$/);
  // One minute short is a margin, and is printed as one.
  const early = windowOutlooks(NOW + 2 * HOUR - MIN, NOW, session(), weekly({ projectable: false }));
  assert.match(outlookLine(early.session, null) ?? "", / — 1m before reset$/);
});

test("a projection already past is 'now', and the margin runs from now", () => {
  const o = windowOutlooks(NOW - 10 * MIN, NOW, session(), weekly({ projectable: false }));
  assert.deepEqual(o.session, {
    kind: "runs-out",
    at: NOW,
    inMs: 0,
    beforeResetMs: 2 * HOUR,
    certain: true,
  });
  assert.equal(outlookLine(o.session, "$9.00/h"), "Runs out now at $9.00/h — 2h before reset");
});

test("a window that has already reset says so, and cannot own the instant", () => {
  const reset = session({ resetsAt: NOW - MIN });
  const o = windowOutlooks(NOW + 50 * MIN, NOW, reset, weekly());
  assert.equal(o.session.kind, "reset");
  assert.equal(outlookLine(o.session, null), "Reset since this reading");
  assert.equal(o.weekly.kind === "runs-out" && o.weekly.certain, true);
  // A reset at exactly now has happened.
  assert.equal(windowOutlooks(null, NOW, session({ resetsAt: NOW }), weekly()).session.kind, "reset");
});

test("a trailing week owns an instant past the session's reset, with no margin", () => {
  const o = windowOutlooks(NOW + 30 * HOUR, NOW, session(), weekly({ resetsAt: null }));
  assert.equal(o.weekly.kind === "runs-out" && o.weekly.beforeResetMs, null);
  assert.match(outlookLine(o.weekly, null) ?? "", /^Runs out ~.* \(in 1d 6h\)$/);
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
