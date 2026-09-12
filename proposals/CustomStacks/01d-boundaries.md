# Boundaries: what stays in the image, and what this design does not do

Two questions the design has to answer out loud so the next run does not have to
guess at either. The first is the migration question: twelve `Dockerfile` commits
since 2026-08-25 are the evidence this feature exists, and whether they should
now move out of the image is a decision rather than an assumption. The second is
the refusal list.

Checked against the tree at `baf051d`.

---

## 1. Where the boundary between a stack and the two existing `UF_*` lists sits

**Neither `UF_GH_EXTENSIONS` nor `UF_PY_TOOLS` is removed, deprecated or
rewritten.** Both already meet R1 at a per-tool cost of one `.env` line
(`docker-entrypoint.sh:159-161` and `:233`), both are pinned by tests
(`src/lib/deployment.test.ts:905`, `:978`, `:1045`), and replacing something that
works with something that works differently is churn an operator pays for.

The line between them:

- **a `UF_*` list** is right when the whole declaration is one package name from
  one registry, and you want nothing else. It has nowhere to put a checksum, an
  environment variable, a state directory or a permission grant.
- **a stack** is right when you need any of those, or when you want the thing to
  be an artifact somebody else can take. R2 is the whole difference: a `.env`
  line is not a unit, and `01-constraints.md` already rules that it passes three
  of R2's four tests and fails the fourth.

A stack's `uv-tool` verb exists so a tool can move from the first to the second
without changing how it is installed, only where it lands.

---

## 2. The migration question, answered

`git log --since=2026-08-25T00:00:00 --format='%h|%s' -- Dockerfile` returns
twelve commits at `baf051d`: **five winnow pins and drops** (`6d48c7a`,
`ceb9763`, `c50e519`, `478e4dd`, `61871d9`), one context feature that touched the
image (`d30704f`), one Claude Code version bump (`005fa72`), one merge
(`546a0a5`), one `chown` repair (`15fd18b`), and **three that add or repair a
tool an agent invokes**: `8d0a1b6` (codex pre install), `9cc0935` (added JQ) and
`94e9250` (fixed playwright integration).

[README.md](README.md) counts the same twelve as *"eleven distinct changes, ten
of them about a tool"*, which is the wider reading: it counts a version pin as
being about a tool. Both are true of the same list, and the narrower count is
used here because the question in this section is which tools would become
stacks, and a pin never would.

**Recommendation: all twelve stay in the image. None of them moves to a stack.**

The sorting rule that makes this a rule rather than an opinion, and the one a
reviewer should apply to the *next* `Dockerfile` commit:

> **A tool this app's own code shells out to belongs in the image. A tool only an
> agent invokes belongs in a stack.**

Because the first kind is a dependency of the product, it must be present for the
app to work at all, and a dependency whose absence is an operator's configuration
error is a dependency that fails at the worst possible moment. `Dockerfile:311-314`
already states the harder half of the same rule for the run loop's own binary:
root-owned, 0755, in a directory no agent can rewrite.

Measured against the rule, by counting references:

| Tool | `src/` | `scripts/` | Verdict |
|---|---|---|---|
| `codex` | **15 files**, including `src/lib/codexAuth.ts`, `src/lib/codexRules.ts`, `src/lib/cycleInvocation.ts` and three `/api/codex-auth/` routes | none | image. It is a run *engine* here, not a tool an agent happens to call |
| `winnow` | **12 files**, including `src/lib/contextPruning.ts`, `src/lib/retention.ts`, `src/lib/intakeFilter.ts` | none | image, and it is the binary `Dockerfile:311-314` was written about |
| `playwright` | `src/lib/cycleInvocation.ts` | `scripts/smoke-pages.mjs` | image. `npm run smoke-pages` is a repository check and cannot depend on the operator having copied a directory |
| `jq` | **none** | `scripts/file-health-check-issues.sh` | **the one misfiled tool**, and it still stays - see below |

Commands: `grep -rl` for each name over `src/` excluding tests, and over
`scripts/`, at `baf051d`.

**`jq` is the interesting row and the recommendation does not change for it.**
`9cc0935` is the commit `01-constraints.md` names as *precisely the shape R1
forbids*: one word added to `Dockerfile:130`. Nothing under `src/` references it.
By the rule it is a stack. It stays anyway, for three reasons, and they are worth
stating because they are the reasons *any* migration would fail:

1. `scripts/file-health-check-issues.sh` uses it, so moving it makes a repository
   script depend on an operator's `./stacks` directory - which is exactly the
   failure mode the rule exists to prevent, arriving from the other direction.
2. R1 constrains what the **twelfth** tool costs, not the first eleven. Moving
   `jq` out buys nothing against any of R1 to R5 and costs a working install.
3. Every migration is a chance to be wrong in the direction that is hardest to
   see. A tool that vanishes from the image is a tool whose absence is discovered
   inside a tool call nobody reads, which is `.env.example:245-249`'s 213
   sessions, and there is no reason to take that risk for a 4 MB binary that is
   already there.

**The rule's job is forward-looking.** It is what a reviewer says to the
thirteenth `Dockerfile` commit: *does `src/` shell out to this? If not, it is a
stack, and here is the directory to write.* If this design ships and the
`Dockerfile` still accretes agent-facing tools, the mechanism has failed on its
own terms and that is the thing to measure six months out - `git log --since`
over `Dockerfile`, exactly as this section was written.

---

## 3. What this design deliberately does not do

Each of these was considered and refused. The next run should build none of them,
and if it wants one, it has to argue against the reason rather than notice the
gap.

**No operator-facing surface.** No pane, no card, no route, no settings field.
`01a-` §7 fixes the receipt format so there is something to read; the reading is
the third run's and `C9`'s nine-digits-against-eleven-rows argument bears on it.

**No install from inside the app.** No endpoint, no button, no MCP tool, no chat
proposal that installs a stack. `01a-` §6 gives the three reasons and the sharpest
is that `/api/settings` is reachable with the master key, so an install endpoint
is remote code execution with this app's authentication in front of it;
`src/lib/config.ts:494-508` already refuses a smaller version of the same thing
with the sentence that decides it: *"Here it takes a container restart, which is
a decision a person makes at a shell."*

**No run-time or on-demand install.** Boot only. `PATH` must be final before the
server starts, `createRun` may not `await` (`C7`), and the applier's agent-uid
staging is safe only in the window where no agent process exists.

**No per-run, per-folder, per-template or per-agent stack selection.**
> **SUPERSEDED for per-folder by [23-revision-per-repo-and-login.md](23-revision-per-repo-and-login.md) §2.**
> The operator was asked and the answer is ten repositories inside one mount,
> all needing different stacks. `14-` §7's argument below is true of the
> *installation* and false of the *selection*, and it missed a fourth door that
> ships today. Per-agent, per-template and per-run stay refused. Original text
> follows.

Every `ok`
stack reaches every child. `14-stack-object-model.md` §7 found all three doors
such a selector could attach to closed by name, and this design does not reopen
them. If four mounted repositories genuinely need four toolchains, that is a new
question and `18-option-repo-manifest.md` is where it starts.

**No dependency graph between stacks.** No `depends_on`, no topological sort.
Lexical order by directory name, and two things that must be ordered are one
stack.

**No registry, no `stack install <url>`, no fetch-a-stack-from-the-internet.** The
operator copies a directory by hand. That the copy is manual is what makes the
host filesystem the trust boundary, and a fetch verb would put the boundary back
inside the container where `18-`'s one-sentence approval could not hold it.

**No signature or key verification.** Digests only, against the publisher's own
manifest, exactly as the image already does (`Dockerfile:163-175`). Inventing a
trust root for stacks is a larger decision than this design and this repository
holds no key material.

**No `apt-get`, no system packages, no fourth verb for them.** They cannot be
pinned per install, cannot be removed cleanly, and would need root at run time.
An operator who truly needs a system package has `05-option-image-is-the-stack.md`'s
derived image, which this design rules out as *the* answer (`01a-` §2.4) without
forbidding anybody from building one.

**Nothing about namespaces, `chroot` or nested containers.** `C5` records that
plain `unshare -U` fails here at both seccomp settings
(`docker-compose.yml:534`), and no volume fixes that. A stack whose tool wants to
build its own sandbox does not work in this container and this design does not
change it.

**No per-run isolation of tool state.** `state/<stack>` is shared by every
concurrent run. `C10` is why this costs nothing new: nothing here turns a sandbox
on, and a run already shares a uid, a `$HOME`, a `PATH` and a filesystem with
every other run (`src/lib/sandbox.ts:8-9`). If that ever stops being true, this
is one of the things that has to change with it.

**No change to `UF_GH_EXTENSIONS` or `UF_PY_TOOLS`**, per §1, and **no change to
the twelve `Dockerfile` commits**, per §2.

**No claim that any of the persistence works.** Every statement in `01a-` §3 is
reasoned from `docker-compose.yml` and `docker-entrypoint.sh`; **this container
has no Docker** and no volume in this repository has ever been observed outliving
a rebuild - `grep -n "UF_PY_TOOLS\|UF_GH_EXTENSIONS\|usagefoundry-pytools\|gocache" docs/verification.md`
returns zero lines at `baf051d`. `01-constraints.md` Part 4 has the commands, in
the order that buys the most.
