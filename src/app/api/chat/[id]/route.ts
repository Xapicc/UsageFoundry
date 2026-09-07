// Relative, not "@/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime, so a module a test loads has to import
// the way src/lib and Meter.tsx already do.
import { getChat } from "../../../../lib/chat";
import { jsonMaybeGzipped, jsonNoStore } from "../../../../lib/http";
import { chatDTO, chatListDTO } from "../dto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * One thread, and the list beside it.
 *
 * The list is here because this is the route the page polls: it opens on a
 * thread and then only ever asks for that thread, so a payload of the chat
 * alone leaves the sidebar frozen at whatever was true on mount. Answering with
 * both costs no extra request and no second timer, which is the point — the
 * poll's period follows the thread's status, and the list has no business
 * making the page ask more often than that.
 *
 * **`?after=` is what keeps that poll off the whole conversation.** It carries
 * the highest `seq` the page already holds and the thread comes back as the
 * messages past it, which is the mechanism `/api/runs/[id]/stream` has always
 * used for the run log — the store this app most expects to be large. It is on
 * this route and not on `GET /api/chat`, because that one is what the page
 * loads *with* and has by definition nothing to resume from; a cursor there
 * would be a parameter with no caller.
 */
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const chat = getChat(id);
  if (!chat) return jsonNoStore({ error: "Not found" }, { status: 404 });
  // Validated here because this is the boundary and the value reaches a query.
  // Anything that is not a whole number at or above zero is read as no cursor
  // at all rather than refused: a query string is the one input this page can
  // get wrong on its own, and the honest answer to a broken cursor is the whole
  // thread — the same body this route sent before the parameter existed.
  const after = Number(new URL(req.url).searchParams.get("after"));
  const afterSeq = Number.isSafeInteger(after) && after > 0 ? after : 0;
  // Gzipped: 73,565 bytes to 20,136, measured — the same body `GET /api/chat`
  // answers with, on the poll that runs for the life of the page. That figure
  // is now the *first* read of a thread; every poll after it carries only what
  // has arrived since. `Cache-Control` written out for the reason that route
  // gives.
  return jsonMaybeGzipped(
    req,
    { chat: chatDTO(chat, afterSeq), chats: chatListDTO() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
