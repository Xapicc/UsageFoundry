# 10 — Recommendation

## In one paragraph

Findability in this app is a property of a **route**, not of a page and not of an
index. Three things, in order: give `q=` to the two routes whose corpus is
measured large and which lack it — `/api/branches` and `/api/dreaming` — reusing
the `LIKE` predicate `src/lib/orchestrator.ts:1044-1049` already runs and which
was measured at 4.1 ms over 50,000 rows with no index (`orchestrator.ts:1018-1026`);
derive the destination list from the route tree so a page cannot arrive unfindable
the way `/runs/[id]/conflicts` did; and decide out loud that agents, templates and
schedules are not search targets, because a schedule is a `UNIQUE` column on a
workflow (`db.ts:520`) and the agent and template lists already return every row
with no `LIMIT`. Nothing new is stored, nothing new is depended on, and no new
page has to remember anything.

## The ranking

### 1. `q=` on `/api/branches`, then `/api/dreaming`

**Catches:** the largest corpus this survey measured anywhere in the app. 141
branches in one repository, 121 of them named `uf/<repo>-<hash>-<n>-<hash>`,
served 60 at a time (`MAX_INVENTORY = 60`, `src/lib/land.ts:2334`) with no way to
narrow — and 143 by the time this file was finished, fifteen minutes later (§01). An operator looking for the branch that did a particular piece of work has
to page three times through indistinguishable hashes.

**Why it is nearly free.** §01 shows a branch is not an object: `branchBearingRuns()`
(`land.ts:2645-2657`) is `SELECT … FROM runs WHERE isolation='worktree' AND
worktree_branch IS NOT NULL`. The filter belongs in `selectBranchCandidates`
(`land.ts:2595-2598`) — a **pure, exported function** that already takes
`BranchQuery` and already has a test block at `src/lib/land.test.ts:721` with ten
assertions over its paging and repo filter. `BranchQuery` (`land.ts:2556-2563`)
gains one optional field; `src/app/api/branches/route.ts:26-42` reads one more
parameter; `src/app/branches/page.tsx` gains one input.

**The design conclusion the measurement forces:** the predicate must match
`runs.prompt`, not the branch name. 121 of 141 names are machine hashes (§01), so
a name-only match finds nothing a person would type. This is the finding that
would have been missed by any approach that treated branches as a new corpus.

`/api/dreaming` is the same shape at smaller stakes: notes are capped at
`NOTE_LIMIT = 500` (`src/lib/dreamingLedger.ts:43`), the route takes no parameters
at all, and the pane arrived 2026-09-02 with no way to search what it accumulates.

**Cost to keep correct:** one remembering per new *corpus*. §03 counts five
corpora in 27 days against nineteen pages and sixty-eight routes.

### 2. Derive the destination list

**Catches:** the class of bug that has already happened once and will happen
again at one new page every 4–5 days. `/runs/[id]/conflicts` is in neither `PANES`
(`src/components/shell/panes.ts:42-71`) nor `toolbarTitle` (`:98-110`), added one
day after its sibling `/touched` was correctly registered in both, in a function
whose comment five lines above describes exactly the resulting failure.

**Precedent:** the app already derives one corpus rather than declaring it — the
settings field search walks the rendered page for `[data-setting-name]`
(`src/app/settings/page.tsx:194-222`), and `docs/agent/conventions.md:16` records
why: a declared index "would duplicate sixty labels and their help text with
nothing keeping the two in step, and a search naming a field the page no longer
has is worse than no search". `PANES` is the same hazard on the smaller and more
consequential list, and it has already failed where settings has not.

**Shape:** derive the *set* of routes at build time; keep label, icon and shortcut
digit hand-written, because `panes.ts:52-70` spends ninety words on decisions no
derivation can make. A page present in the tree but absent from the metadata
should be findable under its path rather than invisible — today those are one
list, and that is what made one omission an unreachable page.

**Cost to keep correct:** zero. That is the entire argument for ranking it above
anything that widens a hand-written list.

**Honest constraint:** Next.js's route manifest is not a stable runtime API, so
this is a build-time glob, not a runtime read. It is still generated.

### 3. Write down the refusal

**Catches:** the next four weeks of work. §09 states the test — a kind deserves
search when its size is set by the machine rather than by the operator — and shows
`listAgents` (`agents.ts:821`), `listTemplates` (`templates.ts:375`) and
`listWorkflows` (`workflows.ts:1490`) already return every row, ordered for
scanning. The goal is met; the mechanism is not needed. Cost: a paragraph in
`docs/agent/`, and no code.

## What is refused, by name

| | Why, in one line |
|---|---|
| **A cross-kind FTS5 index** (§05) | The scan it would replace is 4.1 ms over 50,000 rows, measured in the tree at `orchestrator.ts:1024`; it needs feeding by 36 tables growing at one per 1.5 days; and "index every `TEXT` column" indexes `run_events.payload`, which is raw agent stdout. |
| **A query language** (§07) | Outside `limit`/`offset`/`q` the whole API accepts fourteen filter parameters, most appearing once on one route. A grammar over that has two working keywords, four maintenance sites per field, and a mistyped key that must be an error rather than zero results. |
| **A generic client-side per-page filter component** (§06) | `docs/agent/conventions.md:16` already states the rule: "The narrowing happens in the query, never in the client over an already-capped page." Three of the four text inputs that exist are *server* searches, and `QuickOpen.tsx:241-246` documents why client re-filtering drops matches. Over a capped list — 100 runs, 100 chats, 500 notes, 60 branches — a client filter reports "3 matches" when the truth is "3 in the first page". Silently wrong, and already forbidden. |
| **Corpus-widening as *the* answer** (§04) | Refused as a shape, not as an act. Six edit sites per source in a component with no registry and two divergent return paths; and agents, templates and schedules have no page for a jump-to surface to jump to. Quick open consuming item 1's `q=` is welcome and is not this. |
| **A schema-derived content index** (§08) | Safe for routes, unsafe for columns: a column carries no signal about whether its contents are for the operator, and the per-table decision that fixes it is the registration the derivation existed to avoid — failing in the leaking direction. |

## What this does *not* do, stated plainly

It does not make one box that finds everything. After all three items, an operator
who remembers a phrase and not its kind still tries the runs box, then the chat
box, then knowledge, then settings — four inputs, four mechanisms, no two alike. §05 refuses the thing that would fix that, on cost. If that
trade is wrong, the falsifier below is how it shows.

## F2: superseded, not closed

`proposals/GapRegister/01-frontend.md:125`.

**Superseded.** F2 prescribes widening quick open's corpus to reach "a chat, a
branch, an agent, a template and a schedule". Measured (§01), that framing does
not survive:

- **chat** is already findable — `findChats` (`chat.ts:443`) matches title and
  message body, closed by `7d7e3f3`;
- **branch** is a projection of `runs` (`land.ts:2645`), so it is one predicate on
  a query type that exists, not a corpus;
- **schedule** is a `UNIQUE` column on a workflow (`db.ts:520`) with no list
  function and no text of its own;
- **agent** and **template** are refused as search targets (§09), and their lists
  are already complete.

One of five named kinds keeps F2's prescription, and it is not the kind F2's
mechanism would serve.

**What survives from F2 and is ranked first and second here:** its observation
that quick open's corpus is three hardcoded sources, and that three pages have
arrived since with nothing indexing them. Both are true. `/dreaming` becomes item
1's second target; `/runs/[id]/conflicts` is item 2's worked example and is worse
than F2 recorded — it is not merely unindexed, it is missing from `PANES` and
mistitled in the toolbar (§11, D1).

F2 should be marked **superseded by `proposals/Findability/`** rather than closed,
because closing it implies its remedy was applied and it was not. This survey does
not edit the register; that disposition is for the reconciliation pass.

## Falsifier

Run this against a live install's database — Docker is unavailable in this
container and `DATA_DIR` is sandbox-denied, so it was **not** run here:

```bash
sqlite3 "$DATA_DIR/usagefoundry.db" "
  SELECT 'agents',    count(*) FROM agents
  UNION ALL SELECT 'templates', count(*) FROM run_templates
  UNION ALL SELECT 'workflows', count(*) FROM workflows
  UNION ALL SELECT 'runs',      count(*) FROM runs;"
```

**The recommendation is overturned if either holds:**

1. **`agents` or `run_templates` exceeds roughly 200 rows.** The premise of item 3
   and of §09's refusal is that these are sets an operator typed by hand and can
   scroll. At 200+ they are machine-scale, the test in §09 reclassifies them, and
   they need `q=` like everything in Tier A. This is the likelier of the two and
   the one to check first.

2. **`runs` exceeds roughly 500,000 *and* the `q=` shape crosses ~250 ms.** Time it
   directly, since `LIKE '%…%'` cannot use an index (`orchestrator.ts:891-894`):

   ```bash
   sqlite3 "$DATA_DIR/usagefoundry.db" \
     ".timer on" "SELECT count(*) FROM runs WHERE prompt LIKE '%cache%';"
   ```

   The whole case against an index (§05, Refusal 1) rests on the 4.1 ms figure at
   50,000 rows recorded at `orchestrator.ts:1024`. If a real install has grown an
   order of magnitude past what was measured and the scan is now visible on the
   four-second poll, §05's refusal is wrong and one index wins.

A third observation would weaken rather than overturn it: an operator seen
searching the same phrase in two or three different boxes in a row. That is the
need §05 refuses to serve, and it is not measurable from a database.
