# The task's own page: editor, thread and dependency canvas

[← taskboard index](../taskboard.md)

Read before editing `src/app/tasks/[id]/page.tsx`, `src/components/TaskEditor.tsx`, `TaskThread.tsx`, `TaskDependencies.tsx` or `TaskDepGraph.tsx`, `src/lib/taskDepGraph.ts`, or `src/app/api/tasks/[id]/deps/route.ts`.

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
move the task to a folder nobody picked. Whether the scan offers it has three
answers, not two, and `storedFolderState` beside `guardBadge` in `format.ts` is
where they are told apart: until `/api/folders` answers, and for good when it
fails, the stored mount and folder are kept as their own options and the warning
that the folder has left the scan is withheld, because a list not yet read is
not a list without the folder. A failed read draws a notice saying the workspace
list could not be read, with a retry, rather than a picker that offers no mount
and says nothing — which on `tasks/new` read as a container with nowhere to put
a task.

**On an existing task, operator-only is its own press and never a field of the
draft.** The draft is seeded once and this page does not poll, so a run that
released the task and marked it while the form was open would have its mark
cleared by the next save of an unrelated field — and the next run would be started
on work the last one had just said needs a Mac. So `tasks/[id]` draws a toggle
that sends `{ operatorOnly }` alone, against the row as last read, and re-reads
after; `TaskEditor` sends the flag only when filing, where there is no row for
anything else to have marked.

**The thread is drawn on the task's own page, and it does not poll either.**
`TaskThread` in `src/components/TaskThread.tsx` — lifted out of the page when the
run page grew a second reader, and `TaskCommentRows` beside it is why a note looks
the same on both — reads
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

**The task's own page draws the neighbourhood, and the canvas draws while the
form writes.** `TaskDependencies` holds both, `TaskDepGraph` is the surface and
`taskNeighbourhoodGraph` in `src/lib/taskDepGraph.ts` is what decides which nodes
and arrows exist. The split is the point: **every gesture on the drawing is a
navigation**, a node being a link to that task and nothing else being pressable,
and adding and removing are a picker and a named button underneath. A canvas that
could delete an ordering would put the one write on this board that no agent may
make behind a drag which leaves nothing behind, and it would put it on the half
of the pane that is hidden at 390px. `WorkflowCanvas` is an editor because a
workflow has no other surface; these edges have a page each and a list naming
them in words.

The assembly is in `src/lib` rather than beside the component because **a graph
assembled wrongly draws a plausible picture** — an arrow the wrong way round is a
readable drawing of the opposite ordering, and nothing throws. Four rules, all
asserted in `taskDepGraph.test.ts`. The arrow runs *from* the task that happens
first, which is the reverse of the way `dependsOn` lists things and is what makes
`autoLayout`'s layering mean something: everything left of a node is what it
waits on. The second level expands **outwards only** — a dependency contributes
its own dependencies and a dependent its own dependents — because expanding both
ways at level one pulls in every *sibling*, which on a task half the board waits
for is most of the board and is not an answer to anything the page asks. An edge
is kept only when both its ends are already drawn, which is what the cone leaves
at its rim, and an ordering *between* two of this task's own dependencies is kept
for the same test's other half: they are both on the graph, and leaving it out
draws a chain as two unrelated things. And a neighbourhood the caller did not ask
for cannot widen the drawing or mark it clipped.

Nothing on that surface is coloured by status. `conventions.md`'s rule, and the
case for it is sharpest here: there is one kind of node and one kind of edge, so
the whole drawing is border tones, the **accent** marks the anchor and the edges
touching it — it is the app's "this is the one you are looking at" colour rather
than a tone — and a node's status is a `Badge`, which is where a status tone
belongs and where every other surface here already reads one. The anchor also
says *This task* in words beside the halo, because a graph of four boxes is
exactly where a reader who cannot tell two border tones apart loses the one thing
the drawing is about. The sheet opens scrolled to the anchor rather than to the
origin, since the layout puts everything in front of the task to its left and a
chain three deep would otherwise open showing the dependencies and not the task
they are for.

**The second level is one request, and the depth is the route's question rather
than the caller's.** `GET /api/tasks/[id]/deps?depth=2` answers with the anchor's
own neighbourhood and a `beyond` map of each level-one neighbour's, which is
exactly the second argument `taskNeighbourhoodGraph` already takes. The pane used
to read the plain route once per neighbour — `MAX_TASK_DEP_LINKS` on each list, so
**twenty requests on mount**, each re-entering `depsForTasks`, the function that
exists to answer for a list in two queries. Four queries now, whatever the task's
degree, measured 2026-09-14 as 20 → 1 with the drawing's DOM byte-identical. A
route taking `?ids=a,b,c` was the other way to get there and is the wrong one: the
ids a caller would send are the ones the previous answer just handed it, so it is
the same round trip with a step written down in between. Depth 1 stays the default
and keeps its shape, because it is also what `POST` and `DELETE` embed under
`deps` and neither of those draws a second level. `beyond`'s keys are **sorted**,
and that is the drawing rather than tidiness: the graph walks the map to collect
the second level's edges, so the key order is the order `<path>` elements are
emitted in and therefore which stroke is on top where two curves cross. A
neighbour with no edges of its own is absent from `beyond` rather than present and
empty — `depsForTasks`' rule, which the builder already reads as nothing to
expand — and so is one deleted between the two reads, which is now true of it
rather than a gap, since `ON DELETE CASCADE` took its edges. A task with no edges
at all makes **no** request: there is no second level to ask about.

**Three ways of having nothing again, and two of them are not the empty canvas.**
A task with no edges gets the board's empty state — what an ordering is and that
it is advisory — because a surface with nothing drawn on it says the drawing
failed as readily as it says there is nothing to draw, and most rows here have no
ordering at all. A read of the second level that failed leaves the graph at
its immediate neighbours and **says so**: what a reader would otherwise take for
the end of the ordering is the request stopping, and the two look identical on a
canvas. A neighbourhood clipped by `MAX_TASK_DEP_LINKS` says that too, on
`TaskDepsDTO`'s own instruction that anything drawing the graph check the counts
against the lists — an incomplete picture of an ordering does not look
incomplete.

The form renders a server refusal **verbatim**, which is the board's rule one
page down and has a second reason here: the loop refusal *names the loop it
found*, and that sentence is the only thing telling the operator which edge to
break. Nothing in the browser pre-empts it. The one thing the page declines to
send is a picker nobody has answered, and the one task the picker does not offer
is the page it is on — a self-edge stays refused by name at the door, but
offering the press is an interface asking for something it knows is not an
ordering. Removal against a *dependent* is a request to that task's own route,
because `DELETE /api/tasks/[id]/deps` always takes the waiting task in the path;
a page that could only cut the edges it is the near end of would be half a door.
`created: false` is drawn as *already recorded* rather than as a success, since a
press answered with nothing cannot be told from one that did nothing. And **this
page still does not poll** — the pane refetches the row after a write it made and
claims nothing about what another door did meanwhile, holding a half-made choice
across two selects for exactly the reason the editor above it holds a draft.
