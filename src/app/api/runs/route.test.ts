import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * A mistyped limit on `POST /api/runs` is refused, and "off" stays off.
 *
 * `normalizePolicy` reads "5O", "$5", -5 and a stray `true` as no limit, so the
 * route used to answer 200 and start an unattended agent with none of the
 * guards its operator typed. Nothing throws and the run page looks right; the
 * only symptom is a bill. The refusal lives in the route because it is the one
 * door here with somebody to tell — `normalizePolicy` runs a second time over
 * the stored blob and has to stay total.
 *
 * The last describe is the other half of the same door: a fraction guard with
 * nothing to read is refused here and nowhere after, because the pre-cycle guard
 * records it and carries on (`RUN_ENFORCEABLE_CODES`). Only `budget.test.ts`
 * tested `windowGuardRefusal`, and that is the pure function; deleting this
 * route's call to it broke nothing, and the run would have spawned unwatched.
 *
 * Its own file with `DATA_DIR` named before the first import, for
 * `runOrigin.test.ts`'s reason: `config.ts` is read at module load.
 */

let root: string;
let post: (body: unknown) => Promise<{ status: number; body: Record<string, unknown> }>;
let runCount: () => number;
let storedBudget: (runId: string) => Record<string, unknown>;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-runs-route-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(path.join(workspace, "project"), { recursive: true });
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = workspace;
  process.env.WORKSPACE_ROOTS = `Scratch=${workspace}`;
  // Nothing here should reach a spawn: the one case that admits a run does so
  // against a `claude` that does not exist.
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  const config = await import("../../../lib/config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );
  const { saveSettings } = await import("../../../lib/settings");
  saveSettings({ planUsageFromApi: false });
  const { db } = await import("../../../lib/db");
  const { POST } = await import("./route");

  post = async (body) => {
    const res = await POST(
      new Request("http://localhost/api/runs", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  runCount = () => (db().prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
  storedBudget = (runId) =>
    JSON.parse(
      (db().prepare("SELECT budget FROM runs WHERE id = ?").get(runId) as { budget: string })
        .budget,
    ) as Record<string, unknown>;
});

after(async () => {
  // The admitted run is promoted in the background and falls over on its own
  // `claude`; given a tick to, and the database handle left open, so that is
  // not an unhandled rejection about a closed one.
  await new Promise((resolve) => setTimeout(resolve, 50));
  delete process.env.WORKSPACE_ROOTS;
  fs.rmSync(root, { recursive: true, force: true });
});

function formBody(budget: Record<string, unknown>) {
  return { folder: "project", mountId: "scratch", prompt: "do the thing", budget };
}

describe("POST /api/runs — a budget number", () => {
  it("refuses a limit that is not a number, naming the field and the value, and starts no run", async () => {
    for (const [key, sent] of [
      ["maxRunCostUSD", "5O"],
      ["maxRunCostUSD", "$5"],
      ["maxRunCostUSD", -5],
      ["maxRunCostUSD", true],
      ["maxRunTokens", "lots"],
      ["maxRunCostFactor", "x"],
      ["maxDurationMinutes", "1h"],
      ["maxIterations", "5O"],
      ["maxSessionFraction", "half"],
      ["maxWeeklyFraction", -0.5],
    ] as const) {
      const answer = await post(formBody({ maxIterations: 1, [key]: sent }));
      const reason = `${key}: ${JSON.stringify(sent)} was answered ${answer.status} ${JSON.stringify(answer.body)}`;
      assert.equal(answer.status, 400, reason);
      const error = String(answer.body.error);
      assert.ok(
        error.startsWith(`budget.${key} must be a `) &&
          error.endsWith(`; got ${JSON.stringify(sent)}.`),
        reason,
      );
    }
    assert.equal(runCount(), 0, "a refused budget still created a run");
  });

  it("still reads null, blank and 0 as a limit that is off", async () => {
    const answer = await post(
      formBody({
        maxIterations: 1,
        maxRunCostUSD: 0,
        maxRunTokens: "",
        maxRunCostFactor: null,
        maxSessionFraction: 0,
      }),
    );
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    const run = answer.body.run as { id: string };
    const stored = storedBudget(run.id);
    assert.equal(stored.maxRunCostUSD, null);
    assert.equal(stored.maxRunTokens, null);
    assert.equal(stored.maxRunCostFactor, null);
    assert.equal(stored.maxSessionFraction, null);
  });
});

describe("POST /api/runs — a fraction guard with nothing to read", () => {
  // No weekly ceiling, no 5-hour ceiling, `planUsageFromApi` off and an empty
  // CLAUDE_HOME: nothing for either window to be measured against. The value is
  // a valid fraction, so `policyNumberRefusal` lets it through and the only
  // thing standing between it and `createRun` is `windowGuardRefusal`.
  for (const [key, sentence] of [
    ["maxWeeklyFraction", /^A weekly-fraction guard is set but that window has no reading/],
    ["maxSessionFraction", /^A session-fraction guard is set but the 5-hour window has no reading/],
  ] as const) {
    it(`refuses ${key} and starts no run`, async () => {
      const before = runCount();
      const answer = await post(formBody({ maxIterations: 1, [key]: 0.5 }));
      const reason = `${key} was answered ${answer.status} ${JSON.stringify(answer.body)}`;
      assert.equal(answer.status, 400, reason);
      assert.match(String(answer.body.error), sentence, reason);
      assert.equal(runCount(), before, `${reason}: a refused guard still created a run`);
    });
  }
});
