"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { WaitingDTO } from "@/lib/apiTypes";
import { jsonRequest } from "@/lib/jsonRequest";
import { startPoll } from "@/lib/poll";
import { waitingView } from "./waitingView";

/**
 * What is waiting on the operator, as words and numbers, each with the page
 * where it is acted on. Nothing here is drawn: no meter, no badge, no tone —
 * a count is either something to go and do or it is not on the line.
 *
 * It polls its own light route and not the dashboard's `/api/usage`, because
 * none of this is in a transcript, and a strip that waited on the transcript
 * scan would say nothing while that was slow. The dashboard hands it its own
 * cadence, which is the one thing they share.
 *
 * While nothing has been read it holds the height of the line it will become,
 * so the card below does not move when the answer lands. One line, and 12px
 * under it rather than the page's 16: at 1280×800 the dashboard fits to within
 * a few pixels, and this is the line that had to be paid for.
 */
export function WaitingOnYou({ intervalMs }: { intervalMs: number }) {
  const [waiting, setWaiting] = useState<WaitingDTO | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    const read = async () => {
      const res = await jsonRequest<WaitingDTO>("/api/waiting");
      if (!live) return;
      if (res.ok) {
        setWaiting(res.data);
        setFailed(false);
      } else {
        setFailed(true);
      }
    };
    const stop = startPoll(read, intervalMs);
    return () => {
      live = false;
      stop();
    };
  }, [intervalMs]);

  const view = waitingView(waiting, failed);

  return (
    <div className="mb-3 min-h-5 text-sm">
      {view.kind === "failed" && <p>Could not read what is waiting on you.</p>}
      {view.kind === "quiet" && <p className="text-ink-muted">Nothing is waiting on you.</p>}
      {view.kind === "items" && (
        <ul aria-label="Waiting on you" className="flex flex-wrap gap-x-4 gap-y-1 max-md:gap-y-0">
          {view.items.map((item) => (
            <li key={item.key}>
              {/* 44px below the breakpoint, the app's touch floor. Padding on
                  the link itself, since a taller `li` would leave the extra
                  unclickable — and not a flex box, which drops the space
                  between the figure and its words. */}
              <Link href={item.href} className="max-md:block max-md:py-3">
                {item.count !== null && (
                  <>
                    <span className="font-medium tabular-nums">{item.count}</span>{" "}
                  </>
                )}
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
