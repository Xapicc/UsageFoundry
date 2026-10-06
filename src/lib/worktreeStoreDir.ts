/**
 * The store's own directory name, as a value.
 *
 * One spelling, because the retention sweep and the size figure beside it both
 * name this directory from the mount rather than from a repository — and a
 * second copy of the literal is a directory this app would create and never
 * find again.
 *
 * A module of its own so that `fileCostNotice.ts` can skip the store without
 * importing `orchestrator.ts`, which imports it.
 */
export const WORKTREE_STORE_DIR = ".uf-worktrees";
