# Verification: Taskboard — the board, its MCP tools and validation

[← Verification index](../verification.md)

## Verified

- **The taskboard in a browser, 2026-09-07**, standalone server, seeded
  `tasks`: a clipped 310-character brief survived a title-only save; every
  operator move worked through its own button; a refusal rendered
  `taskTransitionRefusal` verbatim; all three nothings drew; ⌘1…⌘9 matched the
  sidebar; no console error at 1280 or 390.

- **The board's MCP tools, in-process, 2026-09-07**: the real route handler
  compiled with `tsc`, tokens from `mintCapability`, 23/23 assertions. Block
  tokens lack `create_task`, `status: "done"` is refused by name, unknown ids
  are refused at all three doors; it caught `propose_run` dropping `taskId`.

- **The task link on its three surfaces, 2026-09-07**, Chromium at 1280px,
  rows seeded through `src/lib`: the proposal card names the task or "a task
  since deleted" and still offers Approve; the run page links it, still Open
  after the run completed; the board row lists the run.

- **The `taskboardForRuns` switch is off on a never-written settings file,
  2026-09-07**, Chromium at 1280px, production build; `smoke-pages` drew
  `/settings` and `/tasks` clean at 390 and 1280.

- **The board reads every task, one status at a time, 2026-09-26**, standalone
  server, Chromium at 1280px, 320 urgent Done, 1 Dropped and 30 normal Open
  seeded through `/api/tasks`. The old single `?limit=300` request answered 300
  of 351 rows with **0 of the 30 Open**; the board now draws 30/30 Open,
  320/320 Done and 1/1 Dropped from five requests (one per status, a second
  page of Done), with no truncation notice and no console error. The live
  install at the time held 816 tasks, and the old request hid 77 of 154 Open
  and 5 of 13 Claimed. Caveat: Claimed was empty in the seed, since the
  operator cannot claim, and the page-shift race between two pages of one
  status was reasoned about, not provoked.

- **`get_my_task`, in-process, 2026-09-26**: `src/app/api/mcp/route.test.ts`
  drives the real route with tokens from `mintRunCapability`/`mintCapability`,
  6/6 tests. The run's tool list gained exactly `get_my_task` and the chat and
  block lists did not; a held 808-character brief came back whole while
  `list_my_tasks` still said `bodyClipped`; another folder's task, another run's
  claimed and done ones and an unknown id got one sentence modulo the id; a
  deleted run's token read only what it held. All six failed before the change.
  Caveat: no real CLI and no model was involved.

- **Operator-only and `release_task` through the real MCP route, in-process,
  2026-09-27**: `route.ts` and `src/lib` compiled with `tsc` to a scratch
  `outDir`, `POST` called directly with tokens from `mintRunCapability` and
  `mintCapability` against seeded `runs` rows, **21/21 assertions**.
  `release_task` is on the run's list and `complete_task`'s description points
  at it; `list_my_tasks` marks the operator-only row in `openInFolder` and says
  nothing on an unmarked `held` row; a string `operatorOnly`, a blank reason,
  another run and an unknown id are each refused with nothing written; the
  holder's release left the task open, unclaimed and marked with its reason as
  a note from that run, after which `complete_task` and a second release were
  refused; a run's `create_task` filed a task marked; a chat calling
  `release_task` got its own sentence; chat `list_tasks` narrowed on the flag
  both ways and refused `"yes"`; `get_task` returned it. Caveat: no `claude`
  child was spawned, so what a model does with the descriptions is unmeasured.

- **Operator-only on the board, 2026-09-27**, standalone build on a scratch
  `DATA_DIR`, three tasks seeded through `POST /api/tasks`, Chromium at 1280px
  and 390px: the badge drew under the marked row's title, the "Who does it"
  filter left one row on Operator only at 1280px (the 390px pass ran after the
  flag was cleared and showed none, as it should), the task page's toggle cleared the
  flag through its own `PATCH` (read back `false`), the new-task toggle drew
  below Folder, no console error and no sideways scroll at either width.
  `GET /api/tasks?operatorOnly=yes` and a `PATCH` sending `"false"` were both
  400s. `npm run smoke-pages` 92/92 on the same build.

## Not yet verified by hand

- **No model has called the board tools over stdio**; that needs a billed run.

- **The taskboard tools (2026-09-07) have never met a real CLI**: unseen are
  the tool list on a first and a `--resume` cycle beside the operator's MCP
  servers, a refused `complete_task`, the token dying with the run; settle
  with a task's run after `docker compose up --build`. Unrendered: refusals
  to non-operators, chat live view, Backups, sign-out, queue priority, Open PR.

- **The external validator, end to end.** No verdict has come from the pinned
  CLI via `spawnAssist`. It rests on a spike's 34 of 37, zero false-finished
  (subagent transport, one sample per case, 40 runs judged against `runs.task`)
  on a prompt since replaced; the shipped prompt has never been scored.

- **`get_my_task` has never been called by a model.** What it was added to
  replace — a run told to read its brief in full digging the body out of
  transcripts on disk — is what is unmeasured: whether a cycle handed a clipped
  `bodyPreview` calls it, once, before working. Settle it after
  `docker compose up --build` by starting a run from a task whose body is well
  over 200 characters and reading the first cycle's transcript for a
  `get_my_task` call and for no read under `~/.claude/projects`.

- **No model has called `release_task`, and the judgement it asks for is
  unmeasured.** The write is covered in `tasks.test.ts` and through the route
  in process; what is not is whether a cycle that cannot finish reaches for it
  rather than stopping with the task held, and whether it keeps `operatorOnly`
  for blockers outside the container rather than for work that was merely
  hard. Settle it after `docker compose up --build` with *Let runs use the
  taskboard* on: start a run from a task that needs a Mac, and read whether
  the task comes back open, marked, with a reason naming the blocker.
