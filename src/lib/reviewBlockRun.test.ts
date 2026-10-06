import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * A workflow's review block driven for real: a repository, two finished
 * branches, and a stand-in for `claude` that reviews them.
 *
 * `reviewBlock.test.ts` pins each decision and `workflows.test.ts` pins what the
 * scheduler hands on. What neither can see is whether the block, given two
 * branches, actually asks for a verdict, reads the one the reviewer gave, hands
 * on only the approved branch and marks the rejected branch's task — every one
 * of which fails silently, and the first as a merge of work nobody approved.
 *
 * The stub approves a brief carrying `APPROVE-ME` and rejects every other one,
 * printing the `stream-json` result Claude Code ends a review with, and answers
 * a brief carrying `SLOW-ONE` only after `SLOW_REVIEW_MS`. Its own `DATA_DIR`
 * before the first import, `loopMergeOwnership.test.ts`' reason.
 */

let workflows: typeof import("./workflows");
let dbMod: typeof import("./db");
let installBudget: typeof import("./installBudget");
let orch: typeof import("./orchestrator");
let root: string;
let base: string;

/** How long the stub takes over a `SLOW-ONE` brief: long enough to halt inside. */
const SLOW_REVIEW_MS = 3_000;

/**
 * What the next snapshot read does once it returns, or null.
 *
 * Answers true when it acted, and stays armed until it does. A snapshot is the
 * one `await` both the review block's door and `startReview`'s own refusal
 * check make, so this is where an operator's Stop lands on a slow read.
 */
let duringSnapshot: (() => boolean) | null = null;

const MOUNT_DIR = "review-block-mount";
const INSTANCE = "inst-review-1";
const TASK = "task-hard-one";
const DONE_TASK = "task-closed-by-bad";
const OTHERS_TASK = "task-closed-by-other";

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
  }).trim();

const repoRoot = () => path.join(root, MOUNT_DIR, "repo");

function branchWithCommit(branch: string, file: string): void {
  git(repoRoot(), "switch", "-q", "-c", branch);
  fs.writeFileSync(path.join(repoRoot(), file), `${file}\n`);
  git(repoRoot(), "add", file);
  git(repoRoot(), "commit", "-q", "-m", file);
  git(repoRoot(), "switch", "-q", "main");
}

/**
 * `promise`, or a failure naming `what` once `ms` have passed without it
 * settling.
 *
 * `startReviewBlock` waits on its reviews through `pause()`, an unref'd timer —
 * deliberately, so a poll never keeps a server that is shutting down alive —
 * and in the app the HTTP server is what holds the event loop open meanwhile.
 * Here nothing does once the stub reviewers have exited, so the loop drained
 * mid-poll with both reviews already written, and `node:test` cancelled the
 * case as "Promise resolution is still pending" every time it ran. This timer
 * is the ref'd handle standing in for the server, and it rejects rather than
 * only holding on, so a review row really stranded `running` fails here by name
 * instead of hanging the suite.
 */
function settledWithin<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} had not settled after ${ms} ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function writeStub(dir: string): string {
  const stub = path.join(dir, "claude-reviewer-stub.js");
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const prompt = args[args.indexOf("--") + 1] || "";
const verdict = prompt.includes("APPROVE-ME") ? "APPROVE" : "REJECT";
const asksForVerdict = prompt.includes("## Verdict");
const result = "## Summary\\nRead it.\\n\\n## Look at this first\\nsrc\\n\\n## Risks\\nnone\\n" +
  (asksForVerdict ? "\\n## Verdict\\n" + verdict + "\\n" : "");
process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n");
setTimeout(() => {
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success", is_error: false, result,
    total_cost_usd: 0.02, usage: { input_tokens: 10, output_tokens: 5 },
  }) + "\\n");
}, prompt.includes("SLOW-ONE") ? ${SLOW_REVIEW_MS} : 0);
`,
    { mode: 0o755 },
  );
  return stub;
}

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-review-block-")));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, MOUNT_DIR);
  process.env.WORKSPACE_ROOTS = "";
  process.env.CLAUDE_BIN = writeStub(root);

  fs.mkdirSync(repoRoot(), { recursive: true });
  git(repoRoot(), "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repoRoot(), "a.txt"), "one\n");
  git(repoRoot(), "add", "-A");
  git(repoRoot(), "commit", "-q", "-m", "first");
  base = git(repoRoot(), "rev-parse", "HEAD");
  branchWithCommit("uf/repo-good", "good.txt");
  branchWithCommit("uf/repo-bad", "bad.txt");

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );
  dbMod = await import("./db");
  workflows = await import("./workflows");
  installBudget = await import("./installBudget");
  orch = await import("./orchestrator");
  const settings = await import("./settings");
  // No network here, and a fix run is held in the queue rather than spawned:
  // what the cases below ask is whether one is *created*. Assists do not read
  // the hold, so the reviews still run.
  settings.saveSettings({ planUsageFromApi: false });
  settings.setNewWorkPaused(true);

  // Replaced on the module object, `scheduleFire.test.ts`' way: `review.ts`
  // and `workflows.ts` both call it through that object under the test
  // build's CommonJS emit.
  const realSnapshot = orch.currentSnapshot;
  (orch as { currentSnapshot: unknown }).currentSnapshot = async () => {
    const snapshot = await realSnapshot();
    if (duringSnapshot?.()) duringSnapshot = null;
    return snapshot;
  };
  const db = dbMod.db();

  const insertRun = db.prepare(
    `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
       created_at, isolation, worktree_branch, worktree_base, worktree_base_branch,
       repo_root, provider)
     VALUES (?, ?, ?, 'completed', '{}', 1, 1, ?, 'worktree', ?, ?, 'main', ?, 'local')`,
  );
  insertRun.run("run-good", repoRoot(), "Do it. APPROVE-ME", Date.now(), "uf/repo-good", base, repoRoot());
  insertRun.run("run-bad", repoRoot(), "Do it badly.", Date.now(), "uf/repo-bad", base, repoRoot());

  // One task the rejected run still holds, one it closed as done, and one
  // another run closed: the first two come back open, the third is left.
  const insertTask = db.prepare(
    `INSERT INTO tasks (id, title, body, status, priority, origin, claimed_by_run_id,
       completed_by_run_id, closed_at, created_at, updated_at)
     VALUES (?, ?, 'brief', ?, 'normal', 'operator', ?, ?, ?, 0, 0)`,
  );
  insertTask.run(TASK, "The hard one", "claimed", "run-bad", null, null);
  insertTask.run(DONE_TASK, "The one it closed", "done", null, "run-bad", 1);
  insertTask.run(OTHERS_TASK, "Someone else's", "done", null, "run-other", 1);
  const link = db.prepare("INSERT INTO run_tasks (run_id, task_id, position) VALUES ('run-bad', ?, ?)");
  link.run(TASK, 0);
  link.run(DONE_TASK, 1);
  link.run(OTHERS_TASK, 2);

  const node = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: id === "r" ? "Review" : "Land",
    kind,
    templateId: null,
    mountId: "",
    folder: "",
    task: "",
    promptOverride: null,
    agentId: null,
    fanOut: null,
    mergeStrategy: kind === "merge" ? "merge" : null,
    mergeAutoResolve: false,
    maxPasses: null,
    maxLoopCostUSD: null,
    stopWhenTasks: null,
    bodyNodeIds: [],
    provider: null,
    fixRounds: kind === "review" ? 0 : null,
    ...extra,
  });
  const graph = JSON.stringify({
    nodes: [node("r", "review"), node("m", "merge")],
    edges: [{ from: "r", to: "m", edge: "on-success", continueBranch: false }],
  });
  db.prepare(
    "INSERT INTO workflows (id, name, graph, created_at, updated_at) VALUES ('wf-1', 'Reviewed', ?, 0, 0)",
  ).run(graph);
  db.prepare(
    `INSERT INTO workflow_instances (id, workflow_id, workflow_name, graph, created_at, status)
     VALUES (?, 'wf-1', 'Reviewed', ?, 0, 'started')`,
  ).run(INSTANCE, graph);
  db.prepare(
    `INSERT INTO workflow_instance_blocks (instance_id, node_id, node_name, position, kind, status)
     VALUES (?, 'r', 'Review', 0, 'review', 'thinking')`,
  ).run(INSTANCE);
});

after(() => {
  const open = (globalThis as { __ufDb?: { close(): void } }).__ufDb;
  open?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("a review block with no fix rounds", () => {
  it("hands on the approved branch, sets the rejected one aside and marks its task", async () => {
    await settledWithin(
      workflows.startReviewBlock(INSTANCE, "r", ["run-good", "run-bad"]),
      30_000,
      "startReviewBlock",
    );
    const db = dbMod.db();

    const items = workflows.reviewItemsOf(INSTANCE, "r");
    assert.deepEqual(
      items.map((i) => [i.origin_run_id, i.status]),
      [
        ["run-good", "approved"],
        ["run-bad", "set-aside"],
      ],
    );
    assert.match(items[1].note ?? "", /rejected by the frontier review — its tasks are marked needs-frontier/);

    // Each review was asked for a verdict and recorded the tip it was shown,
    // which is what the Land gate reads for a local branch.
    const reviews = db
      .prepare("SELECT run_id, verdict, head_sha FROM run_reviews ORDER BY run_id")
      .all() as Array<{ run_id: string; verdict: string | null; head_sha: string | null }>;
    assert.deepEqual(
      reviews.map((r) => [r.run_id, r.verdict]),
      [
        ["run-bad", "reject"],
        ["run-good", "approve"],
      ],
    );
    assert.equal(
      reviews.find((r) => r.run_id === "run-good")?.head_sha,
      git(repoRoot(), "rev-parse", "uf/repo-good"),
    );

    const block = db
      .prepare("SELECT status, error, cost_usd FROM workflow_instance_blocks WHERE node_id='r'")
      .get() as { status: string; error: string; cost_usd: number };
    assert.equal(block.status, "emitted");
    assert.match(block.error, /Approved 1 of 2 branch\(es\); set aside/);
    assert.ok(block.cost_usd > 0, "the reviews' cost lands on the block");

    // The same money is on the block's row and in `run_reviews`; the install's
    // rolling spend must see it once, not twice.
    const reviewed = db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM run_reviews")
      .get() as { s: number };
    assert.equal(installBudget.installSpend().spentUSD.toFixed(4), reviewed.s.toFixed(4));

    const tasks = db
      .prepare(
        "SELECT id, status, needs_frontier, claimed_by_run_id, completed_by_run_id, closed_at FROM tasks ORDER BY id",
      )
      .all() as Array<{
      id: string;
      status: string;
      needs_frontier: number;
      claimed_by_run_id: string | null;
      completed_by_run_id: string | null;
      closed_at: number | null;
    }>;
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const id of [TASK, DONE_TASK]) {
      const t = byId.get(id)!;
      assert.deepEqual(
        [t.status, t.claimed_by_run_id, t.completed_by_run_id, t.closed_at, t.needs_frontier],
        ["open", null, null, null, 1],
        id,
      );
    }
    const others = byId.get(OTHERS_TASK)!;
    assert.equal(others.status, "done", "another run's closed task is left alone");
    assert.equal(others.needs_frontier, 1);

    const comment = (id: string) =>
      (db.prepare("SELECT body FROM task_comments WHERE task_id=?").all(id) as Array<{ body: string }>)
        .map((c) => c.body)
        .join("\n");
    assert.match(comment(TASK), /set run run-bad's branch aside.*so this task is open again/);
    assert.match(comment(OTHERS_TASK), /left done because it was closed by the operator or by another run/);
  });
});

/* ------------------------------------------------------------------ */
/* A review block under a halt and under its instance's limit           */
/* ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls on a ref'd timer, which is also what keeps the loop alive meanwhile. */
async function until(what: string, test: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/**
 * A press of Run whose one block is a review block already claimed `thinking`,
 * and the finished runs it is handed — fresh ones per case, because a run with
 * a review running refuses a second.
 */
function reviewScene(
  instanceId: string,
  opts: {
    fixRounds?: number;
    budget?: Record<string, number>;
    runs: Array<{ id: string; prompt: string; branch: string; spent?: number; member?: boolean }>;
  },
): void {
  const db = dbMod.db();
  const node = (id: string, kind: string) => ({
    id,
    name: id === "r" ? "Review" : "Land",
    kind,
    templateId: null,
    mountId: "",
    folder: "",
    task: "",
    promptOverride: null,
    agentId: null,
    fanOut: null,
    mergeStrategy: kind === "merge" ? "merge" : null,
    mergeAutoResolve: false,
    maxPasses: null,
    maxLoopCostUSD: null,
    stopWhenTasks: null,
    bodyNodeIds: [],
    provider: null,
    fixRounds: kind === "review" ? (opts.fixRounds ?? 0) : null,
  });
  const graph = JSON.stringify({
    nodes: [node("r", "review"), node("m", "merge")],
    edges: [{ from: "r", to: "m", edge: "on-success", continueBranch: false }],
  });
  const budget = opts.budget ? JSON.stringify(opts.budget) : null;
  db.prepare(
    "INSERT INTO workflows (id, name, graph, created_at, updated_at) VALUES (?, ?, ?, 0, 0)",
  ).run(`wf-${instanceId}`, `Reviewed ${instanceId}`, graph);
  db.prepare(
    `INSERT INTO workflow_instances
       (id, workflow_id, workflow_name, graph, created_at, status, instance_budget)
     VALUES (?, ?, ?, ?, 0, 'started', ?)`,
  ).run(instanceId, `wf-${instanceId}`, `Reviewed ${instanceId}`, graph, budget);
  db.prepare(
    `INSERT INTO workflow_instance_blocks
       (instance_id, node_id, node_name, position, kind, status, started_at)
     VALUES (?, 'r', 'Review', 0, 'review', 'thinking', ?)`,
  ).run(instanceId, Date.now());

  const insertRun = db.prepare(
    `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
       created_at, isolation, worktree_branch, worktree_base, worktree_base_branch,
       repo_root, provider, spent_usd)
     VALUES (?, ?, ?, 'completed', '{"maxIterations":1}', 1, 1, ?, 'worktree', ?, ?, 'main', ?,
             'claude', ?)`,
  );
  const insertMember = db.prepare(
    `INSERT INTO workflow_instance_runs (instance_id, node_id, node_name, position, run_id)
     VALUES (?, ?, 'Worker', ?, ?)`,
  );
  opts.runs.forEach((run, i) => {
    insertRun.run(run.id, repoRoot(), run.prompt, Date.now(), run.branch, base, repoRoot(), run.spent ?? 0);
    if (run.member) insertMember.run(instanceId, `w${i}`, i + 1, run.id);
  });
}

function reviewsOf(runId: string): Array<{
  status: string;
  cost_usd: number;
  created_at: number;
  finished_at: number | null;
}> {
  return dbMod
    .db()
    .prepare("SELECT status, cost_usd, created_at, finished_at FROM run_reviews WHERE run_id=?")
    .all(runId) as Array<{ status: string; cost_usd: number; created_at: number; finished_at: number | null }>;
}

const reviewRunning = (runId: string) => reviewsOf(runId).some((r) => r.status === "running");

function storedInstance(instanceId: string): { status: string; stoppedAt: number | null } {
  return dbMod
    .db()
    .prepare("SELECT status, stopped_at AS stoppedAt FROM workflow_instances WHERE id=?")
    .get(instanceId) as { status: string; stoppedAt: number | null };
}

describe("a review block handed more branches than there are assist slots", () => {
  it("waits for a slot rather than setting a branch aside over it", async () => {
    // The siblings all pass the block's own budget check before any of them has
    // written the row that fills a slot, so all but the first few are refused at
    // `startReview`'s door — by the queue, not by a review.
    const settings = await import("./settings");
    assert.equal(settings.getSettings().maxConcurrentAssists, 2, "the default slot count this case is about");
    const ids = ["four-a", "four-b", "four-c", "four-d"];
    reviewScene("inst-four", {
      runs: ids.map((id) => ({ id, prompt: "Do it. APPROVE-ME", branch: "uf/repo-good" })),
    });
    await settledWithin(workflows.startReviewBlock("inst-four", "r", ids), 30_000, "startReviewBlock");

    assert.deepEqual(
      workflows.reviewItemsOf("inst-four", "r").map((i) => [i.origin_run_id, i.status, i.note]),
      ids.map((id) => [id, "approved", null]),
    );
    assert.deepEqual(
      ids.map((id) => reviewsOf(id).length),
      [1, 1, 1, 1],
      "each branch was reviewed exactly once",
    );
  });

  it("still sets a branch aside over a spent install limit, which no wait would clear", async () => {
    // A run the block is not handed has spent past the limit on its own.
    const settings = await import("./settings");
    settings.saveSettings({ installDailyCostLimitUSD: 0.5 });
    try {
      reviewScene("inst-capped", {
        runs: [
          { id: "capped-good", prompt: "Do it. APPROVE-ME", branch: "uf/repo-good" },
          { id: "capped-spender", prompt: "spent", branch: "uf/repo-good", spent: 1 },
        ],
      });
      await settledWithin(workflows.startReviewBlock("inst-capped", "r", ["capped-good"]), 30_000, "startReviewBlock");
      const refusal = installBudget.installBudgetRefusal();
      assert.ok(refusal, "the install limit is spent");
      assert.deepEqual(
        workflows.reviewItemsOf("inst-capped", "r").map((i) => [i.status, i.note]),
        [["set-aside", `it could not be reviewed: ${refusal}`]],
      );
      assert.deepEqual(reviewsOf("capped-good"), []);
    } finally {
      settings.saveSettings({ installDailyCostLimitUSD: null });
    }
  });
});

describe("a review block whose workflow is halted", () => {
  it("starts no fix run for a rejection that lands just after the halt", async () => {
    // The reviewer answers at once, so the review is over while the block's
    // poll is still asleep — the gap the halt has to land in.
    reviewScene("inst-fix", {
      fixRounds: 1,
      runs: [{ id: "fix-origin", prompt: "Do it.", branch: "uf/repo-bad" }],
    });
    const driving = workflows.startReviewBlock("inst-fix", "r", ["fix-origin"]);
    await until("the review to be written", () => reviewsOf("fix-origin").length > 0);
    await until("the review to finish", () => !reviewRunning("fix-origin"));
    const halt = workflows.stopInstance("inst-fix", { kind: "operator" });
    assert.ok(halt.ok && halt.report.acted, "the halt closed the door");
    await settledWithin(driving, 30_000, "startReviewBlock");

    const members = dbMod
      .db()
      .prepare("SELECT node_id AS nodeId FROM workflow_instance_runs WHERE instance_id='inst-fix'")
      .all() as Array<{ nodeId: string }>;
    assert.deepEqual(members, [], "a fix run was created into the workflow after its halt");
    assert.equal(workflows.getInstance("inst-fix")!.status, "stopped");
  });

  it("spawns no reviewer when the halt lands while the review is being prepared", async () => {
    // Pressed inside `startReview`'s own snapshot read — after the block's
    // door, which reads one before the branches are seeded, and before the
    // child would be spawned.
    reviewScene("inst-gap", {
      runs: [{ id: "gap-origin", prompt: "Do it. APPROVE-ME", branch: "uf/repo-good" }],
    });
    let pressed = false;
    duringSnapshot = () => {
      if (workflows.reviewItemsOf("inst-gap", "r").length === 0) return false;
      pressed = workflows.stopInstance("inst-gap", { kind: "operator" }).ok;
      return true;
    };
    try {
      await settledWithin(workflows.startReviewBlock("inst-gap", "r", ["gap-origin"]), 30_000, "startReviewBlock");
    } finally {
      duringSnapshot = null;
    }
    assert.ok(pressed, "the halt landed inside the review's preparation");
    assert.deepEqual(reviewsOf("gap-origin"), [], "a reviewer was spawned into a stopped workflow");
    assert.equal(workflows.getInstance("inst-gap")!.status, "stopped");
  });

  it("stops the reviews still running, and reads stopping until they end", async () => {
    reviewScene("inst-halt", {
      runs: [
        { id: "halt-good", prompt: "Do it. APPROVE-ME", branch: "uf/repo-good" },
        { id: "halt-slow", prompt: "Do it. SLOW-ONE", branch: "uf/repo-bad" },
      ],
    });
    const driving = workflows.startReviewBlock("inst-halt", "r", ["halt-good", "halt-slow"]);
    await until("the fast review to be approved", () =>
      workflows.reviewItemsOf("inst-halt", "r").some((i) => i.origin_run_id === "halt-good" && i.status === "approved"));
    await until("the slow review to be running", () => reviewRunning("halt-slow"));

    workflows.stopInstance("inst-halt", { kind: "operator" });
    const stoppedAt = storedInstance("inst-halt").stoppedAt!;
    assert.ok(reviewRunning("halt-slow"), "the slow reviewer is still dying at this point");
    assert.equal(
      workflows.getInstance("inst-halt")!.status,
      "stopping",
      "the instance reads stopped while a reviewer it started is still running",
    );

    await settledWithin(driving, 30_000, "startReviewBlock");
    assert.equal(reviewRunning("halt-slow"), false);
    const slow = reviewsOf("halt-slow")[0];
    assert.ok(
      slow.finished_at! - stoppedAt < SLOW_REVIEW_MS - 500,
      `the slow reviewer ran on to its own answer ${slow.finished_at! - stoppedAt} ms after the halt`,
    );
    assert.equal(workflows.getInstance("inst-halt")!.status, "stopped");
  });

  it("keeps what its reviews billed in the instance total", async () => {
    reviewScene("inst-total", {
      runs: [
        { id: "total-good", prompt: "Do it. APPROVE-ME", branch: "uf/repo-good" },
        { id: "total-slow", prompt: "Do it. SLOW-ONE", branch: "uf/repo-bad" },
      ],
    });
    const driving = workflows.startReviewBlock("inst-total", "r", ["total-good", "total-slow"]);
    await until("the fast review to be approved", () =>
      workflows.reviewItemsOf("inst-total", "r").some((i) => i.origin_run_id === "total-good" && i.status === "approved"));
    await until("the slow review to be running", () => reviewRunning("total-slow"));
    workflows.stopInstance("inst-total", { kind: "operator" });
    await settledWithin(driving, 30_000, "startReviewBlock");
    await until("the slow review to end", () => !reviewRunning("total-slow"));

    const reviews = [...reviewsOf("total-good"), ...reviewsOf("total-slow")];
    const billed = reviews.reduce((sum, r) => sum + r.cost_usd, 0);
    // A review that ended with nothing reported is a gap, not a measured zero.
    const silent = reviews.filter((r) => r.status === "failed" && r.cost_usd === 0).length;
    const spend = workflows.instanceSpend("inst-total");
    assert.ok(billed >= 0.02);
    assert.equal(spend.spentUSD.toFixed(4), billed.toFixed(4), "the halted block's reviews are missing from the total");
    assert.equal(spend.unmeasured, silent, "a reviewer killed before it reported reads as a measured $0.00");
  });
});

describe("a review block and its workflow's limit", () => {
  it("counts a finished review in the guard figure while the block is still working", async () => {
    reviewScene("inst-mid", {
      runs: [
        { id: "mid-good", prompt: "Do it. APPROVE-ME", branch: "uf/repo-good" },
        { id: "mid-slow", prompt: "Do it. SLOW-ONE", branch: "uf/repo-bad" },
      ],
    });
    const driving = workflows.startReviewBlock("inst-mid", "r", ["mid-good", "mid-slow"]);
    await until("the fast review to be approved", () =>
      workflows.reviewItemsOf("inst-mid", "r").some((i) => i.origin_run_id === "mid-good" && i.status === "approved"));
    const midBlock = workflows.instanceSpend("inst-mid");
    workflows.stopInstance("inst-mid", { kind: "operator" });
    await settledWithin(driving, 30_000, "startReviewBlock");

    assert.ok(midBlock.spentGuardUSD >= 0.02, `the guard figure mid-block omits a finished review: ${midBlock.spentGuardUSD}`);
    assert.equal(midBlock.subjects, 1, "the review block is not counted among what pays");
  });

  it("is held at its boundary rather than starting billed reviews past the limit", async () => {
    reviewScene("inst-over", {
      budget: { maxInstanceCostUSD: 0.01 },
      runs: [
        { id: "over-good", prompt: "Do it. APPROVE-ME", branch: "uf/repo-good" },
        { id: "over-spender", prompt: "spent", branch: "uf/repo-good", spent: 1, member: true },
      ],
    });
    await settledWithin(workflows.startReviewBlock("inst-over", "r", ["over-good"]), 30_000, "startReviewBlock");

    assert.deepEqual(reviewsOf("over-good"), [], "a review was started with the workflow $0.99 past its limit");
    const stored = dbMod
      .db()
      .prepare("SELECT status, stop_cause AS cause FROM workflow_instances WHERE id='inst-over'")
      .get() as { status: string; cause: string };
    assert.deepEqual(stored, { status: "stopping", cause: "guard" });
  });
});
