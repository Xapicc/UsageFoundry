import { toolInventory } from "../../../lib/toolInventory";
import { jsonMaybeGzipped } from "../../../lib/http";
import type { ToolInventoryDTO } from "../../../lib/apiTypes";
import { readReceipts } from "../../../lib/stacks";
import { pendingStackRequests, stackRequestDTOs } from "../../../lib/stackRequests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What this install's agents can run, and how sure the app is of each one.
 *
 * Read-only and behind the ordinary gate. `src/middleware.ts:114` exempts
 * `/api/status` and nothing else, and this route is deliberately not added to
 * it: a read-only inventory still tells its reader which binaries are on the
 * box, and that does not weaken because the list got better.
 *
 * Relative imports rather than aliased, which is what every route with a test
 * here does — `node --test` runs the compiled output and nothing resolves `@/`
 * there.
 *
 * No cache directive beyond the fetch's own `no-store`: this is the one surface
 * whose job is saying what is true now, and the only part of it that is cached
 * is the invocation count, which carries its own reasoning in
 * `toolInventory.ts`.
 */
export async function GET(req: Request) {
  const inventory = toolInventory();
  const { receipts } = readReceipts();
  // An answered request with nobody waiting on it is done with, and the table
  // never says so — "installed" is not a state a request can hold — so this is
  // where it stops being listed. One a run still waits on stays until the
  // release has handed that run back, so the list never claims a run is free
  // that is still parked.
  const requests = (await stackRequestDTOs(pendingStackRequests(), receipts)).filter(
    (request) =>
      request.receipt.kind !== "installed" ||
      request.runs.some((run) => run.releasedAt === null && run.status === "waiting-for-stack"),
  );
  const body: ToolInventoryDTO = {
    tools: inventory.rows,
    unclaimed: inventory.unclaimed,
    observedWindowDays: inventory.observedWindowDays,
    problems: inventory.problems,
    stackRequests: requests,
  };
  return jsonMaybeGzipped(req, body, { headers: { "Cache-Control": "no-store" } });
}
