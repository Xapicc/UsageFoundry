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
 * printing the `stream-json` result Claude Code ends a review with. Its own
 * `DATA_DIR` before the first import, `loopMergeOwnership.test.ts`' reason.
 */

let workflows: typeof import("./workflows");
let dbMod: typeof import("./db");
let root: string;

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

function writeStub(dir: string): string {
  const stub = path.join(dir, "claude-reviewer-stub.js");
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const prompt = args[args.indexOf("-p") + 1] || "";
const verdict = prompt.includes("APPROVE-ME") ? "APPROVE" : "REJECT";
const asksForVerdict = prompt.includes("## Verdict");
const result = "## Summary\\nRead it.\\n\\n## Look at this first\\nsrc\\n\\n## Risks\\nnone\\n" +
  (asksForVerdict ? "\\n## Verdict\\n" + verdict + "\\n" : "");
process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n");
process.stdout.write(JSON.stringify({
  type: "result", subtype: "success", is_error: false, result,
  total_cost_usd: 0.02, usage: { input_tokens: 10, output_tokens: 5 },
}) + "\\n");
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
  const base = git(repoRoot(), "rev-parse", "HEAD");
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
    await workflows.startReviewBlock(INSTANCE, "r", ["run-good", "run-bad"]);
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
