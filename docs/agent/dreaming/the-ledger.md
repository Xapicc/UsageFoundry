# The ledger: claiming, reconciling and retracting notes

[← dreaming index](../dreaming.md)

Read before editing `src/lib/dreamingLedger.ts`, the `dreaming_notes` and `dreaming_nights` tables, or `reconcileDreamingNotes` in `src/lib/dreamingRun.ts`.

**The ledger is the retraction mechanism, and that is why the feature can ship.**
The vault is not a git repository: no history, no author field, and nothing in a
note that marks it as machine-written, so "what did this app write" is a question
only this side can answer. `dreaming_notes` is keyed on the signature itself —
the deduplication test *is* the primary-key lookup — and it is not version
control, it is the list a person deletes *from*. **`forgetNote` deletes the row
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
note that exists.

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

**`recordNight`'s `selected` is sticky.** A night that had already started a run
and then found nothing left on a second pass read back as `quiet`, so the one
surface that shows this feature reported a night that wrote into somebody's vault
as a night that did nothing. A later `quiet`, `refused` or `failed` never
downgrades a night that has written; a later `selected` moves the row to the
newer run, because that is the one whose report the reconciler will read, and
adds to the count. `dreaming_notes` stays the authoritative record of what each
run claimed.
