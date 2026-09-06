# Operations and recovery

Eight gaps, surveyed at `main` `66fdbab` on 2026-09-06.

**This axis asks one question: when something goes wrong on a live install, what
can an operator find out, what can they get back, and what is silently
unrecoverable?** The other five axes are about what the app does. This one is
about what is left after it stops doing it — a restart, a killed process, a
filled disk, a rolled-back image, a database that has to come back from a file.

**It is also the axis with the widest gap between what could be read and what
could be run.** There is no Docker here, `DATA_DIR` and `/backups` are both
outside what this uid may read, and no server was started. So every claim about
a *running* container in this file is a reading of `Dockerfile`,
`docker-compose.yml` or `docker-entrypoint.sh` and says so in the sentence that
makes it, and
[§ Dropped for lack of evidence](#dropped-for-lack-of-evidence-on-this-axis) is
the longest such list in this directory — eleven candidates against eight rows.
That is the honest shape of a survey of operations run without an operating
install, and it is reported rather than compressed.

**What the axis found is not what it went looking for.** The recovery
*mechanisms* here are the best-argued code in the repository: the backup takes a
consistent snapshot through a read-only handle, the restore refuses while a lock
is beating and moves rather than deletes, the lock derives its own staleness
window from git's timeout, and the boot reconciler is transactional about what a
restart may close out. Almost nothing on this axis is a missing mechanism. Seven
of the eight rows are a mechanism that exists and **cannot be seen** — a number
that never clears, a state that reaches only stdout, a store nothing measures, a
coupling nothing pins. The eighth is a sentence in `docs/agent/` that describes
an order the function beside it does not have.

**Nothing here was fixed.** `src/` is untouched by this pass, nothing outside
`proposals/GapRegister/` was edited except the [proposals index](../README.md)
line, and no GitHub issue was opened, closed or commented on.

---

## O1 — The one restart condition the runbook alerts on never clears, and the count that does is on a route the status token cannot reach

**The runs page reasoned this out correctly and `/api/status` shipped the half
that latches.**

`src/app/runs/page.tsx:867-871` states the design in its own comment, and it is
right:

> Bounded to the same 24 hours this page already calls recent: within a day it
> is the explanation for what is below it, and after that it is noise **the
> status endpoint still carries**.

Two surfaces, two lifetimes, both deliberate. The banner at `:875-884` renders
only while `readAt - boot.at < RECENT_WINDOW_MS`. `<RestartClosed />` at `:897`
is driven by `runs.restart_closed` and, as `:888-895` says, "stays until the last
of them has been picked up and renders nothing at all once none is left."

**`/api/status` carries the first and not the second.** `src/lib/status.ts:315-321`
fills `lastBootReconcile` from `recentOpsEvents(1, "boot.reconciled")` — the
newest row, whenever it was written — and `grep -an "restartClosed\|restart_closed"
src/lib/status.ts src/app/api/status/route.ts` returns nothing. The outstanding
count exists and is `restartClosedRuns()` behind `GET /api/runs/restarted`
(`src/app/api/runs/restarted/route.ts:22-28`), which is not on the status route
and is not exempt from the ordinary gate: `src/middleware.ts:114` exempts
`/api/status` alone when `UF_STATUS_TOKEN` is set. **So the read-only credential
`README.md:219-221` tells a monitor to hold cannot reach the number that clears.**

**And `README.md:250` alerts on the one that does not:**

| Condition | Field | Suggested threshold |
|---|---|---|
| A restart terminated runs | `lastBootReconcile.closed` | `> 0` — each one needs picking up by hand |

Once any restart has closed a run, that field is `> 0` for ever. Picking every
one of them up does not move it — `reopenRestartClosed` clears
`runs.restart_closed` (`src/lib/orchestrator.ts:10615`) and writes no `ops_events`
row. Nor does a later clean restart: `src/lib/orchestrator.ts:11276` writes
`boot.reconciled` only `if (closed > 0 || kept > 0)`, so a hundred restarts that
closed nothing leave the old row newest.

**What it costs.** A monitor built from the app's own runbook is permanently red
on the condition whose whole content is *somebody must act*, which is the
condition that most needs to be believed. The two ways out of a permanently red
alert are to widen the threshold or to stop reading it, and both remove the
alert. `README.md:252`'s own fifteenth condition —
`webhook.consecutiveFailures > 3`, added because "a fire-and-forget sink nobody
receives from looks exactly like a quiet fleet" — is the same argument applied to
the channel and not to this field.

**Fair to the code:** the data to de-latch is present. `lastBootReconcile.at` is
on the payload, so a monitor *could* ask `closed > 0 && now - at < 24h`, and the
runbook does not. That makes the smallest fix a README line rather than a schema
change — and the better fix an outstanding count on `/api/status`, because the
question an operator has at 08:00 is not "did a restart happen" but "is anything
still sitting there".

**Confidence: high.** Every line above is in the tree. No monitor was wired and
no restart was performed — Docker is unavailable — so the latch is read out of
the code rather than observed. `M6` names this same field for a different reason
(the cost of rotating a credential) and does not touch what it reports.

---

## O2 — The container's stop grace and the server's shutdown grace are one edit apart, and the file that pins every other such pair does not pin this one

`docker-compose.yml:590-599` sets `stop_grace_period: 30s` and states the
coupling outright:

> On SIGTERM the server interrupts every live run, waits out `SHUTDOWN_GRACE_MS`
> (10s — the kill ladder's own SIGINT/SIGTERM/SIGKILL steps end at 8s) and
> reconciles each interrupted cycle's spend from the transcripts. Docker's
> default is 10s, which would SIGKILL the process at the exact moment the last
> agent died and throw away the accounting this exists to recover.

The other half is `SHUTDOWN_GRACE_MS = 10_000` at
`src/lib/orchestrator.ts:10712`, used at `:10908`. Two files, two numbers, and
the compose one has to be larger than the code one plus however long the
reconciliation takes.

**`src/lib/deployment.test.ts` is the file whose entire purpose is that class of
pair**, and it says so at `:456-467`: *"Both halves are one edit away from each
other and neither typechecks against the other, which is what this is for."* It
carries sixty-odd such pins — the healthcheck's four timings (`:446`), the
container memory ceiling against the server's heap (`:584-607`), the mounted
workspace slots against the volume lines (`:478`), the Discord relay's three
positions (`:1352-1380`), the backup scripts' presence in the image (`:367`).

`grep -an "grace\|stop_\|SIGTERM\|shutdown" src/lib/deployment.test.ts` returns
**nothing**.

**What it costs.** Nothing today: 10s plus an 8s ladder fits inside 30s. It fires
on an edit, and the edit is plausible — `SHUTDOWN_GRACE_MS` is the number
somebody raises when a slow agent is not dying cleanly. Past 30s, Docker SIGKILLs
the process mid-reconciliation and the failure is exactly the one
`src/instrumentation.ts:213-220` records fixing:

> not one of the suspended `startRun` frames ever resumed and nothing after
> `await runIteration(...)` ever ran. Every in-flight cycle's spend went with it

`docs/agent/concurrency-and-ownership.md:16` names the half of that which fails
**open**: `active_started_at` left set on cycles whose agents are gone, which
`installBudget` and a workflow instance's budget both bound
`telemetrySpendSince` below by — so a shutdown that does not finish widens two
ceilings at once. Silent, and visible only as spend that does not add up.

**Confidence: high on the absence, and the absence is the row.** Whether Docker
actually SIGKILLs at 30s was not observed here; it is the documented behaviour of
`stop_grace_period` and the compose comment's own premise, and no container was
run to check it.

---

## O3 — Everything `migrate()` finds wrong with the database it just opened is a line on stdout and nothing else

`db.ts` knows three things a person needs to be told, computes all three at boot,
and writes each to `console.error`:

1. **A downgrade.** `schemaVerdict` (`src/lib/db.ts:81-85`) exists for exactly
   one case, and its docblock says so: *"a `downgrade` is a rollback to an older
   image after a failed deploy, and what it costs is that `migrate()` is about to
   run against a schema it does not know."* When it fires, `:127-133` prints a
   sentence ending *"a rollback has no defined behaviour here and anything the
   newer build added is invisible to this one."*
2. **An orphaned `*_old` table** — the residue of an interrupted migration, whose
   rows *"are not visible anywhere in the UI"* (`:2090-2103`).
3. **A stranded proposals table this build cannot read** (`:1987-1999`), which
   *"needs a hand"*.

**None of the three reaches anything but stdout.**
`grep -ran "schemaVerdict\|SCHEMA_VERSION\|user_version" src/ --include=*.ts
--include=*.tsx` outside `src/lib/db.ts` and outside tests returns nothing at
all. No route carries the file's `PRAGMA user_version`, no page shows it,
`/api/health` does not, `/api/status` does not, and no `ops_events` row is
written.

**`ops_events` is the mechanism for precisely this and it is already used one
function over.** `reconcileOnBoot` writes `recordOpsEvent("warn",
"boot.reconciled", …)` at `src/lib/orchestrator.ts:11279`, with the reason on the
line above it:

> Twenty-five runs terminated, each needing an operator to pick it up by hand,
> was one `console.warn` into a stream nobody is tailing — after which nothing in
> this app could answer "why is everything failed" at all.

That is the same argument, about the same boot, in the same process, and
`migrate()` did not inherit it — the register's recurring shape, here applied to
the schema rather than to chat.

**What it costs.** A rollback to an older image is a normal operational event and
is the one `schemaVerdict` was written to name. After it, the install runs
against a schema the build does not know, and the only evidence is a line in a
stream `orchestrator.ts:11277` has already been burned by assuming somebody
tails — a stream which, per [O7](#o7--the-containers-own-log-is-a-fourth-unbounded-store-and-compose-asks-for-no-limit-on-it),
is also the one nothing bounds. The reporting-rather-than-refusing decision is
right and is argued at `:2083-2089`; what is missing is the second half of
`configCheck.ts`'s own standard, which puts its warnings on the dashboard as well
as on stdout (`src/lib/configCheck.ts:306-310`).

**Confidence: high.** Read entirely from the tree. Whether any real install has
ever been rolled back, or ever held a `*_old` table, is unknown here and is in
the drop list.

---

## O4 — Nothing in the app knows the backup directory exists, so no surface can say when the install was last backed up

`docs/backup-and-restore.md` opens with the stake:

> Everything this app knows about itself is one SQLite file in one Docker volume
> … **There is no second copy anywhere.** `docker compose down -v` destroys it in
> one command.

The mechanism is good and is [recorded as measured](#what-this-axis-got-right-recorded-because-a-register-that-lists-only-failures-misreads-the-codebase).
The gap is that the app cannot tell you whether it has been used.

`grep -ran "UF_BACKUP_DIR\|backups" src/ --include=*.ts --include=*.tsx` outside
tests returns **nothing**. `UF_BACKUP_DIR` is read by `docker-compose.yml:454`
and by `scripts/backup-db.mjs` and by nothing under `src/`. The server does not
know where backups go, so no page and no route can report on them.

**What that costs, against what the app measures for everything else.**
`/api/status` reports three store sizes and `README.md:247-249` gives all three
an alert. The Settings Storage card shows the same three beside their horizons.
Not one figure anywhere describes the store an actual recovery depends on. An
install whose operator ran `backup-db.mjs` once in August and an install running
it nightly from cron present identically — on every page, on the status
endpoint, and in every one of `README.md`'s fifteen alertable conditions.

**This row does not ask for a scheduler and the distinction is the whole of why
it is filed.** Shipping one is refused, on the record, at
`docs/agent/environment.md:13`: *"`scripts/backup-db.mjs` is run by hand or by
the operator's own cron, which the README states in words rather than shipping a
scheduler, because a timer that spends nothing still needs somewhere to put a
file that grows without bound."* That argument is about **writing**. It says
nothing about **reading**, and the newest file in a directory is a `readdir` and
an `mtime` — the same one `storeUsage` already performs three times for stores
whose growth is a nuisance rather than a recovery.

**Confidence: high on the absence; the consequence is argued rather than
observed.** Nothing here establishes that any install has gone unbacked-up, and
`/backups` is unreadable by this uid so the shipped directory's contents were not
listed. What is established is that no surface could tell you either way.

---

## O5 — A chat thread and every message in it is permanent: no horizon, no delete, and the cascade has nothing to cascade from

`retention.ts` deletes from six tables — `run_events`, `otlp_requests`,
`context_samples`, `prune_decisions`, `context_compositions` and
`context_composition_children` (`:174, :182, :199, :212, :232, :239`). Chat is on
none of them.

`docs/agent/retention.md:8` states the design and its permanent set precisely:

> **A run's row is permanent; everything behind it is evidence, and evidence has
> a horizon.** Nothing in `retention.ts` deletes a `runs` row, a `run_reviews`
> row, a `workflow_instance_*` row or a settings key

That list is four things and `chat_messages` is not one of them. It is not
swept, and it is not named as permanent either — it is simply not in the design.

**Nor can an operator remove one by hand.** There is no `DELETE` handler anywhere
under `src/app/api/chat/` (`grep -ran "export async function DELETE"
src/app/api/chat/` returns nothing), no `deleteChat` in `src/lib/chat.ts`, and no
archived or deleted-at column on `chat_sessions`. `src/lib/db.ts:606` declares
`chat_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE` — **a
cascade with nothing to cascade from.** `DELETE FROM chat_sessions` has no
non-test call site in the tree.

**What it holds.** `text TEXT NOT NULL` (`:612`) — every user message and the
full text of every assistant turn, `role` marking which. The run path's
equivalent is `run_events`, which expires at `eventRetentionDays` = 30
(`src/lib/settings.ts:904`) once its run has settled.

**This is the chat theme again, and it is the fifth instance.**
[05-register.md](05-register.md) already records that chat has none of the
run path's mechanisms — incremental persistence, publish-after-persist, a
mid-flight guard, a paged list. Retention is the fifth, and here the asymmetry is
inverted in an instructive way: the run surface *discards* evidence on a horizon
and keeps the row, where chat keeps everything for ever and can reach only the
newest 30 of it ([G2](03-growth.md#g2-chat-threads-past-the-newest-30-cannot-be-reached-at-all),
not refiled — that row is about reachability and this one is about the disk).
Past the thirtieth thread the two compound: undeletable, unreachable, and
retained in full.

**What it costs.** Growth with use, at whatever rate the operator chats, with no
setting to bound it and no control to trim it — and no way to remove a thread
that contains something that should not be kept.

**Confidence: high on the mechanism, unmeasured on the size.** No count of
`chat_messages` or of its bytes exists here; `DATA_DIR` is unreadable. The row is
about the absence of a horizon and of a delete path, both of which are in the
tree, and it makes no claim about how large any real install's chat store is.

---

## O6 — `plan_observations` grows at every boundary, is swept by nothing and is read by nothing

`src/lib/db.ts:1653` creates it with twelve columns and two indices
(`:1673-1674`). `src/lib/contextPruning.ts:2727-2757` writes one row per call,
from `observePlan` (`src/lib/orchestrator.ts:6714`), from `settleBoundary`
(`:6458`), which runs at every cycle boundary and at every early end (`:6367,
:6406, :6431, :8654`). So the write rate is roughly one row per work cycle
boundary, per run, for the life of the install.

**Nothing deletes it.** It is absent from `retention.ts`'s six sweeps and absent
from `docs/agent/retention.md:8`'s permanent set, exactly as
[O5](#o5--a-chat-thread-and-every-message-in-it-is-permanent-no-horizon-no-delete-and-the-cascade-has-nothing-to-cascade-from)'s
subject is.

**And nothing reads it.** `src/lib/orchestrator.ts:9649` says so in passing,
while arguing for something else:

> the same subprocess `observePlan` already spawns at every boundary — whose
> answer went into `plan_observations` and was read by nothing.

`resume_probes` (`db.ts:1615`) is the same shape with one difference that matters:
it *is* read, at `contextPruning.ts:3831`, as the control group
`boundaryInvalidation` needs — and `orchestrator.ts:8645-8655` records what an
empty one silently did. So it earns its rows. It still has no horizon.

**What it costs.** Little, per row, and the numbers are small — this is the
cheapest row on the axis and is ranked accordingly. What it is worth filing for
is the class: `retention.ts`'s design divides every table into *evidence with a
horizon* or *permanent by decision*, and eight tables are in neither
(`chat_messages`, `chat_proposals`, `chat_questions`, `chat_turn_spend`,
`merge_queue`, `plan_observations`, `resume_probes`, `run_deps` — from the create
list in `db.ts` against every `DELETE FROM` in `src/`). Most of those are bounded
by a permanent row they hang off. `plan_observations` is bounded by nothing and
is the one whose rows nothing has ever read.

**Confidence: high on every clause; the growth rate is arithmetic from the call
sites and not a measurement.** No table was counted; `DATA_DIR` is unreadable.

---

## O7 — The container's own log is a fourth unbounded store, and compose asks for no limit on it

**Read from the file. No container was run, and the sentence below is the whole
of what can be claimed from here.**

`grep -rn "logging:" docker-compose*.yml` returns nothing, and
`docker-compose.yml` is the only compose file in the repository. So the container
inherits whatever the host daemon's default logging driver and default size are,
and this repository neither sets nor documents them.

The app writes to that stream on purpose and at volume. `README.md:260-276`: ten
lifecycle event kinds as one JSON object per line, beside the `[usagefoundry] …`
prose — and `run.sandbox_refusal` is deliberately among them for a reason that
names the scale:

> a policy that refuses the work fails *inside* tool calls, and at twenty-five
> unattended runs the run page is not where anyone finds that out.

Every boot refusal, every config warning, every `reportOrphanTables` line
([O3](#o3--everything-migrate-finds-wrong-with-the-database-it-just-opened-is-a-line-on-stdout-and-nothing-else)),
the lock-lost message (`src/lib/serverLock.ts:479-486`) and every shutdown
reconciliation goes to the same place.

**What makes it a gap rather than a fact about Docker** is the asymmetry with the
three stores this app does bound and does measure. `retention.ts` gives
`run_events`, the checkouts and the transcripts a horizon each; `storeUsage` puts
all three on `/api/status`; `README.md:247-249` gives all three an alert with a
threshold. The fourth store grows on the same disk, is written by this app, is
named in this app's own documentation as where an operator goes to find things
out — and has no horizon, no reading and no alert. On a machine whose disk fills,
the three the app watches are the three that are not the problem.

**Confidence: medium, and the discount is the container.** That compose sets no
limit is certain. That the daemon's default is unbounded is Docker's documented
default rather than something checked here, and a host `daemon.json` could set
one — which is itself the point, since nothing in this repository says whether it
does. No log file was inspected and no container was started.

---

## O8 — `lockVerdict` asks staleness second; `docs/agent/concurrency-and-ownership.md` says it asks it last

`src/lib/serverLock.ts:146-155`, whole:

```ts
export function lockVerdict(
  lock: ServerLock | null,
  self: { pid: number; now: number },
  ownerAlive: boolean,
): LockVerdict {
  if (!lock) return "claim";
  if (self.now - lock.heartbeatAt > STALE_MS) return "claim";
  if (lock.pid === self.pid) return "claim";
  return ownerAlive ? "held" : "observe";
}
```

`docs/agent/concurrency-and-ownership.md:18`, verbatim, and the same sentence is
in the `STALE_MS` docblock at `serverLock.ts:66-71`:

> The margin itself is stated where the constant is: staleness is the *last*
> question `lockVerdict` asks and the only case it decides is "the lock's pid is
> alive and has stopped beating" — no lock, a dead pid and our own pid across a
> container restart are all settled before it

Staleness is the **second** of four questions. Of the three the sentence says are
"settled before it", one is (`!lock`, `:151`) and two are not: `lock.pid ===
self.pid` is `:153` and the dead-pid path is `:154`.

**The one case where the order changes the answer** is a stale lock whose pid is
dead — which is what a server killed without releasing leaves behind, and
therefore the case an operator meets. The code claims it outright at `:152`. The
documented order would send it to `stillBeating`'s four-second observation
(`OBSERVE_MS`, `claimDataDir:343-346`) and claim it there.

**Both answers are the same answer, and the code's is faster and no less safe** —
a dead pid *and* a beat older than `STALE_MS` is doubly dead. So this costs
nothing today, and it is ranked last among the open rows for that reason,
alongside [G3](03-growth.md#g3-one-process-is-the-hard-ceiling-and-the-usual-escape-route-is-not-the-one-that-applies)
and [S5](07-security.md#s5-the-one-write-path-the-edge-gate-exempts-buffers-an-unbounded-body).

**What it is worth filing for is what the sentence is for.** It is not a
description; it is the *argument that `STALE_MS` may be large* — "A longer window
costs very little, and that is a fact about `lockVerdict` rather than optimism"
(`:66-67`), followed by the enumeration above as the evidence. The next editor to
change `STALE_MS` will reason from that enumeration, and two thirds of it is
false of the function it describes. This is a documented invariant contradicted
by the code beside it, which is the strongest kind of row this register carries
and the **second** one on it — the first being
[S1](07-security.md#s1-the-all-sessions-branch-of-the-logout-route-takes-no-credential-and-revoking-a-session-does-not-end-it).

**Confidence: high, and the smallest fix is a sentence.** Either reorder the
sentence to match the code, or move the staleness test below the two it claims to
follow. Nothing was run against a live lock; both halves are read from the tree.

---

## What this axis got right, recorded because a register that lists only failures misreads the codebase

`02-backend-logic.md` and `07-security.md` both carry one of these. This axis
needs one more than either, because **the ratio here is the finding**: almost
nothing on this axis is a missing recovery mechanism. The mechanisms are there
and they are the most carefully argued code in the repository. What is missing is
almost always a *reading* of one.

**The backup is not a file copy and the reasoning is written where it is made.**
`scripts/backup-db.mjs:1-34` opens with why `cp` and `docker cp` are both wrong —
WAL mode spreads committed state across three files, so copying the main file
alone *"silently omits every transaction committed since the last checkpoint — it
restores cleanly and is simply missing the newest runs, which is the worst
failure available"* — and uses `VACUUM INTO` through a **read-only** connection
(`:209`), written under a temporary name and renamed only after `integrity_check`
passes (`:206-225`).

**And the half of that which can be checked here has been checked, by somebody
else, and recorded.** `docs/verification.md:409-437` records it driven end to end
against a live writer: a `cp` and a `backup-db.mjs` snapshot taken at the same
instant against a database committing a row every 20ms gave **25 runs** and **386
runs** respectively, *"and both files passed `integrity_check`, which is the whole
argument for this existing"*. Seven refusals were driven, including a restore
whose copy dies part-way — induced with `ulimit -f 200` — which was **seen to fail
first** before the guard was added. That is the standard the rest of this register
is measured against.

**The restore's four refusals are each the difference between a restore and a
second incident**, and `scripts/restore-db.mjs:1-30` numbers them. The one worth
naming is liveness: it is decided on the **age of the heartbeat** rather than on a
pid, *"because a restore runs in a different container from the server, where a
pid means nothing"* — and its copy of `STALE_MS` is held to `serverLock.ts`'s own
derivation by an assertion that reads the script's source
(`src/lib/backupRestore.test.ts:383-396`), because the runtime image ships the
scripts without `src/`.

**`STALE_MS` is derived rather than chosen.** `GIT_SYNC_TIMEOUT_MS * 6`
(`serverLock.ts:84`), because the previous figure was *"shorter than a single git
call"* and one admission makes several in an uninterrupted stretch.
`heartbeatVerdict` (`:191-197`) closes the case where both processes end up
believing they hold the directory — the failure that made the old code's
unconditional restamp permanent.

**`claimDataDir` is asked once and never retried, and the refusal is argued**
(`:325-331`): a second process that keeps asking is one waiting to claim the
directory the moment the owner stalls. A refused process boots, serves every page
read-only, and says so on `/api/health` — `src/app/api/health/route.ts:28-36`
gives 503 its second meaning for exactly that, having learned that a
`console.warn` at boot left a second replica admitting runs.

**The one non-additive migration is gated on ownership** (`shouldMigrate`,
`db.ts:103-112`) with an empty-file exception so a fresh database is not left
without a schema, and `recoverStrandedProposals` (`:1977-2003`) *completes* the
one interrupted rebuild this app has shipped rather than reporting it — naming,
in its own docblock, why the idempotence guard is what would otherwise make the
loss permanent.

**`configCheck.ts` refuses on one variable and warns on every other**, and
`:24-47` argues the asymmetry rather than applying a rule evenly: `DATA_DIR`
decides where the only copy of anything lives, and *"a boot that carries on
writing to a directory the operator did not name is a boot that is manufacturing
the data loss"*. A missing mount is degraded rather than broken and taking the
dashboard away over it would be the wrong trade.

**The shutdown awaits its own reconciliation** (`instrumentation.ts:213-220`),
and the comment records what the previous shape lost: every in-flight cycle's
spend, plus the two columns saying a cycle is open. `releaseDataDir()` in the
`finally` hands the directory back so the next boot — immediate, under
`restart: unless-stopped` — does not have to watch a dead pid for four seconds.

**And the restart banner reasons out two lifetimes for one event**
(`runs/page.tsx:867-895`), which is the reasoning [O1](#o1--the-one-restart-condition-the-runbook-alerts-on-never-clears-and-the-count-that-does-is-on-a-route-the-status-token-cannot-reach)
exists to say `/api/status` did not receive.

---

## Refuted or already decided on this axis

Eight candidates that look like operational gaps and are documented decisions.
Named so a future sweep does not rediscover them.

1. **Nothing schedules a backup.** Decided at `docs/agent/environment.md:13`:
   run by hand or by the operator's own cron, *"because a timer that spends
   nothing still needs somewhere to put a file that grows without bound."*
   [O4](#o4--nothing-in-the-app-knows-the-backup-directory-exists-so-no-surface-can-say-when-the-install-was-last-backed-up)
   asks for a reading and explicitly not for this.
2. **A second server serves read-only until somebody restarts it by hand.**
   Argued at `src/lib/serverLock.ts:325-331`: a retry would widen the one window
   the module exists to keep narrow.
3. **Nothing ever runs `VACUUM`.** `docs/agent/retention.md:20` and
   `README.md:414-428`: it blocks the single writer, on a process carrying live
   guards, so the size is reported and the command is given instead.
4. **Docker's health state is surfaced and never acted on.**
   `README.md:209-214` states it and leaves the wiring to the operator's
   supervisor deliberately, *"a restart here marks every in-flight run `failed`"*.
5. **`migrate()` is not a migration framework.** `db.ts:52-67` argues that
   `addColumn` reading the live schema is the correct check for an additive
   change and that `user_version` records the two things a schema read cannot
   say. [O3](#o3--everything-migrate-finds-wrong-with-the-database-it-just-opened-is-a-line-on-stdout-and-nothing-else)
   is about where that verdict goes, never about replacing the mechanism.
6. **A `*_old` table is reported rather than dropped.** `db.ts:2083-2089`: it is
   either a future migration's residue or a table somebody made by hand, and
   *"neither is something to drop"*.
7. **`stop_grace_period: 30s` is not arbitrary.** It is reasoned against
   `SHUTDOWN_GRACE_MS` and the kill ladder in the compose comment itself
   (`:590-599`).
   [O2](#o2--the-containers-stop-grace-and-the-servers-shutdown-grace-are-one-edit-apart-and-the-file-that-pins-every-other-such-pair-does-not-pin-this-one)
   is about the pin, never about the number.
8. **Alerting in general.** [M3](04-missing-features.md#m3-nothing-this-app-runs-can-reach-a-human-and-most-of-that-is-on-purpose)
   is registered and closed, and `README.md`'s pull-based position stands. No row
   here asks for a new channel or a new push;
   [O1](#o1--the-one-restart-condition-the-runbook-alerts-on-never-clears-and-the-count-that-does-is-on-a-route-the-status-token-cannot-reach)
   asks that an existing field mean what the runbook beside it says, which is a
   different claim and is the only ground on which it was filed.

**Also not refiled:** the seven candidates refuted by the original survey
([06-recommendation.md:244-262](06-recommendation.md)) and the six refuted on the
security axis. Out of scope by the brief.

---

## Dropped for lack of evidence on this axis

Eleven candidates that are plausible, are not in the register, and could not be
tied to a line, a command's output or a documented invariant. **This is the
longest such list in the directory and that is the expected result rather than a
failed pass**: this is an axis about a running install, surveyed without one.

1. **Whether any backup has ever been taken on this install, or any restore ever
   run.** `/backups` and `DATA_DIR` are both outside what this uid may read, so
   the shipped `./backups` was not listed and no snapshot's timestamp was seen.
   [O4](#o4--nothing-in-the-app-knows-the-backup-directory-exists-so-no-surface-can-say-when-the-install-was-last-backed-up)
   argues that no surface could report it and makes no claim about what is there.
2. **Whether the runtime image can actually run the backup scripts.** That it
   carries `scripts/`, resolves `better-sqlite3` out of the standalone bundle,
   has `sqlite3` on the PATH, and that `/backups` is writable by the uid compose
   runs as. `deployment.test.ts:367-388` pins the Dockerfile's text and
   `docs/verification.md:4100-4113` names this same gap and lists the four
   commands that close it. Docker is unavailable here, so this pass adds nothing
   to it and does not refile it.
3. **Whether `HEALTHCHECK --start-period=180s` is long enough for a real boot on
   a large database.** `migrate()` ends with an unconditional `ANALYZE`
   (`db.ts:1920`, measured at 27 ms on a 5,000-run fixture) and four boot
   reconcilers run after it, but nothing here times a cold start on a real
   volume. No container.
4. **Whether the host daemon bounds the container log.**
   [O7](#o7--the-containers-own-log-is-a-fourth-unbounded-store-and-compose-asks-for-no-limit-on-it)
   claims only that compose asks for no limit, which is certain, and marks the
   rest as Docker's default rather than a measurement.
5. **Whether a SIGKILL leaves a lock whose pid a live process has since taken.**
   `lockVerdict:153` claims our own pid, which is the common case across a
   container restart, and a collision with a different live process would leave
   the server read-only until restarted — reported by `dataDirOwned: false`,
   which is already on `README.md:251`. Nothing here establishes that it can
   happen, and reproducing it needs a container.
6. **What a run's log actually holds the morning after a 03:00 failure.** The
   horizon is 30 days on settled runs (`settings.ts:904`, `retention.ts:174-178`)
   and the answer is therefore "all of it" — but only a query against a real
   `run_events` would show what a badly-ended run's last events contain, and
   `DATA_DIR` is unreadable.
7. **Whether `ops_events`' 500-row cap (`src/lib/ops.ts:172`) has ever evicted a
   `boot.reconciled` row.** Only two sites write that table and
   `contextPruning.ts:2700-2712` already bounds the repeating one, so it looks
   ample. Unmeasured, and no row rests on it.
8. **How large `chat_messages` is on any install.**
   [O5](#o5--a-chat-thread-and-every-message-in-it-is-permanent-no-horizon-no-delete-and-the-cascade-has-nothing-to-cascade-from)
   is about the absence of a horizon and of a delete path, both in the tree, and
   makes no size claim.
9. **Whether an interrupted `migrate()` has ever happened outside the one
   `recoverStrandedProposals` was written for.** `reportOrphanTables` exists
   because it could; nothing says it has.
10. **Whether `releaseDataDir`'s hand-back actually beats the next boot under
    `restart: unless-stopped`.** The comment at `instrumentation.ts:239-243`
    says the restart is immediate and that is what the release is for; the
    timing was not observed.
11. **What an operator's monitoring actually reads.** Every claim about alerting
    in [O1](#o1--the-one-restart-condition-the-runbook-alerts-on-never-clears-and-the-count-that-does-is-on-a-route-the-status-token-cannot-reach)
    is about `README.md:236-253`'s table, which is a recommendation. Whether any
    install has wired it is unknown here, and O1 is written to be about the field
    and the route rather than about a monitor nobody can see.
