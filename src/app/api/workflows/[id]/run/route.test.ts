import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { BudgetPolicy } from "../../../../../lib/budget";
import type { WorkflowGraph, WorkflowNode } from "../../../../../lib/workflowGraph";

/**
 * Pressing Run on a workflow refuses a fraction guard with nothing to read, and
 * creates nothing.
 *
 * `planNode` takes each block's budget from its template, or from
 * `chatDefaultGuards` when it names none, and either can hold
 * `maxWeeklyFraction`/`maxSessionFraction`. `createRun` does not ask whether
 * that window can be read and the pre-cycle guard only records it
 * (`RUN_ENFORCEABLE_CODES`), so a press on an install with no reading started
 * members whose guard was never evaluated: measured through a stubbed CLI, one
 * spawn and a `budget` event with `code: "no_ceiling"` and `enforceable: false`.
 * `startWorkflow` already refused the *instance's* own fraction guard at this
 * door and not the per-run one a member carries. A press is a person with an
 * error channel, so it refuses, as `POST /api/runs` does.
 *
 * Route-level because the gap was between the route and `startWorkflow`: the
 * route fetches the readings, `startWorkflow` judges with them, and a unit test
 * of either half passes with the other missing. The Codex reading is the half
 * only the route can supply. Its own file with `DATA_DIR` named before the
 * first import, for `runOrigin.test.ts`'s reason: `config.ts` is read at
 * module load. The fleet is paused, so a run a regression lets through is held
 * `waiting` rather than spawned.
 */

type Answer = { status: number; body: Record<string, unknown> };

let root: string;
let press: (workflowId: string) => Promise<Answer>;
let budgetOf: () => BudgetPolicy;
let withGuards: (budget: Partial<BudgetPolicy>) => void;
let makeTemplate: (budget: Partial<BudgetPolicy>) => string;
let makeWorkflow: (graph: WorkflowGraph) => string;
let setReading: (weeklyCostLimit: number | null) => void;
let count: (table: "runs" | "workflow_instances") => number;
let tick: () => Promise<void>;
let setPaused: (paused: boolean) => void;
let scheduleFor: (workflowId: string) => void;
let lastOutcome: (workflowId: string) => { code: string | null; reason: string | null };

const WEEKLY = /^“Do A”: A weekly-fraction guard is set but that window has no reading/;

/** Every field a saved graph carries, so a fixture states only what it means. */
function block(id: string, kind: WorkflowNode["kind"], over: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id,
    name: `Do ${id}`,
    kind,
    templateId: null,
    mountId: kind === "loop" || kind === "merge" ? "" : "scratch",
    folder: kind === "loop" || kind === "merge" ? "" : "project",
    task: kind === "loop" || kind === "merge" ? "" : "do the thing",
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

const single = (over: Partial<WorkflowNode> = {}, kind: WorkflowNode["kind"] = "run"): WorkflowGraph => ({
  nodes: [block("A", kind, over)],
  edges: [],
});

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-workflow-run-route-")));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(workspace, "project"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "other"), { recursive: true });
  // A repository with a commit on it, for the loop case only: a repeated block
  // has to land every pass, and `startWorkflow` refuses a section whose folder
  // git cannot use before it reaches the guards this file is about.
  const repo = path.join(workspace, "repo");
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "first"]]) {
    execFileSync("git", args, {
      cwd: repo,
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
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = workspace;
  // An empty home, so a Codex block has no sign-in and therefore no reading,
  // whatever this machine's own `~/.codex` holds.
  process.env.CODEX_HOME = path.join(root, "codex");
  process.env.WORKSPACE_ROOTS = `Scratch=${workspace}`;
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  const config = await import("../../../../../lib/config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );
  setPaused = (await import("../../../../../lib/fleet")).setFleetPaused;
  setPaused(true);
  const settings = await import("../../../../../lib/settings");
  // No network here, so the Claude reading is whatever Settings holds.
  settings.saveSettings({ planUsageFromApi: false });
  const templates = await import("../../../../../lib/templates");
  const workflows = await import("../../../../../lib/workflows");
  const schedules = await import("../../../../../lib/schedules");
  const { db } = await import("../../../../../lib/db");
  const { POST } = await import("./route");

  budgetOf = () => settings.chatGuards().budget;
  withGuards = (budget) => {
    const guards = settings.chatGuards();
    settings.saveSettings({
      chatDefaultGuards: { ...guards, budget: { ...guards.budget, ...budget } },
    });
  };
  let serial = 0;
  makeTemplate = (budget) =>
    templates.createTemplate({
      name: `Guarded ${serial++}`,
      prompt: "Work carefully.",
      mountId: "scratch",
      folder: "",
      isolate: false,
      permissionMode: "plan",
      agentId: null,
      model: null,
      budget: { ...budgetOf(), ...budget },
    }).id;
  makeWorkflow = (graph) =>
    workflows.createWorkflow({
      name: `Press ${serial++}`,
      graph,
      // A schedule will not press Run under a workflow with no limit of its
      // own (`scheduleRefusal`), and a dollar limit reads no window.
      instanceBudget: { maxInstanceCostUSD: 5, maxSessionFraction: null, maxWeeklyFraction: null },
    }).id;
  setReading = (weeklyCostLimit) => settings.saveSettings({ weeklyCostLimit });
  count = (table) =>
    (db().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  press = async (workflowId) => {
    const res = await POST(
      new Request(`http://localhost/api/workflows/${workflowId}/run`, { method: "POST" }),
      { params: Promise.resolve({ id: workflowId }) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  // A schedule one minute past an occurrence, inside `FIRE_GRACE_MS`, so one
  // tick has a window to act on.
  scheduleFor = (workflowId) => {
    const anchor = Date.now() - 60 * 60 * 1000 - 60_000;
    schedules.putSchedule(workflowId, { kind: "everyHours", hours: 1, anchorAt: anchor }, "UTC", anchor);
  };
  tick = () => schedules.tickSchedules();
  lastOutcome = (workflowId) => {
    const row = db()
      .prepare("SELECT last_code AS code, last_reason AS reason FROM workflow_schedules WHERE workflow_id = ?")
      .get(workflowId) as { code: string | null; reason: string | null };
    return row;
  };
});

beforeEach(async () => {
  // A folder claim is a folder claim: a press from the previous case that was
  // let through holds `project`, and `sharedFolderOf` would refuse this one.
  const { db } = await import("../../../../../lib/db");
  for (const table of [
    "workflow_schedules",
    "workflow_instance_blocks",
    "workflow_instance_runs",
    "workflow_instances",
    "workflows",
    "run_deps",
    "runs",
  ]) {
    db().prepare(`DELETE FROM ${table}`).run();
  }
});

afterEach(() => {
  setReading(null);
  withGuards({ maxWeeklyFraction: null, maxSessionFraction: null });
});

after(async () => {
  // A run a regression let through is only held, but give anything a tick to
  // fall over before the directory it works in is removed.
  await new Promise((resolve) => setTimeout(resolve, 50));
  delete process.env.WORKSPACE_ROOTS;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("POST /api/workflows/[id]/run — a fraction guard with nothing to read", () => {
  it("starts a workflow whose guards carry no fraction, as it always did", async () => {
    const answer = await press(makeWorkflow(single()));
    const reason = `answered ${answer.status} ${JSON.stringify(answer.body)}`;
    assert.equal(answer.status, 200, reason);
    assert.equal(count("workflow_instances"), 1, reason);
    assert.equal(count("runs"), 1, reason);
  });

  it("refuses a templated weekly fraction, creating no instance and no run", async () => {
    const answer = await press(
      makeWorkflow(single({ templateId: makeTemplate({ maxWeeklyFraction: 0.5 }) })),
    );
    const reason = `answered ${answer.status} ${JSON.stringify(answer.body)}`;
    assert.equal(answer.status, 400, reason);
    assert.match(String(answer.body.error), WEEKLY, reason);
    assert.equal(count("workflow_instances"), 0, `${reason}: an instance was recorded`);
    assert.equal(count("runs"), 0, `${reason}: a run started with its guard unread`);
  });

  it("refuses a session fraction in the 5-hour window's words, off the guards in Settings", async () => {
    // A block that names no template takes `chatDefaultGuards`, the other
    // place a member's fraction comes from.
    withGuards({ maxSessionFraction: 0.5 });
    const answer = await press(makeWorkflow(single()));
    const reason = `answered ${answer.status} ${JSON.stringify(answer.body)}`;
    assert.equal(answer.status, 400, reason);
    assert.match(
      String(answer.body.error),
      /^“Do A”: A session-fraction guard is set but the 5-hour window has no reading/,
      reason,
    );
    assert.equal(count("workflow_instances"), 0, reason);
    assert.equal(count("runs"), 0, reason);
  });

  it("refuses an orchestrator block by its template, whose guards every run it emits takes", async () => {
    const answer = await press(
      makeWorkflow(single({ templateId: makeTemplate({ maxWeeklyFraction: 0.5 }) }, "orchestrator")),
    );
    const reason = `answered ${answer.status} ${JSON.stringify(answer.body)}`;
    assert.equal(answer.status, 400, reason);
    assert.match(String(answer.body.error), WEEKLY, reason);
    assert.equal(count("workflow_instances"), 0, reason);
  });

  it("refuses a block a loop repeats, which is created passes later and not at the press", async () => {
    withGuards({ maxWeeklyFraction: 0.5 });
    const answer = await press(
      makeWorkflow({
        nodes: [
          block("L", "loop", { maxPasses: 1, bodyNodeIds: ["A", "M"] }),
          block("A", "run", { folder: "repo" }),
          block("M", "merge", { mergeStrategy: "merge" }),
        ],
        edges: [
          { from: "L", to: "A", edge: "repeats", continueBranch: false },
          { from: "A", to: "M", edge: "on-success", continueBranch: false },
        ],
      }),
    );
    const reason = `answered ${answer.status} ${JSON.stringify(answer.body)}`;
    assert.equal(answer.status, 400, reason);
    assert.match(String(answer.body.error), WEEKLY, reason);
    assert.equal(count("workflow_instances"), 0, reason);
    assert.equal(count("runs"), 0, reason);
  });

  it("refuses the whole press when one block of several is unreadable, creating none of them", async () => {
    // All or nothing: the readable block must not be left running as a prefix
    // of a graph that was never started.
    const plain = makeTemplate({ maxWeeklyFraction: null });
    const guarded = makeTemplate({ maxWeeklyFraction: 0.5 });
    const answer = await press(
      makeWorkflow({
        nodes: [
          block("P", "run", { templateId: plain, folder: "project" }),
          block("A", "run", { templateId: guarded, folder: "other" }),
        ],
        edges: [],
      }),
    );
    const reason = `answered ${answer.status} ${JSON.stringify(answer.body)}`;
    assert.equal(answer.status, 400, reason);
    assert.match(String(answer.body.error), WEEKLY, reason);
    assert.equal(count("workflow_instances"), 0, reason);
    assert.equal(count("runs"), 0, reason);
  });

  it("starts the same workflow on the next press once the window has a reading", async () => {
    withGuards({ maxWeeklyFraction: 0.5 });
    const id = makeWorkflow(single());
    assert.equal((await press(id)).status, 400);

    setReading(100);
    const answer = await press(id);
    const reason = `answered ${answer.status} ${JSON.stringify(answer.body)}`;
    assert.equal(answer.status, 200, reason);
    assert.equal(count("workflow_instances"), 1, reason);
    assert.equal(count("runs"), 1, reason);
  });

  it("reads a Codex block against Codex's windows, not the Claude reading beside them", async () => {
    // A reading for Claude's week and none for Codex's: a door that asked only
    // `currentSnapshot()` would admit this run.
    setReading(100);
    withGuards({ maxWeeklyFraction: 0.5 });
    const answer = await press(makeWorkflow(single({ provider: "codex" })));
    const reason = `answered ${answer.status} ${JSON.stringify(answer.body)}`;
    assert.equal(answer.status, 400, reason);
    assert.match(String(answer.body.error), /Codex's weekly window has no reading/, reason);
    assert.equal(count("workflow_instances"), 0, reason);
    assert.equal(count("runs"), 0, reason);
  });

  it("starts a Codex block whose own window has a reading, with no Claude reading at all", async () => {
    // The other direction: a door that read Claude's snapshot for every block
    // would refuse this one, and the refusal would look like the guard working.
    const usage = (globalThis as { __ufCodexUsage?: { v?: unknown } }).__ufCodexUsage;
    assert.ok(usage, "codexAccount.ts has not created its cache key");
    fs.mkdirSync(process.env.CODEX_HOME!, { recursive: true });
    fs.writeFileSync(path.join(process.env.CODEX_HOME!, "auth.json"), "{}");
    const now = Date.now();
    usage.v = {
      attemptedAt: now,
      error: null,
      value: {
        session: { utilization: 0.1, resetsAt: now + 3_600_000 },
        weekly: { utilization: 0.2, resetsAt: now + 86_400_000 },
        scopedWeekly: [],
        fetchedAt: now,
        sessionMinutes: 300,
        weeklyMinutes: 10_080,
        planType: null,
        limitReached: null,
      },
    };
    try {
      withGuards({ maxWeeklyFraction: 0.5 });
      const answer = await press(makeWorkflow(single({ provider: "codex" })));
      const reason = `answered ${answer.status} ${JSON.stringify(answer.body)}`;
      assert.equal(answer.status, 200, reason);
      assert.equal(count("runs"), 1, reason);
    } finally {
      usage.v = undefined;
      fs.rmSync(path.join(process.env.CODEX_HOME!, "auth.json"), { force: true });
    }
  });
});

describe("a schedule's fire — the press with nobody present", () => {
  // The hold turns a tick's window into a missed one before it reaches the
  // door under test. Nothing here can spawn if a regression starts a run:
  // `CLAUDE_BIN` names a file that does not exist, so the run fails unbilled
  // and the counts below catch it.
  before(() => setPaused(false));
  after(() => setPaused(true));

  it("is refused and recorded in the window's sentence, starting nothing", async () => {
    withGuards({ maxWeeklyFraction: 0.5 });
    const id = makeWorkflow(single());
    scheduleFor(id);
    await tick();

    const outcome = lastOutcome(id);
    assert.equal(outcome.code, "refused", JSON.stringify(outcome));
    assert.match(String(outcome.reason), WEEKLY, JSON.stringify(outcome));
    assert.equal(count("workflow_instances"), 0);
    assert.equal(count("runs"), 0);
  });
});
