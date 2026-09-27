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

## Not yet verified by hand

- **The process budget has never refused a real child in a browser, nor
  deferred and woken a real block.** `assistBudget.test.ts` covers it. Settle:
  *Other Claude processes at the same time* at 1, a workflow block behind
  something slow and a chat turn; the block should wait, then start as the
  chat settles.

- **A work cycle stopping at its `--max-budget-usd` ceiling.** The argv is
  unit tested; no billed cycle has hit it, so whether the CLI honours it on
  `-p` and how far a cycle overshoots are reasoned, not measured.

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
