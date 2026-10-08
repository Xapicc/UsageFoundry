# Option C — a separate in-app feature with its own clock, ledger and pane

## What it is in this app

A `knowledgeManager.ts` beside `dreamingRun.ts`: its own `globalThis` timer and
cursor in the pattern of Dreaming's clock (`src/lib/dreamingRun.ts:84`–`:87`,
`src/lib/dreamingRun.ts:508`–`:513`), its own switch (off by default), its own
tables — `km_passes` and `km_changes` with path, before and after hash, and a
pre-image — and a pane, most naturally a card under `/dreaming` or `/knowledge`.
Before each Haiku run it starts, the **app** hashes every note; afterwards it
hashes them again and records the difference as the pass's changeset.

## Its strongest case

- **The only model-independent changeset.** The app reads the vault before and
  after the run, outside the session, so the record does not depend on Haiku
  calling anything, and it catches edits made through Bash that the touch scan
  cannot see (C2). Reading is allowed: `knowledge.ts` already walks the vault
  with an mtime/size cache (`src/lib/knowledge.ts:1163`–`:1208`), and a full
  `.md` pre-image measured here is 0.5 s and 6.66 MB compressed (`tar czf` of
  the 1,717 `.md` files from `/workspace2`).
- **Its own switch keeps Dreaming's sentences true** for Dreaming — and adds a
  second, separately named authority to write unattended, instead of widening
  the first.
- **Somewhere to look.** A pane listing each pass's changes with a pre-image
  is the undo the vault has never had.

## The case against, in this install

- **Restore is a write path the app has refused.** Showing a changeset is a
  read; putting a pre-image back is the app writing the vault, which
  `knowledge.ts` rules out (`src/lib/knowledge.ts:40`–`:45`) and
  KnowledgeSection's C1 refused as a Fix button (C10). Either the refusal is
  reversed for an operator-pressed, hash-guarded restore, or restore is itself
  a run — and a run could have restored from a vault-side pre-image anyway.
- **The planner cannot live in the app.** The definition of "wrong" is the
  vault's qc.py, and the app may neither run it (it is run-writable code,
  C10) nor re-implement it (that would be "this app inventing a rule for
  somebody else's vault", `src/lib/knowledge.ts:1662`–`:1665`). So C still
  needs a model run to plan, which is A's weakness again.
- **A whole feature for a few jobs a week.** The measured Haiku-class inflow is
  six qc findings, four captures and three board tasks over seven weeks
  (00 §3–§4). A clock, two tables, a pane and their tests is about 4–6 days
  (**assumed**, by comparison with Dreaming's size).
- **It wraps the wrong writer.** The changeset is most valuable around the
  writer that writes most: Dreaming wrote every note changed in the vault in
  the last day (C12). Building it for a new, smaller writer first is backwards.

## What it costs

About 4–6 days (**assumed**), plus the same per-pass model cost as A
(08 §4).

## Verdict

**Not now.** Its one unique piece — an app-computed changeset of every
vault-writing run — is worth building on its own, around Dreaming first, and is
listed in [`09-recommendation.md`](09-recommendation.md) as what would make it
worth reopening.
