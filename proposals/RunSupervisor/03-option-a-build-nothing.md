# Option A: build nothing

## 1. Its strongest case

The measured traffic is already carried, and by routes that never ask a model to
judge anything.

- **Decisions go to the board.** In 27 days runs handed about 13 decisions to the
  operator ([`00-problem.md`](00-problem.md) §2). They did it as an
  `operatorOnly` task, a `release_task` with the decision in its note, or a
  `NEEDS_REVIEW` ending that names the task to decide on: "What remains is your
  choice of option on task `6b4dccf3`."
- **Physical hand-offs need no answer.** Sixty of them were Mac or host checks.
  The run files the check, the operator does it on their Mac, and the run had
  nothing to wait for.
- **Errors were solved by the runs**, in a median of one message
  ([`00-problem.md`](00-problem.md) §2 (b)).
- **Questions about the task were settled by reading**: "the fix was already on
  main in 6181a6d".

Every one of those routes survives a restart, notifies where it should
(`run.needs_review`, `src/lib/notify.ts:108`-`:112`), is permanent on the task
page (`docs/agent/retention.md:24`), starts nothing, and costs nothing beyond the
run's own cycle. A supervisor adds a fourth way to reach the operator beside the
three that work, and *Orchestration Topologies* (vault, `confidence: medium`,
`status: growing`) finds that most added coordination loses to a matched single
agent.

## 2. Shape

Nothing changes. A run's brief keeps telling it that nobody will answer. The run
writes its judgement calls into its report, files what is the operator's, and
ends.

## 3. The forks

| Fork | Where A stands |
|---|---|
| Who is on the other end | The operator, through the board and the run page |
| Transport, and when the answer lands | Ask-and-end. The answer lands in a **new** run started from the task, or in a pick-up of the same run |
| Claim, duration, cycles, restart | The run ends, so its folder is released (`src/lib/orchestrator.ts:4408`-`:4414`). A new run claims afresh. Nothing is refunded and nothing is extended. Rows survive a restart. |
| Authority | Nobody but the operator answers, so nothing can be answered wrongly on their behalf |
| Spend with nobody present | None beyond the run's own |
| Injection | A run's note is read by a person on the task page. The next run reads the operator's answer as a task note, through a tool call (`docs/agent/taskboard/comments.md:63`-`:69`) |
| What the operator sees | The board and the runs list. In the morning, the `needs-review` filter and the `operatorOnly` tasks |
| Providers | All three. `NEEDS_REVIEW` is text, and the board tools reach Codex and local runs (`src/lib/cycleInvocation.ts:1882`-`:1890`) |
| Too much, too little | Unchanged. 1.4% of runs end `NEEDS_REVIEW`, and the notice is written to make that ending cost more than carrying on (`docs/agent/run-lifecycle/endings.md:17`) |

## 4. What it costs

**A decision answered on the board is answered to a stranger.** The run that
asked had the context: it had read the code, measured, and written five options
with their costs. The run that acts on the answer starts cold and re-derives it.
ContinuousImprovement measured re-derivation on this install, finding that 73.2%
of `Read` calls hit a file an earlier run had already read
(`proposals/ContinuousImprovement/README.md:72`). A new run pays that again, plus
a brief someone had to write.

The pick-up route avoids that and is unused: **zero** operator pick-up notes in
the window ([`00-problem.md`](00-problem.md) §2). Whether that is because it is
dear (a one-cycle run cannot be answered without first raising its cycle limit,
[`02-what-already-asks.md`](02-what-already-asks.md) §1) or because the operator
prefers a fresh brief, the data does not say.

## 5. What would have to be true

That about thirteen decisions a month answered to a fresh run cost less than any
change. At one fresh run per decision that is plausible, and it is the null this
survey has to beat.

## Verdict

**The honest baseline, and the runner-up.** It meets every constraint in
[`01-constraints.md`](01-constraints.md) by doing nothing, and its only cost is
the cold start of the run that acts on an answer. Option B is A plus a cheaper
way to give that answer to the run that asked.
