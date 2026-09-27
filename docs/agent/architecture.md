# Architecture

> Extracted verbatim from `CLAUDE.md`, which grew past the size Claude Code will
> load into a session. Each paragraph records a correctness or safety decision
> whose violation is silent — nothing throws, nothing fails to typecheck.
> **Read before editing src/lib/ generally — the three data sources, the module map, how events flow.**

Each paragraph is in one topic file under `docs/agent/architecture/`; the lines below are their lead claims, under the file that holds them.

## [The three data sources](architecture/data-sources.md)

- Three data sources now, still never summed or mixed in the UI.
- The two original sources: a table setting the subscription view against the API-account view — source, code, route and nature.

## [The module map](architecture/module-map.md)

- The subscription pipeline: a fenced module map, one entry per module: `transcripts.ts`, `pricing.ts`, `settings.ts`, `planUsage.ts`, `windows.ts`, `budget.ts`, `orchestrator.ts`, `git.ts`, `diff.ts`, `review.ts`, `land.ts`, `mergeQueue.ts`, `templates.ts`, `toolInventory.ts`, `stacks.ts`, `scripts/apply-stacks.mjs`, `plugins.ts`, `vaultSkill.ts`, `readGuard.ts`, `fileCostNotice.ts`, `toolComposition.ts`, `intakeFilter.ts`, `agents.ts`, `workflows.ts`, `schedules.ts`, `canvasGraph.ts`, `unsavedWork.ts`, `chat.ts`, `repoSpend.ts`, `fleet.ts`, `workspace.ts`, `tasks.ts`, `cycles.ts`, `ops.ts`, `requestLog.ts`, `retention.ts`, `health.ts`, `status.ts`, `db.ts`.

## [The run loop, agent child processes and the event stream](architecture/run-loop-and-child-processes.md)

- Four kinds of agent child process, from four modules, and no more — and two numbers bound how many of them exist at once.
- Every long-lived child also outranks the server as an OOM victim, and that is a second thing `privsep.ts` decides once.
- `orchestrator.ts`'s loop calls `currentSnapshot()` (a fresh transcript scan, shared with every other caller that asks while it is running — see the invariant below) *before every iteration*, evaluates …
- Several runs can be in flight at once.
- Events flow: `emit()` writes to `run_events` and publishes on a `globalThis` EventEmitter → `/api/runs/[id]/stream` replays persisted history first (honouring `Last-Event-ID`), then tails live.
