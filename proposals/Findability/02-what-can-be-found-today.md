# 02 — What can be found today

## Five routes out of sixty-eight take a `q`

```
$ find src/app/api -name route.ts | wc -l
68
$ grep -rl 'searchParams' src/app/api --include=route.ts | wc -l
12
$ grep -rl 'get("q")' src/app/api --include=route.ts
src/app/api/chat/route.ts
src/app/api/knowledge/graph/route.ts
src/app/api/knowledge/search/route.ts
src/app/api/knowledge/notes/route.ts
src/app/api/runs/route.ts
```

**56 of 68 routes read no query input at all.** They answer one fixed question.
Every parameter the whole API accepts, counted:

```
$ grep -rhon 'params\.get("[a-zA-Z_]*")' src/app/api/ | sed 's/.*get("//;s/")//' | sort | uniq -c | sort -rn
      6 limit      4 offset      5 q         2 tag
      1 tz         1 type        1 status    1 sort
      1 signature  1 settledBefore          1 repo
      1 path       1 kinds       1 history   1 folder
      1 days       1 after
```

Three of the five `q` routes are the knowledge subtree. Outside it, the app has
**two** text-searchable routes: runs and chat.

The routes an operator would reach for and which take no `q`:

| Route | Params it does take | Corpus |
|---|---|---|
| `src/app/api/branches/route.ts:26-42` | `repo`, `offset`, `limit` | 141 measured (§01) |
| `src/app/api/dreaming/route.ts` | none | ≤ 500 (`dreamingLedger.ts:43`) |
| `src/app/api/agents/route.ts` | none | uncapped list |
| `src/app/api/templates/route.ts` | none | uncapped list |
| `src/app/api/workflows/route.ts` | none | uncapped list |
| `src/app/api/folders/route.ts` | none | capped at 25 — B5 |

## Four text inputs exist in the whole UI

```
$ grep -rn 'placeholder="' src/app/**/page.tsx src/components/ | grep -Ei 'ilter|earch|Find'
src/app/chat/page.tsx:1451:  placeholder="Search every thread"
```

That grep finds one because the other three label their input rather than using
a hint placeholder. Reading the state instead:

- `src/app/runs/page.tsx:568-569` — `query` / `settledQuery`
- `src/app/chat/page.tsx:1451` — "Search every thread"
- `src/app/knowledge/page.tsx:128,135,570` — `query` / `settledQuery`,
  placeholder `"Title, alias or path"`
- `src/app/settings/page.tsx:2093,2418` — `fieldQuery`, the settings field search

Fifteen of the nineteen pages have no text search of any kind. There is **no
shared search or filter component**: `ls src/components/ui/` gives `Badge`,
`Button`, `Card`, `Disclosure`, `Field`, `Hint`, `Icon` — and no `Search`,
`Filter` or `SearchField`. Each of the four inputs was built where it stands, and
no two of them share a mechanism.

### The fourth one is not like the other three

`findFields` (`src/app/settings/page.tsx:201-222`) searches settings by walking
the rendered page for `[data-setting-name]` marks — the mark the field primitive
emits at `:730` — and matching against the name plus the two-levels-up block that
holds its help text (`:213-216`). Its docstring, `:194-200`:

> Every field whose name or help text contains `query`, in page order.
> **Reads the rendered page rather than a declared index**, for the reason
> `SettingName` records. Nine sections are anchors on one long page, so all of
> them are in the DOM at once and a walk over it is the whole corpus.

`MAX_FIELD_HITS = 8` (`:190`), and the count of what was dropped is stated beside
the results because "a capped list that does not say it is capped reads as the
whole answer" (`:186-189`).

This is the app's only **derived** corpus, and §08 returns to it: the reason for
the derivation is written out at `docs/agent/conventions.md:16` and it is the
same argument this survey makes from a different direction.

## Quick open reaches three kinds

Corpus construction, `src/components/shell/QuickOpen.tsx:203-252`:

```ts
const paneItems = PANES.map((pane) => ({          // :204
  key: `pane:${pane.href}`, group: "Panes", label: pane.label,
  href: pane.href, haystack: pane.label.toLowerCase(),   // :213
}));
const runItems = (needle ? matches : runs.slice(0, RECENT_RUNS)).map((run) => ({ // :221
  href: `/runs/${run.id}`, ...
}));
const workflowItems = workflows.map((workflow) => ({   // :229
  href: `/workflows/${workflow.id}`,
  haystack: workflow.name.toLowerCase(),   // :235
}));
```

Three sources, three different mechanisms:

| Source | Fetched | Filtered |
|---|---|---|
| Panes | not fetched — static `PANES` import at `:16` | client, `:248` |
| Runs | `GET /api/runs` on open `:118`, then `GET /api/runs?q=` per settled query `:157-159` | **server**; passed through unfiltered at `:249` |
| Workflows | `GET /api/workflows` on open `:119` | client on `name` only, `:250` |

`SEARCH_SETTLE_MS = 250` (`:22`, "A keystroke is not a request").
`RECENT_RUNS = 6` (`:19`). `searchError` is held apart from `loadError`
deliberately (`:104-107`). Runs are not re-filtered on the client because the
server matched full task text while the wire copy is clipped to
`MAX_LIST_PROMPT` — `:241-246` states the reason.

**Not reachable through quick open:** chat threads, agents, templates, branches,
knowledge notes, dreaming notes, plugins, folders, schedules, workflow instances,
settings, touched files, conflicts, reviews. And `/runs/[id]/conflicts`, because
it is not in `PANES` (§03).

## How the two searches that exist actually match

Runs — `src/lib/orchestrator.ts:1044-1049`:

```sql
(prompt LIKE ? ESCAPE '\' OR folder LIKE ? ESCAPE '\' OR id LIKE ? ESCAPE '\')
```

Bound parameters, never interpolated. `likeNeedle` (`orchestrator.ts:946-948`)
wraps in `%…%` and escapes `\`, `%`, `_`. `MAX_RUN_QUERY = 200`
(`orchestrator.ts:895`).

Knowledge — `searchKnowledge` (`src/lib/knowledge.ts:1403-1440`) iterates
`index.notes.values()` in memory. Its scoring is a first-match-wins tier ladder
at `:1416-1433`: exact title 100, title substring 70, alias 50, tag 30, path 10,
otherwise dropped. The index (`knowledge.ts:1169-1201`) is built at request time,
cached on `globalThis.__ufKnowledgeIndex`, and invalidated by a stat-only walk —
measured at 759 `stat` calls and zero `readFile`s on an unchanged vault
(`:1161-1163`). **Nothing is persisted.**

## There is no index anywhere in this codebase

```
$ grep -rain -E "fts5|fts4|virtual +table|using +fts|bm25" \
    --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next .
```

Two hits, both prose, both the same sentence — `src/lib/knowledge.ts:1397` and
its compiled copy:

> Deliberately not a ranked retrieval engine: this vault ships its own BM25
> search, and a second, worse one built here would be the thing an operator
> reaches for and the thing that answers badly.

Zero hits for `fts5`, `fts4`, `VIRTUAL TABLE`, `USING fts`. No SQL `MATCH`
operator anywhere in `src/`.

FTS5 is nonetheless *available* — this is worth knowing before §05 refuses it, so
the refusal rests on cost rather than on a missing capability:

```
$ node -e "const D=require('better-sqlite3'); const db=new D(':memory:');
  db.exec(\"CREATE VIRTUAL TABLE t USING fts5(body)\"); ..."
FTS5: OK -> [{"body":"hello findable world"}]
sqlite version 3.53.2
compile opts: ENABLE_FTS3,ENABLE_FTS3_PARENTHESIS,ENABLE_FTS4,ENABLE_FTS5
```

## The asymmetry worth naming

`src/app/api/mcp/route.ts` exposes 15 tools, six of them `list_*`: `list_folders`
(`:153`), `list_templates` (`:161`), `list_runs` (`:169`), `list_workflows`
(`:230`), `list_agents` (`:239`), `list_proposals` (`:258`).

**A model connected over MCP can enumerate agents and templates. The operator
sitting in front of the app cannot search them.** The app already names these
kinds machine-readably and in prose; what it has never done is offer the same
enumeration to the person. That is an argument about product, not mechanism, and
it is why §09's refusal has to be argued rather than assumed.
