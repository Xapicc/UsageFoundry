import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type Database from "better-sqlite3";

/**
 * That a land merges the commit its checks were asked of, and not whatever the
 * branch holds when the merge starts.
 *
 * `landRun` reads the branch's tip, asks the verify command's proof, the
 * seeded-file refusal and the squash base of that SHA, and then awaits several
 * more git children — the checkout's status among them — before it spawns the
 * merge. The merge used to take the branch by *name*, so a commit that reached
 * the branch in between (the card's Commit button, or a second tab while the
 * merge queue lands unattended) was merged unverified and past
 * `seededRefusal`, a forced `.env` included. Past a squash it was worse: the
 * tree is worked out from the checked tip but `merge -s ours` recorded the
 * newer one as MERGE_HEAD, so history said the late commit was merged while its
 * content was absent — the branch read merged and deletable, and the change
 * was lost under a success message.
 *
 * Driven for real, a database and repositories, behind a `GIT_BIN` stub that
 * does one of two things a real race would: holds the checkout's `git status`
 * until the case has pressed Commit, or commits into the run's slot at the
 * instant the first `git merge` is spawned, strictly after every check. The
 * stub changes when things happen and nothing about what git does. Its own
 * file because `GIT_BIN` is read when `config.ts` loads.
 */

let land: typeof import("./land");
let dbMod: typeof import("./db");
let settings: typeof import("./settings");
let orchestrator: typeof import("./orchestrator");
let root: string;
let holds: string;

const IDENTITY = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENTITY } });

before(async () => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "uf-land-moved-")),
  );
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  fs.mkdirSync(path.join(root, "claude", "projects"), { recursive: true });
  // A resolution started by mistake fails here rather than bills.
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");
  process.env.WORKSPACE_ROOTS = path.join(root, "ws");
  fs.mkdirSync(path.join(root, "ws"), { recursive: true });

  holds = path.join(root, "holds");
  fs.mkdirSync(holds);
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const gitStub = path.join(root, "git");
  fs.writeFileSync(
    gitStub,
    [
      "#!/bin/sh",
      // Hold the operator's checkout's status once the verify command has
      // passed — `landRecheck`'s read, the last await before the merge.
      `if [ -e '${holds}/verified' ] && [ ! -e '${holds}/status.started' ] && [ "$(pwd -P)" = "$(cat '${holds}/dir' 2>/dev/null)" ]; then`,
      '  for arg in "$@"; do',
      '    if [ "$arg" = status ]; then',
      `      : > '${holds}/status.started'; i=0`,
      `      while [ ! -e '${holds}/status.release' ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i + 1)); done`,
      "      break",
      "    fi",
      "  done",
      "fi",
      // Run `on-merge` once, in the instant the first merge that is not an
      // abort is spawned. `mv` claims it, so a second merge does not run it.
      `if [ -e '${holds}/on-merge' ]; then`,
      "  is_merge=0; is_abort=0",
      '  for arg in "$@"; do',
      '    [ "$arg" = merge ] && is_merge=1',
      '    [ "$arg" = --abort ] && is_abort=1',
      "  done",
      '  if [ $is_merge = 1 ] && [ $is_abort = 0 ]; then',
      `    mv '${holds}/on-merge' '${holds}/on-merge.ran' 2>/dev/null && sh '${holds}/on-merge.ran'`,
      "  fi",
      "fi",
      `exec '${realGit}' "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  process.env.GIT_BIN = gitStub;

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );
  land = await import("./land");
  dbMod = await import("./db");
  settings = await import("./settings");
  orchestrator = await import("./orchestrator");
  settings.saveSettings({ maxConcurrentRuns: 0 });
});

after(() => {
  (globalThis as { __ufDb?: Database.Database }).__ufDb?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  dbMod.db().prepare("DELETE FROM runs").run();
});

const read = (file: string) => fs.readFileSync(file, "utf8");

interface Chain {
  repo: string;
  slot: string;
  branch: string;
  base: string;
}

/** `repo` with one commit, its operator's checkout on `main`, clean. */
function newRepo(name: string, gitignore?: string): string {
  const repo = path.join(root, "ws", name);
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "f1.txt"), "original f1\n");
  fs.writeFileSync(path.join(repo, "f2.txt"), "original f2\n");
  if (gitignore) fs.writeFileSync(path.join(repo, ".gitignore"), gitignore);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  return repo;
}

/** The run's slot, cut from `main` on `uf/<name>`. */
function cutSlot(repo: string, name: string): Chain {
  const base = git(repo, "rev-parse", "main").trim();
  const branch = `uf/${name}`;
  const slot = path.join(orchestrator.worktreeStore(repo)!, `${orchestrator.repoSlug(repo)}-1`);
  git(repo, "worktree", "add", "-q", "-b", branch, slot);
  return { repo, slot, branch, base };
}

function insertRun(id: string, c: Chain, continues: string | null = null): void {
  dbMod
    .db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                         created_at, finished_at, isolation, repo_root, worktree_path,
                         worktree_branch, worktree_base, worktree_base_branch, continues_run)
       VALUES (?, ?, 'task', 'completed', '{}', 1, 1, ?, ?, 'worktree', ?, ?, ?, ?, 'main', ?)`,
    )
    .run(id, c.repo, Date.now(), Date.now(), c.repo, c.slot, c.branch, c.base, continues);
}

/**
 * What the stub runs when the first merge is spawned: a commit into the slot
 * of a file the checks never saw and a forced `.env`, which the default
 * seeding list names. Written as a shell script because the stub is one.
 */
function armLateCommit(c: Chain): void {
  const identity = Object.entries(IDENTITY)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  fs.writeFileSync(
    path.join(holds, "on-merge"),
    [
      `cd '${c.slot}' || exit 1`,
      "unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE",
      "printf 'SECRET=hunter2\\n' > .env",
      "printf 'late change\\n' > f3.txt",
      "git add -f .env f3.txt",
      `env ${identity} git commit -qm 'committed during the land'`,
      "",
    ].join("\n"),
  );
}

/** Whether `ancestor` is reachable from `main`. */
function inMainHistory(repo: string, ancestor: string): boolean {
  try {
    git(repo, "merge-base", "--is-ancestor", ancestor, "main");
    return true;
  } catch {
    return false;
  }
}

const tracked = (repo: string) =>
  git(repo, "ls-tree", "-r", "--name-only", "main").trim().split("\n");

const landedTipOf = (id: string) =>
  (dbMod.db().prepare("SELECT landed_tip FROM runs WHERE id=?").get(id) as { landed_tip: string })
    .landed_tip;

describe("a Commit pressed on the card while Land is between its last checks and its merge", () => {
  it("is not merged unverified, and a seeded .env in it does not reach main", async () => {
    const repo = newRepo("pressed");
    const c = cutSlot(repo, "pressed");
    fs.writeFileSync(path.join(c.slot, "verified.txt"), "checked by the verify command\n");
    git(c.slot, "add", "-A");
    git(c.slot, "commit", "-qm", "verified work");
    const verifiedTip = git(repo, "rev-parse", c.branch).trim();
    insertRun("run-pressed", c);

    fs.writeFileSync(path.join(holds, "dir"), repo);
    const verifyScript = path.join(root, "verify.js");
    fs.writeFileSync(
      verifyScript,
      `require("fs").writeFileSync(${JSON.stringify(path.join(holds, "verified"))}, "");\n`,
    );
    settings.saveSettings({ landVerifyCommand: `${process.execPath} ${verifyScript}` });
    try {
      const pressed = land.landRun("run-pressed", "merge", null);
      for (let i = 0; i < 1000 && !fs.existsSync(path.join(holds, "status.started")); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.ok(
        fs.existsSync(path.join(holds, "status.started")),
        "the checkout's status after the verify command was never reached, so the window was not exercised",
      );
      fs.writeFileSync(path.join(c.slot, "unverified.txt"), "never checked\n");
      fs.writeFileSync(path.join(c.slot, ".env"), "API_KEY=sk-not-for-git\n");
      const committed = await land.commitPending("run-pressed");
      assert.equal(committed.ok, true, committed.ok ? "" : committed.reason);
      const lateTip = git(repo, "rev-parse", c.branch).trim();
      assert.notEqual(lateTip, verifiedTip, "the commit did not move the branch");
      fs.writeFileSync(path.join(holds, "status.release"), "");

      const landed = await pressed;

      assert.equal(landed.ok, true, landed.ok ? "" : landed.reason);
      assert.deepEqual(tracked(repo), ["f1.txt", "f2.txt", "verified.txt"]);
      assert.equal(git(repo, "rev-parse", "main").trim(), verifiedTip, "main took more than it was asked of");
      assert.equal(landedTipOf("run-pressed"), verifiedTip, "landed_tip is not what main received");
      assert.equal(inMainHistory(repo, lateTip), false);
      // Not lost: still on the branch, and counted as unlanded by the card.
      assert.equal(git(repo, "rev-parse", c.branch).trim(), lateTip);
      assert.equal((await land.landState("run-pressed"))?.merged, false);
    } finally {
      settings.saveSettings({ landVerifyCommand: "" });
    }
  });
});

describe("a commit that reaches the branch as the merge is spawned", () => {
  for (const strategy of ["merge", "squash"] as const) {
    it(`is not taken by a ${strategy}`, async () => {
      const name = `plain-${strategy}`;
      const repo = newRepo(name, ".env\n");
      const c = cutSlot(repo, name);
      fs.writeFileSync(path.join(c.slot, "f1.txt"), "checked f1\n");
      git(c.slot, "commit", "-qam", "checked work");
      const checkedTip = git(repo, "rev-parse", c.branch).trim();
      insertRun(`run-${name}`, c);
      // Main has moved, so the merge is a real one rather than a fast-forward.
      fs.writeFileSync(path.join(repo, "f2.txt"), "main's f2\n");
      git(repo, "commit", "-qam", "main moves on");
      armLateCommit(c);

      const landed = await land.landRun(`run-${name}`, strategy);

      assert.equal(landed.ok, true, landed.ok ? "" : landed.reason);
      assert.ok(fs.existsSync(path.join(holds, "on-merge.ran")), "the late commit was never made");
      fs.rmSync(path.join(holds, "on-merge.ran"));
      const lateTip = git(repo, "rev-parse", c.branch).trim();
      assert.notEqual(lateTip, checkedTip, "the commit did not move the branch");

      assert.deepEqual(tracked(repo), [".gitignore", "f1.txt", "f2.txt"]);
      assert.equal(read(path.join(repo, "f1.txt")), "checked f1\n");
      assert.equal(inMainHistory(repo, lateTip), false, "the unchecked commit is in main's history");
      assert.equal(git(repo, "log", "main", "--format=%h", "--", ".env").trim(), "");
      assert.equal(landedTipOf(`run-${name}`), checkedTip);
      if (strategy === "merge") {
        assert.equal(git(repo, "rev-parse", "main^2").trim(), checkedTip, "not a merge of what was checked");
        // `git merge <sha>` writes "Merge commit '<sha>'"; the branch is what the operator knows.
        assert.equal(git(repo, "log", "-1", "--format=%s", "main").trim(), `Merge branch '${c.branch}'`);
      }
      assert.equal(git(repo, "status", "--porcelain").trim(), "", "the checkout was left dirty");
    });
  }
});

describe("a commit that reaches the branch as a merge past a squash is spawned", () => {
  it("is not recorded as merged while its content is left out", async () => {
    const name = "past-squash";
    const repo = newRepo(name, ".env\n");
    const a = cutSlot(repo, name);
    fs.writeFileSync(path.join(a.slot, "f1.txt"), "link A's f1\n");
    git(a.slot, "commit", "-qam", "link A edits f1");
    insertRun(`${name}-A`, a);
    const squashed = await land.landRun(`${name}-A`, "squash");
    assert.equal(squashed.ok, true, squashed.ok ? "" : squashed.reason);

    // Link B carries A's branch on, so the merge is measured from the squash.
    fs.writeFileSync(path.join(a.slot, "f2.txt"), "link B's f2\n");
    git(a.slot, "commit", "-qam", "link B edits f2");
    const checkedTip = git(repo, "rev-parse", a.branch).trim();
    insertRun(`${name}-B`, a, `${name}-A`);
    // The operator's own, ignored by the repository and unlike anything the branch holds.
    fs.writeFileSync(path.join(repo, ".env"), "OPERATOR=1\n");
    armLateCommit(a);

    const landed = await land.landRun(`${name}-B`, "merge");

    assert.equal(landed.ok, true, landed.ok ? "" : landed.reason);
    assert.ok(fs.existsSync(path.join(holds, "on-merge.ran")), "the late commit was never made");
    fs.rmSync(path.join(holds, "on-merge.ran"));
    const lateTip = git(repo, "rev-parse", a.branch).trim();
    assert.notEqual(lateTip, checkedTip, "the commit did not move the branch");

    // History and tree agree: neither holds the late commit.
    assert.equal(inMainHistory(repo, lateTip), false, "main's history says the late commit is merged");
    assert.deepEqual(tracked(repo), [".gitignore", "f1.txt", "f2.txt"]);
    assert.equal(read(path.join(repo, "f2.txt")), "link B's f2\n");
    assert.equal(git(repo, "log", "main", "--format=%h", "--", ".env", "f3.txt").trim(), "");
    assert.equal(git(repo, "rev-parse", "main^2").trim(), checkedTip, "not a merge of what was checked");
    assert.equal(landedTipOf(`${name}-B`), checkedTip);
    assert.equal(read(path.join(repo, ".env")), "OPERATOR=1\n", "the operator's .env was overwritten");
    // Not reading merged: the late commit is still owed, so Delete must be refused.
    assert.equal((await land.landState(`${name}-B`))?.merged, false);
    assert.equal(git(repo, "status", "--porcelain").trim(), "", "the checkout was left dirty");
  });
});
