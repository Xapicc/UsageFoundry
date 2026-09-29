import { NextResponse } from "next/server";
// Relative, not "@/…", for the codex-auth routes' reason: a test that loads a
// route module gets no path-alias rewriting.
import type { LocalProviderDTO } from "../../../lib/apiTypes";
import {
  clearLocalSignIn,
  getLocalSignIn,
  parseLocalSignIn,
  probeLocalEndpoint,
  saveLocalSignIn,
  type LocalSignIn,
} from "../../../lib/localProvider";
import { readJsonObject } from "../../../lib/http";
import { auditMutation, recordDurableMutation } from "../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What the page may see: whether there is a token, never the token. */
function toDTO(signIn: LocalSignIn | null): LocalProviderDTO {
  return {
    signedIn: signIn !== null,
    baseUrl: signIn?.baseUrl ?? null,
    model: signIn?.model ?? null,
    hasToken: !!signIn?.token,
    contextTokens: signIn?.contextTokens ?? null,
    signedInAt: signIn?.signedInAt ?? null,
  };
}

export async function GET() {
  return NextResponse.json(toDTO(getLocalSignIn()));
}

/**
 * Sign in: check the endpoint answers the way a work cycle will ask it, then
 * keep it.
 *
 * The token arrives in the body for `/api/codex-auth/api-key`'s reason —
 * `requestLog.ts` records no body — and the durable line names the host and
 * the model, never the token.
 *
 * Probed before it is saved, and a probe that fails saves nothing: a sign-in
 * this app stored without checking would be the first cycle of the next run
 * discovering it, inside a run the operator has already walked away from.
 */
async function postHandler(req: Request) {
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const body = read.body;
  const parsed = parseLocalSignIn(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const failure = await probeLocalEndpoint(parsed.value);
  // 502: the operator's input parsed, and it was the endpoint that said no.
  if (failure) return NextResponse.json({ error: failure }, { status: 502 });

  const signIn = saveLocalSignIn(parsed.value);
  recordDurableMutation(req, "info", "auth.provider_signed_in", {
    provider: "local",
    host: new URL(signIn.baseUrl).host,
    model: signIn.model,
    contextTokens: signIn.contextTokens,
  });
  return NextResponse.json(toDTO(signIn));
}

/**
 * Sign out. `warn` for the Codex sign-out's reason: every local run's next
 * cycle is refused after this, and those refusals will not name it.
 */
async function deleteHandler(req: Request) {
  clearLocalSignIn();
  recordDurableMutation(req, "warn", "auth.provider_signed_out", { provider: "local" });
  return NextResponse.json(toDTO(null));
}

export const POST = auditMutation(postHandler);
export const DELETE = auditMutation(deleteHandler);
