import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { CodexPlanUsage } from "./codexAccount";
import { REFRESH_MS } from "./planUsage";
import { usageRemaining, type RemainingInputs } from "./usageRemaining";
import type { PlanUsage } from "./windows";

/**
 * The toolbar's readout, from the two provider caches. Three ways to get it
 * wrong quietly: a provider that is not signed in drawn as one that is; a
 * window with no current reading drawn as a number, which at 0 reads "plenty
 * left" and at 100 reads "spent"; and a reading the provider stopped refreshing
 * presented as current.
 */

const NOW = 1_791_400_000_000;
const HOUR = 3_600_000;

function claudePlan(overrides: Partial<PlanUsage> = {}): PlanUsage {
  return {
    session: { utilization: 0.28, resetsAt: NOW + 2 * HOUR },
    weekly: { utilization: 0.06, resetsAt: NOW + 3 * 24 * HOUR },
    scopedWeekly: [],
    fetchedAt: NOW - 60_000,
    ...overrides,
  };
}

function codexPlan(overrides: Partial<CodexPlanUsage> = {}): CodexPlanUsage {
  return {
    session: { utilization: 0.4, resetsAt: NOW + 3 * HOUR },
    weekly: { utilization: 0.12, resetsAt: NOW + 5 * 24 * HOUR },
    scopedWeekly: [],
    fetchedAt: NOW - 60_000,
    sessionMinutes: 300,
    weeklyMinutes: 10_080,
    planType: "plus",
    limitReached: null,
    ...overrides,
  };
}

function inputs(overrides: Partial<RemainingInputs> = {}): RemainingInputs {
  return {
    claude: { signedIn: true, plan: claudePlan(), readingsOff: false },
    codex: { signedIn: true, plan: codexPlan() },
    ...overrides,
  };
}

test("lists only the providers with a stored sign-in, Claude first", () => {
  assert.deepEqual(
    usageRemaining(inputs(), NOW).providers.map((p) => p.provider),
    ["claude", "codex"],
  );
  assert.deepEqual(
    usageRemaining(
      inputs({ claude: { signedIn: false, plan: claudePlan(), readingsOff: false } }),
      NOW,
    ).providers.map((p) => p.provider),
    ["codex"],
  );
  assert.deepEqual(
    usageRemaining(
      inputs({ codex: { signedIn: false, plan: codexPlan() } }),
      NOW,
    ).providers.map((p) => p.provider),
    ["claude"],
  );
  assert.deepEqual(
    usageRemaining(
      {
        claude: { signedIn: false, plan: null, readingsOff: false },
        codex: { signedIn: false, plan: null },
      },
      NOW,
    ).providers,
    [],
  );
});

test("passes the used fraction through and names the Claude windows by their lengths", () => {
  const claude = usageRemaining(inputs(), NOW).providers[0];
  assert.deepEqual(
    claude.windows.map((w) => [w.slot, w.minutes, w.used]),
    [
      ["session", 300, 0.28],
      ["weekly", 10_080, 0.06],
    ],
  );
  assert.equal(claude.windows[0].resetsAt, NOW + 2 * HOUR);
  assert.equal(claude.stale, false);
  assert.equal(claude.note, null);
});

test("does not cap a window that is over its wall", () => {
  const claude = usageRemaining(
    inputs({
      claude: {
        signedIn: true,
        plan: claudePlan({ session: { utilization: 1.04, resetsAt: NOW + HOUR } }),
        readingsOff: false,
      },
    }),
    NOW,
  ).providers[0];
  assert.equal(claude.windows[0].used, 1.04);
});

test("a Claude window whose reset has passed is unknown, never its old figure", () => {
  const claude = usageRemaining(
    inputs({
      claude: {
        signedIn: true,
        plan: claudePlan({
          session: { utilization: 0.95, resetsAt: NOW - 60_000 },
          weekly: { utilization: 0.9, resetsAt: NOW - 60_000 },
        }),
        readingsOff: false,
      },
    }),
    NOW,
  ).providers[0];
  assert.deepEqual(
    claude.windows.map((w) => w.used),
    [null, null],
  );
  assert.equal(claude.stale, false, "nothing is shown, so nothing is old");
  assert.match(claude.note ?? "", /No current reading/);
});

test("signed in with no reading is unknown in both windows, and says why", () => {
  const off = usageRemaining(
    inputs({ claude: { signedIn: true, plan: null, readingsOff: true } }),
    NOW,
  ).providers[0];
  assert.deepEqual(
    off.windows.map((w) => w.used),
    [null, null],
  );
  assert.equal(off.fetchedAt, null);
  assert.match(off.note ?? "", /switched off in Settings/);

  const missing = usageRemaining(
    inputs({ claude: { signedIn: true, plan: null, readingsOff: false } }),
    NOW,
  ).providers[0];
  assert.match(missing.note ?? "", /No current reading from Anthropic/);

  const codex = usageRemaining(
    inputs({ codex: { signedIn: true, plan: null } }),
    NOW,
  ).providers[1];
  assert.deepEqual(
    codex.windows.map((w) => [w.used, w.minutes]),
    [
      [null, null],
      [null, null],
    ],
  );
  assert.match(codex.note ?? "", /No current reading from Codex/);
});

test("one window the provider did not name is unknown while the other stands", () => {
  const claude = usageRemaining(
    inputs({
      claude: {
        signedIn: true,
        plan: claudePlan({ weekly: null }),
        readingsOff: false,
      },
    }),
    NOW,
  ).providers[0];
  assert.equal(claude.windows[0].used, 0.28);
  assert.equal(claude.windows[1].used, null);
  assert.equal(claude.note, null, "one reading is enough to not be a failure");
});

test("a reading older than one refresh is stale, and exactly one refresh is not", () => {
  const at = (age: number) =>
    usageRemaining(
      inputs({
        claude: {
          signedIn: true,
          plan: claudePlan({ fetchedAt: NOW - age }),
          readingsOff: false,
        },
      }),
      NOW,
    ).providers[0];
  assert.equal(at(REFRESH_MS).stale, false);
  assert.equal(at(REFRESH_MS + 1).stale, true);
  assert.equal(at(REFRESH_MS + 1).fetchedAt, NOW - REFRESH_MS - 1);
});

test("Codex windows carry their own lengths and are judged by their own resets", () => {
  // A 24-hour primary window with 20 hours to run. The five-hour test
  // `currentPlanReading` applies to Claude's session would call this closed.
  const codex = usageRemaining(
    inputs({
      codex: {
        signedIn: true,
        plan: codexPlan({
          sessionMinutes: 1_440,
          session: { utilization: 0.5, resetsAt: NOW + 20 * HOUR },
        }),
      },
    }),
    NOW,
  ).providers[1];
  assert.deepEqual(
    codex.windows.map((w) => [w.minutes, w.used]),
    [
      [1_440, 0.5],
      [10_080, 0.12],
    ],
  );

  const closed = usageRemaining(
    inputs({
      codex: {
        signedIn: true,
        plan: codexPlan({ session: { utilization: 0.5, resetsAt: NOW - 1 } }),
      },
    }),
    NOW,
  ).providers[1];
  assert.equal(closed.windows[0].used, null);
  assert.equal(closed.windows[1].used, 0.12);
});

test("Codex's own word for a hit wall is carried, and Claude's is always null", () => {
  const out = usageRemaining(
    inputs({ codex: { signedIn: true, plan: codexPlan({ limitReached: "primary" }) } }),
    NOW,
  );
  assert.equal(out.providers[1].limitReached, "primary");
  assert.equal(out.providers[0].limitReached, null);
});
