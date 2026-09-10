import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MAX_STALE_MS } from "./planUsage";
import {
  clearRateLimitReading,
  latestRateLimitReading,
  rateLimitReading,
  recordRateLimitReading,
} from "./rateLimitEvent";

/**
 * `planUsage.test.ts`'s grounds, one channel over, plus one this side has that
 * that side does not.
 *
 * The shape is an undocumented internal of another program, captured off a live
 * stream rather than read from any spec, and every way of getting it wrong is
 * silent and points the reassuring way: `utilization` is a 0–1 fraction here
 * and a percentage in `planUsage.ts`, so reading one as the other is a 100x
 * error in either direction; a shape change reads as an account at 0%; a
 * `status` nobody has seen, read as `allowed`, reports a *rejected* account as
 * a comfortable one.
 *
 * The one this side has on its own is **age**. `planUsage` can re-ask its
 * endpoint at any instant; this arrives only while a work cycle happens to be
 * streaming, so the store has to be able to say "nothing is known" — and the
 * arithmetic that decides when a reading has stopped being known is the kind
 * that fails by quietly keeping a stale percentage on screen.
 */

/**
 * Verbatim off Claude Code 2.1.266, one turn of a live run.
 *
 * `utilization` really is 0.15 for a window at 15%: the CLI builds
 * `unifiedWindows` out of the `anthropic-ratelimit-unified-*` response headers,
 * which carry fractions, and `resetsAt` arriving as an integer epoch second
 * rather than as the OAuth body's ISO string is the visible tell.
 */
const LIVE = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed",
    resetsAt: 1788988800,
    rateLimitType: "five_hour",
    overageStatus: "rejected",
    overageDisabledReason: "org_level_disabled",
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 0.15, resetsAt: 1788988800 },
      seven_day: { utilization: 0.06, resetsAt: 1789538400 },
    },
  },
  uuid: "e0d1f1a0-0000-4000-8000-000000000000",
  session_id: "sess-live",
};

/** Before the earlier of the two reset instants above. */
const DURING = 1788988800_000 - 60_000;

test("reads the live event as fractions, without dividing them again", () => {
  const r = rateLimitReading(LIVE, DURING);
  assert.equal(r?.status, "allowed");
  if (r?.status !== "allowed") return;

  // 15% and 6%. Not 0.15% (a percentage divided as if it were one) and not
  // 1500% (a fraction multiplied as if it were one).
  assert.equal(r.fiveHour?.utilization, 0.15);
  assert.equal(r.sevenDay?.utilization, 0.06);

  // Epoch seconds on the wire, epoch ms everywhere in this app.
  assert.equal(r.fiveHour?.resetsAt, 1788988800_000);
  assert.equal(r.sevenDay?.resetsAt, 1789538400_000);

  assert.equal(r.observedAt, DURING);
  assert.equal(r.limitingWindow, "five_hour");
  assert.equal(r.overageStatus, "rejected");
  assert.equal(r.overageDisabledReason, "org_level_disabled");
  assert.equal(r.isUsingOverage, false);
  assert.equal(r.sessionId, "sess-live");
});

test("refuses to read a percentage out of a status it does not handle", () => {
  // Declared by the pinned binary, never observed on this install. What it is
  // supposed to mean for a *reading* is the guess this refuses to make.
  const r = rateLimitReading(
    {
      ...LIVE,
      rate_limit_info: { ...LIVE.rate_limit_info, status: "allowed_warning" },
    },
    DURING,
  );

  assert.equal(r?.status, "unhandled");
  if (r?.status !== "unhandled") return;
  // The provider's word, kept whole so an operator can act on it and a later
  // build can add the branch knowing what it is answering.
  assert.equal(r.reported, "allowed_warning");
  assert.equal(r.observedAt, DURING);
  // And no percentage anywhere on it to be drawn by accident.
  assert.equal("fiveHour" in r, false);
  assert.equal("sevenDay" in r, false);
});

test("a rejected account is not read as an allowed one", () => {
  const r = rateLimitReading(
    {
      ...LIVE,
      rate_limit_info: { ...LIVE.rate_limit_info, status: "rejected" },
    },
    DURING,
  );
  assert.equal(r?.status, "unhandled");
});

test("an unreadable event is null rather than an account at 0%", () => {
  // No `rate_limit_info` at all — the shape moved under the pin.
  assert.equal(rateLimitReading({ type: "rate_limit_event" }, DURING), null);
  // Present but not an object.
  assert.equal(
    rateLimitReading({ type: "rate_limit_event", rate_limit_info: "allowed" }, DURING),
    null,
  );
  // Present, an object, no `status` — the one required field on it.
  assert.equal(
    rateLimitReading({ type: "rate_limit_event", rate_limit_info: {} }, DURING),
    null,
  );
});

test("a window that is missing or unreadable is absent, never zero", () => {
  const noWindows = rateLimitReading(
    { rate_limit_info: { status: "allowed" } },
    DURING,
  );
  assert.equal(noWindows?.status, "allowed");
  if (noWindows?.status !== "allowed") return;
  assert.equal(noWindows.fiveHour, null);
  assert.equal(noWindows.sevenDay, null);

  // The coercions that would each produce a confident 0%: `Number("")`,
  // `Number(null)` and `Number(undefined)` are 0, 0 and NaN, and only the last
  // of those fails a `Number.isFinite` test.
  for (const bad of ["", null, undefined, "0.15", {}]) {
    const r = rateLimitReading(
      {
        rate_limit_info: {
          status: "allowed",
          unifiedWindows: { five_hour: { utilization: bad, resetsAt: 1788988800 } },
        },
      },
      DURING,
    );
    assert.equal(r?.status, "allowed");
    if (r?.status !== "allowed") return;
    assert.equal(r.fiveHour, null, `utilization ${JSON.stringify(bad)}`);
  }

  // A window with a reading and no reset instant is still a reading.
  const noReset = rateLimitReading(
    {
      rate_limit_info: {
        status: "allowed",
        unifiedWindows: { five_hour: { utilization: 0.42 } },
      },
    },
    DURING,
  );
  assert.equal(noReset?.status, "allowed");
  if (noReset?.status !== "allowed") return;
  assert.deepEqual(noReset.fiveHour, { utilization: 0.42, resetsAt: null });
});

test("utilisation past the cap is kept past the cap", () => {
  // The provider's own schema says values above 1 occur. Clamping here would
  // erase the one state an operator most needs to see; the clamp belongs to
  // whatever draws a bar.
  const r = rateLimitReading(
    {
      rate_limit_info: {
        status: "allowed",
        unifiedWindows: { five_hour: { utilization: 1.4, resetsAt: 1788988800 } },
      },
    },
    DURING,
  );
  assert.equal(r?.status === "allowed" && r.fiveHour?.utilization, 1.4);
});

test("the store keeps the newest reading and forgets it when it ages out", (t) => {
  t.after(clearRateLimitReading);
  clearRateLimitReading();

  // Nothing observed is null, and every caller has to render that as "nothing
  // observed" rather than as 0%.
  assert.equal(latestRateLimitReading(DURING), null);

  const first = rateLimitReading(LIVE, DURING);
  assert.ok(first);
  recordRateLimitReading(first);

  const later = rateLimitReading(
    {
      ...LIVE,
      rate_limit_info: {
        ...LIVE.rate_limit_info,
        unifiedWindows: {
          five_hour: { utilization: 0.31, resetsAt: 1788988800 },
          seven_day: { utilization: 0.06, resetsAt: 1789538400 },
        },
      },
    },
    DURING + 1000,
  );
  assert.ok(later);
  recordRateLimitReading(later);

  // Latest-wins: a snapshot of a moving quantity, never an accumulation.
  const now = latestRateLimitReading(DURING + 2000);
  assert.equal(now?.status === "allowed" && now.fiveHour?.utilization, 0.31);

  // Exactly at the bound is still readable; a millisecond past it is not.
  assert.notEqual(latestRateLimitReading(DURING + 1000 + MAX_STALE_MS), null);
  assert.equal(latestRateLimitReading(DURING + 1001 + MAX_STALE_MS), null);
});

test("a window whose reset has passed is dropped, and the other is not", (t) => {
  t.after(clearRateLimitReading);
  clearRateLimitReading();

  const r = rateLimitReading(LIVE, DURING);
  assert.ok(r);
  recordRateLimitReading(r);

  // A minute after the 5-hour window rolled over and days before the weekly
  // one does. Reporting the closed window's 15% over a window that has spent
  // nothing is the failure this drops it to avoid.
  const after = latestRateLimitReading(1788988800_000 + 60_000);
  assert.equal(after?.status, "allowed");
  if (after?.status !== "allowed") return;
  assert.equal(after.fiveHour, null);
  assert.equal(after.sevenDay?.utilization, 0.06);

  // The observation instant is untouched by the drop: what aged is the window,
  // not the fact that this was seen when it was seen.
  assert.equal(after.observedAt, DURING);
});

test("an unhandled status ages out on the same clock and keeps its word", (t) => {
  t.after(clearRateLimitReading);
  clearRateLimitReading();

  const r = rateLimitReading(
    { rate_limit_info: { status: "something_new" }, session_id: "s" },
    DURING,
  );
  assert.ok(r);
  recordRateLimitReading(r);

  const held = latestRateLimitReading(DURING + 1000);
  assert.equal(held?.status === "unhandled" && held.reported, "something_new");
  assert.equal(latestRateLimitReading(DURING + 1 + MAX_STALE_MS), null);
});
