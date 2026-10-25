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
let landGate: typeof import("./landGate");
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
  landGate = await import("./landGate");
  const settings = await import("./settings");
  // No network here, and a fix run is held in the queue rather than spawned:
  // what the cases below ask is whether one is *created*. A concurrency cap of
  // none rather than the hold on new work, which a review block reads too and
  // would keep these reviews from running at all.
  settings.saveSettings({ planUsageFromApi: false, maxConcurrentRuns: 0 });

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
    verdictSource?: { kind: string; command?: string };
    budget?: Record<string, number>;
    runs: Array<{
      id: string;
      prompt: string;
      branch: string;
      spent?: number;
      member?: boolean;
      status?: string;
      model?: string;
      /** The run's own checkout, `worktree_path`. None unless given. */
      slot?: string;
    }>;
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
    verdictSource: kind === "review" ? (opts.verdictSource ?? null) : null,
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
       repo_root, provider, spent_usd, model, worktree_path)
     VALUES (?, ?, ?, ?, '{"maxIterations":1}', 1, 1, ?, 'worktree', ?, ?, 'main', ?,
             'claude', ?, ?, ?)`,
  );
  const insertMember = db.prepare(
    `INSERT INTO workflow_instance_runs (instance_id, node_id, node_name, position, run_id)
     VALUES (?, ?, 'Worker', ?, ?)`,
  );
  opts.runs.forEach((run, i) => {
    insertRun.run(
      run.id,
      repoRoot(),
      run.prompt,
      run.status ?? "completed",
      Date.now(),
      run.branch,
      base,
      repoRoot(),
      run.spent ?? 0,
      run.model ?? null,
      run.slot ?? null,
    );
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

describe("a review block whose branch the operator is already reviewing", () => {
  it("waits for that review to end, then runs its own, rather than setting the branch aside", async () => {
    const review = await import("./review");
    reviewScene("inst-dup", {
      runs: [{ id: "dup-origin", prompt: "Do it. APPROVE-ME SLOW-ONE", branch: "uf/repo-good" }],
    });
    // The Review button on the run's own page; the stub takes `SLOW_REVIEW_MS`
    // over it, and it asks no verdict of a Claude run, so the block cannot
    // borrow it.
    const manual = await review.startReview("dup-origin");
    assert.ok(manual.ok, "the operator's review started");
    await until("the operator's review to be running", () => reviewRunning("dup-origin"));
    await settledWithin(workflows.startReviewBlock("inst-dup", "r", ["dup-origin"]), 30_000, "startReviewBlock");

    assert.deepEqual(
      workflows.reviewItemsOf("inst-dup", "r").map((i) => [i.status, i.note]),
      [["approved", null]],
      "the branch was set aside because a review of it was already running",
    );
    assert.deepEqual(
      reviewsOf("dup-origin").map((r) => r.status),
      ["completed", "completed"],
      "the operator's review and the block's own",
    );
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

describe("a review block while the install's new work is held", () => {
  it("spawns no reviewer when the hold lands while the review is being prepared, and reviews on the lift", async () => {
    // The halt case above with the halt replaced by the hold: pressed inside
    // `startReview`'s own snapshot read, after `driveReviewItem`'s door asked
    // `newWorkPaused()` and before the child would be spawned.
    const settings = await import("./settings");
    reviewScene("inst-hold-gap", {
      runs: [{ id: "hold-gap-origin", prompt: "Do it. APPROVE-ME", branch: "uf/repo-good" }],
    });
    let pressed = false;
    duringSnapshot = () => {
      if (workflows.reviewItemsOf("inst-hold-gap", "r").length === 0) return false;
      settings.setNewWorkPaused(true);
      pressed = true;
      return true;
    };
    const driving = workflows.startReviewBlock("inst-hold-gap", "r", ["hold-gap-origin"]);
    try {
      await until("the hold to be pressed", () => pressed);
      // Long enough for a stub reviewer spawned past the hold to have finished.
      await sleep(1_500);
      assert.deepEqual(
        reviewsOf("hold-gap-origin").map((r) => r.status),
        [],
        "a billed reviewer was spawned after the operator held new work",
      );
      assert.deepEqual(
        workflows.reviewItemsOf("inst-hold-gap", "r").map((i) => [i.status, i.note]),
        [["reviewing", null]],
        "the branch was set aside over the hold rather than waiting for the lift",
      );
    } finally {
      duringSnapshot = null;
      settings.setNewWorkPaused(false);
      await settledWithin(driving, 30_000, "startReviewBlock");
    }
    assert.deepEqual(
      workflows.reviewItemsOf("inst-hold-gap", "r").map((i) => [i.status, i.note]),
      [["approved", null]],
    );
    assert.equal(reviewsOf("hold-gap-origin").length, 1, "the lift started the one review");
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

  it("starts no queued review once the reviews it already banked are past the limit", async () => {
    // One slot, so branches two to four each wait in the queue, and each review
    // reports $0.02: two reviews put $0.04 on the block against $0.03.
    const settings = await import("./settings");
    settings.saveSettings({ maxConcurrentAssists: 1 });
    const ids = ["queued-a", "queued-b", "queued-c", "queued-d"];
    try {
      reviewScene("inst-queued", {
        budget: { maxInstanceCostUSD: 0.03 },
        runs: ids.map((id) => ({ id, prompt: "Do it. APPROVE-ME", branch: "uf/repo-good" })),
      });
      await settledWithin(workflows.startReviewBlock("inst-queued", "r", ids), 30_000, "startReviewBlock");
    } finally {
      settings.saveSettings({ maxConcurrentAssists: 2 });
    }

    const started = ids.filter((id) => reviewsOf(id).length > 0).length;
    const total = workflows.instanceSpend("inst-queued").spentUSD;
    assert.equal(started, 2, `${started} reviews started; $${total.toFixed(2)} against a $0.03 limit`);
    // A sibling's guard read banks a review its own branch has not polled for
    // yet, and the branch's poll then finds it banked: once, never twice.
    const billed = ids.flatMap((id) => reviewsOf(id)).reduce((sum, r) => sum + r.cost_usd, 0);
    assert.equal(total.toFixed(4), billed.toFixed(4), "a review was banked twice, or not at all");
    const stored = dbMod
      .db()
      .prepare("SELECT status, stop_cause AS cause FROM workflow_instances WHERE id='inst-queued'")
      .get() as { status: string; cause: string | null };
    assert.equal(stored.cause, "guard");
  });

  it("hands its door on to the next branch when one branch's passage through it throws", async () => {
    // The first branch's guard read throws inside the door, and its branch is
    // set aside by `startReviewBlock`'s catch. The second is queued behind it at
    // the door: left waiting on a passage that never settled cleanly, the block
    // never ends, and nothing says why.
    reviewScene("inst-door-throw", {
      budget: { maxInstanceCostUSD: 1 },
      runs: [
        { id: "door-throws", prompt: "Do it. APPROVE-ME", branch: "uf/repo-good" },
        { id: "door-after", prompt: "Do it. APPROVE-ME", branch: "uf/repo-good" },
      ],
    });
    let thrown = false;
    duringSnapshot = () => {
      // The block's own read at its start comes before any item is seeded.
      if (thrown || workflows.reviewItemsOf("inst-door-throw", "r").length === 0) return false;
      thrown = true;
      throw new Error("the window could not be read");
    };
    try {
      await settledWithin(
        workflows.startReviewBlock("inst-door-throw", "r", ["door-throws", "door-after"]),
        30_000,
        "startReviewBlock",
      );
    } finally {
      duringSnapshot = null;
    }

    assert.deepEqual(
      workflows.reviewItemsOf("inst-door-throw", "r").map((i) => [i.origin_run_id, i.status]),
      [
        ["door-throws", "set-aside"],
        ["door-after", "approved"],
      ],
    );
    assert.equal(reviewsOf("door-throws").length, 0);
    assert.equal(reviewsOf("door-after").length, 1);
  });

  it("counts a review that has ended before its own branch's poll has noticed", async () => {
    // What `driveReviewItem` leaves for up to `MERGE_POLL_MS`: the review's row
    // is `completed`, so its assist slot is free, and the poll that banks it
    // onto the block has not come round. A guard read in that window — a queued
    // sibling's, a fix run's cycle boundary — is the one asked here.
    reviewScene("inst-unbanked", {
      budget: { maxInstanceCostUSD: 0.03 },
      runs: [{ id: "unbanked-origin", prompt: "Do it. APPROVE-ME", branch: "uf/repo-good" }],
    });
    const db = dbMod.db();
    db.prepare(
      `INSERT INTO run_reviews (id, run_id, kind, created_at, finished_at, status, cost_usd)
       VALUES ('rv-unbanked', 'unbanked-origin', 'review', ?, ?, 'completed', 0.05)`,
    ).run(Date.now(), Date.now());
    db.prepare(
      `INSERT INTO workflow_review_items
         (instance_id, block_id, origin_run_id, run_id, position, round, status, review_id, updated_at)
       VALUES ('inst-unbanked', 'r', 'unbanked-origin', 'unbanked-origin', 0, 0, 'reviewing', 'rv-unbanked', ?)`,
    ).run(Date.now());

    const guard = workflows.enforceInstanceBudgetForBlock("inst-unbanked", await orch.currentSnapshot());
    const spend = workflows.instanceSpend("inst-unbanked");
    assert.equal(guard?.kind, "halted", `a $0.05 review passed a $0.03 limit: ${JSON.stringify(spend)}`);
    assert.equal(spend.spentUSD.toFixed(4), "0.0500");
  });
});

/* ------------------------------------------------------------------ */
/* A review block that judges by run status                            */
/* ------------------------------------------------------------------ */

describe("a review block that judges by run status", () => {
  it("starts no reviewer, and sets aside what did not complete without marking its task", async () => {
    // Both silent: a reviewer started here bills a review per branch on a block
    // saved to spend nothing, and a mark or a reopen moves a task no model
    // judged — the claim a run left when it ended is the operator's to release.
    reviewScene("inst-status", {
      verdictSource: { kind: "status" },
      runs: [
        // No APPROVE-ME: a frontier review by the stub would reject it.
        { id: "status-done", prompt: "Do it.", branch: "uf/repo-good" },
        { id: "status-asked", prompt: "Do it.", branch: "uf/repo-bad", status: "needs-review" },
      ],
    });
    const db = dbMod.db();
    db.prepare(
      `INSERT INTO tasks (id, title, body, status, priority, origin, claimed_by_run_id,
         created_at, updated_at)
       VALUES ('task-status-held', 'Held', 'brief', 'claimed', 'normal', 'operator',
         'status-asked', 0, 0)`,
    ).run();
    db.prepare(
      "INSERT INTO run_tasks (run_id, task_id, position) VALUES ('status-asked', 'task-status-held', 0)",
    ).run();

    await settledWithin(
      workflows.startReviewBlock("inst-status", "r", ["status-done", "status-asked"]),
      30_000,
      "startReviewBlock",
    );

    const items = workflows.reviewItemsOf("inst-status", "r");
    assert.deepEqual(
      items.map((i) => [i.origin_run_id, i.status, i.note, i.review_id, i.committed_nothing]),
      [
        ["status-done", "approved", null, null, 0],
        ["status-asked", "set-aside", "its run ended needs-review rather than completed", null, 0],
      ],
    );
    assert.deepEqual(reviewsOf("status-done"), [], "a reviewer was started for a status verdict");
    assert.deepEqual(reviewsOf("status-asked"), []);

    const block = db
      .prepare(
        "SELECT status, error, cost_usd FROM workflow_instance_blocks WHERE instance_id='inst-status' AND node_id='r'",
      )
      .get() as { status: string; error: string; cost_usd: number };
    assert.equal(block.status, "emitted");
    assert.match(block.error, /Approved 1 of 2 branch\(es\); set aside .*needs-review rather than completed/);
    assert.equal(block.cost_usd, 0);

    const task = db
      .prepare("SELECT status, claimed_by_run_id, needs_frontier FROM tasks WHERE id='task-status-held'")
      .get() as { status: string; claimed_by_run_id: string | null; needs_frontier: number };
    assert.deepEqual(task, { status: "claimed", claimed_by_run_id: "status-asked", needs_frontier: 0 });
    const comments = db
      .prepare("SELECT COUNT(*) AS n FROM task_comments WHERE task_id='task-status-held'")
      .get() as { n: number };
    assert.equal(comments.n, 0);
  });
});

/* ------------------------------------------------------------------ */
/* A review block over a run on a model that is not a frontier one     */
/* ------------------------------------------------------------------ */

describe("a review block over a Claude run on a below-frontier model", () => {
  const HAIKU = "claude-haiku-4-5";

  /** The model each of a run's reviews was recorded under. */
  function reviewModels(runId: string): Array<string | null> {
    return (
      dbMod.db().prepare("SELECT model FROM run_reviews WHERE run_id=?").all(runId) as Array<{
        model: string | null;
      }>
    ).map((r) => r.model);
  }

  /** A task the run holds, so a needs-frontier mark has somewhere to land. */
  function holdTask(taskId: string, runId: string): void {
    const db = dbMod.db();
    db.prepare(
      `INSERT INTO tasks (id, title, body, status, priority, origin, claimed_by_run_id,
         created_at, updated_at)
       VALUES (?, 'Held', 'brief', 'claimed', 'normal', 'operator', ?, 0, 0)`,
    ).run(taskId, runId);
    db.prepare("INSERT INTO run_tasks (run_id, task_id, position) VALUES (?, ?, 0)").run(runId, taskId);
  }

  it("reviews it on the default model, so the review the block calls frontier is one", async () => {
    const settings = await import("./settings");
    settings.saveSettings({ defaultModel: "claude-opus-5-5" });
    try {
      reviewScene("inst-haiku-default", {
        runs: [
          { id: "haiku-default", prompt: "Do it. APPROVE-ME", branch: "uf/repo-good", model: HAIKU },
          // A run on a frontier model is reviewed on its own, as it always was.
          { id: "sonnet-own", prompt: "Do it. APPROVE-ME", branch: "uf/repo-good", model: "claude-sonnet-5" },
        ],
      });
      await settledWithin(
        workflows.startReviewBlock("inst-haiku-default", "r", ["haiku-default", "sonnet-own"]),
        30_000,
        "startReviewBlock",
      );
      assert.deepEqual(reviewModels("haiku-default"), ["claude-opus-5-5"]);
      assert.deepEqual(reviewModels("sonnet-own"), ["claude-sonnet-5"]);
      assert.deepEqual(
        workflows.reviewItemsOf("inst-haiku-default", "r").map((i) => [i.origin_run_id, i.status]),
        [
          ["haiku-default", "approved"],
          ["sonnet-own", "approved"],
        ],
      );
    } finally {
      settings.saveSettings({ defaultModel: null });
    }
  });

  it("reviews it on Claude Code's own default when Settings names none", async () => {
    reviewScene("inst-haiku-blank", {
      runs: [{ id: "haiku-blank", prompt: "Do it. APPROVE-ME", branch: "uf/repo-good", model: HAIKU }],
    });
    await settledWithin(
      workflows.startReviewBlock("inst-haiku-blank", "r", ["haiku-blank"]),
      30_000,
      "startReviewBlock",
    );
    assert.deepEqual(reviewModels("haiku-blank"), [null]);
  });

  it("starts no reviewer and marks no task when the default is itself a Haiku", async () => {
    // The stub would reject this brief, and a rejection on Haiku is exactly
    // what used to mark the task needs-frontier and be worded as a frontier
    // model's.
    const settings = await import("./settings");
    settings.saveSettings({ defaultModel: HAIKU });
    try {
      reviewScene("inst-haiku-haiku", {
        runs: [{ id: "haiku-haiku", prompt: "Do it badly.", branch: "uf/repo-bad", model: HAIKU }],
      });
      holdTask("task-haiku-held", "haiku-haiku");
      await settledWithin(
        workflows.startReviewBlock("inst-haiku-haiku", "r", ["haiku-haiku"]),
        30_000,
        "startReviewBlock",
      );

      assert.deepEqual(reviewsOf("haiku-haiku"), [], "a Haiku reviewed a branch the block calls frontier-reviewed");
      const [item] = workflows.reviewItemsOf("inst-haiku-haiku", "r");
      assert.equal(item.status, "set-aside");
      assert.match(item.note ?? "", /could not be reviewed: .*claude-haiku-4-5.*not a frontier model/);
      assert.doesNotMatch(item.note ?? "", /needs-frontier/);

      const task = dbMod
        .db()
        .prepare("SELECT status, claimed_by_run_id, needs_frontier FROM tasks WHERE id='task-haiku-held'")
        .get();
      assert.deepEqual(task, { status: "claimed", claimed_by_run_id: "haiku-haiku", needs_frontier: 0 });
    } finally {
      settings.saveSettings({ defaultModel: null });
    }
  });
});

/* ------------------------------------------------------------------ */
/* A review block that judges by a verify command                      */
/* ------------------------------------------------------------------ */

describe("a review block that judges by a verify command", () => {
  /** A branch whose `check.js` is `body`, checked out in a slot of its own. */
  function branchWithCheck(branch: string, body: string): string {
    git(repoRoot(), "switch", "-q", "-c", branch);
    fs.writeFileSync(path.join(repoRoot(), "check.js"), body);
    git(repoRoot(), "add", "check.js");
    git(repoRoot(), "commit", "-q", "-m", `check for ${branch}`);
    git(repoRoot(), "switch", "-q", "main");
    const slot = path.join(root, MOUNT_DIR, ".uf-worktrees", branch.replace(/\W/g, "-"));
    git(repoRoot(), "worktree", "add", "-q", slot, branch);
    return slot;
  }

  it("approves on exit 0, and sets aside with the tail on a failure, a timeout and no checkout", async () => {
    // One command for every branch, and each branch's own `check.js` deciding
    // how it ends: so a pass and a failure side by side prove the command ran
    // in each run's checkout. Run anywhere else — the operator's tree, which
    // holds no `check.js`, or one slot for all three — they would all end alike.
    const pass = branchWithCheck("uf/cmd-pass", "console.log('all green');\n");
    const fail = branchWithCheck(
      "uf/cmd-fail",
      "console.error('FAIL a.test.ts');\nconsole.error('1 of 3 failed');\nprocess.exitCode = 3;\n",
    );
    const hang = branchWithCheck(
      "uf/cmd-hang",
      "console.log('running the slow suite');\nsetInterval(() => {}, 1000);\n",
    );
    reviewScene("inst-command", {
      verdictSource: { kind: "command", command: `${process.execPath} check.js` },
      runs: [
        { id: "cmd-pass", prompt: "Do it.", branch: "uf/cmd-pass", slot: pass },
        { id: "cmd-fail", prompt: "Do it.", branch: "uf/cmd-fail", slot: fail },
        { id: "cmd-hang", prompt: "Do it.", branch: "uf/cmd-hang", slot: hang },
        { id: "cmd-noslot", prompt: "Do it.", branch: "uf/repo-good" },
      ],
    });
    const db = dbMod.db();
    db.prepare(
      `INSERT INTO tasks (id, title, body, status, priority, origin, claimed_by_run_id,
         created_at, updated_at)
       VALUES ('task-cmd-held', 'Held', 'brief', 'claimed', 'normal', 'operator',
         'cmd-fail', 0, 0)`,
    ).run();
    db.prepare(
      "INSERT INTO run_tasks (run_id, task_id, position) VALUES ('cmd-fail', 'task-cmd-held', 0)",
    ).run();

    // A second rather than `VERIFY_TIMEOUT_MS`'s quarter of an hour, through the
    // same `runVerify` and its own timer: replaced on the module object, which
    // `land.ts` calls it through under the test build's CommonJS emit.
    const realRunVerify = landGate.runVerify;
    (landGate as { runVerify: typeof realRunVerify }).runVerify = (cwd, raw, deps = {}) =>
      realRunVerify(cwd, raw, { ...deps, timeoutMs: 1_000 });
    try {
      await settledWithin(
        workflows.startReviewBlock("inst-command", "r", ["cmd-pass", "cmd-fail", "cmd-hang", "cmd-noslot"]),
        30_000,
        "startReviewBlock",
      );
    } finally {
      (landGate as { runVerify: typeof realRunVerify }).runVerify = realRunVerify;
    }

    const items = workflows.reviewItemsOf("inst-command", "r");
    assert.deepEqual(
      items.map((i) => [i.origin_run_id, i.status, i.note, i.review_id, i.committed_nothing]),
      [
        ["cmd-pass", "approved", null, null, 0],
        ["cmd-fail", "set-aside", "its verify command exited 3\nFAIL a.test.ts\n1 of 3 failed", null, 0],
        [
          "cmd-hang",
          "set-aside",
          "its verify command did not finish in time and was killed after 1 second\nrunning the slow suite",
          null,
          0,
        ],
        [
          "cmd-noslot",
          "set-aside",
          // Land's own refusal, without Land's last sentence: "clear the
          // command in Settings" names a setting this command is not.
          "it could not be verified: A verify command is configured, but this run has no " +
            "checkout of its own to run it in, so nothing here can tell whether its branch is good.",
          null,
          0,
        ],
      ],
    );
    for (const id of ["cmd-pass", "cmd-fail", "cmd-hang", "cmd-noslot"]) {
      assert.deepEqual(reviewsOf(id), [], `a reviewer was started for ${id} under a command verdict`);
    }

    const block = db
      .prepare(
        "SELECT status, error, cost_usd FROM workflow_instance_blocks WHERE instance_id='inst-command' AND node_id='r'",
      )
      .get() as { status: string; error: string; cost_usd: number };
    assert.equal(block.status, "emitted");
    // One line a branch: the output is on the branch's own row, not here.
    assert.ok(
      block.error.startsWith(
        "Approved 1 of 4 branch(es); set aside uf/cmd-fail — its verify command exited 3; " +
          "uf/cmd-hang — its verify command did not finish in time and was killed after 1 second; " +
          "uf/repo-good — it could not be verified: ",
      ),
      block.error,
    );
    assert.doesNotMatch(block.error, /FAIL a\.test\.ts|slow suite|Settings/);
    assert.equal(block.cost_usd, 0);

    // `statusVerdict`'s rule: no model judged the work, so nothing is marked,
    // reopened or commented on.
    const task = db
      .prepare("SELECT status, claimed_by_run_id, needs_frontier FROM tasks WHERE id='task-cmd-held'")
      .get() as { status: string; claimed_by_run_id: string | null; needs_frontier: number };
    assert.deepEqual(task, { status: "claimed", claimed_by_run_id: "cmd-fail", needs_frontier: 0 });
  });

  /** A branch carrying `check.js`, with no checkout of its own. */
  function branchOnly(branch: string, body: string): void {
    git(repoRoot(), "switch", "-q", "-c", branch);
    fs.writeFileSync(path.join(repoRoot(), "check.js"), body);
    git(repoRoot(), "add", "check.js");
    git(repoRoot(), "commit", "-q", "-m", `check for ${branch}`);
    git(repoRoot(), "switch", "-q", "main");
  }

  /** A checkout under the mount, standing on `branch`. */
  function slotOn(name: string, branch: string): string {
    const slot = path.join(root, MOUNT_DIR, ".uf-worktrees", name);
    git(repoRoot(), "worktree", "add", "-q", slot, branch);
    return slot;
  }

  const headOf = (dir: string) => git(dir, "rev-parse", "--abbrev-ref", "HEAD");

  /**
   * Two runs whose checkouts were swapped: a later run took the slot an earlier
   * one finished in, and `allocateSlotPath` did it because that slot was clean.
   * Every run here records the same `worktree_path`, and it stands on the last
   * one's branch.
   */
  it("switches a reused checkout back to the run's branch, checks it there and restores it", async () => {
    const ignoreFile = path.join(repoRoot(), ".git", "info", "exclude");
    fs.appendFileSync(ignoreFile, "deps/\n");
    // The earlier branches' checks read a dependency tree that only the slot
    // has: it is ignored, so it survives the switch, and it is the reason the
    // slot is reused rather than a worktree cut fresh.
    const needsDeps =
      "const fs = require('fs');\n" +
      "if (!fs.existsSync('deps/marker.txt')) { console.error('no dependency tree'); process.exitCode = 4; }\n" +
      "else console.log('early one green');\n";
    branchOnly("uf/swap-early-ok", needsDeps);
    branchOnly("uf/swap-early-red", "console.error('early two broke');\nprocess.exitCode = 5;\n");
    branchOnly("uf/swap-late", "console.error('late one red');\nprocess.exitCode = 7;\n");
    const shared = slotOn("swap-shared", "uf/swap-late");
    fs.mkdirSync(path.join(shared, "deps"));
    fs.writeFileSync(path.join(shared, "deps", "marker.txt"), "installed\n");

    // A slot the later run left uncommitted work in, and one a run is working
    // in: neither may be switched, and neither branch may be called checked.
    branchOnly("uf/swap-dirty", "console.log('would pass');\n");
    branchOnly("uf/swap-dirty-late", "console.log('x');\n");
    const dirty = slotOn("swap-dirty", "uf/swap-dirty-late");
    fs.writeFileSync(path.join(dirty, "scratch.txt"), "mine\n");
    branchOnly("uf/swap-busy", "console.log('would pass');\n");
    branchOnly("uf/swap-busy-late", "console.log('x');\n");
    const occupied = slotOn("swap-occupied", "uf/swap-busy-late");

    reviewScene("inst-swapped", {
      verdictSource: { kind: "command", command: `${process.execPath} check.js` },
      runs: [
        // The slot's current holder is judged first, in place, so the cases
        // after it also prove it was put back.
        { id: "sw-late", prompt: "Do it.", branch: "uf/swap-late", slot: shared },
        { id: "sw-ok", prompt: "Do it.", branch: "uf/swap-early-ok", slot: shared },
        { id: "sw-red", prompt: "Do it.", branch: "uf/swap-early-red", slot: shared },
        { id: "sw-dirty", prompt: "Do it.", branch: "uf/swap-dirty", slot: dirty },
        { id: "sw-occupied", prompt: "Do it.", branch: "uf/swap-busy", slot: occupied },
        { id: "sw-working", prompt: "Do it.", branch: "uf/swap-busy-late", slot: occupied, status: "running" },
      ],
    });

    // What the checkout looked like each time the command started, read from
    // inside `runVerify` so it is the command's tree and not the block's idea.
    const seen: Array<{ branch: string; borrowed: boolean; shareable: boolean }> = [];
    // The two other ways a run could be put into the borrowed checkout while the
    // command is running in it, tried once, on the first branch that borrowed it.
    const meanwhile: Array<{
      reopened: ReturnType<typeof orch.reopenRun>;
      continuation: { id: string; worktree_path: string | null };
    }> = [];
    const realRunVerify = landGate.runVerify;
    (landGate as { runVerify: typeof realRunVerify }).runVerify = (cwd, raw, deps = {}) => {
      const another = orch.holdSlot(cwd);
      another?.();
      const borrowed = orch.isSlotBorrowed(cwd);
      seen.push({ branch: headOf(cwd), borrowed, shareable: another !== null });
      if (borrowed && meanwhile.length === 0) {
        meanwhile.push({
          reopened: orch.reopenRun("sw-late", { maxIterations: 5, maxDurationMinutes: 60 }),
          continuation: orch.createRun({
            folder: "repo",
            mountId: null,
            prompt: "carry on",
            budget: { maxIterations: 1 },
            origin: "form",
            dependsOn: [{ runId: "sw-late", edge: "on-success", continueBranch: true }],
          }),
        });
      }
      return realRunVerify(cwd, raw, deps);
    };
    try {
      await settledWithin(
        workflows.startReviewBlock("inst-swapped", "r", [
          "sw-late",
          "sw-ok",
          "sw-red",
          "sw-dirty",
          "sw-occupied",
        ]),
        30_000,
        "startReviewBlock",
      );
    } finally {
      (landGate as { runVerify: typeof realRunVerify }).runVerify = realRunVerify;
      dbMod.db().prepare("DELETE FROM runs WHERE id='sw-working'").run();
      for (const { continuation } of meanwhile) {
        dbMod.db().prepare("DELETE FROM runs WHERE id=?").run(continuation.id);
      }
    }

    const items = workflows.reviewItemsOf("inst-swapped", "r");
    assert.deepEqual(
      items.map((i) => [i.origin_run_id, i.status, i.note]),
      [
        ["sw-late", "set-aside", "its verify command exited 7\nlate one red"],
        // Approved by `needsDeps`, which passes only in a checkout that kept its
        // dependency tree: the branch was checked in the slot, not in a fresh one.
        ["sw-ok", "approved", null],
        ["sw-red", "set-aside", "its verify command exited 5\nearly two broke"],
        [
          "sw-dirty",
          "set-aside",
          `it could not be verified: A verify command is configured, but ${dirty} no longer holds ` +
            "uf/swap-dirty — a later run has taken that checkout over, so there is nowhere to run " +
            "the check against this work. It was not switched back to uf/swap-dirty for the check, " +
            "because it holds 1 uncommitted path(s) from uf/swap-dirty-late: scratch.txt.",
        ],
        [
          "sw-occupied",
          "set-aside",
          `it could not be verified: A verify command is configured, but ${occupied} no longer holds ` +
            "uf/swap-busy — a later run has taken that checkout over, so there is nowhere to run " +
            "the check against this work. It was not switched back to uf/swap-busy for the check, " +
            "because a run is working in it.",
        ],
      ],
    );

    // The command ran three times, never in the two checkouts it was refused:
    // in place on the slot's holder, then on each early branch with the slot
    // switched to it and borrowed, so no second check could share it.
    assert.deepEqual(seen, [
      { branch: "uf/swap-late", borrowed: false, shareable: true },
      { branch: "uf/swap-early-ok", borrowed: true, shareable: false },
      { branch: "uf/swap-early-red", borrowed: true, shareable: false },
    ]);

    // Neither the run that was the slot's holder, picked up again, nor a run
    // continuing its branch was put into the checkout under the command:
    // `ensureWorktree` would have switched it back to that branch.
    assert.equal(meanwhile.length, 1, "the command never ran in a borrowed checkout, so this proves nothing");
    const [{ reopened, continuation }] = meanwhile;
    assert.equal(reopened.ok, false, "picked up into a checkout a verify command was using");
    assert.match(reopened.ok ? "" : reopened.reason, /verify command on another branch/);
    assert.equal(orch.getRun("sw-late")?.status, "completed");
    assert.notEqual(continuation.worktree_path, shared, "a continuation inherited the borrowed checkout");

    // Put back, clean, and free for the next run to be given.
    assert.equal(headOf(shared), "uf/swap-late");
    assert.equal(git(shared, "status", "--porcelain"), "");
    assert.equal(orch.isSlotBorrowed(shared), false);
    const free = orch.holdSlot(shared);
    assert.ok(free, "the slot is still held after the block");
    free();

    // Neither refused checkout was touched.
    assert.equal(headOf(dirty), "uf/swap-dirty-late");
    assert.equal(fs.readFileSync(path.join(dirty, "scratch.txt"), "utf8"), "mine\n");
    assert.equal(headOf(occupied), "uf/swap-busy-late");
  });

  it("waits for a check already running in the slot, and does not set the branch aside over it", async () => {
    branchOnly("uf/wait-early", "console.log('green');\n");
    branchOnly("uf/wait-late", "console.log('green');\n");
    const shared = slotOn("wait-shared", "uf/wait-late");
    reviewScene("inst-wait", {
      verdictSource: { kind: "command", command: `${process.execPath} check.js` },
      runs: [{ id: "wait-early", prompt: "Do it.", branch: "uf/wait-early", slot: shared }],
    });

    // A land's or a delivery's check, holding the slot as `verifyInSlot` does.
    const release = orch.holdSlot(shared);
    assert.ok(release, "the slot was free to hold");
    const block = settledWithin(
      workflows.startReviewBlock("inst-wait", "r", ["wait-early"]),
      30_000,
      "startReviewBlock",
    );
    await sleep(300);
    assert.deepEqual(
      workflows.reviewItemsOf("inst-wait", "r").map((i) => [i.status, i.note]),
      [["reviewing", null]],
      "the branch was judged while another check held its slot",
    );
    assert.equal(headOf(shared), "uf/wait-late", "the slot was switched under the other check");

    release();
    await block;
    assert.deepEqual(
      workflows.reviewItemsOf("inst-wait", "r").map((i) => [i.status, i.note]),
      [["approved", null]],
    );
    assert.equal(headOf(shared), "uf/wait-late");
  });
});
