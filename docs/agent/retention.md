# Retention: what is evidence and what is permanent

> Extracted verbatim from `CLAUDE.md`, which grew past the size Claude Code will
> load into a session. Each paragraph records a correctness or safety decision
> whose violation is silent — nothing throws, nothing fails to typecheck.
> **Read before editing src/lib/retention.ts.**

This file is an index. Each line below is the lead claim of one paragraph, and the paragraph itself is in the topic file its heading links to.

## [One decision over three stores, and what every sweep promises](retention/design.md)

- Three stores, one retention decision, and the decision is what a run's row is for.
- Four properties are shared by all three sweeps and none of them is optional.
- Two consequences are written down rather than absorbed.

## [Which tables the event sweep reaches, and the column no sweep writes](retention/tables.md)

- `runs.provider` is permanent, and the clause that matters is that no sweep may ever write to it.
- Seven tables outlive the code that wrote them, and only one of them is still swept.
- A fourth table rides the event sweep, and which sweep it rides is the decision.
- The holdouts' evidence is copied out ahead of this sweep, into tables it never reaches, and a run it could not copy keeps its events.

## [Who may sweep, and the taskboard no sweep reaches](retention/sweeper-and-taskboard.md)

- Every tick re-asks who owns the data directory, and this is the only sweep in the app for which that is a deletion question.
- The taskboard rides no sweep at all, and the refusal is the decision rather than an omission.

## [No VACUUM, and the storage card's cache](retention/vacuum-and-storage-card.md)

- What the sweep deliberately does **not** do is `VACUUM`.
- The card's two store sizes are measured rather than counted, so they are cached — and which half of this module the cache sits on is a structural decision rather than a tuning one.

## [The transcript sweep and the checkout sweep](retention/transcript-and-checkout-sweeps.md)

- The transcript sweep is the one whose protection cannot come from a file's age, so it comes from the database: `expiredTranscripts` takes a horizon and a `keepSessions` set built from every …
- The checkout sweep is the one whose store is somebody else's directory, so what it may touch is narrower than the other two and is worth stating outright.
