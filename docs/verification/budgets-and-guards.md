# Verification: Budgets and guards

[← Verification index](../verification.md)

## Verified

- **Budget refusal returns `blocked` with 0 iterations and 0 spend.**

- **Metric selection:** the cost ceiling wins when both are set, tokens when
  cost is cleared, null when neither is.

- **The guard reads the cost fraction:** with the window at 11.2%, allowed at
  an 80% guard and refused at 5%.

- **Unpriced-model guard fallback, 17 assertions:** 90M output tokens from an
  unknown model read `$0`, yet `guardFraction` is 45× a $100 ceiling and the
  guard blocks; priced windows are unchanged, and no ceiling still refuses.

- **A parked run's time bar is frozen, and a resumed one starts where it left
  off.** Measured 2026-09-20 against the standalone bundle from this branch's
  own `npm run build`, on a scratch `DATA_DIR` with two hand-seeded rows: both
  `started_at` 4h50m ago with a 60-minute cap, one `running` carrying
  `paused_ms = 4h`, one `paused` with `paused_at` 4h ago. Both drew
  `50m 0s / 60m`; reloaded 45 seconds later the running one read `50m 47s` and
  the parked one still read `50m 0s`. Caveat: the rows were written straight
  into `runs` rather than reached by parking a real run, so this measures the
  page's arithmetic against the columns and not the orchestrator's writes to
  them — those are covered by `src/lib/orchestrator.test.ts`.

- **Reserved headroom:** a 50% reserve halves a $200 ceiling to $100, doubling
  the reading (13.8% → 27.5%) past a 20% guard; 400% clamps to 95%.

- **Budget policy and guard order, `npm test` 11 cases:** `normalizePolicy` is
  idempotent over JSON; `evaluateBudget` refuses `no_terminus` first, parks on
  the 5-hour window only under `live-resume` and never on the weekly, and
  blocks on reconciled spend that `spent_usd` alone would miss.

- **`--max-budget-usd` binds while the CLI waits on background sub-agents,
  2026-10-05.** Host `claude` 2.1.280 against a local stub Messages server with
  a fake key, a background sub-agent whose first response the stub priced at
  about $1.00, `--max-budget-usd 0.50` and the wait ceiling at `0`. 5.2 s in,
  when that response landed, stderr printed `Budget limit reached ($1.00 of
  $0.5); stopping background agents.`, the task was killed (`task_updated
  killed`, `task_notification stopped`) and the cycle ended with a `result` whose
  subtype was `success`, `total_cost_usd` 1.0009 and exit 0 — **not**
  `error_max_budget_usd`, so `buildArgs`' branch for that subtype does not see
  this ending and the pre-cycle `run_cost` check is what stops the run. When
  the *main* thread's own turn crossed the cap the result was
  `error_max_budget_usd`, `is_error` true, exit 1, and the background agent was
  killed with the same stderr line. Caveat: stub-reported usage priced by the
  CLI, so it shows the flag is honoured on `-p` and that sub-agent spend counts,
  not what a real cycle overshoots by; the stub's second sub-agent request was
  already in flight and was not billed.

- **An idle wait for a background sub-agent writes nothing to stdout or stderr,
  2026-10-05.** The same stub with the ceiling at `0` and a sub-agent that made
  no tool calls: the largest gap between lines was 69.98 s in a 70 s run and
  139.9 s in a 140 s one — no heartbeat and no `task_progress`. A sub-agent that
  is making tool calls prints a `task_progress` and its own assistant and tool
  lines at each one, which is what keeps `cycleSilenceMs`'s clock from running
  down. So the silence deadline does bind during a quiet wait, and ends the
  cycle `failed`, not through the CLI's own ceiling. Not measured: a sub-agent
  inside one long real Bash call, because the CLI's Bash tool could not start in
  the sandbox this ran in.

- **A fraction guard in a stored budget, picked up through `POST /api/fleet`,
  spawned its cycle unread; it is now refused, 2026-11-08.** A scratch test, not
  kept, over a throwaway `DATA_DIR` with `CLAUDE_BIN` and `child_process.spawn`
  stubbed (`costOutlierGuard.test.ts`'s shape): one stopped row whose blob was
  `{ maxIterations: 1, maxWeeklyFraction: 0.5 }`, no weekly ceiling
  (`currentSnapshot()` read `weekly.fraction` null), the fleet unpaused, body
  `{ action: "reopen", runIds, budget: { moreIterations: 1 } }`. Before the
  change: 200, `queued` then `running`, one spawn, `run.guard_unreadable` at
  `info`, a `budget` event with `code: "no_ceiling"` and `enforceable: false`,
  and the run ended `completed`. After: 400 carrying the weekly sentence,
  status `stopped`, no spawn. Caveat: the stub stands in for the CLI, so this
  measures the loop's decision to spawn and not a billed cycle, and the reading
  was empty because the scratch home had no transcripts and no provider
  percentage, not because a real endpoint was down.

- **A fraction guard in a restart-closed run's stored budget, picked up through
  `POST /api/runs/restarted`, spawned its cycle unread; it is now refused,
  2026-11-08.** The same scratch drive as the fleet entry above, not kept: a
  throwaway `DATA_DIR`, `child_process.spawn` stubbed for `CLAUDE_BIN`, the
  fleet unpaused, one `stopped` row with `restart_closed = 1` and a blob of
  `{ maxIterations: 1, maxWeeklyFraction: 0.5 }`, no weekly ceiling
  (`currentSnapshot().weekly.fraction` null), the compiled route's `POST` called
  with no body. On the tree before the change: 200, `{ reopened: 1, refused: [] }`,
  one spawn, a `budget` event with `code: "no_ceiling"` and `enforceable: false`,
  the run `completed` and `restart_closed` cleared. After: 200,
  `{ reopened: 0, refused: [{ id, reason }] }` with the weekly sentence, no
  spawn, the run `stopped` with `restart_closed` still 1. The kept test,
  `src/app/api/runs/restarted/route.test.ts`, failed 4 of its 5 cases on the old
  door (the fifth, a window with a reading, is there to stop the refusal being
  widened) and failed only the Codex case with the provider mapping forced to
  `claude`. Caveat: as the fleet entry's — a stub stands in for the CLI, so this
  measures the loop's decision to spawn and not a billed cycle, and the reading
  was empty because the scratch home had no transcripts and no provider
  percentage, not because a real endpoint was down. Not driven: the notice's
  rendering of a refusal in a browser; `restartClosedView.test.ts` pins its text
  handling, and the sentence is the one the reopen route already shows.

- **A fraction guard on a chat proposal, approved through `POST
  /api/chat/[id]/proposals`, spawned its cycle unread; it is now refused,
  2026-11-09.** A scratch drive, not kept, over a throwaway `DATA_DIR` with
  `child_process.spawn` stubbed for `CLAUDE_BIN` (`costOutlierGuard.test.ts`'s
  shape) and the fleet unpaused: `chatDefaultGuards.budget` set to
  `{ maxIterations: 1, maxWeeklyFraction: 0.5 }` before the card was written (an
  untemplated card freezes that set), `planUsageFromApi` off and no weekly
  ceiling (`currentSnapshot().weekly.fraction` null), the compiled route's `POST`
  called with `{ action: "approve", ids }`. Before the change: 200 with the run
  in `started`, the proposal `approved`, the run `queued` then `running`, one
  spawn, `run.guard_unreadable` at `info`, a `budget` event with `code:
  "no_ceiling"` and `enforceable: false`, the run `completed` — the guard
  recorded and never read. After: 400 carrying the weekly sentence led by the
  card's title and ending "Nothing was decided", the proposal still `pending`,
  no run row, no spawn. The kept test, `src/app/api/chat/[id]/proposals/route.test.ts`,
  failed 6 of its 8 cases on the old door (the plain approval and the reject are
  there to stop the refusal being widened) and failed only the Codex case with
  `guardWindowsOf` forced to answer `claude`. Caveat: as the fleet entry's — a
  stub stands in for the CLI, so this measures the loop's decision to spawn and
  not a billed cycle, and the reading was empty because the scratch home had no
  transcripts and no provider percentage, not because a real endpoint was down.
  Not driven: the chat page's rendering of the refusal, which `ChatPanel`'s
  `decide` puts under the button from the route's `error` as it does for the
  install-limit refusal (read, not rendered); and the double click that the
  route's ordering of its `await` guards against, read from `markProposal`'s
  unconditional `UPDATE`, not run.

- **A fraction guard on a workflow block's template, started through a press of
  Run, spawned its member unread; the press now refuses it, and the later
  creators still start theirs and record it, 2026-11-09.** A scratch drive, not
  kept, over a throwaway `DATA_DIR` with `child_process.spawn` stubbed for
  `CLAUDE_BIN` (`costOutlierGuard.test.ts`'s shape) and the fleet unpaused: one
  run block whose template held `{ maxIterations: 1, maxWeeklyFraction: 0.5 }`
  (and, separately, `maxSessionFraction`), `planUsageFromApi` off and no ceiling
  (`currentSnapshot()`'s fractions null), the compiled `startWorkflow` called as
  the route calls it. Before: `ok: true`, the member `queued` then `running`, one
  spawn, `run.guard_unreadable` at `info`, a `budget` event with `code:
  "no_ceiling"` and `enforceable: false`, the run `completed`. After: `ok:
  false` with the window's sentence led by the block's name, no instance row, no
  run, no spawn. The three later creators were driven the same way with the
  guard added to the template **after** the press: a node behind an orchestrator
  block (`advanceInstanceRound`), a run that block emitted (`emitBlockRuns`) and
  a repeated block's pass (`stepPass`, with the guard on the template before the
  press, which the new door refuses, so that pass was only reached on the old
  build). Each of the first two spawned with the same `no_ceiling` /
  `enforceable: false` event on its own feed, on the old build and on the new
  one, which is the record the deferred paths rely on instead of a refusal. The
  kept test, `src/app/api/workflows/[id]/run/route.test.ts`, failed 8 of its 10
  cases on the old door (the plain press and the Codex block with a reading of
  its own are the two that pass there, to stop the refusal being widened), and
  mutating the compiled tree failed only the two Codex cases when the
  route fetched no Codex reading, when the provider was dropped from the
  refusal, and when `workflowGuardWindows` always answered `claude`. Caveat: a stub stands in
  for the CLI, so this measures the decision to spawn and not a billed cycle, and
  the reading was empty because the scratch home had no transcripts and no
  provider percentage, not because a real endpoint was down. Not driven:
  `stepPass` on the new build (the guard is refused before a pass can exist, so
  it was only reached before the change), the workflow page's rendering of the
  refusal beside Run (the route's `error` goes where the instance budget's
  already does, read, not rendered), and a Codex block with a readable window
  through the real app-server, which the test stands in for with the usage
  cache.

## Not yet verified by hand

- **The process budget has never refused a real child in a browser, nor
  deferred and woken a real block.** `assistBudget.test.ts` covers it. Settle:
  *Other Claude processes at the same time* at 1, a workflow block behind
  something slow and a chat turn; the block should wait, then start as the
  chat settles.

- **A billed work cycle stopping at its `--max-budget-usd` ceiling.** The argv
  is unit tested and the CLI honours the flag on `-p` against a stub (the entry
  above), but no billed cycle has hit it, so how far a real cycle overshoots is
  reasoned, not measured.

- **A work cycle with no run limit stopping at the install's headroom (added
  2026-10-25).** `resumedCycleSpend.test.ts` hands a stub child the headroom
  and has it answer `error_max_budget_usd`; no billed cycle has hit it, so that
  the pinned CLI stops a `-p` cycle there and the run ends `guard:install_cost`
  is reasoned, not measured, on the premise of the entry above. Settle: set the
  install's daily limit a dollar above what it holds, clear a run's cost limit
  and start one that will spend more; it should end `stopped` on
  `guard:install_cost` with the `$1.00 left` sentence.

- **A work cycle whose run limit is larger than the install's headroom
  stopping at that headroom (added 2026-10-25).** The same stub test hands a
  run at a $100 limit under $5 of headroom `--max-budget-usd 5`; no billed
  cycle has hit it, on the premise of the two entries above. Settle: the same
  setup with the run's cost limit at $100; the argv should carry the headroom,
  and the run should end `stopped` on `guard:install_cost`, not `guard:run_cost`.

- **A conflict resolution stopping at `resolutionBudgetUSD` (added
  2026-09-27).** `resolutionBudget.test.ts` asserts the argv against a stub
  CLI; no billed resolution has hit it, so that the pinned CLI ends a `-p`
  resolution there and the merge is rolled back is reasoned, not measured.
  Settle: *Limit per conflict resolution* at 0.05, press Resolve on a
  conflicting run; the row should fail naming `error_max_budget_usd` and the
  branch should be unchanged.

- **A workflow-wide budget tripping against real spend.** No instance has been
  halted by a guard; `instanceSpend` has never summed a real `otlp_requests`
  row.
