import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mergeMessages, threadItems, turnStartInstant } from "./chatThread";
import type { ChatMessageDTO, ChatQuestionDTO } from "./apiTypes";

/**
 * Where a question is drawn in the transcript.
 *
 * It earns a test on the grounds the other three question functions do — every
 * way of getting it wrong produces a *page* rather than an error — and the
 * worst of them is silent in the direction no other surface here can be: a
 * question that is never drawn leaves the thread waiting for an answer to
 * something the operator was never shown, with nothing on screen saying so.
 * Nothing throws, nothing fails to typecheck, and the chat reads as idle.
 *
 * The rest of the cases pin the pairing the panel is built on: an answered
 * question sits directly above the message that carried the answer, and a
 * pending one sits at the foot of the thread beside the composer.
 *
 * `turnStartInstant` is here on the same grounds one function over: it decides
 * what the clock beside "Thinking…" counts from, and every way of getting it
 * wrong renders a *duration* — plausible, wrong, and the number an operator
 * uses to decide whether to keep waiting or stop a turn and lose what the child
 * has done.
 */

// `seq` defaults to the timestamp because `threadItems` never reads it and the
// cases above are written in distinct, increasing `ts`. `mergeMessages` reads
// nothing else, so its cases pass it.
function msg(
  id: string,
  role: ChatMessageDTO["role"],
  ts: number,
  seq = ts,
): ChatMessageDTO {
  return { id, ts, seq, role, text: id };
}

function question(id: string, createdAt: number): ChatQuestionDTO {
  return {
    id,
    createdAt,
    question: id,
    choices: [],
    allowText: true,
    status: "pending",
    answer: null,
    answeredAt: null,
  };
}

/** Ids in render order, a question item as the ids it holds. */
function order(items: ReturnType<typeof threadItems>): string[] {
  return items.map((item) =>
    item.kind === "message"
      ? item.message.id
      : `[${item.questions.map((q) => q.id).join(",")}]`,
  );
}

test("a question nobody has answered is drawn, at the foot of the thread", () => {
  const items = threadItems(
    [msg("ask", "user", 1_000), msg("reply", "assistant", 3_000)],
    [question("q1", 2_000)],
  );
  assert.deepEqual(order(items), ["ask", "reply", "[q1]"]);
});

test("a question outlives a thread with no messages at all", () => {
  // Reachable: the first turn of a chat can ask before it has replied, and a
  // turn that dies leaves the row behind. Dropped here, the chat waits for ever.
  const items = threadItems([], [question("q1", 2_000)]);
  assert.deepEqual(order(items), ["[q1]"]);
});

test("an answered question is drawn directly above the message answering it", () => {
  const items = threadItems(
    [
      msg("ask", "user", 1_000),
      msg("reply", "assistant", 3_000),
      msg("answer", "user", 9_000),
      msg("proposal", "assistant", 11_000),
    ],
    [question("q1", 2_000)],
  );
  assert.deepEqual(order(items), ["ask", "reply", "[q1]", "answer", "proposal"]);
});

test("questions asked by one turn stay one item, in the order asked", () => {
  // They share a `created_at` — `createQuestions` takes one `now` for the call
  // — so only the arrival order tells them apart, and the answer message quotes
  // them back in it.
  const items = threadItems(
    [msg("ask", "user", 1_000), msg("reply", "assistant", 3_000)],
    [question("q1", 2_000), question("q2", 2_000), question("q3", 2_000)],
  );
  assert.deepEqual(order(items), ["ask", "reply", "[q1,q2,q3]"]);
});

test("two turns' questions land at their own messages, never merged", () => {
  const items = threadItems(
    [
      msg("ask", "user", 1_000),
      msg("reply", "assistant", 3_000),
      msg("answer", "user", 9_000),
      msg("second", "assistant", 13_000),
      msg("again", "user", 19_000),
    ],
    [question("q1", 2_000), question("q2", 11_000)],
  );
  assert.deepEqual(order(items), [
    "ask",
    "reply",
    "[q1]",
    "answer",
    "second",
    "[q2]",
    "again",
  ]);
});

test("a question is never drawn above the message that provoked it", () => {
  // The strict comparison. `sendChatMessage` appends the message and only then
  // spawns the child that asks, so the two can land on one millisecond — and a
  // `<=` here would put the card above the sentence it is answering.
  const items = threadItems(
    [msg("ask", "user", 1_000), msg("reply", "assistant", 3_000)],
    [question("q1", 1_000)],
  );
  assert.deepEqual(order(items), ["ask", "reply", "[q1]"]);
});

test("an assistant or system message never separates a question from its answer", () => {
  // Only a *user* message closes the placement, because everything between the
  // question and the operator's next message is the rest of the turn that asked
  // — including the failure notice a turn that died leaves behind.
  const items = threadItems(
    [
      msg("ask", "user", 1_000),
      msg("failed", "system", 4_000),
      msg("answer", "user", 9_000),
    ],
    [question("q1", 2_000)],
  );
  assert.deepEqual(order(items), ["ask", "failed", "[q1]", "answer"]);
});

test("no questions is the transcript unchanged", () => {
  const messages = [msg("ask", "user", 1_000), msg("reply", "assistant", 3_000)];
  assert.deepEqual(order(threadItems(messages, [])), ["ask", "reply"]);
});

test("the turn's clock counts from the claim, not from the last write", () => {
  // The defect this exists against: a turn writes into its own thread —
  // `save_template` appends a note mid-turn — and taking the later of the two
  // put a nine-minute turn back at zero seconds, on the one line the operator
  // reads to decide whether to wait.
  assert.equal(turnStartInstant(1_000, 500_000), 1_000);
  // A row claimed before `turn_started_at` existed has no start instant, which
  // is `staleTurn`'s own fallback and not "no clock": the thread's last write
  // is the nearest thing there is to one.
  assert.equal(turnStartInstant(null, 500_000), 500_000);
  assert.equal(turnStartInstant(undefined, 500_000), 500_000);
  // Neither is a render with no chat loaded. Null rather than 0, which the
  // caller would draw as the elapsed time since 1970.
  assert.equal(turnStartInstant(null, null), null);
  assert.equal(turnStartInstant(undefined, undefined), null);
});

/**
 * What a poll's answer does to the thread already on screen.
 *
 * The poll asks for the messages past the highest `seq` it holds, so the answer
 * is a tail and the page has to put it back together. Every way of getting that
 * wrong renders a transcript rather than an error, which is the bar this file
 * was opened at: a dropped tail is a paragraph missing from the middle of a
 * conversation with nothing to say so, and a kept duplicate is the model
 * appearing to answer twice.
 */
test("a tail is appended to the thread already held", () => {
  const held = [msg("a", "user", 1_000, 1), msg("b", "assistant", 2_000, 2)];
  const merged = mergeMessages(held, [msg("c", "user", 3_000, 3)], 2);
  assert.deepEqual(
    merged.map((m) => m.id),
    ["a", "b", "c"],
  );
});

test("a whole thread replaces what is held, however long that is", () => {
  // Zero is what a send, a cancel, an answer, a decision and the first load all
  // answer with, and what a broken `?after=` falls back to. Appending one would
  // draw the whole conversation twice.
  const held = [msg("a", "user", 1_000, 1), msg("b", "assistant", 2_000, 2)];
  const merged = mergeMessages(held, held, 0);
  assert.deepEqual(
    merged.map((m) => m.id),
    ["a", "b"],
  );
});

test("two polls carrying one cursor do not say the same message twice", () => {
  // The interval fires whether or not the last request has answered, so two
  // polls on the same cursor are ordinary rather than exotic — and the second
  // one's answer overlaps the first's entirely.
  const held = [msg("a", "user", 1_000, 1)];
  const first = mergeMessages(held, [msg("b", "assistant", 2_000, 2)], 1);
  const second = mergeMessages(first, [msg("b", "assistant", 2_000, 2)], 1);
  assert.deepEqual(
    second.map((m) => m.id),
    ["a", "b"],
  );
});

test("a poll that adds nothing hands back the very same array", () => {
  // Reference equality, not contents: this is the shape of nearly every poll,
  // and a fresh array each time re-renders every message in the thread to say
  // that nothing has changed.
  const held = [msg("a", "user", 1_000, 1)];
  assert.equal(mergeMessages(held, [], 1), held);
});

test("what a poll merges does not grow with the length of the thread", () => {
  // The whole of G5 in one assertion, and stated as work rather than as time:
  // the same single message arrives onto a thread of ten and a thread of a
  // thousand, and both merges consider exactly what the answer carried.
  const thread = (n: number) =>
    Array.from({ length: n }, (_, i) => msg(`m${i}`, "user", i + 1, i + 1));
  const arriving = (n: number) => [msg("new", "assistant", n + 1, n + 1)];

  for (const n of [10, 1_000]) {
    const held = thread(n);
    const merged = mergeMessages(held, arriving(n), n);
    assert.equal(merged.length, n + 1);
    assert.equal(merged.at(-1)?.id, "new");
  }
});
