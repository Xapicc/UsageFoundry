import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

/**
 * Covers which directory a conflict resolution is given, and only that.
 *
 * Not a pure function, and it cannot be one: the fault it is here for is that
 * two runs were handed the same path, and a path is only shared once a real
 * store, a real repository and two real `git worktree add`s have said so. The
 * aux checkout was `<repoSlug>-resolve` — a constant per repository — while the
 * removal that precedes creating it is an unconditional `worktree remove
 * --force` plus `rmSync`. Two resolutions in one repository therefore destroyed
 * each other's working tree, each with a billed `claude` child editing files
 * inside it, and neither the guard on the way in (`assistRunning`, keyed on one
 * run) nor the assist budget (`maxConcurrentAssists`, which is two) said a word.
 * Nothing about it fails loudly: both children run to completion and write
 * `run_reviews` rows describing work that was overwritten.
 *
 * It also covers who else may write to that checkout while a resolution is
 * being set up, which needs the same real repository for the same reason: the
 * fault is an interleaving of git calls, and it is only real once a merge has
 * been opened in a slot and something else has staged it. Commit and `reopenRun`
 * each read the resolution's claim once and went on awaiting git, or could not
 * read it at all, so a Commit pressed as a resolution started committed the
 * open merge, conflict markers and all, and a pick-up queued a work cycle into
 * the checkout the merge was about to be opened in. Each is interleaved here by
 * holding one git call of the first caller until the second has run.
 *
 * Its own file for `slotProbes.test.ts`'s reason: it needs a real git repository
 * inside a real mount, and `DATA_DIR` and `CLAUDE_HOME` set before anything is
 * required, which `land.test.ts` — pure functions, static imports — cannot give.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-resolve-")));
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

const { createRun, getRun, reopenRun } = require("./orchestrator") as typeof import("./orchestrator");
const { saveSettings } = require("./settings") as typeof import("./settings");
const land = require("./land") as typeof import("./land");
const { resolveCheckout } = land;
const gitModule = require("./git") as typeof import("./git");
const { db } = require("./db") as typeof import("./db");
const { assistRunning } = require("./review") as typeof import("./review");

after(() => {
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

/** One repository with a branch per run, which is the state after two runs. */
function makeRepo(name: string, branches: readonly string[]): string {
  const repo = path.join(ws, name);
  fs.mkdirSync(repo, { recursive: true });
  fixtureGit(repo, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "README.md"), "seed\n");
  fixtureGit(repo, ["add", "-A"]);
  fixtureGit(repo, ["commit", "-q", "-m", "seed"]);
  for (const branch of branches) fixtureGit(repo, ["branch", branch, "main"]);
  return repo;
}

describe("the checkout a resolution is given", () => {
  // Nothing may be promoted: a started run would do its own git, asynchronously,
  // in the middle of the fixture.
  saveSettings({ maxConcurrentRuns: 0 });

  const repo = makeRepo("shared", ["uf/first", "uf/second"]);

  it("is not the same directory for two runs in one repository", async () => {
    // Neither run has a usable checkout of its own — nothing was promoted, so no
    // slot exists on disk — which is the ordinary state of a finished run whose
    // slot a later one took over, and the branch of `resolveCheckout` that used
    // the shared path.
    const first = createRun({
      folder: "shared",
      prompt: "resolve the first branch",
      budget: { maxIterations: 1 },
      origin: "form",
    });
    const second = createRun({
      folder: "shared",
      prompt: "resolve the second branch",
      budget: { maxIterations: 1 },
      origin: "form",
    });

    const one = await resolveCheckout(repo, first, "uf/first");
    const two = await resolveCheckout(repo, second, "uf/second");

    assert.notEqual(
      one.path,
      two.path,
      "two runs resolving in one repository were handed the same directory",
    );

    // The one that matters: the second call force-removes whatever stands at the
    // path it is about to use, so a shared path leaves the first resolution's
    // checkout gone — or, worse, standing on the second run's branch, which is
    // what its `after` handler would then read files from and commit.
    assert.ok(fs.existsSync(one.path), "the first resolution's checkout was deleted");
    assert.equal(
      fixtureGit(one.path, ["rev-parse", "--abbrev-ref", "HEAD"]),
      "uf/first",
      "the first resolution's checkout was taken over by the second run's branch",
    );
    assert.equal(fixtureGit(two.path, ["rev-parse", "--abbrev-ref", "HEAD"]), "uf/second");

    // Both are throwaway checkouts in the store, so both are removed either way.
    assert.equal(one.temporary, true);
    assert.equal(two.temporary, true);
    for (const at of [one.path, two.path]) {
      assert.equal(path.dirname(at), path.join(ws, ".uf-worktrees"));
    }
  });

  it("refuses a slot a cut-off resolution left mid-merge, and never says to commit it", async () => {
    // The run's own slot still holds its branch, so it is reused or refused.
    // Its tracked dirt here is a merge nobody finished, and the refusal used to
    // be the dirty-slot sentence: "Commit or discard them there and resolve
    // again". Committing it is how the markers reached the branch and then the
    // target, so this state gets a sentence of its own.
    const midMerge = makeRepo("mid-merge", ["uf/cut-off"]);
    const slot = path.join(ws, ".uf-worktrees", "mid-merge-slot");
    fixtureGit(midMerge, ["worktree", "add", "-q", slot, "uf/cut-off"]);
    fs.writeFileSync(path.join(slot, "README.md"), "branch side\n");
    fixtureGit(slot, ["commit", "-q", "-am", "branch side"]);
    fs.writeFileSync(path.join(midMerge, "README.md"), "main side\n");
    fixtureGit(midMerge, ["commit", "-q", "-am", "main side"]);
    assert.throws(() => fixtureGit(slot, ["merge", "--no-edit", "main"]));

    const run = createRun({
      folder: "mid-merge",
      prompt: "resolve a branch whose last resolution was cut off",
      budget: { maxIterations: 1 },
      origin: "form",
    });

    await assert.rejects(
      resolveCheckout(midMerge, { ...run, worktree_path: slot }, "uf/cut-off"),
      (err: Error) => {
        assert.match(err.message, /in the middle of a merge/);
        assert.match(err.message, /git merge --abort/);
        assert.doesNotMatch(err.message, /Commit or discard/);
        return true;
      },
    );
    // Refused, not repaired: whether the open merge is a resolution's or the
    // operator's own is not something this can tell.
    assert.ok(fixtureGit(slot, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]));
  });
});

/**
 * A finished run whose own slot still holds its branch, and whose branch
 * conflicts with `main` in `README.md`: the checkout a resolution reuses rather
 * than replaces, and the one Commit writes in.
 */
function conflictingRunInSlot(name: string, status: "completed" | "stopped") {
  const branch = `uf/${name}`;
  const repo = makeRepo(name, [branch]);
  // The app's own commit runs with no `-c` of its own, and this throwaway
  // repository's identity is the only one it may use.
  fixtureGit(repo, ["config", "user.email", "test@example.invalid"]);
  fixtureGit(repo, ["config", "user.name", "Test"]);
  const base = fixtureGit(repo, ["rev-parse", "main"]);
  const slot = path.join(ws, ".uf-worktrees", `${name}-slot`);
  fixtureGit(repo, ["worktree", "add", "-q", slot, branch]);
  fs.writeFileSync(path.join(slot, "README.md"), "branch side\n");
  fixtureGit(slot, ["commit", "-q", "-am", "branch side"]);
  fs.writeFileSync(path.join(repo, "README.md"), "main side\n");
  fixtureGit(repo, ["commit", "-q", "-am", "main side"]);

  const runId = `race-${name}`;
  db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                         created_at, finished_at, work_dir, isolation, repo_root, worktree_path,
                         worktree_branch, worktree_base, worktree_base_branch)
       VALUES (?, ?, 'change the readme', ?, '{"maxIterations":1}', 1, 1, ?, ?, ?, 'worktree',
               ?, ?, ?, ?, 'main')`,
    )
    .run(runId, repo, status, Date.now(), Date.now(), slot, repo, slot, branch, base);
  return { runId, repo, slot, branch };
}

/** Until no resolution of this run is running, so its `after` cannot outlive the test. */
async function settledResolution(runId: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (assistRunning(runId, "resolve")) {
    assert.ok(Date.now() < deadline, "the resolution never settled");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

type Outcome = Awaited<ReturnType<typeof land.resolveConflicts>>;

describe("the other writers of a run's checkout while a resolution is set up", () => {
  it("a Commit pressed as a resolution starts cannot put its conflict markers on the branch", async (t) => {
    const { runId, repo, slot, branch } = conflictingRunInSlot("commit-race", "completed");
    // Pending work that is untracked only, which `resolveCheckout` lets through
    // because an untracked file cannot reach a resolution's own commit.
    fs.writeFileSync(path.join(slot, "notes.txt"), "the run's last notes\n");

    const realGit = gitModule.git;
    let resolution = null as Outcome | null;
    let commitSettled = () => {};
    const committing = new Promise<void>((resolve) => {
      commitSettled = resolve;
    });
    t.mock.method(gitModule, "git", async (...call: Parameters<typeof realGit>) => {
      const [cwd, args] = call;
      // Resolve, pressed while Commit's `add -A` is on its way to git.
      if (resolution === null && cwd === slot && args[0] === "add" && args[1] === "-A") {
        resolution = await land.resolveConflicts(runId);
      }
      // A resolution that did start has no child to run — `CLAUDE_BIN` cannot
      // spawn — so it goes straight to rolling back. Held until the commit is
      // made, or the abort could close the merge before `add -A` staged it and
      // the fixture would lose the race it is here to run.
      if (args[0] === "merge" && args[1] === "--abort") await committing;
      return realGit(...call);
    });

    let committed: Outcome;
    try {
      committed = await land.commitPending(runId, "Keep the run's notes");
    } finally {
      commitSettled();
    }
    await settledResolution(runId);

    assert.doesNotMatch(
      fixtureGit(repo, ["show", `${branch}:README.md`]),
      /^<<<<<<< /m,
      "the conflict markers reached the branch",
    );
    assert.equal(
      fixtureGit(repo, ["rev-list", "--parents", "-n", "1", branch]).split(" ").length,
      2,
      "the Commit made a merge commit out of the resolution's open merge",
    );
    assert.ok(resolution, "the fixture never pressed Resolve, so this proves nothing");
    assert.equal(resolution.ok, false, "a resolution opened its merge under a commit");
    assert.match(resolution.ok ? "" : resolution.reason, /commit is being made/);
    // And the Commit did what it was pressed for.
    assert.equal(committed.ok, true, committed.ok ? "" : committed.reason);
    assert.equal(fixtureGit(repo, ["show", `${branch}:notes.txt`]), "the run's last notes");
  });

  it("a pick-up while a resolution is being set up is refused, and the run left alone", async (t) => {
    const { runId, repo, slot, branch } = conflictingRunInSlot("reopen-race", "stopped");
    const tipBefore = fixtureGit(repo, ["rev-parse", branch]);

    const realGit = gitModule.git;
    let pickUp = null as ReturnType<typeof reopenRun> | null;
    t.mock.method(gitModule, "git", async (...call: Parameters<typeof realGit>) => {
      const [cwd, args] = call;
      // The last moment before the merge is opened, and well before the row
      // `reopenRun` could always read has been written.
      if (pickUp === null && cwd === slot && args[0] === "merge" && args[1] === "--no-edit") {
        pickUp = reopenRun(runId, { maxIterations: 5, maxDurationMinutes: 60 });
      }
      return realGit(...call);
    });

    const resolution = await land.resolveConflicts(runId);
    await settledResolution(runId);

    assert.ok(pickUp, "the fixture never picked the run up, so this proves nothing");
    assert.equal(
      pickUp.ok,
      false,
      "picked up into the checkout a resolution was opening its merge in",
    );
    assert.match(pickUp.ok ? "" : pickUp.reason, /resolving a conflict/);
    assert.equal(getRun(runId)!.status, "stopped");
    // The resolution went ahead, and with no child to run it rolled back.
    assert.equal(resolution.ok, true, resolution.ok ? "" : resolution.reason);
    assert.equal(fixtureGit(repo, ["rev-parse", branch]), tipBefore);
  });

  it("a resolution pressed while Purge is under way is refused, and Purge finishes", async (t) => {
    const { runId, repo, slot, branch } = conflictingRunInSlot("purge-race", "completed");

    const realGit = gitModule.git;
    let pressed = false;
    let resolution = null as Outcome | null;
    t.mock.method(gitModule, "git", async (...call: Parameters<typeof realGit>) => {
      const [cwd, args] = call;
      // Resolve, pressed once Purge has passed its refusal and is counting the
      // commits it is about to destroy — before the checkout is removed, which
      // is the checkout a resolution would open its merge and spawn its child in.
      if (!pressed && cwd === repo && args[0] === "rev-list" && args[1] === "--count") {
        pressed = true;
        resolution = await land.resolveConflicts(runId);
      }
      return realGit(...call);
    });

    const purged = await land.purgeBranch(runId, branch);
    await settledResolution(runId);

    assert.ok(pressed, "the fixture never pressed Resolve, so this proves nothing");
    assert.ok(resolution);
    assert.equal(resolution.ok, false, "a resolution started on a branch being purged");
    assert.match(resolution.ok ? "" : resolution.reason, /being purged/);
    // Nothing was started, so nothing was billed: a resolution's row is written
    // once its merge is open and its child is on its way.
    const started = db()
      .prepare("SELECT COUNT(*) AS n FROM run_reviews WHERE run_id = ?")
      .get(runId) as { n: number };
    assert.equal(started.n, 0, "a resolution was started in the checkout Purge removes");
    // And the Purge did all of what it was pressed for.
    assert.equal(purged.ok, true, purged.ok ? "" : purged.reason);
    assert.equal(fs.existsSync(slot), false, "the checkout was left behind");
    assert.throws(() => fixtureGit(repo, ["rev-parse", "--verify", `refs/heads/${branch}`]));
  });
});

/**
 * Two finished links of one `continueBranch` chain in one slot, which is what
 * `planWorkspace` leaves: the second inherited the first's checkout and carries
 * its branch on, so both rows name the same `worktree_path` and
 * `worktree_branch`, and that branch conflicts with `main` as
 * `conflictingRunInSlot`'s does.
 */
function conflictingChainInSlot(name: string) {
  const { runId: first, repo, slot, branch } = conflictingRunInSlot(name, "completed");
  fs.writeFileSync(path.join(slot, "second.txt"), "the second link's work\n");
  fixtureGit(slot, ["add", "-A"]);
  fixtureGit(slot, ["commit", "-q", "-m", "second link"]);
  const second = `${first}-next`;
  db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                         created_at, finished_at, work_dir, isolation, repo_root, worktree_path,
                         worktree_branch, worktree_base, worktree_base_branch, continues_run)
       SELECT ?, folder, prompt, status, budget, max_iterations, iterations, created_at + 1,
              finished_at, work_dir, isolation, repo_root, worktree_path, worktree_branch,
              worktree_base, worktree_base_branch, id
         FROM runs WHERE id = ?`,
    )
    .run(second, first);
  return { first, second, repo, slot, branch };
}

/**
 * A resolution as it stands while its agent works: its row `running`, and its
 * merge open in the slot with `README.md` unmerged. Returns the undo, which
 * settles the row so no later case reads it as running.
 */
function resolutionWorking(runId: string, slot: string): () => void {
  const id = `resolve-${runId}`;
  db()
    .prepare(
      "INSERT INTO run_reviews (id, run_id, created_at, status, kind) VALUES (?, ?, ?, 'running', 'resolve')",
    )
    .run(id, runId, Date.now());
  assert.throws(
    () => fixtureGit(slot, ["merge", "--no-edit", "main"]),
    "the fixture merge did not conflict",
  );
  return () => {
    db().prepare("UPDATE run_reviews SET status = 'failed' WHERE id = ?").run(id);
  };
}

/**
 * The same doors asked from the other link of a chain.
 *
 * What the claim and the `run_reviews` row protect is a checkout and a branch,
 * and a chain's links share both, so a hold read off the pressed run's id alone
 * let the other link's card Purge the slot from under a billed agent, Pick up a
 * work cycle into a merge with `UU` files open, and tell the operator to
 * `git merge --abort` a live resolution. Both directions, because the merge
 * queue resolves on whichever link it was handed — an earlier one included —
 * while Resolve on a card resolves on that card's run.
 */
describe("the other link of a chain while one link holds the checkout they share", () => {
  for (const [holding, asking] of [
    ["second", "first"],
    ["first", "second"],
  ] as const) {
    it(`refuses the ${asking} link's Commit, Pick up and Purge while the ${holding} link resolves`, async () => {
      const chain = conflictingChainInSlot(`chain-resolve-${holding}`);
      const door = chain[asking];
      const settle = resolutionWorking(chain[holding], chain.slot);
      try {
        // What the land route answers as `branchResolving`, which is what stops
        // the other link's card drawing Purge and Resolve at all.
        assert.equal(land.resolutionHolds(getRun(door)!), true);

        // Untracked, so the only thing between it and `add -A` is the hold.
        fs.writeFileSync(path.join(chain.slot, "notes.txt"), "the run's last notes\n");
        const committed = await land.commitPending(door, "Keep the run's notes");
        assert.equal(committed.ok, false, "committed the open merge of a live resolution");
        assert.match(committed.ok ? "" : committed.reason, /resolving a conflict/);
        assert.doesNotMatch(
          committed.ok ? "" : committed.reason,
          /git merge --abort/,
          "told the operator to abort a resolution that is still running",
        );

        const picked = reopenRun(door, { maxIterations: 5, maxDurationMinutes: 60 });
        assert.equal(picked.ok, false, "picked up into a checkout with a merge open in it");
        assert.match(picked.ok ? "" : picked.reason, /resolving a conflict/);
        assert.equal(getRun(door)!.status, "completed");

        const purged = await land.purgeBranch(door, chain.branch);
        assert.equal(purged.ok, false, "purged the checkout a resolution is editing");
        assert.match(purged.ok ? "" : purged.reason, /resolving a conflict/);
        assert.ok(fs.existsSync(chain.slot), "the slot went from under the resolution");
        assert.ok(fixtureGit(chain.slot, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]));
        assert.ok(fixtureGit(chain.repo, ["rev-parse", "--verify", `refs/heads/${chain.branch}`]));
      } finally {
        settle();
      }
    });

    it(`refuses the ${asking} link's Pick up and Resolve while the ${holding} link commits`, async (t) => {
      const chain = conflictingChainInSlot(`chain-commit-${holding}`);
      const door = chain[asking];
      fs.writeFileSync(path.join(chain.slot, "notes.txt"), "the run's last notes\n");

      const realGit = gitModule.git;
      let picked = null as ReturnType<typeof reopenRun> | null;
      let resolution = null as Promise<Outcome> | null;
      t.mock.method(gitModule, "git", async (...call: Parameters<typeof realGit>) => {
        const [cwd, args] = call;
        // Both pressed on the other card while the Commit's `add -A` is on its
        // way to git, which is the stretch only the claim answers for.
        if (picked === null && cwd === chain.slot && args[0] === "add" && args[1] === "-A") {
          picked = reopenRun(door, { maxIterations: 5, maxDurationMinutes: 60 });
          resolution = land.resolveConflicts(door);
        }
        return realGit(...call);
      });

      const committed = await land.commitPending(chain[holding], "Keep the run's notes");
      const resolved = await resolution;
      await settledResolution(door);

      assert.ok(picked && resolved, "the fixture never pressed the other card, so this proves nothing");
      assert.equal(picked.ok, false, "picked up into a checkout a Commit is writing");
      assert.match(picked.ok ? "" : picked.reason, /being committed/);
      assert.equal(getRun(door)!.status, "completed");
      assert.equal(resolved.ok, false, "a resolution opened its merge under a commit");
      assert.match(resolved.ok ? "" : resolved.reason, /commit is being made/);
      assert.equal(committed.ok, true, committed.ok ? "" : committed.reason);
      assert.doesNotMatch(
        fixtureGit(chain.repo, ["show", `${chain.branch}:README.md`]),
        /^<<<<<<< /m,
        "the conflict markers reached the branch",
      );
    });
  }
});
