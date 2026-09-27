# Task notes on the run page

[← taskboard index](../taskboard.md)

Read before editing `src/components/RunTaskComments.tsx`, `src/app/api/runs/[id]/task-comments/route.ts` or `runPageNotes` in `src/lib/format.ts`.

**The run page draws the same notes, carries no composer, and polls — and the
three are one decision rather than three.** `RunTaskComments` in
`src/components/` is a block in the inspector on `/runs/[id]`, under a region
called *On the board* and beside `Task`, which is the prompt the agent was handed;
this is what has been said about that brief since. The operator, the orchestrator
and other runs can all write on a task a run is working, and until this block the
operator watching the run had to open `/tasks/[id]` to read any of it, on the
page they were already on. **No composer**
comes first: the operator writes where the thread is read whole, and a second box
here would be a second draft to lose on a page whose business is something else.
That is what makes the rest available. **It polls** because the reason the task
page refuses to is spent — with no draft there is nothing a re-read can throw
away — and because what it is watching, a live agent writing a note, is the whole
reason the block exists; a note that appeared only on reload would miss it. The
interval is the **board's** ten seconds rather than the run page's three: a note
is a row in the same table a board asks about on that cadence, and nothing here
moves faster than somebody finishing a sentence. It is gated on `active`, so a run
that can no longer write stops being asked about — measured 2026-09-14 at three
requests in twenty-five seconds while `running` and one, the mount's, over the
same span once `failed`.

**One request whatever the run names, and it is keyed on the run.**
`GET /api/runs/[id]/task-comments` answers for every board task the run is linked
to at once, in two queries — `newestCommentsForTasks` and `commentCountsForTasks`,
both of which take the list. A thread fetched per task would be `MAX_RUN_TASKS`
requests every poll, which is the N+1 the board's own listing already refuses one
table up. It is **not** a field on `GET /api/runs/[id]`: that payload is polled
every three seconds for the life of a run and a note's body runs to
`MAX_TASK_COMMENT` characters, which is `RunAgentCost`'s route's reason for
existing and the same trade. A task the operator has deleted is absent from the
reply rather than present and empty — `ON DELETE CASCADE` took its notes with it —
and the block draws *a task since deleted* for it and asks nothing, which is the
fourth way of having nothing this surface has and the task page does not.

**What it may draw is `MAX_RUN_TASK_NOTES`, and the line saying so is not the task
page's notice.** Three notes — the last exchange, which is the span that makes the
newest one readable — because the block sits in a column beside ten others and a
thread drawn whole would be the column. Above them, *Newest 3 of 9* and a link to
the task. That is deliberately **not** the `warn` notice the task page draws for
the same shortfall: there the route ran out of room and dropped the oldest end,
which is a caveat, and here the block is drawing exactly what it is for with the
rest one link away, which is a fact about where to find it. `total` covers both
causes because it is counted over the table either way.

**The run page does not repeat the run's own notes back to it.** A note whose
`authorRunId` is the page's own run is not drawn as a row there: its header was
the page's own run id and its body was what the run already reported on its
Report tab, which `/tasks/[id]` also holds whole, so the row was the run's final
report a second time in a column meant for what *others* said. It is counted
instead, per task, in one faint line linking to the task (*This run left 2 notes,
the latest 3m ago*), and that line is kept on purpose: a work cycle writing on its
own task is still the event the poll is for, and a note that vanished without a
word would read as nothing having happened. Notes by the operator, the
orchestrator or **another** run keep their full row, header included, because
there the run id is information. The rule is `runPageNotes` in `format.ts`, and
`TaskCommentRows` is handed fewer rows rather than told to draw differently, so
the task page still draws every note whole. It is decided in the browser from
the reply the route already sends, which has two consequences the line is written
around. Once a thread is longer than `MAX_RUN_TASK_NOTES` nothing on the client
knows who wrote the older notes, so the line says how many **of the newest** are
this run's (*Newest 3 of 7, 2 of them by this run*) rather than a count over the
thread, and never stands *Newest 3 of 7* above one row without saying where the
other two went; the latest one's age is exact either way, since any note of this
run's outside the slice is older than every note in it. And the run's own notes
still take their place in that slice, so a run that has written the newest three
draws no row by anybody else even when an operator note sits just behind them.
That is what the page drew before this rule too, since those three were drawn as
rows then; a per-author count and an others-only slice on
`GET /api/runs/[id]/task-comments` would buy both an exact count and three rows by
somebody else, and is the change to make the day a run writing a note per work
cycle makes that trade matter. A thread holding only this run's notes draws the
line and no rows, never *Nothing said yet*.

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
