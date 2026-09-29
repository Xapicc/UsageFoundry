# Register

This file lists every item that survived assembly. They are deduplicated across the five area files and ranked by value against size: S items first, then S–M, then M, and within each size by value. The "From" column names the file that holds the item's full friction, change, touches and not-worth-it-if, so read that file before building anything.

The "Checked here" column says whether this assembly re-read the item's evidence at `db8692a`, whose `src/` and `docs/` are identical to `fee5efb`, where the hunts ran. "yes" is followed by what was read or run. "—" means the item rests on its hunt's evidence alone. Nothing marked "—" was found to be wrong. It was simply not re-read.

Two values differ from the hunts' own:

- **R-1** is lowered from high to medium-high. Its premise, "`maxIterations` defaults to 1", quotes `docs/agent/run-lifecycle/reopen-and-resume.md`'s *"a reopened run carries one message"* paragraph. That holds for `narrowGuards` (`src/lib/settings.ts:1277-1279`) and for workflow blocks. It does not hold for the new-run form, which defaults to 5 (`src/app/runs/new/page.tsx:215`), or for chat guards, which default to 4 (`src/lib/settings.ts:988`). The friction is real for every run that stopped on its own limit, but not for "the ordinary pick-up of the default run, every time".
- **U-9** keeps its hunt's "high", with a caveat: dreaming is off by default (`src/lib/settings.ts:1066`).

## S

| # | ID | Title | Value | From | Checked here | Notes |
|---|---|---|---|---|---|---|
| 1 | R-2 | Fleet pick-up sheet keeps each run's spending cap and seeds a passable cycle cap | high | 01 | yes: `FleetControls.tsx:55-56`, `:191-196`, `:222`; `fleet.ts:274` spreads `{ ...stored, ...wire }`, which settles the hunt's open assumption about an absent key | Top ten. Same run as R-3. Goes after `b403b8b4` |
| 2 | G-1 | Name the paths when Land refuses a dirty checkout | high | 04 | yes: `land.ts:423-435` keeps a boolean; `:1040-1041`; `DIRT_NAMED` at `:1332` | Top ten. Goes before G-2. `landRefusal` needs a new test case |
| 3 | R-4 + W-1 | A run's page links to the workflow run (or other origin) that started it | high | 01, 03 | yes: `runs/[id]/page.tsx:1330`; `grep -c "/workflows/"` gives 0; `origin_ref` is read nowhere in `src/app` or `src/components` | Top ten. **Merged from R-4 and W-1.** W-1's route is the one to take: `origin_ref` holds a node id for some origins (`workflows.ts:4887-4888`, per W-1), so resolve through `workflow_instance_runs`, indexed at `db.ts:901`. The schedule and chat halves of R-4 make it S–M |
| 4 | C-1 | A decided proposal card says what its run did | high | 02 | yes: `chat/page.tsx:2651-2676`; `chat/dto.ts:268-290` has `runId` and no run field | Top ten. One batched query per poll (`docs/agent/chat/chat-api-and-poll.md`'s *"the poll asks for the messages it does not have"* paragraph). Same run as C-6 |
| 5 | C-10 | Warn before an unsaved task brief or note is thrown away | high | 02 (and 05, outside note) | yes: no `registerLeaveGuard` or `beforeunload` in `TaskEditor.tsx` or `TaskThread.tsx`; `autoFocus` at `TaskEditor.tsx:210`; `unsavedWork.ts:36` exists | Top ten. **Merged with 05's "Seen outside my territory" note** on the same missing guard. Its "send only changed fields" part goes before C-15 |
| 6 | C-8 | Show the status of the run that holds a claim | high | 02 | yes: `tasks/page.tsx:214-223` and `tasks/[id]/page.tsx:54-63` draw a short id only; no holder status on the DTO | Top ten |
| 7 | W-2 | The instance page says each wait's condition | high | 03 | yes: `workflows/dto.ts:87-95` keeps `edge.from` and drops `edge.edge` | Top ten. Same run as W-3 |
| 8 | R-1 | Resume pre-fills a raised limit when the stored one is already reached | medium-high (hunt: high) | 01 | yes: `runs/[id]/page.tsx:1153-1158`; `orchestrator.ts:11800-11812`; premise corrected above | Top ten. Same run as R-2 and R-3, sharing one pure `reachedLimits` helper |
| 9 | C-11 | The dependency picker offers open and claimed tasks | high | 02 | yes: `TaskDependencies.tsx:226` asks one unfiltered page | Top ten |
| 10 | G-3 | Delete every merged branch on the page in one press | high | 04 | yes: per-row Delete at `branches/page.tsx:1600`; no bulk delete in the file | Top ten. Best after `a9ec4551`. Less needed if G-5 lands |
| 11 | U-9 | Dreaming: open a written note from the pane | high (off by default) | 05 | yes: `dreaming/page.tsx:389` draws the path as plain `<code>`; `noteHref` at `knowledge/page.tsx:91` | Same run as U-10 and U-11 |
| 12 | R-10 | The context panel says why an over-ceiling run was not cut | medium-high | 01 | — | Only matters with pruning on. Select on `outcome`, not on `trigger` |
| 13 | W-4 | "Cannot be started again" links the live run, and Run says so before the press | medium-high | 03 | — | |
| 14 | W-5 | The install-wide pause is stated on the workflow pages | medium-high | 03 | yes: `grep -rln newWorkPaused src/app src/components` finds only `api/usage/route.ts`, `page.tsx` and `FleetControls.tsx` | |
| 15 | R-3 | The pick-up sheet lists the runs it will pick up | medium | 01 | — | Same run as R-2 |
| 16 | R-5 | Say when a run finished, how long it worked and how long it waited | medium | 01 | yes: `pause_count` is read nowhere in `src/app` or `src/components` | Read `MAX_PAUSES_PER_RUN`. Watch `8ef928a2` |
| 17 | R-6 | List queued runs in start order, with their priority | medium | 01 | yes: `runs/page.tsx:806-810` sorts by `ACTIVE_ORDER` only; `grep -c priority` on that file gives 0 | Move `queueCompare` to a shared module rather than copying it |
| 18 | R-8 | `/runs/new?template=<id>` opens the form with a template applied | medium | 01, 02 (C-6's template half) | — | **Merged from R-8 and the template half of C-6.** Goes before C-9, which adds a parameter the same way |
| 19 | C-4 | The browser tab says when a turn has landed or a question is waiting | medium | 02 | yes: `grep -rn document.title src` finds nothing | It would be the first page to set a title |
| 20 | C-5 | Keep the composer's draft per thread, and do not overwrite it | medium | 02 | — | Closes the rest of ChatPanelExperience C7 |
| 21 | C-6 | A proposal card's task links to the task | medium | 02 | — | The template half moved to R-8. Same run as C-1 |
| 22 | C-7 | Name the open thread on the page, from its first message | medium | 02 | yes: the heading is the literal "Orchestrator" (`chat/page.tsx:1039`) | S; M with rename. Rewrites `docs/agent/chat/chat-api-and-poll.md`'s *"`GET /api/chat` answers two different questions"* paragraph |
| 23 | C-12 | Keep the board's project filter, and file new tasks into it | medium | 02 | — | Same run as C-15 |
| 24 | C-14 | Show what was filed while working a task | medium | 02 | yes: `grep -ci parent src/app/api/tasks/route.ts` gives 0 | |
| 25 | C-15 | Change a task's priority from its board row | medium | 02 | — | After C-10's changed-fields Save |
| 26 | C-16 | Let the orchestrator's replies link to the app's own pages | medium | 02 | yes: `safeHref` admits only `http`, `https` and `mailto` (`Markdown.tsx:551-556`) | Security-adjacent: it widens the link allowlist, so it needs review |
| 27 | W-3 | The instance page states its outcome, and stops polling once it can no longer move | medium | 03 | — | Same run as W-2 and W-12 (shared `OUTCOME_LABEL`) |
| 28 | W-6 | The schedule card states the next start in the schedule's own zone | medium | 03 | — | |
| 29 | W-8 | Duplicate a block in the editor | medium | 03 | yes: `grep -ci duplicate WorkflowEditor.tsx` gives 0 | |
| 30 | W-9 | A block name opens the editor with that block selected | medium | 03 | yes: no `searchParams` in `WorkflowEditor.tsx` or `workflows/[id]/edit/page.tsx` | |
| 31 | W-11 | The editor's errors are shown where the operator is looking | medium | 03 | — | |
| 32 | W-13 | The history table says who started each press and what it spent | medium | 03 | yes: no `origin` on the instance DTO (`apiTypes.ts:2400-2420`) | The origin half goes after `1a90c468` |
| 33 | W-14 | The loop card says what its cost limit is measured on | medium | 03 | — | The guard figure stays unrendered |
| 34 | G-2 | Let untracked files through Land | medium | 04 | — | **Goes after `a8a0bd95` and G-1.** It changes the recorded rule "the operator's checkout must be clean", so it is a decision, not a tweak |
| 35 | G-4 | Say which run a retired checkout belongs to, and link to it | medium | 04 | — | |
| 36 | G-7 | Open every file of a diff at once | medium | 04 | — | Same run as G-10 (shared `defaultOpen` re-key) |
| 37 | G-8 | The Land card says a verify command will run first, and which | medium | 04 | — | Same run as G-9 |
| 38 | G-10 | Jump from a touched file to its patch | medium | 04 | — | After `1c04d1ea` |
| 39 | G-11 | Mark a review that no longer matches the branch | medium | 04 | yes: `review.ts:296-312` passes neither `baseSha` nor `headSha` | |
| 40 | G-12 | Show what a failed resolution said | medium | 04 | yes: `resolution.text` is drawn only for `completed` (`RunLand.tsx:536`) | |
| 41 | G-13 | Show how long a queued merge has been going, and what it was authorised to do | medium | 04 | yes: `grep -c startedAt branches/page.tsx` gives 0 | Same run as G-14 and G-15 |
| 42 | G-14 | Say which workflow block queued a batch before offering to cancel it | medium | 04 | — | Same run as G-13 |
| 43 | G-15 | Re-queue a batch's failed and skipped rows in one press | medium | 04 | — | Same run as G-13. Less needed once `f3a2f4f6` and 04's unfiled item 1 are fixed |
| 44 | U-2 | Say "no window open" instead of a countdown that moves with the clock | medium | 05 | — | Same run as U-3 and U-4 |
| 45 | U-3 | Show each per-model weekly wall's own reset | medium | 05 | yes: the per-model line prints a label and a percentage only (`src/app/page.tsx:852-861`) | With or after `9202c8f2` |
| 46 | U-4 | Refetch the provider reading once an instant it named has passed | medium | 05 | — | Measure one rollover first |
| 47 | U-7 | Settings: take the operator to the field a Save was refused over | medium | 05 | — | |
| 48 | U-10 | Dreaming: show how each night's run actually ended | medium | 05 | yes: the `wrote` badge is on every `selected` night (`dreaming/page.tsx:461`) | Same run as U-9 |
| 49 | U-11 | Dreaming: mark which recurring signatures tonight's pass will hand the run | medium | 05 | — | Same run as U-9 |
| 50 | U-12 | Knowledge: make frontmatter wikilinks clickable in the reader | medium | 05 | — | It bends the "shown as it was written" rule |
| 51 | U-13 | Quick open: let a result open in a new tab | medium | 05 | yes: rows are `<div role="option" onClick>` (`QuickOpen.tsx:372-377`) | Check VoiceOver before landing |
| 52 | W-10 | ⌘↩ saves the workflow editor | low-medium | 03 | yes: `grep -c isCommitChord WorkflowEditor.tsx` gives 0 | |
| 53 | W-15 | The schedule card says a schedule would be refused before offering the form | low-medium | 03 | — | |
| 54 | G-6 | Show when and how a branch was landed on the branches table | low | 04 | yes: `grep -c landedAt branches/page.tsx` gives 0 | |

## S–M

| # | ID | Title | Value | From | Checked here | Notes |
|---|---|---|---|---|---|---|
| 55 | R-7 | Filter the runs list by origin | medium | 01 | yes: `grep -c origin src/app/runs/page.tsx` gives 0 | Refuse an unknown `?origin=` rather than dropping it |
| 56 | R-9 | The agent delete sheet names what still refers to the agent | medium | 01 | — | |
| 57 | R-11 | The work-cycle meter shows refunded and granted cycles | medium | 01 | — | **Blocked** by `c1dc14cf` and `55ee6a0a`. Display only |
| 58 | G-9 | Run the land check on a branch without landing it | medium | 04 | — | After `0a3278ff`. It is a new door that runs agent-written code, so it needs a security review |
| 59 | U-8 | Storage card: "Sweep now", and when the next sweep is due | medium | 05 | — | A destructive action, so it goes through a `Sheet` |

## M

| # | ID | Title | Value | From | Checked here | Notes |
|---|---|---|---|---|---|---|
| 60 | C-9 | Start a run from a task, linked to it | high | 02 | — | After R-8. `taskIds` go *into* `createRun`, never after it (`docs/agent/taskboard/runs-from-tasks.md`'s *"the links have to be written before the run can be promoted"* paragraph) |
| 61 | C-2 | Say on the chat page that another thread is waiting on the operator | high | 02 | — | Proposals and questions stay two counts (`docs/agent/chat/operator-questions.md`'s *"a chat waiting on an answer is drawn as waiting"* paragraph) |
| 62 | U-5 | Settings: send only what changed | high | 05 | — | It bends `metering.md`'s default-agent decision and has to argue with that decision's reasoning. `modelCatalogue` joins `EDITABLE_PATHS` first |
| 63 | G-5 | Stop listing deleted branches as rows for ever | high | 04 | — | Migration (`runs.branch_removed_at`). Pager counts go over the filtered set |
| 64 | U-1 | Project exhaustion from Anthropic's own reading on a stock install | high | 05 | — | Same run as `8b47ae9a` |
| 65 | U-6 | Settings: name the shipped value on a field that has moved, and offer it back | medium-high | 05 | — | Defaults travel on the GET |
| 66 | C-13 + U-14 | `q=` on `GET /api/tasks`: a search box on the board, and tasks in quick open | medium | 02, 05 | yes: `src/app/api/tasks/route.ts` reads no `q` | **Merged from C-13 and U-14.** One route change with two consumers. A search that matched nothing must not draw the empty-board card |
| 67 | C-3 | Reject with a reason the chat can read | medium | 02 | yes: `chat.ts:2062` sets `status` and `decided_at` only | S for the version that only fills the composer |
| 68 | W-7 | A failed deciding block can be picked up | medium | 03 | — | The hunt did not confirm that the doc allows it |
| 69 | W-12 | The workflows list shows how the last press ended, and links it | medium | 03 | yes: "Last run" is a bare `fmtDateTime(w.lastRunAt)` (`workflows/page.tsx:164`) | |
| 70 | R-12 | Page back through the part of a long log the replay cut | medium | 01 | yes: `src/app/api/runs/[id]/` has no `events` route | |

## Merged and dropped

**Merged (two items became one each, 72 → 70):**
- **R-4 + W-1.** Both say the run page cannot reach the workflow run that started it. The register keeps W-1's resolution path.
- **C-13 + U-14.** Both need `q=` on `GET /api/tasks`. One is a board search box and the other a quick-open source.

**Folded without a count change:**
- **The template half of C-6 went into R-8.** It is the same missing `?template=` on `/runs/new`. C-6 keeps the task link.
- **05's "Seen outside my territory" note on `TaskEditor`'s missing leave guard went into C-10.** It was a note, not an item.

**Dropped on verification: none.** 34 items were re-read at `db8692a` (the "yes" rows above), including all of the top ten. Every one held. R-1's premise was partly wrong (see the top of this file). Its friction held, so it was re-valued rather than dropped.

**Dropped by the hunts themselves.** Hunt 3 considered and refused ten more, with its reasons, in `03-workflows.md:125`. They are not carried here.

## Bugs filed

There are 66 tasks: 61 filed by the hunts and 5 filed by this assembly. The 5 come from "Seen outside my territory" notes that no open task covered, and each was confirmed from source at `db8692a`. Hunt 2's thirteenth task is one over its cap, and the hunt says so.

| Title | Priority | Task id | Source |
|---|---|---|---|
| Picking up a run that was stopped or failed while waiting starts it in the operator's own folder, without its checkout or its dependencies | high | `b403b8b4-9dea-4895-ab14-da0c2564084a` | this assembly, from 03's outside note |
| Boot stops every waiting run as if its dependency was closed out, even when that dependency was kept paused or had completed | high | `d2c5ecb6-fc8f-4783-86db-3fc4e7d7274b` | this assembly, from 03's outside note |
| A run's spend adds each resumed work cycle's cumulative total_cost_usd, over-counting spent_usd and the cost guard | high | `277a1969-28d2-4898-abc5-304da439edec` | this assembly, from 02's outside note |
| Paused sweeper writes stopped over a run the operator resumed or stopped during its usage scan | high | `7bf1a4e1-a79f-427a-8760-e0dc75332aff` | this assembly, from 03's outside note |
| Merge queue records a branch already on its target as a failed landing, failing a workflow merge block and stopping its loop | normal | `f3a2f4f6-90a6-4b1e-8479-117896e6c783` | this assembly, from 04's outside note and unfiled item 1(c) |
| Saving a run template skips the form's blank-limit check, storing "on but blank" as no limit | normal | `01cc1ab9-2cbd-4566-8cf9-469aa126d69a` | 01-runs.md |
| Run form warns a window guard will be refused when the provider's percentage makes it work | normal | `0821945e-04eb-4fce-943b-59ed01839e25` | 01-runs.md |
| "Start another like this" drops isolation for never-released runs and can strand the workspace picker | normal | `0d0810d9-7357-4885-bb56-c7836a6e9993` | 01-runs.md |
| Validator's extra work cycle never runs: pre-cycle guard stops the run at the cycle cap | high | `c1dc14cf-ed4a-48e3-838c-bf6162b0a8e7` | 01-runs.md |
| Live guard tick can stop a run using a finished cycle's guard, double-counting its spend | high | `73d5c74a-0349-4db7-928c-343abec20413` | 01-runs.md |
| Refusal-park allowance is charged for guard parks and never reset by a pick-up | normal | `8ef928a2-ae55-42e8-9a9e-f4a5cad3eb95` | 01-runs.md |
| Live-resume refund of a guard-cut cycle is unbounded, so maxIterations never ends the run | high | `6e6736b7-889b-421d-a1de-e3d395119ac1` | 01-runs.md |
| MAX_EARLY_ENDS_PER_RUN resets on every park, restart and pick-up, so the refund cap is per segment | normal | `55ee6a0a-990f-4f65-a86a-e11e65b542b3` | 01-runs.md |
| A run cut off by a graceful shutdown is picked up without RESTART_KILLED_NOTICE | high | `4ae8348f-1a4e-47cf-be17-363f2ba10c90` | 01-runs.md |
| /runs "In flight" band drops running runs older than the newest 100 rows | normal | `f5f3bd0f-75a3-46b6-b567-1013068e9ae7` | 01-runs.md |
| Paused-run card says the run holds its folder and names the wrong reason for a provider-refusal park | normal | `22610d48-3207-4430-b075-894754032680` | 01-runs.md |
| Context ceiling ignores a run for 25k tokens past its pre-cut reading after a boundary cut or fresh start | normal | `4b221595-a4fc-4379-8384-55d3208aa076` | 01-runs.md |
| A resumed chat turn's cumulative total_cost_usd is banked as that turn's cost | high | `d2782026-77dc-4893-8198-8aae0d7b4cfb` | 02-chat-and-board.md |
| Chat stream counts one response's usage once per content block, inflating the live guard estimate | high | `11cf59df-b4ad-479b-99af-3a817ce9cd28` | 02-chat-and-board.md |
| list_tasks narrowed by mountId+folder always returns zero: relative folder compared to stored absolute path | high | `9c4cbf8a-443d-4d8c-82d7-dafdcd6fabc5` | 02-chat-and-board.md |
| Validation boundary reads the run's newest verdict, so a not-finished task is ignored once another task is checked | high | `d82e9d21-50e6-456c-8878-c655c19c523f` | 02-chat-and-board.md |
| Chat turn capability stays live after Stop and after a spawn that throws | normal | `b8305935-b642-4681-91ba-7f1cc3eb6915` | 02-chat-and-board.md |
| A dependsOn that is not an array is read as "no dependency" by propose_run, propose_workflow and emit_runs | normal | `a680431f-1cf0-4eb4-921d-a06b0561bcfd` | 02-chat-and-board.md |
| propose_run reads an omitted folder as the mount root, and drops a folder sent without mountId | normal | `95dbb1ee-439b-498d-b3a7-7fbbc7391089` | 02-chat-and-board.md |
| A server restart during a completion check leaves the task claimed for good | normal | `382b15b1-a454-4c22-9b4e-e996b7843156` | 02-chat-and-board.md |
| Validator's verdict parser drops an unfenced verdict whenever the reply quotes any fenced JSON | normal | `d5e28b71-e37c-4b9d-b596-783e2604829b` | 02-chat-and-board.md |
| Task editor draws "not in the workspace scan" while /api/folders is loading or after it failed | normal | `94ea8ea8-f273-44eb-a6c1-70d98985925a` | 02-chat-and-board.md |
| A task write that changes nothing still bumps updated_at, reordering the board on every run pick-up | low | `dc9b8f02-3658-4c2f-a0b3-690bdb3bee2f` | 02-chat-and-board.md |
| A JSON null body crashes the chat, task-dependency and MCP routes with a 500 | low | `441c43b5-d962-4990-a70c-9e6105f2f183` | 02-chat-and-board.md |
| A validation records the run's branch name as head_sha, so the verdict names no commit | low | `27ad4238-d6b7-4975-bb51-d5f66c837e29` | 02-chat-and-board.md |
| A loop whose board can't be counted is failed mid-pass, stranding the pass and releasing the block behind it early | high | `9e6f6a52-cacd-47e8-b729-7d6f237db8a0` | 03-workflows.md |
| A scheduled workflow's later blocks are recorded as started by a press of Run | normal | `1a90c468-dea2-4894-9cd9-a8dd094363f8` | 03-workflows.md |
| Duplicate workflow fails for a name near the 80-character limit | normal | `c8e68403-0b56-4da4-a1ce-7fd075c1129a` | 03-workflows.md |
| Editor mints section links that carry a branch the server refuses, with no control to undo it | normal | `6dad185c-b5d9-45e4-9652-69cad5037626` | 03-workflows.md |
| In-section link panel calls an "either way" link refused, and its redraw advice silently changes it to on-success | normal | `ae6e12b7-2429-4cef-b2f9-cbb2a8bfcda9` | 03-workflows.md |
| Editor's worst-case run count for a loop leaves out each orchestrator turn that Save counts | normal | `4b22a720-4f59-42ed-b2b4-94fb937e4034` | 03-workflows.md |
| Schedule tick starts a workflow the operator paused, removed or changed during the fire | high | `6a78f187-2c43-450f-8930-b1d2a8d7a4e2` | 03-workflows.md |
| Schedule PATCH resumes a paused schedule for any paused value that is not literally true | normal | `2d00098f-a52a-49a8-ba95-5fc8b295bdcc` | 03-workflows.md |
| Schedule input coerces hours, weekday and zone instead of refusing them | low | `83a5eeba-cc3f-4b85-8f47-1b998dacce9d` | 03-workflows.md |
| Orchestrator block whose emitted runs all failed to start is reported as having decided nothing | low | `dda964d2-62c1-4a75-a32c-a0eb7c95a5c5` | 03-workflows.md |
| Reviving a blocked dependent leaves it waiting even when another dependency still fails it | low | `cd3ae5a5-ce4b-4748-a685-53b72137ab7d` | 03-workflows.md |
| A workflow run stopped by "Stop everything" reads back as stopped by you alone | low | `d6c6bd40-450d-463c-9d1b-0f3cd9ff0096` | 03-workflows.md |
| Land merges into a checkout it last read before a 15-minute verify command, and a squash unwind then wipes uncommitted edits | high | `a8a0bd95-a2f4-424e-920d-90af96431a32` | 04-branches-and-landing.md |
| Land verify gate passes on uncommitted work that the land then leaves behind | normal | `0a3278ff-c134-4551-965f-e0cca9d87368` | 04-branches-and-landing.md |
| Delete branch refuses a merged branch whenever the operator's checkout is not on its target | normal | `a9ec4551-98a5-453e-95a3-d5885687ceea` | 04-branches-and-landing.md |
| Land card hides why Land is refused once a landed run's branch gains new commits | normal | `9083ce3a-6fd8-4741-8f53-487128bc70de` | 04-branches-and-landing.md |
| Branches page resets the chosen merge strategy on every inventory re-read, so a selection lands with the default | normal | `5b6e8305-4434-4cc4-8016-9a7055bba44b` | 04-branches-and-landing.md |
| After a conflict resolution, "What changed" and the review count the target's commits as the run's work | normal | `a7f6343d-cd3f-40bb-b75f-81d0d0599fcb` | 04-branches-and-landing.md |
| Files tab and touched map call every edited file "not changed" for runs without a committed branch diff | normal | `1c04d1ea-ce58-4f52-a409-0f3fd32ab8a0` | 04-branches-and-landing.md |
| One failed patch read blanks every file's contents in "What changed" and blames size without the shortened-diff notice | normal | `eb0c39de-4d14-4b40-bb45-bb2e9636849c` | 04-branches-and-landing.md |
| Commit on the Land card can write a conflict resolution's half-finished merge, markers included, onto the branch | high | `c3199f70-2b36-495f-a52a-08081bc3354e` | 04-branches-and-landing.md |
| Land verify command's 15-minute timeout does not end a hung check, so Land and Deliver wait for ever holding the folder | high | `d7a4a679-fb4a-44b5-bce0-2730113f42fb` | 04-branches-and-landing.md |
| Deliver pushes an active run's branch, crashes after pushing on a malformed body, and is offered twice for one pull request | normal | `ccbe1870-ca68-4573-a184-c7826fc392fd` | 04-branches-and-landing.md |
| Purge confirmation says "0 commits" when the commit count could not be taken | high | `2b1ade96-f732-4fab-8ade-54283e5b87b8` | 04-branches-and-landing.md |
| Exhaustion projection uses the typed ceiling while the meter shows Anthropic's percentage, so a 92% window reads "Not projected to run out" | high | `8b47ae9a-0cc5-4bbf-ae65-2bdec1753bd6` | 05-usage-settings-knowledge.md |
| Dashboard window card reads the raw provider reading: stale per-model walls, false "reported by Anthropic" reset, false "all-model" bar | normal | `9202c8f2-7ae2-4a9c-9f58-f1aa8145f6e5` | 05-usage-settings-knowledge.md |
| Calibrate's "Measured" ceiling divides new-window spend by a rolled-over or aged provider percentage | normal | `2f735b96-3c7d-4db7-b49b-fc0a6e500bf3` | 05-usage-settings-knowledge.md |
| Knowledge resolver reports a wikilink as broken when the note's name contains a dot | normal | `d0e67076-e557-477f-81db-dc7d063d7b70` | 05-usage-settings-knowledge.md |
| Knowledge note view's Backlinks list names and links the open note itself instead of the notes linking to it | normal | `785ab790-a603-464d-bace-e59cf8b073d5` | 05-usage-settings-knowledge.md |
| Dreaming scan keeps the old time zone's day keys after dreamingTimeZone changes, and can write a note for a one-day failure | normal | `668dd86e-085a-4d36-b421-0fb086edd98d` | 05-usage-settings-knowledge.md |
| Dreaming reconciler attaches a note path to the wrong signature once forgetNote has removed an earlier row of the same run | normal | `c56f4f92-7964-4323-a254-850c6409338f` | 05-usage-settings-knowledge.md |
| ReadOnlyNotice shows "Failed to fetch" as the read-only banner on any dropped poll, and stays silent when SQLite cannot write | normal | `6a33052a-bbe2-4284-a487-c1cbc5c20d7a` | 05-usage-settings-knowledge.md |
| RestartClosed never shows why runs were refused, and a failed pick-up removes its only button until reload | normal | `63ba6de7-3233-4a8d-9964-32524b040ebf` | 05-usage-settings-knowledge.md |
| Typing 0, a negative or a non-number into a Settings cap stores "no limit" instead of the promised floor or a refusal | high | `d4a1d4af-582b-4147-9be0-b6335ff56383` | 05-usage-settings-knowledge.md |
| Every Settings Save drops the cached provider usage reading, so a Save during a 429 spell leaves the window guards with nothing to read | high | `c42481ca-dbf7-4607-884a-6ec6b06a2e2b` | 05-usage-settings-knowledge.md |
| An enabled plugin whose manifest breaks or whose folder disappears cannot be switched off | normal | `37cd4945-3fe0-4680-b1cd-05d91cd0e465` | 05-usage-settings-knowledge.md |

The hunts' confirmed but unfiled bugs stay in each file's "Bugs not filed" section. They are not repeated here.

## Too big for this list

These are gathered from the five files. The reasons are given there.

- **01:** One install-wide stop that also reaches assist children (reviews, resolutions, chat turns, validations). It needs a stop path for assists first.
- **01:** A per-segment history of a run, where each pick-up, park and restart is a row with its own worked minutes and spend.
- **02:** Tell an operator who is not looking that the chat asked them something. It needs the webhook's closed, run-only field list reopened, and a per-thread URL.
- **02:** Bulk moves on the board. It needs a selection column, and `docs/agent/taskboard/board-page.md`'s *"the count goes inside a cell the board already has"* paragraph refuses a seventh column.
- **02:** Start a run from several tasks at once. This is C-9 plus the bulk selection.
- **03:** A per-edge "why did or did not this start" timeline across an instance. That is RunDecisionTree's `run_events`.
- **03:** Inputs at the press of Run. The run route reads no body, by design.
- **03:** A canvas layout that follows the operator across browsers. Refused: "where a block sits is not part of it".
- **04:** A door that reclaims a retired checkout that no run owns. It would discard ownerless uncommitted work.
- **04:** Pushing later commits to a pull request already opened. It reverses "offered once per pull request".
- **04:** A merge preview for every row of the branches table. Sixty `merge-tree` runs per read is a cost decision.
- **04:** Reading a conflicting file's content past the first ten on request. It bends the conflicts map's "adds no git call" rule.
- **05:** None found that could be grounded. The sidebar count badges are held as a question in `docs/agent/ui-density-audit.md`.

## Seen outside my territory

Each note was checked against the open tasks and against every "Bugs filed" line. `list_my_tasks` shows 20 of the 63 open tasks in this folder. The other 43 were read from the `create_task` inputs in this machine's UsageFoundry transcripts, which returned 183 tasks, every hunt's among them. A task filed by hand in the UI would not appear there, so a hand-filed duplicate is possible (assumed unlikely). Five notes were filed, which is the cap.

| From | Note | Outcome |
|---|---|---|
| 01 | `scripts/discord-relay.mjs:220`: the relay answers 204 before forwarding, so a dead Discord webhook still counts as delivered | Not filed. The comment at `scripts/discord-relay.mjs:217-219` makes this deliberate: "a slow Discord must not be able to turn a delivered notification into a lost one". What it costs (`consecutiveFailures` never rises for a dead webhook) is unstated there, which is a docs sentence, not a defect |
| 01 | `src/app/settings/page.tsx:3370`: the default-model hint puts the agent's model ahead of the default, but `createRun` applies the default first (`orchestrator.ts:3924`) | Not filed. Copy, low. Same root as 01's unfiled "new-run form's model copy misleads". Not re-read here |
| 02 | `src/lib/orchestrator.ts:9610`: run spend adds each resumed cycle's `total_cost_usd` | **Filed as `277a1969`** (high). The source was read, and one UsageFoundry run transcript was read whose `cost-state` climbs 8.415 → 10.34 → 11.97 across three work cycles. It contradicts the comment at `orchestrator.ts:7581-7585`, and the task says so |
| 02 | `src/lib/workflows.ts:740`: `planEmission` reads a non-array `dependsOn` as none | Covered by `a680431f`, which names it |
| 02 | `workflows.ts:388`, `schedules.ts:1149`: the approvers do not check that a proposal is still pending | Not filed. Low. It is half of 02's unfiled duplicate-ids bug, and only a direct API call reaches it |
| 02 | `src/lib/review.ts:239-247`: `reconcileReviewsOnBoot` fails a validate row and closes nothing | Covered by `382b15b1`, whose fix may land there |
| 02 | `src/lib/schedules.ts:172`: `Math.trunc(Number(o.hours))` coerces `true` and `[5]` | Covered by `83a5eeba`, which is about schedule input that coerces rather than refuses |
| 02 | `docs/taskboard.md:185-186` says the board announces an outgrown page; it no longer does | Not filed. Doc drift, over the cap |
| 02 | `docs/agent/chat/chat-api-and-poll.md`'s *"`GET /api/chat` answers two different questions"* paragraph says a thread's title is written by the model | Not filed. Doc drift. C-7 has to rewrite that sentence anyway |
| 03 | `src/lib/orchestrator.ts:11728`: picking up a once-waiting run queues it with no checkout | **Filed as `b403b8b4`** (high). Read at `:11728`, `:431-433`, `:8779`, `:8886`, `:10483-10491`. The boot's own comment at `:12620-12627` names the mechanism |
| 03 | `src/lib/orchestrator.ts:12608-12633`: the boot stops every waiting run | **Filed as `d2c5ecb6`** (high). Read at `:12608-12642`. The grace branch that keeps a paused dependency runs after its dependents are already stopped |
| 03 | `src/lib/orchestrator.ts:9751-9765`: the ceiling refund can take a first cycle to `iterations = 0`, so a later guard writes `blocked` | Not filed. Over the cap, and not re-read here. It is the same refund site as `6e6736b7` and `55ee6a0a`, so whoever fixes either should check it |
| 03 | `src/lib/orchestrator.ts:11474`: the paused sweeper's end branch has no `AND status='paused'` | **Filed as `7bf1a4e1`** (high, because the run ends wrongly, although it needs a press during one scan). Read at `:11361-11372`, `:11474-11479` and `setStatus` at `:1240` |
| 03 | `src/lib/format.ts:169-173`: `pctField` rounds to 0.1, so an unrelated edit re-saves a guard | Not filed. Verified at `format.ts:172`. It is low: the change is under 0.05 of a percentage point |
| 03 | `src/components/RecentBlocksCard.tsx:21`: the docblock says five token counts where the code sums six | Not filed. Comment drift |
| 04 | `src/lib/retention.ts:545,568`: worktree remove and prune run outside `withRepoAdmin` | Not filed. Verified: there is no `withRepoAdmin` in `retention.ts`, and `repoLock.ts:12-16` lists four registry callers without it. It is low, because `repoLock.ts` itself records that no collision was ever reproduced. Over the cap |
| 04 | `orchestrator.ts:11706-11776`: `reopenRun` accepts a run that is still landing or resolving | Covered by a note on `c3199f70` |
| 04 | `src/lib/workflows.ts:~6364`: `startMergeBlock` counts an already-landed branch as a failed landing | **Filed as `f3a2f4f6`** (normal), together with 04's unfiled item 1(c). Read at `mergeQueue.ts:140-178`, `land.ts:1014` and `workflows.ts:6364` |
| 05 | `docs/agent/metering/windows-and-periods.md`'s *"a calendar period is history, so its percentage is a pace and never a guard"* paragraph contradicts the *"calendar buckets"* paragraph beside it on weekly buckets | Not filed. Doc drift, over the cap |
| 05 | `src/components/TaskEditor.tsx` registers no leave guard | Covered by item C-10, which it was merged into |
| 05 | `src/app/api/mcp/route.ts:2868`: `list_recurring_failures` inherits `668dd86e` | Covered: that task names it |
| 05 | `docs/agent/testing.md:47`, `:279`: the dangling-link counts were probably inflated by `d0e67076` | Not filed. The hunt assumed it and did not re-measure |
