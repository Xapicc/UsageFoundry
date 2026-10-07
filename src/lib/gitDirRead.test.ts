import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { compareGitDir, type GitDirBaseline } from "./gitDirWatch";

/**
 * Covers reading a run's repository git directory, against a real repository
 * that has every plant the check exists to find.
 *
 * The one property that fails silently and expensively here is that reading
 * runs nothing: the reader is this server's own git child, and a read that
 * fired the `core.fsmonitor` or the clean filter it was looking for would be
 * the attack carried out by the thing meant to report it, with no line
 * anywhere. Every marker the plants would write is asserted absent after both
 * readings, and the control at the end is a plain `git status` writing them,
 * without which a fixture whose plants could not fire would prove nothing.
 *
 * The other two are where the reader looks: a git directory outside every
 * configured folder is refused rather than read as root, and the end refuses a
 * directory whose real path has moved since the start.
 */

let root: string;
let workspace: string;
let read: typeof import("./gitDirRead");

/** git with none of the environment's own configuration, so only the fixture's runs. */
function plainGit(cwd: string, args: string[]): string {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    PATH: process.env.PATH,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" });
}

/** The same, with this fixture's plants switched off while it is being built. */
function setupGit(cwd: string, args: string[]): string {
  return plainGit(cwd, ["-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null", ...args]);
}

function marker(name: string): string {
  return path.join(root, `ran-${name}`);
}

function markersWritten(): string[] {
  return fs.readdirSync(root).filter((name) => name.startsWith("ran-"));
}

function writeHook(gitDir: string, name: string, body: string) {
  const file = path.join(gitDir, "hooks", name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

/** A repository with a linked worktree, as an isolated run has. */
function makeRepository(parent: string, name: string): { repo: string; worktree: string } {
  const repo = path.join(parent, name);
  fs.mkdirSync(repo, { recursive: true });
  setupGit(repo, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  setupGit(repo, ["add", "a.txt"]);
  setupGit(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "one"]);
  const worktree = path.join(parent, ".uf-worktrees", `${name}-1`);
  setupGit(repo, ["worktree", "add", "-q", "-b", "uf/run", worktree]);
  return { repo, worktree };
}

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-git-dir-read-")));
  workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  process.env.DATA_DIR = path.join(root, "data");
  process.env.WORKSPACE_ROOT = workspace;
  // Wins over WORKSPACE_ROOT, and the container an agent edits this in has it
  // set to real mounts.
  process.env.WORKSPACE_ROOTS = `Scratch=${workspace}`;
  read = await import("./gitDirRead");
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("reading a planted repository", () => {
  it("runs nothing it planted, and finds every plant at the start and the end", async () => {
    const { repo, worktree } = makeRepository(workspace, "planted");
    const gitDir = path.join(repo, ".git");
    setupGit(repo, ["config", "core.fsmonitor", `touch ${marker("fsmonitor")} #`]);
    setupGit(repo, ["config", "filter.x.clean", `sh -c 'touch ${marker("clean")}; cat'`]);
    setupGit(repo, ["config", "diff.x.textconv", `sh -c 'touch ${marker("textconv")}; cat'`]);
    setupGit(repo, ["config", "include.path", "evil.inc"]);
    fs.writeFileSync(
      path.join(gitDir, "evil.inc"),
      `[diff]\n\texternal = touch ${marker("external")}\n`,
    );
    fs.mkdirSync(path.join(gitDir, "info"), { recursive: true });
    fs.writeFileSync(path.join(gitDir, "info", "attributes"), "* filter=x diff=x\n");
    writeHook(gitDir, "post-checkout", `touch ${marker("post-checkout")}`);
    writeHook(gitDir, "reference-transaction", `touch ${marker("reference-transaction")}`);
    // Neither may stall or be followed: a FIFO would hold a read for ever, and
    // a symlink would have this server read wherever it points.
    execFileSync("mkfifo", [path.join(gitDir, "hooks", "pre-push")]);
    // git runs a hook through its symlink, so the target's mode is what counts.
    fs.symlinkSync(
      path.join(gitDir, "hooks", "post-checkout"),
      path.join(gitDir, "hooks", "pre-rebase"),
    );
    // Stat-dirty, so a `status` that refreshed the index would run the filter.
    fs.writeFileSync(path.join(repo, "a.txt"), "two\n");

    const baseline = await read.readGitDirBaseline(worktree, 1_000);
    assert.ok(baseline?.ok, JSON.stringify(baseline));
    assert.equal(baseline.commonDir, fs.realpathSync(gitDir));
    const keys = baseline.snapshot.config.map(
      (entry) => `${entry.key}@${path.basename(entry.origin)}`,
    );
    for (const expected of [
      "core.fsmonitor@config",
      "filter.x.clean@config",
      "diff.x.textconv@config",
      "include.path@config",
      "diff.external@evil.inc",
    ]) {
      assert.ok(keys.includes(expected), `${expected} in ${keys.join(", ")}`);
    }
    assert.deepEqual(
      baseline.snapshot.hooks.map((hook) => [
        hook.name,
        hook.identity.split(":")[0],
        hook.executable,
      ]),
      [
        ["post-checkout", "file", true],
        ["pre-push", "other", false],
        ["pre-rebase", "symlink", true],
        ["reference-transaction", "file", true],
      ],
    );
    assert.deepEqual(baseline.snapshot.attributes?.driverLines, ["* filter=x diff=x"]);

    // What a work cycle adds after the start.
    writeHook(gitDir, "pre-commit", `touch ${marker("pre-commit")}`);
    setupGit(repo, ["config", "core.pager", `touch ${marker("pager")}`]);
    const end = await read.readGitDirAgain(baseline);
    const report = compareGitDir(baseline, end, [], 2_000);
    assert.equal(report.state, "changed", JSON.stringify(report));
    assert.deepEqual(
      report.state === "changed" &&
        report.findings.map((f) => (f.kind === "config" ? f.key : `${f.kind}:${f.change}`)),
      ["core.pager", "hook:added"],
    );

    assert.deepEqual(markersWritten(), [], "reading ran a planted command");

    // The control: the plants do fire under a git that does not clear them.
    plainGit(repo, ["status", "--short"]);
    assert.ok(markersWritten().includes("ran-fsmonitor"), markersWritten().join(", "));
    assert.ok(markersWritten().includes("ran-clean"), markersWritten().join(", "));
  });
});

describe("where the reader looks", () => {
  it("has nothing to read in a folder outside any repository", async () => {
    const folder = path.join(workspace, "plain");
    fs.mkdirSync(folder);
    assert.equal(await read.readGitDirBaseline(folder, 1_000), null);
  });

  it("refuses a git directory outside every configured folder", async () => {
    const outside = makeRepository(path.join(root, "elsewhere"), "outside");
    const checkout = path.join(workspace, "pointed");
    fs.mkdirSync(checkout);
    // A checkout in the mount whose `.git` names a directory outside it, as a
    // work cycle in an in-place run could leave one.
    fs.writeFileSync(path.join(checkout, ".git"), `gitdir: ${path.join(outside.repo, ".git")}\n`);
    for (const cwd of [outside.worktree, checkout]) {
      const baseline = await read.readGitDirBaseline(cwd, 1_000);
      assert.equal(baseline?.ok, false, JSON.stringify(baseline));
      assert.match(
        baseline?.ok === false ? baseline.reason : "",
        /outside every configured folder/,
      );
    }
  });

  it("refuses at the end a directory whose real path has moved", async () => {
    const { repo, worktree } = makeRepository(workspace, "moved");
    const baseline = (await read.readGitDirBaseline(worktree, 1_000)) as GitDirBaseline;
    assert.ok(baseline.ok);
    fs.renameSync(path.join(repo, ".git"), path.join(repo, ".git-real"));
    fs.symlinkSync(path.join(repo, ".git-real"), path.join(repo, ".git"));
    const end = await read.readGitDirAgain(baseline);
    assert.equal(end.ok, false);
    assert.match(end.ok ? "" : end.reason, /now resolves to .*\.git-real/);
  });
});
