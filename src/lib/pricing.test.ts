import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CACHE_READ_MULTIPLIER,
  UNKNOWN_MODEL_PRICE,
  ZERO_TOKENS,
  cacheReadMultiplierOf,
  costOf,
  costSplitOf,
  resolvePrice,
} from "./pricing";

/**
 * The cache read rate, which stopped being a constant when the 5.1 pair
 * shipped at 0.025× against everything else's 0.10×.
 *
 * Every failure below is silent in the way this suite exists for: the model
 * resolves, the price resolves, the two visible columns — $10 input, $50 output
 * — are identical between Claude Fable 5 and Claude Fable 5.1, and the only
 * symptom of getting it wrong is a dollar figure that is 4× too large on the
 * one line item a Claude Code workload is almost entirely made of. Nothing
 * throws, nothing fails to typecheck, and a budget guard refuses a run against
 * a ceiling it never reached.
 *
 * Rates are read from the published pricing table rather than derived: Fable 5.1
 * and Mythos 5.1 charge $0.25/MTok for a cache hit (0.025× a $10 input), Claude
 * Opus 5.5 charges $0.20/MTok (0.05× a $4 one), and every other model 0.10× its
 * own input.
 */
describe("the cache read rate is a property of the model", () => {
  const MTOK = { ...ZERO_TOKENS, cacheRead: 1_000_000 };

  it("resolves claude-fable-5-1 to its own entry, not the claude-fable-5 prefix", () => {
    // The trap this exists for. `PREFIXES` is sorted longest-first, so the 5.1
    // entry only wins because it is longer — a table re-ordered by hand, or a
    // `sort` that lost its comparator, would silently fall through to the 5
    // entry, whose input and output are the same $10/$50. Both figures a person
    // can see on the page would still be right.
    const fable51 = resolvePrice("claude-fable-5-1");
    assert.ok(fable51);
    assert.equal(cacheReadMultiplierOf(fable51), 0.025);

    const fable5 = resolvePrice("claude-fable-5");
    assert.ok(fable5);
    assert.equal(cacheReadMultiplierOf(fable5), CACHE_READ_MULTIPLIER);

    // Same $10/$50 on both, which is exactly why the multiplier needs pinning.
    assert.deepEqual(
      { input: fable51.input, output: fable51.output },
      { input: fable5.input, output: fable5.output },
    );
  });

  it("charges a million cache-read tokens $0.25 on 5.1 and $1.00 on 5", () => {
    assert.equal(costOf(MTOK, resolvePrice("claude-fable-5-1")), 0.25);
    assert.equal(costOf(MTOK, resolvePrice("claude-mythos-5-1")), 0.25);
    assert.equal(costOf(MTOK, resolvePrice("claude-fable-5")), 1);
    assert.equal(costOf(MTOK, resolvePrice("claude-mythos-5")), 1);
  });

  it("keeps the discount through a dated snapshot and a provider prefix", () => {
    // `canonicalModelId` strips decoration and the prefix match then has to land
    // on the longer key again. A Bedrock-served 5.1 priced at the 5 rate is the
    // same 4× error arriving through a different door.
    for (const id of [
      "claude-fable-5-1-20260901",
      "us.anthropic.claude-fable-5-1",
      "claude-fable-5-1@20260901",
    ]) {
      const price = resolvePrice(id);
      assert.ok(price, `${id} did not resolve`);
      assert.equal(cacheReadMultiplierOf(price), 0.025, id);
    }
  });

  it("prices a [1m] id at its base model's rate, discount included", () => {
    // `[1m]` is a Claude Code construct — the CLI's name for the 1M-context
    // deployment of a model — and Anthropic charges no long-context premium for
    // that window, so the base rate *is* the right answer here. The suffix falls
    // after the table's key, so `canonicalModelId` leaves it alone and the
    // prefix match already lands correctly.
    //
    // Pinned because both ways of getting it wrong are silent. Strip the suffix
    // in `canonicalModelId` and every figure below stays right while a
    // normalisation of a CLI-shaped id sits one refactor from the path to
    // `--model`, where the brackets have to survive. Add a `[1m]` key to
    // `PRICES` *after* its base and longest-prefix-first would never reach it.
    for (const [variant, base] of [
      ["claude-opus-5[1m]", "claude-opus-5"],
      ["claude-fable-5[1m]", "claude-fable-5"],
      ["claude-sonnet-4-5-20250929[1m]", "claude-sonnet-4-5"],
    ]) {
      const price = resolvePrice(variant);
      assert.ok(price, `${variant} did not resolve`);
      assert.deepEqual(price, resolvePrice(base), variant);
    }

    // The 5.1 pair through the same door: `claude-fable-5[1m]` must not reach
    // the longer `claude-fable-5-1` key, which shares its $10/$50 and would be
    // 4× wrong on the cache read nobody sees.
    const fable5 = resolvePrice("claude-fable-5[1m]");
    assert.ok(fable5);
    assert.equal(cacheReadMultiplierOf(fable5), CACHE_READ_MULTIPLIER);
  });

  it("resolves claude-opus-5-5 to its own entry, not the claude-opus-5 prefix", () => {
    // The 5.1 pair's trap one tier down, and sharper: Claude Opus 5.5 is $4/$20
    // against Claude Opus 5's $5/$25 *and* halves the cache read to 0.05×. A
    // fall-through to the shorter key is 25% wrong on the two columns a person
    // can check — which is at least visible — and 2× wrong on the one they
    // cannot, in the direction that refuses a run against a ceiling it never
    // reached.
    const opus55 = resolvePrice("claude-opus-5-5");
    assert.ok(opus55);
    assert.deepEqual(opus55, { input: 4, output: 20, cacheReadMultiplier: 0.05 });

    // And the collision does not run the other way: `claude-opus-5` is not a
    // prefix of `claude-opus-5-5`, so the older model keeps the default.
    const opus5 = resolvePrice("claude-opus-5");
    assert.ok(opus5);
    assert.deepEqual(opus5, { input: 5, output: 25 });
    assert.equal(cacheReadMultiplierOf(opus5), CACHE_READ_MULTIPLIER);
  });

  it("charges a cache-heavy Opus 5.5 cycle half what the default would", () => {
    // Against a shape this workload actually produces rather than one token:
    // 5M cache reads carrying the context, a quarter-million 1h writes laying it
    // down, and the input and output that a cycle's real work amounts to. That
    // proportion is this file's own measurement — ~92% of the tokens are reads —
    // which is why the term nobody can check is the term that decides the bill.
    const CYCLE = {
      ...ZERO_TOKENS,
      input: 40_000,
      output: 30_000,
      cacheRead: 5_000_000,
      cacheWrite1h: 250_000,
    };
    const opus55 = resolvePrice("claude-opus-5-5");
    assert.ok(opus55);

    // $0.20/MTok × 5M. An entry that inherited `CACHE_READ_MULTIPLIER` prices
    // the same reads at exactly $2.00, which is the 2× this case exists for and
    // is asserted here rather than reasoned about.
    assert.equal(costSplitOf(CYCLE, opus55).cacheRead, 1);
    assert.equal(
      costSplitOf(CYCLE, { ...opus55, cacheReadMultiplier: CACHE_READ_MULTIPLIER })
        .cacheRead,
      2,
    );
  });

  it("keeps Opus 5.5's rate through [1m], a snapshot and a provider prefix", () => {
    // Every door onto the same entry. `[1m]` falls after the key and so prefix-
    // matches the base; the other two are `canonicalModelId`'s to strip, and a
    // Bedrock- or Vertex-served Opus 5.5 priced at the Opus 5 rate is the same
    // error arriving by post.
    for (const id of [
      "claude-opus-5-5[1m]",
      "claude-opus-5-5-20260922",
      "us.anthropic.claude-opus-5-5",
      "claude-opus-5-5@20260922",
    ]) {
      const price = resolvePrice(id);
      assert.ok(price, `${id} did not resolve`);
      assert.deepEqual(price, resolvePrice("claude-opus-5-5"), id);
      assert.equal(cacheReadMultiplierOf(price), 0.05, id);
    }
  });

  it("charges fast mode on Opus 5.5 at $8/$40", () => {
    // Fast mode replaces the whole entry rather than overlaying the base one, so
    // this is also where a `cacheReadMultiplier` would have to be repeated if a
    // fast-mode rate ever departed. None was published, so the default stands
    // and the two numbers that were published are what is pinned.
    const fast = resolvePrice("claude-opus-5-5", { speed: "fast" });
    assert.ok(fast);
    assert.deepEqual({ input: fast.input, output: fast.output }, { input: 8, output: 40 });
    assert.equal(cacheReadMultiplierOf(fast), CACHE_READ_MULTIPLIER);

    // The older entries are untouched by the addition.
    assert.equal(resolvePrice("claude-opus-5", { speed: "fast" })?.input, 10);
    assert.equal(resolvePrice("claude-opus-4-8", { speed: "fast" })?.output, 50);
  });

  it("does not let the unknown-model rate inherit the discount", () => {
    // `UNKNOWN_MODEL_PRICE` shares the 5.1 pair's $10/$50 and must not share
    // its cache read rate: the whole point of that entry is to be the dearest
    // plausible shape, so a model nothing can price cannot slip under a cost
    // ceiling. 0.10× on a $10 input is dearer than 0.025× on one.
    assert.equal(cacheReadMultiplierOf(UNKNOWN_MODEL_PRICE), CACHE_READ_MULTIPLIER);
    assert.equal(costOf(MTOK, UNKNOWN_MODEL_PRICE), 1);
  });
});

/**
 * Claude Sonnet 5's $2/$10, which is the list price and not a promotion.
 *
 * It shipped as introductory pricing with a rise to $3/$15 scheduled for
 * 2026-09-01, this table carried that ramp, and Anthropic then cancelled the
 * rise — "is now the standard price … will not occur", their pricing page's own
 * words. So the ramp is deleted rather than expired, and what this pins is that
 * it stays deleted: an install running the old table prices every Sonnet 5 run
 * 50% high on a figure `evaluateBudget` acts on, refusing work against a ceiling
 * that was never reached, and nothing on any page says a rate expired.
 *
 * The dates are fixed rather than relative for the reason the ramp made
 * necessary in the first place: a `Date.now()` here would have been a test that
 * started passing or failing on its own.
 */
describe("claude-sonnet-5 costs the same whatever day it is priced on", () => {
  const MTOK_IO = { ...ZERO_TOKENS, input: 1_000_000, output: 1_000_000 };

  it("charges $2/$10 either side of the cancelled increase", () => {
    for (const [what, at] of [
      ["inside the old introductory window", Date.UTC(2026, 7, 30, 12)],
      ["the day the increase was scheduled for", Date.UTC(2026, 8, 1, 0)],
      ["well past it", Date.UTC(2027, 0, 15, 12)],
    ] as [string, number][]) {
      const price = resolvePrice("claude-sonnet-5", { at });
      assert.ok(price, what);
      assert.deepEqual({ input: price.input, output: price.output }, { input: 2, output: 10 }, what);
      assert.equal(costOf(MTOK_IO, price), 12, what);
    }
  });

  it("gives the same answer to a caller that names no instant at all", () => {
    // Every guard call site is one of these. Under the ramp the two paths could
    // disagree — `opts.at ?? Date.now()` — and the shown figure and the guarded
    // one came from different days.
    assert.deepEqual(
      resolvePrice("claude-sonnet-5"),
      resolvePrice("claude-sonnet-5", { at: Date.UTC(2026, 7, 1) }),
    );
    // Its [1m] variant and a dated snapshot arrive at the same entry.
    assert.deepEqual(resolvePrice("claude-sonnet-5[1m]"), resolvePrice("claude-sonnet-5"));
  });
});
