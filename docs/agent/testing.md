# What the test suite covers, and what earns a test

> Extracted verbatim from `CLAUDE.md`, which grew past the size Claude Code will
> load into a session. Each paragraph records a correctness or safety decision
> whose violation is silent — nothing throws, nothing fails to typecheck.
> **Read before editing any src/**/*.test.ts, or when deciding whether a change needs one.**

This page is the index. The bar every test is held to comes first, as it was written; then one section per topic file under `testing/`, each with a table of the test files whose grounds that file holds. Read the bar, then the one topic file your change touches.

## The bar

There is **no linter run** (`eslint.ignoreDuringBuilds` is on), and `npm test` covers a deliberately short list: `overlaps()`, `walkQueue()` — which is `selectPromotable()` with its reasons kept rather than discarded, and which earns cases of its own on the half the promoter never had to get right: the three waits a queued run can be in are indistinguishable from outside, so a blocker naming the wrong one renders a confident, well-formed and false sentence, which is what shipped — every run the concurrency cap was holding read "next up — starts when the folder frees" with its folder free and nothing ahead of it, because the only thing the page had was `queuePosition`, which counts folder overlaps and is 0 for a cap block.

Every one earns it on the same grounds — pure functions whose failure modes are silent and expensive (two agents in one working tree, or a run queued behind something that will never move, or a run told to start after another one that is never woken and never ended, or one started on top of work that never happened, or a whole parked fleet un-parked into folders other agents are already writing in, ended when it only had to wait out a window, or left parked for ever on a refusal that was never going to clear, or a corrected reason rewritten and logged once a minute for every parked run into a table with no retention; a run that never terminates, or that parks instead of ending; a work cycle that stops producing output and holds its folder, its checkout slot and one of `maxConcurrentRuns` until somebody restarts the container, or a healthy cycle killed for going quiet while one long tool call ran, or a hung one filed as though somebody had chosen to stop it; a wall that stops being recognised, or a run that waits hours for money that will not arrive; a blip that ends a run holding a live session, or three billed re-spawns into a wall that will refuse every one; a cycle billed to say `DONE` twice, or one that restates a task already half done; a window that rolls over while the provider is still counting it, or that reopens after it closed, or a percentage read a hundred times too small because the body says percent where the headers say fraction, or a window with no reading reported as a window at zero, or a column of agent names that says the operator wrote down one it has never seen, or that says nobody wrote down any because nothing looked, or one run's split reported as a run whose agents spent nothing when nobody could measure it at all; an evening's work filed under the wrong day because the container cuts its days in UTC, or a percentage printed against a ceiling that is off by the length of the month it spans, or a gap between two buckets that drops spend out of the history with nothing on the page to say so; a file list that shifts by one at the first rename, or a diff that is quietly a third of the change, or a gutter whose second hunk goes on counting from the first and so names, for the rest of the file, lines that hold something else; a merge into a dirty tree or onto a branch the work does not belong on; a conflicting file dropped from the list because a message did not parse, or a markdown heading rendered as a clash; a billed resolution bought for a merge that was going to be refused anyway, or ten identical refusals where one was the answer, or a set of merges landing into somebody's own checkout with nothing on the page naming them and so no way to stop them, or a branch with committed work on it that no page in this app reaches and no count on any page says is there; a saved configuration that widens what an agent may do, or that can never be started, or a run whose every work cycle dies at the spawn because it is started as an agent the CLI will not register, or one whose `--agent` names something its own `--agents` did not define, or a saved agent shadowing a built-in so that a run is something other than the thing its name says, or an ambient definition named off its filename and so named as an agent that does not exist, or a run started as an agent that was deleted an hour ago and so started as nobody — which is bit-for-bit a run that was never given one, arriving from inside this app rather than from the CLI — or a template that names one and can be saved and never started, or a form for writing one down that grows a field an agent may not carry and so a saved record that decides what a run may do, or a saved name a file on disk also answers to with nothing on the page that would let anyone notice; a saved graph instantiated in an order that starts an agent before the work it extends exists, or one whose loop is noticed only by the rows that sit `waiting` for ever, or one that runs to the end with its tail missing because the blocks behind a run somebody picked up again stayed written off for ever, or a graph reported as still working for ever after its last member settled — and, the same word the other way, one whose tail was written off behind a block that decided nothing reported as one that reached its end — or a graph stopped whole with one member left spending under a page that says it is stopped, or a finished run rewritten as stopped and the record of work that landed gone with it, or a workflow-wide limit that never trips because every block's cycle is still in flight and reported nothing, or one refused as having no ceiling while the provider was reporting a percentage for that very window, or a block that starts one more billed agent than the number a person agreed to, or one that starts an agent in a repository nobody pointed it at, or a block given an agent it does not have — a spawn that fails every cycle, arriving from a graph this app saved — or a run emitted "as the reviewer" that starts as nobody, or a merge block named an agent when it starts no child that could be one, or a set of runs that wait for each other for ever because the graph was written by a model, or a block left holding a prompt behind a decision that was never going to come and nothing on the page to say so, or the tail of a graph written off by the same restart that deliberately kept its head, under a sentence saying the run in front of it had been closed out while that run was parked and about to resume, or a deciding block that spent money, started nothing and ended the branch of the graph behind it with no account of which of the three ways it did that — it said there was nothing worth doing, this app refused the runs it asked for, or it never reached a decision at all; a graph pressed twice for one occurrence because a restart made up a window that passed while the container was down, or one that goes on pressing Run into a refusal it will meet every hour, or a wall-clock time read in the container's UTC and so an hour out for half the year, or a day silently skipped once a year because the clocks moved through it, or a schedule that has quietly stopped deciding and reads exactly like one between occurrences; a credential block git discards whole because its count disagrees with its pairs; a guard read off a model's suggestion instead of off the guard set a person wrote, or an agent handed a heading with no instructions above it, or an agent ordered to commit by a flag that forbids committing, or an agent an operator picked that never reached the argv, or a delegation that is a tool call followed by silence for as long as the sub-agent takes, or an agent that ends the server supervising it — and every run in flight with it — by matching a process name that describes two processes, or a refusal that leaves a run looking like it chose to do nothing, or a command that failed inside a tool call and so a run that pushed nothing reading exactly like one that did, or a proposal approved as one agent and started as none — the same bit-for-bit run, reached this time through a card a person read and agreed to — or one whose guards moved because it named an agent at all, or a chat turn billed without the thread it is answering, or issues read out of a stranger's repository because a remote URL was parsed loosely, or a mid-cycle spending limit reading a figure that cannot move because the run was never told to report one; or one run's leftovers committed onto the branch of whichever run took its checkout slot next, or a branch destroyed by a request that was aimed at a different one, or a work cycle's report filed under the cycle before it, or a sub-agent's account of the piece it was handed presented as the run's account of the whole task, or a thread told that proposals it has never held were already decided, or a run told to wait for another one and started immediately instead — which is bit-for-bit a run that was never told, with both agents then in one checkout in whatever order the queue felt like — or a batch created in the order the page happened to display, so a proposal is refused for naming a run that was going to exist one line later, or a chat turn that never settles because a grandchild is still holding the pipe its answer already arrived through, or a run cut off by its cycle cap picked up with the prompt written for one that said it was finished; or an agent put to work in the operator's own checkout, on whatever branch it was standing on and unable to commit, because the isolated ones had run out — announced as a note about waiting its turn — or a second agent told to extend the first one's work and started on the target branch with none of it in sight, or a review and a merge that cover only the last link of a chain because the range was measured from the run before it rather than from where the chain began, or one branch offered for landing once per run that ever touched it, or a branch destroyed under a run that has not started yet, or two repositories in one mount handed the same checkout directory because their paths reduce to one name, which is every isolated run on the second of them failing at `git worktree add` for ever; or a run eight minutes into its first cycle displayed exactly like one that was marked running and never started, or a dead run still claiming a cycle in flight, or a failed poll that renders as an empty notice and so goes on looking like a thread still thinking; or a link drawn on the canvas and saved under a condition nobody chose, or a canvas that never finishes laying out a graph it is required to be able to draw, or a block placed under another one and so invisible while still starting an agent, or a block that cannot be saved at all because it is refused over an agent the panel stopped showing when its kind changed; or a container that starts as many Claude processes as it is asked to and takes the host — and the server supervising every run in it — down with them, or an operator's chat turn refused to make room for a merge block that spawns no process at all, or a workflow block written off for ever because a review happened to be running when its turn came; or twenty-five unattended agents holding the server's own uid under a container that reads, from every page and every log line, exactly like one that separated them; or two mounts onto one host directory reported as two repositories with half the money each, or a repository's bill quietly missing every run that was not in a git checkout; or a second server that has correctly worked out it owns nothing and admits a run anyway, so two processes each decide one folder is free inside their own event loop and two agents start work in one checkout, or an owner that stalled for one git call, lost the directory, restamped the file over whoever took it and went on writing to a database two processes now believe is theirs; or a run confined to nothing because the one path its write set had to name was thrown away as a glob pattern, or every window and every budget guard reading zero because that set forgot the directory the transcripts are written into, or a boundary reported as in place while the policy behind it named so little that every command ran unwrapped — and, the same word the other way, an ordinary permission error filed as a policy decision, which sends somebody to widen an allowlist that was never the problem).

The twelve modules at the end of that list are the ones whose grounds are not obvious from the function's name, and each states them in its own file's docblock.

That is the bar for adding another, not a general testing convention to follow.

`npm run typecheck` plus a `docker compose up --build` smoke test is still the real verification loop, and `docs/verification.md` records what was checked by hand — including its "Not yet verified" list, which must stay honest.

Seventeen are renderings rather than functions — every `*.test.tsx` in the tree, which is the whole of that class and is countable as `find src -name '*.test.tsx' | wc -l`.

## [Run queue and admission](testing/run-queue-and-admission.md)

| Test file | Also in |
|---|---|
| `budget.test.ts` | [harnesses] |
| `diff.test.ts` |  |
| `land.test.ts` | [landing], [harnesses] |
| `orchestrator.test.ts` | [cycle], [argv], [ceiling], [pruning], [parsers], [budgets], [pricing], [landing], [sandbox], [harnesses] |
| `patch.test.ts` |  |
| `planUsage.test.ts` |  |
| `queueOrder.test.ts` |  |
| `runOrigin.test.ts` |  |
| `slotProbes.test.ts` |  |
| `windows.test.ts` | [harnesses] |

## [Work-cycle prompts, endings and deadlines](testing/work-cycle-prompts-and-endings.md)

| Test file | Also in |
|---|---|
| `cycleDeadline.test.ts` |  |
| `resumeControl.test.ts` |  |

## [Fleet stop, hold and shutdown](testing/fleet-and-shutdown.md)

| Test file | Also in |
|---|---|
| `fleet.test.ts` | [harnesses] |
| `shutdown.test.ts` |  |

## [Data directory ownership, retention and migrations](testing/data-dir-retention-and-migrations.md)

| Test file | Also in |
|---|---|
| `dataDirClaim.test.ts` |  |
| `retention.test.ts` | [stacks], [harnesses] |
| `retentionSweep.test.ts` |  |
| `schemaMigration.test.ts` |  |

## [Budgets, spend guards and the run form's limits](testing/budgets-and-spend.md)

| Test file | Also in |
|---|---|
| `assistBudget.test.ts` |  |
| `budgetPayload.test.ts` | [pricing] |
| `costBaseline.test.ts` |  |
| `costSplit.test.ts` |  |
| `formProblems.test.ts` |  |
| `formSeed.test.ts` |  |
| `installSpend.test.ts` | [chat], [harnesses] |
| `instanceBudget.test.ts` |  |
| `parksAndRefunds.test.ts` |  |
| `validationGrant.test.ts` |  |

## [Pricing, the model catalogue and model choice](testing/pricing-and-models.md)

| Test file | Also in |
|---|---|
| `modelAdoption.test.ts` |  |
| `modelCatalogue.test.ts` |  |
| `pricing.test.ts` |  |
| `templates.test.ts` | [argv] |

## [Transcript scanning and the usage snapshot](testing/transcripts-and-snapshot.md)

| Test file | Also in |
|---|---|
| `snapshotCoalesce.test.ts` |  |
| `transcriptCache.test.ts` |  |
| `transcriptCompaction.test.ts` |  |
| `transcriptDedupe.test.ts` |  |
| `transcripts.test.ts` | [argv] |
| `transcriptScan.test.ts` |  |
| `transcriptScanMemo.test.ts` |  |
| `transcriptWalk.test.ts` |  |

## [Context pruning, winnow's intake filter and pruned transcripts](testing/context-pruning.md)

| Test file | Also in |
|---|---|
| `contextPruning.test.ts` | [ceiling] |
| `intakeFilter.test.ts` |  |
| `pruneStatement.test.ts` |  |
| `pruneTranscript.test.ts` |  |
| `transcriptOwnership.test.ts` |  |

## [Context samples, the live tick and the context ceiling](testing/context-samples-and-ceiling.md)

| Test file | Also in |
|---|---|
| `contextCeilingRace.test.ts` |  |
| `contextSamples.test.ts` |  |

## [Workflow instances, blocks and schedules](testing/workflow-instances.md)

| Test file | Also in |
|---|---|
| `bootBlocks.test.ts` | [harnesses] |
| `canvasGraph.test.ts` | [stacks] |
| `format.test.ts` | [tasks], [stacks] |
| `haltedMembers.test.ts` |  |
| `instanceReading.test.ts` |  |
| `schedulePut.test.ts` |  |
| `src/app/api/workflows/[id]/route.test.ts` |  |

## [Loop blocks and their passes](testing/workflow-loops.md)

| Test file | Also in |
|---|---|
| `loopBoardCount.test.ts` |  |
| `loopMergeOwnership.test.ts` |  |
| `loopSection.test.ts` |  |
| `workflows.test.ts` | [argv], [pricing], [workflows] |

Units that are about no test file in the tree:

- Deliberately **not** tested: `STATUS_TONE`, `GLYPH` and `describeRun`, where the compiler is the test and a rendering earns one only when it pins something a reader would act on that is wrong in a …

## [Chat turns, threads and the request helpers](testing/chat-turns-and-threads.md)

| Test file | Also in |
|---|---|
| `chat.test.ts` | [proposals], [argv], [pricing], [task-deps], [landing] |
| `chatOrder.test.ts` |  |
| `chatRequest.test.ts` |  |
| `chatStream.test.ts` |  |
| `chatThread.test.ts` | [proposals] |
| `chatTurn.test.ts` |  |
| `jsonRequest.test.ts` |  |
| `src/app/api/chat/[id]/route.test.ts` |  |

## [Chat proposals, questions and search](testing/chat-proposals.md)

| Test file | Also in |
|---|---|
| `dto.test.ts` |  |
| `proposalContinuation.test.ts` |  |
| `remoteReads.test.ts` |  |

## [Taskboard authority, moves and a run's board](testing/taskboard-authority-and-moves.md)

| Test file | Also in |
|---|---|
| `tasks.test.ts` | [argv] |

## [Task comments, dependencies, the validator and the board's MCP surface](testing/taskboard-comments-deps-and-mcp.md)

| Test file | Also in |
|---|---|
| `src/app/api/mcp/route.test.ts` |  |
| `taskComments.test.ts` |  |
| `taskDepGraph.test.ts` |  |
| `taskDeps.test.ts` |  |
| `validation.test.ts` |  |
| `validationSettle.test.ts` |  |

## [Landing, conflict resolution and the merge queue](testing/landing-and-merge-queue.md)

| Test file | Also in |
|---|---|
| `conflictedPaths.test.ts` |  |
| `deleteBranch.test.ts` |  |
| `delivery.test.ts` |  |
| `git.test.ts` |  |
| `landGate.test.ts` |  |
| `landAfterVerify.test.ts` |  |
| `landUnwind.test.ts` |  |
| `mergeQueue.test.ts` | [argv] |
| `mergeQueueDrain.test.ts` |  |
| `mergeQueueOrder.test.ts` |  |
| `mergeQueueView.test.ts` |  |
| `repoLock.test.ts` |  |
| `resolutionBudget.test.ts` |  |
| `resolutionSilence.test.ts` |  |
| `resolveCheckout.test.ts` |  |

## [Run page panels: background tasks, touched files and conflict maps](testing/run-page-panels-and-file-maps.md)

| Test file | Also in |
|---|---|
| `conflictMap.test.ts` |  |
| `runTasks.test.ts` |  |
| `runTouches.test.ts` |  |
| `touchedMap.test.ts` |  |
| `touchReplay.test.ts` |  |

## [Spawn argv, the child environment and appended notices](testing/spawn-argv-and-child-env.md)

| Test file | Also in |
|---|---|
| `agentRegistry.test.ts` |  |
| `agents.test.ts` |  |
| `fileCostNotice.test.ts` |  |
| `plugins.test.ts` |  |
| `privsep.test.ts` | [knowledge] |
| `sandbox.test.ts` |  |
| `schedules.test.ts` | [proposals] |
| `serverLock.test.ts` | [data-dir] |
| `src/app/api/agents/route.test.ts` |  |

## [The sandbox, Codex's rules file and the read guard](testing/sandbox-and-read-guard.md)

| Test file | Also in |
|---|---|
| `codexRules.test.ts` |  |
| `readGuard.test.ts` |  |
| `sandboxMountPoints.test.ts` |  |

## [Stream parsers, assist output and the outbound webhook](testing/stream-parsers-and-webhook.md)

| Test file | Also in |
|---|---|
| `notify.test.ts` |  |
| `review.test.ts` | [pricing], [landing], [stacks] |
| `toolComposition.test.ts` |  |

Units that are about no test file in the tree:

- `rateLimitEvent.test.ts` is gone, with the module it covered: the provider's own utilisation off the `stream-json` stream fed one dashboard card and nothing else, and card and parser were removed …

## [Auth, credentials, config and the status routes](testing/auth-config-and-status-routes.md)

| Test file | Also in |
|---|---|
| `authGuard.test.ts` |  |
| `claudeAuth.test.ts` |  |
| `codexAuth.test.ts` |  |
| `config.test.ts` |  |
| `configCheck.test.ts` |  |
| `credential-audit.test.ts` |  |
| `http.test.ts` | [harnesses] |
| `loginLimiter.test.ts` |  |
| `otlp.test.ts` |  |
| `requestLog.test.ts` |  |
| `sessionToken.test.ts` |  |
| `settings.test.ts` |  |
| `src/app/api/jsonObjectBody.test.ts` |  |
| `src/app/api/health/route.test.ts` |  |
| `src/app/api/login/route.test.ts` |  |
| `src/app/api/runs/[id]/stream/route.test.ts` |  |
| `src/app/api/settings/route.test.ts` | [harnesses] |
| `src/app/api/status/route.test.ts` |  |

## [Container, compose and backups](testing/container-and-deployment.md)

| Test file | Also in |
|---|---|
| `backupRestore.test.ts` |  |
| `deployment.test.ts` | [stacks] |

## [The knowledge vault reader, vault skill and graph view](testing/knowledge-vault-and-graph.md)

| Test file | Also in |
|---|---|
| `canvasView.test.ts` |  |
| `forceLayout.test.ts` |  |
| `knowledge.test.ts` |  |
| `knowledgeGraph.test.ts` | [harnesses] |
| `vaultSkill.test.ts` |  |

## [Dreaming](testing/dreaming.md)

| Test file | Also in |
|---|---|
| `dreaming.test.ts` |  |
| `dreamingClock.test.ts` |  |
| `dreamingLedger.test.ts` |  |
| `dreamingScan.test.ts` |  |

## [Components: Meter, the ascii skin, Markdown and the UI kit](testing/components-meter-markdown-and-kit.md)

| Test file | Also in |
|---|---|
| `AsciiBar.test.tsx` |  |
| `AsciiFrame.test.tsx` |  |
| `Disclosure.test.tsx` |  |
| `LimitField.test.tsx` |  |
| `ListView.test.tsx` |  |
| `LiveTelemetry.test.tsx` | [cards] |
| `Markdown.test.tsx` |  |
| `Meter.test.tsx` |  |
| `Table.test.tsx` |  |

## [Components: usage, context and run cards](testing/components-usage-and-run-cards.md)

| Test file | Also in |
|---|---|
| `BranchWork.test.tsx` |  |
| `ContextControl.test.tsx` |  |
| `ContextOccupancy.test.tsx` | [ceiling] |
| `InstallSpendCard.test.tsx` |  |
| `RecentBlocksCard.test.tsx` |  |
| `RunHandoff.test.tsx` |  |
| `RunPruning.test.tsx` |  |
| `UsagePeriods.test.tsx` | [ui-kit] |

## [Stacks, the tool inventory and the end of the function list](testing/stacks-and-tool-inventory.md)

| Test file | Also in |
|---|---|
| `applyStacks.test.ts` |  |
| `cycles.test.ts` | [run-page] |
| `logLine.test.ts` |  |
| `repoSpend.test.ts` |  |
| `stacks.test.ts` |  |
| `toolInventory.test.ts` |  |
| `unsavedWork.test.ts` |  |

## [Test harnesses: which tests open a database, and how this page is checked](testing/test-harnesses.md)

| Test file | Also in |
|---|---|
| `docClaims.test.ts` |  |

Units that are about no test file in the tree:

- Four more files and 91 cases across thirteen of them landed with the audit pass that added the two spawn-side token levers, the install-ceiling bounding and the gzip helper — counted as `git diff …

## Test files whose grounds are not recorded

These are in the tree, and no topic file says what they earned.

| Test file |
|---|
| `contextPruningReporting.test.ts` |
| `forkAttempts.test.ts` |
| `mcpStatus.test.ts` |
| `transcriptForkDedupe.test.ts` |

## Checking this page is complete

The rest of the suite is named by *subject* in the topic files rather than by filename, which is the right way round for deciding whether something is already covered and the wrong way round for checking that this page is complete — so the filenames are here too, and nothing else is claimed about them: `budgetPayload.test.ts`, `agentRegistry.test.ts`, `agents.test.ts`, `authGuard.test.ts`, `budget.test.ts`, `canvasGraph.test.ts`, `chatRequest.test.ts`, `claudeAuth.test.ts`, `config.test.ts`, `configCheck.test.ts`, `contextPruningReporting.test.ts`, `cycles.test.ts`, `diff.test.ts`, `forkAttempts.test.ts`, `format.test.ts`, `formProblems.test.ts`, `formSeed.test.ts`, `git.test.ts`, `http.test.ts`, `jsonRequest.test.ts`, `land.test.ts`, `loginLimiter.test.ts`, `logLine.test.ts`, `patch.test.ts`, `planUsage.test.ts`, `plugins.test.ts`, `privsep.test.ts`, `repoSpend.test.ts`, `retention.test.ts`, `review.test.ts`, `sandbox.test.ts`, `sandboxMountPoints.test.ts`, `schedules.test.ts`, `serverLock.test.ts`, `sessionToken.test.ts`, `stacks.test.ts`, `templates.test.ts`, `toolInventory.test.ts`, `applyStacks.test.ts`, `transcriptForkDedupe.test.ts`, `unsavedWork.test.ts`, `windows.test.ts` and `workflows.test.ts`.

The completeness `CLAUDE.md` promises for this page is therefore checkable rather than asserted, and a test added without a paragraph here fails it:

```
find src -name '*.test.ts' -o -name '*.test.tsx' | wc -l          # 147 as this is written
for f in $(find src -name '*.test.ts' -o -name '*.test.tsx' | sort); do
  grep -qF "$(basename "$f")" docs/agent/testing.md || echo "unnamed: $f"
done                              # names any test whose grounds are not on this page
```

**It prints three, as this is written, and they are deliberately not listed
here.** Each was written on a sibling branch and merged in without its
paragraph; naming them in this file would satisfy the `grep` and silence the
check, which is the one thing that must not happen to it — the tool is worth
having only because a mention is what it looks for. Run it, and whoever owns
what it names owes this page the grounds that test earned.

[queue]: testing/run-queue-and-admission.md
[cycle]: testing/work-cycle-prompts-and-endings.md
[fleet]: testing/fleet-and-shutdown.md
[data-dir]: testing/data-dir-retention-and-migrations.md
[budgets]: testing/budgets-and-spend.md
[pricing]: testing/pricing-and-models.md
[transcripts]: testing/transcripts-and-snapshot.md
[pruning]: testing/context-pruning.md
[ceiling]: testing/context-samples-and-ceiling.md
[workflows]: testing/workflow-instances.md
[loops]: testing/workflow-loops.md
[chat]: testing/chat-turns-and-threads.md
[proposals]: testing/chat-proposals.md
[tasks]: testing/taskboard-authority-and-moves.md
[task-deps]: testing/taskboard-comments-deps-and-mcp.md
[landing]: testing/landing-and-merge-queue.md
[run-page]: testing/run-page-panels-and-file-maps.md
[argv]: testing/spawn-argv-and-child-env.md
[sandbox]: testing/sandbox-and-read-guard.md
[parsers]: testing/stream-parsers-and-webhook.md
[auth]: testing/auth-config-and-status-routes.md
[container]: testing/container-and-deployment.md
[knowledge]: testing/knowledge-vault-and-graph.md
[dreaming]: testing/dreaming.md
[ui-kit]: testing/components-meter-markdown-and-kit.md
[cards]: testing/components-usage-and-run-cards.md
[stacks]: testing/stacks-and-tool-inventory.md
[harnesses]: testing/test-harnesses.md
