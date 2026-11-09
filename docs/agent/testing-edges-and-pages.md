# What the test suite covers, and what earns a test: the install's edges and its pages

[← testing index](testing.md)

This page is the second half of the index at [testing.md](testing.md), which holds the bar every test is held to, the check that the index is complete and the first sections. It is built the same way: one section per topic file under `testing/`, each with a table of the test files whose grounds that file holds. A test file's row is on the page that holds its section, and its "Also in" cell names the other topic files that hold grounds for it, as there.

## [Stream parsers, assist output and the outbound webhook](testing/stream-parsers-and-webhook.md)

| Test file | Also in |
|---|---|
| `codexRollout.test.ts` |  |
| `mcpStatus.test.ts` |  |
| `notify.test.ts` |  |
| `review.test.ts` | [pricing], [landing], [stacks], [argv], [sandbox] |
| `toolComposition.test.ts` |  |

Units that are about no test file in the tree:

- `rateLimitEvent.test.ts` is gone, with the module it covered: the provider's own utilisation off the `stream-json` stream fed one dashboard card and nothing else, and card and parser were removed …

## [The live page: its stream, tiles and sub-agent roster](testing/live-page-folds.md)

| Test file | Also in |
|---|---|
| `liveStream.test.ts` |  |
| `liveSubagents.test.ts` |  |
| `liveTiles.test.ts` |  |

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
| `reviewBlockRun.test.ts` | [workflows], [harnesses] |
| `src/app/api/runs/[id]/agent-cost/route.test.ts` |  |

## [Auth, credentials, config and the request log](testing/auth-config-and-status-routes.md)

| Test file | Also in |
|---|---|
| `authGuard.test.ts` |  |
| `config.test.ts` |  |
| `configCheck.test.ts` |  |
| `credential-audit.test.ts` |  |
| `requestLog.test.ts` |  |
| `sessionToken.test.ts` |  |
| `src/app/api/login/route.test.ts` | [sign-in], [bodies] |
| `src/middleware.test.ts` | [sign-in] |

## [Request bodies, settings, the run streams and the run doors](testing/request-bodies-settings-and-run-streams.md)

| Test file | Also in |
|---|---|
| `http.test.ts` | [harnesses] |
| `otlp.test.ts` |  |
| `settings.test.ts` |  |
| `src/app/api/fleet/route.test.ts` |  |
| `src/app/api/jsonObjectBody.test.ts` |  |
| `src/app/api/otlp/v1/logs/route.test.ts` |  |
| `src/app/api/runs/[id]/reopen/route.test.ts` |  |
| `src/app/api/runs/[id]/stream/route.test.ts` |  |
| `src/app/api/runs/route.test.ts` |  |
| `src/app/api/runs/live/stream/route.test.ts` | [harnesses] |
| `src/app/api/settings/route.test.ts` | [harnesses] |

## [Provider sign-in: the Claude and Codex auth modules](testing/provider-sign-in.md)

| Test file | Also in |
|---|---|
| `claudeAuth.test.ts` |  |
| `codexAuth.test.ts` |  |

## [The health and status routes](testing/health-and-status-routes.md)

| Test file | Also in |
|---|---|
| `readOnlyBanner.test.ts` |  |
| `src/app/api/health/route.test.ts` |  |
| `src/app/api/status/route.test.ts` | [sign-in] |

## [Sign-in limits](testing/sign-in-limits.md)

| Test file | Also in |
|---|---|
| `loginLimiter.test.ts` |  |

## [Container, compose and backups](testing/container-and-deployment.md)

| Test file | Also in |
|---|---|
| `backupRestore.test.ts` |  |
| `deployment.test.ts` | [stacks], [token-economizer] |

## [The knowledge vault reader, vault skill and graph view](testing/knowledge-vault-and-graph.md)

| Test file | Also in |
|---|---|
| `canvasView.test.ts` |  |
| `forceLayout.test.ts` |  |
| `knowledge.test.ts` |  |
| `knowledgeGraph.test.ts` | [harnesses] |
| `vaultPointer.test.ts` |  |
| `vaultSkill.test.ts` |  |

## [Dreaming](testing/dreaming.md)

| Test file | Also in |
|---|---|
| `dreaming.test.ts` |  |
| `dreamingClock.test.ts` |  |
| `dreamingLanding.test.ts` |  |
| `dreamingLedger.test.ts` |  |
| `dreamingScan.test.ts` |  |

## [The toolbar's usage readout](testing/toolbar-usage-readout.md)

| Test file | Also in |
|---|---|
| `usageRemaining.test.ts` |  |
| `UsageRemaining.test.ts` |  |

## [The dashboard's "waiting on you" line](testing/waiting-on-you.md)

| Test file | Also in |
|---|---|
| `src/app/api/waiting/route.test.ts` |  |
| `waitingView.test.ts` |  |

## [What a run left in its repository's git directory](testing/git-dir-watch.md)

| Test file | Also in |
|---|---|
| `gitDirWatch.test.ts` |  |
| `gitDirRead.test.ts` |  |
| `RunGitDirNotice.test.tsx` |  |

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
| `CodexWindows.test.tsx` |  |
| `ContextOccupancy.test.tsx` | [samples] |
| `InstallSpendCard.test.tsx` |  |
| `LiveRunFigures.test.tsx` |  |
| `OpenTasksChart.test.tsx` |  |
| `RecentBlocksCard.test.tsx` |  |
| `RunHandoff.test.tsx` |  |
| `UsageNotices.test.tsx` |  |
| `UsagePeriods.test.tsx` | [ui-kit] |
| `windowCardNotes.test.ts` |  |
| `windowOutlook.test.ts` |  |

## [Stacks, the tool inventory and the end of the function list](testing/stacks-and-tool-inventory.md)

| Test file | Also in |
|---|---|
| `applyStacks.test.ts` |  |
| `cycles.test.ts` | [run-page] |
| `logLine.test.ts` |  |
| `repoReading.test.ts` |  |
| `repoSpend.test.ts` |  |
| `stackRequests.test.ts` |  |
| `stackWait.test.ts` | [budgets], [cycle], [edges], [queue], [validation](testing/completion-validation.md) |
| `stacks.test.ts` |  |
| `toolInventory.test.ts` |  |
| `unsavedWork.test.ts` |  |

## [TokenEconomizer: availability, env pins and the catalogue refresh](testing/token-economizer.md)

| Test file | Also in |
|---|---|
| `tokenEconomizer.test.ts` | [argv], [deployment] |

[queue]: testing/run-queue-and-admission.md
[cycle]: testing/work-cycle-prompts-and-endings.md
[budgets]: testing/budgets-and-spend.md
[samples]: testing/context-samples.md
[run-page]: testing/run-page-panels-and-file-maps.md
[argv]: testing/spawn-argv-and-child-env.md
[deployment]: testing/container-and-deployment.md
[sign-in]: testing/sign-in-limits.md
[ui-kit]: testing/components-meter-markdown-and-kit.md
[cards]: testing/components-usage-and-run-cards.md
[stacks]: testing/stacks-and-tool-inventory.md
[harnesses]: testing/test-harnesses.md
[bodies]: testing/request-bodies-settings-and-run-streams.md
[edges]: testing/dependency-edges-and-rivals.md
[token-economizer]: testing/token-economizer.md
[pricing]: testing/pricing-and-models.md
[landing]: testing/landing-and-delivery.md
[sandbox]: testing/sandbox-and-read-guard.md
[workflows]: testing/workflow-instances.md
