# Verification: Security and sandboxing — the `~/.claude` lock and OAuth refresh

[← Verification index](../verification.md)

## Verified

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

## Not yet verified by hand

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
