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


## Too big for this list

## Bugs filed

- Land merges into a checkout it last read before a 15-minute verify command, and a squash unwind then wipes uncommitted edits — high — `a8a0bd95-a2f4-424e-920d-90af96431a32`
- Land verify gate passes on uncommitted work that the land then leaves behind — normal — `0a3278ff-c134-4551-965f-e0cca9d87368`
- Delete branch refuses a merged branch whenever the operator's checkout is not on its target — normal — `a9ec4551-98a5-453e-95a3-d5885687ceea`

## Bugs not filed

## Seen outside my territory
