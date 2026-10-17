import path from "node:path";
import { db } from "./db";
import { signatureOf } from "./dreaming";
import { conflictKey, describeFolder } from "./orchestrator";
import {
  keyOf,
  labelsOf,
  NO_REPOSITORY_KEY,
  NO_REPOSITORY_LABEL,
  type RepoLabels,
} from "./repoSpend";
import { reviewPaths } from "./review";
import { getSettings } from "./settings";

/**
 * What runs on each repository keep re-deriving: the files they keep reading,
 * the failures they keep hitting, and the files they keep colliding in.
 *
 * `proposals/ContinuousImprovement/` measured that 73.2% of `Read` calls on this
 * install were of a path an earlier run on the same repository had already read,
 * and that nothing in the app could show it: `run_events` carried every one of
 * those paths, and `run_reviews` every paid conflict resolution, and neither had
 * ever been read per repository.
 *
 * **This is reporting and never a guard**, `repoSpend`'s rule for `repoSpend`'s
 * reason: nothing here reaches `buildSnapshot()`, a window meter or
 * `evaluateBudget`. A threshold on how much a repository re-reads is a limit
 * nobody set.
 *
 * **It is not a cost source.** Two of the three readings are counts and carry no
 * money at all. The third carries `run_reviews.cost_usd`, which is what conflict
 * resolutions were billed outside work cycles; it is never added to
 * `runs.spent_usd`, to the transcript meters or to telemetry, and the card says
 * which column it is.
 *
 * The three functions below are pure over rows the caller supplies, so the SQL
 * stays at the edge and what can fail silently — the edited split, the
 * relativisation and the failure normaliser — is testable without a database.
 */

/** The tools whose call on a path means the run changed that file. */
export const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

/** One `Read` or edit call off a run's log. */
export interface FileCallRow {
  eventId: number;
  runId: string;
  /** `runs.created_at`: what "an earlier run" is ordered by. */
  runCreatedAt: number;
  /** The repository's identity, as `repositoryKeys` resolves it. */
  repoKey: string;
  tool: string;
  /** As the tool call carried it: absolute. */
  filePath: string;
  /**
   * The directory a path is made relative to: the run's checkout when it had
   * one, else the repository it was in, else its folder. A checkout is a whole
   * checkout of the repository, so all three name the same root for the same
   * file — which is what makes a path one run read comparable with another's.
   */
  base: string | null;
  /** False for a call a sub-agent made. */
  mainThread: boolean;
}

/**
 * A path relative to its run's base, or null when it is not inside it.
 *
 * Null rather than the absolute path, because the two callers want different
 * things from a path outside: the readout keys it as itself, and the pointer
 * must never name it. A read of another run's checkout is the common case —
 * `/workspace/.uf-worktrees/<repo>-2/…` read from slot `-1` — and as a
 * repository-relative path it would name a file in a tree this run is not in.
 *
 * Normalised first, so `a/../b` cannot climb out of the base by spelling, and a
 * path with a control character in it is refused: it is about to be printed on
 * a line of its own into a prompt.
 */
export function repoRelative(filePath: string, base: string | null): string | null {
  if (!base || !path.posix.isAbsolute(filePath) || !path.posix.isAbsolute(base)) {
    return null;
  }
  const file = path.posix.normalize(filePath);
  const root = path.posix.normalize(base).replace(/\/+$/, "");
  if (!file.startsWith(`${root}/`)) return null;
  const rel = file.slice(root.length + 1);
  if (rel === "" || /[\u0000-\u001f\u007f]/.test(rel)) return null;
  return rel;
}

/* ------------------------------------------------------------------ */
/* 1. What runs keep reading                                           */
/* ------------------------------------------------------------------ */

export interface ReReadFile {
  path: string;
  /** Reads of it by a run that was not the first to read it here. */
  reads: number;
  /** Distinct such runs. */
  runs: number;
}

export interface CrossRunReading {
  repoKey: string;
  /** Distinct runs that read anything. */
  runs: number;
  reads: number;
  /** Reads of a path some earlier run on this repository had already read. */
  repeats: number;
  /** …by a run that also edited that file, which no pointer would have saved. */
  repeatsEdited: number;
  /** …by a run that never edited it: the share anything could address. */
  repeatsNotEdited: number;
  /** The files behind `repeatsNotEdited`, most re-read first. */
  reReadNotEdited: ReReadFile[];
}

/**
 * Per repository: how much reading repeats an earlier run's, split by whether
 * the run doing it went on to edit the file.
 *
 * **The split is the point.** Half of the 2026-08 repeats were files the reading
 * run then changed — it had to open them whatever any earlier run knew — so an
 * unsplit share overstates what could be saved by a factor of two, and a reader
 * shown one number will read it as the prize.
 *
 * "Earlier" is `runs.created_at`, then event id: a read is a repeat when its run
 * is not the first to have read that path on that repository. A run's own
 * re-reads of a file it was first to open are not repeats. "Edited" is any edit
 * call on the path by the same run, before or after the read; that is the split
 * `04-option-see-it.md` measured, and the four columns add up exactly.
 *
 * A path outside the run's base keeps its absolute spelling as its own key,
 * which is what the 2026-08 query did, so a figure here is comparable with it.
 */
export function crossRunReading(rows: readonly FileCallRow[]): CrossRunReading[] {
  const edited = new Set<string>();
  for (const row of rows) {
    if (EDIT_TOOLS.has(row.tool)) edited.add(`${row.runId}\u0000${keyPath(row)}`);
  }
  const reads = rows
    .filter((row) => row.tool === "Read")
    .sort((a, b) => a.runCreatedAt - b.runCreatedAt || a.eventId - b.eventId);

  const firstReader = new Map<string, string>();
  const byRepo = new Map<
    string,
    CrossRunReading & { runSet: Set<string>; files: Map<string, { reads: number; runs: Set<string> }> }
  >();
  for (const row of reads) {
    const rel = keyPath(row);
    const pathKey = `${row.repoKey}\u0000${rel}`;
    if (!firstReader.has(pathKey)) firstReader.set(pathKey, row.runId);
    let repo = byRepo.get(row.repoKey);
    if (!repo) {
      repo = {
        repoKey: row.repoKey,
        runs: 0,
        reads: 0,
        repeats: 0,
        repeatsEdited: 0,
        repeatsNotEdited: 0,
        reReadNotEdited: [],
        runSet: new Set(),
        files: new Map(),
      };
      byRepo.set(row.repoKey, repo);
    }
    repo.reads += 1;
    repo.runSet.add(row.runId);
    if (firstReader.get(pathKey) === row.runId) continue;
    repo.repeats += 1;
    if (edited.has(`${row.runId}\u0000${rel}`)) {
      repo.repeatsEdited += 1;
      continue;
    }
    repo.repeatsNotEdited += 1;
    let file = repo.files.get(rel);
    if (!file) repo.files.set(rel, (file = { reads: 0, runs: new Set() }));
    file.reads += 1;
    file.runs.add(row.runId);
  }

  return [...byRepo.values()].map(({ runSet, files, ...repo }) => ({
    ...repo,
    runs: runSet.size,
    reReadNotEdited: [...files]
      .map(([p, f]) => ({ path: p, reads: f.reads, runs: f.runs.size }))
      .sort((a, b) => b.runs - a.runs || b.reads - a.reads || compare(a.path, b.path)),
  }));
}

function keyPath(row: FileCallRow): string {
  return repoRelative(row.filePath, row.base) ?? row.filePath;
}

/* ------------------------------------------------------------------ */
/* 2. What runs keep failing at                                        */
/* ------------------------------------------------------------------ */

/** One `tool_error` row off a run's log. */
export interface FailureRow {
  runId: string;
  repoKey: string;
  tool: string | null;
  /** The failure's text as the log stored it. */
  text: string | null;
}

export interface FailureSignature {
  tool: string;
  signature: string;
  /** The first text seen with this signature, clipped, for a reader to recognise it by. */
  sample: string;
  /** Distinct runs that hit it: what the list is ordered by. */
  runs: number;
  rows: number;
}

export interface RepeatedFailures {
  repoKey: string;
  rows: number;
  runs: number;
  /** Signatures more than one run hit, most runs first. */
  recurring: FailureSignature[];
  /** Signatures exactly one run hit, however often: counted, never listed. */
  singleRun: number;
}

const SAMPLE_CHARS = 240;

/**
 * Per repository: tool failures grouped by a normalised signature, ordered by
 * how many **runs** hit each, never by how many rows.
 *
 * By runs because one run retrying one wall 214 times — the bubblewrap
 * namespace refusal on 2026-08-18 — is one wall, and ten runs each failing once
 * at the same thing is the pattern this exists to show. Ordered by rows, the
 * first would bury the second.
 *
 * The normaliser is Dreaming's `signatureOf`, unchanged, rather than a second
 * one: `docs/agent/dreaming/halves-and-write-policy.md` pins it to
 * `scripts/recurrence.mjs` exactly, and two normalisers in one app would put
 * two different counts of "the same failure" on two pages. It is fed the
 * `tool_error` row's stored text, which `toolResultText` has already joined and
 * whitespace-collapsed, so a signature here can differ from Dreaming's for the
 * same failure when the transcript's result was an array — the two lists are
 * not joined and the card does not say they are. The tool is kept apart from
 * the signature, so a `Read` and a `Bash` that fail with the same words are two
 * rows.
 *
 * A signature is a string, not a cause (Dreaming's rule, and the card repeats
 * it): two faults can share one and one fault can have several.
 */
export function repeatedFailures(rows: readonly FailureRow[]): RepeatedFailures[] {
  const byRepo = new Map<
    string,
    {
      rows: number;
      runs: Set<string>;
      signatures: Map<string, { tool: string; signature: string; sample: string; runs: Set<string>; rows: number }>;
    }
  >();
  for (const row of rows) {
    let repo = byRepo.get(row.repoKey);
    if (!repo) byRepo.set(row.repoKey, (repo = { rows: 0, runs: new Set(), signatures: new Map() }));
    repo.rows += 1;
    repo.runs.add(row.runId);
    const tool = row.tool ?? "(unnamed tool)";
    const text = row.text ?? "";
    const signature = signatureOf(text);
    const key = `${tool}\u0000${signature}`;
    let sig = repo.signatures.get(key);
    if (!sig) {
      sig = {
        tool,
        signature,
        sample: text.length > SAMPLE_CHARS ? `${text.slice(0, SAMPLE_CHARS - 1)}…` : text,
        runs: new Set(),
        rows: 0,
      };
      repo.signatures.set(key, sig);
    }
    sig.rows += 1;
    sig.runs.add(row.runId);
  }

  return [...byRepo].map(([repoKey, repo]) => {
    const all = [...repo.signatures.values()].map((s) => ({ ...s, runs: s.runs.size }));
    return {
      repoKey,
      rows: repo.rows,
      runs: repo.runs.size,
      recurring: all
        .filter((s) => s.runs > 1)
        .sort(
          (a, b) =>
            b.runs - a.runs ||
            b.rows - a.rows ||
            compare(a.tool, b.tool) ||
            compare(a.signature, b.signature),
        ),
      singleRun: all.filter((s) => s.runs === 1).length,
    };
  });
}

/* ------------------------------------------------------------------ */
/* 3. What runs keep colliding in                                      */
/* ------------------------------------------------------------------ */

/** One completed conflict resolution. */
export interface ResolveRow {
  reviewId: string;
  repoKey: string;
  createdAt: number;
  /** `run_reviews.cost_usd`: billed outside every work cycle. */
  costUSD: number;
  /** `reviewPaths` of the row: the files the resolution was given. */
  paths: readonly string[];
}

export interface ContendedFile {
  path: string;
  /** Distinct resolutions that named it. */
  resolutions: number;
}

export interface Contention {
  repoKey: string;
  resolutions: number;
  /** Every resolution's cost, summed; never apportioned to a file. */
  costUSD: number;
  firstAt: number;
  lastAt: number;
  /** Files named by more than one resolution, most first. */
  files: ContendedFile[];
  /** Files exactly one resolution named: counted, never listed. */
  namedOnce: number;
}

/**
 * Per repository: which files paid conflict resolutions were about, with what
 * those resolutions cost.
 *
 * The money is per repository and never per file. A resolution names every
 * conflicted path it was handed, and its cost is one figure for all of them, so
 * a per-file sum counts a five-file resolution's cost five times: summed that
 * way, the 2026-08 corpus attributed $196.66 to `CLAUDE.md` alone.
 *
 * `run_reviews` is never swept, so this reading reaches further back than the
 * other two and carries its own first and last dates.
 */
export function contention(rows: readonly ResolveRow[]): Contention[] {
  const byRepo = new Map<
    string,
    { resolutions: number; costUSD: number; firstAt: number; lastAt: number; files: Map<string, number> }
  >();
  for (const row of rows) {
    let repo = byRepo.get(row.repoKey);
    if (!repo) {
      repo = { resolutions: 0, costUSD: 0, firstAt: row.createdAt, lastAt: row.createdAt, files: new Map() };
      byRepo.set(row.repoKey, repo);
    }
    repo.resolutions += 1;
    repo.costUSD += row.costUSD;
    repo.firstAt = Math.min(repo.firstAt, row.createdAt);
    repo.lastAt = Math.max(repo.lastAt, row.createdAt);
    for (const p of new Set(row.paths)) repo.files.set(p, (repo.files.get(p) ?? 0) + 1);
  }
  return [...byRepo].map(([repoKey, repo]) => {
    const files = [...repo.files].map(([p, n]) => ({ path: p, resolutions: n }));
    return {
      repoKey,
      resolutions: repo.resolutions,
      costUSD: repo.costUSD,
      firstAt: repo.firstAt,
      lastAt: repo.lastAt,
      files: files
        .filter((f) => f.resolutions > 1)
        .sort((a, b) => b.resolutions - a.resolutions || compare(a.path, b.path)),
      namedOnce: files.filter((f) => f.resolutions === 1).length,
    };
  });
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ------------------------------------------------------------------ */
/* The edge                                                            */
/* ------------------------------------------------------------------ */

/**
 * Identity and label for every repository string the rows carry.
 *
 * `repoSpend`'s identity, `conflictKey` case-folded, so `/workspace/repo` and
 * `/workspace3/repo` — compose's default second mount onto the same directory —
 * are one repository on this card as they are on that one. Memoised per string
 * because `conflictKey` resolves mount identity with a `stat`, and the rows
 * repeat each string thousands of times.
 */
export function repositoryKeys(
  roots: Iterable<string | null>,
  identify: (p: string) => string,
  describe: (p: string) => RepoLabels,
): {
  keyOf: (root: string | null) => string;
  labels: Map<string, { label: string; isRepository: boolean }>;
} {
  const keys = new Map<string, string>();
  const short = new Map<string, RepoLabels>();
  const keyFor = (root: string | null): string => {
    if (!root) return NO_REPOSITORY_KEY;
    let key = keys.get(root);
    if (key === undefined) {
      key = identify(root);
      keys.set(root, key);
      if (!short.has(key)) short.set(key, describe(root));
    }
    return key;
  };
  for (const root of roots) keyFor(root);

  const shortCounts = new Map<string, number>();
  for (const l of short.values()) shortCounts.set(l.short, (shortCounts.get(l.short) ?? 0) + 1);
  const labels = new Map<string, { label: string; isRepository: boolean }>([
    [NO_REPOSITORY_KEY, { label: NO_REPOSITORY_LABEL, isRepository: false }],
  ]);
  for (const [key, l] of short) {
    labels.set(key, { label: shortCounts.get(l.short)! > 1 ? l.qualified : l.short, isRepository: true });
  }
  return { keyOf: keyFor, labels };
}

/**
 * One repository's three readings, each list clipped for the wire and each
 * clipped list carrying the length it had, so a card can say how many it left out.
 */
export interface RepoReadingRepository {
  key: string;
  label: string;
  isRepository: boolean;
  reading: (CrossRunReading & { reReadFiles: number }) | null;
  failures: (RepeatedFailures & { recurringCount: number }) | null;
  contention: (Contention & { fileCount: number }) | null;
}

export interface RepoReading {
  until: number;
  /** The earliest log row read, or null when there was none: what the first two readings reach back to. */
  eventsFrom: number | null;
  /** `settings.eventRetentionDays`: why `eventsFrom` is no earlier. Null keeps logs forever. */
  eventRetentionDays: number | null;
  repositories: RepoReadingRepository[];
  /** How long the reads took, measured: they are full scans of `run_events`. */
  queryMs: number;
}

/** How many entries of each list a card is sent. The counts above them are whole. */
const LIST_LIMIT = 6;

/**
 * Everything the card shows, read now.
 *
 * One scan of `run_events` for both the reading and the failures: the table has
 * no index on `kind`, so each filter is a full scan whatever it says, and one
 * scan is half the cost of two. Measured at 0.155 s over 124,861 rows in
 * 2026-08, which is fine at a page's cadence and is why this is read on request
 * and never on a cycle.
 *
 * Every run whose log is still kept, rather than a span: "an earlier run" needs
 * the history before any span's start, and the history is bounded by
 * `eventRetentionDays` already. Conflict resolutions are never swept, so their
 * reading reaches back to the first.
 */
export function repoReading(now = Date.now()): RepoReading {
  const started = performance.now();
  const events = db()
    .prepare(
      `SELECT e.id AS eventId, e.run_id AS runId, e.ts, e.kind,
              r.created_at AS runCreatedAt,
              COALESCE(r.folder_repo, r.repo_root) AS repoRoot,
              COALESCE(NULLIF(r.worktree_path, ''), r.folder_repo, NULLIF(r.work_dir, ''), r.folder) AS base,
              json_extract(e.payload, '$.name') AS tool,
              COALESCE(json_extract(e.payload, '$.input.file_path'),
                       json_extract(e.payload, '$.input.notebook_path')) AS filePath,
              json_extract(e.payload, '$.parentToolUseId') AS parent,
              json_extract(e.payload, '$.text') AS text
         FROM run_events e JOIN runs r ON r.id = e.run_id
        WHERE e.kind = 'tool_error'
           OR (e.kind = 'tool'
               AND json_extract(e.payload, '$.name') IN ('Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'))`,
    )
    .all() as Array<{
    eventId: number;
    runId: string;
    ts: number;
    kind: string;
    runCreatedAt: number;
    repoRoot: string | null;
    base: string | null;
    tool: string | null;
    filePath: unknown;
    parent: string | null;
    text: unknown;
  }>;
  const resolves = db()
    .prepare(
      `SELECT rr.id, rr.created_at AS createdAt, rr.cost_usd AS costUSD, rr.resolved_paths,
              COALESCE(r.folder_repo, r.repo_root) AS repoRoot
         FROM run_reviews rr JOIN runs r ON r.id = rr.run_id
        WHERE rr.kind = 'resolve' AND rr.status = 'completed'`,
    )
    .all() as Array<{
    id: string;
    createdAt: number;
    costUSD: number;
    resolved_paths: string | null;
    repoRoot: string | null;
  }>;
  const queryMs = performance.now() - started;

  const ids = repositoryKeys(
    [...events.map((e) => e.repoRoot), ...resolves.map((r) => r.repoRoot)],
    (root) => keyOf(conflictKey(root)),
    (root) => labelsOf(describeFolder(root), root),
  );

  const calls: FileCallRow[] = [];
  const failures: FailureRow[] = [];
  let eventsFrom: number | null = null;
  for (const e of events) {
    eventsFrom = eventsFrom === null ? e.ts : Math.min(eventsFrom, e.ts);
    const repoKey = ids.keyOf(e.repoRoot);
    if (e.kind === "tool_error") {
      failures.push({
        runId: e.runId,
        repoKey,
        tool: e.tool,
        text: typeof e.text === "string" ? e.text : null,
      });
    } else if (typeof e.filePath === "string" && e.tool) {
      calls.push({
        eventId: e.eventId,
        runId: e.runId,
        runCreatedAt: e.runCreatedAt,
        repoKey,
        tool: e.tool,
        filePath: e.filePath,
        base: e.base,
        mainThread: e.parent === null,
      });
    }
  }
  const resolveRows: ResolveRow[] = resolves.map((r) => ({
    reviewId: r.id,
    repoKey: ids.keyOf(r.repoRoot),
    createdAt: r.createdAt,
    costUSD: r.costUSD,
    // `reviewPaths` is the column's one reader and says a value that does not
    // parse is no paths at all; the resolution is still counted and its cost
    // still attached, because it was still paid for.
    paths: reviewPaths(r),
  }));

  const reading = new Map(crossRunReading(calls).map((r) => [r.repoKey, r]));
  const failing = new Map(repeatedFailures(failures).map((r) => [r.repoKey, r]));
  const colliding = new Map(contention(resolveRows).map((r) => [r.repoKey, r]));
  const keys = new Set([...reading.keys(), ...failing.keys(), ...colliding.keys()]);

  const repositories = [...keys].map((key): RepoReadingRepository => {
    const r = reading.get(key);
    const f = failing.get(key);
    const c = colliding.get(key);
    return {
      key,
      ...(ids.labels.get(key) ?? { label: key, isRepository: true }),
      reading: r
        ? { ...r, reReadNotEdited: r.reReadNotEdited.slice(0, LIST_LIMIT), reReadFiles: r.reReadNotEdited.length }
        : null,
      failures: f
        ? { ...f, recurring: f.recurring.slice(0, LIST_LIMIT), recurringCount: f.recurring.length }
        : null,
      contention: c ? { ...c, files: c.files.slice(0, LIST_LIMIT), fileCount: c.files.length } : null,
    };
  });
  // The bucket last whatever its size: it is every non-repository folder at
  // once, and leading with it would lead with the one card that describes no
  // repository.
  repositories.sort(
    (a, b) =>
      Number(b.isRepository) - Number(a.isRepository) ||
      (b.reading?.reads ?? 0) - (a.reading?.reads ?? 0) ||
      compare(a.label, b.label),
  );

  return {
    until: now,
    eventsFrom,
    eventRetentionDays: getSettings().eventRetentionDays,
    repositories,
    queryMs,
  };
}
