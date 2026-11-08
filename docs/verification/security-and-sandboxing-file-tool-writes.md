# Verification: Security and sandboxing: the file tools' write boundary

[← Verification index](../verification.md)

## Verified

- **`permissions.blockWritesOutsideWorkingDirectories` from a cycle's
  `--settings` refuses file-tool writes outside the working directories under
  `bypassPermissions` and `acceptEdits`, on 2.1.319, 2026-11-08.** The
  linux-arm64 build at `/usr/local/bin/claude`, run as uid 1000 inside this
  container. Driven by `scripts/sandbox-probe/write-boundary-probe.mjs` against
  a loopback stub API with a dummy key and a scratch `HOME` and
  `CLAUDE_CONFIG_DIR`, in the shape of argv `buildArgs` emits for an isolated
  run whose cwd is a real `git worktree` of a scratch repository. The control
  had the setting off: every write below landed. With the setting on,
  `Write`, `Edit` and `NotebookEdit` into the main checkout were refused, and
  so were a `Write` spelled through `..` and one through a symlink inside the
  worktree pointing at the main checkout. Writes into the repository's `.git`,
  another repository, `CLAUDE_CONFIG_DIR` (its `settings.json` included), the
  child's `$TMPDIR`, the CLI's per-uid temp root under it, and a literal
  `/tmp/<name>` were refused too. Writes in the worktree landed, `package.json`
  included. Each refusal reached the model as an `is_error` tool result of the
  form `<path> is outside <working directories>; the
  permissions.blockWritesOutsideWorkingDirectories setting blocks writes
  outside the working directories…`, or for the link, `… resolves through a
  symlink to <real path>, which is outside …`. Caveat: the stub API, and the
  probe's argv rather than one built by `runIteration`.

- **What counts as a working directory, and what the setting exempts, on
  2.1.319, 2026-11-08.** Same probe. The cwd and each `--add-dir` counted: a
  vault writer's `Write` into the vault through its `--add-dir` landed with the
  setting on. So did each `permissions.additionalDirectories` entry in the same
  overlay: with the child's temporary directory named there, writes to it and
  to the per-uid root under it landed, while the main checkout, another
  repository and a literal `/tmp` path outside it stayed refused. The sandbox
  write set did not count. Exempt: a write to this project's auto-memory under
  `CLAUDE_CONFIG_DIR/projects/<key>/memory/` landed, for the worktree's key and
  for the main checkout's. Not exempt: a file under `CLAUDE_CONFIG_DIR/plans/`
  whose name the CLI had not chosen. No scratchpad path was offered to a `-p`
  session, and neither `EnterWorktree` nor `ExitWorktree` was on offer with the
  setting on or off. Caveat: the CLI's own plan file and a session with a
  scratchpad were not exercised.

- **An `--add-dir` loads the skills and agents in that directory's `.claude/`,
  and `permissions.additionalDirectories` does not, on 2.1.319, 2026-11-08.**
  Same probe. A `SKILL.md` and an agent file were planted in the temporary
  directory's `.claude/skills/` and `.claude/agents/`, each with a marker in its
  name and description, and a `CLAUDE.md` beside them. Given as `--add-dir`,
  the skill's and the agent's markers were in the first request the model was
  sent and the `CLAUDE.md`'s was not. Given as `additionalDirectories`, none of
  the three was. Both made the directory a working directory, and both put it
  in the "Additional working directories" list of the environment section in
  the request's first user message. Caveat: the markers were looked for in the
  request body, and whether the model could have invoked the skill was not
  driven.

- **`true` in the cycle's `--settings` holds against the checkout's own
  settings, on 2.1.319, 2026-11-08.** Same probe. With the overlay's `true` and
  `"blockWritesOutsideWorkingDirectories": false` in the worktree's
  `.claude/settings.json`, a `Write` into the main checkout was refused. The
  setting given only in that file refused it too. With the setting on, a
  `Write` to the worktree's own `.claude/settings.json` was refused with
  `Writes to Claude Code settings files are blocked while
  permissions.blockWritesOutsideWorkingDirectories is on…`. Caveat: managed
  settings were not tried, because the overlay was honoured and this container's
  `/etc/claude-code/managed-settings.json` is not writable from a work cycle.

- **The setting breaks one write path real runs use, and it is the temporary
  directory, measured 2026-11-08 over this container's transcripts.** Every
  `Write`, `Edit` and `NotebookEdit` call in the `-workspace*` project
  directories of `~/.claude/projects`, 2026-10-10 to 2026-11-08, classified
  against each session's starting cwd: 3,576 calls in 561 sessions. 3,137
  were inside the starting directory, 153 to auto-memory, 282 under
  `/tmp/claude-1000/` and 1 elsewhere in `/tmp`, and 3 had no path. None wrote
  a settings file. The 283 temporary-directory writes came from 164 of the 561
  sessions. Caveat: the population is every session in those directories,
  sub-agents included, not only app-spawned work cycles, and a session that
  never wrote with the file tools is not in it.

## Not yet verified by hand

- **No work cycle spawned by the app has been seen refused.** The probe
  drove the real CLI with `buildArgs`' shape of argv, not `runIteration`, and
  the darwin build was not run. Settle: on a scratch install, start a cheap
  isolated run whose prompt asks it to `Write` a file into the main checkout's
  root and another into `$TMPDIR`. The first must come back as the setting's
  tool error and leave no file, and the second must land.

- **`Bash` under the setting was not observed.** Nested in this agent's
  sandbox, the probe's two `Bash` steps went unanswered within 90 s, so the
  claim that the setting leaves shell commands to bwrap rests on the CLI's
  schema text. Settle: run the probe's turn 8 unnested in a booted container
  (`PROBE_TURN=8 node scripts/sandbox-probe/write-boundary-probe.mjs` as the
  agents' uid). `touch` into the repository's `.git` should land and `touch`
  into the main checkout should fail with `Read-only file system`.

- **The cold prefix on a resumed run is inferred, not measured.** The working
  directories ride the first user message of every request, so a run whose
  session spans the change most likely re-reads its context once at full price.
  Settle: compare `cache_read_input_tokens` on the first cycle after the change
  of a run resumed across it with that run's previous cycle.

- **Reads under `acceptEdits` were not re-measured.** With the setting off, an
  `acceptEdits` session in `-p` was refused a `Read` of the main checkout as an
  ungranted permission. Making the temporary directory a working directory
  presumably lets such a run `Read` its own scratch there, which was not
  checked either way.
