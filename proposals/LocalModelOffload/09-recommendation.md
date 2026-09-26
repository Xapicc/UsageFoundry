# 09 — Recommendation

## In one line

**Do not build the local agent MCP yet: set sub-agents to Sonnet (Option A),
trial a local reader through the operator's own MCP config — which already
reaches every work cycle — and build the in-app read-only tool (Option B, then
Option C) only if [`11-validation.md`](11-validation.md) shows read-heavy runs
spending at least 15% less frontier weight at the same outcome.**

This is **against building the local agent MCP now**, and for building it
later on one measured condition.

## The case

1. **The brief's premise does not hold for this app's runs.** The third of
   window share that went to sub-agents is the operator's Mac. In this install's
   worktree runs, sub-agents are **8.0%** of list-price weight and read-only
   sub-agents — the only ones the vault's evidence lets a local model replace —
   **2.0%**, about $115 of $5,755 over the measured month
   ([`00-problem.md`](00-problem.md) §1). A perfect local agent that replaced
   every one of them changes the monthly picture by two points.
2. **The larger target is a hypothesis.** The main loop's reading is 42.6% of
   run weight, and the local agent MCP could reach it — by collapsing several
   single-read turns into one call, which the frontier-side model in
   [`04-option-c-local-agent-mcp.md`](04-option-c-local-agent-mcp.md) §1 prices
   favourably. Whether the frontier model then does its task as well is the
   vault's open seed, and nobody has measured it
   (*Does a Local Sub-Agent Cost the Main Loop More Than It Saves*,
   `status: seed`, `confidence: low`).
3. **The question that decides it costs no app code to answer.** Runs carry no
   `--strict-mcp-config` (`src/lib/cycleInvocation.ts:1188`), so a small HTTP MCP
   server on the host, added to the operator's `~/.claude` config, is a working
   trial of Options B and C in every work cycle. It lacks what makes the in-app
   version worth building — per-run containment, run-log rows, one queue,
   cancellation — and none of those are needed to learn whether the frontier
   weight falls.
4. **Option A is the vault's first step and is free.** One compose line. Worth
   a few points here, not a third — but it is the only option with no failure
   mode, and its week of before-and-after is the baseline the trial needs
   anyway.

## The shape to build, if the trial clears the bar

Read-only; in the app's own process; a minimal loop over the local server's
OpenAI-compatible endpoint with three reading tools and an answer; one global
queue with a short admission wait and a fast "do it yourself" refusal; reads
verified on the opened descriptor against the run's checkout; one run-log row
per call and per file read; aborted with the run. Delivered as a second server
in the app-written config, runs only. [`10-implementation-sketch.md`](10-implementation-sketch.md)
has it in full, with a build order that ships Option B first.

## Refused by name

- **A write-capable or Bash-capable local agent.** Its actions happen inside
  one MCP call, outside the permission mode, the `pkill` denial and the run log
  ([`04-option-c-local-agent-mcp.md`](04-option-c-local-agent-mcp.md) §3), and
  the local tier edits eight or more points worse and does multi-step work about
  half as well (*Local Model Quality by Agent Task*, `confidence: medium`).
- **Claude Code as the local agent's harness.** 16.7k–45k tokens of prompt
  before any work, the failure catalogue, and the OAuth trap (*What Breaks When
  Claude Code Runs on a Local Model*; C5).
- **CustomStacks as the vehicle.** A stack has no MCP field and cannot know which
  run is calling ([`01-constraints.md`](01-constraints.md) C12).
- **The orchestrator chat.** Planning stays on Claude, and the chat's
  `--strict-mcp-config` is a deliberate narrowing (C4).
- **A local-provider run (D) and a gateway (E)** as offload — the vault's steps
  5 and 6, for the vault's reasons and this install's smaller delegated share.
- **A local task-completion validator (F).** A wrong "done" from a weaker judge
  closes a task nobody reopens.

## What would overturn this

1. **The trial clears the bar.** In [`11-validation.md`](11-validation.md)'s
   experiment, read-heavy tasks spend ≥15% less frontier list-price weight with
   the local tool than without, at the same outcome grade, with edit-heavy tasks
   not worse and median wall clock up by no more than a fifth. Then build B,
   then C, in the sketch's order.
2. **Runs hit the window often.** "That headroom is worth something only when
   the operator hits a limit" (*Local Offload Economics*). If ProviderFallback's
   frequency SQL (U6) shows runs parked on the allowance more than about once a
   week, a smaller measured saving is worth building for, and the 15% bar
   should drop.
3. **The operator's hardware prefills fast.** If U5 measures a 16k-token prompt
   in under ~10 s (an RTX-class GPU is 5–9 s per 32k in the vault's table; M5
   "narrowed the gap", *Local Decode and Prefill Speed*), C's latency objection
   largely falls and its contention table shrinks by several times.
4. **The runs start delegating.** If this install's sub-agent share rises
   towards the Mac's third — runs using workflows, or a template that
   delegates by design — the block Options A, C and E compete for grows by four
   times, and A's cheap step is worth redoing first.
5. **The container cannot reach the host (U1).** Then nothing local works from
   this app without a compose change, the trial included — settle U1 before
   anything else.

## If overruled

If the operator builds the local agent MCP without the trial, build it in
[`10-implementation-sketch.md`](10-implementation-sketch.md)'s order anyway —
Option B's one-shot tool first, behind its own setting, off by default — and
run the validation experiment on phase 1 before starting phase 2. Phase 1 is
the part of C that is certainly reused, and the experiment is the only thing
that says whether phase 2 is worth its containment surface.
