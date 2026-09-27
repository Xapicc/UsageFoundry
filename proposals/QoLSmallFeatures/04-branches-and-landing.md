# QoL hunt 4/5: branches, landing, review, touched and conflict maps

At `fee5efb`. Work in progress — this paragraph is rewritten when the hunt ends.

## Items

### G-1 Name the paths when Land refuses a dirty checkout
- **Friction**: the operator presses Land (or opens the card) and reads "Your checkout has uncommitted changes — commit or stash them first." (`src/lib/land.ts:1040-1041`) with no clue which files. `checkoutStateOf` runs `git status --porcelain` and keeps only a boolean (`land.ts:422-434`), so the answer is thrown away one line after it was read, and the operator re-runs `git status` in a terminal to find what is usually one stray file. The merge queue halts a whole repository on the same fact (`docs/agent/isolation-and-landing.md`, "A queue tells a branch's problem apart from the checkout's") and says just as little.
- **Change**: keep the parsed porcelain on `CheckoutState` (`parseStatusZ`, `land.ts:1836`, already parses `-z` output for the run's own slot) and put the first three paths plus a count in the refusal, exactly as `trackedDirt` already does with `DIRT_NAMED = 3` for the resolution checkout (`land.ts:1332-1376`). `RunLand` needs no new element: the refusal is already its one state line (`src/components/RunLand.tsx:453-468`).
- **Size**: S.
- **Touches**: `landRefusal` is pure and unit-tested (`isolation-and-landing.md`, "The tool does now merge…"); the new sentence needs a test case. `git status --porcelain` must not be trimmed (`isolation-and-landing.md`, "Work an agent left uncommitted…") — use `-z` and `trim: false`. Unreadable must stay "could not read", never "clean".
- **Value**: high — it is the refusal every operator with a working checkout meets, and the fix is information the server already held.
- **Not worth it if**: measured refusals on real installs are almost never the dirty-checkout one (assumed common; not measured — `run_events` has no row for a refused land, so this could only be counted by instrumenting it).

### G-2 Let untracked files through Land, on `resolveCheckout`'s own reasoning
- **Friction**: "clean" for Land is `status --porcelain` being empty (`land.ts:431`), so one untracked scratch file in the operator's checkout (`notes.tmp`, an editor swap file) blocks every Land and halts the queue for that repository. `resolveCheckout` already refuses on `trackedDirt` rather than on non-empty porcelain, and `docs/agent/isolation-and-landing.md` ("A conflict is resolved on the run's branch…") gives the reason: an untracked file cannot reach the merge commit, and "where a merge would clobber one git refuses by name".
- **Change**: in `checkoutStateOf`, treat `??` records as not dirty (keep them in G-1's list as information); `landRefusal` unchanged otherwise. Executed in a scratch repository on git 2.39.5: with an untracked `notes.tmp` and an untracked `new.txt` the branch adds, `git merge --no-edit` refused "The following untracked working tree files would be overwritten by merge: new.txt … Aborting" (exit 1); with only `notes.tmp` it merged (exit 0) and left `?? notes.tmp` untouched.
- **Size**: S.
- **Touches**: this takes on the recorded rule "The operator's checkout must be clean" (`isolation-and-landing.md`, "The tool does now merge…") directly; its stated reason is merge safety, which the git behaviour above preserves for untracked files. **Must not ship before board task `a8a0bd95`** (filed by this hunt): `unwind`'s `reset --hard` leaves untracked files alone, but that task shows the unwind path is already unsafe when the tree changed under it.
- **Value**: medium — removes the most trivial blocker, but only for installs whose operators leave untracked files lying around (assumed common for a checkout a person works in).
- **Not worth it if**: the operator wants "clean" to mean clean as a matter of policy — then G-1 alone is the fix.

### G-3 Delete every merged branch on the page in one press
- **Friction**: cleaning up after a day of landing is one Delete press per row (`src/app/branches/page.tsx:1596-1604`), each a round trip that re-derives `landState`. The page's tick boxes exist only for landing (`queueable`, `branches/page.tsx:186-187`). `proposals/Findability/` measured 141 branches in one repository on this machine, so the cleanup is dozens of presses.
- **Change**: a "Delete N merged" button in the table card's title row (beside Refresh, `branches/page.tsx:1027-1038`), counting rows where `exists && (merged || landedUnchanged) && !active`, opening the existing `Sheet` (as the Land confirmation does, `branches/page.tsx:1345-1360`) that lists the branches, then POSTing `action: "delete"` for each in turn to the existing `/api/runs/[id]/land` route and reporting "N deleted, M refused (reasons)". No new endpoint; `deleteBranch` (`land.ts:2167`) keeps every refusal it has.
- **Size**: S.
- **Touches**: `deleteBranch`'s docblock says "Always a person: nothing automatic in this app deletes a branch" (`land.ts:2188-2189`) — this is a person's press, confirmed on a sheet that names every branch. `chainBlocker` and the loop refusal still apply per row. Sequential, not parallel, because each delete takes `withRepoAdmin` (`src/lib/repoLock.ts`) anyway. Scope is the page (sixty rows), which is what the operator can see — say so on the sheet. Would be far more useful after board task `a9ec4551` (filed by this hunt): today every one of these deletes is refused while the operator's checkout is on another branch.
- **Value**: high — the branch list only ever grows, and this is the one cleanup that is safe by construction.
- **Not worth it if**: G-5 lands first and operators stop caring about merged-but-present rows.

### G-4 Say which run a retired checkout belongs to, and link to it
- **Friction**: the "Checkout slots" card names each retired slot only by directory and path count (`branches/page.tsx:659-672`; `DirtySlotDTO` is `name` + `uncommitted`, `src/lib/apiTypes.ts:2898-2903`) and tells the operator to "Commit or purge what the checkouts below hold" (`branches/page.tsx:616-617`). The Commit and Purge buttons are on the owning run's Land card and branch row, and nothing on the card says which run that is — so the operator opens a terminal, `cd`s into `<slug>-17`, runs `git branch --show-current`, and then searches for that branch. `docs/agent/isolation-and-landing.md` says nothing reclaims a retired slot, so this is the only way slots come back.
- **Change**: in `checkoutStores` (`land.ts:2617-2734`), for each dirty slot already probed, also read `rev-parse --abbrev-ref HEAD` (bounded by the same `MAX_SLOT_PROBES`) and look up `runs` by `worktree_path` and `worktree_branch`; add `branch` and `runId` (nullable) to `DirtySlotDTO`; render the branch and a "Open run" link in that cell. A slot whose branch no run owns says so.
- **Size**: S.
- **Touches**: `pendingWork` offers Commit only while the slot still holds the run's own branch (`land.ts:1899-1916`, and `commitRefusal`), so the link must go to the run whose branch the slot holds **now**, never to whichever run last had that path. One more git call per dirty slot on a page that is not polled.
- **Value**: medium — only hits when slots are retired, but then it is the only way back from "no checkout left".
- **Not worth it if**: retired slots are rare in practice (the card only renders at the first one, `branches/page.tsx:599-602`).

### G-5 Stop listing deleted branches as rows for ever
- **Friction**: `branchBearingRuns` selects every run with `isolation = 'worktree'` and a branch (`land.ts:2903-2916`), and neither `deleteBranch` nor `purgeBranch` writes anything to `runs` — a deletion is only a `land` event (`land.ts:2266-2271`), which retention sweeps. So every branch the operator has ever deleted stays on `/branches` as a "gone" row (`branches/page.tsx:139-144`), takes one of the sixty rows a page pays git for, and is counted in the title's "N branches" (`branches/page.tsx:1029`). Cleaning up never makes the list shorter.
- **Change**: an idempotent `runs.branch_removed_at` column in `migrate()` (`src/lib/db.ts`), written by `deleteBranch` and `purgeBranch` on success; `branchBearingRuns` leaves those rows out by default and `branchInventory` returns their count so the card can offer "Show N deleted". A branch deleted outside the app still shows as "gone", which is true.
- **Size**: M (migration, two writers, one query, one toggle, a `selectBranchCandidates` test for the count).
- **Touches**: "Every branch this app produced is reachable" (`isolation-and-landing.md`) — a deleted branch has no work left to reach, and the toggle keeps the record reachable. `total`/`notShown` must be counted over the filtered set or the pager lies (`selectBranchCandidates`, `land.ts:2853`). `reopenRun` on a deleted branch is already refused by `requireBranch`.
- **Value**: high — without it every other cleanup on this page is invisible in the list.
- **Not worth it if**: the operator wants "gone" rows as a history; then the default flips and the toggle stays.

### G-6 Show when and how a branch was landed on the branches table
- **Friction**: the row's badge says "merged" or "squashed in" (`branches/page.tsx:151-164`) whether this app landed it an hour ago or someone merged it by hand last month. `BranchSummaryDTO.landedAt` is already on the wire (`apiTypes.ts:2894`) and the page never reads it (`grep -n landedAt src/app/branches/page.tsx` → no match); the run page's Land card is the only place it is drawn (`RunLand.tsx:455-461`).
- **Change**: under the badge, "landed <date>" when `landedAt` is set (the same slot `UncommittedNote` uses, `branches/page.tsx:1531`), and nothing when it is not.
- **Size**: S.
- **Touches**: `UncommittedNote`'s comment (`branches/page.tsx:1514-1530`) forbids a third wording for the uncommitted state — this is a different fact, so it needs its own words, and "landed" is already the Land card's badge (`RunLand.tsx:373`).
- **Value**: low — useful for reading the page as a record, not for any decision.
- **Not worth it if**: G-5 hides most landed branches anyway.


### G-7 Open every file of a diff at once
- **Friction**: "What changed" draws each file as a closed disclosure (`DiffFileRow`, `src/components/ui/Patch.tsx:140-180`, listed by `src/components/RunDiff.tsx`), so reading a run's whole change before deciding to land it is one click per file — and the patches are already in the response (`selectForPatch` budgets them into `RunDiffDTO`; `docs/agent/git-and-review.md`, "A diff that was shortened says so"). No list in the app has an open-all control (`grep -rn "Expand all\|Open all" src` → nothing).
- **Change**: an "Open all" / "Close all" button in the card's title row beside Refresh (`RunDiff.tsx`), shown when there are two or more files with patch bodies; implemented by re-keying the rows with `defaultOpen` (the `Disclosure` prop read at mount, `src/components/ui/Disclosure.tsx:64-65`), so no controlled state is added to a component whose `open` is reserved for fetch-on-open. Files listed without contents stay closed and say so, as they do now.
- **Size**: S.
- **Touches**: `conventions.md`'s grouping vocabulary — this is one control on an existing card, not a new region. Opening forty patches at once is a long DOM; the card already scrolls its file list above 24 files (`SCROLL_FILE_LIST_ABOVE`, `RunDiff.tsx`), which bounds it.
- **Value**: medium — reading the diff is the decision Land asks for, and this removes the per-file clicking from it.
- **Not worth it if**: operators mostly land without reading the diff (not measured).

### G-8 Say on the Land card that a verify command will run first, and which
- **Friction**: with `landVerifyCommand` set, pressing Land runs the operator's command in the run's checkout for up to 15 minutes (`VERIFY_TIMEOUT_MS`, `src/lib/landGate.ts:165`) before anything merges, while the button reads only "Landing…" (`src/components/RunLand.tsx:653`). The sentence above the button says "Merges into <target> in your own checkout, which has to be clean and standing on it. A conflict is rolled back." (`RunLand.tsx:585-596`) and never mentions the check; the only hint is the Open pull request sentence's "The check Land takes applies here too" (`RunLand.tsx:611`), which refers to a check nothing on the card has named. The land GET does not return the command (`src/app/api/runs/[id]/land/route.ts` GET returns `state`, `defaultStrategy`, `resolution`, `delivery`).
- **Change**: return `verifyCommand` (the configured string, or null) from the land GET and add one clause to the existing sentence: "Runs `npm test` in the run's checkout first; a failure refuses the land." While a land is in flight with a command set, the button reads "Checking…" rather than "Landing…" — the card does not know when the check ends, so it should say "Checking, then landing…" rather than guess.
- **Size**: S.
- **Touches**: `isolation-and-landing.md`, "The check in front of Land": an empty command is not a check, so nothing is said when none is set. The minutes-long wait is also the window in board task `a8a0bd95` (filed by this hunt); telling the operator a check is running is a reason for them not to touch their checkout meanwhile, which is a mitigation, not the fix.
- **Value**: medium — a multi-minute silent spinner on the button that writes into the operator's checkout is the worst place in the app to leave someone guessing.
- **Not worth it if**: almost no install sets `landVerifyCommand` (it is empty by default, `src/lib/settings.ts`; install counts not known).

### G-9 Run the land check on a branch without landing it
- **Friction**: the only way to learn whether a branch passes `landVerifyCommand` is to press Land, which, if it passes, merges immediately (`src/lib/land.ts:1145-1171`). An operator who wants to know "does this pass?" before deciding — or before queueing ten branches — has no button for it, and the merge queue runs each check inline at its turn.
- **Change**: a "Run check" action on the Land card (a new `action: "verify"` in `src/app/api/runs/[id]/land/route.ts`) that calls the existing `verifyTree` + `runVerify` and returns `landVerdict`'s sentence and tail, drawn in the card's existing note/error slot. It takes nothing in the operator's checkout, so it needs no `landing` claim; it does need the run to be settled, which `landRefusal`'s status test already expresses.
- **Size**: S to M.
- **Touches**: `isolation-and-landing.md`, "The check in front of Land" and "Which tree the check runs in…": same tree, same refusals, same child uid and `verifyEnv` (`landGate.ts`). It is one more door that runs agent-written repository code (`npm test` executes the branch's own `package.json`), as the child uid — the same exposure Land already has, reachable without a merge. Should wait for board task `0a3278ff` (filed by this hunt), or it inherits the uncommitted-work hole.
- **Value**: medium — turns the gate from a trap into a tool, for installs that set it.
- **Not worth it if**: G-8 is enough for the operators who set a command.

### G-10 Jump from a touched file to its patch
- **Friction**: on the run page, "What it touched" is drawn inside the "What changed" card's own component (`src/components/RunDiff.tsx:208` renders `<RunTouches run={run} diff={diff} />`), so the two lists about the same files sit one above the other — and a row in the touched table is plain text (`src/components/RunTouches.tsx:251-257`, `<span className="mono">{file.path}</span>`). An operator reading "changed, never named by a tool call" — the group whose whole point is "go and look at this change" — scrolls back up the diff list and hunts for the same path by eye, then opens it.
- **Change**: give each `DiffFileRow` an `id` derived from its path (`src/components/ui/Patch.tsx:140`) and make the path in a touched row a link to it when the file is in `diff.files`; following the link opens that row's disclosure (re-key with `defaultOpen`, as G-7 does) and scrolls it into view. Rows whose file is not in the diff stay plain text, which is itself the information.
- **Size**: S.
- **Touches**: `git-and-review.md`, "What a run *touched*…": the changed set arrives as a prop precisely so this needs no second fetch — keep it that way. "Nothing may render as an empty list" is unaffected. A path id needs escaping (paths can hold spaces, quotes, `#`); use an index into `diff.files` rather than the raw path.
- **Value**: medium — it turns the reconciliation from a list of names into a route to the evidence, on the page where the land decision is made.
- **Not worth it if**: board task `1c04d1ea` (filed by this hunt) changes which runs get a reconcilable diff enough that the link would mostly be absent; it should land first either way.

### G-11 Mark a review that no longer matches the branch
- **Friction**: a review is a verdict about one diff, and the card shows it with only its date (`src/components/RunReview.tsx:33`). After a Reopen adds commits, or a resolution merges the target in, the old review still reads as the review of this branch. `run_reviews` already has `base_sha` and `head_sha` (`src/lib/review.ts:167-168`, inserted at `:429-450`), but `startReview` never passes them (`review.ts:298-310` builds the `startAssist` request with no `baseSha`/`headSha`); only validations fill them.
- **Change**: have `startReview` record the branch tip it read (one `rev-parse`, the same moment `runDiff` is taken) as `headSha`; return it on the review DTO; on the card, when the branch tip now differs, say "Reviewed at `<sha7>`; the branch has N commits since" beside the date, and label the button "Review again".
- **Size**: S.
- **Touches**: `git-and-review.md`, "Reviewing a diff is not a work cycle and is never automatic" — this only labels, it never re-reviews by itself. The columns' rule ("written at the start … what the child was *shown*") is exactly what a review needs too.
- **Value**: medium — a stale "looks good" beside a Land button is the review being wrong in the most expensive direction.
- **Not worth it if**: reviews are rarely run on this install (not measured).

### G-12 Show what a failed resolution said
- **Friction**: when a conflict resolution fails ("Conflict markers are still in …", or a refusal from the agent), the Land card shows the error but hides the agent's own text, which is drawn only for `status === "completed"` (`src/components/RunLand.tsx:536-540`). The text is stored on the row (`run_reviews.text`, returned by the land GET as `resolution.text`, `src/app/api/runs/[id]/land/route.ts`). The operator's only next step is another billed press of "Resolve with Claude", without knowing whether the agent gave up, misunderstood, or was one file short.
- **Change**: render `resolution.text` for `failed` too, under the error, in the same `max-h-52` scrolling block (collapsed by default with the kit's `Disclosure`, since it is secondary to the error).
- **Size**: S.
- **Touches**: `git-and-review.md`, "An assist streams…": the assistant's own text belongs in `run_reviews.text` and nowhere else, which this respects. It must still read as the agent's account, not as a result — the card's existing "What it says it did, and then what it did" framing (`RunLand.tsx:542-544`).
- **Value**: medium — it is the difference between retrying blind and knowing what to fix by hand.
- **Not worth it if**: failed resolutions almost never carry text (the silence deadline and spawn failures carry none; not measured how many do).

### G-13 Show how long a queued merge has been going, and what it was authorised to do
- **Friction**: a queue row draws its position, branch, target, resolution cost and status (`src/app/branches/page.tsx:295-355`); `MergeQueueItemDTO` also carries `startedAt`, `finishedAt`, `strategy` and `autoResolve` (`src/lib/apiTypes.ts:2815-2820`) and none is drawn. A `resolving` row five seconds in and one fifty-five minutes into `RESOLVE_SILENCE_MS`'s hour (`docs/agent/isolation-and-landing.md`, "A resolution's child has one deadline…") look identical, and nothing on the panel says whether a batch was allowed to spend on auto-resolution.
- **Change**: on a `landing`/`resolving` row, "for 12 min" from `startedAt` (re-rendered on the panel's existing 3-second poll); on a finished row, its duration; in the batch header (`branches/page.tsx:416-420`), "merge · auto-resolve on" or "squash · auto-resolve off" once per batch, since both are per-batch decisions recorded per row.
- **Size**: S.
- **Touches**: "Nothing on the landing path has a clock on its duration" (`isolation-and-landing.md`) — this displays elapsed time and decides nothing; the copy must not suggest a limit. Auto-resolution is authorised per batch (`isolation-and-landing.md`, "Auto-resolution is authorised per batch and recorded per row"), so saying it on the batch is saying what was authorised.
- **Value**: medium — it answers "is it stuck?" without a restart, which is the only remedy the page offers today.
- **Not worth it if**: resolutions stay as short as measured (median 111.6 s, longest 867.5 s, per the same doc) — then the elapsed time rarely matters.

### G-14 Say which workflow block queued a batch before offering to cancel it
- **Friction**: a batch a workflow's merge block queued reads exactly like one the operator queued — "Queued <time>" and a Cancel button (`src/app/branches/page.tsx:416-435`). Cancelling it fails that block, and in a loop the pass stops (`isolation-and-landing.md`, "A branch a live pass of a workflow loop is working on…"). `workflow_instance_blocks.merge_batch_id` already ties the batch to its block (same doc: "`workflow_instance_blocks.merge_batch_id` ties that batch back to the block that queued it").
- **Change**: `queueView` (`src/lib/mergeQueue.ts`) left-joins `workflow_instance_blocks` on `merge_batch_id` and returns the instance id, workflow name and block name per batch; the header says "From <workflow> › <block>" with a link to the instance page, and the Cancel press on such a batch goes through the existing `Sheet` saying the block will be recorded as not landed.
- **Size**: S.
- **Touches**: the queue panel polls every three seconds while working and "is one `GROUP BY` and no git" (`isolation-and-landing.md`, "The queue panel polls whatever it last said") — one indexed left join keeps it that. The asker rule ("recorded, never inferred") is the same column, read for display only.
- **Value**: medium — the one press on this panel that can stop an unattended workflow currently looks like housekeeping.
- **Not worth it if**: workflows with merge blocks are not used on this install.

### G-15 Re-queue a batch's failed and skipped rows in one press
- **Friction**: a row that failed (a conflict with auto-resolve off, a verify refusal) or was skipped by a checkout halt ("The checkout is on main rather than …") has no action on the panel (`src/app/branches/page.tsx:295-355`); the way back is to find each branch again in the paged, repository-filtered table, tick them in the original order and press Land. A halt skips every remaining row of the repository at once (`isolation-and-landing.md`, "A queue tells a branch's problem apart from the checkout's"), so after fixing the checkout the operator re-picks the whole tail of the batch by hand.
- **Change**: a "Queue N again" button on a finished batch that has `failed`/`skipped` rows, POSTing their `runId`s in their original `position` order to the existing `POST /api/branches/queue` with the batch's own `strategy` and `autoResolve` (G-13's fields). `enqueue` already refuses a run that is still in the queue by name.
- **Size**: S.
- **Touches**: "Auto-resolution is authorised per batch" — a new press is a new batch and a new authorisation; if the old batch had auto-resolve on, the press goes through the same confirmation `Sheet` the selection bar uses (`branches/page.tsx:1345-1360`). `landRun` re-derives everything at each row's turn, so nothing is trusted from the old batch.
- **Value**: medium — halts are the queue's commonest multi-row outcome by design, and this makes recovering from one a single press.
- **Not worth it if**: the unfiled queue-classification bugs below are fixed so that far fewer rows fail spuriously (see "Bugs not filed", first entry).

## Too big for this list

## Bugs filed

- Land merges into a checkout it last read before a 15-minute verify command, and a squash unwind then wipes uncommitted edits — high — `a8a0bd95-a2f4-424e-920d-90af96431a32`
- Land verify gate passes on uncommitted work that the land then leaves behind — normal — `0a3278ff-c134-4551-965f-e0cca9d87368`
- Delete branch refuses a merged branch whenever the operator's checkout is not on its target — normal — `a9ec4551-98a5-453e-95a3-d5885687ceea`
- Land card hides why Land is refused once a landed run's branch gains new commits — normal — `9083ce3a-6fd8-4741-8f53-487128bc70de`
- Branches page resets the chosen merge strategy on every inventory re-read, so a selection lands with the default — normal — `5b6e8305-4434-4cc4-8016-9a7055bba44b`
- After a conflict resolution, "What changed" and the review count the target's commits as the run's work — normal — `a7f6343d-cd3f-40bb-b75f-81d0d0599fcb`
- Files tab and touched map call every edited file "not changed" for runs without a committed branch diff — normal — `1c04d1ea-ce58-4f52-a409-0f3fd32ab8a0`
- One failed patch read blanks every file's contents in "What changed" and blames size without the shortened-diff notice — normal — `eb0c39de-4d14-4b40-bb45-bb2e9636849c`

## Bugs not filed

## Seen outside my territory
