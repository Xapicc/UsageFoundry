# The mechanism

**This is the design.** It answers the ten fixed headings of
[01-constraints.md](01-constraints.md) in the order that file fixes, under the
names it fixes, and it decides rather than compares. The stack artifact itself
is specified in [01b-stack-format.md](01b-stack-format.md); the reach and
permission argument is [01c-reach-and-permission.md](01c-reach-and-permission.md);
what stays in the image and what this design refuses to do are in
[01d-boundaries.md](01d-boundaries.md).

Checked against the tree at `baf051d`. **This container has no Docker**, so every
claim about what survives a rebuild is reasoned from `docker-compose.yml`'s and
`docker-entrypoint.sh`'s own statements and says "assumed" where it is assumed.

---

## 1. The strongest case

A stack is a directory holding one `stack.json`. It lives on the operator's own
machine, in `./stacks/` beside `docker-compose.yml`, and it reaches the container
through a read-only bind mount that the compose file gains **once**. At boot,
before the server starts, an applier reads every stack, installs what each one
declares into a named volume, links the binaries it names into one root-owned
`bin` directory that is already on `PATH`, and writes a receipt saying what
happened.

Everything the request asks for falls out of that sentence.

**Without modifying the published container** is met because the artifact is on
the host and the mount already exists: the twelfth tool costs one directory
copied into `./stacks/` and a restart, and touches no file the image contains.
**Modular** is met because the unit is a directory, not a row: it has a name, a
version, its own state, its own environment and its own permission grants, and
nothing about it refers to this app's internals. **Easy for other people** is met
because consuming somebody else's stack is `cp -r their-terraform ./stacks/` and
`docker compose up -d`, which is one copy and one act of approval, and because
the same directory copied to a second install produces the same tools there.

It survives `docker compose up --build` because the volume is not the writable
layer, and it survives `docker compose down -v` in the only way that can be
honest: the volume dies, the declaration does not, and the next boot reinstalls
from the declaration. **The declaration outliving the volume is the property this
design is built around**, and the compose file already argues for it in its own
words about the backups bind: *"a snapshot kept inside the volume dies with
`docker compose down -v`, which is the command this whole path exists to
survive"* (`docker-compose.yml:489-491`).

And it is the only shape in this directory where an agent cannot rewrite what
gets installed. The read-only mount is a kernel flag, not a sentence: root inside
the container cannot write it either. `18-option-repo-manifest.md` reached the
same artifact and held the boundary shut with one sentence, that *"the changed
manifest is inert until a human approves it"* (`18-`:127). Here the boundary is
the host filesystem, which is the same boundary that already protects `.env` and
`docker-compose.yml` themselves.

---

## 2. Shape [R1, R2]

### 2.1 The two paths, and why they are two

| | Container path | What it is | Who writes it |
|---|---|---|---|
| Declarations | `/etc/uf-stacks` | read-only bind of the host's `./stacks` | the operator, on the host, only |
| Artifacts | `/var/lib/uf-stacks` | named volume `usagefoundry-stacks` | the applier, at boot, only |

They are two paths because `C1` says they must be. A named volume takes its
contents from the image exactly once, at creation, so anything the image ships at
a volume's mount point is masked on every install that already exists and visible
only on a fresh one (`Dockerfile:302-309`). **The image ships nothing under
`/var/lib/uf-stacks`, ever**, and §9 puts a test on that sentence so breaking it
is loud rather than silent.

`/var/lib` rather than `/opt` is deliberate. `Dockerfile:308` states the
invariant this design must not break: *"`/opt` is in the image layer, so a
rebuild is the only thing that can change it."* A volume under `/opt` would make
that sentence false. `/var/lib` is where this repository already puts a named
volume for exactly this reason: `usagefoundry-winnow` is mounted at
`/var/lib/winnow` (`docker-compose.yml:486`, volume declared at `:719`).

### 2.2 Inside the volume

```
/var/lib/uf-stacks/
  bin/                     root:root 0755   every linked binary, one flat directory
  pkg/<stack>/             root:root 0755   what the stack unpacked or installed
  state/<stack>/           agent uid 0775   the tool's own cache, plugins, config
  receipts/<stack>.json    root:root 0644   what the applier did and what happened
```

`bin/` is root-owned and agent-readable, and that is the opposite of the
decision the two existing install loops take. Both of those run under
`setpriv --reuid "$UF_AGENT_UID"` (`docker-entrypoint.sh:147`, `:218`), and
`src/lib/deployment.test.ts:1045` pins the reason: *"installs as the uid that
will run them, never as root"*, so an agent can remove or upgrade what it runs.

This design takes the other rule, the one the Dockerfile applies to the one
binary the **run loop** invokes:

> Root-owned and 0755: every agent uid reads it, none writes it. A tool the run
> loop shells out to on every cycle boundary, sitting in a directory a sibling
> agent could rewrite, would be a way for one run to put its own code on every
> other run's transcript.
> `Dockerfile:311-314`

The reason it applies here and not there is §2.3: `bin/` goes on the **server's**
`PATH`, and the server runs as root (`docker-compose.yml:64`, `user: "0:0"`).
`/home/node/pytools/bin` is already on that `PATH` and is already agent-writable,
which `src/lib/contextPruning.ts:98-99` names and works around by resolving an
absolute interpreter rather than a name. **One live instance of that hazard is
one too many and this design will not add a second.** The cost is that an agent
cannot upgrade a stack tool, which is correct rather than a loss: upgrading is an
operator act, and an agent upgrading a tool is undeclared drift by definition.

`state/` is agent-owned because the tools write there. Sharing it between
concurrent runs adds no isolation this install has: `C10` records that nothing
here turns a sandbox on and a run already shares a uid, a `$HOME`, a `PATH` and a
filesystem with every other run (`src/lib/sandbox.ts:8-9`).

### 2.3 What reaches the container, and the one-time cost

**One change now, none per tool.** Six files change once, in a commit that names
no tool. Nothing in the list below is ever touched again to add a tool.

| File | The one change | Why it can only go here |
|---|---|---|
| `docker-compose.yml` | one mount, `${UF_STACKS_DIR:-./stacks}:/etc/uf-stacks:ro`, and one named volume `usagefoundry-stacks:/var/lib/uf-stacks` | the door itself, and it is not in the image |
| `Dockerfile` | one `ENV PATH="/var/lib/uf-stacks/bin:${PATH}"`, and `scripts/apply-stacks.mjs` added to the `COPY` at `:570` | `PATH` must be final before the server starts (§4) |
| `docker-entrypoint.sh` | one block that runs the applier before `exec "$@"` (`:1223`) | the applier is root and must precede the server |
| `scripts/apply-stacks.mjs` | new, the applier | — |
| `src/lib/stacks.ts` | new, reads the receipts | R5's data, not its surface |
| `src/instrumentation.ts` | merge the applier's env file into `process.env` | §5 |

Plus the two-line projections in §4: one append in `src/lib/cycleInvocation.ts`
and one entry in `BUILD_CACHE_DIRS` at `src/lib/orchestrator.ts:5327-5330`.

**R1 is met**, and `01-constraints.md`'s own note is what licenses this list:
*"Whatever carries a stack may itself be built into the image once, in a commit
that names no tool. R1 is about what the twelfth tool costs, not the first."*
The `git diff --name-only` over the commit that adds Terraform is one line:
`stacks/terraform/stack.json`, and it is not in the image.

### 2.4 Why a bind mount and not `/workspace`, a `UF_` list, or a derived image

`/workspace` is already mounted and needs no compose change at all, and the app
already claims a hidden sibling directory inside it: `WORKTREE_STORE_DIR` is
`.uf-worktrees`, dot-prefixed so `/api/folders` never offers it as a run target
(`src/lib/orchestrator.ts:2360-2400`). It is rejected because **agents write
there**. A stack declaration an agent can edit is a way for one run to install
software into every later run, and no sentence fixes that.

A widened `UF_*` list, which is `02-option-widen-the-existing-lists.md`, is
rejected on R2's fourth test, exactly as `01-constraints.md` predicts: `.env` is
one file for the whole install, so merging two operators' lines is a text edit
rather than an act of consumption, and a line has nowhere to put a checksum, an
environment block or a permission grant.

`05-option-image-is-the-stack.md`'s `Dockerfile.stack` is **ruled out**, and this
is the ruling `README.md` asks for first. `A1` says a stack layers on at boot or
run time; a derived image layers at build time, which means every operator who
adds a tool builds an image, which means the pulled-image install in R1's test
(*"an install started from `docker compose pull` rather than `docker compose up
--build`"*) cannot add a tool at all. That is the requirement failing on its own
stated test, not a preference. What survives from `05-` is its instinct that the
unit should be a file a third party hands you, and that is what `stack.json` is.

### 2.5 What a stack looks like

Fully specified in [01b-stack-format.md](01b-stack-format.md), with the Terraform
example written out as an author would write it. In one line: a directory under
`./stacks/`, named for the stack, holding `stack.json`, which declares a name,
install steps drawn from a closed set of three verbs, the binaries to link, the
environment to export, the state directories to create and the shell commands a
work cycle may run.

---

## 3. What persists it, and what discards it [R4a, R4b]

**Assumed from the compose file and Docker's documented volume semantics. This
container has no Docker and nothing below has been observed.** The commands that
would observe it are `01-constraints.md` Part 4, item 1, unchanged.

**R4a, `docker compose up --build`: met, and without a network.** `./stacks` is a
host directory, so the declarations are not in the container at all. Both mounts
are outside the writable layer, so the rebuild does not touch them. On the next
boot the applier finds a receipt whose digest matches the declaration and whose
status is `ok`, and does nothing. A rebuild therefore costs no download, which
matters because the failure the operator reported is a rebuild handing an agent
`command not found`, and a design that re-downloads on every rebuild converts
that into the same symptom whenever the network is slow, rate-limited or down.

**R4b, `docker compose down -v`: answered with the first of the two options
`01-constraints.md` allows.** *The tools are reinstalled from the declaration,
because the durable thing is the declaration and the volume is a cache.*
`down -v` destroys `usagefoundry-stacks` along with `usagefoundry-data`,
`usagefoundry-gocache`, `usagefoundry-gh`, `usagefoundry-pytools` and
`usagefoundry-winnow` (`docker-compose.yml:714-719`); it destroys no bind mount,
so `./stacks` is untouched, and the next `docker compose up -d` reinstalls every
stack from scratch. This is the treatment the compose file already prescribes for
a cache: *"the correct treatment of a cache and the reason backups are not
here"* (`docker-compose.yml:443-444`).

The one thing the operator loses across `down -v` is time and bandwidth, and they
are told: the boot log names every stack it is installing, and the receipts are
rewritten with fresh timestamps.

**`scripts/backup-db.mjs` does not cover it, and must not.** It writes one file, a
snapshot of the database into the `/backups` bind mount
(`docs/backup-and-restore.md:15`, `:122`). Backing up `/var/lib/uf-stacks` would
be backing up a cache, and backing up `/etc/uf-stacks` would be backing up a
read-only copy of a host directory the operator already has. `01-constraints.md`
observes that a toolchain volume *"would be the first thing this app holds that is
in neither the image, nor git, nor the host, nor the database"* - under this
design it is not, because the thing that matters is on the host and can be put in
git.

The bind mount's shape copies `/backups` deliberately, including its default:
`${UF_BACKUP_DIR:-./backups}:/backups` (`docker-compose.yml:500`), with the
repository shipping an empty `backups/.gitkeep` so the default works with no
setup. `stacks/.gitkeep` is the same, and **the repository ships no example stack
inside `stacks/`** - the worked examples live in the docs, so there is never a
directory whose presence means "install this" that the operator did not put
there.

---

## 4. Reach [R3]

Argued in full, with the measurement that is still owed, in
[01c-reach-and-permission.md](01c-reach-and-permission.md). The result:

| Child | Mode | On `PATH`? | Permitted to invoke? |
|---|---|---|---|
| work cycle | `acceptEdits` | yes | **only if the stack declares the grant** (§4.2) |
| reviewer | `plan` | yes | no, and correctly so: the mode is read-only |
| conflict assist | `acceptEdits` | yes | only via the declared grant |
| chat turn | `bypassPermissions` | yes | yes, no grant needed |
| workflow orchestrator | `bypassPermissions` | yes | yes, no grant needed |

The child kinds, their spawn sites and their modes are
[00-problem.md](00-problem.md)'s table, unchanged.

### 4.1 `PATH`, which needs nothing new

`ENV PATH="/var/lib/uf-stacks/bin:${PATH}"` in the `Dockerfile`, beside the
identical line `ENV PATH="/home/node/pytools/bin:${PATH}"` at `Dockerfile:281`.
From there it reaches every child for free, because the env builders copy the
server's environment and strip prefixes and names that do not include `PATH`
(`src/lib/orchestrator.ts:5698-5716`), and the docblock says so: *"Everything
else passes through. The CLI needs PATH, HOME, CLAUDE_CONFIG_DIR, proxy and CA
settings, and locale to function at all"* (`src/lib/orchestrator.ts:5628`).

**This is already pinned by a test.** `src/lib/git.test.ts:88`,
`it("passes PATH through so a repo-local hook resolves")`, asserts
`assert.equal(env.PATH, process.env.PATH)` at `:96`. The `Dockerfile` half is
pinned too: `src/lib/deployment.test.ts:1029`,
`it("puts uv's launcher directory on the PATH a hook resolves through")`, which
is the same assertion one layer down and is the shape the new line copies.

The applier runs **before** `exec "$@"` (`docker-entrypoint.sh:1223`), which is
the whole reason `PATH` can be a constant rather than something the server
mutates. A run-time installer would have to add to `process.env.PATH` after some
children had already been spawned, and the two sets of children would then differ
in what they could resolve, silently. That is the decisive argument for boot-time
and it is repeated with three more in §6.

### 4.2 Permission, which needs one append

A work cycle runs `acceptEdits` (`src/lib/settings.ts:940`) and this tree has
twice measured that mode refusing commands. The authoritative statement is in the
code:

> `acceptEdits` auto-approves file edits and read-only shell, and holds mutating
> git for a human
> `src/lib/cycleInvocation.ts:605-614`

An arbitrary binary the CLI has never heard of is not read-only shell, so
**this design assumes the worse answer: the grant is required.** The repair is
the shape the argv builder already has. `cycleInvocation.ts:1190-1225` assembles
`--allowedTools` from `ISOLATED_GIT_TOOLS` and `SEARCH_TOOLS` and states the rule
in its own comment, that `--allowedTools` *names what skips the prompt, and
everything else still follows the mode*. A third list joins them, built from the
`allow` arrays of the receipts whose status is `ok`.

It is derived rather than written, so it is still one change and none per tool.
`01c-` gives the exact command that measures whether the grant was needed, and
says what to delete if it was not.

### 4.3 Under `UF_SANDBOX=1`

Reading and executing a binary outside the image is **unaffected**. The write
config binds `/` read-only and rw-binds only the allow set
(`src/lib/orchestrator.ts:5310`), and read-only is not unreadable; the
`denyRead` list the entrypoint writes into the managed settings is two entries,
`DATA_DIR` and `/backups` (`docker-entrypoint.sh:432`), and `/var/lib/uf-stacks`
is neither.

**Writing is where a path has to be added, and it is one path.** The rw-bind
allow set is the run's cwd plus `BUILD_CACHE_DIRS`, which is two entries,
`$HOME/.npm` and `$GOPATH` (`src/lib/orchestrator.ts:5327-5330`, applied at
`:5396` and `:5413`). `/var/lib/uf-stacks/state` joins it as a third. It is one
entry for the mechanism, not one per stack, because every stack's state lands
under it - which is the reason `state/` is one tree rather than a path each stack
chooses.

---

## 5. Tool state, not the binary [R4, C6]

`C6` is the constraint that makes a stack more than a download. `$HOME` is
`/home/node` for the server and every child alike (`Dockerfile:47`), and of its
subdirectories only `.claude`, `go`, `.local/share/gh` and `pytools` are
persistent; `.cache`, `.config`, `.terraform.d`, `.aws` and `.kube` are the
writable layer and do not survive a rebuild. A stack that ships a binary and not
the relocation ships half a tool, and the symptom is a slow work cycle rather
than an error.

**Every stack gets `/var/lib/uf-stacks/state/<stack>`, and relocating the tool
into it is a declared field rather than something the author is trusted to
remember.** `stack.json`'s `env` block names the variables, with `{state}`
expanding to that directory, and `state` names the subdirectories to create
before the first run - which exists because Terraform refuses to start when
`TF_PLUGIN_CACHE_DIR` names a directory that is not there. The worked example in
`01b-` uses both.

Three image-level answers in this tree already do the same relocation explicitly
and are the precedent: `UV_TOOL_BIN_DIR` under `/home/node/pytools`
(`Dockerfile:283`), Playwright's browsers to `/opt/playwright/browsers`
(`Dockerfile:500`), and winnow's state out of `$HOME` into `/var/lib/winnow`
(`docker-compose.yml:486`).

**How the env reaches a child, given `C2`.** `childEnv` deletes the whole `UF_*`
prefix (`src/lib/orchestrator.ts:5698-5716`), so nothing a stack sets may be
`UF_`-prefixed, and `01b-` refuses such a key by name at parse time rather than
letting it be set and vanish. Everything else passes through, so the applier
writes `/var/lib/uf-stacks/env` as `KEY=VALUE` lines and
`src/instrumentation.ts` merges it into `process.env` at server start, before any
child can be spawned. It goes through the server rather than through the
entrypoint because the entrypoint would have to `export` text that came from a
third party's file, and *"never a shell"* (`docs/agent/security.md:14`) is easier
to keep true if no generated text is ever handed to one.

**`state/` persists on exactly the same terms as the binary**: same volume,
survives `up --build`, destroyed by `down -v`. A tool that caches a gigabyte of
providers re-downloads them after `down -v`, which is the definition of a cache
and is stated in the read-back rather than hidden.

**`/home/node/.claude` is out of bounds for a stack.** `.env.example:304` already
warns that a tool which *"wires itself in globally" on first run edits your
machine's settings*, and that bind is the **host's** `~/.claude` for every
session on the machine (`docker-compose.yml:401`). `01b-` refuses an `env` value
that points into it.

---

## 6. What it does to the boundaries [C3, C4, C5, C7, C10]

**C3, the uid split: crossed deliberately, and §2.2 says which rule it takes.**
`bin/` and `pkg/` are root-owned so nothing an agent does can change what a later
run executes; `state/` is agent-owned because tools write there. Install steps do
**not** run as root: each step runs under
`setpriv --reuid "$UF_AGENT_UID" --regid "$UF_AGENT_GID" --clear-groups` into
`pkg/<stack>`, exactly as `docker-entrypoint.sh:147` and `:218` already do, and
only the final `chown -R root:root` and the `install -m 0755` link are root's.
So a third party's `npm` postinstall script never executes as root.

That staging directory is agent-owned while the applier works in it, which would
be a race at run time and is not one here: **the applier runs in the only window
in the container's life when no agent process exists**, between the entrypoint's
work and `exec "$@"` at `docker-entrypoint.sh:1223`. This is the second of the
four reasons the applier is boot-time only. The others are §4.1's `PATH`, §6's
next paragraph, and `C7`'s rule that `createRun` runs from entry to INSERT with
no `await`, so nothing that probes a volume or shells out may sit on the
admission path.

**The third reason, and it is the one that would be hardest to take back: an
installer inside the server is reachable from the network.** `/api/settings` is
reachable with the master key, which is why `src/lib/config.ts:494-508` keeps the
outbound webhook target out of `settings.json` and in the environment, with the
sentence that decides it here too: *"Here it takes a container restart, which is
a decision a person makes at a shell"*. An install endpoint would be a
remote code execution surface with the app's own authentication in front of it.
The entrypoint is reachable only by someone who can restart the container, which
is the same person who can edit `docker-compose.yml`.

**C4, `/data` 0700: not crossed.** Nothing in this design writes under `DATA_DIR`.
The compose comment already forbids it for exactly this purpose: not inside
`/data`, which *"is root-owned 0700 precisely to keep the agents out"*
(`docker-compose.yml:440-444`).

**C5, namespaces denied: not fixed, and named.** A stack whose tool wants to
build its own container, chroot or sandbox fails here whatever the volume does,
and no part of this design changes that (`docker-compose.yml:534`). `01d-` lists
it among the things this mechanism deliberately does not solve.

**C7's four invariants.** `createRun`: untouched, nothing here is on the
admission path. The two flags that must ride every cycle's argv: untouched, the
stack grant is appended to `--allowedTools`, which is already rebuilt per cycle
at `cycleInvocation.ts:1190-1225`, and **nothing about a stack is written into
the appended system prompt**, because `runs.file_cost_notice` is a cached prefix
generated once at `createRun` and text that differed between two cycles would
cold-start a large context. `--add-dir`: no stack path is ever passed to it, so
no stack directory becomes *"a directory whose hooks the container executes"*
(`docs/agent/architecture.md:59`). *Never a shell*: the applier builds argument
arrays; the three install verbs have constant argv templates with substitution
only into a single argument position; there is no `postinstall`, no `script`
field and no `run` verb, which is `11-option-allowlisted-installer.md`'s closed
verb list applied to the only surface that needs it.

**C10: unchanged.** This turns no sandbox on and reads no sandbox setting except
to add the one write path in §4.3.

**What it hands an agent that the agent did not have.** Exactly the binaries the
operator declared, plus the argv prefixes the operator's stack file declared, and
nothing else. It hands the agent no new write path: `bin/` and `pkg/` are
read-only to it, and `state/` is a cache directory the agent could already have
written somewhere in `$HOME`.

---

## 7. The operator's surface [R2, R5]

**The surface in the app is run 3's and is not designed here.** What is fixed
here is the data it reads and the acts it describes.

**What they configure and where.** A directory under `./stacks/`, on their own
machine, in their own editor. Optionally `UF_STACKS_DIR` in `.env` if they keep
stacks somewhere else, which is compose's variable and never reaches the
entrypoint, so `C8`'s four-files rule does not apply and this design adds **no**
`UF_` variable the entrypoint reads.

**What a restart does with it.** Every boot, the applier reconciles declarations
against receipts, in lexical order of directory name, and within a stack in the
file order of the `install` array:

- a declaration whose digest matches an `ok` receipt: nothing, no network;
- a declaration with no receipt, or whose digest differs: remove `pkg/<stack>`,
  install afresh, relink, rewrite the receipt. `state/<stack>` is **kept**, so a
  version bump does not throw away a provider cache;
- a receipt with no declaration: remove `pkg/<stack>`, `state/<stack>` and the
  links it owns, then delete the receipt. **The applier removes only paths its
  own receipts record**, so it can never delete something it did not install.

The digest is `sha256` over the bytes of `stack.json`. A narrower digest over
only the install steps would skip a reinstall when only `allow` changed, and it
is refused: the cost of the simple rule is one unnecessary download, and the cost
of the clever one is a binary that does not match its declaration with nothing
saying so.

**Ordering between stacks is lexical and there is no `depends_on`.** Two things
that must be ordered are one stack. A dependency graph is configurability for a
requirement that does not exist, and this repository already knows what one costs
to get right.

**Two stacks claiming the same binary name: both lose it, neither silently.** The
name is not linked, both receipts are marked `conflicted` and each names the
other. Letting the lexically first win would hand the operator a version they did
not choose with nothing to read; `docs/install.md:493-505` records this tree
taking the same view of an ambiguous mount, where a silent fifth slot was turned
into a refused boot. **This refuses the name and not the boot**, which is a
deliberate departure from that precedent: a mount is the app's subject, a stack
is an accessory, and losing an accessory must not lose the install.

**How they change or remove a tool.** Edit `stack.json` and restart, or delete
the directory and restart. There is no in-app removal, and there is no
`docker compose exec` step, so the design does not rest on the question
`README.md` lists third and nobody has asked - whether the operator has host
access to the container. It rests only on their having host access to the
directory holding `docker-compose.yml`, which they must have to run it.

**What R5 reads.** `/var/lib/uf-stacks/receipts/<stack>.json`, one per stack,
carrying the declared name, the digest, `ok | failed | conflicted`, the applied
timestamp, the binaries linked, the grants projected, the env exported, a
per-step status and, on failure, the last 4 KB of the step's stderr.
`src/lib/stacks.ts` reads and types them. That is R5's points 1 and 2.

Point 3, *whether the tool has ever been observed to run*, is deliberately not
the applier's: it comes from `run_events`, whose `kind` union already separates
`tool` from `tool_error` (`src/lib/apiTypes.ts:2194-2218`), and it is
`15-option-no-stack-object.md`'s `toolInventory.ts` carried forward whole,
including its honest rendering that a tool whose invocation has never been
observed reads `unverified` rather than `installed`. Under this design that
rendering earns a second meaning, because §4.2's grant can be missing while the
install is perfect, and `unverified` is exactly what that looks like.

---

## 8. How it fails, and whether loudly [R5]

The bar is `.env.example:245-249`: a missing command inside a `|| true` hook body
is a plugin reporting itself active against a command that was never present,
213 times. Every failure below is named, and each one says where it is visible.

| Failure | Visible where | Loud? |
|---|---|---|
| `stack.json` is not valid JSON, or fails the schema | boot log, receipt `failed` with the parse error | yes |
| directory name and `name` disagree | boot log, receipt `failed` | yes, and it is a refusal rather than a rename |
| download 404s, times out, or the host is unreachable | boot log, receipt `failed` with the curl exit code | yes |
| **checksum mismatch** | boot log, receipt `failed`, nothing unpacked, nothing linked | yes, and nothing downloaded is executed |
| an install step exits non-zero | boot log, receipt `failed`, **no binary from that stack is linked** | yes |
| two stacks claim one binary name | boot log, both receipts `conflicted` | yes |
| a stack declares a `UF_`-prefixed env key | refused at parse, receipt `failed` | yes; the alternative is `childEnv` deleting it and nobody knowing |
| a stack installs, but declares no `allow` | receipt `ok`, tool never observed to run | **this is the quiet one** |
| the operator never mounted `./stacks` | boot log says zero stacks, no receipts | yes, but only if they read it |
| a run needs a tool no stack declares | the agent's tool call fails | **no, and this design does not fix it** |

The two rows that are not loud are the two worth stating plainly.

**A stack that installs and grants nothing** is the one failure this design
creates. It looks perfect from the applier's side and fails inside a tool call
nobody reads, which is the exact shape `01-constraints.md` ranks R5 against R1
for. It is answered by R5 point 3 rather than by the applier: a receipt that is
`ok` with a non-empty `bin` and an empty `allow` is the specific state the
read-back must call out, and `01c-` says what to do with it if the measurement
comes back the other way.

**A run needing an undeclared tool** is not this design's problem and the
alternative is worse. `17-option-requirements-not-installs.md` proposed refusing
the run before it starts and concedes the point itself: *"the correct version of
this option is not a refusal but a warning on the run"* (`17-`:227). **A failed
or missing stack never blocks a run.** A run that will not start because an
unrelated stack could not download is a worse outcome than a run that fails at
one tool call, and the run loop has nowhere to put that refusal that an operator
would see sooner.

**The boot blocks while the applier works**, exactly as the two existing loops
already do. Each step gets a bounded timeout and prints a line before and after,
in the format the existing loops use (`[usagefoundry] installed Python tool
$entry` at `docker-entrypoint.sh:297`, `could not install` at `:306`). A first
boot with several stacks is slow; every later boot is a digest comparison and no
network at all.

---

## 9. What it costs to build

Six files changed once and two new ones, listed in §2.3, plus the two projections
in §4. `src/lib/deployment.test.ts` grows by three assertions, and `C8` is why
they are not optional:

1. the compose mount and the named volume exist and are spelled as the entrypoint
   and the `Dockerfile` expect, in the style of `:905`, `:978` and `:1137`;
2. `ENV PATH` carries `/var/lib/uf-stacks/bin`, in the style of `:1029`;
3. **the `Dockerfile` contains no path under `/var/lib/uf-stacks`** - the `C1`
   guard, which is the one assertion here whose absence fails silently on every
   install except the reviewer's fresh one.

A fourth test belongs to the applier rather than the deployment: the digest,
conflict and reconcile decisions are pure functions over a declaration list and a
receipt list, they have no observable failure mode short of the wrong software
being installed, and `CLAUDE.md` says a pure function whose failure mode is
silent gets a unit test. `docs/agent/testing.md` is the bar to read before
writing them.

**One `docs/agent/` invariant moves and one is added.** `docs/agent/architecture.md`
gains `scripts/apply-stacks.mjs` and `src/lib/stacks.ts` on the module map and the
sentence that the image ships nothing under `/var/lib/uf-stacks`;
`docs/agent/security.md` gains the trust statement in §10. `docs/install.md`
gains the operator's half, which is run 3's to write.

**Two to three days** for the applier, the plumbing and the tests. The read-back
surface is not counted here.

---

## 10. What would have to be true

**The single fact that would confirm it.** That a work cycle at `acceptEdits`,
handed `--allowedTools 'Bash(terraform version:*)'`, runs `terraform version` and
reports the output. That is R3's third link, the one `01-constraints.md` says
has never been measured, and the exact command is
[01c-reach-and-permission.md](01c-reach-and-permission.md) §4. If it passes, the
design is complete as written. If the grant turns out to be unnecessary, the
design is the same minus §4.2, which is a deletion rather than a redesign - which
is why it is built assuming the worse answer.

**The single fact that would kill it.** That the operator cannot write a
directory beside `docker-compose.yml`. The entire carrier is a host bind mount,
so an install where the compose file belongs to somebody else - a managed
platform, a registry image run by a deployment system, a machine the operator
reaches only through this app's own UI - has no door at all, and the design would
have to be rebuilt around something the app itself can write. This is question 3
of `README.md`'s open list, it is one sentence to the operator, and four runs of
this directory have named it decisive without asking it.

**Second, and cheaper to check:** that a named volume survives
`docker compose up --build` on the operator's engine. `01-constraints.md` Part 4
item 1 has the commands, `docs/verification.md` records nothing about any of the
five existing volumes, and **no volume in this repository has ever been observed
outliving a rebuild.** If it does not, the toolbox reinstalls from the network on
every rebuild and R4a degrades from "met" to "met when the network is up".
