# Verification: Security and sandboxing, what this app's own git runs from a repository a work cycle wrote — submodules

[← Verification index](../verification.md)

## Verified

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

## Not yet verified by hand

None yet.
