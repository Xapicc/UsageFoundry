# Verification: Security and sandboxing — the privilege split, credentials, auth and containment

[← Verification index](../verification.md)

## Verified

- **Child environment, dumped from a real spawn:** 97 variables, `PATH` and
  `HOME` intact; `ANTHROPIC_ADMIN_KEY`, `UF_AUTH_TOKEN` and `OTEL_*` absent.

- **Path traversal rejected in every form tested:** `../`, an absolute path
  outside all mounts, an escaping symlink, another mount's folder, an unknown
  mount id, an unmounted workspace, a disabled slot.

- **The prune has to run as the server, not the agent uid, 2026-08-24.** Under
  `setpriv`, a child at `UF_AGENT_UID` raises `PermissionError` on
  `WINNOW_DATA_DIR`, because transcripts are `0600 root` and `DATA_DIR` is
  `0700 root` on this install. `spawnPrune` is the only spawn that omits
  `childCredentials()`.

- **The gap-register pass, 2026-09-06**, dev server on an isolated `DATA_DIR`:
  logout-all without a credential is 401 and revokes nothing; with
  `UF_STATUS_TOKEN` set, `/api/status` takes a minted `uf_session` but not the
  master token as a cookie. `npm test` 2,268/2,269, the miss
  `backupRestore.test.ts`'s `ulimit -f` case, which fails on this macOS host.

- **The entrypoint drops the intake filter to the agent uid, under a harness
  only.** The real `docker-entrypoint.sh` with a recording `setpriv` and `uv`
  recorded `setpriv --reuid=1000 --regid=1000 --clear-groups env -i …` and a
  seven-entry environment holding none of the four credentials set. A
  recording `uv` is not `uv`, and none of it boots a container.

- **`CLAUDE_CODE_HARBOR_KITE=0` removes `ListAgents` and skips the CLI's peer
  inbox, on 2.1.280, 2026-10-01.** Measured with
  `proposals/CrossSessionCommunication/scripts/native-tools.sh`, which runs the
  CLI against its stub with a dummy key. The argv was the app's shape
  (`--permission-mode acceptEdits --allowedTools Grep Glob --disallowedTools
  'Bash(pkill:*)' 'Bash(killall:*)'`) plus `--debug-file`. Without the
  variable: `init tools (23)` including `ListAgents` and `SendMessage`, and the
  debug log shows the inbox trying to listen at
  `$XDG_RUNTIME_DIR/cc-socks/<pid>.sock`. With
  `EXTRA_ENV=CLAUDE_CODE_HARBOR_KITE=0`: `init tools (22)` with `ListAgents` the
  only one gone, the same 22 in the stub's request, and `[uds-messaging]
  Skipped: cross-session messaging gate off`. A stub turn that called
  `ListAgents` under the variable got "No such tool available … disabled for
  this session, in subagents as well as here". Without `--allowedTools` the
  counts are 21 and 20. `childEnv`, `chatEnv`, `reviewEnv` and `authEnv` set the
  variable, and `orchestrator.test.ts` pins it on all four. Caveat: the Bash
  sandbox refuses `AF_UNIX`, so the listen without the variable failed with
  `EPERM`, and neither run left a socket under `/tmp/cc-socks/` or the scratch
  `$XDG_RUNTIME_DIR`. That the variable keeps the socket from being created is
  read from the debug line, not seen as a missing file. The probe set the
  variable by hand rather than through the app's builders.

- **Work cycles spawned by the deployed app open no peer inbox and are not
  offered `ListAgents`, on 2.1.280, 2026-10-04.** Read from a live cycle's own
  Bash, where `printenv CLAUDE_CODE_HARBOR_KITE` said `0`. `find /tmp/cc-socks
  -maxdepth 1 -type s | wc -l` said `0`, and `ls -la /tmp/cc-socks/` said "No
  such file or directory". The sandbox sees the real `/tmp`, because this
  session's own `/tmp/claude-1000/…` directory showed there. The task's step-2
  `jq` loop read 13 `sdk-cli` records. It said `none` for all 6 started
  2026-10-04T23:42:42Z on 2.1.280: pids 1151–1156, which carry no
  `messagingSocketPath` key, though they keep `peerProtocol: 1`. This cycle is
  pid 1154, matched by `CLAUDE_CODE_SESSION_ID`. The 7 records naming a socket
  started 2026-09-07 to 09-11 on 2.1.260 in other pid namespaces, and those
  sockets are gone. `ToolSearch select:ListAgents` found no such tool, while
  `SendMessage` is still offered as a deferred tool. Caveat: all six cycles came
  through `childEnv`, so `chatEnv`, `reviewEnv` and `authEnv` were not seen live.

- **A child spawned with `{uid, gid}` loses the server's supplementary groups,
  read from libuv source, not measured, 2026-10-26.** Node 22.23.4 bundles libuv
  1.51.0 (`node_shared_libuv` false), and its `deps/uv/src/unix/process.c` is
  byte-identical to libuv's `v1.51.0` tag. There `uv__process_child_init` calls
  `setgroups(0, NULL)` whenever SETUID or SETGID is set (l.385–394), then
  `setgid` (l.396) and `setuid` (l.399), and ignores `setgroups`' result. On
  Linux, `fork()` (l.841) is the only path to it; `posix_spawn` is `__APPLE__`
  only (l.420–817). `spawn` reaches `uv_spawn` via `process_wrap.cc` (l.222,
  234, 362), `spawnSync` via `spawn_sync.cc` (l.516, 866, 881). Caveat: a
  refused `setgroups`, e.g. under `setgroups` = `deny`, keeps the groups.

- **`CLAUDE_CODE_HARBOR_KITE=0` still removes `ListAgents` on 2.1.319,
  2026-11-08**, the check `docs/agent/security/` requires of a pin bump. The
  macOS build of 2.1.319 against the same stub with a dummy key: without the
  variable `init.tools` held 22 tools including `ListAgents` and
  `SendMessage`; with it, 21, `ListAgents` the only one gone. Caveat: the
  darwin build, a bare argv without the app's `--allowedTools`, and the inbox
  socket was not looked for.

## Not yet verified by hand

- **What an authenticated work cycle replaces under `~/.claude` is unwatched,
  2026-09-27.** *Verified* in
  [security-and-sandboxing-config-dir-binds.md](security-and-sandboxing-config-dir-binds.md)
  reads each
  deny-listed file's write method off the binary and reproduces the strip on
  `.config.json`, but both scratch runs
  stopped at "Not logged in", so two things rest on the binary alone: that an
  authenticated headless cycle never rewrites `settings.json`, and that an OAuth
  refresh strips `.credentials.json`'s read-deny bind. Settle from an
  authenticated container by recording
  `stat -c '%n %i' ~/.claude/settings.json ~/.claude/.credentials.json` before
  and after a real work cycle, and, from inside a sandboxed session there (the
  credential file reads as a `/dev/null` character device), polling that inode
  and a one-byte read across a token refresh: the read should stop returning the
  device in the step the inode changes, and the `settings.json` inode should not
  move at all.

- **`/app`'s ownership has never been read off a built image** since the
  `Dockerfile` stopped chowning it to `node` (#200); `deployment.test.ts` pins
  the absence. Settle: `stat -c '%U %n' /app /app/server.js
  /app/scripts/discord-relay.mjs` must say `root` thrice, a `touch` as the
  container's `UF_AGENT_UID` must be refused, and the boot log stay healthy.

- **The privilege split's probes (#79, #80, #87, #83) have never been run
  against a container.** `resolveChildCredentials`, the compose/Dockerfile
  pair, the capability file and `telemetryEnv` are unit-tested; one uid cannot
  observe the MCP refusal.
  Also unrun: an isolated run committing as the dropped uid, and macOS Docker
  Desktop's mount remapping. Known open: agents can read `.credentials.json`.
  ```sh
  docker compose logs usagefoundry | grep 'privilege separation'
  # expect "on: children run as 1000:1000, chat and block turns as 1000:65533,
  # server as 0"; uid below read in-container (#147, reshaped 2026-09-08, not re-run)
  uid=$(docker compose exec -T usagefoundry printenv UF_AGENT_UID)
  # #79 the server's environment: expect a permission error, not a count
  docker compose exec --user "$uid" usagefoundry sh -c \
    'tr "\0" "\n" < /proc/$(pgrep -f "next-server" | head -1)/environ | grep -c UF_'
  # #80 the database, fresh and upgraded volume: expect ok twice
  docker compose exec --user "$uid" usagefoundry sh -c \
    'test -w /data/usagefoundry.db && echo BAD-writable || echo ok'
  docker compose exec --user "$uid" usagefoundry sh -c \
    'test -w /data/server.lock && echo BAD-writable || echo ok'
  # #87 mid chat turn: nothing from the first ls, a permission error from the second
  docker compose exec --user "$uid" usagefoundry sh -c \
    'ls /tmp/uf-mcp-* 2>/dev/null; ls /run/uf-mcp 2>/dev/null; echo "exit=$?"'
  # #87 the read: expect "ok: not readable", directory group 65533; no
  # --mcp-config argv found proves nothing, so probe while the turn works
  docker compose exec --user "$uid" usagefoundry sh -c '
    for p in $(ls /proc | grep "^[0-9][0-9]*$"); do
      cfg=$(tr "\0" "\n" < /proc/$p/cmdline 2>/dev/null |
            grep -A1 -x -- --mcp-config | tail -1)
      case "$cfg" in /run/uf-mcp/*)
        echo "pid $p -> $cfg"
        if [ -r "$cfg" ]; then echo "BAD-readable, $(wc -c < "$cfg") bytes"
        else echo "ok: not readable"; fi ;;
      esac
    done'
  # #83 task the agent with `env | grep OTEL_EXPORTER_OTLP_HEADERS`: expect a
  # bearer that is not UF_AUTH_TOKEN
  ```

- **The `/api/mcp` middleware exemption under a real `UF_AUTH_TOKEN`.** Only
  the route's capability check ran, with auth off (no edge runtime there).

- **That a chat turn, a review and `claude auth login` open no inbox under the
  variable.** *Verified* above saw only work cycles, which `childEnv` spawns.
  No child of `chatEnv`, `reviewEnv` or `authEnv` was live at the time. Settle
  while one of each runs: its pid must not appear in `ls /tmp/cc-socks/`, and
  `jq -r 'select(.entrypoint=="sdk-cli") | "\(.pid) \(.messagingSocketPath // "none")"' ~/.claude/sessions/*.json`
  must say `none` for it, if it writes a record at all.

- **The receiving side of a peer message (U1), and `SendMessage` refusing a
  live peer under the variable.** Not runnable inside the Bash sandbox, for the
  same `AF_UNIX` reason. With no live peer to address, the only measured change
  was the hint for an unknown name: "Use ListAgents to see everyone you can
  message" became "use the agent ID from a background agent's spawn result".
  The "Cross-session messaging is not available in this session" refusal is
  read from the binary. Settle from a container shell outside the sandbox: run
  `bash proposals/CrossSessionCommunication/scripts/native-pair-test.sh`, then
  run it again with `CLAUDE_CODE_HARBOR_KITE=0` added to the `env -i` line for
  `ROLE_A` and `ROLE_B`. In the second run A's debug log must read `Skipped`,
  no socket may appear for A, B's `ListAgents` must not list A, and B's send
  must be refused.

- **That a mid-session feature-flag refresh cannot reopen the inbox under the
  variable.** The skip line itself ends "(will late-bind if a GrowthBook refresh
  enables it)", and the binary has that late-bind path. That the variable holds
  against it is inferred: the gate returns the variable's value whenever it is
  set (`proposals/CrossSessionCommunication/13-validation.md` §4). The stub
  probe reaches no flag service, so no refresh happened. Settle in the deployed
  container, outside any Bash sandbox, with a work cycle that runs past a flag
  refresh: `ls /tmp/cc-socks/`, polled throughout, must never show its pid.
  Started by hand with `--debug-file`, its log must hold no `Late bind` line.
  That cycle is billed.

- **That a dropped child really loses root's supplementary groups.** The
  libuv reading above is source only; this container's uid 1000 cannot drop, and
  a user namespace refuses `setgroups`. Settle as root in a scratch container:
  `usermod -aG node root`, a fresh shell, then
  `node -e 'require("child_process").spawnSync("grep",["^Groups","/proc/self/status"],{uid:1000,gid:1000,stdio:"inherit"})'`.
  An empty `Groups:` confirms the drop.
