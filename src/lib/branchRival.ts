import type { DependencyEdge } from "./orchestrator";

/**
 * Whether no dependency can ever meet both of two conditions.
 *
 * Exactly one pair, and it is a reading of `edgeSatisfied`: once a dependency
 * has run a work cycle, `on-success` is met by `completed` alone and
 * `on-failure` by `failed` or `needs-review` alone, so one run's ending cannot
 * start both. `on-finish` is met by every terminal status and so overlaps both
 * of them — and so does the same condition twice. A `stopped` dependency meets
 * neither, which makes the pair "at most one", never "exactly one": the
 * exception is that they cannot both commit to a branch, not that one of them
 * will.
 *
 * Time is the limit of that reading. A completed dependency picked up again can
 * end `failed`, so over its life it can meet both; `admitWaiting` asks
 * `continuationRival` again at release for that reason.
 */
export function edgesExclude(a: string | null, b: string | null): boolean {
  return (a === "on-success" && b === "on-failure") || (a === "on-failure" && b === "on-success");
}

/** One run that is set to continue a branch, as the one-continuer rule reads it. */
export interface Continuer {
  id: string;
  /**
   * The condition it waits on, on the dependency whose branch is contested.
   * Null where no edge is recorded, which can exempt nothing.
   */
  edge: DependencyEdge | null;
  /** It has put work on the branch or still can: it ran a work cycle, or has not settled. */
  holdsBranch: boolean;
  /** It is `waiting` and ran no work cycle, so nothing of it is on the branch yet. */
  isPending: boolean;
}

/**
 * The continuer that stops a run waiting on `edge` from continuing the same
 * branch, or null when none does.
 *
 * A continuer that holds nothing never counts — a dependent blocked behind a
 * failure put no commit on the branch. Beyond that, one rival is let through: a
 * run still waiting under the condition `edgesExclude` pairs with this one's,
 * because exactly one of the two can ever be released. It has to be *waiting*
 * and to have done nothing: a released rival has had its condition met, and one
 * that has worked is on the branch whatever it waited for.
 *
 * Asked of every continuer and not the first, since a branch can carry the
 * exempt pair and a third run beside them, and the third is the one to name.
 */
export function continuationRival<T extends Continuer>(
  edge: DependencyEdge | null,
  continuers: readonly T[],
): T | null {
  for (const continuer of continuers) {
    if (!continuer.holdsBranch) continue;
    if (continuer.isPending && edgesExclude(continuer.edge, edge)) continue;
    return continuer;
  }
  return null;
}
