import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, it } from "node:test";
// Type-only, so it is erased rather than hoisted above the environment below.
import type { Interrupt } from "./orchestrator";

/**
 * What a `docker compose restart` does to the work cycles it interrupts.
 *
 * The handler was synchronous end to end — `killAllAgents(sig)`,
 * `releaseDataDir()`, `process.exit(0)` — so not one suspended `startRun` frame
 * ever resumed and nothing after `await runIteration(...)` ran. Three things
 * went with it every time, and each already had a mechanism written for it:
 * `reconcileKilledCycle` recovered the cycle's spend and was reachable only
 * from inside that loop, `active_iteration`/`active_started_at` were cleared in
 * the same place, and the run's own account of why it ended was left for the
 * next boot to guess at. On twenty-five runs that is twenty-five cycles of real
 * billed tokens missing from `spent_usd_est` — invisible afterwards to
 * `RunProgress.spentGuardUSD`, to `maxRunCostUSD` and to the instance budget,
 * so a run picked up later can overshoot its own cost limit by a whole cycle.
 *
 * What this pins is that the shutdown path **awaits** the accounting, which no
 * test of `reconcileKilledCycle` itself could say: the function was always
 * correct and always unreachable. So it drives a real run to `running` against
 * a stubbed child, calls the real `shutdownRuns`, and reads the row.
 *
 * Its own file with the environment set before anything is required, for the
 * reason every database-backed test here needs it: `config.ts` fixes `DATA_DIR`
 * and `CLAUDE_HOME` at module load.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-shutdown-")));
const projects = path.join(tmp, "claude", "projects", "workspace-project");
fs.mkdirSync(projects, { recursive: true });
fs.mkdirSync(path.join(tmp, "workspace", "project"), { recursive: true });

process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
process.env.WORKSPACE_ROOT = path.join(tmp, "workspace");
delete process.env.WORKSPACE_ROOTS;
process.env.CLAUDE_BIN = path.join(tmp, "no-such-claude");

const config = require("./config") as typeof import("./config");
assert.equal(
  config.DATA_DIR,
  process.env.DATA_DIR,
  "config was already loaded by another test file in this process — refusing to " +
    "run against the real database",
);

const {
  activeRuns,
  createRun,
  cycleCutByRestart,
  getRun,
  killAllAgents,
  reconcileInterruptedCycles,
  reconcileOnBoot,
  reopenRestartClosed,
  reopenRun,
  restartClosedRuns,
  runEvents,
  selectPromotable,
  shutdownRuns,
  startRun,
  stopRun,
  trackAssistChild,
} =
  require("./orchestrator") as typeof import("./orchestrator");
const { db } = require("./db") as typeof import("./db");
const { claimDataDir, releaseDataDir } =
  require("./serverLock") as typeof import("./serverLock");
const { assistRefusal, getAssist, SHUTDOWN_REFUSAL, startAssist } =
  require("./review") as typeof import("./review");
const { getSettings, saveSettings } =
  require("./settings") as typeof import("./settings");
const { runVerify } = require("./landGate") as typeof import("./landGate");

const SESSION = "11111111-2222-3333-4444-555555555555";
const lockFile = path.join(config.DATA_DIR, "server.lock");

/** The run loop's interrupt map, which `checkContextCeilings` writes a prune into. */
function interrupts(): Map<string, Interrupt> {
  return (globalThis as unknown as { __ufInterrupts: Map<string, Interrupt> })
    .__ufInterrupts;
}

/**
 * The transcript the killed cycle leaves behind.
 *
 * This is what `reconcileKilledCycle` reads, through the same pipeline the
 * dashboard uses — same dedupe key, same price table. Written *after* the cycle
 * has been stamped on the row, because the estimate is bounded by session id
 * **and** by the cycle's own start instant: a resumed session copies earlier
 * turns forward carrying their original timestamps, so a record written before
 * the spawn is one this deliberately does not count.
 */
function appendTranscript(
  messageId: string,
  requestId: string,
  sessionId: string = SESSION,
): void {
  const record = {
    type: "assistant",
    cwd: path.join(tmp, "workspace", "project"),
    sessionId,
    requestId,
    timestamp: new Date().toISOString(),
    message: {
      id: messageId,
      model: "claude-sonnet-4-5-20250929",
      usage: {
        input_tokens: 40_000,
        output_tokens: 2_000,
        cache_read_input_tokens: 100_000,
      },
    },
  };
  fs.appendFileSync(
    path.join(projects, `${sessionId}.jsonl`),
    `${JSON.stringify(record)}\n`,
  );
}

/**
 * A child that stays alive until it is signalled.
 *
 * The point of the fixture: `runIteration` must still be suspended when
 * `shutdownRuns` is called, which is the state the whole defect lives in. It
 * names a session on stdout because that is how `adoptSession` learns it — and
 * the session id is what bounds the estimate — and it never emits `result`,
 * which is what makes this a killed cycle rather than a finished one.
 */
const childProcess = require("node:child_process") as Record<string, unknown>;
const realSpawn = childProcess.spawn as typeof import("node:child_process").spawn;
let spawned = 0;
/**
 * Whether the next child finishes its cycle on its own, replying DONE, rather
 * than staying alive until it is signalled. Only the case about a run that
 * reached its own ending during the grace sets it.
 */
let nextChildSaysDone = false;

childProcess.spawn = () => {
  spawned += 1;
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    // No pid, so `signalTree` skips `process.kill(-pid)` — which would either
    // throw ESRCH or, far worse in a test runner, signal a real process group.
    pid: undefined as number | undefined,
    kill(sig: string) {
      setImmediate(() => {
        stdout.end();
        child.emit("exit", null, sig);
        child.emit("close", null, sig);
      });
      return true;
    },
  });
  stdout.write(`${JSON.stringify({ type: "system", session_id: SESSION })}\n`);
  if (nextChildSaysDone) {
    setImmediate(() => {
      stdout.write(
        `${JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "DONE",
          total_cost_usd: 0.5,
          session_id: SESSION,
        })}\n`,
      );
      stdout.end();
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    });
  }
  return child;
};

after(() => {
  childProcess.spawn = realSpawn;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Let the run loop reach the point where it is suspended on its child. */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

describe("shutting down with a work cycle in flight", () => {
  it("reconciles the killed cycle before it exits, and clears the columns", async () => {
    const run = createRun({
      folder: "project",
      mountId: null,
      prompt: "do the thing",
      // Two, so a loop that carried on rather than stopping would spawn again —
      // which is the other half of what the flag in `shutdownRuns` prevents.
      budget: { maxIterations: 2 },
      origin: "form",
    });

    await waitFor(
      () => getRun(run.id)?.active_started_at !== null,
      "the first work cycle to be stamped on the row",
    );
    appendTranscript("msg_shutdown_1", "req_shutdown_1");

    const before = getRun(run.id)!;
    assert.equal(before.status, "running");
    assert.equal(before.active_iteration, 1);
    assert.equal(before.session_id, SESSION, "the stream's session id must be on the row");
    assert.equal(before.spent_usd_est, 0, "nothing is reconciled while the cycle runs");

    const outcome = await shutdownRuns("SIGTERM");
    assert.equal(outcome.closed, 1, "the run must have been stopped by the shutdown");
    // The loop recovered this one itself, inside the grace, so the mop-up found
    // nothing. The handler's log line is built from this count, and it read 0
    // while the row below carried the recovered spend.
    assert.equal(outcome.recovered, 1, "a cycle the loop recovered must be counted");

    const settled = getRun(run.id)!;

    // The whole issue. Before this change the process exited here and every one
    // of these was left as it was.
    assert.ok(
      settled.spent_usd_est > 0,
      `the killed cycle's spend must be recovered, got ${settled.spent_usd_est}`,
    );
    assert.ok(settled.spent_tokens_est > 0);
    assert.equal(settled.active_iteration, null, "no cycle is in flight after a shutdown");
    assert.equal(settled.active_started_at, null);

    // And the run says what happened to it, rather than being left `running`
    // for the next boot to call a restart — or, worse, settled by the exit-code
    // test as `Claude Code exited with code -1`.
    assert.equal(settled.status, "stopped");
    assert.match(settled.stop_reason ?? "", /server shut down/);
    assert.equal(
      settled.restart_closed,
      1,
      "it has to be findable as one the restart closed out",
    );
    // And as one whose cycle the restart cut off, which `stopped` cannot say:
    // this is the row picking it up must tell that its last cycle did not
    // finish, and it read as an ordinary stop.
    assert.equal(settled.restart_cut_cycle, 1);
    assert.equal(cycleCutByRestart(settled), true);
    assert.ok(
      restartClosedRuns().some((row) => row.id === run.id),
      "a run whose cycle the shutdown cut off must be offered by the restart notice",
    );

    // One child, not two: the second work cycle its budget allowed must not
    // have been spawned on the way out of the door.
    assert.equal(spawned, 1);

    // And the row says the figure is an estimate. A recovered total presented
    // as measured spend is the one thing worse than a missing one, which is why
    // it lives in its own column and its own sentence.
    assert.match(settled.stop_reason ?? "", /reconciled from transcripts/);
  });

  it("does not return before the loops it interrupted have written their endings", async () => {
    // The wait used to end on a reading of the row: no child left, and no
    // cycle claiming to be in flight. Neither says the loop has written the
    // run's ending. After a killed cycle the post-cycle UPDATE clears
    // `active_started_at` a transcript read before the status write, and under
    // `npm run dev` the handler's `process.exit(0)` landed in that gap and left
    // the row `running` for the next boot to fail. A run caught in its
    // pre-cycle scan is the same gap with no clock in it: it has no child and
    // no open cycle, so the old wait did not wait at all.
    const run = createRun({
      folder: "project",
      mountId: null,
      prompt: "do the other thing",
      budget: { maxIterations: 1 },
      origin: "form",
    });
    // The case above has already shut down, so `promoteQueued` refuses and the
    // loop is started here instead. It runs as far as its pre-cycle transcript
    // scan, its first `await`, before this line returns.
    void startRun(run.id);
    const before = getRun(run.id)!;
    assert.equal(before.status, "running");
    assert.equal(before.active_started_at, null, "the fixture must be between cycles");
    const spawnedBefore = spawned;

    const outcome = await shutdownRuns("SIGINT");
    assert.equal(outcome.closed, 1);

    const settled = getRun(run.id)!;
    assert.equal(
      settled.status,
      "stopped",
      "the shutdown returned before the loop had written the run's ending",
    );
    assert.match(settled.stop_reason ?? "", /server shut down \(SIGINT\)/);
    assert.equal(spawned, spawnedBefore, "no work cycle may start on the way out");
    // Closed out by the restart like the run above, and with the same ending,
    // but it had no cycle to cut off and must not be told it had one.
    assert.equal(settled.restart_closed, 1);
    assert.equal(settled.restart_cut_cycle, 0);
    assert.equal(cycleCutByRestart(settled), false);
  });

  it("mops up a cycle whose loop never got to finish", async () => {
    // The grace is a ceiling, not a promise: a loop still inside
    // `reconcileKilledCycle`'s own transcript scan when it expires leaves the
    // row exactly as the old synchronous exit did. `reconcileInterruptedCycles`
    // is the belt, and this is the row it is for — one claiming an open cycle
    // with nothing coming to settle it.
    const startedAt = Date.now();
    appendTranscript("msg_orphan", "req_orphan");

    db()
      .prepare(
        "INSERT INTO runs (id, folder, prompt, model, status, budget, max_iterations," +
          " iterations, created_at, spent_usd, spent_tokens, session_id," +
          " active_iteration, active_started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "orphaned-cycle",
        path.join(tmp, "workspace", "project"),
        "task",
        null,
        "running",
        "{}",
        1,
        0,
        startedAt,
        0,
        0,
        SESSION,
        2,
        startedAt,
      );

    const recovered = await reconcileInterruptedCycles();
    assert.equal(recovered, 1);

    const row = getRun("orphaned-cycle")!;
    assert.ok(row.spent_usd_est > 0);
    // The cycle was spawned and billed, so the cap has to have it: the loop
    // that would have written `iterations` is the one that never finished.
    assert.equal(row.iterations, 2);
    assert.equal(row.active_iteration, null);
    assert.equal(row.active_started_at, null);

    // Said in the run's own log, because a run whose spend is understated and a
    // run that spent nothing look identical everywhere else in this app.
    const said = runEvents("orphaned-cycle").events.map((e) =>
      JSON.stringify(e.payload),
    );
    assert.ok(
      said.some((t) => /reconciled from this session's transcripts/.test(t)),
      "the recovery has to be visible in the run's log",
    );

    // Idempotent by construction: the guarded UPDATE means a second pass — or
    // the loop's own write landing late — cannot charge the cycle twice.
    const before = row.spent_usd_est;
    assert.equal(await reconcileInterruptedCycles(), 0);
    assert.equal(getRun("orphaned-cycle")!.spent_usd_est, before);
  });

  it("leaves no run claiming an open cycle after a boot reconcile", async () => {
    // The other half of the same criterion, for the endings the shutdown handler
    // never reaches — a SIGKILL, an OOM, a host that lost power. Nothing else
    // clears these columns, and `instanceSpend` reads `active_started_at` for a
    // `running` member.
    db()
      .prepare(
        "UPDATE runs SET status='running', active_iteration=3, active_started_at=? WHERE id=?",
      )
      .run(Date.now() - 60_000, "no-such-run");
    const crashed = db()
      .prepare(
        "INSERT INTO runs (id, folder, prompt, model, status, budget, max_iterations," +
          " iterations, created_at, spent_usd, spent_tokens, active_iteration," +
          " active_started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "crashed-mid-cycle",
        path.join(tmp, "workspace", "project"),
        "task",
        null,
        "running",
        "{}",
        1,
        0,
        Date.now(),
        0,
        0,
        3,
        Date.now() - 60_000,
      );
    assert.equal(crashed.changes, 1);

    await reconcileOnBoot();

    const row = getRun("crashed-mid-cycle")!;
    assert.equal(row.active_iteration, null);
    assert.equal(row.active_started_at, null);
    assert.equal(row.status, "failed");
    assert.equal(row.restart_closed, 1);
    // No shutdown reached it to record a child, so `failed` is what says so.
    assert.equal(row.restart_cut_cycle, 0);
    assert.equal(cycleCutByRestart(row), true);
  });

  it("recovers at the next boot what a cycle cut off by a hard stop spent, and counts it", async () => {
    // The state a SIGKILL, an OOM kill or a lost host leaves: a `running` row
    // with its cycle open and the cycle's transcript on disk, and no shutdown
    // handler having run at all. The boot used to null the two columns first,
    // which made the spend unrecoverable for good and left the cycle off the
    // cap, so a run picked up on `maxIterations: 1` was handed it again.
    const session = "bbbbbbbb-0000-0000-0000-000000000002";
    const startedAt = Date.now() - 1_000;
    db()
      .prepare(
        "INSERT INTO runs (id, folder, prompt, model, status, budget, max_iterations," +
          " iterations, created_at, spent_usd, spent_tokens, session_id," +
          " active_iteration, active_started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "killed-hard",
        path.join(tmp, "workspace", "project"),
        "task",
        null,
        "running",
        JSON.stringify({ maxIterations: 1, maxRunCostUSD: 5 }),
        1,
        0,
        startedAt,
        0,
        0,
        session,
        1,
        startedAt,
      );
    appendTranscript("msg_hard_kill", "req_hard_kill", session);

    await reconcileOnBoot();

    const row = getRun("killed-hard")!;
    assert.equal(row.status, "failed");
    assert.ok(
      row.spent_usd_est > 0,
      `the killed cycle's spend must be recovered at boot, got ${row.spent_usd_est}`,
    );
    assert.ok(row.spent_tokens_est > 0);
    assert.equal(row.iterations, 1, "the killed cycle must count against the cycle cap");
    assert.equal(row.active_iteration, null);
    assert.equal(row.active_started_at, null);
    const said = runEvents("killed-hard").events.map((e) => JSON.stringify(e.payload));
    assert.ok(
      said.some((t) => /\$\d+\.\d\d is reconciled from this session's transcripts/.test(t)),
      "the recovered spend has to be named in the run's log",
    );
  });
});

/**
 * The same handler, in the process that does not own the data directory.
 *
 * `shutdownRuns` closes out every `running` row install-wide, which is the
 * right reading for the owner and nobody else's business. The second process is
 * ordinarily an agent's `npm run dev` against an inherited `DATA_DIR` — the
 * workflow `serverLock.ts` exists for — and on its way out it was marking the
 * *owner's* live runs `restart_closed`, logging a shutdown against them and
 * clearing `active_started_at` on cycles whose agents were still working. That
 * last column is why this is worth a case of its own rather than tidiness:
 * `installBudget` and a workflow instance's budget both bound their spend below
 * by it, so nulling it widens two limits at once, silently, in the direction
 * a guard may never move by accident.
 *
 * Refused for real rather than through a stubbed `mayWriteDataDir`: a lock file
 * naming a live pid that is not ours is what a second server actually finds,
 * and it is the whole of the difference between `held` and the `unclaimed`
 * every case above runs under — which is why those may write and this may not.
 */
describe("shutting down without owning the data directory", () => {
  // Whatever is appended to this file next must not inherit a process that has
  // been refused the directory. Deleting the lock and claiming it back is the
  // module's own route from `held` to `unclaimed`; there is no setter.
  after(async () => {
    fs.rmSync(lockFile, { force: true });
    await claimDataDir();
    releaseDataDir();
  });

  it("leaves the owner's running row exactly as it found it", async () => {
    const startedAt = Date.now();
    db()
      .prepare(
        "INSERT INTO runs (id, folder, prompt, model, status, budget, max_iterations," +
          " iterations, created_at, spent_usd, spent_tokens, session_id," +
          " active_iteration, active_started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "owners-live-run",
        path.join(tmp, "workspace", "project"),
        "task",
        null,
        "running",
        "{}",
        1,
        0,
        startedAt,
        0,
        0,
        SESSION,
        1,
        startedAt,
      );
    // Written after the cycle's start instant, so it is spend
    // `reconcileKilledCycle` would have found: without it "nothing was charged"
    // would be true for the wrong reason.
    appendTranscript("msg_nonowner", "req_nonowner");

    const before = db()
      .prepare("SELECT * FROM runs WHERE id = ?")
      .get("owners-live-run");
    const eventsBefore = runEvents("owners-live-run").events.length;

    // `process.ppid` because it is alive and can never be our own pid — which
    // `lockVerdict` reads as this server's predecessor across a restart and
    // claims outright.
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: process.ppid,
        ownerId: "the-process-that-owns-this-directory",
        startedAt,
        heartbeatAt: Date.now(),
      }),
    );
    assert.equal(
      await claimDataDir(),
      false,
      "the fixture must leave this process refused, or the case proves nothing",
    );

    const outcome = await shutdownRuns("SIGTERM");
    assert.deepEqual(
      outcome,
      { signalled: 0, closed: 0, recovered: 0 },
      "a process that may not write has closed nothing out and recovered nothing",
    );

    // The whole issue. Every column this compares was being written by a
    // process that had already been told it does not own this database, on a
    // row whose agent belongs to the server that does.
    assert.deepEqual(
      db().prepare("SELECT * FROM runs WHERE id = ?").get("owners-live-run"),
      before,
      "restart_closed, active_started_at and spent_usd_est are the owner's to write",
    );
    assert.equal(
      runEvents("owners-live-run").events.length,
      eventsBefore,
      "no run_events row — and so no outbound webhook, which is fired from emit",
    );
  });
});

/**
 * A child that is not a work cycle, on the same way out.
 *
 * Reproduced against the built server before these cases existed: a review and
 * a chat turn spawned `detached` under `killProcessGroup` both outlived a group
 * `SIGINT` and a lone `SIGTERM`, because `killAllAgents` read only `procs` and
 * nothing else on the path read anything. The server exited in a tenth of a
 * second and said nothing. A fake handle rather than a real review, because
 * `spawnAssist` needs a run with a committed diff and a CLI; what these pin is
 * the registry's contract with the shutdown, which is the half that was missing.
 */
describe("shutting down with a child that is not a work cycle", () => {
  it("interrupts it with SIGINT and waits for it to settle", async () => {
    const signals: NodeJS.Signals[] = [];
    let settled = false;
    let untrack = () => {};
    const child = {
      pid: undefined as number | undefined,
      kill(sig: NodeJS.Signals) {
        signals.push(sig);
        // A beat later, as a CLI that handles the signal and prints its result
        // would, so returning before this is a shutdown that did not wait.
        setTimeout(() => {
          settled = true;
          untrack();
        }, 50);
        return true;
      },
    };
    untrack = trackAssistChild(child);

    await shutdownRuns("SIGINT");

    assert.equal(settled, true, "the shutdown returned before the child had settled");
    assert.deepEqual(
      signals,
      ["SIGINT"],
      "SIGINT first, and nothing harder for a child that settled on it",
    );
  });

  it("is in the final sweep, which is all a process that may not write gets", () => {
    const signals: NodeJS.Signals[] = [];
    const untrack = trackAssistChild({
      pid: undefined,
      kill(sig) {
        signals.push(sig);
        return true;
      },
    });
    try {
      killAllAgents("SIGKILL");
    } finally {
      untrack();
    }
    assert.deepEqual(signals, ["SIGKILL"]);
  });

  it("reaches a land's verify command, which is waited on and nothing else signals", async () => {
    // A real child, through the spawn this file otherwise replaces: what has to
    // hold is that the sweep reaches the process `runVerify` started, and the
    // fake exits on any signal it is handed. Its own timeout is the
    // fifteen-minute default, so nothing but the sweep can end it inside the
    // bound.
    const dir = fs.mkdtempSync(path.join(tmp, "verify-"));
    fs.writeFileSync(path.join(dir, "check.sh"), "sleep 6\n");
    const fakeSpawn = childProcess.spawn;
    childProcess.spawn = realSpawn;
    const started = Date.now();
    let verdict: ReturnType<typeof runVerify>;
    try {
      verdict = runVerify(dir, "sh check.sh");
    } finally {
      childProcess.spawn = fakeSpawn;
    }

    killAllAgents("SIGKILL");
    const outcome = await verdict;

    assert.ok(Date.now() - started < 4_000, "the check outlived the final sweep");
    assert.equal(outcome.passed, false);
  });

  it("refuses to start another once the process is going down", async () => {
    await shutdownRuns("SIGTERM");

    // The finding: nothing but `promoteQueued` read the flag, so a review, a
    // resolution, a validation or a chat turn asked for during the grace was
    // spawned, got no SIGINT, and left its row open for the next boot.
    assert.equal(await assistRefusal(), SHUTDOWN_REFUSAL);

    // And it outranks a full process budget, whose sentence the merge queue
    // deliberately asks again after: once per branch, in a process that is
    // exiting.
    const cap = getSettings().maxConcurrentAssists;
    const now = Date.now();
    saveSettings({ maxConcurrentAssists: 1 });
    db()
      .prepare("INSERT INTO chat_sessions (id, created_at, updated_at, status) VALUES (?,?,?,?)")
      .run("shutdown-chat", now, now, "thinking");
    try {
      assert.equal(await assistRefusal(), SHUTDOWN_REFUSAL);
    } finally {
      db().prepare("DELETE FROM chat_sessions WHERE id=?").run("shutdown-chat");
      saveSettings({ maxConcurrentAssists: cap });
    }
  });

  it("settles one that passed the door before the shutdown through `after`, and spawns nothing", async () => {
    await shutdownRuns("SIGTERM");

    // The state `startReview` and a resolution reach when the shutdown begins
    // inside the awaits between `assistRefusal` and `startAssist`: the door
    // said yes, and the process is now going down.
    db()
      .prepare(
        "INSERT INTO runs (id, folder, prompt, model, status, budget, max_iterations," +
          " iterations, created_at, spent_usd, spent_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "resolved-during-shutdown",
        path.join(tmp, "workspace", "project"),
        "task",
        null,
        "completed",
        "{}",
        1,
        1,
        Date.now(),
        0,
        0,
      );
    const run = getRun("resolved-during-shutdown")!;
    const spawnedBefore = spawned;
    const handed: { status: string; error?: string }[] = [];

    const started = startAssist({
      run,
      kind: "resolve",
      cwd: path.join(tmp, "workspace", "project"),
      permissionMode: "acceptEdits",
      prompt: "resolve the conflict",
      // A resolution's rollback — `merge --abort` and the checkout discarded —
      // lives here and nowhere else, so a refusal that skipped it would leave
      // the throwaway checkout mid-merge.
      after: async (result) => {
        handed.push({ status: result.status, error: result.error });
      },
    });
    assert.equal(started.ok, true);
    const id = started.ok ? started.id : "";

    await waitFor(
      () => getAssist(id)?.status !== "running",
      "the resolution's row to settle",
    );

    // The finding: the child was spawned during the grace, got no SIGINT
    // because the ladder snapshots its children at the signal, and left this
    // row `running` for the boot.
    assert.equal(spawned, spawnedBefore, "no child may be spawned once the process is going down");
    assert.deepEqual(
      handed,
      [{ status: "failed", error: SHUTDOWN_REFUSAL }],
      "`after` must run once, with the failure, so a resolution can roll back",
    );
    const row = getAssist(id)!;
    assert.equal(row.status, "failed");
    assert.equal(row.error, SHUTDOWN_REFUSAL);
  });
});

/**
 * A run that reaches its own ending while the shutdown waits on it.
 *
 * The shutdown used to flag every `running` row `restart_closed` the moment it
 * interrupted it, before that row's loop had ended, and a loop suspended at a
 * cycle boundary does not end on the interrupt: the verdict wait returns early
 * and the loop goes on to the ending the cycle earned. So a run whose agent had
 * replied DONE ended `completed` *and* flagged, the restart notice counted it,
 * and its one press re-queued a finished task under the pushback prompt — a
 * billed agent told to keep working on what it had finished.
 */
describe("shutting down while a run waits for its completion verdict", () => {
  it("leaves a run that finished on its own out of the restart notice", async () => {
    const validating = getSettings().validateTaskCompletion;
    saveSettings({ validateTaskCompletion: true });
    nextChildSaysDone = true;
    try {
      const run = createRun({
        folder: "project",
        mountId: null,
        prompt: "finish the task",
        budget: { maxIterations: 5 },
        origin: "form",
      });
      // A validation of a `complete_task` the cycle made, still running: the
      // verdict the loop waits for at the boundary before it takes the DONE.
      db()
        .prepare(
          "INSERT INTO run_reviews (id, run_id, created_at, status, kind)" +
            " VALUES (?, ?, ?, 'running', 'validate')",
        )
        .run(`validate-${run.id}`, run.id, Date.now());
      // An earlier case has shut down, so `promoteQueued` refuses.
      void startRun(run.id);
      await waitFor(() => {
        const row = getRun(run.id)!;
        return row.iterations === 1 && row.active_started_at === null;
      }, "the cycle to reply DONE");
      // Past the post-cycle interrupt check and into the verdict wait, whose
      // first poll is two seconds away.
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(getRun(run.id)!.status, "running");

      await shutdownRuns("SIGTERM");

      const settled = getRun(run.id)!;
      assert.equal(settled.status, "completed");
      assert.equal(settled.reported_done, 1);
      assert.equal(
        settled.restart_closed,
        0,
        "a run that reached its own ending was flagged as closed out by the restart",
      );

      await reconcileOnBoot();
      assert.ok(
        !restartClosedRuns().some((row) => row.id === run.id),
        "the restart notice offers, and its press re-queues, a run that had finished",
      );
    } finally {
      nextChildSaysDone = false;
      saveSettings({ validateTaskCompletion: validating });
    }
  });
});

/**
 * A graceful restart and a run told to start "after A, either way".
 *
 * The shutdown interrupts A mid-cycle, and A's loop writes the shutdown's
 * ending, `stopped` with its one cycle counted, then runs the release pass in
 * its `finally`. An `on-finish` edge is satisfied by any terminal status after
 * a cycle, so B was given a workspace and queued while the process was going
 * down; the boot stopped it as a queued row and flagged it `restart_closed`,
 * and the restart notice's one press reopened A and B together, to run side by
 * side. A crash already did the right thing: the boot writes B `blocked` behind
 * A, unflagged, and picking A up puts B back to waiting for it. These pin the
 * graceful path to that.
 */
describe("shutting down with a run waiting on the one it interrupts", () => {
  /** A working, B waiting on it with `on-finish`, then a shutdown and a boot. */
  async function shutDownBehind(label: string) {
    for (const folder of [`${label}-a`, `${label}-b`]) {
      fs.mkdirSync(path.join(tmp, "workspace", folder), { recursive: true });
    }
    const a = createRun({
      folder: `${label}-a`,
      mountId: null,
      prompt: "dependency A",
      budget: { maxIterations: 2 },
      origin: "form",
    });
    // An earlier case has shut down, so `promoteQueued` refuses and the loop is
    // started here; run alone, `createRun` will have started it already.
    if (getRun(a.id)!.status === "queued") void startRun(a.id);
    await waitFor(() => getRun(a.id)?.active_started_at !== null, "A's first work cycle");

    const b = createRun({
      folder: `${label}-b`,
      mountId: null,
      prompt: "dependent B, after A either way",
      budget: { maxIterations: 1 },
      origin: "form",
      dependsOn: [{ runId: a.id, edge: "on-finish" }],
    });
    assert.equal(getRun(b.id)!.status, "waiting");

    await shutdownRuns("SIGTERM");
    const afterShutdown = { a: getRun(a.id)!, b: getRun(b.id)! };
    await reconcileOnBoot();
    return { a, b, afterShutdown, afterBoot: getRun(b.id)! };
  }

  it("does not release the dependent, and the restart pick-up never runs them side by side", async () => {
    const { a, b, afterShutdown, afterBoot } = await shutDownBehind("graceful-press");

    // The shutdown's own ending on A, which is what B's edge was read against.
    assert.equal(afterShutdown.a.status, "stopped");
    assert.equal(afterShutdown.a.iterations, 1);
    assert.equal(afterShutdown.a.restart_closed, 1);

    assert.notEqual(
      afterShutdown.b.status,
      "queued",
      "the shutdown released B into the queue on the strength of the ending it gave A",
    );
    assert.equal(afterShutdown.b.work_dir, null, "B was given a workspace mid-shutdown");
    assert.notEqual(
      afterBoot.restart_closed,
      1,
      "B joined the restart notice's one-press pick-up beside the run it waits for",
    );
    assert.ok(
      !restartClosedRuns().some((row) => row.id === b.id),
      "the restart notice offers B as well as A",
    );

    const press = reopenRestartClosed();
    assert.ok(
      !press.refused.some((r) => r.id === a.id),
      `A was refused by the pick-up: ${JSON.stringify(press.refused)}`,
    );
    const promotable = selectPromotable(activeRuns(), null);
    assert.ok(promotable.includes(a.id), "the pick-up must make A promotable");
    assert.ok(
      !promotable.includes(b.id),
      "A and its on-finish dependent B were promotable together",
    );
    assert.equal(getRun(b.id)!.status, "waiting", "B goes back to waiting behind A");
  });

  it("puts the dependent back to waiting when that run is picked up by name", async () => {
    const { a, b, afterBoot } = await shutDownBehind("graceful-by-name");

    // What the crash path writes: ended with nothing spent, naming A, and
    // revivable, because it never reached a workspace.
    assert.equal(afterBoot.status, "blocked");
    assert.equal(afterBoot.work_dir, null);
    assert.equal(afterBoot.iterations, 0);
    assert.match(afterBoot.stop_reason ?? "", /restart closed out/);

    const outcome = reopenRun(a.id, JSON.parse(getRun(a.id)!.budget) as unknown);
    assert.ok(outcome.ok, outcome.ok ? "" : outcome.reason);
    assert.equal(getRun(a.id)!.status, "queued");
    assert.equal(
      getRun(b.id)!.status,
      "waiting",
      "picking A up must put B back to waiting for it, as it does after a crash",
    );
    assert.ok(!selectPromotable(activeRuns(), null).includes(b.id));
  });

  /**
   * A fan-in: B after both A and C, either way, and the operator picks up C
   * alone. Picking C up wakes B, and C's next ending ran the release pass, which
   * read A's restart ending as `on-finish` satisfied and queued B while A was
   * still closed out — so picking A up afterwards ran A and B side by side.
   */
  it("does not release a fan-in dependent when only one of its closed-out runs is picked up", async () => {
    const label = "graceful-fan-in";
    for (const folder of [`${label}-a`, `${label}-b`, `${label}-c`]) {
      fs.mkdirSync(path.join(tmp, "workspace", folder), { recursive: true });
    }
    const working = async (suffix: string) => {
      const run = createRun({
        folder: `${label}-${suffix}`,
        mountId: null,
        prompt: `dependency ${suffix.toUpperCase()}`,
        budget: { maxIterations: 3 },
        origin: "form",
      });
      if (getRun(run.id)!.status === "queued") void startRun(run.id);
      await waitFor(
        () => getRun(run.id)?.active_started_at !== null,
        `${suffix.toUpperCase()}'s first work cycle`,
      );
      return run;
    };
    const a = await working("a");
    const c = await working("c");
    const b = createRun({
      folder: `${label}-b`,
      mountId: null,
      prompt: "dependent B, after A and C either way",
      budget: { maxIterations: 1 },
      origin: "form",
      dependsOn: [
        { runId: a.id, edge: "on-finish" },
        { runId: c.id, edge: "on-finish" },
      ],
    });
    assert.equal(getRun(b.id)!.status, "waiting");

    await shutdownRuns("SIGTERM");
    await reconcileOnBoot();
    for (const run of [a, c]) {
      const row = getRun(run.id)!;
      assert.equal(row.status, "stopped");
      assert.equal(row.restart_closed, 1);
      assert.equal(row.iterations, 1);
    }
    assert.equal(getRun(b.id)!.status, "blocked");

    // C alone, by name, and then run and stopped: an ending that is not the
    // restart's, so B's pass decides on A's ending alone.
    const reopened = reopenRun(c.id, JSON.parse(getRun(c.id)!.budget) as unknown);
    assert.ok(reopened.ok, reopened.ok ? "" : reopened.reason);
    const loop = startRun(c.id);
    await waitFor(() => getRun(c.id)?.active_started_at !== null, "C's picked-up cycle");
    assert.equal(stopRun(c.id), "signalled");
    await loop;
    assert.equal(getRun(c.id)!.status, "stopped");
    assert.equal(getRun(c.id)!.restart_closed, 0);

    const stillClosed = getRun(a.id)!;
    assert.equal(stillClosed.status, "stopped");
    assert.equal(stillClosed.restart_closed, 1, "A has not been picked up");
    const behind = getRun(b.id)!;
    assert.notEqual(
      behind.status,
      "queued",
      "B was released on the strength of the restart's ending on A, which nobody has picked up",
    );
    assert.equal(behind.work_dir, null, "B was given a workspace while A is closed out");
    assert.equal(behind.status, "blocked");
    assert.match(
      behind.stop_reason ?? "",
      new RegExp(`run ${a.id.slice(0, 8)}, which the server restart closed out`),
      "B's reason must name the run still closed out, which picking up brings it back",
    );
    // A new run told to start after A is refused at the door rather than
    // released on the same reading and queued beside A's pick-up.
    assert.throws(
      () =>
        createRun({
          folder: `${label}-b`,
          mountId: null,
          prompt: "a later dependent, after A either way",
          budget: { maxIterations: 1 },
          origin: "form",
          dependsOn: [{ runId: a.id, edge: "on-finish" }],
        }),
      /closed out by a server restart and nobody has picked it up/,
    );

    // Which is what brings it back, behind A rather than beside it.
    const pickedUp = reopenRun(a.id, JSON.parse(stillClosed.budget) as unknown);
    assert.ok(pickedUp.ok, pickedUp.ok ? "" : pickedUp.reason);
    assert.equal(getRun(b.id)!.status, "waiting");
    assert.ok(!selectPromotable(activeRuns(), null).includes(b.id));
  });
});

/**
 * A shutdown or a Stop landing while a context-ceiling prune is pending.
 *
 * The ceiling ends a cycle with a `prune` interrupt, the one kind the loop's
 * post-cycle checkpoint consumes and carries on from. The map kept the first
 * interrupt it was given, so a shutdown landing between the prune being recorded
 * and that checkpoint was dropped: the loop pruned, refunded the cycle, found
 * nothing pending at its pre-scan, and spawned a billed cycle into the grace,
 * leaving the row `running` for the boot to fail with no word of the shutdown.
 * An operator's Stop went the same way, answered as a stop and then ignored.
 */
describe("a context-ceiling prune pending when the run is told to stop", () => {
  /** A run mid-cycle with the ceiling's prune recorded and its child still alive. */
  async function cycleWithPrunePending(prompt: string) {
    const run = createRun({
      folder: "project",
      mountId: null,
      prompt,
      budget: { maxIterations: 2 },
      origin: "form",
    });
    const loop = startRun(run.id);
    await waitFor(
      () => getRun(run.id)?.active_started_at !== null,
      "the work cycle to be stamped on the row",
    );
    const spawnedBefore = spawned;
    // What `checkContextCeilings` writes, with the child still alive: its own
    // signal has not yet taken effect, which is the window this is about.
    interrupts().set(run.id, {
      kind: "prune",
      reason: "This work cycle's context reached 210k tokens, so it was ended here to be pruned.",
      pause: false,
      at: Date.now(),
    });
    return { run, loop, spawnedBefore };
  }

  it("does not let the prune swallow the shutdown's interrupt", async () => {
    const { run, spawnedBefore } = await cycleWithPrunePending("work near the ceiling");

    await shutdownRuns("SIGTERM");

    const settled = getRun(run.id)!;
    assert.equal(spawned, spawnedBefore, "a work cycle was spawned during the shutdown's grace");
    assert.equal(settled.status, "stopped");
    assert.match(settled.stop_reason ?? "", /server shut down/);
    assert.equal(settled.restart_closed, 1, "the restart notice must offer it");
  });

  it("does not let it swallow an operator's Stop either", async () => {
    const { run, loop, spawnedBefore } = await cycleWithPrunePending("work near it again");

    assert.equal(stopRun(run.id), "signalled");
    // Not `await loop` first: against a swallowed Stop the loop is suspended on
    // a second child that nothing will ever signal.
    await waitFor(() => getRun(run.id)!.status !== "running", "the run to settle");
    await loop;

    const settled = getRun(run.id)!;
    assert.equal(spawned, spawnedBefore, "a work cycle was spawned after the Stop was answered");
    assert.equal(settled.status, "stopped");
    assert.match(settled.stop_reason ?? "", /Stopped by operator/);
    assert.equal(settled.restart_closed, 0);
  });
});

/**
 * The completion-verdict wait with an operator's Stop in place of the shutdown,
 * which must end the other way. The wait returns as soon as anything is pending,
 * and the loop took the DONE without reading what was: the press answered as if
 * it had stopped the run, and the run ended `completed` saying the agent had
 * finished. The shutdown's exception, pinned further up, is about the restart
 * notice, and nothing re-queues a run an operator stopped.
 */
describe("stopping a run while it waits for its completion verdict", () => {
  it("ends it stopped rather than completed", async () => {
    const validating = getSettings().validateTaskCompletion;
    saveSettings({ validateTaskCompletion: true });
    nextChildSaysDone = true;
    try {
      const run = createRun({
        folder: "project",
        mountId: null,
        prompt: "finish the task",
        budget: { maxIterations: 5 },
        origin: "form",
      });
      db()
        .prepare(
          "INSERT INTO run_reviews (id, run_id, created_at, status, kind)" +
            " VALUES (?, ?, ?, 'running', 'validate')",
        )
        .run(`validate-${run.id}`, run.id, Date.now());
      const loop = startRun(run.id);
      await waitFor(() => {
        const row = getRun(run.id)!;
        return row.iterations === 1 && row.active_started_at === null;
      }, "the cycle to reply DONE");
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(getRun(run.id)!.status, "running");

      assert.equal(stopRun(run.id), "cancelled", "between cycles there is no child to signal");
      await loop;

      const settled = getRun(run.id)!;
      assert.equal(
        settled.status,
        "stopped",
        "a Stop pressed during the verdict wait was answered and then ignored",
      );
      assert.match(settled.stop_reason ?? "", /Stopped by operator/);
      // Still what the agent replied: the column means that and nothing else.
      assert.equal(settled.reported_done, 1);
      assert.equal(settled.restart_closed, 0);
    } finally {
      nextChildSaysDone = false;
      saveSettings({ validateTaskCompletion: validating });
    }
  });
});
