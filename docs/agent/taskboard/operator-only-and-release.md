# Operator-only tasks and giving a task back

[← taskboard index](../taskboard.md)

Read before editing `operatorOnlyRefusal` in `src/lib/tasks.ts`, `releaseTask` in `src/lib/taskRelease.ts`, or anything that shows an agent open work.

**Operator-only is a flag, not a fifth status, and it says who may do the work
rather than where the task is.** `tasks.operator_only` marks work no run in this
container can do: it needs a Mac or a GUI, hardware, credentials only the
operator holds, or a physical action. An operator-only task is still `open`, and
that is the reason it is a column rather than a status: a fifth status would have
to be threaded through every edge of `taskTransitionRefusal`, and it would stop
meaning "open" to every reader that already asks for open work — the board's
groups, `tasksForRun`, the chat's `list_tasks`, a loop's count. The one edge the
flag changes is `open → claimed`: a claim naming a **run** is refused whoever
asks, because the flag says no run here can do the work, and a claim on one is a
run spending its budget finding that out again. The operator's own claim, which
names no run, is allowed, and it is what an operator-only task is waiting for —
"I am doing this myself", with the board saying who holds it, which is otherwise
the one thing the operator's own lane has no way to say. Handing it to a run is
still clearing
the flag first, which says the blocker is gone rather than claiming past it. A
task already claimed when the flag is set keeps its claim, because a claim is a
record and taking it off is a release. The operator still closes and drops one
the ordinary way. It defaults to false on an existing install (`addColumn`, `NOT NULL
DEFAULT 0`), because every row filed before the column existed was filed as
agent work — there was no other kind.

**Who may move the flag is `operatorOnlyRefusal`, beside the transition rule, and
a model may move work into the operator's lane and never out of it.** Same shape
as `taskTransitionRefusal`: pure, total, one wording for every door, and asked by
both writers — `createTask` against the actor the origin names, `updateTask`
against the row.

| Actor | File a task marked | Mark an existing task | Clear the mark |
|---|---|---|---|
| operator | yes | yes | yes |
| run | yes, through its `create_task` | only a task it holds, in the write that releases it (`release_task`) | no |
| chat | yes, through chat `create_task` | no | no |
| block | no | no | no |

**Only the operator clears it**, which is the board's "may put work on, never take
it off" applied to this flag: cleared by a model, it is a run started on work
somebody was told needs a Mac, spending its budget finding that out again. A
**run** may mark only in the write that moves its own claim back to `open` — the
rule reads that move off the row rather than taking a caller's word for it, and
asks `taskTransitionRefusal` for the holder check instead of keeping a second one.
It is the only actor that has *tried* the work, which is what earns it the
judgement that the environment is the blocker. A **chat** may file a task already
marked, because it is writing down what the operator just told it with the
operator at the keyboard, but may not mark one already on the board, which is a
judgement about work it has not tried; `comment_on_task` is where it says what it
knows. A **block** does neither: it has no door that files a task, and nobody is
reading its turn to weigh the claim.

**Where an agent is shown open work, the flag rides beside the status.**
`list_my_tasks` carries `operatorOnly: true` on both halves only when set — the
result is paid for by the token on every call, and its `note` says what the
absence means — and marks rather than drops the operator-only rows of
`openInFolder`, because that half exists so a run does not file a duplicate, and
an operator-only task is still a task somebody already wrote down. `list_tasks`
returns the flag on every row and takes an `operatorOnly` filter, refused by name
when it is not a boolean; `get_task` returns it. `readTaskLinks` refuses an
operator-only id in **`taskIds`** — on `propose_run` and `emit_runs` alike, since
both read through it — and names `relatedTaskIds` as the way to say the brief
only mentions it. That is refused at the proposal rather than left to the claim
because a claim refusal is a log line on a run that has already started. A task
**the operator holds** is refused in `taskIds` on the same two doors with the
same way out, for the same reason — the run would start, fail to claim it, and
do the work beside the operator — and `list_tasks` and `get_task` carry
`claimedByOperator` beside `claimedByRunId` so a model can see it first. The rule
that a named open task must be accounted for is untouched: an operator-only task
named in a brief and in neither list is refused exactly as any other is. A
proposal already written names its tasks as they were when it was written; one
marked between the proposal and the approval is refused at the claim, on the run's
log, the same as a task deleted in that gap.

**A loop's board count leaves operator-only tasks out.** `countBoardCondition`
counts `operatorOnly: false` only. No pass can bring an operator-only task down,
so a loop told to repeat until at most N are open would otherwise never stop once
the operator's own lane held more than N — it would run to its pass cap, every
pass looking as though it had done its work. The loop editor's live reading goes
through the same function and shows the same number.

**A run gives back a task it cannot finish with `release_task`, and the move and
the reason commit together or not at all.** Before it existed the edge
`claimed → open` was allowed to the holder with no tool that made it, so a run
that could not finish — a Dockrac run on Linux arm64 asked for Mac work — could
only end with its task still `claimed`, and the board showed it held by a run
that had finished. The tool takes `taskId`, a required `reason` and an optional
`operatorOnly`. `releaseTask` in `taskRelease.ts` moves the task through
`updateTask` (so `taskTransitionRefusal` is still the whole of who may, and the
run id is still the token's), writes the reason as a note signed by the run, and
sets the flag if asked — all inside one `db.transaction`, because a release that
opened the task and lost the reason sends the next run to try the same thing
again with nothing saying it was tried. A note the store refuses rolls the move
back; that is pinned by forcing the insert to fail. `taskRelease.ts` is its own
module because this is the one write across both tables, and `tasks.ts` must not
import `taskComments.ts` while `taskComments.ts` must not call `updateTask`. It
refuses a task that is already `open`, which is the one check it adds: `open →
open` is not a move and the transition rule allows it for anybody, so without it
any run could sign a release note on any open task. The reason is bounded at
`MAX_RELEASE_REASON`, which keeps the note it becomes — a fixed first line saying
it was a release, and whether it was marked, then the run's words — inside
`MAX_TASK_COMMENT`, so a reason the tool took is never refused by the store for a
length the caller never typed. The note is where the operator reads it: the
task's thread already draws a run's note with its whitespace, and there is no
second place. The description says when to use it (the run cannot finish, and
another run or the operator should take the task) and what the flag is for —
blockers this container cannot remove, **not** work that was hard, long or
unclear, which is a plain release for the next run.

**Needs-frontier is operator-only's shape one lane over: a flag, not a status, saying a local model may not do the work.** `tasks.needs_frontier` is set by a workflow's review block when it sets a local model's branch aside after its last fix round (`setAside` in `workflows.ts`), or by the operator from the task page; `needsFrontierRefusal` lets any actor set it and only the operator clear it, for "may put work on, never take it off" — cleared by a model, it is a local run put straight back on work a frontier review already turned down. It gates nothing but local-model runs: `readTaskLinks` refuses a flagged task in `taskIds` when `opts.localRun` is set, which reaches a local block's emission and a local `propose_run`, and a Claude or Codex run may still take it on. It rides beside the status in `list_tasks` and `get_task` for operator-only's reason. `docs/agent/workflows-and-schedules/review-blocks-and-providers.md` has when it is set, and when the task is reopened with it — the one move a review block makes on the board, pinned in `tasks-and-transitions.md`'s table.
