import { projectInventory } from "@/lib/projects";
import { jsonMaybeGzipped } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Every git folder across the workspace mounts: the branch each stands on, how
 * far it is from its upstream as of the last fetch, and the local branches not
 * merged into it.
 *
 * Deliberately not polled by its page, for `/api/branches`' reason: a page of
 * projects is a few hundred git children and nothing in it changes on its own.
 * Fetch is what moves the counts, and it is a press. `offset` and `limit` move
 * which projects are read and never how many; `total` counts every git folder.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  return jsonMaybeGzipped(
    req,
    await projectInventory({
      offset: Number(params.get("offset") ?? 0),
      limit: Number(params.get("limit") ?? 0),
    }),
  );
}
