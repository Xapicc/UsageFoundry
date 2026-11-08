import { jsonNoStore } from "../../../lib/http";
import { readWaiting } from "../../../lib/waiting";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What is waiting on the operator, for the dashboard's strip: five counts and
 * nothing else.
 *
 * **Not the five list routes.** Each of them answers with rows — `/api/runs` a
 * page of runs, `/api/branches` ~250 KB and a `git` call per branch plus a
 * `git status` per checkout, `/api/tasks` a page of briefs — to be counted down
 * to a number. This reads the totals from the queries those pages list by.
 *
 * A count that could not be read comes back as `unknown` inside a 200, so the
 * four that could be read still arrive; the strip says which one is missing.
 * The branches count is the dear one and the only one that touches git: it
 * skips the checkout probes (`branchInventory`'s `light`) and stops at one page
 * of the inventory, returning a floor beyond it.
 */
export async function GET() {
  return jsonNoStore(await readWaiting(Date.now()));
}
