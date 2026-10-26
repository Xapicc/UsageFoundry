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

## Not yet verified by hand

- **Any way to keep this app's git from running hooks defined in config.**
  None is in the tree: git has no switch for it, and the choice between
  disabling each listed name and refusing git 2.54 or later is the
  operator's, on board task `6b4dccf3`. Settle once one lands: with a git of
  2.54 or later, `GIT_BIN` pointing at it, run this app's `git()` as `commit
  --allow-empty -m t` in a repository with `hook.x.command 'touch <marker>'`
  and `hook.x.event pre-commit`. Expect no marker, and expect a plain `git
  commit` there to create it.

- **Whether a work cycle can race this app's git on `.git/config` in
  practice.** Board task `7d41bb25`. The race is shown above with a writer
  this harness started; a cycle doing it beside a sibling run's `worktree
  add`, a Land or a checkout `status` is inferred from a cycle being able to
  write the common git directory. Settle with a stub cycle that renames over
  `.git/config` in a loop while a sibling run is admitted on the same
  repository, and look for the planted program's marker and for refusals
  naming `.git/config`.
