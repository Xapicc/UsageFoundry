import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type Database from "better-sqlite3";

/**
 * That the worker always answers the row it took, and only that.
 *
 * `setStatus` is reachable from `drainRepo` and from nowhere else: `cancelBatch`
 * and `cancelQueuedFor` touch `queued` rows alone, and `reconcileMergeQueueOnBoot`
 * needs a restart. So this loop is the only thing in the process that can move a
 * row off `landing` or `resolving`, and a throw escaping it stranded that row
 * for the life of the container — while `queuedRunIds` went on counting the run
 * as queued, so `enqueue` refused it by name and the operator's only retry was
 * the manual Land button, which worked, on a branch whose queue row still said
 * `landing`. Nothing crashes: Next's own `unhandledRejection` handler logs the
 * rejection and the server keeps serving the frozen panel.
 *
 * It earns a database and a real repository for the reason the parked sweeper's
 * writes do — no pure function reaches the transition, and a second copy of the
 * loop in a test would be the copy that stayed right.
 *
 * The failure is provoked where it does the most damage and where it is a real
 * shape rather than an invented one: a database error on the `land` event
 * `landRun` emits **after** it has merged into the operator's checkout and
 * written `runs.landed_at` (`land.ts:965`). The merge is on disk and has
 * succeeded; only this app's own bookkeeping broke. That is what the row has to
 * be honest about, and it is why the answer is `failed` with "it is not known
 * whether the merge went through" rather than a retry. The trigger stands in for
 * the reachable causes — `SQLITE_BUSY` or `IOERR` on any of the four statements
 * that path runs, and, before `git()` was made total, an `EMFILE` rejection out
 * of any of a dozen git children.
 *
 * Its own file for `mergeQueueOrder.test.ts`'s reason: `config.ts` reads
 * `DATA_DIR` at module load, so a file that imports `./mergeQueue` statically
 * would bind the path to the repository's own `.data` directory, which on a
 * developer's machine is the real one.
 */

let mergeQueue: typeof import("./mergeQueue");
let land: typeof import("./land");
let dbMod: typeof import("./db");
let orchestrator: typeof import("./orchestrator");
let workflows: typeof import("./workflows");
let root: string;
let repo: string;
/** A second repository, so a second worker can be mid-land beside the first. */
let otherRepo: string;
/**
 * Where a case holds the app's own git at one subcommand. A file named `merge`
 * or `status` here makes that call write `<name>.started` and wait for
 * `<name>.release` before it runs.
 */
let holds: string;

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
  // `realpathSync` around the temp root, which eight sibling test files already
  // do and this one did not. On macOS `os.tmpdir()` is `/var/folders/…`, a
  // symlink to `/private/var/folders/…`, and `resolveInMount` checks
  // containment on the resolved path *and again* after `realpathSync` —
  // `security.md` says both are load-bearing. So a mount registered at the
  // unresolved path refuses its own checkout, and all three tests in this file
  // failed off Linux with "This run's repository is no longer inside a
  // workspace mount." A fixture bug, not a landing bug: the assertion it broke
  // is the one proving a clean branch lands.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-merge-drain-")));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  // Nothing here resolves a conflict, so nothing here should reach a spawn. A
  // `claude` that does not exist makes a regression that gets that far a failed
  // test rather than a billed one.
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");
  process.env.WORKSPACE_ROOTS = path.join(root, "ws");
  fs.mkdirSync(path.join(root, "ws"), { recursive: true });

  // The app's git, able to be held at one step long enough for a shutdown to
  // begin inside it, and a pass-through for every call no case holds. The real
  // binary by absolute path, because `gitEnv()` decides what the child's PATH
  // is. The wait gives up after twenty seconds so a failed case cannot keep the
  // runner alive behind a child nobody will release.
  holds = path.join(root, "holds");
  fs.mkdirSync(holds);
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const gitStub = path.join(root, "git");
  fs.writeFileSync(
    gitStub,
    [
      "#!/bin/sh",
      'for arg in "$@"; do',
      '  case "$arg" in',
      "    merge|status)",
      `      if [ -e '${holds}'/"$arg" ]; then`,
      `        : > '${holds}'/"$arg".started`,
      "        i=0",
      `        while [ ! -e '${holds}'/"$arg".release ] && [ $i -lt 200 ]; do`,
      "          sleep 0.1; i=$((i + 1))",
      "        done",
      "      fi",
      "      break ;;",
      "  esac",
      "done",
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

  repo = path.join(root, "ws", "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");

  otherRepo = path.join(root, "ws", "other");
  fs.mkdirSync(otherRepo);
  git(otherRepo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(otherRepo, "a.txt"), "one\n");
  git(otherRepo, "add", "-A");
  git(otherRepo, "commit", "-q", "-m", "first");

  mergeQueue = await import("./mergeQueue");
  land = await import("./land");
  dbMod = await import("./db");
  orchestrator = await import("./orchestrator");
  workflows = await import("./workflows");
});

after(() => {
  const open = (globalThis as { __ufDb?: Database.Database }).__ufDb;
  open?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Break the `land` event `landRun` emits once the merge is already committed.
 *
 * Narrow on purpose: everything up to and including the merge is real, and what
 * fails is one statement inside `emit()`, which is the shape a `SQLITE_BUSY`
 * takes. Returns the undo.
 */
function breakLandEvent(): () => void {
  dbMod
    .db()
    .prepare(
      `CREATE TRIGGER uf_test_break_land BEFORE INSERT ON run_events
         WHEN NEW.kind = 'land'
         BEGIN SELECT RAISE(ABORT, 'the disk went away'); END`,
    )
    .run();
  return () => {
    dbMod.db().prepare("DROP TRIGGER uf_test_break_land").run();
  };
}

/** A completed isolated run whose branch is one commit ahead of `from`, `main` unless told. */
function makeRun(id: string, file: string, repoRoot = repo, from = "main"): string {
  const branch = `uf/repo-${id}`;
  git(repoRoot, "checkout", "-q", "-b", branch, from);
  fs.writeFileSync(path.join(repoRoot, file), `${file}\n`);
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-q", "-m", `work ${id}`);
  const base = git(repoRoot, "rev-parse", "main").trim();
  git(repoRoot, "checkout", "-q", "main");

  dbMod
    .db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                         created_at, isolation, repo_root, worktree_branch, worktree_base,
                         worktree_base_branch)
       VALUES (?, ?, 'task', 'completed', '{}', 1, 1, ?, 'worktree', ?, ?, ?, 'main')`,
    )
    .run(id, repoRoot, Date.now(), repoRoot, branch, base);
  return branch;
}

/** Wait for the worker to owe the batch nothing, or give up and report. */
async function settle(batchId: string, ms = 30_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const rows = mergeQueue.batchRows(batchId);
    if (rows.length > 0 && !rows.some((r) => mergeQueue.isQueueActive(r.status))) {
      return rows;
    }
    if (Date.now() > deadline) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("the merge worker", () => {
  it("lands a clean branch and says so on the row", async () => {
    makeRun("aaaaaaaa", "b.txt");
    const queued = mergeQueue.enqueue(["aaaaaaaa"], {
      strategy: "merge",
      autoResolve: false,
    });
    assert.ok(queued.ok, JSON.stringify(queued));

    const rows = await settle(queued.batchId);
    assert.equal(rows[0].status, "landed", rows[0].message ?? "");
  });

  it("answers the row it was on when this server itself breaks", async () => {
    makeRun("bbbbbbbb", "c.txt");
    makeRun("cccccccc", "d.txt");
    const undo = breakLandEvent();

    try {
      const queued = mergeQueue.enqueue(["bbbbbbbb", "cccccccc"], {
        strategy: "merge",
        autoResolve: false,
      });
      assert.ok(queued.ok, JSON.stringify(queued));

      const rows = await settle(queued.batchId, 10_000);

      // The row it was holding. `landing` here is the whole defect: nothing in
      // the process can move it afterwards, `enqueue` refuses the run by name
      // for as long as it stands, and the panel shows it in flight for ever.
      assert.equal(rows[0].status, "failed", `left on ${rows[0].status}`);
      assert.match(rows[0].message ?? "", /not known whether the merge went through/);

      // And the branch behind it, which must not be left waiting on a loop that
      // has gone. `skipped` for the same reason a dirty checkout skips the rest:
      // this fault will meet it identically, and each attempt is another merge
      // into a directory a person owns.
      assert.equal(rows[1].status, "skipped", `left on ${rows[1].status}`);
    } finally {
      undo();
    }
  });

  it("takes the next branch after that, rather than waiting for a restart", async () => {
    // A drain that answered a broken row still reaches its own tail and hands
    // the queue on. Before the row-level catch the throw went past the loop
    // entirely, so the `startWorker()` after it never ran and every repository
    // the `MAX_MERGE_WORKERS` cap was holding back waited for the next enqueue
    // — which, for the runs in the stranded rows, `enqueue` refused by name.
    makeRun("dddddddd", "e.txt");
    const queued = mergeQueue.enqueue(["dddddddd"], {
      strategy: "merge",
      autoResolve: false,
    });
    assert.ok(queued.ok, JSON.stringify(queued));

    const rows = await settle(queued.batchId);
    assert.equal(rows[0].status, "landed", rows[0].message ?? "");
  });

  it("records a branch already on its target at its turn as already landed, not failed", async () => {
    // The second row's commit is under the first row's branch, so landing the
    // first puts the second on `main` before its turn: the shape of a chain
    // link whose successor landed first, or of a branch merged by hand. It was
    // failed, and a workflow merge block over the batch failed with it.
    const inner = makeRun("hhhhhhhh", "i.txt");
    makeRun("iiiiiiii", "j.txt", repo, inner);
    const queued = mergeQueue.enqueue(["iiiiiiii", "hhhhhhhh"], {
      strategy: "merge",
      autoResolve: false,
    });
    assert.ok(queued.ok, JSON.stringify(queued));

    const rows = await settle(queued.batchId);
    assert.equal(rows[0].status, "landed", rows[0].message ?? "");
    assert.equal(rows[1].status, "already-landed", rows[1].message ?? "");
    assert.match(rows[1].message ?? "", /Already in main/);

    // Read back the way the merge block reads its own batch.
    const outcomes = rows.map((row) => workflows.queuedBranchOutcome(row, row.run_id));
    assert.deepEqual(
      outcomes.filter((o) => o.result === "failed"),
      [],
      "a merge block over this batch records a failed landing",
    );
    assert.equal(workflows.mergeBlockOutcome(outcomes).ok, true);
  });
});

/**
 * A restart that cut off a conflict resolution in the run's own checkout.
 *
 * `after` is the only thing that closes a resolution's merge, and it died with
 * the process, so the slot came back mid-merge: `MERGE_HEAD` present and the
 * conflicted file `UU` with its markers in it. Both boot reconcilers rewrote
 * rows and nothing else, the Land card listed the marked file under
 * "Uncommitted in the checkout", and Commit followed by Land (each passing
 * every check it had) put the markers on `main` as a fast-forward. Executed
 * end to end before the fix, which is why this is one case through the app's
 * own doors rather than three assertions about their refusals.
 *
 * The stranded state is built by hand rather than by killing a resolution:
 * what a restart leaves is a queue row saying `resolving` and a checkout
 * mid-merge, and nothing about how the process died is visible to the boot.
 */
describe("the boot after a resolution was cut off", () => {
  it("closes its merge in the run's checkout, and nothing lands the markers", async () => {
    const runId = "kkkkkkkk";
    const branch = `uf/repo-${runId}`;
    const base = git(repo, "rev-parse", "main").trim();
    git(repo, "checkout", "-q", "-b", branch);
    fs.writeFileSync(path.join(repo, "a.txt"), "branch side\n");
    git(repo, "commit", "-q", "-am", "branch side");
    git(repo, "checkout", "-q", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "main side\n");
    git(repo, "commit", "-q", "-am", "main side");
    const mainBefore = git(repo, "rev-parse", "main").trim();
    const branchBefore = git(repo, "rev-parse", branch).trim();

    // The run's own slot, where `resolveCheckout` merges when the slot still
    // holds the branch, left exactly as the merge left it.
    const store = orchestrator.worktreeStore(repo);
    assert.ok(store, "the fixture repository is not inside a mount");
    fs.mkdirSync(store, { recursive: true });
    const slot = path.join(store, `repo-${runId}`);
    git(repo, "worktree", "add", "-q", slot, branch);
    assert.throws(() => git(slot, "merge", "--no-edit", "main"), "the fixture merge did not conflict");
    assert.match(git(slot, "status", "--porcelain"), /^UU a\.txt/m);

    dbMod
      .db()
      .prepare(
        `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                           created_at, isolation, repo_root, worktree_branch, worktree_base,
                           worktree_base_branch, worktree_path)
         VALUES (?, ?, 'task', 'completed', '{}', 1, 1, ?, 'worktree', ?, ?, ?, 'main', ?)`,
      )
      .run(runId, repo, Date.now(), repo, branch, base, slot);
    dbMod
      .db()
      .prepare(
        `INSERT INTO merge_queue (id, batch_id, run_id, position, strategy, auto_resolve,
                                  status, created_at, started_at)
         VALUES ('stranded-row', 'stranded-batch', ?, 0, 'merge', 1, 'resolving', ?, ?)`,
      )
      .run(runId, Date.now(), Date.now());

    await mergeQueue.reconcileMergeQueueOnBoot();

    const [row] = mergeQueue.batchRows("stranded-batch");
    assert.equal(row.status, "failed", `left on ${row.status}`);
    // The half this case is for: without it, the markers wait in the slot for
    // the next press of Commit.
    assert.throws(
      () => git(slot, "rev-parse", "-q", "--verify", "MERGE_HEAD"),
      "the boot left the resolution's merge open in the run's checkout",
    );
    assert.equal(fs.readFileSync(path.join(slot, "a.txt"), "utf8"), "branch side\n");
    assert.equal(git(slot, "status", "--porcelain"), "");
    assert.equal(git(repo, "rev-parse", branch).trim(), branchBefore);

    // And every door the card offers after it: nothing to commit, and a land
    // that is still the conflict it was.
    const committed = await land.commitPending(runId);
    assert.equal(committed.ok, false, "Commit made a commit out of the resolution's leftovers");
    const landed = await land.landRun(runId, "merge");
    assert.equal(landed.ok, false, "the branch landed as if the conflict were resolved");

    assert.equal(git(repo, "rev-parse", "main").trim(), mainBefore);
    assert.doesNotMatch(git(repo, "show", "main:a.txt"), /^(<<<<<<<|>>>>>>>)/m);
    assert.doesNotMatch(git(repo, "show", `${branch}:a.txt`), /^(<<<<<<<|>>>>>>>)/m);
    // The operator's checkout was never the one the boot touched.
    assert.equal(git(repo, "symbolic-ref", "--short", "HEAD").trim(), "main");
    assert.equal(git(repo, "status", "--porcelain"), "");
  });
});

/** Hold the app's git at `step` from its next call on; resolves once one is held. */
async function holdAt(step: "merge" | "status"): Promise<void> {
  fs.writeFileSync(path.join(holds, step), "");
  const started = path.join(holds, `${step}.started`);
  for (let i = 0; i < 500 && !fs.existsSync(started); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(fs.existsSync(started), `no git ${step} was reached`);
}

function release(...steps: ("merge" | "status")[]): void {
  for (const step of steps) fs.writeFileSync(path.join(holds, `${step}.release`), "");
}

/**
 * A SIGTERM that arrives while two workers are part-way through a land.
 *
 * Nothing waited for either. `shutdownRuns` waited for work cycles and for the
 * children in `trackAssistChild`'s set, and a land is neither: its `git merge`
 * is a plain `git()` child. So the process exited with the merge running under
 * it, which under Docker takes it down with PID 1 part-way, and the next boot
 * failed both rows with "The server restarted while this was landing".
 *
 * Held with release files rather than timed with sleeps, so the shutdown is
 * certain to begin inside both. Last in the file because `shutdownRuns` sets a
 * flag nothing clears, and every case after it would run in a process that is
 * going down.
 */
describe("the merge worker at a shutdown", () => {
  it("finishes the merge it is in, refuses the one it has not begun, and takes no other", async () => {
    makeRun("eeeeeeee", "f.txt");
    makeRun("ffffffff", "g.txt");
    makeRun("gggggggg", "h.txt", otherRepo);
    const otherHead = git(otherRepo, "rev-parse", "HEAD").trim();

    try {
      // Mid-merge in one repository: the first branch's `git merge` is running.
      const merging = mergeQueue.enqueue(["eeeeeeee", "ffffffff"], {
        strategy: "merge",
        autoResolve: false,
      });
      assert.ok(merging.ok, JSON.stringify(merging));
      await holdAt("merge");

      // Taken but not yet merging in the other: its row is `landing` while
      // `landState` reads the operator's checkout.
      const reading = mergeQueue.enqueue(["gggggggg"], {
        strategy: "merge",
        autoResolve: false,
      });
      assert.ok(reading.ok, JSON.stringify(reading));
      await holdAt("status");

      let returned = false;
      const shutdown = orchestrator.shutdownRuns("SIGTERM").finally(() => {
        returned = true;
      });
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(returned, false, "the shutdown returned with a merge still running");

      // The merge first and the read well after it, so a wait that held only
      // `landRun` returns here with the other row still `landing`.
      release("merge");
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(returned, false, "the shutdown returned with a row it had taken still unanswered");

      release("status");
      await shutdown;

      // Read the moment it returns, which is when the server exits.
      const [landed, behind] = mergeQueue.batchRows(merging.batchId);
      assert.equal(landed.status, "landed", `left on ${landed.status}: ${landed.message ?? ""}`);
      // The drain does not reach for the next branch on the way out: that row
      // is the boot's to cancel, and a merge begun now is one the exit could
      // cut off.
      assert.equal(behind.status, "queued", `left on ${behind.status}`);

      // And the row whose merge had not begun is refused at `landRun`'s door
      // rather than merged during the grace, with the operator's checkout as
      // it was.
      const [refused] = mergeQueue.batchRows(reading.batchId);
      assert.equal(refused.status, "failed", `left on ${refused.status}: ${refused.message ?? ""}`);
      assert.match(refused.message ?? "", /shutting down, so nothing was merged/);
      assert.equal(git(otherRepo, "rev-parse", "HEAD").trim(), otherHead);
    } finally {
      release("merge", "status");
    }
  });
});
