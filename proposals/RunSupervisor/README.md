# RunSupervisor

**Recommendation: build no supervising model. Make the one question runs do ask,
the `NEEDS_REVIEW` ending, cheap to answer to the run that asked (Option B).** Put
an answer box under the reason on the run page, and give back the cycle the run
ended on, at most three times per run on a count nothing resets. That is the
stack park's refund, applied to the ending this app already teaches. There is no
model, no new status and no new tool. The case is in
[`11-recommendation.md`](11-recommendation.md).

**What would overturn it:** after B ships, **three or more questions in four
weeks that a read-only model could have answered** from something the asking run
had not read, two of them not traceable to one recurring cause that a sentence in
`CLAUDE.md` would fix. Then build Option D, the tool-less tiered supervisor, as
specified. [`13-validation.md`](13-validation.md) §3 fixes how it is counted.

**Runner-up: Option A, build nothing.** B rests on an unmeasured premise, that the
operator would answer through the box: zero pick-up notes in the window. If the
first five decision-shaped endings after it ships are answered by fresh runs
instead, revert it, and A is the answer.

**Scope**, decided in [`01-constraints.md`](01-constraints.md) Part 0:

- This survey is the vertical channel: a run up to a party acting for the operator
  on that run's own task, and back down to the same run.
- Peer messaging is [CrossSessionCommunication](../CrossSessionCommunication/README.md)'s,
  and is not reopened. The line is the reader: if any other run reads what the
  asker wrote, even through a supervisor's answer, it is peer.
- `CLAUDE_CODE_HARBOR_KITE=0` (G1) stays.
- The orchestrator chat is in scope as a party, and CrossSessionCommunication's
  three reasons for excluding it are met rather than stepped around (C9).

A survey that ends in one recommendation, not a plan. Nothing under `src/`,
`docs/` or the Dockerfile was changed.

---

## The finding that shapes everything

**The questions runs raise are the operator's, and a model on the other end would
have had three things to say in a month.** 494 runs, 2026-10-01 to 2026-10-27,
from transcripts, because the database is unreadable from a work cycle
([`00-problem.md`](00-problem.md)):

| Kind of traffic | Measured | A model could have answered | Only the operator |
|---|---|---:|---:|
| (a) Only a human could answer: `NEEDS_REVIEW`, `release_task`, `operatorOnly` and decision tasks | 74 runs (15.0%): 60 physical (a Mac, a host shell, root), 13 decisions, 1 both | **0** | all |
| (b) Help with an error | `tsc: not found` 22 runs, solved in a median of 1 message; memory-directory refusals 18; the other four `CLAUDE.md` traps 0 for real | **3** | 0 |
| (c) About its own task: already done, or the brief wrong | 18 genuine of 34 hits, settled by reading | 0 | 3 |
| (c) …judgement calls in reports | 84 hits; sample of 25: 19 routine, 2 the operator's | 0 | 2 |
| (d) Before a destructive step | 2 genuine stops, both handled alone. **Dropped as a kind** | 0 | 0 |
| `request_stack`, operator pick-up notes | **0**, **0** | — | — |
| The chat's `ask_operator`, for comparison | 3 calls in 142 operator turns, all the operator's | 0 | 3 |

The three model-answerable questions share one cause, a shell redirect into a
directory only the Write tool can reach, which the operator's own memory note
already explains. The decisions already travel by the board, and are answered to
a **fresh** run that re-derives what the asker had read. The pick-up route that
would answer the asker is unused, and on a one-cycle run it cannot be taken
without editing the budget first. That friction is the whole of what B removes.

**The caveat.** 268 of 494 briefs tell the run that nobody will answer. The
figures are a lower bound on what runs would ask if asking were offered. Read the
falsifier only over briefs that no longer say it.

## What can reach a live cycle at all

Item 7 of the brief, settled with the pinned CLI 2.1.310 against loopback stubs,
nothing billed ([`02-what-already-asks.md`](02-what-already-asks.md) §7):

- **An MCP tool call can wait minutes, but not through the app's route as it is
  configured today.**
  - A plain-JSON reply, which is what `/api/mcp` sends, **fails at 60.0 s**:
    `The operation timed out.`
  - An SSE reply survives up to the 300 s idle limit, and longer with
    `notifications/progress`.
  - A per-server `"timeout"` in the `--mcp-config` entry raises both limits
    (`"timeout": 900000` let a 540 s JSON call through).
  - The CLI prints a `tool_progress` heartbeat every 30 s while it waits, so the
    silence watchdog never fires.
  - Codex waits 300 s wall clock.
- **`--input-format stream-json` delivers a message into a live turn, but only at
  the next model request.** It cannot release a pending tool call. `total_cost_usd`
  becomes cumulative per `result`, the positional prompt is ignored, and the
  process lives until stdin closes. It is a new cycle model, not a transport.

So a model's answer can ride a blocking call under 60 s with no change to the
route. A person's answer cannot ride anything live, because it takes hours. It
has to be ask-and-end or ask-and-park.

## The options at a glance

| | Who answers | Transport | Wakes or extends (C1) | Widens a guard (C2) | Hub or upward injection (C6) | Traffic it serves | Build |
|---|---|---|---|---|---|---|---|
| **A** nothing | operator, board | ask-and-end, fresh run | no | no | no | all, to a cold run | 0 |
| **B** answer the ending | operator, run page | ask-and-end, same run | operator's press only, ≤ 3 | no | no | 4 decision endings, to the asker | ½–1 d |
| **C** ask and park | operator | park at cycle end | operator's press only, ≤ 3 | no | no | the same 4, slot kept | 2–3 d |
| **D** tiered supervisor | server → tool-less model → operator | blocking call, < 60 s | no | no; gated by kind | stateless, tool-less | 3 | 3–4 d |
| **E** the spawner | fork of the proposing chat | as D | no | no | the chat's context | 0; chat runs only | +2–3 d |
| **F** native messaging | whoever is live | CLI inbox | **yes** | **yes** | **yes** | 0; no live spawner | ~0 |
| **G** live turn | operator, or a model posing as one | stdin | **yes**, past `result` | no | operator's framing | 0 | 3–5 d |

## The files

| | |
|---|---|
| [`00-problem.md`](00-problem.md) | The question, the line against CrossSessionCommunication and the other neighbours, and the need measured per kind of traffic. |
| [`01-constraints.md`](01-constraints.md) | Scope. Eleven constraints: the authority line (C2), injection both ways with the supervisor as hub (C6), spend with nobody present (C7), the chat's privilege met (C9), asking too much and too little (C10). Five unknowns. |
| [`02-what-already-asks.md`](02-what-already-asks.md) | Every way a run reaches somebody today, verified. What carries over from the stack park and what was specific to stacks. The two transport facts, measured. |
| [`03-option-a-build-nothing.md`](03-option-a-build-nothing.md) | **A**: the board already carries the decisions. **Runner-up.** |
| [`04-option-b-answer-the-ending.md`](04-option-b-answer-the-ending.md) | **B**: an answer box and a bounded refund on `needs-review`. **Recommended.** |
| [`05-option-c-ask-and-park.md`](05-option-c-ask-and-park.md) | **C**: `ask_operator` for runs and a `waiting-for-answer` park. Specified; not now. |
| [`06-option-d-tiered-supervisor.md`](06-option-d-tiered-supervisor.md) | **D**: server gate, then a tool-less stateless model inside a blocking call, then the operator. What the overturning fact builds. |
| [`07-option-e-the-spawner-answers.md`](07-option-e-the-spawner-answers.md) | **E**: a de-privileged fork of the proposing chat; the block cannot be reached. Rejected; its input is kept as a part of D. |
| [`08-option-f-native-messaging.md`](08-option-f-native-messaging.md) | **F**: turn `HARBOR_KITE` back on. Rejected against G1's four reasons. |
| [`09-option-g-live-turn.md`](09-option-g-live-turn.md) | **G**: answers through the CLI's stdin. Rejected as an answer channel. |
| [`10-comparison.md`](10-comparison.md) | The facts side by side, why C1, C2 and C6 are vetoes, and what dominates what. |
| [`11-recommendation.md`](11-recommendation.md) | The case, the order, the refusals by name, the overturning fact, the runner-up, and what to build if overruled. |
| [`12-implementation-sketch.md`](12-implementation-sketch.md) | Phase 1 (B) as one commit with its two traps, Phase 2 the readout, and Phases 3 (D) and 4 (C), each gated. |
| [`13-validation.md`](13-validation.md) | Test B by hand on the next decision, test D offline before building it, every threshold fixed in advance, and what was and was not verified. |
| [`scripts/`](scripts/) | `scripts/measure-all.sh` rebuilds every traffic figure from transcripts in about 12 s; `rules.txt` and `labels/` hold the classification. `scripts/mcp-wait-probe.sh`, `scripts/live-turn-probe.sh` and `scripts/codex-mcp-timeout-probe.sh` drive the real CLIs against loopback stubs. `scripts/readout.sql` is the operator's monthly count. `scripts/check-citations.mjs` checks every `path:line`. |

## Reused, not redone

- **CrossSessionCommunication.** Its corpus keying (`scripts/index_sessions.py`)
  and exclusions, its C8 injection rules (extended here into C6 with the hub), its
  measurement of the CLI's native channel, and G1's reasons, which
  [F](08-option-f-native-messaging.md) is weighed against. Board task `dd0c0b1d`'s
  comment records G1 as measured: with `CLAUDE_CODE_HARBOR_KITE=0`, `ListAgents`
  is gone and "`[uds-messaging] Skipped: cross-session messaging gate off`".
- **ContinuousImprovement**, for the cost of a fresh run re-deriving context
  (73.2% of `Read` calls on files an earlier run had read), which is B's case
  against A.
- **The archived Operator Questions and Orchestrator Chat Quality surveys** (vault,
  `confidence: low` and `medium`, `status: archived`), for the chat's question
  design and its near-silence. They predict that a deferred run tool would be
  found as rarely.
- **The archived Unattended Operation survey** (`confidence: low`, `status:
  archived`) and `SHIPPED-UnattendedOperation.md`, for the webhook, inherited
  unchanged with its content-free body.
- **The vault.** *Ask or Assume (Edwards and Schuster 2026)*, *UnderSpecBench (Ji
  et al 2026)*, *Habituation at the Gate (Yu et al 2026)*, *Prompt Infection (Lee
  and Tiwari 2024)*, *Orchestration Topologies* and *Sub-Agent Architectures*,
  each `confidence: medium`, `status: growing`.
- **LocalModelOffload**, whose reading of the 2.1.280 binary's 300 s idle limit
  this survey measured on 2.1.310, adding the 60 s plain-JSON limit it did not
  name. Its own sketch already carries a per-server `"timeout"`
  (`proposals/LocalModelOffload/10-implementation-sketch.md:152`), so it is
  unaffected.

## Found on the way, filed rather than fixed

- **The completion validator reads a task already fixed on main as not-finished,
  so the run that found it done cannot close it** (low). Filed as board task
  `17be140e`. A Dockrac run held a task whose fix had reached main through another
  run. Its branch diff was empty, the check refused the close, and the run
  released it operator-only. `src/lib/validation.ts:319`-`:327` treats an empty
  diff on a task that "plainly required a change" as not-finished, which cannot
  tell "already done" from "did nothing".

## Checked

`node scripts/check-citations.mjs` resolves every `path:line` in this directory
against the tree at the commit that adds this README. The key ones were also read
back for what they are cited for. [`13-validation.md`](13-validation.md) §4 lists
what was measured and what was not.
