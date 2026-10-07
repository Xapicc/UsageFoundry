# Budgets, guards and concurrency caps

> Extracted verbatim from `CLAUDE.md`, which grew past the size Claude Code will
> load into a session. Each paragraph records a correctness or safety decision
> whose violation is silent — nothing throws, nothing fails to typecheck.
> **Read before editing src/lib/budget.ts, installBudget.ts, and every guard site in orchestrator.ts.**

This file is an index. Each line below is the lead claim of one paragraph, and the paragraph itself is in the topic file its heading links to.

## [Enforcement modes and what bounds one cycle](budgets-and-guards/enforcement-modes.md)

- How guards are enforced is the operator's choice, and none of the three modes is a hard cap.
- `between-cycles` (the default) reads the guards only before each iteration.
- `live` also reads them on a global ticker (`liveGuardTick`, `settings.liveGuardIntervalSeconds`, floor 15s) while a child is in flight, and interrupts it.
- `live-resume` is `live`, except the 5-hour window parks the run instead of ending it.
- `LIVE_ENFORCEABLE_CODES` is the whitelist.
- All three of those modes bound what a cycle may *spend*, and none of them bounds a cycle that spends nothing — so a work cycle also has a deadline, and the deadline is silence rather than wall clock.
- Every one of those three bounds is a bound on a count of cycles, so the run's own spending limit is enforced somewhere else as well — inside the CLI.
- `run_cost`/`run_tokens` are live only because telemetry makes them live — this is the one place OTLP feeds a budget decision.
- A Codex run's `run_tokens` is live off its session rollout, and its `run_cost` is never live because there is no cost.
- A guard whose input is optional is not a guard, so the input stops being optional.
- A cycle that is only waiting on its background sub-agents is bound by three of these guards and not by the rest, and the duration limit is the one the CLI's wait ceiling has to carry (`run-lifecycle/background-work.md`).
- A cycle cut short by a pause is refunded to the counter.

## [Concurrency caps and the install's rolling limit](budgets-and-guards/concurrency-and-install-ceiling.md)

- Concurrency multiplies overshoot — `maxRunCostUSD` is per run, so N runs at $5 is a $25 worst case — and `maxConcurrentRuns` bounds N.
- The concurrency cap is a bound on the host, so it ships as a number and it covers every kind of `claude` child.
- A local run needs a slot under two caps, and the second is about another machine.
- And a cap on N still bounds nothing about the total, so there is one limit that is about the install rather than about a spender.
- `installSpend` reads a fifth place, and the reason it did not before stopped being true.
- Counting a spender and refusing it are two halves, and the install limit had only the first for assists.
- The door is read once, so what an admitted child spends has to be bounded on the child, and **every conflict resolution now carries `resolutionBudgetUSD` as `--max-budget-usd`**: $20 by default …

## [Termini, waiting out a window and the duration cap](budgets-and-guards/termini-and-waiting.md)

- A run's provider changes nothing about the terminus rule and everything about the sentence.
- Only the 5-hour window can be waited out.
- `maxDurationMinutes` caps the minutes a run *worked*, not the wall clock since it started — and it is still a terminus.
- Three rules follow from the column rather than from the arithmetic, and each fails silently.
- One guard can now be extended, by a bounded count, and nothing else about the terminus rule moves.
