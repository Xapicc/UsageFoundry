import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type Database from "better-sqlite3";

/**
 * Covers the export that copies both pointer holdouts' evidence out of
 * `run_events` before `sweepRunEvents` deletes it.
 *
 * It earns a test because every way of getting it wrong is silent and cannot be
 * repaired afterwards: the evidence is the thirty-day log, so a row that is
 * wrong, missing or overwritten with less is a hole in an experiment nobody
 * learns about until the analysis is run, by which time the source is gone. The
 * pure parts decide what counts as a path the prompt named and a call that
 * looked in the vault; the database half pins the property the whole design
 * rests on — an export is out before the sweep that would take it, a second pass
 * after the sweep takes nothing back, and a run it could not copy keeps its
 * events.
 *
 * Its own file for `retentionSweep.test.ts`'s reason: `config.ts` reads
 * `DATA_DIR` at module load.
 */

let exportMod: typeof import("./holdoutExport");
let retention: typeof import("./retention");
let dbMod: typeof import("./db");
let settings: typeof import("./settings");
let priorReads: typeof import("./priorReads");
let cycleInvocation: typeof import("./cycleInvocation");
let vaultPointer: typeof import("./vaultPointer");
let root: string;

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_786_470_000_000;
const REPO = "/workspace/repo";
const VAULT = "/vault";

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-holdout-export-")));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, "mount");
  process.env.WORKSPACE_ROOTS = "";
  fs.mkdirSync(path.join(root, "mount"), { recursive: true });
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );

  exportMod = await import("./holdoutExport");
  retention = await import("./retention");
  dbMod = await import("./db");
  settings = await import("./settings");
  priorReads = await import("./priorReads");
  cycleInvocation = await import("./cycleInvocation");
  vaultPointer = await import("./vaultPointer");
});

after(() => {
  const open = (globalThis as { __ufDb?: Database.Database }).__ufDb;
  open?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the prompt's two pointer blocks", () => {
  const files = [
    { path: "src/lib/a.ts", runs: 3 },
    { path: "docs/with space.md", runs: 1 },
  ];
  const pick = {
    path: "3 Resources/Note.md",
    title: "Note",
    confidence: "medium",
    tokens: 1200,
    abstract: "What it says.",
    why: "It bears on the task.",
    section: "## Part",
  };

  it("separates each block from the brief, and the brief keeps its own mention of a block path", () => {
    const prompt = [
      "Earlier orientation.",
      vaultPointer.vaultPointerNotice([pick], VAULT),
      cycleInvocation.priorReadsNotice(files),
      "    indented first line of the task, which names src/lib/a.ts and src/other.ts",
    ].join("\n\n");

    const split = exportMod.splitPromptBlocks(prompt);

    assert.deepEqual(exportMod.blockPaths(split.priorReadBlock), ["src/lib/a.ts", "docs/with space.md"]);
    assert.ok(split.vaultBlock?.includes("3 Resources/Note.md"));
    assert.ok(!split.rest.includes("3 Resources/Note.md"), "the vault block must not leak into the brief");
    assert.ok(!split.rest.includes("docs/with space.md"), "the prior-read block must not leak into the brief");
    // The task's own indented first line was not swallowed by the vault block.
    assert.ok(split.rest.includes("indented first line of the task"));
    assert.deepEqual(exportMod.promptPaths(split.rest, REPO), ["src/lib/a.ts", "src/other.ts"]);
  });

  it("finds nothing in a prompt without either block", () => {
    const split = exportMod.splitPromptBlocks("Fix the bug in src/x.ts.\n\n    code\n");
    assert.equal(split.priorReadBlock, null);
    assert.equal(split.vaultBlock, null);
    assert.deepEqual(exportMod.blockPaths(split.priorReadBlock), []);
  });
});

describe("promptPaths", () => {
  it("keeps an absolute path only inside the base, as the relative path it names", () => {
    const got = exportMod.promptPaths(
      "see /workspace/repo/src/a.ts and /etc/passwd, also ./src/b.ts, https://x.dev/y.ts, e.g. v1.2 and `README.md`.",
      REPO,
    );
    assert.deepEqual(got, ["src/a.ts", "src/b.ts", "README.md"]);
  });
});

describe("tool events", () => {
  it("reads the path from file_path, notebook_path or path, and refuses any other tool", () => {
    assert.equal(exportMod.toolEventOf({ name: "Read", input: { file_path: "/a/b" } })?.path, "/a/b");
    assert.equal(exportMod.toolEventOf({ name: "Grep", input: { pattern: "x", path: "/a" } })?.path, "/a");
    assert.equal(exportMod.toolEventOf({ name: "Glob", input: { pattern: "*.md" } })?.path, null);
    assert.equal(exportMod.toolEventOf({ name: "Bash", input: { command: "ls" } }), null);
    assert.equal(
      exportMod.toolEventOf({ name: "Read", input: { file_path: "/a" }, parentToolUseId: "toolu_1" })?.parentToolUseId,
      "toolu_1",
    );
  });

  it("calls a path inside the vault inside and its prefix-sharing sibling outside", () => {
    const call = (p: string | null, over: Partial<ReturnType<typeof exportMod.toolEventOf> & object> = {}) => ({
      name: "Read", path: p, pattern: null, glob: null, parentToolUseId: null, ...over,
    });
    assert.equal(exportMod.insideVault(call("/vault/a/b.md"), VAULT), true);
    assert.equal(exportMod.insideVault(call("/vault"), VAULT), true);
    assert.equal(exportMod.insideVault(call("/vault2/a.md"), VAULT), false, "a sibling that shares the prefix");
    assert.equal(exportMod.insideVault(call("/vault/../etc/x"), VAULT), false, "climbing out by spelling");
    assert.equal(exportMod.insideVault(call(null, { name: "Glob", pattern: "/vault/**/*.md" }), VAULT), true);
    assert.equal(exportMod.insideVault(call(null, { name: "Grep", pattern: "/vault/x" }), VAULT), false);
    assert.equal(exportMod.insideVault(call("/vault/a.md"), null), false);
  });
});

describe("the iteration record", () => {
  it("reads an event from before the lists were logged, and one after, without guessing", () => {
    const before = exportMod.iterationRecord(
      { n: 1, prompt: "x", resuming: null, priorReads: { arm: "holdout", paths: 7 } },
      REPO,
    );
    assert.equal(before.priorReads?.count, 7);
    assert.equal(before.priorReads?.files, null, "the list was never recorded: null, not empty");
    assert.equal(before.vault, null);

    const after = exportMod.iterationRecord(
      {
        n: 1, prompt: "x", resuming: null,
        priorReads: { arm: "pointer", paths: 1, files: [{ path: "a.ts", runs: 2 }], snapshotAt: 5, basis: "parent" },
        vaultPointer: { arm: "pointer", paths: [], costUsd: 0.002, candidates: ["n.md"], outcome: "none-declined", root: VAULT },
      },
      REPO,
    );
    assert.deepEqual(after.priorReads?.files, [{ path: "a.ts", runs: 2 }]);
    assert.equal(after.priorReads?.basis, "parent");
    assert.deepEqual(after.vault?.candidates, ["n.md"]);
  });

  it("tells a picked pointer from a declined, an unsplit and a failed one", () => {
    const vault = (over: object) => ({ arm: "pointer", paths: [], costUsd: 0, candidates: null, outcome: null, failure: null, root: null, ...over });
    assert.equal(exportMod.vaultOutcome(vault({ paths: ["a.md"] }), null), "picked");
    assert.equal(exportMod.vaultOutcome(vault({ outcome: "none-no-candidates" }), null), "none-no-candidates");
    assert.equal(exportMod.vaultOutcome(vault({}), null), "none-unsplit");
    assert.equal(exportMod.vaultOutcome(vault({}), "gate silent"), "failed", "an old event whose log recorded the failure");
  });
});

/* ------------------------------------------------------------------ */
/* The database half                                                   */
/* ------------------------------------------------------------------ */

function run(o: {
  id: string;
  status?: string;
  createdAt: number;
  provider?: string | null;
  originRef?: string | null;
  repo?: string | null;
  startedAt?: number | null;
  finishedAt?: number | null;
}): void {
  dbMod
    .db()
    .prepare(
      `INSERT INTO runs (id, folder, folder_repo, prompt, status, budget, created_at, started_at, finished_at,
                         provider, origin_ref, spent_usd, spent_tokens, iterations)
       VALUES (?, ?, ?, 'task', ?, '{}', ?, ?, ?, ?, ?, 1.5, 100, 2)`,
    )
    .run(
      o.id,
      o.repo ?? REPO,
      o.repo === null ? null : (o.repo ?? REPO),
      o.status ?? "completed",
      o.createdAt,
      o.startedAt === undefined ? o.createdAt : o.startedAt,
      o.finishedAt === undefined ? o.createdAt + 1000 : o.finishedAt,
      o.provider === undefined ? "claude" : o.provider,
      o.originRef ?? null,
    );
}

function event(runId: string, ts: number, kind: string, payload: unknown): void {
  dbMod
    .db()
    .prepare("INSERT INTO run_events (run_id, ts, kind, payload) VALUES (?, ?, ?, ?)")
    .run(runId, ts, kind, JSON.stringify(payload));
}

const count = (sql: string, ...args: unknown[]) =>
  (dbMod.db().prepare(sql).get(...args) as { n: number }).n;

describe("exporting before the sweep", () => {
  const T = "00000000-0000-4000-8000-00000000000a";
  const OLD = NOW - 40 * DAY;

  before(() => {
    settings.saveSettings({ eventRetentionDays: 30 });

    run({ id: "earlier-1", createdAt: OLD - 3 * DAY });
    event("earlier-1", OLD - 3 * DAY, "tool", { name: "Read", input: { file_path: `${REPO}/src/a.ts` } });
    event("earlier-1", OLD - 3 * DAY, "tool", { name: "Read", input: { file_path: `${REPO}/src/b.ts` } });
    run({ id: "earlier-2", createdAt: OLD - 2 * DAY });
    event("earlier-2", OLD - 2 * DAY, "tool", { name: "Read", input: { file_path: `${REPO}/src/a.ts` } });
    // A sub-agent's read is not the run's own and must not be ranked.
    event("earlier-2", OLD - 2 * DAY, "tool", { name: "Read", input: { file_path: `${REPO}/src/c.ts` }, parentToolUseId: "toolu_s" });

    run({ id: T, createdAt: OLD });
    const block = cycleInvocation.priorReadsNotice([{ path: "src/a.ts", runs: 2 }]);
    event(T, OLD, "iteration", {
      n: 1,
      prompt: `${block}\n\nFix src/a.ts`,
      resuming: null,
      priorReads: { arm: "pointer", paths: 1 },
      vaultPointer: { arm: "holdout", paths: ["N.md"], costUsd: 0.002, root: VAULT },
    });
    event(T, OLD + 10, "tool", { name: "Read", input: { file_path: `${REPO}/src/a.ts` } });
    event(T, OLD + 11, "tool", { name: "Grep", input: { pattern: "x", path: `${VAULT}/area` } });
    event(T, OLD + 12, "tool", { name: "Read", input: { file_path: `${VAULT}/N.md` } });
    event(T, OLD + 13, "tool", { name: "Read", input: { file_path: `${REPO}/src/z.ts` }, parentToolUseId: "toolu_s" });
    event(T, OLD + 14, "tool", { name: "Bash", input: { command: "ls" } });
    event(T, OLD + 15, "tool_error", { text: "boom" });
    event(T, OLD + 16, "subagent", { text: "hi", parentToolUseId: "toolu_s" });
    event(T, OLD + 17, "result", { subtype: "success", costUSD: 0.5, numTurns: 4, durationMs: 900 });

    // Never considered: another provider, Dreaming's writer, and no repository.
    run({ id: "codex-run", createdAt: OLD, provider: "codex" });
    run({ id: "dream-run", createdAt: OLD, originRef: "dreaming:2026-10-01" });
    run({ id: "no-repo", createdAt: OLD, repo: null });
    // …except that a vault pointer is considered with no repository at all.
    run({ id: "vault-only", createdAt: OLD, repo: null });
    event("vault-only", OLD, "iteration", {
      n: 1, prompt: "t", resuming: null, vaultPointer: { arm: "pointer", paths: [], costUsd: 0.001 },
    });
    event("vault-only", OLD, "log", { message: "No vault pointer", vaultPointer: { arm: "pointer", failure: "gate silent" } });
  });

  it("writes one row per considered run and none for a run the pointer never considers", async () => {
    const summary = await exportMod.exportHoldoutEvidence(NOW);
    assert.equal(summary.failed, 0);

    const ids = (dbMod.db().prepare("SELECT run_id FROM holdout_runs ORDER BY run_id").all() as { run_id: string }[]).map((r) => r.run_id);
    assert.deepEqual(ids, [T, "earlier-1", "earlier-2", "vault-only"].sort());
  });

  it("records the arm as logged, the ranking as recomputed, and the runs it was ranked from", () => {
    const row = dbMod.db().prepare("SELECT * FROM holdout_runs WHERE run_id = ?").get(T) as Record<string, unknown>;
    assert.equal(row.prior_read_arm, "pointer");
    assert.equal(row.prior_read_arm_source, "logged");
    assert.equal(row.prior_read_arm_by_id, priorReads.inHoldout(T) ? "holdout" : "pointer");
    assert.equal(row.vault_arm, "holdout");
    assert.equal(row.prior_read_ranking_source, "recomputed");
    assert.deepEqual(JSON.parse(row.prior_read_ranking as string), [
      { path: "src/a.ts", runs: 2 },
      { path: "src/b.ts", runs: 1 },
    ]);
    assert.equal(row.prior_read_ranking_runs, 2);
    assert.equal(row.prior_read_ranking_reads, 3);
    assert.equal(row.tool_error_count, 1);
    assert.equal(row.subagent_count, 1);
    assert.deepEqual(JSON.parse(row.results as string), [
      { ts: OLD + 17, subtype: "success", costUSD: 0.5, numTurns: 4, durationMs: 900 },
    ]);
    const preceding = JSON.parse(row.preceding_runs as string) as Array<[string, string | null]>;
    assert.deepEqual(preceding.map((p) => p[0]), ["earlier-2", "earlier-1"]);
    for (const [id, arm] of preceding) assert.equal(arm, priorReads.inHoldout(id) ? "holdout" : "pointer");
    assert.equal(row.first_event_ts, OLD);
  });

  it("records each cycle with the pointer's block apart from the brief's paths, and each tool call", () => {
    const cycle = dbMod.db().prepare("SELECT * FROM holdout_cycles WHERE run_id = ?").get(T) as Record<string, unknown>;
    assert.equal(cycle.prior_read_count, 1);
    assert.equal(cycle.prior_read_files, null, "an event from before the list was logged has none");
    assert.deepEqual(JSON.parse(cycle.prompt_block_paths as string), ["src/a.ts"]);
    assert.deepEqual(JSON.parse(cycle.prompt_brief_paths as string), ["src/a.ts"]);
    assert.equal(cycle.vault_outcome, "picked");
    assert.deepEqual(JSON.parse(cycle.vault_paths as string), ["N.md"]);

    const tools = dbMod
      .db()
      .prepare("SELECT name, path, parent_tool_use_id AS parent, in_vault AS inVault FROM holdout_tool_events WHERE run_id = ? ORDER BY event_id")
      .all(T);
    assert.deepEqual(tools, [
      { name: "Read", path: `${REPO}/src/a.ts`, parent: null, inVault: 0 },
      { name: "Grep", path: `${VAULT}/area`, parent: null, inVault: 1 },
      { name: "Read", path: `${VAULT}/N.md`, parent: null, inVault: 1 },
      { name: "Read", path: `${REPO}/src/z.ts`, parent: "toolu_s", inVault: 0 },
    ]);

    const vaultOnly = dbMod.db().prepare("SELECT vault_outcome, vault_failure FROM holdout_cycles WHERE run_id = 'vault-only'").get();
    assert.deepEqual(vaultOnly, { vault_outcome: "failed", vault_failure: "gate silent" });
  });

  it("is out before the sweep, and a second pass after the sweep takes nothing back", async () => {
    const before = count("SELECT COUNT(*) AS n FROM holdout_tool_events");
    const swept = retention.sweepRunEvents(NOW);
    assert.ok(swept.events > 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?", T), 0);

    const again = await exportMod.exportHoldoutEvidence(NOW + 1000);
    assert.equal(again.runs, 0, "a settled, exported run is final and is not visited again");
    assert.equal(count("SELECT COUNT(*) AS n FROM holdout_tool_events"), before);
    assert.equal(count("SELECT COUNT(*) AS n FROM holdout_cycles WHERE run_id = ?", T), 1);
    const row = dbMod.db().prepare("SELECT tool_error_count AS e, prior_read_ranking_source AS s FROM holdout_runs WHERE run_id = ?").get(T);
    assert.deepEqual(row, { e: 1, s: "recomputed" });
  });

  it("never lets a live run's later pass overwrite evidence with less", async () => {
    run({ id: "live", createdAt: NOW - DAY, status: "running", finishedAt: null });
    event("live", NOW - DAY, "tool_error", { text: "a" });
    event("live", NOW - DAY, "tool_error", { text: "b" });
    await exportMod.exportHoldoutEvidence(NOW);
    dbMod.db().prepare("DELETE FROM run_events WHERE run_id = 'live'").run();
    await exportMod.exportHoldoutEvidence(NOW + 1000);
    const row = dbMod.db().prepare("SELECT tool_error_count AS e, finalized_at AS f FROM holdout_runs WHERE run_id = 'live'").get();
    assert.deepEqual(row, { e: 2, f: null });
  });

  it("keeps a run's events when its export failed", async () => {
    run({ id: "unexported", createdAt: OLD });
    event("unexported", OLD, "tool", { name: "Read", input: { file_path: `${REPO}/src/a.ts` } });

    dbMod.db().exec("ALTER TABLE holdout_runs RENAME TO holdout_runs_away");
    try {
      await retention.runRetentionSweep(NOW);
    } finally {
      dbMod.db().exec("ALTER TABLE holdout_runs_away RENAME TO holdout_runs");
    }
    assert.equal(count("SELECT COUNT(*) AS n FROM run_events WHERE run_id = 'unexported'"), 1, "the only copy survived");

    await retention.runRetentionSweep(NOW);
    assert.equal(count("SELECT COUNT(*) AS n FROM run_events WHERE run_id = 'unexported'"), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM holdout_tool_events WHERE run_id = 'unexported'"), 1);
  });
});

describe("the runs live when a run started", () => {
  const OTHER = "/workspace/other";

  it("records the running neighbours on the repository, once, and nothing for a parked or foreign run", async () => {
    run({ id: "sib-a", createdAt: NOW - 3000, status: "running", repo: OTHER, finishedAt: null });
    run({ id: "sib-b", createdAt: NOW - 2000, status: "running", repo: OTHER, finishedAt: null });
    run({ id: "sib-parked", createdAt: NOW - 1000, status: "paused", repo: OTHER, finishedAt: null });
    run({ id: "sib-foreign", createdAt: NOW - 500, status: "running", finishedAt: null });

    priorReads.recordLiveSiblings("sib-a", OTHER);
    run({ id: "sib-late", createdAt: NOW, status: "running", repo: OTHER, finishedAt: null });
    priorReads.recordLiveSiblings("sib-a", OTHER);
    priorReads.recordLiveSiblings("sib-late", OTHER);

    const stored = (id: string) =>
      (dbMod.db().prepare("SELECT live_siblings AS s FROM runs WHERE id = ?").get(id) as { s: string | null }).s;
    assert.deepEqual(JSON.parse(stored("sib-a")!), ["sib-b"], "written once: the later arrival is not added");
    assert.deepEqual(JSON.parse(stored("sib-late")!), ["sib-a", "sib-b"]);
    assert.equal(stored("sib-b"), null, "a run nobody recorded for stays not-recorded, never an empty list");

    await exportMod.exportHoldoutEvidence(NOW);
    const exported = dbMod.db().prepare("SELECT live_siblings AS s FROM holdout_runs WHERE run_id = 'sib-late'").get() as { s: string };
    assert.deepEqual(JSON.parse(exported.s), ["sib-a", "sib-b"]);
  });
});
