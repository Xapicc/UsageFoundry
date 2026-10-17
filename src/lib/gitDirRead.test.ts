import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { HOOKS_PATH_PREFIX } from "./apiTypes";
import { compareGitDir, type GitDirBaseline, type GitDirReport } from "./gitDirWatch";

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

function writeHook(hooksDir: string, name: string, body: string) {
  const file = path.join(hooksDir, name);
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
    writeHook(path.join(gitDir, "hooks"), "post-checkout", `touch ${marker("post-checkout")}`);
    writeHook(
      path.join(gitDir, "hooks"),
      "reference-transaction",
      `touch ${marker("reference-transaction")}`,
    );
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
    writeHook(path.join(gitDir, "hooks"), "pre-commit", `touch ${marker("pre-commit")}`);
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

describe("a submodule's git directory, which the superproject's git status runs from", () => {
  it("compares what a run plants there, keyed by the module, and runs none of it", async () => {
    const lib = path.join(root, "lib-source");
    fs.mkdirSync(lib);
    setupGit(lib, ["init", "-q", "-b", "main"]);
    setupGit(lib, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "l"]);
    const { repo, worktree } = makeRepository(workspace, "super");
    const baseline = await read.readGitDirBaseline(worktree, 1_000);
    assert.ok(baseline?.ok, JSON.stringify(baseline));
    setupGit(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "lib"]);
    // A name with a slash in it, which git keeps as nested directories.
    setupGit(repo, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      "--name",
      "vendor/two",
      lib,
      "two",
    ]);
    setupGit(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "s"]);
    // Adding a submodule is not itself a warning: git sets no watched key or hook.
    const added = compareGitDir(baseline, await read.readGitDirAgain(baseline), [], 2_000);
    assert.deepEqual(added.state === "unchanged" && added.notRead, undefined, JSON.stringify(added));

    // Inside the run's own common git directory, so the run can write it.
    const moduleDir = path.join(repo, ".git", "modules", "lib");
    setupGit(repo, [
      "config",
      "-f",
      path.join(moduleDir, "config"),
      "core.fsmonitor",
      `touch ${marker("submodule-fsmonitor")} #`,
    ]);
    const slashed = path.join(repo, ".git", "modules", "vendor", "two");
    writeHook(path.join(slashed, "hooks"), "pre-commit", `touch ${marker("submodule-hook")}`);
    const report = compareGitDir(baseline, await read.readGitDirAgain(baseline), [], 3_000);
    assert.equal(report.state, "changed", JSON.stringify(report));
    assert.deepEqual(
      report.state === "changed" &&
        report.findings.map((f) => [f.module, f.kind === "config" ? f.key : f.kind, f.change]),
      [
        ["modules/lib", "core.fsmonitor", "added"],
        ["modules/vendor/two", "hook", "added"],
      ],
    );
    assert.equal(report.state === "changed" && report.notRead, undefined);
    assert.ok(!markersWritten().includes("ran-submodule-fsmonitor"), "reading ran the fsmonitor");

    // The control: the superproject's own status recurses into the submodule
    // and runs what was planted in its git directory.
    plainGit(repo, ["status", "--short"]);
    assert.ok(markersWritten().includes("ran-submodule-fsmonitor"), markersWritten().join(", "));
  });
});

describe("a hooks directory holding more than this app reads", () => {
  const pad = (hooks: string) => {
    // Names that sort before every hook git runs.
    for (let i = 0; i < 300; i++) {
      fs.writeFileSync(path.join(hooks, `a${String(i).padStart(3, "0")}`), "x");
    }
  };
  const preCommitOf = (report: GitDirReport) =>
    report.state === "changed"
      ? report.findings.find((f) => f.kind === "hook" && f.name === "pre-commit")
      : undefined;

  it("still compares git's own hooks, and says the rest were not", async () => {
    for (const padFirst of [false, true]) {
      const { repo, worktree } = makeRepository(workspace, `padded-${padFirst}`);
      const hooks = path.join(repo, ".git", "hooks");
      writeHook(hooks, "pre-commit", "true");
      if (padFirst) pad(hooks);
      const baseline = await read.readGitDirBaseline(worktree, 1_000);
      assert.ok(baseline?.ok, JSON.stringify(baseline));
      if (!padFirst) pad(hooks);
      writeHook(hooks, "pre-commit", "exit 3");
      const report = compareGitDir(baseline, await read.readGitDirAgain(baseline), [], 2_000);
      const label = `padded ${padFirst ? "before" : "after"} the start`;
      assert.deepEqual(
        preCommitOf(report),
        { kind: "hook", name: "pre-commit", change: "changed", executable: true },
        `${label}: ${JSON.stringify(report).slice(0, 300)}`,
      );
      assert.match(
        (report.state === "changed" ? (report.notRead ?? []) : []).join("\n"),
        padFirst
          ? /At the run's start and end: hooks holds 300 entries that are not git's own hook names/
          : /At the run's end: hooks holds 300 entries that are not git's own hook names/,
        label,
      );
      // The control: the hook compared is the one git runs.
      assert.throws(
        () => plainGit(repo, ["hook", "run", "pre-commit"]),
        (err: { status?: number }) => err.status === 3,
        label,
      );
    }
  });
});

describe("a symlinked hooks/, info/ or hook, which git follows", () => {
  /** `git hook run`'s exit status, which is the hook's. */
  function hookRunStatus(repo: string, hook: string): number {
    try {
      plainGit(repo, ["hook", "run", hook]);
      return 0;
    } catch (err) {
      return (err as { status: number }).status;
    }
  }

  it("reads one inside a configured folder through, so a rewrite of its target is a change", async () => {
    // C: the whole hooks directory, as `ln -s ../.githooks .git/hooks` leaves it.
    const linkedDir = makeRepository(workspace, "linked-hooks");
    const shared = path.join(linkedDir.repo, ".githooks");
    fs.mkdirSync(shared);
    writeHook(shared, "pre-commit", "true");
    const hooks = path.join(linkedDir.repo, ".git", "hooks");
    fs.rmSync(hooks, { recursive: true, force: true });
    fs.symlinkSync("../.githooks", hooks);
    // D: info/, and with it info/attributes.
    const linkedInfo = makeRepository(workspace, "linked-info");
    const gitinfo = path.join(linkedInfo.repo, ".gitinfo");
    fs.mkdirSync(gitinfo);
    fs.writeFileSync(path.join(gitinfo, "attributes"), "*.md text\n");
    fs.rmSync(path.join(linkedInfo.repo, ".git", "info"), { recursive: true, force: true });
    fs.symlinkSync("../.gitinfo", path.join(linkedInfo.repo, ".git", "info"));
    // E: one hook.
    const linkedHook = makeRepository(workspace, "linked-hook");
    const scripts = path.join(linkedHook.repo, "scripts");
    fs.mkdirSync(scripts);
    writeHook(scripts, "pre-commit", "true");
    fs.symlinkSync(
      "../../scripts/pre-commit",
      path.join(linkedHook.repo, ".git", "hooks", "pre-commit"),
    );

    const baselines = await Promise.all(
      [linkedDir, linkedInfo, linkedHook].map(async ({ worktree }) => {
        const baseline = await read.readGitDirBaseline(worktree, 1_000);
        assert.ok(baseline?.ok, JSON.stringify(baseline));
        return baseline;
      }),
    );
    writeHook(shared, "pre-commit", "exit 3");
    writeHook(shared, "post-checkout", "exit 4");
    fs.writeFileSync(path.join(gitinfo, "attributes"), "* filter=lfs diff=lfs\n");
    writeHook(scripts, "pre-commit", "exit 3");
    const [dirReport, infoReport, hookReport] = await Promise.all(
      baselines.map(async (baseline) =>
        compareGitDir(baseline, await read.readGitDirAgain(baseline), [], 2_000),
      ),
    );
    const findingsOf = (report: GitDirReport) => {
      assert.equal(report.state, "changed", JSON.stringify(report));
      return report.state === "changed" ? report.findings : [];
    };
    assert.deepEqual(findingsOf(dirReport), [
      { kind: "hook", name: "post-checkout", change: "added", executable: true },
      { kind: "hook", name: "pre-commit", change: "changed", executable: true },
    ]);
    assert.deepEqual(findingsOf(infoReport), [
      { kind: "attributes", change: "changed", driverLines: ["* filter=lfs diff=lfs"] },
    ]);
    assert.deepEqual(findingsOf(hookReport), [
      { kind: "hook", name: "pre-commit", change: "changed", executable: true },
    ]);

    // The controls: git runs, and reads, the rewritten targets.
    assert.equal(hookRunStatus(linkedDir.repo, "pre-commit"), 3);
    assert.equal(plainGit(linkedInfo.repo, ["check-attr", "filter", "--", "a.txt"]), "a.txt: filter: lfs\n");
    assert.equal(hookRunStatus(linkedHook.repo, "pre-commit"), 3);
  });

  it("says which it did not read when the target is outside every configured folder", async () => {
    const elsewhere = path.join(root, "elsewhere-linked");
    fs.mkdirSync(elsewhere);
    writeHook(elsewhere, "pre-commit", "true");
    fs.writeFileSync(path.join(elsewhere, "attributes"), "* filter=x\n");
    const cases: Array<[string, (gitDir: string) => void, RegExp]> = [
      [
        "hooks",
        (gitDir) => {
          fs.rmSync(path.join(gitDir, "hooks"), { recursive: true, force: true });
          fs.symlinkSync(elsewhere, path.join(gitDir, "hooks"));
        },
        /^At the run's start and end: hooks is a symlink to .*elsewhere-linked, which is outside every configured folder, so /,
      ],
      [
        "info",
        (gitDir) => {
          fs.rmSync(path.join(gitDir, "info"), { recursive: true, force: true });
          fs.symlinkSync(elsewhere, path.join(gitDir, "info"));
        },
        /^At the run's start and end: info is a symlink to .*elsewhere-linked, which is outside every configured folder, so /,
      ],
      [
        "hook",
        // A host path the container does not have, whose absence is not the host's.
        (gitDir) => fs.symlinkSync("/Users/someone/pre-commit", path.join(gitDir, "hooks", "pre-commit")),
        /^At the run's start and end: hooks\/pre-commit is a symlink to \/Users\/someone\/pre-commit, which is outside every configured folder and does not exist in the container, so /,
      ],
    ];
    for (const [name, link, reason] of cases) {
      const { repo, worktree } = makeRepository(workspace, `linked-out-${name}`);
      link(path.join(repo, ".git"));
      const baseline = await read.readGitDirBaseline(worktree, 1_000);
      assert.ok(baseline?.ok, JSON.stringify(baseline));
      writeHook(elsewhere, "pre-commit", `exit ${name.length}`);
      const report = compareGitDir(baseline, await read.readGitDirAgain(baseline), [], 2_000);
      const notRead = report.state === "unchanged" ? (report.notRead ?? []) : [];
      assert.equal(notRead.length, 1, `${name}: ${JSON.stringify(report)}`);
      assert.match(notRead[0], reason);
    }
  });
});

describe("a core.hooksPath the repository already had", () => {
  it("compares the directory it names, which is where git runs hooks from", async () => {
    const { repo, worktree } = makeRepository(workspace, "husky");
    // husky v9's layout. The directory is gitignored, so nothing written there
    // is in a branch or its diff.
    const hooksDir = path.join(repo, ".husky", "_");
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, ".gitignore"), "*\n");
    fs.writeFileSync(path.join(hooksDir, "h"), "#!/bin/sh\n");
    writeHook(hooksDir, "pre-commit", '. "$(dirname "$0")/h"');
    setupGit(repo, ["config", "core.hooksPath", ".husky/_"]);

    const baseline = await read.readGitDirBaseline(worktree, 1_000);
    assert.ok(baseline?.ok, JSON.stringify(baseline));
    const before = compareGitDir(baseline, await read.readGitDirAgain(baseline), [], 2_000);
    assert.equal(before.state, "unchanged", JSON.stringify(before));

    // What a work cycle can do to the operator's main checkout.
    writeHook(hooksDir, "pre-commit", `touch ${marker("husky-pre-commit")}`);
    const report = compareGitDir(baseline, await read.readGitDirAgain(baseline), [], 3_000);
    assert.equal(report.state, "changed", JSON.stringify(report));
    assert.deepEqual(report.state === "changed" && report.findings, [
      {
        kind: "hook",
        name: `${HOOKS_PATH_PREFIX}${fs.realpathSync(hooksDir)}/pre-commit`,
        change: "changed",
        executable: true,
      },
    ]);
    assert.ok(!markersWritten().includes("ran-husky-pre-commit"), "reading ran the hook");

    // The control: from a subdirectory of the main checkout, git runs exactly
    // the file compared, so the path was resolved where git resolves it.
    plainGit(path.join(repo, ".husky"), [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "two",
    ]);
    assert.ok(markersWritten().includes("ran-husky-pre-commit"), markersWritten().join(", "));
  });

  it("reads one that does not exist yet as empty, so a hook created there is added", async () => {
    const { repo, worktree } = makeRepository(workspace, "husky-later");
    setupGit(repo, ["config", "core.hooksPath", ".husky/_"]);
    const baseline = await read.readGitDirBaseline(worktree, 1_000);
    assert.ok(baseline?.ok && baseline.snapshot.hooksPathUnread === null, JSON.stringify(baseline));

    const hooksDir = path.join(repo, ".husky", "_");
    fs.mkdirSync(hooksDir, { recursive: true });
    writeHook(hooksDir, "pre-commit", "true");
    const report = compareGitDir(baseline, await read.readGitDirAgain(baseline), [], 2_000);
    assert.deepEqual(
      report.state === "changed" && report.findings.map((f) => f.kind === "hook" && f.name),
      [`${HOOKS_PATH_PREFIX}${fs.realpathSync(hooksDir)}/pre-commit`],
    );
  });

  it("says which it did not read, never that nothing changed", async () => {
    const elsewhere = path.join(root, "elsewhere-hooks");
    fs.mkdirSync(elsewhere);
    writeHook(elsewhere, "pre-commit", "true");
    const cases: Array<[string, RegExp]> = [
      // Outside every configured folder: this server would be reading as root.
      [elsewhere, /outside every configured folder/],
      // A host path the container does not have, whose absence is not the host's.
      ["/Users/someone/hooks", /outside every configured folder and does not exist in the/],
      // The operator's home on the host, which the container cannot know.
      ["~/.githooks", /~\/\.githooks, which git expands against your host's home/],
    ];
    for (const [i, [configured, reason]] of cases.entries()) {
      const { repo, worktree } = makeRepository(workspace, `unread-${i}`);
      setupGit(repo, ["config", "core.hooksPath", configured]);
      const baseline = await read.readGitDirBaseline(worktree, 1_000);
      assert.ok(baseline?.ok, JSON.stringify(baseline));
      assert.deepEqual(
        baseline.snapshot.hooks.filter((hook) => hook.name.startsWith(HOOKS_PATH_PREFIX)),
        [],
        configured,
      );
      const report = compareGitDir(baseline, await read.readGitDirAgain(baseline), [], 2_000);
      assert.equal(report.state, "unchanged", configured);
      const notRead = report.state === "unchanged" ? (report.notRead ?? []) : [];
      assert.equal(notRead.length, 1, `${configured}: ${JSON.stringify(report)}`);
      assert.match(notRead[0], /^At the run's start and end: core\.hooksPath is /);
      assert.match(notRead[0], reason);
    }
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
