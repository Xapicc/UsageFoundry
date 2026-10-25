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

## Not yet verified by hand

- **Any way to keep this app's git from running hooks defined in config.**
  None is in the tree: git has no switch for it, and the choice between
  disabling each listed name and refusing git 2.54 or later is the
  operator's, on board task `6b4dccf3`. Settle once one lands: with a git of
  2.54 or later, `GIT_BIN` pointing at it, run this app's `git()` as `commit
  --allow-empty -m t` in a repository with `hook.x.command 'touch <marker>'`
  and `hook.x.event pre-commit`. Expect no marker, and expect a plain `git
  commit` there to create it.
