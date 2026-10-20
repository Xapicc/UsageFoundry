import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * What the telemetry ingest answers when it read a batch and could not keep it.
 *
 * `otlp_requests` is the only input of the live `run_cost`/`run_tokens` guard,
 * so a batch the route drops is spend that guard never sees for the rest of the
 * cycle. The exporter retries on a failure and treats a 200 as delivered, which
 * makes the status code the whole of the protection: the route answered 200
 * whichever half threw, so a write that failed (disk full, `SQLITE_BUSY` past
 * the busy timeout) reported success for telemetry that never arrived, with
 * nothing thrown and nothing logged. `otlp.test.ts` reads this route's source
 * for its ordering and cap; only a request can see which status a failed write
 * is answered with.
 *
 * Its own `DATA_DIR` before the first import, `health/route.test.ts`' reason.
 * The write failure is a trigger refusing inserts into `otlp_requests`, so the
 * read half of the route runs for real and only the write is made to fail — the
 * shape of an I/O error at this layer.
 *
 * The last cases are about what a run can post with its own capability, which
 * is in the work cycle's environment where `Bash`'s `env` prints it. A negative
 * cost or token count, or a record dated after it arrived, lowered
 * `telemetrySpendSince` for the cycle in flight — and a future date lowered it
 * for every later cycle too — so the live guard never tripped and nothing was
 * logged. They drive the route and read the guard's own figure, because that
 * figure is what the forgery was aimed at.
 *
 * The last one is the other direction: a *positive* cost the poster made up,
 * read by the install limit and a workflow instance's limit, which sum every
 * running run's cycle in flight and so judge every other run by it. One
 * `cost_usd: 1e9` ended each run that reached its pre-cycle check while the
 * forging cycle ran, and halted its instance's members.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-otlp-route-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.CLAUDE_HOME = path.join(root, "claude");
process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude-config");

let dbMod: typeof import("../../../../../lib/db");
let otlp: typeof import("../../../../../lib/otlp");
let token: string;

before(async () => {
  const config = await import("../../../../../lib/config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );
  dbMod = await import("../../../../../lib/db");
  otlp = await import("../../../../../lib/otlp");
  token = otlp.ingestTokenFor("run-ingest");
});

after(() => {
  const open = (globalThis as { __ufDb?: { close(): void } }).__ufDb;
  open?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const batch = (requestId: string) => ({
  resourceLogs: [
    {
      resource: { attributes: [] },
      scopeLogs: [
        {
          logRecords: [
            {
              body: { stringValue: "claude_code.api_request" },
              attributes: [
                { key: "event.name", value: { stringValue: "api_request" } },
                { key: "request_id", value: { stringValue: requestId } },
                { key: "model", value: { stringValue: "claude-opus-5" } },
                { key: "cost_usd", value: { doubleValue: 1.25 } },
                { key: "input_tokens", value: { intValue: "10" } },
                { key: "output_tokens", value: { intValue: "2000" } },
                { key: "session.id", value: { stringValue: "s1" } },
                { key: "event.timestamp", value: { stringValue: new Date().toISOString() } },
              ],
            },
          ],
        },
      ],
    },
  ],
});

async function post(body: string, bearer = token): Promise<Response> {
  const { POST } = await import("./route");
  return POST(
    new Request("http://localhost/api/otlp/v1/logs", {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body,
    }),
  );
}

const storedCount = (requestId: string): number =>
  (
    dbMod
      .db()
      .prepare("SELECT COUNT(*) AS n FROM otlp_requests WHERE request_id = ?")
      .get(requestId) as { n: number }
  ).n;

describe("the ingest route's answer to a batch it read", () => {
  it("records a well-formed batch and answers 200 with what it stored", async () => {
    const res = await post(JSON.stringify(batch("req_control")));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { partialSuccess: {}, seen: 1, inserted: 1 });
    assert.equal(storedCount("req_control"), 1, "the fixture is a payload the route records");
  });

  it("answers 200 to a body that does not parse, because no retry will fix it", async () => {
    const res = await post("{ this is not json");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { partialSuccess: {} });
  });

  it("does not answer 200 to a batch it read but could not write", async () => {
    const db = dbMod.db();
    db.exec(
      `CREATE TRIGGER otlp_route_refuses BEFORE INSERT ON otlp_requests
         BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`,
    );
    const logged: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      const res = await post(JSON.stringify(batch("req_dropped")));
      assert.equal(
        res.status,
        503,
        "a 200 tells the exporter the batch arrived, so it never retries and the live guard never sees $1.25",
      );
      assert.equal(storedCount("req_dropped"), 0);
      assert.equal(logged.length, 1, "a dropped batch must leave a line in the container log");
      assert.match(String(logged[0].join(" ")), /database or disk is full/);

      // The same refusal must not turn a body that never parsed into a retry:
      // that is the one case the 200 is for, and it stays one when the write
      // path is the thing that is broken.
      const malformed = await post("{ this is not json");
      assert.equal(malformed.status, 200);
    } finally {
      console.error = realError;
      db.exec("DROP TRIGGER otlp_route_refuses");
    }

    // A retry of the same batch once the write works is recorded exactly once.
    const retry = await post(JSON.stringify(batch("req_dropped")));
    assert.equal(retry.status, 200);
    assert.equal(storedCount("req_dropped"), 1);
  });
});

/** One `api_request` record, with the fields a forgery would set. */
function record(requestId: string, attrs: Record<string, number | string>, tsMs: number) {
  return {
    timeUnixNano: String(BigInt(tsMs) * 1_000_000n),
    body: { stringValue: "claude_code.api_request" },
    attributes: [
      { key: "event.name", value: { stringValue: "api_request" } },
      { key: "request_id", value: { stringValue: requestId } },
      { key: "model", value: { stringValue: "claude-opus-5" } },
      ...Object.entries(attrs).map(([key, value]) => ({
        key,
        value: typeof value === "number" ? { doubleValue: value } : { intValue: value },
      })),
    ],
  };
}

const payload = (...logRecords: ReturnType<typeof record>[]) =>
  JSON.stringify({ resourceLogs: [{ resource: { attributes: [] }, scopeLogs: [{ logRecords }] }] });

describe("a record that would lower the live guard's figure", () => {
  it("drops a negative cost or token count, and keeps the rest of the batch", async () => {
    const run = "run-negative";
    const bearer = otlp.ingestTokenFor(run);
    const cycleStart = Date.now() - 1000;
    const now = Date.now();

    const res = await post(
      payload(
        record("req_real", { cost_usd: 4, input_tokens: "1000" }, now),
        record("req_negative_cost", { cost_usd: -1000, input_tokens: "10" }, now),
        record("req_negative_input", { cost_usd: 1, input_tokens: "-1000000000" }, now),
        record("req_negative_output", { cost_usd: 1, output_tokens: "-5" }, now),
        record("req_negative_cache_read", { cost_usd: 1, cache_read_tokens: "-5" }, now),
        record("req_negative_cache_write", { cost_usd: 1, cache_creation_tokens: "-5" }, now),
      ),
      bearer,
    );
    assert.equal(res.status, 200);
    // Skipped rather than refused: the exporter retries a refused batch, and
    // one bad record would cost the good one beside it on every retry.
    assert.deepEqual(await res.json(), { partialSuccess: {}, seen: 1, inserted: 1 });
    assert.deepEqual(otlp.telemetrySpendSince(run, cycleStart), {
      requests: 1,
      costUSD: 4,
      tokens: 1000,
    });
  });

  it("counts a record dated in the future in the cycle that received it, and in no later one", async () => {
    const run = "run-future";
    const bearer = otlp.ingestTokenFor(run);
    const cycleStart = Date.now() - 1000;

    const res = await post(
      payload(record("req_2100", { cost_usd: 2, input_tokens: "500" }, Date.parse("2100-01-01"))),
      bearer,
    );
    assert.equal(res.status, 200);
    assert.deepEqual(otlp.telemetrySpendSince(run, cycleStart), {
      requests: 1,
      costUSD: 2,
      tokens: 500,
    });
    const nextCycle = Date.now() + 60 * 60_000;
    assert.equal(
      otlp.telemetrySpendSince(run, nextCycle).requests,
      0,
      "a cycle that has not started yet already has records",
    );
  });
});

describe("a record that would raise another run's figure", () => {
  it("adds no more to the install and workflow figures than the forging cycle could have spent", async () => {
    const installBudget = await import("../../../../../lib/installBudget");
    const settings = await import("../../../../../lib/settings");
    const workflows = await import("../../../../../lib/workflows");
    const db = dbMod.db();
    const cycleStart = Date.now() - 1000;

    // The forger is in a cycle spawned with `--max-budget-usd 3`: a $5 limit
    // with $2 already spent. The bystander is between cycles, at the pre-cycle
    // check the install limit refuses at.
    const insertRun = db.prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, created_at,
                         spent_usd, active_started_at, active_budget_usd)
       VALUES (?, '/workspace', 'work', 'running', '{"maxIterations":5,"maxRunCostUSD":5}', 5, ?, ?, ?, ?)`,
    );
    insertRun.run("run-forger", cycleStart, 2, cycleStart, 3);
    insertRun.run("run-bystander", cycleStart, 1, null, null);
    db.prepare(
      "INSERT INTO workflows (id, name, graph, created_at, updated_at) VALUES ('wf-forged', 'w', '{}', ?, ?)",
    ).run(cycleStart, cycleStart);
    db.prepare(
      `INSERT INTO workflow_instances
         (id, workflow_id, workflow_name, graph, created_at, status, instance_budget)
       VALUES ('inst-forged', 'wf-forged', 'w', '{"nodes":[],"edges":[]}', ?, 'started',
               '{"maxInstanceCostUSD":20}')`,
    ).run(cycleStart);
    const insertMember = db.prepare(
      "INSERT INTO workflow_instance_runs (instance_id, node_id, node_name, position, run_id)" +
        " VALUES ('inst-forged', ?, ?, ?, ?)",
    );
    insertMember.run("n0", "Forger", 0, "run-forger");
    insertMember.run("n1", "Bystander", 1, "run-bystander");

    const bearer = otlp.ingestTokenFor("run-forger");
    const guardFigures = () => ({
      install: installBudget.installSpend().spentGuardUSD,
      instance: workflows.instanceSpend("inst-forged").spentGuardUSD,
    });

    // Real spend under the cap counts in full: a cap that understated it would
    // blind both limits to money actually being spent.
    const real = await post(payload(record("req_real_cycle", { cost_usd: 1.25 }, Date.now())), bearer);
    assert.equal(real.status, 200);
    assert.deepEqual(guardFigures(), { install: 2 + 1 + 1.25, instance: 2 + 1 + 1.25 });

    const forged = await post(payload(record("req_forged", { cost_usd: 1e9 }, Date.now())), bearer);
    assert.equal(forged.status, 200);
    assert.equal(
      otlp.telemetrySpendSince("run-forger", cycleStart).costUSD,
      1e9 + 1.25,
      "the forger's own live guard still reads what it posted, and stops it",
    );
    assert.deepEqual(
      guardFigures(),
      { install: 2 + 1 + 3, instance: 2 + 1 + 3 },
      "another run's figure moved past what the forging cycle could have spent",
    );

    settings.saveSettings({ installDailyCostLimitUSD: 50 });
    try {
      assert.equal(installBudget.installBudgetVerdict(), null, "the bystander is refused on install_cost");
    } finally {
      settings.saveSettings({ installDailyCostLimitUSD: null });
    }
  });
});
