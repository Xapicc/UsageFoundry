/**
 * Calls `load` now, and again `intervalMs` after each call settles, until the
 * returned function is called. The return is an effect's cleanup.
 *
 * A timeout re-armed on settle rather than a `setInterval`, so a page never has
 * two of its own polls out at once. An interval fires whether or not the last
 * answer arrived: a route slower than the period — `/api/runs/live` took 5.7-18s
 * on a process's first transcript scan against a 5s poll — gets a second request
 * while the first is out, the two answers land in whichever order the server
 * finishes them, and the page draws the older one last with nothing on it to say
 * so. The cost is a period of interval-plus-latency instead of interval, which
 * on a slow route is the point.
 *
 * Stopping holds across a load that is in flight when it happens: the re-arm
 * after that load settles is skipped, or an unmounted page would go on polling
 * for the life of the tab. Discarding that load's *answer* stays the caller's
 * job, through the `alive`/`mounted` flag each page already closes over.
 *
 * `load` is expected to report its own failures, as every page's does. One that
 * rejects anyway still re-arms — a poll that died on one bad answer would freeze
 * the page on its last good one — and its rejection is left unhandled rather
 * than caught here, so it still reaches the console.
 */
export function startPoll(load: () => Promise<void>, intervalMs: number): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    try {
      await load();
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  };
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
