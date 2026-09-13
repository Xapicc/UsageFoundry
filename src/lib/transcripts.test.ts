import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  INTERN_MAX_ENTRIES,
  intern,
  readTokens,
  transcriptCacheStats,
} from "./transcripts";
import {
  CACHE_WRITE_1H_MULTIPLIER,
  CACHE_WRITE_5M_MULTIPLIER,
  cacheWriteTokens,
  costOf,
  guardCostOf,
  resolvePrice,
  totalTokens,
} from "./pricing";

/**
 * Where a record's cache-creation tokens go, and what it costs to put them in
 * the wrong place.
 *
 * A `usage` block carrying only the aggregate `cache_creation_input_tokens` —
 * every transcript written before the TTL split shipped, and any `~/.claude`
 * tree copied from a machine whose CLI predates it — does not say which of the
 * two write classes it was billed at, and they are 1.25× and 2.00× input.
 * `pricing.ts` measured cache writes at 48% of the bill from 7% of the tokens,
 * so a whole file's write volume put in the cheaper bucket takes 37.5% off the
 * only term that decides what a Claude Code loop costs.
 *
 * The failure is silent end to end: the record parses, the totals add up, the
 * meters draw, and the guard refuses nothing it should have refused. That is
 * the bar this suite is built to, and there is no other door to the decision —
 * every caller reaches it through a directory scan.
 */
describe("readTokens — cache creation with no declared TTL", () => {
  it("keeps an unsplit write out of the 5m bucket and reports it as its own", () => {
    const tokens = readTokens({
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 1_000,
      cache_creation_input_tokens: 100_000,
    });
    assert.equal(
      tokens.cacheWrite5m,
      0,
      "nothing declared the 5m class, so nothing may be counted at it",
    );
    assert.equal(tokens.cacheWrite1h, 0);
    assert.equal(tokens.cacheWriteUnattributed, 100_000);
    // Kept, not dropped: the volume is real and every window measured in raw
    // tokens still has to see it.
    assert.equal(cacheWriteTokens(tokens), 100_000);
    assert.equal(totalTokens(tokens), 10 + 20 + 1_000 + 100_000);
  });

  it("reads a declared split as declared, with nothing left over", () => {
    const tokens = readTokens({
      cache_creation_input_tokens: 100_000,
      cache_creation: {
        ephemeral_5m_input_tokens: 40_000,
        ephemeral_1h_input_tokens: 60_000,
      },
    });
    assert.equal(tokens.cacheWrite5m, 40_000);
    assert.equal(tokens.cacheWrite1h, 60_000);
    assert.equal(tokens.cacheWriteUnattributed, 0);
  });

  it("carries only the remainder when the split does not cover the aggregate", () => {
    // A partial breakdown is the case that most looks like it can be ignored:
    // the two figures disagree, and the difference is exactly the volume that
    // nothing accounted for.
    const tokens = readTokens({
      cache_creation_input_tokens: 100_000,
      cache_creation: { ephemeral_1h_input_tokens: 30_000 },
    });
    assert.equal(tokens.cacheWrite1h, 30_000);
    assert.equal(tokens.cacheWriteUnattributed, 70_000);
    assert.equal(cacheWriteTokens(tokens), 100_000);
  });

  it("never reports a negative remainder from a split larger than the total", () => {
    const tokens = readTokens({
      cache_creation_input_tokens: 10,
      cache_creation: { ephemeral_5m_input_tokens: 40_000 },
    });
    assert.equal(tokens.cacheWriteUnattributed, 0);
  });
});

/**
 * The price of the ambiguity, at both ends.
 *
 * `costOf` is what a person is shown and takes the cheaper class, so the figure
 * understates rather than guesses. `guardCostOf` is what a ceiling acts on and
 * takes the dearer one, which is the same asymmetry `UNKNOWN_MODEL_PRICE`
 * already applies to a model this table cannot place: a guard bounded from
 * below is not a guard. The gap between them is what the dashboard's existing
 * hatched band draws, so the ambiguity reaches the operator with no new concept
 * on the page.
 */
describe("an unsplit cache write is a floor to show and a ceiling to guard", () => {
  const price = resolvePrice("claude-opus-5");
  const tokens = readTokens({ cache_creation_input_tokens: 1_000_000 });

  it("charges the guard the 1h rate and the display the 5m one", () => {
    assert.ok(price);
    const perMillion = price.input;
    assert.equal(costOf(tokens, price), perMillion * CACHE_WRITE_5M_MULTIPLIER);
    assert.equal(
      guardCostOf(tokens, price),
      perMillion * CACHE_WRITE_1H_MULTIPLIER,
    );
    assert.ok(
      guardCostOf(tokens, price) > costOf(tokens, price),
      "the guard must be bounded from above, not from below",
    );
  });

  it("leaves a declared write priced identically in both", () => {
    // The asymmetry is the *ambiguity's* price and nothing else's. A record
    // that said which class it was must not be charged twice for saying so.
    const declared = readTokens({
      cache_creation_input_tokens: 1_000_000,
      cache_creation: { ephemeral_5m_input_tokens: 1_000_000 },
    });
    assert.equal(costOf(declared, price), guardCostOf(declared, price));
  });

  it("still charges an unplaced model for the ambiguity", () => {
    // Both fallbacks at once: no price table entry *and* no declared class.
    // Either one alone leaving the guard at the floor would be the same hole.
    assert.ok(guardCostOf(tokens, null) > costOf(tokens, null));
  });
});

/**
 * The intern table, whose two ways of being wrong are both silent.
 *
 * It sits under every field of every cached record, so a table that handed back
 * a string other than the one it was asked about would rewrite a model id, a
 * `cwd` or a session id in the cache and nowhere else — the transcript on disk
 * still says what it said, so a re-read after an eviction would disagree with a
 * figure the dashboard had already drawn, and nothing would throw on the way.
 * And a table that never started over would be the growth this module is here
 * to bound, one level down: `project` and `sessionId` have a distinct value per
 * checkout and per session rather than a fixed vocabulary, so on a server that
 * stays up the table, not the records, becomes the term that grows.
 */
describe("intern", () => {
  it("answers with a string equal to the one it was given", () => {
    for (const value of [
      "claude-opus-4-5-20251101",
      "",
      "/workspace/.uf-worktrees/usagefoundry-721638d11c0b-6",
      "xhigh",
      "\u00e9\u4e2d\ud83d\ude80",
    ]) {
      // Built at runtime so the two are not the same literal to begin with:
      // a source-level duplicate is already one object in V8, which would make
      // this pass against a table that did nothing at all.
      const fresh = JSON.parse(JSON.stringify(value)) as string;
      assert.equal(intern(fresh), value);
      assert.equal(intern(fresh), value);
    }
  });

  it("starts the table over rather than growing it for ever", () => {
    // Distinct on every call, which is what a session id and a checkout path
    // are across a long-lived server.
    const distinct = INTERN_MAX_ENTRIES * 2;
    for (let i = 0; i < distinct; i += 1) intern(`session-${i}-${Math.random()}`);
    const after = transcriptCacheStats().internedStrings;

    assert.ok(
      after <= INTERN_MAX_ENTRIES,
      `the table holds ${after} strings against a bound of ` +
        `${INTERN_MAX_ENTRIES} after ${distinct} distinct ones went in`,
    );
  });
});
