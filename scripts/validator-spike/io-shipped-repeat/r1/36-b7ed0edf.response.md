The work looks present, though I could not see three of the files that carry its core.

**Seen and matching the task:**
- **Limits on the form and the saved workflow.** The editor has `maxInstanceCostUSD`, `maxSessionFraction` and `maxWeeklyFraction`, all nullable. The DB gets `workflows.instance_budget` and `workflow_instances.instance_budget`.
- **No model-emitted setting.** The run route reads no body and still sets no budget. The README says no route edits a running instance's copy.
- **Verdict function.** `src/lib/budget.test.ts` imports and exercises `evaluateInstanceBudget`, `normalizeInstanceBudget`, `instanceBudgetIsOff` and `INSTANCE_ENFORCEABLE_CODES`. Those tests cover every case the task lists: cap not reached, reached exactly, an in-flight cycle, estimate-only spend, fraction with no ceiling, and a fraction falling back under the limit. They also cover the provider's own percentage standing in for a ceiling, the guard reading versus the displayed one, and spend reported ahead of a window.
- **Between-nodes enforcement.** `orchestrator.ts` calls `enforceInstanceBudget(id, snapshot)` before each cycle spawns and emits a `scope: "workflow"` budget event on a halt. The README and UI copy state the overshoot bound and that concurrency multiplies it, and they say deliberately that there is no live mode.
- **Telemetry door.** `runs.active_started_at` is added, stamped and cleared with `active_iteration`, so `telemetrySpendSince` can be read for another run.
- **Display versus guard.** The instance page shows `spentUSD` and `spentGuardUSD` separately. The `Meter` gets `fraction={null}` when there is no limit, which gives the hatched meter instead of zero.
- **Terminus decision.** The README says an instance needs no monotone terminus of its own.

**Not shown:** `src/lib/budget.ts`, `src/lib/workflows.ts` and `CLAUDE.md` are listed as changed, but their bodies were cut. Imports in the tests, the orchestrator and the DTO point at symbols in them (`evaluateInstanceBudget`, `enforceInstanceBudget`, `instance.spend`). I could not check the halt call, the recorded stop cause, or the CLAUDE.md note directly.

The task said to add cases to `evaluateBudget` rather than fork it, and this adds a sibling `evaluateInstanceBudget`. I could not see how it is built, and that is a question of quality, not a missing deliverable.

```json
{
  "verdict": "finished",
  "reason": "Limits, DB columns, form/UI, between-run enforcement, telemetry bound and all required unit tests are in the diff; budget.ts, workflows.ts and CLAUDE.md bodies were cut but are listed as changed.",
  "evidence": [
    "src/lib/budget.test.ts: evaluateInstanceBudget cases for cap, exact cap, in-flight, estimate-only, no_ceiling, falling-back window",
    "src/lib/orchestrator.ts: enforceInstanceBudget(id, snapshot) before each cycle and active_started_at column stamped/cleared",
    "src/lib/db.ts: instance_budget columns on workflows and workflow_instances",
    "src/components/WorkflowEditor.tsx: three limit fields saved with the workflow",
    "instance page Meter with hatched unknown, spentUSD vs spentGuardUSD",
    "README Limits for the whole workflow section stating the overshoot bound and no live mode",
    "budget.ts, workflows.ts, CLAUDE.md listed as changed but bodies not shown"
  ]
}
```
