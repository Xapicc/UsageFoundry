# Verification: Taskboard — task dependencies and their drawing

[← Verification index](../verification.md)

## Verified

- **Task dependencies, both doors, 2026-09-11** against the branch's own
  `.next/standalone/server.js` and — for the tool surface — the same modules
  loaded in process. On the **route**: an edge across two projects wrote with
  `created: true` and both ends described down to `mountId`/`relPath`; the same
  call again answered 200 with `created: false` and one edge still on the board;
  a two-node and a three-node loop were both refused 400 naming the loop by
  title (`“Ship the parser” → “Write the parser” → “Third” → “Ship the
  parser”`); a self-edge, a `dependsOn` that is not a task and a `taskId` that
  is not a task were refused 400/404/404 with three different sentences; `GET`
  answered both directions and 404 on a task that is not there; closing the
  dependency took `blockedByCount` 1 → 0 with the edge and its count standing;
  `DELETE` answered 200 then **404** on the repeat; and deleting a task took the
  edge on its other end with it. Nothing was logged at error level. On the
  **tool surface**: `add_task_dependency` is on a chat's list and on a run's
  five, absent from a block's and refused to one by name; the write, the repeat
  and the loop answered in the three wordings above with `isError` set only on
  the refusal; an unknown id came back in `taskRefusal`'s own words;
  `get_task` carried the refs with their projects, `list_tasks` the two counts,
  and `list_my_tasks` `waitingFor` on `held` only. **The advisory property was
  measured rather than assumed**: a task with `blockedByCount` 1 was closed by
  the operator's `PATCH` and a second one by a run's `complete_task`, both
  reaching `done`. What this did not touch is a real CLI — no model has called
  the tool over stdio, which is the standing item below.

- **The dependency drawing on both pages, in a real browser, 2026-09-12**: the
  half the entry above says it does not cover. The branch's own
  `.next/standalone/server.js` — the artifact the container ships — against a
  throwaway `DATA_DIR` and a `CLAUDE_BIN` that cannot spawn, seeded through
  `src/lib` with eight tasks across two projects and six edges forming a chain
  three deep with a fork at the end, driven with the container's Chromium at
  1280×1000 and 390×844. **Both widths: no console error, and
  `scrollWidth − clientWidth` measured 0 on the document at each.** On `/tasks`
  the line drew inside the Task cell under the title with no seventh column: a
  row with four edges read *Blocked by 2 tasks · blocks 2 tasks*, a row with one
  each read *After «title» · blocks «title»* with both titles as links, and the
  task with no edges drew nothing at all. On `/tasks/[id]` the graph laid out
  left to right with the arrows running from the task that happens first, the
  anchor haloed and reading *This task* in words, a cross-project neighbour
  naming `Main / RepoTwo` and the same-project ones naming nothing, and the
  second level present — from the `Migrate` anchor, `Draw the task dependency
  graph` was drawn two hops out through `Add the task_deps table`, with the edge
  between those two in the border tone and only the edges touching the anchor in
  the accent. **The form was pressed for real**, not reasoned about: adding
  through the picker wrote the edge, answered *Recorded: this task now waits for
  it*, redrew the graph with the new node in it and cleared the picker; asking
  for a loop was refused with `taskDepRefusal`'s own sentence rendered whole —
  *That would make a loop: “Add the task_deps table and its index” → “Migrate the
  schema for task orderings” → “Draw the task dependency graph” → “Add the
  task_deps table and its index”…* — with the picker's choice deliberately left
  standing; and Remove took the edge away and left the empty state. A task with
  no edges drew that empty state rather than an empty canvas. The 400 from the
  refused write is the only console entry either page produced. Caveats: one
  browser engine; the **default** skin here, with the ascii skin measured
  separately below; the clipped-graph notice and the failed-neighbour notice
  were not reproduced in the browser — both need more than `MAX_TASK_DEP_LINKS`
  edges or an aborted request, and what covers them is
  `taskDepGraph.test.ts`'s `clipped` assertions and the absent-neighbour case
  rather than a rendered screen.

- **The dependency pane under `data-skin="ascii"`, 2026-09-12.** The skin the
  2026-09-11 `/branches` defect was found under, and the one this pane has most
  to lose to: a `Badge` sits inside an absolutely positioned **fixed-height**
  node box, so a badge that grew to three lines there would overflow rather than
  reflow. Set through `localStorage["uf-skin"]` so `layout.tsx`'s blocking script
  puts it on the element before anything hydrates, against the same standalone
  bundle and seed as the entry above. **14 of 14 badges on one line at both
  1280px and 390px**, measured as a bounding box against 2.2× the computed font
  size rather than judged by eye; no console error, no sideways scroll; the
  graph, the two lists and the form all drew. Caveat: the default and ascii
  skins only, and one browser engine.

- **The whole gate for the drawing, 2026-09-12**, on the worktree mount:
  `NODE_ENV=development npm ci --include=dev` exit 0; `npm run typecheck` exit
  0; `npm test` **2680 tests, 2680 pass, 0 fail**; `env -u
  __NEXT_PRIVATE_STANDALONE_CONFIG npm run build` exit 0 with `.next/standalone`
  written; `npm run smoke-pages` served `.next/standalone/server.js` rather than
  the `next start` fallback and reported **44/44 page loads clean, 0 of 22 pages
  failing at either width**. The 26 tests over 2654 are `taskDepGraph.test.ts`
  and they are the bar `docs/agent/testing.md` records rather than a convention
  followed: `taskNeighbourhoodGraph` is a pure function whose every failure mode
  draws a plausible picture — an arrow reversed is a readable graph of the
  opposite ordering, a second level expanded the wrong way reads as a
  neighbourhood, and none of them throws or fails a typecheck.

- **The dependency pane's request count, before and after, 2026-09-14.** One
  seeded database read by two builds of the same worktree, so the ids — and
  therefore the layout — are the same in both. The anchor sits at
  `MAX_TASK_DEP_LINKS` on **both** lists (ten dependencies and ten dependents)
  with one task further out on each side, which is 41 nodes and 40 edges drawn.
  **Before: 20 requests on mount**, one `GET /api/tasks/<neighbour>/deps` per
  level-one neighbour, at both 1280px and 390px. **After: 1**, a single
  `GET /api/tasks/<anchor>/deps?depth=2`. The drawing is unchanged and that was
  measured rather than argued: the node list — titles, absolute `left`/`top`, and
  the sheet's own width and height — hashes identically across the two builds
  (`1803062a51df591e`), and so does the set of 40 SVG path `d` strings
  (`5d71c1973efcf5b6`). The **ordered** path hash first diverged, because the new
  `beyond` arrived in database order where it had arrived sorted; sorting the
  reply's keys brought it back to `e4d7e610958c5a8f`, identical to before, so the
  emitted DOM matches element for element. No console error at either width. The
  three other states were checked on the same build: a task with no edges makes
  **no** request and draws the empty state; a task with one edge makes one and
  draws two nodes; and the read aborted in the page draws *the tasks beyond this
  one could not be read* with the immediate neighbours still on the graph.
  Caveat: one browser engine, and the default skin only.

## Not yet verified by hand

- **The graph at a size no hand-drawn ordering reaches.** Every reading above is
  against eight tasks. `autoLayout` is bounded by the block count rather than run
  to a fixed point, so it terminates, but nothing has measured what the sheet
  costs at, say, the `MAX_TASK_DEP_LINKS` cap on both lists with every neighbour
  expanded — 21 nodes, absolutely positioned, with an SVG over them. What would
  settle it: seed one task with ten dependencies and ten dependents, give each of
  those ten of its own, and time the first paint of `/tasks/[id]`.

- **`add_task_dependency` has never been called by a model**, which is the
  dependency half of the item above and has the same cost: it needs a billed
  run. What is unmeasured is not the write — that was exercised through the
  route handler and through the tool surface in process on 2026-09-11 — but
  whether the descriptions do their job. The failure they are written against is
  a model drawing an edge and then treating it as a gate: stopping work on a
  task it holds, or reporting that a run cannot start. Settle it by giving a run
  a task that waits on an open one after `docker compose up --build`, and
  reading whether the cycle finishes the work it was given.

- **No dependency has been drawn on a board with a real backlog on it.**
  `MAX_TASK_DEP_LINKS` is 10 and the cap's direction — blocking dependencies
  first, done ones dropped — was measured only against a hand-built twelve in
  `taskDeps.test.ts`. Unknown is whether ten is the right number for a backlog
  somebody actually accumulated, and nothing yet has produced a row whose
  `dependsOnCount` exceeds `dependsOn.length` outside a fixture. Settle it by
  filing a real project's tasks and reading `GET /api/tasks`.

- **Nothing about dependencies has been drawn on screen.** This change is
  storage, a route and two tool surfaces; the board does not render an edge yet,
  and `docs/taskboard.md` describes the feature as it will read once it does.
  `npm run smoke-pages` was deliberately not re-run, because no page changed.
  Settle it with the run that draws it.
