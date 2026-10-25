import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, it, mock } from "node:test";

/**
 * The git calls that make a reused checkout ready for a run, under the clock
 * they were given.
 *
 * A slot a finished run left behind is reused with `git status --porcelain` and
 * `git checkout -b`, both of which walk the working tree. They ran under
 * `git()`'s default of 20 seconds, which is a `SIGKILL` that arrives as
 * `ok: false` with an empty `stderr` — so on a checkout whose files are slow to
 * read (an iCloud Drive vault with most of its notes evicted) a run failed at
 * setup with `Could not start branch uf/…: ` and nothing after the colon,
 * having been killed in the middle of a checkout that was making progress.
 *
 * The slow call is a `GIT_BIN` stub that hangs the first matching step in the
 * slot, and the clock is `mock.timers`, so the case advances 20 seconds and then
 * thirty minutes without waiting for either. The child is real and so is the
 * `SIGKILL`: what the case reads is the run's `stop_reason`, as an operator
 * does. `GIT_BIN` is read when `config.ts` loads, hence a file of its own; the
 * rest is `cutOffCheckout.test.ts`' harness.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-checkout-git-clock-")));
fs.mkdirSync(path.join(tmp, "claude", "projects"), { recursive: true });

for (const key of Object.keys(process.env)) {
  if (/^GIT_/.test(key)) delete process.env[key];
}
process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");
process.env.WORKSPACE_ROOT = path.join(tmp, "workspace");
delete process.env.WORKSPACE_ROOTS;
process.env.CLAUDE_BIN = path.join(tmp, "no-such-claude");

const holds = path.join(tmp, "holds");
fs.mkdirSync(holds);
const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const gitStub = path.join(tmp, "git");
fs.writeFileSync(
  gitStub,
  [
    "#!/bin/sh",
    // Hang the first step whose argv names the word in `word`, run in the dir in
    // `dir`, once `armed` exists. `exec`, so that the SIGKILL reaches the process
    // holding the pipes and the child closes the way a killed git does.
    `if [ -e '${holds}/armed' ] && [ ! -e '${holds}/started' ] && [ "$(pwd -P)" = "$(cat '${holds}/dir')" ]; then`,
    '  for arg in "$@"; do',
    `    if [ "$arg" = "$(cat '${holds}/word')" ]; then`,
    `      : > '${holds}/started'`,
    "      exec sleep 120",
    "    fi",
    "  done",
    "fi",
    `exec '${realGit}' "$@"`,
    "",
  ].join("\n"),
  { mode: 0o755 },
);
process.env.GIT_BIN = gitStub;

const config = require("./config") as typeof import("./config");
assert.equal(
  config.DATA_DIR,
  process.env.DATA_DIR,
  "config was already loaded by another test file in this process — refusing to " +
    "run against the real database",
);

const { createRun, getRun } = require("./orchestrator") as typeof import("./orchestrator");
const { db } = require("./db") as typeof import("./db");

const childProcess = require("node:child_process") as Record<string, unknown>;
const realSpawn = childProcess.spawn as (...args: unknown[]) => unknown;

childProcess.spawn = (command: unknown, ...rest: unknown[]) => {
  if (command !== config.CLAUDE_BIN) return realSpawn(command, ...rest);
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    pid: undefined as number | undefined,
    kill: () => true,
  });
  setImmediate(() => {
    stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "sess-clock" })}\n`);
    stdout.write(
      `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "DONE", total_cost_usd: 0, session_id: "sess-clock" })}\n`,
    );
    stdout.end();
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  });
  return child;
};

after(() => {
  mock.timers.reset();
  childProcess.spawn = realSpawn;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fixtureGit(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

function makeRepo(folder: string): void {
  const repo = path.join(tmp, "workspace", folder);
  fs.mkdirSync(repo, { recursive: true });
  fixtureGit(repo, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "file.txt"), "one\n");
  fixtureGit(repo, ["add", "-A"]);
  fixtureGit(repo, ["commit", "-q", "-m", "seed"]);
}

function start(folder: string): string {
  return createRun({
    folder,
    mountId: null,
    prompt: "do it",
    budget: { maxIterations: 1 },
    origin: "form",
  }).id;
}

/** Real wall-clock polling on `setImmediate`, which `mock.timers` leaves alone. */
async function until(what: string, ready: () => boolean, withinMs = 10_000): Promise<void> {
  const deadline = Date.now() + withinMs;
  while (!ready()) {
    if (Date.now() > deadline) assert.fail(`${what} never happened`);
    await new Promise((r) => setImmediate(r));
  }
}

async function pause(ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) await new Promise((r) => setImmediate(r));
}

const isSettled = (id: string) => {
  const status = getRun(id)!.status;
  return status !== "queued" && status !== "running";
};

/**
 * A finished run, so that its slot is clean and registered for the next one.
 *
 * Waited out past its `handoff` event, not just its status: the run is
 * `completed` before `emitHandoff` has run its own `git status` in the slot, and
 * that one would take the stub's hang meant for the next run's setup.
 */
async function finishedRunIn(folder: string) {
  makeRepo(folder);
  const first = start(folder);
  await until(`run ${first}`, () => isSettled(first));
  const handoff = db().prepare("SELECT 1 FROM run_events WHERE run_id = ? AND kind = 'handoff'");
  await until(`run ${first}'s handoff`, () => handoff.get(first) !== undefined);
  const row = getRun(first)!;
  assert.equal(row.status, "completed", row.stop_reason ?? "");
  assert.equal(row.isolation, "worktree");
  return { slot: row.worktree_path!, firstBranch: row.worktree_branch! };
}

const HUNG = [
  { word: "checkout", command: /git checkout -b uf\/\S+ \S+/ },
  { word: "status", command: /git status --porcelain/ },
];

describe("a reused checkout's working-tree git calls", () => {
  for (const { word, command } of HUNG) {
    it(`give \`git ${word}\` thirty minutes, and say so when that runs out`, async () => {
      const folder = `hung-${word}`;
      const { slot } = await finishedRunIn(folder);

      const second = start(folder);
      const planned = getRun(second)!;
      assert.equal(planned.worktree_path, slot, "the second run should take the first one's slot");

      // Armed and mocked before the first `await` of the second run's setup, so
      // the stub meets the reuse path's own call and not an admission probe.
      fs.writeFileSync(path.join(holds, "dir"), slot);
      fs.writeFileSync(path.join(holds, "word"), word);
      fs.writeFileSync(path.join(holds, "armed"), "");
      mock.timers.enable({ apis: ["setTimeout"] });
      try {
        await until(`git ${word} reaching the slot`, () => fs.existsSync(path.join(holds, "started")));

        mock.timers.tick(20_001);
        await pause(300);
        assert.equal(
          getRun(second)!.status,
          "running",
          `git ${word} was cut off at git()'s default 20 s: ${getRun(second)!.stop_reason}`,
        );

        mock.timers.tick(30 * 60_000);
        await until(`run ${second}`, () => isSettled(second));
      } finally {
        mock.timers.reset();
        for (const entry of fs.readdirSync(holds)) fs.rmSync(path.join(holds, entry));
      }

      const reason = getRun(second)!.stop_reason ?? "";
      assert.equal(getRun(second)!.status, "failed", reason);
      assert.match(reason, command);
      assert.ok(reason.includes(slot), `the checkout is not named: ${reason}`);
      assert.match(reason, /killed after 30m/);
      assert.doesNotMatch(reason, /still has uncommitted work/, "a call that never answered is not a dirty tree");
      assert.doesNotMatch(reason, /:\s*$/, "the message ends on an empty reason");
    });
  }

  it("hands git's own words over unaltered when a leftover index.lock refuses the checkout", async () => {
    const folder = "locked";
    const { slot } = await finishedRunIn(folder);
    const gitDir = fixtureGit(slot, ["rev-parse", "--absolute-git-dir"]);
    fs.writeFileSync(path.join(gitDir, "index.lock"), "");

    const second = start(folder);
    assert.equal(getRun(second)!.worktree_path, slot, "the second run should take the first one's slot");
    await until(`run ${second}`, () => isSettled(second));

    const reason = getRun(second)!.stop_reason ?? "";
    assert.equal(getRun(second)!.status, "failed", reason);
    assert.match(reason, /^Could not start branch uf\/\S+: fatal: Unable to create '.*index\.lock': File exists\./);
    assert.doesNotMatch(reason, /killed|timed out/);
  });
});
