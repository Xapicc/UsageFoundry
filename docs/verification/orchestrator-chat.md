# Verification: Orchestrator chat

[← Verification index](../verification.md)

## Verified

- **Orchestrator chat end to end, real CLI 2.1.226:** a chat proposed a run
  from a saved template, it was approved and completed ($0.22 the turn, $0.165
  the run), and `/api/mcp`'s hand-written handlers served the pinned CLI.

- **Chat thread order, `npm test` 3 cases, real database:** same-millisecond
  messages keep insert order across a reopen and over null-`seq` rows; the
  migration, on three rows from the live deployment, put the reply back above
  its denial note.

- **Under `manual` plus an allowlist the chat could not write** (`No such tool
  available: Write`). That is not what ships: it now runs `bypassPermissions`
  with no tool list, held back only by its system prompt.

- **`--permission-mode plan` cannot run the chat:** every MCP call answered
  `Cannot call mcp__uf__list_templates while in plan mode`.

- **The chat child gets the fill and the sweep, 2026-09-09.** Before: 118
  bwrap failures in 53 of 192 `-workspace` sessions (67 `.claude` list, 35
  config dir, 16 `/workspace` root, which it leaves). A bwrap-effect stub via
  `runOrchestratorChild` left ten placeholders at `HEAD~1` and only the
  operator's `?? .vscode/` at `HEAD`. Deliberately no `core.excludesFile`.

- **A chat turn streams and survives a crash, 2026-09-06**, fake `CLAUDE_BIN`,
  nothing billed: `partialText` grew, then settled to the CLI's `0.0731`; after
  a `SIGKILL` the boot pass kept the half-answer, cost `0.022` marked
  `estimated = 1`; a $0.025 install ceiling stopped it mid-turn, $0.03 did not.

- **A stale Approve on a superseded proposal is refused, 2026-09-08**,
  standalone server, non-spawning `CLAUDE_BIN`, 13/13 assertions: "Nothing was
  approved…", zero runs, the badge counting only the replacement, and the
  `SUPERSEDED` card linking to it.

- **The chat naming a model, driven in-process through `/api/mcp`.** With a
  minted capability, `propose_run` and `save_template` write and state a named
  model, store null for a blank, and `save_template` keeps it when omitted;
  guards unchanged. The migration survived seeded rows and the
  pre-`relaxProposalTemplate` schema. `npm test` 2,139 tests / 0 failures.

- **The `ask_operator` card was rendered and clicked in Chromium at 1440×1000
  and 390**, over hand-seeded threads with `POST /api/chat/[id]/questions`
  intercepted: six card states and the `asked you` marker drew, dark and 390px
  held, its text controls are 16px below `md`, and a choice sends on one press
  only when it is the only open question.

- **One poll of an open chat thread is flat in its length, 2026-09-07**: on a
  throwaway database, 246,362 bytes to 1,136 at 500 messages and 1,004,522 to
  1,137 at 2,000, the cursored read now on `idx_chat_messages_seq` with no
  sort. A thread's first read costs 2.0% more, once.

- **`propose_schedule`, `list_past_proposals` and `list_recurring_failures`,
  driven in-process through `/api/mcp`, 2026-09-14.** Throwaway `DATA_DIR`, a
  minted chat capability, no CLI. `propose_schedule` refused an unbudgeted
  workflow, `25:00`, an unknown zone and a second waiting card for one workflow;
  `supersedes` replaced one; approval through `POST /api/chat/[id]/proposals`
  wrote the schedule and the thread note, and a card whose workflow then lost its
  limits was refused on the card and at the click. The failures tool returned a
  seeded note with its vault path and the unwritten recurrence; the proposals
  tool excluded the asking thread and reported a purged run as gone. Three
  sentences were wrong and were fixed before this entry. Caveat: no model called
  any of it.

- **The schedule card rendered under `next dev` at 390 and 1280, 2026-09-14**,
  over a seeded thread: replacing a paused schedule, refused after its limits
  were cleared, an interval, a run card beside them, and an approved row reading
  "— scheduled". No sideways scroll, no console error, `Select all (skips 1)`.
  Not clicked; not the standalone build.

## Not yet verified by hand

- **Whether the shipped chat leaves files alone when a fix is one edit away
  has not been measured.**

- **No chat turn has run the fill against a real CLI, 2026-09-09.** `bwrap`
  cannot nest in that container and a live turn would bill unattended; the
  stub is not bwrap. Expected after a rebuild: 51 failures, not zero, and no
  tree-root name in the turn's `git status --porcelain`.

- **No chat turn has run through the real CLI's `stream-json --verbose`**; the
  pair is only the one work cycles pass (`cycleInvocation.ts:1075`).

- **The stale-Approve check used two seeded proposals**, so `propose_run`'s
  `supersedes` is covered only by `chat.test.ts`.

- **The proposal card's model row has never been drawn**, and no live
  orchestrator turn has shown whether a model names a sensible model or reads
  the field as licence to argue for guards.

- **A chat reaching `MAX_PENDING_PROPOSALS` (25) or `MAX_REMOTES_READ` (25).**
  Both are reasoned, never hit; behaviour at the cap mid-answer is unseen.

- **Ordered proposals and proposed workflows, against a real CLI.** Unit
  tested only; no CLI has called `propose_workflow` or passed a `dependsOn`.

- **The chat's inspection tools and untemplated proposals.** `get_run`,
  `get_run_diff`, `get_usage`, `list_proposals` and `save_template` typecheck;
  no real CLI has called one.

- **That an unrestricted chat stays an orchestrator.** It runs
  `bypassPermissions` with push credentials; only a `systemPrompt()` paragraph
  stops it editing. Untested against a real CLI.

- **Stopping a chat turn, in either of its two forms.** `staleTurn` is unit
  tested; no CLI child has been signalled by `cancelChatTurn` and no sweep has
  fired on a live row. The no-child half of both, free (then load `/chat`):
  ```bash
  sqlite3 $DATA_DIR/usagefoundry.db "update chat_sessions set status='thinking', turn_started_at=…, partial_at=… where id=…"
  ```

- **A chat turn's silence bound, in all three places.** Unit tested where
  pure; no real child has shown a turn past fifteen minutes surviving.

- **Switching Orchestrator threads, in a browser.** The cross-thread 400's
  sentence is unit tested; the click and the red banner are unwatched.

- **The *Earlier chats* two-line rows, in a browser.** Never rendered in the
  360px column; how they read against the 6px gap is unmeasured.

- **The chat page recovering from a dropped request, in a browser.** Unit
  tested; no one has stopped the server and pressed Send.

- **The chat page's failed-poll notice, in a browser.** Its sentence is unit
  tested; its appearing and clearing are unwatched.

- **The "Earlier chats" list refreshing on its 10s poll, in a browser.** The
  route is unit tested against the handler; the sidebar is unwatched.

- **Whether the pinned CLI ends an `ask_operator` turn when told to is
  unmeasured**; only prose ends it. Test: ask something under-specified, watch
  whether it asks once and stops. Also unmeasured: `--resume` carrying the tool
  call, the caps (5 questions, 8 choices), an exchange's cost, `chat_questions`
  on a real database, and a stranded turn writing into an idle chat.

- **No `ask_operator` answer has reached a real turn, and no model has called
  it**: `answerChatQuestions` → `sendChatMessage` → `claude -p` runs only in
  unit tests, and the when-to-ask prompt paragraph, paid every turn, is
  unmeasured. No screen reader or reduced-motion pass; `busy` seen only against
  an instant stub; the eight-step click list is unwalked against a real turn.

- **The chat has never been shown a workspace with more than twenty-five git
  repositories.** `list_folders`' paging is covered only by
  `remoteReads.test.ts` over the pure selection; no model has been seen to read
  `notRead` and call back with the offset it was handed.

- **No browser has held a chat open across a turn landing (2026-09-07)**; the
  append path is unit-tested only. Unseen: a mid-turn reply appending, the
  unseen count and scroll on a tail, a thread switch mid-poll. Open `/chat`,
  send a message to a thread with history, and watch the reply land.

- **No model has called `propose_schedule`, `list_past_proposals` or
  `list_recurring_failures` (2026-09-14).** Unmeasured: whether a turn reaches
  for the two read tools on the system prompt's pointer alone, whether it asks
  for a time zone rather than guessing one, and what a cold
  `list_recurring_failures` scan adds to a turn on a real corpus. Settling it:
  on a real install with a saved, budgeted workflow, ask the chat to "run the
  sweep every Monday morning" and to "fix the bwrap failures", and read the
  turn's tool calls and cost.

- **No model has proposed a run with a provider (2026-09-28).** `propose_run`
  gained `provider`, pinned in `route.test.ts` and `chat.test.ts` against the
  refusals and the row; no real turn has been shown the field, and no card
  carrying one has been approved in a browser. Settles by asking the chat for
  a Codex run in a folder whose template has a work-cycle limit, then
  approving it and reading `runs.provider`.
