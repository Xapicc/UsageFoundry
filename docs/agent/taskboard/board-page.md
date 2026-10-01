# The board page

[← taskboard index](../taskboard.md)

Read before editing `src/app/tasks/page.tsx` or the pane list in `src/components/shell/panes.ts`.

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

**The board reads every row, one status at a time, and narrows only the project
in the browser.** It used to ask for one page of `MAX_TASK_PAGE` rows across
every status and narrow everything in the browser, and that trade stopped
holding on 2026-09-26 at 816 tasks: the listing is priority first, so long-done
urgent work outranked today's normal work, and the one page held 215 Done rows
while 77 of 154 Open and 5 of 13 Claimed were not on the board at all — with a
notice that named only the total, which is the "board that looks like an
answer" failure one layer up from the route. So status is narrowed **in the
query**, on `/api/runs`' rule: one request per status the board draws, each with
its own offset, paged to its end in steps of the first page's length, the later
pages asked for together once `total` is known. The per-request ceiling stays —
it is what stops one request serialising the table — and **the answer to a
bigger board is more pages, never a larger cap**. The read is all or nothing,
because a board missing one status draws that group as empty, which reads as a
clear backlog; and a row that moved between two of the requests is kept once by
id, with one that slipped between two pages back on the next poll. The project
filter is one of the two narrowings still done in the browser, because its options are
derived from the same answer the rows are, so the select can offer neither a
project the board cannot show nor a hidden one it can; built from
`/api/folders` instead they would need a mount root joined to a stored relative
path *in the browser*, which is the second, looser resolver the `resolveInMount`
paragraph in [tasks-and-transitions.md](tasks-and-transitions.md) exists to prevent. The other is the operator-only filter beside
it (all work, agent work, operator only), which follows the project filter
rather than the query: in the browser over the same rows, not kept in the URL
because the project filter is not, and counted within the chosen project because
that is the set it narrows. `MAX_TASK_PAGE` lives in `apiTypes.ts` beside
`MAX_LIST_TASK_BODY`, not in `tasks.ts`, because the dependency picker still asks
for exactly one page of it and says when `total` was larger — written twice, it
would ask for a number the route quietly reduced and then report a whole list it
had not been sent.

**The board draws controls; it never decides a move.** Every press on this page
is a `PATCH` and the sentence that comes back is rendered verbatim, because
`taskTransitionRefusal` is a server module a `"use client"` file may not import
and a mirrored copy of the edge table in the browser is a second set to keep in
step — confidently wrong about what a press does, from the moment one of them
changes. What the page *does* decide is which buttons to draw, and that is the
smaller claim: the operator's own edges. Claim is among them on an **open** row
only — the operator holding the task themselves, in Release's slot so an open row
is no wider than a claimed one — and never on a claimed row, because taking a
run's task is a release and then a claim, two presses the operator sees. The
holder cell draws "Held by you" for the operator's claim, since a claimed row
naming no holder reads as a claim nobody is working. A row that moved between the poll that drew it and the press against it is
exactly when the server's refusal matters, so it is shown rather than swallowed
and the board is re-read either way. The in-flight state is keyed on the *edge*
(`id:status`) and not on the row: keyed on the row, pressing Done lit Release
and Drop too, which reads as three presses having been made.

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

**The board draws an ordering as one line inside a cell it already has, and a
column for it is refused for the count's reason above.** `DepLine` in
`src/app/tasks/page.tsx` goes in the Task cell under the title, above the
provenance — it is about the work rather than about where the brief came from,
and `Blocked by` is the thing on this page somebody scanning a backlog is looking
for. **Nothing at all when a task has no edges**, which is the Runs cell's
decision one column over and matters more here: most rows have none, so a marker
that drew on every row would be a column of the word none with a seventh `min-w`
paid for it. It names **one** neighbour a side and counts past that — measured,
not chosen: two a side rendered as six wrapped lines under a two-line title at
1280px, because that cell is whatever the six min-width columns leave. The
stacked layout at 390px would carry more and deliberately does not get more, or
the same board would say different things on a phone and on a laptop. What
decides between a name and a count is the **count**, never the list's length:
`TaskDepsDTO`'s lists stop at `MAX_TASK_DEP_LINKS` and its counts do not, so a
line reading the list would report a task waiting on fourteen things as one
waiting on ten. The blocking half is `dependsOn.slice(0, blockedByCount)` and
that is sound only because `depNeighbourhood` partitions the list blocking-first;
the browser never re-tests a status, because `depIsBlocking` is a server module
and a copy of "done clears an edge and nothing else does" over here is a second
answer to when an ordering is satisfied. An ordering that has fully cleared still
draws — as *After* rather than *Blocked by* — since a row that drew nothing for
it would say this task was never put behind anything.

**The open-tasks chart in the filter card is rebuilt from two timestamps, and
says so on the page.** `OpenTasksChart` counts, at the end of each of the last
seven local days and at the poll's `fetchedAt`, the rows both selects narrow to
that had been filed and not yet closed — over every status, because a row closed
today was open on Tuesday, which is also why no status narrows it. The table has
no history to read instead: `closed_at` is cleared on the move back out of done
or dropped, so a reopened task counts as open for its whole life, a deleted one
is missing from every day it was on the board, and with no `claimed_at` open and
claimed are one line, since two would draw a history nothing recorded. That is
what the muted line under it says, and why it is computed in the browser from
the rows already on screen rather than by a route, which would look like a
record. Eight points rather than seven, so the first is where the week began and
the change printed beside the line is the whole seven days'. It takes `Field`'s
anatomy — a label, a control-height row, one muted line — so the card is no
taller for it.

**Closes per day are a second chart beside it rather than a second line on it,
because the two are not on one scale.** The open count is a level in the tens or
hundreds and closes are a handful a day, so one plot would need two scales, and
then a crossing or the gap between the lines reads as a comparison that means
nothing. `ClosedTasksChart` takes `closedTaskSeries`, which counts the rows whose
`closed_at` falls in each of the week's seven local days, today so far — seven
points, because the day ending at the open series' first point is the one before
the week — and the interval is half-open on the side `isOpenAt` is, so the week's
closes are exactly what the open line lost beside what was filed. It is scaled
from zero rather than to its own range, because a day nothing closed is a reading:
on its own range 5, 6, 5, 6 draws the sawtooth 0, 6, 0, 6 does. The bold figure is
today's count, the dot drawn larger, as the open chart's is its last point; the
week's total is the muted text beside it. Its muted line says done and dropped
both count, since `closed_at` is set by either and the label alone reads as
"completed"; a close undone by a reopen is on no day, for the reason above. The
page wraps the pair in one box so they wrap and align together, which at 1280px
puts them on a second row of the card.

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
