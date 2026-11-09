# Verification: Security and sandboxing — what a reviewer, validator or resolver may read

[← Verification index](../verification.md)

Started on 2026-11-09 under board task `a73d9d8a`, from the `097ca029` entries in
`security-and-sandboxing-project-config-discovery.md`. Unless an entry says
otherwise the harness is this one. The compiled modules of this branch run in a
scratch process under `env -i`, with a scratch `DATA_DIR`, `HOME` and
`CLAUDE_CONFIG_DIR`. A validator is started through `startAssist` with
`kind: "validate"` under `plan`, a resolver with `kind: "resolve"` under
`acceptEdits`, and a reviewer through `startReview` over a run row with
`isolation`, `work_dir`, `worktree_branch` and `worktree_base` set, so that
`reviewCwd` picks the worktree. `CLAUDE_BIN` is a wrapper around the linux-arm64
`/usr/local/bin/claude` (2.1.319) that records the argv and cwd, and that can
merge a JSON object into the last `--settings`. A loopback stub with a fake key
answers the main turn with a fixed list of tool calls, then a verdict. The
scratch install holds a repository with a `git worktree add` whose branch commits
`CHANGED.md`, a second repository on the same mount, and two directories beside
the mount. Each holds a marker string. uid 1000, nested in an agent's sandbox.
"Managed sandbox" means this container's `/etc/claude-code/managed-settings.json`,
the policy `docker-entrypoint.sh` writes under `UF_SANDBOX`; "stock" means the
same run inside `unshare -rm`, with a tmpfs over `/etc/claude-code`, then a nested
`unshare --user --map-user=1000` back to uid 1000.

## Verified

- **A reviewer under `plan` reads outside its checkout as the validator does,
  on 2.1.319, 2026-11-09.** Through `startReview`, cwd the run's worktree, with
  nothing planted under `.claude/`. A `Read` of a file in each directory beside
  the mount and in the other repository, a `Grep` and a `Glob` of those
  directories, and a `Read` of `../../other/secret3.txt` all returned the
  file's marker. So did the `.git/HEAD` of the main checkout. The validator in
  the same worktree did the same, which reproduces the `097ca029` measurement.
  Caveat: no instruction was planted in a diff; the stub chose the calls.

- **The reach holds under the managed sandbox and on a stock install, same pin
  and day.** Under the managed sandbox the app read the policy as on and put
  `sandbox.filesystem.allowWrite` (the scratch `CLAUDE_CONFIG_DIR` and `/tmp`)
  on both plan-mode assists' `--settings`. Stock, it emitted no `sandbox` key.
  The validator and the reviewer read all five targets either way. Caveat: the
  server as root with the uid drop was not run.

- **The resolver is refused the three `Read`s and the relative one, and not the
  `Grep` and `Glob`, same pin and day.** Under `acceptEdits` each `Read` came
  back "Claude requested permissions to read from …, but you haven't granted it
  yet". The `Grep` and `Glob` of the outside directories returned their
  markers. `--allowedTools` names both on every assist.

- **A `sandbox.filesystem.denyRead` on the assist's `--settings` refuses no
  file-tool read, same pin and day.** The wrapper added the three directories as
  `denyRead` beside the write set under the managed sandbox. The validator's
  `Read`s, `Grep` and `Glob` of them all returned their markers.

- **`permissions.blockReadsOutsideWorkingDirectories: true` on the assist's
  `--settings` refuses every one of those reads, same pin and day.** First added
  by the wrapper, then built from this branch with the wrapper passing the argv
  through. The validator and the reviewer, under the managed sandbox and stock,
  were refused all five targets and `.git/HEAD` with "<path> is outside <cwd>;
  the permissions.blockReadsOutsideWorkingDirectories …". `README.md` and
  `CHANGED.md` in the worktree still read, and so did a `Grep` and a `Glob` there.
  A validator in the main checkout read its `README.md`. One in a subdirectory of
  the main checkout was refused that same file as outside. The built resolver
  carried no `permissions` key and behaved as in the entry above. With the
  wrapper adding the setting to the resolver, it was refused all of them too.

- **`Bash` under the setting, same pin and day.** A plan-mode validator's
  `git log --oneline -2` in the worktree returned both commits stock, with the
  setting and without. Under the managed sandbox it returned them with the
  setting on the third attempt. The others died on the nested-bwrap
  `/proc/<n>/ns/ns` error, and the control did not get through in 14. A `cat` of
  the outside file was refused "Reads outside the working directories are
  blocked (permissions.blockReadsOutsideWorkingDirectories)". Without the
  setting the same `cat` was refused "Auto mode is unavailable: its safety check
  does not run for this session". A `bwrap` shim on the child's `PATH` showed
  what the setting adds: a `--tmpfs` over `/home`, `/media`, `/mnt`, `/root`,
  `/srv` and the scratch `$HOME`, with the binds inside `$HOME` dropped.

- **The CLI's spilled tool output stays readable under the setting, same pin
  and day.** Stock, a validator's `seq 1 120000` was saved under the scratch
  `CLAUDE_CONFIG_DIR`'s `projects/<key>/<session>/tool-results/`. A `Read` of
  that path with an `offset` and a `limit` returned lines 100 to 102.

- **What this install's assists read outside their cwd, from transcripts read
  2026-11-09.** Over `~/.claude/projects/*/*.jsonl`, sessions were classified by
  their first prompt's opening line. 569 validator sessions, 2026-10-13 to
  2026-11-09, made 56 `Read`/`Grep`/`Glob` calls and 91 `Bash` calls. No file-tool
  call was outside the session's cwd, and no `Bash` command named an absolute
  path outside it. The one reviewer session, 2026-10-16, made 10 `Read`s of `/tmp`
  files its own `Bash` had written. The 31 resolver sessions made 2 `Grep`s
  outside the cwd, one of `/workspace` and one of a file in the main checkout.
  Caveat: the outside categories were matched by path, and a session whose
  first message was something else was not counted.

- **A plan-mode reviewer on this install ran writing `Bash` commands under the
  managed sandbox, from its transcript read 2026-11-09.** The 2026-10-16
  reviewer session above carries `permissionMode: plan` and opens with the
  reviewer prompt. All 16 of its `Bash` calls returned without `is_error`,
  among them `npx tsc`, `node --test`, `git archive | tar -x` and redirections
  into `/tmp/claude-1000/`, which later calls read back. One result carried the
  sandbox proxy's denial of `registry.npmjs.org:443`. Caveat: the files were
  not checked on disk, and no write into its checkout was attempted.

## Not yet verified by hand

- **The server as root, dropping the child to the agent uid.** Every case above
  ran as uid 1000. Settle: on the operator's install, as root with `UF_SANDBOX=1`,
  run the validator case through the rig's driver with the server's
  `childCredentials` in force. The `Read` of a file in another repository on
  the mount must come back refused as outside, and one in the worktree must
  return.

- **No assist started by a running server has been seen carrying the setting.**
  Settle: on a scratch install, finish an isolated run, press Review, and let a
  run close a task so a validator starts. Each child's `--settings` in
  `/proc/<pid>/cmdline` must hold `"permissions":{"blockReadsOutsideWorkingDirectories":true}`,
  and a conflict resolution's must not.

- **A `Bash` command whose path the CLI cannot read, against a real API.** The
  stub runs no safety check, so a plan-mode `Bash` call the setting does not
  catch was refused for that reason alone. Settle: with a real login, have a
  validator run `cat "$(printf %s /workspace/<other repo>)/<file>"`, and record
  whether it runs, with the setting and without it.
