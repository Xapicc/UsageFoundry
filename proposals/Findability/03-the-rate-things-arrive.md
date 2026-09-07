# 03 — The rate things arrive, and the registry that already drifted

This is the file that decides the ranking. The brief says the deciding criterion
is what each mechanism costs *to keep correct as pages keep arriving*. So: how
fast do they arrive, and does this codebase, in practice, remember to register
things?

## The rate

```
$ git rev-list --count HEAD          →  1107
$ git log --oneline | tail -1        →  24a886d   (2026-08-10)
$ git log -1 --format=%ad --date=short  →  2026-09-06
```

**1,107 commits in 27 days**, ≈41 a day. At each of eleven sampled commits,
`git ls-tree -r --name-only <sha> | grep -c '^src/app/.*page\.tsx$'` and the same
for `route.ts`, and `git show <sha>:src/lib/db.ts | grep -c 'CREATE TABLE'`:

| date | sha | pages | routes | tables |
|---|---|---|---|---|
| 2026-08-10 | 24a886d | 6 | 9 | 3 |
| 2026-08-11 | 95d8567 | 9 | 25 | — |
| 2026-08-13 | ad07c77 | 14 | 33 | 17 |
| 2026-08-14 | 7e358ad | 14 | 36 | — |
| 2026-08-16 | 6655355 | 15 | 44 | 23 |
| 2026-08-19 | b094292 | 15 | 49 | — |
| 2026-08-22 | 27a0631 | 16 | 56 | 23 |
| 2026-08-25 | 4399232 | 16 | 56 | — |
| 2026-08-28 | 925b4eb | 17 | 58 | 31 |
| 2026-09-03 | 700e277 | 19 | 62 | — |
| 2026-09-06 | 594ac64 | **19** | **68** | **36** |

Pages ×3.2, routes ×7.6, tables ×12, in 27 days. Eight of the thirteen new pages
landed in the first four days; the steady-state rate since is **about one new
page every four to five days**, ~2 routes a day, and ~1 table every 1.5 days.

Recent page arrivals (`git log --diff-filter=A -- <path>`):

| sha | date | page |
|---|---|---|
| 5bf2502 | 2026-09-02 | `src/app/dreaming/page.tsx` |
| 834f383 | 2026-08-28 | `src/app/runs/[id]/conflicts/page.tsx` |
| cdba0d3 | 2026-08-27 | `src/app/runs/[id]/touched/page.tsx` |
| 079bc7b | 2026-08-21 | `src/app/knowledge/page.tsx` |
| d4e4cf5 | 2026-08-14 | `src/app/agents/page.tsx` |

## The registry, and its drift

The app has exactly one hand-maintained list of destinations: `PANES` at
`src/components/shell/panes.ts:42-71`, ten entries, three readers
(`grep -rln 'PANES' src/ | grep -v panes.ts` → `AppShell.tsx`, `QuickOpen.tsx`,
`Sidebar.tsx` — sidebar rows, ⌘1…⌘9, and quick open's corpus).

The file knows why it is dangerous. Its own header says a pane added in one
reader and missed in the others "is a pane you can reach and cannot get back
from". The entries carry ninety words of comment about *shortcut renumbering*
alone (`:52-70`), and the last one closes with

> What may never be done is the compromise […] which is the failure the position
> rule at the top of this file exists to prevent.

Twenty-six lines further down is a **second** hand-maintained list:

```
$ sed -n '98,110p' src/components/shell/panes.ts
export function toolbarTitle(pathname: string): string {
  if (pathname === "/runs/new") return "New run";
  // Before the line under it, which would otherwise title a sub-route with the
  // name of the page it hangs off — and a toolbar saying "Run" over a screen
  // that is not the run page is the one breadcrumb an operator has.
  if (pathname.endsWith("/touched") && pathname.startsWith("/runs/")) {
    return "What it touched";
  }
  if (pathname.startsWith("/runs/")) return "Run";
```

```
$ grep -rn 'conflicts' src/components/shell/
(no matches)
```

`/runs/[id]/touched` arrived 2026-08-27 and was registered.
`/runs/[id]/conflicts` arrived 2026-08-28 — **the next day** — and was not. It
falls through to `startsWith("/runs/")`, so the toolbar over the conflicts screen
reads "Run", which is verbatim the failure the comment five lines above it
describes. It is also absent from `PANES`, so it is unreachable from quick open.

**The comment warning about the hazard and the code exhibiting the hazard are
eight lines apart, in the same function, added one day apart.**

## What that means for the options

This is not an argument that the authors were careless. It is a measurement of
what a manual registration step costs at this repository's actual rate, under the
most favourable possible conditions: one file, three readers, a prominent
comment, and a rule stated twice. The observed failure rate on the most recent
pair of sibling pages is **one in two**.

Any mechanism whose correctness requires a human to remember a step when a page,
route or table is added should be priced at that rate. Concretely:

- **Widening quick open's corpus (§04)** adds a fourth, fifth and sixth source to
  a component with no source registry — six edit sites each (see §04). Each new
  kind is a new remembering.
- **A global index (§05)** requires every writer to feed it. 36 tables, +1 per
  1.5 days.
- **Per-page filters (§06)** require every new list page to build one. 19 pages,
  +1 per 4–5 days, and three built so far in 27 days.
- **A query language (§07)** requires every new filterable field to be added to a
  grammar *and* to the help text that documents it.
- **Deriving the corpus (§08)** requires nothing, by construction.
- **Route-level `q=` (§10, item 1)** requires nothing per *page*: a page that
  lists something already calls a route, and the route is where the predicate
  goes. It is a remembering per new **corpus**, of which §01 finds two.

That last distinction is the whole ranking. Pages arrive every 4–5 days. New
corpora — kinds with independent identity, text and volume — arrive far more
rarely: in 27 days the app grew from `runs` to `runs`, `chats`, knowledge notes,
branches and dreaming notes. Five in four weeks, against nineteen pages and
sixty-eight routes.
