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
 * A fourth, further down, is the retry: **a second try after a first that
 * failed on one branch pushes only what the first missed**. That is the whole
 * ground for offering the pick-up at all, and it holds only because
 * `deliverBranch` asks `deliveredPullRequest` ahead of the push; a retry that
 * pushed every branch again would update each pull request's branch and then be
 * refused by GitHub, and nothing else would notice.
 *
 * Then the halt: **a Stop that lands while a branch is in its verify command
 * pushes nothing**, though the page already reads Stopped and nothing on the
 * instance would say a push had happened. And last the shutdown: **a block
 * reached during one is not claimed**, so it neither fails on a refusal nor
 * releases the block behind it.
 *
 * The pure half — what the outcome of several branches reads as — is pinned in
 * `workflows.test.ts`. This is the join those cannot reach: a real instance
 * row, the scheduler's claim, `deliverRun`'s own gates and the run's row.
 *
 * Driven in `deliverRun.test.ts`' harness and for its reasons: the remote is a
 * **local bare repository under this test's own temporary directory**, `origin`
 * is a genuine `https://github.com/acme/<name>.git` and git's https transport
 * is replaced by a stand-in serving the bare repository for it — not
 * `pushInsteadOf`, which Deliver refuses — every scene's first push goes
 * through the stand-in before it presses, and the pull request is opened by a
 * stub standing in for `fetch`. Nothing here reaches GitHub or its API, and the
 * process's own `GIT_*`, `GH_*` and `GITHUB_*` variables are cleared first.
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
let remotes: string;

const MOUNT_DIR = "deliver-block-mount";
/** `origin` for the branch named `name`; the stand-in serves `<remotes>/<name>.git` for it. */
const githubRemote = (name: string) => `https://github.com/acme/${name}.git`;
const PULLS_ENDPOINT = /^https:\/\/api\.github\.com\/repos\/acme\/([^/]+)\/pulls$/;

for (const key of Object.keys(process.env)) {
  if (/^(GIT_|GH_|GITHUB_)/.test(key)) delete process.env[key];
}

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
  const repo = PULLS_ENDPOINT.exec(url)?.[1];
  if (!repo) throw new Error(`the test's fetch stub refuses ${url}`);
  const body = JSON.parse(String(init?.body)) as { head: string; base: string };
  opened.push({ head: body.head, base: body.base });
  const number = 70 + opened.length;
  return new Response(
    JSON.stringify({ number, html_url: `https://github.com/acme/${repo}/pull/${number}` }),
    { status: 201, headers: { "content-type": "application/json" } },
  );
}) as typeof fetch;

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-deliver-block-")));
  remotes = path.join(root, "remotes");
  fs.mkdirSync(remotes);
  process.env.GIT_EXEC_PATH = standInTransport();
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, MOUNT_DIR);
  process.env.WORKSPACE_ROOTS = "";
  // A credential `planDelivery` accepts. It never leaves this process: the
  // stand-in transport asks for none, and the stub above answers the API call.
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

/** `deliverRun.test.ts`' stand-in transport, copied for the reason given there. */
function standInTransport(): string {
  const real = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
  const dir = path.join(root, "git-exec");
  fs.mkdirSync(dir);
  for (const entry of fs.readdirSync(real)) {
    if (entry !== "git-remote-https") fs.symlinkSync(path.join(real, entry), path.join(dir, entry));
  }
  fs.writeFileSync(
    path.join(dir, "git-remote-https"),
    [
      "#!/bin/sh",
      'repo=$(basename "$2" .git)',
      "while read -r line; do",
      '  case "$line" in',
      "    capabilities) printf 'connect\\n\\n' ;;",
      `    "connect "*) printf '\\n'; exec \${line#connect } "${remotes}/$repo.git" ;;`,
      "    *) exit 1 ;;",
      "  esac",
      "done",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return dir;
}

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

interface Branch {
  runId: string;
  repo: string;
  slot: string;
  branch: string;
  remote: string;
}

interface Scene extends Branch {
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
 * repository.
 *
 * The commit's file names the branch, so a verify command can refuse one branch
 * and pass another from the tree it is run in.
 */
function branchScene(name: string, opts: { commits?: boolean } = {}): Branch {
  const repo = path.join(root, MOUNT_DIR, name);
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "shared.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "main").trim();

  const remote = path.join(remotes, `${name}.git`);
  git(root, "init", "-q", "--bare", remote);
  const url = githubRemote(name);
  git(repo, "remote", "add", "origin", url);
  // The guard every scene stands on: if the stand-in ever stopped carrying the
  // push, the press below would aim at GitHub, so the test refuses to press.
  assert.equal(git(repo, "remote", "get-url", "--push", "--all", "origin").trim(), url);
  git(repo, "push", "-q", "origin", "main:refs/heads/main");
  assert.equal(git(remote, "rev-parse", "refs/heads/main").trim(), base);

  const branch = `uf/${name}`;
  const slot = path.join(
    orchestrator.worktreeStore(repo)!,
    `${orchestrator.repoSlug(repo)}-1`,
  );
  git(repo, "worktree", "add", "-q", "-b", branch, slot);
  if (opts.commits !== false) {
    fs.writeFileSync(path.join(slot, "shared.txt"), `branch ${name}\n`);
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

  return { runId, repo, slot, branch, remote };
}

/**
 * A workflow instance with a deliver block `ship` waiting behind the given
 * builds — and, with `afterOnFinish`, a run node `after` set to start once
 * `ship` finishes either way, held as the `waiting` row `startWorkflow` writes
 * for a node deferred behind a block.
 */
function instanceFor(
  name: string,
  builds: ReadonlyArray<{ id: string; branch: Branch }>,
  opts: { afterOnFinish?: boolean } = {},
): string {
  const now = Date.now();
  const db = dbMod.db();
  const instanceId = `inst-${name}`;
  const graph = JSON.stringify({
    nodes: [
      ...builds.map((b) => graphNode(b.id, `Build ${b.id}`, "run")),
      graphNode("ship", "Open the PR", "deliver"),
      ...(opts.afterOnFinish ? [graphNode("after", "Then this", "run")] : []),
    ],
    edges: [
      ...builds.map((b) => ({
        from: b.id,
        to: "ship",
        edge: "on-success",
        continueBranch: false,
      })),
      ...(opts.afterOnFinish
        ? [{ from: "ship", to: "after", edge: "on-finish", continueBranch: false }]
        : []),
    ],
  });
  db.prepare(
    "INSERT INTO workflows (id, name, graph, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(`wf-${name}`, name, graph, now, now);
  db.prepare(
    `INSERT INTO workflow_instances (id, workflow_id, workflow_name, graph, created_at, status)
     VALUES (?, ?, ?, ?, ?, 'started')`,
  ).run(instanceId, `wf-${name}`, name, graph, now);
  builds.forEach((b, position) => {
    db.prepare(
      "INSERT INTO workflow_instance_runs (instance_id, node_id, node_name, position, run_id)" +
        " VALUES (?, ?, ?, ?, ?)",
    ).run(instanceId, b.id, `Build ${b.id}`, position, b.branch.runId);
  });
  db.prepare(
    "INSERT INTO workflow_instance_blocks (instance_id, node_id, node_name, position, kind, status)" +
      " VALUES (?, 'ship', 'Open the PR', ?, 'deliver', 'waiting')",
  ).run(instanceId, builds.length);
  if (opts.afterOnFinish) {
    db.prepare(
      "INSERT INTO workflow_instance_blocks (instance_id, node_id, node_name, position, kind, status)" +
        " VALUES (?, 'after', 'Then this', ?, 'run', 'waiting')",
    ).run(instanceId, builds.length + 1);
  }
  return instanceId;
}

/** One branch and the instance whose deliver block waits behind it. */
function scene(name: string, opts: { commits?: boolean } = {}): Scene {
  const branch = branchScene(name, opts);
  return { ...branch, instanceId: instanceFor(name, [{ id: "build", branch }]) };
}

/** The branch as the remote has it, or null when nothing was pushed. */
function remoteTip(s: Branch): string | null {
  const refs = git(s.remote, "for-each-ref", "--format=%(refname) %(objectname)").trim();
  const line = refs.split("\n").find((l) => l.startsWith(`refs/heads/${s.branch} `));
  return line ? line.split(" ")[1] : null;
}

/** Press the scheduler and wait for the deliver block to leave `waiting`/`thinking`. */
async function settleBlock(s: Pick<Scene, "instanceId">) {
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
    assert.match(block.error ?? "", /Delivered 1 branch\(es\): uf\/dirty — https:\/\/github\.com\/acme\/dirty\/pull\/71/);
    assert.equal(remoteTip(s), git(s.slot, "rev-parse", "HEAD").trim());
    assert.deepEqual(opened, [{ head: s.branch, base: "main" }]);
    assert.equal(
      land.deliveredPullRequest(s.runId)?.url,
      "https://github.com/acme/dirty/pull/71",
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

  it("pushes the new commits of a delivered branch that moved since, and opens no second pull request", async () => {
    const s = scene("moved");
    const first = await land.deliverRun(s.runId);
    assert.equal(first.ok, true, first.ok ? "" : first.reason);
    fs.writeFileSync(path.join(s.slot, "followup.txt"), "addressing review\n");
    git(s.slot, "add", "followup.txt");
    git(s.slot, "commit", "-qm", "follow-up the PR asked for");
    const tip = git(s.slot, "rev-parse", "HEAD").trim();
    assert.notEqual(remoteTip(s), tip, "the scene starts with the remote behind the branch");

    const block = await settleBlock(s);

    assert.equal(block.status, "emitted", block.error ?? "");
    assert.match(block.error ?? "", /Delivered 1 branch\(es\): uf\/moved — https:\/\/github\.com\/acme\/moved\/pull\/71/);
    assert.equal(remoteTip(s), tip, "the block passed having published nothing of the new work");
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

/**
 * Two branches behind one deliver block, with a verify command that refuses
 * whichever branch is listed in the returned file.
 *
 * The command reads the commit's own file, which names its branch, because the
 * check runs in the run's own tree and nothing else it can see tells the two
 * apart.
 */
function twoBranchScene(name: string) {
  const a = branchScene(`${name}-a`);
  const b = branchScene(`${name}-b`);
  const instanceId = instanceFor(name, [
    { id: "build-a", branch: a },
    { id: "build-b", branch: b },
  ]);
  const denyList = path.join(root, `${name}-deny.txt`);
  const verify = path.join(root, `${name}-verify.js`);
  fs.writeFileSync(
    verify,
    'const fs = require("node:fs");\n' +
      'const denied = fs.readFileSync(process.argv[2], "utf8").split("\\n");\n' +
      'process.exit(denied.includes(fs.readFileSync("shared.txt", "utf8").trim()) ? 1 : 0);\n',
  );
  settings.saveSettings({ landVerifyCommand: `${process.execPath} ${verify} ${denyList}` });
  return {
    a,
    b,
    instanceId,
    deny: (...branches: Branch[]) =>
      fs.writeFileSync(
        denyList,
        branches.map((x) => fs.readFileSync(path.join(x.slot, "shared.txt"), "utf8").trim()).join("\n"),
      ),
  };
}

const shipBlock = (instanceId: string) =>
  workflows.blocksOf(instanceId).find((x) => x.nodeId === "ship")!;

describe("retrying a deliver block that failed", () => {
  it("pushes only the branch the first try missed, and the note still names both pull requests", async () => {
    const s = twoBranchScene("retry");
    s.deny(s.a);

    const first = await settleBlock({ instanceId: s.instanceId });
    assert.equal(first.status, "failed");
    assert.match(first.error ?? "", /Delivered 1 of 2 branch\(es\)\./);
    // The failed branch did not stop the one after it.
    assert.deepEqual(opened, [{ head: s.b.branch, base: "main" }]);
    assert.equal(remoteTip(s.a), null);
    const bTip = remoteTip(s.b);
    assert.notEqual(bTip, null);

    const offered = workflows.pickUpsOf(workflows.getInstance(s.instanceId)!);
    assert.deepEqual(
      offered.map((p) => ({
        kind: p.kind,
        nodeId: "nodeId" in p ? p.nodeId : null,
        retryRefusal: "retryRefusal" in p ? p.retryRefusal : "n/a",
      })),
      [{ kind: "deliver", nodeId: "ship", retryRefusal: null }],
      "a failed deliver block is offered, as a failed merge block is, and nothing else is",
    );

    // What was wrong has been put right: the verify command passes both now.
    s.deny();
    assert.deepEqual(workflows.retryDeliverBlock(s.instanceId, "ship"), { ok: true });
    const second = await settleBlock({ instanceId: s.instanceId });

    assert.equal(second.status, "emitted", second.error ?? "");
    assert.deepEqual(
      opened,
      [
        { head: s.b.branch, base: "main" },
        { head: s.a.branch, base: "main" },
      ],
      "the branch that already had a pull request was not opened a second time",
    );
    assert.equal(remoteTip(s.b), bTip, "and was not pushed again");
    assert.notEqual(remoteTip(s.a), null);
    // The retry's note replaces the first try's, so the first try's pull
    // request has to be in it or the instance page loses its address.
    assert.match(second.error ?? "", /Delivered 1 branch\(es\): .*\/pull\/72/);
    assert.match(second.error ?? "", new RegExp(`${s.b.branch} — it already has pull request #71`));
    assert.deepEqual(
      workflows.pickUpsOf(workflows.getInstance(s.instanceId)!),
      [],
      "nothing is holding the workflow up once the retry has delivered",
    );
  });

  it("fails again, and offers the retry again, while the branch is still refused", async () => {
    const s = twoBranchScene("again");
    s.deny(s.a);
    assert.equal((await settleBlock({ instanceId: s.instanceId })).status, "failed");

    assert.deepEqual(workflows.retryDeliverBlock(s.instanceId, "ship"), { ok: true });
    const second = await settleBlock({ instanceId: s.instanceId });

    assert.equal(second.status, "failed");
    assert.match(second.error ?? "", /Not delivered: .*uf\/again-a/);
    assert.equal(opened.length, 1, "the refused branch was asked again and refused again");
    assert.equal(workflows.pickUpsOf(workflows.getInstance(s.instanceId)!).length, 1);
  });

  it("refuses once a block behind it has started, in the sentence the list gives", () => {
    const s = twoBranchScene("started");
    const db = dbMod.db();
    const after = branchScene("started-after");
    const row = db
      .prepare("SELECT graph FROM workflow_instances WHERE id = ?")
      .get(s.instanceId) as { graph: string };
    const graph = JSON.parse(row.graph) as {
      nodes: unknown[];
      edges: unknown[];
    };
    graph.nodes.push(graphNode("after", "Then this", "run"));
    graph.edges.push({ from: "ship", to: "after", edge: "on-finish", continueBranch: false });
    db.prepare("UPDATE workflow_instances SET graph = ? WHERE id = ?").run(
      JSON.stringify(graph),
      s.instanceId,
    );
    db.prepare(
      "INSERT INTO workflow_instance_runs (instance_id, node_id, node_name, position, run_id)" +
        " VALUES (?, 'after', 'Then this', 3, ?)",
    ).run(s.instanceId, after.runId);
    db.prepare(
      "UPDATE workflow_instance_blocks SET status='failed', error='x' WHERE instance_id=? AND node_id='ship'",
    ).run(s.instanceId);

    const refusal = workflows.retryDeliverBlock(s.instanceId, "ship");

    assert.equal(refusal.ok, false);
    assert.equal(!refusal.ok && refusal.status, 409);
    assert.match(
      !refusal.ok ? refusal.error : "",
      /“Then this” has already started after “Open the PR” failed, so retrying it now would push work/,
    );
    assert.equal(shipBlock(s.instanceId).status, "failed", "nothing was written");
    const offered = workflows.pickUpsOf(workflows.getInstance(s.instanceId)!);
    assert.equal(offered.length, 1);
    assert.equal("retryRefusal" in offered[0] && offered[0].retryRefusal, "“Then this” has already started after it failed.");
  });

  it("refuses a block that is not failed, and a block of another kind", () => {
    const s = twoBranchScene("refuse");

    const waiting = workflows.retryDeliverBlock(s.instanceId, "ship");
    assert.equal(waiting.ok, false);
    assert.match(
      !waiting.ok ? waiting.error : "",
      /“Open the PR” is waiting, so there is no failed delivery to retry\./,
    );
    assert.equal(shipBlock(s.instanceId).status, "waiting");

    const notABlock = workflows.retryDeliverBlock(s.instanceId, "build-a");
    assert.equal(!notABlock.ok && notABlock.status, 404);
    assert.equal(
      workflows.retryMergeBlock(s.instanceId, "ship").ok,
      false,
      "the merge door does not open a deliver block, so a stale button cannot cross them",
    );
  });
});

/**
 * Stop pressed while the block's branch is inside `deliverRun`'s verify
 * command, where nothing has left the machine yet.
 *
 * Measured on 02f3b764 by bug hunt 3/6 (board task 5e2ce382) and again in this
 * harness on 2026-10-17: the halt wrote the block off "while it was delivering
 * branches" and the instance read `stopped` at once, and after the check
 * finished the branch was pushed and its pull request opened anyway. The block
 * read its latch only before each branch, and `deliverRun` asked nothing of the
 * workflow. The check is held on a file rather than a clock, so the Stop lands
 * inside it every time.
 *
 * The check itself is ended too, and that is the second claim: the push was
 * refused but the command ran on, holding the checkout's `landing` claim for as
 * long as it ran, and a Land press, a queue drain and a project Push on that
 * checkout were held behind a workflow already reading Stopped. The check
 * there is held for twenty seconds and these cases wait five, so only a signal
 * to it ends the wait.
 */
describe("a deliver block stopped while it verifies a branch", () => {
  async function until(done: () => boolean, failure: string, limitMs = 20_000): Promise<void> {
    const deadline = Date.now() + limitMs;
    while (!done()) {
      if (Date.now() > deadline) assert.fail(failure);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it("pushes nothing and opens no pull request once the workflow is stopped", async () => {
    const s = scene("stopped");
    const signals = path.join(root, "signals-stopped");
    fs.mkdirSync(signals);
    const probe = path.join(root, "held-check.js");
    fs.writeFileSync(
      probe,
      `const fs = require("node:fs");
const path = require("node:path");
const dir = process.argv[2];
fs.writeFileSync(path.join(dir, "started"), "");
const deadline = Date.now() + 20000;
while (!fs.existsSync(path.join(dir, "go"))) {
  if (Date.now() > deadline) process.exit(3);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
`,
    );
    settings.saveSettings({ landVerifyCommand: `${process.execPath} ${probe} ${signals}` });
    const ship = () => workflows.blocksOf(s.instanceId).find((b) => b.nodeId === "ship")!;

    workflows.advanceInstances();
    await until(() => fs.existsSync(path.join(signals, "started")), "the branch's check never started");
    assert.equal(ship().status, "thinking");

    const halted = workflows.stopInstance(s.instanceId, { kind: "operator" });
    assert.equal(halted.ok, true, halted.ok ? "" : halted.reason);
    assert.equal(workflows.getInstance(s.instanceId)!.status, "stopped");

    fs.writeFileSync(path.join(signals, "go"), "");
    // The claim is let go only once `deliverRun` has returned, pushed or not.
    await until(() => !land.checkoutHolder(s.repo).landing, "the delivery never let go of the checkout");

    assert.equal(remoteTip(s), null, "the branch was pushed after the workflow was stopped");
    assert.deepEqual(opened, [], "a pull request was opened after the workflow was stopped");
    assert.equal(land.deliveredPullRequest(s.runId), null);
    assert.match(ship().error ?? "", /^Stopped by the operator .* while it was delivering branches\.$/);
    assert.equal(workflows.getInstance(s.instanceId)!.status, "stopped");
  });

  /**
   * A verify command that records its pid and the moment it began, then holds
   * until `go` appears or twenty seconds pass. Set as the install's command.
   */
  function heldCheck(name: string) {
    const signals = path.join(root, `signals-${name}`);
    fs.mkdirSync(signals);
    const probe = path.join(root, `held-check-${name}.js`);
    fs.writeFileSync(
      probe,
      `const fs = require("node:fs");
const path = require("node:path");
const dir = process.argv[2];
fs.writeFileSync(path.join(dir, "pid"), String(process.pid));
fs.writeFileSync(path.join(dir, "started"), "");
const deadline = Date.now() + 20000;
while (!fs.existsSync(path.join(dir, "go"))) {
  if (Date.now() > deadline) process.exit(3);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
`,
    );
    settings.saveSettings({ landVerifyCommand: `${process.execPath} ${probe} ${signals}` });
    return {
      started: () => fs.existsSync(path.join(signals, "started")),
      pid: () => Number(fs.readFileSync(path.join(signals, "pid"), "utf8")),
      release: () => fs.writeFileSync(path.join(signals, "go"), ""),
    };
  }

  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };

  it("ends the check and frees the checkout's claim at the Stop, not when the check would have ended", async () => {
    const s = scene("stop-ends-check");
    const check = heldCheck("stop-ends-check");
    try {
      workflows.advanceInstances();
      await until(check.started, "the branch's check never started");
      const pid = check.pid();
      assert.equal(land.checkoutHolder(s.repo).landing, true, "the check was not running under the claim");

      const halted = workflows.stopInstance(s.instanceId, { kind: "operator" });
      assert.equal(halted.ok, true, halted.ok ? "" : halted.reason);

      // `go` is never written before these: the check holds for twenty seconds,
      // so a claim let go inside five was let go because the check was ended.
      await until(
        () => !land.checkoutHolder(s.repo).landing,
        "the checkout's claim was still held five seconds after the Stop",
        5_000,
      );
      assert.equal(isAlive(pid), false, "the check was still running after the claim was let go");
      assert.equal(remoteTip(s), null, "the branch was pushed after the workflow was stopped");
      assert.deepEqual(opened, [], "a pull request was opened after the workflow was stopped");
    } finally {
      check.release();
    }
  });

  it("returns a refusal that names the Stop when the signal fires inside the check", async () => {
    const s = branchScene("signal-names-stop");
    const check = heldCheck("signal-names-stop");
    const controller = new AbortController();
    let delivery: Awaited<ReturnType<typeof land.deliverRun>> | undefined;
    const pressed = land
      .deliverRun(s.runId, {}, () => true, controller.signal)
      .then((answer) => {
        delivery = answer;
      });
    try {
      await until(check.started, "the branch's check never started");
      controller.abort("Stopped by the operator at noon");
      await until(
        () => delivery !== undefined,
        "deliverRun was still waiting on the check five seconds after the signal",
        5_000,
      );
      assert.deepEqual(delivery, {
        ok: false,
        reason:
          "Stopped by the operator at noon while its verify command was running, so the command " +
          "was ended, nothing was pushed and no pull request was opened.",
      });
      assert.equal(land.checkoutHolder(s.repo).landing, false);
      assert.equal(remoteTip(s), null);
      assert.deepEqual(opened, []);
    } finally {
      check.release();
      await pressed;
    }
  });

  it("still refuses the push when the caller withdraws during a check that then passes", async () => {
    // What the first case in this describe pinned before the check was ended:
    // the check is not interrupted here, so only `stillWanted`'s read after it
    // stands between a passing check and the push.
    const s = branchScene("withdrawn-in-check");
    const check = heldCheck("withdrawn-in-check");
    const pressed = land.deliverRun(s.runId, {}, () => !check.started());
    try {
      await until(check.started, "the branch's check never started");
    } finally {
      check.release();
    }
    const delivery = await pressed;
    assert.equal(delivery.ok, false);
    assert.match(delivery.ok ? "" : delivery.reason, /called off before its push began/);
    assert.equal(land.checkoutHolder(s.repo).landing, false);
    assert.equal(remoteTip(s), null);
    assert.deepEqual(opened, []);
  });
});

/**
 * A deliver block whose inputs are ready while the server is shutting down —
 * a build that finished inside the shutdown's grace.
 *
 * Measured on 02f3b764 by bug hunt 3/6 (board task 083064a8): the claim asked
 * nothing about the shutdown, so the block was claimed, `deliverRun` refused
 * its branch with "Try again once it has restarted", the block settled
 * `failed`, and `on-finish` — satisfied by a block that finished either way —
 * created "Then this" during the shutdown. After the restart the retry that
 * sentence asks for was refused with a 409, because a block behind it had
 * started, and nothing had ever been pushed.
 */
describe("a deliver block reached while the server is shutting down", () => {
  it("is left waiting, releases nothing behind it, and delivers once the flag is down", async () => {
    const a = branchScene("shut-a");
    const instanceId = instanceFor("shut", [{ id: "build", branch: a }], { afterOnFinish: true });
    const flag = (globalThis as unknown as { __ufShutdown: { active: boolean } }).__ufShutdown;
    const members = () => workflows.getInstance(instanceId)!.nodes.map((n) => n.nodeId);
    const successor = () => workflows.blocksOf(instanceId).find((x) => x.nodeId === "after")!;

    flag.active = true; // what `shutdownRuns` sets first
    try {
      workflows.advanceInstances();
      // A claimed block reads `thinking` until `deliverRun` answers, so this
      // waits out the refusal when the claim was made and is instant when not.
      const deadline = Date.now() + 20_000;
      while (shipBlock(instanceId).status === "thinking") {
        if (Date.now() > deadline) assert.fail("the deliver block never left thinking");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(
        shipBlock(instanceId).status,
        "waiting",
        `the block was claimed during the shutdown: ${shipBlock(instanceId).error ?? ""}`,
      );
      assert.equal(
        successor().status,
        "waiting",
        `the on-finish successor was decided behind a delivery nobody tried: ${successor().error ?? ""}`,
      );
      assert.deepEqual(members(), ["build"]);
      assert.equal(remoteTip(a), null);
      assert.deepEqual(opened, []);
    } finally {
      flag.active = false;
    }

    // What decides a `waiting` block across the restart is
    // `reconcileBlocksOnBoot`'s rule, not this one. Here the advance that would
    // follow a hold's lift or a surviving member's ending: the block was left
    // intact, so it delivers, and only then is the successor decided — refused
    // by name here, since this harness has no mount for a run node to start in.
    const block = await settleBlock({ instanceId });
    assert.equal(block.status, "emitted", block.error ?? "");
    assert.equal(remoteTip(a), git(a.slot, "rev-parse", "HEAD").trim());
    assert.deepEqual(opened, [{ head: a.branch, base: "main" }]);
    assert.notEqual(successor().status, "waiting");
  });
});
