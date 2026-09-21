import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { passMemberId } from "./passIds";

/**
 * Who may land a branch a live workflow pass owns.
 *
 * The rule has two halves and they used to be one. While a pass of a loop is
 * live its branches belong to that pass, so a person's Land, Delete, Purge and
 * Resolve are refused — that half is right and is asserted here unchanged. But
 * the pass lands its own work *through the same doors*: the section it repeats
 * ends in a merge block, that block queues the pass's branches, and the queue
 * asks `landState`, `landRun` and `resolveConflicts` exactly as a button does.
 * The refusal could not see who was asking, so it fired against the one
 * mechanism it exists to protect.
 *
 * Measured on a real install: a loop named “Loop until Tasks <10” produced ten
 * branches on its first pass, its merge block was refused on all ten with
 * “Pass 1 … is still running on this branch and lands it at its own merge
 * block … Stop that run of the workflow first”, and the loop then stopped,
 * correctly, on the rule that a pass which did not land everything stops the
 * loop. The operator was told to stop the workflow so that the branch could be
 * landed by the merge block of the workflow they had just been told to stop.
 *
 * Nothing about that was visible any other way. The instance page reported a
 * merge that had failed, which is a real outcome with a plausible sentence;
 * every unit test of `planItem` and `landRefusal` passed, because the answer
 * they check is correct for the asker they were written for; and
 * `loopSection.test.ts` — the one file that drives a pass end to end — settles
 * its members onto branches that sit at their own base, so `branchVerdict`
 * skips them and no pass in it has ever reached the merge queue. **This file's
 * branches carry a commit**, which is the whole of what makes the defect
 * reachable.
 *
 * So the first describe drives a pass for real, through `advanceInstances`,
 * into the queue, into the operator's own checkout, and asserts the commit
 * arrived. The rest pin the boundary: four doors that still refuse a person,
 * and an exemption that is the owning pass alone — not a different loop, and
 * not a later pass of the same one.
 *
 * Its own file, with `DATA_DIR` named before the first import, for
 * `loopSection.test.ts`'s reason: `config.ts` is read at module load, so a file
 * that imported the orchestrator at the top would already be bound to the
 * repository's own `.data`, which on a developer's machine is the real one.
 */

let workflows: typeof import("./workflows");
let land: typeof import("./land");
let dbMod: typeof import("./db");
let root: string;
let mountId: string;

/** The workspace directory's basename, which is also the mount's id. */
const MOUNT_DIR = "ownership-mount";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });

/** The repository every member of every fixture works in, and lands into. */
const repoRoot = () => path.join(root, MOUNT_DIR, "repo");

/**
 * Somewhere for the parked run to sit that is **not** the repository.
 *
 * `loopSection.test.ts` parks its holding run in the repository itself, which
 * costs it nothing because nothing there lands. Here it would: `landRun`
 * refuses to merge into a folder an active run is working in, and that refusal
 * is about the right thing for the wrong reason — the fixture's own scaffolding
 * rather than the rule under test.
 */
const holdFolder = () => path.join(root, MOUNT_DIR, "hold");

before(async () => {
  // `realpathSync`, which `resolveInMount` checks containment against — a mount
  // registered at an unresolved path refuses its own checkout, and on macOS
  // `os.tmpdir()` is a symlink.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-loop-own-")));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, MOUNT_DIR);
  // Cleared, not overridden: `WORKSPACE_ROOTS` wins whenever it is set, so an
  // operator's own mounts inherited from the shell would be the ones these runs
  // were created against.
  process.env.WORKSPACE_ROOTS = "";
  // Nothing here should reach a spawn — the one resolution these tests ask for
  // is one they expect to be refused before the child. A `claude` that does not
  // exist makes a regression that gets that far a failed test rather than a
  // billed one.
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  fs.mkdirSync(holdFolder(), { recursive: true });
  fs.mkdirSync(repoRoot(), { recursive: true });
  git(repoRoot(), "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repoRoot(), "a.txt"), "one\n");
  git(repoRoot(), "add", "-A");
  git(repoRoot(), "commit", "-q", "-m", "first");

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );
  mountId = config.WORKSPACE_MOUNTS[0].id;
  assert.equal(mountId, MOUNT_DIR, "the temp workspace is the only mount");

  dbMod = await import("./db");
  land = await import("./land");
  workflows = await import("./workflows");

  // One run at a time, so a member the loop creates is held at `queued` behind
  // the run each fixture parks. A released member would build a checkout and
  // spawn an agent against a `CLAUDE_BIN` that does not exist, and fail
  // asynchronously over the status this file just set.
  const settings = await import("./settings");
  settings.saveSettings({ maxConcurrentRuns: 1 });
});

after(() => {
  const open = (globalThis as { __ufDb?: { close(): void } }).__ufDb;
  open?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  for (const table of [
    "merge_queue",
    "workflow_instance_blocks",
    "workflow_instance_runs",
    "workflow_instances",
    "workflows",
    "run_deps",
    "runs",
  ]) {
    dbMod.db().prepare(`DELETE FROM ${table}`).run();
  }
  // Back to a clean checkout on the target, whatever the last test landed.
  git(repoRoot(), "checkout", "-q", "main");
});

/* ------------------------------------------------------------------ */
/* The instance, written the way the instantiation writes one          */
/* ------------------------------------------------------------------ */

type NodeBlob = Record<string, unknown>;

/** Every field a saved graph carries, so a fixture states only what it means. */
function node(id: string, over: NodeBlob = {}): NodeBlob {
  return {
    id,
    name: id.toUpperCase(),
    kind: "run",
    templateId: null,
    mountId,
    folder: "repo",
    task: `${id} the thing`,
    promptOverride: null,
    agentId: null,
    fanOut: null,
    mergeStrategy: null,
    mergeAutoResolve: false,
    maxPasses: null,
    maxLoopCostUSD: null,
    stopWhenTasks: null,
    bodyNodeIds: [],
    ...over,
  };
}

const mergeNode = (id: string, over: NodeBlob = {}) =>
  node(id, { kind: "merge", mergeStrategy: "merge", folder: "", ...over });

/** The section under test throughout: one run block, then a merge block. */
const SECTION = {
  nodes: [node("a"), mergeNode("m")],
  edges: [
    { from: "L", to: "a", edge: "repeats" },
    { from: "a", to: "m", edge: "on-success" },
  ],
  body: ["a", "m"],
};

/**
 * A started instance holding one loop, named `Chip away`.
 *
 * The section's members get no rows of their own, which is what instantiation
 * does with them: their work happens once per pass under the loop's
 * `emitted_by`, so the loop's ledger row is their record until a pass opens one.
 */
function scene(opts: { maxPasses?: number; loopStatus?: string } = {}): string {
  const now = Date.now();
  const instanceId = `inst-${now}-${Math.random().toString(36).slice(2)}`;
  const loop = node("L", {
    name: "Chip away",
    kind: "loop",
    folder: "",
    maxPasses: opts.maxPasses ?? 1,
    bodyNodeIds: SECTION.body,
  });
  const graph = JSON.stringify({
    nodes: [loop, ...SECTION.nodes],
    edges: SECTION.edges.map((e) => ({ continueBranch: false, ...e })),
  });

  const db = dbMod.db();
  // The run that fills the one concurrency slot, so every member the instance
  // creates stays `queued` until the test settles it. See `maxConcurrentRuns`.
  db.prepare(
    `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                       created_at, started_at, work_dir)
     VALUES (?, ?, 'hold the slot', 'running', '{"maxIterations":1,"permissionMode":"acceptEdits"}',
             1, 0, ?, ?, NULL)`,
  ).run(`hold-${instanceId}`, holdFolder(), now, now);
  // The name is unique per scene because `workflows.name` is: one test builds
  // two instances, to ask what a *different* loop may do with this branch.
  const name = `Nightly ${instanceId}`;
  db.prepare(
    "INSERT INTO workflows (id, name, graph, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(`wf-${instanceId}`, name, graph, now, now);
  db.prepare(
    `INSERT INTO workflow_instances (id, workflow_id, workflow_name, graph, created_at, status)
     VALUES (?, ?, ?, ?, ?, 'started')`,
  ).run(instanceId, `wf-${instanceId}`, name, graph, now);
  db.prepare(
    "INSERT INTO workflow_instance_blocks (instance_id, node_id, node_name, position, kind, status)" +
      " VALUES (?, ?, ?, 0, 'loop', ?)",
  ).run(instanceId, "L", "Chip away", opts.loopStatus ?? "waiting");
  return instanceId;
}

/** The member rows of one instance, in creation order. */
function membersOf(instanceId: string): Array<{ memberId: string; runId: string }> {
  return dbMod
    .db()
    .prepare(
      "SELECT node_id AS memberId, run_id AS runId FROM workflow_instance_runs" +
        " WHERE instance_id = ? ORDER BY position",
    )
    .all(instanceId) as Array<{ memberId: string; runId: string }>;
}

/**
 * One ledger row as the instance page reads it.
 *
 * `branchesLanded` and `branchesFailed` are correlated on `merge_batch_id`, and
 * this run moved when that column is written — before the queue rows exist
 * rather than after, so that a row drained in between is not refused for want
 * of a statement a microtask away. That is the page's own reading, so it is
 * asserted here rather than reasoned about.
 */
function blockRow(
  instanceId: string,
  nodeId: string,
): { status: string; error: string | null; landed: number; failed: number } {
  const block = workflows.blocksOf(instanceId).find((b) => b.nodeId === nodeId);
  assert.ok(block, `no ledger row for ${nodeId}`);
  return {
    status: block.status,
    error: block.error,
    landed: block.branchesLanded,
    failed: block.branchesFailed,
  };
}

/**
 * Put a real commit on a branch of the repository, leaving `main` checked out.
 *
 * The one thing `loopSection.test.ts` deliberately does not do, and the reason
 * no test there could reach this defect: a branch sitting at its own base is
 * skipped by `branchVerdict` and never enters the merge queue.
 */
function commitOnBranch(branch: string, file: string): string {
  const base = git(repoRoot(), "rev-parse", "main").trim();
  git(repoRoot(), "checkout", "-q", "-b", branch, "main");
  fs.writeFileSync(path.join(repoRoot(), file), `${file}\n`);
  // This file and nothing else. `add -A` would sweep up whatever else is in
  // the tree, which is exactly what the dirty-checkout case plants there.
  git(repoRoot(), "add", "--", file);
  git(repoRoot(), "commit", "-q", "-m", `work on ${branch}`);
  git(repoRoot(), "checkout", "-q", "main");
  return base;
}

/** Settle every queued member as a completed run whose branch has a commit. */
function settleQueuedRuns(instanceId: string): void {
  for (const row of membersOf(instanceId)) {
    const run = dbMod
      .db()
      .prepare("SELECT status FROM runs WHERE id = ?")
      .get(row.runId) as { status: string } | undefined;
    if (!run || run.status !== "queued") continue;
    const branch = `uf/${row.runId}`;
    const base = commitOnBranch(branch, `${row.runId}.txt`);
    dbMod
      .db()
      .prepare(
        `UPDATE runs SET status='completed', iterations=1, finished_at=?,
                         isolation='worktree', repo_root=?, worktree_branch=?,
                         worktree_base=?, worktree_base_branch='main'
          WHERE id=?`,
      )
      .run(Date.now(), repoRoot(), branch, base, row.runId);
  }
}

/**
 * Carry the instance until nothing is moving, settling whatever it creates.
 *
 * A merge block is fire and forget and the queue it waits on polls every two
 * seconds, so this has to outlast that — `loopSection.test.ts`'s driver gives
 * the instance 800ms, which is enough for a merge that lands nothing and not
 * for one that lands something.
 */
async function drive(instanceId: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    settleQueuedRuns(instanceId);
    workflows.advanceInstances();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const live = workflows.blocksOf(instanceId).some((b) => b.status === "thinking");
    const queued = membersOf(instanceId).some(
      (m) =>
        (
          dbMod.db().prepare("SELECT status FROM runs WHERE id=?").get(m.runId) as
            | { status: string }
            | undefined
        )?.status === "queued",
    );
    if (!live && !queued) return;
  }
  assert.fail("the instance never stopped moving");
}

/** Whether git can see `branch` as already in `main`. */
function isInMain(branch: string): boolean {
  try {
    git(repoRoot(), "merge-base", "--is-ancestor", branch, "main");
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* The defect: a pass landing its own work                             */
/* ------------------------------------------------------------------ */

describe("a pass's merge block lands the pass's own branches", () => {
  it("puts the commit into the operator's checkout while the loop is still looping", async () => {
    const instanceId = scene({ maxPasses: 1 });
    await drive(instanceId);

    const member = membersOf(instanceId).find(
      (m) => m.memberId === passMemberId("L", 1, "a"),
    );
    assert.ok(member, "the pass created no run member");

    const merge = blockRow(instanceId, passMemberId("L", 1, "m"));
    // The sentence the operator got. Asserted by name rather than only through
    // the status, because "failed" is a real outcome with a dozen causes and
    // this is the one that must never be among them.
    assert.doesNotMatch(
      merge.error ?? "",
      /is still running on this branch/,
      "the pass's own merge block was refused by the hold its pass owns",
    );
    assert.equal(merge.status, "emitted", merge.error ?? "");
    assert.deepEqual(
      { landed: merge.landed, failed: merge.failed },
      { landed: 1, failed: 0 },
      "the instance page's own count of what this pass landed",
    );

    assert.ok(
      isInMain(`uf/${member.runId}`),
      "the branch never reached main, so nothing was landed",
    );
    const landed = dbMod
      .db()
      .prepare("SELECT landed_at AS at, landed_into AS into_ FROM runs WHERE id=?")
      .get(member.runId) as { at: number | null; into_: string | null };
    assert.ok(landed.at, "the run was never recorded as landed");
    assert.equal(landed.into_, "main");
  });

  it("still reports a pass that genuinely could not land, with the reason it has", async () => {
    // What this run changes is who may land, not what a failure to land means.
    // A dirty checkout is the operator's own tree moving under the merge, and
    // `planItem` halts the repository on it — the pass must still hear so.
    const instanceId = scene({ maxPasses: 1 });
    const dirty = path.join(repoRoot(), "uncommitted.txt");
    fs.writeFileSync(dirty, "half a thought\n");
    try {
      await drive(instanceId);
    } finally {
      fs.rmSync(dirty, { force: true });
    }

    const merge = blockRow(instanceId, passMemberId("L", 1, "m"));
    assert.equal(merge.status, "failed");
    assert.match(merge.error ?? "", /uncommitted changes/);
    assert.doesNotMatch(merge.error ?? "", /is still running on this branch/);
    assert.deepEqual(
      { landed: merge.landed, failed: merge.failed },
      { landed: 0, failed: 1 },
      "and what it did not land, which is the other half the page reports",
    );
  });
});

/* ------------------------------------------------------------------ */
/* The four doors, against a branch a live pass owns                   */
/* ------------------------------------------------------------------ */

/**
 * A live pass with one finished member on a branch of its own, by hand.
 *
 * Written rather than driven, because what these assert is the decision each
 * door makes about a scene, and driving one costs a merge queue per case. The
 * rows are the rows `stepPass` and `startMergeBlock` write, and the describe
 * above is what keeps that claim honest.
 */
function livePass(opts: { branch: string }): {
  instanceId: string;
  runId: string;
} {
  const instanceId = scene({ maxPasses: 3, loopStatus: "looping" });
  const runId = `member-${Math.random().toString(36).slice(2, 10)}`;
  const base = commitOnBranch(opts.branch, `${runId}.txt`);

  const db = dbMod.db();
  db.prepare(
    `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                       created_at, finished_at, isolation, repo_root, worktree_branch,
                       worktree_base, worktree_base_branch)
     VALUES (?, ?, 'a the thing', 'completed', '{}', 1, 1, ?, ?, 'worktree', ?, ?, ?, 'main')`,
  ).run(runId, repoRoot(), Date.now(), Date.now(), repoRoot(), opts.branch, base);
  db.prepare(
    `INSERT INTO workflow_instance_runs (instance_id, node_id, node_name, position, run_id, emitted_by)
     VALUES (?, ?, 'A — pass 1', 1, ?, 'L')`,
  ).run(instanceId, passMemberId("L", 1, "a"), runId);
  return { instanceId, runId };
}

/** A merge block of `instanceId` that has queued `batchId`. */
function mergeBlockQueued(
  instanceId: string,
  memberId: string,
  batchId: string,
): void {
  dbMod
    .db()
    .prepare(
      "INSERT INTO workflow_instance_blocks" +
        " (instance_id, node_id, node_name, position, kind, status, merge_batch_id)" +
        " VALUES (?, ?, 'M', 2, 'run', 'thinking', ?)",
    )
    .run(instanceId, memberId, batchId);
}

const HOLD = /Pass 1 of the workflow block “Chip away” is still running on this branch/;
const STOP = /Stop that run of the workflow first\./;

describe("a person is still refused every door on a live pass's branch", () => {
  it("refuses Land, and says which pass holds it", async () => {
    const { runId } = livePass({ branch: "uf/person-land" });

    const state = await land.landState(runId);
    assert.ok(state);
    assert.match(state.blocked ?? "", HOLD);
    assert.match(state.blocked ?? "", STOP);
    assert.match(state.blocked ?? "", /what it has done so far rather than all of it/);

    const landed = await land.landRun(runId, "merge");
    assert.equal(landed.ok, false);
    assert.match(landed.ok ? "" : landed.reason, HOLD);
    assert.equal(isInMain("uf/person-land"), false, "it landed anyway");
  });

  it("refuses Delete", async () => {
    const { runId } = livePass({ branch: "uf/person-delete" });
    const outcome = await land.deleteBranch(runId);
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? "" : outcome.reason, HOLD);
    assert.match(
      outcome.ok ? "" : outcome.reason,
      /take the next pass's starting point away/,
    );
  });

  it("refuses Purge, even when it names the branch", async () => {
    const { runId } = livePass({ branch: "uf/person-purge" });
    const outcome = await land.purgeBranch(runId, "uf/person-purge");
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? "" : outcome.reason, HOLD);
    assert.match(
      outcome.ok ? "" : outcome.reason,
      /take the branch out from under the next pass/,
    );
  });

  it("refuses Resolve, which is the door that would have spent money", async () => {
    const { runId } = livePass({ branch: "uf/person-resolve" });
    const outcome = await land.resolveConflicts(runId);
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? "" : outcome.reason, HOLD);
    assert.match(
      outcome.ok ? "" : outcome.reason,
      /resolution paid for now would be resolving against a moving branch/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* And the exemption is the owning pass alone                          */
/* ------------------------------------------------------------------ */

describe("the exemption reaches the owning pass's merge block and no other", () => {
  it("lets the pass's own merge block through", async () => {
    const { instanceId, runId } = livePass({ branch: "uf/own-pass" });
    mergeBlockQueued(instanceId, passMemberId("L", 1, "m"), "batch-own");

    const state = await land.landState(runId, { batchId: "batch-own" });
    assert.ok(state);
    assert.equal(state.blocked, null, state.blocked ?? "");
  });

  it("refuses a later pass of the same loop", async () => {
    // Pass 2's merge block lands pass 2's branches. Pass 1's are as much none
    // of its business as they are a person's — and by the time pass 2 exists,
    // pass 1 has either landed them or stopped the loop.
    const { instanceId, runId } = livePass({ branch: "uf/later-pass" });
    mergeBlockQueued(instanceId, passMemberId("L", 2, "m"), "batch-later");

    const state = await land.landState(runId, { batchId: "batch-later" });
    assert.ok(state);
    assert.match(state.blocked ?? "", HOLD);
  });

  it("refuses another loop's merge block, in another instance", async () => {
    const { runId } = livePass({ branch: "uf/other-loop" });
    const other = scene({ maxPasses: 1, loopStatus: "looping" });
    mergeBlockQueued(other, passMemberId("L", 1, "m"), "batch-other");

    const state = await land.landState(runId, { batchId: "batch-other" });
    assert.ok(state);
    assert.match(state.blocked ?? "", HOLD);
  });

  it("refuses a batch nothing queued, which is what the operator's Land is", async () => {
    const { runId } = livePass({ branch: "uf/loose-batch" });
    const state = await land.landState(runId, { batchId: "batch-nobody-owns" });
    assert.ok(state);
    assert.match(state.blocked ?? "", HOLD);
  });

  it("lets the owning pass reach the resolution door, and refuses everyone else at it", async () => {
    // The door that spends money, asked of a branch that does not conflict —
    // so the owning pass gets past the hold and is stopped by the honest answer
    // one check later, with no checkout built and no child spawned. What is
    // under test is which of the two answers each caller gets.
    const { instanceId, runId } = livePass({ branch: "uf/resolve-own" });
    mergeBlockQueued(instanceId, passMemberId("L", 1, "m"), "batch-resolve");

    const owner = await land.resolveConflicts(runId, { batchId: "batch-resolve" });
    assert.equal(owner.ok, false);
    assert.doesNotMatch(owner.ok ? "" : owner.reason, HOLD);
    assert.match(
      owner.ok ? "" : owner.reason,
      /does not conflict with main, so there is nothing to resolve/,
    );

    const person = await land.resolveConflicts(runId);
    assert.equal(person.ok, false);
    assert.match(person.ok ? "" : person.reason, HOLD);
  });
});
