# Verification: Security and sandboxing — what a Codex cycle loads from its checkout's `.codex/config.toml`

[← Verification index](../verification.md)

Started beside `security-and-sandboxing-codex-config.md` on 2026-11-09, when
board tasks `1eff0ac8` and `786dd327` would have taken that file past 20 KB.
It keeps what `$CODEX_HOME/config.toml` does to the server's Codex children
and the two entries this one builds on: every `workspace-write` or bypass
cycle writes a trust entry into that file, and with the write failing a cycle
loads its repository's `.codex/config.toml`. The harness is the same: a
scratch `CODEX_HOME` under `$TMPDIR` with a made-up API key, the spawn
environment's proxy at a closed or logging loopback port with
`NO_PROXY=127.0.0.1`, and the real `/home/node/.codex` never opened.

## Verified

- **A directory, FIFO or link to a directory at `config.toml` fails every
  sign-in child and not `app-server`, 2026-11-09.** Board task `1eff0ac8`,
  codex-cli 0.153.4, the two sign-in pins on. Over a directory, `login status`,
  `logout`, `login --with-api-key` and `login --device-auth` each exited 1 with
  `Error loading configuration: Failed to read config file …: path … is not a
  file`; `login status` answered the same over a FIFO and a link to a
  directory, and over a dangling link answered as with no file. `app-server`
  over a directory logged `Invalid configuration; using defaults` and answered
  `initialize`, `account/read` and `model/list` (6 models) as it did with no
  file. With its nine `-c` pins it made no connection at a logging proxy
  either way; without them it made the same four CONNECTs either way, to
  `api.github.com`, `github.com` and `chatgpt.com` twice, so the pins survive
  "using defaults". The board task had inferred that `app-server` would fail,
  so `codexAccount.ts` is the one Codex child left unchecked. Caveat: one run
  per cell, a fake key.

- **The guard refuses a Codex cycle over a `config.toml` that is not a regular
  file, and the sign-in children name it without starting, 2026-11-09.** Board
  task `1eff0ac8`. `codexConfigUnusableBecause`, called from
  `prepareCodexRules` and `ensureCodexHome`. Four `codexRules.test.ts` cases
  failed on the code before and pass after: a directory without a uid split,
  and under one a directory, a link to a file, to a directory or to nothing,
  and a FIFO. The two controls passed both times: absent or a regular file
  under the split, and a link to a file followed without it. So did the
  `codexAuth.test.ts` case, where status, both sign-ins and the sign-out
  started no child and named the path. Following links under the split, or
  never following them, each failed one case (mutation of the compiled
  module). The entrypoint's new block, extracted and run under `dash` against
  a scratch directory, renamed a directory, a FIFO, a link to a file or a
  directory and a dangling link to `config.toml.moved-aside.<epoch>`, leaving
  the link's target as it was. It left a regular file and an absent name
  alone. A directory with links planted at the next four seconds' names stayed
  in place behind the warning, with nothing moved into the target (board task
  `d7c19b38`). Two `deployment.test.ts` cases run the block the same way under
  `sh`. The move-aside case failed before the change, and the planted-link case
  failed with `-T` dropped. Caveat: not as root and not in a booted container; the run
  loop's refusal was not driven, only `prepareCodexRules`.

- **A regular `config.toml` the cycle cannot parse or read also makes it load
  its repository's `.codex/config.toml`, 2026-11-09.** Board task `1eff0ac8`,
  the app's whole argv from `buildCodexArgs` with `-C`, a working directory
  whose `.codex/config.toml` named an MCP server appending to a marker. A
  valid file: 0 of 3 started, and the trust entry was appended. A directory: 3
  of 3. `[[[ not toml`: 3 of 3, the file left unchanged. The cycle's own file
  at mode 0000: 3 of 3. Every run reached `turn.started` and none said
  anything. Over the last two, `login status` exited 1 with `Error loading
  configuration: …:1:3: unquoted keys cannot be empty…` and `… Permission
  denied (os error 13)`; `app-server` sent `configWarning` and answered. The
  guard passes both, being regular files: board task `93f1c142`. Caveat: run as
  the file's owner rather than a second uid; one version, a fake key.

- **Entries a cycle plants at the clock-stamped aside names no longer stop
  the boot's repair, 2026-11-09.** Board task `d7c19b38`. The entrypoint's
  `CODEX_HOME` block, extracted and run under `dash` and under `bash` against
  a scratch home with a directory at `config.toml`, a file at `rules`, and a
  link and a non-empty directory planted at each `<name>.moved-aside.<epoch>`
  for the next 120 seconds of the real clock. Before the change both repairs
  failed, the boot printing the `config.toml` warning and the `rules`
  refusal. After it both moved, each into a `.moved-aside.XXXXXX` directory
  `mktemp -d` made at 0700, and nothing went through a planted link. The
  `deployment.test.ts` cases for each name, with `date` stubbed, failed before
  and pass after. Caveat: not as root, not in a container, so that the later
  boots' chown loop skips root's aside directory is read from its `0:*` case.

- **TokenEconomizer's Codex tool pruning, written into a repository's
  `.codex/config.toml`, removes no tool from a Codex work cycle, 2026-11-09.**
  Board task `786dd327`, codex-cli 0.153.4. The keys are
  `/opt/tokeneconomizer/tokeneconomizer/plugin/denylist.py:62-67`'s:
  `[features] view_image`, `goals` and `multi_agent = false`, `[agents]
  enabled = false` and `include_collaboration_mode_instructions = false`. Each
  cycle ran the argv above plus `-c openai_base_url` at a loopback stub, which
  logged the request and answered 400; `OPENAI_BASE_URL` in the environment was
  ignored. The tools are an `additional_tools` input item, not a top-level
  `tools`. With no `.codex/` the request carried 20 tools, among them
  `view_image`, the three goal tools and six `collaboration.*` tools. With the
  file in the repository it carried all 20 in 3 of 3 runs, and in 3 of 3 more
  over a home already holding `trust_level = "trusted"` for the directory. The
  same keys as `-c`, or the file with a directory at `$CODEX_HOME/config.toml`,
  dropped exactly those 10 tools, 3 of 3 each, so the keys are right. Caveat:
  the request was read, not a model's behaviour; one model (`gpt-6-astra`); a
  fresh home per run.

## Not yet verified by hand

- **The agent uid's `rm` and `mkdir` at `config.toml` in a booted container,
  and what the guard answers there.** Every case above ran as one uid on a
  scratch directory; that the agent uid can do it in `/home/node/.codex`
  (root:node 1770, file node:node 0600) is read from `stat`, not run. Board
  task `9dd37c12` is a different measurement, root's file. Settle in a booted
  container: `docker compose exec -u node usagefoundry sh -c 'cd
  /home/node/.codex && mv config.toml config.toml.mine; mkdir config.toml'`.
  Expect a Codex run's next cycle to be refused with `Refusing to spawn a Codex
  work cycle: /home/node/.codex/config.toml is a directory…`, and Settings →
  Codex to show the same sentence. Then `docker compose restart usagefoundry`,
  expect the boot log's `was not a file; moved it to …` and the next cycle to
  run, and move `config.toml.mine` back.
