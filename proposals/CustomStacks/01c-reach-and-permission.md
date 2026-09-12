# Reach, permission, and the one measurement still owed

**R3 is the requirement this directory has never been able to close, and the
reason is one link of three.** This file settles the two that can be settled from
the tree, states the third as unmeasured, designs for the worse answer, and gives
the exact command that would let the design be simplified.

Checked against the tree at `baf051d`. The probe in §4 has **not been run**;
this container has no Docker and no way to spawn a `claude` process against a
real install.

---

## 1. The three links

R3 is met, per child kind, when the binary exists on disk after a rebuild, it is
on that child's `PATH`, and **the child is permitted to invoke it**.

| Link | Status | What settles it |
|---|---|---|
| 1. exists on disk | settled by design | `01a-` §3: a named volume plus a host-side declaration that reinstalls it |
| 2. on `PATH` | **settled, and pinned by a test** | §2 |
| 3. permitted to invoke | **never measured** | §3, §4 |

---

## 2. Link 2, `PATH`, which is already pinned

`ENV PATH="/var/lib/uf-stacks/bin:${PATH}"` in the `Dockerfile` puts the toolbox
on the server's `PATH`, and from there it reaches every child because the env
builders copy the server's environment and strip prefixes and names that do not
include `PATH`:

> Everything else passes through. The CLI needs PATH, HOME, CLAUDE_CONFIG_DIR,
> proxy and CA settings, and locale to function at all
> `src/lib/orchestrator.ts:5628`, over the strip list at `:5698-5716`

**The test that pins it is `src/lib/git.test.ts:88`**,
`it("passes PATH through so a repo-local hook resolves")`, whose assertion is
`assert.equal(env.PATH, process.env.PATH)` at `:96`. That is the sentence the
task of finding it asks for: `PATH` passing through is not a property this design
has to establish, it is one an existing test would fail on if somebody removed
it.

One layer down, `src/lib/deployment.test.ts:1029`,
`it("puts uv's launcher directory on the PATH a hook resolves through")`, pins
the `Dockerfile` half for `/home/node/pytools/bin`. The new `ENV PATH` line is
the same shape and gets the same assertion, which is the second of the three
`deployment.test.ts` additions `01a-` §9 lists.

**Under `UF_SANDBOX=1`, reading and executing are unaffected.** A write config of
any kind makes the CLI bind `/` read-only and rw-bind only the allow set
(`src/lib/orchestrator.ts:5310`); read-only is not unreadable, and the only
`denyRead` entries the entrypoint writes into the managed settings are
`DATA_DIR` and `/backups` (`docker-entrypoint.sh:432`). `/var/lib/uf-stacks` is
neither, so a binary living outside the image is readable and executable by a
sandboxed run exactly as one inside it is.

**Writing is where one path has to be added, and it is one path for the
mechanism rather than one per tool.** The rw-bind allow set is the run's cwd plus
`BUILD_CACHE_DIRS`, which is two entries, `$HOME/.npm` and `$GOPATH`
(`src/lib/orchestrator.ts:5327-5330`), applied for a run at `:5396` and for the
assist at `:5413`. **No tool state directory is in it today**, which is the whole
of what a sandbox does to this design. `/var/lib/uf-stacks/state` joins it as a
third entry, and it is single because `01a-` §2.2 puts every stack's state under
one tree rather than letting each stack choose a path.

---

## 3. Link 3, and why the design assumes the worse answer

**What is known.** A work cycle runs `acceptEdits`
(`src/lib/settings.ts:940`) and the code states what that mode does:

> `acceptEdits` auto-approves file edits and read-only shell, and holds mutating
> git for a human
> `src/lib/cycleInvocation.ts:605-614`

The same docblock records the measurement behind it: a run tried to commit
*"seven times, in five phrasings, and was refused every time"*, which is why
`ISOLATED_GIT_TOOLS = ["Bash(git add:*)", "Bash(git commit:*)"]`
(`src/lib/cycleInvocation.ts:633`) exists at all. The second measurement is in
`src/lib/settings.ts:386-392`: *"19 of 58 completed resolutions, $109.94 of
$233.85, say in their own report text that they could not compile or test what
they had merged"*.

**What is not known.** Neither measurement is of an arbitrary unknown binary.
Whether `terraform version` passes where `git commit` does not turns on how the
CLI classifies a command it has never seen, and **nothing in this repository
measures that.** The phrase in the docblock is *read-only shell*, and a binary
the CLI has no model of is not obviously in that class, so the working assumption
here is that **it is refused** - stated as an assumption, not as a finding.

**The design under that assumption.** A stack's `allow` array is projected onto
the work cycle's `--allowedTools`. The argv builder already has exactly this
shape at `src/lib/cycleInvocation.ts:1190-1225`, which assembles
`["-p", prompt, "--output-format", "stream-json", "--verbose"]`, then `--model`,
`--permission-mode`, then `--allowedTools` with `ISOLATED_GIT_TOOLS` and
`SEARCH_TOOLS` spread into it, then `--disallowedTools` with `PROCESS_KILLERS`.
The stack grants become a third spread list, derived from the receipts whose
status is `ok`, and the builder's own comment is the rule that makes this safe:
`--allowedTools` **names what skips the prompt, and everything else still follows
the mode**. Granting `Bash(terraform plan:*)` does not widen anything else.

**Install-wide, not per run.** `14-stack-object-model.md` §7 found that all three
doors a per-run stack selector could attach to are closed by name, and this
design does not reopen them: every `ok` stack's grants reach every work cycle.
The narrowing that matters is done by the stack author in `allow`, not by the run.

---

## 4. The exact command that measures it

**Two commands, and the first is the one to run.** It costs one short headless
turn rather than a work cycle, it needs no run, no folder and no branch, and it
isolates the single variable.

The uid must be read out of the container rather than taken from `${UF_UID:-1000}`
in the operator's own shell, because `.env` is compose's input rather than an
exported environment - `docs/install.md:44-50` gives the same idiom for signing
the CLI in, down to the `printenv UF_AGENT_UID`.

```bash
# A. Put one binary the CLI has never heard of on a directory on PATH.
docker compose exec -T usagefoundry sh -c '
  mkdir -p /var/lib/uf-probe/bin &&
  printf "#!/bin/sh\necho probetool 9.9.9\n" > /var/lib/uf-probe/bin/probetool &&
  chmod 0755 /var/lib/uf-probe/bin/probetool'

# B. No grant. This is what a work cycle looks like today.
docker compose exec -T \
  -u "$(docker compose exec -T usagefoundry printenv UF_AGENT_UID)" \
  -e PATH=/var/lib/uf-probe/bin:/usr/local/bin:/usr/bin:/bin \
  usagefoundry claude \
    -p 'Use the Bash tool to run the command `probetool`, then reply with exactly the line it printed.' \
    --output-format stream-json --verbose \
    --permission-mode acceptEdits

# C. With the grant this design projects. Identical but for the last flag.
docker compose exec -T \
  -u "$(docker compose exec -T usagefoundry printenv UF_AGENT_UID)" \
  -e PATH=/var/lib/uf-probe/bin:/usr/local/bin:/usr/bin:/bin \
  usagefoundry claude \
    -p 'Use the Bash tool to run the command `probetool`, then reply with exactly the line it printed.' \
    --output-format stream-json --verbose \
    --permission-mode acceptEdits \
    --allowedTools 'Bash(probetool:*)'
```

Read the `stream-json` for `probetool 9.9.9` and for any event naming a
permission denial.

**Four outcomes, each deciding a different thing.**

| B | C | What it means |
|---|---|---|
| prints the line | - | **The grant is unnecessary.** Delete §3's projection: one list, one spread, and the `allow` field becomes advisory rather than load-bearing. `01b-` keeps `allow` as documentation of what the stack is for, or drops it |
| refuses | prints the line | **The design is correct as written.** The grant is necessary and sufficient, and a stack with an empty `allow` is the quiet failure `01a-` §8 names |
| refuses | refuses | The refusal is not about the allowlist. Look at `--disallowedTools`, at the `--settings` file the builder writes at `cycleInvocation.ts:1300`, and at whether a sandbox write config is in play |
| refuses | errors on the flag | The CLI's allowlist syntax has moved since `ISOLATED_GIT_TOOLS` was written. `claude --help` and re-derive; this would also mean two existing grants are silently dead, which is a defect worth filing on its own |

**The confirming measurement is still `07-option-make-it-runnable.md` §10**, a
real run at `acceptEdits` asked to invoke the tool, because only that exercises
the whole spawn path: the `--settings` file, the appended system prompt, the
plugin directory, the taskboard MCP config and the agent uid together. The probe
above isolates the variable; the run confirms nothing else interferes. Run the
probe first: if B prints the line, the run is not needed at all.

---

## 5. The five child kinds, one by one

The kinds, their spawn sites and their modes are [00-problem.md](00-problem.md)'s
table; what follows is only what this design does to each.

**Work cycle, `acceptEdits`.** `PATH` yes; grant projected from the receipts.
This is the kind the whole question is about and the only one the probe measures.

**Reviewer, `plan`.** `PATH` yes; **no grant, and that is correct.** `plan` is a
read-only mode, so a reviewer cannot run a tool whatever any allowlist says. A
reviewer that could run `terraform apply` while reading a diff would be a defect,
not a feature. R3 is met for this kind by links 1 and 2 alone, and link 3 is
answered *no* deliberately.

**Conflict assist, `acceptEdits`.** Same as the work cycle. Note that this is the
one caller of `resolveAllowedTools`, which defaults to `[]`
(`src/lib/settings.ts:994`) and is read at `src/lib/land.ts:1441` - so the assist
already has an operator-configurable allowlist beside the stack projection, and
the two are additive rather than in conflict.

**Chat turn, `bypassPermissions`.** `PATH` yes; **no grant needed.** The mode
already skips the prompt. Nothing about this design changes what a chat turn may
run, which is worth saying out loud: a stack installs a binary that a chat turn
could already have invoked had it existed.

**Workflow orchestrator, `bypassPermissions`.** As the chat turn.

So the projection in §3 exists for two of the five kinds, is refused by the mode
for one, and is redundant for two. That is an argument for keeping it small and
derived rather than for making it configurable.

---

## 6. What this leaves open

**Nothing in this file has been run.** The probe is written, priced at one short
headless turn, and unexecuted. Until somebody runs it, the sentence that belongs
in `docs/verification.md`'s *Not yet verified by hand* list is: *whether a work
cycle at `acceptEdits` may invoke a binary the CLI has never seen, with and
without a `Bash(<name>:*)` grant; §4 of `proposals/CustomStacks/01c-` has the
commands.*

**The design does not depend on the answer**, which is the point of assuming the
worse one. A wrong assumption here costs one deletable list; the opposite
assumption, had it been taken, would cost a redesign discovered inside a tool
call nobody reads.
