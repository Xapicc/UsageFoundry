import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * What `landRun` merges into once the operator's verify command has run.
 *
 * `landRun` proved the operator's checkout clean, standing on the target and
 * free of runs, then ran `landVerifyCommand` for up to fifteen minutes, then
 * merged without proving any of it again. That window is exactly when a person
 * waiting on the spinner goes back to the checkout. A squash then met their
 * edit, git refused it, and the undo ran `reset --hard` over every uncommitted
 * change in the tree; a `git switch` made in the window received the run's
 * work while `landed_into` named the branch it did not go to; and a run started
 * in the folder in the window was merged underneath.
 *
 * Each of those is driven here for real: a database, a repository, a run's
 * own checkout, and a verify command that does to the operator's checkout what
 * a person would do while it runs. `landRecheck` is the decision and
 * `land.test.ts` pins it; this file pins that `landRun` asks it at the moment
 * that matters — which no test of the pure function can.
 *
 * Its last two describes are what no status read of the checkout can see: a
 * file it ignores, which git's merge replaced by default, and another git
 * process holding its index lock.
 *
 * Its own file, with `DATA_DIR` named before the first import, for
 * `loopMergeOwnership.test.ts`' reason: `config.ts` is read at module load.
 */

let land: typeof import("./land");
let dbMod: typeof import("./db");
let settings: typeof import("./settings");
let orchestrator: typeof import("./orchestrator");
let root: string;
let mountId: string;

const MOUNT_DIR = "land-verify-mount";

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
 * The verify command. What it does is the first argument: `edit` and `switch`
 * are a person at the operator's checkout, `wait` holds the check open until
 * the test says go, and `mark` only records that it ran.
 */
const PROBE = `
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const [mode, dir] = process.argv.slice(2);
if (mode === "edit") {
  fs.writeFileSync(path.join(dir, "shared.txt"), "operator edit\\n");
  fs.writeFileSync(path.join(dir, "other.txt"), "operator unrelated\\n");
} else if (mode === "switch") {
  execFileSync("git", ["switch", "-q", "other"], { cwd: dir });
} else if (mode === "wait" || mode === "inspect") {
  fs.writeFileSync(path.join(dir, "started"), "");
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(path.join(dir, "go"))) {
    if (Date.now() > deadline) process.exit(3);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  if (mode === "inspect") {
    // The tree the command was left looking at once the test said go: whether a
    // merge is open in it, and what the run's file holds.
    let merging = "no";
    try {
      execFileSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { stdio: "ignore" });
      merging = "yes";
    } catch {}
    fs.writeFileSync(
      path.join(dir, "seen"),
      JSON.stringify({ shared: fs.readFileSync("shared.txt", "utf8"), merging }),
    );
  }
} else if (mode === "mark") {
  fs.writeFileSync(path.join(dir, "ran"), "");
} else if (mode === "record") {
  // What the check saw: the branch the slot stood on and the file the run's
  // work changed, read from the command's own working directory.
  const head = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" });
  fs.writeFileSync(path.join(dir, "head"), head.trim());
  fs.writeFileSync(path.join(dir, "shared"), fs.readFileSync("shared.txt", "utf8"));
}
`;

const probePath = () => path.join(root, "probe.js");
const verifyWith = (mode: string, dir: string) =>
  settings.saveSettings({
    landVerifyCommand: `${process.execPath} ${probePath()} ${mode} ${dir}`,
  });

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-land-verify-")));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, MOUNT_DIR);
  process.env.WORKSPACE_ROOTS = "";
  // Nothing here should reach a spawn of `claude`; one that does fails rather
  // than bills.
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");
  fs.mkdirSync(path.join(root, MOUNT_DIR), { recursive: true });
  fs.writeFileSync(probePath(), PROBE);

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );
  mountId = config.WORKSPACE_MOUNTS[0].id;
  dbMod = await import("./db");
  land = await import("./land");
  settings = await import("./settings");
  orchestrator = await import("./orchestrator");
  // One run at a time, so a run created during a check stays `queued` behind
  // the one `parkRun` sits there — holding its slot, as allocation does,
  // without spawning anything.
  settings.saveSettings({ maxConcurrentRuns: 1 });
});

after(() => {
  const open = (globalThis as { __ufDb?: { close(): void } }).__ufDb;
  open?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  dbMod.db().prepare("DELETE FROM runs").run();
  settings.saveSettings({ landVerifyCommand: "" });
});

interface Scene {
  runId: string;
  repo: string;
  slot: string;
  branch: string;
  /** `main` before anything was landed. */
  base: string;
  /** Where the verify command's `wait` and `mark` signal. */
  signals: string;
}

/**
 * A finished isolated run with one commit on its branch, checked out in a slot
 * where `allocateSlotPath` would look for one, and the operator's checkout on
 * `main`, clean. `other` is a second branch there for a person to switch to.
 * `gitignore` goes into the base commit as `.gitignore`.
 */
function scene(name: string, opts: { gitignore?: string } = {}): Scene {
  const repo = path.join(root, MOUNT_DIR, name);
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "shared.txt"), "base\n");
  fs.writeFileSync(path.join(repo, "other.txt"), "base\n");
  if (opts.gitignore) fs.writeFileSync(path.join(repo, ".gitignore"), opts.gitignore);
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

  const signals = path.join(root, "signals", name);
  fs.mkdirSync(signals, { recursive: true });
  return { runId, repo, slot, branch, base, signals };
}

/** Whether git can see `branch` in `into`. */
function contains(repo: string, into: string, branch: string): boolean {
  try {
    git(repo, "merge-base", "--is-ancestor", branch, into);
    return true;
  } catch {
    return false;
  }
}

function landedAt(runId: string): number | null {
  const row = dbMod.db().prepare("SELECT landed_at FROM runs WHERE id = ?").get(runId) as {
    landed_at: number | null;
  };
  return row.landed_at;
}

async function until(file: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) assert.fail(`${file} never appeared`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("landRun re-proves the checkout after the verify command", () => {
  it("lands when the check leaves the operator's checkout alone", async () => {
    // The control: without it every refusal below could be the harness.
    const s = scene("control");
    verifyWith("mark", s.signals);

    const landed = await land.landRun(s.runId, "merge");

    assert.equal(landed.ok, true, landed.ok ? "" : landed.reason);
    assert.ok(fs.existsSync(path.join(s.signals, "ran")), "the verify command never ran");
    assert.ok(contains(s.repo, "main", s.branch));
  });

  it("refuses a squash into a checkout edited during the check, and keeps the edits", async () => {
    const s = scene("edited");
    verifyWith("edit", s.repo);

    const landed = await land.landRun(s.runId, "squash");

    assert.equal(landed.ok, false);
    assert.equal(
      landed.ok ? "" : landed.reason,
      "Your checkout has uncommitted changes — commit or stash them first.",
    );
    // The data loss: both of these were `base\n` again after the unwind.
    assert.equal(fs.readFileSync(path.join(s.repo, "shared.txt"), "utf8"), "operator edit\n");
    assert.equal(fs.readFileSync(path.join(s.repo, "other.txt"), "utf8"), "operator unrelated\n");
    assert.equal(git(s.repo, "rev-parse", "main").trim(), s.base);
    assert.equal(landedAt(s.runId), null);
  });

  it("refuses when the operator switched branch during the check", async () => {
    const s = scene("switched");
    verifyWith("switch", s.repo);

    const landed = await land.landRun(s.runId, "merge");

    assert.equal(landed.ok, false);
    assert.match(landed.ok ? "" : landed.reason, /Your checkout is on other, and this work belongs on main/);
    assert.equal(contains(s.repo, "other", s.branch), false, "the work went onto the wrong branch");
    assert.equal(contains(s.repo, "main", s.branch), false);
    assert.equal(landedAt(s.runId), null);
  });

  it("refuses when a run started working in the folder during the check", async () => {
    const s = scene("busy");
    verifyWith("wait", s.signals);

    const landing = land.landRun(s.runId, "merge");
    await until(path.join(s.signals, "started"));
    dbMod
      .db()
      .prepare(
        `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                           created_at, isolation)
         VALUES ('run-intruder', ?, 'x', 'running', '{}', 1, 0, ?, 'none')`,
      )
      .run(s.repo, Date.now());
    fs.writeFileSync(path.join(s.signals, "go"), "");
    const landed = await landing;

    assert.equal(landed.ok, false);
    assert.match(landed.ok ? "" : landed.reason, /Run run-intr is working in this folder/);
    assert.equal(contains(s.repo, "main", s.branch), false);
  });
});

/**
 * A running run somewhere that is not any scene's repository, holding the one
 * concurrency slot so that a run created during a check is only admitted.
 */
function parkRun(): void {
  const hold = path.join(root, MOUNT_DIR, "hold");
  fs.mkdirSync(hold, { recursive: true });
  dbMod
    .db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                         created_at, isolation)
       VALUES ('run-parked', ?, 'x', 'running', '{}', 1, 0, ?, 'none')`,
    )
    .run(hold, Date.now());
}

describe("the check runs against what the land would carry", () => {
  it("refuses before the command runs while the run's checkout holds uncommitted work", async () => {
    const s = scene("uncommitted");
    // Committed work on the branch *and* more beside it: the case `landRefusal`
    // lets through, because it refuses on uncommitted paths only when there
    // are no commits at all.
    fs.writeFileSync(path.join(s.slot, "stray.txt"), "never committed\n");
    verifyWith("mark", s.signals);

    const landed = await land.landRun(s.runId, "merge");

    assert.equal(landed.ok, false);
    assert.match(landed.ok ? "" : landed.reason, /1 path\(s\) in .* are not committed to uf\/uncommitted: stray\.txt/);
    assert.equal(fs.existsSync(path.join(s.signals, "ran")), false, "the command ran anyway");
    assert.equal(contains(s.repo, "main", s.branch), false);
  });

  it("changes nothing when no command is configured", async () => {
    const s = scene("ungated");
    fs.writeFileSync(path.join(s.slot, "stray.txt"), "never committed\n");

    const landed = await land.landRun(s.runId, "merge");

    assert.equal(landed.ok, true, landed.ok ? "" : landed.reason);
    assert.ok(contains(s.repo, "main", s.branch));
  });

  it("keeps the run's checkout from a run started during the check", async () => {
    const s = scene("held");
    parkRun();
    verifyWith("wait", s.signals);

    const landing = land.landRun(s.runId, "merge");
    await until(path.join(s.signals, "started"));
    const started = orchestrator.createRun({
      folder: "held",
      mountId,
      prompt: "something else in the same repository",
      budget: { maxIterations: 1 },
      origin: "form",
    });
    fs.writeFileSync(path.join(s.signals, "go"), "");
    const landed = await landing;

    assert.equal(started.status, "queued");
    assert.ok(started.worktree_path, "the new run was given no checkout at all");
    assert.notEqual(
      started.worktree_path,
      s.slot,
      "the new run was given the checkout the check was running in",
    );
    assert.equal(landed.ok, true, landed.ok ? "" : landed.reason);
  });

  it("refuses when the branch gained a commit during the check", async () => {
    // A continuation adopting the slot, or the card's Commit button, commits
    // while the command runs. The merge is by name, so without the comparison
    // it carried a commit the command never saw.
    const s = scene("moved");
    verifyWith("wait", s.signals);

    const landing = land.landRun(s.runId, "merge");
    await until(path.join(s.signals, "started"));
    fs.writeFileSync(path.join(s.slot, "late.txt"), "never checked\n");
    git(s.slot, "add", "late.txt");
    git(s.slot, "commit", "-qm", "committed during the check");
    const late = git(s.slot, "rev-parse", "HEAD").trim();
    fs.writeFileSync(path.join(s.signals, "go"), "");
    const landed = await landing;

    assert.equal(landed.ok, false);
    assert.match(
      landed.ok ? "" : landed.reason,
      /uf\/moved moved while the verify command ran/,
    );
    assert.equal(contains(s.repo, "main", late), false, "main holds a commit the check never saw");
    assert.equal(git(s.repo, "rev-parse", "main").trim(), s.base);
    assert.equal(landedAt(s.runId), null);
  });

  for (const status of ["queued", "running"] as const) {
    it(`refuses when a continuation became the branch's owner during the check (${status})`, async () => {
      // A run told to carry this branch on, created while the command runs and
      // handed the slot the way `planWorkspace`'s `inheritedSlot` hands it, with
      // nothing committed yet — so the branch has not moved, and only the chain
      // says this run is no longer the one that lands it.
      const s = scene(`continued-${status}`);
      verifyWith("wait", s.signals);

      const landing = land.landRun(s.runId, "merge");
      await until(path.join(s.signals, "started"));
      dbMod
        .db()
        .prepare(
          `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                             created_at, isolation, repo_root, worktree_path, work_dir,
                             worktree_branch, worktree_base, worktree_base_branch, continues_run)
           VALUES ('run-successor', ?, 'carry on', ?, '{}', 1, 0, ?, 'worktree', ?, ?, ?, ?, ?, 'main', ?)`,
        )
        .run(s.repo, status, Date.now(), s.repo, s.slot, s.slot, s.branch, s.base, s.runId);
      fs.writeFileSync(path.join(s.signals, "go"), "");
      const landed = await landing;

      assert.equal(landed.ok, false, "the land went ahead under a run that now owns the branch");
      assert.match(
        landed.ok ? "" : landed.reason,
        /Run run-succ carries this branch on from here and is the one that lands it/,
      );
      assert.equal(git(s.repo, "rev-parse", "main").trim(), s.base);
      assert.equal(landedAt(s.runId), null);
    });
  }
});

/** The branch a checkout stands on. */
const headOf = (dir: string) => git(dir, "rev-parse", "--abbrev-ref", "HEAD").trim();

interface ReusedScene extends Scene {
  /** The later run that took the slot, and the branch it left standing in it. */
  laterId: string;
  laterBranch: string;
}

/**
 * `scene`, then a later run in the same repository that was given the run's
 * checkout the way `allocateSlotPath` gives out a clean one: its own branch cut
 * in the slot, a commit on it, and a row recording the same slot.
 */
function reusedScene(name: string): ReusedScene {
  return takeOverSlot(scene(name));
}

/** `reusedScene` over a scene already built, for one that needs more in the run's branch first. */
function takeOverSlot(s: Scene): ReusedScene {
  const name = path.basename(s.repo);
  const laterBranch = `${s.branch}-later`;
  git(s.slot, "checkout", "-q", "-b", laterBranch, s.base);
  fs.writeFileSync(path.join(s.slot, "other.txt"), "later\n");
  git(s.slot, "commit", "-qam", "the later run's work");
  const laterId = `run-${name}-later`;
  dbMod
    .db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                         created_at, finished_at, isolation, repo_root, worktree_path,
                         worktree_branch, worktree_base, worktree_base_branch)
       VALUES (?, ?, 'a later task', 'completed', '{}', 1, 1, ?, ?, 'worktree', ?, ?, ?, ?, 'main')`,
    )
    .run(laterId, s.repo, Date.now() + 1, Date.now() + 1, s.repo, s.slot, laterBranch, s.base);
  return { ...s, laterId, laterBranch };
}

describe("a checkout a later run reused, with a verify command set", () => {
  it("is offered, switched to the run's branch for the check, and back before the merge", async () => {
    const s = reusedScene("reused");
    verifyWith("record", s.signals);

    const offered = await land.landState(s.runId);
    assert.equal(offered?.blocked, null, "the card still withholds a slot Land would switch");
    assert.deepEqual(offered?.verifySwitch, { path: s.slot, holds: s.laterBranch });

    const landed = await land.landRun(s.runId, "merge");

    assert.equal(landed.ok, true, landed.ok ? "" : landed.reason);
    // What the check ran against: this run's branch and tree, not the later run's.
    assert.equal(fs.readFileSync(path.join(s.signals, "head"), "utf8"), s.branch);
    assert.equal(fs.readFileSync(path.join(s.signals, "shared"), "utf8"), "branch\n");
    assert.ok(contains(s.repo, "main", s.branch));
    assert.equal(contains(s.repo, "main", s.laterBranch), false, "the later run's branch was landed too");
    // Undone before the merge returned, with the later run's tree untouched.
    assert.equal(headOf(s.slot), s.laterBranch);
    assert.equal(git(s.slot, "status", "--porcelain").trim(), "");
    assert.equal(fs.readFileSync(path.join(s.slot, "other.txt"), "utf8"), "later\n");

    // The later run, whose slot was never anyone else's from its own side.
    const later = await land.landState(s.laterId);
    assert.equal(later?.blocked, null);
    assert.equal(later?.verifySwitch, null);
    const second = await land.landRun(s.laterId, "merge");
    assert.equal(second.ok, true, second.ok ? "" : second.reason);
    assert.ok(contains(s.repo, "main", s.laterBranch));
  });

  it("is borrowed for the whole check, so another press finds it said so", async () => {
    const s = reusedScene("borrowed");
    verifyWith("wait", s.signals);

    const landing = land.landRun(s.runId, "merge");
    await until(path.join(s.signals, "started"));
    assert.equal(orchestrator.isSlotBorrowed(s.slot), true);
    assert.equal(headOf(s.slot), s.branch, "the check was started before the switch");

    // The later run's own card, mid-switch: its slot is standing on this
    // branch, and it cannot be switched under a command that is running.
    const later = await land.landState(s.laterId);
    assert.match(
      later?.blocked ?? "",
      /It was not switched back to uf\/borrowed-later for the check, because another verify command is running in it\./,
    );
    const pressed = await land.landRun(s.laterId, "merge");
    assert.equal(pressed.ok, false);
    assert.equal(pressed.ok ? "" : pressed.reason, later?.blocked);

    fs.writeFileSync(path.join(s.signals, "go"), "");
    const landed = await landing;
    assert.equal(landed.ok, true, landed.ok ? "" : landed.reason);
    assert.equal(orchestrator.isSlotBorrowed(s.slot), false);
    assert.equal(headOf(s.slot), s.laterBranch);
  });

  it("withholds Land, naming why, while the later run's work is uncommitted in it", async () => {
    const s = reusedScene("dirty");
    fs.writeFileSync(path.join(s.slot, "scratch.txt"), "the later run's, not committed\n");
    verifyWith("mark", s.signals);

    const state = await land.landState(s.runId);
    const reason =
      "It was not switched back to uf/dirty for the check, because it holds 1 uncommitted " +
      "path(s) from uf/dirty-later: scratch.txt.";
    assert.ok(state?.blocked?.includes(reason), state?.blocked ?? "not blocked");
    assert.match(state?.blocked ?? "", /Nothing was landed\./);
    assert.equal(state?.verifySwitch, null);

    const landed = await land.landRun(s.runId, "merge");

    assert.equal(landed.ok, false);
    assert.equal(landed.ok ? "" : landed.reason, state?.blocked);
    assert.equal(fs.existsSync(path.join(s.signals, "ran")), false, "the command ran anyway");
    assert.equal(headOf(s.slot), s.laterBranch);
    assert.ok(fs.existsSync(path.join(s.slot, "scratch.txt")), "the later run's file was touched");
    assert.equal(git(s.repo, "rev-parse", "main").trim(), s.base);
  });

  it("withholds Land while a run is working in it, and switches nothing", async () => {
    const s = reusedScene("working");
    dbMod.db().prepare("UPDATE runs SET status = 'running' WHERE id = ?").run(s.laterId);
    verifyWith("mark", s.signals);

    const state = await land.landState(s.runId);
    assert.match(state?.blocked ?? "", /because a run is working in it\. Nothing was landed\./);

    const landed = await land.landRun(s.runId, "merge");

    assert.equal(landed.ok, false);
    assert.equal(landed.ok ? "" : landed.reason, state?.blocked);
    assert.equal(fs.existsSync(path.join(s.signals, "ran")), false, "the command ran anyway");
    assert.equal(headOf(s.slot), s.laterBranch);
    assert.equal(git(s.repo, "rev-parse", "main").trim(), s.base);
  });

  describe("whose own ignored file the run's branch tracks", () => {
    /**
     * `git status` never lists an ignored file, so the slot reads clean and the
     * switch is offered; and `git checkout` replaces an ignored file by default,
     * the way `git merge` did before `--no-overwrite-ignore`. The switch to the
     * run's branch overwrote the later run's file with the run's tracked one,
     * and the switch back, to a branch that does not track the path, deleted
     * it: a seeded `.env` is the file this is for, and nothing said so.
     */
    const LATERS_OWN = "the later run's own, never in git\n";

    function ignoredScene(name: string): ReusedScene {
      const s = takeOverSlot(trackedIgnoredScene(name, { operatorFile: false }));
      fs.writeFileSync(path.join(s.slot, "local.settings.json"), LATERS_OWN);
      assert.equal(git(s.slot, "status", "--porcelain").trim(), "", "precondition: the slot reads clean");
      return s;
    }

    const keptFile = (s: ReusedScene) => path.join(s.slot, "local.settings.json");

    it("refuses Land's switch, runs nothing, and keeps the file", async () => {
      const s = ignoredScene("switch-ignored");
      verifyWith("mark", s.signals);

      const landed = await land.landRun(s.runId, "merge");

      assert.equal(landed.ok, false, "landed after switching over the later run's ignored file");
      assert.match(
        landed.ok ? "" : landed.reason,
        /git would not switch it: .*overwritten by checkout: local\.settings\.json — ignored/,
      );
      assert.equal(fs.existsSync(path.join(s.signals, "ran")), false, "the command ran anyway");
      assert.equal(headOf(s.slot), s.laterBranch);
      assert.equal(fs.readFileSync(keptFile(s), "utf8"), LATERS_OWN);
      assert.equal(git(s.repo, "rev-parse", "main").trim(), s.base);
      assert.equal(landedAt(s.runId), null);
    });

    it("refuses a review block's switch the same way", async () => {
      const s = ignoredScene("switch-ignored-review");

      const outcome = await land.verifyBranchForReview(
        orchestrator.getRun(s.runId)!,
        `${process.execPath} ${probePath()} mark ${s.signals}`,
      );

      assert.equal(outcome.ran, false, "the block's command ran after the switch");
      assert.match(outcome.reason, /git would not switch it: .*overwritten by checkout: local\.settings\.json — ignored/);
      assert.equal(fs.existsSync(path.join(s.signals, "ran")), false, "the command ran anyway");
      assert.equal(headOf(s.slot), s.laterBranch);
      assert.equal(fs.readFileSync(keptFile(s), "utf8"), LATERS_OWN);
    });

    it("still switches and lands when the later run holds no file at that path", async () => {
      // The control: what is refused is the later run's file, not a branch that
      // tracks a path `.gitignore` names.
      const s = takeOverSlot(trackedIgnoredScene("switch-ignored-absent", { operatorFile: false }));
      verifyWith("mark", s.signals);

      const landed = await land.landRun(s.runId, "merge");

      assert.equal(landed.ok, true, landed.ok ? "" : landed.reason);
      assert.ok(fs.existsSync(path.join(s.signals, "ran")), "the command did not run");
      assert.equal(headOf(s.slot), s.laterBranch, "the slot was not put back");
    });
  });

  it("refuses two runs whose checkouts hold each other's branch, which git cannot switch", async () => {
    const a = scene("swapped");
    const bBranch = `${a.branch}-b`;
    const bSlot = path.join(orchestrator.worktreeStore(a.repo)!, `${orchestrator.repoSlug(a.repo)}-2`);
    git(a.repo, "worktree", "add", "-q", "-b", bBranch, bSlot, a.base);
    fs.writeFileSync(path.join(bSlot, "other.txt"), "b's work\n");
    git(bSlot, "commit", "-qam", "b's work");
    dbMod
      .db()
      .prepare(
        `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                           created_at, finished_at, isolation, repo_root, worktree_path,
                           worktree_branch, worktree_base, worktree_base_branch)
         VALUES ('run-swapped-b', ?, 'b', 'completed', '{}', 1, 1, ?, ?, 'worktree', ?, ?, ?, ?, 'main')`,
      )
      .run(a.repo, Date.now(), Date.now(), a.repo, bSlot, bBranch, a.base);
    // Each slot now holds the other run's branch. git lets a branch be checked
    // out in one worktree only, so neither can be switched back to its own.
    git(a.slot, "checkout", "-q", "--detach");
    git(bSlot, "checkout", "-q", "--detach");
    git(bSlot, "checkout", "-q", a.branch);
    git(a.slot, "checkout", "-q", bBranch);
    verifyWith("mark", a.signals);

    for (const [runId, branch, heldBy] of [
      [a.runId, a.branch, bSlot],
      ["run-swapped-b", bBranch, a.slot],
    ] as const) {
      const state = await land.landState(runId);
      assert.ok(
        state?.blocked?.includes(`because ${branch} is checked out in ${heldBy}.`),
        state?.blocked ?? "not blocked",
      );
      const landed = await land.landRun(runId, "merge");
      assert.equal(landed.ok, false);
      assert.equal(landed.ok ? "" : landed.reason, state?.blocked);
    }
    assert.equal(fs.existsSync(path.join(a.signals, "ran")), false, "the command ran anyway");
    assert.equal(headOf(a.slot), bBranch);
    assert.equal(headOf(bSlot), a.branch);
    assert.equal(git(a.repo, "rev-parse", "main").trim(), a.base);
  });

  it("asks who owns the branch again after the switch is undone", async () => {
    // A run told to carry this branch on, created while the check is running in
    // the switched slot: the tip has not moved, so only the chain says this run
    // no longer lands it. The refusal must come after the slot is back, so the
    // later run is not left standing on the wrong branch by a land that stopped.
    const s = reusedScene("continued");
    verifyWith("wait", s.signals);

    const landing = land.landRun(s.runId, "merge");
    await until(path.join(s.signals, "started"));
    dbMod
      .db()
      .prepare(
        `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                           created_at, isolation, repo_root, worktree_path, work_dir,
                           worktree_branch, worktree_base, worktree_base_branch, continues_run)
         VALUES ('run-successor', ?, 'carry on', 'queued', '{}', 1, 0, ?, 'worktree', ?, ?, ?, ?, ?, 'main', ?)`,
      )
      .run(s.repo, Date.now(), s.repo, path.join(root, "elsewhere"), path.join(root, "elsewhere"), s.branch, s.base, s.runId);
    fs.writeFileSync(path.join(s.signals, "go"), "");
    const landed = await landing;

    assert.equal(landed.ok, false, "the land went ahead under a run that now owns the branch");
    assert.match(
      landed.ok ? "" : landed.reason,
      /Run run-succ carries this branch on from here and is the one that lands it/,
    );
    assert.equal(headOf(s.slot), s.laterBranch);
    assert.equal(git(s.repo, "rev-parse", "main").trim(), s.base);
    assert.equal(landedAt(s.runId), null);
  });
});

/**
 * The writers a verify command's hold is there to keep out.
 *
 * `holdSlot` and `borrowSlot` refused a second *check*, a run and a continuation,
 * and said nothing to the three doors that write to or remove a checkout:
 * Purge's `worktree remove --force` took a later run's switched checkout out
 * from under the command, Resolve opened its merge in the tree the command was
 * checking and the review block then passed it, and nothing looked at the slot
 * once the command had exited 0. None of it throws, so the only place the
 * exclusion is checked in both directions is a command held open on a real slot
 * while the other door is pressed.
 */
describe("a checkout a verify command is running in is kept from Purge, Delete and Resolve", () => {
  const claudeBin = () => process.env.CLAUDE_BIN!;
  const command = (mode: string, dir: string) => `${process.execPath} ${probePath()} ${mode} ${dir}`;
  const review = (runId: string, mode: string, dir: string) =>
    land.verifyBranchForReview(orchestrator.getRun(runId)!, command(mode, dir));

  before(() => {
    // A resolution wrongly let in has to keep its merge open long enough to be
    // seen; the guard under test means this is never run.
    fs.writeFileSync(claudeBin(), "#!/bin/sh\nsleep 3\n", { mode: 0o755 });
  });
  after(() => fs.rmSync(claudeBin(), { force: true }));

  /** Main moves the file the run changed, so the run's branch conflicts with it. */
  function mainConflicts(s: Scene): void {
    fs.writeFileSync(path.join(s.repo, "shared.txt"), "main moved\n");
    git(s.repo, "commit", "-qam", "main moved");
  }

  it("refuses Purge while a check has switched a later run's checkout to the branch", async () => {
    const s = reusedScene("purge-mid");
    const checking = review(s.runId, "wait", s.signals);
    await until(path.join(s.signals, "started"));
    assert.equal(orchestrator.isSlotBorrowed(s.slot), true);
    assert.equal(headOf(s.slot), s.branch, "switched for the check");

    const purged = await land.purgeBranch(s.runId, s.branch);
    fs.writeFileSync(path.join(s.signals, "go"), "");
    const verdict = await checking;

    assert.equal(purged.ok, false, "Purge went ahead under the check");
    assert.match(
      purged.ok ? "" : purged.reason,
      /^A verify command has switched .+, a later run's checkout, to uf\/purge-mid for its check, so purging now would delete the checkout from under the command\. Nothing was deleted\./,
    );
    assert.ok(fs.existsSync(s.slot), "Purge of this run removed the later run's checkout");
    assert.equal(verdict.passed, true, verdict.reason);
    assert.equal(headOf(s.slot), s.laterBranch);
    git(s.repo, "rev-parse", "--verify", `refs/heads/${s.branch}`);

    // The control: with no check running the same press goes through, and still
    // leaves the later run's checkout alone, because the branch is not in it.
    const again = await land.purgeBranch(s.runId, s.branch);
    assert.equal(again.ok, true, again.ok ? "" : again.reason);
    assert.ok(fs.existsSync(s.slot));
    assert.equal(headOf(s.slot), s.laterBranch);
  });

  it("refuses Purge while a check is running in the run's own checkout", async () => {
    const s = scene("purge-own");
    const checking = review(s.runId, "wait", s.signals);
    await until(path.join(s.signals, "started"));

    const purged = await land.purgeBranch(s.runId, s.branch);
    fs.writeFileSync(path.join(s.signals, "go"), "");
    const verdict = await checking;

    assert.equal(purged.ok, false, "Purge removed the checkout the command was running in");
    assert.match(
      purged.ok ? "" : purged.reason,
      /^A verify command is running its check in .+, where uf\/purge-own is checked out, so purging now would delete the checkout from under the command\. Nothing was deleted\./,
    );
    assert.ok(fs.existsSync(s.slot));
    assert.equal(verdict.passed, true, verdict.reason);

    const again = await land.purgeBranch(s.runId, s.branch);
    assert.equal(again.ok, true, again.ok ? "" : again.reason);
    assert.equal(fs.existsSync(s.slot), false, "the control press no longer removes the checkout");
  });

  it("refuses Delete while a check has switched a later run's checkout to a landed branch", async () => {
    const s = reusedScene("delete-mid");
    const landed = await land.landRun(s.runId, "merge");
    assert.equal(landed.ok, true, landed.ok ? "" : landed.reason);
    const checking = review(s.runId, "wait", s.signals);
    await until(path.join(s.signals, "started"));
    assert.equal(headOf(s.slot), s.branch, "switched for the check");

    const deleted = await land.deleteBranch(s.runId);
    fs.writeFileSync(path.join(s.signals, "go"), "");
    await checking;

    assert.equal(deleted.ok, false, "Delete went ahead under the check");
    assert.match(
      deleted.ok ? "" : deleted.reason,
      /^A verify command has switched .+, a later run's checkout, to uf\/delete-mid for its check, so deleting now would remove the checkout from under the command\. Nothing was deleted\./,
    );
    assert.ok(fs.existsSync(s.slot), "Delete of this run removed the later run's checkout");
    assert.equal(headOf(s.slot), s.laterBranch);
  });

  it("refuses Resolve while a check is running in the run's own checkout", async () => {
    const s = scene("resolve-own");
    mainConflicts(s);
    const checking = review(s.runId, "inspect", s.signals);
    await until(path.join(s.signals, "started"));
    assert.equal((await land.landState(s.runId))?.preview.outcome, "conflict");

    const resolved = await land.resolveConflicts(s.runId);
    fs.writeFileSync(path.join(s.signals, "go"), "");
    const verdict = await checking;

    assert.equal(resolved.ok, false, "a resolution was opened in the checkout under the check");
    assert.match(
      resolved.ok ? "" : resolved.reason,
      /^A verify command is running its check in .+, where uf\/resolve-own is checked out, so a resolution would open its merge in the tree the command is checking\. Nothing was started\./,
    );
    const seen = JSON.parse(fs.readFileSync(path.join(s.signals, "seen"), "utf8"));
    assert.deepEqual(seen, { shared: "branch\n", merging: "no" });
    assert.equal(verdict.passed, true, verdict.reason);
    assert.equal(git(s.slot, "status", "--porcelain"), "");
  });

  it("refuses Resolve while a check has switched a later run's checkout to the branch", async () => {
    const s = reusedScene("resolve-mid");
    mainConflicts(s);
    const checking = review(s.runId, "inspect", s.signals);
    await until(path.join(s.signals, "started"));
    assert.equal(orchestrator.isSlotBorrowed(s.slot), true);
    assert.equal(headOf(s.slot), s.branch, "switched for the check");

    const resolved = await land.resolveConflicts(s.runId);
    fs.writeFileSync(path.join(s.signals, "go"), "");
    const verdict = await checking;

    assert.equal(resolved.ok, false, "a resolution was opened in the checkout under the check");
    assert.match(
      resolved.ok ? "" : resolved.reason,
      /^A verify command has switched .+, a later run's checkout, to uf\/resolve-mid for its check, so a resolution would open its merge in the tree the command is checking\. Nothing was started\./,
    );
    const seen = JSON.parse(fs.readFileSync(path.join(s.signals, "seen"), "utf8"));
    assert.deepEqual(seen, { shared: "branch\n", merging: "no" });
    assert.equal(verdict.passed, true, verdict.reason);
    assert.equal(headOf(s.slot), s.laterBranch);
    assert.equal(git(s.slot, "status", "--porcelain"), "");
  });

  it("does not pass a check whose checkout has a merge open in it afterwards", async () => {
    // Whoever opened it, and whichever door let them in: the tip is where it was,
    // because a merge has not committed, so the tip comparison cannot see it.
    const s = scene("guard-merge");
    mainConflicts(s);
    const checking = review(s.runId, "wait", s.signals);
    await until(path.join(s.signals, "started"));
    try {
      git(s.slot, "merge", "--no-edit", "main");
    } catch {
      // The conflict is the point.
    }
    assert.ok(fs.existsSync(path.join(s.slot, ".git")), "the slot is a checkout");
    fs.writeFileSync(path.join(s.signals, "go"), "");
    const verdict = await checking;

    assert.equal(verdict.passed, false, "the check passed on a tree with a merge open in it");
    assert.equal(verdict.ran, false);
    assert.match(verdict.reason, /^A merge was opened in .+ while the verify command ran/);
    git(s.slot, "merge", "--abort");
  });

  it("does not pass a check whose checkout has an uncommitted change to a tracked file afterwards", async () => {
    const s = scene("guard-dirt");
    const checking = review(s.runId, "wait", s.signals);
    await until(path.join(s.signals, "started"));
    fs.writeFileSync(path.join(s.slot, "shared.txt"), "written during the check\n");
    fs.writeFileSync(path.join(s.signals, "go"), "");
    const verdict = await checking;

    assert.equal(verdict.passed, false, "the check passed on a tree edited while it ran");
    assert.equal(verdict.ran, false);
    assert.match(verdict.reason, /has uncommitted changes to shared\.txt after the verify command ran/);
  });

  it("still passes a check that left an untracked file behind", async () => {
    // The control for the two above: build output and caches are untracked, and
    // a check that wrote some is not a check on another tree.
    const s = scene("guard-untracked");
    const checking = review(s.runId, "wait", s.signals);
    await until(path.join(s.signals, "started"));
    fs.writeFileSync(path.join(s.slot, "build-output.txt"), "left by the command\n");
    fs.writeFileSync(path.join(s.signals, "go"), "");
    const verdict = await checking;

    assert.equal(verdict.passed, true, verdict.reason);
  });
});

const OPERATORS_FILE = '{ "Values": { "API_KEY": "the-operators-own-key" } }\n';
const PLACEHOLDER = '{ "Values": { "API_KEY": "placeholder" } }\n';

/**
 * A run whose branch tracks `local.settings.json`, which the operator's checkout
 * ignores — got there with `git add -f`, git's own hint when `add` meets an
 * ignored path. With `operatorFile` the operator's checkout holds its own.
 *
 * Not `.env`, which this used to be: the default `isolationCopyGlobs` names
 * that, so a branch carrying it is now refused as a seeded file before the
 * merge is reached (`seededRefusal`, pinned in `deliverRun.test.ts`), and what
 * is pinned here is the merge's own refusal for an ignored file nothing seeds.
 */
function trackedIgnoredScene(name: string, opts: { operatorFile: boolean }): Scene {
  const s = scene(name, { gitignore: "local.settings.json\n" });
  if (opts.operatorFile) fs.writeFileSync(path.join(s.repo, "local.settings.json"), OPERATORS_FILE);
  fs.writeFileSync(path.join(s.slot, "local.settings.json"), PLACEHOLDER);
  git(s.slot, "add", "-f", "local.settings.json");
  git(s.slot, "commit", "-qm", "track local.settings.json");
  return s;
}

describe("landRun never overwrites a file the operator's checkout ignores", () => {
  for (const strategy of ["merge", "squash"] as const) {
    it(`refuses a ${strategy} over one, naming it, and keeps its content`, async () => {
      const s = trackedIgnoredScene(`ignored-${strategy}`, { operatorFile: true });

      // `git status --porcelain` never lists an ignored file, so the checkout
      // reads as clean and Land is offered: the refusal has to come from the merge.
      const state = await land.landState(s.runId);
      assert.equal(state?.checkout?.dirty, false);
      assert.equal(state?.blocked, null);

      const landed = await land.landRun(s.runId, strategy);

      assert.equal(landed.ok, false, "landed over the operator's local.settings.json");
      assert.match(landed.ok ? "" : landed.reason, /uf\/ignored-\w+ tracks local\.settings\.json/);
      // The data loss: the placeholder, with the card saying it landed.
      assert.equal(fs.readFileSync(path.join(s.repo, "local.settings.json"), "utf8"), OPERATORS_FILE);
      assert.equal(git(s.repo, "rev-parse", "main").trim(), s.base);
      assert.equal(git(s.repo, "status", "--porcelain").trim(), "", "the checkout was left part-way");
      assert.equal(landedAt(s.runId), null);
    });
  }

  it("lands a branch tracking an ignored path when the operator holds no file there", async () => {
    // The control: what is refused is the operator's file, not the branch
    // tracking a path `.gitignore` names.
    const s = trackedIgnoredScene("ignored-absent", { operatorFile: false });

    const landed = await land.landRun(s.runId, "merge");

    assert.equal(landed.ok, true, landed.ok ? "" : landed.reason);
    assert.equal(fs.readFileSync(path.join(s.repo, "local.settings.json"), "utf8"), PLACEHOLDER);
  });
});

/**
 * Another git process in the operator's checkout at the moment of the merge:
 * an editor's background `git status`, a terminal, a CLI session. Held for the
 * whole land here, where in life it is held for milliseconds, because what is
 * pinned is what the land says and leaves, not how likely the collision is.
 */
describe("landRun into a checkout another git process holds the index lock of", () => {
  for (const strategy of ["merge", "squash"] as const) {
    it(`refuses a fast-forward ${strategy} with nothing written, then lands once the lock is gone`, async () => {
      const s = scene(`index-lock-${strategy}`);
      const lock = path.join(s.repo, ".git", "index.lock");
      fs.writeFileSync(lock, "");

      const landed = await land.landRun(s.runId, strategy);

      assert.equal(landed.ok, false, "landed through a held index.lock");
      const reason = landed.ok ? "" : landed.reason;
      // The generic "git refused the merge" with git's own first line, before.
      assert.match(reason, /^Another git process was using your checkout/);
      assert.ok(reason.includes(`${lock} was left behind`), reason);
      assert.equal(git(s.repo, "rev-parse", "main").trim(), s.base);
      assert.equal(fs.existsSync(path.join(s.repo, ".git", "MERGE_HEAD")), false);
      assert.equal(fs.existsSync(path.join(s.repo, "shared.txt")), true);
      assert.equal(fs.readFileSync(path.join(s.repo, "shared.txt"), "utf8"), "base\n");
      assert.equal(landedAt(s.runId), null);

      // "Land again and it should go through" is a claim, so it is checked.
      fs.rmSync(lock);
      const again = await land.landRun(s.runId, strategy);
      assert.equal(again.ok, true, again.ok ? "" : again.reason);
      assert.equal(fs.readFileSync(path.join(s.repo, "shared.txt"), "utf8"), "branch\n");
    });
  }

  it("says a merge left part-way is part-way, rather than that the checkout is as it was", async () => {
    // Not a fast-forward, so git writes MERGE_HEAD before it finds the lock
    // taken, and the abort needs the same lock. Before `unwind` asked, the card
    // said the checkout was as it was over a MERGE_HEAD that the operator's
    // next commit would have recorded as a merge of work the tree lacks.
    const s = scene("index-lock-true-merge");
    fs.writeFileSync(path.join(s.repo, "other.txt"), "main moved\n");
    git(s.repo, "commit", "-qam", "main moved");
    const moved = git(s.repo, "rev-parse", "main").trim();
    fs.writeFileSync(path.join(s.repo, ".git", "index.lock"), "");

    const landed = await land.landRun(s.runId, "merge");

    assert.equal(landed.ok, false);
    assert.match(
      landed.ok ? "" : landed.reason,
      /could not be rolled back, so your checkout may still be mid-merge — run git merge --abort there/,
    );
    assert.equal(fs.existsSync(path.join(s.repo, ".git", "MERGE_HEAD")), true);
    assert.equal(git(s.repo, "rev-parse", "main").trim(), moved);
    assert.equal(landedAt(s.runId), null);
  });

  it("takes back a fast-forward refused at the target's ref lock, then lands once the lock is gone", async () => {
    // A fast-forward writes the branch's tree into the index and the working
    // tree and moves `main` last, so the lock refuses it with the whole branch
    // staged and no MERGE_HEAD. Before `unwind` asked the checkout, the card
    // said it was as it was over that staged change.
    const s = scene("ref-lock");
    const lock = path.join(s.repo, ".git", "refs", "heads", "main.lock");
    fs.writeFileSync(lock, "");

    const landed = await land.landRun(s.runId, "merge");

    assert.equal(landed.ok, false, "landed through a held ref lock");
    const reason = landed.ok ? "" : landed.reason;
    assert.match(reason, /^Another git process was using your checkout/);
    assert.ok(reason.includes(`${lock} was left behind`), reason);
    assert.equal(git(s.repo, "rev-parse", "main").trim(), s.base);
    assert.equal(git(s.repo, "status", "--porcelain"), "", "the branch was left in the checkout");
    assert.equal(fs.readFileSync(path.join(s.repo, "shared.txt"), "utf8"), "base\n");
    assert.equal(fs.existsSync(path.join(s.repo, ".git", "MERGE_HEAD")), false);
    assert.equal(landedAt(s.runId), null);

    fs.rmSync(lock);
    const again = await land.landRun(s.runId, "merge");
    assert.equal(again.ok, true, again.ok ? "" : again.reason);
    assert.equal(fs.readFileSync(path.join(s.repo, "shared.txt"), "utf8"), "branch\n");
  });

  it("says a squash refused at its commit by the target's ref lock met another git process", async () => {
    // `merge --squash` moves no ref, so it stages the branch and the commit is
    // what meets the lock. `reset --merge` then restores the tree and exits 1
    // on the same lock, and the card said the squash was still staged. Then it
    // said the commit's own stderr, where a merge refused by the same lock got
    // `lockRefusal`'s sentence.
    const s = scene("ref-lock-squash");
    const lock = path.join(s.repo, ".git", "refs", "heads", "main.lock");
    fs.writeFileSync(lock, "");

    const landed = await land.landRun(s.runId, "squash");

    assert.equal(landed.ok, false, "landed through a held ref lock");
    const reason = landed.ok ? "" : landed.reason;
    assert.match(reason, /^Another git process was using your checkout/);
    assert.ok(reason.includes(`${lock} was left behind`), reason);
    assert.equal(git(s.repo, "rev-parse", "main").trim(), s.base);
    assert.equal(git(s.repo, "status", "--porcelain"), "", "the squash was left staged");
    assert.equal(fs.readFileSync(path.join(s.repo, "shared.txt"), "utf8"), "base\n");
    assert.equal(landedAt(s.runId), null);

    fs.rmSync(lock);
    const again = await land.landRun(s.runId, "squash");
    assert.equal(again.ok, true, again.ok ? "" : again.reason);
    assert.equal(fs.readFileSync(path.join(s.repo, "shared.txt"), "utf8"), "branch\n");
  });
});
