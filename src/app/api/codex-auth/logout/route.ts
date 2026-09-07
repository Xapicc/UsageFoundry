import { NextResponse } from "next/server";
// Relative, not "@/…" — see the note in the login route.
import type { CodexAuthDTO } from "../../../../lib/apiTypes";
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
  const auth: CodexAuthDTO = res.value;
  // `warn` for its Claude twin's reason: this destroys the credential a Codex
  // run authenticates with, and the runs that fail afterwards will not name it.
  recordDurableMutation(req, "warn", "auth.provider_signed_out", {
    provider: "codex",
  });
  return NextResponse.json({ auth });
}

/** Wrapped for the reason `/api/claude-auth/login` is. */
export const POST = auditMutation(postHandler);
