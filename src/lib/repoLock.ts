/**
 * One repository's worktree administration, one caller at a time.
 *
 * ## What this is for, and what it deliberately is not
 *
 * `land.ts`'s `landing` set claims **the operator's checkout** — a directory a
 * person also works in — and refuses a second claimant, because a land takes
 * minutes and telling somebody "another branch is being landed into this
 * folder" is the honest answer. This claims something else: the repository's
 * `$GIT_DIR/worktrees` registry, which is shared by every checkout in it.
 *
 * Four callers mutate that registry and, until this existed, none of them knew
 * about the others: `ensureWorktree` prunes it at the start of every isolated
 * run, `resolveCheckout` removes a slot and prunes before adding one,
 * `deleteBranch` removes a slot and deletes a ref, and `purgeBranch` does the
 * same by force. `git worktree prune` is repository-wide by construction — it
 * is the one operation here that is not scoped to a named entry — so it is the
 * one git's own per-entry locking does not serialise for us.
 *
 * **It waits; it does not refuse.** That is the difference from `landing` and
 * it follows from who takes it: the run loop is one of the four, and a refusal
 * there would fail a run start because somebody pressed Delete. Every section
 * bracketed by this is git metadata work measured in milliseconds — the long
 * parts, `worktree add` on a large repository and the seeding copy after it,
 * are deliberately left **outside**, so concurrent run starts in one repository
 * still overlap where the cost is.
 *
 * ## What it does not claim to have fixed
 *
 * No collision was ever reproduced, before or after — `proposals/GapRegister/`
 * ranks that row on blast radius and says so. git locks refs itself and skips
 * locked entries when pruning, so what this closes is the *app-level*
 * interleaving of these four, which is the half this repository is responsible
 * for. It is not evidence that the interleaving was harming anything.
 *
 * ## The one rule for a caller
 *
 * **Never take it inside a section that already holds it for the same
 * repository.** The queue is per key and would wait on itself for ever. Every
 * call site is therefore a leaf: the bracketed body runs git and nothing that
 * re-enters this module.
 */

/**
 * The tail of each repository's queue.
 *
 * `globalThis` for the reason `landing` and every other long-lived map here
 * uses it: module state resets on a dev hot reload, and two of these would be
 * two queues that do not see each other. Its own key, because the value's shape
 * is new — reusing one whose shape changed is the trap `orchestrator.ts:373`
 * records.
 */
const tails = ((globalThis as unknown as { __ufRepoAdminQueue?: Map<string, Promise<void>> })
  .__ufRepoAdminQueue ??= new Map<string, Promise<void>>());

const swallow = () => undefined;

/**
 * Run `fn` with nothing else in this repository's registry at the same time.
 *
 * Resolves and rejects exactly as `fn` does, so a caller's error handling is
 * unchanged by being bracketed.
 */
export function withRepoAdmin<T>(
  repoRoot: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prior = tails.get(repoRoot) ?? Promise.resolve();
  // `fn` on both settlements: a section that threw must not wedge the
  // repository for the life of the process, which is what chaining on success
  // alone would do — and one of the four callers is the run loop, so the wedge
  // would be every isolated run in that repository never starting again.
  const running = prior.then(fn, fn);
  const tail = running.then(swallow, swallow);
  tails.set(repoRoot, tail);
  void tail.then(() => {
    // Only the last waiter clears the entry. A repository whose queue is still
    // being added to must keep its tail, or the next caller chains onto a
    // resolved promise and runs beside the one already in flight.
    if (tails.get(repoRoot) === tail) tails.delete(repoRoot);
  });
  return running;
}

/** Whether anything holds this repository's registry. Exported for tests. */
export function repoAdminBusy(repoRoot: string): boolean {
  return tails.has(repoRoot);
}
