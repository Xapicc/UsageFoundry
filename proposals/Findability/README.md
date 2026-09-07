# Findability

**The question.** What should an operator be able to find in this app, and by
what mechanism, across chats, branches, agents, templates and schedules?

**The current state, measured.** 68 API routes. Five of them read a `q=`:
`runs`, `chat`, and the three `knowledge` routes. Four text inputs exist in the
whole UI — `src/app/runs/page.tsx:568`, `src/app/chat/page.tsx:1451`,
`src/app/knowledge/page.tsx:570` and the settings field search
(`src/app/settings/page.tsx:2418`), whose corpus is walked out of the rendered
DOM rather than declared. Quick open has exactly three corpus sources —
panes, runs, workflows — built as three hardcoded blocks at
`src/components/shell/QuickOpen.tsx:203-252`. No route and no lib function
searches more than one kind at once.

**The recommendation.** *Findability is a property of a route, not of a page and
not of an index.* Three things, ranked:

1. **Give `q=` to the two routes whose corpus is measured large and lacks it** —
   `/api/branches` (141 branches in one repository on this machine, 143 fifteen
   minutes later) and `/api/dreaming`. Use the predicate `src/lib/orchestrator.ts:1044-1049` already
   runs, which was measured at 4.1 ms over 50,000 rows with no index of its own
   (`src/lib/orchestrator.ts:1018-1026`). No new table, no new dependency, no new
   mechanism.
2. **Derive the destination corpus instead of hand-registering it.** `PANES`
   (`src/components/shell/panes.ts:42-71`) is ten hand-written rows and it has
   already drifted: `/runs/[id]/conflicts` is in neither `PANES` nor
   `toolbarTitle`, so its toolbar reads "Run" — the exact failure the comment
   five lines above it was written to prevent. The app has already made this
   choice once, for the settings field search, and written down why
   (`src/app/settings/page.tsx:194-200`).
3. **Decide out loud that agents, templates and schedules are not search
   targets**, because they are not corpora. A schedule is a `UNIQUE` column on a
   workflow (`src/lib/db.ts:520`). `listAgents`, `listTemplates` and
   `listWorkflows` already return every row with no `LIMIT`
   (`agents.ts:821`, `templates.ts:375`, `workflows.ts:1490`). What these kinds
   need is a complete list, and they already have one.

**What is refused, by name.** A cross-kind index (§05), a query language (§07),
and a generic client-side per-page filter component (§06). Widening quick open's
corpus (§04) is refused *as a shape* and accepted only as a consumer of what §1
builds.

**F2 is superseded, not closed.** See §10.

**Falsifier.** §10 states it and names the command.

## Files

| | |
|---|---|
| `01-what-the-app-holds.md` | Every object kind, where it lives, and which are corpora at all |
| `02-what-can-be-found-today.md` | The five `q=` routes, the four text inputs, quick open's three sources |
| `03-the-rate-things-arrive.md` | 19 pages, 68 routes, 36 tables in 27 days — and the registry that already drifted |
| `04-option-widen-quick-open.md` | Option 1 |
| `05-option-one-index.md` | Option 2 — **refused** |
| `06-option-per-page-filters.md` | Option 3 — **refused in its generic form** |
| `07-option-a-query-language.md` | Option 4 — **refused** |
| `08-option-derive-the-corpus.md` | Option 5 |
| `09-option-refuse-to-search.md` | Option 6 |
| `10-recommendation.md` | The ranked answer, its cost, the F2 disposition, the falsifier |
| `11-defects-found.md` | Three defects found while measuring. Recorded, not fixed. |

## Standing of the evidence

Every number here came from a command run in this container against this tree at
`594ac64`, or from a `file.ts:line` read directly. Two things could **not** be
measured and are marked as such wherever they appear: this container holds no
populated install database (§01), and Docker is unavailable, so nothing was
observed in a running app. Baseline at the time of writing: `npm run typecheck`
clean, `npm test` 2289 passing, 0 failing.
