# Deliver, and what may leave

[← isolation-and-landing index](../isolation-and-landing.md)

Read before editing `deliverRun`, `deliveredPullRequest`, `deliveryState`, `seededOnBranch` or `seededRefusal` in `src/lib/land.ts`, the Deliver route, or `src/lib/delivery.ts`. Split out of `land-verify-and-deliver.md` on 2026-10-06; the verify gate Deliver shares with Land is there.

**The other exit.** `deliverRun` pushes a run's branch and opens a pull request
on the checkout's GitHub remote. It is reached from one endpoint on one press
and from a workflow's deliver block (below), and from nothing in the run loop:
an outward-facing action taken by a loop is a different product from one taken
by a person, and the block is the person's decision taken earlier, when they
saved the graph and pressed Run on it. It never force-pushes, it runs
the same verify gate Land does against the same `verifyRunBranch` — an operator who
said "not unless this passes" has said nothing about which exit the work leaves
by — and with no token for the repository it refuses, which is the honest
default for a feature that publishes. **The credential is passed explicitly, to
this call and to the project view's `ls-remote`, push and fetch, and to no other
git this app runs** ([projects-push-and-fetch.md](projects-push-and-fetch.md)). `gitEnv()` strips the whole
`UF_` namespace, so `git()` reaches every remote unauthenticated by default and
that withholding is deliberate — `githubEnv`'s docstring gives the reason, which
is that a git child is the one child here that executes repository-controlled
code. `deliverRun` hands it back through `git()`'s `env` option, which exists
for these callers; without it the push fails against an https GitHub remote
with a `GIT_TERMINAL_PROMPT=0` authentication error naming nothing an operator
could fix. *Which* token is `githubTokenFor(repo_root ?? folder)` — the
repository's, not the checkout's, on the run loop's own rule — and the same one
opens the pull request, so a repository configured to get none refuses at
`planDelivery` instead of publishing as the install. The run's timeline carries it as `deliver`, beside `land`:
`land` is work entering the operator's own checkout, `deliver` is it leaving
the machine. **It takes the `landing` claim and the `activeRuns()` overlap
check**, which it arrived without: it resolves the *same* folder `landRun`
guards — the operator's checkout — and then writes that checkout's
`.git/config` with the upstream it sets after the push, so a delivery racing a land is the
collision the claim exists to stop. That was survivable while nothing could
press it and stopped being when the Land card grew a button. **A shutdown
gates and waits for it as it does Land**: `isShuttingDown()` is read after
`landState` and again where nothing awaits before the push, and `trackLand`
holds it from the claim to the row write, because an exit between the push and
that write published a branch with no pull request and no record. Nothing reads
the flag after the push, where refusing would leave exactly that.

**Deliver decides on every URL its push goes to, never on the fetch URL, and reads them again after the verify gate.** `planDelivery` is handed `git remote get-url --push --all --end-of-options origin`, read under `githubEnv`'s rewrites with a placeholder token (`originPushUrls`, which is `projects.ts`' `urlReadEnv` restated, because that module imports this one), and requires exactly one URL, starting `https://` and read by `parseRemote` as GitHub. It used to be handed `git remote get-url origin`, the first *fetch* URL, which ignores `remote.origin.pushurl`, `url.<base>.pushInsteadOf` and a second `remote.origin.url`; all three live in `.git/config`, which a work cycle can write, and measured on 2026-10-17 in `deliverRun.test.ts`' harness the card offered each and the press pushed the branch to the other repository and opened a pull request, while a `pushInsteadOf` to `git@github.com:` ran the repository's `core.sshCommand` in the push's environment, which carries the token. The `https://` test is load-bearing beside `parseRemote`, which still reads both SSH spellings: once `githubEnv`'s rewrites are applied an SSH URL left standing is one a `pushInsteadOf` put there, and git runs `core.sshCommand` for it. `parseRemote`'s https pattern no longer takes `http://`. **The second read is after the verify command**, the last await before the push but the seeded-file read, because the command is the branch's own code run in a worktree that shares the checkout's `.git/config`, and a rewrite it planted there was pushed through; the pull request is opened on the repository that read names. A write in the milliseconds between that read and the push's spawn is not caught, and no read can catch it. What neither read covers is the repository's `http.proxy`, `http.sslVerify` and `http.sslCAInfo`, which still apply to the https push and between them can route it through a host that reads the token (`docs/security.md`).

**A workflow's deliver block is the second caller, and it asks nothing the button does not.** `startDeliverBlock` in `workflows.ts` calls `deliverRun` once per branch, one after another, and keeps none of its decisions: the verify gate, the seeded-file refusal, the certification gate, the per-repository token, the `landing` claim and the shutdown gate are all `deliverRun`'s, so the block reaches no remote the button could not. The one thing the block adds is its halt latch, passed as `stillWanted` and asked beside both shutdown reads, so a workflow stopped while a branch is in its verify command pushes nothing (`workflows-and-schedules/merge-and-deliver-blocks.md`); the button passes none. `deliverHold` still asks as a person — `null` for the asker — because a pass of a loop never reaches Deliver: a deliver block is refused inside a loop section at save. **Neither exit's refusals about the operator's checkout apply to it.** `deliverRun` takes from `landState` the branch, the target, `seeded`, `certification` and `checkout.path`, and never `blocked`, which is where `landRefusal` keeps a dirty tree and a checkout on the wrong branch; the only commands it runs in the checkout that write are `push`, which sends objects and moves the remote-tracking ref, and `branch --set-upstream-to`, which writes `.git/config` and nothing else. What it does refuse there is a run working in that folder (`runWorkingIn`) and a delivery or land already holding the claim, which a block meets as a failed branch. The block's side — its outcome, its save-time refusals and the schedule and chat doors it keeps shut — is in `workflows-and-schedules/merge-and-deliver-blocks.md`.

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
person, `null` for the asker, since nothing in the run loop reaches it. **A
branch with a conflict resolution under way is one that can still move**: its
merge commit is about to land on it, so a press pushed the tip before the
resolution and left the pull request without what the operator had just paid a
model for. Measured on 2026-10-16 in `deliverRun.test.ts`' harness, the card
answered `branchResolving: true` and `delivery.possible: true` in one response,
the press pushed and opened the pull request, and when the merge then committed
the remote stayed behind it while the card read Delivered. `resolutionHolds`
(the checkout claim a resolution holds, then its `running` row) is asked in
`commitRefusal`'s words from `deliveryState`, ahead of `landState` in
`deliverRun`, and beside the second `deliverHoldNow` with nothing awaited before
the push, and the card's `canDeliver` requires `!resolving`. The first read
is the one that spares the verify gate, which runs the branch's own code for up
to `VERIFY_TIMEOUT_MS`: the second would refuse in the same words after it, so
a verify command that leaves a mark is what pins the first. **Deliver reads the
claim and does not hold it**, unlike Commit and Purge
([conflicts-and-resolution.md](conflicts-and-resolution.md)): it writes nothing in the run's
checkout, and a resolution that starts after the last read finds the tip already
pushed and commits on top of it, which is the moved branch below. **And
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
repository, a remote that is not GitHub — named by its push URL through
`redactUrl`, since the sentence reaches the card and the route's body and a
`pushurl` can carry a token — a branch that is already the target)
or a branch something can still commit to, never something only a press would
find out. What it does *not* pre-empt is the verify gate and the push, which are
about the branch now. Opened once per pull request, and replaced afterwards by
a link to it: a second open would be refused by GitHub's "already exists", so
what it reported and what it did would disagree. **A branch that has moved since
its last push is offered the push alone.** That reasoning is about the report of
a second *open* and says nothing of a tip that moved after the push, which is
the follow-up an operator starts to answer review comments: it commits on the
same ref. Measured on 2026-10-16 in the same harness, the follow-up's card read
`delivered: {#41}` with the remote still at the first run's tip and nothing to
press, and a deliver block skipped the branch on the same read and passed with
the new work unpublished. `runs.delivered_tip` records the tip each push to the
pull request carried, written with the link and again by a push-only update, and
`branchMovedSincePush` compares it with `refs/heads/<branch>`.
`deliveryState` carries the answer as `movedSincePush`, asked whether or not a
press is possible, so a refused card does not say Delivered of a moved branch
either. When it is true the card reads "Opened … — pull request #N, behind this
branch" and offers **Push to pull request #N**; `pushAndOpen` pushes, opens
nothing, returns the existing address, writes the new tip on the row that holds
the link, and puts a `deliver` event with `updated: true` on the run that
pressed. A branch at the pushed tip is unchanged: the link only, and a route
press still meets GitHub's refusal. **The record, and not
`refs/remotes/origin/<branch>`**, which needs no column and was the other
candidate: that ref moves with any `git fetch` of the operator's checkout and is
deleted by `fetch --prune` once GitHub removes a merged pull request's branch,
so a merged and cleaned-up pull request would read as a branch with a push
waiting, whose press recreates the remote branch it was deleted from. **A row
delivered before the column holds null and reads as not moved**: the `deliver`
event carries the address and not the commit, so nothing says what such a press
pushed, and a button offered on a guess is a push. **The link is read off the run's row, per branch, and never
off the `deliver` event.** The event was the only record, and it failed both
ways: `sweepRunEvents` deletes a settled run's events after
`eventRetentionDays`, after which the card offered the press again, and it was
kept per run while a chain's links share one ref, so a pull request opened from
one link was invisible on the card of the link that carried the branch on.
`deliverRun` writes `runs.delivered_pr_url`/`delivered_pr_number`/`delivered_at`
beside the event, the row being permanent on `retention/design.md`'s rule, and
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

**A branch whose history carries a file seeding copied in leaves by neither exit, and the handoff card offers no merge command for it.** `seedWorktree` puts the operator's own gitignored configuration into the run's checkout, `.env` by default and usually real credentials, and nothing in the checkout stops it being committed: `git add -f` is git's own hint when `add` meets an ignored path, and the `add -A` of the agent and of `commitPending` stages one the repository does not ignore. Measured on 2026-10-06 in `deliverRun.test.ts`' harness: with the seeded `.env` committed, `deliveryState` offered the button and `deliverRun` pushed the operator's key; `landRun` refused only because the operator's copy was in the way, and landed it into `main` once that copy was moved aside, as `overwriteRefusal` advised. `seededOnBranch` lists every path a commit between the exit's reference and the tip writes — history rather than the tip's tree, because a later commit deleting the file still pushes the one that added it, and a merge read against its first parent — keeps those the repository's seeding list names (`copyGlobsFor`, the same choice `seedWorktree` makes), and drops those the reference or the chain's base tracks, since seeding copies only what a checkout lacks and a tracked `.env.development` is the repository's own. **The reference differs by exit, and for Deliver it is the remote's copy of the target, `refs/remotes/origin/<target>` as last fetched, never the local one.** Land merges into the local target, so what that holds is where the commits go; a push publishes what the remote lacks, and a local `main` that merged the branch by hand and then untracked the file holds the commit adding it with nothing published. Measured on 2026-10-20 in `deliverRun.test.ts`' harness: measured from the local target such a branch read as carrying nothing, the card offered Deliver and the press pushed it with the key in its history. A remote-tracking ref never fetched is skipped, which excludes less and refuses more. `landState` carries Land's read as `seeded`, like `certification`, because Deliver does not read `blocked`; Deliver asks its own, `seededForDeliver`, at the card and at the press, so the poll that feeds the Land card does not pay for it. `seededRefusal` turns either into one sentence per exit, ahead of the certification gate because taking the file out rewrites the tip a review would approve. Both exits ask again of the commit they act on, after their check, because the card's Commit button can put one on the branch while the check runs. **And both act on that SHA, never the branch's name** (`land-verify-and-deliver.md`): by name, a `.env` committed between the question and the spawn got past `seededRefusal`, into the target for a merge and onto the remote for a push. `pushAndOpen` takes the SHA the verify command ran on (`VerifyOutcome.commit`, which `verifyHeldSlot` proved the branch still named), or reads the branch once when no command is set; asks `seededOnBranch` of it; and pushes `<sha>:refs/heads/<head>`, so the remote receives exactly what was checked and a commit that arrives later stays on the local branch for the next press (`deliverMovedBranch.test.ts`, 2026-10-20: with a `.env` committed as the push was spawned the remote received it). A SHA source makes git ignore `--set-upstream` without a word, so the upstream the flag used to leave in `.git/config` is set by `branch --set-upstream-to` after the push, best effort and never a verdict, since the branch is already published. What a card reads when the local branch is then ahead of the remote is `deliveredPullRequest`'s, not decided here. The handoff card is a third door, and the one walked through by hand: `emitHandoff` published a copyable `git merge --no-overwrite-ignore <branch>` whenever the operator's checkout was clean, git refused it only because the operator's ignored `.env` was in the way, and moving that aside merged it — measured in the same harness on 2026-10-06, the forced `.env` got the command. `handoffSeededRefusal` now withholds it in the land sentence, reaching `land.ts` by a dynamic import because `land.ts` imports the orchestrator. It reads against the branch the operator's checkout has out, since that is what the command merges into, and the run's recorded target when the checkout is detached; with neither it refuses rather than guess. It is asked ahead of the dirty checkout, because the card is written once and never read again, and an operator told only to commit their changes would then merge the file in. The merge queue fails a conflicting row carrying one instead of buying a resolution `landRun` would refuse anyway, and the Land card's Resolve declines it the same way: `landState` carries `seededRefusal`'s land sentence as `resolveBlocked` beside a conflict, `startResolution` refuses on it before `assistRefusal` or any checkout is touched, and the card withholds the button and puts the sentence after the conflict on its state line — taking the file out rewrites the history a resolution is bought against, so one bought first is paid for nothing. Unreadable refuses, but a base commit that no longer exists is skipped and a tree that cannot be listed subtracts nothing, because both can only make it refuse more and refusing on them would leave the run no way out. The list is Settings as they are now, not what was copied at the time, which only a swept log line records: an operator who takes a file off the list has said it is not private, and that is the sentence's second way out. **It checks names, never contents**, so a credential an agent pastes into some other file goes unseen — and a work cycle holds `UF_GITHUB_TOKEN` and can push for itself, which no exit of this app's stands in front of (`docs/security.md`).
