# The ledger: claiming, reconciling and retracting notes

[← dreaming index](../dreaming.md)

Read before editing `src/lib/dreamingLedger.ts`, the `dreaming_notes` and `dreaming_nights` tables, or `reconcileDreamingNotes` in `src/lib/dreamingRun.ts`.

**The ledger is the retraction mechanism, and that is why the feature can ship.**
The vault had no history, no author field, and nothing in a note that marks it as
machine-written, so "what did this app write" is a question only this side can
answer. It has since become a git repository (2026-10-24), and that does not
change the answer: a landed branch says where a night's notes entered, not which
of them a person later edited, and a person's own commits sit beside them.
`dreaming_notes` is keyed on the signature itself, so the deduplication test *is*
the primary-key lookup, and it is not version control, it is the list a person
deletes *from*. **`forgetNote` deletes the row
and never the file.** Retraction in the vault is a person moving a file in
Obsidian, and an app that deleted from a mount it does not own would be doing
something heavier than anything else in this codebase, against a store with no
undo. What forgetting buys is that the signature stops being suppressed, so the
next qualifying night writes it again — which is the intended repair for a note
that came out wrong.

**Signatures are claimed before the run writes, not after it reports.** A run
that crashes half way has still written some of the files, and a ledger written
only on success hands the same signatures to the next night — which is the
duplicate `_Meta/Vault Conventions.md` names as the failure mode its conventions
exist to prevent. Over-claiming loses a note; under-claiming leaves a second note
beside one that is already there, and only the second is a mess in somebody's
document store. `note_path` stays null until a report says otherwise, so a
claimed-but-unwritten row reads as "attempted, no file recorded" rather than as a
note that exists. That is the rule for a run working in the vault's own folder. A
run on a branch writes nothing into the vault until the branch lands, so its
signatures wait in `dreaming_pending` and are claimed then, which is
[`landing.md`](landing.md)'s.

**`reconcileDreamingNotes` is keyed on the run and never on the night.** Two
passes share a calendar night — a press at noon and the timer at 03:04 — but not
a prompt: each run was handed only its own selection and numbered it from 1.
Indexing a night's rows as one list maps the second run's `NOTE 1` onto the first
run's first signature, attaching a real path to a row about a different failure,
and nothing reports it: both rows exist, both point at real files, and only the
pairing is wrong. It reads the **last** `assistant` event, on `cycleOutputs`'
rule — an earlier turn saying `NOTE 1 draft.md` is a plan, not a result — and
never overwrites a path it already has, so a reopened run that says nothing
cannot blank a row pointing at a real file. It runs at read time in the route
rather than in the run loop: the pane is the only consumer, and a Dreaming-shaped
branch inside the orchestrator's cycle handling would be this feature reaching
into the loop every other feature is careful not to touch.

**`reconcileDreamingNotes` maps `NOTE n` on the stored `prompt_item`, never on a
row's position among the run's rows that are left.** `forgetNote` deletes a row
and every later row of that run moves up a place, so a position map attached
item 1's path to item 2's signature on the next reconcile of a run still
waiting on its report — and the pane's retraction list then sent a person to
delete the wrong file from their vault. `claimSignatures` stores each row's
1-based place in the array it was handed, which must be the array
`buildDreamingPrompt` numbers and in its order, and `claimedByItem` reads it
back. A `NOTE` line whose row has been forgotten is dropped, because forgetting
is what lets a later night write that signature again. Rows claimed before the
column existed carry a null `prompt_item`, and a run holding one falls back to
claim order — right until one of its rows is forgotten, which is all those rows
ever had. `dreamingLedger.test.ts` pins both: forget-then-reconcile, and the
fallback.

**An item's row records the note the item is about, never the hub that links it.**
The vault's `LINK/orphan` rule makes every new note two writes — the note, then a
hub edited to point at it — so a run reports several files for one item, and the
parser used to keep the **last** line, which is the hub. Measured 2026-10-08 over
the 19 Dreaming transcripts under `~/.claude/projects/-workspace2/`, taking each
one's final assistant message: 16 reported several files for an item, 49 items
did, the last line was a hub (`Agent Error Memory.md`, `Standing Failures in This
Install.md`, a `… MOC.md`) in 45 of them and the first line in none. Recorded, a
hub makes `note_path` — the list a person deletes from — name a file shared by
every other item, and `noteStillPresent` then badges a row "deleted" or "present"
on the hub's account rather than the note's. Nothing reports it: the path is real
and the file is there. The prompt now asks for `NOTE <n> created <path>`, or
`NOTE <n> edited <path>` when the item grew an existing note and wrote none, and
says not to report a file edited only to link; `parseNoteLines` keeps the first
`created` line, else the first of the rest. First, because no real report listed a
hub before its note and a line with no verb — the old format, and what a run that
was never reconciled still holds — cannot say. The prompt and the parser change
together: a prompt that stopped saying it would still run and the parser would
still parse, and only the ledger would drift back to the hubs.

One path and not all of them, because `note_path` is one column and every reader
takes one — the DTO, the pane's cell, `noteStillPresent`, `list_recurring_failures`
— and because a second note an item created (a source, a question) is a note other
notes link to, so the one the item is about is the one to send a person to. Two
limits follow. The row does not record which verb it came from, so an `edited`
row names a note that existed before Dreaming and the pane cannot say so. And a
row reconciled before this change keeps the hub path it was given, since
`reconcileDreamingNotes` never overwrites one; only a row still waiting on its
report is read by the new parser. `repairDreamingNotePaths` is what moves those.

**Rows attached before that change are repaired once, by a pass that is not
`reconcileDreamingNotes`.** The never-overwrite rule stays, because it is what
stops a reopened run that says nothing from blanking a real path, so the repair
is a separate boot-time pass (`instrumentation.ts`, after `reconcileOnBoot`)
gated on the `dreaming.notePathsRederivedAt` settings key and written only when
the whole pass returned. Run on every boot it would rewrite the row of a run
reopened since and now ending on a different report. The decision is
`rederivedNotePaths`, pure: for each row that already has a path, it takes the
current parser's path for the row's item and updates the row only when that
differs from what is stored. It never writes an empty path, and it skips a row
whose run is gone, not terminal (no final message yet), reported nothing, or no
longer yields a line for the item. One more refusal is what lets it run blind,
because `/data` is not readable from a work cycle: a row is repaired only when
the path it holds is one of the lines this report wrote **for the item the row
maps to**. That is true of a row the old parser filled from this item and false
of a row that `claimedByItem`'s position fallback has slid onto a neighbour after
a `forgetNote`, so a legacy row cannot be handed another item's note. Rows it
leaves holding a hub are those whose run's events retention has deleted, or whose
report never listed the note first; `forgetNote` is the repair for those, at the
price of the next qualifying night writing that signature again.

**`recordNight`'s `selected` is sticky.** A night that had already started a run
and then found nothing left on a second pass read back as `quiet`, so the one
surface that shows this feature reported a night that wrote into somebody's vault
as a night that did nothing. A later `quiet`, `refused` or `failed` never
downgrades a night that has written; a later `selected` moves the row to the
newer run, because that is the one whose report the reconciler will read, and
adds to the count. `dreaming_notes` stays the authoritative record of what each
run claimed.

**A night's `outcome` is its decision and never its run's ending; the Nights tab
reads the ending from `runs` at list time.** `dreaming_nights.outcome` is written
once per pass, before the run has done anything: `failed` only when
`runDreamingNight` threw, with no run to name, and a run that was created and
then failed, was stopped or was killed stays `selected` for ever. The tab used to
claim "wrote" for it, then "run started", and neither could say that the run
ended badly, so the only way to learn that a night wrote nothing was to open the
Log link of every `selected` row. `listNights` now LEFT JOINs `runs` on `run_id`
and carries `runStatus`; `/api/dreaming` passes it on as `runEnding` and the tab
draws it as a second badge beside `run started`. Three choices there fail
silently. The status is **read, not copied** into the night's row, because a copy
is stale the moment the run moves and would need a writer in the run loop, which
this feature does not reach into. It is a **LEFT JOIN**, because retention
deletes old runs and an inner join would take the night out of the list with its
run. And the route **nulls any status not in `TERMINAL_STATUSES`**: the pane
reads once and never polls, so a `running` badge would still be on screen hours
after the run ended, while an ending cannot go stale. "Has this run ended" has one
answer in the codebase and this asks that constant rather than keeping a list of
the live statuses.

The status is the **latest** run's, by `recordNight`'s sticky rule above: a second
pass that also selects overwrites `run_id`, so a first run that failed under a
second that completed shows `completed`, and the Log link beside it opens the same
run. The tab says nothing about this on the row; the earlier run's status was
never reachable from the table and the link already behaves the same way, so the
only new fact is that the badge and the link agree. `dreaming_notes` still holds
which run claimed which signature. `dreamingLedger.test.ts` pins the join, the
null for a night with no run, the null for a run row that is gone, and the
latest-run rule.
