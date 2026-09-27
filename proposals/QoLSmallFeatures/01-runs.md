# QoL hunt 1/5: starting runs, the run loop, the run page

At `fee5efb`. I read the four `docs/agent/` files for this territory: `budgets-and-guards.md` in full, and `run-lifecycle.md`, `agents-and-templates.md` and `concurrency-and-ownership.md` by section, along with the grouping rules in `conventions.md`. I split the territory across five read-only sub-agents:

- the new-run form, templates and agents;
- the run page and its per-run API routes;
- the runs list, the fleet and `notify`;
- the run loop and its guards;
- context pruning.

I re-read every filed bug myself at the lines cited, at this commit. Each entry under "Bugs not filed" says whether I re-read it or only a sub-agent did. Where a sub-agent executed something (a scratch `node --test` against a `tsconfig.test.json` build, or the real `startRun` loop against a stub `CLAUDE_BIN`), the entry says so and gives the output. I did not re-run those probes.

I did not run `npm test` or `npm run typecheck`, because nothing in `src/` changed. I did not open a browser. Not covered:

- `createRun`'s install-ceiling door and `resolveWorkspaceFolder`;
- `reopenFleet`'s interaction with workflow members;
- the `buildCodexArgs` path;
- `parseComposition`/`forkTranscript`;
- the isolation, permission and enforcement rows of the new-run form (`src/app/runs/new/page.tsx:1826-2060`);
- about half of `src/app/agents/page.tsx`.

## Items

### R-1 Resume pre-fills the limit that ended the run, so the first press is refused
- **Friction**: Anyone picking up a run that used its cycles or its money hits this on the first press.
  - `openReopen` copies the stored caps into the Resume sheet verbatim (`src/app/runs/[id]/page.tsx:1153-1158`).
  - `reopenRun` refuses a cap at or below what was already used: "Raise the cycle limit above that to carry on." (`src/lib/orchestrator.ts:11800-11812`).
  - `maxIterations` defaults to 1 (`docs/agent/run-lifecycle.md:35`), so the ordinary `completed` run that used its one cycle is refused on the first press with the values the sheet chose. So is a run stopped by its spending limit.
- **Change**: When a stored limit is already reached, pre-fill a raised value instead: `iterations + max(1, original cap)` for cycles, and the spend so far plus the original cap for money. Mark each raised field with its hint ("was 1 — used up"), so the raised number is visibly the form's suggestion. Share one pure helper between the sheet and the door, e.g. `reachedLimits(run)` next to `pausedMsAt` in `apiTypes.ts`, so the sheet and `reopenRun`'s three checks cannot disagree.
- **Size**: S.
- **Touches**: `run-lifecycle.md:33` ("re-queueing under the limits that stopped it just reproduces the stop"). This item applies that reasoning to the form as well as the door. `permissionMode` stays off the wire. The risk is that a pre-filled higher spending cap is a money decision, so it must show as a changed value, never silently.
- **Value**: high. It is the ordinary pick-up of the default run, every time.
- **Not worth it if**: pick-ups are nearly all of `failed` runs whose limits were not reached (not measured; assumed rare).

### R-2 The fleet pick-up sheet's defaults refuse every run and clear every spending cap
- **Friction**:
  - The cycle field starts at `"1"` and the spending field blank (`src/components/FleetControls.tsx:55-56`), and blank goes on the wire as `null` (`:194-197`).
  - Cycles: every run that has used a cycle is refused by the door check (`orchestrator.ts:11800`). After "Stop everything", that is every run that was mid-cycle, because the loop increments before it spawns (`budgets-and-guards.md:14`). A sub-agent executed `reopenFleet` with the sheet's defaults: runs at 1/5 and 3/10 cycles were both refused.
  - Spending: `reopenFleet` spreads the wire over each run's stored budget (`run-lifecycle.md:15`), so the untouched blank field rewrites every run's own `maxRunCostUSD` to "no limit". A sub-agent executed it: a stored `{maxIterations:1, maxRunCostUSD:5, …}` came back as `"maxRunCostUSD":null`.
- **Change**:
  - Seed the cycle field from the set: the maximum `iterations` over `reopenable` plus the smallest original cap. `RunListItemDTO` carries `iterations`.
  - Send `maxRunCostUSD` only when the operator has typed in the field, and say "each run keeps its own spending limit" while it is untouched.
  - A typed blank still means "no limit", exactly as `run-lifecycle.md:15` records.
- **Size**: S.
- **Touches**: `run-lifecycle.md:15`, where blank-as-`null` is an explicit answer and "a field the sheet never asked about keeps the value that run was started with". This item uses the second half of that sentence for a field the operator did not touch. That an absent key is kept by the spread is assumed from that sentence; `fleet.ts:220-232` should be checked first.
- **Value**: high. The control exists for the twenty-five-run case, and its defaults fail it both ways.
- **Not worth it if**: nobody uses the fleet pick-up (no usage figure exists).

### R-3 The pick-up sheet lists the runs it will pick up
- **Friction**: The sheet confirms a count, "The N failed or stopped runs listed on this page" (`FleetControls.tsx:~201-206`). `reopenable` is computed from the poll's newest 100 rows (`src/app/runs/page.tsx:876`), including runs that are only in the collapsed "Older runs" fold. `run-lifecycle.md:15` grounds the bulk pick-up on "the ids the page displayed", but the sheet never displays them.
- **Change**: Inside the existing `Sheet`, list `reopenable` as `ListRow`s (task clipped, status, finished relative, link to the run). Beyond nine rows, show the first nine and a count ("and 16 more"), per the `ListGroup` rule "more than nine is two".
- **Size**: S.
- **Touches**: `conventions.md:51` (a `Sheet` is the allowed shape for a decision; no nested disclosure). The list must be `reopenable` itself and not a re-query, or it stops being the ids the press sends.
- **Value**: medium. It turns a count into something that can be checked before a press that restarts agents that accept edits.
- **Not worth it if**: the set is almost always one or two runs.

### R-4 Link a run to the record that started it
- **Friction**: The run header prints `fmtRunOrigin(run.origin)` as plain text (`src/app/runs/[id]/page.tsx:1330`). `origin_ref` is on `RunDTO` (`src/lib/apiTypes.ts:1407`), and `grep -rn "origin_ref\|originRef" src/app src/components` returns nothing. So "which workflow instance, schedule or chat proposal started this?" is answered with a word and no way to get there.
- **Change**: Resolve `origin_ref` in `GET /api/runs/[id]` to an `originHref: string | null`:
  - `workflow`/`orchestrator-block` → `/workflows/<workflowId>/instances/<instanceId>`, through `workflow_instances.workflow_id`, which `haltedWorkflowOf` (`orchestrator.ts:~4917-4936`) already joins;
  - `schedule` → the schedule's page;
  - `chat` → the thread.

  Render the origin word as a `Link` when non-null. When the referenced row is gone, leave it as plain text, which is what the column is designed to keep saying (`run-lifecycle.md:9`).
- **Size**: S–M.
- **Touches**: `run-lifecycle.md:9` (origin is a record, not a deduction; this must not infer an origin where `origin_ref` is null). `conventions.md` on positions resolved at the fetch boundary.
- **Value**: medium-high. The comment above that line calls provenance "the first question".
- **Not worth it if**: most referenced rows are deleted before anyone reads the run (unmeasured).

### R-5 Say when a run finished, how long it worked and how long it waited
- **Friction**: The header shows only "started" or "created" (`src/app/runs/[id]/page.tsx:1320-1322`). The worked-minutes arithmetic (`pausedMsAt`, `:545-547`) is drawn only inside the time bar, which exists only when `maxDurationMinutes` is set (`:535-536`). `pause_count` is on the DTO, and `grep -rn "pause_count\|pauseCount" src/app src/components` returns nothing. On the default run (one cycle, no time limit), "when did it end, how long did it take, how long was it parked, how many of its three waits are used" cannot be read anywhere.
- **Change**:
  - Add "finished <time>" to the header when `finished_at` is set.
  - Add one fact line "worked Xm · parked Ym · n of 3 waits used" to the run's inspector region, computed with `pausedMsAt`.
  - Label it "since it was last picked up" when `reopened_at` is set, because `started_at` and `paused_ms` reset on a pick-up (`run-lifecycle.md:33`).
- **Size**: S.
- **Touches**: `budgets-and-guards.md` (the bar and the guard share one arithmetic; this adds a third reader of the same function, not a copy). The "of 3" must read `MAX_PAUSES_PER_RUN`. If task `8ef928a2` splits the refusal counter from `pause_count`, show that counter instead.
- **Value**: medium. These are basic facts about a run, currently missing from its own page.
- **Not worth it if**: `RunActivity` or the log already carries them. I checked `RunActivity.tsx`, and it does not.

### R-6 List queued runs in the order they will start, with their priority
- **Friction**: `/runs` sorts "In flight" by status only (`src/app/runs/page.tsx:806-810`), over rows that arrive `created_at DESC`. So queued runs are shown newest first, the reverse of `queueCompare` (`orchestrator.ts:4111`: priority first, oldest breaking ties). `priority` is on `RunListItemDTO`, which omits only prompt, budget, agent and `needs_review_reason` (`apiTypes.ts:1461-1464`), but `/runs` never draws it. With the cap reached, nothing on the list says which run starts next.
- **Change**:
  - Sort the queued rows by the same rule as `queueCompare`.
  - Mark the first "next".
  - Show a non-zero priority beside the status.

  `queueCompare` lives in server-only `orchestrator.ts`, so it cannot be imported into a `"use client"` page. Move the pure comparator to a shared module both import, not a second copy (`conventions.md` on what a client file may import).
- **Size**: S.
- **Touches**: `proposals/GapRegister/04-missing-features.md` M5 shipped the lever and the priority control on the run page (`src/app/runs/[id]/page.tsx:625-652`). This is the list half, which M5 does not cover.
- **Value**: medium. A priority nobody can see from the list is only half a lever.
- **Not worth it if**: the queue is rarely more than one or two deep.

### R-7 Filter the runs list by origin
- **Friction**: `origin` is on the list DTO (`apiTypes.ts:1405`) but is not drawn or filterable on `/runs`; `grep -n origin src/app/runs/page.tsx` returns nothing. "What did the schedules start overnight?" and "what did that orchestrator block emit?" cannot be asked. `listRunsPage` filters on `status`, `q` and `settledBefore` only (`orchestrator.ts:1130-1145`).
- **Change**:
  - Add `?origin=` to `GET /api/runs` and `listRunsPage`. Refuse an unknown value rather than dropping it (`conventions.md:16`).
  - Add a select beside the status filter in the "Older runs" fold.
  - Add a short origin word on each row.
- **Size**: S–M.
- **Touches**: `conventions.md:16` (narrowing happens in the query, never over a capped page). `run-lifecycle.md:9` (five values, recorded not deduced). The local scan over `proposals/Findability/` found no filter by origin.
- **Value**: medium. Three of the five origins start agents with nobody present, and that is when an operator most needs to find the runs later.
- **Not worth it if**: installs use only the form.

### R-8 `/runs/new?template=<id>` opens the form with a template applied
- **Friction**: The chat proposal card links a template's name to a bare `/runs/new` (`src/app/chat/page.tsx:2460`). The form reads only `?from=` (`src/app/runs/new/page.tsx:607`), so the operator then finds and picks the same template by hand. `templateId` is already on the proposal DTO (`apiTypes.ts:3471`).
- **Change**: Read `?template=` beside `?from=` and call the existing `pickTemplate` (`page.tsx:1119`) once templates load. Point the chat card's link at it. The chat page is outside this territory; its change is a one-line `href`.
- **Size**: S.
- **Touches**: `agents-and-templates.md` (a template is form input and is re-gated by `POST /api/runs`, so a pre-applied template is no looser than a picked one). `chat.md` on what the card promises. When both `?from=` and `?template=` are given, one must win and say so; `?from=` is proposed.
- **Value**: medium. It saves a click and a search on every chat-to-form hand-off.
- **Not worth it if**: operators rarely adjust a chat proposal on the form.

### R-9 The agent delete sheet names what still refers to the agent
- **Friction**: The sheet warns that anything naming the agent "refuses to start … so check those before deleting", and lists nothing (`src/app/agents/page.tsx:551-558`). A workflow node or template that names it is then refused at its next start, which for a scheduled workflow happens with nobody present.
- **Change**: When the sheet opens, show the references: templates with that `agentId`, `settings.defaultAgentId`, and workflow nodes naming it. Read them through one small `GET /api/agents/[id]/references`, or from the existing template, settings and workflow GETs.
- **Size**: S–M.
- **Touches**: `agents-and-templates.md` (a run holds a frozen copy, so runs are correctly not listed; only references refuse). Copy: the sheet's "specialist" is the older name for the feature.
- **Value**: medium. It turns a warning into a checklist, for a deletion with no undo.
- **Not worth it if**: installs keep only one or two agents.

### R-10 The context panel says why an over-ceiling run was not cut
- **Friction**: The run page's Context panel can show a run at 120% of "the cycle ceiling" with no explanation. Several different states read the same on the page: pruning off (the ceiling never acts, `orchestrator.ts:10806`), declined on payback, winnow unavailable, or waiting for 25k tokens of growth. `ContextOccupancyDTO` (`apiTypes.ts:583-621`) carries nothing about the last decision. The server records it (`PruneDecisionRow`, `src/lib/contextPruning.ts:3639-3647`), already words it (`ceilingDeclineMessage`, `contextPruning.ts:3230`), and already reads it for the dashboard (`src/app/api/usage/route.ts:168`).
- **Change**:
  - Add `lastCeilingDecision: { ts, outcome, sentence } | null` to `ContextOccupancyDTO`, from this run's newest ceiling row in `prune_decisions`.
  - When the latest sample is over the ceiling, render it in `Caption` with its age.
  - When pruning is off, show the sentence `compositionAbsence: "off"` already implies.
- **Size**: S.
- **Touches**: `run-lifecycle.md` ("when the number last moved and when it was last looked at are two facts"; "every failure on this path is a log line"). A sub-agent noted that ceiling declines and early-end prunes both write `trigger = 'early-end'`, so the query must select on `outcome`, not on the trigger alone. It must not overlap open issues #211 and #212, which concern the composition stack.
- **Value**: medium-high for installs with pruning on, since it is the one question that panel cannot answer.
- **Not worth it if**: pruning stays off everywhere.

### R-11 The work-cycle meter shows refunded and granted cycles
- **Friction**: The meter draws `iterations / max_iterations` (`src/app/runs/[id]/page.tsx:491-497`). Several things move `runs.iterations` without saying so: park refunds, early-end refunds and transient retries all decrement it (`orchestrator.ts:9810`, `:9751-9764`). A validator grant (`runs.validation_cycles`) is not on the DTO at all (`grep -n validation_cycles src/lib/apiTypes.ts` returns nothing). A run reading "1 / 1" may have been billed for four invocations.
- **Change**: Add `validation_cycles`, and the early-end count once it is persisted (task `55ee6a0a`), to `RunDTO`. Draw them as the meter's hint ("+1 granted by the task check · 2 cut short and refunded"), reusing the `upperHint` slot the Spend meter already has (`page.tsx:483-485`, `:514`).
- **Size**: S–M. It depends on the fixes filed as `c1dc14cf` and `55ee6a0a`, without which the numbers would describe behaviour that does not happen.
- **Touches**: `budgets-and-guards.md` (the refund paragraph; validator extension by a bounded count). This is display only and must not feed a guard.
- **Value**: medium. It reconciles the cycle count with the bill.
- **Not worth it if**: refunds turn out to be rare in practice (unmeasured).

### R-12 Page back through the part of a long log the replay cut
- **Friction**: The event stream caps its replay and reports how many earlier events were never sent (`src/app/api/runs/[id]/stream/route.ts:98-135`). `docs/runs.md:425-428` calls this "the one limit" and says "The whole log is in the database either way". But `runEvents` pages forward only (`orchestrator.ts:1182-1185`, `afterId`), and nothing in the UI reaches those events. The long runs are the ones most worth reading back.
- **Change**: Add `GET /api/runs/[id]/events?before=<id>&limit=`, reusing `runEvents`' row shape with a descending bound. Add a "Load earlier events" control above the log whenever the replay reported a cut.
- **Size**: M.
- **Touches**: `proposals/GapRegister/01-frontend.md` F4 shipped search and filter and states the log is "knowingly incomplete". This is the half F4 left. The byte cap in the stream route exists for page-load cost (the comment at `stream/route.ts:~98`), so older pages must be fetched on request, never replayed.
- **Value**: medium.
- **Not worth it if**: long runs are rare on real installs (unmeasured).

## Too big for this list

- One install-wide stop that also reaches assist children (reviews, conflict resolutions, chat turns, validations). "Stop everything" composes run and instance stops only (`src/lib/fleet.ts`, `run-lifecycle.md:13`), and a `run_reviews` row has no stop at all (`budgets-and-guards.md:46`). That needs a stop path designed for assists first.
- A per-segment history of a run, with each pick-up, park and restart as its own row carrying worked minutes and spend. `started_at`/`paused_ms` reset on a pick-up (`run-lifecycle.md:33`), so today a run's whole life cannot be totalled.

## Bugs filed

- Saving a run template skips the form's blank-limit check, storing "on but blank" as no limit — normal — `01cc1ab9-2cbd-4566-8cf9-469aa126d69a`
- Run form warns a window guard will be refused when the provider's percentage makes it work — normal — `0821945e-04eb-4fce-943b-59ed01839e25`
- "Start another like this" drops isolation for never-released runs and can strand the workspace picker — normal — `0d0810d9-7357-4885-bb56-c7836a6e9993`
- Validator's extra work cycle never runs: pre-cycle guard stops the run at the cycle cap — high — `c1dc14cf-ed4a-48e3-838c-bf6162b0a8e7`
- Live guard tick can stop a run using a finished cycle's guard, double-counting its spend — high — `73d5c74a-0349-4db7-928c-343abec20413`
- Refusal-park allowance is charged for guard parks and never reset by a pick-up — normal — `8ef928a2-ae55-42e8-9a9e-f4a5cad3eb95`
- Live-resume refund of a guard-cut cycle is unbounded, so maxIterations never ends the run — high — `6e6736b7-889b-421d-a1de-e3d395119ac1`
- MAX_EARLY_ENDS_PER_RUN resets on every park, restart and pick-up, so the refund cap is per segment — normal — `55ee6a0a-990f-4f65-a86a-e11e65b542b3`
- A run cut off by a graceful shutdown is picked up without RESTART_KILLED_NOTICE — high — `4ae8348f-1a4e-47cf-be17-363f2ba10c90`
- /runs "In flight" band drops running runs older than the newest 100 rows — normal — `f5f3bd0f-75a3-46b6-b567-1013068e9ae7`
- Paused-run card says the run holds its folder and names the wrong reason for a provider-refusal park — normal — `22610d48-3207-4430-b075-894754032680`
- Context ceiling ignores a run for 25k tokens past its pre-cut reading after a boundary cut or fresh start — normal — `4b221595-a4fc-4379-8384-55d3208aa076`

Twelve tasks. One of them covers two defects in one loader (the "Start another like this" entry).

## Bugs not filed

These are over the cap of twelve or below its severity bar. Each one names who established it. "Read by a sub-agent" means I did not re-check the lines myself.

- **A cut that removed nothing reopens the boundary payback gate** (low).
  - Where: `predictedPayback`'s receipt query (`orchestrator.ts:~11000`) lacks the `tokens_removed > 0` filter that the fork query beside it has (`net_bytes > 0`). The newest zero receipt makes `paybackTurns` null, so the gate prunes.
  - Established: executed by a sub-agent; I re-read the query.
  - Why low: the comment there (`:~11020-11027`) records that this gate leans optimistic on purpose because a natural-boundary cut "costs almost nothing".
- **Read guard and in-place pruning conflict** (normal/low; both are off by default).
  - What happens: with both on, the read guard refuses a whole re-read of a file whose earlier read `treat` just trimmed, telling the agent to "use what is already in your context".
  - Where: the ledger is keyed on `session_id`, which `treat` keeps (`src/lib/readGuard.ts:468-487`).
  - Established: read by a sub-agent.
- **Fork prune marks carry API-window tokens and show an unmeasured fork as "0 tokens"**, although the DTO caption says transcript tokens (low).
  - Where: `src/lib/contextPruning.ts:1146-1166`, `src/components/ContextOccupancy.tsx:207-234`.
  - Established: read by a sub-agent.
- **`liveGuardTick` runs the ceiling check's winnow subprocesses serially ahead of the budget scan**, which can delay the live guard. The comment at `orchestrator.ts:~10634` ("cheap enough to run first") predates the subprocesses (low; magnitude not measured). Read by a sub-agent.
- **The run page's "still running" tool strip goes stale after an SSE reconnect** (normal).
  - Where: `src/app/api/runs/[id]/stream/route.ts:169` sends the open-tool set only when non-empty. The page never clears `liveTools` on reconnect (`src/app/runs/[id]/page.tsx:849-854`). `docs/agent/architecture.md:291` says the frame is sent unconditionally.
  - Established: read by a sub-agent.
- **"Stopped by one of your limits" shows on a run the operator stopped after a guard-stop and a pick-up**, and it ignores `enforceable: false` (normal/low).
  - Where: `src/app/runs/[id]/page.tsx:1043-1052`. `src/lib/notify.ts:~232` already applies the right rule.
  - Established: read by a sub-agent.
- **"Set aside in 12m" renders in the future tense on a finished run.** `nowTick` is frozen at mount for terminal runs (`src/app/runs/[id]/page.tsx:1003-1008`, `:1478`) (low). Read by a sub-agent.
- **Stop on a process that does not own the data directory** reports "Stopping" and writes a "Stopped by operator." row while the owner's loop carries on. `stopRun`, `setRunAside` and `setRunPriority` do not ask the lock (`orchestrator.ts:10461`), unlike `resumeRun`/`reopenRun` (low; rare precondition). Read by a sub-agent.
- **The Fleet card is read once on mount** (normal).
  - What happens: after the restart notice's "Pick up N", runs start while the card still says nothing is in flight and "Stop everything" stays disabled until a reload. `RestartClosed`'s docblock (`src/components/RestartClosed.tsx:28`) claims the opposite.
  - Where: `src/components/FleetControls.tsx:58-65`, `:137`.
  - Established: read by a sub-agent.
- **"Stop everything" sends one `run.blocked` webhook per waiting run** while the runs it actually stopped are silent (normal).
  - Where: `src/lib/fleet.ts:136` → `blockWaitingRun` (`orchestrator.ts:4887`) → `NOTIFY_STATUSES` (`src/lib/notify.ts:107-111`).
  - Established: executed by a sub-agent. `notifiableEvent` gave `run.blocked` for the waiting run and `null` for the stopped one.
- **A graceful restart sends no webhook and writes no `boot.reconciled` event**, while a crash does both.
  - The `shutdownRuns` docblock (`orchestrator.ts:12210-12213`) promises "a `shutdown` event and its outbound webhook".
  - Normal; medium-low confidence, because a restart is often the operator's own act. Read by a sub-agent.
- **A crash, SIGKILL or OOM kill loses the in-flight cycle's spend.**
  - Where: `reconcileOnBoot` clears `active_started_at` before anything reads it (`orchestrator.ts:12601-12606`), and `reconcileInterruptedCycles` is called only from `shutdownRuns` (`:12311`). So `spent_usd_est` and the install ceiling miss that cycle.
  - Normal. Read by a sub-agent. `concurrency-and-ownership.md:16` records the graceful half, so check whether the crash half is a known gap before filing.
- **The new-run form's model copy misleads.** "Runs on <agent model>" leads (`src/app/runs/new/page.tsx:1554-1560`) even though `createRun` writes `settings.defaultModel` onto every run that names none (`orchestrator.ts:3924`) and `--model` beats the agent's model. `/agents` still says "What the delegated turn runs on" (`src/app/agents/page.tsx:299`) (normal/low). Read by a sub-agent.
- **`applySeed` and `budgetFromForm` drop `maxRunTokens` and `maxRunCostFactor`**, so loading a template that has them and pressing Update erases them (`src/app/runs/new/page.tsx:1040-1071`, `src/app/runs/new/budgetPayload.ts:39-59`) (low; only settable through the API). Executed by a sub-agent: stored `2000000 3`, after update `null null`.
- **Switching the provider to Codex keeps a Claude model id in the model box** (`src/app/runs/new/page.tsx:1633-1645`). Separately, `createRun` logs "started as the X agent" for Codex runs, which drop the agent (`orchestrator.ts:4021-4031`) (low). Read by a sub-agent.
- **After Start, the form keeps saying "Starts an unattended agent in X" for the next run in the same folder**, which will queue. `/api/folders` is read once (`src/app/runs/new/page.tsx:610`, `:2593-2595`) (low). Read from source by me.
- **The Agent work card reads only the current `session_id`** (`src/app/api/runs/[id]/agent-cost/route.ts:38-56`), so a run that fresh-started (`freshStartContextTokens`, off by default) under-reports its earlier sessions (low confidence). Read by a sub-agent.

## Seen outside my territory

- `scripts/discord-relay.mjs:220`: the relay answers 204 before forwarding, so a deleted or rotated Discord webhook still records a successful delivery and `/api/status` `consecutiveFailures` never rises (read by a sub-agent).
- `src/app/settings/page.tsx:3370`: the default-model hint says the default applies "when neither it nor its template nor its agent names one". `createRun` (`src/lib/orchestrator.ts:3924`) applies it ahead of the agent's model (read by a sub-agent).
