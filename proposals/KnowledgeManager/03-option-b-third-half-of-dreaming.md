# Option B — a third half of Dreaming, on Dreaming's clock and ledger

## What it is in this app

Dreaming has a readout that writes nothing and a writer that is a nightly run
(`docs/agent/dreaming/halves-and-write-policy.md:7`–`:17`). A third half,
"upkeep", would be started by `tickDreaming` after `runDreamingNight` — or as an
`on-finish` dependent of the writer's run (`src/lib/orchestrator.ts:5172`) — as
a Haiku run in the vault root with `originRef: "dreaming:<night>:upkeep"`, a job
list taken from the night's `NOTE` lines, and its own rows in the ledger.

## Its strongest case

- **The debt is made here.** Two of the three Haiku-class corpus tasks are
  upkeep of the hubs Dreaming grows — a batch not yet logged in
  `Agent Error Memory.md` (`f1d24ec0`), an abstract its batches outgrew
  (`c3d149b8`) — and all three were filed by Dreaming nights (00 §4). The
  housekeeping need appears at 03:04 in Dreaming's own files.
- **The job list is free.** The writer already reports one `NOTE` line per note
  it created or edited (`src/lib/dreamingRun.ts:200`), so upkeep would know
  exactly which files changed tonight without a planner.
- **One clock, one switch, one pane.** The operator already understands
  `dreamingEnabled`, the 03:04 fire and the `/dreaming` pane; the overlap guard
  already refuses while any `dreaming:` run is live
  (`src/lib/dreamingRun.ts:264`–`:275`), and an `originRef` under that prefix
  would inherit it.

## The case against, in this install

- **The ledger does not fit.** `dreaming_notes` is keyed on an error signature,
  and its key "is the deduplication mechanism" (`src/lib/db.ts:2446`–`:2451`).
  An upkeep edit has no signature: it needs a new table, and sharing the pane
  means upkeep rows next to retractable notes.
- **It corrupts retraction.** A recorded note that moves shows as deleted —
  what a person's retraction looks like (`src/lib/dreamingLedger.ts:236`–`:262`)
  — and the Dreaming investigation found that `note_path` already mostly names
  shared hubs rather than Dreaming's own notes, because `parseNoteLines` keeps
  only the last line per item (`src/lib/dreamingRun.ts:230`; "Found on the way"
  in the [README](README.md)). A second writer editing those same hubs makes
  "what did Dreaming write" harder to answer, not easier.
- **It couples what Dreaming's design keeps apart.** Upkeep would run only
  while `dreamingEnabled` is on, and Dreaming's rule is that a change "that
  makes the writer reachable without that flag … breaks the split the whole
  feature rests on" (`docs/agent/dreaming/halves-and-write-policy.md:15`–`:17`).
  Upkeep of anything Dreaming did not write — the Inbox captures, research
  runs' keyword slips, `11b1e89d`'s tag — would either be out of scope or turn
  the half into a general manager wearing Dreaming's name.
- **A cheaper fix exists for the part it is best at.** The writer already has
  the hub open when it adds a batch; telling it to update the log line and the
  abstract's count in the same edit costs one paragraph of prompt
  ([Option F](07-option-f-no-debt-at-source.md)).

## What it costs

About 1–2 days (**assumed**): a branch in `tickDreaming`, a table in `db.ts`, a
row type in the pane. Per night a Haiku session of $0.02–0.07 (08 §4).

## Verdict

**No.** Its one unique asset — tonight's list of changed notes — is what
Option F uses without a second writer, and everything else about it is Option C
inside Dreaming's ledger, where it does not fit.
