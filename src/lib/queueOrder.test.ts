import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { queueCompare, queueOrder } from "./orchestrator";

/**
 * The order the queue is considered in.
 *
 * Its failure mode is the quiet one: a comparator that ignored `priority`
 * behaves identically to a working one on every install where nobody has set
 * one, which is every install today. So the first case here is the one that
 * would catch that, and the last is the one that would catch the opposite
 * mistake — a priority sort that quietly stopped being stable and started
 * reordering runs an operator never touched.
 */
const at = (created_at: number, priority = 0, id = String(created_at), seq = created_at) =>
  ({ id, created_at, priority, seq });

describe("queueOrder puts priority first and keeps age as the tie-break", () => {
  it("promotes a higher priority ahead of an older run", () => {
    const order = queueOrder([at(100, 0, "old"), at(200, 5, "urgent")]);
    assert.deepEqual(order.map((r) => r.id), ["urgent", "old"]);
  });

  it("leaves an untouched queue in exactly arrival order", () => {
    // The property that makes this safe to ship: with no priority set anywhere,
    // the queue behaves precisely as it did before the column existed.
    const arrival = [at(1), at(2), at(3), at(4)];
    assert.deepEqual(
      queueOrder(arrival).map((r) => r.id),
      arrival.map((r) => r.id),
    );
  });

  it("orders equal priorities by age, oldest first", () => {
    const order = queueOrder([at(300, 7, "c"), at(100, 7, "a"), at(200, 7, "b")]);
    assert.deepEqual(order.map((r) => r.id), ["a", "b", "c"]);
  });

  it("treats a missing or null priority as 0 rather than as last", () => {
    // Rows written before the column existed read back as 0 through the
    // DEFAULT, but a null arriving from anywhere else must not sink a run to
    // the bottom of a queue silently.
    const order = queueOrder([
      { id: "null", created_at: 100, priority: null, seq: 1 },
      { id: "zero", created_at: 200, priority: 0, seq: 2 },
      { id: "neg", created_at: 50, priority: -1, seq: 3 },
    ]);
    assert.deepEqual(order.map((r) => r.id), ["null", "zero", "neg"]);
  });

  it("does not mutate the array it was given", () => {
    const runs = [at(200, 1, "b"), at(100, 9, "a")];
    const before = runs.map((r) => r.id);
    queueOrder(runs);
    assert.deepEqual(runs.map((r) => r.id), before);
  });
});

/**
 * The shown position and the promoted order, which must be one answer.
 *
 * `queueOrder` arrived described as "the single definition of what runs next",
 * and `queuePosition` — the only place that order is ever rendered — kept
 * counting `created_at` alone. The result was a lever whose readout did not
 * move: raise a run to the front, watch it start first, and the page still says
 * it is queued behind three others. Silent in the way this file exists for,
 * because on an install where nobody sets a priority the two agree exactly.
 *
 * `queueCompare` is asserted rather than `queuePosition` itself: the position
 * counts over `activeRuns()` and a folder-overlap test, both of which need a
 * database, and neither is the half that was wrong.
 */
describe("queueCompare is the one order both the queue and its readout use", () => {
  it("counts a higher-priority run as ahead of an older one", () => {
    // Negative means "considered first". The newer run wins on its lever, so a
    // position counting `queueCompare(other, self) < 0` counts it as ahead.
    assert.ok(queueCompare(at(200, 5), at(100, 0)) < 0);
    assert.ok(queueCompare(at(100, 0), at(200, 5)) > 0);
  });

  it("falls back to age when priorities match, which is every install today", () => {
    assert.ok(queueCompare(at(100), at(200)) < 0);
    assert.ok(queueCompare(at(200), at(100)) > 0);
  });

  it("breaks a same-millisecond pair on write order, as the queue band's SQL does", () => {
    // A fan-out's runs share a `created_at`. This answered 0 for them, so the
    // walk kept whatever order `activeRuns` returned while the band sorted on
    // `id`, and `queuePosition` counted each of the pair as ahead of the other.
    assert.ok(queueCompare(at(100, 0, "first", 1), at(100, 0, "second", 2)) < 0);
    assert.ok(queueCompare(at(100, 0, "second", 2), at(100, 0, "first", 1)) > 0);
    // Handed in backwards, as a plan that sought another index could return
    // them: the walk's order is the rows' own, not the input's.
    const batch = [1, 2, 3, 4, 5, 6, 7, 8].map((seq) => at(100, 0, `w${seq}`, seq));
    assert.deepEqual(
      queueOrder([...batch].reverse()).map((r) => r.id),
      batch.map((r) => r.id),
    );
  });

  it("orders by the same rule queueOrder sorts by", () => {
    const runs = [at(100, 0, "old"), at(300, 9, "urgent"), at(200, 0, "mid")];
    const sorted = queueOrder(runs).map((r) => r.id);
    const byCompare = [...runs].sort(queueCompare).map((r) => r.id);
    assert.deepEqual(sorted, byCompare);
    assert.deepEqual(sorted, ["urgent", "old", "mid"]);
  });
});
