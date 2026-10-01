# 00 — The problem, and whether this install has it

## The question

The operator's idea, in their words: "cross session communication, allowing
sessions that work on the same project talk to each other."

> Should runs (and possibly the orchestrator chat) that work on the same project
> be able to send each other messages, what would that channel be, what would it
> cost, and what must it never be allowed to do?

Read here as: a **session** is a run, a sequence of `claude -p` work cycles
(`src/lib/cycleInvocation.ts:1237`); the **same project** is the same
repository, including every isolated worktree of it under
`<mountRoot>/.uf-worktrees/<repo>-<slot>`
(`docs/agent/security/path-containment-and-spawn-argv.md:11`). Whether the
orchestrator chat and finished runs are in scope is decided, with the reason, in
[`01-constraints.md`](01-constraints.md) §0.

## Where the line is against the two neighbouring surveys

- **[ContinuousImprovement](../ContinuousImprovement/README.md)** is about a run
  re-deriving what an *earlier* run established: information across time, from
  a finished run to a later one. Its corpus question was "has a run on this
  repository already read this file?" (73.2% of `Read` calls,
  `proposals/ContinuousImprovement/README.md:72`). **This survey is about runs
  that are live at the same time, or that hand over directly** (`dependsOn`,
  `continueBranch`). A note left for the next run on a folder is ContinuousImprovement's
  question, and its four rejections of a durable, model-authored store (the
  operator note, the per-repository brief, the MCP knowledge tool, the
  agent-maintained `CLAUDE.md`, `proposals/ContinuousImprovement/README.md:116`–`:121`)
  are reused here rather than re-argued.
- **[ProviderFallback](../ProviderFallback/README.md)** describes one run's
  hand-over from one provider to another:
  `proposals/ProviderFallback/02-the-handover-contract.md` lists what crosses
  the switch, and `proposals/ProviderFallback/08-continuity.md` concludes that
  "branch + task text" is what continuity should rest on. A hand-over between
  two *runs* is the same shape with a different seam, and this survey cites that
  conclusion rather than repeating it.

## 1. Are two runs on one repository ever live at once?

Yes, and that is the normal state on this install. The folder claim allows one
writing run per folder subtree **unless the run is isolated**
(`docs/agent/concurrency-and-ownership/folder-claim-and-slot-walk.md:7`), an
isolated run claims its own worktree rather than the repository
(`src/lib/orchestrator.ts:476`–`:478`), isolation is on by default
(`src/lib/orchestrator.ts:4098`), and a repository has up to 64 worktree slots
(`src/lib/orchestrator.ts:3549`). `maxConcurrentRuns` ships at 4
(`src/lib/settings.ts:1052`); this install has evidently raised it, since ten
runs on one repository were live in the same minute.

**How it was measured.** The app's database is unreadable from a work cycle:
`sqlite3 "file:/data/usagefoundry.db?mode=ro" "select 1"` answered
`unable to open database file`, `/data` lists empty from inside the sandbox, and
`docker ps` answered `docker: command not found`, so the
`docker exec … sqlite3` route ContinuousImprovement used
(`proposals/ContinuousImprovement/00-problem.md:15`) is closed here. Two
corpora stand in for it:

1. **Session transcripts** under `/home/node/.claude/projects/`, 1,428
   top-level sessions, run activity from 2026-09-02 07:05 to 2026-10-01 06:38
   UTC. A run is keyed on its `uf/<slug>-<N>-<hash>` branch (580 isolated runs)
   or on its one session in `-workspace-<Repo>` (20 unisolated). Validator,
   reviewer, resolver, chat, vault, scheduler and Mac sessions are excluded.
   "Live" means a minute in which the run's transcript wrote a line, with gaps
   under 10 minutes filled, so parked time between cycles does not count.
2. **`prune-audit-dump.json`**, a gitignored extract of 478 `runs` rows from
   2026-08-10 to 2026-08-28 at `/workspace/UsageFoundry/prune-audit-dump.json`,
   which has start and finish times but no `run_events` and no `run_reviews`.

`scripts/run-all.sh` rebuilds every figure below from both.

| Repository | Runs | Had a sibling live at the same time | Overlapping pairs | Pair-overlap hours | Most at once |
|---|---:|---:|---:|---:|---:|
| UsageFoundry | 258 | **86.8%** | 551 | 90.0 | 10 (2026-09-27 16:41) |
| Dockrac | 192 | **99.0%** | 453 | 63.2 | 6 |
| FoundryCode | 46 | 89.1% | 86 | 13.1 | 7 |
| All 21 repositories | 600 | **80.0%** | 1,122 | 170.5 | |

The naive first-to-last span gives the same shares and 2.6× the pair-hours,
because it counts parked time. The August dump, on naive spans, agrees: 85.9% of
290 UsageFoundry runs had a sibling, at most 14 at once.

## 2. Do concurrent siblings collide?

Often, and mostly in shared indexes. The resolver merges with
`git merge --no-edit <target>` and commits with `git commit --no-edit`
(`src/lib/land.ts:1969`, `src/lib/land.ts:2056`), which keeps git's
`# Conflicts:` block, so every paid resolution leaves a findable commit. All 80
such commits in the transcript window matched a resolver session.

- **146 conflicted merges** across six repositories: UsageFoundry 114, Dockrac
  23, four others 9.
- In the transcript window, **63 of 80 (79%)** collided with a sibling that was
  live during the resolved run; 9 only with siblings that were not; 8 could not
  be attributed. The August dump, on naive spans: 40 of 66, 16, 10.
- The most-conflicted files across all 146: `CLAUDE.md` 47,
  `docs/verification.md` 35, `docs/agent/testing.md` 19, `README.md` 13. These
  are indexes and logs that both sides legitimately append to.

ContinuousImprovement priced 59 completed resolutions at $238.20
(`proposals/ContinuousImprovement/README.md:82`) and left open whether the
colliding runs overlapped in time; on this measurement most did. September's
resolver spend is not measured: 60 of 87 resolver sessions carry no cost line.

## 3. Did a run re-derive, duplicate or contradict a live sibling?

Duplicate, yes; contradict, no case found.

- **Nine runs filed the same task on Dockrac on 2026-09-25**, seven of them
  between 15:07 and 15:38: `TestEveryHelpPageListsEveryFlagItsCommandDefines`
  fails because `help service` has no row. Every filer called `list_my_tasks`
  first, and none of the results contained the task, because each showed 20
  open tasks while `openInFolderTotal` read 69, then 85, then 99. That is
  `MAX_RUN_TASKS = 20` (`src/lib/tasks.ts:1473`) applied to `openInFolder`
  (`src/lib/tasks.ts:1525`–`:1534`). The bug was then fixed once.
- **Three runs filed "EraseReported.swift does not compile on Linux"** on
  Dockrac between 19:35 and 19:42 on 2026-09-26. One said it was "Checking
  whether a sibling run already filed the EraseReported failure" and filed
  anyway; another noticed afterwards that "Other runs filed the same problems at
  the same time". Four further true duplicate pairs exist, two on UsageFoundry
  (25 of 52 similar-title pairs were between concurrently live runs; the rest
  were reviewed by hand and dropped).
- **One fix was written twice.** On 2026-09-28 a UsageFoundry run wrote: "A
  sibling run fixed this on another branch (commit 0da625d), but that commit is
  not on mine, so I'm redoing the work here." It committed the equivalent 20
  minutes later; that commit is now on no branch.
- **No run undid or contradicted a live sibling** in a keyword hunt over the
  assistant text of all 600 runs (`scripts/keyword_hunt.py`: 82 hits, read by
  hand).

Two things are already doing part of the job. Runs read sibling branches: a
FoundryCode run on 2026-09-13 found its work "Already done by the run ahead …
I wrote nothing." And some prompts already name the siblings, written by
whoever started the run: a scan of each isolated run's opening prompt found
"Other runs at the same time" or "another run owns that file" in **12 of 493**,
all on Dockrac. (A first pass with a wider match counted 151; the two are not
reconciled, and [`13-validation.md`](13-validation.md) §3 records it.)

## 4. What this does to the brief

Three findings narrow it.

1. **The need is real, and it is a need to see, not to talk.** Every measured
   duplicate is a run failing to see state that already existed: a task on the
   board behind a 20-row clip, a commit on a sibling branch. None is a run
   lacking something only a sibling's *words* could have told it. That is an
   inference from eleven cases, not a measurement of the counterfactual.
2. **Collisions are not a messaging problem.** The top four files are indexes
   both runs must edit. A message saying "I am editing `CLAUDE.md`" does not
   remove the edit the receiver also has to make. The contention is
   ContinuousImprovement's contention card's territory
   (`proposals/ContinuousImprovement/README.md:10`–`:15`), not this survey's.
3. **A channel already exists that nobody here built.** The pinned Claude Code
   CLI gives every work cycle peer-messaging tools, and nothing on the app's argv
   denies them. [`02-what-already-talks.md`](02-what-already-talks.md) §1 has the
   evidence. Whatever this survey recommends about building a channel, that one
   needs a decision first.
