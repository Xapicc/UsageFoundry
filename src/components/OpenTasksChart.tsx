"use client";

// Relative, not "@/lib/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime, so a tested component has to import the
// way src/lib already does.
import type { TaskListItemDTO } from "../lib/apiTypes";
import { fmtDate } from "../lib/format";

/**
 * How many tasks were open on each of the last seven days, and how many were
 * closed on each, as the taskboard's filter card draws them.
 *
 * **The series are a reconstruction, and the card says so.** The table keeps
 * `created_at` and `closed_at` and nothing else about a task's history:
 * `closed_at` is cleared on the move back out of done or dropped, so a reopened
 * task counts as open for its whole life and its earlier close is on no day of
 * the closed series, and a deleted one is missing from every day it was on the
 * board. There is no `claimed_at` either, which is why open and claimed are one
 * line — splitting them would draw a history this app never recorded.
 *
 * **Two charts, not two lines on one.** The open count is a level in the tens
 * or hundreds and closes are a handful a day, so one plot needs two scales, and
 * then where one line sits against the other — a crossing, a gap — says
 * nothing while looking like it does.
 */

/** Days the series spans, today included. */
const SERIES_DAYS = 7;

export interface OpenTasksPoint {
  /** The instant counted at: the last millisecond of a local day, or now. */
  at: number;
  open: number;
}

export interface ClosedTasksPoint {
  /** The day's last millisecond, or now for today. */
  at: number;
  closed: number;
}

type TaskSpan = Pick<TaskListItemDTO, "createdAt" | "closedAt">;

function isOpenAt(task: TaskSpan, at: number): boolean {
  return task.createdAt <= at && (task.closedAt === null || task.closedAt > at);
}

/**
 * The end of each local day from seven days ago to yesterday, then `now`, so
 * today is "so far".
 *
 * Every midnight is built from calendar fields in the browser's zone and never
 * as `now - n * 86_400_000`, because a day a clock change shortens or stretches
 * is 23 or 25 hours long and the subtraction would cut it an hour into the next.
 */
function sampleInstants(now: number): number[] {
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
  return instants;
}

/**
 * One point at each sample instant: eight rather than seven, so the first is
 * where the week started and the change printed beside the line is the whole
 * seven days' change, where seven points would make it six days and a part.
 */
export function openTaskSeries(
  tasks: readonly TaskSpan[],
  now: number,
): OpenTasksPoint[] {
  return sampleInstants(now).map((at) => ({
    at,
    open: tasks.filter((task) => isOpenAt(task, at)).length,
  }));
}

/**
 * One point per day of the week the open series spans, today included: the
 * tasks closed after one sample instant and at or before the next.
 *
 * Seven points, because the day that ends at the open series' first point is
 * the one before the week. The interval is half-open on the side `isOpenAt`
 * is, so a close at a sample instant lands on the day that instant ends and
 * the week's closes are exactly what the open line lost beside what was filed.
 */
export function closedTaskSeries(
  tasks: readonly TaskSpan[],
  now: number,
): ClosedTasksPoint[] {
  const instants = sampleInstants(now);
  return instants.slice(1).map((at, i) => ({
    at,
    closed: tasks.filter(
      (task) =>
        task.closedAt !== null &&
        task.closedAt > instants[i] &&
        task.closedAt <= at,
    ).length,
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
 * The smallest count range either plot is scaled to, so a one-task wobble is
 * not drawn as the full height of the plot.
 */
const MIN_SPAN = 4;

interface Scale {
  bottom: number;
  top: number;
}

/**
 * The open line is scaled to its own range rather than from zero, because a
 * board of 150 that moved by fifteen is a flat line from zero and the shape of
 * the week is what the chart is for — the figures beside it carry the
 * magnitude.
 */
function ownRange(counts: readonly number[]): Scale {
  const low = Math.min(...counts);
  const high = Math.max(...counts);
  const half = Math.max(high - low, MIN_SPAN) / 2;
  // Centred on the series, but never below zero: a board with nothing open
  // draws its line on the floor rather than floating in the middle of it.
  const bottom = Math.max(0, (low + high) / 2 - half);
  return { bottom, top: bottom + half * 2 };
}

/**
 * Closes per day are scaled from zero, because a day nothing was closed is a
 * reading rather than the bottom of a range: on its own range a week of 5, 6,
 * 5, 6 would draw the same sawtooth as 0, 6, 0, 6.
 */
function fromZero(counts: readonly number[]): Scale {
  return { bottom: 0, top: Math.max(...counts, MIN_SPAN) };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function fmtChange(change: number): string {
  if (change === 0) return "unchanged over 7 days";
  // A real minus sign: a hyphen beside tabular figures reads as a dash.
  return `${change > 0 ? "+" : "−"}${Math.abs(change)} over 7 days`;
}

interface SparkPoint {
  at: number;
  count: number;
  /** The hover readout for this point. */
  title: string;
}

function Sparkline({
  label,
  points,
  scale,
  description,
  figure,
  detail,
  note,
  className,
}: {
  label: string;
  points: readonly SparkPoint[];
  scale: Scale;
  description: string;
  figure: number;
  detail: string;
  note: string;
  className: string;
}) {
  const { bottom, top } = scale;
  const x = (i: number) => round(PAD + (i / (points.length - 1)) * PLOT_W);
  const y = (count: number) =>
    round(PAD + (1 - (count - bottom) / (top - bottom)) * PLOT_H);
  const placed = points.map((point, i) => ({
    ...point,
    cx: x(i),
    cy: y(point.count),
  }));
  const line = placed
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.cx} ${p.cy}`)
    .join(" ");

  return (
    // Field's anatomy — label, a control-height row, one muted line, the same
    // bottom margin — so the card is no taller for having the chart in it.
    <div className={`mb-3.5 min-w-0 max-w-full ${className}`}>
      <p className="mb-1.5 text-xs font-medium text-ink-muted">{label}</p>
      <div className="flex h-9 items-center gap-3">
        <svg
          className="block h-auto w-40 shrink-0"
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          role="img"
          aria-label={description}
        >
          <path
            d={line}
            className="stroke-accent"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
          {placed.map((p, i) => {
            const last = i === placed.length - 1;
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
                  <title>{p.title}</title>
                </circle>
              </g>
            );
          })}
        </svg>
        <p className="whitespace-nowrap text-sm">
          <span className="font-semibold text-ink">{figure}</span>{" "}
          <span className="text-xs text-ink-muted tabular-nums">{detail}</span>
        </p>
      </div>
      <p className="mt-1.5 text-xs leading-snug text-ink-muted">{note}</p>
    </div>
  );
}

export function OpenTasksChart({
  series,
  className = "",
}: {
  series: readonly OpenTasksPoint[];
  className?: string;
}) {
  const counts = series.map((point) => point.open);
  const current = counts[counts.length - 1];
  return (
    <Sparkline
      label="Open, last 7 days"
      points={series.map((point, i) => ({
        at: point.at,
        count: point.open,
        title: `${i === series.length - 1 ? "Now" : fmtDate(point.at)}: ${point.open} open`,
      }))}
      scale={ownRange(counts)}
      description={`Open tasks at the end of each day from ${fmtDate(series[0].at)} to now: ${counts.join(", ")}`}
      figure={current}
      detail={fmtChange(current - counts[0])}
      note="Rebuilt from when each task was filed and closed"
      className={className}
    />
  );
}

export function ClosedTasksChart({
  series,
  className = "",
}: {
  series: readonly ClosedTasksPoint[];
  className?: string;
}) {
  const counts = series.map((point) => point.closed);
  const week = counts.reduce((sum, count) => sum + count, 0);
  return (
    <Sparkline
      label="Closed per day, last 7 days"
      points={series.map((point, i) => ({
        at: point.at,
        count: point.closed,
        title: `${i === series.length - 1 ? "Today so far" : fmtDate(point.at)}: ${point.closed} closed`,
      }))}
      scale={fromZero(counts)}
      description={`Tasks closed on each day from ${fmtDate(series[0].at)} to today: ${counts.join(", ")}`}
      figure={counts[counts.length - 1]}
      detail={`today, ${week} over 7 days`}
      // Closed is `closed_at`, which dropping sets as well as finishing, and
      // the label alone reads as "completed".
      note="Done and dropped both count"
      className={className}
    />
  );
}
