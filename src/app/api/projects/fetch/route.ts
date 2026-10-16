import { NextResponse } from "next/server";
// Relative, not "@/…", for the reason `src/app/api/settings/route.ts` gives:
// `projectPush.test.ts` loads the push route, and nothing rewrites the alias there.
import { readJsonObject } from "../../../../lib/http";
import { fetchProject, readFetchFields } from "../../../../lib/projects";
import { auditMutation } from "../../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Fetch one project's upstream remote, `{ mountId, folder }`.
 *
 * Reached only by a press: nothing polls it and nothing in the run loop calls
 * it, because it is a credentialed call to a remote. Answers as the push route
 * does — 400 for a malformed body, 404 for a folder that is not a git folder
 * in that mount, 409 with `code` for a refusal, 502 when the remote could not
 * be fetched — and carries the project as it stands afterwards.
 */
async function postHandler(req: Request) {
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const fields = readFetchFields(read.body);
  if (!fields.ok) return NextResponse.json({ error: fields.error }, { status: 400 });

  const outcome = await fetchProject(fields.value);
  if (!outcome.ok) {
    const { status, reason, ...rest } = outcome;
    return NextResponse.json({ error: reason, ...rest }, { status });
  }
  return NextResponse.json(outcome);
}

/** Wrapped so a request that reached a remote is on the audit log. */
export const POST = auditMutation(postHandler);
