import { db } from "./db";
import {
  INSTALL_WINDOW_MS,
  evaluateInstallBudget,
  installBudgetIsOff,
  normalizeInstallBudget,
  type BudgetVerdict,
  type InstallBudgetPolicy,
  type InstallProgress,
} from "./budget";
import { telemetrySpendSince } from "./otlp";
import { getSettings } from "./settings";

/**
 * What this installation has spent, and whether it may start anything else.
 *
 * Its own module rather than a corner of `orchestrator.ts` because all five
 * doors read it and they live in four different files — `orchestrator.ts`
 * (`createRun` and the pre-cycle guard), `workflows.ts` (`startWorkflow`,
 * `startBlockTurn`), `chat.ts` (`sendChatMessage`) — and the last two already
 * import the first, so a home in any one of them would be an import cycle
 * waiting to happen. It reads the database and nothing else: the *decision* is
 * `evaluateInstallBudget`, which is pure and unit-tested beside the run and
 * instance guards.
 *
 * **No new cost source.** Every figure here is one this app already records:
 * `runs.spent_usd` and `runs.spent_usd_est`, `workflow_instance_blocks.cost_usd`,
 * `chat_turn_spend.cost_usd` (the same money `chat_sessions.cost_usd` totals,
 * dated per turn so a day's window can be taken out of it), and — for cycles in
 * flight — `telemetrySpendSince`,
 * through the same one door and with the same per-run, per-cycle bound the live
 * run guard and the instance guard already use. None of it reaches
 * `buildSnapshot()`, `runs.spent_usd` or any existing meter; this is its own
 * reading, with the same display-versus-guard split everything else here makes.
 */

/** Where the rolling window starts. */
function windowStart(now: number): number {
  return now - INSTALL_WINDOW_MS;
}

/**
 * The install's spend across the rolling window, measured and guarded.
 *
 * **A run contributes its whole spend if it was still going inside the window.**
 * `runs.spent_usd` is one figure for a whole run and this app records no
 * per-hour breakdown of it, so a run that started 30 hours ago and finished an
 * hour ago is counted in full. That over-counts, which is the safe direction for
 * a ceiling and the wrong one for a report — which is why this feeds a guard and
 * a card of its own and never a dashboard meter or a period rollup. The settings
 * copy says so.
 *
 * **But over-counting has to stay bounded, and every row here says which instant
 * bounds it.** A row that has nothing but a start is inside the window by
 * definition; one that stopped spending has to name when.
 *
 * - A run: `finished_at`, or `paused_at` while the row is still `paused`. A
 *   parked run deliberately has no `finished_at` — it is not finished, it is
 *   waiting for the 5-hour window and keeps its folder and session — so
 *   bounding on that column alone counted its whole spend for ever. Three runs
 *   parked at $40 each read $120 against a $100 ceiling on every call, and
 *   nothing could start, resume or continue while they stayed parked: the
 *   refusal says spend will age out of the window, and this was the one shape
 *   where it never would. The status test is load-bearing and not decoration —
 *   nothing clears `paused_at` on the way out of a park, so a run that parked
 *   yesterday and is spending right now still carries it, and a bare
 *   `COALESCE(finished_at, paused_at)` would drop the live spender out of the
 *   reading. Both instants null is a run that has never stopped, counted whole.
 * - A block: `finished_at`, or `started_at` while it has none. Every UPDATE
 *   that adds to `workflow_instance_blocks.cost_usd` writes `finished_at` in
 *   the same statement, so nothing live is dropped by this and the case it
 *   bounds is the one where a settled block is put back to `waiting` with its
 *   `finished_at` cleared and its accumulated cost kept.
 * - A chat: the `ts` of each `chat_turn_spend` row. `chat_sessions.cost_usd` is
 *   a running total over the life of a thread and summing it bounded on
 *   `updated_at` charged that whole history to whichever window the latest
 *   message landed in — see the table's own note in `db.ts`.
 */
export function installSpend(now = Date.now()): InstallProgress {
  const since = windowStart(now);

  const runs = db()
    .prepare(
      `SELECT id, status, spent, est, cycleStartedAt
         FROM (SELECT id, status, spent_usd AS spent, spent_usd_est AS est,
                      active_started_at AS cycleStartedAt,
                      COALESCE(finished_at,
                               CASE WHEN status = 'paused' THEN paused_at END)
                        AS stoppedAt
                 FROM runs)
        WHERE stoppedAt IS NULL OR stoppedAt >= ?`,
    )
    .all(since) as Array<{
    id: string;
    status: string;
    spent: number;
    est: number;
    cycleStartedAt: number | null;
  }>;

  let spentUSD = 0;
  let spentGuardUSD = 0;
  for (const run of runs) {
    spentUSD += run.spent;
    spentGuardUSD += run.spent + run.est;
    // `running` alone, for the reason `instanceSpend` bounds it that way and
    // `fmtCycleInFlight` refuses the column on any other status: nothing clears
    // `active_started_at` when the container dies mid-cycle, so a terminal row
    // can still name a cycle that ended hours ago.
    if (run.status === "running" && run.cycleStartedAt !== null) {
      spentGuardUSD += telemetrySpendSince(run.id, run.cycleStartedAt).costUSD;
    }
  }

  // An orchestrator block's deciding turn: measured money this app spent that no
  // run row records, exactly as `instanceSpend` counts it.
  const blocks = db()
    .prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM workflow_instance_blocks" +
        " WHERE COALESCE(finished_at, started_at) IS NULL" +
        " OR COALESCE(finished_at, started_at) >= ?",
    )
    .get(since) as { spent: number };

  // And the orchestrator chat, which passes through no `evaluateBudget` at all
  // and is bounded only by `chatTurnBudgetUSD` and the clock. Per turn rather
  // than per thread: a thread is open for weeks and the window is a day.
  //
  // Split by `estimated`, because the two are different kinds of number and the
  // reading has to keep them apart exactly as it does for a run. A settled turn
  // carries the CLI's own `total_cost_usd` and is money this app measured; a
  // row a turn left behind when it was cut off — a cancel, a timeout, a restart
  // — carries this app's own price for the tokens the CLI reported, which is a
  // guard figure. Folding the second into `spentUSD` would put a derived number
  // into the shown one, and dropping it would leave the ceiling believing money
  // it watched being spent was never spent at all.
  const chats = db()
    .prepare(
      "SELECT COALESCE(SUM(CASE WHEN estimated = 0 THEN cost_usd END), 0) AS measured," +
        " COALESCE(SUM(CASE WHEN estimated = 1 THEN cost_usd END), 0) AS est" +
        " FROM chat_turn_spend WHERE ts >= ?",
    )
    .get(since) as { measured: number; est: number };

  // The turn happening *right now*, which no row records until it settles.
  // This is B4's actual subject: the ceiling used to be read once, at
  // admission, so a turn admitted at 99% could run for ten minutes past it and
  // a turn admitted before three runs finished ran against a figure that had
  // moved. `chat.ts` writes this every half-second while a turn produces
  // output; it is a guard figure and is bounded on `status` rather than on a
  // clock, because a `thinking` row with an estimate on it is by definition a
  // turn that has not settled.
  const live = db()
    .prepare(
      "SELECT COALESCE(SUM(turn_cost_est), 0) AS est FROM chat_sessions" +
        " WHERE status = 'thinking'",
    )
    .get() as { est: number };

  const other = blocks.spent + chats.measured;
  return {
    spentUSD: spentUSD + other,
    spentGuardUSD: spentGuardUSD + other + chats.est + live.est,
  };
}

/** The ceiling as configured, `null` meaning off. */
export function installBudget(): InstallBudgetPolicy {
  return normalizeInstallBudget({
    maxInstallCostUSD: getSettings().installDailyCostLimitUSD,
  });
}

/**
 * The verdict every door reads: may this install start something that spends?
 *
 * Returns `null` when the ceiling is off, so a caller's ordinary path is one
 * settings read and out — and so the doors can say "nothing to check" rather
 * than pretending to have checked.
 */
export function installBudgetVerdict(
  now = Date.now(),
): (BudgetVerdict & { allowed: false }) | null {
  const policy = installBudget();
  if (installBudgetIsOff(policy)) return null;
  const verdict = evaluateInstallBudget(policy, installSpend(now));
  return verdict.allowed ? null : verdict;
}

/** The same, as the sentence a door with an error channel shows. */
export function installBudgetRefusal(now = Date.now()): string | null {
  return installBudgetVerdict(now)?.reason ?? null;
}

/** What the dashboard draws: the reading, the ceiling and what it covers. */
export interface InstallSpendReport extends InstallProgress {
  /** null when no ceiling is configured — the meter is indeterminate, not 0%. */
  limitUSD: number | null;
  windowHours: number;
}

export function installSpendReport(now = Date.now()): InstallSpendReport {
  return {
    ...installSpend(now),
    limitUSD: installBudget().maxInstallCostUSD,
    windowHours: INSTALL_WINDOW_MS / 3_600_000,
  };
}
