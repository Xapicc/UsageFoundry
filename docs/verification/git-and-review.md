# Verification: Git and review

[← Verification index](../verification.md)

## Verified

- **Diff and land parsers, `npm test` 24 assertions:** NUL-separated numstat
  and name-status incl. renames and tabs, patch splitting that ignores `diff
  --git` inside a hunk, `merge-tree` on an old git, every `landRefusal` branch.

- **GitHub credential block, real git 2.39.5:** `credential fill` returns the
  token past a repo-configured missing helper (`osxkeychain`), SSH GitHub
  remotes rewrite to HTTPS, and `gitlab.com` fails without prompting. Six
  `npm test` assertions.

- **git 2.39.5 formats behind Delete and Purge:** `status --porcelain -z`
  needs its leading space, so `.trim()` drops an unstaged file (hence `trim:
  false`); `worktree remove` needs `--force` on a dirty checkout, and `branch
  -d` refuses an unmerged branch where `-D` deletes it.

- **`core.excludesFile` via `GIT_CONFIG_*` lets `git add -A` pass the bound
  dotfiles, 2026-09-09.** git 2.39.5: exit 0, none staged, a nested
  `.gitconfig` still staged; `agentGitEnv` keeps the GitHub pairs in the same
  block. Only the `os.tmpdir()` path was written; 2590 tests pass.

- **Delivery opened a real pull request, 2026-09-06**, the app's first:
  throwaway `Xapicc/uf-deliver-smoke`, branch unpushed, seeded worktree run,
  `UF_GITHUB_TOKEN`. The app pushed and opened #1 `uf/deliver-smoke` → `main`;
  it refused a non-GitHub remote with no credential, and a second request, 400.

- **The Land card over a branch that moved after its pull request, and over one
  under a resolution, 2026-10-20 (git 2.39.5, the standalone build).** Five runs
  seeded into a scratch `DATA_DIR` from the compiled test build. Behind its
  pull request the card read "Opened … — pull request #41, behind this branch"
  and offered "Push to pull request #41", its sentence naming #41 and "No second
  one is opened"; at the pushed tip, "Delivered …" and no button; undelivered
  under a `running` resolve row, no "Open pull request" and the refusal under
  the buttons (`GET /api/runs/<id>/land`: `branchResolving` true,
  `delivery.possible` false); delivered, behind and resolving, the link and the
  refusal and no push. Caveat: nothing was pressed (the press is
  `deliverRun.test.ts`', on a local bare repository), and boot reconciliation
  fails a seeded `running` row, so it was set after the server was up.

- **Review and conflict-resolution spawn, flags, JSON shape and accounting**,
  with a stub `result`; a bad conflict resolution cannot be committed.

- **The Files tab's touched/changed scan returns what the design claims, on
  real SQLite** (in-memory `better-sqlite3`, ten hand-written tool payloads, a
  throwaway script): worktree and checkout paths collapse to one row, `/tmp`
  counts as outside, a command-only `Bash` and a directory `Grep` are excluded.
  `runTouches.test.ts` covers only the pure reconciliation, nine cases.

- **A type change no longer blanks every patch, 2026-09-27, git 2.39.5.** `rm
  f; ln -s g f; echo y >> g` gives 3 numstat entries and 4 `diff --git`
  chunks, `f`'s two under one header; the real `runDiff` (orchestrator, config
  and privsep stubbed) now returns all three patches. Scratch repository only.

- **The byte budget keeps the small file's patch, 2026-09-27, git 2.39.5.**
  Through the real `runDiff`: a 4.2 MB one-line `dist.min.js` beside a
  one-line `small.ts` edit gives `small.ts` its patch and `omittedPatches: 1`.
  2.1M blank lines beside `small.ts` overflowed the read when charged the file
  alone, reported as `patchFailure`; the per-line marker charge leaves them out.

- **After a merge of the target the diff is the run's own, 2026-09-27, git
  2.39.5.** One run commit, one unrelated `main` commit, `main` merged into the
  branch: 4 files +6 −2 from the base, `run.txt +2` and `shared +1 −1` from
  `measuredFrom.commit`. A later merge of another branch keeps it at the base.

- **The card's new sentences render, 2026-09-27**, standalone build, a seeded
  run that failed at the spawn, `/api/runs/<id>/diff` answered by Playwright
  with a `measuredFrom` and a `patchFailure` payload: hint, both notices and
  the row sentence paint, no console error. 1280px only; not a server's diff.

- **A repository's own `core.fsmonitor` and `core.hooksPath` outrank global
  ones, and only `-c` or `GIT_CONFIG_*` outranks them, 2026-10-06, git
  2.39.5.** Board task `9d74a9ef`. A scratch repository whose `.git/config`
  named a marker as `core.fsmonitor`, and whose `.git/hooks/post-checkout`
  wrote another, with a scratch `HOME` and `GIT_CONFIG_NOSYSTEM=1`. With a
  global `core.fsmonitor false`, `git status` still ran the repository's
  fsmonitor. It did not run under `-c core.fsmonitor=false`, `-c
  core.fsmonitor=`, a `GIT_CONFIG_COUNT` pair or `GIT_CONFIG_PARAMETERS`. A
  global `core.hooksPath=/dev/null` stopped `.git/hooks/post-checkout` on
  `checkout -b`, and stopped nothing once the repository set a
  `core.hooksPath` of its own. `-c core.hooksPath=/dev/null` stopped both.
  Caveat: this was the container's git as uid 1000, not a host's git (see
  below).

- **Reading a repository's own configuration, hooks and attributes runs none
  of them, 2026-10-06, git 2.39.5.** The same repository also had a
  `filter.x.clean` under `* filter=x` in `.git/info/attributes`, an
  `include.path` naming a second file under `.git` that set
  `core.sshCommand`, and `extensions.worktreeConfig` with a
  `diff.external` in `.git/config.worktree`. `git config --list --show-scope
  --show-origin`, `ls .git/hooks` and `cat .git/info/attributes` wrote no
  marker. The first listed every planted key on a `local` or `worktree` line
  naming its file, the included one under `file:.git/evil.inc`. A plain
  `git status` afterwards ran the filter and the fsmonitor.

- **A run's end reports what its cycle planted in the repository's git
  directory, and the server's reads run none of it, 2026-10-07, git 2.39.5.**
  Board task `3fafd392`. Standalone build with a scratch `DATA_DIR`, booted by
  a copy of `scripts/smoke-pages.mjs`. The stub `CLAUDE_BIN` set
  `core.fsmonitor` to write a marker, wrote an executable
  `.git/hooks/post-checkout`, and replied `DONE`. An isolated run in a scratch
  repository ended `completed`, and its `gitDir.report` was `changed`. It
  listed `core.fsmonitor` added, with its value, and `post-checkout` added and
  executable, with no other runs named. A second, in-place run in the same
  repository reported `unchanged`, because the stub set the same values
  again. A run in a plain folder had `gitDir: null`. Neither the run route nor
  the runs list shipped the raw columns. No marker was written, the isolated
  run's `worktree add` included, until a plain `git status` wrote the
  fsmonitor's. Caveat: this ran as uid 1000 with no uid split, so the server's
  file reads were not root's.

- **Two runs overlapping in one repository each name the other, 2026-10-07.**
  Same harness. The stub slept 3 seconds and then set `alias.st` to a value
  carrying its pid. Two isolated runs started together both reported
  `alias.st` changed, and each listed the other. A third run, started after
  both had ended, listed none.

- **The warning renders on the run page and the Land card, 2026-10-07.**
  Standalone build and one seeded run, with `GET /api/runs/<id>` and its
  `/land` answered by Playwright. The states were `changed` (with and without
  other runs), `unreadable`, `unchanged`, and no report on a settled run, at
  390px and 1280px in the default skin. There was no console error and no
  sideways scroll, and a 180-character value wrapped. Not measured in the
  ascii skin.

- **git resolves a relative `core.hooksPath` against the root of the work
  tree it runs in, 2026-10-08, git 2.39.5.** Board task `602e9c65`. A scratch
  repository with `core.hooksPath=.husky/_` and an executable
  `.husky/_/pre-commit` writing a marker, with a scratch `HOME` and
  `GIT_CONFIG_NOSYSTEM=1`. `git commit --allow-empty` run from a subdirectory
  wrote that marker. A linked worktree given its own `.husky/_/pre-commit`
  ran that copy, not the main checkout's. A bare `hooksPath` key made git
  refuse to commit at all (`missing value for 'core.hookspath'`). An empty
  value ran neither the work tree's `pre-commit` nor `.git/hooks/pre-commit`,
  and where git looked instead was not established. Caveat: the container's
  git as uid 1000, not a host's.

- **The `core.hooksPath` rows and not-read notes render on the run page and
  the Land card, 2026-10-08.** Board task `602e9c65`, standalone build of
  `a7f84588`. One run was seeded through `POST /api/runs` against a scratch
  `DATA_DIR` and a `CLAUDE_BIN` that exits 1. Playwright then answered
  `GET /api/runs/<id>` as a completed worktree run carrying an injected
  `gitDir`, and `/land` as a fast-forward. The states were `changed` with
  hooksPath rows (`pre-commit`, a non-executable `h`, the directory itself)
  and a not-read note, `unchanged` with a not-read note, and plain
  `unchanged`. Both of the first two were drawn as warnings in the inspector
  and on the Land card, and the last as the muted line in the inspector only.
  Checked at 390px and 1280px in both skins, with no console error and no
  sideways scroll. Over a 68-character hyphen-free path, no box was wider
  than its parent once `a7f84588` added `break-all`; before it, the path ran
  past the notice. Caveat: the reports were injected, so this says nothing
  about what the server reads.

- **A planted signing program or filter driver does not run in this app's own
  git, git 2.39.5, 2026-10-17, on `9e878484` plus the fix (board task
  `9f3f9226`).** Through `git()` in a scratch repository: `commit.gpgSign` +
  `gpg.program` on `commit`, `filter.x.clean` from `.git/info/attributes` on
  `add -A` and on a stat-dirty working-tree `diff --name-only`, `filter.x.smudge`
  on `worktree add`, and a case-preserved `filter.Some.Name.clean` each left no
  marker; on the base all four plants ran, and plain git ran each of them (the
  control in `git.test.ts`). By hand: a blanked `filter.x.process` ran nothing,
  and with `filter.x.required=true` the blanked driver made `add` exit 128
  with "clean filter 'x' failed" and ran nothing. Also measured: mid-merge,
  `conflictedFiles`' `diff --name-only --diff-filter=U` ran a planted clean
  filter three times on a stat-dirty file under plain git. Caveat: as uid
  1000 in an agent worktree, not as root with the uid split on.

- **A linked worktree inside its own main worktree, the store ignored
  (2026-10-24, git 2.39.5, a scratch repository, by hand):** with
  `.uf-worktrees/` in `.gitignore` and a slot added under it, the main
  checkout's `status --porcelain` is empty and `add -A` stages nothing; `status
  --ignored` shows `!! .uf-worktrees/`; `clean -fdx` skips the slot as a
  repository and `clean -ffdx` would remove the whole store. git run in the
  store directory, or in a slot directory without `.git`, resolves to the main
  repository; with `GIT_CEILING_DIRECTORIES` naming the store the second says
  "not a git repository" while a slot and a directory inside one still resolve.
  `check-ignore -- .uf-worktrees/` answers 0 for a `/.uf-worktrees/*` rule even
  with a `!` line re-including a slot that `status` then lists, and `-c
  core.excludesFile=` drops a global excludes file and one set through
  `GIT_CONFIG_COUNT`. Caveat: never the operator's host git or the real vault;
  the ceiling and the excludes half are now in `mountRootIsolation.test.ts`.

- **A reused slot's `status` and `checkout -b` ran under `git()`'s 20 s and
  failed with an empty reason, 2026-10-25**, git 2.39.5, scratch repositories
  under `$TMPDIR` on `a9b61621`, `checkoutGitClock.test.ts` built into its
  own `--outDir`: a `GIT_BIN` stub hanging the reuse path's one call, and
  `mock.timers` advanced 20,001 ms. Before the change the run failed at once
  with `Could not start branch uf/…: ` ending at the colon (`checkout -b`) and
  `Checkout … still has uncommitted work` (`status`); after it both calls were
  still running, and at 30 minutes failed with `git … in <slot> was killed
  after 30m 0s without finishing`. A real `index.lock` in the slot's git
  directory gave git's `fatal: Unable to create '…/index.lock': File exists.`
  in the run's reason, unaltered, before and after. Caveat: the slowness is a
  stub's. That a vault's evicted iCloud files make `status` or `checkout` pass
  20 s is the nightly failure's likely cause and is not measured.

- **A planted `core.fsmonitor` and hook run in the operator's own git on the
  host, 2026-10-25, macOS 27.0.1, host git 2.54.0 (Apple Git-157), OrbStack.**
  Board task `da885677`. As `UF_AGENT_UID` (1000) inside the live container,
  with its git 2.39.5: `git init` of `/workspace/uf-fsmonitor-probe`,
  `core.fsmonitor "touch .git/fsmonitor-ran #"` and an executable
  `.git/hooks/post-checkout` that touches `.git/hook-ran`. On the host the
  hook showed as `-rwxr-xr-x`, owned by the operator. The host's `git status`
  alone wrote `.git/fsmonitor-ran`; after `git commit -q --allow-empty -m x`
  and `git checkout -q -b probe`, `.git/hook-ran` existed too, both owned by
  the operator. So OrbStack's file sharing keeps the exec bit, and the
  command runs as the operator, outside the container. The directory was
  removed afterwards.

## Not yet verified by hand

- **That an evicted iCloud checkout is what outlasted 20 s.** Reported from a
  read-only look at the failed run's slot, not repeated here: `git status
  --porcelain` did not finish in 60 s and 100 s there and takes 0.02 s in the
  main checkout, and a zero-byte `index.lock` from 03:05 was in its git
  directory. Unmeasured: whether the files were placeholders, and whether the
  new thirty minutes is enough. To
  settle it, on the host, `time git -C <slot> status --porcelain` with the
  `.uf-worktrees` store's files evicted, then again once downloaded, and
  compare; the stale lock is the operator's to clear first.

- **The signing pins and filter blanking in a booted image, against a land.**
  Unmeasured: `ensureWorktree`, commitPending and a Land press each running
  with a planted `gpg.program` and clean/smudge filter in a real mounted
  repository, as the agent uid through `childCredentials()`. To settle it, in
  a scratch repository under a mount, start an isolated run whose prompt is
  to run `git config commit.gpgSign true`, `git config gpg.program "sh -c 'touch /tmp/uf-sign-ran; cat'"`,
  `git config filter.x.smudge "sh -c 'touch /tmp/uf-smudge-ran; cat'"` and to
  write `* filter=x` to `.git/info/attributes`. Start a second run in the same
  repository, land the first, then `docker compose exec usagefoundry ls
  /tmp/uf-sign-ran /tmp/uf-smudge-ran`: neither should exist.

- **A planted `core.fsmonitor` running in the operator's own git on a host
  other than macOS with OrbStack.** Measured there on 2026-10-25 (Verified
  above). Unmeasured: Docker Desktop's file sharing and a Linux host's plain
  bind mount, where ownership and the exec bit may come through differently.
  To settle it, in a scratch directory and never a real repository:
  `uid=$(docker compose exec -T usagefoundry printenv UF_AGENT_UID)`, then
  `docker compose exec --user "$uid" usagefoundry sh -c 'git init -q /workspace/uf-fsmonitor-probe && cd /workspace/uf-fsmonitor-probe && git config core.fsmonitor "touch .git/fsmonitor-ran #" && printf "#!/bin/sh\ntouch .git/hook-ran\n" > .git/hooks/post-checkout && chmod +x .git/hooks/post-checkout'`.
  Then, on the host in the same directory, run `git status`, `git commit -q
  --allow-empty -m x`, `git checkout -q -b probe` and
  `ls .git/fsmonitor-ran .git/hook-ran`. Both files existing confirms the
  gap.

- **The git-directory warning in a booted image, as root with the uid split
  on.** Unmeasured: the server reading `hooks/` and `info/attributes` as root
  against a mount the agent uid writes, `git config --list` running as the
  agent uid through `childCredentials()`, and the containment check against
  the container's real mounts. To settle it, use a scratch repository under a
  mount. Start an isolated run whose prompt is to run
  `git config core.fsmonitor "touch /tmp/uf-probe #"` and to write an
  executable `.git/hooks/post-checkout`. Then read `run.gitDir` from
  `GET /api/runs/<id>`: both should be listed, and `/tmp/uf-probe` should not
  exist.

- **A resolution made through the app, then "What changed".** The range was
  measured on a hand-made merge; `resolveConflicts`' own merge, the review it
  then bills and the Files tab over it are unwatched. Settles on a resolved
  run whose card names `measuredFrom` and lists only the run's files.

- **No work cycle has been spawned by the `core.excludesFile` code,
  2026-09-09.** Unseen: the write to `/run/uf-git`, the block reaching a
  child's environment, the `EEXIST` path. Settles on a cycle whose `git add -A
  && git status --porcelain` exits 0 where `main` fails.

- **What the 2026-09-06 delivery does not establish**: an agent committing to
  the branch (the run was seeded), the verify gate (`landVerifyCommand` empty),
  a real run id in the PR body (the fixture's read `deliver-`).

- **Deliver's run-state refusal, body check and per-branch link have not met
  GitHub, 2026-09-27.** `deliverRun.test.ts` pushes to a local bare repository
  and stubs `fetch`; unseen are a refused press on a real card and the link
  surviving a real sweep. Settles on the smoke repository above: press on a
  paused run (400, `git ls-remote` empty), then deliver, set
  `eventRetentionDays` to 1 and wait a day past the sweep.

- **A push-only update of an open pull request has not reached GitHub,
  2026-10-20.** `deliverRun.test.ts` pushes the moved tip to a local bare
  repository and stubs `fetch`; unseen are GitHub taking the second push and the
  pull request listing the new commit, and what a branch pushed again after its
  pull request was *closed* now gets (an update, not the new pull request the
  press used to open). Settles on the smoke repository above: deliver, commit on
  the branch, press "Push to pull request #N", then `git ls-remote` and the
  pull request's commit list.

- **A review or conflict resolution against the real CLI.** Review quality,
  `plan` mode in print mode and `acceptEdits` resolutions are unconfirmed.

- **A repository large enough to hit the diff's size budget in the wild.**

- **Committing and purging through the app itself.** Git formats confirmed on
  2.39.5, decisions unit tested; never done through a running server.

- **A real agent using the token**: a `git push` of a run's branch, and a `gh`
  call that needs authentication. The credential block itself was driven into
  a real git; what has not been watched is the CLI's own git picking it up out
  of the environment mid-run.

- **The Files tab's *What it touched* card has been rendered but never
  walked.** The 2026-09-14 label-clamp entry above drew it at 390px in all four
  states against a seeded `run_events` fixture, so the card and its graph are
  known to paint; nothing below it was read. To walk at 1280px and 390px:
  - write down the header's distinct-file and work-cycle counts: the deferred
    file-by-cycle grid in `git show a74a1bb:"proposals/implemented - SessionFlow/"` waits on them;
  - a gone branch (`kind: "none"`) drops to two groups with a warn notice and
    neither "changed, never named" nor "named, and not changed" — the item
    most likely to be wrong;
  - `/api/runs/[id]/touched` is fetched once per tab open, never on the poll.

- **A pre-existing `core.hooksPath` directory compared in a booted image.**
  Unmeasured: the server listing and hashing `.husky/_` as root across a bind
  mount the agent uid writes, and resolving it against the container's real
  mounts. To settle it, in a scratch repository under a mount, run
  `git config core.hooksPath .husky/_`, make `.husky/_/pre-commit` an
  executable script, and start an isolated run whose prompt is to rewrite
  that file in the repository's main checkout. `run.gitDir.report` from
  `GET /api/runs/<id>` should list one hook finding named
  `core.hooksPath:<the directory's real path>/pre-commit`.
