import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * That a finished run's diff does not list a later run's in-progress edits as
 * its own leftovers once its checkout slot has been reused.
 *
 * Slots are reused lowest-first, so the directory run A worked in is usually the
 * next run's `checkout -b` a few minutes after A ends. `uncommittedIn` read
 * `git status` in whatever the slot held, and everything B had touched since
 * was then A's "Uncommitted in the checkout", the warning that landing A would
 * not bring those files over, a line in the billed reviewer's prompt, and the
 * difference between "named, and not changed" and "named, and left uncommitted"
 * on A's Files tab. `landState` already refused to read the slot under another
 * branch, so the two cards on one page disagreed.
 *
 * Driven for real, a database and a repository, because the fault was in what
 * git says about a directory that has changed hands; a fixture stating that
 * would be stating the very thing in question. Its own file with `DATA_DIR`
 * named before the first import, for `deleteBranch.test.ts`' reason: `config.ts`
 * is read at module load.
 */

let diffMod: typeof import("./diff");
let landMod: typeof import("./land");
let touches: typeof import("./runTouches");
let dbMod: typeof import("./db");
let orchestrator: typeof import("./orchestrator");
let root: string;

const MOUNT_DIR = "diff-slot-reuse-mount";

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
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-diff-slot-reuse-")));
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
  diffMod = await import("./diff");
  landMod = await import("./land");
  touches = await import("./runTouches");
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
  base: string;
}

/**
 * A finished isolated run with one commit on `uf/<name>`, checked out in the
 * slot `allocateSlotPath` would hand out first. The repository holds
 * `notes.md` as well as `shared.txt`, so a later run has a tracked file to edit
 * that the finished run never changed.
 */
function scene(name: string): Scene {
  const repo = path.join(root, MOUNT_DIR, name);
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "shared.txt"), "base\n");
  fs.writeFileSync(path.join(repo, "notes.md"), "notes\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
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

  return { runId, repo, slot, branch, base };
}

/**
 * What `ensureWorktree`'s registered-slot branch does for the next run, minus
 * the run: a clean slot is switched to a fresh branch from the same base, and
 * the new run starts editing in it.
 */
function handSlotToNextRun(s: Scene): void {
  git(s.slot, "checkout", "-q", "-b", "uf/next", s.base);
  fs.writeFileSync(path.join(s.slot, "notes.md"), "the next run's edit\n");
  fs.writeFileSync(path.join(s.slot, "b-new.txt"), "new\n");
}

describe("an isolated run's uncommitted files", () => {
  it("are listed while the slot still holds the run's branch", async () => {
    const s = scene("own-slot");
    fs.writeFileSync(path.join(s.slot, "notes.md"), "left behind\n");

    const diff = await diffMod.runDiff(s.runId);

    assert.equal(diff.kind, "range");
    assert.deepEqual(diff.uncommitted, [" M notes.md"]);
  });

  it("are not a later run's, once the slot holds another branch", async () => {
    const s = scene("reused-slot");
    handSlotToNextRun(s);

    const diff = await diffMod.runDiff(s.runId);

    // Before the fix: [" M notes.md", "?? b-new.txt"], the next run's edits.
    assert.equal(diff.kind, "range");
    assert.deepEqual(diff.files.map((f) => f.path), ["shared.txt"]);
    assert.deepEqual(diff.uncommitted, []);
  });

  it("are not a later run's when the run committed nothing either", async () => {
    // `rangeDiff` reads them on two paths: with a range and with none.
    const s = scene("reused-slot-empty-range");
    git(s.slot, "checkout", "-q", "--detach");
    git(s.repo, "branch", "-f", s.branch, s.base);
    handSlotToNextRun(s);

    const diff = await diffMod.runDiff(s.runId);

    assert.equal(diff.kind, "range");
    assert.deepEqual(diff.files, []);
    assert.deepEqual(diff.uncommitted, []);
  });

  it("do not move the Files tab's reconciliation, and the land card agrees", async () => {
    const s = scene("reconcile");
    handSlotToNextRun(s);

    const diff = await diffMod.runDiff(s.runId);
    const changed = touches.changedSetOf(diff);
    assert.ok(changed.known, "the branch's own diff is still known");
    const report = touches.reconcileTouches(
      [{ path: "notes.md", outside: false, tool: "Read", subagent: null, parentToolUseId: null, calls: 1 }],
      changed.changed,
      changed.uncommitted,
      changed.renamedAway,
    );

    // Before the fix: filed under `touchedUncommitted`, "named, and left uncommitted".
    assert.deepEqual(report.touchedUncommitted, []);
    assert.deepEqual(report.touchedNotChanged.map((f) => f.path), ["notes.md"]);
    // The two surfaces on one run page said different things about the slot.
    assert.equal((await landMod.landState(s.runId))?.pending, null);
  });
});
