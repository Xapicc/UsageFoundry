import type { CodexPlanUsageDTO, PlanWindowDTO } from "./apiTypes";

/**
 * A Codex window that has not yet closed, or null.
 *
 * `currentPlanReading` is not used for Codex, because its session test is a
 * five-hour window by construction and Codex names its own lengths: applied to
 * a day-long primary window it would drop a live reading whenever the reset is
 * more than five hours off. A window that named no reset is an absence of an
 * instant, not a rollover, and stands.
 */
function openWindow(window: PlanWindowDTO | null, now: number): PlanWindowDTO | null {
  if (!window) return null;
  return window.resetsAt === null || window.resetsAt > now ? window : null;
}

/**
 * The part of a Codex reading still in force at `now`, for every surface that
 * draws it.
 *
 * `codexUsage` re-serves its last good reading on age alone — up to five
 * minutes on a healthy install, an hour while the app server is failing — so a
 * window can reset inside a reading that is still being served. Drawn as it
 * stands, that put "100% used, limit reached" on the dashboard over a window
 * that had spent nothing, while the toolbar called the same window unknown.
 *
 * `limitReached` is the backend's verdict on the reading as a whole and names
 * no window, so it stands only while an open window still reads at or over the
 * wall — `codexWallBoundary`'s test for a full window. Carried past the reset,
 * it tinted the window that was still open as spent.
 *
 * Display only. The guards read `codexGuardSnapshot`, whose `buildSnapshot`
 * applies its own reset test.
 *
 * Its own module because `CodexWindows` is a client component and both
 * `codexAccount.ts` and `usageRemaining.ts` import server-only code.
 */
export function currentCodexReading(plan: CodexPlanUsageDTO, now: number): CodexPlanUsageDTO {
  const session = openWindow(plan.session, now);
  const weekly = openWindow(plan.weekly, now);
  const atWall = [session, weekly].some((w) => w !== null && w.utilization >= 1);
  return { ...plan, session, weekly, limitReached: atWall ? plan.limitReached : null };
}
