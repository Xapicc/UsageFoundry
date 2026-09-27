import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { measureCeilings } from "./calibration";
import { ZERO_TOKENS } from "./pricing";
import type { UsageEntry } from "./transcripts";
import type { PlanUsage } from "./windows";

/**
 * The "Measured" ceiling Settings offers, which divides local spend by the
 * provider's percentage. A wrong one is a plausible dollar figure an operator
 * saves, and every meter and guard is then measured against it whenever the
 * provider's reading is unavailable.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.UTC(2026, 8, 20, 12, 0);

const entry = (ts: number, costUSD: number): UsageEntry => ({
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

describe("measureCeilings", () => {
  it("measures nothing from a reading whose windows have rolled over", () => {
    // Both instants passed three minutes ago and the cache still serves the
    // reading. The old formula divided the new window's $2 by the closed
    // window's 88% and suggested a $2.27 session ceiling after an $80 block.
    const rolledOver: PlanUsage = {
      session: { utilization: 0.88, resetsAt: now - 3 * 60_000 },
      weekly: { utilization: 0.7, resetsAt: now - 3 * 60_000 },
      scopedWeekly: [],
      fetchedAt: now - 8 * 60_000,
    };
    const entries = [
      entry(now - 4 * HOUR, 80),
      entry(now - 2 * DAY, 300),
      entry(now - 60_000, 2),
    ];
    const measured = measureCeilings(entries, rolledOver, now);
    assert.equal(measured.session, null);
    assert.equal(measured.weekly, null);
  });

  it("counts only the spend the reading had seen when it was taken", () => {
    // Fetched 50 minutes ago at 50%, with $100 spent by then and $100 since.
    // Dividing all $200 by 50% measured $400; the reading's own rate is $200.
    const aged: PlanUsage = {
      session: { utilization: 0.5, resetsAt: now + 2 * HOUR },
      weekly: { utilization: 0.5, resetsAt: now + 3 * DAY },
      scopedWeekly: [],
      fetchedAt: now - 50 * 60_000,
    };
    const entries = [entry(now - 2 * HOUR, 100), entry(now - 20 * 60_000, 100)];
    const measured = measureCeilings(entries, aged, now);
    assert.equal(measured.session?.ceilingUSD, 200);
    assert.equal(measured.session?.costUSD, 100);
    assert.equal(measured.weekly?.ceilingUSD, 200);
  });
});
