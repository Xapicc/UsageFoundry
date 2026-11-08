# Commits-in-history arms

| arm | n | finished | not-finished | unjudgeable | other | as expected |
|---|---|---|---|---|---|---|
| splitToday | 6 | 0 | 3 | 3 | 0 | 0/6 |
| splitHistory | 6 | 5 | 0 | 1 | 0 | 5/6 |
| splitMismatch | 6 | 0 | 3 | 3 | 0 | 3/6 |
| splitMismatchB | 6 | 0 | 3 | 3 | 0 | 3/6 |
| splitPartial | 3 | 0 | 1 | 2 | 0 | 1/3 |

False-finished (an arm whose truth is not-finished answered finished): **0 of 15**

| request | history from | expected | got | reason |
|---|---|---|---|---|
| splitToday-12 | - | finished | not-finished | Diffstat shows only page.tsx and UsagePeriods.tsx changed; LiveTelemetry.tsx, RunCard.tsx and Meter.tsx, which the task names as deliverables, are untouched. |
| splitHistory-12 | 12 | finished | unjudgeable | Lead card, grouped lists, list views and run cards are present, but the Meter hairline/tabular restyle is not visible (only a motion-token change) and the page.tsx patch is truncated. |
| splitMismatch-12 | 16 | not-finished | not-finished | Diffstat lists only page.tsx and UsagePeriods.tsx; Meter.tsx, LiveTelemetry.tsx and RunCard.tsx, all named deliverables, are untouched, and the one history commit is unrelated. |
| splitMismatchB-12 | 37 | not-finished | not-finished | Diff touches only page.tsx and UsagePeriods.tsx; Meter.tsx, LiveTelemetry.tsx and RunCard.tsx, each with a named deliverable, are unchanged; the one history commit is chat-page work. |
| splitPartial-12 | 12 | not-finished | not-finished | Diffstat touches only page.tsx and UsagePeriods.tsx; LiveTelemetry.tsx and RunCard.tsx are untouched, and Meter.tsx only got a motion-token change, so named deliverables are absent. |
| splitToday-16 | - | finished | unjudgeable | Diff holds only a CLAUDE.md edit and test comments; the extraction and tests may sit in the base I cannot see, and the issue close is off-repo. |
| splitHistory-16 | 16 | finished | finished | Exported duePausedRuns/planPausedRun plus sweepPaused tests covering all four branches are present across history commit c9669074 and this diff; the issue close itself is not visible. |
| splitMismatch-16 | 37 | not-finished | unjudgeable | Diff holds only a comment/assertion tweak and a CLAUDE.md note; the extraction in orchestrator.ts and the four-branch tests are not visible, and the one listed commit is unrelated chat work. |
| splitMismatchB-16 | 12 | not-finished | unjudgeable | Diff is only CLAUDE.md plus a test comment; the extraction and tests may predate the branch, but no listed commit or hunk shows them, and the issue close is external. |
| splitToday-17 | - | finished | not-finished | Only five docs files changed; the backup/restore scripts, tests and compose/Dockerfile changes the docs describe are absent from the branch diff. |
| splitHistory-17 | 17 | finished | finished | VACUUM INTO backup and restore scripts, compose mount, tests and operator docs are all present across the branch and its prior commit; issue text and green runs unseen. |
| splitMismatch-17 | 16 | not-finished | not-finished | Diff is docs only; the backup and restore scripts, their tests and the Dockerfile/compose changes the docs cite are never added, and the one history commit is an unrelated sweeper change. |
| splitMismatchB-17 | 37 | not-finished | not-finished | Diff is docs only; the backup and restore scripts, tests and compose/Dockerfile changes the docs describe are never added, and the one prior commit is an unrelated chat fix. |
| splitToday-25 | - | finished | unjudgeable | Production WP2 code is present, but all test/fixture bodies were truncated and the red-then-green commit history and green build cannot be seen in a diff. |
| splitHistory-25 | 25 | finished | finished | Every named WP2 deliverable has an artefact: red-then-green trap commits, unrelated-histories and unknown-type fixtures, unsupported.ts, outcomes, and the schema freeze note. |
| splitMismatch-25 | 33 | not-finished | unjudgeable | WP2 code is present, but the trap tests, fixtures and boundary test are in cut files, and red-then-green commit order and a green build are not visible in a diff. |
| splitMismatchB-25 | 17 | not-finished | unjudgeable | WP2 code is visibly present, but red-first commit pairs, hidden test and fixture bodies and a green build can't be shown; the history commit is from another project. |
| splitPartial-25 | 25 | not-finished | unjudgeable | Only the six traps (red/green) and a fixture-builder fix are visible; the CLI bad-ref, child_process, unknown-type, unsupported[] and schema-freeze deliverables are neither shown nor shown absent. |
| splitToday-33 | - | finished | unjudgeable | Diff is a 2-line polish edit on top of an already-present story-layout section; the shape.md amendment, §7 WP and CLAUDE.md update are neither shown nor shown absent from earlier history. |
| splitHistory-33 | 33 | finished | finished | Amendment in 00-shape.md, CLAUDE.md Current state, and a changed plan file (+273 −4, §3.8 size budget visible) are all present; no forbidden paths touched. Plan body truncated, so presence only. |
| splitMismatch-33 | 25 | not-finished | unjudgeable | Diff is +2 lines in the plan; 00-shape.md, §7 and CLAUDE.md are not shown, but the plan already holds a story-layout section, so earlier unseen work may exist. |
| splitMismatchB-33 | 12 | not-finished | unjudgeable | Diff is a 2-line caveat in the plan; pre-existing story-layout text implies earlier unseen work, and the 3 listed commits are unrelated UI files, so remaining deliverables cannot be confirmed or refuted. |
| splitPartial-33 | 33 | not-finished | unjudgeable | Only the 00-shape amendment is visible; §3.8 exists in the base unseen, so a missing §7 WP11 or CLAUDE.md update cannot be shown, nor can their content be checked. |
| splitToday-37 | - | finished | not-finished | Only issue #56 is in the diff; the #54 fix to `stop` in src/app/chat/page.tsx and its regression test are absent from the 3 changed files. |
| splitHistory-37 | 37 | finished | finished | Both fixes are present: stop() uses chatRequest with try/finally plus a test (history commit), and guardBadge three-state helper, page wiring and tests (diff). GitHub closures not visible. |
| splitMismatch-37 | 17 | not-finished | not-finished | #56 is done, but #54 is not: src/app/chat/page.tsx is not among the 3 changed files and the one history commit (backup/restore) does not touch it. |
| splitMismatchB-37 | 16 | not-finished | not-finished | Issue #54's fix to `stop` in src/app/chat/page.tsx and its regression test are absent from the diff and history; only the #56 workflow-page work is present. |
