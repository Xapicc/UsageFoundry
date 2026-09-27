# QoL hunt 2/5: the orchestrator chat, proposals, the taskboard, MCP

At `fee5efb`. Read in full: `CLAUDE.md`, `docs/agent/chat.md`, `docs/agent/taskboard.md`, and
`ChatPanelExperience/00-problem.md` (its findings are cited by id where an item
here touches one). `ProposalBoundary` and `OrchestratorChatQuality` were read
only through their rows in `proposals/README.md`, because neither directory is
in this tree. Five read-only passes went over the territory: the chat's server
half (`chat.ts`, `chatStream.ts`, `chatThread.ts`, `proposalContinuation.ts`,
`src/app/api/chat/**`), the board's server half (`tasks.ts`, `taskComments.ts`,
`taskDeps.ts`, `taskDepGraph.ts`, `validation.ts`, `src/app/api/tasks/**`), every
tool on the MCP route's three subjects, the chat page, and the board's three
pages with their components. Bugs were confirmed with scratch `node --test`
files against the real modules and route handlers, using temp `DATA_DIR`s and
a faked child where a spawn was involved, all deleted before committing. Where a
claim was only read, it says "read from source". `npm run typecheck` and
`npm test` were not run as a gate, because nothing under `src/` changed. No
browser was opened and no `claude` was spawned, so every UI claim is read from
the component source. Not covered: `Markdown.tsx` was read only as the chat page
uses it, `mcpStatus.ts` and `chatRequest.ts` got only the MCP pass's attention,
and there was no pass for accessibility or narrow viewports. Those two have
their own proposals (`OperatorInterface`, `UIChecks`).

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

### C-8 Say whether the run holding a claim is still alive
- **Friction**: the no-lease decision rests on one lever. `docs/agent/taskboard.md:41-44` says a stale claim is "the operator's to release — `claimed → open` — which is a press on a board they are already reading, against a run whose status they can see on the same screen", and `:44` says "The lever that exists is visibility, not expiry". But the board draws the holder as a bare short id (`RunLink`, `src/app/tasks/page.tsx:214-223`, used at `:248-249` and `:560-561`), and so does the task page (`src/app/tasks/[id]/page.tsx:326-328`). The status is not on the screen. Every Claimed row costs a click-through to `/runs/<id>` before Release can be pressed safely.
- **Change**: pass the holder's run status into `taskDTO` beside `claimedByRunId`, from one query per page in the list route and in `GET /api/tasks/[id]`. That is `runLinksForTasks`' existing join onto `runs` (`src/lib/tasks.ts:1523-1546`), and like the comment and dependency counts it is handed to `taskDTO` rather than read inside it (`taskboard.md:239-247`). Draw it as a `Badge` in `STATUS_TONE` (`src/lib/format.ts`) after *Held by*. The task page's *Filed by / Closed by / Started for it* lines (`[id]/page.tsx:323-340`) can take the same status from the same query.
- **Size**: S (board), M with the task page's run lines.
- **Touches**: `taskboard.md:29-47` — no clock and no expiry; this draws a status and decides nothing, and the Release button stays exactly where it is. The browser must not decide what counts as dead (`depIsBlocking`'s rule at `taskboard.md:990-996`), so it draws the run's own status word. Keep the field off the MCP `list_tasks`/`get_task` payloads unless it is wanted there, since tokens there are paid for.
- **Value**: high — it supplies the one piece of visibility the whole no-lease design says replaces a lease.
- **Not worth it if**: stale claims never happen on this install (assumed not; the board had 13 claimed on 2026-09-26 per `taskboard.md:478-479`, and how many of them were stale was not measured).

### C-9 Start a run from a task, linked to it
- **Friction**: the board and the new-task page both say "starting the work is a separate press" (`src/app/tasks/page.tsx:704-708`, `src/app/tasks/new/page.tsx:22-23`), and there is no such press. `POST /api/runs` takes no task ids (`grep -n taskIds src/app/api/runs/route.ts` is empty), and `/runs/new` reads only `?from=` (`src/app/runs/new/page.tsx:607`). The ways to start a *linked* run are a chat proposal or an orchestrator emission, both billed model turns. Copying a brief into the form by hand gives an unlinked run: no claim, the board still says `open`, and the run can never `complete_task` it, because a run may complete only what was claimed in its own name (`taskboard.md:68-74`).
- **Change**: a *Start a run* `ButtonLink` on `/tasks/[id]`, drawn only while the task is `open`, to `/runs/new?task=<id>`. The form seeds the prompt from the title and brief (fetched whole from `GET /api/tasks/[id]`, never from a list row, per `taskboard.md:838-850`) and the mount/folder pair, the way `?from=` seeds from a run, and shows the linked task. `POST /api/runs` accepts `taskIds`, validates them through `readTaskLinks`/`taskRefusal` against `currentTaskKnowledge()` (`src/lib/tasks.ts`), and hands them to `createRun` in `CreateRunInput.taskIds`.
- **Size**: M.
- **Touches**: `taskboard.md:13-27` holds — the operator presses Run on the form, and the task starts nothing. `taskboard.md:755-768` is the ordering that must not be broken: the ids go *into* `createRun`, never written after it. Offer it on `open` only: on a claimed task the new run's claim is refused and logged, which is two agents with one brief. One decision to make: whether the form is held to `readTaskLinks`' mention rule, which would refuse a brief naming another open task (`taskboard.md:731-753`) and need a `relatedTaskIds` affordance on the form. The form lives in `src/app/runs/new/`, outside this territory.
- **Value**: high — it removes a billed chat turn, or a silently unlinked run, from the most basic move on the board.
- **Not worth it if**: the operator deliberately routes all board work through the chat.

### C-10 Warn before an unsaved brief or note is thrown away
- **Friction**: `TaskEditor` holds a 16-row draft of the brief (`src/components/TaskEditor.tsx:104`) and `TaskThread` a second draft for a note (`src/components/TaskThread.tsx:123`). Neither registers a leave guard, although the app has one: `src/lib/unsavedWork.ts:36` (`registerLeaveGuard`), used by `WorkflowEditor.tsx:934`, and a `beforeunload` in `settings/page.tsx:2352`. The exits beside the form are many — Cancel, *Back to the taskboard*, every dependency row and graph node (both links, by design, per `taskboard.md:1003-1005`), the parent link, the sidebar, ⌘1–⌘9 and ⌘K. Two smaller frictions sit beside it. Title has `autoFocus` on the edit route too (`TaskEditor.tsx:210`), so opening a task to read it puts the caret in a field, and `AppShell` skips its shortcuts inside text entry, so ⌘K and the pane digits do nothing until the operator clicks away. Save always sends the whole draft including the project pair (`TaskEditor.tsx:139-144`), so a priority change on a task whose mount is absent right now is refused, which the hint at `:314-318` admits. That is the read-modify-write `PATCH`'s docblock exists to avoid (`src/app/api/tasks/[id]/route.ts:65-68`).
- **Change**: track dirty state against the seeded task and the composer's text, and wire `registerLeaveGuard` plus `beforeunload` exactly as `WorkflowEditor.tsx:876-938` does. With a third caller, a small `useLeaveGuard(dirty)` hook is justified. Keep `autoFocus` on `/tasks/new` only. Send only the fields that differ from the seed, so an unchanged project is not re-proved.
- **Size**: S.
- **Touches**: `taskboard.md:824-836` — the page still does not poll, and the draft is still seeded once. `conventions.md`'s `beforeunload` rule: registered only while dirty.
- **Value**: high — the brief is the one field the whole board exists for, and it is lost to one misclick today.
- **Not worth it if**: nothing found kills it.

### C-11 The dependency picker offers the tasks that could block
- **Friction**: the picker asks `/api/tasks?limit=${MAX_TASK_PAGE}` across every status (`src/components/TaskDependencies.tsx:226`). That is the priority-first single page the board itself stopped using on 2026-09-26, when at 816 tasks it held 215 Done rows while 77 of 154 Open and 5 of 13 Claimed were missing (`taskboard.md:474-481`). A done task blocks nothing (`depIsBlocking`), so the picker spends most of its one page on the rows least likely to be picked, and leaves out open work the operator is trying to order. Options arrive in priority order rather than grouped, and an edge that already exists is offered again only to be answered *already recorded*.
- **Change**: ask two pages, `status=open` and `status=claimed` (the route already filters by status in the query, `src/app/api/tasks/route.ts:74-81`), and draw them as two `<optgroup>`s, each keeping the existing *n of total* line. Drop ids already in the task's `deps`. Done and dropped tasks stay reachable by editing from the other end, or through a third, folded group if they turn out to be wanted.
- **Size**: S.
- **Touches**: `taskboard.md:495-499` records that the picker asks for "exactly one page" and says when `total` was larger; this keeps one page *per request* and the shortfall sentence per group, and `MAX_TASK_PAGE` stays in `apiTypes.ts`. A server refusal is still rendered verbatim (`taskboard.md:1075-1078`).
- **Value**: high at this backlog's size — the task an operator wants to order against is often not in the list at all today.
- **Not worth it if**: orderings are usually drawn against finished work, which a done dependency's not blocking makes unlikely.

### C-12 Keep the board's project filter, and file new tasks into it
- **Friction**: the project filter is component state (`src/app/tasks/page.tsx:345-348`). Opening a task and coming back — Back, *Back to the taskboard* (`src/app/tasks/[id]/page.tsx:278`), or Cancel — resets it to Every project, so working one project's backlog means re-picking it after every task opened. *New task* (`page.tsx:711`) opens an empty mount/folder pair (`TaskEditor.tsx:60-66`) even while the board is narrowed to one project.
- **Change**: keep the chosen key in `sessionStorage`, or in `?project=` read from `window.location` the way `runs/new/page.tsx:604-607` reads `?from=`, falling back to Every project when the key is not among the options after the first load. Pass the narrowed project's `mountId`/`folder` (both already on the rows) to `/tasks/new?mountId=&folder=`, and seed the editor's draft from them.
- **Size**: S.
- **Touches**: `taskboard.md:489-495` — the options stay derived from the rows the board was answered with, never from `/api/folders`, so a remembered key that is no longer an option falls back rather than being drawn. The seeded pair on `/tasks/new` is proved at the door on Save like any other.
- **Value**: medium — for anyone working more than one project, which the filter exists for.
- **Not worth it if**: the install effectively has one project.

### C-13 Search the board by title and brief
- **Friction**: there is no text search on the board. The brief is not drawn on the board at all, and the list DTO clips it to `MAX_LIST_TASK_BODY` (`src/lib/tasks.ts:1626-1640`), so "has this already been filed?" at 816 tasks is browser find over titles, with Done and Dropped folded away. Quick open does not search tasks (`src/components/shell/QuickOpen.tsx`). The chat's `list_tasks` has no text filter either, so a model checking for a duplicate before `create_task` pages the whole board.
- **Change**: `q` on `GET /api/tasks`, `(title LIKE ? OR body LIKE ?) ESCAPE '\'` with `%` and `_` escaped, as `findChats` does (`docs/agent/chat.md:69`), normalised in the pure, tested `normalizeTaskListQuery` (`tasks.ts:967`). On the board, an input beside Project, passed to every per-status read. The same parameter on `list_tasks` as `query`, as `list_past_proposals` already has (`src/app/api/mcp/route.ts:843-846`).
- **Size**: M.
- **Touches**: `proposals/Findability` concluded that "findability is a property of a route" and put `q=` on `/api/branches` and `/api/dreaming`; the board did not exist when it measured, so this is that recommendation applied to one more route rather than a new index. `taskboard.md:474-487` — narrowing is in the query, per status, and a search that matched nothing is a fourth way of having nothing: it must not draw the empty-board card that says "Nothing on the board — File one" (`taskboard.md:1091-1102`).
- **Value**: medium — mostly as the duplicate check before filing, which is what `openInFolder` exists for on the run side.
- **Not worth it if**: browser find over titles turns out to be enough (not measured).

### C-14 Show what was filed while working a task
- **Friction**: a run's `create_task` defaults its parent to the task the run was started for (`taskboard.md:581-587`), so the children of a task are what working it turned up. The task's own page shows only its parent (`src/app/tasks/[id]/page.tsx:309-322`), `listTasks` cannot filter by parent, and on the board the *Filed under “X”* line is plain text (`src/app/tasks/page.tsx:489-497`), where `DepLine` beside it links.
- **Change**: a `parentTaskId` filter (exact match) on `listTasks` and `GET /api/tasks`. On the task page, a short list of children — title link and status `Badge`, *n of total* when clipped. On the board, make the parent's title a link to `/tasks/<parent>`.
- **Size**: S.
- **Touches**: `taskboard.md:292-299` — parentage is provenance, not ordering, so it is drawn apart from the Dependencies card and never merged with it. A parent deleted since is already drawn as a short id (`page.tsx:492-495`) and stays unlinked, the deleted-task rule of `taskboard.md:799-808`.
- **Value**: medium — "what did working this turn up" is otherwise a scan of the whole board by eye.
- **Not worth it if**: `taskboardForRuns` is off on this install, so runs file nothing (the setting's state here is unknown).

### C-15 Change a task's priority from its board row
- **Friction**: re-ranking one task is: open it, change the select (`TaskEditor.tsx:232-251`), Save, which re-proves the folder (C-10), go back, and re-pick the project filter (C-12). The route was built for exactly the one-field patch: "most presses on a board change one thing — a status, a priority" (`src/app/api/tasks/[id]/route.ts:65-66`).
- **Change**: on open and claimed rows, the priority cell (`src/app/tasks/page.tsx:575-588`) becomes a compact `Select` that `PATCH`es `{ priority }` on change, with the in-flight state keyed on `id:priority` (the `moving` rule, `page.tsx:352-354`, `taskboard.md:819-822`), the server's sentence rendered verbatim on a refusal, and a re-read either way.
- **Size**: S.
- **Touches**: `taskboard.md:810-822` — the board draws controls and never decides a move; a priority change is not a status move, and the server still answers. `taskboard.md:962-966` — the column's width comes off the title, so the select must fit the Priority column's existing `min-w`. The row will move within its group on the next read, because the listing is priority-first; that is the change being made, not a glitch.
- **Value**: medium — triage is the board's other daily move besides closing.
- **Not worth it if**: the operator rarely re-ranks.

### C-16 Let the orchestrator's replies link to the app's own pages
- **Friction**: the orchestrator's job is to talk about runs, tasks, proposals and workflows, and its tools hand it their ids (`list_runs`, `get_run`, `list_tasks`, `list_past_proposals`). Its replies render through `Markdown` (`src/app/chat/page.tsx:1832`, and `:1261` for the live partial), whose `safeHref` accepts only `http`, `https` and `mailto` (`src/components/Markdown.tsx:551-556`). So a reply writing `[the failed run](/runs/3f2a…)` renders as that literal bracketed text (`Markdown.tsx:744-748`). An operator reading "run 3f2a1b9c stopped on its budget" copies the id into quick open or the URL bar to follow it. How often replies name ids was not counted; the `OrchestratorChatQuality` corpus would answer it.
- **Change**: an opt-in `appLinks` prop on `Markdown`, passed only by the chat page. With it on, a link target that is a same-origin path under a closed list of prefixes — `/runs/`, `/tasks/`, `/workflows/`, `/chat` — is drawn as an in-app link (same tab, no `target="_blank"`). A target starting `//` or `/\` is refused, since those are protocol-relative. One sentence in `systemPrompt()` then tells the model to link what it names that way. Every other caller, including the knowledge pages and a run's report, is unchanged.
- **Size**: S.
- **Touches**: `Markdown.tsx:34-41` — the renderer's safety rests on "a scheme allowlist and an unknown scheme renders as its own literal text". A path allowlist keeps that shape: it is a closed set, it is checked before any link is drawn, and a path without a scheme cannot execute. `Markdown.tsx:43-45` — the file imports nothing that reaches the app, so the link stays a plain `href` and no router call is added. `chat.md:39` — the prompt is this child's boundary, so the added sentence must say nothing about what the model may *do*.
- **Value**: medium — every reply that names a run becomes one click to it.
- **Not worth it if**: the model rarely names a run or task in prose (not measured).

## Too big for this list

- **Tell an operator who is not looking that the chat asked them something.** `ask_operator` ends the turn and waits on a person (`docs/agent/chat.md:49`), but the only outbound channel is the run webhook, whose field list is closed and run-only (`src/lib/notify.ts:49`, `NotificationBody` at `:66-78` carries a `run_id` and a `/runs/<id>` url), and a chat thread has no URL to send (`ChatPanelExperience` O3). It needs a decision on reopening that closed list, plus a per-thread URL first.
- **Bulk moves on the board** (drop, re-open or re-prioritise several at once). It needs a selection column, and `taskboard.md:962-966` refuses a seventh column because its width comes off the title. A bulk design has to take that argument on directly, perhaps as a selection mode that replaces a column rather than adding one.
- **Start a run from several tasks at once** (the batch shape `taskboard.md:718-729` says the chat already produces). It is C-9 plus a multi-select on the board, so it inherits both C-9's form work and the bulk item's column argument.

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

- `src/lib/orchestrator.ts:9610` — `if (spendIsMeasured) spentUSD += res.costUSD` per work cycle, and cycles resume the session (`src/lib/cycleInvocation.ts:1298`, `--resume`). If a resumed cycle's `result.total_cost_usd` carries the restored session total on 2.1.280, as the chat task `d2782026` establishes from the binary, run spend is over-counted the same way. The comment at `orchestrator.ts:7577-7582` says a resumed child's accumulator "starts at zero", which the pinned binary's `costLedger.restore` contradicts. This is the most consequential line in this file and was **not** checked against a real run's `spent_usd` and telemetry.
- `src/lib/workflows.ts:740` — `planEmission` reads a non-array `dependsOn` as none; same cause as `a680431f`, which names it.
- `src/lib/workflows.ts:388`, `src/lib/schedules.ts:1149` — neither approver checks the proposal is still `pending` (half of the duplicate-ids bug under "Bugs not filed").
- `src/lib/review.ts:239-247` — `reconcileReviewsOnBoot` fails a running validate row and closes nothing; the fix for `382b15b1` may land here instead of in `validation.ts`.
- `src/lib/schedules.ts:172` — `Math.trunc(Number(o.hours))` coerces `true` to every hour and `[5]` to five; a boolean or array should be refused.
- `docs/taskboard.md:185-186` — says the board announces a backlog that outgrows one page; since `4a49627` the board reads every page and draws no such notice.
- `docs/agent/chat.md:69` — says a thread's title "is written by the model from the opening line"; `src/lib/chat.ts:3707-3717` writes the operator's own first message, clipped to 80 characters.
