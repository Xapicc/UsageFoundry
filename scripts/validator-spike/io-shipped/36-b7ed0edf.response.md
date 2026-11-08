I judge the work finished.

The task asked for `maxInstanceCostUSD`, `maxSessionFraction` and `maxWeeklyFraction` on a workflow instance, all nullable. The diff has all three:
- **Limits and storage:** `InstanceBudgetDTO` in `apiTypes.ts` carries them. `db.ts` adds `instance_budget` columns on both `workflows` and `workflow_instances`.
- **Verdict function:** `budget.test.ts` imports `evaluateInstanceBudget`, `normalizeInstanceBudget`, `instanceBudgetIsOff` and `INSTANCE_ENFORCEABLE_CODES`. The verdicts reuse the existing `no_ceiling` code and the guard-reading rule, and `budget.ts` is in the changed-file list.
- **Enforcement:** `orchestrator.ts` calls `enforceInstanceBudget` before each cycle, as a between-nodes check. It halts through the `stopInstance` function the earlier node added, and it emits a `budget` event with `scope: "workflow"`.
- **Telemetry door:** `runs.active_started_at` is added and stamped, so `telemetrySpendSince` has a lower bound.
- **Setting the limits:** `WorkflowEditor.tsx` holds the three fields. `route.ts` reads no body, so nothing a model emits can set them.
- **UI and copy:** both workflow pages show the limits, and the instance page renders a `Meter` where an unknown fraction is null (hatched). The overshoot bound, the choice not to build a live mode, and the missing terminus are written out in the README, the editor hints and the instance page.
- **Tests:** `budget.test.ts` covers cap unreached, reached exactly, in-flight spend, estimate-only spend, a fraction with no ceiling, the provider percentage with no ceiling, and a window that falls back under the limit after tripping.

Three things are not shown. The bodies of `budget.ts`, `workflows.ts` and `CLAUDE.md` were cut from the diff, though all three are listed as changed. Nothing visible covers "orchestrator-block turns" in the instance total. Nothing here can show whether the code builds or the tests pass. None of these is a deliverable the evidence shows to be missing.

```json
{
  "verdict": "finished",
  "reason": "Instance budget limits, evaluateInstanceBudget with tests, between-nodes enforcement via stopInstance, DB columns, UI and overshoot copy are all present; three file bodies were cut but listed as changed.",
  "evidence": [
    "src/lib/budget.test.ts imports and exercises evaluateInstanceBudget, normalizeInstanceBudget and INSTANCE_ENFORCEABLE_CODES, with all the requested cases",
    "src/lib/orchestrator.ts calls enforceInstanceBudget before each cycle and emits a scope:workflow budget event",
    "src/lib/db.ts adds instance_budget on workflows and workflow_instances, and runs.active_started_at",
    "src/components/WorkflowEditor.tsx and src/app/api/workflows/[id]/run/route.ts: limits are set on the form only, the run route reads no body",
    "Instance page renders a Meter with a null fraction when no spending limit is set",
    "budget.ts, workflows.ts and CLAUDE.md are in the changed list but their bodies were cut; orchestrator-block turn counting is not visible"
  ]
}
```
