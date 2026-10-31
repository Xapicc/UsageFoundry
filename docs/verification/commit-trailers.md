# Verification: Commit trailers

[← Verification index](../verification.md)

## Verified

- **How git 2.39.5 writes the messages the trailers ride on (2026-10-31, the container's git, scratch repository):** `git merge --no-edit -m 'Merge branch x' -m 'UF-Run: r1'` wrote the subject, a blank line and the trailer block, and `%(trailers:only,unfold)` read it back. A conflicted merge given the same two `-m`, resolved and committed with `git commit --no-edit --trailer 'UF-Run: r1'`, wrote the block twice, the second after `# Conflicts:` comment lines from `MERGE_MSG`, which is why a resolution's commit restates its message instead. Measured once, on this one git; a newer git may order `MERGE_MSG` differently.

- **The stamp keeps everything but the message (2026-10-31, real repositories, `runTrailers.test.ts`, 20 cases):** after `stampBranchCommits` each rewritten commit has the same tree, author, committer and dates as the one it replaced, its parent is the stamped commit below it, the checkout reports no change, and a second pass finds nothing to do. Removing the target from the `rev-list` exclusion made 5 of the 20 fail; removing the call from the run loop made the run test fail. It shows the module and the call do what the tests say, against a stub agent; it does not show a real CLI's commits are stamped.

## Not yet verified by hand

- **No real run's commits have been stamped, and the vault has none:** every case above is a scratch repository or a stub agent. Unseen: a real Claude Code cycle's own `git commit` under the sandbox, with the stamp running as the child uid in a real slot on virtiofs (`update-ref` onto a branch checked out in that slot, and `commit-tree` writing objects into a repository the agent also writes); that a Dreaming night's branch lands with trailers on every commit it brings; and that `git log --format='%(trailers)'` on the vault's `main` shows them. Settle after the first run on a build that carries this: `git -C <repo> log --format='%h %an %(trailers:only,unfold)' <target>..<run's branch>` should show the run's id on every commit and the author unchanged, and the run's log should hold no `Run trailers were not added` line.

- **How often a stamp is skipped:** the skips are `stampCycleCommits`' log lines (target not recorded, checkout on another branch, more than 500 commits, a signed or re-encoded commit, the branch moved). None has been counted on a real install. Settle with `SELECT COUNT(*) FROM run_events WHERE kind = 'log' AND payload LIKE '%Run trailers were not added%'` once a week of runs exists.
