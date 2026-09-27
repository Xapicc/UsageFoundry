# Branch inventory, squashes and deleting a branch

[← isolation-and-landing index](../isolation-and-landing.md)

Read before editing `branchInventory`, `deleteBranch` or `purgeBranch` in `src/lib/land.ts`, `withRepoAdmin` in `src/lib/repoLock.ts`, or `GET /api/branches`.

**Every branch this app produced is reachable, and the cap is on the page rather than on the set.** `branchInventory` used to take the newest 400 *runs*, collapse them and keep 60 — two truncations that stack, and the second one silently. Branches 61…N were dropped and counted; branches belonging to older runs were dropped *before* the count, so the page could not say they existed because nothing had looked. At twenty-five concurrent runs that is about five hours before committed work stops being reachable from any page in this app. So the candidate set is now its own query over the branch-bearing runs (`isolation='worktree'` with a branch and a repo root, every one of them, newest first) and `selectBranchCandidates` is the pure decision on top of it: collapse to one row per branch *before* the slice, so a page holds sixty branches rather than sixty runs and a five-link chain does not eat five rows; `total` counted over the whole matching set so `notShown` is derived from what exists rather than from what was examined; `repos` counted over the *unfiltered* set, because a filter that hides the repositories you would use to change it is a filter you cannot get out of. What the two caps bound is unchanged and is the point: `MAX_INVENTORY` `rev-list` calls and `MAX_PENDING_PROBES` status probes per request, whatever `repo` and `offset` are set to — they move which sixty branches are paid for, never how many. **What did change is when the second cap is applied, and it had to.** Both per-branch git reads are now resolved after the collection loop under a bounded pool rather than one per turn of it: serially they *were* the request, a `git status` against a 15,082-entry checkout measuring 140 ms and eight of them making up 1.12 s of a 1.13 s `GET /api/branches`, with the cap of twenty putting the worst case at 2.8 s — and neither read decides anything the other or the loop needs. Once they overlap, a `probes < MAX_PENDING_PROBES` test spread across awaits caps nothing: every turn scheduled together reads the counter before any of them has incremented it, so the cap is exceeded by however many started at once and *which* rows got a probe becomes a function of how the event loop interleaved them — two identical requests answering `uncommitted` on different branches, with nothing anywhere saying so. `selectProbeTargets` is that decision, pure and made in one synchronous pass before the first probe is dispatched, and it keeps the answer the serial loop gave: the first `limit` rows, in page order, whose branch some checkout still holds, with rows no checkout holds skipped without spending cap since there is nothing to ask git about. A row nothing probed stays `null`, which the page reads as "not asked" — the same answer a failed probe gives, and never a claim of clean. Only the examined rows are read back in full, so listing sixty branches on a machine with fifty thousand runs does not load fifty thousand prompts. The route is still not polled, for the reason its own comment gives.

**A squash is landed work that git cannot see.** Squashing rewrites the commits, so the branch is never an ancestor of its target and `merged` is false for ever — which would both offer it for landing a second time and leave it undeletable. `landed_tip` records the branch tip at land time; `landedUnchanged` (tip unmoved) is what stands in for ancestry, and it stops being true the moment the branch gains a commit, which is exactly when deleting would lose something. Branch deletion uses `-d` wherever git can see the merge itself and `-D` only in this case.

**Getting rid of a branch is two doors, and only the careful one is called Delete.** `deleteBranch` still refuses anything git cannot see as merged — that refusal is all that stands between a stray click and work that exists nowhere else — and `purgeBranch` is the deliberate other one, for the attempt that went nowhere and the slot it is holding hostage. It destroys committed work by design, so the caller has to **name the branch back**: that echo is not authentication and never selects anything (the row still decides what is deleted), it is what stops a request aimed at one branch from landing on another, and what forces the interface to spell out what goes. It force-removes the checkout, which `deleteBranch` will not do, and counts the commits and the uncommitted paths *before* anything is removed so the sentence afterwards says what was lost. Neither door is offered for an active run, and the UI never shows both at once.

**The other doors are claimed too, and by a *second* claim, because they are
not about that folder.** `landing` is the operator's checkout — a directory a
person also works in — and it **refuses**, which is the honest answer for
something that takes minutes. What `resolveCheckout`, `deleteBranch` and
`purgeBranch` share with the run loop is the repository's
`$GIT_DIR/worktrees` registry, and `withRepoAdmin` (`repoLock.ts`) is that one:
keyed on the repository root, and it **waits** rather than refusing, because the
run loop is one of the four callers and a refusal there would fail a run start
because somebody pressed Delete. `git worktree prune` is the operation that
makes it necessary — it is the only one here that is repository-wide rather than
scoped to a named entry, so it is the one git's own per-entry locking does not
serialise. Two rules for the sections it brackets. **They are short**: the
registry read and the removals are in, and `worktree add` and the seeding copy
after it are deliberately out, so concurrent run starts in one repository still
overlap where the cost is. And **the read that decides is inside the claim that
acts** — `worktreeHolding` moved in for both deletion doors, since a slot read
outside is a slot another caller may since have taken or freed. `commitPending`
takes neither and needs neither: it writes into the run's own checkout with
`add`/`commit`, touches no registry, and already tests for a live holder.
**None of this is evidence of a collision** — nothing has ever reproduced one,
which is why `proposals/GapRegister/` ranks that row on blast radius; it closes
the app-level interleaving, which is the half this repository owns.
