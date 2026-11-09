# Verification: Security and sandboxing, what this app's own git runs from a repository a work cycle wrote — what the probe read and the call re-reads: includes, conditions and reftable

[← Verification index](../verification.md)

Which git directory the probe and the call read, directories made or unmade among them, is in [security-and-sandboxing-server-git-directories.md](security-and-sandboxing-server-git-directories.md).

## Verified

- **A file renamed away and renamed back has a new ctime, 2026-10-26.** Node's
  `statSync(..., { bigint: true })` before a rename away, a rename of another
  file in, and both renames back: `ctimeNs` differed, `ino` did not, on this
  container's overlay `$TMPDIR` and on the fuse mount holding the worktrees.
  `utimes` to the file's own times changed `ctimeNs` too.

- **The configuration fingerprint stops a nonstop `.git/config` swap and does
  not stop a paced one, 2026-10-26.** Board task `7d41bb25`. A repository with
  `* filter=x` in `.git/info/attributes`, and a second process renaming over
  `.git/config` with a version alternately with and without `filter.x.clean`,
  while this app's compiled `git()` ran `add -A` after an edit, 300 or 1000
  times. Against `a177041e`: 66 and 77 of 300 ran the filter with the swaps
  back to back, and 32, 16 and 8 of 1000 with 10, 20 and 50 ms between them.
  With the change: 0 and 1 of 300 back to back, about 297 of each 300
  refused, and 37, 14 and 3 of 1000 paced. Caveat: one container, one run
  per setting; the paced totals, 56 before and 54 after, are within noise.

- **In a reftable repository `$GIT_DIR/HEAD` is a stub, a flip of an
  `onbranch:` include through `git()` ran the driver, and `tables.list` is what
  moves, 2026-11-08.** Board task `4c645539`, branch at `23c38d50`, git 2.56.0
  (a sibling run's `NO_RUST=1` build of the `v2.56.0` tag, as `GIT_BIN` and
  first on `PATH`). `git init --ref-format=reftable` wrote `HEAD` as `ref:
  refs/heads/.invalid`, `config` with `extensions.refStorage = reftable`, and
  `reftable/` with `tables.list` and one `.ref` table; `branch`, `commit` and
  `symbolic-ref` each rewrote `tables.list` (its ctime moved) and left `HEAD`
  as it was. A linked worktree has a stack of its own at
  `worktrees/<id>/reftable/`: `symbolic-ref HEAD refs/heads/uf/x` there moved
  that `tables.list`'s ctime and not the common one's, a commit moved both.
  `symbolic-ref HEAD` printed `refs/heads/uf/x` once `main` was made a symbolic
  ref to it. Through the compiled `git()` and `gitSync()`, with filter `x` only
  behind `includeIf "onbranch:uf/**"` and the stub flipping HEAD while the
  index was listed, `gitFilterProbe.test.ts`' reftable case ran the planted
  program at `23c38d50`, so the fingerprint of the files backend's `HEAD` and
  loose refs watched nothing that moved; the same plant ran under plain git.
  Also: `extensions.refStorage = reftable` with `repositoryformatversion = 1`
  written by hand into a files repository, with no `reftable/` directory and
  again with an empty `reftable/tables.list`, did not stop git 2.56.0: `status
  --short` exited 0, `symbolic-ref -q HEAD` exited 1 and `rev-parse HEAD`
  exited 128, so a write to `.git/config` alone makes the newer git read an
  empty ref store. With each `tables.list` and the tables it names
  fingerprinted by stat, the main, linked-worktree and branch-made-symbolic
  flips were refused (`reftable/tables.list changed while the filter probe read
  it`) and removing the fingerprints failed them again; `gitFilterProbe.test.ts`
  ran 60 of 60 on 2.56.0 and 53 with 7 skipped (the six reftable cases, the
  hook case) on 2.39.5, and `npm test` on 2.39.5 ran 5451 of 5465 with 14
  skipped and none failing. Caveat: only 2.56.0 was built, so the 2.45 to 2.55
  reftable is inferred; a table edited in place, and a flip back straddling
  the probe which makes `symbolic-ref HEAD` a worse fingerprint than the
  stat, are reasoned and not driven.

- **Watching the reftable stacks refuses about one call per ref update, and
  only in a reftable repository, 2026-11-08.** Board task `4c645539`, same
  build and branch. Back-to-back `git()` and `gitSync()` `status --short` calls
  (about 3 ms each) in a repository beside a linked worktree committing
  `--allow-empty` in a shell loop: files backend, no gap, 0 of 400 refused;
  reftable, no gap 396 of 400, a 100 ms gap 4 of 400, 250 ms 20 of 2000
  (about 20 commits), 1000 ms 9 of 4000 (about 12 commits), and every refusal
  named a `tables.list`. A refusal says that a ref update in a reftable
  repository changes the file. Caveat: calls were issued back to back, so the rate
  per call is the worst case, about one refusal per ref update; a poll every
  few seconds meets far fewer. A reftable repository with several runs
  committing is the case that pays, and none was driven.

- **git names an include's origin relative to the top of the work tree, and
  places `~<user>/` through the user database, 2026-11-08.** Board task
  `10264b6b`, `main` at `60db46c4`, git 2.39.5 under `env -i`. With
  `include.path = evil.inc`, `config --show-origin --includes` printed
  `file:.git/config` and `file:.git/evil.inc` from the top, a subdirectory
  and a nested one, `file:config` from inside `.git` and a bare repository's
  root, and absolute paths from a linked worktree and from a subdirectory of
  a git directory. `rev-parse --show-cdup`, last on its line, printed an
  empty line at the top, `../` one level down, and no line where there is no
  work tree. `config --file /dev/null --type=path --default ~node/x --get k`
  printed `/home/node/x`; for `~nosuchuser/` it exited 128, and so did the
  probe over an `include.path` naming one. Through `git()` and `gitSync()`,
  `gitFilterProbe.test.ts`'s subdirectory and `~<user>/` cases ran the plant
  at `60db46c4` and were refused with the change. Caveat: one user database,
  the container's `/etc/passwd`.

- **An `includeIf` condition flips on HEAD, on the ref behind it and on a
  worktree's `.git` file, and fingerprinting those stops a nonstop flip and
  not a paced one, 2026-11-08.** Board task `9d44342d`, `main` at
  `60db46c4`, git 2.39.5 under `env -i`. With filter `x` only behind
  `includeIf "onbranch:uf/**"`, plain `add -A` ran it after `symbolic-ref
  HEAD refs/heads/uf/x`, and after `.git/refs/heads/main` was rewritten as
  `ref: refs/heads/uf/x` with HEAD left on main. With it behind
  `gitdir:**/worktrees/w2`, `add -A` in worktree `w1` ran it once `w1/.git`
  named `w2`'s git directory. git also followed a branch made a symbolic ref
  through `main-worktree/HEAD`, `worktrees/w2/HEAD` and a per-worktree
  `refs/worktree/x`. Through this app's compiled `git()` and `gitSync()`,
  `gitFilterProbe.test.ts`'s three flip cases ran the plant at `60db46c4`
  and were refused with the change. A writer looping `symbolic-ref` between
  `uf/x` and `main` against 200 `git()` `add -A` calls: nonstop, 42, 42 and
  47 driver runs at `60db46c4` and 0, 0 and 0 with the change (199 to 200
  refused); 20 ms between flips, 7 and 7 against 5 and 3 (13 and 15
  refused). The suite ran 53 of 54 on a built 2.56.0, the one failure the
  merge-preview wording case that fails there at `60db46c4` too. Caveat: one
  container, the paced runs within noise of each other.

- **git reads a linked worktree's `config` from whatever its `commondir`
  names, and fingerprinting that file refuses the swap, 2026-11-08.** Board
  task `2290ab7a`, `main` at `5773bb0b`, git 2.39.5 under `env -i`. A clone
  `B` of repository `A` defined filter `x` in `B/.git/config`, and both named
  it in `info/attributes`. `add -A` in `A`'s linked worktree `w1` ran nothing;
  with `A/.git/worktrees/w1/commondir` rewritten from `../..` to `B/.git`,
  `rev-parse --git-path config` printed `B/.git/config`, `config
  --show-origin` placed the driver there, and `add -A` ran it and exited 0:
  git does not refuse such a worktree. Through this app's compiled `git()`
  and `gitSync()`, `gitFilterProbe.test.ts`'s commondir case, the stub
  rewriting the file while the index is listed, ran the plant through each
  at `5773bb0b` and was refused with the change. On a built 2.56.0 the
  plain-git control ran the driver too, and the file ran 55 of 56, the one
  failure the merge-preview wording case. Caveat: only a rewrite between the
  probe and the call was driven, not a writer racing a call.

- **git expands an include's `%(prefix)/` to its own install prefix, and
  placing it through git refuses a file written there after the probe,
  2026-11-08.** Board task `12d0e24c`, `main` at `5773bb0b`. `v2.56.0` built
  with `NO_RUST=1` against a scratch zlib v1.3.1 under `$TMPDIR`, with a
  prefix there, under `env -i`. `config --file /dev/null --type=path -z
  --default '%(prefix)/x.inc'` printed `<prefix>/x.inc`, and on the image's
  2.39.5 `/usr/x.inc`; `%(prefix)x.inc` and a bare `%(prefix)` came back
  unchanged, so only the prefix with its slash is expanded. Through this
  app's compiled `git()` and `gitSync()` on that build,
  `gitFilterProbe.test.ts`'s `%(prefix)/` case, the stub writing the
  included file while the index is listed, ran the plant through each at
  `5773bb0b` and was refused with the change, and its control ran a driver
  included from the prefix under plain git. The file ran 79 of 80 there, the
  one failure the merge-preview wording case; on 2.39.5 both cases skip,
  since `/usr` is not writable. Caveat: a `RUNTIME_PREFIX` build (Git for
  Windows, some macOS packages) was not tried; that placement follows one,
  since it asks the same binary the call runs, is inferred.

- **git joins an include onto its origin's directory without folding `..`,
  and watching the path unfolded refuses a file written beside a symlink's
  target after the probe, 2026-11-08.** Board task `bbbe1aff`, `main` at
  `4fd7c103`, git 2.39.5 under `env -i`. With `.git/sub` a symlink to
  `<elsewhere>/dir`, `include.path = sub/../evil.inc` and `* filter=x` in
  `.git/info/attributes`, `config --show-origin --includes --get-regexp
  '^filter\.'` printed origin `file:.git/sub/../evil.inc`, `add -A` ran the
  `filter.x.clean` that `<elsewhere>/evil.inc` defines and exited 0, and
  `.git/evil.inc`, where the fingerprint looked, did not exist. Through this
  app's compiled `git()` and `gitSync()`, `gitFilterProbe.test.ts`'s five
  symlink cases, the stub writing the included file while the index is
  listed (a relative include, one nested in a file reached that way, `~/`
  with `HOME` below the link, `~<user>/` below `~/.cache` and `%(prefix)/`),
  ran the plant at `4fd7c103` through `git()` and, with the loop cut to
  `gitSync()` alone, through it too; with the change all are refused naming
  the `sub/../` path. On 2.39.5 the `%(prefix)/` case skips; on a `v2.56.0`
  built under `$TMPDIR` as the `12d0e24c` entry says, it failed at
  `4fd7c103` and passed with the change, and the whole file passed 70 of 70
  there. Caveat: only the
  include targets were unfolded; the top of the work tree is still
  `path.resolve(dir, cdup)`, which folds a symlink in the call's own
  directory, and that was not driven.

## Not yet verified by hand

- **Whether a work cycle can race this app's git on `.git/config` in
  practice.** Board task `7d41bb25`. The race is shown above with a writer
  this harness started; a cycle doing it beside a sibling run's `worktree
  add`, a Land or a checkout `status` is inferred from a cycle being able to
  write the common git directory. Settle with a stub cycle that renames over
  `.git/config` in a loop while a sibling run is admitted on the same
  repository, and look for the planted program's marker and for refusals
  naming `.git/config`.
