import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

/**
 * Covers a run's own checkout left part-way through a rebase or a bisect of its
 * branch, and only that.
 *
 * An agent that runs `git rebase main` in its slot and stops on a conflict ends
 * the run there, and both operations detach HEAD — so `worktree list` lists the
 * slot as `detached` and every door that asked it "who holds this branch" heard
 * "nobody". Purge skipped the `worktree remove --force` it exists to make and
 * was then refused by `git branch -D` as "checked out at" that very slot, on
 * every press; Commit called a checkout standing right there "gone"; Resolve
 * fell through to a second `worktree add` of the branch, which git refused as
 * already checked out. `deleteBranch` alone knew the state, and refuses in it.
 * None of that fails loudly: each door answers with a sentence, and the slot
 * stays out of circulation with no way out offered anywhere.
 *
 * Not a pure function, and it cannot be one: the state is whatever git writes
 * into a checkout's own git directory when it stops, and whether `worktree
 * remove --force` ends the operation and `branch -D` then lets go is git's
 * answer, which a fixture stating it would be assuming.
 *
 * Its own file for `slotProbes.test.ts`'s reason: it needs a real git repository
 * inside a real mount, and `DATA_DIR` and `CLAUDE_HOME` set before anything is
 * required, which `land.test.ts` — pure functions, static imports — cannot give.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-mid-operation-")));
const ws = path.join(tmp, "ws");
fs.mkdirSync(ws, { recursive: true });
fs.mkdirSync(path.join(tmp, "claude", "projects"), { recursive: true });

process.env.WORKSPACE_ROOTS = `Main=${ws}`;
process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
// `planUsage` looks for an OAuth token here, and a unit test must not send a
// request on the operator's own credential.
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");
// Belt to the `maxConcurrentRuns: 0` below: a path that cannot be executed
// rather than a real, billed CLI, should promotion ever reach a spawn.
process.env.CLAUDE_BIN = path.join(tmp, "no-such-claude");

// `require`, not `import`: imports are hoisted above the environment above, and
// these modules read `WORKSPACE_ROOTS` and `DATA_DIR` once at load.
const config = require("./config") as typeof import("./config");
assert.equal(
  config.DATA_DIR,
  process.env.DATA_DIR,
  "config was already loaded by another test file in this process — refusing to run against the real database",
);

const { getRun, repoSlug, worktreeStore } = require("./orchestrator") as typeof import("./orchestrator");
const { saveSettings } = require("./settings") as typeof import("./settings");
const land = require("./land") as typeof import("./land");
const { db } = require("./db") as typeof import("./db");

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Nothing may be promoted: a started run would do its own git, asynchronously,
// in the middle of the fixture.
saveSettings({ maxConcurrentRuns: 0 });

beforeEach(() => {
  db().prepare("DELETE FROM runs").run();
});

const IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

/** git for the fixture, with an identity of its own so a commit cannot refuse. */
function fixtureGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...IDENTITY },
  }).trim();
}

function branchExists(repo: string, branch: string): boolean {
  return spawnSync("git", ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { cwd: repo })
    .status === 0;
}

const headOf = (dir: string) => fixtureGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);

interface Scene {
  runId: string;
  repo: string;
  slot: string;
  branch: string;
}

/**
 * A finished isolated run with one commit on its branch, checked out in a slot
 * where `allocateSlotPath` would look for one, and a commit on `main` since
 * that changes the same line — so rebasing the branch onto `main` stops.
 */
function scene(name: string): Scene {
  const repo = path.join(ws, name);
  fs.mkdirSync(repo);
  fixtureGit(repo, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "shared.txt"), "base\n");
  fixtureGit(repo, ["add", "-A"]);
  fixtureGit(repo, ["commit", "-q", "-m", "base"]);
  const base = fixtureGit(repo, ["rev-parse", "main"]);

  const branch = `uf/${name}`;
  const slot = path.join(worktreeStore(repo)!, `${repoSlug(repo)}-1`);
  fixtureGit(repo, ["worktree", "add", "-q", "-b", branch, slot]);
  fs.writeFileSync(path.join(slot, "shared.txt"), "the run's line\n");
  fixtureGit(slot, ["commit", "-qam", "the run's work"]);

  fs.writeFileSync(path.join(repo, "shared.txt"), "the target's line\n");
  fixtureGit(repo, ["commit", "-qam", "the target's work"]);

  const runId = `run-${name}`;
  db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                         created_at, finished_at, isolation, repo_root, worktree_path,
                         worktree_branch, worktree_base, worktree_base_branch)
       VALUES (?, ?, 'do the thing', 'completed', '{}', 1, 1, ?, ?, 'worktree', ?, ?, ?, ?, 'main')`,
    )
    .run(runId, repo, Date.now(), Date.now(), repo, slot, branch, base);

  return { runId, repo, slot, branch };
}

/** What the agent did: `git rebase main` in its checkout, stopped on the conflict. */
function rebaseStops(checkout: string): void {
  const rebase = spawnSync("git", ["rebase", "main"], {
    cwd: checkout,
    encoding: "utf8",
    env: { ...process.env, ...IDENTITY },
  });
  assert.notEqual(rebase.status, 0, "the rebase did not stop on the conflict");
  assert.equal(headOf(checkout), "HEAD", "the rebase did not stop detached");
}

describe("a run's checkout stopped part-way through a rebase of its branch", () => {
  it("is purged, the checkout with the branch", async () => {
    const s = scene("purged");
    rebaseStops(s.slot);

    const outcome = await land.purgeBranch(s.runId, s.branch);

    assert.equal(outcome.ok, true, outcome.ok ? "" : `the purge was refused: ${outcome.reason}`);
    assert.equal(branchExists(s.repo, s.branch), false, "the branch survived the purge");
    assert.equal(fs.existsSync(s.slot), false, "the rebasing checkout survived the purge");
    assert.ok(
      !fixtureGit(s.repo, ["worktree", "list", "--porcelain"]).includes(s.slot),
      "the checkout is still registered",
    );
  });

  it("is named by Commit, rather than called gone", async () => {
    const s = scene("committed");
    const tip = fixtureGit(s.repo, ["rev-parse", s.branch]);
    rebaseStops(s.slot);

    const outcome = await land.commitPending(s.runId);

    assert.equal(outcome.ok, false, "a commit was made in a checkout mid-rebase");
    const reason = outcome.ok ? "" : outcome.reason;
    assert.doesNotMatch(reason, /gone/, `a checkout standing there was called gone: ${reason}`);
    assert.match(reason, /rebase of uf\/committed/);
    assert.match(reason, /git rebase --abort/);
    assert.equal(fixtureGit(s.repo, ["rev-parse", s.branch]), tip);
    assert.equal(headOf(s.slot), "HEAD", "the rebase was disturbed");
  });

  it("is named by Resolve, rather than handed to a second checkout", async () => {
    const s = scene("resolved");
    rebaseStops(s.slot);

    await assert.rejects(
      land.resolveCheckout(s.repo, getRun(s.runId)!, s.branch),
      /rebase of uf\/resolved.*git rebase --abort/s,
    );
    assert.deepEqual(
      fs.readdirSync(worktreeStore(s.repo)!).filter((entry) => entry.includes("resolve-")),
      [],
      "a checkout to resolve in was cut beside the rebasing one",
    );
  });

  it("is purged part-way through a bisect too, and Commit names the bisect", async () => {
    // `BISECT_START` spells the branch without `refs/heads/`, and bisect
    // detaches at its first midpoint.
    const s = scene("bisected");
    for (const n of [1, 2, 3]) {
      fs.writeFileSync(path.join(s.slot, "shared.txt"), `step ${n}\n`);
      fixtureGit(s.slot, ["commit", "-qam", `step ${n}`]);
    }
    fixtureGit(s.slot, ["bisect", "start", s.branch, `${s.branch}~4`]);
    assert.equal(headOf(s.slot), "HEAD", "the bisect did not detach");

    const commit = await land.commitPending(s.runId);
    assert.equal(commit.ok, false);
    assert.match(commit.ok ? "" : commit.reason, /bisect of uf\/bisected.*git bisect reset/s);

    const purge = await land.purgeBranch(s.runId, s.branch);
    assert.equal(purge.ok, true, purge.ok ? "" : `the purge was refused: ${purge.reason}`);
    assert.equal(branchExists(s.repo, s.branch), false);
    assert.equal(fs.existsSync(s.slot), false);
  });

  it("leaves a checkout that is not the run's own to git's refusal", async () => {
    // The control: what Purge force-removes is the run's own slot, never
    // somebody else's rebase of the same branch.
    const s = scene("elsewhere");
    fixtureGit(s.repo, ["worktree", "remove", s.slot]);
    const mine = path.join(ws, "operators-own");
    fixtureGit(s.repo, ["worktree", "add", "-q", mine, s.branch]);
    rebaseStops(mine);

    const outcome = await land.purgeBranch(s.runId, s.branch);

    assert.equal(outcome.ok, false, "a branch somebody else is rebasing was purged");
    assert.equal(branchExists(s.repo, s.branch), true);
    assert.equal(fs.existsSync(mine), true, "somebody else's checkout was removed");
    assert.equal(headOf(mine), "HEAD", "somebody else's rebase was ended");
  });
});
