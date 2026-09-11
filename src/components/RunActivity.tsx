"use client";

import type { RunToolActivityDTO } from "@/lib/apiTypes";
import { fmtDuration } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Log";

/**
 * What the run is inside right now, as the last rows of the live log.
 *
 * The one thing in that feed that is not derived from `run_events`: the CLI
 * says a tool is still running every 30 seconds and this app keeps those in
 * memory rather than as rows (`liveTools` in `orchestrator.ts` has the
 * reasoning), so a row appears while a call is open and is gone the moment it
 * answers. Nothing here fetches or polls — the frames arrive on the same
 * EventSource the log does, without an `id:` line, and they are held in their
 * own collection rather than merged into `events`: they have no sequence
 * number, they are the whole open set on every frame, and a page that treated
 * them as rows would keep them after they stopped being true.
 *
 * **It exists for the silence.** A cycle inside a twenty-minute build prints
 * nothing for twenty minutes, and a log whose last line is four screens up and
 * eight minutes old is indistinguishable from a wedged child — which is a real
 * state this app has a watchdog for. Naming the call and counting up is the
 * difference between the two.
 *
 * Which is why it is mounted **inside** the log's scroll container but is not
 * subject to either thing that can hide a line in it:
 *
 * - *The filter.* It is rendered beside `shown` rather than out of it, so
 *   Find/Show narrows the feed and never this. A filter that silently hid a
 *   running call would be worse than the strip this replaced, because the
 *   silence is the exact state the display is for.
 * - *The scroll position.* `sticky bottom-0` keeps it on the pane's bottom
 *   edge however far up the reader has scrolled, so it can never be the row
 *   that scrolled four screens away.
 *
 * The cost it does accept is the jump-to-live button, which floats over the
 * pane's bottom-right corner while the reader is away from the tail — the one
 * state where these rows are pinned rather than simply last. It is allowed to
 * paint over them (no `z-index` here, and it comes later in the DOM), because
 * a reader who cannot get back to the tail is worse off than one whose command
 * string is covered: every fact these rows are read for — that something is
 * running, which tool, and for how long — is packed into the left gutter and
 * the badge beside it, and the command was truncating there anyway. Pressing
 * it is also what ends the overlap, since rows at the live edge are simply the
 * last of the feed and the button is gone.
 *
 * A run with nothing open renders nothing at all, which is the ordinary case:
 * most tool calls answer inside the first 30 seconds and never produce one of
 * these.
 */
export function RunActivity({
  tools,
  /**
   * The run can still produce output. A terminal run's rows are cleared at the
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
    // Opaque, and a rule above it: the feed scrolls *underneath* this while it
    // is pinned, so without both the lines passing behind would read as part of
    // the row.
    //
    // The translate is what covers the pane's own `py-2.5`. A sticky box is
    // held inside its scroll container's *content* box, so `bottom-0` leaves
    // the bottom padding below it — measured at 10px, through which the feed
    // goes on scrolling, and a line clipped to its last 10px under a rule reads
    // as a rendering fault. A negative `bottom` closes that gap only while
    // pinned and leaves it at rest, where a transform is the same 10px in both
    // states because it moves nothing in layout.
    <div className="sticky bottom-0 translate-y-2.5 border-t border-line bg-inset pb-1 pt-1.5">
      {/* Announced when the *set* changes and never on the clock: the duration
          below re-renders every second, and a live region reading it out would
          say "Bash, four minutes twelve seconds" sixty times a minute. */}
      <p className="sr-only" aria-live="polite">
        {tools.length === 1
          ? `Still running: ${tools[0].name}`
          : `Still running: ${tools.map((t) => t.name).join(", ")}`}
      </p>
      <ul>
        {tools.map((tool) => (
          <li key={tool.toolUseId} className="flex gap-2.5 px-3 py-0.5">
            {/* The log row's own left gutter, holding what the timestamp holds
                on every other row — a time. A fixed clock and a counting one
                are the same kind of fact and belong in the same column, and
                putting the elapsed figure here rather than at the right edge is
                what keeps it out from under the jump-to-live button.
                `tabular-nums` so a second ticking over cannot shift the row. */}
            <span className="flex shrink-0 items-center gap-1.5 text-2xs tabular-nums text-ink-faint">
              <Spinner />
              {fmtDuration(Math.max(0, now - tool.startedAt))}
            </span>
            <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-ink-muted">
              <Badge tone={tool.retry === null ? "accent" : "warn"}>
                {tool.name}
              </Badge>
              {/* A retry is the CLI waiting on a wall rather than a tool doing
                  work, and the two must not read alike: a sub-agent on its third
                  attempt is a run that may be about to park, not a slow build. */}
              {tool.retry !== null && (
                <span className="text-warn">
                  retrying, attempt {tool.retry.attempt} of{" "}
                  {tool.retry.maxRetries}
                </span>
              )}
              {/* The call's own arguments, as the log line for it already read.
                  A truncating line, so the row cannot be the reason the pane
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
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
