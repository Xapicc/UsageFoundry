// Relative, not "@/…": the test build is plain CommonJS and nothing rewrites
// the alias at runtime.
import type { WindowStateDTO } from "../lib/apiTypes";
import { fmtDateTime } from "../lib/format";

/**
 * What the dashboard's projection line under one Claude window can say.
 *
 * Each window carries its own run-out from `buildSnapshot`, already bounded by
 * that window's reset, so the line under a meter is about that meter alone. It
 * used to be deduced from the snapshot's one earliest instant, which cannot say
 * whose it is: before the session's reset, with both windows projectable, the
 * line read "Session or week runs out" and the week got no line at all.
 */
export type WindowOutlook =
  | { kind: "nothing-to-project" }
  /** The window's reset instant has passed since the reading was taken. */
  | { kind: "reset" }
  /** Not projected to run out before it resets — or at all, for a trailing total. */
  | { kind: "lasts"; trailing: boolean }
  | {
      kind: "runs-out";
      /** When, never earlier than `now`: an instant already passed is "now". */
      at: number;
      inMs: number;
      /** How long before this window's reset, or null for a trailing total. */
      beforeResetMs: number | null;
    };

export interface OutlookWindow {
  /** When the consumed figure goes back to zero, or null for a trailing total. */
  resetsAt: number | null;
  /** Whether `buildSnapshot` had anything to project it against (`isProjectable`). */
  projectable: boolean;
  /** This window's own `projectedExhaustionAt`, never the snapshot's. */
  projectedAt: number | null;
}

/**
 * Whether `buildSnapshot` can project this window at all, from the window as the
 * snapshot reports it — the same test its `candidatesFor` applies.
 *
 * A provider-backed window is projected against the allowance its percentage
 * implies, and never against a typed ceiling, so a typed ceiling does not make
 * it projectable: a model-scoped wall standing in for a missing figure has
 * `planFraction` null and offers nothing, and neither does a reading of 0%.
 * Anything else is projectable exactly when it has a ceiling, which is when it
 * has a `fractionMetric`. The one case this cannot see is a provider reading
 * taken before the window had spent anything on this disk; `buildSnapshot`
 * offers no candidate for it and this calls it projectable, so for those few
 * minutes it reads "lasts to reset" where the honest answer is "unknown".
 */
export function isProjectable(
  w: Pick<WindowStateDTO, "fractionMetric" | "planFraction">,
): boolean {
  if (w.fractionMetric === "plan") return w.planFraction !== null && w.planFraction > 0;
  return w.fractionMetric !== null;
}

/**
 * One Claude window's outlook from its own projected instant.
 *
 * A reset that has passed outranks the projection, which was made against the
 * window before it. Equal to the reset counts as running out — `buildSnapshot`
 * keeps a candidate at exactly its window's reset and drops one a millisecond
 * past it.
 */
export function windowOutlook(w: OutlookWindow, now: number): WindowOutlook {
  if (w.resetsAt !== null && w.resetsAt <= now) return { kind: "reset" };
  if (w.projectedAt !== null) {
    const at = Math.max(w.projectedAt, now);
    return {
      kind: "runs-out",
      at,
      inMs: at - now,
      beforeResetMs: w.resetsAt === null ? null : w.resetsAt - at,
    };
  }
  if (!w.projectable) return { kind: "nothing-to-project" };
  return { kind: "lasts", trailing: w.resetsAt === null };
}

/**
 * A duration as a person plans by: "45m", "2h 10m", "3d 4h".
 *
 * Rounded to the minute, and to the hour once it is a day or more — a reset
 * three days out is not planned to the minute, and "in 76h 12m" (what
 * `fmtRelative` prints) is not a time anybody reads. Under half a minute is
 * "<1m" rather than "0m", which would say the gap is not there.
 */
export function fmtSpan(ms: number): string {
  const minutes = Math.round(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) {
    const m = minutes % 60;
    return `${Math.floor(minutes / 60)}h${m ? ` ${m}m` : ""}`;
  }
  const hours = Math.round(minutes / 60);
  const h = hours % 24;
  return `${Math.floor(hours / 24)}d${h ? ` ${h}h` : ""}`;
}

/**
 * An instant as a wall-clock time, with the date only when it is not today:
 * "11:18 PM", "Nov 9, 12:28 AM". A reset or a run-out is nearly always within
 * the day, and a date on every one of them is the width that wrapped the
 * projection line onto a second row of a card meant to fit one screen.
 */
export function fmtInstant(ts: number, now: number): string {
  const day = (t: number) => new Date(t).toDateString();
  return day(ts) === day(now)
    ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : fmtDateTime(ts);
}

/**
 * What is left of a window, from the fraction used: "38% left", or null when
 * there is no reading — an unknown is never "100% left" or "0% left".
 *
 * Whole percent, as the toolbar's readout prints it, so the two agree on the
 * same screen. Except at the two ends, where rounding would state the opposite
 * of the reading: a sliver left is "<1%", not "0%", and a sliver used is
 * ">99%", not "100%". Over the wall is "0% left"; the meter's head beside it
 * keeps the figure past 100%.
 */
export function fmtLeft(usedFraction: number | null): string | null {
  if (usedFraction === null || !Number.isFinite(usedFraction)) return null;
  const left = 1 - usedFraction;
  if (left <= 0) return "0% left";
  if (left >= 1) return "100% left";
  const pct = Math.round(left * 100);
  if (pct === 0) return "<1% left";
  if (pct === 100) return ">99% left";
  return `${pct}% left`;
}

/**
 * The projection line's words.
 *
 * `rate` is the burn rate as printed ("$4.10/h"), handed only to the line that
 * carries it so it is said once in the card.
 */
export function outlookLine(
  o: WindowOutlook,
  rate: string | null,
  now: number,
): string {
  const at = rate ? ` at ${rate}` : "";
  switch (o.kind) {
    case "nothing-to-project":
      return "Nothing to project against";
    case "reset":
      return "Reset since this reading";
    case "lasts":
      return `${o.trailing ? "Not projected to run out" : "Lasts to reset"}${at}`;
    case "runs-out": {
      const when = o.inMs < 60_000 ? "now" : `~${fmtInstant(o.at, now)} (in ${fmtSpan(o.inMs)})`;
      // Under a minute is "about when it resets" and never "<1m before": the
      // projection is an hour's rate extrapolated, and a margin that precise
      // would be a claim about which side of the reset it lands on.
      const margin =
        o.beforeResetMs === null
          ? ""
          : o.beforeResetMs < 60_000
            ? " — about when it resets"
            : ` — ${fmtSpan(o.beforeResetMs)} before reset`;
      return `Runs out ${when}${at}${margin}`;
    }
  }
}
