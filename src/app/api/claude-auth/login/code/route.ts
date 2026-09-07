import { NextResponse } from "next/server";
// Relative, not "@/…" — see the note in the login route.
import type { ClaudeAuthDTO } from "../../../../../lib/apiTypes";
import { submitCode } from "../../../../../lib/claudeAuth";
import {
  auditMutation,
  recordDurableMutation,
} from "../../../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Finish a sign-in with the code the browser handed back.
 *
 * The code goes to the waiting child on **stdin** and never into argv — the one
 * place in this app where a value typed by a person reaches a child process, so
 * the one place where the shape of that value decides what the process is
 * asked. `normalizeCode` refuses anything carrying whitespace for that reason
 * rather than for tidiness.
 *
 * The answer is a fresh status read rather than an `{ ok: true }`, because the
 * exchange succeeding and the credential landing somewhere the next agent can
 * open are two different facts and only the second one matters.
 *
 * 400 rather than 502: every failure here — a stale link, a mistyped code, a
 * code already redeemed — is one the operator fixes by starting again.
 */
async function postHandler(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { code?: unknown };
  const res = await submitCode(body.code);
  if (!res.ok) {
    // `stillPending` is what tells the page whether to leave the field open for
    // another paste or send the operator back to a fresh link. Without it a
    // mistyped code and an expired one look identical from the browser.
    //
    // No durable row on this branch: nothing was replaced, and the wrapper's
    // `request_log` line already says a 400 happened here and from where. The
    // durable channel is for what changed.
    return NextResponse.json(
      { error: res.error, stillPending: res.stillPending },
      { status: 400 },
    );
  }
  const auth: ClaudeAuthDTO = res.value;
  // The credential every billed child runs against has just been written. The
  // method is the CLI's own word for what landed; the email and organisation it
  // also reports are not here, because an audit line is not a place to put a
  // person's address.
  recordDurableMutation(req, "info", "auth.provider_signed_in", {
    provider: "claude",
    method: auth.method,
  });
  return NextResponse.json({ auth });
}

/** Wrapped for the reason `/api/claude-auth/login` is. */
export const POST = auditMutation(postHandler);
