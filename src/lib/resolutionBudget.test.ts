import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * What a conflict resolution's child is handed as a spending ceiling.
 *
 * A resolution has no clock — the landing path's rule, because a clock was
 * ending large merges — and nothing reaches its child once it is spawned but
 * a deadline on its silence, which a child that is working and spending never
 * meets (`resolutionSilence.test.ts`). The
 * merge queue starts one per conflicting branch of a batch queued with
 * auto-resolve, a workflow's merge block included, with nobody present, and the
 * install ceiling is read once at the door. So `--max-budget-usd` is the only
 * bound one has, and it was never passed: a resolution admitted at $99.99 of a
 * $100 day spent until it chose to exit.
 *
 * Driven end to end rather than through a helper, because the defect was an
 * argument missing at one call site and a pure function beside it would have
 * been right all along: a real repository with a real conflict, `resolveConflicts`
 * asked exactly as the Resolve button asks it, and a stand-in `claude` that
 * writes down the argv it was spawned with.
 *
 * Its own file, with `DATA_DIR` named before the first import, for
 * `loopMergeOwnership.test.ts`'s reason.
 */

let land: typeof import("./land");
let review: typeof import("./review");
let settings: typeof import("./settings");
let dbMod: typeof import("./db");
let root: string;

const MOUNT_DIR = "resolution-budget-mount";
const repoRoot = () => path.join(root, MOUNT_DIR, "repo");
const argvFile = () => path.join(root, "claude-argv.json");

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
 * A `claude` that records how it was called and resolves nothing.
 *
 * It reports success without touching a file, so the resolution's own `after`
 * finds the markers still there and rolls the merge back — which is the path
 * that leaves the repository as it found it for the next case.
 */
function writeStub(dir: string): string {
  const stub = path.join(dir, "claude-stub.js");
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(argvFile())}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "left it", total_cost_usd: 0 }) + "\\n");
`,
    { mode: 0o755 },
  );
  return stub;
}

before(async () => {
  // `realpathSync`, which `resolveInMount` checks containment against.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-resolve-budget-")));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  // `planUsage` looks for an OAuth token here, and a unit test must not send a
  // request on the operator's own credential.
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, MOUNT_DIR);
  process.env.WORKSPACE_ROOTS = "";
  process.env.CLAUDE_BIN = writeStub(root);
  fs.mkdirSync(path.join(root, "claude", "projects"), { recursive: true });

  // `main` and the run's branch both change the one line, so they conflict.
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
  settings = await import("./settings");
  review = await import("./review");
  land = await import("./land");
});

after(() => {
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

/** Resolve as the button does, wait for the child to settle, and return its argv. */
async function resolveAndReadArgv(runId: string): Promise<string[]> {
  fs.rmSync(argvFile(), { force: true });
  const started = await land.resolveConflicts(runId, null);
  assert.equal(started.ok, true, started.ok ? "" : started.reason);
  const assistId = started.ok ? started.assistId : undefined;
  assert.ok(assistId, "no child was spawned, so there is no argv to read");

  const deadline = Date.now() + 30_000;
  while (review.getAssist(assistId)?.status === "running") {
    assert.ok(Date.now() < deadline, "the resolution never settled");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return JSON.parse(fs.readFileSync(argvFile(), "utf8")) as string[];
}

describe("a conflict resolution's spending ceiling", () => {
  it("hands the child resolutionBudgetUSD as --max-budget-usd", async () => {
    settings.saveSettings({ resolutionBudgetUSD: 7 });
    const argv = await resolveAndReadArgv(conflictingRun("uf/ceiling"));

    const at = argv.indexOf("--max-budget-usd");
    assert.notEqual(at, -1, "a resolution was spawned with no ceiling at all");
    assert.equal(argv[at + 1], "7");
  });

  it("passes no ceiling when the operator has removed it", async () => {
    settings.saveSettings({ resolutionBudgetUSD: null });
    const argv = await resolveAndReadArgv(conflictingRun("uf/uncapped"));
    assert.equal(argv.includes("--max-budget-usd"), false);
  });
});
