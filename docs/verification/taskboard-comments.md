# Verification: Taskboard — task comments and threads

[← Verification index](../verification.md)

## Verified

- **Task comments end to end, in-process, 2026-09-11**: the real route
  handlers and the real MCP route compiled with `tsc` to a scratch `outDir`
  and required directly, tokens from `mintCapability`/`mintRunCapability`
  against a seeded `runs` row and a claimed task, **31/31 assertions**.
  `comment_on_task` is published to the run subject (4 tools, not 3) and to
  the chat subject and refused to a block in its own sentence naming
  `list_tasks`; an operator's note written through `POST
  /api/tasks/[id]/comments` is recorded as `operator` with a null
  `authorRunId` and its body trimmed; a body carrying `author` is a 400
  naming the field; a thread on an id that is not there is a 404 rather than
  an empty list; a note written through the run's tool is attributed to the
  token's run id; the thread reads back oldest first with `total` beside it;
  `updated_at`, `status` and `claimed_by_run_id` are unmoved after both
  writes; `commentCount` is 2 on `GET /api/tasks/[id]` **and** on the board
  row from `GET /api/tasks`; `list_my_tasks` hands the run both notes whole
  under `held` with `commentsTotal`, and `openInFolder` carries no thread;
  `complete_task` is still refused for a task the run does not hold while
  `comment_on_task` on that same task is allowed, which is the stated trade;
  and `DELETE /api/tasks/[id]` leaves zero rows in `task_comments`, which is
  the cascade proved through the real route rather than through a `PRAGMA`.
  Caveat: this is the server half only. Nothing here opened a browser — the
  board's own rendering of a count or a thread is a later run's work — and
  no `claude` child was spawned, so what a model does when handed the tool
  description is unmeasured.

- **`npm run build` with the comments route, 2026-09-11**: `env -u
  __NEXT_PRIVATE_STANDALONE_CONFIG npm run build` exit 0 twice,
  `.next/BUILD_ID` and `.next/standalone` both written on the worktree
  mount; `/api/tasks/[id]/comments` is listed as a dynamic route. Ahead of
  it, `NODE_ENV=development npm ci --include=dev` exit 0, `npm run
  typecheck` exit 0, `npm test` 2654/2654. `npm run smoke-pages` then served
  `.next/standalone/server.js` — the artifact the container ships, not the
  `next start` fallback — and reported 44/44 page loads clean, 0 of 22 pages
  failing at either width. It asserts about *load* only and this change adds
  no page, so what it rules out is a route change having broken one.

- **The thread and the board's count, in a real browser, 2026-09-11**: the half
  the entry above says it does not cover. The standalone bundle served against a
  throwaway `DATA_DIR` and a `CLAUDE_BIN` that cannot spawn, seeded through the
  real routes, driven with the container's Chromium at 1280px and 390px.
  `/tasks/[id]` drew four notes oldest first, one per author kind — `Operator`,
  `Orchestrator`, `Workflow`, and `Run` with `9f2c1d3a` linking to `/runs/…` —
  each carrying its own relative phrase, and a body's blank line survived as a
  blank line, which is what `whitespace-pre-wrap` and no `Markdown` buys. **Both
  widths: no console error, no sideways scroll.** The composer was pressed for
  real: with an empty box the button reports `disabled`, with a draft it does
  not, the click posted, the box came back empty, the note appeared and the
  count beside the heading went 4 → 5 with the task's own title, priority and
  `updated_at` unmoved. All three ways of having nothing were rendered rather
  than reasoned about — a task with no notes drew the sentence naming who may
  write one; a thread of **205** against `MAX_TASK_COMMENTS` = 200 drew *Showing
  the newest 200 of 205 comments* over notes 6…205, which is the oldest end
  dropped and the newest kept, measured rather than inferred; and
  `/api/tasks/*/comments` aborted inside the page drew the failed-read notice
  **and** *this is a failed request rather than an empty thread* with a retry,
  the composer still on screen under it. On `/tasks` the count read `4 comments`
  inside the Task cell at both widths, no seventh column appeared, and the task
  with no notes drew nothing at all rather than a zero. Caveat: one browser
  engine, and the **default** skin only — nothing here opened
  `data-skin="ascii"`, which is board item `4e6dd0b9`.

- **The whole gate for the thread's two surfaces, 2026-09-11**, on the worktree
  mount: `NODE_ENV=development npm ci --include=dev` exit 0; `npm run typecheck`
  exit 0; `npm test` **2654 tests, 2654 pass, 0 fail** across 413 suites; `env
  -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build` exit 0 with
  `.next/standalone` written; `npm run smoke-pages` served
  `.next/standalone/server.js` and reported **44/44 page loads clean, 0 of 22
  pages failing**. The test count is unchanged from the entry above and that is
  deliberate: this change is two rendered surfaces and one `Record` of four
  words, and none of the three is a pure function with a silent failure mode,
  which is the bar `docs/agent/testing.md` records. What covers it is the
  browser entry above rather than a unit test.

- **The thread on the run page, in a real browser, 2026-09-14.** The block
  `RunTaskComments` draws in the inspector on `/runs/[id]`, against the branch's
  own `.next/standalone/server.js` with a throwaway `DATA_DIR` and a `CLAUDE_BIN`
  that cannot spawn, seeded through the real routes. One run linked to four task
  ids so a single page carries every state the block has: a thread of **zero**, a
  thread of **one**, a thread of **nine**, and an id whose task was deleted after
  the link was written. Opened at **390px and 1280px**, in **light and dark**, in
  the **default and ascii skins** — eight combinations, every one of them with no
  console error, no sideways scroll, and the region measured inside its parent's
  content box (322px in a 354px column at 390, 300px in 332px at 1280). All four
  states drew: *Nothing said yet* with a link to the task, the single note under
  `Operator`, *Newest 3 of 9* over notes 7–9 with a *Read the thread* link — the
  newest end, measured rather than inferred — and *a task since deleted* with no
  thread asked for and none drawn. A body's backticks and its wrapping survived at
  390px in both skins. The poll gate was measured on its own: with the row forced
  to `running`, **three** requests to `/api/runs/[id]/task-comments` in 25s at
  0/10.1/20.1s; with it `failed`, **one**, the mount's, over the same span. Caveat:
  one browser engine, and nothing here pressed anything — this block has no
  control on it to press.

- **The whole gate for the run page's thread, 2026-09-14**, on the worktree
  mount: `npm run typecheck` exit 0; `npm test` **2789 tests, 2789 pass, 0 fail**;
  `env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build` exit 0 with
  `.next/standalone` written; `npm run smoke-pages` served
  `.next/standalone/server.js` rather than the `next start` fallback and reported
  **46/46 page loads clean, 0 of 23 pages failing at either width**. The one test
  added covers `newestCommentsForTasks`, which is the bar rather than a convention:
  a window reading the oldest rows instead of the newest draws a thread that looks
  right and hides the note somebody just wrote, and a missing partition attributes
  one brief's notes to another. Neither throws.

- **The run page no longer draws its own run's notes, 2026-09-26**, standalone
  server, Chromium at **1920x963 and 390x844**, default skin, light theme, one
  completed run seeded straight into a throwaway `DATA_DIR` (the notes by the run
  itself need an `author_run_id` no operator route writes) and linked to four
  tasks. A task holding only a 40-line report by this run drew *This run left 1
  note, 3m ago. Read it on the task* and no row; one holding that report plus an
  operator note drew the same line above the operator's row alone; one with no
  notes drew *Nothing said yet* as before; and a seven-note thread whose newest
  three were this run's, another run's, this run's drew *Newest 3 of 7, 2 of them
  by this run, the latest 1m ago* above one row, `Run 9c1e44aa`, with its run
  link. Every link opened `/tasks/<id>`, and no console error at either width.
  `/tasks/[id]` for the second task still drew both notes whole, the run's with
  its `Run 337d38f5` header. Gate on the same tree: `npm run typecheck` exit 0;
  `npm test` **3033 tests, 3033 pass, 0 fail**, exit 0, beside the one suite
  that throws during construction against CLI 2.1.280 (`sandboxMountPoints`,
  already on the board); `npm run smoke-pages` against
  `.next/standalone/server.js`, **92/92 page loads clean**. Caveat: one engine
  and one skin for this block, and `smoke-pages`' own seed carries no notes, so
  its pass says nothing about it.

## Not yet verified by hand

- **Nothing has watched a real `claude` child call `comment_on_task`.** Every
  assertion about this feature is against the route handlers in-process; what
  a model does when handed the tool description — whether it reads the
  operator's note out of `list_my_tasks` and acts on it, and whether it
  reaches for `comment_on_task` instead of widening its own diff — is
  unmeasured, and the descriptions are the only thing standing between the
  two. Settling it: `docker compose up --build`, switch *Let runs use the
  taskboard* on, start a run from a task, write a note on that task from
  `/tasks/<id>` mid-run, and read the next cycle's transcript for whether the
  note reached the model and what it did with it.

- **The `MAX_RUN_TASKS × MAX_TOOL_TASK_COMMENTS` ceiling on a
  `list_my_tasks` payload has never been reached.** Note bodies are not clipped
  in a tool result, deliberately — see `toolComment` in `route.ts` — so a run
  holding twenty tasks each carrying ten notes at `MAX_TASK_COMMENT` is a
  reply nothing bounds below two megabytes. Nothing in this app produces that
  shape (a run holds one task in practice) and no measurement says what a
  cycle pays for a realistic one. Settling it: seed a run holding three tasks
  with ten notes each, call `tools/call list_my_tasks` through the in-process
  harness, and measure the reply's bytes against the same call with no
  threads.
