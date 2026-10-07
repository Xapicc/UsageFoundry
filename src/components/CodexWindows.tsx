// Relative, not "@/…": the test build is plain CommonJS and nothing rewrites
// the alias at runtime.
import { Meter } from "./Meter";
import { Badge } from "./ui/Badge";
import { CardTitle } from "./ui/Card";
import type { CodexUsageDTO, PlanWindowDTO } from "../lib/apiTypes";
import { fmtDateTime, fmtRelative } from "../lib/format";

const DAY_MINUTES = 24 * 60;

/**
 * A window's name from the length the backend reported, or `fallback` when it
 * reported none.
 *
 * Computed rather than assumed because the two windows are only *named*
 * primary and secondary on the wire; 300 and 10,080 minutes are what one plan
 * measured, and a plan whose windows differ must not be labelled "5-hour"
 * over a reading that is not one.
 */
export function codexWindowName(minutes: number | null, fallback: string): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return fallback;
  if (minutes === 7 * DAY_MINUTES) return "Weekly";
  if (minutes % DAY_MINUTES === 0) return `${minutes / DAY_MINUTES}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

function resetLine(window: PlanWindowDTO, minutes: number | null, now: number): string | undefined {
  if (window.resetsAt === null) return undefined;
  // A day or longer reads as a date; "in 137h 12m" is not a time anybody plans by.
  const long = minutes !== null && minutes >= DAY_MINUTES;
  return long
    ? `Resets ${fmtDateTime(window.resetsAt)}`
    : `Resets ${fmtRelative(window.resetsAt, now)} · ${fmtDateTime(window.resetsAt)}`;
}

/**
 * The Codex account's own windows, under the Claude ones in the window card.
 *
 * Another provider's percentages, read off the Codex CLI's app server: never
 * added to, compared with or guarded by the Claude meters above them. An
 * unreadable window is the hatched unknown meter, never 0%.
 */
export function CodexWindows({ codex, now }: { codex: CodexUsageDTO; now: number }) {
  const plan = codex.plan;
  return (
    <div className="mt-5 border-t border-line pt-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <CardTitle>Codex</CardTitle>
        {plan?.planType && (
          <Badge tone="neutral">
            ChatGPT {plan.planType.charAt(0).toUpperCase()}
            {plan.planType.slice(1)}
          </Badge>
        )}
        {plan?.limitReached && <Badge tone="danger">limit reached</Badge>}
      </div>

      {plan ? (
        <>
          <div className="mt-2 grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <Meter
              label={`${codexWindowName(plan.sessionMinutes, "Short")} window`}
              fraction={plan.session?.utilization ?? null}
              unknownHint="not reported"
              detail={plan.session ? resetLine(plan.session, plan.sessionMinutes, now) : undefined}
            />
            <Meter
              label={`${codexWindowName(plan.weeklyMinutes, "Long")} window`}
              fraction={plan.weekly?.utilization ?? null}
              unknownHint="not reported"
              detail={plan.weekly ? resetLine(plan.weekly, plan.weeklyMinutes, now) : undefined}
            />
          </div>
          <div className="mt-3 text-xs text-ink-muted">
            Reported by OpenAI for the signed-in account, so it matches Codex&rsquo;s{" "}
            <span className="mono">/status</span>.
          </div>
        </>
      ) : (
        <div className="mt-2 text-xs text-ink-muted">
          No reading{codex.error ? `: ${codex.error}` : ""}
        </div>
      )}
    </div>
  );
}
