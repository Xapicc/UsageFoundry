import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatDTO, ChatListEntryDTO } from "../../../../lib/apiTypes";

/**
 * The one thing this route has to answer with besides the thread: the list.
 *
 * This is the only route the chat page polls, so what it leaves out is frozen
 * on screen for as long as the page stays open — which is how the list came to
 * be fetched once on mount and never again, under a comment saying it was
 * refetched with the thread. The failure is the kind the rest of this suite is
 * reserved for: nothing throws, nothing fails a typecheck, and the sidebar
 * whose whole job is to say which conversations have work waiting for approval
 * quietly stops being true — a thread stays "Untitled" after `finishTurn` names
 * it, and a waiting count never moves.
 *
 * It is also the first test here that opens a database rather than calling a
 * pure function, and that is the point: the defect was a payload key, so the
 * only test that can see it is one that reads the payload. The database is a
 * throwaway directory and the run is a few milliseconds.
 */

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uf-chat-route-"));

// Config is fixed at boot, so the throwaway database has to be named before the
// first import of anything that reads it — hence the dynamic imports below.
process.env.DATA_DIR = DATA_DIR;

after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

type Body = { chat: ChatDTO; chats?: ChatListEntryDTO[] };

/** The route as the page calls it, with the poll's cursor where it sends one. */
async function get(id: string, after?: number | string): Promise<Body> {
  const { GET } = await import("./route");
  const query = after === undefined ? "" : `?after=${encodeURIComponent(after)}`;
  const res = await GET(new Request(`http://localhost/api/chat/${id}${query}`), {
    params: Promise.resolve({ id }),
  });
  return (await res.json()) as Body;
}

function entry(body: Body, id: string): ChatListEntryDTO {
  const found = (body.chats ?? []).find((c) => c.id === id);
  assert.ok(found, "the payload the page polls must carry the chat list");
  return found;
}

test("the thread the page polls comes back with the list beside it", async () => {
  const { createChat, createProposal } = await import("../../../../lib/chat");
  const open = createChat();
  const other = createChat();

  const body = await get(open.id);

  assert.equal(body.chat.id, open.id);
  assert.ok(Array.isArray(body.chats), "chats must be present, not optional");
  assert.equal(entry(body, open.id).pendingCount, 0);
  assert.equal(entry(body, other.id).pendingCount, 0);

  // A proposal made during the page's lifetime is exactly what the list is for.
  createProposal(other.id, {
    templateId: null,
    title: "Fix the parser",
    task: "Fix the parser.",
    promptOverride: null,
    mountId: null,
    folder: null,
  });

  assert.equal(entry(await get(open.id), other.id).pendingCount, 1);
});

test("a title set after the page loaded reaches the list without a reload", async () => {
  const { createChat } = await import("../../../../lib/chat");
  const { db } = await import("../../../../lib/db");
  const chat = createChat();

  assert.equal(entry(await get(chat.id), chat.id).title, null);

  // What `finishTurn` does at the end of a first turn, which is always after
  // the page last loaded the list.
  db()
    .prepare("UPDATE chat_sessions SET title=? WHERE id=?")
    .run("Fix the parser", chat.id);

  assert.equal(entry(await get(chat.id), chat.id).title, "Fix the parser");
});

/**
 * What one poll of this route reads, against how long the thread is.
 *
 * The defect: the page re-asked for the whole conversation every three seconds
 * for as long as it was open, so the cost of leaving a chat on screen rose with
 * the chat and never came back down — and the longest conversations, the ones
 * worth having, were the dearest to keep. It is the kind of failure this suite
 * is reserved for: nothing throws, nothing fails a typecheck, and the page is
 * correct in every frame.
 *
 * Stated as work rather than as time, deliberately. A timing here would measure
 * the machine the test ran on; what has to hold is that the same single message
 * arriving onto a thread of twenty and a thread of two hundred is the same
 * amount of payload, and that the read behind it is a range scan over those
 * messages rather than a walk of the thread.
 */

/** A thread with `count` messages, and the `seq` of its last one. */
async function thread(count: number): Promise<{ id: string; lastSeq: number }> {
  const { createChat, appendMessage, listMessages } = await import(
    "../../../../lib/chat"
  );
  const chat = createChat();
  for (let i = 0; i < count; i += 1) {
    appendMessage(chat.id, i % 2 === 0 ? "user" : "assistant", `message ${i}`);
  }
  const last = listMessages(chat.id).at(-1);
  assert.ok(last, "a thread just written must have a last message");
  return { id: chat.id, lastSeq: last.seq };
}

test("a poll carrying a cursor reads the new messages and not the thread", async () => {
  const { appendMessage } = await import("../../../../lib/chat");

  const counts: number[] = [];
  for (const length of [20, 200]) {
    const { id, lastSeq } = await thread(length);

    // What the page loads with: no cursor, the whole conversation.
    const whole = await get(id);
    assert.equal(whole.chat.messages.length, length);
    assert.equal(whole.chat.messagesFrom, 0);

    // One turn lands, and the page polls again from where it got to.
    appendMessage(id, "assistant", "the reply");
    const poll = await get(id, lastSeq);
    assert.equal(poll.chat.messagesFrom, lastSeq);
    assert.deepEqual(
      poll.chat.messages.map((m) => m.text),
      ["the reply"],
    );
    counts.push(poll.chat.messages.length);
  }

  // The whole row in one line: ten times the conversation, the same poll.
  assert.deepEqual(counts, [1, 1]);
});

test("a poll that has seen everything reads nothing at all", async () => {
  const { id, lastSeq } = await thread(50);
  const poll = await get(id, lastSeq);
  assert.deepEqual(poll.chat.messages, []);
});

test("the cursored read is a range scan, not a walk of the thread", async () => {
  // The half a payload assertion cannot see. Before `idx_chat_messages_seq` the
  // cursor bounded only what was *sent*: on `(chat_id, ts)` SQLite answered
  // `seq > ?` by visiting every row of the thread and sorting the survivors in a
  // temp B-tree, so the work per poll still grew with the conversation. Pinned
  // by name because the index is the reason the bound is real, and dropping it
  // would leave every other assertion here green.
  const { db } = await import("../../../../lib/db");
  const plan = db()
    .prepare(
      "EXPLAIN QUERY PLAN SELECT * FROM chat_messages" +
        " WHERE chat_id = ? AND seq > ? ORDER BY seq",
    )
    .all("x", 0) as { detail: string }[];
  const detail = plan.map((row) => row.detail).join(" | ");

  assert.match(detail, /idx_chat_messages_seq/);
  assert.doesNotMatch(detail, /TEMP B-TREE/);
});

test("a cursor the page could not have sent is read as no cursor", async () => {
  // The query string is the one input this page can get wrong on its own, and
  // the honest answer to a broken one is the thread rather than a 400 — the poll
  // is what keeps "Thinking…" from standing for ever.
  const { id } = await thread(5);
  for (const bad of ["", "abc", "-3", "1.5", "9e99"]) {
    const body = await get(id, bad);
    assert.equal(body.chat.messages.length, 5, `?after=${bad}`);
    assert.equal(body.chat.messagesFrom, 0, `?after=${bad}`);
  }
});
