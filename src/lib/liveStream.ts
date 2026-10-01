import type { ContextOccupancyDTO, LiveCountsDTO } from "./apiTypes";
import { toolArgs } from "./logLine";
import type { PersistedRunEvent } from "./orchestrator";

/**
 * The pure half of `/api/runs/live/stream`: what a tile's tail is opened with,
 * how much of it one connection may put on the wire, and how much of each event
 * a tile is sent.
 *
 * Apart from the route because these are the parts whose failure is silent. A
 * replay bounded by rows and not by bytes is the multi-megabyte response the
 * per-run route's `REPLAY_BYTE_BUDGET` exists to prevent, here multiplied by the
 * number of running runs; a tile sent a file where it draws a line is that
 * response again on every `Write`; and a run the stream stops following while it
 * is still running is a tile that goes quiet and reads exactly like an agent
 * thinking.
 */

/**
 * Bytes one opening replay may put on the wire, across every run in it.
 *
 * Half the per-run route's budget, for a replay that is fifty clipped events
 * per run rather than two thousand whole ones: at 25 running runs — the
 * concurrency ceiling's order of magnitude — each run's share is ~84 KB, and
 * fifty events clipped by `clipForTile` fit inside that with room to spare. The
 * budget is what holds when they do not.
 */
export const LIVE_REPLAY_BYTE_BUDGET = 2 * 1024 * 1024;

/**
 * Longest string a tile's event keeps. A tile shows a line, and the run page —
 * one click away — has the event whole.
 */
export const LIVE_TEXT_CHARS = 600;

/**
 * An event cut to what a tile draws.
 *
 * A `tool` event's input is replaced by the one line `describeEvent` renders
 * from it — `toolArgs` of the stored input, which `toolArgs` then returns
 * unchanged — so a tile's tool line is the run page's line, character for
 * character, from a payload of at most 160 characters rather than up to 4 KB of
 * `Write` body. `truncatedFrom` is kept, so a call stored shortened still says
 * so. Every other string anywhere in the payload is cut at `LIVE_TEXT_CHARS`
 * with the `…` the rest of the app marks a cut with: an agent's message, a
 * stderr chunk of up to 8 KB, the whole cycle prompt an `iteration` event
 * carries but no line renders.
 */
export function clipForTile(e: PersistedRunEvent): PersistedRunEvent {
  if (e.kind === "tool") {
    return { ...e, payload: { ...e.payload, input: toolArgs(e.payload.input) } };
  }
  return { ...e, payload: clipStrings(e.payload) as Record<string, unknown> };
}

function clipStrings(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > LIVE_TEXT_CHARS
      ? `${value.slice(0, LIVE_TEXT_CHARS - 1)}…`
      : value;
  }
  if (Array.isArray(value)) return value.map(clipStrings);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, clipStrings(v)]),
    );
  }
  return value;
}

/**
 * A tail cut to a byte budget, newest first, with what that cut counted.
 *
 * The per-run route's discipline: measured as the bytes that will be sent, so
 * the budget is the wire size rather than a guess at it, and the newest event is
 * kept even when it alone is over — the overshoot is then one event, where the
 * alternative is an empty tail on a run that is working.
 */
export function boundTail<T>(
  events: readonly T[],
  budget: number,
  sizeOf: (event: T) => number,
): { kept: T[]; droppedForBytes: number } {
  const kept: T[] = [];
  let bytes = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const size = sizeOf(events[i]);
    if (kept.length > 0 && bytes + size > budget) {
      return { kept: kept.reverse(), droppedForBytes: i + 1 };
    }
    bytes += size;
    kept.push(events[i]);
  }
  return { kept: kept.reverse(), droppedForBytes: 0 };
}

/**
 * Each run's share of a replay's budget.
 *
 * An even split rather than first come, first served: a budget spent in roster
 * order lets the first run's large events leave the last run's tile empty, and
 * an empty tail on a running run is the one reading this page must not give.
 */
export function replayShare(budget: number, runs: number): number {
  return Math.floor(budget / Math.max(1, runs));
}

/**
 * Which runs to start and stop following, against the ones that are running.
 *
 * The table, not the event that prompted the check, is what decides. A `status`
 * event says where a run went, and the route checks on every one; but the check
 * also runs on a timer, so a status written by some path that emits nothing
 * costs a tile fifteen seconds rather than staying on screen until the page is
 * reloaded, reading as an agent that has gone quiet.
 */
export function diffRoster(
  following: Iterable<string>,
  running: readonly string[],
): { joined: string[]; left: string[] } {
  const now = new Set(running);
  const had = new Set(following);
  return {
    joined: running.filter((id) => !had.has(id)),
    left: [...had].filter((id) => !now.has(id)),
  };
}

/** The strip's three counts, from `activeRuns()`'s rows. */
export function liveCounts(rows: readonly { status: string }[]): LiveCountsDTO {
  const counts: LiveCountsDTO = { running: 0, queued: 0, paused: 0 };
  for (const { status } of rows) {
    if (status === "running" || status === "queued" || status === "paused") {
      counts[status] += 1;
    }
  }
  return counts;
}

export function sameCounts(a: LiveCountsDTO | null, b: LiveCountsDTO): boolean {
  return (
    a !== null &&
    a.running === b.running &&
    a.queued === b.queued &&
    a.paused === b.paused
  );
}

/**
 * `contextOccupancy`'s answer cut to what a tile draws: the newest sample, and
 * none of the prunes or composition that only the series on the run page uses.
 *
 * A cut of the one derivation rather than a second one — every figure the tile
 * shows is computed by `ContextOccupancy` from this, exactly as the run page's
 * is. The counts are left alone so they still say how much exists, which is the
 * contract `contextOccupancy` keeps for a tail. The series is up to 500 points
 * per run, and this is polled for every running run every few seconds.
 */
export function contextForTile(context: ContextOccupancyDTO): ContextOccupancyDTO {
  return {
    ...context,
    samples: context.samples.slice(-1),
    prunes: [],
    composition: [],
  };
}
