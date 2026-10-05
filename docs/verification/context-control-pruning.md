# Verification: Context control — pruning, compaction and the context ceiling

[← Verification index](../verification.md)

## Verified

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
  invalidation was understated 16.6% — charged against `tokens_after`,
  405,049 across the four, where the resumes actually wrote 485,828 — which
  overstated the net by 22.6% (`+$4.39` displayed against `+$3.58`
  corrected), so `netReceipt` now prices it off the first billed turn's
  `cache_creation_input_tokens`.

- **Both prune triggers have fired: 54 receipts, 52 `early-end` and 2
  `boundary`, read 2026-09-07.** 2026-08-24 to 2026-08-28, 47 runs, read from
  `/data/usagefoundry.db`, not the untracked `prune-audit-dump.json`. Receipts
  1-4 match the four measured 2026-08-24 digit for digit. `tokens_before` is
  the transcript measure, not the API measure the ceiling compares.

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

- **The compaction reader and `compactionNotice` have run against a real
  boundary off this machine.** The session matched and the notice rendered in
  full; only the run loop's call site is unexercised.

- **The ceiling's below-the-mark reset adds almost nothing but cuts,
  2026-09-27.** Replaying the minute tick (last main-thread `usage` frame,
  `apiContextTokens`' sum) over the 256 transcripts under
  `~/.claude/projects/-workspace*` that crossed 200,000: 581 measurements under
  the old pacing, 656 with the reset. Of those only the reset took, 117 followed
  a drop of 25,000 or more and 5 a dip of 2k-23k. In-loop dips are common frame
  to frame (5,245, median 492 tokens) but a minute's growth hides them, so a
  threshold on the reset buys nothing. Caveat: per file not per run, ticks
  rebuilt from timestamps, cuts inferred from the drop.

- **One `pruneSavingsByRun` call costs one transcript scan, and the fork half
  used to cost one per forked run, 2026-10-05.** Against this install's 2,444
  transcripts (116,865 turns, 2.6 GB, a slow mount) with a scratch `DATA_DIR`
  and eight running runs, tree base `88674f1`. With no receipts: 0.1 ms. After
  the one-pass change: 58-76 ms with no transcript grown and 129-139 ms with
  one grown, whether the eight had pruned in place, forked, or half each. Before
  it, eight forked runs took 3.2-4.5 s (memo hit) and 1.8-3.6 s (memo missed).
  `scanUsage` alone read 67 ms and 189 ms in the same two cases, so what
  pricing adds on top of a scan is about 20 ms or less. Caveats: eight in-place
  runs, one scan on both sides of the change, read 0.24-0.75 s in the first
  batch and 58-76 ms in the last, so the machine's load or cache moved the
  baseline by a factor of five and only the fork case's factor, which tracks
  the number of runs, is the change's; the first call in a process, which reads
  every transcript, took 14-18 s in the first batch and 5.7-6.5 s in the last,
  which is the filesystem cache's temperature and is paid by whichever caller
  scans first; the receipts were written by hand, and a transcript growing was
  simulated by clearing the scan memo rather than by a run writing.

- **`/runs/live` tiles show Saved, Lost and Net for each running run,
  2026-10-05**, the standalone bundle built from `88674f1` plus this change,
  headless Chromium at 375x2600 and 1280x1500, a scratch `DATA_DIR` and
  `CLAUDE_HOME`. Six running runs written after boot, each in one state: no
  receipt (`null`, drawn as a dash over "no prune yet"), settled, a boundary
  prune after a cold first resume with no clean probe (`unsettledPrunes` 1),
  two prunes of which one ran on a model with no price, a prune on a model with
  no price alone, and a prune with no later turns (net −$1.00). The polled
  figure for each equalled `pruneSavingsByRun`'s for it; the unsettled tile read
  "Net, at most" over a dash and "not settled yet"; the partly unpriced read
  "money over 1 of 2" and the unpriced one dashes and "money over 0 of 1". At
  375px the three columns were 95px each with no cell, tile or document
  overflow and no console error, and "re-reads avoided" and "restarts paid
  for" stayed on one line; at 1280px 147px each. `npm run smoke-pages` 96/96.
  Caveat: the tile is 40px taller once a run has pruned than before, so a run's
  first prune moves what is below it on that tile.

## Not yet verified by hand

- **The mark clears in `pruneAtBoundary` and the fresh-start branch have not
  met a real run**; `contextCeilingRace.test.ts` drives only the tick's reset.
  Settled by a fork-engine run that declines at the ceiling, forks at a natural
  boundary and crosses again: `prune_decisions` should hold an `early-end` row
  at its first `context_samples` reading over 200,000 after the fork, not
  25,000 past the pre-fork decline.

- **No netted prune figure has been read against a real run.** The KPI
  arithmetic rests on unit tests and a clean `npm run build`; the
  `ContextControlAside` tile's six states were rendered only as markup from
  hand-written DTOs. Also unchecked: the corrected invalidation against a fifth
  prune, and whether `readAppended`'s `rotated` test catches a prune's rewrite.

- **Lowering the ceiling from 300,000 to 200,000 was a judgement, 2026-08-25.**
  No `prune_receipts` or `netReceipt` comparison was taken across the two.
  Never seen in the running app: a crossing at the current ceiling, the new
  prune log line, and the per-tick cost of reading every live run's
  transcript with no size gate.

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

- **The pruning block on a `/runs/live` tile has not met a real running run,
  2026-10-05.** Every receipt behind it was a row written by hand. Settles it:
  `docker compose up --build`, run a task long enough to cross the context
  ceiling with `contextPruningEngine` set to `winnow` and again to `legacy`,
  open `/runs/live`, and compare each tile's Saved, Lost and Net with that
  run's own page.
