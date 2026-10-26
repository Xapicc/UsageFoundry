# Verification: Another git process in the operator's checkout

[← Verification index](../verification.md)

## Verified

- **What the merge queue failed on, read off the install's `merge_queue`,
  2026-10-26.** 1,270 rows since 2026-08-11, every one `merge`: 1,120 landed,
  78 skipped, 72 failed. 35 of the 72 were another process's lock: 13 "You
  have not concluded your merge (MERGE_HEAD exists)", 10 "Unable to write
  index." left mid-merge, 5 "Unable to write index." restored, 4 "stash
  failed", 3 `index.lock` by name, the first on 2026-09-12. In every batch with
  a row left mid-merge, the next row in that repository failed on the
  MERGE_HEAD and the one after it was attempted as usual. Caveat: what held the
  lock on the host was not identified.

- **git 2.39.5 under a held `index.lock`, in the live container, 2026-10-26.**
  A scratch repository in `/tmp`. A true merge printed "error: Unable to write
  index." and exited 1 having written MERGE_HEAD, and `status --porcelain`
  printed nothing. `merge --abort` with the lock still held exited 128 on
  "Unable to create '…/index.lock': File exists."; after it was removed the
  abort exited 0 and MERGE_HEAD was gone. A fast-forward exited 1 on the lock
  by name with no MERGE_HEAD. `GIT_TRACE` showed every true merge running `git
  stash create` first, which is what "stash failed" names. Caveat: what made
  that child fail on the install was not reproduced; with the lock held it
  exited 0.

- **The retry in `landRun` and `unwind`, against git 2.39.5 and 2.54,
  2026-10-26.** Built from `d4c88ebf` plus the change, the ten landing and
  merge-queue test files (254 tests) passed inside the container under git
  2.39.5 and node 22.23.4, run with `env -i` from a `mktemp` directory against
  `/app/node_modules`. Against the unchanged `land.ts` there, the true-merge
  case with the lock held for 300 ms failed with the queue's own sentence,
  "could not be rolled back … error: Unable to write index." On the macOS
  host's git 2.54, 253 passed; the one failure is the 2.39.5-specific
  part-way case, which failed identically before the change. Caveat: a test
  harness in the container's `/tmp`, not the rebuilt image serving the queue.

## Not yet verified by hand

- **The retry on the install.** The running container predates it. Settle:
  `docker compose up --build`, then on the host, in a checkout the queue lands
  into, run `while :; do git status >/dev/null; done` while a batch of several
  branches is landed from `/branches`. No row should end on "Unable to write
  index." or "MERGE_HEAD exists"; one ending "(Tried 4 times.)" means the lock
  was held past seven seconds.
