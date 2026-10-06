# Land and the verify gate

[← isolation-and-landing index](../isolation-and-landing.md)

Read before editing `landRun`, `landRefusal`, `unsettledBranchRefusal`, `chainBlocker` or `verifyTree` in `src/lib/land.ts`, or `src/lib/landGate.ts` or `src/lib/verifyCommand.ts`. The verify gate is Deliver's too; the rest of Deliver, and the refusal of a branch carrying a seeded file that both exits share, are in [deliver.md](deliver.md).

**The tool does now merge, and every protection the old "never merges" rule bought is a check in `land.ts` rather than a caveat.** The operator's checkout must be clean (unreadable counts as dirty, same rule as `emitHandoff`) *and* standing on the recorded target branch — landing onto the wrong branch is the one mistake here with no undo, so it is refused by name rather than caveated. An active run's branch is never landable: `running`/`queued`/`paused` can commit again, and the base that merges cleanly now will not be the base in ten minutes. A failed merge is aborted immediately and the conflicting files reported, so a half-merged index never survives the request. `landRefusal` is pure and unit-tested for exactly these branches, because it is the decision that writes into a directory a person also works in. **The checkout half is proved twice, and the second proof is the one the merge stands on.** `landRefusal` answers from `landState`'s read, which is taken before the operator's verify command and may be `VERIFY_TIMEOUT_MS` old by the time the merge runs — and that window is exactly when a person waiting on the spinner goes back to the checkout. A `git switch` made in it received the run's work under a `landed_into` naming the branch it did not go to; a run promoted into the folder in it was merged underneath; an edit made in it met a squash. So `landRun` asks `landRecheck` after the check, from a fresh `checkoutStateOf` and a fresh `activeRuns()` overlap check, with nothing awaited between that read and the merge's spawn, and it refuses in `landRefusal`'s own sentences. **An ignored file is uncommitted work no status lists**, so the merges carry `--no-overwrite-ignore` and the land past a squash, whose `read-tree -u` cannot refuse, asks `untrackedAt` first. **The undo never runs `reset --hard`.** A squash writes no MERGE_HEAD, so `merge --abort` has nothing to work from, and the old fall-through to `reset --hard HEAD` ran after squashes git had *refused* — which it does precisely because the checkout holds changes the squash would overwrite — destroying every uncommitted edit in the tree while the card said "rolled back". A squash git refused wrote nothing and gets no undo at all, `conflictedFiles` coming back empty being the test; `reset --merge` would be no better there, because it resets a *staged* edit too. One that did write — conflicted, or staged under a commit the operator's hooks refused — is undone with `reset --merge`, which keeps an unstaged edit it did not touch and refuses where the two are tangled in one file, and that refusal is reported as a checkout left part-way rather than as a rollback. **A fast-forward refused at its last step wrote, and nothing git leaves says so.** It puts the branch's tree into the index and the working tree before it moves the target, so another process holding the target's ref lock leaves the whole branch staged with no MERGE_HEAD, and `unwind` reported that as restored. It now asks the status `landRecheck` proved clean in the merge's own turn, and takes anything listed back out with `read-tree -m -u HEAD` — `reset --merge`'s undo without its ref update, since `reset --merge` needs the very lock that refused the merge and exits 1 having already restored the tree — then says the checkout holds the branch's work uncommitted if that did not leave it clean. `landUnwind.test.ts` and `landAfterVerify.test.ts` pin both halves against real repositories. **`--no-overwrite-ignore` is the guard for an ignored file nothing seeds, and its sentence's "move it aside" is only ever about one.** A branch carrying a path the seeding list names is refused before the merge (`seededRefusal`, in `deliver.md`): moving the operator's `.env` aside as `overwriteRefusal` advises was how the operator's own credential reached the target's history.

**One branch, one Land button: the last run on it, and only once nothing behind it can still commit.** Three runs extending each other share a ref, so every one of them would offer to land it — the operator merges the first, the second still reads unmerged because the branch has moved, and the merge queue takes the same branch once per link. `landRefusal` is where that is decided, pure and unit-tested for exactly this, and both refusals **name a run**: a greyed-out button on a page whose whole purpose is getting work merged is a dead end. The owner is the last member that is not terminal without a work cycle, which is `edgeSatisfied`'s rule reused — `ranWorkCycle`, so a cycle the refunds put back still counts — — a dependent blocked because its dependency failed is recorded on the branch and put nothing on it, and letting it own the branch would leave the run that did the work unlandable for ever. `waiting` counts as unsettled here and nowhere else in this app: it holds no folder and no checkout, but it is a declared future commit on this exact ref. `deleteBranch`, `purgeRefusal` and `resolveConflicts` take the same test through `chainBlocker`, because all three were written when "this run's branch" picked out a branch and a chain is what stopped that being true — the first two would destroy the starting point of a run that has not begun, and the third would pay for a resolution against a branch another run is about to move. `branchInventory` collapses to the owner for the same reason and not merely to tidy the page: that table keys its rows on the branch, so a three-link chain was three rows with one React key, three Land checkboxes and identical counts, and picking two of them queued one branch twice. It is deliberately the only place here that *groups* a chain by `worktree_branch` rather than by `continues_run`, so a `waiting` link — which has no branch yet — is invisible to it and a row can read landable while a run is queued up behind it. That is `canLand`'s existing approximation, and `landRun` re-derives the whole verdict from git and the full chain before anything merges. Which member of that group owns it is still read off `continues_run`, and has to be: the runs arrive `created_at DESC`, a chain is created in a single synchronous pass, and two links sharing a millisecond then come back in whatever order the sort settled on — the same collision `nextQueuedIn` needed `batch_id` for, except that here no tiebreak would do, because the true order *is* the links. Taking the arrival order as the chain's put the wrong link on the page, and the row it kept then refused to land while naming an owner it had never listed, which leaves committed work with no route in the UI that reaches it at all.

**A branch a live pass of a workflow loop is working on may be landed by that pass's own merge block and by nothing else, and every other refusal names the pass.** `chainBlocker` answers "can another run that already exists still commit to this ref", which used to be the whole of the question and used to miss a loop: between one pass reaching a terminal status and the next being created there was no unsettled member on the branch at all, so every door read the chain as finished and acted on a ref that was about to move. The ground has changed and the refusal has to be read the new way rather than deleted: a pass now **lands its own work** — the section it repeats ends in a merge block, and that block is what puts the pass's branches onto their target — so what is being protected is not a run that does not exist yet but a landing that has not happened. While a pass is live its branches belong to it: landing one by hand takes the work out from under the merge block that was going to land it, deleting or purging one destroys work the pass is not finished with, and either way the loop's own reading of whether that pass landed everything is decided by something the operator did behind it. `loopStillRepeating` matches on the **member id prefix** rather than on `emitted_by`, because the runs a pass's orchestrator member decided on are named under that member rather than under the loop, and it reads the pass number back out of that id so the sentence can say *which* pass holds the branch — a loop may have taken a dozen. It reads the tables directly rather than calling `workflows.ts`, which imports `mergeQueue.ts`, which imports this file; `passIds.ts` is the one thing the two share and it imports nothing at all, which is what keeps the format from being written in one file and parsed in another. **And the pass's own merge block comes through those same doors**, which is what the `asker` argument is for: that block only ever runs while its loop is `looping` — the loop is not settled until the pass is — so a refusal that could not see who was asking fired against the one mechanism it exists to protect, refused every branch of the pass, and stopped the loop on the rule that a pass which did not land everything stops the loop; the operator was told to stop the workflow so that the branch could be landed by the merge block of the workflow they had just been told to stop. The asker is **recorded, never inferred**: it is a `merge_queue` batch id, and `workflow_instance_blocks.merge_batch_id` ties that batch back to the block that queued it — which for a pass is a row whose `node_id` carries its loop and its pass. Nothing about timing, and nothing about the absence of another explanation, may stand in for it. `startMergeBlock` therefore mints the batch id itself and writes the tie **before** calling `enqueue`, because `enqueue` starts the worker and a row drained before the tie exists is refused by the guard the tie is there to lift. The exemption is the owning pass alone — same instance, same loop node, same pass number — so a later pass of the same loop and another loop's merge block are refused with the sentence a person gets, and it is **one function asked by all four doors** rather than an exemption written into each: four call sites agreeing about a question none of them could ask completely is how this got in.

**The check in front of Land, and what an empty one means.** Every other
condition Land enforces is about the *checkout* — clean, on target, nobody
working in it. `landVerifyCommand` is the only one about the **work**: set it
and a non-zero exit refuses the land, leave it empty and Land behaves exactly
as it did before the field existed. An empty command is not a check that
passed, and neither is one that could not be parsed — `landGate.landVerdict`
returns `passed: false` for a malformed command precisely because the operator
asked for a gate, and handing them an open door because their string was wrong
is the failure the field exists to prevent. It is argv and never a shell line:
`parseVerifyCommand` refuses shell metacharacters rather than escaping them,
for the reason `security.md` gives about spawn argv generally. It runs as the
child uid, before anything merges — a failing check on an already-merged branch
is a report, and what was asked for was a refusal. Its bound is its own:
`VERIFY_TIMEOUT_MS`, fifteen minutes, ends the command's whole process group —
it is spawned `detached` for that — and the refusal says it did not finish and
was killed after that long. `runVerify` settles on the child's `exit` plus a
two-second drain rather than on `close`, which waits for every process holding
the pipes: a hung grandchild of `npm test` used to hold Land and Deliver past
the timeout for as long as it hung, with the folder's `landing` claim held, so
nothing could land into that checkout until a restart. The group is killed after
every exit, a pass included, so nothing the check started outlives it in the
tree about to be merged. This is not the clock `landing-timeouts.md` forbids:
nothing has merged, the refusal rolls nothing back, and its sentence says the
check ran out of time rather than that the work is bad.

**Which tree the check runs in is the whole of whether it checks anything.**
`verifyTree` resolves the **run's own** worktree slot, never `state.checkout`:
that one is the *operator's*, and `landRefusal` has already required it to be
clean and standing on the target — so a check run there tests the branch the
work is about to be merged into and never sees the work, passing or failing
identically whatever the agent wrote, with nothing on either side visible. When
the slot no longer holds the run's branch because a later run took it over,
this **refuses** rather than falling back — and a slot stopped mid-rebase or
mid-bisect of the branch, which reads as holding none, is refused naming that. It does not cut a fresh worktree,
for the reason `resolveConflicts` records when it hands a temporary checkout
`resolveAllowedTools: []`: a slot cut from bare git has no `node_modules` and no
build output, so `npm test` there fails for a reason that is not the work, and
a gate that reported a missing dependency tree as "your branch is bad" would be
worse than no gate because an operator would believe it. Resolving the tree at
all is gated on the command being set, so an install that configures none pays
nothing. **The tree must also be the one the land
carries.** The command runs against the files on disk and the land takes only
the commits, so a slot holding uncommitted work is checked as a tree that is
not the one landed — and can pass *because of* the difference, an agent's fix to
a failing test that never got committed being the ordinary case. `landRefusal`
does not catch it: it refuses on uncommitted paths only when the branch has no
commits at all. So `verifyTreeVerdict` refuses while the slot holds any
uncommitted path, naming them and pointing at the card's Commit button, and
refuses a status it could not read rather than reading it as clean; with no
command configured none of this is asked. **And the slot is held for as long as
the command runs.** The run being landed is terminal, so `activeRuns()` alone
let `allocateSlotPath` hand its slot to a run started in the same repository
during the check, which would `checkout -b` underneath the command. The call
goes through `verifyInSlot`, which takes `holdSlot` around `runVerify`:
synchronous, refusing when an active run was given the slot between
`verifyTree`'s read and the hold, and counted so that one release can never end
another's hold. `allocateSlotPath` skips a held slot as it skips an occupied
one. **The hold keeps other runs out, not commits, so what passed is proved to
be what leaves.** A continuation inherits the slot in `planWorkspace` without
`allocateSlotPath`, the card's Commit button writes into it, and both exits act
on the branch by name, so a commit made during the check left unverified.
`verifyInSlot` reads the slot's `HEAD` under the hold before the command and,
after a pass, refuses unless `rev-parse <branch>` still names it — chosen over
making `inheritedSlot` respect the hold, which covers one writer and would mean
refusing a continuation while a land is in flight. A continuation created
mid-check that has not committed, or a run reopened mid-check, leaves the tip
where the check saw it and this run no longer the one that lands the branch,
so `landRun` asks `unsettledBranchRefusal` again from a fresh `getRun` and
`branchChain`, beside `landRecheck` with nothing awaited before the merge's
spawn, as Deliver does. Still open: the milliseconds between the `HEAD`
comparison and the merge's spawn.
