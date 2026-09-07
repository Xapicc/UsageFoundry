import fs from "node:fs";
import path from "node:path";

import { DB_PATH, PROJECTS_DIR, WORKSPACE_MOUNTS } from "./config";
import { type SchemaFault, db, schemaFaultsThisBoot } from "./db";
import { webhookHealth } from "./notify";
import { opsCounters, recentOpsEvents } from "./ops";
import { currentSnapshot, restartClosedCount } from "./orchestrator";
import { backupStore } from "./retention";
import { ownsDataDir } from "./serverLock";

/**
 * What `GET /api/status` answers with: gauges an operator or a monitor can
 * threshold, for a fleet nobody is watching.
 *
 * This is the other half of `health.ts` and the split is deliberate. Health
 * answers **"should Docker restart this"** — one boolean, cheap enough to run
 * every thirty seconds, and unauthenticated because it carries nothing but
 * counts. This answers **"what is it doing"**: queue depth, how long the oldest
 * queued run has been waiting, what the two live windows have cost, how big the
 * three stores have grown, and whether the sweeper is still sweeping.
 *
 * Same rule about the payload, for a different reason. Health's constraint
 * comes from being open; this one's comes from being pointed at a monitoring
 * system that will retain and forward it: **counts, bytes, fractions and
 * timestamps only** — no prompt text, no folder or mount path, no settings
 * value, no token, no branch name, no model. A folder path here is a leak of
 * what this install works on into whatever scrapes it.
 */

/** Runs by status — every state, so the numbers add up to the row count. */
export type RunStatusCounts = Record<string, number>;

export interface StoreUsage {
  /** The SQLite file plus its WAL and shm siblings. */
  databaseBytes: number;
  /** Every mount's `.uf-worktrees` checkout store, added together. */
  checkoutsBytes: number;
  /** The transcript tree this install parses. */
  transcriptsBytes: number;
  /**
   * True when a walk stopped at its entry cap, so the two tree figures are a
   * floor rather than a total. Said rather than implied, for the reason a
   * shortened diff says so: a plausible number that is quietly a third of the
   * real one is worse than no number.
   */
  partial: boolean;
  /** When these were last measured, since they are cached between polls. */
  measuredAt: number;
  /**
   * The fourth store, and the only one here this app does not write.
   *
   * A path would be a leak of what this install is, so this is the same reading
   * the Settings card takes with the directory's name removed: whether the
   * process could look at all, how many snapshots there are, what they weigh,
   * and how old the newest one is. The last is the number to alert on — the
   * three above it grow when something is wrong, and this one goes stale.
   */
  backups: {
    /** False means the directory could not be read, which is not "none". */
    readable: boolean;
    count: number;
    bytes: number;
    /** Seconds since the newest snapshot, or null when there is not one. */
    newestAgeSeconds: number | null;
  };
}

export interface StatusWindow {
  startsAt: number;
  endsAt: number;
  costUSD: number;
  /** The guard's own reading, which charges an unpriced model a fallback rate. */
  costGuardUSD: number;
  tokens: number;
  /** Null where no ceiling is configured and the provider answered nothing. */
  fraction: number | null;
  guardFraction: number | null;
}

export interface StatusReport {
  now: number;
  uptimeSeconds: number;
  dataDirOwned: boolean;
  runs: RunStatusCounts;
  queue: {
    /** `queued` plus `waiting` — work admitted and not yet started. */
    depth: number;
    /** Seconds the oldest `queued` run has been waiting, or null if none is. */
    oldestQueuedAgeSeconds: number | null;
  };
  windows: { session: StatusWindow; weekly: StatusWindow };
  stores: StoreUsage;
  sweeper: {
    lastTickAgeSeconds: number | null;
    failures: number;
    lastError: string | null;
  };
  liveGuard: {
    lastTickAgeSeconds: number | null;
    failures: number;
    lastError: string | null;
  };
  /**
   * The outbound notification channel — see `notify.ts`.
   *
   * Here rather than only in the table because a webhook is fire-and-forget by
   * construction, so a receiver that has been refusing every POST for a week
   * produces the same silence as a fleet with nothing wrong. This is the number
   * to alert on, and it is the condition
   * `proposals/UnattendedOperation/04-option-c-outbound-webhook.md` puts on the
   * whole feature.
   *
   * Counts and a clock, and deliberately **no error string**: a fetch failure's
   * message carries the receiver's hostname, and this payload is retained and
   * forwarded by whatever scrapes it. That text is on stdout and in
   * `webhook_deliveries`, both of which are the operator's own.
   */
  webhook: {
    /** A URL *and* a secret. Either alone sends nothing. */
    configured: boolean;
    /** Attempts since the last success. Non-zero means notifications are lost. */
    consecutiveFailures: number;
    lastAttemptAgeSeconds: number | null;
  };
  /** The newest restart reconciliation, retained rather than only logged. */
  lastBootReconcile: { at: number; closed: number; kept: number } | null;
  /**
   * Runs a restart closed that nobody has picked up yet — and the field to
   * alert on, which `lastBootReconcile.closed` is not.
   *
   * That one is the newest `boot.reconciled` row whenever it was written, so it
   * is `> 0` for ever after the first restart that closed anything: picking
   * every run up clears `runs.restart_closed` and writes no ops event, and a
   * later clean boot writes no row at all (`orchestrator.ts` only records one
   * when something was closed or kept). A monitor built on it goes red once and
   * stays red, which is the fastest way to teach an operator to ignore the one
   * condition whose whole content is *somebody must act*.
   *
   * This de-latches, because it is the same set the runs page's notice counts:
   * it falls to zero when the last one has been picked up or set aside.
   */
  restartClosedOutstanding: number;
  /**
   * What `migrate()` found wrong with the database file when this process
   * opened it: a rollback to an older image, or the residue of an interrupted
   * migration. Empty on a clean boot, which is what makes it alertable.
   *
   * Each of these is also an `ops_events` row — that is the copy a restart does
   * not erase, and the restart is when an operator comes looking. This one is
   * scoped to the process now running so that it de-latches, for the reason
   * `lastBootReconcile` above does not.
   *
   * Payload-safe under this file's rule: `detail` carries table names, column
   * names and version numbers, which are schema rather than anything an
   * operator or an agent wrote.
   */
  schemaFaults: SchemaFault[];
}

/**
 * How many directory entries one measurement may look at before it gives up.
 *
 * A checkout store holds a full working tree per slot, `node_modules` included,
 * so this walk is the one part of this route with no natural bound — measured
 * against this repository's own store it was tens of seconds of syscalls. The
 * cap is what stops a gauge from becoming the most expensive thing the server
 * does, and `partial` is what stops the resulting figure from being a quiet
 * lie: a number that stopped early must say so, exactly as a shortened diff
 * does.
 */
const WALK_ENTRY_CAP = 50_000;

interface WalkResult {
  bytes: number;
  partial: boolean;
}

/**
 * Bytes under a directory.
 *
 * **Asynchronous, and that is the point rather than a style choice.** This
 * server is one event loop shared by the run loop, the sweepers and the lock
 * heartbeat, so a synchronous walk of a checkout store is precisely the wedge
 * `/api/health` exists to detect — self-inflicted, once a minute, by the route
 * that reports on it. Every `await` here is a yield.
 *
 * Symlinks are counted by their own size and never followed: a link into the
 * mount would make this walk a repository twice, and one pointing outside would
 * make it walk the host. Anything unreadable contributes zero rather than
 * throwing — this is a gauge, and one unreadable subdirectory must not cost the
 * whole figure.
 */
async function treeBytes(dir: string, budget = { left: WALK_ENTRY_CAP }): Promise<WalkResult> {
  let bytes = 0;
  let partial = false;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return { bytes: 0, partial: false };
  }
  for (const entry of entries) {
    if (budget.left <= 0) return { bytes, partial: true };
    budget.left -= 1;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await treeBytes(full, budget);
      bytes += sub.bytes;
      partial = partial || sub.partial;
    } else {
      try {
        bytes += (await fs.promises.lstat(full)).size;
      } catch {
        /* vanished between readdir and lstat — it is a gauge */
      }
    }
  }
  return { bytes, partial };
}

function fileBytes(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * The expensive half: measured rarely, and only once at a time.
 *
 * Five minutes rather than the poll interval, because the answer moves slowly
 * (a checkout store grows when a run installs dependencies) and the measurement
 * is the costliest thing on this route. Single-flight for the same reason the
 * dashboard's poll slows down while a run is working: two monitors polling
 * together must not start two walks.
 */
const STORE_TTL_MS = 5 * 60_000;

interface StoreCache {
  value: StoreUsage;
  inFlight: Promise<StoreUsage> | null;
}

const storeCache = ((globalThis as unknown as { __ufStoreUsage?: StoreCache })
  .__ufStoreUsage ??= {
  value: {
    databaseBytes: 0,
    checkoutsBytes: 0,
    transcriptsBytes: 0,
    partial: false,
    measuredAt: 0,
    backups: { readable: false, count: 0, bytes: 0, newestAgeSeconds: null },
  },
  inFlight: null,
});

async function measureStores(now: number): Promise<StoreUsage> {
  let checkouts = 0;
  let partial = false;
  for (const mount of WORKSPACE_MOUNTS) {
    const res = await treeBytes(path.join(mount.path, ".uf-worktrees"));
    checkouts += res.bytes;
    partial = partial || res.partial;
  }
  const transcripts = await treeBytes(PROJECTS_DIR);
  const backups = await backupStore();
  return {
    databaseBytes:
      fileBytes(DB_PATH) + fileBytes(`${DB_PATH}-wal`) + fileBytes(`${DB_PATH}-shm`),
    checkoutsBytes: checkouts,
    transcriptsBytes: transcripts.bytes,
    partial: partial || transcripts.partial,
    measuredAt: now,
    backups: {
      readable: backups.readable,
      count: backups.count,
      bytes: backups.bytes,
      newestAgeSeconds:
        backups.newestAt === null
          ? null
          : Math.round((now - backups.newestAt) / 1000),
    },
  };
}

function storeUsage(now: number): Promise<StoreUsage> {
  if (storeCache.value.measuredAt > 0 && now - storeCache.value.measuredAt < STORE_TTL_MS) {
    return Promise.resolve(storeCache.value);
  }
  storeCache.inFlight ??= measureStores(now)
    .then((value) => {
      storeCache.value = value;
      return value;
    })
    .finally(() => {
      storeCache.inFlight = null;
    });
  return storeCache.inFlight;
}

function window(w: {
  startsAt: number;
  endsAt: number;
  costUSD: number;
  tokens: number;
  fraction: number | null;
  guardFraction: number | null;
  agg: { costGuardUSD: number };
}): StatusWindow {
  return {
    startsAt: w.startsAt,
    endsAt: w.endsAt,
    costUSD: w.costUSD,
    costGuardUSD: w.agg.costGuardUSD,
    tokens: w.tokens,
    fraction: w.fraction,
    guardFraction: w.guardFraction,
  };
}

export async function statusReport(now = Date.now()): Promise<StatusReport> {
  const counts = Object.fromEntries(
    (
      db()
        .prepare("SELECT status, COUNT(*) AS n FROM runs GROUP BY status")
        .all() as Array<{ status: string; n: number }>
    ).map((r) => [r.status, r.n]),
  ) as RunStatusCounts;

  const oldestQueued = db()
    .prepare("SELECT MIN(created_at) AS at FROM runs WHERE status = 'queued'")
    .get() as { at: number | null };

  // The same snapshot the guard reads, so a fraction here and a refusal in the
  // loop cannot disagree. It is the expensive call on this route; `scanUsage`
  // coalesces concurrent callers and reads incrementally from cached offsets,
  // which is what makes a per-minute poll affordable.
  const [snapshot, stores] = await Promise.all([currentSnapshot(), storeUsage(now)]);
  const ops = opsCounters();
  const boot = recentOpsEvents(1, "boot.reconciled")[0] ?? null;
  const webhook = webhookHealth();
  const age = (at: number | null) => (at === null ? null : Math.round((now - at) / 1000));

  return {
    now,
    uptimeSeconds: Math.round((now - ops.bootedAt) / 1000),
    dataDirOwned: ownsDataDir(),
    runs: counts,
    queue: {
      depth: (counts.queued ?? 0) + (counts.waiting ?? 0),
      oldestQueuedAgeSeconds: age(oldestQueued.at),
    },
    windows: {
      session: window(snapshot.session),
      weekly: window(snapshot.weekly),
    },
    stores,
    sweeper: {
      lastTickAgeSeconds: age(ops.lastSweepAt),
      failures: ops.sweepFailures,
      lastError: ops.lastSweepError,
    },
    liveGuard: {
      lastTickAgeSeconds: age(ops.lastLiveTickAt),
      failures: ops.liveTickFailures,
      lastError: ops.lastLiveTickError,
    },
    webhook: {
      configured: webhook.configured,
      consecutiveFailures: webhook.consecutiveFailures,
      lastAttemptAgeSeconds: age(webhook.lastAttemptAt),
    },
    lastBootReconcile: boot
      ? {
          at: boot.ts,
          closed: Number(boot.detail.closed ?? 0),
          kept: Number(boot.detail.kept ?? 0),
        }
      : null,
    restartClosedOutstanding: restartClosedCount(),
    // Copied rather than handed out: the list behind it is the one `migrate()`
    // clears and refills, and a caller that held a reference to it would see it
    // emptied under them by the next boot in this process.
    schemaFaults: [...schemaFaultsThisBoot()],
  };
}
