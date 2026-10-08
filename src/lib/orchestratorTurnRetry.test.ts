import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type Database from "better-sqlite3";

/**
 * Covers one thing: an orchestrator block whose deciding turn failed is started
 * again, up to `turnRetries` times, inside the one press of Run — and which
 * endings must not be.
 *
 * `blockTurnRetries` is the decision and is unit-tested beside the other pure
 * ones in `workflows.test.ts`. What is left is everything it cannot see, each of
 * which is silent: a retry that skips `startBlockTurn` skips the instance
 * budget, so the workflow limit stops bounding a block that is billing; a retry
 * that does not bank the attempt before it makes the block cheaper than it was
 * and the instance total with it; a halt's dying child read as a failed turn
 * buys a second child for a workflow the operator stopped.
 *
 * It spawns real children against a stub `claude` whose outcome per invocation
 * is read from a plan file, and counts the invocations — the only evidence that
 * a second turn was or was not started. Its own file for `orchestratorPickUp`'s
 * reason: `advanceInstances` acts on every started instance, so a block left
 * running would be claimed against another file's fixtures.
 */

let root: string;
let stubDir: string;
let workflows: typeof import("./workflows");
let settings: typeof import("./settings");
let dbMod: typeof import("./db");
let assists: number | null;

const STUB = (dir: string) => `#!/usr/bin/env node
const fs = require("node:fs");
const dir = ${JSON.stringify(dir)};
const calls = fs.existsSync(dir + "/calls") ? Number(fs.readFileSync(dir + "/calls", "utf8")) : 0;
fs.writeFileSync(dir + "/calls", String(calls + 1));
const plan = JSON.parse(fs.readFileSync(dir + "/plan.json", "utf8"));
const outcome = plan[calls] || "ok";
const session = "stub-session-" + calls;
const usage = { input_tokens: 10, output_tokens: 5 };
const write = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
write({ type: "system", subtype: "init", session_id: session });
if (outcome === "hang") {
  process.on("SIGINT", () => process.exit(130));
  setInterval(() => {}, 1000);
} else if (outcome === "die") {
  process.stderr.write("The stub went away.\\n");
  process.exit(1);
} else if (outcome === "fail") {
  write({ type: "result", subtype: "error_during_execution", is_error: true, session_id: session, result: "It broke.", total_cost_usd: 0.2, usage });
} else {
  write({ type: "result", subtype: "success", is_error: false, session_id: session, result: "Nothing to start.", total_cost_usd: 0.1, usage });
}
`;

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-orch-turn-retry-")));
  const workspace = path.join(root, "workspace");
  stubDir = path.join(root, "stub");
  fs.mkdirSync(path.join(root, "claude", "projects"), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(stubDir, { recursive: true });
  const stub = path.join(root, "claude-stub.js");
  fs.writeFileSync(stub, STUB(stubDir), { mode: 0o755 });

  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = workspace;
  process.env.WORKSPACE_ROOTS = "";
  process.env.CLAUDE_BIN = stub;

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );

  workflows = await import("./workflows");
  settings = await import("./settings");
  dbMod = await import("./db");
  // A turn holds a slot while it is `thinking`; a block refused one stays
  // `waiting`, which would read as the claim not happening.
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
  fs.rmSync(path.join(stubDir, "calls"), { force: true });
});

/** What each successive invocation of the stub does: ok, fail, die or hang. */
function plan(...outcomes: string[]): void {
  fs.writeFileSync(path.join(stubDir, "plan.json"), JSON.stringify(outcomes));
}

function calls(): number {
  const file = path.join(stubDir, "calls");
  return fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what: string, ready: () => boolean): Promise<void> {
  for (let tries = 0; tries < 600 && !ready(); tries += 1) await sleep(10);
  assert.equal(ready(), true, `never happened: ${what}`);
}

function graphWith(turnRetries: number | undefined): string {
  return JSON.stringify({
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
        ...(turnRetries === undefined ? {} : { turnRetries }),
      },
    ],
    edges: [],
  });
}

/**
 * A started instance with one orchestrator block, in the status given.
 * Inserted rather than built through `startWorkflow`, which would want a git
 * probe and a mount; the block's own turn is what is under test.
 */
function instance(
  id: string,
  over: {
    turnRetries?: number;
    status?: "waiting" | "thinking";
    budget?: Record<string, number>;
    specs?: string | null;
  } = {},
): string {
  const now = Date.now();
  const graph = graphWith(over.turnRetries);
  dbMod
    .db()
    .prepare(
      "INSERT INTO workflows (id, name, graph, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(`wf-${id}`, `Decide ${id}`, graph, now, now);
  dbMod
    .db()
    .prepare(
      `INSERT INTO workflow_instances
         (id, workflow_id, workflow_name, graph, created_at, status, instance_budget)
       VALUES (?, ?, ?, ?, ?, 'started', ?)`,
    )
    .run(id, `wf-${id}`, `Decide ${id}`, graph, now, over.budget ? JSON.stringify(over.budget) : null);
  dbMod
    .db()
    .prepare(
      `INSERT INTO workflow_instance_blocks
         (instance_id, node_id, node_name, position, kind, status, started_at, emitted_specs)
       VALUES (?, 'o', 'Decide', 0, 'orchestrator', ?, ?, ?)`,
    )
    .run(id, over.status ?? "waiting", over.status === "thinking" ? now : null, over.specs ?? null);
  return id;
}

interface BlockRow {
  status: string;
  error: string | null;
  notes: string | null;
  cost_usd: number;
  cost_unreported: number;
  tokens: number;
  emitted_specs: string | null;
}

function block(id: string): BlockRow {
  return dbMod
    .db()
    .prepare("SELECT * FROM workflow_instance_blocks WHERE instance_id=? AND node_id='o'")
    .get(id) as BlockRow;
}

const thinking = (id: string) => block(id).status === "thinking";

/** Claim the block and let its turn, and any retry of it, end. */
async function run(id: string): Promise<BlockRow> {
  workflows.advanceInstances();
  await until("the block was claimed", () => block(id).status !== "waiting");
  await until("the block settled", () => !thinking(id));
  return block(id);
}

const FAILED = { status: "failed", error: "The CLI exited 1.", costUSD: 0.2 } as const;

describe("an orchestrator block whose deciding turn failed", () => {
  it("is started again, and the block succeeds when that attempt does", async () => {
    plan("fail", "ok");
    const id = instance("retry", { turnRetries: 1 });
    const after = await run(id);

    assert.equal(calls(), 2, "the second attempt was a second child");
    assert.equal(after.status, "emitted");
    assert.equal(after.error, null, "the failed attempt is not the block's verdict");
    assert.match(after.notes ?? "", /Attempt 1 of 2 failed: It broke\. Starting the turn again\./);
    // Both attempts are on the one row: the failed turn's 0.2 and the retry's 0.1.
    assert.ok(Math.abs(after.cost_usd - 0.3) < 1e-9, `cost_usd ${after.cost_usd}`);
    assert.equal(after.tokens, 30);
  });

  it("settles failed at once when it saved no retries", async () => {
    for (const turnRetries of [0, undefined]) {
      fs.rmSync(path.join(stubDir, "calls"), { force: true });
      plan("fail", "ok");
      const id = instance(`none-${String(turnRetries)}`, { turnRetries });
      const after = await run(id);
      assert.equal(calls(), 1, `turnRetries ${String(turnRetries)}`);
      assert.equal(after.status, "failed");
      assert.equal(after.error, "It broke.");
      assert.doesNotMatch(after.notes ?? "", /Attempt/);
    }
  });

  it("stops at the limit it saved, and is failed with the last attempt's error", async () => {
    plan("fail", "die", "ok");
    const id = instance("limit", { turnRetries: 1 });
    const after = await run(id);

    assert.equal(calls(), 2, "one retry, not a third turn");
    assert.equal(after.status, "failed");
    assert.match(after.error ?? "", /The stub went away/);
    assert.match(after.notes ?? "", /Attempt 1 of 2 failed/);
    assert.doesNotMatch(after.notes ?? "", /Attempt 2/);
  });

  it("banks a turn that never reported a cost as unreported, attempt by attempt", async () => {
    plan("die", "fail", "ok");
    const id = instance("three", { turnRetries: 2 });
    const after = await run(id);

    assert.equal(calls(), 3);
    assert.equal(after.status, "emitted");
    assert.equal(after.cost_unreported, 1, "the turn that died is the one gap");
    assert.ok(Math.abs(after.cost_usd - 0.3) < 1e-9, `cost_usd ${after.cost_usd}`);
  });

  it("is not started again after an operator's stop", async () => {
    plan("hang", "ok");
    const id = instance("stopped", { turnRetries: 2 });
    workflows.advanceInstances();
    await until("the first child started", () => calls() === 1);

    assert.equal(workflows.stopInstance(id, { kind: "operator" }).ok, true);
    // The dying child's turn is banked as one that never reported, and that
    // write is the evidence its ending was read.
    await until("the stopped turn was read", () => block(id).cost_unreported === 1);
    await sleep(300);

    assert.equal(calls(), 1, "a halt's dying child is not a failed turn to retry");
    assert.equal(block(id).status, "failed");
    // Several things stop a second child from being spawned; only the decision
    // itself keeps the block's notes from saying it was about to be.
    assert.doesNotMatch(block(id).notes ?? "", /Attempt/);
  });

  it("checks the instance budget before starting it again", async () => {
    plan("fail", "ok");
    const id = instance("budget", { turnRetries: 2, budget: { maxInstanceCostUSD: 0.15 } });
    const after = await run(id);
    await sleep(300);

    // The first attempt was started under a total of zero. The retry would have
    // been the second, with the failed attempt's 0.2 already over the limit.
    assert.equal(calls(), 1, "the limit stopped it before the second child was spawned");
    assert.equal(after.status, "failed");
    assert.ok(Math.abs(after.cost_usd - 0.2) < 1e-9, "the attempt that spent is on the row");
    const instanceRow = dbMod
      .db()
      .prepare("SELECT status, stop_cause AS cause FROM workflow_instances WHERE id=?")
      .get(id) as { status: string; cause: string };
    assert.equal(instanceRow.cause, "guard");
    assert.notEqual(instanceRow.status, "started");
  });

  it("is started again under a budget that has room, so the case above is the limit", async () => {
    plan("fail", "ok");
    const id = instance("room", { turnRetries: 2, budget: { maxInstanceCostUSD: 5 } });
    const after = await run(id);
    assert.equal(calls(), 2);
    assert.equal(after.status, "emitted");
  });

  it("is not started again when this app refused what it tried to emit", async () => {
    plan("ok", "ok");
    const id = instance("refused", { turnRetries: 2, status: "thinking" });
    const refusal = workflows.emitBlockRuns(id, "o", "not a list");
    assert.equal(refusal.ok, false);

    workflows.settleBlockTurn(id, "o", FAILED, 0);

    assert.equal(block(id).status, "failed");
    assert.match(block(id).notes ?? "", /It tried to emit runs and was refused/);
    await sleep(300);
    assert.equal(calls(), 0, "nothing was spawned");

    // The same ending without the refusal is started again, so the case above is
    // the refusal and not a fixture that cannot retry.
    const control = instance("control", { turnRetries: 2, status: "thinking" });
    workflows.settleBlockTurn(control, "o", FAILED, 0);
    await until("the control retried", () => calls() === 1);
    await until("the control settled", () => !thinking(control));
    assert.equal(block(control).status, "emitted");
  });

  it("clears a stored empty decision, so the new turn can emit", async () => {
    plan("ok");
    const id = instance("empty", { turnRetries: 1, status: "thinking", specs: "[]" });
    workflows.settleBlockTurn(id, "o", FAILED, 0);

    // Straight after the call, before the new turn could have written anything:
    // `[]` is a set column and `emitBlockRuns` refuses a block whose column is.
    assert.equal(block(id).emitted_specs, null);
    await until("the retry settled", () => !thinking(id));
  });
});
