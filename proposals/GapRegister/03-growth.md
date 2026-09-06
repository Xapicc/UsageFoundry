# Growth

Five gaps, and the first is the shape of the other two.

> **Re-checked against `main` at `66fdbab`.** All four are open. [G1](#g1-nine-list-routes-read-parameters-the-one-for-runs-does-not-and-the-pattern-repeats-three-times)'s
> lead example was closed and the pattern it claims survives at two of its three
> instances; [G2](#g2-chat-threads-past-the-newest-30-cannot-be-reached-at-all), [G3](#g3-one-process-is-the-hard-ceiling-and-the-usual-escape-route-is-not-the-one-that-applies) and [G4](#g4-the-audit-trail-is-20000-rows-deep-evicted-on-every-insert-and-identifies-no-person) are untouched.
>
> **The fourth pass, 2026-09-06, added [G5](#g5--the-chat-page-re-reads-and-re-serialises-every-message-in-the-thread-every-three-seconds-and-nothing-bounds-the-thread) and a fourth instance to
> [G1](#g1-nine-list-routes-read-parameters-the-one-for-runs-does-not-and-the-pattern-repeats-three-times)'s
> table.** G1's argument is now carried by four caps rather than three; G5 is the
> first row on this axis argued from a query plan rather than from a constant.
> One of the two refutations at the bottom of this file is now stale in its
> facts and unchanged in its conclusion: the three npm advisories were cleared by
> `102050d` and `npm audit` reports `found 0 vulnerabilities`.

Two candidates that look like growth limits are documented deliberate ceilings.
They are refuted at the bottom of this file rather than registered, on the same
grounds as the four in
[00-method.md](00-method.md#refuted-or-already-decided). That matters for the
register's credibility: the workflow caps and the `npm audit` gate are the two things a
casual sweep would flag first, and both are already reasoned about in the
repository, in more detail than a flag would have added.

---

## G1 — Nine list routes read parameters; the one for runs does not, and the pattern repeats three times

> **Open at `66fdbab` with its lead example struck, and the row is stronger for
> it.** `/api/runs` is no longer the route that reads nothing: it reads five
> parameters (`src/app/api/runs/route.ts:77-97`). The survey re-run at `66fdbab`
> is 68 `route.ts` files under `src/app/api`, **eleven** of which read
> `searchParams` — the ten this row counted plus `/api/runs`. **The route that
> now returns a capped list and reads none is `/api/chat`**
> (`src/app/api/chat/route.ts:15-27`), whose list is `listChats()`'s 30. So the
> title's arithmetic is out of date and its claim — that this is a pattern, fixed
> one instance at a time, months apart — is exactly what happened: one of the
> three was closed on its own and the other two were not touched.
>
> **A fourth instance, found by the fourth pass, 2026-09-06**, in the
> `workflows.ts` region [00-method.md](00-method.md#what-was-deliberately-left-unread) named as unread. `listInstances(workflowId, limit = 20)`
> at `src/lib/workflows.ts:2103` is called with no second argument at
> `src/app/api/workflows/[id]/route.ts:29`, and that route reads no
> `searchParams` — `grep -n "searchParams" src/app/api/workflows/[id]/route.ts`
> returns nothing. So a workflow's own history is the newest **twenty** presses
> of Run, permanently, with no paging, no filter and no date range, on the one
> surface that answers *what has this graph done*. The table below gains a row and
> the count in the title becomes four; the argument does not change, which is the
> point of it.

Not one cap. A class of them.

Every `route.ts` under `src/app/api` was checked for whether it reads
`searchParams`. Ten do. **`src/app/api/runs/route.ts` is the only route in the
tree that returns a capped list and reads none** — its whole body is
`listRuns(100)` at `:49`.

The same shape appears three times, in three modules, with three different
numbers:

| Surface | Cap | Where at `175ba57` | Where at `66fdbab` | Parameter to move it |
|---|---|---|---|---|
| Runs list | 100 | `src/app/api/runs/route.ts:49` | **closed** — `offset`, `limit`, `status`, `q`, `settledBefore` at `:77-97` | five |
| Chat threads | 30 | `src/lib/chat.ts:289` (`listChats(limit = 30)`), called with no argument at `src/app/api/chat/dto.ts:89` | `src/lib/chat.ts:387`, called with no argument at `src/app/api/chat/dto.ts:132` | none |
| GitHub repositories the chat can name | 25 | `src/lib/workspace.ts:168, :188` | `src/lib/workspace.ts:168, :188` | none |
| A workflow's instance history | 20 | not surveyed | `src/lib/workflows.ts:2103`, called with no argument at `src/app/api/workflows/[id]/route.ts:29` | none |

And the counter-example is in the same tree. `/api/branches` takes `repo`,
`offset` and `limit` (`src/app/api/branches/route.ts:25-40`) with a docstring
stating the principle:

> `repo` and `offset` are what make the whole set reachable rather than only its
> newest page.

So does `/api/knowledge/search`, which is a real search — `?q=` over title,
alias, tag and path, `?limit=` defaulting to 50 and capped at 200
(`src/app/api/knowledge/search/route.ts:9-19`). **This repository contains a
working, parameterised, capped search implementation, and it is pointed at the
operator's vault rather than at the operator's own runs.**

**Why this is a growth gap and not three bugs.** Each cap was reasonable when
written and none of them fails; they simply stop being enough as an install
accumulates, and there is no signal at the boundary except the one line the runs
page renders. An install grows into all three at different times, so each is
discovered separately, as a mystery, months apart.

**Blast radius.** Run history, chat history, and which repositories the
orchestrator can reason about.

**Cost of leaving it.** Rising with use, which is the definition of the axis.
An install that has done ten thousand runs has the same window onto them as one
that has done a hundred and one.

**Confidence: high.** The route survey is a loop over `find src/app/api -name
route.ts` grepping for `searchParams`; the three caps are read from source.

**Owned by:** nothing owns the pattern. The runs half is
[F1](01-frontend.md#f1-run-history-stops-at-100-rows-and-cannot-be-paged-filtered-or-searched)/[F2](01-frontend.md#f2-quick-open-the-apps-only-search-surface-inherits-that-cap), the repositories half is
[B5](02-backend-logic.md#b5-the-chat-can-identify-only-the-first-25-repositories-always-the-same-25) and #78.

---

## G2 — Chat threads past the newest 30 cannot be reached at all

> **Open at `66fdbab`, unchanged, and now the register's clearest single
> demonstration.** [G1](#g1-nine-list-routes-read-parameters-the-one-for-runs-does-not-and-the-pattern-repeats-three-times)'s runs half was closed with five
> parameters on one route; this one, which needs one parameter and the same
> shape, was not touched. `/api/chat` inherits `/api/runs`' old description
> exactly: the capped list route that reads no `searchParams`.

Broken out from [G1](#g1-nine-list-routes-read-parameters-the-one-for-runs-does-not-and-the-pattern-repeats-three-times) because its ceiling is the lowest and its content is
the least replaceable.

`src/lib/chat.ts:387` is `export function listChats(limit = 30): ChatRow[]`.
`src/app/api/chat/dto.ts:132` calls `listChats()` — no argument, so 30. The route
at `src/app/api/chat/route.ts:15-27` reads nothing from the request and returns
`{ chats: chatListDTO(), chat: chatDTO(chat) }`.

There is no chat search, no date filter, and Quick open does not index chats
([F2](01-frontend.md#f2-quick-open-the-apps-only-search-surface-inherits-that-cap)). A thread is reachable by URL if the operator kept the
id, and otherwise not.

What is in a thread makes this worse than the run list. `docs/agent/chat.md`:
prompt text is *the one half of a run a model may write*, and a proposal that
was approved is a decision with reasoning attached. Thirty threads on an active
install is weeks, not months.

**Blast radius.** Every past orchestrator conversation.

**Cost of leaving it.** The reasoning behind approved runs becomes
unrecoverable on a rolling window nobody chose the width of — 30 was a sensible
default for a list, not a decision about how much history to keep.

**Confidence: high.**

**Owned by:** nothing.

---

## G3 — One process is the hard ceiling, and the usual escape route is not the one that applies

> **Open at `66fdbab`, unchanged in mechanism and in cost.** `serverLock.ts:214`
> and `:394` still say what is quoted below, `MAX_MERGE_WORKERS` is still 4 and
> `MAX_WORKTREE_SLOTS` still 64 (its line moved from `:2675` to `:3196`), and
> the operator-facing half is still missing: `docs/install.md` states no capacity
> position, and the nearest thing to one is a note that four merge workers is "a
> real ceiling" living in `docker-compose.yml` (`docs/install.md:794`). What the
> tree *does* now document is the read-only second process
> (`docs/agent/concurrency-and-ownership.md:14`), which is the mechanism and not
> the product position this row asks for. Nothing here has a cost today, which is
> why it stays last.

The single-writer design is real and deliberate. `serverLock.ts:214` types
ownership as `"unclaimed" | "owned" | "held" | "lost"`; `:394` records that
*"`unclaimed` is deliberately not a refusal"*; `docs/agent/concurrency-and-ownership.md`
makes "every writer asks the lock at the moment of the write" an invariant, and
the `ReadOnlyNotice` banner is what a second replica gets. That closed #93 and
it is right.

It also means the install's ceiling is **the process**, and every concurrency
constant — `maxConcurrentRuns`, `maxConcurrentAssists`, `MAX_WORKTREE_SLOTS = 64`
(`src/lib/orchestrator.ts:3196`), `MAX_MERGE_WORKERS = 4`
(`src/lib/mergeQueue.ts:613`) — is a ceiling on one machine's one Node process,
several of whose paths are synchronous because better-sqlite3 is.

**What the vault says, and what it says against the obvious framing.**
`3 Resources/Data and Storage/When an Embedded Database Stops Being the Right Answer.md`
names two structural boundaries at which an embedded database stops being the
right answer: **more than one serial write queue is needed**, and **the
filesystem must be shared across hosts**. Neither is crossed here. The write
queue is deliberately serial and the filesystem is deliberately one host's. So
the honest finding is the inverse of the one a growth survey usually reaches:
*SQLite is not the constraint, and swapping it would buy nothing.* The
constraint is that the app has one process and no story for a second one beyond
refusing it.

**Blast radius.** Whether an install can grow past what one machine runs.

**Cost of leaving it.** Zero today, unbounded later, and unusually cheap to
*decide* — the question is whether horizontal scale is a goal at all, and the
answer might well be no. A single-container product with an explicit "one
machine" position is a coherent product. Nothing in `docs/` states that
position, which is the actual gap: the ceiling exists, and it is not written
down anywhere an operator planning capacity would find it.

**Confidence: high** on the mechanism and the constants. **Medium** on
severity — no install was observed near any ceiling, because `DATA_DIR` is
unreadable.

**Owned by:** nothing. This is the row most likely to be refused in
[06-recommendation.md](06-recommendation.md), and it is.

---

## G4 — The audit trail is 20,000 rows deep, evicted on every insert, and identifies no person

> **Open at `66fdbab`, unchanged, and at the same lines.** `RETENTION_ROWS` is
> still 20,000 at `src/lib/requestLog.ts:68`, the unconditional per-insert
> `DELETE` is still at `:119-121`, `actor` is still the only thing recorded about
> a caller (`:28-31, :53`), and `retention.ts` still does not touch
> `request_log`. The verification entry moved: the audit trail on a real database
> is `docs/verification.md:3201`, under the "Not yet verified by hand" heading at
> `:1865`.
>
> **One thing arrived beside it and is not a second instance of this row.**
> `webhook_deliveries` (`src/lib/notify.ts:322-353`) bounds itself the same way —
> `DELIVERY_RETENTION_ROWS = 2_000` at `:312`, deleted on every insert at
> `:345-350` — but its docblock at `:303-311` states the arithmetic that makes
> 2,000 enough and says why the
> bound is here rather than in `retention.ts`. Accepted on the record, on this
> file's own standard, and not a gap.

`src/lib/requestLog.ts:68` sets `const RETENTION_ROWS = 20_000;` and every
`recordRequest` runs, immediately after its `INSERT`:

```ts
"DELETE FROM request_log WHERE id <= (SELECT MAX(id) FROM request_log) - ?"
```

at `:119-121`. Nothing in `retention.ts` touches `request_log` — this is the
only eviction, and it is unconditional per write.

The cap is deliberate and `docs/agent/chat.md` explains why it must stay one:
`request_log` evicts on every insert, so auditing a credential-free refusal
would be a lever on the audit log itself, which is why the capability token's
401 is answered *outside* `auditMutation`. Do not raise this number without
reading that.

The gap is that **20,000 rows is the entire audit history and it is measured in
requests, not in time**. A polling browser generates requests continuously; a
fleet under load generates more. How many days 20,000 rows buys on a real
install is unknown here, because `DATA_DIR` is unreadable — and
`docs/verification.md:1033+` lists *"the audit trail on a real database"* among
the things not yet verified by hand, so it is unknown to the project too.

And what survives identifies no person. `requestLog.ts:28-31` is explicit and
correct about why:

> `actor` says **how** a caller authenticated — a session cookie, a bearer
> token, the chat's per-turn capability, or nothing at all — and never with
> what. That is the whole of what an audit needs: which credential class, not
> which secret.

That is right about *secrets*. It is a statement about credentials, not about
identity, and identity is genuinely absent — see [M2](04-missing-features.md#m2-one-credential-no-identity-no-authorisation).
An audit row says `session` because there is only one thing it could say.

**Blast radius.** Any question of the form "what happened, and when". Incident
review, and any compliance posture that needs a retained trail.

**Cost of leaving it.** Silent. The trail does not fail; it shortens, and the
day you need it is the day you learn how short.

**Confidence: high** on the mechanism. **Low** on how many days 20,000 rows is
— that number is exactly what a survey would have to measure first.

**Owned by:** nothing directly. #91 is open on the operational surface and
should be read alongside.

---

## G5 — The chat page re-reads and re-serialises every message in the thread, every three seconds, and nothing bounds the thread

> **Added by the fourth pass, 2026-09-06.** The first row on this axis argued
> from an `EXPLAIN QUERY PLAN` rather than from a cap in source — see
> [00-method.md](00-method.md#the-fourth-pass-2026-09-06) for how the schema was
> materialised without a readable `DATA_DIR`.

`chatDTO` is the shape both chat routes answer with, and it carries the whole
thread (`src/app/api/chat/dto.ts:58`):

```ts
    messages: listMessages(chat.id).map((m) => ({
```

`listMessages` has no `LIMIT`, no offset and no cursor
(`src/lib/chat.ts:410-413`):

```ts
export function listMessages(chatId: string): ChatMessageRow[] {
  return db()
    .prepare("SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY seq")
```

**And the route it feeds is polled.** The file says so itself at
`src/app/api/chat/dto.ts:96` — *"the chat page polls this route every few
seconds"* — and the page's timer is `src/app/chat/page.tsx:460-464`, at
`POLL_ACTIVE_MS` while a turn is in flight and `POLL_IDLE_MS` otherwise:
**3,000 ms and 10,000 ms** (`:54-55`). So while a turn runs, every message ever
written to that conversation is selected, sorted, mapped and JSON-encoded twenty
times a minute.

The plans, taken against a freshly migrated schema:

```
SELECT * FROM chat_messages WHERE chat_id='x' ORDER BY seq
  SEARCH chat_messages USING INDEX idx_chat_messages_chat (chat_id=?)
  | USE TEMP B-TREE FOR ORDER BY

SELECT * FROM chat_sessions ORDER BY updated_at DESC LIMIT 30
  SCAN chat_sessions | USE TEMP B-TREE FOR ORDER BY
```

The lookup is indexed; the ordering is not, so each poll builds a temporary
B-tree over the thread. The same response also carries `chatListDTO()`
(`src/app/api/chat/dto.ts:131-141`), which scans and sorts `chat_sessions` whole
and then runs `pendingProposals` and `pendingQuestions` per row — sixty-one
statements per poll at the 30 of [G2](#g2-chat-threads-past-the-newest-30-cannot-be-reached-at-all).

**Nothing bounds the thread.** `chat_messages` is on no retention horizon, has
no delete handler and no cap —
[O5](08-operations.md#o5--a-chat-thread-and-every-message-in-it-is-permanent-no-horizon-no-delete-and-the-cascade-has-nothing-to-cascade-from)
is that row, and this is what it costs while the thread is *open* rather than
after it is closed. The two compound in a way neither says alone: past the
thirtieth thread a conversation is undeletable and unreachable, and before that
it is undeletable and re-read whole every three seconds.

**The mechanism that would fix it is in the same repository, built for runs.**
`/api/runs/[id]/stream` takes an `after` cursor and ships only events past it
(`src/app/api/runs/[id]/stream/route.ts:135-141`, the evidence
[F4](01-frontend.md#f4-a-runs-log-cannot-be-searched-or-filtered) closed on), and
`run_events` is the store this app most expects to be large — 113,073 rows in
eight days on this install, counted in the comment at
`src/lib/orchestrator.ts:7306`. The run log is incremental because somebody
reasoned about its size. The chat thread, which is the newer surface, is not.

**Blast radius.** Every open chat, on the single process
[G3](#g3-one-process-is-the-hard-ceiling-and-the-usual-escape-route-is-not-the-one-that-applies)
is about, where `better-sqlite3` is synchronous and the sort happens on the
event loop that also runs every agent.

**Cost of leaving it.** Rising with the length of a conversation, with no
boundary and no signal at one — the axis's definition. The absolute figure is
**not measured**: no thread of any length exists in a readable database here, so
what this costs at a hundred messages against a thousand is arithmetic from the
plan and not a timing.

**Confidence: high** on the mechanism and on the plans, which are quoted from a
schema `migrate()` built on this tree. **Low** on severity, for want of a real
thread to time it against — that is dropped candidate 3 in
[00-method.md](00-method.md#dropped-for-lack-of-evidence) still standing, on the
half this pass could not close.

**Owned by:** no issue. #21, #26, #28 and #30 are the closed chat-poll issues
and every one of them is about the poll *failing* or being cached, never about
what it carries.

---

## Refuted on this axis

**The workflow caps are too low.** `MAX_WORKFLOW_NODES = 25`, `MAX_FAN_OUT = 10`,
`MAX_LOOP_PASSES = 20` (`src/lib/apiTypes.ts:1595, :1606, :1615` at `66fdbab`;
`:980, :991, :1000` when surveyed — the constants and their docblocks are
unchanged). Each carries a
docblock giving the reason, and the reasons are about *safety*, not about
capacity — `MAX_FAN_OUT` is deliberately tighter than `MAX_WORKFLOW_NODES`
because those runs *"are chosen by a model and start with no approval between
the decision and the spawn"*, and `MAX_LOOP_PASSES` bounds *"what one press of
Run can put on the machine over the life of a block whose repetitions nobody
watches."* Raising them is a request for a different risk position, not a fix.
Not a gap.

**The three high-severity npm advisories — since cleared, and the refutation
outlived them.**

> **Corrected at `66fdbab`.** `npm audit` on this tree now reports
> `found 0 vulnerabilities`, and `npm audit --audit-level=high` exits 0. The fix
> was not the semver-major move this section reasoned about: commit `102050d`,
> *"Clear the three high-severity advisories under `next`"*, added an `overrides`
> block pinning `postcss` to `^8.5.26` inside `next` (`package.json:23-27`).
> `next` is still `^15.5.4` (`package.json:19`, resolving to 15.5.24), and the
> CI gate is still `critical` at `.github/workflows/ci.yml:163` with its
> thirty-seven-line argument intact at `:126-163`, and it still opens by naming
> the three advisories "as of 2026-08-14" (`:130`), which is now a description of
> a tree that no longer exists. **The conclusion this section
> reached is unchanged and the reasoning under it is now historical**, which is
> the outcome an accepted-on-the-record decision should have: it was accepted,
> and then it was fixed anyway by a narrower move than the one it declined.

As surveyed at `175ba57`: `npm audit` reported `3 high severity
vulnerabilities`, all inside `next`'s subtree, fixable only by `next@16.3.2` — a
semver-major move. The CI gate is set at `critical`,
not `high`, and `.github/workflows/ci.yml:126-163` is thirty-seven lines
explaining that decision advisory by advisory: which four postcss GHSAs, why
postcss here only ever sees `src/app/globals.css` and Tailwind's output under an
explicit `@source` with `source(none)`, why nothing under `src/` imports
`next/image` so the only route to `sharp` is an optimiser with empty
`remotePatterns`, and why gating at `high` *"would leave this job red every day
for three advisories a human has already read, which is how a gate stops being
read at all."* The unconditional `npm audit || true` at `:124` keeps `critical`
from being a silent pass.

The only thing that survey's run changed was the version number — the comment
says `next@16.3.1` as of 2026-08-14 and `npm audit` then said `next@16.3.2`. The
advisory set was unchanged. **Accepted on the record is not a gap**, and this is
the clearest example in the repository of the standard the rest of this register
is trying to meet. At `66fdbab` there is no advisory set left to accept.
