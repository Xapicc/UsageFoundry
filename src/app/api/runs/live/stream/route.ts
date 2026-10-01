// Relative, not "@/lib/…": tsconfig.test.json emits plain CommonJS and nothing
// rewrites the path alias at runtime, so a file with a test beside it has to
// import the way src/lib and the tested components already do.
import {
  activeRuns,
  runEvents,
  subscribeAll,
  subscribeToolActivity,
  toolActivity,
  type PersistedRunEvent,
} from "../../../../../lib/orchestrator";
import {
  LIVE_REPLAY_BYTE_BUDGET,
  boundTail,
  clipForTile,
  diffRoster,
  liveCounts,
  replayShare,
  sameCounts,
} from "../../../../../lib/liveStream";
import {
  LIVE_TAIL_EVENTS,
  type LiveCountsDTO,
  type LiveFrameDTO,
} from "../../../../../lib/apiTypes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * How often the set of runs followed is checked against the table, and the
 * heartbeat that keeps a proxy from dropping the connection — one timer for
 * both, at the per-run route's 15 seconds.
 */
const RECONCILE_MS = 15_000;

/**
 * Server-sent events for every running run at once — `/runs/live`'s one
 * connection.
 *
 * **One stream for the page, never one per tile.** This server speaks HTTP/1.1
 * (`next start` and the standalone `server.js` are both `http.createServer`),
 * and a browser holds about six connections per origin over it. A page that
 * opened `/api/runs/[id]/stream` for each of ten running runs would hold all six
 * and queue the rest — and every other request the tab makes, the figures poll
 * included, would queue behind them.
 *
 * What it carries, every frame a `LiveFrameDTO`: on connect, the strip's
 * counts, then each running run's tail as one `join` frame, then `ready` naming
 * them all; after that, each followed run's events as they are written, its
 * open tool calls, `join` and `leave` as runs start and stop running, and the
 * counts again whenever a status moves.
 *
 * **No frame carries an `id:`, and a reconnect replaces each tail rather than
 * resuming it.** The per-run route's `Last-Event-ID` works because one run's
 * events arrive in id order, so the last id seen is a complete statement of
 * what the client holds. Here a `join` sent mid-stream replays a run's history
 * after newer events of other runs have gone out, so no single number states
 * what a client holds, and the one the browser would send back would replay or
 * skip events depending on which run joined last. A tile holds at most
 * `LIVE_TAIL_EVENTS` lines, so a fresh replay is exactly the state the tile
 * would be in had the connection never dropped, at a cost the byte budget
 * bounds. The client replaces a tail on `join`, and drops a tile on `ready`
 * when its run is not named — a run that ended while the connection was down.
 *
 * **Never `jsonMaybeGzipped`, and never any encoding at all**, for the reason
 * the per-run route gives: a deflate buffer holds each frame until the next one
 * pushes it out.
 */
export async function GET(req: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // The per-run route's two flags, for its reason: a failed `enqueue` must
      // not disarm the cleanup `abort` is about to do.
      let writable = true;
      let cleaned = false;

      const write = (bytes: Uint8Array) => {
        if (!writable) return;
        try {
          controller.enqueue(bytes);
        } catch {
          writable = false;
        }
      };
      const send = (frame: LiveFrameDTO) =>
        write(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      const sizeOf = (e: PersistedRunEvent) =>
        encoder.encode(JSON.stringify(e)).byteLength;

      /** Followed runs, each with its tool-activity unsubscribe. */
      const following = new Map<string, () => void>();
      let counts: LiveCountsDTO | null = null;

      const join = (runId: string, share: number) => {
        const history = runEvents(runId, 0, LIVE_TAIL_EVENTS);
        const { kept, droppedForBytes } = boundTail(
          history.events.map(clipForTile),
          share,
          sizeOf,
        );
        send({
          kind: "join",
          runId,
          events: kept,
          dropped: history.dropped + droppedForBytes,
          tools: toolActivity(runId),
        });
        following.set(
          runId,
          subscribeToolActivity(runId, (tools) => send({ kind: "tools", runId, tools })),
        );
      };

      const leave = (runId: string) => {
        following.get(runId)?.();
        following.delete(runId);
        send({ kind: "leave", runId });
      };

      // Synchronous from the table read to the last `join`, like the per-run
      // route's replay-then-subscribe: nothing can be emitted in between, so a
      // run's tail and the events forwarded after it neither overlap nor gap.
      const reconcile = (): string[] => {
        const active = activeRuns();
        const next = liveCounts(active);
        if (!sameCounts(counts, next)) {
          counts = next;
          send({ kind: "counts", counts: next });
        }
        const running = active.filter((r) => r.status === "running").map((r) => r.id);
        const { joined, left } = diffRoster(following.keys(), running);
        for (const runId of left) leave(runId);
        const share = replayShare(LIVE_REPLAY_BYTE_BUDGET, joined.length);
        for (const runId of joined) join(runId, share);
        return running;
      };

      send({ kind: "ready", runIds: reconcile() });

      // A status event is checked on the next turn rather than inside the
      // listener. The listener runs inside `emit`, on the run loop's own call
      // stack, so a table read there is the run loop's latency and a throw
      // there is the run loop's exception. Deferred, the read also sees
      // whatever the writer did after emitting. Events of a followed run are
      // forwarded in the listener itself — that is only a send.
      let pending: ReturnType<typeof setImmediate> | null = null;
      const reconcileSoon = () => {
        if (pending !== null || cleaned) return;
        pending = setImmediate(() => {
          pending = null;
          if (cleaned) return;
          try {
            reconcile();
          } catch (err) {
            // Off the run loop's stack, so nothing above this would catch it
            // but the process. The next status event or tick tries again.
            console.error("[runs/live/stream] reconcile failed:", err);
          }
        });
      };

      const unsubscribe = subscribeAll((e) => {
        if (following.has(e.runId)) {
          send({ kind: "event", runId: e.runId, event: clipForTile(e) });
        }
        if (e.kind === "status") reconcileSoon();
      });

      const heartbeat = setInterval(() => {
        reconcileSoon();
        write(encoder.encode(": ping\n\n"));
      }, RECONCILE_MS);
      heartbeat.unref?.();

      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        writable = false;
        clearInterval(heartbeat);
        if (pending !== null) clearImmediate(pending);
        unsubscribe();
        for (const unsubscribeTools of following.values()) unsubscribeTools();
        following.clear();
        try {
          controller.close();
        } catch {
          /* already closed by the runtime */
        }
      };

      req.signal.addEventListener("abort", cleanup);
      if (req.signal.aborted) cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
