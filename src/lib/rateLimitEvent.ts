import { MAX_STALE_MS } from "./planUsage";

/**
 * The provider's own utilisation reading, off the `stream-json` stream.
 *
 * Claude Code emits a top-level `rate_limit_event` while a cycle runs. It is
 * the only place in this app where the two subscription windows arrive as a
 * *fact from the provider on the same connection the work is going over*,
 * rather than as this app's arithmetic over local transcripts or as a separate
 * poll of an HTTP endpoint. Measured against Claude Code 2.1.266:
 *
 *     {"type":"rate_limit_event",
 *      "rate_limit_info":{
 *        "status":"allowed","resetsAt":1788988800,"rateLimitType":"five_hour",
 *        "overageStatus":"rejected","overageDisabledReason":"org_level_disabled",
 *        "isUsingOverage":false,
 *        "unifiedWindows":{
 *          "five_hour":{"utilization":0.15,"resetsAt":1788988800},
 *          "seven_day":{"utilization":0.06,"resetsAt":1789538400}}},
 *      "uuid":"...","session_id":"..."}
 *
 * Four things about it decide the whole of this module, and each of them is a
 * decision that could have gone the other way.
 *
 * **1. It does not outrank anything.** `metering.md` already settles an
 * ordering — `WindowState.fraction` prefers `planUsage.ts`'s percentage, then a
 * cost ceiling, then tokens — and this is a *third* source arriving on a fourth
 * channel. It is never merged into that ordering, never averaged with it and
 * never substituted for it: it is drawn beside the meters with its own label
 * and its own observation instant. Two provider-supplied readings that disagree
 * are worth seeing disagree; one silently overwritten by the other is not, and
 * an operator reconciling this app against `claude /usage` has to be able to
 * tell which figure came from where.
 *
 * **2. No guard reads it, and nothing here is exported in a shape a guard could
 * take.** A guard acting on this behaves differently in kind from one acting on
 * `planUsage`: that figure can be *recomputed on demand* at any instant, and
 * this one exists only if a cycle happened to be streaming recently enough to
 * have produced it. The binary's own schema says the field is "absent until the
 * first response carrying these headers is observed, and always absent for
 * API-key, Bedrock, and Vertex sessions" — so on a perfectly healthy install
 * this is legitimately null forever, and a guard reading null as 0% would run
 * an account straight through its ceiling. `evaluateBudget` has no argument
 * that could carry this and must not gain one; the reading reaches `/api/usage`
 * as its own key and reaches `buildSnapshot` nowhere.
 *
 * **3. It is a utilisation reading and not a cost source.** Nothing here is
 * money or tokens, so nothing here may be summed with the transcript meters,
 * with `runs.spent_usd` or with telemetry — the rule `repoSpend` and `install`
 * are both held to. It gets this module and one install-wide slot rather than a
 * column on an existing cost source, because a column on a cost table is an
 * invitation to add it to something.
 *
 * **4. `status` is a set and only one member has been seen.** The pinned
 * binary declares `["allowed","allowed_warning","rejected"]`, but only
 * `allowed` has been observed on the wire here, and what the other two are
 * *supposed to mean for a reading* is a guess. So only `allowed` yields a
 * utilisation reading. Anything else — including a member of that declared set
 * — is kept verbatim as an `unhandled` reading, logged, filed to `ops_events`
 * and drawn on the dashboard as an unhandled status. It is never coerced into a
 * percentage, and it never silently replaces the last good reading with
 * nothing.
 *
 * **`utilization` here is a 0–1 fraction, and in `planUsage.ts` it is a
 * percentage.** They are not the same field read twice. The binary builds
 * `unifiedWindows` out of the `anthropic-ratelimit-unified-*` **response
 * headers** — its own schema note says so, and `resetsAt` arriving as an
 * integer epoch *second* rather than as the OAuth body's ISO string is the
 * visible tell — while `GET /api/oauth/usage` answers with percent, which is
 * why `parsePlanUsage` divides by 100 and nothing here does. Reading one as the
 * other is a 100x error in the one number this exists to get right.
 */

/** One window as `rate_limit_event` reports it. */
export interface RateLimitWindow {
  /**
   * Fraction of the window consumed, and **not clamped to 1**.
   *
   * The provider's own schema says values above 1 occur where usage has run
   * past a window's cap. Clamping on the way in would erase the one state an
   * operator most needs to see, so the clamp belongs to whatever draws a bar.
   */
  utilization: number;
  /** Epoch **ms** at which the window resets, or null when none was named. */
  resetsAt: number | null;
}

/**
 * What the last `rate_limit_event` said, as this build is willing to read it.
 *
 * A discriminated union rather than an object with an optional everything: an
 * unhandled status has no windows by construction, and the surface must not be
 * able to draw a meter off one by forgetting to check a boolean first.
 */
export type RateLimitReading =
  | {
      status: "allowed";
      /**
       * Epoch ms on *this* clock, taken when the line was parsed.
       *
       * The event carries no timestamp of its own. This is the only instant
       * that says how old the reading is, and the reading is meaningless
       * without it — a window at 15% twenty minutes ago and one at 15% now are
       * not the same fact.
       */
      observedAt: number;
      fiveHour: RateLimitWindow | null;
      sevenDay: RateLimitWindow | null;
      /**
       * `rateLimitType`, verbatim — which window the provider says is the
       * binding one. Kept as a string rather than narrowed to a union: the
       * declared set has six members, four of them never seen here, and a
       * value this app only ever prints does not earn a type that would refuse
       * a seventh.
       */
      limitingWindow: string | null;
      /**
       * Whether the account is on overage and whether overage is available at
       * all, verbatim in the provider's own words.
       *
       * Not reduced to a boolean: `overageStatus` is its own three-member set
       * and `overageDisabledReason` is a thirteen-member one, and "unavailable
       * because the organisation disabled it" and "unavailable because it is
       * spent" are different facts to whoever has to act on them.
       */
      overageStatus: string | null;
      overageDisabledReason: string | null;
      isUsingOverage: boolean;
      /** The session the event arrived on, for reconciling against a run. */
      sessionId: string | null;
    }
  | {
      /** A `status` this build has no branch for. See decision 4 above. */
      status: "unhandled";
      observedAt: number;
      /** The provider's word for it, unaltered. */
      reported: string;
      sessionId: string | null;
    };

/** Epoch seconds as the event carries them, to epoch ms as this app holds them. */
function resetInstant(raw: unknown): number | null {
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds * 1000);
}

/** One `unifiedWindows` member, or null when it is absent or unreadable. */
function windowOf(windows: Record<string, unknown>, key: string): RateLimitWindow | null {
  const w = windows[key] as Record<string, unknown> | undefined;
  if (w === null || typeof w !== "object") return null;
  // `typeof` rather than `Number`, which is the leniency `toolProgressReading`
  // allows itself and this must not: there the coerced value only dates a row
  // on a strip, and here `Number("")` is 0 and 0% is the exact reading this
  // whole module exists to keep off the screen.
  if (typeof w.utilization !== "number" || !Number.isFinite(w.utilization)) {
    return null;
  }
  return { utilization: w.utilization, resetsAt: resetInstant(w.resetsAt) };
}

/**
 * Read one `rate_limit_event` line.
 *
 * Pure and exported for its test, on the bar every parser here is held to:
 * every way of getting this wrong is silent. A fraction read as a percentage
 * reports an account at 15% of its window as being at 0.15% of it, an absent
 * `unifiedWindows` read leniently reports it at 0%, and a status nobody has
 * seen read as `allowed` reports a *rejected* account as a comfortable one.
 *
 * Null means "this is not a readable `rate_limit_event`" — no
 * `rate_limit_info`, or no `status` on it — and the caller says so out loud
 * rather than treating it as an absence of usage.
 */
export function rateLimitReading(
  ev: Record<string, unknown>,
  now: number,
): RateLimitReading | null {
  const info = ev.rate_limit_info as Record<string, unknown> | undefined;
  if (info === null || typeof info !== "object") return null;

  const sessionId = typeof ev.session_id === "string" && ev.session_id ? ev.session_id : null;
  const status = typeof info.status === "string" ? info.status : "";
  if (!status) return null;
  if (status !== "allowed") {
    return { status: "unhandled", observedAt: now, reported: status, sessionId };
  }

  const windows = (info.unifiedWindows ?? {}) as Record<string, unknown>;
  return {
    status: "allowed",
    observedAt: now,
    // `seven_day_overage_included` is a third member of `unifiedWindows` on
    // accounts whose responses carry it. Deliberately not read: it has never
    // been observed here, this app has no per-model weekly wall on this
    // channel to put it beside, and a window drawn from a shape nobody has
    // seen is a guess with a percentage on it.
    fiveHour: windowOf(windows, "five_hour"),
    sevenDay: windowOf(windows, "seven_day"),
    // The top-level `resetsAt` beside it is the same instant as the named
    // window's and is not carried twice.
    limitingWindow: typeof info.rateLimitType === "string" ? info.rateLimitType : null,
    overageStatus: typeof info.overageStatus === "string" ? info.overageStatus : null,
    overageDisabledReason:
      typeof info.overageDisabledReason === "string" ? info.overageDisabledReason : null,
    isUsingOverage: info.isUsingOverage === true,
    sessionId,
  };
}

/**
 * The last reading any cycle on this install produced.
 *
 * One slot rather than one per run, because the fact is the *account's*: every
 * run on this box streams over the same credential, so the newest observation
 * from any of them is the newest thing known about the windows all of them
 * share. Latest-wins for the same reason — this is a snapshot of a moving
 * quantity, never an accumulation, so there is nothing here to sum and nothing
 * to lose by overwriting.
 *
 * Held in memory rather than in a table, which is `liveTools`' trade and for a
 * sharper version of its reason. A row would outlive the boot, and a persisted
 * utilisation reading is a thing a later reader treats as current: the failure
 * mode of this feature is a stale percentage read as a live one, and a store
 * that cannot hold one for longer than a process lifetime cannot produce that
 * failure. It also keeps the reading out of `retention.ts` entirely — nothing
 * expires because nothing was written.
 *
 * `globalThis`-pinned under its own key, for the reason every long-lived
 * singleton here is: module state resets on every request under `next dev`.
 */
const latest = ((globalThis as unknown as {
  __ufRateLimitReadingV1?: { current: RateLimitReading | null };
}).__ufRateLimitReadingV1 ??= { current: null });

/** Keep the newest reading. */
export function recordRateLimitReading(reading: RateLimitReading): void {
  latest.current = reading;
}

/**
 * The newest reading still worth showing, or null.
 *
 * **Null is "nothing has been observed", and every caller must render it as
 * that rather than as 0% or as "fine".** There are three ordinary ways to get
 * here with nothing: no cycle has run since this process started; the account
 * authenticates in a way that carries no such headers at all; or the windows
 * have not moved, because the CLI emits this when a rounded percentage or a
 * reset instant *changes* rather than on a fixed cadence.
 *
 * Two things are dropped, both of them because the alternative is a figure that
 * reads as current and is not:
 *
 *  - A reading older than `MAX_STALE_MS`. That constant is `planUsage.ts`'s and
 *    the argument transfers word for word — a window can go from empty to full
 *    in well under an hour — so the two provider readings on this page age out
 *    together rather than one outliving the other on screen.
 *  - A window whose own reset instant has passed. `buildSnapshot` does exactly
 *    this to a `planUsage` window, and here it matters more: the minutes after
 *    a rollover would otherwise print a closed window's utilisation over a
 *    window that has spent nothing.
 */
export function latestRateLimitReading(now = Date.now()): RateLimitReading | null {
  const reading = latest.current;
  if (reading === null) return null;
  if (now - reading.observedAt > MAX_STALE_MS) return null;
  if (reading.status !== "allowed") return reading;
  return {
    ...reading,
    fiveHour: liveWindow(reading.fiveHour, now),
    sevenDay: liveWindow(reading.sevenDay, now),
  };
}

function liveWindow(w: RateLimitWindow | null, now: number): RateLimitWindow | null {
  if (w === null) return null;
  return w.resetsAt !== null && w.resetsAt <= now ? null : w;
}

/** Forget everything. For tests, and for nothing else. */
export function clearRateLimitReading(): void {
  latest.current = null;
}
