import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { newChatTurnAccumulator, readChatEvent } from "./chatStream";
import { totalTokens } from "./pricing";

/**
 * What a chat turn's output says while it is still being produced.
 *
 * The whole file exists because the turn used to exist nowhere durable until
 * the child exited, so every way of reading the stream wrongly is silent in the
 * same direction: a turn that produced *less* than it did. Text folded from the
 * wrong field is an empty half-answer; usage read from the wrong key is a
 * ceiling that never sees the money; an event type with no branch is a CLI
 * rename that makes every turn look thinner rather than making one fail.
 *
 * The last is the one with a precedent in this repository and it is why the
 * unknown-type case is here at all — `orchestrator.ts`'s Claude parser has four
 * branches and no fifth, and the Codex parser twelve lines below it spends a
 * docblock on why that is not survivable.
 */

const line = (o: unknown) => JSON.stringify(o);

const assistant = (o: {
  text?: string;
  model?: string;
  usage?: Record<string, unknown>;
  parent?: string;
}) =>
  line({
    type: "assistant",
    session_id: "s-1",
    ...(o.parent ? { parent_tool_use_id: o.parent } : {}),
    message: {
      model: o.model ?? "claude-opus-5",
      content: o.text === undefined ? [] : [{ type: "text", text: o.text }],
      ...(o.usage ? { usage: o.usage } : {}),
    },
  });

describe("readChatEvent", () => {
  it("folds assistant text in the order it arrived", () => {
    const acc = newChatTurnAccumulator();
    assert.equal(readChatEvent(acc, assistant({ text: "Look" })).textGrew, true);
    readChatEvent(acc, assistant({ text: "ing at it." }));
    assert.equal(acc.text, "Looking at it.");
  });

  it("takes only text blocks, and reports no growth when there are none", () => {
    const acc = newChatTurnAccumulator();
    // A tool call is a content block too, and folding its JSON into the
    // transcript would put the machinery in front of the operator.
    const withTool = line({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "one moment" },
          { type: "tool_use", name: "Read", input: { file_path: "/x" } },
        ],
      },
    });
    assert.equal(readChatEvent(acc, withTool).textGrew, true);
    assert.equal(acc.text, "one moment");

    const moved = readChatEvent(acc, assistant({ text: "" }));
    assert.equal(moved.textGrew, false, "an empty block is not progress");
  });

  it("keeps a delegated turn out of the operator's transcript", () => {
    const acc = newChatTurnAccumulator();
    readChatEvent(acc, assistant({ text: "the orchestrator" }));
    readChatEvent(acc, assistant({ text: " and a sub-agent", parent: "tu_1" }));
    // A second voice folded in reads as the orchestrator saying it.
    assert.equal(acc.text, "the orchestrator");
  });

  it("sums the usage the CLI reported and prices it as a guard figure", () => {
    const acc = newChatTurnAccumulator();
    readChatEvent(
      acc,
      assistant({ text: "a", usage: { input_tokens: 100, output_tokens: 50 } }),
    );
    readChatEvent(
      acc,
      assistant({
        text: "b",
        usage: { input_tokens: 200, cache_read_input_tokens: 1_000 },
      }),
    );
    // Summed across requests rather than last-write-wins: each API request
    // bills its own input and its own cache reads, so the second event is more
    // money and not a restatement of the first.
    assert.equal(totalTokens(acc.tokens), 100 + 50 + 200 + 1_000);
    assert.ok(acc.costGuardUSD > 0);
  });

  it("prices an unplaced model rather than charging it nothing", () => {
    const acc = newChatTurnAccumulator();
    readChatEvent(
      acc,
      assistant({
        model: "claude-nextgen-9",
        text: "x",
        usage: { output_tokens: 1_000_000 },
      }),
    );
    // `guardCostOf`'s whole reason: a ceiling that stops existing the day a new
    // model ships is worse than one that over-charges.
    assert.ok(
      acc.costGuardUSD > 0,
      "a model this table cannot place must still cost something to a guard",
    );
  });

  it("tells a 1h cache write from a 5m one when the breakdown is there", () => {
    const flat = newChatTurnAccumulator();
    readChatEvent(
      flat,
      assistant({ usage: { cache_creation_input_tokens: 1_000 } }),
    );
    const split = newChatTurnAccumulator();
    readChatEvent(
      split,
      assistant({
        usage: {
          cache_creation_input_tokens: 1_000,
          cache_creation: { ephemeral_1h_input_tokens: 1_000 },
        },
      }),
    );
    // The 1h rate is 2× against the 5m's 1.25×, so reading the flat field when
    // a breakdown exists under-charges the guard by a third.
    assert.equal(split.tokens.cacheWrite1h, 1_000);
    assert.equal(split.tokens.cacheWriteUnattributed, 0);
    // With no breakdown the volume is neither class, and it is kept in its own
    // field rather than folded into the cheaper one: 5m and 1h are 1.25× and
    // 2×, and a distribution chosen for its direction is still a distribution.
    assert.equal(flat.tokens.cacheWrite5m, 0);
    assert.equal(flat.tokens.cacheWriteUnattributed, 1_000);
    // Which is what closes the gap this test was written for from the other
    // side: the guard prices the unattributed volume at the 1h class it might
    // equally have been, so a transcript with no breakdown can no longer buy a
    // third off every ceiling in the app.
    assert.equal(flat.costGuardUSD, split.costGuardUSD);
  });

  it("takes the session id from the init event, before any answer", () => {
    const acc = newChatTurnAccumulator();
    readChatEvent(acc, line({ type: "system", subtype: "init", session_id: "s-9" }));
    // What lets a turn whose final event never arrived still be resumed.
    assert.equal(acc.sessionId, "s-9");
  });

  it("holds the final result and says it saw one", () => {
    const acc = newChatTurnAccumulator();
    const moved = readChatEvent(
      acc,
      line({ type: "result", subtype: "success", result: "done", total_cost_usd: 0.4 }),
    );
    assert.equal(moved.sawResult, true);
    assert.equal(acc.result?.total_cost_usd, 0.4);
  });

  it("counts an event type it has no branch for, by name", () => {
    const acc = newChatTurnAccumulator();
    readChatEvent(acc, line({ type: "stream_event", delta: {} }));
    readChatEvent(acc, line({ nothing: true }));
    // Dropped silently, a renamed event is a CLI change that makes every turn
    // look thinner rather than making one fail.
    assert.deepEqual([...acc.unknownTypes].sort(), ["(no type)", "stream_event"]);
  });

  it("counts a line that is not JSON at all", () => {
    const acc = newChatTurnAccumulator();
    readChatEvent(acc, "Warning: something happened");
    assert.equal(acc.unreadable, 1);
    // And carries on: one bad line must not cost the rest of the turn.
    readChatEvent(acc, assistant({ text: "still here" }));
    assert.equal(acc.text, "still here");
  });
});
