# Option C: direct, addressed messages between live runs, through the app

## 1. Its strongest case

This is the operator's idea taken literally, built where this app can see and
bound it. Run A tells run B, which it knows is live on the same repository: "I
have fixed `0da625d` on my branch, do not redo it." That is the one measured
redo ([`00-problem.md`](00-problem.md) §3), and it is a sentence only A could
have sent. The CLI already offers this. Built in the app, it would be scoped to
the project, durable, logged and bounded, which the CLI's version is not.

## 2. Shape

There are two forms, and the second is the only one this survey takes seriously.

- **C-new.** `send_to_run({ to, body })` and a `run_messages` table.
  - Delivered pull-only: `list_my_tasks` returns unread messages.
  - `to` is a short id from a roster of live siblings on the same `runs.folder`.
  - A recipient outside the roster is refused.
  - Cost: one new tool, one new table, a roster.
- **C-board.** No new tool and no new table. The sibling roster (Option G3)
  carries each live sibling's **held task id**. A note written with the existing
  `comment_on_task` on that id reaches the sibling whole at its next
  `list_my_tasks`, on the rule that already exists
  (`docs/agent/taskboard/comments.md:72`-`:78`). The "address" is the task, the
  sender is the token, and the store is `task_comments`, never swept.

## 3. When a message is read

At the receiver's next `list_my_tasks`, mid-cycle, when the receiving agent
chooses to ask. Delivery "between cycles", in the next resumed `-p`, is
possible: `pendingPushback` is the precedent (`src/lib/orchestrator.ts:9177`).
It is refused for Option B's reason, because the app would be composing a peer's
words into its own slot (C8 rule 3).

## 4. Metering and guards

- It starts and extends nothing.
- A parked run's message waits for the run, never the other way round.
- **C4 is the live question.** An addressed message to a writing sibling is a
  request to write. In C-board that sibling is working its own task in its own
  worktree, and its note arrives as a note on that task. That frames it as
  information about the task rather than an order.
- C-new arrives with no such frame.

## 5. Restart

Both forms survive, as rows. A message held for a run that `reconcileOnBoot`
closed stays on the task. If the task is released, the next holder reads it,
which is the correct recipient.

## 6. What the operator sees

- C-board: the task page, where every note is already shown.
- C-new: a new view.

In both, `run_events` holds the sender's call.

## 7. Isolation and injection

Addressed is narrower than broadcast, and that is its whole advantage over B. One
message reaches one run. A forwarding payload must name each next victim, and
every hop is a permanent, signed row the operator can read.

It is still free text between unattended agents, and two facts weaken the
signature:

- Siblings can read each other's tokens
  (`docs/agent/security/child-uid-and-credentials.md:13`).
- `comment_on_task` checks only that a task exists (`src/lib/taskComments.ts:270`).

So authorship is evidence, not proof (C9).

## 8. Cost to build

- **C-board**: about a day on top of G3, which already pays for the roster. One
  field per roster row, plus one sentence in `list_my_tasks`'s description.
- **C-new**: 2-3 days, and one standing tool definition at $8.14-$8.26 a week.

## 9. What would have to be true

There must be messages only a sibling's words could carry. Measured on this
install there is one candidate, the redo. And in that case the run already knew
about the sibling commit: it chose to redo the work because the commit "is not
on mine". A message would have told it what it already knew. No measured case
needed an addressed message.

## Verdict

**C-new rejected; C-board is the runner-up.** If the operator wants runs to talk
at all, C-board is the smallest step that does it. It adds no tool and no table,
gives authorship from the token, never expires, is pull-only and is visible on a
page that already exists. Its one new exposure is that a run learns which task
each sibling holds. It is not recommended now, because nothing measured needs it.
[`11-recommendation.md`](11-recommendation.md) names the measurement that would
make it worth that exposure.
