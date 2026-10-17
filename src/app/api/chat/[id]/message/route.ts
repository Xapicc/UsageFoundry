import { NextResponse } from "next/server";
// Relative, not "@/…", so `jsonObjectBody.test.ts` can load this handler —
// `../route.ts` gives the reason.
import { getChat, sendChatMessage } from "../../../../../lib/chat";
import { optionalStringField, readJsonObject } from "../../../../../lib/http";
import { chatDTO } from "../../dto";
import { auditMutation } from "../../../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Say something to the chat.
 *
 * Returns as soon as the child is on its way, not when it answers: a turn takes
 * minutes and the row is the handle the page polls. The refusals that come back
 * with a 400 are the ones a person can act on — a turn already in flight, or a
 * window already past the ceiling they set.
 */
async function postHandler(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  // `String()` here sent an object as "[object Object]" and an array joined
  // with commas, each as a billed turn on words nobody wrote.
  const message = optionalStringField(read.body, "message");
  if (!message.ok) return NextResponse.json({ error: message.error }, { status: 400 });

  const res = await sendChatMessage(id, message.value ?? "");
  if (!res.ok) {
    return NextResponse.json({ error: res.reason }, { status: 400 });
  }

  const chat = getChat(id);
  return NextResponse.json({ chat: chat ? chatDTO(chat) : null });
}

/** Wrapped so the request that changed something is on the audit log. */
export const POST = auditMutation(postHandler);
