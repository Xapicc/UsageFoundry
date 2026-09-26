# 01 — Constraints of this install

Part 1 is what holds, each with where it was read. Part 2 is what could not be
settled from here, each with the command that would settle it. Line numbers
are against `main` at `4a49627`.

## Part 1 — what holds

### C1. The operator's hardware is a parameter, not a fact

No host hardware is visible from the container, and the vault says the same of
its own research (*Local Inference MOC*, `confidence: medium`: "the operator's
machine is not visible from where this was written"). Every latency figure in
this directory is therefore a function of the memory tier and chip, taken from
the vault:

| Unified memory | What the vault would run | Usable by default |
|---|---|---:|
| 16 GB | an embedder and at most a 12B summariser (Gemma 4 12B) | 11.5 GB |
| 32 GB | Gemma 4 26B-A4B for summarising; Qwen3.6-27B "tight" for agent work | 22.9 GB |
| 64 GB | the same at Q8, or Qwen3-Coder-Next with a raised limit | 51.5 GB |
| 128 GB | gpt-oss-120b or Qwen3.5-122B-A10B | 103 GB |

From *Recommended Local and Claude Hybrid Setup* step 2 and *Local Model Memory
Budget* (both `confidence: medium`; "Arithmetic and published scores; untested
on hardware"). The best measured local agentic model, Qwen3.6-27B, fits 32 GB,
and "memory beyond 32 GB buys context, speed options and headroom, not
demonstrated agentic quality" (*Local Model Quality by Agent Task*).

### C2. The model server is on the host; the app is in a container

This container runs on OrbStack (`uname` reports `7.0.14-orbstack-…`), so a
Metal-accelerated server — `llama-server`, LM Studio, Ollama — runs on macOS,
outside it. Nothing in the repository wires the host in: `docker-compose.yml`
declares no `network_mode`, `networks:` or `extra_hosts:`, so the app sits on
the default bridge. The one recorded measurement of reaching the host is
`scripts/discord-relay.mjs:105`: "a container reaches a host's loopback listener
through `host.docker.internal` on Docker Desktop" (2026-08-24). On Docker Engine
for Linux that name needs `extra_hosts: host-gateway`, which this compose file
does not set; on OrbStack the name is provided by the runtime (**assumed**, from
OrbStack's documented behaviour, not checked here).

Probed from inside this run on 2026-09-26: `getent hosts host.docker.internal
host.orb.internal` returned nothing (exit 2), and `curl` to
`host.docker.internal:{8080,11434,1234}` returned `502 Bad Gateway` from this
run's sandbox proxy — **the same 502 it returned for `no-such-host.invalid`**. The
probe therefore cannot distinguish "unreachable" from "reachable, nothing
listening". Unsettled; U1 below.

What matters is *which process* makes the call:

- **The app server** (Next.js, root in the container) is not under any Claude
  Code sandbox. If it can resolve the host, it can reach it.
- **A run's `claude` child and anything its Bash starts** is under the install's
  sandbox policy when `UF_SANDBOX=1` (C3).

### C3. The run network policy is install-wide, off by default, and never exercised

`UF_SANDBOX` blank is "off and is the shipped state" (`docker-compose.yml:191`,
comment above). With `UF_SANDBOX=1` the entrypoint writes a root-owned
`/etc/claude-code/managed-settings.json` (`docker-entrypoint.sh:412`–`:491`), and a
`network` block with `allowManagedDomainsOnly: true` only when
`UF_SANDBOX_ALLOWED_DOMAINS` is non-blank (`:437`–`:439`). The entry validator
accepts `[A-Za-z0-9.*_-]` (`:392`–`:410`), so `host.docker.internal` passes it; whether
Claude Code's `allowedDomains` then honours it is untested (the Sandboxing
validation notes it "takes domains",
`proposals/implemented - Sandboxing/10-validation.md` line 250). There is no
per-run network policy: the per-run `--settings` overlay carries only
`filesystem.allowWrite` (`src/lib/orchestrator.ts:5680`–`:5687`). And the
repository's own verdict: "the egress allowlist has never been exercised"
(`docs/security.md:217`).

**Whether that sandbox wraps an MCP server the CLI starts is unmeasured.**
`docs/verification.md:4127`: "Q3 — is the sandbox around the session or only
around Bash? *(unmeasured — narrowed on one side: `Bash` is wrapped,
`Edit`/`Write` unknown)*"; `src/lib/orchestrator.ts:5520`: "so this asserts
neither". The Sandboxing survey's working position is that "the CLI process and
the non-shell file tools run outside the namespace" (**assumed**, in its
02x option file). A stdio MCP server is started by the CLI process,
not by Bash, so under that assumption it runs **outside** the sandbox.

### C4. Permission: what a run's session may do, and what it may not see

- Default mode `acceptEdits` (`src/lib/orchestrator.ts:9301`, `src/lib/settings.ts:1001`).
- `--allowedTools` carries only `Bash(git add:*)`, `Bash(git commit:*)`
  (`src/lib/cycleInvocation.ts:634`), stack grants and `Grep`/`Glob` (`:663`);
  there is **no `mcp__…` entry** (`:1244`–`:1249`).
- `--disallowedTools Bash(pkill:*) Bash(killall:*)` on every spawn
  (`:711`, `:1258`) — it binds the **Bash tool**, and "survives
  `bypassPermissions`" (`docs/agent/security.md:21`). It cannot see a process a
  tool call spawns by any other route.
- **`--strict-mcp-config` is deliberately absent for runs**
  (`src/lib/cycleInvocation.ts:1188`): the operator's own MCP servers in the
  mounted `~/.claude` join every work cycle. **The chat gets it**
  (`src/lib/chat.ts:2975`), so only the app's own server reaches a chat child.

The consequence for any tool that runs an agent: whatever that agent does
happens **inside one MCP tool call**. The calling session's permission mode
approves or refuses the call as a whole; it never sees the reads, writes or
commands inside it, and neither does the `pkill` denial.

### C5. Credentials a child can reach

`childEnv` strips `UF_*`, `OTEL_*`, `__NEXT_*`, `ANTHROPIC_ADMIN_KEY`,
`OPENAI_API_KEY`, `CODEX_API_KEY`, `CLAUDE_CODE_ENABLE_TELEMETRY`, `DATA_DIR` and
`NODE_OPTIONS` (`src/lib/orchestrator.ts:5857`–`:5875`) — ProviderFallback's
"one line" repair has since landed (`:5865`–`:5866`). It deliberately keeps
`ANTHROPIC_API_KEY` (`:5784`–`:5785`), and passes `GH_TOKEN`/`GITHUB_TOKEN` to runs
(`:6114`–`:6127`). `CODEX_ACCESS_TOKEN` is not stripped (filed as a task; see
the README). The subscription itself is the mounted
`~/.claude/.credentials.json`, which a work cycle can read by design
(`docs/agent/security.md:10`: "a work cycle can still read the account's own
OAuth credential — it has to").

The vault's trap for anything that spawns Claude Code against another server:
"with `ANTHROPIC_BASE_URL` alone 'a saved claude.ai login remains the active
credential' and its OAuth token travels to whatever the URL points at"
(*Pointing Claude Code at a Local Model*, `confidence: medium`, from Anthropic's
gateway documentation, `documentation`).

### C6. One server, one slot; up to four runs and two assists

The vault's server line is `llama-server -m <model>.gguf -c 65536 --jinja -np 1`,
`-np 1` "because the default four slots divide one KV pool" (*Recommended Local
and Claude Hybrid Setup*, step 3). One slot serves one request at a time.
Against it: `maxConcurrentRuns` 4 (`src/lib/settings.ts:1016`) and
`maxConcurrentAssists` 2 (`:1017`). Four slots instead of one would quarter the
context per request — 16K each at `-c 65536` (*Choosing a Local Inference
Runtime*: "4 slots sharing one KV pool") — which the delegated jobs measured
here cannot fit (median read-only peak 75,672 tokens, [`00-problem.md`](00-problem.md)
§1) and which even a minimal loop's six-read job, peaking near 16,200 tokens
([`scripts/latency.mjs`](scripts/latency.mjs)), would sit at the edge of.

### C7. Clocks that a slow tool call runs into

- **`maxDurationMinutes`** counts time worked, excluding parks
  (`src/lib/budget.ts:513`), and is enforced **between cycles** by default
  (`src/lib/settings.ts:976`); mid-cycle only under `enforcement: "live"`, on a
  60-second tick (`src/lib/orchestrator.ts:10545`). A session blocked on a tool
  call keeps accruing it.
- **The silence watchdog**, `maxCycleSilenceMinutes` 120 (`src/lib/settings.ts:1031`),
  applied at `src/lib/orchestrator.ts:9434`: time since the child's last output.
  A multi-minute tool call is well inside it.
- **Claude Code's own MCP timeouts**, read from the installed 2.1.280 binary's
  bundled source (minified, so the constant bindings are **inferred** from the
  code that reads them):
  - an **idle** timeout of **300,000 ms for an HTTP server** and 1,800,000 ms for
    stdio, reset by progress notifications, overridable per server with a
    `"timeout"` field or globally with `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`; the
    message on expiry is "sent no response or progress for …s; aborting";
  - a **hard** per-call limit: the per-server `"timeout"`, else
    `MCP_TOOL_TIMEOUT`, else a default bound to `1e8` ms — "progress
    notifications do not extend it";
  - **auto-backgrounding** of a long MCP call is **off in a non-interactive
    session** unless `CLAUDE_AUTO_BACKGROUND_TASKS` is set. A work cycle is
    spawned with `-p` (`src/lib/cycleInvocation.ts:1220`), so a slow MCP call
    blocks the session's turn.

  Neither `MCP_TOOL_TIMEOUT` nor `MCP_TIMEOUT` appears anywhere in `src/`,
  compose or the Dockerfile.

### C8. What the run log shows of a tool call

A `tool_use` becomes a `kind: "tool"` row with the tool's name and its input
clipped to 4,000 characters (`src/lib/orchestrator.ts:7948`). A **successful**
result is dropped by name — "these carry whole file reads and command output,
and the log already shows the call that produced them" (`:7980`–`:7983`); only a
failed one is kept (`:7475`). A live per-tool elapsed clock exists, fed by the
CLI's `tool_progress` heartbeats, held in memory and never persisted
(`const liveTools`, `:7631`); heartbeats were measured for Bash only. So **what
an MCP server does inside a call is invisible to the run log** unless the
server writes rows of its own through `emit()` (`:699`), which only an in-app
server can.

### C9. Cancellation reaches the process group, and not reliably a grandchild

A work cycle is spawned `detached` when `killProcessGroup` is on (default)
(`src/lib/orchestrator.ts:6437`); `interruptRun` sends `SIGINT` to the group
(`:10347`) and escalates to `SIGTERM`/`SIGKILL` only while the child is still
registered, so if `claude` exits promptly on `SIGINT` a grandchild receives
only that. The code says so of itself: "A killed agent that leaves a
grandchild behind would never close" (`:6569`). Whether Claude Code starts a
stdio MCP server in its own process group is not known here.

### C10. What the installed Codex CLI can do

`codex-cli 0.153.4` (`/usr/local/bin/codex`; pinned at `Dockerfile:580`),
checked without a model request under a scratch `CODEX_HOME`:

- **It can target a local server.** `--oss` and `--local-provider <lmstudio|ollama>`
  are on `codex --help` and `codex exec --help`; a custom provider
  `-c model_provider=local -c model_providers.local.base_url=…` is accepted.
  **Only the Responses API**: `wire_api=chat` is refused with "`wire_api =
  "chat"` is no longer supported". Whether `llama-server` serves
  `/v1/responses` was not established; the binary's own string names "ollama
  server (Responses API, default port 11434)".
- **A Codex session can call MCP servers**, set per invocation with
  `-c mcp_servers.<name>.command=…` or `.url=…`, and `-c` is still parsed under
  `--ignore-user-config` — the flag the app's Codex argv carries
  (`src/lib/cycleInvocation.ts:1521`). A scratch stdio server attached this way
  received `initialize`, `notifications/initialized` and `tools/list` from
  `codex-mcp-client` 0.153.4. That the tools then reach the model was not
  shown. Per-server `tool_timeout_sec` and `startup_timeout_sec` exist and
  pass `--strict-config`; their defaults were not established.
- **Codex runs get no MCP today**: `prepareRunTaskboard` returns `off` for the
  Codex provider (`src/lib/orchestrator.ts:8585`).

### C11. `ANTHROPIC_BASE_URL` is already taken when the intake filter is on

With `WINNOW_FILTER=1` the entrypoint points every agent's
`ANTHROPIC_BASE_URL` at winnow's loopback proxy (`docker-entrypoint.sh:1192`),
which rewrites each request and forwards it (`src/lib/intakeFilter.ts:16`–`:20`).
Any design that sets `ANTHROPIC_BASE_URL` for a child — a local-provider run, a
routing gateway — collides with it. It also means the install already relays
subscription traffic through a local proxy in that mode, which bears on the
vault's open terms question (*Is Relaying a Claude Subscription Through a Local
Gateway Permitted*, `status: seed`, `confidence: low`) without settling it.

### C12. How the app delivers an MCP server to a run today

Exactly one server, and only when `taskboardForRuns` is on (default `false`,
`src/lib/settings.ts:1025`; read per cycle at `src/lib/orchestrator.ts:8580`):

- per cycle, `prepareRunTaskboard(id, run.provider)` (`:9233`) mints a per-run
  capability token (`mintRunCapability`, `src/lib/chat.ts:2292`) and writes a
  config **file** (`writeMcpConfig`, `:4145`) — a file because "a string would
  put the capability token in the child's command line" (`:4106`);
- the file holds one server, `{ uf: { type: "http", url: MCP_SELF_URL, headers:
  { Authorization: "Bearer …" } } }` (`:4168`), and `MCP_SELF_URL` is this app's
  own `/api/mcp` on loopback (`src/lib/config.ts:154`) — the tools "have to run
  *in this process*" (`:147`);
- `--mcp-config <file>` goes on the argv (`src/lib/cycleInvocation.ts:1291`), the
  file is removed in the cycle's `finally` (`src/lib/orchestrator.ts:9461`) and the
  token is revoked in `startRun`'s (`:10166`);
- the route answers only the run tools for a run subject (`RUN_TOOLS`,
  `src/app/api/mcp/route.ts:498`; POST at `:1714`).

CustomStacks, the decided vehicle for installing tools, **cannot carry an MCP
server**: a stack is binaries on `PATH`, environment and cache directories,
with no MCP field and nothing linking it to `--mcp-config`, and as shipped it is
install-wide (`src/lib/stacks.ts:321` grants only `Bash(...)` entries; per-repository
selection is designed in `proposals/CustomStacks/23-revision-per-repo-and-login.md`,
which supersedes `proposals/CustomStacks/14-stack-object-model.md` §7 on that point, and is not built —
it adds no MCP field either). A stack also may not set `OPENAI_*` (`proposals/CustomStacks/01b-stack-format.md`
§2.2), which blocks the usual `OPENAI_BASE_URL` wiring.

## Part 2 — unknowns, and what settles each

| | Unknown | Would change | Settles it |
|---|---|---|---|
| U1 | Can the app container reach a server on the Mac host, and at which name? | Whether any in-app option works at all | On the host: `docker compose exec <service> sh -c 'getent hosts host.docker.internal; curl -s http://host.docker.internal:8080/v1/models'` with `llama-server --host 0.0.0.0` running |
| U2 | Does the CLI sandbox wrap a stdio MCP server? | Whether a stdio local agent is contained | `docs/verification.md` Q3's experiment, with a stdio server that writes outside the run's write set |
| U3 | Does `acceptEdits` under `-p` permit an `mcp__…` tool with no `--allowedTools` entry? | Whether a run can call the tool at all without an argv change | One cycle with a trivial HTTP MCP server and `taskboardForRuns` off; read the `tool_error` rows |
| U4 | Does Claude Code send `tool_progress` for an MCP call? | Whether the run page shows a live clock for it | Same cycle, a tool that sleeps 90 s; grep the stream for `tool_progress` |
| U5 | Prefill and decode on the operator's own machine | Every latency figure here | `llama-bench -p 2048,16384 -n 256` with the chosen model, or time one 16k-token request with `curl` |
| U6 | How often runs actually hit the window wall | Whether headroom is worth anything | ProviderFallback's frequency SQL (`proposals/ProviderFallback/14-validation.md`, the four statements at its end), run against `/data`, which no work cycle may read |
| U7 | Does `llama-server` serve `/v1/responses`? | Whether Codex can use it without Ollama or LM Studio | `curl -s localhost:8080/v1/responses -d '{"model":"x","input":"hi"}'` on the host |
| U8 | Does `CLAUDE_CODE_SUBAGENT_MODEL` move `general-purpose` in 2.1.280? | Option A's size | One cycle with it set; read `message.model` in `subagents/*.jsonl` |
