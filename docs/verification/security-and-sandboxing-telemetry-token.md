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

## Not yet verified by hand

- **Whether the Bash tool's environment carries `OTEL_EXPORTER_OTLP_HEADERS`
  on 2.1.310.** The CLI's sandbox cannot start nested in an agent's own here
  (`EPERM … listen …srt-mux….sock`, `failIfUnavailable`), so no Bash command
  ran. Read off the bundle: the general child-environment builder deletes
  every `OTEL_*` key, which matches the hook above. Settle: in a container
  with `UF_SANDBOX` blank, start a run with `telemetryForRuns` on whose prompt
  asks it to run `env | grep -c OTEL_`; `0` means the premise in
  `docs/agent/metering/run-spend-readings.md` that `env` prints the token no
  longer holds there.
