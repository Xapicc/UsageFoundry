import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * A loop that repeats a **section** of blocks, driven through the real creation
 * path rather than asserted about.
 *
 * `planPass` and `groupPasses` are unit-tested in `workflows.test.ts`, and they
 * are the decisions. This is the wiring between them and `createRun`, which is
 * the half neither of those can reach and where every mistake is silent:
 *
 *   - The member index a plan states has to become the run id that member's
 *     predecessor was actually given. Substituted wrongly, a pass is a set of
 *     unrelated runs on one folder and the section runs in whatever order the
 *     queue happens to admit — which looks exactly like a section that ran.
 *   - The chain has to close across the pass boundary onto the **last** run of
 *     the pass before, not the first. Wired to the first, every pass after the
 *     second builds on a branch missing the work of the one before it, and
 *     nothing anywhere reports a fault.
 *   - The member ids have to carry their pass, because `loopPasses` reads the
 *     pass count back out of them. Six rows read as six passes trips a cap of
 *     three after one pass and records it as the loop running out.
 *   - A pass that fails half way must not be left as a smaller pass.
 *
 * And the compatibility rule of the whole feature — an empty body is exactly
 * today's loop — is a claim about a graph blob written by an **older build**,
 * which has no `bodyNodeIds` key at all. That is unreachable from a graph this
 * build normalizes, so the instance here is written the way that build wrote
 * one: straight into the table, with the key absent.
 *
 * The instance rows are inserted rather than instantiated because
 * `startWorkflow` probes the disk for a real git worktree on every block of a
 * body, and this file is about what happens *after* a loop is released. Nothing
 * here spawns: `CLAUDE_BIN` names a file that does not exist, so a regression
 * that reached a spawn is a failed test rather than a billed one.
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
/**
 * Guards that work directly in the folder, for the one case that needs a
 * member held at `queued`.
 *
 * A member whose guards isolate takes a checkout of its own, which is what lets
 * it be released past the run holding the folder — and a released member is
 * `running`, where a stop is the kill ladder and lands asynchronously. Working
 * in the folder is what makes it conflict, stay queued, and be stopped
 * synchronously, which is the only way to read the rollback in one turn.
 * `graphRefusal` refuses this shape at save; the rollback is about a folder
 * that has gone, and is orthogonal to it.
 */
let flatTemplateId: string;

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

  // A real repository with a commit on it, because a pass carries on the branch
  // the one before it built: `createRun` resolves isolation against the disk,
  // and a plain directory gets none — after which the second member's
  // hand-over is refused by name, which is the right refusal about the wrong
  // thing.
  const repo = path.join(root, MOUNT_DIR, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");

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
  const templates = await import("./templates");
  const budget = await import("./budget");
  flatTemplateId = templates.createTemplate({
    name: "In place",
    prompt: "",
    mountId,
    folder: "repo",
    isolate: false,
    permissionMode: "acceptEdits",
    agentId: null,
    model: null,
    budget: budget.normalizePolicy({ maxIterations: 1 }),
  }).id;
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

/** A run block of a body, with everything a saved graph carries filled in. */
function member(id: string, folder = "repo", templateId: string | null = null) {
  return {
    id,
    name: id === "plan" ? "Plan it" : "Do it",
    kind: "run",
    templateId,
    mountId,
    folder,
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
  };
}

/**
 * A started instance holding one loop, its body, and a merge block behind it.
 *
 * The body members get **no rows of their own**, which is what instantiation
 * does with them: their work happens once per pass under the loop's
 * `emitted_by`, so the loop's ledger row is their record.
 */
function scene(opts: {
  /** Absent means the key is not written at all — an older build's graph. */
  body?: string[];
  maxPasses?: number;
  /** The folder each body member runs in, by id. */
  folders?: Record<string, string>;
  /** When set, every member works directly in the folder. See `flatTemplateId`. */
  flat?: boolean;
}): string {
  const now = Date.now();
  const instanceId = `inst-${now}-${Math.random().toString(36).slice(2)}`;
  const loop: Record<string, unknown> = {
    ...member("plan"),
    id: "L",
    name: "Chip away",
    kind: "loop",
    maxPasses: opts.maxPasses ?? 3,
  };
  if (opts.body) loop.bodyNodeIds = opts.body;
  else delete loop.bodyNodeIds;

  const nodes: Record<string, unknown>[] = [loop];
  const edges: Record<string, unknown>[] = [];
  for (const [index, id] of (opts.body ?? []).entries()) {
    nodes.push(
      member(id, opts.folders?.[id] ?? "repo", opts.flat ? flatTemplateId : null),
    );
    if (index > 0) {
      edges.push({
        from: opts.body![index - 1],
        to: id,
        edge: "on-success",
        continueBranch: true,
      });
    }
  }
  const graph = JSON.stringify({ nodes, edges });

  const db = dbMod.db();
  // Something already working in `repo`, so every run this instance creates
  // stays `queued`. Nothing here is about admission: releasing a member would
  // have it build a checkout and spawn an agent, and `CLAUDE_BIN` names a file
  // that does not exist — so a released member fails asynchronously, some
  // milliseconds later, and rewrites the status this file just set. Occupancy
  // is the one lever that holds every member at creation, which is the moment
  // this file is about.
  db.prepare(
    `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                       created_at, started_at, work_dir)
     VALUES (?, ?, 'hold the folder', 'running', '{"maxIterations":1,"permissionMode":"acceptEdits"}',
             1, 0, ?, ?, NULL)`,
  ).run(`hold-${instanceId}`, path.join(root, MOUNT_DIR, "repo"), now, now);
  db.prepare(
    "INSERT INTO workflows (id, name, graph, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(`wf-${instanceId}`, "Nightly", graph, now, now);
  db.prepare(
    `INSERT INTO workflow_instances (id, workflow_id, workflow_name, graph, created_at, status)
     VALUES (?, ?, ?, ?, ?, 'started')`,
  ).run(instanceId, `wf-${instanceId}`, "Nightly", graph, now);
  db.prepare(
    "INSERT INTO workflow_instance_blocks (instance_id, node_id, node_name, position, kind, status)" +
      " VALUES (?, 'L', 'Chip away', 0, 'loop', 'waiting')",
  ).run(instanceId);
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

/**
 * Settle every run of the instance as one that worked on its branch.
 *
 * The status alone is not enough and the difference is the reason this helper
 * exists: a run's branch columns are filled in when it is **released**, and
 * nothing here releases anything — `CLAUDE_BIN` names a file that does not
 * exist, so a member admitted for real would fail at the spawn. The next pass
 * is created against the last run of this one and `resolveIsolation` refuses a
 * hand-over from a run with no branch, so a pass settled by status alone would
 * stop the loop with a sentence about isolation rather than unrolling.
 *
 * What is written here is exactly what that release would have written. The
 * subject of this file is the wiring between `planPass` and `createRun` — the
 * member ids, the dependency rows and which run each pass continues — and the
 * worktree mechanics behind those columns are `isolation-and-landing.md`'s and
 * are covered where they are decided.
 */
function completeEveryRun(instanceId: string): void {
  const repoRoot = path.join(root, MOUNT_DIR, "repo");
  const base = git(repoRoot, "rev-parse", "HEAD").trim();
  for (const row of membersOf(instanceId)) {
    dbMod
      .db()
      .prepare(
        `UPDATE runs SET status='completed', iterations=1, finished_at=?,
                         isolation='worktree', repo_root=?, worktree_path=?,
                         worktree_branch=?, worktree_base=?
          WHERE id=? AND status<>'completed'`,
      )
      .run(
        Date.now(),
        repoRoot,
        path.join(root, "worktrees", row.runId),
        // One branch for the whole chain, which is what a pass continuing a
        // pass produces: each run adopts the branch of the run in front of it.
        "uf/section",
        base,
        row.runId,
      );
  }
}

function loopBlock(instanceId: string): {
  status: string;
  emitted: number;
  error: string | null;
} {
  const block = workflows.blocksOf(instanceId).find((b) => b.nodeId === "L");
  assert.ok(block, "the fixture's loop block has gone");
  return { status: block.status, emitted: block.emitted, error: block.error };
}

/* ------------------------------------------------------------------ */
/* One pass of a section                                               */
/* ------------------------------------------------------------------ */

describe("a loop that repeats a section", () => {
  it("creates one run per body block, and none for the loop itself", () => {
    const instanceId = scene({ body: ["plan", "do"] });
    workflows.advanceInstances();

    const rows = membersOf(instanceId);
    assert.deepEqual(
      rows.map((r) => [r.memberId, r.nodeName, r.emittedBy]),
      [
        ["L#pass-1#plan", "Plan it — pass 1", "L"],
        ["L#pass-1#do", "Do it — pass 1", "L"],
      ],
    );
    // Named for the member rather than for the loop: a pass of a section is
    // several rows on the instance page, and "Chip away — pass 1" twice over
    // says nothing about which of them is which.
    assert.equal(loopBlock(instanceId).status, "looping");
  });

  it("chains the members of one pass onto a single branch", () => {
    const instanceId = scene({ body: ["plan", "do"] });
    workflows.advanceInstances();

    const [first, second] = membersOf(instanceId);
    assert.deepEqual(depsOf(first.runId), []);
    assert.deepEqual(depsOf(second.runId), [
      { dependsOn: first.runId, edge: "on-success", continueBranch: 1 },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Three passes of a two-block body                                    */
/* ------------------------------------------------------------------ */

describe("a two-block body unrolled over three passes", () => {
  it("is one chain of six runs, each pass continuing the last run of the last", () => {
    const instanceId = scene({ body: ["plan", "do"], maxPasses: 3 });
    for (const _ of [1, 2, 3]) {
      workflows.advanceInstances();
      completeEveryRun(instanceId);
    }

    const rows = membersOf(instanceId);
    assert.deepEqual(
      rows.map((r) => r.memberId),
      [
        "L#pass-1#plan",
        "L#pass-1#do",
        "L#pass-2#plan",
        "L#pass-2#do",
        "L#pass-3#plan",
        "L#pass-3#do",
      ],
    );

    // Every run after the first continues exactly the one in front of it in
    // that list — inside a pass and across the boundary alike. That is the
    // whole of "one branch, all the passes": a successor released on the last
    // run is released on all six, and `land.ts` sees one ref with one owner.
    for (const [index, row] of rows.entries()) {
      const deps = depsOf(row.runId);
      if (index === 0) {
        assert.deepEqual(deps, [], row.memberId);
        continue;
      }
      assert.deepEqual(
        deps,
        [
          {
            dependsOn: rows[index - 1].runId,
            edge: "on-success",
            continueBranch: 1,
          },
        ],
        row.memberId,
      );
    }
  });

  it("counts passes rather than runs, and stops at the pass cap", () => {
    const instanceId = scene({ body: ["plan", "do"], maxPasses: 3 });
    // A fourth advance, which is what would take pass 4 if the cap were read in
    // runs: six rows against a cap of three is already past it.
    for (const _ of [1, 2, 3, 4]) {
      workflows.advanceInstances();
      completeEveryRun(instanceId);
    }

    assert.equal(membersOf(instanceId).length, 6);
    const block = loopBlock(instanceId);
    assert.equal(block.emitted, 3, "the block's count is passes, not runs");
    assert.equal(block.status, "emitted");
    assert.match(block.error ?? "", /3 pass/);
  });
});

/* ------------------------------------------------------------------ */
/* A pass that could not be created in full                            */
/* ------------------------------------------------------------------ */

describe("a pass that fails half way", () => {
  it("stops what it created rather than running half a section", () => {
    // The second member's folder is not on disk, so its `createRun` throws
    // after the first member's has already claimed a folder. A section is one
    // piece: its first block run without its second is a branch left in a state
    // nobody asked for, with the block that would have finished it never made.
    const instanceId = scene({
      body: ["plan", "do"],
      folders: { do: "no-such-folder" },
      flat: true,
    });
    workflows.advanceInstances();

    const rows = membersOf(instanceId);
    assert.equal(rows.length, 1, "only the first member was created");
    const status = dbMod
      .db()
      .prepare("SELECT status FROM runs WHERE id = ?")
      .get(rows[0].runId) as { status: string };
    assert.equal(status.status, "stopped");

    const block = loopBlock(instanceId);
    assert.equal(block.status, "failed");
    assert.match(block.error ?? "", /Pass 1 could not be started/);
    assert.match(block.error ?? "", /1 run\(s\) of it already created were stopped/);
  });
});

/* ------------------------------------------------------------------ */
/* The compatibility rule                                              */
/* ------------------------------------------------------------------ */

describe("a loop saved before a body was a thing", () => {
  it("repeats its own task, one run per pass, from a graph with no such key", () => {
    // The instance blob is what an older build wrote: no `bodyNodeIds` at all,
    // which is `undefined` rather than `[]` and throws on any read that does
    // not go through `bodyOf`. Nothing about that fails to typecheck, because
    // the type says the field is there and the build that wrote the row agreed.
    const instanceId = scene({ maxPasses: 2 });
    workflows.advanceInstances();
    completeEveryRun(instanceId);
    workflows.advanceInstances();

    assert.deepEqual(
      membersOf(instanceId).map((r) => [r.memberId, r.nodeName]),
      [
        ["L#pass-1", "Chip away — pass 1"],
        ["L#pass-2", "Chip away — pass 2"],
      ],
    );
    assert.equal(loopBlock(instanceId).emitted, 2);
  });
});
