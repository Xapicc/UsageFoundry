import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { WorkflowGraph, WorkflowNode } from "./workflowGraph";

/**
 * Which gate created each run, driven through the gates rather than asserted
 * about them.
 *
 * The point of the column is that it is *recorded* rather than deduced, so the
 * only test that says anything is one that goes through the real creation
 * paths: a `createRun({origin: "chat"})` written here would pin this file's own
 * argument and nothing about `approveProposal`. Every one of the five is
 * silent when it is wrong — the run starts, works and lands exactly as before,
 * and the only symptom is a row that says a person filled in a form when a
 * model decided it, months later, when somebody is trying to scope what a
 * stolen token did.
 *
 * Three of the five start an agent with nobody at the keyboard, which is the
 * whole reason the distinction is worth a column: `workflow` and `schedule` are
 * the same graph and the same `startWorkflow`, differing only in whether a
 * person pressed anything, and `orchestrator-block` is the one origin no person
 * chose run by run.
 *
 * Its own file with `DATA_DIR` named before the first import, for
 * `bootBlocks.test.ts`'s reason: `config.ts` is read at module load, so a file
 * that imported `orchestrator.ts` at the top would already be bound to the
 * repository's own `.data` — which on a developer's machine is the real one.
 */

let root: string;
let workspace: string;
let orch: typeof import("./orchestrator");
let workflows: typeof import("./workflows");
let chat: typeof import("./chat");
let dbMod: typeof import("./db");

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-run-origin-"));
  workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(workspace, "project"), { recursive: true });
  // A repository with a commit on it, for the loop's sake only: a repeated
  // block has to land every pass, and `startWorkflow` refuses a loop whose
  // section works in a folder git cannot use.
  const repo = path.join(workspace, "repo");
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "-A"],
    ["commit", "-q", "-m", "first"],
  ]) {
    execFileSync("git", args, {
      cwd: repo,
      // An identity of the fixture's own: a machine running the suite need not
      // have one configured.
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
  }
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = workspace;
  // Wins over WORKSPACE_ROOT, and any container this ships in has it set.
  process.env.WORKSPACE_ROOTS = `Scratch=${workspace}`;
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
  chat = await import("./chat");
  dbMod = await import("./db");

  // The snapshot every creation path reads asks the provider for its own
  // utilisation, and there is no network here — see the same line in
  // `src/app/api/status/route.test.ts`.
  const { saveSettings } = await import("./settings");
  saveSettings({ planUsageFromApi: false });
});

after(async () => {
  // Every case here creates a real run, and `createRun` ends in
  // `promoteQueued`, which starts one in the background — a transcript scan and
  // a spawn of a `claude` that does not exist. Given a tick to fall over on its
  // own, and the handle left **open**: closing it out from under that work
  // turns a run that was always going to fail into an unhandled rejection about
  // a closed database, which is a failure about this file rather than the code.
  await new Promise((resolve) => setTimeout(resolve, 50));
  delete process.env.WORKSPACE_ROOTS;
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A folder claim is a folder claim: two of these cases point at the same
 * directory, and a run left `queued` from the previous case would hold it.
 */
beforeEach(() => {
  for (const table of [
    "workflow_instance_blocks",
    "workflow_instance_runs",
    "workflow_instances",
    "workflows",
    "chat_proposals",
    "chat_messages",
    "chat_sessions",
    "run_deps",
    "runs",
  ]) {
    dbMod.db().prepare(`DELETE FROM ${table}`).run();
  }
});

/** The two audit columns, straight off the row rather than through a DTO. */
function originOf(runId: string): { origin: string | null; ref: string | null } {
  const row = dbMod
    .db()
    .prepare("SELECT origin, origin_ref AS ref FROM runs WHERE id = ?")
    .get(runId) as { origin: string | null; ref: string | null };
  return row;
}

/** Every field a saved graph carries, so a fixture states only what it means. */
function block(
  id: string,
  kind: WorkflowNode["kind"],
  over: Partial<WorkflowNode> = {},
): WorkflowNode {
  return {
    id,
    name: `Do ${id}`,
    kind,
    templateId: null,
    // A loop frames the blocks it repeats and runs nothing itself, so a saved
    // one carries no workspace and no task.
    mountId: kind === "loop" ? "" : "scratch",
    folder: kind === "loop" ? "" : "project",
    task: kind === "loop" ? "" : "do the thing",
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
    ...over,
  };
}

function runBlockGraph(kind: "run" | "orchestrator"): WorkflowGraph {
  return { nodes: [block("A", kind)], edges: [] };
}

describe("every creation path records the gate it came through", () => {
  it("the run form", async () => {
    const { POST } = await import("../app/api/runs/route");
    const res = await POST(
      new Request("http://localhost/api/runs", {
        method: "POST",
        body: JSON.stringify({
          folder: "project",
          mountId: "scratch",
          prompt: "do the thing",
          budget: { maxIterations: 1 },
        }),
      }),
    );
    const body = (await res.json()) as { run?: { id: string }; error?: string };
    assert.ok(body.run, `the form's own route refused the run: ${body.error}`);

    assert.deepEqual(originOf(body.run.id), { origin: "form", ref: null });
  });

  it("an approved chat proposal, naming the proposal that authorised it", () => {
    const session = chat.createChat();
    const proposal = chat.createProposal(session.id, {
      templateId: null,
      title: "Fix a bug",
      task: "do the thing",
      promptOverride: null,
      mountId: "scratch",
      folder: "project",
    });

    const outcome = chat.approveProposal(proposal.id);
    assert.ok(outcome.ok, `approval refused: ${!outcome.ok && outcome.reason}`);

    assert.deepEqual(originOf(outcome.runId), {
      origin: "chat",
      // The proposal, not the chat: a thread holds many, and only one of them
      // authorised this run.
      ref: proposal.id,
    });
  });

  it("a press of Run on a workflow, naming the instance", async () => {
    const workflow = workflows.createWorkflow({
      name: "By hand",
      graph: runBlockGraph("run"),
      instanceBudget: {
        maxInstanceCostUSD: null,
        maxSessionFraction: null,
        maxWeeklyFraction: null,
      },
    });
    const outcome = workflows.startWorkflow(
      workflow.id,
      await orch.currentSnapshot(),
    );
    assert.ok(outcome.ok, `start refused: ${!outcome.ok && outcome.reason}`);

    const member = dbMod
      .db()
      .prepare("SELECT run_id AS id FROM workflow_instance_runs WHERE instance_id = ?")
      .get(outcome.instance.id) as { id: string };
    assert.deepEqual(originOf(member.id), {
      origin: "workflow",
      ref: outcome.instance.id,
    });
  });

  it("a schedule firing, naming the schedule rather than the instance", async () => {
    const workflow = workflows.createWorkflow({
      name: "On a timer",
      graph: runBlockGraph("run"),
      instanceBudget: {
        maxInstanceCostUSD: null,
        maxSessionFraction: null,
        maxWeeklyFraction: null,
      },
    });
    const outcome = workflows.startWorkflow(
      workflow.id,
      await orch.currentSnapshot(),
      { kind: "schedule", scheduleId: "sched-1" },
    );
    assert.ok(outcome.ok, `start refused: ${!outcome.ok && outcome.reason}`);

    const member = dbMod
      .db()
      .prepare("SELECT run_id AS id FROM workflow_instance_runs WHERE instance_id = ?")
      .get(outcome.instance.id) as { id: string };
    // The same graph and the same `startWorkflow` as the case above; the only
    // difference is that nobody was present, which is the one an audit is for.
    assert.deepEqual(originOf(member.id), {
      origin: "schedule",
      ref: "sched-1",
    });
  });

  it("an orchestrator block's own decision, even inside a scheduled instance", async () => {
    const workflow = workflows.createWorkflow({
      name: "It decides",
      graph: runBlockGraph("orchestrator"),
      instanceBudget: {
        maxInstanceCostUSD: null,
        maxSessionFraction: null,
        maxWeeklyFraction: null,
      },
    });
    const outcome = workflows.startWorkflow(
      workflow.id,
      await orch.currentSnapshot(),
      { kind: "schedule", scheduleId: "sched-2" },
    );
    assert.ok(outcome.ok, `start refused: ${!outcome.ok && outcome.reason}`);

    // What `startBlockTurn` does before it spawns. The turn itself needs a real
    // child; what is under test is what the emission writes.
    dbMod
      .db()
      .prepare(
        "UPDATE workflow_instance_blocks SET status='thinking' WHERE instance_id=? AND node_id=?",
      )
      .run(outcome.instance.id, "A");

    const emission = workflows.emitBlockRuns(outcome.instance.id, "A", [
      { id: "s1", title: "Emitted", task: "do the emitted thing", folder: "project" },
    ]);
    assert.ok(emission.ok, `emission refused: ${!emission.ok && emission.reason}`);


    // The specs are only *recorded* by the emission; the runs are created when
    // the turn settles, which on a real block is a child process exiting.
    workflows.settleBlock(outcome.instance.id, "A", { status: "idle", text: "done" });
    const emitted = dbMod
      .db()
      .prepare(
        "SELECT run_id AS id FROM workflow_instance_runs WHERE instance_id = ? AND emitted_by = 'A'",
      )
      .get(outcome.instance.id) as { id: string };
    // Not the instance's `schedule`: what authorised *this* run is a model's
    // decision taken moments ago, which no person chose run by run.
    assert.deepEqual(originOf(emitted.id), {
      origin: "orchestrator-block",
      ref: "A",
    });
    const decider = workflows.blocksOf(outcome.instance.id).find((b) => b.nodeId === "A");
    assert.deepEqual(
      { emitted: decider?.emitted, started: decider?.started },
      { emitted: 1, started: 1 },
    );
  });
});

/**
 * Which saved folder a press of Run, or a schedule, starts its runs in.
 *
 * Here rather than beside `chooseFolder`'s own cases because the failure it
 * guards is past that function: a choice that was checked and then not the
 * folder `createRun` was handed is an agent in a repository nobody chose, and
 * only the run row says which one it got.
 */
describe("a workflow saved against more than one folder", () => {
  const FOLDERS = [
    { mountId: "scratch", folder: "project" },
    { mountId: "scratch", folder: "second" },
  ];

  function folderOf(instanceId: string): string {
    const row = dbMod
      .db()
      .prepare(
        `SELECT r.folder FROM workflow_instance_runs m JOIN runs r ON r.id = m.run_id
          WHERE m.instance_id = ?`,
      )
      .get(instanceId) as { folder: string };
    return row.folder;
  }

  function saveTwoFolderWorkflow(name: string) {
    fs.mkdirSync(path.join(workspace, "second"), { recursive: true });
    return workflows.createWorkflow({
      name,
      graph: {
        nodes: [block("run", "run", { followsChosenFolder: true })],
        edges: [],
      },
      instanceBudget: {
        maxInstanceCostUSD: null,
        maxSessionFraction: null,
        maxWeeklyFraction: null,
      },
      folders: FOLDERS,
    });
  }

  it("starts a person's press in the saved folder they chose, and records it", async () => {
    const workflow = saveTwoFolderWorkflow("Either project");
    const outcome = workflows.startWorkflow(workflow.id, await orch.currentSnapshot(), {
      kind: "manual",
      folder: FOLDERS[1],
    });
    assert.ok(outcome.ok, `start refused: ${!outcome.ok && outcome.reason}`);
    assert.equal(path.basename(folderOf(outcome.instance.id)), "second");
    assert.deepEqual(outcome.instance.chosenFolder, FOLDERS[1]);
    assert.equal(outcome.instance.graph.nodes[0].folder, "second");
  });

  it("refuses a folder that is not saved on the workflow, and starts nothing", async () => {
    const workflow = saveTwoFolderWorkflow("Only saved ones");
    const outcome = workflows.startWorkflow(workflow.id, await orch.currentSnapshot(), {
      kind: "manual",
      folder: { mountId: "scratch", folder: "repo" },
    });
    assert.ok(!outcome.ok);
    assert.match(outcome.reason, /not one of the folders saved on this workflow/);
    const count = dbMod.db().prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number };
    assert.equal(count.n, 0);
  });

  it("starts presses against two saved folders side by side, and refuses one into the same folder", async () => {
    const workflow = saveTwoFolderWorkflow("Both projects at once");
    // One snapshot and no await between the presses, so the first press's run
    // is still live when the second and third are asked.
    const snapshot = await orch.currentSnapshot();
    const first = workflows.startWorkflow(workflow.id, snapshot, { kind: "manual", folder: FOLDERS[0] });
    assert.ok(first.ok, `start refused: ${!first.ok && first.reason}`);

    const again = workflows.startWorkflow(workflow.id, snapshot, { kind: "manual", folder: FOLDERS[0] });
    assert.ok(!again.ok);
    assert.match(again.reason, /share no folder/);

    const beside = workflows.startWorkflow(workflow.id, snapshot, { kind: "manual", folder: FOLDERS[1] });
    assert.ok(beside.ok, `start refused: ${!beside.ok && beside.reason}`);
    assert.equal(path.basename(folderOf(beside.instance.id)), "second");
    assert.equal(workflows.liveInstancesOf(workflow.id).length, 2);
  });

  it("refuses a press against another folder while a block with its own folder is shared", async () => {
    fs.mkdirSync(path.join(workspace, "second"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "tools"), { recursive: true });
    const workflow = workflows.createWorkflow({
      name: "Both projects, one toolbox",
      graph: {
        nodes: [
          block("run", "run", { followsChosenFolder: true }),
          block("lint", "run", { folder: "tools" }),
        ],
        edges: [],
      },
      instanceBudget: {
        maxInstanceCostUSD: null,
        maxSessionFraction: null,
        maxWeeklyFraction: null,
      },
      folders: FOLDERS,
    });
    const snapshot = await orch.currentSnapshot();
    const first = workflows.startWorkflow(workflow.id, snapshot, { kind: "manual", folder: FOLDERS[0] });
    assert.ok(first.ok, `start refused: ${!first.ok && first.reason}`);

    const other = workflows.startWorkflow(workflow.id, snapshot, { kind: "manual", folder: FOLDERS[1] });
    assert.ok(!other.ok);
    assert.match(other.reason, /“Do lint” names its own folder/);
    assert.equal(workflows.liveInstancesOf(workflow.id).length, 1);
  });

  it("starts a schedule in the first saved folder", async () => {
    const workflow = saveTwoFolderWorkflow("Nightly, either project");
    const outcome = workflows.startWorkflow(workflow.id, await orch.currentSnapshot(), {
      kind: "schedule",
      scheduleId: "sched-folders",
    });
    assert.ok(outcome.ok, `start refused: ${!outcome.ok && outcome.reason}`);
    assert.equal(path.basename(folderOf(outcome.instance.id)), "project");
    assert.deepEqual(outcome.instance.chosenFolder, FOLDERS[0]);
  });
});

/**
 * The runs a scheduled instance creates after `startWorkflow` has returned.
 *
 * The cases above only see the creating pass, which is handed its origin as an
 * argument. Everything created later — a node behind an orchestrator block, a
 * loop's pass — reads it back off the stored instance, so a read path that
 * drops the column is invisible to them and stamps every such run as a press
 * of Run.
 */
describe("a scheduled instance's later runs are still the schedule's", () => {
  async function startScheduled(
    name: string,
    graph: WorkflowGraph,
    scheduleId: string,
  ): Promise<string> {
    const workflow = workflows.createWorkflow({
      name,
      graph,
      instanceBudget: {
        maxInstanceCostUSD: null,
        maxSessionFraction: null,
        maxWeeklyFraction: null,
      },
    });
    const outcome = workflows.startWorkflow(
      workflow.id,
      await orch.currentSnapshot(),
      { kind: "schedule", scheduleId },
    );
    assert.ok(outcome.ok, `start refused: ${!outcome.ok && outcome.reason}`);
    return outcome.instance.id;
  }

  function memberRun(instanceId: string, where: string): { id: string } | undefined {
    return dbMod
      .db()
      .prepare(`SELECT run_id AS id FROM workflow_instance_runs WHERE instance_id = ? AND ${where}`)
      .get(instanceId) as { id: string } | undefined;
  }

  it("a node behind an orchestrator block, created once the block's runs finish", async () => {
    const instanceId = await startScheduled(
      "Decide, then follow up",
      {
        nodes: [block("O", "orchestrator"), block("B", "run")],
        edges: [{ from: "O", to: "B", edge: "on-success", continueBranch: false }],
      },
      "sched-3",
    );

    dbMod
      .db()
      .prepare(
        "UPDATE workflow_instance_blocks SET status='thinking' WHERE instance_id=? AND node_id=?",
      )
      .run(instanceId, "O");
    const emission = workflows.emitBlockRuns(instanceId, "O", [
      { id: "s1", title: "Emitted", task: "do the emitted thing", folder: "project" },
    ]);
    assert.ok(emission.ok, `emission refused: ${!emission.ok && emission.reason}`);
    workflows.settleBlock(instanceId, "O", { status: "idle", text: "done" });

    const emitted = memberRun(instanceId, "emitted_by = 'O'");
    assert.ok(emitted, "the orchestrator block's turn created no run");
    assert.equal(memberRun(instanceId, "node_id = 'B'"), undefined, "B started early");
    dbMod
      .db()
      .prepare("UPDATE runs SET status='completed', iterations=1, finished_at=? WHERE id=?")
      .run(Date.now(), emitted.id);
    workflows.advanceInstances();

    const deferred = memberRun(instanceId, "node_id = 'B'");
    assert.ok(deferred, "B was not created once the block's runs had finished");
    // Created hours after the fire, by nobody: the schedule authorised it, and
    // `workflow` here is a row saying a person pressed Run.
    assert.deepEqual(originOf(deferred.id), { origin: "schedule", ref: "sched-3" });
  });

  it("a member of a loop's pass", async () => {
    const instanceId = await startScheduled(
      "Chip away",
      {
        nodes: [
          block("L", "loop", { maxPasses: 1, bodyNodeIds: ["B", "M"] }),
          block("B", "run", { folder: "repo" }),
          block("M", "merge", { folder: "", mergeStrategy: "merge" }),
        ],
        edges: [
          { from: "L", to: "B", edge: "repeats", continueBranch: false },
          { from: "B", to: "M", edge: "on-success", continueBranch: false },
        ],
      },
      "sched-4",
    );

    const member = memberRun(instanceId, "emitted_by = 'L'");
    assert.ok(member, "the loop opened no pass");
    // Not `orchestrator-block` either: no model decided a pass, and the fire
    // that authorised the graph authorised every pass its cap allows.
    assert.deepEqual(originOf(member.id), { origin: "schedule", ref: "sched-4" });
  });
});

describe("picking a run up again", () => {
  it("is recorded without rewriting where the run came from", async () => {
    const run = orch.createRun({
      folder: "project",
      mountId: "scratch",
      prompt: "do the thing",
      budget: { maxIterations: 1 },
      origin: "chat",
      originRef: "proposal-7",
    });
    dbMod
      .db()
      .prepare("UPDATE runs SET status='stopped', finished_at=? WHERE id=?")
      .run(Date.now(), run.id);

    const outcome = orch.reopenRun(run.id, { maxIterations: 3 });
    assert.ok(outcome.ok, `reopen refused: ${!outcome.ok && outcome.reason}`);

    const row = dbMod
      .db()
      .prepare("SELECT origin, origin_ref AS ref, reopened_at AS reopenedAt FROM runs WHERE id=?")
      .get(run.id) as { origin: string; ref: string; reopenedAt: number | null };

    // A reopen creates nothing. Writing "reopen" here would lose the one fact
    // the column exists for while `created_at` went on pointing at the original
    // creation — so it lands on its own column, and on the request log.
    assert.equal(row.origin, "chat");
    assert.equal(row.ref, "proposal-7");
    assert.ok(
      row.reopenedAt !== null && Date.now() - row.reopenedAt < 60_000,
      "a run picked up again has to say when",
    );
  });
});

/**
 * An orchestrator block whose runs this app could not create.
 *
 * Here rather than in the pure suite because both halves of the failure are
 * what `settleBlock` writes — the block's own row and the verdict the advance
 * pass writes onto the block behind it — and this is the file that already
 * drives an emission through `emitBlockRuns` and `settleBlock` against a real
 * mount. Silent both ways: the row read as the turn having failed, and the block
 * behind it said the model had decided to start nothing, when it had decided on
 * work that was then lost to a folder removed between the decision and the start.
 */
describe("an orchestrator block none of whose decided runs could be started", () => {
  it("notes why on itself and says so to the block behind it", async () => {
    fs.mkdirSync(path.join(workspace, "project", "sub"), { recursive: true });
    const workflow = workflows.createWorkflow({
      name: "Decide into a folder that goes",
      graph: {
        nodes: [block("O", "orchestrator"), block("B", "run")],
        edges: [{ from: "O", to: "B", edge: "on-finish", continueBranch: false }],
      },
      instanceBudget: {
        maxInstanceCostUSD: null,
        maxSessionFraction: null,
        maxWeeklyFraction: null,
      },
    });
    const outcome = workflows.startWorkflow(workflow.id, await orch.currentSnapshot());
    assert.ok(outcome.ok, `start refused: ${!outcome.ok && outcome.reason}`);
    const instanceId = outcome.instance.id;

    dbMod
      .db()
      .prepare(
        "UPDATE workflow_instance_blocks SET status='thinking' WHERE instance_id=? AND node_id=?",
      )
      .run(instanceId, "O");
    const emission = workflows.emitBlockRuns(instanceId, "O", [
      { id: "E3", title: "E3", task: "do the emitted thing", folder: "project/sub" },
    ]);
    assert.ok(emission.ok, `emission refused: ${!emission.ok && emission.reason}`);
    // Between the decision and the start, which is the window a spec is
    // re-resolved across.
    fs.rmSync(path.join(workspace, "project", "sub"), { recursive: true });
    workflows.settleBlock(instanceId, "O", { status: "idle", text: "Started E3." });

    const rowOf = (nodeId: string) =>
      dbMod
        .db()
        .prepare(
          "SELECT status, error, notes FROM workflow_instance_blocks WHERE instance_id=? AND node_id=?",
        )
        .get(instanceId, nodeId) as { status: string; error: string | null; notes: string | null };

    const decider = rowOf("O");
    assert.equal(decider.status, "emitted");
    assert.equal(decider.error, null, "the turn did not fail; this app did");
    assert.match(decider.notes ?? "", /“E3” could not be started: .*project\/sub/);
    // What the instance page's status line reads: decided on one, started none.
    const deciderBlock = workflows.blocksOf(instanceId).find((b) => b.nodeId === "O");
    assert.deepEqual(
      { emitted: deciderBlock?.emitted, started: deciderBlock?.started },
      { emitted: 1, started: 0 },
    );

    const follower = rowOf("B");
    assert.equal(follower.status, "blocked");
    assert.doesNotMatch(follower.error ?? "", /decided there was nothing/);
    assert.match(follower.error ?? "", /“Do O” decided on 1 run\(s\), but none of them could be started/);
    assert.match(follower.error ?? "", /“E3” could not be started: .*project\/sub/);
  });
});

/**
 * A template that pins a model the operator's list has switched off.
 *
 * Here for the reason the describe above is: what matters is that every place a
 * workflow creates a run asks, and a pure suite can only say the question is
 * right. The run form refuses the same template at Start; the template door
 * cannot, because a template outlives the list. Silent otherwise — the run
 * starts, on a model the operator turned off, from a press of Run or a schedule.
 */
describe("a workflow whose template pins a switched-off model", () => {
  const MODEL = "claude-haiku-5-5";

  let settings: typeof import("./settings");
  let templates: typeof import("./templates");
  // Loaded once so the switch below is synchronous: a run a press of Run
  // created fails to spawn on the next event-loop turn, and a block behind it
  // is then written off before the case has had its say.
  before(async () => {
    settings = await import("./settings");
    templates = await import("./templates");
  });

  function withModel(enabled: boolean): () => void {
    const original = settings.getSettings().modelCatalogue;
    assert.ok(
      original.some((entry) => entry.id === MODEL),
      `${MODEL} left the seeded list; pick another id for this case`,
    );
    settings.saveSettings({
      modelCatalogue: original.map((entry) => (entry.id === MODEL ? { ...entry, enabled } : entry)),
    });
    return () => settings.saveSettings({ modelCatalogue: original });
  }

  function pinnedTemplate() {
    return templates.createTemplate({
      name: `Pins ${MODEL} ${Math.random().toString(36).slice(2)}`,
      prompt: "Work carefully.",
      mountId: null,
      folder: null,
      isolate: false,
      permissionMode: "plan",
      agentId: null,
      model: MODEL,
      budget: settings.chatGuards().budget,
    });
  }

  const instanceBudget = { maxInstanceCostUSD: null, maxSessionFraction: null, maxWeeklyFraction: null };

  it("is refused at a press of Run for a run block and an orchestrator block alike, and starts once the model is back", async () => {
    const restore = withModel(false);
    try {
      const template = pinnedTemplate();
      for (const kind of ["run", "orchestrator"] as const) {
        const workflow = workflows.createWorkflow({
          name: `Pinned ${kind}`,
          graph: { nodes: [block("A", kind, { templateId: template.id })], edges: [] },
          instanceBudget,
        });
        const refused = workflows.startWorkflow(workflow.id, await orch.currentSnapshot());
        assert.equal(refused.ok, false, kind);
        const reason = refused.ok ? "" : refused.reason;
        assert.match(reason, /“Do A”/, kind);
        assert.match(reason, new RegExp(`Model "${MODEL}" is switched off for this install`), kind);
        assert.equal(
          (dbMod.db().prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n,
          0,
          `${kind}: a refused press created nothing`,
        );
      }

      withModel(true);
      const workflow = workflows.createWorkflow({
        name: "Pinned and back on",
        graph: { nodes: [block("A", "run", { templateId: template.id })], edges: [] },
        instanceBudget,
      });
      const started = workflows.startWorkflow(workflow.id, await orch.currentSnapshot());
      assert.ok(started.ok, `start refused: ${!started.ok && started.reason}`);
    } finally {
      restore();
    }
  });

  it("is refused for an emitted run when the model is switched off after the block started", async () => {
    fs.mkdirSync(path.join(workspace, "project", "sub"), { recursive: true });
    const restore = withModel(true);
    try {
      const template = pinnedTemplate();
      const workflow = workflows.createWorkflow({
        name: "Emit onto a retired model",
        graph: { nodes: [block("O", "orchestrator", { templateId: template.id })], edges: [] },
        instanceBudget,
      });
      const outcome = workflows.startWorkflow(workflow.id, await orch.currentSnapshot());
      assert.ok(outcome.ok, `start refused: ${!outcome.ok && outcome.reason}`);
      const instanceId = outcome.instance.id;
      dbMod
        .db()
        .prepare(
          "UPDATE workflow_instance_blocks SET status='thinking' WHERE instance_id=? AND node_id=?",
        )
        .run(instanceId, "O");
      const emission = workflows.emitBlockRuns(instanceId, "O", [
        { id: "E1", title: "E1", task: "do the emitted thing", folder: "project/sub" },
      ]);
      assert.ok(emission.ok, `emission refused: ${!emission.ok && emission.reason}`);

      // Between the decision and the start, the window the template is re-read across.
      withModel(false);
      workflows.settleBlock(instanceId, "O", { status: "idle", text: "Started E1." });

      const row = dbMod
        .db()
        .prepare(
          "SELECT error, notes FROM workflow_instance_blocks WHERE instance_id=? AND node_id=?",
        )
        .get(instanceId, "O") as { error: string | null; notes: string | null };
      assert.equal(row.error, null, "the turn did not fail; the list refused its runs");
      assert.match(row.notes ?? "", /“E1” was not started: .*switched off for this install/);
      assert.equal(
        workflows.blocksOf(instanceId).find((b) => b.nodeId === "O")?.started,
        0,
      );
    } finally {
      restore();
    }
  });

  // Fails at the claim with nothing spent: every run the turn emitted would hit
  // the case above, so the turn it was paid for would decide on work that could
  // not start.
  it("does not pay for an orchestrator block's turn whose template model is off", async () => {
    const restore = withModel(true);
    try {
      const template = pinnedTemplate();
      const workflow = workflows.createWorkflow({
        name: "Decide after a retired model",
        graph: {
          nodes: [block("R", "run"), block("O", "orchestrator", { templateId: template.id })],
          edges: [{ from: "R", to: "O", edge: "on-finish", continueBranch: false }],
        },
        instanceBudget,
      });
      const outcome = workflows.startWorkflow(workflow.id, await orch.currentSnapshot());
      assert.ok(outcome.ok, `start refused: ${!outcome.ok && outcome.reason}`);
      const instanceId = outcome.instance.id;

      withModel(false);
      dbMod
        .db()
        .prepare(
          "UPDATE runs SET status='completed', iterations=1, finished_at=? WHERE id IN (SELECT run_id FROM workflow_instance_runs WHERE instance_id=? AND node_id='R')",
        )
        .run(Date.now(), instanceId);
      workflows.advanceInstances();

      const row = dbMod
        .db()
        .prepare(
          "SELECT status, error FROM workflow_instance_blocks WHERE instance_id=? AND node_id='O'",
        )
        .get(instanceId) as { status: string; error: string | null };
      assert.equal(row.status, "failed", JSON.stringify(row));
      assert.match(row.error ?? "", /switched off for this install/);
      assert.equal(
        workflows.blocksOf(instanceId).find((b) => b.nodeId === "O")?.costUSD,
        0,
        "nothing was spent",
      );
    } finally {
      restore();
    }
  });
});
