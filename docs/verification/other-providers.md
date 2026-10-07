# Verification: Other providers

[← Verification index](../verification.md)

## Verified

- **The Codex sign-in panel, end to end, 2026-09-05**, `codex-cli 0.153.4`,
  scratch `CODEX_HOME`, routes and Playwright: `login status` exits 1 both
  signed out and on a bad credential file; a device flow deletes the stored
  credential on start; `--with-api-key` exits 0 on empty stdin. The key
  reached no log, only `$CODEX_HOME/auth.json` (0600).

- **A Codex device start deletes `auth.json` before it prints its code,
  2026-10-06**, `codex-cli 0.153.4`, scratch `CODEX_HOME` holding a fake key
  stored by `--with-api-key`, the file polled every millisecond: gone 16–20 ms
  after spawn, link and code in one stdout chunk at 275–350 ms. SIGKILL at 1 ms
  left `Logged in using an API key`; at 120 ms and on the first stdout chunk,
  `Not logged in` and no file. With the code request refused (proxy on a closed
  port) it deleted the file and exited 1 at 22 ms. The gap is one round trip to
  `auth.openai.com` from this sandbox, and will be longer on a slow link.

- **`runs.provider` and its admission refusals, 2026-09-05**, `npm start`:
  `provider TEXT`, nullable, cid 47, with `createRun`'s `INSERT` run for
  `'codex'` and `null`; four refused `POST /api/runs` each got their own 400
  sentence; both run-page labels rendered for seeded rows.

- **Codex device sign-in was driven against the real CLI up to approval.**
  `Logged in using ChatGPT` was read from a hand-written `auth.json` (unsigned
  JWT), not a real credential; the Settings row's poll arms and stands down
  around a cancelled flow, never a successful one.

- **The Codex CLI installs and runs on this image's base, measured on arm64
  only, 2026-09-05.** In `node:22-bookworm-slim`, `npm install -g
  @openai/codex@0.153.4` then `codex --version` prints `codex-cli 0.153.4`;
  279 MiB on disk. The binary arrives via `optionalDependencies` gated on
  `os`/`cpu`, so the Dockerfile block ends in a version check.

- **The Codex adapter's argv and spend handling, 2026-09-05.** Every flag it
  emits is in `codex-cli 0.153.4`'s `codex exec --help`; `codex execpolicy
  check` forbids `pkill node` under the app's `prefix_rule` spelling
  (`rule(...)` and `define_program(...)` do not parse); a seeded Codex run
  renders `148.2k` tokens against a dash, not `$0.00`, in the built app.

- **`CODEX_ACCESS_TOKEN` outranks a stored Codex credential, 2026-09-26**,
  `codex-cli 0.153.4`, scratch `CODEX_HOME` holding a key stored by
  `--with-api-key`: `login status` says `Logged in using an API key` (exit 0)
  without it and `Error checking login status: invalid agent identity JWT
  format` (exit 1) with it set to a non-JWT; blank is ignored. `OPENAI_API_KEY`
  and `CODEX_API_KEY` each left an empty home at `Not logged in`. No valid token
  was tried (no OpenAI account), so what a parsing one reports is unmeasured.

- **The pinned CLI names every variable a local cycle sets, and ranks the
  bearer token above the OAuth login, 2026-09-27**, `2.1.280`, read out of the
  binary in the running container: all six model-role variables,
  `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and
  `ANTHROPIC_CUSTOM_HEADERS` are present, and the CLI's own diagnostic reads
  "ANTHROPIC_AUTH_TOKEN is set, so this session is using API-key auth". Read,
  not exercised: no local cycle has run.

- **Winnow reaches agents through `ANTHROPIC_BASE_URL` alone, 2026-09-27**, on
  the live container: the Next server's environment carries
  `ANTHROPIC_BASE_URL=http://127.0.0.1:8789` and no `HTTP(S)_PROXY`, so a local
  cycle's override takes it out of the filter's path entirely. `HOME` is
  `/home/node`, so `LOCAL_CLAUDE_CONFIG_DIR` resolves to
  `/home/node/.claude-local`.

- **The CLI runs headless on a local cycle's environment and sends nothing it
  should not, 2026-09-27**, host `claude` 2.1.283 driven with `localCycleEnv`'s
  output (a fake `ANTHROPIC_API_KEY` and a winnow-style base URL in the input)
  against a stub Messages server that logged every request: exit 0, `DONE`, in
  a fresh `CLAUDE_CONFIG_DIR` with no prompt. The stub saw a `HEAD /api/hello`
  and a streamed `POST /v1/messages?beta=true` carrying `Bearer
  local-token-123`, model `qwen-local` and no `x-api-key`; no
  `count_tokens` call was made. The transcript went to the local config
  directory and nothing to `~/.claude/projects`, and a second call with
  `--resume` continued the session. The CLI reported `total_cost_usd` 0.000075
  for a model it has no price for — the figure `providerReportsSpend` refuses.

- **Winnow's `ENABLE_TOOL_SEARCH=1` broke the first real local run, and
  `false` fixes it, 2026-09-28.** A local run against LM Studio serving
  `qwen/qwen3.6-35b-a3b` failed on its first tool call with `400
  request.messages.3.content.0.content.0.type: Invalid literal value, expected
  "text"`; its transcript in `.claude-local` shows the model's `ToolSearch`
  call answered by a `tool_result` holding a `tool_reference` block, which the
  entrypoint's export had switched on for winnow. Reproduced against a stub
  with host `claude` 2.1.283 — the request offered `ToolSearch` and deferred a
  tool — and with `localCycleEnv` setting `false` the same request offered 20
  tools, none of them `ToolSearch`, and deferred none. Not yet re-run against
  LM Studio. A session that already holds a `tool_reference` fails again on
  `--resume`, so a run that hit this has to be started afresh.

- **Local runs were working without the operator's rules, and a symlink
  restores them, 2026-09-28.** The transcript of 45e27aad — the local run a
  frontier review rejected — carries one `instructions` attachment holding the
  repository's `CLAUDE.md` alone; the five files in `~/.claude/rules/` a
  Claude run loads were absent, because `.claude-local` had none. With
  `ensureLocalConfigDir` linking `rules/` and `CLAUDE.md`, host `claude`
  2.1.283 sent marker text from both into the request to a stub server. Not
  yet re-run in the container or against LM Studio; whether the rules change
  the next review's verdict is the open question.

- **What a local cycle's idle timeout has to set, read out of the pinned
  2.1.280 binary, 2026-09-28.** `CLAUDE_STREAM_IDLE_TIMEOUT_MS` is floored at
  300 000 ms and clamped at 1 800 000; set, it replaces the byte-stream idle
  watchdog's 180 000 first-party default (the host's cached
  `tengu_byte_stream_idle_timeout_ms` says the same) and is the default
  first-byte wait. That wait is capped at `API_TIMEOUT_MS` − 1 000, and
  `API_TIMEOUT_MS` (default 600 000) is also the SDK's request timeout, so
  `localCycleEnv` sets both to 900 000. Read, not run: no local cycle has been
  seen waiting past three minutes.

- **Splash's limits, against the live server, 2026-09-28.** `GET /v1/models`
  reports `context_length` and `max_model_len` 131072 for
  `incoai/qwen3.8-27b-splash`. It does not reserve `max_tokens`: a 19-token
  prompt asking for 131,072 and for 200,000 was answered 200. A 187,516-token
  prompt got `400 invalid_request_error` "prompt is too long: 187516 tokens >
  131071 maximum input tokens" in 0.3 s, Anthropic's own wording. A
  128,164-token prompt asked for more than fits streamed 2,908 tokens, exactly
  to 131,072, and ended `stop_reason: max_tokens` with a clean `message_stop`,
  in 279 s. One model and one server; another server may refuse where this one
  clips.

- **The pinned CLI takes the sign-in's window, 2026-09-28.** `claude -p
  "/context"` in the container against Splash, scratch config directory: without
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS` it printed the unknown-model notice and
  `13.7k / 200k`; with 131072 it printed `13.7k / 131.1k` and a 33k autocompact
  buffer, so compaction near 98,000. Before it, local session 22d3bae3 reached
  127,833 input tokens without compacting.

- **The first Codex work cycle ran through this app, 2026-10-07**,
  `codex-cli 0.153.4`, ChatGPT sign-in, run 08f0702d (`gpt-5.6-luna`,
  `acceptEdits`, two cycles, `UF_SANDBOX=1`). The CLI accepted the whole argv;
  `thread.started` set `session_id` and cycle two ran `exec resume` on it (one
  rollout file, two `task_started`); no stream event reached
  `noteUnknownStreamEvent`; exit 0. `spent_tokens` 130,963 is exactly cycle one
  (97,713 + 1,429) plus cycle two (31,529 + 292), so `turn.completed` usage is
  per invocation and assigning it is right. Spend read as unknown, not `$0`.

- **The rules file loads in a real cycle, 2026-10-07**, same run: the model's
  `pkill -f uf-nonexistent-marker-9z` came back `rejected: policy forbids
  commands starting with \`pkill\``. The `$(echo pkill)` bypass the rules
  module names was not tried.

- **Codex's sandbox makes three mount points in every write root, and one it
  cannot make fails every command, 2026-10-07**, `codex-cli 0.153.4`, uid 1000.
  The run's session file lists read-only `<root>/.git`, `.agents` and `.codex`
  entries (`missing_path_behavior: "skip"`) for each root, and bwrap still
  `mkdir`s them: with `/var/lib/uf-stacks/state` (root 0755) a root, every
  command of that run, `apply_patch` included, failed `bwrap: Can't mkdir
  /var/lib/uf-stacks/state/.git: Permission denied`. Replayed through `codex
  sandbox --sandbox-state-json` with the recorded profile: the old root set
  fails the same way; `codexWritableRoots`' set (checkout, `~/.npm`, `~/go`,
  `~/.cache`, the four stack directories) writes the checkout, the npm cache,
  a stack's state and `/tmp`, reads the vault, and is refused writing the vault
  and `~/.claude`. A worktree with its repository's `.git` as a root committed.

- **The mount points outlive a SIGKILL and nothing gentler, 2026-10-07**, same
  CLI, `codex sandbox -P :workspace -- sleep 30` in a fresh directory: all three
  present while it ran, gone after SIGTERM to its group, left behind empty after
  SIGKILL. `:workspace` makes `/tmp` a root too, so a killed cycle can leave
  them in `/tmp` whatever `--add-dir` says.

- **The vault is readable to a Codex cycle without `--add-dir`, 2026-10-07**:
  `ls /workspace2` succeeds under `codex sandbox -P :workspace`, and `touch` in
  it is refused `Read-only file system`.

- **A Codex work cycle writes, and an isolated one commits, with the fixed
  write set, 2026-10-07**, `codex-cli 0.153.4`, `gpt-5.6-luna`, ChatGPT team
  sign-in, through the deployed app (`2507404a`), scratch repository under
  `/workspace`: a non-isolated `acceptEdits` run wrote `hello.txt` (`hi`) and
  completed in one cycle, 26,835 tokens, spend reported unknown; an isolated
  run committed `codex isolated test` on its own `uf/…` branch in one cycle.
  Neither repository gained a `.claude/` directory, neither log carried a prune
  attempt, a `Permission denied` or an unknown stream event, and both cycles
  wrote `$CODEX_HOME/last-message/<run>.txt` owned by uid 1000.

- **A Codex sign-in survives a rebuild on the `usagefoundry-codex` volume,
  2026-10-07**: after a ChatGPT sign-in on the volume's first boot, a second
  `docker compose up -d --build` recreated the container (`cda29edf`) and
  `codex login status` as uid 1000 still answered `Logged in using ChatGPT`.

- **A Codex cycle refuses every MCP call under `approval_policy = "never"`
  unless the server's tools are pre-approved, 2026-10-07**, `codex-cli
  0.153.4`, `gpt-5.6-luna`: with this app's server named by `url` and
  `bearer_token_env_var` the cycle listed all eight `mcp__uf__*` tools and
  every call failed "MCP tool call requires approval, but approval policy is
  never" — `list_my_tasks` on the first cycle, `create_task` on the resumed
  second.

- **`shell_environment_policy.exclude` does not reliably keep a variable out of
  a Codex cycle's shell, 2026-10-07**, same pin: through `app-server`'s
  `command/exec` the exclusion held (0 against 1 for an unexcluded variable),
  and 0.153.4 has no default exclusion of `*TOKEN*`; through `codex exec` it held
  once and failed three times, `printenv` printing the excluded value, with and
  without MCP overrides beside it. Why it differs between the two paths is not
  known.

- **Codex reads MCP request headers from `http_headers_helper`, 2026-10-07**,
  same pin, against a local listener: a helper string `/bin/cat <file>`,
  arguments included, sent the file's JSON object as the request's headers —
  `Authorization` exactly as written — and a helper not found failed with exit
  127 before any request.

- **A Codex run reaches the taskboard, 2026-10-07**, the deployed app with
  `taskboardForRuns` on, a two-cycle `gpt-5.6-luna` run in a scratch repository
  with a seeded open task: `list_my_tasks` returned the seeded task on the
  first cycle, `create_task` filed a task with `origin` `run` and the run as
  `created_by_run_id` on the resumed second, and the run completed on DONE.
  `env | grep -c USAGEFOUNDRY_MCP_TOKEN` in the cycle's shell was 0 and
  `/run/uf-mcp` was empty after it. The test tasks were deleted afterwards.

- **A Codex cycle's commands are offline under `acceptEdits` unless the
  network is opened, 2026-10-07**, `codex-cli 0.153.4`, `gpt-5.6-luna`: `curl
  https://example.com` in a `workspace-write` cycle failed (`000`), and with
  `-c sandbox_workspace_write.network_access=true` answered 200. Through the
  deployed app (`409f1ba7`) with "Network for Codex runs" switched on by `PUT
  /api/settings`, a one-cycle `acceptEdits` Codex run got 200 and completed.
  The switch was left on for this install.

## Not yet verified by hand

- **No local cycle has been seen compacting under a sign-in window
  (2026-09-28).** The threshold is read off `/context`, not off a compaction,
  and whether Splash answers the summary request at ~98,000 tokens is open. A
  local run long enough to pass it settles it: a `compacting` status and a
  `compact_boundary` in its log, then a next turn that is answered.

- **Why 682ea6fa's requests timed out at ~134 s is unknown (2026-09-28).**
  All nine attempts to LM Studio, with the server on, ended `Request timed
  out.` 134–136 s after dispatch with `noResponse` null, so not the first-byte
  watchdog, and none of the defaults above is that short. The fifteen-minute
  setting may not reach it. Settles with one local cycle against the running
  server and the spacing of its `api_retry` events: still ~134 s means the
  bound is somewhere `localCycleEnv` does not set.

- **No local-provider work cycle has run through this app or against a real
  server (2026-09-27).** The CLI half is measured (above) against a stub on
  the host's 2.1.283, not the image's 2.1.280, and not through `runIteration`.
  Open: whether LM Studio's endpoint accepts the `?beta=true` query and answers
  the `HEAD /api/hello` probe harmlessly, whether a real model's tool calls
  stream back in a shape the CLI accepts, and whether the sandbox
  (`UF_SANDBOX=1`) builds against a config directory that holds none of the
  placeholders `ensureSandboxMountPoints` writes. Settles with a sign-in to
  LM Studio and one two-cycle local run with the sandbox on and off.

- **The sign-in has not been driven from the page against a real server.** The
  probe is unit tested against stubs; the LAN address the operator named
  (`192.168.0.190:1234`) answered `EHOSTUNREACH` from the host on 2026-09-27, so
  nothing about reaching it from the container is known.

- **No frontier review has certified a real local branch.** Whether the review
  child follows the fourth heading closely enough for `parseCertificationVerdict`
  — which reads only a bare `APPROVE` or `REJECT` — is untested against a real
  reply; a reviewer that hedges leaves the branch unlandable, which fails
  closed. Settles with one review of a local run's branch and the Land card read
  before and after.

- **What the Settings panel showed while a device sign-in converged is
  unobserved.** A ChatGPT sign-in made from the deployed app on 2026-10-07
  left `login status` at `Logged in using ChatGPT`; the poll's own states on
  the way there, and `loginError` on a failure, were not watched.

- **The amd64 Codex figures are registry metadata (2026-09-05)**: ~335 MB
  unpacked and a 123 MB download, never pulled here; and signed-out is still
  reasoned from `childEnv`'s strip rather than read off a cycle.

- **What a Codex cycle does with the stacks' state and the in-band notices is
  open (2026-10-07).** The two runs above wrote, committed and ended on DONE
  in one cycle each, and touched no package cache; whether a cycle can use
  `~/.npm` and `~/go` under the fixed set, whether it obeys the self-hosting
  notice, and what a Codex wall looks like are unmeasured. Settles with one
  Codex run that installs a package and runs `npm --version`.
