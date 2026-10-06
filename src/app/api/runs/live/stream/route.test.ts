import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import type { LiveFrameDTO } from "../../../../../lib/apiTypes";

/**
 * `/runs/live`'s one connection, against the real bus and a real table.
 *
 * The pure bounds are pinned in `liveStream.test.ts`; this pins the part that
 * is only true end to end. A run that starts while the page is open must arrive
 * as a `join` carrying its tail — the `status` event announcing it reaches the
 * route before anything follows that run, so a route that only forwarded events
 * of runs it already knew would never show it. A run that stops must arrive as
 * a `leave`, or its tile stays up reading as an agent gone quiet. And a closed
 * connection must take its `"*"` listener with it: the bus has
 * `setMaxListeners(0)`, so nothing would ever report the leak, and every one
 * left behind is a closure re-reading the runs table on every status change in
 * the install.
 *
 * The environment has to be configured before the modules load: `config.ts`
 * reads DATA_DIR once at import.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-live-stream-")));
const ws = path.join(tmp, "ws");
fs.mkdirSync(ws, { recursive: true });
process.env.WORKSPACE_ROOTS = `Main=${ws}`;
process.env.DATA_DIR = path.join(tmp, "data");

// `require`, not `import`: imports are hoisted above the environment setup.
const { db } = require("../../../../../lib/db") as typeof import("../../../../../lib/db");
const { emitRunEvent } =
  require("../../../../../lib/orchestrator") as typeof import("../../../../../lib/orchestrator");
const { GET } = require("./route") as typeof import("./route");

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
let clock = 1_700_000_000_000;

function newRun(status: string): string {
  const id = `run-${++seq}`;
  db()
    .prepare(
      "INSERT INTO runs (id, folder, prompt, status, budget, created_at)" +
        " VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(id, ws, "task", status, "{}", ++clock);
  return id;
}

function log(runId: string, message: string) {
  emitRunEvent({ runId, ts: ++clock, kind: "log", payload: { message } });
}

/** Moves a run the way `setStatus` does: the row, then the event. */
function moveTo(runId: string, status: string) {
  db().prepare("UPDATE runs SET status = ? WHERE id = ?").run(status, runId);
  emitRunEvent({ runId, ts: ++clock, kind: "status", payload: { status } });
}

const bus = (globalThis as unknown as {
  __ufBus: { listenerCount(name: string): number };
}).__ufBus;

class Connection {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buf = "";
  private at = 0;

  private constructor(
    body: ReadableStream<Uint8Array>,
    private readonly abort: AbortController,
  ) {
    this.reader = body.getReader();
  }

  static async open(): Promise<Connection> {
    const abort = new AbortController();
    const res = await GET(
      new Request("http://localhost/api/runs/live/stream", { signal: abort.signal }),
    );
    assert.equal(res.status, 200);
    assert.ok(res.body);
    return new Connection(res.body, abort);
  }

  /** The next frame, skipping heartbeats; a frame with an `id:` line fails. */
  async frame(): Promise<LiveFrameDTO> {
    for (;;) {
      const end = this.buf.indexOf("\n\n", this.at);
      if (end >= 0) {
        const raw = this.buf.slice(this.at, end);
        this.at = end + 2;
        if (raw.startsWith(":")) continue;
        assert.ok(!/^id: /m.test(raw), `frame carries an id: ${raw.slice(0, 80)}`);
        assert.ok(raw.startsWith("data: "), `not a data frame: ${raw.slice(0, 80)}`);
        return JSON.parse(raw.slice("data: ".length)) as LiveFrameDTO;
      }
      this.buf = this.buf.slice(this.at);
      this.at = 0;
      const { value, done } = await this.reader.read();
      if (done) throw new Error("stream closed before the expected frame");
      this.buf += this.decoder.decode(value, { stream: true });
    }
  }

  /** Frames up to and including the first of `kind`. */
  async until(kind: LiveFrameDTO["kind"]): Promise<LiveFrameDTO[]> {
    const seen: LiveFrameDTO[] = [];
    for (;;) {
      const frame = await this.frame();
      seen.push(frame);
      if (frame.kind === kind) return seen;
    }
  }

  close() {
    this.abort.abort();
  }
}

/** Every run this file created is settled again, so the next test starts clean. */
function settleAll() {
  db().prepare("UPDATE runs SET status = 'completed'").run();
}

describe("a connection opening", () => {
  it("sends the counts, each running run's bounded tail, then ready", async () => {
    const running = newRun("running");
    for (let i = 0; i < 60; i++) log(running, `line ${i}`);
    const queued = newRun("queued");
    log(queued, "not shown: this run is not running");

    const conn = await Connection.open();
    const frames = await conn.until("ready");
    conn.close();
    settleAll();

    assert.deepEqual(frames[0], {
      kind: "counts",
      counts: { running: 1, queued: 1, paused: 0, "waiting-for-stack": 0 },
    });
    const joins = frames.filter((f) => f.kind === "join");
    assert.equal(joins.length, 1);
    const join = joins[0] as Extract<LiveFrameDTO, { kind: "join" }>;
    assert.equal(join.runId, running);
    assert.equal(join.events.length, 50);
    assert.equal(join.dropped, 10);
    assert.equal(join.events.at(-1)?.payload.message, "line 59");
    assert.deepEqual(frames.at(-1), { kind: "ready", runIds: [running] });
  });

  it("sends a tool call in the replay as its one line", async () => {
    const running = newRun("running");
    emitRunEvent({
      runId: running,
      ts: ++clock,
      kind: "tool",
      payload: { name: "Write", input: { file_path: "a.ts", content: "x".repeat(3_000) } },
    });

    const conn = await Connection.open();
    const frames = await conn.until("ready");
    conn.close();
    settleAll();

    const join = frames.find((f) => f.kind === "join") as Extract<LiveFrameDTO, { kind: "join" }>;
    assert.equal(join.events[0].payload.input, "a.ts");
  });
});

describe("a connection that is open", () => {
  it("forwards a followed run's events and ignores the rest", async () => {
    const running = newRun("running");
    const queued = newRun("queued");
    const conn = await Connection.open();
    await conn.until("ready");

    log(queued, "ignored");
    log(running, "forwarded");
    const frame = await conn.frame();
    conn.close();
    settleAll();

    assert.equal(frame.kind, "event");
    assert.equal((frame as Extract<LiveFrameDTO, { kind: "event" }>).runId, running);
  });

  it("joins a run that starts, with the tail it already had", async () => {
    const queued = newRun("queued");
    log(queued, "written while queued");
    const conn = await Connection.open();
    await conn.until("ready");

    moveTo(queued, "running");
    const frames = await conn.until("join");
    log(queued, "after the join");
    const next = await conn.frame();
    conn.close();
    settleAll();

    assert.deepEqual(frames[0], {
      kind: "counts",
      counts: { running: 1, queued: 0, paused: 0, "waiting-for-stack": 0 },
    });
    const join = frames.at(-1) as Extract<LiveFrameDTO, { kind: "join" }>;
    assert.equal(join.runId, queued);
    // The tail holds the status event that announced the start, and once.
    assert.deepEqual(
      join.events.map((e) => e.kind),
      ["log", "status"],
    );
    assert.equal(next.kind, "event");
  });

  it("leaves a run that stops, after forwarding the status that stopped it", async () => {
    const running = newRun("running");
    const conn = await Connection.open();
    await conn.until("ready");

    moveTo(running, "stopped");
    const frames = await conn.until("leave");
    conn.close();
    settleAll();

    assert.deepEqual(
      frames.map((f) => f.kind),
      ["event", "counts", "leave"],
    );
    assert.deepEqual(frames.at(-1), { kind: "leave", runId: running });
  });
});

describe("a connection that closes", () => {
  it("takes its listener off the bus", async () => {
    const before = bus.listenerCount("*");
    const conn = await Connection.open();
    await conn.until("ready");
    assert.equal(bus.listenerCount("*"), before + 1);
    conn.close();
    assert.equal(bus.listenerCount("*"), before);
  });
});
