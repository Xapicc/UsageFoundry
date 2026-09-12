# Persistent custom stacks

> **DECIDED: the feature is being built.**
> Decided by the operator on 2026-09-12, in the orchestrator chat. Their words:
> **it is not about whether we do it, it is about *how*.**
>
> **No file in this directory may re-argue whether.** The question from here is
> what a stack is, what installs it, and what must be true of the result. The
> requirement set is [01-constraints.md](01-constraints.md) and it is the
> acceptance criteria, not a survey.

## What is being built

A way to install new tools into UsageFoundry **without modifying the published
container**, with a mechanism that is **modular and easy for other people to use
for their own tools**.

That sentence supersedes the one this directory was opened on. The operator's
original phrasing asked for a Terminal pane on the left menu; the decision is
about the *mechanism*, and the surface was a later question. Both sentences are
quoted in [00-problem.md](00-problem.md).

**The surface is no longer later**: [01e-operator-surface.md](01e-operator-surface.md)
answers it, and the answer is **not a pane** - a `Tools` section on Settings plus
a sub-route for one stack's receipt, on the ban's own replacement sentence
(`docs/agent/ui-density-audit.md:162`). The original Terminal request is refused
in `08-terminal-problem.md` and nothing here reopens it.

## The five requirements

Each is stated in [01-constraints.md](01-constraints.md) with a met/not-met test
and the citations behind it. Summarised so nobody has to open the file to know
what is binding:

| | Requirement | The hard part |
|---|---|---|
| **R1** | Adding a tool edits no file inside the published image | **The central one. A design that fails it is out of the running.** It constrains the per-tool cost, not the mechanism's own |
| **R2** | A stack is a self-contained declarative unit a third party can author, copy and share | A line in a shared `.env` passes three of R2's four tests and fails the fourth |
| **R3** | An installed tool reaches every run, every sandboxed run and every kind of agent child | Link 3, permission to invoke, **has never been measured** and one work cycle settles it |
| **R4** | It survives `docker compose up --build`, and `down -v` is answered **separately** | `down -v` destroys a volume nothing backs up. Either answer is acceptable; silence is not |
| **R5** | The app can report what is installed and whether the install succeeded | A tool that is absent fails inside a tool call nobody reads, 213 sessions at a time |

**Whether the design meets them is checked one by one in
[01h-acceptance.md](01h-acceptance.md)**, with how each was checked. The result:
**R1 met**, **R2 met and one of its four tests was failing until this run's
validation pass**, **R3 not met** - two links of three settled, the third
designed around and never measured - **R4b met with R4a met in design and
unobserved**, and **R5 met in design**, which also did not meet its own
de-latching claim until `01a-` §7 gained a fourth reconcile rule. A criterion
that is not met is recorded as a finding there rather than softened here.

Plus the constraints the tree imposes, each with its citation, in
`01-constraints.md` Part 2: the volume-masking trap, `childEnv`'s strip list,
the uid split, `/data` 0700, denied namespaces, tool state versus the binary,
four `CLAUDE.md` invariants that fail silently, the four-files rule for a new
`UF_` variable, the left menu's nine digits against eleven rows, and the fact
that nothing here turns a sandbox on.

Two assumptions are carried explicitly and each names what changes if it is
wrong: **A1**, that "without modifying the published container" means the
shipped image stays as published and a stack layers on top at boot or run time,
not that no image may ever be rebuilt; and **A2**, that "modular and easy for
others" means a publishable unit rather than a row typed into a form.

## Why the request is real, measured

**The image was edited twelve times in the three weeks after this directory
closed saying the problem was mostly solved.**
`git log --since=2026-08-25T00:00:00 -- Dockerfile` returns 12 commits at
`6c5af5f`: eleven distinct changes, ten of them about a tool, among them `jq`,
a Codex CLI pre-install, a Playwright install repair and six version pins.

Six of the ten are dependency pins that R1 would not remove, and
[00-problem.md](00-problem.md) says so. **The two that are exactly the request
are `jq` and `codex`**, and the strongest evidence is not the count but the
comments: the Dockerfile makes the same argument three times, for three
different tools, in three writers' words, and every time it is R1's argument.

> In the image rather than installed by hand […] an `npm install -g` typed into
> a shell survives `docker restart` and is discarded by the `docker compose up
> --build` this project is deployed with, so what the next upgrade hands an
> agent is `codex: command not found` inside a tool call — which no part of the
> run loop reads, and which ends the cycle looking like the agent decided not to
> run it.
> `Dockerfile:521-527`

**Nobody chose to edit the published image. Each of them wrote down that there
was no other way.**

## The design

**Written on 2026-09-12 in eight files.** `01a-` through `01d-` are the design
run's, against `baf051d`; `01e-` through `01h-` are the build run's, against
`fd07353`. It decides rather than compares, and `01-constraints.md`'s fixed
ten-heading list governs the first four.

**The mechanism in five sentences.** A stack is a directory holding one
`stack.json`, living in `./stacks/` on the operator's own machine and reaching
the container through a read-only bind mount the compose file gains **once**. At
boot, before the server starts, an applier reads every stack, installs what each
declares into the named volume `usagefoundry-stacks` at `/var/lib/uf-stacks`,
links the binaries it names into one root-owned `bin` directory the `Dockerfile`
has already put on `PATH`, and writes a receipt saying what happened. Adding the
twelfth tool is a directory copied in and a restart: no file the image contains
is touched, which is R1. The declaration is on the host, so it survives
`docker compose up --build` untouched and survives `docker compose down -v`,
which destroys the volume and is answered by reinstalling from the declaration -
the volume is a cache and the declaration is the durable thing. Because a work
cycle's `acceptEdits` may refuse a binary the CLI has never seen, and nobody has
measured whether it does, a stack declares the argv prefixes it grants and the
applier projects them onto `--allowedTools` beside `ISOLATED_GIT_TOOLS`, which is
the design that works under the worse answer and is one deletable list under the
better one.

| File | What it argues |
|---|---|
| [01a-mechanism.md](01a-mechanism.md) | **the design.** The ten fixed headings in order: the two paths and why they are two, the six files that change once and never again, why a bind mount rather than `/workspace`, a `UF_*` list or a derived image, both persistence events separately, boot-time apply and its four reasons, the ownership split, idempotency, reconciliation, removal, conflicts, every failure mode with where it is visible, the build cost, and the fact that would kill it |
| [01b-stack-format.md](01b-stack-format.md) | **the artifact.** What one stack is, why the directory name is its identity, why JSON, the schema field by field, the three install verbs and their argv, the four `env` refusals and what each prevents, what `allow` may and may not grant, the parse-time refusals, and the Terraform example written out whole with real publisher digests |
| [01c-reach-and-permission.md](01c-reach-and-permission.md) | **R3.** Which of the three links are settled and by which test, what a sandboxed run's read, exec and write policy does to a binary outside the image and the one path that has to be added, and the exact command that measures whether `acceptEdits` refuses an arbitrary binary, with the four outcomes and what each one changes |
| [01d-boundaries.md](01d-boundaries.md) | **the two answers the next run should not re-derive.** Where the line between a stack and the existing `UF_*` lists sits; the migration question answered with a counting rule and a table - all twelve `Dockerfile` commits stay, `jq` is the one misfiled and stays anyway, and here is what a reviewer says to the thirteenth; and the twelve things this design deliberately does not do |
| [01e-operator-surface.md](01e-operator-surface.md) | **where the operator meets it.** Why three of the four acts are a file manager and a restart rather than a button; the pane, which is Settings, and why there is no tenth; a `Tools` section with stacks as one of three sources; the six states and why `danger` is reserved for the one that lies; and the failure in four places, because a boot log line dies with the restart that is exactly when somebody comes looking |
| [01f-read-back.md](01f-read-back.md) | **R5.** Four layers - declared, applied, reachable, observed - from four sources, with the rule that a layer may never be inferred from the one above it; how `reachable` keeps the whole thing true when somebody installs by hand; what a `run_events` count can and cannot say; and the seven things it may never claim |
| [01g-third-party.md](01g-third-party.md) | **R2 between two people.** What a publisher publishes and what they cannot promise, what a consumer does and reads, nine failure modes with which are quiet, and a second complete stack - shellcheck and shfmt, two publishers, no manifest anywhere - that found two defects in `01b-`'s schema |
| [01h-acceptance.md](01h-acceptance.md) | **the five criteria checked one by one**, with how each was checked and one of them answered **not met** |

**The operator's half, decided by the build run.** A stack is added, removed and
changed on the host with a file manager and a restart, and **nothing in the app
installs anything** - an install endpoint would be remote code execution behind
this app's own authentication, which `src/lib/config.ts:494-508` already refuses
a smaller version of. What the app does is *report*, in a `Tools` section on
Settings - never a tenth pane - over four layers read from four places rather
than inferred from one another, so that a tool somebody installed by hand and a
receipt that has stopped being true are both visible. A failed install is written
in four places, because the boot log that carries it is destroyed by the next
restart and the restart is when an operator comes looking.

**The build order, and phase 1 is the one that inverts expectation.**
[21-implementation-sketch.md](21-implementation-sketch.md) ships the **read-back
first**, over the two tool lists that exist today, before anything installs
anything: it touches no `Dockerfile`, no compose file, no entrypoint and no
volume, and it is worth having on an install that never adds a stack. Then the
carrier with the one verb that executes nothing at install time, the rest of the
format, the grant the probe may delete, and the last mile.

**Three rulings the design run was asked to make and made.**
`05-option-image-is-the-stack.md` is **out**: a derived image layers at build
time, so an operator on a pulled image cannot add a tool at all, which fails
R1's own stated test rather than a preference. `04-`'s reconcile-host question is
**answered**: the applier reconciles declarations against receipts in both
directions and removes only paths its own receipts record. `14-`'s identity
question is **answered** the way R2 forces: the directory name is the identity,
the filesystem enforces uniqueness, and a stack is install-wide because `14-` §7
found every per-run door closed by name.

## Disposition of the surveyed options

**Nothing in this directory has been deleted.** The files below are unedited, so
the design run can read what it is superseding. Each row says what the design
run should do with the file.

- **input** means read it; its reasoning bears on a requirement.
- **superseded** means its conclusion is reversed or its question is now
  answered, and what remains under it is still worth reading.
- **dead** means do not build it. The options premised on "maybe we build
  nothing" are dead on their face: the decision forecloses them.

| File | Option | Disposition | Why |
|---|---|---|---|
| [02-…widen-the-existing-lists](02-option-widen-the-existing-lists.md) | A | **input** | The only declarative installer for a release tarball in the directory, and the per-tool cost is one `.env` line, so it meets R1. Its checksum question is real: validation found every existing pinned download verifies the **publisher's** digest, never one this repository chose |
| [03-…persistent-opt-volume](03-option-persistent-opt-volume.md) | B | **dead** | A bare writable volume carries no declaration, so nothing is shareable (R2) and `down -v` leaves nothing to reinstall from (R4b). Its own §8 calls it *"the option with the worst failure profile in the directory"* |
| [04-…declared-manifest](04-option-declared-manifest.md) | C | **superseded** | The manifest idea is now required; its *store* is not. A database row is the form-typed row assumption A2 rules out, and it does not survive `down -v` where `.env` does. The reconcile-host question it left open is the design's to answer |
| [05-…image-is-the-stack](05-option-image-is-the-stack.md) | D | **input, and the one to rule on first** | The closest thing here to R1, R2 and R4 met at once: a `Dockerfile.stack` that `FROM`s `usagefoundry:${UF_IMAGE_TAG:-latest}` (`docker-compose.yml:37`) layers on top without editing the published image, and it is a file a third party can hand you. **But it layers at build time, where assumption A1 says boot or run time.** That ruling decides whether `05-` is the answer or is out |
| [06-…build-nothing](06-option-build-nothing.md) | E | **dead** | It is "build nothing new". The decision forecloses it by name. Its three code-comment corrections are worth keeping as chores and are not a stack mechanism |
| [07-…make-it-runnable](07-option-make-it-runnable.md) | F | **input** | The only file in the directory that addresses R3's third link, permission to invoke. Its §10 probe costs one work cycle and **no design should be finalised without it** |
| [08-terminal-problem.md](08-terminal-problem.md) | framing | **input, question superseded** | Nobody is asking for a terminal now, so its surface question is moot. Its uid trap, its transport survey and its reconciliation of *"never a shell"* (`docs/agent/security.md:14`) are constraints on any install surface. **Correction: its `terminalEnv()` does not exist in `src/`**; the real strip list is `childEnv`'s |
| [09-…full-pty](09-option-full-pty.md) | G | **dead** | A PTY installs by typing, into the writable layer, which R4a discards and R2 cannot share. It also carries the directory's only cost estimate with an unbounded tail. The decision is about a mechanism, not a console |
| [10-…one-shot-exec](10-option-one-shot-exec.md) | H | **dead** | Same as `09-` against R2 and R4: a typed command is not a unit. Its exit code as a read-back is the one piece worth carrying into R5 |
| [11-…allowlisted-installer](11-option-allowlisted-installer.md) | I | **input, standalone superseded** | Its closed verb list and constant argv templates are the shape any install surface must take under *"never a shell"*, and `16-` and `18-` both borrow them. As a standalone answer it fails R2: typed verbs are actions, not a shareable artifact |
| [12-…manifest-transcript](12-option-manifest-transcript.md) | J | **superseded** | A view onto `04-`'s manifest, and that manifest's store has changed, so the view is re-derived rather than inherited. Its insight is R5: what the operator wanted from a terminal was **feedback** |
| [13-…build-no-terminal](13-option-build-no-terminal.md) | K | **dead** | "Build no terminal, write it down" is the second build-nothing option. Its host-access question survives as an open input below, and is still unasked |
| [14-stack-object-model.md](14-stack-object-model.md) | framing | **input, conclusion reversed** | The decision answers its headline question in the opposite direction: R2 says there **is** a stack object. Everything under that heading is the design run's most direct input: identity, the four candidate stores, when a stack is applied, the three states, additive-only drift, and its §7 finding that **all three doors a stack capability could attach to are closed by name** |
| [15-…no-stack-object](15-option-no-stack-object.md) | L | **superseded, and its read-back is carried forward whole** | Its `toolInventory.ts` plus one route plus one card **is R5**, including the honest rendering that a tool whose invocation has never been observed reads `unverified` rather than `installed`. Its "no stack object" conclusion is reversed by R2 |
| [16-…stack-table](16-option-stack-table.md) | M | **superseded** | Identity is now required rather than optional, so its central refusal falls. Its store does not survive R2 or R4b. Its lifecycle and boot-reconciler reasoning is input |
| [17-…requirements-not-installs](17-option-requirements-not-installs.md) | N | **dead** | "A stack is a precondition; install nothing" is build-nothing in a third costume. Its pre-spawn refusal survives only as an R5 note, and it concedes the point itself: *"the correct version of this option is not a refusal but a warning on the run"* (`17-`:227), which is R5 |
| [18-…repo-manifest](18-option-repo-manifest.md) | O | **input, and it is the strongest** | The only option in the directory that is **already** a self-contained declarative file a third party can author, copy and share (R2), surviving all four events including a fresh host (R4), at no per-tool image edit (R1). It was rejected on cost and on boundary width, and the decision removes the cost objection. Its boundary problem does not go away: a cloned repository becoming an installer is held by one sentence, that *"the changed manifest is inert until a human approves it"* (`18-`:127) |

`19-comparison.md`, `20-recommendation.md` and `21-implementation-sketch.md` are
**superseded whole.** Their weights were chosen for a question that is no longer
being asked, "Asked" and "Cheap" both weigh against a decision already taken,
and `20-`'s core sentences, *"the Terminal pane, as described, should not be
built"* and *"the deploy button should not be built either"*, are exactly the
re-argument this directory may no longer make. Read `19-` §3, the ten-heading
comparison of shapes, as a fact table; read its §4 scores as history.

`22-validation.md` stands as a record of what was checked at `fe52cab` and is
the reason the corrections below are trustworthy. See the citation health
warning.

## What would change the design

**Nothing here would reverse the decision.** The decision is at the top of this
file, the operator made it, and no file in this directory may re-argue it. What
follows is what would change *the design* - and each item names which part of it
moves, because "this would overturn it" is not a useful thing to say about a
mechanism that is being built either way.

**Two of the five questions this list used to carry are closed and are not
repeated below.** *Does A1 permit build-time layering?* - **ruled no**
(`01a-` §2.4): a derived image cannot add a tool on a `docker compose pull`
install, which is R1's own test. *What is the identity of a stack?* - **ruled**:
the directory name, with the filesystem enforcing uniqueness (`01b-` §1).

Ordered by how much of the design each one moves.

1. **The operator does not own the directory holding `docker-compose.yml`.**
   **Changes: everything.** The whole carrier is a host bind mount beside that
   file (`01a-` §2.1). An install on a managed platform, or one the operator
   reaches only through this app's own UI, has no door at all, and the mechanism
   would have to be rebuilt around something the app itself can write - which is
   the thing `01a-` §6 refuses on security grounds, so it would be a different
   design rather than a modified one. **Still unasked**, and it is one sentence.
   The weaker half is already answered: the design needs host *filesystem*
   access and **not** `docker compose exec`.
2. **A named volume does not survive `docker compose up --build` on the
   operator's engine.** **Changes: R4a's verdict and `21-` phase 2's costing,
   not the shape.** The toolbox would reinstall from the network on every rebuild,
   R4a degrades from met to *met when the network is up*, and the applier's
   whole-run time budget becomes a per-boot cost rather than a first-boot one.
   `22-validation.md` §5 command 2 settles it in five lines and **nothing in this
   repository has ever watched a volume outlive a rebuild.**
3. **`acceptEdits` turns out to permit an arbitrary binary.** **Changes: one
   deletable list.** `01c-` §4.2's grant projection and `21-` phase 4 both
   disappear, `01b-`'s `allow` field becomes optional decoration, and nothing
   else moves. The design is built for the worse answer precisely so that the
   better one costs a deletion - `22-validation.md` §5 command 1.
4. **The operator expects to type `apt-get`, or a login, or a two-step install.**
   **Changes: whether the unit is the right unit.** `01d-` §3 refuses system
   packages by name, and if that is what is actually wanted then a declarative
   artifact is answering a smaller question than the one being asked. **Still
   unasked.**
5. **Four mounted repositories need four different toolchains.**
   **Changes: `01d-` §3's refusal of per-folder selection.** The design takes the
   one-stack reading - install-wide, per `14-` §7, which found all three per-run
   doors closed by name. If the reading is wrong, `18-option-repo-manifest.md` is
   where the question restarts. **Still unasked.**

Items 1, 4 and 5 are questions for the operator rather than facts about the tree,
they cost a sentence each, and **five runs of this directory have named them
decisive without asking any of them.** Items 2 and 3 are commands, and
`22-validation.md` §5 has both, in that order.

## Citation health

**`CLAUDE.md` citations in this directory were swept and fixed on 2026-09-12.**
The file is 77 lines (`wc -l CLAUDE.md`), so every `CLAUDE.md:134`,
`CLAUDE.md:95` and `CLAUDE.md:35` in the tree pointed past its end. The rules
moved into `docs/agent/`, and the fixes point at where they live now:
*"never a shell"* at `docs/agent/security.md:14`, routed from `CLAUDE.md:59`;
*"a directory whose hooks the container executes"* at
`docs/agent/architecture.md:59`, routed from `CLAUDE.md:53`; and the "four
modules" claim at `docs/agent/architecture.md:222`.

**The eleven current files were fully re-validated on 2026-09-12 against
`fd07353`, and `22-validation.md` is that pass**: 289 citations resolved
mechanically, 88 quotations located in the tree, and every citation's line
content read by hand for `01-constraints.md`, `00-problem.md` and the four
design files. **Seven findings, five references and two design defects**, all
fixed in place: R5's count of its own evidence was wrong in both directions;
`01a-` §7's reconcile would never have retried a failed stack, which broke
`01e-` §5.3's de-latching claim; and `01b-`'s schema could neither name a
publisher's architecture spelling nor pin a digest per architecture, both found
by writing a second worked example. Two findings against the tree are recorded
and **not** fixed, because this is a proposal: `CLAUDE.md`'s pointer to the
`globalThis` shape trap names `orchestrator.ts:373` and the trap is at
`:10870-10873`, and `docs/agent/ui-density-audit.md:159` still calls `panes.ts`
ten rows where it is eleven.

**`02-` through `18-` were deliberately not re-validated and many are stale.**
`22-validation.md` §4 says why and what it costs; the short version is that a
citation inside a superseded argument is part of the record of that argument.
An earlier pass resolved roughly 390 of them at `fe52cab`. Spot checks at
`6c5af5f`: `childEnv` is at
`src/lib/orchestrator.ts:5698-5716`, not `:6306-6321`; the `acceptEdits` default
is `src/lib/settings.ts:940`, not `:730`; the seven-refusals measurement left
`orchestrator.ts` entirely and is now `src/lib/cycleInvocation.ts:605-614`; the
three tool volumes are `docker-compose.yml:445`, `:459` and `:471`, not
`:370-409`. **Anything in `02-` through `18-` that a build run intends to act on
has to be re-resolved at that moment.** The four claims the current design
actually borrows from them were each re-checked in this run's pass.

**The four design files were written and their citations verified against
`baf051d`**, and they correct three the design needed: the tree now has **five**
named volumes rather than three (`usagefoundry-winnow` at
`docker-compose.yml:486`, declared at `:719`, joined the three this directory
counted); the two existing install loops run `gh_as_agent extension install "$1"
--pin "$2"` at `docker-entrypoint.sh:159-161` and `uv_as_agent tool install "$1"`
at `:233`, neither of which greps as a literal `gh extension install`; and
`install -m 0755` is `Dockerfile:175`. Facts the design rests on that were
measured **in this container** rather than read: `command -v unzip` returns
nothing while `tar`, `python3`, `curl`, `jq`, `sha256sum` and `install` all
resolve; `python3 -m zipfile -e` extracts a `0755` file at `0644`;
`dpkg --print-architecture` returns `arm64` where `uname -m` returns `aarch64`;
and both of `01g-`'s example binaries run here, `shellcheck --version` printing
`version: 0.11.0` and `shfmt --version` printing `v3.14.1`, against digests
fetched from their publishers the same day.

## What could not be reached

**This container has no Docker.** No rebuild, no volume creation, no volume
destruction, no image build, no seccomp application. Every persistence claim in
this directory is assumed from the compose file's own statements and says so at
the point it is made. **`22-validation.md` §5 has the commands a human with
Docker must run, in the order they buy the most, and §6 is the whole
reasoned-versus-observed accounting for the directory.**

One gap in the repository's own record rather than in this directory, and it has
**widened** since it closed:
`grep -n "UF_PY_TOOLS\|UF_GH_EXTENSIONS\|usagefoundry-pytools\|gocache" docs/verification.md`
returned one line about a guard when the survey closed and returns **zero** at
`fd07353`. The five named volumes have never been observed surviving a rebuild;
they are pinned by unit tests over file *contents*
(`src/lib/deployment.test.ts:905`, `:978`, `:1137`) and by nothing else.

## Files

| File | What it holds |
|---|---|
| [00-problem.md](00-problem.md) | the measured cost of the status quo, what ships today, the four gaps against R1-R5, which children have to see a tool, and the six things "sandboxed run" means |
| [01-constraints.md](01-constraints.md) | **the acceptance criteria**: R1-R5 with a met/not-met test each, the constraints the tree imposes, the two assumptions, the commands nobody has run, and the fixed ten-heading list a design document answers |
| [01a-mechanism.md](01a-mechanism.md) | **the design**, answering the ten fixed headings in order: the two paths, the six files that change once, both persistence events separately, reach, tool state, the boundaries crossed, the operator's acts, every failure mode, the cost, and the fact that would kill it |
| [01b-stack-format.md](01b-stack-format.md) | **the stack unit**: identity, format, schema, the three install verbs, the refusals, pinning and integrity, and the Terraform example written out whole |
| [01c-reach-and-permission.md](01c-reach-and-permission.md) | **R3**: which links are settled and by which test, what a sandbox does to a binary outside the image, and the exact command that measures the one link nobody has measured |
| [01d-boundaries.md](01d-boundaries.md) | **the migration question answered** - all twelve `Dockerfile` commits stay, with the counting rule that decides the thirteenth - and the twelve things this design deliberately does not do |
| [01e-operator-surface.md](01e-operator-surface.md) | **the operator's surface**: the four acts and why three of them are a file manager and a restart; the pane and the route, with the ban that forbids a tenth; what installing, installed and failed each look like; the failure written in four places and why one is not enough; removing and changing; and the six things this surface may never do |
| [01f-read-back.md](01f-read-back.md) | **R5**: the four layers and their four sources, why the receipt is not the truth, how `PATH` resolution keeps it honest against a hand install, what a `run_events` count can and cannot say, the composition rule, the routes, the tests, and the seven claims it may never make |
| [01g-third-party.md](01g-third-party.md) | **R2 between two people**: what is published and through which four channels, what a publisher owes and cannot promise, the consumer's four commands and five-line checklist, nine failure modes with which are quiet, the two schema defects this example found, and the shell-lint stack written out whole with digests fetched here |
| [01h-acceptance.md](01h-acceptance.md) | **R1-R5 checked one by one**, with how each was checked, one verdict of **not met** and two of *met in design* |
| `02-` … `18-` | the seventeen surveyed options and two framing files, dispositioned in the table above, unedited and **deliberately not re-validated** |
| [19-comparison.md](19-comparison.md) | superseded whole. §3's shape table is still a fact table; §4's scores are history |
| [20-recommendation.md](20-recommendation.md) | superseded whole. It recommended building almost nothing |
| [21-implementation-sketch.md](21-implementation-sketch.md) | **the build order**: five phases against the decided design, each naming what ships, the invariant it must not break, what the operator sees and which functions earn a test - plus the seven tests collected, what is not built and where it went, and what each phase leaves unverified |
| [22-validation.md](22-validation.md) | **this run's validation pass**: what was checked and how, seven findings fixed in place, two findings against the tree that were not, what was deliberately not re-validated, the Docker commands in the order they buy the most, and the reasoned-versus-observed accounting |
