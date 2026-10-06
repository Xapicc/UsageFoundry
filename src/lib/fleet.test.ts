import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type Database from "better-sqlite3";

/**
 * The two halves of the install-wide control, and both are database subjects.
 *
 * **The stop** has to take down every live run in one pass, whatever status each
 * is in, and it has to close out the ones that have not started *before* it signals
 * anything — because stopping a run releases its dependents, and a dependent
 * released a moment before the walk reached it would be admitted, promoted and
 * spawned. A run starting *because* the fleet was stopped is the failure this
 * ordering exists to have none of, and nothing about it throws: the operator
 * gets a page saying everything stopped and an agent working underneath it.
 *
 * **The hold** is read by seven separate call sites — `promoteQueued`,
 * `releaseDependents`, `tickSchedules` and `emitBlockRuns`, the sweeper's
 * `sweepPaused` and `releaseStackWaits`, and an orchestrator block's deciding
 * turn — and a fix that misses one is silent in exactly the same way: work
 * starts, or a turn is billed, while a banner says new work is held, or a park
 * the restart would have kept is closed out by it. So there is a case per
 * site, each driving the real entry point rather than the pure decision
 * underneath it, and each proving the *difference* the flag makes — by running
 * the same call with it clear, or beside a row the same restart keeps.
 *
 * Its own file, and `DATA_DIR` set before the first import, for the reason
 * `haltedMembers.test.ts` gives: `config.ts` reads that variable at module load
 * and `orchestrator.ts` pulls it in statically, so a file importing either at
 * the top would already be bound to the repository's own `.data` — which on a
 * developer's machine is the real one.
 */

let root: string;
let workspace: string;
let orch: typeof import("./orchestrator");
let workflows: typeof import("./workflows");
let schedules: typeof import("./schedules");
let settings: typeof import("./settings");
let fleet: typeof import("./fleet");
let dbMod: typeof import("./db");

before(async () => {
  // Resolved, because `probeIsolation` compares a repository's real root with
  // the folder it was handed, and a temp directory behind a symlink (macOS's
  // `/var`) would read as a subdirectory and plan no checkout at all.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-fleet-")));
  workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(root, "claude", "projects"), { recursive: true });
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  // Pinned rather than left to fall back to CLAUDE_HOME: the sweeper's cases
  // reach `planUsage()`, which sends a request when it finds an OAuth token.
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = workspace;
  // Cleared, not overridden: `WORKSPACE_ROOTS` wins whenever it is set and this
  // repository's own `.env` sets it, so a run that reached `createRun` would
  // resolve against the developer's real mounts.
  process.env.WORKSPACE_ROOTS = "";
  // Nothing here should reach a spawn. A `claude` that does not exist is what
  // makes a regression that gets that far a failed test rather than a billed one.
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );

  orch = await import("./orchestrator");
  workflows = await import("./workflows");
  schedules = await import("./schedules");
  settings = await import("./settings");
  fleet = await import("./fleet");
  dbMod = await import("./db");
});

after(() => {
  const open = (globalThis as { __ufDb?: Database.Database }).__ufDb;
  open?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

let seq = 0;

/**
 * One run row, inserted rather than created.
 *
 * `createRun` would drag in a mount, a git probe and — through `promoteQueued` —
 * a real spawn, and what is under test here is which rows a walk selects.
 * Each run gets its own folder so no two of them conflict, which keeps the
 * queue's own promotion out of the assertions.
 */
function run(
  id: string,
  status: string,
  extra: { folder?: string; iterations?: number; budget?: string } = {},
): string {
  const folder = extra.folder ?? path.join(workspace, id);
  fs.mkdirSync(folder, { recursive: true });
  dbMod
    .db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations,
                         iterations, created_at, work_dir)
       VALUES (?, ?, 'do it', ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      id,
      folder,
      status,
      extra.budget ?? '{"maxIterations":1,"permissionMode":"acceptEdits"}',
      extra.iterations ?? 0,
      Date.now() + seq++,
      folder,
    );
  return id;
}

/**
 * A run behind `on`, exactly as `createRun` leaves one with a dependency:
 * `waiting`, with nothing about its workspace decided — which is the shape
 * `reviveBlockedDependents` selects once a release pass has blocked it.
 */
function dependent(
  id: string,
  on: string,
  edge: "on-success" | "on-finish" = "on-success",
): string {
  const folder = path.join(workspace, id);
  fs.mkdirSync(folder, { recursive: true });
  const now = Date.now() + seq++;
  const db = dbMod.db();
  db.prepare(
    `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations,
                       iterations, created_at, work_dir)
     VALUES (?, ?, 'then this', 'waiting', '{"maxIterations":1,"permissionMode":"acceptEdits"}',
             1, 0, ?, NULL)`,
  ).run(id, folder, now);
  db.prepare(
    "INSERT INTO run_deps (run_id, depends_on, edge, continue_branch, created_at)" +
      " VALUES (?, ?, ?, 0, ?)",
  ).run(id, on, edge, now);
  return id;
}

/** A stored budget with work cycles left after the first. */
const ROOMY = '{"maxIterations":5,"permissionMode":"acceptEdits"}';

function statusOf(id: string): string {
  return orch.getRun(id)!.status;
}

/** A workflow row with no instance budget — which is what a schedule refuses. */
function workflow(id: string, name: string): string {
  const now = Date.now();
  dbMod
    .db()
    .prepare(
      `INSERT INTO workflows (id, name, graph, created_at, updated_at)
       VALUES (?, ?, '{"nodes":[],"edges":[]}', ?, ?)`,
    )
    .run(id, name, now, now);
  return id;
}

describe("stopFleet", () => {
  it("takes down every live status in one pass and leaves finished runs alone", () => {
    const running = run("stop-running", "running");
    const queued = run("stop-queued", "queued");
    const paused = run("stop-paused", "paused");
    // The other park, which no timer of its own will ever end: a stop that
    // missed it would leave it waiting on an operator who believes they
    // stopped everything.
    const forStack = run("stop-stack", "waiting-for-stack");
    const waiting = run("stop-waiting", "waiting");
    // The silent half: a `completed` row rewritten as stopped destroys the
    // record of work that landed, and nothing afterwards says it happened.
    const completed = run("stop-completed", "completed", { iterations: 3 });
    const blocked = run("stop-blocked", "blocked");

    const report = fleet.stopFleet();

    assert.deepEqual(report.blocked, [waiting]);
    // Every one of the four live statuses answers `cancelled` here because no
    // child is registered in this process; what matters is that each was
    // reached, and that none of them was skipped for being the wrong status.
    for (const id of [running, queued, paused, forStack]) {
      assert.ok(
        report.cancelled.includes(id) || report.signalled.includes(id),
        `${statusOf(id)} run was not reached`,
      );
    }
    assert.equal(statusOf(queued), "stopped");
    assert.equal(statusOf(paused), "stopped");
    assert.equal(statusOf(forStack), "stopped");
    assert.equal(statusOf(waiting), "stopped");
    assert.match(orch.getRun(waiting)!.stop_reason ?? "", /every run in flight/);

    // Untouched, and still saying what they said.
    assert.equal(statusOf(completed), "completed");
    assert.equal(orch.getRun(completed)!.iterations, 3);
    assert.equal(statusOf(blocked), "blocked");
    for (const id of [completed, blocked]) {
      assert.equal(report.cancelled.includes(id), false);
      assert.equal(report.blocked.includes(id), false);
    }
  });

  it("closes a waiting run out before stopping the run it waits on", () => {
    // The ordering rule. `stopRun` on a queued row releases its dependents and
    // promotes, so a dependent still `waiting` when its dependency was stopped
    // would be admitted — a run starting because the fleet was stopped.
    const head = run("order-head", "queued");
    const tail = run("order-tail", "waiting");
    dbMod
      .db()
      .prepare(
        "INSERT INTO run_deps (run_id, depends_on, edge, continue_branch, created_at)" +
          " VALUES (?, ?, 'on-finish', 0, ?)",
      )
      .run(tail, head, Date.now());

    const report = fleet.stopFleet();

    assert.equal(
      statusOf(tail),
      "stopped",
      "the dependent must be closed out by the stop, not released by it",
    );
    assert.deepEqual(report.blocked, [tail]);
    assert.match(orch.getRun(tail)!.stop_reason ?? "", /every run in flight/);
    assert.equal(statusOf(head), "stopped");
  });

  it("halts a workflow instance through its own door, with its own cause", () => {
    const member = run("wf-member", "queued");
    const now = Date.now();
    workflow("wf-fleet", "Nightly sweep");
    dbMod
      .db()
      .prepare(
        `INSERT INTO workflow_instances (id, workflow_id, workflow_name, graph, created_at, status)
         VALUES ('inst-fleet', 'wf-fleet', 'Nightly sweep', '{"nodes":[],"edges":[]}', ?, 'started')`,
      )
      .run(now);
    dbMod
      .db()
      .prepare(
        "INSERT INTO workflow_instance_runs (instance_id, node_id, node_name, position, run_id)" +
          " VALUES ('inst-fleet', 'n0', 'Block 0', 0, ?)",
      )
      .run(member);

    const report = fleet.stopFleet();

    assert.equal(report.instances.length, 1);
    assert.equal(report.instances[0].acted, true);
    const instance = dbMod
      .db()
      .prepare("SELECT status, stop_cause FROM workflow_instances WHERE id='inst-fleet'")
      .get() as { status: string; stop_cause: string };
    assert.equal(instance.status, "stopping");
    // A third cause, not `operator`: afterwards it is the only thing telling a
    // workflow somebody stopped from one that went down with everything else.
    assert.equal(instance.stop_cause, "fleet");
    // And back through the reader the pages get, not just the row: a cause
    // `getInstance` drops is a cause the instance page and the workflow page
    // cannot show, and the page then says "by you".
    assert.equal(workflows.getInstance("inst-fleet")?.stopCause, "fleet");
    assert.equal(statusOf(member), "stopped");
    assert.match(orch.getRun(member)!.stop_reason ?? "", /Nightly sweep/);
    // Halted by its instance, so the standalone pass must not claim it too.
    assert.equal(report.cancelled.includes(member), false);
  });

  it("ends a waiting run the way its own Stop would, so picking up the run in front does not wake it", () => {
    // Held, so the pick-ups below queue and nothing is promoted to a spawn.
    settings.setNewWorkPaused(true);
    const head = run("fleet-revive-head", "paused", { iterations: 1 });
    const tail = dependent("fleet-revive-tail", head, "on-finish");
    try {
      fleet.stopFleet();
      const ended = orch.getRun(tail)!;

      // The run in front, picked up by name on its own page. That is a decision
      // about that run, and the one behind it was stopped by the same press.
      assert.deepEqual(orch.reopenRun(head, { maxIterations: 5 }), { ok: true });
      const after = orch.getRun(tail)!;
      assert.equal(
        after.status,
        ended.status,
        "picking up the run in front undid the fleet's stop of the run behind it",
      );
      assert.equal(after.stop_reason, ended.stop_reason);

      // What Stop on its own page writes for a waiting run, which nothing
      // revives — and which the fleet's own pick-up offers, so a fleet stopped
      // and picked up again does not strand the run behind.
      assert.equal(ended.status, "stopped");
      assert.match(ended.stop_reason ?? "", /every run in flight while it was waiting/);
      assert.deepEqual(fleet.reopenFleet([tail], { maxIterations: 5 }).reopened, [tail]);
      assert.equal(statusOf(tail), "waiting", "back behind the run in front");
    } finally {
      // Ended while still held: the next describe clears the hold and promotes.
      orch.stopRun(tail);
      orch.stopRun(head);
      settings.setNewWorkPaused(false);
    }
  });
});

describe("the hold on new work", () => {
  after(() => settings.setNewWorkPaused(false));

  it("stops promoteQueued starting anything", () => {
    const id = run("hold-promote", "queued");

    settings.setNewWorkPaused(true);
    orch.promoteQueued();
    assert.equal(statusOf(id), "queued", "a held queue must not start a run");

    settings.setNewWorkPaused(false);
    orch.promoteQueued();
    // `startRun` claims the row with a guarded UPDATE before its first `await`,
    // so promotion is observable synchronously. The interrupt below is what
    // keeps the continuation from reaching a spawn.
    assert.equal(statusOf(id), "running", "clearing the hold must promote it");
    orch.stopRun(id);
  });

  it("stops releaseDependents admitting a waiting run", () => {
    const head = run("hold-head", "completed", { iterations: 1 });
    const tail = run("hold-tail", "waiting");
    dbMod
      .db()
      .prepare(
        "INSERT INTO run_deps (run_id, depends_on, edge, continue_branch, created_at)" +
          " VALUES (?, ?, 'on-success', 0, ?)",
      )
      .run(tail, head, Date.now());

    settings.setNewWorkPaused(true);
    orch.releaseDependents();
    assert.equal(
      statusOf(tail),
      "waiting",
      "a run whose dependency has succeeded must still wait while the fleet is held",
    );

    settings.setNewWorkPaused(false);
    orch.releaseDependents();
    assert.equal(statusOf(tail), "queued", "clearing the hold must admit it");
    orch.stopRun(tail);
  });

  it("still ends a chain that can never start, held or not", () => {
    // The half the hold must *not* suppress: `blocked` costs nothing and is the
    // true thing to say, and holding it back would leave a dead chain that can
    // only be ended by somebody remembering to clear the pause.
    const head = run("hold-dead-head", "failed");
    const tail = run("hold-dead-tail", "waiting");
    dbMod
      .db()
      .prepare(
        "INSERT INTO run_deps (run_id, depends_on, edge, continue_branch, created_at)" +
          " VALUES (?, ?, 'on-success', 0, ?)",
      )
      .run(tail, head, Date.now());

    settings.setNewWorkPaused(true);
    orch.releaseDependents();
    assert.equal(statusOf(tail), "blocked");
  });

  it("stops emitBlockRuns starting runs nobody is watching", () => {
    const now = Date.now();
    workflow("wf-emit", "Fan out");
    dbMod
      .db()
      .prepare(
        `INSERT INTO workflow_instances (id, workflow_id, workflow_name, graph, created_at, status)
         VALUES ('inst-emit', 'wf-emit', 'Fan out', ?, ?, 'started')`,
      )
      .run(
        JSON.stringify({
          nodes: [
            {
              id: "n0",
              name: "Decide",
              kind: "orchestrator",
              fanOut: 3,
              mountId: null,
              folder: "",
              task: "decide",
            },
          ],
          edges: [],
        }),
        now,
      );
    dbMod
      .db()
      .prepare(
        `INSERT INTO workflow_instance_blocks (instance_id, node_id, node_name, position, kind, status)
         VALUES ('inst-emit', 'n0', 'Decide', 0, 'orchestrator', 'thinking')`,
      )
      .run();

    settings.setNewWorkPaused(true);
    const held = workflows.emitBlockRuns("inst-emit", "n0", "not even a list");
    assert.equal(held.ok, false);
    if (held.ok) return;
    assert.match(held.reason, /held/i, "the turn has to be told why it was refused");

    // Clear the hold and the *same* call is refused for a different reason —
    // which is what says the hold was the thing that refused it, rather than the
    // malformed payload that refuses it either way.
    settings.setNewWorkPaused(false);
    const open = workflows.emitBlockRuns("inst-emit", "n0", "not even a list");
    assert.equal(open.ok, false);
    if (open.ok) return;
    assert.match(open.reason, /list of run specs/);
  });

  it("stops tickSchedules firing", async () => {
    workflow("wf-sched", "Hourly");
    // An occurrence one minute ago, inside `FIRE_GRACE_MS`, so an unheld tick
    // has a window to act on.
    const now = Date.now();
    schedules.putSchedule(
      "wf-sched",
      { kind: "everyHours", hours: 1, anchorAt: now - 60 * 60 * 1000 - 60_000 },
      "UTC",
      now - 60 * 60 * 1000 - 60_000,
    );

    settings.setNewWorkPaused(true);
    await schedules.tickSchedules();
    const held = dbMod
      .db()
      .prepare("SELECT last_code FROM workflow_schedules WHERE workflow_id='wf-sched'")
      .get() as { last_code: string | null };
    assert.equal(held.last_code, null, "a held tick must decide nothing at all");

    // Unheld, the same tick reaches the door and is refused there instead — this
    // workflow sets no instance budget, which `scheduleRefusal` will not allow a
    // schedule to press Run under. Nothing is started either way; what the two
    // answers separate is a tick that never looked from one that did.
    settings.setNewWorkPaused(false);
    await schedules.tickSchedules();
    const open = dbMod
      .db()
      .prepare("SELECT last_code FROM workflow_schedules WHERE workflow_id='wf-sched'")
      .get() as { last_code: string | null };
    assert.equal(open.last_code, "unbudgeted");
  });

  it("survives a restart, because it is a row and not a variable", () => {
    // The usual reason it gets set is the restart it has to survive. It is
    // deliberately not a key of `Settings`, so an unrelated Save cannot clear it.
    settings.setNewWorkPaused(true);
    assert.equal(settings.newWorkPaused(), true);
    settings.saveSettings({ maxConcurrentRuns: 4 });
    assert.equal(
      settings.newWorkPaused(),
      true,
      "an unrelated settings save must not clear the hold",
    );
  });
});

/**
 * A started instance whose one block is an orchestrator with nothing in front of
 * it: ready the moment anything advances it, which is what a press of Run leaves
 * behind for a graph that starts by deciding.
 */
function decidingInstance(id: string): string {
  const graph = JSON.stringify({
    nodes: [
      {
        id: "o",
        name: "Decide",
        kind: "orchestrator",
        templateId: null,
        mountId: "workspace",
        folder: "",
        task: "decide",
        promptOverride: null,
        agentId: null,
        fanOut: 2,
        provider: null,
      },
    ],
    edges: [],
  });
  workflow(`wf-${id}`, `Decide first ${id}`);
  const db = dbMod.db();
  db.prepare(
    `INSERT INTO workflow_instances (id, workflow_id, workflow_name, graph, created_at, status)
     VALUES (?, ?, 'Decide first', ?, ?, 'started')`,
  ).run(id, `wf-${id}`, graph, Date.now());
  db.prepare(
    `INSERT INTO workflow_instance_blocks (instance_id, node_id, node_name, position, kind, status)
     VALUES (?, 'o', 'Decide', 0, 'orchestrator', 'waiting')`,
  ).run(id);
  return id;
}

function decidingBlock(id: string): { status: string; started_at: number | null } {
  return dbMod
    .db()
    .prepare(
      "SELECT status, started_at FROM workflow_instance_blocks WHERE instance_id=? AND node_id='o'",
    )
    .get(id) as { status: string; started_at: number | null };
}

/** Poll until `done` holds, so an asynchronous turn has somewhere to land. */
async function until(done: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting until ${what}`);
}

/**
 * The deciding turn is the seventh site, and the only one whose failure was a
 * bill rather than a start: under the hold the turn spawned, was paid for, and
 * was then told by `emitBlockRuns` that nothing it decided could start. So each
 * case asserts on the claim — `thinking` is the row that precedes every spawn.
 *
 * Each halts its instance on the way out, pass or fail, because
 * `advanceInstances` walks every instance in the file: a block left `waiting`
 * would be claimed by the next case that releases anything. And the assist
 * budget is opted out of for the describe, because a turn holds a slot while it
 * is `thinking` — `emitBlockRuns`' fixture above holds one for good — and a
 * block refused a slot is left `waiting` too, which is the answer the hold's
 * cases assert for a different reason.
 */
describe("the hold on an orchestrator block's deciding turn", () => {
  let assists: number | null;
  before(() => {
    assists = settings.getSettings().maxConcurrentAssists;
    settings.saveSettings({ maxConcurrentAssists: null });
  });
  after(() => {
    settings.setNewWorkPaused(false);
    settings.saveSettings({ maxConcurrentAssists: assists });
  });

  /** Run `body` over a fresh instance, and leave nothing of it to the next case. */
  async function withInstance(id: string, body: (id: string) => Promise<void>): Promise<void> {
    decidingInstance(id);
    try {
      await body(id);
    } finally {
      settings.setNewWorkPaused(false);
      workflows.stopInstance(id, { kind: "operator" });
    }
  }

  it("leaves the block waiting rather than paying for a turn whose emission it would refuse", () =>
    withInstance("hold-decide", async (id) => {
      settings.setNewWorkPaused(true);
      workflows.advanceInstances();
      assert.equal(decidingBlock(id).status, "waiting", "a held install must not claim the turn");
      assert.equal(decidingBlock(id).started_at, null);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(decidingBlock(id).status, "waiting", "nor claim it a turn later");

      // Cleared, the same call claims it. The halt on the way out lands in this
      // same turn of the event loop, before `startBlockTurn`'s first await
      // returns, so the turn it has just fired finds the door closed.
      settings.setNewWorkPaused(false);
      workflows.advanceInstances();
      assert.equal(decidingBlock(id).status, "thinking", "clearing the hold must let it decide");
    }));

  it("decides it once the hold is lifted, with nothing else to wake it", () =>
    withInstance("hold-lift", async (id) => {
      // Lifting is the only event there will be: a fleet held and stopped has
      // no run left whose ending would advance anything.
      settings.setNewWorkPaused(true);
      workflows.advanceInstances();
      assert.equal(decidingBlock(id).status, "waiting");

      fleet.setFleetPaused(false);
      await until(() => decidingBlock(id).status !== "waiting", "the lift claimed the turn");
      assert.notEqual(decidingBlock(id).started_at, null, "the turn was claimed");
      // Let the turn end against the `claude` that is not there, so nothing of
      // it is still running into the next case.
      await until(() => decidingBlock(id).status !== "thinking", "the turn ended");
    }));

  it("hands the block back when the hold is pressed while its turn is being prepared", () =>
    withInstance("hold-mid-turn", async (id) => {
      // The claim's question is asked before `startBlockTurn` awaits the window
      // and the transcript scan, and a hold pressed during those is not in it —
      // `tickSchedules`' reason for asking again after its own snapshot.
      workflows.advanceInstances();
      assert.equal(
        decidingBlock(id).status,
        "thinking",
        "the claim lands before the turn's first await",
      );

      settings.setNewWorkPaused(true);
      await until(() => decidingBlock(id).status !== "thinking", "the turn gave up its claim");
      assert.equal(
        decidingBlock(id).status,
        "waiting",
        "a hold is a shortage rather than a decision, so the block waits for the lift",
      );
      assert.equal(decidingBlock(id).started_at, null);
    }));
});

/**
 * The per-run answer to a control that acts on a set.
 *
 * Both bulk pick-ups take a whole set — every `restart_closed` row, or every
 * terminal run the page is displaying — so a run somebody had deliberately
 * stopped was started again by a press aimed at the twenty-four beside it, and
 * nothing anywhere said it had been. That failure is silent in the worst way
 * available: an agent that edits files starts working in a folder the operator
 * had finished with, under limits nobody re-read.
 *
 * Three cases, because there are three doors and each is a different mechanism.
 * The fleet's own reads the column off the row at the moment of the write, so a
 * stale list cannot get past it. The restart notice reads a query, so what it
 * needs proving is the filter — in both directions, since putting a run back
 * has to restore the banner it left. And `reopenRun` deliberately does *not*
 * read the column at all: picking one run up by name is the decision being
 * taken back, so the mark has to be gone afterwards rather than quietly
 * excluding a run that has since worked again.
 */
describe("a run set aside", () => {
  // Suppresses `promoteQueued`, so a reopened row stays `queued` and nothing
  // reaches a spawn. What is under test is which rows each door selects.
  before(() => settings.setNewWorkPaused(true));
  after(() => settings.setNewWorkPaused(false));

  it("is refused by name when the fleet's pick-up names it anyway", () => {
    const kept = run("aside-kept", "stopped");
    const aside = run("aside-refused", "stopped");
    assert.equal(orch.setRunAside(aside, true).ok, true);

    const report = fleet.reopenFleet([kept, aside], { maxIterations: 3 });

    assert.deepEqual(report.reopened, [kept]);
    assert.equal(report.refused.length, 1);
    assert.equal(report.refused[0].id, aside);
    assert.match(report.refused[0].reason, /set aside/i);
    // The whole point of the mark: it changes what a list acts on and nothing
    // about the run, so the row still says exactly how it ended.
    assert.equal(statusOf(aside), "stopped");
    assert.equal(statusOf(kept), "queued");
  });

  it("leaves the restart notice, and rejoins it when it is put back", () => {
    const id = run("aside-restart", "failed");
    dbMod.db().prepare("UPDATE runs SET restart_closed = 1 WHERE id = ?").run(id);
    const listed = () => orch.restartClosedRuns().some((r) => r.id === id);
    assert.equal(listed(), true);

    orch.setRunAside(id, true);
    assert.equal(listed(), false, "a run set aside is no longer outstanding");
    assert.equal(
      orch.reopenRestartClosed().reopened,
      0,
      "and the press that reads that list must start nothing",
    );
    assert.equal(statusOf(id), "failed");

    // Filtered rather than cleared at the door: the restart is still holding
    // this run up, so putting it back has to restore the count as well.
    orch.setRunAside(id, false);
    assert.equal(listed(), true);
    assert.equal(orch.getRun(id)!.restart_closed, 1);
  });

  it("is cleared by picking that one run up", () => {
    const id = run("aside-cleared", "stopped");
    orch.setRunAside(id, true);

    assert.equal(orch.reopenRun(id, { maxIterations: 3 }).ok, true);

    assert.equal(
      orch.getRun(id)!.set_aside_at,
      null,
      "a run picked up by hand is not still held back from the next bulk press",
    );
  });

  // The side door: neither pick-up names the run set aside, but each picks up
  // the run it waits on, and `reopenRun` revives what that run's ending blocked.
  // A dependent beside it that nobody set aside is the control — it is woken by
  // the same press, so the revive ran and the mark is the whole difference.
  function blockedBehind(name: string, head: string) {
    const aside = dependent(`${name}-aside`, head);
    const beside = dependent(`${name}-beside`, head);
    // Behind the one set aside, so a walk that went through it would reach this.
    const further = dependent(`${name}-further`, aside);
    // A failed run satisfies no `on-success` edge, held or not.
    orch.releaseDependents();
    for (const id of [aside, beside, further]) assert.equal(statusOf(id), "blocked");
    assert.equal(orch.setRunAside(aside, true).ok, true);
    return { aside, beside, further };
  }

  function assertLeftAlone(aside: string, further: string): void {
    assert.equal(
      statusOf(aside),
      "blocked",
      "a run set aside was brought back by a bulk pick-up of the run it waits on",
    );
    assert.notEqual(orch.getRun(aside)!.set_aside_at, null);
    assert.equal(statusOf(further), "blocked", "the revive walked on through it");
  }

  it("is not brought back by the fleet's pick-up of the run it waits on", () => {
    const head = run("aside-fleet-head", "failed", { iterations: 1 });
    const { aside, beside, further } = blockedBehind("aside-fleet", head);

    const report = fleet.reopenFleet([head], { maxIterations: 3 });

    assert.deepEqual(report.reopened, [head]);
    assert.equal(statusOf(beside), "waiting");
    assertLeftAlone(aside, further);
  });

  it("is not brought back by the restart notice's pick-up of the run it waits on", () => {
    // Picked up on its own stored budget, so it needs cycles left under it.
    const head = run("aside-notice-head", "failed", { iterations: 1, budget: ROOMY });
    dbMod.db().prepare("UPDATE runs SET restart_closed = 1 WHERE id = ?").run(head);
    const { aside, beside, further } = blockedBehind("aside-notice", head);

    orch.reopenRestartClosed();

    assert.equal(statusOf(head), "queued");
    assert.equal(statusOf(beside), "waiting");
    assertLeftAlone(aside, further);
  });
});

/**
 * What one budget for twenty-five runs is allowed to do to each of them.
 *
 * `reopenRun` writes `budget=?` from the policy it is handed, so passing the
 * fleet sheet's two fields straight through **replaced** every run's stored
 * limits with those two — a time limit, a token limit, an enforcement mode
 * chosen per run, all silently gone on a press aimed at the cycle cap. Nothing
 * throws, the report says twenty-five reopened, and the guards that were
 * dropped are guards: the next thing that notices is the spend. So the wire is
 * laid *over* the stored blob and the assertion has to be the stored blob after
 * the write, never the report.
 *
 * The second case is the other half of the same change. `reopenRun` now refuses
 * the no-cycle-limit-and-no-time-limit pair at the door — the sheet has no
 * time-limit field at all, so before the merge a blank cycle cap could only
 * ever mean "nothing will end these runs".
 */
describe("what a fleet budget does to each run's own", () => {
  // Suppresses `promoteQueued`, so a reopened row stays `queued` and nothing
  // reaches a spawn.
  before(() => settings.setNewWorkPaused(true));
  after(() => settings.setNewWorkPaused(false));

  const budgetOf = (id: string) =>
    JSON.parse(orch.getRun(id)!.budget) as Record<string, unknown>;

  it("keeps a limit the sheet never asked about", () => {
    const id = run("merge-kept", "stopped", {
      budget: JSON.stringify({
        maxIterations: 1,
        maxDurationMinutes: 90,
        maxRunTokens: 500_000,
        enforcement: "live",
        permissionMode: "acceptEdits",
      }),
    });

    // Exactly what `FleetControls` puts on the wire: two fields, no more.
    const report = fleet.reopenFleet([id], { maxIterations: 3, maxRunCostUSD: 5 });
    assert.deepEqual(report.reopened, [id]);

    const stored = budgetOf(id);
    assert.equal(stored.maxIterations, 3, "the sheet's answer wins where it gave one");
    assert.equal(stored.maxRunCostUSD, 5);
    assert.equal(
      stored.maxDurationMinutes,
      90,
      "not exposed by the sheet, so not rewritten",
    );
    assert.equal(stored.maxRunTokens, 500_000);
    assert.equal(stored.enforcement, "live");
    // Carried off the row by `reopenRun` rather than merged: reopening is not a
    // second route to `--permission-mode`, and the merge must not make it one.
    assert.equal(stored.permissionMode, "acceptEdits");
  });

  it("refuses a blank cycle cap on a run with no time limit of its own", () => {
    const bounded = run("merge-timed", "stopped", {
      budget: JSON.stringify({ maxIterations: 1, maxDurationMinutes: 30 }),
    });
    const unbounded = run("merge-untimed", "stopped", {
      budget: JSON.stringify({ maxIterations: 1 }),
    });

    const report = fleet.reopenFleet([bounded, unbounded], {
      maxIterations: null,
      maxRunCostUSD: null,
    });

    assert.deepEqual(
      report.reopened,
      [bounded],
      "its own time limit is the terminus, so an uncapped loop is legal for it",
    );
    assert.equal(report.refused.length, 1);
    assert.equal(report.refused[0].id, unbounded);
    assert.match(report.refused[0].reason, /no work-cycle limit and no time limit/);
    assert.equal(
      statusOf(unbounded),
      "stopped",
      "refused by name and left exactly as it ended",
    );
  });
});

/**
 * A run picked up that never got as far as a workspace.
 *
 * A run created behind another one is `waiting` with nothing planned: no
 * `work_dir`, no isolation, no checkout, because `admitWaiting` plans all of
 * that when it is released. It can end without ever being released, stopped
 * while it waited or failed by the release itself, and `reopenRun` used to put
 * either back in the *queue*. `startRun` then works in `work_dir ?? folder`,
 * which for this row is the operator's own folder: no checkout, and no wait for
 * the run it was chained behind. Nothing throws and the run page looks like any
 * other pick-up; the evidence is an agent editing the operator's checkout.
 *
 * Here because both doors are here: the run page's own pick-up, and the fleet's
 * `reopenFleet`, which calls it. The folder is a real repository, so that the
 * plan a release makes is a checkout and cannot be mistaken for the folder.
 */
describe("a run picked up before it ever had a workspace", () => {
  const BUDGET = { maxIterations: 3 };
  let cap: number | null;

  // The cap rather than the hold, because the hold would suppress the release
  // that is under test. Nothing may be promoted: several rows earlier in this
  // file are still `queued`, and a spawn is what the missing `CLAUDE_BIN` is
  // only the backstop for.
  before(() => {
    settings.setNewWorkPaused(false);
    cap = settings.getSettings().maxConcurrentRuns;
    settings.saveSettings({ maxConcurrentRuns: 0 });
  });
  after(() => settings.saveSettings({ maxConcurrentRuns: cap }));

  /** git for the fixture, with an identity of its own so a commit cannot refuse. */
  function fixtureGit(cwd: string, args: string[]): void {
    execFileSync(
      "git",
      ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", ...args],
      { cwd, stdio: "ignore" },
    );
  }

  /**
   * A running, and B behind it exactly as `createRun` leaves a run with a
   * dependency: `waiting`, and nothing about its workspace decided yet.
   */
  function chain(
    name: string,
    edge: "on-success" | "on-finish" = "on-success",
  ): { a: string; b: string; repo: string } {
    const repo = path.join(workspace, name);
    fs.mkdirSync(repo, { recursive: true });
    fixtureGit(repo, ["init", "-q", "-b", "main"]);
    fs.writeFileSync(path.join(repo, "README.md"), "seed\n");
    fixtureGit(repo, ["add", "-A"]);
    fixtureGit(repo, ["commit", "-q", "-m", "seed"]);

    const a = run(`${name}-a`, "running", { folder: repo });
    const b = `${name}-b`;
    const now = Date.now() + seq++;
    const db = dbMod.db();
    db.prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations,
                         iterations, created_at, work_dir, isolation)
       VALUES (?, ?, 'then this', 'waiting', '{"maxIterations":1,"permissionMode":"acceptEdits"}',
               1, 0, ?, NULL, NULL)`,
    ).run(b, repo, now);
    db.prepare(
      "INSERT INTO run_deps (run_id, depends_on, edge, continue_branch, created_at)" +
        " VALUES (?, ?, ?, 0, ?)",
    ).run(b, a, edge, now);
    return { a, b, repo };
  }

  /** A finishes its one work cycle and the release pass that follows runs. */
  function complete(id: string): void {
    dbMod
      .db()
      .prepare("UPDATE runs SET status='completed', iterations=1, finished_at=? WHERE id=?")
      .run(Date.now(), id);
    orch.releaseDependents();
  }

  function assertBackBehind(b: string): void {
    const row = orch.getRun(b)!;
    assert.equal(
      row.status,
      "waiting",
      "a run that never started goes back behind its dependency, not into the queue",
    );
    assert.equal(row.work_dir, null, "and holds nothing while it waits");
  }

  /** Admitted by the release, with the checkout it was always going to get. */
  function assertAdmitted(b: string, repo: string): void {
    const row = orch.getRun(b)!;
    assert.equal(row.status, "queued");
    assert.equal(row.isolation, "worktree", "the release planned its workspace");
    assert.ok(row.worktree_path, "a checkout slot was allocated");
    assert.equal(row.work_dir, row.worktree_path, "and the run works in it");
    assert.notEqual(row.work_dir, repo, "never in the operator's own folder");
  }

  it("goes back to waiting when it was stopped while it waited", () => {
    const { a, b, repo } = chain("pickup-stopped");
    assert.equal(orch.stopRun(b), "cancelled");
    assert.equal(statusOf(b), "stopped");

    assert.deepEqual(orch.reopenRun(b, BUDGET), { ok: true });
    assertBackBehind(b);

    complete(a);
    assertAdmitted(b, repo);
  });

  it("goes back to waiting when its release could not prepare a workspace", () => {
    const { a, b, repo } = chain("pickup-failed");
    // Every checkout slot the repository may have, held by live runs, so the
    // release that A's completion triggers has nowhere to put B.
    const store = orch.worktreeStore(repo);
    assert.ok(store, "the fixture repository must be inside the mount");
    const holders: string[] = [];
    for (let slot = 1; slot <= orch.MAX_WORKTREE_SLOTS; slot++) {
      const holder = run(`pickup-failed-slot-${slot}`, "paused");
      dbMod
        .db()
        .prepare("UPDATE runs SET worktree_path=? WHERE id=?")
        .run(path.join(store, `${orch.repoSlug(repo)}-${slot}`), holder);
      holders.push(holder);
    }

    complete(a);
    const failed = orch.getRun(b)!;
    assert.equal(failed.status, "failed");
    assert.match(failed.stop_reason ?? "", /workspace could not be prepared/);
    assert.equal(failed.work_dir, null);

    // The slots come free, and the operator picks B up.
    for (const holder of holders) {
      dbMod.db().prepare("DELETE FROM runs WHERE id=?").run(holder);
    }
    assert.deepEqual(orch.reopenRun(b, BUDGET), { ok: true });

    // Its dependency has already succeeded, so going back to waiting admits it
    // in the same call, through the release that plans a workspace.
    assertAdmitted(b, repo);
  });

  it("goes back to waiting when the fleet's pick-up is the door", () => {
    const { a, b, repo } = chain("pickup-fleet");
    assert.equal(orch.stopRun(b), "cancelled");

    const report = fleet.reopenFleet([b], BUDGET);
    assert.deepEqual(report.reopened, [b]);
    assertBackBehind(b);

    complete(a);
    assertAdmitted(b, repo);
  });

  // The page sends its ids newest first, so a dependent comes before the run it
  // waits for. Taken in that order, B's release pass reads A as it ended — a
  // cycle run and terminal, which is all `on-finish` asks — and admits B before
  // A is picked up beside it, so both would work at once.
  it("stays behind a dependency the same press picks up, whatever order it names them", () => {
    const { a, b, repo } = chain("pickup-both", "on-finish");
    assert.equal(orch.stopRun(b), "cancelled");
    dbMod
      .db()
      .prepare("UPDATE runs SET status='failed', iterations=1, finished_at=? WHERE id=?")
      .run(Date.now(), a);

    const report = fleet.reopenFleet([b, a], BUDGET);
    assert.deepEqual([...report.reopened].sort(), [a, b].sort());
    assert.equal(statusOf(a), "queued");
    assertBackBehind(b);

    complete(a);
    assertAdmitted(b, repo);
  });
});

/**
 * The two parks a restart keeps, and what the hold must not turn them into.
 *
 * Holding new work before a planned restart is the hold's main use, and a
 * restart keeps a `paused` run inside its grace and a `waiting-for-stack` run
 * whatever its age — but closes every `queued` row out as `stopped`. So a park
 * whose wait ended while new work was held, re-queued by the sweeper and kept
 * there by the hold, was ended by the restart the operator held the fleet for,
 * and dropped into the restart notice instead of resuming. Nothing throws: the
 * page says the run was stopped because the server restarted, which is true.
 *
 * Last in the file because `reconcileOnBoot` closes out every row it finds.
 * The cap is 0 so that lifting the hold queues what it kept and starts none of
 * it.
 */
describe("the parks a restart keeps, under the hold", () => {
  let cap: number | null;

  before(() => {
    settings.setNewWorkPaused(true);
    cap = settings.getSettings().maxConcurrentRuns;
    settings.saveSettings({ maxConcurrentRuns: 0 });
  });
  after(() => {
    settings.setNewWorkPaused(false);
    settings.saveSettings({ maxConcurrentRuns: cap });
  });

  /** A run parked a minute ago, inside any restart grace, due at `resumeAt`. */
  function parked(id: string, resumeAt: number): string {
    // Cycles left, or the sweeper ends it on its cap instead of resuming it.
    run(id, "paused", { iterations: 1, budget: ROOMY });
    dbMod
      .db()
      .prepare("UPDATE runs SET session_id='s', paused_at=?, resume_at=? WHERE id=?")
      .run(Date.now() - 60_000, resumeAt, id);
    return id;
  }

  /**
   * A run waiting for a stack, with no request attached — which
   * `decideStackWait` reads as a request that has gone, and releases.
   */
  function answeredStackWait(id: string): string {
    run(id, "waiting-for-stack", { iterations: 1, budget: ROOMY });
    dbMod
      .db()
      .prepare("UPDATE runs SET session_id='s', paused_at=? WHERE id=?")
      .run(Date.now() - 60_000, id);
    return id;
  }

  it("keeps a parked run whose window clears paused, so a restart keeps it", async () => {
    const due = parked("held-park-due", Date.now() - 1_000);
    // The control: a park still inside its window is kept by the same restart.
    const notDue = parked("held-park-not-due", Date.now() + 3_600_000);

    await orch.sweepPaused();
    assert.equal(statusOf(due), "paused", "the sweeper put a held run in the queue");

    orch.reconcileOnBoot();
    assert.equal(statusOf(notDue), "paused");
    const kept = orch.getRun(due)!;
    assert.equal(
      kept.status,
      "paused",
      "a parked run the hold kept from resuming was closed out by the restart",
    );
    assert.equal(kept.restart_closed, 0);
  });

  it("keeps an answered stack wait waiting, so a restart keeps it", () => {
    const id = answeredStackWait("held-stack-answered");

    // Still counted as waiting, which is what keeps the sweeper's timer alive
    // to release it once the hold is lifted.
    assert.deepEqual(orch.releaseStackWaits([]), { released: 0, waiting: 1 });
    assert.equal(statusOf(id), "waiting-for-stack");

    orch.reconcileOnBoot();
    assert.equal(
      statusOf(id),
      "waiting-for-stack",
      "a stack wait the hold kept from resuming was closed out by the restart",
    );
  });

  it("puts what it kept back in the queue the moment it is lifted", async () => {
    const due = parked("lifted-park-due", Date.now() - 1_000);
    const stack = answeredStackWait("lifted-stack-answered");
    await orch.sweepPaused();
    assert.equal(statusOf(due), "paused");
    assert.equal(statusOf(stack), "waiting-for-stack");

    fleet.setFleetPaused(false);

    // Decided without a snapshot, so it is back before the call returns.
    assert.equal(statusOf(stack), "queued");
    // A parked run needs the usage snapshot first. The sweeper's own timer is a
    // minute, so a run still parked after this wait was not kicked.
    for (let i = 0; i < 500 && statusOf(due) === "paused"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      statusOf(due),
      "queued",
      "lifting the hold left a run whose window had cleared waiting for the next sweep",
    );
  });
});
