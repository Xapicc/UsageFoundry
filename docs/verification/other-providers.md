# Verification: Other providers

[← Verification index](../verification.md)

## Verified

- **The Codex sign-in panel, end to end, 2026-09-05**, `codex-cli 0.153.4`,
  scratch `CODEX_HOME`, routes and Playwright: `login status` exits 1 both
  signed out and on a bad credential file; a device flow deletes the stored
  credential on start; `--with-api-key` exits 0 on empty stdin. The key
  reached no log, only `$CODEX_HOME/auth.json` (0600).

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

## Not yet verified by hand

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

- **No Codex device sign-in has been completed** (no OpenAI account): the
  exit-0 `auth.json` write, `loginError` on any failure and the poll
  converging are unmeasured; an unnoticed success reads `waiting for approval`.
  `CODEX_HOME` (unmounted `~/.codex` by default) lives in the container's
  writable layer, lost on a rebuild.

- **The image has not been rebuilt with Codex (2026-09-05)**: the amd64
  figures (~335 MB unpacked, 123 MB download) are registry metadata, no work
  cycle has run `codex`, signed-out is reasoned from `childEnv`'s strip, and
  `codex` under `UF_SANDBOX=1`, whose read-only binds may break `$HOME/.codex`,
  is untried.

- **No Codex work cycle has ever been spawned (2026-09-05)**; `codex login
  status` says "Not logged in". Unverified: argv acceptance, event names,
  `resume` taking the session id, `--output-last-message`, sandbox binding,
  notices as prompt text, a Codex wall, and above all a real cycle loading the
  rules file (a wrong dialect loads as zero rules): ask one to `pkill -f`.
