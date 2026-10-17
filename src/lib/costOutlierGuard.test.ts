import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, it } from "node:test";

/**
 * That a run past `maxRunCostFactor` is ended at the next pre-cycle guard.
 *
 * `budget.test.ts` pins that the verdict is one a run may be ended on. This
 * pins the loop acting on it, because the defect was there: the code was missing
 * from `RUN_ENFORCEABLE_CODES`, so `startRun` logged `run.guard_unreadable`
 * beside a reason saying the run had been stopped, and spawned the next cycle.
 * Nothing threw and the run ended `completed`.
 *
 * Its own file with the environment set before anything is required, for the
 * reason every database-backed test here needs it: `config.ts` fixes `DATA_DIR`
 * and `CLAUDE_HOME` at module load.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-cost-outlier-")));
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

const { createRun, getRun } = require("./orchestrator") as typeof import("./orchestrator");
const { saveSettings } = require("./settings") as typeof import("./settings");

interface Cycle {
  spend: number;
  text: string;
}

/** What each child the loop spawns will do, in spawn order. */
let script: Cycle[] = [];
let spawns = 0;

const childProcess = require("node:child_process") as Record<string, unknown>;
const realSpawn = childProcess.spawn as typeof import("node:child_process").spawn;

childProcess.spawn = (bin: string, args: readonly string[], options: unknown) => {
  // Only the work cycle is stubbed; anything else the loop starts is itself.
  if (bin !== config.CLAUDE_BIN) {
    return (realSpawn as (...a: unknown[]) => unknown)(bin, args, options);
  }
  const n = spawns++;
  const cycle = script[n];
  assert.ok(cycle, `the loop spawned work cycle ${n + 1}, and the script has ${script.length}`);
  const session = `session-${Math.random().toString(16).slice(2)}`;

  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    // No pid, so `signalTree` skips `process.kill(-pid)`.
    pid: undefined as number | undefined,
    kill: () => true,
  });
  const usage = { input_tokens: 10, output_tokens: 5 };
  const events = [
    { type: "system", subtype: "init", session_id: session },
    {
      type: "assistant",
      session_id: session,
      message: {
        id: `msg_${n + 1}`,
        role: "assistant",
        content: [{ type: "text", text: cycle.text }],
        usage,
      },
    },
    {
      type: "result",
      subtype: "success",
      session_id: session,
      result: cycle.text,
      num_turns: 1,
      total_cost_usd: cycle.spend,
      usage,
    },
  ];
  stdout.on("end", () => {
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  });
  setImmediate(() => {
    for (const event of events) stdout.write(`${JSON.stringify(event)}\n`);
    stdout.end();
  });
  return child;
};

after(() => {
  childProcess.spawn = realSpawn;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function settled(id: string) {
  for (let i = 0; i < 1_000; i++) {
    const row = getRun(id)!;
    if (row.status !== "queued" && row.status !== "running") return row;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`run ${id} did not end`);
}

async function runToEnd(cycles: Cycle[], budget: Parameters<typeof createRun>[0]["budget"]) {
  script = cycles;
  spawns = 0;
  const run = createRun({
    folder: "project",
    mountId: null,
    prompt: "do the same thing",
    budget,
    origin: "form",
  });
  return settled(run.id);
}

describe("a run past its cost-outlier limit", () => {
  it("is stopped at the next pre-cycle guard rather than spawned again", async () => {
    saveSettings({ freshStartContextTokens: null });
    // Three completed runs of the same task at $1 is the baseline: a median of
    // $1 over `MIN_BASELINE_SAMPLES`.
    for (let i = 0; i < 3; i++) {
      const row = await runToEnd([{ spend: 1, text: "DONE" }], { maxIterations: 1 });
      assert.equal(row.status, "completed", row.stop_reason ?? "");
      assert.equal(row.spent_usd, 1);
    }

    const row = await runToEnd(
      [
        { spend: 10, text: "Still working." },
        { spend: 0.01, text: "DONE" },
      ],
      { maxIterations: 3, maxRunCostFactor: 2 },
    );
    assert.equal(spawns, 1, `spawned ${spawns} work cycles; ended ${row.status}: ${row.stop_reason}`);
    assert.equal(row.status, "stopped");
    assert.equal(row.ending_code, "guard:run_cost_outlier");
    assert.match(row.stop_reason ?? "", /10\.0x what this task has cost before/);
  });
});
