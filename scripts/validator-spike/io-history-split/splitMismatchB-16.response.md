The task asked for a pure function extracted from `sweepPaused` in `orchestrator.ts`, exported and unit-tested for four branches, plus an issue-close comment. The branch diff touches only two files. `CLAUDE.md` gains a mention of `duePausedRuns` / `planPausedRun`, and `src/lib/orchestrator.test.ts` gets a comment block and a reworded assertion. There is no `orchestrator.ts` change and no new test for the four branches. The context lines show that "the parked sweeper's decision" and "applying the sweeper's decision" describe blocks already existed at the base, so an earlier commit may have done the extraction and tests. The three history commits are unrelated UI changes (`RunCard.tsx`, `LiveTelemetry.tsx`, `Meter.tsx`) and don't contain it. The close comment on issue #109 is outside the repository and can't be seen. The evidence neither shows the deliverable nor proves it absent, so it can't be settled.

```json
{
  "verdict": "unjudgeable",
  "reason": "Diff is only CLAUDE.md plus a test comment; the extraction and tests may predate the branch, but no listed commit or hunk shows them, and the issue close is external.",
  "evidence": ["diff touches only CLAUDE.md and src/lib/orchestrator.test.ts (comment and one assertion)", "no src/lib/orchestrator.ts change in the diff", "existing describe blocks for the sweeper's decision appear only as hunk context at the base", "history commits are RunCard.tsx, LiveTelemetry.tsx, Meter.tsx, unrelated to the task", "gh issue close 109 is not visible in a diff"]
}
```
