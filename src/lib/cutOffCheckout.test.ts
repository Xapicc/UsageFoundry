import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, it } from "node:test";

/**
 * A run picked up into a checkout that `git worktree add` never finished.
 *
 * The add names the branch in the new checkout's HEAD before its `reset --hard`
 * writes the files and the index, and cleans up only from a signal handler, so a
 * SIGKILL in between — a container stopped past its grace, an OOM kill — leaves
 * a registered checkout on the run's branch with none of its files in it. The
 * restart fails the run, Pick up re-queues it, and `ensureWorktree` adopted that
 * tree "exactly as it stands": the agent was spawned where `git status` reports
 * every tracked file deleted, under a grant to `git add` and `git commit`, and
 * told it was resuming. Nothing about that fails — the cycle ends `completed`
 * and the deletion of the repository is one ordinary commit away from a branch
 * the merge queue can land.
 *
 * The state is constructed rather than raced, the way the sandbox allows: the
 * checkout removed and re-added with `--no-checkout`, and git's own lock written
 * back with the reason it carries while an add is in flight.
 *
 * `stackWait.test.ts`'s harness, for its reasons: `config.ts` fixes `DATA_DIR`
 * at load, `spawn` is replaced for the life of the process, and
 * `reconcileOnBoot` acts on every row there is. The stub is the agent, and it
 * reports what it was handed — the directory, how much of the checkout is on
 * disk, and what `git status` says there.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-cut-off-checkout-")));
fs.mkdirSync(path.join(tmp, "claude", "projects"), { recursive: true });

process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
// Pinned rather than left to fall back to CLAUDE_HOME: the pre-cycle guard
// reaches `planUsage()`, which sends a request when it finds an OAuth token.
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");
process.env.WORKSPACE_ROOT = path.join(tmp, "workspace");
delete process.env.WORKSPACE_ROOTS;
// A path that does not exist, so a spawn the stub below fails to catch is a
// failed test rather than a billed one.
process.env.CLAUDE_BIN = path.join(tmp, "no-such-claude");

const config = require("./config") as typeof import("./config");
assert.equal(
  config.DATA_DIR,
  process.env.DATA_DIR,
  "config was already loaded by another test file in this process — refusing to " +
    "run against the real database",
);

const { createRun, getRun, reconcileOnBoot, reopenRun } =
  require("./orchestrator") as typeof import("./orchestrator");
const { db } = require("./db") as typeof import("./db");
const { saveSettings } = require("./settings") as typeof import("./settings");

const TRACKED_FILES = 50;

/** What one work cycle was handed. */
interface Seen {
  cwd: string;
  /** How many of the fixture's committed files are on disk there. */
  trackedOnDisk: number;
  statusLines: number;
}

let seen: Seen[] = [];
/** Run inside the next spawn, in its working directory, before it replies. */
let during: ((cwd: string) => void) | null = null;

const childProcess = require("node:child_process") as Record<string, unknown>;
const realSpawn = childProcess.spawn as (...args: unknown[]) => unknown;

childProcess.spawn = (command: unknown, ...rest: unknown[]) => {
  if (command !== config.CLAUDE_BIN) return realSpawn(command, ...rest);
  const cwd = (rest[1] as { cwd: string }).cwd;
  seen.push({
    cwd,
    trackedOnDisk: fs.readdirSync(cwd).filter((name) => name.startsWith("file-")).length,
    statusLines: statusLines(cwd),
  });
  during?.(cwd);
  during = null;

  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    // No pid, so `signalTree` never reaches `process.kill(-pid)`.
    pid: undefined as number | undefined,
    kill: () => true,
  });
  // After `runIteration` has attached its listeners, which it does once
  // `spawn` has returned.
  setImmediate(() => {
    stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "sess-cut-off" })}\n`);
    stdout.write(
      `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "DONE", total_cost_usd: 0, session_id: "sess-cut-off" })}\n`,
    );
    stdout.end();
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  });
  return child;
};

after(() => {
  childProcess.spawn = realSpawn;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** git for the fixture, with an identity of its own so a commit cannot refuse. */
function fixtureGit(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

function statusLines(cwd: string): number {
  return fixtureGit(cwd, ["status", "--porcelain"]).split("\n").filter(Boolean).length;
}

/** A repository with `TRACKED_FILES` committed files, at the top so they count. */
function makeRepo(folder: string): string {
  const repo = path.join(tmp, "workspace", folder);
  fs.mkdirSync(repo, { recursive: true });
  fixtureGit(repo, ["init", "-q", "-b", "main"]);
  for (let i = 0; i < TRACKED_FILES; i++) {
    fs.writeFileSync(path.join(repo, `file-${i}.txt`), `${i}\n`);
  }
  fixtureGit(repo, ["add", "-A"]);
  fixtureGit(repo, ["commit", "-q", "-m", "seed"]);
  return repo;
}

/**
 * What a SIGKILL between `worktree add`'s `symbolic-ref HEAD` and its `reset
 * --hard` leaves: registered, HEAD on the branch, no index and no files, and
 * the lock git writes first and unlinks last still in place.
 */
function halfAdd(repo: string, slot: string, branch: string, create: boolean): void {
  if (fs.existsSync(slot)) fixtureGit(repo, ["worktree", "remove", "--force", slot]);
  fixtureGit(repo, [
    "worktree",
    "add",
    "-q",
    "--no-checkout",
    ...(create ? ["-b", branch, slot, "main"] : [slot, branch]),
  ]);
  const gitDir = fixtureGit(slot, ["rev-parse", "--absolute-git-dir"]);
  fs.writeFileSync(path.join(gitDir, "locked"), "initializing\n");
}

function lockOf(slot: string): string | null {
  const file = path.join(fixtureGit(slot, ["rev-parse", "--absolute-git-dir"]), "locked");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}

function start(folder: string): string {
  seen = [];
  return createRun({
    folder,
    mountId: null,
    prompt: "do it",
    budget: { maxIterations: 1 },
    origin: "form",
  }).id;
}

/** Wait for the segment in flight to end, however it ends. */
async function settled(id: string): Promise<NonNullable<ReturnType<typeof getRun>>> {
  for (let i = 0; i < 1_000; i++) {
    const row = getRun(id)!;
    if (row.status !== "queued" && row.status !== "running") return row;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`run ${id} never left running`);
}

/**
 * The run as a restart leaves one caught inside its first `ensureWorktree`:
 * planned, `running`, never a cycle, and then closed out by the next boot.
 */
async function cutOffDuringSetup(folder: string, slotState: (repo: string, slot: string, branch: string) => void) {
  const repo = makeRepo(folder);
  saveSettings({ maxConcurrentRuns: 0 });
  const id = start(folder);
  const planned = getRun(id)!;
  assert.equal(planned.isolation, "worktree", "the fixture repository should be isolated");
  const slot = planned.worktree_path!;
  const branch = planned.worktree_branch!;
  slotState(repo, slot, branch);
  db()
    .prepare("UPDATE runs SET status='running', started_at=? WHERE id=?")
    .run(Date.now(), id);
  await reconcileOnBoot();
  const closed = getRun(id)!;
  assert.equal(closed.status, "failed");
  assert.equal(closed.restart_closed, 1);
  assert.equal(closed.iterations, 0);
  saveSettings({ maxConcurrentRuns: 4 });
  return { id, repo, slot, branch };
}

describe("a pick-up into a checkout git never finished", () => {
  it("refuses, naming the slot, when the run has worked in it since", async () => {
    const repo = makeRepo("worked");
    const id = start("worked");
    const first = await settled(id);
    assert.equal(first.status, "completed", first.stop_reason ?? "");
    assert.equal(first.isolation, "worktree");
    const slot = first.worktree_path!;
    const branch = first.worktree_branch!;
    assert.deepEqual(seen[0], { cwd: slot, trackedOnDisk: TRACKED_FILES, statusLines: 0 });

    halfAdd(repo, slot, branch, false);
    assert.equal(statusLines(slot), TRACKED_FILES, "the fixture should report every file deleted");

    const reopened = reopenRun(id, { maxIterations: 3 });
    assert.ok(reopened.ok, reopened.ok ? "" : reopened.reason);
    const second = await settled(id);

    // The Done criterion, either way round: refused, or handed a whole tree.
    assert.ok(
      !seen[1] || seen[1].statusLines === 0,
      `the agent was spawned in a checkout reporting ${seen[1]?.statusLines} changed paths`,
    );
    // And which way round: anything uncommitted in there may be this run's, so
    // nothing here may overwrite it.
    assert.equal(seen.length, 1, "a second work cycle was spawned");
    assert.equal(second.status, "failed");
    assert.match(second.stop_reason ?? "", new RegExp(path.basename(slot)));
    assert.match(second.stop_reason ?? "", /initializing/);
    assert.equal(statusLines(slot), TRACKED_FILES, "the refusal changed the checkout");
    assert.equal(lockOf(slot), "initializing\n");
  });

  it("finishes the checkout when the run never got past setting it up", async () => {
    const { id, slot, branch } = await cutOffDuringSetup("never-worked", (repo, slot, branch) =>
      halfAdd(repo, slot, branch, true),
    );

    const reopened = reopenRun(id, { maxIterations: 1 });
    assert.ok(reopened.ok, reopened.ok ? "" : reopened.reason);
    const row = await settled(id);

    assert.equal(row.status, "completed", row.stop_reason ?? "");
    assert.deepEqual(seen, [{ cwd: slot, trackedOnDisk: TRACKED_FILES, statusLines: 0 }]);
    assert.equal(lockOf(slot), null, "git's lock was left on a finished checkout");
    assert.equal(fixtureGit(slot, ["rev-parse", "--abbrev-ref", "HEAD"]), branch);
  });

  it("refuses, naming the slot, a never-worked checkout with tracked changes and no lock", async () => {
    const { id, slot } = await cutOffDuringSetup("unlocked", (repo, slot, branch) => {
      halfAdd(repo, slot, branch, true);
      fs.rmSync(path.join(fixtureGit(slot, ["rev-parse", "--absolute-git-dir"]), "locked"));
    });

    const reopened = reopenRun(id, { maxIterations: 1 });
    assert.ok(reopened.ok, reopened.ok ? "" : reopened.reason);
    const row = await settled(id);

    assert.equal(seen.length, 0, "the agent was spawned in a checkout reporting every file deleted");
    assert.equal(row.status, "failed");
    assert.match(row.stop_reason ?? "", new RegExp(path.basename(slot)));
    assert.equal(statusLines(slot), TRACKED_FILES, "the refusal changed the checkout");
  });

  it("refuses a hand-over rather than call what is missing the predecessor's work", async () => {
    const repo = makeRepo("handover");
    const predecessor = start("handover");
    const done = await settled(predecessor);
    assert.equal(done.status, "completed", done.stop_reason ?? "");
    const slot = done.worktree_path!;
    halfAdd(repo, slot, done.worktree_branch!, false);

    seen = [];
    const next = createRun({
      folder: "handover",
      mountId: null,
      prompt: "carry on",
      budget: { maxIterations: 1 },
      origin: "form",
      dependsOn: [{ runId: predecessor, edge: "on-success", continueBranch: true }],
    });
    const row = await settled(next.id);

    assert.equal(row.continues_run, predecessor);
    assert.equal(row.worktree_path, slot, "the hand-over should have taken the predecessor's checkout");
    assert.equal(seen.length, 0, "the agent was spawned in a checkout reporting every file deleted");
    assert.equal(row.status, "failed");
    assert.match(row.stop_reason ?? "", new RegExp(path.basename(slot)));
    assert.match(row.stop_reason ?? "", new RegExp(predecessor.slice(0, 8)));
    assert.equal(statusLines(slot), TRACKED_FILES, "the refusal changed the checkout");
  });

  it("still adopts its own checkout, work in progress and all, when git finished it", async () => {
    makeRepo("resumes");
    const id = start("resumes");
    during = (cwd) => {
      fs.writeFileSync(path.join(cwd, "file-0.txt"), "edited\n");
      fs.writeFileSync(path.join(cwd, "new.txt"), "new\n");
    };
    const first = await settled(id);
    assert.equal(first.status, "completed", first.stop_reason ?? "");
    const slot = first.worktree_path!;
    assert.equal(statusLines(slot), 2);

    const reopened = reopenRun(id, { maxIterations: 3 });
    assert.ok(reopened.ok, reopened.ok ? "" : reopened.reason);
    await settled(id);

    assert.equal(seen.length, 2);
    assert.deepEqual(seen[1], { cwd: slot, trackedOnDisk: TRACKED_FILES, statusLines: 2 });
    assert.equal(fs.readFileSync(path.join(slot, "file-0.txt"), "utf8"), "edited\n");
  });
});
