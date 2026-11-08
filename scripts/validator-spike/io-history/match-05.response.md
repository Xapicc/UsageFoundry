The work for issue #19 is present in the branch history as commit 889d4a06, "Fail a chat turn that cannot start, instead of stranding the thread". The branch's own diff is empty, so I judged against that commit. Its title and content match the issue. I could not run anything, so this means the change is there, not that it works.

- **Pre-promise failure path:** `sendChatMessage` in `src/lib/chat.ts` now wraps the `runTurn(...)` call in a try/catch. On a throw it calls `finishTurn(chatId, {status:"failed", error: "Could not start the turn: ..."})` and returns `{ok:false, reason}`. That moves the row out of `thinking` and surfaces the error.
- **Cleanup inside the window:** `runTurn` catches a throw from `writeMcpConfig`, revokes the minted capability and rethrows. `writeMcpConfig` unlinks a partly written file. Both stay inside the pre-promise window, so this is not a restructure of `runTurn` or a general recovery path.
- **Regression test:** `src/lib/chatTurn.test.ts` is new. It points `TMPDIR` at a missing directory so the config write fails, then calls `sendChatMessage`. It asserts `res.ok` is false, the row status is `failed` rather than `thinking`, and the error text survives (`ENOENT`). It also asserts the failure shows in `listMessages` and that no capability is left live. I cannot see a before/after run.
- **CLAUDE.md:** the commit also edits it to document the new test.

I cannot see the issue's acceptance-criteria boxes, only the task's own "Done looks like". Every part of that is present.

```json
{
  "verdict": "finished",
  "reason": "History commit 889d4a06 adds the try/catch in sendChatMessage settling the row to failed, cleanup in runTurn/writeMcpConfig, and a new regression test chatTurn.test.ts.",
  "evidence": [
    "src/lib/chat.ts: sendChatMessage try/catch calls finishTurn status failed and returns ok:false with 'Could not start the turn'",
    "src/lib/chat.ts: runTurn revokes the capability and rethrows on a writeMcpConfig failure; writeMcpConfig unlinks the partial file",
    "src/lib/chatTurn.test.ts: new test with TMPDIR set to a missing directory, asserting status failed not thinking, the error visible in the thread, and no live capability",
    "CLAUDE.md: documents the new chatTurn.test.ts"
  ]
}
```
