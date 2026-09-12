# The five requirements, checked one by one

**Does the design as written meet its own acceptance criteria?** Each of R1 to R5
is taken from [01-constraints.md](01-constraints.md) in its own words, checked
against the design as it stands, and answered **met**, **met in design** or
**not met** — with how it was checked beside the answer.

**A criterion that is not met is a finding, not a reason to move the criterion.**
One of the five is not met and says so; two more are met in design and cannot be
met in fact from this container, which is a different and weaker thing than met.

Checked against the tree at `fd07353` and the directory as of this run.

---

| | Requirement | Verdict |
|---|---|---|
| **R1** | adding a tool edits no file inside the published image | **met** |
| **R2** | a stack is a self-contained declarative unit a third party can author, copy and share | **met**, and one of its four tests failed until this run |
| **R3** | an installed tool reaches every run, every sandboxed run and every kind of agent child | **not met.** Two links of three are settled; the third is designed around and has never been measured |
| **R4** | it survives `docker compose up --build`, and `down -v` is answered separately | **R4b met. R4a met in design and unobserved** |
| **R5** | the app can report what is installed and whether the install succeeded | **met in design**, and it did not meet its own de-latching claim until this run fixed `01a-` §7 |

---

## R1 · met

**The criterion.** *"Met when: the change that adds a tool to an install touches
none of `Dockerfile`, `docker-entrypoint.sh`, `scripts/`, `src/`, or any other
path the image contains, and an operator running a *pulled* image can add the
tool without building one."*

**How it was checked.** Two ways, matching R1's own two tests.

1. **`git diff --name-only` over a commit that adds a tool.** The stack in
   `01g-` §6 is `stacks/shell-lint/stack.json` and `stacks/shell-lint/README.md`.
   **Neither path can be in the image**, and the `Dockerfile`'s stage split is
   why: `COPY . .` at `Dockerfile:34` is the *builder* stage, and the runner
   stage that becomes the published image copies exactly five things —
   `public`, `.next/standalone` and `.next/static` (`:560-562`), three named
   scripts (`:570`), and the entrypoint (`:740`). A directory under `stacks/`
   reaches none of them. Adding the second tool to that stack — shfmt beside
   shellcheck — is an edit to the same `stack.json` and nothing else.
2. **The six one-time changes enumerated and each checked for per-tool cost.**
   `01a-` §2.3 lists them: one compose mount and volume, one `ENV PATH` and one
   `COPY`, one entrypoint block, and three new or edited `src/`-side files.
   **None of the six names a tool**, and none is touched again to add one.

**What R1 explicitly licenses**, and this is the clause the verdict rests on:
*"Whatever carries a stack may itself be built into the image once, in a commit
that names no tool. R1 is about what the twelfth tool costs, not the first."*

**The one honest caveat.** An operator on a pulled image adds a tool with a `cp`
and a restart **once they have a compose file carrying the mount**. Getting that
compose file is a one-time `git pull` of this repository's own
`docker-compose.yml`, which is the operator's file and not a path the image
contains, and it is the same act every other compose change in this repository's
history has required. It is a first-adoption cost, not a per-tool one, so it
falls on R1's licensed side — but it is a cost and stating it is the difference
between met and claimed.

---

## R2 · met, and one of its four tests failed until this run

**The criterion.** Four tests, all of which must hold.

**1. One artifact whose content alone determines what gets installed** — **met**.
A directory holding one required file, and *"`stack.json` … the only file the
applier reads"* (`01b-` §1). The `README.md` beside it is for the author's prose
and the applier never opens it.

**2. Its author needs no knowledge of `src/`** — **met**. Checked by reading
`01g-` §6's `stack.json` word by word: `schema`, `name`, `summary`, `install`
with `kind`, `url`, `sha256`, `unpack` and `bin`, and `allow`. Every one names a
tool, a version, a file or a command. **The closest thing to an internal is
`allow`**, whose entries the applier turns into `Bash(<cmd>:*)` — and that is
Claude Code's own permission vocabulary, which a person installing tools for a
coding agent already has to know. It is not this app's internals.

**3. Copying to a second install and doing nothing else produces the same tools
there** — **met now, and it was not met before this run.** This is the test
`01g-` §5.2 found failing: a stack whose `url` varied by architecture and whose
publisher shipped no checksum manifest asserted one `sha256` about two different
files, so copying it to an install on the other architecture produced a `failed`
receipt rather than the same tools. The repair — `sha256` may be an object keyed
by architecture, and a bare string against an arch-varying `url` is a parse
refusal — is in `01b-` §2.1, and it is what moves this test from failing to
passing.

**4. Consuming somebody else's stack is copying their artifact plus one act of
approval** — **met**. `01g-` §2: `cp -r`, then `docker compose up -d`. The
approval is the restart, and it is an act the operator takes at a shell.

**The borderline `01-constraints.md` asked the design to rule on, ruled.** A line
in `.env` satisfies 1 and 3, arguably 2, and fails 4 *"because `.env` is one file
for the whole install and merging two operators' lines is a text edit rather than
an act of consumption."* `01d-` §1 keeps `UF_PY_TOOLS` and `UF_GH_EXTENSIONS`
rather than replacing them and states the boundary: a `UF_*` list is right when
the whole declaration is one package name and you want nothing else; a stack is
right when you need a checksum, an environment variable, a state directory, a
permission grant, or an artifact somebody else can take.

---

## R3 · not met

**This is the finding, and it is the same one the directory has carried since it
opened.**

**The criterion.** *"Met when, for each child kind enumerated in
[00-problem.md](00-problem.md), all three links hold"*: the binary *"exists on
disk after a rebuild (R4)"*, *"it is on that child's `PATH`"*, and *"**the child
is permitted to invoke it.**"* And: *"How to test it: a run at each permission
mode asked to invoke the tool, and the log read for a refusal. Until that exists,
R3 is open."*

**How it was checked.** Link by link, against `01c-`.

- **Link 1** is settled by design and inherits R4's own verdict below, which is
  *met in design and unobserved*. So link 1 is no stronger than R4a.
- **Link 2** is settled and pinned: `childEnv` copies the server's environment
  and strips prefixes and names that do not include `PATH`
  (`src/lib/orchestrator.ts:5698-5711`), and `src/lib/git.test.ts:97` asserts
  `assert.equal(env.PATH, process.env.PATH)`. **With the caveat `01c-` §2 makes
  honestly**: that test is over `gitEnv`, not `childEnv`, and `childEnv`'s three
  `describe` blocks assert nothing about `PATH`. `21-` phase 2 adds the missing
  line.
- **Link 3 has never been run.** `01c-` §4 writes the command and §6 says so in
  its own words: *"Nothing in this file has been run."* There is no Docker here
  and no way to spawn a `claude` process against a real install.

**So the verdict is not met, and it is not met on the criterion's own terms** —
the test R3 names has not been performed. Saying otherwise would require reading
"designed around" as "met", which is the substitution this file exists to refuse.

**What the design does about it is the right thing and is not the same thing.**
It assumes the worse answer and projects a grant from each stack's `allow`
(`01c-` §3), so the design works whichever way the measurement lands, and a
better answer costs one deleted list rather than a redesign. That makes R3 *safe
to build against*. It does not make it met.

**Cost to settle: one short headless turn.** `22-validation.md` §5 command 1.

---

## R4 · R4b met, R4a met in design and unobserved

**R4a, `docker compose up --build`.** *"Met when every tool a stack declares is
present and runnable after the rebuild with no operator action."*

**How it was checked.** By reading what the design rests on rather than by
running it. The artifacts live in a named volume at `/var/lib/uf-stacks`
(`01a-` §2.1), the image ships nothing at that path, and a named volume is not
the writable layer a rebuild replaces. Every clause of that is Docker's
documented semantics plus this repository's own statements — the compose file's
description of the failure it is avoiding at `docker-compose.yml:450-453`, and
the `/opt`-versus-volume reasoning at `Dockerfile:303-309`.

**And it has never been observed here or anywhere in this repository's record.**
`grep -n "UF_PY_TOOLS\|UF_GH_EXTENSIONS\|usagefoundry-pytools\|gocache" docs/verification.md`
returns **zero** lines at `fd07353`. The five named volumes are pinned by unit
tests over file *contents* (`src/lib/deployment.test.ts:905`, `:978`, `:1137`)
and by nothing else. **No volume in this repository has ever been observed
outliving a rebuild.**

So: **met in design, unobserved in fact**, and `22-validation.md` §5 command 2 is
the five lines that settle it. If it fails, R4a degrades to *met when the network
is up* and `21-` phase 2's time budget becomes a per-boot cost.

**R4b, `docker compose down -v`.** *"Met when the design states, in writing,
which of these it is"* — reinstalled from the declaration, or gone with the
operator told — *"and the app says the same thing"*. And: *"Both are acceptable.
Silence is not."*

**Met.** The design states it in `01a-` §1 and §3: the volume dies, the
declaration does not, and the next boot reinstalls from the declaration. The app
says the same thing in two places — the boot log's install lines (`01e-` §3) and
the Tools section, where a stack reinstalling after a `down -v` is drawn from its
fresh receipt like any other (`01e-` §4).

**This is the half that is met on the criterion's own terms**, because the
criterion asks for a written answer and consistency rather than for a
measurement. It is also the one R4 called harder, on the ground that nothing
backs up a named volume — and the design's answer removes that problem rather
than solving it: there is nothing in the volume worth backing up, because the
declaration is on the host and in the operator's own git.

---

## R5 · met in design, and it did not meet its own claim until this run

**The criterion.** *"Met when a surface in this app names, per declared tool:
1. that it is declared; 2. the outcome of its install, carrying the failure text
when it failed; 3. whether the tool has ever been observed to run."*

**How it was checked.** Point by point against `01f-`'s four layers.

1. **Declared** — the `declared` layer, read from `/etc/uf-stacks/*/stack.json`
   rather than inferred from the receipt, which is what catches a stack the
   operator added whose applier never ran (`01f-` §2.1).
2. **Outcome with the failure text** — the `applied` layer. The receipt carries
   `ok | failed | conflicted` and, on failure, the last 4 KB of the step's stderr
   **verbatim and never parsed**, with the original byte count beside it so a cap
   that bit says so (`01f-` §2.2).
3. **Ever observed to run** — the `observed` layer, counted from `run_events`'s
   `tool` and `tool_error` rows over the retention horizon, with the horizon
   printed because *"never observed" means "not in the retained window"*
   (`01f-` §2.4).

**And a fourth layer the criterion did not ask for**, which is the one that
answers *how it stays true when somebody installs something by hand*: `reachable`
resolves the server's own `PATH` and reports `shadowed`, `missing` and
`unclaimed` rather than believing the receipt (`01f-` §2.3).

**The claim that was false until this run.** `01e-` §5.3 puts two integers on
`/api/status` and argues they de-latch on a boot, in the shape `schemaFaults`
already has. That argument requires the receipt set to be a reading of *this*
boot — and `01a-` §7's reconcile rules would have skipped a `failed` receipt
forever, making it a reading of the boot that first failed. `22-validation.md`
§2.2 is the finding and the fourth reconcile rule is the fix. **Without it R5
point 2 was met on the Settings page and not on the monitoring surface**, which
is the surface an operator who never opens Settings actually has.

**Why it is *met in design* rather than *met*.** None of it exists. Phase 1 of
`21-` ships the layers that need no stack, which is the part that can be checked
against a real install today; the receipt half cannot be checked until an applier
writes a receipt.

---

## What the five verdicts add up to

**Four of five are met or met in design; R3 is not met and is one short headless
turn from being answered either way.** That is the same shape this directory has
had since it opened, and the design's contribution is not to have closed R3 but
to have made the answer cheap to act on: `01c-` §3's grant is built for the worse
reading and deleted under the better one.

**Two of the five rest on facts no run in this container can check**, and
`22-validation.md` §6 is the list. R4a is the load-bearing one: it is the
operator's stated problem, it is what every existing tool volume was created for,
and **nothing in this repository has ever watched one survive a rebuild.**
