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
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-otlp-route-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.CLAUDE_HOME = path.join(root, "claude");
process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude-config");

let dbMod: typeof import("../../../../../lib/db");
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
  const otlp = await import("../../../../../lib/otlp");
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
