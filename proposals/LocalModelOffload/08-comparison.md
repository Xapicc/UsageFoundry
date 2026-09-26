# 08 — Comparison

## 1. The facts, side by side

| | A — cheaper Claude sub-agents | B — one-shot local tool | C — local agent MCP | D — local-provider run | E — gateway | F — app-internal calls |
|---|---|---|---|---|---|---|
| **What it moves** | delegated turns | one read or log, by the main loop's choice | a read-only exploration job | a whole run | sub-agents by name or tier | review, at most |
| **Target share, measured here** | 8.0% (4.4% movable by the env var) | main-loop read steps 42.6%, about half of it prefix re-reads it does not remove | **2.0%** safely; the main-loop route unmeasured | the run: 92%+ | 8.0%, not separable into read-only | unmeasured; the chat, for scale, is ~1% of runs |
| **Task class on the vault's evidence** | Sonnet/Opus 0.90 | summarising: parity or better | search: one study; multi-step: ~0.5 | multi-step: ~0.5 | multi-step: ~0.5 | review: parity; the rest no |
| **Wall clock per call, Max-class Mac** | none | 10–93 s | 26–216 s alone, multiples of that queued across runs | an hour or more per cycle (D1) | per sub-agent, Claude-sized prompt | 17–164 s per review (`scripts/latency.mjs`, a 60 KB diff at an assumed 4 bytes a token) |
| **Fits a 64K local window** | n/a | yes | only if the job is sized for it (§2 of C) | D1: prompt alone 12k–70k | median delegated job does not | yes |
| **New containment surface** | none | one app-read path | app-read paths an agent can swap | the whole run | a proxy on all traffic | one diff |
| **Credential exposure** | none | none | none in shape (i) | D1: the OAuth trap | token relaying, terms open | none |
| **Needs host reach from** | — | the app | the app | the child | the child, via the gateway | the app |
| **Collides with winnow's `ANTHROPIC_BASE_URL`** | no | no | no | D1 yes | yes | no |
| **App code** | none | ~4–5 days (phase 1 of C) | ~1,300 lines, ~9–11 days | 2–6 days | 5–8 days | ~2 days |
| **Saving evidence** | a benchmark ratio and a fixed-token counterfactual | Minions, on documents; coding unmeasured | a frontier-side model; the vault's seed open | the vault says do not | the vault says not now | none |
| **Operator-side trial with no app code** | yes: one compose line | **yes**: own MCP config reaches runs | yes, same route, reduced (§4 of C) | no | no | no |

Sources: [`00-problem.md`](00-problem.md) §1–§2 for the shares and the inventory,
[`scripts/latency.mjs`](scripts/latency.mjs) for the clock,
[`scripts/delegation-cost.mjs`](scripts/delegation-cost.mjs) for C's frontier
side, and each option's own file for the rest.

## 2. Why there is no weighted score here

ProviderFallback scored its options (`proposals/ProviderFallback/scripts/score.mjs`)
because its deciding quantities were known: what parking costs, which guards
survive, what a Codex cycle reports. Here the two quantities that decide
B and C — the local pass rate on *this install's* read jobs, and whether the
frontier model edits as well after reading an extract — are exactly the ones
the vault marks open (*Does a Local Tool-Output Summariser Save Frontier Usage
in a Coding Agent*; *Does a Local Sub-Agent Cost the Main Loop More Than It
Saves*; both `status: seed`, `confidence: low`). A weighted total would encode
this survey's guesses about them and present the result as arithmetic. The
table is the comparison; [`11-validation.md`](11-validation.md) is how the
missing rows get measured.

## 3. What dominates what

- **A dominates E**: the same target, cache-neutral, no proxy, no terms
  question, a 0.90 pass-rate ratio against 0.5.
- **B is C's first phase**: the same delivery, client, containment, queue and
  run-log rows, without the loop. Anything learned building B is reused by C,
  and C's extra risk (a multi-step local decision, a larger read surface) is
  only worth taking if B's measurement shows the frontier model uses local
  output well.
- **D and F are out on size and on task class**, independently of each other.
- **Everything composes with A.**

## 4. A finding outside the question

C's frontier-side saving (§1 of its file) comes from **fewer main-loop turns**:
six single-read turns each re-read a ~116k-token prefix; one delegated call
re-reads it once. Runs already have a free way to part of that: issue
independent reads in one turn. They rarely do — 2,967 of 54,049 tool-using
main-loop turns (5.5%) carried more than one read (`scripts/window-share.mjs`,
2026-09-26). A prompt line asking a run to batch independent reads targets the
same turns with no local model, no latency and no loss of fidelity. It cannot
replace a sequential exploration, which is what C's loop is for. It is not an
option in this survey — it is a prompt change to the appended system prompt
(`DELEGATION_NOTICE`'s neighbourhood, `src/lib/cycleInvocation.ts:840`), and
its rule about literals would apply (`docs/agent/security.md:22`) — but anyone
measuring C should measure the batching rate beside it, because a rise in one
would be credited to the other.
