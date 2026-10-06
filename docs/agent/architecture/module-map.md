# The module map

[← architecture index](../architecture.md)

Read before editing `plugins.ts`, `vaultSkill.ts`, `readGuard.ts`, `fileCostNotice.ts`, `toolComposition.ts`, `stacks.ts` or `scripts/apply-stacks.mjs`, or before adding, removing or re-purposing a module in `src/lib/`.

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
mergeQueue.ts   several branches landed one after another — rows in merge_queue,
                one worker per repository (that Set is the mutual exclusion),
                and nothing on the path carrying a clock
templates.ts    saved run configurations — form input, never a run
toolInventory.ts what this install's agents can actually run, and how sure the
                app is of each one. Four readings from four places — declared
                (UF_PY_TOOLS / UF_GH_EXTENSIONS), installed (the gh extensions
                volume, and later a stack's receipt), reachable (a PATH
                resolution over the server's own PATH, which *is* the child's
                because childEnv strips no PATH), observed (a bounded, cached
                run_events scan) — composed into one word by `composeState`. A
                layer is never inferred from the layer above it, and
                `installed` is the only word needing all four to agree, because
                it is the one an operator acts on without reading further. The
                two kinds of event do not carry the command in the same place
                — `tool` at $.input.command, `tool_error` at $.command — and a
                query reading both the same way counts zero failures for ever.
                Read by /api/tools and by status.ts's two integers; nothing
                writes through it, because add, remove and change are all a
                file edit on the host and a restart.
stacks.ts       the read-back over what apply-stacks.mjs installed, and the
                only reader of the receipts. A *reader*: it installs nothing,
                removes nothing and repairs nothing, because the applier runs
                in the one window of the container's life with no agent alive
                and this runs in a request. `parseReceipt` validates at the
                boundary a shell script writes across — the truncated receipt a
                container killed mid-write leaves behind must read `unreadable`
                and never a partial `ok`, since a partial `ok` is the read-back
                reporting an install that did not happen. It also
                projects what every ok stack grants a cycle
                (`Bash(<bin>:*)` onto --allowedTools) and denies it
                (`Bash(<entry>:*)` onto --disallowedTools), cached for the life
                of the process because that is the exact life of the receipts.
                `agentEnvironment` is what every builder for a child dropped to
                the agent uid starts from: the server's environment with
                `stackEnvironment`'s block under it, so the operator's value
                wins, and `agentPath()` over it. Never `process.env` itself —
                the server is root, and so is winnow under it.
                There is **no `stacks` table** and must not be: the receipts
                are the state and they are per boot, so the one question a
                monitor asks — what did *this* boot find wrong — is answered by
                a set nothing outlives a restart with.
stackRequests.ts
                what runs asked the operator to install through
                `request_stack`, and which runs wait on each — text an agent
                wrote for a person to read, never anything the app applies.
                It records requests (`pending` or `declined`) and never
                installs: whether one is answered is `stackSatisfaction` over
                the receipts, asked by both the tool and the release so the two
                cannot disagree. `decideStackWait` is the release's pure
                decision; the status writes are `orchestrator.ts`'s
                `releaseStackWaits`. `checkStackDraft` asks the image's own
                `scripts/apply-stacks.mjs` whether a draft would parse, loaded
                at runtime rather than bundled. See
                docs/agent/run-lifecycle/waiting-for-stack.md.
scripts/apply-stacks.mjs
                not in src/ and not bundled into it — it runs from the
                entrypoint before `exec "$@"`, because PATH has to be final
                before the server starts and childEnv copies the server's
                environment into every agent, and the server reaches its
                parser only by loading the image's copy at runtime
                (`checkStackDraft`). Parse, digest, download, verify,
                unpack, link, write receipts. Three verbs and nothing else:
                `archive` executes nothing it downloads, `uv-tool` and
                `npm-global` run the package's own install hooks as the agent
                uid. Never a shell — every URL, filename and digest on its argv
                came out of a file a stranger wrote. **C1: the image ships
                nothing under /var/lib/uf-stacks, ever.** A named volume takes
                its contents from the image exactly once, at creation, so
                anything the image puts at that mount point is visible on a
                reviewer's fresh install and masked on every install that
                already exists — which is the one breach here invisible to
                whoever commits it, and the reason deployment.test.ts asserts
                the Dockerfile names no path under it.
plugins.ts      Claude Code plugins found in the mounts, switched on per install
                and carried onto every work cycle as --plugin-dir. Deliberately
                *not* `claude plugin install`: compose binds the operator's
                ~/.claude onto /home/node/.claude, so the CLI's own registry is
                one file shared by host and container and it records absolute
                paths — whichever side installs last silently breaks the other,
                since a plugin path that does not resolve is skipped with a
                warning and exit 0. So this app owns the list, in its own
                settings row (never a key of Settings — the settings form sends
                the whole blob on Save, and this decides what code every agent
                loads). Two invariants, both silent when broken: the flag goes
                on **every** cycle's argv because --plugin-dir does not survive
                --resume, and a stored path is proved contained in a mount again
                at *use* time, not just when it was switched on, because what it
                becomes is a directory whose hooks the container executes. An
                enabled plugin that stops resolving, or whose manifest stops
                parsing, is withheld and reaches the run's own log rather than
                being dropped. Switching off proves nothing: the entries that
                most need it are the ones the enable proofs would refuse
vaultSkill.ts   the vault-lookup skill, delivered the same way and for the same
                reason: a plugin directory generated per spawn and passed as
                --plugin-dir, never installed into ~/.claude/skills, where it
                would break the operator's host sessions exactly as above. Its
                switch is its own settings row and is refused with no knowledge
                base configured. It is *generated* rather than shipped as a file
                because it must name the vault's absolute path as the child sees
                it, and whether that vault has a ranked search is discoverable
                only by looking — and it goes to /run/uf-skills rather than
                DATA_DIR, which is 0700 root and on the CLI's managed denyRead
                list, so a skill there is unreadable by the agent uid on exactly
                the hardened install this is for. The vault also needs --add-dir
                or the skill names a path the run may not read; measurement says
                that flag grants **write**, so the skill's own text is the only
                thing forbidding writes into the vault
readGuard.ts    the second *generated* directory on that same --plugin-dir list
                — which now carries three kinds of entry, the plugins found in
                the mounts, the vault skill and this — and the only one shipping
                hooks rather than a skill, so unlike the vault skill it puts
                nothing in the window and needs no --add-dir. It is a PreToolUse
                hook on Read that refuses a repeat of a read this session has
                already made (size and mtime unchanged) and a whole
                read past settings.readGuardMaxTokens. A *ranged* read is tested
                first and never refused, so nothing it says no to becomes
                unreachable — an agent stranded by a guard burns work cycles,
                which costs more than the tokens saved. /run rather than
                DATA_DIR for vaultSkill.ts's reason, root-owned so no agent can
                rewrite the script; the per-session ledger is a *sibling*
                directory the agents may write. Off by default: the savings it
                attacks are measured and that refusing a read produces them is
                not, and it is not confirmed that --plugin-dir registers a
                plugin's hooks as well as its skills
fileCostNotice.ts
                what a Read of this repository's largest files costs, ranked on
                tokens x how often this fleet has read each one, generated once
                at createRun and frozen on runs.file_cost_notice — the appended
                system prompt is part of the cached prefix, so a version of this
                text that differed between two cycles of one run would cold-start
                every token behind it. Every failure degrades to "", because a
                run that could not be created for want of a cost hint would cost
                infinitely more than the hint saves
tmpdirNotice.ts
                the literal $TMPDIR a sandboxed Bash command gets, derived from
                the child's uid and inherited environment (never a constant) and
                withheld wherever it cannot be known; taken once at createRun and
                frozen on runs.tmpdir_notice, for fileCostNotice.ts's reason
toolComposition.ts
                what is *in* the contexts this machine paid for — a second reader
                over the same transcripts, in parseCompactionBoundary's shape,
                denominated in characters of tool output. Not a sixth breakdown
                and not a cost source: a tool_result carries no usage block, so
                it reconciles to itself and never to a window total, and its type
                is an object of rows so nothing written for the five compiles
                against it
intakeFilter.ts what winnow's intake filter kept off the wire, read from its own
                ledger at /var/lib/winnow/filter.jsonl — the one file here
                that no part of this app writes. A counterfactual, never a
                fourth cost source: the meters are priced from usage frames and
                a usage frame reports the request the filter had already
                rewritten, so this money is already absent from every figure
                beside it. The filter is stateless and re-drops the same result
                on every later request still carrying it, so a ledger line is a
                *request* and not a removal — de-duplicating on tool_use_id, or
                on (session, tool, rule, bytes) for lines written before winnow
                carried one, is what separates 14 results from 334 and is the
                whole of why this is a module rather than a SUM. It joins
                request_id to UsageEntry.requestId for the clock, the model and
                the turns that followed, so it is bounded by the transcript
                horizon exactly as the prune total is, and it is read behind a
                minute-long TTL with single-flight because the dashboard polls
                every ten seconds and the ledger grows with every request the
                fleet makes. That join is also what windows it: session and
                weekly are three nets off one pass, sliced by resultsSince on
                the anchor turn's instant, and a result that joined to nothing
                is left out of both rather than guessed into one — so the two
                window figures are a floor by much more than the total is
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
fleet.ts        the three controls that act on the whole install — stop
                everything, hold new work, pick several runs back up. It owns no
                transition of its own: it composes stopInstance, stopRun,
                blockWaitingRun and reopenRun, and the hold is one settings row
                six sites that start work read
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
db.ts           SQLite: every table migrate() creates, and there are 41 —
                runs, run_deps, run_events, run_reviews, run_templates,
                fork_attempts, resume_probes, agents, settings,
                chat_sessions, chat_messages, chat_proposals,
                chat_questions, chat_turn_spend, workflows,
                workflow_instances, workflow_instance_runs,
                workflow_instance_blocks, workflow_schedules,
                context_samples, context_compositions,
                context_composition_children, prune_decisions,
                prune_receipts, dreaming_nights, dreaming_notes,
                merge_queue, ops_events, request_log, otlp_requests,
                webhook_deliveries, auth_sessions,
                login_attempts, tasks, task_comments, task_deps,
                run_tasks, local_provider,
                workflow_review_items, stack_requests,
                stack_request_runs. The list is a
                completeness claim, so
                check it against
                `grep -oE 'CREATE TABLE IF NOT EXISTS [a-z_]+'
                src/lib/db.ts | sort -u | wc -l` when adding one — a plain
                `grep -c` says 43 and counts two comments
```
