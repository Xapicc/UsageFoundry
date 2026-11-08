import type {
  HoldoutArmDTO,
  HoldoutComplianceArmDTO,
  HoldoutContrastDTO,
  HoldoutLeftOutReason,
  HoldoutMeanDTO,
  HoldoutReadbackDTO,
  HoldoutTargetDTO,
} from "./apiTypes";
import { db } from "./db";
import { lastHoldoutExport } from "./holdoutExport";
import { repoRelative } from "./priorReads";
import { EDIT_TOOLS } from "./repoReading";

/**
 * The prior-read pointer's holdout, read back: `17-implementation-sketch.md`'s
 * Phase 4, over the tables `holdoutExport.ts` keeps, never over `run_events`
 * (which the thirty-day sweep empties).
 *
 * **Three questions, and the card keeps them apart.** *Compliance*: did the run
 * open a file the list named — a mechanism, and a floor test on delivery rather
 * than a measure of effect. *Displacement*: did the run read less. *Outcome*:
 * did the run finish differently. Reporting compliance as though it were
 * displacement is the likeliest way this experiment misleads, which is why they
 * share no figure and no verdict.
 *
 * **Both arms are measured the same way.** `Analysis Plan for the Prior-Read
 * Pointer Holdout.md` step 2: a count of files the prompt *never named* falls
 * by construction in the arm whose prompt names twenty more, so displacement
 * here is distinct main-thread `Read` paths, which neither arm's prompt can
 * lower by naming. Compliance scores the list each cycle logged — the block the
 * pointer arm was sent and the list the held-out arm was withheld, recorded by
 * the same line in the run loop — through the same rule.
 *
 * **Only runs that had something to show.** A run counts when a cycle's list
 * held a file (`paths > 0`), in both arms, because the arm is dealt before the
 * list is known and a run with an empty list is the same run in either. The
 * rest are counted under the reason they were left out, per arm, so a
 * difference in what each arm lost shows.
 *
 * **Spend is `runs.spent_usd` and nothing else.** It is the CLI's own
 * `total_cost_usd`, a floor that omits a cycle killed before it reported. It is
 * never added to a transcript or telemetry reading, and no other spend column
 * is read (`docs/agent/metering/run-spend-readings.md`).
 *
 * **Reporting, never a guard.** Nothing here reaches a meter or `evaluateBudget`.
 *
 * The functions above `holdoutReadback` are pure over rows the caller supplies,
 * so the SQL stays at the edge and what fails silently — who is counted, which
 * file a call opened, which pairs are scored — is testable without a database.
 */

const ARMS: readonly HoldoutArmDTO[] = ["pointer", "holdout"];

/** The two-sided 95% point of the normal curve; the intervals are approximate. */
const Z_95 = 1.96;

/* ------------------------------------------------------------------ */
/* Who is counted                                                      */
/* ------------------------------------------------------------------ */

/** A run the pointer considered, as the export holds it. */
export interface ConsideredRun {
  runId: string;
  arm: HoldoutArmDTO;
  /** `holdout_runs.prior_read_arm_source`: `logged` when an event said it. */
  armSource: string | null;
  /** `holdout_runs.prior_read_treatment`. */
  treatment: string | null;
  isContinuation: boolean;
  isSettled: boolean;
  /** The most files any of the run's lists held. */
  paths: number;
}

/**
 * Every reason in the order it is tried; a run is counted under the first that
 * applies. The order is the claim: a run whose arm was never logged is counted
 * as that and not as a continuation, because that is the thing the analysis
 * cannot recover.
 */
export const LEFT_OUT_REASONS: readonly HoldoutLeftOutReason[] = [
  "arm-derived",
  "earlier-list",
  "continuation",
  "unsettled",
  "nothing-to-show",
];

/**
 * Whether a treatment names one of the fixed per-repository lists, or the wait
 * for one. Anything else — `rolling`, or nothing — is the list that drifted with
 * the last hundred runs, which is a different treatment and is not read here.
 */
function isFixedList(treatment: string | null): boolean {
  return treatment !== null && /^snapshot(?:@\d+|-pending)$/.test(treatment);
}

function leftOutReason(run: ConsideredRun): HoldoutLeftOutReason | null {
  // No event recorded the arm, so what the run was shown is unknown: the arm
  // was recomputed from the id, and a continuation dealt by its own id before
  // the inheritance rule can name the other one.
  if (run.armSource !== "logged") return "arm-derived";
  if (!isFixedList(run.treatment)) return "earlier-list";
  // A continuation is dealt its parent's arm, so a chain is one draw: counting
  // each link would count one piece of work as several independent runs.
  if (run.isContinuation) return "continuation";
  // A running run has read only part of what it will.
  if (!run.isSettled) return "unsettled";
  if (run.paths <= 0) return "nothing-to-show";
  return null;
}

export interface Population {
  read: ConsideredRun[];
  leftOut: Array<{ reason: HoldoutLeftOutReason } & Record<HoldoutArmDTO, number>>;
}

export function classifyRuns(runs: readonly ConsideredRun[]): Population {
  const read: ConsideredRun[] = [];
  const counts = new Map<HoldoutLeftOutReason, Record<HoldoutArmDTO, number>>(
    LEFT_OUT_REASONS.map((reason) => [reason, { pointer: 0, holdout: 0 }]),
  );
  for (const run of runs) {
    const reason = leftOutReason(run);
    if (reason === null) read.push(run);
    else counts.get(reason)![run.arm]++;
  }
  return {
    read,
    leftOut: LEFT_OUT_REASONS.map((reason) => ({ reason, ...counts.get(reason)! })),
  };
}

/* ------------------------------------------------------------------ */
/* Displacement: what a run read                                       */
/* ------------------------------------------------------------------ */

/** One tool call off the export, in the order the run made them. */
export interface ToolCall {
  name: string;
  path: string | null;
  isMainThread: boolean;
  inVault: boolean;
}

export interface RunReading {
  /** Distinct files the main thread read before its first edit. */
  beforeEdit: number;
  /** Distinct files the main thread read in all. */
  wholeRun: number;
  edited: boolean;
}

/**
 * What a run's main thread read, before its first edit and in all.
 *
 * Main thread only, because the ranking the pointer is built from counts only
 * main-thread reads and a sub-agent's reading is the sub-agent's. A file read
 * twice is one file. A vault note is not a file of the repository, so neither
 * its read nor an edit of it moves anything. A run that never edits reads
 * everything "before its first edit", which is why `edited` travels with the
 * figure: those runs are a different population and the card counts them.
 */
export function readingOf(calls: readonly ToolCall[]): RunReading {
  const all = new Set<string>();
  const before = new Set<string>();
  let edited = false;
  for (const call of calls) {
    if (!call.isMainThread || call.inVault) continue;
    if (EDIT_TOOLS.has(call.name)) {
      edited = true;
    } else if (call.name === "Read" && call.path !== null) {
      all.add(call.path);
      if (!edited) before.add(call.path);
    }
  }
  return { beforeEdit: before.size, wholeRun: all.size, edited };
}

/* ------------------------------------------------------------------ */
/* Compliance: did the run open what the list named                    */
/* ------------------------------------------------------------------ */

/** One cycle that carried a list, in either arm. */
export interface ComplianceCycle {
  runId: string;
  arm: HoldoutArmDTO;
  ts: number;
  /**
   * Repository-relative paths the list held — shown to the pointer arm, withheld
   * from the held-out arm — or null when the cycle did not log it.
   */
  listed: readonly string[] | null;
  /** Paths the run's own brief named, which the pointer cannot be credited for. */
  briefNamed: readonly string[];
}

/** The latest time a run called anything on each repository-relative path. */
export type LatestOpen = ReadonlyMap<string, number>;

interface Cluster {
  numerator: number;
  denominator: number;
}

export interface ComplianceTally {
  runs: number;
  cycles: number;
  pairs: number;
  opened: number;
  briefNamedPairs: number;
  unlistedCycles: number;
  /** One per run: the unit the variance is taken over, since a run's pairs are not independent. */
  clusters: Cluster[];
}

/**
 * Scores every (cycle, listed path) pair: opened when the run called anything
 * on that path at or after the cycle began, `03-experiment-holdout.md`'s rule.
 *
 * A path the brief also named is set aside in both arms, not scored: a run opens
 * a file its task names whatever any list said, and keeping those pairs would
 * move both arms' shares towards each other for no reason the pointer owns. The
 * brief is the same text in either arm, so the filter cannot favour one.
 */
export function complianceOf(
  cycles: readonly ComplianceCycle[],
  opens: ReadonlyMap<string, LatestOpen>,
): Record<HoldoutArmDTO, ComplianceTally> {
  const tally = (): ComplianceTally => ({
    runs: 0,
    cycles: 0,
    pairs: 0,
    opened: 0,
    briefNamedPairs: 0,
    unlistedCycles: 0,
    clusters: [],
  });
  const result: Record<HoldoutArmDTO, ComplianceTally> = { pointer: tally(), holdout: tally() };
  const perRun = new Map<string, { arm: HoldoutArmDTO; cluster: Cluster }>();

  for (const cycle of cycles) {
    const t = result[cycle.arm];
    if (cycle.listed === null) {
      t.unlistedCycles++;
      continue;
    }
    const named = new Set(cycle.briefNamed);
    const latest = opens.get(cycle.runId);
    let pairs = 0;
    let opened = 0;
    for (const rel of new Set(cycle.listed)) {
      if (named.has(rel)) {
        t.briefNamedPairs++;
        continue;
      }
      pairs++;
      if ((latest?.get(rel) ?? Number.NEGATIVE_INFINITY) >= cycle.ts) opened++;
    }
    if (pairs === 0) continue;
    t.cycles++;
    t.pairs += pairs;
    t.opened += opened;
    let entry = perRun.get(cycle.runId);
    if (!entry) {
      entry = { arm: cycle.arm, cluster: { numerator: 0, denominator: 0 } };
      perRun.set(cycle.runId, entry);
      t.runs++;
      t.clusters.push(entry.cluster);
    }
    entry.cluster.numerator += opened;
    entry.cluster.denominator += pairs;
  }
  return result;
}

export interface Share {
  value: number | null;
  /** Null with fewer than two runs behind it. */
  se: number | null;
}

/**
 * A share of pairs with its standard error taken over runs.
 *
 * The runs are the clusters: a cycle names several paths and a run's pairs move
 * together, so the pair count overstates what was learned. This is the ratio
 * estimator's linearised variance, the figure the proposal's design effect of
 * 1.30 approximated, taken from the data instead of assumed.
 */
export function clusteredShare(clusters: readonly Cluster[]): Share {
  const total = clusters.reduce((sum, c) => sum + c.denominator, 0);
  if (total === 0) return { value: null, se: null };
  const value = clusters.reduce((sum, c) => sum + c.numerator, 0) / total;
  const n = clusters.length;
  if (n < 2) return { value, se: null };
  const squares = clusters.reduce((sum, c) => sum + (c.numerator - value * c.denominator) ** 2, 0);
  return { value, se: Math.sqrt((n / (n - 1)) * squares) / total };
}

/* ------------------------------------------------------------------ */
/* Means, differences and the sample sizes                             */
/* ------------------------------------------------------------------ */

export function meanOf(values: readonly number[]): HoldoutMeanDTO {
  const n = values.length;
  if (n === 0) return { n, mean: null, sd: null };
  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  if (n === 1) return { n, mean, sd: null };
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1);
  return { n, mean, sd: Math.sqrt(variance) };
}

/**
 * Pointer minus held out, with Welch's standard error and a normal 95% interval.
 *
 * The normal point rather than Student's is deliberate and is only honest at
 * the sample sizes the card waits for: the plan's simulation held its size from
 * sixty runs an arm at this outcome's skew, and the card says nothing is
 * significant before the proposal's own targets, all of which are past that.
 * Unadjusted: the plan's regression-adjusted estimate is not computed here.
 */
export function contrastOf(pointer: readonly number[], holdout: readonly number[]): HoldoutContrastDTO {
  const a = meanOf(pointer);
  const b = meanOf(holdout);
  if (a.mean === null || a.sd === null || b.mean === null || b.sd === null) {
    return { pointer: a, holdout: b, difference: null, low: null, high: null };
  }
  const difference = a.mean - b.mean;
  const se = Math.sqrt(a.sd ** 2 / a.n + b.sd ** 2 / b.n);
  return { pointer: a, holdout: b, difference, low: difference - Z_95 * se, high: difference + Z_95 * se };
}

export function complianceArm(tally: ComplianceTally): HoldoutComplianceArmDTO {
  return {
    runs: tally.runs,
    cycles: tally.cycles,
    pairs: tally.pairs,
    opened: tally.opened,
    share: clusteredShare(tally.clusters).value,
  };
}

export function complianceDifference(
  pointer: ComplianceTally,
  holdout: ComplianceTally,
): { difference: number | null; low: number | null; high: number | null } {
  const a = clusteredShare(pointer.clusters);
  const b = clusteredShare(holdout.clusters);
  if (a.value === null || a.se === null || b.value === null || b.se === null) {
    return { difference: null, low: null, high: null };
  }
  const difference = a.value - b.value;
  const se = Math.sqrt(a.se ** 2 + b.se ** 2);
  return { difference, low: difference - Z_95 * se, high: difference + Z_95 * se };
}

export interface SampleTarget {
  effect: string;
  perArm: number;
  unit: "runs" | "pairs";
}

/**
 * The sample sizes `03-experiment-holdout.md` priced, at 80% power and a
 * two-sided 5% test. A difference is not significant until the smaller arm
 * holds the first of them; the later rows are the smaller effects.
 */
export const COMPLIANCE_TARGETS: readonly SampleTarget[] = [
  { effect: "62.3% to 77.3% opened", perArm: 372, unit: "pairs" },
  { effect: "62.3% to 72.3% opened", perArm: 888, unit: "pairs" },
  { effect: "62.3% to 67.3% opened", perArm: 3713, unit: "pairs" },
];
export const READING_TARGETS: readonly SampleTarget[] = [
  { effect: "50% fewer files", perArm: 115, unit: "runs" },
  { effect: "30% fewer files", perArm: 319, unit: "runs" },
  { effect: "20% fewer files", perArm: 717, unit: "runs" },
];
export const SECOND_CYCLE_TARGETS: readonly SampleTarget[] = [
  { effect: "58.8% to 43.8% reaching a second cycle", perArm: 341, unit: "runs" },
  { effect: "58.8% to 48.8% reaching a second cycle", perArm: 773, unit: "runs" },
];
export const SPEND_TARGETS: readonly SampleTarget[] = [
  { effect: "25% less spend", perArm: 265, unit: "runs" },
  { effect: "15% less spend", perArm: 737, unit: "runs" },
];

/** Each target, and whether the smaller of the two arms holds it. */
export function reachedTargets(
  targets: readonly SampleTarget[],
  armSizes: Record<HoldoutArmDTO, number>,
): HoldoutTargetDTO[] {
  const smaller = Math.min(armSizes.pointer, armSizes.holdout);
  return targets.map((t) => ({ ...t, reached: smaller >= t.perArm }));
}

/* ------------------------------------------------------------------ */
/* The list a cycle carried                                            */
/* ------------------------------------------------------------------ */

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : null;
}

/**
 * The paths a cycle's list held, from the columns the export keeps it in.
 *
 * `prior_read_files` is the record, in both arms. Without it only the pointer
 * arm has an exact list — the block its prompt carried — and the held-out arm
 * has none, which is null here rather than a reconstruction: a rebuilt list is
 * not the one the run was withheld, and scoring one arm against its exact list
 * and the other against a guess would put a difference between them that no
 * pointer made.
 */
export function listedPaths(
  arm: HoldoutArmDTO,
  filesJson: string | null,
  blockPathsJson: string | null,
): string[] | null {
  const files = parseJson(filesJson);
  if (Array.isArray(files)) {
    return files.flatMap((f) => {
      const path = (f as { path?: unknown } | null)?.path;
      return typeof path === "string" ? [path] : [];
    });
  }
  return arm === "pointer" ? stringArray(parseJson(blockPathsJson)) : null;
}

/* ------------------------------------------------------------------ */
/* The edge                                                            */
/* ------------------------------------------------------------------ */

interface RunRow {
  runId: string;
  arm: string;
  armSource: string | null;
  treatment: string | null;
  continuesRun: string | null;
  finalizedAt: number | null;
  iterations: number;
  spentUsd: number;
  isolation: string | null;
  folderRepo: string | null;
  endingCode: string | null;
  worktreePath: string | null;
  paths: number;
}

interface ToolRow {
  runId: string;
  ts: number;
  name: string;
  path: string | null;
  parent: string | null;
  inVault: number;
}

interface CycleRow {
  runId: string;
  ts: number;
  arm: string;
  files: string | null;
  blockPaths: string | null;
  briefPaths: string | null;
}

function asArm(value: string): HoldoutArmDTO | null {
  return value === "pointer" || value === "holdout" ? value : null;
}

/** Rows per `IN (…)`, well under SQLite's variable limit. */
const CHUNK = 400;

function inChunks<T>(ids: readonly string[], read: (chunk: readonly string[]) => T[]): T[] {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) rows.push(...read(ids.slice(i, i + CHUNK)));
  return rows;
}

/**
 * The directory a run's list was relative to: its checkout when isolated, else
 * its repository — the `root` the run loop gave `priorReadsFor`. An open is
 * only scored against it, so a read of another checkout's copy is not a read of
 * the listed file.
 */
function rootOf(run: Pick<RunRow, "isolation" | "worktreePath" | "folderRepo">): string | null {
  return run.isolation === "worktree" && run.worktreePath ? run.worktreePath : run.folderRepo;
}

/**
 * The holdout read back, now, from `holdout_runs`, `holdout_cycles` and
 * `holdout_tool_events` and from `runs.ending_code`, which the export does not
 * copy and which a permanent row has no sweep to survive.
 *
 * Read on request, never per cycle. A run that ended since the export last ran
 * is not in it, and `exportedAt` says when that was.
 */
export function holdoutReadback(now = Date.now()): HoldoutReadbackDTO {
  const started = performance.now();
  const rows = db()
    .prepare(
      `SELECT h.run_id AS runId, h.prior_read_arm AS arm, h.prior_read_arm_source AS armSource,
              h.prior_read_treatment AS treatment, h.continues_run AS continuesRun,
              h.finalized_at AS finalizedAt, h.iterations, h.spent_usd AS spentUsd,
              h.isolation, h.folder_repo AS folderRepo,
              r.ending_code AS endingCode, r.worktree_path AS worktreePath,
              COALESCE((SELECT MAX(c.prior_read_count) FROM holdout_cycles c
                         WHERE c.run_id = h.run_id AND c.prior_read_arm IS NOT NULL), 0) AS paths
         FROM holdout_runs h JOIN runs r ON r.id = h.run_id
        WHERE h.prior_read_arm IN ('pointer', 'holdout')`,
    )
    .all() as RunRow[];

  const byId = new Map<string, RunRow & { arm: HoldoutArmDTO }>();
  const considered: ConsideredRun[] = [];
  for (const row of rows) {
    const arm = asArm(row.arm);
    if (arm === null) continue;
    byId.set(row.runId, { ...row, arm });
    considered.push({
      runId: row.runId,
      arm,
      armSource: row.armSource,
      treatment: row.treatment,
      isContinuation: row.continuesRun !== null,
      isSettled: row.finalizedAt !== null,
      paths: row.paths,
    });
  }
  const population = classifyRuns(considered);
  const ids = population.read.map((r) => r.runId);

  const toolRows = inChunks(ids, (chunk) =>
    db()
      .prepare(
        `SELECT run_id AS runId, ts, name, path, parent_tool_use_id AS parent, in_vault AS inVault
           FROM holdout_tool_events WHERE run_id IN (${chunk.map(() => "?").join(",")})
          ORDER BY run_id, event_id`,
      )
      .all(...chunk) as ToolRow[],
  );
  const callsByRun = new Map<string, ToolRow[]>();
  for (const t of toolRows) {
    const list = callsByRun.get(t.runId);
    if (list) list.push(t);
    else callsByRun.set(t.runId, [t]);
  }

  const cycleRows = inChunks(ids, (chunk) =>
    db()
      .prepare(
        `SELECT run_id AS runId, ts, prior_read_arm AS arm, prior_read_files AS files,
                prompt_block_paths AS blockPaths, prompt_brief_paths AS briefPaths
           FROM holdout_cycles
          WHERE run_id IN (${chunk.map(() => "?").join(",")})
            AND prior_read_arm IS NOT NULL AND prior_read_count > 0
          ORDER BY run_id, ts`,
      )
      .all(...chunk) as CycleRow[],
  );

  const reading = new Map<string, RunReading>();
  const opens = new Map<string, Map<string, number>>();
  for (const id of ids) {
    const run = byId.get(id)!;
    const calls = callsByRun.get(id) ?? [];
    reading.set(
      id,
      readingOf(
        calls.map((c) => ({ name: c.name, path: c.path, isMainThread: c.parent === null, inVault: c.inVault === 1 })),
      ),
    );
    // `03-experiment-holdout.md` counts any call that names a file, so an edit
    // of a listed path and a sub-agent's read of it are opens; a Grep or Glob
    // carries a directory, not a file the run opened.
    const root = rootOf(run);
    const latest = new Map<string, number>();
    for (const c of calls) {
      if (c.inVault === 1 || c.path === null || c.name === "Grep" || c.name === "Glob") continue;
      const rel = repoRelative(c.path, root);
      if (rel !== null && c.ts > (latest.get(rel) ?? Number.NEGATIVE_INFINITY)) latest.set(rel, c.ts);
    }
    opens.set(id, latest);
  }

  const cycles: ComplianceCycle[] = [];
  for (const c of cycleRows) {
    const arm = asArm(c.arm);
    if (arm === null) continue;
    cycles.push({
      runId: c.runId,
      arm,
      ts: c.ts,
      listed: listedPaths(arm, c.files, c.blockPaths),
      briefNamed: stringArray(parseJson(c.briefPaths)) ?? [],
    });
  }
  const tallies = complianceOf(cycles, opens);

  interface MeasuredRun {
    arm: HoldoutArmDTO;
    iterations: number;
    spentUsd: number;
    endingCode: string | null;
    reading: RunReading;
  }
  const measured: MeasuredRun[] = population.read.map((r) => {
    const row = byId.get(r.runId)!;
    return {
      arm: r.arm,
      iterations: row.iterations,
      spentUsd: row.spentUsd,
      endingCode: row.endingCode,
      reading: reading.get(r.runId)!,
    };
  });
  const armSizes = {
    pointer: measured.filter((m) => m.arm === "pointer").length,
    holdout: measured.filter((m) => m.arm === "holdout").length,
  };
  const contrast = (measure: (run: MeasuredRun) => number) =>
    contrastOf(
      measured.filter((m) => m.arm === "pointer").map(measure),
      measured.filter((m) => m.arm === "holdout").map(measure),
    );
  const neverEdited = (arm: HoldoutArmDTO) => measured.filter((m) => m.arm === arm && !m.reading.edited).length;

  const endingCounts = new Map<string | null, Record<HoldoutArmDTO, number>>();
  for (const m of measured) {
    const entry = endingCounts.get(m.endingCode) ?? { pointer: 0, holdout: 0 };
    entry[m.arm]++;
    endingCounts.set(m.endingCode, entry);
  }
  const endings = [...endingCounts]
    .map(([code, n]) => ({ code, ...n }))
    .sort((a, b) => b.pointer + b.holdout - (a.pointer + a.holdout) || String(a.code).localeCompare(String(b.code)));

  const complianceSizes = { pointer: tallies.pointer.pairs, holdout: tallies.holdout.pairs };
  const queryMs = performance.now() - started;
  return {
    until: now,
    exportedAt: lastHoldoutExport()?.at ?? null,
    population: { read: armSizes, leftOut: population.leftOut },
    compliance: {
      pointer: complianceArm(tallies.pointer),
      holdout: complianceArm(tallies.holdout),
      briefNamedPairs: { pointer: tallies.pointer.briefNamedPairs, holdout: tallies.holdout.briefNamedPairs },
      unlistedCycles: { pointer: tallies.pointer.unlistedCycles, holdout: tallies.holdout.unlistedCycles },
      ...complianceDifference(tallies.pointer, tallies.holdout),
      targets: reachedTargets(COMPLIANCE_TARGETS, complianceSizes),
    },
    displacement: {
      beforeEdit: contrast((r) => r.reading.beforeEdit),
      wholeRun: contrast((r) => r.reading.wholeRun),
      neverEdited: { pointer: neverEdited("pointer"), holdout: neverEdited("holdout") },
      targets: reachedTargets(READING_TARGETS, armSizes),
    },
    outcome: {
      secondCycle: contrast((r) => (r.iterations >= 2 ? 1 : 0)),
      secondCycleTargets: reachedTargets(SECOND_CYCLE_TARGETS, armSizes),
      spend: contrast((r) => r.spentUsd),
      spendTargets: reachedTargets(SPEND_TARGETS, armSizes),
      endings,
    },
    queryMs,
  };
}
