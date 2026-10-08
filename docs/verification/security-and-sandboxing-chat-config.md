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

- **A repository's `.git/config` runs commands on `fetch`, `push` and `log`
  under the chat's first two pairs, and nine more stop them, 2026-10-06, git
  2.39.5.** Board task `5219cea7`. A scratch repository's `.git/config`
  planted marker commands as `credential.helper`, a URL-scoped
  `credential.http://127.0.0.1:<port>.helper`, `core.askPass`, `core.sshCommand`
  for an `ssh://127.0.0.1:1` remote, `uploadpack` and `receivepack` for a
  local-path remote, an `ext::` remote with `protocol.allow=always`,
  `core.gitProxy` for a `git://` remote, and the three `gpg.*program` keys
  with `log.showSignature=true`. It also had three commits carrying junk PGP,
  x509 and SSH signatures. Under `env -i` with a scratch `HOME` and
  `GIT_TERMINAL_PROMPT=0`, the commands were `git fetch` of each remote, a
  `git push` to the local one, `git log -1` of each signed commit, and a
  `git fetch` of a loopback server answering 401. Every marker appeared with
  no pairs, with `core.fsmonitor=` and `core.hooksPath=/dev/null`, and with
  those plus the GitHub pairs. With the nine pairs `CHAT_GIT_CONFIG` now adds,
  none appeared except `core.gitProxy`'s, because `core.gitProxy=` does not
  override it: the first match wins, and the repository's comes first. Both
  `protocol.git.allow=never` and `GIT_PROXY_COMMAND=` stopped it, and the
  first was taken so the block stays one mechanism. Caveat: this container
  has no `ssh`, `gpg`, `gpgsm` or `ssh-keygen`, and the image installs none
  of them, so the pinned values were measured failing to start ("unable to
  fork", "cannot run gpg") rather than running.

- **An empty `credential.helper` after the GitHub pairs takes the GitHub
  helper away, 2026-10-06, git 2.39.5.** `git credential fill` for
  `github.com` with `GH_TOKEN` set printed the token when `credential.helper=`
  came before the two GitHub helper pairs. When it came after them, the fill
  died with `could not read Username … terminal prompts disabled`. The
  repository's own unscoped helper did not run in either order.

- **What runs a repository-named driver, and what does not stop it,
  2026-10-06, git 2.39.5.** A scratch repository with `*.txt filter=x` and
  `*.dat diff=y` in `.git/info/attributes`, marker-writing `filter.x.clean`,
  `filter.x.smudge`, `diff.y.command` and `diff.external`, both files
  modified, and the chat's first two pairs set. The clean filter ran on
  `status` when a file's size matched the index and its mtime did not, and
  not when the size differed. It also ran on `diff`, `diff --stat`,
  `diff --no-ext-diff` and `commit -a`. The smudge filter ran on `diff` and
  on `checkout <rev> -- <path>`. `diff.y.command` and `diff.external` ran on
  `diff` and not on `log -p` or `show`. With `GIT_EXTERNAL_DIFF` set to a
  third marker, `git diff` ran that marker and `diff.y.command` and both
  filters as well. Only `-c filter.x.clean= -c filter.x.smudge=` stopped the
  filter, which requires knowing the name. Caveat: textconv was not re-run;
  it is the entry above that measured it.

- **The pinned CLI runs git itself at startup in a repository cwd, and that
  runs a repository's clean filter, 2026-10-06, Claude Code 2.1.280.** `claude
  -p hi --setting-sources user --settings '{"disableAllHooks":true}'
  --output-format stream-json --verbose --permission-mode bypassPermissions`
  ran against a stub API that answered with text and `end_turn`, with no tool
  call. Its cwd was a scratch repository with a stale, modified `f.txt` under
  a planted `* filter=x`, and the chat's first two pairs were set.
  `GIT_TRACE` recorded `git status --short --ignore-submodules=dirty`, `git
  log --oneline -n 5`, `git remote`, `git remote get-url origin`, `git config
  user.name` and a `git ls-files` for `.claude/settings.local.json`. The clean
  filter's marker appeared. Caveat: a block's real spawn also carries
  `--mcp-config` and the sandbox overlay, and neither was present.

- **The tests for the fetch, push and log pairs fail on the composition
  before the change, 2026-10-06.** With the compiled `CHAT_GIT_CONFIG`
  patched back to its two old pairs, `cliPath.test.ts`'s "pins every one of
  them" failed with all ten markers present. With `agentGitEnv` patched back
  to appending `extra` last, "still answers github.com from the token"
  failed with `terminal prompts disabled`. With the change, `npm test`
  passed 4,120 of 4,120 with none skipped. Caveat: the test's runner removes
  `GIT_SSH_COMMAND` and `GIT_SSH`, because an agent's own sandbox sets the
  first and it outranks `core.sshCommand`.

- **The pinned CLI runs no git in an `--add-dir`, so a repository there runs
  no filter at startup, 2026-10-07, Claude Code 2.1.280.** Board task
  `7764bc65`. `claude -p hi --setting-sources user --settings
  '{"disableAllHooks":true}' --output-format stream-json --verbose
  --permission-mode bypassPermissions --strict-mcp-config` ran against a stub
  API that answered text and `end_turn`, under `GIT_TRACE` and the chat's
  first two pairs. The scratch repository had a stale, modified `f.txt` under
  a planted `* filter=x`. With the repository as the cwd, the trace held the
  six startup commands from the entry above and the filter ran twice. The
  request said `Is a git repository: true` and carried a `gitStatus` block
  with the branch, `M f.txt` and the last commit. With a plain directory as
  the cwd and the repository as `--add-dir`, the trace was empty and the
  filter did not run. The request said `Is a git repository: false` and listed
  the repository under `Additional working directories`. A `CLAUDE.md` with a
  marker in the repository reached neither request; without `--setting-sources
  user` it reached the request. Caveat: no `--mcp-config`, no sandbox overlay
  and no tool call; this container's managed policy had the sandbox on.

- **The test for a block's startup git fails with the child standing in its
  folder, 2026-10-07.** `blockStartupGit.test.ts` was run with the compiled
  `launchOrchestratorChild` patched to stand in `o.folder` again, as the old
  `cwd` option did. Its spawn case failed with "the block's child ran the
  repository's clean filter". With the change, both cases passed. Caveat: one
  process, not root; the stub runs the measured `git status` rather than the
  CLI.

- **Under the `UF_SANDBOX=1` policy shape, a chat `Bash` call whose sandbox
  cannot start does not run, 2026-10-07, Claude Code 2.1.280.** Board task
  `7764bc65`. The managed file here had `enabled`, `failIfUnavailable: true`,
  `allowUnsandboxedCommands: false` and `enableWeakerNestedSandbox`, as
  `docker-entrypoint.sh` writes them. A turn with the chat's flags ran against
  a stub API answering one `Bash` call that copied a scratch file into a
  marker. The `--settings` overlay carried `allowWrite`, a `denyRead` over the
  file's directory and `disableAllHooks`. The tool result was `Sandbox is
  required but failed to initialize: EPERM: operation not permitted, listen
  '…/srt-mux-…sock'`, and no marker was written. It was the same with
  `dangerouslyDisableSandbox: true` in the tool input, with the overlay also
  setting `allowUnsandboxedCommands: true`, and with `TMPDIR` moved off
  `/tmp`. Caveat: nested in an agent's sandbox, which refuses the socket, so
  whether `denyRead` hides a file from a working sandbox was not observed.

- **A tmpfs over a directory hides it from `/proc/<pid>/root` across a user
  namespace, 2026-10-07.** In `unshare -Urm` with a tmpfs mounted over a
  scratch directory holding a `0600` file, `cat` of the file failed with
  ENOENT. Through `/proc/<pid>/root` of a same-uid `sleep` outside the
  namespace it failed with EACCES. The same `/proc/<pid>/root` read from
  outside succeeded. `ptrace_scope` was 0. This is the shape the 2.1.280
  binary gives a denied directory (`--tmpfs`, read from the binary). Caveat:
  `unshare`, not the CLI's own bwrap flags.

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

- **The pinned `ssh` and signature programs were measured only where none is
  installed.** That a planted `core.sshCommand` or `gpg.program` does not run
  under the block is measured. What is not measured is that, on a machine
  that has `ssh` and `gpg`, an `ssh://` fetch and `git log --show-signature`
  still work under it. That matters for `npm run dev` on a host and not for
  the image. To settle it on such a host, run `git fetch` of a reachable ssh
  remote and `git log -1 --show-signature` of a signed commit, each with
  `GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=core.sshCommand GIT_CONFIG_VALUE_0=ssh
  GIT_CONFIG_KEY_1=gpg.program GIT_CONFIG_VALUE_1=gpg`. Expect the same
  output as without the variables.

- **Whether `denyRead` keeps a capability file from a chat `Bash` call.**
  Board task `f3cb882a` would add `/run/uf-mcp` to the chat's overlay, and
  nothing here could start the CLI's sandbox to observe it. To settle it, in a
  booted `UF_SANDBOX=1` container and never against the live app's
  `/run/uf-mcp`, run the stub-API probe as uid 1000 with the chat's flags. Use
  an overlay denying a scratch directory that holds a marker file, and a
  `Bash` call running `git status` in a scratch repository whose planted
  `filter.x.clean` copies that file out. Expect the copy to fail.
