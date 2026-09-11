# Verification log

[← Documentation index](README.md)

What has been exercised by hand against real transcripts, a real CLI and the
built container — and, under *Not yet verified by hand*, what has not. Each
entry is one claim: what was measured, when, against which pin, the result and
its caveat, filed under its area. The long-form write-ups these entries were
condensed from, including how each thing was found, are
`git show df8626c:docs/verification.md`.

`npm run typecheck` plus a `docker compose up --build` smoke test is the real
verification loop. What `npm test` covers, and why each test earned its place,
is `docs/agent/testing.md`; interface defects and their classes are
[`interface-defects.md`](interface-defects.md).

## Verified

### Metering and cost

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

### Budgets and guards

- **Budget refusal returns `blocked` with 0 iterations and 0 spend.**

- **Metric selection:** the cost ceiling wins when both are set, tokens when
  cost is cleared, null when neither is.

- **The guard reads the cost fraction:** with the window at 11.2%, allowed at
  an 80% guard and refused at 5%.

- **Unpriced-model guard fallback, 17 assertions:** 90M output tokens from an
  unknown model read `$0`, yet `guardFraction` is 45× a $100 ceiling and the
  guard blocks; priced windows are unchanged, and no ceiling still refuses.

- **Reserved headroom:** a 50% reserve halves a $200 ceiling to $100, doubling
  the reading (13.8% → 27.5%) past a 20% guard; 400% clamps to 95%.

- **Budget policy and guard order, `npm test` 11 cases:** `normalizePolicy` is
  idempotent over JSON; `evaluateBudget` refuses `no_terminus` first, parks on
  the 5-hour window only under `live-resume` and never on the weekly, and
  blocks on reconciled spend that `spent_usd` alone would miss.

### Run lifecycle

- **Stop reaches `stopped` against a stub that ignores SIGTERM**, about 8s
  after the stop (5s escalation + 2s drain), instead of staying `running`
  forever; the iteration also settles on `exit`, since a grandchild can hold
  stdout open.

- **Operator stop records `stopped`**, not `failed`, with the interrupted-cost
  note in `stop_reason`.

- **Normal accounting survives the stop fix:** a stub `result` event records
  $0.42 / 35 tokens and completes on `DONE` with no interrupted-cost note.

- **Restart recovery:** a row left `running` closes as `failed` with
  `claude --resume <id>` in its stop reason, freeing the folder.

- **One real billed run, end to end:** 1 iteration, exit 0, stopped at the
  cap, $0.067 / 13,983 tokens accounted correctly.

- **Provider refusals, `npm test` 18 cases:** spend caps and credit balances
  fail as themselves while a 429 or an overload is transient;
  `refusalResumeAt` backs off 20/40/60 minutes, never re-spawns inside five
  and never holds a folder past six hours.

- **`acceptEdits` holds mutating git for an approval a `-p` child cannot get:**
  four runs ended with their change uncommitted. For $0.02, `--allowedTools
  "Bash(git add:*)" "Bash(git commit:*)"` committed while `git push` stayed
  refused, and proved additive outside `manual`.

- **Agents here have never had `Grep` or `Glob`:** CLI 2.1.226 drops both when
  `Bash` is present, and 0 of 469 `system:init` events since 2026-08-10
  carried `Grep`.

- **The outbound webhook delivers and its signature verifies, 2026-08-23.**
  The compiled `notifyLifecycle` at a local listener: four events, two POSTs
  (`needs-review`; `stopped` after a `budget` verdict), six-key UTF-8 body,
  `sha256=` header matched by `openssl` and Python's `hmac`. A real POST to
  httpbin got 200, but byte fidelity is proved over loopback only.

- **An assist's `stream-json` stdout against the pin, 2026-09-09**: CLI
  `2.1.260`, `spawnAssist`'s whole flag set, exit 0, eight lines. The
  `tool_use` came on an `assistant` event in the shape `assistToolUses` reads;
  `parseReviewOutput` read `completed`, $0.206351, 64,437 tokens.
  - argv: `-p … --output-format stream-json --verbose --permission-mode plan
    --max-budget-usd 0.30 --allowedTools Grep Glob Read`
  - lines: three `system`, two `assistant`, one each of `rate_limit_event`,
    `user` and `result`

- **The live log's open-tool rows, rendered in isolation, 2026-09-11**:
  `renderToStaticMarkup` with the built CSS at 1280 and 390, both skins; the
  `sticky bottom-0` rows sit flush in both scroll states, jump-to-live paints
  over them, and 390px has no sideways scroll.

- **Every flag `buildArgs` and `sessionAgentArgs` emit is in `claude --help` on
  2.1.260**, checked before the 2026-09-04 bump, so a run will at least start.

- **The failed `tool_result` shape comes from real CLI 2.1.226 transcripts.**
  Both the string and the array-of-blocks `content` carry `is_error: true`.

- **The `<synthetic>` refusal marker**, from a real record on this machine;
  the only refusal seen here is `Not logged in · Please run /login`.

- **`Connection closed mid-response`, seen in a real run** (then filed
  `failed`); one of five `isTransientApiError` sentences from the binary.

- **A new run takes a parked run's folder straight away**, reproduced against
  the live container.

- **The refusals around resuming a finished run** (an exhausted cycle or spend
  limit, a taken checkout), checked against the live container.

- **The column a follow-up pick-up reads is written end to end**, against a
  stub CLI printing the two `stream-json` events the loop reads.

- **`Grep`/`Glob` on `--allowedTools` restore both tools, on four `system:init`
  events.** Two with only those names (throwaway container; real image, live
  container), one with two `Bash(git …:*)` grants in front, one also under
  `--permission-mode plan`. None was a spawn from this app; `SEARCH_TOOLS` on
  every spawn's argv is unit-tested only.

- **The `needs-review` matcher, precedence, prompt composition, loop stop and
  edge semantics are unit-tested.**

### Context control

- **`--autocompact` removed 2026-08-24 for `contextPruning.ts`, at the same
  167,000 it fired at**, knowing its measured value: over 1,147 transcripts,
  turns past the cap cost 0.45x per turn and 0.50x per 1,000 output tokens
  between the two arms. A decision, not a regression; nothing retracted.

- **winnow's own token figure is unusable, 2026-08-24.** It read
  `Saved 0 tokens (0.0%)` for a prune that removed 28% of what is sent: it
  comes from historical `usage` frames and cannot express a delta. winnow
  wrote no receipts either, so `contextPruning.ts` measures `message` content
  before and after itself, and that is the only figure the app reports.

- **winnow at `standard` removed 28% and 38.4% of context, 2026-08-24.**
  winnow `b49fceb`, `winnow safe run -- treat … -rx standard`: 72,392 tokens
  from `f2de6d64-…jsonl` (2.0 MB), 154,609 from `06510dfb-…jsonl` (2.4 MB).
  Bytes freed overstated these 3.4× and 2.0×, a ratio that varies by session,
  so no fixed factor corrects it and the app never renders bytes freed.

- **`gentle` removes nothing, 2026-08-24.** 0 bytes on `f2de6d64-…jsonl`: its
  one strategy that fires on an ordinary session, `metadata-strip`, is
  excluded by name in orchestrator-safe mode, so the setting offers two
  positions, not three.

- **Every prune leaves a full-size `.bak`; only a listing sweep removes it,
  2026-09-08.** `create_backup=True` is hardcoded in winnow and `shutil.copy2`
  keeps the source's mtime, so the old mtime filter missed them: eleven
  copies, 18.8 MB, had survived here. On a real prune the old sweep left its
  `.bak`; `removeBackups`' pre-spawn directory listing left nothing.

- **Four real prunes at `aggressive` removed 29.1-52.8%, 2026-08-24.** All
  early-end, at 167,326-169,283 tokens; removal matched the observed context
  drop to about 3% (266,683 claimed, 274,619 observed). The resume
  invalidation was understated 16.6%, so `netReceipt` now prices it off the
  first billed turn's `cache_creation_input_tokens`.

- **Both prune triggers have fired: 54 receipts, 52 `early-end` and 2
  `boundary`, read 2026-09-07.** 2026-08-24 to 2026-08-28, 47 runs, read from
  `/data/usagefoundry.db`, not the untracked `prune-audit-dump.json`. Receipts
  1-4 match the four measured 2026-08-24 digit for digit. `tokens_before` is
  the transcript measure, not the API measure the ceiling compares.

- **Intake-filter/prune overlap is 4.06% of pruned tokens, an upper bound,
  2026-08-24.** Corpus-weighted over this install's ten largest transcripts;
  3.07% unweighted, 0.00-9.92% spread. The context card adds the two figures
  and does not print the bound. No correction today: no ledger line carries a
  `tool_use_id` (15 of 15 results on the fallback key).

- **The filter ledger's live readout nets `+$0.0660675`, a floor,
  2026-08-24T21:12Z.** 125 lines held 15 distinct results, 15,144 tokens, so
  summing the file would overstate 24.8×, a factor that grows with session
  length. A floor because 82 of 125 requests joined no main-thread turn and
  only 6 of 15 results were priced.

- **`intakeFilter.ts` read a dead ledger path from 2026-08-25, as `missing`.**
  The ledger had moved to `/data/winnow/filter.jsonl`; `GET /api/usage` showed
  every figure zero while it held 212 lines. At the real path 215 of 217
  request ids joined, all main-thread: how much of a ledger joins depends on
  what the fleet was doing.

- **The API and transcript context measures sat ~65,000 apart, 2026-08-25.**
  Run `a75a7cb7`: the last request before the prune carried 183,214 prompt
  tokens against 118,776 in the transcript's turns. Its first request carried
  57,819 against 2,759 of conversation, through the winnow proxy, which turns
  tool deferral off; no prune reaches that fixed part.

- **Ratio versus subtraction on that crossing, 2026-08-25.** The first request
  after the prune carried 120,595. `apiContextTokens` minus what came out gave
  132.9k, high; `contextAfterPrune`'s ratio gave 105.6k, low, because it
  scales the fixed prompt down too. It now subtracts: high never claims more
  was freed than was.

- **At a 167,000 ceiling a run was back over it five minutes after its own
  prune, 2026-08-25.** The ~55,000 fixed prompt left ~112,000 prunable.
  `CYCLE_CONTEXT_CEILING_TOKENS` went to 300,000, then the same day to 200,000
  (~145,000 prunable), and the size gate before the check went, since ~55,000
  prompt tokens are in no transcript.

- **The fixed prompt carried 17,229 tokens of the intake filter, 2026-08-27.**
  A custom `ANTHROPIC_BASE_URL` turns the CLI's tool deferral off: the live
  argv replayed gave 30,845 prompt tokens direct and 48,074 through the proxy.
  `docker-entrypoint.sh` now exports `ENABLE_TOOL_SEARCH=1` (30,849). Sessions
  step up at 2026-08-24T14:05:19, when `WINNOW_FILTER=1` was first switched on.

- **The intake filter held streamed responses back in 8 KB blocks, killing
  long generations, 2026-09-11.** `proxy.py` relayed with `read(8192)`, which
  on a chunked body reads until 8 KB arrive. Run `b511c547` lost one turn
  twelve times across two processes, nine of them ending 300.0–300.6 s after
  the attempt began — the floor CLI 2.1.260 puts under
  `CLAUDE_STREAM_IDLE_TIMEOUT_MS`. winnow `4b1b7b1` relays with `read1`; a
  held-upstream test fails before it and passes after. Reopened on it, the
  run's first Write carried 32,827 bytes in a 2 min 53 s response, no retry.

- **`--autocompact` creates the only compaction threshold, firing at ~167,000,
  2026-08-22.** 1,147 transcripts split at `ee93684`: before the flag, 604
  sessions (246 past 167,000) made zero `compact_boundary` records; after, 53
  made 42. CLI 2.1.226 fires at min(asked, window) − min(maxOutput, 20,000) −
  13,000, so 167,000 for 200,000; 30 of 42 boundaries fell within ±3,000.

- **Capping cut cost to 0.45× per turn and 0.50× per 1,000 output tokens,
  2026-08-22.** Compared between arms from where each session reaches the cap;
  a natural experiment, not randomised (same pin and model, different periods
  and workloads). The within-session ±K-turn figure (−18.6% to −23.2%) is a
  phase contrast, not a saving; do not quote it.

  | | sessions | turns | cache $/turn | $/1k output | output/turn |
  |---|---|---|---|---|---|
  | Uncapped | 227 | 15,933 | $0.1656 | $0.1849 | 896 |
  | Capped | 16 | 1,541 | $0.0742 | $0.0930 | 798 |

- **Decision, 2026-08-22: keep the autocompact window at 200,000, declining
  issue #156's 150,000.** 150,000 fires at 117,000, and a firing spread of
  roughly ±12,000 reaches the CLI breaker's 100,000 floor. No breaker trip was
  found (zero `type: "system"` matches). `AUTOCOMPACT_WINDOW_TOKENS` has since
  gone from `src/`.

- **The runs list's `Pruning` column renders, 2026-08-25.** Production build,
  seeded runs: `+$0.77`, an early end netting `−$0.07`, and `—` with no
  receipts (`prunedNetUSD` absent, not 0); wire matched render at 1440px and
  stacked below `md`. `next dev` 500'd there (`EvalError` from
  `edge-instrumentation`).

- **The context ceiling priced the wrong winnow engine, 2026-08-28.** It read
  `winnow plan --tier CB` (8.5k tokens, 2.2%, on session `02584a86`) on an
  install running `treat -rx aggressive`, which frees 49% there and 53% on
  `de288909` (winnow 1.8.39, dry-run in the container). No prune landed after
  2026-08-26 21:14.

- **The corrected ceiling path declines one session and prunes the other,
  2026-08-28.** Real dry-run stdout through `parseTreatEstimate` to
  `ceilingDeclineMessage`: `02584a86` 49.0%, T\* = 21, declined by one turn;
  `de288909` 53.0%, T\* = 18, pruned; horizon 20.

- **Treat's byte share cannot be converted with `BYTES_PER_TOKEN`.** Session
  `02584a86` ran 14.8 bytes a token, four times the constant, so 1.79 MB read
  as 521k tokens removed from a 258k-token context and `ceilingPayback`
  priced it at 0 turns. A test asserts the overshoot before the fix.

- **A written fork removes nothing from the API's window**, all five forks
  this install has written (2026-08-28 export): 58,002 tokens recorded removed,
  the window **+14,745** after resume, five 178k–260k cold rewrites paid; 0
  bytes of `toolUseResult` removed. The in-place engine does reach the wire:
  108,534 claimed, 114,350 measured, run `115c617d`.

  | run | `net_bytes` | recorded removed (÷3.6) | API before | API after | measured change | resume's `cache_creation` |
  |---|---|---|---|---|---|---|
  | 3da14af4 | 16,839 | 4,678 | 200,964 | 202,117 | **+1,153** | 180,259 |
  | 07f9e442 | 31,962 | 8,878 | 199,751 | 201,908 | **+2,157** | 178,675 |
  | 7f361068 | 63,337 | 17,594 | 199,807 | 205,045 | **+5,238** | 183,187 |
  | fc491479 | 60,911 | 16,920 | 204,471 | 207,102 | **+2,631** | 185,244 |
  | c939c07a | 35,756 | 9,932 | 281,628 | 285,194 | **+3,566** | 259,881 |

- **Context pruning runs on real work cycles (recorded 2026-09-07).** This
  install held 52 `early-end` receipts against 2 `boundary`: both triggers
  fired. The image's `WINNOW_REF` step worked (54 receipts need `/opt/winnow`);
  `Xapicc/winnow` is `PUBLIC`. Four runs took a second prune, `54931cbb` a
  third, all completed: the loop re-enters resumably.

- **The context occupancy series has been written by real runs (2026-08-27).**
  198 rows across 10 runs at the default 60 s tick: 159 of 188 gaps are one
  tick, the widest 1,320 s while run `fc491479` sat in a sub-agent; every gap is
  a multiple of 60 s, so gaps are deduplication, not a late ticker. 16 rows
  carry `turns_exact` false.

- **`ContextOccupancy` rendered in headless Chromium, in isolation, on synthetic
  data.** Four states in a 336px box against the build's CSS, light and dark:
  token classes resolve, the sawtooth is legible with prune rules on the cliffs,
  the no-reading hatch is not a zero fill, the legend fits one line.

- **The intake-filter card's markup caught a defect.** Of 24
  `renderToStaticMarkup` cases (eight filter states, both components, both
  pruning states), one printed `Net +$0.00` on a fully unpriced read; the money
  rows are now omitted there. The reader has run on the real ledger and
  transcripts, its arithmetic under 13 unit tests.

- **The compaction reader and `compactionNotice` have run against a real
  boundary off this machine.** The session matched and the notice rendered in
  full; only the run loop's call site is unexercised.

- **The context composition series, and the winnow pin it needed,
  2026-09-04.** The pin moved from `0384486` to `0421da5` (forty-three commits)
  because `winnow context` is an unknown command at the old one; all four
  spawned subcommands were re-read at the new pin against a real 8.7 MB
  transcript, and `docker compose build` completed.
  - In the image, `safe run -- context <path> --depth 1 --json` returned a body
    with stderr empty in ~0.12 s; `parseComposition` read window 433,331 and
    six bands summing to it exactly.
  - `python -m winnow context --help` outside `safe run` printed that it wired
    7 hooks into `~/.claude/settings.json`; every app spawn uses `safe run`.

- **A depth-3 `winnow context` body is 18–29 KB, 2026-09-04**: 72 to 110
  sub-nodes and at most 29 children under one parent over the four largest
  local transcripts (7.2–12.9 MB), so the 4 MB stdout bound holds. Against the
  real pinned winnow the tree round-tripped through `recordComposition`, which
  kept the newest reading's only, and `sweepRunEvents` removed it with its run.

- **The composition stack clipped because the parse floored a signed residual,
  2026-09-10.** On run `5b967a08` the eight stored readings summed past their
  windows after the first (324,569 against 243,678 at the last) with
  `unattributed` stored at 0; `winnow context --depth 2 --json` on the same
  transcript put it at −17,969, and `context.py` allows a negative residual.

- **Nothing was displaced on that run; the picture was the clip, 2026-09-10.**
  The prefix held at 14,392 tokens on all eight readings and standing
  configuration grew from 18,098 to 44,511.

- **The signed residual, end to end, 2026-09-10.** `parseComposition` keeps the
  sign (−81,822 on that transcript) and `migrate()` re-derives every stored
  residual on boot — idempotent on a scratch database first. After `docker
  compose up --build`: all eight readings sum to their windows, residuals −1 to
  −80,891, every band has height, the legend reads `unattributed −80.9k`.

- **The tick writes `context_compositions` on a real run, 2026-09-10.** Eight
  readings on run `5b967a08`, paced by growth, one taken a minute after the
  early-end cut at 30 minutes; `compositionSeries` draws the stored rows.

### Orchestrator chat

- **Orchestrator chat end to end, real CLI 2.1.226:** a chat proposed a run
  from a saved template, it was approved and completed ($0.22 the turn, $0.165
  the run), and `/api/mcp`'s hand-written handlers served the pinned CLI.

- **Chat thread order, `npm test` 3 cases, real database:** same-millisecond
  messages keep insert order across a reopen and over null-`seq` rows; the
  migration, on three rows from the live deployment, put the reply back above
  its denial note.

- **Under `manual` plus an allowlist the chat could not write** (`No such tool
  available: Write`). That is not what ships: it now runs `bypassPermissions`
  with no tool list, held back only by its system prompt.

- **`--permission-mode plan` cannot run the chat:** every MCP call answered
  `Cannot call mcp__uf__list_templates while in plan mode`.

- **The chat child gets the fill and the sweep, 2026-09-09.** Before: 118
  bwrap failures in 53 of 192 `-workspace` sessions (67 `.claude` list, 35
  config dir, 16 `/workspace` root, which it leaves). A bwrap-effect stub via
  `runOrchestratorChild` left ten placeholders at `HEAD~1` and only the
  operator's `?? .vscode/` at `HEAD`. Deliberately no `core.excludesFile`.

- **A chat turn streams and survives a crash, 2026-09-06**, fake `CLAUDE_BIN`,
  nothing billed: `partialText` grew, then settled to the CLI's `0.0731`; after
  a `SIGKILL` the boot pass kept the half-answer, cost `0.022` marked
  `estimated = 1`; a $0.025 install ceiling stopped it mid-turn, $0.03 did not.

- **A stale Approve on a superseded proposal is refused, 2026-09-08**,
  standalone server, non-spawning `CLAUDE_BIN`, 13/13 assertions: "Nothing was
  approved…", zero runs, the badge counting only the replacement, and the
  `SUPERSEDED` card linking to it.

- **The chat naming a model, driven in-process through `/api/mcp`.** With a
  minted capability, `propose_run` and `save_template` write and state a named
  model, store null for a blank, and `save_template` keeps it when omitted;
  guards unchanged. The migration survived seeded rows and the
  pre-`relaxProposalTemplate` schema. `npm test` 2,139 tests / 0 failures.

- **The `ask_operator` card was rendered and clicked in Chromium at 1440×1000
  and 390**, over hand-seeded threads with `POST /api/chat/[id]/questions`
  intercepted: six card states and the `asked you` marker drew, dark and 390px
  held, its text controls are 16px below `md`, and a choice sends on one press
  only when it is the only open question.

- **One poll of an open chat thread is flat in its length, 2026-09-07**: on a
  throwaway database, 246,362 bytes to 1,136 at 500 messages and 1,004,522 to
  1,137 at 2,000, the cursored read now on `idx_chat_messages_seq` with no
  sort. A thread's first read costs 2.0% more, once.

### Taskboard

- **The taskboard in a browser, 2026-09-07**, standalone server, seeded
  `tasks`: a clipped 310-character brief survived a title-only save; every
  operator move worked through its own button; a refusal rendered
  `taskTransitionRefusal` verbatim; all three nothings drew; ⌘1…⌘9 matched the
  sidebar; no console error at 1280 or 390.

- **The board's MCP tools, in-process, 2026-09-07**: the real route handler
  compiled with `tsc`, tokens from `mintCapability`, 23/23 assertions. Block
  tokens lack `create_task`, `status: "done"` is refused by name, unknown ids
  are refused at all three doors; it caught `propose_run` dropping `taskId`.

- **The task link on its three surfaces, 2026-09-07**, Chromium at 1280px,
  rows seeded through `src/lib`: the proposal card names the task or "a task
  since deleted" and still offers Approve; the run page links it, still Open
  after the run completed; the board row lists the run.

- **The `taskboardForRuns` switch is off on a never-written settings file,
  2026-09-07**, Chromium at 1280px, production build; `smoke-pages` drew
  `/settings` and `/tasks` clean at 390 and 1280.

### Workflows and schedules

- **Workflows end to end, live dev server, stub CLI:** save refuses each bad
  graph by name; a four-block graph ran its roots in parallel and continued a
  branch; a failed root left its `on-success` dependent `blocked` while the
  `on-finish` one ran; deleting a workflow keeps its runs.

- **Canvas live check:** `POST /api/workflows/validate` returned each of nine
  refusals as `normalizeWorkflowInput`'s sentence and a valid graph as
  `{"ok":true}`; all four workflow pages answered 200.

- **A workflow's history pages, 2026-09-07**, `next start`, 45 seeded
  instances: 20 by default, `?offset=999` clamps to the oldest row and
  `?limit=5000` to 100; the page drew `1–20 of 45`, Next drew `21–40 of 45`.

- **A drawn workflow cannot be discarded without being asked, 2026-09-07**
  (Chromium 1400×900, production build): the sidebar link, breadcrumb,
  Cancel, ⌘3 and quick open each raised *Discard unsaved changes?*; a
  Ctrl-click and an unchanged or typed-back editor did not. Browser Back was
  deliberately not tested.

### Concurrency and ownership

- **Folder collision, `npm test` 8 cases:** self, parent/child both ways, a
  second workspace's alias and a case-only difference collide, a sibling does
  not; isolated checkouts collide only with a whole-workspace run.

- **Concurrency, real database, stub agent:** a second run on one folder
  queues and is promoted when the first ends, another folder starts at once,
  and a workspace-root run queues behind both without starving.

- **Concurrency limit 1:** runs on two further idle folders queue rather than
  being refused, one promoted per freed slot; a run whose agent leaves a
  grandchild holding its output still terminates.

- **The `chat_proposals` rebuild keeps rows, index and cascade**, against
  SQLite directly and under a throw after each statement
  (`schemaMigration.test.ts`).

- **A process that does not own the data directory no longer closes the
  owner's runs on exit**: `shutdownRuns` is gated on `mayWriteDataDir()`. A new
  `shutdown.test.ts` case (a lock naming a live foreign pid, then
  `claimDataDir()`) failed on the unfixed function: `closed: 1, recovered: 1`,
  the row's `restart_closed`, `active_started_at`, `spent_usd_est` rewritten.

- **What a migration finds now outlives stdout, 2026-09-07**: all four
  findings, driven against a real SQLite file by reopening it, write one
  `ops_events` row each under `schema.fault`. `schemaMigration.test.ts`'s five
  cases fail with the write removed (`# fail 5`, then `# pass 16`), and the row
  survives the fault clearing.

### Isolation and landing

- **Isolation, real repo with uncommitted work and a gitignored `.env`:** two
  runs start in separate slots on their own `uf/…` branches with `.env`
  seeded; the operator's modified file and branch are untouched.

- **Review and land, real scratch repos, stub CLI (unbilled):** diffs survive
  a rename, a binary and a tab-named file; land refuses a dirty or wrong-branch
  checkout and leaves HEAD unmoved on conflict; a stub resolver faking success
  is caught and rolled back, cost still recorded. Also driven in a browser.

- **Merge queue, five-branch scratch repo, live dev server, stub resolver:**
  branches landed in queue order, the $0.07 resolution on the queue row not
  the run; with the resolver off the next branch still landed; a dirty
  checkout skipped both queued branches without paying to resolve.

- **Conflict display, git 2.50, a content and a modify/delete conflict:** real
  `merge-tree --write-tree -z` through `parseMergeTree` lists each file once
  with its type and `<<<<<<<` block, and the run page renders both.

- **Resolution display, from a seeded `run_reviews` row, never a real
  agent's:** `GET /api/runs/<id>/land` returns the resolution's own diff over
  the conflicted paths and the run page renders it.

- **The Land verify field in a browser, 2026-09-07**, standalone bundle:
  settings search found it inside the closed *Isolated runs* fold and focused
  it; `npm test && npm run typecheck` drew the argv warning on blur, before any
  Save; "Checks a conflict resolution may run" sits beneath it.

- **Conflicts map (`/runs/[id]/conflicts`) seen against real `merge-tree`
  output.** `next dev`, eight planted runs on built repos, 1280×1100, light
  theme: 21 paths (12 unopened, drawn hollow and dashed), three of four fills,
  the inspector, five empty states, n=1, one link in. A binary conflict reads
  `contents`, as `parseMergeTree` takes the last record.

### Git and review

- **Diff and land parsers, `npm test` 24 assertions:** NUL-separated numstat
  and name-status incl. renames and tabs, patch splitting that ignores `diff
  --git` inside a hunk, `merge-tree` on an old git, every `landRefusal` branch.

- **GitHub credential block, real git 2.39.5:** `credential fill` returns the
  token past a repo-configured missing helper (`osxkeychain`), SSH GitHub
  remotes rewrite to HTTPS, and `gitlab.com` fails without prompting. Six
  `npm test` assertions.

- **git 2.39.5 formats behind Delete and Purge:** `status --porcelain -z`
  needs its leading space, so `.trim()` drops an unstaged file (hence `trim:
  false`); `worktree remove` needs `--force` on a dirty checkout, and `branch
  -d` refuses an unmerged branch where `-D` deletes it.

- **`core.excludesFile` via `GIT_CONFIG_*` lets `git add -A` pass the bound
  dotfiles, 2026-09-09.** git 2.39.5: exit 0, none staged, a nested
  `.gitconfig` still staged; `agentGitEnv` keeps the GitHub pairs in the same
  block. Only the `os.tmpdir()` path was written; 2590 tests pass.

- **Delivery opened a real pull request, 2026-09-06**, the app's first:
  throwaway `Xapicc/uf-deliver-smoke`, branch unpushed, seeded worktree run,
  `UF_GITHUB_TOKEN`. The app pushed and opened #1 `uf/deliver-smoke` → `main`;
  it refused a non-GitHub remote with no credential, and a second request, 400.

- **Review and conflict-resolution spawn, flags, JSON shape and accounting**,
  with a stub `result`; a bad conflict resolution cannot be committed.

- **The Files tab's touched/changed scan returns what the design claims, on
  real SQLite** (in-memory `better-sqlite3`, ten hand-written tool payloads, a
  throwaway script): worktree and checkout paths collapse to one row, `/tmp`
  counts as outside, a command-only `Bash` and a directory `Grep` are excluded.
  `runTouches.test.ts` covers only the pure reconciliation, nine cases.

### Agents, templates and models

- **Run templates, live dev server:** CRUD works and each refusal is a 400 with
  the form's sentence; a stored `bypassEverything` mode with a corrupt budget
  reads back as `plan` and one work cycle. Plus 20 `npm test` assertions.

- **`--agent` / `--agents`, seven probes on CLI 2.1.226:** `--agent` selects a
  definition passed on the same argv, exits 1 on an unregistrable one, keeps
  `--append-system-prompt`, survives `--resume`, and yields to the run's
  `--model`.

- **The `settings.json` `agent` key is real and deliberately not declared,
  CLI 2.1.226:** `--agent` outranks it, `--agents` does not, and a bad value is
  silently ignored at exit 0; it reaches every child started with no agent.
  Four probes, throwaway `CLAUDE_CONFIG_DIR`, `-p "Say hello."`:

  | settings.json | argv | answer |
  |---|---|---|
  | no `agent` key | — | `Hello! 👋 What can I help you with today?` |
  | `"agent": "uf-set-probe"` | — | `BANANA` |
  | `"agent": "uf-set-probe"` | `--agent uf-set-probe2` | `CHERRY` |
  | `"agent": "uf-set-probe"` | `--agents '{"uf-offered":{…}}'` | `BANANA` |
  | `"agent": "uf-set-typo"` | — | `Hello! 👋 …`, exit 0 |

- **The model catalogue in a browser and over HTTP, 2026-09-08**, `next
  start`, throwaway `DATA_DIR`: thirty rows render, a typed `acme-model-9[1m]`
  adds, the last enabled switch is `disabled`, both `#model` selects list
  Inherit first; `PUT /api/settings` stores `claude-opus-5[1m]` intact, and
  settings and runs refuse disabled or unknown models with a sentence.

- **A template's model (added 2026-09-04) works up to the planners.** Migration
  checked by hand on a pre-change database; dropping the inherit in
  `planProposal`/`planNode` fails 6 tests; routes (auth on) trim, null blanks,
  clear on `PUT ""`; the form (Chromium, auth off) seeds it and overrides it per
  run. `npm test` 2,136 tests / 0 failures.

- **Per-run model (added 2026-09-04) rendered on `next dev`, on planted rows.**
  `/runs/new` draws the field under *Folder* with placeholder
  `Claude Code's own default`; `/runs/[id]` reads `This run`/`Its agent` for a
  set and a NULL model. `npm test` 2,123 tests / 0 failures. `next dev` there
  needs `NODE_ENV=development` set explicitly.

- **The routes under the new-run form's template UI**, exercised directly.

### Other providers

- **The Codex sign-in panel, end to end, 2026-09-05**, `codex-cli 0.153.4`,
  scratch `CODEX_HOME`, routes and Playwright: `login status` exits 1 both
  signed out and on a bad credential file; a device flow deletes the stored
  credential on start; `--with-api-key` exits 0 on empty stdin. The key
  reached no log, only `$CODEX_HOME/auth.json` (0600).

- **`runs.provider` and its admission refusals, 2026-09-05**, `npm start`:
  `provider TEXT`, nullable, cid 47, with `createRun`'s `INSERT` run for
  `'codex'` and `null`; four refused `POST /api/runs` each got their own 400
  sentence; both run-page labels rendered for seeded rows.

- **Codex device sign-in was driven against the real CLI up to approval.**
  `Logged in using ChatGPT` was read from a hand-written `auth.json` (unsigned
  JWT), not a real credential; the Settings row's poll arms and stands down
  around a cancelled flow, never a successful one.

- **The Codex CLI installs and runs on this image's base, measured on arm64
  only, 2026-09-05.** In `node:22-bookworm-slim`, `npm install -g
  @openai/codex@0.153.4` then `codex --version` prints `codex-cli 0.153.4`;
  279 MiB on disk. The binary arrives via `optionalDependencies` gated on
  `os`/`cpu`, so the Dockerfile block ends in a version check.

- **The Codex adapter's argv and spend handling, 2026-09-05.** Every flag it
  emits is in `codex-cli 0.153.4`'s `codex exec --help`; `codex execpolicy
  check` forbids `pkill node` under the app's `prefix_rule` spelling
  (`rule(...)` and `define_program(...)` do not parse); a seeded Codex run
  renders `148.2k` tokens against a dash, not `$0.00`, in the built app.

### Knowledge and plugins

- **Vault reader on a real 773-note vault, read-only, 2026-08-21:** 885 nodes
  and 19,438 edges, cold scan 303ms, cached 9ms, and
  `/note?path=../../../etc/passwd` answered 404. It caught frontmatter tags
  being dropped (747 notes tag only there).

- **`--plugin-dir` delivers the generated skill, CLI 2.1.226, 2026-08-21,
  $0.00:** the request carried `usagefoundry:knowledge-vault` with
  `renderVaultSkill`'s exact text, namespaced so it cannot shadow the
  operator's skills; `--add-dir` proved a write grant, not a read-only one.

- **Knowledge page and renderer over a real 785-note vault, 2026-08-21:** the
  routes answered with live counts, 213 of 13,100 wikilinks leaked as literal
  `[[…]]` inside emphasis (24 after the fix, all vault content), and `sha256`
  digests showed the vault untouched.

- **Graph view at the real vault's size, 2026-08-22:** 893 nodes and 19,995
  edges in 605ms, uncapped; the layout settles in 251 frames at 1.49ms a step
  (Node 22.23.2), and Barnes-Hut is 2.7x all-pairs, 4.32ms a step at the
  2,500-node render cap.

- **Obsidian markdown over all 785 real notes, 2026-08-22:** 760 carry a
  callout, 621 a table, 524 a task list, all previously literal text; now 0
  notes leak a construct and 0 throw; two bugs the pass found, both invisible
  from the desktop, are tested.

- **Four hook and read facts, read in the pinned CLI bundle.** A `PreToolUse`
  deny lacking `hookSpecificOutput.hookEventName` is silently discarded; a
  plugin's `hooks/hooks.json` needs the `{"hooks": …}` wrapper; `agent_id` is
  on hook stdin only in a sub-agent; a whole-file read caps at 25,000 tokens
  and the first 2,000 lines.

- **`--plugin-dir` registers a plugin's hooks, observed 2026-08-23.** 213
  `hook_response` rows from `/workspace/winnow/plugin`, all exit 0:
  `SessionStart:startup` 93, `:compact` 88, `:resume` 32, so resumed cycles
  get hooks and autocompact re-fires `SessionStart`. Only the shell ran:
  `cozempic` was absent, so 213 sessions were told a guard was active.

- **The `/knowledge` graph orientation layer, `next dev`, 2026-09-02**, on the
  mounted vault (1,227 notes, 1,258 of 1,375 nodes drawn) at 1440px and 390px:
  graph first, three closed folds, legend, `Fit`, a readout that survives the
  pointer leaving, `role="img"` with a label. `textFade` 0.35 chosen by eye: a
  threshold just under `fitView`'s `k` 0.12–0.14 put 1,258 titles in 820px.

- **The vault skill is on `--plugin-dir` for first and resumed cycles.** Three
  `buildArgs` cases pin it; the skill reaches the model's skill list.

- **`graphTags`, `tagGroups` and the query they write are unit-tested.**

### Dreaming

- **Dreaming end to end, 2026-09-02**, built app over the real corpus: the
  readout matches `proposals/Dreaming` (77 signatures, 1,260 of 2,553
  instances); warm scan 21 ms, 0 files re-read. One night ($9.40) wrote notes
  passing `_Meta/qc.py`'s ERROR gate for nine of twelve signatures, and found
  the scan double-counting the 5.1% of records resumes rewrite.

### Retention

- **A transcript's filename is its session id under CLI 2.1.226**, checked
  against every `.jsonl` in a real `~/.claude/projects`.

### Security and sandboxing

- **Child environment, dumped from a real spawn:** 97 variables, `PATH` and
  `HOME` intact; `ANTHROPIC_ADMIN_KEY`, `UF_AUTH_TOKEN` and `OTEL_*` absent.

- **Path traversal rejected in every form tested:** `../`, an absolute path
  outside all mounts, an escaping symlink, another mount's folder, an unknown
  mount id, an unmounted workspace, a disabled slot.

- **A required sandbox that could not start ran unnoticed, 2026-08-18/19:**
  the only end-to-end reading of `UF_SANDBOX=1`. With `security_opt` commented
  out as shipped the CLI started anyway (its probe only `access(X_OK)`s
  `bwrap`); 214 `Bash` calls failed across 10 runs in 15.5 hours ($407.26),
  and UsageFoundry recorded zero `sandbox` events.

- **`uf-seccomp.json`, Docker Engine 29.7.2, kernel 6.12.76-linuxkit:** it
  lets `bwrap --unshare-user` create a namespace (rc=1 → 0, root and uid 1000)
  but not `--proc /proc`, so only the CLI's weaker `--bind /proc /proc` shape
  runs, measured on `bwrap`, not on the CLI choosing. Its regeneration command
  404s: moby publishes no `v29` tag.

- **A sandbox that starts and confines, 2026-08-19, $0.51 for three calls:**
  with the seccomp override and `enableWeakerNestedSandbox`, a sandboxed `Bash`
  ran and was refused the `.credentials.json` uid 1000 reads outside it, as a
  plain `EACCES` indistinguishable from a missing path.

- **The prune has to run as the server, not the agent uid, 2026-08-24.** Under
  `setpriv`, a child at `UF_AGENT_UID` raises `PermissionError` on
  `WINNOW_DATA_DIR`, because transcripts are `0600 root` and `DATA_DIR` is
  `0700 root` on this install. `spawnPrune` is the only spawn that omits
  `childCredentials()`.

- **Sandbox mount-point failures counted, the fill's git half checked,
  2026-09-04.** 255 `bwrap: Can't create file` tool failures in ten days, 252
  of 261 paths in a project tree's `.claude` list, which `claude.exe` 2.1.260
  applies to the cwd and every ancestor. After the fill a linked worktree's
  `git status --porcelain` is empty.

- **The sandbox's tree-root list binds eleven dotfiles at the cwd only,
  2026-09-09.** Each is a character device `1,3`, and `git add -A` dies on
  `.bash_profile`; 6 of 47 idle checkouts kept all eleven as `0444` files.
  `sweepSandboxTreeRoot` removed nine on a scratch tree, keeping a real
  `.gitconfig` and `.vscode`.

- **The gap-register pass, 2026-09-06**, dev server on an isolated `DATA_DIR`:
  logout-all without a credential is 401 and revokes nothing; with
  `UF_STATUS_TOKEN` set, `/api/status` takes a minted `uf_session` but not the
  master token as a cookie. `npm test` 2,268/2,269, the miss
  `backupRestore.test.ts`'s `ulimit -f` case, which fails on this macOS host.

- **The entrypoint drops the intake filter to the agent uid, under a harness
  only.** The real `docker-entrypoint.sh` with a recording `setpriv` and `uv`
  recorded `setpriv --reuid=1000 --regid=1000 --clear-groups env -i …` and a
  seven-entry environment holding none of the four credentials set. A
  recording `uv` is not `uv`, and none of it boots a container.

- **The sandbox wiring builds, boots and wraps `Bash` (2026-08-18/19).**
  `bubblewrap` and `socat` ship executable; `UF_SANDBOX=1` writes the managed
  policy; Docker applies `uf-seccomp.json` (v28.5.2's default, six syscalls
  ungated). `sandboxRefusal` is unit-tested; its three `bwrap:` markers were
  read off `run_events`.

- **The per-run write set is unit-tested and was watched to fail first.**
  `sandboxSettings`/`sandboxArgs` in `orchestrator.test.ts`: own checkout
  writable, a sibling run's not, `CLAUDE_CONFIG_DIR` writable, plus glob-path
  and empty-set cases.

- **`UF_LOCK_CLAUDE_HOME`'s entrypoint passed an 18-scenario `dash` harness.**
  Stubbed `chown`/`stat`/`id`/`setpriv`; every branch printed right and chowned
  nothing wrong. Control flow only, not a kernel: no ownership changed. CLI
  2.1.226 (throwaway config dir) reaches the API with an unwritable top level
  whose entries exist, and rewrites in place with `O_TRUNC` on `EACCES`.

- **The CLI's own sandbox has been executed three narrow ways (2026-08-18/19
  onward).** `bwrap` with and without the seccomp profile, in both argv
  shapes; a 15-hour `UF_SANDBOX=1` install whose sandbox never started (Q2);
  three hand-run `claude -p` calls against one that did: one ran a shell
  command, one was refused the credentials file its own uid owns.

### Container and environment

- **Multiple workspaces:** slots list independently, a disabled one is skipped,
  a missing one reads unavailable rather than empty, and a folder maps back to
  its workspace through a symlinked mount.

- **Backup and restore against a live writer:** mid-transaction, `cp` got 25
  runs and `scripts/backup-db.mjs` the live 386, both passing
  `integrity_check`; restore never deletes, refuses under a live
  `server.lock`, and a copy killed part-way leaves the database in place.
  Seven tests in `backupRestore.test.ts`.

- **`UF_BIND_ADDRESS=0.0.0.0` with a token, from the LAN address:** bound
  `0.0.0.0:3000`, `/api/usage` 401 bare and 200 with the bearer; with
  `UF_COOKIE_SECURE=0` the cookie had no `Secure`. A new binding needs a
  recreate; `docker compose restart` keeps the old one.

- **Go in the image, arm64 only:** the tarball passed `sha256sum --check`, the
  image reports `go1.26.6 linux/arm64` with both caches under `/home/node/go`,
  and a fresh cache volume was re-owned to `UF_AGENT_UID=1001` once.

- **`jq` 1.6 in the image, 2026-08-25:** runs as uid 1000 under
  `uf-seccomp.json`, unwrapped and inside both `bwrap` shapes, unconfigured.

- **Discord's 400, the in-container relay, and the URL it keeps,
  2026-08-24.** The generic body to a live Discord webhook got 400 (`"code":
  50006`), `{"content": …}` 204. `scripts/discord-relay.mjs` forwarded a
  signed body (204; unsigned 401). The server holds no `DISCORD_*`, and uid
  1000 was refused the root relay's environ.

- **Playwright renders a real page as uid 1000, 2026-08-24.** 1.62.1 on
  Debian 12 arm64 installed Chrome for Testing 151.0.7922.34 (`chromium-1234`,
  641 MB, plus a 340 MB headless shell) and screenshotted `/login` correctly
  at 1280×800. Chromium's own sandbox is unusable (`unshare` EPERM) and
  unneeded: `chromiumSandbox` defaults to false.

- **`playwright install` fails in the container two ways; rendering does
  not, 2026-08-25.** As uid 1000, `EACCES: permission denied, open
  '/opt/playwright/browsers/.links/4aea…'` (a root-owned link file); under
  `UF_SANDBOX=1`, `Read-only file system` (`srt` 0.0.71). Screenshots work
  both ways. A bare-`srt` ENOENT on `/tmp/claude` is an artifact; don't add it.

- **The host-side causes of an unreachable LAN install are ruled out.** From
  the container's own host, `lsof -nP -iTCP:3000 -sTCP:LISTEN` showed Docker on
  `*:3000` and the macOS application firewall was confirmed disabled.

- **The intake filter's launcher, and the container's memory at rest,
  2026-09-10.** Idle four minutes after boot: `docker stats` 576 MiB,
  `next-server` 441 MB RSS (transcript cache 168 MB), the filter's `uv run`
  parent 199 MB beside a 23 MB filter; an hour later, still idle, `docker
  stats` read 1.35 GiB, the difference virtiofs slab from the bind mounts.
  - The entrypoint now runs `uv sync`, then the venv's `python -m winnow
    filter`. On the rebuilt container the filter runs at uid 1000, 23 MB, with
    no `uv`; the proxy answers on 8789; the ledger's 54,145 lines are intact.
  - cgroup `anon` fell from 578 MB to 390 MB and `docker stats` to ~410 MiB
    after a cold scan. A plain `docker restart` wrapper held only ~29 MB, so
    the saving is the `compose up --build` one.
  - Same day: the +214 MB poll spike is `intakeFilter.ts` reading its 102 MB
    ledger whole; the 1,531 MB high-water mark is the dreaming pane's cold read
    (1,268 MB at a 2048 MB heap, 656 MB at 1024, in a throwaway container).
  - This install now sets `UF_NODE_HEAP_MB=1024`, `UF_MEM_LIMIT=6g` and
    `maxConcurrentRuns` 2; the shipped defaults are unchanged.

### Build and release

- **The standalone build boots and serves**, native SQLite binding included.

- **`npm run build` cannot finish on an agent worktree's virtiofs mount,
  2026-09-08**, at `23a3d45`: 4 of 4 died copying the standalone bundle, a
  different path each time; `rm -rf` gave `ENOTEMPTY` 6/40 there, 0/40 under
  `$TMPDIR`. `scripts/redirect-dist-dir.mjs` made 7 consecutive builds exit 0
  with a serving bundle; `distDir` and a bare symlink were measured and fail.

- **`next build` failing with `TypeError: generate is not a function` in a
  spawned run** is the inherited `__NEXT_PRIVATE_STANDALONE_CONFIG`; with it
  unset, `npm run build` builds cleanly, standalone output included.

- **Four traps for a hand check inside an agent's sandbox.** The ambient
  `NODE_ENV=production` makes `next dev` answer every request with a 500
  (`EvalError: Code generation from strings disallowed`); the ambient
  `WORKSPACE_ROOTS` silently outranks any `WORKSPACE_ROOT`; `UF_ALLOW_NO_AUTH=1`
  does not open the app while `UF_AUTH_TOKEN` is set — export it empty instead;
  and each shell has its own network namespace, so boot, seed, drive and tear
  down in one command.

### Interface

- **Layout sweep, production build, twelve widths 1440–380px, both themes,
  geometry read from the DOM:** it found and fixed three defects (a 0px gap, a
  button 92px outside its card at 380px, a translucent save bar), after which
  no page scrolled sideways.

- **API payloads before the 2026-08-23 wire pass.** `GET /api/runs` 696,197
  bytes for 100 rows, 75.1% prompt text; `/api/runs/[id]` 591,574, of which
  582,469 an unread events array; `/api/knowledge/graph` 9,864,990;
  `/api/storage` 5.3–7.4 s warm for 585 bytes, 5,981 ms of it one serial
  `lstat` walk. An idle runs page pulled 10.5 MB a minute, uncompressed.

- **No app-router `/api` response was compressed, Next 15.5.23.** Handler
  headers are stored as arrays and `compression`'s `compressible()` rejects a
  non-string, reproduced with `DEBUG=compression`. Bodies under ~250 bytes
  grow under gzip; `gzipSync` blocks the loop 30.6 ms on the 8.8 MB graph, so
  the async form is used. Graph 8.8 MB → 488 KB on that morning's capture.

- **The orchestrator page fits the pane at `lg`, 2026-08-27.** `next dev`,
  seeded chat, Playwright's Chromium: pane overflow 0 at 1440×1080, 1440×700
  and 1024×700 (parent commit 3,180–5,024px); below `lg` identical to the
  parent. A 700px window with the read-only banner, disclosure and two error
  banners all open still runs 71px short.

- **`/knowledge`'s smoke failure was the harness fixture, 2026-09-08**: with
  no vault configured its API answered 409; `seedVault` (`66e71c0`) fixed it.
  One build at `3e59699`, 2026-09-09: 44/44 clean with it, 42/44 and exit 1
  with its call site removed; no host state reaches the pass.

- **The shared layer at 390×844, 2026-09-10**: `Sheet`, `Card`, `Meter`,
  `RunAgentCost` in Chromium, mostly the standalone bundle: no sideways scroll
  on five pages, nothing in the kit under 44px, `ContextOccupancy` at 1280
  byte-identical before and after.

- **The ascii skin's tokens and switch, 2026-09-11**: built utilities read
  tokens one `:root[data-skin=ascii]` block overrides; line tones clear
  contrast (worst 3.19:1, 4.87:1); `npm test` 2618/0, `smoke-pages` 44/44; 48
  `rounded-full` sites stay pills. A live flip zooms `/knowledge`'s graph ~5x,
  as light→dark already did.

- **The ascii skin's kit primitives, 2026-09-11**, eleven components, no call
  site changed: `npm test` 2622/0 with a test that fails without `aria-hidden`,
  sideways scroll 0 on 52 loads; `ListGroup`'s frame, painted out by its own
  box, was found and fixed.

- **The ascii skin's meters, 2026-09-11**: `ui/AsciiBar` in `Meter`, with
  `meterCells` pinned by nineteen tests (0.4% shows a cell, 99.6% leaves one
  empty, no ceiling is `null`); block glyphs measured 14px against 7px ASCII,
  hence `╳` for unknown; `npm test` 2641/0; the charts needed no change.

- **The ascii skin's app shell, 2026-09-11**: 176/176 loads clean (22 routes ×
  widths × skins × themes), default-skin geometry unchanged, `npm test` 2643/0.
  Five defects found only by looking, one of them every framed box app-wide
  inking its stroke 7px inside its edge since frames shipped; `-0.5em`
  corrected all but a pixel on bordered hosts.

- **The ascii frame's second app-wide offset, caught only by reading device
  pixels, 2026-09-11**, 1920x963 at DPR 2: bordered `Card`s inked their stroke
  1.00px inside where `ListGroup` did. `calc(-0.5em - 1px)` leaves 0.016px, and
  a test reading the selector from `globals.css` fails all four mutations.

- **The ascii table head rule is one line again, 2026-09-11**: the `3px
  double` border drew ink-gap-ink; without it, one run of ink at 390, 1280 and
  1920 in both skins, and `/runs` in the standalone server read `1px solid`.

- **The ascii meters fit their card, 2026-09-11**, standalone bundle, three
  pages at 390/1280/1920: `AsciiBar` measures its own advance and fills 96.0%
  to 99.9% of the track (23 cells at 390, up to 123 at 1920), never past it;
  a resize settles once.

- **The Context sparkline's floor line is removed, 2026-09-11**: reproduced
  from the real `ContextOccupancy` at the capture's shape, the 1px floor read
  as a section rule; it is gone in all six shape × skin cases, the prune
  marker still reads as one mark, `npm test` 2647/0.

- **The ascii skin's in-flight marks became one, 2026-09-11**: `▛ ▜ ▟ ▙`,
  since `▀`/`▐` measured 9.22px against 13.00px, drawn 6.50 × 6.50px; DPR 4
  captures on `/runs` rotate clockwise in phase; default-skin pixels
  byte-identical; `npm test` 2647/0, `smoke-pages` 44/44 standalone.

- **The quick-open sheet at 390px, 2026-09-10**, standalone bundle: it spans
  the window, nothing scrolls sideways, footer buttons are 44px, focus lands in
  the field, Esc and Cancel close it (a tap below does not, by design: `Sheet`
  has no backdrop dismiss). Not on a real phone.

- **The workflow surface at 390x844, headless Chromium, 2026-09-10.** The
  block list replacing the canvas below `md`, 288px controls and 44px links
  measured by box; `smoke-pages` clean on all five pages at both widths; the
  list's four gestures answer Playwright's synthetic `tap()`; the 1280px table
  screenshot is byte-identical.

- **`/settings` at 390px, headless Chromium, geometry only.** The standalone
  bundle at 390x844 and 390x568, every disclosure open, every switch on, a long
  path in every field: nothing past the viewport, no sideways scroll on
  `#main`. The 44px floor was read off bounding boxes, not hit.

- **Touched map (`/runs/[id]/touched`) rendered 2026-09-02, on a seeded run
  only.** 399 tool events over 48 distinct files, none real: it renders, settles
  and stops, and clusters by directory legibly at 1440×1000 in both themes.
  Headless layout (nothing on colour or labels) settles at 250 frames against a
  2,000 cap and separates clusters 3.6× on a reconstruction of the measured run.

- **Touch replay scrubber driven 2026-09-02, on the same seeded run only.** 399
  touches over 48 distinct files; the sequence route answers 50 KB beside the
  collapsed scan's 47 KB. Playwright at 1440×1000: space played 121→170 in 2.5 s
  (the `TARGET_SECONDS` rate), pause held, Reset cleared, the wash read in both
  themes. `touchReplay.test.ts` covers the fold cases.

- **Paged `/api/runs` query checked in SQLite, not a browser.** Seven planted
  rows check paging, the offset clamp, the `created_at`/`id` tiebreak and
  literal `%`/`_` in `q`; 13 unit cases. At 50,000 rows the poll's unfiltered
  first page takes 0.23ms and a `status` page at offset 20,000 7.8ms, with no
  new index.

- **Stacked tables (`d8c711d`) typecheck, test and build.** `npm test` 1335
  pass, 0 fail at `c9d0b3c`; the build exits 0 at `a294ed2`, whose CSS holds
  `.md\:contents{display:contents}`. An unescaped `grep 'md:contents'` matches
  nothing there: grep built CSS with `-F` and escaped colons.

- **`/chat` at 390×844 has no element wider than its parent.** Headless
  Chromium, standalone bundle, seeded chat; this fixed a 584px column in a
  358px pane that `smoke-pages` cannot see. With a 336px keyboard inset set by
  script, composer and Send stay inside the pane. 1280×900 differs from
  `bf9d40b` in 0 of 1,152,000 pixels.

- **The mobile form pass (`d8c711d`, `2e68820`) passes typecheck, test and
  build, and two of its classes reach the CSS.** On the `a294ed2` build,
  `grep -cF 'max-md\:text-\[16px\]'` and `'max-md\:min-w-32'` match once each;
  `min-width:8rem` never does, since Tailwind v4 emits a `calc()`.

- **The density restructure typechecks, tests (1335 pass, 210 suites) and
  builds, and was read at a wide desktop width.** Per `ui-density-audit.md` §9,
  the completion pass opened eleven surfaces and found `CardTitle`'s `mb-0` a
  no-op at seven call sites, every table's fixed columns at a third of their
  width, and `npm test` failing on macOS for an unrelated reason.

- **The Context panel's band picker was operated in the built app,
  2026-09-04** (`npm start`, seeded `DATA_DIR`, Chromium over `/runs/<id>`; no
  container, no real winnow): 24 assertions pass, a legend row is 44px under
  `md`, and polling left an open region's rows byte-identical. `npm run dev`
  500s there on a Tailwind `EvalError`; use `npm run build && npm start`.

- **The dashboard's three-column top row was measured in headless Chromium**
  against the built stylesheet and a stand-in shell: from 1280 to 1920 the
  window card is 50.0% of the row and the tile 256px; at 1180 and 1024 it is
  two columns, as half of a 760px row leaves the middle track 85px.

- **The collapsed live-telemetry card fits its 533px cell, 2026-09-04**:
  rendered alone via `renderToStaticMarkup` in headless Chromium with six runs
  and the widest plausible figures, all five columns fit unwrapped; at 390px
  `Table stack` turns each run into a labelled block.

## Not yet verified by hand

Everything below typechecks and builds, and some of it is unit tested, but none
of it has been exercised the way its entry says — against a real CLI, a real
browser, a real device or a real install. This is the list to work through
before trusting this unattended. When an item gets measured, add the
measurement under *Verified* and cut the item down to what is still open.

### Metering and cost

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

- **No `rate_limit_event` read off a real process**: the event was canned,
  only `allowed` has been seen, no overage window, and `FirstRun` hides the
  card on a machine with no transcripts.

- **The metering figures measured on 2.1.226 have not been re-measured on
  2.1.260** (the pin moved 2026-09-04). Each parser degrades quietly, so a
  green build proves nothing about metering. One assist's 2.1.260 stdout has
  been parsed (2026-09-09); nobody has compared a 2.1.260 work cycle's spend,
  OTLP records or transcript against the 2.1.226 readings.

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

### Budgets and guards

- **The process budget has never refused a real child in a browser, nor
  deferred and woken a real block.** `assistBudget.test.ts` covers it. Settle:
  *Other Claude processes at the same time* at 1, a workflow block behind
  something slow and a chat turn; the block should wait, then start as the
  chat settles.

- **A work cycle stopping at its `--max-budget-usd` ceiling.** The argv is
  unit tested; no billed cycle has hit it, so whether the CLI honours it on
  `-p` and how far a cycle overshoots are reasoned, not measured.

- **A workflow-wide budget tripping against real spend.** No instance has been
  halted by a guard; `instanceSpend` has never summed a real `otlp_requests`
  row.

### Run lifecycle

- **What `--allowedTools Grep Glob` does to a real work cycle is unmeasured.**

- **No real validation, review or conflict resolution has run since assists
  began streaming (2026-09-09)**, so `logAssistTools`' rows and the `check ›`
  prefix are unexercised.

- **The live log's open-tool rows have never met a real `tool_progress`
  frame**: arrival, the 30-second restatement and clearing on `tool_result`
  are untested, and the `aria-live` line was never listened to.

- **Never a real Home Assistant, ntfy topic or other operator receiver.** The
  `docs/install.md` automation was never loaded, so `trigger.json.*`,
  `allowed_methods` and `local_only` are unconfirmed. Only `completed` has come
  from a real run; the other endings' events were constructed. No run has gone
  all the way to Discord, and the mention and one 429 retry are unexercised.

- **The audit trail has not been read off a running install.** The five
  creation paths and the request wrapper pass under `npm test` only, and no run
  page has shown its origin line. Settle with `SELECT origin, count(*) FROM
  runs GROUP BY origin;` and the last 20 `request_log` rows on a real database.

- **No install-wide control has met a live child or a browser.** `stopFleet`
  and the hold are unit-tested, but no real `claude` was signalled (the test
  answers `cancelled`, not `signalled`) and the Fleet card never rendered.
  Settle: **Stop everything** on two or three cheap runs, then **Hold new
  work** and **Resume new work**.

- **Setting a run aside has never been done in a browser or on a live
  child.** `fleet.test.ts` drives all three doors; the mark-then-signal order
  has only been read. Settle: **Stop and set aside** a cheap run, check the
  Fleet count and restart notice exclude it, then **Resume** it.

- **The work-cycle deadline has never met a real hanging `claude`.**
  `cycleDeadline.test.ts` pins the mechanism on a silent child. Unknown: does
  `SIGINT` reap a hung `claude` and keep its `result` event, or only `SIGKILL`
  eight seconds later; the 120-minute default is reasoned. Settle with a
  `sleep 100000` task under a five-minute **Silent cycle limit**.

- **No live `stream-json` failure has reached the run page.** A forwarded
  message's `parent_tool_use_id` is still assumed, and no `tool_error` row has
  rendered. Settle: a run whose `git push` fails should log one danger row, a
  clean run none.

- **"The agent's own report" was never compiled, tested or rendered.** Its run
  had no `npm` and no `gh`: `cycles.ts`, `Markdown.tsx`, `RunOutput.tsx` and
  their tests were read by hand only, and the issue it follows was never read.
  Run typecheck, test and build and open a finished run first.

- **Whether `claude -p` flushes its `result` event on `SIGINT`.** If so, an
  interrupted cycle keeps its measured cost; reconciliation becomes a fallback.

- **What a subscription-limit refusal actually says.** `isUsageLimit()`'s
  wording is from the binary's strings, never seen on the wire.

- **Whether a refusal ever arrives on stderr alone** rather than as a
  `<synthetic>` turn. `refusalInStderr` covers that case but has never fired.

- **What a dropped stream does to the cycle around it.** Which path that run
  took, and whether `--resume` accepts a drop-truncated session, is unwatched.

- **Whether `claude --resume` accepts a session truncated by a mid-turn
  kill.** The ladder retries once, then stops rather than start fresh.

- **Which session id `claude -p --resume <id>` reports back.** A differing id
  is adopted and logged; no real resume has been watched.

- **Whether a session id from an `init` event killed seconds later is
  resumable.** It is persisted, relying on the first user turn being flushed.

- **A run parking and resuming across a real 5-hour boundary**, in the same
  worktree, on the same branch, with its commits intact.

- **A paused run surviving `docker compose restart`**, and a stale one being
  closed out once past `resumeGraceHours`.

- **A parked run taking its folder back** within a sweep of the run that took
  it finishing, and staying parked until then.

- **Resuming a finished run into a real agent**: `--resume` picking the
  session up, an isolated one back in its own checkout on its own branch.

- **Picking a `completed` run back up with a follow-up, through a real
  `claude`**: the note as the next turn, DONE pushback only after a real `DONE`.

- **`detached: true`**: that Ctrl-C during `npm run dev` still kills the agent
  (via `instrumentation.ts`) and any long command it started.

- **The in-flight cycle line on a real run.** `fmtCycleInFlight` is unit
  tested; no run started through a server has been watched.

- **`SEARCH_TOOLS` on a real spawn from this app is unwatched.** Unknown:
  whether the mixed list still grants its two git commands, whether the tools
  appear in a `bypassPermissions` chat turn, and whether `--resume` keeps them
  at cycle 2. Check: `Grep` in the latest `system:init` payload in `run_events`.

- **Whether a real agent says `NEEDS_REVIEW` when it should, and only then.**
  Reasoned from `COMPLETION_NOTICE`'s precedent (251 runs), not measured.
  Under-use burns the cycle cap; cheap use turns completions into questions
  for a person. A task quoting the token ending in one cycle is unmeasured too.

- **No `claude` child has reported `NEEDS_REVIEW` to this app.** Unrendered:
  the amber badge and glyph, the **Needs review** filter, the reason under the
  state card, the warn log line. Unexercised on a database: freeing the folder,
  continuing the branch, Resume, the bulk pick-ups, Land/Delete/Purge. No
  `docker compose up --build` has been run against it.

### Context control

- **No netted prune figure has been read against a real run.** The KPI
  arithmetic rests on unit tests and a clean `npm run build`; the
  `ContextControlAside` tile's six states were rendered only as markup from
  hand-written DTOs. Also unchecked: the corrected invalidation against a fifth
  prune, and whether `readAppended`'s `rotated` test catches a prune's rewrite.

- **The intake-filter figures have no independent check and were never seen
  in a browser.** `winnow savings --json` does not exist at `f9f8e4b`; checked
  only against unit tests and the ledger recounted in Python. The windowed
  `session`/`weekly` halves and the corrected path have typecheck and tests
  only; check that the 5-hour figure is not permanently `—`.

- **No response over 300 s has been seen to finish through the fixed filter.**
  Run `b511c547` was told to write in sections when it was reopened, so it
  shows the path works, not that a long silent generation now survives —
  which needs the API to send pings for `read1` to pass. Settled by a run
  event log with a main-thread gap over 300 s and no `api_retry` in it.

- **Lowering the ceiling from 300,000 to 200,000 was a judgement, 2026-08-25.**
  No `prune_receipts` or `netReceipt` comparison was taken across the two.
  Never seen in the running app: a crossing at the current ceiling, the new
  prune log line, and the per-tick cost of reading every live run's
  transcript with no size gate.

- **The `ENABLE_TOOL_SEARCH=1` fix has not been through a rebuild.** Check
  that a real run's first request lands near 30,800 rather than 48,000 and
  that `WebSearch`/`WebFetch` still reach through `ToolSearch`. The 17,229
  added tokens are not netted against the filter's saving anywhere.

- **The compaction summariser's call is billed and in no ledger, 2026-08-22.**
  All 42 `isCompactSummary` records carry no usage: roughly 168,000 in and
  6,300 out, order $0.24 to $1.84 per compaction, invisible to `scanUsage()`.
  Also unmeasured: whether 200,000 is optimal (one arm, no dose-response; one
  Docker run logging `effectiveWindow` would show the operating point) and
  whether the firing arithmetic holds for another model.

- **The `Pruning` column has not been read on a real install or an aged
  run.** Seeded receipts prove plumbing, not worth; a run whose transcripts
  were swept should drift to a small negative, unobserved.

- **Why a fork's edit misses the wire is assumed**: the resumed CLI rebuilding
  tool results from the untouched `toolUseResult` is the likeliest cause.

- **No fork has been written since the API-basis measurement was added**, so
  `apiContextSample`'s `api` basis at the fork site and `firstContextTokens`
  skipping a `<synthetic>` zero are unconfirmed. Settle: fork engine to a
  natural boundary; the row needs `api_context_before` and `api_context_after`.
  `pruneAtBoundary`'s clear is argued from code; the stack's age line is unseen.

- **No 2026-08-28 cycle or prune change has met a real boundary**: no agent
  spawned since `cycleInvocation.ts` split out, no `prune_decisions` row, no
  early-end prune; settle with a `maxIterations >= 2` run outlasting cycle 1.
  `treatRemovedTokens` over-claims `D` by ~a quarter (unmeasured), making the
  gate permissive; winnow's `unavailable` branch has never been rendered.

- **Context series: fallback basis, cap, scan cost and sweep unmeasured.** 0 of
  198 rows use the `transcript` basis, no run reached `CONTEXT_SAMPLES_PER_RUN`
  (max 38), the scan is untimed, no sweep has removed a real row. The freshness
  line (container not rebuilt) and `guardScanDue` (needs
  `liveGuardIntervalSeconds` above 120) are unseen.

- **`ContextOccupancy` has never been seen on real rows or on the run page.**
  Its placement in `Against its limits`, its behaviour as the 3-second poll
  replaces the DTO, the one-column narrow layout and its caption length are
  unchecked.

- **The intake-filter card has never been displayed.** No browser has shown it,
  every DTO was hand-written, the throwaway harness is not in the tree, and
  `readFilterSavings`' TTL and single-flight have not been raced.

- **The tile's total span is unmeasured.** Every prune receipt here was written
  inside one session, none older than a window; the superset clamp (`Math.min`
  against `snapshot.weekly.startsAt`) is read, not run; a swept-transcript
  receipt's exclusion is unseen; the single-read path is untimed.

- **No compaction notice has been seen on a run log, and its field names hold
  only on CLI `2.1.226`.** `preTokens`, `postTokens`, `durationMs`, `trigger`
  come from 23 records, all `2.1.226` (`Dockerfile:215`); a rename renders as
  zero. Watch `/runs/<id>` for `Claude Code compacted this run's conversation`.
  The survival table is Anthropic's docs (`v2.1.198`), never a measurement.

- **`freshStartContextTokens`' net saving is unmeasured.** Its prices are: a
  two-cycle run averaged $19.19 against $10.05 for one, 12.0c a call early
  against 20.4c late. The net needs a matched pair of runs on one task, one arm
  each way, compared on total spend **and** on whether the task finished —
  never a within-run before/after, since cost per call climbs with position.

- **Nothing else in the 2026-08-23 pass ran against a real agent, container or
  browser**; its graph and workflow-list "after" bytes are computed. Unseen:
  the file-cost notice on a real argv, or byte-identical on cycles 1 and 2; any
  page from that build.

- **The composition series' winnow/sample anchor divergence has never been
  measured while a sub-agent ran**; it is read from code (2026-09-04).

- **The depth-3 tree has been drawn only from hand-seeded rows, and
  `COMPOSITION_CHILDREN_PER_NODE` (64) has never fired on real output
  (2026-09-04)**; its test feeds 200 synthetic children.

- **`describeComposition`'s signed negative share has been seen only by the
  test build.** It went in after the container was rebuilt.

### Orchestrator chat

- **Whether the shipped chat leaves files alone when a fix is one edit away
  has not been measured.**

- **No chat turn has run the fill against a real CLI, 2026-09-09.** `bwrap`
  cannot nest in that container and a live turn would bill unattended; the
  stub is not bwrap. Expected after a rebuild: 51 failures, not zero, and no
  tree-root name in the turn's `git status --porcelain`.

- **No chat turn has run through the real CLI's `stream-json --verbose`**; the
  pair is only the one work cycles pass (`cycleInvocation.ts:1075`).

- **The stale-Approve check used two seeded proposals**, so `propose_run`'s
  `supersedes` is covered only by `chat.test.ts`.

- **The proposal card's model row has never been drawn**, and no live
  orchestrator turn has shown whether a model names a sensible model or reads
  the field as licence to argue for guards.

- **A chat reaching `MAX_PENDING_PROPOSALS` (25) or `MAX_REMOTES_READ` (25).**
  Both are reasoned, never hit; behaviour at the cap mid-answer is unseen.

- **Ordered proposals and proposed workflows, against a real CLI.** Unit
  tested only; no CLI has called `propose_workflow` or passed a `dependsOn`.

- **The chat's inspection tools and untemplated proposals.** `get_run`,
  `get_run_diff`, `get_usage`, `list_proposals` and `save_template` typecheck;
  no real CLI has called one.

- **That an unrestricted chat stays an orchestrator.** It runs
  `bypassPermissions` with push credentials; only a `systemPrompt()` paragraph
  stops it editing. Untested against a real CLI.

- **Stopping a chat turn, in either of its two forms.** `staleTurn` is unit
  tested; no CLI child has been signalled by `cancelChatTurn` and no sweep has
  fired on a live row. The no-child half of both, free (then load `/chat`):
  ```bash
  sqlite3 $DATA_DIR/usagefoundry.db "update chat_sessions set status='thinking', turn_started_at=…, partial_at=… where id=…"
  ```

- **A chat turn's silence bound, in all three places.** Unit tested where
  pure; no real child has shown a turn past fifteen minutes surviving.

- **Switching Orchestrator threads, in a browser.** The cross-thread 400's
  sentence is unit tested; the click and the red banner are unwatched.

- **The *Earlier chats* two-line rows, in a browser.** Never rendered in the
  360px column; how they read against the 6px gap is unmeasured.

- **The chat page recovering from a dropped request, in a browser.** Unit
  tested; no one has stopped the server and pressed Send.

- **The chat page's failed-poll notice, in a browser.** Its sentence is unit
  tested; its appearing and clearing are unwatched.

- **The "Earlier chats" list refreshing on its 10s poll, in a browser.** The
  route is unit tested against the handler; the sidebar is unwatched.

- **Whether the pinned CLI ends an `ask_operator` turn when told to is
  unmeasured**; only prose ends it. Test: ask something under-specified, watch
  whether it asks once and stops. Also unmeasured: `--resume` carrying the tool
  call, the caps (5 questions, 8 choices), an exchange's cost, `chat_questions`
  on a real database, and a stranded turn writing into an idle chat.

- **No `ask_operator` answer has reached a real turn, and no model has called
  it**: `answerChatQuestions` → `sendChatMessage` → `claude -p` runs only in
  unit tests, and the when-to-ask prompt paragraph, paid every turn, is
  unmeasured. No screen reader or reduced-motion pass; `busy` seen only against
  an instant stub; the eight-step click list is unwalked against a real turn.

- **The chat has never been shown a workspace with more than twenty-five git
  repositories.** `list_folders`' paging is covered only by
  `remoteReads.test.ts` over the pure selection; no model has been seen to read
  `notRead` and call back with the offset it was handed.

- **No browser has held a chat open across a turn landing (2026-09-07)**; the
  append path is unit-tested only. Unseen: a mid-turn reply appending, the
  unseen count and scroll on a tail, a thread switch mid-poll. Open `/chat`,
  send a message to a thread with history, and watch the reply land.

### Taskboard

- **No model has called the board tools over stdio**; that needs a billed run.

- **The taskboard tools (2026-09-07) have never met a real CLI**: unseen are
  the tool list on a first and a `--resume` cycle beside the operator's MCP
  servers, a refused `complete_task`, the token dying with the run; settle
  with a task's run after `docker compose up --build`. Unrendered: refusals
  to non-operators, chat live view, Backups, sign-out, queue priority, Open PR.

- **The external validator, end to end.** No verdict has come from the pinned
  CLI via `spawnAssist`. It rests on a spike's 34 of 37, zero false-finished
  (subagent transport, one sample per case, 40 runs judged against `runs.task`)
  on a prompt since replaced; the shipped prompt has never been scored.

### Workflows and schedules

- **The pager has not met live instances**: all rows were inserted `finished`
  with no member runs, and none arrived while a page was open.

- **No real restart has been taken over a live loop block**; the
  `reconcileBlocksOnBoot` fix is unit-tested only. Settle: park a pass inside
  `resumeGraceHours`, `docker compose restart`; the block must still read as
  repeating and the pass resume, and a loop whose pass that boot failed must
  still read `failed`.

- **No workflow schedule has ever fired.** `decideSchedule` and its helpers are
  unit-tested, both Europe/Berlin DST boundaries included; no card has rendered,
  and `reconcileSchedulesOnBoot` has not seen a real restart. Settle: fire one
  a few minutes out, stop the container over the next and expect *missed*.

- **An unhalted instance's `working`/`finished`/`blocked` badges.** Tested
  against a real db; no browser has rendered them. The risk is cosmetic.

- **Stopping a whole workflow instance against real runs.** `haltPlan` is unit
  tested; no child has been signalled by `stopInstance`.

- **An orchestrator block, end to end.** Its planners are unit tested; no
  block has spawned a child, called `emit_runs` or created a run.

- **The workflow canvas, touched in a browser.** Dragging, linking, keyboard
  routes and the stored layout are all unexercised.

- **A pre-canvas workflow opened on the canvas and saved back**, to confirm
  every link survives; the derived layout is unit tested.

- **A workflow instantiated against the real CLI.** Every run so far came from
  a stub that committed nothing.

- **The rollback path.** Its stop-everything-and-record-`failed` branch has
  never run; read it rather than trust it.

### Concurrency and ownership

- **The `chat_proposals` rebuild on a real upgraded volume**, in a running
  container; the first `docker compose up` on an existing `.data` is the test.

- **The server lock with two live processes**: two servers on one `DATA_DIR`,
  and an owner stalled past `STALE_MS`. Unit tests cover the verdicts and
  `claimDataDir` against a temporary directory.

- **`STALE_MS` against a measured stall.** Its multiplier of six is reasoned;
  nothing has been timed under 25 concurrent runs.

- **The shutdown reconciling its cycles under a real `docker compose
  restart`.** `shutdown.test.ts` fakes `spawn`; whether 30s of grace suffices
  is unknown.

- **No two-process reproduction of the shutdown gate was run**, and no
  container built; the second server is only worth watching against a real
  billed agent in the first.

- **A migration finding has not been seen on a real boot (2026-09-07).**
  Settle: set `user_version = 99` via `docker compose exec app node -e`, run
  `docker compose restart app`, and `GET /api/status`'s `.schemaFaults` should
  hold one `downgrade` naming 99, its line in `docker compose logs`; a second
  restart clears it.

### Isolation and landing

- **The Land verify field was never saved**, so its check covers the form, not
  the round trip; the other four controls added 2026-09-06 were not looked at.

- **Neither three-valued reading has been seen on a real install**: the branch
  row's unread checkout (smoke-pages' `/branches` held no branches) and
  `run.guard_unreadable` (no run has hit `no_ceiling`). `heldByCheckout`
  matching the `MAX_PENDING_PROBES` skips is by construction. Settle: past the
  cap on one repo, rows must say "checkout could not be read" and offer Commit.

- **Two conflict resolutions in one repository have never run at once.**
  Only the checkout collision is tested (`resolveCheckout.test.ts`, two real
  `git worktree add`s, no `claude` child); the merge queue resolving one while
  the operator resolves the other, and each `run_reviews` row describing its
  own work, need Docker and two billed children.

- **Conflicts map unseen in the shipped image, dark theme, 390px, reduced motion
  or folding.** No `docker compose up`; nobody watched a CPU meter; the grey
  `untyped` fill (unit-tested only) and `none-named` need records the git on
  hand will not produce; folding needs a few-hundred-path conflict or a lowered
  `MAX_DRAWN_FILES`.

- **No run has met a real exhausted checkout store.** `resolveIsolation`'s
  refusal is unit-tested only. Dirty `<mount>/.uf-worktrees/<slug>-1` … `-64`,
  confirm Branches shows `0 of 64` free and an isolated run is refused with the
  sentence; which of its four counts it prints has only been unit-tested.

- **The branches filter and pager have never run on a real inventory past 400
  runs.** `selectBranchCandidates` is unit-tested; unchanged git cost rests on
  the cap. Settle with `curl -s 'localhost:3000/api/branches?offset=60' | jq
  '.branches | length, .total, .notShown'` over sixty-plus branches.

- **The multi-repository sweep (#77, #76, #70, #67) has met neither Docker nor
  a second repository.** Unrun: compose interpolating `UF_UNMOUNTED_WORKSPACES`
  for a fifth slot, a nested seed pattern reaching a real checkout, a
  per-repository GitHub token pushing, and two repositories landing at once.

- **Landing inside the container, on git 2.39** rather than 2.50. Conflict
  types come from `-z` records captured on 2.50; a 2.39 that differs loses type
  and explanation but still lists every file.

### Git and review

- **No work cycle has been spawned by the `core.excludesFile` code,
  2026-09-09.** Unseen: the write to `/run/uf-git`, the block reaching a
  child's environment, the `EEXIST` path. Settles on a cycle whose `git add -A
  && git status --porcelain` exits 0 where `main` fails.

- **What the 2026-09-06 delivery does not establish**: an agent committing to
  the branch (the run was seeded), the verify gate (`landVerifyCommand` empty),
  a real run id in the PR body (the fixture's read `deliver-`).

- **A review or conflict resolution against the real CLI.** Review quality,
  `plan` mode in print mode and `acceptEdits` resolutions are unconfirmed.

- **A repository large enough to hit the diff's size budget in the wild.**

- **Committing and purging through the app itself.** Git formats confirmed on
  2.39.5, decisions unit tested; never done through a running server.

- **A real agent using the token**: a `git push` of a run's branch, and a `gh`
  call that needs authentication. The credential block itself was driven into
  a real git; what has not been watched is the CLI's own git picking it up out
  of the environment mid-run.

- **The Files tab's *What it touched* card has never been rendered**, in a
  browser or a container. To walk at 1280px and 390px:
  - write down the header's distinct-file and work-cycle counts: the deferred
    file-by-cycle grid in `proposals/SessionFlow/` waits on them;
  - a gone branch (`kind: "none"`) drops to two groups with a warn notice and
    neither "changed, never named" nor "named, and not changed" — the item
    most likely to be wrong;
  - `/api/runs/[id]/touched` is fetched once per tab open, never on the poll.

### Agents, templates and models

- **An empty agent name and a non-JSON `--agents` payload were not
  re-measured under `--agent`.**

- **No run has started on a `[1m]` id and no model has read the MCP `enum`.**
  Unread: the spawned argv for `claude-opus-5[1m]` (brackets could be
  normalised away with no test failing), whether chat picks off the enum and
  `"inherit"` lands as null. Not run for it: `docker compose up --build` (no
  Docker), `smoke-pages` (the container's mount broke `npm run build`).

- **No template's model has reached a real `--model` on a spawn**, since a run
  here starts a billed agent. `docker compose`, narrow viewports and the sign-in
  path are also unchecked.

- **A per-run model has never reached `--model` on a real spawn**, nor the CLI
  run on it. Also unchecked: the placeholder with a default set, the copied-run
  seed carrying `run.model`, `docker compose`, narrow viewports, and sign-in (it
  ran with `UF_ALLOW_NO_AUTH=1`).

- **The new-run form's template UI, in a browser**: only the client wiring
  (loading, *Start another like this*, the two banners) is unconfirmed.

- **Everything about a saved agent that is not one of the seven probes.** No
  child has been spawned with `--agent` or `--agents` from this app, no browser
  has rendered its UI, and no request has written `/api/agents`. Open under
  `--agent`: the two `--agents` drops, turns' agent name, delegation; and
  whether a member's `tools` beats the `PROCESS_KILLERS` deny.

- **The `settings.json` `agent` key: measured, and deliberately not
  declared.** Declaring it needs a read in `agents.ts`, a field on
  `GET /api/agents`, and copy probably on the Settings page rather than under
  the picker, since choosing an agent there overrides the key.

### Other providers

- **No Codex device sign-in has been completed** (no OpenAI account): the
  exit-0 `auth.json` write, `loginError` on any failure and the poll
  converging are unmeasured; an unnoticed success reads `waiting for approval`.
  `codex` is not in the `Dockerfile`, and `CODEX_HOME` (unmounted `~/.codex`
  by default) lives in the container's writable layer, lost on a rebuild.

- **The image has not been rebuilt with Codex (2026-09-05)**: the amd64
  figures (~335 MB unpacked, 123 MB download) are registry metadata, no work
  cycle has run `codex`, signed-out is reasoned from `childEnv`'s strip, and
  `codex` under `UF_SANDBOX=1`, whose read-only binds may break `$HOME/.codex`,
  is untried.

- **No Codex work cycle has ever been spawned (2026-09-05)**; `codex login
  status` says "Not logged in". Unverified: argv acceptance, event names,
  `resume` taking the session id, `--output-last-message`, sandbox binding,
  notices as prompt text, a Codex wall, and above all a real cycle loading the
  rules file (a wrong dialect loads as zero rules): ask one to `pkill -f`.

### Knowledge and plugins

- **None of the four pinned-bundle hook and read facts has been run.** Each
  stays read-not-run until a billed run confirms it.

- **No hook event but `SessionStart` has been observed.** `hook_response` is
  emitted only for `["SessionStart","Setup"]` outside `CLAUDE_CODE_REMOTE`,
  so `PostToolUse`, `PreCompact`, `PostCompact`, `Stop` and `readGuard`'s
  `PreToolUse` run, or not, unobserved.

- **The graph orientation layer is unseen in the dark theme, on a touch
  device, with a screen reader and under `docker compose`**, and no run passed
  through auth: the middleware was moved aside because the edge bundle will
  not load under that container's sandbox. The canvas click-list is unrun.

- **The `canvasView.ts` extraction has never been looked at.** Pan, zoom, hit
  testing, dpr sizing, the `ResizeObserver` and the colour probe left
  `KnowledgeGraphCanvas.tsx` with no browser; `observeCanvasSize`,
  `observeTheme`, `probeTokens`, `sizeCanvasToHost` only compile. Unrun: its
  ten-step click-list, and Firefox on `wheelZoomFactor`'s estimated 16px line.

- **The Knowledge base settings section has never rendered**, and no `docker
  compose up --build` ran where it landed. Four states unseen: nothing
  configured, a gone mount (*Folder no longer mounted*), a scanned vault, a
  capped walk; the `≥` prefix and Truncated badge need more than 5,000 notes.

- **Of the Knowledge page, only the graph's orientation layer has been drawn
  (2026-09-02).** Unverified in a browser:
  wikilink and modified clicks, **Back** via `popstate`, the 250ms debounce,
  stacking below `md`, the 2026-08-22 Obsidian constructs (a DOM count is no
  substitute) and chrome pass (scroll-to-note, reduced motion, the 180ms
  spinner, tag chips), and the graph box's `aspect-[4/3]` on a wide window.

- **No run has answered out of the vault.** Unmeasured: that the model invokes
  the skill, stops and reports on an unreadable path, and carries the
  confidence grade. The root-owned 0755 `/run/uf-skills` is reasoned, not
  measured (only the `os.tmpdir()` fallback has run); the Settings switch has
  never rendered.

- **The graph view's frame rate and interaction are unmeasured.** Unseen: the
  colour probe and its theme re-run,
  crisp strokes, the rAF stopping, wheel/drag/hover, the non-passive wheel,
  `LINE_HEIGHT_PX` 16 (an estimate), the 7.3MB payload's parse, the row-height
  sizing, and the one-shot tag seed with `uf.knowledge-graph` cleared.

- **`readGuard`'s `PreToolUse` hook has never been seen to fire.** Plugin
  hooks are observed for `SessionStart` only, and the CLI emits
  `hook_response` for `SessionStart` and `Setup` alone, so an inert guard looks
  exactly like one switched off. One billed run settles it: switch `readGuard`
  on, have a cycle read one file twice, and confirm the second read is refused.

### Dreaming

- **Dreaming's nightly timer has never fired**: every night was a press, and
  `tickDreaming`, `reconcileDreamingOnBoot` and `armDreaming` have never run
  unattended; two faults a press cannot expose were found only by reading the
  code. Nothing enforces that an agent reads `CLAUDE.md` first. Settle: one
  03:04 that nobody is present for.

### Retention

- **The retention sweep under a CLI that names transcripts differently.** On a
  moved pin, compare basenames with each file's first `sessionId`.

- **A pruned transcript's run being reopened, against a real CLI.** Both
  halves are unit tested; the whole sequence has not run.

### Security and sandboxing

- **The 2026-08-19 probes did not exercise** the per-run `--settings` overlay,
  `denyRead` paths, the network allowlist, the write set, or real work.

- **Whether the CLI's `filesystem.allowWrite` replaces its defaults is
  unmeasured, 2026-08-25.** Adding `/opt/playwright/browsers` reopens the
  install, but a replacement would drop the cwd and `/tmp` and leave agents
  unable to write their worktrees. Do not add it on reasoning alone.

- **No sandboxed cycle has run with the mount-point fill, 2026-09-04.** Bwrap
  binding over the placeholders is unseen. After a rebuild the `run_events`
  count should fall to zero for project trees, keeping the config-directory
  handful and the one `.idea`.

- **The post-cycle `sweepSandboxTreeRoot` call is unseen, 2026-09-09.** No
  sandboxed cycle since; its log line, the `EBUSY` branch and the interplay
  with `land.ts`'s `trackedDirt` workaround are reasoned only.

- **The merged tree's suite has not been run for the chat child's fill and
  sweep plus `core.excludesFile`.** Its 2,597 and 2,590 passes were measured on
  separate branches; that `runIteration` does all three and
  `runOrchestratorChild` the first two is read from code, not run.

- **The intake filter's uid drop has never been booted.** Unseen: the filter
  running as the agent uid (`docker compose exec usagefoundry ps -o uid,cmd |
  grep 'winnow filter'` must not say 0), the `/var/lib/winnow` ledger growing
  after a cycle (a failed write is silent), and uid 1000 refused `filter-off`.

- **`/app`'s ownership has never been read off a built image** since the
  `Dockerfile` stopped chowning it to `node` (#200); `deployment.test.ts` pins
  the absence. Settle: `stat -c '%U %n' /app /app/server.js
  /app/scripts/discord-relay.mjs` must say `root` thrice, a `touch` as the
  container's `UF_AGENT_UID` must be refused, and the boot log stay healthy.

- **The privilege split's probes (#79, #80, #87, #83) have never been run
  against a container.** `resolveChildCredentials`, the compose/Dockerfile
  pair, the capability file and `telemetryEnv` are unit-tested; one uid cannot
  observe the MCP refusal.
  Also unrun: an isolated run committing as the dropped uid, and macOS Docker
  Desktop's mount remapping. Known open: agents can read `.credentials.json`.
  ```sh
  docker compose logs usagefoundry | grep 'privilege separation'
  # expect "on: children run as 1000:1000, chat and block turns as 1000:65533,
  # server as 0"; uid below read in-container (#147, reshaped 2026-09-08, not re-run)
  uid=$(docker compose exec -T usagefoundry printenv UF_AGENT_UID)
  # #79 the server's environment: expect a permission error, not a count
  docker compose exec --user "$uid" usagefoundry sh -c \
    'tr "\0" "\n" < /proc/$(pgrep -f "next-server" | head -1)/environ | grep -c UF_'
  # #80 the database, fresh and upgraded volume: expect ok twice
  docker compose exec --user "$uid" usagefoundry sh -c \
    'test -w /data/usagefoundry.db && echo BAD-writable || echo ok'
  docker compose exec --user "$uid" usagefoundry sh -c \
    'test -w /data/server.lock && echo BAD-writable || echo ok'
  # #87 mid chat turn: nothing from the first ls, a permission error from the second
  docker compose exec --user "$uid" usagefoundry sh -c \
    'ls /tmp/uf-mcp-* 2>/dev/null; ls /run/uf-mcp 2>/dev/null; echo "exit=$?"'
  # #87 the read: expect "ok: not readable", directory group 65533; no
  # --mcp-config argv found proves nothing, so probe while the turn works
  docker compose exec --user "$uid" usagefoundry sh -c '
    for p in $(ls /proc | grep "^[0-9][0-9]*$"); do
      cfg=$(tr "\0" "\n" < /proc/$p/cmdline 2>/dev/null |
            grep -A1 -x -- --mcp-config | tail -1)
      case "$cfg" in /run/uf-mcp/*)
        echo "pid $p -> $cfg"
        if [ -r "$cfg" ]; then echo "BAD-readable, $(wc -c < "$cfg") bytes"
        else echo "ok: not readable"; fi ;;
      esac
    done'
  # #83 task the agent with `env | grep OTEL_EXPORTER_OTLP_HEADERS`: expect a
  # bearer that is not UF_AUTH_TOKEN
  ```

- **The `/api/mcp` middleware exemption under a real `UF_AUTH_TOKEN`.** Only
  the route's capability check ran, with auth off (no edge runtime there).

- **No sandbox has confined a tool call from this app; no `sandbox` event has
  fired.** Every `bwrap` it caused exited 1 unexecuted; the 15-hour run logged
  484 `tool_error` and 0 `sandbox` rows. Unseen: any CLI-written marker (six
  read by `strings`), the credential deny from a run, the boot line past `none`,
  `enableWeakerNestedSandbox` read by any `claude`, seccomp past `bwrap`. Probe:
  ```sh
  uid=$(docker compose exec -T usagefoundry printenv UF_AGENT_UID)

  # A command the policy refuses, read off the wire rather than off a page.
  docker compose exec --user "$uid" usagefoundry sh -c '
    claude -p "run: touch /etc/uf-probe" --output-format stream-json --verbose' \
    | jq -r 'select(.type=="user") | .message.content[]?
             | select(.is_error == true) | .content'
  # Then compare what it prints against MARKERS in src/lib/sandbox.ts
  # and add what is missing.
  ```

- **No sandbox has ever honoured the per-run write set.** Unrun: run A writing
  into a concurrent run B's `.uf-worktrees/<slot>` via `Bash` and `Write`, and
  `--settings` merging with the managed file. The set left out `/tmp`,
  `$HOME/.npm` and `$GOPATH` until 2026-08-19; that it now suffices is argued,
  not measured. Open dependency: a stock `settings.json` lets a run widen it.

- **Root-owning `~/.claude` (`UF_LOCK_CLAUDE_HOME=1`) has never run in a
  container.** Unknown: that the kernel enforces it (`fakeowner` on macOS may
  void it), that cycles still meter, what it does to the host's `~/.claude`.
  Not read-only: credentials stay readable; `remote-settings.json` and
  `policy-limits.json`, not fully traced, stay agent-owned. Steps, none run:
  ```sh
  # 0. the shipped state first — with UF_LOCK_CLAUDE_HOME unset, nothing changes
  docker compose up -d --build
  docker compose logs usagefoundry | grep UF_LOCK_CLAUDE_HOME    # expect nothing
  uid=$(docker compose exec -T usagefoundry printenv UF_AGENT_UID)
  docker compose exec --user "$uid" usagefoundry sh -c \
    'test -w ~/.claude/settings.json && echo BAD-writable'   # expect BAD-writable

  # then set UF_LOCK_CLAUDE_HOME=1 in .env and restart
  docker compose up -d
  docker compose exec usagefoundry sh -c 'echo "[$UF_LOCK_CLAUDE_HOME]"'
  # expect [1]: compose forwards by name and has no env_file
  docker compose logs usagefoundry | grep UF_LOCK_CLAUDE_HOME
  # expect "…is root-owned: a run cannot rewrite or replace its settings.json…"

  # 1 + 2. the two the sketch names (09-implementation-sketch.md:274–284)
  docker compose exec --user "$uid" usagefoundry \
    sh -c 'echo x >> ~/.claude/settings.json'                    # expect denied
  docker compose exec --user "$uid" usagefoundry \
    sh -c 'rm -f ~/.claude/settings.json; ls ~/.claude/settings.json'
                                              # expect denied, and still listed
  # if the append *succeeds*, the lock is not in force and your settings.json is
  # no longer valid JSON — remove the stray line before the next session reads it

  # 3. and the half that is not a permission check — the metering path
  docker compose exec --user "$uid" usagefoundry \
    sh -c 'ls ~/.claude/projects >/dev/null && touch ~/.claude/projects/.probe'
                                                          # expect BOTH to work
  docker compose exec --user "$uid" usagefoundry \
    sh -c 'cat ~/.claude/settings.json >/dev/null'           # expect it to work
  # then run a real work cycle and confirm the dashboard's figures move

  # from a host shell, not docker compose exec
  ls -ld ~/.claude ~/.claude/settings.json
  # Linux: expect root:<your gid> 0750, and root:<your gid> 0640 on the file
  claude -p 'say hi'                               # expect a normal answer

  # the way back: clear UF_LOCK_CLAUDE_HOME in .env, then
  docker compose up -d
  docker compose logs usagefoundry | grep UF_LOCK_CLAUDE_HOME
  # expect "off — gave /home/node/.claude back to <uid>:<gid>"
  # and if that ever fails to run — two paths, no -R:
  sudo chown "$(id -u):$(id -g)" ~/.claude ~/.claude/settings.json
  sudo chmod 0700 ~/.claude && sudo chmod 0600 ~/.claude/settings.json
  ```

- **No work cycle has run in a started sandbox, the network allowlist never
  ran, and `scripts/sandbox-probe/` has never met a container.** CLI 2.1.226's
  sandbox and the policy choices built on it are readings of the binary.
  `probe.test.sh`'s 37 stub assertions test the harness only; `probe.sh`'s Q2
  cannot reach the failure production showed. Results (Q3, Q8d decide shape):

  | Question | Answer | Recorded |
  |---|---|---|
  | Q0 — are `bubblewrap` and `socat` installable in this image? | **Yes** — both ship in the image and are executable | 2026-08-19, this install; inferred from the CLI's own `access(X_OK)` probe passing |
  | Q1 — does bubblewrap start under the relaxed profile? | **BWRAP-BLOCKED** without `security_opt`, at both uids; **BWRAP-OK** with `uf-seccomp.json`. `--proc /proc` fails either way | 2026-08-19, Engine 29.7.2 / kernel 6.12.76-linuxkit |
  | Q2 — does the CLI refuse to start when it cannot sandbox? | **Neither refused nor unsandboxed** — it starts, reports nothing, and every `Bash` call dies inside `bwrap`; `failIfUnavailable` never fires | 2026-08-18/19, production, 170 failed calls across 8 runs |
  | Q3 — is the sandbox around the session or only around Bash? | *(unmeasured — narrowed on one side: `Bash` is wrapped, `Edit`/`Write` unknown)* | |
  | Q4 — does a credentials deny entry stop a shell reading the token? | *(unmeasured)* | |
  | Q5 — does a user-settings write widen a managed policy? | *(unmeasured)* | |
  | Q6 — what does one sandboxed command cost in tasks? | *(unmeasured)* | |
  | Q7 — does the CLI's sandbox unshare PID? | *(unmeasured)* | |
  | Q8a — which bubblewrap, and does it carry `--tmp-overlay`? | *(unmeasured)* | |
  | Q8b — does `--unshare-pid` plus `--tmp-overlay` work here? | *(unmeasured — narrowed: `--unshare-pid` alone exits 0 under the profile; `--tmp-overlay` has never been tried)* | |
  | Q8c — does one bubblewrap start inside another? | *(unmeasured)* | |
  | Q8d — does the CLI's own bubblewrap start inside one we started? | *(unmeasured)* | |

- **`enableWeakerNestedSandbox: true` has never been read by a `claude`, and
  its price applies once one does.** Written unconditionally since 2026-08-19
  because the other argv shape cannot mount a procfs here; a sandboxed command
  then sees the container's `/proc`, so a sibling agent's processes are
  visible to it.

### Container and environment

- **That the next boot after a failed restore comes up green on an empty path
  was not executed**; it follows from `db.ts`'s unconditional
  `new Database(DB_PATH)` and wants a container.

- **Go on amd64, and a real agent building Go, are unchecked:** the amd64
  branch and digest were never built; only a shell has built Go in the image.

- **`jq` has not run inside a CLI-wrapped `Bash` call**, only in `bwrap`
  command lines.

- **The image has not been built since `npm run build` gained its wrapper.**
  `scripts/redirect-dist-dir.mjs` was measured to do nothing on `overlayfs`,
  which `/app` is on, so the builder should reach `next build` as before; that
  is an argument, not a measurement (no docker client). Settle: `docker
  compose up --build`.

- **`RELAY_PORT` and `RELAY_BIND` have never reached a container.** They are
  in compose's `environment:`, statically reconciled by `deployment.test.ts`;
  unseen are compose substituting them, the relay inheriting them and delivery
  on a moved port. Settle with `RELAY_PORT=9000`: `printenv`, then a notifying
  run's message must arrive: the listening line looked healthy while none did.

- **No second machine has reached a LAN install, and no browser has signed in
  to one.** Client isolation is not ruled out, and `curl` cannot see the
  `Secure`-cookie failure. From another machine, run
  `curl -sf http://<host>:3000/api/health`, sign in and reload; a bounce to
  `/login` means `UF_COOKIE_SECURE` is not `0`.

- **`/api/status` has not been polled on an install with runs in flight.**
  `npm test` covers it on a six-row database; its cost at size is reasoned. No
  browser drew the restart banner, and no monitor has scraped a stdout JSON
  line or checked one for a prompt, path or token:
  `docker logs usagefoundry --since 1h | grep '^{' | jq -c .`

- **Docker has never run the container's `HEALTHCHECK`.** `/api/health` is
  tested both ways and `deployment.test.ts` pins the directive, but the image
  was never built. Settle with `docker inspect --format '{{json
  .State.Health}}' usagefoundry`; after `kill -STOP 1` it should read
  `unhealthy` within ~3 min. Docker reports that and restarts nothing.

- **No Docker has applied the container's resource limits.** `mem_limit`,
  `memswap_limit`, `pids_limit`, `cpus` and the heap ceiling parse by eye only;
  README's per-child memory figures are estimates. `memory.max` reading `max`
  means not in force (likely cgroup v1). The OOM kill and `reconcileOnBoot`
  after it are unexercised.
  ```bash
  docker inspect --format '{{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.PidsLimit}} {{.HostConfig.NanoCpus}}' usagefoundry
  docker exec usagefoundry cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.max
  docker stats --no-stream usagefoundry
  docker exec usagefoundry node -e 'const a=[];for(;;)a.push(Buffer.alloc(1<<26))'
  docker inspect -f '{{.State.OOMKilled}}' usagefoundry   # expect true
  dmesg | tail                                            # expect no host process named
  ```

- **No Docker has applied the container's log cap.** `json-file`, 20m × 5, is
  pinned by `deployment.test.ts`, but no line has been seen rotating; ~270 B a
  line and README's 25-run fleet rates are derived, not measured. A daemon
  `log-driver` in `/etc/docker/daemon.json` would silently override it.
  ```bash
  docker inspect -f '{{json .HostConfig.LogConfig}}' usagefoundry
  # expect {"Type":"json-file","Config":{"max-file":"5","max-size":"20m"}}
  ```

- **The image with `gh` in it.** The install layer, the checksum check and the
  arch mapping have not been built — no Docker on the machine this was written
  on — so `docker compose up --build` is the first thing to run against this.

- **That a fresh `usagefoundry-data` volume is writable under a non-1000
  `UF_UID`.** `/data` is 0777, relying on Docker copying that mode onto a new
  volume; no `docker build` since. On Linux with `id -u` not 1000, then again
  with both uid variables unset:
  ```bash
  UF_UID=1001 UF_GID=1001 UF_PORT=3100 UF_CONTAINER_NAME=usagefoundry-uidtest \
    docker compose -p uf-uidtest up --build -d
  docker compose -p uf-uidtest exec usagefoundry ls -ld /data   # expect drwxrwxrwx
  curl -fsS localhost:3100/api/usage >/dev/null && echo OK      # with UF_AUTH_TOKEN blank
  docker compose -p uf-uidtest down -v
  ```

- **Backup and restore inside Docker.** Driven against real databases and the
  real scripts, never through the container; a restore after
  `docker compose down -v` is the case it exists for.
  ```bash
  docker compose up -d --build
  docker compose exec usagefoundry which sqlite3
  docker compose exec usagefoundry node scripts/backup-db.mjs /backups
  ls -la backups/
  # then, with the app stopped:
  docker compose down
  docker compose run --rm --entrypoint node usagefoundry \
    scripts/restore-db.mjs /backups/usagefoundry-<stamp>.db
  docker compose up -d
  ```

- **The `VACUUM` command in `README.md`**, never executed; check it names one
  `usagefoundry-data` volume and leaves the database file's ownership alone.

- **The launcher's `/opt/winnow/src` branch was not booted, a sync failure's
  retry is unexercised, and no work cycle has run through the rebuilt filter
  (2026-09-10)**; routing rests on the boot line and the proxy answering. The
  1024 MB server heap figure is derived, not seen on a dreaming cold scan.

### Interface

- **The layout sweep has not been re-run since the layout below 768px
  changed** (drawer source list, seventeen tables stacking at `md`).

- **No after-change payload from the 2026-08-23 pass has been read from a
  server.** The "after" sizes (graph 734,233 bytes, workflow list 471) are
  re-serialisations of the one baseline capture, and the readings of the
  sixteen changes, made in parallel against it, do not compose.

- **The orchestrator's `lg` layout has not been seen in a container,
  2026-08-27.** Docker was unavailable: the CSS rests on a clean `npm run
  build` and a grep of the emitted classes. The error banners were injected
  into the DOM, not produced by a failing poll.

- **The shared layer's 390px pass (2026-09-10) was never on a real phone or
  with a keyboard up**; the long-label `Meter` case was a fixture only.

- **The ascii skin (2026-09-11) has been looked at narrowly.** Of 22 routes,
  eight were looked at for the tokens and four for the kit primitives, the
  rest load-asserted; only the dashboard at 1920; the live flip (task
  `d8e5f614`) was never driven; `smoke-pages` is default-skin only
  (`4e6dd0b9`). No second browser (where `█` measures 0.602em), touch, zoom
  or screen reader.

- **Open under the ascii skin, 2026-09-11.** Five findings stay on the board,
  among them `New run` clipped off at 390px in both skins; `ListView`'s real
  borders still mismatch at 1920, where dark was not re-measured. The
  in-flight marks were seen in Chromium, dark, 1280px only; the charts ran on
  intercepted responses, `RunConflictMap` only empty; the meter fit was
  exercised at one glyph advance.

- **The ascii head-rule and sparkline fixes were checked on scratch pages**:
  `/account`'s table did not render (no transcript data) and run `d02b9e40`
  was never loaded, so neither reviewer's own page has been seen fixed.

- **No other sheet has been seen at 390px, and none on a real phone or with a
  software keyboard up**, the case `--keyboard-inset` and the `100dvh` cap are
  for. Of the eleven other files that open one, only Codex's `Use API key` has
  been opened, width unrecorded; the workflow pass did not trigger
  `WorkflowEditor`'s or `WorkflowSchedule`'s confirmations.

- **The narrow workflow surface has never been touched by a real finger**:
  thumb reach, a 44px row at the foot of a long list, and whether the list
  reads as an ordering are unjudged. On a phone: link two non-adjacent blocks
  of a six-block graph at `/workflows/[id]/edit`, watching the arming state
  while scrolling, then change a schedule at `/workflows/[id]`.

- **The Settings mobile pass has never been on a phone or tapped, and its
  stacked calibration table has never shown a real scan.** With no
  transcripts `Scan history` gives no suggestion; the table was seen only with
  `cal` seeded by a reverted local patch. No sheet here but Codex's `Use API
  key` has been opened.

- **Two widened new-run pickers, template (`runs/new/page.tsx:1388`) and agent
  (`:1547`), were never seen at 390px** (settle: save one of each, open
  `/runs/new`); they match the four measured by construction. Nothing in that
  pass was tapped. At 390px the touched and conflicts maps held two and one
  file nodes: no folded directory, `modify/delete` node or open inspector.

- **The touched map has never been looked at on a real run.** Its 300-file fold
  has never fired on real data, and none of the hand checks is done: CPU idle
  and reduced motion, the node legend, labels, gestures, one-cycle, swept and
  no-diff states, folding, theme switching, 390px.

- **Touch replay has never been scrubbed on a real run.** Open: whether the halo
  is findable in motion, whether the wash reads as progress or noise, whether
  `TARGET_SECONDS = 20` (chosen by reasoning, not watching) suits a real run's
  length, and that space neither double-toggles Play nor scrolls the page.

- **The four frontend reachability fixes have never been rendered.** Paged runs
  list, quick-open search, run-log filter and settings search, ~900 lines of
  page code on `uf/usagefoundry-721638d11c0b-1-41e5e190`, rest on typecheck,
  `npm test` (1,660 tests / 245 suites / 0 failures) and the build at `a34e56b`.
  No page tests, jsdom or CI browser.

- **The runs list and ⌘K search have never been driven in a browser.** Open:
  paging without repeats, Failed over the whole history, debounced search, the
  24-hour boundary (one fold request a minute), old runs in ⌘K.
  `/api/runs?status=nope` should answer `Unknown run status: nope`.

- **The run log's filter and the settings field search have never been
  rendered.** They rest on six unit cases (`matchesLogFilter`,
  `logFilterActive`) and the build; the settings search has no unit test, as it
  reads `textContent`. Open: counts and truncation hint, Jump to live, results
  opening closed Prompts folds, the unsaved dialog, 390×844.

- **The run log's background-task panel (`RunTasks.tsx`) has never been
  rendered.** Only its reducer is tested (18 cases in `runTasks.test.ts`). Open
  it on run `eadfe9f2-ac96-4c44-b59a-fbb3c9341871`, which has real
  `system:task_*` events; the empty, cut-replay, stopped-task and 390×844 states
  are unchecked.

- **No stacked table has been opened in a browser.** Unseen at 390×844: no
  sideways scroll, and the branches bar above its arithmetic-chosen
  `max-md:h-80` spacer. `max-md:last:border-b-0` is not recorded in the CSS,
  and 1440px unchanged rests on `Table.test.tsx` alone.

- **The chat surface has met no real device and no interaction.** Unknown:
  whether 24px between Reject and Approve (chosen, not measured) keeps a thumb
  off a billed run, and whether the sticky composer holds on iOS Safari.
  Nothing pressed a choice, approved, sent a message or opened the drawer.

- **The mobile form pass was reasoned from platform docs and never watched.**
  On a real iOS device: tapping a `/runs/new` field must not zoom, and the
  composer, save bar and `Sheet` buttons must stay above the keyboard, with
  `--keyboard-inset` back to `0px` on blur. 44px targets at ≤767px are
  unmeasured, and 1440px unchanged is by argument.

- **The density restructure is unseen below about 390px and unmeasured at
  1440px.** The browser would not resize, and none of the five build runs had
  Docker. Also unseen: the `Land N branches` confirmation, the fixed-bar
  strategy picker, `Disclosure`s opening and closing, and Approve sending
  exactly the displayed ids through a real thread.

- **The band picker has not run under `docker compose up --build` or drawn a
  real winnow tree (2026-09-04).** Labels and repeats were seeded, the shortfall
  sentence has not met a dropped tail, `aria-live` is unheard, and no new
  reading has arrived under an open region. Settle: hold a region open on a
  growing pruning run until a reading lands; rows swap, region and age hold.

- **The dashboard's top row has not been seen as the real page**, with
  transcripts behind it: its composition, the ragged bottom edge under
  `items-start` at 1920 and the `lg`-to-`xl` band with content are unlooked-at.
  Open `/` at 1920 and about 1100 with a run in flight.

- **The live-telemetry card has not been seen in the real row (2026-09-04)**:
  its bottom edge beside the 16rem tile, and the phone case with a six-run list
  between the meters and everything below. Open `/` at 1920 and about 390 with
  a run in flight.

- **The four-item release pass is written down and nothing has performed
  it**, so how many of the nineteen `src/app/**/page.tsx` pages fail it is
  unknown. Each item runs across every page, at two widths:
  1. Every page at 390px: no sideways body scroll, no clipped control, every
     `stack`ed table naming its own fields — the class of `434c235`'s Land
     select, where `.w-auto` (byte 15178) lost to `.w-full` (byte 15197).
  2. Every page in both themes, and on "Match system" while the OS appearance
     changes; a `<canvas>` must re-probe its colours without a reload.
  3. Tab through each primary flow: the focus ring visible at every stop, in
     the order the page reads.
  4. The controls that need state: a queued run's priority input, the Backups
     row's `unreadable` state, the chat turn's live view. The fourth, Deliver,
     is no longer open: it opened a real pull request, on the one path where
     branch, remote and credential are all present.

- **The composition stack's hatched overflow strip has not been drawn at
  390px.** It sits in the same `viewBox` as the bands, which is an argument,
  not a measurement.
