# QoL / Small Feature Proposal

**The question:** which small improvements that an operator would notice are each worth one run? Each one has to be sized S or M and grounded in a `path:line`. And what bugs did the hunt for them find?

**The state:** open. Five hunts over five separate territories, all at `fee5efb`, wrote 72 items. This file assembles them at `db8692a`, whose `src/` and `docs/` are identical to `fee5efb` (`git diff --stat fee5efb HEAD -- src docs` prints nothing). Deduplication leaves **70 items**, and **none were dropped on verification**:

- 34 of the 70 were re-checked against source here, including every item in the top ten.
- One premise was corrected: R-1, where the new-run form's default cycle cap is 5, not 1.
- Two cross-file duplicates were merged. A third duplicate was only one half of C-6, so that half was folded into R-8 and C-6 keeps the rest.

**66 bugs are on the board from this work**: 61 filed by the hunts, and five filed by this assembly from the hunts' "Seen outside my territory" notes. Four of those five are `high`. **Nothing here is a decision and no product code changed.**

## The recommendation

**Build the top ten as six runs**, in the order given in [07-recommendation.md](07-recommendation.md). All ten are size S, all ten are verified at `db8692a`, and none needs a migration. Two ordering constraints come from bugs on the board:

- G-3 is best landed after `a9ec4551`.
- The fleet pick-up changes (R-2, R-3) should follow `b403b8b4`, filed here, so that making the bulk pick-up easier to press does not also make it easier to start a once-waiting run in the operator's own folder.

**If only one change is made:** R-2. As it stands, the fleet pick-up sheet removes every picked-up run's spending cap on a press that never touched the spending field. The field starts blank (`src/components/FleetControls.tsx:56`), blank goes on the wire as `null` (`:194-197`), and the wire is spread over each run's stored budget (`src/lib/fleet.ts:274`, `{ ...stored, ...wire }`). The field's hint does say "Blank switches it off" (`FleetControls.tsx:222`). But the blank is the default, and the sheet exists for the twenty-five-run case.

**The fact that would re-order this list** is how this install's runs are started: `SELECT origin, COUNT(*) FROM runs GROUP BY origin`. It cannot be read from a work cycle, because `/data` is denied. [07-recommendation.md](07-recommendation.md) says which items move and in which direction.

## Files

| File | What it holds |
|---|---|
| [01-runs.md](01-runs.md) | Hunt 1/5, starting runs, the run loop and the run page: R-1 to R-12, 12 bugs filed |
| [02-chat-and-board.md](02-chat-and-board.md) | Hunt 2/5, the orchestrator chat, proposals, the taskboard and MCP: C-1 to C-16, 13 bugs filed |
| [03-workflows.md](03-workflows.md) | Hunt 3/5, workflows, schedules and run dependencies: W-1 to W-15, 12 bugs filed |
| [04-branches-and-landing.md](04-branches-and-landing.md) | Hunt 4/5, branches, landing, review, and the touched and conflict maps: G-1 to G-15, 12 bugs filed |
| [05-usage-settings-knowledge.md](05-usage-settings-knowledge.md) | Hunt 5/5, usage and the dashboard, settings, knowledge and dreaming, and the shell: U-1 to U-14, 12 bugs filed |
| [06-register.md](06-register.md) | Every surviving item, deduplicated and ranked with S before M; what was merged or dropped; the 66 filed bugs in one table; every "Too big" line; and every "Seen outside my territory" note with what became of it |
| [07-recommendation.md](07-recommendation.md) | The build order for the top ten: which items share a run, what must go first, and the fact that would re-order it |

The five area files are as the hunts wrote them. Each was merged from its own branch with `git merge --no-edit`. None of the five branches carried a commit outside `proposals/QoLSmallFeatures/`, so nothing had to be copied by hand.

## Top ten

The ten are ranked by value against size. All ten are S, so the order is by value and then by how many operators meet the friction. Every `path:line` here was re-read at `db8692a`.

| # | ID | Title | Size | Value | Why |
|---|---|---|---|---|---|
| 1 | R-2 | Fleet pick-up sheet: keep each run's own spending cap, and seed a cycle cap the runs can pass | S | high | The untouched blank field sends `maxRunCostUSD: null`, which `{ ...stored, ...wire }` writes over every run's cap (`src/lib/fleet.ts:274`). The default `"1"` cycle cap (`FleetControls.tsx:55`) is refused for any run that has used a cycle (`orchestrator.ts:11800`) |
| 2 | G-1 | Name the paths when Land refuses a dirty checkout | S | high | `checkoutStateOf` runs `git status --porcelain` and keeps only a boolean (`src/lib/land.ts:424-433`). The refusal then says "commit or stash" with no file named (`:1040-1041`). `DIRT_NAMED` already names three paths for the resolution checkout (`:1332`, `:1401-1404`) |
| 3 | R-4 + W-1 | A run's page links to the workflow run (or other origin) that started it | S | high | The origin line is plain `fmtRunOrigin(run.origin)` (`src/app/runs/[id]/page.tsx:1330`). The page has no `/workflows/` link at all (`grep -c "/workflows/"` gives 0), and nothing in `src/app` or `src/components` reads `origin_ref` |
| 4 | C-1 | A decided proposal card says what its run did | S | high | A decided row draws the proposal's own badge and a link (`src/app/chat/page.tsx:2651-2676`). The DTO carries `runId` and nothing about the run (`src/app/api/chat/dto.ts:268-290`), while the model's own `list_past_proposals` gets `run.status` (`src/app/api/mcp/route.ts:2807-2833`, per the hunt) |
| 5 | C-10 | Warn before an unsaved task brief or note is thrown away | S | high | Neither `TaskEditor.tsx` nor `TaskThread.tsx` calls `registerLeaveGuard` or registers `beforeunload`. The guard exists (`src/lib/unsavedWork.ts:36`) and the workflow editor uses it. Hunts 2 and 5 found this independently |
| 6 | C-8 | Show the status of the run that holds a claim | S | high | `taskboard.md` rests its no-lease design on the holder's status being "on the same screen", but the board and the task page draw a bare short id (`src/app/tasks/page.tsx:214-223`, `src/app/tasks/[id]/page.tsx:54-63`) |
| 7 | W-2 | The instance page says each wait's condition, not only who it waits for | S | high | `instanceDTO` keeps `edge.from` and drops `edge.edge` (`src/app/api/workflows/dto.ts:87-95`), so "after Build" never says "only if it completes" or "either way" |
| 8 | R-1 | Resume pre-fills a raised limit when the stored one is already reached | S | medium-high | `openReopen` copies the stored caps verbatim (`src/app/runs/[id]/page.tsx:1153-1158`). `reopenRun` refuses any cap at or below what was used (`src/lib/orchestrator.ts:11800-11812`). So every run that stopped on its own limit is refused on the sheet's first press |
| 9 | C-11 | The dependency picker offers open and claimed tasks, not one page of everything | S | high | It asks `/api/tasks?limit=${MAX_TASK_PAGE}` across every status (`src/components/TaskDependencies.tsx:226`). That is the single page the board itself stopped using when Done rows crowded out Open ones (`taskboard.md:474-481`, per the hunt) |
| 10 | G-3 | Delete every merged branch on the page in one press | S | high | Delete is one press per row (`src/app/branches/page.tsx:1600`), and the page's tick boxes exist only for landing. Findability counted 141 branches in one repository. Best after `a9ec4551` |

Next in line are U-9 (link a dreaming note from its pane; high by the hunt's measure, but dreaming is off by default, `src/lib/settings.ts:1066`) and three medium-high items: R-10, W-4 and W-5. The full ranking is in [06-register.md](06-register.md).

## Hunts present, missing or partial

**All five hunts are present, and none stopped part-way.** Each file has every section the brief asked for. Hunt 5's "Too big for this list" says "None found that could be grounded", which is an answer, not a gap.

Each hunt listed what it did not cover, and those gaps stand:

- **Hunt 1:** `createRun`'s install-ceiling door, the codex argv, and the isolation and permission rows of the new-run form.
- **Hunt 2:** accessibility and narrow viewports.
- **Hunt 3:** `/workflows/new` as distinct from edit, and the merge block past `retryMergeBlock`.
- **Hunt 4:** the canvases, which it read for bugs only.
- **Hunt 5:** OTLP ingest, `LiveTelemetry`, and the DST-at-midnight case.

No hunt opened a browser, so every UI claim in all five files is read from source.

Two counts differ from the brief:

- Hunt 2 filed thirteen bugs against a cap of twelve and says so (`02-chat-and-board.md:175`).
- Only hunt 5 ran `npm run typecheck` and `npm test` (3067 of 3067 at `fee5efb`). The other four left `src/` untouched and say they did not run them.
