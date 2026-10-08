# KnowledgeManager

**Should this app run a "Knowledge Manager" — an agent on Claude Haiku 5.5
that does routine housekeeping in the knowledge vault because it is cheap and
fast — and if so, which jobs, in what form, with what write safety, at what
cost, and how would we know Haiku 5.5 is good enough?** Six options, from
"build nothing" to a separate in-app feature, each given its strongest honest
case; the recommended one gets the implementation sketch and a spike that can
sink it.

A survey that ends in one recommendation, not a plan. Read
[`00-problem.md`](00-problem.md) first: its measurement corrects the premise the
brief was written on.

---

## The finding that shapes everything

**The vault's backlog is mostly research debt, not housekeeping.** `qc.py`
reports `1670 notes checked — 7 errors, 411 warnings.`, and broken down by
family and class ([`00-problem.md`](00-problem.md) §3,
[`scripts/backlog-classes.py`](scripts/backlog-classes.py)):

- **5 findings are Haiku-suitable** (keyword fixes) and **9 mechanical** (one
  keyword's case; eight notes whose cited URLs already have a source note, so a
  wikilink clears them).
- **85 are Haiku-sized only if the operator asks** — Related lists over eight
  links on ordinary notes, which the rulebook's 3–8 range covers and the vault
  calls a judgement call.
- **155 are WARNs the vault keeps by policy** — hubs over eight Related links,
  source notes without a quote block.
- **153 are research debt** — source notes not yet written, one confidence
  grade — which needs a frontier model reading sources.
- **Six of the seven ERRORs are two Inbox captures**, and every Inbox outcome is
  a move or a delete, which a manager may draft but not do.

**The board agrees.** Of fourteen open vault tasks, **one** is mechanical,
**three** are Haiku-class, **eight** need a frontier model and **two** the
operator (§4). All three Haiku-class tasks were filed by Dreaming nights, and
two of them are upkeep of the hub notes Dreaming itself grows.

**Money is not the argument.** The one past housekeeping session that fixed
eleven qc ERRORs cost $3.54 on Opus 5; its tokens re-priced on Haiku 5.5 cost
**$0.07**, and on Opus 5.5 $2.13. A weekly Haiku pass is **$0.30–1.52 a
month**, and a few dollars more if the 85 trims are wanted. All vault sessions
since 2026-09-01 cost $514.61 at list price, of which
housekeeping was **$3.75** ([`08-comparison.md`](08-comparison.md) §4). The
"$15–$38 per vault run" in the brief is true of research runs, not of
housekeeping or Dreaming.

Three more findings narrow it further:

- **The store has no undo, and a run in it gets none of the app's.** No git, no
  trash, no backup; no diff, review, land or validation for a run in a non-git
  folder; nothing but the prompt bounding where it writes
  ([`01-constraints.md`](01-constraints.md) C1–C2).
- **Haiku's 100,000-token price cliff is reached by reading, not by working.**
  Every vault session's first request was already 32k–47k tokens; a median note
  plus the notes it links to is 93.7k, the two MOCs are 82.8k and 77.8k alone;
  65.4% of all vault requests to date were over 100k. A note plus its links'
  *abstracts* is 2.5k at the median and 14.6k at p99 (C3).
- **The pinned CLI does not know `claude-haiku-5-5`.** It is off in the
  catalogue for that reason, the CLI prints `unrecognized_model` for it, and the
  app records a run's spend from the CLI's own figure — so whether a Haiku run
  works, and what it says it cost, is unmeasured (C4, U1).

## Recommendation, in one line

**Build no Knowledge Manager feature in the app. Make Dreaming keep its own
hubs current now; run the spike on a copy of the vault; and if Haiku 5.5 passes,
ship a vault-side `_Meta/housekeeping.py` written once by a frontier run,
driven by a Haiku-pinned template that a one-block workflow runs weekly and the
operator runs on demand.** [`09-recommendation.md`](09-recommendation.md) has
the case, the refusals, and the one fact that would overturn it: a single Haiku
edit, in the spike, that changes or misstates a claim.

## The files

| | |
|---|---|
| [`00-problem.md`](00-problem.md) | The question; which vault and what kind of store; the qc.py backlog by family; the fourteen board tasks classified; the scope split; what this does to the premise. |
| [`01-constraints.md`](01-constraints.md) | Twelve constraints — no undo, nothing bounding writes, the price cliff, the CLI and the catalogue, Dreaming's ledger and clock, turn-taking, the primitives, `needsFrontier`, board access, the app's no-write rule, the vault's rules, concurrency — and seven unknowns with the command that settles each. |
| [`02-option-a-existing-primitives.md`](02-option-a-existing-primitives.md) | **A** — a Haiku template, a one-block workflow, a schedule. No code; no gate and no undo. |
| [`03-option-b-third-half-of-dreaming.md`](03-option-b-third-half-of-dreaming.md) | **B** — upkeep as Dreaming's third half. Where the debt is made, and the wrong ledger to put it in. |
| [`04-option-c-separate-feature.md`](04-option-c-separate-feature.md) | **C** — its own clock, ledger and pane. The only model-independent changeset; sized for a backlog that is not there. |
| [`05-option-d-scripts-then-haiku.md`](05-option-d-scripts-then-haiku.md) | **D** — `housekeeping.py` for planning, mechanical fixes, snapshot, verify and revert; Haiku only for judgement. |
| [`06-option-e-local-model.md`](06-option-e-local-model.md) | **E** — the local provider instead of Haiku. Cents saved; review gate lost. |
| [`07-option-f-no-debt-at-source.md`](07-option-f-no-debt-at-source.md) | **F** — no manager: Dreaming keeps its hubs current, the operator settles the Inbox, the stock is cleared once. |
| [`08-comparison.md`](08-comparison.md) | The options side by side; the trigger; write safety, including the measured edit cap and the never-list; the cost arithmetic. |
| [`09-recommendation.md`](09-recommendation.md) | The case, the shape to build, the refusals, and the fact that would overturn it. |
| [`10-implementation-sketch.md`](10-implementation-sketch.md) | `housekeeping.py`'s verbs and checks, the template's prompt, what the operator creates, the app's few lines, the board, Option F's change, the tests. |
| [`11-validation.md`](11-validation.md) | Three checks, then the spike — nine sessions from the corpus on a git copy of the vault, Haiku against Opus 5.5, scored by diff, qc and a blind frontier reviewer — and the result that sinks the plan. **Not run.** |
| [`scripts/backlog-classes.py`](scripts/backlog-classes.py) | qc.py's 418 findings by family and by class, running qc's own checks in-process; read-only. |
| [`scripts/session-budget.py`](scripts/session-budget.py) | Note sizes, link fan-out and what one session must hold, using the vault's own `vaultlib`; read-only. |
| [`scripts/vault-cost.mjs`](scripts/vault-cost.mjs) | Per-session list-price cost of vault sessions, and the same tokens on Haiku 5.5, priced by importing `src/lib/pricing.ts`. |
| [`scripts/check-citations.mjs`](scripts/check-citations.mjs) | Resolves every repo and vault path and line number in this directory; copied from LocalModelOffload's. |

## The options at a glance

| | deterministic part | undo | collides with Dreaming | build | per pass | verdict |
|---|---|---|---|---|---|---|
| **A** primitives only | the model | none | no | none | $0.01–0.35 | the trial's shell |
| **B** third half of Dreaming | the model | none | **yes** | ~1–2 d | as A, on nights Dreaming writes | no |
| **C** separate feature | a model run | app changeset the session cannot reach; no restore | no | ~4–6 d | as A | not now |
| **D** scripts, then Haiku | `housekeeping.py` | pre-images + `revert` | no | one vault frontier run + a few app lines | as A | **recommended** |
| **E** local model | as D | none | no | as D | $0 | no |
| **F** no debt at source | — | — | edits its prompt | a paragraph | under a cent, on Opus | **do regardless** |

## Reused, not redone

- **Dreaming** settled that a vault writer is a run, never an assist, never
  isolated, under `bypassPermissions`, with a spend limit that cannot be "no
  limit", one agent in the vault at a time, and an app that never deletes from
  the mount (`docs/agent/dreaming/the-writer.md`,
  `docs/agent/dreaming/the-clock.md`, and `git show
  a74a1bb:"proposals/implemented - Dreaming/"`). Option D inherits all of it;
  Option B is refused because its ledger is keyed on error signatures.
- **LocalModelOffload**'s task-class rubric (summarise and extract near parity;
  edits behind; judging and planning stay on Claude) shapes the scope split and
  Option E, and its refusal of a weaker model as a completion judge is repeated
  here (`proposals/LocalModelOffload/00-problem.md:154`–`:172`,
  `proposals/LocalModelOffload/09-recommendation.md:69`–`:70`).
- **ModelRouter**, deleted by `fab9fb5e`, recorded that no cheaper model was
  ever measured on this install's tasks, that every cheaper-model saving is a
  fixed-token counterfactual, and that `maxIterations` 1 denies a cheap model a
  second cycle; the spike is the measurement it asked for, and the third point
  is used here on purpose. Its "build no router" was since overruled by the
  model decider (`src/lib/modelDecider.ts:16`–`:23`), which a pinned template
  bypasses.
- **ContinuousImprovement**'s refusal of an automatic, billed, model-written
  store and its measurement that naming an exact command is what gets complied
  with shape Option F and the template's prompt.
- **KnowledgeSection**'s rule that the app adds no write path to `/knowledge`
  stands; nothing here adds a Fix button (C10).

## Found on the way, filed rather than fixed

**In this app** — five tasks filed on the board against
`/workspace/UsageFoundry`, none part of this survey:

- `d2f13e1f` — `propose_run` passes no `localRun` to `readTaskLinks`
  (`src/app/api/mcp/route.ts:5720`–`:5724`), so a chat can put a local run on a
  needs-frontier task the docs say it refuses.
- `f4a062ed` — `workflows.ts` never calls `modelRefusal`, so a template's
  switched-off model runs from a workflow or schedule.
- `4833ed4e` — a review of a Haiku run is run on Haiku and called a frontier
  review, and sets the needs-frontier mark.
- `7fd2d06b` — Dreaming's `parseNoteLines` keeps the last `NOTE` line per item
  (`src/lib/dreamingRun.ts:230`), so the ledger's `note_path` mostly names
  hubs rather than the note Dreaming wrote (inferred from transcripts).
- `61ae21f1` — doc drift: the Dreaming cursor described as a night key; "the
  nightly timer has never fired" though transcripts show it firing at 03:04
  since 2026-09-09; a `failed` night outcome that a failed run never writes; a
  stale `schedules.ts` line reference; `docs/workflows.md` missing the review
  block; this index's rows for ModelRouter and KnowledgeSection pointing at
  directories that no longer exist; LocalModelOffload's `proposals/LocalModelOffload/scripts/window-share.mjs`
  pricing Haiku 5.5 at Haiku 4.5's rate.

**In the vault** — not filed: a run files tasks against its own folder, and
these belong to `/workspace2`. Each for the operator or a vault run:

- **qc.py has no Inbox exemption**, so every untriaged capture is three ERRORs
  and qc exits 1 until triage; `SEED/parent` also fires on captures, which
  carry `captured_from`.
- **A `#` inside a flow list silently truncates it**: `val.split(" #")`
  (`/workspace2/_Meta/qc.py:73`, `/workspace2/_Meta/vaultlib.py:77`) reads
  `aliases: [UAX #15, …]` as `[UAX`, on three Unicode source notes, and the
  index's vocabulary now carries the term `[UAX`.
- **`CONF/ungraded` says "no source note" for 22 URLs that have one**, merely
  unlinked from the citing note (`scripts/backlog-classes.py`).
- **`_Meta/Vault Quality Control.md` lists `KW/*` as WARN**, while `KW/case`
  is an ERROR in the code.
- **Stale costs and counts in the files agents read first**: `/workspace2/CLAUDE.md:256`
  puts `INDEX.md` at ~130k estimated tokens and `_Meta/index/README.md` tells
  its readers ~110k (hard-coded at `/workspace2/_Meta/build_index.py:211`),
  against ~950k in `INDEX.md`'s own header; `AGENTS.md` says 1,083 notes and 21
  domains (1,670 and 24 today) and a search at ~400 tokens and 0.25 s (one
  `python3 -B _Meta/vault_search.py` query, timed in this survey, returned
  ~3,050 bytes — ~760 estimated tokens — in 2.23 s); `Questions Inbox.md` says
  two captures await triage (`ls "/workspace2/3 Resources/Questions/Inbox/"`
  shows four, beside the index note and the template).
- **Non-vault files at the vault root**: `uf-c3-base/` (a `.next` and `src`
  copy, 2026-09-08) and `throughput.pid` (2026-09-06). Inside this work cycle's
  sandbox the root also shows a `.claude/` of empty entries and a `.mcp.json`
  that is a character device — **assumed** to be sandbox mount points that
  exist only inside a sandboxed process's view; nobody has looked from the Mac.
- **Two corpus tasks carry stale facts**: `a3bfd638` puts
  `Local Offload Economics.md` under the wrong folder, and `c3d149b8` says
  nineteen batches where the note now has 23.

## What this survey did not do

It wrote nothing in `/workspace2` — every vault command ran read-only with
bytecode writing off, and the one archive of the vault's notes went to this
cycle's own temp directory. It did not work, claim, comment on or close any of
the fourteen board tasks. It did not run the spike: this work cycle has no
Claude credentials (C4).
