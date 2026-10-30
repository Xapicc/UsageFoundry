# 12: Implementation sketch

Phase 1 is the recommendation and is useful on its own. Phase 2 is a readout the
operator runs. Phases 3 and 4 are built only if a threshold in
[`13-validation.md`](13-validation.md) §3 fires, and are specified here so that
nothing about them has to be decided again.

## Phase 1: answer the ending (Option B), one commit

**What changes.** A pick-up of a `needs-review` run that carries a note gives
back the cycle the run ended on, at most three times per run. The run page grows
an answer box under the reason.

| File | Change |
|---|---|
| `src/lib/db.ts` | In `migrate()`, beside `stack_waits` (`src/lib/db.ts:995`): `addColumn(db, "runs", "review_answers", "INTEGER NOT NULL DEFAULT 0")`. Idempotent, as every statement there is |
| `src/lib/orchestrator.ts` | A pure `answeredReviewRefund({ status, note, iterations, reviewAnswers })` returning whether this pick-up refunds. True only for `needs-review`, a non-empty trimmed note, `reviewAnswers < MAX_ANSWERED_REVIEWS_PER_RUN` (3) and `iterations > 0`. `reopenRun` (`src/lib/orchestrator.ts:15813`) asks it **before** the cap refusal (`:15951`-`:15966`) and tests the cap against `iterations − 1` when it refunds. The reopen UPDATE (`:16064`-`:16070`) then writes `iterations = iterations − 1, review_answers = review_answers + 1, pause_count = pause_count + 1` |
| `src/lib/apiTypes.ts` | `RunDTO.reviewAnswers`, so the page can say how many refunds are left |
| `src/app/runs/[id]/page.tsx` | Under the reason (`src/app/runs/[id]/page.tsx:1693`-`:1697`), an `Input`-kit text area and one button, "Answer and resume". It posts `{ followUp }` to `POST /api/runs/[id]/reopen` with the run's stored budget, through the same call the existing Resume makes. It shows the refund sentence from [B](04-option-b-answer-the-ending.md) §2 |
| `src/app/api/runs/[id]/reopen/route.ts` | No change. It already reads `followUp` (`src/app/api/runs/[id]/reopen/route.ts:55`) and validates the budget |

**The two traps, named so that the build does not rediscover them.**

1. **`pause_count` advances with the refund.** The stack park advances it "because
   the refund can put `iterations` back to zero on a run whose branch exists and
   `ensureWorktree` reads that column as 'has worked before'"
   (`docs/agent/run-lifecycle/waiting-for-stack.md:11`). A one-cycle run refunded
   to zero without it would be treated as never having worked.
2. **The note stays verbatim.** `nextPrompt` returns `o.followUp` alone
   (`src/lib/cycleInvocation.ts:391`), and `docs/runs.md` promises that the
   operator's words are sent as typed. The box must not wrap them. The run has
   its session, so its own question is already the last thing in its context.
   That is why `NEEDS_REVIEW_PICKUP_NOTICE` does not quote the reason back
   (`docs/agent/run-lifecycle/reopen-and-resume.md:11`).

**Test.** `src/lib/answeredReviewRefund.test.ts`, or a block in the existing
reopen suite, over the pure function. It pins:

- refund on `needs-review` with a note;
- none without a note, because a bare Resume asks whether the wall is still there
  and is not an answer;
- none on `failed`, `stopped` or `completed`;
- none at the bound;
- none at `iterations` 0.

This meets `docs/agent/testing.md`'s bar: a refund applied wrongly either ends an
answered run on its cap with nothing said, or buys unbounded cycles. Both are
silent.

**Docs, in the same commit.**

- `docs/agent/run-lifecycle/reopen-and-resume.md`: one paragraph under the
  `needs-review` pick-up.
- `docs/agent/budgets-and-guards/termini-and-waiting.md`: the third bounded
  refund, beside `guard_refunds` and `stack_waits`, and why it keeps
  `maxIterations` a terminus.
- `docs/runs.md`: the operator-facing sentence.
- A *Verified* entry in the run-lifecycle file under `docs/verification/` for the
  manual check in [`13-validation.md`](13-validation.md) §1.

**What it must not touch.**

- `NEEDS_REVIEW_NOTICE`'s wording, which is written to make the ending dearer than
  carrying on.
- The bulk pick-up's exclusion of `needs-review` (`src/app/runs/page.tsx:118`).
- The webhook body.

## Phase 2: the readout, no code

[`scripts/readout.sql`](scripts/readout.sql), run by the operator monthly:

```sh
docker exec -i usagefoundry sqlite3 -readonly /data/usagefoundry.db < proposals/RunSupervisor/scripts/readout.sql
```

It counts, per week:

- `needs-review` endings;
- pick-ups of them with a note;
- refunds spent (after Phase 1);
- tasks runs filed `operatorOnly`.

Its output is what [`13-validation.md`](13-validation.md) §3's thresholds are read
against. A work cycle cannot run it, because `/data` is denied to the sandbox.

## Phase 3, only if the overturning fact fires: the tiered supervisor (Option D)

| File | Change |
|---|---|
| `src/lib/supervisor.ts` (new) | `tierZero(question, kind)`: pure, matches [`01-constraints.md`](01-constraints.md) C2's escalation kinds and returns the fixed escalation sentence. `composeSupervisorPrompt(run, question, sources)`: pure, and takes **only** the asking run's id, so no other run's text can reach the context. `askSupervisor(runId, args)`: spawns as `src/lib/vaultPointer.ts:538`-`:560` does, with `--tools ""`, `--setting-sources ""`, `--strict-mcp-config`, `--disable-slash-commands`, `reviewEnv()`, a 45-second clock and `--max-budget-usd 0.10`, behind its own concurrency bound of 2 |
| `src/app/api/mcp/route.ts` | `ask_supervisor` in `RUN_TOOLS` (`src/app/api/mcp/route.ts:642`-`:961`), handled beside `request_stack` (`:2730`). Refused past `MAX_SUPERVISOR_QUESTIONS_PER_RUN` (5) and on `assistRefusal()` |
| `src/lib/db.ts` | `run_supervisions(id, run_id, created_at, kind, tier, question, answer, sources_json, escalated, cost_usd, duration_ms)`, cascading with the run. `runs.supervisor_questions` count |
| `src/lib/installBudget.ts` | A term for `run_supervisions.cost_usd` in `installSpend` (`src/lib/installBudget.ts:111`-`:217`), so the daily limit binds it |
| `src/lib/cycleInvocation.ts` | Name the tool once in `TASKBOARD_NOTICE` (`src/lib/cycleInvocation.ts:1111`-`:1123`). Deferred and unnamed, it would be found as rarely as `ask_operator` was |
| `src/app/runs/[id]/page.tsx` | A section listing each question, its tier, answer, sources and cost |
| `docs/agent/architecture/run-loop-and-child-processes.md` | The argument for it as a child kind: or why it is not one, the vault gate's argument (`docs/agent/run-lifecycle/vault-pointer.md:23`) |
| `docs/agent/run-lifecycle/supervisor.md` (new) and its index line | The invariants: stateless, tool-less, server-gated, never wakes, never notifies |

**Tests.**

- `tierZero` over every C2 kind. Its failure mode is a guard request answered by
  a model, which is silent.
- `composeSupervisorPrompt`: asserts that no text from a second run reaches the
  context, given two runs' rows.
- The `installSpend` term.

**Not in Phase 3.** No `timeout` in `writeMcpConfig`: the 45-second clock fits
under the measured 60 s. Raising it would need the field, and a reason.

## Phase 4, only if pick-ups fail for a taken slot: ask and park (Option C)

[C](05-option-c-ask-and-park.md) §2 is the specification: the chat's question
schema, the stack park's boundary branch, refund and release, and a
`waiting-for-answer` status. **The status must be added to every set that
already lists `waiting-for-stack`.** That means `activeRuns()`
(`src/lib/orchestrator.ts:4408`-`:4414`), `LIVE_STATUSES`
(`src/lib/workflows.ts:3742`-`:3748`), `liveCounts` (`src/lib/liveStream.ts:131`-`:151`),
`NOTIFY_PARKS` (`src/lib/notify.ts:126`), `stopRun`'s park branch and
`reconcileOnBoot`. Each one fails silently if missed. The boot decision is the
one new choice, and C §3 makes it: the `paused` grace, not "any age".
