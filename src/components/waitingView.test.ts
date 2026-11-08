import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { WaitingDTO, WaitingReadingDTO } from "../lib/apiTypes";
import { waitingView } from "./waitingView";

/**
 * The dashboard's "waiting on you" line, from five readings.
 *
 * The failure here is a number that says less than it knows or more: a read that
 * failed printed as 0 tells the operator nothing is waiting when nothing was
 * asked, a count over one page of branches printed as the whole hides the older
 * unmerged branch it missed, and the quiet sentence shown over either one is the
 * same lie said in words. Nothing throws, and the page looks calm.
 */

const exact = (count: number): WaitingReadingDTO => ({ state: "exact", count });
const floor = (count: number): WaitingReadingDTO => ({ state: "floor", count });
const unknown: WaitingReadingDTO = { state: "unknown", reason: "database is locked" };

const dto = (over: Partial<WaitingDTO> = {}): WaitingDTO => ({
  needsReview: exact(0),
  failedRecently: exact(0),
  branches: exact(0),
  proposals: exact(0),
  tasks: exact(0),
  failedSince: 0,
  ...over,
});

const labels = (view: ReturnType<typeof waitingView>): string[] =>
  view.kind === "items"
    ? view.items.map((i) => (i.count === null ? i.label : `${i.count} ${i.label}`))
    : [];

test("an item whose count is zero is left out, and the rest keep their order and their link", () => {
  const view = waitingView(dto({ needsReview: exact(2), proposals: exact(1), tasks: exact(4) }), false);
  assert.equal(view.kind, "items");
  assert.deepEqual(labels(view), [
    "2 runs need review",
    "1 chat proposal waiting",
    "4 operator-only tasks open",
  ]);
  if (view.kind !== "items") return;
  assert.deepEqual(
    view.items.map((i) => i.href),
    ["/runs", "/chat", "/tasks"],
  );
});

test("every count read in full and zero is the one quiet line, and nothing else", () => {
  assert.deepEqual(waitingView(dto(), false), { kind: "quiet" });
});

test("a read that failed says which count is unknown, and is never a zero", () => {
  const view = waitingView(dto({ branches: unknown }), false);
  assert.deepEqual(labels(view), ["Branches ready to land: unknown"]);
  // The quiet sentence would be the same claim as a zero for it.
  assert.notEqual(view.kind, "quiet");
});

test("known and unknown mix: the known counts stand, the unknown one is named beside them", () => {
  const view = waitingView(
    dto({ needsReview: exact(1), failedRecently: unknown, tasks: exact(3) }),
    false,
  );
  assert.deepEqual(labels(view), [
    "1 run needs review",
    "Runs failed in the last 24 hours: unknown",
    "3 operator-only tasks open",
  ]);
});

test("a floor is said as at least, and a floor of zero is not a zero", () => {
  assert.deepEqual(labels(waitingView(dto({ branches: floor(7) }), false)), [
    "At least 7 branches ready to land",
  ]);

  const none = waitingView(dto({ branches: floor(0) }), false);
  assert.deepEqual(labels(none), ["Branches ready to land: not all checked"]);
  assert.notEqual(none.kind, "quiet");
});

test("one is singular", () => {
  assert.deepEqual(
    labels(
      waitingView(
        dto({
          needsReview: exact(1),
          failedRecently: exact(1),
          branches: exact(1),
          proposals: exact(1),
          tasks: exact(1),
        }),
        false,
      ),
    ),
    [
      "1 run needs review",
      "1 run failed in the last 24 hours",
      "1 branch ready to land",
      "1 chat proposal waiting",
      "1 operator-only task open",
    ],
  );
});

test("a failed poll beats an answer held from before it, and nothing read yet is loading", () => {
  // The held answer says nothing waits; after a failed poll that can no longer be vouched for.
  assert.deepEqual(waitingView(dto(), true), { kind: "failed" });
  assert.deepEqual(waitingView(null, true), { kind: "failed" });
  assert.deepEqual(waitingView(null, false), { kind: "loading" });
});
