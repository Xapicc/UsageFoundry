# Verification: Security and sandboxing, what this app's own git runs from a repository a work cycle wrote

[← Verification index](../verification.md)

## Verified

- **`gitArgs` as shipped does not stop a hook defined in config on git 2.54.0
  or 2.56.0, and does stop a hooks-directory hook on both, 2026-10-25.** Board
  task `6b4dccf3`, `main` at `4fa51272`. git built from the `v2.54.0` and
  `v2.56.0` tags with `NO_RUST=1` under `$TMPDIR`. This app's compiled `git()`
  ran with `GIT_BIN` pointing at each build, a scratch `HOME` and
  `GIT_CONFIG_NOSYSTEM=1`. A fresh repository had `hook.x.command 'touch
  <marker>'` and `hook.x.event pre-commit` in `.git/config`. `git()` running
  `commit --allow-empty -m t` created the marker on both, as did a plain `git
  commit`. A `.git/hooks/pre-commit` that wrote a marker did not run under
  `git()` on either, and did run under a plain commit. On the image's 2.39.5
  the `hook.x.*` keys ran under neither, because 2.39 has no hooks in config.
  Caveat: run as uid 1000 in an agent container, not in a booted image.

- **git 2.56.0 has no switch that turns off every hook defined in config,
  2026-10-25.** Read from the `v2.56.0` tag. `list_hooks` (`hook.c:535`)
  adds the configured hooks (`hook.c:547`) before the hooks-directory one
  (`hook.c:550`). Only the hooks-directory lookup goes through `core.hooksPath`
  (`hook.c:35`, `path.c:400`). The configured hooks are read with
  `repo_config` (`hook.c:368`), every scope, with no reference to
  `core.hooksPath`. `Documentation/config/core.adoc:529` still says
  `core.hooksPath=/dev/null` disables all hooks. The only off switches are
  `hook.<friendly-name>.enabled` (`Documentation/config/hook.adoc:32`) and,
  from 2.55, `hook.<event>.enabled` (`hook.adoc:49`). 2.54.0 has only the
  first.

- **`-c hook.<name>.enabled=false` for each name stops that hook on 2.54.0 and
  2.56.0, and outranks the repository's `enabled = true`, 2026-10-25.** Same
  harness, through `gitArgs` with the pair added. The marker was not created
  for the names `a.b`, `MiXed` and `sp ace`. The name `a=b` still ran under
  `-c`, because git splits a `-c` argument at its first `=` (`config.c:472`).
  `--config-env=hook.a=b.enabled=VAR` with `VAR=false` stopped it, because
  `--config-env` splits at the last `=` (`config.c:511`). `git config -z
  --includes --get-regexp '^hook\.'` listed every one of these names verbatim.

- **`-c hook.pre-commit.enabled=false` stops a configured `pre-commit` hook on
  2.56.0 only, and a repository can undo it, 2026-10-25.** Same harness. On
  2.56.0 the marker was not created. On 2.54.0 it was. On 2.56.0, adding
  `hook.pre-commit.command = true` to the repository's config made the hook
  run again: git then counts `pre-commit` as a hook's name, and an
  event-level switch applies only to a name that is not one (`hook.c:322`,
  `hook.c:383`). A repository `hook.pre-commit.event` made 2.56.0's commit
  exit 128 (`hook.c:201`) and did not affect 2.54.0.

- **On 2.54.0 and 2.56.0, `branch` and `update-ref` fire a configured hook
  under `git()`, and `status`, `rev-parse` and `diff` do not, 2026-10-25.**
  Same harness, with hooks configured for seven events. `branch` and
  `update-ref` fired `reference-transaction`. `checkout` and `worktree add`
  also fired `post-checkout` and `post-index-change`. `commit` fired
  `post-commit`, and `merge --no-ff` fired `pre-merge-commit` and
  `post-merge`. `status --porcelain`, `rev-parse HEAD` and `diff HEAD~1 HEAD`
  fired nothing. Caveat: `fetch`, `push` and `gc --auto` were not run.

- **A `--config-env` blank stops a filter driver named `a=b` on 2.39.5, and
  the `-c` blank does not, 2026-10-25.** Board task `a9fde194`, `main` at
  `5ba27e95`. The image's git 2.39.5, every `GIT_*` variable unset, a scratch
  `HOME` and `GIT_CONFIG_NOSYSTEM=1`. A fresh repository per case had
  `[filter "a=b"] clean = <prog>` in `.git/config`, `* filter=a=b` in
  `.git/info/attributes` and an edited tracked file, and `<prog>` writes a
  marker. `git -c 'filter.a=b.clean=' add -A` wrote the marker.
  `E= git --config-env='filter.a=b.clean=E' add -A` exited 0 and wrote none,
  and neither did `GIT_CONFIG_COUNT=1` with `GIT_CONFIG_KEY_0='filter.a=b.clean'`
  and an empty value. With `E` unset, `--config-env` exits 128 naming it. With
  `filter.a=b.required=true` as well, the three `--config-env` blanks made
  `add` exit 128 (`clean filter 'a=b' failed`) and wrote no marker. Caveat:
  uid 1000 in an agent container, not a booted image.

- **An empty `merge.<x>.driver` runs nothing and fails the merge on 2.39.5,
  where `false` and `true` each give a wrong merge, 2026-10-25.** Board task
  `a38856ec`, same harness as the entry above. Two branches changed lines 2
  and 5 of one file, `[merge "evil"] driver = <prog> %O %A %B` was in
  `.git/config` and `* merge=evil` in `.git/info/attributes`, and `<prog>`
  writes a marker and keeps theirs. With only `-c core.hooksPath=/dev/null`,
  `merge-tree --write-tree -z` and `merge --no-edit` each ran it. With `-c
  merge.evil.driver=` neither did: both printed `error: cannot run : No such
  file or directory`, `merge-tree` exited 128 and `merge` exited 2, and
  afterwards `status` was clean with no `MERGE_HEAD`. With `false`, both
  reported a content conflict in the file, and the marker was not written. With `true`, both
  reported a clean merge and the result was ours. A driver named `a=b` still
  ran under `-c 'merge.a=b.driver='` and did not under
  `--config-env='merge.a=b.driver=E'` with `E` empty. Caveat: uid 1000 in an
  agent container, not a booted image.

- **A filter behind `includeIf "onbranch:uf/**"` or `includeIf
  "gitdir:<repo>/.git/worktrees/"` is invisible from the main checkout and
  runs in `worktree add` and in an unforced `worktree remove`, 2026-10-25.**
  Board task `d8cae532`, same harness. The filter's `smudge` and `clean` were
  in `.git/evil.inc`, reached only through the include, with `* filter=evil`
  in `.git/info/attributes`. In the main checkout `git config --includes
  --get-regexp '^filter\.'` listed nothing. `worktree add -b uf/slot-1` ran
  the smudge in both forms. `worktree add --no-checkout` ran nothing; the
  same probe inside the new tree listed both commands; and `reset --hard
  --no-recurse-submodules` there with them blanked by `--config-env` ran
  nothing and left `status` clean. `worktree remove` of that tree after a
  `touch` ran the clean filter in both forms, and `remove --force` did not.
  In the main checkout, an in-process `checkout -b uf/new` and a `checkout` of
  an existing `uf/old` whose file differed ran nothing. When a plain add's
  checkout failed (a required filter), git deleted the tree and its
  registration and kept the `-b` branch. `--lock --reason initializing` shows
  as `locked initializing` in `worktree list --porcelain`, and a locked tree
  needs `remove -f -f`.

- **A filter planted in a submodule's own git directory runs on the
  superproject's `status`, and `--ignore-submodules` cannot stop all of the
  subcommands that reach it, 2026-10-26.** Board task `a559b561`, `main` at
  `a177041e`, the image's git 2.39.5, every `GIT_*` variable unset, a scratch
  `HOME` and `GIT_CONFIG_NOSYSTEM=1`. A superproject with submodule `sm` had
  `filter.x.clean = <prog>` in `.git/modules/sm/config`, `* filter=x` in its
  `info/attributes` and a `touch`ed file in `sm/`. Plain `status --porcelain`
  (v1, v2 and long), `diff`, `diff --name-only --diff-filter=U`, `checkout
  <branch>`, `add -A` and `commit -a` each ran it. `commit -m`, `update-index
  -q --refresh`, `reset --hard` and `read-tree -m -u HEAD` did not; `stash`
  had nothing to stash and `merge` was already up to date, so neither says much. `--ignore-submodules=dirty`
  stopped `status` and `diff` even with `submodule.sm.ignore=none` in
  `.git/config`; `-c diff.ignoreSubmodules=all` stopped `status` until that
  key was set. `add -A` ran it under `-c diff.ignoreSubmodules=dirty` and
  `-c submodule.sm.ignore=dirty`. With the `.gitmodules` entry removed,
  `status` still recursed. `--config-env=filter.x.clean=B` with `B` empty on
  the superproject's `status` ran nothing, so the blank reaches the child.
  Caveat: uid 1000 in an agent container, not a booted image.

- **Three more routes into a submodule the superproject's index does not
  list, and the switch that closes each, 2026-10-26.** Same harness. With the
  repository's `submodule.recurse=true`, `checkout -q`, `reset --hard` and
  `read-tree -m -u HEAD <commit>` onto a commit adding a registered submodule
  ran a smudge planted in `.git/modules/sm/`, and `merge` did not; `-c
  submodule.recurse=false` stopped all three. With a repository left in the
  tree that only the target branch lists as a gitlink, `checkout <branch>`,
  `checkout -b` and `switch` ran its clean filter while reporting local
  changes, and `-q` stopped each. Under the superproject's
  `diff.submodule=diff`, `diff --no-textconv <a> <b>` across a submodule move
  ran a textconv planted in the submodule's git directory, and `-c
  diff.submodule=short` stopped it.

- **The fixes above, through this app's `git()`, 2026-10-26.** The cases in
  `gitFilterProbe.test.ts`'s submodule `describe` (status from the top and a
  subdirectory, `gitSync` status, `add -A`, a submodule inside a submodule,
  `read-tree -u`, `checkout`, the textconv patch) each wrote the marker
  against `a177041e`'s `git.ts` and wrote none with the change; the
  plain-git control fired every plant on both. `ls-files --stage -z` over a
  100,000-entry index took 16 ms and printed 6.5 MB. Caveat: what the extra
  steps cost a `status` poll on a real large checkout was not measured.

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

- **A blanked merge driver's failure starts with git's `cannot run :` line,
  2026-10-26.** Board task `adb9e828`, same harness as the merge-driver entry
  above. `merge-tree --write-tree -z` printed `error: cannot run : No such
  file or directory`, then `error: error: Failed to execute internal merge`
  and `fatal: failure to merge`, and exited 128. `merge --no-edit` printed the
  same first two lines, then `Merge with strategy ort failed.`

- **Of this app's git call shapes, only the ref-moving and content-moving
  ones fire a hook defined in config, 2026-11-06.** Board task `6b4dccf3`,
  `main` at `100b9f24`. Apple git 2.54.0 (Apple Git-157) on the macOS host,
  a scratch `HOME`, `GIT_CONFIG_NOSYSTEM=1`, `gitArgs`' first four pairs on
  every call, and a repository with a configured hook for each of 18 events
  in `githooks(5)`. `update-ref` (create, `--no-deref`, compare-and-swap,
  `-d`), `branch -D` and `fetch` fired `reference-transaction`; `push` fired
  `pre-push` and `reference-transaction`. `status`, `update-index --refresh`,
  `add` and `read-tree -m -u` fired `post-index-change`; `commit`, `checkout`,
  `merge --no-ff` and `reset --hard` fired their own events as well.
  `rev-parse`, `rev-list`, `merge-base`, `for-each-ref`, `ls-files`, `log`,
  `show`, `ls-tree`, `diff-tree`, `cat-file`, `config`, `commit-tree`,
  `check-ignore`, `interpret-trailers`, bare `remote`, `remote get-url`,
  `ls-remote`, `--version`, `diff A B` and `merge-tree --write-tree` fired
  nothing. Caveat: `gc --auto` was never triggered, and `worktree add` and
  `remove` failed in the harness and measured nothing.

- **This app's `git()` and `gitSync()` run no hook defined in config on Apple
  git 2.54.0, and ran four before the change, 2026-11-06.** Board task
  `6b4dccf3`, `main` at `100b9f24` plus the per-name switch. `git.test.ts`'s
  config-hook cases on the macOS host: `commit --allow-empty` through both,
  `update-ref` and `branch -D` with a `reference-transaction` hook, `push` to
  a local bare remote with `pre-push`, and hooks named `a.b`, `MiXed`, `sp
  ace` and `a=b` on `commit`. No marker in any case, and the plain-git control
  fired all of them. With `git.ts` at `100b9f24` the same build failed all
  four with the marker present. Caveat: Apple's build only; not run on 2.55
  or later.

- **A push to a local-path remote runs that repository's receive hooks,
  whatever this app's git is told, 2026-11-06.** Apple git 2.54.0, a bare
  repository with a `hooks/pre-receive` and a configured `pre-receive` hook,
  pushed to by path from `git -c core.hooksPath=/dev/null -c
  hook.r.enabled=false push`: both hooks ran. The receiving side is a second
  git that reads its own repository's configuration, and neither pair reached
  it. Not measured on 2.39.5, and not through `git()`.

- **The per-name hook switch holds on git 2.56.0 inside the booted image,
  and is inert on its 2.39.5, 2026-11-06.** Board task `6b4dccf3`, `main` at
  `84beb333`, image rebuilt from it with `docker compose up --build`. git
  `v2.56.0` built with `NO_RUST=1` in a `node:22-bookworm-slim` container and
  copied into the running one. `git.test.ts` and `gitFilterProbe.test.ts`, run
  as root with `GIT_BIN` and the head of `PATH` at that build: the four
  config-hook cases and their plain-git control passed, none skipped, and the
  two gate cases passed. With the image's 2.39.5 the same files gave 56
  passed, 0 failed and the 5 hook cases skipped. Caveat: the server process
  itself still ran 2.39.5. Under 2.56.0 "Land's preview of a merge the blank
  failed names the driver" failed, as it does on the host's 2.54.0 without
  this change.

- **A hook in a second git that this app's git starts does not run, on Apple
  git 2.54.0 and on git 2.56.0 in the image, 2026-11-06.** Board task
  `6b4dccf3`, `main` at `fb8f4239` plus the two cases. A `commit` whose
  repository sets `maintenance.strategy=gc` and has two packs against
  `gc.autoPackLimit=1` starts `git maintenance run --auto`, and that child
  fired a configured `pre-auto-gc` three times under plain git. Under `git()`
  it fired none, and gc still ran. With `push.recurseSubmodules=on-demand` and a
  `pre-push` hook in the submodule's own config, plain git and git with only
  `core.hooksPath=/dev/null` pushed the submodule to its own remote and ran the
  hook. Adding the name switch stopped the hook, but the push still went out.
  `submodule.recurse=false`, which a probed `push` carries, stopped the push
  itself. `git.test.ts` holds both cases. Before the change they failed on
  2.54.0, and after it they passed there and on 2.56.0. Caveat: `fetch`'s gc
  was not driven.

- **A filter, merge driver or configured hook with an empty name runs, and a
  `--config-env` blank of it stops it, 2026-11-08.** Board task `582bceef`,
  `main` at `60db46c4`. The container's git 2.39.5 and `v2.56.0` built with
  `NO_RUST=1` against a scratch zlib under `$TMPDIR`, each under `env -i`. git
  lists `[filter ""]`, `[merge ""]` and `[hook ""]` as `filter..clean`,
  `merge..driver` and `hook..command`. On both, `filter..clean` with
  `* filter=` ran on `add -A` and did not under
  `--config-env=filter..clean=B`, `B` empty; `merge..driver` with `* merge=`
  ran on `merge-tree --write-tree`, and blanked it ran nothing and exited 128
  (2.39.5) or 1 (2.56.0). On 2.56.0 a `[hook ""]` `pre-commit` ran on
  `commit` and did not under `--config-env=hook..enabled=F` or
  `-c hook..enabled=false`. Through this app's compiled `git()` and
  `gitSync()`, `gitFilterProbe.test.ts`'s empty-name cases ran the plant at
  `60db46c4`, four on 2.39.5 and five on 2.56.0, and none with the change.
  Caveat: 2.54.0 was not built, and the hook case skips on 2.39.5.

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

## Not yet verified by hand

- **Whether a work cycle can race this app's git on `.git/config` in
  practice.** Board task `7d41bb25`. The race is shown above with a writer
  this harness started; a cycle doing it beside a sibling run's `worktree
  add`, a Land or a checkout `status` is inferred from a cycle being able to
  write the common git directory. Settle with a stub cycle that renames over
  `.git/config` in a loop while a sibling run is admitted on the same
  repository, and look for the planted program's marker and for refusals
  naming `.git/config`.
