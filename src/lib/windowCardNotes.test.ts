import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ZERO_TOKENS } from "./pricing";
import type { UsageEntry } from "./transcripts";
import { buildSnapshot, type PlanUsage } from "./windows";
import { windowCardNotes } from "./windowCardNotes";

/**
 * The sentences under the dashboard's meters, read off the snapshot the meters
 * were built from rather than off the provider's raw reading.
 *
 * Every wrong answer here is a true-looking sentence: a closed week's Opus wall,
 * a derived reset credited to Anthropic, an Opus-only bar called the all-model
 * window. Each case builds a real snapshot, because what is pinned is that the
 * card and `buildSnapshot` agree on which readings are still in force.
 */

const HOUR = 3_600_000;
const now = Date.UTC(2026, 8, 20, 12, 0);

const entry = (ts: number, costUSD = 1): UsageEntry => ({
  key: `k${ts}`,
  requestId: `req${ts}`,
  ts,
  model: "claude-opus-5",
  tokens: { ...ZERO_TOKENS, input: 100 },
  costUSD,
  costGuardUSD: costUSD,
  project: "p",
  sessionId: "s",
  isSidechain: false,
  unpriced: false,
});

const NO_LIMITS = {
  sessionCostLimit: null,
  weeklyCostLimit: null,
  sessionTokenLimit: null,
  weeklyTokenLimit: null,
  weeklyAnchor: null,
};

const spend = [entry(now - 20 * 60_000, 2)];

describe("window card notes", () => {
  it("says nothing the snapshot dropped after a rollover", () => {
    // Fetched at 11:52 naming 11:57 for both windows, re-served at 12:00 on age
    // alone. The meters have already dropped all three readings.
    const rolledOver: PlanUsage = {
      session: { utilization: 0.88, resetsAt: now - 3 * 60_000 },
      weekly: { utilization: 0.4, resetsAt: now - 3 * 60_000 },
      scopedWeekly: [
        { label: "Opus", window: { utilization: 0.95, resetsAt: now - 3 * 60_000 } },
      ],
      fetchedAt: now - 8 * 60_000,
    };
    const snap = buildSnapshot(spend, NO_LIMITS, now, null, rolledOver);
    assert.equal(snap.weekly.fraction, null);

    const notes = windowCardNotes(snap, null);
    assert.equal(notes.modelWallLine, null);
    assert.equal(notes.sessionResetSource, "derived");

    // A pinned reset in the future is outranked by the stale provider instant
    // in `buildSnapshot`, so the card must not claim the pin either.
    const pinned = buildSnapshot(spend, NO_LIMITS, now, now + HOUR, rolledOver);
    assert.equal(windowCardNotes(pinned, now + HOUR).sessionResetSource, "derived");
  });

  it("makes no all-model claim when the provider named only a model wall", () => {
    // `five_hour` and `limits[]`, no `seven_day`: the Opus wall is the bar.
    const wallOnly: PlanUsage = {
      session: { utilization: 0.3, resetsAt: now + 2 * HOUR },
      weekly: null,
      scopedWeekly: [
        { label: "Opus", window: { utilization: 0.95, resetsAt: now + 48 * HOUR } },
      ],
      fetchedAt: now,
    };
    const snap = buildSnapshot(spend, NO_LIMITS, now, null, wallOnly);
    assert.equal(snap.weekly.fraction, 0.95);
    assert.equal(snap.weekly.planFraction, null);

    const notes = windowCardNotes(snap, null);
    assert.match(notes.modelWallLine ?? "", /Opus 95\.0%/);
    assert.doesNotMatch(notes.modelWallLine ?? "", /all-model window/);
    assert.equal(notes.sessionResetSource, "provider");
  });

  it("calls the bar the all-model window when the provider named one", () => {
    const both: PlanUsage = {
      session: null,
      weekly: { utilization: 0.25, resetsAt: now + 48 * HOUR },
      scopedWeekly: [
        { label: "Opus", window: { utilization: 0.95, resetsAt: now + 48 * HOUR } },
      ],
      fetchedAt: now,
    };
    const snap = buildSnapshot(spend, NO_LIMITS, now, null, both);
    assert.match(
      windowCardNotes(snap, null).modelWallLine ?? "",
      /The bar above is the all-model window/,
    );
  });
});
