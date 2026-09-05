# Validation

Three sections: **verified** (re-checked, with the command), **corrected**
(things the brief or an earlier draft of this proposal got wrong), and **not
verified** (claims standing on reasoning or on source-reading rather than on
observation, each flagged where it is used).

Everything in §1a–§1d was run in this container at `db10377`. **§1e and §1f are
a second pass at `879c8ab`, after `codex-cli 0.153.4` was installed** — the
first pass had no binary, and eight of the ten Codex unknowns moved — four
answered outright, four in part. Where the two passes disagree the second one
wins, and §2f and §2g say so by name.

## 0. Every citation resolved mechanically

```sh
node proposals/ProviderFallback/scripts/check-citations.mjs
→ files 16  links 51  repo paths 301  foreign names 74  named lines 202  bare :N 311
  no problems
```

The script checks three things: that every internal markdown link resolves to a
sibling file; that every `path/file.ts:N` names a real path with at least N
lines; and that every bare `` `:N` `` chains to the last **named** repo path in
the same markdown file, which is the convention `proposals/ContextControl/19-validation.md`
found fifty violations of across eight files.

**On the first pass this proposal had 53 of them.** Every one was qualified in
place — a bare line reference sitting after a `src/lib/budget.ts` citation but
meaning `src/lib/orchestrator.ts:1652` was rewritten to name its own file — and
the run above is the result. Names that are
not this repository's (the Codex sources, `config.toml`, `AGENTS.md`, absolute
host paths) suppress the anchor rather than erroring, so a bare reference after
one is *reported* rather than silently chained to something older.

---

## 1. Verified

### 1a. The refusal path

| claim | where | how checked |
|---|---|---|
| `isUsageLimit` matches the CLI's refusal text and vetoes `spend\|credit\|credits\|balance` | `src/lib/orchestrator.ts:1438`–`:1444` | read |
| `refusalKind` files an allowance wall first, then rate limit, then transient | `:1540`–`:1545` | read |
| `refusalDisposition` parks an allowance refusal below `MAX_PAUSES_PER_RUN`, else fails `pauses-spent` | `:1795`–`:1818` | read |
| `MAX_PAUSES_PER_RUN = 3` | `:1652` | read |
| the call site, and the park branch writing `status = "paused"` and refunding the cycle | `:8125`, `:8174`–`:8192` | read |
| `REFUSAL_BACKOFF_MS = [20, 40, 60]` min, `MIN_REFUSAL_WAIT_MS = 5` min, `MAX_REFUSAL_WAIT_MS = 6` h | `:1640`–`:1644` | read |
| all four `refusalStopReason` sentences name Claude | `:1836`, `:1840`, `:1847`, `:1851` | read |
| `MAX_RESUMES_PER_SWEEP = 4` against a 60-second tick | `:9272` | read |

### 1b. The spawn and stream contract

| claim | where |
|---|---|
| `spawn(CLAUDE_BIN, args)`, no shell, `stdio: ["ignore","pipe","pipe"]`, own process group | `:5621`, `:5619`–`:5621`, `:5628`, `:5634` |
| the fourteen reads in `00-problem.md` §3a | `orchestrator.ts:6595`–`:6919`, each row cited individually |
| cost comes only from `result.total_cost_usd` | `orchestrator.ts:6819` |
| `subtype` is "the only machine-readable statement the CLI makes about *why* a cycle ended" | `src/lib/cycleInvocation.ts:102`–`:104` |
| `buildArgs`' argv, in order | `src/lib/cycleInvocation.ts:1023`–`:1119` |
| `--max-budget-usd` is the only in-cycle spend bound | `:1115`–`:1118`, `src/lib/budget.ts:14`–`:19` |
| `--plugin-dir` is not restored by `--resume` | `cycleInvocation.ts:955`–`:962` |
| `PROCESS_KILLERS = ["Bash(pkill:*)", "Bash(killall:*)"]`, unconditional | `cycleInvocation.ts:650`, `:1050` |
| `SELF_HOSTING_NOTICE` is what stops the agent routing around them | `:652`–`:663` |
| `childEnv` strips six classes, none of them an OpenAI key | `src/lib/orchestrator.ts:5369`–`:5384` |
| `authEnv` is a deliberate copy, and `ANTHROPIC_API_KEY` is deliberately not stripped | `src/lib/claudeAuth.ts:245`–`:273` |
| five `CLAUDE_BIN` spawn sites | `orchestrator.ts:5621`, `chat.ts:2104`, `review.ts:660`, `claudeAuth.ts:302`, `:414` — `grep -rn "spawn(" src/lib` |

### 1c. Guards and metering

| claim | where |
|---|---|
| the guard order: `no_terminus`, `iterations`, `duration`, `run_cost`, `run_tokens`, `weekly_fraction`, `session_fraction`, held `no_ceiling` | `src/lib/budget.ts:494`, `:502`, `:514`, `:524`, `:531`, `:558`, `:574`, `:556` |
| `maxDurationMinutes` includes parked time | `:99`–`:101` |
| `maxIterations`/`maxDurationMinutes` are the only monotone termini | `:86`–`:91` |
| `PRICES` has 20 keys and all 20 begin `claude-` | `src/lib/pricing.ts:31`–`:59`; counted by `node -e` over the literal → `count 20`, `non-claude: (none)` |
| `guardCostOf` substitutes `UNKNOWN_MODEL_PRICE = { input: 10, output: 50 }` | `:194`, `:198`, `:84` |
| three data sources, never summed or mixed in the UI | `docs/agent/architecture.md:10`; `docs/agent/metering.md:50` |
| `byAgent.counterfactualUSD` is the precedent for a further figure that reaches no meter | `src/lib/windows.ts:703`, `:1150`; `src/lib/windows.test.ts:1004`, `:1031`–`:1032` |

### 1d. This machine

| claim | command | result |
|---|---|---|
| `codex` is not installed | `command -v codex` | exit 1, no output |
| no Codex/OpenAI reference in the app | `grep -rni codex src/ docs/ README.md` (excl. `proposals/`) | 0 |
| Claude Code is pinned at 2.1.226 and is the only agent CLI | `Dockerfile:378`–`:379` | read |
| `@anthropic-ai/sandbox-runtime` pinned at 0.0.71 | `Dockerfile:400`–`:402` | read |
| the network is reachable through a proxy | `curl -sS -o /dev/null -w '%{http_code}' https://registry.npmjs.org/@openai/codex` | `200` |
| DNS is **not** the right probe here | `getent hosts registry.npmjs.org` | exit 2, while `curl` succeeds |
| the local database is a dev scratch file | `node -e` + `better-sqlite3`, read-only, over `.data/usagefoundry.db` | `runs 0`, `run_events 0`, `ops_events 1`, `request_log 8`, `chat_sessions 1` |
| `/data` is unreadable from here | `ls -la /data` | empty; the sandbox's read denylist includes it |

### 1e. The Codex CLI, read from source

Every one of these was **`openai/codex@main` as fetched on 2026-09-02** on the
first pass, with **no binary run**. The second pass re-fetched the two files the
whole reading rests on at both release tags and found them **byte-identical**,
so the table below now stands at the installed version rather than at a moving
branch:

```sh
for t in rust-v0.152.1 rust-v0.153.4; do
  curl -sS -o "ev-$t.rs"  "https://raw.githubusercontent.com/openai/codex/$t/codex-rs/exec/src/exec_events.rs"
  curl -sS -o "cli-$t.rs" "https://raw.githubusercontent.com/openai/codex/$t/codex-rs/exec/src/cli.rs"
done
diff ev-rust-v0.152.1.rs  ev-rust-v0.153.4.rs   → exit 0, no output   (320 lines each)
diff cli-rust-v0.152.1.rs cli-rust-v0.153.4.rs  → exit 0, no output   (318 lines each)
```

`codex-rs/exec/src/lib.rs` went 2,163 → 2,167 lines over the same bump, and the
whole diff is one rollout-file reader swapped for a seekable reverse scanner.
The one citation in this folder that names a Codex source **by line** —
`codex-rs/login/src/lib.rs:38-47`, in
[`10-permission-and-credentials.md`](10-permission-and-credentials.md) — was
read at both tags and is identical, so no line number here has drifted.

| claim | file |
|---|---|
| `@openai/codex` 0.152.1, Apache-2.0, `bin/codex.js` over platform `optionalDependencies` | `https://registry.npmjs.org/@openai/codex/0.152.1` |
| `codex exec [OPTIONS] [PROMPT]`, subcommands `resume`/`fork`/`review` | `codex-rs/exec/src/cli.rs` |
| `--json` (alias `--experimental-json`) prints events as JSONL, global | `cli.rs` |
| `-o/--output-last-message`, `--output-schema`, `--ephemeral`, `--skip-git-repo-check`, `--ignore-user-config`, `--ignore-rules`, `--strict-config` | `cli.rs` |
| `-m/--model`, `-s/--sandbox`, `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`), `--approve-for-me`, `-C/--cd`, `--add-dir`, `-p/--profile` | `codex-rs/utils/cli/src/shared_options.rs` |
| sandbox modes are exactly `read-only`, `workspace-write`, `danger-full-access` | `codex-rs/utils/cli/src/sandbox_mode_cli_arg.rs` |
| approval modes are exactly `on-request` and `never` | `codex-rs/utils/cli/src/approval_mode_cli_arg.rs` |
| `-c key=value` overrides `~/.codex/config.toml`, value parsed as TOML | `codex-rs/utils/cli/src/config_override.rs` |
| the eight top-level JSONL events and the nine item types | `codex-rs/exec/src/exec_events.rs` |
| `Usage` is five integers and **carries no cost** | `exec_events.rs` |
| `thread.started.thread_id` is documented as resumable | `exec_events.rs` |
| auth reads `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN` | `codex-rs/login/src/lib.rs:38-47`; `codex-rs/login/src/auth_env_telemetry.rs` |
| ChatGPT-plan auth persists a `chatgpt_plan_type` under `CODEX_HOME` | `codex-rs/login/src/token_data.rs` |
| `shell_environment_policy` has `inherit`, `exclude`, `include_only`, `set`, `ignore_default_excludes` | `codex-rs/config/src/shell_environment_policy.rs` |
| **no rate-limit or quota handling by name in the exec crate** | `grep -inE 'rate_limit\|usage_limit\|quota'` over `codex-rs/exec/src/lib.rs` at `rust-v0.153.4` (2,167 lines) → 0 |
| **no per-invocation spend ceiling anywhere in the flag surface** | `cli.rs` + `shared_options.rs`, both read in full; re-confirmed against `codex exec --help` on the binary, §1f |
| the item union still has nine members incl. `collab_tool_call`; `CommandExecutionStatus` is `{in_progress, completed, failed, declined}`; `CommandExecutionItem` carries `{command, aggregated_output, exit_code, status}` on one item | `exec_events.rs` at `rust-v0.153.4` |
| every `Usage` field's docblock says "during the turn"; `cache_write_input_tokens` carries `#[serde(default)]` | `exec_events.rs` at `rust-v0.153.4` |

Reproduce the whole Codex-side reading with:

```sh
D=$(mktemp -d)
curl -sS -o "$D/pkg.json"  https://registry.npmjs.org/@openai/codex/0.152.1
for f in exec/src/cli.rs exec/src/exec_events.rs exec/src/lib.rs \
         utils/cli/src/shared_options.rs utils/cli/src/sandbox_mode_cli_arg.rs \
         utils/cli/src/approval_mode_cli_arg.rs utils/cli/src/config_override.rs \
         login/src/lib.rs login/src/auth_env_telemetry.rs login/src/token_data.rs \
         config/src/shell_environment_policy.rs; do
  curl -sS -o "$D/$(echo "$f" | tr / _)" \
    "https://raw.githubusercontent.com/openai/codex/rust-v0.153.4/codex-rs/$f"
done
```

(The first pass used `main` in place of the tag. Use the tag — a survey that
cannot say which build it read is the thing `Dockerfile:373`–`:377` argues
against.)

### 1f. The Codex CLI, run

`codex-cli 0.153.4` at `/usr/local/bin/codex`, **no OpenAI credential**
(`codex login status` → `Not logged in`, exit 1). Every row below is the
binary's own output. The full reasoning, and what each one changes, is in
`01-constraints.md` Part 2; this table is the audit trail.

| claim | command | result |
|---|---|---|
| the version | `codex --version` | `codex-cli 0.153.4` |
| **no dollar or token ceiling on `codex exec`** | `codex exec --help`; then `codex exec --strict-config -c '<k>=1'` for `max_budget_usd`, `budget.max_usd`, `max_cost_usd`, `spend_limit_usd`, `max_tokens`, `token_limit`, `max_total_tokens`, `budget` | 26 flags, none denominated in money or tokens; all eight keys → `unknown configuration field` |
| the `--strict-config` probe is not vacuously failing | same, with `model`, `project_doc_max_bytes`, `sandbox_mode`, `approval_policy` | all recognised |
| a **token** budget exists one protocol down | `codex app-server generate-json-schema --out $D` | `ThreadGoalSetParams.tokenBudget: int64`; `ThreadGoalStatus` includes `usageLimited`, `budgetLimited` |
| **an `--append-system-prompt` equivalent exists, on argv** | `codex debug prompt-input -c 'developer_instructions="UF_A"' 'hello'` | lands as `generic.developer_instructions`, first content item of the first **developer** message |
| …and via the config file, and via `-p` | `$CODEX_HOME/config.toml`; `codex exec --strict-config -p ufp` | same slot; `-p` reads `$CODEX_HOME/ufp.config.toml` (proved by a bogus key rejected with its line:col) |
| …and `$CODEX_HOME/AGENTS.md` | `codex debug prompt-input 'hello'` | lands as `agents_md.instructions`, **user** role |
| the prompt-input probe is complete | a repository `AGENTS.md` with a sentinel | 5 items; sentinel at item 3 beside `environments.environment_context` |
| `experimental_instructions_file` **does not exist** in 0.153.4 | `--strict-config`; `grep -c -a` over the platform binary | rejected; `0` |
| **a key can pass `--strict-config` and do nothing** | `-c 'instructions="…"'` then `codex debug prompt-input` | recognised, and reaches no message |
| what `-s workspace-write` resolves to | `codex debug prompt-input -c 'sandbox_mode="workspace-write"' 'hi'` | read `:root`; write `cwd`, `:slash_tmp`, `:tmpdir`; **read-only `.git`, `.agents`, `.codex`** |
| a writable root brings its own read-only `.git` | `-c 'sandbox_workspace_write.writable_roots=["/opt/uf"]'` | `/opt/uf` write, `/opt/uf/.git` read |
| network is off under `workspace-write` and is one key away | `-c 'sandbox_workspace_write.network_access=true'` | "Network access is enabled" |
| enforcement **could not be exercised** | `RUST_LOG=debug timeout 25 codex sandbox --sandbox-state-json …` | hangs; exit 124; both streams empty. Codex vendors its own `bwrap` (529,168 bytes, `…/codex-resources/bwrap`) and these probes ran inside one |
| `codex exec --json` stdout is pure JSONL; tracing is on stderr | `codex exec --json 'hi' >out 2>err` | 14 stdout lines, `grep -cv '^{'` → `0` |
| **`{"type":"error"}` is usually not fatal** | same run | 10 of the 14 lines are top-level `error`; **nine** say `Reconnecting... N/5`; `ErrorItem`'s docblock says "non-fatal" |
| Codex has its own retry ladder | same run, timed twice | WebSocket attempts → HTTPS transport fallback (as an `item.completed`) → five more; 18 s and 19 s wall |
| `turn.failed.error` is `{message}` and carries no code | same run | `{"type":"turn.failed","error":{"message":"unexpected status 401 …"}}`; exit 1 |
| a machine-readable code exists **only** on the app-server protocol | `generate-json-schema` | `CodexErrorInfo` = `usageLimitExceeded`, `rateLimitExceeded`, `sessionBudgetExceeded`, `contextWindowExceeded`, … ; `ErrorNotification.willRetry: boolean` |
| **`-o <FILE>` is not written when the turn fails** | `codex exec --json -o last.txt 'hi'; ls last.txt` | `No such file or directory` |
| the argv prompt ceiling is 128 KiB, not `ARG_MAX` | prompts of 100,000 and 200,000 bytes, then bisected | `OK` / `Argument list too long`; the cliff is between 131,070 and 131,080 — `MAX_ARG_STRLEN`, while `getconf ARG_MAX` → `2097152` |
| `codex exec` announces a stdin read even from `/dev/null` | `codex exec --json 'hi' </dev/null` | `Reading additional input from stdin...` on **stderr** |
| `resume`/`fork` drop **nine** of `exec`'s flags | `comm` over the three `--help` flag lists (26 / 19 / 17) | `--add-dir`, `--approve-for-me`, `--cd`, `--color`, `--local-provider`, `--oss`, `--profile`, `--sandbox`, `--version`; `resume` adds `--all` and `--last` |
| `--ephemeral` writes no session file | `rm -rf $CODEX_HOME/sessions` then one run each way | nothing vs `sessions/2026/09/05/rollout-<ts>-<thread_id>.jsonl` |
| the model catalog is readable with no credential and **carries no prices** | `codex debug models` | 11 slugs; a `price\|cost\|rate\|usd` regex over the whole document → `(none)` |
| **Codex has an OTel exporter and it emits a per-turn cost** | `codex exec --strict-config -c 'otel.exporter="bogus"'`; metric names in the platform binary | `expected one of none, statsig, otlp-http, otlp-grpc`; `codex.turn.cost_microusd`, `codex.turn.token_usage` |
| `--with-api-key` **does not validate** | `printf 'sk-uf-not-a-real-key\n' \| codex login --with-api-key` | `Successfully logged in`, exit 0; `$CODEX_HOME/auth.json` mode 0600, `{"auth_mode":"apikey","OPENAI_API_KEY":"…"}` |
| `--with-access-token` does | `printf 'not-a-real-access-token\n' \| codex login --with-access-token` | `Error logging in with access token: invalid agent identity JWT format`, exit 1 |
| `login status` **echoes a masked key** | `codex login status` | `Logged in using an API key - sk-uf-no***l-key` |
| `--device-auth` works headless, prints to stdout, and blocks | `codex login --device-auth` | `https://auth.openai.com/codex/device` + a one-time code, ANSI-coloured, expiring in 15 minutes; no exit inside that window |
| the credential env vars are all three | `grep -aoE 'CODEX_[A-Z0-9_]+'` over the platform binary; `codex-rs/login/src/lib.rs:38-47` | `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `OPENAI_API_KEY` — **none of which `childEnv` strips**, §4 |

Two things this pass could **not** do, and neither is a matter of effort:

- **No live model turn.** There is no OpenAI credential on this machine and
  `~/.codex` holds no credential file. Everything downstream of a completed turn —
  U1's quota text, U2's one-`turn.completed`-per-invocation, U3's restore
  semantics, U10's number — is still open and is marked so in
  `01-constraints.md` Part 2.
- **No sandbox enforcement test.** `codex sandbox` hangs here, and the
  environment it hangs in is this agent's own bubblewrap sandbox rather than a
  UsageFoundry container, so the result would not transfer even if it had one.

---

## 2. Corrected

Six things this survey found wrong — three in the brief that commissioned it,
three in its own first pass. Whether each made the recommendation easier or
harder:

### 2a. **A parked run does not hold its folder.** *Easier.*

The brief states "A parked run holds its folder and its worktree slot until the
window resets." `occupantOf`'s default status set is `["running", "queued"]`
(`orchestrator.ts:3097`), and its docblock says the omission is deliberate:
"a parked run yields its folder, so naming it as the thing a new run is waiting
for would describe a wait that does not happen" (`:3089`–`:3091`).
`FOLDER_TAKEN_REASON` (`:9294`) exists because another run really does take it
while this one waits.

### 2b. **A parked run does not hold a concurrency slot.** *Easier.*

`selectPromotable` computes occupancy from `status === "running"` alone
(`:3827`–`:3832`) and compares it against `maxConcurrentRuns` (`:3869`).
A `paused` run is skipped by the `queued` filter at `:3835`. **Parking frees a
slot rather than holding one.**

### 2c. What it *does* hold is one of 64 checkout slots. *Neither.*

`MAX_WORKTREE_SLOTS = 64` (`:3120`), and `SlotCensus.heldByRuns` is documented as
"Held by a run that is queued, running **or paused**" (`:3138`–`:3139`). The
docblock at `:3112`–`:3118` says the headroom over `maxConcurrentRuns` is
deliberate and that what consumes it is dirty retired slots rather than live
runs — so a parked run is a small consumer of a large budget.

The brief was directionally right that *something* is held. It named the wrong
two things, and the thing actually held is 16× the default concurrency cap.

### 2d. The brief's line numbers had moved. *Neither.*

`isUsageLimit` at `:1438` and `refusalKind` at `:1540` are exact.
`refusalDisposition` was given as `:1795` and is at `:1795`. All three verified,
listed here only because the brief invited the check.

### 2e. An earlier draft of this proposal said `PRICES` had 21 keys. *Neither.*

It has 20. Counted rather than eyeballed, and the count is in §1c.

### 2f. The appended system prompt is **not** absent as an argv. *Harder.*

[`02-the-handover-contract.md`](02-the-handover-contract.md)'s "In" table records
`--append-system-prompt` against "**no flag** — `-c` overrides, `AGENTS.md`" and
files it **absent as an argv**. It is not.
`-c developer_instructions="<text>"` puts the text at the **front of the first
developer message**, ahead of Codex's own skills, permissions and
collaboration-mode blocks, and `-c` is one of the five flags `codex exec resume`
and `codex exec fork` still accept. Measured in §1f; reasoned in
`01-constraints.md` Part 2, U6.

Harder, because it removes the cleanest safety objection to every option that
spawns Codex: `SELF_HOSTING_NOTICE` and `COMMIT_IDENTITY_NOTICE` **can** ride a
Codex cycle. What is still absent is the other half of that pair — the
unconditional `--disallowedTools Bash(pkill:*) Bash(killall:*)`, which is a
denial rather than a notice, and nothing found on the binary does it per
invocation.

### 2g. A Codex cycle does not have zero of the three cost sources. *Harder.*

`README.md` §"The finding that shapes everything" says a Codex cycle has "zero
of the three". It has one. Codex ships an OTel exporter —
`otel.exporter` ∈ `{none, statsig, otlp-http, otlp-grpc}`, probed in §1f — and
its metric names include **`codex.turn.cost_microusd`** beside
`codex.turn.token_usage`. OTLP is one of this app's three sources
(`src/lib/otlp.ts`), so the figure would arrive over a transport that already
exists.

`02-the-handover-contract.md`'s narrower sentence — "There is no cost field
anywhere in the union" — is still exactly right, and re-verified at
`rust-v0.153.4`. The union is not Codex.

**This does not touch C1.** C1 forbids *summing*, not sourcing: a Codex figure
would still be a fourth population over a fourth time base and may never be
added into `runs.spent_usd`, a meter, or a window fraction. And three things
about the figure are unverified — whether it is populated on a subscription
account at all, whether `estimatedUsageUsdMicros` means dollars or plan credits
(the schema carries both, and the credits field is the required one), and
whether standing up a second OTLP path is proportionate. Recorded as U10 in
`01-constraints.md` Part 2, still open.

---

## 3. Not verified

Each of these is used somewhere in this proposal and is flagged where it is used.

### 3a. What a running Codex process does, where it needs a credential

The first pass settled none of the ten unknowns — no binary, no account, no
`codex exec` run. The second pass installed `codex-cli 0.153.4` and settled
what does not need a credential. **Five are still open or half-open, and every
one of them is open for the same reason: there is no OpenAI credential on this
machine.**

| | question | status | still needed |
|---|---|---|---|
| **U1** | what Codex emits at its own wall | **open** | an account at a wall |
| **U2** | per-turn or cumulative `usage` | **half** — the docblocks say per-turn | a turn that completes, to count `turn.completed` per invocation |
| **U3** | what `resume` restores | **half** — `resume` will not *accept* `-s`, `-C`, `-p` | two live turns, to see whether the session restores what argv cannot |
| **U4** | a dollar or token ceiling | **answered: no** on `codex exec` | — (the `tokenBudget` one protocol down is schema-read, not exercised) |
| **U5** | what `workspace-write` permits, and whether it holds | **half** — the resolved profile is measured | the real image; `codex sandbox` hangs in *this* agent's own sandbox |
| **U6** | an `--append-system-prompt` equivalent | **answered: yes** | — (the managed `/etc/codex` carrier is schema-read only) |
| **U7** | per-invocation MCP | **deferred** | nothing in scope depends on it |
| **U8** | argv prompt size | **answered** — ~128 KiB | — |
| **U9** | `--json` stability | **answered** for 0.152.1 → 0.153.4 | a second bump, each time |
| **U10** | what a cycle costs | **open on the number** | an account, and an OTLP collector |

**U1 still blocks every building option**, unchanged: `04-option-b`'s premise is
that a Claude wall is survivable by switching, and nothing here says what
happens at the OpenAI one. Used in `04-option-b`, `12-comparison.md` §2.

Three second-pass findings are used elsewhere and are **schema-read rather than
exercised**, which is a weaker standing than §1f's measured rows and is flagged
here rather than there:

- `CodexErrorInfo`'s member list and `ErrorNotification.willRetry` (U1) come
  from `codex app-server generate-json-schema`. **No app-server session was
  run**, and nothing proves those codes are populated in practice.
- `ThreadGoalSetParams.tokenBudget` (U4) is from the same dump and was never
  set.
- `ConfigRequirements.additionalDeveloperInstructions` (U6) is from the same
  dump; `/etc` is not writable from this sandbox, so the managed
  standing-instruction carrier was never proved to land.

The probe for each unknown, and what its answer changes, is in
`01-constraints.md` Part 2 beside the question.

### 3b. Every frequency about walls

`runs` has zero rows here and `/data` is unreadable, so **no claim in this
proposal about how often, how long, or how consequentially runs park is
measured.** Used in `03-option-a` §"What would have to be true",
`12-comparison.md` §4, and `13-recommendation.md` §"What would overturn this".

Four statements would settle it on a live install:

```sql
-- 1. How often a run has parked at all, and how deep the parks go.
SELECT pause_count, COUNT(*) FROM runs GROUP BY pause_count ORDER BY pause_count;

-- 2. How many runs ended out of waits rather than out of allowance.
SELECT COUNT(*) FROM runs
 WHERE status = 'failed' AND stop_reason LIKE '%already waited out%';

-- 3. How long parks actually last: the gap between parking and the next start.
SELECT id, paused_at, resume_at, (resume_at - paused_at)/60000.0 AS minutes
  FROM runs WHERE paused_at IS NOT NULL ORDER BY paused_at DESC LIMIT 200;

-- 4. Runs that died on wall clock — the one case where parking loses work
--    rather than delaying it. Cross-check against pause_count > 0.
SELECT pause_count, COUNT(*) FROM runs
 WHERE stop_reason LIKE '%time limit%' GROUP BY pause_count;
```

Statement 4 is the one that could overturn the recommendation on its own
(`13-recommendation.md` §"What would overturn this", item 2), and it has a
cheaper fix than a second provider.

Checkout-slot pressure needs a fifth reading that is not SQL: whether
`slotExhaustionRefusal` has ever fired. `ops_events` has one row here.

### 3c. Whether the `--yolo` argument is sound

`10-permission-and-credentials.md` notes that
`--dangerously-bypass-approvals-and-sandbox`'s own help endorses bypassing "in
environments that are externally sandboxed", and that this container arguably is
one. **That is an argument, not a finding.** Whether the uid drop, the mounts
and the process group are sufficient without the domain allowlist is a question
for `docs/agent/security.md`'s owner, and this survey did not answer it.

### 3d. Whether workflows are used on any real install

`07-option-e` depends on it. `workflows` and `workflow_instances` have 0 rows
here, which is a property of a scratch database rather than evidence about
production. `SELECT COUNT(*) FROM workflows` on a live install is the check.

### 3e. Whether `run_templates` are numerous enough for a per-template flag to be reviewable

`06-option-d` depends on it. `run_templates` has 0 rows here.

### 3f. The Codex reading was of `main`; it has since been anchored, once

The first pass fetched everything in §1e from the default branch. The second
re-fetched `exec_events.rs` and `codex-rs/exec/src/cli.rs` at both
`rust-v0.152.1` and `rust-v0.153.4` and found them byte-identical, so the
reading now stands at the installed build rather than at a moving branch.

**That is one bump, not a stability guarantee.** The `--json` flag still carries
the `experimental-json` alias, `Dockerfile:373`–`:377`'s argument for pinning an
agent CLI is unweakened, and the check is two `curl`s and a `diff` — cheap
enough to be a condition of every version bump rather than a one-off. **U9** is
the reason to.

---

## 4. Owed repairs

One, and it is not conditional on anything in this survey.

**`childEnv` (`src/lib/orchestrator.ts:5369`) and `authEnv`
(`src/lib/claudeAuth.ts:258`) do not strip `OPENAI_API_KEY` or `CODEX_API_KEY`.**
Either variable set on the server today reaches all five `CLAUDE_BIN` children,
inside sessions that have `Bash`. The two functions are deliberate copies of one
another (`claudeAuth.ts:254`–`:256`), so both move together.

Argued in `10-permission-and-credentials.md` §"The repair that is owed either
way"; recommended in `13-recommendation.md`. Read `docs/agent/security.md`
first — this is a change to what a child process can read.

---

## 5. What this proposal did not do

- **Changed nothing outside `proposals/ProviderFallback/`.** No `src/`, no
  `Dockerfile`, no `docker-compose.yml`, no `.env.example`, no dependency.
- **Did not add a row to `proposals/README.md`.** The brief fixed the change
  scope at this directory; the table there is one line short and whoever lands
  this should add it. (While there: that table's ModelRouter row links a
  directory that no longer exists — `ls proposals/` shows no `ModelRouter`. Not
  this survey's to fix, and cited in `05-option-c` on the strength of the README
  row rather than of the files.)
- **Ran no browser and started no container.** Nothing here is a judgement about
  how anything looks.
- **Ran `codex` — on the second pass, and only where no credential was needed.**
  `--help` on every relevant subcommand, `debug prompt-input`, `debug models`,
  `app-server generate-json-schema`, `exec --strict-config`, `login`/`logout`
  against a throwaway `CODEX_HOME` outside the repository, and one
  `codex exec --json` that failed at auth. **No model turn completed, so no
  token was spent and nothing was billed.** The throwaway `CODEX_HOME` was
  logged out and holds no credential.
