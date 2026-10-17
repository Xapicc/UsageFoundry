# Codex cycles that end without reporting

[← testing index](../testing.md)

Read before adding or editing tests of the Codex branch after `runIteration` returns in `startRun`, of `reconcileInterruptedCycles` on a Codex row, of `readCodexCycleSince`, or of `unmeasuredSpendNotice`.

`codexKilledCycle.test.ts` opens a database and drives the real run loop against a stubbed child, as `shutdown.test.ts` does, because the defect is what the loop does *after* the child returns: no test of the rollout reader could say a killed cycle banked nothing. Its scratch `CODEX_HOME` holds a rollout written the way the CLI writes one — three `token_count` lines ending at 120,500 tokens — and the stub never emits `turn.completed`.

The first case is the one the task was filed for. Stop ends the cycle, `spent_tokens + spent_tokens_est` must reach 120,500, `reopenRun` with `maxRunTokens: 100000` must refuse and spawn nothing, and the ending must not call the count measured. It read `0 + 0` before the change, and a run in that state is reopened under its limit once per pick-up with its recorded total never moving. Stop stands for the live `run_tokens` guard, the silence deadline and the shutdown's interrupt: all four end the cycle through the one post-cycle path, so a test of each would pin one line four times.

The second case is `turn.failed`, which no kill reaches and which carries an error without usage. The third is the one that keeps the first two honest: a cycle that sent `turn.completed` is not banked, because the rollout's total equals what that event reports and adding both charges it twice. It passes before the change and is there so that a fix written as "bank whenever a reading exists" fails; dropping the `!res.sawResult` test was checked to fail it.

The restart cases seed a `running` row with `active_started_at` set and call `reconcileInterruptedCycles("crash")`, the path with no loop and no tracker in memory. The first lays an earlier cycle's lines ahead of the interrupted cycle's in one file and requires only the later total, 77,000 and not the earlier 90,000, and that Claude's "never reported what it cost" line is not written: either a missing time bound or a call to `reconcileKilledCycle` fails it. The second requires that a thread with no file says the spend is missing rather than charging nothing quietly.

`unmeasuredSpendNotice` is pure and its cases are the sentences the operator reads at the end of a run: measured only when every cycle reported, understated with the rollout's count when one was cut short, understated on a later segment that has only the column to go on, and a statement that nothing could be read when nothing was.
