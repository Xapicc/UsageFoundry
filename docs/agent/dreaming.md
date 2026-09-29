# Dreaming: what recurred, and what was written about it

> Each paragraph records a correctness or safety decision whose violation is
> silent — nothing throws, nothing fails to typecheck, and the page looks right.
> **Read before editing `src/lib/dreaming.ts`, `src/lib/dreamingLedger.ts`,
> `src/lib/dreamingRun.ts`, `src/app/dreaming/`, or `src/app/api/dreaming/`.**
> The reasoning behind the shape is `proposals/Dreaming/`, whose figures every
> constant here comes from.

This file is an index. Each line below is the lead claim of one paragraph, and the paragraph itself is in the topic file its heading links to.

## [Two halves, the corpus, signatures and the write policy](dreaming/halves-and-write-policy.md)

- Two halves, and only one of them can be wrong.
- Why the corpus is the error slice and not the day.
- The write policy is the feature, and its number is measured rather than chosen.
- A signature is a string, not a cause, and every surface has to say so.

## [The scan: days, its memo and deduplication](dreaming/the-scan.md)

- A day is the operator's day.
- The scan keeps its own cache and must never ride `scanUsage`'s.
- The scan memo holds each observation's instant, never its day.
- There is no eviction bound on the scan memo and that is deliberate.
- The scan deduplicates on the record, never on the signature, and the distinction is load-bearing.

## [The ledger: claiming, reconciling and retracting notes](dreaming/the-ledger.md)

- The ledger is the retraction mechanism, and that is why the feature can ship.
- Signatures are claimed before the run writes, not after it reports.
- `reconcileDreamingNotes` is keyed on the run and never on the night.
- `reconcileDreamingNotes` maps `NOTE n` on the stored `prompt_item`, never on a row's position among the run's rows that are left.
- `recordNight`'s `selected` is sticky.

## [The writer: a run, its spend limit and its prompt](dreaming/the-writer.md)

- The writer is a run, never an assist.
- `dreamingMaxCostUSD` has no way to express "no ceiling".
- Everything the licence rests on lives in `buildDreamingPrompt`, which is why it is pure and tested.

## [The nightly clock](dreaming/the-clock.md)

- The clock copies three of `schedules.ts`' rules and each was learned expensively.
- The cursor is an instant and never a day, and this is the fault that would have stopped the feature dead.
- Enabling the setting arms the clock, because `startDreaming` at boot alone was a switch with no timer behind it.
- A night refuses while the previous one is still running.

## [The pane, its row in the sidebar, and `list_recurring_failures`](dreaming/the-pane.md)

- The pane must keep three kinds of nothing apart.
- The pane does not poll.
- Both lists on the pane say when they are cut.
- The orchestrator reads both halves through `list_recurring_failures`, and the rules above follow it there.
- The pane is the ninth row, directly under Knowledge, and `Pane.shortcut` is optional because of where that leaves the digits.

## [Steering agents to consult the vault](dreaming/vault-skill-steering.md)

- Steering an agent to consult the vault is cheaper than letting it investigate, and the steering belongs in the skill rather than in every prompt.
