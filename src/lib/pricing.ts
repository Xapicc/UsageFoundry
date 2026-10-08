/**
 * Model pricing and cost derivation.
 *
 * All rates are USD per million tokens, expressed as the *input* base rate.
 * Cache tokens are multiples of that base rate rather than independent numbers:
 *
 *   cache read            0.10x input  (per-model; see below)
 *   cache write (5m TTL)  1.25x input
 *   cache write (1h TTL)  2.00x input
 *
 * This matters: Claude Code uses 1h-TTL cache writes heavily, which cost 2x
 * input, not 1.25x. Collapsing both into one "cache creation" number
 * understates spend on exactly the workload this tool is built to measure.
 *
 * **The cache read multiplier is a property of the model, not a constant.**
 * It was 0.10x on every model this table knew until Claude Fable 5.1 and
 * Claude Mythos 5.1 shipped at 0.025x ($0.25/MTok against a $10 input), and
 * that is 4x, on the line item this tool exists to measure — a Claude Code
 * workload is ~98% cache reads, so a hard-coded 0.10x would overstate a Fable
 * 5.1 run's bill by nearly 4x and refuse it against a ceiling it never
 * reached. `CACHE_READ_MULTIPLIER` remains the default every entry inherits;
 * an entry that overrides it says so, and `cacheReadMultiplierOf` is the only
 * thing that may read either. The write multipliers are still constants
 * because no model has departed from them; when one does, it takes the same
 * shape rather than a second mechanism.
 *
 * **A rate can also depend on how long the request's prompt was.** Claude Haiku
 * 5.5 is the first model that does: every column, the output one included,
 * steps up once a request's prompt passes 100,000 tokens. The tier belongs to
 * one API request and is chosen from *that request's own* prompt size, before
 * anything is summed — two 60k-token turns are two short-prompt turns, though
 * their sum is 120k. See `ModelPrice.longPrompt`, `PromptBasis` and `costOf`.
 */

export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2.0;

/** One set of per-million-token rates, with no say in which prompts it applies to. */
export interface FlatPrice {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /**
   * Cache read as a multiple of `input`, when this model departs from
   * `CACHE_READ_MULTIPLIER`. Absent means the default, which is what every
   * entry but the 5.1 pair means.
   */
  cacheReadMultiplier?: number;
}

export interface ModelPrice extends FlatPrice {
  /**
   * The rates for a request whose prompt is **longer than** `above` tokens,
   * replacing the ones above for all of that request's tokens — output
   * included. Absent on every model but Claude Haiku 5.5, whose rates are the
   * `FlatPrice` fields up to and including `above` tokens, so "up to 100,000"
   * is the low tier.
   *
   * It rides on the price `resolvePrice` returns rather than being asked for
   * there, because `resolvePrice` is called without a request and memoised
   * without one (`windows.ts` keys on speed and UTC day): the same object is
   * right for every prompt length, and `costOf` picks the tier from the tokens
   * it is handed.
   */
  longPrompt?: { above: number; price: FlatPrice };
}

/**
 * The cache read multiplier in force for a price, default included.
 *
 * Every site that prices a cache read — this module's `costOf`, and the two
 * counterfactuals in `contextPruning.ts` and `intakeFilter.ts` that price a
 * read that did *not* happen — goes through here rather than reading the
 * constant, so a model that departs from it cannot be right in one place and
 * wrong in three.
 */
export function cacheReadMultiplierOf(price: FlatPrice): number {
  return price.cacheReadMultiplier ?? CACHE_READ_MULTIPLIER;
}

/**
 * Keys are matched longest-first against the canonical model id, and a key
 * matches only when what follows it is decoration (`DECORATION_ONLY`), so
 * `claude-opus-4-5-20251101` resolves via `claude-opus-4-5` and
 * `claude-sonnet-5-6` resolves via nothing.
 */
const PRICES: Record<string, ModelPrice> = {
  // Fable / Mythos tier. The 5.1 pair differs from the 5 pair *only* on the
  // cache read rate: input and output are the same $10/$50, so a 5.1 turn priced
  // at the 5 row would be right on both visible columns and 4x wrong on the
  // invisible one — which is why a point release never borrows its
  // predecessor's row (`DECORATION_ONLY`).
  "claude-fable-5-1": { input: 10, output: 50, cacheReadMultiplier: 0.025 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheReadMultiplier: 0.025 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-mythos-5": { input: 10, output: 50 },
  "claude-mythos-preview": { input: 10, output: 50 },

  // Opus tier. `claude-opus-5-5` departs from `claude-opus-5` the 5.1 pair's
  // way: it halves the cache read rate to 0.05x ($0.20/MTok against a $4 input).
  // Unlike that pair it is also cheaper on both visible columns, so the Opus 5
  // row would show as *some* overcharge on it — but 2x of it would land on the
  // cache read, which is the line item nobody can check and ~98% of this
  // workload.
  "claude-opus-5-5": { input: 4, output: 20, cacheReadMultiplier: 0.05 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-opus-4-1": { input: 15, output: 75 },
  // `-4-0` is the alias spelling; the id an API response, a transcript and
  // Bedrock carry is the dated one, which no alias key can match now that a key
  // only takes decoration after it. Both rows are the same model.
  "claude-opus-4-20250514": { input: 15, output: 75 },
  "claude-opus-4-0": { input: 15, output: 75 },
  "claude-3-opus": { input: 15, output: 75 },

  // Sonnet tier. $2/$10 is Claude Sonnet 5's *standard* rate, not a promotion
  // this table is waiting out: it shipped as introductory pricing with a rise to
  // $3/$15 scheduled for 2026-09-01, and Anthropic cancelled that rise and made
  // the introductory number the list price. The dated ramp that used to live
  // here is deleted rather than expired — restoring it from memory would
  // overstate every Sonnet 5 run by 50% on a figure the budget guard acts on.
  //
  // `claude-sonnet-5-5` is the first point release that departs from its
  // predecessor on no column, the cache read included ($0.20/MTok, the default
  // 0.10x of $2). It still takes a row of its own rather than a looser
  // `DECORATION_ONLY`, because "the same as Sonnet 5" was read off the pricing
  // page and is not something the table could have inferred.
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "claude-sonnet-4-0": { input: 3, output: 15 },
  "claude-3-7-sonnet": { input: 3, output: 15 },
  "claude-3-5-sonnet": { input: 3, output: 15 },

  // Haiku tier. `claude-haiku-5-5` is the one row priced by prompt length. The
  // pricing page (platform.claude.com/docs/en/about-claude/pricing.md, fetched
  // 2026-10-08) lists two rows for it: "Claude Haiku 5.5 (for prompts up to
  // 100,000 tokens)" at $0.10 input / $0.125 5m write / $0.20 1h write / $0.01
  // cache hit / $0.50 output, and "(for prompts over 100,000 tokens)" at $0.50 /
  // $0.625 / $1 / $0.05 / $2.50, and its long-context section says "Claude
  // Haiku 5.5 is priced by prompt length: a prompt of over 100,000 tokens pays
  // higher prices". It has no cache footnote, so both tiers use the standard
  // 0.1x read multiplier (and 1.25x / 2x writes) of their own input rate, and
  // neither needs a `cacheReadMultiplier`. It is not in the fast-mode table.
  //
  // What counts as the prompt is the "total input tokens" of the prompt-caching
  // page, `cache_read_input_tokens + cache_creation_input_tokens +
  // input_tokens` (`promptTokensOf`); the Haiku 5.5 model page and the pricing
  // page say "prompts up to / over 100,000 tokens" and define it no further.
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    longPrompt: { above: 100_000, price: { input: 0.5, output: 2.5 } },
  },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-3-5-haiku": { input: 0.8, output: 4 },
  "claude-3-haiku": { input: 0.25, output: 1.25 },
};

/**
 * Fast mode runs the same model at premium rates.
 *
 * Keyed on the price-table key `resolvePrice` already matched, and an entry here
 * *replaces* the `PRICES` one rather than overlaying it — so a row that needs a
 * `cacheReadMultiplier` has to repeat it, and the Opus 5.5 row does.
 *
 * Anthropic's pricing page states it directly: "Fast mode pricing stacks with
 * other pricing modifiers … prompt caching multipliers apply on top of fast mode
 * pricing", and the caching multiplier is the per-model one (0.05x on Claude
 * Opus 5.5). So a fast-mode Opus 5.5 cache read is 0.05x of $8 — $0.40/MTok, 2x
 * its own base rate, the same doubling the input and output columns take. The
 * Opus 5 and 4.8 rows carry nothing because their *base* entries use the 0.10x
 * default, so inheriting it here already gives them that doubling.
 *
 * Omitting it from the 5.5 row would have charged $0.80/MTok, 4x the base rate
 * where every other column is 2x, on the term that is ~98% of this workload.
 */
const FAST_MODE_PRICES: Record<string, ModelPrice> = {
  "claude-opus-5-5": { input: 8, output: 40, cacheReadMultiplier: 0.05 },
  "claude-opus-5": { input: 10, output: 50 },
  "claude-opus-4-8": { input: 10, output: 50 },
};

/**
 * Rate charged to a model this table cannot place — for the budget guard only.
 *
 * $10/$50 is the most expensive *current-generation* entry above (Fable /
 * Mythos), deliberately not the $5/$25 Opus tier: an unrecognised ID must not
 * be able to look cheaper than a model that is actually in the table. The
 * $15/$75 entries are deprecated snapshots rather than a plausible shape for a
 * future launch, so they are not the benchmark.
 *
 * This is the same trade the Claude apps gateway's spend meter makes, and for
 * the same reason — an ID nothing can price must not go unmetered, or a cap
 * stops being a cap.
 *
 * It carries no `cacheReadMultiplier`, so it inherits the 0.10x default rather
 * than Fable 5.1's cheaper 0.025x, and that is the same trade again: the
 * unknown rate must be the dearest plausible shape, and 0.10x on a $10 input
 * is dearer than 0.025x on one.
 */
export const UNKNOWN_MODEL_PRICE: ModelPrice = { input: 10, output: 50 };

const PREFIXES = Object.keys(PRICES).sort((a, b) => b.length - a.length);

/**
 * What may follow a `PRICES` key in a canonical id for the key to still name
 * that model: nothing, or decoration only — a dated snapshot (`-20251001`), a
 * provider's version tag (Bedrock's `-v1:0`, Vertex's `-v2`), a bracketed CLI
 * suffix (`[1m]`), in any order and number.
 *
 * A `-<minor>` continuation is not decoration, and refusing it is the point. A
 * bare `startsWith` made every undated key a catch-all for the point releases
 * after it — `claude-sonnet-5` priced `claude-sonnet-5-5`, `claude-opus-5` would
 * price `claude-opus-5-6` — which is the short catch-all key `canonicalModelId`
 * rules out, arriving one release late. Two of the three point releases this
 * table knows departed from their predecessor on the cache read rate, the one
 * column nobody checks by eye, and the third matched it only by reading the page,
 * so a successor with no row of its own resolves to null: $0 shown, named as
 * unpriced, and `UNKNOWN_MODEL_PRICE` in every guard.
 */
const DECORATION_ONLY = /^(?:-\d{8}|-v\d+(?::\d+)?|\[[^\]]*\])*$/;

/**
 * Reduce a provider-decorated model string to the first-party form the table
 * is keyed on.
 *
 * Bedrock serves `us.anthropic.claude-…-v1:0` and Google's Agent Platform
 * serves `claude-…@20250929` — both name a model this table knows perfectly
 * well, but either would miss the prefix match and be charged the unknown
 * rate. Only decoration is stripped; nothing here maps one model onto another.
 * Note what is deliberately absent: no short catch-all keys like
 * `claude-opus-4`, because those would price an unreleased `claude-opus-4-9`
 * at a confident wrong number instead of surfacing it as unknown.
 *
 * **`[1m]` is deliberately neither stripped nor special-cased.** Claude Code
 * takes `claude-opus-5[1m]` for the 1M-context deployment of a model, and the
 * suffix falls after the table's key, where `resolvePrice` reads any bracketed
 * suffix as decoration, so a `[1m]` id matches its base and prices at the base
 * rate. That is the correct rate rather than a near-miss: the current models
 * carry a 1M window natively and Anthropic charges no premium for it by window
 * size — "1M context window at standard API pricing (no long-context premium)",
 * the bundled `claude-api` skill's own words about the Opus 4.7/4.8 generation
 * these variants belong to, and the pricing page's long-context section says
 * "Claude 4.6 and later models (except Claude Haiku 5.5) … include the full 1M
 * token context window at standard pricing". Left written down because the shape
 * invites a fix that would break it: stripping the suffix here would change
 * nothing about the price and would put a normalisation of a CLI-shaped id one
 * refactor away from the path to `--model`, where the brackets must survive.
 *
 * **Claude Haiku 5.5 is the exception to the sentence above, and `[1m]` still
 * needs nothing.** It does charge more for a long prompt, but by the length of
 * each request's prompt (`ModelPrice.longPrompt`), not by which deployment sent
 * it: a short prompt is the cheap tier with or without a `[1m]`, a long one the
 * dear tier with or without it, and `claude-haiku-5-5[1m]` resolves to the same
 * row as its base. Should a premium ever attach to the *suffix*, it belongs in
 * `PRICES` as its own `claude-…[1m]` key — which, being the longer key,
 * `PREFIXES` tries before its base — and never in this function.
 */
function canonicalModelId(model: string): string {
  return model
    .toLowerCase()
    .replace(/^(us|us-gov|eu|apac|global)\./, "")
    .replace(/^anthropic\./, "")
    .replace("@", "-");
}

/**
 * Resolve pricing for a model string at a point in time.
 *
 * Returns null for unknown models rather than guessing — an unpriced model
 * should surface as "unknown" in the UI, not silently contribute $0 and make
 * a budget look safer than it is.
 *
 * **`at` reads no entry today.** The only rate that ever varied with it was
 * Claude Sonnet 5's introductory $2/$10, and Anthropic cancelled the rise to
 * $3/$15 rather than letting it land, so the ramp is gone and every entry is
 * flat in time. It stays on the signature because the callers that pass one are
 * repricing turns that already ran, and "what did this cost" is a question about
 * the day it happened rather than about today — `metering.md` writes that down
 * as the shape a future dated rate takes, and `windows.ts`'s per-day memo key
 * assumes it (a rate turning over anywhere but a UTC midnight would make that
 * memo wrong for the turns either side). A new dated rate branches here.
 *
 * **Prompt length is not an input here, and that is the design.** Claude Haiku
 * 5.5's rate depends on each request's prompt, but this function is called
 * without a request (the counterfactual in `windows.ts` memoises its answer per
 * speed and UTC day), so it returns the whole schedule — the object carries
 * `longPrompt` — and `costOf` chooses the tier from the tokens of the one
 * request it is pricing. A caller that has no single request to hand `costOf`
 * does not get a tier chosen for it: see `PromptBasis`, and `resolveFlatPrice`
 * for the callers that read a rate directly.
 */
export function resolvePrice(
  model: string | undefined,
  opts: { at?: number; speed?: string } = {},
): ModelPrice | null {
  if (!model) return null;
  const id = canonicalModelId(model);

  const key = PREFIXES.find(
    (p) => id.startsWith(p) && DECORATION_ONLY.test(id.slice(p.length)),
  );
  if (!key) return null;

  if (opts.speed === "fast" && FAST_MODE_PRICES[key]) {
    return FAST_MODE_PRICES[key];
  }
  return PRICES[key];
}

export function isKnownModel(model: string | undefined): boolean {
  return resolvePrice(model) !== null;
}

/**
 * `resolvePrice`, but null for a model whose rate depends on prompt length.
 *
 * For the two counterfactuals — `netReceipt` in `contextPruning.ts` and
 * `netFilterSavings` in `intakeFilter.ts` — that read `price.input` to value a
 * *difference in tokens* spread over later turns whose prompts they never see.
 * With a tiered model there is no single rate to read: `price.input` is the
 * low tier, and valuing the savings on a context that may well be past 100,000
 * tokens at the cheap rate is a confident wrong number that looks like a
 * measurement. Those sites already have an answer for a model nothing can
 * price — report it unpriced and let the page say the figure covers fewer
 * results — and a tiered model takes it, rather than being given a tier it was
 * not told.
 */
export function resolveFlatPrice(
  model: string | undefined,
  opts: { at?: number; speed?: string } = {},
): ModelPrice | null {
  const price = resolvePrice(model, opts);
  return price && !price.longPrompt ? price : null;
}

/** Token counts broken out by how each class is billed. */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  /**
   * Cache creation the record declared no TTL for.
   *
   * A transcript written before the split shipped — or copied from a machine
   * whose CLI predates it — carries only the aggregate
   * `cache_creation_input_tokens`, and the two classes it could be are 1.25x
   * and 2.00x input. This is that volume kept **out of both**: charging all of
   * it to the cheaper class is not "not inventing a distribution", it is
   * choosing one, and choosing the one that flatters the bill on a term
   * measured at 48% of it.
   *
   * `costOf` prices it at 1.25x, which is the floor and the honest thing to
   * show; `guardCostOf` prices it at 2.00x, which is the ceiling and the only
   * thing a limit may safely act on. The dashboard's existing hatched band is
   * the gap between them, so the ambiguity is drawn without a new UI concept.
   */
  cacheWriteUnattributed: number;
}

export const ZERO_TOKENS: TokenCounts = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheWriteUnattributed: 0,
};

export function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
    cacheWriteUnattributed:
      a.cacheWriteUnattributed + b.cacheWriteUnattributed,
  };
}

/**
 * Every cache-creation token, whatever class it was billed at.
 *
 * One definition, because the volume is now in three fields and every place
 * that wants "how much did this write" wants all three. A site that summed the
 * two declared classes and left the third out would under-report by exactly the
 * volume nothing declared, which is 100% of it on a pre-split transcript.
 */
export function cacheWriteTokens(t: TokenCounts): number {
  return t.cacheWrite5m + t.cacheWrite1h + t.cacheWriteUnattributed;
}

/**
 * Total tokens, for limit windows that are measured in raw token volume.
 * Cache reads are included because they still consume the window even though
 * they are cheap in dollar terms.
 */
export function totalTokens(t: TokenCounts): number {
  return t.input + t.output + t.cacheRead + cacheWriteTokens(t);
}

/** Tokens excluding cache reads — a closer proxy for "real" work done. */
export function billableWeightedTokens(t: TokenCounts): number {
  return t.input + t.output + cacheWriteTokens(t);
}

/**
 * The tokens of one request that its prompt consists of: everything the model
 * was sent, whether it was read from the cache, written to it or neither.
 *
 * Anthropic's definition of a request's total input, on the prompt-caching page:
 * `total_input_tokens = cache_read_input_tokens + cache_creation_input_tokens +
 * input_tokens`. The Haiku 5.5 tier boundary is stated as "prompts up to / over
 * 100,000 tokens" without defining the word again, so this is the rule used, and
 * it is the one the earlier >200K long-context tier counted by. Output is
 * excluded — it is not part of the prompt — and `cacheWriteTokens` is used
 * rather than the two declared classes for `costOf`'s reason.
 *
 * Meaningful only for the tokens of **one** request. Handed a sum it answers
 * about a prompt that was never sent.
 */
export function promptTokensOf(t: TokenCounts): number {
  return t.input + t.cacheRead + cacheWriteTokens(t);
}

/**
 * What is known of the prompt behind the tokens being priced, which decides the
 * tier of a model priced by prompt length (`ModelPrice.longPrompt`) and nothing
 * for any other.
 *
 * - `"request"` — the tokens are one API request's usage block, so its own
 *   prompt size picks the tier. `transcripts.ts` prices each `UsageEntry` this
 *   way and `windows.ts` reprices each one this way; a sum is never this.
 * - `"unknown"` — the tokens are a sum over several requests, or a request
 *   whose prompt was not recorded. No tier can be read from them: a sum of two
 *   60k-token requests is 120k tokens and was never a 120k-token prompt. Priced
 *   the way this module prices every ambiguity (`cacheWriteUnattributed`,
 *   `UNKNOWN_MODEL_PRICE`): `costOf` shows the lowest tier, the floor a person
 *   is shown, and `guardCostOf` charges the highest, the ceiling a limit may
 *   act on. A guard that took the low tier for a turn it cannot measure would
 *   be bounded from below, and Haiku 5.5's long tier is five times the short.
 *
 * **`"unknown"` is the default on purpose.** A caller that does not say what its
 * tokens are gets the pair that cannot understate the guard, instead of a tier
 * picked from the size of whatever it happened to add up. Only a site holding
 * exactly one request's usage may say `"request"`.
 */
export type PromptBasis = "request" | "unknown";

/**
 * The rates to price `tokens` at under `price`.
 *
 * The one place a tier is chosen. `reader` is who is asking when the prompt is
 * `"unknown"`: the shown figure takes the low tier, the guard the high one. It
 * is ignored when `basis` is `"request"`, where the tokens answer for
 * themselves — a guard is a ceiling on what was spent, and a request whose
 * prompt is known to be short did not spend the long rate.
 */
function rateFor(
  price: ModelPrice,
  tokens: TokenCounts,
  basis: PromptBasis,
  reader: "shown" | "guard",
): FlatPrice {
  const tier = price.longPrompt;
  if (!tier) return price;
  // "Up to 100,000" is the low tier, so the boundary is strict.
  const isLong =
    basis === "request" ? promptTokensOf(tokens) > tier.above : reader === "guard";
  return isLong ? tier.price : price;
}

/**
 * Cost for budget-guard purposes, charging an unknown model the fallback rate
 * rather than nothing.
 *
 * `costOf` returns 0 for an unpriced model, which is the honest number to
 * *display* — but it also means a model this table cannot place contributes
 * nothing to a cost-denominated guard. With a whole window unpriced the
 * fraction is exactly 0 and the guard can never fire, so the one setting a
 * user reaches for to bound spend silently stops existing at exactly the
 * moment a new model ships.
 *
 * Only `evaluateBudget` reads this. The dashboard keeps reporting the $0 floor
 * and naming the model, so no figure shown to a user is ever a guess.
 *
 * The same asymmetry applies a second time, to cache creation the record
 * declared no TTL for: `costOf` charges it at 1.25x and this charges the 2.00x
 * it might equally have been. A guard bounded from below is not a guard, and
 * an install whose transcripts predate the TTL split would otherwise have every
 * ceiling computed against up to 37.5% less than the writes may have cost.
 *
 * And a third time, to a prompt whose length is unknown (`PromptBasis`): the
 * highest tier of a model priced by prompt length, where `costOf` shows the
 * lowest.
 */
export function guardCostOf(
  tokens: TokenCounts,
  price: ModelPrice | null,
  basis: PromptBasis = "unknown",
): number {
  const rate = rateFor(price ?? UNKNOWN_MODEL_PRICE, tokens, basis, "guard");
  return (
    costAt(tokens, rate) +
    tokens.cacheWriteUnattributed *
      (rate.input / 1_000_000) *
      (CACHE_WRITE_1H_MULTIPLIER - CACHE_WRITE_5M_MULTIPLIER)
  );
}

/**
 * What `tokens` cost at `price`, in dollars.
 *
 * `tokens` must be **one request's** usage when `basis` is `"request"`: the tier
 * of a model priced by prompt length is chosen from this request's own prompt
 * (`promptTokensOf`) *here*, per request, before anything is summed — which is
 * why every aggregate in this app (`windows.ts`'s `aggregate`) adds the dollars
 * of its entries and never prices the tokens it adds. Anything that is not
 * exactly one request's usage takes the default, `"unknown"`, which shows the
 * low tier; see `PromptBasis`. A model with a single rate ignores the argument.
 */
export function costOf(
  tokens: TokenCounts,
  price: ModelPrice | null,
  basis: PromptBasis = "unknown",
): number {
  if (!price) return 0;
  return costAt(tokens, rateFor(price, tokens, basis, "shown"));
}

function costAt(tokens: TokenCounts, price: FlatPrice): number {
  const perToken = price.input / 1_000_000;
  const outPerToken = price.output / 1_000_000;
  return (
    tokens.input * perToken +
    tokens.output * outPerToken +
    tokens.cacheRead * perToken * cacheReadMultiplierOf(price) +
    tokens.cacheWrite5m * perToken * CACHE_WRITE_5M_MULTIPLIER +
    tokens.cacheWrite1h * perToken * CACHE_WRITE_1H_MULTIPLIER +
    // The cheaper of the two classes it could have been. This is the shown
    // figure, so it understates rather than guesses; `guardCostOf` carries the
    // other end and the meter draws the gap between them.
    tokens.cacheWriteUnattributed * perToken * CACHE_WRITE_5M_MULTIPLIER
  );
}

/**
 * Where a bill actually went, in dollars, by term.
 *
 * ## Why this is worth a function
 *
 * MEASURED across 90 deduplicated usage frames on one install, priced with the
 * table in this file at the one-hour write class:
 *
 *     cache writes    48.1% of the bill   from  7% of the tokens
 *     cache reads     31.6%               from 92% of the tokens
 *     output          20.2%               from  1% of the tokens
 *
 * A loop can be almost entirely cache reads by volume and still spend half its
 * money on writes, because the multipliers are 0.1x and 2.0x - a twentyfold
 * ratio that no token count shows. An operator looking at a token chart is
 * looking at the 92% that costs a third, and the term that actually decides
 * their bill is the one that barely appears.
 *
 * `costOf` above already sums these five terms and is the figure everything
 * else in this app trusts. This returns the SAME arithmetic broken out rather
 * than a second computation of it, and `costSplitOf(t, p).total` is asserted
 * equal to `costOf(t, p)` in the tests - a split that could drift from the
 * total would be two statements of one policy, which is how a readout starts
 * telling an operator something the guard does not believe.
 */
export interface CostSplit {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export function costSplitOf(
  tokens: TokenCounts,
  price: ModelPrice | null,
  basis: PromptBasis = "unknown",
): CostSplit {
  if (!price) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  }
  // The rate `costOf` will use, chosen once for both halves of this function.
  const rate = rateFor(price, tokens, basis, "shown");
  const perToken = rate.input / 1_000_000;
  const split = {
    input: tokens.input * perToken,
    output: tokens.output * (rate.output / 1_000_000),
    cacheRead: tokens.cacheRead * perToken * cacheReadMultiplierOf(rate),
    // The write classes are one line on a receipt: an operator cannot choose
    // between them and the distinction is the API's, not theirs. The
    // unattributed volume is on the same line at the floor rate, so this stays
    // `costOf`'s own arithmetic broken out rather than a second opinion.
    cacheWrite:
      tokens.cacheWrite5m * perToken * CACHE_WRITE_5M_MULTIPLIER +
      tokens.cacheWrite1h * perToken * CACHE_WRITE_1H_MULTIPLIER +
      tokens.cacheWriteUnattributed * perToken * CACHE_WRITE_5M_MULTIPLIER,
  };
  // `costOf`, not a re-sum of the four terms above. Adding them again gives a
  // number that differs from it in the last bits of a float, and a receipt that
  // disagrees with the guard by a rounding error is still a receipt that
  // disagrees. One definition of the total, and this is not it.
  return { ...split, total: costOf(tokens, price, basis) };
}

/** The same split as shares of the total, or null when nothing was spent. */
export function costSharesOf(split: CostSplit): Record<keyof Omit<CostSplit, "total">, number> | null {
  if (!(split.total > 0)) return null;
  return {
    input: split.input / split.total,
    output: split.output / split.total,
    cacheRead: split.cacheRead / split.total,
    cacheWrite: split.cacheWrite / split.total,
  };
}

export function knownModelIds(): string[] {
  return [...PREFIXES];
}
