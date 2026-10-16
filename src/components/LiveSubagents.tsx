"use client";

import type { LiveSubagentsDTO } from "@/lib/apiTypes";
import { fmtDuration } from "@/lib/format";
import { Spinner } from "@/components/ui/Log";

/**
 * A running run's sub-agents on its `/runs/live` tile: how many are running,
 * how many have finished this work cycle, and one row per running one with how
 * long it has been at it.
 *
 * The roster is the server's (`liveSubagents.ts`), sent whole on the tile's
 * `join` and again whenever it changes, so a page opened mid-run draws what is
 * running rather than what its 50-line tail happens to mention.
 *
 * **Nothing at all for a cycle that has delegated nothing**, which is most of
 * them, and one line once everything it started has finished — a box that is
 * empty on most tiles would be the loudest thing on the page.
 *
 * Beside the open-call strip, not instead of it. A foreground delegation older
 * than the CLI's first heartbeat is on both: the strip is what the cycle is
 * inside, and it carries the one state this does not — a sub-agent retrying its
 * API call — where this is who is working, including the background agents the
 * strip has already let go of.
 */
export function LiveSubagents({
  subagents,
  now,
}: {
  subagents: LiveSubagentsDTO;
  now: number;
}) {
  const { running, finished } = subagents;
  if (running.length === 0 && finished === 0) return null;

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
        <span className="font-semibold text-ink">Sub-agents</span>
        <span className="tabular-nums text-ink-muted">
          {running.length === 0 ? "none running" : `${running.length} running`}
          {finished > 0 && ` · ${finished} finished this work cycle`}
        </span>
      </div>
      {running.length > 0 && (
        <ul className="mt-1" aria-label="Sub-agents running">
          {running.map((agent) => (
            <li key={agent.toolUseId} className="flex min-w-0 items-baseline gap-2 py-0.5">
              {/* The clock in a fixed gutter, so rows that differ in how long
                  they have run still line their names up. Blank rather than
                  zero for a start nobody saw: see `LiveSubagentDTO.startedAt`. */}
              <span className="flex w-16 shrink-0 items-center gap-1.5 text-2xs tabular-nums text-ink-faint">
                <Spinner />
                {agent.startedAt !== null && fmtDuration(Math.max(0, now - agent.startedAt))}
              </span>
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-xs">
                <span className="shrink-0 font-medium text-ink">
                  {agent.agentType ?? "sub-agent"}
                </span>
                {agent.description !== null && (
                  <span className="min-w-0 truncate text-ink-muted" title={agent.description}>
                    {agent.description}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-2xs text-ink-faint">
                {agent.background ? "background" : "foreground"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
