# Validator spike — score against git show a74a1bb:"proposals/implemented - ExternalValidator/validator-baseline.md" §3

model: claude-sonnet-5-5 via Agent-tool subagent · transport: file · prompt: shipped (buildValidationPrompt) · testimony: withheld

cases: 40 · answered: 40 · unparseable: 0 · awaiting: 0
held out — this harness cannot vouch the model saw the whole diff: 3 (cases 2, 18, 24)

## Agreement

- scored set: **32/37** (86.5%)
- including reconstruction failures: 33/40 (82.5%)
- trivial baseline (always answer `finished`): 29/37 (78.4%)

## Confusion (rows = label, columns = verdict)

| label | finished | not-finished | unjudgeable | n |
|---|---:|---:|---:|---:|
| finished | 26 | 0 | 3 | 29 |
| not-done | 0 | 1 | 0 | 1 |
| unjudgeable | 1 | 1 | 5 | 7 |

## false-finished — said finished, the label says the work was not done

**0 of 1** such rows.

## false-not-finished — said not-finished, the label says finished

**0 of 29** such rows.

## Rows the labels call `unjudgeable` (7)

- case 1 → **unjudgeable** — Task is a code-quality review whose output is an answer, not a repo change; the empty diff fits both a completed review and a run that did nothing.
- case 6 → **unjudgeable** — Deliverable is a stdout report on a read-only task; the empty diff is correct but identical to a run that did nothing, and no report text is in the evidence.
- case 8 → **not-finished** — Task required halt to commit uncommitted work via commitPending; the branch's README and UI text state the halt never commits and no commitPending call appears in the visible diff.
- case 10 → **unjudgeable** — Deliverables are GitHub issues and a stdout report, never repo changes; the task forbids commits, so the empty diff fits both a completed triage and a run that did nothing.
- case 15 → **unjudgeable** — Deliverables are GitHub issues and a stdout report, not repo changes; the empty diff is correct for this task and identical to a run that did nothing.
- case 31 → **unjudgeable** — Task is a question about the repo; the answer is not a repo deliverable, so an empty diff fits both a completed run and a run that did nothing.
- case 36 → **finished** — Instance budget limits, evaluateInstanceBudget with tests, between-nodes enforcement via stopInstance, DB columns, UI and overshoot copy are all present; three file bodies were cut but listed as changed.

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
| 1 | unjudgeable | unjudgeable | ✓ | complete | 0 | Task is a code-quality review whose output is an answer, not a repo change; the empty diff fits both a completed review and a run that did nothing. |
| 2 | not-done | not-finished | ✓ | unattributed | 0 | Task required fixing label splitting in the health-check script plus a regression check and a commit; the branch diff is empty (0 files, +0 -0). |
| 3 | finished | finished | ✓ | complete | 3035 | The diff restructures the Earlier chats rows in src/app/chat/page.tsx so the time and waiting badge sit outside the truncating title, with a title tooltip. Rendering and the issue's boxes could not be checked. |
| 4 | finished | finished | ✓ | complete | 26384 | Cancel route, Stop button, stale-turn sweeper, live-child signalling and a staleTurn regression test are all in the diff; the issue's own checkboxes could not be read. |
| 5 | finished | finished | ✓ | complete | 16443 | chat.ts wraps the runTurn call to settle the row as failed and return the error; chatTurn.test.ts adds the regression test. Issue text and test results unverifiable. |
| 6 | unjudgeable | unjudgeable | ✓ | complete | 0 | Deliverable is a stdout report on a read-only task; the empty diff is correct but identical to a run that did nothing, and no report text is in the evidence. |
| 7 | finished | unjudgeable | ✗ | complete | 90221 | Both owned files changed, but settings/page.tsx's body was truncated; the guard-set lead, save states and secret handling live there and cannot be checked. Build results are not diff-visible. |
| 8 | unjudgeable | not-finished | ✗ | complete | 87272 | Task required halt to commit uncommitted work via commitPending; the branch's README and UI text state the halt never commits and no commitPending call appears in the visible diff. |
| 9 | finished | finished | ✓ | complete | 62170 | Diff adds persisted block reply/notes, a decided flag, and instance-page rendering that explains why an orchestrator block started nothing; every layer from DB to UI is present. |
| 10 | unjudgeable | unjudgeable | ✓ | complete | 0 | Deliverables are GitHub issues and a stdout report, never repo changes; the task forbids commits, so the empty diff fits both a completed triage and a run that did nothing. |
| 11 | finished | finished | ✓ | complete | 4636 | RunLand.tsx splits chosen vs default strategy; load() no longer overwrites the choice, and select and act both use effectiveStrategy. GitHub close and test results are not visible. |
| 12 | finished | finished | ✓ | complete | 59320 | All five scoped files changed: one primary card, ListGroup, SegmentedControl, sticky-header list views, restyled RunCard. Meter's track styling not visible in the diff, presumed from the earlier run. |
| 13 | finished | finished | ✓ | complete | 11710 | zonedTime in schedules.ts now checks the local date via zonedParts and prefers the on-date candidate; Santiago/Havana daily 00:00, 00:30 and weekly-Sunday tests were added. Issue closure and test runs are not visible. |
| 14 | finished | finished | ✓ | complete | 123375 | Diff adds node agentId, validation against injected agents, planEmission check, orchestrator turn agent, editor picker and sentence, merge refusal, and the requested tests in both named test files. |
| 15 | unjudgeable | unjudgeable | ✓ | complete | 0 | Deliverables are GitHub issues and a stdout report, not repo changes; the empty diff is correct for this task and identical to a run that did nothing. |
| 16 | finished | finished | ✓ | complete | 54551 | Pure exported duePausedRuns/planPausedRun extracted in orchestrator.ts, sweepPaused rewired, and tests for all four branches added in orchestrator.test.ts; issue close and test runs not visible. |
| 17 | finished | finished | ✓ | complete | 101273 | VACUUM INTO backup script, guarded restore script, docs/README, compose and Dockerfile wiring, and tests are all in the diff; #92's criteria and test output were not visible. |
| 18 | finished | not-finished | — | 1 ambiguous | 82324 | #104 transient-retry jitter is absent: TRANSIENT_BACKOFF_MS is still used raw and no spread test exists for it, though #102 and #103 are present. |
| 19 | finished | unjudgeable | ✗ | complete | 108961 | Readme.md and DECISIONS.md are present and SPEC.md is listed as changed, but the 6-10 issues plus index live on GitHub, which this evidence cannot show or refute. |
| 20 | finished | unjudgeable | ✗ | complete | 169258 | Acceptance criteria are in issue bodies and SPEC I cannot read; issue closure and commit split are off-diff; referential.go, pr.go and commit.go bodies were truncated. Nothing is shown absent. |
| 21 | finished | finished | ✓ | complete | 109072 | Diff changes the merge worker, git(), the queue route and the panel's polling, with new tests, all aimed at queue statuses never updating; presence only, not verified by running. |
| 22 | finished | finished | ✓ | complete | 36540 | Branch diff adds docs/00-shape.md (+293) covering every section the brief lists, with assumptions marked and no application code or scaffolding added. |
| 23 | finished | finished | ✓ | complete | 136567 | digest command, four-section render with the §9.6 footer, transport, shared Assumed heuristic and tests are all present; classifier bodies and the #10 comment are not visible. |
| 24 | finished | not-finished | — | unattributed | 0 | Task required building a new codebase (schema, CLI, widget, example, size gate, log) in a docs-only repo; the branch diff is empty, 0 files changed, nothing committed. |
| 25 | finished | finished | ✓ | complete | 150155 | 32-file diff has a file or test for every WP2 deliverable (traps, boundaries, unrelated/up-to-date/fast-forward fixtures, unknown-type, schema); build and red/green history unseen. |
| 26 | finished | finished | ✓ | complete | 128275 | All named files are in the changed set (03, 07, 09, 10, 02, sources); shown diffs record D2 SETTLED, D12 'extend A2A', three prior-art paragraphs; 09/10/03/sources bodies cut but cross-cited. |
| 27 | finished | finished | ✓ | complete | 274202 | Every named deliverable has a file in the diff: schema, two parties, adversaries, decidability probe, verifier, README and walls edits. Unshown bodies are listed as changed. |
| 28 | finished | finished | ✓ | complete | 2144 | Both reported defects have a matching change on the branch: mb-4 spacing on the Checkout slots Card, and `relative` on the AppShell main scroll pane for the double scrollbar. |
| 29 | finished | finished | ✓ | complete | 115775 | All named deliverables are present: Dockerfile.probe, RUNBOOK.md, verification.md table, plus uf-seccomp.json and probe.sh in the complete file list; bodies of those two were not shown. |
| 30 | finished | finished | ✓ | complete | 14462 | docs/verification.md now has the results table filled with Q1-Q4 and Q8a tokens, versions, uname, probe.test.sh result and Phase 4 note; Not-yet-verified entries updated. |
| 31 | unjudgeable | unjudgeable | ✓ | complete | 0 | Task is a question about the repo; the answer is not a repo deliverable, so an empty diff fits both a completed run and a run that did nothing. |
| 32 | finished | finished | ✓ | complete | 40910 | The diff adds docs/fundamentals-premise.md alone, with verdict, CLI-version ground truth, section table, test and by-hand results, timings and a could-not-measure list, all as the task listed. |
| 33 | finished | finished | ✓ | complete | 76804 | Docs-only diff touches all three named files; the shape amendment and CLAUDE.md update are visible. Plan §3.8/WP11 body is truncated but the file is changed (~270 added lines). |
| 34 | not-done | not-finished | ✓ | complete | 0 | Task required committed edits to docs/08-track-b-shape.md Run record and poc/README.md; the branch diff is empty (0 files, +0 −0), so no required deliverable landed. |
| 35 | finished | finished | ✓ | complete | 18965 | chat.ts adds an atomic conditional-UPDATE claimTurn in sendChatMessage and chat.test.ts adds a Promise.all race test asserting one spawned child; issue text itself unreadable. |
| 36 | unjudgeable | finished | ✗ | complete | 131502 | Instance budget limits, evaluateInstanceBudget with tests, between-nodes enforcement via stopInstance, DB columns, UI and overshoot copy are all present; three file bodies were cut but listed as changed. |
| 37 | finished | finished | ✓ | complete | 14425 | Both fixes, the pure guardBadge helper and the regression tests for #54 and #56 are in the diff, and WorkflowEditor is untouched; commit split, test runs and issue closures are not visible. |
| 38 | finished | finished | ✓ | complete | 67448 | mem_limit, memswap_limit, pids_limit and cpus are in docker-compose.yml with reasoned comments, plus test, README and verification notes; issue text and test results not visible. |
| 39 | finished | finished | ✓ | complete | 87308 | The named file docs/01-implementation-plan.md is the branch's only change (+1175 lines); the body was truncated, so its section coverage is unseen and only its presence is claimed. |
| 40 | finished | finished | ✓ | complete | 73059 | docs/08-track-b-shape.md is in the changed-file list (body cut), and docs/06, docs/07 and research/sources.md visibly carry matching updates that cite its sections. |
