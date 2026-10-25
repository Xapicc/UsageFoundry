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
