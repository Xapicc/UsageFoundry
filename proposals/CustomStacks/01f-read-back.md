# The read-back

**R5, which is the one gap the original survey agreed was real.** What the app
reports about what is installed, where each part of that comes from, and how it
stays true when somebody installs something by hand. The surface that draws it is
[01e-operator-surface.md](01e-operator-surface.md); this file is what is behind
it.

Checked against the tree at `68a8aa7`. Nothing here has been run: **this
container has no Docker**, so every claim about what a receipt says after a boot
is reasoned from `01a-mechanism.md` §7's applier rather than read off one.

---

## 1. The requirement, and the thing that makes it hard

R5 is met when a surface names, per declared tool, *that it is declared*, *the
outcome of its install with the failure text*, and *whether the tool has ever
been observed to run* (`01-constraints.md` R5). Point 3 is separate from point 2
on purpose: R3's third link can fail after a perfect install, and the honest
rendering of a tool nobody has seen run is not `installed`.

**Today none of it exists.** `grep -rn "UF_PY_TOOLS\|UF_GH_EXTENSIONS" src/`
returns no reader - ten lines in two files at `68a8aa7`, one docblock mention in
`src/lib/contextPruning.ts:99` and nine in `src/lib/deployment.test.ts`, none of
them a read - so an operator learns whether an
install worked by reading the boot log for
`[usagefoundry] installed Python tool $entry` (`docker-entrypoint.sh:297`) or the
`could not install` line at `:306`. That is the whole read-back, and
`src/lib/db.ts:182-184` is why it is not enough: *"a container's stdout is a
scrollback buffer that the restart destroys, and the restart is exactly when an
operator comes looking."*

**The hard part is not reporting the receipt. It is that the receipt is not the
truth.** A receipt is what the applier believed at boot. What an agent gets is
whatever `PATH` resolves at the moment it types a word, and between those two
facts sit three ways of drifting apart:

1. somebody `docker compose exec`ed in and installed a tool by hand;
2. somebody removed or overwrote one of the files a receipt claims;
3. a stack installed perfectly and the tool is still refused, because R3's third
   link - permission to invoke - is not on disk at all (`01c-` §3).

A read-back built on receipts alone answers confidently and wrongly in all three
cases. So it is built on **four layers, read from four places**, and the design
rule is that a layer may never be inferred from the layer above it.

---

## 2. The four layers

| Layer | Question | Source | Cost |
|---|---|---|---|
| **declared** | what did the operator ask for | `/etc/uf-stacks/*/stack.json`, the read-only bind | one read per stack |
| **applied** | what did the applier do about it | `/var/lib/uf-stacks/receipts/<stack>.json` | one read per stack |
| **reachable** | what would an agent actually get | `PATH` resolution over the server's own `process.env.PATH` | one `lstat` per name |
| **observed** | has it ever run, and did it work | `run_events`, `kind IN ('tool','tool_error')` | one cached query |

`src/lib/stacks.ts` reads the first three; `src/lib/toolInventory.ts` - which is
`15-option-no-stack-object.md` §2's module carried forward whole - reads the
fourth. Two modules rather than one because the fourth is a database reading with
a cache and the first three are filesystem reads with none, and a module that is
sometimes pure and sometimes cached is a module whose test has to decide which.

### 2.1 declared, and why it is read at all

The receipt already carries the declared name and digest, so reading the
declarations looks redundant. It is not, and the case it catches is the one that
matters most: **a stack the operator added, whose applier never ran.** A
declaration with no receipt is an install the operator believes in and the
container has never attempted - the exact shape of `.env.example:245-249`'s
plugin, active against a command that was never present, 213 times.

It is also how the read-back survives the applier crashing mid-boot: the
declaration list is a bind mount and cannot be a partial write, and the receipt
set can be.

### 2.2 applied, and the one field that is not a status

`01a-` §7 fixes the receipt: name, digest, `ok | failed | conflicted`, applied
timestamp, binaries linked, grants projected, env exported, per-step status, and
on failure the last 4 KB of the step's stderr.

**The stderr is carried verbatim and never parsed.** The same call
`src/lib/orchestrator.ts:7934-7936` makes about the words it matches on: *"this recognises text
read out of one CLI build and never executed, so what it decided has to be
checkable against what the tool actually said."* An applier that summarised a
`curl` failure into a category would be inventing the one field an operator
actually needs to read.

**4 KB is a cap and the page must say when it bit**, on the shortened-diff rule
`docs/agent/git-and-review.md` fixes and `src/lib/status.ts:41-46` restates:
*"a plausible number that is quietly a third of the real one is worse than no
number."* The receipt carries the original byte count beside the text.

### 2.3 reachable, which is the layer that keeps the other three honest

For every binary name any receipt claims, resolve it the way a child would:
split the **server's own** `process.env.PATH`, and take the first entry that is
an existing executable file.

**The server's `PATH` is the right one to split, and this is the non-obvious
fact the whole layer rests on.** `childEnv` (`src/lib/orchestrator.ts:5698`)
copies `process.env` and deletes a closed list of prefixes and names - `UF_`,
`OTEL_`, `__NEXT_`, and five named keys (`:5701-5711`) - and `PATH` is in none of
them. The docblock above it says so directly: *"Everything else passes through.
The CLI needs PATH, HOME, CLAUDE_CONFIG_DIR, proxy and CA settings, and locale to
function at all"* (`:5628`). So the server's `PATH` **is** the child's `PATH`,
and a resolution done here is the resolution the child will do.

**One honest caveat, and it is the same one `01c-` §2 records.** The test that
pins the pass-through is `src/lib/git.test.ts:89`, whose assertion is
`assert.equal(env.PATH, process.env.PATH)` at `:97` - and it is over `gitEnv`,
not `childEnv`. `childEnv` has three `describe` blocks in
`src/lib/orchestrator.test.ts` (`:4251`, `:4305`, `:4340`) and none asserts
anything about `PATH`. For agent children the guarantee is the construction plus
the docblock, which is weaker than a test. **A `childEnv().PATH` assertion is
one line and this design should add it**, which is a repair to an existing
module rather than a new test, and it makes the reachable layer's central
assumption a thing that fails loudly.

What resolution buys, case by case:

- **A hand-installed tool that shadows a stack's**, or is shadowed by it. The
  design puts the toolbox first - `ENV PATH="/var/lib/uf-stacks/bin:${PATH}"`
  (`01c-` §2) - so a stack wins over `/usr/local/bin`. The read-back reports the
  path it resolved to, and a resolution outside the toolbox against a name a
  receipt claims is drawn as **`shadowed`**, naming both paths. Nothing about
  that is an error; it is the one fact an operator debugging a version mismatch
  needs and cannot get any other way.
- **A link a receipt claims that is not there.** Removed by hand, or removed with
  the volume. This layer reports **`missing`** for that binary, which §3 composes
  into **`broken`** for the stack holding it - two names at two levels and not two
  states, because a stack with three binaries and one gone needs a word for the
  binary and a word for the stack. It is a fault either way: the receipt says `ok`
  and the disk disagrees, and only one of them can be right.
- **A name the toolbox carries that no receipt claims.** Listed separately, as
  `unclaimed`, with the sentence that the applier will not touch it - because
  `01a-` §7's reconcile *"removes only paths its own receipts record"*, so an
  unclaimed link outlives every stack and every `down -v` that does not take the
  volume with it. This is the row that answers "somebody installed something by
  hand" out loud rather than by silence.

**Bounded, and the bound is a real one.** A `stack.json` declares a handful of
binaries, so this is on the order of ten `lstat`s against a local volume. It is
still not free on a settings page load, and §4 is where that is paid.

### 2.4 observed, and what a count can and cannot say

`run_events` already separates a call from a failed call by `kind`
(`src/lib/apiTypes.ts:2194-2216`), and the union's own comment on `tool_error`
is what makes this readable at all: *"Errors only — a successful result is not
recorded at all"* (`:2216`). So the two counts are not symmetric and the
rendering must not pretend they are:

- **calls seen**, from `kind = 'tool'` rows whose payload command begins with the
  binary's name;
- **failures seen**, from `kind = 'tool_error'` rows the same way.

`calls − failures` is **not** successes, because a `tool` row is written when the
call is *made* and a run killed mid-call never produces either answer. The page
prints the two numbers and never their difference.

**The query is `readCountsFor`'s shape and there is a production precedent for
every part of it.** `src/lib/fileCostNotice.ts:328-363` already pulls
`json_extract(e.payload, '$.input.file_path')` and
`json_extract(e.payload, '$.name')` out of `run_events` over a bounded horizon,
today, for a prompt rather than for a person. This is the same query with
`$.input.command` and a prefix test.

**Three limits, each of which must be on the page rather than in this file.**

1. **The horizon.** `run_events` is swept on `eventRetentionDays`, default 30
   (`src/lib/settings.ts:1012`), by `sweepRunEvents` (`src/lib/retention.ts:151`).
   So "never observed" means "not in the retained window", and the page says the
   window in days. A stack that has run daily for a year and been idle for five
   weeks reads `unverified`, correctly, because that is all the data says.
2. **The prefix test is a string test.** A `Bash` call's `command` is what
   `toolArgs` rendered, and a binary invoked through a wrapper script, a shell
   function or an absolute path is a call the count misses. It **undercounts**,
   which is the direction that leaves a tool reading `unverified` when it is
   fine, rather than `installed` when it is not - the same trade
   `src/lib/sandbox.ts:157-159` takes with its needles, for the same reason.
3. **It cannot distinguish a missing grant from a missing binary.** Both arrive
   as a `tool_error`, and the words differ per CLI build. Naming the cause is
   what the surface refuses to do (`01e-` §4).

---

## 3. How a state is composed, and the rule that composes it

Four layers, one word per stack. The rule is **the worst layer wins, and a
higher layer may never overwrite a lower one's fault**.

| Word | Composition | Tone |
|---|---|---|
| `failed` | receipt `failed`, `conflicted`, or a declaration with no receipt | `danger` |
| `broken` | receipt `ok`, and a claimed binary does not resolve | `danger` |
| `failing` | resolves, and `tool_error` rows against its names in the window | `warn` |
| `shadowed` | resolves outside the toolbox | `warn` |
| `unverified` | resolves, and no call against its names in the window | `neutral` |
| `installed` | resolves, calls seen, no failures in the window | `ok` |

**`installed` is the only word that requires all four layers to agree**, and that
is the design: it is the one word an operator will act on without reading
further, so it is the one that has to be expensive to say. Everything else is
cheaper to say than `installed`, which is the right direction for a page whose
failure mode is a false reassurance.

**This is `SandboxRow`'s argument, generalised.** *"Four readings and not a
switch, because two of them are the ways a sandbox lies about itself"*
(`src/app/settings/page.tsx:1744-1745`). Here there are six, and three of them -
`broken`, `failing`, `shadowed` - are ways an install lies about itself: the
receipt says `ok` in every one.

**Unknown must not render as zero** (`docs/agent/metering.md:8`). A layer that
could not be read is its own thing and never a `0` or an `ok`: receipts
unreadable is a page-level error, not six `unverified` rows.

---

## 4. What it costs to read, and where the cost is paid

**The first three layers are cheap and uncached.** A handful of small file reads
and about ten `lstat`s, on a settings page that already does more than that. No
cache, because the alternative - staleness on the one page whose whole job is
saying what is true now - is the failure this file exists to stop.

**The fourth is a bounded query behind a short cache**, on the reasoning
`src/lib/fileCostNotice.ts:300-310` writes out for the same query on the same
table:

> Staleness costs nothing here, which is what makes a cache the right answer
> rather than an index: this ranks a price list over thirty days of history, so a
> minute-old ranking and a fresh one differ only in files nobody has read since.
> An index would move the cost onto every `run_events` insert instead, and that
> table is written on every tool call of every cycle — far the busier side of
> the trade.

Every clause transfers. `READ_COUNTS_TTL_MS` is 60 seconds
(`src/lib/fileCostNotice.ts:310`) and this takes the same, on `globalThis` under
its own key - never a key whose shape changed, which is `CLAUDE.md`'s trap and
`src/lib/fileCostNotice.ts:312-315` is the pattern to copy.

**No index on `run_events`.** The one partial index this app added over that
table, `idx_run_events_sandbox` (`src/lib/db.ts:831-832`), earned it by being
*"the one question about it that does not come in by run"* (`:2818-2820`). This
question is the same shape, and the honest difference is that the sandbox
reading feeds a row that must be correct within the hour on every settings load,
while this one is read when somebody opens a section. The cache is the answer
until something measures otherwise, and a measurement is cheaper than an index
on the busiest table in the schema.

---

## 5. The two routes

**Two routes, one per subject.** `GET /api/tools` is the list the section draws,
covering all three sources of a tool on this install - stacks, `UF_PY_TOOLS`,
`UF_GH_EXTENSIONS` - and `GET /api/stacks/[name]` is one stack's whole receipt.
Two rather than one because they answer about two different things and a route
handler here is per subject; one rather than three because the two `UF_*` lists
have no receipt behind them and never will (`01e-` §4).

Both: `runtime = "nodejs"`,
`dynamic = "force-dynamic"` - both required, per `docs/agent/conventions.md:11`:
*"Route handlers that touch SQLite or the filesystem need … Every existing data
route has both."* Through `jsonMaybeGzipped` like the other eighteen
(`docs/agent/conventions.md:18`), with a list DTO in `src/lib/apiTypes.ts` and
`Cache-Control` written at the call site, *"because the helper knows nothing
about caching"* (same line).

The detail is **never filled from the list row** - `docs/agent/taskboard.md:779`
makes the same call for the task editor, and here it is load-bearing rather than
stylistic, because the list deliberately does not carry the 4 KB of stderr.

**Behind the master token, with no exemption.** `src/middleware.ts:114` exempts
`/api/status` when `UF_STATUS_TOKEN` is set and nothing else; neither route is
added to that list. A read-only inventory still tells its reader which binaries
are on the box, which is `15-` §6's argument, and it does not weaken because the
list got better.

**Neither is an MCP tool, and both are refused by name.** `docs/agent/taskboard.md` fixes the
board's three tools and the membership test that gates them; `stacks` is not a
subject on that surface. A model asking what is installed is a model choosing
what to invoke, and the design's answer to "which tools may this agent use" is
the projected grant (`01c-` §3), not a catalogue.

---

## 6. Which functions earn a test

`CLAUDE.md`'s bar, not a convention: **a pure function whose failure mode is
silent gets a unit test**, and `docs/agent/testing.md` is what to read first
because it names every existing one and the grounds each earned.

**Three here meet it, and one nearly does.**

1. **`composeState(receipt, resolution, counts)`** - §3's table. Pure, six
   branches, and every way of being wrong is silent and expensive in one
   direction: a composition that reports `installed` over a `broken` resolution
   is a page actively telling an operator the thing that is costing them money is
   fine. The assertions are the six rows plus the two precedence cases, `broken`
   over `failing` and `failed` over everything.
2. **`resolveOnPath(name, pathValue, exists)`** - §2.3, with the filesystem
   predicate injected so the function stays pure. The failure mode is the
   classic one: an empty `PATH` element means the current directory, a trailing
   colon means the same, and a resolver that treats either as "not found" or as
   "found" silently changes what the page claims about every binary at once.
3. **`parseReceipt(json)`** - a receipt written by a shell script and read by
   TypeScript is a boundary, and `CLAUDE.md`'s rule is to validate at boundaries
   and trust internal calls. A truncated receipt from a container killed
   mid-write must be `unreadable` and never a partial `ok`; that is one branch
   and it is the whole reason this is on the list.

**The nearly.** The `run_events` prefix count is not pure - it is a query - and
its failure mode is a number that is too low, which §2.4 argues is the safe
direction. It gets no test of its own. Its **cache** is a different matter: the
`globalThis` key trap costs a thrown call on every request after a hot reload -
*"`??=` only initialises when the key is absent, so a pre-upgrade value at a key
whose shape changed survives the reload and every call on it throws"*
(`src/lib/orchestrator.ts:10870-10873`; `CLAUDE.md`'s own pointer at `:373` is
stale, and [22-validation.md](22-validation.md) §3.1 records it), and that is
caught by typechecking a fresh key rather than by a test.

**No route test.** `src/app/api/health/route.test.ts` is the bar for one, and it
earned it by answering *falsely* when the server cannot do its job. This route's
failure is a visibly empty card, which `21-implementation-sketch.md` already
separates from that shape and which stays true here.

---

## 7. What the read-back may never claim

- **Never that a tool works.** It reports four readings and composes them. The
  only evidence that a tool works is a run that used it, which is the `observed`
  layer, and that layer is bounded by a retention horizon it must print.
- **Never a cause for a `tool_error`.** §2.4 limit 3.
- **Never a number it did not measure.** A cap that bit is said out loud, in
  both places one can: the 4 KB stderr cap and the retention horizon.
- **Never `0` for a layer it could not read.** §3, on `docs/agent/metering.md:8`.
- **Never the host path of a stack directory.** `01e-` §6: the container does not
  know it, and inventing it is worse than the hedge.
- **Never a fact about a stack in `/api/status`'s payload.** Two integers, on
  `src/lib/status.ts:24-28`'s closed rule. `01e-` §5.3.
