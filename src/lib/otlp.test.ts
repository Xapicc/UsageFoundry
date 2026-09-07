import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { MAX_INGEST_BODY_BYTES, readCappedBody } from "./otlp";

/**
 * Covers the ceiling on the one write path `middleware.ts` exempts, and the
 * wiring that puts it in front of the parse.
 *
 * Both directions fail in silence and neither is cheap. A cap that stops firing
 * is bit-for-bit the unbounded route it replaced — `loginLimiter`'s argument,
 * on a path that is reachable without passing the edge gate and whose body is
 * buffered in the single process running every agent, the run loop and SQLite.
 * A cap that fires *early* is the opposite and no louder: a batch exporter meets
 * a 413 it cannot shrink its way past, the run's own telemetry stops arriving,
 * and what reads zero is `telemetrySpendSince` — the mid-cycle half of a live
 * spending guard, which has no other source and cannot tell "spent nothing"
 * from "heard nothing".
 *
 * The size cases are driven through a streamed request body rather than a
 * string, because that is the shape a 4 MiB POST actually arrives in: a counter
 * that reset per chunk, or a decode that ran per chunk, would both pass against
 * a one-chunk body and fail on the wire.
 *
 * The wiring half reads source text, on `http.test.ts`'s grounds: the handler
 * imports through the `@/` alias, which plain CommonJS does not resolve, so the
 * choice is a text assertion or no regression test at all for the order the
 * refusal is answered in.
 */

const CHUNK_BYTES = 64 * 1024;

/** A POST whose body arrives as `total` bytes split across realistic chunks. */
function streamedRequest(chunks: Uint8Array[]): Request {
  return new Request("http://ingest.invalid/api/otlp/v1/logs", {
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    // Node refuses a streamed request body without this, and the DOM lib this
    // project compiles against carries no field for it.
    duplex: "half",
  } as RequestInit);
}

function chunksOf(total: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let sent = 0; sent < total; sent += CHUNK_BYTES) {
    chunks.push(new Uint8Array(Math.min(CHUNK_BYTES, total - sent)).fill(0x61));
  }
  return chunks;
}

describe("readCappedBody bounds the exempted route's body at the read", () => {
  it("reads a body of exactly the ceiling", async () => {
    const body = await readCappedBody(streamedRequest(chunksOf(MAX_INGEST_BODY_BYTES)));
    assert.equal(body.ok, true);
    assert.equal(body.ok && body.text.length, MAX_INGEST_BODY_BYTES);
  });

  it("refuses a body one byte over it", async () => {
    const body = await readCappedBody(streamedRequest(chunksOf(MAX_INGEST_BODY_BYTES + 1)));
    assert.equal(body.ok, false);
  });

  it("counts across chunks rather than per chunk", async () => {
    // Every chunk here is far under the ceiling; only the running total crosses
    // it, which is the whole of what a per-chunk test would miss.
    const chunks = chunksOf(MAX_INGEST_BODY_BYTES + CHUNK_BYTES);
    assert.ok(chunks.every((c) => c.byteLength <= CHUNK_BYTES));
    assert.equal((await readCappedBody(streamedRequest(chunks))).ok, false);
  });

  it("stops reading the stream it refused", async () => {
    let pulled = 0;
    const oversized = new Request("http://ingest.invalid/api/otlp/v1/logs", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          controller.enqueue(new Uint8Array(CHUNK_BYTES));
        },
      }),
      duplex: "half",
    } as RequestInit);

    assert.equal((await readCappedBody(oversized)).ok, false);
    // A stream this app never cancels is one an unattended caller keeps feeding
    // for as long as it likes, which is the cap refusing on paper only.
    const atRefusal = pulled;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(pulled, atRefusal);
  });

  it("returns an accepted body byte-for-byte, across a chunk boundary", async () => {
    // The one way a length-only cap corrupts what it lets through: a multi-byte
    // sequence decoded per chunk comes back as replacement characters, and the
    // JSON the route parses is then not the JSON that was sent.
    const bytes = Buffer.from(JSON.stringify({ resourceLogs: [], note: "€" }), "utf8");
    const split = bytes.indexOf(0xe2) + 1;
    const body = await readCappedBody(
      streamedRequest([bytes.subarray(0, split), bytes.subarray(split)]),
    );
    assert.equal(body.ok, true);
    assert.equal(body.ok && body.text, bytes.toString("utf8"));
  });

  it("treats a request with no body as an empty one", async () => {
    const body = await readCappedBody(
      new Request("http://ingest.invalid/api/otlp/v1/logs", { method: "POST" }),
    );
    assert.deepEqual(body, { ok: true, text: "" });
  });
});

describe("the ingest route answers the size refusal before it writes anything", () => {
  // Comments stripped: this file's own prose names both `req.json()` and the
  // status codes, and an assertion satisfied by a comment asserts nothing.
  const code = readFileSync(
    join(process.cwd(), "src", "app", "api", "otlp", "v1", "logs", "route.ts"),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("caps the read rather than the parsed payload", () => {
    assert.match(code, /readCappedBody\(req\)/);
    assert.doesNotMatch(
      code,
      /req\.json\(\)/,
      "req.json() has buffered and parsed the body before any size check could read a length",
    );
  });

  it("refuses with 413 and names the limit", () => {
    assert.match(code, /status:\s*413/);
    assert.match(code, /limitBytes:\s*MAX_INGEST_BODY_BYTES/);
  });

  it("refuses before the credential-free path could reach a durable write", () => {
    const refusal = code.indexOf("413");
    assert.ok(refusal > 0, "the route no longer refuses an oversized body");
    // Both orderings are load-bearing and both are silent if lost: the 401
    // above means an unauthenticated caller's body is never read at all, and
    // nothing between the refusal and the top of the handler may write a row —
    // an exempted path's own refusal must not spend a capped table's window.
    assert.ok(code.indexOf("401") < refusal);
    assert.ok(code.indexOf("recordTelemetry(") > refusal);
    assert.doesNotMatch(code, /auditMutation/);
  });
});
