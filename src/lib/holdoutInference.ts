import type {
  HoldoutArmDTO,
  HoldoutInterferenceDTO,
  HoldoutLookDTO,
  HoldoutLookVerdict,
  HoldoutPermutationDTO,
  HoldoutStratifiedDTO,
} from "./apiTypes";

/**
 * What `Analysis Plan for the Prior-Read Pointer Holdout.md` steps 3 to 5 ask of
 * the holdout beyond an arm-against-arm difference: an estimate that does not
 * move with which repository a run landed on, a check that one arm's treatment
 * is not reaching the other, and two looks on fixed boundaries.
 *
 * Pure over rows the caller supplies, like the functions above `holdoutReadback`
 * in `holdoutReadback.ts`, so what fails silently — a weight, a variance, which
 * runs a look includes — is testable without a database, and nothing here
 * imports `config` or the database.
 *
 * **Deterministic on purpose.** A permutation p-value that changed on every
 * reload would make the card a way of looking until a number suits, which is
 * what step 5 is there to stop. The shuffles come from a seeded generator and
 * the re-dealt arms from a hash of the replicate and the run, so one set of
 * rows is always one set of figures.
 *
 * Nothing here is a guard.
 */

/** The two-sided 95% point of the normal curve; the intervals are approximate. */
export const Z_95 = 1.96;

/* ------------------------------------------------------------------ */
/* The primary: a difference stratified by repository                  */
/* ------------------------------------------------------------------ */

/** One run, with the measure the primary is taken over. */
export interface InferenceRun {
  runId: string;
  arm: HoldoutArmDTO;
  /** The repository: the one covariate fixed before a run starts that the export holds for every run. */
  stratum: string;
  y: number;
  /** When the run's evidence was complete, which is what orders the looks. */
  settledAt: number;
}

/** One repository's values, the pointer arm's first. */
export interface StratumValues {
  values: number[];
  /** How many of `values`, from the front, are the pointer arm's. */
  treated: number;
}

/**
 * A repository where either arm holds fewer than two runs has no variance for
 * that arm and no difference worth weighting, so it is set aside and counted
 * rather than guessed at. The estimand then names the repositories left.
 */
const MIN_PER_ARM = 2;

export function strataOf(runs: readonly InferenceRun[]): { strata: StratumValues[]; setAside: number } {
  const byStratum = new Map<string, { pointer: number[]; holdout: number[] }>();
  for (const run of runs) {
    let entry = byStratum.get(run.stratum);
    if (!entry) {
      entry = { pointer: [], holdout: [] };
      byStratum.set(run.stratum, entry);
    }
    entry[run.arm].push(run.y);
  }
  const strata: StratumValues[] = [];
  let setAside = 0;
  for (const { pointer, holdout } of byStratum.values()) {
    if (pointer.length < MIN_PER_ARM || holdout.length < MIN_PER_ARM) {
      setAside += pointer.length + holdout.length;
      continue;
    }
    strata.push({ values: [...pointer, ...holdout], treated: pointer.length });
  }
  return { strata, setAside };
}

/**
 * Post-stratified pointer-minus-held-out difference and its variance, weighting
 * each repository by its share of the runs: `sum w (m1 - m0)` and
 * `sum w² (v1/n1 + v0/n0)`. This is Lin's regression estimator with the
 * repository dummy as the only covariate, so a repository whose runs read more
 * cannot move the arms apart by being dealt unevenly.
 */
function statisticOf(strata: readonly StratumValues[], total: number): { difference: number; variance: number } {
  let difference = 0;
  let variance = 0;
  for (const { values, treated } of strata) {
    const n1 = treated;
    const n0 = values.length - treated;
    let sum1 = 0;
    let squares1 = 0;
    for (let i = 0; i < n1; i++) {
      sum1 += values[i];
      squares1 += values[i] * values[i];
    }
    let sum0 = 0;
    let squares0 = 0;
    for (let i = n1; i < values.length; i++) {
      sum0 += values[i];
      squares0 += values[i] * values[i];
    }
    const weight = values.length / total;
    // Floored at zero: the one-pass form can leave a rounding-sized negative
    // where every value in an arm is equal, which is a variance of nothing.
    const v1 = Math.max(0, (squares1 - (sum1 * sum1) / n1) / (n1 - 1));
    const v0 = Math.max(0, (squares0 - (sum0 * sum0) / n0) / (n0 - 1));
    difference += weight * (sum1 / n1 - sum0 / n0);
    variance += weight * weight * (v1 / n1 + v0 / n0);
  }
  return { difference, variance };
}

/** The studentised difference. No spread and no difference is no signal (0); no spread and a difference is every signal. */
function studentised(difference: number, variance: number): number {
  if (variance > 0) return difference / Math.sqrt(variance);
  if (difference === 0) return 0;
  return difference > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
}

function emptyStratified(setAside: number): HoldoutStratifiedDTO {
  return {
    difference: null,
    low: null,
    high: null,
    z: null,
    runs: { pointer: 0, holdout: 0 },
    strata: 0,
    setAside,
  };
}

export function stratifiedDifference(runs: readonly InferenceRun[]): HoldoutStratifiedDTO {
  const { strata, setAside } = strataOf(runs);
  if (strata.length === 0) return emptyStratified(setAside);
  const total = strata.reduce((sum, s) => sum + s.values.length, 0);
  const { difference, variance } = statisticOf(strata, total);
  const se = Math.sqrt(variance);
  return {
    difference,
    low: difference - Z_95 * se,
    high: difference + Z_95 * se,
    z: studentised(difference, variance),
    runs: {
      pointer: strata.reduce((sum, s) => sum + s.treated, 0),
      holdout: strata.reduce((sum, s) => sum + s.values.length - s.treated, 0),
    },
    strata: strata.length,
    setAside,
  };
}

/** A small seeded generator (mulberry32): the permutation's shuffles must be the same on every reload. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Arm assignments below which every one is enumerated, so the p-value is exact rather than sampled. */
export const EXACT_ASSIGNMENTS = 20_000;
/** Random assignments drawn when there are too many to enumerate. */
export const PERMUTATION_DRAWS = 4_000;
const PERMUTATION_SEED = 0x70_72_69_6d;

/** Tolerance for "at least as extreme": the observed assignment is one of the permutations and must count itself. */
const TIE = 1 - 1e-12;

/** The number of ways to choose which of each repository's runs are the pointer arm's, capped one past `limit`. */
function assignmentCount(strata: readonly StratumValues[], limit: number): number {
  let total = 1;
  for (const { values, treated } of strata) {
    const k = Math.min(treated, values.length - treated);
    let ways = 1;
    for (let i = 1; i <= k; i++) {
      ways = (ways * (values.length - k + i)) / i;
      if (ways > limit) return limit + 1;
    }
    total *= ways;
    if (total > limit) return limit + 1;
  }
  return total;
}

/** Every way to pick `k` of the values as the pointer arm, as that repository's weighted difference and variance terms. */
function stratumTerms(stratum: StratumValues, total: number): Array<[number, number]> {
  const { values, treated: k } = stratum;
  const n = values.length;
  const allSum = values.reduce((sum, v) => sum + v, 0);
  const allSquares = values.reduce((sum, v) => sum + v * v, 0);
  const weight = n / total;
  const terms: Array<[number, number]> = [];
  const pick = (from: number, left: number, sum1: number, squares1: number): void => {
    if (left === 0) {
      const sum0 = allSum - sum1;
      const squares0 = allSquares - squares1;
      const v1 = Math.max(0, (squares1 - (sum1 * sum1) / k) / (k - 1));
      const v0 = Math.max(0, (squares0 - (sum0 * sum0) / (n - k)) / (n - k - 1));
      terms.push([weight * (sum1 / k - sum0 / (n - k)), weight * weight * (v1 / k + v0 / (n - k))]);
      return;
    }
    for (let i = from; i <= n - left; i++) pick(i + 1, left - 1, sum1 + values[i], squares1 + values[i] * values[i]);
  };
  pick(0, k, 0, 0);
  return terms;
}

/**
 * Two-sided studentised permutation p-value of the stratified difference.
 *
 * Arms are re-dealt within each repository, keeping every repository's arm
 * sizes, and the difference is divided by its own standard error each time: the
 * studentised form is what keeps the test's size at this outcome's skew and
 * unequal arm spreads, where a percentile bootstrap undercovers
 * (`Estimators for Skewed Zero-Heavy Outcomes`). Every assignment is counted
 * when there are few enough, otherwise `draws` of them are, and the p-value is
 * `(1 + at least as extreme) / (1 + draws)` so that it is never zero.
 */
export function permutationTest(
  runs: readonly InferenceRun[],
  options: { exactLimit?: number; draws?: number; seed?: number } = {},
): HoldoutPermutationDTO {
  const { strata } = strataOf(runs);
  if (strata.length === 0) return { p: null, assignments: 0, exact: false };
  const exactLimit = options.exactLimit ?? EXACT_ASSIGNMENTS;
  const total = strata.reduce((sum, s) => sum + s.values.length, 0);
  const observed = statisticOf(strata, total);
  const threshold = Math.abs(studentised(observed.difference, observed.variance)) * TIE;

  if (assignmentCount(strata, exactLimit) <= exactLimit) {
    const terms = strata.map((s) => stratumTerms(s, total));
    let assignments = 0;
    let atLeast = 0;
    const walk = (index: number, difference: number, variance: number): void => {
      if (index === terms.length) {
        assignments++;
        if (Math.abs(studentised(difference, variance)) >= threshold) atLeast++;
        return;
      }
      for (const [d, v] of terms[index]) walk(index + 1, difference + d, variance + v);
    };
    walk(0, 0, 0);
    return { p: atLeast / assignments, assignments, exact: true };
  }

  const draws = options.draws ?? PERMUTATION_DRAWS;
  const random = seededRandom(options.seed ?? PERMUTATION_SEED);
  const shuffled = strata.map((s) => ({ values: [...s.values], treated: s.treated }));
  let atLeast = 0;
  for (let b = 0; b < draws; b++) {
    for (const { values } of shuffled) {
      for (let i = values.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        const swap = values[i];
        values[i] = values[j];
        values[j] = swap;
      }
    }
    const t = statisticOf(shuffled, total);
    if (Math.abs(studentised(t.difference, t.variance)) >= threshold) atLeast++;
  }
  return { p: (1 + atLeast) / (1 + draws), assignments: draws, exact: false };
}

/* ------------------------------------------------------------------ */
/* Two looks                                                           */
/* ------------------------------------------------------------------ */

/**
 * The plan's two-sided 5% boundaries for two equally spaced looks (O'Brien and
 * Fleming): a strict interim, then a final nearly at the usual 1.96, which costs
 * under one percent in sample against a single look.
 */
export const OBRIEN_FLEMING = { interim: 2.797, final: 1.977 } as const;

/**
 * Settled runs the smaller arm must hold at the final look: the plan's thirty
 * days at per-run randomisation (`Minimum detectable effect, worked`: 410 an
 * arm, a fall of about 26% in files read). The interim is half of it. It is a
 * count of runs read rather than a date, because the runs a reading keeps
 * (settled, on a fixed list, with a list to name) arrive at their own pace.
 */
export const PLANNED_RUNS_PER_ARM = 410;

export interface LookPlan {
  interimPerArm: number;
  finalPerArm: number;
}

export function lookPlan(finalPerArm = PLANNED_RUNS_PER_ARM): LookPlan {
  return { interimPerArm: Math.ceil(finalPerArm / 2), finalPerArm };
}

/**
 * The runs the data held at the first moment the smaller arm held `perArm`
 * settled runs, in the order they settled — or null before that moment.
 *
 * A look is the data as it stood then, not as it stands now: that is what makes
 * it one look rather than however many times the card was loaded, and it is
 * what the boundaries' error rate assumes. Runs that settled after it are the
 * descriptive reading to date.
 */
function snapshotAt(ordered: readonly InferenceRun[], perArm: number): InferenceRun[] | null {
  const counts: Record<HoldoutArmDTO, number> = { pointer: 0, holdout: 0 };
  for (let i = 0; i < ordered.length; i++) {
    counts[ordered[i].arm]++;
    if (Math.min(counts.pointer, counts.holdout) >= perArm) return ordered.slice(0, i + 1);
  }
  return null;
}

function settledOrder(a: InferenceRun, b: InferenceRun): number {
  return a.settledAt - b.settledAt || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0);
}

export function sequentialOf(
  runs: readonly InferenceRun[],
  plan: LookPlan = lookPlan(),
): { looks: HoldoutLookDTO[]; verdict: HoldoutLookVerdict } {
  const ordered = [...runs].sort(settledOrder);
  const held: Record<HoldoutArmDTO, number> = { pointer: 0, holdout: 0 };
  for (const run of ordered) held[run.arm]++;

  const look = (stage: "interim" | "final", perArm: number): HoldoutLookDTO => {
    const boundary = OBRIEN_FLEMING[stage];
    const snapshot = snapshotAt(ordered, perArm);
    if (snapshot === null) {
      return { stage, perArm, boundary, reachedAt: null, runs: held, z: null, crossed: null };
    }
    const estimate = stratifiedDifference(snapshot);
    const z = estimate.z;
    return {
      stage,
      perArm,
      boundary,
      reachedAt: snapshot[snapshot.length - 1].settledAt,
      runs: {
        pointer: snapshot.filter((r) => r.arm === "pointer").length,
        holdout: snapshot.filter((r) => r.arm === "holdout").length,
      },
      z,
      crossed: z !== null && Math.abs(z) >= boundary,
    };
  };

  const looks = [look("interim", plan.interimPerArm), look("final", plan.finalPerArm)];
  return { looks, verdict: verdictOf(looks) };
}

/**
 * What the two looks say together. A boundary crossed at the interim ends the
 * test there: the final is then data after the stop, and descriptive.
 */
export function verdictOf(looks: readonly HoldoutLookDTO[]): HoldoutLookVerdict {
  const [interim, final] = looks;
  if (interim.crossed === true) return "difference-at-interim";
  if (final.crossed !== null) return final.crossed ? "difference-at-final" : "none-at-final";
  return interim.crossed === false ? "continue" : "before-interim";
}

/* ------------------------------------------------------------------ */
/* Interference                                                        */
/* ------------------------------------------------------------------ */

/** A held-out run, the one population that never saw the pointer and so should not vary with anyone else's arm. */
export interface InterferenceSubject {
  stratum: string;
  y: number;
  /** Ids of the runs in one exposure set, or null when the set was never recorded. */
  neighbours: readonly string[] | null;
}

/**
 * Slope of `y` on `x` within repositories, with HC2 standard error.
 *
 * Both are taken from their repository's mean, so a repository that reads more
 * and also happens to have a different treated share cannot make a slope. The
 * leverage of a run in a fixed-effects regression is `1/n + x̃²/Sxx`.
 */
export function withinSlope(points: ReadonlyArray<{ stratum: string; x: number; y: number }>): {
  slope: number | null;
  se: number | null;
  exposureSd: number | null;
  runs: number;
} {
  const groups = new Map<string, Array<{ x: number; y: number }>>();
  for (const p of points) {
    const list = groups.get(p.stratum);
    if (list) list.push(p);
    else groups.set(p.stratum, [p]);
  }
  const centred: Array<{ x: number; y: number; n: number }> = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const meanX = list.reduce((sum, p) => sum + p.x, 0) / list.length;
    const meanY = list.reduce((sum, p) => sum + p.y, 0) / list.length;
    for (const p of list) centred.push({ x: p.x - meanX, y: p.y - meanY, n: list.length });
  }
  const runs = centred.length;
  const sxx = centred.reduce((sum, p) => sum + p.x * p.x, 0);
  if (runs === 0 || sxx === 0) return { slope: null, se: null, exposureSd: null, runs };
  const slope = centred.reduce((sum, p) => sum + p.x * p.y, 0) / sxx;
  let weighted = 0;
  for (const p of centred) {
    const residual = p.y - slope * p.x;
    const leverage = 1 / p.n + (p.x * p.x) / sxx;
    // A repository of two runs with the whole spread on one of them leaves a
    // leverage of one and a residual of nothing; its term is zero, not a quotient.
    if (leverage < 1) weighted += (p.x * p.x * residual * residual) / (1 - leverage);
  }
  const degrees = runs - groups.size;
  return {
    slope,
    se: Math.sqrt(weighted) / sxx,
    exposureSd: degrees > 0 ? Math.sqrt(sxx / degrees) : null,
    runs,
  };
}

/**
 * Whether a held-out run's reading moves with the treated share of the runs
 * around it — the plan's step 4, for one definition of "around it".
 *
 * The slope is of the run's reading on the share of its neighbours that were
 * dealt the pointer, among neighbours whose arm is known. A slope the null does
 * not cover means the held-out arm is not a clean baseline: something a treated
 * run left behind reached it, and no adjustment in the primary can sign the bias.
 *
 * The null is the conditional randomisation test: every neighbour's arm is
 * dealt again, `draws` times, by `redeal` — the real assignment rule applied to
 * a new id — with the held-out runs' readings held fixed, because under no
 * interference they do not depend on the draw. The p-value is
 * `(1 + at least as extreme) / (1 + draws)`.
 *
 * Detection needs far more runs than the main effect: the treated share of a
 * hundred runs hardly varies, and `exposureSd` is how little. An interval that
 * spans the pointer's whole expected effect is the absence of evidence, and the
 * card says so rather than reading it as absence.
 */
export function interferenceOf(
  subjects: readonly InterferenceSubject[],
  arms: ReadonlyMap<string, HoldoutArmDTO>,
  redeal: (replicate: number, id: string) => HoldoutArmDTO,
  draws: number,
): Omit<HoldoutInterferenceDTO, "exposure"> {
  const universe: string[] = [];
  const indexOf = new Map<string, number>();
  const usable: Array<{ stratum: string; y: number; neighbours: number[] }> = [];
  for (const s of subjects) {
    const neighbours: number[] = [];
    for (const id of s.neighbours ?? []) {
      if (!arms.has(id)) continue;
      let index = indexOf.get(id);
      if (index === undefined) {
        index = universe.length;
        universe.push(id);
        indexOf.set(id, index);
      }
      neighbours.push(index);
    }
    if (neighbours.length > 0) usable.push({ stratum: s.stratum, y: s.y, neighbours });
  }

  const share = (treated: ArrayLike<number>, neighbours: readonly number[]): number => {
    let count = 0;
    for (const index of neighbours) count += treated[index];
    return count / neighbours.length;
  };
  const slopeFor = (treated: ArrayLike<number>) =>
    withinSlope(usable.map((u) => ({ stratum: u.stratum, x: share(treated, u.neighbours), y: u.y })));

  const observedArms = Uint8Array.from(universe, (id) => (arms.get(id) === "pointer" ? 1 : 0));
  const observed = slopeFor(observedArms);
  const base = {
    runs: observed.runs,
    setAside: subjects.length - observed.runs,
    exposureSd: observed.exposureSd,
    draws,
  };
  if (observed.slope === null || observed.se === null) {
    return { ...base, slope: null, low: null, high: null, p: null };
  }

  const threshold = Math.abs(observed.slope) * TIE;
  const treated = new Uint8Array(universe.length);
  let atLeast = 0;
  for (let b = 0; b < draws; b++) {
    for (let i = 0; i < universe.length; i++) treated[i] = redeal(b, universe[i]) === "pointer" ? 1 : 0;
    const replicate = slopeFor(treated).slope;
    if (replicate !== null && Math.abs(replicate) >= threshold) atLeast++;
  }
  return {
    ...base,
    slope: observed.slope,
    low: observed.slope - Z_95 * observed.se,
    high: observed.slope + Z_95 * observed.se,
    p: (1 + atLeast) / (1 + draws),
  };
}
