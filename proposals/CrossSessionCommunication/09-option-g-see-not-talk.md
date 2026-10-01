# Option G: runs see each other, and nobody talks

Added to the brief's list for the reason [`00-problem.md`](00-problem.md) §4
gives. Every measured duplicate between live siblings was a run failing to see
state that already existed. None was a run lacking words only a sibling could
send.

## 1. Its strongest case

It answers the measurement, it closes the one channel that fails four
constraints, and it adds no new text a run wrote to anything another run reads.

- **The nine Dockrac filings.** Each filer called `list_my_tasks` and was shown
  20 of 69-99 open tasks. The docblock above `tasksForRun` already names this
  failure: "a run shown twenty of sixty open tasks and told nothing files the
  duplicate it was reading the list to avoid" (`src/lib/tasks.ts:1500`-`:1503`).
  The fix it chose, telling the run the total, did not stop it. Being told
  "there are 99" does not let a run find the one that matters.
- **The siblings.** Runs on one repository are live together 80% of the time.
  The only way they currently learn of each other is incidental: the CLI's
  `ListAgents` showing them a sibling's session name and nothing about its work.
  The app knows exactly which runs are live on a folder, which branch each is
  on, and which task each holds.

## 2. Shape: three parts

- **G1: close the CLI's channel.** Set `CLAUDE_CODE_HARBOR_KITE=0` on every
  environment that spawns `claude`.
  - Measured on 2026-10-01 with `EXTRA_ENV=CLAUDE_CODE_HARBOR_KITE=0 bash scripts/native-tools.sh kite0 …`:
    `ListAgents` is gone (22 tools, against 23), `SendMessage` stays for the
    run's own sub-agents, and the inbox is skipped.
  - `--disallowedTools` is the wrong lever. It also removes sub-agent messaging,
    and it leaves the inbox open ([`02-what-already-talks.md`](02-what-already-talks.md) §1).
- **G2: let `list_my_tasks` search.** Add an optional `query`, matched
  case-folded against the title and body of every open task in the run's folder,
  returning up to `MAX_RUN_TASKS` matches with the total.
  - Add one sentence to the tool description: search before you file.
  - No new tool, so no new standing definition. The existing one grows by one
    optional property.
- **G3: a sibling roster on `list_my_tasks`.** Add a `siblings` array: the other
  runs whose `runs.folder` is this run's and whose status is `running` or
  `paused`.
  - Each row carries a short id, `worktree_branch`, `started_at`, and the title
    of the task it holds, clipped and labelled as a title.
  - All fields are app-derived except that title, which a run may have written
    and which `openInFolder` already shows to every run in the folder.
  - **No held task id**, so the roster opens no path for a note to reach a
    sibling. That is the line between G and Option C-board.

## 3. When it is read

On request, at the agent's next `list_my_tasks`, which every measured filer
called before filing. Nothing is pushed, nothing goes into the appended prompt,
and nothing goes into the app-composed `-p` slot.

## 4. Metering and guards

None of the three parts starts, wakes or extends anything. G1 removes the one
path by which a cycle could be extended by another agent's text (C3), and the
one by which a `plan` run could have a writing sibling act for it (C4). G2 and
G3 are reads.

## 5. Restart

G1 is an environment value set at every spawn, so there is nothing to survive.
G2 and G3 are queries over rows `reconcileOnBoot` already settles. A run closed
at boot is no longer `running`, so it drops off every roster with no new code.

## 6. What the operator sees

- G1: a `docs/verification/` entry and, for a cycle, one fewer tool in its
  `system:init`.
- G2 and G3: the `list_my_tasks` call on the run's log. The query is in its
  clipped input.
- Nothing new to page through, because nothing new is said.

## 7. Isolation and injection

**G adds no free text a run wrote to anything another run reads.** The task
title is the one exception, and it is already in `openInFolder`.

- G1 removes the container-wide, forwardable, unlogged channel. That is the
  largest single reduction in C8 exposure available to this survey.
- The roster's branch names let a run `git log` a sibling's branch, which runs
  already do unprompted. That reads the sibling's commits: state the sibling
  chose to commit, under its own name, landed or not. It is not a message.

## 8. Cost to build

- **G1**: one line per spawn env, one unit test pinning it, one verification
  entry. Under a day.
- **G2**: an optional parameter through `tasksForRun` (`src/lib/tasks.ts:1505`)
  and the handler (`src/app/api/mcp/route.ts:3844`). About half a day with its
  test.
- **G3**: one synchronous query and one field on the same handler. About half a
  day.

Standing cost: G2 and G3 enlarge one existing tool's schema by a few dozen
tokens, a fraction of the $8.14-$8.26 a week a whole definition costs (C10).
That figure is estimated, not measured.

## 9. What would have to be true

- **G1.** Nothing a run needs goes through peer messaging. Measured: zero peer
  sends in 21 `SendMessage` calls, and every sub-agent use survives the switch.
  The env var is the CLI's internal name, so it must be re-proved at every pin
  bump (U2).
- **G2.** Duplicates come from not finding, not from not looking. Measured:
  every one of the nine filers looked first.
- **G3.** A run that can see its siblings' branches uses them. That is the least
  evidenced part. Runs read sibling branches unprompted in some cases
  ([`02-what-already-talks.md`](02-what-already-talks.md) §5), and the one redo
  happened with the sibling commit in view. [`13-validation.md`](13-validation.md)
  §2 measures it before it is relied on.

## Verdict

**Recommended**, as G1 then G2 then G3, for the reasons in
[`11-recommendation.md`](11-recommendation.md).
