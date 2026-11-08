# Commits-in-history arms

| arm | n | finished | not-finished | unjudgeable | other | as expected |
|---|---|---|---|---|---|---|
| today | 7 | 0 | 7 | 0 | 0 | 0/7 |
| match | 7 | 7 | 0 | 0 | 0 | 7/7 |
| mismatch | 7 | 0 | 7 | 0 | 0 | 7/7 |
| mismatchB | 7 | 0 | 7 | 0 | 0 | 7/7 |

False-finished (a mismatch arm answered finished): **0 of 14**

| request | history from | expected | got | reason |
|---|---|---|---|---|
| today-03 | - | finished | not-finished | Task required a markup change to the Earlier chats list in src/app/chat/page.tsx; the branch diff is empty, so the deliverable is absent. |
| match-03 | 3 | finished | finished | Commit ad50a199 in the branch history reworks the Earlier chats row in src/app/chat/page.tsx so the time and waiting count sit outside the truncating title, which has a title tooltip. |
| mismatch-03 | 4 | not-finished | not-finished | Branch diff is empty and the only history commit adds a chat Stop button; nothing changes the Earlier chats list's timestamp or waiting-count layout. |
| mismatchB-03 | 35 | not-finished | not-finished | Branch diff is empty and the one history commit (906a5058) is a chat-turn race fix in chat.ts; nothing touches src/app/chat/page.tsx or the Earlier chats list layout. |
| today-04 | - | finished | not-finished | Empty diff on the branch (0 files, +0 -0), but issue #22 plainly required a committed recovery path and a regression test in the repository. |
| match-04 | 4 | finished | finished | History commit 8e6a4376 adds the cancel route, Stop button, sweeper with live-child signal ladder, and staleTurn tests; every deliverable in the task prose is present, though the issue's own boxes are unreadable. |
| mismatch-04 | 5 | not-finished | not-finished | Branch diff is empty; the only history commit prevents a pre-spawn strand (a #19/#20-style fix), and adds no operator-reachable recovery for an already-thinking chat or live-child check. |
| mismatchB-04 | 3 | not-finished | not-finished | Diff is empty; the only trailer-tagged history commit (ad50a199) restyles Earlier-chats rows and adds no thinking-chat recovery, live-child safety or regression test. |
| today-05 | - | finished | not-finished | Task required a fix in src/lib/chat.ts runTurn and a regression test, but the branch diff is empty: 0 files changed, nothing committed. |
| match-05 | 5 | finished | finished | History commit 889d4a06 adds the try/catch in sendChatMessage settling the row to failed, cleanup in runTurn/writeMcpConfig, and a new regression test chatTurn.test.ts. |
| mismatch-05 | 35 | not-finished | not-finished | Branch diff is empty; the only history commit fixes a different race in sendChatMessage and does not touch runTurn's pre-promise MCP-config failure path or test it. |
| mismatchB-05 | 4 | not-finished | not-finished | Branch diff is empty; the one history commit adds cancel/sweeper recovery, with no pre-promise error handling in runTurn and no regression test for the MCP config write throwing. |
| today-11 | - | finished | not-finished | Diff is empty; the task required a fix in src/components/RunLand.tsx and a commit, and nothing shows the issue-closed or critical-decision exit was taken. |
| match-11 | 11 | finished | finished | Commit e648eefb in history makes RunLand.tsx seed the default only while unchosen, with one effectiveStrategy for select, act and note; test/issue-close not visible. |
| mismatch-11 | 13 | not-finished | not-finished | Diff is empty; the required RunLand.tsx strategy fix is absent, and the one history commit (9433d0b8) only changes schedules.ts and is unrelated to issue #48. |
| mismatchB-11 | 30 | not-finished | not-finished | Diff is empty and the only history commit edits docs/verification.md only; the RunLand.tsx strategy fix the task required is absent. |
| today-13 | - | finished | not-finished | Diff is empty; the task required a zonedTime fix in schedules.ts, new Santiago/Havana tests and a commit, and none of these is on the branch. |
| match-13 | 13 | finished | finished | Commit 9433d0b8 in history changes zonedTime with a zonedParts date check and adds Santiago/Havana daily 00:00, 00:30 and weekly-Sunday tests; issue closure and test runs are not visible. |
| mismatch-13 | 30 | not-finished | not-finished | Empty branch diff; the only trailer-tagged commit edits docs/verification.md (sandbox notes). No change to schedules.ts zonedTime and no Santiago/Havana tests appear anywhere. |
| mismatchB-13 | 11 | not-finished | not-finished | Empty branch diff; the only trailer-linked commit edits RunLand.tsx, unrelated. No change to schedules.ts zonedTime and no Santiago/Havana tests in schedules.test.ts appear anywhere. |
| today-30 | - | finished | not-finished | Task required a committed fill-in of the docs/verification.md sandbox results table; the branch diff is empty, 0 files changed. |
| match-30 | 30 | finished | finished | History commit 83fa7ab8 fills the docs/verification.md sandbox table with Q1-Q4 and Q8a tokens, CLI/bwrap/uname versions, the Phase 4 untested note and the probe.test.sh result. |
| mismatch-30 | 3 | not-finished | not-finished | Task required committing a filled sandbox results table in docs/verification.md; branch diff is empty and the only history commit is an unrelated chat-page UI change. |
| mismatchB-30 | 13 | not-finished | not-finished | Task required committing filled Q1-Q4 results to docs/verification.md; branch diff is empty and the one history commit only changes schedules.ts and schedules.test.ts. |
| today-35 | - | finished | not-finished | Diff is empty (0 files, +0 -0); the task required an atomic check-and-claim change in sendChatMessage in src/lib/chat.ts and a regression test, and neither exists. |
| match-35 | 35 | finished | finished | History commit 906a5058 adds claimTurn, an atomic conditional UPDATE claim in sendChatMessage with no await before the spawn, plus a two-message Promise.all regression test in chat.test.ts. |
| mismatch-35 | 5 | not-finished | not-finished | Branch diff is empty; the only trailered commit fixes a stranded-thinking turn, not the check-then-claim race in sendChatMessage, and no concurrent-send regression test exists. |
| mismatchB-35 | 30 | not-finished | not-finished | Empty branch diff; the only task-trailered history commit edits docs/verification.md about CLI sandboxing, so no src/lib/chat.ts change or regression test is present. |
