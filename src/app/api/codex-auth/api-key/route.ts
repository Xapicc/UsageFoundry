import { NextResponse } from "next/server";
// Relative, not "@/…" — see the note in the login route.
import type { CodexAuthDTO } from "../../../../lib/apiTypes";
import { submitApiKey } from "../../../../lib/codexAuth";
import { auditMutation, recordDurableMutation } from "../../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sign Codex in with an API key — the fallback, for an install with no
 * subscription to sign into.
 *
 * The key arrives in the **body** and that is a requirement rather than a habit.
 * `requestLog.ts` records a method, a path and a subject and deliberately no
 * body and no query string, so a key posted here leaves no copy in the audit
 * table; the same key in a query string or a path segment would be written into
 * a 20,000-row table on every attempt. From here it goes to the child on stdin
 * and nowhere else — never argv, so never `/proc/<pid>/cmdline`, which is
 * world-readable.
 *
 * The durable line below is held to the same rule from the other direction: it
 * names the *method* the CLI confirmed and nothing read out of the body. The
 * mask in `apiKeyHint` is the CLI's own and is on the page already, but it is a
 * prefix and a suffix of the secret, so it stays out of a row that is kept.
 *
 * The answer is a fresh status read rather than an `{ ok: true }`, and here that
 * is load-bearing rather than tidy: `codex login --with-api-key` **exits 0 when
 * it read nothing at all**, so the exit code cannot be the success signal and
 * `submitApiKey` refuses to report a sign-in the CLI does not confirm. That is
 * also what makes the row below trustworthy: it is written behind a status read
 * that agreed about the method, not behind an exit code.
 *
 * 400 rather than 502: a refused key is something the operator fixes by pasting
 * a different one.
 */
async function postHandler(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { apiKey?: unknown };
  const res = await submitApiKey(body.apiKey);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  const auth: CodexAuthDTO = res.value;
  recordDurableMutation(req, "info", "auth.provider_signed_in", {
    provider: "codex",
    method: auth.method,
  });
  return NextResponse.json({ auth });
}

/** Wrapped for the reason `/api/claude-auth/login` is. */
export const POST = auditMutation(postHandler);
