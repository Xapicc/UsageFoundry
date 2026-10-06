import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { WorkflowGraph } from "./workflowGraph";

/**
 * A Pause, Remove or Change pressed while a schedule is firing wins over the
 * fire.
 *
 * `tickSchedules` reads every active row once and then awaits each one's
 * snapshot in turn, and `currentSnapshot()` is a transcript walk plus, now and
 * then, a provider call — seconds, on a real install. A row read before that
 * await and acted on after it started an unattended instance the operator had
 * just paused or removed, and wrote a stale cursor and outcome over an edit
 * they had just saved. The card said paused, or gone, or the new recurrence;
 * the agent started anyway, which is the one start in this app with nobody
 * present to see it. So each case presses a button from inside the snapshot,
 * which is exactly where the operator's press lands on a slow read.
 *
 * The first case is the control: without it the rest would pass on a fixture
 * that never fires, and "no instance" would say nothing.
 *
 * Its own file for `schedulePut.test.ts`' reason, and apart from that one
 * because `tickSchedules` acts on every active schedule in the database, so it
 * would fire that file's fixtures. `currentSnapshot` is replaced on the module
 * object, `validationGrant.test.ts`' way: `schedules.ts` calls it through that
 * object under the test build's CommonJS emit.
 */

let root: string;
let orch: typeof import("./orchestrator");
let schedules: typeof import("./schedules");
let workflows: typeof import("./workflows");
let dbMod: typeof import("./db");
let settings: typeof import("./settings");
let fleet: typeof import("./fleet");

/** What an operator presses while the snapshot is being read; nothing by default. */
let pressDuringSnapshot: () => void = () => {};

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-schedule-fire-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(workspace, "one"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "two"), { recursive: true });
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = workspace;
  // Wins over WORKSPACE_ROOT, and any container this ships in has it set.
  process.env.WORKSPACE_ROOTS = `Scratch=${workspace}`;
  // The control case starts a real instance, whose run is promoted in the
  // background. A `claude` that does not exist makes that a failed run rather
  // than a billed one.
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );

  orch = await import("./orchestrator");
  schedules = await import("./schedules");
  workflows = await import("./workflows");
  dbMod = await import("./db");
  settings = await import("./settings");
  fleet = await import("./fleet");

  // The snapshot asks the provider for its own utilisation otherwise, and there
  // is no network here.
  settings.saveSettings({ planUsageFromApi: false });

  const realSnapshot = orch.currentSnapshot;
  (orch as { currentSnapshot: unknown }).currentSnapshot = async () => {
    const snapshot = await realSnapshot();
    pressDuringSnapshot();
    return snapshot;
  };
});

after(async () => {
  // `runOrigin.test.ts`' reason: the control's run fails in the background on
  // the missing `claude`, and closing the handle under it turns that into an
  // unhandled rejection about this file rather than the code.
  await new Promise((resolve) => setTimeout(resolve, 50));
  delete process.env.WORKSPACE_ROOTS;
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  pressDuringSnapshot = () => {};
  // A row of the settings table rather than a variable, so one case's hold
  // would otherwise be the next case's.
  settings.setNewWorkPaused(false);
  for (const table of [
    "workflow_schedules",
    "workflow_instance_blocks",
    "workflow_instance_runs",
    "workflow_instances",
    "workflows",
    "run_deps",
    "runs",
  ]) {
    dbMod.db().prepare(`DELETE FROM ${table}`).run();
  }
});

const HOUR_MS = 60 * 60_000;

/** One run block in its own folder, so two workflows never contend for one. */
function graphIn(folder: string): WorkflowGraph {
  return {
    nodes: [
      {
        id: "A",
        name: "Do A",
        kind: "run",
        templateId: null,
        mountId: "scratch",
        folder,
        task: "do the thing",
        promptOverride: null,
        agentId: null,
        fanOut: null,
        mergeStrategy: null,
        mergeAutoResolve: false,
        maxPasses: null,
        maxLoopCostUSD: null,
        stopWhenTasks: null,
        bodyNodeIds: [],
        provider: null,
        fixRounds: null,
      },
    ],
    edges: [],
  };
}

/**
 * A budgeted workflow whose hourly schedule had an occurrence `secondsAgo` and
 * a cursor just before it, so the next tick fires it. Inside `FIRE_GRACE_MS`
 * either way; the age only orders the rows, since the tick reads them oldest
 * first. `windowsBehind` moves the cursor back by that many whole hours, so the
 * tick finds that many older occurrences to record as missed before the one it
 * fires.
 */
function dueSchedule(name: string, folder: string, secondsAgo = 10, windowsBehind = 0): string {
  const id = workflows.createWorkflow({
    name,
    graph: graphIn(folder),
    instanceBudget: {
      maxInstanceCostUSD: 5,
      maxSessionFraction: null,
      maxWeeklyFraction: null,
    },
  }).id;
  const occurrence = Date.now() - secondsAgo * 1000;
  schedules.putSchedule(
    id,
    { kind: "everyHours", hours: 1, anchorAt: occurrence },
    "UTC",
    occurrence - 1 - windowsBehind * HOUR_MS,
  );
  return id;
}

function instancesOf(workflowId: string): number {
  const row = dbMod
    .db()
    .prepare("SELECT COUNT(*) AS n FROM workflow_instances WHERE workflow_id = ?")
    .get(workflowId) as { n: number };
  return row.n;
}

function runCount(): number {
  const row = dbMod.db().prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number };
  return row.n;
}

function rowOf(workflowId: string): { cursor_at: number | null; last_code: string | null } | undefined {
  return dbMod
    .db()
    .prepare("SELECT cursor_at, last_code FROM workflow_schedules WHERE workflow_id = ?")
    .get(workflowId) as { cursor_at: number | null; last_code: string | null } | undefined;
}

describe("a schedule's fire, against what the operator presses during it", () => {
  it("starts an instance when nothing is pressed", async () => {
    const id = dueSchedule("Control", "one");

    await schedules.tickSchedules();

    assert.equal(instancesOf(id), 1, "the fixture has to fire for the other cases to mean anything");
    assert.equal(rowOf(id)?.last_code, "started");
  });

  it("starts nothing for a schedule paused during its own snapshot", async () => {
    const id = dueSchedule("Nightly", "one");
    pressDuringSnapshot = () => schedules.pauseSchedule(id, true);

    await schedules.tickSchedules();

    assert.equal(instancesOf(id), 0, "a paused schedule started an unattended instance");
    assert.equal(rowOf(id)?.last_code, null);
  });

  it("starts nothing for a schedule removed during its own snapshot", async () => {
    const id = dueSchedule("Nightly", "one");
    pressDuringSnapshot = () => schedules.deleteSchedule(id);

    await schedules.tickSchedules();

    assert.equal(instancesOf(id), 0, "a removed schedule started an unattended instance");
    assert.equal(rowOf(id), undefined);
  });

  it("keeps an edit saved during its own snapshot, and starts nothing for the old recurrence", async () => {
    const id = dueSchedule("Nightly", "one");
    let editedAt = 0;
    pressDuringSnapshot = () => {
      editedAt = Date.now();
      schedules.putSchedule(id, { kind: "daily", minutes: 540 }, "UTC", editedAt);
    };

    await schedules.tickSchedules();

    assert.equal(instancesOf(id), 0, "the recurrence the operator replaced still fired");
    // The edit's own reset, which a stale `recordOutcome` wrote "started" over.
    assert.deepEqual(rowOf(id), { cursor_at: editedAt, last_code: null });
  });

  it("starts nothing for a workflow whose limits were cleared during its own snapshot", async () => {
    const id = dueSchedule("Nightly", "one");
    pressDuringSnapshot = () => {
      // An edit to the workflow, not the schedule, so the schedule row's
      // `updated_at` is untouched and the row still reads as unchanged.
      workflows.updateWorkflow(id, {
        name: "Nightly",
        graph: graphIn("one"),
        instanceBudget: {
          maxInstanceCostUSD: null,
          maxSessionFraction: null,
          maxWeeklyFraction: null,
        },
      });
    };

    await schedules.tickSchedules();

    assert.equal(instancesOf(id), 0, "a workflow with no instance budget was started unattended");
    assert.equal(rowOf(id)?.last_code, "unbudgeted");
  });

  it("starts nothing for a later schedule paused during an earlier one's snapshot", async () => {
    // Both due at once — "every day at 09:00" twice — and read together at the
    // top of the tick, so the second row is stale for the whole of the first
    // one's snapshot and start.
    const first = dueSchedule("First", "one", 20);
    const second = dueSchedule("Second", "two");
    const cursorBefore = rowOf(second)?.cursor_at;
    pressDuringSnapshot = () => {
      pressDuringSnapshot = () => {};
      schedules.pauseSchedule(second, true);
    };

    await schedules.tickSchedules();

    assert.equal(instancesOf(first), 1);
    assert.equal(instancesOf(second), 0, "the schedule paused mid-tick still fired");
    assert.deepEqual(rowOf(second), { cursor_at: cursorBefore, last_code: null });
  });

  it("keeps an edit to a later schedule saved during an earlier one's snapshot", async () => {
    const first = dueSchedule("First", "one", 20);
    const second = dueSchedule("Second", "two");
    let editedAt = 0;
    pressDuringSnapshot = () => {
      pressDuringSnapshot = () => {};
      editedAt = Date.now();
      schedules.putSchedule(second, { kind: "daily", minutes: 540 }, "UTC", editedAt);
    };

    await schedules.tickSchedules();

    assert.equal(instancesOf(first), 1);
    assert.equal(instancesOf(second), 0, "the recurrence the operator replaced still fired");
    // A stale `setCursor` moved this back to the old recurrence's window, which
    // the new one was never set for.
    assert.deepEqual(rowOf(second), { cursor_at: editedAt, last_code: null });
  });
});

/**
 * The install-wide hold is the other press that lands in the snapshot gap, and
 * the operator's usual reason for it — stop everything before a restart, or
 * because the meters look wrong — is the one that least tolerates a fire that
 * was already past the check. `fireIfDue` read the hold into `decideSchedule`
 * before awaiting the snapshot and never asked again, so a fire in flight
 * created the instance and recorded "started" while held, and the run was
 * promoted the moment the hold was lifted: a window that passed during the hold,
 * made up after it, under a card that said it started on time.
 *
 * The hold is pressed through `setFleetPaused`, which is what the button calls.
 */
describe("a schedule's fire, against the install-wide hold on new work", () => {
  it("control: starts nothing, and moves nothing, when the hold is set before the tick", async () => {
    const id = dueSchedule("Held before", "one");
    const cursorBefore = rowOf(id)?.cursor_at;
    settings.setNewWorkPaused(true);

    await schedules.tickSchedules();

    assert.equal(instancesOf(id), 0);
    assert.deepEqual(rowOf(id), { cursor_at: cursorBefore, last_code: null });
  });

  it("starts nothing when the hold is set during the fire's own snapshot", async () => {
    const id = dueSchedule("Held during", "one");
    const cursorBefore = rowOf(id)?.cursor_at;
    pressDuringSnapshot = () => fleet.setFleetPaused(true);

    await schedules.tickSchedules();

    assert.equal(instancesOf(id), 0, "a fire decided before the hold started an instance while held");
    assert.equal(runCount(), 0, "the held fire still wrote a run for the hold's release to promote");
    // The cursor stays where the hold found it, so lifting the hold records the
    // window as missed rather than the card saying nothing happened at all.
    assert.deepEqual(rowOf(id), { cursor_at: cursorBefore, last_code: null });
  });

  it("puts the cursor back only as far as the windows it already recorded as missed", async () => {
    // One older occurrence ahead of the one being fired. The tick records it as
    // missed before the snapshot, and a cursor put back past it would have the
    // next decision record the same window again.
    const id = dueSchedule("Held after a miss", "one", 10, 1);
    const cursorBefore = rowOf(id)?.cursor_at as number;
    pressDuringSnapshot = () => fleet.setFleetPaused(true);

    await schedules.tickSchedules();

    assert.equal(instancesOf(id), 0);
    // The older occurrence is one millisecond past the cursor the fixture set.
    assert.deepEqual(rowOf(id), { cursor_at: cursorBefore + 1, last_code: "missed" });
  });
});
