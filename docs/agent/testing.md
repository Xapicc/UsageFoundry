# What the test suite covers, and what earns a test

> Extracted verbatim from `CLAUDE.md`, which grew past the size Claude Code will
> load into a session. Each paragraph records a correctness or safety decision
> whose violation is silent — nothing throws, nothing fails to typecheck.
> **Read before editing any src/**/*.test.ts, or when deciding whether a change needs one.**

This page is the index. The bar every test is held to comes first, each of its paragraphs listed by its lead claim and held in `testing/the-bar.md`; then one section per topic file under `testing/`, each with a table of the test files whose grounds that file holds. Read the bar, then the one topic file your change touches.

## [The bar](testing/the-bar.md)

- There is **no linter run** (`eslint.ignoreDuringBuilds` is on), and `npm test` covers a deliberately short list: `overlaps()`, `walkQueue()` — which is `selectPromotable()` with its reasons kept …
- Every one earns it on the same grounds — pure functions whose failure modes are silent and expensive (two agents in one working tree, or a run queued behind something that will never move, …
- The twelve modules at the end of that list are the ones whose grounds are not obvious from the function's name …
- That is the bar for adding another …

`npm run typecheck` plus a `docker compose up --build` smoke test is still the real verification loop, and `docs/verification.md` records what was checked by hand — including its "Not yet verified" list, which must stay honest.

Twenty are renderings rather than functions — every `*.test.tsx` in the tree, which is the whole of that class and is countable as `find src -name '*.test.tsx' | wc -l`.

## [Run queue and admission](testing/run-queue-and-admission.md)

| Test file | Also in |
|---|---|
| `budget.test.ts` | [harnesses] |
| `cutOffCheckout.test.ts` |  |
| `diff.test.ts` |  |
| `land.test.ts` | [landing], [merge-queue], [harnesses] |
| `orchestrator.test.ts` | [cycle], [argv], [ceiling], [pruning], [parsers], [budgets], [pricing], [landing], [merge-queue], [sandbox], [harnesses] |
| `patch.test.ts` |  |
| `planUsage.test.ts` |  |
| `queueOrder.test.ts` |  |
| `runOrigin.test.ts` |  |
| `slotProbes.test.ts` |  |
| `windows.test.ts` | [harnesses] |

## [Work-cycle prompts, endings and deadlines](testing/work-cycle-prompts-and-endings.md)

| Test file | Also in |
|---|---|
| `backgroundWork.test.ts` |  |
| `cycleDeadline.test.ts` |  |
| `resumeControl.test.ts` |  |

## [Fleet stop, hold and shutdown](testing/fleet-and-shutdown.md)

| Test file | Also in |
|---|---|
| `fleet.test.ts` | [harnesses] |
| `restartClosedView.test.ts` |  |
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
| `calibration.test.ts` |  |
| `costBaseline.test.ts` |  |
| `costSplit.test.ts` |  |
| `formProblems.test.ts` |  |
| `formSeed.test.ts` |  |
| `installSpend.test.ts` | [chat], [harnesses] |
| `instanceBudget.test.ts` |  |
| `parksAndRefunds.test.ts` |  |
| `resumedCycleSpend.test.ts` |  |
| `validationGrant.test.ts` |  |

## [Pricing and model choice](testing/pricing-and-models.md)

| Test file | Also in |
|---|---|
| `pricing.test.ts` |  |
| `templates.test.ts` | [argv] |

## [The model catalogue and model discovery](testing/model-catalogue-and-discovery.md)

| Test file | Also in |
|---|---|
| `modelAdoption.test.ts` |  |
| `modelCatalogue.test.ts` |  |
| `modelDiscovery.test.ts` |  |

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
| `contextPruning.test.ts` | [ceiling], [stacks] |
| `contextPruningReporting.test.ts` |  |
| `forkAttempts.test.ts` |  |
| `intakeFilter.test.ts` |  |
| `pruneStatement.test.ts` |  |
| `pruneTranscript.test.ts` |  |
| `transcriptForkDedupe.test.ts` |  |
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
| `scheduleFire.test.ts` |  |
| `schedulePut.test.ts` |  |
| `src/app/api/workflows/[id]/route.test.ts` |  |
| `src/app/api/workflows/[id]/schedule/route.test.ts` |  |

## [Loop blocks and their passes](testing/workflow-loops.md)

| Test file | Also in |
|---|---|
| `loopBoardCount.test.ts` |  |
| `loopMergeOwnership.test.ts` |  |
| `loopSection.test.ts` |  |
| `workflows.test.ts` | [argv], [pricing], [workflows], [decider] |

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
| `poll.test.ts` |  |
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

## [Landing, delivery and the land gate](testing/landing-and-delivery.md)

| Test file | Also in |
|---|---|
| `deleteBranch.test.ts` |  |
| `deliverRun.test.ts` |  |
| `delivery.test.ts` |  |
| `diffSlotReuse.test.ts` |  |
| `git.test.ts` |  |
| `landGate.test.ts` |  |
| `landAfterSquash.test.ts` |  |
| `landAfterVerify.test.ts` |  |
| `landUnwind.test.ts` |  |
| `landView.test.ts` | [cards] |
| `repoLock.test.ts` |  |

## [The merge queue and conflict resolution](testing/merge-queue-and-resolution.md)

| Test file | Also in |
|---|---|
| `conflictedPaths.test.ts` |  |
| `mergeQueue.test.ts` | [argv] |
| `mergeQueueDrain.test.ts` |  |
| `mergeQueueOrder.test.ts` |  |
| `mergeQueueView.test.ts` |  |
| `resolutionBudget.test.ts` |  |
| `resolutionMarkerless.test.ts` |  |
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
| `cliPath.test.ts` |  |
| `fileCostNotice.test.ts` |  |
| `plugins.test.ts` |  |
| `privsep.test.ts` | [knowledge] |
| `sandbox.test.ts` |  |
| `schedules.test.ts` | [proposals] |
| `serverLock.test.ts` | [data-dir] |
| `src/app/api/agents/route.test.ts` |  |
| `tmpdirNotice.test.ts` |  |

## [The sandbox, Codex's rules file and the read guard](testing/sandbox-and-read-guard.md)

| Test file | Also in |
|---|---|
| `codexRules.test.ts` |  |
| `readGuard.test.ts` |  |
| `sandboxMountPoints.test.ts` |  |

## [Stream parsers, assist output and the outbound webhook](testing/stream-parsers-and-webhook.md)

| Test file | Also in |
|---|---|
| `mcpStatus.test.ts` |  |
| `notify.test.ts` |  |
| `review.test.ts` | [pricing], [landing], [stacks] |
| `liveStream.test.ts` |  |
| `liveTiles.test.ts` |  |
| `toolComposition.test.ts` |  |

Units that are about no test file in the tree:

- `rateLimitEvent.test.ts` is gone, with the module it covered: the provider's own utilisation off the `stream-json` stream fed one dashboard card and nothing else, and card and parser were removed …

## [The model decider](testing/model-decider.md)

| Test file | Also in |
|---|---|
| `modelDecider.test.ts` |  |

## [The local provider](testing/local-provider.md)

| Test file | Also in |
|---|---|
| `localCertification.test.ts` |  |
| `localLandGate.test.ts` | [harnesses] |
| `localProvider.test.ts` |  |
| `reviewBlock.test.ts` |  |
| `reviewBlockRun.test.ts` | [harnesses] |

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
| `readOnlyBanner.test.ts` |  |
| `requestLog.test.ts` |  |
| `sessionToken.test.ts` |  |
| `settings.test.ts` |  |
| `src/app/api/jsonObjectBody.test.ts` |  |
| `src/app/api/health/route.test.ts` |  |
| `src/app/api/login/route.test.ts` |  |
| `src/app/api/runs/[id]/stream/route.test.ts` |  |
| `src/app/api/runs/live/stream/route.test.ts` | [harnesses] |
| `src/app/api/settings/route.test.ts` | [harnesses] |
| `src/app/api/status/route.test.ts` |  |
| `src/middleware.test.ts` |  |

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
| `LiveRunFigures.test.tsx` |  |
| `LiveRunPruning.test.tsx` |  |
| `OpenTasksChart.test.tsx` |  |
| `RecentBlocksCard.test.tsx` |  |
| `RunHandoff.test.tsx` |  |
| `RunPruning.test.tsx` |  |
| `UsagePeriods.test.tsx` | [ui-kit] |
| `windowCardNotes.test.ts` |  |

## [Stacks, the tool inventory and the end of the function list](testing/stacks-and-tool-inventory.md)

| Test file | Also in |
|---|---|
| `applyStacks.test.ts` |  |
| `cycles.test.ts` | [run-page] |
| `logLine.test.ts` |  |
| `repoSpend.test.ts` |  |
| `stackRequests.test.ts` |  |
| `stackWait.test.ts` | [budgets] |
| `stacks.test.ts` |  |
| `toolInventory.test.ts` |  |
| `unsavedWork.test.ts` |  |

## [Test harnesses: which tests open a database, and how this page is checked](testing/test-harnesses.md)

| Test file | Also in |
|---|---|
| `docClaims.test.ts` |  |

Units that are about no test file in the tree:

- Four more files and 91 cases across thirteen of them landed with the audit pass that added the two spawn-side token levers, the install-limit bounding and the gzip helper — counted as `git diff …

## Checking this page is complete

Every test file is named in the paragraph that holds its grounds, in the topic file for its area — by basename, or by path for the `route.test.ts` files, which all share one — and that name is the whole of what the check below looks for. It reads the topic files and never this page. The tables above name every test file by design, so a check that read them would pass a test whose row was added and whose paragraph never was, which is how it once printed nothing while four files had no grounds anywhere. For the same reason a paragraph that names only its subject, a function or a module, is invisible to it: when you write one, put the file's name in it too.

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
[cycle]: testing/work-cycle-prompts-and-endings.md
[fleet]: testing/fleet-and-shutdown.md
[data-dir]: testing/data-dir-retention-and-migrations.md
[budgets]: testing/budgets-and-spend.md
[pricing]: testing/pricing-and-models.md
[catalogue]: testing/model-catalogue-and-discovery.md
[transcripts]: testing/transcripts-and-snapshot.md
[pruning]: testing/context-pruning.md
[ceiling]: testing/context-samples-and-ceiling.md
[workflows]: testing/workflow-instances.md
[loops]: testing/workflow-loops.md
[chat]: testing/chat-turns-and-threads.md
[proposals]: testing/chat-proposals.md
[tasks]: testing/taskboard-authority-and-moves.md
[task-deps]: testing/taskboard-comments-deps-and-mcp.md
[landing]: testing/landing-and-delivery.md
[merge-queue]: testing/merge-queue-and-resolution.md
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
[decider]: testing/model-decider.md
