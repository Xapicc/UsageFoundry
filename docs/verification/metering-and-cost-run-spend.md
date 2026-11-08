# Verification: Metering and cost — a cycle's spend, resumed sessions and the per-repository readout

[← Verification index](../verification.md)

## Verified

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

- **A `-p` child saves its cost ledger at exit, and `--max-budget-usd` counts
  from the restore: read off the 2.1.280 binary, no turn spawned, 2026-09-29.**
  Headless mode registers the `cost-state` writer (`nyt`) only as an exit
  provider. It is written after `error_during_execution` and after SIGINT,
  whose handler exits gracefully. Only SIGKILL or a crash skips it, and the
  previous record is then restored. The print-mode `--resume` branch calls
  `nte` with no condition beyond a record whose `sessionId` matches. The budget
  check reads `em() - restoredCostUSD()`. Caveat: that
  `error_during_execution` exits by the normal route was inferred, not traced.
  `cycleSpendOf` banks each resumed work cycle's increase on this reading.

- **`repoReading()`'s query time over a synthetic corpus at the 2026-08 size,
  2026-10-17, branch `uf/usagefoundry-721638d11c0b-22`.** The install's
  database is not readable from a work cycle, so this was measured against a
  scratch database built through `migrate()`. It held 294 runs and 124,950
  `run_events` rows with a mean payload of 544 bytes; 4.7% were `Read`s, 1.6%
  edits and 0.4% `tool_error`s, with 59 completed resolutions. Five calls took
  30–36 ms in the two queries and 42–56 ms per call including the three pure
  readings. That is one full scan, against 2026-08's 0.155 s for the unsplit
  repeat query on the install's own table. Caveat: synthetic payloads, so it
  bounds the shape of the cost and not this install's figure.

- **The readout's band on the dashboard, standalone build, 2026-10-17, seeded
  state.** One repository with nine reads by two runs (one repeat, not
  edited), 44 failures across two runs (one signature 41 times, one long
  path-laden text twice, one seen once) and three completed resolutions at
  $12.50. Opened in Chromium at 1280 and 390px. `/api/repo-reading` answered
  each count as seeded. The card drew the three sections, with the long
  failure sample wrapped inside its row at 390px, the per-file table with no
  dollar column, and the resolutions' $12.50 once. `scrollWidth` equalled
  `clientWidth` at both widths, with no console error.

- **The readout's three pure readings, 2026-10-17.** `repoReading.test.ts`,
  14 cases. A mutation of the compiled module that turned off the edited test
  failed one case, and one that dropped the runs-first ordering of failures
  failed one case.

- **A Codex run's banked tokens on the run page, runs list and live tile,
  standalone build, 2026-10-25, branch `uf/usagefoundry-721638d11c0b-13-2187a73b`.**
  Four Codex rows inserted into a scratch `DATA_DIR` under a running server:
  34,000 reported with 30,000 in `spent_tokens_est` (failed, one finished,
  one running) and 34,000 with none. Opened in Chromium at 1280 and 390px. The
  banked run's page said "64.0k tokens, 30.0k of them counted from the session
  log" with "Codex reported 34.0k" under it and "64.0k tokens over its work
  cycles" in the agent sentence; the other said "34.0k tokens, as Codex
  reported them". The list drew 64.0k with "includes 30.0k from session log"
  and 34.0k bare, and the tile 64.0k and 34.0k likewise. No console error, no
  sideways scroll, and `npm run smoke-pages` was 100/100 on the standalone
  bundle. Caveat: seeded rows, not a cycle killed for real.

## Not yet verified by hand

- **No real resumed chat turn has been compared with its transcript.** The
  entry above is read, not run, and `chat_turn_spend` now banks each resumed
  turn's increase on it; whether `result.usage` is cumulative too is unread.
  Settle it with two turns on one thread in a logged-in container: compare
  `SELECT ts, cost_usd FROM chat_turn_spend WHERE chat_id = '<id>'` in
  `$DATA_DIR/usagefoundry.db` with that session's deduped per-message usage in
  `~/.claude/projects/*/<session>.jsonl` priced by `pricing.ts`, and read the
  second turn's `result.usage` against the first's.

- **No real run resumed across work cycles has been reconciled since
  `cycleSpendOf`, 2026-09-29.** The loop is pinned only by
  `resumedCycleSpend.test.ts`, against a stub that restores its ledger the way
  the 2026-09-29 *Verified* entry reads the binary. Settle it with one three-cycle run on one
  session, `telemetryForRuns` on, then in `$DATA_DIR/usagefoundry.db`:
  `SELECT r.spent_usd, r.session_cost_usd, (SELECT SUM(cost_usd) FROM
  otlp_requests o WHERE o.run_id = r.id) FROM runs r WHERE r.id = '<id>'`.
  The three should agree to the cent. Rows written earlier keep their
  inflated `spent_usd`.

- **The `cycleCostAfterResult` fix is unit-tested only, 2026-08-27.** 1,816
  tests pass; no rebuild, not read in the running app. Check a two-`success`
  cycle's run-page spend against its telemetry card. `075f7959` and
  `65252b8a` keep their inflated stored `runs.spent_usd`.

- **The unsplit-cache-write notice was seen only on `next start`**, not the
  standalone bundle, with the settings row written in SQL; no real transcript
  lacking the breakdown has been seen.

- **The per-repository cost card has never been rendered or read against a
  real multi-repository install.** `groupRunSpend` is unit-tested only. Check
  its total against `SELECT SUM(spent_usd) FROM runs WHERE created_at >= …`,
  and that a run outside git lands in `(not a repository)`.

- **What the per-repository readout shows on this install.** Not measured: no
  run could read the database (`proposals/ContinuousImprovement/19-remeasure-2026-10.md`).
  To settle it, open the dashboard's *What runs keep re-deriving* band and
  compare its largest repository's repeat and addressable shares with
  `docker exec -i -w /app usagefoundry node --input-type=module - /data/usagefoundry.db < proposals/ContinuousImprovement/scripts/remeasure.mjs`,
  which uses the same definitions. They should agree except where the card
  folds two mounts of one directory into one repository and the script, which
  keys on the stored string, does not.
