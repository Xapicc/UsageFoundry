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

The paragraphs themselves live in `docs/agent/taskboard/`, one topic file per heading below. Find the rule by its lead claim and open the file its heading links to.

## [Tasks, status transitions and the task row](taskboard/tasks-and-transitions.md)

- A task is not a run, and the absence of every hook that would make it one is what keeps this feature out of the orchestrator.
- `claimed` is a record of who holds a task — a run, or the operator. It is not a lock, it has no clock on it, and nothing on this path may acquire one.
- Who may move a task to which status is one pure function, and it is the whole of the board's authority model.
- Table: From / To / Who.
- Four of those are load-bearing beyond their own row.
- A claim names its holder, and the operator can be one.
- `from === to` is not a move and is allowed for every actor, so an update that restates the status it is not changing is a no-op rather than a refusal — the one exception being a non-operator restating `claimed`…
- A write that changes nothing is not written, so `updated_at` does not move.
- A move's effects are the other half of the rule, and re-opening deliberately clears both run columns.
- `GET`/`POST /api/tasks` and `GET`/`PATCH`/`DELETE /api/tasks/[id]` are operator-facing and behind the app's ordinary gate, and the actor is a constant in the route rather than anything read off a…
- A `mount_id`/`folder` pair is proved against the app's own mount list at the door, through the resolver a run is confined by, and half a pair is refused rather than stored.
- Three fields are recorded rather than claimed, and are refused by name off the wire.
- Nothing on the board expires, and the reasoning is in `retention.md` beside the sweeps that do not touch it.
- The board's own index deliberately does not carry `priority`, and that is the one thing here a reader is most likely to "fix".

## [Operator-only tasks and giving a task back](taskboard/operator-only-and-release.md)

- Operator-only is a flag, not a fifth status, and it says who may do the work rather than where the task is.
- Who may move the flag is `operatorOnlyRefusal`, beside the transition rule, and a model may move work into the operator's lane and never out of it.
- Table: Actor / File a task marked / Mark an existing task / Clear the mark.
- Only the operator clears it, which is the board's "may put work on, never take it off" applied to this flag: cleared by a model, it is a run started on work somebody was told needs a Mac, spending…
- Where an agent is shown open work, the flag rides beside the status.
- A loop's board count leaves operator-only tasks out.
- A run gives back a task it cannot finish with `release_task`, and the move and the reason commit together or not at all.
- Needs-frontier is operator-only's shape one lane over: a flag, not a status, saying a local model may not do the work.

## [Task comments](taskboard/comments.md)

- A comment is append-only, and the absent columns are the design.
- A comment's author is recorded, never claimed, and it is the same rule `origin` and `created_by_run_id` already carry one table over.
- A comment moves nothing, and specifically does not bump `tasks.updated_at`.
- A clipped thread loses its oldest end, which is the one place this inverts `listTasks`' shape.
- Comments reach a run through a tool call and never through the appended system prompt.
- `comment_on_task` takes a task id and is deliberately not held to `complete_task`'s rule, which is a smaller claim than it looks.
- The comment count is on `TaskDTO` and is passed rather than read.

## [Dependencies between tasks](taskboard/task-dependencies.md)

- A dependency is advisory, and that is the decision every other line about it rests on.
- One kind of edge, and the absent condition column is the design.
- `parent_task_id` is a different relation and stays one.
- A self-edge is refused by name and a loop is refused at the write door, and the loop test is `dependencyCycle` rather than a second walker.
- A duplicate edge is not an error, and the answer says it was already there.
- Edges across projects are allowed, and the wire carries which project each end is in.
- Adding an edge is available to chat and to a run; removing one is the operator's alone.
- The edge records no author, and that absence is not an oversight.
- The neighbourhood is on `TaskDTO`, is passed rather than read, and its lists are capped while its counts are not.
- Every tool that mentions an edge says twice that it holds nothing back.
- An edge moves nothing, `updated_at` included.
- `task_deps` did not bump `SCHEMA_VERSION`, and the reason is that constant's own docblock rather than an omission: it is bumped for a migration that is something other than an added column or an…

## [The board's MCP tools, subjects and the per-run token](taskboard/mcp-surface.md)

- Which subject may do what to the board, and the one thing none of them may do.
- The gate is one membership test against the list the same function published, and that shape is load-bearing rather than tidy.
- Nothing a chat turn or a block holds can move a task to any status, and that is enforced twice rather than once.
- A work cycle's tools, and what their absence is.
- `get_my_task` is the whole-brief door onto exactly those rows, and its scope is the list's and never wider.
- The run id comes from the token and never from the call, and that sentence is the entire authorisation of this surface.
- The token is minted per run, lives as long as the run's loop and is revoked outright, with no grace.
- A run's MCP config is deliberately not strict, and the claim is not the config.

## [A run and its tasks: the notice, the claim, the setting and the link](taskboard/runs-from-tasks.md)

- The run is told the board exists on the appended system prompt, and the notice rides the same value the flag does.
- A run started from tasks claims every one of them when the run starts, not when a tool is first called.
- Whether a work cycle reaches the board at all is `taskboardForRuns`, off by default, and the whole path is inert while it is off.
- A run that came off the board carries the link, and the link is a record rather than a trigger.
- One run may be for several tasks, and it is linked to every one.
- A brief that names a board task its run is not linked to is refused, and that is what keeps the list from being optional.
- The links have to be written before the run can be promoted, and that is the one ordering here whose violation is silent.
- An unknown task id is refused by name, and a *closed* one is not.
- The board is read whole to answer "is this id there", and the runs behind a page are read in one query.
- A run whose task has been deleted still names it, and that is a third answer rather than a missing one.

## [The board page](taskboard/board-page.md)

- The pane sits directly under Runs, and two panes now go without a digit.
- The board reads every row, one status at a time, and narrows only the project in the browser.
- The board draws controls; it never decides a move.
- The count goes inside a cell the board already has, and a column for it is refused rather than merely not built.
- The board draws an ordering as one line inside a cell it already has, and a column for it is refused for the count's reason above.
- The open-tasks chart in the filter card is rebuilt from two timestamps, and says so on the page.
- Closes per day are a second chart beside it rather than a second line on it, because the two are not on one scale.
- The three ways of having nothing are three different screens, and none of them is an empty list.
- The poll does not stand down, which is the deliberate exception to `conventions.md`'s rule that a page stops polling what cannot change.

## [The task's own page: editor, thread and dependency canvas](taskboard/task-page.md)

- The editor is a route, not a card the board opens above itself.
- The editor is never filled from a list row.
- On an existing task, operator-only is its own press and never a field of the draft.
- The thread is drawn on the task's own page, and it does not poll either.
- The task's own page draws the neighbourhood, and the canvas draws while the form writes.
- The assembly is in `src/lib` rather than beside the component because a graph assembled wrongly draws a plausible picture — an arrow the wrong way round is a readable drawing of the opposite…
- Nothing on that surface is coloured by status.
- The second level is one request, and the depth is the route's question rather than the caller's.
- Three ways of having nothing again, and two of them are not the empty canvas.
- The form renders a server refusal verbatim, which is the board's rule one page down and has a second reason here: the loop refusal *names the loop it found*, and that sentence is the only thing…

## [Task notes on the run page](taskboard/run-page-notes.md)

- The run page draws the same notes, carries no composer, and polls — and the three are one decision rather than three.
- One request whatever the run names, and it is keyed on the run.
- What it may draw is `MAX_RUN_TASK_NOTES`, and the line saying so is not the task page's notice.
- The run page does not repeat the run's own notes back to it.
- A note's body is drawn as the characters it is, and that is decided by the field above it rather than by what the text might be.

## [Validating a run's claim to have finished a task](taskboard/completion-validation.md)

- A run's claim to have finished a task can be checked before the board acts on it, and every way that check can fail closes the task anyway.
- The judge is never told that a run claims to be finished, and the prompt is a measuring instrument rather than a setting.
- What the judge is shown is the branch, and uncommitted work is named as not delivered.
- An unfinished verdict buys work cycles, and it may extend exactly one guard.
- A validation is the third `AssistKind`, the only child this app starts without being asked, and the two things that follow are not optional.
- The check is a weak verifier and the strong one is deliberately absent.
