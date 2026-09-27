import type { SnapshotDTO } from "./apiTypes";
import { fmtPct } from "./format";

/**
 * Where the 5-hour reset instant on the dashboard's window card came from.
 *
 * Three provenances for one clock, and each gets its own sentence: the
 * provider's instant matches `/usage` exactly, a pinned one was typed by the
 * operator, and a derived one can sit minutes off.
 */
export type SessionResetSource = "provider" | "pinned" | "derived";

export interface WindowCardNotes {
  sessionResetSource: SessionResetSource;
  /** The per-model weekly line under the weekly meter, or null for none. */
  modelWallLine: string | null;
}

/**
 * The claims the window card makes about the provider's reading, decided from
 * what the snapshot kept rather than from what the provider last said.
 *
 * The card used to read `plan`, the raw copy, which `planUsage` re-serves on
 * age alone for up to an hour. After a rollover the snapshot had already
 * dropped a stale wall and a stale 5-hour instant, and the card still printed
 * the closed week's Opus 95% and called a derived reset "reported by
 * Anthropic". Both look right, which is why this is decided here and tested.
 *
 * `sessionResetOverrideAt` is the setting `buildSnapshot` was given.
 */
export function windowCardNotes(
  snapshot: Pick<SnapshotDTO, "now" | "weekly" | "plan" | "currentPlan">,
  sessionResetOverrideAt: number | null,
): WindowCardNotes {
  return {
    sessionResetSource: sessionResetSource(snapshot, sessionResetOverrideAt),
    modelWallLine: modelWallLine(snapshot),
  };
}

function sessionResetSource(
  snapshot: Pick<SnapshotDTO, "now" | "plan" | "currentPlan">,
  sessionResetOverrideAt: number | null,
): SessionResetSource {
  if ((snapshot.currentPlan?.session?.resetsAt ?? null) !== null) return "provider";
  // `buildSnapshot` lets any provider instant outrank the pinned one, a stale
  // one included, so a pin the snapshot ignored must not be claimed either.
  const providerNamedAnInstant = (snapshot.plan?.session?.resetsAt ?? null) !== null;
  if (
    !providerNamedAnInstant &&
    sessionResetOverrideAt !== null &&
    sessionResetOverrideAt > snapshot.now
  ) {
    return "pinned";
  }
  return "derived";
}

function modelWallLine(
  snapshot: Pick<SnapshotDTO, "weekly" | "currentPlan">,
): string | null {
  const walls = snapshot.currentPlan?.scopedWeekly ?? [];
  if (walls.length === 0) return null;
  const list = walls
    .map((x) => `${x.label} ${fmtPct(x.window.utilization)}`)
    .join(" · ");
  // With no top-level weekly figure the wall stands on its own as the bar (see
  // `makeWindow`), and `planFraction` is what says the provider named one.
  return snapshot.weekly.planFraction !== null
    ? `Per-model weekly: ${list}. The bar above is the all-model window; a guard stops on whichever is highest.`
    : `Per-model weekly: ${list}. Anthropic reported no all-model figure, so the bar above is the highest of these.`;
}
