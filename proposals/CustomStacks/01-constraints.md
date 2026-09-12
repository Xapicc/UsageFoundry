# The requirement set

**This file is the acceptance criteria for the feature, not a survey of what an
option would have to survive.** The decision to build is recorded at the top of
[README.md](README.md). Five requirements come from the operator; the rest are
constraints this tree imposes, each with the citation that imposes it. Every one
is phrased so that a later run can answer **met** or **not met** and say which
command or file settles it.

Checked against the tree at `6c5af5f`. Where a claim could not be checked, and
several central ones cannot be, because **this container has no Docker**, the
sentence says "assumed" at the point it is made.

---

## Part 1. The five operator requirements

### R1. Adding a tool requires no edit to any file inside the published image

**This is the central requirement. A design that fails it is out of the
running.**

**Met when:** the change that adds a tool to an install touches none of
`Dockerfile`, `docker-entrypoint.sh`, `scripts/`, `src/`, or any other path the
image contains, and an operator running a *pulled* image can add the tool
without building one.

**Not met when:** adding a tool means editing this repository's `Dockerfile` or
its entrypoint, however small the edit. `9cc0935` added `jq` by putting one word
on `Dockerfile:130`, and that is precisely the shape R1 forbids.

**Note what R1 does not forbid.** It constrains the *per-tool* cost, not the
mechanism's own cost. Whatever carries a stack may itself be built into the
image once, in a commit that names no tool. R1 is about what the twelfth tool
costs, not the first.

**How to test it:** `git diff --name-only` over the commit that adds a tool, and
separately, an install started from `docker compose pull` rather than
`docker compose up --build`.

### R2. A stack is a self-contained declarative unit a third party can author, copy and share

**Met when** all four hold:

1. A stack is **one artifact**, a file or a directory, whose content alone
   determines what gets installed.
2. Its author needs no knowledge of `src/`. The words in it name tools and
   versions, not this app's internals.
3. Copying that artifact to a second install and doing nothing else produces the
   same tools there.
4. Consuming somebody else's stack is copying their artifact plus one act of
   approval by the receiving operator.

**Not met by** a row typed into a form, by anything whose meaning depends on
state held only in this install's database, or by an instruction sequence
somebody has to re-type. See assumption A2 below, which is what this
requirement rests on.

**Borderline, and the design must rule on it:** a line in `.env` satisfies 1 and
3 and arguably 2, and fails 4, because `.env` is one file for the whole install
and merging two operators' lines is a text edit rather than an act of
consumption. `UF_PY_TOOLS` (`docs/install.md:192`) is exactly this case and is
the closest thing the tree has to a stack today.

### R3. An installed tool reaches every run, including sandboxed runs and every kind of agent child

**Met when**, for each child kind enumerated in
[00-problem.md](00-problem.md), all three links hold:

1. the binary exists on disk after a rebuild (R4);
2. it is on that child's `PATH`;
3. **the child is permitted to invoke it.**

Link 2 is already true for anything on `PATH`: `childEnv` copies the server's
environment and strips prefixes and named keys, and `PATH` is on neither list
(`src/lib/orchestrator.ts:5698-5716`), with the docblock saying so by name:
*"Everything else passes through. The CLI needs PATH, HOME, CLAUDE_CONFIG_DIR,
proxy and CA settings, and locale to function at all"*
(`src/lib/orchestrator.ts:5628`).

**Link 3 has never been measured and R3 cannot be declared met until it is.**
A work cycle runs `acceptEdits` (`src/lib/settings.ts:940`), and this tree has
measured that mode refusing commands twice: one run tried to commit *"seven
times, in five phrasings, and was refused every time"*
(`src/lib/cycleInvocation.ts:605-614`), and *"19 of 58 completed resolutions,
$109.94 of $233.85, say in their own report text that they could not compile or
test what they had merged"* (`src/lib/settings.ts:386-392`). Neither measurement
is of an arbitrary unknown binary, so whether `terraform version` passes where
`git commit` does not is **assumed either way** and the probe in
[07-option-make-it-runnable.md](07-option-make-it-runnable.md) §10 costs one
work cycle.

**"Sandboxed runs" resolves to six different things** and only two of them bear
on this; [00-problem.md](00-problem.md) enumerates them. The one that bites is
`UF_SANDBOX=1`: a write config of any kind makes the CLI bind `/` read-only and
rw-bind only the allow set (`src/lib/orchestrator.ts:5310`), and that set is
the run's cwd plus `BUILD_CACHE_DIRS`, which is two entries,
`$HOME/.npm` and `$GOPATH` (`src/lib/orchestrator.ts:5327-5330`). **No tool
state directory is in it.** So R3 under a sandbox is a requirement about the
write set, not about `PATH`.

**How to test it:** a run at each permission mode asked to invoke the tool, and
the log read for a refusal. Until that exists, R3 is open.

### R4. It survives `docker compose up --build`, and `down -v` is answered separately

These are two events and this requirement deliberately splits them, because the
existing volumes answer them differently and folding them together is how the
tree's own record got vague.

**R4a, `docker compose up --build`. Met when** every tool a stack declares is
present and runnable after the rebuild with no operator action. This is the
operator's stated problem and it is the event the three existing volumes were
created for. The compose file states the failure it is avoiding in the language
of the symptom: an extension in the writable layer *"works until the next
upgrade and is then simply gone — and what an agent sees at that point is
`unknown command`, inside a tool call nothing here reads, which the run loop
files as the agent choosing not to use it"*
(`docker-compose.yml:450-453`).

**R4b, `docker compose down -v`. Met when the design states, in writing, which
of these it is** and the app says the same thing:

- the tools are **reinstalled from the declaration**, because the durable thing
  is the declaration and the volume is a cache; or
- the tools are **gone**, and the operator is told they are gone rather than
  discovering it inside a tool call.

Both are acceptable. Silence is not. `down -v` is the harder half because
**nothing backs up a named volume**: `scripts/backup-db.mjs` writes one file, a
snapshot of the database into the `/backups` bind mount
(`docs/backup-and-restore.md:15`, `:122`), and the compose file describes `down -v`
as *"the correct treatment of a cache and the reason backups are not here"*
(`docker-compose.yml:443-444`). A toolchain volume would be the first thing this
app holds that is in neither the image, nor git, nor the host, nor the database.

**Evidence status: R4 has never been observed for any existing tool volume.**
`grep -n "UF_PY_TOOLS\|UF_GH_EXTENSIONS\|usagefoundry-pytools\|gocache" docs/verification.md`
returns **zero lines** at `6c5af5f`. The three volumes are pinned only by unit
tests over file *contents*, at `src/lib/deployment.test.ts:905`, `:978` and
`:1137`. Docker is unavailable in this container, so every persistence statement
in this directory is **assumed** from the compose file's own claims and Docker's
documented semantics. Part 3 has the commands a human with Docker would run.

### R5. The app can report what is installed and whether the install succeeded

**Met when** a surface in this app names, per declared tool:

1. that it is declared;
2. the outcome of its install, carrying the failure text when it failed;
3. whether the tool has ever been observed to run.

Point 3 is separate from point 2 on purpose, because R3's third link can fail
after a perfectly successful install, and the honest rendering of a tool nobody
has seen run is not `installed`.

**Today none of this exists.** `ls src/app/api/` returns 27 entries, 26 of them
route directories, and none is `tools` or `stacks`;
`grep -rn "UF_PY_TOOLS\|UF_GH_EXTENSIONS" src/` returns **no reader**: ten lines
in two files, one docblock mention in `src/lib/contextPruning.ts:99` and nine in
`src/lib/deployment.test.ts`, none of them a read.
An operator learns whether an install worked by
reading the container's boot log for `[usagefoundry] installed Python tool`
(`docker-entrypoint.sh:297`) or the `could not install` line beside it
(`:306-307`). That is the whole read-back.

**This requirement carries the directory's own strongest finding and it survives
the decision unchanged:** a tool that is absent fails inside a tool call nobody
reads. The number is in the tree: *"Measured on one install here: 213 sessions
told a plugin was active against a command that was never present"*
(`.env.example:245-249`), because *"hook bodies end in `|| true`, so the hook
exits 0 having done nothing"* (`:246-247`). The asymmetry that ranks R5 against
R1 is that **an install that fails costs a boot log line an operator is
watching, and a tool that is absent costs billed tokens on every cycle of every
run that needed it, discovered by nobody.**

---

## Part 2. Constraints this tree imposes

These are not negotiable by the design and none of them was invented for this
file. Each fails **silently** if broken: nothing throws, nothing fails to
typecheck, and the page looks right.

### C1. The volume-masking trap

**A named volume takes its contents from the image exactly once, at creation.**
A file written into an image path that is also a volume mount point is masked by
whatever the existing volume already holds, on every install that has run
before. Written down in the tree at the place that had to work around it:

> that path is a named volume, and a volume takes its contents from the image
> exactly once, at creation. An install written there during a build is masked
> by whatever the existing volume already holds — which is precisely the
> "installed by hand, lost on rebuild" failure this is meant to end.
> `Dockerfile:303-309`, pinned by `src/lib/deployment.test.ts:1137`

**Consequence for the design.** Anything that ships a default set in the image
*and* lets a stack add to it **at the same path** is broken on every existing
install and correct on a fresh one, which is the worst available failure,
because the person testing it has a fresh install. The image's contents and a
stack's contents go at different paths, or the image half never upgrades.

### C2. `childEnv` strips `UF_*`, so a stack cannot be named to a child by a `UF_` variable

`childEnv` (`src/lib/orchestrator.ts:5698-5716`) copies the server's whole
environment, sets `FORCE_COLOR=0`, and deletes three prefixes and six names:

```
UF_*   OTEL_*   __NEXT_*
ANTHROPIC_ADMIN_KEY   OPENAI_API_KEY   CODEX_API_KEY
CLAUDE_CODE_ENABLE_TELEMETRY   DATA_DIR   NODE_OPTIONS
```

So a design shaped "`UF_STACK_DIR=/opt/stacks`, and the agent's tooling reads
it" does not work: the child never sees it. A `UF_` variable can be read by
`docker-entrypoint.sh`, which runs before `exec` and is not subject to the
strip, or by the server; the result reaches a child as `PATH`, as some
non-`UF_` variable, or as a file on disk.

**Correction to this directory's own earlier claim.** Files `09-`, `10-` and
`11-` describe a `terminalEnv()` and argue about whether its strip list is five
or six names. **There is no `terminalEnv` in `src/`** (`grep -rn "terminalEnv"
src/` returns nothing); it was this survey's invented name for a function it
proposed. The real list is `childEnv`'s above, it is nine conditions rather than
six, and `OPENAI_API_KEY`, `CODEX_API_KEY` and `__NEXT_*` joined it after the
survey closed.

### C3. The uid split decides ownership, and which rule applies depends on who invokes the binary

The container runs as root, `user: "0:0"` (`docker-compose.yml:64`), and agent
children are dropped to `UF_AGENT_UID:UF_AGENT_GID`, which compose fills from
`${UF_UID:-1000}` / `${UF_GID:-1000}` (`docker-compose.yml:280-281`).

Both existing install loops run under
`setpriv --reuid --regid --clear-groups` (`docker-entrypoint.sh:147`, `:218`),
because an agent must be able to remove or upgrade what it runs. The opposite
decision is taken for the one binary the *run loop* invokes rather than the
agent:

> Root-owned and 0755: every agent uid reads it, none writes it. A tool the run
> loop shells out to on every cycle boundary, sitting in a directory a sibling
> agent could rewrite, would be a way for one run to put its own code on every
> other run's transcript.
> `Dockerfile:311-314`

**Consequence.** A design that ships one directory for both kinds of tool must
say which rule it takes. Reading and executing a root-owned 0755 file is not the
problem; upgrading and removing it is.

There is a live instance of the hazard already: `/home/node/pytools/bin` is on
the **server's** `PATH` and is agent-writable, which
`src/lib/contextPruning.ts:98-99` names and works around by resolving an
absolute interpreter rather than a name. Any new stack directory that lands on
`PATH` for a root process inherits it, and the mitigation is the same:
absolute paths, never names.

### C4. No agent-writable toolchain under `/data`

`/data` ships root-owned 0700 and the entrypoint reclaims it on every boot. The
compose comment states the corollary for a tool volume directly: not inside
`/data`, which *"is root-owned 0700 precisely to keep the agents out — while this
is the one directory they must be able to write"*
(`docker-compose.yml:440-444`). Confirmed from inside this container:
`ls -la /data` returns `Permission denied`.

### C5. Namespaces are denied at both seccomp settings

Docker gates the namespace and mount family behind `CAP_SYS_ADMIN`, this
container holds no capabilities, and the compose file records the measurement:
plain `unshare -U` *"needs no privilege on a stock kernel"* and fails here
(`docker-compose.yml:534`). The profile
itself ships **commented out** at `docker-compose.yml:567-568`, so a stock
install runs Docker's default profile, which also allows `execve`. So an
operator-installed binary runs; a tool that wants to build its own container,
chroot or sandbox, and several "stack" tools do, fails here in a way no volume
fixes. **Not re-measured by this run; quoted from the compose file's own
record.**

### C6. A tool's own state is a separate persistence problem from its binary

`$HOME` is `/home/node` for the server and for every child alike
(`Dockerfile:47`), and exactly four subdirectories of it are persistent:

| Path | What it is | Survives `up --build`? |
|---|---|---|
| `/home/node/.claude` | bind mount of the operator's own `~/.claude` | yes, and it is the **host's** file |
| `/home/node/go` | `usagefoundry-gocache` (`docker-compose.yml:445`) | yes |
| `/home/node/.local/share/gh` | `usagefoundry-gh` (`:459`) | yes |
| `/home/node/pytools` | `usagefoundry-pytools` (`:471`) | yes |
| everything else under `/home/node`: `.npm`, `.cache`, `.config`, `.terraform.d`, `.aws`, `.kube` | writable layer | **no** |

Terraform downloads providers, `kubectl` reads a kubeconfig, `mise` keeps a tool
registry, `npm` keeps a cache, and all of them default to `$HOME`. A stack that
ships a binary and not that relocation ships half a tool, and the operator's
symptom is a slow work cycle rather than an error. Every image-level answer
already in the tree does the relocation explicitly:
`UV_TOOL_BIN_DIR` under `/home/node/pytools` (`Dockerfile:283`), Playwright
browsers to `/opt/playwright/browsers` (`Dockerfile:500`), winnow's state out of
`$HOME` (`src/lib/contextPruning.ts`).

`/home/node/.claude` carries its own warning and `.env.example` already makes
it: a tool that *"wires itself in globally" on first run edits your machine's
settings* (`.env.example:304`), which is the **host's** Claude Code settings for every session on the machine, not just this
app's.

### C7. Four invariants from `CLAUDE.md` that a stack mechanism could break silently

- **`createRun` runs from entry to INSERT with no `await`**
  (`CLAUDE.md:49` routes to `docs/agent/concurrency-and-ownership.md`).
  Anything that probes for a tool, stats a volume or shells out during admission
  puts two agents in one directory. A "which stack does this run need" check
  belongs anywhere but there.
- **Two flags ride every cycle's argv because `--resume` restores neither**,
  `--plugin-dir` and the `--append-system-prompt` notice (`CLAUDE.md:48`). A
  design that tells the agent about the stack in a system-prompt notice is
  editing a **cached prefix**: `runs.file_cost_notice` is generated once at
  `createRun` and never rebuilt at a spawn, because text differing between two
  cycles of one run would cold-start a large context. Any generated notice about
  installed tools inherits that rule.
- **`--add-dir` grants write, and a stored path is proved contained in a mount
  again at use time**, because what an enabled plugin becomes is *"a directory
  whose hooks the container executes"* (`docs/agent/architecture.md:59`, routed
  from `CLAUDE.md:53`). **A stack directory reachable by `--add-dir` is a stack
  directory an agent can rewrite.**
- **Never a shell.** The agent is spawned with an argument array and
  `stdio: ["ignore", "pipe", "pipe"]`, **never a shell**, so prompt
  metacharacters are inert (`docs/agent/security.md:14`, routed from
  `CLAUDE.md:59`). Any install surface that takes operator text and runs it
  answers to this line, and the only shape that never has to argue with it is a
  closed verb list with constant argv templates.

### C8. A new `UF_` variable the entrypoint reads must land in four files in one commit

`.env.example`, `docker-compose.yml`'s `environment:` block,
`docker-entrypoint.sh`, and `src/lib/deployment.test.ts`. Compose has no
`env_file`, so a variable in `.env` that the `environment:` block does not name
never reaches the container at all, which is the trap `UF_LOCK_CLAUDE_HOME` was
caught by: *"a security control switched on in a file,
never applied, and indistinguishable from one that is off"*
(`docker-compose.yml:219`). `src/lib/deployment.test.ts:1377`'s
`it("forwards every variable the entrypoint reads and nothing else supplies")`
is what makes forgetting one of the four loud, and `:863` and `:884` carry the
reasoning.

**Read against R1:** this constraint applies to the *mechanism*, once. If it
applies every time a tool is added, R1 is not met.

### C9. The left menu has nine digits and eleven rows, and the loss is taken from the bottom

**This directory's claim that "there is no room on the left menu" is stale and
the tree now contradicts itself about it.** `src/components/shell/panes.ts:14-20`
says *"**Nine is the ceiling** — ⌘1…⌘9 is nine digits and the list is eleven
rows — so the last **two** rows have no digit at all"*, and names them: API account and
Settings, *"because Taskboard went in under Runs and pushed everything below it
down one."* `docs/agent/ui-density-audit.md:159-163` still bans **an eleventh**
pane on the ground that it would be *"the second row you cannot reach from the
keyboard"*, and gives the alternative: *"New destinations are sub-routes under
an existing pane."*

So: eleven rows exist, the ban's stated price has already been paid once, and
the doc is stale by one pane. **The design run should not assume a new pane is
impossible, and should not assume it is free either.** A sub-route under an
existing pane is what the doc asks for and costs no digit.

### C10. Nothing here turns a sandbox on

*"Nothing here turns a sandbox on. This app configures none"*
(`src/lib/sandbox.ts:8-9`). `UF_SANDBOX` is read only by
`docker-entrypoint.sh:362` and ships off. A "sandboxed run" on a stock install
is a run in a git worktree under `acceptEdits`, sharing a uid, a `$HOME`, a
`PATH` and a filesystem with every other run. R3's "including sandboxed runs" is
therefore **not two cases today**, and becomes two cases only in the one
configuration where a tool's write path breaks (C6, and
`src/lib/orchestrator.ts:5310`).

---

## Part 3. Assumptions this specification carries

Stated so that a later run can find out they were wrong, rather than inheriting
them silently.

### A1. "Without modifying the published container" means the shipped image stays as published and a stack layers on top at boot or run time

It does **not** mean the image may never be rebuilt. A `docker compose up
--build` that rebuilds the same published `Dockerfile` unchanged is fine; what
R1 forbids is the *edit*.

**What changes if this is wrong, in either direction.**

- If the operator meant something stricter, that no image is ever built at all,
  then anything at build time leaves the running, including
  [05-option-image-is-the-stack.md](05-option-image-is-the-stack.md)'s
  `Dockerfile.stack`, and only a boot-time or run-time installer qualifies.
- If the operator meant something looser, that editing this repository's own
  `Dockerfile` is acceptable as long as the *published* artifact is not
  republished, then R1 is not a constraint at all and the whole directory
  reopens, because the status quo measured in
  [00-problem.md](00-problem.md) already satisfies it.
- **The live tension:** `05-`'s form builds a derived image `FROM
  usagefoundry:latest`, which layers on top of the shipped image without editing
  it, but does so at **build** time rather than at boot or run time. A1 as
  written says boot or run. The design run has to rule on whether build-time
  layering counts, and that ruling decides whether `05-` is the answer or is out.

### A2. "Modular and easy for others" means a stack is a unit someone can publish and another operator can consume, not a row typed into a form

The unit is the artifact, and the app's job is to consume it. This is what R2
tests.

**What changes if this is wrong.** If the operator meant a form in the app, with
the stack living in this install's database, then R2 collapses into the stacks
table of [16-option-stack-table.md](16-option-stack-table.md), the "easy for
others" half becomes a statement about this app's UI rather than about the
artifact, and R4b gets harder rather than easier, because `.env` survives
`docker compose down -v` and a database on a volume does not.

---

## Part 4. What could not be reached, and the commands that would reach it

Every item here is a claim this directory makes on documentation and code rather
than on observation. A human with Docker runs these, in this order.

1. **That anything survives `docker compose up --build`.** Nothing in this
   directory has watched a volume outlive a rebuild, and `docs/verification.md`
   records nothing about any of the three.
   ```bash
   docker compose -p ufstack up -d --build
   docker compose -p ufstack exec -T usagefoundry sh -c \
     'echo hi > /home/node/pytools/bin/probe && echo hi > /home/node/probe-writable-layer'
   docker compose -p ufstack up -d --build --force-recreate
   docker compose -p ufstack exec -T usagefoundry sh -c \
     'ls /home/node/pytools/bin/probe /home/node/probe-writable-layer'
   #   expected: the first exists, the second is gone
   docker compose -p ufstack down -v
   #   then repeat the build and check which tools came back
   ```
   The last two lines are R4b and are the half this directory has never
   separated out.
2. **That C1 is real on this engine.** Add a `RUN touch
   /home/node/pytools/bin/from-image` to the Dockerfile, rebuild against an
   *existing* volume, and check whether the file is visible. The repository
   asserts it is not (`Dockerfile:303-309`).
3. **R3 link 3, which is the single most decisive unknown in this directory.**
   Install `ruff` via `UF_PY_TOOLS`, start a run at `acceptEdits`, ask it to run
   `ruff --version` and `ruff check .`, and read the log for a refusal. Four
   outcomes and each decides a different thing;
   [07-option-make-it-runnable.md](07-option-make-it-runnable.md) §10 has the
   recipe. **It costs one work cycle and no design should be finalised without
   it.**
4. **That a boot-installed binary is executable by the agent uid.**
   `docker compose exec -T -u "$(docker compose exec -T usagefoundry printenv UF_AGENT_UID)" usagefoundry sh -c 'command -v <tool> && <tool> --version'`,
   and note that the uid must be read out of the container rather than taken
   from `${UF_UID:-1000}` in the operator's own shell, because `.env` is
   compose's input rather than an exported environment
   (`docs/install.md:44-50`).
5. **That the seccomp profile is accepted and a new binary still runs under it.**
   Uncomment `docker-compose.yml:567-568` and repeat 4.
6. **Anything about a real stack tool.** No Terraform, no `mise`, no `asdf`, no
   `apt-get` has been run anywhere in this directory.

Two questions are not about the tree at all, cost a sentence each, and settle
more than any command above. **Neither has been asked in four runs.**

- **Does the operator have host access to the container?** If not, every
  argument resting on `docker compose exec` collapses.
- **What are the five commands they expect to type?** If the answer is
  `apt-get`, a login, or a two-step install, a declarative unit is answering a
  smaller question than the one being asked.

---

## The fixed heading list

This list governed the seventeen option files in this directory and it now
governs the design. **A design document answers these ten headings, in this
order, under these names**, and each of R1 to R5 maps onto one or more of them,
named in brackets. A heading with nothing to say gets "Nothing" under it rather
than being dropped.

1. **The strongest case** for the shape chosen, written as its advocate would
   write it, with no hedging.
2. **Shape** [R1, R2] which files, which variables, which volumes, which lines
   of `src/`; and what a stack artifact literally looks like.
3. **What persists it, and what discards it** [R4a, R4b] the two events stated
   separately, plus whether `scripts/backup-db.mjs` covers it.
4. **Reach** [R3] which of the kinds of child sees the tool, named one by one,
   and what carries it there: `PATH`, `childEnv`, the agent uid, an `--add-dir`.
5. **Tool state, not the binary** [R4, C6] where the tool's own cache, config,
   plugin directory and credentials land, and whether that persists on the same
   terms as the executable.
6. **What it does to the boundaries** [C3, C4, C5, C7, C10] which it crosses,
   and what it hands an agent that the agent did not have.
7. **The operator's surface** [R2, R5] what they configure and where, what a
   restart does with it, and how they change or remove a tool once installed.
8. **How it fails, and whether loudly** [R5] every silent failure mode named.
   The bar is `.env.example:245-249`: a missing command inside a `|| true` hook
   body is a plugin reporting itself active against a command that was never
   present, 213 times.
9. **What it costs to build** files touched, whether `deployment.test.ts` grows,
   whether any `docs/agent/` invariant moves, and whether the work is a day, a
   week or longer.
10. **What would have to be true** the single fact that would confirm the design
    and the single fact that would kill it, both stated as something somebody
    could go and check.
