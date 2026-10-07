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
let review: typeof import("./review");
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
  review = await import("./review");
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

describe("resolving a conflict past a squash", () => {
  // The resolution merges the target into the branch, the other direction from
  // a land, and a plain `git merge` there took git's merge-base — the chain's
  // base — so it conflicted in the squashed lines the card never listed. A
  // resolver keeping the branch's side of those made the target an ancestor of
  // a branch that undid the target's edit, and Land fast-forwarded it.
  //
  // `startAssist` is stood in for, which is the stop before the spawn: it is
  // handed the checkout with the merge open, as the child would have been.

  type AssistRequest = Parameters<typeof review.startAssist>[0];

  /**
   * Link A squash-landed, then `main` edits the lines A brought in (`f1.txt`)
   * and the line link B changes (`f2.txt`). B's card, previewed past the
   * squash, lists `f2.txt` alone and offers Resolve.
   */
  async function conflictingPastSquash(name: string) {
    const c = await squashedLinkA(name);
    fs.writeFileSync(path.join(c.repo, "f1.txt"), "main's later f1\n");
    fs.writeFileSync(path.join(c.repo, "f2.txt"), "main's later f2\n");
    git(c.repo, "commit", "-qam", "main edits f1 and f2");
    const b = linkB(name, c);

    const state = await land.landState(b);
    assert.equal(state?.preview.outcome, "conflict");
    assert.deepEqual(
      state?.preview.outcome === "conflict" ? state.preview.files.map((f) => f.path) : [],
      ["f2.txt"],
    );
    return { c, b, tip: git(c.repo, "rev-parse", c.branch).trim() };
  }

  const unmergedIn = (cwd: string) =>
    git(cwd, "diff", "--name-only", "--diff-filter=U").trim().split("\n").filter(Boolean);

  it("opens the merge with only the conflicts the card listed, and rolls it back", async (t) => {
    const { c, b, tip } = await conflictingPastSquash("resolve-opened");

    let opened = null as { cwd: string; unmerged: string[]; paths: string[]; f1: string } | null;
    let settled: Promise<unknown> = Promise.resolve();
    t.mock.method(review, "startAssist", (req: AssistRequest) => {
      opened = {
        cwd: req.cwd,
        unmerged: unmergedIn(req.cwd),
        paths: req.paths ?? [],
        f1: read(path.join(req.cwd, "f1.txt")),
      };
      // What a child that never started comes to.
      settled = req.after!({ status: "failed", error: "stood in for" });
      return { ok: true as const, id: "stand-in" };
    });

    const started = await land.resolveConflicts(b);
    await settled;

    assert.equal(started.ok, true, started.ok ? "" : started.reason);
    assert.ok(opened, "no resolution was handed a checkout");
    assert.equal(opened.cwd, c.slot);
    // Before the fix: ["f1.txt", "f2.txt"].
    assert.deepEqual(opened.unmerged, ["f2.txt"], "the merge conflicted where the card said it would not");
    assert.deepEqual(opened.paths, ["f2.txt"], "the resolution was told to settle other files");
    assert.equal(opened.f1, "main's later f1\n", "main's edit to the squashed lines was not merged in");

    // Rolled back like any merge: the branch where it was, nothing open.
    assert.equal(git(c.repo, "rev-parse", c.branch).trim(), tip);
    assert.throws(() => git(c.slot, "rev-parse", "-q", "--verify", "MERGE_HEAD"));
    assert.equal(git(c.slot, "status", "--porcelain").trim(), "");
  });

  it("does not undo the target's edit to the squashed lines when the branch's side is kept", async (t) => {
    const { c, b } = await conflictingPastSquash("resolve-kept");

    let settled: Promise<unknown> = Promise.resolve();
    t.mock.method(review, "startAssist", (req: AssistRequest) => {
      // A resolver that keeps the branch's side of every file it is handed.
      for (const file of req.paths ?? []) {
        fs.writeFileSync(path.join(req.cwd, file), git(req.cwd, "show", `:2:${file}`));
      }
      settled = req.after!({ status: "completed", text: "kept the branch's side" });
      return { ok: true as const, id: "stand-in" };
    });

    const started = await land.resolveConflicts(b);
    const result = await settled;
    assert.equal(started.ok, true, started.ok ? "" : started.reason);
    assert.equal((result as { status?: string } | undefined)?.status, "completed");
    assert.equal(git(c.repo, "merge-base", "--is-ancestor", "main", c.branch), "");

    const landed = await land.landRun(b, "squash");
    assert.equal(landed.ok, true, landed.ok ? "" : landed.reason);
    // Before the fix: "link A's f1", under a success message.
    assert.equal(read(path.join(c.repo, "f1.txt")), "main's later f1\n", "main's edit was undone");
    assert.equal(read(path.join(c.repo, "f2.txt")), "link B's f2\n");
  });
});

describe("landing past a squash while another process holds the target's ref lock", () => {
  // Nothing before the commit moves a ref, so the commit is what meets the
  // lock; the undo — `merge --abort` for a merge, `reset --merge` for a squash
  // — restores the tree and exits 1 on the same lock.
  for (const strategy of ["merge", "squash"] as const) {
    it(`says a ${strategy} refused at its commit was rolled back`, async () => {
      const name = `ref-lock-${strategy}`;
      const c = await squashedLinkA(name);
      const b = linkB(name, c);
      const before = git(c.repo, "rev-parse", "main").trim();
      const lock = path.join(c.repo, ".git", "refs", "heads", "main.lock");
      fs.writeFileSync(lock, "");

      const landed = await land.landRun(b, strategy);

      assert.equal(landed.ok, false, "landed through a held ref lock");
      assert.match(landed.ok ? "" : landed.reason, /^The \w+ could not be committed and was rolled back: /);
      assert.equal(git(c.repo, "rev-parse", "main").trim(), before);
      assert.equal(git(c.repo, "status", "--porcelain"), "", "the land was left staged");
      assert.equal(fs.existsSync(path.join(c.repo, ".git", "MERGE_HEAD")), false);
      assert.equal(read(path.join(c.repo, "f2.txt")), "original f2\n");
      fs.rmSync(lock);
    });
  }
});
