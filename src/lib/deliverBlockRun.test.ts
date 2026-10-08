import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * What a workflow's deliver block does to a real repository and a real remote.
 *
 * Three claims, each silent until somebody looks at GitHub. **The operator's
 * checkout need not be clean**, which is the reason the block exists: a merge
 * block refuses every branch in a repository whose checkout has uncommitted
 * changes, and `deliverRun` was read to see whether it shared that — it does
 * not, because it reads the remote and writes `.git/config` and never asks
 * `landState` whether the checkout is `blocked`. A refactor that made it ask
 * would put the dirty-checkout failure back, and nothing else would notice.
 * **A branch with nothing to deliver is the block's skip and not its failure**,
 * and nothing is pushed for it. And **a branch that already has a pull request
 * is not pushed again**, the Land card's own rule, because a second push would
 * update that pull request and then be refused by GitHub's "already exists".
 *
 * The pure half — what the outcome of several branches reads as — is pinned in
 * `workflows.test.ts`. This is the join those cannot reach: a real instance
 * row, the scheduler's claim, `deliverRun`'s own gates and the run's row.
 *
 * Driven in `deliverRun.test.ts`' harness and for its reasons: the remote is a
 * **local bare repository under this test's own temporary directory**, `origin`
 * reads as a GitHub URL and `pushInsteadOf` sends the push there, every scene
 * asserts that rewrite before it presses, and the pull request is opened by a
 * stub standing in for `fetch`. Nothing here reaches GitHub or its API.
 *
 * Its own file, with `DATA_DIR` and the token named before the first import,
 * for `deliverRun.test.ts`' reason: `config.ts` is read at module load.
 */

let workflows: typeof import("./workflows");
let land: typeof import("./land");
let dbMod: typeof import("./db");
let settings: typeof import("./settings");
let orchestrator: typeof import("./orchestrator");
let root: string;

const MOUNT_DIR = "deliver-block-mount";
const GITHUB_REMOTE = "https://github.com/acme/widget.git";
const PULLS_ENDPOINT = "https://api.github.com/repos/acme/widget/pulls";

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
  });

/** Every pull request the stub was asked to open, in order. */
let opened: Array<{ head: string; base: string }> = [];
let realFetch: typeof fetch;

/** The one endpoint `openPullRequest` calls; anything else is refused, not forwarded. */
const stubFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url !== PULLS_ENDPOINT) throw new Error(`the test's fetch stub refuses ${url}`);
  const body = JSON.parse(String(init?.body)) as { head: string; base: string };
  opened.push({ head: body.head, base: body.base });
  const number = 70 + opened.length;
  return new Response(
    JSON.stringify({ number, html_url: `https://github.com/acme/widget/pull/${number}` }),
    { status: 201, headers: { "content-type": "application/json" } },
  );
}) as typeof fetch;

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-deliver-block-")));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, MOUNT_DIR);
  process.env.WORKSPACE_ROOTS = "";
  // A credential `planDelivery` accepts. It never leaves this process: the push
  // goes to a local path, and the stub above answers the API call.
  process.env.UF_GITHUB_TOKEN = "test-token-not-a-real-credential";
  process.env.UF_GITHUB_TOKENS = "";
  // Nothing here should reach a spawn of `claude`; one that does fails rather
  // than bills.
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");
  fs.mkdirSync(path.join(root, MOUNT_DIR), { recursive: true });

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );
  dbMod = await import("./db");
  land = await import("./land");
  settings = await import("./settings");
  orchestrator = await import("./orchestrator");
  workflows = await import("./workflows");

  realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch;
});

after(() => {
  globalThis.fetch = realFetch;
  const open = (globalThis as { __ufDb?: { close(): void } }).__ufDb;
  open?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  for (const table of [
    "workflow_instance_blocks",
    "workflow_instance_runs",
    "workflow_instances",
    "workflows",
    "runs",
  ]) {
    dbMod.db().prepare(`DELETE FROM ${table}`).run();
  }
  settings.saveSettings({ landVerifyCommand: "" });
  opened = [];
});

interface Scene {
  runId: string;
  repo: string;
  slot: string;
  branch: string;
  remote: string;
  instanceId: string;
}

/** A graph node with every field the wire carries, so a case states what it varies. */
function graphNode(id: string, name: string, kind: "run" | "deliver") {
  return {
    id,
    name,
    kind,
    templateId: null,
    mountId: kind === "run" ? "work" : "",
    folder: "",
    task: kind === "run" ? name : "",
    promptOverride: null,
    agentId: null,
    fanOut: null,
    mergeStrategy: null,
    mergeAutoResolve: false,
    maxPasses: null,
    maxLoopCostUSD: null,
    stopWhenTasks: null,
    bodyNodeIds: [],
    provider: null,
    fixRounds: null,
  };
}

/**
 * A finished run with one commit on its isolated branch, the operator's
 * checkout on `main`, `origin` reading as GitHub while pushing to a bare
 * repository — and a workflow instance with a deliver block waiting behind it.
 */
function scene(name: string, opts: { commits?: boolean } = {}): Scene {
  const repo = path.join(root, MOUNT_DIR, name);
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "shared.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "main").trim();

  const remote = path.join(root, "remotes", `${name}.git`);
  fs.mkdirSync(remote, { recursive: true });
  git(remote, "init", "-q", "--bare");
  git(repo, "remote", "add", "origin", GITHUB_REMOTE);
  git(repo, "config", `url.${remote}.pushInsteadOf`, GITHUB_REMOTE);
  // The guard every scene stands on: if the rewrite ever stopped applying, the
  // press below would aim at GitHub, so the test refuses to press at all.
  assert.equal(git(repo, "remote", "get-url", "--push", "origin").trim(), remote);
  assert.equal(git(repo, "remote", "get-url", "origin").trim(), GITHUB_REMOTE);

  const branch = `uf/${name}`;
  const slot = path.join(
    orchestrator.worktreeStore(repo)!,
    `${orchestrator.repoSlug(repo)}-1`,
  );
  git(repo, "worktree", "add", "-q", "-b", branch, slot);
  if (opts.commits !== false) {
    fs.writeFileSync(path.join(slot, "shared.txt"), "branch\n");
    git(slot, "commit", "-qam", "the run's work");
  }

  const runId = `run-${name}`;
  const now = Date.now();
  const db = dbMod.db();
  db.prepare(
    `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                       created_at, finished_at, isolation, repo_root, work_dir,
                       worktree_path, worktree_branch, worktree_base, worktree_base_branch)
     VALUES (?, ?, 'do the thing', 'completed', '{}', 1, 1, ?, ?, 'worktree', ?, ?, ?, ?, ?, 'main')`,
  ).run(runId, repo, now, now, repo, slot, slot, branch, base);

  const instanceId = `inst-${name}`;
  const graph = JSON.stringify({
    nodes: [graphNode("build", "Build it", "run"), graphNode("ship", "Open the PR", "deliver")],
    edges: [{ from: "build", to: "ship", edge: "on-success", continueBranch: false }],
  });
  db.prepare(
    "INSERT INTO workflows (id, name, graph, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(`wf-${name}`, name, graph, now, now);
  db.prepare(
    `INSERT INTO workflow_instances (id, workflow_id, workflow_name, graph, created_at, status)
     VALUES (?, ?, ?, ?, ?, 'started')`,
  ).run(instanceId, `wf-${name}`, name, graph, now);
  db.prepare(
    "INSERT INTO workflow_instance_runs (instance_id, node_id, node_name, position, run_id)" +
      " VALUES (?, 'build', 'Build it', 0, ?)",
  ).run(instanceId, runId);
  db.prepare(
    "INSERT INTO workflow_instance_blocks (instance_id, node_id, node_name, position, kind, status)" +
      " VALUES (?, 'ship', 'Open the PR', 1, 'deliver', 'waiting')",
  ).run(instanceId);

  return { runId, repo, slot, branch, remote, instanceId };
}

/** The branch as the remote has it, or null when nothing was pushed. */
function remoteTip(s: Scene): string | null {
  const refs = git(s.remote, "for-each-ref", "--format=%(refname) %(objectname)").trim();
  const line = refs.split("\n").find((l) => l.startsWith(`refs/heads/${s.branch} `));
  return line ? line.split(" ")[1] : null;
}

/** Press the scheduler and wait for the deliver block to leave `waiting`/`thinking`. */
async function settleBlock(s: Scene) {
  workflows.advanceInstances();
  const deadline = Date.now() + 20_000;
  for (;;) {
    const block = workflows.blocksOf(s.instanceId).find((b) => b.nodeId === "ship")!;
    if (block.status !== "waiting" && block.status !== "thinking") return block;
    if (Date.now() > deadline) assert.fail(`the deliver block never settled: ${block.status}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("a deliver block against a real repository", () => {
  it("pushes the branch and opens its pull request while the operator's checkout is dirty", async () => {
    const s = scene("dirty");
    // What a merge block refuses a whole repository over: uncommitted changes
    // in the operator's own checkout, tracked and untracked.
    fs.writeFileSync(path.join(s.repo, "shared.txt"), "the operator is mid-edit\n");
    fs.writeFileSync(path.join(s.repo, "scratch.txt"), "not yet added\n");
    const dirty = git(s.repo, "status", "--porcelain");
    assert.match(dirty, /shared\.txt/, "the scene's checkout is dirty before the block runs");

    const block = await settleBlock(s);

    assert.equal(block.status, "emitted", block.error ?? "");
    assert.match(block.error ?? "", /Delivered 1 branch\(es\): uf\/dirty — https:\/\/github\.com\/acme\/widget\/pull\/71/);
    assert.equal(remoteTip(s), git(s.slot, "rev-parse", "HEAD").trim());
    assert.deepEqual(opened, [{ head: s.branch, base: "main" }]);
    assert.equal(
      land.deliveredPullRequest(s.runId)?.url,
      "https://github.com/acme/widget/pull/71",
      "the run's row records it, which is what the Land card reads",
    );
    // Delivery wrote `.git/config` and nothing in the working tree.
    assert.equal(git(s.repo, "status", "--porcelain"), dirty);
    assert.equal(fs.readFileSync(path.join(s.repo, "shared.txt"), "utf8"), "the operator is mid-edit\n");
  });

  it("succeeds without pushing for a branch that left no commits", async () => {
    const s = scene("empty", { commits: false });

    const block = await settleBlock(s);

    assert.equal(block.status, "emitted", block.error ?? "");
    // A branch with no commits is an ancestor of its target, so git reports it
    // as already there; the block's skip is the same either way.
    assert.match(block.error ?? "", /^Nothing to deliver: uf\/empty — already on main/);
    assert.equal(remoteTip(s), null);
    assert.deepEqual(opened, []);
  });

  it("does not open a second pull request for a branch that already has one", async () => {
    const s = scene("twice");
    const first = await land.deliverRun(s.runId);
    assert.equal(first.ok, true, first.ok ? "" : first.reason);
    assert.equal(opened.length, 1);

    const block = await settleBlock(s);

    assert.equal(block.status, "emitted", block.error ?? "");
    assert.match(block.error ?? "", /uf\/twice — it already has pull request #71/);
    assert.equal(opened.length, 1, "GitHub would have refused the second as already existing");
  });

  it("fails the block, and pushes nothing, when the verify command refuses the branch", async () => {
    const s = scene("verify");
    const refuse = path.join(root, "refuse.js");
    fs.writeFileSync(refuse, "process.exit(1);\n");
    settings.saveSettings({ landVerifyCommand: `${process.execPath} ${refuse}` });

    const block = await settleBlock(s);

    assert.equal(block.status, "failed");
    assert.match(block.error ?? "", /Delivered 0 of 1 branch\(es\)\. Not delivered: uf\/verify — /);
    assert.equal(remoteTip(s), null);
    assert.deepEqual(opened, []);
  });
});
