# Dependencies between tasks

[← taskboard index](../taskboard.md)

Read before editing `src/lib/taskDeps.ts`, the `task_deps` table or `add_task_dependency`.

**A dependency is advisory, and that is the decision every other line about it
rests on.** `task_deps` records that one task has to happen before another, and
nothing in this app acts on it: there is no new status, no new refusal, and no
task made unclaimable because something it waits for is open. A task whose
dependencies are not all `done` is **shown** as blocked — `blockedByCount`,
derived at read time in `depNeighbourhood`, never stored — and every actor that
could claim, start, comment on or close it before still can.
`taskTransitionRefusal` is untouched and is still the whole of the board's
authority model; nothing in `taskDeps.ts` may consult it, extend it or become a
second answer to it. What making this *enforcing* would cost is worth stating,
because it looks like a small change and is not. It would need a fifth reading
of "may this move" that is not in that one function — so either the function
grows a dependency on a second table, or a second authority appears beside it,
and the whole reason this board is safe to hand three kinds of agent is that
there is exactly one place to read. It would make an ordering somebody typed
into a deletion of a press: a task blocked by a dependency the operator dropped,
or by one filed by a chat turn that misread the folder, is a task they can no
longer claim, on the strength of a row nothing audited. And it would put a lock
back in a feature that deliberately has none — `claimed` has no clock on it for
reasons two paragraphs up, and an enforced edge is the same failure arriving
through the other door, work held back by a record nobody is watching expire.
The lever that exists is visibility, exactly as it is for a stale claim.

**One kind of edge, and the absent condition column is the design.** `run_deps`
carries `on-success`/`on-finish` because it gates a *start*: something is
waiting on the answer, so what counts as satisfied has to be explicit on the
wire — `dependencies.md` has that argument. This edge gates nothing, so there is
nothing for a condition to decide, and a kind would be a field every reader has
to branch on for no behaviour. `depIsBlocking` is the whole of what "satisfied"
means here and it is one comparison: `done` clears an edge and nothing else
does. **`dropped` deliberately still blocks.** A task somebody decided should
not happen has not been *done*, and the ordering its dependent was given still
says it comes first; reading `dropped` as satisfied would quietly mark a
dependent ready on the strength of work nobody did, and unlike a wrong status
that reading is drawn as a word rather than stored, so nothing anywhere would
say so. What the operator gets instead is the dependency's own status beside it,
so the thing in the way names itself and the edge can be removed.

**`parent_task_id` is a different relation and stays one.** It records that a
run filed a task while working another — provenance, and the answer to "where
did this come from" — and it is not "this blocks that". Nothing reads the two
together, nothing derives one from the other, and a future editor tempted to
merge them should note that they disagree in both directions: a task filed
during another's work usually does *not* have to wait for it, and two tasks with
a real ordering between them usually have no parentage at all. The two are drawn
differently for that reason and the doc for the page says which is which.

**A self-edge is refused by name and a loop is refused at the write door, and
the loop test is `dependencyCycle` rather than a second walker.** Both failures
are silent: a self-edge stores happily, reads back as a task waiting for itself,
and renders as a row permanently blocked by nothing a person can act on; a loop
is worse and quieter, every task in it blocked for ever, each pointing at the
next, with no surface in a position to notice that the set as a whole can never
clear. The self-edge gets its own sentence rather than falling out of the walker
because what a person has to do about it is different — there is no edge to
break somewhere else, there is one press that was wrong. For the loop,
`orchestrator.ts`'s `dependencyCycle` is the one definition of what a cycle is
in this app, as its caller in `workflows.ts` already records; taking a second
copy here would be two answers to one question, and the id pairs it walks are
agnostic about what the ids are — it was generalised to `DependencyNodeLink` in
this change for exactly that reason, because a task edge has no `edge` kind to
supply and a fabricated one carried only to satisfy a signature is a lie in a
type. It is handed the stored edges **plus the proposed one**, which is sound
because this door is the only writer and the graph on disk is therefore already
acyclic. The refusal **names the loop it found**, through titles the door passes
in: a path drawn out of four UUIDs is a sentence nobody can act on.

**A duplicate edge is not an error, and the answer says it was already there.**
The primary key over the pair is what makes the insert idempotent —
`ON CONFLICT DO NOTHING` rather than a read followed by an insert, since a
check-then-insert is a window in which a second door writes the same pair — and
`created` is read off the statement's own `changes` rather than a second read's
guess. The distinction is not cosmetic: a caller told nothing cannot tell "I
drew this" from "this was already drawn", which is exactly what a model retrying
a tool call is acting on. **Removing an edge is the opposite and is a 404.** A
repeated add is a caller restating something true; a remove that found nothing
means the row the press was drawn against has changed underneath it, and a board
told "done" would redraw itself as though the press had landed.

**Edges across projects are allowed, and the wire carries which project each end
is in.** A task in one folder blocking one in another is precisely the case an
operator needs shown — it is the ordering they cannot see any other way — so
nothing refuses it and `TaskDepRefDTO` carries `mountId`, `mountLabel` and
`relPath` beside the title and the status. They are split by the same
`describeFolder` `taskDTO` uses, so a task drawn as a row and the same task drawn
as somebody else's dependency cannot disagree about where it is, and the stored
`mount_id` travels rather than a resolved one on `taskDTO`'s rule: a mount the
operator renamed leaves the task where it was filed and the label is what goes
null. On the tool surface the same fields ride `get_task`'s refs, because
"which repository is this waiting on" is not answerable from an id.

**Adding an edge is available to chat and to a run; removing one is the
operator's alone.** `add_task_dependency` is on both MCP surfaces — refused to
an orchestrator block, which sees the board through one node of one workflow
with nobody reading its reasoning — and **neither surface has a tool that
removes an edge**. The gate is not a refusal to be found in a pure function: it
is that the tool does not exist, and `DELETE /api/tasks/[id]/deps` behind the
app's ordinary gate is the only door. A model silently undoing an ordering the
operator drew is the quiet reversal the rest of this board's rules exist to
prevent, and it is quieter here than anywhere else on the board — a status that
moved leaves a status behind, a note that was written stays written, and an edge
that has been removed leaves nothing at all saying it was ever there. The
asymmetry is deliberate and is the same shape as the one on statuses: what an
agent may *record* is wide, what it may *undo* is the operator's.

**The edge records no author, and that absence is not an oversight.** Three
doors write one, all three write the same fact, and an edge is not a claim about
who noticed the ordering — where a *comment* is a sentence somebody later acts
on, which is why that table records its author and refuses a body that names
one. What would make an author column load-bearing here is a rule that read it,
and the only candidate is "a run may remove what a run drew", which is the
enforcement decision above arriving through a side door. If an author is ever
added, that is the paragraph it has to answer.

**The neighbourhood is on `TaskDTO`, is passed rather than read, and its lists
are capped while its counts are not.** `taskDeps.ts` sits on the far side of
`tasks.ts`'s one-way dependency exactly as `taskComments.ts` does, so a
neighbourhood reaches `taskDTO` as an argument and the empty one is written
inline there rather than imported — a `NO_TASK_DEPS` taken from the other module
would close the loop for five zeroes. What it must never become is a *read*: the
board asks for a whole page in one request precisely so it can draw a row
without a second one, and a call inside `taskDTO` would be an N+1 on a
ten-second poll; `depsForTasks` answers a page in two queries, one per direction,
because the two directions are two different joins and
`idx_task_deps_depends_on` exists for the second. The lists are capped at
`MAX_TASK_DEP_LINKS`, ten, because nothing bounds how many edges one task may
accumulate and `MAX_TASK_PAGE` rows each carrying two unbounded neighbour lists
is the payload to avoid. The counts beside them are **not** capped, on
`runCount`'s rule, and `blockedByCount` in particular is counted over every edge
*before* the lists are cut: counted over the capped list instead, a task waiting
on twelve things with the first ten done would report itself ready, which is a
number drawn on a row, wrong, with nothing saying so. What a cap drops is the
**done** end of `dependsOn` — the mirror of a clipped thread losing its oldest
note, and for the same reason: a list of four finished dependencies beside a
`blockedByCount` of three names nothing a reader can act on. Anything drawing
the graph itself must check `dependsOnCount` against `dependsOn.length` rather
than treat the list as the edge set.

**Every tool that mentions an edge says twice that it holds nothing back.** The
failure this feature can produce on the agent surface is not a bad write — a
misdirected edge is a wrong ordering on the board and is visible as one, which
is why `add_task_dependency` takes two task ids without being held to
`list_my_tasks`' id rule, the same argument `comment_on_task` makes. It is a
model *reading* an edge as a gate: stopping work on a task it holds because
something upstream is open, or telling the operator that a run cannot start.
Nothing in this app reads `task_deps` when a run starts, when a task is claimed
or when one is closed, so the tool descriptions, the success reply,
`get_task`'s `dependencyNote` and `list_my_tasks`' `note` all say so in words —
a shape alone cannot carry it, because two arrays of task ids read as a queue
unless something says they are not. The chat's copy carries one sentence more,
because a chat is the surface that plans work: an ordering recorded here must
not be read as a way of sequencing runs, and a model that believed otherwise
would propose a chain and then not propose the second half of it.

**An edge moves nothing, `updated_at` included.** Nothing on this path calls
`updateTask`, and nothing here may: that column means the task moved and the
board sorts on it, so drawing an edge would reorder the board and read as
somebody having worked on the task. It is the comment table's rule and it holds
on both ends of the pair, which is the half worth stating — the write touches
two rows and only one of them is the obvious one.

**`task_deps` did not bump `SCHEMA_VERSION`**, and the reason is that constant's
own docblock rather than an omission: it is bumped for a migration that is
something other than an added column or an `IF NOT EXISTS`, and this is two
`IF NOT EXISTS` statements, as `task_comments` was before it. Both ends cascade,
`run_deps`' reasoning with one difference that matters — a task *is* deleted, by
the operator and by nobody else, where nothing in this app deletes a `runs` row
— so an edge naming a row that is gone is an ordering no reader can place. The
two columns are two separate foreign keys and both are declared, since a table
carrying only one would leave half the edges standing after a delete.
