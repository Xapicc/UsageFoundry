# Verification: Workflows and schedules — the canvas, instances, schedules, and a loop's region, link and board stop

[← Verification index](../verification.md)

## Verified

- **A loop as a region, 2026-09-21** (production standalone build from this
  branch, scratch `DATA_DIR`, one-repo vault, Chromium): a graph whose section
  holds a run block, an orchestrator block capped at 2 and a merge block at its
  exit POSTed 200 and came back with `bodyNodeIds` `["a","d","m"]` and every
  field on the loop empty — `task` `""`, `templateId`, `agentId` and
  `promptOverride` null, `mountId` and `folder` `""`. A loop sent a task was
  refused 400 with the field named: "frames the blocks it repeats and starts no
  run of its own, so there is no task for it to do." A section ending at a run
  block was refused 400 naming the block and the block to add. The edit page for
  the saved workflow loaded with no console error, Save was enabled, pressing it
  navigated to the detail page, and re-reading the workflow gave the same
  `bodyNodeIds` — so the editor still round-trips a legal graph with the loop's
  own task, workspace, template and agent controls still on screen and their
  values dropped before the wire. Caveat: `CLAUDE_BIN` could not spawn, so
  nothing here ran a pass, and the runtime still carries the previous
  one-branch-all-the-passes contract — what a pass does with a section that
  forks or that ends in a merge block is not covered by any of this.

- **Workflows end to end, live dev server, stub CLI:** save refuses each bad
  graph by name; a four-block graph ran its roots in parallel and continued a
  branch; a failed root left its `on-success` dependent `blocked` while the
  `on-finish` one ran; deleting a workflow keeps its runs.

- **Canvas live check:** `POST /api/workflows/validate` returned each of nine
  refusals as `normalizeWorkflowInput`'s sentence and a valid graph as
  `{"ok":true}`; all four workflow pages answered 200.

- **The link that says what a loop repeats, 2026-09-21** (production standalone
  build, scratch `DATA_DIR`, Chromium 1280×1000): a four-block graph POSTed with
  a `repeats` link from the loop to the first member saved 200 and came back
  with `bodyNodeIds` derived from it; the edit page drew the region labelled
  *Repeated by Repeat it · 2 blocks in order*, the member cards marked *FIRST OF
  2* and the panel listed the section as *first* / *last — its DONE ends the
  loop*; the intra-section link's panel stated the branch rule with a Remove
  button and no pickers; the containment link's panel stated *Nothing waits for
  this link*. The same graph POSTed with `bodyNodeIds` and **no** link rendered
  identically — the link is materialised on the way in — and leaving the
  untouched page raised no unsaved-work dialog. Pressing **Repeat** and then a
  block redrew the section live, at 2 links and no refusal. Caveat: driven
  against a `CLAUDE_BIN` that cannot spawn, so nothing here ran a pass; what a
  pass *does* with the section is `stepPass`' own tests. The duplicate-link
  defect this found — the gesture appending beside an ordinary link the loop
  already had to that block, which `normalizeWorkflowInput` refuses as "set to
  start after … twice" — was fixed and re-measured green in the same way.

- **A loop's board stop condition, 2026-09-21** (production standalone build,
  scratch `DATA_DIR`, Chromium 1280×1600): `/api/workflows/validate` returned
  `{"ok":true}` for `["open"]`/0 and refused `["done"]` and `atMost: -1` as
  `normalizeWorkflowInput`'s own sentences. A graph saved with
  `["open","claimed"]`/2 read back through `GET /api/workflows/[id]` byte for
  byte and re-populated all four controls in the editor. The block's sentence
  on both the editor panel and the instance page named the project, the states
  and the number. `npm run smoke-pages` was 92/92 with no console error.
  **Not measured by hand:** a loop actually declining to start its first pass
  against a clear board — the decision is covered by `planLoopPass`'s unit
  tests and the count by `loopBoardCount.test.ts`, but nothing here drove a
  real instance through `runInstanceStep`. `npm run dev`, save a one-loop
  graph pointed at an empty project, press Run, and read the block's status
  and reason without a run appearing.

- **A workflow's history pages, 2026-09-07**, `next start`, 45 seeded
  instances: 20 by default, `?offset=999` clamps to the oldest row and
  `?limit=5000` to 100; the page drew `1–20 of 45`, Next drew `21–40 of 45`.

- **A drawn workflow cannot be discarded without being asked, 2026-09-07**
  (Chromium 1400×900, production build): the sidebar link, breadcrumb,
  Cancel, ⌘3 and quick open each raised *Discard unsaved changes?*; a
  Ctrl-click and an unchanged or typed-back editor did not. Browser Back was
  deliberately not tested.

- **A loop's board condition, thresholds and all, was driven by hand against a
  built standalone server, 2026-09-21.** A scratch `DATA_DIR` and workspace
  holding `terraServe`, `terraServe/docs` and `terraServeWeb`, seven tasks
  filed through `/api/tasks`. `/api/workflows/validate` answered
  `{"total":5,"byPriority":{"urgent":1,"high":1,"normal":2,"low":1}}` for the
  folder alone and `total 6, normal 3` with `includeSubfolders` on — the
  `docs` task and not the `terraServeWeb` one, which is the separator in the
  prefix doing its job. `?priority=urgent` answered 1 and `?priority=bogus`
  answered 400. A workflow POSTed in the pre-thresholds shape (`atMost: 4`, no
  `thresholds`, no `includeSubfolders`) came back stored as
  `includeSubfolders: false` and one `{"priority":"any","atMost":4}`, and one
  with no condition came back `null`. Caveat: no agent ran — `CLAUDE_BIN`
  pointed at a file that does not exist, so nothing here exercises a pass
  actually stopping, only the figures the decision is made from.

- **The threshold rows were measured in the browser at both widths,
  2026-09-21.** At 1280 each threshold is one line — label, number, priority,
  Remove — with the number field at its full 80px. At 390 the row wraps after
  the number and the picker takes a line with Remove, both rows breaking in the
  same place and both numbers at one x (112). The select's chosen option was
  measured against its own content box at both widths and fits in all four
  readings; before the `max-md:min-w-40` floor it had 76px for a 110px "Any
  priority" and drew "Any pr". `document.scrollWidth` equalled `clientWidth` at
  both. Caveat: measured in the default skin only — `npm run smoke-pages`
  covers the ascii one for load, not for this row.

- **The project row's two sentences were read out of the DOM, 2026-09-21.**
  With a project picked it says `5 open now — 1 urgent, 1 high, 2 normal, 1
  low`; set back to off it says `Counted before every pass, including the first
  — a backlog already clear starts no run`, the threshold rows go (0 number
  fields in the DOM) and the block's statement loses its board clause,
  ending at `or after 5 passes.` Caveat: the count is the server's, so this
  says the row draws what the route answered, not that the route counted
  right — the entry above is what says that.

- **The picker and the board were read side by side, 2026-09-21.** The loop's
  project `<select>` offered `ws`, `ws / terraServe`, `ws / terraServe/docs`,
  `ws / terraServeWeb`; `/tasks`' own filter offered the last three, character
  for character. The extra is the mount root, which the board lists only once a
  task is filed there and the picker lists always — that difference is
  deliberate and written down beside `projects`. Caveat: one mount with a label
  equal to its directory name, so this does not exercise a mount whose
  configured label differs from its path.

## Not yet verified by hand

- **The pager has not met live instances**: all rows were inserted `finished`
  with no member runs, and none arrived while a page was open.

- **No loop has actually stopped on a board threshold.** The figures the
  decision reads were driven by hand against a built server and are recorded
  above, and `planLoopPass`'s any-of reading is unit-tested, but the two have
  never met: nothing has watched a pass finish, the count fall past a number
  and the block end with `tasks` and that threshold's sentence on it. Settle:
  point a loop at a scratch project holding two tasks with a stub `CLAUDE_BIN`
  that closes one per cycle, set one threshold at 1, press Run, and read the
  block's stop reason for the priority and both figures.

- **No real restart has been taken over a live loop block**; the
  `reconcileBlocksOnBoot` fix is unit-tested only. Settle: park a pass inside
  `resumeGraceHours`, `docker compose restart`; the block must still read as
  repeating and the pass resume, and a loop whose pass that boot failed must
  still read `failed`.

- **No workflow schedule has ever fired.** `decideSchedule` and its helpers are
  unit-tested, both Europe/Berlin DST boundaries included; no card has rendered,
  and `reconcileSchedulesOnBoot` has not seen a real restart. Settle: fire one
  a few minutes out, stop the container over the next and expect *missed*.

- **An unhalted instance's `working`/`finished`/`blocked` badges.** Tested
  against a real db; no browser has rendered them. The risk is cosmetic.

- **Stopping a whole workflow instance against real runs.** `haltPlan` is unit
  tested; no child has been signalled by `stopInstance`.

- **An orchestrator block, end to end.** Its planners are unit tested; no
  block has spawned a child, called `emit_runs` or created a run.

- **The workflow canvas, touched in a browser.** Dragging, linking, keyboard
  routes and the stored layout are all unexercised.

- **A pre-canvas workflow opened on the canvas and saved back**, to confirm
  every link survives; the derived layout is unit tested.

- **A workflow instantiated against the real CLI.** Every run so far came from
  a stub that committed nothing.

- **The rollback path.** Its stop-everything-and-record-`failed` branch has
  never run; read it rather than trust it.
