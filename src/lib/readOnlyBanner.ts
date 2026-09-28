import type { JsonResult } from "./jsonRequest";

/**
 * The fields of the health body the banner reads. The rest of the body is the
 * route's: this decides what the page shows, and it reads nothing it would not
 * render.
 */
type HealthChecks = { database?: unknown; databaseError?: unknown };

/**
 * The banner a server that cannot write puts above every page, as a decision
 * rather than a line in `ReadOnlyNotice`.
 *
 * The line there was `res.ok ? null : res.error`, and it failed in both
 * directions at once, because `jsonRequest` folds a failure into the one field
 * the notice read and nothing else:
 *
 *  - a fetch that never reached the server comes back `status: null` with the
 *    transport's own words in `error` — "Failed to fetch" in Chrome, "Load
 *    failed" in Safari, "fetch failed" in Node — and the notice rendered
 *    them. A server restart or a proxy blip therefore put a warning banner
 *    above every page for the length of a poll interval, and a banner that
 *    appears and disappears with the network trains the eye to skip the one
 *    that means something. This shows nothing for it.
 *
 *  - the server that most needs the banner is the one whose database it cannot
 *    write: the health route answers 503 for that with the failure in
 *    `checks.databaseError` and **no** top-level `error` at all — the field
 *    every route uses to explain a refusal — so `res.error` was null and the
 *    page that cannot write showed nothing. `jsonRequest` now keeps the
 *    parsed body on the failure, and this reads the sentence off
 *    `checks.databaseError` when `checks.database` is `"error"`.
 *
 * Everything else keeps what the notice showed: a healthy 200 shows nothing,
 * a refusal the server explained in `error` shows in its own words, and a 503
 * whose body a proxy replaced with something that will not parse shows
 * nothing, because it is the proxy speaking rather than the server.
 */
export function readOnlyBanner(result: JsonResult<unknown>): string | null {
  if (result.ok) return null;

  // `status: null` is nobody answered. `error` there is the transport's own
  // words, and the banner is standing context about the server rather than a
  // reading of the network: a dropped fetch must not put it above every page.
  if (result.status === null) return null;

  // The one 503 whose sentence is not in `error`. `checks.database` is the
  // check `healthReport` fails the probe on, and `databaseError` is the
  // sentence written next to it. When the body carries both, it outranks
  // `error`, because the banner is the thing a server that cannot write puts
  // above every page.
  if (result.status === 503) {
    const checks = reportedChecks(result.body);
    if (
      checks !== null &&
      checks.database === "error" &&
      typeof checks.databaseError === "string" &&
      checks.databaseError !== ""
    ) {
      return checks.databaseError;
    }
  }

  // A refusal the server explained in `error` renders in its own words. A 503
  // with no parseable body carries neither and shows nothing: it is the
  // proxy's answer, and the server said no such thing.
  return result.error;
}

/**
 * The checks a health answer reported, or null when the body is not one.
 *
 * The cast is the narrowing: what follows reads only the two fields the banner
 * renders, and each is checked against its literal before use, so the shape of
 * the rest of the body is irrelevant.
 */
function reportedChecks(body: unknown): HealthChecks | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  // `body` is `unknown`; there is no other door to its `checks` field.
  const checks = (body as { checks?: unknown }).checks;
  if (typeof checks !== "object" || checks === null || Array.isArray(checks)) return null;
  return checks as HealthChecks;
}
