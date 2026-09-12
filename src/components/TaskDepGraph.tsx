"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import {
  NODE_H,
  NODE_W,
  autoLayout,
  edgeGeometry,
  layoutBounds,
  linkKey,
} from "@/lib/canvasGraph";
import type { TaskDepGraphEdge, TaskDepGraphNode } from "@/lib/taskDepGraph";
import { TASK_STATUS_TONE } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";

/**
 * One task's neighbourhood, drawn.
 *
 * **It draws and it does not write.** Every gesture on this surface is a
 * navigation: a node is a link to that task's own page and there is nothing else
 * to press. Drawing an edge and taking one away are the form below it, which is
 * a deliberate split rather than an unfinished canvas — `WorkflowCanvas` is an
 * editor because a workflow has no other surface, where a task's edges have a
 * page each and a list that names them in words. A canvas that could delete an
 * ordering would put the one write on this board that an agent may not make
 * behind a drag nobody can see afterwards.
 *
 * **The arrangement is `autoLayout`'s and nothing here stores a position.** The
 * arrow runs from the task that happens first to the one that waits for it, so
 * the layered left-to-right arrangement reads as the ordering itself: everything
 * to the left of a node is in front of it. Nobody has arranged these graphs and
 * nobody will — there is no drag and no `positions` column — so the derived
 * arrangement is the only one, which is exactly the case `autoLayout` was
 * written for.
 *
 * **Nothing on this surface is coloured by status.** `conventions.md`'s rule:
 * a mark's colour carries which *thing* it is, never how that thing is doing,
 * because a reader who has learnt that a red edge means trouble on one surface
 * reads every red edge that way. There is one kind of node and one kind of edge
 * here, so the whole surface is drawn in the border tones, and the accent — the
 * app's "this is the one you are looking at" colour, not a tone — marks the
 * anchor and the edges that touch it. A node's status is a `Badge`, which is
 * where a status tone belongs and where every other surface here already reads
 * one.
 *
 * **Hidden below the `md` breakpoint**, `WorkflowCanvas`'s decision and its
 * reason: the sheet is at least two node-widths across, so a reader at 390px
 * would pan two axes through a window onto a third of it, and `overflow-auto`
 * is the only thing keeping the *page* from scrolling sideways while they did.
 * The lists under it name every edge this task has either way, in words, with
 * the same links — so what the breakpoint costs is the arrangement and not the
 * information.
 */

export function TaskDepGraph({
  anchorId,
  nodes,
  edges,
}: {
  anchorId: string;
  nodes: readonly TaskDepGraphNode[];
  edges: readonly TaskDepGraphEdge[];
}) {
  const positions = autoLayout(nodes, edges);
  const { width, height } = layoutBounds(positions);
  const sheet = useRef<HTMLDivElement>(null);
  const anchorAt = positions.get(anchorId);
  const anchorX = anchorAt?.x ?? 0;
  const anchorY = anchorAt?.y ?? 0;

  /**
   * Open centred on the anchor rather than at the origin.
   *
   * The layout puts everything this task waits for to the *left* of it, so a
   * sheet left at scroll zero shows the dependencies and hides the task they
   * are for — which on a chain three deep is the one node the page exists to
   * draw. `scrollLeft` on the scroller rather than `scrollIntoView` on the
   * node, because that call walks up and would scroll the page to it too.
   */
  useEffect(() => {
    const el = sheet.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, anchorX + NODE_W / 2 - el.clientWidth / 2);
    el.scrollTop = Math.max(0, anchorY + NODE_H / 2 - el.clientHeight / 2);
  }, [anchorX, anchorY]);

  return (
    <div
      ref={sheet}
      className="relative max-h-[62vh] overflow-auto bg-inset max-md:hidden"
    >
      <div className="dot-grid relative" style={{ width, height }}>
        <svg
          className="pointer-events-none absolute left-0 top-0"
          width={width}
          height={height}
          aria-hidden
        >
          {edges.map((edge) => {
            const from = positions.get(edge.from);
            const to = positions.get(edge.to);
            if (!from || !to) return null;
            const geometry = edgeGeometry(from, to);
            const atAnchor = edge.from === anchorId || edge.to === anchorId;
            return (
              <g key={linkKey(edge)}>
                <path
                  d={geometry.d}
                  fill="none"
                  strokeWidth={atAnchor ? 2 : 1.25}
                  className={atAnchor ? "stroke-accent" : "stroke-line-strong"}
                />
                {/* A plain triangle rather than an SVG marker, `edgeGeometry`'s
                    note: a marker cannot take the path's own stroke colour in
                    Chromium, and the curve arrives horizontally by
                    construction so there is no orientation to work out. */}
                <path
                  d={`M ${geometry.tip.x} ${geometry.tip.y} l -8 -4.5 l 0 9 z`}
                  className={atAnchor ? "fill-accent" : "fill-line-strong"}
                />
              </g>
            );
          })}
        </svg>

        {nodes.map((node) => {
          const at = positions.get(node.id);
          if (!at) return null;
          const isAnchor = node.id === anchorId;
          const card = `flex h-full flex-col rounded-lg border bg-surface p-2.5 shadow-e1 ${
            isAnchor
              ? "border-accent-line ring-[3px] ring-ring"
              : "ui-transition border-line no-underline hover:border-accent-line"
          }`;
          const body = (
            <>
              <span className="line-clamp-2 text-sm font-medium text-ink">
                {node.title}
              </span>
              {node.place && (
                <span className="mt-0.5 block truncate text-xs text-ink-faint">
                  {node.place}
                </span>
              )}
              <span className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
                <Badge tone={TASK_STATUS_TONE[node.status]}>{node.status}</Badge>
                {isAnchor && (
                  // Said in words as well as drawn, because the halo is a
                  // colour and a graph of four boxes is exactly where a reader
                  // who cannot tell two border tones apart loses the one thing
                  // this drawing is about.
                  <span className="text-xs text-ink-faint">This task</span>
                )}
              </span>
            </>
          );

          return (
            <div
              key={node.id}
              style={{ left: at.x, top: at.y, width: NODE_W, height: NODE_H }}
              className="absolute"
            >
              {isAnchor ? (
                // Not a link: it would open the page it is already on. The
                // anchor is the one node here that is a statement rather than a
                // destination.
                <div className={card}>{body}</div>
              ) : (
                <Link href={`/tasks/${node.id}`} className={card}>
                  {body}
                </Link>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
