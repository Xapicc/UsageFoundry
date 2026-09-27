# A run and its tasks: the notice, the claim, the setting and the link

[← taskboard index](../taskboard.md)

Read before editing `TASKBOARD_NOTICE` in `src/lib/cycleInvocation.ts`, `claimTasksForRun` in `src/lib/orchestrator.ts`, `taskboardForRuns`, `readTaskLinks`/`taskRefusal` in `src/lib/tasks.ts`, or `run_tasks`.

**The run is told the board exists on the appended system prompt, and the notice
rides the same value the flag does.** `TASKBOARD_NOTICE` in `cycleInvocation.ts`
is keyed on `buildArgs`' `taskboard` option, so a run cannot be told to call
tools it does not have and cannot have them without being told — the two failures
that pairing exists to make impossible, both of which look like a normal run from
the outside. What it says is **behavioural rather than descriptive**: the tool
list already says what the tools are, and a model reading only that closes its
task and stops, or finds a second defect and fixes it because nothing told it
there was anywhere else to put one. "Complete only what you hold", "give back what
you cannot finish" and "file what you find rather than fixing it" are the
sentences that earn their tokens; the middle one is there because a run that
stops with its task held leaves the board saying a finished run is working it.
What it may **not** carry is `security.md`'s rule about literals: nothing on this
prompt may give an agent a pattern that selects a process. The four tool names
are shared across every board-enabled run on the box and are exactly that kind of
literal — what keeps them safe is that nothing near them offers a pattern, no
verb selects a process, no command is named and there are no digits at all. They
are named rather than alluded to because a model told "there is a board" without
the names writes prose about filing a task instead of filing one. A run without
the board gets an appended prompt **byte-identical** to the one this app sent
before the feature existed, the file price list's rule: a run mid-flight across a
deploy that gained one newline would otherwise pay a cold prefix for a notice it
did not get.

**A run started from tasks claims every one of them when the run starts, not when
a tool is first called.** `claimTasksForRun` fires at the top of `startRun`,
before the worktree and before the first cycle, and claims each linked task on its
own in the order they were named, so one that cannot be claimed leaves the rest
claimed. A claim written at the first `list_my_tasks`
is a claim a run never writes if the setting is off, if the model never opens the
tool, or if the cycle dies before it does — so the board would show `open` for
work already in flight, and the chat tool that exists to stop two agents taking
one brief would be reading it. It is deliberately **not** gated on
`taskboardForRuns`: the claim is this app writing down what it just did, and the
setting is about what an *agent* may do, so a run started from a task with the
board switched off still holds it. Every refusal on that path is a log line and
never a failure — a task somebody dropped, one another run still holds, one the
operator deleted between the press and the start, one marked operator-only since
the proposal named it. None of them says anything
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

**A run that came off the board carries the link, and the link is a record
rather than a trigger.** `propose_run` and `emit_runs` each take an optional
`taskIds` list. It rides `chat_proposals.task_ids` from the proposal and lands in
`run_tasks` **inside `createRun`'s own transaction**, carried in on
`CreateRunInput.taskIds` from the approval or the emission, so nothing can see
the run without seeing what it was started for. Approving or emitting moves
nothing on the board — the run's own claim at its start is the move — and the
run reaching a terminal status does not close anything. A run can complete and
still not have done the thing — it can stop on a budget, be cancelled, or finish
having decided the work was wrong — so a status-derived rule here would close
backlog items nobody worked. Completion belongs to the run that did the work, in
its own name, or to the operator's press. Nothing in the run *loop* reads the
table either: not a guard, not the budget, not occupancy. A run carrying task ids
and one that is not are the same run, which is why the SQL still lives in
`tasks.ts` and `createRun` holds only the ids.

**One run may be for several tasks, and it is linked to every one.** The link
was a single column, `runs.task_id`, and the failure it produced was the one this
file exists for, at scale: a chat batched two or three board tasks into one run's
brief — "Board tasks A, B and C" — and linked A. The run claimed A, did the work
for all three, and could close only A, because `complete_task` refuses what was
not claimed in its own name. Ten tasks in one batch stayed open that way, and a
dozen more before it, with nothing on the board or the run saying why. So the
link is a list, capped at `MAX_RUN_TASKS` because that is what `list_my_tasks`
shows of what a run holds — a run linked to more could claim a task it is never
shown. `runs.task_id` and `chat_proposals.task_id` are backfilled into
`run_tasks` and `task_ids` and are no longer written or read; they stay because
dropping them is a rebuild and a rolled-back image still reads them.

**A brief that names a board task its run is not linked to is refused, and that
is what keeps the list from being optional.** A list the model may leave short is
the single column again with more room in it. `readTaskLinks` in `tasks.ts` reads
every proposal and every emitted spec — including one that names no task at all,
which is precisely the failing shape — and refuses when the run's text (title,
brief, prompt override) names an **open or claimed** task by its whole id, by
its first eight characters standing alone, or by its whole title past
`MIN_MENTIONED_TITLE`, and that task is in neither `taskIds` nor
`relatedTaskIds`. The refusal names each task and says both ways out.
`relatedTaskIds` is the second one and it records nothing: it is how a brief says
it mentions a task *on purpose* — "separately filed as X and not in scope",
"another run holds Y" — and it exists because those sentences are real: measured
against every prompt this install had run, the id matches included exactly that
kind of context alongside the bundles. Refused rather than linked automatically,
for that same reason: a claim written off "do not touch the task another run
holds" would be this app deciding what a run is for. Closed tasks never count as
mentioned, since naming finished work is context, and a short title never does,
since "Fix the README" is a phrase any brief can contain. The title match is a
detector rather than a proof — a brief that paraphrases a title slips past it,
which the batch it was measured on did once in ten — and it is the second line;
the tool descriptions and both system prompts saying "every task this run works
goes in `taskIds`" is the first. `taskId`, the field this replaced, is refused
by name, because a caller still sending it would believe it had linked something.

**The links have to be written before the run can be promoted, and that is the
one ordering here whose violation is silent.** It used to be a `recordRunForTask`
call on the line after `createRun` returned, which reads as the same synchronous
pass and is not: `createRun` ends by calling `promoteQueued`, `startRun` runs to
`claimTasksForRun` without an `await` in between, so the entire claim happens
*inside* the `createRun(...)` call expression. The link was not written yet, the
claim found nothing and returned at its first line — the one branch that logs
nothing, because a run that names no task has nothing to say. The board then
showed `open` for work already in flight, and the run could never complete the
task afterwards either, since a run may complete only what was claimed in its own
name. It bit only runs that started immediately; a run that queued behind a busy
folder was promoted later, after the write, and claimed correctly. Anything that
gives a new run task ids must hand them to `createRun` rather than write them
afterwards.

**An unknown task id is refused by name, and a *closed* one is not.**
`taskRefusal` in `tasks.ts` is the one wording, reached through `readTaskLinks`
for both lists, so an id that is not there reads the same in a chat, in an
emission and in `get_task` — `agentRefusal`'s ground.
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
rather than a missing one.** Neither `chat_proposals.task_ids` nor `run_tasks`
is a foreign key — the operator deletes tasks freely and nothing in this app
deletes a `runs` row, so a cascade would describe a deletion that never happens
in one direction and destroy a run's provenance in the other. `tasksLinkedToRun`
returns the id with `title` and `status` both null where the row has gone, and
every surface that draws it tells that apart from "no task": the run page says
*a task since deleted*, the proposal card says the same, and neither links,
because the row they would open is not there. A surface that collapsed the two
would lose exactly the provenance the column exists to hold.
