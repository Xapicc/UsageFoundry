# 00 — The problem, and what this install actually spends on

## The question

> Where could this app use a model running on the operator's own machine to
> take load off the frontier models it currently spends on — Claude Opus 5.5 /
> Fable 5.1 through the `claude` provider and gpt-6-astra through the `codex`
> provider — and in particular, should it build an MCP server that lets a run's
> session spawn sub-agents powered by a local model?

The operator leans toward the MCP. This survey treats it as a candidate: it gets
its strongest case in [`04-option-c-local-agent-mcp.md`](04-option-c-local-agent-mcp.md)
and its strongest case against in the same file.

The research the brief rests on is in the operator's vault, read-only at
`/workspace2/3 Resources/`. Every note is cited here by title with the vault's
own grade: its `confidence:` and `status:` fields and, where the claim rests on
one source, that source's grade (`blog`, `peer-reviewed`, …). Nothing in the
vault was run on the operator's Mac; the vault says so itself (*Recommended
Local and Claude Hybrid Setup*, `confidence: medium`, `status: growing`: "No step
below was run end to end on a Mac").

## 1. The measurement that moves the answer

The vault's case for offload starts from one month of the operator's own Claude
Code sessions on the Mac: **a third of window share went to delegated
sub-agents**, 96.8% of it on Opus-family models, and the largest main-loop block
was reading and searching files at 37% (*Local Offload Economics*,
`confidence: medium`, `status: growing`; the breakdown is the author's own
measurement over 157 sessions, 2026-08-26 to 2026-09-25).

That month is the operator's *interactive* work. This app's runs are a
different population, and their transcripts are on this machine: the container
mounts the operator's `~/.claude` as `CLAUDE_CONFIG_DIR` (`docker-compose.yml:253`,
`Dockerfile:51`), and a run with a worktree of its own writes under a project
directory named `-workspace--uf-worktrees-…`.
[`scripts/window-share.mjs`](scripts/window-share.mjs) walks those, deduplicates
by request id, recurses into `subagents/` (workflow sub-agents sit one level
further down, under `subagents/workflows/<id>/`), and weights every request by
API list price including cache multipliers, copied from `src/lib/pricing.ts:28`–`:30`
and `:63`–`:103` — the same proxy the vault uses, because the subscription's own
formula is unpublished.

`node proposals/LocalModelOffload/scripts/window-share.mjs`, run 2026-09-26:

| | This install's worktree runs | The operator's Mac sessions (`^-Users-`) | The vault's figure for the Mac |
|---|---:|---:|---:|
| Window | 2026-08-27 → 2026-09-26 | 2026-08-26 → 2026-09-26 | 2026-08-26 → 2026-09-25 |
| Sessions | 906 | 176 | 157 |
| Priced requests | 61,844 | — | 26,260 |
| List-price weight | **$5,755.38** | $3,107.57 | ~$3,300 |
| Main loop | **92.0%** | 69.4% | 64.3% |
| Sub-agents, all | **8.0%** | 30.6% | 35.6% |
| — workflow sub-agents | 0.0% | 17.2% | 21.4% |
| — general-purpose | 4.4% | 12.8% | 13.5% |
| — Explore | 2.9% | 0.3% | 0.7% (with fork) |
| — named agents (`go-coder`, `typescript`, `claude`) | 0.8% | — | — |
| On Opus 5 / Opus 5.5 | 90.0% / 7.9% | — | 96.8% together |
| On Fable 5.1 | 1.4% | — | 3.0% |
| On Sonnet 5 or Haiku 4.5 | 0.7% | — | 0.2% |

The script reproduces the vault's shape on the Mac's own directories (30.6%
sub-agents against 35.6%, over a window one day longer and with a different
deduplication), so the method agrees with the vault's. **The runs are the
outlier: sub-agents are 8.0% of what they spend, and 92.0% is the main loop.**

Split by what each sub-agent actually did (a sub-agent that called `Edit`,
`Write`, `MultiEdit` or `NotebookEdit` "wrote"; one that ran any Bash command
outside a fixed read-only list, any MCP tool or a nested agent is "read + Bash";
the rest are "read-only"):

| Sub-agent kind in runs | Count | Share of all run weight | List price over the window |
|---|---:|---:|---:|
| Read-only | 80 | **2.0%** | ~$115 |
| Read + Bash | 120 | 5.2% | ~$299 |
| Wrote | 20 | 0.8% | ~$46 |
| **All** | **220** | **8.0%** | **~$460** |

And the size of the job a run hands to a sub-agent, which decides whether a
local model could take it (percentiles over the 220; "fresh" is uncached input
plus cache writes, the tokens a local server with a working prefix cache would
have to prefill; "peak" is the largest single request, the window it would have
to hold):

| Per sub-agent | p25 | median | p75 | p90 |
|---|---:|---:|---:|---:|
| API requests | 14 | 25 | 41 | 65 |
| Fresh tokens, all | 69,728 | 97,046 | 135,076 | 219,796 |
| Fresh tokens, read-only | 61,335 | 84,166 | 108,572 | 154,930 |
| Output tokens, read-only | 886 | 3,483 | 7,346 | 16,786 |
| **Peak context, read-only** | **57,921** | **75,672** | **91,976** | **141,077** |

**The median read-only sub-agent in this install's runs held 75,672 tokens at
its peak** — above the 64K context the vault recommends serving a local model
at (*Recommended Local and Claude Hybrid Setup*, step 3). Part of that is Claude
Code's own sub-agent prompt, which a minimal local loop would not carry; the
rest is the files it read. Either way, the delegated read in this install is
not the "few thousand tokens" the vault's tool shape assumes.

The main loop, weighted by what each step did (a request's weight goes to the
tool calls it emitted, "text" when none — the vault's attribution), as a share
of all run weight: **read and search 42.6%**, other Bash 29.6%, edits 14.4%,
plain text 2.5%, MCP 2.2%, delegation 0.3%. Reading is the largest block, as
the vault found on the Mac (37%) — and it is almost all the cost of the main
loop re-reading its own prefix to decide to read, not the file bytes.

Three other populations, same script, same run:

- **The orchestrator chat**, whose children run in `/run/uf-chat` (`src/lib/chat.ts:3950`):
  22 sessions, 2026-09-15 → 2026-09-26, **$60.63** at list price, sub-agents
  0.4%. Around 1% of what runs spend.
- **Runs without a worktree**, which write under their folder's own directory
  (`^-workspace-[^-]`): 146 sessions, $607.64, sub-agents 5.2%. These
  directories may also hold sessions that were not runs; they are reported,
  not added in.
- **Codex runs**: none found. `~/.codex` holds only `tmp`, so no Codex session
  has been recorded in this container's home; gpt-6-astra spend, if any, is
  invisible to this measurement and — per ProviderFallback — to the app's
  meters too (`src/lib/orchestrator.ts:6331`, `providerRecordsSpend`).

**Caveats, stated once.** List-price weight is a proxy for window share, not
the window (the vault's own caveat). One month. Worktree runs only. The
read-only classification is by tool name and a Bash prefix list, so a
`python3 -c` that only reads counts as "Bash". The window moves: rerunning the
script later gives different figures, which is why it is shipped rather than
its output.

## 2. Every place this app spends frontier money

The app starts a paid model from exactly **three spawn sites**; everything
else that costs money — Dreaming, workflows, loops, schedules, chat approvals,
reopen — does it by creating a run. The app makes no model call over HTTP or
an SDK: its server-side `fetch`es go to the usage endpoint
(`src/lib/planUsage.ts:46`), the Admin API and a notification webhook. winnow
and its intake filter spawn no model (`src/lib/contextPruning.ts` runs only
`treat`/`plan`/`context`/`fork`; the intake filter is a loopback proxy that
rewrites and forwards, `src/lib/intakeFilter.ts:16`–`:20`).

| # | What | Spawn site | Provider and model | Task class | Tools, mode | Spend bound | Fires |
|---|---|---|---|---|---|---|---|
| 1 | Claude work cycle | `src/lib/orchestrator.ts:6421`, argv `src/lib/cycleInvocation.ts:990` | `claude`; `--model run.model` (`src/lib/orchestrator.ts:9300`), frozen at create as `input.model ?? settings.defaultModel` (`:3865`); `--effort settings.runEffort` (`src/lib/cycleInvocation.ts:1224`) | **multi-step coding** | full toolset, `acceptEdits` default (`src/lib/orchestrator.ts:9301`) | `--max-budget-usd` per cycle when a run limit is set (`src/lib/cycleInvocation.ts:1328`–`:1331`); guards between cycles | per cycle |
| 2 | Codex work cycle | same spawn; argv `src/lib/cycleInvocation.ts:1516` | `codex`; `-m run.model` (`:1523`), free text | **multi-step coding** | `workspace-write` for `acceptEdits` (`:1404`–`:1416`) | cycle cap or time limit only — no money ceiling exists (`:1465`–`:1466`), spend not recorded (`src/lib/orchestrator.ts:6331`) | per cycle |
| 3 | Sub-agents inside a session | no spawn; the CLI's Task/Agent tool | inherits the CLI's defaults; the app sets no `CLAUDE_CODE_SUBAGENT_MODEL` anywhere and passes the environment through `childEnv` (`src/lib/orchestrator.ts:5857`) | **reading/search** to **multi-step** | the sub-agent's own | inside the cycle's | when the main loop delegates; told to by `DELEGATION_NOTICE` (`src/lib/cycleInvocation.ts:840`) |
| 4 | Orchestrator chat turn | `src/lib/chat.ts:3077` | `claude`; `settings.defaultModel` or CLI default | **conversation/planning** | `bypassPermissions`, `--strict-mcp-config` (`:2975`) | `--max-budget-usd chatTurnBudgetUSD`, $2 default | per operator message |
| 5 | Workflow orchestrator block | same site, `src/lib/workflows.ts:5823` | as chat | **planning/classifying** | `bypassPermissions` | `chatTurnBudgetUSD` | per block advance |
| 6 | Review | `src/lib/review.ts:816` | `claude`; `--model run.model` (`:754`) | **reading/summarising** a diff | `plan`, read-only (`:269`) | 10-minute timeout, no money cap | on click |
| 7 | Task-completion validation | via `startAssist`, `src/lib/validation.ts:567` | as review | **classifying** (a judge) | `plan` | `validationBudgetUSD`, $1 (`:591`) | on `complete_task`, when enabled |
| 8 | Conflict resolution | via `startAssist`, `src/lib/land.ts:1582` | as review | **single/multi-file editing** | `acceptEdits` | none per call | on click, or automatically from a merge batch |
| 9 | Dreaming | a run, `src/lib/dreamingRun.ts:370` | `claude`, default model | **multi-step** (writes vault notes) | `bypassPermissions` | `dreamingMaxCostUSD` $2, 6 cycles (`:51`), 90 minutes (`:62`) | nightly when enabled |

Classified against *Local Model Quality by Agent Task* (vault,
`confidence: medium`, `status: growing`), which puts the line "between
**transforming given content** and **deciding under feedback**":

- **Near parity locally** (summarise, extract to a validated schema,
  localise/search): item 6, the reading half of item 3, and — only as a
  one-shot tool — the reading steps inside items 1 and 2. Summarising is "at
  parity or better as a writer of summaries; worse as a judge of them" (Vectara
  leaderboard, `vendor`).
- **Behind by eight points or more** (single-file edits, EDIT-Bench,
  `peer-reviewed`): item 8.
- **About half of Opus** (multi-step agentic coding, SWE-rebench fresh tasks,
  `industry-report`: Qwen3.6-27B 31.2 against Opus 5 63.4): items 1, 2, 9, and
  every sub-agent that edits or runs Bash.
- **A judge**, which the vault finds local models worse at: item 7 — and a
  wrong "done" from a local judge closes a task the operator then never looks
  at again.
- **Conversation and planning with tools**, which no row of the vault's table
  measures and the vault keeps on Claude (step 0): items 4 and 5.

## 3. What this does to the brief

The brief's picture — "about a third of window share went to delegated
sub-agents" — is the operator's Mac, not this app. In this app's runs:

1. **The sub-agent block the local agent MCP would replace is 8.0% of run
   weight, and the read-only part — the only part the vault's evidence lets a
   local model take — is 2.0%.** A local agent MCP that replaced every
   read-only sub-agent perfectly, at zero rework, removes about $115 a month of
   list-price weight from ~$5,755.
2. **The larger target is the main loop's own reading (42.6%)**, which a local
   agent could only reach by the main loop calling it *instead of* reading —
   and the vault's open question is precisely whether that leaves the frontier
   model able to edit what it no longer saw (*Does a Local Tool-Output
   Summariser Save Frontier Usage in a Coding Agent*, `status: seed`,
   `confidence: low`).
3. **The jobs runs delegate today are larger than a 64K local window.** A local
   agent given the same job would have to be given a smaller one.

Everything after this file is written against those three facts.
