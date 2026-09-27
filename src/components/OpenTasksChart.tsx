"use client";

// Relative, not "@/lib/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime, so a tested component has to import the
// way src/lib already does.
import type { TaskListItemDTO } from "../lib/apiTypes";
import { fmtDate } from "../lib/format";

/**
 * How many tasks were open on each of the last seven days, as the taskboard's
 * filter card draws it.
 *
 * **The series is a reconstruction, and the card says so.** The table keeps
 * `created_at` and `closed_at` and nothing else about a task's history:
 * `closed_at` is cleared on the move back out of done or dropped, so a reopened
 * task counts as open for its whole life, and a deleted one is missing from
 * every day it was on the board. There is no `claimed_at` either, which is why
 * open and claimed are one line — splitting them would draw a history this app
 * never recorded.
 */

/** Days the series spans, today included. */
const SERIES_DAYS = 7;

export interface OpenTasksPoint {
  /** The instant counted at: the last millisecond of a local day, or now. */
  at: number;
  open: number;
}

type TaskSpan = Pick<TaskListItemDTO, "createdAt" | "closedAt">;

function isOpenAt(task: TaskSpan, at: number): boolean {
  return task.createdAt <= at && (task.closedAt === null || task.closedAt > at);
}

/**
 * One point at the end of each local day from seven days ago to yesterday, and
 * one at `now`, so today is "so far".
 *
 * Eight points rather than seven so the first is where the week started: the
 * change printed beside the line is then the whole seven days' change, where
 * seven points would make it six days and a part.
 *
 * Every midnight is built from calendar fields in the browser's zone and never
 * as `now - n * 86_400_000`, because a day a clock change shortens or stretches
 * is 23 or 25 hours long and the subtraction would cut it an hour into the next.
 */
export function openTaskSeries(
  tasks: readonly TaskSpan[],
  now: number,
): OpenTasksPoint[] {
  const today = new Date(now);
  const instants: number[] = [];
  for (let back = SERIES_DAYS; back >= 1; back--) {
    const nextMidnight = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() - back + 1,
    ).getTime();
    instants.push(nextMidnight - 1);
  }
  instants.push(now);
  return instants.map((at) => ({
    at,
    open: tasks.filter((task) => isOpenAt(task, at)).length,
  }));
}

// The viewBox is the CSS size the chart is drawn at, so a stroke width here is
// a pixel on screen; `h-auto` takes the height from it rather than a class that
// would have to be kept in step.
const VIEW_W = 160;
const VIEW_H = 36;
const PAD = 3;
const PLOT_W = VIEW_W - PAD * 2;
const PLOT_H = VIEW_H - PAD * 2;

/**
 * The smallest count range the plot is scaled to.
 *
 * The line is scaled to its own range rather than from zero, because a board of
 * 150 that moved by fifteen is a flat line from zero and the shape of the week
 * is what the chart is for — the figures beside it carry the magnitude. The
 * floor stops a one-task wobble being drawn as the full height of the plot.
 */
const MIN_SPAN = 4;

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function fmtChange(change: number): string {
  if (change === 0) return "unchanged over 7 days";
  // A real minus sign: a hyphen beside tabular figures reads as a dash.
  return `${change > 0 ? "+" : "−"}${Math.abs(change)} over 7 days`;
}

function describeSeries(series: readonly OpenTasksPoint[]): string {
  const counts = series.map((point) => point.open).join(", ");
  return `Open tasks at the end of each day from ${fmtDate(series[0].at)} to now: ${counts}`;
}

export function OpenTasksChart({
  series,
  className = "",
}: {
  series: readonly OpenTasksPoint[];
  className?: string;
}) {
  const counts = series.map((point) => point.open);
  const low = Math.min(...counts);
  const high = Math.max(...counts);
  const half = Math.max(high - low, MIN_SPAN) / 2;
  // Centred on the series, but never below zero: a board with nothing open
  // draws its line on the floor rather than floating in the middle of it.
  const bottom = Math.max(0, (low + high) / 2 - half);
  const top = bottom + half * 2;

  const x = (i: number) => round(PAD + (i / (series.length - 1)) * PLOT_W);
  const y = (open: number) =>
    round(PAD + (1 - (open - bottom) / (top - bottom)) * PLOT_H);
  const points = series.map((point, i) => ({ ...point, cx: x(i), cy: y(point.open) }));
  const line = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.cx} ${p.cy}`)
    .join(" ");
  const current = counts[counts.length - 1];

  return (
    // Field's anatomy — label, a control-height row, one muted line, the same
    // bottom margin — so the card is no taller for having the chart in it.
    <div className={`mb-3.5 min-w-0 max-w-full ${className}`}>
      <p className="mb-1.5 text-xs font-medium text-ink-muted">
        Open, last 7 days
      </p>
      <div className="flex h-9 items-center gap-3">
        <svg
          className="block h-auto w-40 shrink-0"
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          role="img"
          aria-label={describeSeries(series)}
        >
          <path
            d={line}
            className="stroke-accent"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
          {points.map((p, i) => {
            const last = i === points.length - 1;
            return (
              <g key={p.at}>
                <circle
                  cx={p.cx}
                  cy={p.cy}
                  r={last ? 2.6 : 1.6}
                  className="fill-accent"
                />
                {/* A wider transparent target carries the hover readout, since
                    a 1.6 dot is too small to find with a pointer. One string:
                    React renders a <title> with array children as empty. */}
                <circle cx={p.cx} cy={p.cy} r={7} fill="transparent">
                  <title>
                    {`${last ? "Now" : fmtDate(p.at)}: ${p.open} open`}
                  </title>
                </circle>
              </g>
            );
          })}
        </svg>
        <p className="whitespace-nowrap text-sm">
          <span className="font-semibold text-ink">{current}</span>{" "}
          <span className="text-xs text-ink-muted tabular-nums">
            {fmtChange(current - counts[0])}
          </span>
        </p>
      </div>
      <p className="mt-1.5 text-xs leading-snug text-ink-muted">
        Rebuilt from when each task was filed and closed
      </p>
    </div>
  );
}
