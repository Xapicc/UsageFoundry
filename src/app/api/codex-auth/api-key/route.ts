import { NextResponse } from "next/server";
import type { CodexAuthDTO } from "@/lib/apiTypes";
import { submitApiKey } from "@/lib/codexAuth";

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
 * The answer is a fresh status read rather than an `{ ok: true }`, and here that
 * is load-bearing rather than tidy: `codex login --with-api-key` **exits 0 when
 * it read nothing at all**, so the exit code cannot be the success signal and
 * `submitApiKey` refuses to report a sign-in the CLI does not confirm.
 *
 * 400 rather than 502: a refused key is something the operator fixes by pasting
 * a different one.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { apiKey?: unknown };
  const res = await submitApiKey(body.apiKey);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  const auth: CodexAuthDTO = res.value;
  return NextResponse.json({ auth });
}
