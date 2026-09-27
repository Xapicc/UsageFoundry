# QoL hunt 3/5: workflows, schedules, run dependencies
At `fee5efb`. I read `CLAUDE.md`, `docs/agent/dependencies.md` in full, and the paragraphs of `docs/agent/workflows-and-schedules.md` that each finding touches. Sub-agents hunted five slices in parallel and had to check each finding against those docs: dependency edges (`releasableRuns`/`admitWaiting`/`releaseDependents` and every caller), loop blocks, running/stopping/picking up an instance (including `ec8a2e1`'s two-day-old pick-up path), schedules, and the canvas editor. A sixth sub-agent surveyed the pages for friction. Every bug below was reproduced with a scratch `node --test` probe compiled against this tree with its own `DATA_DIR` and `CLAUDE_BIN=/bin/false`, except where the line says "read from source". The probes were kept under `$TMPDIR` and are not committed. I re-read the load-bearing lines of each filed bug myself before filing. I did not run `npm test` or `npm run typecheck`, because nothing in `src/` changed. Nothing was rendered in a browser (`npm run build` and `smoke-pages` were out of scope), so every UI claim below comes from reading the source. Not covered: `canvasView.ts` beyond the NaN and zero-size cases, the `/workflows/new` flow as distinct from edit, and the merge block's landing path past `retryMergeBlock`.

## Items
### W-1 A run's page links back to the workflow run and block that started it
- **Friction**: an operator who opens a run from `/runs`, from a notification or from a pick-up card cannot get back to the workflow run it belongs to. `src/app/runs/[id]/page.tsx` contains no `/workflows/` link (`grep -c "/workflows/"` → 0), and its origin line is plain text from `fmtRunOrigin(run.origin)` (`runs/[id]/page.tsx:1330`). `runs.origin_ref` cannot build the link either: depending on origin it holds the instance id, the schedule id or a node id (`src/lib/workflows.ts:4887-4888`, `5663-5664`). Meanwhile the instance page's pick-up card sends Resume to `/runs/<id>` (`instances/[instanceId]/page.tsx:~527`), so the trip is one way.
- **Change**: in `GET /api/runs/[id]` (`src/app/api/runs/[id]/route.ts:91`, beside `haltedWorkflow: haltedWorkflowOf(id)`), resolve `{ workflowId, workflowName, instanceId, nodeName }` through `workflow_instance_runs`, which is already indexed on `run_id` (`src/lib/db.ts:902`). Render the origin phrase as a link to `/workflows/<id>/instances/<instanceId>` on the run's own page only.
- **Size**: S.
- **Touches**: the runs list must not gain a per-row join (`src/lib/apiTypes.ts` list DTO; `docs/agent/conventions.md` "list DTOs"). It is a record of provenance and decides nothing (`docs/agent/run-lifecycle.md`, `runs.origin`).
- **Value**: high. Every workflow member run is reached from somewhere, and today each one is a dead end.
- **Not worth it if**: instances are routinely deleted before anyone reads their runs (deleting a workflow takes its instances, so the field is then null and the line stays plain text).

### W-2 The instance page says each wait's condition, not just who it waits for
- **Friction**: `instanceDTO` builds each member's wait list from the snapshot's edges but keeps only `edge.from` and drops `edge.edge` (`src/app/api/workflows/dto.ts:87-95`). An instance row reads "after Build, Test" with no "only if it completes" or "either way". Meanwhile `/workflows/[id]` does show the condition. When a member is `blocked`, its reason names a short run id (`src/lib/orchestrator.ts:~4443-4449`), not a block, so reading why an edge did not start the next run means matching ids by hand.
- **Change**: carry `{ nodeId, edge }` per wait in the DTO, including pass members, and render the condition with the edge labels `/workflows/[id]` already uses.
- **Size**: S.
- **Touches**: `docs/agent/dependencies.md` (conditions are explicit on the wire; this only labels them). Satisfaction stays `edgeSatisfied`'s: the page must not re-derive it.
- **Value**: high. This is the page an operator reads to find out why the next block did or did not start.
- **Not worth it if**: in practice every workflow uses one condition throughout (assumed not; the editor offers both on every link).

### W-3 The instance page states its outcome in words, and stops polling once it can no longer move
- **Friction**: the heading is "Run of <date>" (`instances/[instanceId]/page.tsx:1066-1068`), and the only outcome notices are for `failed` (`:1115`) and `stopping`/`stopped` (`:1121`). "working", "finished" and "blocked, N never ran" are never said on the page that owns them, although `/workflows/[id]` already has `OUTCOME_LABEL` and `outcomeDetail` for exactly this (`src/app/workflows/[id]/page.tsx:55`, `:81`). The page also polls every 10 s for ever (`instances/[instanceId]/page.tsx:48`, `:868`), including for a `stopped` or `failed` instance, which a pick-up never moves ("never through a halt", the pick-up paragraph of `docs/agent/workflows-and-schedules.md`).
- **Change**: move `OUTCOME_LABEL`/`outcomeDetail` to a shared module and render the badge and clause beside the heading. Stand the poll down for `stopped` and `failed`, and keep it for `finished` and `blocked`, which a pick-up can move.
- **Size**: S.
- **Touches**: the derived-status paragraph ("Four of an instance's six readings are derived…"): show the reading, and act on nothing because of it. `docs/agent/conventions.md` "A poll stands down when its subject can no longer move, and re-arming it is the half that has to be designed". Re-arming here is a reload, because nothing re-opens a halted instance.
- **Value**: medium. Operators follow a run from this page, and today they have to infer its state from the member rows.
- **Not worth it if**: the per-member rows are always few enough that the outcome is obvious at a glance.

### W-4 "Cannot be started again" names and links the live run, and Run says it before it is pressed
- **Friction**: while an earlier press is live, `/workflows/[id]` shows "N run(s) from this workflow have not finished. It cannot be started again until they do." with no link (`src/app/workflows/[id]/page.tsx:421-426`). Run stays enabled (`:352-356`, disabled only while busy), and pressing it earns the 400 from `startWorkflow` (`src/lib/workflows.ts:3049-3059`). That 400 says "stop that run of the workflow", again with no link, even when that run is already stopping.
- **Change**: `liveRunsOf` already returns `instanceId` (`workflows.ts:2918-2923`). Add the live instance id to `WorkflowDTO` (`liveBlocksOf` needs a variant that returns it too), link the notice to it, and disable Run with the notice as its stated reason. The server keeps its refusal.
- **Size**: S.
- **Touches**: `/workflows/[id]` is "the page Run is pressed from". The refusal stays the server's (`startWorkflow`), and the page only states it earlier.
- **Value**: medium-high. A second press is the likeliest mistake on this page, and today it costs a round trip plus a hunt through the history table.
- **Not worth it if**: two instances could ever legitimately be live at once (the refusal above says they cannot).

### W-5 The install-wide pause is stated where workflows are started and scheduled
- **Friction**: `newWorkPaused()` (`src/lib/settings.ts:1215`) holds every start. It is surfaced only on `/runs` (`src/components/FleetControls.tsx`) and the dashboard (`src/app/page.tsx`): `grep -rln newWorkPaused src/app src/components` finds no workflow page. So on `/workflows/[id]`, Run creates runs that sit in the queue, and the schedule card still shows "Next start <instant>" (`src/components/WorkflowSchedule.tsx:229-240`) for an occurrence that will be recorded as missed.
- **Change**: add `newWorkPaused` to `GET /api/workflows/[id]`. Show a `Notice` above Run and a line on the schedule card, both linking to `/runs`, where the pause is lifted.
- **Size**: S.
- **Touches**: read-only. The paragraph "A missed window is not made up, an overlap is skipped rather than queued" is unchanged, and this only says in advance that the window will be missed.
- **Value**: medium-high. A held install looks exactly like a broken schedule from the only page that owns the schedule.
- **Not worth it if**: `AppShell` already draws a global banner for the pause (assumed not; the grep above found none in `src/components` outside `FleetControls`).

### W-6 The schedule card states the next start in the schedule's own zone
- **Friction**: "Next start" is `fmtDateTime(schedule.nextFireAt)` (`src/components/WorkflowSchedule.tsx:236`), which prints in the browser's zone with no zone label, beside a description like "Every day at 09:00 (Europe/Berlin)". The two check each other only when the zones match. The zone itself is a free-text field that is not checked until Save (`WorkflowSchedule.tsx:~436`).
- **Change**: format the instant with the schedule's `timeZone` and name the zone, reusing the zone-aware formatter `missedSentence` already uses (`src/lib/schedules.ts:740-748`). Offer the zone field a `<datalist>` from `Intl.supportedValuesOf("timeZone")`.
- **Size**: S.
- **Touches**: "The zone is stored with the schedule, and an unknown one is refused rather than replaced": the datalist suggests and the server still refuses. A related coercion bug is filed separately (`83a5eeba`).
- **Value**: medium. This is the one place an operator checks that an unattended start will happen when they meant.
- **Not worth it if**: every operator of this install works in the same zone as their schedules.

### W-7 A failed deciding block can be picked up
- **Friction**: `pickUpsOf` (`src/lib/workflows.ts:4464`) offers three kinds of obstacle: a `run`, a `merge` and a stopped `loop` (`PickUp`, `workflows.ts:4420-4440`). An orchestrator block whose turn failed offers nothing, so the only way on is a fresh press of Run, which repeats every block that already finished.
- **Change**: a fourth `PickUp` kind that retries the deciding turn. It follows the shape of `retryMergeBlock` (`workflows.ts:4757`: failed → waiting, refused once a successor has started) plus `reviveGraphDependents` (`workflows.ts:4261`).
- **Size**: M.
- **Touches**: the pick-up paragraph ("one named obstacle at a time, and never through a halt"). A grep of that paragraph found no refusal of a deciding-block retry, but this is assumed rather than confirmed. The block's fan-out cap and the instance budget apply to the retried turn exactly as to the first.
- **Value**: medium. A failed turn is usually transient (a refusal or a timeout), and re-running the whole graph to get past it wastes every block before it.
- **Not worth it if**: a failed deciding turn is rare in practice (not measured).

### W-8 Duplicate a block in the editor
- **Friction**: every new block starts from `emptyBlock` (`src/components/WorkflowEditor.tsx:282`), added with `defaultMount()` and nothing else (`:606`): no template, folder, agent or task. The block inspector offers only "Remove block" (`:2437`). Building four similar blocks means filling the same fields four times.
- **Change**: a Duplicate button in the block inspector. It copies the draft without its id or links, places it beside the original, and is disabled at `MAX_WORKFLOW_NODES`.
- **Size**: S.
- **Touches**: hidden for a loop, which is made by framing and is in no palette ("A loop is made by framing blocks…"). A copied `continueBranch` must not come with it, since links are not copied.
- **Value**: medium. Graphs that fan out over similar blocks are the common case this editor exists for.
- **Not worth it if**: most blocks come from templates that already carry the repeated fields.

### W-9 A block name on `/workflows/[id]` opens the editor with that block selected
- **Friction**: the block table's name is plain text (`src/app/workflows/[id]/page.tsx:514`). The editor starts with nothing selected (`WorkflowEditor.tsx:378`, `useState<CanvasSelection | null>(null)`) and reads no search params (no `useSearchParams` in the editor or `edit/page.tsx`), so fixing one block's task means Edit, then finding the block on the canvas.
- **Change**: link each name to `edit?block=<nodeId>` and seed `selection` from that parameter.
- **Size**: S.
- **Touches**: selection is canvas state and not part of the workflow ("where a block sits is not part of it"). Nothing is saved.
- **Value**: medium. It is the shortest path from reading a block's settings to changing them.
- **Not worth it if**: workflows stay small enough that finding the block costs nothing.

### W-10 ⌘↩ saves the workflow editor
- **Friction**: Save is only a button in the sticky footer (`WorkflowEditor.tsx:1197-1223`). The run form commits with ⌘↩ through `isCommitChord` (`src/app/runs/new/page.tsx:1235`). `docs/agent/conventions.md` (the "⌘ and nothing beside it" rule) reserves ⌘↩ as the one chord the shell leaves to a form's own commit, and the editor does not take it.
- **Change**: bind `isCommitChord` on the editor to Save, with `aria-keyshortcuts` on the button.
- **Size**: S.
- **Touches**: the same unsaved-changes guard and the same `save()`. Nothing new is written.
- **Value**: low-medium. It is consistency with the other form, for people who work from the keyboard.
- **Not worth it if**: ⌘↩ inside the editor's prompt textarea is ever wanted as a newline (it is not a newline anywhere else here).

### W-11 The editor's errors are shown where the operator is looking
- **Friction**: a failed save sets `error` (`WorkflowEditor.tsx:970`), which renders at the top of the page (`:1000`), while Save sits in the sticky footer (`:1197`). On a tall editor the refusal is off-screen and the press looks like it did nothing. Separately, `src/app/workflows/[id]/edit/page.tsx:74` says "No such workflow" for any failed read, including a network error or a 500.
- **Change**: repeat the save error in the footer's existing `role="status"` line (`:1200`) or scroll the notice into view. In `edit/page.tsx`, say "No such workflow" only on a 404 and use `pollFailureMessage` for anything else.
- **Size**: S.
- **Touches**: `docs/agent/conventions.md` (no tooltip carrying needed information; a notice is the vocabulary here).
- **Value**: medium. An unseen refusal after a long edit invites a second, identical press or an abandoned edit.
- **Not worth it if**: the editor page never grows past one viewport (it does once the inspector is open).

### W-12 The workflows list shows how the last press ended, and links it
- **Friction**: "Last run" on `/workflows` is a bare timestamp (`src/app/workflows/page.tsx:160-165`, from `lastRunAt`, `src/lib/workflows.ts:2893`). Checking whether last night's scheduled press worked takes two hops: the workflow, then the history table.
- **Change**: a `lastInstance { id, createdAt, status }` on the list DTO, read with a `LIMIT 1` query plus `instanceStatus` over that one instance's member tally, not a full `rowToInstance`. The timestamp becomes a link and the status a badge.
- **Size**: M.
- **Touches**: the list DTO is kept small on purpose, and quick open reads the same list (`docs/agent/conventions.md`, list DTOs and the quick-open cast). The status is derived and must be read, never acted on.
- **Value**: medium. For scheduled workflows this is the morning check.
- **Not worth it if**: the extra per-row query shows up in the list's 10 s poll (assumed small; not measured).

### W-13 The history table says who started each press and what it spent
- **Friction**: "Runs of this workflow" has three columns, Started, Outcome and Runs (`src/app/workflows/[id]/page.tsx:676-688`). Every row's payload already carries `spentUSD` and `spentUnmeasured` (`src/lib/apiTypes.ts:2405-2416`), and none of it is shown. Whether a press was the schedule's or a person's is not on `WorkflowInstanceDTO` at all (no `origin` field), though `workflow_instances.origin` is stored (`src/lib/db.ts:1622`). The schedule card links only the latest press it started.
- **Change**: a `num` Spent column that reuses the instance page's wording when a block reported no cost ("reported so far", `instances/[instanceId]/page.tsx:1184`), with no footer total. Add `origin` to the instance DTO and render "schedule" or "you".
- **Size**: S.
- **Touches**: "The instance total is a fourth reading…": each row's figure is its own reading and is never summed across rows. The origin half depends on the filed bug `1a90c468` (the instance's origin is not read back today).
- **Value**: medium. It separates the scheduled presses from the manual ones, and the cheap ones from the costly ones, without opening each.
- **Not worth it if**: the history is usually one or two rows.

### W-14 The loop card says what its cost limit is measured on
- **Friction**: the loop card shows "Spent by its runs <$X> of <$Y> limit" (`instances/[instanceId]/page.tsx:665-672`), summed by `passSpend` from the member runs' shown figure (`:122-131`). The cap itself is `loopSpend` (`src/lib/workflows.ts:2411-2431`), which reads the **guard** figure and adds the pass's orchestrator and merge turns. So a loop can stop "on its cost limit" beside a figure well under that limit, and nothing on the page says why.
- **Change**: include the pass blocks' reported turn cost (`workflow_instance_blocks.cost_usd`, which is shown elsewhere) in the card's figure, and add one clause under the limit saying it is checked against a figure that also counts cycles cut short before they reported. The guard figure itself stays unrendered.
- **Size**: S.
- **Touches**: `docs/agent/metering.md`, the split between the shown figure and the guard figure: the guard figure is "Never rendered" (`AggregateDTO.costGuardUSD`, `apiTypes.ts:26`), so the card states the difference and does not show it.
- **Value**: medium. A cost stop that looks under budget reads as a bug and costs the operator an investigation.
- **Not worth it if**: loops with orchestrator members or cut-short cycles are rare enough that the two figures agree in practice.

### W-15 The schedule card says a schedule would be refused before offering the form
- **Friction**: "Add schedule" is always offered (`src/components/WorkflowSchedule.tsx:205`). The component is not told whether the workflow can be scheduled (props at `:103-112`), so the refusal from `scheduleRefusal` (`src/lib/schedules.ts:530`) only arrives after the form is filled and saved. It then points at "Limits for the whole workflow", which cannot be edited on that page.
- **Change**: send the server's `scheduleRefusal(workflow)` on `WorkflowDTO`, so that the browser decides nothing. Show that sentence in place of the button, with a link to the editor.
- **Size**: S.
- **Touches**: "A schedule is the first thing here that starts an agent with no person present at all…": the refusal stays the server's, and is re-checked at every fire as today.
- **Value**: low-medium. It saves one filled-in form per unbudgeted workflow, and it explains the rule where it applies.
- **Not worth it if**: most workflows carry an instance budget already.

Fifteen items. I considered and dropped these: search or filter on the list (`proposals/Findability/README.md:31-37` refuses per-page filters, and the list is complete); Run on list rows (`/workflows/[id]` is where Run is pressed, with the limits above it); a default edge condition (`docs/agent/dependencies.md`: "neither is defaulted"); canvas undo and a "re-arrange" reset (`src/components/WorkflowCanvas.tsx:83-88`, Delete is the only destructive gesture); loops in the palette; server-saved positions; overriding the budget at Run; making up missed windows; a "Duplicate keeps layout" item (assumed low value); and a "Repeat re-points an outside link into the frame" item, which would bend the link-into-a-frame refusal rule of `docs/agent/workflows-and-schedules.md` without a stated reason to.

## Too big for this list
- A per-edge "why did or did not this start" timeline across a whole instance is RunDecisionTree's `run_events` (`proposals/RunDecisionTree/`), not a page change.
- Inputs at the press of Run: the run route reads no body by design ("A person sets an instance budget, and there is nothing on the wire that could").
- A canvas layout that follows the operator across browsers is refused ("where a block sits is not part of it").

## Bugs filed
- A loop whose board can't be counted is failed mid-pass, stranding the pass and releasing the block behind it early — high — `9e6f6a52-cacd-47e8-b729-7d6f237db8a0`
- A scheduled workflow's later blocks are recorded as started by a press of Run — normal — `1a90c468-dea2-4894-9cd9-a8dd094363f8`
- Duplicate workflow fails for a name near the 80-character limit — normal — `c8e68403-0b56-4da4-a1ce-7fd075c1129a`
- Editor mints section links that carry a branch the server refuses, with no control to undo it — normal — `6dad185c-b5d9-45e4-9652-69cad5037626`
- In-section link panel calls an "either way" link refused, and its redraw advice silently changes it to on-success — normal — `ae6e12b7-2429-4cef-b2f9-cbb2a8bfcda9`
- Editor's worst-case run count for a loop leaves out each orchestrator turn that Save counts — normal — `4b22a720-4f59-42ed-b2b4-94fb937e4034`
- Schedule tick starts a workflow the operator paused, removed or changed during the fire — high — `6a78f187-2c43-450f-8930-b1d2a8d7a4e2`
- Schedule PATCH resumes a paused schedule for any paused value that is not literally true — normal — `2d00098f-a52a-49a8-ba95-5fc8b295bdcc`
- Schedule input coerces hours, weekday and zone instead of refusing them — low — `83a5eeba-cc3f-4b85-8f47-1b998dacce9d`
- Orchestrator block whose emitted runs all failed to start is reported as having decided nothing — low — `dda964d2-62c1-4a75-a32c-a0eb7c95a5c5`
- Reviving a blocked dependent leaves it waiting even when another dependency still fails it — low — `cd3ae5a5-ce4b-4748-a685-53b72137ab7d`
- A workflow run stopped by "Stop everything" reads back as stopped by you alone — low — `d6c6bd40-450d-463c-9d1b-0f3cd9ff0096`

## Bugs not filed
Each of these was confirmed but falls below the twelve filed, or is cosmetic. All refer to `fee5efb`.
- **Frame gestures can write a graph Save refuses (low; executed).** Taking out a section's entry block can mint a duplicate link (`src/lib/canvasGraph.ts:1033` lacks the `next.some(...)` guard that `:1039` has). The server answers "“b” is set to start after “a” twice", and two React elements share one `linkKey`. Put in accepts a block another loop already frames, and the refusal names the wrong block (`canvasGraph.ts:945`, `WorkflowCanvas` `chooseMember`). Which blocks Repeat frames depends on the order they were marked (`canvasGraph.ts:910`); the server refuses the result.
- **Client and server order a forked section differently (low; executed).** For e→a→c→m plus e→b→m, `bodyOrder` gives `e,a,b,c,m` (`canvasGraph.ts:462`) while the server's `loopBody` gives `e,a,c,b,m`. The doc paragraph "The client orders a body by the body's own edges, and it has to be the same order the server will run it in" is broken. There is no runtime effect, but `BlockStatement` reads parallel blocks as "in this order … then".
- **Deleting a section member cuts its links instead of splicing (low; executed; possibly intended).** `WorkflowEditor.tsx:617`: deleting the entry leaves an empty section that Save refuses, unlike take-out ("Taking a block out of a frame splices rather than cuts").
- **Coincident nodes are thrown about 1e9 units apart (low; executed).** `src/lib/forceLayout.ts:415-419` divides by `d = 1e-6`. It is not reachable on the workflow canvas, only through coinciding pins or carried positions elsewhere.
- **Boot catch-up past 500 missed windows names the 500th, not the latest (low).** `src/lib/schedules.ts:370` (`MAX_CATCHUP`), `:941-972`. The cap was executed on `decideSchedule`; the boot path was read from source, not executed.
- **A schedule whose `nextOccurrence` throws records every 30 s tick as an occurrence (low; read from source, not executed).** `schedules.ts:832-839`.
- **"run(s) in flight" counts live blocks as runs (low, copy).** `liveRunCount` is runs plus blocks (`src/app/api/workflows/dto.ts:58`), but it is printed as runs (`src/app/workflows/page.tsx:138`, `src/app/workflows/[id]/page.tsx:423`).
- **`POST /api/workflows/<unknown>/run` answers 400 "No such workflow." where its siblings answer 404 (low; executed).** `src/app/api/workflows/[id]/run/route.ts:39`.
- **Two tabs editing one workflow: the last save wins silently (low; read from source).** No version check in `updateWorkflow` (`src/lib/workflows.ts:1940`), and no doc paragraph calls that deliberate.
- **A zero-cycle `completed` pass member stops the loop with the sentence "ended completed" (low, copy; read from source).** `workflows.ts:1217-1232`. The sentence does not say the member ran no work cycle.
- **Not confirmed, recorded so nobody re-derives it:** during `startWorkflow`'s rollback, `stopRun` on a waiting member runs `releaseDependents` → `advanceInstances` while the stored status is still `started`, so a root merge or orchestrator block could be claimed mid-rollback (read from source; needs an instantiation failure part-way, which the doc calls unreachable). Separately, `retryMergeBlock` leaves the previous `merge_batch_id` on the row until the retry starts (`workflows.ts:~4782-4788`), so the page may briefly show the old batch's counts (read from source, not executed).

## Seen outside my territory
- **High.** `src/lib/orchestrator.ts:11728` (`reopenRun`): picking up a run that never left `waiting` sends it to `queued` with no checkout, because `waitingAgain` covers only `blocked`. Such a run is `stopped` by `stopRun`'s waiting branch (`:10484`) or by the boot (`:12619`), or `failed` by `admitWaiting` (`:5052`). It then works in the operator's own folder, where `startRun` builds no worktree (`:8886`), and without waiting for its dependencies. Executed with a scratch probe: "B after reopen queued isolation= null work_dir= null". The bulk pick-up on `/runs` (`src/app/runs/page.tsx:85`) offers these rows too.
- **High.** `src/lib/orchestrator.ts:12608-12633` (`reconcileOnBoot`): the boot closes every `waiting` run as "closed out by the same restart", even when its dependency was kept `paused` within `resumeGraceHours`, or `completed` while the install-wide hold held the dependent. The premise stated in `docs/agent/dependencies.md` is false in both cases. Executed: "after boot dep-paused paused … dependent-of-paused stopped".
- `src/lib/orchestrator.ts:9751-9765`: the context-ceiling refund can take a first cycle back to `iterations = 0`, and a following pre-cycle guard then writes `blocked` (`:9028`, `:9057`). The result is a run that spent money recorded as refused before its first work cycle, dependents blocked "without running a work cycle", and no handoff. Read from source, not executed.
- `src/lib/orchestrator.ts:11474`: the paused sweeper's end branch writes `stopped` without `AND status='paused'`, unlike its siblings (`:11440`). Read from source, not executed.
- `src/lib/format.ts:169-173`: percentage fields round to 0.1% when the editor loads them, so an unrelated edit re-saves a changed guard (33.33% → 33.3%) without the page counting as having unsaved changes. Read from source, not executed.
- `src/components/RecentBlocksCard.tsx:21` is in this hunt's list but is the dashboard's 5-hour usage table, not a workflow block. Its docblock says "five token counts" where the sum at `:66-71` correctly adds six. That is comment drift, not a bug.
