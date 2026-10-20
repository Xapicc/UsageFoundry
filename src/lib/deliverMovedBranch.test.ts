import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * That a delivery pushes the commit its checks were asked of, and not whatever
 * the branch holds when the push starts.
 *
 * `pushAndOpen` proves the verify command against the branch's tip, awaits
 * `originPushUrls` again and `seededOnBranch`'s git children, and only then
 * spawns `git push origin <head>:<head>`, which resolves the branch by name
 * when it starts. A commit that reached the branch in between (the card's
 * Commit button, which takes a claim `pushAndOpen` never reads, or a second
 * tab) was published without the command having run on it, and one that came
 * after `seededOnBranch` had resolved the ref got past `seededRefusal`: a
 * forced `.env` reached the remote. It is `landMovedBranch.test.ts`' fault with
 * a push in place of the merge, and the same fix: the SHA is read once, asked
 * of every check, and pushed as `<sha>:refs/heads/<head>`.
 *
 * Driven for real, a database, a repository, the run's own checkout and a bare
 * remote served for a genuine GitHub URL by `deliverRun.test.ts`' stand-in
 * transport, behind a `GIT_BIN` stub that holds one git step in the operator's
 * checkout until the case has pressed `commitPending`. The stub changes when
 * things happen and nothing about what git does. Its own file because
 * `GIT_BIN` is read when `config.ts` loads.
 */

let land: typeof import("./land");
let dbMod: typeof import("./db");
let settings: typeof import("./settings");
let orchestrator: typeof import("./orchestrator");
let root: string;
let remotes: string;
let holds: string;

const MOUNT_DIR = "moved-mount";
const githubRemote = (name: string) => `https://github.com/acme/${name}.git`;
const PULLS_ENDPOINT = /^https:\/\/api\.github\.com\/repos\/acme\/([^/]+)\/pulls$/;

for (const key of Object.keys(process.env)) {
  if (/^(GIT_|GH_|GITHUB_)/.test(key)) delete process.env[key];
}

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

let opened: Array<{ head: string; base: string }> = [];
let realFetch: typeof fetch;

const stubFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const repo = PULLS_ENDPOINT.exec(url)?.[1];
  if (!repo) throw new Error(`the test's fetch stub refuses ${url}`);
  const body = JSON.parse(String(init?.body)) as { head: string; base: string };
  opened.push({ head: body.head, base: body.base });
  const number = 40 + opened.length;
  return new Response(
    JSON.stringify({ number, html_url: `https://github.com/acme/${repo}/pull/${number}` }),
    { status: 201, headers: { "content-type": "application/json" } },
  );
}) as typeof fetch;

/** `deliverRun.test.ts`' stand-in: a `git-remote-https` that serves `<remotes>/<name>.git`. */
function standInTransport(): string {
  const real = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
  const dir = path.join(root, "git-exec");
  fs.mkdirSync(dir);
  for (const entry of fs.readdirSync(real)) {
    if (entry !== "git-remote-https") fs.symlinkSync(path.join(real, entry), path.join(dir, entry));
  }
  fs.writeFileSync(
    path.join(dir, "git-remote-https"),
    [
      "#!/bin/sh",
      'repo=$(basename "$2" .git)',
      "while read -r line; do",
      '  case "$line" in',
      "    capabilities) printf 'connect\\n\\n' ;;",
      `    "connect "*) printf '\\n'; exec \${line#connect } "${remotes}/$repo.git" ;;`,
      "    *) exit 1 ;;",
      "  esac",
      "done",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return dir;
}

before(async () => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "uf-deliver-moved-")),
  );
  remotes = path.join(root, "remotes");
  fs.mkdirSync(remotes);
  process.env.GIT_EXEC_PATH = standInTransport();
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  });
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, MOUNT_DIR);
  process.env.WORKSPACE_ROOTS = "";
  process.env.UF_GITHUB_TOKEN = "test-token-not-a-real-credential";
  process.env.UF_GITHUB_TOKENS = "";
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");
  fs.mkdirSync(path.join(root, MOUNT_DIR), { recursive: true });

  holds = path.join(root, "holds");
  fs.mkdirSync(holds);
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const gitStub = path.join(root, "git");
  fs.writeFileSync(
    gitStub,
    [
      "#!/bin/sh",
      // Hold the first git step whose argv names the word in `word`, run in the
      // operator's checkout, once `armed` exists. `armed` is written by the
      // verify command, so everything before the check runs untouched.
      `if [ -e '${holds}/armed' ] && [ ! -e '${holds}/started' ] && [ "$(pwd -P)" = "$(cat '${holds}/dir' 2>/dev/null)" ]; then`,
      '  for arg in "$@"; do',
      `    if [ "$arg" = "$(cat '${holds}/word')" ]; then`,
      `      : > '${holds}/started'; i=0`,
      `      while [ ! -e '${holds}/release' ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i + 1)); done`,
      "      break",
      "    fi",
      "  done",
      "fi",
      `exec '${realGit}' "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  process.env.GIT_BIN = gitStub;

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );
  dbMod = await import("./db");
  land = await import("./land");
  settings = await import("./settings");
  orchestrator = await import("./orchestrator");

  realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch;
});

after(() => {
  globalThis.fetch = realFetch;
  (globalThis as { __ufDb?: { close(): void } }).__ufDb?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  dbMod.db().prepare("DELETE FROM runs").run();
  settings.saveSettings({ landVerifyCommand: "", maxConcurrentRuns: 0 });
  opened = [];
  for (const entry of fs.readdirSync(holds)) fs.rmSync(path.join(holds, entry));
});

interface Scene {
  runId: string;
  repo: string;
  slot: string;
  branch: string;
  remote: string;
}

/**
 * An isolated run with one commit on its branch, in the slot `allocateSlotPath`
 * would look for, the operator's checkout on `main` and clean, and `origin` a
 * GitHub URL the stand-in serves. No `.gitignore`, so the card's Commit button
 * stages a `.env` in the slot, as it does in a repository that does not ignore
 * one.
 */
function scene(name: string): Scene {
  const repo = path.join(root, MOUNT_DIR, name);
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "shared.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "main").trim();

  const remote = path.join(remotes, `${name}.git`);
  git(root, "init", "-q", "--bare", remote);
  git(repo, "remote", "add", "origin", githubRemote(name));
  git(repo, "push", "-q", "origin", "main:refs/heads/main");

  const branch = `uf/${name}`;
  const slot = path.join(orchestrator.worktreeStore(repo)!, `${orchestrator.repoSlug(repo)}-1`);
  git(repo, "worktree", "add", "-q", "-b", branch, slot);
  fs.writeFileSync(path.join(slot, "shared.txt"), "branch\n");
  git(slot, "commit", "-qam", "the run's work");

  const runId = `run-${name}`;
  dbMod
    .db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                         created_at, finished_at, isolation, repo_root, work_dir,
                         worktree_path, worktree_branch, worktree_base, worktree_base_branch)
       VALUES (?, ?, 'do the thing', 'completed', '{}', 1, 1, ?, ?, 'worktree', ?, ?, ?, ?, ?, 'main')`,
    )
    .run(runId, repo, Date.now(), Date.now(), repo, slot, slot, branch, base);
  return { runId, repo, slot, branch, remote };
}

function remoteTip(s: Scene): string | null {
  const refs = git(s.remote, "for-each-ref", "--format=%(refname) %(objectname)").trim();
  const line = refs.split("\n").find((l) => l.startsWith(`refs/heads/${s.branch} `));
  return line ? line.split(" ")[1] : null;
}

/** Hold the first `word` git step in the operator's checkout, once armed. */
function holdOn(s: Scene, word: "remote" | "push"): void {
  fs.writeFileSync(path.join(holds, "dir"), s.repo);
  fs.writeFileSync(path.join(holds, "word"), word);
}

/** A verify command that arms the hold when it has passed, as the check's end does. */
function armingCommand(): string {
  const script = path.join(root, "arm.js");
  fs.writeFileSync(
    script,
    `require("fs").writeFileSync(${JSON.stringify(path.join(holds, "armed"))}, "");\n`,
  );
  return `${process.execPath} ${script}`;
}

async function waitForHold(): Promise<void> {
  for (let i = 0; i < 1500 && !fs.existsSync(path.join(holds, "started")); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(
    fs.existsSync(path.join(holds, "started")),
    "the held git step was never reached, so the window was not exercised",
  );
}

/** The card's Commit button, pressed while the delivery is held. */
async function commitDuringDelivery(s: Scene, files: Record<string, string>): Promise<string> {
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(s.slot, file), content);
  }
  const committed = await land.commitPending(s.runId);
  assert.equal(committed.ok, true, committed.ok ? "" : committed.reason);
  const lateTip = git(s.repo, "rev-parse", s.branch).trim();
  fs.writeFileSync(path.join(holds, "release"), "");
  return lateTip;
}

const addedEnv = (s: Scene, tip: string) =>
  git(s.remote, "log", "--format=%h", tip, "--", ".env").trim();

describe("a Commit pressed on the card while Deliver is between its check and its push", () => {
  it("delivers the checked commit when nothing moves (the control)", async () => {
    const s = scene("control");
    const checkedTip = git(s.repo, "rev-parse", s.branch).trim();
    settings.saveSettings({ landVerifyCommand: armingCommand() });

    const delivered = await land.deliverRun(s.runId);

    assert.equal(delivered.ok, true, delivered.ok ? "" : delivered.reason);
    assert.equal(remoteTip(s), checkedTip);
    assert.deepEqual(opened, [{ head: s.branch, base: "main" }]);
    // `push --set-upstream` set it for a branch name and sets nothing for a SHA.
    assert.equal(git(s.repo, "config", "--get", `branch.${s.branch}.remote`).trim(), "origin");
    assert.equal(git(s.repo, "config", "--get", `branch.${s.branch}.merge`).trim(), `refs/heads/${s.branch}`);
  });

  it("does not publish a commit made after the verify command, before the second push-URL read", async () => {
    const s = scene("after-verify");
    const checkedTip = git(s.repo, "rev-parse", s.branch).trim();
    settings.saveSettings({ landVerifyCommand: armingCommand() });
    holdOn(s, "remote");

    const pressed = land.deliverRun(s.runId);
    await waitForHold();
    const lateTip = await commitDuringDelivery(s, { "unverified.txt": "never checked\n" });
    assert.notEqual(lateTip, checkedTip, "the commit did not move the branch");
    const delivered = await pressed;

    assert.equal(delivered.ok, true, delivered.ok ? "" : delivered.reason);
    assert.equal(remoteTip(s), checkedTip, "the remote took more than the verify command ran on");
    // Not lost: still on the branch, for the next press to send.
    assert.equal(git(s.repo, "rev-parse", s.branch).trim(), lateTip);
  });

  it("does not publish a forced .env that reaches the branch after the seeded read, as the push is spawned", async () => {
    const s = scene("late-env");
    const checkedTip = git(s.repo, "rev-parse", s.branch).trim();
    settings.saveSettings({ landVerifyCommand: armingCommand() });
    holdOn(s, "push");

    const pressed = land.deliverRun(s.runId);
    await waitForHold();
    const lateTip = await commitDuringDelivery(s, {
      ".env": "API_KEY=the-operators-own-key\n",
      "f3.txt": "late change\n",
    });
    assert.match(git(s.repo, "show", "--name-only", "--format=", lateTip), /^\.env$/m);
    const delivered = await pressed;

    assert.equal(delivered.ok, true, delivered.ok ? "" : delivered.reason);
    const pushed = remoteTip(s);
    assert.equal(pushed, checkedTip, "the remote took more than was checked");
    assert.equal(addedEnv(s, pushed!), "", "the operator's .env reached the remote");
    assert.equal(git(s.repo, "rev-parse", s.branch).trim(), lateTip);
  });

  it("pushes the commit it read, with no verify command to have read it", async () => {
    const s = scene("no-command");
    const readTip = git(s.repo, "rev-parse", s.branch).trim();
    holdOn(s, "push");
    fs.writeFileSync(path.join(holds, "armed"), "");

    const pressed = land.deliverRun(s.runId);
    await waitForHold();
    const lateTip = await commitDuringDelivery(s, {
      ".env": "API_KEY=the-operators-own-key\n",
      "f3.txt": "late change\n",
    });
    assert.notEqual(lateTip, readTip, "the commit did not move the branch");
    const delivered = await pressed;

    assert.equal(delivered.ok, true, delivered.ok ? "" : delivered.reason);
    assert.equal(remoteTip(s), readTip, "the remote took more than the delivery read");
    assert.equal(addedEnv(s, remoteTip(s)!), "");
  });
});
