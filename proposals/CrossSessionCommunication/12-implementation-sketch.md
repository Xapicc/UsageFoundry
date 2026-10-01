# 12: Implementation sketch: Option G

Three commits, in this order, each landable alone. Line numbers are as of
`336b907`. Before editing, read the docs `CLAUDE.md` routes each file to:

- `docs/agent/security.md` for spawn environments;
- `docs/agent/taskboard.md` for the board's MCP surface;
- `docs/agent/testing.md` before adding a test, because it names the bar every
  existing test met.

## G1: no child of this app may message another session

**The rule to write down first**, as one paragraph in
`docs/agent/security/child-uid-and-credentials.md` and a line in its index:

> No Claude Code child this app spawns may list or message another session. The
> CLI's peer messaging is container-wide, extends a live cycle when a message
> arrives, accepts between `plan` and `acceptEdits`, and leaves nothing on the
> receiver's log. Every env that spawns `claude` sets `CLAUDE_CODE_HARBOR_KITE=0`,
> which removes `ListAgents`, refuses peer addresses in `SendMessage` and never
> opens the inbox. `--disallowedTools` is the wrong lever: it takes sub-agent
> messaging with it and leaves the inbox open.

**Where.** Every environment builder whose result reaches `spawn(CLAUDE_BIN, …)`:

| Spawn | Env builder | Note |
|---|---|---|
| Work cycle (`src/lib/orchestrator.ts:6760`) | `childEnv` (`src/lib/orchestrator.ts:6181`) | The value goes **after** `...extra` in the return, so no caller can re-enable it. The local provider's `localCycleEnv` is applied on top of `childEnv` (`src/lib/localProvider.ts:345`) and must not undo it. |
| Chat and blocks (`src/lib/chat.ts:3197`) | `chatEnv` (`src/lib/chat.ts:4285`) | It builds its own env from `process.env` and does not call `childEnv`. |
| Review, resolution (`src/lib/review.ts:1099`) | `reviewEnv` (`src/lib/review.ts:1253`) | The same. |
| Pruning probes (`src/lib/contextPruning.ts:1653` and siblings) | `pruneEnv` (`src/lib/contextPruning.ts:1444`) | Only where the spawned binary is `claude`. Not the `WINNOW_PYTHON` spawn. |
| `claude auth` (`src/lib/claudeAuth.ts:308`, `src/lib/claudeAuth.ts:420`) | `spawnOptions()` | No session and no tools, so no change. Say so in a comment rather than leave it to be wondered about. |

The build run must re-derive this table rather than trust it:
`grep -n "spawn(CLAUDE_BIN\|spawn(adapter.bin" src/lib/*.ts`, then follow each
`env:` back to its builder.

**Tests.** `childEnv` is already pinned by
`src/lib/orchestrator.test.ts:4567` ("a credential class the app has no use
for"). Add one assertion there, that the key is `"0"` even when `process.env`
and `extra` both carry `"1"`, and the same for `chatEnv` and `reviewEnv`. The
grounds `docs/agent/testing.md` asks for: the failure is silent. A regression
reopens the channel, every run still works, and nothing on any page changes.

**Verification.** Add a *Verified* entry to
`docs/verification/security-and-sandboxing-privilege-and-auth.md`, or the file
its index names for spawn environments. It records what
`scripts/native-tools.sh` shows on 2.1.280 with and without the variable
(23 → 22 tools, `ListAgents` gone, `[uds-messaging] Skipped`), with the date.
Add a *Not yet verified* item for the receiving side (U1), with
`scripts/native-pair-test.sh` as the command that settles it. Add a second
item: the CLI has a late-bind path that opens the inbox when a flag refresh
enables the gate mid-session. That the variable also holds against that path is
inferred, from the gate returning the variable's value whenever it is set
([`13-validation.md`](13-validation.md) §4).

**Pin bumps.** The variable is the CLI's internal name. Whoever bumps
`CLAUDE_CLI_VERSION` (`Dockerfile:445`) re-runs `scripts/native-tools.sh` with
`EXTRA_ENV=CLAUDE_CODE_HARBOR_KITE=0`, and refuses the bump if `ListAgents` is
in `init.tools`. The scripts are moved to `scripts/` at the repository root at
that point, so they outlive this proposal.

## G2: `list_my_tasks` can search

- **`src/lib/tasks.ts`.** `tasksForRun(runId, folder)` (`src/lib/tasks.ts:1505`)
  gains an optional `query`. When it is present, `openInFolder` is the open tasks
  in the folder whose `title` or `body` contains it, case-folded. It is still
  capped at `MAX_RUN_TASKS` (`src/lib/tasks.ts:1473`), and
  `openInFolderTotal` counts the matches.
  - Use a parameterised `LIKE ? ESCAPE '\'`, with the query's `%`, `_` and `\`
    escaped. Never interpolate it.
  - It is one synchronous `better-sqlite3` query, so it is safe on every path
    (`proposals/ContinuousImprovement/01-constraints.md:134`-`:145`).
- **`src/app/api/mcp/route.ts`.** The `list_my_tasks` definition
  (`src/app/api/mcp/route.ts:537`) gains `query: { type: "string" }`, bounded
  in length by the handler. Its description gains one sentence: *before you
  file something, search for it: the folder may hold more open tasks than one
  page shows.* `listMyTasks` (`src/app/api/mcp/route.ts:3844`) passes it
  through. `held` is never filtered: what a run holds is not a search result.
- **Tests.** In `src/lib/tasks.test.ts` beside the existing `tasksForRun` case
  (`src/lib/tasks.test.ts:929`):
  - a query matches beyond the 20th row;
  - `%` in a query is literal;
  - `held` is unchanged by a query.
- **Docs.** One paragraph in the `docs/agent/taskboard/` topic file that owns
  `list_my_tasks`, saying the count alone was measured not to prevent
  duplicates, with this survey's nine filings as the evidence.

## G3: the sibling roster

- **`src/lib/tasks.ts`.** Add `siblingsForRun(runId, folder)`:

  ```sql
  SELECT r.id, r.worktree_branch, r.started_at, t.title
    FROM runs r LEFT JOIN tasks t ON t.claimed_by_run_id = r.id AND t.status = 'claimed'
   WHERE r.folder = ? AND r.id <> ? AND r.status IN ('running', 'paused')
   ORDER BY r.started_at
   LIMIT 10
  ```

  The build run must confirm the claimed-status spelling and the `runs` columns
  in `migrate()` (`src/lib/db.ts`). The `LEFT JOIN` can yield several rows per
  run if a run holds several tasks: take the first by the board's own priority
  order.
- **`src/app/api/mcp/route.ts`.** `listMyTasks` adds
  `siblings: [{ run, branch, startedAt, holding }]`. Here `run` is the 8-character
  id the UI shows, and `holding` is the title clipped to 120 characters, or
  `null`. **No task id.** That is the line between G3 and the runner-up. The
  description gains one sentence: *other runs live on this repository right now,
  and the branch each is on; `git log <branch>` shows what they have committed.*
- **What it must not carry:** a sibling's prompt, its log, its report, or any
  field a run can write other than the title already in `openInFolder`.
- **Tests.**
  - A sibling on the same folder is listed.
  - One on another folder is not.
  - A `completed` one is not.
  - Self is not.
  - No row carries a task id. Pin this one explicitly, because it is the
    property the runner-up is defined by.

## What the runner-up adds, if the falsifier fires

C-board is one field: `heldTaskId` on each roster row, and one sentence telling
the run it may leave a note there with `comment_on_task`. Before that ships:

- **Scope `comment_on_task` for runs to what the doc says it is.** Today a run
  may write on any existing task (`src/lib/taskComments.ts:270`), and the doc
  says "anything it can see" (`docs/agent/taskboard/comments.md:92`). The new
  scope is a held task, a task in `openInFolder`, or a task a sibling on the same
  folder holds. Do this first, because C-board makes sibling task ids routine
  rather than rare.
- **Render a run-authored note on the run page of the run that read it**, not
  only on the task page, so C5 holds on the receiving side.

## What none of this touches

- `cycleInvocation.ts`'s argv and the appended prompt are unchanged. G1 is an
  environment value, so the cached prefix is untouched.
- No new table, retention horizon, `StorageReport` arm, tool definition, model
  call, or byte in a mounted folder.
- `taskboardForRuns` (`src/lib/settings.ts:1063`) still gates G2 and G3. G1 is
  unconditional, because the channel it closes is open whether or not the board
  is on.
