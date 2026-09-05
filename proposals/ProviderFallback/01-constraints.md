# Constraints, and the unknowns

Two lists. The first is what any option has to satisfy — each entry is either a
measured property of this codebase, an invariant `docs/agent/` already enforces,
or a product commitment that follows from what the feature claims to be. The
second is what could not be established from this container, written as
questions with **what the answer would change** and **how to find out**, because
a proposal that guesses the half it could not see is worth less than one that
names it.

---

# Part 1 — Constraints

## C1. The three cost sources may not become four, and a Codex figure may never be summed with any of them

This is the constraint most likely to be broken by accident, because breaking it
produces a number rather than an error. `docs/agent/architecture.md:10` states
it as a property of the app:

> **Three** data sources now, still **never summed or mixed in the UI**.

and `docs/agent/metering.md:50` says why:

> three routes to overlapping work, and any sum double-counts

The three are the transcript scan, the CLI's own `total_cost_usd`, and OTLP
telemetry. A Codex cycle's spend, however derived, is a **fourth population over
a fourth time base**, denominated against a price table this app does not have
(`src/lib/pricing.ts:31`–`:59` — every key begins `claude-`). It may appear
beside the three. It may never be added into `runs.spent_usd`, into a dashboard
meter, or into the window fractions.

There is already a precedent for admitting a further figure without making it a
further source, and it is the shape to copy. `src/lib/intakeFilter.ts` reads
winnow's ledger — a **fourth file**, which `docs/agent/metering.md` records is
"deliberately **not** a fourth source" — and the rollup carries
`byAgent.counterfactualUSD` (`src/lib/windows.ts:703`, computed at `:1150`;
asserted at `src/lib/windows.test.ts:1004`, `:1031`–`:1032`), which is *what the same work
would have cost without the filter*. It is `null` when it cannot be computed
rather than zero, it reaches no meter and no guard, and it is rendered as a
statement about a hypothetical rather than as spend.

The precedent for how a foreign figure is handled already exists one function
over. `resolvePrice` (`src/lib/pricing.ts:115`) returns `null` for a model it
does not know; the display shows unknown; and `guardCostOf` (`:194`) substitutes
`UNKNOWN_MODEL_PRICE = { input: 10, output: 50 }` (`:84`) so that *the guard*
still has something to act on. **That is the shape any Codex costing has to
take: unknown on the card, a deliberately pessimistic substitute at the guard,
and never the same number.**

## C2. The window guards do not constrain Codex, and must not be made to look as though they do

`maxWeeklyFraction` and `maxSessionFraction` (`src/lib/budget.ts:56`, `:65`) are
fractions of a **Claude subscription window**, derived by `windows.ts` from
Claude Code's local transcripts. A Codex process writes no such transcript and
spends no such allowance. So under any fallback:

- Codex spend cannot move either fraction, and neither fraction can stop a Codex
  cycle.
- `maxRunCostUSD` may not be computable at all — see U4 below — and
  `--max-budget-usd`, which is *the* in-cycle ceiling
  (`src/lib/cycleInvocation.ts:1115`–`:1118`), has no established equivalent on
  the Codex CLI.
- `maxIterations` and `maxDurationMinutes` are the only two guards that survive
  a provider swap unchanged, because they are the **monotone termini**
  (`src/lib/budget.ts:86`–`:91`) and neither is denominated in a provider's
  money.

**An option that runs a Codex cycle under a policy whose only limits are the two
fractions is running it under no limit at all.** That is not a footnote; it is
the constraint that decides which options are admissible.

## C3. The refusal classifiers are read out of one binary and cannot be reused

`isUsageLimit` (`src/lib/orchestrator.ts:1438`) matches Claude Code's own
sentences. `isTransientApiError` (`:1475`) matches five stream-truncation
sentences its docblock says were "read out of the shipped binary rather than
guessed". `sandboxRefusal` recognises text from that same build.

None of it transfers. A Codex refusal — of any kind — arrives as text this app
has never seen, and the failure mode is not a crash: `refusalKind` (`:1540`)
would return `"other"`, `refusalDisposition` would return
`{ action: "fail", cause: "other" }` (`:1817`), and the run would end with
`refusalStopReason`'s sentence **"Claude Code refused the request: …"**
(`:1851`) attached to something Claude never said.

So every option that spawns a second binary owes a second classifier, and until
it has one, every Codex failure is terminal and misattributed.

## C4. `refusalStopReason` names Claude in four of four sentences

```
"Claude refused the work cycle for want of allowance again…"      :1836
"Claude Code hit a transient API error on N attempts in a row…"   :1840
"Claude Code was rate limited on N attempts in a row…"            :1847
"Claude Code refused the request: …"                              :1851
```

The `switch` has a `never` arm (`:1853`) that makes a fifth `RefusalCause` a
build failure, which is the good half. The bad half is that the four existing
sentences are unconditional prose about a provider. Any option that can end a
run on a Codex failure has to reach every one of them, and an option that adds a
cause without touching the other four ships a run page that lies about which
provider refused.

## C5. A run's stop reason, report and `DONE` contract are read per line from one voice

`docs/agent/run-lifecycle.md` owns the `DONE` and `needs-review` contracts. The
mechanism is that `finalText` holds **the main thread's last assistant text**
and nothing else — `handleStreamLine` keeps a forwarded sub-agent turn out of it
deliberately (`orchestrator.ts:6638`–`:6652`), on the grounds that "a sub-agent reporting
`DONE` would end a run whose main thread had not finished".

A Codex cycle has to produce a `finalText` with the same property, from a
different event shape, or the run cannot end on its own judgement. Codex's
`--output-last-message <FILE>` (`codex-rs/exec/src/cli.rs`, `-o`) is the
candidate and is a *file* rather than a stream position — which is a different
failure mode, not a worse one, but it is a different one and has to be
handled: a file that was never written is not the same as an empty answer.

## C6. Nothing new may put a clock in front of the Land button, and nothing may make a landing decision provider-conditional

`docs/agent/isolation-and-landing.md` records that nothing on the landing path
may have a clock on it. `docs/agent/git-and-review.md` records that no row may
carry a success mark it did not earn, and that the three ways of having nothing
may never render as an empty list.

A Codex-written branch is a branch. `landRun` reads git; it does not read a
model. So the constraint here is a **prohibition on inventing a difference**:
the merge queue may not gate on provider, `runTouches` may not be
provider-conditional, and a diff is a diff. What *is* owed is disclosure — see
[`11-review-landing-and-blast-radius.md`](11-review-landing-and-blast-radius.md)
— and disclosure is a label, not a gate.

## C7. New persistent state goes through `migrate()` and onto the retention map

`CLAUDE.md`: schema changes are idempotent statements in `migrate()` in `db.ts`;
a destructive one runs inside a single `db.transaction`. The mechanism for a new
`runs` column already exists and is one line —
`addColumn(db, "runs", "file_cost_notice", "TEXT")` at `src/lib/db.ts:845`,
over the helper at `:1801`.

`docs/agent/retention.md` records what expires and on which horizon. Any option
storing which provider ran a cycle has to answer both, and an option that stores
nothing gets to skip both, which is a real part of its case.

## C8. `run_events.kind` is a closed union and a new member is a real cost

`RunEventDTO.kind` (`src/lib/apiTypes.ts:1791`–`:1836`) is sixteen members, each
with a docblock arguing why it is not a flag on its neighbour. The pattern the
union enforces — `subagent` is not `assistant` with a flag; `tool_error` is not
`tool` with a flag; `sandbox` is emitted *beside* `tool_error` and not instead of
it — is the same argument any provider marker would have to make.

An option that renders a Codex cycle's tool calls as `kind: "tool"` is claiming
they are the same kind of event, and that claim has to be made deliberately
rather than by reusing the emitter.

## C9. No shell, ever, and containment is proved twice

`docs/agent/security.md` owns this. At the spawn site: arguments as an array, no
shell (`orchestrator.ts:5619`–`:5621`); `childCredentials()` (`src/lib/privsep.ts:252`) so the
child runs below the server's uid; its own process group so `signalTree`
(`orchestrator.ts:5566`) reaches what it started.

A second binary inherits none of that by being a second binary. It inherits it
by being spawned through the same discipline, and an option's cost includes
re-proving it.

## C10. `childEnv`'s strip is a denylist, and a denylist fails open

```ts
key.startsWith("UF_") || key.startsWith("OTEL_") ||
key === "ANTHROPIC_ADMIN_KEY" || key === "CLAUDE_CODE_ENABLE_TELEMETRY" ||
key === "DATA_DIR" || key === "NODE_OPTIONS"
```
— `src/lib/orchestrator.ts:5371`–`:5382`

**`OPENAI_API_KEY` is not on that list, and neither is `CODEX_API_KEY`.** So an
operator who sets either on the server today hands it to every Claude work
cycle, every chat turn, every review child and both auth children — five
`CLAUDE_BIN` spawn sites (`orchestrator.ts:5621`, `chat.ts:2104`,
`review.ts:660`, `claudeAuth.ts:302` and `:414`) — inside a session with `Bash`,
which can print `env`.

This is not hypothetical drift; it is the current behaviour of the current code,
and `claudeAuth.ts:245`–`:252` shows the repository already reasoning about
exactly this class for `ANTHROPIC_API_KEY`, where the omission is deliberate and
documented. **Any option that introduces an OpenAI credential owes a decision
here before it owes anything else**, and it is the one piece of work that is
worth doing even if the recommendation is "don't" —
[`10-permission-and-credentials.md`](10-permission-and-credentials.md) §"The
repair that is owed either way".

## C11. A Codex process leaves winnow's intake filter, and there is no equivalent to give it

When `WINNOW_FILTER=1`, `docker-entrypoint.sh` starts a loopback proxy in front
of `api.anthropic.com` and **exports `ANTHROPIC_BASE_URL` before the exec**, so
every agent this container spawns talks to the API through it
(`docker-entrypoint.sh:856`–`:930`). The proxy places a spent tool result after
the last `cache_control` breakpoint so the API never writes it to the prompt
cache, and drops it from the next request — "the bytes cost 1.0x once instead of
a 2.0x cache write plus a 0.1x read on every later turn" (`:864`–`:865`).

`childEnv` passes `ANTHROPIC_BASE_URL` through untouched, deliberately, because
proxy settings are the operator's decision (`:874`–`:875`).

**A Codex process talks to a different API on a different host and would bypass
all of it.** Three consequences, none of which any option can fix:

1. The per-request saving does not apply. On the Claude side this is not a
   rounding error: `proposals/ContextControl/README.md` measures 82.1% of the
   week's bill as carried context.
2. `intakeFilter.ts`'s ledger gains no line, so `counterfactualUSD` and
   `winnow inspect`/`winnow fork` know nothing about the cycle. A run whose
   cycles alternate has a ledger with holes in it that look like quiet cycles.
3. The entrypoint's own safety argument does not transfer. Its worst outcome is
   "a boot that exports the URL and no listener" (`docker-entrypoint.sh:929`); a second provider
   introduces a second base URL with no such reasoning attached to it.

This is a **cost to name, not a constraint to satisfy** — nothing here forbids a
Codex cycle. But it belongs beside the money in
[`09-guards-and-metering.md`](09-guards-and-metering.md), because an option
justified on "the wall costs us throughput" is trading a filtered, cached,
ledgered request path for an unfiltered one.

## C12. The UI says "work cycle"; the code says "iteration"

`CLAUDE.md`. Whatever a fallback is called on a run page, the column, the
policy field and the payload stay `iteration`/`maxIterations`.

## C13. The container has no OpenAI credential and no Codex binary, and acquiring either is the operator's decision

`command -v codex` exits 1. Nothing in `src/`, `docs/` or `README.md` mentions
Codex or OpenAI. There is no key here to test with and no account to bill.

That is a constraint on *this proposal*, not on the design: it means the entire
Codex half of every option below is either read from source or flagged
unverified, and no option may be recommended on the strength of behaviour nobody
here observed.

---

# Part 2 — The unknowns

## Status

`codex-cli 0.153.4` is now installed at `/usr/local/bin/codex`, and a second
pass answered what could be answered without an OpenAI credential. **Four are
answered, four are partially answered, one stays deferred and one is still
open** — and the one still open is the one that blocks the most.

| | question | status |
|---|---|---|
| **U1** | what Codex emits when its own quota is exhausted | **still open** — needs an account at a wall |
| **U2** | is `turn.completed.usage` per-turn or cumulative | **partially answered** — per-turn per the docblocks; one-per-invocation unverified |
| **U3** | does `resume` restore the sandbox mode, model and overrides | **partially answered** — `resume` and `fork` will not *accept* `-s`, `-C`, `--add-dir`, `-p` or `--approve-for-me` at all |
| **U4** | a per-invocation dollar or token ceiling | **answered: no**, not on `codex exec` — but a `tokenBudget` exists one protocol down |
| **U5** | what `-s workspace-write` permits, and whether it holds here | **partially answered** — the resolved profile is readable; enforcement could not be exercised |
| **U6** | an `--append-system-prompt` equivalent | **answered: yes** — `-c developer_instructions=…`, on argv, and two file-borne alternatives |
| **U7** | per-invocation MCP servers | **still deferred** — nothing in scope depends on it |
| **U8** | how large a prompt argv takes | **answered** — 128 KiB (`MAX_ARG_STRLEN`), bisected; the binding limit is not `ARG_MAX` |
| **U9** | is the `--json` event stream stable across releases | **answered for this bump** — `exec_events.rs` is byte-identical 0.152.1 → 0.153.4 |
| **U10** | what a Codex cycle costs | **still open on the number**, but the *mechanism* is not "nowhere" — see below |

Four of those answers move claims elsewhere in this folder, and each is flagged
where it lands rather than only here:

- **U6** contradicts [`02-the-handover-contract.md`](02-the-handover-contract.md)'s
  "**absent as an argv**" for the appended system prompt, and settles item 4 of
  [`13-recommendation.md`](13-recommendation.md)'s overturning list. It does
  *not* move the score — see there for why.
- **U10** contradicts `README.md`'s and
  [`09-guards-and-metering.md`](09-guards-and-metering.md)'s "a Codex cycle has
  zero of the three [cost sources]". It has one.
- **U4** settles item 3 of the same overturning list, in the negative, which is
  the answer that leaves the recommendation where it was.
- **U5**'s read-only `.git` and **U3**'s nine dropped flags land in
  [`10-permission-and-credentials.md`](10-permission-and-credentials.md) and
  [`08-continuity.md`](08-continuity.md) respectively, and both make a
  Codex-spawning option harder rather than easier.

Corrections carrying the ~~struck~~ original text are collected in
[`14-validation.md`](14-validation.md) §2f and §2g; the command behind every
claim below is in §1f.

## The probe environment

```sh
codex --version              → codex-cli 0.153.4
command -v codex             → /usr/local/bin/codex
                               (→ ../lib/node_modules/@openai/codex/bin/codex.js)
ls ~/.codex                  → tmp/          (no auth.json)
codex login status           → Not logged in            ; exit 1
```

**There is no OpenAI credential on this machine.** Anything needing a live
model turn is recorded as open below rather than guessed. Probes that need a
writable `CODEX_HOME` used one outside the repository; probes that need a git
worktree used a scratch one under `$TMPDIR`. Two warnings appear on every
invocation here and neither is a failure:

```
WARNING: proceeding, even though we could not create PATH aliases:
  Read-only file system (os error 30)
WARNING: proceeding, even though we could not create PATH aliases:
  Refusing to create helper binaries under temporary dir "/tmp/claude-1000"
```

The first is `/usr/local/bin` being read-only; the second is `CODEX_HOME` being
under `$TMPDIR`, which Codex declines to lay helper binaries into.

### Three probes that need no credential, and carry most of what follows

They are worth naming separately because the first draft of this survey assumed
a running turn was the only way in.

- **`codex debug prompt-input '<prompt>'`** renders the model-visible prompt
  input list as JSON — every developer and user message, each tagged with its
  `content_item_kinds`. It is what settles U6 and most of U5. It reads the real
  config stack, the real `AGENTS.md` discovery and the real permission-profile
  resolution, and it exits 0 without a credential and without a model turn.
- **`codex exec -c '<key>=<value>' --strict-config`** errors on a key this
  version does not recognise, which distinguishes a real config key from a
  guess. **It does not distinguish a live key from a dead one** — see U6, where
  `instructions` passes `--strict-config` and reaches nothing.
- **`codex app-server generate-json-schema --out <DIR>`** writes the whole
  app-server protocol as JSON Schema — 4.3 MB, ~180 files. It is a different
  protocol from `codex exec --json` and nothing in it is automatically true of
  the exec stream, but it is where the machine-readable error codes and the
  token budget live, and it is why U1 and U4 have "one protocol down" answers.

## What could be established from source, and was

The container reaches the network through a proxy (`curl` to
`registry.npmjs.org` returns `200`; `getent hosts` fails, which is why a DNS
check is the wrong probe here). So the Codex CLI's **command-line and event
surface** was read out of `openai/codex` on GitHub rather than guessed.
[`02-the-handover-contract.md`](02-the-handover-contract.md) is that reading in
full, with the file each fact came from. In summary: `codex exec` takes a
prompt, `--json` prints a typed JSONL event stream, `resume <SESSION_ID>` and
`fork <SESSION_ID>` are subcommands, `--sandbox` takes three modes, and
`turn.completed` carries a five-field `Usage` **with no cost in it**.

**That reading was of `main` rather than of a pinned release, and the version it
named was 0.152.1; the binary installed here is 0.153.4.** U9 below re-fetched
both tags and found the two files the reading rests on identical, so the reading
holds — but every "the source says" in this folder should be read as *of
`openai/codex@rust-v0.153.4`* now, and the one place that cites a Codex source
**by line** (`codex-rs/login/src/lib.rs:38-47`, in
[`10-permission-and-credentials.md`](10-permission-and-credentials.md)) was
re-checked at both tags and has not moved.

## The unknowns, one by one

Each entry keeps its original question and what turns on it, and adds what the
installed binary said.

### U1. What does Codex emit when *its own* allowance or quota is exhausted?

**Status: still open.** It needs an account at a wall and there is none here.

**Turns on:** everything. Option B's entire premise is that a Claude wall is
survivable by switching; if the OpenAI side walls too, the fallback inherits the
same problem with none of the machinery — no `isUsageLimit` equivalent, no
window model, no reset boundary, no `refusalResumeAt`. `refusalKind` would file
it as `"other"` and end the run (C3).

**Not answerable from source either.** `grep -inE 'rate_limit|usage_limit|quota'`
over `codex-rs/exec/src/lib.rs` still returns nothing at `rust-v0.153.4`
(2,167 lines), and the JSONL union in `exec_events.rs` has exactly two error
shapes — `turn.failed { error: { message } }` and `error { message }` — both
carrying a free-text `message` and nothing machine-readable about *why*.
Confirmed at the installed tag:

```sh
sed -n '/pub struct TurnFailedEvent/,/^}/p' exec_events.rs
→ pub struct TurnFailedEvent { pub error: ThreadErrorEvent, }
sed -n '/pub struct ThreadError/,/^}/p' exec_events.rs
→ pub struct ThreadErrorEvent { pub message: String, }
```

**What the failing-turn *shape* is, measured.** The survey's own fallback probe
— force an authorisation refusal instead of a quota one — was run:

```sh
codex exec --json --skip-git-repo-check -o last.txt 'hi' </dev/null \
  >out.jsonl 2>err.txt ; echo $?
→ 1
```

The 14 stdout lines,  all valid JSON (`grep -cv '^{' out.jsonl` → `0`):

```
{"type":"thread.started","thread_id":"01a070fa-79c2-7b42-9974-b38309af0987"}
{"type":"turn.started"}
{"type":"error","message":"Reconnecting... 2/5 (unexpected status 401 Unauthorized: …)"}
…
{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Falling back
  from WebSockets to HTTPS transport. unexpected status 401 Unauthorized: …"}}
{"type":"error","message":"Reconnecting... 1/5 (… url: https://api.openai.com/v1/responses …)"}
…
{"type":"error","message":"unexpected status 401 Unauthorized: Missing bearer or basic
  authentication in header, url: https://api.openai.com/v1/responses, …"}
{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: …"}}
```

Four things in there are contract facts an adapter has to survive, and none of
them was readable from the flag surface:

1. **stdout is pure JSONL.** The `ERROR codex_api::endpoint::responses_websocket:`
   tracing lines go to **stderr**, along with `Reading additional input from
   stdin...`. A line-oriented stdout consumer needs no filtering.
2. **Ten of the fourteen lines are top-level `{"type":"error"}`, and nine of
   them are not fatal.** Nine say `Reconnecting... N/5`; the tenth is the
   terminal 401, and only the `turn.failed` after it says so. (An eleventh
   `"type":"error"` is nested *inside* the `item.completed` as an item detail —
   `ErrorItem`, whose own docblock says "Describes a **non-fatal** error
   surfaced as an item".) The union carries no `willRetry` and no code, so a
   retry notice and a terminal failure are the same event type with different
   English in them. **An adapter that ends a run on the first
   `{"type":"error"}` will end runs Codex was going to finish.**
3. **Codex has its own retry ladder and it is not configurable on argv**: four
   further WebSocket attempts, a transport fallback to HTTPS announced as an
   `item.completed`, then five more. 18 s and 19 s of wall clock on two timed
   runs of the same 401. That sits *underneath* whatever ladder this app puts on
   top (`docs/agent/run-lifecycle.md`'s 429 ladder), and the two compose.
4. **`-o last.txt` was never created.** `ls last.txt` → `No such file or
   directory`. C5's "a file that was never written is not the same as an empty
   answer" is a real state, not a hypothetical, and it is the state a failed
   turn leaves.

**And there is a machine-readable code — one protocol down, not on this
stream.** `codex app-server generate-json-schema` emits `CodexErrorInfo`:

```
contextWindowExceeded, sessionBudgetExceeded, usageLimitExceeded,
rateLimitExceeded, serverOverloaded, cyberPolicy, misalignmentPolicyViolation,
internalServerError, unauthorized, badRequest, threadRollbackFailed,
sandboxError, other
```

plus four variants carrying an upstream `httpStatusCode`, on a `TurnError`
`{ message, codexErrorInfo?, additionalDetails?, misalignment? }`; and the
app-server's `ErrorNotification` carries **`willRetry: boolean`**. So `refusalKind`
*could* have an exact counterpart — `usageLimitExceeded` is the wall,
`rateLimitExceeded` is the 429, `willRetry` is the hold-or-act decision — but
only for a caller driving `codex app-server`, not `codex exec`. In the 401 run
above, `turn.failed.error` carried `message` alone and no `codexErrorInfo`.

**What would settle it:** an account at a wall, then

```sh
codex exec --json 'hi' >out.jsonl 2>err.txt ; echo $?   # last 3 lines of out.jsonl
```

and the same wall driven through `codex app-server`, because that is where the
code lives and the answer to "can this be classified at all" depends on which
of the two a fallback would be built on.

### U2. Is `turn.completed.usage` per-turn or cumulative, and is there exactly one per `codex exec` invocation?

**Status: partially answered.** Per-turn, per the field docblocks at the
installed tag. One-per-invocation is unverified and needs a turn that completes.

**Turns on:** whether a Codex cycle's tokens can be summed at all. This is
precisely the trap `cycleCostAfterResult` exists for on the Claude side, where
`total_cost_usd` is a session running total and one child can emit two `result`
events (`src/lib/cycleInvocation.ts:25`–`:31`). Getting it backwards
double-counts or undercounts, silently.

```sh
curl -sS -o ev.rs https://raw.githubusercontent.com/openai/codex/rust-v0.153.4/\
codex-rs/exec/src/exec_events.rs
sed -n '/pub struct Usage/,/^}/p' ev.rs
```

```rust
pub struct Usage {
    /// The number of input tokens used during the turn.
    pub input_tokens: i64,
    /// The number of cached input tokens used during the turn.
    pub cached_input_tokens: i64,
    /// The number of input tokens written to the prompt cache during the turn.
    #[serde(default)]
    pub cache_write_input_tokens: i64,
    /// The number of output tokens used during the turn.
    pub output_tokens: i64,
    /// The number of reasoning output tokens used during the turn.
    pub reasoning_output_tokens: i64,
}
```

**Every field says "during the turn."** Five fields, unchanged, and
`cache_write_input_tokens` carries `#[serde(default)]` — so an adapter must
treat it as optional on the wire rather than assume it is present.

That is a documentation-level answer, not a measurement, and it leaves the
second half open: whether a single `codex exec` invocation can produce more than
one `turn.completed`. The probe is unchanged and still needs a credential:

```sh
codex exec --json 'write hello to /tmp/a then read it back' \
  | grep -c '"type":"turn.completed"'
```

then compare the sum of the `usage.input_tokens` against the last one alone.

### U3. Does a Codex session id survive `codex exec resume`, and does resume restore the sandbox mode, the model and the config overrides?

**Status: partially answered, and the answer so far is the one that was feared.**

**Turns on:** continuity ([`08-continuity.md`](08-continuity.md)) and the whole
alternation question. This repository has been bitten specifically by flags that
`--resume` does *not* restore (`--plugin-dir`,
`src/lib/cycleInvocation.ts:955`–`:962`), and the same class of bug would be
silent here.

**What the flag surface says.** `comm` over the three sorted `--help` flag
lists — 26 flags on `exec`, 19 on `resume`, 17 on `fork`:

```sh
for c in "exec" "exec resume" "exec fork"; do
  codex $c --help | grep -oE '^\s+(-[A-Za-z], )?--[a-z-]+' | grep -oE '\-\-[a-z-]+' \
    | sort -u > "f-${c// /-}.txt"
done
comm -23 f-exec.txt f-exec-resume.txt
comm -13 f-exec.txt f-exec-resume.txt
```

**In `exec` and in neither `resume` nor `fork` — nine flags:**

```
--add-dir  --approve-for-me  --cd  --color
--local-provider  --oss  --profile  --sandbox  --version
```

`resume` adds `--all` and `--last`; `fork` adds nothing. Short forms tell the
same story: `exec` has `-c -i -m -p -s -C -o -h -V`, `resume` and `fork` have
`-c -i -m -o -h`.

So **a resumed cycle cannot restate its sandbox mode, its working root, its
extra writable directory, its profile or its approval routing on argv.** The
survivors are `-c/--config`, `-m/--model`, `-i/--image`, `-o`, `--json`,
`--output-schema`, `--strict-config`, `--ephemeral`, `--ignore-user-config`,
`--ignore-rules`, `--skip-git-repo-check`, `--thread-source`, `--enable`,
`--disable` and both `--dangerously-*`.

`-s workspace-write` and `--add-dir` are unavailable at resume; the only way to
say either is `-c sandbox_mode="workspace-write"` and
`-c sandbox_workspace_write.writable_roots=[…]`, which *are* accepted. That is
exactly the `--plugin-dir` shape: the flag silently is not there rather than
being rejected, and the run continues under whatever the session or the config
stack supplies. **And it compounds U5** — the resumed cycle is the one that
most needs its writable roots restated, because `.git` is read-only under
`workspace-write` and `--add-dir` is one of the nine flags it cannot use.

Both subcommands take a UUID **or a thread name**:

```
codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]
  [SESSION_ID]  Conversation/session id (UUID) or thread name. UUIDs take
                precedence if it parses. If omitted, use --last to pick the
                most recent recorded session
codex exec fork [OPTIONS] <SESSION_ID> [PROMPT]
  <SESSION_ID>  Conversation/session id (UUID) or thread name to fork
```

`fork` requires the id; `resume` will take `--last` instead.

**Still open:** whether the *session* restores the sandbox mode and model when
argv cannot. That needs two live turns and a credential. Probe unchanged:

```sh
codex exec --json -s read-only 'say A'                  # note thread_id
codex exec resume <id> --json 'try to write /tmp/x'     # is the write refused?
```

**One thing that is settled and bears on it**: `--ephemeral` writes no session
file at all (see the extras below), so `--ephemeral` and `resume` are mutually
exclusive by construction — there is nothing to resume from.

### U4. Can a `codex exec` invocation be given a hard dollar or token ceiling?

**Status: answered — no, not on `codex exec`.** C2's teeth are intact. But a
per-thread **token** budget exists in the app-server protocol, which changes who
could build a ceiling rather than whether one exists.

**Turns on:** C2, and with it the admissibility of every option that lets a
Codex cycle start unattended. `--max-budget-usd` is the only thing bounding what
one Claude cycle spends (`src/lib/cycleInvocation.ts:1115`–`:1118`).

**The full flag surface, from the installed binary.** `codex exec --help` on
0.153.4 lists, in order: `-c/--config`, `--enable`, `--disable`,
`--strict-config`, `-i/--image`, `-m/--model`, `--oss`, `--local-provider`,
`-p/--profile`, `-s/--sandbox`, `--approve-for-me`,
`--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust`,
`-C/--cd`, `--add-dir`, `--thread-source`, `--skip-git-repo-check`,
`--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--output-schema`,
`--color`, `--json`, `-o/--output-last-message`, `-h/--help`, `-V/--version`.
**Nothing denominated in money or tokens.** `grep -icE 'budget|usd|cost'` over
`codex-rs/exec/src/cli.rs` at `rust-v0.153.4` → `0`.

**The config schema, probed rather than guessed.** `--strict-config` rejects a
key this version does not know, so each candidate is one command:

```sh
for k in max_budget_usd budget.max_usd max_cost_usd spend_limit_usd \
         max_tokens token_limit max_total_tokens budget; do
  codex exec --strict-config -c "$k=1" 'x' </dev/null
done
```

Every one returns

```
Error loading config.toml: unknown configuration field `<key>` in -c/--config override
```

(`budget.max_usd` reports the unknown field as `budget`). Controls that
**are** recognised, so the probe is not vacuously failing: `model`,
`project_doc_max_bytes`, `sandbox_mode`, `sandbox_workspace_write`,
`approval_policy`, `shell_environment_policy.inherit`.

**The nearest recognised keys bound context, not spend**:
`model_context_window` and `model_auto_compact_token_limit`. Neither is a
terminus — they change what gets compacted, not when the process stops.

**Where a ceiling does exist.** `codex app-server`'s `thread/goal/set`:

```json
"ThreadGoalStatus": { "enum":
  ["active","paused","blocked","usageLimited","budgetLimited","complete"] },
"properties": {
  "threadId":    { "type": "string" },
  "objective":   { "type": ["string","null"] },
  "status":      { "$ref": "#/definitions/ThreadGoalStatus" },
  "tokenBudget": { "format": "int64", "type": ["integer","null"] }
}
```

— `ThreadGoalSetParams`, from `codex app-server generate-json-schema`. A goal
carries an `int64` **token** budget and a status that can read `budgetLimited`;
`CodexErrorInfo` carries `sessionBudgetExceeded` to match. There is still no
dollar ceiling anywhere, and none of it is reachable from `codex exec`'s argv.

**What this does and does not move.** It does not rescue Option C as written:
`13-recommendation.md`'s largest objection was that a fallback cycle "runs under
a cycle cap and a clock and nothing denominated in money", and that is still
true — a token budget is not a dollar budget, and `codex exec` cannot set even
the token one. What it does is name the price of fixing it: an implementer who
wants a ceiling has to drive `codex app-server` rather than `codex exec`, which
is a different process model, a different event stream from the one
`02-the-handover-contract.md` costed, and a second protocol to pin.

The remaining half of the original probe is unchanged and is an account-side
question: whether the OpenAI platform's project-level spend limits can stand in.
They are not a per-invocation ceiling and would not stop one runaway cycle, so
they answer a different question than `--max-budget-usd` does.

### U5. What does `--sandbox workspace-write` actually permit on Linux, and does it hold under this container's seccomp profile?

**Status: partially answered.** What it *resolves to* is now measured exactly.
Whether it *holds* could not be exercised here.

**Turns on:** [`10-permission-and-credentials.md`](10-permission-and-credentials.md).
This repository already knows that a sandbox can be enabled and confine nothing
(`src/lib/sandbox.ts:201`, `policyNamesSomething`), which is the failure to look
for.

**What it resolves to.** `codex debug prompt-input` renders the permission
profile Codex will describe to the model, with no credential and no turn:

```sh
cd <a git worktree> && codex debug prompt-input -c 'sandbox_mode="workspace-write"' 'hi'
```

Codex's own sentence:

> Filesystem sandboxing defines which files can be read or written.
> `sandbox_mode` is `workspace-write`: The sandbox permits reading files, and
> editing files in `cwd` and `writable_roots`. Editing files in other
> directories requires approval. Network access is restricted.

and the resolved profile, from the same output's `<environment_context>`:

```xml
<permission_profile type="managed"><file_system type="restricted">
  <entry access="read"><special>:root</special></entry>
  <entry access="write"><path>{cwd}</path></entry>
  <entry access="write"><special>:slash_tmp</special></entry>
  <entry access="write"><special>:tmpdir</special></entry>
  <entry access="read"><path>{cwd}/.git</path></entry>
  <entry access="read"><path>{cwd}/.agents</path></entry>
  <entry access="read"><path>{cwd}/.codex</path></entry>
</file_system></permission_profile>
```

Four readings, each with the command that produced it:

- **The whole filesystem is readable** (`:root`), and `/tmp` and `$TMPDIR` are
  writable regardless of the working root.
- **`.git` is read-only, inside the writable root.** So is `.agents` and
  `.codex`. This is the finding that matters most to this app: **a Codex cycle
  under `-s workspace-write` cannot write `.git`, so it cannot commit** without
  escalating through the approval path. Every option here ends in a branch and
  a Land button (`docs/agent/isolation-and-landing.md`), and none of them
  survives an agent that cannot commit. An implementer's choices are an
  approval policy that grants the escalation, an extra writable root, or
  `danger-full-access` — and the third is the one C9 and
  `docs/agent/security.md` exist to argue about.
- **`writable_roots` composes, and the carve-outs follow it.** With
  `-c 'sandbox_workspace_write.writable_roots=["/opt/uf"]'` the profile gains
  `<entry access="write"><path>/opt/uf</path></entry>` *and* read-only entries
  for `/opt/uf/.git`, `/opt/uf/.agents` and `/opt/uf/.codex`. The `.git`
  read-only rule is a property of every writable root, not of the cwd.
- **Network is off by default and is one key away.** With
  `-c 'sandbox_workspace_write.network_access=true'` the sentence becomes
  "Network access is enabled". Also relevant to C11: Codex sets
  `CODEX_SANDBOX_NETWORK_DISABLED=1` inside the sandbox when it is off, which is
  a signal a child can read.

**What could not be established: whether any of it is enforced here.** The
credential-free way to test enforcement is `codex sandbox`, which runs an
arbitrary command under the same machinery:

```
codex sandbox --permission-profile <NAME> | --sandbox-state-json <JSON> <COMMAND>...
```

The state shape was recovered from its own errors — `{"permissionProfile":
{"file_system":{}},"sandboxCwd":"file:///abs/path"}` parses; camelCase
`fileSystem` does not — but every invocation that got past parsing **hung
silently**, producing no stdout and no stderr even under `RUST_LOG=debug`, and
was killed at 25 s:

```sh
RUST_LOG=debug timeout 25 codex sandbox --sandbox-state-json \
  '{"permissionProfile":{"file_system":{}},"sandboxCwd":"file:///…/probe"}' \
  -- /bin/echo ok
→ exit 124, both streams empty
```

The likely cause is nesting: the npm platform package vendors its own
`bwrap` (`…/vendor/aarch64-unknown-linux-musl/codex-resources/bwrap`) beside
`--apply-seccomp-then-exec` and Landlock handling, and the shell these probes
ran in is *itself* inside a bubblewrap sandbox. **That is a hypothesis, not a
measurement** — nothing was logged to confirm it.

**And it is the wrong environment for the question anyway.** The sandbox these
probes ran under is this agent's, not the app's: `orchestrator.ts` spawns its
children directly from the Node server, with no bwrap between. So a `codex
sandbox` failure here says nothing about a `codex exec -s workspace-write`
inside a UsageFoundry container. **The enforcement half of U5 stays open and can
only be answered inside the real image.** The probe there is the original one,
now runnable, and needs a credential only for the third clause:

```sh
codex exec -s workspace-write --json \
  'read /etc/passwd, then curl https://example.com, then write ./x and ./.git/x'
```

### U6. Is there an `--append-system-prompt` equivalent?

**Status: answered — yes.** Three carriers, one of them on argv, and the argv
one survives `resume` and `fork`. This corrects
[`02-the-handover-contract.md`](02-the-handover-contract.md), which records the
appended system prompt as "**absent as an argv**".

**Turns on:** four notices that ride every Claude cycle
(`SELF_HOSTING_NOTICE`, `DELEGATION_NOTICE`, `RENDERING_NOTICE`,
`COMMIT_IDENTITY_NOTICE`) plus the run's frozen file price list
(`src/lib/cycleInvocation.ts:1058`–`:1069`). `COMMIT_IDENTITY_NOTICE` is the one
that matters most: it is what stops an agent signing commits with the operator's
email, and its absence is silent until a commit is published.

**The measurement.** `codex debug prompt-input` renders every message the model
will see, tagged. A repository `AGENTS.md` proves the probe is complete before
it is used to prove a negative:

```sh
cd <worktree> && printf 'UF_SENTINEL_AGENTS_MD marker\n' > AGENTS.md
codex debug prompt-input 'hello'
```

```
5 items
0 developer ["host_skills.instructions","permissions.instructions",
             "collaboration_mode.instructions"]
1 developer ["multi_agent.role_instructions"]
2 developer ["multi_agent.mode_instructions"]
3 user      ["agents_md.instructions","environments.environment_context"]
4 user      ["user.text"]                                     → hello
```

The sentinel lands at item 3. The probe sees what the model sees.

**What carries standing instructions, all four measured the same way:**

| carrier | lands as | role | survives `resume`/`fork` |
|---|---|---|---|
| `-c developer_instructions="<text>"` | `generic.developer_instructions` | **developer**, first content item of item 0 | **yes** — `-c` is accepted by both |
| `$CODEX_HOME/config.toml` → `developer_instructions = "…"` | same slot | developer | yes (config stack, not argv) |
| `-p <name>` → `$CODEX_HOME/<name>.config.toml` | same slot | developer | **no** — `-p` is one of the nine flags `resume`/`fork` drop (U3) |
| `$CODEX_HOME/AGENTS.md` | `agents_md.instructions` | user | yes (file, not argv) |

The global `AGENTS.md` is presented to the model as
`# AGENTS.md instructions for <cwd>` wrapping the text in `<INSTRUCTIONS>` — so
a file outside the worktree arrives labelled as instructions *for* the worktree,
which is a different claim than the text itself makes and worth knowing before
putting a safety notice in it.

```sh
codex debug prompt-input -c 'developer_instructions="UF_A"' 'hello' | grep -c UF_A
→ 1
```

and the landing slot, from the same run's metadata:

```
item 0  role developer
kinds ["generic.developer_instructions","host_skills.instructions",
       "permissions.instructions","collaboration_mode.instructions"]
```

— **ahead of** Codex's own skills, permissions and collaboration-mode blocks.
That is a stronger position than `--append-system-prompt` gives on the Claude
side, where the text is appended.

`-p` really does read its file, proven by making that file the thing
`--strict-config` complains about:

```sh
printf 'developer_instructions = "…"\nbogus_key_uf = 1\n' > "$CODEX_HOME/ufp.config.toml"
codex exec --strict-config -p ufp 'x' </dev/null
→ Error loading config.toml:
  /…/ufp.config.toml:2:1: unknown configuration field `bogus_key_uf`
```

**Two traps found on the way, both worth carrying forward.**

1. **`experimental_instructions_file` does not exist in 0.153.4.**
   `--strict-config` rejects it and `grep -c -a` over the platform binary
   returns `0`. If it was ever the answer, it is not this one.
2. **`--strict-config` proves a key is *parsed*, not that it *does* anything.**
   The key `instructions` passes `--strict-config` — no unknown-field error —
   and reaches nothing:

   ```sh
   codex debug prompt-input -c 'instructions="UF_SENTINEL_INSTR"' 'hello' \
     | grep -c UF_SENTINEL_INSTR
   → 0
   ```

   Same for `instructions = "…"` in `config.toml`. A key that survives
   `--strict-config` still has to be shown landing in `prompt-input`. This is
   the same class of failure as `policyNamesSomething` in U5: configured, and
   confining nothing.

   (Note `codex debug prompt-input` accepts neither `--strict-config` nor `-C`
   nor `-p`; it must be run from the working directory, and a `--strict-config`
   in the command line makes it exit 2 with empty stdout, which reads as a
   negative result if it is not checked.)

**A fifth carrier exists and could not be tested here: the managed layer.**
`ConfigRequirements.additionalDeveloperInstructions` (`string | null`) is in the
app-server schema beside `allowedSandboxModes`, `allowedApprovalPolicies` and
`defaultPermissions`, and `managed_developer_instructions` is one of the prompt
content-item kinds carried in the binary. The binary also carries layer names —
packaged defaults, MDM, system, enterprise-managed, user, project, session
flags and a legacy file — and the paths `/etc/codex/config.toml`,
`/etc/codex/requirements.toml` and `/etc/codex/managed_config.toml`. **Those are
strings read out of the binary, not a precedence order this pass established**,
and `/etc` is not writable from this sandbox, so **the managed route is
schema-level only and unverified.** It is the interesting one for a *deployment*, because it is the
only carrier an agent cannot see in its own argv or `$CODEX_HOME`.

**What this settles for the safety notices.** `SELF_HOSTING_NOTICE` and
`COMMIT_IDENTITY_NOTICE` **can** ride a Codex cycle, on argv, at the front of
the developer message, and can ride a resumed one too. What still has no
equivalent is the other half of the pair — `--disallowedTools
Bash(pkill:*) Bash(killall:*)` — which is a *denial*, not a notice, and nothing
found here does it per invocation. Codex's execpolicy `.rules` files and
`--ignore-rules` remain the file-based near-equivalent, with a different
lifetime, and were not exercised.

### U7. Can MCP servers be attached per invocation, and would `/api/mcp` accept a Codex client?

**Status: still deferred, deliberately.** Nothing in scope depends on it.

**Turns on:** less than it appears. `buildArgs` carries **no** `--mcp-config` —
grep finds MCP wiring only on the chat path (`src/app/api/mcp/route.ts` and its
consumers), not the run path. So the MCP tool surface is **not** part of the run
contract a fallback has to satisfy.

The installed binary confirms the mechanism without changing the conclusion:
`codex mcp` is a top-level subcommand ("Manage external MCP servers for Codex"),
`codex mcp-server` runs Codex *as* an MCP server over stdio, and servers are
configured in `config.toml` — reachable per invocation via `-c`, since `-c`
takes dotted paths and parses TOML. So "per invocation" is *possible*; it is
still out of scope.

### U8. How large a prompt can `codex exec` take on argv?

**Status: answered.** About 128 KiB, and the limit is not the one the original
probe would have blamed.

**Turns on:** whether a handover brief can be passed the way `-p <prompt>` is
today.

```sh
for n in 100000 200000 1000000 2000000; do
  P=$(head -c $((n*3/4)) /dev/zero | tr '\0' 'a')
  codex debug prompt-input "$P" >/dev/null
done
→ 100000  OK
→ 200000  /usr/local/bin/codex: Argument list too long   (exit 126)
→ 1000000 Argument list too long
→ 2000000 Argument list too long

getconf ARG_MAX → 2097152
```

**`ARG_MAX` is 2 MB and the prompt fails at 200 KB**, because the binding
constraint is Linux's per-*argument* limit, `MAX_ARG_STRLEN` = 32 pages =
131,072 bytes, not the total. Bisected, so it is measured rather than assumed:

```
131000 OK   131060 OK   131070 OK   131080 fail   132000 fail
```

The cliff sits within ten bytes of 131,072. So the ceiling is per argument, and
no amount of trimming elsewhere in argv buys headroom for the prompt.

`08-continuity.md`'s briefs are well under that, so argv is viable — but the
threshold is a cliff with a confusing error (`E2BIG` reported against the
binary, not the argument), and a brief that crosses it fails before Codex runs.

Codex's own answer above the cliff is stdin, and its behaviour there is
measured: `codex exec` prints `Reading additional input from stdin...` **to
stderr** whenever stdin is not a TTY — including when it is `/dev/null`, which
is what this app's `stdio: ["ignore", "pipe", "pipe"]`
(`orchestrator.ts:5628`) supplies. So the current spawn discipline already
produces that line and reads EOF harmlessly; using stdin for the prompt means
opening it, which is the change to the spawn the original entry named.

### U9. Is the `--json` event stream stable across Codex releases?

**Status: answered for this bump — byte-identical.**

**Turns on:** whether the pin argument at `Dockerfile:373`–`:377` applies with
equal force. The `--json` flag carries `alias = "experimental-json"`, which is
the CLI's own statement that this surface was recently experimental — and still
does at 0.153.4.

```sh
for t in rust-v0.152.1 rust-v0.153.4; do
  curl -sS -o "ev-$t.rs" \
    "https://raw.githubusercontent.com/openai/codex/$t/codex-rs/exec/src/exec_events.rs"
  curl -sS -o "cli-$t.rs" \
    "https://raw.githubusercontent.com/openai/codex/$t/codex-rs/exec/src/cli.rs"
done
diff ev-rust-v0.152.1.rs ev-rust-v0.153.4.rs   → no output, exit 0   (320 lines each)
diff cli-rust-v0.152.1.rs cli-rust-v0.153.4.rs → no output, exit 0   (318 lines each)
```

**`exec_events.rs` and `codex-rs/exec/src/cli.rs` are unchanged between the two
releases.** `codex-rs/exec/src/lib.rs` went 2,163 → 2,167 lines and the entire diff is
one rollout-file reader swapped for a seekable reverse scanner — nothing on the
event surface.

Everything `02-the-handover-contract.md` read therefore holds at the installed
version, and three details it recorded are re-confirmed at the tag: the item
union still has nine members including `collab_tool_call`;
`CommandExecutionStatus` is still `{ in_progress, completed, failed, declined }`,
so item 9's "dedicated status beats text matching" stands; and
`CommandExecutionItem` still carries `{ command, aggregated_output,
exit_code: Option<i32>, status }` on one item, so item 8's "better shaped than
Claude's" stands.

**What this does not license.** One bump is one data point, and it is a patch-ish
minor. The union is still behind an `experimental-json` alias, and
`Dockerfile:373`–`:377`'s argument for pinning is unweakened — the check is
cheap enough (`diff` over two `curl`s) to make a condition of every version
bump rather than a one-off.

### U10. What does a Codex cycle actually cost?

**Status: still open on the number. The mechanism is no longer "nowhere", and
that is a correction to `README.md`.**

**Turns on:** every figure in [`09-guards-and-metering.md`](09-guards-and-metering.md).

**The model catalog is readable with no credential, and carries no prices:**

```sh
codex debug models
→ gpt-6-astra, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna,
  gpt-daybreak-blue-latest, gpt-daybreak-red-latest,
  gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.2, codex-auto-review
```

Per-model keys include `context_window`, `max_context_window`,
`default_reasoning_level` and `base_instructions`; a regex for
`price|cost|rate|usd` over the whole document returns `(none)`. So the second
half of the original unknown — "what that model's input/output rates are" — is
not answerable from the CLI at all, and the first half, which model `codex exec`
defaults to under a given account, still needs an account.

**But Codex has an OTel exporter and it emits a per-turn cost.** Probed the same
way as U4:

```sh
codex exec --strict-config -c 'otel.exporter="bogus"' 'x' </dev/null
→ Error loading config.toml: unknown variant `bogus`, expected one of
  `none`, `statsig`, `otlp-http`, `otlp-grpc`
  in `otel.exporter`
```

`otel.environment` and `otel.log_user_prompt` are recognised too
(`otel.enabled` and `otel.include_events` are not). And the metric names carried
in the platform binary, beside `codex-rs/otel/src/events/session_telemetry.rs`,
include:

```
codex.api_request   codex.api_request.duration_ms   codex.conversation.turn.count
codex.tool.call     codex.tool.call.duration_ms
codex.turn.token_usage        codex.turn.cost_microusd
```

**`codex.turn.cost_microusd` is a per-turn figure denominated in money, exported
over OTLP** — which is a transport this app already ingests (`src/lib/otlp.ts`,
one of the three sources). The app-server protocol carries the same idea as a
readable value: `ThreadUsage { estimatedUsageUsdMicros: int64|null,
estimatedUsageCreditsMicros: int64, groups: [{ model, inputTokens,
cachedInputTokens, netNewInputTokens, outputTokens, reasoningEffort,
estimatedUsageCreditsMicros }] }`.

**So `README.md`'s "a Codex cycle has zero of the three" is wrong, and
`02-the-handover-contract.md`'s "there is no cost field anywhere in the union"
is right but narrower than it reads** — it is true of the `codex exec --json`
union and false of Codex. One of the three sources is available, over the
transport the app already reads, and it carries money.

**What that does not settle, and why C1 is unchanged.** A `codex.turn.cost_microusd`
would still be a **fourth population over a fourth time base**, and C1's
prohibition is on *summing*, not on *sourcing*. It may appear beside the three;
it may never be added into `runs.spent_usd`, a dashboard meter or a window
fraction. And three things about it are unverified and each could make it
useless:

- whether it is populated at all on a ChatGPT-plan account, where the marginal
  dollar cost of a turn is not a number OpenAI bills;
- whether `estimatedUsage*Micros` means dollars or plan credits — the schema
  carries **both** fields, and the credits one is the required one while the USD
  one is nullable;
- whether standing up an OTLP path for a second provider is proportionate to a
  figure this app is forbidden from summing anyway.

**What would settle it:** an account, then `codex exec --json -c
'otel.exporter="otlp-http"' 'hi'` against a collector, and read whether
`codex.turn.cost_microusd` arrives and with what value for a turn whose tokens
are known.

---

## The rest of the CLI surface, measured

Not unknowns, but they change Option C's design and the first pass did not have
them. Each is what the binary actually did, not a summary of the help text.

### `-o, --output-last-message <FILE>` — a `DONE` contract with no JSONL parsing

C5's candidate, and the measurement is about its failure mode. On the failed
turn in U1:

```sh
codex exec --json -o last.txt 'hi' </dev/null ; ls -la last.txt
→ exit 1
→ ls: cannot access 'last.txt': No such file or directory
```

**A failed turn writes no file.** So an adapter has three states, not two —
written, written-empty, and absent — and only the third distinguishes "the cycle
failed" from "the agent said nothing", which is exactly the distinction
`finalText` needs to decide whether a run may end on its own judgement. The
happy path (a file written on a successful turn) needs a credential and was not
observed.

### `codex exec resume` and `codex exec fork`

Covered under U3. The short version: `exec`'s flags minus nine — `--add-dir`,
`--approve-for-me`, `--cd`, `--color`, `--local-provider`, `--oss`,
`--profile`, `--sandbox`, `--version`. `resume` adds `--all` and `--last` and
takes `[SESSION_ID]` or `--last`; `fork` adds nothing and requires
`<SESSION_ID>`; both take a UUID or a thread name.

### `--ephemeral` — and what a non-ephemeral run writes

```sh
rm -rf "$CODEX_HOME/sessions"
codex exec --json --ephemeral 'x' </dev/null ; find "$CODEX_HOME/sessions" -type f
→ (nothing — the directory is not created)

rm -rf "$CODEX_HOME/sessions"
codex exec --json 'x' </dev/null ; find "$CODEX_HOME/sessions" -type f
→ sessions/2026/09/05/rollout-2026-09-05T10-11-08-01a0710c-f089-7ee1-820f-8274ddeff1ee.jsonl
```

A normal run writes one rollout JSONL per session under
`$CODEX_HOME/sessions/YYYY/MM/DD/`, named with the timestamp and the
`thread_id`. `--ephemeral` writes none — **so it forecloses `resume` and
`fork`**, and it is the flag to reach for if the alternative is a rollout file
per cycle accumulating under a container path nobody put on
`docs/agent/retention.md`'s map (C7).

Note that both invocations above still failed at auth, and the rollout was
written anyway — the file is a session record, not a success record.

### `--ignore-user-config`

Does not load `$CODEX_HOME/config.toml`; **auth still uses `CODEX_HOME`** (its
own help says so, and the separation is the point). Measured, by making the
config file the thing `--strict-config` complains about:

```sh
printf 'bogus_key_uf = 1\n' > "$CODEX_HOME/config.toml"
codex exec --strict-config 'x' </dev/null
→ Error loading config.toml:
  /…/config.toml:1:1: unknown configuration field `bogus_key_uf`
codex exec --ignore-user-config --strict-config 'x' </dev/null
→ (no config error; proceeds to the auth failure)
```

**`-c` overrides are still parsed and still validated** under it:

```sh
codex exec --ignore-user-config --strict-config -c 'bogus_uf_flag=1' 'x' </dev/null
→ Error loading config.toml: unknown configuration field `bogus_uf_flag` in -c/--config override
```

So it is the flag that makes a spawn independent of whatever is in the
operator's `CODEX_HOME` while still letting the caller write the whole policy on
argv — which is the shape this app would want. Whether it also suppresses
`/etc/codex/*` was **not** tested, because `/etc` is not writable here;
`codex sandbox` carries a separate `--include-managed-config`, which suggests
the managed layer is handled independently of this flag.

### `--add-dir <DIR>`

Accepted by `exec`, `resume` **and** `fork` — one of the few things `resume`
keeps. Its own help says the directories "should be **writable** alongside the
primary workspace", which is the same finding `cycleInvocation.ts:984`–`:986`
records for Claude's flag. The equivalent config key is
`sandbox_workspace_write.writable_roots`, and U5 shows what adding a root does
to the resolved profile — including that the new root gets its own read-only
`.git`.

### `CODEX_HOME`

Honoured everywhere. It holds `$CODEX_HOME/auth.json`, `sessions/`, `installation_id`,
`goals_1.sqlite*`, `skills/`, `AGENTS.md` and `<name>.config.toml` for `-p`.
Two behaviours worth knowing before wiring it:

- With `CODEX_HOME` under `$TMPDIR`, Codex prints `Refusing to create helper
  binaries under temporary dir "…"` and proceeds. It is a warning, not a
  failure, but it means a `CODEX_HOME` on a tmpfs gets a different install than
  one on a volume.
- The relevant credential env vars in the 0.153.4 binary are `CODEX_API_KEY`,
  `CODEX_ACCESS_TOKEN` and `OPENAI_API_KEY` (`codex-rs/login/src/lib.rs:38-47`
  re-exports all three, and those lines are identical at both tags). **All three
  are what C10 is about**, and `childEnv` strips none of them.

### The login surface

The next run in this sequence builds a sign-in on these, so this is what each
one printed rather than what it is for.

```sh
codex login status                          # no credential
→ Not logged in                                                        ; exit 1

printf 'sk-uf-not-a-real-key\n' | codex login --with-api-key
→ Reading API key from stdin...
→ Successfully logged in                                               ; exit 0

codex login status                          # after the above
→ Logged in using an API key - sk-uf-no***l-key                        ; exit 0

printf 'not-a-real-access-token\n' | codex login --with-access-token
→ Reading access token from stdin...
→ Error logging in with access token: invalid agent identity JWT format ; exit 1

codex logout
→ Successfully logged out                                              ; exit 0
```

`$CODEX_HOME/auth.json` is written mode `0600` and its shape is

```json
{ "auth_mode": "apikey", "OPENAI_API_KEY": "<the key>" }
```

Four things a sign-in built on this has to handle:

1. **`--with-api-key` does not validate.** `Successfully logged in` and exit 0
   for a key that is not a key. The only way to know a key works is a turn.
   `--with-access-token` *does* validate, and rejects a non-JWT by format —
   the two are not symmetric.
2. **`codex login status` echoes a masked key to stdout** (`sk-uf-no***l-key`).
   Anything that relays that line relays a prefix and a suffix of a live
   credential.
3. **Neither flag takes the secret on argv.** Both read stdin, which is what
   makes them usable from a server without the value landing in
   `/proc/<pid>/cmdline` — the same property `docs/agent/security.md` requires
   of this app's own spawns.
4. `codex login --with-api-key` is equivalent to writing `$CODEX_HOME/auth.json` directly.
   That is worth knowing because it means a deployment can provision auth
   without running the binary, and `--ignore-user-config`'s "auth still uses
   `CODEX_HOME`" is what makes that stable.

**`codex login --device-auth` is the headless flow, and it works from here.**
It reaches `auth.openai.com` through the proxy and prints, to **stdout**:

```
Welcome to Codex [v0.153.4]
OpenAI's command-line coding agent

Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   https://auth.openai.com/codex/device

2. Enter this one-time code (expires in 15 minutes)
   VYP3-5CFML

Continue only if you started this login in Codex. If a website or another
person gave you this code, cancel.
```

then **blocks, polling**, and does not exit on its own inside the code's
15-minute life. Three consequences for a UI built on it:

- the URL and the code are on **stdout**, so a caller must read the stream
  incrementally rather than waiting for exit;
- the output carries **ANSI colour codes** around the URL and the code
  (`\e[94m…\e[0m`), and `codex login` has **no `--color` flag** — only
  `codex exec` does — so a caller strips them itself;
- the process is the thing that completes the login, so it has to be kept alive
  and cancellable, and its lifetime is bounded by the code's 15 minutes rather
  than by anything the caller sets.

`codex login` (no flag) is the browser flow and was not run, because there is no
browser here and it would have blocked the same way.
