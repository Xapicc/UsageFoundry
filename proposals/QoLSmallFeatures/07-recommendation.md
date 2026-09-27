# Recommendation: build order for the top ten

The top ten fit in **six runs**. Each run either groups items that touch the same files, or groups items governed by the same `docs/agent/` file, so the reasoning that doc holds is read once rather than three times. All ten are S. None needs a migration or a new table. Two of the six runs have a bug on the board that should land first.

## Order

| Step | Run | Items | Files it touches | Must go first | Governing doc |
|---|---|---|---|---|---|
| 0 | Bug fix, not an item | `b403b8b4` | `src/lib/orchestrator.ts` (`reopenRun`'s `waitingAgain`, `:11728`) | — | `run-lifecycle.md`, `dependencies.md` |
| 1 | Pick-up limits | R-2, R-1, R-3 | `src/components/FleetControls.tsx`; `src/app/runs/[id]/page.tsx` (`openReopen`, `:1153-1158`); a pure `reachedLimits` helper beside `pausedMsAt` in `src/lib/apiTypes.ts`, with a unit test | step 0 | `run-lifecycle.md` (the pick-up paragraphs), `budgets-and-guards.md` |
| 2 | Land names the dirt | G-1 | `src/lib/land.ts` (`checkoutStateOf` `:423-435`, `landRefusal` `:1040-1041`) and the `landRefusal` test. Optionally the matching halt sentence in `src/lib/mergeQueue.ts:153-157` | — | `isolation-and-landing.md`, `git-and-review.md` |
| 3 | The chat card's run | C-1, and C-6 (same card) | `src/app/api/chat/dto.ts` (`proposalDTOs`); `src/app/chat/page.tsx` (`Decided`, `:2651-2676`; the task phrase, `:2339-2355`) | — | `chat.md` |
| 4 | Taskboard trio | C-10, C-8, C-11 | `src/components/TaskEditor.tsx`, `TaskThread.tsx`, `TaskDependencies.tsx`; `src/app/tasks/page.tsx`, `src/app/tasks/[id]/page.tsx`; `src/lib/tasks.ts` (`taskDTO` gains the holder's status); `src/app/api/tasks/**` | — | `taskboard.md` |
| 5 | Workflow provenance, both ends | R-4 + W-1, W-2 | `src/app/api/runs/[id]/route.ts` (beside `haltedWorkflowOf`, `:91`); `src/app/runs/[id]/page.tsx` (`:1330`); `src/app/api/workflows/dto.ts` (`:87-95`); the instance page | — | `workflows-and-schedules.md`, `dependencies.md`, `run-lifecycle.md` (`runs.origin`) |
| 6 | Merged-branch cleanup | G-3 | `src/app/branches/page.tsx` only, reusing the existing `Sheet` and `POST /api/runs/[id]/land` `action: "delete"` | `a9ec4551` (preferred, not required) | `isolation-and-landing.md` |

### Why this order

**Step 0 before step 1.** The bulk pick-up offers once-waiting runs today (`src/app/runs/page.tsx:85`, per hunt 3). `reopenRun` puts such a run in the queue, and it then works in the operator's own folder with no checkout and without its dependency. That is task `b403b8b4`, filed by this assembly. Step 1 makes the fleet sheet into a control an operator can press with confidence, so the thing it can wrongly start should be fixed first.

The order does not change what step 1 lets through. A once-waiting run has used no cycle, so the sheet's refusal never covered it. The dependency is the operator's trust, not the code.

**Step 1 goes first among the items.** R-2 is the one item in the top ten whose failure changes a money cap. An untouched blank field is sent as `null` (`src/components/FleetControls.tsx:194-197`) and spread over every run's stored budget (`src/lib/fleet.ts:274`). R-1 and R-2 answer the same question for two sheets: what should a limit field show when the stored limit is already reached? One pure helper keeps the sheets and `reopenRun`'s refusals (`orchestrator.ts:11800-11812`) from disagreeing. That function fails silently, so by `CLAUDE.md`'s bar it earns a unit test. R-3 lists runs inside the same `Sheet`, which makes it one more edit to a file the run already has open.

**Steps 2, 3, 4 and 6 share no files** with each other or with steps 1 and 5, so they can run in any order or in parallel.

**Steps 1 and 5 both edit `src/app/runs/[id]/page.tsx`**, in regions about 170 lines apart (the Resume sheet at `:1153` and the origin line at `:1330`). Run them one after the other, or expect a textual merge.

**Step 4 is three items in one run**, because all three are governed by `taskboard.md`. That file is the longest routing entry in `CLAUDE.md`, and every board item has to be read against it. C-10 should add a small `useLeaveGuard(dirty)` hook, since `WorkflowEditor.tsx` and `settings/page.tsx` would otherwise make three callers of the same pattern. C-10's "send only the fields that differ" half is also what C-15 needs later.

**Step 5 pairs R-4 + W-1 with W-2**, because together they make the trip between a run and its workflow run go both ways:

- today the instance page links to its runs, and the run page links back to nothing;
- today the instance page names who a member waits for, but not on what condition.

Take W-1's resolution path, not R-4's: `origin_ref` holds a node id for some origins, so resolve through `workflow_instance_runs`. Keep the list DTO free of a per-row join (`conventions.md`, list DTOs).

**Step 6 after `a9ec4551` if possible.** That bug refuses Delete on a merged branch whenever the operator's checkout is not on the branch's target. A bulk Delete built before it would report most rows refused on such an install. On an install whose checkout stands on the target, which is the common case (assumed), G-3 works without it.

## What the top ten leaves for next

These are the next items to build, in order:

- **U-5** (M, high): Settings sends only what changed. It removes a cross-tab data loss and the class of Save refused over a field nobody touched. It has to argue with `metering.md`'s default-agent decision rather than route around it.
- **C-9** (M, high): start a run from a task. It goes after R-8, which teaches `/runs/new` a second query parameter the same way.
- **G-5** (M, high): stop listing deleted branches. It makes G-3's cleanup visible in the list.
- **U-1** (M, high): project exhaustion on a stock install. It goes in the same run as bug `8b47ae9a`.
- **C-2** (M, high): say that another chat thread is waiting.

Among the S items outside the top ten, three are medium-high and cheap: **W-5**, **W-4** and **R-10**.

Two items need a security reading before they land, because each widens what untrusted text or agent-written code can reach:

- **C-16** widens `Markdown`'s link allowlist from schemes to same-origin paths.
- **G-9** adds a door that runs a branch's own `npm test`.

## The fact that would overturn the ranking

**How this install's runs are started.** The query is:

```sql
SELECT origin, COUNT(*) FROM runs GROUP BY origin;
```

It has to be run by the operator, because `/data` is denied to a work cycle.

The top ten is spread across four starting points: the form and its pick-ups (R-1, R-2), workflows (R-4 + W-1, W-2), the chat and the board (C-1, C-8, C-10, C-11), and landing (G-1, G-3). The spread assumes each is in regular use. Nothing measured says so: no hunt read the `runs` table, and every value in the five files is the hunt's judgement.

- **If `workflow`, `orchestrator-block` and `schedule` together are most runs**, R-4 + W-1 and W-2 move to the top. W-4 and W-5 enter the top ten, and R-1 and R-2 fall behind them.
- **If `chat` dominates**, C-1 leads and C-2 (M) enters the top ten.
- **If `form` is nearly everything**, the workflow items fall out and R-5 and R-6 come in.

G-1 and G-3 do not move with this figure. They depend on how often the operator lands through the app. Nothing records that today: `run_events` has no row for a refused land, as hunt 4 notes under G-1.
