# Missing features

Seven candidates, judged the way the brief asked: **what can the operator not do
today, and what does that cost them.** Nothing here is polish. Every one is a
capability the product does not have at all. The seventh is the one whose
operator is the next agent editing this repository rather than the person
running it, and it is filed here on
[M4](#m4-nothing-verifies-a-branch-before-it-is-merged)'s grounds: something is
trusted before it is used and nothing establishes that it is true.

Two of the six are argued down inside their own sections — [M3](#m3-nothing-this-app-runs-can-reach-a-human-and-most-of-that-is-on-purpose) because the
product has a documented position that covers most of it, and [M6](#m6-a-credential-cannot-be-rotated-without-a-restart-and-a-restart-ends-live-runs) because
the alternative is worse than it first looks. They stay in the file because the
honest form of "we do not need this" is the argument, not the omission.

> **Re-checked against `main` at `66fdbab`.** Three of the six moved.
> [M3](#m3-nothing-this-app-runs-can-reach-a-human-and-most-of-that-is-on-purpose) is **closed whole** — `src/lib/notify.ts` posts a signed
> JSON body to an operator-named URL when a run ends needing somebody — and it is
> the one row on this axis whose absence claim is now simply false.
> [M1](#m1-the-app-can-push-nothing-and-open-no-pull-request) and [M5](#m5-nothing-can-be-prioritised-the-queue-is-strictly-oldest-first) are still half, and their missing halves are
> the same missing half: no control on any page.
> [M4](#m4-nothing-verifies-a-branch-before-it-is-merged) is still half for the same reason.
> [M2](#m2-one-credential-no-identity-no-authorisation) and [M6](#m6-a-credential-cannot-be-rotated-without-a-restart-and-a-restart-ends-live-runs) are untouched.
>
> **The fourth pass, 2026-09-06, added [M7](#m7--nothing-checks-a-completeness-claim-and-docsagent-is-built-out-of-them)**, from the closed issues rather
> than from the tree. It is the register's only row whose evidence is a closed
> issue whose defect is back.

---

## M1 — The app can push nothing and open no pull request

> **Shipped in half.** `main` at `d1d3119`, out of PR #214 and the correction
> that followed it. `deliverRun` (`src/lib/land.ts`) pushes the run's branch to
> the checkout's `origin` and opens a pull request through
> `openPullRequest`/`planDelivery` (`src/lib/delivery.ts`), reached from
> `POST /api/runs/:id/deliver` and from nothing in the run loop. Never
> `--force`, refuses when the repository has no credential, runs the same
> `landVerifyCommand` gate Land does, and writes a `deliver` event on the run's
> timeline beside `land`.
>
> **The credential was the correction, and it is this row's own evidence
> turning up as a bug.** The merged version pushed through `git()`, whose
> `gitEnv()` deletes the whole `UF_` namespace — deliberately, because a git
> child is the one child here that runs repository-controlled code — so the
> push reached GitHub unauthenticated and, with `GIT_TERMINAL_PROMPT=0`, failed
> naming nothing an operator could fix. `git()` now takes an `env` option for
> this one caller, and the token is `githubTokenFor`'s answer off the
> repository, so a repository configured to get none refuses rather than
> publishing as the install.
>
> **Half, and the missing half is the one this row cared about.** There is no
> button: delivery is reachable only by hand against the endpoint. And **no
> pull request has ever been opened by it** — the push and the API call are
> covered by unit tests and by their refusal paths, never end to end against
> GitHub. The row's demand was marked **assumed** when it was written, and
> shipping a mechanism nobody has yet pressed does not settle that.
>
> **Re-checked at `66fdbab`, still half.** `deliverRun` is
> `src/lib/land.ts:2901`, `planDelivery` and `openPullRequest` are
> `src/lib/delivery.ts:79` and `:140`, the endpoint is
> `src/app/api/runs/[id]/deliver/route.ts`, and the credential fix is on the line:
> the push takes `githubEnv(github.token)` explicitly at `:2958-2962` because
> `gitEnv()` strips the `UF_` namespace. `grep -rn "deliver" src/app --include=*.tsx
> src/components --include=*.tsx` returns **nothing**, so there is still no
> button. Whether a real pull request has been opened since is **assumed
> unchanged and unverifiable from here**: `DATA_DIR` is unreadable by this uid, so
> no `deliver` event on any run's timeline can be read.
>
> **One thing the merge left behind.** `src/lib/delivery.ts:11-12` opens by
> stating that "`grep` over `src/` for `git push`, `gh pr create` and
> `createPullRequest` returns prose only" — which was this row's evidence, and
> which the file it is written in falsifies.

An agent finishes. Its branch is a local `uf/*` ref. The operator's route to
getting that work anywhere is **Land**, which is a merge into their own checkout
on the recorded target branch (`src/lib/land.ts:947-1057`), guarded by
`checkoutStateOf` requiring the checkout to be clean and standing on the target
(`:414-426`, and `docs/agent/isolation-and-landing.md`).

There is no other exit. `grep` over `src/` for `git push`, `gh pr create`,
`pull request` and `createPullRequest` returns three hits and all three are
prose:

- `src/lib/config.ts:322` — a docblock describing what the *agent's* token is
  for: *"it is the agent's `git push`, `gh pr create` and `gh issue view`"*.
  Unmoved at `66fdbab`.
- `src/lib/orchestrator.ts:6014` — the same, in the argv reasoning. At `66fdbab`
  it is `:5670`.
- `src/lib/chat.ts:2092` — the chat's system text telling the model it may read
  *"pull requests and CI logs with `gh`"*. At `66fdbab` it is `:2779`.

At `66fdbab` the same grep also returns `src/lib/delivery.ts` and
`src/lib/land.ts:2958-2962`, which are the mechanism rather than prose. The
count of three was true when it was taken.

So the capability exists **inside** a run, as something the agent might do with
a shell if the task text asks it to and `UF_GITHUB_TOKEN` is present. It does
not exist as something the app does, tracks, or shows. Nothing in `runs` records
a PR; nothing in the branches page links one; a run whose agent opened a PR is
indistinguishable from one that did not.

**What it costs.** Three things, and the third is structural:

1. **A team whose review gate is a pull request cannot use Land at all.** The
   product's entire finishing move assumes the operator merges to their own
   working copy, which is a solo workflow.
2. **The operator's checkout becomes a required, serialised resource.** Landing
   refuses if it is dirty, if it is on the wrong branch, or if a run is working
   in it (`src/lib/land.ts:963-978`). A fleet of twenty runs converges on one
   directory that a human is probably also using.
3. **Work is stranded on the machine.** Until a land, the output of every run
   exists only in one container's filesystem, and
   `docs/agent/isolation-and-landing.md` records that isolation being *used up*
   throws rather than degrading.

**Confidence: high** that the capability is absent — three greps, three prose
hits. **Assumed:** that operators want it. No operator was consulted and no run
history was readable. That assumption is what a survey would test first, and it
is the reason this row is ranked on cost rather than on demand.

**Owned by:** nothing. Read #99 first; it is open and touches the same surface.

---

## M2 — One credential, no identity, no authorisation

> **Open at `66fdbab`, unchanged, and at the same lines.** `AUTH_TOKEN` is still
> a module-level `optionalEnv` at `src/lib/config.ts:286`, `request_log.actor`
> still records only how a caller authenticated (`src/lib/requestLog.ts:28-31,
> :53`), and no role, scope or second credential was added. What did arrive since
> the survey is more surface behind the one token, not less: `/api/codex-auth`
> and `/api/claude-auth` now sign the container's CLIs in, and both are reachable
> with the same `UF_AUTH_TOKEN` as everything else.

`src/lib/config.ts:286`:

```ts
export const AUTH_TOKEN = optionalEnv("UF_AUTH_TOKEN");
```

That is the model. The session cookie is a handle to that one token
(`src/lib/sessionToken.ts`); `UF_STATUS_TOKEN` is a second, narrower credential
for `/api/status` and nothing else; `middleware.ts` has five documented
exemptions, each paired with the check standing in for it
(`docs/agent/security.md`). Knowing the token is the whole of being allowed in,
and everyone who knows it is the same principal.

Three consequences the operator cannot work around:

- **No read-only access for a colleague.** There is no role, no scope, no second
  credential that sees runs without being able to start, stop, land or change
  settings. The only sharable thing is total control.
- **No revocation of one person.** Rotating `UF_AUTH_TOKEN` logs everyone out
  and requires a restart ([M6](#m6-a-credential-cannot-be-rotated-without-a-restart-and-a-restart-ends-live-runs)).
- **No attributable audit.** `request_log.actor` records *how* a caller
  authenticated and never who (`src/lib/requestLog.ts:28-31, :53`) — see
  [G4](03-growth.md#g4-the-audit-trail-is-20000-rows-deep-evicted-on-every-insert-and-identifies-no-person). It cannot record who, because there is no who.

**What the vault adds, and where it is careful.**
`3 Resources/Software Security/Authentication versus Authorisation.md` makes the
distinction load-bearing rather than pedantic: authentication is one gate you
can get right once, and authorisation is a **per-endpoint coverage problem** —
every handler is a place the predicate can be forgotten, which is why the note
frames complete mediation as the property to aim at rather than a feature to
add. Applied here, that says two useful things at once. The bad news is that
adding roles means auditing every one of the app's route handlers, not adding a
middleware line. The good news is that the current design has *perfect*
coverage of a trivial predicate, so nothing is half-done — there is no partially
enforced authorisation to untangle first.

**What it costs.** The product is single-operator by construction. Every
multi-person use — a team fleet, a reviewer who is not the runner, a monitor
with read access — is out of reach, and the cost of the gap is bounded by
whether that matters, which no evidence here can settle.

**Confidence: high** on the mechanism. **Medium** on the cost, for that reason.

**Owned by:** nothing. #125 is open on the security surface — read it first.

---

## M3 — Nothing this app runs can reach a human, and most of that is on purpose

> **CLOSED WHOLE at `66fdbab`.** This row's central claim is now false, and the
> grep below is the claim: `src/lib/notify.ts` is an outbound channel. One signed
> JSON body is POSTed to one operator-named URL when a run reaches an ending that
> needs a person — `needs-review`, `blocked`, `failed`
> (`NOTIFY_STATUSES` at `:107-111`) — attached as a second sink beside
> `logLifecycle` in `emit()` (`notifyLifecycle` at `:422`), with an HMAC
> `X-UF-Signature` (`signBody` at `:296`), a 5-second timeout (`:301`) and a
> per-attempt row in `webhook_deliveries` (`:322`). A run that simply worked is
> off by default and opt-in through `UF_NOTIFY_ON_SUCCESS`
> (`src/lib/config.ts:505`). Commits `1891ad7` and `0d6af15`; the proposal behind
> it is `proposals/implemented - UnattendedOperation`.
>
> **Two things about it are worth carrying forward rather than filing as new
> rows.** It is **vendor-neutral by argument, not by omission** — the docblock at
> `src/lib/notify.ts:26-36` refuses a format switch and records the consequence,
> that a bare Discord or Slack incoming-webhook URL answers 400 and needs a
> shaping layer in front. And it is **environment-only**: `UF_WEBHOOK_URL`,
> `UF_WEBHOOK_SECRET`, `UF_PUBLIC_URL`, `UF_INSTALL_LABEL` and
> `UF_NOTIFY_ON_SUCCESS` (`src/lib/config.ts:467, :475, :485, :488, :505`) have
> no Settings field on purpose, and the reason is written out at `:450-466`:
> `/api/settings` is reachable with the master key, so a webhook target held in
> `settings.json` would turn one credential into an exfiltration channel aimed
> anywhere the container can reach. That is the opposite of
> [M1](#m1-the-app-can-push-nothing-and-open-no-pull-request), [M4](#m4-nothing-verifies-a-branch-before-it-is-merged) and [M5](#m5-nothing-can-be-prioritised-the-queue-is-strictly-oldest-first), which have no
> field because nobody has built one; here the absence is the design.
>
> **What survives is smaller than a row and is already answered.** A stock
> install still has no channel, because blank is the shipped value — but blank is
> now a decision the operator makes at a shell rather than a capability the
> product lacks. `README.md`'s alert table is fifteen conditions now rather than
> twelve (`:236-253`) and the fifteenth is
> `webhook.consecutiveFailures > 3 while webhook.configured`, which is the
> channel watching itself.

`grep -rniE "webhook|smtp|nodemailer|slack|pushover|ntfy|web-?push|notificat"`
over `src/`, excluding tests, returns nine hits and **not one is an outbound
channel** — three are MCP transport comments in
`src/app/api/mcp/route.ts:693-729`, three use "slack" to mean spare column
width, and the rest are unrelated prose. There is no email, no webhook, no
browser push, no anything.

**The strongest case against calling this a gap** is `README.md:229-255`, which
is not a shrug but a designed position: a table of twelve alertable conditions
(fifteen at `66fdbab`, `:236-253`),
each named as a field on `/api/status`, each with a suggested threshold and a
note that *"the conditions are the ones that have gone wrong here"* — queue
depth, oldest queued age, sweeper tick age, sweeper and live-guard failure
counts, both `guardFraction`s, three store sizes, `lastBootReconcile.closed`,
and `dataDirOwned`. It even warns that a `guardFraction` of `null` means no
ceiling was configured and must not be alerted on as a number. Below it, ten
lifecycle events go to stdout as one JSON object per line. That is a coherent
pull-based, operator-integrates-it design, and it is better specified than most
products' push notifications.

**What survives that argument** is narrower and still real: **a stock install
produced by the Quick start has no channel, and the conditions the README
itself lists are precisely the unattended ones.** "A restart terminated runs —
each one needs picking up by hand" and "another process took the data directory"
are not conditions you discover by opening the app; they are conditions that
matter because you are *not* watching. The design assumes the operator already
runs Prometheus or equivalent. An operator who does not — which is the operator
`docs/install.md` is written for — gets nothing.

`3 Resources/Debugging and Observability/SLOs and Error Budgets.md` argues that
alerting should fire on user-visible symptoms rather than on causes, which this
table already does. The note rests on a **single vendor book with no
replication**, so this survey takes the framing and not the authority, and
records that it is doing so.

**What it costs.** A run that parked overnight is discovered in the morning. On
a per-run budget that is money; on a schedule that is a missed window.

**Confidence: high** that no channel exists. **This is the row this survey is
least confident *is* a gap**, and it is ranked accordingly.

**Owned by:** partly by `README.md`'s documented position, which is why the
recommendation for this one is "file an issue for a single webhook", not "survey
it".

---

## M4 — Nothing verifies a branch before it is merged

> **Shipped in half.** `main` at `d1d3119`. `landVerifyCommand`
> (`src/lib/settings.ts`) is empty by default; set, a non-zero exit refuses the
> land. It is argv and never a shell line — `parseVerifyCommand` refuses shell
> metacharacters rather than escaping them — and a command that cannot be
> parsed is a refusal rather than a pass, which is the failure the field exists
> to prevent. `landVerdict` and `runVerify` are split so the decision is
> testable without a subprocess, and `deliverRun` runs the same gate, because an
> operator who said "not unless this passes" said nothing about which exit the
> work leaves by.
>
> **Which tree it runs in was the correction, and it is the whole of whether the
> gate checks anything.** The merged version passed `state.checkout.path` — the
> *operator's* checkout, which `landRefusal` has already required to be clean
> and standing on the target — so the command ran against the branch the work
> was about to be merged into and never saw the work. It passed or failed
> identically whatever the agent wrote, and the live evidence in the PR
> (`/bin/false` refused, `/bin/true` allowed) could not tell the difference,
> because neither command reads the tree. `verifyTreeVerdict`
> (`src/lib/land.ts`) now answers the **run's own** worktree slot while it still
> holds the run's branch, and refuses otherwise rather than falling back — it
> does not cut a fresh worktree, for the reason `resolveConflicts` already
> records when it hands a temporary checkout `resolveVerifyTools: []`: a slot
> cut from bare git has no dependency tree, so `npm test` there fails for a
> reason that is not the work.
>
> **Half.** There is no Settings field, so the gate is reachable only by
> `PUT /api/settings` by hand — which means the default install is still
> exactly as this row surveyed it. And [B2](02-backend-logic.md#b2-nothing-builds-or-tests-a-branch-before-it-is-merged-and-the-setting-that-looks-like-it-does-has-one-reader)'s
> second half is untouched: `resolveVerifyTools` still has one reader and it is
> still the conflict assist, so the setting that sounds like a verify gate still
> is not one.
>
> **Re-checked at `66fdbab`, still half, and still at the same two lines.**
> `landVerifyCommand` is declared at `src/lib/settings.ts:391` and ships `""` at
> `:891`; it is read at `src/lib/land.ts:999` (Land) and `:2941` (Deliver), both
> through `verifyTree` (`:1736`) and its pure half `verifyTreeVerdict` (`:1703`), and
> `runVerify` (`src/lib/landGate.ts`).
> `grep -an "landVerifyCommand" src/app/settings/page.tsx` returns nothing —
> **there is still no field.** The API accepts it at
> `src/app/api/settings/route.ts:157-158`, which is the whole of the reachable
> surface.
>
> **And the one setting that does have a field is the wrong one.**
> `resolveVerifyTools` has an editor at `src/app/settings/page.tsx:3221-3243`.
> So the page shows the operator the setting that is not a verify gate, and hides
> the one that is.

The mechanism is [B2](02-backend-logic.md#b2-nothing-builds-or-tests-a-branch-before-it-is-merged-and-the-setting-that-looks-like-it-does-has-one-reader) and is not repeated. The
capability framing is:

**The operator cannot say "do not land this unless the tests pass."** There is
no field for it, no per-repository setting, no gate in `landRun`, and the one
setting whose name suggests otherwise — `resolveVerifyTools` — has a single
reader that is the conflict-resolution assist and ships as `[]`
(`src/lib/settings.ts:713`, read at `src/lib/land.ts:1275`; at `66fdbab` those
are `settings.ts:890` and `land.ts:1362`, and the second clause of that sentence
is the half still standing).

What makes this the sharpest capability gap in the file is the comparison with
what the project does for itself. `.github/workflows/ci.yml` gates every change
to UsageFoundry on `npm run typecheck`, `npm test` and `npm run build`, across
two platforms, plus a Docker build. The product ships an unattended agent that
writes code and merges it, and offers its operator none of the three.

**What it costs.** Unattended merging without a gate is not unattended; it is
deferred attention. That returns the cost the fleet was bought to remove, and it
is the only row in this register whose failure lands in the operator's product
rather than in UsageFoundry.

**Confidence: high.**

**Owned by:** nothing.

---

## M5 — Nothing can be prioritised; the queue is strictly oldest-first

> **Shipped in half.** `main` at `d1d3119`. `runs.priority` is an integer
> defaulting to 0, clamped to ±100 by `setRunPriority` — unbounded invites
> `MAX_SAFE_INTEGER` as a way of saying "definitely first", and the row after
> that is unreachable by any value a person would type. `queueCompare` is the
> one definition of the order (higher first, `created_at` breaking every tie),
> `queueOrder` sorts by it, and `selectPromotable` promotes in it. An install
> that never sets a priority queues exactly as it did before the column existed,
> which is what makes it safe to have.
>
> **The readout was the correction, and it is this row's own headline.** The row
> says `queuePosition` "reports a place nothing can leave". At the merge,
> priority reached the promotion order and not `queuePosition`, which went on
> counting `created_at <= self.created_at` — so an operator could raise a run to
> the front, watch it start first, and read "queued behind 3 other runs" on the
> page the whole time. The lever worked and its only readout did not move, which
> is the complaint the column was added to answer surviving the column.
> `queuePosition` now counts over `queueCompare`, so the number shown and the
> order promoted are one answer.
>
> **Half.** No page has a control: priority is settable only by
> `PUT /api/runs/:id/priority`. The row's confidence line already marked its
> queue depth **assumed**, and nothing here measures it.
>
> **Re-checked at `66fdbab`, still half.** `queueOrder` is
> `src/lib/orchestrator.ts:3913`, `queueCompare` `:3938`, `selectPromotable`
> `:3942` (promoting through `queueOrder` at `:3968`), `queuePosition` `:4018`
> — counting over `queueCompare` at `:4034`, which is the correction — and
> `setRunPriority` `:10994`. The endpoint is
> `src/app/api/runs/[id]/priority/route.ts`.
> `grep -rn "priority" src/app --include=*.tsx` returns **nothing**: there is
> still no control on any page.

Every selection over `runs` in the orchestrator is ordered by creation time:

| Line at `175ba57` | Line at `66fdbab` | Query |
|---|---|---|
| `src/lib/orchestrator.ts:626` | `:838` | `SELECT * FROM runs ORDER BY created_at DESC LIMIT ?` |
| `:2631` | `:3152` | `SELECT * FROM runs WHERE status IN ('queued','running','paused') ORDER BY created_at` |
| `:3950` | `:4528` | `SELECT * FROM runs WHERE status = 'waiting' ORDER BY created_at` |
| `:8665` | `:10112` | `SELECT * FROM runs WHERE status = 'paused' ORDER BY created_at` |
| `:9471` | `:10944` | `… ORDER BY created_at` |

Every one of those SQL statements still reads `ORDER BY created_at` at
`66fdbab`. What changed is that the rows they return are re-sorted through
`queueOrder`/`queueCompare` before anything is promoted, so the SQL is no longer
the order — which is why the table is left standing rather than struck.

There is no priority column, no reorder endpoint, no "run this next". The
`queuePosition` the UI shows is a report of a position **nothing can change**,
which is a subtly worse affordance than showing no position: it tells the
operator where they are in a line they cannot leave.

The only levers are destructive or oblique — cancel the runs ahead, set them
aside via `set_aside_at`, or raise `maxConcurrentRuns` and let everything
through at once.

**What it costs.** A one-line urgent fix behind twenty queued documentation runs
waits for all twenty. On an install where a schedule fills the queue overnight,
the morning's real work starts last.

**Confidence: high** on the ordering — five `grep` hits, no exceptions.
**Assumed:** that queues get deep enough for this to bite. `DATA_DIR` is
unreadable, so no queue depth was observed, and `README.md:233` suggesting an
alert at `queue.depth > 10` is the closest thing to evidence that they do.

**Owned by:** nothing.

---

## M6 — A credential cannot be rotated without a restart, and a restart ends live runs

> **Open at `66fdbab`, unchanged, and now with five more values on the same
> footing.** `AUTH_TOKEN` is still a module-level `const` at
> `src/lib/config.ts:286`, the `UF_GITHUB_TOKENS` map is still built at `:366`
> and consumed by `selectGithubToken` at `:422-447`, and there is still no reload
> endpoint. The five notification variables added since
> ([M3](#m3-nothing-this-app-runs-can-reach-a-human-and-most-of-that-is-on-purpose)) are read the same way and for the same stated reason,
> so the number of values that need a restart to change went up rather than down.

Secrets are read at module load and never again. `src/lib/config.ts:286` is a
module-level `const`, as is the `UF_GITHUB_TOKENS` map built at `:366` and
consumed by `selectGithubToken` at `:424-430` (`:422-447` at `66fdbab`). Changing `UF_AUTH_TOKEN`,
`UF_GITHUB_TOKEN`, `UF_GITHUB_TOKENS` or `UF_STATUS_TOKEN` means editing `.env`
and restarting the container. There is no reload endpoint and no re-read.

A restart is not free: `README.md`'s alert table lists
`lastBootReconcile.closed > 0` with the note *"each one needs picking up by
hand"*, which is the app telling the operator that a restart terminates live
runs and leaves work to reclaim.

**So rotation is coupled to an outage of the fleet.**

`3 Resources/Software Security/Secrets Management.md` sharpens why that matters
rather than merely being inconvenient: **rotation is the only real control after
an exposure**, and its own measured figure — 19% of leaked credentials removed
after 16 days — is a statement about how long exposure persists when rotation is
expensive. Environment variables are listed there as an OWASP *fallback* rather
than a recommended store, which is a fair description of what this app does and
is a reasonable choice for a single-container self-hosted product.

**The honest counter-argument**, and it is strong: a config reload endpoint is
new attack surface on the exact values it reloads, and for a single-container
install a restart is thirty seconds. The gap is not "there should be a reload
endpoint". It is that **rotation costs live runs**, and the cheap fix is not a
new feature at all — it is making a restart non-destructive, which is
`lastBootReconcile`'s territory and #60's.

**What it costs.** Measured in reluctance. A rotation that costs the fleet is a
rotation deferred, and the vault note's 16 days is what deferral looks like.

**Confidence: high** on the mechanism. **Medium** on the framing — no restart
was performed, because Docker is unavailable here.

**Owned by:** #89 carries a rotation item over-cap. Read it before opening
anything.

---

## M7 — Nothing checks a completeness claim, and `docs/agent/` is built out of them

> **Added by the fourth pass, 2026-09-06**, from the 181 closed issues
> [00-method.md](00-method.md#what-was-deliberately-left-unread) named as unread.
> It is the only row in this register whose evidence is a *closed* issue whose
> defect is back, and there are two of them.

`CLAUDE.md`'s routing section sends an editor to one file in `docs/agent/` per
area before they touch the code, and those files answer with counts and with
enumerations. Several of those numbers are wrong, each was filed and closed as
its own issue, and the same numbers have since drifted again. Nothing anywhere
in this repository reads a doc.

**Two that are wrong at `66fdbab`, both of them previously filed and closed.**

`docs/agent/architecture.md:190` opens the `db.ts` entry with *"every table
`migrate()` creates, and there are 22 —"*, names twenty-two tables at
`:191-196`, and then states at `:196-197` that *"the list is a completeness
claim"* and hands the reader a command to check it with (`:198-200`):

```
$ grep -aoE 'CREATE TABLE IF NOT EXISTS [a-z_]+' src/lib/db.ts | sort -u | wc -l
34
```

Twelve tables are missing from a list that says of itself that it is complete.
**#161 — *"architecture.md's db.ts map says 22 tables; migrate() creates 24"* —
is closed**, and the line still says 22 while the gap has grown from two to
twelve. Materialising the schema confirms the number rather than trusting the
grep: `migrate()` against a fresh `DATA_DIR` produces 34 non-`sqlite_` tables.

`CLAUDE.md:61` says *"`grep -rn "globalThis as unknown" src/` finds the
thirty-odd keys already there"*, in the paragraph whose whole point is that
reusing a key whose shape changed makes every call on it throw after a dev hot
reload:

```
$ grep -raoE '__uf[A-Za-z0-9_]+' src/ | sed 's/.*://' | sort -u | wc -l
58
$ grep -ran "globalThis as unknown" src/ | wc -l
53
```

**#166 — *"Widen CLAUDE.md's globalThis grep: it misses two live keys"* — is
closed.** The sentence around the grep still says thirty-odd; the answer is
fifty-eight.

**The repository has a form of this that does not decay, in the same
directory.** `docs/agent/testing.md:310` ships the command with its answer
beside it and dates it in the same breath:

```
find src -name '*.test.ts' -o -name '*.test.tsx' | wc -l          # 109 as this is written
```

That reads 128 today and is not wrong, because it never claimed to be current —
it is a reading with a date on it. `docs/agent/conventions.md` is the other
side of the same coin: it says the panes are *"closed at ten"* and `PANES` holds
ten (`src/components/shell/panes.ts:42-70`), so **#163** was fixed and has
stayed fixed. So this row is not "the docs are stale". It is that the repository
uses two idioms for the same problem, one of which fails silently, and it is the
silent one that carries the claims a reader is most likely to act on.

**Nothing would catch either.** CI runs four things —
`.github/workflows/ci.yml:75` typecheck, `:78` test, `:100` build, `:163`
`npm audit --audit-level=critical` — and none reads a file under `docs/`.
`npm test` covers *"a deliberately short list of pure functions whose failure
modes are silent and expensive"* (`CLAUDE.md`); five test files mention
`docs/agent/` and every one of the five is a prose citation in a docblock about
why that test earned its place — `knowledge.test.ts:29`,
`contextPruning.test.ts:1415`, `orchestrator.test.ts:5018`,
`fileCostNotice.test.ts:10`, `vaultSkill.test.ts:10`. There is no linter
(`eslint.ignoreDuringBuilds`). A doc claim is checked when a person runs the
command the doc happens to carry, or never.

**Why this is a missing mechanism and not doc hygiene.** It is
[M4](#m4-nothing-verifies-a-branch-before-it-is-merged)'s argument one layer up:
something is trusted before it is used and nothing establishes that it is true.
The closed-issue list is what makes it a pattern rather than two stale numbers —
**#123, #124, #133, #136, #140, #150, #151, #153, #161, #162, #163, #166, #169,
#174, #175, #176** are sixteen closed issues that are each one count, one
enumeration or one name in a doc corrected by hand — all sixteen confirmed
closed by the `gh issue list` output this pass persisted — and two of the three
checked against the tree are wrong again.
That is [G1](03-growth.md#g1-nine-list-routes-read-parameters-the-one-for-runs-does-not-and-the-pattern-repeats-three-times)'s
shape exactly — discovered separately, fixed separately, regenerating — applied
to the repository's own instructions rather than to its list routes.

**Blast radius.** The next agent editing `src/lib/`, which is who `docs/agent/`
is written for and who `CLAUDE.md` routes. A completeness claim that is twelve
short is worse than no list: it is the shape that makes a reader stop looking.

**Cost of leaving it.** Paid by hand, roughly one issue at a time, at whatever
rate the tree grows. Nothing breaks and nothing goes red.

**Confidence: high** on both wrong numbers, each measured by a command whose
output is quoted above. **Medium** on the sixteen: their titles were read from
`gh issue list --state closed`, and only #161, #163 and #166 were checked against
the tree.

**A measurement worth carrying, because it makes the doc's own self-check useless
in this container.** The command `docs/agent/architecture.md:198-200` gives the
reader is written without `-a`, and GNU grep 3.8 here reports
`src/lib/db.ts: binary file matches` and prints **nothing** to stdout, so the
check answers `0` rather than 34 — see
[00-method.md](00-method.md#the-fourth-pass-2026-09-06), where the same is true
of `CLAUDE.md:61`'s grep and of six files under `src/lib/`. A byte-identical
copy of `db.ts` outside the worktree greps normally, so this is a property of
this container's filesystem and **not** of the repository, and no part of the
row above rests on it. It is recorded because every command quoted in this pass
carries `-a` for that reason, and because a reader who runs the doc's command as
written may get a silent zero.

**Owned by:** no open issue. #144, #152 and #154 are closed doc-drift *indexes*
covering earlier sweeps of exactly this, which is the point.

---

## Considered and not argued for

**Per-repository configuration.** Guards, model, permission mode and plugin set
are install-wide. The one dimension that *is* per repository is the GitHub
token — `UF_GITHUB_TOKENS` and the `perRepo` map at `src/lib/config.ts:424-430`
(`:422-447` at `66fdbab`),
which resolves a folder to a key via `matchFolderKey`. So the mechanism for
per-repository settings exists and was built for the value that most needed it.
Extending it is a feature request with a clear shape and no evidence behind it
here: nothing in the tree shows an operator wanting a different budget for a
different repository, and inventing that demand is the kind of guess the brief
asked to be dropped. Named so the next survey knows it was considered.
