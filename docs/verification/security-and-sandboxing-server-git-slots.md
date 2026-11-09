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

- **The checkout sweep removed another run's live checkout through a link
  at a settled run's slot, and skips the link with the change,
  2026-11-09.** Board task `e057434a`, branch off `c6a6e3ef`, git 2.39.5.
  Driven through the compiled `sweepCheckouts` over a scratch mount, with
  `spawn`/`spawnSync` wrapped to record each git child: a completed run
  past a 7-day horizon whose `worktree_path` `<slug>-1` was a link to
  `<slug>-3`, a clean checkout of another branch recorded on a `running`
  row. At `c6a6e3ef` the sweep ran the probe and `status --porcelain` in
  `<slug>-3`, then `worktree remove <slug>-1` in the repository, which
  exited 0 and deleted `<slug>-3` with its committed file: `removed: 1`.
  With the change no git child ran in the link or its target or was handed
  either, `removed: 0`, the target was whole and the link left.
  `retentionSweep.test.ts`' case failed against `c6a6e3ef` on the survival
  assertion and passes; the file passed 19 of 19. Caveat: the link was
  planted by the fixture, not by a chat turn, and the second `lstat` before
  the removal narrows the window to `git()`'s probe of the tree and git's
  own resolution of the path without closing it.

- **Every reader of a finished run's recorded slot ran git through a link
  planted there, and none does with the change, 2026-11-09.** Board task
  `9e0badc3`, branch off `c6a6e3ef`, git 2.39.5. Driven through the
  compiled exports with `spawn`/`spawnSync` wrapped, each over a completed
  isolated run whose `worktree_path` `<slug>-1` was a link to `<slug>-9`, a
  registered checkout of the run's own branch. At `c6a6e3ef`:
  `resolveCheckout` ran `rev-parse`, `MERGE_HEAD` and `status` through it
  and returned the link as the resolution's checkout;
  `abortInterruptedResolutions` ran `rev-parse` and `MERGE_HEAD` there;
  `landState` ran `slotState`'s three; `commitPending`, with an uncommitted
  `README.md` in `<slug>-9`, ran `add -A` and `commit` there and answered
  "Committed 1 path", the branch moved; `runDiff` listed ` M README.md`
  from it; `startReview` ran `rev-parse` through it and answered `ok`
  (its cwd is the work directory once the branch matches, read). With the
  change each ran no git child in the link or its target: Resolve was
  refused by git's "already checked out at" `<slug>-9` for its own
  checkout, Commit with "The checkout this run worked in is gone" and the
  branch unmoved, `uncommitted` came back empty, and the review started.
  `resolveCheckout.test.ts`' three new cases failed against `c6a6e3ef` and
  pass; the file passed 16 of 16. Caveat: the probe for `landState`,
  `runDiff` and `startReview` is not committed, and it checks the leaf
  only: with `.uf-worktrees` itself a link to a directory outside the mount
  holding a checkout of the branch at `<slug>-1`, `commitPending` on the
  changed build still committed there (measured, board task `f21be77c`).

## Not yet verified by hand

- **Where a link planted between a slot's `lstat` and git's own `mkdir`
  gets its checkout written.** Board task `d90a042d`. Inferred:
  `worktree add` follows it and checks out where it points, and the first
  cycle's `resolveWorkspaceFolder` then refuses the run, as at `aeca455d`
  above. Settle with a `GIT_BIN` stub that plants the link when `worktree
  add` is spawned, then reads where the checkout went.

- **Whether a link swapped in between `isSlotDirectory` and a reader's git
  call gets through.** Board task `9e0badc3`. Inferred: yes, as at
  admission, since the `lstat` and the spawn are separate steps and
  `slotState` awaits git between them. Settle with a `GIT_BIN` stub that
  replaces the slot with a link to another checkout of the branch when the
  first `rev-parse --abbrev-ref HEAD` in it is spawned, then read where
  `commitPending`'s `add -A` ran.

- **Whether the other readers follow a linked store as Commit does.** Board
  task `f21be77c`. Inferred from `lstat` following every component but the
  last: `resolveCheckout`, the boot cleanup, `reviewCwd`, `uncommittedIn`
  and the sweep would all act at the far end. Settle with a scratch mount
  whose `.uf-worktrees` is renamed out of it and replaced by a link, a
  completed isolated run recorded at `<slug>-1` there, and `spawn` wrapped
  to record each git child's cwd while each reader is called.
