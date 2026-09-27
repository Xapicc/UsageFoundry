# Verification: Metering and cost

[← Verification index](../verification.md)

## Verified

- **Cost math cross-checked by hand:** `$12.843618` vs the API's `$12.8436175`
  on 54 in / 83,517 out / 12,072,025 cache-read / 471,941 cache-1h tokens.

- **Fable 5.1 / Mythos 5.1 rates, read off the pricing page, not measured,
  2026-09-04:** $10 input, $12.50 5m write, $20 1h write, $0.25 cache hit, $50
  output per MTok; cache hits bill at 0.025x base input, other models 0.1x.

- **Dedup verified:** 99 → 31 records.

- **Dedup keeps each turn's highest-output line, 40,885 turns / 1,011 files,
  2026-08-21:** the last line held the most output in 27,228 of 27,228
  multi-line turns; first-seen understated output 15.6% on CLI 2.1.226 and
  74.9% on 2.1.238.

- **Incremental re-scan picks up records appended mid-session.**

- **Model-ID canonicalisation:** `us.anthropic.claude-opus-5-20260101-v1:0`
  and `claude-sonnet-4-5@20250929` resolve, `claude-nextgen-9` stays unknown,
  `claude-opus-4-1` keeps its own $15/$75.

- **A zero-token `<synthetic>` turn is not an unpriced model** and incurs no
  fallback charge.

- **5-hour windows open at their first turn, not on the hour:** the CLI's reset
  formatter emits minutes and nothing local records the instant. On 4,663 real
  turns 86 moved back into the window really open; the old rule re-armed the
  session guard 17 minutes before Anthropic's window closed.

- **Attribution tables reconcile over 998 real turns:** effort, sub-agent and
  skill each match the window total ($138.3639) within rounding.

- **Calendar periods, 9,200 real turns / 303 files, `Europe/Berlin` on a UTC
  host:** days break at local midnight with every turn in one bucket; the
  weekly bucket matched the weekly meter ($1,228.79) and a $700 week pro-rates
  to $100.00 a day. Nine unit tests add DST and the no-ceiling case.

- **OTLP ingest over HTTP:** a captured batch inserts 1 row and its replay 0;
  a non-JSON body still gets 200 so the exporter stops retrying; no column
  holds `user.email` or an account UUID.

- **OTLP transport, captured from a real headless `claude -p`, CLI v2.1.226:**
  uncompressed JSON to `/api/otlp/v1/logs` and `/v1/metrics`; the event is
  `event.name` `api_request`, the documented `claude_code.api_request` being
  the record body. The parser accepts both.

- **OTLP parser, 13 assertions on the captured payloads:** extracts cost,
  tokens and run id, drops `user.email` / `user.account_uuid`, inserts 0 on
  redelivery, and returns empty rather than throwing on malformed input.

- **Live from runs card, real database via the live ingest route:** counts
  only the five in-window, run-attributed requests, takes status from the
  `runs` join, and never reaches `session.costUSD`; it vanishes when *Agent
  self-reporting* is off.

- **Live from runs card rendering, `npm test` 5 cases:** the first-party figure
  never renders without the three sentences that keep it from reading as an
  addend; a `TOP_RUNS`-capped list says how many runs it left out.

- **Plan detection** reads `Claude Max 20x` from `.credentials.json` with no
  identity crossing the wire, caches 60s including misses, and says "plan
  unknown" without error; a redirected `CLAUDE_HOME` reports no plan rather
  than the wrong one.

- **Most of this fleet's spend is carrying context, 2026-08-23.** 1,194
  transcripts (49,038 deduped turns, $6,537, 12.3 days): 58% cache read, 20%
  cache write, though `fileCostNotice.ts` reads 60.5% / 26.5%, so good to a
  few points. Repricing the 327 runs at sonnet-5 gives 0.408× ($3,043.09 to
  $1,241.30): arithmetic over produced tokens, not a forecast.

- **A cycle's spend summed two nested `result` events, 2026-08-27.** Run
  `075f7959`: $16.355574 against telemetry's $9.330155, which matches its 110
  `requestId`s exactly; a late sub-agent re-inited the session and the second
  `result` contained the first. 2 of 39 multi-result runs drift (`65252b8a`
  +$29.082). `result.usage` omits sub-agent tokens: CLI scoping, left as is.

- **The unsplit-cache-write notice and its hatched span, 2026-09-09**, one
  synthetic `claude-sonnet-4-5-20250929` turn, 100k cache writes with no
  breakdown: at a $1 limit the 5-hour meter read **40.2% – 62.7%**, matching
  $0.4024 (5m rate) and $0.6274 (1h rate) by hand.

- **`rate_limit_event`'s shape, read off the pinned binary, 2026-09-09**
  (`grep -ao` in `bin/claude.exe`), then a stubbed event through the
  standalone bundle: `/api/usage` kept `utilization` 0.15/0.06 undivided, the
  card drew "5-hour 15.0%", and `allowed_warning` drew the unhandled notice.
  - `status`: `allowed`, `allowed_warning`, `rejected`
  - `five_hour`, `seven_day`, `seven_day_overage_included`, each
    `{utilization, resetsAt}`: a fraction that can exceed 1, epoch seconds
  - read from `anthropic-ratelimit-unified-*` headers; emitted on change, not
    on a cadence; absent on API-key, Bedrock and Vertex sessions

- **The prices around two 2026-08-23 levers are measured; their effect is
  not.** A two-cycle run averaged $19.19 against $10.05 for one, and a call cost
  12.0c early against 20.4c late. `orchestrator.ts` (~116,000 tokens) was read
  496 times across 78 runs, `workflows.ts` (68,000) over 185; by arithmetic one
  avoided full read of the first is worth about $3.19.

- **`total_cost_usd` is a resumed session's running total on 2.1.280, read off
  the arm64 binary and transcripts, no turn spawned, 2026-09-27.** The binary
  restores a saved `costState` into its ledger (`nte` → `aAr` →
  `costLedger.restore`) and builds `result.total_cost_usd` from
  `costLedger.totalCostUSD()`. 138 of 138 local transcripts holding two or
  more `cost-state` records (of 1,617; 36 written by 2.1.280) never fall — one
  session read 8.415 → 10.340 → 11.970. Caveat: the call path from `--resume`
  to the restore was not traced. The chat's `turnCostOf` banks the increase on
  this reading.

## Not yet verified by hand

- **No real resumed chat turn has been compared with its transcript.** The
  entry above is read, not run, and `chat_turn_spend` now banks each resumed
  turn's increase on it; whether `result.usage` is cumulative too is unread.
  Settle it with two turns on one thread in a logged-in container: compare
  `SELECT ts, cost_usd FROM chat_turn_spend WHERE chat_id = '<id>'` in
  `$DATA_DIR/usagefoundry.db` with that session's deduped per-message usage in
  `~/.claude/projects/*/<session>.jsonl` priced by `pricing.ts`, and read the
  second turn's `result.usage` against the first's.

- **No Fable 5.1 / Mythos 5.1 turn has been metered here.** A transcript not
  spelling `claude-fable-5-1` / `claude-mythos-5-1` would price silently at the
  Fable 5 rate.

- **The `cycleCostAfterResult` fix is unit-tested only, 2026-08-27.** 1,816
  tests pass; no rebuild, not read in the running app. Check a two-`success`
  cycle's run-page spend against its telemetry card. `075f7959` and
  `65252b8a` keep their inflated stored `runs.spent_usd`.

- **The unsplit-cache-write notice was seen only on `next start`**, not the
  standalone bundle, with the settings row written in SQL; no real transcript
  lacking the breakdown has been seen.

- **The metering figures measured on 2.1.226 have not been re-measured on
  2.1.260** (the pin moved 2026-09-04). Each parser degrades quietly, so a
  green build proves nothing about metering. One assist's 2.1.260 stdout has
  been parsed (2026-09-09); nobody has compared a 2.1.260 work cycle's spend,
  OTLP records or transcript against the 2.1.226 readings.

- **The pin moved to 2.1.280 on 2026-09-24, and nothing on this page has been
  re-measured against it.** Every figure above that names a CLI names 2.1.226
  or 2.1.260, because those are the builds they were taken from: the
  `stream-json` shapes `handleStreamLine` parses, the OTLP records `otlp.ts`
  reads, the compaction threshold `readCompactions` keys on, the mount points in
  `sandboxMountPoints.ts`, and the
  nine sandbox answers in `scripts/sandbox-probe/RUNBOOK.md` (whose probe pin
  follows the shipped image's and has moved with it). Those readings stand as
  history and are not claims about what the image now installs. What **was**
  checked before the bump is the cheap half, the same half 2026-09-04's was:
  every flag `buildArgs` and `sessionAgentArgs` emit is in the 2.1.280 binary
  (entry above), so a run will at least start, an unknown flag being the one
  failure here that is loud. `modelCatalogue.ts`'s `[1m]` list has since been
  read off the 2.1.280 arm64 binary and is no longer on this list (entry under
  *Agents, templates and models*); the amd64 build of that version still has
  not been read. What was **not**: a single container run on the
  new pin, so no `stream-json` line, no `result` event, no OTLP record and no
  transcript written by 2.1.280 has been through this app's parsers. Each of
  those degrades *quietly* — an unparsed line becomes a log entry, a missing
  `result` understates spend, an unrecognised compaction boundary is simply not
  seen — so a green build here proves nothing about metering. Nor does `npm
  test`: the two lists `sandboxMountPoints.test.ts` asserts are read out of
  whatever `claude.exe` is installed beside it, which in the container this
  entry was written in is still 2.1.260 (`claude --version`, checked), so that
  suite keeps passing against the build the pin just left and will not notice a
  2.1.280 change to either list until the image is rebuilt. No image has been
  built on this pin at all: the container the bump was made in carries no
  Docker client and no daemon socket, so the `npm install -g
  @anthropic-ai/claude-code@2.1.280` line is unexercised beyond the registry
  confirming that the version resolves. The first `docker compose up --build`
  with a real cycle is what settles all of it. Note also that 2.1.280 was
  **not** npm's newest that day — `latest` was 2.1.281 and `next` 2.1.282, both
  read from the registry after the pin was chosen. It was held at 2.1.280
  deliberately, so that the model-id list being measured against exactly this
  build stays a claim about the program the image installs.

- **The per-repository cost card has never been rendered or read against a
  real multi-repository install.** `groupRunSpend` is unit-tested only. Check
  its total against `SELECT SUM(spent_usd) FROM runs WHERE created_at >= …`,
  and that a run outside git lands in `(not a repository)`.

- **No browser has rendered the Usage by period card.** Its rollup ran against
  9,200 real turns, but its sandbox could not execute Next's edge runtime.
  Unseen: the tab strip at a narrow width, a fourteen-row daily table, and a
  798% meter clamping to a full bar.

- **A 413 from the OTLP ingest route, on the wire.** `readCappedBody` is unit
  tested; no oversized request has reached a running server.

- **The derived 5-hour boundary against a live `/usage` reading.** Argued, not
  watched; the residual offset against the real reset time is unmeasured.

- **The Live from runs card, looked at on a real telemetry-enabled run**:
  whether it reads apart from the meters and moves within one cycle.
