# Where the gaps are

**The question:** where are this app's gaps — across frontend design, backend
logic, growth limits, features it is missing, and the app's own security and
trust boundary — and which of them are worth a survey of their own?

**The state, at `main` `66fdbab`:** **eight of the original twenty rows have
moved — four closed whole, four closed in half — and twelve are open exactly as
surveyed. A fifth axis was then added and carries five more.** Twenty-five
verified gaps registered, twelve candidates dropped for lack of evidence and
thirteen refuted as documented decisions or by probe. Three questions recommended
for a survey, eight things recommended as issues, five refused by name.

**Security is the fifth axis and it is the app's doors rather than a run's
reach**: what gets in, what credentials it holds, what it accepts as input, which
is deliberately the reverse direction from
`proposals/implemented - Sandboxing/`. It is also the one axis where
`docs/agent/` has stated positions to test a row against, and it produced the
register's **first violation of a documented invariant** along with its highest
refutation rate.

Every count, confidence and rank in this directory was re-read against the tree
on 2026-09-06 and is current; the security rows were surveyed against the same
tree on the same day. [05-register.md](05-register.md) carries the row-by-row
account of what moved and where the five new rows were ranked in.

**Four rows were implemented**, on branch
`uf/usagefoundry-721638d11c0b-1-41e5e190`, by two runs after this register was
written:

- **[F1](01-frontend.md#f1-run-history-stops-at-100-rows-and-cannot-be-paged-filtered-or-searched) shipped** — `/api/runs` reads `offset`, `limit`, `status`,
  `q` and `settledBefore`, and the runs page pages the whole history
  (`7405720`, `d77638d`).
- **[F2](01-frontend.md#f2-quick-open-the-apps-only-search-surface-inherits-that-cap) shipped in half** — quick open asks the route for typed
  text, so a run past the hundredth is reachable; its corpus is still panes, runs
  and workflows, so a chat, a branch, an agent, a template and a schedule are
  still unfindable (`f7617fb`). Three more pages have arrived since — `/dreaming`,
  `/runs/[id]/touched` and `/runs/[id]/conflicts` — and nothing indexes what any
  of them holds.
- **[F4](01-frontend.md#f4-a-runs-log-cannot-be-searched-or-filtered) shipped** — a text box and a kind picker over the events the
  page already holds, with the truncated-replay count stated when a filter is on
  (`e250524`, `e16fd7f`).
- **[F6](01-frontend.md#f6-settings-is-nine-sections-in-a-3502-line-page-with-no-way-to-find-a-field) shipped**, and so did the `beforeunload` prompt it filed as
  an issue rather than a row (`a8f2984`, `bdbdf08`). The page is 4,298 lines and
  **ten** sections now rather than nine, and the search found the tenth without
  being told about it, because its corpus is the rendered page.

Three more shipped later, on `main` at `d1d3119`, from PR #214 and the fixes
that followed it — **each of them a mechanism with no interface**, which is the
whole of why none is marked whole. All three were re-checked at `66fdbab` and
none has gained a control since:

- **[B2](02-backend-logic.md#b2-nothing-builds-or-tests-a-branch-before-it-is-merged-and-the-setting-that-looks-like-it-does-has-one-reader) / [M4](04-missing-features.md#m4-nothing-verifies-a-branch-before-it-is-merged) shipped in half** — `landVerifyCommand` gates both
  `landRun` and `deliverRun`: argv never a shell line, a non-zero exit refuses,
  and an unparseable command refuses too rather than reading as a pass. It runs
  in the **run's own** worktree slot (`verifyTreeVerdict`), which is the half
  that had to be corrected after the merge — the first version ran it in the
  operator's checkout, standing on the target, where it never saw the work at
  all. Two things keep this from being whole: there is **no Settings field**, so
  the gate is reachable only by `PUT /api/settings` by hand; and the row's other
  half stands untouched — `resolveVerifyTools` still has one reader and it is
  still the conflict assist, so the setting that sounds like a verify gate still
  is not one.
- **[M5](04-missing-features.md#m5-nothing-can-be-prioritised-the-queue-is-strictly-oldest-first) shipped in half** — `runs.priority`, clamped ±100, higher
  first with `created_at` breaking every tie, through `queueOrder`/`queueCompare`
  into `selectPromotable` and `queuePosition`. The row's headline — that
  `queuePosition` reports a place nothing can leave — needed a second fix to
  close: priority reached the promotion order at the merge and not the readout,
  so a run raised to the front started first while the page went on saying it
  was queued behind three others. Not whole because there is **no control** on
  any page; the only way to set one is `PUT /api/runs/:id/priority`.
- **[M1](04-missing-features.md#m1-the-app-can-push-nothing-and-open-no-pull-request) shipped, and is the least proven thing here** —
  `deliverRun` pushes the branch and opens a pull request, one endpoint, one
  press, never forced, never reached from the run loop, refusing without a
  credential for that repository. The credential also needed a fix after the
  merge: it pushed through `git()`, whose `gitEnv()` strips the whole `UF_`
  namespace, so it reached GitHub unauthenticated. **No pull request has ever
  been opened by it.** The push and the API call are covered by unit tests and
  by their refusal paths, not end to end against GitHub, and there is no button.
  Whether one has been opened since is **assumed unchanged and unverifiable from
  here**: `DATA_DIR` is unreadable by this uid, so no run's `deliver` event can
  be read.

**An eighth shipped after those, on `main`, and it is the first thing on this
register to close without an implementation run being pointed at it.**

- **[M3](04-missing-features.md#m3-nothing-this-app-runs-can-reach-a-human-and-most-of-that-is-on-purpose) shipped whole** — `src/lib/notify.ts` POSTs one signed
  JSON body to one operator-named URL when a run ends `needs-review`, `blocked`
  or `failed` (`:107-111`, `:422`), with an HMAC `X-UF-Signature` (`:296`), a
  5-second timeout (`:301`) and a per-attempt row in `webhook_deliveries`
  (`:322`); a run that simply worked is opt-in through `UF_NOTIFY_ON_SUCCESS`
  (`1891ad7`, `0d6af15`). It is **not** marked half despite having no Settings
  field, and that is what separates it from the three above: here the absence is
  argued rather than unbuilt. `src/lib/config.ts:450-466` refuses to let a
  webhook target live in `settings.json`, because `/api/settings` is reachable
  with the master key and a repointable target would turn one credential into an
  exfiltration channel aimed anywhere the container can reach. The proposal
  behind it is `proposals/implemented - UnattendedOperation`.

**[F3](01-frontend.md#f3-a-chat-turn-renders-nothing-until-it-finishes-the-run-path-streams) and [F5](01-frontend.md#f5-nothing-that-renders-is-checked-by-anything) did not ship, and neither did B1, B3, B4, B5,
G1–G4, or M2 and M6.** Twelve of the twenty rows are exactly as surveyed and
four more are half closed, which is why this directory is not renamed. The
invariants behind the frontend four moved to `docs/agent/conventions.md` and
`docs/agent/testing.md`, the operator's half to `docs/runs.md` and
`docs/install.md`, and what a person still has to open and click to
`docs/verification.md`; the landing three are in
`docs/agent/isolation-and-landing.md` and `docs/agent/run-lifecycle.md`, and
**none of the three has an operator-facing doc yet**, because none of them has a
surface for an operator to be told about. The webhook is the exception and has
both: `docs/install.md` for its five environment variables, and
`docs/agent/run-lifecycle.md` for the closed field list and its own status set.

**Two open rows have a claim contradicted rather than closed**, and both
corrections are in the axis files. [G1](03-growth.md#g1-nine-list-routes-read-parameters-the-one-for-runs-does-not-and-the-pattern-repeats-three-times)'s lead example is gone
— `/api/runs` reads five parameters now, and the route that fits its description
is `/api/chat` — while the pattern it claims survives at two of three instances.
[B4](02-backend-logic.md#b4-the-install-ceiling-is-checked-once-per-chat-turn-before-it-and-a-turn-has-no-cap)'s "a turn has no cap" is wrong, and was wrong when it was
written: `--max-budget-usd` has been on the chat child's argv since before the
survey. **One row got wider**: [B1](02-backend-logic.md#b1-the-landing-guard-covers-landrun-and-none-of-the-other-four-doors) has five unguarded doors
beside `landRun` now rather than four, because `deliverRun` arrived taking
neither check.

**The recommendation below was to survey reachability first, not to implement
it.** The implementation was taken instead. Nothing about that answers Survey 1's
actual question — *what should an operator be able to find, and by what
mechanism, across chats, branches, agents, templates and schedules* — which is
still unanswered at `66fdbab`, and four point fixes to the run surface are not an
answer to it. Three pages have been added since without anything indexing what
they hold. The falsifier the recommendation named is **still unrun**: nobody has
executed `SELECT COUNT(*) FROM runs` on the live install, and this refresh could
not run it either, for the same reason the survey could not — `DATA_DIR` is not
readable by the agent uid. So whether reachability was the right axis to lead
with remains unestablished, before the work, after it, and now.

## The recommendation

**Survey reachability first** — [06-recommendation.md](06-recommendation.md#survey-1-reachability-what-should-an-operator-be-able-to-find-and-how).
Eight of the twenty-five rows are one sentence: *the app cannot find what it has
already done.* A hundred-row runs list with no parameters, a search that indexes
two lists, thirty reachable chat threads, a log with no filter, twenty-five
nameable repositories, a settings page with no field search. They share a fix
and the repository already contains the pattern twice — `/api/branches` takes
`repo`/`offset`/`limit`, and `/api/knowledge/search` is a real parameterised
search pointed at the operator's vault rather than at their own runs.

**Three of the eight are closed at `66fdbab` and one is half closed**, as four
separate changes on one branch, which is the observation being demonstrated
rather than refuted. The five still open are F5, G1, G2, G4 and B5, plus F2's
corpus — and `/api/branches`' pattern was carried across to `/api/runs` and to
nothing else.

**What would overturn it:** `SELECT COUNT(*) FROM runs` on the live install. If
history is a few hundred rows, reachability is theoretical and the landing
boundary leads instead. That query is one line and **this survey could not run
it** — `DATA_DIR` is unreadable by the agent uid — which makes it the cheapest
falsifier here and the largest hole in the register.

**Runner-up:** the landing boundary
([Survey 2](06-recommendation.md#survey-2-the-landing-boundary-what-must-be-true-before-an-agents-work-leaves-the-machine)) — the register's #1 row, and the
only group whose failure lands in the operator's product rather than in
UsageFoundry.

**[06-recommendation.md](06-recommendation.md) was not re-derived against the
five security rows and does not mention them.** That pass was scoped to
surveying and registering an axis, so the three surveys, eight issues and five
refusals are still the four-axis answer. Whether
[S1](07-security.md#s1-the-all-sessions-branch-of-the-logout-route-takes-no-credential-and-revoking-a-session-does-not-end-it)
at rank four displaces any of them is an open question and is stated as one
rather than answered here. S1 is also the row on this register most likely to
want an operator's attention before anything else is decided about it.

## The register at a glance

Every figure below describes the register at `main` `66fdbab`: the first four
axes re-read row by row on 2026-09-06, the fifth surveyed against the same tree
on the same day.

| | |
|---|---|
| Rows | **25** (26 gap ids; one carried once under two framings) |
| Frontend / backend / growth / missing features / security | 6 / 5 / 4 / 6 / 5 |
| **Rows closed whole** | **4** — F1, F4, F6, M3 |
| **Rows closed in half** | **4** — F2, B2/M4, M1, M5 |
| **Rows open exactly as surveyed** | **17** (the original twelve, plus S1–S5) |
| Open rows with a claim since contradicted | 2 — G1's lead example, B4's second clause |
| Open rows that got wider | 1 — B1, now five unguarded doors rather than four |
| Dropped for lack of evidence | 12 (6 as surveyed, none re-adjudicated, plus 6 on the security axis) |
| Refuted as documented decisions, or by probe | 13: 7 as surveyed, one of them the three npm advisories, since fixed by `102050d` so that `npm audit` now reports `found 0 vulnerabilities`, plus 6 on the security axis |
| Rows whose failure lands in the operator's product, not this app | **1** (B2/M4) |
| Rows that violate a documented invariant | **1**: S1, against `docs/agent/security.md:26`. It was 0 for the four axes `docs/agent/` has no opinion about, and finding it took adding the axis where it does |
| Rows resting on an explicitly assumed premise | 7 (F3, B3, B5, M1, M5, S5, S2) |
| Rows already owned by an open issue, squarely | 1 (#78) — **assumed unchanged**; no issue was read or written on this pass or the one before it |

**Two figures in that table cannot be checked from this container and are
carried forward as assumed.** Every issue number, because neither this pass nor
the refresh before it opened, closed, commented on or fetched anything on GitHub.
And whether M1 has opened a real pull request since, because `DATA_DIR` is
unreadable by the agent uid, so no run's `deliver` event can be read. Everything
else was read out of the tree.

Full table, ranked, with evidence and confidence per row:
[05-register.md](05-register.md).

## The three worth a survey

1. **Reachability** — what should an operator be able to find, and by what
   mechanism? Five genuinely different answers, two of which pull in opposite
   directions, and one of which collides with a documented invariant.
   [→](06-recommendation.md#survey-1-reachability-what-should-an-operator-be-able-to-find-and-how)
2. **The landing boundary** — what must be true before an agent's work leaves
   the machine? **Half of this one was built rather than surveyed, and the half
   that was built needed two corrections after its merge.** At `66fdbab`:
   `landVerifyCommand` gates `landRun` (`src/lib/land.ts:999-1006`) and
   `deliverRun` (`:2941-2947`) but has no Settings field; the setting that sounds
   like it does still has one reader and it is still the conflict assist
   (`:1362`); the concurrency guard now covers one exported door of **six**
   (`:2901` is the new one); and the push and the pull request exist
   (`src/lib/delivery.ts`) with no button and, so far as anything readable from
   here shows, no real pull request yet. **Not ExternalValidator's question** —
   that one is a semantic reading of the diff, this one is whether the code
   builds.
   [→](06-recommendation.md#survey-2-the-landing-boundary-what-must-be-true-before-an-agents-work-leaves-the-machine)
3. **What should check the UI** — **20,447** lines of page code at `66fdbab`
   (16,529 when surveyed), zero page tests, no jsdom, no browser in CI, and
   **ten** narrow-viewport entries on `docs/verification.md`'s "Not yet verified
   by hand" list (`:1865`), which is 91 entries long. A survey rather than "add
   Playwright", because the operator's own vault has already read the coverage
   literature that stops the obvious answer being taken on faith. **This is the
   one recommendation whose case has strengthened rather than been overtaken**:
   nothing was done about it and the number it turns on grew 24%.
   [→](06-recommendation.md#survey-3-what-should-check-the-ui-and-what-would-it-actually-catch)

## The three biggest things the register says that no single row does

**Nine of twenty rows are reachability.** They would be filed as nine unrelated
tickets and fixed nine times. **Four of them then were** — three whole and one in
half, as four separate changes on one branch — and the five still open include
[G2](03-growth.md#g2-chat-threads-past-the-newest-30-cannot-be-reached-at-all), chat threads past the newest 30, which has the same
one-parameter fix as the runs list and still has not got it. That is the
observation being demonstrated rather than refuted, and `66fdbab` demonstrates it
twice: `/api/chat` now matches, word for word, the description
[G1](03-growth.md#g1-nine-list-routes-read-parameters-the-one-for-runs-does-not-and-the-pattern-repeats-three-times) wrote for `/api/runs`.

**The chat surface carries four rows and the run surface carries none of the
equivalents.** Incremental persistence, publish-after-persist, a mid-flight
budget check, a paged list — every one exists in this repository, built for
runs, documented in `docs/agent/`. Chat is the newest surface and inherited none
of them. That is why the recommendation for those four is *one issue*, not a
survey: the answer is already written down, one module over.

**Nothing on the register violates a documented invariant.** Every row is
something `docs/agent/` never had an opinion about, and six candidates died
because it did. The invariants hold, and re-reading all twenty rows against
`66fdbab` found no new violation.

## What this survey could not do

All three were still true of the `66fdbab` refresh, which is why the falsifier
above is still unrun and why [B1](02-backend-logic.md#b1-the-landing-guard-covers-landrun-and-none-of-the-other-four-doors)'s confidence is still medium.

- **Read any run history.** `DATA_DIR` is not readable by the agent uid;
  `.data/usagefoundry.db` in the checkout is stale (last written 2026-08-19) and
  was used only for one schema probe. No row rests on a count of real runs.
- **Run a container.** Docker is unavailable here, so nothing was checked
  against a live fleet, the image `HEALTHCHECK`, or a reproduced collision.
- **Open a browser.** At any viewport. Which is [F5](01-frontend.md#f5-nothing-that-renders-is-checked-by-anything)'s point.
- **Read a GitHub issue.** Deliberately, on the refresh: the pass was scoped to
  the tree, so every issue number in the register is assumed unchanged rather
  than confirmed.

Full accounting, including every command run and its output, what was
deliberately left unread, and every dropped candidate:
[00-method.md](00-method.md).

## Files

| | |
|---|---|
| [00-method.md](00-method.md) | What was read, what was run and what it printed, what could not be reached, what was refuted, what was dropped |
| [01-frontend.md](01-frontend.md) | F1–F6 |
| [02-backend-logic.md](02-backend-logic.md) | B1–B5, and what this axis got right |
| [03-growth.md](03-growth.md) | G1–G4, and two candidates refuted as deliberate ceilings |
| [04-missing-features.md](04-missing-features.md) | M1–M6, judged on capability rather than polish |
| [05-register.md](05-register.md) | The ranked table, how it was ranked, and what its shape says |
| [06-recommendation.md](06-recommendation.md) | Three surveys, eight issues, five refusals by name: the four-axis answer, not re-derived against S1–S5 |
| [07-security.md](07-security.md) | S1–S5, what this axis got right, and its own refuted and dropped lists |

Verification loop on the tree this was written against (`175ba57`):
`npm run typecheck` exit 0; `npm test` 1,578 tests / 230 suites / 0 failures;
`env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build` exit 0. The tree is
green, and that is the point — none of these twenty is something a green tree
tells you.

Re-run on `a34e56b`, the head of the branch carrying the four fixes:
`npm run typecheck` exit 0; `npm test` **1,660 tests / 245 suites / 0 failures**;
`env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build` exit 0. Also still green,
and 82 more assertions — none of them about anything that renders, which is
[F5](01-frontend.md#f5-nothing-that-renders-is-checked-by-anything)'s point after roughly 900 more lines of interactive page
code. **No browser was opened and no container was started for any of that work,
at any viewport**; `docs/verification.md`'s "Not yet verified by hand" list is
where that is recorded and it is the list to work through.

### The `66fdbab` refresh, 2026-09-06

This refresh changed no code — only the seven files in this directory and the
[proposals index](../README.md) line that summarises them — so a failure here
would be a finding about `main` rather than about the refresh. There was none.
Run from `/workspace/.uf-worktrees/usagefoundry-721638d11c0b-1`, a linked
worktree level with `origin/main` at `66fdbab`. Every exit code below was read
from `$?` on the command itself, not through a pipe.

| Command | Exit | Output |
|---|---|---|
| `NODE_ENV=development npm ci --include=dev` | 0 | — |
| `npm run typecheck` | 0 | nothing beyond the banner |
| `npm test` | 0 | `# tests 2259`, `# suites 351`, `# pass 2259`, `# fail 0`, `# cancelled 0`, `# skipped 0`, `# todo 0`, `# duration_ms 16403.668466` |
| `env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build` | 0 | — |
| `npm audit` | 0 | `found 0 vulnerabilities` |
| `npm audit --audit-level=high` | 0 | `found 0 vulnerabilities` |

`NODE_ENV=development npm ci --include=dev` rather than a bare `npm ci` for the
reason `CLAUDE.md` gives: this image's `NODE_ENV=production` makes a bare install
exit 0 having skipped devDependencies, and both scripts then fail with exit 127
for a reason that is not the code.

**The tree is green again, and 681 more assertions than the survey recorded** —
2,259 against 1,578. None of them renders a page component, against 3,918 more
lines of page code. That is [F5](01-frontend.md#f5-nothing-that-renders-is-checked-by-anything) for the third time in this file,
and it is why that row is now ranked first.

**All four of the survey's commands were re-run and all four pass. Everything
the survey could not do, this refresh could not do either.**
`SELECT COUNT(*) FROM runs` on the live install is still impossible here —
`DATA_DIR` is unreadable by the agent uid — so the recommendation's own falsifier
is **unrun**, before the work and after it. No container was started, because
Docker is unavailable, so no landing collision was reproduced and
[B1](02-backend-logic.md#b1-the-landing-guard-covers-landrun-and-none-of-the-other-four-doors) stays medium. No browser was opened, at any viewport.
And no GitHub issue was read, deliberately, which is why every issue number in
the register is marked assumed.

### The security pass, 2026-09-06

**This pass changed no code either.** `src/` is untouched, no GitHub issue was
opened, closed or commented on, and nothing outside `proposals/GapRegister/` was
edited except the [proposals index](../README.md) line that summarises this
directory. So, as with the refresh, a failure below would be a finding about
`main` rather than about the pass. There was none. Same worktree, same tree
(`origin/main` at `66fdbab`), exit codes read from `$?` on the command itself.

| Command | Exit | Output |
|---|---|---|
| `NODE_ENV=development npm ci --include=dev` | 0 | `found 0 vulnerabilities` |
| `npm run typecheck` | 0 | nothing beyond the banner |
| `npm test` | 0 | `# tests 2259`, `# suites 351`, `# pass 2259`, `# fail 0`, `# cancelled 0`, `# skipped 0`, `# todo 0`, `# duration_ms 16401.747132` |

**Identical to the refresh's figures, and that is the expected result rather than
a reassuring one**: nothing under `src/` changed, so the same suite ran over the
same code. `env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build` and `npm
audit` were **not** re-run on this pass, because neither can say anything about a
tree that is byte-identical to the one the refresh ran them against four commits
of prose ago. That is a deliberate omission and it is named here rather than left
to be inferred from the table's length.

**Two of the five rows are precisely about a green suite not telling you
anything.**
[S2](07-security.md#s2-the-status-route-authenticates-a-browser-against-the-master-token-which-the-session-cookie-stopped-being)
is an assertion that passes on a cookie value the login route can no longer
issue, and
[S4](07-security.md#s4-the-no-literal-rule-is-pinned-by-an-assertion-whose-fixture-omits-the-one-notice-that-carries-figures)
is an assertion whose fixture omits the one thing its own failure message claims
to be about. Both are inside the 2,259 above.

**What this pass could not reach**, beyond everything the refresh could not: no
request was made against a running server, so
[S1](07-security.md#s1-the-all-sessions-branch-of-the-logout-route-takes-no-credential-and-revoking-a-session-does-not-end-it)'s
unauthenticated `POST` and
[S5](07-security.md#s5-the-one-write-path-the-edge-gate-exempts-buffers-an-unbounded-body)'s
unbounded body are read out of the tree rather than demonstrated against a
listener; and who can reach the port at all is
`proposals/implemented - Sandboxing/`'s question, deliberately left there.
Full accounting in [00-method.md](00-method.md#the-security-pass-2026-09-06).
