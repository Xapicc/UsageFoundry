# Verification: Security and sandboxing, what this app's own git does at a worktree slot that is a symbolic link — at admission, at setup, and after the run

[← Verification index](../verification.md)

Split out of [security-and-sandboxing-server-git-directories.md](security-and-sandboxing-server-git-directories.md) on 2026-11-09, when the entries for board tasks `e057434a` and `9e0badc3` would have taken that file past 20 KB; the entry and the open item for board task `d90a042d` were moved from there unchanged.

## Verified

- **A link planted at a worktree slot gets past admission today, and is
  skipped, refused or unlinked with the change, 2026-11-09.** Board task
  `d90a042d`, branch off `aeca455d`, git 2.39.5. Driven through the real
  `createRun` and run loop, with `spawn`/`spawnSync` wrapped to record each
  git child's cwd and an unspawnable `CLAUDE_BIN`. At `aeca455d`, a link at
  `<slug>-1` to an empty directory inside the same repository's checkout
  was handed out; `worktree add` wrote `.git` and every tracked file into
  that directory, registered at its realpath, the operator's `git status`
  read `?? empty-target/`, and the probe, `status`, `reset --hard` and two
  `rev-parse`s ran there before the first cycle's `resolveWorkspaceFolder`
  failed the run, no agent spawned. A dangling link was handed out and the
  run failed on "already exists"; a link to a plain directory was skipped,
  after one probe step ran in it. `git worktree remove --force <link>`
  deleted the checkout the link pointed at, uncommitted file included,
  which `resolveCheckout` and the boot cleanup ran on a link at
  `<slug>-resolve-<id8>`. With the change both slot links are skipped to
  `<slug>-2` with no git in them, a link planted after admission is refused
  by name with nothing written, and both resolve paths unlink the link and
  leave its target whole. `slotLeafLink.test.ts`' three cases,
  `resolveCheckout.test.ts`' last two and the census case in
  `orchestrator.test.ts` all failed against `aeca455d`'s source and pass
  with the change; drive them with `npx tsc -p tsconfig.test.json --outDir
  .test-build/<tag> && node --test
  .test-build/<tag>/lib/slotLeafLink.test.js`. Caveat: the probe that read
  the operator's status is not committed, and every link was planted from
  the test, not by a chat turn.

## Not yet verified by hand

- **Where a link planted between a slot's `lstat` and git's own `mkdir`
  gets its checkout written.** Board task `d90a042d`. Inferred:
  `worktree add` follows it and checks out where it points, and the first
  cycle's `resolveWorkspaceFolder` then refuses the run, as at `aeca455d`
  above. Settle with a `GIT_BIN` stub that plants the link when `worktree
  add` is spawned, then reads where the checkout went.
