import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { RunRow } from "./orchestrator";

/**
 * Covers a symbolic link standing at a checkout slot's path, and only that.
 *
 * Nothing in this app makes one there, and anything that can write the store
 * can plant one: a chat turn, a run with isolation off on the mount root, an
 * unconfined cycle. Every failure it caused was silent until a run failed at
 * setup. `allocateSlotPath` asked `existsSync`, which follows the link, so a
 * dangling link read as a free slot and every isolated run on the repository
 * then failed on git's "already exists"; a link to an empty directory inside the
 * repository's own checkout read clean and not foreign, was handed out, and
 * `worktree add` followed it and wrote a full checkout, `.git` file and all, into
 * the operator's checkout, with `reset --hard` run there — all before the first
 * cycle's containment check failed the run (measured on this harness, board
 * task d90a042d). And `ensureWorktree` is reached long after admission for a
 * queued run, so a link planted between the two got the same checkout.
 *
 * Its own file for `slotProbes.test.ts`'s reasons: a real repository inside a
 * real mount, `spawn` and `spawnSync` wrapped module-wide to see where git was
 * run, and `DATA_DIR` set before anything is required. The wrappers record and
 * never replace, so the walk takes git's real answers.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-slot-leaf-")));
const ws = path.join(tmp, "ws");
const store = path.join(ws, ".uf-worktrees");
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(path.join(tmp, "claude", "projects"), { recursive: true });

process.env.WORKSPACE_ROOTS = `Main=${ws}`;
process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
// `planUsage` looks for an OAuth token here, and a unit test must not send a
// request on the operator's own credential.
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");
// A path that cannot be executed, so a run that got past setup is a failed
// test rather than a billed one.
process.env.CLAUDE_BIN = path.join(tmp, "no-such-claude");

// `require`, not `import`: imports are hoisted above the environment above, and
// these modules read `WORKSPACE_ROOTS` and `DATA_DIR` once at load.
const config = require("./config") as typeof import("./config");
assert.equal(
  config.DATA_DIR,
  process.env.DATA_DIR,
  "config was already loaded by another test file in this process — refusing to run against the real database",
);

const { createRun, getRun, promoteQueued, worktreeSlug } =
  require("./orchestrator") as typeof import("./orchestrator");
const { saveSettings } = require("./settings") as typeof import("./settings");
const { db } = require("./db") as typeof import("./db");

/** Every git child this process spawned, with the directory it was spawned in. */
const gitCalls: { cwd: string; args: string[] }[] = [];
const childProcess = require("node:child_process") as Record<string, unknown>;
const realSpawn = childProcess.spawn as (...args: unknown[]) => unknown;
const realSpawnSync = childProcess.spawnSync as (...args: unknown[]) => unknown;
function record(command: unknown, rest: unknown[]): void {
  if (command !== config.GIT_BIN) return;
  gitCalls.push({ cwd: (rest[1] as { cwd: string }).cwd, args: rest[0] as string[] });
}
childProcess.spawn = (command: unknown, ...rest: unknown[]) => {
  record(command, rest);
  return realSpawn(command, ...rest);
};
childProcess.spawnSync = (command: unknown, ...rest: unknown[]) => {
  record(command, rest);
  return realSpawnSync(command, ...rest);
};

after(() => {
  childProcess.spawn = realSpawn;
  childProcess.spawnSync = realSpawnSync;
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

/**
 * A committed repository with an empty directory in its checkout — the target
 * that reads clean and as this repository's own through a link — and the path
 * of its first slot.
 */
function makeRepo(name: string): { repo: string; target: string; slot1: string } {
  const repo = path.join(ws, name);
  fs.mkdirSync(repo, { recursive: true });
  fixtureGit(repo, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "README.md"), "seed\n");
  fixtureGit(repo, ["add", "-A"]);
  fixtureGit(repo, ["commit", "-q", "-m", "seed"]);
  const target = path.join(repo, "empty-target");
  fs.mkdirSync(target);
  return { repo, target, slot1: path.join(store, `${worktreeSlug(name)}-1`) };
}

function admit(folder: string): RunRow {
  return createRun({
    folder,
    prompt: "work in a checkout of your own",
    budget: { maxIterations: 1 },
    origin: "form",
  });
}

/** git children run in `dir` or under it, or handed `slot` by name. */
function gitThrough(dir: string, slot: string): string[] {
  return gitCalls
    .filter(
      (call) =>
        call.cwd === slot ||
        call.cwd === dir ||
        call.cwd.startsWith(`${dir}${path.sep}`) ||
        call.args.includes(slot),
    )
    .map((call) => `${call.cwd}: git ${call.args.filter((arg) => !arg.includes("=")).join(" ")}`);
}

async function settled(id: string): Promise<RunRow> {
  for (let i = 0; i < 1_000; i++) {
    const row = getRun(id)!;
    if (row.status !== "queued" && row.status !== "running") return row;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`run ${id} never left running`);
}

describe("a symbolic link at a checkout slot's path", () => {
  // Admission only, until the last case starts one on purpose.
  saveSettings({ maxConcurrentRuns: 0 });

  it("is skipped, not handed out as free, when it dangles", () => {
    const { slot1 } = makeRepo("dangling");
    fs.symlinkSync(path.join(tmp, "nowhere"), slot1);

    const run = admit("dangling");

    assert.equal(run.isolation, "worktree");
    assert.equal(
      run.worktree_path,
      slot1.replace(/-1$/, "-2"),
      "a dangling link was handed out as a free slot, which `worktree add` refuses",
    );
    assert.ok(fs.lstatSync(slot1).isSymbolicLink(), "the link was not left as it was");
  });

  it("is skipped, and git never run through it, when it points at a directory in the repository", () => {
    const { target, slot1 } = makeRepo("same-tree");
    fs.symlinkSync(target, slot1);
    gitCalls.length = 0;

    const run = admit("same-tree");

    assert.equal(
      run.worktree_path,
      slot1.replace(/-1$/, "-2"),
      "a link into the repository's own checkout was handed out as a reusable slot",
    );
    assert.deepEqual(gitThrough(target, slot1), [], "admission ran git through the link");
  });

  it("refuses a queued run whose slot became a link after admission, before git touches it", async () => {
    const { repo, target, slot1 } = makeRepo("planted-later");
    const run = admit("planted-later");
    assert.equal(run.worktree_path, slot1, "the fixture expects the first slot to be free");
    // Planted while the run waits for a concurrency slot, past every question
    // admission asked.
    fs.symlinkSync(target, slot1);
    gitCalls.length = 0;
    // `promoteQueued` starts every queued run, and the cases above left theirs
    // queued; started, they would do git of their own beside this one.
    db().prepare("DELETE FROM runs WHERE id != ?").run(run.id);

    saveSettings({ maxConcurrentRuns: 4 });
    try {
      promoteQueued();
      const row = await settled(run.id);

      assert.deepEqual(
        fs.readdirSync(target),
        [],
        "a checkout was written into the operator's checkout through the link",
      );
      assert.deepEqual(gitThrough(target, slot1), [], "setup ran git through the link");
      assert.equal(row.status, "failed");
      assert.match(row.stop_reason ?? "", /is a symbolic link/);
      assert.ok((row.stop_reason ?? "").includes(slot1), "the refusal does not name the slot");
      assert.equal(fixtureGit(repo, ["status", "--porcelain"]), "");
      assert.deepEqual(
        fixtureGit(repo, ["worktree", "list", "--porcelain"])
          .split("\n")
          .filter((line) => line.startsWith("worktree ")),
        [`worktree ${repo}`],
      );
    } finally {
      saveSettings({ maxConcurrentRuns: 0 });
    }
  });
});
