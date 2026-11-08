/**
 * When the container's stored claude.ai sign-in ends, and what to say about it.
 *
 * Pure and free of Node imports so the Settings panel (a client file) and the
 * dashboard notice (built server-side in `claudeAuth.ts`) read the same date the
 * same way. The date itself is `loginExpiresAt` in `claude auth status --json`,
 * which the CLI takes from the stored OAuth credential's refresh-token expiry:
 * after it, the CLI cannot renew the short-lived access token and every cycle
 * stops authenticating, with nobody at a terminal to see the CLI's own warning.
 */

const DAY_MS = 86_400_000;

/**
 * How far ahead a warning starts. The CLI starts its own `claude -p` stderr
 * warning at the same distance from this same date, so the two agree on what
 * "soon" means; this app's reason to match is that the stderr one never reaches
 * a run that reads stream-json.
 */
export const LOGIN_EXPIRY_WARN_DAYS = 10;

/**
 * How much sooner than the reported date the sign-in may end.
 *
 * The pinned CLI words its own warning as a window — "between <date − 3 days>
 * and <date>" — rather than as one day, so the reported date is the *latest* end.
 * Read from the shipped binary's code (2.1.319), not observed to end early.
 */
export const LOGIN_EXPIRY_WINDOW_DAYS = 3;

export type LoginExpiryState = "ok" | "soon" | "ended";

export interface LoginExpiry {
  state: LoginExpiryState;
  /** Epoch ms of the reported end. */
  endsAt: number;
  /** Whole days left, rounded up, as the CLI's own warning counts them; 0 once ended. */
  daysLeft: number;
}

/**
 * The state of a reported end date, or null when the CLI reported none.
 *
 * Null is "unknown" and renders as nothing: the field is absent for an API key,
 * a helper, `CLAUDE_CODE_OAUTH_TOKEN` and a signed-out container, none of which
 * is a fault. The boundary is inclusive — exactly ten days out already warns —
 * and an end date at or before now is `ended`, not a negative number of days.
 */
export function loginExpiry(endsAt: number | null, now: number): LoginExpiry | null {
  if (endsAt === null) return null;
  const msLeft = endsAt - now;
  if (msLeft <= 0) return { state: "ended", endsAt, daysLeft: 0 };
  const daysLeft = Math.ceil(msLeft / DAY_MS);
  return {
    state: msLeft <= LOGIN_EXPIRY_WARN_DAYS * DAY_MS ? "soon" : "ok",
    endsAt,
    daysLeft,
  };
}

/**
 * The end date as `YYYY-MM-DD` in UTC.
 *
 * UTC rather than the reader's zone because the dashboard sentence is written
 * on the server and the Settings panel in a browser; one unambiguous date is
 * the same words in both.
 */
function utcDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** "ends 2026-12-08, in 30 days" or "ended 2026-11-06" — what the Settings panel shows. */
export function loginExpiryText(e: LoginExpiry): string {
  if (e.state === "ended") return `ended ${utcDate(e.endsAt)}`;
  return `ends ${utcDate(e.endsAt)}, in ${e.daysLeft} ${e.daysLeft === 1 ? "day" : "days"}`;
}

/**
 * The dashboard sentence for a sign-in that is ending or has ended, or null when
 * there is nothing to say. It follows a bold name, as a `ConfigProblem` message
 * does, and says what happens rather than how to fix it beyond where to go:
 * renewing is not something this app does.
 */
export function loginExpiryMessage(e: LoginExpiry): string | null {
  if (e.state === "ok") return null;
  if (e.state === "ended") {
    return (
      `sign-in ended ${utcDate(e.endsAt)} or up to ${LOGIN_EXPIRY_WINDOW_DAYS} days before, ` +
      `so runs stop authenticating once the CLI can no longer renew it. ` +
      `Sign out and back in under Settings.`
    );
  }
  return (
    `sign-in ends ${utcDate(e.endsAt)} (in ${e.daysLeft} ${e.daysLeft === 1 ? "day" : "days"}), ` +
    `possibly up to ${LOGIN_EXPIRY_WINDOW_DAYS} days sooner; after that runs stop authenticating. ` +
    `Sign out and back in under Settings.`
  );
}
