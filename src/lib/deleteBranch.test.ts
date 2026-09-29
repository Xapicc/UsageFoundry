import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * That Delete removes a branch its target contains, whatever the operator's
 * checkout is standing on.
 *
 * `deleteBranch` judged a branch merged by asking whether it is an ancestor of
 * its recorded target, and then deleted it with `git branch -d` — which asks a
 * different question: merged into the branch's upstream or, with none, into
 * HEAD of the repository's main working tree, which is the operator's own
 * checkout. So with that checkout on any branch that lacks the run's work,
 * every Delete the land card and the branches table offered was refused with
 * "not fully merged" about a branch the same card had just called merged —
 * after the run's slot had already been removed.
 *
 * Driven for real, a database and a repository, because the fault was in what
 * git answers to the question this app put to it; a fixture stating git's
 * answer would be stating the very thing in question. Its own file with
 * `DATA_DIR` named before the first import, for `loopMergeOwnership.test.ts`'
 * reason: `config.ts` is read at module load.
 */

let land: typeof import("./land");
let dbMod: typeof import("./db");
let orchestrator: typeof import("./orchestrator");
let root: string;

const MOUNT_DIR = "delete-branch-mount";

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

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-delete-branch-")));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, MOUNT_DIR);
  process.env.WORKSPACE_ROOTS = "";
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
  orchestrator = await import("./orchestrator");
});

after(() => {
  const open = (globalThis as { __ufDb?: { close(): void } }).__ufDb;
  open?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  dbMod.db().prepare("DELETE FROM runs").run();
});

interface Scene {
  runId: string;
  repo: string;
  slot: string;
  branch: string;
}

/**
 * A finished isolated run with one commit on its branch, checked out in a slot
 * where `allocateSlotPath` would look for one, and the operator's checkout on
 * `main`. `other` is a branch that does not contain the run's work, for the
 * operator to be standing on.
 */
function scene(name: string): Scene {
  const repo = path.join(root, MOUNT_DIR, name);
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "shared.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "branch", "other");
  const base = git(repo, "rev-parse", "main").trim();

  const branch = `uf/${name}`;
  const slot = path.join(
    orchestrator.worktreeStore(repo)!,
    `${orchestrator.repoSlug(repo)}-1`,
  );
  git(repo, "worktree", "add", "-q", "-b", branch, slot);
  fs.writeFileSync(path.join(slot, "shared.txt"), "branch\n");
  git(slot, "commit", "-qam", "the run's work");

  const runId = `run-${name}`;
  dbMod
    .db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                         created_at, finished_at, isolation, repo_root, worktree_path,
                         worktree_branch, worktree_base, worktree_base_branch)
       VALUES (?, ?, 'do the thing', 'completed', '{}', 1, 1, ?, ?, 'worktree', ?, ?, ?, ?, 'main')`,
    )
    .run(runId, repo, Date.now(), Date.now(), repo, slot, branch, base);

  return { runId, repo, slot, branch };
}

function branchExists(repo: string, branch: string): boolean {
  try {
    git(repo, "rev-parse", "--verify", "-q", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

const headOf = (dir: string) => git(dir, "rev-parse", "--abbrev-ref", "HEAD").trim();

describe("deleteBranch", () => {
  it("deletes a branch merged into its target while the operator's checkout is elsewhere", async () => {
    const s = scene("merged");
    git(s.repo, "merge", "-q", "--no-ff", "-m", "land", s.branch);
    git(s.repo, "switch", "-q", "other");

    const outcome = await land.deleteBranch(s.runId);

    // Before the fix: "git refused to delete the branch: error: The branch
    // 'uf/merged' is not fully merged.", with the slot already gone.
    assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
    assert.equal(branchExists(s.repo, s.branch), false);
    assert.equal(fs.existsSync(s.slot), false, "its checkout slot was not freed");
    assert.equal(headOf(s.repo), "other", "the operator's checkout was moved");
  });

  it("drops the tracking section a Deliver left, as `git branch -d` did", async () => {
    const s = scene("delivered");
    // What `push --set-upstream origin <branch>:<branch>` writes.
    git(s.repo, "config", `branch.${s.branch}.remote`, "origin");
    git(s.repo, "config", `branch.${s.branch}.merge`, `refs/heads/${s.branch}`);
    git(s.repo, "merge", "-q", "--no-ff", "-m", "land", s.branch);

    const outcome = await land.deleteBranch(s.runId);

    assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
    assert.equal(branchExists(s.repo, s.branch), false);
    assert.equal(git(s.repo, "config", "--local", "--list").includes(`branch.${s.branch}.`), false);
  });

  it("deletes a squash-landed branch whose tip has not moved", async () => {
    const s = scene("squashed");
    git(s.repo, "merge", "-q", "--squash", s.branch);
    git(s.repo, "commit", "-q", "-m", "land squashed");
    const tip = git(s.repo, "rev-parse", s.branch).trim();
    dbMod
      .db()
      .prepare(
        "UPDATE runs SET landed_at=?, landed_into='main', landed_strategy='squash', landed_tip=? WHERE id=?",
      )
      .run(Date.now(), tip, s.runId);
    git(s.repo, "switch", "-q", "other");

    const outcome = await land.deleteBranch(s.runId);

    assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.reason);
    assert.equal(branchExists(s.repo, s.branch), false);
    assert.equal(fs.existsSync(s.slot), false, "its checkout slot was not freed");
  });

  it("refuses a branch that gained a commit after it was merged, and changes nothing", async () => {
    const s = scene("moved");
    git(s.repo, "merge", "-q", "--no-ff", "-m", "land", s.branch);
    fs.writeFileSync(path.join(s.slot, "shared.txt"), "more\n");
    git(s.slot, "commit", "-qam", "after the land");
    const tip = git(s.repo, "rev-parse", s.branch).trim();
    git(s.repo, "switch", "-q", "other");

    const outcome = await land.deleteBranch(s.runId);

    assert.equal(outcome.ok, false);
    assert.equal(git(s.repo, "rev-parse", s.branch).trim(), tip);
    assert.equal(headOf(s.slot), s.branch, "its checkout slot was removed anyway");
  });

  it("refuses while the operator's own checkout stands on the branch", async () => {
    // The one holder that cannot be removed. Nothing below git's own refusal
    // may delete a ref a checkout is standing on: the checkout would be left on
    // a branch that no longer exists.
    const s = scene("held");
    git(s.repo, "merge", "-q", "--no-ff", "-m", "land", s.branch);
    git(s.repo, "worktree", "remove", s.slot);
    git(s.repo, "switch", "-q", s.branch);

    const outcome = await land.deleteBranch(s.runId);

    assert.equal(outcome.ok, false);
    assert.equal(branchExists(s.repo, s.branch), true);
    assert.equal(headOf(s.repo), s.branch);
  });

  it("refuses while a checkout is stopped mid-rebase on the branch", async () => {
    // The holder `worktree list` does not name: a rebase detaches HEAD and
    // writes the branch it will move back into `rebase-merge/head-name`, which
    // is where `git branch -d` found it. `update-ref -d` does not look, so
    // before the refusal the branch went and `rebase --continue` then failed on
    // its final ref write, leaving the checkout detached.
    const s = scene("rebasing");
    git(s.repo, "merge", "-q", "--no-ff", "-m", "land", s.branch);
    const tip = git(s.repo, "rev-parse", s.branch).trim();
    execFileSync("git", ["rebase", "-q", "-i", `${s.branch}~1`], {
      cwd: s.slot,
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
        GIT_SEQUENCE_EDITOR: "sed -i -e s/^pick/edit/",
      },
    });
    assert.equal(headOf(s.slot), "HEAD", "the rebase did not stop detached");

    const outcome = await land.deleteBranch(s.runId);

    assert.equal(outcome.ok, false, "a branch mid-rebase was deleted");
    const reason = outcome.ok ? "" : outcome.reason;
    assert.match(reason, /rebase/);
    assert.ok(reason.includes(s.slot), `the refusal does not say where: ${reason}`);
    assert.equal(git(s.repo, "rev-parse", s.branch).trim(), tip);
    assert.equal(fs.existsSync(s.slot), true, "the rebasing checkout was removed");
  });

  it("refuses while a checkout is bisecting from the branch", async () => {
    // The same gap by the other file: `BISECT_START` names the branch short,
    // without `refs/heads/`, and bisect detaches at the first midpoint.
    const s = scene("bisecting");
    for (const n of [1, 2, 3]) {
      fs.writeFileSync(path.join(s.slot, "shared.txt"), `step ${n}\n`);
      git(s.slot, "commit", "-qam", `step ${n}`);
    }
    git(s.repo, "merge", "-q", "--no-ff", "-m", "land", s.branch);
    const tip = git(s.repo, "rev-parse", s.branch).trim();
    git(s.slot, "bisect", "start", tip, `${s.branch}~4`);
    assert.equal(headOf(s.slot), "HEAD", "the bisect did not detach");

    const outcome = await land.deleteBranch(s.runId);

    assert.equal(outcome.ok, false, "a branch being bisected was deleted");
    const reason = outcome.ok ? "" : outcome.reason;
    assert.match(reason, /bisect/);
    assert.ok(reason.includes(s.slot), `the refusal does not say where: ${reason}`);
    assert.equal(git(s.repo, "rev-parse", s.branch).trim(), tip);
    assert.equal(fs.existsSync(s.slot), true, "the bisecting checkout was removed");
  });
});
