# 05 — Option 2: one index and one search route

**Verdict: REFUSED.**

## What it is

An FTS5 virtual table fed by every writer, and a single `/api/search?q=` that
returns hits across every kind, ranked. The operator who remembers a phrase but
not whether it was a run, a chat or a note types it once.

This is the most attractive option on paper. It is also the one this survey most
wants to refuse clearly, because "add search" almost always means "add an index"
and here it should not.

## The capability is there

§02 measures it: `better-sqlite3` in this tree ships SQLite 3.53.2 with
`ENABLE_FTS5`, and a virtual table creates and matches in this container. **No
new dependency is required.** The refusal is not about capability.

## Refusal 1 — the scan it would replace is already fast enough, measured

`src/lib/orchestrator.ts:1018-1026`, in the tree, not estimated by this survey:

> It also needs no index of its own, which was measured rather than assumed:
> against 50,000 rows in groups of 25 sharing a millisecond, the plan is `SCAN
> runs USING INDEX idx_runs_created` […] The two slower shapes are 7.8ms for a
> status page at offset 20,000 and **4.1ms for a `LIKE` over `prompt`**, and
> neither is on the four-second poll.

`MAX_RUN_QUERY`'s own comment (`:891-894`) concedes that `LIKE '%…%'` cannot use
an index whatever the needle is — and the measurement says it does not need to.
**4.1 ms over 50,000 rows.** An install would have to grow two orders of
magnitude before an index bought a user-perceptible millisecond, and the largest
corpus this survey measured anywhere is 1,415 vault notes and 141 branches.

An index that makes a 4.1 ms query faster, at the price of a second copy of every
searchable string on disk, is not an optimisation. It is a liability with a
benchmark attached.

## Refusal 2 — it needs feeding, and this codebase forgets

36 tables, +1 every 1.5 days (§03). Every writer to a searchable table must
remember to write the index too. §03 measures what this repository's actual
failure rate is on exactly that obligation, in a file whose comments beg the
reader not to fail: one in two, one day apart.

SQLite triggers would co-locate the registration with the `CREATE TABLE` in
`migrate()`, which is a real mitigation and the strongest form of this option.
It still fails on the next point.

## Refusal 3 — "index every text column" is a decision nobody can safely make

A cross-kind index has to decide, per table, which columns are content. The two
ways to decide are both wrong here:

- **Derive it from the schema** (index every `TEXT` column). That indexes
  `run_events.payload` (`src/lib/db.ts:167`) — raw agent stdout, every line an
  agent printed, for every run. `docs/agent/security.md` records that
  `UF_GITHUB_TOKEN` reaches some children. Putting agent stdout into a global
  search box is not a findability feature.
- **Register it per table.** Then the index is a denylist-shaped registration:
  forgetting to *exclude* a new telemetry table leaks its contents into search,
  while forgetting to *include* a content table merely fails to find. Those two
  failure modes are not symmetric, and the manual list that fails safe is the one
  this option cannot use.

## Refusal 4 — retention becomes a second correctness surface

`docs/agent/retention.md` governs what expires and on what horizon. An index is a
second copy of expiring content, on its own lifecycle. Every rule in that
document acquires a shadow. A retained index row for a swept run is a search hit
that navigates to a 404 — a class of bug this app does not currently have.

## Refusal 5 — the codebase has already argued this, in prose

`src/lib/knowledge.ts:1393-1401`:

> Deliberately not a ranked retrieval engine: this vault ships its own BM25
> search, and a second, worse one built here would be the thing an operator
> reaches for and the thing that answers badly. What this is for is finding the
> note you already know the name of, so the ranking is only "where did it match"
> and it says so on the wire.

That is the house position on exactly this trade, written against the app's
largest text corpus (1,415 notes), and it chose a tier ladder of five integers
(`:1416-1433`) over a retrieval engine. A cross-kind FTS5 index would be the
second, worse retrieval engine that sentence refuses — and unlike the vault, the
runs and chat corpora have **no** external BM25 search to defer to, so it would
have no better one to point at either.

## What would make this option win

An install where `LIKE` over `prompt` crosses the four-second poll budget, or an
observed operator need to search across kinds at once. §10 states the falsifier
and the command.
