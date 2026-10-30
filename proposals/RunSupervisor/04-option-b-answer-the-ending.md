# Option B: make `NEEDS_REVIEW` cheaper to answer

## 1. Its strongest case

It is the operator's idea applied to the only traffic that was measured. Every
question a run raised that needed an answer needed **the operator's**
([`00-problem.md`](00-problem.md) §2): a security posture, a deployment
capability, an ordering call, a vault layout. The run that asked had already done
the reading and written the options. The cheapest supervisor for that traffic is
the operator, answering **the run that asked**, in the session that holds the
reading, without editing its budget first.

The mechanism is already built and has a test suite.

- `needs-review` is reopenable by name (`docs/agent/run-lifecycle/reopen-and-resume.md:11`).
- The operator's note becomes the whole next prompt, verbatim
  (`src/lib/cycleInvocation.ts:391`).
- The session is resumed (`--resume`), so the run's own question is the last
  thing in its context.

What is missing is two pieces of friction and one label.

## 2. Shape

1. **An answer box where the question is.** On a `needs-review` run's page, under
   the reason (`src/app/runs/[id]/page.tsx:1693`-`:1697`), add a text field and
   one button, "Answer and resume". It calls the existing reopen route with the
   text as the note. The note stays verbatim, as `docs/runs.md` promises.
2. **The asking cycle is refunded, bounded, as the stack park's is.** Today
   `reopenRun` refuses at `iterations >= maxIterations + grantedCycles`
   (`src/lib/orchestrator.ts:15951`-`:15966`), so on the default cap of one the
   operator must type a higher limit before an answer can be delivered.
   - The answered pick-up gives back the cycle that ended `needs-review`, exactly
     as `parkForStack` gives back the cycle that asked
     (`src/lib/orchestrator.ts:11821`-`:11836`).
   - It is counted on a new never-reset column, `runs.review_answers`, and bounded
     by `MAX_ANSWERED_REVIEWS_PER_RUN` = 3, `MAX_STACK_WAITS_PER_RUN`'s value and
     arrangement (`src/lib/stackRequests.ts:83`).
   - Past the bound, the door behaves as it does today.
3. **The page says what answering does.** Beside the box it reads "Answering
   resumes this run in the same session and gives back the work cycle it ended
   on (N of 3 left)". A `needs-review` row is unanswered by definition, because a
   pick-up moves it to `queued`, so the existing "Needs review" headline is
   already the "asked you" marker and nothing is relabelled.

No new status, no new tool, no model.

## 3. The forks

| Fork | Where B stands |
|---|---|
| **Who is on the other end** | The operator only. Nothing answers on their behalf. |
| **Transport, and when the answer lands** | Ask-and-end, then a pick-up. The answer is the next segment's `-p` text through `runs.follow_up`, read once at the spawn (`src/lib/orchestrator.ts:11668`). Latency is the operator's attention. |
| **Folder claim** | Unchanged from today. The ending releases it, and the pick-up re-claims it through `promoteQueued`. A pick-up is refused if another run took the worktree slot (`src/lib/orchestrator.ts:15893`-`:15901`). |
| **`maxDurationMinutes`** | Unchanged. The reopen restarts the worked-minutes clock (`src/lib/orchestrator.ts:16064`-`:16070`). |
| **`maxIterations`** | The asking cycle is refunded, at most three times per run, on a count the reopen never resets. This is the stack park's terminus argument whole (`docs/agent/run-lifecycle/waiting-for-stack.md:11`). It is a **person's** press that spends the refund, which C1 requires. |
| **`reconcileOnBoot`** | Untouched. The row is terminal (`src/lib/orchestrator.ts:16920`-`:16931`). |
| **Authority** | Every answer is the operator's. Nothing in C2's right-hand column can be granted by the box: it carries a sentence, not a budget. The reopen route still validates the policy it is sent (`src/app/api/runs/[id]/reopen/route.ts:62`-`:98`). |
| **Spend with nobody present** | None. The cycle an answer starts passes the pre-cycle `evaluateBudget` (`src/lib/orchestrator.ts:12058`-`:12075`), and an answer cannot be given with nobody present. |
| **Injection** | The run's reason is read by a person. The answer is a person's words. No model reads another model's text on the way. |
| **What the operator sees** | The reason and the answer, both on the run page. The answer is also the cycle's prompt, shown under the run's next cycle row (`proposals/ContinuousImprovement/README.md`, item 0e). `run.needs_review` already notifies. In the morning: the runs list filtered to `needs-review`, every row of which is a question nobody has answered. |
| **Providers** | All three. `cycleEnding` reads the final text whatever CLI wrote it. A Codex run's session resumes through its own adapter. A local run is unchanged. |
| **Too much, too little** | Floor: an answer box nobody uses is visible as unanswered `needs-review` rows older than a week. Kill criterion, fixed in [`13-validation.md`](13-validation.md) §3: if the operator keeps answering decisions by starting fresh runs, B was wrong about why the pick-up route is unused. B does not make asking cheaper for the run. The notice's wording, which makes the ending cost more than carrying on, stays. |

## 4. Cost to build

Half a day to a day.

- One component on the run page.
- One column in `migrate()` (`src/lib/db.ts`).
- One branch in `reopenRun` beside the `grantedCycles` arithmetic.
- One unit test on the refund's bound.
- A line in `docs/agent/run-lifecycle/reopen-and-resume.md`.

[`12-implementation-sketch.md`](12-implementation-sketch.md) Phase 1 names the
files.

## 5. What it does not do

- **It does not keep the run's place.** The run ends and its worktree slot is
  free. On this install that has not been seen to matter, but nothing measured
  it either. If it bites, it is [Option C](05-option-c-ask-and-park.md)'s case.
- **It does not answer anything a model could.** Three such questions were
  measured in a month.
- **It does not reach an operator who is away any faster.** The webhook does
  that already, and B inherits it.

## 6. What would have to be true

That a decision answered to the run that asked is worth more than one answered to
a fresh run, and that the operator would use the box. The first is the
ContinuousImprovement re-derivation argument, and it is strong. The second is
unmeasured: zero pick-up notes in the window. That is why B's kill criterion is
about use, not about correctness.

## Verdict

**Recommended**, as the whole of what the measured traffic supports, and it is
small. It is the stack park's refund applied to the ending this app already
teaches, and it adds nothing a model could get wrong. Be clear about its reach.
Of the ≈ 13 decisions in the window, four arrived as a `needs-review` ending:
`925e5b4e` and `9f968ffa` each reserve a choice for the operator, `2ce878df` had
no task at all, and `b8664b0d` asked whether its documented state was enough to
close. Those four are what B reaches. The rest went to the board as tasks, and B
changes nothing for them; they stay [A](03-option-a-build-nothing.md)'s.
