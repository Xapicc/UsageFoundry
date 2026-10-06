import { strict as assert } from "node:assert";
import { test } from "node:test";
import { startPoll } from "./poll";

/**
 * A page's poll, and the two ways it goes wrong without anything on the page
 * saying so.
 *
 * Two requests out at once is the first: their answers land in whichever order
 * the server finishes them, and the page draws the older one last. Polling on
 * after the page has gone is the second, and the shape that invites it is this
 * one — a stop that clears the pending timer but not the re-arm a load still in
 * flight is about to make keeps an unmounted page polling for the life of the
 * tab. Neither throws, renders wrong or shows in a typecheck.
 */

/** A load whose answer arrives only when the test says so. */
function heldLoad() {
  const answers: (() => void)[] = [];
  return {
    load: () => new Promise<void>((resolve) => answers.push(resolve)),
    calls: () => answers.length,
    answer: (i: number) => answers[i](),
  };
}

// The re-arm happens in a `finally` after an `await`, so it needs a turn of the
// microtask queue that a mocked timer tick does not give it.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("keeps one request out however long its answer takes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const poll = heldLoad();
  const stop = startPoll(poll.load, 1_000);
  // The first read is immediate, not a period late.
  assert.equal(poll.calls(), 1);

  // Ten periods pass with the answer still out, and nothing else is sent.
  t.mock.timers.tick(10_000);
  assert.equal(poll.calls(), 1);

  // The period is counted from the answer, so the next request is a whole
  // period after it rather than immediately behind it.
  poll.answer(0);
  await settle();
  assert.equal(poll.calls(), 1);
  t.mock.timers.tick(999);
  assert.equal(poll.calls(), 1);
  t.mock.timers.tick(1);
  assert.equal(poll.calls(), 2);
  stop();
});

test("stays stopped when stopped with a request out", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const poll = heldLoad();
  const stop = startPoll(poll.load, 1_000);
  stop();
  poll.answer(0);
  await settle();
  t.mock.timers.tick(10_000);
  assert.equal(poll.calls(), 1, "a poll stopped mid-request re-armed when the answer came back");
});

test("stays stopped when stopped between requests", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const poll = heldLoad();
  const stop = startPoll(poll.load, 1_000);
  poll.answer(0);
  await settle();
  stop();
  t.mock.timers.tick(10_000);
  assert.equal(poll.calls(), 1);
});
