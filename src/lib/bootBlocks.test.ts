import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type Database from "better-sqlite3";

/**
 * Covers one thing: which unsettled blocks a restart closes out, and the same
 * question asked of a run waiting on another run (the last describe below).
 *
 * `reconcileOnBoot` keeps a run that is `paused` inside `resumeGraceHours`,
 * because it is a run the operator started in a mode chosen precisely so it
 * would carry on across a restart. `reconcileBlocksOnBoot` then used to write
 * *every* `waiting` block `blocked`, so the tail of that run's own workflow was
 * destroyed by the same boot that went out of its way to preserve its head —
 * and the sentence recorded on the row said the block in front of it "was
 * closed out by the same restart", which was a statement about a run that was
 * still parked and about to resume.
 *
 * The `looping` sweep in the same function asked no such question for longer,
 * and the parked run there is the loop's own current pass: the row went
 * `failed`, `advanceLoops` selects `looping` so no further pass was ever
 * created, and `loopVerdict`'s `failed` arm then wrote every successor
 * `blocked` while that pass was still committing to the branch they were
 * waiting for.
 *
 * It earns a place in this suite on this suite's terms. `bootBlockPlan` is the
 * decision and is unit-tested beside the other pure ones in `workflows.test.ts`;
 * what is left over is a *join* across three tables and an ordering between two
 * reconcilers, which is not something there is an argument to hand a function.
 * Every way of getting it wrong typechecks, throws nothing and renders as an
 * ordinary blocked block — the only evidence is a merge that never lands weeks
 * of work, months after the restart that decided it.
 *
 * Its own file, and `DATA_DIR` set before the first import, for the reason
 * `haltedMembers.test.ts` and `chatTurn.test.ts` are: `config.ts` reads that
 * variable at module load and `orchestrator.ts` pulls it in statically, so a
 * file that imported either at the top would already be bound to the
 * repository's own `.data` directory — which on a developer's machine is the
 * real one. Its own file rather than a case in `haltedMembers.test.ts` for a
 * second reason as well: both reconcilers here act on *every* row in the
 * database, so they would close out that file's fixtures under it.
 */

let root: string;
let orch: typeof import("./orchestrator");
let workflows: typeof import("./workflows");
let settings: typeof import("./settings");
let dbMod: typeof import("./db");

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-boot-blocks-"));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, "workspace");
  // Nothing here should reach a spawn. A `claude` that does not exist is what
  // makes a regression that gets that far a failed test rather than a billed one.
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );

  orch = await import("./orchestrator");
  workflows = await import("./workflows");
  settings = await import("./settings");
  dbMod = await import("./db");
});

after(() => {
  const open = (globalThis as { __ufDb?: Database.Database }).__ufDb;
  open?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Both reconcilers read the whole database, so a fixture left behind is a row
 * the next case's boot would decide as well.
 */
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

const HOUR = 3_600_000;

/**
 * The graph from the issue: one run block, and one merge block behind it that
 * `deferredNodes` leaves out of the creating pass — so `startWorkflow` writes it
 * a `waiting` ledger row and nothing else.
 */
const GRAPH = JSON.stringify({
  nodes: [
    { id: "A", name: "Build it", kind: "run" },
    { id: "B", name: "Land it", kind: "merge" },
  ],
  edges: [{ from: "A", to: "B", edge: "on-success", continueBranch: false }],
});

/**
 * The same graph with a loop at its head: `maxPasses` a number rather than
 * absent, because `advanceLoop` reads that field with `typeof` and a loop
 * without it ends on the next advance for a reason that has nothing to do with
 * the boot.
 */
const LOOP_GRAPH = JSON.stringify({
  nodes: [
    {
      id: "L",
      name: "Keep at it",
      kind: "loop",
      maxPasses: 5,
      maxLoopCostUSD: null,
    },
    { id: "B", name: "Land it", kind: "merge" },
  ],
  // No branch is carried out of a loop: each pass lands its own work through
  // the section's own exit, so the block behind one starts after a landing
  // rather than after a run. `normalizeWorkflowInput` refuses the other
  // spelling by name, and this blob is inserted rather than saved — so it
  // says what a saved one would say.
  edges: [{ from: "L", to: "B", edge: "on-success", continueBranch: false }],
});

/**
 * One instance mid-flight when the process died: its head a real run row, its
 * tail a `waiting` block.
 *
 * Inserted rather than built through `startWorkflow`, which would want a mount,
 * a git probe and a real spawn. What is under test is the join these columns
 * make — a run's status against the instance its block belongs to.
 */
function scene(
  name: string,
  run: { status: string; pausedAt?: number | null },
  instanceStatus = "started",
): { instanceId: string; runId: string } {
  const now = Date.now();
  const instanceId = `inst-${name}`;
  const runId = `run-${name}`;
  const db = dbMod.db();

  db.prepare(
    "INSERT INTO workflows (id, name, graph, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(`wf-${name}`, name, GRAPH, now, now);
  db.prepare(
    `INSERT INTO workflow_instances (id, workflow_id, workflow_name, graph, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(instanceId, `wf-${name}`, name, GRAPH, now, instanceStatus);
  db.prepare(
    `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                       created_at, started_at, paused_at, work_dir)
     VALUES (?, ?, ?, ?, '{"maxIterations":1,"permissionMode":"acceptEdits"}', 1, 0, ?, ?, ?, NULL)`,
  ).run(
    runId,
    path.join(root, "workspace"),
    "build it",
    run.status,
    now,
    now,
    run.pausedAt ?? null,
  );
  db.prepare(
    "INSERT INTO workflow_instance_runs (instance_id, node_id, node_name, position, run_id)" +
      " VALUES (?, 'A', 'Build it', 0, ?)",
  ).run(instanceId, runId);
  db.prepare(
    "INSERT INTO workflow_instance_blocks (instance_id, node_id, node_name, position, kind, status)" +
      " VALUES (?, 'B', 'Land it', 1, 'merge', 'waiting')",
  ).run(instanceId);

  return { instanceId, runId };
}

/**
 * The same instance one block kind over: a loop mid-pass, and a merge block
 * behind it that only the loop's own verdict can release.
 *
 * The pass's members are ordinary rows with `emitted_by` set to the loop, which
 * is what `bootBlockPlan` sees and what `loopPasses` reads — so the run this
 * boot keeps and the pass the block is on are the same row, as they are in
 * `stepPass`.
 *
 * `members` says what else the pass had opened when the container died. A pass
 * is a *section* now, so its other members are `waiting` ledger rows of their
 * own, and the question this file asks of each of them — does a boot close it
 * out or leave it to the instance that survived — is the question a chain of
 * runs never had to answer.
 */
function loopScene(
  name: string,
  run: { status: string; pausedAt?: number | null },
  instanceStatus = "started",
  members: Array<{ id: string; kind: string }> = [],
): { instanceId: string; runId: string } {
  const now = Date.now();
  const instanceId = `inst-${name}`;
  const runId = `run-${name}`;
  const db = dbMod.db();

  db.prepare(
    "INSERT INTO workflows (id, name, graph, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(`wf-${name}`, name, LOOP_GRAPH, now, now);
  db.prepare(
    `INSERT INTO workflow_instances (id, workflow_id, workflow_name, graph, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(instanceId, `wf-${name}`, name, LOOP_GRAPH, now, instanceStatus);
  db.prepare(
    `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                       created_at, started_at, paused_at, work_dir)
     VALUES (?, ?, ?, ?, '{"maxIterations":1,"permissionMode":"acceptEdits"}', 1, 0, ?, ?, ?, NULL)`,
  ).run(
    runId,
    path.join(root, "workspace"),
    "keep at it",
    run.status,
    now,
    now,
    run.pausedAt ?? null,
  );
  db.prepare(
    "INSERT INTO workflow_instance_runs (instance_id, node_id, node_name, position, run_id, emitted_by)" +
      " VALUES (?, 'L#pass-1', 'Keep at it — pass 1', 0, ?, 'L')",
  ).run(instanceId, runId);
  db.prepare(
    "INSERT INTO workflow_instance_blocks (instance_id, node_id, node_name, position, kind, status, started_at)" +
      " VALUES (?, 'L', 'Keep at it', 0, 'loop', 'looping', ?)",
  ).run(instanceId, now);
  db.prepare(
    "INSERT INTO workflow_instance_blocks (instance_id, node_id, node_name, position, kind, status)" +
      " VALUES (?, 'B', 'Land it', 1, 'merge', 'waiting')",
  ).run(instanceId);
  for (const [index, member] of members.entries()) {
    db.prepare(
      "INSERT INTO workflow_instance_blocks (instance_id, node_id, node_name, position, kind, status)" +
        " VALUES (?, ?, ?, ?, ?, 'waiting')",
    ).run(
      instanceId,
      `L#pass-1#${member.id}`,
      `${member.id} — pass 1`,
      index + 2,
      member.kind,
    );
  }

  return { instanceId, runId };
}

function blockOf(
  instanceId: string,
  nodeId = "B",
): {
  status: string;
  error: string | null;
  finishedAt: number | null;
} {
  const block = workflows.blocksOf(instanceId).find((b) => b.nodeId === nodeId);
  assert.ok(block, "the fixture's block row has gone");
  return {
    status: block.status,
    error: block.error,
    finishedAt: block.finishedAt,
  };
}

/** The boot, in `src/instrumentation.ts`'s order. */
async function boot(): Promise<void> {
  await orch.reconcileOnBoot();
  workflows.reconcileBlocksOnBoot();
}

describe("a waiting block whose workflow kept a run across the restart", () => {
  it("is left waiting rather than written off", async () => {
    const { instanceId, runId } = scene("Nightly build", {
      status: "paused",
      pausedAt: Date.now() - HOUR,
    });

    await boot();

    // The exception `reconcileOnBoot` makes, unchanged: the head survives.
    assert.equal(orch.getRun(runId)!.status, "paused");
    // And now the tail survives with it.
    const block = blockOf(instanceId);
    assert.equal(block.status, "waiting");
    assert.equal(block.error, null, "nothing may be recorded against a block still to come");
    assert.equal(block.finishedAt, null);
  });

  it("is decided by the next advance pass, on what is true then", async () => {
    const { instanceId, runId } = scene("Release train", {
      status: "paused",
      pausedAt: Date.now() - HOUR,
    });

    await boot();
    // While the run is parked there is still nothing to decide: a live
    // predecessor is `pending`, not a verdict.
    workflows.advanceInstances();
    assert.equal(blockOf(instanceId).status, "waiting");

    // The run resumes and this time ends without doing a cycle, which is the
    // one thing that settles the block rather than releasing it.
    dbMod
      .db()
      .prepare("UPDATE runs SET status='stopped', finished_at=? WHERE id=?")
      .run(Date.now(), runId);
    workflows.advanceInstances();

    const block = blockOf(instanceId);
    assert.equal(block.status, "blocked");
    assert.match(
      block.error ?? "",
      /Build it/,
      "the reason must name the run in front of it, as the cascade always does",
    );
    assert.doesNotMatch(
      block.error ?? "",
      /restart/i,
      "the restart decided nothing here and must not be what the row says",
    );
  });
});

describe("a waiting block with nothing left of its workflow", () => {
  it("is closed out when the boot failed the run in front of it", async () => {
    const { instanceId, runId } = scene("Broken build", { status: "running" });

    await boot();

    assert.equal(orch.getRun(runId)!.status, "failed");
    const block = blockOf(instanceId);
    assert.equal(block.status, "blocked");
    assert.ok(block.finishedAt, "a block that is closed out keeps the instant it ended");
    assert.match(block.error ?? "", /closed out by the same restart/);
  });

  it("is closed out when the pause was too stale to keep", async () => {
    const { instanceId, runId } = scene("Stale pause", {
      status: "paused",
      // Past `resumeGraceHours`, which defaults to 24.
      pausedAt: Date.now() - 48 * HOUR,
    });

    await boot();

    assert.equal(orch.getRun(runId)!.status, "stopped");
    const block = blockOf(instanceId);
    assert.equal(block.status, "blocked");
    assert.match(block.error ?? "", /closed out by the same restart/);
  });

  it("is closed out when the restart caught a halt half way through", async () => {
    // The one instance whose blocks must come down however live its members
    // are: `stopInstance` had already decided this workflow was over.
    const { instanceId, runId } = scene(
      "Halted graph",
      { status: "paused", pausedAt: Date.now() - HOUR },
      "stopping",
    );

    await boot();

    assert.equal(orch.getRun(runId)!.status, "paused");
    const block = blockOf(instanceId);
    assert.equal(block.status, "blocked");
    assert.match(block.error ?? "", /no longer running/);
  });
});

/**
 * A press of Run under the hold on a graph that starts by deciding: the block's
 * turn was never claimed, and there are no members at all.
 */
function heldDecision(name: string): string {
  const now = Date.now();
  const instanceId = `inst-${name}`;
  const graph = JSON.stringify({
    nodes: [{ id: "O", name: "Decide", kind: "orchestrator", fanOut: 2 }],
    edges: [],
  });
  const db = dbMod.db();
  db.prepare(
    "INSERT INTO workflows (id, name, graph, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(`wf-${name}`, name, graph, now, now);
  db.prepare(
    `INSERT INTO workflow_instances (id, workflow_id, workflow_name, graph, created_at, status)
     VALUES (?, ?, ?, ?, ?, 'started')`,
  ).run(instanceId, `wf-${name}`, name, graph, now);
  db.prepare(
    "INSERT INTO workflow_instance_blocks (instance_id, node_id, node_name, position, kind, status)" +
      " VALUES (?, 'O', 'Decide', 0, 'orchestrator', 'waiting')",
  ).run(instanceId);
  return instanceId;
}

describe("a waiting block across a restart taken while new work is held", () => {
  it("is left waiting for the lift when the restart closed none of its workflow", async () => {
    // The restart is the usual reason the hold is pressed. The run half keeps
    // a row that is ready but held; writing the block off here would end the
    // work the operator held the fleet to keep.
    const instanceId = heldDecision("Held decision");

    settings.setNewWorkPaused(true);
    try {
      await boot();
    } finally {
      settings.setNewWorkPaused(false);
    }

    const block = blockOf(instanceId, "O");
    assert.equal(block.status, "waiting");
    assert.equal(block.error, null);
  });

  it("is left waiting behind a member that completed before the restart", async () => {
    const { instanceId, runId } = scene("Held after a finish", { status: "completed" });

    settings.setNewWorkPaused(true);
    try {
      await boot();
    } finally {
      settings.setNewWorkPaused(false);
    }

    assert.equal(orch.getRun(runId)!.status, "completed");
    assert.equal(blockOf(instanceId).status, "waiting");
  });

  it("leaves a loop repeating when the pass it was on finished before the restart", async () => {
    // The `looping` sweep reads the same plan, so a loop whose next pass
    // would open with a held turn is the lift's to decide as well.
    const { instanceId } = loopScene("Held between passes", { status: "completed" });

    settings.setNewWorkPaused(true);
    try {
      await boot();
    } finally {
      settings.setNewWorkPaused(false);
    }

    assert.equal(blockOf(instanceId, "L").status, "looping");
    assert.equal(blockOf(instanceId).status, "waiting");
  });

  it("is closed out as before when nothing is held", async () => {
    // The control: the same instance with the hold clear has nothing left that
    // could wake it, which is what the rule was written for.
    const instanceId = heldDecision("Unheld decision");

    await boot();

    assert.equal(blockOf(instanceId, "O").status, "blocked");
  });

  it("is still closed out when the restart closed out one of its members", async () => {
    // A queued run is what a press of Run under the hold leaves, and the boot
    // closes it out. What is behind it is then behind a run the restart
    // ended — `on-finish` would release it on a cycle that died with the
    // container — so the hold spares nothing here.
    const { instanceId, runId } = scene("Held behind a queue", { status: "queued" });

    settings.setNewWorkPaused(true);
    try {
      await boot();
    } finally {
      settings.setNewWorkPaused(false);
    }

    assert.equal(orch.getRun(runId)!.status, "stopped");
    const block = blockOf(instanceId);
    assert.equal(block.status, "blocked");
    assert.match(block.error ?? "", /closed out by the same restart/);
  });
});

describe("a looping block whose workflow kept its pass across the restart", () => {
  it("is left looping rather than failed", async () => {
    const { instanceId, runId } = loopScene("Docs sweep", {
      status: "paused",
      pausedAt: Date.now() - HOUR,
    });

    await boot();

    assert.equal(orch.getRun(runId)!.status, "paused");
    const loop = blockOf(instanceId, "L");
    assert.equal(
      loop.status,
      "looping",
      "the pass this block is on is the run the same boot decided to keep",
    );
    assert.equal(
      loop.error,
      null,
      "nothing may be recorded against a loop that is still repeating",
    );
    assert.equal(loop.finishedAt, null);
  });

  it("holds the blocks behind it rather than writing them off", async () => {
    const { instanceId } = loopScene("Release notes", {
      status: "paused",
      pausedAt: Date.now() - HOUR,
    });

    await boot();
    // The verdict a live loop gives its successors is `pending`; a failed one
    // gives them "could not repeat its task", which is what a restart used to
    // decide here while the pass was still committing to their branch.
    workflows.advanceInstances();

    assert.equal(blockOf(instanceId, "L").status, "looping");
    const behind = blockOf(instanceId);
    assert.equal(behind.status, "waiting");
    assert.equal(behind.error, null);
  });
});

describe("a looping block with nothing left of its workflow", () => {
  it("is closed out when the boot failed the pass it was on", async () => {
    const { instanceId, runId } = loopScene("Abandoned sweep", {
      status: "running",
    });

    await boot();

    assert.equal(orch.getRun(runId)!.status, "failed");
    const loop = blockOf(instanceId, "L");
    assert.equal(loop.status, "failed");
    assert.ok(loop.finishedAt, "a block that is closed out keeps the instant it ended");
    assert.match(loop.error ?? "", /was repeating its task/);
    assert.match(loop.error ?? "", /closed out by the same restart/);
  });

  it("is closed out when the restart caught a halt half way through", async () => {
    // A live pass does not spare a loop whose workflow was already coming
    // down: `stopInstance` had decided this graph was over before the boot.
    const { instanceId, runId } = loopScene(
      "Halted sweep",
      { status: "paused", pausedAt: Date.now() - HOUR },
      "stopping",
    );

    await boot();

    assert.equal(orch.getRun(runId)!.status, "paused");
    const loop = blockOf(instanceId, "L");
    assert.equal(loop.status, "failed");
    assert.match(loop.error ?? "", /closed out by the same restart/);
  });

  it("leaves a whole pass alone when one of its members survived", () => {
    // `reconcileOnBoot`'s rule for a `waiting` run, one level up and over a
    // pass of several members: a pass is spared as a unit or not at all. Half a
    // pass closed out is a merge block written off while the run it was going
    // to land is still working — and the loop then stops because its pass did
    // not land everything, having landed nothing for want of a block the boot
    // removed.
    const { instanceId } = loopScene("live-section", { status: "paused" }, "started", [
      { id: "b", kind: "run" },
      { id: "m", kind: "merge" },
    ]);
    workflows.reconcileBlocksOnBoot();
    assert.equal(blockOf(instanceId, "L").status, "looping");
    for (const id of ["L#pass-1#b", "L#pass-1#m"]) {
      assert.equal(blockOf(instanceId, id).status, "waiting", id);
    }
  });

  it("closes out a whole pass when nothing of it survived", () => {
    // The other half. A member left `waiting` under a loop nothing will ever
    // advance again is what `liveBlocksOf` counts for ever, and the second
    // press of Run is refused on it.
    const { instanceId } = loopScene(
      "dead-section",
      { status: "failed" },
      "started",
      [
        { id: "b", kind: "run" },
        { id: "m", kind: "merge" },
      ],
    );
    workflows.reconcileBlocksOnBoot();
    assert.equal(blockOf(instanceId, "L").status, "failed");
    for (const id of ["L#pass-1#b", "L#pass-1#m"]) {
      assert.equal(blockOf(instanceId, id).status, "blocked", id);
    }
  });
});

/**
 * The same question one level down: a run waiting on another run.
 *
 * The boot used to write every `waiting` row `stopped`, before it looked at
 * anything else, under a sentence saying the run it waited for "was closed out
 * by the same restart". Two of the three cases below are that sentence being
 * false: the dependency was a pause the same boot kept, or it had already
 * completed and the hold was what kept the dependent back. The third is the one
 * where it was true, and there the sentence named no run at all, and an
 * `on-finish` edge is what makes the decision dangerous: the ordinary release
 * pass reads a run that did a cycle and then died with the container as
 * finished, and would queue the run behind it because of a restart.
 *
 * Ids are uuids because the reasons name runs by their first eight characters,
 * and the assertions look for exactly those.
 */
describe("a run waiting on another run across the restart", () => {
  function runRow(
    status: string,
    extra: { pausedAt?: number; iterations?: number } = {},
  ): string {
    const id = randomUUID();
    const now = Date.now();
    const folder = path.join(root, "workspace", id);
    dbMod
      .db()
      .prepare(
        `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                           created_at, started_at, paused_at, work_dir)
         VALUES (?, ?, 'do it', ?, '{"maxIterations":1,"permissionMode":"acceptEdits"}', 1, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        folder,
        status,
        extra.iterations ?? 0,
        now,
        status === "waiting" ? null : now,
        extra.pausedAt ?? null,
        // A waiting row has no workspace until its release plans one.
        status === "waiting" ? null : folder,
      );
    return id;
  }

  function dependOn(runId: string, dependsOn: string, edge = "on-success"): void {
    dbMod
      .db()
      .prepare(
        "INSERT INTO run_deps (run_id, depends_on, edge, continue_branch, created_at)" +
          " VALUES (?, ?, ?, 0, ?)",
      )
      .run(runId, dependsOn, edge, Date.now());
  }

  it("stays waiting behind a run the boot kept paused", async () => {
    const a = runRow("paused", { pausedAt: Date.now() - HOUR });
    const b = runRow("waiting");
    dependOn(b, a);

    await boot();

    assert.equal(orch.getRun(a)!.status, "paused");
    const row = orch.getRun(b)!;
    assert.equal(row.status, "waiting", "nothing it waits for was closed out");
    assert.equal(row.stop_reason, null);
    assert.equal(row.finished_at, null);
  });

  it("ends naming the run the boot closed out, and so does everything behind it", async () => {
    const a = runRow("running", { iterations: 1 });
    const b = runRow("waiting");
    const c = runRow("waiting");
    dependOn(b, a, "on-finish");
    dependOn(c, b);

    await boot();

    assert.equal(orch.getRun(a)!.status, "failed");
    const behindA = orch.getRun(b)!;
    assert.equal(
      behindA.status,
      "blocked",
      "terminal, and in the status that says nothing ran; never released into the queue",
    );
    assert.match(behindA.stop_reason ?? "", new RegExp(a.slice(0, 8)));
    assert.match(behindA.stop_reason ?? "", /restart/);
    assert.equal(
      behindA.restart_closed,
      0,
      "picked up through the run it waited for, which carries the flag, not by the same press",
    );
    const behindB = orch.getRun(c)!;
    assert.equal(behindB.status, "blocked");
    assert.match(
      behindB.stop_reason ?? "",
      new RegExp(b.slice(0, 8)),
      "the cascade names the run in front of it, not the head of the chain",
    );
  });

  it("stays waiting behind a completed run while new work is held", async () => {
    const a = runRow("completed", { iterations: 1 });
    const b = runRow("waiting");
    dependOn(b, a);

    settings.setNewWorkPaused(true);
    try {
      await boot();

      const row = orch.getRun(b)!;
      assert.equal(row.status, "waiting", "the restart closed nothing it waits for");
      assert.equal(row.work_dir, null, "and the hold still keeps it out of the queue");
    } finally {
      settings.setNewWorkPaused(false);
    }
  });
});
