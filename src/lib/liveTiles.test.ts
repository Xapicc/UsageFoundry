import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LIVE_TAIL_EVENTS, type LiveFrameDTO, type RunEventDTO } from "./apiTypes";
import { EMPTY_LIVE, applyLiveFrame, type LiveState } from "./liveTiles";

/**
 * `/runs/live` as a fold over its one stream.
 *
 * It earns a test because every way of getting this wrong renders a page that
 * looks right. A reconnect replays every running run's tail, so a `join`
 * appended rather than replacing doubles each tile's log once per dropped
 * connection — and a repeated block is indistinguishable from an agent that did
 * the same thing twice. A tile that survives the `ready` naming the runs still
 * running is a run that ended while the connection was down, sitting on screen
 * as an agent gone quiet. A tail never trimmed grows for as long as the tab is
 * open.
 */

let seq = 0;
function line(runId: string, message = "working"): RunEventDTO {
  seq += 1;
  return { id: seq, runId, ts: seq, kind: "log", payload: { message } };
}

function fold(frames: LiveFrameDTO[], from: LiveState = EMPTY_LIVE): LiveState {
  return frames.reduce(applyLiveFrame, from);
}

const join = (runId: string, events: RunEventDTO[], dropped = 0): LiveFrameDTO => ({
  kind: "join",
  runId,
  events,
  dropped,
  tools: [],
});

describe("a connection opening", () => {
  it("is not ready, and so not empty, until the replay says so", () => {
    const state = fold([join("a", [line("a")])]);
    assert.equal(state.ready, false);
    assert.equal(fold([{ kind: "ready", runIds: [] }]).ready, true);
  });

  it("puts tiles in the order their runs joined", () => {
    const state = fold([join("a", []), join("b", []), { kind: "ready", runIds: ["a", "b"] }]);
    assert.deepEqual(
      state.tiles.map((t) => t.runId),
      ["a", "b"],
    );
  });
});

describe("a reconnect", () => {
  it("replaces each tail rather than adding to it", () => {
    const tail = [line("a", "one"), line("a", "two")];
    const first = fold([join("a", tail), join("b", []), { kind: "ready", runIds: ["a", "b"] }]);
    const again = fold([join("a", tail, 4), { kind: "ready", runIds: ["a", "b"] }], first);
    assert.deepEqual(again.tiles[0].events, tail);
    assert.equal(again.tiles[0].dropped, 4);
    // In place, so a tile does not jump to the end of the grid.
    assert.deepEqual(
      again.tiles.map((t) => t.runId),
      ["a", "b"],
    );
  });

  it("drops the tile of a run that stopped while the connection was down", () => {
    const first = fold([join("a", []), join("b", []), { kind: "ready", runIds: ["a", "b"] }]);
    const again = fold([join("b", []), { kind: "ready", runIds: ["b"] }], first);
    assert.deepEqual(
      again.tiles.map((t) => t.runId),
      ["b"],
    );
  });
});

describe("live frames", () => {
  const opened = fold([join("a", [line("a")]), join("b", []), { kind: "ready", runIds: ["a", "b"] }]);

  it("append to their own run's tile", () => {
    const e = line("b");
    const state = applyLiveFrame(opened, { kind: "event", runId: "b", event: e });
    assert.deepEqual(state.tiles[1].events, [e]);
    assert.equal(state.tiles[0], opened.tiles[0]);
  });

  it("keep the tail at its length and count what fell off", () => {
    let state = fold([join("a", [], 7), { kind: "ready", runIds: ["a"] }]);
    for (let i = 0; i < LIVE_TAIL_EVENTS + 3; i++) {
      state = applyLiveFrame(state, { kind: "event", runId: "a", event: line("a", `n${i}`) });
    }
    const tile = state.tiles[0];
    assert.equal(tile.events.length, LIVE_TAIL_EVENTS);
    assert.equal(tile.events.at(-1)?.payload.message, `n${LIVE_TAIL_EVENTS + 2}`);
    assert.equal(tile.dropped, 7 + 3);
  });

  it("for a run with no tile change nothing", () => {
    const state = applyLiveFrame(opened, { kind: "event", runId: "z", event: line("z") });
    assert.equal(state, opened);
  });

  it("replace the open tool calls whole", () => {
    const tools = [
      {
        toolUseId: "t1",
        name: "Bash",
        command: "npm test",
        startedAt: 1,
        seenAt: 2,
        retry: null,
      },
    ];
    const state = applyLiveFrame(opened, { kind: "tools", runId: "a", tools });
    assert.deepEqual(state.tiles[0].tools, tools);
    assert.deepEqual(applyLiveFrame(state, { kind: "tools", runId: "a", tools: [] }).tiles[0].tools, []);
  });

  it("remove a tile when its run leaves, and only that tile", () => {
    const state = applyLiveFrame(opened, { kind: "leave", runId: "a" });
    assert.deepEqual(
      state.tiles.map((t) => t.runId),
      ["b"],
    );
  });

  it("carry the counts through", () => {
    const counts = { running: 2, queued: 1, paused: 0, "waiting-for-stack": 0 };
    assert.deepEqual(applyLiveFrame(opened, { kind: "counts", counts }).counts, counts);
  });
});
