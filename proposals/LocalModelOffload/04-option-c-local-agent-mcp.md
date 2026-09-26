# Option C — the local agent MCP

**An MCP tool a run's session calls with a brief; the tool runs a small agent
on the operator's local model, which reads the run's checkout and returns an
answer.** The operator's preferred option. This file gives it its strongest
case (§1), then answers the eight questions the brief set (§2–§9), then the
case against (§10). [`10-implementation-sketch.md`](10-implementation-sketch.md)
is what building it would take.

It is not the vault's step 4 (Option B, one request, no loop) and not its step 6
(Option E, a gateway that sends Claude Code's own sub-agents to the local
model). It sits between them: a loop, like a sub-agent, but the app's own loop
over the local server's OpenAI-compatible endpoint, reached as a tool, like
step 4. The vault's closest words for it are the tool shape's — "the local
model cannot act; it can only read what it is handed and answer" (*Hybrid
Claude and Local Model Setups*, `confidence: medium`) — widened to "it can also
choose what to read next".

## 1. Its strongest case

Four facts, each measured or read, not argued:

1. **The main loop reads one thing per turn, and every turn re-reads a large
   prefix.** In this install's runs, 54,049 main-loop turns called a tool; only
   4,768 (8.8%) called more than one and 2,967 (5.5%) more than one read
   (`scripts/window-share.mjs`, 2026-09-26). The median main-loop request carried
   **116,217 tokens** of context (p75 163,945). Reading and search steps are
   **42.6%** of all run weight ([`00-problem.md`](00-problem.md) §1). A tool that
   turns six sequential reads into one call removes five prefix re-reads, and
   that is the one mechanism in this survey that can reach the main loop's
   largest block rather than the 8% sub-agent block.
2. **On the frontier side, delegation is cheap to try.**
   [`scripts/delegation-cost.mjs`](scripts/delegation-cost.mjs), at Opus 5
   list prices and the measured median context, for a six-read job (2,000
   tokens a read, assumed) that then rides 10–60 more turns:

   | Turns after | Main loop reads it | Local, trusted | Local, a third re-read | Local failed, all redone | Claude sub-agent | Break-even local pass rate |
   |---:|---:|---:|---:|---:|---:|---:|
   | 10 | $0.562 | $0.078 | $0.262 | $0.639 | $1.548 | 0.21 |
   | 30 | $0.682 | $0.086 | $0.310 | $0.767 | $1.556 | 0.19 |
   | 60 | $0.862 | $0.098 | $0.382 | $0.959 | $1.568 | 0.17 |

   If failures are caught and redone, the local agent pays for itself on the
   frontier side at a pass rate of about **one in five**. The "Claude sub-agent"
   column uses the measured *mean* read-only sub-agent ($1.47), whose jobs are
   far larger than six reads, so it overstates that route for this job size; it
   is shown because it is what runs actually do when they delegate.
3. **The delivery path exists.** The app already hands every work cycle an
   app-written MCP config with a per-run capability token, serves the tools in
   its own process, removes the file after each cycle and revokes the token
   when the run ends ([`01-constraints.md`](01-constraints.md) C12). A second
   server entry is a small change to a path that is tested and live.
4. **It keeps the subscription out of it.** The local model sees a brief and
   file text. No Claude-shaped prompt, no gateway, no token relaying, no
   question under Anthropic's terms — the vault's reason for preferring the
   tool shape (*Hybrid Claude and Local Model Setups*).

That is a real case. §10 is why it does not win yet.

## 2. Loop shape

Two ways to run the agent behind the tool.

**(i) A minimal loop inside the app.** The app posts to the local server's
`/v1/chat/completions` with a short system prompt, the brief, and three or
four tool schemas (`read_file`, `grep`, `list_files`, `answer`), executes each
tool call itself against the run's checkout, appends the result, and repeats
until `answer` or a turn cap. First request ~2,500 tokens (**assumed**: nothing
is built; ~1.5k of instructions and schemas plus a ~500-token brief).

**(ii) Spawn an existing harness** per call — Claude Code with the vault's
environment block, Aider, OpenCode, Qwen Code. Their first requests, from
*Agent Harnesses for Local Models* (`confidence: medium`, `documentation` and
one observation): Claude Code ~16.7k *observed*, 12k–70k reported; OpenCode
~6k; Aider ~0.5–1.5k plus a repository map; Codex CLI ~5k. Qwen Code's was not
measured.

Per call, from [`scripts/latency.mjs`](scripts/latency.mjs), for a six-read job
(2,000 tokens a read, 150 tokens a step, an 800-token answer, the prefix reused
between turns; prefill rates from *Local Decode and Prefill Speed*, `blog`;
dense decode is the vault's prediction; the dense prefill factor of 5.0 is an
`anecdote` applied beyond where the vault applies it):

| Loop shape | M4 Max, ~3B-active sparse | M2 Ultra, sparse | M4 Max, dense 27B | M3 Ultra, dense 27B | RTX 4090, dense 27B |
|---|---:|---:|---:|---:|---:|
| (i) minimal, 2.5k first request | **42 s** | 26 s | 216 s | 125 s | 58 s |
| (ii) Aider-sized, ~3k | 43 s | 26 s | 221 s | 127 s | 58 s |
| (ii) OpenCode-sized, ~6.5k | 49 s | 29 s | 252 s | 140 s | 62 s |
| (ii) Claude Code, 16.7k | 68 s | 38 s | 348 s | 179 s | 72 s |
| (ii) Claude Code, 45k | 118 s | 61 s | **600 s** | 284 s | 100 s |
| This install's median read-only sub-agent (84k fresh, 3.5k out) | 180 s | 96 s | 913 s | 450 s | 170 s |

Three readings:

- **Claude Code as the harness is out.** At 16.7k–45k of prompt before any work
  it adds 26–384 s per call on a Max-class Mac, and it brings the whole failure
  catalogue with it — silent truncation, tool calls as text, a WebSearch that
  fabricates sources, a system prompt telling the model it is Claude (*What
  Breaks When Claude Code Runs on a Local Model*, `confidence: medium`). It also
  spends the local model's context on instructions tuned for Claude.
- **Aider and the minimal loop cost the same time**, but Aider is an *editor*:
  its formats exist to write files, and its read-only mode is a chat. A
  read-only agent does not need an edit format at all. OpenCode needs native
  tool calling with "no text fallback" — the same as (i).
- **The job must be sized to the model, not copied from Claude.** The median
  read-only sub-agent in this install's runs held **75,672 tokens at its peak**
  (p25 57,921) — over the 64K context the vault recommends — and would take 1.5
  to 15 minutes to replay locally. A local agent that is given what runs give
  Claude sub-agents today would truncate or time out. The tool's contract has to
  be smaller: a question and a scope, a turn cap, a per-read cap, and an answer
  budget, and the loop has to drop old tool output as it goes — the one harness
  result the vault has on tight windows is that trimming old tool results raised
  complete solutions from 43 to 72 of 169 under a 20,480-token window (*Same
  Model Different Harness*, `preprint`, via *Agent Harnesses for Local Models*).

**Choice: (i), the minimal in-app loop.** Same speed as the smallest harness,
no edit machinery, no second process, and — the deciding reason — it is the
only shape in which the *app* executes every tool call, which is what §3, §6,
§7 and §8 need.

## 3. What a spawned local agent may do

**Every action happens inside one MCP tool call.** The calling session's
permission mode sees `mcp__uf_local__local_explore` and nothing within it; the
`--disallowedTools Bash(pkill:*) Bash(killall:*)` denial
(`src/lib/cycleInvocation.ts:711`, `:1258`) binds the **Bash tool** and cannot see
a command the MCP server runs; and the run log drops successful tool results
(`src/lib/orchestrator.ts:7980`–`:7983`). Any write or command the local agent
makes is outside every guard the app puts on a run.

Where it would run:

- **In-app (the chosen shape):** in the Next.js server process, which is
  **root** in the container ("The server is root and every child it spawns is
  not", `docs/agent/security.md:10`). Not inside the run's sandbox, not under
  the agent uid. Root can read `/data`, `/proc/<server>/environ` and the
  credential file. Every path it touches must therefore pass the app's own
  containment against **the run's checkout**, not the mount: `resolveInMount`'s
  lexical check and then its `realpathSync` check (`src/lib/orchestrator.ts:1244`;
  both "load-bearing", `docs/agent/security.md:11`). And because the run's agent
  can write its own checkout, it can swap a checked file for a symlink between
  the check and the read, so the read must verify the path of the **opened
  descriptor**, not of the name — open, `fstat`, resolve `/proc/self/fd/<n>`,
  compare, then read. That is a new containment rule, not a reuse of an
  existing one, and it is the part of this option a security review must look
  at first.
- **As a stdio child of `claude`:** under the agent uid, with `childEnv`'s
  environment (which keeps `ANTHROPIC_API_KEY` and `GH_TOKEN`,
  [`01-constraints.md`](01-constraints.md) C5), and, on the Sandboxing survey's
  working assumption, **outside** the sandbox (C3, U2).

**Default: read-only, and not configurable to anything else.** Three tools
that read (`read_file`, `grep`, `list_files`) and one that answers. No write,
no edit, no Bash, no network beyond the local model server. The evidence
decides it, not caution alone:

- Reading, search and localisation are where the local tier is near Claude;
  single-file edits trail by eight points or more (EDIT-Bench,
  `peer-reviewed`); multi-step coding reaches **about half** of Opus 5 (31.2
  against 63.4 on SWE-rebench fresh tasks, `industry-report`) — all from *Local
  Model Quality by Agent Task*, and "not one of these scores was measured at the
  quantisation a local user actually runs".
- An edit the local agent makes lands in the run's branch without the calling
  model having seen it, and the operator's review is where the vault puts the
  largest cost: "at the about 0.5 pass-rate ratio measured for local agentic
  coding, half of all attempts cost review time and a redo" (*Local Offload
  Economics*).
- Bash inside an MCP call is the `pkill` incident's shape exactly: a command no
  deny list sees, issued by an agent the run log does not show
  (`docs/agent/security.md:21`–`:22`).

A write-capable local agent is a different option with a different risk, and
nothing in the vault's evidence makes it worth taking.

## 4. Delivery

| | Second server in the app-written config | A CustomStacks stack | The operator's own `~/.claude` MCP config |
|---|---|---|---|
| Mechanism | `writeMcpConfig` (`src/lib/chat.ts:4145`) writes a second entry, e.g. `uf_local`, beside `uf` | none: a stack has no MCP field and nothing links it to `--mcp-config` (C12) | already reaches runs: `--strict-mcp-config` is absent for runs (`src/lib/cycleInvocation.ts:1188`) |
| Per-run token, revoked at run end | yes, the existing one (`src/lib/chat.ts:2292`, `src/lib/orchestrator.ts:10166`) | — | no |
| Tools run where | in the app process (§3) | — | wherever the operator's server runs |
| Knows which run is calling, and its checkout | yes, from the token | — | no |
| Run log rows | yes, via `emit()` | — | no (C8) |
| One queue across all runs | yes (§6) | — | only if the server builds one |
| Aborted when the run stops | yes (§7) | — | no |
| Reaches the chat | only if added to the chat's config | — | **no**: the chat passes `--strict-mcp-config` (`src/lib/chat.ts:2975`) |
| Codex runs | only through `-c mcp_servers…` (C10); off today (`src/lib/orchestrator.ts:8585`) | — | no: Codex runs with `--ignore-user-config` |
| App code | yes | yes, and a new stack field | **none** |

Today the config file exists only when `taskboardForRuns` is on
(`src/lib/orchestrator.ts:8580`). A local agent gated on its own setting needs
that decoupled: one config, written when either setting is on, holding
whichever servers are on. The entry should carry a per-server `"timeout"` (C7),
and the argv needs `--allowedTools mcp__uf_local__*` unless U3 shows
`acceptEdits` permits MCP tools under `-p` without it.

**The operator's own config is the right vehicle for a trial and the wrong one
for a feature.** It needs no code, which is exactly why it is how
[`11-validation.md`](11-validation.md) runs; and it cannot know which run is
calling, cannot contain reads to that run's checkout, cannot show anything in
the run log and cannot be stopped with the run.

**The chat should not get it.** The chat is conversation and planning — the
class the vault keeps on Claude — and it spent $60.63 at list price over its
22 sessions ([`00-problem.md`](00-problem.md) §1), about 1% of what runs spend.
A turn is bounded by a 15-minute silence timeout (`src/lib/chat.ts:482`) that a
queued local call would eat into, and the chat's `--strict-mcp-config` is a
deliberate narrowing of what reaches it.

## 5. Reach

In the in-app shape **the app server makes the HTTP request**, not the run's
child. So the run's sandbox and its `UF_SANDBOX_ALLOWED_DOMAINS` allowlist do
not apply at all (C3); what applies is whether the container can reach the Mac
host. That is unverified here (C2, U1): compose sets no `extra_hosts`, the only
recorded measurement is on Docker Desktop (`scripts/discord-relay.mjs:105`), and
this run's own probe could not tell "unreachable" from "nothing listening". Two
host-side requirements follow from the vault's server line: the server must
listen where the container can reach it (`llama-server` binds loopback by
default; whether OrbStack forwards `host.docker.internal` to the host's loopback
is **assumed**, not checked), and nothing on the path may carry a credential —
the base URL is operator configuration with no key.

In the stdio shape the *child* makes the request, and under `UF_SANDBOX=1` with
an allowlist the host name would have to be on it — an allowlist "never
exercised" (`docs/security.md:217`).

## 6. Contention

One server, one slot (C6): calls are served one at a time, first come first
served. With `maxConcurrentRuns` at 4 (`src/lib/settings.ts:1016`):

| Six-read call, one at a time | M4 Max sparse | M4 Max dense 27B | RTX 4090 dense 27B |
|---|---:|---:|---:|
| Alone | 42 s | 216 s | 58 s |
| Third of three at once | 127 s | 649 s | 173 s |
| Fourth of four | ~170 s | ~865 s | ~230 s |

(`scripts/latency.mjs`; the fourth row is 4× the first.) Three things happen to a
calling session while it waits:

- **Its turn blocks.** A work cycle is `-p` (`src/lib/cycleInvocation.ts:1220`),
  where Claude Code does not auto-background a long MCP call (C7).
- **Claude Code aborts an HTTP MCP call after 300 s with no response or
  progress** (C7) — the dense-27B fourth-in-line case. It then sees an error and
  typically does the reading itself, having paid the brief *and* the wait.
- **It burns time worked** against `maxDurationMinutes`, which counts through a
  blocked call (`src/lib/budget.ts:513`), and nothing in the cost meters shows it.

The design answer is not a longer timeout. It is **a single global queue in the
app with a short admission wait** — if the call cannot start within, say, 30 s,
refuse it at once with "the local model is busy; do this yourself" — plus a
total cap under the 300 s idle floor, so a caller never waits for a result it
will then abandon. That turns contention into a fast fallback to the
frontier, which is cheaper than a slow one. Four slots instead of one would
quarter the context per call, which the job sizes in §2 cannot afford.

## 7. Metering, visibility and cancellation

- **Money: zero, and it must not look like zero *usage*.** Nothing the local
  model does enters `result.total_cost_usd` or any `usage` frame, so the three
  cost sources and every guard are right to ignore it. But time is real: each
  call adds its wall clock — including its queue wait — to the calling cycle.
- **The run log.** Today the log would show `uf_local:local_explore` and its
  input (clipped at 4,000 characters) and nothing of the result or of what the
  local agent read (C8). The in-app server can do better, because it can
  `emit()` its own rows, persist-then-publish (`src/lib/orchestrator.ts:699`): one
  row when the call is admitted, one per file it read (path and bytes), one when
  it answers — with model, prompt and completion tokens as the local server
  reports them, turns, queue wait and wall clock — and the answer itself clipped
  as a tool error is (`:7475`). A per-run total ("local: 7 calls, 4m 12s, 61k
  tokens in") on the run page, beside the cost figures but never summed into
  them.
- **Cancellation.** An in-app call holds an `AbortController` registered by run
  id; `startRun`'s `finally`, which already revokes the run's tokens
  (`src/lib/orchestrator.ts:10166`), aborts them too, and a queued call whose run
  is no longer `running` — parked, cancelled, failed — is dropped when it
  reaches the head of the queue. Aborting the HTTP request frees the local
  server's slot for the next caller (**assumed** of `llama-server`: that it stops
  generating on client disconnect). A stdio server would instead depend on the
  process-group signal reaching a grandchild, which C9 says it may not.

## 8. Credentials

- **The subscription never reaches the local server.** In the in-app shape the
  request is built by app code with no `Authorization` header (or a fixed
  dummy), from a base URL the operator sets; nothing is read from the
  environment. A settings validator should refuse a base URL carrying userinfo
  and refuse `api.anthropic.com` and `api.openai.com` outright.
- **Nothing is spawned**, so `childEnv` is not involved; the in-process tools
  read files and never run a command.
- **Contrast the harness shape (ii).** Claude Code spawned against the local
  server with only `ANTHROPIC_BASE_URL` set sends the subscription's OAuth token
  to that URL (C5); it needs a dummy `ANTHROPIC_AUTH_TOKEN` and must not inherit
  `CLAUDE_CONFIG_DIR`'s login. Aider or OpenCode would inherit `childEnv`'s
  `ANTHROPIC_API_KEY` and `GH_TOKEN` unless given a clean environment. None of
  that exists in shape (i).
- **What the local model sees is the run's checkout**, which may hold secrets
  the operator's repositories contain. The local server is the operator's own,
  on their own machine; this is the same exposure a Claude run already has, to a
  party the operator controls rather than one they don't.

## 9. Whether it saves anything

The honest answer is **unknown, and small at best in this install**:

- **The ceiling.** The vault's own bound: a class holding share $s_i$, moved
  with local pass rate $p_i$ and escalation overhead $o_i$, saves
  $\Delta W = \sum_i s_i (p_i - o_i)$ — "my derivation, not a published result"
  (*Local Offload Economics*). If the local agent only replaced read-only
  sub-agents, $s = 2.0\%$. If it replaced every sub-agent, $s = 8.0\%$ — but
  5.2 of those points ran Bash and 0.8 wrote, which §3 excludes. The only route
  to a larger $s$ is the main loop calling the tool *instead of reading*, whose
  share (42.6%) is mostly prefix re-reads that one call saves only when it
  replaces several reads.
- **The frontier-side arithmetic in §1 is favourable per call**, and it is a
  model, not a measurement. It assumes the job would otherwise have been six
  sequential reads, that failures are noticed, and that the main loop re-reads
  only a third to check. The two assumptions that decide it are the two nobody
  has measured: how often the answer is wrong **without** the calling model
  noticing, and whether the calling model then edits worse for not having seen
  the files. That is the vault's central open question for this shape (*Does a
  Local Sub-Agent Cost the Main Loop More Than It Saves*, `status: seed`,
  `confidence: low`: "Nobody has measured the quantity that decides it"), and
  its hypothesis is split exactly along §3's line — a saving for read-only
  search and summarising, a loss for anything that edits.
- **The value of headroom exists only at the wall.** "A local model cannot win
  on dollars against a subscription that is already paid: it can only buy
  headroom inside the windows. That headroom is worth something only when the
  operator hits a limit" (*Local Offload Economics*). How often this install's
  runs park at the window is not readable from a work cycle (U6).
- **A cheaper way to the same mechanism exists and is unexamined.** The saving
  in §1 comes from fewer main-loop turns. Runs batch reads in only 5.5% of
  their tool turns; independent reads issued in one turn pay one prefix
  re-read, not six, with no local model and no loss of fidelity. It does not
  cover sequential exploration (read A to learn to read B), which is what the
  local loop does; it covers a good part of the rest. [`08-comparison.md`](08-comparison.md)
  carries it as a finding rather than an option, because it is a prompt change
  outside this survey's question.

## 10. The case against

1. **The target is small here.** 2.0% of run weight for what it may safely
   replace; the main-loop route is unmeasured.
2. **The jobs runs delegate are too big for the model that would take them.**
   Median read-only peak 75,672 tokens against a 64K window; minutes per call.
3. **The quality it relies on is one study deep for search.** Localisation is
   "promising, one study, a task-tuned 7B on a rented GPU" (*Scrouting*,
   `preprint`, via *Local Model Quality by Agent Task*); nothing measures a stock
   4-bit local model searching a repository for a frontier caller.
4. **It creates a new containment surface.** A root process reading files an
   agent can swap; a new rule to get right (§3).
5. **It makes runs slower** by a minute or several per call, serialised across
   the fleet, and the saving it buys is list-price weight on a subscription that
   is already paid for.
6. **Its reach is unverified** (U1).
7. **It is about 1,300 lines, tests included, and 9–11 days** to build properly
   ([`10-implementation-sketch.md`](10-implementation-sketch.md)), against an
   operator-side trial that costs an afternoon and answers the question that
   decides whether to build it.

## Verdict

The strongest candidate for local offload **in shape**: read-only, in-app,
minimal loop, one queue, fast refusal. Not yet worth building **in
substance**: its measured target in this install is 2% of run weight, its
larger target is a hypothesis, and the one experiment that would settle both
costs no app code. Run [`11-validation.md`](11-validation.md) through the
operator's own MCP config first; build the in-app version if the numbers there
clear the bar in [`09-recommendation.md`](09-recommendation.md).
