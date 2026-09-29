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

const { createRun, getRun } = require("./orchestrator") as typeof import("./orchestrator");
const { saveSettings } = require("./settings") as typeof import("./settings");

interface Cycle {
  /** What this child spends of its own. */
  spend: number;
  /** The window its last turn reports, which is what `startsFresh` reads. */
  window: number;
}

/** What each child the loop spawns will do, in spawn order. */
let script: Cycle[] = [];
/** What each child was asked to `--resume`, and the ceiling it was handed. */
let spawns: Array<{ resumed: string | null; ceiling: string | null }> = [];
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
  spawns.push({ resumed, ceiling: flag(args, "--max-budget-usd") });

  const session = resumed ?? `session-${n + 1}`;
  const total = (resumed === null ? 0 : (ledgers.get(resumed) ?? 0)) + cycle.spend;
  ledgers.set(session, total);

  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    // No pid, so `signalTree` skips `process.kill(-pid)`.
    pid: undefined as number | undefined,
    kill: () => true,
  });
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
      subtype: "success",
      session_id: session,
      result: "Still working.",
      num_turns: 1,
      total_cost_usd: total,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  ];
  // Settled on `end`, so every line has been read before `close` says so.
  stdout.on("end", () => {
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
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

async function runToEnd(
  cycles: Cycle[],
  budget: Parameters<typeof createRun>[0]["budget"],
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
  for (let i = 0; i < 1_000; i++) {
    const row = getRun(run.id)!;
    if (row.status !== "queued" && row.status !== "running") return row;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`run ${run.id} did not end`);
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
    // And what reaches the CLI as its own ceiling is the same remainder.
    assert.deepEqual(
      spawns.map((s) => s.ceiling),
      ["10", "6", "2"],
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
    } finally {
      saveSettings({ freshStartContextTokens: null });
    }
  });
});
