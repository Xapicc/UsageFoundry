# The taskboard: who may move a task, and what a claim is not

> Each paragraph records a correctness or safety decision whose violation is
> silent — nothing throws, nothing fails to typecheck, and the board looks right.
> **Read before editing `src/lib/tasks.ts`, `src/app/api/tasks/`,
> `src/app/tasks/page.tsx`, or the `tasks` table in `src/lib/db.ts`.**
> This is the storage, the server half and the board. The chat and block tools
> and a work cycle's own access are later work and are deliberately absent — what
> they will need exists here, typed and tested, and nothing else does.

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

**`claimed` is a record of which run holds a task. It is not a lock, it has no
clock on it, and nothing on this path may acquire one.** The obvious next feature
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
The lever that exists is visibility, not expiry. Nothing here calls
`setTimeout`, nothing stores an expiry, and `updated_at` is a record of the last
edit rather than a countdown; a future editor reaching for a `claimed_at` should
know that the column's absence is the decision.

**Who may move a task to which status is one pure function, and it is the whole
of the board's authority model.** `taskTransitionRefusal` in `tasks.ts` takes a
pair of statuses, an actor and the row's own `claimed_by_run_id`, and answers
with a sentence or with null — `agentRefusal`'s shape, for `agentRefusal`'s
reason: three doors will eventually ask it (the operator's route, a chat tool, a
work cycle) and one wording is what stops them disagreeing about the same move.
Eight edges exist and every pair not on the list is refused:

| From | To | Who |
|---|---|---|
| `open` | `claimed` | any actor, and the claim names the run that will hold it |
| `open` | `done` | operator only — a run claims first |
| `open` | `dropped` | operator only |
| `claimed` | `open` | operator, or the run that holds it (releasing) |
| `claimed` | `done` | operator, or the run that holds it |
| `claimed` | `dropped` | operator only |
| `done` | `open` | operator only (re-opening) |
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

`from === to` is not a move and is allowed for every actor, so an update that
restates the status it is not changing is a no-op rather than a refusal;
`updateTask` calls the rule only when the status actually differs, which is what
keeps a patch from applying a move's effects when nothing moved.

**A move's effects are the other half of the rule, and re-opening deliberately
clears both run columns.** Into `claimed`, the claim names its run and `closed_at`
is cleared. Into `done`, `completed_by_run_id` is the acting run, or null when the
operator marked it — a person is not a run, and inventing one would put a run id
on work no run did. Into `dropped`, `closed_at` is set and `completed_by_run_id`
is left alone, because nobody completed it. Into `open`, both run columns are
cleared: a task that is open while naming the run that completed it is a
contradiction every surface drawing the board would have to explain, and a
re-open is the operator saying the work is not done. What that costs is the
record of who had done it before, and the trade is deliberate — the mutation
itself is on `request_log` and in `ops_events`, and a board whose columns
contradict its own status is worse than a board that has forgotten one thing.

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
caller whose field was silently ignored believes it took effect.

**Nothing on the board expires**, and the reasoning is in `retention.md` beside
the sweeps that do not touch it.

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

**`GET`/`POST /api/tasks` and `GET`/`PATCH`/`DELETE /api/tasks/[id]` are
operator-facing and behind the app's ordinary gate**, and the actor is a constant
in the route rather than anything read off a request. That is the point: a route
that could be persuaded to act as another actor kind would be a route around the
rule above, so the way a run or a chat turn gets access later is a door of its
own carrying its own credential — not a field on this one's body. Both mutating
handlers are wrapped in `auditMutation`. The list route reads `offset`, `limit`,
`status`, `origin`, `mountId` and `folder` off `searchParams` and refuses an
unknown `status` or `origin` with a **400** rather than dropping it, on
`/api/runs`' rule that a parameter deciding *which rows exist* must never widen
quietly: answering "every task" to "show me the claimed ones" is a board that
looks like an answer, and on a backlog that reads as an absence of work rather
than as a failed filter. `mountId` and `folder` are matched against the stored
columns exactly as held and are deliberately **not** re-resolved on a read — a
board must not stop listing because a mount is briefly unavailable.

**The pane sits directly under Runs, and two panes now go without a digit.**
`panes.ts` is a closed, ordered list whose number shortcut follows a row's
*position* rather than its age, so inserting Taskboard fourth renumbered
everything below it — Workflows to ⌘5, Agents ⌘6, Branches ⌘7, Knowledge ⌘8,
Dreaming ⌘9 — and pushed the account pane off the end beside Settings. ⌘1…⌘9 is
nine digits against eleven rows and **the loss is always taken from the bottom**,
which is the only rule that keeps "the digit is the row's position" true; the
alternative, leaving the digits where they were, gives ⌘4 a name in the list and
a landing one row down, which is the failure the position rule exists to
prevent. The two rows that lost it are both read rather than worked in — a
readout and the pane somebody opens when something is already wrong — and both
stay one press away in quick open. **A two-key chord to buy a digit back is a
different decision** and not one this feature may make on the way past. Under
Runs rather than beside Workflows because the board is what *feeds* the list
above it: a task is a brief nobody has started and the press that starts one is
a run, where a row under Workflows would read as a third way of describing work
to do — which is the one thing the first paragraph of this document says a task
is not.

**The board asks for the whole page and narrows in the browser, which is the one
place this feature departs from `/api/runs`' rule that narrowing belongs in the
query.** Two reasons, both specific to a board rather than to a list. The page
draws every status group at once, so a server-side narrowing is one request per
group against an offset that cuts across them — page two of a priority-ordered
listing is half of Open and half of Claimed, and the two requests that produce
it can disagree about what a row's status is. And the project filter's options
are derived from the same answer the rows are, so the select can offer neither a
project the board cannot show nor a hidden one it can; built from
`/api/folders` instead they would need a mount root joined to a stored relative
path *in the browser*, which is the second, looser resolver the `resolveInMount`
paragraph above exists to prevent. The cost is bounded and stated rather than
hidden: the page asks for `MAX_TASK_PAGE` rows, and a `total` larger than what
came back is a notice on the board saying so — because a filter narrowing a
silently truncated set is the "board that looks like an answer" failure one
layer up from the route. `MAX_TASK_PAGE` therefore lives in `apiTypes.ts` beside
`MAX_LIST_TASK_BODY`, not in `tasks.ts`: written twice, the page would ask for a
number the route quietly reduced and then report a whole board it had not been
sent. **The day the board needs a second page is the day this trade stops
holding**, and the answer then is a per-status request with its own offset, not
a larger cap.

**The board draws controls; it never decides a move.** Every press on this page
is a `PATCH` and the sentence that comes back is rendered verbatim, because
`taskTransitionRefusal` is a server module a `"use client"` file may not import
and a mirrored copy of the edge table in the browser is a second set to keep in
step — confidently wrong about what a press does, from the moment one of them
changes. What the page *does* decide is which buttons to draw, and that is the
smaller claim: the operator's own edges, with **no Claim button among them**,
because a claim names the run that will hold the task and the operator is not a
run. A row that moved between the poll that drew it and the press against it is
exactly when the server's refusal matters, so it is shown rather than swallowed
and the board is re-read either way. The in-flight state is keyed on the *edge*
(`id:status`) and not on the row: keyed on the row, pressing Done lit Release
and Drop too, which reads as three presses having been made.

**The editor is never filled from a list row.** `TaskListItemDTO` carries the
brief clipped to `MAX_LIST_TASK_BODY` with an ellipsis on it, so a form seeded
from the board and saved writes two hundred characters and a `…` over the whole
brief — the one field a future agent is handed with nothing else to go on,
destroyed by an edit to the title, silently, with the row still looking right
afterwards. So opening a task fetches `GET /api/tasks/[id]` first, the draft is
set only from that, and Save is gated until it lands; a failed read leaves the
editor open saying why, with no path that writes the clip. The folder select
carries the same shape of guard for a different reason: a stored folder the
workspace scan does not currently offer stays in the list as its own option,
since a `<select>` whose value is absent resolves to the first option and an
unrelated save would then move the task to a folder nobody picked.

**The three ways of having nothing are three different screens, and none of them
is an empty list.** A board with nothing on it says a task is a brief anybody —
the orchestrator, a workflow block, a work cycle, the operator — can file, and
offers the press that files one; a filter that matched none names the project it
narrowed to, says how many the board holds, and offers the way back to every
project; a fetch that failed says *this is a failed request rather than an empty
backlog* and offers a retry. The third is the one that matters and the reason
this is written down: an unreadable board rendered as an empty one tells an
operator their backlog is clear, which is both false and the most expensive
thing this page could say. It is told apart by `pollError !== null && tasks
.length === 0` — a poll that fails over rows already on screen keeps the rows and
carries the notice above them, because stale work is still work.

**The poll does not stand down**, which is the deliberate exception to
`conventions.md`'s rule that a page stops polling what cannot change. A run's
page gates its interval on the row being live because a terminal run moves no
further on its own; a board has no terminal state at all — a row can be filed or
claimed by a door this page does not own whatever the board currently holds, and
a board of nothing but closed work is exactly when a newly filed task is the
thing worth seeing. There is therefore no gate to re-arm, and the cost is one
capped request every ten seconds.
