import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type Database from "better-sqlite3";

/**
 * Which press of Run, and which block of it, a run belongs to — the lookup the
 * run's own page draws its origin link from.
 *
 * It is a join, so there is no argument to hand a pure function: a run row
 * carries no workflow id (`origin_ref` is an instance id, a schedule id or a
 * node id depending on `origin`), and the membership table is the only place
 * the three meet. Every way of getting it wrong typechecks and draws a link —
 * to the wrong instance, or to a page that is not there — so the cases are the
 * ones that tell a right join from a plausible one: a run that is no member, a
 * member an orchestrator block emitted rather than the graph named, and a
 * workflow deleted since, which must read as no origin rather than as a link to
 * an instance that went with it.
 *
 * Its own file, and `DATA_DIR` set before the first import, for the reason
 * `instanceReading.test.ts` is: `config.ts` reads that variable at module load.
 */

let root: string;
let workflows: typeof import("./workflows");
let dbMod: typeof import("./db");

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-run-workflow-origin-"));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, "workspace");
  process.env.WORKSPACE_ROOTS = "";
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

let seq = 0;

function run(): string {
  const id = `run-${seq++}`;
  dbMod
    .db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations,
                         iterations, created_at)
       VALUES (?, ?, 'do it', 'completed',
               '{"maxIterations":1,"permissionMode":"acceptEdits"}', 1, 0, ?)`,
    )
    .run(id, path.join(root, "workspace"), Date.now());
  return id;
}

function workflow(id: string, name: string): void {
  const now = Date.now();
  dbMod
    .db()
    .prepare(
      "INSERT INTO workflows (id, name, graph, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)",
    )
    .run(id, name, now, now);
}

function instance(id: string, workflowId: string, workflowName: string): void {
  dbMod
    .db()
    .prepare(
      `INSERT INTO workflow_instances (id, workflow_id, workflow_name, graph, created_at, status)
       VALUES (?, ?, ?, '{"nodes":[],"edges":[]}', ?, 'started')`,
    )
    .run(id, workflowId, workflowName, Date.now());
}

function member(
  instanceId: string,
  nodeId: string,
  nodeName: string,
  runId: string,
  emittedBy: string | null = null,
): void {
  dbMod
    .db()
    .prepare(
      `INSERT INTO workflow_instance_runs
         (instance_id, node_id, node_name, position, run_id, emitted_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(instanceId, nodeId, nodeName, seq++, runId, emittedBy);
}

describe("the workflow a run belongs to", () => {
  it("names the workflow, the press of Run and the block", () => {
    workflow("wf-a", "Ship it");
    instance("inst-a", "wf-a", "Ship it");
    const first = run();
    const second = run();
    member("inst-a", "node-build", "Build", first);
    member("inst-a", "node-test", "Test", second);

    assert.deepEqual(workflows.workflowOriginOf(second), {
      workflowId: "wf-a",
      workflowName: "Ship it",
      instanceId: "inst-a",
      nodeName: "Test",
    });
  });

  it("is null for a run that is no member of any instance", () => {
    // Most runs in this app: the form, an approved chat proposal. A query that
    // fell back to the newest instance, or to the run's `origin_ref`, would
    // draw a link for every one of them.
    workflow("wf-b", "Other");
    instance("inst-b", "wf-b", "Other");
    member("inst-b", "node-x", "X", run());

    assert.equal(workflows.workflowOriginOf(run()), null);
  });

  it("follows a run an orchestrator block emitted to its own instance", () => {
    // `origin` says "orchestrator-block" and `origin_ref` a node id, so only the
    // membership row can say which instance. Its name is the emitted run's.
    workflow("wf-c", "Fan out");
    instance("inst-c", "wf-c", "Fan out");
    const decider = run();
    const emitted = run();
    member("inst-c", "node-decide", "Decide", decider);
    member("inst-c", "node-decide/1", "Fix the parser", emitted, "node-decide");

    assert.deepEqual(workflows.workflowOriginOf(emitted), {
      workflowId: "wf-c",
      workflowName: "Fan out",
      instanceId: "inst-c",
      nodeName: "Fix the parser",
    });
  });

  it("keeps two presses of one workflow apart", () => {
    workflow("wf-d", "Twice");
    instance("inst-d1", "wf-d", "Twice");
    instance("inst-d2", "wf-d", "Twice");
    const early = run();
    const late = run();
    member("inst-d1", "node-1", "Only", early);
    member("inst-d2", "node-1", "Only", late);

    assert.equal(workflows.workflowOriginOf(early)?.instanceId, "inst-d1");
    assert.equal(workflows.workflowOriginOf(late)?.instanceId, "inst-d2");
  });

  it("is null once the workflow is deleted, because its instances go with it", () => {
    // The run row stays, and a link to an instance page that now answers 404
    // is worse than the plain sentence the page falls back to.
    workflow("wf-e", "Doomed");
    instance("inst-e", "wf-e", "Doomed");
    const orphan = run();
    member("inst-e", "node-1", "Only", orphan);
    assert.ok(workflows.workflowOriginOf(orphan));

    assert.equal(workflows.deleteWorkflow("wf-e"), true);
    assert.equal(workflows.workflowOriginOf(orphan), null);
  });
});
