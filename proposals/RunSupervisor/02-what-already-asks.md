# 02: What already lets a run reach somebody

Every item below was verified in code at the commit that adds this file, or
measured with the command quoted. The same questions are asked of each:

- what it carries, who writes it and who reads it;
- **when** the reader sees it;
- whether it survives a restart (`reconcileOnBoot`);
- what the operator sees;
- whether it can start, wake or extend a run;
- what it does to the folder claim, `maxDurationMinutes` and `maxIterations`.

§7 comes last and decides which transports exist at all.

## 1. The `NEEDS_REVIEW` ending: a question asked by stopping

**What it is.** `NEEDS_REVIEW_NOTICE` (`src/lib/cycleInvocation.ts:654`) tells
every cycle that it may "reply with exactly NEEDS_REVIEW on its own line and
this run ends for a person to look at". It lists what counts as a wall: "a
credential that is not there, a permission you do not have, a decision that is
not yours to make, a repository or service you cannot reach". And it adds:
"Do not use it because the task is large, unclear or tedious". The notice rides
the opening join, the pushback and the continuation, and never the operator's
own note (`src/lib/cycleInvocation.ts:391`).

**How it is read.** `cycleEnding` matches the sentinel before `DONE`
(`src/lib/cycleInvocation.ts:691`-`:695`). The loop tests it below every rung
about the machine and below the stack park (`src/lib/orchestrator.ts:13657`).
The branch writes the cycle's final text into `needs_review_reason`, clipped to
`MAX_NEEDS_REVIEW_REASON` = 2,000 characters
(`src/lib/cycleInvocation.ts:211`), and ends the run `needs-review`
(`src/lib/orchestrator.ts:13669`-`:13686`).

**What a person sees.**

- The run page shows a warn-toned "Needs review" headline and the reason
  verbatim (`src/app/runs/[id]/page.tsx:497`-`:519`, `:1693`-`:1697`).
- A webhook fires as `run.needs_review` (`src/lib/notify.ts:108`-`:112`). Its
  body carries no reason, by design (`src/lib/notify.ts:64`).

**How it is answered.** The operator presses Resume on that run's page. Bulk
pick-up deliberately excludes it (`src/app/runs/page.tsx:118`), for the reason
recorded in `docs/agent/run-lifecycle/reopen-and-resume.md:11`. The route is
`POST /api/runs/[id]/reopen`, which calls `reopenRun`
(`src/app/api/runs/[id]/reopen/route.ts:100`). The operator's note becomes
`runs.follow_up` verbatim. With no note, `NEEDS_REVIEW_PICKUP_NOTICE` asks the
run whether the wall is still there (`src/lib/orchestrator.ts:15588`-`:15596`).
The note is the whole of the next cycle's prompt
(`src/lib/cycleInvocation.ts:391`).

**What it costs the run.** This is the friction a general channel would remove.

| | `needs-review` today |
|---|---|
| Folder | Released at the ending. The row leaves `activeRuns()` (`src/lib/orchestrator.ts:4408`-`:4414`). The pick-up queues behind whoever took the folder, and is refused outright if another run took the worktree slot (`src/lib/orchestrator.ts:15893`-`:15901`). |
| Cycle cap | **Not refunded.** `reopenRun` refuses at `iterations >= maxIterations + grantedCycles` (`src/lib/orchestrator.ts:15951`-`:15966`). On the default cap of one, the operator has to type a higher limit before the answer can be delivered. |
| Duration | The clock restarts: the reopen's UPDATE writes `started_at=NULL … paused_ms=0` (`src/lib/orchestrator.ts:16064`-`:16070`). |
| Session | Kept on the row. A terminal run's session is **not** in retention's keep set (`src/lib/retention.ts:748`-`:762`), so after `transcriptRetentionDays` (30, `src/lib/settings.ts:1151`) the pick-up starts fresh. |
| Restart | Untouched; it is terminal (`src/lib/orchestrator.ts:16920`-`:16931`). |
| Start, wake, extend | Nothing. Only a person's Resume re-queues it. |

**So it is a question and an answer with the whole run stopped in between.** The
answer is free text, the question is free text, and nothing pairs them. The
operator writes a note against a reason they read on the page, and the run reads
the note without its question beside it; the session supplies that. Every
property of a good channel is here except two: **it costs the run its place**,
and **on a one-cycle run it cannot be answered without editing the budget.**

## 2. `request_stack` and the `waiting-for-stack` park: the closest precedent

**What it is.** A run tool (`src/app/api/mcp/route.ts:907`-`:960`). It takes
`name`, `binaries`, `reason` and an optional `draft`. It records a request and
**returns at once**, telling the agent to "End this work cycle now … do not
reply DONE or NEEDS_REVIEW" (`src/app/api/mcp/route.ts:5065`-`:5069`). It
exists only while `taskboardForRuns` is on, and that setting defaults to off
(`src/lib/settings.ts:1138`).

**When it parks.** At the cycle boundary, and never mid-cycle. The loop reads the
record, not the reply (`src/lib/orchestrator.ts:13644`-`:13652`), below the
machine rungs and above `cycleEnding`. A model that calls the tool and carries on
still parks; one that only says it needs a tool does not
(`docs/agent/run-lifecycle/waiting-for-stack.md:9`).

**What it refunds, and the bound.**

- `parkForStack` gives back the asking cycle:
  `if (!refunded && stackWaits < MAX_STACK_WAITS_PER_RUN) iterations -= 1`
  (`src/lib/orchestrator.ts:11821`-`:11836`). Spend is not refunded.
- `MAX_STACK_WAITS_PER_RUN` = 3 (`src/lib/stackRequests.ts:83`). It is counted
  on the row and never reset by `reopenRun`. The tool refuses to file at the
  bound (`src/lib/stackRequests.ts:439`-`:528`).
- The wait opens `paused_at` and the claim closes it into `paused_ms`, so
  waiting is never worked minutes
  (`docs/agent/budgets-and-guards/termini-and-waiting.md:11`).

**Claim and restart.**

- The folder is **yielded**: `walkQueue` reserves only `running` runs
  (`src/lib/orchestrator.ts:5417`-`:5419`).
- The worktree slot is **kept**: the row stays in `activeRuns()`
  (`src/lib/orchestrator.ts:4411`).
- `reconcileOnBoot` keeps the row whatever its age
  (`src/lib/orchestrator.ts:16941`-`:16950`).

**Who answers, and how the answer travels.**

- The operator answers by installing and restarting, or by pressing Decline.
  There is no free-text answer.
- `releaseStackWaits` flips the row to `queued` with
  `follow_up = stackResumeNotice(…)` and `follow_up_is_note=0`, at most
  `MAX_RESUMES_PER_SWEEP` = 4 at a time, always through `promoteQueued`
  (`src/lib/orchestrator.ts:15384`-`:15430`).
- `NOTIFY_PARKS` sends `run.waiting_for_stack` (`src/lib/notify.ts:126`). The
  release sends nothing.

**Which decisions carry over to a general question, and which were about stacks.**

| Carries over unchanged | Specific to stacks |
|---|---|
| A tool that records and returns at once, and tells the agent to end the cycle | The answer is machine-checkable: `stackSatisfaction` against receipts, so the tool can refuse a question already answered |
| The park is read off the record at the boundary, below the machine and above the task, clearing `reported_done` | The only yes is a container restart, which is why the boot is the release and why the row is kept whatever its age |
| A refund of the asking cycle, bounded by a never-reset counter on the row, and a refusal at the bound | Many runs attach to one request by name, and one install answers all of them |
| `paused_at`/`paused_ms`/`pause_count`, folder yielded, slot kept, in `activeRuns` and `LIVE_STATUSES` | Decline-by-name: a declined stack cannot be asked again by that run |
| The answer travels in `follow_up` at the flip to `queued`, through `promoteQueued`, at most four per tick | A per-cycle tool grant read from receipts (`stackGrants`, per `docs/agent/run-lifecycle/waiting-for-stack.md:19`; not re-read in code here) |
| One notification per park; `stopRun` and every non-park ending release the attachment | |

**The decision that matters most for this survey** is the one the doc states in a
sentence: "Every wait needs a person's answer, which bounds it in practice too,
but a terminus that rests on a person doing something is not one"
(`docs/agent/run-lifecycle/waiting-for-stack.md:11`). The cycle refund is
bounded by a count, not by the person. Any general ask-and-park inherits that
count.

## 3. The chat's `ask_operator`: the same problem one level up, built and nearly unused

**What it is.** It is a chat-only tool (`src/app/api/mcp/route.ts:1269`-`:1342`),
refused to a workflow block because "there is nobody watching this workflow to
answer" (`src/app/api/mcp/route.ts:2110`-`:2115`), and absent from `RUN_TOOLS`.

- It records up to five open questions per thread, with eight choices each,
  2,000 characters a question and 150 a choice
  (`src/lib/chat.ts:454`, `:463`, `:477`, `:491`). The rows go in
  `chat_questions` (`src/lib/db.ts:806`-`:836`).
- It returns at once: "Your turn ends here. Nothing returns their answer to you"
  (`src/app/api/mcp/route.ts:5255`-`:5262`).
- The answer is the next chat turn. `answerMessage` quotes each question above
  its answer (`src/lib/chat.ts:1011`-`:1017`), because a fresh process "has the
  thread but not the tool call" (`docs/agent/chat/operator-questions.md:7`).
- It sends **no notification**: nothing in `src/lib/chat.ts` imports `notify.ts`.

**Why it ends the turn rather than waiting.** `CHAT_IDLE_TIMEOUT_MS` is fifteen
minutes of silence (`src/lib/chat.ts:556`), and "a tool call that blocked on a
click is precisely the shape that gets killed"
(`docs/agent/chat/operator-questions.md:7`). A run's equivalent bound is
`maxCycleSilenceMinutes`, which is 120 by default and floored at 5
(`src/lib/settings.ts:1144`, `src/lib/orchestrator.ts:1016`-`:1042`). §7
measures what actually ends a long call first.

**What happened to it.** *UsageFoundry Orchestrator Chat Quality Proposal*
(vault, `confidence: medium`, `status: archived`) found "3 `ask_operator` calls
in 152 operator turns, each prompted by the operator". The tool's description
was fetched in 3 of 98 conversations, because a deferred tool's description is
read only after the model has already chosen the tool. *UsageFoundry Operator
Questions Proposal* (`confidence: low`, `status: archived`) records the
inference: "The survey guarded against interrogation and got near-silence." The
chat's prompt now names the tool (`src/lib/chat.ts:4309`-`:4313`). This corpus's
own recount is in [`00-problem.md`](00-problem.md) §3.

**What it predicts for runs.**

1. **A run tool is deferred too.** This survey's own cycle was offered all eight
   run tools as deferred (each needed a `ToolSearch` before it could be called).
   A new run tool that is not named in the run's prompt will be found about as
   often as `ask_operator` was: when the task is about it.
2. **Runs already have the prompt-level version.** `NEEDS_REVIEW_NOTICE` names
   the ending on every resumed turn, which `ask_operator` lacked for three weeks.
   So `needs-review` endings, not tool calls, are the measure of how often a run
   reaches for a person ([`00-problem.md`](00-problem.md)).
3. **The design that worked was the ending, not the wait.** Every rule in
   `docs/agent/chat/operator-questions.md` exists because nothing can wait for a person.

## 4. The taskboard: a run can leave a note, and nothing reads it back while the run is live

Under `taskboardForRuns`, a run has eight tools (`RUN_TOOLS`,
`src/app/api/mcp/route.ts:642`-`:961`).

- **`comment_on_task`** writes one append-only `task_comments` row on a task the
  run holds or one open in its folder (`src/lib/tasks.ts:1797`-`:1816`), up to
  10,000 characters (`src/lib/taskComments.ts:121`). It notifies nobody.
- **`create_task`** files an `open` task and "Nothing is running for it and
  nothing will until somebody starts it"
  (`src/app/api/mcp/route.ts:5128`-`:5130`).
- **`release_task`** puts a held task back to `open` with the reason as a note,
  optionally marking it `operatorOnly` (`src/lib/taskRelease.ts:110`-`:162`).
  A run may never clear that mark, and may never claim an `operatorOnly` task
  (`src/lib/tasks.ts:369`-`:375`).

**Who reads a note while the run is live.**

- The operator, on the task page, and on the run page's `RunTaskComments`, which
  polls every 10 seconds and shows the newest three
  (`src/app/api/runs/[id]/task-comments/route.ts:51`). That component counts the
  run's own notes rather than drawing them
  (`docs/agent/taskboard/run-page-notes.md:7`-`:26`).
- The run itself, when it asks: `list_my_tasks` returns the last ten notes on
  each held task (`src/lib/taskComments.ts:153`).

So **the board is already a pull channel downward**. An operator who writes on
the held task reaches the run at its next `list_my_tasks`. Nothing on it is a
channel upward that anyone is waiting on: a run's note sits on a page until a
person happens to open it. And nothing tells the run to look again, which is
correct for the rule that comments "reach a run through a tool call and never
through the appended system prompt"
(`docs/agent/taskboard/comments.md:63`-`:69`).

## 5. The outbound webhook: how an absent person is reached today

`src/lib/notify.ts` POSTs a signed body of six fields (`install`, `event`,
`run_id`, `status`, `at`, `url`) with a five-second timeout and no retry
(`src/lib/notify.ts:67`-`:79`, `:320`).

- It fires on `needs-review`, `blocked` and `failed`; on `waiting-for-stack`; on
  a guard's stop; on the first rung of a rate-limit ladder; and on a held
  workflow gate (`src/lib/notify.ts:108`-`:126`, `:243`-`:295`, `:512`-`:535`).
- It never carries the title, task, reason or diff, because those are
  model-writable text (`src/lib/notify.ts:58`-`:65`).
- It is configured by `UF_WEBHOOK_URL` and `UF_WEBHOOK_SECRET` alone
  (`src/lib/config.ts:583`, `:603`).
- Every attempt is recorded in `webhook_deliveries`, and `webhookHealth()`
  reports failures since the last success (`src/lib/notify.ts:560`-`:578`).

**A question channel inherits this unchanged.** A notify-worthy question is one
more member of `NOTIFY_PARKS`. The body stays content-free: the question is
model-written text, and a payload that carried it would be the one way this app
sends a model's words off the machine unread. The *UsageFoundry Unattended
Operation Proposal* (vault, `confidence: low`, `status: archived`) recorded the
operator's yes to a receiver, and the shipped record's "never on `completed`"
rule (`SHIPPED-UnattendedOperation.md`). Whether the operator's receiver is
still live is not readable from here; `/api/status` reports it.

## 6. Provenance: "the session that spawned it" is a real answer only for a chat proposal

`runs.origin` and `runs.origin_ref` (`src/lib/db.ts:1836`-`:1837`) are written
once by `createRun`. They are not foreign keys and do not cascade
(`src/lib/db.ts:1818`-`:1835`).

| `origin` | `origin_ref` | Can the spawner be reached? |
|---|---|---|
| `form` | null, or `dreaming:<night>` | No spawner but the operator |
| `chat` | the **proposal** id (`src/lib/chat.ts:2067`-`:2068`) | **Yes, in data.** `chat_proposals.chat_id` → `chat_sessions.session_id`, and every chat turn is `--resume`d on that id (`src/lib/chat.ts:3289`). Chat transcripts are kept for as long as the chat row exists (`src/lib/retention.ts:764`-`:768`). No code path deletes a chat (grep finds no `DELETE FROM chat_sessions` outside tests and no DELETE route; that absence is all this rests on). No code walks from a run to its chat today. |
| `workflow`, `schedule` | the instance or schedule id | The instance's runs and blocks, until the workflow is deleted. `deleteWorkflow` cascades instances (`src/lib/workflows.ts:2622`-`:2625`), and the run's ref then dangles; the page falls back to the bare word (`src/app/runs/[id]/page.tsx:1526`-`:1537`). |
| `orchestrator-block` | the block's **node** id (`src/lib/workflows.ts:10149`-`:10150`) | **No.** A block is one headless turn that has ended before its runs exist: emitted specs become runs in `settleBlock`, after the turn's status UPDATE (`src/lib/workflows.ts:8648`-`:8695`). Its session id is stored (`src/lib/workflows.ts:8666`), nothing resumes it, and block transcripts are not in retention's keep set (`src/lib/retention.ts:748`-`:805`). |

**The spawner is never live while its run works.**

- A chat turn ends when it proposes. Approval is a separate press.
- A block's turn ends before its runs are created.
- A run started from the form has no model behind it.

So "talk to the session that spawned it" means **resuming** a conversation, which
is a new billed turn of the most privileged child in the app
([`01-constraints.md`](01-constraints.md) C9). It never means reaching a session
that is waiting.

## 7. What a live cycle can receive at all

**From the app: nothing but the answer to a call the cycle made.**

- The child is spawned with `stdio: ["ignore", "pipe", "pipe"]`
  (`src/lib/orchestrator.ts:8527`), and the prompt is the last argv element,
  `-p … -- <prompt>` (`src/lib/cycleInvocation.ts:1599`-`:1605`, `:1150`-`:1152`).
  No `--input-format` is passed.
- The MCP route answers plain JSON, not SSE (`src/app/api/mcp/route.ts:227`-`:228`),
  and `GET` is a 405 "No server stream" (`src/app/api/mcp/route.ts:2295`-`:2300`).
- `follow_up` is read once per segment (`src/lib/orchestrator.ts:11668`). The
  validator's `pendingPushback` is a local in `startRun`'s frame and is lost on
  restart (`src/lib/orchestrator.ts:11680`).
- `interruptRun` only signals: SIGINT, SIGTERM at 3 s, SIGKILL at 8 s
  (`src/lib/orchestrator.ts:14103`-`:14109`).

**What bounds a cycle that is waiting inside a tool call.**

- **The silence watchdog.** Any stdout or stderr chunk re-arms it
  (`src/lib/orchestrator.ts:8574`-`:8590`). When it fires, the run ends
  `failed` with ending code `deadline` (`src/lib/orchestrator.ts:8737`-`:8746`,
  `:879`, `:892`-`:893`).
  "The CLI heartbeats a tool call on the main thread every 30 seconds"
  (`src/lib/orchestrator.ts:1048`-`:1049`), measured for `Bash`.
- **The live guards.** Under the default `between-cycles` enforcement they are
  not registered (`src/lib/orchestrator.ts:12831`-`:12864`,
  `src/lib/settings.ts:1083`). Mid-cycle, only `--max-budget-usd`, the watchdog
  and the context ceiling bind.
- **Worked minutes keep accruing** through a long call, because only a park
  writes `paused_at`.

**From the CLI: the two facts that decide the transports.** Measured with the
pinned CLI 2.1.310 (`Dockerfile:453`) against a loopback stub, nothing billed,
with the scripts in [`scripts/`](scripts/):

**Fact 1: an MCP tool call can wait minutes, but not through the app's route as
it is configured today.** The probe's MCP server matches the app's: `type:"http"`,
a bearer header, `GET` answered 405 (`src/lib/chat.ts:4880`-`:4897`). The
runner is `scripts/mcp-wait-probe.sh <label> <mode> <delaySec>`.

| How the server answers | Default pinned CLI |
|---|---|
| Plain JSON held open, which is what `/api/mcp` does | **Fails at 60.0 s** for every delay tried (60, 75, 90, 180, 360, 540 s). The model gets `The operation timed out.` as an error tool result |
| SSE opened at once, then silent | OK at 180 s. Fails at 300 s: `MCP server "sup" tool "ask_supervisor" sent no response or progress for 300s; aborting` |
| SSE with `: keepalive` comments every 30 s | Fails at 300 s, so comments are not activity |
| SSE with `notifications/progress` every 30 s | OK at 360 s and at 540 s |
| Plain JSON, with `"timeout": 120000` in the server's `--mcp-config` entry | OK at 90 s |
| Plain JSON, with `"timeout": 900000` | OK at 540 s |

- **The binary agrees.** A per-request HTTP timer of 60,000 ms is cleared once
  response headers arrive, which is why JSON dies at 60 s and SSE does not. There
  is an HTTP idle limit of 300,000 ms (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`). The
  per-server `timeout` is a "Hard wall-clock limit per call; progress
  notifications do not extend it", and it raises both of the other limits.
- **The CLI keeps the watchdog fed.** It writes a `tool_progress` frame with
  `"heartbeat":true` to stdout every 30 s while an MCP call is pending: 17 of them
  over a 540 s wait. So the silence watchdog never fires on a waiting call. Its
  default is 120 minutes anyway.
- **So:** a blocking call through today's route must answer in **under 60 s**. One
  line in `writeMcpConfig`, a `timeout` on the run's server entry, lets it wait
  as long as that value. Nothing the app writes today sets one; `grep -rn
  "MCP_TOOL_TIMEOUT\|CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT" src/` finds nothing.
- **Codex (0.153.4)** waits **300 s** wall clock by default and is silent on
  stdout meanwhile. `timed out awaiting tools/call after 300s` at a 400 s delay;
  90, 150 and 270 s succeeded. `tool_timeout_sec` moves it (120 failed at 120;
  900 let 330 through), and progress does not extend it.
  `scripts/codex-mcp-timeout-probe.sh` re-runs this.

**Fact 2: `--input-format stream-json` delivers a message into a live turn, but
only at the next model request, and it changes what a cycle is.** The runner is
`scripts/live-turn-probe.sh <case>`, with 13 cases.

- **Folded, not interrupting.** A second message written while a tool was
  pending reached the model only when that tool returned. It arrived inside the
  same turn as a `role:"system"` block: "The user sent a new message while you
  were working: … Address the message above as you continue this turn." It
  **cannot release a pending tool call**. With no tool pending (`midstream`), it
  ran as a **separate turn** after the first `result`.
- **Metering changes.** Each `result` reports its own `usage` but a
  **cumulative** `total_cost_usd`: 0.01042 then 0.01626 in one process. A
  resumed process carries the earlier process's cost forward too. Summing
  `result` costs per process would double-count.
- **Lifetime changes.** After a `result`, with stdin open, the process stays
  alive (observed for 20 s). EOF ends it, exit 0, within 0.1 s. The positional
  `-p` prompt is **ignored** under this input format, so the first message has to
  go on stdin too. `--max-turns` counts per message. `--max-budget-usd` is per
  process and checked after a request, so it can overshoot by one request.
- **Logging changes.** Without `--replay-user-messages`, no injected text appears
  on stdout at all. With it, a `{"type":"user",…,"isReplay":true}` frame is
  emitted at fold time.
- `--resume` combines with it and keeps the session id.

**Codex mid-run input is not established.** `codex exec --help` has no input
format, and `codex queue --thread <id> --message <text>` exists. Whether a queued
message reaches an `exec` turn would be settled by running `codex exec --json`
against `scripts/codex-stub-responses.mjs` with a slow tool, then `codex queue`
on its `thread.started` id from the same Bash call, and checking the next
`/v1/responses` body.

**What the two facts decide.**

- A **blocking tool call** is a real transport for a model's answer, under 60 s
  today and longer with one config field.
- It is **not** a transport for a person's answer. The person may take hours, and
  the cycle would be held live, worked and paid for the whole time.
- **Live-turn delivery** is possible but cannot carry an answer to a question the
  run is blocked on: the message lands only after the blocked call returns. Using
  it at all means piping stdin, moving the prompt off the argv, closing stdin to
  end a cycle, de-cumulating cost, and passing `--replay-user-messages`. That is a
  new cycle model, weighed as [G](09-option-g-live-turn.md).
- Each case above was run once. The JSON 60 s limit, the `timeout` field at 90 s,
  and the live fold were re-run for this file and agreed.

## 8. What this inventory says

| | Carries | Answer lands | Run's place while waiting | Cycle refund | Survives restart | Notifies | Who answers |
|---|---|---|---|---|---|---|---|
| `NEEDS_REVIEW` | free text up | next segment, `follow_up` | **lost** (folder, maybe slot) | **no**; the cap must be raised | yes, terminal | yes | operator |
| `request_stack` | a stack name up | next segment, `follow_up` | folder yielded, slot kept | yes, ≤ 3 | yes, any age | yes | operator, by restart |
| chat `ask_operator` | structured question up | next chat turn | n/a | n/a | yes | **no** | operator |
| board note | free text, either way | when somebody pulls | n/a | n/a | yes | no | anyone who looks |
| webhook | six fields, out | n/a | n/a | n/a | delivery log | is the notification | — |
| `origin_ref` | provenance | n/a | n/a | n/a | yes | no | a chat could be resumed; a block cannot |

**Nothing today answers a run while it works**, and nothing lets a run ask a
question without either ending or claiming a stack. The stack park is a
complete, tested, notified, restart-safe ask-and-park whose only defect for
general use is that its answer is a restart rather than a sentence.
