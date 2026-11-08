# The three data sources

[← architecture index](../architecture.md)

Read before editing `src/lib/transcripts.ts`, `windows.ts`, `adminApi.ts` or `otlp.ts`, or anything that sets two of their figures side by side.

**Three** data sources now, still **never summed or mixed in the UI**. The third is Claude Code's own OTLP export (`otlp.ts` → `otlp_requests`), gated on `settings.telemetryForRuns` with one exception — a run whose own guards need it gets it regardless, under *A guard whose input is optional is not a guard* in `docs/agent/budgets-and-guards/enforcement-modes.md` — covering only runs this app spawns. It is first-party per-request cost — no price table, no dedupe key, no file polling — and it is the only way to account for a work cycle killed before the CLI's `result` event. It renders as its own card on the run page and its own card on the dashboard, and must never reach `buildSnapshot()` or `runs.spent_usd`. It reaches a budget decision through exactly one door — `telemetrySpendSince` → a `*Guard*` figure — and that door is narrow on purpose: one run, one cycle, the guard half of a split whose display half stays transcript- and `result`-derived. Two callers go through it and no more: a live run's own spending limit via `RunProgress.spentGuardUSD`, described in `docs/agent/budgets-and-guards/enforcement-modes.md` under *`run_cost`/`run_tokens` are live only because telemetry makes them live*, and a workflow instance's own budget via `instanceSpend` → `InstanceProgress.spentGuardUSD`, which reads each `running` member's current cycle bounded by `runs.active_started_at`. Same bound, same destination, and neither ever reaches `runs.spent_usd`. It cannot replace transcripts: no backfill, no `cwd`, and `cache_creation_tokens` collapses the 5m/1h split. Wire details were captured from a live CLI, not read from the docs — the docs' `claude_code.api_request` is the record *body*, while `event.name` is the bare `api_request`, and `OTEL_RESOURCE_ATTRIBUTES` lands on both the resource and each record. The payload carries `user.email` and account UUIDs; the parser drops them and the schema has no column for them. `request_id` is the primary key because OTLP delivery is at-least-once, and the ingest route always answers 200 — a batch exporter retries failures, so rejecting a malformed record would cost that batch on a loop.

The two original sources:

| | Subscription view | API-account view |
|---|---|---|
| Source | `~/.claude/projects/**/*.jsonl` | Anthropic Admin API |
| Code | `transcripts.ts` → `windows.ts` | `adminApi.ts` |
| Route | `/api/usage`, `/api/calibrate` | `/api/account` |
| Nature | exact volumes, **estimated** percentages | authoritative |
