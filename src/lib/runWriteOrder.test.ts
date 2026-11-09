import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { CreateRunInput, RunRow } from "./orchestrator";

/**
 * Runs that share a millisecond, read back in the order they were written.
 *
 * A fan-out, a workflow press and an orchestrator block's emission each call
 * `createRun` in one synchronous pass, `created_at` is a millisecond clock, and
 * `id` is a random UUID. Reads that sorted on `created_at` and then on `id`, or
 * on nothing, each gave an answer that looks right: a batch listed in UUID
 * order, a queue band in an order the walk does not start it in, a queue
 * position counting every run of the batch as ahead of every other, and a
 * chain's branch credited to its first link rather than its newest.
 *
 * The clock is held rather than hoped for. In this container 200 `createRun`s
 * in a loop took 409 ms and none shared a stamp (measured 2026-11-08), so the
 * tie needs a faster host or a coarser clock, and only a held one makes a test
 * of it certain. Batches of eight make a pass by chance 1 in 40,320 where the
 * wrong order is a UUID's.
 *
 * Its own file with `DATA_DIR` named before the first import, for
 * `runOrigin.test.ts`'s reason: `config.ts` is read at module load.
 */

const AUTHOR = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
const realNow = Date.now;

let root: string;
let workspace: string;
let repo: string;
let orch: typeof import("./orchestrator");
let land: typeof import("./land");
let projects: typeof import("./projects");
let retention: typeof import("./retention");
let dbMod: typeof import("./db");
let fleet: typeof import("./fleet");

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, env: { ...process.env, ...AUTHOR } });
}

before(async () => {
  // An agent's shell carries `GIT_CONFIG_*` overrides that outrank the
  // fixture repository's own config, and the app's git children inherit them.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("GIT_")) delete process.env[key];
  }
  // Real path, because `repo_root` is git's spelling of the repository and the
  // project read compares it with the mount's.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-write-order-")));
  workspace = path.join(root, "workspace");
  repo = path.join(workspace, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "first"]);

  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = workspace;
  process.env.WORKSPACE_ROOTS = `Scratch=${workspace}`;
  // Nothing here should reach a spawn; a `claude` that does not exist makes a
  // regression that gets that far a failed test rather than a billed one.
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );

  orch = await import("./orchestrator");
  land = await import("./land");
  projects = await import("./projects");
  retention = await import("./retention");
  dbMod = await import("./db");
  fleet = await import("./fleet");
  const settings = await import("./settings");
  settings.saveSettings({ planUsageFromApi: false, checkoutRetentionDays: 7 });
  // Every case reads the queue as it was written, and a run that started would
  // leave it.
  settings.setNewWorkPaused(true);
});

after(async () => {
  Date.now = realNow;
  // `createRun` ends in `promoteQueued`; given a tick, and the handle left open,
  // for `runOrigin.test.ts`'s reason.
  await new Promise((resolve) => setTimeout(resolve, 50));
  delete process.env.WORKSPACE_ROOTS;
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  for (const table of ["run_deps", "runs"]) {
    dbMod.db().prepare(`DELETE FROM ${table}`).run();
  }
  git(repo, ["checkout", "-q", "main"]);
});

/** `write` with `Date.now` held at one instant, which is what a fast pass is. */
function inOneMillisecond<T>(write: () => T): T {
  const at = realNow();
  Date.now = () => at;
  try {
    return write();
  } finally {
    Date.now = realNow;
  }
}

function create(
  folder: string,
  prompt: string,
  extra: Partial<CreateRunInput> = {},
): RunRow {
  fs.mkdirSync(path.join(workspace, folder), { recursive: true });
  return orch.createRun({
    folder,
    mountId: "scratch",
    prompt,
    budget: { maxIterations: 1 },
    origin: "workflow",
    isolate: false,
    ...extra,
  });
}

function stampsOf(ids: readonly string[]): number {
  return new Set(ids.map((id) => orch.getRun(id)!.created_at)).size;
}

describe("runs written in one millisecond keep their write order", () => {
  it("lists a batch on the runs page newest-written first", () => {
    const ids = inOneMillisecond(() =>
      Array.from({ length: 8 }, (_, i) => create("newest", `newest ${i}`).id),
    );
    assert.equal(stampsOf(ids), 1, "the batch has to share one created_at");

    const page = orch.listRunsPage({});
    assert.deepEqual(
      page.rows.map((r) => r.id),
      [...ids].reverse(),
    );
  });

  it("lists the queue band in the order the walk starts it", () => {
    // One folder each, so every queued run can start, and two of them waiting
    // on the first, as a workflow's later members do: the band lists `waiting`
    // beside `queued`, and `idx_runs_status` hands the two back one status at
    // a time, so a band with no tiebreak puts every waiting run last.
    const ids = inOneMillisecond(() => {
      const written: string[] = [];
      for (let i = 0; i < 8; i++) {
        const dependsOn =
          i === 3 || i === 6 ? [{ runId: written[0], edge: "on-success" as const }] : [];
        written.push(create(`band-${i}`, `band ${i}`, { dependsOn }).id);
      }
      return written;
    });
    assert.equal(stampsOf(ids), 1, "the batch has to share one created_at");

    const band = orch.listRunsPage({ statuses: ["queued", "waiting"], order: "queue" }).rows;
    assert.deepEqual(
      band.map((r) => r.status),
      ["queued", "queued", "queued", "waiting", "queued", "queued", "waiting", "queued"],
    );
    assert.deepEqual(
      band.map((r) => r.id),
      ids,
    );

    const { promote } = orch.walkQueue(orch.activeRuns(), null);
    assert.deepEqual(
      promote,
      band.filter((r) => r.status === "queued").map((r) => r.id),
    );
  });

  it("puts only the runs written before it ahead of it in a shared folder", () => {
    const ids = inOneMillisecond(() =>
      Array.from({ length: 8 }, (_, i) => create("shared", `shared ${i}`).id),
    );
    assert.equal(stampsOf(ids), 1, "the batch has to share one created_at");

    // Every one of them read 7 — each counting the other seven as ahead —
    // while the walk started the first written.
    assert.deepEqual(
      ids.map((id) => orch.queuePosition(id)),
      [0, 1, 2, 3, 4, 5, 6, 7],
    );
    assert.deepEqual(orch.walkQueue(orch.activeRuns(), null).promote, [ids[0]]);
  });

  it("names a chain's newest link in the Push refusal on its branch", async () => {
    // Each link settled before the next is written, so the next carries the
    // branch from creation — the state a released chain reaches, in one pass.
    const chain = inOneMillisecond(() => {
      const links = [create("repo", "link 0", { isolate: true })];
      for (let i = 1; i < 5; i++) {
        dbMod
          .db()
          .prepare("UPDATE runs SET status = 'completed', iterations = 1, finished_at = ? WHERE id = ?")
          .run(Date.now(), links[i - 1].id);
        links.push(
          create("repo", `link ${i}`, {
            isolate: true,
            dependsOn: [{ runId: links[i - 1].id, edge: "on-success", continueBranch: true }],
          }),
        );
      }
      return links;
    });
    const ids = chain.map((r) => r.id);
    assert.equal(stampsOf(ids), 1, "the chain has to share one created_at");
    const branch = chain[0].worktree_branch;
    assert.ok(branch, "the first link has to be isolated onto a branch");
    assert.deepEqual(
      ids.map((id) => orch.getRun(id)!.worktree_branch),
      ids.map(() => branch),
    );

    git(repo, ["checkout", "-q", "-b", branch]);
    const project = (await projects.projectInventory()).projects.find((p) => p.path === repo);
    assert.ok(project, "the repository has to be listed as a project");
    assert.equal(project.push.code, "run-branch");
    assert.match(project.push.reason ?? "", new RegExp(`run ${ids[4].slice(0, 8)}'s branch`));
  });

  it("lists a fan-out's branches newest-written first", async () => {
    const ids = inOneMillisecond(() =>
      Array.from({ length: 5 }, (_, i) => create("repo", `fan ${i}`, { isolate: true }).id),
    );
    assert.equal(stampsOf(ids), 1, "the fan-out has to share one created_at");

    const { branches } = await land.branchInventory();
    assert.deepEqual(
      branches.map((b) => b.runId),
      [...ids].reverse(),
    );
  });
});

describe("checkout reclaim reads the newest link of a chain written in one millisecond", () => {
  const DAY = 24 * 60 * 60 * 1000;

  function settle(id: string, finishedAt: number): void {
    dbMod
      .db()
      .prepare("UPDATE runs SET status = 'completed', iterations = 1, finished_at = ? WHERE id = ?")
      .run(finishedAt, id);
  }

  /**
   * Links that each continue the one before, written in one pass with every
   * predecessor settled first — the state a released chain reaches — and then
   * the checkout they share, made real on disk. `finishedDaysAgo[i]` is when link
   * `i` ended, and the last link is left unsettled for the case to place.
   */
  function chainOnDisk(
    finishedDaysAgo: readonly number[],
    now: number,
  ): { chain: RunRow[]; slot: string; branch: string } {
    const chain = inOneMillisecond(() => {
      const links = [create("repo", "link 0", { isolate: true })];
      for (let i = 1; i <= finishedDaysAgo.length; i++) {
        settle(links[i - 1].id, now - finishedDaysAgo[i - 1] * DAY);
        links.push(
          create("repo", `link ${i}`, {
            isolate: true,
            dependsOn: [{ runId: links[i - 1].id, edge: "on-success", continueBranch: true }],
          }),
        );
      }
      return links;
    });
    assert.equal(stampsOf(chain.map((r) => r.id)), 1, "the chain has to share one created_at");
    const slot = chain[0].worktree_path;
    const branch = chain[0].worktree_branch;
    assert.ok(slot && branch, "the first link has to be isolated onto a slot and a branch");
    for (const link of chain) {
      assert.equal(orch.getRun(link.id)!.worktree_path, slot);
    }
    git(repo, ["worktree", "add", "-q", "-b", branch, slot]);
    return { chain, slot, branch };
  }

  function dropCheckout(slot: string, branch: string): void {
    if (fs.existsSync(slot)) git(repo, ["worktree", "remove", "--force", slot]);
    git(repo, ["branch", "-D", branch]);
  }

  it("counts a settled chain's age from its last link, not its first", async () => {
    const now = realNow();
    // The first link ended past the week and the last inside it. Read off the
    // first, the slot looked ten days idle and went, three days short of the
    // horizon counted from where the chain actually stopped.
    const { chain, slot, branch } = chainOnDisk([10, 8, 6], now);
    try {
      settle(chain[3].id, now - 2 * DAY);

      const within = await retention.sweepCheckouts(now);
      assert.equal(within.removed, 0);
      assert.equal(fs.existsSync(slot), true, "the checkout went while its last link was two days old");

      // The control: the same slot, with the last link as old as the first, is
      // reclaimed — so the keep above was the last link's age and not something
      // else about the fixture.
      settle(chain[3].id, now - 10 * DAY);
      const past = await retention.sweepCheckouts(now);
      assert.equal(past.removed, 1, "the slot was never a candidate, so the keep above proves nothing");
      assert.equal(fs.existsSync(slot), false);
    } finally {
      dropCheckout(slot, branch);
    }
  });

  it("keeps a slot whose next link is waiting on something else", async () => {
    const now = realNow();
    // `chainedRunIds` names the run a not-yet-started link continues, and a
    // waiting link holds no slot, so that keep can only be carried by the
    // chain's newest link that has one. The first link is continued by a settled
    // run and carries nothing.
    const { chain, slot, branch } = chainOnDisk([10, 10], now);
    try {
      settle(chain[2].id, now - 10 * DAY);
      const blocker = create("other", "still running elsewhere");
      const waiting = create("repo", "link 3", {
        isolate: true,
        dependsOn: [
          { runId: chain[2].id, edge: "on-success", continueBranch: true },
          { runId: blocker.id, edge: "on-success" },
        ],
      });
      assert.equal(waiting.status, "waiting");
      assert.equal(waiting.worktree_path, null, "a waiting link has to hold no slot");

      const during = await retention.sweepCheckouts(now);
      assert.equal(during.removed, 0);
      assert.equal(fs.existsSync(slot), true, "the checkout went from under a link set to carry its branch on");

      // The control: once nothing is set to carry the branch on, it is reclaimed.
      dbMod
        .db()
        .prepare("UPDATE runs SET status = 'stopped', finished_at = ? WHERE id = ?")
        .run(now - 10 * DAY, waiting.id);
      const after = await retention.sweepCheckouts(now);
      assert.equal(after.removed, 1, "the slot was never a candidate, so the keep above proves nothing");
    } finally {
      dropCheckout(slot, branch);
    }
  });
});

describe("a fleet pick-up reopens a batch written in one millisecond in write order", () => {
  it("picks independent runs up oldest-written first, whatever order the page names them", () => {
    // One folder each, so nothing refuses one for another's checkout. Finished
    // having worked a cycle, so each rejoins the queue rather than going back to
    // `waiting`.
    const ids = inOneMillisecond(() =>
      Array.from({ length: 8 }, (_, i) => create(`pickup-${i}`, `pickup ${i}`).id),
    );
    assert.equal(stampsOf(ids), 1, "the batch has to share one created_at");
    dbMod
      .db()
      .prepare(
        `UPDATE runs SET status = 'failed', iterations = 1, session_id = 'session',
           finished_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`,
      )
      .run(realNow(), ...ids);

    // A clock that moves on every read, so `reopened_at` — written by `reopenRun`
    // at the moment a run is picked up — records the order of the picks. The
    // page sends its ids newest first, which is the order the batch is handed in.
    let tick = realNow();
    Date.now = () => ++tick;
    let report: ReturnType<typeof fleet.reopenFleet>;
    try {
      report = fleet.reopenFleet([...ids].reverse(), { maxIterations: 5 });
    } finally {
      Date.now = realNow;
    }
    assert.deepEqual(report.refused, []);

    // `promoteQueued` follows each pick-up, so with a free slot the first run
    // picked up is the one that starts: this order decides which runs a cap lets
    // through, and `queueCompare` can only re-order what is already queued.
    const pickedUp = [...ids].sort(
      (a, b) => orch.getRun(a)!.reopened_at! - orch.getRun(b)!.reopened_at!,
    );
    assert.deepEqual(pickedUp, ids);
  });
});
