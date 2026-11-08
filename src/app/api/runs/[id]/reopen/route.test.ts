import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * A mistyped limit on `POST /api/runs/[id]/reopen` is refused, and "off" stays off.
 *
 * The route's docblock says it refuses what `POST /api/runs` refuses, and for a
 * budget number it did not: `normalizePolicy` reads "5O", "$5" and -5 as no limit
 * and `true` as 1, so a finished run was put back in the queue under none of the
 * guards its operator had just retyped. Nothing throws and the run page looks
 * right; the only symptom is a bill. `runs/route.test.ts` pins the same refusal
 * for the start door off the same value table.
 *
 * Its own file with `DATA_DIR` named before the first import, for
 * `runOrigin.test.ts`'s reason: `config.ts` is read at module load. The fleet is
 * paused, so a run a regression lets through is never promoted to a spawn.
 */

let root: string;
let reopen: (runId: string, body: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;
let newStoppedRun: () => string;
let statusOf: (runId: string) => string;
let storedBudget: (runId: string) => Record<string, unknown>;

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-reopen-route-")));
  fs.mkdirSync(path.join(root, "workspace"), { recursive: true });
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  process.env.WORKSPACE_ROOTS = `Scratch=${path.join(root, "workspace")}`;
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  const config = await import("../../../../../lib/config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );
  (await import("../../../../../lib/fleet")).setFleetPaused(true);
  const { db } = await import("../../../../../lib/db");
  const { POST } = await import("./route");

  let serial = 0;
  newStoppedRun = () => {
    const id = `run-reopen-${serial++}`;
    db()
      .prepare(
        "INSERT INTO runs (id, folder, prompt, status, budget, created_at)" +
          " VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(id, path.join(root, "workspace"), "task", "stopped", "{}", Date.now());
    return id;
  };
  statusOf = (runId) =>
    (db().prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string }).status;
  storedBudget = (runId) =>
    JSON.parse(
      (db().prepare("SELECT budget FROM runs WHERE id = ?").get(runId) as { budget: string })
        .budget,
    ) as Record<string, unknown>;
  reopen = async (runId, body) => {
    const res = await POST(
      new Request(`http://localhost/api/runs/${runId}/reopen`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: runId }) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
});

after(() => {
  delete process.env.WORKSPACE_ROOTS;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("POST /api/runs/[id]/reopen — a budget number", () => {
  it("refuses a limit that is not a number, naming the field and the value, and leaves the run stopped", async () => {
    for (const [key, sent] of [
      ["maxRunCostUSD", "5O"],
      ["maxRunCostUSD", "$5"],
      ["maxRunCostUSD", -5],
      ["maxRunCostUSD", true],
      ["maxRunTokens", "lots"],
      ["maxDurationMinutes", "1h"],
      ["maxIterations", "5O"],
    ] as const) {
      const runId = newStoppedRun();
      const answer = await reopen(runId, { budget: { maxIterations: 1, [key]: sent } });
      const reason = `${key}: ${JSON.stringify(sent)} was answered ${answer.status} ${JSON.stringify(answer.body)}`;
      assert.equal(answer.status, 400, reason);
      const error = String(answer.body.error);
      assert.ok(
        error.startsWith(`budget.${key} must be a `) &&
          error.endsWith(`; got ${JSON.stringify(sent)}.`),
        reason,
      );
      assert.equal(statusOf(runId), "stopped", `${reason}: the refused run was reopened anyway`);
    }
  });

  it("still reads null, blank and 0 as a limit that is off", async () => {
    const runId = newStoppedRun();
    const answer = await reopen(runId, {
      budget: { maxIterations: 1, maxRunCostUSD: 0, maxRunTokens: "", maxRunCostFactor: null },
    });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    // A row that never started work goes back to `waiting`, not the queue; either
    // way it has left `stopped`, which is all this case needs to show.
    assert.equal(statusOf(runId), "waiting");
    const stored = storedBudget(runId);
    assert.equal(stored.maxRunCostUSD, null);
    assert.equal(stored.maxRunTokens, null);
    assert.equal(stored.maxRunCostFactor, null);
  });
});
