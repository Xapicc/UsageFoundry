# Usage readings, windows and cost

> Extracted verbatim from `CLAUDE.md`, which grew past the size Claude Code will
> load into a session. Each paragraph records a correctness or safety decision
> whose violation is silent — nothing throws, nothing fails to typecheck.
> **Read before editing src/lib/windows.ts, transcripts.ts, pricing.ts, planUsage.ts, repoSpend.ts, otlp.ts.**

This file is an index. Each line below is the lead claim of one paragraph, and the paragraph itself is in the topic file its heading links to.

## [Unknown readings, the provider's percentage and fraction guards](metering/unknown-and-percentages.md)

- Unknown must not render as zero.
- …but the *percentage* is readable, and it outranks anything derived from a ceiling.
- And a percentage the provider volunteers mid-cycle is deliberately ignored.
- A fraction guard with nothing to read is refused at the door, and never acted on afterwards.
- Cost is the primary metric; raw tokens are the fallback.
- Naming the plan is not setting a ceiling.
- Reserved headroom is applied in exactly one place.

## [Pricing, unpriced models and cache multipliers](metering/pricing.md)

- Unpriced models contribute $0 to everything displayed, and are named.
- …but the guard charges them a fallback rate, because a floor is not a guard.
- Canonicalise model IDs, never truncate them.
- `cache_creation` splits into 5m (1.25×) and 1h (2×).
- The cache read multiplier is a property of the model, and `cacheReadMultiplierOf` is the only thing that may read it.
- Pricing changes over time: `resolvePrice(model, {at, speed})` is speed-aware (`speed: "fast"` has its own table, which *replaces* the base entry rather than overlaying it — so a fast-mode row …

## [Transcript parsing and the usage scan](metering/transcripts.md)

- Transcript parsing details that materially change the numbers:
- Dedupe key is `${message.id}:${requestId}`, applied across files (a resumed session copies earlier turns forward).
- The records sharing that key are not all identical, so the resolution rule is highest `output` wins, never first-seen.
- Files are read from a cached byte offset; the bytes after the final `\n` are left unconsumed so a partially-flushed line is re-read next pass.
- The directory walk overlaps its levels and its output order is byte-for-byte the serial walk's
- The parsed cache holds a second array now, and the bound counts both.
- One aggregation per burst, because the scan was coalesced and the aggregation was not.
- A compaction record is read out of the same files and is not a reading of anything.

## [5-hour blocks, calendar periods and projections](metering/windows-and-periods.md)

- A block opens at its first turn, and nothing rounds that off.
- The 5-hour window is derived, except when the provider resets it.
- A calendar period is history, so its percentage is a pace and never a guard.
- Calendar buckets are cut in the browser's zone, and a bucket's end is the next one's start.
- A projection is bounded by the window it was computed from, and a candidate past that horizon is dropped rather than clamped to it.
- A window the provider reported is projected at the rate its own reading implies, never against a typed ceiling.

## [A run's spend and the other spend readings](metering/run-spend-readings.md)

- Per-iteration spend comes from the CLI's own `result` event
- A resumed cycle's `total_cost_usd` is its session's running total, so the run loop banks the increase.
- A killed cycle's spend is reconciled, into its own column.
- The cycle in flight is on the row, in its own column, and it is not a count.
- What a run is spending *now* is a third reading on the dashboard, never a correction to the meters.
- What each repository cost is a fifth reading, and it is a report rather than a source.

## [Attribution by effort, agent and skill](metering/attribution.md)

- Attribution comes from the transcript, not from telemetry.
- An agent bucket is annotated, never moved, and "nobody checked" is not "no such agent".
- A run's agent split is the transcript source scoped to one session, and it is display only.
- A default agent is `settings.defaultAgentId`, and a form seed is not a naming.

## [What the stream log records](metering/stream-log.md)

- A sub-agent's words are in the log and are never the run's own report.
- A tool call that failed is on the log; one that worked is not.

## [Where the bill goes, and this engine against a script loop](metering/cost-measurements.md)

- Where a bill went, and why a token chart does not show it.
- Why cache writes are half the bill, and why that is not a defect.
- The cost follows from the multipliers rather than from any waste.
- The lever this identifies is intake, not pruning.
- And the lever, priced.
- The write term needs no assumptions and is the floor: **2.3% of the run**.
- The fixed cost of starting a run, and what it is made of.
- What that first request buys is the cached prefix, written once at 2.0x.
- Two things follow, and neither is about pruning.
- And what all of that is worth, against the alternative — not yet known.
- Table: cost, done, per module.
- Two runs of this engine on one corpus differ by 3.48x
- Resolving it needs replication against a within-arm spread of 3.48x, which is the same wall the intake filter's A/B hit and the reason that mechanism was priced from its ledger instead.
- What can be said without replication.
- MEASURED on the four naive sessions: cold starts of $0.0761, $0.0875, $0.0169 and $0.0168, totalling **$0.1973**, against **$0.0493** for a single session.
- Two of those four sessions wrote **no prefix at all**, which is worth knowing before assuming the naive loop pays full price every time: the API's prefix cache outlives a session, so back-to-back …
- So the defensible statement about this engine against that loop is the sum of what has been priced rather than compared: **resume is worth about 13.3% here, the intake filter 3.67-8.76%**, and the …
- What one tool costs.
- It is paid whether the run uses the tool or not, because the definition is in the prefix before the agent has read anything.
- That makes `agents.ts` a metering surface as well as a permissions one.
- Why every figure above was priced rather than compared.
- Table: effect, runs per arm.
- The resume effect is 13.3%, so **seeing it by comparison needs about 88 runs per arm** - at roughly $0.55 a run that is over $95 for one number.
- That asymmetry is the argument for the method used throughout this section, and it is a property of the workload rather than of anyone's patience: agent runs vary by 2.28x to 3.48x on identical …
- The corollary is worth stating too: a *large* effect is cheap to measure.
- The comparison, run properly.
- Table: mean, range, completed, per module.
- 4.44x cheaper per unit of work, and the distributions do not overlap
- Within-arm spread here is 1.23x and 1.35x, far tighter than the 2.28x-3.48x measured on the other corpus, which is why five pairs settle it: the task is bounded by a cycle cap and by twelve files …
- This supersedes the earlier one-run reading of 0.89x-3.09x, which is what a single pair bought and was correctly refused as a result.
- The same comparison against a competent script.
- Table: arm, n, mean, completed, per module.
- Resuming closes about half the gap, exactly as the cold-start figure predicts.
- The clearest way to state it: the engine did **50% more work for 28% less money**.
- What could not be compared, and why that is a fact rather than a caveat.
- This install authenticates with a **subscription OAuth credential** (`claudeAiOauth`: an access token, a refresh token and a `subscriptionType`).
- That boundary is worth stating in a metering document because it is the same boundary an operator of this app is standing behind.
