# The problem, and what three weeks of the status quo cost

**The decision to build is recorded at the top of [README.md](README.md). This
file no longer argues whether there is a problem; it measures one.** What it
establishes is that the request is real and recurring, that the only route this
container offers today is the one R1 forbids, and that the repository's own
comments are a written record of operators taking that route because nothing
else exists.

The operator's request, in their words:

> Persistent custom stacks that the user can deploy from the web interface. My
> imagination of it is that there is a point on the left menu called Terminal
> where users can run terminal commands on the container's CLI. The things
> installed by that CLI — let's take Terraform for an example — should then be
> available to all runs and sandboxed runs, and survive a rebuild of the
> container.

And the reframing that supersedes it, 2026-09-12: **it is not about whether we
do it, it is about how.** Tools must reach UsageFoundry without the published
container being modified, and the mechanism must be modular and easy for other
people to use for their own tools. The five requirements that follow from that
are [01-constraints.md](01-constraints.md).

---

## 1. What the status quo cost, measured

The survey that closed this directory on 2026-08-25 concluded that the problem
was mostly solved. **In the three weeks after it closed, the image was edited
twelve times.**

```bash
git log --since=2026-08-25T00:00:00 --format='%h %cd %s' --date=format:'%Y-%m-%d' -- Dockerfile
#   12 commits at 6c5af5f
```

Use the `T00:00:00` form. A bare `--since=2026-08-25` fills the missing
time-of-day from the current clock, so it returns 11 or 12 depending on the hour
you run it: `94e9250` lands at 10:57 UTC on the boundary day.

| Commit | Date | What it changed in the image | Kind |
|---|---|---|---|
| `94e9250` | 2026-08-25 | `chown -R node:node "${PLAYWRIGHT_BROWSERS_PATH}/.links"`, so `playwright install` can rewrite its own link file; root-owned, the no-op re-install dies EACCES under *"Failed to install browsers"* (`Dockerfile:483`) and the run fetches a second Chromium into a path it can write | a tool install repaired |
| `9cc0935` | 2026-08-25 | `jq` on the runtime apt line (`Dockerfile:130`), roughly 1 MB with libjq1 and libonig5 | **a new tool** |
| `61871d9` | 2026-08-26 | `WINNOW_REF` 79dd165 to 4512a0c, so `winnow plan` and `winnow fork` exist as subcommands at all | a tool version |
| `478e4dd` | 2026-08-26 | `WINNOW_REF` to fb49802, winnow 1.9.0 | a tool version |
| `c50e519` | 2026-08-28 | `WINNOW_REF` to 0384486 | a tool version |
| `15fd18b` | 2026-08-28 | drops `/app` from the `chown -R node:node` line | **not a tool**: an ownership boundary |
| `ceb9763` | 2026-08-28 | creates `/var/lib/winnow` (`Dockerfile:622`, `:654`), outside the `chown -R`, for the intake filter's ledger | a tool's state directory |
| `546a0a5` | 2026-08-28 | merge carrying `15fd18b` | duplicate of the row above |
| `d30704f` | 2026-09-04 | `WINNOW_REF` to 0421da5, because `winnow context` does not exist at the old pin and fails there as an unknown command | a tool version |
| `005fa72` | 2026-09-04 | `CLAUDE_CLI_VERSION` 2.1.226 to 2.1.260 (`Dockerfile:408`) | a tool version |
| `8d0a1b6` | 2026-09-06 | 47 lines installing `@openai/codex` globally (`Dockerfile:556`) | **a new tool** |
| `6d48c7a` | 2026-09-11 | `WINNOW_REF` to 4b1b7b1 (`Dockerfile:376`) | a tool version |

**Twelve commits, eleven distinct changes**, since `546a0a5` is a merge of
`15fd18b`. **Ten of the eleven are about a tool**: two tools added, six version
pins, one tool state directory, one install repaired. One is not.

**Read that honestly and it is weaker than a raw twelve, and still decisive.**
Six of the ten are version pins of tools this app itself spawns, `winnow` and
the Claude CLI, which is dependency maintenance rather than an operator
installing Terraform, and R1 would not remove them. **The two that are exactly
the request are `jq` and `codex`**, and both are an operator wanting a command on
an agent's `PATH` and having no route but editing the shipped image.

In the same window: `git log --since=2026-08-25T00:00:00` returns **10 commits
to `docker-entrypoint.sh`** and **14 to `docker-compose.yml`**. Those two counts
are not classified here and should not be read as ten and fourteen more tools.

## 2. The repository's own comments are the evidence

The Dockerfile makes the same argument **three times, by name**, each time for a
different tool, and each time the argument is R1's:

> It belongs in the image rather than in an agent's first Bash call for the
> reason the Go block below gives: apt is root's and the agents are
> UF_AGENT_UID, and a package installed into the writable layer is discarded by
> the next `up --build`.
> `Dockerfile:78-82`, for `jq`

> In the image rather than installed by hand, on exactly the argument the Go and
> gh blocks above make: a shell `npm install -g` survives `docker restart` and
> is discarded by the `docker compose up --build` this project is deployed with,
> so what an agent meets after the next upgrade is `playwright: not found`
> inside a tool call — which the run loop reads as the agent deciding not to
> look.
> `Dockerfile:443-447`, for Playwright

> In the image rather than installed by hand, on the argument the gh, Go and
> Playwright blocks above all make: an `npm install -g` typed into a shell
> survives `docker restart` and is discarded by the `docker compose up --build`
> this project is deployed with, so what the next upgrade hands an agent is
> `codex: command not found` inside a tool call — which no part of the run loop
> reads, and which ends the cycle looking like the agent decided not to run it.
> `Dockerfile:521-527`, for the Codex CLI

Three writers, three tools, one sentence. **Nobody chose to edit the published
image. Each of them wrote down that there was no other way**, and each named the
same failure: the tool is absent, the failure lands inside a tool call, and the
run loop files it as the agent choosing not to act. That is R5's finding arrived
at independently three times, and it is why R5 is a requirement rather than a
nicety.

Playwright's own block landed at `70a684d` on 2026-08-24, the day before this
directory closed, and is outside the window above; only its repair is inside it.

## 3. What ships today, works, and is the design's closest prior art

Three named volumes exist for this problem and the compose file argues each one
out:

| Volume | Mounted at | Holds | Line |
|---|---|---|---|
| `usagefoundry-gocache` | `/home/node/go` | `GOPATH` + `GOCACHE` | `docker-compose.yml:445` |
| `usagefoundry-gh` | `/home/node/.local/share/gh` | `gh` extensions | `:459` |
| `usagefoundry-pytools` | `/home/node/pytools` | uv-installed Python tools, their bin dir, and a fetched interpreter | `:471` |

Two of the three have a **declarative, boot-time install loop** behind them:
`docker-entrypoint.sh:169-211` for `UF_GH_EXTENSIONS` and `:241-310` for
`UF_PY_TOOLS`. So an operator can already write

```
UF_PY_TOOLS=cozempic==1.8.39 ruff==0.6.9
UF_GH_EXTENSIONS=dlvhdr/gh-dash github/gh-copilot@v1.1.0
```

in `.env`, restart, and have those commands on every agent's `PATH`, surviving
every rebuild and reinstalled on a fresh host. Both are documented for the
operator at `docs/install.md:141` and `:192`.

**Score that against the five requirements and it is closer than it looks.**
R1 met: adding a `uv`-installable tool edits nothing in the image. R3 met on
links 1 and 2, open on link 3. R4a met. R4b met in the strongest sense
available, because the declaration outlives the volume: `down -v` destroys the
volume and the next boot reinstalls from `.env`. **R2 is where it fails**, on
one of the four tests in `01-constraints.md` R2: a line in a shared `.env` is
not a unit a third party can hand you, and merging two operators' lines is a
text edit rather than an act of consumption. **R5 fails outright.**

**So the design is not starting from nothing. It is starting from a mechanism
that satisfies four of five requirements for two package managers, and the work
is generalising the artifact and building the read-back.**

## 4. What is missing, stated against the requirements

### Missing 1, against R2: there is no general installer

The two loops are tied to two package managers. `uv tool install` installs
Python distributions; `gh extension install` installs `gh` extensions.
**Neither installs a statically-linked binary from a release tarball, which is
what Terraform, `kubectl`, `helm`, `mise` and most of the tools an operator
means by "a stack" actually are.**

The container holds the pieces: `curl`, `jq` and `git` from the runtime apt line
(`Dockerfile:127-132`), plus `tar`, `sha256sum` and `install` from the Debian
base. `Dockerfile:173-175` is a worked example of the pattern for `gh` itself,
downloading a pinned release, verifying a checksum, and `install -m 0755`ing it.
What is missing is a version of that loop whose target is a **volume** rather
than an image layer, and whose input is an artifact somebody can share.

### Missing 2, against R4 and C6: the tool's own state

A binary is not a toolchain. `01-constraints.md` C6 has the table of which four
`$HOME` subdirectories are persistent and which are not. The short version:
`$HOME/.npm` is on no volume and is discarded by every rebuild, while `$GOPATH`
is on one, and `BUILD_CACHE_DIRS` (`src/lib/orchestrator.ts:5327-5330`) names
both as the caches a build touches. A stack that ships a binary and not the
relocation of its state ships half a tool, and the operator's symptom is a slow
work cycle rather than an error.

### Missing 3, against R3: a work cycle may not be permitted to run it

**This is the finding that most contradicts the operator's mental model and it
is still unmeasured.** The shipped permission mode for a run is `acceptEdits`
(`src/lib/settings.ts:940`), and what that mode does is documented twice in the
tree with a measurement attached each time:

> `acceptEdits` auto-approves file edits and read-only shell, and holds mutating
> git for a human — `git add` and `git commit` both come back "This command
> requires approval", and a `-p` child has nobody to give it. […] Measured, not
> reasoned: one run tried seven times, in five phrasings, and was refused every
> time, finished as `completed`, and left its whole change sitting uncommitted.
> `src/lib/cycleInvocation.ts:605-614`

> Measured across this install's whole window: 19 of 58 completed resolutions,
> $109.94 of $233.85, say in their own report text that they could not compile
> or test what they had merged.
> `src/lib/settings.ts:386-392`

The app's answer, both times, has been a **named grant on `--allowedTools`**,
never a mode change: `ISOLATED_GIT_TOOLS = ["Bash(git add:*)", "Bash(git
commit:*)"]` (`src/lib/cycleInvocation.ts:633`).

Link 3 does not bite the two existing loops because of *how* their tools are
invoked: a `gh` extension or a `UF_PY_TOOLS` tool is reached by a **plugin
hook**, which the CLI runs itself rather than as a `Bash` tool call
(`Dockerfile:271-274`). **Terraform is not a hook.** It is a command a model
types into `Bash`, and that is the path `acceptEdits` gates.

**What is not established.** Nobody here has measured what the pinned CLI
classifies as "read-only shell". `terraform version` and `terraform plan` may
well pass where `terraform apply` does not. Both measurements above are of git,
not of an arbitrary unknown binary, so this is **assumed** from two adjacent
measurements rather than measured. The probe is
[07-option-make-it-runnable.md](07-option-make-it-runnable.md) §10 and it costs
one work cycle.

### Missing 4, against R5: nothing in the app can see any of it

`ls src/app/api/` returns 27 entries, 26 of them route directories, and none is
`tools` or `stacks`. `grep -rn "UF_PY_TOOLS\|UF_GH_EXTENSIONS" src/` returns no
reader: two docblock mentions in `src/lib/contextPruning.ts:98-99` and three in
`src/lib/deployment.test.ts`. An operator who sets `UF_PY_TOOLS` and restarts
learns whether it worked by reading the container's boot log for
`[usagefoundry] installed Python tool` (`docker-entrypoint.sh:297`) or the
`could not install` line beside it (`:306-307`). **That is the whole read-back,
and it is unchanged since this directory closed.**

## 5. Which children have to see it (R3)

Every one of these gets the image's `PATH` unchanged.
`src/lib/git.test.ts:97` pins it with `assert.equal(env.PATH, process.env.PATH)`.

| # | Child | Spawn site | env fn | Mode |
|---|---|---|---|---|
| 1 | Work cycle | `src/lib/orchestrator.ts:6262` | `childEnv` (`orchestrator.ts:5698`) | `acceptEdits` (`settings.ts:940`) |
| 2 | Reviewer | `src/lib/review.ts:797` | `reviewEnv` (`review.ts:923`) | `plan` (`review.ts:268`) |
| 3 | Conflict resolver | same site | `reviewEnv` | `acceptEdits` (`land.ts:1450`) |
| 4 | Orchestrator chat turn | `src/lib/chat.ts:2940` | `chatEnv` (`chat.ts:3826`) | `bypassPermissions` (`chat.ts:2833`) |
| 5 | Workflow orchestrator block | same site | `chatEnv` | `bypassPermissions` |
| — | `claude auth` | `src/lib/claudeAuth.ts:306`, `:418` | `authEnv` (`:260`) | n/a |
| — | `codex auth` | `src/lib/codexAuth.ts:399`, `:551` | own | n/a |
| — | git | `src/lib/git.ts:233` | `gitEnv` (`:51`) | n/a |
| — | winnow | `src/lib/contextPruning.ts` (five sites) | `pruneEnv` (`:1444`) | n/a |
| — | land gate | `src/lib/landGate.ts:140` | own | n/a |

The agent children drop to the agent uid through `childCredentials()`
(`src/lib/privsep.ts:252`), the chat child through `chatChildCredentials()`
(`:274`). **The `codex auth` and land-gate children did not exist when this
directory closed**, which is its own small argument: the set of children a stack
must reach grows.

**So `PATH` is not the problem, and a design that only fixes `PATH` fixes
nothing that is broken.** The two things that differ across these children are
the **permission mode**, which decides whether the tool can be invoked at all,
and, if `UF_SANDBOX` is ever switched on, the **write set**, which decides
whether the tool can write its own cache.

One live hazard worth carrying into the design: `/home/node/pytools/bin` is on
the **server's** `PATH` and is agent-writable, which
`src/lib/contextPruning.ts:98-99` names and works around by resolving an
absolute interpreter rather than a name. Any new stack directory on a root
process's `PATH` inherits it.

## 6. "Sandboxed runs" names at least six different things

The operator's phrase does not resolve, and two of the six change the answer
while four do not.

1. **Git worktree isolation.** Changes cwd and nothing else: not `PATH`, not
   `$HOME`, not the uid. *No effect.*
2. **Permission modes.** Always in force, and per Missing 3 the one thing that
   decides whether a tool can be run. **Decisive.**
3. **The uid split.** Server root (`docker-compose.yml:64`), children at
   `UF_AGENT_UID` (`:280-281`). *Decides who may upgrade or remove an installed
   tool*, which is why both existing loops install under `setpriv`
   (`docker-entrypoint.sh:147`, `:218`).
4. **The CLI's bubblewrap sandbox**, `UF_SANDBOX`, read only by
   `docker-entrypoint.sh:362` and **shipped off**, with its compose prerequisite
   commented out at `docker-compose.yml:567-568`. **Decisive if ever switched
   on**, because a write config binds `/` read-only and rw-binds only the allow
   set (`src/lib/orchestrator.ts:5310`), and no tool state directory is in it
   (`:5327-5330`).
5. **The read guard.** A `PreToolUse` hook on the `Read` tool only. *No effect:
   it does not see Bash.*
6. **`UF_LOCK_CLAUDE_HOME`.** Root-owns `~/.claude`. Off by default. *No
   effect.*

The sentence to lead with when correcting the mental model is the module
header's own: *"Nothing here turns a sandbox on. This app configures none."*
(`src/lib/sandbox.ts:8-9`).

**Two consequences for R3.** First, "available to all runs and sandboxed runs"
is not two cases today: there is no isolation mechanism here that a `PATH` entry
does not already cross. Second, the *one* configuration in which it would be two
cases, `UF_SANDBOX=1`, is exactly the one where an installed tool's write path
breaks, and it breaks inside a tool call the run loop does not read.

## 7. What could not be reached

- **Any rebuild.** Docker is not installed in this container, so no claim about
  what survives `docker compose up --build` or `down -v` was observed. Every one
  is **assumed** from the compose file's own statements and Docker's documented
  semantics. `01-constraints.md` Part 4 has the commands.
- **Whether an arbitrary binary is invokable under `acceptEdits`**, the single
  most decisive unknown here, assumed from two adjacent measurements rather than
  probed.
- **Terraform, or any real stack tool.** None was downloaded, installed or run.
- **The seccomp profile in action.** `docker-compose.yml:567-568` ships it
  commented out.
- **`/data`, and therefore all run history.** `ls -la /data` returns
  `Permission denied`, so there is no figure anywhere here for how many runs
  would have used a stack tool.
- **`docs/verification.md` still records nothing about any of it.**
  `grep -n "UF_PY_TOOLS\|UF_GH_EXTENSIONS\|usagefoundry-pytools\|gocache" docs/verification.md`
  returns **zero lines** at `6c5af5f`. When this directory closed, that grep
  returned one line about a guard; it now returns none. **The mechanism the
  design builds on has never been executed against a real rebuild.**
