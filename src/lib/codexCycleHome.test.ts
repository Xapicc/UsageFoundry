import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, beforeEach, describe, it } from "node:test";

/**
 * Board task `27f99097`: every Codex work cycle gets a `CODEX_HOME` of its own.
 *
 * A cycle whose trust write into `$CODEX_HOME/config.toml` failed loaded its
 * repository's `.codex/config.toml` (codex-cli 0.153.4), and in the shared home
 * any cycle could fail that write for another in the ~0.1 s before it. Nothing
 * says which happened, so what is pinned is the shape that keeps it from
 * happening: a fresh home per cycle whose `config.toml` starts absent, links
 * back to the shared entries a cycle reads and writes, and a removal that
 * deletes the cycle's own files and never what the links name, leaving a home
 * that started a thread as the anchor of the path Codex recorded for it.
 *
 * Its own file with the environment set before anything is required, for the
 * reason every database-backed test here needs it. The suite is not root, so
 * this is the path without a uid split; the split's modes and the agents' `rm`
 * are the Verified entry's.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-codex-cycle-home-")));
const shared = path.join(tmp, "codex-home");
fs.mkdirSync(path.join(shared, "rules"), { recursive: true });
fs.mkdirSync(path.join(tmp, "workspace", "project"), { recursive: true });

process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
process.env.CODEX_HOME = shared;
process.env.WORKSPACE_ROOT = path.join(tmp, "workspace");
delete process.env.WORKSPACE_ROOTS;
process.env.CLAUDE_BIN = path.join(tmp, "no-such-claude");
process.env.CODEX_BIN = path.join(tmp, "no-such-codex");

const config = require("./config") as typeof import("./config");
assert.equal(
  config.DATA_DIR,
  process.env.DATA_DIR,
  "config was already loaded by another test file in this process — refusing to " +
    "run against the real database",
);

const { CODEX_CYCLE_HOME_LINKS, codexCycleHomesBase, prepareCodexCycleHome, releaseCodexCycleHome } =
  require("./codexCycleHome") as typeof import("./codexCycleHome");
const { createRun, getRun } = require("./orchestrator") as typeof import("./orchestrator");

const sharedConfig = path.join(shared, "config.toml");

/** The shared home as a signed-in install has it, with `config.toml` left as `plant` makes it. */
function sharedHome(plant: () => void = () => {}): void {
  fs.rmSync(sharedConfig, { recursive: true, force: true });
  fs.writeFileSync(path.join(shared, "auth.json"), '{"OPENAI_API_KEY":"sk-fake-test-0000"}');
  fs.writeFileSync(path.join(shared, "installation_id"), "aaaaaaaa-1111-4222-8333-444444444444");
  plant();
}

function readyHome(prepared: Awaited<ReturnType<typeof prepareCodexCycleHome>>): { home: string; env: Record<string, string> } {
  assert.equal(prepared.kind, "ready", prepared.kind === "unavailable" ? prepared.reason : "");
  return prepared as { kind: "ready"; home: string; env: Record<string, string> };
}

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("prepareCodexCycleHome", () => {
  beforeEach(() => sharedHome());

  it("makes a fresh home with no config.toml, linking back every shared entry a cycle uses", async () => {
    const { home, env } = readyHome(await prepareCodexCycleHome("run-a"));
    try {
      assert.equal(path.dirname(home), codexCycleHomesBase());
      assert.equal(codexCycleHomesBase(), path.join(shared, ".uf-cycle-homes"));
      assert.deepEqual(env, { CODEX_HOME: home, CODEX_SQLITE_HOME: shared });
      // The one thing the cycle writes for itself, so it must start absent:
      // anything there would be what its trust write reads.
      assert.equal(fs.readdirSync(home).includes("config.toml"), false);
      for (const name of CODEX_CYCLE_HOME_LINKS) {
        assert.equal(fs.readlinkSync(path.join(home, name)), path.join(shared, name), name);
      }
      // A link to a missing directory failed the whole cycle on 0.153.4, so
      // the two Codex makes on first use exist before it starts.
      for (const name of ["sessions", "thread-writer-locks"]) {
        assert.equal(fs.statSync(path.join(shared, name)).isDirectory(), true, `${name} was not made`);
      }
      assert.equal((fs.statSync(codexCycleHomesBase()).mode & 0o777).toString(8), "700");
    } finally {
      assert.equal(await releaseCodexCycleHome("run-a"), null);
    }
  });

  it("gives every cycle a different home, so none can be found from another's name", async () => {
    const a = readyHome(await prepareCodexCycleHome("run-a")).home;
    const b = readyHome(await prepareCodexCycleHome("run-b")).home;
    try {
      assert.notEqual(a, b);
      assert.match(path.basename(a), /^[0-9a-f]{32}$/);
    } finally {
      await releaseCodexCycleHome("run-a");
      await releaseCodexCycleHome("run-b");
    }
  });

  it("is not stopped by anything at the shared config.toml", async () => {
    // Each of these refused every Codex cycle before, since the cycle's trust
    // write went there.
    for (const plant of [
      () => fs.mkdirSync(sharedConfig),
      () => fs.writeFileSync(sharedConfig, "[[["),
      () => fs.symlinkSync("/no/such/file", sharedConfig),
    ]) {
      sharedHome(plant);
      readyHome(await prepareCodexCycleHome("run-a"));
      await releaseCodexCycleHome("run-a");
    }
  });
});

describe("releaseCodexCycleHome", () => {
  beforeEach(() => sharedHome());

  it("removes the cycle's own files and never what its links name", async () => {
    const { home } = readyHome(await prepareCodexCycleHome("run-a"));
    // What a cycle leaves: its trust entry and scratch, and a rollout written
    // through the link into the shared `sessions/`.
    fs.writeFileSync(path.join(home, "config.toml"), '[projects."/w"]\ntrust_level = "trusted"\n');
    fs.mkdirSync(path.join(home, "shell_snapshots"));
    fs.writeFileSync(path.join(home, "shell_snapshots", "s.sh"), "");
    fs.writeFileSync(path.join(home, "sessions", "rollout-x.jsonl"), "{}\n");

    assert.equal(await releaseCodexCycleHome("run-a"), null);
    assert.equal(fs.existsSync(home), false, "the cycle's home is still there");
    assert.equal(fs.readFileSync(path.join(shared, "sessions", "rollout-x.jsonl"), "utf8"), "{}\n");
    assert.equal(fs.readFileSync(path.join(shared, "auth.json"), "utf8"), '{"OPENAI_API_KEY":"sk-fake-test-0000"}');
    assert.equal(fs.statSync(path.join(shared, "rules")).isDirectory(), true);
    assert.equal(await releaseCodexCycleHome("run-a"), null, "a second release is not a no-op");
  });

  it("keeps a home that started a thread as nothing but its sessions link, which only root can change", async () => {
    // The state database records a rollout through the home that started its
    // thread, and `exec resume` answered `no rollout found` once that home was
    // gone (0.153.4).
    const { home } = readyHome(await prepareCodexCycleHome("run-a"));
    fs.writeFileSync(path.join(home, "config.toml"), "");
    fs.mkdirSync(path.join(home, ".tmp"));
    fs.writeFileSync(path.join(home, "sessions", "rollout-y.jsonl"), "{}\n");

    assert.equal(await releaseCodexCycleHome("run-a", true), null);
    assert.deepEqual(fs.readdirSync(home), ["sessions"]);
    assert.equal(fs.readlinkSync(path.join(home, "sessions")), path.join(shared, "sessions"));
    assert.equal((fs.statSync(home).mode & 0o7777).toString(8), "755");
    assert.equal(fs.existsSync(path.join(home, "sessions", "rollout-y.jsonl")), true, "the path no longer resolves");
  });

  it("clears a run's previous home when its next one is made", async () => {
    // A cycle that threw between making its home and spawning never reached
    // the `finally` that removes it.
    const first = readyHome(await prepareCodexCycleHome("run-a")).home;
    const second = readyHome(await prepareCodexCycleHome("run-a")).home;
    try {
      assert.equal(fs.existsSync(first), false, "the earlier home was left");
    } finally {
      await releaseCodexCycleHome("run-a");
    }
    assert.equal(fs.existsSync(second), false);
  });
});

/**
 * The run loop's half: the cycle is spawned in its own home, not the shared
 * one the server's environment names, and the home is gone once the cycle is.
 * Drives the real loop against a stubbed child, as `codexKilledCycle.test.ts`
 * does, with a directory at the shared `config.toml`, which refused the cycle
 * before it spawned until this change.
 */
describe("a Codex work cycle", () => {
  const childProcess = require("node:child_process") as Record<string, unknown>;
  const realSpawn = childProcess.spawn as typeof import("node:child_process").spawn;
  const seen: { home: string; sqliteHome: string | undefined; linked: string | null; config: boolean }[] = [];

  after(() => {
    childProcess.spawn = realSpawn;
  });

  it("runs in a home of its own, cleared when the cycle ends and kept as its thread's anchor", async () => {
    sharedHome(() => fs.mkdirSync(sharedConfig));
    childProcess.spawn = (command: string, _args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      const home = opts.env.CODEX_HOME ?? "";
      if (command === config.CODEX_BIN) {
        seen.push({
          home,
          sqliteHome: opts.env.CODEX_SQLITE_HOME,
          linked: fs.existsSync(home) ? fs.readlinkSync(path.join(home, "auth.json")) : null,
          config: fs.existsSync(path.join(home, "config.toml")),
        });
      }
      const stdout = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        stdout,
        stderr: new PassThrough(),
        pid: undefined as number | undefined,
        kill() {
          return true;
        },
      });
      setImmediate(() => {
        stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "01a1be20-0000-7000-8000-000000000001" })}\n`);
        stdout.write(`${JSON.stringify({ type: "turn.started" })}\n`);
        stdout.write(
          `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 } })}\n`,
        );
        stdout.end();
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      });
      return child;
    };

    const run = createRun({
      folder: "project",
      mountId: null,
      prompt: "do the thing",
      provider: "codex",
      budget: { maxIterations: 1, enforcement: "between-cycles" },
      origin: "form",
    });
    for (let i = 0; i < 300 && !["completed", "stopped", "failed", "blocked", "paused"].includes(getRun(run.id)!.status); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    assert.equal(seen.length, 1, `the cycle was not spawned: ${getRun(run.id)!.stop_reason}`);
    const [cycle] = seen;
    assert.notEqual(cycle.home, shared, "the cycle was spawned in the shared CODEX_HOME");
    assert.equal(path.dirname(cycle.home), codexCycleHomesBase());
    assert.equal(cycle.sqliteHome, shared, "the cycle's SQLite state left the shared home");
    assert.equal(cycle.linked, path.join(shared, "auth.json"), "the cycle's home had no link to the sign-in");
    assert.equal(cycle.config, false, "the cycle's home started with a config.toml");
    // The cycle started a thread, so its home is that thread's anchor now.
    assert.deepEqual(fs.readdirSync(cycle.home), ["sessions"], "the cycle's home was not cleared to its anchor");
  });
});
