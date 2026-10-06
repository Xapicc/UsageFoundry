import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";

/**
 * The gate's bearer branch, as a guess at the master token.
 *
 * `/api/login` was given a budget so that `UF_AUTH_TOKEN` could not be guessed
 * at the rate of the event loop, and its locked answer is the same whether the
 * token is right or wrong so it cannot be used as an oracle. Every other route
 * accepted the same secret as `Authorization: Bearer` with no budget at all,
 * answering a wrong one 401 and letting the right one through — the oracle the
 * limiter's own rule forbids, on every route in the app, while sign-in sat
 * locked. Nothing about that throws or fails to typecheck: an unbounded gate
 * looks exactly like a bounded one until somebody counts.
 *
 * The clock is replaced for the whole file rather than per case, because the
 * budget is module state that only time clears: each case starts by winding
 * past anything the one before it left standing.
 */

const TOKEN = "0123456789abcdef0123456789abcdef";

let middleware: typeof import("./middleware");
let limiter: typeof import("./lib/loginLimiter");
let sessionToken: typeof import("./lib/sessionToken");

const realNow = Date.now;
let clock = realNow();

before(async () => {
  process.env.UF_AUTH_TOKEN = TOKEN;
  Date.now = () => clock;
  middleware = await import("./middleware");
  limiter = await import("./lib/loginLimiter");
  sessionToken = await import("./lib/sessionToken");
});

after(() => {
  Date.now = realNow;
  delete process.env.UF_AUTH_TOKEN;
});

/** Past every lock and every window the previous case could have left. */
function startClean() {
  clock += limiter.DEFAULT_LIMITER.windowMs + limiter.DEFAULT_LIMITER.globalLockoutMs + 1;
}

const gate = (headers: Record<string, string>, path = "/api/runs") =>
  middleware.middleware(new NextRequest(`http://localhost${path}`, { headers }));

const bearer = (value: string, path?: string) => gate({ authorization: `Bearer ${value}` }, path);

const letThrough = (res: Response) => res.headers.get("x-middleware-next") === "1";

async function answers(responses: Response[]) {
  const statuses = new Map<number, number>();
  for (const r of responses) {
    statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
    // Locked or wrong, the body is the same — the oracle rule, as on sign-in.
    assert.deepEqual(await r.json(), { error: "Unauthorized" });
  }
  return { compared: statuses.get(401) ?? 0, refused: statuses.get(429) ?? 0 };
}

test("wrong bearers past the budget are refused, and the right one is refused with them", async () => {
  startClean();
  const { maxGlobalFailures, globalLockoutMs } = limiter.DEFAULT_LIMITER;
  const burst = 2_000;

  const { compared, refused } = await answers(
    await Promise.all(
      Array.from({ length: burst }, (_, i) => bearer(`guess-${i}`.padEnd(TOKEN.length, "x"))),
    ),
  );
  assert.equal(compared, maxGlobalFailures);
  assert.equal(refused, burst - maxGlobalFailures);

  // The oracle half: inside the lock the right token gets the wrong token's
  // answer, header for header.
  const right = await bearer(TOKEN);
  const wrong = await bearer("f".repeat(TOKEN.length));
  assert.equal(letThrough(right), false, "the right bearer must not be let through while locked");
  assert.equal(right.status, 429);
  assert.equal(right.status, wrong.status);
  assert.equal(right.headers.get("retry-after"), wrong.headers.get("retry-after"));
  assert.deepEqual(await right.json(), await wrong.json());

  // A page path gets what a page path gets for a wrong bearer: the sign-in page.
  const page = await bearer(TOKEN, "/runs");
  assert.equal(page.status, 307);
  assert.match(page.headers.get("location") ?? "", /\/login$/);

  // And the lock lifts, rather than leaving scripts out for good.
  clock += globalLockoutMs + 1;
  assert.equal(letThrough(await bearer(TOKEN)), true);
});

test("a session cookie still opens the gate while bearers are locked out", async () => {
  startClean();
  for (let i = 0; i < limiter.DEFAULT_LIMITER.maxGlobalFailures; i++) {
    await bearer(`wrong-${i}`);
  }
  assert.equal((await bearer(TOKEN)).status, 429);

  // The cookie is checked first and is not a guess at anything: a lock that
  // anybody can trip must not reach the operator's browser.
  const cookie = await sessionToken.mintSessionCookie(
    sessionToken.newSessionId(),
    Date.now() + sessionToken.SESSION_TTL_MS,
    TOKEN,
  );
  assert.equal(letThrough(await gate({ cookie: `${sessionToken.SESSION_COOKIE}=${cookie}` })), true);
});

test("the right bearer does not refill the budget", async () => {
  startClean();
  const { maxGlobalFailures } = limiter.DEFAULT_LIMITER;
  for (let i = 0; i < maxGlobalFailures - 1; i++) {
    assert.equal((await bearer(`wrong-${i}`)).status, 401);
  }
  // A script polling with the real token would otherwise reset the count
  // between every pair of guesses, and the budget would bound nothing.
  assert.equal(letThrough(await bearer(TOKEN)), true);
  assert.equal((await bearer("last-wrong")).status, 401);
  assert.equal((await bearer("one-too-many")).status, 429);
});
