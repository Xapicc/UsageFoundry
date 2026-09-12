# Revision: per-repository stacks, and a login

**The operator answered the three questions this directory had named decisive
and never asked.** Five runs named them; none asked. They were asked on
2026-09-12 and answered in two sentences. This file is what the answers move.

> **Q1 — do you own the directory holding `docker-compose.yml`?**
> *"yes i do, it wouldnt be a problem but it would be nicer if i dont"*
>
> **Q3 — do four mounted repositories need four toolchains?**
> *"each workspace thats mounted could hold 10 repos that all need completly
> different stacks"*
>
> **Q2 — do you expect to type `apt-get`, a login, or a two-step install?**
> *"A login I guess"* — narrowed in the same conversation to **a token pasted
> into configuration**, not an interactive flow and not a host-side credential
> file (§5.2 case 1).
>
> **Two rulings made in the same conversation, and neither was a question this
> directory had asked:**
>
> **The grant is a deny-list.** *"we need to change the allow to a unallowed as
> a blacklist not a whitelist."* → §9.
>
> **The configuration belongs in the web interface.** *"id like to do the config
> you mention in 2 & 3 not in the .env files but rather in the webinterface of
> the foundry."* → §10, which splits it in two and answers the halves
> differently.

**This is not a re-argument of whether.** The decision at the top of
[README.md](README.md) stands and nothing here touches it. What moves is the
design: one refusal falls, one is replaced, and one part of the argument behind
the refusal was wrong on the tree.

Checked against the tree at `e8c44d9`.

---

## 1. What each answer moves

| Answer | What it moves | Where |
|---|---|---|
| **Q1: owns it, would rather not** | Nothing is blocked. The carrier in `01a-` §2.1 works today. The preference is not a separate requirement — it is served by the same change Q3 forces | §6 |
| **Q3: ten repos, different stacks** | `01d-` §3's *"No per-run, per-folder, per-template or per-agent stack selection"* **falls**, and `14-` §7's argument for it was half wrong | §2, §3, §4 |
| **Q2: a login** | `01b-` §2.2's `env` has no way to carry a credential that is not written into the artifact R2 says people copy. **A new field, and a refusal** | §5 |
| **Ruling: deny, not allow** | `01b-` §2.4's field is replaced and the grant derived. The tree supports it: deny is the only one of the two flags *verified* to restrict anything. One claim in `01b-` §5 is corrected from fact to unmeasured | §9 |
| **Ruling: configure in the app** | The repository map moves into the UI. **The secret does not, and the operator accepted the refusal** - the card reports set/unset and never holds a value | §10 |

Q3 is the one that costs. Q1 costs nothing, Q2 costs one field, and the two
rulings cost one field replaced and one card gaining a section.

---

## 2. The per-folder refusal falls, and half its argument did not hold

`01d-` §3 refuses it by name:

> **No per-run, per-folder, per-template or per-agent stack selection.** Every
> `ok` stack reaches every child. `14-stack-object-model.md` §7 found all three
> doors such a selector could attach to closed by name, and this design does not
> reopen them. If four mounted repositories genuinely need four toolchains, that
> is a new question and `18-option-repo-manifest.md` is where it starts.

It is a new question, it has been asked, and the answer is yes. The refusal is
**superseded**. But the reasoning has to be corrected rather than just
overridden, because it is cited three times and a build run that reads only the
citation will rebuild the same wrong thing.

### 2.1 The load-bearing sentence, and why it is only half true

`14-` §7:

> **there is one `PATH`, one filesystem and one set of volumes per container, so
> an installation cannot be per-folder however the record is scoped.**

**True of the installation. Not true of the selection**, and the selection is
the half that matters.

`PATH` is a per-process variable, and this app already composes a per-child
environment: `childEnv` copies the server's environment, strips four prefixes
and six names, and merges a caller's `extra` map **last**
(`src/lib/orchestrator.ts:5698-5716`). A caller can therefore hand one child a
different `PATH` than another, and `agentGitEnv`'s call site at
`src/lib/orchestrator.ts:6266` is an existing example of per-run values entering
exactly that way.

So the shape `14-` §7 declared impossible is available: **every stack installs
at boot, each into its own `{pkg}` prefix, and a run's `PATH` is composed from
the prefixes its repository declares.** One filesystem, many `PATH`s. The
installation stays install-wide, which is all the sentence actually proves.

### 2.2 The fourth door, which is open and shipping

`14-` §7 enumerates three doors a stack capability could attach to — the saved
agent, the workflow node, admission — and finds each closed by name. **It missed
a fourth, and the fourth is a per-folder capability selector that this app
already ships, tested.**

`UF_GITHUB_TOKENS` is a `folder=token` map (`src/lib/config.ts:407`).
`selectGithubToken` picks which credential a child working in a folder is handed
(`src/lib/config.ts:464-481`), off `matchFolderKey`
(`src/lib/config.ts:424-442`), and `githubTokenFor` is the process-configuration
door onto it (`src/lib/config.ts:484-490`).

That is not an analogy. A GitHub token and a toolchain are the same kind of
thing under `14-` §7's own definition: **a capability the container holds,
narrowed per repository.** The survey's claim that every door is closed by name
was measured against agents, nodes and admission, and this one was not looked
at.

**`14-` §7's resolution is superseded**, and its `allow` corollary with it: the
grant projected onto `--allowedTools` (`01b-` §2.4,
`src/lib/cycleInvocation.ts:633`) is composed from the selected stacks, not from
all of them, for the same reason a token is.

---

## 3. The selector already exists — copy it, including its trap

`selectGithubToken` is four decisions this revision should not re-derive. Each
one is right here for the same reason it is right there.

| Its rule | Why it transfers |
|---|---|
| **Relative keys resolve against every workspace mount; absolute keys are taken literally** (`config.ts:433`) | Ten repos inside one mount are named by folder name, not by full path. This is exactly the operator's shape |
| **Longest match wins** (`config.ts:438`) | A mount-wide default plus per-repo overrides, which is what "ten repos, mostly different" actually needs |
| **An entry with no value means *this one gets none*, never *fall through to the install-wide one*** (`config.ts:473-476`) | *"the second reading would make the narrowest thing an operator can write the widest one it does"* — a repo that must not see a toolchain has to be expressible |
| **`folder === null` takes the install-wide answer** (`config.ts:470`) | The orchestrator chat roams every mount by design and has no repository. `01c-` §5's five child kinds each need an answer and this is the one for the roaming child |

### 3.1 The trap, written down so it is not rediscovered

**Key on the repository, never on the working directory.**
`src/lib/orchestrator.ts:8690-8696` resolves the credential from
`run.repo_root ?? run.folder` and says why in a comment worth quoting whole:

> The credential this run's cycles get, chosen once from the *repository* rather
> than from `workDir` — an isolated run's cwd is its checkout under
> `.uf-worktrees`, which no operator writes a token entry for.

A per-repo stack selector keyed on `workDir` silently gives every isolated run
the install-wide set, and the failure is `00-problem.md`'s: a tool that is absent
fails inside a tool call the run loop does not read. **Resolve once at pick-up,
from `run.repo_root ?? run.folder`, beside the credential that is already
resolved there** — and for the same stated reason, that a set changing between
cycles would be a run whose toolchain moved with nothing saying why.

---

## 4. What still cannot be per-folder: the installation

The selection is cheap. The **install** is where Q3 collides with `01d-` §3's
other refusal, which does *not* fall:

> **No run-time or on-demand install.** Boot only. `PATH` must be final before
> the server starts, `createRun` may not `await` (`C7`), and the applier's
> agent-uid staging is safe only in the window where no agent process exists.

A repository cloned after boot declares a toolchain nothing installed. Three
shapes answer that, and they are not equally priced.

**(a) Declarations on the host, selection by map. Recommended first.**
`./stacks/` keeps every stack as designed in `01a-` and `01b-`; a new
`UF_STACK_FOLDERS` map, in `UF_GITHUB_TOKENS`' exact shape and parsed by the
same helper, says which repository gets which stacks. Everything installs at
boot; `PATH` composes at pick-up. **Nothing in `01a-`, `01b-`, `01f-` or `01g-`
changes** — only §3's selector is added, and `21-` phase 2 gains one map.
The operator writes ten directories and ten map entries. It works today, it
breaks no invariant, and it is the increment that proves the selector before
anything harder is built.

**(b) Declarations in the repository, applied at run admission.** What Q1's
preference actually wants, and **refused for now**: `createRun` may not `await`
(`C7`), so an install cannot happen at admission without moving the run's
start behind a network fetch — and `01a-` §6's agent-uid staging is safe only in
the window where no agent process exists, which admission is not.

**(c) Declarations in the repository, applied at boot. The shape to design
toward.** A stack lives in the repo it belongs to; the applier walks the mounts
at boot and reads them; a repo cloned mid-life gets its tools at the next
restart. This is `18-option-repo-manifest.md` with `01a-`'s applier, and it
answers Q1's preference — **the operator never touches the compose directory**,
because the declaration arrives with the clone.

It also gives `18-`'s boundary problem a real mechanism instead of a sentence.
`18-` held *a cloned repository becoming an installer* with one promise, that
*"the changed manifest is inert until a human approves it"* (`18-`:127) — quoted
as *"approves its exact content"* in [README.md](README.md), which is a
tightening the source line does not carry, and the looser real sentence is the
weaker promise — the thing README rightly calls what *"every reasonable
convenience request afterwards attacks"*. Under (c) the approval is **the restart** — a person at a
shell, which is `src/lib/config.ts:492-508`'s own standard: *"Here it takes a
container restart, which is a decision a person makes at a shell."* That is
weaker than reading the file and stronger than a promise, and it is the same
boundary the rest of this design already rests on.

**What (c) still owes**, and it should be settled before it is built: a `git
pull` that changes a stack is not a decision anybody made, and the restart that
applies it may be for an unrelated reason. `01f-`'s `declared` layer has to show
what changed since the last apply, or (c) installs on a schedule nobody chose.

---

## 5. The login, which the format cannot express today

`01b-` §2.2's `env` takes **literal values only**, expanded from four tokens and
nothing else. There is no indirection, no reference to a variable, and no secret
store. So the only way to give a stack a credential today is to type it into
`stack.json` — **the file R2 exists to make copyable and shareable**, and under
§4(c) the file that lives in a git repository.

That is a defect, not a gap: nothing in `01b-` §3's parse refusals stops it, the
resulting stack looks correct, and the failure is a credential in somebody's
repository. `01g-` walks nine failure modes between a publisher and a consumer
and this is not among them.

### 5.1 What to add: a name, never a value

A fifth optional field, and the whole of it is indirection:

```
"secrets": { "TF_TOKEN_app_terraform_io": "UF_STACK_SECRET_TFCLOUD" }
```

The key is the variable the **tool** reads. The value is the name of a variable
the **operator** sets in `.env` and which appears in no shared artifact. The
applier reads the source at boot and injects it under the key into the selected
children's environment.

The renaming is not decoration — it is forced, and `githubEnv` is the precedent
that shows why. `childEnv` deletes the entire `UF_` prefix
(`src/lib/orchestrator.ts:5698-5716`), so a `UF_`-named secret is set and then
silently absent in every child, which is `C2`. `UF_GITHUB_TOKEN` is read from a
`UF_`-namespaced name and handed to exactly one place under the names the tool
actually reads (`src/lib/config.ts:355-367`,
`src/lib/orchestrator.ts:5863`, `:5946`), and the docblock states the reason the
namespace is load-bearing: git children execute repository-controlled code, and
*"a token named `GH_TOKEN` in the environment of this server would be inherited
by all of them."* **A stack secret inherits that property or it leaks the same
way.**

Three refusals come with it:

- **The source name must match `UF_STACK_SECRET_*`.** One prefix, so the strip
  list keeps covering it and a reviewer can see every stack credential in `.env`
  with one grep.
- **A literal value in `secrets` is a parse refusal**, with the reason named:
  this field takes the name of a variable, not a secret.
- **The destination key takes `01b-` §2.2's existing refusal table**, so a
  `secrets` entry cannot set `PATH`, `CLAUDE_*`, `ANTHROPIC_*` or the rest by
  going around `env`.

And `01f-` gains one rule: **the read-back names which secret sources a stack
wants and whether each is set, and never their values.** A stack installed
perfectly with an unset credential is `01a-` §8's quiet failure exactly — it
fails inside a tool call nobody reads.

### 5.2 What a login still cannot be here

**Interactive login does not work in this container and no field fixes it.**
`gh auth login`, `aws sso login` and `terraform login` want a TTY or a browser.
There is no TTY, `08-terminal-problem.md` refuses the pane, and boot has no
operator in front of it. Two things work and they should be documented as the
answer rather than discovered:

1. **A token.** Every one of those logins has a non-interactive form that reads
   an environment variable. That is §5.1.
2. **A credential file produced on the host and bind-mounted read-only**, the
   way `~/.claude` already arrives (`docker-compose.yml:401`) — with
   `01b-` §2.2's fourth refusal standing, that nothing may resolve under
   `/home/node/.claude`, because that bind is the host's for every session on
   the machine.

**If the login the operator means is neither** — if it is a device-code flow, or
a credential that must be refreshed by a human every few hours — then the unit
is answering a smaller question than the one being asked, and that is worth one
more sentence to them before §5.1 is built.

---

## 6. Q1 costs nothing, and is answered by §4(c)

The design needs host **filesystem** access beside `docker-compose.yml`
(`01a-` §2.1) and explicitly not `docker compose exec`. The operator has it, so
**README's overturn item 1 is closed and nothing is rebuilt.**

The preference — *"it would be nicer if i dont"* — is not a second requirement
and should not be built for on its own. It is the same change as §4(c): when a
stack rides in the repository it belongs to, adding a toolchain is a `git clone`
and a restart, and the compose directory is never opened. **One change answers
both halves of the operator's reply**, which is the reason to sequence toward
(c) rather than to treat Q1 as its own work.

---

## 7. What this supersedes, by name

| Where | What | Now |
|---|---|---|
| `01d-` §3 | *"No per-run, per-folder, per-template or per-agent stack selection"* | **Superseded** for per-folder. Per-agent, per-template and per-run stay refused — nothing asked for them |
| `14-` §7 | *"an installation cannot be per-folder however the record is scoped"* | **Corrected.** True of the install, false of the selection (§2.1) |
| `14-` §7 | *"all three doors a stack capability could attach to are closed by name"* | **Incomplete.** `selectGithubToken` is a fourth and it is open (§2.2) |
| `14-` §7 | the `allow` grant is install-wide, *"in the shape of `resolveVerifyTools`"* | **Superseded.** Composed from the selected stacks, in the shape of `githubTokenFor` |
| `01b-` §2 | the five-field schema | **One field added**, `secrets` (§5.1), with three parse refusals, and **one replaced**: `allow` becomes `deny` (§9.3) |
| `01b-` §2.4 | `allow`, opt-in, empty by default | **Superseded.** `deny`, and the safe default inverts - which `01f-` absorbs (§9.4) |
| `01b-` §5 | *"`acceptEdits` … will refuse it in a headless run"* | **Corrected.** Unverified, and it is the probe's own proposition stated as fact (§9.2) |
| `01a-` §6 | no install from inside the app | **Stands**, and it does not reach the repository map, which installs nothing (§10.1) |
| `01f-` | the four layers | **Gains two rules**: an empty `deny` renders as everything granted, spelled out (§9.4), and secret names render set/unset and never values (§10.3) |
| `01d-` §3 | *"No run-time or on-demand install. Boot only."* | **Stands.** It is what refuses §4(b) |
| `01a-` §2.1 | the host bind mount as the carrier | **Stands for (a)**, and is the thing §4(c) would replace |
| `21-` phases | the five-phase order | **Phase order stands.** Phase 2 gains the map, phase 4 gains the composition, and a phase 6 is §4(c) |
| README | overturn items 1, 4 and 5 | **All three answered.** Items 2 and 3 are still commands nobody has run |

`01h-`'s acceptance pass is not re-run here. **R3's verdict of *not met* is
unchanged** and now has a second unmeasured thing under it: the probe measures
whether a work cycle may invoke an arbitrary binary, and says nothing about
whether a *composed* `PATH` reaches all five child kinds in `01c-` §5.

---

## 8. What is still not measured, and it is the same list

Three of the five items in README's *"What would change the design"* are closed
by this file. **The two that remain are commands, not questions**, both in
`22-validation.md` §5, and neither has been run:

1. **Does a named volume survive `docker compose up --build` on this engine?**
   Nothing in this repository has ever observed it. The claim rests on two unit
   tests over file contents - *"gh extensions survive the rebuild that installs
   them by hand does not"* (`src/lib/deployment.test.ts:905`) and its Python
   counterpart (`:978`) - and on nothing else. README cites `:1137` beside them
   and it is a different claim, *"keeps that directory off every named volume"*.
2. **Does `acceptEdits` permit an arbitrary binary?** One work cycle. If yes,
   `01b-`'s `allow`, `01a-` §4.2 and `21-` phase 4 are deleted rather than
   composed, and §2.2's correction above costs nothing to have made.

**One new question for the operator**, and it is §5.2's: whether the login
reduces to a token or a mounted credential file. If it does, §5.1 is the whole
of it. If it does not, the unit is the wrong unit and that is worth knowing
before the field is built rather than after.

---

## 9. `allow` becomes `deny`, and the measured ground says the operator is right

**Ruled by the operator on 2026-09-12: the grant is a deny-list, not an
allow-list.** *"we need to change the allow to a unallowed as a blacklist not a
whitelist."*

`01b-` §2.4 and `01b-` §5 are superseded. The reason to record here is that the
tree supports the ruling on a stronger ground than preference, and it does so by
contradicting a claim `01b-` §5 states as fact.

### 9.1 What the two flags actually do

**`--allowedTools` is additive and is not a gate.**
`src/lib/cycleInvocation.ts:1203-1205`:

> Additive: `--allowedTools` names what skips the prompt, and everything else
> still follows the mode. It is not the allowlist `chat.ts` runs under, where
> `manual` mode is what makes the same flag exhaustive.

A work cycle runs at `acceptEdits`, not `manual`. So what a stack's `allow`
entries buy is *skipping a prompt* — and what happens to everything else is
whatever `acceptEdits` does headless, which is **exactly the thing
`01c-` §4's probe exists to measure and which nobody has measured.**

**`--disallowedTools` is a gate, and it is verified.**
`src/lib/agents.ts:216-218`:

> `PROCESS_KILLERS` is a `--disallowedTools` entry, and CLAUDE.md records that
> deny beats `--permission-mode` — **verified**.

It already ships unconditionally on every cycle
(`src/lib/cycleInvocation.ts:1220`, `PROCESS_KILLERS` at `:710`).

**So the deny list is the only one of the two measured to restrict anything.**
The allow list's restricting power is unknown and conditional on the probe; the
deny list's is known and unconditional.

### 9.2 The claim in `01b-` §5 that this corrects

> `terraform apply` matches no entry and falls back to `acceptEdits`, **which
> will refuse it in a headless run.** That is the design working, not failing.

**That is an unverified claim stated as certain**, and it is the same claim
`01c-` §3 says the design must not rest on — written down as fact three sections
later. If `acceptEdits` permits an arbitrary binary headless, then the Terraform
example as published grants `terraform apply` to every work cycle in the
repository it is mapped to, and the file says the opposite in bold.

### 9.3 The shape: the operator writes `deny`, the applier derives the grant

Replacing `allow` with `deny` and nothing else would break under the *other*
probe outcome: if `acceptEdits` refuses unknown binaries, a stack with no allow
entries installs a tool no cycle can run. So the field is replaced and the grant
is derived rather than dropped.

```
"deny": [ "terraform apply", "terraform destroy" ]
```

- The applier projects **`Bash(<bin>:*)` for every binary the stack links** onto
  `--allowedTools`. That is what makes an installed tool usable and it needs no
  author decision.
- It projects **every `deny` entry** onto `--disallowedTools`.
- Deny beats allow and beats the mode, verified, so the result reads the way the
  operator asked: *everything this stack installs, except what you denied.*
- It is correct under **both** probe outcomes, which is the property
  `01a-` §4.2 was written for and which `allow` alone did not have.

**`01b-` §2.4's same-binary rule carries over to `deny`, and it is doing a
different job there.** An entry's first word must still name a binary this stack
links — not to stop a stack granting what it should not, but to stop one
*denying* what it does not own. A stack that could write `git commit` or `git
add` into `deny` would silently break every isolated run on the install, because
deny beats `ISOLATED_GIT_TOOLS` the same way it beats the mode.

### 9.4 The cost, stated rather than argued away

**A deny-list on a shared artifact fails open, and an allow-list fails closed.**
Three consequences, and the operator has taken them:

1. A publisher who forgets an entry ships a stack that grants more than they
   meant, and nothing in `01g-`'s consumer checklist would catch it.
2. **A tool that gains a subcommand in a later version gains it granted.** The
   pinned version in the declaration limits this and does not remove it: the
   operator bumps the pin, the new verb arrives, and no line changed to say so.
3. The safe default inverts. `allow` was empty by default and a stack had to opt
   in; `deny` empty by default means a stack grants everything it installs. The
   read-back has to carry that weight instead — `01f-` gains a rule: **a stack
   with an empty `deny` is rendered as granting every command of every binary it
   links, spelled out, never as a blank field.**

`01g-`'s nine failure modes gain a tenth and it is a quiet one.

---

## 10. The configuration moves into the web interface — in one half, and not the other

**Asked by the operator on 2026-09-12**: the step-2 secret and the step-3
repository map should both be set in the app rather than in `.env`. These are
two different asks with two different answers, and collapsing them is how the
dangerous half gets built on the safe half's reasoning.

### 10.1 The repository-to-stack map: yes, and it is a small change

**It installs nothing.** Under §4(a) every stack installs at boot from
declarations on disk; the map only decides which already-installed binaries a
run's `PATH` sees. No network fetch, no write outside the database, nothing
executed. That is categorically different from an install endpoint, and
`01a-` §6's refusal — which is about installing — does not reach it.

Two conditions come with it:

- **It is a capability change, so it belongs where capability changes already
  go.** Mapping a repository to a stack changes what that repository's agents
  may run. It is the same kind of edit as a guard change, and it needs the same
  audit treatment rather than sitting on the settings save path unremarked.
- **The database is a named volume and `.env` is not.** `usagefoundry-data:/data`
  (`docker-compose.yml:430`, `:715`) is destroyed by `docker compose down -v`.
  This is `16-`'s rejected argument arriving again — *"moving the declaration
  from a file that survives `docker compose down -v` into a database that does
  not"* — and here it is **accepted**, because retyping a ten-row map is cheap
  and the declarations themselves stay on disk where `16-`'s objection bites.
  The read-back must say the map is database-held.

### 10.2 The secret: not in settings — refused, and the refusal accepted

**Decided on 2026-09-12.** The operator asked for the credential in the web
interface, the refusal below was put to them with its reasons, and they took it:
*"sure thats fine."* **The token stays in `.env`; the app reports whether it is
set and never holds it.** §10.3(a) is the build.

This is recorded as a decision rather than a recommendation because the next run
will find a Tools card that shows a secret's *name* and will read that as an
omission. It is not one.

**`src/lib/config.ts:492-508` refuses exactly this shape for a webhook URL**, and
a Terraform Cloud token is a strictly worse thing to hold there:

> `saveSettings` stores only what differs from `DEFAULTS` — it is a
> product-defaults mechanism, not a secret store — and `/api/settings` is
> reachable with `UF_AUTH_TOKEN`, so a webhook target held there is repointable
> by anything holding the master key, which would turn one credential into an
> exfiltration channel aimed anywhere the container can reach. **Here it takes a
> container restart, which is a decision a person makes at a shell.**

Three specifics on top of that sentence:

1. `saveSettings` writes through `setJSON` into the database
   (`src/lib/settings.ts:1097-1110`), which is in the volume `down -v` destroys.
   A token typed into the UI is a trip back to Terraform Cloud after a
   `down -v`; one in `.env` is not.
2. **`UF_ALLOW_NO_AUTH=1` is sanctioned and documented** (`src/lib/config.ts:340`).
   On such an install, a secret field in the web interface is a credential
   readable by anything that can open a TCP connection to port 3000.
3. A secret in `DEFAULTS`-diffed storage is one `GET /api/settings` from being
   read back, and nothing in that route was built to hold something that must
   never be returned.

### 10.3 Two ways to give the operator the surface without that

**(a) Names in the app, values in `.env`. Recommended, and it is `01f-` §5.1
already.** The Tools card lists every secret a stack wants, says whether each is
set, and never shows or accepts a value. The operator sees *"`terraform` wants
`UF_STACK_SECRET_TFCLOUD` — not set"* in the app, which is the whole of what they
could not see before, and pastes the token into `.env`. Costs one field on a card
that is already being built.

**(b) A real secret store, write-only, off the settings path.** A separate file
under `/data`, which is root-owned 0700 (`docker-compose.yml:50`, `:482`), behind
its own route that accepts a value and never returns one, never touching
`saveSettings` or `/api/settings`. This is buildable and honest, and it is a new
credential-at-rest surface in an app that currently has none — every secret today
is an environment variable. It should not be built on the back of the map in
§10.1, and it needs `docs/agent/security.md` to gain a section rather than a
line.

**(a) is decided and built; (b) is deferred with a condition on it.**
What the operator asked for was not the typing — it was not being able to *see*
whether a token is set, which is what (a) removes for one field on a card that
already exists. **(b) is revisited only if, after (a) has been in use, the
remaining friction is named concretely** — not on the general principle that a
web interface should hold everything, which is the argument
`src/lib/config.ts:492-508` was written against.

**What a later run has to accept to build (b):** that this app holds a
credential at rest for the first time — every secret today is an environment
variable — that `docs/agent/security.md` gains a section rather than a line, and
that on a `UF_ALLOW_NO_AUTH=1` install the store is reachable by anything that
can open port 3000 unless the route is written to refuse that case by name.
Stating it here is what makes building it a decision rather than a drift.
