import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { repoAdminBusy, withRepoAdmin } from "./repoLock";

/**
 * A mutual exclusion whose failure mode is that it silently excludes nothing.
 *
 * Every way of getting a promise-chained lock wrong type-checks and passes any
 * test that only calls it once: chain onto the wrong promise and two bodies run
 * side by side, chain on success alone and one thrown error wedges the key for
 * the life of the process, forget to clear the map and it grows a permanent
 * entry per repository. The first is the defect the lock exists to prevent and
 * is invisible until two callers happen to overlap on a live install; the
 * second is worse than not having the lock, because one of the four callers is
 * the run loop and a wedged key is every isolated run in that repository never
 * starting again.
 *
 * Driven with explicit deferreds rather than timers: what is being asserted is
 * an ordering, and a test that establishes it by sleeping asserts the sleep.
 */

/** A promise plus the handle that settles it, so a body can be held open. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every already-settled microtask run before asserting about ordering. */
const settle = () => new Promise((r) => setImmediate(r));

describe("withRepoAdmin", () => {
  it("holds the second caller until the first has finished", async () => {
    const gate = deferred();
    const order: string[] = [];

    const first = withRepoAdmin("/repo/a", async () => {
      order.push("first in");
      await gate.promise;
      order.push("first out");
    });
    const second = withRepoAdmin("/repo/a", async () => {
      order.push("second in");
    });

    await settle();
    // The whole point, and the one assertion that fails if the lock excludes
    // nothing: the second body has not started while the first is still open.
    assert.deepEqual(order, ["first in"]);

    gate.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first in", "first out", "second in"]);
  });

  it("lets two repositories work at once", async () => {
    const gate = deferred();
    const order: string[] = [];

    const a = withRepoAdmin("/repo/a", async () => {
      order.push("a in");
      await gate.promise;
    });
    const b = withRepoAdmin("/repo/b", async () => {
      order.push("b in");
    });

    await settle();
    // A lock keyed on the process rather than the repository would serialise
    // every install-wide run start behind one repository's registry work.
    assert.deepEqual(order, ["a in", "b in"]);
    gate.resolve();
    await Promise.all([a, b]);
  });

  it("passes a body's own result and its own failure straight through", async () => {
    assert.equal(await withRepoAdmin("/repo/c", async () => 41 + 1), 42);
    await assert.rejects(
      withRepoAdmin("/repo/c", async () => {
        throw new Error("git refused");
      }),
      /git refused/,
    );
  });

  it("is not wedged by a body that threw", async () => {
    const failed = withRepoAdmin("/repo/d", async () => {
      throw new Error("the first one blew up");
    });
    await assert.rejects(failed);

    // Chaining on success alone would leave this waiting on a rejected promise
    // for ever, and the caller behind it is the run loop.
    assert.equal(await withRepoAdmin("/repo/d", async () => "still works"), "still works");
  });

  it("forgets a repository once its queue has drained", async () => {
    const gate = deferred();
    const held = withRepoAdmin("/repo/e", async () => {
      await gate.promise;
    });
    assert.equal(repoAdminBusy("/repo/e"), true);

    gate.resolve();
    await held;
    await settle();
    // Otherwise the map keeps one entry per repository this process has ever
    // touched — small, but it is the kind of growth nothing would ever notice.
    assert.equal(repoAdminBusy("/repo/e"), false);
  });

  it("keeps the entry while somebody is still queued behind the holder", async () => {
    const firstGate = deferred();
    const secondGate = deferred();
    const first = withRepoAdmin("/repo/f", async () => {
      await firstGate.promise;
    });
    // Held open as well, because the claim being tested is only observable
    // while the second caller still has it: a second body that returned in the
    // same tick would have drained the queue legitimately.
    const second = withRepoAdmin("/repo/f", async () => {
      await secondGate.promise;
    });

    firstGate.resolve();
    await first;
    await settle();
    // The first one draining must not clear a queue the second is still in, or
    // a third caller chains onto nothing and runs beside the second.
    assert.equal(repoAdminBusy("/repo/f"), true);

    secondGate.resolve();
    await second;
    await settle();
    assert.equal(repoAdminBusy("/repo/f"), false);
  });
});
