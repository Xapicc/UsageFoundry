# The git this app runs

[← testing index](../testing.md)

Read before adding or editing tests of `git.ts`.

`git.ts`'s are what every git call this app makes carries: a missing `-c` is a repository-controlled hook run by this server's own git child, with no permission mode and no line in `run_events`, and a variable that survives the scrub is that hook handed `DATA_DIR`.

`git.test.ts`'s `GIT_OPTIONAL_LOCKS` cases are a land refused for no reason of its own. `git status` refreshes the index and takes `index.lock` to write it back, and this app runs `status` in the operator's checkout from the poll behind every Land card, so a merge starting at that moment was refused by git with `Unable to create '…/index.lock': File exists`, and the lock was gone by the time anyone looked. One case asserts `gitEnv()` carries the variable and `agentEnvironment()` does not, since set there it would reach every agent. The other is a real repository with a stat-dirty file, a `status` through `git()` and the index's bytes compared, because a git that ignored the variable would pass the first; its control is a plain `status` rewriting the same index, without which a fixture that was not dirty would measure nothing. Before the change both failed. On 2.39 `git diff` against the working tree rewrites the index whatever the variable says, measured, which is why `gitEnv`'s comment requires every diff here to be between commits.

`git.test.ts`'s `GIT_BIN` case plants a `git` first on `PATH` and asserts `gitSync` did not run it. The default was the bare name, and this server's `PATH` then started with the stacks' `bin/` and the agent-owned `/home/node/pytools/bin`, so whatever `git` was first there answered every diff, worktree and landing — as root wherever the uid split is off. Root's `PATH` no longer carries either (board task `aff25da4`); the case stays because the path is what keeps git from depending on that. Nothing about that is visible: a planted `git` that forwards to the real one passes every other test in the suite. Skipped when `GIT_BIN` is set, because the default is then not what runs.
