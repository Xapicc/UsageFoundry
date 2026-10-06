import { NextResponse, type NextRequest } from "next/server";
// Edge-safe by construction: Web Crypto and string handling, no node builtins
// and no lib/config. That is what lets the gate below decide about a cookie
// without a database it cannot reach — see the note in that file.
import { SESSION_COOKIE, readSessionCookie } from "./lib/sessionToken";
// Edge-safe for the same reason: the limiter's decision is pure, and the state
// it decides from lives in this runtime's own memory.
import { checkBearerAllowed, recordBearerFailure } from "./lib/bearerLimiter";

/**
 * Shared-secret gate.
 *
 * This app holds Claude credentials and can execute an agent with write access
 * to mounted code, so it is not something to leave open on a LAN. Auth is on
 * whenever UF_AUTH_TOKEN is set; leaving it unset makes the server refuse to
 * boot unless UF_ALLOW_NO_AUTH=1 says the operator meant it, so an unset token
 * reaching this function is a state somebody chose and every page announces.
 *
 * Two credentials, and they are deliberately different things. The bearer
 * header is UF_AUTH_TOKEN itself — what a script presents. The cookie is a
 * signed session handle that is *not* the token and cannot be replayed as one,
 * which is the whole of what changed: it used to be a thirty-day plaintext copy
 * of the master secret sitting in a browser jar.
 *
 * The per-turn and per-run capabilities two of the exempted paths below take
 * are neither of those, which is why each of those is checked in its own route.
 * The read-only credential a third one takes is a third thing again, and is
 * what makes that exemption conditional on it existing at all.
 *
 * Runs in the edge runtime, so it reads process.env directly rather than
 * importing lib/config (which pulls in node:os / node:path).
 */

function timingSafeEqual(a: string, b: string): boolean {
  // Length is not secret here, but keep the comparison constant-time over the
  // shorter of the two to avoid leaking a prefix match.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function changesState(req: NextRequest): boolean {
  return req.method !== "GET" && req.method !== "HEAD";
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * Where the browser says a request came from: this app's own pages, a page
 * somewhere else, or nothing said at all.
 *
 * The cookie cannot answer this. `SameSite=Lax` is decided by *site*, and a
 * site ignores the port, so a page on `localhost:5173` — an agent's dev server
 * the operator opened — gets the cookie attached to its `no-cors` POST, and a
 * `text/plain` body needs no preflight to be sent.
 *
 * `Sec-Fetch-Site` comes first because the browser computes it from the URLs
 * it actually holds, so no proxy in between can make it wrong. It is only sent
 * to a trustworthy origin, though, so a LAN install over plain http never sees
 * it and falls through to `Origin`. That is compared against the host the
 * browser addressed — `Host`, or a proxy's `x-forwarded-host`, as Next's own
 * server-action check does — and not against `nextUrl`, which in production is
 * the server's bind address rather than anything a browser typed. Trusting
 * those headers costs nothing here: a page cannot set either one without a
 * preflight this app never answers, and a client that can is not borrowing
 * anybody's cookie. `UF_PUBLIC_URL` covers a proxy that rewrites `Host` and
 * forwards nothing.
 */
function requestSource(req: NextRequest): "own" | "elsewhere" | "unstated" {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin" || site === "none" ? "own" : "elsewhere";

  const origin = req.headers.get("origin");
  if (origin === null) return "unstated";
  const ownHosts = [
    req.nextUrl.host,
    req.headers.get("host"),
    req.headers.get("x-forwarded-host")?.split(",")[0].trim(),
    hostOf(process.env.UF_PUBLIC_URL ?? ""),
  ].filter((host): host is string => !!host).map((host) => host.toLowerCase());
  const host = hostOf(origin);
  return host !== null && ownHosts.includes(host) ? "own" : "elsewhere";
}

function crossOriginRefusal(req: NextRequest) {
  const site = req.headers.get("sec-fetch-site");
  const origin = req.headers.get("origin");
  const seen =
    site !== null ? `Sec-Fetch-Site: ${site}` : origin !== null ? `Origin: ${origin}` : "no Origin header";
  return NextResponse.json(
    { error: `Cross-origin request refused: a change has to come from this app's own pages, and this one came with ${seen}.` },
    { status: 403 },
  );
}

export async function middleware(req: NextRequest) {
  const token = process.env.UF_AUTH_TOKEN ?? "";
  if (!token) return NextResponse.next();

  const { pathname } = req.nextUrl;
  // The two credential-free doors refuse only a page the browser says is
  // somewhere else. A sign-in guess posted through the operator's own browser
  // reaches a port its author may not, and spends the install-wide sign-in
  // bucket that locks the operator out as well; a sign-out from there ends the
  // operator's sessions. A client that names no origin at all is not a page in
  // anybody's browser, holds nothing ambient to borrow, and can already reach
  // these routes directly — so it is let by, unlike on the cookie branch below.
  if (pathname === "/login" || pathname === "/api/login") {
    if (changesState(req) && requestSource(req) === "elsewhere") return crossOriginRefusal(req);
    return NextResponse.next();
  }

  // Ending a session must not need one: a cookie whose signature has gone stale
  // is exactly the cookie somebody is trying to clear, and the route revokes
  // only the id it is handed.
  if (pathname === "/api/logout") {
    if (changesState(req) && requestSource(req) === "elsewhere") return crossOriginRefusal(req);
    return NextResponse.next();
  }

  // The orchestrator chat's tool endpoint authenticates itself, because the
  // credential it takes is not this one: it is a capability minted per chat
  // turn and revoked when that turn's child exits, so a leaked copy opens
  // nothing afterwards — where UF_AUTH_TOKEN opens every route in the app for
  // as long as it is set. That check needs SQLite and module state, neither of
  // which exists in the edge runtime, so it cannot happen here.
  //
  // This is an exemption from *this* gate, not from authentication. If the
  // check in `/api/mcp` is ever removed, this line makes the whole tool surface
  // public — keep the two together.
  if (pathname === "/api/mcp") {
    return NextResponse.next();
  }

  // The same exemption, for the same reason, for the telemetry a run exports.
  // The exporter used to authenticate with UF_AUTH_TOKEN — which meant this
  // app's master credential sat in the agent's own environment, in a variable
  // `env` prints, for a Claude Code session with `Bash`. It now carries a
  // capability minted per run, revoked when that run's loop ends, opening
  // nothing but writes to that run's own telemetry.
  //
  // Exemption from *this* gate, not from authentication: the route checks the
  // capability itself, and needs SQLite and module state to do it, neither of
  // which exists in the edge runtime. If that check is ever removed, this line
  // makes `otlp_requests` openly writable — keep the two together.
  if (pathname === "/api/otlp/v1/logs") {
    return NextResponse.next();
  }

  // The container's own liveness probe, which has to work before anyone has a
  // credential and from a `HEALTHCHECK` that has no way to hold one. It is safe
  // to leave open because of what it answers with and only that: counts of runs
  // by status, whether SQLite responds, whether this process owns its data
  // directory, and two timings. No prompt, no folder or mount path, no setting,
  // no token, no model name, nothing read off a transcript.
  //
  // That list is the exemption's whole justification, so it is a constraint on
  // the route rather than a description of it — see the same statement in
  // `health.ts`. Anything added to that payload that is not a count makes this
  // line a second unauthenticated data route.
  if (pathname === "/api/health") {
    return NextResponse.next();
  }

  // The monitor's route, and the last exemption. Conditional, which is what
  // makes it different from every one above: it is exempt only while a
  // *separate* read-only credential exists for it to check, and `/api/status`
  // checks that credential itself.
  //
  // The credential is the whole reason this is not simply behind the gate. The
  // token above is the one that can start billed agents, so polling any other
  // route from a monitoring system means handing a scraper the master key.
  // `UF_STATUS_TOKEN` reaches this route and nothing else. Unset, there is no
  // exemption and the ordinary gate applies — the safe direction, since an
  // operator who never configured one gets a 401 rather than a public endpoint.
  //
  // Keep this line and the check in that route together, exactly as with
  // `/api/mcp` above.
  if (pathname === "/api/status" && (process.env.UF_STATUS_TOKEN ?? "") !== "") {
    return NextResponse.next();
  }

  // The signature proves this server issued it and the signed expiry proves it
  // is still inside its window — neither of which a comparison against the
  // token could say, because the token has no window and every copy of it is
  // identical.
  //
  // What neither proves is who sent it, because the browser attaches the cookie
  // to a request from any page on the same site. So it authorises a change only
  // from this app's own pages, and a request that says nothing about where it
  // came from is refused too: every browser names an origin on a POST, so that
  // is a script holding a cookie, and a script can hold the token instead.
  const cookie = req.cookies.get(SESSION_COOKIE)?.value ?? "";
  if (cookie && (await readSessionCookie(cookie, token, Date.now()))) {
    if (!changesState(req) || requestSource(req) === "own") return NextResponse.next();
    return crossOriginRefusal(req);
  }

  // A bearer is a guess at the master token and is charged like one: check,
  // compare and charge with nothing awaited between them, and once the budget is
  // spent the right token gets the wrong token's answer, so the gate cannot be
  // used as the oracle the sign-in limiter refuses to be. See bearerLimiter.ts
  // for why this budget is not the sign-in one.
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (bearer) {
    const now = Date.now();
    const verdict = checkBearerAllowed(now);
    if (!verdict.allow) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json(
          { error: "Unauthorized" },
          {
            status: 429,
            headers: { "retry-after": String(Math.ceil(verdict.retryAfterMs / 1000)) },
          },
        );
      }
    } else if (timingSafeEqual(bearer, token)) {
      return NextResponse.next();
    } else {
      recordBearerFailure(now);
    }
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
