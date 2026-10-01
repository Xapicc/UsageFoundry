"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { LiveCountsDTO, LiveFrameDTO, LiveRunDTO, LiveRunsDTO } from "@/lib/apiTypes";
import { pollFailureMessage } from "@/lib/format";
import { jsonRequest } from "@/lib/jsonRequest";
import { EMPTY_LIVE, applyLiveFrame, type LiveState } from "@/lib/liveTiles";
import { LiveRunTile } from "@/components/LiveRunTile";
import { Card, Empty, SkeletonText } from "@/components/ui/Card";
import { Notice } from "@/components/ui/Notice";

/**
 * Every running run at once: one tile each, with its spend, its context and the
 * tail of its log.
 *
 * A sub-route of Runs rather than a pane (`ui-density-audit.md` §1.2), reached
 * from the Live button on the runs list. `activePane` matches on a path
 * segment, so the sidebar keeps Runs highlighted here without learning about
 * it, and `toolbarTitle` names it before the line that would call it a run.
 *
 * Two channels, the run page's split: **one** stream for every tile's log and
 * for which runs have tiles at all, and a poll for the figures. Never a stream
 * per tile — `/api/runs/live/stream` says why that stalls the tab.
 */

/**
 * The figures poll. The run page reads one run every 3s; this reads all of
 * them in one request, and only while there is a tile to draw them on.
 */
const POLL_MS = 5_000;

const STRIP: readonly (keyof LiveCountsDTO)[] = ["running", "queued", "paused"];

export default function LiveRunsPage() {
  const [live, setLive] = useState<LiveState>(EMPTY_LIVE);
  const [stream, setStream] = useState<"open" | "retrying" | "closed">("open");
  const [figures, setFigures] = useState<ReadonlyMap<string, LiveRunDTO>>(new Map());
  const [pollError, setPollError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const es = new EventSource("/api/runs/live/stream");
    es.onopen = () => setStream("open");
    // `EventSource` reconnects on its own after a dropped connection, and the
    // stream then replays every running run's tail for the reducer to replace.
    // An answer it cannot use — a 401 once the session lapses — closes it for
    // good instead, and saying "reconnecting" over that would be a promise.
    es.onerror = () =>
      setStream(es.readyState === EventSource.CLOSED ? "closed" : "retrying");
    es.onmessage = (msg) => {
      const frame = JSON.parse(msg.data) as LiveFrameDTO;
      setLive((state) => applyLiveFrame(state, frame));
    };
    return () => es.close();
  }, []);

  // Keyed on which runs have tiles, so a run that joins is read at once rather
  // than up to a poll later, and a page with nothing running polls nothing. The
  // stream is what re-arms it: the next `join` changes the key.
  const tileKey = live.tiles.map((t) => t.runId).join(",");
  useEffect(() => {
    if (tileKey === "") {
      setFigures(new Map());
      setPollError(null);
      return;
    }
    let mounted = true;
    const load = async () => {
      const answer = await jsonRequest<LiveRunsDTO>("/api/runs/live");
      if (!mounted) return;
      if (!answer.ok) {
        setPollError(pollFailureMessage(answer.status, answer.error));
        return;
      }
      setPollError(null);
      setFigures(new Map(answer.data.runs.map((r) => [r.id, r])));
    };
    void load();
    const poll = setInterval(load, POLL_MS);
    return () => {
      mounted = false;
      clearInterval(poll);
    };
  }, [tileKey]);

  // Durations and open tool calls count up between polls; nothing does when
  // there is nothing running.
  const counting = live.tiles.length > 0;
  useEffect(() => {
    if (!counting) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(tick);
  }, [counting]);

  return (
    <>
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Live runs</h1>

      {/* Each count goes to the runs list, whose "In flight" band — the first
          thing on it — holds all three statuses. The list has no filter by
          status to land on. */}
      <p className="mb-4 flex min-h-5 flex-wrap gap-x-4 text-sm tabular-nums">
        {live.counts !== null &&
          STRIP.map((status) => (
            <Link
              key={status}
              href="/runs"
              className="max-md:inline-flex max-md:min-h-11 max-md:items-center"
            >
              {live.counts?.[status]} {status}
            </Link>
          ))}
      </p>

      <div role="alert">
        {stream === "retrying" && (
          <Notice tone="warn" quiet>
            Live updates lost — reconnecting.
          </Notice>
        )}
        {stream === "closed" && (
          <Notice tone="danger">Live updates stopped. Reload the page to try again.</Notice>
        )}
        {pollError && <Notice tone="danger">{pollError}</Notice>}
      </div>

      <p className="sr-only" aria-live="polite">
        {live.ready
          ? `${live.tiles.length} run${live.tiles.length === 1 ? "" : "s"} running`
          : ""}
      </p>

      {!live.ready ? (
        <div aria-busy="true">
          <span className="sr-only">Reading runs…</span>
          <Card emphasis="quiet">
            <SkeletonText lines={4} />
          </Card>
        </div>
      ) : live.tiles.length === 0 ? (
        <Card emphasis="quiet">
          <Empty>
            Nothing is running. <Link href="/runs">Back to runs</Link>
          </Empty>
        </Card>
      ) : (
        // Columns from the pane's width rather than the window's — the sidebar
        // takes a share of the window that a viewport breakpoint cannot see.
        // `min(100%, …)` is what keeps one column from overflowing a phone.
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,24rem),1fr))] gap-4">
          {live.tiles.map((tile) => (
            <LiveRunTile
              key={tile.runId}
              tile={tile}
              run={figures.get(tile.runId) ?? null}
              now={now}
            />
          ))}
        </div>
      )}
    </>
  );
}
