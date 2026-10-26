# Verification: Security and sandboxing: who can read a work cycle's telemetry ingest token

[← Verification index](../verification.md)

## Verified

- **`otelHeadersHelper` authenticates the exporter with no header in the
  environment, on 2.1.310, 2026-10-25.** Board task `df961289`. The real CLI ran
  `-p` against a loopback stub serving both `/v1/messages` and `/v1/logs`, with
  `OTEL_EXPORTER_OTLP_ENDPOINT` set, no `OTEL_EXPORTER_OTLP_HEADERS`, and user
  settings naming a helper script that printed
  `{"Authorization":"Bearer <token>"}` from a file. The stub received two
  `/v1/logs` POSTs carrying that header. The helper ran in the CLI's own user
  and mount namespace, not in its sandbox. Read off the same bundle, not run:
  the output is cached in the CLI's memory for
  `CLAUDE_CODE_OTEL_HEADERS_HELPER_DEBOUNCE_MS` (default 1,740,000 ms), a
  helper from project or local settings needs workspace trust, and a helper in
  the managed policy drops OTLP endpoint variables from every other source.

- **That token is in the CLI's memory, and an unsandboxed descendant reads it
  there on this host, 2026-10-25.** Same run, from a `Stop` hook: the hook's
  environment held no `OTEL_*` variable at all, the CLI's
  `/proc/<pid>/environ` did not hold the token, and reading
  `/proc/<pid>/mem` over its readable mappings found it 5 times.
  `kernel.yama.ptrace_scope` is 0 on this OrbStack host; a host at 1 would
  refuse a descendant reading its ancestor's memory. Caveat: the hook ran in
  the same namespace as the CLI, which is what an unsandboxed child is.

- **A command inside the CLI's sandbox cannot open its CLI's `/proc` entries,
  2026-10-25.** Measured from a Bash command of this session, which the CLI
  runs under the same sandbox runtime (`bwrap` then `apply-seccomp`). Opening
  `maps`, `mem` and `environ` succeeded for the processes inside the sandbox
  and returned `EACCES` for every ancestor outside it, including
  `/usr/local/bin/claude` itself, all at uid 1000. Caveat: this session's
  sandbox settings are the harness's, not the app's managed policy, though
  both bind the container's `/proc`.

- **The Read tool returns neither `/proc/self/environ` nor a denied file, even
  through a symlink, on 2.1.310, 2026-10-25.** The same stub drove one `Read`
  call per run. `/proc/self/environ` was refused as "a device or process file
  that this tool does not read" under `acceptEdits` and `bypassPermissions`,
  and so was a workspace symlink to it under `bypassPermissions`
  (`acceptEdits` refused it as outside the working directories). A token
  file outside the workspace was refused under `acceptEdits` and returned
  under `bypassPermissions`; a `permissions.deny` rule `Read(//<path>)`
  refused it under `bypassPermissions`, directly and through a symlink.

- **A `--settings` `env` outranks the same key in a project, local or user
  settings file, on 2.1.310, 2026-10-25.** Board task `a0c412bf`. The real
  CLI ran `-p` under `env -i` with a scratch `HOME` and config dir, a fake
  `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` naming loopback stub A. With
  `env.ANTHROPIC_BASE_URL` naming stub B in the cwd's
  `.claude/settings.json`, its `settings.local.json`, or
  `$CLAUDE_CONFIG_DIR/settings.json`, the one `/v1/messages` went to B with the
  key. Adding `--settings '{"env":{"ANTHROPIC_BASE_URL":"<A or C>"}}'` sent it
  to A or C every time. Caveat: one request per run, under this container's
  managed policy.

- **What a project file's `env` can do with a cycle's credential, on 2.1.310,
  2026-10-25.** Same rig; stubs logged only header names. Moved it: the base
  URL, also with a scratch `.credentials.json` login (B got `Authorization:
  Bearer`); `HTTP_PROXY`, `http_proxy` or `ALL_PROXY`, which received the
  `http://` request whole, key in it; `HTTPS_PROXY` plus
  `NODE_TLS_REJECT_UNAUTHORIZED=0`, or plus `NODE_EXTRA_CA_CERTS` naming a CA
  in the repository, through which an intercepting stub decrypted the default
  `api.anthropic.com` request and read the key; `CLAUDE_CODE_USE_VERTEX` with a
  Vertex URL (key sent there). Bedrock and Foundry with their auth skipped
  sent requests to B without the key. Not honoured: `OTEL_*` (the exporter kept
  the environment's endpoint and token), `SSL_CERT_FILE`,
  `CLAUDE_CODE_API_BASE_URL`, `ANTHROPIC_UNIX_SOCKET`. A project
  `ANTHROPIC_API_KEY` replaced the key, and `ANTHROPIC_AUTH_TOKEN` added a
  bearer, both to the pinned host.

- **`""` in the overlay reads as unset, on 2.1.310, 2026-10-25.** With no base
  URL in the environment and a project URL naming B, an overlay
  `ANTHROPIC_BASE_URL: ""` sent nothing to B. Every connection was a
  `CONNECT api.anthropic.com:443` through an environment proxy. `""` for each
  proxy variable sent requests direct, and `""` for the two TLS variables made
  the intercepting stub's handshake fail. `""` for the provider switches sent
  requests to A. A control run with every pin `""` completed. Node, Python,
  curl and git ran normally with those variables `""`.

- **The run loop pins them, measured through `createRun` with the real CLI,
  2026-10-25.** `cycleEnvPins` puts the variables in `PINNED_CYCLE_ENV` into
  every Claude cycle's one `--settings`, at the cycle's spawned values. A
  scratch `DATA_DIR`, `CLAUDE_BIN` wrapping 2.1.310, server
  `ANTHROPIC_BASE_URL` naming A, and a project file naming B plus
  `HTTP_PROXY`/`http_proxy`/`ALL_PROXY` naming P. Built from `5ba27e95`, the
  cycle's `/v1/messages` reached P addressed to B, carrying `x-api-key`. With
  the change, it reached A, and B and P got nothing. Both runs completed.
  Caveat: not as root with a uid drop, and not through winnow.

- **The reviewer and the chat turn pin them too, measured through their own
  spawn sites with the real CLI, 2026-10-26.** Board task `dcd92557`.
  `assistSettingsArgs` and `chatSettingsArgs` put `PINNED_CYCLE_ENV` into each
  child's one `--settings`, read off `reviewEnv()` and `chatEnv()`. A scratch
  `DATA_DIR`, `CLAUDE_BIN` wrapping 2.1.310, a fake key and server
  `ANTHROPIC_BASE_URL` naming A. After one cycle, the checkout's
  `.claude/settings.json` named B with `HTTP_PROXY`/`http_proxy`/`ALL_PROXY` P,
  and `$CLAUDE_CONFIG_DIR/settings.json` named U with proxy Q; `startAssist`
  ran a review and `sendChatMessage` a turn. Built from `a177041e`, the
  review's `/v1/messages` reached P addressed to B, the chat's reached Q
  addressed to U, both with `x-api-key`, and with only the user file the
  review's reached Q addressed to U. With the change, all of them reached A
  and B, U, P and Q got nothing. With the planted hosts answering a million
  output tokens, the review recorded $20.00004 and the turn stopped at its
  $2.00 limit before the change, and each recorded $0.00006 after. Caveat: not
  as root with a uid drop, not under `UF_SANDBOX`, not through winnow.

- **A user-scope proxy received the chat's MCP capability, on 2.1.310,
  2026-10-26.** Same rig, built from `a177041e`: proxy Q got both of the chat
  turn's `POST http://127.0.0.1:3000/api/mcp` requests, each carrying an
  `Authorization` header (names logged, not values), which is the turn's
  capability bearer. With the pins, Q got nothing. Caveat: no server was
  listening at the MCP URL, so the after run shows only that nothing went
  through Q, not that the tools connected.

- **A checkout's hooks reached its own validator's request until the assist
  turned hooks off, measured through `startAssist` with the real CLI,
  2026-10-26.** Board task `9ec70b90`. A scratch `DATA_DIR`, `CLAUDE_BIN`
  wrapping 2.1.310, a fake key and `ANTHROPIC_BASE_URL` naming one loopback
  stub that logged which planted strings each request body held. After one
  cycle, the checkout's `.claude/settings.local.json` held a
  `UserPromptSubmit` hook printing one string, a `SessionStart` hook returning
  a second as `additionalContext`, and `"disableAllHooks": false`. Its
  `.claude/settings.json` held a `SessionStart` hook returning a third. Each
  hook wrote a marker file. Then `startAssist` ran with `kind: "validate"`.
  Built from `a2ca76e3`, all three markers were written and the validator's
  one `/v1/messages` carried all three strings, as `SessionStart hook
  additional context: …` and `UserPromptSubmit hook success: …`. With
  `disableAllHooks: true` in `assistSettingsArgs`' `--settings`, no marker was
  written and no string arrived. Every validation completed, and a control
  with nothing planted wrote nothing and carried nothing on either build.
  Caveat: the validator only (the reviewer and resolver share its spawn and
  flag but were not run), not as root with a uid drop, not under
  `UF_SANDBOX`, not through winnow.

- **A checkout's `apiKeyHelper` still runs in an assist with hooks off, on
  2.1.310, 2026-10-26.** Same rig, with `settings.local.json` naming an
  `apiKeyHelper` that wrote a marker and printed a second fake key. On both
  builds the marker was written, and the validator's `/v1/messages` reached
  the pinned stub with the helper's key in `authorization` beside the
  environment's in `x-api-key`. The validation completed. Caveat: which of
  the two keys the real API honours was not measured.

- **A route handler can learn its request's peer port, but only through
  `diagnostics_channel`, on Next 15.5.24, 2026-10-25.** Board task
  `ef579cdc`. `NextRequestAdapter.fromNodeNextRequest` builds the handler's
  request from URL, method, headers and body alone, and `base-server.js` sets
  `x-forwarded-for` with `??=`: a client's own `6.6.6.6` arrived intact. A
  scratch app whose `instrumentation.ts` subscribed to
  `http.server.request.start` and called `AsyncLocalStorage.enterWith` with
  the socket gave the handler its own connection's `remotePort` in 450 of 450
  concurrent POSTs, half of them keep-alive, read before and after an
  `await`, under the standalone `server.js` and under `next dev`. Caveat: a
  scratch app on this repo's `node_modules`, not this app.

- **The exporter's socket belongs to the CLI's own pid, on 2.1.310,
  2026-10-25.** The real CLI ran `-p` with `telemetryEnv`'s variables against
  a loopback stub serving `/v1/messages` and `/api/otlp/v1/logs`, its pid read
  in a shell before `exec`. Both log POSTs used one keep-alive connection.
  `/proc/net/tcp` held one row with that client port facing the stub, and the
  only holder of its inode was that pid (18 threads, one process). Walking
  every `/proc/*/fd` for the owner took 5.5–11.7 ms. Caveat: under this
  container's managed policy, with no Bash call in the turn.

- **The run loop holds that pid, and under privilege separation the server
  cannot read its descriptors, 2026-10-25.** `runIteration` spawns
  `spawnCommand`'s launcher with `childCredentials()` as `uid`/`gid`, which
  libuv applies between fork and exec, so no wrapper process. `CLAUDE_BIN` is
  a symlink to an ELF binary, and `procs` keeps the child. But following
  `/proc/<pid>/fd/*` takes a `PTRACE_MODE_READ_FSCREDS` check
  (`proc_pid_fd(5)`). `ptrace(2)` denies that unless the target's real,
  effective and saved uids and gids all equal the caller's, or the caller
  holds `CAP_SYS_PTRACE`. This container's server, pid 6, is root with
  `CapEff` and `CapBnd` `00000000a80425fb`. That is Docker's default set, which
  lacks `CAP_SYS_PTRACE`. Cycles run at `UF_AGENT_UID`, 1000 by default
  (`docker-compose.yml`). So on a stock install the route can read
  `/proc/net/tcp` but not which process holds the socket. Caveat: read off
  the documented rule and the measured capability set, not run as root. With
  one uid for server and agent the read works, but there the agent can write
  `/data` itself.

- **Checking one pid for one socket costs under a millisecond, 2026-10-25.**
  As uid 1000 against its own process, with 22 descriptors: reading
  `/proc/net/tcp{,6}` and readlinking that pid's descriptors took 0.14 ms per
  check over 500. Spawning `/usr/bin/find /proc/<pid>/fd -maxdepth 1 -lname
  'socket:\[<inode>\]' -print -quit` took 0.70 ms per check over 100, all 100
  found. Caveat: `-lname` is a glob, so unescaped brackets match nothing.

- **A repository's `.claude/settings.json` decides where a work cycle's CLI
  sends its API calls, and so what cost its own exporter reports, on 2.1.310,
  2026-10-25.** The CLI ran `-p` with no `--setting-sources`, as cycles do.
  Its environment's `ANTHROPIC_BASE_URL` named stub A, which also took the
  telemetry. The cwd held `.claude/settings.json` with `env.ANTHROPIC_BASE_URL`
  naming stub B, which answered `input_tokens: 1000000000`. Every
  `/v1/messages` went to B, carrying the environment's `x-api-key`. The CLI's
  exporter posted `cost_usd` 4000.0001 per request to A, and the result said
  `total_cost_usd` 20000.0005. So binding ingest to the CLI's process would
  authenticate the reporter and not the figure: while cycles load project
  settings, a file in the repository gets the genuine CLI to report any
  cost. Caveat: an API key rather than an OAuth login, under this container's
  managed policy, whose only key is `sandbox`. Not checked: what the
  transcript scan reads for that cycle.

## Not yet verified by hand

- **The pins in a booted container with a real login and winnow on.** The
  measurements above used a fake API key and a scratch credentials file. They
  were never run as root with the uid drop or with winnow at
  `127.0.0.1:8789`. Settle: in a checkout a cycle will work in, commit
  `.claude/settings.json` with `{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:9"}}`
  and start a one-cycle run. A cycle that completes means the pin holds there;
  one that fails connecting to port 9 means it does not. Also unrun: a cycle
  under `UF_SANDBOX=1`. The 2.1.310 bundle sets its sandbox's own
  `HTTP(S)_PROXY` and `NO_PROXY` on each command unconditionally, so the
  inherited `""` pins should not cut a sandboxed `Bash` call's network.

- **Whether root in the shipped container is refused `readlink` on a cycle's
  descriptors.** Read off `ptrace(2)` above, not run. Settle, while a cycle
  runs: `docker compose exec usagefoundry sh -c 'for d in /proc/[0-9]*; do [
  "$(stat -c %u $d)" = "$UF_AGENT_UID" ] && { readlink $d/fd/0; break; };
  done'`. `Permission denied` confirms it. A `pipe:[…]` or `/dev/null` means
  root can follow the links and the binding needs no capability.

- **Whether the Bash tool's environment carries `OTEL_EXPORTER_OTLP_HEADERS`
  on 2.1.310.** The CLI's sandbox cannot start nested in an agent's own here
  (`EPERM … listen …srt-mux….sock`, `failIfUnavailable`), so no Bash command
  ran. Read off the bundle: the general child-environment builder deletes
  every `OTEL_*` key, which matches the hook above. Settle: in a container
  with `UF_SANDBOX` blank, start a run with `telemetryForRuns` on whose prompt
  asks it to run `env | grep -c OTEL_`; `0` means the premise in
  `docs/agent/metering/run-spend-readings.md` that `env` prints the token no
  longer holds there.

- **The assist's and chat's pins in a booted container.** Measured only
  through compiled modules in a scratch process (above). Settle: with
  `UF_LOCK_CLAUDE_HOME` off, save the operator's
  `$CLAUDE_CONFIG_DIR/settings.json`, add
  `"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:9"}` to it as the agent uid,
  start a review from a run page and send one chat message, then restore the
  file. Both completing means the pins hold there; either failing to connect
  to port 9 means they do not.
