# The module map

[← architecture index](../architecture.md)

Read before editing `toolComposition.ts`, or before adding, removing or re-purposing a module in `src/lib/`. The entries for `toolInventory.ts`, `stacks.ts`, `stackRequests.ts`, `scripts/apply-stacks.mjs`, `plugins.ts`, `vaultSkill.ts`, `readGuard.ts`, `fileCostNotice.ts` and `tmpdirNotice.ts` are in [module-map-agent-tooling.md](module-map-agent-tooling.md).

The subscription pipeline:

```
transcripts.ts  scan + dedupe → UsageEntry[]      (incremental byte-offset reads)
pricing.ts      per-model rates, cache multipliers → costUSD per entry
settings.ts     limitConfig() applies reserved headroom → LimitConfig
planUsage.ts    GET /api/oauth/usage → the account's own utilisation, cached
windows.ts      buildSnapshot() → 5-hour blocks, weekly rollup, burn, projection
                buildPeriods()  → calendar day/week/month history, display only
budget.ts       evaluateBudget(policy, snapshot, progress) → allow / block + code
                evaluateInstanceBudget(...) → the same verdict for a whole
                press of Run on a workflow, sharing readWindowGuard with it
orchestrator.ts the run loop: guard → spawn claude → parse stream-json → repeat
git.ts          the one way this app runs git — argv only, env scrubbed
diff.ts         <base>...<branch> as a rendered, budgeted file list + patches
review.ts       one-shot Claude calls outside the loop: review, conflict resolve
land.ts         merge preview, AI conflict resolution, landing, deletion, inventory
projects.ts     every git folder in the mounts: its branch, upstream, ahead/behind
                as of the last fetch and unmerged branches; and the push of its
                current branch and the fetch of its upstream, each a press
mergeQueue.ts   several branches landed one after another — rows in merge_queue,
                one worker per repository (that Set is the mutual exclusion),
                and nothing on the path carrying a clock
templates.ts    saved run configurations — form input, never a run
toolComposition.ts
                what is *in* the contexts this machine paid for — a second reader
                over the same transcripts, in parseCompactionBoundary's shape,
                denominated in characters of tool output. Not a fourth breakdown
                and not a cost source: a tool_result carries no usage block, so
                it reconciles to itself and never to a window total, and its type
                is an object of rows so nothing written for the three compiles
                against it
contextSamples.ts
                how full a live run's context is, sampled off its own transcript
                (or a Codex rollout) and kept as a series for the run page's
                chart. It measures and records and nothing acts on it: no
                interrupt, no cut. Its two bases, api and transcript, are
                different currencies and a series never mixes them silently
agents.ts       saved agents — form input, never a run: the role a run itself
                takes, carried onto a spawn by sessionAgentArgs as an --agents
                definition *and* an --agent selection, built on the one encoder
                every spawn site that can carry one uses. It holds no tool list
                and no permission mode, and it also reads the ambient
                definitions this app did not write, so a surface can say the
                registry is not the whole set. A run, a
                template, a chat proposal, a workflow block and the new-run
                form's own default may each name one: the run by a frozen copy
                on runs.agent, everything that is form input by id, and every
                door refuses a deleted one by name rather than falling back to
                none — the id-keyed doors through one shared agentRefusal, and
                the two that were shown a name (planEmission, createEmitted) in
                their own words, because a name is what those were shown
workflows.ts    saved graphs of run blocks — form input, never a run; one press
                of Run becomes one createRun per block, wired in topological order,
                one press of Stop halts every member through stopInstance, and a
                workflow-wide budget halts it through the same door between blocks.
                A block may instead be an *orchestrator* block: one headless turn
                that decides what to create next, whose runs then start with no
                approval — planEmission bounds what it may ask for, and
                planInstanceStep decides what happens to the blocks behind it.
                A block may also be a *merge* block: no agent at all, it puts
                each predecessor's branch onto the target that branch's own run
                recorded, through mergeQueue.enqueue, with an optional
                per-graph authorisation to pay for a conflict resolution
schedules.ts    when a saved workflow presses its own Run — the recurrence, the
                one timer, and decideSchedule: fire, skip, missed or nothing
canvasGraph.ts  the workflow canvas's own model — client-safe and pure: where
                a block sits, which is not in the graph, and the draft the
                validate and save routes are sent
unsavedWork.ts  leaving a page that has work in it — client-safe and pure:
                which clicks are an in-app navigation, and the one registration
                the exits that are not clicks ask first. beforeunload covers
                the closed tab and nothing else
chat.ts         the orchestrator chat: a conversation that proposes runs —
                ordered against each other, and whole workflows, none of which
                starts anything until a person approves it
repoSpend.ts    what each repository cost, over a span — a rollup of
                runs.spent_usd keyed by conflictKey's own mount identity.
                Reporting and never a guard: it reaches no meter, no snapshot
                and no verdict
repoReading.ts  what runs on each repository keep reading, failing at and
                colliding in — three pure readings over run_events and
                run_reviews rows, the edited/not-edited split, Dreaming's
                signatureOf, and the money per repository only. Reporting and
                never a guard, and no cost source
priorReads.ts   the prior-read pointer: the files earlier runs on a repository
                opened most, ranked ×0.9 per run back, proved to exist in the
                run's tree, and the arm — a hash of the run id, or the parent's
                for a continuation. Each repository's list is fixed the first
                time a run asks (prior_read_snapshots)
holdoutExport.ts  both pointer holdouts' evidence, copied out of run_events into
                tables no sweep reaches, ahead of every event sweep; pure
                readings of a prompt's blocks and of a call's path, then the
                pass that keeps a row at least as good as it was
holdoutReadback.ts  the prior-read holdout read back from those tables: who is
                counted, what a run read, which (cycle, path) pairs are scored
                and the arms' difference; compliance, displacement and outcome
                share no figure. Reporting, never a guard
holdoutInference.ts  the plan's primary, looks and interference check, pure over
                rows the readback hands it: a difference stratified by
                repository with a studentised permutation p-value, two
                O'Brien-Fleming looks on the data as it stood when the smaller
                arm reached its size, and a held-out run's reading regressed on
                the treated share around it. Deterministic; never a guard
fleet.ts        the three controls that act on the whole install — stop
                everything, hold new work, pick several runs back up. It owns no
                transition of its own: it composes stopInstance, stopRun,
                stopWaitingRun and reopenRun, and the hold is one settings row
                seven sites that start work read
fleetPickUp.ts  the pick-up sheet's wire, client-safe: which of its fields reach
                reopenFleet, so an untouched one never overwrites a run's own
workspace.ts    the folder walk, shared by /api/folders and the chat's tools
tasks.ts        the taskboard: one board across every mount, and the only
                module that touches the tasks table. A task is not a run — it
                claims no folder, takes no slot and starts nothing — and which
                actor kind may move one to which status is a pure function
                beside the storage, because a wrong edge closes work nobody did
cycles.ts       the event stream segmented into work cycles — client-safe, and
                the only reader of where one cycle's output ends
liveStream.ts   the pure half of /api/runs/live/stream, the one SSE connection
                /runs/live holds for every running run: a tail of
                LIVE_TAIL_EVENTS per run, a replay byte budget split evenly
                across runs, each event cut to the line a tile draws, and
                which runs to follow against the runs table. The route reads
                the bus's "*" topic (subscribeAll) and answers no Last-Event-ID
                — a reconnect replays each tail and the page replaces it.
                GET /api/runs/live, the tiles' figures, is a poll beside it
liveTiles.ts    that stream folded into the page's tiles — client-safe and
                pure: a join replaces a tail, ready drops the tiles of runs
                that ended while the connection was down
ops.ts          what the two background timers last did, and how often they
                failed — in memory, because it answers "is *this* process
                making progress" and a counter that outlived it would not
requestLog.ts   one durable line per mutating request: method, path, status,
                the id it named, which credential class, from where — and
                deliberately no body, no query string and no credential
retention.ts    what expires and what never does — no runs row is ever deleted,
                the evidence behind one goes on three separate horizons, and
                every sweep asks the database what is live rather than asking
                a file its age
health.ts       what /api/health answers with, and the one thing it is for:
                being false when this server cannot do its job
status.ts       what /api/status answers with — gauges for a monitor rather
                than a person, behind a read-only credential of its own
db.ts           SQLite: every table migrate() creates, and there are 48 —
                runs, run_deps, run_events, run_reviews, run_templates,
                fork_attempts, resume_probes, agents, settings,
                chat_sessions, chat_messages, chat_proposals,
                chat_questions, chat_turn_spend, workflows,
                workflow_instances, workflow_instance_runs,
                workflow_instance_blocks, workflow_schedules,
                context_samples, context_compositions,
                context_composition_children, prune_decisions,
                prune_receipts, dreaming_nights, dreaming_notes,
                dreaming_pending, merge_queue, ops_events, request_log, otlp_requests,
                webhook_deliveries, auth_sessions,
                login_attempts, tasks, task_comments, task_deps,
                run_tasks, run_squashes, local_provider,
                workflow_review_items, stack_requests,
                stack_request_runs, validation_queue, holdout_runs,
                holdout_cycles, holdout_tool_events, prior_read_snapshots. The list is a
                completeness claim, so
                check it against
                `grep -oE 'CREATE TABLE IF NOT EXISTS [a-z_]+'
                src/lib/db.ts | sort -u | wc -l` when adding one — a plain
                `grep -c` says 50 and counts two comments
```
