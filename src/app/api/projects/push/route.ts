import { NextResponse } from "next/server";
// Relative, not "@/…", for the reason `src/app/api/settings/route.ts` gives:
// `projectPush.test.ts` loads the push route, and nothing rewrites the alias there.
import { readJsonObject } from "../../../../lib/http";
import { pushProject, readPushFields } from "../../../../lib/projects";
import { auditMutation } from "../../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Push one project's current branch to its configured upstream.
 *
 * The body names the project and what the operator was shown —
 * `{ mountId, folder, branch, sha }` — and `planPush` refuses when HEAD is no
 * longer that branch at that commit, so a press sends what was on screen and
 * nothing else. The body is checked before anything runs, so a malformed one
 * is a 400 with nothing pushed. A refusal decided before the remote is touched
 * is a 409 carrying `code` and the project as it now stands; a push the remote
 * refused is a 502, with the same.
 */
async function postHandler(req: Request) {
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const fields = readPushFields(read.body);
  if (!fields.ok) return NextResponse.json({ error: fields.error }, { status: 400 });

  const { branch, sha, ...project } = fields.value;
  const outcome = await pushProject(project, { branch, sha });
  if (!outcome.ok) {
    const { status, reason, ...rest } = outcome;
    return NextResponse.json({ error: reason, ...rest }, { status });
  }
  return NextResponse.json(outcome);
}

/** Wrapped so the request that published something is on the audit log. */
export const POST = auditMutation(postHandler);
