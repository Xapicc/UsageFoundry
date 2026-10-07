import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ContextOccupancyDTO } from "./apiTypes";
import {
  LIVE_TEXT_CHARS,
  boundTail,
  clipForTile,
  contextForTile,
  diffRoster,
  liveCounts,
  replayShare,
  sameCounts,
} from "./liveStream";
import { clipToolInput, describeEvent } from "./logLine";
import type { PersistedRunEvent } from "./orchestrator";

/**
 * The bounds on `/api/runs/live/stream`, which is one connection carrying
 * every running run's log.
 *
 * It earns a test on the per-run route's grounds, multiplied: a replay bounded
 * by rows and not bytes is a response of tens of megabytes held in the stream's
 * queue, once per open dashboard; a tile sent a `Write`'s body where it draws a
 * line is that again on every edit an agent makes; and a tile line that differs
 * from the run page's line for the same event is two pages disagreeing about
 * what an agent did. None of them throws or fails a typecheck.
 */

let seq = 0;
function event(kind: string, payload: Record<string, unknown>): PersistedRunEvent {
  return {
    id: ++seq,
    runId: "run-a",
    ts: 1_700_000_000_000 + seq,
    kind: kind as PersistedRunEvent["kind"],
    payload,
  };
}

describe("a tool event on a tile", () => {
  it("renders the run page's line, whatever the stored input held", () => {
    const inputs: unknown[] = [
      // A `Write` whose body is the file, stored at the clip's ceiling.
      clipToolInput({ file_path: "src/a.ts", content: "x".repeat(20_000) }).input,
      // A heredoc, which the line flattens.
      { command: "cat <<'EOF'\nline one\nline two\nEOF", description: "write" },
      // No headline field, so the line is the raw JSON, clipped.
      { alpha: "a".repeat(500), beta: 2 },
      {},
      null,
    ];
    for (const input of inputs) {
      const original = event("tool", { name: "Write", input, truncatedFrom: 20_000 });
      assert.deepEqual(describeEvent(clipForTile(original)), describeEvent(original));
    }
  });

  it("carries one line rather than the body", () => {
    const { input } = clipToolInput({ file_path: "a.ts", content: "y".repeat(20_000) });
    const clipped = clipForTile(event("tool", { name: "Write", input }));
    assert.equal(typeof clipped.payload.input, "string");
    assert.ok(String(clipped.payload.input).length <= 160);
  });

  it("keeps the fields the line attributes the call with", () => {
    const original = event("tool", {
      name: "Grep",
      input: { pattern: "foo" },
      parentToolUseId: "toolu_1",
      subagent: "Explore",
      truncatedFrom: 9_000,
    });
    const clipped = clipForTile(original);
    assert.equal(clipped.payload.subagent, "Explore");
    assert.equal(clipped.payload.parentToolUseId, "toolu_1");
    assert.equal(clipped.payload.truncatedFrom, 9_000);
  });
});

describe("any other event on a tile", () => {
  it("cuts a long string and marks the cut", () => {
    const clipped = clipForTile(event("assistant", { text: "z".repeat(5_000) }));
    const text = String(clipped.payload.text);
    assert.equal(text.length, LIVE_TEXT_CHARS);
    assert.ok(text.endsWith("…"));
  });

  it("leaves a short string, a number and the event's identity alone", () => {
    const original = event("log", { message: "short", droppedEvents: 12 });
    const clipped = clipForTile(original);
    assert.deepEqual(clipped, original);
  });

  it("reaches strings nested inside the payload", () => {
    const clipped = clipForTile(
      event("handoff", { notes: { body: "n".repeat(2_000) }, files: ["f".repeat(900)] }),
    );
    const notes = clipped.payload.notes as { body: string };
    const files = clipped.payload.files as string[];
    assert.equal(notes.body.length, LIVE_TEXT_CHARS);
    assert.equal(files[0].length, LIVE_TEXT_CHARS);
  });

  it("does not touch the stored event", () => {
    const original = event("assistant", { text: "q".repeat(5_000) });
    clipForTile(original);
    assert.equal(String(original.payload.text).length, 5_000);
  });
});

describe("a tail cut to a byte budget", () => {
  const size = (n: number) => n;

  it("keeps everything that fits, in order, and drops nothing", () => {
    assert.deepEqual(boundTail([10, 20, 30], 100, size), {
      kept: [10, 20, 30],
      droppedForBytes: 0,
    });
  });

  it("drops the oldest first and counts what it dropped", () => {
    assert.deepEqual(boundTail([40, 10, 20, 30], 55, size), {
      kept: [20, 30],
      droppedForBytes: 2,
    });
  });

  it("keeps the newest event even when it alone is over", () => {
    assert.deepEqual(boundTail([5, 500], 100, size), {
      kept: [500],
      droppedForBytes: 1,
    });
  });

  it("is empty only for an empty tail", () => {
    assert.deepEqual(boundTail([], 100, size), { kept: [], droppedForBytes: 0 });
  });
});

describe("a replay's budget across runs", () => {
  it("is split evenly, so one run's large events cannot empty another's tile", () => {
    assert.equal(replayShare(1_000, 4), 250);
  });

  it("goes whole to a single run, and is not divided by zero", () => {
    assert.equal(replayShare(1_000, 1), 1_000);
    assert.equal(replayShare(1_000, 0), 1_000);
  });
});

describe("which runs to follow", () => {
  it("joins a run that started and leaves one that stopped", () => {
    assert.deepEqual(diffRoster(["a", "b"], ["b", "c"]), {
      joined: ["c"],
      left: ["a"],
    });
  });

  it("changes nothing when the set has not moved", () => {
    assert.deepEqual(diffRoster(new Map([["a", 1]]).keys(), ["a"]), {
      joined: [],
      left: [],
    });
  });
});

describe("the strip's counts", () => {
  it("counts the four statuses it names and nothing else", () => {
    assert.deepEqual(
      liveCounts([
        { status: "running" },
        { status: "running" },
        { status: "queued" },
        { status: "paused" },
        { status: "waiting-for-stack" },
        { status: "waiting" },
        { status: "completed" },
      ]),
      { running: 2, queued: 1, paused: 1, "waiting-for-stack": 1 },
    );
  });

  /**
   * `activeRuns()` returns this row and the strip is the page's only word on
   * it, so leaving it out read "0 running · 0 queued · 0 paused" over a run
   * that will not move until a person answers it.
   */
  it("counts a run waiting for a stack", () => {
    assert.deepEqual(liveCounts([{ status: "waiting-for-stack" }]), {
      running: 0,
      queued: 0,
      paused: 0,
      "waiting-for-stack": 1,
    });
  });

  it("sees a change in the waiting-for-stack count alone", () => {
    const before = liveCounts([{ status: "running" }]);
    const after = liveCounts([{ status: "running" }, { status: "waiting-for-stack" }]);
    assert.equal(sameCounts(before, after), false);
    assert.equal(sameCounts(after, after), true);
  });
});

describe("a tile's context", () => {
  it("keeps the newest reading and the counts, and none of the series", () => {
    const sample = (ts: number, tokens: number) => ({
      ts,
      iteration: 1,
      tokens,
      basis: "api" as const,
      turnIndex: 1,
      turnsExact: true,
    });
    const full: ContextOccupancyDTO = {
      ceilingTokens: 200_000,
      ceilingKind: "cycle",
      samples: [sample(1, 10_000), sample(2, 40_000)],
      sampleCount: 37,
      prunes: [{ ts: 1, trigger: "boundary", tokensRemoved: 5_000 }],
      pruneCount: 3,
      lastCheck: { ts: 3, basis: "api" },
      composition: [],
      compositionCount: 2,
      compositionAbsence: null,
    };
    const tile = contextForTile(full);
    assert.deepEqual(tile.samples, [sample(2, 40_000)]);
    assert.deepEqual(tile.prunes, []);
    assert.equal(tile.sampleCount, 37);
    assert.equal(tile.pruneCount, 3);
    assert.equal(tile.ceilingTokens, 200_000);
    assert.deepEqual(tile.lastCheck, full.lastCheck);
  });
});
