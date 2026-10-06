# Deliver, and what may leave

[← isolation-and-landing index](../isolation-and-landing.md)

Read before editing `deliverRun`, `deliveredPullRequest`, `deliveryState`, `seededOnBranch` or `seededRefusal` in `src/lib/land.ts`, the Deliver route, or `src/lib/delivery.ts`. Split out of `land-verify-and-deliver.md` on 2026-10-06; the verify gate Deliver shares with Land is there.

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

**A branch whose history carries a file seeding copied in leaves by neither exit.** `seedWorktree` puts the operator's own gitignored configuration into the run's checkout, `.env` by default and usually real credentials, and nothing in the checkout stops it being committed: `git add -f` is git's own hint when `add` meets an ignored path, and the `add -A` of the agent and of `commitPending` stages one the repository does not ignore. Measured on 2026-10-06 in `deliverRun.test.ts`' harness: with the seeded `.env` committed, `deliveryState` offered the button and `deliverRun` pushed the operator's key; `landRun` refused only because the operator's copy was in the way, and landed it into `main` once that copy was moved aside, as `overwriteRefusal` advised. `seededOnBranch` lists every path a commit between the target and the tip writes — history rather than the tip's tree, because a later commit deleting the file still pushes the one that added it, and a merge read against its first parent — keeps those the repository's seeding list names (`copyGlobsFor`, the same choice `seedWorktree` makes), and drops those the target or the chain's base tracks, since seeding copies only what a checkout lacks and a tracked `.env.development` is the repository's own. `landState` carries it as `seeded`, like `certification`, because Deliver does not read `blocked`; `seededRefusal` turns it into one sentence per exit, ahead of the certification gate because taking the file out rewrites the tip a review would approve. Both exits ask again of the tip they act on: `landRun` after its check, and `pushAndOpen` after its check with nothing awaited before the push, because the card's Commit button can put one on the branch while the check runs. The merge queue fails a conflicting row carrying one instead of buying a resolution `landRun` would refuse anyway. Unreadable refuses, but a base commit that no longer exists is skipped and a tree that cannot be listed subtracts nothing, because both can only make it refuse more and refusing on them would leave the run no way out. The list is Settings as they are now, not what was copied at the time, which only a swept log line records: an operator who takes a file off the list has said it is not private, and that is the sentence's second way out. **It checks names, never contents**, so a credential an agent pastes into some other file goes unseen — and a work cycle holds `UF_GITHUB_TOKEN` and can push for itself, which no exit of this app's stands in front of (`docs/security.md`).
