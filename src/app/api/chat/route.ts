import { CHAT_PAGE_MAX, createChat, findChats, latestChat } from "@/lib/chat";
import { jsonMaybeGzipped, jsonNoStore } from "@/lib/http";
import { chatDTO, chatListDTO } from "./dto";
import { auditMutation } from "../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The chat list, plus whichever thread the page should open on.
 *
 * One request rather than two because the page has nothing to show without
 * both, and a second round trip would render an empty thread first.
 *
 * **With `q`, `offset` or `limit` it answers with the list alone**, and that is
 * a different question rather than the same one with parameters. The plain form
 * is what the page polls: it opens a thread, so it takes `latestChat()`, which
 * *creates* one when the install has none. A search must never do that — an
 * operator looking for a conversation from March would have created an empty
 * thread every time they typed — and it has no thread to open anyway.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  if (params.has("q") || params.has("offset") || params.has("limit")) {
    const found = findChats({
      q: params.get("q") ?? "",
      limit: Number(params.get("limit") ?? 30),
      offset: Number(params.get("offset") ?? 0),
    });
    return jsonMaybeGzipped(
      req,
      // `total` is what lets the page say "showing 30 of 214" rather than
      // leaving a Load-more button that may or may not do anything.
      { chats: chatListDTO(found.chats), total: found.total, limit: CHAT_PAGE_MAX },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const chat = latestChat();
  // Gzipped: 73,565 bytes to 20,011, measured — a thread is model prose and
  // this is polled for as long as the page is open. `Cache-Control` written
  // out rather than taken from `jsonNoStore`, because the directive is what
  // keeps the composer from freezing on `thinking` and it has to survive the
  // change of builder: `jsonNoStore`'s docblock is the argument for it.
  return jsonMaybeGzipped(
    req,
    { chats: chatListDTO(), chat: chatDTO(chat) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** Start a fresh thread. Nothing is carried over — not even the session id. */
// Takes the request it does not read, so the audit wrapper has one to log.
async function postHandler(_req: Request) {
  return jsonNoStore({ chat: chatDTO(createChat()) });
}

/** Wrapped so the request that changed something is on the audit log. */
export const POST = auditMutation(postHandler);
