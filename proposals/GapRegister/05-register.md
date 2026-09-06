# The register

**Twenty rows.** Twenty-one gap identifiers across the four axis files, with
[B2](02-backend-logic.md#b2-nothing-builds-or-tests-a-branch-before-it-is-merged-and-the-setting-that-looks-like-it-does-has-one-reader) and [M4](04-missing-features.md#m4-nothing-verifies-a-branch-before-it-is-merged) carried once as
one gap with two framings.

Every row points at a file and line, a command whose output is quoted in
[00-method.md](00-method.md), or a documented invariant it contradicts. Six
candidates were dropped for lack of evidence and seven were refuted outright;
five of the refutations are in
[00-method.md](00-method.md#refuted-or-already-decided) and two in
[03-growth.md](03-growth.md#refuted-on-this-axis).

Ranked by *cost of leaving it*, discounted by confidence. Blast radius alone
does not rank a row — [B1](02-backend-logic.md#b1-the-landing-guard-covers-landrun-and-none-of-the-other-four-doors) has the widest and sits third
because no failure has been reproduced, and [G3](03-growth.md#g3-one-process-is-the-hard-ceiling-and-the-usual-escape-route-is-not-the-one-that-applies) has an
unbounded one and sits last among the open rows because it costs nothing today.

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

## Ranked

| # | ID | Axis | Gap | Evidence | Blast radius | Cost of leaving it | Conf. | Already owned? |
|---|---|---|---|---|---|---|---|---|
| 1 | [F5](01-frontend.md#f5-nothing-that-renders-is-checked-by-anything) | frontend | Nothing that renders is checked by anything: 20,447 lines of page code, 0 page tests, no jsdom, no browser in CI | `find`/`wc -l`; `npm test` = 2,259/351/0; `grep -nE "jsdom\|testing-library\|playwright\|puppeteer" package.json` returns nothing; `README.md:983`; `docs/verification.md:1865` | every visual and interactive regression | high and **measurably rising**: +3,918 lines of page code and +681 assertions since `175ba57`, and page components rendered by a test is still 0 | high | #155, adjacent |
| 2 | [B2](02-backend-logic.md#b2-nothing-builds-or-tests-a-branch-before-it-is-merged-and-the-setting-that-looks-like-it-does-has-one-reader) / [M4](04-missing-features.md#m4-nothing-verifies-a-branch-before-it-is-merged) | backend / feature | **SHIPPED IN HALF** (`d1d3119`) — `landVerifyCommand` gates `landRun` (`src/lib/land.ts:999-1006`) and `deliverRun` (`:2941-2947`) against the run's own slot, but has **no Settings field**, so a stock install lands unverified exactly as surveyed; and `resolveVerifyTools` still has one reader and it is still the conflict assist | `src/lib/settings.ts:391`, default `""` at `:891`; `grep -an "landVerifyCommand" src/app/settings/page.tsx` → nothing; `src/lib/land.ts:1362`; the field that *does* exist is `resolveVerifyTools`' at `src/app/settings/page.tsx:3221-3243` | every landed branch on every repository | high — the only row whose failure lands in the operator's product; but lower than surveyed, because the mechanism now exists and one `PUT /api/settings` turns it on | high | no |
| 3 | [B1](02-backend-logic.md#b1-the-landing-guard-covers-landrun-and-none-of-the-other-four-doors) | backend | The `landing` guard covers `landRun` and none of the other **five** exported doors into the same repository | `src/lib/land.ts:228, :970-982, :1079`; the five at `:1254, :1810, :1916, :2104` and **`:2901`**; `resolveCheckout`'s repository-wide `worktree prune` at `:1205`; `MAX_MERGE_WORKERS = 4` at `src/lib/mergeQueue.ts:613` | a repository's git state — refs, worktree admin, the operator's index, and now `origin` | low frequency, high consequence, hard to diagnose after the fact — and one door wider than surveyed | **medium** — scope read from source, no collision reproduced, Docker unavailable | #68, third concern only |
| 4 | [M2](04-missing-features.md#m2-one-credential-no-identity-no-authorisation) | feature | One credential, no identity, no authorisation, no per-person revocation | `src/lib/config.ts:286`; `src/lib/requestLog.ts:28-31, :53` | every multi-person use of the product | high on a team, zero solo — the product is single-operator by construction | high mechanism / medium cost | #125, adjacent |
| 5 | [F2](01-frontend.md#f2-quick-open-the-apps-only-search-surface-inherits-that-cap) | frontend | **SHIPPED IN HALF** (`f7617fb`) — the cap is gone, the two-list corpus is not — quick open still indexes panes, runs and workflows and cannot find a chat, a branch, an agent, a template or a schedule | `src/components/shell/QuickOpen.tsx:118-119, :204, :221, :229`, and the input's own label at `:315`; three pages arrived since with nothing indexing them (`/dreaming`, `/runs/[id]/touched`, `/runs/[id]/conflicts`); contrast the real search at `src/app/api/knowledge/search/route.ts:9-19` | all navigation that is not a click | high — a miss is indistinguishable from an absence — but lower than surveyed, because the run half of it is answered | high | no |
| 6 | [B3](02-backend-logic.md#b3-a-chat-turn-exists-nowhere-durable-until-the-child-exits) | backend | A chat turn exists nowhere durable until the child exits — text, `chat_turn_spend` and the thread total are lost together | `src/lib/chat.ts:2358`, `:428`, `:2623-2628`; contrast the `emit()` ordering in `docs/agent/architecture.md` | orchestrator chat, where a model writes half a run | rare and total — a turn lands whole or vanishes whole, and the money is spent either way | high | no |
| 7 | [G2](03-growth.md#g2-chat-threads-past-the-newest-30-cannot-be-reached-at-all) | growth | Chat threads past the newest 30 cannot be reached at all — no paging, no search, no index | `src/lib/chat.ts:387`; `src/app/api/chat/dto.ts:132`; `src/app/api/chat/route.ts:15-27` — the capped list route that reads no `searchParams`, a description `/api/runs` vacated | every past orchestrator conversation | high — approved proposals carry reasoning, on a rolling window nobody chose the width of, and the one-parameter fix its twin got was not carried across | high | no |
| 8 | [G1](03-growth.md#g1-nine-list-routes-read-parameters-the-one-for-runs-does-not-and-the-pattern-repeats-three-times) | growth | A pattern, not an incident: three capped lists with no parameter, at 100 / 30 / 25. **The 100 is closed; the other two are untouched** | route survey re-run at `66fdbab`: 68 `route.ts` under `src/app/api`, eleven read `searchParams`; `src/lib/chat.ts:387`; `src/lib/workspace.ts:168, :188` | chats, and which repositories the chat can name | rising with use; the row's own prediction — that each instance is discovered and fixed separately — is what happened | high | partly — #78 owns the third |
| 9 | [G4](03-growth.md#g4-the-audit-trail-is-20000-rows-deep-evicted-on-every-insert-and-identifies-no-person) | growth | The audit trail is 20,000 rows, evicted on every insert, measured in requests rather than time, and names no person | `src/lib/requestLog.ts:68, :119-121, :28-31, :53`; nothing in `retention.ts`; `docs/verification.md:3201` | incident review; any retained-trail requirement | silent — the trail shortens rather than failing | high mechanism / **low** on how many days | no; #91 adjacent |
| 10 | [F3](01-frontend.md#f3-a-chat-turn-renders-nothing-until-it-finishes-the-run-path-streams) | frontend | A chat turn renders nothing until it ends; the run path has SSE and lossless reconnect, chat has neither half | `src/lib/chat.ts:2358`; `src/app/chat/page.tsx:462, :1596`; contrast `src/app/api/runs/[id]/stream/route.ts` | every orchestrator chat turn | moderate — the newest surface feels the least alive, and the mechanism is one route away | high mechanism / **assumed** turn length | no; #114 adjacent |
| 11 | [M5](04-missing-features.md#m5-nothing-can-be-prioritised-the-queue-is-strictly-oldest-first) | feature | **SHIPPED IN HALF** (`d1d3119`) — `runs.priority` orders promotion **and** `queuePosition` through one comparator, so the readout this row headlined is fixed; no page has a control for it | `src/lib/orchestrator.ts:3913, :3938, :3942, :4018` (counting over `queueCompare` at `:4034`), `:10994`; `src/app/api/runs/[id]/priority/route.ts`; `grep -rn "priority" src/app --include=*.tsx` → nothing | scheduling under load | urgent work waits behind a night's schedule — unless the operator can reach the endpoint by hand, which they now can | high mechanism / **assumed** queue depth | no |
| 12 | [B4](02-backend-logic.md#b4-the-install-ceiling-is-checked-once-per-chat-turn-before-it-and-a-turn-has-no-cap) | backend | The install ceiling is checked once per chat turn, before it, and chat has no `live-resume` equivalent. **The title's second clause is wrong: a turn is capped** | `src/lib/chat.ts:2071` is the only install-ceiling call site on the turn path; the cap is `--max-budget-usd` at `:2327-2332` from `chatTurnBudgetUSD` = 2 (`src/lib/settings.ts:903`); `docs/agent/budgets-and-guards.md` | the install's 24-hour ceiling | bounded, not unbounded — the overshoot between checks is at most one `chatTurnBudgetUSD` per admitted turn | high mechanism / **low** severity | #87, adjacent |
| 13 | [M1](04-missing-features.md#m1-the-app-can-push-nothing-and-open-no-pull-request) | feature | **SHIPPED IN HALF** (`d1d3119`) — `deliverRun` pushes and opens a pull request from one endpoint, but has no button and, so far as anything readable from here shows, **has never opened a real one** | `src/lib/land.ts:2901`; `src/lib/delivery.ts:79, :140`; `src/app/api/runs/[id]/deliver/route.ts`; `grep -rn "deliver" src/app --include=*.tsx` → nothing; the "no real PR" half is **assumed** — `DATA_DIR` is unreadable | any team whose review gate is a PR | high for them, zero for a solo operator — and it is now reachable by hand rather than absent | high mechanism / **assumed** demand | #99, adjacent |
| 14 | [B5](02-backend-logic.md#b5-the-chat-can-identify-only-the-first-25-repositories-always-the-same-25) | backend | The chat can name only the first 25 git repositories, in scan order, permanently — no offset, no filter | `src/lib/workspace.ts:168, :186-188, :208` | installs with 25+ repositories mounted | absolute past the boundary, invisible from the UI, reads to the operator as a broken repository | high mechanism / **low** on how many installs cross it | **#78**, suspicion 2 — confirmed here |
| 15 | [M6](04-missing-features.md#m6-a-credential-cannot-be-rotated-without-a-restart-and-a-restart-ends-live-runs) | feature | A credential cannot be rotated without a restart, and a restart terminates live runs | module-level consts at `src/lib/config.ts:286, :366, :422-447`; five more environment-only values arrived with the webhook (`:467, :475, :485, :488, :505`); `README.md:250` alert on `lastBootReconcile.closed > 0` | every secret the install holds | measured in reluctance; the vault's 19%-after-16-days is what deferral looks like | high mechanism / medium framing | #89, over cap |
| 16 | [G3](03-growth.md#g3-one-process-is-the-hard-ceiling-and-the-usual-escape-route-is-not-the-one-that-applies) | growth | One process is the hard ceiling, and the ceiling is written down nowhere an operator planning capacity would find it | `src/lib/serverLock.ts:214, :394`; `MAX_WORKTREE_SLOTS = 64` at `src/lib/orchestrator.ts:3196`, `MAX_MERGE_WORKERS = 4` at `src/lib/mergeQueue.ts:613`; nothing in `docs/install.md` | whether an install can grow past one machine | **zero today**, unbounded later; the real gap is an unstated product position, not a missing mechanism | high mechanism / medium severity | no |
| 17 | [F1](01-frontend.md#f1-run-history-stops-at-100-rows-and-cannot-be-paged-filtered-or-searched) | frontend | **CLOSED** (`7405720`, `d77638d`) — run history pages, filters and searches over every matching row | `src/app/api/runs/route.ts:77-97`; `src/lib/orchestrator.ts:965, :999, :1027`; `src/app/runs/page.tsx:676, :993-1099`; `grep -rn "SERVER_LIMIT" src/` → nothing | — | **zero** — closed whole. The four-second poll at `:642` still asks with no parameters, deliberately | high | no |
| 18 | [F4](01-frontend.md#f4-a-runs-log-cannot-be-searched-or-filtered) | frontend | **CLOSED** (`e250524`, `e16fd7f`) — a text box and a kind picker over the events the page already holds, with the truncated-replay count stated when a filter is on | `src/lib/logLine.ts:691, :716, :730`; `src/app/runs/[id]/page.tsx:511-512, :650-660, :1804-1826`; `src/app/api/runs/[id]/stream/route.ts:135-141` | — | **zero** — closed whole | high | no |
| 19 | [F6](01-frontend.md#f6-settings-is-nine-sections-in-a-3502-line-page-with-no-way-to-find-a-field) | frontend | **CLOSED** (`a8f2984`, `bdbdf08` — the `beforeunload` prompt this row filed as an issue rather than a row) — the page is findable; it is not smaller | `src/app/settings/page.tsx:105-117` (ten sections now, 4,298 lines), `:191`, `:200-222`, `:2357-2392`, `:2426`, `:2031-2032` | — | **zero** — closed whole. The tenth section (Dreaming, `:3923`) arrived after the fix and the search found it without being told | high | no |
| 20 | [M3](04-missing-features.md#m3-nothing-this-app-runs-can-reach-a-human-and-most-of-that-is-on-purpose) | feature | **CLOSED** (`1891ad7`, `0d6af15`) — one signed JSON body to one operator-named URL when a run ends needing a person; success is opt-in | `src/lib/notify.ts:107-111` (`needs-review`, `blocked`, `failed`), `:296`, `:301`, `:322`, `:422`; `src/lib/config.ts:467, :475, :485, :488, :505`, environment-only for the reason at `:450-466`; `README.md:236-253` is fifteen alertable conditions now and the fifteenth watches the channel | — | **zero** — closed whole. A stock install still has no channel, because blank is the shipped value and that is the design rather than the gap | high | was mostly owned by `README.md`'s own position |

## How the ranking was made

Three inputs, in this order. Unchanged from the survey — this refresh re-applies
the method rather than replacing it.

**Cost of leaving it, now.** Not blast radius. A gap that is catastrophic and
has never fired ranks below one that costs something every week. This is why
row 3 sits below row 2 despite the widest radius here, and why row 16 is last
among the open rows despite being the only unbounded one.

**A closed row costs nothing to leave**, so rows 17 to 20 sit at the bottom. They
keep their place in the table rather than being deleted, because the twenty
sections they index are the ledger and a register that quietly drops what it got
fixed cannot be audited against itself.

**Confidence, as a discount rather than a filter.** A medium-confidence row
stays on the register and moves down. Three rows carry an explicitly assumed
premise in the Conf. column — [M1](04-missing-features.md#m1-the-app-can-push-nothing-and-open-no-pull-request)'s demand,
[M5](04-missing-features.md#m5-nothing-can-be-prioritised-the-queue-is-strictly-oldest-first)'s queue depth and
[F3](01-frontend.md#f3-a-chat-turn-renders-nothing-until-it-finishes-the-run-path-streams)'s turn length — and all three are ranked as if that
assumption is even money. Two more mark one in their axis section rather than in
the table: [B3](02-backend-logic.md#b3-a-chat-turn-exists-nowhere-durable-until-the-child-exits)'s absence of a recovery path elsewhere, and
[B5](02-backend-logic.md#b5-the-chat-can-identify-only-the-first-25-repositories-always-the-same-25)'s premise that installs with more than 25
repositories exist. M1 now carries a second one: that no real pull request has
been opened.

**Whether something already owns it, as a tiebreak only.** An owned gap is still
a gap; it just should not become a new proposal. Ten rows name an issue number —
eight carry it as ownership and two ([G4](03-growth.md#g4-the-audit-trail-is-20000-rows-deep-evicted-on-every-insert-and-identifies-no-person),
[F3](01-frontend.md#f3-a-chat-turn-renders-nothing-until-it-finishes-the-run-path-streams)) name an adjacent one while answering *no* — and only
[B5](02-backend-logic.md#b5-the-chat-can-identify-only-the-first-25-repositories-always-the-same-25) is owned squarely rather than adjacently. **None of
those numbers was re-read on this pass** — no GitHub issue was opened, closed,
commented on or fetched — so every one of them is assumed unchanged since
`175ba57`.

## What moved in the ranking, and why

One sentence each. Rows not listed here did not move relative to the rows around
them.

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

Three observations that no individual row carries. All three survive the
refresh, and the first two are now demonstrated rather than argued.

**Nine of twenty rows are one sentence: the app cannot find what it has already
done.** [F1](01-frontend.md#f1-run-history-stops-at-100-rows-and-cannot-be-paged-filtered-or-searched), [F2](01-frontend.md#f2-quick-open-the-apps-only-search-surface-inherits-that-cap), [F4](01-frontend.md#f4-a-runs-log-cannot-be-searched-or-filtered),
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

**The chat surface carries four rows ([B3](02-backend-logic.md#b3-a-chat-turn-exists-nowhere-durable-until-the-child-exits), [B4](02-backend-logic.md#b4-the-install-ceiling-is-checked-once-per-chat-turn-before-it-and-a-turn-has-no-cap),
[F3](01-frontend.md#f3-a-chat-turn-renders-nothing-until-it-finishes-the-run-path-streams), and half of [G2](03-growth.md#g2-chat-threads-past-the-newest-30-cannot-be-reached-at-all)) and the run
surface carries none of the equivalents.** Every mechanism chat lacks —
incremental persistence, publish-after-persist, a mid-flight guard, a paged
list — exists in this repository, built for runs, documented in
`docs/agent/architecture.md` and `docs/agent/budgets-and-guards.md`. Chat is the
newest surface and it did not inherit them. `src/lib/chat.ts` went from 2,397
lines to 3,065 between `175ba57` and `66fdbab` and inherited none of them in that
window either.

**Nothing on the register is a violation of a documented invariant.** Every one
is something `docs/agent/` never had an opinion about, and re-reading the four
axis files against `66fdbab` found no new one. That is a strong signal about
where the next hour of documentation is worth spending, and it is the reason four
candidates died as documented decisions rather than surviving as rows.
