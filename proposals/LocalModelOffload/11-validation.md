# 11 — Validation

Two halves. §1–§2 is the experiment that decides the recommendation: the same
real tasks with and without a local reader, compared on frontier weight, wall
clock and outcome — the vault's step 7, "Compare the share of the five-hour
window used on similar days before and after step 4; the usage formula is
unpublished, so this is the only honest measure available" (*Recommended Local
and Claude Hybrid Setup*). §3–§4 is what this survey itself checked, and what
it could not.

## 1. Before the experiment: four checks, an hour between them

| | Check | Command or step | If it fails |
|---|---|---|---|
| U1 | The container reaches the host's model server | on the host, with `llama-server -m <model>.gguf -c 65536 --jinja -np 1 --host 0.0.0.0` running: `docker compose exec <service> sh -c 'getent hosts host.docker.internal; curl -s http://host.docker.internal:8080/v1/models'` | stop: nothing local works from this app without a compose change |
| U5 | What a call costs on this hardware | on the host: `llama-bench -m <model>.gguf -p 2048,16384 -n 256`; put the prompt and generation rates into [`scripts/latency.mjs`](scripts/latency.mjs)'s `PROFILES` | if a six-read call is over ~4 minutes, stop: it cannot fit under Claude Code's 300 s HTTP idle floor with a queue in front of it |
| U3 | A run may call an MCP tool under `acceptEdits` without an allow rule | one throwaway run on a scratch repository with the trial server below attached and one prompt that names the tool; read the run's `tool_error` rows | add a `permissions.allow` entry for the tool in the mounted `~/.claude/settings.json` for the trial's duration |
| — | Which file the container's user-scope MCP config lives in | `docker compose exec <service> claude mcp add -s user …` then `claude mcp list`, and check the Mac's own `claude mcp list` does not show it | if the Mac's sessions see it too, use a project-scope `.mcp.json` in the trial repositories instead |

The last row matters because the container mounts the operator's real
`~/.claude` (`docker-compose.yml:253`); a trial server registered carelessly
would reach the operator's Mac sessions as well (**assumed** that the
container's user config is `$CLAUDE_CONFIG_DIR/.claude.json` and the Mac's is
`~/.claude.json`, which would keep them apart — the row settles it).

## 2. The experiment

**The trial server** (no app code; the operator's own, ~150 lines, **not
written here**): a stdio MCP server run inside the container by the CLI —
inside, so it sees the container's checkout paths — exposing the two tools of
[`10-implementation-sketch.md`](10-implementation-sketch.md) §1 with the same
schemas, the same trailer (files and line ranges read, turns, wall clock,
tokens) and the same refusals, against `http://host.docker.internal:8080/v1`.
It should log one JSON line per call (run's `cwd`, tool, paths read, tokens,
queue wait, wall clock) to a file under `$TMPDIR`, because nothing it does
reaches the run log ([`01-constraints.md`](01-constraints.md) C8). It inherits
`childEnv`'s environment and may or may not be sandboxed (U2); for a
read-only trial that makes one HTTP call to a fixed URL, that is acceptable
and should be said in the write-up.

**The tasks.** Eight real tasks from this install's own history whose original
run succeeded and whose base commit still exists — four **read-heavy**
(a question about the code, an audit, a survey like this one, a "find where
X is decided") and four **edit-heavy** (a bug fix with a test, a small feature).
Each re-run from its original base commit on a fresh branch.

**The arms.** Control: no trial server attached. Treatment: the trial server
attached, and one sentence in the task prompt saying what the tools are for.
Because an MCP server in the user config reaches every run at once, arms run in
**batches**, not interleaved: control batch, treatment batch, control batch,
treatment batch, two runs of each task in each arm (32 runs). Hold constant:
model pinned (`claude-opus-5-5`, via the run's model field), `runEffort`,
template, budgets, worktree isolation, and `maxConcurrentRuns` at 1 — so the
treatment's latency is measured alone and contention (§6 of Option C) is not
confounded with it. List-price cost is **assumed** at $5–15 a run from the
measured month ($5,755 over 906 sessions, and ModelRouter's recorded spread of
$4.75 to $66.66 per run), so the experiment is ~$160–480 of list-price weight.

**What to record, per run:**

| Measure | From |
|---|---|
| Frontier list-price weight, main loop and sub-agents | `node proposals/LocalModelOffload/scripts/window-share.mjs ~/.claude/projects '<the run's worktree directory>'` |
| Main-loop turns, and the share of turns batching several reads | same script: `mainLoopToolTurns` — the confound named in [`08-comparison.md`](08-comparison.md) §4 |
| Five-hour window share | the app's plan-usage reading before and after each batch (vault step 7); batch-level only |
| Wall clock and work cycles | the run page |
| Local calls, their wall clock and queue waits | the trial server's log |
| Verification reads | main-loop `Read`s of a file the local answer cited, after the call |
| Outcome | edit-heavy: tests pass, then a blind A/B grade by the operator on the diff; read-heavy: a blind grade of the report against a three-point rubric (correct, complete, cites real code) |

**The decision rule** is [`09-recommendation.md`](09-recommendation.md)'s: build
phase 1 if read-heavy tasks spend ≥15% less frontier weight in the treatment
arm at the same median grade, edit-heavy tasks are not worse on either, and
median wall clock rises by no more than a fifth. Report the local calls whose
answer was wrong and **not** caught — those are the cost the vault says
dominates, and the frontier-side model in
[`scripts/delegation-cost.mjs`](scripts/delegation-cost.mjs) cannot see them.

**Fold the result back** into the vault's two seeds (*Does a Local Tool-Output
Summariser Save Frontier Usage in a Coding Agent*; *Does a Local Sub-Agent Cost
the Main Loop More Than It Saves*), whose "How to grow this" lists this
experiment's shape.

## 3. What this survey verified, and how

| Claim | How |
|---|---|
| Sub-agents 8.0% of run weight; read-only 2.0%; main loop 92.0%; the per-sub-agent sizes; main-loop context median 116,217; 5.5% multi-read turns | `node proposals/LocalModelOffload/scripts/window-share.mjs`, 2026-09-26, over 81 worktree project directories |
| The method reproduces the vault's Mac figure | the same script with `'^-Users-'`: 30.6% sub-agents against the vault's 35.6% |
| The chat's spend | the same script with `'^-run-uf-chat'`; the chat's cwd is `/run/uf-chat` (`src/lib/chat.ts:3950`) |
| No Codex session recorded | `ls ~/.codex` shows only `tmp` |
| The three spawn sites and the inventory | read from code; each row's file:line in [`00-problem.md`](00-problem.md) §2, re-checked with `grep -n` against `4a49627` |
| Claude Code 2.1.280's MCP idle, hard and auto-background behaviour | `grep -a` over `/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe` for `MCP_TOOL_TIMEOUT`, `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` and `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`; the constants' bindings are inferred from minified code |
| Codex `--oss`, `--local-provider`, the Responses-only refusal, `-c mcp_servers…` under `--ignore-user-config` | `codex --help`, `codex exec --help`, `codex mcp list -c …`, `codex exec --ignore-user-config --strict-config -c …` and a scratch stdio server's handshake under `codex debug prompt-input`, all with a scratch `CODEX_HOME` and no model request |
| `childEnv` strips `OPENAI_API_KEY` and `CODEX_API_KEY` | `src/lib/orchestrator.ts:5865`–`:5866` |
| The per-call latencies and the delegation arithmetic | [`scripts/latency.mjs`](scripts/latency.mjs) and [`scripts/delegation-cost.mjs`](scripts/delegation-cost.mjs) — arithmetic on vault figures and measured medians, not measurements |
| Every path and line number in this directory resolves | `node proposals/LocalModelOffload/scripts/check-citations.mjs` |

## 4. Not verified

- **Any local model on the operator's hardware** — every latency here is the
  vault's figures run through arithmetic (U5).
- **Reach from the container to the host** (U1). This run's own probe was
  inconclusive: its sandbox proxy returned the same 502 for
  `host.docker.internal` as for a nonexistent `.invalid` name.
- **Whether the CLI sandbox wraps a stdio MCP server** (U2), whether
  `acceptEdits` under `-p` permits an MCP tool without an allow rule (U3), and
  whether Claude Code sends `tool_progress` for an MCP call (U4).
- **How often runs park at the window** (U6): `/data` is not readable from a
  work cycle.
- **Whether `llama-server` serves `/v1/responses`** (U7), and so whether Codex
  can use it.
- **Whether `CLAUDE_CODE_SUBAGENT_MODEL` moves `general-purpose` in 2.1.280**
  (U8), and why only 0.7% of run weight is on Sonnet.
- **Review, validation and conflict-resolution spend**, which runs in the
  run's checkout and could not be separated from the worktree figures.
- **Every saving claimed anywhere for a local tool in a coding agent.** None is
  claimed here; the experiment above is how one would be.
