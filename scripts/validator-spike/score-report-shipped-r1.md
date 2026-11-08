# Validator spike — score against git show a74a1bb:"proposals/implemented - ExternalValidator/validator-baseline.md" §3

model: claude-sonnet-5-5 via Agent-tool subagent · transport: file · prompt: shipped (buildValidationPrompt) · testimony: withheld

cases: 40 · answered: 40 · unparseable: 0 · awaiting: 0
held out — this harness cannot vouch the model saw the whole diff: 3 (cases 2, 18, 24)

## Agreement

- scored set: **31/37** (83.8%)
- including reconstruction failures: 32/40 (80.0%)
- trivial baseline (always answer `finished`): 29/37 (78.4%)

## Confusion (rows = label, columns = verdict)

| label | finished | not-finished | unjudgeable | n |
|---|---:|---:|---:|---:|
| finished | 25 | 0 | 4 | 29 |
| not-done | 0 | 1 | 0 | 1 |
| unjudgeable | 1 | 1 | 5 | 7 |

## false-finished — said finished, the label says the work was not done

**0 of 1** such rows.

## false-not-finished — said not-finished, the label says finished

**0 of 29** such rows.

## Rows the labels call `unjudgeable` (7)

- case 1 → **unjudgeable** — Task is an analysis request (check code quality); an empty diff is expected for it and is identical to a run that did nothing, so the diff cannot settle it.
- case 6 → **unjudgeable** — Read-only task whose only deliverable is a stdout report; the empty diff is correct but identical to a no-op run, and the report is not in the evidence.
- case 8 → **not-finished** — Task requires uncommitted work committed to each run's branch via commitPending; the README and UI say the halt never commits. The core workflows.ts diff was truncated.
- case 10 → **unjudgeable** — Deliverables are GitHub issues and an index issue, outside the repo; the empty diff is correct but identical to a no-op run, and no gh output or report is in the evidence.
- case 15 → **unjudgeable** — Task's deliverables are GitHub issues and an index issue, not repo changes; the empty diff is expected and cannot be told apart from a run that did nothing.
- case 31 → **unjudgeable** — Task is a question about the repo; the answer never enters the repository, so an empty diff is expected and can't be told apart from a run that did nothing.
- case 36 → **finished** — Limits, DB columns, form/UI, between-run enforcement, telemetry bound and all required unit tests are in the diff; budget.ts, workflows.ts and CLAUDE.md bodies were cut but are listed as changed.

## Cost, wall clock, and diff size

- cost per verdict: not measured by this transport
- wall clock per verdict: not measured by this transport
- prompt size: median 36353 chars
- diff size (whole branch diff, before shortening): median 76804 B, max 274202 B over 32 non-empty
- shortened to fit: 19 of 40
- empty diffs: 8 · chained branches: 13

## Every verdict

| # | label | verdict | ok | diff | diff B | reason |
|---|---|---|---|---|---:|---|
| 1 | unjudgeable | unjudgeable | ✓ | complete | 0 | Task is an analysis request (check code quality); an empty diff is expected for it and is identical to a run that did nothing, so the diff cannot settle it. |
| 2 | not-done | not-finished | ✓ | unattributed | 0 | Diff is empty (0 files, +0 -0) against a task that required fixing the label-splitting bug and adding a regression check, all committed on the branch. |
| 3 | finished | finished | ✓ | complete | 3035 | The Earlier chats row in src/app/chat/page.tsx now truncates only the title; timestamp and waiting Badge sit on a second line and a title tooltip was added, as the task described. |
| 4 | finished | finished | ✓ | complete | 26384 | Diff adds a cancel route, Stop button, endTurn child-signalling ladder, a staleTurn sweeper with unit tests and a migration, covering the task's three stated deliverables. |
| 5 | finished | finished | ✓ | complete | 16443 | chat.ts wraps the pre-promise window so a throw settles the row to failed and reports it; chatTurn.test.ts reproduces the stranded-thinking case. Not run; issue boxes unseen. |
| 6 | unjudgeable | unjudgeable | ✓ | complete | 0 | Read-only task whose only deliverable is a stdout report; the empty diff is correct but identical to a no-op run, and the report is not in the evidence. |
| 7 | finished | unjudgeable | ✗ | complete | 90221 | Settings page diff (most of the +1356/-610, and the guard-first and save-state work) was cut from the evidence; only the account page is visible. Build/typecheck also unshowable. |
| 8 | unjudgeable | not-finished | ✗ | complete | 87272 | Task requires uncommitted work committed to each run's branch via commitPending; the README and UI say the halt never commits. The core workflows.ts diff was truncated. |
| 9 | finished | finished | ✓ | complete | 62170 | Diff stores and renders the orchestrator block's reply, notes and a decided/not-decided status on the workflow instance page, so a zero-run block now explains itself. |
| 10 | unjudgeable | unjudgeable | ✓ | complete | 0 | Deliverables are GitHub issues and an index issue, outside the repo; the empty diff is correct but identical to a no-op run, and no gh output or report is in the evidence. |
| 11 | finished | finished | ✓ | complete | 4636 | RunLand.tsx now keeps the operator's strategy separate from the server default; select, act and the squash note all use effectiveStrategy. GitHub close and test not visible. |
| 12 | finished | finished | ✓ | complete | 59320 | All five scoped files changed; one primary card, ListGroup, SegmentedControl, sticky-head list views and RunCard glyph/ButtonRow are all present in the diff. |
| 13 | finished | finished | ✓ | complete | 11710 | zonedTime in schedules.ts now checks the requested local date and prefers the first candidate; Santiago/Havana tests for daily 00:00, 00:30 and weekly Sunday were added. GitHub closure unseen. |
| 14 | finished | finished | ✓ | complete | 123375 | Every named deliverable is present: node agentId, knowledge-based refusals, picker and statement, emit_runs agent, merge refusal, and the requested tests. |
| 15 | unjudgeable | unjudgeable | ✓ | complete | 0 | Task's deliverables are GitHub issues and an index issue, not repo changes; the empty diff is expected and cannot be told apart from a run that did nothing. |
| 16 | finished | finished | ✓ | complete | 54551 | Exported pure duePausedRuns/planPausedRun, sweepPaused rewired and exported, and tests for all four branches are in the diff; only the out-of-repo issue close is unseen. |
| 17 | finished | unjudgeable | ✗ | complete | 101273 | Acceptance criteria live in issue #92, which is not in the evidence; the diff shows a coherent backup/restore implementation but cannot be checked against that spec. |
| 18 | finished | not-finished | — | 1 ambiguous | 82324 | #104's transient retry-ladder jitter is absent: backoff is still raw TRANSIENT_BACKOFF_MS[plan.attempt], jitterMs is only used in refusalResumeAt, and no retry-spread test exists. |
| 19 | finished | unjudgeable | ✗ | complete | 108961 | The three docs are present in the diffstat, but the 6-10 filed issues and the index issue live on GitHub and can't be verified from the diff. SPEC.md's body was truncated. |
| 20 | finished | unjudgeable | ✗ | complete | 169258 | Code for #4/#5 is visibly present, but acceptance criteria live in unreadable issue bodies, and issue closure, commit split and test results cannot be seen in a diff. |
| 21 | finished | finished | ✓ | complete | 109072 | Fix landed in the merge queue worker, git(), queue page polling and queue route, with regression tests; the bug report names no other deliverable. Correctness is not judged. |
| 22 | finished | finished | ✓ | complete | 36540 | Branch adds docs/00-shape.md (+293, only file) with every section the task listed, assumptions marked, and no application code or scaffolding added. |
| 23 | finished | finished | ✓ | complete | 136567 | digest command, four sections, footer, drop rule, Assumed heuristic and fake-transport tests are present; classify.go body and the #10 comment are not visible. |
| 24 | finished | not-finished | — | unattributed | 0 | Task required building the WP1 skeleton (schema, CLI, widget, example, size gate, log) in a docs-only repo; the branch diff is empty, so every named deliverable is absent. |
| 25 | finished | finished | ✓ | complete | 150155 | Trap tests, fixtures, boundary tests, unrelated-histories handling and schema freeze are all in the diff; red/green history and green build cannot be seen, and 10 files were hidden. |
| 26 | finished | finished | ✓ | complete | 128275 | All named artefacts (03-walls, 07 D2/D12, 09, 10, 02-prior-art, sources.md) are in the changeset and cross-referenced; some bodies were cut but the file list is complete. |
| 27 | finished | finished | ✓ | complete | 274202 | All named deliverables (schema, two parties, adversaries, probe, verifier, README, walls/open-questions docs, scripts) appear in the diffstat; unseen bodies are listed as changed. |
| 28 | finished | finished | ✓ | complete | 2144 | Both named fixes are in the diff: mb-4 on the Checkout slots Card in branches/page.tsx, and `relative` on <main> in AppShell.tsx to stop the double scrollbar and grey overscroll. |
| 29 | finished | finished | ✓ | complete | 115775 | All named deliverables are present: Dockerfile.probe, uf-seccomp.json, probe.sh, RUNBOOK.md and the verification.md table. probe.sh and the JSON bodies were truncated. |
| 30 | finished | finished | ✓ | complete | 14462 | docs/verification.md now has the sandbox results table filled with Q1-Q4 and Q8a tokens, versions and uname, plus the probe.test.sh result and Phase 4 note; the changes are present. |
| 31 | unjudgeable | unjudgeable | ✓ | complete | 0 | Task is a question about the repo; the answer never enters the repository, so an empty diff is expected and can't be told apart from a run that did nothing. |
| 32 | finished | finished | ✓ | complete | 40910 | The only deliverable, docs/fundamentals-premise.md, is added on the branch and contains every required part: verdict, CLI 2.1.226 raw output, table, test and by-hand results, timing, unmeasured list. |
| 33 | finished | finished | ✓ | complete | 76804 | Shape amendment and CLAUDE.md state are visible; the plan file is in the complete diffstat with ~270 added lines, body cut. Only docs changed; no src/bin/test/scripts/README touched. |
| 34 | not-done | not-finished | ✓ | complete | 0 | Empty diff, nothing committed; task required updating poc/README.md and docs/08-track-b-shape.md Run record with corrected counts and coverage table, and committing. |
| 35 | finished | finished | ✓ | complete | 18965 | chat.ts adds claimTurn, a conditional UPDATE claim made after the await in sendChatMessage, and chat.test.ts adds a two-concurrent-message test asserting one spawned child. |
| 36 | unjudgeable | finished | ✗ | complete | 131502 | Limits, DB columns, form/UI, between-run enforcement, telemetry bound and all required unit tests are in the diff; budget.ts, workflows.ts and CLAUDE.md bodies were cut but are listed as changed. |
| 37 | finished | finished | ✓ | complete | 14425 | Both fixes and their regression tests are in the diff, and out-of-scope files are untouched; commit split, test runs and GitHub closures cannot be seen in a diff. |
| 38 | finished | finished | ✓ | complete | 67448 | docker-compose.yml adds mem_limit, memswap_limit, pids_limit and cpus with justified numbers; deployment test, README sizing and verification docs added. Issue's own criteria unseen. |
| 39 | finished | finished | ✓ | complete | 87308 | The only deliverable, docs/01-implementation-plan.md, was added (+1175 lines) as the sole changed file; its body was truncated, so section coverage is unseen. |
| 40 | finished | finished | ✓ | complete | 73059 | docs/08 is in the diffstat (~490 added lines) and docs/06, 07 and sources.md, whose diffs are visible, cite its sections; its body was truncated and not directly read. |
