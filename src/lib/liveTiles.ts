import {
  LIVE_TAIL_EVENTS,
  type LiveCountsDTO,
  type LiveFrameDTO,
  type RunEventDTO,
  type RunToolActivityDTO,
} from "./apiTypes";

/**
 * What `/runs/live` holds, built from `/api/runs/live/stream`'s frames —
 * client-safe and pure, so the page is a fold over the stream.
 *
 * Every mistake here is silent. A `join` appended rather than replacing doubles
 * a tail on every reconnect, and a doubled line is indistinguishable from an
 * agent doing the same thing twice; a tile that `ready` does not drop is a run
 * that ended while the connection was down, still on screen and reading as an
 * agent that has gone quiet; a tail that is never trimmed grows for as long as
 * the page is open.
 */

export interface LiveTile {
  runId: string;
  /** Oldest first, at most `LIVE_TAIL_EVENTS`. */
  events: RunEventDTO[];
  /** Older events of this run the tail does not hold. */
  dropped: number;
  tools: RunToolActivityDTO[];
}

export interface LiveState {
  /** In the order the runs joined, so a tile does not move when another ends. */
  tiles: LiveTile[];
  counts: LiveCountsDTO | null;
  /** The opening replay has finished, so an empty `tiles` means none is running. */
  ready: boolean;
}

export const EMPTY_LIVE: LiveState = { tiles: [], counts: null, ready: false };

export function applyLiveFrame(state: LiveState, frame: LiveFrameDTO): LiveState {
  switch (frame.kind) {
    case "counts":
      return { ...state, counts: frame.counts };

    case "join": {
      const tile: LiveTile = {
        runId: frame.runId,
        events: frame.events,
        dropped: frame.dropped,
        tools: frame.tools,
      };
      const at = state.tiles.findIndex((t) => t.runId === frame.runId);
      return {
        ...state,
        tiles:
          at < 0
            ? [...state.tiles, tile]
            : state.tiles.map((t, i) => (i === at ? tile : t)),
      };
    }

    case "ready": {
      const running = new Set(frame.runIds);
      return {
        ...state,
        ready: true,
        tiles: state.tiles.filter((t) => running.has(t.runId)),
      };
    }

    case "event":
      return withTile(state, frame.runId, (t) => {
        const events = [...t.events, frame.event];
        const over = Math.max(0, events.length - LIVE_TAIL_EVENTS);
        return { ...t, events: events.slice(over), dropped: t.dropped + over };
      });

    case "tools":
      return withTile(state, frame.runId, (t) => ({ ...t, tools: frame.tools }));

    case "leave":
      return {
        ...state,
        tiles: state.tiles.filter((t) => t.runId !== frame.runId),
      };
  }
}

/**
 * One tile changed, or the state untouched when there is no tile for the run —
 * a frame for a run this page is not showing has nowhere to go, and the stream
 * sends a run's `join` before anything else about it.
 */
function withTile(
  state: LiveState,
  runId: string,
  change: (tile: LiveTile) => LiveTile,
): LiveState {
  const at = state.tiles.findIndex((t) => t.runId === runId);
  if (at < 0) return state;
  return { ...state, tiles: state.tiles.map((t, i) => (i === at ? change(t) : t)) };
}
