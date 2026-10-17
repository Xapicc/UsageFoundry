import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, it } from "node:test";

/**
 * A Codex work cycle that ends without `turn.completed`, and what its run is
 * charged for it.
 *
 * `turn.completed` is the only way a Codex cycle's tokens reached
 * `runs.spent_tokens`, so a cycle killed by the live `run_tokens` guard, by
 * Stop, by the silence watchdog or by a restart, or ended by `turn.failed`,
 * added nothing — although its rollout had recorded every request. `maxRunTokens`
 * is the one spending guard a Codex run has, and it reads
 * `spent_tokens + spent_tokens_est`, so a run stopped at 120,500 tokens of a
 * 100,000 limit could be reopened and cross the limit again on every pick-up,
 * with its recorded total never moving.
 *
 * Drives the real run loop against a stubbed child, as `shutdown.test.ts` does,
 * because the defect is in what the loop does *after* the child returns — no
 * test of the rollout reader could say it banked nothing.
 *
 * Its own file with the environment set before anything is required, for the
 * reason every database-backed test here needs it.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-codex-killed-")));
const codexHome = path.join(tmp, "codex-home");
fs.mkdirSync(codexHome, { recursive: true });
fs.mkdirSync(path.join(tmp, "workspace", "project"), { recursive: true });

process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
process.env.CODEX_HOME = codexHome;
process.env.WORKSPACE_ROOT = path.join(tmp, "workspace");
delete process.env.WORKSPACE_ROOTS;
process.env.CLAUDE_BIN = path.join(tmp, "no-such-claude");
process.env.CODEX_BIN = path.join(tmp, "no-such-codex");

const config = require("./config") as typeof import("./config");
assert.equal(
  config.DATA_DIR,
  process.env.DATA_DIR,
  "config was already loaded by another test file in this process — refusing to " +
    "run against the real database",
);

const {
  createRun,
  getRun,
  reconcileInterruptedCycles,
  reopenRun,
  runEvents,
  stopRun,
  unmeasuredSpendNotice,
} =
  require("./orchestrator") as typeof import("./orchestrator");
const { db } = require("./db") as typeof import("./db");

const LIMIT = 100_000;

/** A UUIDv7 whose creation instant is `at`, which is how the rollout's day directory is found. */
function threadIdAt(at: number, tail: string): string {
  const hex = at.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-${tail.padStart(12, "0")}`;
}

const tokenLine = (totalTokens: number, at: number) =>
  JSON.stringify({
    timestamp: new Date(at).toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: totalTokens - 500,
          output_tokens: 500,
        },
        last_token_usage: { input_tokens: 40_000, output_tokens: 1 },
        model_context_window: 258_400,
      },
    },
  });

/** Write (or append to) a thread's rollout where the CLI keeps it. */
function appendRollout(threadId: string, lines: string[]): string {
  const created = new Date(parseInt(threadId.replace(/-/g, "").slice(0, 12), 16));
  const pad = (n: number) => String(n).padStart(2, "0");
  const dir = path.join(
    codexHome,
    "sessions",
    String(created.getUTCFullYear()),
    pad(created.getUTCMonth() + 1),
    pad(created.getUTCDate()),
  );
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${created.toISOString().slice(0, 19).replace(/:/g, "-")}-${threadId}.jsonl`);
  fs.appendFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

type Script = (play: {
  write: (event: Record<string, unknown>) => void;
  finish: (code: number) => void;
}) => void;

const childProcess = require("node:child_process") as Record<string, unknown>;
const realSpawn = childProcess.spawn as typeof import("node:child_process").spawn;
let spawned = 0;
let script: Script = () => {};

childProcess.spawn = () => {
  spawned += 1;
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    // No pid, so `signalTree` has no process group to signal.
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
  script({
    write: (event) => stdout.write(`${JSON.stringify(event)}\n`),
    finish: (code) =>
      setImmediate(() => {
        stdout.end();
        child.emit("exit", code, null);
        child.emit("close", code, null);
      }),
  });
  return child;
};

after(() => {
  childProcess.spawn = realSpawn;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

const FINISHED = ["completed", "stopped", "failed", "blocked", "paused"];

function startCodexRun(maxRunTokens: number | null = LIMIT) {
  return createRun({
    folder: "project",
    mountId: null,
    prompt: "do the thing",
    provider: "codex",
    budget: { maxIterations: 5, maxRunTokens, enforcement: "between-cycles" },
    origin: "form",
  });
}

describe("a Codex cycle that ends without turn.completed", () => {
  it("banks what its rollout recorded, so a run stopped at its token limit cannot be reopened under it", async () => {
    const now = Date.now();
    const thread = threadIdAt(now, "1");
    spawned = 0;
    script = ({ write }) => {
      // Three requests, the last at 120,500 tokens: over the 100,000 limit.
      appendRollout(thread, [
        tokenLine(41_000, now + 1),
        tokenLine(82_000, now + 2),
        tokenLine(120_500, now + 3),
      ]);
      write({ type: "thread.started", thread_id: thread });
      write({ type: "turn.started" });
      write({
        type: "item.started",
        item: { id: "i1", type: "command_execution", command: "npm test", status: "in_progress" },
      });
    };

    const run = startCodexRun();
    await waitFor(() => getRun(run.id)?.session_id === thread, "the thread on the row");
    assert.equal(stopRun(run.id), "signalled", "Stop must reach the live child");
    await waitFor(() => FINISHED.includes(getRun(run.id)!.status), "the run to end");

    const settled = getRun(run.id)!;
    assert.equal(settled.spent_tokens, 0, "no turn.completed arrived, so nothing was reported");
    assert.ok(
      settled.spent_tokens + settled.spent_tokens_est >= 120_500,
      `the cycle's 120,500 recorded tokens must be on the row, got ${settled.spent_tokens} + ${settled.spent_tokens_est}`,
    );

    const reopened = reopenRun(run.id, { maxIterations: 5, maxRunTokens: LIMIT });
    assert.equal(reopened.ok, false, "a run already past its token limit must not be reopened under it");
    if (!reopened.ok) assert.match(reopened.reason, /120,500 tokens/);
    assert.equal(spawned, 1, "the refused pick-up must not have spawned a second cycle");

    assert.match(
      getRun(run.id)!.stop_reason ?? "",
      /token count is understated/,
      "the ending must not call the count measured",
    );
  });

  it("banks them for a cycle that ends in turn.failed too", async () => {
    const now = Date.now();
    const thread = threadIdAt(now, "2");
    script = ({ write, finish }) => {
      appendRollout(thread, [tokenLine(30_000, now + 1), tokenLine(64_000, now + 2)]);
      write({ type: "thread.started", thread_id: thread });
      write({ type: "turn.started" });
      write({ type: "turn.failed", error: { message: "the model refused a later request" } });
      finish(1);
    };

    const run = startCodexRun(null);
    await waitFor(() => FINISHED.includes(getRun(run.id)?.status ?? ""), "the run to end");

    const settled = getRun(run.id)!;
    assert.equal(settled.spent_tokens, 0);
    assert.equal(settled.spent_tokens_est, 64_000);
  });

  it("does not bank a cycle that reported its own usage, which would count it twice", async () => {
    const now = Date.now();
    const thread = threadIdAt(now, "3");
    script = ({ write, finish }) => {
      appendRollout(thread, [tokenLine(30_000, now + 1), tokenLine(64_000, now + 2)]);
      write({ type: "thread.started", thread_id: thread });
      write({ type: "turn.started" });
      write({
        type: "item.completed",
        item: { id: "m1", type: "agent_message", text: "DONE" },
      });
      write({
        type: "turn.completed",
        usage: { input_tokens: 63_500, output_tokens: 500 },
      });
      finish(0);
    };

    const run = startCodexRun(null);
    await waitFor(() => FINISHED.includes(getRun(run.id)?.status ?? ""), "the run to end");

    const settled = getRun(run.id)!;
    assert.equal(settled.spent_tokens, 64_000);
    assert.equal(settled.spent_tokens_est, 0);
    assert.doesNotMatch(settled.stop_reason ?? "", /understated/);
  });
});

describe("a Codex cycle a restart left open", () => {
  function seedInterrupted(thread: string, startedAt: number) {
    const id = `restart-${thread.slice(-4)}`;
    db()
      .prepare(
        `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                           created_at, provider, session_id, active_iteration, active_started_at)
         VALUES (?, ?, 'do the thing', 'running', '{}', 5, 1, ?, 'codex', ?, 2, ?)`,
      )
      .run(id, path.join(tmp, "workspace", "project"), startedAt - 1000, thread, startedAt);
    return id;
  }

  it("is read from the thread's rollout from where the cycle began, not from Claude's transcripts", async () => {
    const earlier = Date.now() - 60_000;
    const thread = threadIdAt(earlier, "4");
    // An earlier cycle's lines, which a resumed thread keeps ahead of this one's.
    appendRollout(thread, [tokenLine(50_000, earlier + 1), tokenLine(90_000, earlier + 2)]);
    const startedAt = Date.now();
    appendRollout(thread, [tokenLine(20_000, startedAt + 1), tokenLine(77_000, startedAt + 2)]);
    const id = seedInterrupted(thread, startedAt);

    await reconcileInterruptedCycles("crash");

    const row = getRun(id)!;
    assert.equal(row.spent_tokens_est, 77_000, "only the interrupted cycle's own total");
    assert.equal(row.spent_tokens, 0);
    assert.equal(row.active_started_at, null);
    const said = runEvents(id).events.map((e) => JSON.stringify(e.payload)).join("\n");
    assert.doesNotMatch(said, /Claude Code never reported/, "Claude's reconciliation must not run for Codex");
    assert.match(said, /77,000 tokens/);
  });

  it("says so when no rollout can be found, rather than charging nothing quietly", async () => {
    const startedAt = Date.now();
    const id = seedInterrupted(threadIdAt(startedAt, "5"), startedAt);

    await reconcileInterruptedCycles("crash");

    const row = getRun(id)!;
    assert.equal(row.spent_tokens_est, 0);
    assert.match(
      runEvents(id).events.map((e) => JSON.stringify(e.payload)).join("\n"),
      /missing from this run's total/,
    );
  });
});

describe("unmeasuredSpendNotice", () => {
  it("calls a Codex run's tokens measured only when every cycle reported", () => {
    assert.match(unmeasuredSpendNotice("codex", false, 0), /Its token count is measured\.$/);
  });

  it("says understated, and how much came from the rollout, when a cycle was cut short", () => {
    const notice = unmeasuredSpendNotice("codex", true, 120_500);
    assert.match(notice, /understated/);
    assert.match(notice, /120,500 tokens/);
    assert.doesNotMatch(notice, /is measured/);
  });

  it("still says understated on a later segment, where only the banked column survives", () => {
    assert.match(unmeasuredSpendNotice("codex", false, 64_000), /understated/);
  });

  it("does not claim a count it could not read", () => {
    assert.match(unmeasuredSpendNotice("codex", true, 0), /None of that cycle's tokens/);
  });
});
