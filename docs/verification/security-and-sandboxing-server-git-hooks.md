# Verification: Security and sandboxing, what this app's own git runs from a repository a work cycle wrote — hooks defined in config

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

## Not yet verified by hand

None yet.
