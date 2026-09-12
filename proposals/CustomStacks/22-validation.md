# Validation

**What this pass checked, what it found, and which of this directory's claims are
observed rather than reasoned.**

Three runs produced the eleven files this pass covers: the reframing run
(`README.md`, `00-problem.md`, `01-constraints.md`), the design run (`01a-`
through `01d-`), and this one (`01e-`, `01f-`, `01g-`, `21-`). **The seventeen
superseded option files `02-` through `18-` were deliberately not re-validated**,
and §5 says why and what that costs.

Checked against the tree at `fd07353`. **This container has no Docker**, and §6
is the honest accounting of what that leaves unobserved.

---

## 1. What was checked, and how

**Three passes, two of them mechanical.**

1. **Every `path/file:line` citation resolved.** A script opened each cited file
   at each cited line and reported anything past the file's end or pointing at a
   file that does not exist. **289 citations across the eleven files plus
   `proposals/README.md`.** Two apparent failures were false positives - both are
   `README.md`'s own prose *about* the stale `CLAUDE.md:134` and `CLAUDE.md:95`
   citations the previous run swept, quoting them in order to say they were
   wrong.
2. **Every quoted passage located in the tree.** A second script extracted every
   `*"…"*` span, normalised it to letters and digits, and searched `src/`,
   `docs/`, `scripts/`, the three deployment files, `.env.example`, `CLAUDE.md`
   and `README.md`, falling back to `proposals/` for a quotation from a sibling
   file. **88 quotations across the eleven files; none is unattributed after the
   fixes in §2.** Three reported misses were the matcher breaking on a nested
   `"` and all three resolve to `.env.example:304`.
3. **Every citation's line content read by hand**, for `01-constraints.md`,
   `00-problem.md` and the four design files - the claim beside it compared with
   what the line says. This is the pass that found §2's substantive errors; the
   mechanical ones cannot.

**Why bother, given the previous run already did pass 3 over the four design
files.** Because it keeps finding things. That run corrected nine citations in
the design files, and this one found five more in files it had already checked
plus two design defects that no citation check could have caught.

---

## 2. What was wrong, and is now fixed in place

Seven findings. Two changed a design decision; five are references.

### 2.1 `01-constraints.md` R5 undercounted its own evidence · **reference**

**Was:** *"`grep -rn "UF_PY_TOOLS\|UF_GH_EXTENSIONS" src/` returns **no reader**,
only two docblock mentions in `src/lib/contextPruning.ts:98-99` and three in
`src/lib/deployment.test.ts`."*

**Is:** ten lines in two files at `fd07353` - **one** docblock mention in
`src/lib/contextPruning.ts:99` and **nine** in `src/lib/deployment.test.ts`.

**Direction: neither.** The claim R5 rests on - that nothing in `src/` *reads*
either variable - is unchanged and is the only part that was load-bearing. The
count was decoration and it was wrong in both directions at once. Fixed in
`01-constraints.md` and in the sentence `01f-` §1 inherited from it.

### 2.2 `01a-` §7's reconcile would never retry a failed stack · **design**

**Was:** three rules - digest matches an `ok` receipt, do nothing; no receipt or
digest differs, install; receipt with no declaration, remove.

**The gap:** a stack whose install failed keeps its declaration and its digest,
so on the next boot *neither* of the first two rules fires. It is attempted once
and skipped forever, and the receipt set becomes a record of the boot that first
failed rather than of this one.

**Why it matters beyond the retry.** `01e-` §5.3 puts two integers on
`/api/status` and argues they de-latch because the receipt set is a per-boot
reading. Under the old rules it is not, and the thing being built would be
exactly the trap `src/lib/db.ts:184-189` writes up: *"a monitor built on the
archive would go red at the first fault and stay red until five hundred later
events pushed it out."*

**Fixed:** a fourth rule in `01a-` §7 - a declaration matching a `failed` or
`conflicted` receipt is retried, and only `ok` is a reason to skip. The cost is
one retried download per boot on an install whose network is down, which is loud
and correct.

**Direction: harder.** The design as written did not meet its own R5 claim.

### 2.3 `01b-`'s `{arch}` has one spelling and publishers have two · **design**

Found by writing `01g-`'s second worked example. `01b-` §2 gave `{arch}` as
`dpkg --print-architecture`'s output, which is Debian's spelling; shellcheck's
release assets are `…linux.x86_64.tar.gz` and `…linux.aarch64.tar.gz`, which no
expansion of it can name. **Measured here on 2026-09-12:**
`dpkg --print-architecture` returns `arm64` where `uname -m` returns `aarch64`.

**Fixed:** a fourth token `{arch_uname}` in `01b-` §2, derived from the same
switch so exactly one thing decides what architecture this is. `01g-` §5.1 is
the finding.

### 2.4 `01b-`'s `sha256` could not pin a per-arch URL · **design, and the worse of the two**

Same origin. `sha256` was one string per step while `url` *"may contain
`{arch}`"*, so a declaration could assert one digest about two different files.
shfmt is that case: its release carries no checksum manifest, and its two Linux
binaries digest differently, as they must.

**What it produced:** not the wrong software - the digest check precedes the
unpack and there is no branch where a mismatch proceeds - but a correct-looking
stack that installs on its author's architecture and fails on the other, blaming
the consumer's machine in a message nobody wrote.

**Fixed:** `sha256` may be a string or an object keyed by `{arch}`'s value, and a
string against an arch-varying `url` is a **parse refusal**, so the defect is
loud at the one moment somebody can fix it. `01g-` §5.2 is the finding; the
refusal joins `01b-` §3's list and is the only one there about two fields
disagreeing rather than one field being wrong.

### 2.5 A quotation attributed to `docs/agent/security.md:14` that it does not contain · **reference**

`docs/agent/security.md:14`'s words are: *"The agent is spawned with an argument
array and `stdio: ["ignore", "pipe", "pipe"]`, **never a shell**, so prompt
metacharacters are inert."* The phrase **"Never a shell. Argv arrays only"** is
`CLAUDE.md`'s routing paraphrase and appears nowhere in `docs/agent/`.

Two files in this directory quoted the paraphrase as if it were the doc's, both
of them written by this run, and both now quote the doc's own sentence. **Every
other `docs/agent/security.md:14` citation in the directory is correct** - they
quote the two words *"never a shell"*, which the line does contain.

**This is a house-style trap worth naming, because the paraphrase is loose in the
tree**: `proposals/ContinuousImprovement/01-constraints.md:159` and
`proposals/implemented - ContextControl/08-option-externalise-tool-output.md:284`
both carry it, the second in quotation marks, and neither cites a source for it.
Attributing it to a file is the error; using the phrase is not.

### 2.6 `docs/install.md`'s comma sentence and the test that pins it · **reference**

`21-` cited `docs/install.md:195-196` for *"a comma is meaningful inside a
version specifier"*, which spans `:195-197`, and
`src/lib/deployment.test.ts:1057-1067` for the assertion, which is
`:1056-1069` and has a name worth quoting:
`it("does not split entries on commas, which belong to version specifiers")`.
Both fixed.

### 2.7 Three quotations tightened to their own line and wording · **reference**

Three claims in `01e-` and `01f-` cited a `docs/agent/` file without a line, and
in one case paraphrased it:

- the agent-placement refusal is `docs/agent/agents-and-templates.md:10` -
  *"A saved agent … carries a role rather than a capability"*, and the field that
  would make it one is `tools`, which *"is refused at save"*;
- the route-not-a-card decision is `docs/agent/taskboard.md:779` - *"The editor
  is a route, not a card the board opens above itself"*;
- the grouping rule is `docs/agent/conventions.md:51` - *"Grouping has a closed
  vocabulary, and it is seven things"* - and the component is `ListGroup`
  (`src/components/ui/List.tsx:43`).

---

## 3. Two findings against the tree, neither fixed here

**This is a proposal, and nothing under `src/`, `docs/` or the deployment files
was edited.** Both belong to whoever implements this.

### 3.1 `CLAUDE.md`'s pointer to the `globalThis` shape trap is stale

`CLAUDE.md`'s **Always** section says the trap is *"the trap
`orchestrator.ts:373` records"*. `src/lib/orchestrator.ts:373` is a docblock
about a run's set-aside timestamp. The trap is written at
`src/lib/orchestrator.ts:10870-10873`: *"`??=` only initialises when the key is
absent, so a pre-upgrade value at a key whose shape changed survives the reload
and every call on it throws."* `src/lib/orchestrator.ts:605` makes the same point
for its own key: *"A **new key**, because the value's shape changed when
`iteration` was added."*

This matters here because `01f-` §4's cache is a new `globalThis` key and the
rule is the one thing a reader has to get right about it.

### 3.2 `panes.ts` is eleven rows and `ui-density-audit.md` still says ten

`grep -c "href:" src/components/shell/panes.ts` returns **11** at `fd07353`, and
`panes.ts:14-18` says so in its own words: *"**Nine is the ceiling** — ⌘1…⌘9 is
nine digits and the list is eleven rows — so the last **two** rows have no digit
at all."* `docs/agent/ui-density-audit.md:159` still reads *"`panes.ts` is ten
rows against ⌘1–⌘9"*.

**The ban is not weakened by being stale - it is strengthened**, and `01e-` §2
uses it either way. This is the third document in a disagreement
`proposals/implemented - SessionFlow/README.md` already recorded, and it has not
been reconciled since.

---

## 4. What was deliberately not re-validated

**`02-` through `18-`: seventeen option files and two framing files, roughly 390
citations, not re-resolved.**

The reason is that they are superseded rather than current.
[README.md](README.md)'s table dispositions each one as input, superseded or
dead, and `proposals/README.md` says why the files are kept rather than deleted:
so the design run can read what it is superseding. A citation inside a superseded
argument is part of the record of that argument, and correcting it would make the
file claim to have been written against a tree it was not.

**What that costs, stated so nobody assumes otherwise.** Many of those line
numbers are known stale and `README.md` names three: `childEnv` moved from
`:6306` to `:5698`, the `acceptEdits` default from `settings.ts:730` to `:940`,
and the seven-refusals measurement out of `orchestrator.ts` into
`cycleInvocation.ts:605-614`. **Anything in `02-` through `18-` that a build run
intends to act on has to be re-resolved at that moment**, and the four claims the
current design actually borrowed from them were each re-checked in §1's third
pass: `15-`'s `toolInventory.ts` shape, `11-`'s closed verb list, `14-` §7's
three closed doors, and `17-`:227's warning-not-refusal fallback.

The earlier validation pass over those files is not lost. It ran at `fe52cab`,
it found 39 wrong citations of which six changed an argument, and its record is
this file's own git history - `git show fe52cab:proposals/CustomStacks/22-validation.md`
is the whole of it, and `1f7b2a7` annotated rather than rewrote it for exactly
that reason.

---

## 5. The commands a human must run, in the order they buy the most

**Every one of them needs Docker and none of them can run here.** The ordering
rule is how much of this directory each command moves from reasoned to observed.

### 1. The probe - one work cycle, and it decides a whole phase

Moves: **R3's third link**, which `01-constraints.md` calls the one that has
never been measured and which `21-` phase 0 gates phase 4 on.

```bash
docker compose up -d --build
# add UF_PY_TOOLS=ruff==0.14.1 to .env, then:
docker compose restart
docker compose logs usagefoundry | grep "installed Python tool"
#   expect: [usagefoundry] installed Python tool ruff==0.14.1   (docker-entrypoint.sh:297)
```

Then start a run at `acceptEdits` - the default (`src/lib/settings.ts:940`) - on
any mounted repository, with the task: *"Run `ruff --version` and report exactly
what it printed. Then run `ruff check .` and report the first line."* Read the
log for a refusal, and read the run's own report text. Repeat with
`Bash(ruff:*)` granted. `01c-` §4 has the four outcomes and what each decides.

**Whatever it says goes in `docs/verification.md`**, replacing the *Not yet
verified by hand* sentence `01c-` §6 already writes.

### 2. The two persistence events, which nothing in this repository has ever observed

Moves: **R4a and R4b**, and with them every "assumed" in `01a-` §3 and every
phase-2-onward claim in `21-` §8.

```bash
docker compose exec usagefoundry sh -c 'command -v ruff; ls /home/node/pytools/bin'
docker compose up -d --build                                     # the rebuild
docker compose exec usagefoundry sh -c 'command -v ruff'         # expect: still there
docker compose down -v && docker compose up -d                   # the down -v
docker compose logs usagefoundry | grep "installed Python tool"  # expect: reinstalled
```

**This is the largest single gap in the repository's own record, and it has
widened.**
`grep -n "UF_PY_TOOLS\|UF_GH_EXTENSIONS\|usagefoundry-pytools\|gocache" docs/verification.md`
returns **zero** lines at `fd07353`. The five named volumes are pinned by unit
tests over file *contents* (`src/lib/deployment.test.ts:905`, `:978`, `:1137`)
and by nothing else. If a volume does **not** survive a rebuild on the operator's
engine, R4a degrades from *met* to *met when the network is up* and `21-` phase
2's time budget becomes a per-boot cost rather than a first-boot one - which is
why `21-` §8 says to run this **before** phase 2 starts.

### 3. Whether an agent uid can write what this design assumes it cannot

Moves: `01a-` §2.2's whole root-owned-`bin` argument, and the uid split in
`01b-` §4.

```bash
uid=$(docker compose exec -T usagefoundry printenv UF_AGENT_UID)
gid=$(docker compose exec -T usagefoundry printenv UF_AGENT_GID)
docker compose exec -T usagefoundry setpriv --reuid="$uid" --regid="$gid" \
  --clear-groups sh -c 'id; echo $PATH; \
    touch /usr/local/bin/probe; \
    touch /home/node/pytools/bin/probe; \
    touch /var/lib/winnow/probe'
#   expected: /usr/local/bin refused, /home/node/pytools/bin written,
#             /var/lib/winnow refused — the last is the shape bin/ will have.
```

`/var/lib/winnow` is the closest existing analogue to the toolbox: a named volume
under `/var/lib` (`docker-compose.yml:486`, declared at `:719`). If an agent uid
*can* write it, `01a-` §2.2's plan for `bin/` needs the `chown` it assumes rather
than inheriting one.

### 4. The whole mechanism, once it exists

Moves: everything in `21-` phases 2 and 3 from *reasoned* to *observed*. Not
runnable before the applier is written, and listed here so the list is complete.

```bash
mkdir -p stacks && cp -r <shell-lint from 01g- §6> stacks/
env -u __NEXT_PRIVATE_STANDALONE_CONFIG docker compose up -d --build
docker compose logs usagefoundry | grep '^\[usagefoundry\] stack'
docker compose exec usagefoundry sh -c 'shellcheck --version; shfmt --version'
docker compose exec usagefoundry cat /var/lib/uf-stacks/receipts/shell-lint.json
```

The `env -u` is not optional if the build is started from inside an agent
session: a shell inheriting `__NEXT_PRIVATE_STANDALONE_CONFIG` makes `next build`
die with `TypeError: generate is not a function` (`CLAUDE.md`, Commands), and the
error names nothing relevant.

Then the two failure paths, because a mechanism observed only succeeding is a
mechanism whose failure handling is still reasoned: corrupt one digest and
restart, expecting a `failed` receipt and no link; delete the directory and
restart, expecting `pkg/`, `state/` and the link gone and nothing else touched.

### 5. The seccomp profile, which nothing has ever applied

Moves: `01c-` §4.3's *"unaffected"*, which is reasoned from
`src/lib/orchestrator.ts:5310` and `docker-entrypoint.sh:432` and has never been
run under a profile.

```bash
# uncomment docker-compose.yml:567-568, then repeat 1 and 4.
```

### 6. The two questions for the operator, which are not commands

They cost a sentence each and settle more than any command above.
**Five runs of this directory have named them decisive and none has asked.**

- **Do you have host access to the machine this container runs on?** `01a-` §10
  names this as the single fact that would kill the design: the entire carrier is
  a host bind mount, and an install whose compose file belongs to somebody else
  has no door at all.
- **Is it one toolchain or four?** If four mounted repositories genuinely need
  four different toolchains, `01d-` §3's refusal of per-folder selection is the
  wrong refusal and `18-option-repo-manifest.md` is where the question restarts.

---

## 6. Reasoned versus observed, for the whole directory

**Observed in this container**, and each says so where it is claimed:

- `command -v unzip` returns nothing while `tar`, `python3`, `curl`, `jq`,
  `sha256sum` and `install` all resolve;
- `python3 -m zipfile -e` extracts a `0755` file at `0644`;
- `dpkg --print-architecture` returns `arm64` where `uname -m` returns `aarch64`;
- the Terraform URLs and digests in `01b-` §5 and the shellcheck and shfmt URLs
  and digests in `01g-` §6, fetched from their publishers on 2026-09-12;
- both of `01g-`'s binaries run here: `shellcheck --version` prints
  `version: 0.11.0` and `shfmt --version` prints `v3.14.1`;
- every citation and every quotation in the eleven current files, per §1.

**Reasoned and not observed** - everything else, and the list is short because
the boundary is sharp:

- **every statement about what survives a rebuild or a `down -v`**, which is all
  of `01a-` §3 and therefore R4 in both halves;
- **every statement about what the applier does**, because it does not exist;
- **R3's third link**, permission to invoke, which §5's first command settles;
- **everything about the read-only bind mount**, including the sentence that root
  inside the container cannot write it;
- **the boot timings in `01e-` §3**, including whether an install can outrun
  `Dockerfile:737`'s 180-second start period;
- **the seccomp profile in any form.** `docker-compose.yml:567-568` ships it
  commented out and it has been parsed, never applied.

**And one thing that is neither**: `/data` is **empty** in this container -
`ls -a /data` returns `.` and `..` and nothing else at `fd07353`, and no
UsageFoundry database exists anywhere reachable from it. (The original survey
recorded `ls -la /data` → `Permission denied`; the directory is readable now and
has nothing in it, which changes the reason and not the consequence.) So there is
**no figure anywhere in this directory** for how many runs would have used a
stack tool, how often an operator installs one, or how long a boot currently
takes. Every cost argument here is
about what a change costs to build, never about what the status quo costs to run.
