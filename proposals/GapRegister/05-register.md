# The register

**Thirty-seven rows.** Thirty-eight gap identifiers across the six axis files,
with
[B2](02-backend-logic.md#b2-nothing-builds-or-tests-a-branch-before-it-is-merged-and-the-setting-that-looks-like-it-does-has-one-reader) and [M4](04-missing-features.md#m4-nothing-verifies-a-branch-before-it-is-merged) carried once as
one gap with two framings.

Every row points at a file and line, a command whose output is quoted in
[00-method.md](00-method.md) or in its own axis file, or a documented invariant
it contradicts. Twenty-three candidates were dropped for lack of evidence and
twenty-one were refuted outright; five of the refutations are in
[00-method.md](00-method.md#refuted-or-already-decided), two in
[03-growth.md](03-growth.md#refuted-on-this-axis), six in
[07-security.md](07-security.md#refuted-or-already-decided-on-this-axis) and
eight in
[08-operations.md](08-operations.md#refuted-or-already-decided-on-this-axis).
The last two files carry their own drops as well — six and eleven — and the
operations list is the longest in this directory, which is what surveying a
running install without one looks like when it is reported rather than
compressed.

Ranked by *cost of leaving it*, discounted by confidence. Blast radius alone
does not rank a row: [B1](02-backend-logic.md#b1-the-landing-guard-covers-landrun-and-none-of-the-other-four-doors) has the widest and sits third
because no failure has been reproduced, and [G3](03-growth.md#g3-one-process-is-the-hard-ceiling-and-the-usual-escape-route-is-not-the-one-that-applies) has an
unbounded one and sits thirty-first, third from last among the open rows,
because it costs nothing today.
[S5](07-security.md#s5-the-one-write-path-the-edge-gate-exempts-buffers-an-unbounded-body)
is below it on the same reasoning plus an assumed premise, and
[O8](08-operations.md#o8--lockverdict-asks-staleness-second-docsagentconcurrency-and-ownershipmd-says-it-asks-it-last)
is below both: it contradicts a documented invariant, which is the strongest
kind of evidence here, and costs nothing at all because the code it contradicts
is *safer* than the sentence describing it.

## The state of it, at `66fdbab`

**Every figure in this file is `main` at `66fdbab`, re-read row by row against
the tree on 2026-09-06.** The survey was written at `175ba57`; where a line moved
without its code changing, the number here is the current one and the axis file
says what it was.

**Eight of the twenty rows have moved. Four are closed whole and four are closed
in half.**

Closed whole: [F1](01-frontend.md#f1-run-history-stops-at-100-rows-and-cannot-be-paged-filtered-or-searched), [F4](01-frontend.md#f4-a-runs-log-cannot-be-searched-or-filtered) and [F6](01-frontend.md#f6-settings-is-nine-sections-in-a-3502-line-page-with-no-way-to-find-a-field)
on branch `uf/usagefoundry-721638d11c0b-1-41e5e190`, and
**[M3](04-missing-features.md#m3-nothing-this-app-runs-can-reach-a-human-and-most-of-that-is-on-purpose) on `main`, which is new since the last
reading of this file**: `src/lib/notify.ts` POSTs one signed JSON body to one
operator-named URL when a run ends `needs-review`, `blocked` or `failed`
(`:107-111`, `:422`), so "nothing this app runs can reach a human" is simply no
longer true. Commits `1891ad7` and `0d6af15`.

Closed in half: [F2](01-frontend.md#f2-quick-open-the-apps-only-search-surface-inherits-that-cap) (the cap, not the corpus), and
[B2](02-backend-logic.md#b2-nothing-builds-or-tests-a-branch-before-it-is-merged-and-the-setting-that-looks-like-it-does-has-one-reader)/[M4](04-missing-features.md#m4-nothing-verifies-a-branch-before-it-is-merged),
[M1](04-missing-features.md#m1-the-app-can-push-nothing-and-open-no-pull-request) and [M5](04-missing-features.md#m5-nothing-can-be-prioritised-the-queue-is-strictly-oldest-first) on `main` at `d1d3119`. **All three
of the landing group are still mechanisms with no interface**, re-checked here:
`grep -an "landVerifyCommand" src/app/settings/page.tsx`,
`grep -rn "deliver" src/app --include=*.tsx` and
`grep -rn "priority" src/app --include=*.tsx` each return nothing.
[M3](04-missing-features.md#m3-nothing-this-app-runs-can-reach-a-human-and-most-of-that-is-on-purpose) is marked whole rather than half despite also
having no field, because there the absence is argued: `src/lib/config.ts:450-466`
refuses to let a webhook target live in `settings.json`, since `/api/settings` is
reachable with the master key.

**Three rows had a claim contradicted rather than closed**, and each is corrected
in its axis file:

1. [G1](03-growth.md#g1-nine-list-routes-read-parameters-the-one-for-runs-does-not-and-the-pattern-repeats-three-times) reads "`/api/runs` is the only route in the tree
   returning a capped list and reading no `searchParams`". `/api/runs` now reads
   five (`src/app/api/runs/route.ts:77-97`), and the survey re-run at `66fdbab`
   is 68 `route.ts` files with **eleven** reading `searchParams`. The route that
   now fits the description is `/api/chat`
   (`src/app/api/chat/route.ts:15-27`) — which is
   [G2](03-growth.md#g2-chat-threads-past-the-newest-30-cannot-be-reached-at-all). The row's actual claim, that this is a pattern
   rather than an incident, survives with its first instance struck: the 30 at
   `src/lib/chat.ts:387` and the 25 at `src/lib/workspace.ts:168, :188` are
   untouched.
2. [B4](02-backend-logic.md#b4-the-install-ceiling-is-checked-once-per-chat-turn-before-it-and-a-turn-has-no-cap)'s title says "a turn has no cap". A chat turn is
   capped: `runOrchestratorChild` passes `--max-budget-usd`
   (`src/lib/chat.ts:2327-2332`) from `settings.chatTurnBudgetUSD`, which ships
   at 2 (`src/lib/settings.ts:903`). **That was true at `175ba57` too**
   (`src/lib/chat.ts:1704` there), so this is a survey error and not drift. What
   survives is the row's real subject: the *install's* 24-hour ceiling is read
   once, at admission (`chat.ts:2071`), and never again inside the turn.
3. [M1](04-missing-features.md#m1-the-app-can-push-nothing-and-open-no-pull-request)'s three prose-only grep hits are down to prose plus a
   mechanism, and one of them is inside the mechanism:
   `src/lib/delivery.ts:11-12` still opens by saying that a grep for `git push`
   and `gh pr create` "returns prose only", in the file that answers it.

**One row got wider.** [B1](02-backend-logic.md#b1-the-landing-guard-covers-landrun-and-none-of-the-other-four-doors) surveyed four unguarded doors
into the repository beside `landRun`. There are now five: `deliverRun`
(`src/lib/land.ts:2901`) resolves the same folder `landRun` does
(`:2914` against `:962`), takes neither the `landing` set nor the `activeRuns()`
overlap check, and then runs `git push --set-upstream` in it (`:2958-2962`). It
arrived with the work that closed half of
[B2](02-backend-logic.md#b2-nothing-builds-or-tests-a-branch-before-it-is-merged-and-the-setting-that-looks-like-it-does-has-one-reader)/[M4](04-missing-features.md#m4-nothing-verifies-a-branch-before-it-is-merged).

**And one figure outside the rows changed.** `npm audit` on this tree reports
`found 0 vulnerabilities`; the three high-severity advisories
[03-growth.md](03-growth.md#refuted-on-this-axis) refuted were cleared by
`102050d`, with a `postcss` override inside `next` rather than the semver-major
move that section declined. The refutation's conclusion is unchanged and its
facts are now historical.

**Nothing else on the register moved.** [M2](04-missing-features.md#m2-one-credential-no-identity-no-authorisation),
[B3](02-backend-logic.md#b3-a-chat-turn-exists-nowhere-durable-until-the-child-exits), [B5](02-backend-logic.md#b5-the-chat-can-identify-only-the-first-25-repositories-always-the-same-25), [G2](03-growth.md#g2-chat-threads-past-the-newest-30-cannot-be-reached-at-all),
[G3](03-growth.md#g3-one-process-is-the-hard-ceiling-and-the-usual-escape-route-is-not-the-one-that-applies), [G4](03-growth.md#g4-the-audit-trail-is-20000-rows-deep-evicted-on-every-insert-and-identifies-no-person), [F3](01-frontend.md#f3-a-chat-turn-renders-nothing-until-it-finishes-the-run-path-streams) and
[M6](04-missing-features.md#m6-a-credential-cannot-be-rotated-without-a-restart-and-a-restart-ends-live-runs) are open at the same mechanism, most of them at
lines that only shifted. [F5](01-frontend.md#f5-nothing-that-renders-is-checked-by-anything) is open and every count in it
moved the wrong way again.

**What could not be re-checked from here**, and is therefore carried forward as
**assumed unchanged**: every "Already owned?" issue number, because no GitHub
issue was read or written on this pass; and whether
[M1](04-missing-features.md#m1-the-app-can-push-nothing-and-open-no-pull-request) has since opened a real pull request, because `DATA_DIR`
is unreadable by this uid, so no run's `deliver` event can be read.

## The fifth axis, added 2026-09-06

**Five rows, [S1](07-security.md#s1-the-all-sessions-branch-of-the-logout-route-takes-no-credential-and-revoking-a-session-does-not-end-it) to
[S5](07-security.md#s5-the-one-write-path-the-edge-gate-exempts-buffers-an-unbounded-body),
on the app's own security and trust boundary**: its doors, its credentials, its
inputs. [07-security.md](07-security.md) is the axis file. That axis is
deliberately the *reverse* direction from
`proposals/implemented - Sandboxing/`, which owns what a run can reach; where a
finding would have needed a claim about what a sandboxed child can dial, the
claim is not made and the candidate is in that file's drop list saying so.

They are ranked into the table below by the same method rather than appended, so
seventeen of the twenty existing rows changed number without any of them changing
cost, and none changed position *relative to each other*. Nothing on the four original axes was re-read on this pass: every figure
above this section is still the `66fdbab` reading of 2026-09-06, and the five new
rows were read against the same tree on the same day.

**One of them is the first violation of a documented invariant this register has
carried**, which is why the third observation at the foot of this file had to be
rewritten rather than re-asserted.
[S1](07-security.md#s1-the-all-sessions-branch-of-the-logout-route-takes-no-credential-and-revoking-a-session-does-not-end-it)
contradicts `docs/agent/security.md:26` in the clause that justifies
`/api/logout`'s exemption from the edge gate: *"it revokes the id inside the
cookie it is handed"*, where the `all: true` branch is handed no cookie, reads
none, and revokes every id.

**What the axis mostly found is that the position is held.** Seventeen
candidates were judged: five became rows, six died against a paragraph that had
already reasoned the thing through, and six were dropped for want of evidence.
The six that died include every one of the checks the brief named as ground to
cover:
both containment phases, at both times, in both files that implement them; the
relay's HMAC over raw bytes before parsing; the capability token's life; the
`UF_` strip that makes every credentialed git call greppable; and
`permissionMode`'s narrowing, which turns out to happen at *three* routes rather
than the two `docs/agent/security.md:19` counts. That is a different result from
the other four axes and it is recorded in
[07-security.md](07-security.md#what-this-axis-got-right-recorded-because-a-register-that-lists-only-failures-misreads-the-codebase)
rather than compressed into a row.

## The sixth axis, added 2026-09-06

**Eight rows, [O1](08-operations.md#o1--the-one-restart-condition-the-runbook-alerts-on-never-clears-and-the-count-that-does-is-on-a-route-the-status-token-cannot-reach)
to [O8](08-operations.md#o8--lockverdict-asks-staleness-second-docsagentconcurrency-and-ownershipmd-says-it-asks-it-last),
on operations and recovery**: what an operator can find out when a live install
breaks, what they can get back, and what is silently unrecoverable.
[08-operations.md](08-operations.md) is the axis file. Restart and boot, the
server lock and stale ownership, backup and restore, schema and upgrade, growth
of the store on disk, the container, and diagnosis after a bad ending at 03:00.

They are ranked into the table below by the same method rather than appended, so
twenty of the twenty-five existing rows changed number without any of them
changing cost, and none changed position *relative to each other*. Nothing on
the first five axes was re-read on this pass: every figure above this section is
still the reading of 2026-09-06, and the eight new rows were read against the
same tree — `origin/main` at `66fdbab` — on the same day.

**The axis's own result is that seven of its eight rows are a mechanism that
exists and cannot be seen.** The recovery mechanisms here are the best-argued
code in the repository — `VACUUM INTO` through a read-only handle, a restore that
refuses while a lock is beating, `STALE_MS` derived from git's own timeout rather
than chosen, a boot reconciler with a documented exception for a recent pause.
Almost nothing on this axis is a missing mechanism. What is missing is a
*reading* of one: a number that never clears
([O1](08-operations.md#o1--the-one-restart-condition-the-runbook-alerts-on-never-clears-and-the-count-that-does-is-on-a-route-the-status-token-cannot-reach)),
a verdict that reaches only stdout
([O3](08-operations.md#o3--everything-migrate-finds-wrong-with-the-database-it-just-opened-is-a-line-on-stdout-and-nothing-else)),
a store the app does not know exists
([O4](08-operations.md#o4--nothing-in-the-app-knows-the-backup-directory-exists-so-no-surface-can-say-when-the-install-was-last-backed-up)),
a coupling nothing pins
([O2](08-operations.md#o2--the-containers-stop-grace-and-the-servers-shutdown-grace-are-one-edit-apart-and-the-file-that-pins-every-other-such-pair-does-not-pin-this-one)).
That is recorded in
[08-operations.md](08-operations.md#what-this-axis-got-right-recorded-because-a-register-that-lists-only-failures-misreads-the-codebase)
at greater length than either of the other two axes that carry such a section,
because on this one the ratio is the finding.

**The second violation of a documented invariant is here**, which is why the
observation at the foot of this file had to be rewritten a second time.
[O8](08-operations.md#o8--lockverdict-asks-staleness-second-docsagentconcurrency-and-ownershipmd-says-it-asks-it-last)
contradicts `docs/agent/concurrency-and-ownership.md:18`, which says staleness is
the *last* question `lockVerdict` asks and names three things settled before it;
`src/lib/serverLock.ts:152` asks it second and two of those three come after. It
is ranked last among the open rows because both orders reach the same verdict.

**And this is the axis where the gap between what could be read and what could
be run is widest.** Docker is unavailable, `DATA_DIR` and `/backups` are both
outside what this uid may read, and no server was started, so every claim about a
running container is a reading of `Dockerfile`, `docker-compose.yml` or
`docker-entrypoint.sh` and says so in the sentence that makes it. Eleven
candidates were dropped for want of evidence against eight filed — the only axis
here whose drop list is longer than its row list. Full accounting in
[00-method.md](00-method.md#the-operations-pass-2026-09-06).

## The fourth pass, 2026-09-06 — no new axis, four rows off the unread ground

**This pass added no seventh axis.** It went to the four regions
[00-method.md](00-method.md#what-was-deliberately-left-unread) names as
deliberately unread and filed what cleared the bar onto the axes that already
exist:
[B6](02-backend-logic.md#b6--the-claude-stream-parser-drops-an-event-type-it-does-not-recognise-without-a-word-and-the-codex-parser-twelve-lines-below-it-says-why-that-is-not-survivable),
[F7](01-frontend.md#f7--the-workflow-editor-is-the-apps-one-drawing-surface-and-it-discards-a-graph-without-asking),
[G5](03-growth.md#g5--the-chat-page-re-reads-and-re-serialises-every-message-in-the-thread-every-three-seconds-and-nothing-bounds-the-thread)
and
[M7](04-missing-features.md#m7--nothing-checks-a-completeness-claim-and-docsagent-is-built-out-of-them).
They are ranked in by the same method rather than appended, so twenty-one of the
thirty-three existing rows changed number and none changed position relative to
another. Nothing already on the register was re-read; every figure above this
section is still 2026-09-06's, and the four new rows were read against the same
tree on the same day.

**One existing row got wider rather than a new row being written.**
[G1](03-growth.md#g1-nine-list-routes-read-parameters-the-one-for-runs-does-not-and-the-pattern-repeats-three-times)
gains a fourth capped list with no parameter — a workflow's instance history, the
newest twenty at `src/lib/workflows.ts:2103`, called with no argument by a route
that reads no `searchParams` (`src/app/api/workflows/[id]/route.ts:29`). Filing
that as its own row would have been G1 in another framing, which the pass was
told not to do and which would in any case have weakened the thing G1 is: an
argument that the shape repeats.

**Two of the four are a first for this register.**
[G5](03-growth.md#g5--the-chat-page-re-reads-and-re-serialises-every-message-in-the-thread-every-three-seconds-and-nothing-bounds-the-thread)
is the first row argued from an `EXPLAIN QUERY PLAN` rather than from a constant
in source — dropped candidate 3 has stood since the survey opened for want of
one, and this pass materialised a schema with `migrate()` against a writable
`DATA_DIR` to get it. And
[M7](04-missing-features.md#m7--nothing-checks-a-completeness-claim-and-docsagent-is-built-out-of-them)
is the first row whose evidence is a **closed** issue whose defect is back:
`gh issue list --state closed` returned 181 issues, two of which (#161, #166)
name a doc count that has since drifted further than it had when they were
filed.

**The strongest of the four is the one the code makes about itself.**
[B6](02-backend-logic.md#b6--the-claude-stream-parser-drops-an-event-type-it-does-not-recognise-without-a-word-and-the-codex-parser-twelve-lines-below-it-says-why-that-is-not-survivable)
does not need a documented invariant to contradict, because the argument against
it is a docblock twelve lines below the function it is about, written when the
second provider arrived and acted on for that provider alone. It is not a third
violation of `docs/agent/`: run-lifecycle.md has no position on this, so it stays
a gap the documentation never had an opinion about — one that the *source* does.

**And this is the first pass that read GitHub.** Titles only, of closed issues
only, through `gh issue list`; nothing was opened, closed, commented on or
edited. The nine issue numbers the register carries as ownership were checked
against that list and none of them appears in it, so all nine are still open —
the first time that column has been confirmed rather than assumed since the
survey was written.

## Ranked

| # | ID | Axis | Gap | Evidence | Blast radius | Cost of leaving it | Conf. | Already owned? |
|---|---|---|---|---|---|---|---|---|
| 1 | [F5](01-frontend.md#f5-nothing-that-renders-is-checked-by-anything) | frontend | Nothing that renders is checked by anything: 20,447 lines of page code, 0 page tests, no jsdom, no browser in CI | `find`/`wc -l`; `npm test` = 2,259/351/0; no jsdom, `@testing-library`, Playwright or Puppeteer in `package.json`; `README.md:983`; `docs/verification.md:1865` | every visual and interactive regression | high and **measurably rising**: +3,918 lines of page code and +681 assertions since `175ba57`, and page components rendered by a test is still 0 | high | #155, adjacent |
| 2 | [B2](02-backend-logic.md#b2-nothing-builds-or-tests-a-branch-before-it-is-merged-and-the-setting-that-looks-like-it-does-has-one-reader) / [M4](04-missing-features.md#m4-nothing-verifies-a-branch-before-it-is-merged) | backend / feature | **SHIPPED IN HALF** (`d1d3119`) — `landVerifyCommand` gates `landRun` (`src/lib/land.ts:999-1006`) and `deliverRun` (`:2941-2947`) against the run's own slot, but has **no Settings field**, so a stock install lands unverified exactly as surveyed; and `resolveVerifyTools` still has one reader and it is still the conflict assist | `src/lib/settings.ts:391`, default `""` at `:891`; `grep -an "landVerifyCommand" src/app/settings/page.tsx` → nothing; `src/lib/land.ts:1362`; the field that *does* exist is `resolveVerifyTools`' at `src/app/settings/page.tsx:3221-3243` | every landed branch on every repository | high — the only row whose failure lands in the operator's product; but lower than surveyed, because the mechanism now exists and one `PUT /api/settings` turns it on | high | no |
| 3 | [B1](02-backend-logic.md#b1-the-landing-guard-covers-landrun-and-none-of-the-other-four-doors) | backend | The `landing` guard covers `landRun` and none of the other **five** exported doors into the same repository | `src/lib/land.ts:228, :970-982, :1079`; the five at `:1254, :1810, :1916, :2104` and **`:2901`**; `resolveCheckout`'s repository-wide `worktree prune` at `:1205`; `MAX_MERGE_WORKERS = 4` at `src/lib/mergeQueue.ts:613` | a repository's git state — refs, worktree admin, the operator's index, and now `origin` | low frequency, high consequence, hard to diagnose after the fact — and one door wider than surveyed | **medium** — scope read from source, no collision reproduced, Docker unavailable | #68, third concern only |
| 4 | [S1](07-security.md#s1-the-all-sessions-branch-of-the-logout-route-takes-no-credential-and-revoking-a-session-does-not-end-it) | security | `POST /api/logout` acts on `all: true` from a caller holding no credential, and revoking a session does not end it: nothing on a request path reads `revoked_at` | `src/middleware.ts:52-54` exempts the route; `src/app/api/logout/route.ts:30-43` reads the cookie on the *other* branch only; `src/lib/sessions.ts:69-72`; the sole reader of `revoked_at` is `activeSessionCount` (`:87-91`) into `src/app/api/settings/route.ts:134`; **contradicts `docs/agent/security.md:26`** | who the app says can reach it, and the one revocation control it offers | standing: `activeSessions` reports bookkeeping rather than reachability every time it is read, and the leaked-cookie remedy at `route.ts:22-23` is the case `docs/agent/security.md:28` records as the one this cannot answer | high | no |
| 5 | [O1](08-operations.md#o1--the-one-restart-condition-the-runbook-alerts-on-never-clears-and-the-count-that-does-is-on-a-route-the-status-token-cannot-reach) | operations | `lastBootReconcile.closed > 0` — the one alertable condition whose whole content is *somebody must act* — never clears, and the count that does clear is on a route the read-only status token cannot reach | `src/lib/status.ts:315-321` fills it from the newest `boot.reconciled` row whenever it was written; `src/lib/orchestrator.ts:11276` writes one only when a run was closed or kept, and the pick-up at `:10615` writes none; `grep -an "restartClosed\|restart_closed" src/lib/status.ts src/app/api/status/route.ts` → nothing; the count is at `src/app/api/runs/restarted/route.ts:22-28` and `src/middleware.ts:114` exempts `/api/status` alone; contrast the two lifetimes reasoned out at `src/app/runs/page.tsx:867-895`; `README.md:250` | every unattended restart, and the credibility of the whole alert table | standing: the app's own runbook goes permanently red on the condition that most needs to be believed, and both ways out of a permanently red alert remove the alert | high — every clause is in the tree; **no restart was performed**, Docker unavailable | no; [M6](04-missing-features.md#m6-a-credential-cannot-be-rotated-without-a-restart-and-a-restart-ends-live-runs) names the same field for a different reason |
| 6 | [M2](04-missing-features.md#m2-one-credential-no-identity-no-authorisation) | feature | One credential, no identity, no authorisation, no per-person revocation | `src/lib/config.ts:286`; `src/lib/requestLog.ts:28-31, :53` | every multi-person use of the product | high on a team, zero solo — the product is single-operator by construction | high mechanism / medium cost | #125, adjacent |
| 7 | [F2](01-frontend.md#f2-quick-open-the-apps-only-search-surface-inherits-that-cap) | frontend | **SHIPPED IN HALF** (`f7617fb`) — the cap is gone, the two-list corpus is not — quick open still indexes panes, runs and workflows and cannot find a chat, a branch, an agent, a template or a schedule | `src/components/shell/QuickOpen.tsx:118-119, :204, :221, :229`, and the input's own label at `:315`; three pages arrived since with nothing indexing them (`/dreaming`, `/runs/[id]/touched`, `/runs/[id]/conflicts`); contrast the real search at `src/app/api/knowledge/search/route.ts:9-19` | all navigation that is not a click | high — a miss is indistinguishable from an absence — but lower than surveyed, because the run half of it is answered | high | no |
| 8 | [B3](02-backend-logic.md#b3-a-chat-turn-exists-nowhere-durable-until-the-child-exits) | backend | A chat turn exists nowhere durable until the child exits — text, `chat_turn_spend` and the thread total are lost together | `src/lib/chat.ts:2358`, `:428`, `:2623-2628`; contrast the `emit()` ordering in `docs/agent/architecture.md` | orchestrator chat, where a model writes half a run | rare and total — a turn lands whole or vanishes whole, and the money is spent either way | high | no |
| 9 | [G2](03-growth.md#g2-chat-threads-past-the-newest-30-cannot-be-reached-at-all) | growth | Chat threads past the newest 30 cannot be reached at all — no paging, no search, no index | `src/lib/chat.ts:387`; `src/app/api/chat/dto.ts:132`; `src/app/api/chat/route.ts:15-27` — the capped list route that reads no `searchParams`, a description `/api/runs` vacated | every past orchestrator conversation | high — approved proposals carry reasoning, on a rolling window nobody chose the width of, and the one-parameter fix its twin got was not carried across | high | no |
| 10 | [O4](08-operations.md#o4--nothing-in-the-app-knows-the-backup-directory-exists-so-no-surface-can-say-when-the-install-was-last-backed-up) | operations | Nothing under `src/` knows the backup directory exists, so no page, route or alert can say when this install was last backed up | `grep -ran "UF_BACKUP_DIR\|backups" src/ --include=*.ts --include=*.tsx` (non-test) → nothing; `UF_BACKUP_DIR` is read by `docker-compose.yml:454` and `scripts/backup-db.mjs` and by nothing in the server; `storeUsage` measures three stores and `README.md:247-249` alerts on all three; `docs/backup-and-restore.md:5-8` — *"There is no second copy anywhere"* | the only copy of every run, setting, workflow and schedule | standing and invisible: an install backed up nightly and one never backed up present identically on every surface. **Not** the scheduler `docs/agent/environment.md:13` refuses — a `readdir` and an `mtime` | high on the absence / consequence argued rather than observed, `/backups` unreadable here | no |
| 11 | [O5](08-operations.md#o5--a-chat-thread-and-every-message-in-it-is-permanent-no-horizon-no-delete-and-the-cascade-has-nothing-to-cascade-from) | operations | A chat thread and every message in it is permanent — no horizon, no delete handler anywhere, and an `ON DELETE CASCADE` with nothing to cascade from | `src/lib/db.ts:604-613`, the cascade at `:606`; no `DELETE` handler under `src/app/api/chat/`, no `deleteChat` in `src/lib/chat.ts`, no archived column; `retention.ts:174, :182, :199, :212, :232, :239` sweep six tables and none is chat's; `docs/agent/retention.md:8`'s permanent set is four things and this is not one; contrast `run_events` at 30 days (`src/lib/settings.ts:904`) | the volume, and anything in a chat that should not be kept | growing with use, with no setting to bound it and no control to trim it; past the thirtieth thread it compounds with [G2](03-growth.md#g2-chat-threads-past-the-newest-30-cannot-be-reached-at-all) — undeletable *and* unreachable | high on the mechanism / **size unmeasured**, `DATA_DIR` unreadable | no |
| 12 | [G1](03-growth.md#g1-nine-list-routes-read-parameters-the-one-for-runs-does-not-and-the-pattern-repeats-three-times) | growth | A pattern, not an incident: three capped lists with no parameter, at 100 / 30 / 25. **The 100 is closed; the other two are untouched** | route survey re-run at `66fdbab`: 68 `route.ts` under `src/app/api`, eleven read `searchParams`; `src/lib/chat.ts:387`; `src/lib/workspace.ts:168, :188` | chats, and which repositories the chat can name | rising with use; the row's own prediction — that each instance is discovered and fixed separately — is what happened | high | partly — #78 owns the third |
| 13 | [O3](08-operations.md#o3--everything-migrate-finds-wrong-with-the-database-it-just-opened-is-a-line-on-stdout-and-nothing-else) | operations | Every fault `migrate()` finds in the database it just opened — a rollback to a schema this build does not know, an orphaned `*_old` table, a stranded table it cannot read — is a `console.error` and nothing else | `src/lib/db.ts:81-85` and `:127-133`; `:2090-2103`; `:1987-1999`; `grep -ran "schemaVerdict\|SCHEMA_VERSION\|user_version" src/` outside `db.ts` and tests → nothing, so no route and no page carries `PRAGMA user_version`; `ops_events` is the durable mechanism and `src/lib/orchestrator.ts:11279` already uses it for the same boot, on the argument at `:11277` | any upgrade or rollback, which is the ordinary deploy | silent when it fires: the state `schemaVerdict` exists to name reaches only the stream that same file was already burned by assuming somebody tails, and which nothing bounds ([O7](08-operations.md#o7--the-containers-own-log-is-a-fourth-unbounded-store-and-compose-asks-for-no-limit-on-it)) | high | no |
| 14 | [G5](03-growth.md#g5--the-chat-page-re-reads-and-re-serialises-every-message-in-the-thread-every-three-seconds-and-nothing-bounds-the-thread) | growth | The chat route re-reads, re-sorts and re-serialises **every** message in the thread on every poll — three seconds while a turn runs, ten otherwise — with no cursor, over a table on no horizon | `src/app/api/chat/dto.ts:58` and that file's own `:96`; `src/lib/chat.ts:410-413`, no `LIMIT`; `src/app/chat/page.tsx:54-55, :460-464`; `EXPLAIN QUERY PLAN` on a schema `migrate()` built here → `SEARCH chat_messages USING INDEX idx_chat_messages_chat | USE TEMP B-TREE FOR ORDER BY`, and `SCAN chat_sessions | USE TEMP B-TREE FOR ORDER BY` beside it; contrast the `after` cursor at `src/app/api/runs/[id]/stream/route.ts:135-141` | every open chat, on the one process [G3](03-growth.md#g3-one-process-is-the-hard-ceiling-and-the-usual-escape-route-is-not-the-one-that-applies) is about | rising with the length of a conversation, with no boundary and no signal at one; compounds with [G2](03-growth.md#g2-chat-threads-past-the-newest-30-cannot-be-reached-at-all) and [O5](08-operations.md#o5--a-chat-thread-and-every-message-in-it-is-permanent-no-horizon-no-delete-and-the-cascade-has-nothing-to-cascade-from) — undeletable, unreachable, and re-read whole | high on the mechanism and the plans / **low** on severity: no thread of any length is readable here, so nothing was timed | no |
| 15 | [G4](03-growth.md#g4-the-audit-trail-is-20000-rows-deep-evicted-on-every-insert-and-identifies-no-person) | growth | The audit trail is 20,000 rows, evicted on every insert, measured in requests rather than time, and names no person | `src/lib/requestLog.ts:68, :119-121, :28-31, :53`; nothing in `retention.ts`; `docs/verification.md:3201` | incident review; any retained-trail requirement | silent — the trail shortens rather than failing | high mechanism / **low** on how many days | no; #91 adjacent |
| 16 | [S3](07-security.md#s3-nine-mutating-route-files-write-no-audit-line-and-six-of-them-are-the-credential-routes) | security | Nine mutating route files write no audit line, six of them the sign-in routes: a sign-in is a row and a sign-out is not | the nine, from the command quoted in [00-method.md](00-method.md#the-security-pass-2026-09-06); `src/app/api/login/route.ts:12, :146` wrapped against `src/app/api/logout/route.ts` unwrapped; `src/lib/requestLog.ts:4-13`; `src/app/api/codex-auth/api-key/route.ts:12-18` reasons about a row's *contents* and not about its absence | incident review of anything credential-shaped | silent, and conditional on a second person the way [M2](04-missing-features.md#m2-one-credential-no-identity-no-authorisation) is; the routes that matter most are the ones with no line | high coverage / **medium** cost | no; #91 adjacent through G4 |
| 17 | [M7](04-missing-features.md#m7--nothing-checks-a-completeness-claim-and-docsagent-is-built-out-of-them) | feature | Nothing in CI, `npm test` or a linter reads a doc, and `docs/agent/` is built out of completeness claims — two of them were filed, closed, and are wrong again | `docs/agent/architecture.md:190` says 22 tables and `:196` calls the list a completeness claim; `grep -aoE 'CREATE TABLE IF NOT EXISTS [a-z_]+' src/lib/db.ts | sort -u | wc -l` → **34**, confirmed by materialising the schema; `CLAUDE.md:61` says thirty-odd `globalThis` keys, `grep -raoE '__uf[A-Za-z0-9_]+' src/ | sort -u | wc -l` → **58**; **#161** and **#166** are closed; `.github/workflows/ci.yml:75, :78, :100, :163` read no doc | the next agent editing `src/lib/`, which is who `docs/agent/` is written for | paid by hand, one issue at a time, at whatever rate the tree grows — sixteen closed issues are each one such correction, and two of the three re-checked here have decayed again | high on both wrong numbers, each a quoted command / **medium** on the sixteen, whose titles were read and whose subjects were not | no; #144, #152 and #154 are closed sweeps of exactly this |
| 18 | [F3](01-frontend.md#f3-a-chat-turn-renders-nothing-until-it-finishes-the-run-path-streams) | frontend | A chat turn renders nothing until it ends; the run path has SSE and lossless reconnect, chat has neither half | `src/lib/chat.ts:2358`; `src/app/chat/page.tsx:462, :1596`; contrast `src/app/api/runs/[id]/stream/route.ts` | every orchestrator chat turn | moderate — the newest surface feels the least alive, and the mechanism is one route away | high mechanism / **assumed** turn length | no; #114 adjacent |
| 19 | [F7](01-frontend.md#f7--the-workflow-editor-is-the-apps-one-drawing-surface-and-it-discards-a-graph-without-asking) | frontend | The workflow editor holds the whole graph in React state until Save, and warns about nothing — no `beforeunload`, no dirty mark, no confirmation on Cancel | `grep -ran "beforeunload" src/` → `src/app/settings/page.tsx` alone (`:2031-2032`, reasoned at `:2008-2024`); `grep -an "dirty\|unsaved\|hasChanges" src/components/WorkflowEditor.tsx` → nothing; the only write is `save()` at `:585-614`; Cancel is a bare `router.push` at `:837`; the arrangement *is* persisted (`:330`) and the graph is not; `MAX_WORKFLOW_NODES = 25` at `src/lib/apiTypes.ts:1595` | every workflow drawn by hand, and every chat-proposed graph adjusted before approval | bounded by how long a graph takes to draw and paid whole each time; nothing is corrupted, the previous save stands | high on the mechanism, all read from source; **no browser was opened** | no |
| 20 | [M5](04-missing-features.md#m5-nothing-can-be-prioritised-the-queue-is-strictly-oldest-first) | feature | **SHIPPED IN HALF** (`d1d3119`) — `runs.priority` orders promotion **and** `queuePosition` through one comparator, so the readout this row headlined is fixed; no page has a control for it | `src/lib/orchestrator.ts:3913, :3938, :3942, :4018` (counting over `queueCompare` at `:4034`), `:10994`; `src/app/api/runs/[id]/priority/route.ts`; `grep -rn "priority" src/app --include=*.tsx` → nothing | scheduling under load | urgent work waits behind a night's schedule — unless the operator can reach the endpoint by hand, which they now can | high mechanism / **assumed** queue depth | no |
| 21 | [B4](02-backend-logic.md#b4-the-install-ceiling-is-checked-once-per-chat-turn-before-it-and-a-turn-has-no-cap) | backend | The install ceiling is checked once per chat turn, before it, and chat has no `live-resume` equivalent. **The title's second clause is wrong: a turn is capped** | `src/lib/chat.ts:2071` is the only install-ceiling call site on the turn path; the cap is `--max-budget-usd` at `:2327-2332` from `chatTurnBudgetUSD` = 2 (`src/lib/settings.ts:903`); `docs/agent/budgets-and-guards.md` | the install's 24-hour ceiling | bounded, not unbounded — the overshoot between checks is at most one `chatTurnBudgetUSD` per admitted turn | high mechanism / **low** severity | #87, adjacent |
| 22 | [B6](02-backend-logic.md#b6--the-claude-stream-parser-drops-an-event-type-it-does-not-recognise-without-a-word-and-the-codex-parser-twelve-lines-below-it-says-why-that-is-not-survivable) | backend | The Claude parser tests four event types and has no fifth branch; the Codex parser twelve lines below it logs an unknown type once per cycle **and its docblock names the Claude parser while arguing why** | `src/lib/orchestrator.ts:7036, :7186, :7221, :7299` and the function ending at `:7360`; the docblock at `:7372-7381`; the `default:` arm at `:7511-7523`; `unknownEventTypes` initialised for every cycle at `:6061` and read by one parser; `selectCycleAdapter` at `:5916` answers Claude for the `null` every non-form caller writes (`docs/agent/run-lifecycle.md:69`) | every work cycle on the default provider, on the day the pinned CLI renames or adds a top-level event | **zero today** — nothing establishes the pin emits a fifth type — and when it fires it is exactly what the docblock describes: a cycle with no cost, no session id and no stop reason, indistinguishable from one that had nothing to say | high on the asymmetry, four line ranges in one file / **assumed** on what the pinned CLI emits | no |
| 23 | [O2](08-operations.md#o2--the-containers-stop-grace-and-the-servers-shutdown-grace-are-one-edit-apart-and-the-file-that-pins-every-other-such-pair-does-not-pin-this-one) | operations | `stop_grace_period: 30s` and `SHUTDOWN_GRACE_MS = 10_000` are one edit apart across two files, and the test file whose entire purpose is that class of pair does not pin them | `docker-compose.yml:590-599` states the coupling in words; `src/lib/orchestrator.ts:10712, :10908`; `grep -an "grace\|stop_\|SIGTERM\|shutdown" src/lib/deployment.test.ts` → nothing, against sixty-odd other pins and that file's own reason at `:456-467`; the failure it would restore is `src/instrumentation.ts:213-220`'s, and `docs/agent/concurrency-and-ownership.md:16` names the half of it that fails **open** | every in-flight cycle's spend on every restart, plus two budget ceilings widened by an `active_started_at` nothing cleared | zero today — 10s plus an 8s kill ladder fits inside 30s — and it fires on exactly the edit somebody makes when a slow agent will not die cleanly | high on the absence; Docker's kill at the grace boundary is read rather than observed | no |
| 24 | [S4](07-security.md#s4-the-no-literal-rule-is-pinned-by-an-assertion-whose-fixture-omits-the-one-notice-that-carries-figures) | security | The "no literal on every sibling's command line" rule is pinned by an assertion whose fixture omits the one notice another test requires to end in a figure | `src/lib/cycleInvocation.ts:1110-1121` joins five notices into one flag; `src/lib/orchestrator.test.ts:2516-2520` asserts two-or-more digits do not appear, over a `base` that never sets `fileCostNotice` (`:2348` shows the production value carrying `— 116k`); `src/lib/fileCostNotice.test.ts:165` requires every price line to *end* in a figure | the fleet, through the mechanism `docs/agent/security.md:22` records as having ended fourteen runs | zero until a notice or the price list's rendering is edited, and the flag went from one notice to five since the incident | high scoping / **medium** severity | no |
| 25 | [M1](04-missing-features.md#m1-the-app-can-push-nothing-and-open-no-pull-request) | feature | **SHIPPED IN HALF** (`d1d3119`) — `deliverRun` pushes and opens a pull request from one endpoint, but has no button and, so far as anything readable from here shows, **has never opened a real one** | `src/lib/land.ts:2901`; `src/lib/delivery.ts:79, :140`; `src/app/api/runs/[id]/deliver/route.ts`; `grep -rn "deliver" src/app --include=*.tsx` → nothing; the "no real PR" half is **assumed** — `DATA_DIR` is unreadable | any team whose review gate is a PR | high for them, zero for a solo operator — and it is now reachable by hand rather than absent | high mechanism / **assumed** demand | #99, adjacent |
| 26 | [B5](02-backend-logic.md#b5-the-chat-can-identify-only-the-first-25-repositories-always-the-same-25) | backend | The chat can name only the first 25 git repositories, in scan order, permanently — no offset, no filter | `src/lib/workspace.ts:168, :186-188, :208` | installs with 25+ repositories mounted | absolute past the boundary, invisible from the UI, reads to the operator as a broken repository | high mechanism / **low** on how many installs cross it | **#78**, suspicion 2 — confirmed here |
| 27 | [O7](08-operations.md#o7--the-containers-own-log-is-a-fourth-unbounded-store-and-compose-asks-for-no-limit-on-it) | operations | The container's own log is a fourth store on the same disk: written by this app at volume, bounded by nothing in this repository, measured by nothing and alerted on by nothing | `grep -rn "logging:" docker-compose*.yml` → nothing, and it is the only compose file in the tree; `README.md:260-276` — ten JSON event kinds plus the prose, with `run.sandbox_refusal` on it deliberately because *"at twenty-five unattended runs the run page is not where anyone finds that out"*; contrast the three stores `retention.ts` bounds, `storeUsage` measures and `README.md:247-249` alerts on | the host disk, on the machine the whole fleet runs on | unknown and unbounded: on a disk that fills, the three stores this app watches are the three that are not the problem | **medium** — that compose sets no limit is certain; that the daemon's default is unbounded is Docker's documented default and **was not checked here**, no container | no |
| 28 | [S2](07-security.md#s2-the-status-route-authenticates-a-browser-against-the-master-token-which-the-session-cookie-stopped-being) | security | `/api/status` authenticates a browser by comparing `uf_session` against `UF_AUTH_TOKEN`, which the cookie stopped being; the test covering it supplies a cookie the login route can no longer issue | `src/app/api/status/route.ts:50-53`; `docs/agent/security.md:28` for the cookie's shape; `src/lib/sessionToken.test.ts:59` rejects a cookie equal to the token; `src/app/api/status/route.test.ts:235-241`; `docs/install.md:292, :719, :728` point an operator at the URL | one route, and it fails in the closed direction | low and constant: a 401 to the person who owns the install, behind a green test that proves nothing | high mechanism / the 401 **read rather than observed** | no |
| 29 | [M6](04-missing-features.md#m6-a-credential-cannot-be-rotated-without-a-restart-and-a-restart-ends-live-runs) | feature | A credential cannot be rotated without a restart, and a restart terminates live runs | module-level consts at `src/lib/config.ts:286, :366, :422-447`; five more environment-only values arrived with the webhook (`:467, :475, :485, :488, :505`); `README.md:250` alert on `lastBootReconcile.closed > 0` | every secret the install holds | measured in reluctance; the vault's 19%-after-16-days is what deferral looks like | high mechanism / medium framing | #89, over cap |
| 30 | [O6](08-operations.md#o6--plan_observations-grows-at-every-boundary-is-swept-by-nothing-and-is-read-by-nothing) | operations | `plan_observations` takes a row at every cycle boundary, is on no horizon, is on no permanent list, and is read by nothing | `src/lib/db.ts:1653, :1673-1674`; written by `src/lib/contextPruning.ts:2727-2757` from `src/lib/orchestrator.ts:6714` ← `:6458` ← `settleBoundary` at `:6367, :6406, :6431, :8654`; `orchestrator.ts:9649` says its answer *"was read by nothing"*; absent from `retention.ts`'s six sweeps and from `docs/agent/retention.md:8`'s permanent set, as are seven other tables | the volume, slowly | **near zero** — the rows are small, and the class is what is worth filing: `retention.ts` divides every table into evidence-with-a-horizon or permanent-by-decision, and eight are in neither | high on every clause / the rate is arithmetic from the call sites, not a measurement | no |
| 31 | [G3](03-growth.md#g3-one-process-is-the-hard-ceiling-and-the-usual-escape-route-is-not-the-one-that-applies) | growth | One process is the hard ceiling, and the ceiling is written down nowhere an operator planning capacity would find it | `src/lib/serverLock.ts:214, :394`; `MAX_WORKTREE_SLOTS = 64` at `src/lib/orchestrator.ts:3196`, `MAX_MERGE_WORKERS = 4` at `src/lib/mergeQueue.ts:613`; nothing in `docs/install.md` | whether an install can grow past one machine | **zero today**, unbounded later; the real gap is an unstated product position, not a missing mechanism | high mechanism / medium severity | no |
| 32 | [S5](07-security.md#s5-the-one-write-path-the-edge-gate-exempts-buffers-an-unbounded-body) | security | The one write path the edge gate exempts buffers an unbounded body, in the single process that also runs every agent | `src/app/api/otlp/v1/logs/route.ts:39, :53, :57`; nothing in `next.config.ts`; `src/lib/otlp.ts:495` bounds output rather than input; contrast `scripts/discord-relay.mjs:106-107` and `src/lib/requestLog.ts:78-82`, two boundaries with less reach that both cap | the single process, which is [G3](03-growth.md#g3-one-process-is-the-hard-ceiling-and-the-usual-escape-route-is-not-the-one-that-applies)'s subject | **zero today**; nothing establishes that any child has sent a large body | high on the absence / **assumed** that the runtime imposes no cap of its own | no |
| 33 | [O8](08-operations.md#o8--lockverdict-asks-staleness-second-docsagentconcurrency-and-ownershipmd-says-it-asks-it-last) | operations | `lockVerdict` asks staleness **second** of four questions; `docs/agent/concurrency-and-ownership.md:18` says it asks it last and names as settled-before-it two tests that come after. **The register's second violation of a documented invariant** | `src/lib/serverLock.ts:146-155` against its own `:66-71` and `docs/agent/concurrency-and-ownership.md:18`; the one case the order moves is a stale lock whose pid is dead — what a server killed without releasing leaves behind — claimed at `:152` rather than through `OBSERVE_MS` at `claimDataDir:343-346` | none: both orders reach `claim`, and the code's is the faster of the two | **zero today**, and filed anyway because the false enumeration *is* the argument that `STALE_MS` may be large (`:66-67`) — it is what the next editor of that constant will reason from | high; nothing was run against a live lock | no |
| 34 | [F1](01-frontend.md#f1-run-history-stops-at-100-rows-and-cannot-be-paged-filtered-or-searched) | frontend | **CLOSED** (`7405720`, `d77638d`) — run history pages, filters and searches over every matching row | `src/app/api/runs/route.ts:77-97`; `src/lib/orchestrator.ts:965, :999, :1027`; `src/app/runs/page.tsx:676, :993-1099`; `grep -rn "SERVER_LIMIT" src/` → nothing | — | **zero** — closed whole. The four-second poll at `:642` still asks with no parameters, deliberately | high | no |
| 35 | [F4](01-frontend.md#f4-a-runs-log-cannot-be-searched-or-filtered) | frontend | **CLOSED** (`e250524`, `e16fd7f`) — a text box and a kind picker over the events the page already holds, with the truncated-replay count stated when a filter is on | `src/lib/logLine.ts:691, :716, :730`; `src/app/runs/[id]/page.tsx:511-512, :650-660, :1804-1826`; `src/app/api/runs/[id]/stream/route.ts:135-141` | — | **zero** — closed whole | high | no |
| 36 | [F6](01-frontend.md#f6-settings-is-nine-sections-in-a-3502-line-page-with-no-way-to-find-a-field) | frontend | **CLOSED** (`a8f2984`, `bdbdf08` — the `beforeunload` prompt this row filed as an issue rather than a row) — the page is findable; it is not smaller | `src/app/settings/page.tsx:105-117` (ten sections now, 4,298 lines), `:191`, `:200-222`, `:2357-2392`, `:2426`, `:2031-2032` | — | **zero** — closed whole. The tenth section (Dreaming, `:3923`) arrived after the fix and the search found it without being told | high | no |
| 37 | [M3](04-missing-features.md#m3-nothing-this-app-runs-can-reach-a-human-and-most-of-that-is-on-purpose) | feature | **CLOSED** (`1891ad7`, `0d6af15`) — one signed JSON body to one operator-named URL when a run ends needing a person; success is opt-in | `src/lib/notify.ts:107-111` (`needs-review`, `blocked`, `failed`), `:296`, `:301`, `:322`, `:422`; `src/lib/config.ts:467, :475, :485, :488, :505`, environment-only for the reason at `:450-466`; `README.md:236-253` is fifteen alertable conditions now and the fifteenth watches the channel | — | **zero** — closed whole. A stock install still has no channel, because blank is the shipped value and that is the design rather than the gap | high | was mostly owned by `README.md`'s own position |

## How the ranking was made

Three inputs, in this order. Unchanged from the survey; the `66fdbab` refresh
re-applied the method rather than replacing it, and the security and operations
passes ranked their five and eight rows by the same one rather than appending
them.

**Cost of leaving it, now.** Not blast radius. A gap that is catastrophic and
has never fired ranks below one that costs something every week. This is why
row 3 sits below row 2 despite the widest radius here, and why rows 31 and 32
are near the bottom of the open rows despite carrying the two unbounded ones.
Row 33 is below both and is the clearest case the rule has: it contradicts a
documented invariant and costs nothing, because there the code is safer than the
sentence. Row 22 is the fourth pass's application of the same rule:
[B6](02-backend-logic.md#b6--the-claude-stream-parser-drops-an-event-type-it-does-not-recognise-without-a-word-and-the-codex-parser-twelve-lines-below-it-says-why-that-is-not-survivable)
is a total loss of a cycle's accounting that has never fired, so it sits below
[B4](02-backend-logic.md#b4-the-install-ceiling-is-checked-once-per-chat-turn-before-it-and-a-turn-has-no-cap),
whose overshoot is bounded, small and real.

**A closed row costs nothing to leave**, so rows 34 to 37 sit at the bottom. They
keep their place in the table rather than being deleted, because the sections
they index are the ledger and a register that quietly drops what it got
fixed cannot be audited against itself.

**Confidence, as a discount rather than a filter.** A medium-confidence row
stays on the register and moves down. Five rows carry an explicitly assumed
premise in the Conf. column — the fifth is
[B6](02-backend-logic.md#b6--the-claude-stream-parser-drops-an-event-type-it-does-not-recognise-without-a-word-and-the-codex-parser-twelve-lines-below-it-says-why-that-is-not-survivable)'s,
that the pinned CLI emits only the four top-level event types the code handles,
which is read off the code rather than off a running CLI — and the original four
are: [M1](04-missing-features.md#m1-the-app-can-push-nothing-and-open-no-pull-request)'s demand,
[M5](04-missing-features.md#m5-nothing-can-be-prioritised-the-queue-is-strictly-oldest-first)'s queue depth,
[F3](01-frontend.md#f3-a-chat-turn-renders-nothing-until-it-finishes-the-run-path-streams)'s turn length and
[S5](07-security.md#s5-the-one-write-path-the-edge-gate-exempts-buffers-an-unbounded-body)'s
premise that the runtime imposes no body cap of its own, and all four are ranked
as if that assumption is even money. Three more mark one in their axis section
rather than in the table: [B3](02-backend-logic.md#b3-a-chat-turn-exists-nowhere-durable-until-the-child-exits)'s absence of a recovery path elsewhere,
[B5](02-backend-logic.md#b5-the-chat-can-identify-only-the-first-25-repositories-always-the-same-25)'s premise that installs with more than 25
repositories exist, and
[S2](07-security.md#s2-the-status-route-authenticates-a-browser-against-the-master-token-which-the-session-cookie-stopped-being)'s
401, which is read out of the code rather than observed from a browser. M1 now
carries a second one: that no real pull request has been opened.

**Every operations row carries one, and on this axis the assumption is always the
same one**: no container was run, so what a live install does is read out of the
file that configures it.
[O7](08-operations.md#o7--the-containers-own-log-is-a-fourth-unbounded-store-and-compose-asks-for-no-limit-on-it)
is the only one discounted to medium for it, because it is the only one whose
*consequence* rests on a default this repository does not set. The other seven
are high-confidence about an absence in the tree and say in their own text which
half was not observed —
[O1](08-operations.md#o1--the-one-restart-condition-the-runbook-alerts-on-never-clears-and-the-count-that-does-is-on-a-route-the-status-token-cannot-reach)
performed no restart,
[O2](08-operations.md#o2--the-containers-stop-grace-and-the-servers-shutdown-grace-are-one-edit-apart-and-the-file-that-pins-every-other-such-pair-does-not-pin-this-one)
never watched Docker kill anything,
[O4](08-operations.md#o4--nothing-in-the-app-knows-the-backup-directory-exists-so-no-surface-can-say-when-the-install-was-last-backed-up)
never listed `/backups`,
[O5](08-operations.md#o5--a-chat-thread-and-every-message-in-it-is-permanent-no-horizon-no-delete-and-the-cascade-has-nothing-to-cascade-from)
and [O6](08-operations.md#o6--plan_observations-grows-at-every-boundary-is-swept-by-nothing-and-is-read-by-nothing)
counted no rows.

**Whether something already owns it, as a tiebreak only.** An owned gap is still
a gap; it just should not become a new proposal. Twelve rows name an issue
number — the twelfth is
[M7](04-missing-features.md#m7--nothing-checks-a-completeness-claim-and-docsagent-is-built-out-of-them),
and it is the only one whose numbers are *closed* rather than open, which is the
row's argument rather than its ownership. Of the other eleven: eight carry it as ownership and three
([G4](03-growth.md#g4-the-audit-trail-is-20000-rows-deep-evicted-on-every-insert-and-identifies-no-person),
[F3](01-frontend.md#f3-a-chat-turn-renders-nothing-until-it-finishes-the-run-path-streams) and now
[S3](07-security.md#s3-nine-mutating-route-files-write-no-audit-line-and-six-of-them-are-the-credential-routes))
name an adjacent one while answering *no*, and only
[B5](02-backend-logic.md#b5-the-chat-can-identify-only-the-first-25-repositories-always-the-same-25) is owned squarely rather than adjacently. **All five
security rows, all eight operations rows and all four of the fourth pass's answer
*no*.** No number was re-read on the `66fdbab` refresh or on the security or
operations passes (no GitHub issue was opened, closed, commented on or fetched
by any of the three). The fourth pass read one thing and nothing else:
`gh issue list --repo Xapicc/UsageFoundry --state closed --limit 300`, titles
only, writing nothing. **None of #68, #78, #87, #89, #91, #99, #114, #125 or
#155 appears in those 181 closed issues, so all nine are still open** — confirmed
rather than assumed, for the first time since `175ba57`. What is still assumed is
everything about their *contents*: no issue body was fetched, so whether an open
issue still describes what the register says it owns is unchecked. The one operations row that points anywhere points inside this
register rather than at an issue:
[O1](08-operations.md#o1--the-one-restart-condition-the-runbook-alerts-on-never-clears-and-the-count-that-does-is-on-a-route-the-status-token-cannot-reach)
names the same `/api/status` field
[M6](04-missing-features.md#m6-a-credential-cannot-be-rotated-without-a-restart-and-a-restart-ends-live-runs)
already cites, for a different reason — M6 is about what a restart costs, O1 is
about what the field then reports.

## What moved in the ranking, and why

One sentence each. Rows not listed here did not move relative to the rows around
them.

**The arrows below are the `175ba57` survey's ranks against the `66fdbab`
refresh's, and they are left as they were written.** The security pass then
inserted five rows into that order without re-ranking any of it, which pushed
seventeen of the twenty down by one, two, three or five places purely by
displacement: M2 4→5, F2 5→6, B3 6→7, G2 7→8, G1 8→9, G4 9→10, F3 10→12,
M5 11→13, B4 12→14, M1 13→16, B5 14→17, M6 15→19, G3 16→20, F1 17→22, F4 18→23,
F6 19→24, M3 20→25. Read against each other they are unmoved, and that is the
point of recording the displacement separately rather than rewriting the arrows:
no cost was re-judged on this pass.

**The operations pass then did the same thing again**, inserting eight rows
without re-ranking any of the twenty-five, which displaced twenty of them:
M2 5→6, F2 6→7, B3 7→8, G2 8→9, G1 9→12, S3 11→15, F3 12→16, M5 13→17,
B4 14→18, S4 15→20, M1 16→21, B5 17→22, S2 18→24, M6 19→25, G3 20→27, S5 21→28,
F1 22→30, F4 23→31, F6 24→32, M3 25→33. F5, B2/M4, B1 and S1 hold 1 to 4.
**Read against each other all twenty-five are unmoved**, and the two lists below
keep the ranks each pass wrote at the time rather than being rewritten to the
current table — the arrows are a record of a judgement, and a judgement
renumbered by somebody else's insertion is no longer the one that was made.

**The fourth pass did it a third time**, inserting four rows into the
thirty-three without re-ranking any of them, which displaced twenty-one:
G4 14→15, S3 15→16, F3 16→18, M5 17→20, B4 18→21, O2 19→23, S4 20→24, M1 21→25,
B5 22→26, O7 23→27, S2 24→28, M6 25→29, O6 26→30, G3 27→31, S5 28→32, O8 29→33,
F1 30→34, F4 31→35, F6 32→36, M3 33→37 — and G1 held 12, which is the one worth
noticing, because that row got *wider* on this pass without getting dearer. The
first thirteen are untouched. **Read against each other all thirty-three are
unmoved.**

Where the four new rows went, and why.

- **[G5](03-growth.md#g5--the-chat-page-re-reads-and-re-serialises-every-message-in-the-thread-every-three-seconds-and-nothing-bounds-the-thread) at 14**, immediately under
  [G1](03-growth.md#g1-nine-list-routes-read-parameters-the-one-for-runs-does-not-and-the-pattern-repeats-three-times)
  and [O3](08-operations.md#o3--everything-migrate-finds-wrong-with-the-database-it-just-opened-is-a-line-on-stdout-and-nothing-else)
  and above [G4](03-growth.md#g4-the-audit-trail-is-20000-rows-deep-evicted-on-every-insert-and-identifies-no-person),
  because it costs something on every poll of every open chat rather than at a
  boundary, and below the three above it because how much it costs is the one
  thing this pass could not measure.
- **[M7](04-missing-features.md#m7--nothing-checks-a-completeness-claim-and-docsagent-is-built-out-of-them) at 17**, beside the two rows about a record that
  is quietly incomplete —
  [G4](03-growth.md#g4-the-audit-trail-is-20000-rows-deep-evicted-on-every-insert-and-identifies-no-person)
  and [S3](07-security.md#s3-nine-mutating-route-files-write-no-audit-line-and-six-of-them-are-the-credential-routes)
  — and under both, because their incompleteness costs an operator an incident
  review and this one costs an editor a wrong belief.
- **[F7](01-frontend.md#f7--the-workflow-editor-is-the-apps-one-drawing-surface-and-it-discards-a-graph-without-asking) at 19**, directly under
  [F3](01-frontend.md#f3-a-chat-turn-renders-nothing-until-it-finishes-the-run-path-streams):
  both are one surface behaving worse than the equivalent beside it, and F3's
  costs something on every chat turn where this costs something only when a tab
  closes on unsaved work.
- **[B6](02-backend-logic.md#b6--the-claude-stream-parser-drops-an-event-type-it-does-not-recognise-without-a-word-and-the-codex-parser-twelve-lines-below-it-says-why-that-is-not-survivable) at 22**, in the band of rows that cost nothing
  today and fire on a specific future edit —
  [O2](08-operations.md#o2--the-containers-stop-grace-and-the-servers-shutdown-grace-are-one-edit-apart-and-the-file-that-pins-every-other-such-pair-does-not-pin-this-one)
  at 23 and [S4](07-security.md#s4-the-no-literal-rule-is-pinned-by-an-assertion-whose-fixture-omits-the-one-notice-that-carries-figures)
  at 24 — and at the top of that band, because the edit that fires it is not one
  this repository makes: it is the CLI pin moving, which has already moved once
  inside the window `docs/agent/run-lifecycle.md:117` records.

Where the five security rows went, and why. **The numbers are the security
pass's own**; the mapping above gives each one's rank in the table as it now
stands:

- **[S1](07-security.md#s1-the-all-sessions-branch-of-the-logout-route-takes-no-credential-and-revoking-a-session-does-not-end-it) at 4.** Below B1 because B1's radius is a
  repository's git state on every landing, above M2 because S1's cost is standing
  rather than conditional on a second operator: the figure that reports who is
  signed in is wrong about access every time it is read.
- **[S3](07-security.md#s3-nine-mutating-route-files-write-no-audit-line-and-six-of-them-are-the-credential-routes) at 11, immediately below
  [G4](03-growth.md#g4-the-audit-trail-is-20000-rows-deep-evicted-on-every-insert-and-identifies-no-person).**
  The pairing is the argument: G4 is how long the trail is, S3 is what never
  enters it, and a line that was evicted at least existed.
- **[S4](07-security.md#s4-the-no-literal-rule-is-pinned-by-an-assertion-whose-fixture-omits-the-one-notice-that-carries-figures) at 15.** Below B4 because B4's overshoot is
  occasional real money and S4 costs nothing until somebody edits a notice, above
  M1 because the failure behind it has fired twice with fourteen runs lost.
- **[S2](07-security.md#s2-the-status-route-authenticates-a-browser-against-the-master-token-which-the-session-cookie-stopped-being) at 18.** It fails closed, so what it costs is
  a capability rather than an exposure; below B5, whose boundary is absolute past
  25 repositories, and above M6, which is measured in reluctance.
- **[S5](07-security.md#s5-the-one-write-path-the-edge-gate-exempts-buffers-an-unbounded-body) at 21, last among the open rows.**
  [G3](03-growth.md#g3-one-process-is-the-hard-ceiling-and-the-usual-escape-route-is-not-the-one-that-applies)'s
  reasoning exactly (zero today, unbounded later) plus an assumed premise G3 does
  not carry, so it sits one below it.

Where the eight operations rows went, and why. These are ranks in the table
above:

- **[O1](08-operations.md#o1--the-one-restart-condition-the-runbook-alerts-on-never-clears-and-the-count-that-does-is-on-a-route-the-status-token-cannot-reach) at 5, above M2.** The highest row this pass filed,
  and the reasoning is the method's first input rather than deference to the
  axis: M2's cost is explicitly *"high on a team, zero solo"* and nothing here
  establishes which this install is, where O1 costs something on every restart of
  an app that restarts on every upgrade and every credential rotation. Below S1
  because S1 is a door and this is a readout.
- **[O4](08-operations.md#o4--nothing-in-the-app-knows-the-backup-directory-exists-so-no-surface-can-say-when-the-install-was-last-backed-up) at 10 and
  [O5](08-operations.md#o5--a-chat-thread-and-every-message-in-it-is-permanent-no-horizon-no-delete-and-the-cascade-has-nothing-to-cascade-from)
  at 11, between G2 and G1.** Both are standing and both are about the store
  rather than the surface. O4 above O5 because what O4 cannot report is whether
  the only copy of everything has a second copy, and O5's cost accrues gradually.
  Both above the capped-list rows because a cap is an inconvenience and a missing
  backup is an ending.
- **[O3](08-operations.md#o3--everything-migrate-finds-wrong-with-the-database-it-just-opened-is-a-line-on-stdout-and-nothing-else) at 13, between G1 and G4.** Conditional on an
  upgrade going wrong, which is not rare and is not today; ranked as an
  observability gap of the same weight as G4's shortening trail, and directly
  above it because a fault nobody is told about is worse than a record that runs
  short.
- **[O2](08-operations.md#o2--the-containers-stop-grace-and-the-servers-shutdown-grace-are-one-edit-apart-and-the-file-that-pins-every-other-such-pair-does-not-pin-this-one) at 19, immediately above S4.** The same shape —
  zero until somebody edits one of two numbers — and above S4 because what the
  edit costs is every in-flight cycle's accounting plus two ceilings that then
  fail open, against S4's one flag.
- **[O7](08-operations.md#o7--the-containers-own-log-is-a-fourth-unbounded-store-and-compose-asks-for-no-limit-on-it) at 23.** Unbounded growth on the host disk of the
  machine the fleet runs on, discounted a long way for the one thing this pass
  could not check: whether anything outside this repository bounds it. Below B5,
  whose boundary is absolute, above S2, which fails closed.
- **[O6](08-operations.md#o6--plan_observations-grows-at-every-boundary-is-swept-by-nothing-and-is-read-by-nothing) at 26.** Real, growing, and the cheapest row on
  the register: small rows, no reader, no horizon. Above G3 only because it is
  accruing now rather than later.
- **[O8](08-operations.md#o8--lockverdict-asks-staleness-second-docsagentconcurrency-and-ownershipmd-says-it-asks-it-last) at 29, last among the open rows.** It has the
  strongest evidence on the register — a documented invariant contradicted by the
  function beside it — and the lowest cost, because both orders reach the same
  verdict and the code's is the faster. That combination is what the ranking rule
  is for, and this is the plainest instance of it here.

- **[F5](01-frontend.md#f5-nothing-that-renders-is-checked-by-anything) 2 → 1.** It is the one row whose cost is a function of
  how much code there is, and the code grew 24% while the thing that checks it
  stayed at zero — which is the row's claim making itself true rather than an
  argument for it.
- **[B2](02-backend-logic.md#b2-nothing-builds-or-tests-a-branch-before-it-is-merged-and-the-setting-that-looks-like-it-does-has-one-reader)/[M4](04-missing-features.md#m4-nothing-verifies-a-branch-before-it-is-merged) 1 → 2.** The gate exists and runs against
  the right tree; what is left is a Settings field and a naming clash, which is
  a smaller thing to leave than "there is no gate".
- **[B1](02-backend-logic.md#b1-the-landing-guard-covers-landrun-and-none-of-the-other-four-doors) 6 → 3.** A sixth door was added, it is the only one
  that reaches GitHub, and it took neither of the two checks — the exposure grew
  and the guard did not, for the second time on this row.
- **[F2](01-frontend.md#f2-quick-open-the-apps-only-search-surface-inherits-that-cap) 4 → 5.** Half of it closed, so half of the cost went
  with it.
- **[G2](03-growth.md#g2-chat-threads-past-the-newest-30-cannot-be-reached-at-all) 9 → 7** and
  **[G1](03-growth.md#g1-nine-list-routes-read-parameters-the-one-for-runs-does-not-and-the-pattern-repeats-three-times) 11 → 8.** Neither cost changed; they rise because
  four rows above them closed or shrank, and G2 in particular is now the exact
  description `/api/runs` vacated.
- **[M5](04-missing-features.md#m5-nothing-can-be-prioritised-the-queue-is-strictly-oldest-first) 12 → 11** and
  **[M1](04-missing-features.md#m1-the-app-can-push-nothing-and-open-no-pull-request) 7 → 13.** Both shipped in half; M1 falls further
  because its remaining half is a button on a capability that also rests on an
  assumed demand, while M5's remaining half is a control on a lever that already
  works and already has an endpoint.
- **[B4](02-backend-logic.md#b4-the-install-ceiling-is-checked-once-per-chat-turn-before-it-and-a-turn-has-no-cap) 10 → 12.** Half its claim is refuted: the overshoot
  it warns about is bounded by `chatTurnBudgetUSD` rather than unbounded, so the
  cost of leaving it is a known number instead of an unmeasured one.
- **[G3](03-growth.md#g3-one-process-is-the-hard-ceiling-and-the-usual-escape-route-is-not-the-one-that-applies) 20 → 16.** No change in cost; it is last among the
  open rows, as it was, and only the closed rows moved past it.
- **[F1](01-frontend.md#f1-run-history-stops-at-100-rows-and-cannot-be-paged-filtered-or-searched) 3 → 17,
  [F4](01-frontend.md#f4-a-runs-log-cannot-be-searched-or-filtered) 15 → 18,
  [F6](01-frontend.md#f6-settings-is-nine-sections-in-a-3502-line-page-with-no-way-to-find-a-field) 18 → 19,
  [M3](04-missing-features.md#m3-nothing-this-app-runs-can-reach-a-human-and-most-of-that-is-on-purpose) 19 → 20.** Closed whole; nothing is left to leave.

## What the shape of the register says

Four observations that no individual row carries. The first survives every pass
and is now demonstrated rather than argued. **The second is widened by the
operations pass, the third was rewritten by the security pass and is amended
again below, and the fourth is new with this axis.**

**Nine of thirty-seven rows are one sentence: the app cannot find what it has
already done.** [F1](01-frontend.md#f1-run-history-stops-at-100-rows-and-cannot-be-paged-filtered-or-searched), [F2](01-frontend.md#f2-quick-open-the-apps-only-search-surface-inherits-that-cap), [F4](01-frontend.md#f4-a-runs-log-cannot-be-searched-or-filtered),
[F6](01-frontend.md#f6-settings-is-nine-sections-in-a-3502-line-page-with-no-way-to-find-a-field), [G1](03-growth.md#g1-nine-list-routes-read-parameters-the-one-for-runs-does-not-and-the-pattern-repeats-three-times), [G2](03-growth.md#g2-chat-threads-past-the-newest-30-cannot-be-reached-at-all),
[G4](03-growth.md#g4-the-audit-trail-is-20000-rows-deep-evicted-on-every-insert-and-identifies-no-person) and [B5](02-backend-logic.md#b5-the-chat-can-identify-only-the-first-25-repositories-always-the-same-25) are all reachability — a cap without a
parameter, a corpus without an index, a log without a filter, a page without a
search. [F5](01-frontend.md#f5-nothing-that-renders-is-checked-by-anything) is the same failure applied to the code itself.
This is the single largest theme and it is not how any of them would be filed
individually.

Three of those eight are now closed whole (F1, F4, F6) and one in half (F2),
which leaves F5, G1, G2, G4 and B5 open plus F2's corpus — and leaves the
observation itself intact, because they *were* fixed as four separate changes on
one branch. [G2](03-growth.md#g2-chat-threads-past-the-newest-30-cannot-be-reached-at-all) has the same one-parameter fix as F1 and
still has not got it, and three more pages have been added since with nothing
indexing what they hold.

**The fourth pass moved this theme in both directions at once, and neither move
is a new row.** No row it filed is a reachability row, so the count stays at nine
while the denominator goes to thirty-seven — 27% of the register down to 24%.
But the theme's *evidence* got one instance stronger inside
[G1](03-growth.md#g1-nine-list-routes-read-parameters-the-one-for-runs-does-not-and-the-pattern-repeats-three-times):
a workflow's own history is the newest twenty presses of Run, permanently, on a
route that reads no parameters (`src/lib/workflows.ts:2103`,
`src/app/api/workflows/[id]/route.ts:29`), found in a file nobody had read for
this. That is the fourth cap of the shape and the second one discovered after the
survey closed, which is what G1 predicted would keep happening. **The share is
smaller and the claim is better supported**, and those two are not in tension:
adding rows on axes the theme does not touch is what dilutes a share.

**The chat surface carries five rows ([B3](02-backend-logic.md#b3-a-chat-turn-exists-nowhere-durable-until-the-child-exits), [B4](02-backend-logic.md#b4-the-install-ceiling-is-checked-once-per-chat-turn-before-it-and-a-turn-has-no-cap),
[F3](01-frontend.md#f3-a-chat-turn-renders-nothing-until-it-finishes-the-run-path-streams),
[O5](08-operations.md#o5--a-chat-thread-and-every-message-in-it-is-permanent-no-horizon-no-delete-and-the-cascade-has-nothing-to-cascade-from)
and half of [G2](03-growth.md#g2-chat-threads-past-the-newest-30-cannot-be-reached-at-all)) and the run
surface carries none of the equivalents.** Every mechanism chat lacks —
incremental persistence, publish-after-persist, a mid-flight guard, a paged
list — exists in this repository, built for runs, documented in
`docs/agent/architecture.md` and `docs/agent/budgets-and-guards.md`. Chat is the
newest surface and it did not inherit them. `src/lib/chat.ts` went from 2,397
lines to 3,065 between `175ba57` and `66fdbab` and inherited none of them in that
window either.

**The operations pass added a fifth and it is the same failure inverted, which
is what makes it worth adding rather than a repetition.** Retention is the
mechanism chat did not inherit
([O5](08-operations.md#o5--a-chat-thread-and-every-message-in-it-is-permanent-no-horizon-no-delete-and-the-cascade-has-nothing-to-cascade-from)):
`run_events` has a horizon, a sweep, an operator-visible count and a documented
promise about what survives it, and `chat_messages` has none of the four and no
delete path either. Where the run surface *discards* evidence on a schedule and
keeps the row, chat keeps everything and can reach only the newest thirty of it.
Four of the five are one issue by
[06-recommendation.md](06-recommendation.md)'s reading; this one is not, because
what it needs is a decision about what a chat is for rather than a mechanism
copied across.

**Two rows of thirty-three violate a documented invariant, and both took adding
an axis where `docs/agent/` has opinions to find.** The original
observation read *"nothing on the register is a violation of a documented
invariant"*, and it was true of the four axes it was written against: every row
there is something `docs/agent/` never had a position on, and re-reading them at
`66fdbab` found no new one.

`docs/agent/security.md` is thirty paragraphs of stated position, so it is the
one file the claim could actually be tested against, and the test found exactly
one failure.
[S1](07-security.md#s1-the-all-sessions-branch-of-the-logout-route-takes-no-credential-and-revoking-a-session-does-not-end-it)
contradicts `docs/agent/security.md:26`: the exemption of `/api/logout` from the
edge gate is justified by *"it revokes the id inside the cookie it is handed"*,
and the `all: true` branch is handed no cookie, reads none, and revokes every
id. The same row's second half contradicts nothing and is worse for it: `all:
true` is offered at `src/app/api/logout/route.ts:22-23` as the remedy for a
cookie that got out, which is the one case `docs/agent/security.md:28` records
this mechanism as unable to answer.

**The second is
[O8](08-operations.md#o8--lockverdict-asks-staleness-second-docsagentconcurrency-and-ownershipmd-says-it-asks-it-last),
against `docs/agent/concurrency-and-ownership.md:18`**, and it fails in the
opposite direction: the sentence says staleness is the *last* question
`lockVerdict` asks and names three tests settled before it, where
`src/lib/serverLock.ts:152` asks it second and two of the three come after. The
behaviour is unaffected — both orders reach `claim` — so unlike S1 this costs
nothing, and it is on the register because the false enumeration *is* the
argument that `STALE_MS` may be large. **Both violations are a sentence written
about one path of a function that has several**, which is a more specific finding
than either row alone and is the only pattern two instances can support.

**The original claim's corollary holds and is strengthened again.** Four
candidates died on the first four axes as documented decisions rather than
surviving as rows; six more died on the security axis and eight on the
operations axis the same way, which is the highest count of any axis here. Where
the documentation has an opinion, the code holds it: thirty-five of thirty-seven
times, and the two exceptions are both prose about a branch rather than code
about a case. The fourth pass added four rows and no third violation, which is
the corollary holding rather than being tested — none of the four ground regions
it read has a `docs/agent/` position that a row could contradict.

**But it found the same shape one level down, in the source rather than the
documentation.**
[B6](02-backend-logic.md#b6--the-claude-stream-parser-drops-an-event-type-it-does-not-recognise-without-a-word-and-the-codex-parser-twelve-lines-below-it-says-why-that-is-not-survivable)
is a docblock at `src/lib/orchestrator.ts:7372-7381` that names the function
above it, states exactly why silence there is not survivable, and then builds the
remedy for the other provider only. That is not a violation of an invariant —
`docs/agent/run-lifecycle.md` has no position on it — and it is the same failure
those two are: a sentence written about one path of a function that has several,
this time with the sentence and the untaken path in one file.

**Very little on this register is a missing mechanism, and the operations axis is
where that stops being an impression and becomes a count.** Seven of its eight
rows are a mechanism that exists and cannot be seen: a boot reconciliation that
records itself and reports a number that never clears
([O1](08-operations.md#o1--the-one-restart-condition-the-runbook-alerts-on-never-clears-and-the-count-that-does-is-on-a-route-the-status-token-cannot-reach)),
a schema verdict computed at every boot and printed to a stream nobody tails
([O3](08-operations.md#o3--everything-migrate-finds-wrong-with-the-database-it-just-opened-is-a-line-on-stdout-and-nothing-else)),
a backup path that is measured, tested and invisible to the app that depends on
it ([O4](08-operations.md#o4--nothing-in-the-app-knows-the-backup-directory-exists-so-no-surface-can-say-when-the-install-was-last-backed-up)),
a coupling stated in a comment and pinned by nothing
([O2](08-operations.md#o2--the-containers-stop-grace-and-the-servers-shutdown-grace-are-one-edit-apart-and-the-file-that-pins-every-other-such-pair-does-not-pin-this-one)).

The same shape is on every other axis once it is named. **Three rows shipped as
mechanisms with no interface** — B2/M4, M1 and M5, each closed in half for
exactly that reason. Five more are a working mechanism reachable only up to a
number nobody chose: G1's four caps — the fourth added by the fourth pass, a
workflow's twenty instances — and G2's thirty. And
[F5](01-frontend.md#f5-nothing-that-renders-is-checked-by-anything), ranked
first, is the same sentence about the code itself.

So the register's dominant failure mode is not *this app cannot do X*. It is
**this app does X, correctly and with the reasoning written down, and nothing
says so** — which is why the recommendation for so many of these rows is a
readout, a field or a pin rather than a build, and why a green tree, a clean
`npm audit` and thirty paragraphs of held invariants are all consistent with
every one of them.
