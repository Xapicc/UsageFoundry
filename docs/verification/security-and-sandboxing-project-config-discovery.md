# Verification: Security and sandboxing — what a work cycle loads from directories that are not its own

[← Verification index](../verification.md)

Started on 2026-11-09 under board task `687b0d2f`, beside
`security-and-sandboxing-file-tool-writes.md`, whose "Where else the CLI found
`.claude/` content" entry is the first observation this file builds on. Unless
an entry says otherwise the harness is the same: the linux-arm64 build at
`/usr/local/bin/claude` (2.1.319), uid 1000, nested in an agent's sandbox. It
is an uncommitted copy of `scripts/sandbox-probe/write-boundary-probe.mjs`
against a loopback stub API with a dummy key, with a scratch `HOME` and
`CLAUDE_CONFIG_DIR` under `$TMPDIR`, a repository and a `git worktree add` of
it, and the argv shape `buildArgs` emits for an isolated run under
`bypassPermissions`, with `blockWritesOutsideWorkingDirectories` on. Each case
is one run. A marker counts as shown when it is in the body of a request the
model was sent.

## Verified

- **A linked worktree is offered its main checkout's untracked skills, agents
  and commands, one directory name at a time, on 2.1.319, 2026-11-09.** The
  main checkout held, untracked, a skill, an agent, a command, a `CLAUDE.md`
  and a `CLAUDE.local.md`, and there was a skill in `.uf-worktrees/.claude/`
  and one in the mount's `.claude/`. A worktree with nothing committed under
  `.claude/` was shown the main checkout's skill, agent and command in its
  first request, and its `init` event listed all three. With its own
  `.claude/skills/` committed on its branch only, it was shown its own skill
  and not the main checkout's, and still the main checkout's agent and
  command. With its own skills, agents and commands committed, it was shown
  only its own. No case was shown the main checkout's `CLAUDE.md` or
  `CLAUDE.local.md`, or either skill above the worktree. Caveat: whether the
  model would have invoked a planted skill was not driven.

- **The main checkout's untracked `.claude/settings.local.json` applies in a
  linked worktree, and its hook runs, same pin and day.** Its `language` reached
  the request. When the worktree's own `settings.local.json` also set
  `language`, the main checkout's reached the request and the worktree's did
  not. With the main checkout's file absent or 0 bytes, the worktree's own
  applied. A `SessionStart` hook in it, `echo <marker>; touch
  "$TMPDIR/<file>"`, created its file and put its output in the first request.
  Under `acceptEdits`, its `permissions.allow` entry for `Read` of a directory
  outside the working directories let the worktree run read a file there. The
  control without the entry was refused that read as "you haven't granted it
  yet". The main checkout's untracked `settings.json`, with a `language` and
  the same hook, did neither.

- **`--project-config-root <worktree>` keeps all of that out and keeps the
  worktree's own, same pin and day.** With the flag, a worktree with nothing
  committed was shown none of the main checkout's skill, agent and command, and
  one with all three committed was shown its own three. The main checkout's
  `settings.local.json` applied neither its `language` nor its hook, whose file
  was not created, nor its `Read` allow, and that read was refused as
  ungranted. The worktree's own `settings.local.json` applied, with or without
  a main-checkout one beside it. Its committed `settings.json` applied its
  `language` and ran its hook, as it did without the flag. Three of these
  cases, the skills, the hook and its control, were repeated on this
  container's virtiofs mount (`fuseblk`, under
  `/workspace/.uf-worktrees/<this checkout>/`) with the same results, so the
  CLI's refusal of a "network location" did not fire there.

- **What else the flag changed, same pin and day.** The tool list was the same
  12 tools. The auto-memory path in the request still used the main
  checkout's project key, and the session's transcript still went under the
  worktree's key. The first requests of a worktree with and without the flag
  differed only in the session ids, the commit hashes the two scratch
  repositories got, and the sandbox section's deny list. That list lost the main
  checkout's `settings.local.json` and `.cc-writes` and gained the worktree's
  `settings.local.json`. A session started without the flag and resumed with
  it exited 0 and sent five messages in the resumed cycle's last request, and
  one started and resumed with it sent four, against the one a fresh session
  sends. A skill in a subdirectory's `.claude/skills/` was not shown after a
  `Write` and a `Read` in that subdirectory, with or without the flag. Caveat:
  `--routine`, durable scheduled tasks and project-scope MCP changes, which the
  CLI's own text says the flag refuses, were not exercised.

- **A run on a plain folder is offered its ancestors' `.claude/`, and the flag
  does not stop it, same pin and day.** A cwd in no git repository, two levels
  below the mount, was shown its own skill and the skills, agents and commands
  in its parent's `.claude/` and in the mount's, and the mount's `CLAUDE.md`.
  With `--project-config-root <cwd>` it was shown exactly the same.

- **A run on the main checkout can plant `.claude/` content there with the
  file tools under `bypassPermissions`, same pin and day.** `Write` created
  `.claude/skills/x/SKILL.md`, `.claude/agents/x.md`,
  `.claude/commands/x.md` and `CLAUDE.md` in the run's own checkout with the
  setting on. Under `acceptEdits` the three `.claude/` writes were refused as
  ungranted. `Bash` was not driven.

- **`write-boundary-probe.mjs` as committed under `687b0d2f` holds with the
  flag, same pin and day.** The main checkout now holds an untracked skill,
  agent, command and a `settings.local.json` `SessionStart` hook, and every
  worktree turn carries `--project-config-root`. In turns 1 to 7, none of the
  four reached any worktree run, and every other check held. In turn 10c,
  without the flag, all four did. In turn 5 the vault's writer, in a worktree
  under the vault's `.uf-worktrees/`, was no longer shown the vault's planted
  skill and agent, and still wrote into its worktree and the vault. Turn 8's
  `Bash` steps went unanswered, nested, as before.

## Not yet verified by hand

- **No app-spawned isolated cycle has been seen carrying the flag.** Settle:
  on a scratch install, plant an untracked `.claude/skills/x/SKILL.md` and a
  `settings.local.json` `SessionStart` hook that touches a file in the main
  checkout of a scratch repository, then start a cheap isolated run of it. Its
  spawn argv must carry `--project-config-root <its worktree>`, the hook's file
  must not appear, and the cycle's `init` event must not list `x`.

- **The reviewer, resolver and validator in a run's worktree are presumably
  still shown the main checkout's `.claude/`.** `spawnAssist` passes no
  `--project-config-root` (board task `097ca029`). Settle: the first entry's main-checkout plant, then
  a validator started on a run in a worktree of that repository. Its first
  request is read for the skill, agent and command markers and for a
  `settings.local.json` `language`.

- **Where the plain-folder walk stops above the mount.** By the binary's
  reading it stops at `$HOME` and at a git root. Only the git root was
  measured. Settle: a plain folder below `$HOME` with a skill planted in
  `$HOME/.claude/skills/` (the user scope) and one in `$HOME/x/.claude/skills/`.
