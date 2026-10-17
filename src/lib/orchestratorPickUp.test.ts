import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type Database from "better-sqlite3";

import type { WorkflowNode } from "./workflowGraph";

/**
 * Covers one thing: what picking up a failed deciding block writes, and which
 * failed blocks the instance page is offered it for.
 *
 * `orchestratorRetryRefusal` is the decision and is unit-tested beside the other
 * pure ones in `workflows.test.ts`. What is left is the join and the writes it
 * cannot reach, every one of which is silent: `emitted_specs` set to `[]` is a
 * set column, so a block retried without clearing it refuses every `emit_runs`
 * the new turn makes as "already emitted" and the operator is billed for a turn
 * that cannot start anything; a spend column reset on the way back to `waiting`
 * reports the block as cheaper than it was; and a successor left `blocked`
 * leaves the pick-up looking done while the graph never moves.
 *
 * Its own file, and `DATA_DIR` set before the first import, for the reason
 * `fleet.test.ts` and `bootBlocks.test.ts` are: `config.ts` reads it at module
 * load, so a file that imported `workflows` at the top would be bound to the
 * repository's own `.data`.
 */

let root: string;
let orch: typeof import("./orchestrator");
let workflows: typeof import("./workflows");
let settings: typeof import("./settings");
let dbMod: typeof import("./db");
let assists: number | null;

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-orch-pick-up-")));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(root, "claude", "projects"), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  // The two saved folders of the shared-folder cases below.
  fs.mkdirSync(path.join(workspace, "project"));
  fs.mkdirSync(path.join(workspace, "second"));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = workspace;
  process.env.WORKSPACE_ROOTS = "";
  // A `claude` that does not exist makes a retry that reaches a spawn a failed
  // test rather than a billed one.
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
  // `currentSnapshot` would otherwise ask the provider's API for plan usage.
  settings.saveSettings({ planUsageFromApi: false });
  // A turn holds a slot while it is `thinking`, and a block refused a slot stays
  // `waiting`, which would read as the retry not claiming it.
  assists = settings.getSettings().maxConcurrentAssists;
  settings.saveSettings({ maxConcurrentAssists: null });
});

after(() => {
  settings.saveSettings({ maxConcurrentAssists: assists });
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

const GRAPH = JSON.stringify({
  nodes: [
    {
      id: "o",
      name: "Decide",
      kind: "orchestrator",
      templateId: null,
      mountId: "workspace",
      folder: "",
      task: "decide",
      promptOverride: null,
      agentId: null,
      fanOut: 2,
      provider: null,
    },
    { id: "m", name: "Land it", kind: "merge" },
  ],
  edges: [{ from: "o", to: "m", edge: "on-success", continueBranch: false }],
});

const SPEC = {
  id: "s1",
  title: "Fix it",
  task: "fix it",
  folder: "",
  dependsOn: [],
};

/**
 * A started instance whose deciding block failed and whose merge block was
 * written off behind it — what a press of Run leaves when the turn dies.
 * Inserted rather than driven, because a real failure would want a spawn.
 */
function failedDecision(
  id: string,
  over: {
    specs?: string | null;
    mergeStatus?: string;
    instanceStatus?: string;
  } = {},
): string {
  const now = Date.now();
  const db = dbMod.db();
  db.prepare(
    "INSERT INTO workflows (id, name, graph, created_at, updated_at) VALUES (?, 'Decide first', ?, ?, ?)",
  ).run(`wf-${id}`, GRAPH, now, now);
  db.prepare(
    `INSERT INTO workflow_instances (id, workflow_id, workflow_name, graph, created_at, status)
     VALUES (?, ?, 'Decide first', ?, ?, ?)`,
  ).run(id, `wf-${id}`, GRAPH, now, over.instanceStatus ?? "started");
  db.prepare(
    `INSERT INTO workflow_instance_blocks
       (instance_id, node_id, node_name, position, kind, status, started_at, finished_at,
        error, cost_usd, cost_usd_est, cost_unreported, tokens, emitted_specs, reply, notes)
     VALUES (?, 'o', 'Decide', 0, 'orchestrator', 'failed', ?, ?, 'The CLI exited 1.',
             0.37, 0.05, 1, 900, ?, NULL, 'a note')`,
  ).run(id, now - 5_000, now - 1_000, over.specs ?? null);
  db.prepare(
    `INSERT INTO workflow_instance_blocks
       (instance_id, node_id, node_name, position, kind, status, finished_at, error)
     VALUES (?, 'm', 'Land it', 1, 'merge', ?, ?, ?)`,
  ).run(
    id,
    over.mergeStatus ?? "blocked",
    now - 1_000,
    "“Decide” could not decide what to start: The CLI exited 1.",
  );
  return id;
}

type BlockRow = {
  status: string;
  error: string | null;
  started_at: number | null;
  finished_at: number | null;
  cost_usd: number;
  cost_usd_est: number;
  cost_unreported: number;
  tokens: number;
  emitted_specs: string | null;
};

function block(id: string, nodeId: string): BlockRow {
  return dbMod
    .db()
    .prepare("SELECT * FROM workflow_instance_blocks WHERE instance_id=? AND node_id=?")
    .get(id, nodeId) as BlockRow;
}

function offered(id: string) {
  return workflows.pickUpsOf(workflows.getInstance(id)!);
}

function thinking(id: string): boolean {
  return (
    dbMod
      .db()
      .prepare("SELECT 1 FROM workflow_instance_blocks WHERE instance_id=? AND status='thinking'")
      .get(id) !== undefined
  );
}

/**
 * Run `body`, then let any turn it started end against the `claude` that is not
 * there. Not a halt: a halted turn's tail still reads the database after its
 * awaits, and the file closes the database when its last case returns.
 */
async function withInstance(id: string, body: () => void | Promise<void>): Promise<void> {
  try {
    await body();
  } finally {
    for (let tries = 0; tries < 300 && thinking(id); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.equal(thinking(id), false, "a turn this case started never ended");
}

describe("picking up a failed deciding block", () => {
  it("is offered for a turn that failed having decided nothing", () =>
    withInstance(failedDecision("clean"), () => {
      assert.deepEqual(offered("clean"), [
        {
          kind: "orchestrator",
          nodeId: "o",
          nodeName: "Decide",
          error: "The CLI exited 1.",
          retryRefusal: null,
        },
      ]);
    }));

  it("runs only the turn again: claimed, its spend kept, what it blocked revived", () =>
    withInstance(failedDecision("retry"), () => {
      assert.deepEqual(workflows.retryOrchestratorBlock("retry", "o"), { ok: true });

      // `advanceInstances` ran inside the call, so the block is already claimed
      // and its turn is in flight — the claim is the evidence the turn started
      // through `startBlockTurn`, the only place a cap or a budget is asked.
      const after = block("retry", "o");
      assert.equal(after.status, "thinking");
      assert.notEqual(after.started_at, null);
      assert.equal(after.error, null, "the failure clears when the retry starts");
      assert.equal(after.finished_at, null);
      assert.equal(after.cost_usd, 0.37, "the failed turn's bill is not erased");
      assert.equal(after.cost_usd_est, 0.05);
      assert.equal(after.cost_unreported, 1);
      assert.equal(after.tokens, 900);
      assert.equal(block("retry", "m").status, "waiting", "its successor is asked again");
    }));

  it("clears a stored empty decision, so the new turn can emit", () =>
    withInstance(failedDecision("empty", { specs: "[]" }), () => {
      assert.equal(offered("empty")[0]?.kind, "orchestrator");
      assert.deepEqual(workflows.retryOrchestratorBlock("empty", "o"), { ok: true });
      assert.equal(
        block("empty", "o").emitted_specs,
        null,
        "`[]` is a set column, and emit_runs refuses a block whose column is set",
      );
    }));

  it("is refused, with the sentence, for a turn that had decided on runs", () =>
    withInstance(failedDecision("decided", { specs: JSON.stringify([SPEC]) }), () => {
      const [pickUp] = offered("decided");
      assert.equal(pickUp?.kind, "orchestrator");
      assert.match(
        pickUp.kind === "orchestrator" ? (pickUp.retryRefusal ?? "") : "",
        /had already decided on 1 run when its turn failed/,
      );

      const outcome = workflows.retryOrchestratorBlock("decided", "o");
      assert.equal(outcome.ok, false);
      assert.equal(!outcome.ok && outcome.status, 409);
      const after = block("decided", "o");
      assert.equal(after.status, "failed", "a refusal writes nothing");
      assert.equal(after.emitted_specs, JSON.stringify([SPEC]));
    }));

  it("is refused once a block behind it has started", () =>
    withInstance(failedDecision("moved-on", { mergeStatus: "emitted" }), () => {
      const [pickUp] = offered("moved-on");
      assert.match(
        pickUp.kind === "orchestrator" ? (pickUp.retryRefusal ?? "") : "",
        /“Land it” has already started after “Decide” failed/,
      );
      const outcome = workflows.retryOrchestratorBlock("moved-on", "o");
      assert.equal(!outcome.ok && outcome.status, 409);
      assert.equal(block("moved-on", "o").status, "failed");
    }));

  it("is not offered, or honoured, through a halt", () =>
    withInstance(failedDecision("halted", { instanceStatus: "stopping" }), () => {
      assert.deepEqual(offered("halted"), []);
      const outcome = workflows.retryOrchestratorBlock("halted", "o");
      assert.equal(!outcome.ok && outcome.status, 409);
      assert.equal(block("halted", "o").status, "failed");
    }));

  it("is not offered for a block that did not fail", () =>
    withInstance(failedDecision("fine"), () => {
      dbMod
        .db()
        .prepare("UPDATE workflow_instance_blocks SET status='emitted' WHERE instance_id='fine' AND node_id='o'")
        .run();
      assert.deepEqual(offered("fine"), []);
    }));
});

/**
 * Two presses of one workflow run at the same time only when they share no
 * folder, and `startWorkflow` holds that at a press. A pick-up brings an idle
 * press back as surely as Run starts one, and a newer press into its folder is
 * exactly what that gate admits while it is idle — so without the check at the
 * pick-up's own door, the older press is put back to work beside the newer.
 *
 * Driven through `startWorkflow` under the install-wide hold, so a held turn
 * stays `waiting` (live) and nothing is ever claimed or spawned.
 */
describe("a pick-up on an older press of Run", () => {
  const FOLDERS = [
    { mountId: "workspace", folder: "project" },
    { mountId: "workspace", folder: "second" },
  ];

  function node(id: string, kind: WorkflowNode["kind"]): WorkflowNode {
    return {
      id,
      name: `Do ${id}`,
      kind,
      templateId: null,
      mountId: "workspace",
      folder: "project",
      task: "do the thing",
      promptOverride: null,
      agentId: null,
      fanOut: kind === "orchestrator" ? 2 : null,
      mergeStrategy: null,
      mergeAutoResolve: false,
      maxPasses: null,
      maxLoopCostUSD: null,
      stopWhenTasks: null,
      bodyNodeIds: [],
      provider: null,
      fixRounds: null,
      followsChosenFolder: true,
    };
  }

  /** A workflow of one block, pressed once into the first saved folder. */
  async function firstPress(name: string, kind: WorkflowNode["kind"]) {
    const workflow = workflows.createWorkflow({
      name,
      graph: { nodes: [node("O", kind)], edges: [] },
      instanceBudget: { maxInstanceCostUSD: null, maxSessionFraction: null, maxWeeklyFraction: null },
      folders: FOLDERS,
    });
    const snapshot = await orch.currentSnapshot();
    const press = (folder: (typeof FOLDERS)[number]) => {
      const started = workflows.startWorkflow(workflow.id, snapshot, { kind: "manual", folder });
      assert.ok(started.ok, `a press was refused: ${!started.ok && started.reason}`);
      return started.instance.id;
    };
    return { workflow, first: press(FOLDERS[0]), press };
  }

  /** Run `body` with new work held, so no turn or run of it ever starts. */
  async function held(body: () => Promise<void>): Promise<void> {
    settings.setNewWorkPaused(true);
    try {
      await body();
    } finally {
      settings.setNewWorkPaused(false);
    }
  }

  const failTurn = (instanceId: string) =>
    dbMod
      .db()
      .prepare(
        "UPDATE workflow_instance_blocks SET status='failed', error='The turn failed.', finished_at=?" +
          " WHERE instance_id=? AND node_id='O'",
      )
      .run(Date.now(), instanceId);

  it("is refused, and not offered, while a newer press works in the same folder", () =>
    held(async () => {
      const { workflow, first, press } = await firstPress("Decide per project", "orchestrator");
      failTurn(first); // decided nothing: what retryOrchestratorBlock exists to pick up
      assert.equal(workflows.liveInstancesOf(workflow.id).length, 0);
      press(FOLDERS[0]); // admitted, correctly: press 1 is not live

      const pickUp = workflows.retryOrchestratorBlock(first, "O");
      assert.equal(pickUp.ok, false, "the pick-up should be refused while press 2 works in project");
      assert.equal(pickUp.status, 409);
      assert.match(pickUp.error, /from another press of Run have not finished yet/);
      assert.match(pickUp.error, /before picking this one up/);
      assert.equal(workflows.liveInstancesOf(workflow.id).length, 1, "two presses live in one folder");
      assert.equal(block(first, "O").status, "failed", "a refusal writes nothing");

      const [offer] = workflows.pickUpsOf(workflows.getInstance(first)!);
      assert.ok(offer?.kind === "orchestrator");
      assert.equal(offer.retryRefusal, pickUp.error, "the list says what the door does");
    }));

  it("control: is allowed while the newer press works in the other saved folder", () =>
    held(async () => {
      const { first, press } = await firstPress("Decide alone", "orchestrator");
      failTurn(first);
      press(FOLDERS[1]);

      assert.equal(workflows.pickUpsOf(workflows.getInstance(first)!)[0]?.kind, "orchestrator");
      assert.deepEqual(workflows.retryOrchestratorBlock(first, "O"), { ok: true });
    }));

  it("refuses reopening a member run on its own page while a newer press works in its folder", () =>
    held(async () => {
      const { workflow, first, press } = await firstPress("Build per project", "run");
      const member = workflows.getInstance(first)!.nodes[0];
      assert.ok(member, "press 1 created its run");
      dbMod
        .db()
        .prepare("UPDATE runs SET status='failed', iterations=1, finished_at=? WHERE id=?")
        .run(Date.now(), member.runId);
      assert.equal(workflows.liveInstancesOf(workflow.id).length, 0);
      press(FOLDERS[0]);

      const run = orch.getRun(member.runId)!;
      const outcome = orch.reopenRun(run.id, JSON.parse(run.budget) as unknown);
      assert.equal(outcome.ok, false, "the member was reopened beside press 2");
      assert.match(!outcome.ok ? outcome.reason : "", /from another press of Run have not finished yet/);
      assert.equal(orch.getRun(member.runId)!.status, "failed", "a refusal writes nothing");
    }));
});
