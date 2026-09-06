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

> **Read on 2026-09-06 by the fourth pass, and not finished.** That pass took
> this list as its brief and got through item 1 at about a quarter of its extent,
> item 2 at one section, and items 4 and 5 for one question each; the metering
> line is still out of scope for the reason it gives. **The list below is what
> the survey left; the boundary that matters now is
> [Where this pass stopped, exactly](#where-this-pass-stopped-exactly),** which
> names the unread regions of `orchestrator.ts` by line and of `workflows.ts` by
> symbol.

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
file links to them rather than to be right in isolation.

> **Re-counted by the fourth pass, 2026-09-06: 454 anchor links in this
> directory, 245 of which resolve only under the single-hyphen reading and
> **none** of which resolves under neither.** That pass followed the same rule
> both ways: its four new headings
> ([B6](02-backend-logic.md#b6--the-claude-stream-parser-drops-an-event-type-it-does-not-recognise-without-a-word-and-the-codex-parser-twelve-lines-below-it-says-why-that-is-not-survivable),
> [F7](01-frontend.md#f7--the-workflow-editor-is-the-apps-one-drawing-surface-and-it-discards-a-graph-without-asking),
> [G5](03-growth.md#g5--the-chat-page-re-reads-and-re-serialises-every-message-in-the-thread-every-three-seconds-and-nothing-bounds-the-thread),
> [M7](04-missing-features.md#m7--nothing-checks-a-completeness-claim-and-docsagent-is-built-out-of-them))
> take the double hyphen and every link *to* them resolves under the correct
> reading, while its links to existing F, G, B and M rows keep the single hyphen
> the rest of the directory uses. The number grew because the register grew, not
> because anything got worse. They are all left
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

## The fourth pass, 2026-09-06

The pass that read the ground the section
[What was deliberately left unread](#what-was-deliberately-left-unread) named, in
the order that section names it, and stopped inside item 2. It added four rows —
[B6](02-backend-logic.md#b6--the-claude-stream-parser-drops-an-event-type-it-does-not-recognise-without-a-word-and-the-codex-parser-twelve-lines-below-it-says-why-that-is-not-survivable),
[F7](01-frontend.md#f7--the-workflow-editor-is-the-apps-one-drawing-surface-and-it-discards-a-graph-without-asking),
[G5](03-growth.md#g5--the-chat-page-re-reads-and-re-serialises-every-message-in-the-thread-every-three-seconds-and-nothing-bounds-the-thread),
[M7](04-missing-features.md#m7--nothing-checks-a-completeness-claim-and-docsagent-is-built-out-of-them)
— widened one
([G1](03-growth.md#g1-nine-list-routes-read-parameters-the-one-for-runs-does-not-and-the-pattern-repeats-three-times)),
and no axis. It changed nothing under `src/` or `docs/`, and it opened, closed,
commented on and edited no GitHub issue.

`src/lib/windows.ts`, `pricing.ts`, `planUsage.ts` and `repoSpend.ts` were out of
scope for it and are still unread: the reason this file gives for that — that
ContextControl and ModelRouter have both surveyed metering with real measurements
this survey cannot take — still holds and nothing on this pass tested it.

### One measurement that shapes every command below

**`grep` without `-a` returns nothing usable on the six largest files in
`src/lib/` in this container**, and says so only on stderr:

```
$ grep -oE 'CREATE TABLE IF NOT EXISTS [a-z_]+' src/lib/db.ts | sort -u | wc -l
grep: src/lib/db.ts: binary file matches
0
$ grep -aoE 'CREATE TABLE IF NOT EXISTS [a-z_]+' src/lib/db.ts | sort -u | wc -l
34
```

The six are `db.ts`, `orchestrator.ts`, `workflows.ts`, `chat.ts`, `land.ts` and
`contextPruning.ts`. **It is not the files.** `db.ts` holds no NUL byte, no
control byte and no invalid UTF-8 — checked by strict `TextDecoder` and a byte
histogram — and a byte-identical `cp` of it outside the worktree greps normally,
returning the same 34. So it is a property of this container's filesystem under
GNU grep 3.8, most likely a sparse-file probe, and **no row rests on it**. It is
recorded because it is why every command quoted on this pass carries `-a`, and
because two things the repository hands a reader as self-checks are written
without one: `docs/agent/architecture.md:198-200`'s table count, and
`CLAUDE.md:61`'s `globalThis` grep. Both answer short here, silently. Whether
they answer short on the operator's own machine is unknown from this container
and is not claimed.

### The verification loop

Run from this worktree, on the tree the four rows describe. Exit codes read from
`$?` on the command itself, not through a pipe.

| Command | Exit | Output |
|---|---|---|
| `NODE_ENV=development npm ci --include=dev` | 0 | `22 packages are looking for funding` / `found 0 vulnerabilities` |
| `npm run typecheck` | 0 | nothing beyond the banner |
| `npm test` | 0 | `# tests 2259`, `# suites 351`, `# pass 2259`, `# fail 0`, `# cancelled 0`, `# skipped 0`, `# todo 0` |

**All three pass.** The same 2,259 the refresh, the security pass and the
operations pass each recorded, over `src/` unchanged by any of the four.
`env -u __NEXT_PRIVATE_STANDALONE_CONFIG npm run build` and `npm audit` were
**not** re-run, for the reason the two passes before this one give: `src/` is
byte-identical to the tree the refresh ran them against, and this pass wrote
nothing into it.

`npm test` is also this pass's own subject at one remove. It is what produced the
`.test-build/` used below, and
[M7](04-missing-features.md#m7--nothing-checks-a-completeness-claim-and-docsagent-is-built-out-of-them)
is about what those 351 suites do not cover.

### Commands whose output is a row's evidence

**The schema, materialised.** `DATA_DIR` is unreadable by this uid, so nothing
here reads a real database. `npm test` compiles the tree to `.test-build/`, and
`db.js` out of that, pointed at a writable scratch `DATA_DIR`, runs `migrate()`
and produces the schema this install would have. Every plan and pragma below is
against **that** — a correct schema with no rows in it, which is exactly what a
query *plan* needs and exactly what a timing cannot use.

```
$ node -e '<import .test-build/lib/db.js with DATA_DIR=scratch>'
  SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'
34
```

Thirty-four tables, against the twenty-two `docs/agent/architecture.md:190` names
and calls a completeness claim. This is
[M7](04-missing-features.md#m7--nothing-checks-a-completeness-claim-and-docsagent-is-built-out-of-them)'s
first number, confirmed two ways: the doc's own grep with `-a` added, and the
schema itself.

**The plans behind [G5](03-growth.md#g5--the-chat-page-re-reads-and-re-serialises-every-message-in-the-thread-every-three-seconds-and-nothing-bounds-the-thread).**

```
chat_messages by thread :: SEARCH chat_messages USING INDEX idx_chat_messages_chat (chat_id=?)
                           | USE TEMP B-TREE FOR ORDER BY
chat_sessions newest 30 :: SCAN chat_sessions | USE TEMP B-TREE FOR ORDER BY
```

**The plans that killed a candidate**, on the `runs` table — the one this
register has suspected since it opened and never measured:

```
costBaselineFor   :: SEARCH runs USING INDEX runs_task_signature (task_signature=? AND status=?)
                     | USE TEMP B-TREE FOR ORDER BY
restartClosedRuns :: SCAN runs USING INDEX idx_runs_created
activeRuns        :: SEARCH runs USING INDEX idx_runs_status (status=?)
backfillTaskSig   :: SEARCH runs USING INDEX runs_task_signature (task_signature=?)
run_deps by run   :: SEARCH run_deps USING INDEX sqlite_autoindex_run_deps_1 (run_id=?)
run_deps by dep   :: SEARCH run_deps USING INDEX idx_run_deps_depends_on (depends_on=?)
run_events by run :: SEARCH run_events USING INDEX idx_run_events_run (run_id=?)
otlp by run+ts    :: SEARCH otlp_requests USING INDEX idx_otlp_run (run_id=? AND ts>?)
```

Every one indexed. The `run_deps` line is the same refutation this file already
carries under [One probe](#one-probe-run-to-refute-a-suspicion-rather-than-to-confirm-one),
reproduced against a fresh schema rather than the stale checkout copy.

**Foreign keys, checked rather than assumed.**

```
foreign_keys pragma = 1
workflow_schedules: workflow_id -> workflows.id onDelete=CASCADE
schedules before: 1
schedules after : 0
```

Twelve tables declare a foreign key. The cascade fires: inserting a workflow and
a schedule and deleting the workflow leaves zero schedules. That refuted a
candidate rather than producing a row — see below.

**The counts behind [M7](04-missing-features.md#m7--nothing-checks-a-completeness-claim-and-docsagent-is-built-out-of-them).**

```
$ grep -raoE '__uf[A-Za-z0-9_]+' src/ | sed 's/.*://' | sort -u | wc -l
58
$ grep -ran "globalThis as unknown" src/ | wc -l
53
$ grep -rn  "globalThis as unknown" src/ | wc -l
29      # six files reported "binary file matches" and excluded, orchestrator.ts among them
$ find src -name '*.test.ts' -o -name '*.test.tsx' | wc -l
128     # docs/agent/testing.md:310 carries this command and "# 109 as this is written"
$ grep -aoE 'id: "[a-z-]+"' src/components/shell/panes.ts   # PANES, src/components/shell/panes.ts:42-70
10      # docs/agent/conventions.md says "closed at ten" — current, #163 stayed fixed
```

**GitHub, read once and written to never.**

```
$ export GH_PAGER=cat
$ gh issue list --repo Xapicc/UsageFoundry --state closed --limit 300 \
    --json number,title,state   # exit 0, 19,300 bytes, 181 issues
```

Persisted to a scratch file and read back in two sections of ninety titles, as
the brief asked. **Numbers and titles only; no body was fetched.** Nineteen
numbers were checked against that list: the nine the register carries as
ownership (#68, #78, #87, #89, #91, #99, #114, #125, #155) appear in none of the
181, so all nine are still open; the sixteen doc-count issues M7 cites (#123,
#124, #133, #136, #140, #150, #151, #153, #161, #162, #163, #166, #169, #174,
#175, #176) and the three doc-drift indexes (#144, #152, #154) are all in it, so
all nineteen are closed.

### What was read, and how much of it, region by region

**1. `orchestrator.ts` outside the guard sites, the run loop, the queue
selections and `createRun` — 11,281 lines, not the 9,710 the brief quotes.**
The whole file was **mapped**: a declaration grep produced 218 top-level
functions, types and `globalThis` handles with their line numbers, and that map
was read end to end. Then roughly **1,900 lines** were read closely, chosen from
the map:

- `:429-573` — the bus, `procs`, `Interrupt` and `interruptOutcome`, `LiveGuard`,
  `ContextWatch`.
- `:5537-5766` — `contextShapingEnv`, `childEnv`, `needsLiveSpendTelemetry`,
  `telemetryEnv`, the git credential helper, `githubEnv`, `signalTree`.
- `:5966-6230` — `runIteration` whole, and the head of `prune`.
- `:6802-7011` — `permissionDenials`, `parentToolUseId`, `toolResultText`,
  `toolResultFailures`, `cycleCostAfterResult`.
- `:7011-7390` — `handleStreamLine` whole, and the head of
  `handleCodexStreamLine`. **This is where B6 came from.**
- `:7496-7575` — the Codex parser's `default:` arm and `currentSnapshot`'s
  docblock.
- `:9169-9348` — `interruptRun`, `stopRun`, `CONTEXT_READ_MAX_INTERVAL_MS`.
- `:9769-9963` — `predictedPayback` and the five per-run `globalThis` maps with
  their docblocks, plus the sweeper's start and stop.
- `:10940-11119` — `restartClosedRuns` through `reopenRestartClosed`.

Plus targeted greps over the whole file for empty `catch` blocks, for every
`.set`/`.delete`/`.clear` on the per-run maps, and for each map's call sites.

**2. `workflows.ts` outside `advanceInstances`, `planLoopPass` and the instance
status derivation — 5,257 lines. This is where the pass stopped, and it stopped
early.** The file was **mapped** the same way — 133 declarations, read end to end
— and then only `:1557-1646` was read closely: `duplicateWorkflow`,
`deleteWorkflow`, `WorkflowInstanceStatus` and `instanceIsOpen`. `listInstances`
at `:2103` and its one caller were read through greps. Everything else in that
file is **unread**; the boundary is named exactly below.

**3. `src/app/branches/page.tsx`, `WorkflowEditor.tsx` and `canvasGraph.ts`.**
`src/components/WorkflowEditor.tsx` (1,585 lines) was read at `:575-634` — the
whole of `save()` — and otherwise probed with greps for state, `localStorage`,
`router.push`, the Cancel control and any dirty tracking; that is
[F7](01-frontend.md#f7--the-workflow-editor-is-the-apps-one-drawing-surface-and-it-discards-a-graph-without-asking)'s
whole evidence and every line of it is a reading of source, because **no browser
was opened at any viewport**. `src/app/branches/page.tsx` was probed only: it
already holds `offset` state and a `repo` filter, which is why the growth caps
that region was named for stayed refuted and why nothing was filed against it.
`src/lib/canvasGraph.ts` (408 lines) was **not read** beyond its line count.

**4. The 181 closed issues.** Every title read, in two sections. No body fetched.
Three subjects re-checked against the tree (#161, #163, #166), of which two are
wrong again and one is current — that is
[M7](04-missing-features.md#m7--nothing-checks-a-completeness-claim-and-docsagent-is-built-out-of-them),
including its honest third.

**Also read**, because a row cannot be filed against `orchestrator.ts` without
it: `docs/agent/run-lifecycle.md` end to end, all 139 lines of it. That is what
established B6 is *not* a third violation of a documented invariant — the file
has no position on stream-event handling — and what killed two candidates before
they were written.

### Where this pass stopped, exactly

So the reader after this one knows, in the same terms this file was given.

**In `orchestrator.ts`, unread at the end of this pass:**

- `:170-429` — `RunStatus`, `RunRow`, `RunOrigin`, `RunEvent` and their fields.
- `:573-965` — `timers`, `cycleSilenceMs`, `emit`, `logLifecycle`, `log`,
  `emitRunEvent`, `getRun`, `listRuns`.
- `:965-1137` — the run-list query, filters and paging, and `setStatus`. Covered
  by [F1](01-frontend.md#f1-run-history-stops-at-100-rows-and-cannot-be-paged-filtered-or-searched)
  rather than read here.
- `:1137-1979` — folder resolution, `mountTopology`, `conflictKey`, `overlaps`,
  and the whole refusal-classification band: `isUsageLimit`,
  `isTransientApiError`, `isRateLimited`, `refusalKind`, `refusalInStderr`,
  `jitterMs`, `maxRetriesFor`, `transientBackoffMs`, `refusalDisposition`,
  `refusalStopReason`, `waitUnlessInterrupted`, `refusalResumeAt`. **The largest
  coherent unread block with rows plausibly in it**, and the one this pass would
  read next: `docs/agent/run-lifecycle.md:19-29` states eleven separate things
  about it, which is the density that produced both of the register's documented
  violations.
- `:1979-3084` — `resolveIsolation`, `probeIsolation`, the worktree store,
  `slotIsDirty`, `recentSlotVerdict`, `ensureWorktree`, the copy globs and
  seeding. `docs/agent/isolation-and-landing.md`'s ground, untouched.
- `:3084-3664` — `activeRuns`, `occupantOf`, `allocateSlotPath`,
  `slotExhaustionRefusal`, `planWorkspace`, `admitDependencies`.
- `:4044-4806` — the dependency machinery below `queuePosition`:
  `edgeSatisfied`, `dependencyCycle`, `topologicalOrder`, `releasableRuns`,
  `dependenciesOf`, `revivableDependents`, `releaseDependents`, `releasePass`,
  `blockWaitingRun`, `haltedWorkflowOf`, `reviveBlockedDependents`,
  `admitWaiting`.
- `:4833-5537` — `injectionFates`, `compactionNotice`, `sandboxSettings`,
  `writeSet`, `sandboxArgs`, `sandboxArgsFor`.
- `:6230-6802` — `prune`'s body, `pruneAtBoundary`, `settleBoundary`,
  `pruneAtEarlyEnd`, `forkAndAdopt`, `observePlan`, `contextAfterPrune`.
- `:7575-7667` — `buildCurrentSnapshot`, `reconcileKilledCycle`.
- `:7667-9169` — `startRun`, the run loop. Read by the original survey, not
  re-read here.
- `:9348-9769` — `guardScanDue`, the live ticker, `liveGuardTick`,
  `checkContextCeilings`.
- `:9963-10940` — `duePausedRuns`' body, `planPausedRun`, `sweepPaused`,
  `resumeRun`, `reopenPrompt`, `reopenRun`, `killAllAgents`, `cyclesInFlight`,
  `reconcileInterruptedCycles`, `shutdownRuns`.
- `:11119-11281` — `isRunning`, `reconcileOnBoot`.

**In `workflows.ts`, unread at the end of this pass — which is nearly all of
it.** Named by symbol rather than by line, because the map is what the next
reader will start from: `planWorkflowProposal`, `summarizeProposedGraph`,
`approveWorkflowProposal`, `planNode`, `guardsFor`, `planEmittedRun`,
`planEmission`, `normalizeSpec`, `planInstanceStep`, `edgeVerdict`,
`loopVerdict`, `rowToWorkflow`, `withNameConflict`, `listWorkflows`,
`createWorkflow`, `updateWorkflow`, `sumMemberSpend`, `instanceSpend`,
`loopSpend`, `memberTally`, `blocksOf`, `parseSpecs`, `instanceOwnsRun`,
`rowToInstance`, `lastRunAt`, `liveRunsOf`, `liveBlocksOf`, `startWorkflow`
(`:2250-2523`, the largest single function in the file), `recordMember`,
`deferredNodes`, `haltCause`, `haltPlan`, `haltSteps`, `membersOf`,
`stopInstance`, `walkMembers`, `haltBlocks`, `reconcileHaltsOnBoot`,
`guardedInstanceOf`, `enforceInstanceBudget` and its two siblings,
`guardInstance`, `blockTurns`, `getBlock`, `noteBlock`, `reviveBlockedBlocks`,
`advanceInstance`, `instanceState`, `nextPosition`, `upsertBlock`, `claimBlock`,
`claimLoop`, `settleLoop`, `loopPasses`, `advanceLoops`, `advanceLoop`,
`createPass`, `startBlockTurn`, `safeFolder`, `blockSettlement`, `settleBlock`,
`mergeBlockOutcome`, `startMergeBlock`, `withNote`, `branchVerdict`,
`branchLabel`, `awaitBatch`, `finishMergeBlock`, `createEmitted`,
`emittedFolderRefusal`, `emitBlockRuns`, `blockSystemPrompt`, `bootBlockPlan`,
`reconcileBlocksOnBoot`, `runStateOf`.

**Why it stopped there rather than sweeping all four thinly.** The brief said a
thorough pass over the first two beats a thin pass over four. What actually
happened is between the two: item 1 was read at roughly a quarter of its unread
extent and produced the strongest row; item 2 was mapped and read at one section;
items 3 and 4 were read for one question each, and item 4 produced a row anyway
because a closed-issue list is cheap to check a claim against. **The honest
summary is that item 2 is where a fifth pass should start**, and that
`orchestrator.ts:1137-1979` is where it should go after that.

### Refuted or already decided on this pass

Seven candidates that looked like gaps and are not. Five were killed by a
measurement rather than by a paragraph, which is what running a database bought.

**The per-run `globalThis` maps in `orchestrator.ts` leak.** They do not. Every
one — `interrupts`, `liveGuards`, `contextWatches`, `earlyEndDeclined`,
`ceilingMeasuredAt`, `compositionMeasuredAt`, `boundaryDeclines`, `pendingFork` —
is deleted in `startRun`'s `finally` at `src/lib/orchestrator.ts:9022-9032`, and
each carries a docblock ending in a sentence naming when it clears. `procs` is removed
there too and again in `runIteration`'s `finish` at `:6114`, whichever comes
first. **This closes the in-memory half
of [dropped candidate 1](#dropped-for-lack-of-evidence)**, which was dropped
because *"the in-memory side was not read closely enough to claim anything"*; it
has now been read and there is nothing to claim. The persisted half is still
`retention.ts`'s and is still
[O6](08-operations.md#o6--plan_observations-grows-at-every-boundary-is-swept-by-nothing-and-is-read-by-nothing)'s.

**`deleteWorkflow` orphans its instances and its schedules.** It does not.
`PRAGMA foreign_keys` reads 1 on a handle `db()` opened, twelve tables declare a
foreign key, `workflow_schedules.workflow_id` is `ON DELETE CASCADE`, and
inserting a workflow with a schedule and deleting the workflow leaves zero
schedules. The docblock at `src/lib/workflows.ts:1583-1588` is accurate. What the
delete confirmation at `src/app/workflows/[id]/page.tsx:363-364` does not say is
that the schedule goes too — and that is not a gap, because a schedule whose
workflow is gone has nothing left to fire.

**A workflow can carry a second, invisible schedule.** It cannot.
`workflow_schedules.workflow_id` is `UNIQUE`, so the singular
`workflow.schedule ?? null` the page renders at
`src/app/workflows/[id]/page.tsx:411` is the whole truth.

**A schedule records only its most recent outcome.** It records more than that.
Beside `last_code` — `started`, `overlap`, `unbudgeted`, `refused`, `missed` —
the row carries `streak` and `streak_since`, so *"refused six times since
Tuesday"* is representable and is what the schedule card is built on.

**`ops_events` is a fourth unbounded store.** It is not. `recordOpsEvent`
evicts past `OPS_EVENT_RETENTION = 500` on every insert
(`src/lib/ops.ts:156-172`), on `request_log`'s pattern. It has exactly two
production writers — `orchestrator.ts:11279` and `contextPruning.ts:2719` — which
is also what makes
[O1](08-operations.md#o1--the-one-restart-condition-the-runbook-alerts-on-never-clears-and-the-count-that-does-is-on-a-route-the-status-token-cannot-reach)'s
*"never clears"* true rather than approximately true: at boot frequency nothing
pushes that row out. The fourth unbounded store is still
[O7](08-operations.md#o7--the-containers-own-log-is-a-fourth-unbounded-store-and-compose-asks-for-no-limit-on-it)'s,
and it is the container log.

**Query performance on the `runs` table.** Every hot query uses an index — the
plans are quoted above. This answers half of
[dropped candidate 3](#dropped-for-lack-of-evidence): the *runs* half is not a
gap. The other half — how slow any of it actually is — is still unmeasured,
because a plan is not a timing and there are no rows here to time against.

**A workflow's instance history capped at twenty is a new row.** It is not; it is
[G1](03-growth.md#g1-nine-list-routes-read-parameters-the-one-for-runs-does-not-and-the-pattern-repeats-three-times),
whose entire claim is that the shape repeats. Filed as an amendment to that row's
table rather than as G6, which is what the brief's rule against refiling an
existing row in another framing requires and what makes G1 stronger rather than
G1-plus-one.

### Dropped for lack of evidence on this pass

Three, plus one recorded inside a row rather than filed.

1. **Whether the pinned CLI emits a fifth top-level stream event type.** Four are
   handled and four is what a reading of the handler establishes; nothing here
   ran `claude -p --output-format stream-json` and read its output.
   [B6](02-backend-logic.md#b6--the-claude-stream-parser-drops-an-event-type-it-does-not-recognise-without-a-word-and-the-codex-parser-twelve-lines-below-it-says-why-that-is-not-survivable)
   is argued from the asymmetry and from the docblock, and marks this assumed in
   its own text and in the register's Conf. column.
2. **What [G5](03-growth.md#g5--the-chat-page-re-reads-and-re-serialises-every-message-in-the-thread-every-three-seconds-and-nothing-bounds-the-thread)
   costs at a real thread length.** No thread of any length is readable here, so
   the row carries a query plan and no milliseconds.
3. **Whether `grep`'s binary verdict reproduces outside this container.** A
   byte-identical copy greps normally, so it is this filesystem and not the
   repository; it is recorded as a measurement above and no row rests on it.

**And one seen, checked and not filed**, recorded inside
[B6](02-backend-logic.md#b6--the-claude-stream-parser-drops-an-event-type-it-does-not-recognise-without-a-word-and-the-codex-parser-twelve-lines-below-it-says-why-that-is-not-survivable)
rather than here: `runIteration`'s deadline message names one CLI in a fixed
string — *"No output from Claude Code for …"* at
`src/lib/orchestrator.ts:6191` — inside the one function whose whole argument for
taking the adapter as a required parameter is that a provider must not be
confused for another. A Codex cycle that hangs is ended with a sentence naming
Claude Code. It is one interpolation, nothing decides differently because of it,
and it did not seem worth a row.

### The vault, on this pass

Not consulted. All four rows are a line in this repository, a command's output
quoted above, or a sentence in this repository's own documentation.
