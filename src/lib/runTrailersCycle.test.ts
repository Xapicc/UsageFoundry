import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, it } from "node:test";

/**
 * The commits an agent makes inside a cycle carry their run's trailers once the
 * cycle is over.
 *
 * The stamp is a call in the run loop and every part of it is silent when it is
 * missing: the run completes, the branch lands, and the commits are as anonymous
 * as before — which is the state the feature exists to end. So this drives a
 * real run through `createRun` with a stub agent that commits in its working
 * directory, and reads the branch back with git.
 *
 * `cutOffCheckout.test.ts`'s harness, for its reasons: `config.ts` fixes
 * `DATA_DIR` at load and `spawn` is replaced for the life of the process.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-run-trailers-")));
fs.mkdirSync(path.join(tmp, "claude", "projects"), { recursive: true });

process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");
process.env.WORKSPACE_ROOT = path.join(tmp, "workspace");
delete process.env.WORKSPACE_ROOTS;
process.env.CLAUDE_BIN = path.join(tmp, "no-such-claude");

const config = require("./config") as typeof import("./config");
assert.equal(
  config.DATA_DIR,
  process.env.DATA_DIR,
  "config was already loaded by another test file in this process — refusing to " +
    "run against the real database",
);

const { createRun, getRun } = require("./orchestrator") as typeof import("./orchestrator");
const { saveSettings } = require("./settings") as typeof import("./settings");

/** Run inside the next spawn, in its working directory, as the agent would. */
let during: ((cwd: string) => void) | null = null;

const childProcess = require("node:child_process") as Record<string, unknown>;
const realSpawn = childProcess.spawn as (...args: unknown[]) => unknown;

childProcess.spawn = (command: unknown, ...rest: unknown[]) => {
  if (command !== config.CLAUDE_BIN) return realSpawn(command, ...rest);
  const cwd = (rest[1] as { cwd: string }).cwd;
  during?.(cwd);
  during = null;

  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    pid: undefined as number | undefined,
    kill: () => true,
  });
  setImmediate(() => {
    stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "sess-trailers" })}\n`);
    stdout.write(
      `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "DONE", total_cost_usd: 0, session_id: "sess-trailers" })}\n`,
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

/** The identity the agent commits under, which the stamp has to leave alone. */
const AGENT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "UsageFoundry Agent",
  GIT_AUTHOR_EMAIL: "agent@example.invalid",
  GIT_COMMITTER_NAME: "UsageFoundry Agent",
  GIT_COMMITTER_EMAIL: "agent@example.invalid",
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_DATE: "1700000000 +0000",
};

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: AGENT_ENV }).trim();
}

function makeRepo(folder: string): string {
  const repo = path.join(tmp, "workspace", folder);
  fs.mkdirSync(repo, { recursive: true });
  sh(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "seed.txt"), "seed\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "seed");
  return repo;
}

/** What an agent does in a cycle: two commits, as the run's checkout. */
function commitTwice(cwd: string): void {
  for (const name of ["note-a.md", "note-b.md"]) {
    fs.writeFileSync(path.join(cwd, name), `${name}\n`);
    sh(cwd, "add", "-A");
    sh(cwd, "commit", "-q", "-m", `write ${name}`);
  }
}

async function settled(id: string): Promise<NonNullable<ReturnType<typeof getRun>>> {
  for (let i = 0; i < 1_000; i++) {
    const row = getRun(id)!;
    if (row.status !== "queued" && row.status !== "running") return row;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`run ${id} never left running`);
}

describe("a cycle's commits carry the run's trailers", () => {
  it("stamps an isolated run's own commits, keeping what git recorded about them", async () => {
    const repo = makeRepo("isolated");
    saveSettings({ maxConcurrentRuns: 4 });
    during = commitTwice;
    const id = createRun({
      folder: "isolated",
      mountId: null,
      prompt: "write two notes",
      model: "claude-test-model",
      budget: { maxIterations: 1 },
      origin: "form",
      isolate: true,
      taskIds: ["task-from-the-board"],
    }).id;

    const run = await settled(id);

    assert.equal(run.isolation, "worktree");
    assert.equal(run.status, "completed", `ended ${run.status}`);
    const branch = run.worktree_branch!;
    const rows = sh(repo, "log", "--reverse", "--format=%an|%ae|%ad|%s|%(trailers:only,unfold)", "--date=raw", `main..${branch}`)
      .split("\n\n")
      .filter(Boolean);
    assert.equal(rows.length, 2, rows.join("\n--\n"));
    for (const row of rows) {
      assert.match(row, /^UsageFoundry Agent\|agent@example\.invalid\|1700000000 \+0000\|write note-[ab]\.md\|/);
      assert.ok(row.includes(`UF-Run: ${id}`), row);
      assert.ok(row.includes("UF-Task: task-from-the-board"), row);
      assert.ok(row.includes("Model: claude-test-model"), row);
    }
    assert.equal(sh(repo, "rev-parse", "main"), run.worktree_base, "the operator's branch moved");
    assert.equal(sh(run.worktree_path!, "status", "--porcelain"), "", "the checkout was disturbed");
    assert.equal(sh(run.worktree_path!, "rev-parse", "--abbrev-ref", "HEAD"), branch);
  });

  it("does not rewrite the operator's own branch for a run that works in its checkout", async () => {
    const repo = makeRepo("in-place");
    during = commitTwice;
    const id = createRun({
      folder: "in-place",
      mountId: null,
      prompt: "write two notes",
      budget: { maxIterations: 1 },
      origin: "form",
      isolate: false,
    }).id;

    const run = await settled(id);

    assert.equal(run.isolation, "none");
    assert.equal(sh(repo, "rev-list", "--count", "main"), "3");
    assert.doesNotMatch(sh(repo, "log", "--format=%B", "main"), /UF-Run/);
  });
});

