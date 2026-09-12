# Implementation sketch

**Five phases for the decided design**, in build order. The design is
[01a-mechanism.md](01a-mechanism.md) and the four files beside it; this file is
how it gets built and in what order. It replaces the sketch that phased
`20-recommendation.md`, which recommended building almost nothing and is
superseded whole.

Each phase names **what ships**, **the invariant it must not break**, **what the
operator can see when it lands**, and **which functions earn a test**.

**The test bar is `CLAUDE.md`'s and not a general convention**: a pure function
whose failure mode is silent gets a unit test, and `docs/agent/testing.md`
records what each existing one earned. That file *"names every existing one and
the grounds each earned, and that is the bar, not a general convention to
follow"* (`CLAUDE.md`). **Seven functions in this whole plan meet it**, named
phase by phase and collected in §6.

The bar is not "no I/O tests" — `src/app/api/health/route.test.ts` earned one by
answering falsely when the server cannot do its job. **Nothing in this plan is
that shape**: its routes are reads whose failure is a visibly empty card, and its
one dangerous surface is a shell script the deployment tests already have a way
of pinning (`src/lib/deployment.test.ts`, which asserts over the *text* of
`Dockerfile`, `docker-compose.yml` and `docker-entrypoint.sh`).

Checked against the tree at `ec205fe`. **This container has no Docker**, so every
phase's persistence claim is reasoned rather than observed and
[22-validation.md](22-validation.md) §5 has the commands that would settle it.

---

## The order is the argument

**Phase 1 ships the read-back, before anything installs anything**, and that
inverts the order somebody would reach for. The reason is this directory's own
central finding: *"an install that fails costs a boot log line an operator is
watching, and a tool that is absent costs billed tokens on every cycle of every
run that needed it, discovered by nobody"* (`01-constraints.md` R5). Building the
installer first ships the expensive half first — more tools, and still no way to
learn that one of them is missing except by paying for it.

It is also the phase that stands alone. **Phase 1 touches no `Dockerfile`, no
`docker-compose.yml`, no `docker-entrypoint.sh` and no volume**, and it is worth
having on an install that never adds a stack, because the two tool lists it
reports on — `UF_GH_EXTENSIONS` and `UF_PY_TOOLS` — are shipped, documented and
**completely unreported** today: `grep -rn "UF_PY_TOOLS\|UF_GH_EXTENSIONS" src/`
returns ten lines in two files at `ec205fe`, one docblock mention in
`src/lib/contextPruning.ts:99` and nine in `src/lib/deployment.test.ts`, and none
of them is a read.

After that the order is forced. Phase 2 is the carrier and the one verb that
needs no trust beyond a URL. Phase 3 is the rest of the format. Phase 4 is the
grant and is the only phase the probe can delete. Phase 5 is the last mile of the
surface and is deliberately last because it is the only one whose absence costs
nothing but convenience.

---

## Phase 0 — the probe

**One work cycle. Nothing ships. It can run beside phase 1.**

[01c-reach-and-permission.md](01c-reach-and-permission.md) §4 has the commands
verbatim. It measures R3's third link: whether a work cycle at `acceptEdits` may
invoke a binary the CLI has never seen, with and without a `Bash(<name>:*)`
grant.

**Invariant not to break:** none. Nothing is changed; this is a measurement.

**Operator sees:** a run, and its log.

**Test:** none.

**Output:** a `docs/verification.md` entry, whatever the answer, because that
file's honesty is the point of it and `01c-` §6 already writes the *Not yet
verified by hand* sentence it replaces.

**What it decides:** whether phase 4 exists. If an ungranted binary runs, phase 4
is deleted and the design is the same minus `01c-` §4.2, which is a deletion
rather than a redesign — *"which is why it is built assuming the worse answer"*
(`01a-` §10).

---

## Phase 1 — the read-back, over what is installed today

**Two to three days. Ships alone and is worth having alone.**

### What ships

- **`src/lib/toolInventory.ts`** — `15-option-no-stack-object.md` §2's module,
  carried forward. Parses `UF_GH_EXTENSIONS` and `UF_PY_TOOLS` into
  `{ ecosystem, name, version }`. **The two parsers differ and the difference is
  the whole reason this is a module**: `UF_GH_EXTENSIONS` splits on `|` *and*
  `,` while `UF_PY_TOOLS` splits on `|` only, because *"a comma is meaningful
  inside a version specifier"* (`docs/install.md:195-197`), and
  `src/lib/deployment.test.ts:1056-1069`,
  `it("does not split entries on commas, which belong to version specifiers")`,
  already asserts the entrypoint loop treats them that way.
- **`resolveOnPath(name, pathValue, exists)`** — [01f-](01f-read-back.md) §2.3's
  resolution, with the filesystem predicate injected so the function stays pure.
- **the `observed` layer** — the bounded `run_events` query of `01f-` §2.4,
  behind a 60-second `globalThis` cache in `src/lib/fileCostNotice.ts:310-315`'s
  shape.
- **`GET /api/tools`** — `runtime = "nodejs"`, `dynamic = "force-dynamic"`
  (`docs/agent/conventions.md:11`), through `jsonMaybeGzipped` like the other
  eighteen (`:18`), with a list DTO in `src/lib/apiTypes.ts`.
- **a `Tools` section on Settings**, `01e-` §2 and §4. Two groups in this phase —
  `UF_PY_TOOLS` and `UF_GH_EXTENSIONS` — and the stacks group arrives in phase 2
  with nothing about the section changing to admit it.
- **two integers on `/api/status`**, which in this phase count declared `UF_*`
  entries and entries that do not resolve. `01e-` §5.3.

### The invariant it must not break

**The server's environment is not the child's, in one direction only.**
`childEnv` deletes every `UF_*` key (`src/lib/orchestrator.ts:5698-5711`), so
reading `process.env.UF_PY_TOOLS` is legal **on the server** and would be empty
in any child. The server holds them because the entrypoint `exec`s it
(`docker-entrypoint.sh:1223`) and unsets only `DISCORD_WEBHOOK_URL` and
`DISCORD_MENTION_USER_ID` (`:853`). This is the one non-obvious fact the phase
rests on, and it is what makes it cheap.

**And the second: `/api/status` carries counts and not names.**
`src/lib/status.ts:24-28` — *"counts, bytes, fractions and timestamps only — no
prompt text, no folder or mount path, no settings value, no token, no branch
name, no model"*. A tool name is a settings value in everything but the table it
is stored in.

### What the operator can see

A Tools section listing every tool they declared in `.env`, each with a badge
saying whether it resolves on `PATH` and whether anything has ever invoked it.
**On many installs the first thing it will show is that something does not
resolve**, which is the point: that state is unreadable today except by shelling
into the container.

### Which functions earn a test

Three, and the first is the strongest case in the plan.

1. **`parseToolList(value, separators)`** — pure, two call sites with different
   separator rules, and *"a parser that gets that wrong silently installs
   nothing"* (`15-` §2). It is also the only function here whose wrongness is
   already possible today in the shell and merely unobserved.
2. **`resolveOnPath`** — pure with the predicate injected. An empty `PATH`
   element means the current directory and a trailing colon means the same; a
   resolver that treats either as "not found" or as "found" silently changes what
   the page claims about every binary at once.
3. **`composeState`** — [01f-](01f-read-back.md) §3's six-row table. Every way of
   being wrong is silent and one direction is expensive: a composition reporting
   `installed` over a `broken` resolution is a page telling an operator that the
   thing costing them money is fine.

**No route test**, per the header.

---

## Phase 2 — the carrier, and one verb

**Three to four days. The first phase that installs anything.**

### What ships

The six one-time changes of `01a-` §2.3, in a commit that names no tool, plus the
`archive` verb and nothing else:

| File | The one change |
|---|---|
| `docker-compose.yml` | one mount `${UF_STACKS_DIR:-./stacks}:/etc/uf-stacks:ro`, one named volume |
| `Dockerfile` | one `ENV PATH="/var/lib/uf-stacks/bin:${PATH}"`, and `scripts/apply-stacks.mjs` added to the `COPY` |
| `docker-entrypoint.sh` | one block running the applier before `exec "$@"` (`:1223`) |
| `scripts/apply-stacks.mjs` | new: parse, digest, download, verify, unpack, link, write receipts |
| `src/lib/stacks.ts` | new: read and type the receipts |
| `src/lib/apiTypes.ts` | the stack rows on the existing `/api/tools` DTO |

Plus one entry in `BUILD_CACHE_DIRS` (`src/lib/orchestrator.ts:5327`) so a
sandboxed run may write `state/`, per `01a-` §4.3.

**`archive` first and alone** because it is the one verb that executes nothing at
install time (`01b-` §2.1). `uv-tool` and `npm-global` run whatever the package's
install hooks run, as the agent uid; shipping them in the same commit as the
carrier would mean the first thing this mechanism ever did was execute a
stranger's code, and nothing would have been reviewed against a working install
yet.

**The applier's whole-run time budget ships here**, not later. `01e-` §3: ten
stacks each timing out politely is still a container past its 180-second
`--start-period` (`Dockerfile:737`), and a stack the applier never reached must
write a `failed` receipt reading *not attempted* rather than none at all. A
missing receipt reads as a stack that was never declared, which is the one way
this phase could produce the silent failure the whole directory is about.

### The invariant it must not break

**`C1`: the image ships nothing under `/var/lib/uf-stacks`, ever.** A named
volume takes its contents from the image exactly once, at creation
(`Dockerfile:303-309`), so anything the image puts at a volume's mount point is
visible on a reviewer's fresh install and masked on every install that already
exists. **This is the one invariant in the plan whose breach is invisible to the
person who breaks it**, and §6's assertion 3 is the only thing that catches it.

**And: never a shell.** `docs/agent/security.md:14` — the agent is spawned
*"with an argument array and `stdio: ["ignore", "pipe", "pipe"]`, **never a
shell**, so prompt metacharacters are inert"* — over an artifact a third party
wrote. `01b-` §2's three expansion
tokens and closed verb list exist for this, and the applier interpolates into
argv arrays and never into a command string.

### What the operator can see

`01e-` §3's boot log, the stacks group in the Tools section from phase 1, and —
for the first time — a tool they added without editing a file the image contains.
R1, R2 and R4 are met at the end of this phase; R5 is met for stacks because the
receipts now feed the section phase 1 built.

### Which functions earn a test

Two in the applier, both pure over lists:

4. **`reconcile(declarations, receipts)`** — `01a-` §7's three rules: digest
   match is a no-op, digest mismatch is a reinstall keeping `state/`, a receipt
   with no declaration is a removal. *"The applier removes only paths its own
   receipts record"* is the assertion that matters, and the failure mode is
   deleting something it did not install, which is silent and unrecoverable.
5. **`parseStack(json, dirName)`** — `01b-` §3's refusal list, now eleven
   refusals including the two `01g-` §5 added. Each refusal is a branch, and the
   two new ones — a string `sha256` against an arch-varying `url`, and an object
   `sha256` missing a key — are exactly the kind that fail on somebody else's
   machine if they are wrong.

Plus three assertions in `src/lib/deployment.test.ts`, per `01a-` §9, in the
style of the existing `:905`, `:978`, `:1029` and `:1137`:

- the mount and the volume exist and are spelled as the entrypoint and the
  `Dockerfile` expect;
- `ENV PATH` carries `/var/lib/uf-stacks/bin`;
- **the `Dockerfile` contains no path under `/var/lib/uf-stacks`** — the `C1`
  guard above.

**One repair to an existing test belongs in this phase**: `childEnv` has three
`describe` blocks in `src/lib/orchestrator.test.ts` (`:4251`, `:4305`, `:4340`)
and none asserts anything about `PATH`. The whole reach argument rests on `PATH`
passing through, the only assertion is over `gitEnv` (`src/lib/git.test.ts:97`),
and the repair is one line.

---

## Phase 3 — the rest of the format

**Two to three days.**

### What ships

- **`uv-tool` and `npm-global`**, `01b-` §2.1. The first is the existing
  `UF_PY_TOOLS` command — `uv_as_agent tool install "$1"`
  (`docker-entrypoint.sh:233`) — pointed at `{pkg}/bin` instead of at
  `/home/node/pytools`.
- **`env`**, and the `src/instrumentation.ts` merge that carries it into
  `process.env` so `childEnv` can copy it onward (`01a-` §2.3, §5).
- **`state`**, the directories created under `{state}` at the agent uid
  (`01b-` §2.3).
- **conflict detection**: two stacks claiming one binary name, both
  `conflicted`, neither linked, each naming the other (`01a-` §7).
- **`GET /api/stacks/[name]`** and the `/settings/stacks/<name>` page —
  `01e-` §2.1, `01f-` §5.

### The invariant it must not break

**`env` may not set what `childEnv` strips or what the container decides.**
`01b-` §2.2's four refusals: no `UF_*` key, because `childEnv` deletes the whole
prefix and the variable would be set and then silently gone; none of the named
keys that decide where things are; no shell metacharacter, because there is no
shell to interpret it; nothing resolving under `/home/node/.claude`, which is the
host's `~/.claude` bind.

**And the uid split holds.** Download, verify, unpack and `chmod` run under
`setpriv --reuid="$UF_AGENT_UID"` in the form
`docker-entrypoint.sh:147-148` and `:218-219` already use; the `chown -R
root:root` and the `install -m 0755` are root's (`01b-` §4). The reason the split
is safe here and would not be at run time is `01a-` §6: this is the only window
with no agent process alive.

### What the operator can see

A stack that installs a Python or Node tool, exports an environment variable and
keeps a cache across restarts — and, on the detail page, the last 4 KB of the
step's stderr when one does not. That last is the thing this phase adds that
nothing before it could: **the failure text, in the app, after the restart that
destroyed the log line** (`src/lib/db.ts:182-184`).

### Which functions earn a test

Two:

6. **`expandTokens(value, arch)`** — four tokens now, two of them architecture
   spellings that differ (`01g-` §5.1: `dpkg --print-architecture` says `arm64`
   where `uname -m` says `aarch64`, measured in this container 2026-09-12). A
   wrong expansion is a 404 at boot, read once, on one architecture only.
7. **`refuseEnv(key, value)`** — `01b-` §2.2's table. Every entry in it prevents
   a *silent* failure by construction, which is the bar restated.

**The conflict rule is `reconcile`'s** and is asserted there, in the test phase 2
wrote.

---

## Phase 4 — the grant

**Half a day, and phase 0 may delete it entirely.**

### What ships

One append in `src/lib/cycleInvocation.ts`. The `--allowedTools` list is built at
`:1193` onward from `ISOLATED_GIT_TOOLS` (`:633`) and `SEARCH_TOOLS`; a third
list joins them, derived from the `allow` arrays of receipts whose status is `ok`
(`01a-` §4.2, `01c-` §3).

**Derived and never configured.** It is one change and none per tool, and it
reaches two of the five child kinds: the work cycle and the conflict assist.
`plan` refuses it and is meant to, `bypassPermissions` does not need it
(`01c-` §5).

### The invariant it must not break

**Every flag must ride every cycle's argv.** `docs/agent/run-lifecycle.md` is the
routing for that rule, and the trap it names is `--resume`: a flag that is not on
the resumed cycle's argv is a flag that silently stops applying partway through a
run. A grant appended on the first cycle and not the fifth is a tool that stops
working for no visible reason.

**And the grant may only name this stack's own binaries** (`01b-` §2.4), which is
a parse-time refusal from phase 2 rather than something this phase re-checks.
Re-checking it here would be a second place that can disagree with the first
about what a stack may grant.

### What the operator can see

Nothing new on any page — the grants were already on the detail page in phase 3,
projected from the receipt. What changes is that a work cycle can run the tool.
**That is the phase's own risk**: its success is invisible and its failure is
`01f-` §3's `failing`, which is why phase 1 shipped first.

### Which functions earn a test

**None, and that is deliberate.** The projection is a `flatMap` over receipt
fields into a string template; its input is validated at parse (phase 2, test 5)
and its output is asserted by the run loop's own argv construction. A test here
would be testing `Array.prototype.flatMap`, which is not what the bar is for:
`docs/agent/testing.md` records grounds per function, and "it calls `flatMap`"
is not one anybody wrote down.

---

## Phase 5 — the last mile of the surface

**One to two days. Nothing else depends on it.**

### What ships

- **the `ops_events` row per non-`ok` outcome**, one event name with `detail`
  saying which, through `recordOpsEvent` (`src/lib/ops.ts:155`) — `01e-` §5.2.
- **the `unclaimed` list**: names in `/var/lib/uf-stacks/bin` that no receipt
  claims, which is how somebody installing by hand becomes visible
  (`01f-` §2.3).
- **the state-directory size and the sentence about losing it on removal**
  (`01e-` §6).
- **`docs/install.md`'s operator half** and the two `docs/agent/` edits `01a-` §9
  names: `architecture.md` gains `scripts/apply-stacks.mjs` and
  `src/lib/stacks.ts` on the module map and the `C1` sentence;
  `security.md` gains `01b-` §6's trust statement.

### The invariant it must not break

**`ops_events` is capped at 500 rows** (`src/lib/db.ts:136-137`), and the cap was
sized for *"boot-frequency writes"*. An applier that wrote a row per *step* per
boot rather than per failed *stack* would evict the rest of the table on an
install with a few stacks, which is the trap
`src/lib/contextPruning.ts:2919-2922` records for a repeating fault.

**And the `docs/` edits come last on purpose.** `proposals/README.md`: *"A
proposal is promoted by implementing it and moving its reasoning into those two
places."* Documenting a mechanism before it exists is how `docs/` drifts, and
`CLAUDE.md` says `docs/verification.md`'s *Not yet verified by hand* list *"must
stay honest"*.

### What the operator can see

The complete surface of `01e-`, plus a page in `docs/install.md` that tells them
how to write a stack. This is also the phase where `22-validation.md` §5's
commands get run for real and their answers go into `docs/verification.md` as
*Verified* entries.

### Which functions earn a test

**None.** Every item here is an I/O read or a document. The `unclaimed` list is a
`readdir` minus a set, which is the framework; the size walk is
`docs/agent/retention.md`'s cached-walk pattern and inherits its reasoning.

---

## 6. The seven tests, collected

| # | Function | Phase | The silent failure it prevents |
|---|---|---|---|
| 1 | `parseToolList` | 1 | a separator rule that installs nothing and says so nowhere |
| 2 | `resolveOnPath` | 1 | an empty `PATH` element changing every row on the page at once |
| 3 | `composeState` | 1 | `installed` drawn over a `broken` resolution |
| 4 | `reconcile` | 2 | removing a path the applier did not install |
| 5 | `parseStack` | 2 | a refusal that does not fire, on somebody else's machine |
| 6 | `expandTokens` | 3 | a 404 at boot on one architecture only |
| 7 | `refuseEnv` | 3 | a variable set and then silently stripped by `childEnv` |

Plus **three `deployment.test.ts` assertions** in phase 2, of which the `C1`
guard is the one whose absence is invisible, and **one repair** to
`orchestrator.test.ts` asserting `childEnv().PATH`.

**Read `docs/agent/testing.md` before writing any of them.** It *"names every
existing one and the grounds each earned, and that is the bar, not a general
convention to follow"* (`CLAUDE.md`).

---

## 7. What is not in this plan, and where it went

| Not built | Why | Where it is argued |
|---|---|---|
| a tenth pane, or a Terminal in any form | eleven rows against nine digits; new destinations are sub-routes | `01e-` §2, `docs/agent/ui-density-audit.md:159-162` |
| an install, retry or remove button | `/api/settings` is reachable with the master key | `01e-` §7, `01a-` §6 |
| a `stacks` table | the receipts are the state and they are per boot | `01a-` §7, `14-` §7 |
| per-run, per-folder or per-template stack selection | all three doors are closed by name | `01d-` §3 |
| a registry, or `stack install <url>` | it would move the trust boundary back inside the container | `01d-` §3 |
| a dependency graph between stacks | two things that must be ordered are one stack | `01d-` §3 |
| signature verification | this repository holds no key material | `01b-` §6, `01d-` §3 |
| `apt-get`, or a fourth verb for it | cannot be pinned per install or removed cleanly | `01d-` §3 |
| refusing a run whose tool is missing | this app's rule for a guard that cannot read its input is to hold | `17-`:227, `docs/agent/budgets-and-guards.md` |
| removing `UF_GH_EXTENSIONS` or `UF_PY_TOOLS` | both work and both meet R1 already | `01d-` §1 |

---

## 8. What each phase leaves unverified

**Nothing in phases 1 and 4 depends on a fact this container could not check.**
Phase 1 is `process.env`, a `PATH` split and a SQLite query; phase 4 is a string
append.

**Phases 2, 3 and 5 rest entirely on facts nobody here can check**: that a named
volume survives `docker compose up --build`, that a read-only bind is a read-only
bind, that the applier's uid split behaves, and that `install -m 0755` into a
volume on `PATH` produces a binary a child resolves. Every one is reasoned from
`docker-compose.yml` and `docker-entrypoint.sh`'s own statements, and
**`docs/verification.md` records nothing about any of the five named volumes** —
`grep -n "UF_PY_TOOLS\|UF_GH_EXTENSIONS\|usagefoundry-pytools\|gocache" docs/verification.md`
returns zero lines at `ec205fe`.

[22-validation.md](22-validation.md) §5 lists the commands in the order they buy
the most, and **the first two of them should be run before phase 2 starts**, not
after it ships: if a named volume does not survive a rebuild on the operator's
engine, R4a degrades from *met* to *met when the network is up* and phase 2's
whole-run time budget becomes a per-boot cost rather than a first-boot one.
