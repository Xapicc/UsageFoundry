# CrossSessionCommunication

**Recommendation: runs should see each other, not talk to each other.**

1. Close the peer-messaging channel the pinned Claude Code CLI already gives
   every work cycle (G1).
2. Let `list_my_tasks` search the board (G2).
3. Add a read-only roster of live siblings on the same repository that carries
   no text a run wrote (G3).

Build no message channel. The case is in [`11-recommendation.md`](11-recommendation.md).

**What would overturn it:** after G2 and G3 have run for two weeks, two cases
of a duplicate or a redo between live siblings where the first run had found the
fact but had **not yet recorded it** anywhere a sibling could see: no task, no
commit, no note. That gap between knowing and recording is the one place state
cannot reach and a message can. [`13-validation.md`](13-validation.md) §2 says
how to find such cases.

**Runner-up:** Option C-board. The roster also carries each sibling's held task
id, so a run can leave a note on the task its sibling is working, through the
existing `comment_on_task`. That needs no new tool and no new table, is
token-signed, permanent and pull-only, and is
[`05-option-c-addressed-messages.md`](05-option-c-addressed-messages.md)'s
second form.

**Scope**, decided in [`01-constraints.md`](01-constraints.md) §0:

- A session is a run, and the same project is the same repository, including its
  worktrees.
- **The orchestrator chat is out** as a party to any channel. It is the most
  privileged child in the app, it already reads runs and writes notes, and a
  chat turn is attended.
- **Finished runs leaving messages for the next run are out.** That is
  ContinuousImprovement's question across time, and it already rejected a
  run-authored durable store.
- `dependsOn` and `continueBranch` hand-overs are inventoried as existing
  channels, not re-designed.

A survey that ends in one recommendation, not a plan. Nothing under `src/`,
`docs/` or the Dockerfile was changed.

---

## The finding that shapes everything

**This install already has cross-session messaging, and the app does not know.**
Claude Code 2.1.280 gives every headless `-p` cycle `ListAgents` and
`SendMessage`, and opens a unix-socket inbox for each session
([`02-what-already-talks.md`](02-what-already-talks.md) §1):

- **It is on.** `scripts/native-tools.sh` on the app's argv shape, against a
  local stub with a dummy key, lists both tools among 23. Nothing on the argv
  denies them (`src/lib/cycleInvocation.ts:1275`).
- **Runs have seen each other through it.** Of 39 `ListAgents` calls made by
  runs, **23 listed another live session** (`scripts/peer_usage.py`). These
  included four live UsageFoundry siblings at once, runs on other repositories,
  and sessions in the operator's vault folder. Its scope is the container, not
  the project.
- **Nobody has used it to talk yet.** All 21 `SendMessage` calls went to the
  run's own sub-agents; 0 to a peer, and 0 messages received.
- **It breaks the brief's three "never"s.** All three were read from the binary:
  the receive side could not be run inside the Bash sandbox, which refuses
  `AF_UNIX`.
  - A message arriving before a cycle exits makes the cycle **take another
    turn**.
  - `plan` and `acceptEdits` sessions accept from each other, so a read-only run
    can **have a writing run write**.
  - The receiver's `stream-json`, and so its run log, most likely carries **no
    record of the message**.
- **One environment variable closes it.** `CLAUDE_CODE_HARBOR_KITE=0` removes
  `ListAgents`, refuses peer addresses in `SendMessage` while keeping sub-agent
  messaging, and never opens the inbox. That is measured on the send side.
  `--disallowedTools` is the wrong lever: it leaves the inbox open.

## The measurement, and what it does and does not license

Session transcripts from 2026-09-02 to 2026-10-01, plus a 478-row `runs`
extract for August. The database itself is unreadable from a work cycle
([`00-problem.md`](00-problem.md) §1).

| | |
|---|---|
| Runs with a sibling on the same repository live at the same time | **80.0%** of 600 (UsageFoundry 86.8%, Dockrac 99.0%) |
| Most runs live on one repository in one minute | **10** (UsageFoundry, 2026-09-27) |
| Paid conflict resolutions in git, all repositories | **146** |
| …of which collided with a sibling that was live at the same time (transcript window) | **63 of 80** |
| Most-conflicted files | `CLAUDE.md` 47, `docs/verification.md` 35, `docs/agent/testing.md` 19 |
| Most duplicate filings of one task, by concurrently live runs | **9**, each made after a `list_my_tasks` that showed 20 of 69-99 open tasks |
| Concurrent near-duplicate task pairs a one-word title search would have matched | **25 of 25**; 10 on a distinctive identifier |
| Fixes redone because a sibling's commit was on another branch | **1** |
| Runs that contradicted or undid a live sibling | **0 found** |

**Concurrency is the normal case, and so is collision.** But every measured
duplicate is a run failing to see state that already existed. None is a run
lacking words only a sibling could send. The collisions are in indexes both runs
must edit, which a message would not remove. That is an inference from eleven
cases, not a measurement of a counterfactual, and the falsifier above is how it
gets tested.

## The files

| | |
|---|---|
| [`00-problem.md`](00-problem.md) | The question, the line against ContinuousImprovement and ProviderFallback, and the measured concurrency, collisions and duplicates. |
| [`01-constraints.md`](01-constraints.md) | Scope decisions; eleven constraints, with C8 on prompt injection as its own section; five unknowns with the command that settles each. |
| [`02-what-already-talks.md`](02-what-already-talks.md) | Every channel that already carries information between runs, verified. The CLI's peer messaging first. |
| [`03-option-a-change-nothing.md`](03-option-a-change-nothing.md) | **A**: the taskboard comment is the channel. Its board half is kept; its CLI half cannot stand. |
| [`04-option-b-notice-board.md`](04-option-b-notice-board.md) | **B**: a per-project notice board. Rejected as a broadcast store beside the one that held every answer. |
| [`05-option-c-addressed-messages.md`](05-option-c-addressed-messages.md) | **C**: addressed messages between live runs. C-new rejected; **C-board is the runner-up**. |
| [`06-option-d-native-messaging.md`](06-option-d-native-messaging.md) | **D**: allow the CLI's messaging and log it. Rejected: it extends cycles and widens modes by construction, and cannot be scoped. |
| [`07-option-e-in-the-repository.md`](07-option-e-in-the-repository.md) | **E**: a file or git notes in the tree. Rejected: no author, no horizon, mutable, pushed off the machine. |
| [`08-option-f-orchestrator-relay.md`](08-option-f-orchestrator-relay.md) | **F**: the operator or the chat relays. Kept as it is; it does not answer the unattended case. |
| [`09-option-g-see-not-talk.md`](09-option-g-see-not-talk.md) | **G**: close the CLI channel, search the board, show the siblings. **Recommended.** Added to the brief's list because of the measurement. |
| [`10-comparison.md`](10-comparison.md) | The facts side by side, why C3, C4 and C8 are vetoes rather than weights, and what dominates what. |
| [`11-recommendation.md`](11-recommendation.md) | The case, the order, the refusals by name, the overturning fact, the runner-up, and what to build if overruled. |
| [`12-implementation-sketch.md`](12-implementation-sketch.md) | G1, G2 and G3 as three commits, the files each touches, their tests, and what the runner-up would add. |
| [`13-validation.md`](13-validation.md) | How to test it before building: the receive-side pair test, and the search upper bound. What to measure after, with thresholds fixed in advance. What was verified and what was not. |
| [`scripts/`](scripts/) | `scripts/native-tools.sh`, `scripts/native-pair-test.sh` and `scripts/stub.mjs` drive the real CLI with nothing billed. `scripts/run-all.sh` rebuilds every figure from transcripts. Also `scripts/peer_usage.py`, `scripts/search_would_find.py`, `scripts/settle-from-db.sql` and `scripts/check-citations.mjs`. |

## The options at a glance

| | extends a run (C3) | widens a run (C4) | scope | new run-written text another run reads | measured need met | build |
|---|---|---|---|---|---|---|
| **A** nothing | **CLI: yes** | **CLI: yes** | container | yes | none | 0 |
| **B** notice board | no | narrows peers | repository | yes, broadcast | if found | 1-2 d |
| **C-new** messages | no | request to write | repository | yes, addressed | redo, already known | 2-3 d |
| **C-board** note on a sibling's task | no | framed as a task note | repository | yes, addressed | redo, already known | ~1 d after G3 |
| **D** native, logged | **yes** | **yes** | **container** | yes, peer | none | ~1 d, unscopable |
| **E** git notes | no | no | repository + remote | yes, unsigned | redo, already known | hours |
| **F** relay | no | no | any | after a person reads | late | 0 |
| **G** see, don't talk | **closes it** | **closes it** | repository | **titles only, already shown** | **all 25 filings, by search** | **~1.5 d** |

## Reused, not redone

- **ContinuousImprovement.** Its rejections of a run-authored durable store
  (agent-maintained `CLAUDE.md`, the per-repository brief, the MCP knowledge
  tool) are inherited rather than re-argued
  (`proposals/ContinuousImprovement/16-recommendation.md:179`-`:202`). So are
  its standing-tool-definition price and its contention card as the instrument
  for collisions. This survey answers one question it left open: whether the
  runs behind its 59 paid resolutions overlapped in time. On this measurement,
  most did.
- **ProviderFallback.** Its conclusion that a hand-over should rest on "branch +
  task text" (`proposals/ProviderFallback/08-continuity.md`) is cited for
  `continueBranch` rather than repeated.
- **The archived Sandboxing proposal.** Its goal that no run may write a
  checkout not its own, and its concession that one still can
  (`git show 36a0416^:"proposals/implemented - Sandboxing/README.md"`), set
  C7.
- **The vault.** Every note cited is `confidence: medium`, `status: growing`:
  *Prompt Infection (Lee and Tiwari 2024)*, *Do More Agents Help (Fu et al
  2026)*, *Orchestration Topologies*, *Sub-Agent Architectures* and *Agent
  Interoperability Protocols*.

## Found on the way, filed rather than fixed

Four taskboard tasks, filed against `/workspace/UsageFoundry`:

1. **Every work cycle has container-wide Claude Code peer messaging the app
   never chose** (high). This is G1, filed because it is open today whatever
   happens to this proposal.
2. **`list_my_tasks` clips `openInFolder` to 20 and offers no search, so runs
   file duplicates.** This is G2. It is a board defect with or without this
   survey.
3. **A stolen run token is said to buy "three tools"; `RUN_TOOLS` has seven**
   (`docs/agent/security/child-uid-and-credentials.md:13`, `src/lib/chat.ts:4367`).
4. **`comment_on_task` from a run checks only that the task exists**
   (`src/lib/taskComments.ts:270`), where the doc says "anything it can see".

## Checked

`node scripts/check-citations.mjs` resolves every `path:line` in this directory
against the tree at the commit that adds this README. About fifty of the cited
lines were also read back to confirm they say what they are cited for.
[`13-validation.md`](13-validation.md) §3 and §4 list what was measured and what
was not.
