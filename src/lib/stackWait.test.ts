import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, it } from "node:test";

/**
 * A run that asks for a stack, driven through the real run loop: the park at
 * the cycle boundary, the release, and the resumed cycle's argv.
 *
 * Every step of it fails silently. A park that charges the cycle that asked
 * ends a run on the default cap of one the moment it resumes, having waited a
 * restart for nothing. A park placed below the cycle-cap check never happens on
 * that cap at all — the run completes instead, and the request sits on Settings
 * for a run that is already over. A release that re-queues without the notice
 * sends "continue the task" into a conversation whose last turn was "I am
 * waiting for cargo". And a resumed cycle whose argv lacks the new stack's grant
 * is refused `cargo` with "This command requires approval" while the cycle ends
 * `success` having run nothing, which is the quiet failure `stacks.ts` records
 * for an ungranted binary at `acceptEdits`.
 *
 * `orchestrator.test.ts` cannot say any of it because nothing there spawns, so
 * this is `parksAndRefunds.test.ts`'s harness: a stubbed child, the real loop,
 * and the row each segment leaves. Its own file for that file's reasons —
 * `config.ts` fixes `DATA_DIR` at load and `spawn` is replaced for the life of
 * the process — and one more: `reconcileOnBoot` acts on every row there is.
 *
 * The restart between the park and the resume is simulated, not performed: the
 * applier's receipts are read from a directory this file writes, and
 * `stackGrants()`'s per-process cache is reset and re-primed from it, which is
 * exactly what a new process reading the receipts the boot wrote does.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-stack-wait-")));
fs.mkdirSync(path.join(tmp, "claude", "projects"), { recursive: true });

process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
// Pinned rather than left to fall back to CLAUDE_HOME: the pre-cycle guard
// reaches `planUsage()`, which sends a request when it finds an OAuth token.
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");
process.env.WORKSPACE_ROOT = path.join(tmp, "workspace");
delete process.env.WORKSPACE_ROOTS;
// A path that does not exist, so a spawn the stub below fails to catch is a
// failed test rather than a billed one.
process.env.CLAUDE_BIN = path.join(tmp, "no-such-claude");

const config = require("./config") as typeof import("./config");
assert.equal(
  config.DATA_DIR,
  process.env.DATA_DIR,
  "config was already loaded by another test file in this process — refusing to " +
    "run against the real database",
);

const { createRun, getRun, reconcileOnBoot, releaseStackWaits, stopRun } =
  require("./orchestrator") as typeof import("./orchestrator");
const { readReceipts, stackGrants } = require("./stacks") as typeof import("./stacks");
const { declineStackRequest, recordStackRequest, stackRequestsOfRun, stackWaitOf } =
  require("./stackRequests") as typeof import("./stackRequests");
const { db } = require("./db") as typeof import("./db");

const receiptsDir = path.join(tmp, "receipts");
fs.mkdirSync(receiptsDir, { recursive: true });

/** What the receipts say after "the restart": write one, as the applier would. */
function writeReceipt(name: string, status: "ok" | "failed", bins: string[]): void {
  fs.writeFileSync(
    path.join(receiptsDir, `${name}.json`),
    JSON.stringify({
      name,
      digest: "0".repeat(64),
      status,
      appliedAt: "2026-10-01T00:00:00Z",
      bin: status === "ok" ? bins.map((bin) => ({ name: bin, path: `/var/lib/uf-stacks/bin/${bin}` })) : [],
      deny: [],
      error: status === "ok" ? null : { text: "stack terraform: sha256 mismatch\nmore", bytes: 40 },
    }),
  );
}

/** A new process reading the receipts the boot wrote: the grants cache is per process. */
function restartReadsReceipts(): void {
  (globalThis as unknown as { __ufStackGrants: { value: unknown } }).__ufStackGrants.value = null;
  stackGrants(receiptsDir);
}

/** The process before any stack: an empty grant, cached. */
restartReadsReceipts();

/**
 * What each work cycle does: optionally ask for a stack while it runs, the way
 * an agent's `request_stack` call lands mid-cycle, and then reply.
 */
interface Cycle {
  ask?: { name: string; binaries: string[] };
  reply: string;
}

let script: Cycle[] = [];
let scriptedRun = "";
/** The argv each spawn was handed, in order. */
let argvs: string[][] = [];

const childProcess = require("node:child_process") as Record<string, unknown>;
const realSpawn = childProcess.spawn as (...args: unknown[]) => unknown;

childProcess.spawn = (command: unknown, ...rest: unknown[]) => {
  if (command !== config.CLAUDE_BIN) return realSpawn(command, ...rest);
  argvs.push([...(rest[0] as string[])]);
  const step = script.shift() ?? { reply: "The stub ran out of script." };
  if (step.ask) {
    const outcome = recordStackRequest({
      runId: scriptedRun,
      input: { ...step.ask, reason: "The task builds a Rust crate.", draft: null },
      receipts: readReceipts(receiptsDir).receipts,
      waitsSoFar: getRun(scriptedRun)!.stack_waits,
    });
    assert.equal(outcome.kind, "filed", `the stub's request was not filed: ${outcome.kind}`);
  }

  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    // No pid, so `signalTree` never reaches `process.kill(-pid)`.
    pid: undefined as number | undefined,
    kill: () => true,
  });
  // After `runIteration` has attached its listeners, which it does once
  // `spawn` has returned.
  setImmediate(() => {
    stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "sess-stack" })}\n`);
    stdout.write(
      `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: step.reply, total_cost_usd: 0, session_id: "sess-stack" })}\n`,
    );
    stdout.end();
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  });
  return child;
};

after(() => {
  childProcess.spawn = realSpawn;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function start(folder: string, cycles: Cycle[]): string {
  fs.mkdirSync(path.join(tmp, "workspace", folder), { recursive: true });
  script = [...cycles];
  argvs = [];
  const run = createRun({
    folder,
    mountId: null,
    prompt: "build the crate",
    // The default cap, which is the case the refund exists for.
    budget: { maxIterations: 1 },
    origin: "form",
  });
  scriptedRun = run.id;
  return run.id;
}

/** Wait for the segment in flight to end, however it ends. */
async function settled(id: string): Promise<NonNullable<ReturnType<typeof getRun>>> {
  for (let i = 0; i < 1_000; i++) {
    const row = getRun(id)!;
    if (row.status !== "queued" && row.status !== "running") return row;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`run ${id} never left running`);
}

/** The values one variadic flag carries, up to the next flag. */
function flagValues(args: string[], flag: string): string[] {
  const at = args.indexOf(flag);
  if (at === -1) return [];
  const rest = args.slice(at + 1);
  const end = rest.findIndex((a) => a.startsWith("--"));
  return end === -1 ? rest : rest.slice(0, end);
}

describe("a run that asks for a stack", () => {
  it("parks at the boundary on the default cap, refunded, and resumes granted once installed", async () => {
    const id = start("asks-for-rust", [
      { ask: { name: "rust", binaries: ["cargo"] }, reply: "DONE" },
      { reply: "DONE" },
    ]);

    const parked = await settled(id);
    // `DONE` in the same reply as the request is the case the placement is
    // for: below the park, it completes the run with the request still pending.
    assert.equal(parked.status, "waiting-for-stack", parked.stop_reason ?? "");
    assert.equal(parked.iterations, 0, "the cycle that asked was charged, so the cap ends the resume");
    assert.equal(parked.stack_waits, 1);
    assert.equal(parked.pause_count, 1, "ensureWorktree reads this as having worked before");
    assert.notEqual(parked.paused_at, null, "the wait has to be an open park, or it counts as worked time");
    assert.equal(parked.finished_at, null);
    assert.equal(parked.reported_done, 0, "a DONE said without the tool is not recorded as one");

    // Nothing is installed yet, so a sweep keeps it waiting.
    assert.deepEqual(releaseStackWaits(readReceipts(receiptsDir).receipts), { released: 0, waiting: 1 });
    assert.equal(getRun(id)!.status, "waiting-for-stack");

    writeReceipt("rust", "ok", ["cargo", "rustc"]);
    restartReadsReceipts();
    assert.deepEqual(releaseStackWaits(readReceipts(receiptsDir).receipts), { released: 1, waiting: 0 });

    const done = await settled(id);
    assert.equal(done.status, "completed", done.stop_reason ?? "");
    assert.equal(argvs.length, 2);
    assert.equal(done.paused_at, null, "the claim closes the park");
    assert.deepEqual(stackWaitOf(id), [], "a released run is waiting on nothing");

    const resumed = argvs[1];
    assert.equal(resumed[resumed.indexOf("--resume") + 1], "sess-stack", "it resumes the same session");
    assert.ok(
      flagValues(resumed, "--allowedTools").includes("Bash(cargo:*)"),
      "the resumed cycle is not granted the binary it waited for",
    );
    assert.ok(
      !flagValues(argvs[0], "--allowedTools").includes("Bash(cargo:*)"),
      "the control: the first cycle, before the stack, had no grant for it",
    );
    const prompt = resumed[resumed.indexOf("-p") + 1];
    assert.match(prompt, /installed/);
    assert.match(prompt, /cargo, rustc/);
  });

  it("stays waiting on a failed receipt, and Stop ends the wait and closes the park", async () => {
    const id = start("asks-for-terraform", [
      { ask: { name: "terraform", binaries: ["terraform"] }, reply: "Waiting for terraform." },
    ]);
    assert.equal((await settled(id)).status, "waiting-for-stack");

    writeReceipt("terraform", "failed", []);
    assert.deepEqual(releaseStackWaits(readReceipts(receiptsDir).receipts), { released: 0, waiting: 1 });
    assert.equal(getRun(id)!.status, "waiting-for-stack", "a failed install must not release the run");

    assert.equal(stopRun(id), "cancelled");
    const stopped = getRun(id)!;
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.paused_at, null);
    assert.deepEqual(stackWaitOf(id), []);
    const [request] = stackRequestsOfRun(id);
    assert.equal(request.state, "pending", "stopping one run does not answer the request");
  });

  it("goes back to work told so when the operator declines", async () => {
    const id = start("asks-for-zig", [
      { ask: { name: "zig", binaries: ["zig"] }, reply: "Waiting for zig." },
      { reply: "Carried on without it. DONE" },
    ]);
    assert.equal((await settled(id)).status, "waiting-for-stack");

    const [request] = stackRequestsOfRun(id);
    assert.equal(declineStackRequest(request.id), true);
    assert.equal(declineStackRequest(request.id), false, "a second press changes nothing");
    releaseStackWaits(readReceipts(receiptsDir).receipts);

    const done = await settled(id);
    assert.equal(done.status, "completed", done.stop_reason ?? "");
    const prompt = argvs[1][argvs[1].indexOf("-p") + 1];
    assert.match(prompt, /declined/);
    assert.match(prompt, /NEEDS_REVIEW/);
  });

  it("survives a boot however long it has waited, where a paused run would not", async () => {
    const id = start("asks-for-go", [
      { ask: { name: "golang", binaries: ["go"] }, reply: "Waiting for go." },
    ]);
    assert.equal((await settled(id)).status, "waiting-for-stack");
    // A week ago, far past any `resumeGraceHours`: the restart is what it is
    // waiting for, so its age is not a reason to close it out.
    db().prepare("UPDATE runs SET paused_at = ? WHERE id = ?").run(Date.now() - 7 * 86_400_000, id);

    reconcileOnBoot();
    const kept = getRun(id)!;
    assert.equal(kept.status, "waiting-for-stack", kept.stop_reason ?? "");
    assert.equal(kept.restart_closed, 0);
    stopRun(id);
  });
});
