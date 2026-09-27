import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * A local model's branch does not land or deliver until a frontier review of
 * its tip approves it — driven through `landState` and `deliveryState` against
 * a real repository, because the rule is only as good as its wiring.
 *
 * `localCertification.test.ts` pins the decision. What it cannot see is whether
 * the decision is ever asked: `landState` reading the wrong review, the wrong
 * tip, or skipping the check on the path Deliver takes would leave every unit
 * test green and the button working. So this file builds the branch, writes
 * the run and review rows the way the app does, and asks the two doors.
 *
 * Its own file with `DATA_DIR` named before the first import, for
 * `loopMergeOwnership.test.ts`'s reason.
 */

let land: typeof import("./land");
let dbMod: typeof import("./db");
let root: string;

const MOUNT_DIR = "local-gate-mount";
const BRANCH = "uf/repo-local-1a2b3c4d";

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

/** Commit one file on the run's branch and come back to `main`. */
function commitOnBranch(name: string): string {
  git(repoRoot(), "switch", "-q", BRANCH);
  fs.writeFileSync(path.join(repoRoot(), name), `${name}\n`);
  git(repoRoot(), "add", "-A");
  git(repoRoot(), "commit", "-q", "-m", name);
  const tip = git(repoRoot(), "rev-parse", "HEAD");
  git(repoRoot(), "switch", "-q", "main");
  return tip;
}

function insertRun(id: string, provider: string | null, base: string): void {
  dbMod
    .db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
         created_at, isolation, worktree_branch, worktree_base, worktree_base_branch,
         repo_root, provider)
       VALUES (?, ?, 'task', 'completed', '{}', 1, 1, ?, 'worktree', ?, ?, 'main', ?, ?)`,
    )
    .run(id, repoRoot(), Date.now(), BRANCH, base, repoRoot(), provider);
}

function insertReview(runId: string, verdict: string | null, headSha: string): void {
  dbMod
    .db()
    .prepare(
      `INSERT INTO run_reviews (id, run_id, kind, created_at, finished_at, status, model,
         text, verdict, head_sha)
       VALUES (?, ?, 'review', ?, ?, 'completed', NULL, 'review text', ?, ?)`,
    )
    .run(`rev-${Math.random()}`, runId, Date.now(), Date.now(), verdict, headSha);
}

let mainTip: string;

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-local-gate-")));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, MOUNT_DIR);
  process.env.WORKSPACE_ROOTS = "";
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  fs.mkdirSync(repoRoot(), { recursive: true });
  git(repoRoot(), "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repoRoot(), "a.txt"), "one\n");
  git(repoRoot(), "add", "-A");
  git(repoRoot(), "commit", "-q", "-m", "first");
  mainTip = git(repoRoot(), "rev-parse", "HEAD");
  git(repoRoot(), "branch", BRANCH);

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );
  dbMod = await import("./db");
  land = await import("./land");
});

after(() => {
  const open = (globalThis as { __ufDb?: { close(): void } }).__ufDb;
  open?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  dbMod.db().prepare("DELETE FROM run_reviews").run();
  dbMod.db().prepare("DELETE FROM runs").run();
});

describe("a local model's branch waits for a frontier approval of its tip", () => {
  it("is refused with no review, on Land and on Deliver", async () => {
    commitOnBranch("unreviewed.txt");
    insertRun("local-run-1", "local", mainTip);

    const state = await land.landState("local-run-1");
    assert.equal(state?.certification.required, true);
    assert.match(state?.blocked ?? "", /local model wrote \(run local-ru\)/);

    const delivery = await land.deliveryState("local-run-1", state);
    assert.equal(delivery.possible, false);
    assert.match(delivery.reason ?? "", /cannot be delivered/);
  });

  it("lands once a review approved the tip, and not once the tip moves", async () => {
    const tip = commitOnBranch("approved.txt");
    insertRun("local-run-2", "local", mainTip);
    insertReview("local-run-2", "approve", tip);

    assert.equal((await land.landState("local-run-2"))?.blocked, null);

    commitOnBranch("after-review.txt");
    assert.match(
      (await land.landState("local-run-2"))?.blocked ?? "",
      /branch is at .* now\. Review it again/,
    );
  });

  it("is refused after a rejection", async () => {
    const tip = commitOnBranch("rejected.txt");
    insertRun("local-run-3", "local", mainTip);
    insertReview("local-run-3", "reject", tip);
    assert.match((await land.landState("local-run-3"))?.blocked ?? "", /rejected/);
  });

  it("holds a Claude run that carries on a branch a local run wrote on", async () => {
    commitOnBranch("carried.txt");
    insertRun("local-run-4", "local", mainTip);
    insertRun("claude-run-4", "claude", mainTip);
    const state = await land.landState("claude-run-4");
    assert.equal(state?.certification.required, true);
    assert.notEqual(state?.blocked, null);
  });

  it("asks nothing of a branch only Claude worked on", async () => {
    commitOnBranch("claude-only.txt");
    insertRun("claude-run-5", "claude", mainTip);
    const state = await land.landState("claude-run-5");
    assert.equal(state?.certification.required, false);
    assert.equal(state?.blocked, null);
  });
});
