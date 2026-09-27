# Task comments

[← taskboard index](../taskboard.md)

Read before editing `src/lib/taskComments.ts`, the `task_comments` table, or how comments reach a run.

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
only read about is tokens spent on somebody else's conversation. Note bodies in a
tool result are **whole** rather than clipped, which is the one place this departs
from `bodyPreview` beside it. `get_my_task` would now return the rest of a clipped
one, but a note is the part of a task that changes between cycles and
`list_my_tasks` is what a run re-reads before it acts: a clip there is an answer
the run has to notice is short and go and fetch, and the one it does not notice is
an instruction it acts on half of. `MAX_TOOL_TASK_COMMENTS` is the cap and the count travels
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
shape and its reason — a board request answers up to `MAX_TASK_PAGE` rows on a
ten-second poll, so a per-row read is a second N+1 on the same timer. It reaches
`taskDTO` as an argument so that nothing in `tasks.ts` imports `taskComments.ts`: the
dependency between the two runs one way, and a read there would close the loop
for a number that is drawn beside a row rather than decided on. Both task routes
fill it, because `chatDTO`'s rule applies to a count as much as to a link — a
`commentCount` on the GET and absent from the PATCH would have the editor lose it
on every save. `taskComments.ts` is its own module rather than a fifth section of
`tasks.ts` for the reason `fileCostNotice.ts` sits beside `orchestrator.ts`: that
file is already the closed sets, the transition rule, the door, the storage and
the wire for one table, and a second table's half pushed into it would bury
`taskTransitionRefusal`, which is the function it exists to make findable.
