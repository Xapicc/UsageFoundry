Most deliverables are visible in the shown diff, and the files whose bodies were cut are listed as changed. I did not see `src/lib/budget.ts`, `src/lib/workflows.ts` or `CLAUDE.md`. I infer their contents from the 12 files I did see.

- **Verdict function:** `budget.test.ts` imports and tests `evaluateInstanceBudget`, `normalizeInstanceBudget`, `instanceBudgetIsOff` and `INSTANCE_ENFORCEABLE_CODES` from `./budget`. That file is in the changed list.
- **Test cases the task listed:** all six are present:
  - under the cap, and exactly at it;
  - in-flight spend counted through `spentGuardUSD`;
  - a fraction guard with no ceiling returning `no_ceiling`;
  - a window falling back under the guard so the verdict allows again;
  - estimate-only spend with `spentUSD` at 0.
- **Provider percentage:** the tests also cover accepting the provider's own percentage as the ceiling, which is the `windows.ts` check the task asked for.
- **Wiring:** `orchestrator.ts` calls `enforceInstanceBudget(id, snapshot)` before each cycle, and a tripped guard halts every member through `stopInstance`. `db.ts` adds `instance_budget` on `workflows` and `workflow_instances`, and `runs.active_started_at` so the telemetry door can read one run's in-flight spend.
- **Who sets it:** only the editor form (`WorkflowEditor.tsx`) sets it. The run route reads no body, and the instance holds a copy taken when Run is pressed.
- **Display and guard split:** the DTOs carry `spentUSD` and `spentGuardUSD` separately. The instance page renders the `Meter` with `fraction` null (hatched) when there is no spending limit.
- **Copy:** the overshoot bound, the concurrency multiplier and the "no live mode" decision appear in the editor, the instance page and the README. The README also answers the monotone-terminus question. `logLine.ts` labels workflow-wide stops.
- **Not visible:** I could not confirm that `instanceSpend` includes orchestrator-block turns, as the task asked. That would live in the cut `workflows.ts` body. Nothing shown contradicts it, so I treated it as unverified rather than missing. I also could not confirm the `CLAUDE.md` text.
- **Not checkable from the diff:** the typecheck and test results the task asked to be reported.

```json
{
  "verdict": "finished",
  "reason": "Instance budget evaluator, six required test cases, enforcement hook, DB columns, UI and copy all present in the diff; budget.ts, workflows.ts and CLAUDE.md are listed as changed but cut.",
  "evidence": ["src/lib/budget.test.ts tests evaluateInstanceBudget, normalizeInstanceBudget and INSTANCE_ENFORCEABLE_CODES", "src/lib/orchestrator.ts calls enforceInstanceBudget and halts via stopInstance", "src/lib/db.ts adds instance_budget columns and runs.active_started_at", "src/components/WorkflowEditor.tsx, instance page and README carry the limits, overshoot bound and no-live-mode copy", "budget.ts, workflows.ts and CLAUDE.md listed as changed but bodies not shown"]
}
```
