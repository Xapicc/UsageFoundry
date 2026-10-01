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

- **`UF_LOCK_CLAUDE_HOME`'s entrypoint passed an 18-scenario `dash` harness.**
  Stubbed `chown`/`stat`/`id`/`setpriv`; every branch printed right and chowned
  nothing wrong. Control flow only, not a kernel: no ownership changed. CLI
  2.1.226 (throwaway config dir) reaches the API with an unwritable top level
  whose entries exist, and rewrites in place with `O_TRUNC` on `EACCES`.

- **Under `UF_LOCK_CLAUDE_HOME`'s layout an OAuth refresh is never attempted and
  no credential write lands, simulated on CLI 2.1.280, 2026-09-27.** A
  throwaway `CLAUDE_CONFIG_DIR` laid out like the lock (`CLAUDE_HOME_HANDBACK`'s
  entries present and writable, `settings.json` 0440), its directory `chmod
  0550` by its own owner in place of root:agent-gid 0750, which gives the same
  `EACCES` on a create beside a file; control 0750. With a fake expired
  `claudeAiOauth` token, a scrubbed env and `HTTPS_PROXY` at a loopback
  listener that logged each `CONNECT` and refused it, `claude -p` tried
  `platform.claude.com:443` 3 times in the control ("OAuth refresh failed
  (expected)" ×3 in `--debug-file`) and 0 times locked, with no line saying so:
  the refresh first takes `<config dir>/.oauth_refresh.lock` (`K_r`, byte
  192852671) and returns `lock_error` before the token request. A write through
  `Un().mutate`, the call the refresh's save makes, driven by `claude mcp add
  --client-secret`, replaced `.credentials.json` by rename in the control (inode
  53168190 to 53168214) and left inode, mtime and hash alone locked, failing on
  `mkdir .storage-write.lock` rather than at `cQ`'s temp file as predicted; only
  the CLI's stdout said so, and no arm's debug log names `.credentials.json`.
  `CLAUDE_SECURESTORAGE_CONFIG_DIR` at a writable sibling restored both under
  0550 (3 token attempts, write by rename). No mock token pair was possible: a
  127.0.0.1 `CLAUDE_CODE_CUSTOM_OAUTH_URL` is off the three approved hosts (byte
  ~190188853) and makes every command exit 0 with no output. So the refresh
  token is never spent and renewal itself fails from the access token's expiry.
  Caveat: not the lock's real uid/gid layout, no real provider refresh, and the
  save after a successful refresh (`ENn`) is read, not run.

- **A sticky, group-writable `1770` directory restores the refresh and the
  credential write the `0550` stand-in kills, simulated on CLI 2.1.280,
  2026-09-27.** Three throwaway `CLAUDE_CONFIG_DIR`s laid out like the lock
  (`CLAUDE_HOME_HANDBACK`'s entries present and writable, a fake expired
  `claudeAiOauth`, `settings.json` created root-owned then measured), each driven
  with a scrubbed env and `HTTPS_PROXY` at a loopback listener that logged every
  `CONNECT` and returned 403. `claude -p hi` then `claude mcp add
  --client-secret` per arm. **control `0750`:** 3 `CONNECT platform.claude.com:443`
  ("OAuth refresh failed (expected)" ×3 in `--debug-file`) and the credential
  write replaced `.credentials.json` by rename (inode 54131671→54142650, hash
  changed). **`0550`** (the stand-in for the old root-owned top level, same
  `EACCES` on a create beside a file): 0 `platform` attempts, the write failed
  `EACCES: … mkdir '.storage-write.lock'`, and `.credentials.json` kept its inode,
  mtime and hash. **`1770`** (the fix's mode): 3 `platform` attempts like the
  control, the write succeeded by rename (inode 54152089→54170482, hash changed),
  and `settings.json`'s inode and mtime did not move across either step; the
  directory ended `drwxrwx--T`. So a `1770` layout renews the login the `0550`
  one silently kills. Caveat: a single-uid stand-in owns the directory at `1770`
  rather than `root:agent-gid`, so this arm shows the refresh and the write
  working, not the cross-uid protection of `settings.json`, which is the entry
  below; no real provider refresh.

- **The sticky bit refuses a second uid the unlink or rename that `settings.json`
  is held by, and the sandbox read-only-binds `~/.claude` so the token cannot be
  renamed out of its deny, 2026-09-27.** In a sticky `1777` directory (`/tmp`)
  owned by uid 65534, uid 1000 `rename(2)`-over and `rmdir(2)` of a
  65534-owned entry both returned `EPERM`, which is exactly what stops a run
  removing or replacing the root-owned `settings.json` in the now group-writable
  lock directory (it can still create and replace entries it owns, tested against
  its own files). And the pinned binary constructs its Bash sandbox as
  `["--ro-bind","/","/"]` with a writable `--bind` only for working directories
  and explicit `allowWrite` paths, so `~/.claude` is read-only inside any
  sandboxed command: an agent cannot rename `.credentials.json` to a name the
  `credentials.files` deny does not cover, which is what keeps the group-writable
  directory from opening a read path to the token the `0750` layout closed by
  mode. Caveat: the cross-uid `EPERM` is measured with 65534/1000 on this
  container's kernel, not with the lock's own `root`/`agent-gid` pair; the
  sandbox bind shape is read off the binary, not run.

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

## Not yet verified by hand

- **What an authenticated work cycle replaces under `~/.claude` is unwatched,
  2026-09-27.** *Verified* above reads each deny-listed file's write method off
  the binary and reproduces the strip on `.config.json`, but both scratch runs
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

- **The intake filter's uid drop has never been booted.** Unseen: the filter
  running as the agent uid (`docker compose exec usagefoundry ps -o uid,cmd |
  grep 'winnow filter'` must not say 0), the `/var/lib/winnow` ledger growing
  after a cycle (a failed write is silent), and uid 1000 refused `filter-off`.

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

- **Root-owning `~/.claude` (`UF_LOCK_CLAUDE_HOME=1`) has never run in a
  container.** Unknown: that the kernel enforces it (`fakeowner` on macOS may
  void it), that cycles still meter, what it does to the host's `~/.claude`.
  Not read-only: credentials stay readable; `remote-settings.json` and
  `policy-limits.json`, not fully traced, stay agent-owned. Steps, none run:
  ```sh
  # 0. the shipped state first — with UF_LOCK_CLAUDE_HOME unset, nothing changes
  docker compose up -d --build
  docker compose logs usagefoundry | grep UF_LOCK_CLAUDE_HOME    # expect nothing
  uid=$(docker compose exec -T usagefoundry printenv UF_AGENT_UID)
  docker compose exec --user "$uid" usagefoundry sh -c \
    'test -w ~/.claude/settings.json && echo BAD-writable'   # expect BAD-writable

  # then set UF_LOCK_CLAUDE_HOME=1 in .env and restart
  docker compose up -d
  docker compose exec usagefoundry sh -c 'echo "[$UF_LOCK_CLAUDE_HOME]"'
  # expect [1]: compose forwards by name and has no env_file
  docker compose logs usagefoundry | grep UF_LOCK_CLAUDE_HOME
  # expect "…is root-owned: a run cannot rewrite or replace its settings.json…"

  # 1 + 2. the two the sketch names (09-implementation-sketch.md:274–284)
  docker compose exec --user "$uid" usagefoundry \
    sh -c 'echo x >> ~/.claude/settings.json'                    # expect denied
  docker compose exec --user "$uid" usagefoundry \
    sh -c 'rm -f ~/.claude/settings.json; ls ~/.claude/settings.json'
                                              # expect denied, and still listed
  # if the append *succeeds*, the lock is not in force and your settings.json is
  # no longer valid JSON — remove the stray line before the next session reads it

  # 3. and the half that is not a permission check — the metering path
  docker compose exec --user "$uid" usagefoundry \
    sh -c 'ls ~/.claude/projects >/dev/null && touch ~/.claude/projects/.probe'
                                                          # expect BOTH to work
  docker compose exec --user "$uid" usagefoundry \
    sh -c 'cat ~/.claude/settings.json >/dev/null'           # expect it to work
  # then run a real work cycle and confirm the dashboard's figures move

  # from a host shell, not docker compose exec
  ls -ld ~/.claude ~/.claude/settings.json
  # Linux: expect root:<your gid> 0750, and root:<your gid> 0640 on the file
  claude -p 'say hi'                               # expect a normal answer

  # the way back: clear UF_LOCK_CLAUDE_HOME in .env, then
  docker compose up -d
  docker compose logs usagefoundry | grep UF_LOCK_CLAUDE_HOME
  # expect "off — gave /home/node/.claude back to <uid>:<gid>"
  # and if that ever fails to run — two paths, no -R:
  sudo chown "$(id -u):$(id -g)" ~/.claude ~/.claude/settings.json
  sudo chmod 0700 ~/.claude && sudo chmod 0600 ~/.claude/settings.json
  ```

- **That the `1770` lock lets a real OAuth refresh land while a second uid still
  cannot replace `settings.json` is simulated only, 2026-09-27.** *Verified*
  above measured the refresh and the credential write coming back at `1770` on a
  single-uid stand-in, and the cross-uid `rename`/`rmdir` `EPERM` on a `/tmp`
  sticky directory with 65534/1000; the lock's own `root:agent-gid 1770` with a
  separate agent uid, and a real provider refresh, were not tried together.
  Settle in a container with `UF_LOCK_CLAUDE_HOME=1`, `UF_UID` set, and a login
  whose access token has expired:
  ```sh
  uid=$(docker compose exec -T usagefoundry printenv UF_AGENT_UID)
  docker compose exec usagefoundry sh -c 'ls -ld ~/.claude ~/.claude/settings.json'
  # expect ~/.claude drwxrwx--T root:<gid>, settings.json -rw-r----- root:<gid>
  # a run cannot append to, remove or replace settings.json:
  docker compose exec --user "$uid" usagefoundry sh -c \
    'echo x >> ~/.claude/settings.json; rm -f ~/.claude/settings.json; \
     mv /tmp/x ~/.claude/settings.json 2>&1; ls ~/.claude/settings.json'
                                    # expect all three denied, and still listed
  # but the login renews: record the inode across an expiry-driven refresh
  docker compose exec usagefoundry sh -c 'stat -c "%i %y" ~/.claude/.credentials.json'
  docker compose exec --user "$uid" usagefoundry \
    claude -p hi --debug-file /tmp/r.log        # expect a normal answer
  docker compose exec usagefoundry sh -c 'stat -c "%i %y" ~/.claude/.credentials.json'
                                    # expect the inode to have moved (renewed)
  ```
  The refresh token was never spent under the old read-only layout, so an install
  that stopped authenticating recovers the login on the first boot with this mode.

- **That a live work cycle opens no inbox and is not offered `ListAgents`,
  after the change to every env that spawns `claude`.** The probe in *Verified*
  ran inside the Bash sandbox, which refuses `AF_UNIX`, and did not go through
  the app's own spawn. Settle in the deployed container while runs are live.
  Reading both places works from a work cycle's Bash, because only creating a
  socket is refused there. `ls -la /tmp/cc-socks/` must hold no socket for any
  `sdk-cli` session.
  `jq -r 'select(.entrypoint=="sdk-cli") | "\(.pid) \(.messagingSocketPath // "none")"' ~/.claude/sessions/*.json`
  must name no socket. On the build before this change, read 2026-10-01 from a
  work cycle's Bash, all 12 `sdk-cli` records named a socket and 5 of those
  sockets existed. A run asked to call `ListAgents` must report that it has no
  such tool.

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
