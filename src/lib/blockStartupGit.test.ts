import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

/**
 * A workflow block's turn does not stand in the repository it decides about.
 *
 * The chat and block child holds `UF_CHAT_GID`, which reads its own capability
 * file, and that capability starts runs. A work cycle can write the `.git` of
 * every checkout it works in, and a clean filter named from
 * `.git/info/attributes` runs on a plain `git status` whenever a file's size
 * matches the index and its mtime does not — and no git variable, `-c` pair or
 * flag turns a filter off (`docs/agent/security/chat-child-config-files.md`).
 * The pinned CLI runs `git status --short --ignore-submodules=dirty` itself at
 * startup in a repository cwd, outside any `Bash` sandbox and before any tool
 * call, and runs no git at all in an `--add-dir` (both measured on 2.1.280,
 * board task `7764bc65`). A block used to be spawned with its folder as the
 * cwd, so a block run where a work cycle had worked ran that cycle's filter
 * holding the capability, with nothing on any page saying so.
 *
 * The stub stands in for that startup: it runs the same `git status` in
 * whatever cwd it was spawned in, under the environment the real spawn gave
 * it, and records the cwd and argv. The child is started through the real
 * `runOrchestratorChild`, because the cwd is decided inline at the spawn. Its
 * own file with the environment set before anything is required, for
 * `promptArgv.test.ts`'s reason: `config.ts` fixes `DATA_DIR`, `CLAUDE_BIN`
 * and the mounts at module load.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-block-startup-git-")));
const project = path.join(tmp, "workspace", "project");
const marker = path.join(tmp, "clean-filter-ran");
const receivedFile = path.join(tmp, "received.json");

const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
fs.writeFileSync(${JSON.stringify(receivedFile)}, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }));
// What the pinned CLI runs first in a repository cwd. Outside one it fails,
// which is the point.
spawnSync("git", ["status", "--short", "--ignore-submodules=dirty"], { stdio: "ignore" });
const session = "stub-session";
const usage = { input_tokens: 10, output_tokens: 5 };
for (const event of [
  { type: "system", subtype: "init", session_id: session },
  { type: "assistant", session_id: session, message: { id: "msg_1", role: "assistant", content: [{ type: "text", text: "Nothing to emit." }], usage } },
  { type: "result", subtype: "success", is_error: false, session_id: session, result: "Nothing to emit.", num_turns: 1, total_cost_usd: 0.01, usage },
]) {
  process.stdout.write(JSON.stringify(event) + "\\n");
}
`;

const stub = path.join(tmp, "claude-startup-git-stub.js");
fs.writeFileSync(stub, STUB, { mode: 0o755 });

process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");
process.env.WORKSPACE_ROOT = path.join(tmp, "workspace");
delete process.env.WORKSPACE_ROOTS;
process.env.CLAUDE_BIN = stub;

const config = require("./config") as typeof import("./config");
assert.equal(
  config.DATA_DIR,
  process.env.DATA_DIR,
  "config was already loaded by another test file in this process — refusing to " +
    "run against the real database",
);

const { chatEnv, runOrchestratorChild } = require("./chat") as typeof import("./chat");
type TurnResult = import("./chat").TurnResult;

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
}

/**
 * A repository whose clean filter writes `marker`, left in the state that runs
 * it on a bare `git status`: `f.txt` changed at the same size, with an mtime
 * the index does not have.
 */
function plantCleanFilter(): void {
  fs.mkdirSync(project, { recursive: true });
  git(project, "init", "-q", ".");
  git(project, "config", "user.email", "probe@example.invalid");
  git(project, "config", "user.name", "probe");
  fs.writeFileSync(path.join(project, "f.txt"), "aaaa\n");
  git(project, "add", "f.txt");
  git(project, "commit", "-qm", "init");
  fs.writeFileSync(path.join(project, ".git", "info", "attributes"), "* filter=x\n");
  git(project, "config", "filter.x.clean", `sh -c ': > "${marker}"; cat'`);
  fs.writeFileSync(path.join(project, "f.txt"), "bbbb\n");
  const past = new Date("2001-01-01T00:00:00Z");
  fs.utimesSync(path.join(project, "f.txt"), past, past);
}

describe("a workflow block's turn and the CLI's startup git", () => {
  plantCleanFilter();

  // Without this the case below would pass against a plant that never fires.
  it("runs the planted filter when that git status stands in the folder", () => {
    spawnSync("git", ["status", "--short", "--ignore-submodules=dirty"], {
      cwd: project,
      env: chatEnv(),
      stdio: "ignore",
    });
    assert.ok(fs.existsSync(marker), "the planted clean filter did not run in the repository");
    fs.rmSync(marker);
  });

  it("is spawned outside the folder, hands it over with --add-dir and names it", async () => {
    await new Promise<TurnResult>((resolve) =>
      runOrchestratorChild({
        subject: { kind: "block", instanceId: "instance", nodeId: "node" },
        prompt: "Decide what to run in this repository.",
        appendSystemPrompt: "You are an orchestrator block.",
        folder: project,
        maxBudgetUSD: null,
        idleTimeoutMs: 30_000,
        timedOutMessage: "The stub went silent.",
        onSettle: resolve,
      }),
    );
    assert.ok(fs.existsSync(receivedFile), "the stub was never spawned");

    assert.ok(!fs.existsSync(marker), "the block's child ran the repository's clean filter");

    const received = JSON.parse(fs.readFileSync(receivedFile, "utf8")) as {
      cwd: string;
      argv: string[];
    };
    const inside = path.relative(project, received.cwd);
    assert.ok(
      inside.startsWith("..") || path.isAbsolute(inside),
      `the child stood in ${received.cwd}, inside the folder`,
    );
    const addDirs = received.argv.flatMap((arg, i) =>
      arg === "--add-dir" ? [received.argv[i + 1]] : [],
    );
    assert.ok(addDirs.includes(project), `--add-dir ${addDirs.join(", ")}`);
    const appended = received.argv[received.argv.indexOf("--append-system-prompt") + 1] ?? "";
    assert.ok(appended.startsWith("You are an orchestrator block."), appended);
    assert.ok(appended.includes(`That folder is ${project}`), appended);
  });
});
