import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
// Relative, not "@/…" — see the note in the login route.
import { AUTH_TOKEN, COOKIE_SECURE, authEnabled } from "../../../lib/config";
import { recordOpsEvent } from "../../../lib/ops";
import { revokeAllSessions, revokeSession } from "../../../lib/sessions";
import {
  SESSION_COOKIE,
  cookieIsSecure,
  readSessionCookie,
} from "../../../lib/sessionToken";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * End a session.
 *
 * There was nothing to end before: the cookie *was* `UF_AUTH_TOKEN`, so the
 * only way to invalidate an issued one was to change the environment variable
 * and restart the container — which kills every run in flight for a credential
 * that leaked. Now a sign-in is a row, and this is what closes it.
 *
 * `all: true` closes every outstanding one, which is the operator action for a
 * cookie that got out rather than for the browser in front of you.
 *
 * Exempt from `middleware.ts` on purpose: signing out must not require a valid
 * session, or the one state you can never leave is the one where your cookie
 * has gone stale. That exemption is the whole reason the two branches take
 * different credentials, and the difference is not symmetry for its own sake:
 *
 *  - the ordinary branch revokes **the id inside the cookie it is handed**, so
 *    a caller with no cookie asks for nothing and gets nothing. That is the
 *    clause `docs/agent/security.md` gives as the exemption's justification;
 *  - `all: true` is an install-wide action against sessions the caller was
 *    never handed, so it is not covered by that clause and takes a credential
 *    of its own. Without one, anybody who can reach the port could sign every
 *    browser out — and, worse, zero the `activeSessions` figure an operator
 *    reads to check whether anyone else is signed in.
 *
 * The refusal is answered **before** any audit or rate-limit machinery, for
 * `/api/mcp`'s reason: this path is reachable without a credential, so a
 * refusal that wrote a row would let an unauthenticated caller evict
 * `request_log`'s 20,000-line window at will. A revocation that *happened* is
 * worth a durable line, and gets one on `ops_events` instead.
 *
 * **What this does not close.** A revoked session's cookie stays
 * signature-valid at the edge gate until its own `SESSION_TTL_MS` expiry,
 * because that gate runs in the edge runtime and cannot read the revocation —
 * `sessionToken.ts` states the limitation and what closing it would cost. So
 * `all: true` ends every session this server will *issue against* and does not
 * eject a captured cookie mid-window. It is the right button for "revoke the
 * browsers"; it is not yet the right button for "a cookie got out".
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { all?: boolean };

  if (authEnabled()) {
    const cookie = readCookie(req);
    const claim = cookie
      ? await readSessionCookie(cookie, AUTH_TOKEN, Date.now())
      : null;
    if (body.all === true) {
      if (!claim && !bearerMatches(req)) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      const closed = revokeAllSessions();
      // Durable, because this is the one action here that changes what somebody
      // else can do, and nothing else in the app would say it happened.
      recordOpsEvent("warn", "auth.sessions_revoked", { closed });
    } else if (claim) {
      revokeSession(claim.id);
    }
  }

  const res = NextResponse.json({ ok: true });
  // Cleared with the same attributes it was set with: a browser matches a
  // deletion on name, path and domain, so a `path` that disagreed would leave
  // the cookie in the jar and the sign-out silently half done.
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    secure: cookieIsSecure({
      forwardedProto: req.headers.get("x-forwarded-proto"),
      protocol: new URL(req.url).protocol,
      override: COOKIE_SECURE,
    }),
  });
  return res;
}

/**
 * The master token, presented as a bearer header.
 *
 * Constant-time against a single configured value, for `middleware.ts`'s
 * reason. Compared over bytes rather than code units because that is what
 * `node:crypto` takes and this route runs in Node.
 */
function bearerMatches(req: Request): boolean {
  if (!AUTH_TOKEN) return false;
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const offered = Buffer.from(header.slice(7));
  const known = Buffer.from(AUTH_TOKEN);
  // Length is not secret, and `timingSafeEqual` throws on a mismatch.
  return offered.length === known.length && timingSafeEqual(offered, known);
}

/** A plain `Request` has no cookie jar, only the header. */
function readCookie(req: Request): string {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      return part.slice(eq + 1).trim();
    }
  }
  return "";
}
