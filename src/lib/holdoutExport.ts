import path from "node:path";
import { db, getJSON, setJSON } from "./db";
import { resolveKnowledgeRoot } from "./knowledge";
import { TERMINAL_STATUSES } from "./orchestrator";
import {
  HISTORY_RUNS,
  historyReads,
  holdoutArmFor,
  inHoldout,
  priorReadRanking,
  priorReadsConsidered,
  repoRelative,
} from "./priorReads";
import { getSettings } from "./settings";

/**
 * The evidence of both pointer holdouts, copied out of `run_events` into tables
 * the event sweep does not touch.
 *
 * `sweepRunEvents` deletes a settled run's events thirty days after they were
 * written, and what each holdout is compared on — what a prompt named, what the
 * run then opened — lives only there. `runRetentionSweep` runs this ahead of
 * every sweep, so a row's evidence is out before the sweep that would take it;
 * and it runs once at boot, which is how the first pass reaches back to the
 * earliest events that still exist. Nothing here analyses anything:
 * `Analysis Plan for the Prior-Read Pointer Holdout.md`'s "Fields to export" is
 * the specification, and what could not be populated is listed in
 * `proposals/ContinuousImprovement/README.md`.
 *
 * **Idempotent and monotone, and that is the property to keep.** A pass can run
 * at any time, on a run whose events are half swept, without making a row worse:
 * evidence rows are `INSERT OR IGNORE` on the event's own id, a count only
 * grows, and a derived field that was written is never rewritten from less
 * evidence than it had. A settled run is finalised and skipped until it is
 * picked up again.
 */

/** Settings key the last pass's summary is stored under, `retention.lastSweep`'s shape. */
const LAST_EXPORT_KEY = "holdout.lastExport";

/**
 * The tool names whose calls are the holdout's outcome and its displacement.
 *
 * Any other call that names a `file_path` is kept too (`MultiEdit`, an MCP tool
 * that opens a file): the compliance join counts a file as opened by whatever
 * opened it, and an export narrower than that would score a different number.
 */
const TOOL_NAMES = ["Read", "Grep", "Glob", "Edit", "Write"] as const;

/** Runs between two yields to the event loop on a long pass. */
const YIELD_EVERY = 20;

/* ------------------------------------------------------------------ */
/* Pure parts                                                          */
/* ------------------------------------------------------------------ */

export interface PromptBlocks {
  /** `priorReadsNotice`'s block, or null when the prompt carries none. */
  priorReadBlock: string | null;
  /** `vaultPointerNotice`'s block, or null. */
  vaultBlock: string | null;
  /** The prompt with both blocks taken out: the brief, and the app's own notices. */
  rest: string;
}

// Anchored on the generated header, which is not a setting and so cannot have
// been edited, and ends at the first line that is not one of the block's own
// indented lines. The header is one line: `priorReadsNotice` joins its two
// sentences with a space.
const PRIOR_READ_BLOCK =
  /^The (?:file|\d+ files) that earlier runs on this repository opened most[^\n]*\n\n(?: {4}[^\n]+ \(\d+ runs?\)(?:\n|$))+/m;
// A pick is a blank line, a line carrying its confidence, and indented lines.
// Matched as that rather than as "whatever is indented", so a task that opens
// with an indented line is not read as part of the block it follows.
const VAULT_BLOCK =
  /^(?:One note|\d+ notes) in the operator's knowledge vault at [^\n]*(?:\n\n {4}[^\n]* \(confidence: [^\n]*\)(?:\n {6}[^\n]*)*)*/m;

/**
 * Separates the two pointer blocks from the rest of a first prompt.
 *
 * The compliance question is whether a run opened a path its prompt *named*,
 * and a path named in the pointer's block is the treatment where one named in
 * the brief is not. Without the split, a brief that mentions a file the block
 * also lists reads as the pointer having named it.
 */
export function splitPromptBlocks(prompt: string): PromptBlocks {
  const priorReadBlock = PRIOR_READ_BLOCK.exec(prompt)?.[0] ?? null;
  let rest = priorReadBlock === null ? prompt : prompt.replace(priorReadBlock, "");
  const vaultBlock = VAULT_BLOCK.exec(rest)?.[0] ?? null;
  if (vaultBlock !== null) rest = rest.replace(vaultBlock, "");
  return { priorReadBlock, vaultBlock, rest };
}

/** The paths of `priorReadsNotice`'s lines, in the order they were listed. */
export function blockPaths(block: string | null): string[] {
  if (block === null) return [];
  const paths: string[] = [];
  for (const line of block.split("\n")) {
    const match = /^ {4}(.+) \(\d+ runs?\)$/.exec(line);
    if (match) paths.push(match[1]);
  }
  return paths;
}

// Extensions a bare token is accepted on. A token with a slash in it is a path
// whatever it ends in; one without needs a reason, or "e.g." and "v1.2" are.
const FILE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "md", "mdx", "py", "rb", "go", "rs",
  "java", "kt", "c", "h", "cpp", "css", "scss", "html", "yml", "yaml", "toml", "sql", "sh", "txt", "lock",
]);

const WRAPPING = /^[\s"'`([{<]+|[\s"'`)\]}>,;:.!?]+$/g;

/**
 * The repository-relative paths a piece of prompt text names, in order, once each.
 *
 * Deliberately over-inclusive, because the join that scores compliance matches
 * these against paths a run actually opened: a token that is not a path matches
 * nothing there. An absolute path is kept only when it lies inside `base`, as
 * the relative path it names — a path elsewhere points at no file in this tree.
 */
export function promptPaths(text: string, base: string | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\s+/)) {
    let token = raw.replace(WRAPPING, "");
    if (token === "" || token.includes("://") || /[\u0000-\u001f\u007f]/.test(token)) continue;
    if (token.startsWith("/")) {
      const rel = repoRelative(token, base);
      if (rel === null) continue;
      token = rel;
    } else {
      token = token.replace(/^(?:\.\/)+/, "");
    }
    const ext = /\.([A-Za-z0-9]+)$/.exec(token)?.[1]?.toLowerCase();
    if (!token.includes("/") && !(ext && FILE_EXTENSIONS.has(ext))) continue;
    if (token === "" || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

export interface ToolEvent {
  name: string;
  path: string | null;
  pattern: string | null;
  glob: string | null;
  parentToolUseId: string | null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Whether a call looked inside the vault.
 *
 * A `Read` or `Edit` names a file and a `Grep` or `Glob` a directory, so all of
 * them are tested on `path`. A `Glob` with no `path` can still carry an absolute
 * pattern, which is how an agent reaches a directory it was just told about.
 */
export function insideVault(call: ToolEvent, vaultRoot: string | null): boolean {
  if (!vaultRoot) return false;
  const root = path.posix.normalize(vaultRoot).replace(/\/+$/, "");
  const within = (p: string | null) => {
    if (p === null || !path.posix.isAbsolute(p)) return false;
    const normal = path.posix.normalize(p);
    return normal === root || normal.startsWith(`${root}/`);
  };
  return within(call.path) || (call.name === "Glob" && call.path === null && within(call.pattern));
}

export interface IterationRecord {
  n: number | null;
  resuming: string | null;
  promptChars: number;
  priorReads: {
    arm: string;
    count: number;
    files: Array<{ path: string; runs: number }> | null;
    /** `snapshot@<ms>`, `snapshot-pending`, or null on an event from before snapshots. */
    treatment: string | null;
    basis: string | null;
  } | null;
  vault: {
    arm: string;
    paths: string[];
    costUsd: number | null;
    candidates: string[] | null;
    outcome: string | null;
    failure: string | null;
    root: string | null;
  } | null;
  blockPaths: string[];
  briefPaths: string[];
}

/** The instant a `snapshot@<ms>` treatment was taken, or null for any other. */
export function snapshotAtOf(treatment: string | null | undefined): number | null {
  const at = /^snapshot@(\d+)$/.exec(treatment ?? "")?.[1];
  return at === undefined ? null : Number(at);
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : null;
}

/**
 * The part of an `iteration` event the holdouts read, whichever shape it has.
 *
 * Two shapes exist for each pointer and both stay readable for as long as the
 * rows do: `priorReads.paths` was a count and is still, with the list beside it
 * as `files`; `vaultPointer` gained `candidates`, `outcome`, `failure` and
 * `root`. A field an old event does not have is null here, never a guess — the
 * export's contract is that NULL means "not recorded".
 */
export function iterationRecord(payload: unknown, base: string | null): IterationRecord {
  const p = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
  const prompt = typeof p.prompt === "string" ? p.prompt : "";
  const blocks = splitPromptBlocks(prompt);

  const pr = typeof p.priorReads === "object" && p.priorReads !== null ? (p.priorReads as Record<string, unknown>) : null;
  let priorReads: IterationRecord["priorReads"] = null;
  if (pr && (pr.arm === "pointer" || pr.arm === "holdout")) {
    const files = Array.isArray(pr.files)
      ? pr.files.flatMap((f) => {
          const entry = f as { path?: unknown; runs?: unknown };
          return typeof entry?.path === "string" ? [{ path: entry.path, runs: Number(entry.runs) || 0 }] : [];
        })
      : null;
    priorReads = {
      arm: pr.arm,
      count: files ? files.length : typeof pr.paths === "number" ? pr.paths : 0,
      files,
      treatment: text(pr.treatment),
      basis: text(pr.basis),
    };
  }

  const vp = typeof p.vaultPointer === "object" && p.vaultPointer !== null ? (p.vaultPointer as Record<string, unknown>) : null;
  let vault: IterationRecord["vault"] = null;
  if (vp && (vp.arm === "pointer" || vp.arm === "holdout")) {
    vault = {
      arm: vp.arm,
      paths: strings(vp.paths) ?? [],
      costUsd: typeof vp.costUsd === "number" ? vp.costUsd : null,
      candidates: strings(vp.candidates),
      outcome: text(vp.outcome),
      failure: text(vp.failure),
      root: text(vp.root),
    };
  }

  return {
    n: typeof p.n === "number" ? p.n : null,
    resuming: text(p.resuming),
    promptChars: prompt.length,
    priorReads,
    vault,
    blockPaths: blockPaths(blocks.priorReadBlock),
    briefPaths: promptPaths(blocks.rest, base),
  };
}

/**
 * What the vault pointer concluded, as one word the abstention rate can count.
 *
 * An event written since the pointer started saying why carries `outcome`, and
 * that wins. An older one has only the picks, so a run that picked something is
 * `picked`, one the log says failed is `failed`, and one with no picks is
 * `none-unsplit`: "no candidates" and "the gate declined" were one sentence
 * then, and a guess between them would put a number on the rate that the data
 * cannot back.
 */
export function vaultOutcome(
  vault: NonNullable<IterationRecord["vault"]>,
  loggedFailure: string | null,
): string {
  if (vault.outcome) return vault.outcome;
  if (vault.paths.length > 0) return "picked";
  if (vault.failure || loggedFailure) return "failed";
  return "none-unsplit";
}

/* ------------------------------------------------------------------ */
/* The pass                                                            */
/* ------------------------------------------------------------------ */

interface RunColumns {
  id: string;
  folder: string;
  folder_repo: string | null;
  repo_root: string | null;
  provider: string | null;
  model: string | null;
  status: string;
  stop_reason: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  max_iterations: number;
  iterations: number;
  spent_usd: number;
  spent_tokens: number;
  reported_done: number;
  continues_run: string | null;
  origin_ref: string | null;
  isolation: string | null;
  prompt: string;
  live_siblings: string | null;
  worktree_path: string | null;
  work_dir: string | null;
}

interface StoredRun {
  finalized_at: number | null;
  first_event_ts: number | null;
  prior_read_arm: string | null;
  prior_read_arm_source: string | null;
  prior_read_arm_basis: string | null;
  prior_read_ranking: string | null;
  prior_read_ranking_source: string | null;
  preceding_runs: string | null;
  overlapping_runs: string | null;
  tool_error_count: number;
  subagent_count: number;
  results: string | null;
}

type ArmPair = [string, string | null];

const RUN_COLUMNS =
  "id, folder, folder_repo, repo_root, provider, model, status, stop_reason, created_at, started_at, finished_at, " +
  "max_iterations, iterations, spent_usd, spent_tokens, reported_done, continues_run, origin_ref, isolation, prompt, " +
  "live_siblings, worktree_path, work_dir";

function repositoryOf(run: Pick<RunColumns, "folder_repo" | "repo_root">): string | null {
  const repository = run.folder_repo ?? run.repo_root;
  return repository ? repository : null;
}

/**
 * A run's arm in the prior-read holdout, from what is recorded about it.
 *
 * The exported row first, because it holds the arm the run was actually dealt;
 * the hash of its id only for a run no event or export has spoken for, which is
 * what `inHoldout` was before the arm could be anything else. Null for a run the
 * pointer does not consider.
 */
function armOf(
  run: Pick<RunColumns, "id" | "folder_repo" | "repo_root" | "provider" | "origin_ref" | "continues_run">,
  exported: Map<string, string | null>,
): string | null {
  if (exported.has(run.id)) return exported.get(run.id)!;
  if (!priorReadsConsidered({ repository: repositoryOf(run), provider: run.provider, originRef: run.origin_ref })) {
    return null;
  }
  return holdoutArmFor(run.id, run.continues_run).arm;
}

function armsOf(rows: RunColumns[]): ArmPair[] {
  const ids = rows.map((r) => r.id);
  const exported = new Map<string, string | null>();
  if (ids.length > 0) {
    const stored = db()
      .prepare(`SELECT run_id, prior_read_arm FROM holdout_runs WHERE run_id IN (${ids.map(() => "?").join(",")})`)
      .all(...ids) as Array<{ run_id: string; prior_read_arm: string | null }>;
    for (const s of stored) exported.set(s.run_id, s.prior_read_arm);
  }
  return rows.map((r) => [r.id, armOf(r, exported)]);
}

const ARM_COLUMNS = "id, folder_repo, repo_root, provider, origin_ref, continues_run";

function precedingRuns(run: RunColumns, repository: string): ArmPair[] {
  const rows = db()
    .prepare(
      `SELECT ${ARM_COLUMNS} FROM runs
        WHERE COALESCE(folder_repo, repo_root) = ? AND created_at < ? AND id <> ?
        ORDER BY created_at DESC LIMIT ${HISTORY_RUNS}`,
    )
    .all(repository, run.created_at, run.id) as RunColumns[];
  return armsOf(rows);
}

function overlappingRuns(run: RunColumns, repository: string, now: number): ArmPair[] {
  if (run.started_at === null) return [];
  const rows = db()
    .prepare(
      `SELECT ${ARM_COLUMNS} FROM runs
        WHERE COALESCE(folder_repo, repo_root) = ? AND id <> ?
          AND started_at IS NOT NULL AND started_at <= ? AND COALESCE(finished_at, ?) >= ?
        ORDER BY started_at, id`,
    )
    .all(repository, run.id, run.finished_at ?? now, now, run.started_at) as RunColumns[];
  return armsOf(rows);
}

/** The root a run's pointer-relative paths are relative to: `priorReadsFor`'s `base`. */
function baseOf(run: RunColumns): string | null {
  return run.worktree_path || run.folder_repo || run.work_dir || run.folder || null;
}

export interface HoldoutExportSummary {
  at: number;
  /** Runs written or refreshed this pass. */
  runs: number;
  /** Rows newly written this pass. */
  cycles: number;
  toolEvents: number;
  /** Runs that threw. A pass with any must not be followed by a sweep of their events. */
  failed: number;
}

/** Runs worth exporting that are not already final, oldest first. */
function pendingRuns(): Array<{ id: string }> {
  const settled = TERMINAL_STATUSES.map(() => "?").join(",");
  return db()
    .prepare(
      `SELECT r.id FROM runs r LEFT JOIN holdout_runs h ON h.run_id = r.id
        WHERE COALESCE(r.provider, '') NOT IN ('codex', 'local')
          AND COALESCE(r.origin_ref, '') NOT LIKE 'dreaming:%'
          AND (
            (COALESCE(r.folder_repo, r.repo_root, '') <> '' AND r.started_at IS NOT NULL)
            OR EXISTS (SELECT 1 FROM run_events e
                        WHERE e.run_id = r.id AND e.kind = 'iteration'
                          AND (json_extract(e.payload, '$.vaultPointer') IS NOT NULL
                               OR json_extract(e.payload, '$.priorReads') IS NOT NULL))
          )
          AND NOT (
            h.finalized_at IS NOT NULL
            AND r.status IN (${settled})
            AND COALESCE(r.finished_at, 0) <= h.finalized_at
          )
        ORDER BY r.created_at, r.id`,
    )
    .all(...TERMINAL_STATUSES) as Array<{ id: string }>;
}

function currentVaultRoot(): string | null {
  try {
    const root = resolveKnowledgeRoot(getSettings());
    return root.ok ? root.root : null;
  } catch {
    // An unreadable setting leaves the flag false on this pass; the call's own
    // path is stored beside it, so the column can be recomputed.
    return null;
  }
}

function exportRun(id: string, now: number, vaultRootNow: string | null, counters: HoldoutExportSummary): void {
  const run = db().prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE id = ?`).get(id) as RunColumns | undefined;
  if (!run) return;
  const stored = db()
    .prepare("SELECT * FROM holdout_runs WHERE run_id = ?")
    .get(id) as StoredRun | undefined;
  const repository = repositoryOf(run);
  const base = baseOf(run);
  const settledNow = (TERMINAL_STATUSES as readonly string[]).includes(run.status);

  const iterations = db()
    .prepare("SELECT id, ts, payload FROM run_events WHERE run_id = ? AND kind = 'iteration' ORDER BY id")
    .all(id) as Array<{ id: number; ts: number; payload: string }>;
  const cycles = iterations.map((e) => {
    let payload: unknown = null;
    try {
      payload = JSON.parse(e.payload);
    } catch {
      // A payload that does not parse is recorded as a cycle with nothing in
      // it; the row's existence is still evidence the cycle happened.
    }
    return { eventId: e.id, ts: e.ts, record: iterationRecord(payload, base) };
  });

  const failureLogged = db()
    .prepare(
      "SELECT json_extract(payload, '$.vaultPointer.failure') AS failure FROM run_events " +
        "WHERE run_id = ? AND kind = 'log' AND json_extract(payload, '$.vaultPointer.failure') IS NOT NULL LIMIT 1",
    )
    .get(id) as { failure: string } | undefined;

  const loggedPrior = cycles.find((c) => c.record.priorReads)?.record.priorReads ?? null;
  const loggedVault = cycles.find((c) => c.record.vault)?.record.vault ?? null;

  // The arm the run was dealt: the event that says so, else the hash. 'derived'
  // marks the second so the analysis can leave those rows out of anything that
  // depends on the arm having been the one that was acted on.
  const considered = priorReadsConsidered({
    repository,
    provider: run.provider,
    originRef: run.origin_ref,
  });
  let priorArm: string | null = null;
  let priorSource: string | null = null;
  let priorBasis: string | null = null;
  if (loggedPrior) {
    priorArm = loggedPrior.arm;
    priorSource = "logged";
    priorBasis = loggedPrior.basis ?? "id";
  } else if (stored?.prior_read_arm) {
    priorArm = stored.prior_read_arm;
    priorSource = stored.prior_read_arm_source;
    priorBasis = stored.prior_read_arm_basis;
  } else if (considered) {
    const dealt = holdoutArmFor(id, run.continues_run);
    priorArm = dealt.arm;
    priorBasis = dealt.basis;
    priorSource = "derived";
  }
  const vaultArm = loggedVault ? loggedVault.arm : null;

  // The list the run was shown or held back from. A cycle that logged it is the
  // record; otherwise the ranking is rebuilt from the events that survive,
  // once, and never over a better answer.
  let ranking = stored?.prior_read_ranking ?? null;
  let rankingSource = stored?.prior_read_ranking_source ?? null;
  let rankingRuns: number | null = null;
  let rankingReads: number | null = null;
  const loggedFiles = loggedPrior?.files ?? null;
  if (loggedFiles) {
    ranking = JSON.stringify(loggedFiles);
    rankingSource = "logged";
  } else if (ranking === null && considered && repository !== null) {
    const reads = historyReads(repository, run.created_at, id);
    ranking = JSON.stringify(priorReadRanking(reads));
    rankingSource = "recomputed";
    rankingRuns = new Set(reads.map((r) => r.runId)).size;
    rankingReads = reads.length;
  }

  const tools = db()
    .prepare(
      `SELECT id, ts,
              json_extract(payload, '$.name') AS name,
              COALESCE(json_extract(payload, '$.input.file_path'), json_extract(payload, '$.input.notebook_path'),
                       json_extract(payload, '$.input.path')) AS path,
              json_extract(payload, '$.input.pattern') AS pattern,
              json_extract(payload, '$.input.glob') AS glob,
              json_extract(payload, '$.parentToolUseId') AS parentToolUseId
         FROM run_events
        WHERE run_id = ? AND kind = 'tool'
          AND json_extract(payload, '$.name') IS NOT NULL
          AND (json_extract(payload, '$.name') IN (${TOOL_NAMES.map(() => "?").join(",")})
               OR json_extract(payload, '$.input.file_path') IS NOT NULL)
        ORDER BY id`,
    )
    .all(id, ...TOOL_NAMES) as Array<{
    id: number;
    ts: number;
    name: string;
    path: unknown;
    pattern: unknown;
    glob: unknown;
    parentToolUseId: unknown;
  }>;

  const counts = db()
    .prepare(
      "SELECT kind, COUNT(*) AS n FROM run_events WHERE run_id = ? AND kind IN ('tool_error', 'subagent') GROUP BY kind",
    )
    .all(id) as Array<{ kind: string; n: number }>;
  const countOf = (kind: string) => counts.find((c) => c.kind === kind)?.n ?? 0;

  const resultRows = db()
    .prepare(
      `SELECT ts, json_extract(payload, '$.subtype') AS subtype, json_extract(payload, '$.costUSD') AS costUSD,
              json_extract(payload, '$.numTurns') AS numTurns, json_extract(payload, '$.durationMs') AS durationMs
         FROM run_events WHERE run_id = ? AND kind = 'result' ORDER BY id`,
    )
    .all(id);
  const keepStoredResults = stored?.results && (JSON.parse(stored.results) as unknown[]).length > resultRows.length;

  const firstEvent = db()
    .prepare("SELECT MIN(ts) AS ts FROM run_events WHERE run_id = ?")
    .get(id) as { ts: number | null };

  const vaultRoot = loggedVault?.root ?? vaultRootNow;
  const finalise = settledNow ? now : null;

  db().transaction(() => {
    const insertCycle = db().prepare(
      `INSERT OR IGNORE INTO holdout_cycles (event_id, run_id, ts, n, resuming, prompt_chars,
         prior_read_arm, prior_read_count, prior_read_files, prior_read_snapshot_at,
         prompt_block_paths, prompt_brief_paths,
         vault_arm, vault_paths, vault_cost_usd, vault_candidates, vault_outcome, vault_failure, vault_root)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const c of cycles) {
      const r = c.record;
      counters.cycles += insertCycle.run(
        c.eventId, id, c.ts, r.n, r.resuming, r.promptChars,
        r.priorReads?.arm ?? null, r.priorReads?.count ?? null,
        r.priorReads?.files ? JSON.stringify(r.priorReads.files) : null, snapshotAtOf(r.priorReads?.treatment),
        JSON.stringify(r.blockPaths), JSON.stringify(r.briefPaths),
        r.vault?.arm ?? null, r.vault ? JSON.stringify(r.vault.paths) : null, r.vault?.costUsd ?? null,
        r.vault?.candidates ? JSON.stringify(r.vault.candidates) : null,
        r.vault ? vaultOutcome(r.vault, failureLogged?.failure ?? null) : null,
        r.vault?.failure ?? failureLogged?.failure ?? null, r.vault?.root ?? null,
      ).changes;
    }

    const insertTool = db().prepare(
      `INSERT OR IGNORE INTO holdout_tool_events
         (event_id, run_id, ts, name, path, pattern, glob, parent_tool_use_id, in_vault)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const t of tools) {
      const call: ToolEvent = {
        name: t.name,
        path: text(t.path),
        pattern: text(t.pattern),
        glob: text(t.glob),
        parentToolUseId: text(t.parentToolUseId),
      };
      counters.toolEvents += insertTool.run(
        t.id, id, t.ts, call.name, call.path, call.pattern, call.glob, call.parentToolUseId,
        insideVault(call, vaultRoot) ? 1 : 0,
      ).changes;
    }

    const preceding = stored?.preceding_runs ?? (repository !== null && considered ? JSON.stringify(precedingRuns(run, repository)) : null);
    const overlapping = repository !== null ? JSON.stringify(overlappingRuns(run, repository, now)) : null;

    db().prepare(
      `INSERT INTO holdout_runs (run_id, exported_at, finalized_at, first_event_ts, repository, folder, folder_repo, repo_root,
         provider, model, status, stop_reason, created_at, started_at, finished_at, max_iterations, iterations,
         spent_usd, spent_tokens, reported_done, continues_run, origin_ref, isolation, prompt_chars, live_siblings,
         prior_read_arm, prior_read_arm_source, prior_read_arm_basis, prior_read_arm_by_id, prior_read_treatment,
         prior_read_ranking, prior_read_ranking_source, prior_read_ranking_runs, prior_read_ranking_reads,
         vault_arm, preceding_runs, overlapping_runs, tool_error_count, subagent_count, results)
       VALUES (@run_id, @exported_at, @finalized_at, @first_event_ts, @repository, @folder, @folder_repo, @repo_root,
         @provider, @model, @status, @stop_reason, @created_at, @started_at, @finished_at, @max_iterations, @iterations,
         @spent_usd, @spent_tokens, @reported_done, @continues_run, @origin_ref, @isolation, @prompt_chars, @live_siblings,
         @prior_read_arm, @prior_read_arm_source, @prior_read_arm_basis, @prior_read_arm_by_id, @prior_read_treatment,
         @prior_read_ranking, @prior_read_ranking_source, @prior_read_ranking_runs, @prior_read_ranking_reads,
         @vault_arm, @preceding_runs, @overlapping_runs, @tool_error_count, @subagent_count, @results)
       ON CONFLICT(run_id) DO UPDATE SET
         exported_at = excluded.exported_at, finalized_at = excluded.finalized_at,
         first_event_ts = MIN(COALESCE(holdout_runs.first_event_ts, excluded.first_event_ts), COALESCE(excluded.first_event_ts, holdout_runs.first_event_ts)),
         repository = excluded.repository, folder = excluded.folder, folder_repo = excluded.folder_repo, repo_root = excluded.repo_root,
         provider = excluded.provider, model = excluded.model, status = excluded.status, stop_reason = excluded.stop_reason,
         started_at = excluded.started_at, finished_at = excluded.finished_at, max_iterations = excluded.max_iterations,
         iterations = excluded.iterations, spent_usd = excluded.spent_usd, spent_tokens = excluded.spent_tokens,
         reported_done = excluded.reported_done, continues_run = excluded.continues_run, origin_ref = excluded.origin_ref,
         isolation = excluded.isolation, prompt_chars = excluded.prompt_chars, live_siblings = excluded.live_siblings,
         prior_read_arm = excluded.prior_read_arm, prior_read_arm_source = excluded.prior_read_arm_source,
         prior_read_arm_basis = excluded.prior_read_arm_basis,
         prior_read_arm_by_id = excluded.prior_read_arm_by_id,
         prior_read_treatment = COALESCE(excluded.prior_read_treatment, holdout_runs.prior_read_treatment),
         prior_read_ranking = excluded.prior_read_ranking, prior_read_ranking_source = excluded.prior_read_ranking_source,
         prior_read_ranking_runs = COALESCE(excluded.prior_read_ranking_runs, holdout_runs.prior_read_ranking_runs),
         prior_read_ranking_reads = COALESCE(excluded.prior_read_ranking_reads, holdout_runs.prior_read_ranking_reads),
         vault_arm = COALESCE(excluded.vault_arm, holdout_runs.vault_arm),
         preceding_runs = COALESCE(holdout_runs.preceding_runs, excluded.preceding_runs),
         overlapping_runs = excluded.overlapping_runs,
         tool_error_count = MAX(holdout_runs.tool_error_count, excluded.tool_error_count),
         subagent_count = MAX(holdout_runs.subagent_count, excluded.subagent_count),
         results = excluded.results`,
    ).run({
      run_id: id,
      exported_at: now,
      finalized_at: finalise,
      first_event_ts: firstEvent.ts,
      repository,
      folder: run.folder,
      folder_repo: run.folder_repo,
      repo_root: run.repo_root,
      provider: run.provider,
      model: run.model,
      status: run.status,
      stop_reason: run.stop_reason,
      created_at: run.created_at,
      started_at: run.started_at,
      finished_at: run.finished_at,
      max_iterations: run.max_iterations,
      iterations: run.iterations,
      spent_usd: run.spent_usd,
      spent_tokens: run.spent_tokens,
      reported_done: run.reported_done,
      continues_run: run.continues_run,
      origin_ref: run.origin_ref,
      isolation: run.isolation,
      prompt_chars: run.prompt.length,
      live_siblings: run.live_siblings,
      prior_read_arm: priorArm,
      prior_read_arm_source: priorSource,
      prior_read_arm_basis: priorBasis,
      prior_read_arm_by_id: considered ? (inHoldout(id) ? "holdout" : "pointer") : null,
      // 'rolling' is what every run got before a repository's list was fixed, so
      // an event that does not name a snapshot is that, not unknown.
      prior_read_treatment: loggedPrior ? (loggedPrior.treatment ?? "rolling") : null,
      prior_read_ranking: ranking,
      prior_read_ranking_source: rankingSource,
      prior_read_ranking_runs: rankingRuns,
      prior_read_ranking_reads: rankingReads,
      vault_arm: vaultArm,
      preceding_runs: preceding,
      overlapping_runs: overlapping,
      tool_error_count: countOf("tool_error"),
      subagent_count: countOf("subagent"),
      results: keepStoredResults ? stored!.results : JSON.stringify(resultRows),
    });
  })();
}

/**
 * Copies every unfinalised considered run's evidence out of `run_events`.
 *
 * Yields to the event loop between batches: the first pass after an upgrade
 * reads every run the install has, and `liveGuardTick` must not wait on it. A
 * run that throws is counted and logged and the pass goes on, so one bad row
 * cannot hold back the rest — but `failed` is returned so that the caller can
 * refuse to sweep the events of a run it could not export.
 */
export async function exportHoldoutEvidence(now = Date.now()): Promise<HoldoutExportSummary> {
  const summary: HoldoutExportSummary = { at: now, runs: 0, cycles: 0, toolEvents: 0, failed: 0 };
  const vaultRootNow = currentVaultRoot();
  const pending = pendingRuns();
  for (let i = 0; i < pending.length; i++) {
    if (i > 0 && i % YIELD_EVERY === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      exportRun(pending[i].id, now, vaultRootNow, summary);
      summary.runs++;
    } catch (err) {
      summary.failed++;
      console.warn(
        `[usagefoundry] holdout export of run ${pending[i].id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  setJSON(LAST_EXPORT_KEY, { ...summary, ...holdoutExportCounts() });
  return summary;
}

export interface HoldoutExportCounts {
  /** Exported runs by prior-read arm and where the arm came from; NULL arm is "not considered". */
  priorRead: Array<{ arm: string | null; source: string | null; runs: number }>;
  /** Exported runs by vault-pointer arm; NULL arm is "no record". */
  vault: Array<{ arm: string | null; runs: number }>;
  /** The earliest event the export holds a run's evidence from. */
  oldestEventTs: number | null;
  oldestCycleTs: number | null;
}

/** What the tables hold, for the settings record and for whoever reads the experiment back. */
export function holdoutExportCounts(): HoldoutExportCounts {
  return {
    priorRead: db()
      .prepare(
        "SELECT prior_read_arm AS arm, prior_read_arm_source AS source, COUNT(*) AS runs FROM holdout_runs GROUP BY 1, 2 ORDER BY 1, 2",
      )
      .all() as HoldoutExportCounts["priorRead"],
    vault: db()
      .prepare("SELECT vault_arm AS arm, COUNT(*) AS runs FROM holdout_runs GROUP BY 1 ORDER BY 1")
      .all() as HoldoutExportCounts["vault"],
    oldestEventTs: (db().prepare("SELECT MIN(first_event_ts) AS ts FROM holdout_runs").get() as { ts: number | null }).ts,
    oldestCycleTs: (db().prepare("SELECT MIN(ts) AS ts FROM holdout_cycles").get() as { ts: number | null }).ts,
  };
}

export function lastHoldoutExport(): (HoldoutExportSummary & HoldoutExportCounts) | null {
  return getJSON<(HoldoutExportSummary & HoldoutExportCounts) | null>(LAST_EXPORT_KEY, null);
}
