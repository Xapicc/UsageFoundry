import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * A mistyped limit on `POST /api/fleet` `reopen` is refused, and "off" stays off.
 *
 * The route checked `moreIterations` and handed the rest of `budget` to
 * `reopenFleet`, which lays it over each run's stored blob and lets
 * `normalizePolicy` read it: "5O", "$5" and -5 became no limit and `true` became
 * 1, on every run in the batch, under a 200. `POST /api/runs/[id]/reopen` refuses
 * the same values for one run (`runs/[id]/reopen/route.test.ts`); this door puts
 * a whole selection back, so the same typo removes the guard from all of it at
 * once. The page's sheet cannot send one — both of its inputs are `type=number` —
 * so the wire is the only way in, which is why nothing looked wrong.
 *
 * Its own file with `DATA_DIR` named before the first import, for
 * `runOrigin.test.ts`'s reason: `config.ts` is read at module load. The fleet is
 * paused, so a run a regression lets through is never promoted to a spawn.
 *
 * The last describe is the door's fraction-guard refusal, which was missing: this
 * door never asked `windowGuardRefusal`, and the pre-cycle guard no longer ends a
 * run over a guard with nothing to read, so a run picked up here with
 * `maxWeeklyFraction` in its stored blob spawned its cycle with that guard
 * unread — measured 2026-11-08 through a stubbed CLI: 200, one spawn,
 * `enforceable: false`. The page's sheet sends neither fraction, so the stored
 * blob is the way in, and it is the case worth pinning.
 */

const STORED = { maxIterations: 1, maxRunCostUSD: 5 };

let root: string;
let pickUp: (body: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>;
let newStoppedRun: (
  budget?: Record<string, unknown>,
  provider?: "claude" | "codex",
) => string;
let statusOf: (runId: string) => string;
let storedBudget: (runId: string) => Record<string, unknown>;

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-fleet-route-")));
  fs.mkdirSync(path.join(root, "workspace"), { recursive: true });
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  // An empty home, so a Codex run has no sign-in and therefore no reading,
  // whatever this machine's own `~/.codex` holds.
  process.env.CODEX_HOME = path.join(root, "codex");
  process.env.WORKSPACE_ROOTS = `Scratch=${path.join(root, "workspace")}`;
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  const config = await import("../../../lib/config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );
  (await import("../../../lib/fleet")).setFleetPaused(true);
  const { db } = await import("../../../lib/db");
  const { POST } = await import("./route");

  let serial = 0;
  newStoppedRun = (budget = STORED, provider = "claude") => {
    const id = `run-fleet-${serial++}`;
    db()
      .prepare(
        "INSERT INTO runs (id, folder, prompt, status, budget, created_at, provider)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        path.join(root, "workspace"),
        "task",
        "stopped",
        JSON.stringify(budget),
        Date.now(),
        provider,
      );
    return id;
  };
  statusOf = (runId) =>
    (db().prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string }).status;
  storedBudget = (runId) =>
    JSON.parse(
      (db().prepare("SELECT budget FROM runs WHERE id = ?").get(runId) as { budget: string })
        .budget,
    ) as Record<string, unknown>;
  pickUp = async (body) => {
    const res = await POST(
      new Request("http://localhost/api/fleet", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
});

after(() => {
  delete process.env.WORKSPACE_ROOTS;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("POST /api/fleet reopen — a budget number", () => {
  for (const sent of ["5O", "$5", -5, true]) {
    it(`refuses ${JSON.stringify(sent)} as a spending limit and leaves the run as it was`, async () => {
      const runId = newStoppedRun();
      const answer = await pickUp({
        action: "reopen",
        runIds: [runId],
        budget: { moreIterations: 2, maxRunCostUSD: sent },
      });
      const reason = `${JSON.stringify(sent)} was answered ${answer.status} ${JSON.stringify(answer.body)}`;
      assert.equal(answer.status, 400, reason);
      const error = String(answer.body.error);
      assert.ok(
        error.startsWith("budget.maxRunCostUSD must be a ") &&
          error.endsWith(`; got ${JSON.stringify(sent)}.`),
        reason,
      );
      assert.equal(statusOf(runId), "stopped", `${reason}: the refused run was reopened anyway`);
      assert.deepEqual(storedBudget(runId), STORED, `${reason}: the stored budget changed`);
    });
  }

  it("still reads null, blank and 0 as a limit that is off", async () => {
    for (const sent of [null, "", 0]) {
      const runId = newStoppedRun();
      const answer = await pickUp({
        action: "reopen",
        runIds: [runId],
        budget: { moreIterations: 2, maxRunCostUSD: sent },
      });
      const reason = `${JSON.stringify(sent)} was answered ${answer.status} ${JSON.stringify(answer.body)}`;
      assert.equal(answer.status, 200, reason);
      assert.equal(storedBudget(runId).maxRunCostUSD, null, reason);
    }
  });

  it("leaves a stored limit alone when the sheet sends none", async () => {
    const runId = newStoppedRun();
    const answer = await pickUp({
      action: "reopen",
      runIds: [runId],
      budget: { moreIterations: 2 },
    });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(storedBudget(runId).maxRunCostUSD, 5);
  });
});

describe("POST /api/fleet reopen — the rest of the budget object", () => {
  it("refuses a budget that is not an object, naming the field", async () => {
    for (const sent of ["5", 5, ["x"], true]) {
      const runId = newStoppedRun();
      const answer = await pickUp({ action: "reopen", runIds: [runId], budget: sent });
      const reason = `${JSON.stringify(sent)} was answered ${answer.status} ${JSON.stringify(answer.body)}`;
      assert.equal(answer.status, 400, reason);
      assert.ok(String(answer.body.error).startsWith('"budget" has to be an object'), reason);
      assert.equal(statusOf(runId), "stopped", reason);
    }
  });

  it("refuses an enforcement mode it does not know instead of swapping it for the default", async () => {
    const runId = newStoppedRun();
    const answer = await pickUp({
      action: "reopen",
      runIds: [runId],
      budget: { moreIterations: 2, enforcement: "live-stpo" },
    });
    assert.equal(answer.status, 400, JSON.stringify(answer.body));
    assert.equal(answer.body.error, "Unknown enforcement mode: live-stpo");
    assert.equal(statusOf(runId), "stopped");
    assert.deepEqual(storedBudget(runId), STORED);
  });
});

describe("POST /api/fleet reopen — a fraction guard with nothing to read", () => {
  // `reopenRun` carries a stored fraction forward without asking whether the
  // window can be read, so the door has to: `POST /api/runs/[id]/reopen` does,
  // and a pick-up that reaches the loop with the guard unread runs its cycle
  // with nothing watching the window.
  const FRACTION = { maxIterations: 1, maxRunCostUSD: 5 };

  it("refuses a run whose stored budget carries a weekly fraction and leaves it stopped", async () => {
    const stored = { ...FRACTION, maxWeeklyFraction: 0.5 };
    const runId = newStoppedRun(stored);
    const answer = await pickUp({
      action: "reopen",
      runIds: [runId],
      budget: { moreIterations: 2 },
    });
    const reason = `answered ${answer.status} ${JSON.stringify(answer.body)}`;
    assert.equal(answer.status, 400, reason);
    const report = answer.body.report as { reopened: string[]; refused: Array<{ id: string; reason: string }> };
    assert.deepEqual(report.reopened, [], reason);
    assert.equal(report.refused.length, 1, reason);
    assert.equal(report.refused[0].id, runId, reason);
    assert.match(report.refused[0].reason, /^A weekly-fraction guard is set but that window has no reading/, reason);
    assert.equal(statusOf(runId), "stopped", `${reason}: the run was picked up with its guard unread`);
    assert.deepEqual(storedBudget(runId), stored, `${reason}: the stored budget changed`);
  });

  it("refuses a stored session fraction the same way, in the session window's words", async () => {
    const stored = { ...FRACTION, maxSessionFraction: 0.5 };
    const runId = newStoppedRun(stored);
    const answer = await pickUp({ action: "reopen", runIds: [runId], budget: { moreIterations: 2 } });
    const reason = `answered ${answer.status} ${JSON.stringify(answer.body)}`;
    assert.equal(answer.status, 400, reason);
    assert.match(String(answer.body.error), /A session-fraction guard is set but the 5-hour window has no reading/, reason);
    assert.equal(statusOf(runId), "stopped", reason);
  });

  it("refuses a fraction that arrives on the wire onto a run that stored none", async () => {
    const runId = newStoppedRun(FRACTION);
    const answer = await pickUp({
      action: "reopen",
      runIds: [runId],
      budget: { moreIterations: 2, maxWeeklyFraction: 0.5 },
    });
    const reason = `answered ${answer.status} ${JSON.stringify(answer.body)}`;
    assert.equal(answer.status, 400, reason);
    assert.equal(statusOf(runId), "stopped", reason);
    assert.deepEqual(storedBudget(runId), FRACTION, reason);
  });

  it("does not refuse the run whose stored fraction the wire switched off", async () => {
    const runId = newStoppedRun({ ...FRACTION, maxWeeklyFraction: 0.5 });
    const answer = await pickUp({
      action: "reopen",
      runIds: [runId],
      budget: { moreIterations: 2, maxWeeklyFraction: null },
    });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(storedBudget(runId).maxWeeklyFraction, null);
  });

  it("picks up the runs with nothing to read and names the one it refused", async () => {
    const guarded = newStoppedRun({ ...FRACTION, maxWeeklyFraction: 0.5 });
    const plain = newStoppedRun();
    const answer = await pickUp({ action: "reopen", runIds: [guarded, plain], budget: { moreIterations: 2 } });
    const reason = `answered ${answer.status} ${JSON.stringify(answer.body)}`;
    assert.equal(answer.status, 200, reason);
    const report = answer.body.report as { reopened: string[]; refused: Array<{ id: string }> };
    assert.deepEqual(report.reopened, [plain], reason);
    assert.deepEqual(report.refused.map((r) => r.id), [guarded], reason);
    assert.equal(statusOf(guarded), "stopped", reason);
    // Held in `waiting` while the fleet is paused; what matters is that it left `stopped`.
    assert.notEqual(statusOf(plain), "stopped", reason);
  });

  it("picks a run up once its window has a reading", async () => {
    const { saveSettings } = await import("../../../lib/settings");
    saveSettings({ weeklyCostLimit: 100 });
    try {
      const runId = newStoppedRun({ ...FRACTION, maxWeeklyFraction: 0.5 });
      const answer = await pickUp({ action: "reopen", runIds: [runId], budget: { moreIterations: 2 } });
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      assert.notEqual(statusOf(runId), "stopped");
      assert.equal(storedBudget(runId).maxWeeklyFraction, 0.5);
    } finally {
      saveSettings({ weeklyCostLimit: null });
    }
  });

  it("reads a Codex run against Codex's windows, not the Claude reading beside them", async () => {
    const { saveSettings } = await import("../../../lib/settings");
    // A reading for Claude's week and none for Codex's: a door that asked only
    // `currentSnapshot()` would admit this run.
    saveSettings({ weeklyCostLimit: 100 });
    try {
      const runId = newStoppedRun({ ...FRACTION, maxWeeklyFraction: 0.5 }, "codex");
      const answer = await pickUp({ action: "reopen", runIds: [runId], budget: { moreIterations: 2 } });
      const reason = `answered ${answer.status} ${JSON.stringify(answer.body)}`;
      assert.equal(answer.status, 400, reason);
      assert.match(String(answer.body.error), /Codex's weekly window has no reading/, reason);
      assert.equal(statusOf(runId), "stopped", reason);
    } finally {
      saveSettings({ weeklyCostLimit: null });
    }
  });
});
