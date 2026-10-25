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
let tasks: typeof import("./tasks");
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
  tasks = await import("./tasks");

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

beforeEach(() => emptyTables());

function emptyTables(): void {
  for (const table of [
    "workflow_review_items",
    "run_reviews",
    "workflow_instance_blocks",
    "workflow_instance_runs",
    "workflow_instances",
    "workflows",
    "run_deps",
    "runs",
    "tasks",
  ]) {
    dbMod.db().prepare(`DELETE FROM ${table}`).run();
  }
}

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
 * A started instance holding one loop and whatever the fixture puts round it —
 * or, with no `body`, no loop at all: a block outside every section is what a
 * pass's spelling must not be read into.
 *
 * The section's members get **no rows of their own**, which is what
 * instantiation does with them: their work happens once per pass under the
 * loop's `emitted_by`, so the loop's ledger row is their record until a pass
 * opens one.
 */
function scene(opts: {
  nodes: NodeBlob[];
  edges: Array<{ from: string; to: string; edge: string; continueBranch?: boolean }>;
  body?: string[];
  maxPasses?: number;
  maxLoopCostUSD?: number | null;
  stopWhenTasks?: NodeBlob | null;
  /** Blocks of the graph itself, which get a `waiting` row like the loop's. */
  ownBlocks?: Array<{ id: string; kind: string }>;
}): string {
  const now = Date.now();
  const instanceId = `inst-${now}-${Math.random().toString(36).slice(2)}`;
  const loop = opts.body
    ? node("L", {
        name: "Chip away",
        kind: "loop",
        folder: "",
        maxPasses: opts.maxPasses ?? 3,
        maxLoopCostUSD: opts.maxLoopCostUSD ?? null,
        stopWhenTasks: opts.stopWhenTasks ?? null,
        bodyNodeIds: opts.body,
      })
    : null;
  const graph = JSON.stringify({
    nodes: [...(loop ? [loop] : []), ...opts.nodes],
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
  if (loop) block.run(instanceId, "L", "Chip away", 0, "loop");
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
  opts: {
    done?: boolean;
    costUSD?: number;
    branch?: (runId: string) => string;
    /**
     * Settle as a run that worked in the folder itself: no branch, no checkout.
     * A predicate on the member's id settles only those, for a section that
     * mixes a landing head with an in-folder tail.
     */
    inFolder?: boolean | ((memberId: string) => boolean);
  } = {},
): void {
  const base = git(repoRoot(), "rev-parse", "HEAD").trim();
  for (const row of membersOf(instanceId)) {
    const run = dbMod
      .db()
      .prepare("SELECT status FROM runs WHERE id = ?")
      .get(row.runId) as { status: string } | undefined;
    if (!run || run.status !== "queued") continue;
    const inFolder =
      typeof opts.inFolder === "function" ? opts.inFolder(row.memberId) : opts.inFolder;
    if (inFolder) {
      dbMod
        .db()
        .prepare(
          `UPDATE runs SET status='completed', iterations=1, finished_at=?,
                           reported_done=?, spent_usd=? WHERE id=?`,
        )
        .run(Date.now(), opts.done ? 1 : 0, opts.costUSD ?? 0, row.runId);
      continue;
    }
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
  opts: {
    done?: boolean;
    costUSD?: number;
    branch?: (runId: string) => string;
    inFolder?: boolean | ((memberId: string) => boolean);
  } = {},
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

/** A review block with no fix rounds: one verdict per branch. */
const reviewNode = (id: string) =>
  node(id, { kind: "review", folder: "", fixRounds: 0, provider: null });

/** One run, the review of its branch, and the merge that lands what passed. */
const REVIEWED = {
  nodes: [node("a"), reviewNode("v"), mergeNode("m")],
  edges: [
    { from: "L", to: "a", edge: "repeats" },
    { from: "a", to: "v", edge: "on-success" },
    { from: "v", to: "m", edge: "on-success" },
  ],
  body: ["a", "v", "m"],
};

/** Where each branch a review member was given ended up. */
function reviewItems(instanceId: string): Array<{ status: string; committedNothing: number }> {
  return dbMod
    .db()
    .prepare(
      "SELECT status, committed_nothing AS committedNothing FROM workflow_review_items" +
        " WHERE instance_id = ? ORDER BY position",
    )
    .all(instanceId) as Array<{ status: string; committedNothing: number }>;
}

describe("DONE, over a pass whose review set the branch aside", () => {
  it("is not the work complete when the branch had work on it", async () => {
    // The pass from the report, through the tables rather than a literal: the
    // run said DONE, its branch was set aside unlanded with a commit on it —
    // here because the only model its review could run on is a Haiku, the
    // quickest real refusal to stage that spawns nothing — and the merge behind
    // it had nothing to land. That pass ending the loop as done starts an
    // `on-success` successor on a folder without the work. Not a review of the
    // run already running, as it was staged until 2026-10-17: a review block
    // now waits that out.
    const HAIKU = "claude-haiku-4-5";
    const settings = await import("./settings");
    settings.saveSettings({ defaultModel: HAIKU });
    try {
      const instanceId = scene({ ...REVIEWED, maxPasses: 1 });
      await drive(instanceId, {
        done: true,
        branch: (runId) => {
          const branch = `uf/${runId}`;
          git(repoRoot(), "switch", "-q", "-c", branch);
          fs.writeFileSync(path.join(repoRoot(), `${runId}.txt`), "work\n");
          git(repoRoot(), "add", `${runId}.txt`);
          git(repoRoot(), "commit", "-q", "-m", runId);
          git(repoRoot(), "switch", "-q", "main");
          dbMod.db().prepare("UPDATE runs SET model = ? WHERE id = ?").run(HAIKU, runId);
          return branch;
        },
      });
      assert.deepEqual(reviewItems(instanceId), [{ status: "set-aside", committedNothing: 0 }]);
      const { note } = dbMod
        .db()
        .prepare("SELECT note FROM workflow_review_items WHERE instance_id = ?")
        .get(instanceId) as { note: string };
      assert.match(note, /^it could not be reviewed: .*not a frontier model/, "staged by some other refusal");
      assert.match(loopBlock(instanceId).error ?? "", /limit of 1 pass\(es\) without reporting/);
    } finally {
      settings.saveSettings({ defaultModel: null });
    }
  });

  it("is the work complete when the branch had nothing on it", async () => {
    // The run found nothing left to do and said so, which is how a reviewed
    // loop ends: its branch sits at its base, so the review had nothing to
    // read. Counting that as work turned down would bill every pass the cap
    // allows and then report the loop as having run out.
    const instanceId = scene({ ...REVIEWED, maxPasses: 3 });
    await drive(instanceId, { done: true });
    assert.deepEqual(reviewItems(instanceId), [{ status: "set-aside", committedNothing: 1 }]);
    assert.match(loopBlock(instanceId).error ?? "", /reported the work complete on pass 1/);
    assert.equal(membersOf(instanceId).length, 1, "it stopped after the first pass");
  });

  it("leaves its review unclaimed while new work is held, and reviews once the hold clears", async () => {
    // A pass claims its review members in a loop of its own rather than
    // through `advanceInstance`'s, so the hold has to be asked there as well:
    // claimed under it, every branch was handed to a billed reviewer.
    const settings = await import("./settings");
    const instanceId = scene({ ...REVIEWED, maxPasses: 1 });
    const member = passMemberId("L", 1, "v");
    workflows.advanceInstances();
    settleQueuedRuns(instanceId, { done: true });

    settings.setNewWorkPaused(true);
    try {
      workflows.advanceInstances();
      assert.equal(blockRow(instanceId, member).status, "waiting", "the held pass claimed its review");
      assert.equal(loopBlock(instanceId).status, "looping", "a held pass is not a stopped loop");
    } finally {
      settings.setNewWorkPaused(false);
    }

    await drive(instanceId, { done: true });
    assert.deepEqual(reviewItems(instanceId), [{ status: "set-aside", committedNothing: 1 }]);
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

  it("leaves its turn unclaimed while new work is held, and takes it once the hold clears", async () => {
    // A pass claims its deciding members in a loop of its own rather than
    // through `advanceInstance`'s, so the hold has to be asked there as well:
    // claimed under it, the turn was billed and its emission then refused.
    const settings = await import("./settings");
    const instanceId = scene({ ...DECIDER, maxPasses: 1 });
    const member = passMemberId("L", 1, "o");

    settings.setNewWorkPaused(true);
    try {
      workflows.advanceInstances();
      assert.equal(blockRow(instanceId, member).status, "waiting", "the held pass claimed its turn");
      assert.equal(loopBlock(instanceId).status, "looping", "a held pass is not a stopped loop");
    } finally {
      settings.setNewWorkPaused(false);
    }

    workflows.advanceInstances();
    decide(instanceId, member, twoRuns, 0);
    await drive(instanceId);
    assert.equal(loopBlock(instanceId).emitted, 1, "the pass went on to finish once the hold cleared");
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
/* Picking a stuck pass up                                             */
/* ------------------------------------------------------------------ */

/**
 * Settle every queued run, ending the ones `stuck` names needs-review, until the
 * loop stops. The stuck run keeps a real branch, so a merge that wrongly
 * resolved through it would land it.
 */
async function driveUntilStopped(
  instanceId: string,
  stuck: (memberId: string) => boolean,
): Promise<void> {
  for (let step = 0; step < 40; step += 1) {
    for (const row of membersOf(instanceId)) {
      const run = dbMod
        .db()
        .prepare("SELECT status FROM runs WHERE id=?")
        .get(row.runId) as { status: string } | undefined;
      if (run?.status !== "queued") continue;
      settleOne(row.runId);
      if (stuck(row.memberId)) {
        dbMod.db().prepare("UPDATE runs SET status='needs-review' WHERE id=?").run(row.runId);
      }
    }
    workflows.advanceInstances();
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (loopBlock(instanceId).status !== "looping") return;
  }
  assert.fail("the loop never stopped");
}

const passTwoOpened = (instanceId: string, entry: string) =>
  workflows.blocksOf(instanceId).some((b) => b.nodeId === passMemberId("L", 2, entry)) ||
  membersOf(instanceId).some((m) => m.memberId === passMemberId("L", 2, entry));

describe("picking up a pass that stopped the loop", () => {
  it("carries on past a run left behind, landing the rest without its branch", async () => {
    // The shape that asked for this: a deciding turn fans out, one of its runs
    // asks for review, and the merge behind them — on-success — never runs.
    const instanceId = scene({
      ...DECIDER,
      edges: [
        { from: "L", to: "o", edge: "repeats" },
        { from: "o", to: "m", edge: "on-success" },
      ],
      maxPasses: 2,
    });
    workflows.advanceInstances();
    decide(instanceId, passMemberId("L", 1, "o"), twoRuns, 0);
    await driveUntilStopped(instanceId, (id) => id.endsWith("#two"));

    assert.equal(loopBlock(instanceId).status, "failed");
    assert.equal(blockRow(instanceId, passMemberId("L", 1, "m")).status, "blocked");
    const two = membersOf(instanceId).find((m) => m.memberId.endsWith("#two"))!;

    assert.deepEqual(workflows.leaveRunBehind(instanceId, two.runId), { ok: true });
    for (let step = 0; step < 40 && !passTwoOpened(instanceId, "o"); step += 1) {
      workflows.advanceInstances();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const merge = workflows.blocksOf(instanceId).find(
      (b) => b.nodeId === passMemberId("L", 1, "m"),
    )!;
    assert.equal(merge.status, "emitted", merge.error ?? "");
    // The fixture's branches carry no commits, so the merge reports each one it
    // was given by name as having nothing to land — which is what shows which
    // runs it resolved to.
    const one = membersOf(instanceId).find((m) => m.memberId.endsWith("#one"))!;
    assert.match(merge.error ?? "", new RegExp(`uf/${one.runId}`));
    assert.doesNotMatch(
      merge.error ?? "",
      new RegExp(`uf/${two.runId}`),
      "the branch of the run left behind was handed to the merge",
    );
    assert.ok(passTwoOpened(instanceId, "o"), "the loop never took its next pass");
    const stillAsked = dbMod
      .db()
      .prepare("SELECT status FROM runs WHERE id=?")
      .get(two.runId) as { status: string };
    assert.equal(stillAsked.status, "needs-review", "the run's own ending is untouched");
  });

  it("carries on once a stuck member is resumed and completes", async () => {
    // The other way through: `reopenRun` wakes what the ending wrote off, and a
    // pass's members and its loop have no node of the graph to be found from.
    const instanceId = scene({ ...FAN_OUT, maxPasses: 2 });
    await driveUntilStopped(instanceId, (id) => id.endsWith("#c"));
    assert.equal(loopBlock(instanceId).status, "failed");

    const c = membersOf(instanceId).find((m) => m.memberId === passMemberId("L", 1, "c"))!;
    dbMod.db().prepare("UPDATE runs SET status='queued' WHERE id=?").run(c.runId);
    assert.ok(workflows.reviveBlockedBlocks([c.runId]) > 0);
    assert.equal(loopBlock(instanceId).status, "looping");
    assert.equal(blockRow(instanceId, passMemberId("L", 1, "m")).status, "waiting");

    for (let step = 0; step < 40 && !passTwoOpened(instanceId, "a"); step += 1) {
      settleQueuedRuns(instanceId);
      workflows.advanceInstances();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(passTwoOpened(instanceId, "a"), "the loop never took its next pass");
  });

  it("retries a merge that failed, and the loop carries on", async () => {
    const instanceId = scene({ ...FAN_OUT, maxPasses: 2 });
    for (let step = 0; step < 40; step += 1) {
      for (const row of membersOf(instanceId)) {
        const run = dbMod
          .db()
          .prepare("SELECT status FROM runs WHERE id=?")
          .get(row.runId) as { status: string } | undefined;
        if (run?.status !== "queued") continue;
        settleOne(row.runId, {
          branch: row.memberId.endsWith("#c") ? "uf/cut-later" : undefined,
        });
      }
      workflows.advanceInstances();
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (loopBlock(instanceId).status !== "looping") break;
    }
    assert.equal(blockRow(instanceId, passMemberId("L", 1, "m")).status, "failed");

    // What an operator does about a branch that was never there: put it there.
    git(repoRoot(), "branch", "-f", "uf/cut-later", "HEAD");
    assert.deepEqual(
      workflows.retryMergeBlock(instanceId, passMemberId("L", 1, "m")),
      { ok: true },
    );
    for (let step = 0; step < 40 && !passTwoOpened(instanceId, "a"); step += 1) {
      workflows.advanceInstances();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(blockRow(instanceId, passMemberId("L", 1, "m")).status, "emitted");
    assert.ok(passTwoOpened(instanceId, "a"), "the loop never took its next pass");
  });

  it("runs a deciding turn again that failed, and the loop carries on", async () => {
    // The pass stopped on its own first member, so the obstacle to name is that
    // block and not the loop — which would stop again on the same sentence. The
    // retried turn is the pass's own claim and adds to the failed turn's bill.
    const instanceId = scene({ ...DECIDER, maxPasses: 1 });
    const member = passMemberId("L", 1, "o");
    workflows.advanceInstances();
    workflows.settleBlock(instanceId, member, {
      status: "failed",
      error: "The CLI exited 1.",
      costUSD: 0.3,
    });
    assert.equal(blockRow(instanceId, member).status, "failed");
    assert.equal(loopBlock(instanceId).status, "failed");

    const offered = workflows.pickUpsOf(workflows.getInstance(instanceId)!);
    assert.deepEqual(
      offered.map((p) => [p.kind, p.kind === "run" ? p.runId : p.nodeId]),
      [["orchestrator", member]],
    );

    assert.deepEqual(workflows.retryOrchestratorBlock(instanceId, member), { ok: true });
    assert.equal(loopBlock(instanceId).status, "looping");
    assert.equal(blockRow(instanceId, member).status, "thinking", "the pass never took its turn back");

    decide(instanceId, member, twoRuns, 0.2);
    await drive(instanceId);
    assert.equal(loopBlock(instanceId).status, "emitted", loopBlock(instanceId).error ?? "");
    assert.equal(loopBlock(instanceId).emitted, 1);
    const turn = workflows.blocksOf(instanceId).find((b) => b.nodeId === member)!;
    assert.ok(Math.abs(turn.costUSD - 0.5) < 1e-9, `the two turns cost ${turn.costUSD}`);
  });

  it("refuses a run that completed, and a loop that ended on its own terms", async () => {
    const instanceId = scene({ ...FAN_OUT, maxPasses: 1 });
    await drive(instanceId);
    assert.equal(loopBlock(instanceId).status, "emitted");
    const a = membersOf(instanceId)[0];
    const refused = workflows.leaveRunBehind(instanceId, a.runId);
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? "" : refused.error, /Only a run that ended without completing/);

    dbMod.db().prepare("UPDATE runs SET status='needs-review' WHERE id=?").run(a.runId);
    const ended = workflows.leaveRunBehind(instanceId, a.runId);
    assert.match(ended.ok ? "" : ended.error, /ended on its own terms/);
    assert.equal(loopBlock(instanceId).status, "emitted", "the refusal wrote nothing");
  });
});

/* ------------------------------------------------------------------ */
/* A block or a spec that is itself called pass-N                      */
/* ------------------------------------------------------------------ */

/** Every run but the ones `scene` parks in the folder, oldest first. */
const instanceRuns = () =>
  dbMod
    .db()
    .prepare("SELECT id FROM runs WHERE id NOT LIKE 'hold-%' ORDER BY created_at")
    .all() as Array<{ id: string }>;

/** Runs no member row names: invisible to a stop, the budget and the caps. */
const orphansOf = (instanceId: string) =>
  instanceRuns().filter((r) => !membersOf(instanceId).some((m) => m.runId === r.id));

describe("a block or a spec named the way a pass is", () => {
  it("creates the member once per pass, and every run it creates is a member", async () => {
    // `pass-2` is a legal block id, and a model drawing a pass-1/pass-2 pair is
    // plausible. Its member id carries the spelling twice, and one advance used
    // to queue 64 runs of which one was a member.
    const instanceId = scene({
      nodes: [node("pass-2"), mergeNode("m")],
      edges: [
        { from: "L", to: "pass-2", edge: "repeats" },
        { from: "pass-2", to: "m", edge: "on-success" },
      ],
      body: ["pass-2", "m"],
      maxPasses: 2,
    });
    workflows.advanceInstances();
    assert.equal(instanceRuns().length, 1);
    assert.deepEqual(orphansOf(instanceId), []);

    await drive(instanceId);
    assert.deepEqual(
      membersOf(instanceId).map((m) => m.memberId),
      [passMemberId("L", 1, "pass-2"), passMemberId("L", 2, "pass-2")],
    );
    assert.deepEqual(orphansOf(instanceId), []);
    assert.equal(loopBlock(instanceId).emitted, 2);
  });

  it("offers the same pick-ups whatever the stuck run's spec is called", async () => {
    // A run an orchestrator member decided on is named `<member>#<spec>`, so a
    // spec called `pass-2` puts the spelling in twice too — and read off the
    // second, the stuck run belonged to no stopped pass and nothing was offered.
    const kinds = async (spec: string) => {
      emptyTables();
      const instanceId = scene({
        ...DECIDER,
        edges: [
          { from: "L", to: "o", edge: "repeats" },
          { from: "o", to: "m", edge: "on-success" },
        ],
        maxPasses: 2,
      });
      workflows.advanceInstances();
      decide(instanceId, passMemberId("L", 1, "o"), [twoRuns[0], { ...twoRuns[1], id: spec }], 0);
      await driveUntilStopped(instanceId, (id) => id.endsWith(`#${spec}`));
      assert.equal(loopBlock(instanceId).status, "failed");
      return workflows.pickUpsOf(workflows.getInstance(instanceId)!).map((p) => p.kind);
    };
    const ordinary = await kinds("fix-tests");
    assert.deepEqual(ordinary, ["run"]);
    assert.deepEqual(await kinds("pass-2"), ordinary);
  });

  it("does not read a top-level orchestrator's run as a pass, whatever its spec is called", () => {
    // Outside every loop the run is named `o#<spec>`, and with a spec called
    // `pass-2` that is the id a body-less loop `o` gave its second pass. Read
    // as one, the stuck run belonged to a stopped pass of a loop that is not
    // there: nothing was offered, and leaving it behind was refused for that
    // loop rather than for anything about the run.
    const stuck = (spec: string) => {
      emptyTables();
      const instanceId = scene({
        nodes: [node("o", { kind: "orchestrator", fanOut: 2, folder: "" }), mergeNode("m")],
        edges: [{ from: "o", to: "m", edge: "on-success" }],
        ownBlocks: [
          { id: "o", kind: "orchestrator" },
          { id: "m", kind: "merge" },
        ],
      });
      workflows.advanceInstances();
      decide(instanceId, "o", [twoRuns[0], { ...twoRuns[1], id: spec }], 0);
      for (const row of membersOf(instanceId)) {
        settleOne(row.runId);
        if (row.memberId === `o#${spec}`) {
          dbMod.db().prepare("UPDATE runs SET status='needs-review' WHERE id=?").run(row.runId);
        }
      }
      workflows.advanceInstances();
      assert.equal(blockRow(instanceId, "m").status, "blocked");
      const instance = workflows.getInstance(instanceId)!;
      return {
        instanceId,
        runId: membersOf(instanceId).find((m) => m.memberId === `o#${spec}`)!.runId,
        kinds: workflows.pickUpsOf(instance).map((p) => p.kind),
      };
    };
    const ordinary = stuck("fix-tests");
    assert.deepEqual(ordinary.kinds, ["run"]);
    const named = stuck("pass-2");
    assert.deepEqual(named.kinds, ordinary.kinds);
    assert.deepEqual(workflows.leaveRunBehind(named.instanceId, named.runId), { ok: true });
  });

  it("does not create a member again once its row exists", () => {
    // The other half of the same runaway: whatever makes a pass's state miss a
    // member it has, `stepPass` must not answer with another run. A member whose
    // run row has gone is the shape real data has that reads that way.
    const instanceId = scene({ ...FAN_OUT, maxPasses: 2 });
    workflows.advanceInstances();
    const [entry] = membersOf(instanceId);
    assert.equal(entry.memberId, passMemberId("L", 1, "a"));
    dbMod.db().prepare("DELETE FROM runs WHERE id=?").run(entry.runId);

    workflows.advanceInstances();
    assert.deepEqual(instanceRuns(), []);
    assert.deepEqual(membersOf(instanceId).map((m) => m.runId), [entry.runId]);
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

/* ------------------------------------------------------------------ */
/* The block behind a loop                                             */
/* ------------------------------------------------------------------ */

describe("a successor of a loop", () => {
  it("is created after the last pass landed, waiting for no run", async () => {
    // A successor of a loop is a successor of a *landing*, exactly as a
    // successor of a merge block is: every pass put its own work on the target
    // through the section's own exit, so there is no branch of its own left and
    // no run to be put behind. Handed the last pass's run it would carry on a
    // ref that pass had already landed and may since have deleted — and with a
    // section that forks there is no last run to hand it.
    const instanceId = scene({
      nodes: [...FAN_OUT.nodes, node("after")],
      edges: [...FAN_OUT.edges, { from: "L", to: "after", edge: "on-success" }],
      body: FAN_OUT.body,
      maxPasses: 2,
      ownBlocks: [{ id: "after", kind: "run" }],
    });

    // Nothing behind the loop while it is still repeating: `looping` is pending
    // rather than settled, because the block can still commit a whole further
    // pass to the folders behind it.
    workflows.advanceInstances();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      membersOf(instanceId).some((m) => m.memberId === "after"),
      false,
      "the successor started between two passes",
    );

    await drive(instanceId);
    assert.equal(loopBlock(instanceId).status, "emitted");
    assert.equal(
      blockRow(instanceId, passMemberId("L", 2, "m")).status,
      "emitted",
      "the last pass landed",
    );

    const successor = membersOf(instanceId).find((m) => m.memberId === "after");
    assert.ok(successor, "the successor was never created");
    assert.deepEqual(depsOf(successor.runId), []);
  });
});

/* ------------------------------------------------------------------ */
/* A loop asked to stop after the pass it is on                        */
/* ------------------------------------------------------------------ */

describe("a loop asked to stop after its pass", () => {
  const withSuccessor = {
    nodes: [...FAN_OUT.nodes, node("after")],
    edges: [...FAN_OUT.edges, { from: "L", to: "after", edge: "on-success" }],
    body: FAN_OUT.body,
    maxPasses: 3,
    ownBlocks: [{ id: "after", kind: "run" }],
  };

  const stopAfterOf = (instanceId: string) =>
    workflows.blocksOf(instanceId).find((b) => b.nodeId === "L")?.stopAfterPass;

  it("lands the pass in flight, starts no more, and hands on as a loop that reached its end", async () => {
    // The column is read in `advanceLoop` and nowhere the pure decision can see:
    // a reader that passed `null` would typecheck, keep every unit case green,
    // and take the pass the operator had refused.
    const instanceId = scene(withSuccessor);
    workflows.advanceInstances();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const outcome = workflows.setLoopStopAfter(instanceId, "L", true);
    assert.deepEqual(outcome, { ok: true, stopAfterPass: 1 });
    assert.equal(stopAfterOf(instanceId), 1);

    // Not a halt: nothing was signalled, nothing written off, and the pass is
    // still the one in flight.
    assert.equal(loopBlock(instanceId).status, "looping");
    for (const member of membersOf(instanceId)) {
      const run = dbMod
        .db()
        .prepare("SELECT status FROM runs WHERE id=?")
        .get(member.runId) as { status: string };
      assert.equal(run.status, "queued", `${member.memberId} was touched`);
    }

    await drive(instanceId);

    // Sorted, because the successor is created at the loop's first advance with
    // a `waiting` row and its position says nothing about the order it ran in.
    assert.deepEqual(
      membersOf(instanceId)
        .map((m) => m.memberId)
        .sort(),
      ["after", ...["a", "b", "c"].map((id) => passMemberId("L", 1, id))].sort(),
      "pass 1 and the block behind the loop, and no pass 2",
    );
    assert.equal(
      blockRow(instanceId, passMemberId("L", 1, "m")).status,
      "emitted",
      "the pass it let finish was landed",
    );
    const loop = loopBlock(instanceId);
    assert.equal(loop.status, "emitted", "a terminus, not a failure");
    assert.match(loop.error ?? "", /stopped after pass 1, as the operator asked/);
  });

  it("carries on as before once the request is taken back", async () => {
    const instanceId = scene({ ...withSuccessor, maxPasses: 2 });
    workflows.advanceInstances();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(workflows.setLoopStopAfter(instanceId, "L", true).ok, true);
    assert.deepEqual(workflows.setLoopStopAfter(instanceId, "L", false), {
      ok: true,
      stopAfterPass: null,
    });
    assert.equal(stopAfterOf(instanceId), null);

    await drive(instanceId);
    assert.match(loopBlock(instanceId).error ?? "", /limit of 2 pass\(es\)/);
  });

  it("is refused once Stop has halted the instance, and the halt stands", async () => {
    const instanceId = scene(withSuccessor);
    workflows.advanceInstances();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const halt = workflows.stopInstance(instanceId, { kind: "operator" });
    assert.ok(halt.ok, halt.ok ? "" : halt.reason);
    const loopBefore = loopBlock(instanceId);
    assert.equal(loopBefore.status, "failed");

    const outcome = workflows.setLoopStopAfter(instanceId, "L", true);
    assert.equal(outcome.ok, false);
    assert.equal(!outcome.ok && outcome.status, 409);
    assert.equal(stopAfterOf(instanceId), null, "a refused request left no record");
    assert.deepEqual(loopBlock(instanceId), loopBefore, "the halt's wording was kept");
  });
});

/* ------------------------------------------------------------------ */
/* A loop that cannot decide while a pass is working                   */
/* ------------------------------------------------------------------ */

/** One entry and the merge that lands it, with a block behind the loop. */
const WITH_SUCCESSOR = {
  nodes: [node("a"), mergeNode("m"), node("after")],
  edges: [
    { from: "L", to: "a", edge: "repeats" },
    { from: "a", to: "m", edge: "on-success" },
    // `on-finish`, the link that is released by a loop that failed: a loop
    // settled mid-pass hands it a folder its pass is still working in.
    { from: "L", to: "after", edge: "on-finish" },
  ],
  body: ["a", "m"],
  ownBlocks: [{ id: "after", kind: "run" }],
};

function finishedAt(instanceId: string, nodeId: string): number | null {
  const row = dbMod
    .db()
    .prepare(
      "SELECT finished_at AS at FROM workflow_instance_blocks WHERE instance_id=? AND node_id=?",
    )
    .get(instanceId, nodeId) as { at: number | null } | undefined;
  assert.ok(row, `no ledger row for ${nodeId}`);
  return row.at;
}

/**
 * Start pass 1, break something only the loop's *decision* reads, and advance
 * with the pass still working — which any terminal run anywhere in the app does.
 */
async function breakMidPass(instanceId: string, breakIt: () => void): Promise<void> {
  workflows.advanceInstances();
  assert.ok(
    membersOf(instanceId).some((m) => m.memberId === passMemberId("L", 1, "a")),
    "pass 1 never started",
  );
  breakIt();
  workflows.advanceInstances();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(
    loopBlock(instanceId).status,
    "looping",
    "the loop was settled on top of a pass that was still working",
  );
  assert.equal(blockRow(instanceId, passMemberId("L", 1, "m")).status, "waiting");
  assert.equal(
    membersOf(instanceId).some((m) => m.memberId === "after"),
    false,
    "the block behind the loop was released while its pass was still working",
  );
}

/**
 * A board condition over a folder beside the repository rather than in it, so
 * taking the folder away touches nothing a member works in — and one open task
 * on it, so "at most none" is not met and pass 1 starts.
 */
function openBoard(): { boardDir: string; stopWhenTasks: NodeBlob } {
  const boardDir = path.join(root, MOUNT_DIR, "board");
  fs.mkdirSync(boardDir, { recursive: true });
  const input = tasks.normalizeTaskInput(
    { title: "Still to do", body: "Work for the loop.", mountId, folder: "board" },
    { origin: "operator", createdByRunId: null },
  );
  if (!input.ok) throw new Error(input.error);
  const filed = tasks.createTask(input.value);
  if (!filed.ok) throw new Error(filed.error);
  return {
    boardDir,
    stopWhenTasks: {
      mountId,
      folder: "board",
      includeSubfolders: false,
      statuses: ["open"],
      thresholds: [{ priority: "any", atMost: 0 }],
    },
  };
}

/** The pass landed first, and the loop ended on `reason` only after it. */
function assertLandedThenFailed(instanceId: string, reason: RegExp): void {
  const merge = passMemberId("L", 1, "m");
  assert.equal(blockRow(instanceId, merge).status, "emitted", "the pass never landed");
  const loop = loopBlock(instanceId);
  assert.equal(loop.status, "failed");
  assert.match(loop.error ?? "", reason);
  const mergedAt = finishedAt(instanceId, merge);
  const failedAt = finishedAt(instanceId, "L");
  assert.ok(
    mergedAt !== null && failedAt !== null && mergedAt <= failedAt,
    "the loop failed before its pass finished landing",
  );
}

/** What an instance blob written before `maxPasses` existed reads back as. */
function dropPassCap(instanceId: string): void {
  const db = dbMod.db();
  const row = db
    .prepare("SELECT graph FROM workflow_instances WHERE id=?")
    .get(instanceId) as { graph: string };
  const graph = JSON.parse(row.graph) as { nodes: NodeBlob[] };
  const loop = graph.nodes.find((n) => n.id === "L");
  assert.ok(loop);
  delete loop.maxPasses;
  db.prepare("UPDATE workflow_instances SET graph=? WHERE id=?").run(
    JSON.stringify(graph),
    instanceId,
  );
}

describe("a loop that cannot decide while a pass is working", () => {
  it("carries the pass to its landing when the board can no longer be counted", async () => {
    const { boardDir, stopWhenTasks } = openBoard();
    const instanceId = scene({ ...WITH_SUCCESSOR, stopWhenTasks });

    // An agent in the pass renamed the folder, or the mount blipped.
    await breakMidPass(instanceId, () => fs.rmSync(boardDir, { recursive: true }));

    await drive(instanceId);
    assertLandedThenFailed(instanceId, /could not be counted/);
  });

  it("carries the pass to its landing when the instance's graph has no pass cap", async () => {
    const instanceId = scene(WITH_SUCCESSOR);
    await breakMidPass(instanceId, () => dropPassCap(instanceId));

    await drive(instanceId);
    assertLandedThenFailed(instanceId, /has no pass cap/);
  });
});

/* ------------------------------------------------------------------ */
/* A pass that already ended the loop, over a board it cannot count    */
/* ------------------------------------------------------------------ */

describe("a pass that ended the loop, with a board that can no longer be counted", () => {
  // `on-success`, the link a failed loop writes off: an unreadable board that
  // failed a loop its own pass had already ended would block this block, and
  // `pickUpsOf` offers nothing for a pass with no blocked member.
  const withSuccessor = {
    ...WITH_SUCCESSOR,
    edges: [
      ...WITH_SUCCESSOR.edges.filter((e) => e.to !== "after"),
      { from: "L", to: "after", edge: "on-success" },
    ],
  };

  /** The loop ended `emitted` on `reason`, and the block behind it was started. */
  function assertEndedOn(instanceId: string, reason: RegExp): void {
    const loop = loopBlock(instanceId);
    assert.equal(loop.status, "emitted", `the loop ended ${loop.status}: ${loop.error}`);
    assert.match(loop.error ?? "", reason);
    assert.ok(
      membersOf(instanceId).some((m) => m.memberId === "after"),
      "the block behind the loop was never created",
    );
  }

  it("ends on DONE, which outranks the board", async () => {
    const { boardDir, stopWhenTasks } = openBoard();
    const instanceId = scene({ ...withSuccessor, stopWhenTasks });
    // An agent in the pass renamed the folder, or the mount blipped.
    await breakMidPass(instanceId, () => fs.rmSync(boardDir, { recursive: true }));
    await drive(instanceId, { done: true });
    assertEndedOn(instanceId, /reported the work complete on pass 1/);
  });

  it("ends as the operator asked, which outranks the board", async () => {
    const { boardDir, stopWhenTasks } = openBoard();
    const instanceId = scene({ ...withSuccessor, stopWhenTasks });
    await breakMidPass(instanceId, () => fs.rmSync(boardDir, { recursive: true }));
    assert.deepEqual(workflows.setLoopStopAfter(instanceId, "L", true), {
      ok: true,
      stopAfterPass: 1,
    });
    await drive(instanceId);
    assertEndedOn(instanceId, /stopped after pass 1, as the operator asked/);
  });

  it("ends at its pass cap, which the board could only have ended sooner", async () => {
    const { boardDir, stopWhenTasks } = openBoard();
    const instanceId = scene({ ...withSuccessor, maxPasses: 1, stopWhenTasks });
    await breakMidPass(instanceId, () => fs.rmSync(boardDir, { recursive: true }));
    await drive(instanceId);
    assertEndedOn(instanceId, /reached its limit of 1 pass\(es\)/);
  });
});

/* ------------------------------------------------------------------ */
/* A loop failed on a board it could not count, once the folder is back */
/* ------------------------------------------------------------------ */

describe("a loop failed on a board that could not be counted, with its pass settled whole", () => {
  // `on-success`, so the loop failing writes the block behind it off — and
  // every member of the pass completed, so nothing is blocked for the older
  // pick-up rule to offer.
  const withSuccessor = {
    ...WITH_SUCCESSOR,
    edges: [
      ...WITH_SUCCESSOR.edges.filter((e) => e.to !== "after"),
      { from: "L", to: "after", edge: "on-success" },
    ],
  };

  /** Pass 1 landed, the board went, and the loop failed on reading it. */
  async function failedOnBoard(): Promise<{ instanceId: string; boardDir: string }> {
    const { boardDir, stopWhenTasks } = openBoard();
    const instanceId = scene({ ...withSuccessor, stopWhenTasks });
    await breakMidPass(instanceId, () => fs.rmSync(boardDir, { recursive: true }));
    await drive(instanceId);
    assertLandedThenFailed(instanceId, /could not be counted/);
    assert.equal(blockRow(instanceId, "after").status, "blocked");
    assert.equal(workflows.getInstance(instanceId)!.status, "blocked");
    return { instanceId, boardDir };
  }

  const loopPickUp = (instanceId: string) =>
    workflows.pickUpsOf(workflows.getInstance(instanceId)!).filter((p) => p.kind === "loop");

  it("offers the loop with the board's sentence while the folder is gone, and none once it is back", async () => {
    const { instanceId, boardDir } = await failedOnBoard();

    const gone = loopPickUp(instanceId);
    assert.equal(gone.length, 1, "nothing on the page to press for a loop the board failed");
    assert.match(gone[0].kind === "loop" ? (gone[0].refusal ?? "") : "", /could not be counted/);
    const refused = workflows.resumeLoop(instanceId, "L");
    assert.equal(refused.ok, false, "the door took a loop whose board still cannot be counted");
    assert.equal(loopBlock(instanceId).status, "failed", "a refusal wrote nothing");

    fs.mkdirSync(boardDir, { recursive: true });
    const back = loopPickUp(instanceId);
    assert.equal(back.length, 1);
    assert.equal(back[0].kind === "loop" ? back[0].refusal : "?", null);
  });

  it("reads the board again when pressed, and takes pass 2 while it is not clear", async () => {
    const { instanceId, boardDir } = await failedOnBoard();
    fs.mkdirSync(boardDir, { recursive: true });

    assert.deepEqual(workflows.resumeLoop(instanceId, "L"), { ok: true });
    assert.equal(loopBlock(instanceId).status, "looping", loopBlock(instanceId).error ?? "");
    assert.equal(blockRow(instanceId, "after").status, "waiting", "the written-off block was not put back");
    assert.equal(
      blockRow(instanceId, passMemberId("L", 2, "m")).status,
      "waiting",
      "pass 2 was never opened",
    );
    assert.ok(
      membersOf(instanceId).some((m) => m.memberId === passMemberId("L", 2, "a")),
      "pass 2's entry was never started",
    );
  });

  it("ends on the board rung when the board is clear by then, and releases the block behind it", async () => {
    const { instanceId, boardDir } = await failedOnBoard();
    fs.mkdirSync(boardDir, { recursive: true });
    dbMod.db().prepare("UPDATE tasks SET status='done'").run();

    assert.deepEqual(workflows.resumeLoop(instanceId, "L"), { ok: true });
    await drive(instanceId);
    const loop = loopBlock(instanceId);
    assert.equal(loop.status, "emitted", loop.error ?? "");
    assert.match(loop.error ?? "", /had at most 0 open task\(s\) left/);
    assert.equal(
      membersOf(instanceId).some((m) => m.memberId === passMemberId("L", 2, "a")),
      false,
      "a pass was billed on a board that was already clear",
    );
    assert.ok(
      membersOf(instanceId).some((m) => m.memberId === "after"),
      "the block behind the loop was never released",
    );
  });
});

/* ------------------------------------------------------------------ */
/* A section that works in the folder throughout                       */
/* ------------------------------------------------------------------ */

/**
 * The other kind of section has no merge block, and nothing in a pass may
 * assume it does: a pass that waited on a merge row to decide it had settled
 * would never settle one with none, and the loop would sit `looping` with every
 * member done. Its members' runs are in-folder ones — no branch, no checkout —
 * so what makes pass 1 visible to pass 2 is that it is already in the folder,
 * and the only thing pass 2 may wait for is pass 1's last member.
 *
 * Driven through `advanceInstances` like the rest of this file, with the guards
 * in Settings set to work in the folder because the fixture's blocks name no
 * template, and put back after: a run's isolation is frozen at creation, so
 * the setting only has to hold while the instance creates its members.
 */
describe("a pass of a section that works in the folder throughout", () => {
  let restore: import("./settings").RunGuards;

  before(async () => {
    const settings = await import("./settings");
    restore = settings.getSettings().chatDefaultGuards;
    settings.saveSettings({ chatDefaultGuards: { ...restore, isolate: false } });
  });

  after(async () => {
    const settings = await import("./settings");
    settings.saveSettings({ chatDefaultGuards: restore });
  });

  const IN_FOLDER = {
    nodes: [node("a"), node("b")],
    edges: [
      { from: "L", to: "a", edge: "repeats" },
      { from: "a", to: "b", edge: "on-success" },
    ],
    body: ["a", "b"],
  };

  it("settles on its last member, takes the next pass, and ends at the cap", async () => {
    const instanceId = scene({ ...IN_FOLDER, maxPasses: 2 });
    await drive(instanceId, { inFolder: true });

    const members = membersOf(instanceId);
    assert.deepEqual(
      members.map((m) => m.memberId),
      [
        ...["a", "b"].map((id) => passMemberId("L", 1, id)),
        ...["a", "b"].map((id) => passMemberId("L", 2, id)),
      ],
      "two passes of the same two blocks, and no block that lands them",
    );
    assert.deepEqual(
      workflows.blocksOf(instanceId).filter((b) => b.kind === "merge"),
      [],
      "a merge row was written for a section that has no merge block",
    );
    for (const member of members) {
      const run = dbMod
        .db()
        .prepare("SELECT isolation FROM runs WHERE id = ?")
        .get(member.runId) as { isolation: string | null };
      assert.equal(run.isolation, "none", `${member.memberId} was created to isolate`);
    }

    // Pass 2 starts only once pass 1's last member is done: the pass settled on
    // its members, with no merge to wait for.
    const lastOfFirst = dbMod
      .db()
      .prepare("SELECT finished_at AS at FROM runs WHERE id = ?")
      .get(members[1].runId) as { at: number };
    const firstOfSecond = dbMod
      .db()
      .prepare("SELECT created_at AS at FROM runs WHERE id = ?")
      .get(members[2].runId) as { at: number };
    assert.ok(
      firstOfSecond.at >= lastOfFirst.at,
      "pass 2 was created before pass 1's last member finished",
    );
    assert.deepEqual(depsOf(members[2].runId), [], "pass 2 waits for nothing");

    const block = loopBlock(instanceId);
    assert.equal(block.status, "emitted");
    assert.match(block.error ?? "", /limit of 2 pass\(es\)/);
  });

  it("stops on DONE like any other section, from its own runs", async () => {
    const instanceId = scene({ ...IN_FOLDER, maxPasses: 5 });
    await drive(instanceId, { inFolder: true, done: true });
    assert.equal(membersOf(instanceId).length, 2, "a second pass was taken after DONE");
    assert.match(loopBlock(instanceId).error ?? "", /reported the work complete on pass 1/);
  });
});

/**
 * A template that works in the folder, made on first use. Every template on a
 * real install isolates, so a block that is to end a pass in the folder has to
 * name one — or sit on guards in Settings that do not isolate, which would
 * take the section's orchestrator with it.
 */
let flatTemplateId: string | null = null;
async function flatTemplate(): Promise<string> {
  if (flatTemplateId !== null) return flatTemplateId;
  const templates = await import("./templates");
  const settings = await import("./settings");
  flatTemplateId = templates.createTemplate({
    name: `In place ${Math.random().toString(36).slice(2)}`,
    prompt: "Work in the folder.",
    mountId: null,
    folder: null,
    isolate: false,
    permissionMode: "acceptEdits",
    agentId: null,
    model: null,
    budget: settings.chatGuards().budget,
  }).id;
  return flatTemplateId;
}

/**
 * A landing section that ends in the folder: a deciding turn whose runs work
 * in checkouts of their own, the merge block that lands them, and one run that
 * works in the folder and ends the pass.
 *
 * What these pin is the premise the tail rule is safe on, which the rule itself
 * cannot say: the run behind the merge is **created only once the merge member
 * has settled**, so nothing lands into the folder while it edits it, and the
 * next pass is created only once that run has too.
 */
describe("a pass of a section that lands, then works in the folder", () => {
  const tailRun = (memberId: string) => /#t$/.test(memberId);

  async function sweep() {
    return {
      nodes: [
        node("o", { kind: "orchestrator", fanOut: 2, folder: "" }),
        mergeNode("m"),
        node("t", { templateId: await flatTemplate() }),
      ],
      edges: [
        { from: "L", to: "o", edge: "repeats" },
        { from: "o", to: "m", edge: "on-finish" },
        { from: "m", to: "t", edge: "on-success" },
      ],
      body: ["o", "m", "t"],
    };
  }

  /**
   * Carry the instance to the end of the loop, deciding each pass's turn and
   * settling every run — the tail's as one that worked in the folder — and
   * reporting every moment that broke the order the rule rests on: the tail run
   * existing while its merge was unsettled, or the next pass opening while the
   * tail run had not finished.
   */
  async function driveSweep(instanceId: string): Promise<string[]> {
    const early: string[] = [];
    for (let step = 0; step < 80; step += 1) {
      settleQueuedRuns(instanceId, { inFolder: tailRun });
      workflows.advanceInstances();
      // In the same turn of the event loop that claimed the turn, which is what
      // makes the spawn `startBlockTurn` has already fired a no-op — see
      // `decide`.
      for (const pass of [1, 2, 3]) {
        const turn = workflows
          .blocksOf(instanceId)
          .find((b) => b.nodeId === passMemberId("L", pass, "o"));
        if (turn?.status === "thinking") {
          decide(instanceId, passMemberId("L", pass, "o"), twoRuns, 0);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      for (const pass of [1, 2, 3]) {
        const merge = workflows
          .blocksOf(instanceId)
          .find((b) => b.nodeId === passMemberId("L", pass, "m"));
        const tail = membersOf(instanceId).some(
          (m) => m.memberId === passMemberId("L", pass, "t"),
        );
        if (merge && ["waiting", "thinking"].includes(merge.status) && tail) {
          early.push(`pass ${pass}: the tail run exists while the merge is ${merge.status}`);
        }
      }
      // The next pass is opened — its rows written — only once this one has
      // settled, and the flat run is part of it.
      for (const pass of [2, 3]) {
        const opened = workflows
          .blocksOf(instanceId)
          .some((b) => b.nodeId.startsWith(passMemberId("L", pass, "")));
        const before = membersOf(instanceId).find(
          (m) => m.memberId === passMemberId("L", pass - 1, "t"),
        );
        const status = before
          ? (
              dbMod.db().prepare("SELECT status FROM runs WHERE id=?").get(before.runId) as {
                status: string;
              }
            ).status
          : null;
        if (opened && status !== "completed") {
          early.push(`pass ${pass} opened while pass ${pass - 1}'s flat run was ${status}`);
        }
      }
      if (!["looping", "waiting"].includes(loopBlock(instanceId).status)) return early;
    }
    assert.fail("the loop never stopped");
  }

  it("takes two passes to the cap, the flat run ending each", async () => {
    const instanceId = scene({ ...(await sweep()), maxPasses: 2 });
    const early = await driveSweep(instanceId);
    assert.deepEqual(early, [], "a block of the pass ran out of order");

    const tails = membersOf(instanceId).filter((m) => tailRun(m.memberId));
    assert.deepEqual(
      tails.map((m) => m.memberId),
      [passMemberId("L", 1, "t"), passMemberId("L", 2, "t")],
      "one flat run a pass, and no third pass",
    );
    for (const pass of [1, 2]) {
      assert.equal(blockRow(instanceId, passMemberId("L", pass, "m")).status, "emitted");
    }
    const block = loopBlock(instanceId);
    assert.equal(block.status, "emitted");
    assert.match(block.error ?? "", /limit of 2 pass\(es\)/);
  });

  it("creates the flat run only after the merge member has settled, working in the folder", async () => {
    const instanceId = scene({ ...(await sweep()), maxPasses: 2 });
    await driveSweep(instanceId);

    for (const pass of [1, 2]) {
      const merge = dbMod
        .db()
        .prepare(
          "SELECT finished_at AS at FROM workflow_instance_blocks WHERE instance_id=? AND node_id=?",
        )
        .get(instanceId, passMemberId("L", pass, "m")) as { at: number | null };
      const tail = membersOf(instanceId).find(
        (m) => m.memberId === passMemberId("L", pass, "t"),
      )!;
      const run = dbMod
        .db()
        .prepare("SELECT created_at AS at, isolation FROM runs WHERE id=?")
        .get(tail.runId) as { at: number; isolation: string | null };
      assert.ok(merge.at !== null, `pass ${pass}'s merge never settled`);
      assert.ok(
        run.at >= merge.at,
        `pass ${pass}'s flat run was created before its merge settled`,
      );
      assert.equal(run.isolation, "none", "the tail run was created to isolate");
      // And it waits for no run: the merge block is what it is behind.
      assert.deepEqual(depsOf(tail.runId), []);
    }
  });
});

/**
 * What a press of Run asks of the disk, for each kind of section.
 *
 * A landing section's run members each need a worktree, and a folder that
 * cannot have one — a plain directory here — refuses the press by name. An
 * in-folder section's members cut no branch, so asking the disk for one would
 * refuse a press that has nothing wrong with it: the folder is where the work
 * is to happen, and `folderRefusal` has already said it is there.
 */
describe("a press of Run on a section, in a folder that is not a repository", () => {
  let restore: import("./settings").RunGuards;
  let orch: typeof import("./orchestrator");

  before(async () => {
    fs.mkdirSync(path.join(root, MOUNT_DIR, "plain"), { recursive: true });
    orch = await import("./orchestrator");
    const settings = await import("./settings");
    restore = settings.getSettings().chatDefaultGuards;
    // A press of Run reads a usage snapshot, and one that asked the provider
    // would be a network call from a test.
    settings.saveSettings({ planUsageFromApi: false });
  });

  after(async () => {
    const settings = await import("./settings");
    settings.saveSettings({ chatDefaultGuards: restore });
  });

  /** A saved workflow of `loop → a → rest…`, every block in `folder`. */
  function saved(
    rest: Array<Record<string, unknown>>,
    folder: string,
    first: Record<string, unknown> = {},
  ) {
    const flow = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      name: `Block ${id}`,
      mountId,
      folder,
      task: `${id} the thing`,
      ...extra,
    });
    const nodes = [
      { id: "L", name: "Loop", kind: "loop", maxPasses: 2 },
      flow("a", first),
      ...rest.map((r) => flow(r.id as string, r)),
    ];
    const ids = nodes.slice(1).map((n) => n.id as string);
    const edges = [
      { from: "L", to: "a", edge: "repeats", continueBranch: false },
      ...ids.slice(1).map((id, i) => ({
        from: ids[i],
        to: id,
        edge: "on-success",
        continueBranch: false,
      })),
    ];
    const parsed = workflows.normalizeWorkflowInput(
      { name: `Section ${Math.random()}`, instanceBudget: null, graph: { nodes, edges } },
      workflows.currentKnowledge(),
    );
    if (!parsed.ok) throw new Error(parsed.error);
    return workflows.createWorkflow(parsed.value);
  }

  /** One run holding the only slot, so nothing a press creates is spawned. */
  function holdTheSlot(): void {
    const now = Date.now();
    dbMod
      .db()
      .prepare(
        `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                           created_at, started_at, work_dir)
         VALUES (?, ?, 'hold the slot', 'running',
                 '{"maxIterations":1,"permissionMode":"acceptEdits"}', 1, 0, ?, ?, NULL)`,
      )
      .run(`hold-slot-${now}`, repoRoot(), now, now);
  }

  const setIsolate = async (isolate: boolean) => {
    const settings = await import("./settings");
    settings.saveSettings({ chatDefaultGuards: { ...restore, isolate } });
  };

  it("lets an in-folder section through: its members need no worktree", async () => {
    await setIsolate(false);
    holdTheSlot();
    const workflow = saved([{ id: "b" }], "plain");
    const started = workflows.startWorkflow(workflow.id, await orch.currentSnapshot());
    assert.ok(started.ok, `refused: ${!started.ok && started.reason}`);
  });

  it("still asks a landing section's run members for one", async () => {
    await setIsolate(true);
    holdTheSlot();
    const workflow = saved(
      [{ id: "m", name: "Land", kind: "merge", mergeStrategy: "merge", folder: "", mountId: "" }],
      "plain",
    );
    const started = workflows.startWorkflow(workflow.id, await orch.currentSnapshot());
    assert.equal(started.ok, false, "pressed a landing section in a folder with no repository");
    assert.match(
      !started.ok ? started.reason : "",
      /“Block a” is repeated, and every pass has to land what it produced, which needs a checkout of its own/,
    );
  });

  it("does not ask the in-folder tail of a landing section for one", async () => {
    // The head cuts branches and lands them; the run behind the merge works in
    // the folder and cuts none, so a folder that cannot have a worktree is as
    // good a place for it as any. The head here is an orchestrator, which the
    // probe never asks, so the tail run is the only block of this section it
    // could refuse.
    await setIsolate(true);
    holdTheSlot();
    const workflow = saved(
      [
        { id: "m", name: "Land", kind: "merge", mergeStrategy: "merge", folder: "", mountId: "" },
        { id: "t", templateId: await flatTemplate() },
      ],
      "plain",
      { kind: "orchestrator", fanOut: 2 },
    );
    const started = workflows.startWorkflow(workflow.id, await orch.currentSnapshot());
    assert.ok(started.ok, `refused: ${!started.ok && started.reason}`);
  });

  it("still refuses an in-folder section whose folder is not there", async () => {
    await setIsolate(false);
    holdTheSlot();
    const workflow = saved([{ id: "b" }], "gone");
    const started = workflows.startWorkflow(workflow.id, await orch.currentSnapshot());
    assert.equal(started.ok, false);
    assert.doesNotMatch(!started.ok ? started.reason : "", /checkout of its own/);
    assert.match(!started.ok ? started.reason : "", /gone|No such folder/);
  });
});

/* ------------------------------------------------------------------ */
/* A loop failed before it had a pass, and one with no cap to count by */
/* ------------------------------------------------------------------ */

describe("a loop that failed before its first pass", () => {
  // A block in front of the loop, so pass 1's entry has something to start
  // after, and an `on-success` block behind it for the failure to write off.
  const withPredecessor = {
    nodes: [node("before"), node("a"), mergeNode("m"), node("after")],
    edges: [
      { from: "before", to: "L", edge: "on-success", continueBranch: true },
      { from: "L", to: "a", edge: "repeats" },
      { from: "a", to: "m", edge: "on-success" },
      { from: "L", to: "after", edge: "on-success" },
    ],
    body: ["a", "m"],
    ownBlocks: [
      { id: "before", kind: "run" },
      { id: "after", kind: "run" },
    ],
  };

  const loopPickUp = (instanceId: string) =>
    workflows.pickUpsOf(workflows.getInstance(instanceId)!).filter((p) => p.kind === "loop");

  /** The folder is gone before the loop is released, so no pass is ever opened. */
  async function failedOnBoard(): Promise<{ instanceId: string; boardDir: string }> {
    const { boardDir, stopWhenTasks } = openBoard();
    const instanceId = scene({ ...withPredecessor, stopWhenTasks });
    fs.rmSync(boardDir, { recursive: true });
    await drive(instanceId);

    const loop = loopBlock(instanceId);
    assert.equal(loop.status, "failed");
    assert.match(loop.error ?? "", /could not be counted/);
    assert.equal(
      membersOf(instanceId).some((m) => m.memberId === passMemberId("L", 1, "a")),
      false,
      "a pass was opened on a board that could not be counted",
    );
    assert.equal(blockRow(instanceId, "after").status, "blocked");
    assert.equal(workflows.getInstance(instanceId)!.status, "blocked");
    return { instanceId, boardDir };
  }

  it("offers the loop with the board's sentence while the folder is gone, and none once it is back", async () => {
    const { instanceId, boardDir } = await failedOnBoard();

    const gone = loopPickUp(instanceId);
    assert.equal(gone.length, 1, "nothing on the page to press for a loop with no pass");
    assert.match(gone[0].kind === "loop" ? (gone[0].refusal ?? "") : "", /could not be counted/);
    const refused = workflows.resumeLoop(instanceId, "L");
    assert.equal(refused.ok, false, "the door took a loop whose board still cannot be counted");
    assert.equal(loopBlock(instanceId).status, "failed", "a refusal wrote nothing");
    assert.equal(blockRow(instanceId, "after").status, "blocked", "a refusal wrote nothing");

    fs.mkdirSync(boardDir, { recursive: true });
    const back = loopPickUp(instanceId);
    assert.equal(back.length, 1);
    assert.equal(back[0].kind === "loop" ? back[0].refusal : "?", null);
  });

  it("starts pass 1 behind what released the loop, and puts the block behind it back", async () => {
    const { instanceId, boardDir } = await failedOnBoard();
    fs.mkdirSync(boardDir, { recursive: true });

    assert.deepEqual(workflows.resumeLoop(instanceId, "L"), { ok: true });
    assert.equal(loopBlock(instanceId).status, "looping", loopBlock(instanceId).error ?? "");
    assert.equal(blockRow(instanceId, "after").status, "waiting", "the written-off block was not put back");
    const entry = membersOf(instanceId).find((m) => m.memberId === passMemberId("L", 1, "a"));
    assert.ok(entry, "pass 1's entry was never started");

    // Carried by the loop's release, which is why the loop goes back to
    // `waiting` rather than to `looping`: put straight to `looping`, pass 1's
    // entry would start after nothing, on a fresh branch off the base.
    const before = membersOf(instanceId).find((m) => m.memberId === "before");
    assert.ok(before, "the block in front of the loop has no run");
    assert.deepEqual(
      depsOf(entry.runId).map((d) => [d.dependsOn, d.edge, d.continueBranch]),
      [[before.runId, "on-success", 1]],
    );
  });

  it("ends on the board rung when the board is clear by then, billing no pass", async () => {
    const { instanceId, boardDir } = await failedOnBoard();
    fs.mkdirSync(boardDir, { recursive: true });
    dbMod.db().prepare("UPDATE tasks SET status='done'").run();

    // Nothing advances it again here, as nothing would in a quiet app: the press
    // alone has to release the block behind the loop.
    assert.deepEqual(workflows.resumeLoop(instanceId, "L"), { ok: true });
    const loop = loopBlock(instanceId);
    assert.equal(loop.status, "emitted", loop.error ?? "");
    assert.match(loop.error ?? "", /had at most 0 open task\(s\) left/);
    assert.equal(
      membersOf(instanceId).some((m) => m.memberId === passMemberId("L", 1, "a")),
      false,
      "a pass was billed on a board that was already clear",
    );
    assert.ok(
      membersOf(instanceId).some((m) => m.memberId === "after"),
      "the block behind the loop was never released",
    );
  });

  it("is not offered when the loop repeats no section, which would fail the same way again", async () => {
    // A graph saved when a loop held a task of its own and repeated that.
    const instanceId = scene({
      nodes: [node("after")],
      edges: [{ from: "L", to: "after", edge: "on-success" }],
      body: [],
      ownBlocks: [{ id: "after", kind: "run" }],
    });
    await drive(instanceId);

    assert.equal(loopBlock(instanceId).status, "failed");
    assert.match(loopBlock(instanceId).error ?? "", /repeats no section/);
    assert.deepEqual(loopPickUp(instanceId), []);
  });

  it("is refused the press too, which would otherwise be answered ok and fail again", async () => {
    const instanceId = scene({
      nodes: [node("after")],
      edges: [{ from: "L", to: "after", edge: "on-success" }],
      body: [],
      ownBlocks: [{ id: "after", kind: "run" }],
    });
    await drive(instanceId);
    workflows.advanceInstances();
    assert.deepEqual(loopPickUp(instanceId), [], "the page offers nothing for this loop");

    const refused = workflows.resumeLoop(instanceId, "L");
    assert.equal(refused.ok, false, "the press was answered ok by a loop the page offers nothing for");
    assert.equal(refused.ok === false ? refused.status : null, 409);
    assert.match(refused.ok === false ? refused.error : "", /repeats no section/);
    assert.equal(loopBlock(instanceId).status, "failed");
    assert.equal(blockRow(instanceId, "after").status, "blocked", "a refusal wrote nothing");
    const notes = workflows.blocksOf(instanceId).find((b) => b.nodeId === "L")!.notes;
    assert.deepEqual(
      notes.filter((n) => /Picked up/.test(n)),
      [],
      "a refused press left a note saying it had carried the loop on",
    );
  });
});

describe("a loop that settles at its own release", () => {
  // Nothing in front of the loop, so the first advance is also the release, and
  // an `on-success` block behind it that the loop's ending decides.
  const behindTheLoop = {
    nodes: [node("a"), mergeNode("m"), node("after")],
    edges: [
      { from: "L", to: "a", edge: "repeats" },
      { from: "a", to: "m", edge: "on-success" },
      { from: "L", to: "after", edge: "on-success" },
    ],
    body: ["a", "m"],
    ownBlocks: [{ id: "after", kind: "run" }],
  };

  const startedPassOne = (instanceId: string) =>
    membersOf(instanceId).some((m) => m.memberId === passMemberId("L", 1, "a"));

  // One advance and no more: in a quiet app nothing else makes the next one, so
  // what is behind the loop has to be decided by the advance that settled it.
  it("creates the block behind it in the same advance when the board is already clear", () => {
    const { stopWhenTasks } = openBoard();
    dbMod.db().prepare("UPDATE tasks SET status='done'").run();
    const instanceId = scene({ ...behindTheLoop, stopWhenTasks });

    workflows.advanceInstances();

    const loop = loopBlock(instanceId);
    assert.equal(loop.status, "emitted", loop.error ?? "");
    assert.match(loop.error ?? "", /had at most 0 open task\(s\) left/);
    assert.equal(startedPassOne(instanceId), false, "a pass was billed on a clear board");
    assert.ok(
      membersOf(instanceId).some((m) => m.memberId === "after"),
      "the block behind a settled loop waited for an advance nothing would make",
    );
    assert.equal(workflows.getInstance(instanceId)!.status, "started");
  });

  it("writes the block behind it off in the same advance when its board folder is gone", () => {
    const { boardDir, stopWhenTasks } = openBoard();
    const instanceId = scene({ ...behindTheLoop, stopWhenTasks });
    fs.rmSync(boardDir, { recursive: true });

    workflows.advanceInstances();

    const loop = loopBlock(instanceId);
    assert.equal(loop.status, "failed");
    assert.match(loop.error ?? "", /could not be counted/);
    assert.equal(startedPassOne(instanceId), false, "a pass was opened on a board that could not be counted");
    assert.equal(
      blockRow(instanceId, "after").status,
      "blocked",
      "the block behind a failed loop was left waiting for the next advance",
    );
    assert.equal(workflows.getInstance(instanceId)!.status, "blocked");
  });

  it("leaves the block behind a loop that took a pass waiting, however often it is advanced", () => {
    // The converse, and what keeps the re-plan from being a spin: a loop that is
    // still repeating settled nothing, so nothing behind it may move.
    const { stopWhenTasks } = openBoard();
    const instanceId = scene({ ...behindTheLoop, stopWhenTasks });

    workflows.advanceInstances();
    workflows.advanceInstances();

    assert.equal(loopBlock(instanceId).status, "looping");
    assert.equal(startedPassOne(instanceId), true);
    assert.equal(blockRow(instanceId, "after").status, "waiting");
    assert.equal(
      membersOf(instanceId).filter((m) => m.memberId === passMemberId("L", 1, "a")).length,
      1,
      "pass 1's entry was created more than once",
    );
  });
});

describe("a loop failed on a missing pass cap, with its pass settled whole", () => {
  /** Pass 1 landed, and the loop then failed on a graph that carries no cap. */
  async function failedOnCap(): Promise<string> {
    const instanceId = scene({
      ...WITH_SUCCESSOR,
      edges: [
        ...WITH_SUCCESSOR.edges.filter((e) => e.to !== "after"),
        { from: "L", to: "after", edge: "on-success" },
      ],
    });
    await breakMidPass(instanceId, () => dropPassCap(instanceId));
    await drive(instanceId);
    assertLandedThenFailed(instanceId, /has no pass cap/);
    assert.equal(blockRow(instanceId, "after").status, "blocked");
    return instanceId;
  }

  it("offers the loop with the missing cap as its refusal, and the press writes nothing", async () => {
    const instanceId = await failedOnCap();

    const offered = workflows
      .pickUpsOf(workflows.getInstance(instanceId)!)
      .filter((p) => p.kind === "loop");
    assert.equal(offered.length, 1);
    assert.match(offered[0].kind === "loop" ? (offered[0].refusal ?? "") : "", /has no pass cap/);

    const refused = workflows.resumeLoop(instanceId, "L");
    assert.equal(refused.ok, false, "the press was answered ok by a loop that cannot take a pass");
    assert.equal(loopBlock(instanceId).status, "failed", "a refusal wrote nothing");
    assert.equal(blockRow(instanceId, "after").status, "blocked", "a refusal wrote nothing");
  });
});
