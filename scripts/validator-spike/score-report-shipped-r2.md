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

- case 1 → **unjudgeable** — Task asks for a code-quality check (a report, not a repo change); the empty diff is consistent with both a completed review and a run that did nothing, and no transcript is available.
- case 6 → **unjudgeable** — Task output is a stdout report, not a repo change. The diff is correctly empty, but a run that did nothing looks identical, and no stdout or transcript is provided.
- case 8 → **not-finished** — Task requires stopped runs' uncommitted work be committed to their own branches via commitPending; the added README and UI text say the halt never commits. Rest is present; workflows.ts body hidden.
- case 10 → **unjudgeable** — Deliverables are GitHub issues and a stdout report, not repo changes; the empty diff is expected here and gives no evidence either way.
- case 15 → **unjudgeable** — Deliverables are GitHub issues and a stdout report, not repo changes; the empty diff is correct for this task but identical to a no-op run, and no issue evidence is shown.
- case 31 → **unjudgeable** — Task is a question about the repo; the answer never enters the repository, so an empty diff is expected and cannot distinguish a real answer from no work.
- case 36 → **finished** — Instance budget evaluator, six required test cases, enforcement hook, DB columns, UI and copy all present in the diff; budget.ts, workflows.ts and CLAUDE.md are listed as changed but cut.

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
| 1 | unjudgeable | unjudgeable | ✓ | complete | 0 | Task asks for a code-quality check (a report, not a repo change); the empty diff is consistent with both a completed review and a run that did nothing, and no transcript is available. |
| 2 | not-done | not-finished | ✓ | unattributed | 0 | Diff is empty (0 files, +0 -0); the task required a script fix, a regression test and a commit for issue #16, and none is present on the branch. |
| 3 | finished | finished | ✓ | complete | 3035 | The Earlier chats row now truncates only the title; the timestamp and waiting badge sit outside it with a title tooltip, which is the change the task describes. |
| 4 | finished | finished | ✓ | complete | 26384 | Cancel route, Stop button, row-based stale sweeper, child signal ladder and staleTurn tests are all in the diff; issue #22's own criteria were not visible, so presence only. |
| 5 | finished | finished | ✓ | complete | 16443 | chat.ts now settles the row to failed and returns the error when runTurn's pre-promise setup throws, and a regression test chatTurn.test.ts exists; issue text itself unread. |
| 6 | unjudgeable | unjudgeable | ✓ | complete | 0 | Task output is a stdout report, not a repo change. The diff is correctly empty, but a run that did nothing looks identical, and no stdout or transcript is provided. |
| 7 | finished | finished | ✓ | complete | 90221 | Both owned files changed (+1356/−610) and nothing else did; account page changes are visible, settings patch was cut but its large rewrite shows in the diffstat. Unverified: settings content, build results. |
| 8 | unjudgeable | not-finished | ✗ | complete | 87272 | Task requires stopped runs' uncommitted work be committed to their own branches via commitPending; the added README and UI text say the halt never commits. Rest is present; workflows.ts body hidden. |
| 9 | finished | finished | ✓ | complete | 62170 | Diff adds reply/notes/decided storage, recording in settleBlock/emitBlockRuns, DTO plumbing, and instance-page rendering that explains why an orchestrator block started nothing. |
| 10 | unjudgeable | unjudgeable | ✓ | complete | 0 | Deliverables are GitHub issues and a stdout report, not repo changes; the empty diff is expected here and gives no evidence either way. |
| 11 | finished | finished | ✓ | complete | 4636 | RunLand.tsx now keeps operator choice separate from server default; select, act body and warning text all read one effectiveStrategy. GitHub close and test decision not visible in diff. |
| 12 | finished | finished | ✓ | complete | 59320 | All five scoped files changed: single primary card, ListGroup rows, SegmentedControl breakdown, sticky list-view tables, RunCard glyph/ButtonRow. Meter's hairline/tabular treatment is not visible in the diff. |
| 13 | finished | finished | ✓ | complete | 11710 | Fix to zonedTime and Santiago/Havana tests (00:00, 00:30, weekly Sunday) are in the two expected files; issue close and test output are off-diff and unverified. |
| 14 | finished | finished | ✓ | complete | 123375 | All six build points and the named tests appear in the diff; typecheck, tests and build were not shown, and the CLAUDE.md change and validate route are unseen. |
| 15 | unjudgeable | unjudgeable | ✓ | complete | 0 | Deliverables are GitHub issues and a stdout report, not repo changes; the empty diff is correct for this task but identical to a no-op run, and no issue evidence is shown. |
| 16 | finished | finished | ✓ | complete | 54551 | Pure exported duePausedRuns/planPausedRun extracted from sweepPaused, with tests for all four branches in orchestrator.test.ts; issue close and test runs can't be seen in a diff. |
| 17 | finished | unjudgeable | ✗ | complete | 101273 | Backup and restore scripts, docs and tests are present, but issue #92's acceptance criteria and the report/test output are not in the evidence, so completeness cannot be checked. |
| 18 | finished | not-finished | — | 1 ambiguous | 82324 | #102 and #103 are in the diff, but #104's transient retry ladder is still unjittered (`backoff = TRANSIENT_BACKOFF_MS[plan.attempt]`) and no spread test exists for it. |
| 19 | finished | unjudgeable | ✗ | complete | 108961 | Readme.md and DECISIONS.md are present and SPEC.md is listed as changed (body hidden), but the 6-10 filed issues plus index live on GitHub and cannot be seen in the diff. |
| 20 | finished | unjudgeable | ✗ | complete | 169258 | Both issues' code is visibly present, but their acceptance boxes live in issue bodies and SPEC.md I cannot read, and closing the issues on GitHub is outside the diff. |
| 21 | finished | finished | ✓ | complete | 109072 | Changes are present in the merge queue worker (row always answered), queue page polling and no-store route, git() totality, with regression tests; symptom cure itself unverifiable. |
| 22 | finished | finished | ✓ | complete | 36540 | The branch adds docs/00-shape.md (+293, the only file changed), with every section the brief lists; no application code was added. |
| 23 | finished | finished | ✓ | complete | 136567 | digest command, its four sections, footer, flags and fakes-based tests are in the diff and registered in root.go; four core files are listed as changed but their bodies were cut. |
| 24 | finished | not-finished | — | unattributed | 0 | Task required building a whole skeleton from a docs-only repo (schema, CLI, widget, example, CI gate, log), but the branch diff is empty: 0 files changed, nothing committed. |
| 25 | finished | finished | ✓ | complete | 150155 | All named deliverables present: six trap tests, boundary test, unrelated-histories and unknown-type fixtures and tests, flag, schema freeze noted; red/green history and green build unseen. |
| 26 | finished | finished | ✓ | complete | 128275 | All named deliverables (03-walls, 07 D2/D12, 09, 10, 02 paragraphs, sources.md) are in the diffstat, and shown diffs corroborate their content; four bodies were unseen. |
| 27 | finished | finished | ✓ | complete | 274202 | Schema, two party processes, adversary scenarios, decidability probe, verifier with labelled placeholder, poc/README.md and the walls/open-questions docs are all in the diffstat. |
| 28 | finished | finished | ✓ | complete | 2144 | Both reported defects have a matching change: mb-4 on the Checkout slots Card, and relative on AppShell's main scroll region to stop the second document scrollbar. |
| 29 | finished | finished | ✓ | complete | 115775 | All four deliverables are in the 7-file list under scripts/sandbox-probe/, plus the docs/verification.md pointer and empty table; probe.sh and the seccomp JSON bodies were truncated. |
| 30 | finished | finished | ✓ | complete | 14462 | docs/verification.md results table now holds Q1-Q4/Q8a tokens, versions, uname, probe.test.sh result, Phase 4 note and added unmeasurable items; committed on the branch. |
| 31 | unjudgeable | unjudgeable | ✓ | complete | 0 | Task is a question about the repo; the answer never enters the repository, so an empty diff is expected and cannot distinguish a real answer from no work. |
| 32 | finished | finished | ✓ | complete | 40910 | The only deliverable, docs/fundamentals-premise.md, is committed and has the verdict, measured ground truth, section table, test and by-hand results, timings and gaps list; nothing else touched. |
| 33 | finished | finished | ✓ | complete | 76804 | All three named docs changed. The 00-shape amendment and the CLAUDE.md update are visible; the plan diff was cut but the stats show about +274 lines for it. No src/bin/test/scripts changes. |
| 34 | not-done | not-finished | ✓ | complete | 0 | Task required correcting stale counts in poc/README.md and docs/08-track-b-shape.md and committing; the branch diff is empty (0 files changed). |
| 35 | finished | finished | ✓ | complete | 18965 | chat.ts adds an atomic conditional-UPDATE claim (claimTurn) in sendChatMessage and chat.test.ts adds a concurrent-race test counting spawned children; both named deliverables are present. |
| 36 | unjudgeable | finished | ✗ | complete | 131502 | Instance budget evaluator, six required test cases, enforcement hook, DB columns, UI and copy all present in the diff; budget.ts, workflows.ts and CLAUDE.md are listed as changed but cut. |
| 37 | finished | finished | ✓ | complete | 14425 | Both fixes and their regression tests are in the diff, and WorkflowEditor.tsx is untouched; commit split, GitHub closes and test output are not visible. |
| 38 | finished | finished | ✓ | complete | 67448 | docker-compose.yml adds mem_limit, memswap_limit, pids_limit and cpus with justified numbers, the deployment test is extended, and unverified docker steps are documented; issue checklist unseen. |
| 39 | finished | finished | ✓ | complete | 87308 | The one deliverable, docs/01-implementation-plan.md, is the only file on the branch (+1175 lines, nothing else touched); its body was truncated, so section contents are unseen. |
| 40 | finished | finished | ✓ | complete | 73059 | docs/08-track-b-shape.md is in the diffstat (body cut); docs/06, docs/07 (D17/D18) and research/sources.md edits are visible and cite 08's M0-M4, §II.0-II.6, L1-L13, S1-S8. |
