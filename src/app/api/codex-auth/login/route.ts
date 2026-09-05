import { NextResponse } from "next/server";
import { beginLogin, cancelLogin } from "@/lib/codexAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start a device login and answer with the link and the one-time code.
 *
 * A POST with a side effect, and it has two that its Claude twin does not.
 * Pressing it abandons any earlier attempt — as next door — and it also
 * **removes the credential the container already had**: the CLI clears
 * `auth.json` the moment a device flow begins, before anybody has approved
 * anything, so a press taken while signed in is a sign-out that may not be
 * followed by a sign-in. The page offers the button only when signed out and
 * says so where it is pressed.
 *
 * Neither value in the answer is a secret. The code is a one-time device code
 * that is useless without an OpenAI account to approve it with, and it is
 * printed on this page precisely so somebody can type it into one.
 *
 * 502 rather than 500 on failure: everything that can go wrong here went wrong
 * in the CLI, and the body carries its own sentence about it.
 */
export async function POST() {
  const res = await beginLogin();
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 502 });
  return NextResponse.json(res.value);
}

/**
 * Abandon a device login without completing it.
 *
 * Exists so a closed dialog does not leave a child polling OpenAI for the next
 * quarter of an hour — and so the page never shows a code the operator has
 * already walked away from.
 */
export async function DELETE() {
  cancelLogin();
  return NextResponse.json({ ok: true });
}
