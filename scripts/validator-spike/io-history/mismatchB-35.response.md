The task required an atomic check-and-claim in `sendChatMessage` in `src/lib/chat.ts`, plus a regression test for the race. The branch's own diff is empty, with 0 files changed.

The history section lists one commit with a trailer naming this task, 83fa7ab8. It changes only `docs/verification.md`, recording a CLI sandbox measurement. It doesn't touch `src/lib/chat.ts`, `sendChatMessage`, or any test. The server says a listed trailer isn't evidence the commit holds this task's deliverable, and this one doesn't. Neither the branch diff nor the history shows the chat fix or the regression test.

```json
{
  "verdict": "not-finished",
  "reason": "Empty branch diff; the only task-trailered history commit edits docs/verification.md about CLI sandboxing, so no src/lib/chat.ts change or regression test is present.",
  "evidence": [
    "Branch diff: 0 files changed, +0 -0",
    "History commit 83fa7ab8 touches only docs/verification.md (sandbox measurement), unrelated to sendChatMessage",
    "No change to src/lib/chat.ts and no regression test appear in the diff or the history"
  ]
}
```
