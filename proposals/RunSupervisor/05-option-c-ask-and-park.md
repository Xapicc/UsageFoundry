# Option C: ask the operator and park, the stack precedent made general

## 1. Its strongest case

It is the closest thing to what the operator asked for that the evidence allows:
a run asks a question **without ending**, keeps its place, and resumes in the
same session with the answer. Every hard decision has already been made once, for
stacks, and tested ([`02-what-already-asks.md`](02-what-already-asks.md) §2):

- park at the boundary off the record;
- a bounded refund;
- `paused_ms`;
- folder yielded, slot kept;
- `NOTIFY_PARKS`;
- restart-safe;
- answer in `follow_up`.

The chat's `ask_operator` supplies the other half: structured questions with
choices, caps, quoting each question above its answer, and superseding
(`docs/agent/chat/operator-questions.md:7`, `:21`).

## 2. Shape

- **A run tool, `ask_operator`.** It takes the chat's schema
  (`src/app/api/mcp/route.ts:1290`-`:1339`): up to five questions, eight choices,
  2,000 and 150 characters. It records `run_questions` rows and returns "End this
  work cycle now". That is `request_stack`'s reply
  (`src/app/api/mcp/route.ts:5065`-`:5069`).
- **The park.** At the boundary, `questionWaitOf(id)` beside `stackWaitOf`
  (`src/lib/orchestrator.ts:13644`-`:13652`) parks the run as
  `waiting-for-answer`, with `paused_at` opened, the cycle refunded and
  `run_questions_waits` counted. The tool refuses at the bound.
- **The answer.** On the run page, the question card with its choices. Answering
  flips the row to `queued` with `follow_up` = the chat's `answerMessage` shape
  (`src/lib/chat.ts:1011`-`:1017`). Stopping the run supersedes the questions.
- **Notify.** `waiting-for-answer` joins `NOTIFY_PARKS` (`src/lib/notify.ts:126`).

## 3. The forks

| Fork | Where C stands |
|---|---|
| **Who** | The operator only |
| **Transport, and when** | Ask-and-park at the cycle end. The answer lands as the next segment's prompt |
| **Folder claim** | Yielded while parked, as a stack park's is (`src/lib/orchestrator.ts:5417`-`:5419`). The worktree slot is kept. A sibling may take the folder; the parked run queues behind it on release |
| **`maxDurationMinutes`** | Waiting is never worked minutes: `paused_at` → `paused_ms` (`docs/agent/budgets-and-guards/termini-and-waiting.md:11`) |
| **`maxIterations`** | The asking cycle refunded, ≤ 3 per run on a never-reset count, as the stack park does |
| **`reconcileOnBoot`** | **A new decision.** A stack waits *on* a restart, so it is kept at any age. A question waits on a click, so the `paused` grace (`resumeGraceHours`) is the closer precedent. A question older than the grace is closed `stopped`, and its rows are kept for the page |
| **Authority** | The operator answers; nothing else does |
| **Spend with nobody present** | None. The release is the operator's press (C1) |
| **Injection** | The question is a run's text read by a person. The answer is a person's text read by one run |
| **What the operator sees** | A card on the run page, a fifth figure on `/runs/live` beside `waiting-for-stack`'s (`src/lib/liveStream.ts:131`-`:151`), and the webhook |
| **Providers** | All three get the tool through the same token (`src/lib/cycleInvocation.ts:1882`-`:1890`). A local run carries its full schema on every request, because `ENABLE_TOOL_SEARCH=false` (`docs/agent/local-provider.md:9`) |
| **Too much, too little** | The tool would be deferred, as every run tool is. On `ask_operator`'s history it would be found only when the task is about it ([`02-what-already-asks.md`](02-what-already-asks.md) §3), unless the cycle's notices name it. Naming it beside `NEEDS_REVIEW_NOTICE` makes two ways to reach a person, and the run has to choose between them |

## 4. What it costs

- **Build.** Two to three days. A table, a status that has to be added to every
  set that already lists `waiting-for-stack`, a tool, a park branch, a release, a
  card, a reconcile decision, and their tests. The status alone touches
  `activeRuns()`, `LIVE_STATUSES`, `liveCounts`, `NOTIFY_PARKS`, `stopRun`'s
  branch and the boot. Each of those sets fails silently if one is missed, which
  is the trap `docs/agent/run-lifecycle/waiting-for-stack.md:13` lists for the
  stack park.
- **Standing cost.** A deferred tool's name in every run's tool list. Its full
  schema on every local run's every request.

## 5. What it buys over B

On the measured traffic, very little.

- **The run keeps its worktree slot while it waits.** No pick-up in the window
  was refused for a taken slot. That cannot be measured from transcripts, so it is
  assumed rare, not shown rare.
- **The question is structured** (choices) rather than a free-text reason. The two
  `needs-review` reasons that reserve a choice already listed their options in
  prose, and one recommended one.
- **The run is not counted as ended** on the runs list, so it does not look like
  a judgement on the task.

It carries the same three or four `needs-review` decisions B does, and it competes with the
ending runs already know. Runs did not use `request_stack` once in the window.
A second ask-and-park tool has no evidence it would fare differently.

## Verdict

**Not now.** It is what B grows into **if** pick-ups start being refused because
a sibling took the slot, or if decision-shaped endings rise once briefs stop
saying nobody will answer. [`13-validation.md`](13-validation.md) §3 fixes both
thresholds. Its design is complete enough here that nothing about it would need
deciding again.
