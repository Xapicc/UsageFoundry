import { NextResponse } from "next/server";
// Relative, not "@/…" — see the note in the login route.
import type { ClaudeAuthDTO } from "../../../../lib/apiTypes";
import { signOut } from "../../../../lib/claudeAuth";
import { auditMutation, recordDurableMutation } from "../../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sign the container's Claude Code out.
 *
 * Nothing here checks for runs in flight, and that is deliberate rather than
 * missing: this is also the control an operator reaches for when a credential
 * has leaked, and a sign-out that refused while any run existed would be
 * unreachable at exactly the moment it is most needed. What it costs is stated
 * where it is pressed — every run still working will end on `Not logged in` —
 * and the page confirms before sending this.
 *
 * Distinct from `/api/logout`, which ends a *session of this app*. The two are
 * separate credentials and the Settings page keeps them in separate rows.
 */
async function postHandler(req: Request) {
  const res = await signOut();
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 502 });
  const auth: ClaudeAuthDTO = res.value;
  // `warn`, unlike the sign-in beside it: this destroys the credential every
  // billed child authenticates with, and every run still working will fail on
  // its next cycle. An operator reading `ops_events` after a fleet went quiet
  // needs this row above the noise rather than in it.
  recordDurableMutation(req, "warn", "auth.provider_signed_out", {
    provider: "claude",
  });
  return NextResponse.json({ auth });
}

/** Wrapped for the reason `/api/claude-auth/login` is. */
export const POST = auditMutation(postHandler);
