import { NextResponse } from "next/server";
import type { CodexAuthStateDTO } from "@/lib/apiTypes";
import { lastLoginFailure, pendingLogin, readAuthStatus } from "@/lib/codexAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Whether the container's Codex is signed in, and how.
 *
 * `/api/claude-auth`'s twin, and its own route for the same reason: it spawns a
 * process, and it changes without the Settings form being touched.
 *
 * It carries one job that route does not, and it is why the page polls this one
 * rather than reading it once. A Codex device login is completed in the
 * operator's *browser*, against OpenAI — no request comes back here — so this
 * answer is the only place the sign-in becomes visible. Never cached, for that
 * reason twice over.
 */
export async function GET() {
  const status = await readAuthStatus();
  const body: CodexAuthStateDTO = {
    auth: status.ok ? status.value : null,
    error: status.ok ? null : status.error,
    pending: pendingLogin(),
    loginError: lastLoginFailure(),
  };
  return NextResponse.json(body);
}
