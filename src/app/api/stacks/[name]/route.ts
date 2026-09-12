import path from "node:path";
import { jsonMaybeGzipped } from "../../../../lib/http";
import {
  readReceipts,
  stateBytes,
  STACKS_DECLARATIONS_DIR,
  STACKS_STATE_DIR,
} from "../../../../lib/stacks";
import type { StackDetailDTO } from "../../../../lib/apiTypes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ name: string }> };

/**
 * One stack's whole receipt, including the part the list cannot hold.
 *
 * Its own route rather than a field on `GET /api/tools`, per `01f-` §5: the
 * two answer about different subjects, and this one carries the 4 KB of a
 * failing step's stderr that made the detail a route rather than an expander
 * (`01e-` §2.1). One route and not three, because the two `.env` tool lists
 * have no receipt behind them and never will.
 *
 * **The name is never joined onto a path.** It is matched against the receipts
 * `readReceipts` has already read, so `../../etc/passwd` finds nothing rather
 * than being normalised into a read — `docs/agent/security.md`'s containment
 * rule, met by not having a path to contain. The second reason to go through
 * the same reader the list uses is that a second one could disagree with it
 * about whether a receipt is readable.
 *
 * **Behind the master token, with no exemption.** `src/middleware.ts` exempts
 * `/api/status` when `UF_STATUS_TOKEN` is set and nothing else; this is not
 * added to that list. A read-only inventory still tells its reader which
 * binaries are on the box, and that does not weaken because the answer got
 * more detailed.
 *
 * Having nothing to say is a 200 that says which nothing it is, never a 404:
 * a name no receipt claims and a receipt this build cannot read are different
 * facts with different fixes, and a status code carries neither.
 *
 * Relative imports rather than aliased, which is what every route with a test
 * here does — `node --test` runs the compiled output and nothing resolves `@/`
 * there.
 */
export async function GET(req: Request, ctx: Ctx) {
  const { name } = await ctx.params;
  const { receipts, unreadable } = readReceipts();

  // Both paths are built from the name only after it has been matched against a
  // receipt, so they are a name this applier wrote rather than a segment off the
  // wire — and they are printed, never opened, except by the one walk below.
  const where = (found: string) => ({
    declaredAt: path.posix.join(STACKS_DECLARATIONS_DIR, found),
    stateDir: path.posix.join(STACKS_STATE_DIR, found),
  });

  const receipt = receipts.find((entry) => entry.name === name) ?? null;
  if (receipt) {
    const body: StackDetailDTO = {
      name,
      receipt,
      ...where(receipt.name),
      // Walked per request and deliberately not cached: one directory, on a
      // page an operator opens on purpose and leaves. `stacks.ts` carries why
      // `null` here is not zero.
      stateBytes: stateBytes(receipt.name),
      absence: null,
    };
    return jsonMaybeGzipped(req, body, { headers: { "Cache-Control": "no-store" } });
  }

  const broken = unreadable.find((entry) => entry.name === name);
  const body: StackDetailDTO = {
    name,
    receipt: null,
    // Nothing was matched, so nothing is measured and nothing is spelled: a
    // name off the wire must not become a path, and a stack with no receipt has
    // no state this app can vouch for either way.
    declaredAt: STACKS_DECLARATIONS_DIR,
    stateDir: STACKS_STATE_DIR,
    stateBytes: null,
    absence: broken
      ? { kind: "unreadable", reason: broken.reason }
      : {
          kind: "missing",
          reason:
            "no receipt names this stack — the applier writes one for every declared stack on " +
            "every boot, including the ones it refused, so a name with none was not declared " +
            "on the last one",
        },
  };
  return jsonMaybeGzipped(req, body, { headers: { "Cache-Control": "no-store" } });
}
