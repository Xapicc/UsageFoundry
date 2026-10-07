import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { codexWallBoundary, parseCodexModelPage, parseCodexRateLimits } from "./codexAccount";

/**
 * The two parsers over `codex app-server`'s answers, which are the whole of
 * what this app gets wrong when the protocol moves — and both go wrong
 * quietly: a window read as 0% instead of unknown, a reset instant a thousand
 * times too early, or a hidden reviewer model offered on every Codex picker.
 *
 * The payloads are the ones measured against `codex-cli 0.153.4` on
 * 2026-10-07 with a ChatGPT team sign-in, with the account id removed.
 */

const MEASURED_RATE_LIMITS = {
  rateLimits: {
    limitId: "codex",
    limitName: null,
    primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1791414721 },
    secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1792001521 },
    credits: { hasCredits: false, unlimited: false, balance: null },
    individualLimit: null,
    spendControlReached: false,
    planType: "team",
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: "codex",
      limitName: null,
      primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1791414721 },
      secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1792001521 },
      credits: { hasCredits: false, unlimited: false, balance: null },
      individualLimit: null,
      spendControlReached: false,
      planType: "team",
      rateLimitReachedType: null,
    },
  },
  rateLimitResetCredits: { availableCount: 0, credits: [] },
  accountId: null,
  rateLimitUpsell: null,
};

describe("parseCodexRateLimits", () => {
  it("reads the measured payload, with reset instants in milliseconds", () => {
    const read = parseCodexRateLimits(MEASURED_RATE_LIMITS, 123);
    assert.deepEqual(read, {
      session: { utilization: 0, resetsAt: 1791414721000 },
      weekly: { utilization: 0, resetsAt: 1792001521000 },
      scopedWeekly: [],
      fetchedAt: 123,
      sessionMinutes: 300,
      weeklyMinutes: 10080,
      planType: "team",
      limitReached: null,
    });
  });

  it("prefers the `codex` bucket over the single-bucket view", () => {
    const payload = structuredClone(MEASURED_RATE_LIMITS);
    payload.rateLimits.primary.usedPercent = 10;
    payload.rateLimitsByLimitId.codex.primary.usedPercent = 42;
    assert.equal(parseCodexRateLimits(payload, 0)?.session?.utilization, 0.42);
  });

  it("falls back to the single-bucket view when no bucket is named", () => {
    const payload = { ...structuredClone(MEASURED_RATE_LIMITS), rateLimitsByLimitId: null };
    payload.rateLimits.secondary.usedPercent = 57.5;
    assert.equal(parseCodexRateLimits(payload, 0)?.weekly?.utilization, 0.575);
  });

  it("keeps a window over its wall rather than capping it", () => {
    const payload = structuredClone(MEASURED_RATE_LIMITS);
    payload.rateLimitsByLimitId.codex.primary.usedPercent = 104;
    payload.rateLimitsByLimitId.codex.rateLimitReachedType = "rate_limit_reached" as never;
    const read = parseCodexRateLimits(payload, 0);
    assert.equal(read?.session?.utilization, 1.04);
    assert.equal(read?.limitReached, "rate_limit_reached");
  });

  it("reads a window with no percentage as unknown, never as 0%", () => {
    const payload = structuredClone(MEASURED_RATE_LIMITS);
    (payload.rateLimitsByLimitId.codex.primary as Record<string, unknown>).usedPercent = null;
    const read = parseCodexRateLimits(payload, 0);
    assert.equal(read?.session, null);
    assert.equal(read?.sessionMinutes, null);
    assert.equal(read?.weekly?.utilization, 0);
  });

  it("keeps a reading whose reset instant is missing, with no instant", () => {
    const payload = structuredClone(MEASURED_RATE_LIMITS);
    (payload.rateLimitsByLimitId.codex.secondary as Record<string, unknown>).resetsAt = null;
    assert.deepEqual(parseCodexRateLimits(payload, 0)?.weekly, {
      utilization: 0,
      resetsAt: null,
    });
  });

  it("answers null for a payload naming no window, not an account at 0%", () => {
    assert.equal(parseCodexRateLimits(null, 0), null);
    assert.equal(parseCodexRateLimits({}, 0), null);
    assert.equal(
      parseCodexRateLimits({ rateLimits: { primary: null, secondary: null } }, 0),
      null,
    );
    assert.equal(
      parseCodexRateLimits({ rateLimits: { primary: { usedPercent: "12" } } }, 0),
      null,
    );
  });
});

describe("parseCodexModelPage", () => {
  const model = (over: Record<string, unknown>) => ({
    id: "gpt-6-astra",
    model: "gpt-6-astra",
    displayName: "GPT-6-Astra",
    hidden: false,
    isDefault: false,
    ...over,
  });

  it("keeps the slug, the display name and the CLI's default", () => {
    const page = parseCodexModelPage({
      data: [model({ isDefault: true }), model({ id: "gpt-5.6-luna", model: "gpt-5.6-luna", displayName: "GPT-5.6-Luna" })],
      nextCursor: null,
    });
    assert.deepEqual(page, {
      models: [
        { id: "gpt-6-astra", displayName: "GPT-6-Astra", isDefault: true },
        { id: "gpt-5.6-luna", displayName: "GPT-5.6-Luna", isDefault: false },
      ],
      nextCursor: null,
    });
  });

  it("drops a hidden model, which on the measured account was the CLI's own reviewer", () => {
    const page = parseCodexModelPage({
      data: [model({}), model({ id: "codex-auto-review", model: "codex-auto-review", hidden: true })],
      nextCursor: null,
    });
    assert.deepEqual(page?.models.map((m) => m.id), ["gpt-6-astra"]);
  });

  it("takes `model`, the slug `-m` takes, over the picker id when they part", () => {
    const page = parseCodexModelPage({
      data: [model({ id: "gpt-6-astra-high", model: "gpt-6-astra" })],
      nextCursor: null,
    });
    assert.equal(page?.models[0].id, "gpt-6-astra");
  });

  it("carries the cursor of a listing that continues", () => {
    assert.equal(parseCodexModelPage({ data: [], nextCursor: "abc" })?.nextCursor, "abc");
    assert.equal(parseCodexModelPage({ data: [], nextCursor: "" })?.nextCursor, null);
  });

  it("refuses a body with no list rather than reading it as no models", () => {
    assert.equal(parseCodexModelPage(null), null);
    assert.equal(parseCodexModelPage({ models: [] }), null);
  });
});

/**
 * When a Codex run parked at its usage limit wakes. Waking at the session
 * reset with the week still full is a second refusal and a spent wait; a
 * boundary in the past would wake it at once into the same wall.
 */
describe("codexWallBoundary", () => {
  const NOW = 1_000_000;
  const plan = (session: [number, number] | null, weekly: [number, number] | null) => ({
    session: session ? { utilization: session[0], resetsAt: session[1] } : null,
    weekly: weekly ? { utilization: weekly[0], resetsAt: weekly[1] } : null,
    scopedWeekly: [],
    fetchedAt: NOW,
    sessionMinutes: 300,
    weeklyMinutes: 10_080,
    planType: "team",
    limitReached: "rate_limit_reached",
  });

  it("waits for the full window's reset", () => {
    assert.equal(codexWallBoundary(plan([1, NOW + 100], [0.4, NOW + 9_000]), NOW), NOW + 100);
    assert.equal(codexWallBoundary(plan([0.3, NOW + 100], [1.02, NOW + 9_000]), NOW), NOW + 9_000);
  });

  it("waits for the later reset when both windows are full", () => {
    assert.equal(codexWallBoundary(plan([1, NOW + 100], [1, NOW + 9_000]), NOW), NOW + 9_000);
  });

  it("falls back to the session reset when the reading shows nothing full yet", () => {
    assert.equal(codexWallBoundary(plan([0.97, NOW + 100], [0.5, NOW + 9_000]), NOW), NOW + 100);
  });

  it("answers null with no reading or no reset still ahead, for the ladder to decide", () => {
    assert.equal(codexWallBoundary(null, NOW), null);
    assert.equal(codexWallBoundary(plan([1, NOW - 5], null), NOW), null);
    assert.equal(codexWallBoundary(plan(null, null), NOW), null);
  });
});
