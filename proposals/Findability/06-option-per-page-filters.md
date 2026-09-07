# 06 — Option 3: per-page filters

**Verdict: REFUSED in its generic form. The specific case survives inside §10.**

## What it is

A shared `<SearchField>` in `src/components/ui/`, dropped onto each list page,
filtering the rows that page already has. Nineteen pages, one component, no
backend work.

## Why it is tempting

It is the cheapest thing to build. `src/components/ui/` already holds `Field`
(`Field.tsx`), so the component is small. And four pages have already built one
by hand — `runs/page.tsx:568`, `chat/page.tsx:1451`, `knowledge/page.tsx:570`,
`settings/page.tsx:2418` — so the generic-component argument writes itself:
extract what exists, apply it everywhere.

## The refusal is not this survey's opinion — it is already a stated invariant

`docs/agent/conventions.md:16`, on list routes, verbatim:

> **The narrowing happens in the query, never in the client over an
> already-capped page.**

and, on why `/api/runs` acquired its parameters at all:

> `/api/runs` read none at all and answered with the hundred newest runs, so the
> page's status segments filtered *those*, and "show me the failed runs" got the
> failed runs among the hundred newest: the same shape of answer as the question,
> and wrong, and indistinguishable from right.

Everything below is that rule applied to the fifteen pages that have no search
yet. The generic client-side filter component is the thing that rule forbids,
offered as a component.

## Refusal 1 — the ones that exist are not client-side filters over capped lists

This is the load-bearing objection. Three of the four existing inputs are
**server** searches, and each one's implementation says so:

- runs — `settledQuery` (`runs/page.tsx:569`) becomes `?q=` and the match runs in
  SQL at `orchestrator.ts:1044`.
- chat — `?q=` reaches `findChats` (`chat.ts:443`), which matches message *bodies*
  via `EXISTS` (`chat.ts:455-459`). No client could do that: the messages are not
  on the wire.
- knowledge — `?q=` reaches `searchKnowledge` (`knowledge.ts:1403`) over an index
  the client has never seen.

Quick open makes the point explicitly. `QuickOpen.tsx:241-246` explains why run
results are passed through *unfiltered* at `:249`: the server matched full task
text, while the wire copy is clipped by `clipPrompt`
(`src/app/api/runs/route.ts:49-53`), so re-filtering on the client would **drop
matches the server found**.

The fourth, the settings field search, *is* client-side — and it is the exception
that proves the rule rather than a counter-example. Its corpus is not a page of a
capped list: `findFields` (`settings/page.tsx:194-200`) states that "nine sections
are anchors on one long page, so all of them are in the DOM at once and a walk
over it is the whole corpus." It filters client-side because the client genuinely
holds everything. None of the fifteen pages without a search is in that position.

A generic client-side filter is therefore not an extraction of the pattern that
exists. It is the opposite of it, and it inherits a failure the codebase has
already written a comment against.

## Refusal 2 — a client filter over a capped list lies

`listRunsPage` defaults to 100 rows and caps at 200 (`orchestrator.ts:877`,
`:887`). `findChats` caps at 100 (`chat.ts:425`). `knowledgeBrowse` pages at 50,
max 200 (`knowledge.ts:1447,1450`). `listNotes` caps at 500
(`dreamingLedger.ts:43`). `branchInventory` examines at most
`MAX_INVENTORY = 60` branches per request (`land.ts:2334`).

A filter over the fetched page reports "3 matches" when the truth is "3 matches
in the first hundred". It is not a weaker search than the server one; it is a
**wrong** one, and it is wrong silently — the failure mode `CLAUDE.md` names as
this app's characteristic hazard, and the one `conventions.md:16` calls
"indistinguishable from right". F2's own text is about a cap; answering a cap
with a filter that only sees inside the cap answers nothing.

## Refusal 3 — it is a per-page remembering, and pages arrive fastest

Nineteen pages, one every 4–5 days (§03). The registry-drift measurement applies
directly: `panes.ts` forgot a page one day after remembering its sibling.
Fifteen pages currently have no search; all fifteen would have to be done, and
then every new one.

## What survives

Two things, and they are inside §10 rather than here:

1. **The branches page should get a search box** — because the corpus is 141 and
   because the route can serve it. That is one page acquiring one input backed by
   a route parameter, not a generic component applied to nineteen.
2. **`src/app/dreaming/page.tsx`** likewise, at ≤500 notes.

The distinction is not pedantic. "Add a filter to the branches page" and "add a
shared filter component to every list page" produce different code, and only the
first is correct at the cap.
