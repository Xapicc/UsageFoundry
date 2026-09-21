import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { passMemberId } from "./passIds";

/**
 * A loop that repeats a **section** of blocks, driven through the real creation
 * path rather than asserted about.
 *
 * `planLoopPass` and `groupPasses` are unit-tested in `workflows.test.ts`, and
 * they are the decisions. This is the wiring between them and `createRun`, which
 * is the half neither of those can reach and where every mistake is silent:
 *
 *   - A pass is the section run as a graph, through the same `planInstanceStep`
 *     the graph itself goes through. Driven through a second reading of "which
 *     member may go now", a member that the section's own links release is left
 *     waiting for ever — and a workflow that is simply never finished looks
 *     exactly like one that is still working.
 *   - Nothing may be carried between passes. Pass N+1 that continued pass N's
 *     branch would be building on a ref the pass before it already landed and
 *     may have deleted; pass N+1 that started *before* that landing would redo
 *     the work, billed, in silence. Both are invisible from the instance page.
 *   - The member ids have to carry their pass, because `loopPasses` reads the
 *     pass count back out of them. Eight rows read as eight passes trips a cap
 *     of two after one pass and records it as the loop running out.
 *   - Every run a pass caused has to be its spend, including the ones an
 *     orchestrator member decided on. A pass whose spend is understated is a
 *     spend cap that never trips.
 *
 * The instance rows are inserted rather than instantiated because
 * `startWorkflow` probes the disk for a real git worktree on every block of a
 * section, and this file is about what happens *after* a loop is released.
 * Nothing here spawns: `CLAUDE_BIN` names a file that does not exist, so a
 * regression that reached a spawn is a failed test rather than a billed one.
 *
 * The merge blocks here land **nothing**: every run's branch is real and sits
 * at its own base, so `branchVerdict` skips it and `mergeBlockOutcome` reports a
 * merge that worked and had nothing to do. That is deliberate. What is under
 * test is the loop's reading of a merge — did this pass land everything, and
 * what does the next pass start after — and git's own answer for one branch is
 * `mergeQueue.ts`'s subject, where it is decided and where it is covered.
 *
 * Its own file, with `DATA_DIR` named before the first import, for
 * `loopBoardCount.test.ts`'s reason — `config.ts` is read at module load, so a
 * file that imported the orchestrator at the top would already be bound to the
 * repository's own `.data`, which on a developer's machine is the real one.
 */

let workflows: typeof import("./workflows");
let dbMod: typeof import("./db");
let root: string;
let mountId: string;

/** The workspace directory's basename, which is also the mount's id. */
const MOUNT_DIR = "section-mount";

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

/** The repository every block of every fixture works in. */
const repoRoot = () => path.join(root, MOUNT_DIR, "repo");

before(async () => {
  // `realpathSync`, which `resolveInMount` checks containment against — a mount
  // registered at an unresolved path refuses its own checkout, and on macOS
  // `os.tmpdir()` is a symlink.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-loop-section-")));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, MOUNT_DIR);
  // Cleared, not overridden: `WORKSPACE_ROOTS` wins whenever it is set, so an
  // operator's own mounts inherited from the shell would be the ones these runs
  // were created against.
  process.env.WORKSPACE_ROOTS = "";
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  // A real repository with a commit on it: a merge block resolves every branch
  // in front of it against the disk, and a plain directory gets no branch at
  // all — after which the pass's merge fails by name, which is the right
  // refusal about the wrong thing.
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
  workflows = await import("./workflows");

  // One run at a time, so a member that isolates is still held at `queued`
  // behind the run each fixture parks in the repository. Nothing here is about
  // admission: releasing a member would have it build a checkout and spawn an
  // agent, and `CLAUDE_BIN` names a file that does not exist — so a released
  // member fails asynchronously, some milliseconds later, and rewrites the
  // status this file just set. A checkout of its own is what takes a member
  // past a *folder* that is busy, so occupancy alone cannot hold one and this
  // is the lever that can.
  const settings = await import("./settings");
  settings.saveSettings({ maxConcurrentRuns: 1 });
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  for (const table of [
    "workflow_instance_blocks",
    "workflow_instance_runs",
    "workflow_instances",
    "workflows",
    "run_deps",
    "runs",
  ]) {
    dbMod.db().prepare(`DELETE FROM ${table}`).run();
  }
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

/**
 * A started instance holding one loop and whatever the fixture puts round it.
 *
 * The section's members get **no rows of their own**, which is what
 * instantiation does with them: their work happens once per pass under the
 * loop's `emitted_by`, so the loop's ledger row is their record until a pass
 * opens one.
 */
function scene(opts: {
  nodes: NodeBlob[];
  edges: Array<{ from: string; to: string; edge: string; continueBranch?: boolean }>;
  body: string[];
  maxPasses?: number;
  maxLoopCostUSD?: number | null;
  /** Blocks of the graph itself, which get a `waiting` row like the loop's. */
  ownBlocks?: Array<{ id: string; kind: string }>;
}): string {
  const now = Date.now();
  const instanceId = `inst-${now}-${Math.random().toString(36).slice(2)}`;
  const loop = node("L", {
    name: "Chip away",
    kind: "loop",
    folder: "",
    maxPasses: opts.maxPasses ?? 3,
    maxLoopCostUSD: opts.maxLoopCostUSD ?? null,
    bodyNodeIds: opts.body,
  });
  const graph = JSON.stringify({
    nodes: [loop, ...opts.nodes],
    edges: opts.edges.map((e) => ({ continueBranch: false, ...e })),
  });

  const db = dbMod.db();
  // The run that fills the one concurrency slot this file leaves, so every
  // member the instance creates stays `queued` until this test settles it. See
  // `maxConcurrentRuns` above.
  db.prepare(
    `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                       created_at, started_at, work_dir)
     VALUES (?, ?, 'hold the folder', 'running', '{"maxIterations":1,"permissionMode":"acceptEdits"}',
             1, 0, ?, ?, NULL)`,
  ).run(`hold-${instanceId}`, repoRoot(), now, now);
  db.prepare(
    "INSERT INTO workflows (id, name, graph, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(`wf-${instanceId}`, "Nightly", graph, now, now);
  db.prepare(
    `INSERT INTO workflow_instances (id, workflow_id, workflow_name, graph, created_at, status)
     VALUES (?, ?, ?, ?, ?, 'started')`,
  ).run(instanceId, `wf-${instanceId}`, "Nightly", graph, now);
  const block = db.prepare(
    "INSERT INTO workflow_instance_blocks (instance_id, node_id, node_name, position, kind, status)" +
      " VALUES (?, ?, ?, ?, ?, 'waiting')",
  );
  block.run(instanceId, "L", "Chip away", 0, "loop");
  for (const [index, own] of (opts.ownBlocks ?? []).entries()) {
    block.run(instanceId, own.id, own.id.toUpperCase(), index + 1, own.kind);
  }
  return instanceId;
}

/** The member rows of one instance, in creation order. */
function membersOf(instanceId: string): Array<{
  memberId: string;
  nodeName: string;
  runId: string;
  emittedBy: string | null;
}> {
  return dbMod
    .db()
    .prepare(
      "SELECT node_id AS memberId, node_name AS nodeName, run_id AS runId," +
        " emitted_by AS emittedBy FROM workflow_instance_runs" +
        " WHERE instance_id = ? ORDER BY position",
    )
    .all(instanceId) as Array<{
    memberId: string;
    nodeName: string;
    runId: string;
    emittedBy: string | null;
  }>;
}

/** What one run was created waiting for, as run ids. */
function depsOf(runId: string): Array<{
  dependsOn: string;
  edge: string;
  continueBranch: number;
}> {
  return dbMod
    .db()
    .prepare(
      "SELECT depends_on AS dependsOn, edge, continue_branch AS continueBranch" +
        " FROM run_deps WHERE run_id = ? ORDER BY depends_on",
    )
    .all(runId) as Array<{
    dependsOn: string;
    edge: string;
    continueBranch: number;
  }>;
}

function blockRow(
  instanceId: string,
  nodeId: string,
): { status: string; emitted: number; error: string | null } {
  const block = workflows.blocksOf(instanceId).find((b) => b.nodeId === nodeId);
  assert.ok(block, `no ledger row for ${nodeId}`);
  return { status: block.status, emitted: block.emitted, error: block.error };
}

const loopBlock = (instanceId: string) => blockRow(instanceId, "L");

/**
 * Settle every queued run of the instance as one that worked on its own branch.
 *
 * The status alone is not enough and the difference is the reason this helper
 * exists: a run's branch columns are filled in when it is **released**, and
 * nothing here releases anything — `CLAUDE_BIN` names a file that does not
 * exist, so a member admitted for real would fail at the spawn. A merge block
 * resolves every branch in front of it against the disk, so a pass settled by
 * status alone would fail its merge with a sentence about isolation rather than
 * landing.
 *
 * **A branch each**, cut fresh from the target. That is what the section's links
 * say here and what a pass's runs do: nothing carries a ref unless a link says
 * so, and every branch is left for the pass's own merge block to land.
 */
function settleQueuedRuns(
  instanceId: string,
  opts: { done?: boolean; costUSD?: number; branch?: (runId: string) => string } = {},
): void {
  const base = git(repoRoot(), "rev-parse", "HEAD").trim();
  for (const row of membersOf(instanceId)) {
    const run = dbMod
      .db()
      .prepare("SELECT status FROM runs WHERE id = ?")
      .get(row.runId) as { status: string } | undefined;
    if (!run || run.status !== "queued") continue;
    const branch = opts.branch ? opts.branch(row.runId) : `uf/${row.runId}`;
    if (!opts.branch) git(repoRoot(), "branch", "-f", branch, base);
    dbMod
      .db()
      .prepare(
        `UPDATE runs SET status='completed', iterations=1, finished_at=?,
                         reported_done=?, spent_usd=?,
                         isolation='worktree', repo_root=?, worktree_path=?,
                         worktree_branch=?, worktree_base=?
          WHERE id=?`,
      )
      .run(
        Date.now(),
        opts.done ? 1 : 0,
        opts.costUSD ?? 0,
        repoRoot(),
        path.join(root, "worktrees", row.runId),
        branch,
        base,
        row.runId,
      );
  }
}

/**
 * Carry the instance as far as it will go, settling whatever it creates.
 *
 * A merge block is spawned rather than awaited — `startMergeBlock` is fire and
 * forget, and `finishMergeBlock` advances the instance itself when it lands — so
 * "has this stopped moving" is the only question that can be asked from here.
 * Bounded, because the defect this whole file is about is a loop that does not
 * stop.
 */
async function drive(
  instanceId: string,
  opts: { done?: boolean; costUSD?: number; branch?: (runId: string) => string } = {},
): Promise<void> {
  for (let step = 0; step < 40; step += 1) {
    settleQueuedRuns(instanceId, opts);
    workflows.advanceInstances();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const live = workflows
      .blocksOf(instanceId)
      .some((b) => b.status === "thinking");
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

/** The section every fan-out test repeats: one entry, two branches, a merge. */
const FAN_OUT = {
  nodes: [node("a"), node("b"), node("c"), mergeNode("m")],
  edges: [
    { from: "L", to: "a", edge: "repeats" },
    { from: "a", to: "b", edge: "on-success" },
    { from: "a", to: "c", edge: "on-success" },
    { from: "b", to: "m", edge: "on-success" },
    { from: "c", to: "m", edge: "on-success" },
  ],
  body: ["a", "b", "c", "m"],
};

/* ------------------------------------------------------------------ */
/* One pass is the section instantiated                                */
/* ------------------------------------------------------------------ */

describe("a pass of a section that fans out and merges", () => {
  it("creates every member of the section, wired by the section's own links", async () => {
    const instanceId = scene({ ...FAN_OUT, maxPasses: 1 });
    await drive(instanceId);

    const members = membersOf(instanceId);
    assert.deepEqual(
      members.map((m) => m.memberId),
      ["a", "b", "c"].map((id) => passMemberId("L", 1, id)),
      "one run member per run block of the section, in the section's own order",
    );
    // The merge member is a ledger row, not a run — which is why reading a
    // pass out of the run table alone would report it as settled while its
    // merge was still landing.
    assert.equal(blockRow(instanceId, passMemberId("L", 1, "m")).status, "emitted");

    const byNode = new Map(
      members.map((m) => [m.memberId.split("#").at(-1)!, m.runId]),
    );
    assert.deepEqual(depsOf(byNode.get("a")!), [], "the entry waits for nothing");
    for (const id of ["b", "c"]) {
      assert.deepEqual(
        depsOf(byNode.get(id)!),
        [{ dependsOn: byNode.get("a")!, edge: "on-success", continueBranch: 0 }],
        `${id} starts after the entry, as the section's link says`,
      );
    }
  });

  it("records every member under the loop, so one halt reaches all of them", async () => {
    const instanceId = scene({ ...FAN_OUT, maxPasses: 1 });
    await drive(instanceId);
    assert.deepEqual(
      [...new Set(membersOf(instanceId).map((m) => m.emittedBy))],
      ["L"],
      "the loop, whatever block of the section the work is",
    );
  });

  it("names each member for its own block and its pass", async () => {
    const instanceId = scene({ ...FAN_OUT, maxPasses: 1 });
    await drive(instanceId);
    assert.deepEqual(
      membersOf(instanceId).map((m) => m.nodeName),
      ["A — pass 1", "B — pass 1", "C — pass 1"],
      // The loop's name three times over says nothing about which row is which.
      "the member's own name, not the loop's",
    );
  });
});

describe("two passes of a section", () => {
  it("carries no branch between them, and starts pass 2 after pass 1 landed", async () => {
    const instanceId = scene({ ...FAN_OUT, maxPasses: 2 });
    await drive(instanceId);

    const members = membersOf(instanceId);
    assert.deepEqual(
      members.map((m) => m.memberId),
      [
        ...["a", "b", "c"].map((id) => passMemberId("L", 1, id)),
        ...["a", "b", "c"].map((id) => passMemberId("L", 2, id)),
      ],
      "two passes of the same section, each carrying its own pass number",
    );

    // Nothing anywhere continues a branch, which is the whole rule: a pass's
    // runs cut fresh branches in their folders and what makes the pass before
    // them visible is that it *landed*.
    for (const member of members) {
      for (const dep of depsOf(member.runId)) {
        assert.equal(
          dep.continueBranch,
          0,
          `${member.memberId} was wired to carry on a branch`,
        );
      }
    }

    // And pass 2's entry starts after nothing at all — not after pass 1's last
    // run. What it is waiting for is the landing, which already happened: the
    // pass is only created once pass 1's merge block settled.
    const secondEntry = members.find(
      (m) => m.memberId === passMemberId("L", 2, "a"),
    )!;
    assert.deepEqual(depsOf(secondEntry.runId), []);

    const firstMerge = blockRow(instanceId, passMemberId("L", 1, "m"));
    assert.equal(firstMerge.status, "emitted");
    const secondEntryRun = dbMod
      .db()
      .prepare("SELECT created_at AS at FROM runs WHERE id=?")
      .get(secondEntry.runId) as { at: number };
    const mergedAt = dbMod
      .db()
      .prepare(
        "SELECT finished_at AS at FROM workflow_instance_blocks WHERE instance_id=? AND node_id=?",
      )
      .get(instanceId, passMemberId("L", 1, "m")) as { at: number | null };
    assert.ok(
      mergedAt.at !== null && secondEntryRun.at >= mergedAt.at,
      "pass 2's first run was created before pass 1 finished landing",
    );
  });

  it("stops on the pass cap having counted passes, not members", async () => {
    // Eight rows read as eight passes would stop a cap of two after the first.
    const instanceId = scene({ ...FAN_OUT, maxPasses: 2 });
    await drive(instanceId);
    const block = loopBlock(instanceId);
    assert.equal(block.status, "emitted");
    assert.match(block.error ?? "", /limit of 2 pass\(es\)/);
  });
});

describe("DONE, over a section that runs blocks side by side", () => {
  it("is every run member of the pass reporting it", async () => {
    const instanceId = scene({ ...FAN_OUT, maxPasses: 3 });
    await drive(instanceId, { done: true });
    const block = loopBlock(instanceId);
    assert.equal(block.status, "emitted");
    assert.match(block.error ?? "", /reported the work complete on pass 1/);
    assert.equal(
      membersOf(instanceId).length,
      3,
      "it stopped after the first pass",
    );
  });

  it("is not one member of it", async () => {
    // The defect this exists for: with a section that fans out there is no
    // last-run-of-a-chain, so a loop that read one member's DONE would stop
    // while the rest of the section was still finding work to do — silently,
    // because a branch that was going to be finished simply never is.
    const instanceId = scene({ ...FAN_OUT, maxPasses: 2 });
    let first = true;
    for (let step = 0; step < 40; step += 1) {
      // Only the section's entry ever says DONE.
      for (const row of membersOf(instanceId)) {
        const run = dbMod
          .db()
          .prepare("SELECT status FROM runs WHERE id=?")
          .get(row.runId) as { status: string } | undefined;
        if (run?.status !== "queued") continue;
        settleOne(row.runId, { done: row.memberId.endsWith("#a") });
      }
      workflows.advanceInstances();
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (loopBlock(instanceId).status !== "looping") break;
      first = false;
    }
    assert.equal(first, false, "the loop stopped without taking a second pass");
    const block = loopBlock(instanceId);
    assert.match(block.error ?? "", /limit of 2 pass\(es\)/);
  });
});

/** One run settled the way `settleQueuedRuns` settles them. */
function settleOne(
  runId: string,
  opts: { done?: boolean; costUSD?: number; branch?: string } = {},
): void {
  const base = git(repoRoot(), "rev-parse", "HEAD").trim();
  const branch = opts.branch ?? `uf/${runId}`;
  if (!opts.branch) git(repoRoot(), "branch", "-f", branch, base);
  dbMod
    .db()
    .prepare(
      `UPDATE runs SET status='completed', iterations=1, finished_at=?,
                       reported_done=?, spent_usd=?,
                       isolation='worktree', repo_root=?, worktree_path=?,
                       worktree_branch=?, worktree_base=?
        WHERE id=?`,
    )
    .run(
      Date.now(),
      opts.done ? 1 : 0,
      opts.costUSD ?? 0,
      repoRoot(),
      path.join(root, "worktrees", runId),
      branch,
      base,
      runId,
    );
}

/* ------------------------------------------------------------------ */
/* A pass that did not land everything                                 */
/* ------------------------------------------------------------------ */

describe("a pass whose merge did not land everything", () => {
  it("stops the loop, naming what was left behind", async () => {
    // The next pass's runs would cut fresh branches from the folder, so what
    // this merge left behind is invisible to them: they would do the same work
    // again, billed, and nothing would say so.
    const instanceId = scene({ ...FAN_OUT, maxPasses: 3 });
    for (let step = 0; step < 40; step += 1) {
      for (const row of membersOf(instanceId)) {
        const run = dbMod
          .db()
          .prepare("SELECT status FROM runs WHERE id=?")
          .get(row.runId) as { status: string } | undefined;
        if (run?.status !== "queued") continue;
        // `c`'s branch is one nobody ever cut. Its work is real and it is not
        // on the target, which is exactly the state a merge must not call
        // finished.
        settleOne(row.runId, {
          branch: row.memberId.endsWith("#c") ? "uf/never-cut" : undefined,
        });
      }
      workflows.advanceInstances();
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (loopBlock(instanceId).status !== "looping") break;
    }

    const merge = blockRow(instanceId, passMemberId("L", 1, "m"));
    assert.equal(merge.status, "failed", "a merge that lost a branch is failed");

    const block = loopBlock(instanceId);
    assert.equal(block.status, "failed", "and a loop that did not land is too");
    assert.match(block.error ?? "", /did not land everything/);
    assert.match(block.error ?? "", /would do it again/);
    assert.equal(
      membersOf(instanceId).filter((m) => m.memberId.includes("#pass-2#")).length,
      0,
      "it must not have taken a second pass",
    );
  });
});

/* ------------------------------------------------------------------ */
/* An orchestrator member                                              */
/* ------------------------------------------------------------------ */

/** A section of one deciding turn and the merge block behind it. */
const DECIDER = {
  nodes: [
    node("o", { kind: "orchestrator", fanOut: 2, folder: "" }),
    mergeNode("m"),
  ],
  edges: [
    { from: "L", to: "o", edge: "repeats" },
    { from: "o", to: "m", edge: "on-finish" },
  ],
  body: ["o", "m"],
};

/**
 * Settle the turn this pass's orchestrator member is in the middle of.
 *
 * `settleBlock` is the door a real turn's child process comes back through, and
 * it is latched on `thinking` — so calling it here, in the same turn of the
 * event loop that claimed the block, is what makes the spawn `startBlockTurn`
 * has already fired a no-op when it fails against a `CLAUDE_BIN` that is not
 * there. What a model would have said is the argument; everything downstream of
 * it is the real path.
 */
function decide(
  instanceId: string,
  memberId: string,
  specs: Array<Record<string, unknown>>,
  costUSD: number,
): void {
  assert.equal(
    blockRow(instanceId, memberId).status,
    "thinking",
    "the pass never claimed its orchestrator member",
  );
  const emitted = workflows.emitBlockRuns(instanceId, memberId, specs);
  assert.ok(emitted.ok, emitted.ok ? "" : emitted.reason);
  workflows.settleBlock(instanceId, memberId, { status: "idle", costUSD });
}

/** What a turn would have asked for: two runs in the repository. */
const twoRuns = [
  { id: "one", title: "One", task: "do one", folder: "repo" },
  { id: "two", title: "Two", task: "do two", folder: "repo" },
];

describe("an orchestrator member of a pass", () => {
  it("puts the runs it decided on inside the pass", async () => {
    const instanceId = scene({ ...DECIDER, maxPasses: 1 });
    workflows.advanceInstances();

    const member = passMemberId("L", 1, "o");
    decide(instanceId, member, twoRuns, 0.5);
    await drive(instanceId);

    const emitted = membersOf(instanceId).filter((m) => m.emittedBy === member);
    assert.equal(emitted.length, 2, "both runs the turn decided on were created");
    for (const run of emitted) {
      // Under the loop's own prefix, which is what `loopPasses` and `loopSpend`
      // read: a run outside it is work this pass caused that the pass cannot
      // see, and a spend cap that cannot see it never trips.
      assert.ok(
        run.memberId.startsWith(passMemberId("L", 1, "o")),
        `${run.memberId} is outside the prefix the pass is summed on`,
      );
    }

    // And the pass is counted. A section with no run block in it leaves no row
    // whose `emitted_by` is the loop — its members are ledger rows and its
    // emitted runs name the member — so a count taken from that column reports
    // a loop that took a pass as having taken none.
    assert.equal(loopBlock(instanceId).emitted, 1);
  });

  it("holds the pass open until the runs it emitted have settled", async () => {
    // The member's own row says `emitted` the moment the turn ends. Taking that
    // as the end of the pass would start the next one while a run this one
    // decided on was still working in the folder.
    const instanceId = scene({ ...DECIDER, maxPasses: 2 });
    workflows.advanceInstances();
    decide(instanceId, passMemberId("L", 1, "o"), twoRuns, 0);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(blockRow(instanceId, passMemberId("L", 1, "o")).status, "emitted");
    workflows.advanceInstances();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      workflows.blocksOf(instanceId).some((b) => b.nodeId === passMemberId("L", 2, "o")),
      false,
      "pass 2 started while pass 1's emitted runs were still queued",
    );
  });

  it("counts what those runs spent against the loop's own cap", async () => {
    // The defect: a pass whose spend is understated is a spend cap that never
    // trips, and the money a loop spends on a section that fans out is mostly
    // in the runs a model decided on rather than in its own deciding turn.
    const instanceId = scene({ ...DECIDER, maxPasses: 5, maxLoopCostUSD: 3 });
    workflows.advanceInstances();
    decide(instanceId, passMemberId("L", 1, "o"), twoRuns, 0.25);
    await drive(instanceId, { costUSD: 2 });

    const block = loopBlock(instanceId);
    assert.equal(block.status, "emitted");
    assert.match(block.error ?? "", /spent 4\.25 of its 3\.00 limit/);
  });

  it("stops the loop when its turn did not finish", async () => {
    // A member that did not complete stops the loop, over members of all three
    // kinds — and a deciding turn that failed is one the next pass would meet
    // again. Nothing settles this one, so `startBlockTurn`'s own spawn against
    // a `CLAUDE_BIN` that is not there is what ends it.
    const instanceId = scene({ ...DECIDER, maxPasses: 3 });
    for (let step = 0; step < 40; step += 1) {
      workflows.advanceInstances();
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (loopBlock(instanceId).status !== "looping") break;
    }
    const block = loopBlock(instanceId);
    assert.equal(block.status, "failed");
    assert.match(block.error ?? "", /did not finish/);
  });
});

/* ------------------------------------------------------------------ */
/* Stopping a workflow while a pass is live                            */
/* ------------------------------------------------------------------ */

describe("stopping an instance mid-pass", () => {
  it("brings down every member of the pass, of all three kinds", async () => {
    // A pass used to be a chain of runs, so a halt that reached the runs
    // reached the pass. It is now a section: its orchestrator and merge members
    // are ledger rows and its unopened members are `waiting` rows, and any one
    // of them left behind is a workflow that can never be started again —
    // `liveBlocksOf` counts it for ever and the second press is refused.
    const instanceId = scene({ ...FAN_OUT, maxPasses: 3 });
    workflows.advanceInstances();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const pass1 = ["a", "b", "c", "m"].map((id) => passMemberId("L", 1, id));
    assert.deepEqual(
      workflows
        .blocksOf(instanceId)
        .filter((b) => pass1.includes(b.nodeId))
        .map((b) => b.nodeId),
      pass1.slice(1),
      "the pass opened a row for every member it had not yet created",
    );

    const halt = workflows.stopInstance(instanceId, { kind: "operator" });
    assert.ok(halt.ok, halt.ok ? "" : halt.reason);

    for (const block of workflows.blocksOf(instanceId)) {
      assert.equal(
        ["waiting", "thinking", "looping"].includes(block.status),
        false,
        `${block.nodeId} was left live by the halt`,
      );
    }
    // What the second press of Run reads. A member left `waiting` here is a
    // workflow that can never be started again.
    assert.equal(workflows.liveBlocksOf(`wf-${instanceId}`), 0);
    for (const member of membersOf(instanceId)) {
      const run = dbMod
        .db()
        .prepare("SELECT status FROM runs WHERE id=?")
        .get(member.runId) as { status: string };
      assert.equal(
        ["queued", "running", "waiting", "paused"].includes(run.status),
        false,
        `${member.memberId} was left live by the halt`,
      );
    }
  });

  it("reaches the runs an orchestrator member decided on", async () => {
    // They are not members — a model chose them — but they are runs this pass
    // caused, and the halt's promise is that nothing it started is still
    // working when it reports that it stopped.
    const instanceId = scene({ ...DECIDER, maxPasses: 3 });
    workflows.advanceInstances();
    decide(instanceId, passMemberId("L", 1, "o"), twoRuns, 0);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const emitted = membersOf(instanceId);
    assert.equal(emitted.length, 2, "the turn's runs exist to be stopped");

    const halt = workflows.stopInstance(instanceId, { kind: "operator" });
    assert.ok(halt.ok, halt.ok ? "" : halt.reason);
    for (const member of emitted) {
      const run = dbMod
        .db()
        .prepare("SELECT status FROM runs WHERE id=?")
        .get(member.runId) as { status: string };
      assert.equal(
        ["queued", "running", "waiting", "paused"].includes(run.status),
        false,
        `${member.memberId} was left live by the halt`,
      );
    }
    assert.notEqual(loopBlock(instanceId).status, "looping");
  });
});
