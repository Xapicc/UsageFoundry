import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readOnlyBanner } from "./readOnlyBanner";

/**
 * What the health poll may render above every page, decided in `readOnlyBanner`
 * rather than inline in `ReadOnlyNotice`.
 *
 * The old expression was `res.ok ? null : res.error`, and it failed in both
 * directions at once, because `jsonRequest` folds a failure into exactly the
 * field the notice read:
 *
 *  - a fetch that never reached the server comes back `status: null` with the
 *    transport's own words in `error` — "Failed to fetch" in Chrome, "Load
 *    failed" in Safari, "fetch failed" in Node — and the notice rendered them,
 *    so a server restart or a proxy blip put a warning banner above every page
 *    until the next poll succeeded. A banner that appears and disappears with
 *    the network trains the eye to skip the one that means something, so the
 *    dropped fetch shows nothing.
 *
 *  - the server that most needs the banner is the one whose database it cannot
 *    write, and that one answers 503 with the failure in
 *    `checks.databaseError` and no top-level `error` at all — the field every
 *    route uses to explain a refusal — so the notice showed nothing where the
 *    page most needs it.
 *
 * Both are pure: the input is the shape `jsonRequest` hands back and the
 * output is the one sentence the page may show, which is what earns the cases
 * below.
 */

test("a dropped fetch shows nothing, whatever the transport calls itself", () => {
  assert.equal(
    readOnlyBanner({ ok: false, status: null, error: "Failed to fetch" }),
    null,
  );
  // The words differ between Chrome, Safari and Node; the decision must not.
  assert.equal(readOnlyBanner({ ok: false, status: null, error: "Load failed" }), null);
  assert.equal(readOnlyBanner({ ok: false, status: null, error: "fetch failed" }), null);
});

test("a 503 whose database cannot be written shows the sentence the check wrote", () => {
  const sentence = "the database could not be written: SQLITE_READONLY (5)";
  assert.equal(
    readOnlyBanner({
      ok: false,
      status: 503,
      error: null,
      body: {
        ok: false,
        status: "unhealthy",
        checks: { database: "error", databaseError: sentence, dataDirOwned: false },
      },
    }),
    sentence,
  );
});

test("a 503 the route explained in error shows that refusal in its own words", () => {
  const refusal = "This server does not own the data directory; pid 412 does.";
  assert.equal(
    readOnlyBanner({
      ok: false,
      status: 503,
      error: refusal,
      body: {
        ok: true,
        status: "ok",
        error: refusal,
        checks: { database: "ok", dataDirOwned: false },
      },
    }),
    refusal,
  );
});

test("a 503 that is both is answered by the check that cannot write", () => {
  // A replica on a read-only mount: both a refusal and a failed check. The
  // banner is the thing a server that cannot write puts above every page, so
  // that sentence is the one it shows.
  assert.equal(
    readOnlyBanner({
      ok: false,
      status: 503,
      error: "This server does not own the data directory; pid 412 does.",
      body: { checks: { database: "error", databaseError: "the database is read-only" } },
    }),
    "the database is read-only",
  );
});

test("a healthy 200 shows nothing", () => {
  assert.equal(
    readOnlyBanner({
      ok: true,
      data: { ok: true, status: "ok", checks: { database: "ok", dataDirOwned: true } },
    }),
    null,
  );
});

test("a 503 with no parseable body shows nothing", () => {
  // The body a proxy answers with instead of the route is HTML, which
  // `jsonRequest` could not parse, so the failure carries no `body` key at all.
  assert.equal(readOnlyBanner({ ok: false, status: 503, error: null }), null);
});

test("a 503 whose check failed without a sentence shows nothing", () => {
  // `databaseError` is the one field the check may fail to carry: the message
  // is sliced to 300 characters server-side, and an empty one must render
  // nothing rather than the word "undefined".
  assert.equal(
    readOnlyBanner({ ok: false, status: 503, error: null, body: { checks: { database: "error" } } }),
    null,
  );
  assert.equal(
    readOnlyBanner({
      ok: false,
      status: 503,
      error: null,
      body: { checks: { database: "error", databaseError: "" } },
    }),
    null,
  );
});
