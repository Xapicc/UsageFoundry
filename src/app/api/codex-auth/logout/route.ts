import { NextResponse } from "next/server";
// Relative, not "@/…" — see the note in the login route.
import type { CodexAuthChangeDTO } from "../../../../lib/apiTypes";
import { signOut } from "../../../../lib/codexAuth";
import { auditMutation, recordDurableMutation } from "../../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sign the container's Codex out.
 *
 * `/api/claude-auth/logout`'s reasoning verbatim: nothing here checks for runs
 * in flight, because this is also the control an operator reaches for when a
 * credential has leaked, and a sign-out that refused while any run existed would
 * be unreachable at the moment it is most needed. The page confirms first.
 *
 * Distinct from `/api/logout`, which ends a session of *this app*, and from
 * `/api/claude-auth/logout`, which is the other provider. Three credentials,
 * three rows on the Settings page, three routes.
 */
async function postHandler(req: Request) {
  const res = await signOut();
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 502 });
  // `warn` for its Claude twin's reason: this destroys the credential a Codex
  // run authenticates with, and the runs that fail afterwards will not name it.
  // Keyed to `logout`'s exit, and unconfirmed rather than absent, for the same.
  recordDurableMutation(req, "warn", "auth.provider_signed_out", {
    provider: "codex",
    ...(res.status.ok ? {} : { unconfirmed: true }),
  });
  const body: CodexAuthChangeDTO = res.status.ok
    ? { auth: res.status.value, error: null }
    : { auth: null, error: `Signed out, but could not confirm it: ${res.status.error}` };
  return NextResponse.json(body);
}

/** Wrapped for the reason `/api/claude-auth/login` is. */
export const POST = auditMutation(postHandler);
