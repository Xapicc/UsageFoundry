# Land, the verify gate and Deliver

[← isolation-and-landing index](../isolation-and-landing.md)

Read before editing `landRun`, `landRefusal`, `unsettledBranchRefusal`, `chainBlocker`, `verifyTree`, `deliverRun`, `deliveredPullRequest` or `deliveryState` in `src/lib/land.ts`, the Deliver route, or `src/lib/landGate.ts`, `src/lib/verifyCommand.ts` or `src/lib/delivery.ts`.

**The tool does now merge, and every protection the old "never merges" rule bought is a check in `land.ts` rather than a caveat.** The operator's checkout must be clean (unreadable counts as dirty, same rule as `emitHandoff`) *and* standing on the recorded target branch — landing onto the wrong branch is the one mistake here with no undo, so it is refused by name rather than caveated. An active run's branch is never landable: `running`/`queued`/`paused` can commit again, and the base that merges cleanly now will not be the base in ten minutes. A failed merge is aborted immediately and the conflicting files reported, so a half-merged index never survives the request. `landRefusal` is pure and unit-tested for exactly these branches, because it is the decision that writes into a directory a person also works in. **The checkout half is proved twice, and the second proof is the one the merge stands on.** `landRefusal` answers from `landState`'s read, which is taken before the operator's verify command and may be `VERIFY_TIMEOUT_MS` old by the time the merge runs — and that window is exactly when a person waiting on the spinner goes back to the checkout. A `git switch` made in it received the run's work under a `landed_into` naming the branch it did not go to; a run promoted into the folder in it was merged underneath; an edit made in it met a squash. So `landRun` asks `landRecheck` after the check, from a fresh `checkoutStateOf` and a fresh `activeRuns()` overlap check, with nothing awaited between that read and the merge's spawn, and it refuses in `landRefusal`'s own sentences. **An ignored file is uncommitted work no status lists**, so the merges carry `--no-overwrite-ignore` and the land past a squash, whose `read-tree -u` cannot refuse, asks `untrackedAt` first. **The undo never runs `reset --hard`.** A squash writes no MERGE_HEAD, so `merge --abort` has nothing to work from, and the old fall-through to `reset --hard HEAD` ran after squashes git had *refused* — which it does precisely because the checkout holds changes the squash would overwrite — destroying every uncommitted edit in the tree while the card said "rolled back". A squash git refused wrote nothing and gets no undo at all, `conflictedFiles` coming back empty being the test; `reset --merge` would be no better there, because it resets a *staged* edit too. One that did write — conflicted, or staged under a commit the operator's hooks refused — is undone with `reset --merge`, which keeps an unstaged edit it did not touch and refuses where the two are tangled in one file, and that refusal is reported as a checkout left part-way rather than as a rollback. `landUnwind.test.ts` and `landAfterVerify.test.ts` pin both halves against real repositories.

**One branch, one Land button: the last run on it, and only once nothing behind it can still commit.** Three runs extending each other share a ref, so every one of them would offer to land it — the operator merges the first, the second still reads unmerged because the branch has moved, and the merge queue takes the same branch once per link. `landRefusal` is where that is decided, pure and unit-tested for exactly this, and both refusals **name a run**: a greyed-out button on a page whose whole purpose is getting work merged is a dead end. The owner is the last member that is not terminal-with-zero-cycles, which is `edgeSatisfied`'s rule reused — a dependent blocked because its dependency failed is recorded on the branch and put nothing on it, and letting it own the branch would leave the run that did the work unlandable for ever. `waiting` counts as unsettled here and nowhere else in this app: it holds no folder and no checkout, but it is a declared future commit on this exact ref. `deleteBranch`, `purgeRefusal` and `resolveConflicts` take the same test through `chainBlocker`, because all three were written when "this run's branch" picked out a branch and a chain is what stopped that being true — the first two would destroy the starting point of a run that has not begun, and the third would pay for a resolution against a branch another run is about to move. `branchInventory` collapses to the owner for the same reason and not merely to tidy the page: that table keys its rows on the branch, so a three-link chain was three rows with one React key, three Land checkboxes and identical counts, and picking two of them queued one branch twice. It is deliberately the only place here that *groups* a chain by `worktree_branch` rather than by `continues_run`, so a `waiting` link — which has no branch yet — is invisible to it and a row can read landable while a run is queued up behind it. That is `canLand`'s existing approximation, and `landRun` re-derives the whole verdict from git and the full chain before anything merges. Which member of that group owns it is still read off `continues_run`, and has to be: the runs arrive `created_at DESC`, a chain is created in a single synchronous pass, and two links sharing a millisecond then come back in whatever order the sort settled on — the same collision `nextQueuedIn` needed `batch_id` for, except that here no tiebreak would do, because the true order *is* the links. Taking the arrival order as the chain's put the wrong link on the page, and the row it kept then refused to land while naming an owner it had never listed, which leaves committed work with no route in the UI that reaches it at all.

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

**The other exit.** `deliverRun` pushes a run's branch and opens a pull request
on the checkout's GitHub remote. It is reached from one endpoint on one press
and from nothing in the run loop: an outward-facing action taken by a loop is a
different product from one taken by a person. It never force-pushes, it runs
the same verify gate Land does against the same `verifyTree` — an operator who
said "not unless this passes" has said nothing about which exit the work leaves
by — and with no token for the repository it refuses, which is the honest
default for a feature that publishes. **The credential is passed explicitly and
is the only git call in this app that carries one.** `gitEnv()` strips the whole
`UF_` namespace, so `git()` reaches every remote unauthenticated by default and
that withholding is deliberate — `githubEnv`'s docstring gives the reason, which
is that a git child is the one child here that executes repository-controlled
code. `deliverRun` hands it back through `git()`'s `env` option, which exists
for this one caller; without it the push fails against an https GitHub remote
with a `GIT_TERMINAL_PROMPT=0` authentication error naming nothing an operator
could fix. *Which* token is `githubTokenFor(repo_root ?? folder)` — the
repository's, not the checkout's, on the run loop's own rule — and the same one
opens the pull request, so a repository configured to get none refuses at
`planDelivery` instead of publishing as the install. The run's timeline carries it as `deliver`, beside `land`:
`land` is work entering the operator's own checkout, `deliver` is it leaving
the machine. **It takes the `landing` claim and the `activeRuns()` overlap
check**, which it arrived without: it resolves the *same* folder `landRun`
guards — the operator's checkout — and then writes that checkout's
`.git/config` with `push --set-upstream`, so a delivery racing a land is the
collision the claim exists to stop. That was survivable while nothing could
press it and stopped being when the Land card grew a button. **A shutdown
gates and waits for it as it does Land**: `isShuttingDown()` is read after
`landState` and again where nothing awaits before the push, and `trackLand`
holds it from the claim to the row write, because an exit between the push and
that write published a branch with no pull request and no record. Nothing reads
the flag after the push, where refusing would leave exactly that.

**Deliver refuses a branch that can still move, in Land's own words.** It
pushed the branch of a `running`, `queued` or `paused` run, of a chain link with
a successor still to commit, and of a live loop pass, and opened a pull request
on part of the work: its only guards were the folder overlap and the `landing`
claim, and an isolated run works in `.uf-worktrees`, which overlaps nothing.
`unsettledBranchRefusal` is the run half of `landRefusal` (active status, loop
pass, chain owner, chain successor) split out and asked by both exits, so the
two doors cannot drift; the words change with the exit and the decision does
not, and `land.test.ts` pins that Land's answer is still exactly it.
`deliverRun` asks it before any git runs, from a fresh read of the run and its
chain, and asks again after the verify gate with nothing awaited before the
push, because a check can run for `VERIFY_TIMEOUT_MS`. Deliver asks as a
person, `null` for the asker, since nothing in the run loop reaches it. **And
the body is checked before anything runs**: the route cast it, so `null` or
`{"title": 5}` threw at `.trim()` after `git push` had published the branch,
answered 500 and wrote no record. It now goes through `readJsonObject` and
`readDeliveryFields`, and a malformed one is a 400 with nothing pushed; `{}` is
the ordinary press, and an empty body is refused like any other unparseable one.

**The Land card offers it once, and states every refusal instead of discovering
one.** `deliveryState` answers the card from `planDelivery` and
`unsettledBranchRefusal`, the two the press asks, so the button and the endpoint
cannot disagree about whether delivery is possible or about why it is not. Its
reasons are standing conditions of the install (no credential for this
repository, a remote that is not GitHub, a branch that is already the target)
or a branch something can still commit to, never something only a press would
find out. What it does *not* pre-empt is the verify gate and the push, which are
about the branch now. Offered once per pull request, and replaced afterwards by
a link to it: a second press would push again, updating the pull request, and
then be refused by GitHub's "already exists", so what it reported and what it
did would disagree. **The link is read off the run's row, per branch, and never
off the `deliver` event.** The event was the only record, and it failed both
ways: `sweepRunEvents` deletes a settled run's events after
`eventRetentionDays`, after which the card offered the press again, and it was
kept per run while a chain's links share one ref, so a pull request opened from
one link was invisible on the card of the link that carried the branch on.
`deliverRun` writes `runs.delivered_pr_url`/`delivered_pr_number`/`delivered_at`
beside the event, the row being permanent on `retention.md`'s rule, and
`deliveredPullRequest` takes the newest across every run with the same
`repo_root` and `worktree_branch`. The migration that added the columns
backfilled them once from each run's newest readable `deliver` event, so a run
delivered before it keeps its link past the next sweep. **The whole path has been driven
against a real repository once**, which is what makes the paragraph above a
record rather than an intention: the refusal before a remote existed, the offer
once one did, one press pushing the branch and opening the pull request, the
button withdrawing in favour of the link, and the honest 400 on a second press.
`docs/verification.md` has the account and the three things it does not
establish.
