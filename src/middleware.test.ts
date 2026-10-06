import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { NextRequest } from "next/server";

/**
 * The edge gate, against the two silent defects behind this file.
 *
 * Which state-changing requests it lets a signed-in browser make. That defect
 * was reachable from code agents in this app write. `SameSite=Lax` is decided
 * by site, and a site ignores the port, so a page on `localhost:5173` — an
 * agent's dev server, opened by the operator — had the session cookie attached
 * to its `no-cors` `text/plain` POST, which needs no preflight, and the gate
 * passed it on the cookie alone: a billed run started, a plugin directory
 * enabled for every later child, a branch landed. Nothing threw, every page
 * worked, and the only trace was the change itself.
 *
 * Its bearer branch, as a guess at the master token. `/api/login` was given a
 * budget so that `UF_AUTH_TOKEN` could not be guessed at the rate of the event
 * loop, and its locked answer is the same whether the token is right or wrong
 * so it cannot be used as an oracle. Every other route accepted the same secret
 * as `Authorization: Bearer` with no budget at all, answering a wrong one 401
 * and letting the right one through — the oracle the limiter's own rule
 * forbids, on every route in the app, while sign-in sat locked. Nothing about
 * that throws or fails to typecheck: an unbounded gate looks exactly like a
 * bounded one until somebody counts.
 *
 * The gate reads `process.env` on every call rather than at import, so each
 * case sets what it needs and nothing here opens a database. The clock is
 * replaced for the whole file rather than per case, because the bearer budget
 * is module state that only time clears: each case that sends a bearer starts
 * by winding past anything the one before it left standing, and the session
 * cookie is minted to outlive every wind.
 */

const TOKEN = "0123456789abcdef0123456789abcdef";
const APP = "http://localhost:3000";

let middleware: typeof import("./middleware");
let limiter: typeof import("./lib/loginLimiter");
let cookie: string;

const realNow = Date.now;
let clock = realNow();

before(async () => {
  process.env.UF_AUTH_TOKEN = TOKEN;
  process.env.UF_PUBLIC_URL = "";
  Date.now = () => clock;
  middleware = await import("./middleware");
  limiter = await import("./lib/loginLimiter");
  const sessionToken = await import("./lib/sessionToken");
  cookie = `uf_session=${await sessionToken.mintSessionCookie("sid", Date.now() + sessionToken.SESSION_TTL_MS, TOKEN)}`;
});

afterEach(() => {
  process.env.UF_PUBLIC_URL = "";
});

after(() => {
  Date.now = realNow;
  delete process.env.UF_AUTH_TOKEN;
});

/** Past every lock and every window the previous case could have left. */
function startClean() {
  clock += limiter.DEFAULT_LIMITER.windowMs + limiter.DEFAULT_LIMITER.globalLockoutMs + 1;
}

const letThrough = (res: Response) => res.headers.get("x-middleware-next") === "1";

async function gate(
  pathname: string,
  headers: Record<string, string>,
  o: { method?: string; url?: string } = {},
) {
  const res = await middleware.middleware(
    new NextRequest(`${o.url ?? APP}${pathname}`, { method: o.method ?? "POST", headers }),
  );
  return { status: res.status, passed: letThrough(res) };
}

/** The whole response, because the bearer cases compare bodies and headers. */
const bearer = (value: string, path = "/api/runs") =>
  middleware.middleware(new NextRequest(`${APP}${path}`, { headers: { authorization: `Bearer ${value}` } }));

async function answers(responses: Response[]) {
  const statuses = new Map<number, number>();
  for (const r of responses) {
    statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
    // Locked or wrong, the body is the same — the oracle rule, as on sign-in.
    assert.deepEqual(await r.json(), { error: "Unauthorized" });
  }
  return { compared: statuses.get(401) ?? 0, refused: statuses.get(429) ?? 0 };
}

test("a signed-in POST from another localhost port is refused, and the same POST from the app passes", async () => {
  // Exactly what Chromium sent from `localhost:39118` to `localhost:39117`.
  const crossPort = {
    cookie,
    origin: "http://localhost:5173",
    "sec-fetch-site": "same-site",
    "sec-fetch-mode": "no-cors",
    "content-type": "text/plain;charset=UTF-8",
  };
  for (const pathname of ["/api/runs", "/api/plugins", "/api/runs/r1/land"]) {
    const refused = await gate(pathname, crossPort);
    assert.equal(refused.passed, false, `${pathname} let a cross-origin POST through on the cookie`);
    assert.equal(refused.status, 403, pathname);
  }

  const own = await gate("/api/runs", {
    ...crossPort,
    origin: APP,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
  });
  assert.equal(own.passed, true, "the app's own page was refused");

  // Reading is not what this closes: a link on another port to a run page is a
  // same-site top-level GET and must still open it.
  const navigation = await gate("/runs/r1", { cookie, "sec-fetch-site": "same-site" }, { method: "GET" });
  assert.equal(navigation.passed, true, "a GET from a same-site page was refused");
});

test("a bearer caller sends no origin and is not asked for one", async () => {
  startClean();
  const script = await gate("/api/runs", { authorization: `Bearer ${TOKEN}` });
  assert.equal(script.passed, true, "a script with the master token was refused for naming no origin");
});

test("without Sec-Fetch-Site the Origin decides, against the host the browser addressed", async () => {
  // A LAN install over plain http: browsers send Sec-Fetch-* only to a
  // trustworthy origin, so this is the ordinary case there, not an old browser.
  // The request URL is the server's bind address, which is what Next hands the
  // gate in production; only the Host header says what the browser asked for.
  const lan = { url: "http://0.0.0.0:3000" };
  const fromLan = await gate("/api/runs", { cookie, host: "192.168.1.5:3000", origin: "http://192.168.1.5:3000" }, lan);
  assert.equal(fromLan.passed, true, "the app's own page on a LAN address was refused");

  for (const origin of ["http://192.168.1.5:5173", "null"]) {
    const refused = await gate("/api/runs", { cookie, host: "192.168.1.5:3000", origin }, lan);
    assert.equal(refused.status, 403, `Origin ${origin} passed`);
  }

  // No Origin and no Sec-Fetch-Site is not a browser page — every browser
  // names an origin on a POST — so nothing vouches for where it came from and
  // the cookie alone is not enough. A script holds the token.
  const unstated = await gate("/api/runs", { cookie });
  assert.equal(unstated.status, 403, "a cookie with no origin at all passed");
});

test("behind a proxy that rewrites Host, UF_PUBLIC_URL is the app's own origin", async () => {
  const proxied = { cookie, host: "127.0.0.1:3000", origin: "https://uf.example.com" };
  assert.equal((await gate("/api/runs", proxied)).status, 403, "an unrelated origin passed with no public URL set");

  process.env.UF_PUBLIC_URL = "https://uf.example.com/";
  assert.equal((await gate("/api/runs", proxied)).passed, true, "the configured public origin was refused");
  const forwarded = await gate("/api/runs", { ...proxied, origin: "https://other.example.com" });
  assert.equal(forwarded.status, 403, "a sibling subdomain passed");
});

test("the credential-free doors refuse a page the browser says is elsewhere, and nothing else", async () => {
  // A wrong guess posted from another page through the operator's own browser
  // reaches a port its author cannot, and spends the global sign-in bucket that
  // locks the operator out too.
  const elsewhere = { origin: "http://localhost:5173", "sec-fetch-site": "same-site" };
  assert.equal((await gate("/api/login", elsewhere)).status, 403, "a cross-origin sign-in passed");
  assert.equal((await gate("/api/logout", { ...elsewhere, cookie })).status, 403, "a cross-origin sign-out passed");

  const own = { origin: APP, "sec-fetch-site": "same-origin" };
  assert.equal((await gate("/api/login", own)).passed, true, "the sign-in page was refused");
  assert.equal((await gate("/api/logout", { ...own, cookie })).passed, true, "the app's sign-out was refused");
  // A client that names no origin is not a page in somebody's browser, and
  // has no ambient credential to borrow: it can already reach the route.
  assert.equal((await gate("/api/login", {})).passed, true, "a header-less sign-in was refused");
});

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
  assert.equal((await gate("/api/runs", { cookie }, { method: "GET" })).passed, true);
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
