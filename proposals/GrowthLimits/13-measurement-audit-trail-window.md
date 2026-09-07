# Measurement — how many days a 20,000-row audit window buys

**Months, not hours.** At the busiest run rate this install has ever had
measured — 27.3 runs/day — `request_log` fills in **roughly 8 months**, and the
plausible band is **5 months to a year**. At the rate of the last eleven days it
is **over a year and a half**. Nothing on the request axis makes it shorter,
because the only machine-driven writer in the app is `POST /api/mcp` and
everything else in the table is an operator's click. `RETENTION_ROWS` should
stay at 20,000.

This answers [12-validation.md](12-validation.md) §4, which
[09-option-g](09-option-g-time-based-audit-horizon.md) handed to validation
after refusing the horizon change, and it answers the question
[GapRegister G4](../GapRegister/03-growth.md) asks. Nothing in `src/` changed.

## What was re-measured at `594ac64`

09-option-g's grep counts are stale — it reports 33 wrapped exports over 26
files and cites `mcp/route.ts:671`. At HEAD:

```
grep -rho "export const \(GET\|POST\|PUT\|PATCH\|DELETE\) = auditMutation" src/app/api \
  | awk '{print $3}' | sort | uniq -c
     23 POST      8 DELETE      6 PUT      1 PATCH      0 GET
grep -rl "export const [A-Z]* = auditMutation(" src/app/api --include=route.ts | wc -l
     31
```

Plus `/api/mcp`, which wraps itself inside the handler at
`src/app/api/mcp/route.ts:805` rather than at the export. **39 audited handlers
across 32 route files, and still no GET.** The counts moved; the zero did not,
and the zero is the load-bearing one.

Three structural facts behind the rate, each checked rather than assumed:

- `recordRequest` has no caller outside `src/lib/requestLog.ts`. Every row comes
  through `auditMutation`.
- `retention.ts` never names `request_log`. The per-insert eviction at
  `src/lib/requestLog.ts:117-121` is the only thing that removes a row.
- `src/lib/` holds exactly two self-URLs — `OTLP_SELF_URL` and `MCP_SELF_URL`.
  The OTLP ingest route is deliberately **not** wrapped
  (`src/app/api/otlp/v1/logs/route.ts`), so `POST /api/mcp` is the whole of the
  server-driven traffic that reaches this table. Schedules, `promoteQueued`,
  dependency release and the fleet sweeps all run in-process and write nothing.

**An idle hour contributes zero rows.** Not "few" — zero. No GET is audited, no
audited route is polled on a timer, and no background job posts to one.

## The arithmetic

`proposals/ContinuousImprovement/00-problem.md` measured the live database
directly: **294 runs over 10.761 days**, i.e. **27.3 runs/day**. That is the
only real run-rate reading anyone here has taken, and it is the busiest window
the install has had.

A run's own audit cost is small and is bounded above by 1 row for its creation:
`POST /api/runs` takes a batch (`src/app/api/runs/route.ts:202` loops over the
entries) and `POST /api/workflows/[id]/run` instantiates a whole graph, so one
audited request routinely creates several runs. What follows a run is operator
clicks — resume, review, land, deliver, priority, set-aside, reopen, delete —
each one row. A landed run costs about 3; a quiet one costs 1.

| Rows per run | Rows/day at 27.3 runs/day | Days to fill 20,000 |
|---|---|---|
| 2 | 55 | **366** |
| 3 | 82 | **244** |
| 5 | 137 | **146** |

Cross-checked against git, which is the other record of the same activity.
`git log --merges --oneline --since=2026-08-10 --until=2026-08-21 origin/main`
returns **105 merges** in the window the 294 runs were counted over — 36% of
runs land. The same command over `2026-08-27..2026-09-07` returns **41**, which
scaled by that ratio is ~115 runs, or **10.5 runs/day**. On the current rate the
three-rows-per-run column is **630 days**.

To bring the window down to a **fortnight** the table needs 1,429 rows/day. To
bring it down to **four hours** it needs 1.4 rows *per second*, sustained. The
run axis is three orders of magnitude away from the second figure.

### The one term that is not bounded here

The MCP client is `type: "http"` with no server stream (`src/lib/chat.ts:3373`;
`GET /api/mcp` answers `-32601` at `src/app/api/mcp/route.ts:844`), so one
JSON-RPC message is one POST is one row. The handshake is exactly **3 rows** —
`initialize`, the `notifications/initialized` notification (which gets a bodyless
202 and is still a wrapped POST, `route.ts:830`), and `tools/list` — and then
**1 row per `tools/call`**, including calls naming a tool that does not exist.
So:

```
rows/day = runs/day × rows-per-run  +  sessions/day × (3 + tool-calls-per-session)
```

A session is a **chat turn** (`src/lib/chat.ts:2645-2649`) or an **orchestrator
block**, one per claimed block and so one per loop pass
(`src/lib/workflows.ts:3993, 4079-4080`). Merge blocks and ordinary work cycles
open none: `--mcp-config` appears nowhere in `src/` outside `chat.ts`, which is
the split `src/lib/agents.ts:349` states.

**Nothing in the code caps tool calls per session.** There is no `--max-turns`
in the argv (`src/lib/chat.ts:2410-2509`); the only ceilings are money —
`--max-budget-usd` from `chatTurnBudgetUSD`, default **2** at
`src/lib/settings.ts:903` — and `CHAT_TIMEOUT_MS`. The budget is a real bound,
just a loose one: the one chat turn ever measured end to end cost **$0.22**
(`docs/verification.md:303-304`), so the guard allows roughly nine times a
real turn's spend before it stops one.

Two things keep this term small today. The block half has **never executed** —
"no `claude` child has been spawned by `startBlockTurn`, no `emit_runs` call has
reached `/api/mcp`" (`docs/verification.md:3908-3909`) — so it contributes zero
until it does. And the chat half needs volume: **110 chat turns a day at ten
tool calls each** is 110 × 13 = 1,430 rows/day, which is exactly the fortnight
threshold and would dominate everything else here. Whether the install
does anything like that is **not measured** — see the commands below. It is the
only input that could change this document's answer.

For scale, the same corpus measured **29,251 `otlp_requests` rows over 11
days** — 2,659/day of genuinely machine-rate traffic. Had the ingest route been
audited, the window would be **under eight days**. It was not, on purpose, and
that decision is what buys the months.

## 1. The eviction is per-insert, and what it costs

Confirmed at `src/lib/requestLog.ts:117-121`: a second prepared statement, run
immediately after every INSERT, in its own implicit transaction. There is no
sampling and no "every Nth insert".

Measured on this container against a table built from the schema at
`src/lib/db.ts:1293-1307` (WAL, `foreign_keys` ON, `idx_request_log_ts`
present), filled to 20,000 rows, then 2,000 timed operations at steady state;
three runs:

| | µs/op |
|---|---|
| `INSERT` + `DELETE`, as shipped | 15.9 – 17.0 |
| `INSERT` alone | 9.5 – 10.1 |
| eviction's share of the shipped write | **39 – 43%** |

So the eviction is **6 to 7 µs**, and it is a large fraction of a very small
number. `better-sqlite3` is synchronous and there is one Node process, so these
writes serialise no matter how many agents are running; the app's own bound is
`maxConcurrentRuns: 4` and `maxConcurrentAssists: 2` in `src/lib/settings.ts`.
Six children each making an MCP call every 100 ms is 60 audited writes/second —
about 1 ms of CPU per second, of which the eviction is 0.4 ms. **The per-insert
eviction costs nothing worth reclaiming at this app's concurrency.**

The table also holds its size exactly: because `id` is `INTEGER PRIMARY KEY
AUTOINCREMENT` and nothing else ever deletes from it, ids have no gaps and the
`id <= MAX(id) - 20000` predicate is a true row count. The bench confirmed
20,000 rows still present after 6,000 further inserts. On disk that is
**2,621,440 bytes — 131.1 B/row**, growing to 2.88 MB with the freelist after
sustained churn. The docblock's "a few megabytes at worst" is accurate.

## 2. Who a row identifies

The columns are `ts, method, path, status, subject, actor, address,
duration_ms` (`src/lib/db.ts:1293`). No user, no session, and on the shipped
deployment no useful address either: `docker-compose.yml` publishes on
`${UF_BIND_ADDRESS:-127.0.0.1}:3000`, so on the default binding, with no reverse
proxy setting `x-forwarded-for`, every row's `address` is the loopback.
`subject` is the id of the *thing acted on*, not the actor. `actor` names a
credential class and never a credential.

**Most of this is [M2](../GapRegister/04-missing-features.md) restated, and M2
is refused correctly**: one credential and no user model means there is no person
to name, and a column that named one would be inventing an identity the app does
not have.

**One part of it is not a restatement.** A session id exists today and is not
recorded. `auth_sessions` has its own `id` primary key, and the cookie is
`v1.<id>.<exp>.<hmac>` — the id is a **plaintext, non-secret component**, with
the HMAC over it as the credential. `readSessionCookie` returns it as
`SessionClaim.id` and `src/middleware.ts:122` calls that on every gated request,
so the id is already in hand. There is a bearer-safe handle, at zero cost, that
would let an operator collapse a burst of rows into "this was one sign-in", and
`request_log` does not carry it. That does not identify a *person* — it
identifies a *sign-in*, which is the strongest thing this app can honestly say —
and it does not touch any of the four things `requestLog.ts:19-33` forbids.

Adding it is a schema column and therefore out of scope for this measurement.
Recorded here as the concrete form G4's "identifies no person" should take.

## 3. What the S3 lines add

The nine mutating route files S3 covers, none audited at HEAD:

```
grep -rn "^export \(const\|async function\) \(POST\|PUT\|PATCH\|DELETE\)" src/app/api \
  | grep -v auditMutation
  claude-auth/login, claude-auth/login/code, claude-auth/logout
  codex-auth/api-key, codex-auth/login, codex-auth/logout
  logout, fleet, runs/restarted
```

Every one is operator-initiated and none is polled — the auth routes are driven
by a paste-the-code form on the settings page, `POST /api/runs/restarted` is a
button in `src/components/RestartClosed.tsx:58`, and `POST /api/fleet` is a bulk
action. A sign-in costs about 2 rows, a sign-out 1, and both are rare. **S3 adds
single-digit rows per operator session — call it under 20 rows/day at any rate
this install has shown. It moves the window by well under 1%, and the retention
figure does not need to move because of it.**

`/api/logout` staying unaudited is a separate deliberate decision, stated at
`src/app/api/logout/route.ts:44`, for the same eviction-lever reason as the
`/api/mcp` 401. S3 should read that before wrapping it.

**One warning for whoever does S3.** There is a tenth unaudited mutating route,
`POST /api/workflows/validate`, and it is the only browser-driven writer in the
app that could reach machine rate: `src/components/WorkflowEditor.tsx:544,574`
fires it from a `useEffect` on `[body]` behind a 500 ms debounce, so laying out
a graph produces **up to 2 POSTs per second**. Audited, that is 7,200 rows per
hour of editing and it consumes the whole 20,000-row window in **under three
hours**. It is the one route that would turn the fortnight-versus-four-hours
question into four hours. Leave it out, or change the cap in the same commit.

## Recommendation

**Leave `RETENTION_ROWS` at 20,000, and leave the eviction where it is.** The
number says the window is months on every axis that has been measured; the cost
of the per-insert eviction is 6 µs against a 60-writes-per-second ceiling; and
09-option-g's refusal of a time horizon stands on an argument the measurement
does not disturb. Raising the cap would buy time the install does not need and
weaken a bound that is a term in the `/api/mcp` 401's security argument.

G4's surviving finding is the one 09-option-g already restated: **nothing shows
this table to anybody.** `idx_request_log_ts` exists for a time query no surface
runs. A trail that holds eight months and cannot be opened is not better than
one that holds four hours and cannot be opened.

## What could not be measured here, and the commands that would

`DATA_DIR` is not readable by the agent uid and Docker is not available in this
container, so the live table was never counted. The database in the main
checkout (`/workspace/UsageFoundry/.data/usagefoundry.db`) holds **8**
`request_log` rows spanning two minutes on 2026-08-19 — a smoke test, not a
corpus. Run these on the host:

```bash
# The occupancy and the real window, in one reading. If count is well under
# 20,000 the table has never evicted and the span is the install's whole life.
docker exec -i usagefoundry sqlite3 -readonly /data/usagefoundry.db \
  "SELECT COUNT(*),
          ROUND((MAX(ts)-MIN(ts))/86400000.0, 2) AS days_held,
          ROUND(COUNT(*) / ((MAX(ts)-MIN(ts))/86400000.0), 1) AS rows_per_day,
          ROUND(20000.0 / (COUNT(*) / ((MAX(ts)-MIN(ts))/86400000.0)), 0) AS days_to_fill
     FROM request_log;"

# The unbounded term: how much of it is MCP, and what a turn actually costs.
docker exec -i usagefoundry sqlite3 -readonly /data/usagefoundry.db \
  "SELECT path, actor, COUNT(*) FROM request_log
    GROUP BY path, actor ORDER BY 3 DESC LIMIT 20;"

# Rows per run, which the table above only estimates at 2-5.
docker exec -i usagefoundry sqlite3 -readonly /data/usagefoundry.db \
  "SELECT COUNT(*) * 1.0 / (SELECT COUNT(*) FROM runs) FROM request_log
    WHERE path LIKE '/api/runs%';"
```

The first query's `days_to_fill` is the number this document derives. If it
comes back under 60, the MCP term is larger than anything reasoned here and the
recommendation should be re-taken on that reading rather than on this one.

## Score summary

| | |
|---|---|
| Days a 20,000-row window buys, at 27.3 runs/day measured | **≈244** (band 146–366) |
| At the last eleven days' rate (~10.5 runs/day) | **≈630** |
| Rows an idle hour contributes | **0**, structurally |
| Audited handlers at `594ac64` | 39 over 32 files, **0 GET** |
| Bytes at the cap | 2,621,440 — **131.1 B/row**, measured |
| Eviction's share of the shipped write | **39–43%**, i.e. 6–7 µs |
| What S3's nine routes add | **<20 rows/day**; retention figure unmoved |
| MCP cost per session | **3** handshake rows + 1 per tool call, no code cap |
| Orchestrator-block MCP path | **never executed** on this install |
| Unmeasured term | MCP tool calls per day — command given above |
| Recommendation | **leave `RETENTION_ROWS` at 20,000** |
