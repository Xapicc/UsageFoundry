# LocalModelOffload

**Where this app could use a model on the operator's own machine to take load
off the frontier models it pays for — and whether to build an MCP server that
lets a run's session spawn sub-agents on that local model.** Six options, each
given its strongest honest case; the local agent MCP, which the operator leans
toward, gets the deepest treatment and the full implementation sketch.

A survey that ends in one recommendation, not a plan. Read
[`00-problem.md`](00-problem.md) first: its measurement corrects the premise the
brief was written on.

---

## The finding that shapes everything

**This app's runs hardly delegate.** The vault's case for local offload rests
on the operator's own Mac sessions, where about a third of window share went
to sub-agents (*Local Offload Economics*, vault, `confidence: medium`). This
install's own run transcripts, measured with
[`scripts/window-share.mjs`](scripts/window-share.mjs) over 906 worktree-run
sessions from 2026-08-27 to 2026-09-26 ($5,755 at list price), say something
else:

- **Sub-agents are 8.0% of run weight; the main loop is 92.0%.** The same
  script over the Mac's own directories gives 30.6%, so the method agrees with
  the vault and the runs are the outlier.
- **Read-only sub-agents — the only ones the vault's quality evidence lets a
  local model replace — are 2.0%**, about $115 a month at list price.
- **The jobs runs delegate are too big for the local model that would take
  them.** The median read-only sub-agent peaked at **75,672 tokens** of
  context, over the 64K window the vault recommends, and would take 1.5 to 15
  minutes to replay on a Max- or Ultra-class Mac.
- **The largest block is the main loop reading, 42.6%** — almost all of it the
  main loop re-reading a median 116,217-token prefix to decide to read, one
  read per turn (only 5.5% of tool turns carry more than one read). That is the
  one block a local agent could reach by collapsing several reads into one
  call, and whether the frontier model then does its task as well is the
  vault's open question, measured by nobody.

Three more findings narrow it further:

- **The delivery path exists, and a trial needs none of it.** The app already
  hands each work cycle an app-written MCP config with a per-run token
  ([`01-constraints.md`](01-constraints.md) C12), and — separately — runs carry
  no `--strict-mcp-config` (`src/lib/cycleInvocation.ts:1188`), so an MCP server
  in the operator's own `~/.claude` config already reaches every work cycle.
- **CustomStacks cannot carry an MCP server.** A stack is binaries, environment
  and caches, install-wide, with no MCP field (`proposals/CustomStacks/14-stack-object-model.md`).
- **Claude Code aborts an HTTP MCP call after 300 s with no response or
  progress, and a `-p` session does not background a long one** — read from the
  installed 2.1.280 binary. With one GPU slot and four concurrent runs, a
  queued local call can outlive its caller.

## Recommendation, in one line

**Do not build the local agent MCP yet: set sub-agents to Sonnet (Option A),
trial a local reader through the operator's own MCP config, and build the
in-app read-only tool (Option B, then Option C) only if
[`11-validation.md`](11-validation.md) shows read-heavy runs spending at least
15% less frontier weight at the same outcome.**
[`09-recommendation.md`](09-recommendation.md) has the case, six refusals by
name, and five things that would overturn it.

## The files

| | |
|---|---|
| [`00-problem.md`](00-problem.md) | The question; this install's measured window split against the vault's; every place the app spends frontier money, with file:line, classified by the vault's task-quality evidence. |
| [`01-constraints.md`](01-constraints.md) | Twelve constraints of this install — hardware as a parameter, host reach, the sandbox, permission, credentials, one GPU slot, the clocks a slow tool call runs into, what the run log shows, Codex — and eight unknowns with the command that settles each. |
| [`02-option-a-cheaper-claude-first.md`](02-option-a-cheaper-claude-first.md) | **A** — no local model; `CLAUDE_CODE_SUBAGENT_MODEL`. Free, and worth ~2.6% of run weight here. |
| [`03-option-b-one-shot-local-tool.md`](03-option-b-one-shot-local-tool.md) | **B** — summarise or extract one file. The best-evidenced local task; its saving in a coding agent unmeasured. |
| [`04-option-c-local-agent-mcp.md`](04-option-c-local-agent-mcp.md) | **C** — the local agent MCP, in depth: loop shape and per-call latency, what it may do, delivery, reach, contention, metering, credentials, and whether it saves anything. |
| [`05-option-d-local-provider.md`](05-option-d-local-provider.md) | **D** — a run entirely on the local model, through Claude Code or Codex `--oss`. A privacy option, not an offload one. |
| [`06-option-e-gateway.md`](06-option-e-gateway.md) | **E** — a gateway routing sub-agents to the local server. Dominated by A. |
| [`07-option-f-app-internal-calls.md`](07-option-f-app-internal-calls.md) | **F** — review, validation, resolution and chat on a local model. Only review fits, and it is too small to move. |
| [`08-comparison.md`](08-comparison.md) | The facts side by side, why there is no weighted score, what dominates what, and one finding outside the question: runs batch reads in 5.5% of turns. |
| [`09-recommendation.md`](09-recommendation.md) | The case, the shape to build if the trial clears, the refusals, the overturning facts, and the order if overruled. |
| [`10-implementation-sketch.md`](10-implementation-sketch.md) | The local agent MCP as it would be built: tool schemas, where each piece lives, settings, the new containment rule, the loop, the queue, delivery, visibility, build order. ~1,300 lines, ~9–11 days. |
| [`11-validation.md`](11-validation.md) | Four checks, then the experiment: eight real tasks, with and without a local reader, on frontier weight, wall clock and outcome. And what this survey verified and did not. |
| [`scripts/window-share.mjs`](scripts/window-share.mjs) | The measurement behind §1 of `00-problem.md`, dependency-free, rerunnable. |
| [`scripts/latency.mjs`](scripts/latency.mjs) | Per-call wall clock for each loop shape, from the vault's prefill and decode figures. Arithmetic, not a measurement. |
| [`scripts/delegation-cost.mjs`](scripts/delegation-cost.mjs) | The frontier side of one delegated read job, three ways, and the break-even local pass rate. A model, not a measured saving. |
| [`scripts/check-citations.mjs`](scripts/check-citations.mjs) | Resolves every path and line number in this directory; copied from ProviderFallback's. |

## The options at a glance

| | target, measured here | local task class | per call | new surface | build | verdict |
|---|---|---|---|---|---:|---|
| **A** cheaper Claude | 8.0% (4.4% movable) | Sonnet/Opus 0.90 | — | none | **0** | **do first** |
| **B** one-shot tool | main-loop reads, 42.6% of steps | summarise: parity | 10–93 s | one app-read path | 2–3 d | **trial, then build** |
| **C** local agent MCP | **2.0%** safely; main-loop route unmeasured | search: one study | 26 s–15 min, serialised | app reads an agent can swap | 9–11 d | **trial; build after B** |
| **D** local-provider run | the whole run | multi-step: ~0.5 | an hour+ a cycle | the whole run | 2–6 d | no |
| **E** gateway | 8.0%, inseparable | multi-step: ~0.5 | Claude-sized | a proxy on all traffic | 5–8 d | no |
| **F** app-internal | small, unmeasured | review only | 10–90 s | one diff | ~2 d | no |

## Reused, not redone

ProviderFallback covers the `codex` provider's metering gaps, `childEnv`'s
credential strip and `providerTerminusRefusal`
(`proposals/ProviderFallback/README.md`); this survey re-checked the line
numbers against `4a49627` (`childEnv` is now at `src/lib/orchestrator.ts:5857` and
strips both OpenAI keys; `providerTerminusRefusal` at `src/lib/budget.ts:477`) and
relies on the rest. The deleted ModelRouter survey
(`git show 0232554:"proposals/notRecomended - ModelRouter/README.md"`) settled
that delegated turns are "displacement, not a gap" and recommended no router;
Options A and E agree and add only the environment variable it never examined.

## Found on the way, filed rather than fixed

Three taskboard tasks, none part of this survey: a Codex run with a blank
model inherits a Claude `defaultModel`, and an assist on a Codex run passes a
Codex model to `claude`; `childEnv` does not strip `CODEX_ACCESS_TOKEN`; and
review, validation and conflict resolution never ask the install daily ceiling.
