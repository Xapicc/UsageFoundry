import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Task } from "./tasks";

/**
 * What an operator's Stop does to a completion check still reading.
 *
 * A validation outlives the cycle that called `complete_task`: the loop waits
 * for it at the boundary, and a run can park with it in flight. `stopRun`
 * signalled only the work cycle's child, so the check went on reading on its
 * own ten-minute clock, billed, and its settle then closed the task `done` in
 * the name of a run the operator had stopped — a green row nobody re-reads,
 * written by nobody who decided it. So this drives the real path: a real
 * repository and branch, `completeTaskWithValidation` as `complete_task` calls
 * it, and a stand-in `claude` that never answers unless it is signalled, and
 * then answers `finished` on its way out, as a CLI that handles SIGINT may.
 * That answer is the case the settle has to refuse rather than merely not see.
 *
 * Its own file, with `DATA_DIR` named before the first import, for
 * `loopMergeOwnership.test.ts`'s reason.
 */

let validation: typeof import("./validation");
let review: typeof import("./review");
let orchestrator: typeof import("./orchestrator");
let tasks: typeof import("./tasks");
let settings: typeof import("./settings");
let database: typeof import("./db");
let root: string;

const MOUNT_DIR = "validation-stop-mount";
const BRANCH = "uf/validation-stop";
const repoRoot = () => path.join(root, MOUNT_DIR, "repo");
const control = (name: "started" | "signalled" | "answer") => path.join(root, `stub-${name}`);

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });

/**
 * A `claude` that reads for ever until it is signalled or told to answer.
 *
 * `signalled` records which signal reached it, which is the one direct proof
 * that the Stop did; `answer` is how a failing case lets it go. The
 * thirty-second exit is a backstop for a failing run.
 */
function writeStub(dir: string): string {
  const stub = path.join(dir, "claude-stub.js");
  const verdict = JSON.stringify({
    verdict: "finished",
    reason: "the change the task names is on the branch",
    evidence: [],
  });
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(control("started"))}, String(process.pid));
const answer = () => {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "\`\`\`json\\n" + ${JSON.stringify(verdict)} + "\\n\`\`\`", total_cost_usd: 0.02 }) + "\\n");
  process.exit(0);
};
process.on("SIGINT", () => {
  fs.writeFileSync(${JSON.stringify(control("signalled"))}, "SIGINT");
  answer();
});
setInterval(() => {
  if (fs.existsSync(${JSON.stringify(control("answer"))})) answer();
}, 20);
setTimeout(() => process.exit(9), 30000);
`,
    { mode: 0o755 },
  );
  return stub;
}

before(async () => {
  // `realpathSync`, which `resolveInMount` checks containment against.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-validation-stop-")));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  // `planUsage` looks for an OAuth token here, and a unit test must not send a
  // request on the operator's own credential.
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, MOUNT_DIR);
  process.env.WORKSPACE_ROOTS = "";
  process.env.CLAUDE_BIN = writeStub(root);
  fs.mkdirSync(path.join(root, "claude", "projects"), { recursive: true });

  fs.mkdirSync(repoRoot(), { recursive: true });
  git(repoRoot(), "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repoRoot(), "a.txt"), "one\n");
  git(repoRoot(), "add", "-A");
  git(repoRoot(), "commit", "-q", "-m", "first");
  git(repoRoot(), "checkout", "-q", "-b", BRANCH);
  fs.writeFileSync(path.join(repoRoot(), "a.txt"), "two\n");
  git(repoRoot(), "commit", "-q", "-am", "the task's change");
  git(repoRoot(), "checkout", "-q", "main");

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );
  assert.equal(config.CLAUDE_BIN, process.env.CLAUDE_BIN);

  database = await import("./db");
  settings = await import("./settings");
  tasks = await import("./tasks");
  validation = await import("./validation");
  review = await import("./review");
  orchestrator = await import("./orchestrator");
  settings.saveSettings({ validateTaskCompletion: true });
});

after(() => {
  // A failing case leaves its stub reading; let it go rather than wait out the
  // backstop.
  fs.writeFileSync(control("answer"), "");
  const open = (globalThis as { __ufDb?: { close(): void } }).__ufDb;
  open?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  for (const name of ["started", "signalled", "answer"] as const) {
    fs.rmSync(control(name), { force: true });
  }
});

let seq = 0;

/** A run on its own branch, in the status the case stops it from. */
function worktreeRun(status: "running" | "paused"): string {
  const runId = `run-stop-${(seq += 1)}`;
  const base = git(repoRoot(), "rev-parse", "main").trim();
  database
    .db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                         created_at, isolation, repo_root, worktree_branch, worktree_base,
                         worktree_base_branch, worktree_path)
       VALUES (?, ?, 'change a', ?, '{}', 5, 1, ?, 'worktree', ?, ?, ?, 'main', ?)`,
    )
    .run(runId, repoRoot(), status, Date.now(), repoRoot(), BRANCH, base, repoRoot());
  return runId;
}

/** Filed through the real door and claimed by the run, as a started run's are. */
function heldTask(runId: string, title: string): Task {
  const parsed = tasks.normalizeTaskInput(
    { title, body: "change a.txt" },
    { origin: "operator", createdByRunId: null },
  );
  if (!parsed.ok) throw new Error(`fixture refused at the door: ${parsed.error}`);
  const created = tasks.createTask(parsed.value);
  if (!created.ok) throw new Error(`fixture refused by the store: ${created.error}`);
  const claimed = tasks.updateTask(created.task.id, { status: "claimed" }, { kind: "run", runId });
  if (!claimed.ok) throw new Error(`fixture claim refused: ${claimed.error}`);
  return claimed.task;
}

/** `complete_task`, and the child it started, alive and reading. */
async function startCheck(runId: string, task: Task): Promise<string> {
  const outcome = await validation.completeTaskWithValidation(task.id, runId);
  assert.equal(outcome.kind, "checking", JSON.stringify(outcome));
  await until("the validator to start", () => fs.existsSync(control("started")));
  return outcome.kind === "checking" ? outcome.reviewId : "";
}

async function until(what: string, ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!ready()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function logLines(runId: string): string[] {
  return (
    database
      .db()
      .prepare("SELECT payload FROM run_events WHERE run_id = ? AND kind = 'log' ORDER BY id")
      .all(runId) as { payload: string }[]
  ).map((row) => (JSON.parse(row.payload) as { message: string }).message);
}

/** Everything a stopped check must leave: its child signalled, its task unclosed. */
async function assertStoppedCheck(runId: string, task: Task, reviewId: string): Promise<void> {
  await until(
    "the validation to settle — the Stop did not reach its child",
    () => review.getAssist(reviewId)?.status !== "running",
  );
  assert.equal(fs.readFileSync(control("signalled"), "utf8"), "SIGINT");

  const held = tasks.getTask(task.id)!;
  assert.equal(
    held.status,
    "claimed",
    "the check's settle closed the task in the name of a run the operator stopped",
  );
  assert.equal(held.claimedByRunId, runId);
  assert.equal(held.completedByRunId, null);

  const row = review.getAssist(reviewId)!;
  // The child's own `finished` is not recorded as a verdict nothing acted on,
  // and a null here has to say why it is not "closed unchecked".
  assert.equal(row.status, "failed");
  assert.equal(row.verdict, null);
  assert.match(row.error ?? "", /stopped/i);
  assert.ok(
    logLines(runId).some((line) => /stopped/i.test(line) && /not closed/.test(line)),
    logLines(runId).join("\n"),
  );
}

describe("an operator's Stop with a completion check in flight", () => {
  it("signals the check and leaves the task claimed when it lands during the verdict wait", async () => {
    const runId = worktreeRun("running");
    const task = heldTask(runId, "Change a.txt");
    const since = Date.now();
    const reviewId = await startCheck(runId, task);

    // The loop's own wait, with the loop's own test of whether it was told to
    // stop. No work cycle is in flight there, so there is no child in `procs`.
    const pending = (globalThis as unknown as { __ufInterrupts: Map<string, unknown> })
      .__ufInterrupts;
    const wait = validation.validationAtBoundary(runId, since, () => pending.has(runId));
    assert.equal(orchestrator.stopRun(runId), "cancelled");
    assert.equal(await wait, null);

    await assertStoppedCheck(runId, task, reviewId);
  });

  it("reaches it from a parked run too, which has no loop to read the Stop", async () => {
    const runId = worktreeRun("paused");
    const task = heldTask(runId, "Change a.txt while parked");
    const reviewId = await startCheck(runId, task);

    assert.equal(orchestrator.stopRun(runId), "cancelled");
    assert.equal(orchestrator.getRun(runId)!.status, "stopped");

    await assertStoppedCheck(runId, task, reviewId);
  });
});
