import type { ReactNode } from "react";
// Relative, not "@/…": `CodexWindows` renders this and is under test, and the
// test build is plain CommonJS that nothing rewrites the alias in.
import { fmtInstant, fmtLeft, fmtSpan } from "./windowOutlook";

export type WindowHeadSize = "large" | "default" | "compact";

/** Literal per size, because Tailwind emits nothing for a computed class. */
const LEFT: Record<WindowHeadSize, string> = {
  large: "text-2xl",
  default: "text-xl",
  compact: "text-sm",
};

/**
 * The name sits 4px over its figure rather than `CardTitle`'s 12px: they are
 * one statement ("5-hour session: 38% left"), and the gap, paid twice, was a
 * share of what kept this card from fitting a 1280×800 screen.
 */
const TITLE: Record<WindowHeadSize, string> = {
  large: "mb-1 flex flex-wrap items-center gap-2 text-sm font-semibold text-ink",
  default: "mb-1 flex flex-wrap items-center gap-2 text-sm font-semibold text-ink",
  compact: "text-xs font-medium text-ink",
};

const RESET: Record<WindowHeadSize, string> = {
  large: "text-sm font-medium text-ink",
  default: "text-sm font-medium text-ink",
  compact: "text-xs text-ink-muted",
};

/**
 * When a window resets, absolute first and relative beside it: "Resets Nov 8,
 * 3:30 PM · in 1h 10m", the date only when it is not today. `estimate`
 * prefixes the instant with "~", for a reset derived from turns rather than
 * reported or pinned.
 */
export function resetText(resetsAt: number, now: number, estimate = false): string {
  if (resetsAt <= now) return `Reset ${fmtSpan(now - resetsAt)} ago`;
  return `Resets ${estimate ? "~" : ""}${fmtInstant(resetsAt, now)} · in ${fmtSpan(resetsAt - now)}`;
}

/**
 * One window's first line in the window card: its name, what is left of it,
 * and when it resets — the three things the dashboard is opened to read, in
 * the order they are asked. The Claude windows and the Codex ones share it so
 * a reader learns the layout once; only the size steps down with the emphasis.
 *
 * "Left" rather than "used" because that is the question, and it is the
 * complement of the meter's own head beside it rather than a second reading:
 * both come from the same display `fraction`, and the guard's wider reading
 * stays where it is, as the meter's hatched band. With no reading there is no
 * "left" at all — `instead` is drawn, and never a 0% or a 100%.
 */
export function WindowHead({
  title,
  used,
  instead,
  reset,
  size = "default",
}: {
  title: ReactNode;
  used: number | null;
  instead?: ReactNode;
  reset: ReactNode;
  size?: WindowHeadSize;
}) {
  const left = fmtLeft(used);
  const figure =
    left !== null ? (
      <div className={`font-semibold tabular-nums tracking-tight text-ink ${LEFT[size]}`}>
        {left}
      </div>
    ) : (
      instead
    );
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-1">
      {size === "compact" ? (
        // A size down, the name and its figure share a row: in half the card's
        // width the reset already takes a row of its own under them.
        <div className="flex min-w-0 items-baseline gap-2">
          <h3 className={TITLE.compact}>{title}</h3>
          {figure}
        </div>
      ) : (
        <div className="min-w-0">
          <h2 className={TITLE[size]}>{title}</h2>
          {figure}
        </div>
      )}
      {reset && <div className={`tabular-nums ${RESET[size]}`}>{reset}</div>}
    </div>
  );
}
