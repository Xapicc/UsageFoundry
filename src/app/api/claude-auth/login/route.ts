import { NextResponse } from "next/server";
// Relative, not "@/…" — see the note in the login route. The route tests load
// these files through `tsconfig.test.json`, which rewrites no path alias.
import { beginLogin, cancelLogin, pendingLogin } from "../../../../lib/claudeAuth";
import { auditMutation, recordDurableMutation } from "../../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start a sign-in and answer with the link to open.
 *
 * The child that printed the link stays alive behind this response holding the
 * PKCE verifier, which is why this is a POST with a side effect rather than a
 * read that happens to compute a URL: pressing it twice abandons the first
 * link, and a code issued against the abandoned one can no longer be redeemed.
 *
 * 502 rather than 500 on failure: everything that can go wrong here went wrong
 * in the CLI, and the body carries its own sentence about it.
 */
async function postHandler(req: Request) {
  const res = await beginLogin();
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 502 });
  // The durable half. This is the first move of a credential replacement whose
  // second move — `login/code` — may be minutes later and from a different
  // browser, so the two are separate rows on purpose; a trail that recorded only
  // the completion could not say when the link was minted or how many were.
  // Nothing about the URL goes in it: it carries a PKCE challenge, and the whole
  // of what an audit needs here is that a link now exists.
  recordDurableMutation(req, "info", "auth.provider_login_started", {
    provider: "claude",
  });
  return NextResponse.json(res.value);
}

/**
 * Abandon a sign-in without completing it.
 *
 * Exists so a closed dialog does not leave a child waiting ten minutes on a
 * line nobody will type — and so the page never has to show a link the
 * operator has already walked away from.
 */
async function deleteHandler(req: Request) {
  // Read before the cancel, because afterwards there is nothing to distinguish
  // a login that was abandoned from a dialog closed over no pending login at
  // all. Only the first is a fact worth a row, and a row per no-op press is a
  // row that evicts a real one from a 500-row table.
  const abandoned = pendingLogin() !== null;
  cancelLogin();
  if (abandoned) {
    recordDurableMutation(req, "info", "auth.provider_login_cancelled", {
      provider: "claude",
    });
  }
  return NextResponse.json({ ok: true });
}

/**
 * Wrapped like every other mutating route behind the gate, and for the reason
 * the sign-in next door is: without it a sign-in was a line in `request_log`
 * and a provider credential being replaced was not, so an operator reading the
 * trail after an incident saw who got in and never saw who changed what they
 * got in with. The wrapper records the request, including its refusals; the
 * `recordDurableMutation` calls above record what changed, on the channel
 * ordinary traffic cannot evict.
 */
export const POST = auditMutation(postHandler);
export const DELETE = auditMutation(deleteHandler);
