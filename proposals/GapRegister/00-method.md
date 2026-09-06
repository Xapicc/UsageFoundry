# Method

What was read, what was run and what it printed, and what could not be reached.

## The rule this survey held itself to

Every row in [05-register.md](05-register.md) points at a file and line, a
command whose output is quoted here, or a documented invariant it contradicts.
A candidate that could not be tied to one of those three was dropped, and every
drop is listed in [§ Dropped for lack of evidence](#dropped-for-lack-of-evidence)
rather than left out silently — a register that only shows its survivors reads
as exhaustive when it is not.

A gap that `docs/agent/` records as a deliberate choice is not a gap. Three
candidates died that way and are named in
[§ Refuted or already decided](#refuted-or-already-decided).

## Commands run, and their output

All from `/workspace/.uf-worktrees/usagefoundry-721638d11c0b-1`, a linked
worktree level with `origin/main` at `175ba57`, on 2026-08-23. Dependencies
installed with `NODE_ENV=development npm ci --include=dev`, because a bare
`npm ci` under this image's `NODE_ENV=production` exits 0 having skipped
devDependencies and the two scripts below then fail with exit 127.

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0, no output beyond the banner |
| `npm test` | `# tests 1578`, `# suites 230`, `# pass 1578`, `# fail 0`, `# skipped 0`, `# duration_ms 16537.254841` |
| `env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build` | exit 0 |
| `npm audit` | `3 high severity vulnerabilities` |

The tree is green. Nothing in this register is a broken build, a failing test or
a type error, and that is the point of running the loop first: what follows is
what a green tree does not tell you.

`npm audit`'s three, verbatim from its tail:

```
node_modules/next/node_modules/postcss
  next  9.3.4-canary.0 - 16.3.0-preview.10
  Depends on vulnerable versions of postcss
  Depends on vulnerable versions of sharp
  node_modules/next

sharp  <0.35.0
Severity: high
sharp inherited vulnerabilities in libvips: CVE-2026-33327, CVE-2026-33328,
CVE-2026-35590, CVE-2026-35591
...
Will install next@16.3.2, which is a breaking change
```

Those three are **not** a register row. `.github/workflows/ci.yml:126-163`
accepts them on the record, advisory by advisory, and the argument is set out in
[03-growth.md](03-growth.md#refuted-on-this-axis).

### One probe, run to refute a suspicion rather than to confirm one

GitHub issue #68 suspects that `run_deps` is queried by `run_id` without an
index. It is not. From `.data/usagefoundry.db` — the stale in-checkout copy,
which is fine for a plan because the schema is what is being asked about:

```
sqlite> EXPLAIN QUERY PLAN SELECT * FROM run_deps WHERE run_id = 'x';
SEARCH run_deps USING COVERING INDEX sqlite_autoindex_run_deps_1 (run_id=?)
```

The composite `PRIMARY KEY (run_id, depends_on)` at `src/lib/db.ts:344-351`
creates that autoindex, and `run_id` is its leading column. The explicit
`idx_run_deps_depends_on` at `:655-656` covers the other direction. Both
directions are indexed; the suspicion is wrong and is not in the register.

A shell script was copied into the repository root to run this — `/tmp` is
outside the module resolution root, so `require("better-sqlite3")` from there
fails with `ERR_MODULE_NOT_FOUND` — and deleted in the same command. `git
status` is clean.

## What was read

- `CLAUDE.md` in full, and every file in `docs/agent/` — `architecture.md`,
  `metering.md`, `budgets-and-guards.md`, `run-lifecycle.md`,
  `concurrency-and-ownership.md`, `retention.md`, `dependencies.md`,
  `isolation-and-landing.md`, `agents-and-templates.md`, `chat.md`,
  `workflows-and-schedules.md`, `git-and-review.md`, `security.md`,
  `conventions.md`, `environment.md`, `testing.md`.
- `docs/verification.md`, in particular its "Not yet verified by hand" list from
  `:1033`. Four of the twenty-two register rows lean on it.
- `proposals/README.md` and the READMEs of all five existing proposals. Their
  open questions are owned and are excluded by name in
  [06-recommendation.md](06-recommendation.md#the-five-existing-proposals-questions).
- `HEALTH-CHECK.md`, the dated audit at `267b901`, 2026-08-11. Every finding
  taken from it was re-checked against this tree; several are fixed.
- Open and closed GitHub issues via
  `export GH_PAGER=cat; gh issue list --repo Xapicc/UsageFoundry --state all
  --limit 300 --json number,title,state`, then `gh issue view` on the twelve
  named in the brief plus the umbrella sweeps. That loop's output was 105.4 KB
  and exceeded the tool result limit; it was persisted and read back in
  sections.
- The operator's vault at `/workspace2`, which **is** readable from this
  checkout. Notes cited by path where used; nothing was written into it.
- Source: `orchestrator.ts` (9,710 lines) in the regions the register cites
  rather than whole, `chat.ts` (2,397), `land.ts` (2,708), `workflows.ts`
  (6,010) likewise, and `settings/page.tsx` (3,502), `runs/page.tsx`,
  `chat/page.tsx`, the `src/app/api/` route handlers, `src/components/shell/`,
  `src/components/ui/`, `config.ts`, `db.ts`, `requestLog.ts`, `otlp.ts`,
  `transcripts.ts`, `workspace.ts`, `mergeQueue.ts`, `settings.ts`.

## What could not be reached

- **The live install's `runs` table.** `DATA_DIR` is not readable by the agent
  uid. `.data/usagefoundry.db` inside the checkout is a stale copy last written
  2026-08-19 and was used **only** for the schema probe above. No row in this
  register rests on a count of real runs, a real run's duration, or a real
  ending status. Where a figure like that would have decided a rank, the row
  says so and the rank is held down accordingly — this is the single largest
  hole in the survey and it is the same hole ModelRouter records.
- **Docker.** Not available in this container, so nothing here was checked
  against a running container, a real fleet, or the image's `HEALTHCHECK`.
- **A browser.** None was driven, at any viewport. Every claim about what a page
  renders comes from reading its source or from `docs/verification.md`, and
  [F5](01-frontend.md#f5-nothing-that-renders-is-checked-by-anything) is precisely about the fact that nothing else in this
  repository does either.
- **A linter.** There is none; `eslint.ignoreDuringBuilds` is on. No row here is
  a lint finding.

## What was deliberately left unread

Named so the next reader knows where the survey stops rather than assuming it
stopped nowhere.

- `orchestrator.ts` outside the guard sites, the run loop, the queue selections
  and `createRun` — roughly two thirds of the file.
- `workflows.ts` outside `advanceInstances`, `planLoopPass` and the instance
  status derivation.
- `src/lib/windows.ts`, `pricing.ts`, `planUsage.ts` and `repoSpend.ts` beyond
  their doc invariants. The metering axis is the best-documented area in the
  repository and ContextControl and ModelRouter have both already surveyed it
  with real measurements this survey cannot take.
- `src/app/branches/page.tsx`, `WorkflowEditor.tsx` and `canvasGraph.ts` beyond
  what the caps refuted in
  [03-growth.md](03-growth.md#refuted-on-this-axis) required.
- The 200-odd closed issues, except the ones the umbrella sweeps reference.

## Refuted or already decided

Candidates that looked like gaps and are not. They are recorded here rather than
in the register because a register row implies work is owed.

**`run_deps` is unindexed on `run_id`** (#68, finding 1). Refuted by the
`EXPLAIN QUERY PLAN` above.

**`advanceInstances` is a floating promise that creates runs** (#68, finding 2).
It is floating, and deliberately so, with a `.catch()` and four lines of reason
at `src/lib/orchestrator.ts:3933-3942`: *"deliberately not awaited: the advance
is its own synchronous pass in a later turn, so nothing it does can interleave
with a folder claim being made in this one."* That is the
`concurrency-and-ownership.md` invariant about `createRun` running from entry to
INSERT with no `await`, holding. Awaiting it would be the bug.

**Keyboard shortcuts are `⌘`-only.** `isPlainCommandChord` in
`src/components/shell/shortcuts.ts` requires `metaKey`, which strands a Linux or
Windows operator — except the affordance is reachable without it:
`src/components/shell/Toolbar.tsx:115-135` renders a visible Quick open button
carrying `aria-keyshortcuts="Meta+K"`. `docs/agent/conventions.md` records the
chord restriction as a decision. Not a gap.

**No time-series chart of spend.** The data is rendered — `UsagePeriods.tsx` and
`/account` show it as tables with meters, and `docs/agent/metering.md` is
explicit that an unknown ceiling renders as a hatched indeterminate meter rather
than a bar. Wanting a line chart instead is polish, and the brief asked the
missing-features axis for capability rather than polish.

**Accessibility is unaddressed.** Attribute coverage in `src/components/` is
strong on inspection. The operator's own note —
`3 Resources/Web Design/Automated Accessibility Testing Coverage.md`, confidence
medium, updated 2026-08-23 — is a warning against exactly the claim a survey
would want to make here: automated coverage lands somewhere between 13% and
57.38% of real issues depending which denominator you pick, so neither a green
scan nor an unrun one is a verdict. The honest finding is [F5](01-frontend.md#f5-nothing-that-renders-is-checked-by-anything),
which is about nothing being checked at all, not about accessibility specifically.

## Dropped for lack of evidence

Six candidates that are plausible and are not in the register, because nothing
in the tree or in a command's output establishes them.

1. **Long-run memory pressure in `orchestrator.ts`'s event buffers.** Would need
   a live process to measure; `retention.ts` bounds the persisted side and the
   in-memory side was not read closely enough to claim anything.
2. **Whether the 100-run list is actually hit on the live install.** That is a
   `SELECT COUNT(*) FROM runs`, and `DATA_DIR` is unreadable.
   [F1](01-frontend.md#f1-run-history-stops-at-100-rows-and-cannot-be-paged-filtered-or-searched) is argued from the cap's existence and the page's own
   admission, never from a row count.
3. **Query performance anywhere.** No `EXPLAIN` beyond the one refutation, no
   timings, and better-sqlite3 is synchronous so a slow query blocks the
   process. Suspected; not measured; not filed.
4. **Whether the merge queue's four workers have ever collided.** Needs run
   history. [B1](02-backend-logic.md#b1-the-landing-guard-covers-landrun-and-none-of-the-other-four-doors) argues the guard's *scope* from the
   code, which is verifiable, and does not claim an incident.
5. **Whether any operator has wanted a pull request.** [M1](04-missing-features.md#m1-the-app-can-push-nothing-and-open-no-pull-request)
   argues the capability is absent, which is verifiable, and marks its own
   demand as assumed.
6. **Whether the settings page is slow to render at 3,502 lines.** No profile
   was taken. [F6](01-frontend.md#f6-settings-is-nine-sections-in-a-3502-line-page-with-no-way-to-find-a-field) argues findability, not performance.

## The vault

`/workspace2` is readable. Notes used, each cited again at the point of use:

| Note | Used by |
|---|---|
| `3 Resources/Testing and Correctness/The Test Pyramid.md` | [F5](01-frontend.md#f5-nothing-that-renders-is-checked-by-anything) |
| `3 Resources/Web Design/Automated Accessibility Testing Coverage.md` | [F5](01-frontend.md#f5-nothing-that-renders-is-checked-by-anything), and the refutation above |
| `3 Resources/Data and Storage/When an Embedded Database Stops Being the Right Answer.md` | [G4](03-growth.md#g4-the-audit-trail-is-20000-rows-deep-evicted-on-every-insert-and-identifies-no-person) |
| `3 Resources/Software Security/Authentication versus Authorisation.md` | [M2](04-missing-features.md#m2-one-credential-no-identity-no-authorisation) |
| `3 Resources/Software Security/Secrets Management.md` | [M6](04-missing-features.md#m6-a-credential-cannot-be-rotated-without-a-restart-and-a-restart-ends-live-runs) |
| `3 Resources/Debugging and Observability/SLOs and Error Budgets.md` | [M3](04-missing-features.md#m3-nothing-this-app-runs-can-reach-a-human-and-most-of-that-is-on-purpose) |

The two notes in `3 Resources/Questions/Inbox` that name UsageFoundry were read.
Both are ContinuousImprovement and ContextControl territory — cross-run memory
and what a cycle carries — and neither opens a question those two proposals do
not already own, so nothing in this register cites them as new.

Each note carries its own confidence and grade. Where one is thin — the SLO note
rests on a single vendor book with no replication, and the test-pyramid note's
cost claim is supported while its ratios were never measured — the row using it
says so rather than borrowing certainty the note does not have.

## Candidates seen during the `66fdbab` refresh, not yet surveyed

Written down while re-reading the twenty rows against `main` at `66fdbab` on
2026-09-06, and **left here rather than registered**: this pass was a survey
refresh, and a row that has not been argued against the counter-case does not
belong on the register. Nothing below has a blast radius, a cost or a confidence
attached to it yet. Three later runs pick these axes up.

Each line is what was seen and where. None of it was fixed.

- `src/app/api/mcp/route.ts:1061` — the chat's `list_runs` tool clamps to 100
  with no `offset` and no filter, so the model cannot reach a run that
  `/api/runs` has been able to reach since `7405720`. A fourth instance of
  [G1](03-growth.md#g1-nine-list-routes-read-parameters-the-one-for-runs-does-not-and-the-pattern-repeats-three-times)'s shape, on the surface `docs/agent/chat.md` says may
  write half a run.
- `src/app/api/codex-auth/api-key/route.ts:28` — nine route files export a
  mutating handler that is not wrapped in `auditMutation`, and six of them are
  the sign-in routes (`api/claude-auth/*`, `api/codex-auth/*`); the others are
  `api/fleet`, `api/logout` and `api/runs/restarted`. This one's docblock at
  `:12-18` reasons carefully about what an audit row would *contain* and not
  about there being none.
- `src/lib/notify.ts:476` — `webhook_deliveries` gets a row per attempt and is
  read only by `webhookHealth` into `/api/status:283`; nothing under `src/app`
  renders it, so an operator whose receiver is answering 404 learns it by
  polling the status route or not at all.
- `src/lib/delivery.ts:11-12` — the module docblock opens by stating that a grep
  over `src/` for `git push`, `gh pr create` and `createPullRequest` "returns
  prose only", inside the file that made that false.
- `src/lib/landGate.ts:16` — the docblock cites `settings.ts:871` and
  `land.ts:1336` for values that are at `src/lib/settings.ts:890` and
  `src/lib/land.ts:1362`.
- `.github/workflows/ci.yml:130` — the audit gate's argument opens "As of
  2026-08-14 `npm audit` reports exactly three high-severity advisories in this
  tree"; since `102050d` it reports none, so the thirty-seven lines a reader is
  meant to weigh describe a tree that no longer exists.

The last three are one shape — a comment that states a fact about the repository
which the repository has since changed — and are the kind of thing
`docs/agent/` has no invariant about, which is what the register's third
observation predicts.

## The security pass, 2026-09-06

A fifth axis, [07-security.md](07-security.md): the app's own security and trust
boundary. Same worktree, same tree, same day as the `66fdbab` refresh above.
Everything the refresh could not reach, this could not reach either, and it adds
two holes of its own.

**The boundary this pass held itself to**, stated first because it decided what
was not surveyed: `proposals/implemented - Sandboxing/` owns what a run can
reach (filesystem, network, one run against another), and this axis is the
reverse direction, what reaches the app. Two candidates died on that line rather
than on the evidence line and are recorded as such, one of them a real and
documented residue (every child sharing a uid, `docs/agent/security.md:10`).

### Commands run, and their output

Exit codes read from `$?` on the command itself, never through a pipe.

| Command | Exit | Result |
|---|---|---|
| `NODE_ENV=development npm ci --include=dev` | 0 | `found 0 vulnerabilities` |
| `npm run typecheck` | 0 | nothing beyond the banner |
| `npm test` | 0 | `# tests 2259`, `# suites 351`, `# pass 2259`, `# fail 0`, `# cancelled 0`, `# skipped 0`, `# todo 0`, `# duration_ms 16401.747132` |

Byte-identical figures to the refresh, because `src/` is byte-identical: this
pass edited only this directory. `npm run build` and `npm audit` were **not**
re-run, for that reason, and the omission is deliberate.

**The one survey command whose output a row rests on**, quoted in full in
[S3](07-security.md#s3-nine-mutating-route-files-write-no-audit-line-and-six-of-them-are-the-credential-routes):

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

and the one that decided
[S1](07-security.md#s1-the-all-sessions-branch-of-the-logout-route-takes-no-credential-and-revoking-a-session-does-not-end-it)'s
second half, which is a search returning *less* than expected and is therefore
the kind that has to be quoted rather than described:

```
$ grep -rn "revoked_at\|revokedAt" src/ --include=*.ts --include=*.tsx \
    | grep -v "\.test\."
src/lib/sessions.ts:29,36,43       the column and its DTO
src/lib/sessions.ts:63,72          the two writers
src/lib/sessions.ts:87,91          activeSessionCount
src/app/api/settings/route.ts:134  activeSessions, for the Settings page
```

Nothing on a request path is in that list. `getSession`, the one function that
returns a row's `revokedAt` to a caller, is called from
`src/app/api/login/route.test.ts:110` and `:133` and from nowhere else in `src/`.

### What was read

- `docs/agent/security.md` **in full**, all thirty paragraphs, first and before
  any code. It is the axis's own specification and six of the seventeen
  candidates judged died against it.
- The code it routes to: `src/middleware.ts` whole; `src/app/api/status/route.ts`
  and its test; `src/app/api/logout/route.ts`; `src/app/api/health/route.ts`'s
  test names; `src/app/api/login/route.ts`'s export line;
  `src/app/api/otlp/v1/logs/route.ts`; `src/lib/requestLog.ts` whole;
  `src/lib/sessions.ts`, `src/lib/sessionToken.ts` and `src/lib/loginAttempts.ts`
  in the regions cited; `src/lib/plugins.ts`'s containment and enable/spawn
  paths; `src/lib/vaultSkill.ts` and `src/lib/readGuard.ts` docblocks;
  `src/lib/chat.ts`'s capability block (`:1715-1795`) and its revocation sites;
  `src/lib/git.ts:180-240` and `githubEnv` at `src/lib/orchestrator.ts:5660-5740`;
  `resolveInMount` at `src/lib/orchestrator.ts:1165-1208`;
  `src/lib/cycleInvocation.ts`'s notice join; the two notice tests;
  `src/app/api/mcp/route.ts`'s `save_template` schema and its guard-stating
  handler; `docker-entrypoint.sh:806-854` and `scripts/discord-relay.mjs`.
- `proposals/implemented - Sandboxing/README.md`, to stay off it.
- `proposals/GapRegister/` itself: `00-method.md`, `05-register.md`,
  `02-backend-logic.md` for the row shape, and `06-recommendation.md:196-256` for
  the refuted list this pass was told not to rediscover.

### What could not be reached, beyond the refresh's four

- **A listener.** No request was made against a running server, so every claim
  about what a route accepts or refuses is read out of the handler rather than
  observed. That is stated in the confidence line of
  [S1](07-security.md#s1-the-all-sessions-branch-of-the-logout-route-takes-no-credential-and-revoking-a-session-does-not-end-it),
  [S2](07-security.md#s2-the-status-route-authenticates-a-browser-against-the-master-token-which-the-session-cookie-stopped-being)
  and [S5](07-security.md#s5-the-one-write-path-the-edge-gate-exempts-buffers-an-unbounded-body)
  rather than left to the reader.
- **The framework's own limits.** Whether a `output: "standalone"` Next build
  caps `Request.json()` on its own was not measured; nothing configures a cap in
  `next.config.ts`, and S5 marks the rest as assumed.

### What was deliberately left unread

- **`privsep.ts` and the uid/gid arrangement**, beyond
  `docs/agent/security.md:10`'s account of it. It is the one part of this area
  whose failure mode is *between children*, which is the Sandboxing boundary.
- **`docs/security.md`**, the human-facing companion, except where
  `docs/agent/security.md` names it as holding the residue.
- **Every route handler's authorisation logic individually.** That is the
  per-endpoint audit `06-recommendation.md`'s M2 refusal prices, and doing it
  here would have been that survey rather than this one.
- **The transcript, metering and workflow surfaces**, which carry no credential
  and no door of their own.

### Refuted, and dropped

Both lists live in the axis file rather than here, because both are longer than
the four-axis survey's and both are specific to this boundary:
[§ Refuted or already decided](07-security.md#refuted-or-already-decided-on-this-axis)
(six candidates, all killed by a paragraph that had already reasoned the thing
through) and
[§ Dropped for lack of evidence](07-security.md#dropped-for-lack-of-evidence-on-this-axis)
(six more, each with the missing evidence named).

### The vault

Not consulted on this pass. The notes the four-axis survey used on
authentication and secrets
(`3 Resources/Software Security/Authentication versus Authorisation.md`,
`3 Resources/Software Security/Secrets Management.md`) are already cited by
[M2](04-missing-features.md#m2-one-credential-no-identity-no-authorisation) and
[M6](04-missing-features.md#m6-a-credential-cannot-be-rotated-without-a-restart-and-a-restart-ends-live-runs),
which this pass was told not to refile, and none of the five rows here needed an
external claim: every one of them is a line in this repository or a sentence in
its own documentation.

---

## The operations pass, 2026-09-06

Adding a sixth axis: operations and recovery. **One question** — when something
goes wrong on a live install, what can an operator find out, what can they get
back, and what is silently unrecoverable? Eight rows,
[O1](08-operations.md#o1--the-one-restart-condition-the-runbook-alerts-on-never-clears-and-the-count-that-does-is-on-a-route-the-status-token-cannot-reach)
to [O8](08-operations.md#o8--lockverdict-asks-staleness-second-docsagentconcurrency-and-ownershipmd-says-it-asks-it-last),
in [08-operations.md](08-operations.md), ranked into
[05-register.md](05-register.md) by that file's own method rather than appended.

**This pass changed no code.** `src/` is untouched, no GitHub issue was opened,
closed or commented on, and nothing outside `proposals/GapRegister/` was edited
except the [proposals index](../README.md) line. Same worktree, same tree
(`origin/main` at `66fdbab`).

### The verification loop, and what it does and does not say

Exit codes read from `$?` on the command itself, never through a pipe — the first
attempt piped both scripts to `tail` and read `tail`'s exit code, which is not
the same claim, so both were re-run.

| Command | Exit | Output |
|---|---|---|
| `NODE_ENV=development npm ci --include=dev` | 0 | `found 0 vulnerabilities` |
| `npm run typecheck` | 0 | nothing beyond the banner |
| `npm test` | 0 | `# tests 2259`, `# suites 351`, `# pass 2259`, `# fail 0`, `# cancelled 0`, `# skipped 0`, `# todo 0`, `# duration_ms 16384.263133` |

**The same 2,259 as the refresh and the security pass**, over `src/` unchanged
since both, which is the expected result rather than a reassuring one.
`env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build` and `npm audit` were
**not** re-run, on the security pass's reasoning: neither can say anything new
about a tree byte-identical under `src/` to the one the refresh ran them against.
That is a deliberate omission and is named here rather than left to be inferred.

**Not one of the eight rows is something this loop could have failed on**, and
one of them is about that directly: `src/lib/deployment.test.ts` carries sixty-odd
assertions pinning the image against the compose file, all green, and
[O2](08-operations.md#o2--the-containers-stop-grace-and-the-servers-shutdown-grace-are-one-edit-apart-and-the-file-that-pins-every-other-such-pair-does-not-pin-this-one)
is the pin it does not carry.

### Commands whose output is a row's evidence

**Six of the rows rest on a command that prints nothing**, which is the shape of
an absence claim and is why each is quoted with its exit code rather than
described.

```
$ grep -ran "restartClosed\|restart_closed" src/lib/status.ts src/app/api/status/route.ts
exit 1
$ grep -an "grace\|stop_\|SIGTERM\|shutdown" src/lib/deployment.test.ts
exit 1
$ grep -ran "schemaVerdict\|SCHEMA_VERSION\|user_version" src/ --include=*.ts --include=*.tsx \
    | grep -v "^src/lib/db.ts" | grep -v "\.test\."
exit 1
$ grep -ran "UF_BACKUP_DIR\|/backups" src/ --include=*.ts --include=*.tsx | grep -v "\.test\."
exit 1
$ grep -ran "export async function DELETE" src/app/api/chat/
exit 1
$ grep -rn "logging:" docker-compose*.yml
exit 1
```

In order: the outstanding restart count is nowhere on the status route
([O1](08-operations.md#o1--the-one-restart-condition-the-runbook-alerts-on-never-clears-and-the-count-that-does-is-on-a-route-the-status-token-cannot-reach));
the shutdown-grace coupling is pinned by nothing
([O2](08-operations.md#o2--the-containers-stop-grace-and-the-servers-shutdown-grace-are-one-edit-apart-and-the-file-that-pins-every-other-such-pair-does-not-pin-this-one));
`PRAGMA user_version` and the schema verdict reach no route, page or other module
([O3](08-operations.md#o3--everything-migrate-finds-wrong-with-the-database-it-just-opened-is-a-line-on-stdout-and-nothing-else));
the server does not know the backup directory exists
([O4](08-operations.md#o4--nothing-in-the-app-knows-the-backup-directory-exists-so-no-surface-can-say-when-the-install-was-last-backed-up));
no route can delete a chat
([O5](08-operations.md#o5--a-chat-thread-and-every-message-in-it-is-permanent-no-horizon-no-delete-and-the-cascade-has-nothing-to-cascade-from));
and compose asks for no bound on the container log
([O7](08-operations.md#o7--the-containers-own-log-is-a-fourth-unbounded-store-and-compose-asks-for-no-limit-on-it)).

The two retention rows rest on one command that prints something:

```
$ comm -23 <(grep -aoP 'CREATE TABLE IF NOT EXISTS \K\w+' src/lib/db.ts | sort -u) \
           <(grep -rhaoP 'DELETE FROM \K\w+' src/ --include=*.ts --include=*.tsx | sort -u)
chat_messages
chat_proposals
chat_questions
chat_turn_spend
merge_queue
plan_observations
resume_probes
run_deps
run_reviews
workflow_instance_runs
workflow_instances
```

Eleven tables have no `DELETE FROM` anywhere in `src/`, tests included. Three of
them — `run_reviews` and the two `workflow_instance_*` — are named as permanent
by design at `docs/agent/retention.md:8`. **The other eight are on neither list**:
not swept, and not argued for. `retention.ts` itself deletes from six tables
(`:174, :182, :199, :212, :232, :239`) and none of the eight is among them.

### What was read, and how much of it

**Nothing large was read whole on this pass, and that is a fact about the tooling
rather than a choice.** Long reads come back with their middles elided here, so
what follows names the regions that were actually in front of the survey. It is
also why every row cites a line number: a row resting on "I read the file" would
be resting on something that did not happen.

- **`docs/agent/concurrency-and-ownership.md`** — the opening and closing
  paragraphs, including `:16` and `:18`, which is where
  [O8](08-operations.md#o8--lockverdict-asks-staleness-second-docsagentconcurrency-and-ownershipmd-says-it-asks-it-last)'s
  contradiction and
  [O2](08-operations.md#o2--the-containers-stop-grace-and-the-servers-shutdown-grace-are-one-edit-apart-and-the-file-that-pins-every-other-such-pair-does-not-pin-this-one)'s
  fails-open clause are. **`docs/agent/retention.md`** — the opening two
  paragraphs (`:8`, `:10`) and the closing three, which carry the permanent set
  and the cache reasoning. **`docs/agent/environment.md`** — the head, including
  `:13` on the backup directory, and the tail on the Discord relay.
- **`docs/agent/run-lifecycle.md` was not opened**, though `CLAUDE.md` routes
  restart and boot through it. What this pass needed about a restart is in
  `concurrency-and-ownership.md`'s reconcile paragraph and in the code, and no row
  here cites it. Named as an omission rather than left to be noticed.
- **`src/lib/serverLock.ts:1-390` of 528** — the module docblock, `parseLock`,
  `lockVerdict`, `stillBeating`, `heartbeatVerdict`, the ownership type,
  `writeLock`, `ownerAlive`, `heldByAnotherProcess` and `claimDataDir`, plus the
  stand-down and release at the tail. Both halves of O8 are inside that.
- **`src/instrumentation.ts`**, head and tail: the auth and config refusals at the
  top and the signal handlers at `:206-249`.
- **Both backup scripts**, header and tail each: `scripts/backup-db.mjs:1-50` and
  `:196-245`, `scripts/restore-db.mjs:1-140` and `:258-307`. The headers are where
  the reasoning is and the tails are where the file is moved into place.
  `src/lib/backupRestore.test.ts` by grep, for what it pins.
- **`src/lib/db.ts` in five regions** — `:40-140` (the schema version, the verdict,
  `shouldMigrate`, `open`, the head of `migrate`), `:604-626` (`chat_messages`),
  `:1860-1926` (the migration tail, `ANALYZE`, the `user_version` stamp),
  `:1940-2130` (`recoverStrandedProposals`, `reportOrphanTables`, `addColumn`), and
  targeted greps for every `CREATE TABLE`. It is a 32k file and reading it whole
  would have cost more than the rows are worth.
- **`src/lib/retention.ts:1-200`** — the module docblock and `sweepRunEvents` —
  plus a grep for every `DELETE FROM` in it. **`src/lib/ops.ts`** head and tail:
  the `OpsState` docblock, `OPS_EVENT_RETENTION`, `recentOpsEvents` and
  `measureEventLoopLagMs`. **`src/lib/configCheck.ts`** head and tail: the
  refuse-versus-warn argument and `configProblems`.
- **Read complete, because they are short enough to come back complete:**
  `src/app/api/health/route.ts` (71 lines) and
  `src/app/api/runs/restarted/route.ts`.
- **`src/lib/status.ts`** by grep and by `:20-123` and `:280-323`;
  **`src/app/runs/page.tsx:845-900`**, which is the whole of the restart banner and
  both of its comments; **`src/middleware.ts`** by grep for its exemption list.
- **`README.md:200-279`** — health, status, the fifteen alertable conditions and
  the logging section — and `:405-432` for the `VACUUM` position.
  **`docs/backup-and-restore.md`** head and tail: the two commands and the
  reasoning under them, and what is deliberately not in a backup.
  **`docs/verification.md` by grep only.** It is a 109k file; the two passages
  quoted, `:409-437` and `:4100-4113`, were pulled by line range after a grep
  found them.
- **`docker-compose.yml`, `Dockerfile` and `src/lib/deployment.test.ts` by grep and
  by line range.** None of the three was read whole.

### What could not be reached, and it is most of the axis

**No container was started.** Docker is unavailable here, which on this axis is
not a caveat on a few rows but the binding constraint on all of them. Every
statement about a running container is a reading of the file that configures it
and says so in the sentence that makes it:

- The image `HEALTHCHECK`'s four timings were read out of `Dockerfile:724-725`
  and the assertion pinning them out of `deployment.test.ts:446`. **No probe was
  run and no boot was timed**, so whether `--start-period=180s` covers a real cold
  start on a large database is unknown and is dropped.
- `stop_grace_period: 30s` was read out of `docker-compose.yml:599` and
  `SHUTDOWN_GRACE_MS` out of `orchestrator.ts:10712`. **No SIGTERM was sent and
  nothing was watched being killed**, so O2 argues an unpinned coupling, which is
  checkable, and never a demonstrated truncation.
- The container log's growth rests on compose setting no `logging:` key, which is
  certain, plus Docker's documented default, which is **not** checked here. A host
  `daemon.json` could bound it, and
  [O7](08-operations.md#o7--the-containers-own-log-is-a-fourth-unbounded-store-and-compose-asks-for-no-limit-on-it)
  is discounted to medium for exactly that.
- **No restart was performed**, so
  [O1](08-operations.md#o1--the-one-restart-condition-the-runbook-alerts-on-never-clears-and-the-count-that-does-is-on-a-route-the-status-token-cannot-reach)'s
  latch is read out of `status.ts`, `orchestrator.ts` and `middleware.ts` rather
  than watched failing to clear.
- **No lock was raced and no process killed**, so O8 is a reading of a pure
  function against a sentence, which is the whole of what it claims to be.

**Backup and restore: which half was checked.** The half this pass could check is
**the code and the record** — both scripts in the regions above, the unit tests
read for what they pin, and `docs/verification.md:409-437`'s account of the
mechanism driven end to end against a live writer (a `cp` at 25 runs against
`backup-db.mjs` at 386, both passing `integrity_check`). The half it could **not**
check is everything about actually running them: no backup was taken, no restore
rehearsed, and `/backups` was never listed, because that path is outside what
this uid may read. The packaging half — that the runtime image carries `scripts/`,
resolves `better-sqlite3`, has `sqlite3` on the PATH, and that `/backups` is
writable by the uid compose runs as — is already on
`docs/verification.md:4100-4113`'s own list with the four commands that would
close it, and this pass adds nothing to it and does not refile it.

**And no run history, as on every pass before this one.** `DATA_DIR` is
unreadable by the agent uid, so no table was counted: not `chat_messages`, not
`plan_observations`, not `ops_events`, and not `run_events` for the question of
what is actually on disk the morning after a 03:00 failure. No row rests on a
count of real rows.

### What was deliberately left unread on this pass

- **`docker-entrypoint.sh`**, 1,200 lines, not opened at all. What it does with
  the Discord relay and the `UF_` variables is `docs/agent/environment.md:37-39`'s
  account and `deployment.test.ts:1348-1380`'s pins, both of which are the
  security axis's territory rather than this one's. No row here rests on it — but
  it is the file that decides what the container does before the server starts, so
  an operations survey with a container to run should start there and this one did
  not.
- **`src/lib/notify.ts` beyond its status fields.** The outbound webhook is
  [M3](04-missing-features.md#m3-nothing-this-app-runs-can-reach-a-human-and-most-of-that-is-on-purpose),
  closed, and the brief forbids refiling alerting.
- **`src/lib/otlp.ts` and `src/lib/requestLog.ts` beyond their retention.** The
  audit trail's depth is
  [G4](03-growth.md#g4-the-audit-trail-is-20000-rows-deep-evicted-on-every-insert-and-identifies-no-person)
  and the brief names it as not to be refiled; `otlp_requests` is swept on the
  same horizon as `run_events` and is therefore not a growth row.
- **`src/lib/orchestrator.ts` beyond four regions** — the boot reconciler
  (`:11200-11290`), the restart-closed lifecycle by grep, the boundary call sites,
  and `SHUTDOWN_GRACE_MS`. It is a 142k file.
- **Every route handler's own error handling.** That is a per-endpoint audit, and
  doing it here would have been that survey rather than this one — the same reason
  `06-recommendation.md`'s M2 refusal gives.

### A note on anchors

The eight headings in [08-operations.md](08-operations.md) follow
`03-growth.md`'s shape (`## O1 — Title`), as the brief asked, and the links to
them use the **double** hyphen that heading actually generates: an em dash between
two spaces is stripped and both spaces then become hyphens.

**The rest of this directory uses a single hyphen there.** Slugging every heading
in the directory and matching it against every internal link finds 107 that
resolve only under the single-hyphen reading — and three of those 107 are this
pass's own links *to* existing G and M rows, written to match how every other
file links to them rather than to be right in isolation. They are all left
exactly as they are. Rewriting a hundred links, or every row heading, on the
strength of a slugger this container cannot run would be a large change resting
on an untested claim, and it is outside this pass's scope either way. The two
conventions in one directory are deliberate and this paragraph is where that is
recorded.

### Refuted, and dropped

Both lists live in the axis file, as the security axis's do, and the drop list is
the longest in this directory:
[§ Refuted or already decided](08-operations.md#refuted-or-already-decided-on-this-axis)
(eight candidates, every one killed by a paragraph that had already reasoned the
thing through — the scheduler that is refused by name, the retry `claimDataDir`
declines, the `VACUUM` nothing runs, Docker health being surfaced and not acted
on, `migrate()` deliberately not being a framework, a `*_old` table reported
rather than dropped, the stop grace's own reasoning, and alerting in general) and
[§ Dropped for lack of evidence](08-operations.md#dropped-for-lack-of-evidence-on-this-axis)
(eleven, each naming the evidence that is missing, and nine of the eleven are
missing it for the same reason: there is no container here).

### The vault, on this pass

Not consulted. None of the eight rows needed an external claim: every one is a
line in this repository, a command's output quoted above, or a sentence in this
repository's own documentation.
