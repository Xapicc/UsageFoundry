import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type Database from "better-sqlite3";

import { passMemberId } from "./passIds";

/**
 * Covers one thing: what a gate does to the rows of an instance, from reached to
 * let through, halted, restarted over and repeated by a loop.
 *
 * `planInstanceStep`, `gateContinueRefusal` and `bootBlockPlan` are the
 * decisions and are unit-tested beside the other pure ones in
 * `workflows.test.ts`. What is left is what no argument can be handed: that a
 * gate which is *reached* is written exactly once, that Continue is a write
 * guarded on a column the status does not carry, that a restart's sweep joins
 * `held_at` and not only `status`, and that a pass is a row of its own — so
 * Continue on one pass is a press that releases nothing of the next. Every one
 * of them typechecks, throws nothing and renders: the failure is a workflow that
 * runs past the point a person asked to be stopped at, or one that is closed out
 * under a page still offering the button.
 *
 * Gates are chained to gates, and a loop's section is a single gate, so that no
 * case here reaches a spawn, a git probe or a checkout: what is behind a gate is
 * the next gate, and that is enough to observe "released" as a column.
 *
 * Its own file, and `DATA_DIR` set before the first import, for the reason
 * `bootBlocks.test.ts` is: `config.ts` reads it at module load, and the boot
 * reconciler acts on every row in the database.
 */

let root: string;
let workflows: typeof import("./workflows");
let dbMod: typeof import("./db");

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-gate-block-")));
  fs.mkdirSync(path.join(root, "claude", "projects"), { recursive: true });
  fs.mkdirSync(path.join(root, "workspace"), { recursive: true });
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, "workspace");
  process.env.WORKSPACE_ROOTS = "";
  // No webhook either: a gate that is held tells a receiver, and this file has
  // none to tell.
  process.env.UF_WEBHOOK_URL = "";
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );

  workflows = await import("./workflows");
  dbMod = await import("./db");
});

after(() => {
  const open = (globalThis as { __ufDb?: Database.Database }).__ufDb;
  open?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

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

const gate = (id: string, name: string) => ({ id, name, kind: "gate" });

/** Two gates in a row: the second can only be reached once the first is let through. */
const CHAIN = {
  nodes: [gate("g1", "Look first"), gate("g2", "Look again")],
  edges: [{ from: "g1", to: "g2", edge: "on-success", continueBranch: false }],
};

/**
 * A loop whose section is one gate, taking two passes at most. A graph a
 * person could not save — a section ends at a merge block — and inserted
 * rather than saved for that reason: what is under test is the scheduler's
 * reading of a gate member, and a merge block would want a checkout.
 */
const LOOPED = {
  nodes: [
    { id: "L", name: "Keep at it", kind: "loop", maxPasses: 2, bodyNodeIds: ["g"] },
    gate("g", "Look each time"),
  ],
  edges: [{ from: "L", to: "g", edge: "repeats", continueBranch: false }],
};

/** An instance whose blocks were all written `waiting`, as `startWorkflow` writes them. */
function seed(
  instanceId: string,
  graph: object,
  blocks: Array<{ id: string; name: string; kind: string; status?: string; heldAt?: number | null }>,
  instanceStatus = "started",
): string {
  const now = Date.now();
  const json = JSON.stringify(graph);
  const db = dbMod.db();
  db.prepare(
    "INSERT INTO workflows (id, name, graph, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(`wf-${instanceId}`, instanceId, json, now, now);
  db.prepare(
    `INSERT INTO workflow_instances (id, workflow_id, workflow_name, graph, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(instanceId, `wf-${instanceId}`, instanceId, json, now, instanceStatus);
  for (const [position, block] of blocks.entries()) {
    db.prepare(
      `INSERT INTO workflow_instance_blocks
         (instance_id, node_id, node_name, position, kind, status, held_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      instanceId,
      block.id,
      block.name,
      position,
      block.kind,
      block.status ?? "waiting",
      block.heldAt ?? null,
    );
  }
  return instanceId;
}

function chain(instanceId: string): string {
  return seed(instanceId, CHAIN, [
    { id: "g1", name: "Look first", kind: "gate" },
    { id: "g2", name: "Look again", kind: "gate" },
  ]);
}

type Row = { status: string; held_at: number | null; error: string | null };

function row(instanceId: string, nodeId: string): Row | undefined {
  return dbMod
    .db()
    .prepare(
      "SELECT status, held_at, error FROM workflow_instance_blocks WHERE instance_id=? AND node_id=?",
    )
    .get(instanceId, nodeId) as Row | undefined;
}

describe("a gate that is reached waits for a person", () => {
  it("holds the gate the instance has reached and not the one behind it", () => {
    const id = chain("reached");
    workflows.advanceInstances();

    assert.equal(row(id, "g1")!.status, "waiting", "a held gate is a waiting row");
    assert.notEqual(row(id, "g1")!.held_at, null, "and held_at is what says it was reached");
    assert.equal(row(id, "g2")!.held_at, null, "the gate behind it has not been reached");
    assert.equal(workflows.getInstance(id)!.status, "started", "the instance still reads as working");
  });

  it("holds it once, however many times the instance advances", () => {
    // Every terminal run transition in the app advances every started instance,
    // and a held gate is planned again each time. The guard on `held_at IS NULL`
    // is what stops that being a notification per advance.
    const id = chain("once");
    workflows.advanceInstances();
    assert.notEqual(row(id, "g1")!.held_at, null);

    // A sentinel rather than the clock: two writes inside one millisecond would
    // carry the same timestamp and read as no write at all.
    dbMod
      .db()
      .prepare("UPDATE workflow_instance_blocks SET held_at = 1234 WHERE instance_id=? AND node_id='g1'")
      .run(id);
    workflows.advanceInstances();
    workflows.advanceInstances();
    assert.equal(row(id, "g1")!.held_at, 1234);
  });

  it("releases what is behind it only when Continue is pressed", () => {
    const id = chain("release");
    workflows.advanceInstances();
    assert.equal(row(id, "g2")!.held_at, null);

    const outcome = workflows.continueGate(id, "g1");
    assert.deepEqual(outcome, { ok: true, name: "Look first" });

    assert.equal(row(id, "g1")!.status, "emitted");
    assert.notEqual(row(id, "g2")!.held_at, null, "the next gate is reached by the same press");
    assert.equal(row(id, "g2")!.status, "waiting", "and is waiting for its own");
  });

  it("finishes the instance once the last gate is let through", () => {
    const id = chain("finish");
    workflows.advanceInstances();
    workflows.continueGate(id, "g1");
    workflows.continueGate(id, "g2");
    assert.equal(workflows.getInstance(id)!.status, "finished");
  });
});

describe("Continue says why it did nothing", () => {
  it("refuses a gate the instance has not reached yet", () => {
    const id = chain("early");
    workflows.advanceInstances();
    const outcome = workflows.continueGate(id, "g2");
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.status, 409);
    assert.match(outcome.error, /has not reached “Look again”/);
    assert.equal(row(id, "g2")!.status, "waiting", "and it changed nothing");
  });

  it("refuses a second press on a gate that was already let through", () => {
    const id = chain("twice");
    workflows.advanceInstances();
    workflows.continueGate(id, "g1");
    const again = workflows.continueGate(id, "g1");
    assert.equal(again.ok, false);
    if (again.ok) return;
    assert.equal(again.status, 409);
    assert.match(again.error, /already been let through/);
  });

  it("answers 404 for a block that is not a gate of this run", () => {
    const id = chain("elsewhere");
    for (const node of ["nope", "L"]) {
      const outcome = workflows.continueGate(id, node);
      assert.equal(outcome.ok, false, node);
      if (!outcome.ok) assert.equal(outcome.status, 404, node);
    }
    assert.equal(workflows.continueGate("no-such-run", "g1").ok, false);
  });
});

describe("Stop halts a run that is waiting at a gate", () => {
  it("writes the gates blocked, says nobody let them through, and refuses Continue after", () => {
    const id = chain("stop");
    workflows.advanceInstances();
    assert.notEqual(row(id, "g1")!.held_at, null);

    const stopped = workflows.stopInstance(id, { kind: "operator" });
    assert.equal(stopped.ok, true);
    if (!stopped.ok) return;
    assert.equal(stopped.report.acted, true, "a run waiting only at a gate is live, so a stop acts");

    for (const node of ["g1", "g2"]) {
      assert.equal(row(id, node)!.status, "blocked", node);
      assert.match(row(id, node)!.error ?? "", /before anyone let it through/, node);
    }
    assert.equal(workflows.getInstance(id)!.status, "stopped");

    const late = workflows.continueGate(id, "g1");
    assert.equal(late.ok, false);
    if (!late.ok) assert.equal(late.status, 409);
  });
});

describe("a restart leaves a held gate alone", () => {
  it("keeps the instance a person is being waited on in, and closes out one that is not held", () => {
    const heldAt = Date.now() - 60_000;
    // Reached before the restart: held_at is set.
    const held = seed("boot-held", CHAIN, [
      { id: "g1", name: "Look first", kind: "gate", heldAt },
      { id: "g2", name: "Look again", kind: "gate" },
    ]);
    // Not reached: nothing is live and nothing will wake it, so it is closed
    // out for the reason every other waiting block is.
    const unreached = seed("boot-unreached", CHAIN, [
      { id: "g1", name: "Look first", kind: "gate" },
      { id: "g2", name: "Look again", kind: "gate" },
    ]);

    workflows.reconcileBlocksOnBoot();

    assert.equal(row(held, "g1")!.status, "waiting");
    assert.equal(row(held, "g1")!.held_at, heldAt, "and it is still held, not re-announced");
    assert.equal(row(held, "g2")!.status, "waiting", "what it holds back is not written off either");
    assert.equal(workflows.getInstance(held)!.status, "started");

    assert.equal(row(unreached, "g1")!.status, "blocked");
    assert.equal(row(unreached, "g2")!.status, "blocked");
  });

  it("still closes out a held gate when its instance was already halted", () => {
    const id = seed(
      "boot-halted",
      CHAIN,
      [
        { id: "g1", name: "Look first", kind: "gate", heldAt: Date.now() },
        { id: "g2", name: "Look again", kind: "gate" },
      ],
      "stopping",
    );
    workflows.reconcileBlocksOnBoot();
    assert.equal(row(id, "g1")!.status, "blocked");
  });

  it("lets Continue through after the restart", () => {
    const id = seed("boot-continue", CHAIN, [
      { id: "g1", name: "Look first", kind: "gate", heldAt: Date.now() - 1_000 },
      { id: "g2", name: "Look again", kind: "gate" },
    ]);
    workflows.reconcileBlocksOnBoot();

    assert.equal(workflows.continueGate(id, "g1").ok, true);
    assert.notEqual(row(id, "g2")!.held_at, null);
  });
});

describe("a loop's gate holds every pass", () => {
  it("opens a gate row per pass, and a press on one releases nothing of the next", () => {
    const id = seed("loop", LOOPED, [{ id: "L", name: "Keep at it", kind: "loop" }]);
    const first = passMemberId("L", 1, "g");
    const second = passMemberId("L", 2, "g");

    workflows.advanceInstances();
    assert.equal(row(id, "L")!.status, "looping");
    assert.equal(row(id, first)!.status, "waiting");
    assert.notEqual(row(id, first)!.held_at, null, "pass 1 is held");
    assert.equal(row(id, second), undefined, "and pass 2 does not exist yet");

    // Continue on pass 1 settles it, so the loop takes pass 2 — which is held in
    // its own right, by a row Continue on pass 1 never touched.
    assert.equal(workflows.continueGate(id, first).ok, true);
    assert.equal(row(id, first)!.status, "emitted");
    assert.equal(row(id, second)!.status, "waiting");
    assert.notEqual(row(id, second)!.held_at, null, "pass 2 is held");
    assert.equal(row(id, "L")!.status, "looping", "the loop has not ended with a pass still held");

    // Pass 1's press cannot be used a second time to get through pass 2.
    const reused = workflows.continueGate(id, first);
    assert.equal(reused.ok, false);
    assert.equal(row(id, second)!.status, "waiting");

    assert.equal(workflows.continueGate(id, second).ok, true);
    assert.notEqual(row(id, "L")!.status, "looping", "the pass cap ends the loop after the last gate");
    assert.equal(workflows.getInstance(id)!.status, "finished");
  });

  it("holds the loop on a pass whose gate nobody has answered", () => {
    const id = seed("loop-held", LOOPED, [{ id: "L", name: "Keep at it", kind: "loop" }]);
    workflows.advanceInstances();
    for (let i = 0; i < 3; i += 1) workflows.advanceInstances();
    assert.equal(row(id, "L")!.status, "looping");
    assert.equal(row(id, passMemberId("L", 2, "g")), undefined, "no second pass while the first is held");
  });
});
