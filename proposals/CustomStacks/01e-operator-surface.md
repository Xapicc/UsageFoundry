# The operator's surface

**Where a stack is added, listed, removed and inspected.** `01a-mechanism.md` §7
fixed the data and the acts and said the surface was this run's; this file is the
surface. What the app *reports* - R5 - is [01f-read-back.md](01f-read-back.md),
because R5 is the one gap the original survey agreed was real and it deserves its
own argument.

Checked against the tree at `68a8aa7`. **This container has no Docker**, so every
sentence about what an operator sees during a boot is reasoned from
`docker-entrypoint.sh`, `Dockerfile` and `docker-compose.yml` rather than
watched, and says so where it is made.

---

## 1. The four acts, and where each one happens

**Three of the four are not in the app at all, and that is the design rather than
a gap.** `01d-boundaries.md` §3 refuses an install from inside the app by name,
on `01a-` §6's sharpest reason: `/api/settings` is reachable with the master key,
so an install endpoint is remote code execution with this app's authentication in
front of it, and `src/lib/config.ts:494-508` already refuses a smaller version of
the same thing with the sentence that decides it - *"Here it takes a container
restart, which is a decision a person makes at a shell."*

| Act | Where | What the app does |
|---|---|---|
| **add** | `cp -r <stack> ./stacks/` on the host, then `docker compose up -d` | nothing; it was not running |
| **remove** | `rm -r ./stacks/<stack>` on the host, then `docker compose up -d` | nothing; it was not running |
| **change** | edit `./stacks/<stack>/stack.json`, then `docker compose up -d` | nothing; it was not running |
| **inspect** | `/settings#tools`, and `/settings/stacks/<name>` | **all of it** |

So the app's whole surface is the fourth row. The other three are a file manager
and a restart, which is what makes the host filesystem the trust boundary
(`01a-` §1) and what keeps the three acts reachable by exactly the person who can
already edit `docker-compose.yml`.

**One consequence worth stating rather than discovering.** Because the applier
runs before `exec "$@"` (`docker-entrypoint.sh:1223`), **the app is not serving
while a stack installs.** There is no in-app progress, no spinner and nothing to
poll, and §3 is what the operator sees instead.

---

## 2. The pane, and why it is Settings

**Pane: Settings. Routes: a `Tools` section at `/settings#tools`, and a sub-route
`/settings/stacks/<name>` for one stack's receipt.**

**The section is `Tools` and not `Stacks`, and that is a correction this run made
while writing the phases.** A stack is one of three ways a tool gets onto this
install's `PATH`; the other two are `UF_GH_EXTENSIONS` and `UF_PY_TOOLS`, which
`01d-` §1 keeps rather than replaces. A `Stacks` section would be a second list
of tools beside a first one that does not exist yet, and the operator's question
is not *which stacks are installed* but *what can my agents run*. So the section
answers that question, stacks are a group inside it, and the consequence for the
build order is the good one: the section is shippable before any stack exists,
which is what [21-implementation-sketch.md](21-implementation-sketch.md) phase 1
does with it.

**There is no tenth pane and the ban's own sentence names the replacement.**
`docs/agent/ui-density-audit.md:159-162` bans an eleventh row on the ground that
it would be *"the second row you cannot reach from the keyboard"*, and ends:
*"New destinations are sub-routes under an existing pane."* That sentence has
been applied here before and shipped - `proposals/implemented - SessionFlow/`
took the same fork and landed `/runs/[id]/touched` rather than a pane
(`proposals/implemented - SessionFlow/05-option-d-sub-route.md:11` quotes the
same line).

**The ban is stale by one and it does not matter which way.**
`src/components/shell/panes.ts:14-18` says *"**Nine is the ceiling** — ⌘1…⌘9 is
nine digits and the list is eleven rows — so the last **two** rows have no digit
at all"*, and names them API account and Settings; the audit at `:159` still
describes *"`panes.ts` is ten rows against ⌘1–⌘9"*. `grep -c "href:" src/components/shell/panes.ts`
returns **11** at `68a8aa7`. So the audit undercounts by one, the price it warns
about has already been paid twice rather than once, and a twelfth row would be
the third. Either count forbids a pane.

**Settings rather than Agents, and Agents is refused by name.** A toolchain looks
like it belongs beside the things that decide what an agent can do, and that is
exactly the placement `docs/agent/agents-and-templates.md:10` forbids: *"A saved
agent … carries a role rather than a capability"*, and the field that would make
it one - `tools` - *"is refused at save"*. A stack is install-wide (`01c-` §3, on
`14-stack-object-model.md` §7's finding that all three per-run doors are closed),
so it is not a property of an agent, a template or a run, and the only pane whose
subject is the install itself is Settings.

**Settings has the two precedents and they are the two halves of this surface.**

- **Plugins** (`src/app/settings/page.tsx:4135`, registered in `SECTIONS` at
  `:118`) is an operator-declared list of directories the container loads, drawn
  as a section with a `lede`, a `problems` list at `:4145-4152` and an `Empty` at
  `:4156`. That is the list half.
- **`SandboxRow`** (`src/app/settings/page.tsx:1767`, docblock `:1740-1765`) is
  an install-wide reading of one thing that can lie about itself, drawn as a
  badge plus a server-written sentence. That is the state half, and §4 takes its
  vocabulary wholesale.

**The digit cost is real and is paid on purpose.** Settings is one of the two
rows with no shortcut, so a surface that lives only there is a surface an
operator reaches by deciding to. That is acceptable for the list and
unacceptable for the failure, which is why §5 puts the failure in **four places,
none of them this section**, and does not rely on anybody opening Settings at
all.

### 2.1 Why `/settings/stacks/<name>` is a route and not an expander

One stack's receipt carries, per `01a-` §7, the declared name, the digest, the
status, the applied timestamp, the binaries linked, the grants projected, the env
exported, a per-step status and **the last 4 KB of the step's stderr**. A section
row that can hold 4 KB of stderr is a row that has stopped being a row.

This tree has already argued the same fork and taken the same side:
*"The editor is a route, not a card the board opens above itself"*
(`docs/agent/taskboard.md:779`). The Tools section links out for the same
reason and **is never filled from the list row** - the detail page fetches the
receipt itself, which is the second half of that argument.

---

## 3. Installing

**What the operator sees: the boot log, and an app that is not answering yet.**

The applier runs between the entrypoint's work and `exec "$@"`
(`docker-entrypoint.sh:1223`), which is the only window in the container's life
with no agent process alive (`01a-` §6). Nothing in this app is up, so there is
nothing in this app to look at. The channel is the one the two existing install
loops already use, and the design copies their line format:
`[usagefoundry] installed Python tool $entry` (`docker-entrypoint.sh:297`) and
`[usagefoundry] could not install Python tool $entry:` (`:306`).

```
$ docker compose up -d && docker compose logs -f usagefoundry
[usagefoundry] stacks: 2 declared in /etc/uf-stacks
[usagefoundry] stack terraform: installing (archive, 1 step)
[usagefoundry] stack terraform: installed, 1 binary, 5 grants
[usagefoundry] stack shell-lint: receipt matches, skipped
[usagefoundry] stacks: 2 ok, 0 failed
```

**A first boot is slow and every later boot is not.** A declaration whose digest
matches an `ok` receipt costs a `sha256` over one small file and no network
(`01a-` §3), so the slow boot is the one after `docker compose down -v` or the
one that adds a stack.

**Slow has a ceiling and the ceiling is already written into the image.**
`HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=5`
(`Dockerfile:737`). A boot that has not started serving within 180 seconds begins
burning retries, and five of them at 30 seconds is 150 more, so the container
reads `(health: starting)` and then `(unhealthy)` at roughly five and a half
minutes of installing. `Dockerfile:731-732` says what happens then: *"What this
does NOT do is restart the container. Docker Engine surfaces health state … but
does not act"*, so nothing is killed and the boot finishes; what the operator
loses is the meaning of the health column while it does.

**So the applier needs a total budget and not only a per-step one.** `01a-` §8
gives each step a bounded timeout, which the two existing loops do not have -
`grep -n "timeout\|--max-time\|--connect-timeout" docker-entrypoint.sh` returns
one line, `:1202`, and it is a one-second socket probe for winnow's port, on
neither install path. That is correct and insufficient: ten stacks each timing
out politely is still a container past its start period. The applier takes a
whole-run ceiling as well, spends it in declaration order, and writes a `failed`
receipt reading `not attempted: the applier's time budget was spent` for every
stack it did not reach. **A stack that was never attempted must not read as a
stack that installed**, which is the one way this section could produce the
failure `.env.example:245-249` measures.

---

## 4. Installed

A `Tools` section in Settings, registered in `SECTIONS`
(`src/app/settings/page.tsx:110-122`) between `plugins` and `knowledge`, because
that is where the operator-declared things the container loads already sit.

**Three groups, one per source, in this order: stacks, `UF_PY_TOOLS`,
`UF_GH_EXTENSIONS`.** *"Grouping has a closed vocabulary, and it is seven
things"* (`docs/agent/conventions.md:51`, which routes the reasoning to
`docs/agent/ui-density-audit.md`), and `ListGroup`
(`src/components/ui/List.tsx:43`) is the one of the seven this is: three sources,
labelled, in one list. The order is most-configurable first. One `ListGroup`
row per tool: the name, the `summary` line from `stack.json` for a stack
(`01b-` §2) or the declared spec for the other two, a badge, and the server's own
sentence beside it. A stack's row links to `/settings/stacks/<name>`; a `UF_*`
row links nowhere, because there is no receipt behind it and never will be.

**Six states, and they are `SandboxRow`'s readings rather than a switch.** That
docblock is the argument and it transfers whole: *"Four readings and not a
switch, because two of them are the ways a sandbox lies about itself"*
(`src/app/settings/page.tsx:1744-1745`). Here there are six and **three of them
are ways an install lies about itself**, because the receipt says `ok` in every
one.

**The words and how each is composed are
[01f-read-back.md](01f-read-back.md) §3**, which is where the rule lives because
the composition is a pure function over the four layers and the page only draws
it. Restated here as what an operator reads, with the tone this page gives it:

| Word | What it means to somebody reading the row | Tone |
|---|---|---|
| `installed` | it is there and something has run it and nothing failed | `ok` |
| `unverified` | it is there and nothing has tried it in the retained window | `neutral` |
| `shadowed` | it is there, and a *different* copy of it is what an agent gets | `warn` |
| `failing` | it is there and calls against it are coming back errors | `warn` |
| `broken` | the receipt says it installed and the binary does not resolve | **`danger`** |
| `failed` | the install failed, conflicted, or never ran at all | **`danger`** |

**`danger` is reserved for the two that lie, and the reason is the same one
`SandboxRow` gives for reserving it for `empty`.** There, `empty` is *"an install
that believes it is confined and is not"* (`:1747-1749`). Here, `failed` and
`broken` are an install that believes it has a tool and does not, and they are
the two states where an agent is certain to call a binary that is not on disk.
`failing` and `shadowed` are expensive; those two are the ones that are lying.

**`installed` is the only word that requires all four layers to agree**, which is
`01f-` §3's rule and the right direction for a page whose failure mode is a false
reassurance: every other word is cheaper to say than the one an operator will act
on without reading further.

**`unverified`, never `installed`, for a tool nobody has seen run.**
`15-option-no-stack-object.md`'s honest rendering, carried forward whole by
`01a-` §7, and under this design it earns a second meaning: `01c-` §3's grant can
be missing while the install is perfect, and `unverified` is exactly what that
looks like from here. The shape is the metering rule's - *"Unknown must not
render as zero"* (`docs/agent/metering.md:8`).

**`failing` names no cause, on purpose.** A count cannot tell a missing grant
from a tool that ran and did not like its arguments, and a word that claims a
cause sends somebody to widen an allowlist that was never the problem - which is
the failure `src/lib/sandbox.ts:157-159` names in its own docblock about matching
too eagerly. The badge says `failing`; the sentence beside it says what was
counted and over what window, and the detail page shows the commands.

**The sentence is the server's, not the page's**, for `SandboxRow`'s reason at
`src/app/settings/page.tsx:1752-1754`: *"a second copy written here is a second
thing to keep honest."*

**No poll.** `docs/agent/conventions.md` asks when a poll stands down and how it
re-arms; the answer here is that it never arms. The receipt half cannot change
while the server is up, because the only writer runs before the server starts
(`docker-entrypoint.sh:1223`), and the invocation half is a bounded cached
reading whose TTL a poll would mostly re-serve ([01f-](01f-read-back.md) §4).
The section loads with the page. A poll here would be the easy wrong answer and
it would be polling for an event that cannot happen.

**The states are per tool and not per stack**, which matters for a stack with two
binaries: `01g-` §6's shell-lint links `shellcheck` and `shfmt`, and a stack whose
first binary resolves and whose second does not is `broken` as a whole and one
`installed` row beside one `missing` row underneath. The stack's own badge is the
worst of its rows, on [01f-](01f-read-back.md) §3's rule.

**The three ways of having nothing are three renderings**, in the shape the
Plugins section already uses at `src/app/settings/page.tsx:4139-4159`:

- `/api/tools` errored → the error text, not an empty list;
- `/api/tools` has not answered → `Empty` reading *"Reading tool inventory…"*;
- there are no tools from any of the three sources → `Empty` naming the `stacks`
  directory and the one-line shape of a `stack.json`, exactly as `:4159` names
  what a plugin directory must hold.

An install that has never mounted `./stacks` and an install with an empty
`./stacks` are the same third case and read the same, which is honest: from
inside the container a bind of an empty directory and a bind that was never
configured are indistinguishable, and `src/lib/config.ts:230-231` italicises its
own *is* over the same ambiguity for a mount slot.

---

## 5. Failed, and why one place is not enough

**The directory's asymmetry stands and this is the section it governs.** An
install that fails costs a log line somebody is watching; a tool that is absent
costs billed tokens on every cycle of every run that needed it, discovered by
nobody. The number is `.env.example:245-249`: *"Measured on one install here: 213
sessions told a plugin was active against a command that was never present"*,
because *"hook bodies end in `|| true`, so the hook exits 0 having done
nothing"*.

**A boot log line is not enough, and this repository has already written down
why.** `src/lib/db.ts:182-184`, arguing for `ops_events` beside stdout:

> The rows are the archive, and they are the point: a container's stdout is a
> scrollback buffer that the restart destroys, and the restart is exactly when an
> operator comes looking.

A failed stack install is written at boot, and boot is when stdout starts over.
So the failure goes in four places, each answering a question the others cannot.

### 5.1 The boot log - for the person watching the restart

§3's lines. Free, immediate, and destroyed by the next restart.

### 5.2 `ops_events` - the archive a restart does not erase

One durable row per non-`ok` outcome, under **one event name**, through
`recordOpsEvent` (`src/lib/ops.ts:155`), with the stack name and the reason in
`detail`. One name rather than one per failure kind, for the reason `db.ts`
gives about schema faults at `:207-211`: they answer a single question - what did
this boot find wrong - and the status endpoint reads them with a single-name
query, with `detail` saying which.

The table is capped at 500 rows and the cap is deliberate for this traffic:
*"How many `ops_events` rows are kept. Boot-frequency writes, so generous"*
(`src/lib/db.ts:136-137`). A stack applier writes at boot frequency, so it is the
shape the cap was sized for. `recentOpsEvents(limit, event)` (`src/lib/ops.ts:180`)
is the reader and needs nothing new.

### 5.3 `/api/status` - the machine-readable reading, and it must de-latch

`StatusReport` (`src/lib/status.ts:81`) gains **two integers and nothing else**:
how many stacks are declared, and how many of them are not `ok` **on this boot**.
Zero on a boot where everything applied.

**Two integers rather than the names, and that is this payload's own rule rather
than caution.** `src/lib/status.ts:24-28`: *"**counts, bytes, fractions and
timestamps only** — no prompt text, no folder or mount path, no settings value,
no token, no branch name, no model. A folder path here is a leak of what this
install works on into whatever scrapes it."* A stack name is operator-chosen
text that says which toolchains this install runs, and a failure reason is the
last 4 KB of somebody's stderr, which carries URLs and paths as a matter of
course. Both are settings values in everything but the table they are stored in.
`stacksFailed > 0` is the whole of what a monitor needs to threshold, and the
names are one authenticated request away at `/api/tools`.

**Zero on a good boot is the other half of the requirement, and the trap is
named in the tree.** `src/lib/db.ts:184-189`:

> a monitor built on the archive would go red at the first fault and stay red
> until five hundred later events pushed it out — `restartClosedOutstanding` in
> `status.ts` is the same trap, written up. This list is what `/api/status` reads
> instead: it is empty on a boot that found nothing, so it de-latches on the only
> event that can clear one of these, which is a boot.

`schemaFaults` (`src/lib/status.ts:158`, assembled at `:386` from
`schemaFaultsThisBoot()`) is the shape, and here it costs nothing extra: **the
receipt set already is the per-boot reading**, provided a non-`ok` receipt is
re-attempted on every boot rather than skipped. `01a-` §7's reconcile rules did
not say so and this run has fixed them in place; see
[22-validation.md](22-validation.md) §2.2.

**The counts are the receipts and are not counted twice.** The same
`readReceipts()` that `/api/tools` calls
([01f-read-back.md](01f-read-back.md) §2) answers this; `status.ts` takes its
length and its non-`ok` length. A second reader of the same directory is a
second thing that can disagree with the first about how many stacks there are.

This is also where the digit cost of §2 is answered. `/api/status` is behind the
read-only status token (`src/middleware.ts`, and `README.md` documents the
token), so an operator who never opens Settings still has a way for something
else to tell them.

### 5.4 The run's own log - where the cost is actually incurred

The three above all fire at boot. The fourth fires at the moment the money is
spent, and it is [01f-](01f-read-back.md)'s subject: a `tool_error` row naming a
declared binary is the app learning, from the run itself, that a stack is not
reaching the agent. That is the reading `failing` is drawn from in §4 and it is
the only one of the four that can catch a stack that installed perfectly and
granted nothing - `01a-` §8's one quiet failure.

### 5.5 What is deliberately not used

**Not the outbound webhook.** `src/lib/notify.ts` posts on a run ending that
wants a person, its field list is closed and its status set is its own
(`docs/agent/run-lifecycle.md`). A boot event is not a run ending, and widening
that payload to carry one would make the closed list a list that grew once.

**Not a pane badge.** `src/components/shell/panes.ts` carries no count or badge
field, and adding one touches all four readers the module exists to keep in step
(`:6-10`). A badge on the row with no digit is a poor trade for that.

**Not a refusal.** `01a-` §8 is explicit that a failed or missing stack never
blocks a run, and `17-option-requirements-not-installs.md` concedes the point
itself: *"the correct version of this option is not a refusal but a warning on
the run"* (`17-`:227).

---

## 6. Removing and changing

**Both are `rm -r` and an edit, and neither has a button.** `01a-` §7 fixed the
reconcile: a receipt with no declaration has its `pkg/`, its `state/` and the
links it owns removed and the receipt deleted, and **the applier removes only
paths its own receipts record**, so it can never delete something it did not
install.

The app's part is to say what will happen before the operator does it, and it
has exactly one useful thing to say: **`state/<stack>` is destroyed with the
stack.** For a stack whose state is a provider cache that is a re-download; for
one whose state is anything an operator would miss, it is a loss. The detail page
prints the state directory and its size, which is a `du` over one directory the
server can read, and says the sentence. This is the same act the Storage card
already performs for other trees under `DATA_DIR`, and `docs/agent/retention.md`
is what governs how such a walk is cached.

**What the page cannot say is the host path.** The container knows
`/etc/uf-stacks/<name>`; the host directory is compose's `UF_STACKS_DIR`
interpolation (`01a-` §2.3), which never enters the container's environment.
Forwarding it would add a variable the entrypoint does not read to the
`environment:` block, against which `src/lib/deployment.test.ts:1377`,
`it("forwards every variable the entrypoint reads and nothing else supplies")`,
asserts in both directions. **So the page prints the container path and says the
default host path is `./stacks/<name>` beside `docker-compose.yml`**, hedged
because an operator who set `UF_STACKS_DIR` knows they did and the app does not.
The alternative is a fifth file in `C8`'s four-file rule for one string, and
`01a-` §7's claim that this design adds no `UF_` variable the entrypoint reads is
worth more than the string.

---

## 7. What this surface may never do

Collected so a later run has to argue against a reason rather than notice a gap,
in the manner of `01d-` §3.

- **No install, re-apply, retry or remove button**, and no endpoint behind one.
  `01a-` §6's three reasons, of which the first is that `/api/settings` is
  reachable with the master key.
- **No editing `stack.json` in the browser.** Same reason with one more step: a
  writable declaration path inside the container is a declaration an agent could
  reach if any path containment check were ever wrong, and `01a-` §2.4 rejected
  `/workspace` for exactly that.
- **No MCP exposure.** `/api/tools` and `/api/stacks/[name]` are excluded from
  the board's tool list by name. A read-only inventory still tells a model which binaries are on the box,
  which is `15-` §6's argument and it does not weaken because the list got
  better.
- **No decision on this page.** It reports; it does not gate. `docs/agent/taskboard.md`
  draws the same line for the board - what the page may draw and what it may
  never decide.
- **No second copy of any sentence the server writes.** §4, on
  `src/app/settings/page.tsx:1752-1754`.
