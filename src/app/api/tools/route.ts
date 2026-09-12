import { toolInventory } from "../../../lib/toolInventory";
import { jsonMaybeGzipped } from "../../../lib/http";
import type { ToolInventoryDTO } from "../../../lib/apiTypes";

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
  const body: ToolInventoryDTO = {
    tools: inventory.rows,
    unclaimed: inventory.unclaimed,
    observedWindowDays: inventory.observedWindowDays,
    problems: inventory.problems,
  };
  return jsonMaybeGzipped(req, body, { headers: { "Cache-Control": "no-store" } });
}
