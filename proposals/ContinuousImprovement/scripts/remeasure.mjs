#!/usr/bin/env node
// Re-measures the four headline figures of this proposal against an install's
// own database, read-only. See ../19-remeasure-2026-10.md for what each figure
// means, what it was in 2026-08, and the gate it decides.
//
// Inside the container, where the database is (nothing to copy, nothing written):
//
//   docker exec -i -w /app usagefoundry node --input-type=module - /data/usagefoundry.db \
//     < proposals/ContinuousImprovement/scripts/remeasure.mjs
//
// Against a copy on the host, from a checkout with node_modules installed:
//
//   node proposals/ContinuousImprovement/scripts/remeasure.mjs path/to/usagefoundry.db [--json]
//
// better-sqlite3 is resolved from the working directory, which is why the
// container form passes `-w /app`: that is where the standalone bundle's copy is.
// The database is opened `readonly: true` and `fileMustExist: true`, so a wrong
// path is an error rather than a new, empty file.
//
// Definitions, all of them stated in 19-remeasure-2026-10.md beside the figure:
// - A run's repository is COALESCE(folder_repo, repo_root), never repo_root
//   alone. A run with neither is in "(no repo)", which is reported and never
//   scored for coverage: it is every non-repository folder in one bucket.
// - A path is relativised against the run's checkout (worktree_path) when it
//   had one, else its repository (folder_repo), else its folder. A path outside
//   that stays absolute and is its own key.
// - A read is a repeat when some run created earlier on the same repository
//   read the same path (00-problem.md's FIRST_VALUE over created_at, id).
// - "Edited" means the same run called Edit, Write, MultiEdit or NotebookEdit
//   on the path at any point, before or after the read, as 04's split did.
import { createRequire } from "node:module";
import { join } from "node:path";

const args = process.argv.slice(2).filter((a) => a !== "-" && !a.startsWith("--"));
const asJson = process.argv.includes("--json");
const DB_PATH = args[0] ?? "/data/usagefoundry.db";
const NO_REPO = "(no repo)";
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

const require = createRequire(join(process.cwd(), "remeasure.cjs"));
const Database = require("better-sqlite3");
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

function time(label, fn) {
  const t0 = process.hrtime.bigint();
  const out = fn();
  timings[label] = Number(process.hrtime.bigint() - t0) / 1e6;
  return out;
}
const timings = {};

const runs = time("runs", () =>
  db
    .prepare(
      `SELECT id, created_at AS createdAt, folder, status, provider,
              COALESCE(folder_repo, repo_root) AS repo,
              COALESCE(NULLIF(worktree_path, ''), folder_repo, NULLIF(work_dir, ''), folder) AS base
         FROM runs`,
    )
    .all(),
);
const runById = new Map(runs.map((r) => [r.id, r]));

// One scan of `run_events`: it has no index on `kind`, so every filter here is
// a full scan whatever it says, and one is cheaper than three.
const toolRows = time("tool events", () =>
  db
    .prepare(
      `SELECT e.id, e.run_id AS runId, e.ts,
              json_extract(e.payload, '$.name') AS tool,
              COALESCE(json_extract(e.payload, '$.input.file_path'),
                       json_extract(e.payload, '$.input.notebook_path')) AS filePath,
              json_extract(e.payload, '$.parentToolUseId') AS parent
         FROM run_events e
        WHERE e.kind = 'tool'
          AND json_extract(e.payload, '$.name') IN ('Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit')
        ORDER BY e.id`,
    )
    .all(),
);

function relativise(path, base) {
  if (typeof path !== "string" || path === "") return null;
  if (!base) return path;
  const root = base.endsWith("/") ? base : `${base}/`;
  return path.startsWith(root) ? path.slice(root.length) : path;
}

const events = [];
for (const row of toolRows) {
  const run = runById.get(row.runId);
  if (!run) continue;
  const rel = relativise(row.filePath, run.base);
  if (rel === null) continue;
  events.push({
    ...row,
    rel,
    repo: run.repo ?? NO_REPO,
    createdAt: run.createdAt,
    mainThread: row.parent === null,
  });
}

/* ---------------- 1 and 2: repeat reading, split by edited ---------------- */

function repeatReading(evs) {
  const edited = new Set();
  for (const e of evs) if (EDIT_TOOLS.has(e.tool)) edited.add(`${e.runId}\u0000${e.rel}`);
  const reads = evs
    .filter((e) => e.tool === "Read")
    .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  const firstRun = new Map();
  const byRepo = new Map();
  const total = { reads: 0, repeats: 0, repeatsEdited: 0, repeatsNotEdited: 0 };
  for (const r of reads) {
    const key = `${r.repo}\u0000${r.rel}`;
    if (!firstRun.has(key)) firstRun.set(key, r.runId);
    let row = byRepo.get(r.repo);
    if (!row) byRepo.set(r.repo, (row = { repo: r.repo, reads: 0, repeats: 0, repeatsEdited: 0, repeatsNotEdited: 0 }));
    for (const t of [row, total]) {
      t.reads += 1;
      if (firstRun.get(key) === r.runId) continue;
      t.repeats += 1;
      if (edited.has(`${r.runId}\u0000${r.rel}`)) t.repeatsEdited += 1;
      else t.repeatsNotEdited += 1;
    }
  }
  return { total, byRepo: [...byRepo.values()].sort((a, b) => b.reads - a.reads) };
}

const reading = time("repeat reading", () => repeatReading(events));
const readingMain = repeatReading(events.filter((e) => e.mainThread));

/* ---------------- 3: prequential top-K coverage ---------------- */

const OPENING = 8;
const RULES = ["decay", "raw", "distinct"];

function coverage(evs, { k, decay = 0.9 }) {
  const reads = evs.filter((e) => e.tool === "Read" && e.repo !== NO_REPO);
  const byRun = new Map();
  for (const e of reads) {
    let list = byRun.get(e.runId);
    if (!list) byRun.set(e.runId, (list = []));
    list.push(e);
  }
  const runsByRepo = new Map();
  for (const [runId, list] of byRun) {
    list.sort((a, b) => a.id - b.id);
    const run = runById.get(runId);
    const repo = list[0].repo;
    let ordered = runsByRepo.get(repo);
    if (!ordered) runsByRepo.set(repo, (ordered = []));
    ordered.push({ runId, createdAt: run.createdAt, reads: list });
  }
  const out = {};
  for (const rule of RULES) out[rule] = { scoredRuns: 0, opening: 0, hits: 0 };
  for (const ordered of runsByRepo.values()) {
    ordered.sort((a, b) => a.createdAt - b.createdAt || (a.runId < b.runId ? -1 : 1));
    for (let t = 1; t < ordered.length; t += 1) {
      const decayed = new Map();
      const raw = new Map();
      const distinct = new Map();
      for (let s = 0; s < t; s += 1) {
        const w = decay ** (t - 1 - s);
        const seen = new Set();
        for (const e of ordered[s].reads) {
          decayed.set(e.rel, (decayed.get(e.rel) ?? 0) + w);
          raw.set(e.rel, (raw.get(e.rel) ?? 0) + 1);
          if (!seen.has(e.rel)) {
            seen.add(e.rel);
            distinct.set(e.rel, (distinct.get(e.rel) ?? 0) + 1);
          }
        }
      }
      const opening = ordered[t].reads.slice(0, OPENING);
      for (const [rule, scores] of Object.entries({ decay: decayed, raw, distinct })) {
        // Ties broken by path, so two runs of this script agree; 00-problem.md's
        // scorer broke them arbitrarily and moved the figure by ~0.2 points.
        const top = new Set(
          [...scores]
            .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
            .slice(0, k)
            .map(([path]) => path),
        );
        const tally = out[rule];
        tally.scoredRuns += 1;
        tally.opening += opening.length;
        tally.hits += opening.filter((e) => top.has(e.rel)).length;
      }
    }
  }
  return out;
}

const cov20 = time("coverage top-20", () => coverage(events, { k: 20 }));
const cov40 = coverage(events, { k: 40 });
const cov20Main = coverage(events.filter((e) => e.mainThread), { k: 20 });

/* ---------------- 4: OTLP spend before the first edit ---------------- */

const otlp = time("otlp", () =>
  db
    .prepare(`SELECT run_id AS runId, ts, cost_usd AS cost, query_source AS source FROM otlp_requests WHERE run_id IS NOT NULL`)
    .all(),
);
function spendBeforeFirstEdit(repoFilter) {
  const firstEdit = new Map();
  for (const e of events) {
    if (!EDIT_TOOLS.has(e.tool)) continue;
    const at = firstEdit.get(e.runId);
    if (at === undefined || e.ts < at) firstEdit.set(e.runId, e.ts);
  }
  const perRun = new Map();
  for (const o of otlp) {
    const run = runById.get(o.runId);
    if (!run || !repoFilter(run.repo ?? NO_REPO)) continue;
    let p = perRun.get(o.runId);
    if (!p) perRun.set(o.runId, (p = { total: 0, before: 0, sdkTotal: 0, sdkBefore: 0, hasSdk: false }));
    const edit = firstEdit.get(o.runId);
    const before = edit !== undefined && o.ts < edit;
    p.total += o.cost;
    if (before) p.before += o.cost;
    if (o.source === "sdk") {
      p.hasSdk = true;
      p.sdkTotal += o.cost;
      if (before) p.sdkBefore += o.cost;
    }
  }
  const eligible = [...perRun].filter(([runId, p]) => p.hasSdk && firstEdit.has(runId) && p.total > 0);
  const sum = (f) => eligible.reduce((acc, [, p]) => acc + f(p), 0);
  const shares = eligible.map(([, p]) => p.before / p.total).sort((a, b) => a - b);
  const neverEdited = [...perRun].filter(([runId, p]) => p.hasSdk && !firstEdit.has(runId)).length;
  return {
    runs: eligible.length,
    neverEdited,
    totalUSD: sum((p) => p.total),
    beforeUSD: sum((p) => p.before),
    sdkTotalUSD: sum((p) => p.sdkTotal),
    sdkBeforeUSD: sum((p) => p.sdkBefore),
    medianRunShare: shares.length ? shares[Math.floor((shares.length - 1) / 2)] : null,
  };
}
const biggestRepo = reading.byRepo.find((r) => r.repo !== NO_REPO)?.repo ?? null;
const spendAll = spendBeforeFirstEdit(() => true);
const spendBiggest = biggestRepo ? spendBeforeFirstEdit((repo) => repo === biggestRepo) : null;

/* ---------------- the range this covers ---------------- */

const range = db
  .prepare(
    `SELECT (SELECT MIN(ts) FROM run_events) AS eventsFrom, (SELECT MAX(ts) FROM run_events) AS eventsTo,
            (SELECT MIN(ts) FROM otlp_requests) AS otlpFrom, (SELECT MAX(ts) FROM otlp_requests) AS otlpTo,
            (SELECT COUNT(*) FROM run_events) AS eventRows`,
  )
  .get();
const runsWithReads = new Set(events.filter((e) => e.tool === "Read").map((e) => e.runId));

const pct = (n, d) => (d > 0 ? `${((100 * n) / d).toFixed(1)}%` : "n/a");
const day = (ms) => (ms == null ? "n/a" : new Date(ms).toISOString().slice(0, 16).replace("T", " "));
const t = reading.total;
const addressable = t.reads > 0 ? t.repeatsNotEdited / t.reads : 0;
const decay20 = cov20.decay.opening > 0 ? cov20.decay.hits / cov20.decay.opening : 0;

const result = {
  db: DB_PATH,
  measuredAt: new Date().toISOString(),
  range: { ...range, runs: runs.length, runsWithReads: runsWithReads.size },
  repeatReading: reading,
  repeatReadingMainThread: readingMain.total,
  coverageTop20: cov20,
  coverageTop40: cov40,
  coverageTop20MainThread: cov20Main,
  spendBeforeFirstEdit: { allRepositories: spendAll, biggestRepository: biggestRepo, biggest: spendBiggest },
  gate: {
    addressableShare: addressable,
    decayTop20Coverage: decay20,
    passes: addressable >= 0.15 && decay20 >= 0.25,
  },
  timingsMs: timings,
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const lines = [
    `database          ${DB_PATH}, opened read-only`,
    `run_events        ${range.eventRows} rows, ${day(range.eventsFrom)} → ${day(range.eventsTo)} UTC`,
    `otlp_requests     ${day(range.otlpFrom)} → ${day(range.otlpTo)} UTC`,
    `runs              ${runs.length} rows, ${runsWithReads.size} with a Read event`,
    "",
    `1 repeat reads    ${t.repeats} of ${t.reads} = ${pct(t.repeats, t.reads)}   (2026-08: 73.2%, 4,284 of 5,856)`,
    `2 then edited     ${t.repeatsEdited} = ${pct(t.repeatsEdited, t.repeats)} of repeats   (2026-08: 50.6%)`,
    `  addressable     ${t.repeatsNotEdited} of ${t.reads} = ${pct(t.repeatsNotEdited, t.reads)}   (2026-08: 36.1%)`,
    `  main thread     ${readingMain.total.repeats} of ${readingMain.total.reads} repeat, ${pct(readingMain.total.repeatsNotEdited, readingMain.total.reads)} addressable`,
    "",
    "  per repository  reads / repeats / repeat-edited / repeat-not-edited",
    ...reading.byRepo.map((r) => `    ${r.repo}  ${r.reads} / ${r.repeats} / ${r.repeatsEdited} / ${r.repeatsNotEdited}`),
    "",
    `3 top-20 ×0.9     ${pct(cov20.decay.hits, cov20.decay.opening)} of ${cov20.decay.opening} opening reads over ${cov20.decay.scoredRuns} runs   (2026-08: 45.0%)`,
    `  raw frequency   ${pct(cov20.raw.hits, cov20.raw.opening)}   (2026-08: 42.3%)`,
    `  distinct runs   ${pct(cov20.distinct.hits, cov20.distinct.opening)}   (2026-08: 39.2%)`,
    `  top-40          ×0.9 ${pct(cov40.decay.hits, cov40.decay.opening)}, raw ${pct(cov40.raw.hits, cov40.raw.opening)}, distinct ${pct(cov40.distinct.hits, cov40.distinct.opening)}   (2026-08: 59.0 / 53.9 / 51.6%)`,
    `  main thread     ×0.9 top-20 ${pct(cov20Main.decay.hits, cov20Main.decay.opening)}   (2026-08 re-run: 46.5%)`,
    "",
    `4 OTLP before 1st edit, all repositories: $${spendAll.beforeUSD.toFixed(2)} of $${spendAll.totalUSD.toFixed(2)} = ${pct(spendAll.beforeUSD, spendAll.totalUSD)} over ${spendAll.runs} runs, median run ${spendAll.medianRunShare === null ? "n/a" : pct(spendAll.medianRunShare, 1)}; sdk only ${pct(spendAll.sdkBeforeUSD, spendAll.sdkTotalUSD)}; ${spendAll.neverEdited} runs never edited`,
    spendBiggest
      ? `  ${biggestRepo}: $${spendBiggest.beforeUSD.toFixed(2)} of $${spendBiggest.totalUSD.toFixed(2)} = ${pct(spendBiggest.beforeUSD, spendBiggest.totalUSD)} over ${spendBiggest.runs} runs, median run ${spendBiggest.medianRunShare === null ? "n/a" : pct(spendBiggest.medianRunShare, 1)}   (2026-08, UsageFoundry: 20.9%, median 24.4%, 177 runs)`
      : "  no repository with OTLP rows",
    "",
    `gate              addressable ${pct(addressable, 1)} (needs ≥ 15%), ×0.9 top-20 ${pct(decay20, 1)} (needs ≥ 25%): ${result.gate.passes ? "PASSES" : "STOPS the pointer"}`,
    `query time        ${Object.entries(timings).map(([k, v]) => `${k} ${v.toFixed(0)} ms`).join(", ")}`,
  ];
  console.log(lines.join("\n"));
}
db.close();
