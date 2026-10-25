import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, it } from "node:test";

/**
 * What a run records as spent when its work cycles resume one session.
 *
 * The pinned CLI restores a resumed session's cost ledger from the transcript
 * and reports `total_cost_usd` as the session's running total, so the run loop
 * adding each cycle's figure whole charged cycle N for cycles 1..N — on
 * `runs.spent_usd`, on the pre-cycle `maxRunCostUSD` check and on the
 * `--max-budget-usd` remainder handed to the next child. Nothing threw and the
 * run page looked like a run that went well: the only evidence was a total
 * roughly double what the work cost, and a run stopped at half its limit.
 *
 * `cycleSpendOf` is the arithmetic and has its own cases in
 * `orchestrator.test.ts`. This pins the wiring, which is where the defect was —
 * the old helper was correct for one child and the loop fed it the wrong
 * baseline — so it drives real runs through `startRun` against a stubbed
 * child that behaves as the premise says the CLI does: a `--resume` restores
 * the ledger the last child of that session saved, and a fresh session starts
 * at zero. The premise itself was read off the 2.1.280 binary rather than run,
 * and `docs/verification/metering-and-cost.md` says so.
 *
 * Its own file with the environment set before anything is required, for the
 * reason every database-backed test here needs it: `config.ts` fixes `DATA_DIR`
 * and `CLAUDE_HOME` at module load.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-resumed-spend-")));
fs.mkdirSync(path.join(tmp, "workspace", "project"), { recursive: true });

process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
// Pinned rather than left to fall back to CLAUDE_HOME, `orchestrator.test.ts`'s
// rule: an ambient one puts a real OAuth token within reach of anything here
// that reads plan usage.
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");
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

const { createRun, getRun, reopenRun, runEvents } =
  require("./orchestrator") as typeof import("./orchestrator");
const { saveSettings } = require("./settings") as typeof import("./settings");
const { installSpend } = require("./installBudget") as typeof import("./installBudget");
const { db } = require("./db") as typeof import("./db");

interface Cycle {
  /** What this child spends of its own. */
  spend: number;
  /** The window its last turn reports, which is what `startsFresh` reads. */
  window: number;
  /**
   * How its `result` ends the cycle when it is not a success: the CLI writes
   * `error_max_budget_usd` and exits 1 when it stops at the limit it was handed.
   */
  subtype?: string;
}

/**
 * A `--resume` the CLI gives up on before doing anything: it names some other
 * session, reports nothing and exits 1, after `exitAfterMs`.
 */
interface FailedResume {
  names: string;
  exitAfterMs: number;
}

/** What each child the loop spawns will do, in spawn order. */
let script: Array<Cycle | FailedResume> = [];
/**
 * What each child was asked to `--resume`, the limit it was handed, and the
 * limit its run's row says it was handed.
 */
let spawns: Array<{ resumed: string | null; ceiling: string | null; stamped: number | null }> =
  [];
/** Each session's saved ledger, as the transcript's `cost-state` would hold it. */
const ledgers = new Map<string, number>();

function flag(args: readonly string[], name: string): string | null {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : null;
}

const childProcess = require("node:child_process") as Record<string, unknown>;
const realSpawn = childProcess.spawn as typeof import("node:child_process").spawn;

childProcess.spawn = (bin: string, args: readonly string[], options: unknown) => {
  // Only the work cycle is stubbed; anything else the loop starts is itself.
  if (bin !== config.CLAUDE_BIN) {
    return (realSpawn as (...a: unknown[]) => unknown)(bin, args, options);
  }
  const n = spawns.length;
  const cycle = script[n];
  assert.ok(cycle, `the loop spawned work cycle ${n + 1}, and the script has ${script.length}`);
  const resumed = flag(args, "--resume");
  const row = db()
    .prepare("SELECT active_budget_usd AS stamped FROM runs WHERE active_started_at IS NOT NULL")
    .get() as { stamped: number | null };
  spawns.push({ resumed, ceiling: flag(args, "--max-budget-usd"), stamped: row.stamped });

  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    // No pid, so `signalTree` skips `process.kill(-pid)`.
    pid: undefined as number | undefined,
    kill: () => true,
  });

  if ("names" in cycle) {
    // The ledger it was asked for is untouched: nothing was done in it.
    stdout.on("end", () => {
      setTimeout(() => {
        child.emit("exit", 1, null);
        child.emit("close", 1, null);
      }, cycle.exitAfterMs);
    });
    setImmediate(() => {
      stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: cycle.names })}\n`);
      stdout.end();
    });
    return child;
  }

  const session = resumed ?? `session-${n + 1}`;
  const total = (resumed === null ? 0 : (ledgers.get(resumed) ?? 0)) + cycle.spend;
  ledgers.set(session, total);

  const events = [
    { type: "system", subtype: "init", session_id: session },
    {
      type: "assistant",
      session_id: session,
      message: {
        id: `msg_${n + 1}`,
        role: "assistant",
        content: [{ type: "text", text: "Still working." }],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: cycle.window },
      },
    },
    {
      type: "result",
      subtype: cycle.subtype ?? "success",
      is_error: cycle.subtype !== undefined,
      session_id: session,
      result: "Still working.",
      num_turns: 1,
      total_cost_usd: total,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  ];
  const exitCode = cycle.subtype === undefined ? 0 : 1;
  // Settled on `end`, so every line has been read before `close` says so.
  stdout.on("end", () => {
    child.emit("exit", exitCode, null);
    child.emit("close", exitCode, null);
  });
  setImmediate(() => {
    for (const e of events) stdout.write(`${JSON.stringify(e)}\n`);
    stdout.end();
  });
  return child;
};

after(() => {
  childProcess.spawn = realSpawn;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Wait for the segment in flight to end, however it ends. */
async function settled(id: string) {
  for (let i = 0; i < 1_000; i++) {
    const row = getRun(id)!;
    if (row.status !== "queued" && row.status !== "running") return row;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`run ${id} did not end`);
}

async function runToEnd(
  cycles: Array<Cycle | FailedResume>,
  budget: Parameters<typeof createRun>[0]["budget"],
  /**
   * Called with the run's id before anything the loop does can have run:
   * `createRun` returns synchronously and `startRun` does not read a guard until
   * after its first `await`, so a row written here is one the first pre-cycle
   * guard sees. It is how a run is made a member of a workflow, which `createRun`
   * has no way to say.
   */
  beforeFirstGuard?: (runId: string) => void,
) {
  script = cycles;
  spawns = [];
  const run = createRun({
    folder: "project",
    mountId: null,
    prompt: "do the thing",
    budget,
    origin: "form",
  });
  beforeFirstGuard?.(run.id);
  return settled(run.id);
}

const SMALL = 1_000;

describe("a run whose work cycles resume one session", () => {
  it("records the sum of each cycle's increase, not of the running totals", async () => {
    saveSettings({ freshStartContextTokens: null });
    const row = await runToEnd(
      [
        { spend: 3, window: SMALL },
        { spend: 5, window: SMALL },
        { spend: 2, window: SMALL },
      ],
      { maxIterations: 3 },
    );

    assert.deepEqual(
      spawns.map((s) => s.resumed),
      [null, "session-1", "session-1"],
      "the fixture must be one session resumed twice",
    );
    assert.equal(row.iterations, 3);
    // The CLI reported $3, $8 and $10. Added whole they are $21.
    assert.equal(row.spent_usd, 10);
    assert.equal(row.session_cost_usd, 10, "the next resume is measured from here");
    // And each "cycle done" row, which the feed shows and `run.cycle_finished`
    // logs, is that cycle's own figure. Measured from zero they read $3, $8
    // and $10, and a reader adding up the feed gets the same $21.
    assert.deepEqual(
      runEvents(row.id)
        .events.filter((e) => e.kind === "result")
        .map((e) => e.payload.costUSD),
      [3, 5, 2],
    );
  });

  it("lets the cost guard read that same figure", async () => {
    saveSettings({ freshStartContextTokens: null });
    const row = await runToEnd(
      [
        { spend: 4, window: SMALL },
        { spend: 4, window: SMALL },
        { spend: 4, window: SMALL },
      ],
      { maxIterations: 3, maxRunCostUSD: 10 },
    );

    // $8 of a $10 limit spent after two cycles, so the third is admitted. Read
    // as $4 + $8, the run was stopped at $12 before it.
    assert.equal(row.iterations, 3, `stopped early: ${row.stop_reason}`);
    assert.equal(row.spent_usd, 12);
    // And what reaches the CLI as its own limit is the same remainder.
    assert.deepEqual(
      spawns.map((s) => s.ceiling),
      ["10", "6", "2"],
    );
    // And the row says the same, because the install and workflow limits cap
    // what the cycle's own telemetry adds to their figures at it.
    assert.deepEqual(
      spawns.map((s) => s.stamped),
      [10, 6, 2],
    );
  });

  it("starts a new baseline when a cycle opens a fresh session", async () => {
    // The first cycle ends on a window past the threshold, so the second
    // drops the conversation. Its ledger starts at zero and its figure is its
    // own; the third resumes it and is measured from it.
    saveSettings({ freshStartContextTokens: 100_000 });
    try {
      const row = await runToEnd(
        [
          { spend: 4, window: 150_000 },
          { spend: 6, window: SMALL },
          { spend: 1, window: SMALL },
        ],
        { maxIterations: 3 },
      );

      assert.deepEqual(
        spawns.map((s) => s.resumed),
        [null, null, "session-2"],
        "the fixture must start its second cycle fresh",
      );
      // $4, then a new session's $6 whole — subtracting the old session's $4
      // from it would bank $2 — then $7 less that $6.
      assert.equal(row.spent_usd, 11);
      assert.equal(row.session_cost_usd, 7);
      // The feed's rows follow the same baseline, the fresh session's whole.
      assert.deepEqual(
        runEvents(row.id)
          .events.filter((e) => e.kind === "result")
          .map((e) => e.payload.costUSD),
        [4, 6, 1],
      );
    } finally {
      saveSettings({ freshStartContextTokens: null });
    }
  });

  it("keeps the baseline a failed resume's retry restored when the segment ends before the retry", async () => {
    saveSettings({ freshStartContextTokens: null });
    const first = await runToEnd(
      [
        { spend: 3, window: SMALL },
        // Outlasts the second segment's time limit, so the pre-cycle guard
        // ends it after the retry has restored the baseline and before the
        // retry spawns.
        { names: "junk-session", exitAfterMs: 1_500 },
        { spend: 2, window: SMALL },
      ],
      { maxIterations: 1 },
    );
    assert.equal(first.session_cost_usd, 3);

    const second = reopenRun(first.id, { maxIterations: 5, maxDurationMinutes: 0.02 });
    assert.ok(second.ok, JSON.stringify(second));
    const cut = await settled(first.id);
    assert.equal(cut.status, "stopped", cut.stop_reason ?? "");
    assert.equal(cut.session_id, "session-1");
    // The failed cycle's own write nulled it, because the stream named another
    // ledger; the retry's restore lived only in the loop's frame.
    assert.equal(cut.session_cost_usd, 3, "the ledger session-1 stands at was lost with the segment");

    const third = reopenRun(first.id, { maxIterations: 2, maxDurationMinutes: 60 });
    assert.ok(third.ok, JSON.stringify(third));
    const row = await settled(first.id);
    assert.deepEqual(
      spawns.map((s) => s.resumed),
      [null, "session-1", "session-1"],
      "the fixture must be one session, resumed by a failure and then by a cycle",
    );
    // The CLI reported $3, then $5 for session-1. Measured from no baseline
    // the $5 is banked whole and the run reads $8.
    assert.equal(row.spent_usd, 5);
    assert.deepEqual(
      runEvents(row.id)
        .events.filter((e) => e.kind === "result")
        .map((e) => e.payload.costUSD),
      [3, 2],
    );
  });
});

describe("a run with no spending limit of its own, under the install's or its workflow's", () => {
  // The cycle's own telemetry reaches every other run's install and workflow
  // figures, and its ingest token is in its own environment, so a cycle with no
  // `--max-budget-usd` could post any figure it liked into them. These drive the
  // loop because the defect would be in the wiring: the pure choice
  // (`cycleBudgetUSD`) is right with every input and says nothing about which
  // inputs `startRun` reads, when, or whether the row and the argv agree.

  /** What the install holds already, so a limit can be set a known distance above it. */
  const heldBefore = () => installSpend().spentGuardUSD;

  it("hands the install's headroom to each cycle and stamps the figure it handed", async () => {
    saveSettings({ freshStartContextTokens: null });
    saveSettings({ installDailyCostLimitUSD: heldBefore() + 20 });
    try {
      await runToEnd(
        [
          { spend: 4, window: SMALL },
          { spend: 4, window: SMALL },
        ],
        { maxIterations: 2 },
      );
      // $20 left, then $16 once the first cycle's $4 is on the run: the figure
      // the install guard would have refused the run at, less than which nothing
      // it would have admitted is cut off.
      assert.deepEqual(
        spawns.map((s) => s.ceiling),
        ["20", "16"],
      );
      assert.deepEqual(
        spawns.map((s) => s.stamped),
        [20, 16],
      );
    } finally {
      saveSettings({ installDailyCostLimitUSD: null });
    }
  });

  it("hands none when no limit applies, and the run's own limit when that is the smaller", async () => {
    saveSettings({ freshStartContextTokens: null });
    await runToEnd([{ spend: 1, window: SMALL }], { maxIterations: 1 });
    assert.deepEqual(spawns.map((s) => [s.ceiling, s.stamped]), [[null, null]]);

    saveSettings({ installDailyCostLimitUSD: heldBefore() + 20 });
    try {
      await runToEnd([{ spend: 1, window: SMALL }], { maxIterations: 1, maxRunCostUSD: 3 });
      assert.deepEqual(spawns.map((s) => [s.ceiling, s.stamped]), [["3", 3]]);
    } finally {
      saveSettings({ installDailyCostLimitUSD: null });
    }
  });

  it("hands a member of a workflow the tighter of that and the install's headroom", async () => {
    saveSettings({ freshStartContextTokens: null });
    // The install has far more room than the workflow, which has $12 less the
    // $2 a sibling already spent.
    saveSettings({ installDailyCostLimitUSD: heldBefore() + 2 + 1_000 });
    try {
      await runToEnd(
        [
          { spend: 4, window: SMALL },
          { spend: 4, window: SMALL },
        ],
        { maxIterations: 2 },
        (runId) => {
          const at = Date.now();
          db()
            .prepare("INSERT INTO workflows (id, name, graph, created_at, updated_at) VALUES ('wf-hr', 'hr', '{}', ?, ?)")
            .run(at, at);
          db()
            .prepare(
              `INSERT INTO workflow_instances (id, workflow_id, workflow_name, graph, created_at, status, instance_budget)
               VALUES ('inst-hr', 'wf-hr', 'hr', '{"nodes":[],"edges":[]}', ?, 'started', '{"maxInstanceCostUSD":12}')`,
            )
            .run(at);
          db()
            .prepare(
              `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, created_at, finished_at, spent_usd)
               VALUES ('run-hr-sibling', 'project', 'work', 'completed', '{"maxIterations":1}', 1, ?, ?, 2)`,
            )
            .run(at, at);
          const member = db().prepare(
            "INSERT INTO workflow_instance_runs (instance_id, node_id, node_name, position, run_id) VALUES ('inst-hr', ?, ?, ?, ?)",
          );
          member.run("n0", "Sibling", 0, "run-hr-sibling");
          member.run("n1", "Member", 1, runId);
        },
      );
      assert.deepEqual(
        spawns.map((s) => [s.ceiling, s.stamped]),
        [
          ["10", 10],
          ["6", 6],
        ],
      );
    } finally {
      saveSettings({ installDailyCostLimitUSD: null });
    }
  });

  it("ends a cycle the CLI stops at that headroom on the install's limit, not on a limit of its own", async () => {
    saveSettings({ freshStartContextTokens: null });
    saveSettings({ installDailyCostLimitUSD: heldBefore() + 20 });
    try {
      const row = await runToEnd(
        [{ spend: 20, window: SMALL, subtype: "error_max_budget_usd" }],
        { maxIterations: 3 },
      );
      assert.equal(spawns.length, 1, "a run stopped at its limit goes no further");
      assert.equal(row.status, "stopped");
      // The same ending the pre-cycle guard gives a run at this limit. `cli_budget`
      // is for a limit nobody here set, and this one is the operator's.
      assert.equal(row.ending_code, "guard:install_cost");
      assert.match(row.stop_reason ?? "", /\$20\.00 left of the install's rolling spending limit of \$\d+\.\d\d/);
    } finally {
      saveSettings({ installDailyCostLimitUSD: null });
    }
  });
});

describe("a run with a spending limit of its own larger than the install's headroom", () => {
  // Its own limit used to win outright, so the cycle was handed $100 under an
  // install with $5 left, and its telemetry was capped at $100 in the figure
  // every other run's door reads: one forged `cost_usd` filled the install as
  // surely as an uncapped cycle's did. Driven through the loop because the
  // defect was in which inputs `startRun` read: it took no headroom at all for
  // a run with a limit.
  const heldBefore = () => installSpend().spentGuardUSD;

  it("hands the headroom to argv and row alike, and ends a stop there on the install's limit", async () => {
    saveSettings({ freshStartContextTokens: null });
    saveSettings({ installDailyCostLimitUSD: heldBefore() + 5 });
    try {
      const row = await runToEnd(
        [{ spend: 5, window: SMALL, subtype: "error_max_budget_usd" }],
        { maxIterations: 3, maxRunCostUSD: 100 },
      );
      assert.deepEqual(spawns.map((s) => [s.ceiling, s.stamped]), [["5", 5]]);
      assert.equal(row.status, "stopped");
      // The run still had $100 of its own; naming that limit would send the
      // operator to raise one that did not bind.
      assert.equal(row.ending_code, "guard:install_cost");
      assert.match(row.stop_reason ?? "", /\$5\.00 left of the install's rolling spending limit of \$\d+\.\d\d/);
    } finally {
      saveSettings({ installDailyCostLimitUSD: null });
    }
  });

  it("still ends a stop at the run's own limit on that limit when it is the smaller", async () => {
    saveSettings({ freshStartContextTokens: null });
    saveSettings({ installDailyCostLimitUSD: heldBefore() + 20 });
    try {
      const row = await runToEnd(
        [{ spend: 3, window: SMALL, subtype: "error_max_budget_usd" }],
        { maxIterations: 3, maxRunCostUSD: 3 },
      );
      assert.deepEqual(spawns.map((s) => [s.ceiling, s.stamped]), [["3", 3]]);
      assert.equal(row.ending_code, "guard:run_cost");
      assert.match(row.stop_reason ?? "", /this run's \$3\.00 spending limit/);
    } finally {
      saveSettings({ installDailyCostLimitUSD: null });
    }
  });
});
