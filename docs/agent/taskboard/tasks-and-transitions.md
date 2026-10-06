# Tasks, status transitions and the task row

[← taskboard index](../taskboard.md)

Read before editing `taskTransitionRefusal`, `updateTask`, `normalizeTaskInput`, `resolveTaskFolder` or `listTasks` in `src/lib/tasks.ts`, the `tasks` table, or `src/app/api/tasks/`.

**A task is not a run, and the absence of every hook that would make it one is
what keeps this feature out of the orchestrator.** `run_templates`' rule, and the
same reasoning as `agents.ts`: a row in `tasks` claims no folder, consumes none
of `maxConcurrentRuns`, is invisible to `activeRuns()`, spawns nothing, and no
guard, budget, sweep or occupancy check reads the table. The three run id columns
— `created_by_run_id`, `claimed_by_run_id`, `completed_by_run_id` — are *records
of what happened* and never handles the scheduler acts on; that is why none of
them is a foreign key onto `runs` (`dreaming_notes.run_id`'s reasoning: nothing
in this app deletes a `runs` row, so a cascade would describe a deletion that
never happens). What a task holds is a **brief** — the text a future agent is
handed with nothing else to go on — and the whole point of the board is that
writing one down costs nothing and starting the work is a separate decision
somebody makes later. The day something here starts, queues or bounds a run is
the day this paragraph stops being true, and it is a decision rather than a
detail.

**`claimed` is a record of who holds a task — a run, or the operator. It is not
a lock, it has no clock on it, and nothing on this path may acquire one.** The obvious next feature
is a lease — claim expires after an hour, so a run that died holding a task does
not strand it — and it is the wrong one, for a reason that is specific to this
app rather than general. A work cycle here has no upper bound on how long it may
legitimately hold anything: it can be parked for a provider's weekly wall, held
behind the 429 ladder, waiting on a dependency, or simply running a cycle that
takes hours, and `run-lifecycle.md` is a document about exactly how many ways a
live run can look idle. A lease tuned short enough to release a *dead* run's task
would release a *parked* one's, and the failure that produces is the expensive
one on this feature: two agents given the same brief, in the same folder, with
nothing anywhere saying that happened. A lease tuned long enough not to would
release nothing anybody was waiting on. So a stale claim is left standing and is
the operator's to release — `claimed → open` — which is a press on a board they
are already reading, against a run whose status they can see on the same screen.
The lever that exists is visibility, not expiry. `release_task` does not change
this: it is the holding run giving the task back by its own decision while it is
still alive, never something that fires when a run ends, fails or is stopped. A
run that dies holding a task still leaves the claim for the operator. Nothing here calls
`setTimeout`, nothing stores an expiry, and `updated_at` is a record of the last
edit rather than a countdown; a future editor reaching for a `claimed_at` should
know that the column's absence is the decision. The operator's own claim is the
same record with no run in it, and carries no clock for the same reason: a
person doing the work by hand is the slowest holder there is.

**Who may move a task to which status is one pure function, and it is the whole
of the board's authority model.** `taskTransitionRefusal` in `tasks.ts` takes a
pair of statuses, an actor and the row's own holder — `claimed_by_run_id` and
`claimed_by_operator` — and answers
with a sentence or with null — `agentRefusal`'s shape, for `agentRefusal`'s
reason: three doors will eventually ask it (the operator's route, a chat tool, a
work cycle) and one wording is what stops them disagreeing about the same move.
Eight edges exist and every pair not on the list is refused:

| From | To | Who |
|---|---|---|
| `open` | `claimed` | any actor, and the claim names the run that will hold it — or the operator, with no run, holding it themselves; while the task is operator-only, **only** that second kind |
| `open` | `done` | operator only — a run claims first |
| `open` | `dropped` | operator only |
| `claimed` | `open` | operator, or the run that holds it (releasing, through `release_task`) — or a review block, for a rejected run's claim (`reopenRejectedTask`) |
| `claimed` | `done` | operator, or the run that holds it |
| `claimed` | `dropped` | operator only |
| `done` | `open` | operator (re-opening) — or a review block, for a tick a rejected run left (`reopenRejectedTask`) |
| `dropped` | `open` | operator only |

Four of those are load-bearing beyond their own row. **A run may complete only
the task claimed in its own name** — not "a task", and not "a task some run
claimed": the row's `claimed_by_run_id` has to be that run, and a `claimed` row
holding a null completes for nobody, because two nulls comparing equal would let
any run close any orphaned claim. The failure that closes is the one this whole
file exists for: a work cycle that read the board, picked the wrong id out of a
list, and marked it done. Nothing throws, the board says the work happened, and
the task nobody did is gone from every view. **`chat` and `block` may put work on
the board and may never take it off.** The brief names `chat`; `block` is refused
on the same ground rather than by omission, because "completion belongs to the
run that did the work, or to the operator" excludes anything that is not that run
by construction — an orchestrator block decides and emits, a chat turn proposes,
and neither does the work. **Only the operator drops or deletes.** Dropping is a
judgement that the work should not happen at all, which is not a machine's call
on a person's backlog, and deleting is the row going away — `dropped` is what a
machine's "this should not happen" looks like and it is still on the board where
somebody can disagree with it. **A terminal task is re-opened before it is
anything else**: there is no `done → dropped` and no `dropped → done`, which is
what keeps the edge set small enough to hold in one's head.

**A claim names its holder, and the operator can be one.** The operator claiming
a task says "I am doing this myself": the board shows who holds it, and no run
is pointed at it. It is stored as `tasks.claimed_by_operator` beside
`claimed_by_run_id` rather than as a sentinel id *in* that column, because that
column is read as a run everywhere — `tasksForRun`, completion validation, the
run link on the board — and an invented id is a run no `runs` row answers for.
A `claimed` task has exactly one holder, and `updateTask` is the writer that
keeps it so. A claim naming nobody is the operator's alone: from any other actor
it is the record of a holder that does not exist, which nothing would ever
release. It is taken from `open` only — a task a run holds is released first and
claimed second, so taking work off a run is two presses the operator sees, never
the side effect of one, and the table keeps its eight rows. **Nothing but the
operator moves a task the operator holds**: a run, a chat or a block is refused
its release, its completion, its drop and even a restated claim, and the refusal
names the operator rather than reading the null run column as "nobody holds it".
That one is checked before `from === to` below on purpose: a run claims its
tasks when it starts, and against the operator's claim that would otherwise be
an allowed no-op its log could only report as held by nobody.

`from === to` is not a move and is allowed for every actor, so an update that
restates the status it is not changing is a no-op rather than a refusal — the
one exception being a non-operator restating `claimed` on a task the operator
holds, above. `updateTask` asks the rule whenever a patch carries a status and
applies a move's effects only when the status actually differs, which is what
keeps a patch from applying them when nothing moved. A run's `complete_task`
and `release_task` never reach this no-op for a task the run does not hold:
the MCP door refuses those first (`notHeldByRun`, `mcp-surface.md`), so it
cannot answer a run as though it had closed somebody else's work.

**A write that changes nothing is not written, so `updated_at` does not move.**
That column means the task moved — `idx_tasks_board` and `listTasks` both sort on
it — and the write is what stamps it, so `updateTask` compares the row it built
against the one it read and returns the stored row untouched when no column
differs. The case that needed it was `claimTasksForRun` when it asked again on
every pick-up, resume and restart of a run (it now asks once,
`runs-from-tasks.md`): each re-claim by the holder, and each no-op against a
task another run holds, lifted the task to the top of its priority group in
Claimed, the same false signal a comment or an edge is refused
the right to send. A `PATCH` restating a value is the same no-op, and a `PATCH`
body that does not parse is a 400 rather than being read as the empty patch,
which answers 200. `WRITTEN_TASK_FIELDS` is the list compared, and a column
added to the `UPDATE` without joining it is skipped whenever it is the only
thing a patch changes.

**A move's effects are the other half of the rule, and re-opening deliberately
clears both run columns.** Into `claimed`, the claim names its holder — the run,
or the operator with the run column null — and `closed_at` is cleared. Out of
`claimed` into anything, the operator's claim is cleared, `dropped` included:
unlike the run column, which `tasksForRun` reads to show a run what it closed,
nothing reads the operator's claim on a task that is no longer claimed, and a
set flag on a closed row is a holder the board cannot draw. Into `done`, `completed_by_run_id` is the acting run, or null when the
operator marked it — a person is not a run, and inventing one would put a run id
on work no run did. Into `dropped`, `closed_at` is set and `completed_by_run_id`
is left alone, because nobody completed it. Into `open`, both run columns are
cleared: a task that is open while naming the run that completed it is a
contradiction every surface drawing the board would have to explain, and a
re-open is the operator saying the work is not done. What that costs is the
record of who had done it before, and the trade is deliberate — the mutation
itself is on `request_log` and in `ops_events`, and a board whose columns
contradict its own status is worse than a board that has forgotten one thing.

**`GET`/`POST /api/tasks` and `GET`/`PATCH`/`DELETE /api/tasks/[id]` are
operator-facing and behind the app's ordinary gate**, and the actor is a constant
in the route rather than anything read off a request. That is the point: a route
that could be persuaded to act as another actor kind would be a route around the
rule above, so the way a run or a chat turn gets access later is a door of its
own carrying its own credential — not a field on this one's body. Both mutating
handlers are wrapped in `auditMutation`. The list route reads `offset`, `limit`,
`status`, `origin`, `mountId`, `folder` and `operatorOnly` off `searchParams`
and refuses an unknown `status` or `origin`, or an `operatorOnly` that is not
`true` or `false`, with a **400** rather than dropping it, on
`/api/runs`' rule that a parameter deciding *which rows exist* must never widen
quietly: answering "every task" to "show me the claimed ones" is a board that
looks like an answer, and on a backlog that reads as an absence of work rather
than as a failed filter. `mountId` and `folder` are matched against the stored
columns exactly as held and are deliberately **not** re-resolved on a read — a
board must not stop listing because a mount is briefly unavailable. That rule is
for a reader handed the stored values, and the MCP `list_tasks` is not one: its
schema asks for the folder *within* the mount, as `list_folders` and `get_task`'s
refs give it, so `taskListFolder` in the route canonicalises the pair through
`resolveTaskFolder` first, `countBoardCondition`'s fix for the same defect —
passed straight through, `UsageFoundry` was compared against
`/workspace/UsageFoundry` and every project read back as an empty backlog. When
the resolver refuses, the folder is joined to the mount's configured root
lexically, so the unavailable mount above still lists, and a relative folder on
a mount id with no root is refused rather than answered as zero. The reply's
`matchedFolder` names the absolute path compared, with a note when it was the
lexical join.

**A `mount_id`/`folder` pair is proved against the app's own mount list at the
door, through the resolver a run is confined by, and half a pair is refused
rather than stored.** `resolveTaskFolder` calls `resolveWorkspaceFolder`
unchanged — which is where `security.md`'s two containment checks live: the
lexical one *before* any syscall, so an escape reports "outside the workspace"
rather than whatever ENOENT a bogus path produces, and the second *after*
`realpathSync`, because a symlink inside a mount can still point out of it. It is
reused rather than re-implemented for a reason narrower than "don't repeat
yourself": a second, looser resolver existing in this app at all is the thing to
avoid, and a task's folder has to be the same *kind* of proved path a run's is
or the read a work cycle makes — "tasks for the folder I am working in" — would
be comparing two values resolved differently. What is stored is the canonical
absolute path the resolver returned, which is the shape `runs.folder` holds, so
the comparison is an equality on two paths that went through the same door. Three
things are refused there: a mount id that names no configured mount, a folder
that does not resolve inside the mount it names, and **half a pair** — a folder
with no mount is a path this app cannot say which root proved it, and a mount
with no folder is a project claim with nothing under it. Both would store happily
and neither would answer the query the pair exists for. A mount that is merely
*absent right now* refuses with `resolveInMount`'s own sentence naming the mount
and the path, which is the same refusal the new-run form shows.

**Three fields are recorded rather than claimed, and are refused by name off the
wire.** `origin` and `created_by_run_id` come from the caller supplying a
`TaskCreation`, never from a request body: an origin off the wire is a chat turn
able to file work as though the operator had typed it, which is the single
distinction that column exists to hold. `status` is refused at a create because a
task is filed **open** — there is no filing work that is already done, and a
create that could set a terminal status would be a route around
`taskTransitionRefusal` that no test of that function would ever see. All three
are refused *by name* rather than dropped, on `normalizeAgentInput`'s grounds: a
caller whose field was silently ignored believes it took effect. A create's
title, brief or `parentTaskId` that is not a string is refused by name for the
same reason (`notStringRefusal`, `http.ts`'s one sentence for a text field of the
wrong type), and so is a note's body in `taskComments.ts` and a patch's `title`,
`body`, `parentTaskId`, `mountId`, `folder` and `claimRunId` in
`normalizeTaskPatch` — where `null` stays a real value on the last four and
`PATCH /api/tasks/[id]` answers the refusal with a 400:
`String()` filed an object title as `[object Object]` and an array as its items
joined by commas, and wrote the same into a note, which cannot be removed.

**Nothing on the board expires**, and the reasoning is in `retention/sweeper-and-taskboard.md`
beside the sweeper that does not touch it. A task's **comments** expire with it and never on
their own: `task_comments.task_id` is `ON DELETE CASCADE`, which is the one
cascade on this path and the only foreign key here that could be one — unlike the
three run id columns, the row it points at *is* deleted, by the operator and by
nobody else, and a thread outliving its task is orphaned prose no surface can
place. `parent_task_id`'s `SET NULL` is the opposite case for the opposite
reason: there the child is the thing worth keeping.

**The board's own index deliberately does not carry `priority`, and that is the
one thing here a reader is most likely to "fix".** Priority is a closed set of
four words (`urgent`, `high`, `normal`, `low`) rather than a free integer,
because an integer is a scale nobody can read back. The board's listing orders by
priority *before* `updated_at`, and an index on `(status, priority, updated_at)`
would supply a **lexical** run of those words — high, low, normal, urgent — which
is not the board's order and which the planner would happily use to produce it.
An index the planner uses to return a wrong order is worse than no index at all,
so `idx_tasks_board` is `(status, updated_at DESC)`, `listTasks` sorts on a `CASE`
derived from `TASK_PRIORITIES`' own order, and the cost is a sort over the rows
matching the status filter — a backlog rather than an event log. The day that
stops being cheap the answer is a stored rank column written by `tasks.ts` and
backfilled in `migrate()`, never a widening of this index.
