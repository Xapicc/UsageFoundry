# What the test suite covers, and what earns a test

> Extracted verbatim from `CLAUDE.md`, which grew past the size Claude Code will
> load into a session. Each paragraph records a correctness or safety decision
> whose violation is silent — nothing throws, nothing fails to typecheck.
> **Read before editing any src/**/*.test.ts, or when deciding whether a change needs one.**

This page is the index. The bar every test is held to comes first, each of its paragraphs listed by its lead claim and held in `testing/the-bar.md`; then one section per topic file under `testing/`, each with a table of the test files whose grounds that file holds. Read the bar, then the one topic file your change touches. The sections from the stream parsers to the TokenEconomizer are on a second page, [testing-edges-and-pages.md](testing-edges-and-pages.md), because this one outgrew the size every other doc keeps to.

## [The bar](testing/the-bar.md)

- There is **no linter run** (`eslint.ignoreDuringBuilds` is on), and `npm test` covers a deliberately short list: `overlaps()`, `walkQueue()` — which is `selectPromotable()` with its reasons kept …
- Every one earns it on the same grounds — pure functions whose failure modes are silent and expensive (two agents in one working tree, or a run queued behind something that will never move, …
- The twelve modules at the end of that list are the ones whose grounds are not obvious from the function's name …
- That is the bar for adding another …

`npm run typecheck` plus a `docker compose up --build` smoke test is still the real verification loop, and `docs/verification.md` records what was checked by hand — including its "Not yet verified" list, which must stay honest.

Nineteen are renderings rather than functions — every `*.test.tsx` in the tree, which is the whole of that class and is countable as `find src -name '*.test.tsx' | wc -l`.

## [Run queue and admission](testing/run-queue-and-admission.md)

| Test file | Also in |
|---|---|
| `branchRival.test.ts` |  |
| `budget.test.ts` | [harnesses] |
| `diff.test.ts` |  |
| `land.test.ts` | [landing], [merge-queue], [harnesses], [contention] |
| `orchestrator.test.ts` | [cycle], [edges], [argv], [functions], [samples], [parsers], [codex-cycle], [budgets], [pricing], [landing], [merge-queue], [sandbox], [harnesses], [token-economizer], [slots] |
| `patch.test.ts` |  |
| `planUsage.test.ts` |  |
| `queueOrder.test.ts` |  |
| `repoSpendAdmission.test.ts` |  |
| `runOrigin.test.ts` |  |
| `runWriteOrder.test.ts` | [write-order] |
| `windows.test.ts` | [harnesses], [pricing] |

## [Checkout slots: the walk, the store and the git that readies one](testing/checkout-slots.md)

| Test file | Also in |
|---|---|
| `checkoutGitClock.test.ts` |  |
| `cutOffCheckout.test.ts` | [cycle] |
| `mountRootIsolation.test.ts` |  |
| `slotLeafLink.test.ts` |  |
| `slotProbes.test.ts` |  |

## [Run write order](testing/run-write-order.md)

The cases in `runWriteOrder.test.ts`, listed under the section above, that pin the order runs are listed, queued, positioned and named in when several are written in one millisecond.

## [Work-cycle prompts, endings and deadlines](testing/work-cycle-prompts-and-endings.md)

| Test file | Also in |
|---|---|
| `backgroundWork.test.ts` |  |
| `cycleDeadline.test.ts` |  |
| `cycleEndingSentence.test.ts` |  |
| `priorReads.test.ts` |  |
| `resumeMissingTranscript.test.ts` |  |

## [Dependency edges: `edgeSatisfied`, the rival pair and the restart-closed case](testing/dependency-edges-and-rivals.md)

Its cases are in `orchestrator.test.ts`, `shutdown.test.ts`, `stackWait.test.ts` and `workflows.test.ts`; see those files' rows above.

## [Fleet stop and hold](testing/fleet-stop-and-hold.md)

| Test file | Also in |
|---|---|
| `fleet.test.ts` | [harnesses], [cycle] |
| `restartClosedView.test.ts` |  |
| `src/app/api/runs/restarted/route.test.ts` |  |

## [Shutdown](testing/shutdown.md)

| Test file | Also in |
|---|---|
| `shutdown.test.ts` | [workflows], [cycle], [edges] |

## [Data directory ownership, retention and migrations](testing/data-dir-retention-and-migrations.md)

| Test file | Also in |
|---|---|
| `dataDirClaim.test.ts` |  |
| `holdoutExport.test.ts` |  |
| `holdoutInference.test.ts` |  |
| `holdoutReadback.test.ts` |  |
| `retention.test.ts` | [stacks], [harnesses] |
| `retentionSweep.test.ts` | [status] |
| `schemaMigration.test.ts` |  |

## [Budgets and spend guards](testing/budgets-and-spend.md)

| Test file | Also in |
|---|---|
| `assistBudget.test.ts` |  |
| `calibration.test.ts` |  |
| `costBaseline.test.ts` |  |
| `costOutlierGuard.test.ts` |  |
| `costSplit.test.ts` |  |
| `installSpend.test.ts` | [chat], [harnesses] |
| `instanceBudget.test.ts` |  |
| `parksAndRefunds.test.ts` | [cycle] |
| `resumedCycleSpend.test.ts` |  |
| `validationGrant.test.ts` | [cycle] |

## [The new-run form's limits, refusals and seed](testing/run-form-limits.md)

| Test file | Also in |
|---|---|
| `budgetPayload.test.ts` | [pricing] |
| `formProblems.test.ts` |  |
| `formSeed.test.ts` |  |

## [Codex cycles that end without reporting](testing/codex-killed-cycles.md)

| Test file | Also in |
|---|---|
| `codexKilledCycle.test.ts` |  |

## [Pricing and model choice](testing/pricing-and-models.md)

| Test file | Also in |
|---|---|
| `pricing.test.ts` |  |
| `templates.test.ts` | [functions], [refusals], [bodies], [run-form] |

## [The model catalogue and model discovery](testing/model-catalogue-and-discovery.md)

| Test file | Also in |
|---|---|
| `codexAccount.test.ts` |  |
| `codexInstructions.test.ts` |  |
| `codexModelDiscovery.test.ts` |  |
| `modelAdoption.test.ts` |  |
| `modelCatalogue.test.ts` |  |
| `modelDiscovery.test.ts` |  |
| `runModelPrecedence.test.ts` |  |

## [Transcript scanning and the usage snapshot](testing/transcripts-and-snapshot.md)

| Test file | Also in |
|---|---|
| `snapshotCoalesce.test.ts` |  |
| `transcriptCache.test.ts` |  |
| `transcriptCompaction.test.ts` |  |
| `transcriptForkDedupe.test.ts` |  |
| `transcriptDedupe.test.ts` |  |
| `transcriptPromptTier.test.ts` | [pricing] |
| `transcripts.test.ts` | [functions] |
| `transcriptScan.test.ts` |  |
| `transcriptScanMemo.test.ts` |  |
| `transcriptWalk.test.ts` |  |

## [Context samples and the live tick](testing/context-samples.md)

| Test file | Also in |
|---|---|
| `contextReading.test.ts` |  |
| `contextSamples.test.ts` |  |

## [Workflow instances, blocks and schedules](testing/workflow-instances.md)

| Test file | Also in |
|---|---|
| `bootBlocks.test.ts` | [harnesses], [pick-ups] |
| `src/app/api/workflows/dto.test.ts` |  |
| `haltedMembers.test.ts` |  |
| `instanceReading.test.ts` |  |
| `runWorkflowOrigin.test.ts` |  |

## [Workflow schedules, Duplicate and the workflow routes](testing/workflow-schedules-and-routes.md)

| Test file | Also in |
|---|---|
| `scheduleFire.test.ts` |  |
| `schedulePut.test.ts` |  |
| `src/app/api/workflows/[id]/route.test.ts` |  |
| `src/app/api/workflows/[id]/run/route.test.ts` |  |
| `src/app/api/workflows/[id]/schedule/route.test.ts` |  |

## [Workflow canvas ordering and page formatting](testing/workflow-canvas-and-formatting.md)

| Test file | Also in |
|---|---|
| `canvasGraph.test.ts` | [stacks] |
| `format.test.ts` | [tasks], [stacks] |

## [Gate blocks](testing/workflow-gates.md)

| Test file | Also in |
|---|---|
| `gateBlock.test.ts` |  |

## [Workflow pick-ups](testing/workflow-pick-ups.md)

| Test file | Also in |
|---|---|
| `orchestratorPickUp.test.ts` |  |
| `orchestratorTurnRetry.test.ts` |  |

## [Loop blocks and their passes](testing/workflow-loops.md)

| Test file | Also in |
|---|---|
| `loopMergeOwnership.test.ts` |  |
| `loopSection.test.ts` | [fleet], [loop-endings] |
| `workflows.test.ts` | [functions], [pricing], [workflows], [decider], [pick-ups], [cycle], [edges], [loop-board], [loop-endings], [schedule-routes], [refusals], [chat], [delivery], [fleet], [local], [merge-queue], [bodies], [queue], [task-deps], [gates] |

Units that are about no test file in the tree:

- Deliberately **not** tested: `STATUS_TONE`, `GLYPH` and `describeRun`, where the compiler is the test and a rendering earns one only when it pins something a reader would act on that is wrong in a …

## [A loop's board condition](testing/workflow-loop-board.md)

| Test file | Also in |
|---|---|
| `loopBoardCount.test.ts` |  |

## [How a loop is picked up, fails and ends](testing/workflow-loop-endings.md)

Cases in `loopSection.test.ts` and `workflows.test.ts`, each listed under its own section, that pin how a loop is picked up again, fails at its boundary or before it has a pass, and ends or settles inside its own release.

## [Chat turns, threads and the request helpers](testing/chat-turns-and-threads.md)

| Test file | Also in |
|---|---|
| `blockTurnReading.test.ts` |  |
| `chat.test.ts` | [proposals], [refusals], [functions], [pricing], [task-deps], [landing] |
| `chatOrder.test.ts` |  |
| `chatRequest.test.ts` |  |
| `chatStream.test.ts` | [pricing] |
| `chatTurn.test.ts` |  |
| `jsonRequest.test.ts` |  |
| `poll.test.ts` |  |
| `src/app/api/chat/[id]/route.test.ts` | [chat-thread] |

## [The chat page's thread: the cursored poll and what the page reads off it](testing/chat-thread-page-readings.md)

| Test file | Also in |
|---|---|
| `chatThread.test.ts` | [proposals] |

## [Chat proposals, questions and search](testing/chat-proposals.md)

| Test file | Also in |
|---|---|
| `dto.test.ts` |  |
| `proposalContinuation.test.ts` |  |
| `remoteReads.test.ts` |  |

## [Chat proposals: what the doors refuse](testing/chat-proposal-door-refusals.md)

| Test file | Also in |
|---|---|
| `src/app/api/chat/[id]/proposals/route.test.ts` |  |

## [Taskboard authority, moves and a run's board](testing/taskboard-authority-and-moves.md)

| Test file | Also in |
|---|---|
| `tasks.test.ts` | [functions] |

## [Task comments, dependencies and the board's MCP surface](testing/taskboard-comments-deps-and-mcp.md)

| Test file | Also in |
|---|---|
| `src/app/api/mcp/route.test.ts` | [projects], [bodies], [harnesses], [refusals] |
| `taskComments.test.ts` |  |
| `taskDepGraph.test.ts` |  |
| `taskDeps.test.ts` |  |

## [The completion validator](testing/completion-validation.md)

| Test file | Also in |
|---|---|
| `validation.test.ts` |  |
| `validationQueue.test.ts` |  |
| `validationSettle.test.ts` |  |
| `validationStop.test.ts` |  |

## [The git this app runs](testing/git-children.md)

| Test file | Also in |
|---|---|
| `git.test.ts` | [landing] |
| `runTrailers.test.ts` |  |
| `runTrailersCycle.test.ts` |  |

## [The filter probe in front of this app's git](testing/git-filter-probe.md)

| Test file | Also in |
|---|---|
| `gitFilterProbe.test.ts` |  |

## [Landing, delivery and the land gate](testing/landing-and-delivery.md)

| Test file | Also in |
|---|---|
| `landAfterVerify.test.ts` | [contention] |
| `landMovedBranch.test.ts` |  |
| `landUnwind.test.ts` | [contention] |
| `landView.test.ts` | [cards] |
| `repoLock.test.ts` |  |

## [Deleting a landed branch, a squashed chain's second land and a reused slot](testing/branch-deletion-and-slot-reuse.md)

| Test file | Also in |
|---|---|
| `deleteBranch.test.ts` |  |
| `diffSlotReuse.test.ts` |  |
| `landAfterSquash.test.ts` | [resolution] |

## [The verify gate in front of Land](testing/land-verify-gate.md)

| Test file | Also in |
|---|---|
| `landGate.test.ts` |  |

## [Deliver, and Push of the operator's branch](testing/delivery.md)

| Test file | Also in |
|---|---|
| `deliverBlockRun.test.ts` | [pick-ups] |
| `deliverMovedBranch.test.ts` |  |
| `deliverRun.test.ts` |  |
| `delivery.test.ts` |  |

## [Projects: Push, fetch and the inventory](testing/projects-push-and-fetch.md)

| Test file | Also in |
|---|---|
| `projectPush.test.ts` |  |
| `projects.test.ts` |  |

## [Another git process in the operator's checkout](testing/landing-contention.md)

Cases in `landAfterVerify.test.ts`, `landUnwind.test.ts`, `land.test.ts` and `mergeQueue.test.ts`, each listed under its own section, that pin what a land does when another git process holds a lock in the checkout.

## [The merge queue](testing/merge-queue.md)

| Test file | Also in |
|---|---|
| `mergeQueue.test.ts` | [functions], [resolution], [contention] |
| `mergeQueueDrain.test.ts` | [fleet] |
| `mergeQueueOrder.test.ts` |  |
| `mergeQueueView.test.ts` |  |

## [Conflict resolution: its checkout, limits and refusals](testing/conflict-resolution.md)

| Test file | Also in |
|---|---|
| `conflictedPaths.test.ts` |  |
| `midOperationSlot.test.ts` | [landing] |
| `resolutionBudget.test.ts` |  |
| `resolutionMarkerless.test.ts` |  |
| `resolutionSilence.test.ts` | [merge-queue] |
| `resolveCheckout.test.ts` |  |

## [Run page panels: background tasks, touched files and conflict maps](testing/run-page-panels-and-file-maps.md)

| Test file | Also in |
|---|---|
| `conflictMap.test.ts` |  |
| `runTasks.test.ts` |  |
| `runTouches.test.ts` |  |
| `touchedMap.test.ts` |  |
| `touchReplay.test.ts` |  |

## [The function list from the merge queue to the chat's proposals, and the agents route](testing/function-list-queue-to-proposals.md)

| Test file | Also in |
|---|---|
| `agentRegistry.test.ts` |  |
| `agents.test.ts` | [refusals] |
| `privsep.test.ts` | [chat-child], [knowledge] |
| `sandbox.test.ts` |  |
| `schedules.test.ts` | [proposals] |
| `serverLock.test.ts` | [data-dir] |
| `src/app/api/agents/route.test.ts` |  |

## [Spawn argv, the child environment and appended notices](testing/spawn-argv-and-child-env.md)

| Test file | Also in |
|---|---|
| `fileCostNotice.test.ts` |  |
| `plugins.test.ts` |  |
| `promptArgv.test.ts` |  |
| `tmpdirNotice.test.ts` |  |

## [Names a dropped child runs, and what the chat child loads](testing/chat-child-lookups-and-config.md)

| Test file | Also in |
|---|---|
| `blockStartupGit.test.ts` |  |
| `cliPath.test.ts` |  |

## [The sandbox, Codex's rules file and the read guard](testing/sandbox-and-read-guard.md)

| Test file | Also in |
|---|---|
| `codexCycleHome.test.ts` |  |
| `codexRules.test.ts` |  |
| `readGuard.test.ts` |  |
| `sandboxMountPoints.test.ts` |  |

## [What a Codex cycle's stream and exit are read as](testing/codex-cycle-readings.md)

Its cases are in `orchestrator.test.ts`; see that file's row above.

## [The install's edges and its pages](testing-edges-and-pages.md)

Stream parsers and the outbound webhook, the live page, the model decider, the local provider, auth, credentials, config and settings, provider sign-in, the status routes, sign-in limits, the container, the knowledge vault, Dreaming, the toolbar readout, the dashboard's "waiting on you" line, the git-directory watch, the components, stacks and the TokenEconomizer: their sections, with their tables, are in [testing-edges-and-pages.md](testing-edges-and-pages.md), which is this page's second half.

## [Test harnesses: which tests open a database, and how this page is checked](testing/test-harnesses.md)

| Test file | Also in |
|---|---|
| `docClaims.test.ts` |  |

Units that are about no test file in the tree:

- Four more files and 91 cases across thirteen of them landed with the audit pass that added the two spawn-side token levers, the install-limit bounding and the gzip helper — counted as `git diff …

## Checking this page is complete

Every test file is named in the paragraph that holds its grounds, in the topic file for its area — by basename, or by path for the `route.test.ts` files, which all share one — and that name is the whole of what the check below looks for. It reads the topic files and never this page. The tables above, and those in [testing-edges-and-pages.md](testing-edges-and-pages.md), name every test file by design, so a check that read them would pass a test whose row was added and whose paragraph never was, which is how it once printed nothing while four files had no grounds anywhere. For the same reason a paragraph that names only its subject, a function or a module, is invisible to it: when you write one, put the file's name in it too.

```
find src -name '*.test.ts' -o -name '*.test.tsx' | wc -l          # 185 as this is written, 2026-10-01
for f in $(find src -name '*.test.ts' -o -name '*.test.tsx' | sort); do
  name=$(basename "$f")
  [ "$name" = route.test.ts ] && name=$f          # every route handler's test has that basename
  grep -qF "$name" docs/agent/testing/*.md || echo "no grounds: $f"
done                              # names any test no topic file names
```

It prints nothing as this is written. Whoever owns a file it names owes that file's topic file the paragraph stating what it earned against the bar above, and this page its row. Do not put the name in a topic file before the paragraph exists — not in a list, not in another test's paragraph — because a mention is all the check can see, and that would silence it for a test nobody wrote grounds for. It is a floor rather than a proof: it cannot tell a paragraph from a passing mention.

[queue]: testing/run-queue-and-admission.md
[slots]: testing/checkout-slots.md
[write-order]: testing/run-write-order.md
[cycle]: testing/work-cycle-prompts-and-endings.md
[fleet]: testing/fleet-stop-and-hold.md
[data-dir]: testing/data-dir-retention-and-migrations.md
[budgets]: testing/budgets-and-spend.md
[pricing]: testing/pricing-and-models.md
[catalogue]: testing/model-catalogue-and-discovery.md
[transcripts]: testing/transcripts-and-snapshot.md
[samples]: testing/context-samples.md
[workflows]: testing/workflow-instances.md
[schedule-routes]: testing/workflow-schedules-and-routes.md
[loops]: testing/workflow-loops.md
[loop-board]: testing/workflow-loop-board.md
[loop-endings]: testing/workflow-loop-endings.md
[pick-ups]: testing/workflow-pick-ups.md
[chat]: testing/chat-turns-and-threads.md
[proposals]: testing/chat-proposals.md
[refusals]: testing/chat-proposal-door-refusals.md
[tasks]: testing/taskboard-authority-and-moves.md
[task-deps]: testing/taskboard-comments-deps-and-mcp.md
[landing]: testing/landing-and-delivery.md
[merge-queue]: testing/merge-queue.md
[contention]: testing/landing-contention.md
[resolution]: testing/conflict-resolution.md
[run-page]: testing/run-page-panels-and-file-maps.md
[argv]: testing/spawn-argv-and-child-env.md
[functions]: testing/function-list-queue-to-proposals.md
[chat-child]: testing/chat-child-lookups-and-config.md
[sandbox]: testing/sandbox-and-read-guard.md
[parsers]: testing/stream-parsers-and-webhook.md
[codex-cycle]: testing/codex-cycle-readings.md
[status]: testing/health-and-status-routes.md
[knowledge]: testing/knowledge-vault-and-graph.md
[cards]: testing/components-usage-and-run-cards.md
[stacks]: testing/stacks-and-tool-inventory.md
[harnesses]: testing/test-harnesses.md
[decider]: testing/model-decider.md
[delivery]: testing/delivery.md
[projects]: testing/projects-push-and-fetch.md
[live]: testing/live-page-folds.md
[chat-thread]: testing/chat-thread-page-readings.md
[branch-delete]: testing/branch-deletion-and-slot-reuse.md
[edges]: testing/dependency-edges-and-rivals.md
[run-form]: testing/run-form-limits.md
[token-economizer]: testing/token-economizer.md
[local]: testing/local-provider.md
[bodies]: testing/request-bodies-settings-and-run-streams.md
[gates]: testing/workflow-gates.md
