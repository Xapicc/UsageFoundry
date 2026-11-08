// Relative, not "@/…": the test build is plain CommonJS and nothing rewrites
// the alias at runtime.
import { Meter } from "./Meter";
import { Badge } from "./ui/Badge";
import { CardTitle } from "./ui/Card";
import type { CodexUsageDTO, PlanWindowDTO } from "../lib/apiTypes";
import { currentCodexReading } from "../lib/codexReading";
import { WindowHead, resetText } from "./WindowHead";

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

/**
 * One window's reading: its figure and reset while open, unknown once it has
 * reset.
 *
 * `reported` is the window as the cached reading holds it and `open` is what
 * `currentCodexReading` kept, so the two differ only for a window whose reset
 * has passed — which says so rather than "not reported", because it was.
 */
function windowReading(
  reported: PlanWindowDTO | null,
  open: PlanWindowDTO | null,
  now: number,
): { fraction: number | null; unknownHint: string; reset: string | null } {
  if (open) {
    return {
      fraction: open.utilization,
      unknownHint: "not reported",
      reset: open.resetsAt === null ? null : resetText(open.resetsAt, now),
    };
  }
  return {
    fraction: null,
    unknownHint: reported ? "reset since this reading" : "not reported",
    reset: null,
  };
}

/**
 * One Codex window in the Claude windows' grammar — name, what is left, reset,
 * meter — a size down. It carries no projection line: Codex reports a
 * percentage and a reset, and no rate to extrapolate one from.
 */
function CodexWindow({
  label,
  reported,
  open,
  now,
}: {
  label: string;
  reported: PlanWindowDTO | null;
  open: PlanWindowDTO | null;
  now: number;
}) {
  const r = windowReading(reported, open, now);
  return (
    <div>
      <WindowHead
        size="compact"
        title={label}
        used={r.fraction}
        reset={r.reset}
      />
      <Meter label={`${label} used`} fraction={r.fraction} unknownHint={r.unknownHint} />
    </div>
  );
}

/**
 * The Codex account's own windows, under the Claude ones in the window card.
 *
 * Another provider's percentages, read off the Codex CLI's app server: never
 * added to, compared with or guarded by the Claude meters above them. An
 * unreadable window is the hatched unknown meter, never 0%, and so is one that
 * has reset since the cached reading was taken. Where the figures come from —
 * OpenAI's own, so they match Codex's `/status` — is said in the window card's
 * fold rather than under the meters, because it is read once and decides
 * nothing.
 */
export function CodexWindows({ codex, now }: { codex: CodexUsageDTO; now: number }) {
  const reported = codex.plan;
  const plan = reported ? currentCodexReading(reported, now) : null;
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

      {reported && plan ? (
        <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <CodexWindow
            label={`${codexWindowName(plan.sessionMinutes, "Short")} window`}
            reported={reported.session}
            open={plan.session}
            now={now}
          />
          <CodexWindow
            label={`${codexWindowName(plan.weeklyMinutes, "Long")} window`}
            reported={reported.weekly}
            open={plan.weekly}
            now={now}
          />
        </div>
      ) : (
        <div className="text-xs text-ink-muted">
          No reading{codex.error ? `: ${codex.error}` : ""}
        </div>
      )}
    </div>
  );
}
