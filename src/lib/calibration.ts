import type { UsageEntry } from "./transcripts";
import {
  FIVE_HOURS_MS,
  WEEK_MS,
  currentPlanReading,
  type PlanUsage,
  type PlanWindow,
} from "./windows";

/**
 * The utilisation below which a measured ceiling is not worth reporting.
 *
 * The provider reports whole-ish percentage points, so a window at 2% divides
 * a cost by a number carrying ±25% of relative error — and it divides by a
 * denominator that is mostly rounding. At 10% the same absolute granularity is
 * a few percent, which is well inside the error the coverage caveat already
 * carries.
 */
export const MEASURABLE_UTILIZATION = 0.1;

export interface CeilingMeasurement {
  /** `costUSD` over `utilization`, rounded to the cent. */
  ceilingUSD: number;
  /** The provider's figure for the window. */
  utilization: number;
  /** What this disk's turns in the window had cost when the reading was taken. */
  costUSD: number;
}

export interface MeasuredCeilings {
  session: CeilingMeasurement | null;
  weekly: CeilingMeasurement | null;
}

/**
 * The ceilings implied by windows that are part spent: what the turns here cost,
 * over the share of the allowance the provider says they took.
 *
 * This is a measurement rather than the peak-derived lower bound the calibrate
 * route falls back to, and it is the only way to put a number on a limit
 * Anthropic publishes nowhere. It still errs low, for a reason worth keeping:
 * the numerator is Claude Code's transcripts and the denominator counts every
 * surface, so a week that also held Desktop or web work divides a partial cost
 * by a full percentage. Reading low means percentages computed against it read
 * high, which is the same direction the peak method already errs in.
 *
 * Both halves of the division have to describe the same spend, which is the
 * carry-forward rule in `planFractionCarriedForward` again:
 *
 * - Only a reading still in force (`currentPlanReading`). After a rollover the
 *   route divided the new window's few dollars by the closed window's
 *   percentage: $2 over 88% suggested a $2.27 session ceiling against an
 *   observed $80 peak. For a week it summed two weeks over one percentage.
 * - Only turns up to `fetchedAt`, because the percentage counts nothing newer.
 *   A reading 50 minutes old measured $400 where its own rate says $200, which
 *   is 2x high, the unsafe direction for a ceiling.
 * - Only a reading that names its reset instant, since without one there is no
 *   span to count spend over.
 */
export function measureCeilings(
  entries: readonly UsageEntry[],
  plan: PlanUsage | null,
  now: number,
): MeasuredCeilings {
  if (plan === null) return { session: null, weekly: null };
  const current = currentPlanReading(plan, now);
  return {
    session: measureWindow(entries, current.session, FIVE_HOURS_MS, plan.fetchedAt),
    weekly: measureWindow(entries, current.weekly, WEEK_MS, plan.fetchedAt),
  };
}

function measureWindow(
  entries: readonly UsageEntry[],
  reading: PlanWindow | null,
  spanMs: number,
  fetchedAt: number,
): CeilingMeasurement | null {
  const resetsAt = reading?.resetsAt ?? null;
  if (reading === null || resetsAt === null) return null;
  if (reading.utilization < MEASURABLE_UTILIZATION) return null;

  const opensAt = resetsAt - spanMs;
  const costUSD = entries.reduce(
    (sum, e) =>
      e.ts >= opensAt && e.ts < resetsAt && e.ts <= fetchedAt ? sum + e.costUSD : sum,
    0,
  );
  if (!(costUSD > 0)) return null;

  return {
    ceilingUSD: Math.round((costUSD / reading.utilization) * 100) / 100,
    utilization: reading.utilization,
    costUSD,
  };
}
