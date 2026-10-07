import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  EMPTY_CODEX_READING,
  beginCodexCycle,
  endCodexCycle,
  findCodexRollout,
  foldTokenLines,
  noteCodexThread,
  parseTokenCountLine,
  readCodexCycle,
  rolloutDayDirs,
  takeCodexSampleAdvance,
} from "./codexRollout";

/**
 * The Codex session rollout as a cycle's running token count and context size.
 *
 * Every failure here reads as a measurement. A repeated `token_count` counted
 * as a request doubles a cycle's tokens and can stop a run at half its limit;
 * a resumed cycle that re-reads the thread's earlier cycles charges them twice;
 * a line that is not a reading parsed as zeros draws a run that used nothing.
 * The lines are the measured shape (`codex-cli 0.153.4`, 2026-10-07).
 */

const tokenLine = (o: {
  totalIn: number;
  totalOut: number;
  lastIn: number;
  window?: number;
  ts?: string;
}) =>
  JSON.stringify({
    timestamp: o.ts ?? "2026-10-07T19:47:10.932Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: o.totalIn,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: o.totalOut,
          reasoning_output_tokens: 0,
          total_tokens: o.totalIn + o.totalOut,
        },
        last_token_usage: { input_tokens: o.lastIn, output_tokens: 1 },
        model_context_window: o.window ?? 258400,
      },
      rate_limits: { primary: { used_percent: 1.0 } },
    },
  });

describe("parseTokenCountLine", () => {
  it("reads the cycle total as input plus output, and the request's input as its context", () => {
    assert.deepEqual(parseTokenCountLine(tokenLine({ totalIn: 28974, totalOut: 216, lastIn: 15511 })), {
      cycleTokens: 29190,
      contextTokens: 15511,
      contextWindow: 258400,
      at: Date.parse("2026-10-07T19:47:10.932Z"),
    });
  });

  it("reads nothing off a line that is not a reading, rather than zeros", () => {
    assert.equal(parseTokenCountLine('{"type":"event_msg","payload":{"type":"task_started"}}'), null);
    assert.equal(
      parseTokenCountLine('{"type":"event_msg","payload":{"type":"token_count","info":null}}'),
      null,
    );
    assert.equal(
      parseTokenCountLine(
        '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":"9"}}}}',
      ),
      null,
    );
    assert.equal(parseTokenCountLine('{"type":"event_msg" token_count'), null);
  });
});

describe("foldTokenLines", () => {
  it("counts a request only when the total moves, so a repeated reading is not a second request", () => {
    const lines = [
      tokenLine({ totalIn: 13463, totalOut: 105, lastIn: 13463 }),
      tokenLine({ totalIn: 13463, totalOut: 105, lastIn: 13463 }),
      tokenLine({ totalIn: 28974, totalOut: 216, lastIn: 15511 }),
      '{"type":"response_item","payload":{}}',
    ];
    const reading = foldTokenLines(EMPTY_CODEX_READING, lines);
    assert.equal(reading.requests, 2);
    assert.equal(reading.tokens, 29190);
    assert.equal(reading.contextTokens, 15511);
    assert.equal(reading.contextWindow, 258400);
  });

  it("is incremental: folding in two halves gives the whole", () => {
    const lines = [
      tokenLine({ totalIn: 100, totalOut: 10, lastIn: 100 }),
      tokenLine({ totalIn: 300, totalOut: 20, lastIn: 200 }),
      tokenLine({ totalIn: 600, totalOut: 30, lastIn: 300 }),
    ];
    const whole = foldTokenLines(EMPTY_CODEX_READING, lines);
    const halves = foldTokenLines(foldTokenLines(EMPTY_CODEX_READING, lines.slice(0, 1)), lines.slice(1));
    assert.deepEqual(halves, whole);
  });
});

describe("rolloutDayDirs", () => {
  it("reads the day off a UUIDv7 thread id, with the day either side", () => {
    assert.deepEqual(rolloutDayDirs("01a117e7-bf8e-7322-ba15-85a0bdf616ea", 0), [
      path.join("2026", "10", "06"),
      path.join("2026", "10", "07"),
      path.join("2026", "10", "08"),
    ]);
  });
});

describe("the cycle tracker, against files on disk", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "uf-codex-rollout-"));
  after(() => fs.rmSync(home, { recursive: true, force: true }));
  const thread = "01a117e7-bf8e-7322-ba15-85a0bdf616ea";
  const dir = path.join(home, "sessions", "2026", "10", "07");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-10-07T19-47-06-${thread}.jsonl`);

  it("finds a thread's file by its id", () => {
    fs.writeFileSync(file, "");
    assert.equal(findCodexRollout(thread, home), file);
    assert.equal(findCodexRollout("../etc/passwd", home), null);
  });

  it("reads a new thread from its start, line by line as it is written", () => {
    fs.writeFileSync(file, "");
    beginCodexCycle("run-1", null, home);
    assert.deepEqual(readCodexCycle("run-1", home), EMPTY_CODEX_READING, "no thread yet, no reading");
    noteCodexThread("run-1", thread);
    fs.appendFileSync(file, `${tokenLine({ totalIn: 13463, totalOut: 105, lastIn: 13463 })}\n`);
    // A line written in two pieces is read once it is whole, never as a stub.
    const next = tokenLine({ totalIn: 28974, totalOut: 216, lastIn: 15511 });
    fs.appendFileSync(file, next.slice(0, 40));
    assert.equal(readCodexCycle("run-1", home)?.tokens, 13568);
    fs.appendFileSync(file, `${next.slice(40)}\n`);
    assert.equal(readCodexCycle("run-1", home)?.tokens, 29190);
    assert.deepEqual(takeCodexSampleAdvance("run-1"), { advanced: 2, freshThread: true });
    assert.deepEqual(takeCodexSampleAdvance("run-1"), { advanced: 0, freshThread: true });
    const done = endCodexCycle("run-1", home);
    assert.equal(done?.reading.requests, 2);
    assert.equal(readCodexCycle("run-1", home), null, "the tracker stops with the cycle");
  });

  it("reads a resumed thread from where its earlier cycles end, never counting them twice", () => {
    // The file already holds cycle one when cycle two begins.
    beginCodexCycle("run-1", thread, home);
    assert.equal(readCodexCycle("run-1", home)?.tokens, 0);
    fs.appendFileSync(file, `${tokenLine({ totalIn: 16850, totalOut: 210, lastIn: 16850 })}\n`);
    const reading = readCodexCycle("run-1", home);
    assert.equal(reading?.tokens, 17060);
    assert.equal(reading?.requests, 1);
    assert.deepEqual(endCodexCycle("run-1", home)?.freshThread, false);
  });

  it("answers null for a run with no Codex cycle, and an unreadable file as no reading", () => {
    assert.equal(readCodexCycle("nobody", home), null);
    beginCodexCycle("run-2", "01a117e7-0000-7000-8000-000000000000", home);
    assert.deepEqual(readCodexCycle("run-2", home), EMPTY_CODEX_READING);
    endCodexCycle("run-2", home);
  });
});
