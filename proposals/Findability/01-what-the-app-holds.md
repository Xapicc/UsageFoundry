# 01 — What the app holds, and which of it is a corpus

F2 names five kinds as unfindable: "a chat, a branch, an agent, a template and a
schedule". Measured against the tree, **three of those five are not corpora at
all**, and one of them is already findable. That is the finding this survey turns
on, so it comes first.

## The five, one at a time

### Chat — findable since `7d7e3f3`

G2 (`proposals/GapRegister/03-growth.md:103`) recorded chat threads past the
newest 30 as unreachable. That snapshot predates the fix. `findChats`
(`src/lib/chat.ts:443-447`) now takes `{q, limit, offset}` and matches

```sql
COALESCE(s.title,'') LIKE ? ESCAPE '\'
  OR EXISTS (SELECT 1 FROM chat_messages m
              WHERE m.chat_id = s.id AND m.text LIKE ? ESCAPE '\')
```

(`src/lib/chat.ts:455-459`) — title *or* any message body, `EXISTS` rather than a
join so a thread with forty hits returns one row (`chat.ts:440-441`).
`src/app/api/chat/route.ts:24` branches on `q`/`offset`/`limit`; `CHAT_PAGE_MAX`
is 100 (`chat.ts:425`). `listChats(limit = 30)` survives unchanged at
`chat.ts:418` because it is the sidebar's poll list, and its docstring
(`:430-435`) says the cap "is not a bug and stays".

`03-growth.md` and `05-register.md:56` disagree about G2's state. That is the
snapshot-versus-register split the register's own reconciliation pass owns; it is
not a finding of this survey and nothing here edits either file.

### Branch — a projection of `runs`, not an object

```
$ sed -n '2645,2657p' src/lib/land.ts
function branchBearingRuns(): Array<BranchCandidate & { createdAt: number }> {
  return db().prepare(
      `SELECT id, status, iterations, repo_root AS repoRoot,
              worktree_branch AS branch, continues_run AS continuesRun,
              created_at AS createdAt
         FROM runs
        WHERE isolation = 'worktree'
          AND worktree_branch IS NOT NULL
          AND repo_root IS NOT NULL
        ORDER BY created_at DESC`).all() ...
```

There is no branches table. `branchInventory` (`src/lib/land.ts:2757`) selects
run rows that carry a `worktree_branch` and decorates them with git. A branch is
a **view over `runs`**, which is the one kind that already has a `q=`.

`BranchQuery` (`src/lib/land.ts:2556-2563`) carries `repo`, `offset` and `limit`
and no text field, and `src/app/api/branches/route.ts:26-42` reads exactly those
three. So branches are paged and not searchable.

The corpus is real and it is the largest on this machine:

```
$ git -C /workspace/UsageFoundry for-each-ref --format='%(refname:short)' refs/heads | wc -l
141
$ git -C /workspace/UsageFoundry for-each-ref --format='%(refname:short)' refs/heads | grep -c '^uf/'
121
$ git -C /workspace/UsageFoundry for-each-ref --format='%(refname:short)' refs/heads | shuf -n 4
uf/usagefoundry-721638d11c0b-1-f8e65ab2
uf/usagefoundry-721638d11c0b-2-075f7959
uf/usagefoundry-721638d11c0b-1-5c471f16
concurrent-runs-per-folder
```

**121 of 141 names are machine-generated and mutually indistinguishable.**

The same two commands re-run about fifteen minutes later, at the end of writing
this survey, returned **143 and 123**: two branches arrived while the file was
being written, from sibling agent runs working in this container. That is not
noise to be averaged away — it is the shape of the corpus. Branches are produced
by the machine, continuously, without an operator present, which is exactly the
test §09 uses to decide what deserves a search surface. This
kills the obvious design before it is written: a branch search that matches on
*branch name* is worthless here. What identifies a branch to a person is the task
its run was given, which is `runs.prompt` — the column `listRunsPage` already
matches (`src/lib/orchestrator.ts:1044`). Branch findability is therefore not a
new corpus. It is one predicate, threaded through a query type that already
exists.

### Schedule — a column on a workflow

```
$ grep -n 'CREATE TABLE IF NOT EXISTS workflow_schedules' -A3 src/lib/db.ts
518:    CREATE TABLE IF NOT EXISTS workflow_schedules (
519-      id               TEXT PRIMARY KEY,
520-      workflow_id      TEXT NOT NULL UNIQUE REFERENCES workflows(id) ON DELETE CASCADE,
```

`workflow_id` is `UNIQUE`. There is at most one schedule per workflow, there is
no `/schedules` page (`find src/app -ipath '*schedul*'` returns only
`src/app/api/workflows/[id]/schedule/`), and there is no list function — only
`getSchedule(workflowId)` (`src/lib/schedules.ts:588`). A schedule holds no text
of its own: `spec` is JSON, `time_zone` is an IANA string.

**There can never be more schedules than workflows.** Searching them is searching
workflows, and a "schedule search" would be a second name for a filter on the
workflow list.

### Agent, Template — small, operator-authored, and already complete

```
$ grep -n 'export function listAgents' -A4 src/lib/agents.ts
821:export function listAgents(): (SavedAgent & { usable: boolean })[] {
822-  const rows = db()
823-    .prepare(`SELECT ${COLUMNS} FROM agents ORDER BY name COLLATE NOCASE`)
824-    .all() as AgentRow[];
```

No `LIMIT`. Same for `listTemplates` (`src/lib/templates.ts:375-383`) and
`listWorkflows` (`src/lib/workflows.ts:1490-1496`) — all three return every row,
ordered `BY name COLLATE NOCASE`, which `templates.ts:376-377` explains is
because "the picker is a list a person scans".

These are the only two of F2's five that are genuinely independent, text-bearing
objects with no search. They are also the two whose corpus is bounded by how much
prose an operator has personally typed.

## The rest of the app, for completeness

36 `CREATE TABLE` statements in `migrate()` (`grep -c 'CREATE TABLE'
src/lib/db.ts` → 36). Grouped by whether an operator could want to find one:

**Has text worth searching, and a stable URL**
`runs` (`db.ts:142`, `prompt`, `/runs/[id]`) · knowledge notes (files on disk,
`knowledge.ts:1169`) · `chat_sessions` (`db.ts:556`, `title` + message text —
note there is no `/chat/[id]`, only `/chat`)

**Has text worth searching, no search**
`agents` (`db.ts:283`) · `run_templates` (`db.ts:242`) · `dreaming_notes`
(`db.ts:1864`, capped at `NOTE_LIMIT = 500`, `dreamingLedger.ts:43`) ·
`run_reviews` (`db.ts:212`) · `run_events.payload` (`db.ts:167` — raw agent
stdout; see §05 for why this matters) · plugins (disk, `plugins.ts:244`) ·
folders (disk, `workspace.ts:38` — this is B5's 25-item cap)

**Derived at request time, no independent identity**
branches (`land.ts:2757`) · touched files (`runTouchScan.ts:100`) · conflicts
(`land.ts:1261`) · merge-queue entries (`mergeQueue.ts:313`)

**Written and never read by any route** — roughly half the tables:
`fork_attempts` (`db.ts:1732`), `resume_probes` (`db.ts:1652`),
`plan_observations` (`db.ts:1690`), `webhook_deliveries` (`db.ts:1407`),
`context_samples`/`context_compositions`/`context_composition_children`
(`db.ts:1509`/`:1558`/`:1611`), `prune_receipts`/`prune_decisions`
(`db.ts:1447`/`:1801`), `run_deps` (`db.ts:346`), `otlp_requests` (`db.ts:187`),
`chat_turn_spend` (`db.ts:1361`), `login_attempts` (`db.ts:596`).
`request_log` (`db.ts:1293`) belongs here too and should not — see §11.

A global index would index all of it. That is §05's problem.

## What could not be measured

**No populated install database exists in this container.** Two were found and
copied read-only:

```
$ sqlite3 main.db  'SELECT count(*) FROM runs;'   # /workspace/UsageFoundry/.data
0
$ sqlite3 wt1.db   'SELECT count(*) FROM runs;'   # worktree -1's .data, 33 tables
0
```

Every content table in both is empty; only `settings` (2 rows, bookkeeping
timestamps) and `request_log` (8 rows) hold anything. `DATA_DIR` proper is
sandbox-denied and Docker is unavailable, so **the per-kind row counts of a real
install are not measured here and are not estimated.** The command a human should
run on a live install is in §10's falsifier.

What *was* measured on real data is what lives outside the database: 141 branches
(143 fifteen minutes later) across 15 repositories on this machine, 2,160 Claude
session transcripts under `~/.claude/projects`, and 1,415 markdown notes in the
vault at `/workspace2`.
