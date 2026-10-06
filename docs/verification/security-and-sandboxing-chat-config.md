# Verification: Security and sandboxing — what the chat child loads from files a work cycle writes

[← Verification index](../verification.md)

The rules these entries back are `docs/agent/security/chat-child-config-files.md`. Board task `7dd5f973`. Everything here ran as uid 1000 inside an agent's Bash sandbox against scratch files under `$TMPDIR`, never against the real `/home/node` or a real repository's `.git`. "A stub API" is a loopback HTTP server that answers `POST /v1/messages` with one `Bash` `tool_use` and then `end_turn`, with the CLI pointed at it by `ANTHROPIC_BASE_URL` and a fake `ANTHROPIC_API_KEY`.

## Verified

- **The CLI's shell snapshot runs `~/.bashrc` and `~/.profile` from `HOME`,
  2026-10-06, Claude Code 2.1.280.** The binary resolves the rc file from
  `homedir` (`~/.bashrc` for bash on Linux, `ZDOTDIR` for zsh) and runs the
  snapshot as `bash -c -l`. A `claude -p` against a stub API, given a `HOME`
  holding a marker-writing `.bashrc` and `.profile`, wrote both markers on its
  one `Bash` call. Caveat: the managed sandbox could not start nested in the
  measuring sandbox (`EPERM … listen … srt-mux…sock`), and the tool call
  failed. The snapshot ran anyway, so it runs outside the command's sandbox
  at least when that sandbox fails. Under a working sandbox it is unmeasured.

- **Hooks from user, project, local and plugin scope all run in a child with
  the chat's flags, and two flags stop them, 2026-10-06, 2.1.280.** `-p
  --output-format stream-json --verbose --permission-mode bypassPermissions
  --strict-mcp-config` against a stub API. A `SessionStart` and a
  `PreToolUse` hook each wrote a marker from `$CLAUDE_CONFIG_DIR/settings.json`,
  the cwd's `.claude/settings.json`, the cwd's `.claude/settings.local.json`
  and a `--plugin-dir` plugin's `hooks/hooks.json`: all eight fired. With
  `--setting-sources user`, only the user and plugin markers fired. With
  `--settings '{"disableAllHooks":true}'` as well, none fired. With
  `--setting-sources user`, `--agents … --agent probeagent` still put the
  agent's prompt in the request. Caveat: the plugin came from `--plugin-dir`,
  not from an enabled plugin in `plugins/cache` (see below).

- **The CLI keeps only the last `--settings`, 2026-10-06, 2.1.280.** The same
  probe with `--settings '{"disableAllHooks":true}'` followed by `--settings`
  carrying a sandbox write set ran the user hooks. In the reverse order, and
  with both keys in one object, no hook ran. Caveat: inferred from which hooks
  ran; whether the sandbox write set took effect was not observed.

- **The CLI writes into an empty `HOME` during a turn, 2026-10-06,
  2.1.280.** With `CLAUDE_CONFIG_DIR` set elsewhere, a fresh empty `HOME` held
  `.config/anthropic` after one turn against a stub API. That is why the
  chat's `HOME` is group-writable rather than read-only. Caveat: the CLI's
  behaviour with a read-only `HOME` was not measured.

- **`~/.gitconfig` and a repository's `.git` run commands in a read-only git,
  and two env-level pairs stop some of them, 2026-10-06, git 2.39.5.** Each
  command ran under `env -i` with a scratch `HOME`. With no override,
  `core.fsmonitor` in `~/.gitconfig` ran on `git status`. In a repository's
  `.git/config` it ran on `status`, `diff` and `blame`, and
  `.git/hooks/post-checkout` and `reference-transaction` ran on
  `checkout -b`. With `GIT_CONFIG_COUNT` pairs `core.fsmonitor=` and
  `core.hooksPath=/dev/null`, none of those ran, including when the
  repository set its own `core.hooksPath`. With the pairs, these still ran: a
  `.git/config` `diff.external` on `git diff`; a `filter.x.clean` named from
  `.git/info/attributes` on `diff` and `blame`; and a `diff.y.textconv` named
  there on `log -p`, `show` and `blame`. `diff.external=` made `git diff` exit
  128, `cannot run : No such file or directory`. A `core.pager` never ran
  with stdout a pipe. Caveat: git as uid 1000 in a scratch tree, not a chat
  turn's `Bash` call.

- **A user-site `usercustomize.py` runs on every `python3`, 2026-10-06,
  Python 3.11.2.** `python3 -c pass` under a scratch `HOME` holding
  `~/.local/lib/python3.11/site-packages/usercustomize.py` wrote its marker.
  With `PYTHONNOUSERSITE=1` it did not.

- **The tests for the chat's configuration fail on the composition before the
  change, 2026-10-06.** `cliPath.test.ts`'s block "the chat child's own
  configuration" was run with the compiled `chatEnv` patched back to the old
  composition: no `HOME` swap and no `CHAT_GIT_CONFIG`. Its four spawn cases
  failed, each because its planted command ran: `~/.gitconfig`, `~/.bashrc`,
  `usercustomize.py`, and the repository's `.git`. With the change, all seven
  passed, and `npm test` passed 4,005 of 4,005 with none skipped. Caveat: one
  process, not root; no chat group and no `/run`.

## Not yet verified by hand

- **No booted image has run a chat turn with its own `HOME`.** Unmeasured:
  that `/run/uf-chat-home` and `/run/uf-chat` come up `root:65533` at `0770`,
  that a turn completes and bills with `HOME=/run/uf-chat-home`, and that a
  work cycle is refused both directories. To settle it, send one chat message
  in a privilege-separated container, then run
  `docker compose exec usagefoundry stat -c '%U:%G %a' /run/uf-chat-home /run/uf-chat`
  and `docker compose exec -u 1000:1000 usagefoundry ls /run/uf-chat-home /run/uf-chat`,
  expecting `root:ufchat 770` and `Permission denied` twice.

- **An enabled plugin's hooks under `disableAllHooks` are inferred from a
  `--plugin-dir` one.** To settle it, take a scratch `CLAUDE_CONFIG_DIR` with
  a marketplace plugin installed and enabled whose `hooks.json` writes a
  marker. Run the stub-API probe above with and without
  `--settings '{"disableAllHooks":true}'`.

- **The git settings read only on a network operation were not measured.**
  These are `core.sshCommand`, `credential.helper` for a host other than
  github.com, a local remote's `uploadpack`, and `gpg.program` with
  `log.showSignature`. To settle it, plant each as a marker command in a
  scratch repository's `.git/config` with a local or `ssh://` remote. Run
  `git fetch` and `git log -1` under `chatEnv()`'s variables and see which
  markers appear.
