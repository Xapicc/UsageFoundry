import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";

/**
 * The restart notice's press refuses a stored fraction guard with nothing to
 * read, per run, and leaves that run `restart_closed`.
 *
 * `reopenRestartClosed` hands `reopenRun` each run's own stored blob unchanged,
 * and `reopenRun` carries a fraction forward without asking whether its window
 * can be read; the pre-cycle guard only records that (`RUN_ENFORCEABLE_CODES`).
 * So a run closed by a restart whose blob held `maxWeeklyFraction`, picked up on
 * an install with no reading for that window, spawned its cycle with the guard
 * unread. The press is a bulk one by a person, so the refusal is per run and in
 * the answer's `refused` list, as `POST /api/fleet` `reopen` has it
 * (`fleet/route.test.ts`, whose last describe this one is shaped like).
 *
 * Route-level, because the gap was between the route and the loop: the route
 * fetches the readings, the loop judges with them, and a unit test of either
 * half passes with the other missing. Its own file with `DATA_DIR` named before
 * the first import, for `runOrigin.test.ts`'s reason: `config.ts` is read at
 * module load. The fleet is paused, so a run a regression lets through is never
 * promoted to a spawn.
 */

const STORED = { maxIterations: 5, maxRunCostUSD: 5 };

let root: string;
let press: () => Promise<{ status: number; body: Record<string, unknown> }>;
let newRestartClosedRun: (
  budget?: Record<string, unknown>,
  provider?: "claude" | "codex",
) => string;
let statusOf: (runId: string) => string;
let restartClosed: (runId: string) => number;
let storedBudget: (runId: string) => Record<string, unknown>;
let clearNotice: () => void;

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-restarted-route-")));
  fs.mkdirSync(path.join(root, "workspace"), { recursive: true });
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  // An empty home, so a Codex run has no sign-in and therefore no reading,
  // whatever this machine's own `~/.codex` holds.
  process.env.CODEX_HOME = path.join(root, "codex");
  process.env.WORKSPACE_ROOTS = `Scratch=${path.join(root, "workspace")}`;
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  const config = await import("../../../../lib/config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );
  (await import("../../../../lib/fleet")).setFleetPaused(true);
  const { db } = await import("../../../../lib/db");
  const { POST } = await import("./route");

  let serial = 0;
  newRestartClosedRun = (budget = STORED, provider = "claude") => {
    const id = `run-restarted-${serial++}`;
    // One folder each, so the pick-ups never contend for a checkout and what a
    // case asserts is the guard's refusal and nothing about occupancy.
    const folder = path.join(root, "workspace", id);
    fs.mkdirSync(folder, { recursive: true });
    db()
      .prepare(
        "INSERT INTO runs (id, folder, prompt, status, budget, created_at, provider, restart_closed)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
      )
      .run(id, folder, "task", "stopped", JSON.stringify(budget), Date.now(), provider);
    return id;
  };
  statusOf = (runId) =>
    (db().prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string }).status;
  restartClosed = (runId) =>
    (db().prepare("SELECT restart_closed FROM runs WHERE id = ?").get(runId) as {
      restart_closed: number;
    }).restart_closed;
  storedBudget = (runId) =>
    JSON.parse(
      (db().prepare("SELECT budget FROM runs WHERE id = ?").get(runId) as { budget: string })
        .budget,
    ) as Record<string, unknown>;
  // The notice is global, so a run a case left refused would be pressed again
  // by the next case and turn its assertion into one about its neighbour.
  clearNotice = () => {
    db().prepare("UPDATE runs SET restart_closed = 0").run();
  };
  press = async () => {
    const res = await POST(
      new Request("http://localhost/api/runs/restarted", { method: "POST" }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
});

afterEach(() => clearNotice());

after(() => {
  delete process.env.WORKSPACE_ROOTS;
  fs.rmSync(root, { recursive: true, force: true });
});

type Pressed = {
  reopened: number;
  refused: Array<{ id: string; reason: string }>;
};

describe("POST /api/runs/restarted — a fraction guard with nothing to read", () => {
  it("refuses a run whose stored budget carries a weekly fraction and leaves it restart_closed", async () => {
    const stored = { ...STORED, maxWeeklyFraction: 0.5 };
    const runId = newRestartClosedRun(stored);
    const answer = await press();
    const reason = `answered ${answer.status} ${JSON.stringify(answer.body)}`;
    assert.equal(answer.status, 200, reason);
    const outcome = answer.body as unknown as Pressed;
    assert.equal(outcome.reopened, 0, reason);
    assert.equal(outcome.refused.length, 1, reason);
    assert.equal(outcome.refused[0].id, runId, reason);
    assert.match(
      outcome.refused[0].reason,
      /^A weekly-fraction guard is set but that window has no reading/,
      reason,
    );
    assert.equal(statusOf(runId), "stopped", `${reason}: the run was picked up with its guard unread`);
    assert.equal(restartClosed(runId), 1, `${reason}: it left the notice's count`);
    assert.deepEqual(storedBudget(runId), stored, `${reason}: the stored budget changed`);
  });

  it("refuses a stored session fraction the same way, in the session window's words", async () => {
    const runId = newRestartClosedRun({ ...STORED, maxSessionFraction: 0.5 });
    const answer = await press();
    const reason = `answered ${answer.status} ${JSON.stringify(answer.body)}`;
    const outcome = answer.body as unknown as Pressed;
    assert.equal(outcome.reopened, 0, reason);
    assert.match(
      outcome.refused[0]?.reason ?? "",
      /A session-fraction guard is set but the 5-hour window has no reading/,
      reason,
    );
    assert.equal(statusOf(runId), "stopped", reason);
  });

  it("picks up the runs with nothing to read and names the one it refused", async () => {
    const guarded = newRestartClosedRun({ ...STORED, maxWeeklyFraction: 0.5 });
    const plain = newRestartClosedRun();
    const answer = await press();
    const reason = `answered ${answer.status} ${JSON.stringify(answer.body)}`;
    assert.equal(answer.status, 200, reason);
    const outcome = answer.body as unknown as Pressed;
    assert.equal(outcome.reopened, 1, reason);
    assert.deepEqual(outcome.refused.map((r) => r.id), [guarded], reason);
    assert.equal(statusOf(guarded), "stopped", reason);
    assert.equal(restartClosed(guarded), 1, reason);
    // Held in `waiting` while the fleet is paused; what matters is that it left `stopped`.
    assert.notEqual(statusOf(plain), "stopped", reason);
  });

  it("picks a run up once its window has a reading", async () => {
    const { saveSettings } = await import("../../../../lib/settings");
    saveSettings({ weeklyCostLimit: 100 });
    try {
      const runId = newRestartClosedRun({ ...STORED, maxWeeklyFraction: 0.5 });
      const answer = await press();
      const reason = `answered ${answer.status} ${JSON.stringify(answer.body)}`;
      const outcome = answer.body as unknown as Pressed;
      assert.equal(outcome.reopened, 1, reason);
      assert.deepEqual(outcome.refused, [], reason);
      assert.notEqual(statusOf(runId), "stopped", reason);
      assert.equal(storedBudget(runId).maxWeeklyFraction, 0.5);
    } finally {
      saveSettings({ weeklyCostLimit: null });
    }
  });

  it("reads a Codex run against Codex's windows, not the Claude reading beside them", async () => {
    const { saveSettings } = await import("../../../../lib/settings");
    // A reading for Claude's week and none for Codex's: a door that asked only
    // `currentSnapshot()` would admit this run.
    saveSettings({ weeklyCostLimit: 100 });
    try {
      const runId = newRestartClosedRun({ ...STORED, maxWeeklyFraction: 0.5 }, "codex");
      const answer = await press();
      const reason = `answered ${answer.status} ${JSON.stringify(answer.body)}`;
      const outcome = answer.body as unknown as Pressed;
      assert.equal(outcome.reopened, 0, reason);
      assert.match(outcome.refused[0]?.reason ?? "", /Codex's weekly window has no reading/, reason);
      assert.equal(statusOf(runId), "stopped", reason);
    } finally {
      saveSettings({ weeklyCostLimit: null });
    }
  });
});
