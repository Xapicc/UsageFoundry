# QoL hunt 2/5: the orchestrator chat, proposals, the taskboard, MCP

At `fee5efb`. In progress: `docs/agent/chat.md`, `docs/agent/taskboard.md` and
the overlapping proposals (`ChatPanelExperience`, and the `ProposalBoundary` and
`OrchestratorChatQuality` rows of `proposals/README.md`, whose directories are
not in this tree) have been read; the hunt itself is under way.

## Items

### C-1 A decided card says what the run it started did
- **Friction**: after every approval the operator comes back to learn whether the work happened, and the chat page cannot tell them. A decided row draws the proposal's own badge (`approved`) and a link to the run, and nothing else (`src/app/chat/page.tsx:2651-2676`); `ChatProposalDTO` carries `runId` and no field about the run (`src/app/api/chat/dto.ts:275`). `docs/agent/chat.md:33` is explicit that "`approved` only says a person agreed". Finding which of ten approvals failed, stopped on a budget or is waiting for review means opening ten links. The model is already told more than the operator: `list_past_proposals` returns `run.status`, `reportedDone`, `stopReason` and spend for every approved card (`src/app/api/mcp/route.ts:2807-2833`).
- **Change**: in `proposalDTOs` (`src/app/api/chat/dto.ts`), one batched `SELECT id, status, reported_done FROM runs WHERE id IN (…)` over the decided run proposals of the thread, and a `run: { status, reportedDone } | { gone: true } | null` on each. The `Decided` row draws `StatusMark` (`src/components/StatusMark.tsx`) and the run's status word beside the proposal badge. `list_past_proposals`' projection at `route.ts:2807-2833` is the shape to copy, and `getRun` is the per-row read it already uses (one query per page is the better shape here, since this DTO is re-read on every poll).
- **Size**: S.
- **Touches**: `chat.md:71` — proposals are re-read whole on every poll on purpose, so the join has to be one query, not one per row. The proposal status and the run status stay two marks: `PROPOSAL_TONE.failed` (`page.tsx:130`) means *failed to start*, which is a different fact from a run that failed, and merging them would misreport both. `conventions.md`'s status-tone rule applies to the new mark exactly as it does on `/runs`.
- **Value**: high — "did the work happen" is the question after every approval, and the answer is one join away.
- **Not worth it if**: the operator never checks results from the chat and always goes to `/runs`.

### C-2 Say on the chat page that another thread is waiting on the operator
- **Friction**: the page opens on the most recently updated thread (`src/app/api/chat/route.ts:39`, `latestChat`), and its `N waiting` badge counts that thread alone (`src/app/chat/page.tsx:907-909`). A question asked or a proposal written in thread B while the operator is reading thread A is shown only as row text inside the Chats tab (`page.tsx:2775-2784`), and that list is the newest 30 (`chat.md:69`) with no way to narrow it to threads that are waiting. Nothing outside the chat page reads pending proposals or questions at all (only `dto.ts`, the proposals route and the MCP route mention them).
- **Change**: two parts, each useful alone. (a) A `waiting` flag on `findChats` (an `EXISTS` over `chat_proposals.status='pending'` or `chat_questions.status='pending'`), passed through `GET /api/chat`'s search branch (`route.ts:24`, which already refuses to create a thread when any search parameter is present), and a kit toggle *Waiting on you* in the Chats tab that feeds the existing search result path. (b) A count of *other* threads waiting, computed with the same predicate as a `COUNT`, on the bare `GET /api/chat` and `GET /api/chat/[id]` payloads, drawn beside the tab strip as a button that opens the Chats tab with the toggle on.
- **Size**: M.
- **Touches**: `chat.md:65` — `pendingCount` and `pendingQuestionCount` are kept apart on purpose ("two badges that looked alike would send the reader to the wrong half of the page"); the count in (b) must say proposals and questions separately. `chat.md:69` — the filter has to live on the search branch, never on the bare poll, or it would create a thread. `conventions.md` allows one `SegmentedControl` strip per page, so the filter is a toggle, not a second strip.
- **Value**: high — approving and answering are this page's two daily moves, and today both depend on the operator landing in the right thread by luck.
- **Not worth it if**: the operator works in one thread at a time and never has two waiting.

### C-3 Reject with a reason the chat can read
- **Friction**: `rejectProposal` records a status and a time and nothing else (`src/lib/chat.ts:2059-2066`), and the thread gets *Rejected N proposal(s).* So the operator who rejects because the folder is wrong ticks, presses Reject, then types the card's title into the composer to explain — and the explanation is in one thread only. `list_past_proposals` exists so the model does not re-propose work the operator refused (`chat.md:33`), and it reports every rejection "as having no reason because `rejectProposal` records none" — the model can learn *that*, never *why*, and proposes the same card with the same wrong folder in the next conversation.
- **Change**: an optional `reason` beside `action: "reject"` on `POST /api/chat/[id]/proposals` (the action set stays two), a `chat_proposals.decision_note` column added idempotently in `migrate()`, written by the same conditional `UPDATE … WHERE status='pending'`, echoed in the thread's decision message and in `list_proposals` / `list_past_proposals` (which already have an `error` field beside it that rejections leave null, `route.ts:2820`). In the panel, one optional `Input` beside Reject, cleared with the selection. A cheaper S version stores nothing: after a successful reject, seed the composer with `Rejected "<title>": ` using the mechanism *Send it again* already uses (`page.tsx:1292-1295`), which gets the reason to this thread's model but not to a later conversation.
- **Size**: M (S for the composer-only version).
- **Touches**: `chat.md:33`'s sentence about rejections having no reason becomes false and has to be rewritten. The reason is operator text reaching a model — it is prompt-side, never a guard, and `list_past_proposals` should clip it as it clips `task` (`route.ts:2819`). Proposals whose `status` is `superseded` are unaffected.
- **Value**: medium — it stops the same rejected work coming back across threads, which is a billed turn each time.
- **Not worth it if**: the operator already explains every rejection in the next message and never starts a fresh thread about the same work.

### C-4 The browser tab says when a turn has landed or a question is waiting
- **Friction**: a turn has no duration bound, only a fifteen-minute *silence* bound (`chat.md:51`), so a turn that reads four repositories is minutes of waiting, and the operator waits in another tab. Nothing in `src/` sets `document.title` (`grep -rn document.title src` is empty); `layout.tsx:26-32` declares a `"%s · UsageFoundry"` template that no page uses, since every page here is a client component. The chat page keeps polling in a background tab (`page.tsx:603-607`), so it already knows the moment `thinking` flips — it tells nobody who is not looking.
- **Change**: one effect in the chat page setting `document.title` from state it already holds: `Thinking · Orchestrator` while `chat.status === "thinking"`; `Answered · Orchestrator` when a turn settled while `document.hidden`, until `visibilitychange` says the tab is visible; `Asked you · Orchestrator` while a question is open; plain `Orchestrator` otherwise — each through the layout's template string, restored on unmount.
- **Size**: S.
- **Touches**: `chat.md:65` — a waiting proposal and an open question are never summed, so the title names one or the other, questions first. No blinking or alternating title (`conventions.md`'s motion rule). It would be the first page to set a title, so it sets the pattern the other pages would follow; restoring on unmount matters because a client navigation does not reset `<title>` (assumed from how Next applies static metadata; not measured).
- **Value**: medium — the page's longest wait gets a signal wherever the operator is working.
- **Not worth it if**: the operator keeps the chat in the foreground during turns.

### C-5 Keep the composer's draft per thread, and do not overwrite it
- **Friction**: `draft` is one piece of state for the whole page (`src/app/chat/page.tsx:336`). Opening another thread (`page.tsx:1655-1667`) and New chat (`page.tsx:847-871`) both leave it alone, and nothing persists it, so a half-written message is lost on reload and a message typed for thread A sits in the composer when B is opened — Enter then sends it to B. *Send it again* replaces whatever is in the composer without asking (`page.tsx:1292-1295`). The question-card half of this is `ChatPanelExperience` C7 (question drafts are card-local, `page.tsx:2004`), still present at HEAD; this item is the composer half, which that proposal did not name.
- **Change**: hold drafts in `sessionStorage` keyed by chat id, swap on thread change, clear on a successful send (the draft already clears only on success, `page.tsx:753-757`); *Send it again* appends below a non-empty draft rather than replacing it. Question drafts can ride the same map keyed by question id, which closes the rest of C7.
- **Size**: S.
- **Touches**: nothing in `docs/agent/`; `conventions.md`'s rule that a `"use client"` file imports no server module is untouched.
- **Value**: medium — it removes a lost-text failure and a send to the wrong thread.
- **Not worth it if**: threads are rarely switched mid-draft.

### C-6 A proposal card's task links to the task, and its template to the template
- **Friction**: a card *for* a board task names it as a plain span (`src/app/chat/page.tsx:2339-2355`), so an operator deciding whether to approve a run for a task cannot open that task's brief or thread from the card — it is a trip to the board and a scan. The run page links the same tasks (`src/app/runs/[id]/page.tsx:1344-1345`), and `taskboard.md:806` only says the *deleted* case must not link. Inside the guard fold, the template's name links to a bare `/runs/new` (`page.tsx:2460`), which opens an empty form: the run form reads only `?from=` (`src/app/runs/new/page.tsx:607`), so the link never shows the template it names.
- **Change**: wrap the task phrase in `<Link href={`/tasks/${task.id}`}>` when `task.title` is non-null (the deleted case stays unlinked, as it is on the run page). For the template, either teach the run form a `?template=<id>` preselect beside `?from=` or drop the link rather than keep one that lands nowhere.
- **Size**: S.
- **Touches**: `chat.md:13` — a task decides nothing about the run, so the phrase stays untoned and outside the guard mark. The link sits inside the card's `<label>`; a click on interactive content inside a label does not toggle its checkbox, which is the reasoning the fold already relies on (`page.tsx:2441-2444`). The `?template=` half touches `src/app/runs/new/page.tsx`, outside this territory.
- **Value**: medium — one click instead of a hop to the board and a search, at the moment of approving.
- **Not worth it if**: proposal cards rarely name tasks.

### C-7 Name the open thread on the page, from its first message
- **Friction**: nothing draws the open thread's title — the heading is *Orchestrator* (`src/app/chat/page.tsx:1039`) and the title appears only as a row in the Chats tab (`page.tsx:2755-2762`). With the Proposals tab showing, which is the default, and after opening a thread from search, the operator cannot see which conversation they are in. The title is written only by `finishTurn` (`src/lib/chat.ts:3707-3717`), so every thread reads *Untitled* for the whole of its first turn — the minutes when the operator is most likely to switch away and come back.
- **Change**: write the title in `sendChatMessage` when the row has none (the same clipped first message `finishTurn` writes now, so nothing about the wording changes), and draw it in the header row beside the cost figure (`page.tsx:1065-1087`). A rename (`PATCH /api/chat/[id]` with a title of 1–80 characters, wrapped in `auditMutation`) is the M extension, and it also improves search, which matches titles (`chat.md:69`).
- **Size**: S (M with rename).
- **Touches**: the comment at `page.tsx:1040-1057` about that header row's height at `lg`. `chat.md:69` says the title "is written by the model from the opening line"; the code writes the operator's own first line (`chat.ts:3715`), so that sentence is already drift — see "Seen outside my territory".
- **Value**: medium — orientation on the page and a list whose rows can be told apart during a first turn.
- **Not worth it if**: the operator keeps few, distinct threads.

## Too big for this list

## Bugs filed

- A resumed chat turn's cumulative total_cost_usd is banked as that turn's cost — high — `d2782026-77dc-4893-8198-8aae0d7b4cfb`
- Chat stream counts one response's usage once per content block, inflating the live guard estimate — high — `11cf59df-b4ad-479b-99af-3a817ce9cd28`
- list_tasks narrowed by mountId+folder always returns zero: relative folder compared to stored absolute path — high — `9c4cbf8a-443d-4d8c-82d7-dafdcd6fabc5`
- Validation boundary reads the run's newest verdict, so a not-finished task is ignored once another task is checked — high — `d82e9d21-50e6-456c-8878-c655c19c523f`
- Chat turn capability stays live after Stop and after a spawn that throws — normal — `b8305935-b642-4681-91ba-7f1cc3eb6915`
- A dependsOn that is not an array is read as "no dependency" by propose_run, propose_workflow and emit_runs — normal — `a680431f-1cf0-4eb4-921d-a06b0561bcfd`
- propose_run reads an omitted folder as the mount root, and drops a folder sent without mountId — normal — `95dbb1ee-439b-498d-b3a7-7fbbc7391089`
- A server restart during a completion check leaves the task claimed for good — normal — `382b15b1-a454-4c22-9b4e-e996b7843156`
- Validator's verdict parser drops an unfenced verdict whenever the reply quotes any fenced JSON — normal — `d5e28b71-e37c-4b9d-b596-783e2604829b`
- Task editor draws "not in the workspace scan" while /api/folders is loading or after it failed — normal — `94ea8ea8-f273-44eb-a6c1-70d98985925a`
- A task write that changes nothing still bumps updated_at, reordering the board on every run pick-up — low — `dc9b8f02-3658-4c2f-a0b3-690bdb3bee2f`
- A JSON null body crashes the chat, task-dependency and MCP routes with a 500 — low — `441c43b5-d962-4990-a70c-9e6105f2f183`
- A validation records the run's branch name as head_sha, so the verdict names no commit — low — `27ad4238-d6b7-4975-bb51-d5f66c837e29`

That is **thirteen, one over the brief's cap of twelve** — a counting mistake made while filing, not a judgement that the thirteenth outranks anything below. Nothing this run holds can drop a task, so it stands; if one has to go, it is the last line above, the least consequential of the thirteen.

The first four and the capability task were confirmed by scratch tests the hunt ran against the real modules (DB-backed, with a faked child where a spawn was involved), plus, for the first, a read of the pinned 2.1.280 binary (`function nte(e){let n=e.costState;…`, `total_cost_usd:em()`, `function em(){return n().costLedger.totalCostUSD()}`) and of this host's own `cost-state` transcript records. No real `claude` was spawned: whether a real resumed chat turn's result carries the restored total end to end is the one link not measured, and the task says so.

## Bugs not filed

Confirmed, and below the thirteen above on severity. Each says how it was established.

- **Duplicate ids in one approval mark a saved workflow proposal `failed`.** `src/app/api/chat/[id]/proposals/route.ts:75,81` never deduplicates `ids`, and `approveWorkflowProposal` (`src/lib/workflows.ts:388`) and `approveScheduleProposal` (`src/lib/schedules.ts:1149`) do not check that the proposal is still pending. Executed: `ids: [p, p]` saved the workflow once, then left the row `failed` with `workflow_id` null and the thread saying both "Saved 1 workflow(s)" and "Could not save…". The page sends a `Set`, so only a direct API call reaches it. Low.
- **`complete_task` on a task that is already done answers "recorded as completed by this run".** `closeNow` (`src/lib/validation.ts:613-624`) returns `closed` for done → done, which is a no-move any actor may make, and `src/app/api/mcp/route.ts:3581` then asserts completion by this run. Executed: a run that never held the task was told it completed it. Low.
- **`list_my_tasks`' `held` half is capped at `MAX_RUN_TASKS` with no count beside it** (`src/lib/tasks.ts:1193-1202`), where `taskboard.md` says both halves carry one. Reachable only if the operator claims more than 20 tasks for one run. Read from source. Low.
- **A work cycle's `create_task` drops a mistyped `parentTaskId` in silence** (`route.ts:3622`). The documented drop is for a *deleted* inherited parent; a named id that never existed becomes null with nothing in the reply. Executed. Low.
- **The dependency graph says "the graph is missing nodes" for a task waiting on a popular blocker** (`src/lib/taskDepGraph.ts:161-163` compares the inward side of each neighbour, which the graph never draws). Executed: nodes `[anchor, blocker]`, one edge, `clipped: true`. Low.
- **`GET /api/chat?offset=1e20` (or `Infinity`) is a 500** — `Math.trunc(Infinity) || 0` stays `Infinity` into SQLite's `OFFSET` (`src/lib/chat.ts:557`). Executed. Low.
- **The chat page carries one thread's state into the next.** `sendError` is cleared neither by opening another thread (`src/app/chat/page.tsx:1655-1667`) nor by New chat (`page.tsx:847-871`), and New chat does not clear `answerError` although the thread-switch comment beside it argues it must. And `load` applies answers in arrival order (`page.tsx:451-469`): a whole-thread answer for thread A that lands after the operator opened B replaces B on screen. Read from source. Low.
- **The board's project select reads "Every project" while a filter is still applied**, once the narrowed project's option has disappeared from the rows (`src/app/tasks/page.tsx:376-383`, `:733-751`); re-picking "Every project" fires no change. The empty card's own button recovers. Read from source. Low.
- **A success notice outlives a later refusal** on the board, the task page and the editor (`tasks/page.tsx:415-431`, `tasks/[id]/page.tsx:142-159`, `TaskEditor.tsx:134-137` clear `actionError` but never `note`), so "“X” is now done" and a refusal are drawn together. Read from source. Low.

## Seen outside my territory
