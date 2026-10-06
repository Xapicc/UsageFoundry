# The board's MCP tools, subjects and the per-run token

[← taskboard index](../taskboard.md)

Read before editing the board's tools or `toolsFor` in `src/app/api/mcp/route.ts`, `taskVisibleToRun` in `src/lib/tasks.ts`, or `mintRunCapability` in `src/lib/chat.ts`.

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
idea of the work. The refusal a block gets names `list_tasks` and the `taskIds`
field rather than pointing at `emit_runs`, because answering "write this down for
later" with the one tool that starts work *now* is the opposite of what was
asked. A **work cycle** gets neither of the shared tools and a `create_task` of
its own; the next six paragraphs are its half.

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

**Nothing a chat turn or a block holds can move a task to any status, and that is
enforced twice rather than once.** (A work cycle moves only its own claim, to
`done` or back to `open`, through `complete_task` and `release_task`.) `create_task` files as `open`, there is no `status`
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

**A work cycle's tools, and what their absence is.** `list_my_tasks`,
`get_my_task`, `complete_task`, `release_task` and `create_task`, the two notes
beside them (`comment_on_task`, `add_task_dependency`), and nothing else —
deliberately not `SHARED_TOOLS`, so a run has no `list_runs`, no
`get_run_diff`, no `list_folders`, and specifically **no `list_tasks`** and no
`get_task`. The two orchestrator
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

**The count alone was measured not to prevent that duplicate, and
`list_my_tasks` takes a `query` because of it.** On 2026-09-25 nine runs on one
project filed the same task, seven of them within 31 minutes, and every one had
called `list_my_tasks` first and been shown twenty open tasks beside an
`openInFolderTotal` of 69, then 85, then 99
(`proposals/CrossSessionCommunication/00-problem.md` §3): told the list was
short, a run still had no way to read the rest. Across the 25 near-duplicate
title pairs between concurrently live runs, one word of the later title matched
the earlier one, so a search is the read that would have found it. The query is
matched against the title and the brief of every open task in the folder, as a
parameterised `LIKE ? ESCAPE '\'` with `%`, `_` and `\` escaped — left as
wildcards, a search for `50%` answers with tasks holding neither, which reads as
"already filed" for work nobody wrote down — and it folds case the way SQLite's
`LIKE` does, ASCII only. The cap and the count keep their meaning: at most
`MAX_RUN_TASKS` matches, with `openInFolderTotal` counting matches, which is why
the result echoes `query` back, since a total of two with nothing saying a search
ran reads as a backlog that is nearly empty. `held` is never narrowed, because
what a run holds is not a search result. Nothing widens either: a query reads the
open rows of the same folder the list reads, and nothing else.

**`get_my_task` is the whole-brief door onto exactly those rows, and its scope is
the list's and never wider.** It exists because `list_my_tasks` clips every brief
at `MAX_LIST_TASK_BODY` and runs told to read the task body in full were digging
the rest out of transcripts on disk. Its scope is `taskVisibleToRun`: the list's
two `WHERE` clauses as a predicate on one id — a task this run holds, in any
status, or one open in the run's own folder — rather than membership of the
capped list, so the open task twenty-first in its folder is readable too, since
`openInFolderTotal` has already told the run it exists. A claimed task in the
same folder is refused because it is the brief another run is working from, and a
run whose folder is null reads only what it holds, on the null-folder rule above.
The run id is the token's, as on every other tool here. **"Not yours" and "not
there" are one sentence**, and never `taskRefusal`'s "not on the board": a door
that told them apart is one a run could probe the rest of the board with for
which ids exist. It is deliberately **not** whole bodies on `held`: a run calls
`list_my_tasks` before every `complete_task`, `release_task` and `create_task`, and up to
twenty whole briefs on each of those calls is a recurring cost where a separate
door is read once — the shape the chat surface already has in `list_tasks`
clipping and `get_task` returning the whole. What it leaves out of `get_task`'s
answer is the part about the rest of the board: the runs started for the task and
the runs that filed or closed it are other runs' ids. The neighbourhood it does
carry is `get_task`'s, refs rather than briefs: a dependency in another folder is
named by id, title and status, as `waitingFor` on `held` already names it, and
`get_my_task` on that id is refused like any other.

**An id that is not shaped like one is refused for its shape, before any lookup,
in every board tool that takes one — and no refusal names a tool the caller does
not have.** A task id is a lowercase UUID, 36 characters, and what callers sent
was its first eight: all 31 `No task with id` refusals in the transcripts of
2026-09-09 to 2026-09-25 named a real task's first eight hex digits, and of 226
`get_my_task` calls from 2026-09-27 to 2026-10-01, the two refused were 8-character
prefixes copied out of an opening brief — both for tasks the run could read, and
both told the task was out of scope, which sent them to re-read a list whose ids
were never the problem. An id that is not a string at all is refused by name
before that (`nonStringArg`, `notStringRefusal`'s wording), as is
`list_my_tasks`' `query`: `String()` read `["<id>"]` as the id inside it and
searched for `[object Object]`. The same refusal stands in front of every other
argument that is read as text and used as a filter, a prompt or a stored value:
`list_tasks`' `mountId` and `folder` (an object `folder` read as `[object Object]`
matched no row, which is an empty backlog, the one answer that stops a loop),
`list_past_proposals`' `mountId`, `folder` and `query`,
`list_recurring_failures`' `query`, `save_template`'s `prompt` and
`propose_run`'s `promptOverride`. Absent and `null` keep their meaning. `taskIdShapeRefusal` in `tasks.ts` is asked first by
`malformedTaskId` in the route: the run's `get_my_task`, `complete_task`,
`release_task`, `comment_on_task` and `add_task_dependency`, and the chat's
`get_task`, `comment_on_task` and `add_task_dependency` — and by both doors of
`create_task` for a `parentTaskId` that is named, and by `readTaskLinks` for
every entry of `taskIds` and `relatedTaskIds`. It says "94ec87a2 is 8
characters; a task id is 36" and nothing about the board, and that is why it does
not weaken the one-sentence rule above: it is the same for every id of that length
on every install, so it tells a prober nothing. A shortened id is **never
resolved** to a task, the way git resolves a short hash — which task a prefix
meant is a guess, and this surface writes. The pointer at the end of the sentence
is the tool the *subject has*: `list_my_tasks` for a run, `list_tasks` for a chat.
**No refusal a run can receive may name a tool a run lacks** — `list_tasks`,
`get_task`, `list_folders` — and `taskRefusal`, whose sentence says "Call
list_tasks", is therefore reached only from a chat or an emission; the route's
test sweeps a run's refusals against the tools its list lacks. Where the id is
the point of the call (`get_task`, `comment_on_task`, `add_task_dependency`),
`taskRefusal` is called with `mayOmit: false` and drops "or leave it out — a run
that names no task is the ordinary run", which is true of a proposal's `taskIds`
and meaningless anywhere else. The two lists are only ever read for an
orchestrator subject — a chat's `propose_run`, a block's `emit_runs` — so
`readTaskLinks` points at `list_tasks`, and it asks the shape before
`taskRefusal`, which would otherwise answer a prefix with "No task with id …
is on the board". A run's `create_task` refuses a malformed `parentTaskId` for
its shape too, where it would once have filed the task parentless with no word:
the run can fix a mistyped id, so it is told, and the drop below is kept only
for an id that is well-formed and names no row. The briefs that carried the short ids are written
by an orchestrator, so both orchestrator prompts (`systemPrompt` in `chat.ts`,
`blockSystemPrompt` in `workflows.ts`) and the `task` and `taskIds` descriptions
on `propose_run` and `emit_runs` tell the writer to name a board task by its full
id. `readTaskLinks` still *detects* a brief naming a task by its first eight
characters — that is the second line, and the instruction is the first.

**The run id comes from the token and never from the call, and that sentence is
the entire authorisation of this surface.** `CapabilitySubject` gained a third
arm, `{ kind: "run"; runId }`, and it is the one whose id is load-bearing rather
than descriptive: `complete_task` passes `subject.runId` to `updateTask`, which
compares it against the row's own `claimed_by_run_id` through
`taskTransitionRefusal` — the same pure function the operator's route and the
chat tools ask. Ahead of it, `notHeldByRun` refuses `complete_task` and
`release_task` on a task the run does not hold that nobody has claimed — open,
or closed by somebody else — in a sentence naming no title. It words a refusal
and permits nothing: the rule lets `from === to` through, so a `done` task
another run closed came back as completed by this one, and `releaseTask`
refused an open task by quoting its title, both for any id on the board — two
writes answering as a read wider than `get_my_task`'s. An id on no row and a
task another holder has claimed still reach the rule's sentences, which name
the holder and never the title. A task the run *does* hold that is already
`done` is answered from its row before any close is tried — completed by this
run, or closed by the operator, whose close leaves the run column set — since
the same no-op would report a close the call never made, and the run repeats it. **No tool on this surface takes a run id**, and that is not an
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
it defaults to the first task the run was started for, and a parent that has been **deleted** is
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
