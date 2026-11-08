import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { apiContextTokens, contextTokens } from "./contextSamples";
import { BYTES_PER_TOKEN } from "./fileCostNotice";

/**
 * The two readings of a transcript's size, both pure and both silent when wrong.
 *
 * `apiContextTokens` is what the context chart draws: the API's own count of
 * the last request. Reading the first frame instead of the last, or counting a
 * sub-agent's or a `<synthetic>` frame, draws a plausible line that is not this
 * conversation. `contextTokens` is its fallback, and counting the file rather
 * than the messages inside it is a different quantity, not an approximation.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "uf-ctx-reading-"));

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function transcript(name: string, lines: readonly unknown[]): string {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"));
  return file;
}

describe("apiContextTokens", () => {
  const usageRecord = (
    prompt: { input: number; create: number; read: number; output: number },
    extra: Record<string, unknown> = {},
  ) => ({
    type: "assistant",
    message: {
      role: "assistant",
      model: "claude-opus-5",
      content: "hi",
      usage: {
        input_tokens: prompt.input,
        cache_creation_input_tokens: prompt.create,
        cache_read_input_tokens: prompt.read,
        output_tokens: prompt.output,
      },
    },
    ...extra,
  });

  it("reads the whole prompt however it was billed, plus that turn's output", () => {
    // A cached token is still a token the model reads, so the chart has to
    // count it. Splitting the same prompt across the three fields must not
    // change the answer.
    const file = transcript("usage.jsonl", [
      usageRecord({ input: 100, create: 900, read: 99_000, output: 500 }),
    ]);
    assert.equal(apiContextTokens(file), 100_500);
  });

  it("takes the last turn, not the first", () => {
    const file = transcript("last.jsonl", [
      usageRecord({ input: 10, create: 0, read: 1_000, output: 5 }),
      usageRecord({ input: 10, create: 0, read: 50_000, output: 5 }),
    ]);
    assert.equal(apiContextTokens(file), 50_015);
  });

  it("ignores a sub-agent's turns", () => {
    // A sidechain is its own conversation. Counting it would end a cycle for
    // context this run never carried.
    const file = transcript("sidechain.jsonl", [
      usageRecord({ input: 10, create: 0, read: 1_000, output: 5 }),
      usageRecord({ input: 10, create: 0, read: 90_000, output: 5 }, { isSidechain: true }),
    ]);
    assert.equal(apiContextTokens(file), 1_015);
  });

  it("ignores a <synthetic> frame, whose usage is all zeros", () => {
    const file = transcript("synthetic.jsonl", [
      usageRecord({ input: 10, create: 0, read: 1_000, output: 5 }),
      {
        type: "assistant",
        message: {
          role: "assistant",
          model: "<synthetic>",
          content: "",
          usage: { input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
    ]);
    assert.equal(apiContextTokens(file), 1_015);
  });

  it("is unmoved by message content the API never received", () => {
    // The whole point of the split: content on disk that the request did not
    // carry is counted by `contextTokens` and not by `usage`, which reports
    // what was billed, so this reads the same either way.
    //
    // Note this is *not* the `toolUseResult` case — `contextTokens` already
    // ignores that envelope, and the test above holds it to that.
    const plain = transcript("plain.jsonl", [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "go" }] } },
      usageRecord({ input: 10, create: 0, read: 1_000, output: 5 }),
    ]);
    const fat = transcript("fat.jsonl", [
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "a", content: "x".repeat(400_000) },
          ],
        },
      },
      usageRecord({ input: 10, create: 0, read: 1_000, output: 5 }),
    ]);
    assert.equal(apiContextTokens(plain), apiContextTokens(fat));
    assert.ok(contextTokens(fat) > contextTokens(plain) + 90_000);
  });

  it("falls back to the byte estimate when no usage frame exists", () => {
    // Zero would read as "this run is empty", which a chart of a live run must
    // not say.
    const file = transcript("nousage.jsonl", [
      { type: "assistant", message: { role: "assistant", content: "x".repeat(40_000) } },
    ]);
    assert.equal(apiContextTokens(file), contextTokens(file));
    assert.ok(apiContextTokens(file) > 0);
  });

  it("finds the last turn without reading the whole of a large transcript", () => {
    // The sample is taken on every live-guard tick per live run, so this reads
    // the tail rather than the file. Silent if it is wrong in this direction: a
    // miss reports the byte estimate instead, and the chart stops matching what
    // the API carries. 1.5 MB is past `TAIL_SCAN_BYTES` with the frame inside the window.
    const file = transcript("big-tail.jsonl", [
      { type: "user", message: { role: "user", content: "x".repeat(1_500_000) } },
      usageRecord({ input: 10, create: 0, read: 90_000, output: 5 }),
    ]);
    assert.ok(fs.statSync(file).size > 1_048_576);
    assert.equal(apiContextTokens(file), 90_015);
  });

  it("pays for the whole file when the tail holds no turn at all", () => {
    // One tool result can be larger than the window — the largest transcript on
    // this install is 9.1 MB over 789 lines — so the last frame can sit outside
    // it. Reporting the byte estimate here would be the same silent failure as
    // above, arriving from the one shape the window cannot cover.
    const file = transcript("frame-outside-tail.jsonl", [
      usageRecord({ input: 10, create: 0, read: 90_000, output: 5 }),
      { type: "user", message: { role: "user", content: "x".repeat(1_500_000) } },
    ]);
    assert.equal(apiContextTokens(file), 90_015);
    assert.notEqual(apiContextTokens(file), contextTokens(file));
  });

  it("returns 0 for a transcript it cannot read", () => {
    assert.equal(apiContextTokens("/nonexistent/nope.jsonl"), 0);
  });
});

describe("contextTokens", () => {
  it("counts the message and ignores the envelope around it", () => {
    // The 3.4× overstatement, in miniature. Both records carry the same tiny
    // message; the second also carries a large `toolUseResult`, which the CLI
    // writes into the transcript and never sends to the API. A reading that
    // counted the file would report the second record as far larger than the
    // first.
    const small = transcript("small.jsonl", [
      { type: "assistant", message: { role: "assistant", content: "hi" } },
    ]);
    const withEnvelope = transcript("envelope.jsonl", [
      {
        type: "assistant",
        message: { role: "assistant", content: "hi" },
        toolUseResult: { stdout: "x".repeat(50_000) },
      },
    ]);
    assert.equal(contextTokens(small), contextTokens(withEnvelope));
  });

  it("skips a record with no message at all", () => {
    // Summaries, file-history snapshots and compaction boundaries all sit in the
    // transcript carrying no `message`. Counting them would put content in the
    // total that no turn ever carried.
    const file = transcript("nomsg.jsonl", [
      { type: "summary", summary: "x".repeat(10_000) },
      { type: "assistant", message: { role: "assistant", content: "hi" } },
    ]);
    const only = transcript("only.jsonl", [
      { type: "assistant", message: { role: "assistant", content: "hi" } },
    ]);
    assert.equal(contextTokens(file), contextTokens(only));
  });

  it("survives the torn trailing line a live transcript always has", () => {
    // This runs against a file the CLI is appending to, so the last line is
    // routinely half-written. Throwing here would take out the sample for every
    // run on the tick, and returning 0 would read as "the conversation is
    // empty".
    const file = path.join(TMP, "torn.jsonl");
    fs.writeFileSync(
      file,
      `${JSON.stringify({ message: { role: "user", content: "hello there" } })}\n{"message":{"rol`,
    );
    assert.ok(contextTokens(file) > 0);
  });

  it("answers 0 for a file that is not there rather than throwing", () => {
    // Every caller is on the run loop's path. A transcript that has been swept,
    // or a session id that resolves to nothing, must not end a cycle that is
    // otherwise fine.
    assert.equal(contextTokens(path.join(TMP, "absent.jsonl")), 0);
  });
});

