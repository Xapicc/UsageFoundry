# Verification: Security and sandboxing, what this app's own git runs from a repository a work cycle wrote — which git directory the probe and the call read: directories made or unmade, a call's own `--git-dir=`, and options ahead of the subcommand

[← Verification index](../verification.md)

Split out of [security-and-sandboxing-server-git-fingerprints.md](security-and-sandboxing-server-git-fingerprints.md) on 2026-11-09, when the entry for board task `f3122092` would have taken that file past 20 KB; every entry above that one was moved from there unchanged.

## Verified

- **A directory below the top of the work tree made a git directory after the
  probe is found first, and fingerprinting what makes one refuses the call,
  2026-11-08.** Board task `fbd6d8dd`, branch at `011f4457`, git 2.39.5 under
  `env -i`. In a committed repository `B` with tracked `B/sub`, `add -A` from
  `B/sub` ran a `filter.x.clean` defined only in a `config` naming `B` as its
  `core.worktree` (`* filter=x` in its `info/attributes`) in four layouts,
  each once its last piece was made and never before: `B/sub` given a `HEAD`
  beside `objects/` and `refs/` (`rev-parse --absolute-git-dir` printed
  `B/sub`, `--show-toplevel` `B`); an empty `B/sub/.git` directory given the
  same; `B/sub` holding `HEAD` first and given `objects/` and `refs/`; and
  `B/sub` holding `HEAD` and a `commondir` first and the directory it names
  given `objects/`. Without `core.repositoryformatversion` git discarded the
  `core.worktree` and the call failed "must be run in a work tree" (2.39.5
  and 2.56.0); with a `commondir` it took one only from `config.worktree`
  under `extensions.worktreeConfig`. `-c safe.bareRepository=explicit`
  refused the first layout and ran the driver in the second. Through this
  app's compiled `git()` and `gitSync()`, `gitFilterProbe.test.ts`'s four
  cases, the stub making the last piece while the index is listed, ran the
  plant at `011f4457` through `git()` and, with the loop cut to `gitSync()`
  alone, through it too, on 2.39.5 and on the `v2.56.0` build; with the
  change each is refused naming that piece, and a call from the
  subdirectory with nothing made runs. The file passed 66 of 76 with 10
  skipped on 2.39.5 and 76 of 76 on 2.56.0. A production caller, traced by
  reading and not driven: `worktreeDiff`'s `status --porcelain`
  (`diff.ts`) runs in a run's folder, which `probeIsolation` leaves below
  the top for a run on a subdirectory. Caveat: a `commondir` is read when it
  is first fingerprinted, so one whose target moves under it is seen only as
  the file's change; and the git directory the probe found is not watched
  for ceasing to be one.

- **The git directory the probe found is refused once its `objects/` or
  `refs/` is moved away, 2026-11-08.** Board task `9ef321d6`, branch at
  `2dd9b3a8`, git 2.39.5 and the `v2.56.0` build. A repository `P` with
  `filter.x.clean` in `P/.git/config` and `* filter=x` in its
  `info/attributes`, holding a separate committed repository `R` at `P/r`
  with a modified file and no driver: under plain git `add -A` in `R` ran
  nothing, and once `R/.git/objects` or `R/.git/refs` was renamed away
  `rev-parse --show-toplevel` there printed `P` and `add -A` ran `P`'s
  driver. Through this app's compiled `git()` and `gitSync()`,
  `gitFilterProbe.test.ts`'s stub renaming either away while the index is
  listed, `P`'s driver ran through `git()` at `e51e3e12` on 2.39.5, and
  through `git()` and `gitSync()` each alone with the new watch cut from the
  compiled change on 2.39.5 and 2.56.0; with the change each call is refused
  naming the directory moved. A ref written in `refs/` itself (`update-ref
  refs/stash HEAD`) and a blob that makes a new fan-out directory in
  `objects/`, each checked to move that directory's ctime, still run the
  call, and a `configFingerprint` watch on either, mutated into the compiled
  change, refused it. The file passed 70 of 80 with 10 skipped on 2.39.5 and
  80 of 80 on 2.56.0. Caveat: a rename away and back keeps the inode, so a
  directory away only while the probe reads is not seen; the probe then
  lists the enclosing repository's drivers, and `R`'s own planted driver ran
  in 8 of 8 calls through a scratch script on both gits (board task
  `f3122092`). That a work cycle can make either move beside one of this
  app's calls is inferred from its writing the common `.git`, not driven.

- **A call naming its git directory with a leading `--git-dir=` is probed in
  that one, and `readGitDir`'s listing asks no probe, 2026-11-08.** Board
  task `507d7792`, branch at `5a81fa7b`, git 2.39.5 and the `v2.56.0` build.
  A repository `A` with `filter.x.clean` in `A/.git/config` and `* filter=x`
  in its `info/attributes`, and a separate repository `B` with a modified
  file and no driver: under plain git `--git-dir=A/.git add -A` from `B` ran
  `A`'s driver. Through this app's compiled `git()` and `gitSync()` at
  `d271d406` the same call ran it too, through each alone, because every
  probe step ran in `B` by discovery and read `B`'s configuration; with the
  change it runs nothing and succeeds, and with the probe broken
  (`gitFilterProbe.test.ts`'s stub mode `refused`) it fails naming the
  probe. `readGitDir`'s `--git-dir=<common> config --list --show-scope
  --show-origin -z --includes`, run from inside `A/.git` through a `GIT_BIN`
  that logs each invocation, spawned 4 git children through each at
  `d271d406` and 1 with the change, and with the probe broken it failed at
  `d271d406` and lists `A`'s `local` records with the change. Cutting the
  flag from the steps, leaving everything behind it unprobed, or restoring
  the old gate in the compiled change each failed one of the three cases.
  The file passed 73 of 83 with 10 skipped on 2.39.5 and 83 of 83 on 2.56.0,
  and `gitDirRead.test.ts` and `gitDirWatch.test.ts` 11 and 30 of theirs.
  Caveat: no production caller puts a content subcommand behind
  `--git-dir=`, and the gate understands no other leading option: `-C A add
  -A`, and `--git-dir A/.git --work-tree A add -A` as separate words, from
  `B` still ran `A`'s driver through each on both gits, probed in `B` (board
  task `c011fcd1`).

- **A probed call behind `-C <dir>` or a two-word `--git-dir <dir>` is
  refused before any git child runs, 2026-11-08.** Board task `c011fcd1`,
  branch at `fb373398`, git 2.39.5 only. The `A`/`B` pair of the entry
  above: under plain git, `-C A add -A` and `--git-dir A/.git --work-tree A
  add -A` from `B` each ran `A`'s driver. Through this app's compiled
  `git()` and `gitSync()` at `fb373398`, a scratch script (not committed)
  ran `A`'s driver with `ok: true` on all four, and `--git-dir=A/.git add -A`
  on neither; the new `gitFilterProbe.test.ts` case failed there on its
  first call. With the change all four return `ok: false` naming the option
  (`-C`, `--git-dir`), `A`'s driver does not run, stub mode `log-calls`
  records no git child spawned before the refusal, and the `--git-dir=` call
  still succeeds and blanks. The file passed 75 of 85 with 10 skipped, and
  `git`, `gitDirRead`, `gitDirWatch`, `blockStartupGit` and
  `checkoutGitClock` 62 of 69 with 7 skipped. Caveat: not run on a 2.56.0
  build. Every other leading option is refused the same way, a read behind
  one included; that no production caller writes one rests on a multiline
  grep of `src/` for a `git(`/`gitSync(` argument list opening with `-` or a
  spread (only `-c` and `--git-dir=`), and an argument list built in a
  variable was not traced.

- **A git directory away only while the filter probe reads is refused, now
  that the probe shows which one it read, 2026-11-09.** Board task
  `f3122092`, branch at `2ea2825e`, git 2.39.5 only. A repository `P` with
  no driver holding a separate committed repository `R` at `P/r` with
  `filter.x.clean` in `R/.git/config`, `* filter=x` in its
  `info/attributes` and a modified file: under plain git, with
  `R/.git/objects` or `R/.git/refs` renamed away, `config --get-regexp
  '^filter\.'` in `R` exits 1 with nothing (it read `P`), and renamed back,
  `add -A` runs `R`'s driver. Through this app's compiled `git()` and
  `gitSync()` at `2ea2825e`, a `GIT_BIN` stub renaming either away around
  the probe's `--get-regexp` and back before it exits ran `R`'s driver in 4
  of 4 calls with `ok: true`, and 0 of 4 without the move; the new
  `gitFilterProbe.test.ts` cases failed there. The brief's first fix, the
  probe pinned with `--git-dir=<the gitDir SITE_PATHS printed>` mutated into
  that build, still ran it 4 of 4: `git --git-dir=<R/.git> config` with
  either away exits 1 with nothing, where `rev-parse` and `ls-files` exit
  128, "not a git repository". With the change (a `--config-env`
  `includeIf.gitdir:<that gitDir>.path` of a marker file, and the call
  refused unless the probe lists the marker's key in the `command` scope)
  all 4 are refused naming `R/.git`, the 4 controls run, and the same move
  around `SITE_PATHS`'s `rev-parse` alone is refused 4 of 4 too. An
  enclosing repository that `include.path`s the marker file itself is
  refused, its record being `local`; dropping the check, or only its scope
  test, from the compiled change failed the matching cases with the driver
  run. The include matched in a linked worktree, through a symlinked `.git`
  and cwd, and in paths holding `=`, `*`, `?`, `[` and `\`, the last two
  only once escaped. A marker file that cannot be made fails the call with a
  reason (without the catch, the compiled change threw `ENOENT` out of
  `git()`). The file passed 80 of 90 with 10 skipped, `a ref or an object
  written straight into them still runs the call` among them. Caveat:
  not run on a 2.56.0 build; the index listing is still read by discovery,
  and with either away only while it ran a submodule's planted driver ran on
  `status` in 4 of 4 calls (board task `8e9fe2ed`); a work cycle making the
  move beside a call is inferred, not driven.

- **A directory made a git directory above a cwd spelled through a symlink
  is refused, now that the way up starts at the real path, 2026-11-09.**
  Board task `cdf5ae4b`, branch at `3cee41f0`, git 2.39.5 only. The
  fixture of `fbd6d8dd`'s entry above, `B/sub` holding all but the last
  piece of a git directory, with a link `B-link` naming `B/sub/d` and the
  call made from `B-link/x`: under plain git `rev-parse --show-cdup` there
  printed `../../../`, and in each of the four layouts `add -A` ran the
  driver once the last piece was made and never before. Through this app's
  compiled `git()` and `gitSync()` at `3cee41f0`, the stub making the last
  piece while the index is listed, all 8 calls (each layout through each)
  ran the plant: `top` was `../../../` folded onto the link's spelling, a
  directory above the fixture, so the walks from the cwd never passed
  `B/sub`. With `top` and both walks taken from the cwd's realpath, all 8
  are refused naming the piece made, and a call from `B/sub` and from
  `B-link/x` with nothing made still runs. The file passed 82 of 92 with 10
  skipped. Caveat: not run on a 2.56.0 build. No production caller passes
  a symlink-spelled cwd, read in code and not driven: folders and
  repository roots are realpathed by `resolveInMount`, Land, diff and
  retention re-check them, and a worktree slot is `path.join`ed onto a
  realpathed store, though its last component is never itself checked.
  The cwd's realpath is read once, before the first step, and nothing
  watches the link itself.

- **A probed call's submodules are found from the top of the work tree, so
  one behind `--git-dir=` from outside its `core.worktree` reaches them,
  2026-11-09.** Board task `b934c65b`, branch at `4e79bc97`, git 2.39.5
  only. A repository `A` holding an embedded repository `a` that holds `b`,
  each a gitlink no `.gitmodules` names, with `filter.x.clean` and `*
  filter=x` planted in `A/a/b/.git`, `b/s.txt` stat-dirty and
  `core.worktree` set to `A`: under plain git from a directory outside `A`,
  `--git-dir=A/.git rev-parse --show-cdup` printed `A`'s absolute path,
  `ls-files --stage` printed the gitlink as `a`, from the top, and `add -A`
  ran `b`'s driver. Through this app's compiled `git()` and `gitSync()` at
  `4e79bc97` the same call ran it through each alone with `ok: true`, and
  from `A` ran nothing: `populatedGitlinks` resolved `a` against the cwd,
  found no `.git` there and probed no submodule. The same resolution folded
  `../sm` onto a subdirectory spelled through a symlink, and a
  superproject's `status` from there ran its submodule's driver through
  each. With the listing made `--full-name` and its paths resolved against
  the probe's `top`, all four run nothing and succeed. The file passed 84
  of 94 with 10 skipped, and `git`, `gitDirRead`, `gitDirWatch`,
  `blockStartupGit` and `checkoutGitClock` 62 of 69 with 7 skipped.
  Caveat: not run on a 2.56.0 build. No production caller puts a probed
  subcommand behind `--git-dir=` (its one producer, `readGitDir`, runs
  `config`), so the first shape is latent; `--show-cdup` printing an
  absolute path from outside a work tree was measured only with
  `core.worktree` set.

- **The index listing is pinned to the git directory the probe found, so
  one away only while it lists is refused, 2026-11-09.** Board task
  `8e9fe2ed`, branch at `498dfbf0`, git 2.39.5 only. A repository `P` with
  no driver and no gitlink holding a superproject `R` whose submodule `sm`
  has `filter.x.clean` and `* filter=x` planted in `R/.git/modules/sm/` and
  a stat-dirty `sm/s.txt`: under plain git `ls-files --stage -- :/` in `R`
  named `sm`, with `R/.git/objects` or `R/.git/refs` renamed away it named
  no gitlink, only `P`'s `../f.txt`, and renamed back, `status` ran the
  driver. Through this app's compiled `git()` and `gitSync()` at
  `498dfbf0`, a `GIT_BIN` stub renaming either away around the listing and
  back before it exits ran the driver on `status --porcelain` through each
  alone, for both. With the listing run as `--git-dir=<the gitDir
  SITE_PATHS printed> ls-files --full-name ...`, each is refused on
  `ls-files`' "not a git repository", exit 128. Repeating `SITE_PATHS`
  after the listing, the brief's other fix, was not built: it runs once the
  directory is back and reads what it read before. `--work-tree` was left
  off because plain git listed the same gitlinks with `--git-dir=` alone as
  by discovery: from a subdirectory, through a symlinked cwd, from a linked
  worktree's subdirectory, behind `core.worktree` from inside and outside
  the work tree, from inside `.git`, in a bare repository and in a
  submodule. `--git-dir=` naming the common directory instead listed the
  main checkout's index from the linked worktree, and mutated into the
  compiled change it failed the new linked-worktree case. The
  found-directory cases' stub now moves after the listing, which a pinned
  listing would refuse first; with the `objects/`/`refs/` watch cut from
  the compiled change they ran the plant. The file passed 88 of 98 with 10
  skipped, `land.test.ts` 110 of 110. Caveat: not run on a 2.56.0 build; a
  work cycle making the move beside a call is inferred, not driven.

- **A cwd spelled through a symlink re-pointed after the probe is refused,
  and the probe and the call run in its realpath, 2026-11-09.** Board task
  `9e508616`, branch at `2546e1fe`, git 2.39.5 and a built 2.56.0. Two
  committed repositories, `A` with no driver and `C` with `filter.x.clean`,
  `* filter=x` in `.git/info/attributes` and a modified `f.txt`, and
  `L -> A`, each with a `d/`. Under plain git, `add -A` in `L` and in `L/d`
  ran nothing, and with `L` re-pointed at `C` ran the driver. Through the
  compiled `git()` and `gitSync()` at `ad9de7f9`, a `GIT_BIN` stub running
  `ln -sfn C L` on the probe's `ls-files` ran the driver with `ok: true` in
  all four calls, each spelling through each. With each site's spelling
  watched by `locationFingerprint`, every step run in the site's realpath
  and the call in its cwd's, all four are refused with `<cwd> changed while
  the filter probe read it`, and a call through an unchanged link to `C`
  runs with the driver blanked. A scratch writer replacing `L` atomically
  (`symlink`, then `rename`) between `A` and `C` nonstop, 300 calls each
  through `gitSync()` and `git()`: `ad9de7f9` ran the driver on 40 and 35;
  the spelling watched with the steps and the call still in it, the brief's
  fix, on 9 and 13; the change on 0 of 1000 and 0 of 1000, refusing 637
  and 608. Cost on a real worktree slot,
  `/workspace/.uf-worktrees/usagefoundry-721638d11c0b-7` on virtiofs:
  17.6 µs a `locationFingerprint`, two per site, beside a probed
  `status --porcelain` there of median 206 ms at `ad9de7f9` and 202 ms
  with the change, n=40, which is noise. Slot leaf: a dangling link at a
  slot reads as absent to `allocateSlotPath`'s `fs.existsSync`, and
  `git worktree add` refuses it with "already exists", exit 128; a link to
  an empty directory is followed, git registers the target's realpath and
  the slot stays a link (measured). A link to any directory reads as
  present, and `slotIsDirty` (`orchestrator.ts`) runs
  `gitSync(<slot>, ["status", "--porcelain"])` through it (read). The file
  passed 101 of 101 on 2.56.0 and 91 of 101 with 10 skipped on 2.39.5.
  Caveat: the race script is not committed, and nothing planted a slot
  link beside a real admission.

## Not yet verified by hand

- **Whether a work cycle can move a site's `objects/` or `refs/` away and
  back beside one of this app's calls.** Board tasks `9ef321d6`,
  `f3122092` and `8e9fe2ed`. Every move above was made by a `GIT_BIN` stub at the exact
  step; a cycle doing it is inferred from its writing the common `.git`, and
  it would need a loop timed to a git child. Settle with a stub cycle that
  renames `R/.git/objects` away and back in a loop while a sibling run's
  `status` polls `R`, and count planted-program markers against refusals
  naming `R/.git`.

- **Whether a link planted at a worktree slot gets past admission.** Board
  task `9e508616`. Read, not driven: a link at `<store>/<slug>-N` to an
  empty directory inside the same repository's checkout would read clean to
  `slotIsDirty` and not foreign to `foreignSlotOwner`, so `allocateSlotPath`
  would return it, `worktree add` would check out through it, and the
  run's first cycle would then throw at `resolveWorkspaceFolder`, after
  `addWorktree`'s `reset --hard` and `recordGitDirBaseline` had run `git()`
  through the link. Settle with a scratch `DATA_DIR`, a stub `CLAUDE_BIN`
  and the `log-calls` `GIT_BIN` stub: plant the link, start an isolated run
  on that repository, and read where the checkout was written and which git
  calls ran with the link as their cwd.
