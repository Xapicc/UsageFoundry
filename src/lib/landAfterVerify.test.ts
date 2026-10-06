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
} else if (mode === "wait") {
  fs.writeFileSync(path.join(dir, "started"), "");
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(path.join(dir, "go"))) {
    if (Date.now() > deadline) process.exit(3);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
} else if (mode === "mark") {
  fs.writeFileSync(path.join(dir, "ran"), "");
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

const OPERATORS_ENV = "API_KEY=the-operators-own-key\n";

/**
 * A run whose branch tracks `.env`, which the operator's checkout ignores —
 * got there with `git add -f`, git's own hint when `add` meets an ignored path.
 * With `operatorEnv` the operator's checkout holds its own `.env`.
 */
function trackedEnvScene(name: string, opts: { operatorEnv: boolean }): Scene {
  const s = scene(name, { gitignore: ".env\n" });
  if (opts.operatorEnv) fs.writeFileSync(path.join(s.repo, ".env"), OPERATORS_ENV);
  fs.writeFileSync(path.join(s.slot, ".env"), "API_KEY=placeholder\n");
  git(s.slot, "add", "-f", ".env");
  git(s.slot, "commit", "-qm", "track .env");
  return s;
}

describe("landRun never overwrites a file the operator's checkout ignores", () => {
  for (const strategy of ["merge", "squash"] as const) {
    it(`refuses a ${strategy} over one, naming it, and keeps its content`, async () => {
      const s = trackedEnvScene(`ignored-${strategy}`, { operatorEnv: true });

      // `git status --porcelain` never lists an ignored file, so the checkout
      // reads as clean and Land is offered: the refusal has to come from the merge.
      const state = await land.landState(s.runId);
      assert.equal(state?.checkout?.dirty, false);
      assert.equal(state?.blocked, null);

      const landed = await land.landRun(s.runId, strategy);

      assert.equal(landed.ok, false, "landed over the operator's .env");
      assert.match(landed.ok ? "" : landed.reason, /uf\/ignored-\w+ tracks \.env/);
      // The data loss: "API_KEY=placeholder\n", with the card saying it landed.
      assert.equal(fs.readFileSync(path.join(s.repo, ".env"), "utf8"), OPERATORS_ENV);
      assert.equal(git(s.repo, "rev-parse", "main").trim(), s.base);
      assert.equal(git(s.repo, "status", "--porcelain").trim(), "", "the checkout was left part-way");
      assert.equal(landedAt(s.runId), null);
    });
  }

  it("lands a branch tracking an ignored path when the operator holds no file there", async () => {
    // The control: what is refused is the operator's file, not the branch
    // tracking a path `.gitignore` names.
    const s = trackedEnvScene("ignored-absent", { operatorEnv: false });

    const landed = await land.landRun(s.runId, "merge");

    assert.equal(landed.ok, true, landed.ok ? "" : landed.reason);
    assert.equal(fs.readFileSync(path.join(s.repo, ".env"), "utf8"), "API_KEY=placeholder\n");
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
});
