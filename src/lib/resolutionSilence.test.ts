import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";

/**
 * What a conflict resolution's silence deadline ends, and what it leaves alone.
 *
 * A resolution has no clock on its duration, the landing path's rule, and the
 * only thing in this process that ends its child is `RESOLVE_SILENCE_MS`: an
 * hour with nothing printed on either stream. Both ways of getting that wrong
 * are quiet. A deadline that is not re-armed by output ends large merges that
 * were working, which is the exact defect the no-clock rule was written
 * against; a stopped resolution that does not reach `after` leaves its merge
 * half-done in a checkout nothing will clean up. So this drives the real path
 * end to end: a real repository with a real conflict, `resolveConflicts` asked
 * as the Resolve button asks it, and a stand-in `claude` that says nothing
 * until the test tells it to.
 *
 * The hour is faked rather than waited, and it is the one place in the suite
 * that uses `mock.timers`, because the deadline is a constant on purpose (its
 * margin over the measured gaps is the whole argument for it) and a test-only
 * way to shorten it would be a second deadline to keep honest. Only
 * `setTimeout` and `Date` are faked, and only between the spawn and the tick:
 * the child, git and the settle all run in real time, which is what makes the
 * rollback assertions mean something. Node prints an `ExperimentalWarning` for
 * the API once per file; that line is expected.
 *
 * It also carries the one case that needs the same path for another reason:
 * that the row's account of a rollback is checked rather than assumed. That
 * sentence followed a `merge --abort` whose result nobody read, so a resolution
 * whose open merge something else had committed reported an unchanged branch
 * that had in fact moved, and no fixture short of a real child and a real
 * checkout can put a commit in the gap.
 *
 * Its own file, with `DATA_DIR` named before the first import, for
 * `loopMergeOwnership.test.ts`'s reason.
 */

const HOUR = 60 * 60_000;

let land: typeof import("./land");
let review: typeof import("./review");
let dbMod: typeof import("./db");
let root: string;

const MOUNT_DIR = "resolution-silence-mount";
const repoRoot = () => path.join(root, MOUNT_DIR, "repo");
const control = (name: "started" | "print" | "exit") => path.join(root, `stub-${name}`);

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

/**
 * A `claude` that prints nothing until a control file appears.
 *
 * `print` makes it report one tool call, which is output the deadline has to
 * notice; `exit` makes it report success and leave. It resolves nothing
 * either way, so a resolution that ends on its own is rolled back for the
 * markers it left, and says so, which is how the second case tells that
 * outcome apart from being stopped. The thirty-second exit is a backstop for a
 * failing run, far past anything a passing one waits for.
 */
function writeStub(dir: string): string {
  const stub = path.join(dir, "claude-stub.js");
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env node
const fs = require("node:fs");
const started = ${JSON.stringify(control("started"))};
const print = ${JSON.stringify(control("print"))};
const exit = ${JSON.stringify(control("exit"))};
fs.writeFileSync(started, String(process.pid));
let printed = false;
setInterval(() => {
  if (!printed && fs.existsSync(print)) {
    printed = true;
    process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "a.txt" } }] } }) + "\\n");
  }
  if (fs.existsSync(exit)) {
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "left it", total_cost_usd: 0 }) + "\\n");
    process.exit(0);
  }
}, 20);
setTimeout(() => process.exit(9), 30000);
`,
    { mode: 0o755 },
  );
  return stub;
}

before(async () => {
  // `realpathSync`, which `resolveInMount` checks containment against.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-resolve-silence-")));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  // `planUsage` looks for an OAuth token here, and a unit test must not send a
  // request on the operator's own credential.
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, MOUNT_DIR);
  process.env.WORKSPACE_ROOTS = "";
  process.env.CLAUDE_BIN = writeStub(root);
  fs.mkdirSync(path.join(root, "claude", "projects"), { recursive: true });

  fs.mkdirSync(repoRoot(), { recursive: true });
  git(repoRoot(), "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repoRoot(), "a.txt"), "one\n");
  git(repoRoot(), "add", "-A");
  git(repoRoot(), "commit", "-q", "-m", "first");

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );
  assert.equal(config.CLAUDE_BIN, process.env.CLAUDE_BIN);

  dbMod = await import("./db");
  review = await import("./review");
  land = await import("./land");
});

after(() => {
  mock.timers.reset();
  const open = (globalThis as { __ufDb?: { close(): void } }).__ufDb;
  open?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A finished run on its own branch, which conflicts with `main`. */
function conflictingRun(branch: string): string {
  const base = git(repoRoot(), "rev-parse", "main").trim();
  git(repoRoot(), "checkout", "-q", "-b", branch, "main");
  fs.writeFileSync(path.join(repoRoot(), "a.txt"), `${branch}\n`);
  git(repoRoot(), "commit", "-q", "-am", `work on ${branch}`);
  git(repoRoot(), "checkout", "-q", "main");
  fs.writeFileSync(path.join(repoRoot(), "a.txt"), `main moved past ${branch}\n`);
  git(repoRoot(), "commit", "-q", "-am", `main moves under ${branch}`);

  const runId = `run-${Math.random().toString(36).slice(2, 10)}`;
  dbMod
    .db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                         created_at, finished_at, isolation, repo_root, worktree_branch,
                         worktree_base, worktree_base_branch)
       VALUES (?, ?, 'change a', 'completed', '{}', 1, 1, ?, ?, 'worktree', ?, ?, ?, 'main')`,
    )
    .run(runId, repoRoot(), Date.now(), Date.now(), repoRoot(), branch, base);
  return runId;
}

/** Everything a resolution must leave exactly as it found it. */
function snapshot(branch: string) {
  return {
    branchTip: git(repoRoot(), "rev-parse", branch).trim(),
    operatorHead: git(repoRoot(), "rev-parse", "HEAD").trim(),
    operatorBranch: git(repoRoot(), "symbolic-ref", "--short", "HEAD").trim(),
    operatorStatus: git(repoRoot(), "status", "--porcelain"),
    operatorFile: fs.readFileSync(path.join(repoRoot(), "a.txt"), "utf8"),
    worktrees: git(repoRoot(), "worktree", "list", "--porcelain"),
  };
}

/**
 * Wait for something the child does, while `setTimeout` may be faked.
 *
 * `setImmediate` is not faked and lets I/O through on every turn, and
 * `performance.now()` is not either, so the bound is real time.
 */
async function until(what: string, ready: () => boolean): Promise<void> {
  const deadline = performance.now() + 15_000;
  while (!ready()) {
    assert.ok(performance.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function startResolution(runId: string): Promise<string> {
  for (const name of ["started", "print", "exit"] as const) {
    fs.rmSync(control(name), { force: true });
  }
  const started = await land.resolveConflicts(runId, null);
  assert.equal(started.ok, true, started.ok ? "" : started.reason);
  const assistId = started.ok ? started.assistId : undefined;
  assert.ok(assistId, "no child was spawned, so there is nothing to go silent");
  await until("the stand-in claude to start", () => fs.existsSync(control("started")));
  return assistId;
}

/** Real time again by now, so a plain poll. */
async function settled(assistId: string) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const row = review.getAssist(assistId);
    assert.ok(row, "the resolution's row disappeared");
    if (row.status !== "running") return row;
    assert.ok(Date.now() < deadline, "the resolution never settled");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const toolCalls = (runId: string): number =>
  (
    dbMod
      .db()
      .prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND kind = 'tool'")
      .get(runId) as { n: number }
  ).n;

describe("a conflict resolution that stops printing", () => {
  it(
    "is stopped after an hour of silence and its merge is rolled back",
    { timeout: 30_000 },
    async () => {
      const branch = "uf/silent";
      const runId = conflictingRun(branch);
      const before = snapshot(branch);

      mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
      const assistId = await startResolution(runId);
      mock.timers.tick(HOUR);
      mock.timers.reset();

      const row = await settled(assistId);
      assert.equal(row.status, "failed");
      assert.match(row.error ?? "", /printed nothing for 60 minutes/);
      assert.deepEqual(
        snapshot(branch),
        before,
        "the branch or the operator's checkout is not as the resolution found it",
      );
      assert.equal(fs.existsSync(path.join(repoRoot(), ".git", "MERGE_HEAD")), false);
    },
  );

  it(
    "leaves one alone that printed within the hour, however long it has run",
    { timeout: 30_000 },
    async () => {
      const branch = "uf/chatty";
      const runId = conflictingRun(branch);
      const before = snapshot(branch);

      mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
      const assistId = await startResolution(runId);
      mock.timers.tick(HOUR / 2);
      fs.writeFileSync(control("print"), "");
      // The line has reached this process, at half an hour in.
      await until("the tool call to be logged", () => toolCalls(runId) > 0);
      // An hour since the spawn, half an hour since the last output.
      mock.timers.tick(HOUR / 2);
      fs.writeFileSync(control("exit"), "");
      mock.timers.reset();

      // Ended by the child, so its row carries the resolution's own verdict on
      // the markers it left rather than the deadline's sentence.
      const row = await settled(assistId);
      assert.equal(row.status, "failed");
      assert.match(row.error ?? "", /Conflict markers are still in a\.txt/);
      assert.deepEqual(snapshot(branch), before);
    },
  );
});

/** The checkout git has given `branch` to, which a resolution made for itself. */
function checkoutHolding(branch: string): string {
  let current = "";
  for (const line of git(repoRoot(), "worktree", "list", "--porcelain").split("\n")) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
    if (line === `branch refs/heads/${branch}`) return current;
  }
  assert.fail(`no checkout holds ${branch}`);
}

describe("a resolution whose open merge was committed underneath it", () => {
  it("does not report a rollback it did not make", { timeout: 30_000 }, async () => {
    const branch = "uf/committed-under";
    const runId = conflictingRun(branch);
    const tipBefore = git(repoRoot(), "rev-parse", branch).trim();
    const assistId = await startResolution(runId);

    // What Commit on the Land card did while the agent worked: `add -A` and a
    // commit in the resolution's checkout, which turns the open merge into a
    // two-parent commit with the markers in it.
    const checkout = checkoutHolding(branch);
    git(checkout, "add", "-A");
    git(checkout, "commit", "-q", "--no-edit");
    fs.writeFileSync(control("exit"), "");

    const row = await settled(assistId);
    assert.notEqual(
      git(repoRoot(), "rev-parse", branch).trim(),
      tipBefore,
      "the fixture's commit did not move the branch, so this proves nothing",
    );
    assert.equal(row.status, "failed");
    assert.match(row.error ?? "", /Conflict markers are still in a\.txt/);
    assert.doesNotMatch(row.error ?? "", /is unchanged/);
    assert.match(row.error ?? "", /Nothing was rolled back/);
  });
});
