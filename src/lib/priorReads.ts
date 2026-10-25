import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "./db";
import { WORKTREE_STORE_DIR } from "./worktreeStoreDir";

/**
 * The prior-read pointer: the files earlier runs on a repository opened most,
 * named in a fresh conversation's opening prompt, on half of all runs.
 *
 * `proposals/ContinuousImprovement/` measured that a top-20 built only from
 * earlier runs, weighted ×0.9 per run back, covered 45.0% of a new run's
 * opening eight reads on this install (42.3% by raw frequency, 39.2% by
 * distinct runs). Whether *naming* those files changes what a run reads — or
 * only reorders what it would have read anyway — is not known, and nothing in
 * the repository measures it, so the pointer ships behind a holdout that makes
 * the question answerable: every run's arm is a function of its id alone.
 *
 * Nothing here writes. The pointer reads `run_events` and `runs`, which already
 * hold every path every run opened, so there is no store to keep, no second
 * author and no retention horizon of its own: it sees what the logs still hold.
 */

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
 *
 * A path into the checkout store counts as outside too. For a repository at the
 * mount root the store is inside the base, so a read of another run's slot
 * from the repository itself would otherwise come out as
 * `.uf-worktrees/<repo>-2/…`, the same file in another run's tree.
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
  if (rel.split("/")[0] === WORKTREE_STORE_DIR) return null;
  return rel;
}

/** One main-thread `Read` an earlier run on the repository made. */
export interface PriorReadRow {
  runId: string;
  /** `runs.created_at`, which orders the runs the decay counts back over. */
  runCreatedAt: number;
  /** As the tool call carried it: absolute. */
  filePath: string;
  /** The run's checkout, else its repository, else its folder — `repoRelative`'s base. */
  base: string | null;
}

export interface RankedRead {
  /** Relative to the repository's root. */
  path: string;
  /** Distinct earlier runs that read it, of those the rows covered. */
  runs: number;
}

/**
 * The files earlier runs opened most, most recent weighted, as
 * repository-relative paths.
 *
 * Each read counts `decay^k`, where `k` is how many runs that read anything
 * came after the one that made it: the newest run's reads count 1, the run
 * before it 0.9, and a run 29 back under 5% of the newest. That is the rule the
 * measurement chose over raw frequency and distinct-run counts, which both let
 * a file every run opened a month ago outrank the one every run opened this
 * week. Ties go to the path that sorts first, so one history ranks one way.
 *
 * `keep` is asked of each candidate in rank order until `limit` are kept, so a
 * file that is gone or has moved out of the tree costs its place rather than
 * leaving a hole. It is injected so that this stays pure; the run loop's is a
 * `realpath` against the run's own root.
 *
 * Paths the rows' own bases do not contain are dropped here, before ranking,
 * not kept absolute: named in a prompt they would point into another run's
 * checkout.
 */
export function priorReadRanking(
  rows: readonly PriorReadRow[],
  {
    decay = 0.9,
    limit = 20,
    keep = () => true,
  }: { decay?: number; limit?: number; keep?: (rel: string) => boolean } = {},
): RankedRead[] {
  const runs = new Map<string, number>();
  for (const row of rows) {
    if (!runs.has(row.runId)) runs.set(row.runId, row.runCreatedAt);
  }
  const order = [...runs].sort((a, b) => a[1] - b[1] || compare(a[0], b[0]));
  const weight = new Map(order.map(([runId], i) => [runId, decay ** (order.length - 1 - i)]));

  const score = new Map<string, { weight: number; runs: Set<string> }>();
  for (const row of rows) {
    const rel = repoRelative(row.filePath, row.base);
    if (rel === null) continue;
    let entry = score.get(rel);
    if (!entry) score.set(rel, (entry = { weight: 0, runs: new Set() }));
    entry.weight += weight.get(row.runId)!;
    entry.runs.add(row.runId);
  }

  const ranked = [...score].sort((a, b) => b[1].weight - a[1].weight || compare(a[0], b[0]));
  const kept: RankedRead[] = [];
  for (const [rel, entry] of ranked) {
    if (kept.length >= limit) break;
    if (keep(rel)) kept.push({ path: rel, runs: entry.runs.size });
  }
  return kept;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The name this experiment hashes into every run's arm.
 *
 * Inside the preimage so that a second experiment keyed on the same ids draws a
 * different split: two experiments on bare ids would put the same runs in the
 * same arm of both, and their effects would be confounded with no way to tell
 * afterwards. **Never change it**, nor the hash below: every run already
 * started has an arm that is recomputed from this string, and changing it
 * re-deals the arms of runs whose prompts are already in the log.
 */
export const PRIOR_READS_EXPERIMENT = "prior-read-pointer";

/**
 * Whether a run is held out of the pointer: half of all runs, by id alone.
 *
 * A function of the id and of nothing else, so it is the same answer on every
 * cycle, after a restart, after a pick-up and in a query a fortnight from now —
 * no column records it because none is needed, and the `iteration` event of
 * every session-less cycle records it anyway. `runs.id` is a random UUID, so
 * the first 32 bits of a SHA-256 over it split evenly.
 *
 * Decided for every run the pointer considers, before anything is known about
 * the run's history, so the two arms are the same population: whether a run
 * had anything to be shown is recorded beside its arm and never decides it.
 */
export function inHoldout(runId: string): boolean {
  return holdoutOf(PRIOR_READS_EXPERIMENT, runId);
}

/**
 * The same split for any experiment, so that a second one keyed on run ids
 * draws its arms the way this one does and from a different preimage —
 * `vaultPointer.ts` is the second.
 */
export function holdoutOf(experiment: string, runId: string): boolean {
  const digest = createHash("sha256").update(`${experiment}:${runId}`).digest();
  return digest.readUInt32BE(0) < 0x8000_0000;
}

/**
 * How many of a repository's most recent earlier runs the ranking reads.
 *
 * A bound on the query rather than on the answer: at ×0.9 a run 100 back
 * weighs 0.003% of the newest, so nothing past it can move a ranking, while
 * every run of history is that many more log rows to extract JSON from on the
 * path that starts a run.
 */
const HISTORY_RUNS = 100;

export interface PriorReads {
  arm: "pointer" | "holdout";
  /** What the pointer arm is shown, and what the holdout arm would have been. */
  paths: RankedRead[];
}

/**
 * The pointer for a run about to start, or null for a run it does not consider.
 *
 * Resolved once per segment, beside `githubTokenFor`, with one synchronous
 * query: the ranking cannot change inside a run, because it is built from runs
 * created before this one. It is not in `createRun` and adds nothing to it.
 *
 * Not considered, so in neither arm:
 *
 *   - **A folder that is not in a repository.** There is no "this repository"
 *     to have history, and every such folder shares one bucket.
 *   - **A Codex or local-model run.** The measurement and the arms are Claude
 *     Code's: Codex's reads are shell commands the log does not record as a
 *     `Read`, so its compliance could not be scored, and a local model is a
 *     different reader whose runs would only add variance to both arms.
 *   - **Dreaming's writer.** Its task, its folder and its corpus are fixed by
 *     the feature, and a list of what earlier writer runs opened is a nudge
 *     toward re-reading the notes it is meant to judge afresh.
 *
 * A run with no earlier reads on its repository is considered, gets its arm,
 * and has nothing to show: `paths` is empty in either arm, and the block is not
 * sent. Recording it rather than dropping it keeps the arms' populations
 * comparable when they are read back.
 */
export function priorReadsFor(o: {
  runId: string;
  createdAt: number;
  /** `folder_repo`, falling back to `repo_root`: `repoSpend`'s membership. */
  repository: string | null;
  /** The directory the paths are relative to: the checkout, else the repository. */
  root: string | null;
  provider: string | null;
  originRef: string | null;
}): PriorReads | null {
  if (!o.repository || !o.root) return null;
  if (o.provider === "codex" || o.provider === "local") return null;
  if (o.originRef?.startsWith("dreaming:")) return null;

  const arm = inHoldout(o.runId) ? "holdout" : "pointer";
  // Through `idx_run_events_run` rather than a scan: the run ids come from
  // `runs`, which is small, and the events are read run by run.
  const rows = db()
    .prepare(
      `SELECT e.run_id AS runId, r.created_at AS runCreatedAt,
              COALESCE(NULLIF(r.worktree_path, ''), r.folder_repo, NULLIF(r.work_dir, ''), r.folder) AS base,
              json_extract(e.payload, '$.input.file_path') AS filePath
         FROM run_events e JOIN runs r ON r.id = e.run_id
        WHERE e.run_id IN (
                SELECT id FROM runs
                 WHERE COALESCE(folder_repo, repo_root) = ? AND created_at < ? AND id <> ?
                 ORDER BY created_at DESC LIMIT ${HISTORY_RUNS})
          AND e.kind = 'tool'
          AND json_extract(e.payload, '$.name') = 'Read'
          AND json_extract(e.payload, '$.parentToolUseId') IS NULL`,
    )
    .all(o.repository, o.createdAt, o.runId) as Array<{
    runId: string;
    runCreatedAt: number;
    base: string | null;
    filePath: unknown;
  }>;
  const reads = rows.flatMap((r) =>
    typeof r.filePath === "string" ? [{ ...r, filePath: r.filePath }] : [],
  );
  return { arm, paths: priorReadRanking(reads, { keep: containedFileIn(o.root) }) };
}

/**
 * Whether a repository-relative path is a file inside `root` now.
 *
 * Containment is proved on the resolved path, before and after `realpath`,
 * which is `resolveInMount`'s rule: a name earlier runs read can be a symlink
 * out of the tree today. One `realpath` per candidate buys existence too — a
 * file earlier runs read and a later one deleted throws, and a path named that
 * does not exist is a pointer at nothing. A failure to resolve is the answer
 * "no", not an error: the file being gone is the expected case.
 */
function containedFileIn(root: string): (rel: string) => boolean {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return () => false;
  }
  return (rel) => {
    const joined = path.resolve(realRoot, rel);
    if (!joined.startsWith(realRoot + path.sep)) return false;
    try {
      const real = fs.realpathSync(joined);
      return real.startsWith(realRoot + path.sep) && fs.statSync(real).isFile();
    } catch {
      return false;
    }
  };
}
