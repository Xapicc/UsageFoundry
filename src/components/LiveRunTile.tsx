"use client";

import Link from "next/link";
import { useLayoutEffect, useMemo, useRef } from "react";
import type { LiveRunDTO } from "@/lib/apiTypes";
import type { LiveTile } from "@/lib/liveTiles";
import { describeEvent } from "@/lib/logLine";
import {
  fmtClock,
  fmtDuration,
  fmtLiveCycle,
  folderLabel,
  shortId,
} from "@/lib/format";
import { ContextOccupancy } from "@/components/ContextOccupancy";
import { LiveRunFigures } from "@/components/LiveRunFigures";
import { Meter } from "@/components/Meter";
import { RunActivity } from "@/components/RunActivity";
import { Card, Empty, SkeletonText } from "@/components/ui/Card";
import { Log, LogLine } from "@/components/ui/Log";

/** How near the bottom still counts as following the tail — the run page's figure. */
const PINNED_PX = 40;

/**
 * One running run on `/runs/live`: who it is, its money, its context and the
 * tail of its log.
 *
 * The log half comes from the page's one stream and is here from the first
 * frame; the figures half is `run`, from the page's poll, and is null until
 * that answers. Every line is `describeEvent` into `LogLine`, the run page's
 * own path, and the open tool calls are the run page's `RunActivity`.
 */
export function LiveRunTile({
  tile,
  run,
  now,
}: {
  tile: LiveTile;
  run: LiveRunDTO | null;
  now: number;
}) {
  const lines = useMemo(
    () =>
      tile.events.flatMap((e, i) => {
        const entry = describeEvent(e);
        return entry ? [{ key: e.id ?? `${e.ts}-${i}`, ts: e.ts, entry }] : [];
      }),
    [tile.events],
  );

  // Follows the tail until the reader scrolls up, and picks it up again when
  // they scroll back down — the run page's rule, without its "jump to live"
  // button: a tile is short enough to drag back to the bottom.
  //
  // A layout effect, so the jump lands in the same task as the rows it follows.
  // A full tile trims a row off the top for every one it adds, and scroll
  // anchoring answers that by moving the reader up by the height trimmed; any
  // layout before the follow — a pointer resting on the log is enough, since
  // hovering hit-tests — then sends a scroll event that finds them one batch
  // short of the tail, and `pinned` turned false on the page's own update
  // rather than on the reader's scroll. Anchoring stays on: it is what keeps a
  // reader who *has* scrolled up looking at the same rows while the ones above
  // them are trimmed, and with it off they were carried back to the tail in
  // three events.
  const logRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = logRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines, tile.tools]);
  const onScroll = () => {
    const el = logRef.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < PINNED_PX;
  };

  return (
    <Card className="flex min-w-0 flex-col gap-3">
      <div className="min-w-0">
        {/* The way into the run, and on a phone the whole of it: padded to
            44px and handed back by the negative margin, as the runs list does
            with the same line. */}
        <Link
          href={`/runs/${tile.runId}`}
          className="block truncate font-medium text-ink hover:text-accent max-md:-my-3 max-md:py-3"
          title={run?.prompt}
        >
          {run?.prompt ?? `Run ${shortId(tile.runId)}`}
        </Link>
        {run && (
          <>
            <div
              className="mono mt-0.5 truncate text-xs text-ink-muted"
              title={run.work_dir ?? run.folder}
            >
              {folderLabel(run)}
            </div>
            <div className="mt-0.5 text-xs tabular-nums text-ink-muted">
              {fmtLiveCycle(run)}
              {run.started_at !== null && (
                <> · running {fmtDuration(now - run.started_at)}</>
              )}
            </div>
          </>
        )}
      </div>

      {run === null ? (
        <SkeletonText lines={3} />
      ) : (
        <>
          <LiveRunFigures run={run} />
          <div>
            <div className="text-xs font-semibold text-ink">Context</div>
            {run.context ? (
              <ContextOccupancy context={run.context} now={now} live compact />
            ) : (
              // `ContextOccupancy`'s own words for a run with no reading, for a
              // run with no context record at all.
              <Meter
                size="compact"
                label="Of the cycle ceiling"
                fraction={null}
                unknownHint="not measured yet"
              />
            )}
          </div>
        </>
      )}

      <Log
        ref={logRef}
        onScroll={onScroll}
        size="tile"
        label={`Event log, run ${shortId(tile.runId)}`}
      >
        {tile.dropped > 0 && (
          <div className="px-3 pb-1 text-2xs text-ink-muted">
            … {tile.dropped.toLocaleString()} earlier events not shown
          </div>
        )}
        {lines.length === 0 && (
          <div className="font-sans">
            <Empty>Waiting for the first turn…</Empty>
          </div>
        )}
        {lines.map((l) => (
          <LogLine key={l.key} entry={l.entry} timestamp={fmtClock(l.ts)} />
        ))}
        <RunActivity tools={tile.tools} active now={now} />
      </Log>
    </Card>
  );
}
