# The taskboard: who may move a task, and what a claim is not

> Each paragraph records a correctness or safety decision whose violation is
> silent — nothing throws, nothing fails to typecheck, and the board looks right.
> **Read before editing `src/lib/tasks.ts`, `src/app/api/tasks/`,
> `src/app/tasks/page.tsx`, or the `tasks` table in `src/lib/db.ts`.**
> This is the storage, the server half, the board, and the three kinds of agent
> that reach it over MCP — a chat turn, an orchestrator block, and a work cycle.
> The last of those is the one that carries a credential and a switch of its own;
> `security.md` holds the half of it that is about authorisation, and
> `run-lifecycle.md` the flag it puts on every cycle's argv.

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
the sweeps that do not touch it. A task's **comments** expire with it and never on
their own: `task_comments.task_id` is `ON DELETE CASCADE`, which is the one
cascade on this path and the only foreign key here that could be one — unlike the
three run id columns, the row it points at *is* deleted, by the operator and by
nobody else, and a thread outliving its task is orphaned prose no surface can
place. `parent_task_id`'s `SET NULL` is the opposite case for the opposite
reason: there the child is the thing worth keeping.

**A comment is append-only, and the absent columns are the design.** There is no
`updated_at` on `task_comments`, no `deleted_at`, no `edited_by`, and no route,
tool or function that changes a note once it is written — a comment goes away
only when its task does. The reason is narrower than "an audit trail is nice": a
thread here is written by three parties who cannot see each other, and the whole
point of it is that a run reads what the operator said. An edit would leave a
cycle acting on text that is no longer there, with the board showing the new text
and nothing anywhere recording that it changed — which is the same class of
failure as a stale claim, in a place where the evidence is the thing being
changed. What that costs is that a mistaken note stays, answered by the next one,
and the trade is deliberate: a thread is cheap and a run acting on a sentence
nobody can produce any more is not. The day this needs a redaction the answer is a
tombstoned row that says a note was withdrawn, never a mutation of the one that
was read.

**A comment's author is recorded, never claimed, and it is the same rule
`origin` and `created_by_run_id` already carry one table over.** It comes from
the door the write arrived at — the route's constant `OPERATOR`, the chat tool's
subject, the run's capability token — and `normalizeTaskCommentInput` refuses
`author` and `authorRunId` off the wire **by name** rather than dropping them, on
`normalizeAgentInput`'s grounds. Both ways of getting it wrong are silent and
both end as a sentence somebody acts on: a run's note recorded as the operator's
is an agent's guess read as an instruction, and an operator's note carrying a run
id is a thread asserting a run said something it did not. The `TaskActor` union
is reused rather than a string beside an optional id, and that is what makes the
second unrepresentable — `authorRunId` is derived from the actor in one function
and can be read from nowhere else. `createdAt` is refused by name for a reason of
this table's own: the thread is ordered by it, so a write that chose its own
timestamp could place a note before the ones answering it and no reader could
tell. `TASK_COMMENT_AUTHORS` is its own closed set rather than `TASK_ORIGINS`
despite holding the same four words, `rowToTask`'s reason: every reader here is
typed against it, and a widening made for one table would silently admit a word
the other's `switch` has no case for.

**A comment moves nothing, and specifically does not bump `tasks.updated_at`.**
Nothing on this path calls `updateTask` and nothing on it may. That column means
the task *moved* and `idx_tasks_board` and `listTasks` both sort on it, so a note
would reorder the board and read as a move — a row jumping to the top of Open
because somebody added a sentence is the board telling an operator something
happened to the work. `taskTransitionRefusal` is untouched and is still the whole
of the board's authority model: a comment claims nothing, closes nothing, changes
no status and no priority, and every tool description on the MCP surface says so
in as many words, because a model handed the one write beside `create_task` reads
it as a way around that function unless told otherwise.

**A clipped thread loses its oldest end, which is the one place this inverts
`listTasks`' shape.** The rows come back oldest first — that is how a thread is
read — but the cap is applied to a descending query which is then reversed, so
what a reader loses is what has already been answered. A cap taking from the
other end would hide the note somebody wrote a minute ago, which is the only one
a run acting on the thread needs, and it would do it silently. `total` therefore
travels beside the rows on a shortened diff's rule, and `TaskCommentListDTO`
carries no `offset` at all: a thread is read from the top rather than paged, and
the day one needs a second page the offset has to count from the *new* end, which
is a different query rather than a larger number.

**Comments reach a run through a tool call and never through the appended
system prompt.** `TASKBOARD_NOTICE` is frozen against the cached prefix, on the
file price list's rule — a run mid-flight across a deploy that gained one newline
pays a cold prefix for it. A thread is the opposite of frozen: it changes between
cycles, which is the entire reason an operator writes on a task a run is holding.
Injected there it would rewrite that prefix on every cycle that gained a note,
which is the most expensive possible way to deliver a sentence. So the run reads
its threads out of `list_my_tasks`, on the `held` half and deliberately not on
`openInFolder`: `held` is what this run may act on, where a note on a task it may
only read about is tokens spent on somebody else's conversation. Bodies in a tool
result are **whole** rather than clipped, which is the one place this departs from
`bodyPreview` beside it — a work cycle has no `get_task`, so there is no second
call that would return the rest, and a clipped note is an instruction it can
never finish reading. `MAX_TOOL_TASK_COMMENTS` is the cap and the count travels
beside it; the read is one query per held row rather than one for the set, which
is the N+1 the board's own listing refuses and is admissible only because `held`
is capped at `MAX_RUN_TASKS` and a tool call is not a ten-second poll.

**`comment_on_task` takes a task id and is deliberately not held to
`complete_task`'s rule, which is a smaller claim than it looks.** No tool on the
run surface takes a *run* id and that is unchanged — the author is still the
token's. What this one does take is an id off a list, and the reason that is safe
here and not there is what the two writes do: `complete_task` against a guessed
id closes work nobody did and the board then says it happened, where
`comment_on_task` against a guessed id puts a sentence signed by this run on a
task it was not working. The first is a state nothing can tell apart from the
truth; the second is visible as exactly what it is. A run may therefore write on
anything it can see, which includes `openInFolder` — the case that makes the tool
worth having, since "I have just changed the thing this task is about" is a note
about a task the run does not hold. A **block** is refused the tool outright, on
`create_task`'s ground rather than by omission: a note is permanent and cannot be
edited, its turn is unattended, and a thread it wrote to is one the operator meets
already answered by something nobody was reading. Its refusal names what a block
can still do with the board, on `subjectRefusal`'s rule.

**The comment count is on `TaskDTO` and is passed rather than read.**
`commentCountsForTasks` is one `GROUP BY` for a whole page, `runLinksForTasks`'
shape and its reason — the board draws up to `MAX_TASK_PAGE` rows on a ten-second
poll, so a per-row read is a second N+1 on the same timer. It reaches `taskDTO`
as an argument so that nothing in `tasks.ts` imports `taskComments.ts`: the
dependency between the two runs one way, and a read there would close the loop
for a number that is drawn beside a row rather than decided on. Both task routes
fill it, because `chatDTO`'s rule applies to a count as much as to a link — a
`commentCount` on the GET and absent from the PATCH would have the editor lose it
on every save. `taskComments.ts` is its own module rather than a fifth section of
`tasks.ts` for the reason `fileCostNotice.ts` sits beside `orchestrator.ts`: that
file is already the closed sets, the transition rule, the door, the storage and
the wire for one table, and a second table's half pushed into it would bury
`taskTransitionRefusal`, which is the function it exists to make findable.

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

**Which subject may do what to the board, and the one thing none of them may
do.** `src/app/api/mcp/route.ts` gates its tool list by capability subject, and
the board sits across every group of it. `list_tasks` and `get_task` are
**shared** between the two orchestrator subjects: a chat turn and an orchestrator
block both read the board, and reading it starts nothing — no folder is claimed,
no slot is taken and no guard is consulted — which is exactly what makes it safe
to hand a block that emits runs with nobody watching. `create_task` is refused to
a **block**, and the division is about who is reading rather than about what the
tool does: a chat turn has an operator at the keyboard, so a task it filed is one
somebody sees within the minute, where a block's turn is unattended and a backlog
it wrote to is a board the operator later meets already full of an agent's own
idea of the work. The refusal a block gets names `list_tasks` and the `taskId`
field rather than pointing at `emit_runs`, because answering "write this down for
later" with the one tool that starts work *now* is the opposite of what was
asked. A **work cycle** gets neither of the shared tools and a `create_task` of
its own; the next four paragraphs are its half.

**The gate is one membership test against the list the same function published,
and that shape is load-bearing rather than tidy.** `toolsFor(subject)` decides
what `tools/list` returns, and `callTool` refuses anything not on that list for
this subject — so a tool is unreachable by the same expression that made it
invisible. The pairwise version it replaced was correct for two subjects and
silently wrong the moment there were three: it asked "is this a chat" and
answered every other case as a block, so a work cycle asking for a chat tool was
told it was an orchestrator block, and a work cycle asking for a *block* tool
passed the guard entirely. Nothing about that failure is visible from a
transcript. A name on **no** list falls through to "Unknown tool" instead of
being refused as somebody else's, because a model that mistyped a tool needs to
know it does not exist rather than that it belongs to a subject it has never
heard of. `subjectRefusal` is the one wording, and every sentence it produces
names something the caller *can* do instead — `agentRefusal`'s rule, for
`agentRefusal`'s reason: a model told only "no" reaches for the next tool on the
list.

**A work cycle's three tools, and what their absence is.** `list_my_tasks`,
`complete_task`, `create_task`, and nothing else — deliberately not
`SHARED_TOOLS`, so a run has no `list_runs`, no `get_run_diff`, no
`list_folders`, and specifically **no `list_tasks`**. The two orchestrator
subjects are deciding what work to start and need to see the install to do it; a
run is already doing one piece of work in one folder, and the whole backlog is
neither its business nor something it can act on. `tasksForRun` answers the
narrower question instead, in two lists rather than one board: `held` is every
task whose `claimed_by_run_id` is this run — carrying **every status**, because a
run that has completed its task must be able to see that it did or a second
`complete_task` reads as a board that lost the write — and `openInFolder` is what
is open where it is working, which is what a run reads before filing so it does
not write down something already there. They are named apart in the payload
because the ids are the same shape and one flat list is an invitation to complete
something merely seen. A run whose folder is null gets an **empty**
`openInFolder` rather than the whole board: treating "no folder" as "no filter"
is one `WHERE` clause away and turns a tool scoped to one project into a read of
the operator's entire backlog. Both halves are capped at `MAX_RUN_TASKS`, far
below `MAX_TASK_PAGE` because this is a tool result a cycle pays for by the token
rather than a page somebody scrolls, and the count of what was left out travels
beside the rows on a shortened diff's rule — a run shown twenty of sixty and told
nothing files the duplicate it read the list to avoid.

**The run id comes from the token and never from the call, and that sentence is
the entire authorisation of this surface.** `CapabilitySubject` gained a third
arm, `{ kind: "run"; runId }`, and it is the one whose id is load-bearing rather
than descriptive: `complete_task` passes `subject.runId` to `updateTask`, which
compares it against the row's own `claimed_by_run_id` through
`taskTransitionRefusal` — the same pure function the operator's route and the
chat tools ask. **No tool on this surface takes a run id**, and that is not an
omission to be tidied: an argument would be a work cycle able to close every task
on the board by guessing an id out of a list, and `list_my_tasks` hands it a list.
`create_task` places what it files the same way — `origin: "run"`,
`created_by_run_id`, the folder, and the parent — from the token and the run's own
row rather than from the arguments, which is why its schema has no `folder` and
no `mountId`. **The folder a run reads the board for and the pair it may file
against are two answers and must not be collapsed into one.** The read compares
a string against `tasks.folder` and needs no mount; the write is the
`mount_id`/`folder` pair `normalizeTaskInput` proves, and that door refuses half
a pair by design. `describeFolder` returns a null `mountId` for a path under no
configured mount — a mount the operator renamed or removed while a run was in
flight — so passing it through beside a live folder refuses **every**
`create_task` that run makes, for half a pair it never named, over a field its
schema does not have. Filing therefore drops both when the mount cannot be
identified and the task lands unplaced, which the tool result says rather than
claiming a folder: an unplaced brief is still a brief, and a message asserting
one would send the model looking for it on a project board. The one exception is `parentTaskId`, which a run may name because
it may find something while working a task other than the one it was started for;
it defaults to the task it holds, and a parent that has been **deleted** is
dropped rather than refused, because otherwise an operator deleting a brief
mid-flight would have every `create_task` refused by `createTask`'s
dangling-parent check and the new brief — the thing worth keeping — would be
lost to the state of a row it is only annotated with.

**The token is minted per run, lives as long as the run's loop and is revoked
outright, with no grace.** `mintRunCapability` and `revokeRunCapabilities` in
`chat.ts` follow `otlp.ts`'s `ingestTokenFor` rather than `mintCapability` beside
them, and the difference is the clock: a chat turn's capability expires on
`CHAT_TIMEOUT_MS` because a turn that has not finished by then is not going to,
where a run has no such bound — parks, resumes, the 429 ladder, a weekly wall —
so a lifetime here would be a run whose tools stop existing partway through,
which reads as a model that chose not to call any. It is `Infinity` plus a
revocation in `startRun`'s `finally`, on every path the loop can leave by, and
**unconditionally** rather than gated on the setting: a run that had the board for
its first cycles and lost it to a Settings edit still minted a token, and a
revocation that fires only when the feature is currently on is one an operator
switching it off would skip for exactly the runs it matters for. It is minted
once per run and re-used across cycles for the exporter credential's reason — a
token per cycle is one more thing to revoke on each of the paths a cycle can end
on — and where OTLP's revocation waits out a batching timer, this one does not:
a tool call is synchronous with a child that no longer exists, so there is no
tail to lose, and a grace would be a window in which a token recovered from a
sibling's `/proc/<pid>/cmdline` still closes tasks. `security.md` carries what a
recovered one is worth and why the tool list is the bound that answers for it.

**A run's MCP config is deliberately not strict, and the claim is not the
config.** `--mcp-config` rides every cycle's argv; `--strict-mcp-config` never
does. The chat child passes it because its tool surface is closed by design — an
orchestrator turn is meant to reach this app and nothing else — where a work
cycle's is not: the operator's own MCP servers, configured in the `~/.claude`
this app mounts, are part of what their agents work with, and strict here would
strip every one of them out of every run the moment the setting was switched on.
That regression is invisible from inside this app and would read, to the
operator, as their servers having broken. The **file** is written per cycle even
though the token in it is per run, and removed in the cycle's own `finally`: a
config left on disk is a live capability, where the token it names is bounded by
the loop. Ownership is passed as `null`, which is the opposite of the chat's and
is stated rather than absorbed — the run child is not in `UF_CHAT_GID` and must
not be, so there is no file mode separating two work cycles from each other.
`security.md` holds what that costs.

**The run is told the board exists on the appended system prompt, and the notice
rides the same value the flag does.** `TASKBOARD_NOTICE` in `cycleInvocation.ts`
is keyed on `buildArgs`' `taskboard` option, so a run cannot be told to call
tools it does not have and cannot have them without being told — the two failures
that pairing exists to make impossible, both of which look like a normal run from
the outside. What it says is **behavioural rather than descriptive**: the tool
list already says what the tools are, and a model reading only that closes its
task and stops, or finds a second defect and fixes it because nothing told it
there was anywhere else to put one. "Complete only what you hold" and "file what
you find rather than fixing it" are the two sentences that earn their tokens.
What it may **not** carry is `security.md`'s rule about literals: nothing on this
prompt may give an agent a pattern that selects a process. The three tool names
are shared across every board-enabled run on the box and are exactly that kind of
literal — what keeps them safe is that nothing near them offers a pattern, no
verb selects a process, no command is named and there are no digits at all. They
are named rather than alluded to because a model told "there is a board" without
the names writes prose about filing a task instead of filing one. A run without
the board gets an appended prompt **byte-identical** to the one this app sent
before the feature existed, the file price list's rule: a run mid-flight across a
deploy that gained one newline would otherwise pay a cold prefix for a notice it
did not get.

**A run started from a task claims it when the run starts, not when a tool is
first called.** `claimTaskForRun` fires at the top of `startRun`, before the
worktree and before the first cycle. A claim written at the first `list_my_tasks`
is a claim a run never writes if the setting is off, if the model never opens the
tool, or if the cycle dies before it does — so the board would show `open` for
work already in flight, and the chat tool that exists to stop two agents taking
one brief would be reading it. It is deliberately **not** gated on
`taskboardForRuns`: the claim is this app writing down what it just did, and the
setting is about what an *agent* may do, so a run started from a task with the
board switched off still holds it. Every refusal on that path is a log line and
never a failure — a task somebody dropped, one another run still holds, one the
operator deleted between the press and the start. None of them says anything
about whether this run can do the work it was given, and a run that refused to
start over the state of a row on a backlog would be this app turning a note into
a lock. The sentence shown is `taskTransitionRefusal`'s own, repeated onto the
run's log, because the alternative is a board that silently disagrees with the
run page about who holds what.

**Whether a work cycle reaches the board at all is `taskboardForRuns`, off by
default, and the whole path is inert while it is off.** `telemetryForRuns`' shape
one step further: that setting turns on a behaviour inside the child, and this
one gives an unattended agent a write path into this app's own database. No guard
decides that — the guards bound what a run may spend and how long it may run, and
none of them has an opinion about whether an agent nobody is watching may close
an item on a person's backlog. Off means no token is minted, no config is
written, `--mcp-config` is not on the argv and the appended prompt is the string
it was before the feature. It is read **per cycle** rather than fixed at the
run's start, the read guard's rule rather than `liveSpendTelemetry`'s: an
operator who has just decided this should stop gets it at the next cycle rather
than at the next restart, and the price is one cold prefix on that cycle for the
run in flight. A **Codex** run reaches no board and is told about none — Codex
takes its MCP servers from a `config.toml` that `--ignore-user-config`
deliberately keeps out of a cycle — and no token is minted for it, since a
credential a child could never spend is one on disk for nothing. That is said
once on the run's own log rather than left silent, because an operator who
switched the board on and started a Codex run would otherwise watch it finish
having filed nothing with nothing to read that explains it.

**Nothing on the MCP surface can move a task to any status, and that is enforced
twice rather than once.** `create_task` files as `open`, there is no `status`
property on its schema, and `normalizeTaskInput` refuses one **by name** if a
model sends it regardless — the same door the operator's own POST goes through.
The reason a second enforcement is not belt-and-braces is that the first one is
only a *description*: a schema is what a model is told, and `additionalProperties
: false` is checked by the CLI rather than by this app. `taskTransitionRefusal`
is the whole of the board's authority model and no route may become a second
answer to it; a chat turn that could write `done` would be a model closing the
operator's work on its own say-so, from the one surface whose entire design is
that a person decides whether anything happens. If a model wants a task closed,
that is a proposal or the operator's own press — and the tool description says
so, because a model told it may file a task reads the omission as an oversight.

**A run that came off the board carries the link, and the link is a record
rather than a trigger.** `propose_run` and `emit_runs` each take an optional
`taskId`. It rides `chat_proposals.task_id` from the proposal and lands on
`runs.task_id` **inside `createRun`'s own transaction**, carried in on
`CreateRunInput.taskId` from the approval or the emission, so nothing can see
the run without seeing what it was started for. What it does **not** do is the
point: naming a task does not claim it, and the run reaching a terminal status
does not close it. A run can complete and still not have done the thing — it can
stop on a budget, be cancelled, or finish having decided the work was wrong — so
a status-derived rule here would close backlog items nobody worked. Completion
belongs to the run that did the work, in its own name, or to the operator's
press. Nothing in the run *loop* reads the column either: not a guard, not the
budget, not occupancy. A run carrying a task id and one that is not are the same
run, which is why the SQL still lives in `tasks.ts` and `createRun` holds only
the id.

**The link has to be written before the run can be promoted, and that is the one
ordering here whose violation is silent.** It used to be a `recordRunForTask`
call on the line after `createRun` returned, which reads as the same synchronous
pass and is not: `createRun` ends by calling `promoteQueued`, `startRun` runs to
`claimTaskForRun` without an `await` in between, so the entire claim happens
*inside* the `createRun(...)` call expression. The column was still null,
`taskForRun` returned null, and the claim returned at its first line — the one
branch that logs nothing, because a run that names no task has nothing to say.
The board then showed `open` for work already in flight, and the run could never
complete the task afterwards either, since a run may complete only the one
claimed in its own name. It bit only runs that started immediately; a run that
queued behind a busy folder was promoted later, after the write, and claimed
correctly. Anything that gives a new run a task id must hand it to `createRun`
rather than write it afterwards.

**An unknown `taskId` is refused by name, and a *closed* one is not.**
`taskRefusal` in `tasks.ts` is the one wording, so an id that is not there reads
the same in a chat, in an emission and in `get_task` — `agentRefusal`'s ground.
The failure it closes is the quiet one: a proposal that said "for the flaky-auth
task" and silently carried no task is bit-for-bit a proposal that named none, and
the operator approves a card whose provenance line is simply absent. The
asymmetry with `agentRefusal` is deliberate and is where the two stop being the
same rule. An agent that has gone changes **what the run is** — `--agent` takes a
name and a missing one dies at the spawn — where a task that is `done` or
`dropped` changes nothing about the run at all. Refusing one would be this
function deciding on the operator's behalf that work off closed work may not
happen, which is their call. What the caller gets instead is the status, said
back, so a model that named a dropped task can see that it did.

**The board is read whole to answer "is this id there", and the runs behind a
page are read in one query.** `currentTaskKnowledge` takes every row rather than
a page, because a page answers that question wrongly for everything past it —
`currentAgentKnowledge`'s split, with the impure half here and the rule pure.
`EmissionLimits` takes it as a **function** where `agents` beside it is data, and
the difference is that the registry is a list somebody curated while the board is
a backlog nothing expires: copying every task the install has ever filed into
every emission would grow with the install to answer a question about at most
`fanOut` ids. On the other side, `runLinksForTasks` answers for a whole page at
once, because the board polls every ten seconds and the per-row read it replaces
is an N+1 on a timer. Its id list is capped at `MAX_TASK_RUN_LINKS` and its count
is not, on the rule a shortened diff follows: a row showing three of eleven runs
and saying nothing reports a task worked eleven times as one worked three.

**A run whose task has been deleted still names it, and that is a third answer
rather than a missing one.** Neither `chat_proposals.task_id` nor `runs.task_id`
is a foreign key — the operator deletes tasks freely and nothing in this app
deletes a `runs` row, so a cascade would describe a deletion that never happens
in one direction and destroy a run's provenance in the other. `taskForRun`
returns the id with `title` and `status` both null where the row has gone, and
every surface that draws it tells that apart from "no task": the run page says
*a task since deleted*, the proposal card says the same, and neither links,
because the row they would open is not there. A surface that collapsed the two
would lose exactly the provenance the column exists to hold.

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

**The editor is a route, not a card the board opens above itself.** A task title
is a link to `tasks/[id]` and New task is a link to `tasks/new`, both drawing
`src/components/TaskEditor.tsx`, on `runs/[id]`'s precedent. The brief is the
field with something to read in it and it used to be a seven-line box wedged
above a table that went on polling and moving underneath it. Two consequences
worth knowing before editing either file. The board is a list again — it draws
rows, narrows them, counts them and offers the moves, and holds no draft — so
nothing on it can be lost by a poll. And `tasks/[id]` is the one page here that
**does not** poll: it is a form with unsaved text in it, and a poll could
neither re-seed the draft without throwing away what is being typed nor leave it
alone without drawing a heading that disagrees with the field below it. It reads
the row on arrival and again after every press that changed it, and claims
nothing about what another door did meanwhile.

**The editor is never filled from a list row.** `TaskListItemDTO` carries the
brief clipped to `MAX_LIST_TASK_BODY` with an ellipsis on it, so a form seeded
from the board and saved writes two hundred characters and a `…` over the whole
brief — the one field a future agent is handed with nothing else to go on,
destroyed by an edit to the title, silently, with the row still looking right
afterwards. So the detail page fetches `GET /api/tasks/[id]` and does not mount
the form until it holds the answer, the draft is seeded once from that and never
re-seeded from the prop, and a failed read draws the reason instead of a form —
there is no path that writes the clip. The folder select carries the same shape
of guard for a different reason: a stored folder the workspace scan does not
currently offer stays in the list as its own option, since a `<select>` whose
value is absent resolves to the first option and an unrelated save would then
move the task to a folder nobody picked.

**The thread is drawn on the task's own page, and it does not poll either.**
`TaskThread` in `src/app/tasks/[id]/page.tsx` reads
`GET /api/tasks/[id]/comments` on arrival and again after a post it made itself,
and there is no interval anywhere on that route. It holds a **second** draft
beside the editor's, so the page's own reason applies to it twice over: a timer
re-reading the thread could neither replace the composer's text without throwing
away what is being typed nor leave it alone while redrawing the notes it answers.
What that costs is a note written at another door while the page is open, and it
is the same trade the row above already makes. A successful post refetches the
**thread and nothing else**: the note did not move the task — no status, no
priority, and deliberately not `updated_at` — so re-reading the row would redraw
a heading nothing changed. Its three ways of having nothing are the board's, one
table down: a failed read says *this is a failed request rather than an empty
thread* and offers a retry, an empty thread says what a comment is and who may
write one, and a thread longer than `MAX_TASK_COMMENTS` says how many of how many
it is showing and which end is missing. The composer is drawn in all three,
including the failed read — a thread that could not be read says nothing about
whether a note can be written, and the door answers for that itself.

**A note's body is drawn as the characters it is, and that is decided by the
field above it rather than by what the text might be.** `whitespace-pre-wrap`,
no `Markdown`, because the task's own brief on that page is drawn in a
`Textarea` — the same text, unrendered. A thread rendering headings and links
over a brief shown raw would claim a fidelity the field it answers does not
have, and it would do it on the one surface whose whole point is that a run
reads back exactly what somebody wrote. The day the brief itself is rendered is
the day this follows it, and not before. The author is drawn as a word from
`TASK_COMMENT_AUTHOR_WORD` and the run id beside it as a link, in that order and
never the id alone: the pairing is what `taskComments.ts` records and this is
where it is read back, so the word says who wrote the note and the id is a handle
on the run that did. That map is a second `Record` holding the same four words as
`TASK_ORIGIN_WORD` for the reason `TASK_COMMENT_AUTHORS` is a second closed set —
the two tables move independently, and one map shared between them would let a
fifth word added for either reach a reader typed against the other.

**The count goes inside a cell the board already has, and a column for it is
refused rather than merely not built.** The Task column is `w-full` over six
min-width columns and is therefore whatever they leave — about 190px on a 1280px
window — so a seventh floor comes straight off the title, for a figure that is
zero on most rows. It is drawn in the Task cell specifically: that is the one
cell the board deliberately leaves unlabelled, being the headline the record is
identified by, and every other cell carries a `label` that `stack` puts above the
value at 390px, where "Priority urgent 3" and "Runs 3" both read as a fact about
something else. **Nothing at all at zero**, which is the same decision the Runs
cell makes one column over: a faint "0 comments" on every row is a column of the
word none. And it is **not** a link, unlike the run count beside it — that one is
the only handle its cell can give, where the title directly above this one is
already a link to the page the thread is on.

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

**A run's claim to have finished a task can be checked before the board acts on it, and every way that check can fail closes the task anyway.** `validateTaskCompletion` is off by default and, while it is off, `complete_task` is the statement it always was: one `updateTask`, the same actor, the same two refusals, the same wording — and `toolsFor` publishes the byte-identical description, the appended prompt's price rule applied one surface along. Switched on, the tool stops being the close and becomes the *claim*: `validation.ts` reads what the run committed to its own branch against what the task asks for, and the task closes only if that reading finds the work there. **The authority model is untouched and that is the load-bearing half.** The close still goes through `updateTask` with the run as the actor, so `taskTransitionRefusal` is still the whole of the board's authority: the check can only ever *delay* a close the run could have made, and can never make one it could not — a task the operator took back, dropped or closed in the meantime is refused by the same function, and their decision outranks the verdict. What the check can do is hold a task open, so every way of not getting an answer has to fall the same way, and all of them do: the feature off, a run with no branch of its own, no assist slot free, a diff that cannot be read, a child that crashed or timed out, a reply that will not parse, and the `unjudgeable` verdict itself. The one that is worth stating rather than listing is the slot: `maxConcurrentAssists` bounds how many Node processes this container carries, and holding a task open for it would convert a memory limit into work at exactly the moment the fleet is busiest. **A repeated call is answered, not honoured.** `complete_task` twice in a row used to be the whole gate defeated — the first call starting a check and the second closing the task while that check was still reading — so the same claim asked again returns the reading already in flight, and only a *different* task of the same run falls through to the unchecked close.

**The judge is never told that a run claims to be finished, and the prompt is a measuring instrument rather than a setting.** `LLM-as-a-Judge` is the ground and the bias it names is *directional* rather than noisy: a judge prompt that states the answer somebody hopes for is not a judge. The trigger for this whole path is a claim of completion, which makes "the agent says it is done" the single most natural thing for a future editor to add as helpful context, so `validation.test.ts` asserts against five phrasings of it. The text itself is `scripts/validator-spike/prompt.md`'s — the artefact the 34-of-37 agreement and the zero false-finished were measured on — kept as a constant rather than exposed on the settings page, because every number in `RESULT.md` is a number about that string and a field would make each of them a claim about whatever somebody last typed. **One section is deliberately not the measured one**, and it had to move in this change rather than a later one: the spike says *"be suspicious rather than generous"*, which was correct when a wrong verdict cost a glance, and here it costs a billed work cycle on a job that is already done. `proposals/ExternalValidator/external-validator.md` §7 states that coupling as a rule — a design that gets suspicious and actionable in two separate commits spends money on false alarms with nobody having decided to — so `VERDICT_PREFERENCE` routes every unsupported doubt into `unjudgeable`, which closes the task and costs nothing, and keeps `not-finished` for a deliverable the reading can *name* as absent. What it does not do is tell the model what any answer causes; a judge told the consequences is choosing an outcome.

**What the judge is shown is the branch, and uncommitted work is named as not delivered.** This fires while the run still holds its worktree, which is what makes it different in kind from the reviewer and from the end-of-run trigger the pitch proposed: it routinely meets work that exists and is not on the branch yet. `runDiff` already reports those paths, the prompt lists them and says they are not part of the evidence, and the tool description tells the run to commit before it calls — because the branch is what a land takes and a deliverable that exists only in the working tree is not delivered. The task's own title and brief are what is judged, never `runs.prompt`: a task is written to be read by an agent with no other context, where a run's prompt is whatever somebody typed into a form and may ask for more than the board does. The prompt is given the run's own text underneath, marked as context, precisely so that doing *more* than the task named is never read as a shortfall.

**An unfinished verdict buys work cycles, and it may extend exactly one guard.** This is the half the pitch declined to build and the half that needs the most care, because it is the one place a model's opinion turns into money. `budgets-and-guards.md`: `maxIterations` and `maxDurationMinutes` are the only two monotone termini and `no_terminus` refuses a run with neither, so an extension without a ceiling is a run nothing ends. `runs.validation_cycles` only ever increases, it is written to the row rather than held in the loop's frame so a restart cannot reset it, and `maxValidationCycles` — floored at zero, and the one budget-shaped field here that may never be null — is what stops it. Everything else stays exactly as terminal as it was: `evaluateBudget` at the top of the granted cycle still reads duration, run spend, both window fractions and the install's own daily ceiling, so a grant is permission to *ask* for another cycle and never permission to have one. Zero is a real answer and is the pitch's own notify-only design arrived at through a number — the task is still held open and the operator is still told why; nothing is bought. And a verdict may buy a cycle **once**: the boundary acts only on a row that finished inside the cycle that just ran, or a run granted a cycle that then did not call `complete_task` again would meet the same standing verdict at the next boundary and buy another with it, and another, every one of them billed against a reading nobody re-took.

**A validation is the third `AssistKind`, the only child this app starts without being asked, and the two things that follow are not optional.** It carries `--max-budget-usd` off `validationBudgetUSD` where a review and a resolution carry no ceiling at all — those are one press each with a person watching, and `windowRefusal` is read once at the door, so an automatic spender admitted at 99% of a window could spend arbitrarily. And `installSpend` was widened to read `run_reviews.cost_usd`, which it never did: reviews sat outside the install's daily ceiling for as long as every row in that table was somebody's press, and the day something fires per finished piece of work that ceiling stops meaning what it says. All three kinds are counted rather than validations alone, because what that reading is is money this app recorded spending inside the window and a reviewed run's money is no less spent for having been asked for. The verdict lands in `run_reviews.verdict` with the task it judged and the two commits it read, and **null there is a real value that must never be defaulted to either answer** — a refused, crashed, timed-out or unparseable validation has no verdict, and every one of those closed the task, so a null reads as *closed unchecked* and not as *checked and passed*.

**The check is a weak verifier and the strong one is deliberately absent.** `Self-Correction and Reflection` is the note that bears on this design most directly and it is not flattering: a reflection loop improves results when an **external verifier** supplies the signal (Reflexion, 91% against 80%, where the signal is a test runner) and degrades them when the model grades itself (Huang et al., CommonSenseQA 75.8% → 38.1% after one round). Its two rules are "find the verifier before adding the loop" and "do not let the model decide when to stop". Two are answered: this is not intrinsic self-correction — the judge is a different process with a different prompt and evidence it did not write, which is the weak-verifier middle ground that note names as its own open question — and the model does not decide when to stop, `maxValidationCycles` does. The third is not: nothing here runs the repository's tests, and `validationPushback` earns its cycle by carrying the validator's *evidence* verbatim rather than asking the agent to think again, which is Reflexion's shape — the reflection converts a verdict into an instruction and does not produce the verdict. One of the pitch's three reasons for fencing execution off is weaker here than it was there, and it is recorded for whoever picks it up: this fires while the run still holds its own worktree, so "nobody holds the folder" is not the constraint it was.
