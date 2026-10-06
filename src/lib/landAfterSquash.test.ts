import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * That landing a branch again after a squash takes only what was committed
 * since that squash.
 *
 * A squash leaves no ancestry, so git's merge-base between the target and a
 * squash-landed branch stays where the chain started. Every later count,
 * preview and land of that branch was measured from there, so the squashed
 * work was applied a second time: a change the operator reverted on the target
 * after the squash came back with a clean preview and a success message, a
 * later edit on the target to the lines the squash brought in became a
 * conflict in a file the new commits never touched, and the count included the
 * commits already landed.
 *
 * Driven for real, a database and repositories, for `deleteBranch.test.ts`'
 * reason: the fault was in what git does from the base it was handed, so a
 * fixture stating git's answer would be stating the very thing in question.
 * Its own file with `DATA_DIR` named before the first import, because
 * `config.ts` is read at module load.
 */

let land: typeof import("./land");
let dbMod: typeof import("./db");
let orchestrator: typeof import("./orchestrator");
let root: string;

const MOUNT_DIR = "land-after-squash-mount";

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
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-land-after-squash-")));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, MOUNT_DIR);
  process.env.WORKSPACE_ROOTS = "";
  // A resolution started by mistake fails here rather than bills.
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

interface Chain {
  repo: string;
  slot: string;
  branch: string;
  base: string;
}

const read = (file: string) => fs.readFileSync(file, "utf8");

/**
 * Link A of a chain, finished, with one commit editing `f1.txt` and squashed
 * into `main` through the real `landRun`. `main` holds `f1.txt` and `f2.txt`;
 * the operator's checkout is on it and clean.
 */
async function squashedLinkA(name: string): Promise<Chain> {
  const repo = path.join(root, MOUNT_DIR, name);
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "f1.txt"), "original f1\n");
  fs.writeFileSync(path.join(repo, "f2.txt"), "original f2\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "main").trim();

  const branch = `uf/${name}`;
  const slot = path.join(
    orchestrator.worktreeStore(repo)!,
    `${orchestrator.repoSlug(repo)}-1`,
  );
  git(repo, "worktree", "add", "-q", "-b", branch, slot);
  fs.writeFileSync(path.join(slot, "f1.txt"), "link A's f1\n");
  git(slot, "commit", "-qam", "link A edits f1");
  insertRun(`${name}-A`, { repo, slot, branch, base }, null);

  const landed = await land.landRun(`${name}-A`, "squash");
  assert.equal(landed.ok, true, landed.ok ? "" : landed.reason);
  assert.equal(read(path.join(repo, "f1.txt")), "link A's f1\n");
  return { repo, slot, branch, base };
}

function insertRun(id: string, c: Chain, continues: string | null): void {
  dbMod
    .db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                         created_at, finished_at, isolation, repo_root, worktree_path,
                         worktree_branch, worktree_base, worktree_base_branch, continues_run)
       VALUES (?, ?, 'do the thing', 'completed', '{}', 1, 1, ?, ?, 'worktree', ?, ?, ?, ?,
               'main', ?)`,
    )
    .run(id, c.repo, Date.now(), Date.now(), c.repo, c.slot, c.branch, c.base, continues);
}

/** Link B: carries A's branch on with one commit editing `f2.txt` only. */
function linkB(name: string, c: Chain): string {
  fs.writeFileSync(path.join(c.slot, "f2.txt"), "link B's f2\n");
  git(c.slot, "commit", "-qam", "link B edits f2");
  const id = `${name}-B`;
  insertRun(id, c, `${name}-A`);
  return id;
}

/** Paths the commit at `ref` changed against its first parent. */
const touched = (repo: string, ref: string) =>
  git(repo, "diff", "--name-only", `${ref}^1`, ref).trim().split("\n").filter(Boolean);

describe("landing a branch again after a squash", () => {
  it("leaves a change reverted on the target reverted, and squashes only the new link", async () => {
    const c = await squashedLinkA("reverted");
    git(c.repo, "revert", "--no-edit", "HEAD");
    assert.equal(read(path.join(c.repo, "f1.txt")), "original f1\n");
    const b = linkB("reverted", c);

    const state = await land.landState(b);
    assert.ok(state, "link B has no land state");
    assert.equal(state.blocked, null, `refused: ${state.blocked}`);
    assert.equal(state.ahead, 1, "link A's landed commit is counted as unlanded");
    assert.equal(state.preview.outcome, "clean");

    const landed = await land.landRun(b, "squash");
    assert.equal(landed.ok, true, landed.ok ? "" : landed.reason);

    // Before the fix: "link A's f1", with nothing on the card saying so.
    assert.equal(read(path.join(c.repo, "f1.txt")), "original f1\n", "the revert was undone");
    assert.equal(read(path.join(c.repo, "f2.txt")), "link B's f2\n");
    assert.deepEqual(touched(c.repo, "HEAD"), ["f2.txt"]);
    assert.equal(git(c.repo, "status", "--porcelain").trim(), "", "the checkout was left dirty");
  });

  it("lands the next link cleanly when the target has since edited the squashed lines", async () => {
    const c = await squashedLinkA("edited");
    fs.writeFileSync(path.join(c.repo, "f1.txt"), "main's later f1\n");
    git(c.repo, "commit", "-qam", "main edits f1");
    const b = linkB("edited", c);

    const state = await land.landState(b);
    assert.ok(state, "link B has no land state");
    // Before the fix: "Merging into main conflicts in 1 file(s)", over f1.txt.
    assert.equal(state.blocked, null, `refused: ${state.blocked}`);
    assert.equal(state.ahead, 1);

    const row = (await land.branchInventory()).branches.find((r) => r.branch === c.branch);
    assert.equal(row?.ahead, 1, "the branches page counts link A's landed commit");

    const landed = await land.landRun(b, "squash");
    assert.equal(landed.ok, true, landed.ok ? "" : landed.reason);
    assert.equal(read(path.join(c.repo, "f1.txt")), "main's later f1\n");
    assert.equal(read(path.join(c.repo, "f2.txt")), "link B's f2\n");
  });

  it("merges only the new link too, and leaves the branch an ancestor of the target", async () => {
    const c = await squashedLinkA("merged");
    git(c.repo, "revert", "--no-edit", "HEAD");
    const b = linkB("merged", c);
    const tip = git(c.repo, "rev-parse", c.branch).trim();

    const landed = await land.landRun(b, "merge");
    assert.equal(landed.ok, true, landed.ok ? "" : landed.reason);

    assert.equal(read(path.join(c.repo, "f1.txt")), "original f1\n", "the revert was undone");
    assert.equal(read(path.join(c.repo, "f2.txt")), "link B's f2\n");
    assert.deepEqual(touched(c.repo, "HEAD"), ["f2.txt"]);
    assert.equal(git(c.repo, "rev-parse", "HEAD^2").trim(), tip, "not a merge of the branch");
    assert.equal(git(c.repo, "status", "--porcelain").trim(), "", "the checkout was left dirty");
    assert.equal((await land.landState(b))?.merged, true);
  });

  it("refuses to land, and lands nothing, when the target has since conflicted with the new link", async () => {
    // The control that the base moved rather than the check going away: a
    // conflict in the file the new link did touch is still a conflict.
    const c = await squashedLinkA("conflicting");
    fs.writeFileSync(path.join(c.repo, "f2.txt"), "main's later f2\n");
    git(c.repo, "commit", "-qam", "main edits f2");
    const b = linkB("conflicting", c);
    const before = git(c.repo, "rev-parse", "main").trim();

    const state = await land.landState(b);
    assert.equal(state?.preview.outcome, "conflict");
    assert.deepEqual(
      state?.preview.outcome === "conflict" ? state.preview.files.map((f) => f.path) : [],
      ["f2.txt"],
    );
    const landed = await land.landRun(b, "squash");
    assert.equal(landed.ok, false);
    assert.equal(git(c.repo, "rev-parse", "main").trim(), before);
  });
});

describe("landing past a squash over a file the operator's checkout ignores", () => {
  // This path writes the checkout with `read-tree -u` rather than `git merge`,
  // and `read-tree` overwrites an ignored file with no flag to say otherwise.
  for (const strategy of ["merge", "squash"] as const) {
    it(`refuses a ${strategy}, naming it, and keeps its content`, async () => {
      const name = `ignored-${strategy}`;
      const c = await squashedLinkA(name);
      // Not `.env`, which the default seeding list names and so is refused as
      // a seeded file before this path is reached (`seededRefusal`).
      fs.writeFileSync(path.join(c.repo, ".gitignore"), "local.settings.json\n");
      git(c.repo, "add", ".gitignore");
      git(c.repo, "commit", "-qm", "ignore local.settings.json");
      fs.writeFileSync(path.join(c.repo, "local.settings.json"), "the operator's own key\n");
      const b = linkB(name, c);
      fs.writeFileSync(path.join(c.slot, "local.settings.json"), "placeholder\n");
      git(c.slot, "add", "-f", "local.settings.json");
      git(c.slot, "commit", "-qm", "link B tracks local.settings.json");
      const before = git(c.repo, "rev-parse", "main").trim();

      const landed = await land.landRun(b, strategy);

      assert.equal(landed.ok, false, "landed over the operator's local.settings.json");
      assert.match(landed.ok ? "" : landed.reason, /tracks local\.settings\.json/);
      assert.equal(read(path.join(c.repo, "local.settings.json")), "the operator's own key\n");
      assert.equal(git(c.repo, "rev-parse", "main").trim(), before);
      assert.equal(git(c.repo, "status", "--porcelain").trim(), "", "the checkout was left part-way");
    });
  }
});

describe("a squash-landed branch with nothing new on it", () => {
  it("is not offered a billed resolution when the target has since edited the squashed lines", async () => {
    const c = await squashedLinkA("settled");
    fs.writeFileSync(path.join(c.repo, "f1.txt"), "main's later f1\n");
    git(c.repo, "commit", "-qam", "main edits f1");
    const a = "settled-A";

    const state = await land.landState(a);
    assert.ok(state, "the run has no land state");
    assert.equal(state.landedUnchanged, true);
    assert.match(state.blocked ?? "", /Already squashed into main/);
    // Before the fix: a conflict in f1.txt, with Resolve offered beside it.
    assert.notEqual(state.preview.outcome, "conflict");

    const resolved = await land.resolveConflicts(a);
    assert.equal(resolved.ok, false, "a resolution was started on a branch with nothing to land");
    const rows = dbMod
      .db()
      .prepare("SELECT COUNT(*) AS n FROM run_reviews WHERE run_id = ?")
      .get(a) as { n: number };
    assert.equal(rows.n, 0);
  });
});
