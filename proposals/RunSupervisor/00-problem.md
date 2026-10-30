# 00: The problem, and how much of it this install has

## The question

The operator's idea, in their words: "methods of letting runs talk to an
orchestrator that can do things like answer their question they might have for a
human, help with errors, ask about their task and so on". Claude Code's own
cross-session messaging, in which an agent can talk to the session that spawned
it, is what prompted it.

> While a run is working, should it be able to reach a supervising party: a model
> that answers on the operator's behalf where it can and hands the question to
> the operator where it cannot? What would that channel be, who sits on the other
> end, what may that party say and never say, and what does it cost?

**Terms.**

- A **run** is a sequence of `claude -p` work cycles
  (`src/lib/cycleInvocation.ts:1599`-`:1605`).
- **While it is working** means between the first cycle's spawn and the run's
  ending, parks included.
- A **supervising party** is anything on the other end that is not the run:
  - the operator;
  - the chat conversation that proposed the run;
  - the workflow block that emitted it;
  - a new model.

## Where the line is against the neighbouring surveys

**[CrossSessionCommunication](../CrossSessionCommunication/README.md) is side to
side; this survey is up and down.**

- That one asked whether *sibling runs* should send each other text, and answered
  "see, not talk". It put the chat out of scope as a party.
- This one asks whether a run should send text **up** to a party acting for the
  operator on that run's own task, and receive a reply **down**, to itself only.
- The line falls at the reader. If any run other than the asker reads what the
  asker wrote, even through a supervisor's answer, it is peer messaging.
  [`01-constraints.md`](01-constraints.md) C6 turns that into the first rule
  every option here is held to: a supervisor keeps no state between questions.
- Peer messaging is not reopened. The CLI's native channel stays closed by
  `CLAUDE_CODE_HARBOR_KITE=0` (`src/lib/orchestrator.ts:7816`). The one option
  that would reopen it is [F](08-option-f-native-messaging.md), and it is weighed
  against that decision's reasons.

**The other neighbours.**

- **[ContinuousImprovement](../ContinuousImprovement/README.md)** is about across
  time, from a finished run to a later one. A supervisor that told a run "an
  earlier run found X" would be that survey's pointer delivered on request; its
  measurements are cited rather than repeated.
- **The archived Operator Questions survey** built `ask_operator` for the chat.
  It is the same problem one level up, and its history is evidence
  ([`02-what-already-asks.md`](02-what-already-asks.md) §3).
- **The archived Unattended Operation survey** built the webhook. Any question
  that must reach an absent operator inherits that as it is.

**"The session that spawned it" is a real party for one origin out of five.**
[`02-what-already-asks.md`](02-what-already-asks.md) §6 has the detail.

- A chat proposal's run carries a proposal id whose chat session can be resumed.
- A workflow block's run cannot reach the block: its turn ended before the run
  existed, and nothing resumes it.
- A form or schedule run was spawned by no model at all.
- No spawner is ever live while its run works. Reaching one is always a new,
  billed turn.

## 1. How it was measured

The database is unreadable from a work cycle (`/data` is denied to this sandbox),
which is what [CrossSessionCommunication](../CrossSessionCommunication/00-problem.md)
§1 found too. So the corpus is session transcripts under
`/home/node/.claude/projects/`, keyed the way its `scripts/index_sessions.py`
keys them.

- **Population.** 494 runs from 2026-10-01 to 2026-10-27: 483 isolated runs
  keyed by their `uf/…` branch and 11 unisolated. By repository: UsageFoundry 272,
  Dockrac 190, auto-upload 23, four others 9. They made 656 prompt cycles; 346
  runs had one.
- **Excluded.** Validator (664), resolver (56), reviewer, chat (92 sessions),
  dispatcher, vault-gate (231), vault-folder and Mac sessions, every sub-agent,
  this run, and anything begun on or after 2026-10-30.
- **Not in it.** No transcript before 2026-10-01 survives. Codex and local runs
  leave none here. `runs.follow_up` and true statuses are in the database only.
- **Classification.** The rules were written before they were applied, in
  [`scripts/rules.txt`](scripts/rules.txt). Each instance is labelled with its
  evidence in [`scripts/labels/`](scripts/labels/).
  - **MODEL-ANSWERABLE**: a supervisor with read access to the repository, the
    board, earlier runs' transcripts and the vault could have answered it from
    what was there at the time.
  - **OPERATOR-ONLY**: it needs a decision, preference, credential, physical
    action or permission only the operator holds.
  - **NOT A QUESTION**: the run handled it itself and asking would have been
    waste.
- **Reproduce.** `sh scripts/measure-all.sh <out-dir>`, about 12 seconds,
  deterministic. It was re-run independently for this file and gave identical
  figures.

**One confound runs through every figure.** 268 of the 494 opening prompts tell
the run that nobody will answer a question or that it runs unattended, and 188
tell it to write its judgement calls into the final message. The figures below
are therefore **a lower bound** on what runs would ask if asking were offered.
The upper bound is what their reports say they decided alone, and that is kind 4.

## 2. The traffic, kind by kind

| Kind | Measured | MODEL-ANSWERABLE | OPERATOR-ONLY | NOT A QUESTION |
|---|---|---:|---:|---:|
| **(a) Only a human could answer**: `NEEDS_REVIEW` endings | 7 in 7 runs (1.4% of runs) | 0 | 6 | 1 |
| …the same, handed over as `release_task` | 13 in 13 runs (4 also ended `NEEDS_REVIEW`) | 0 | 13 | 0 |
| …the same, filed as an `operatorOnly` task | 58 calls in 56 runs (of 668 `create_task`) | — | 58 | — |
| …or as a task that hands a decision over in words | 6 | — | 6 | — |
| **(b) Help with an error**: a known trap hit for real | `tsc: not found` 22 runs; memory directory not writable from Bash 18; nested `claude` "Not logged in" 1; the other four `CLAUDE.md` traps **0** | 3 | 0 | 38 |
| **(c) About its own task**: report says already done, or the brief was wrong | 34 keyword hits, 18 genuine | 0 | 3 | 15 |
| …final reports listing judgement calls or assumptions | 84 keyword hits; seeded sample of 25 | 0 | 2 | 19 (4 false positives) |
| **(d) A check before a destructive step** | 68 keyword hits; 2 genuine stops, both handled | 0 | 2 deferrals, not destructive | 4 |
| `request_stack` calls | **0** | — | — | — |
| Operator pick-up notes (an answer to an unasked question) | **0** | — | — | — |

Scripts, in [`scripts/`](scripts/): `needs_review.py` (all (a) rows),
`known_errors.py`, `already_done.py`, `final_reports.py`, `destructive_stops.py`,
`request_stack.py`, `follow_ups.py`. `summary.py` prints the table.

**What the rows mean.**

1. **74 of 494 runs (15.0%) handed something to the operator** by any of the
   four routes in (a). By hand: **60 physical** (a Mac, a host shell, root, a
   booted guest), **13 decisions**, 1 both. The decisions are things like
   - "Security-posture decision among five options with costs … that the task
     itself reserves for the operator";
   - "Add `cap_add: [SYS_PTRACE]` to `docker-compose.yml` … a deployment
     decision";
   - "This is a decision, so I did not make it".

   **No item in (a) was answerable by anything but the operator.** That is the
   instance most of the operator's idea is about, and a model on the other end has
   nothing to say to any of it.
2. **Errors (b) were solved by the runs themselves, fast.** `tsc: not found`, the
   `NODE_ENV=production` trap `CLAUDE.md` names first, cost a median of one
   assistant message and at most three; 13 of the 22 briefs already named it.
   - The four other traps never fired for real. Every hit on their strings was a
     run *reading* `CLAUDE.md` or a memory note that quotes them, which is the
     traps' documentation working.
   - The 3 MODEL-ANSWERABLE cases are runs that tried to write a memory note with
     a shell redirect, were refused because the directory is Write-tool only, and
     ran out of turns. A supervisor could have said so. So does the operator's
     own memory note `uf-bash-call-pid-netns.md`: "This memory directory is
     read-only to Bash; write it with the Write tool." A cycle's sandbox
     configuration lists `/home/node/.claude/projects` among the paths it denies
     for writing.
3. **Task questions (c) were settled by reading.** For example:
   - "the fix was already on main in 6181a6d";
   - "One part of the brief was wrong. `next build` does not fail without the
     Suspense boundary";
   - a run that "ran the real CLI" to show the brief's description of a failure
     was wrong.

   The three OPERATOR-ONLY cases are the (a) items again, met from the other
   side. The judgement calls in reports are "almost always a routine, reversible
   choice". **Only 1 of 494 final reports contains a question mark outside code**,
   and it is a table header.
4. **Destructive steps (d) are not a kind on this evidence.** The two genuine
   stops were "I'm reading it before deleting it" and "I couldn't tell whether
   they were mine, so I didn't delete them". Both are a run being careful on its
   own, and neither needed an answer. The 71 "did not push" hits are runs obeying
   the 305 briefs that say so. **The kind is dropped.**
5. **The stack park has never been used** in this window, on an install where
   `taskboardForRuns` is on.

## 3. The chat's `ask_operator`, recounted

`scripts/chat_ask_operator.py` finds **3 calls in 142 operator turns** (2.1%),
from 2026-09-25 onward. 40 of those 142 turns are the board's canned "Start runs…"
prompt.

- That agrees with the vault's 3 calls in 152 turns (*UsageFoundry Orchestrator
  Chat Quality Proposal*, `confidence: medium`, `status: archived`). The turn
  counts differ because the windows differ.
- Two of the three followed the operator telling the chat to ask ("nono you
  should ask the guiding questions to me right now"; "ask questions for open
  decisions").
- The one unprompted question was "Where should the vault live once it is a git
  repository?", which is a decision about the operator's own data.
- All three are OPERATOR-ONLY. The prompt now names the tool
  (`src/lib/chat.ts:4309`-`:4313`), and the rate did not move off near-silence.

## 4. What this does to the brief

1. **The need is small, and it is the operator's.** In 27 days, 494 runs raised:
   - about 13 decisions;
   - about 60 physical hand-offs;
   - **3 questions a read-only model could have answered**, all three a
     filesystem rule the harness already states.

   Most of the operator's idea is a model that answers on their behalf. On this
   measurement **an answering model would have had three things to say in a
   month**, and the cheaper fix for those three is the sentence they needed in the
   place they would read it.
2. **The decisions already have a route, and it is the board.** Runs file the
   decision as an `operatorOnly` task or release the task they hold with a note.
   The operator answers on the board, and a later run picks it up. What that
   route costs is a fresh run re-deriving the context the asking run had. What
   the `NEEDS_REVIEW` route costs instead is the run's place and, on a one-cycle
   run, an edit to its budget before the answer can be delivered
   ([`02-what-already-asks.md`](02-what-already-asks.md) §1). Zero pick-up notes
   in the window says the operator does not use that second route at all. The
   data cannot say whether that is because of its cost or despite it.
3. **The physical hand-offs need no channel.** A Mac check is done by the
   operator on a Mac, and the run that filed it has nothing to wait for. The
   board carries it, and the run ends.
4. **The lower bound is a real caveat.** More than half the briefs suppress
   asking. A channel would let the operator stop writing "nobody will answer".
   But the briefs that ask for judgement calls get routine, reversible ones back,
   and a channel would put the same calls in front of the operator **during** the
   run instead of after it. That is the habituation surface
   [`01-constraints.md`](01-constraints.md) C10 warns about. It does not reveal a
   class of question that went unasked.

So the options that follow are weighed against **≈ 13 operator-only decisions, ≈ 0
model-answerable questions, and a falsifier**, not against the open-ended traffic
the brief imagined. "Build nothing" and "make `NEEDS_REVIEW` cheaper to answer"
are both on the table, and the comparison is between them.
