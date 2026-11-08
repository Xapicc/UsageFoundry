The branch carries two runs' worth of work: the earlier commit c9669074 in the history, and this run's own small diff. Together they contain what the task names that can appear in a repository. c9669074 adds the exported pure functions `duePausedRuns` and `planPausedRun` (with a `PausedRunPlan` type) to `src/lib/orchestrator.ts`, and `sweepPaused` now calls them through a `switch`. It also exports `sweepPaused`. In `src/lib/orchestrator.test.ts` it adds tests for all four branches:

1. A null `resume_at` is due, and a wake time that has arrived is due while a later one is not.
2. When the guard has cleared but the folder is taken, the plan is `hold` with a constant reason. The test pins that the reason does not vary with the holder, which is the property the guarded UPDATE relies on.
3. When the folder is free, the plan is `resume`. A database-backed test checks that the run ends up `queued` under a concurrency cap, so it went through `promoteQueued` rather than `startRun`.
4. Every stop-disposition code produces an `end` plan.

This run's own diff adds only a comment block to the test file and a stronger assertion message. It also makes a long documentation edit to `CLAUDE.md` that lists the new tests. That edit is extra, not a missing deliverable.

Two things in the task cannot be seen in a diff: the `gh issue close 109 --comment ...` call and the real results of `npm run typecheck` and `npm test`. I could not check either. Every deliverable that is supposed to land in the repository is present, so I call it finished. The only claim I am making is that the change is there.

```json
{
  "verdict": "finished",
  "reason": "Exported duePausedRuns/planPausedRun plus sweepPaused tests covering all four branches are present across history commit c9669074 and this diff; the issue close itself is not visible.",
  "evidence": [
    "history c9669074: src/lib/orchestrator.ts adds exported duePausedRuns, planPausedRun, PausedRunPlan and exports sweepPaused",
    "history c9669074: src/lib/orchestrator.test.ts describe blocks for due runs, hold (constant reason), resume, park, and end for every stop code",
    "history c9669074: 'puts a resumed run in the queue rather than starting it' and the stop-during-scan test exercise sweepPaused against the database",
    "this diff: src/lib/orchestrator.test.ts comment and assertion message on the promoteQueued case, plus a CLAUDE.md edit",
    "not visible in the evidence: gh issue close 109 and real typecheck/test output"
  ]
}
```
