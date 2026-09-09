"use client";

import type { RunToolActivityDTO } from "@/lib/apiTypes";
import { fmtDuration } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Log";

/**
 * What the run is inside right now, over the log.
 *
 * The one thing on this page that is not derived from `run_events`: the CLI
 * says a tool is still running every 30 seconds and this app keeps those in
 * memory rather than as rows (`liveTools` in `orchestrator.ts` has the
 * reasoning), so the strip appears while a call is open and is gone the moment
 * it answers. Nothing here fetches or polls — the frames arrive on the same
 * EventSource the log does.
 *
 * **It exists for the silence.** A cycle inside a twenty-minute build prints
 * nothing for twenty minutes, and a log whose last line is four screens up and
 * eight minutes old is indistinguishable from a wedged child — which is a real
 * state this app has a watchdog for. Naming the call and counting up is the
 * difference between the two.
 *
 * A run with nothing open renders nothing at all, which is the ordinary case:
 * most tool calls answer inside the first 30 seconds and never produce one of
 * these.
 */
export function RunActivity({
  tools,
  /**
   * The run can still produce output. A terminal run's strip is cleared at the
   * cycle's end, but a page that was already open when the container went down
   * would hold the last frame it saw — and a clock still counting up against a
   * run that stopped is this app timing something it has no reason to believe
   * is still going.
   */
  active,
  now,
}: {
  tools: readonly RunToolActivityDTO[];
  active: boolean;
  now: number;
}) {
  if (!active || tools.length === 0) return null;

  return (
    <div className="mb-3 rounded-sm border border-line bg-inset px-3.5 py-2">
      {/* Announced when the *set* changes and never on the clock: the duration
          below re-renders every second, and a live region reading it out would
          say "Bash, four minutes twelve seconds" sixty times a minute. */}
      <p className="sr-only" aria-live="polite">
        {tools.length === 1
          ? `Still running: ${tools[0].name}`
          : `Still running: ${tools.map((t) => t.name).join(", ")}`}
      </p>
      <ul className="flex flex-col gap-1.5">
        {tools.map((tool) => (
          <li
            key={tool.toolUseId}
            className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted"
          >
            <Spinner />
            <Badge tone={tool.retry === null ? "accent" : "warn"}>
              {tool.name}
            </Badge>
            {/* The call's own arguments, as the log line for it already read.
                A truncating line, so the strip cannot be the reason the pane
                scrolls sideways — `min-w-0` on the flex child is the half of
                that which `truncate` alone does not do.

                Its own line below the breakpoint, which is additive and leaves
                every wider window pixel-identical. Measured at the 358px a
                390px phone leaves inside the pane: sharing the line with a
                retry left the command 63px, which is six characters of a path
                and worse than not drawing it. */}
            {tool.command !== null && (
              <span className="mono min-w-0 flex-1 truncate max-md:order-last max-md:basis-full">
                {tool.command}
              </span>
            )}
            {/* A retry is the CLI waiting on a wall rather than a tool doing
                work, and the two must not read alike: a sub-agent on its third
                attempt is a run that may be about to park, not a slow build. */}
            {tool.retry !== null && (
              <span className="text-warn">
                retrying, attempt {tool.retry.attempt} of{" "}
                {tool.retry.maxRetries}
              </span>
            )}
            <span className="ml-auto tabular-nums">
              {fmtDuration(Math.max(0, now - tool.startedAt))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
