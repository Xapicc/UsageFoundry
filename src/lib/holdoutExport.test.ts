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
  it("calls a path inside the vault inside and its prefix-sharing sibling outside", () => {
    const call = (p: string | null, over: Partial<import("./holdoutExport").ToolEvent> = {}) => ({
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
        priorReads: { arm: "pointer", paths: 1, files: [{ path: "a.ts", runs: 2 }], treatment: "snapshot@5", basis: "parent" },
        vaultPointer: { arm: "pointer", paths: [], costUsd: 0.002, candidates: ["n.md"], outcome: "none-declined", root: VAULT },
      },
      REPO,
    );
    assert.deepEqual(after.priorReads?.files, [{ path: "a.ts", runs: 2 }]);
    assert.equal(after.priorReads?.basis, "parent");
    assert.equal(after.priorReads?.treatment, "snapshot@5");
    assert.equal(exportMod.snapshotAtOf("snapshot@5"), 5);
    assert.equal(exportMod.snapshotAtOf("snapshot-pending"), null);
    assert.equal(exportMod.snapshotAtOf(null), null);
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

describe("a continuation's arm", () => {
  /** An id whose own draw is the given arm, so that inheriting it is visible. */
  const idDealt = (heldOut: boolean, tag: string) => {
    for (let i = 0; ; i++) {
      const id = `${tag}-${i}`;
      if (priorReads.inHoldout(id) === heldOut) return id;
    }
  };
  const link = (id: string, continuesRun: string | null) => {
    run({ id, createdAt: NOW, repo: "/workspace/chain" });
    dbMod.db().prepare("UPDATE runs SET continues_run = ? WHERE id = ?").run(continuesRun, id);
  };
  const log = (id: string, arm: string) =>
    event(id, NOW, "iteration", { n: 1, prompt: "", resuming: null, priorReads: { arm, paths: 0 } });

  it("is its own draw when it continues nothing", () => {
    const solo = idDealt(true, "solo");
    assert.deepEqual(priorReads.holdoutArmFor(solo, null), { arm: "holdout", basis: "id" });
  });

  it("is the arm its parent was dealt, not the one its own id would give", () => {
    const parent = idDealt(true, "parent");
    const child = idDealt(false, "child");
    link(parent, null);
    log(parent, "holdout");
    assert.equal(priorReads.inHoldout(child), false);
    assert.deepEqual(priorReads.holdoutArmFor(child, parent), { arm: "holdout", basis: "parent" });
  });

  it("inherits a parent's logged arm even when that parent was dealt by its own id before the rule existed", () => {
    // Head hashes to held out; its continuation was dealt `pointer` by its own
    // id under the old rule. A grandchild must follow the continuation it
    // continues, not skip to the head and re-deal the middle of the chain.
    const head = idDealt(true, "head");
    const middle = idDealt(false, "middle");
    link(head, null);
    link(middle, head);
    log(middle, "pointer");
    assert.deepEqual(priorReads.holdoutArmFor("grandchild", middle), { arm: "pointer", basis: "parent" });
  });

  it("falls back to the head of an unrecorded chain, and stops on a cycle", () => {
    const head = idDealt(true, "unrecorded-head");
    const middle = idDealt(false, "unrecorded-middle");
    link(head, null);
    link(middle, head);
    assert.deepEqual(priorReads.holdoutArmFor("tail", middle), { arm: "holdout", basis: "parent" });

    link("loop-a", "loop-b");
    link("loop-b", "loop-a");
    const got = priorReads.holdoutArmFor("loop-c", "loop-a");
    assert.equal(got.basis, "parent");
  });
});

describe("a repository's fixed list", () => {
  let SHIPPED: number;
  let repo: string;

  const reads = (runId: string, ts: number, ...files: string[]) => {
    for (const f of files) event(runId, ts, "tool", { name: "Read", input: { file_path: `${repo}/${f}` } });
  };
  const considered = (over: Partial<Parameters<typeof priorReads.priorReadsFor>[0]> = {}) =>
    priorReads.priorReadsFor({
      runId: "asking-run", createdAt: SHIPPED + 5 * DAY, repository: repo, root: repo, provider: "claude",
      originRef: null, continuesRun: null, now: SHIPPED + 10 * DAY, ...over,
    });

  before(() => {
    SHIPPED = priorReads.PRIOR_READS_SHIPPED_AT;
    repo = path.join(root, "snap-repo");
    fs.mkdirSync(repo, { recursive: true });
    for (const f of ["a.ts", "b.ts", "held.ts", "later.ts", "treated-only.ts"]) fs.writeFileSync(path.join(repo, f), "x");

    for (let i = 0; i < 6; i++) {
      run({ id: `snap-pre-${i}`, createdAt: SHIPPED - (i + 1) * DAY, repo });
      reads(`snap-pre-${i}`, SHIPPED - (i + 1) * DAY, "a.ts", ...(i < 3 ? ["b.ts"] : []));
    }
    run({ id: "snap-treated", createdAt: SHIPPED + DAY, repo });
    event("snap-treated", SHIPPED + DAY, "iteration", { n: 1, prompt: "", resuming: null, priorReads: { arm: "pointer", paths: 1 } });
    reads("snap-treated", SHIPPED + DAY, "treated-only.ts", "treated-only.ts");
    run({ id: "snap-held", createdAt: SHIPPED + 2 * DAY, repo });
    event("snap-held", SHIPPED + 2 * DAY, "iteration", { n: 1, prompt: "", resuming: null, priorReads: { arm: "holdout", paths: 1 } });
    reads("snap-held", SHIPPED + 2 * DAY, "held.ts");
  });

  it("is ranked from reads no pointer reached, and from nothing a treated run read", () => {
    const got = considered();
    assert.equal(got?.treatment, `snapshot@${SHIPPED + 10 * DAY}`);
    assert.deepEqual(
      got?.paths.map((p) => p.path),
      ["a.ts", "b.ts", "held.ts"],
    );
    assert.equal(got?.paths[0].runs, 6, "a.ts was read by the six untreated runs");
  });

  it("is the same object for every later run, whatever has been read since", () => {
    run({ id: "snap-later", createdAt: SHIPPED + 6 * DAY, repo });
    reads("snap-later", SHIPPED + 6 * DAY, "later.ts", "later.ts", "later.ts");
    const again = considered({ runId: "another-run", now: SHIPPED + 30 * DAY });
    assert.equal(again?.treatment, `snapshot@${SHIPPED + 10 * DAY}`, "still the first snapshot");
    assert.ok(!again?.paths.some((p) => p.path === "later.ts"));
    assert.equal(count("SELECT COUNT(*) AS n FROM prior_read_snapshots WHERE repository = ?", repo), 1);
  });

  it("is the same list in both arms, with a vanished file costing only its own place", () => {
    fs.rmSync(path.join(repo, "b.ts"));
    const shown = considered({ runId: "pointer-run" });
    const held = considered({ runId: "held-run" });
    assert.deepEqual(shown?.paths.map((p) => p.path), ["a.ts", "held.ts"]);
    assert.deepEqual(held?.paths, shown?.paths);
  });

  it("shows nothing, and writes nothing, for a repository with too little history to fix a list", () => {
    const thin = path.join(root, "thin-repo");
    fs.mkdirSync(thin, { recursive: true });
    run({ id: "thin-1", createdAt: SHIPPED - DAY, repo: thin });
    event("thin-1", SHIPPED - DAY, "tool", { name: "Read", input: { file_path: `${thin}/a.ts` } });
    const got = considered({ repository: thin, root: thin });
    assert.deepEqual(got, { arm: got?.arm, basis: "id", treatment: "snapshot-pending", paths: [] });
    assert.equal(count("SELECT COUNT(*) AS n FROM prior_read_snapshots WHERE repository = ?", thin), 0);
  });
});

describe("the compliance join, before and after the sweep", () => {
  const COMPLIANCE_REPO = "/workspace/compliance";
  const C0 = NOW - 60 * DAY;

  // `03-experiment-holdout.md`'s query, read from `run_events` as it is while
  // the events exist, grouped by the arm each cycle logged and limited to the
  // fixture's repository. Left in the shape the proposal has it.
  const FROM_EVENTS = `
    WITH opens AS (
      SELECT e.run_id, e.ts,
             COALESCE(NULLIF(r.folder_repo,''), '(no repo)') AS repo,
             REPLACE(json_extract(e.payload,'$.input.file_path'),
                     COALESCE(NULLIF(r.worktree_path,''),NULLIF(r.work_dir,''),r.folder)||'/','') AS rel
      FROM run_events e JOIN runs r ON r.id=e.run_id
      WHERE e.kind='tool' AND json_extract(e.payload,'$.input.file_path') IS NOT NULL),
    vocab AS (SELECT DISTINCT repo, rel FROM opens WHERE rel LIKE '%/%'),
    cycles AS (
      SELECT e.run_id, e.ts, json_extract(e.payload,'$.n') AS n,
             json_extract(e.payload,'$.prompt') AS prompt,
             json_extract(e.payload,'$.priorReads.arm') AS arm,
             COALESCE(NULLIF(r.folder_repo,''),'(no repo)') AS repo
      FROM run_events e JOIN runs r ON r.id=e.run_id WHERE e.kind='iteration'),
    named AS (
      SELECT c.run_id, c.n, c.ts, c.arm, v.rel,
             CASE WHEN EXISTS (SELECT 1 FROM opens o
                    WHERE o.run_id=c.run_id AND o.rel=v.rel AND o.ts>=c.ts)
                  THEN 1 ELSE 0 END AS hit
      FROM cycles c JOIN vocab v ON v.repo=c.repo AND INSTR(c.prompt, v.rel) > 0
      WHERE c.repo = ?)
    SELECT arm, COUNT(*) AS pairs, COUNT(DISTINCT run_id||'/'||n) AS cycles, SUM(hit) AS opened
    FROM named GROUP BY arm ORDER BY arm`;

  // The same question over the export, which holds the paths a prompt named
  // rather than the prompt.
  const FROM_EXPORT = `
    WITH opens AS (
      SELECT t.run_id, t.ts, h.repository AS repo,
             REPLACE(t.path, COALESCE(NULLIF(r.worktree_path,''),NULLIF(r.work_dir,''),r.folder)||'/','') AS rel
      FROM holdout_tool_events t
      JOIN holdout_runs h ON h.run_id=t.run_id JOIN runs r ON r.id=t.run_id
      WHERE t.path IS NOT NULL AND t.path LIKE '/%'),
    vocab AS (SELECT DISTINCT repo, rel FROM opens WHERE rel LIKE '%/%'),
    named AS (
      SELECT c.run_id, c.n, c.ts, c.prior_read_arm AS arm, v.rel,
             CASE WHEN EXISTS (SELECT 1 FROM opens o
                    WHERE o.run_id=c.run_id AND o.rel=v.rel AND o.ts>=c.ts)
                  THEN 1 ELSE 0 END AS hit
      FROM holdout_cycles c JOIN holdout_runs h ON h.run_id=c.run_id
      JOIN vocab v ON v.repo=h.repository
      WHERE h.repository = ?
        AND (v.rel IN (SELECT value FROM json_each(c.prompt_block_paths))
          OR v.rel IN (SELECT value FROM json_each(c.prompt_brief_paths))))
    SELECT arm, COUNT(*) AS pairs, COUNT(DISTINCT run_id||'/'||n) AS cycles, SUM(hit) AS opened
    FROM named GROUP BY arm ORDER BY arm`;

  before(() => {
    const block = cycleInvocation.priorReadsNotice([
      { path: "src/a.ts", runs: 4 },
      { path: "src/b.ts", runs: 2 },
    ]);
    // Treated: the block names a and b, the brief names docs/x.md. It reads a
    // after the cycle opens and docs/x.md only before it.
    run({ id: "comp-pointer", createdAt: C0, repo: COMPLIANCE_REPO });
    event("comp-pointer", C0 + 1, "tool", { name: "Read", input: { file_path: `${COMPLIANCE_REPO}/docs/x.md` } });
    event("comp-pointer", C0 + 5, "iteration", {
      n: 1, resuming: null, prompt: `${block}\n\nUpdate docs/x.md`, priorReads: { arm: "pointer", paths: 2 },
    });
    event("comp-pointer", C0 + 9, "tool", { name: "Read", input: { file_path: `${COMPLIANCE_REPO}/src/a.ts` } });
    // Held out: the brief names src/a.ts and the run reads it, and a MultiEdit
    // of src/b.ts counts as opening it, which is why the export keeps calls
    // that carry a file_path whatever tool made them.
    run({ id: "comp-holdout", createdAt: C0 + 2, repo: COMPLIANCE_REPO });
    event("comp-holdout", C0 + 6, "iteration", {
      n: 1, resuming: null, prompt: "Fix src/a.ts and src/b.ts", priorReads: { arm: "holdout", paths: 2 },
    });
    event("comp-holdout", C0 + 8, "tool", { name: "Read", input: { file_path: `${COMPLIANCE_REPO}/src/a.ts` } });
    event("comp-holdout", C0 + 9, "tool", { name: "MultiEdit", input: { file_path: `${COMPLIANCE_REPO}/src/b.ts` } });
  });

  it("scores both arms the same from the export as from the log, and keeps doing so after the log is swept", async () => {
    const before = dbMod.db().prepare(FROM_EVENTS).all(COMPLIANCE_REPO);
    assert.deepEqual(before, [
      { arm: "holdout", pairs: 2, cycles: 1, opened: 2 },
      { arm: "pointer", pairs: 3, cycles: 1, opened: 1 },
    ]);

    await exportMod.exportHoldoutEvidence(NOW);
    assert.deepEqual(dbMod.db().prepare(FROM_EXPORT).all(COMPLIANCE_REPO), before);

    retention.sweepRunEvents(NOW);
    assert.equal(count("SELECT COUNT(*) AS n FROM run_events WHERE run_id LIKE 'comp-%'"), 0);
    assert.deepEqual(dbMod.db().prepare(FROM_EXPORT).all(COMPLIANCE_REPO), before);
  });
});
