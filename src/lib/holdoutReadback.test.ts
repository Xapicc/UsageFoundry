import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type Database from "better-sqlite3";

/**
 * Covers the holdout's readback: who is counted, what a run is said to have
 * read, which (cycle, path) pairs are scored, and what the arms' difference is.
 *
 * It earns a test because every way of getting it wrong still renders a
 * confident card. A run counted in one arm and not the other, a sub-agent's
 * read taken for the run's own, a file the task named credited to the pointer,
 * or an interval taken over pairs instead of runs each produce a plausible
 * number in the right units, and the operator decides whether to build the gate
 * hook from them (`17-implementation-sketch.md`, Phase 5). The database half
 * runs the readback over a scratch export and again after `sweepRunEvents` has
 * emptied the log, because surviving that sweep is the reason it reads the
 * export tables.
 *
 * Its own file for `holdoutExport.test.ts`'s reason: `config.ts` reads
 * `DATA_DIR` at module load.
 */

let readback: typeof import("./holdoutReadback");
let exportMod: typeof import("./holdoutExport");
let retention: typeof import("./retention");
let dbMod: typeof import("./db");
let priorReads: typeof import("./priorReads");
let cycleInvocation: typeof import("./cycleInvocation");
let root: string;

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_786_470_000_000;
const REPO = "/workspace/readback";

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-holdout-readback-")));
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

  readback = await import("./holdoutReadback");
  exportMod = await import("./holdoutExport");
  retention = await import("./retention");
  dbMod = await import("./db");
  priorReads = await import("./priorReads");
  cycleInvocation = await import("./cycleInvocation");
});

after(() => {
  const open = (globalThis as { __ufDb?: Database.Database }).__ufDb;
  open?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const considered = (over: Partial<import("./holdoutReadback").ConsideredRun> = {}) => ({
  runId: "r",
  arm: "pointer" as const,
  armSource: "logged",
  treatment: "snapshot@5",
  isContinuation: false,
  isSettled: true,
  paths: 3,
  ...over,
});

describe("who is counted", () => {
  it("reads a settled run on a fixed list that had something to show, in either arm", () => {
    const got = readback.classifyRuns([considered({ runId: "a" }), considered({ runId: "b", arm: "holdout" })]);
    assert.deepEqual(got.read.map((r) => r.runId), ["a", "b"]);
    assert.ok(got.leftOut.every((l) => l.pointer === 0 && l.holdout === 0));
  });

  it("counts a run left out once, under the first reason that applies, in its own arm", () => {
    const got = readback.classifyRuns([
      // Arm never logged, and also on the rolling list and a continuation: the
      // arm is the thing that cannot be recovered, so it is what is said.
      considered({ runId: "1", armSource: "derived", treatment: "rolling", isContinuation: true }),
      // Rolling and a continuation.
      considered({ runId: "2", arm: "holdout", treatment: "rolling", isContinuation: true }),
      // A treatment the build does not know is not a fixed list either.
      considered({ runId: "3", treatment: null }),
      // A continuation that is also still running.
      considered({ runId: "4", isContinuation: true, isSettled: false }),
      // Running with nothing to show.
      considered({ runId: "5", isSettled: false, paths: 0 }),
      // Settled, on a list that was still pending.
      considered({ runId: "6", arm: "holdout", treatment: "snapshot-pending", paths: 0 }),
    ]);
    assert.deepEqual(got.read, []);
    const counts = Object.fromEntries(got.leftOut.map((l) => [l.reason, [l.pointer, l.holdout]]));
    assert.deepEqual(counts, {
      "arm-derived": [1, 0],
      "earlier-list": [1, 1],
      continuation: [1, 0],
      unsettled: [1, 0],
      "nothing-to-show": [0, 1],
    });
  });
});

describe("what a run read", () => {
  const call = (name: string, p: string | null, over: Partial<import("./holdoutReadback").ToolCall> = {}) => ({
    name,
    path: p,
    isMainThread: true,
    inVault: false,
    ...over,
  });

  it("counts distinct main-thread files read before the first edit and in all", () => {
    const got = readback.readingOf([
      call("Read", "/r/a.ts"),
      call("Read", "/r/a.ts"),
      call("Read", "/r/b.ts"),
      call("Edit", "/r/a.ts"),
      call("Read", "/r/c.ts"),
      call("Read", "/r/b.ts"),
    ]);
    assert.deepEqual(got, { beforeEdit: 2, wholeRun: 3, edited: true });
  });

  it("does not count a sub-agent's read, a sub-agent's edit, a vault call, or a search", () => {
    const got = readback.readingOf([
      call("Read", "/r/sub.ts", { isMainThread: false }),
      call("Write", "/r/sub.ts", { isMainThread: false }),
      call("Read", "/vault/n.md", { inVault: true }),
      call("Edit", "/vault/n.md", { inVault: true }),
      call("Grep", "/r/src"),
      call("Glob", null),
      call("Read", "/r/a.ts"),
    ]);
    // The sub-agent's write did not end the main thread's orientation, and the
    // vault edit was not an edit of the repository.
    assert.deepEqual(got, { beforeEdit: 1, wholeRun: 1, edited: false });
  });

  it("says a run that never edited read everything before its first edit, and that it never edited", () => {
    assert.deepEqual(readback.readingOf([call("Read", "/r/a.ts"), call("Read", "/r/b.ts")]), {
      beforeEdit: 2,
      wholeRun: 2,
      edited: false,
    });
    assert.deepEqual(readback.readingOf([]), { beforeEdit: 0, wholeRun: 0, edited: false });
  });
});

describe("compliance", () => {
  const cycle = (over: Partial<import("./holdoutReadback").ComplianceCycle> = {}) => ({
    runId: "r1",
    arm: "pointer" as const,
    ts: 100,
    listed: ["a.ts", "b.ts"],
    briefNamed: [],
    ...over,
  });
  const opens = (entries: Record<string, Record<string, number>>) =>
    new Map(Object.entries(entries).map(([run, files]) => [run, new Map(Object.entries(files))]));

  it("scores a path opened at or after the cycle began, and not one opened before it", () => {
    const got = readback.complianceOf([cycle()], opens({ r1: { "a.ts": 100, "b.ts": 99 } }));
    assert.equal(got.pointer.pairs, 2);
    assert.equal(got.pointer.opened, 1, "a.ts at the cycle's own instant is opened; b.ts a tick earlier is not");
  });

  it("scores each arm by the same rule and keeps them apart", () => {
    const got = readback.complianceOf(
      [cycle(), cycle({ runId: "r2", arm: "holdout" })],
      opens({ r1: { "a.ts": 150, "b.ts": 150 }, r2: { "a.ts": 150 } }),
    );
    assert.deepEqual([got.pointer.pairs, got.pointer.opened], [2, 2]);
    assert.deepEqual([got.holdout.pairs, got.holdout.opened], [2, 1]);
  });

  it("sets aside a path the task also named, in both arms, and does not call that run a run", () => {
    const got = readback.complianceOf(
      [
        cycle({ listed: ["a.ts", "b.ts"], briefNamed: ["a.ts"] }),
        cycle({ runId: "r2", arm: "holdout", listed: ["a.ts"], briefNamed: ["a.ts"] }),
      ],
      opens({ r1: { "a.ts": 150, "b.ts": 150 }, r2: { "a.ts": 150 } }),
    );
    assert.deepEqual([got.pointer.pairs, got.pointer.briefNamedPairs], [1, 1]);
    assert.deepEqual([got.holdout.pairs, got.holdout.briefNamedPairs, got.holdout.runs, got.holdout.cycles], [0, 1, 0, 0]);
  });

  it("scores a path once per cycle however often the list repeats it, and a run's cycles as one cluster", () => {
    const got = readback.complianceOf(
      [cycle({ listed: ["a.ts", "a.ts"] }), cycle({ ts: 200, listed: ["a.ts", "b.ts"] })],
      opens({ r1: { "a.ts": 250 } }),
    );
    assert.equal(got.pointer.pairs, 3);
    assert.equal(got.pointer.opened, 2);
    assert.equal(got.pointer.runs, 1);
    assert.deepEqual(got.pointer.clusters, [{ numerator: 2, denominator: 3 }]);
  });

  it("counts a cycle whose list was not logged and scores nothing for it", () => {
    const got = readback.complianceOf([cycle({ arm: "holdout", listed: null })], opens({}));
    assert.deepEqual([got.holdout.unlistedCycles, got.holdout.pairs, got.holdout.runs], [1, 0, 0]);
  });

  it("takes the list from the export's columns: the record in both arms, the block only for the pointer", () => {
    const files = JSON.stringify([{ path: "a.ts", runs: 3 }, { path: "b.ts", runs: 1 }, { nope: 1 }]);
    const block = JSON.stringify(["x.ts"]);
    assert.deepEqual(readback.listedPaths("pointer", files, block), ["a.ts", "b.ts"]);
    assert.deepEqual(readback.listedPaths("holdout", files, block), ["a.ts", "b.ts"]);
    assert.deepEqual(readback.listedPaths("pointer", null, block), ["x.ts"]);
    assert.equal(readback.listedPaths("holdout", null, block), null, "a held-out list is never rebuilt from the block");
    assert.equal(readback.listedPaths("pointer", "{not json", null), null);
    assert.deepEqual(readback.listedPaths("holdout", "[]", null), [], "an empty record is a recorded none");
  });
});

describe("the arithmetic", () => {
  const near = (actual: number | null, expected: number, digits = 6) => {
    assert.ok(actual !== null && Math.abs(actual - expected) < 10 ** -digits, `${actual} is not ${expected}`);
  };

  it("takes the share's error over runs, not pairs", () => {
    // Three runs: 1/2, 3/4, 0/2 -> p = 4/8. Residuals 0, 1, -1 -> sum of squares 2,
    // so se = sqrt(3/2 * 2) / 8.
    const got = readback.clusteredShare([
      { numerator: 1, denominator: 2 },
      { numerator: 3, denominator: 4 },
      { numerator: 0, denominator: 2 },
    ]);
    near(got.value, 0.5);
    near(got.se, Math.sqrt(3) / 8);
  });

  it("gives no error from one run and no share from none", () => {
    assert.deepEqual(readback.clusteredShare([{ numerator: 1, denominator: 2 }]), { value: 0.5, se: null });
    assert.deepEqual(readback.clusteredShare([]), { value: null, se: null });
    assert.deepEqual(readback.clusteredShare([{ numerator: 0, denominator: 0 }]), { value: null, se: null });
  });

  it("differences two arms' means with Welch's error, pointer minus held out", () => {
    const got = readback.contrastOf([1, 2, 3], [2, 4, 6]);
    near(got.pointer.mean, 2);
    near(got.pointer.sd, 1);
    near(got.holdout.mean, 4);
    near(got.holdout.sd, 2);
    near(got.difference, -2);
    const se = Math.sqrt(1 / 3 + 4 / 3);
    near(got.low, -2 - 1.96 * se);
    near(got.high, -2 + 1.96 * se);
  });

  it("gives no difference until each arm has two runs", () => {
    const got = readback.contrastOf([5], [1, 2, 3]);
    assert.deepEqual([got.difference, got.low, got.high], [null, null, null]);
    assert.equal(got.pointer.n, 1);
    assert.equal(got.pointer.mean, 5, "the mean is still shown");
    assert.equal(readback.contrastOf([], []).pointer.mean, null);
  });

  it("differences two shares by their errors, and by nothing when either has none", () => {
    const arm = (clusters: Array<[number, number]>): import("./holdoutReadback").ComplianceTally => ({
      runs: clusters.length,
      cycles: clusters.length,
      pairs: clusters.reduce((sum, [, denominator]) => sum + denominator, 0),
      opened: clusters.reduce((sum, [numerator]) => sum + numerator, 0),
      briefNamedPairs: 0,
      unlistedCycles: 0,
      clusters: clusters.map(([numerator, denominator]) => ({ numerator, denominator })),
    });
    const a = arm([[1, 2], [3, 4], [0, 2]]);
    const b = arm([[2, 2], [1, 2]]);
    const got = readback.complianceDifference(a, b);
    near(got.difference, 0.5 - 0.75);
    assert.ok(got.low! < got.difference! && got.difference! < got.high!);
    assert.deepEqual(readback.complianceDifference(a, arm([[1, 2]])), { difference: null, low: null, high: null });
  });

  it("calls a sample size reached by the smaller arm, at the boundary", () => {
    const targets = [{ effect: "x", perArm: 10, unit: "runs" as const }, { effect: "y", perArm: 20, unit: "runs" as const }];
    assert.deepEqual(
      readback.reachedTargets(targets, { pointer: 50, holdout: 10 }).map((t) => t.reached),
      [true, false],
    );
    assert.deepEqual(
      readback.reachedTargets(targets, { pointer: 50, holdout: 9 }).map((t) => t.reached),
      [false, false],
    );
  });
});

/* ------------------------------------------------------------------ */
/* The database half                                                   */
/* ------------------------------------------------------------------ */

function run(o: {
  id: string;
  createdAt: number;
  status?: string;
  iterations?: number;
  spent?: number;
  ending?: string | null;
  continuesRun?: string | null;
  finished?: boolean;
}): void {
  dbMod
    .db()
    .prepare(
      `INSERT INTO runs (id, folder, folder_repo, prompt, status, budget, created_at, started_at, finished_at,
                         provider, spent_usd, spent_tokens, iterations, ending_code, continues_run)
       VALUES (?, ?, ?, 'task', ?, '{}', ?, ?, ?, 'claude', ?, 100, ?, ?, ?)`,
    )
    .run(
      o.id,
      REPO,
      REPO,
      o.status ?? "completed",
      o.createdAt,
      o.createdAt,
      o.finished === false ? null : o.createdAt + 1000,
      o.spent ?? 1,
      o.iterations ?? 1,
      o.ending ?? null,
      o.continuesRun ?? null,
    );
}

function event(runId: string, ts: number, kind: string, payload: unknown): void {
  dbMod
    .db()
    .prepare("INSERT INTO run_events (run_id, ts, kind, payload) VALUES (?, ?, ?, ?)")
    .run(runId, ts, kind, JSON.stringify(payload));
}

const read = (runId: string, ts: number, file: string, over: object = {}) =>
  event(runId, ts, "tool", { name: "Read", input: { file_path: `${REPO}/${file}` }, ...over });

/** The cycle's first event: the list it carried (or withheld), and the brief. */
function cycle(runId: string, ts: number, arm: "pointer" | "holdout", files: string[], extra: object = {}) {
  const listed = files.map((p) => ({ path: p, runs: 2 }));
  const block = arm === "pointer" && files.length > 0 ? `${cycleInvocation.priorReadsNotice(listed)}\n\n` : "";
  event(runId, ts, "iteration", {
    n: 1,
    resuming: null,
    prompt: `${block}Update docs/x.md`,
    priorReads: { arm, paths: files.length, files: listed, basis: "id", treatment: "snapshot@5", ...extra },
  });
}

describe("the readback over a scratch export, before and after the log is swept", () => {
  const T0 = NOW - 60 * DAY;
  const LIST = ["src/a.ts", "src/b.ts", "docs/x.md"];

  before(() => {
    // Pointer. Reads a, c, edits a, reads d afterwards; a sub-agent reads b. The
    // brief names docs/x.md, which is on the list and so is set aside.
    run({ id: "p1", createdAt: T0, iterations: 2, spent: 3, ending: "done" });
    cycle("p1", T0 + 1, "pointer", LIST);
    read("p1", T0 + 10, "src/a.ts");
    read("p1", T0 + 11, "src/c.ts");
    event("p1", T0 + 12, "tool", { name: "Edit", input: { file_path: `${REPO}/src/a.ts` } });
    read("p1", T0 + 13, "src/d.ts");
    read("p1", T0 + 14, "src/b.ts", { parentToolUseId: "toolu_sub" });
    // Pointer. Opens none of the list and never edits.
    run({ id: "p2", createdAt: T0 + 1000, iterations: 1, spent: 1, ending: "cycle_cap" });
    cycle("p2", T0 + 1001, "pointer", LIST);
    read("p2", T0 + 1010, "src/z.ts");

    // Held out. Opens a, reads two others, edits one of them.
    run({ id: "h1", createdAt: T0 + 2000, iterations: 2, spent: 2, ending: "done" });
    cycle("h1", T0 + 2001, "holdout", LIST);
    read("h1", T0 + 2010, "src/a.ts");
    read("h1", T0 + 2011, "src/q.ts");
    read("h1", T0 + 2012, "src/r.ts");
    event("h1", T0 + 2013, "tool", { name: "Edit", input: { file_path: `${REPO}/src/q.ts` } });
    // Held out. Opens nothing on the list, reads two files, never edits, no ending recorded.
    run({ id: "h2", createdAt: T0 + 3000, iterations: 1, spent: 0.5 });
    cycle("h2", T0 + 3001, "holdout", LIST);
    read("h2", T0 + 3010, "src/m.ts");
    read("h2", T0 + 3011, "src/n.ts");

    // Left out, one for each reason the card names.
    run({ id: "cont", createdAt: T0 + 4000, continuesRun: "p1" });
    cycle("cont", T0 + 4001, "pointer", LIST, { basis: "parent" });
    run({ id: "live", createdAt: T0 + 5000, status: "running", finished: false });
    cycle("live", T0 + 5001, "pointer", LIST);
    run({ id: "empty", createdAt: T0 + 6000 });
    cycle("empty", T0 + 6001, "pointer", [], { treatment: "snapshot-pending" });
    run({ id: "rolling", createdAt: T0 + 7000 });
    event("rolling", T0 + 7001, "iteration", { n: 1, prompt: "Update docs/x.md", priorReads: { arm: "holdout", paths: 5 } });
    // No iteration event at all: the arm is recomputed from the id.
    run({ id: "silent", createdAt: T0 + 8000 });
  });

  const strip = (r: import("./apiTypes").HoldoutReadbackDTO) => ({ ...r, queryMs: 0 });

  it("reads the three questions separately, per arm, over only the runs with a list", async () => {
    await exportMod.exportHoldoutEvidence(NOW);
    const got = readback.holdoutReadback(NOW);

    assert.deepEqual(got.population.read, { pointer: 2, holdout: 2 });
    const silentArm = priorReads.holdoutArmFor("silent", null).arm;
    const leftOut = Object.fromEntries(got.population.leftOut.map((l) => [l.reason, [l.pointer, l.holdout]]));
    assert.deepEqual(leftOut, {
      "arm-derived": silentArm === "pointer" ? [1, 0] : [0, 1],
      "earlier-list": [0, 1],
      continuation: [1, 0],
      unsettled: [1, 0],
      "nothing-to-show": [1, 0],
    });

    // Compliance: pointer opened a and (by a sub-agent) b of 2 pairs, then none
    // of 2; held out opened a of 2, then none of 2. docs/x.md is the brief's.
    assert.deepEqual(got.compliance.pointer, { runs: 2, cycles: 2, pairs: 4, opened: 2, share: 0.5 });
    assert.deepEqual(got.compliance.holdout, { runs: 2, cycles: 2, pairs: 4, opened: 1, share: 0.25 });
    assert.deepEqual(got.compliance.briefNamedPairs, { pointer: 2, holdout: 2 });
    assert.deepEqual(got.compliance.unlistedCycles, { pointer: 0, holdout: 0 });
    assert.ok(Math.abs(got.compliance.difference! - 0.25) < 1e-9);
    assert.ok(got.compliance.targets.every((t) => !t.reached));

    // Displacement: the sub-agent's read of b is not the pointer run's own.
    assert.deepEqual([got.displacement.beforeEdit.pointer.mean, got.displacement.beforeEdit.holdout.mean], [1.5, 2.5]);
    assert.deepEqual([got.displacement.wholeRun.pointer.mean, got.displacement.wholeRun.holdout.mean], [2, 2.5]);
    assert.ok(Math.abs(got.displacement.beforeEdit.difference! + 1) < 1e-9);
    assert.deepEqual(got.displacement.neverEdited, { pointer: 1, holdout: 1 });

    // Outcome, with the one spend source and the endings the runs recorded.
    assert.deepEqual([got.outcome.secondCycle.pointer.mean, got.outcome.secondCycle.holdout.mean], [0.5, 0.5]);
    assert.deepEqual([got.outcome.spend.pointer.mean, got.outcome.spend.holdout.mean], [2, 1.25]);
    assert.deepEqual(got.outcome.endings, [
      { code: "done", pointer: 1, holdout: 1 },
      { code: "cycle_cap", pointer: 1, holdout: 0 },
      { code: null, pointer: 0, holdout: 1 },
    ]);
  });

  it("answers the same after the sweep has emptied the log", () => {
    const before = readback.holdoutReadback(NOW);
    retention.sweepRunEvents(NOW);
    const swept = dbMod.db().prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id IN ('p1','p2','h1','h2')").get() as { n: number };
    assert.equal(swept.n, 0, "the fixture's events must be gone for this to test anything");
    assert.deepEqual(strip(readback.holdoutReadback(NOW)), strip(before));
    assert.equal(before.population.read.pointer + before.population.read.holdout, 4);
  });
});
