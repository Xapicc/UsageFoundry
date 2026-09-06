# Security and the trust boundary

Five gaps, surveyed at `main` `66fdbab` on 2026-09-06.

**This axis is the reverse direction from `proposals/implemented - Sandboxing/`.**
That proposal owns what a run can reach: filesystem, network, and one run
against another. This one owns what reaches **the app**: its own doors, its own
credentials, its own inputs. Where a finding here would have needed a claim
about what a sandboxed child can dial, the claim is not made and the candidate
is in [§ Dropped for lack of evidence](#dropped-for-lack-of-evidence-on-this-axis)
saying so.

**`docs/agent/security.md` is thirty paragraphs of stated position, which makes
this the one axis where the register's third observation can be tested rather
than asserted.** Every other axis file reports gaps in areas `docs/agent/` never
had an opinion about; here there are opinions, and a gap can therefore be a
contradiction rather than an omission. One of the five is:
[S1](#s1-the-all-sessions-branch-of-the-logout-route-takes-no-credential-and-revoking-a-session-does-not-end-it)
contradicts `docs/agent/security.md:26` in the sentence that justifies the
route's exemption from the edge gate. That is the strongest kind of row this
directory can carry and it is the reason the register's closing observation had
to be rewritten.

The other four are the shape the rest of the register already has: a check whose
premise expired, a trail with holes rather than a short trail, an assertion
scoped narrower than its own failure message, and a boundary that does not bound
its input.

**Nothing here was fixed.** `src/` is untouched by this pass and no GitHub issue
was opened, closed or commented on.

---

## S1. The all-sessions branch of the logout route takes no credential, and revoking a session does not end it

**Two halves, one mechanism, and each makes the other worse.**

`POST /api/logout` is exempt from the edge gate unconditionally
(`src/middleware.ts:52-54`), which is correct and argued: signing out must not
require a valid session, or a stale cookie becomes the one state an operator can
never leave. `docs/agent/security.md:26` states the exemption's whole
justification in one clause:

> `/api/logout` is the third, and it is the one that grants nothing: it revokes
> the id inside the cookie it is handed

**The `all` branch is handed no cookie.** `src/app/api/logout/route.ts:30-43`:

```ts
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { all?: boolean };

  if (authEnabled()) {
    if (body.all === true) {
      revokeAllSessions();
    } else {
      const cookie = readCookie(req);
      ...
```

The cookie is read on the `else` branch only. `body.all` comes off an
unauthenticated request body: the middleware let the request through, the
handler checks nothing, and `revokeAllSessions()`
(`src/lib/sessions.ts:69-72`) marks every live row revoked. There is no rate
limit on this path (`login_attempts` and `loginLimiter.ts` are reached from
`/api/login` alone) and no audit row, because the route is one of the nine in
[S3](#s3-nine-mutating-route-files-write-no-audit-line-and-six-of-them-are-the-credential-routes).

**The second half is what makes the first half's damage small and the route's
own promise empty.** `revoked_at` is read by exactly one caller in the tree:

```
$ grep -rn "revoked_at\|revokedAt" src/ --include=*.ts --include=*.tsx | grep -v "\.test\."
src/lib/sessions.ts:29,36,43     the column and its DTO
src/lib/sessions.ts:63,72        the two writers
src/lib/sessions.ts:87,91        activeSessionCount
src/app/api/settings/route.ts:134  activeSessions, for the Settings page
```

`getSession` exists and is called from `src/app/api/login/route.test.ts:110`
and `:133` and from nowhere else in `src/`. **Nothing on a request path reads
revocation.** `middleware.ts:122-125` validates the cookie through
`readSessionCookie`, which is an HMAC and a signed expiry and no database, for
the reason the file states at `:2-4`: it runs in the edge runtime and cannot
reach SQLite.

`docs/agent/security.md:28` records that limitation for the ordinary case and is
explicit that closing it means moving the gate off the edge runtime. What it
does not say, and what the route says instead, is
`src/app/api/logout/route.ts:22-23`:

> `all: true` closes every outstanding one, which is the operator action for a
> cookie that got out rather than for the browser in front of you.

**A cookie that got out is precisely the case the documented limitation says
this cannot answer.** A leaked `uf_session` keeps opening every route until its
own `SESSION_TTL_MS` expiry, whatever the operator presses. The operator is
offered a remedy, the remedy runs, the Settings page then reports zero
outstanding sessions, and the leaked cookie still works.

**So the two halves compose into the failure worth naming.** An unauthenticated
caller can zero the one figure an operator would use to check whether anybody
else is signed in, while changing nothing about who actually is.

**No test.** `src/app/api/logout/` contains `route.ts` and nothing else.
`revokeAllSessions` has one caller and it is the unauthenticated branch above.

**Blast radius.** The accuracy of what the app says about its own access, and
the credibility of the one session-revocation control it offers.

**Cost of leaving it.** Standing rather than conditional. The `activeSessions`
figure is wrong about access every time it is read, because it reports
bookkeeping rather than reachability. The leaked-cookie remedy costs nothing
until a cookie leaks, and then costs everything, silently, because it reports
success.

**Confidence: high.** Every step is read off three files and there is no premise
to assume. What is **not** established here is who can reach the port: compose
binds `127.0.0.1:3000`, and whether a sandboxed child can dial loopback is
`proposals/implemented - Sandboxing/`'s question and not this one. The row
argues the door, never the reach.

**Owned by:** no issue. Adjacent to [M2](04-missing-features.md#m2-one-credential-no-identity-no-authorisation)
(#125) in subject and not in mechanism: M2 is that there is one credential for
everybody, this is that one route accepts none.

---

## S2. The status route authenticates a browser against the master token, which the session cookie stopped being

`src/app/api/status/route.ts:50-53`, the last two lines of `authorised()`:

```ts
  const cookie = /(?:^|;\s*)uf_session=([^;]*)/.exec(
    req.headers.get("cookie") ?? "",
  )?.[1];
  return Boolean(appToken && cookie && timingSafeEqual(cookie, appToken));
```

The comment three lines above says what it is for: *"The master token still
works, so an operator with a browser session does not have to find the monitor's
credential to read this page's data."*

**`uf_session` has not equalled `UF_AUTH_TOKEN` since the cookie was reshaped.**
`docs/agent/security.md:28` records the change in its first sentence: the cookie
"used to be `UF_AUTH_TOKEN` byte for byte" and is now
`v1.<32 random bytes>.<expiry>.<HMAC-SHA256 keyed by the token>`. The comparison
above is over the raw cookie value, so it can never succeed against a cookie
this server issues.

**The tree already asserts that, in the other direction.**
`src/lib/sessionToken.test.ts:59`:

```ts
assert.equal(await readSessionCookie(TOKEN, TOKEN, NOW), null);
```

A cookie equal to the token is rejected by the reader the edge gate uses. So the
value `/api/status:53` accepts is one no browser can be holding and one the
middleware would refuse anyway.

**And the test that covers this branch supplies exactly that impossible value.**
`src/app/api/status/route.test.ts:235-241`:

```ts
    // And the operator's own session still reads it, so nobody has to find the
    // monitor's credential to look at the same numbers.
    process.env.UF_AUTH_TOKEN = "master-token-value";
    assert.equal(
      (await get({ cookie: "uf_session=master-token-value" })).status,
      200,
    );
```

The assertion passes, and it passes on a cookie shape the login route can no
longer issue. The comment above it states a capability the code has lost, and
the test is what would otherwise have caught the loss. This is the same failure
[F5](01-frontend.md#f5-nothing-that-renders-is-checked-by-anything) is about,
narrowed to one assertion: a check that agrees with a comment rather than with
the system.

**What it costs, exactly.** The direction of failure is closed, not open: a 401
where a 200 was intended, and no credential is accepted that should not be. What
is lost is the stated capability. With `UF_STATUS_TOKEN` set, a signed-in
operator opening `/api/status` in the browser gets `{"error":"Unauthorized"}`,
and `docs/install.md:292`, `:719` and `:728` all point them at that URL. The
bearer branch at `:49` still works, so an operator who reaches for `curl` with
the master token is fine; only the browser path is broken.

**Blast radius.** One route, one credential class, in the safe direction.

**Cost of leaving it.** Low and constant: a route the install docs name three
times answers 401 to the person who owns the install, and the way anybody would
check is a green test that proves nothing.

**Confidence: high** on the mechanism and on the test, from three files. **The
401 itself is asserted from reading rather than observed**: no browser was
driven and no container was run, so what is verified is that no cookie value the
issuer can produce satisfies `:53`.

**Owned by:** no issue.

---

## S3. Nine mutating route files write no audit line, and six of them are the credential routes

```
$ for f in $(grep -rl "export async function \(POST\|PUT\|PATCH\|DELETE\)" \
      src/app/api --include=route.ts | sort); do
    grep -q auditMutation "$f" || echo "$f"; done
src/app/api/claude-auth/login/code/route.ts
src/app/api/claude-auth/login/route.ts
src/app/api/claude-auth/logout/route.ts
src/app/api/codex-auth/api-key/route.ts
src/app/api/codex-auth/login/route.ts
src/app/api/codex-auth/logout/route.ts
src/app/api/fleet/route.ts
src/app/api/logout/route.ts
src/app/api/runs/restarted/route.ts
```

`src/lib/requestLog.ts:4-13` states what the table is for, and states the case
these nine are:

> `runs.origin` answers *which gate*; this answers *which request*, including
> for the routes that create nothing, a stop, a delete, a settings change, a
> branch purge.

Six of the nine take, replace or destroy a **credential**: `claude auth login`
writes the 0600 OAuth credential every billed child runs against, and the Codex
pair writes an API key. `/api/logout` revokes sessions, including every session
at once and from an unauthenticated caller
([S1](#s1-the-all-sessions-branch-of-the-logout-route-takes-no-credential-and-revoking-a-session-does-not-end-it)).
None of the seven leaves a row.

**The asymmetry that makes this a row rather than an observation:**
`POST /api/login` **is** wrapped, at `src/app/api/login/route.ts:12` and `:146`.
So a sign-in is a line in `request_log` and a sign-out is not; a failed sign-in
is a line and a provider credential being replaced is not. An operator reading
the trail after an incident sees who got in and never sees who changed what they
got in with.

**It is not an oversight in the sense of nobody having looked.**
`src/app/api/codex-auth/api-key/route.ts:12-18` is a docblock that reasons
carefully about what an audit row for this route would *contain* and never about
there being none. That is the shape worth naming: the question was asked one
level down and not at this one.

**Distinct from [G4](03-growth.md#g4-the-audit-trail-is-20000-rows-deep-evicted-on-every-insert-and-identifies-no-person),
which is ranked immediately above it.** G4 is how long the trail is. This is what
never enters it. The two fail differently: a trail evicted at 20,000 rows still
had the line, and the line for a credential rotation was never written.

**Not every one of the nine is owed a row.** `/api/mcp`'s refusal is
deliberately outside `auditMutation` and `docs/agent/security.md:26` sets out
why at length: wrapping a route the middleware exempts hands an unauthenticated
caller a lever on the audit table itself, twenty thousand refusals at a time.
That reasoning applies exactly to `/api/logout`, which is also exempt, and it is
the argument the fix has to answer rather than an argument against the row. The
sign-in routes are behind the gate and carry no such objection.

**Blast radius.** Incident review of anything credential-shaped.

**Cost of leaving it.** Silent and conditional on there being a second person to
attribute to, which is the same condition
[M2](04-missing-features.md#m2-one-credential-no-identity-no-authorisation)
carries. Zero for a solo operator; on a team, the routes that matter most are
the ones with no line.

**Confidence: high** on the coverage, which is a command's output. **Medium on
the cost**, for M2's reason: no evidence available here says whether this
install has more than one operator.

**Owned by:** no issue. #91 is adjacent through G4.

---

## S4. The no-literal rule is pinned by an assertion whose fixture omits the one notice that carries figures

`docs/agent/security.md:22` is the longest paragraph in that file and the only
one with two dated incidents in it: a literal in `--append-system-prompt` is on
every concurrently running agent's command line, so it is a pattern that selects
the whole fleet, and `pgrep -f 3100` killed siblings twice. Its closing rule is
general:

> The flag now carries **five** notices under one value ... anything added to any
> of them inherits this bullet's rule, since all five are equally on every
> sibling's command line.

**The five are joined in one place**, `src/lib/cycleInvocation.ts:1110-1121`:
`SELF_HOSTING_NOTICE`, `DELEGATION_NOTICE`, `RENDERING_NOTICE`,
`COMMIT_IDENTITY_NOTICE` and `opts.fileCostNotice`.

**The assertion reads as covering all five.**
`src/lib/orchestrator.test.ts:2506` takes the whole flag value, and `:2516-2520`
says:

```ts
        assert.doesNotMatch(
          said,
          /\d\d+/,
          "no multi-digit literal: it is on every sibling's command line",
        );
```

**It never sees a price list.** The spawn under test is
`buildArgs({ ...base, permissionMode, isolated })` (`:2494`), and `base` does not
set `fileCostNotice`. Every use of that option in the file is an explicit
override at `:2348`, `:2371`, `:2387`, `:2822` and `:3454`, and the first of them
is the proof of what the production value looks like: it passes a notice
containing `— 116k`.

**The other test asserts the opposite property of the same string.**
`src/lib/fileCostNotice.test.ts:165`:

```ts
  for (const line of lines) assert.match(line, /— \d+k$/, "a line was clipped mid-figure");
```

Every price line is required to end in a figure. So the value that reaches a
real child's argv carries multi-digit literals by construction, and the
assertion whose message is *"it is on every sibling's command line"* is scoped
to a fixture where that clause is not true.

**The rule itself is not violated, and saying otherwise would be the easy
mistake.** `docs/agent/security.md:22` anticipates the price list by name and
argues it is safe on different grounds: what keeps it inert is not that the
strings differ but that nothing near them offers a pattern, no verb beside them
is `kill`, and the block names no command.
`src/lib/fileCostNotice.test.ts:228` pins that weaker form, and pins it well.

**The gap is that the two forms are not distinguished anywhere a future editor
would look.** The strong assertion's failure message states a property of the
whole flag; the weak assertion lives in another file under a name the doc itself
records as stale (*"its docblock still calls that case `noticeIsInert`, which is
a name nothing carries"*). An editor who adds a figure to `RENDERING_NOTICE` is
caught. An editor who adds a line to the price list's rendering, which is where
digits are already permitted, is checked only against `kill`, `pgrep`, `ps -`,
`$(` and absolute paths, and reads a green suite whose loudest assertion says no
multi-digit literal ships at all.

**And the shared literal is real, not hypothetical.** Every run on the same
repository gets the same price list, so `142k` and the repo-relative paths beside
it are exactly the class of string that made `pgrep -f 3100` fatal. The defence
is that nothing offers them as a pattern, which is a defence made of prose over a
failure mode that has fired twice.

**Blast radius.** The fleet, through the one mechanism `docs/agent/security.md`
documents as having ended fourteen runs.

**Cost of leaving it.** Zero until someone edits a notice or the price list's
rendering, and the register's own experience is that both get edited: the flag
went from one notice to five since the incident.

**Confidence: high** on the scoping, which is four line references in two test
files and one join site. **Medium on the severity**: whether a price figure is
actually reachable as a kill pattern was not demonstrated, and the documented
argument that it is not is a good one.

**Owned by:** no issue.

---

## S5. The one write path the edge gate exempts buffers an unbounded body

`/api/otlp/v1/logs` is exempt from `middleware.ts` (`:81-83`) and authenticates
itself, and it does so in the right order:
`src/app/api/otlp/v1/logs/route.ts:39` and `:53` refuse without a live per-run
ingest token, and `:57` is the first line that touches the body:

```ts
  const payload = await req.json();
```

There is no byte cap on that read, nothing in `next.config.ts` configures one,
and `parseLogsPayload` in `src/lib/otlp.ts` bounds its **output** (`:495`,
`slice(0, TOP_RUNS)`) rather than its input. The whole body is buffered and
parsed in the single Node process that also runs every agent, the run loop and
SQLite.

**The caller is not a stranger.** The ingest token is minted per run and lives in
that run's own environment so its OTLP exporter can use it, which is why
`docs/agent/security.md:26` describes the exemption as safe: the credential
opens nothing but that run's telemetry. That is true of what it *writes* and says
nothing about what it *costs to read*, and the holder is the unattended child
the whole privsep design at `docs/agent/security.md:10` treats as the party to
be excluded.

**Two boundaries in this repository already bound their input, with the reason on
the line.** `scripts/discord-relay.mjs:106-107`:

> `/** A notification is ~200 bytes. Anything approaching this is not one. */`
> `const MAX_BODY_BYTES = 16 * 1024;`

and `src/lib/requestLog.ts:78-82`, truncating the source address to 64 bytes
*"because the header is attacker-controlled and this is a column, not a
parser."* The relay is a loopback listener inside the same container; the
exempted route is reachable from anywhere the app is. The one that bounds itself
is the one with less reach.

**Blast radius.** The single process, which is
[G3](03-growth.md#g3-one-process-is-the-hard-ceiling-and-the-usual-escape-route-is-not-the-one-that-applies)'s
subject: there is no second one to take over.

**Cost of leaving it.** Zero today. Nothing here establishes that any child has
ever sent a large body, and the exporter this app configures sends small ones.

**Confidence: medium, and the premise is stated as assumed.** That no cap is
configured is read from the tree. That **no cap is imposed anyway** by the
runtime, on `Request.json()` in a `output: "standalone"` build, is **assumed**:
it was not measured, because Docker is unavailable in this container and no
request was made against a running server. If the framework caps it, this row is
a documentation gap rather than a bound one.

**Owned by:** no issue.

---

## What this axis got right, recorded because a register that lists only failures misreads the codebase

More than any other axis file in this directory, and that is the finding rather
than a courtesy. Seventeen candidates were carried far enough to be judged: five
became rows, six died as documented decisions and six were dropped for want of
evidence. The six that died are in
[§ Refuted or already decided](#refuted-or-already-decided-on-this-axis),
every one of them killed by a paragraph that had already thought the thing
through; the six that were dropped are in
[§ Dropped for lack of evidence](#dropped-for-lack-of-evidence-on-this-axis).

- **Both containment checks are there, twice, deliberately duplicated.**
  `resolveInMount` (`src/lib/orchestrator.ts:1165-1208`) checks the lexically
  resolved path before touching the filesystem (`:1184-1187`) and again after
  `realpathSync` (`:1196-1202`), each under a comment saying which failure it
  answers. `plugins.ts:153-174` mirrors it rather than importing it, with the
  cycle it would otherwise close named at `:141-143`, and both phases intact.
- **A stored plugin path is re-proved on the way out, not only on the way in.**
  `setPluginEnabled` (`:337-355`) proves containment before storing;
  `enabledPluginDirs` (`:365-377`) proves it again before the path becomes
  `--plugin-dir`, because a mount can be repointed under a stored path. The
  docblock at `:332-335` says exactly that, and `:149-151` says why it runs at
  read time: what this path becomes is a directory whose hooks the container
  executes.
- **The Discord relay is a boundary and is written like one.**
  `scripts/discord-relay.mjs:120-127` verifies an HMAC over the **raw received
  bytes** before parsing, with the re-serialisation trap named at `:112-118`;
  `:107` caps the body; `:130-134` checks the app's closed field list again on
  arrival. Both ends refuse to start without `UF_WEBHOOK_SECRET`, and
  `docker-entrypoint.sh:853` unsets `DISCORD_WEBHOOK_URL` before the server is
  exec'd, with the reason at `:821-826`: `orchestrator.ts` builds every agent's
  environment as `{ ...process.env }`, so a variable this process still holds is
  one every unattended agent can read.
- **The chat's capability token cannot outlive its turn and cannot be reached by
  the model.** In memory on `globalThis` (`src/lib/chat.ts:1751-1752`), 32 random
  bytes (`:1755`), compared constant-time against every live token rather than
  looked up by key (`:1772-1789`, with the timing reason on the line), and
  revoked on both endings rather than one: `:2376` inside the `settled`-guarded
  `land()` that every ordinary result goes through, and `:2240` in a `catch`
  around the setup, under a comment naming the exact hole it closes. The second
  is pinned by `src/lib/chatTurn.test.ts:665`, which asserts that a turn whose
  child never started leaves no live capability behind.
- **`/api/health`'s exemption is enforced by a test rather than by its comment.**
  `src/app/api/health/route.test.ts:51`, *"answers 200 with counts, and nothing
  but counts"*. That is the pattern the rest of this register keeps asking for:
  the justification for a decision written as an assertion.
- **`permissionMode` is narrowed at every route that can carry one**, and there
  are three rather than the two `docs/agent/security.md:19` counts:
  `POST /api/runs`, `chatDefaultGuards` in `PUT /api/settings`
  (`src/app/api/settings/route.ts:585-625`), and a template
  (`src/lib/templates.ts:190-192`, against `PERMISSION_MODES`). All three narrow
  against the same four literals, so the third route is a counting difference
  against `docs/agent/security.md:19`'s *"the routes to `--permission-mode` stay
  the two they were"* and not a hole.
- **`gitEnv()`'s `UF_` strip makes every credentialed git call greppable.** The
  scrub drops the whole namespace, so `UF_GITHUB_TOKEN` cannot be *left in* and
  has to be handed back by a caller that means to (`src/lib/git.ts:191-207`).
  There is exactly one such caller in the tree, `src/lib/land.ts:2961`, which is
  the delivery push. The withholding is by namespace rather than by memory, which
  is why `UF_GITHUB_TOKENS` was covered by it with no change.
- **`login_attempts` bounds itself on the write path.**
  `src/lib/loginAttempts.ts:106-113` prunes decayed unlocked buckets on every
  recorded failure, so the table an attacker fills is the one their own attempt
  cleans.

---

## Refuted or already decided on this axis

Candidates that looked like gaps and are not. Recorded here rather than in the
register because a register row implies work is owed.

**A chat model setting a run's permission mode.** The `save_template` tool's
input schema (`src/app/api/mcp/route.ts:265-306`) has no `permissionMode`
property, and no handler in that file writes one from a payload: the only
occurrences are `:1002` reading a saved template's value out, `:1676` taking it
from the operator's `chatDefaultGuards`, and `:1730` stating it back to the model
in the confirmation text. `docs/agent/security.md:19` is the reasoning and it
holds.

**A revoked session's captured cookie staying valid until its own expiry.**
Documented at `docs/agent/security.md:28` as the price of an edge gate that
cannot read SQLite, with the fix named as a change to what `middleware.ts` is.
[S1](#s1-the-all-sessions-branch-of-the-logout-route-takes-no-credential-and-revoking-a-session-does-not-end-it)
cites this rather than refiling it: the row is that one branch of the route
claims to answer the case this paragraph says it cannot, and that the same branch
takes no credential.

**The relay as an unauthenticated door on the container's loopback.** Refuted
above: HMAC over the raw bytes before parsing, 16 KB cap, both ends refuse to
start without the secret, and the secret is `UF_`-namespaced so it leaves every
child's environment with the rest.

**A stored plugin path escaping its mount, or a `--plugin-dir` that was contained
when stored and is not when used.** Refuted above: both phases, at both times,
with the re-prove's reason written down.

**`safe.directory=*` on every git this app runs.** A deliberate waiver, argued at
`docs/agent/security.md:15`: git's ownership refusal reaches `probeIsolation` as
an unreadable repository, indistinguishable from "not a repository", so isolation
would switch itself off and say the wrong thing about why. Every path reaching
`gitSync` has already been proved inside a mount.

**The vault skill and the read guard granting more than an agent should have.**
Both are generated rather than mounted, both are decided by the operator, and the
one thing only their own text forbids is stated as such in
`docs/agent/security.md`'s routing line in `CLAUDE.md` rather than left to be
discovered. A row here would be re-filing a decision that names itself.

**Sibling children sharing one uid, so one agent can read another's environment.**
Real, and stated at `docs/agent/security.md:10` (*"every child still shares one
uid, so the group above is the only thing separating them"*) with
`docs/security.md` named as where the residue is written down. It is also **one
run against another**, which is
`proposals/implemented - Sandboxing/`'s question by the boundary set for this
pass, so it is not surveyed here in either direction.

**[M2](04-missing-features.md#m2-one-credential-no-identity-no-authorisation)
and [M6](04-missing-features.md#m6-a-credential-cannot-be-rotated-without-a-restart-and-a-restart-ends-live-runs).**
Already on the register. Cited by
[S1](#s1-the-all-sessions-branch-of-the-logout-route-takes-no-credential-and-revoking-a-session-does-not-end-it)
and [S3](#s3-nine-mutating-route-files-write-no-audit-line-and-six-of-them-are-the-credential-routes)
and not refiled.

**The seven candidates refuted by the original survey**, listed at
[06-recommendation.md:244-256](06-recommendation.md), including the npm
advisories that `.github/workflows/ci.yml:126-163` accepts advisory by advisory
and accessibility. Out of scope by the brief and not revisited.

---

## Dropped for lack of evidence on this axis

Six candidates that are plausible and are not in the register, because nothing in
the tree or in a command's output establishes them. This list is as much of the
survey's output as the rows are.

1. **Whether anything other than the operator can reach `/api/logout`, the
   relay's port, or `/api/otlp/v1/logs`.** Compose binds `127.0.0.1:3000`, and
   what a sandboxed child can dial is
   `proposals/implemented - Sandboxing/`'s question by the boundary set for this
   pass. Docker is unavailable here, so no request was made from anywhere.
   [S1](#s1-the-all-sessions-branch-of-the-logout-route-takes-no-credential-and-revoking-a-session-does-not-end-it)
   and [S5](#s5-the-one-write-path-the-edge-gate-exempts-buffers-an-unbounded-body)
   argue what a door accepts and never who is standing at it.
2. **Whether an unbounded OTLP body actually exhausts the process.** No live
   process, no measurement, and no figure for what a real exporter sends.
   [S5](#s5-the-one-write-path-the-edge-gate-exempts-buffers-an-unbounded-body)
   argues the absence of a cap, which is verifiable, and marks the framework's
   own behaviour as assumed.
3. **A time-of-check race on a plugin directory between `enabledPluginDirs()` and
   the spawn.** The window exists in the code and the resolved real path is what
   is passed, which closes the obvious form of it. Nothing here establishes an
   exploitable form, and demonstrating one needs a running container.
4. **Whether `login_attempts` can be grown past its own prune by an attacker
   rotating `x-forwarded-for`.** The prune at
   `src/lib/loginAttempts.ts:106-113` bounds decayed buckets and the global
   lockout throttles the rate, but whether a request refused by the global
   lockout still records a per-source failure was not traced end to end, and
   without that the growth rate is not known.
5. **Whether any session cookie has ever been replayed, or any credential route
   called by anyone but the operator.** That is a query against `request_log` and
   `auth_sessions` on the live install, and `DATA_DIR` is unreadable by this uid.
   No row here rests on a count of real requests.
6. **Whether the five notices `--append-system-prompt` ships today contain a
   usable kill pattern.** Reading them says they do not, which is
   also what `docs/agent/security.md:22` argues.
   [S4](#s4-the-no-literal-rule-is-pinned-by-an-assertion-whose-fixture-omits-the-one-notice-that-carries-figures)
   is therefore about the scope of the check and not about a live pattern, and it
   says so in its confidence line.
