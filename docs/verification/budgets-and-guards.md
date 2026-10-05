# Verification: Budgets and guards

[← Verification index](../verification.md)

## Verified

- **Budget refusal returns `blocked` with 0 iterations and 0 spend.**

- **Metric selection:** the cost ceiling wins when both are set, tokens when
  cost is cleared, null when neither is.

- **The guard reads the cost fraction:** with the window at 11.2%, allowed at
  an 80% guard and refused at 5%.

- **Unpriced-model guard fallback, 17 assertions:** 90M output tokens from an
  unknown model read `$0`, yet `guardFraction` is 45× a $100 ceiling and the
  guard blocks; priced windows are unchanged, and no ceiling still refuses.

- **A parked run's time bar is frozen, and a resumed one starts where it left
  off.** Measured 2026-09-20 against the standalone bundle from this branch's
  own `npm run build`, on a scratch `DATA_DIR` with two hand-seeded rows: both
  `started_at` 4h50m ago with a 60-minute cap, one `running` carrying
  `paused_ms = 4h`, one `paused` with `paused_at` 4h ago. Both drew
  `50m 0s / 60m`; reloaded 45 seconds later the running one read `50m 47s` and
  the parked one still read `50m 0s`. Caveat: the rows were written straight
  into `runs` rather than reached by parking a real run, so this measures the
  page's arithmetic against the columns and not the orchestrator's writes to
  them — those are covered by `src/lib/orchestrator.test.ts`.

- **Reserved headroom:** a 50% reserve halves a $200 ceiling to $100, doubling
  the reading (13.8% → 27.5%) past a 20% guard; 400% clamps to 95%.

- **Budget policy and guard order, `npm test` 11 cases:** `normalizePolicy` is
  idempotent over JSON; `evaluateBudget` refuses `no_terminus` first, parks on
  the 5-hour window only under `live-resume` and never on the weekly, and
  blocks on reconciled spend that `spent_usd` alone would miss.

- **`--max-budget-usd` binds while the CLI waits on background sub-agents,
  2026-10-05.** Host `claude` 2.1.280 against a local stub Messages server with
  a fake key, a background sub-agent whose first response the stub priced at
  about $1.00, `--max-budget-usd 0.50` and the wait ceiling at `0`. 5.2 s in,
  when that response landed, stderr printed `Budget limit reached ($1.00 of
  $0.5); stopping background agents.`, the task was killed (`task_updated
  killed`, `task_notification stopped`) and the cycle ended with a `result` whose
  subtype was `success`, `total_cost_usd` 1.0009 and exit 0 — **not**
  `error_max_budget_usd`, so `buildArgs`' branch for that subtype does not see
  this ending and the pre-cycle `run_cost` check is what stops the run. When
  the *main* thread's own turn crossed the cap the result was
  `error_max_budget_usd`, `is_error` true, exit 1, and the background agent was
  killed with the same stderr line. Caveat: stub-reported usage priced by the
  CLI, so it shows the flag is honoured on `-p` and that sub-agent spend counts,
  not what a real cycle overshoots by; the stub's second sub-agent request was
  already in flight and was not billed.

- **An idle wait for a background sub-agent writes nothing to stdout or stderr,
  2026-10-05.** The same stub with the ceiling at `0` and a sub-agent that made
  no tool calls: the largest gap between lines was 69.98 s in a 70 s run and
  139.9 s in a 140 s one — no heartbeat and no `task_progress`. A sub-agent that
  is making tool calls prints a `task_progress` and its own assistant and tool
  lines at each one, which is what keeps `cycleSilenceMs`'s clock from running
  down. So the silence deadline does bind during a quiet wait, and ends the
  cycle `failed`, not through the CLI's own ceiling. Not measured: a sub-agent
  inside one long real Bash call, because the CLI's Bash tool could not start in
  the sandbox this ran in.

## Not yet verified by hand

- **The process budget has never refused a real child in a browser, nor
  deferred and woken a real block.** `assistBudget.test.ts` covers it. Settle:
  *Other Claude processes at the same time* at 1, a workflow block behind
  something slow and a chat turn; the block should wait, then start as the
  chat settles.

- **A billed work cycle stopping at its `--max-budget-usd` ceiling.** The argv
  is unit tested and the CLI honours the flag on `-p` against a stub (the entry
  above), but no billed cycle has hit it, so how far a real cycle overshoots is
  reasoned, not measured.

- **A conflict resolution stopping at `resolutionBudgetUSD` (added
  2026-09-27).** `resolutionBudget.test.ts` asserts the argv against a stub
  CLI; no billed resolution has hit it, so that the pinned CLI ends a `-p`
  resolution there and the merge is rolled back is reasoned, not measured.
  Settle: *Limit per conflict resolution* at 0.05, press Resolve on a
  conflicting run; the row should fail naming `error_max_budget_usd` and the
  branch should be unchanged.

- **A workflow-wide budget tripping against real spend.** No instance has been
  halted by a guard; `instanceSpend` has never summed a real `otlp_requests`
  row.
