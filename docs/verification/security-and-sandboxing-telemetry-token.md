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

- **Whether the Bash tool's environment carries `OTEL_EXPORTER_OTLP_HEADERS`
  on 2.1.310.** The CLI's sandbox cannot start nested in an agent's own here
  (`EPERM … listen …srt-mux….sock`, `failIfUnavailable`), so no Bash command
  ran. Read off the bundle: the general child-environment builder deletes
  every `OTEL_*` key, which matches the hook above. Settle: in a container
  with `UF_SANDBOX` blank, start a run with `telemetryForRuns` on whose prompt
  asks it to run `env | grep -c OTEL_`; `0` means the premise in
  `docs/agent/metering/run-spend-readings.md` that `env` prints the token no
  longer holds there.
