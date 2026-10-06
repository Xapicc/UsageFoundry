# Verification: Security and sandboxing — root's `PATH`, the agents' `PATH` and what a dropped process runs by name

[← Verification index](../verification.md)

## Verified

- **The tests for root's `PATH` and a stack's `env` fail on the tree before the
  change, 2026-10-05.** Board tasks `aff25da4` and `76b451aa`. The six test
  files the change touched or extended (`applyStacks`, `deployment`,
  `orchestrator`, `chat`, `review`, `landGate`) were compiled against the
  parent of `fdb28ff` in a scratch worktree and run there: 13 cases failed —
  the widened `refuseEnv` refusals, the `UF_AGENT_PATH` and root-`PATH` cases
  in `deployment.test.ts`, and the planted-toolbox cases that now plant into
  `UF_AGENT_PATH` and expect the child to get it rather than the server's
  `PATH`. With the change, `npm test` passed 3,731 of 3,731. Caveat: these
  read the `Dockerfile` and entrypoint as text and call the builders in one
  process; nothing booted an image (see below).

- **The entrypoint's literal `PATH` beats a planted one, 2026-10-05.** The
  lines from the top of `docker-entrypoint.sh` through `export PATH`, run under
  `dash` in a container of the previous image with planted `chown`, `node` and
  `stat` first on the inherited `PATH`, resolved the three to `/usr/bin/chown`,
  `/usr/local/bin/node` and `/usr/bin/stat`; the same probe without those
  lines resolved all three to the planted copies. Measured beside it: Node's
  `spawnSync` given `env: { PATH }` ran a bare name found only on that `PATH`,
  which is why the builders' `PATH`, not the server's, decides what a dropped
  child runs. Caveat: a shell probe of the first lines, not a boot as root.

- **`CLAUDE_BIN` and `CODEX_BIN` resolve on root's `PATH`, and nothing planted
  on the agents' runs, 2026-10-05.** Board task `af2a031b`. The resolver as
  built was run against `docker-entrypoint.sh`'s literal root `PATH`, in a
  container carrying this image's pins (Claude Code 2.1.280, Codex 0.153.4).
  It gave `/usr/local/bin/claude`, a native ELF spawned as it is. It spawned
  Codex as `/usr/local/bin/node /usr/local/bin/codex`, because that file is
  `codex.js` behind `#!/usr/bin/env node`, and that command answered
  `codex-cli 0.153.4`. Both are where `npm install -g` puts them as root under
  the base image's `/usr/local` prefix (`Dockerfile:454` and `:614`, with no
  `USER` line before either). `cliPath.test.ts` plants `claude`, `node` and an
  unresolvable `CODEX_BIN` name first on `UF_AGENT_PATH`. Compiled against the
  tree before the change, all 11 of its cases failed; the two planted-binary
  cases failed because the planted copy ran. With the change, all 11 passed,
  as did `npm test`, 3,744 of 3,744, both as it stands and with `CLAUDE_BIN`
  and `CODEX_BIN` set to names on no `PATH`. Caveat: the auth commands ran as
  a non-root user in one process; nothing booted an image as root (see below).

- **The boot's dropped `uv` is the image's and holds no credential,
  2026-10-06.** Board task `7e2073d5`. `uv_as_agent` was extracted from
  `docker-entrypoint.sh` at 50d60d8 and on this branch and run the way the
  task's reproduction ran it: as uid 1000 with `setpriv` shimmed to drop its
  flags, root's literal `PATH`, fake `UF_AUTH_TOKEN`, `ANTHROPIC_ADMIN_KEY`,
  `UF_GITHUB_TOKEN`, `UF_WEBHOOK_SECRET` and `UF_STATUS_TOKEN` exported, and a
  `uv` planted in a scratch directory standing second on `UF_AGENT_PATH`, where
  `/home/node/pytools/bin` sits. At 50d60d8 `uv_as_agent tool list` ran the
  planted copy, which listed all five variables in its environment. On this
  branch it ran `/usr/local/bin/uv` (`No tools installed`), and a child of
  `uv_as_agent run --no-project` reading that uv's `/proc` entry found its
  executable `/usr/local/bin/uv` and its environment exactly `HOME PATH
  UV_PYTHON_INSTALL_DIR UV_PYTHON_PREFERENCE UV_TOOL_BIN_DIR UV_TOOL_DIR`.
  The new `deployment.test.ts` block failed against 50d60d8 on lines 179 and
  255 and passes here. Caveat: no `setpriv` actually switched uid, no boot ran
  it as root, and `gh_as_agent`'s environment was read off the text only (see
  below).

- **What the chat child runs by name resolves on root's `PATH`, 2026-10-06.**
  Board task `6f85c72a`. `cliPath.test.ts` plants `git` and `node` in a
  scratch directory first on `UF_AGENT_PATH`, puts a `git` that writes a
  marker in one on the server's `PATH`, and spawns `/bin/sh -c git` and an
  `#!/usr/bin/env node` script with `chatEnv()`. Run against a build of this
  branch with `chatEnv`'s `PATH: chatPath()` removed from the compiled
  `chat.js`, which is `chatEnv` as it was, both cases failed because the
  planted `git` and `node` ran. With it, all 14 of the file's cases passed.
  Caveat: one process as uid 1000 with no `setgid`, so this shows what the
  child resolves and not that a booted chat turn holds `UF_CHAT_GID` while it
  does (see below).

## Not yet verified by hand

- **No image carrying `UF_AGENT_PATH` has been built or booted.** There is no
  Docker where board tasks `aff25da4` and `76b451aa` were done. Unmeasured:
  that the server, the Discord relay and the applier start with root's `PATH`
  and no stack variable; that a work cycle gets `UF_AGENT_PATH`'s value and a
  stack's `env`; that Settings → Tools reads no installed stack or
  `UF_PY_TOOLS` entry newly `missing` or `shadowed`; and that `uv_as_agent`'s
  installs no longer warn that their bin directory is off `PATH`. Settle:
  `docker compose up --build` with the operator's `./stacks`, then
  `docker compose exec usagefoundry sh -c 'srv=$(cut -d" " -f1 /proc/1/task/1/children); tr "\0" "\n" < /proc/$srv/environ | grep -E "^(PATH|UF_AGENT_PATH|PIP_REQUIRE_VIRTUALENV)="'`
  (expect root's `PATH`, `UF_AGENT_PATH` set, no `PIP_REQUIRE_VIRTUALENV`);
  a run asked to execute `echo "$PATH"; env | grep PIP_REQUIRE_VIRTUALENV; go version`
  (expect `/var/lib/uf-stacks/bin` first, the variable present, Go answering);
  Settings → Tools (expect every row as before); and
  `docker compose logs usagefoundry | grep 'not on your PATH'` (expect nothing).

- **No root boot has spawned through the resolved paths.** Unmeasured: that a
  booted image logs no `CLAUDE_BIN` or `CODEX_BIN` warning, and that a work
  cycle, a chat turn and a Codex sign-in each start under the uid drop with the
  absolute command. Settle: `docker compose up --build`, then
  `docker compose logs usagefoundry | grep -E 'CLAUDE_BIN|CODEX_BIN'` (expect
  nothing); start a run, a chat turn and a Codex sign-in, and while they are
  alive read `docker compose exec usagefoundry ps -eo user,args | grep -E '/usr/local/bin/(claude|codex)'`
  (expect the agents' user on every line, each `claude` child starting
  `/usr/local/bin/claude`, the sign-in starting
  `/usr/local/bin/node /usr/local/bin/codex`).

- **No booted image has run the boot's dropped `uv` or `gh`.** Unmeasured:
  that a boot with `UF_AGENT_UID` and `UF_PY_TOOLS` set ignores a `uv` an agent
  left in the pytools volume and hands the real one no credential, and that
  `UF_PY_TOOLS` and `UF_GH_EXTENSIONS` still install with the environment cut
  to the allowlist. Settle on a host with compose:
  `docker compose exec -u "$UF_UID" usagefoundry sh -c 'printf "#!/bin/sh\nenv > /tmp/uv-env\nexec /usr/local/bin/uv \"\$@\"\n" > /home/node/pytools/bin/uv; chmod +x /home/node/pytools/bin/uv'`,
  then `docker compose restart`, then
  `docker compose exec usagefoundry sh -c 'test -e /tmp/uv-env && grep -c UF_AUTH_TOKEN /tmp/uv-env || echo not-run'`
  (expect `not-run`), and
  `docker compose logs usagefoundry | grep -E 'installed (Python tool|gh extension)|could not install'`
  (expect each entry installed or skipped as before). Remove the planted file
  afterwards.

- **No booted chat turn has run with `chatPath()`.** Unmeasured: that a chat
  turn in a booted image gets `/var/lib/uf-stacks/bin` first and no
  `/home/node/pytools/bin`, and that a stack's tool still resolves there.
  Settle: `docker compose up --build`, then ask a chat turn to run
  `echo "$PATH"; command -v git` (expect the toolbox first, no
  `/home/node/pytools/bin`, `/usr/bin/git`), and, with a `uv-tool` stack and a
  `UF_PY_TOOLS` entry both installed, `command -v <each>` (expect the stack's
  under `/var/lib/uf-stacks/bin` and nothing for the `UF_PY_TOOLS` one).
