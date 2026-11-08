import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { addWorktree, git, gitArgs, gitEnv, gitSync } from "./git";
import { agentEnvironment } from "./stacks";

/**
 * Covers what every git call this app makes carries, and only that.
 *
 * Both halves fail silently. A missing `-c` is a repository-controlled command
 * executed by this server's own git child — a `post-checkout` fired by the
 * `worktree add` of a run that did not write it, or a `post-merge` fired inside
 * the operator's live checkout — with no permission mode, no tool lists and no
 * line in `run_events` to say it happened. And a variable that survives the
 * scrub is that command handed this app's configuration: `DATA_DIR` is the
 * address of the database `serverLock.ts` exists to protect, and a run that
 * closes out every other run's rows looks exactly like a container restart.
 *
 * Nothing here can observe the agent's own git, which keeps its hooks
 * deliberately — that spawn is `buildArgs`, and it passes no config at all.
 */

describe("gitArgs", () => {
  it("disables hooks and fsmonitor before whatever it was asked to run", () => {
    // Order matters only in that config precedes the subcommand: `git checkout
    // -c x=y` is a checkout of a branch called `-c`, not a configured checkout.
    assert.deepEqual(gitArgs(["worktree", "add", "/tmp/x", "-b", "b"]), [
      "-c",
      "core.fsmonitor=",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "safe.directory=*",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "gpg.program=gpg",
      "-c",
      "gpg.x509.program=gpgsm",
      "-c",
      "gpg.ssh.program=ssh-keygen",
      "-c",
      "core.checkStat=minimal",
      "worktree",
      "add",
      "/tmp/x",
      "-b",
      "b",
    ]);
  });

  it("carries the same config for a call that takes no arguments of its own", () => {
    assert.deepEqual(gitArgs([]), [
      "-c",
      "core.fsmonitor=",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "safe.directory=*",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "gpg.program=gpg",
      "-c",
      "gpg.x509.program=gpgsm",
      "-c",
      "gpg.ssh.program=ssh-keygen",
      "-c",
      "core.checkStat=minimal",
    ]);
  });

  it("splices extra config between the fixed flags and the subcommand", () => {
    // The filter neutralisers are config and must precede the subcommand, or
    // `git add -c filter.x.clean=` is an add of a pathspec called `-c`.
    assert.deepEqual(gitArgs(["add", "-A"], ["-c", "filter.x.clean="]), [
      "-c",
      "core.fsmonitor=",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "safe.directory=*",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "gpg.program=gpg",
      "-c",
      "gpg.x509.program=gpgsm",
      "-c",
      "gpg.ssh.program=ssh-keygen",
      "-c",
      "core.checkStat=minimal",
      "-c",
      "filter.x.clean=",
      "add",
      "-A",
    ]);
  });
});

describe("gitEnv", () => {
  it("withholds the same set the agent's and the reviewer's children withhold", () => {
    // Set on this process rather than passed in, because reading `process.env`
    // is the whole of what this function does: a version that scrubbed a copy
    // nobody handed it would pass any test that supplied one.
    const planted = {
      UF_AUTH_TOKEN: "shared-secret",
      UF_GITHUB_TOKEN: "ghp_x",
      // The per-repository map is withheld by the same namespace rule, which is
      // why a second credential shape needed no second exclusion.
      UF_GITHUB_TOKENS: "acme/web=ghp_y",
      ANTHROPIC_ADMIN_KEY: "sk-admin",
      ANTHROPIC_API_KEY: "sk-x",
      // Not covered by the `ANTHROPIC_` prefix above, and the drivers a
      // repository can make this child run are the reason it matters here.
      OPENAI_API_KEY: "sk-openai",
      CODEX_API_KEY: "codex-key",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector",
      OTEL_RESOURCE_ATTRIBUTES: "a=b",
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      DATA_DIR: "/data",
    };
    for (const [k, v] of Object.entries(planted)) process.env[k] = v;
    try {
      const env = gitEnv();
      for (const k of Object.keys(planted)) {
        assert.equal(env[k], undefined, `${k} reached a git child`);
      }
    } finally {
      for (const k of Object.keys(planted)) delete process.env[k];
    }
  });

  it("passes through what git needs and disables the credential prompt", () => {
    // A git child with no stdin that is asked for a password hangs until the
    // 20s timeout, which reads as a slow repository rather than a missing
    // credential. PATH and HOME are how git finds itself and its own config.
    process.env.PATH ??= "/usr/bin";
    process.env.HOME ??= "/home/node";
    const env = gitEnv();
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(env.HOME, process.env.HOME);
  });

  it("turns off git's optional locks for this app's git and nobody else's", () => {
    // Without it every `git status` this app runs in the operator's checkout
    // takes `index.lock` to write back a refreshed index, and a land into that
    // checkout starting at the same moment is refused by git.
    assert.equal(gitEnv().GIT_OPTIONAL_LOCKS, "0");
    // `gitEnv` copies `agentEnvironment()`; set there, it would reach every
    // agent and change how the agent's own git behaves.
    assert.equal(agentEnvironment().GIT_OPTIONAL_LOCKS, undefined);
  });
});

/**
 * That a status read through `git()` leaves the index alone, against a real
 * repository: whether `status` writes is git's behaviour, and a test of the
 * environment alone would pass against a git that ignored the variable.
 */
describe("git status through git()", () => {
  it("does not rewrite the index of a checkout with a stat-dirty file", async () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-git-locks-")));
    const plainEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    };
    delete plainEnv.GIT_OPTIONAL_LOCKS;
    const plain = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8", env: plainEnv });
    try {
      plain("init", "-q", "-b", "main");
      fs.writeFileSync(path.join(repo, "f.txt"), "same\n");
      plain("add", "f.txt");
      plain("commit", "-q", "-m", "base");
      // Same content, different mtime: what a checkout, a build or an editor's
      // save leaves behind, and what `status` refreshes and writes back.
      const past = new Date("2001-01-01T00:00:00Z");
      fs.utimesSync(path.join(repo, "f.txt"), past, past);
      const index = path.join(repo, ".git", "index");
      const before = fs.readFileSync(index);

      const res = await git(repo, ["status", "--porcelain"]);

      assert.equal(res.ok, true, res.stderr);
      assert.equal(res.stdout, "");
      assert.ok(fs.readFileSync(index).equals(before), "git status rewrote the index");

      // The control: a plain `status` does write it, so the fixture was dirty
      // enough for the assertion above to have measured something.
      plain("status", "--porcelain");
      assert.equal(fs.readFileSync(index).equals(before), false, "the fixture was not stat-dirty");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does not count a file whose inode alone changed as modified", async () => {
    // What a reboot of OrbStack's VM does to every bind-mounted checkout: new
    // inode numbers, same times and sizes. Because this app's `status` never
    // writes back what it re-hashes, each of those entries was re-hashed on
    // every read, and the Branches page hashed ~7 GB of idle slots per load.
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-git-checkstat-")));
    const plainEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    };
    const plain = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8", env: plainEnv });
    const file = path.join(repo, "f.txt");
    // Long before the index is written, so the entry is not racily clean and git
    // decides by stat alone rather than by reading the content.
    const past = new Date("2001-01-01T00:00:00Z");
    try {
      plain("init", "-q", "-b", "main");
      // Replacing the file below moves its ctime, which virtiofs did not; this
      // leaves the inode as the only field that differs, as it was there.
      plain("config", "core.trustctime", "false");
      fs.writeFileSync(file, "same\n");
      fs.utimesSync(file, past, past);
      plain("add", "f.txt");
      plain("commit", "-q", "-m", "base");

      const inodeBefore = fs.statSync(file).ino;
      fs.copyFileSync(file, `${file}.tmp`);
      fs.renameSync(`${file}.tmp`, file);
      fs.utimesSync(file, past, past);
      assert.notEqual(fs.statSync(file).ino, inodeBefore, "the fixture kept its inode");

      // `diff-files` compares stat data and never reads content, so it is the
      // call that shows what `status` would have had to re-hash.
      const res = await git(repo, ["diff-files", "--name-only"]);

      assert.equal(res.ok, true, res.stderr);
      assert.equal(res.stdout, "");

      // The control: git's default comparison does see the entry as changed, so
      // the fixture measured something.
      assert.equal(plain("diff-files", "--name-only").trim(), "f.txt");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

/**
 * That a child which never started is a failed call and not a rejection.
 *
 * Every caller of `git()` in `land.ts` reads a `GitResult` and none of them has
 * a `catch`, so this is load-bearing rather than defensive — and the way it was
 * wrong is invisible from the call site, because `spawn` demotes only five
 * errnos to the `error` event this already handled. `ENOTDIR` is the one that
 * can be provoked deterministically; the one that matters in production is
 * `EMFILE`, which does not throw from `spawn` at all but *returns* having
 * skipped the stdio wiring, so `child.stdout` is undefined and `setEncoding`
 * throws instead. Both arrive at the same line, and both used to reject.
 *
 * What that cost is a merge queue row: the rejection propagated out of the
 * worker's loop and left the branch it was landing stuck on `landing` for the
 * life of the container, with no status the operator could ever see change.
 */
describe("git", () => {
  it("reports a child that could not be started, rather than rejecting", async () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "uf-git-")),
      "not-a-directory",
    );
    fs.writeFileSync(file, "");

    // A `cwd` that is a file: ENOTDIR, which `spawn` throws synchronously.
    const res = await git(file, ["rev-parse", "HEAD"]);

    assert.equal(res.ok, false);
    assert.equal(res.code, null);
    assert.match(res.stderr, /ENOTDIR/);
  });
});

/**
 * `GIT_BIN`'s default is a path, because this server is root and its `PATH`
 * starts with the stacks' `bin/` and an agent-writable `/home/node/pytools/bin`.
 * A `git` planted first on it would be what every diff, worktree and landing
 * ran — as root wherever the uid split is off. Skipped when `GIT_BIN` is set,
 * since the default is then not what runs.
 */
describe("GIT_BIN", () => {
  it(
    "runs the image's git rather than the first git on PATH",
    { skip: process.env.GIT_BIN ? "GIT_BIN is set, so the default is not what runs" : false },
    () => {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "uf-git-path-"));
      const ran = path.join(scratch, "ran");
      fs.writeFileSync(path.join(scratch, "git"), `#!/bin/sh\n: > "${ran}"\necho "git version 0.planted"\n`, {
        mode: 0o755,
      });
      const saved = process.env.PATH;
      process.env.PATH = `${scratch}${path.delimiter}${saved ?? ""}`;
      try {
        const res = gitSync(scratch, ["--version"]);
        assert.equal(fs.existsSync(ran), false, "the git planted first on PATH ran");
        assert.equal(res.ok, true, res.stderr);
        assert.match(res.stdout, /^git version \d/);
      } finally {
        process.env.PATH = saved;
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    },
  );
});

/**
 * That a program a work cycle plants in its repository's `.git` cannot be run by
 * this app's own git — the vuln this server would be wide open to otherwise, of
 * the same class as the `core.hooksPath` clearing. A work cycle commits into the
 * real common `.git`, so it can write `.git/config` and `.git/info/attributes`;
 * two lines in each make `git commit`, `git add` or `git worktree add` run a
 * program the run chose, as this server's git child, outside the permission
 * model. The fix pins the signing programs and forces `commit.gpgSign=false` in
 * `gitArgs`, and blanks every repository-named filter driver on the content
 * subcommands. The control proves the plants fire without it, so a `-c` that
 * stopped carrying its pin would fail this rather than pass silently.
 */
describe("the server's own git refuses a command a work cycle planted in .git", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-git-plant-")));

  before(() => {
    // The server's own environment carries none of a shell's git overrides, so
    // only `gitArgs`/`gitEnv` and the repository's `.git/config` decide. An
    // inherited `GIT_CONFIG_*` would otherwise outrank the planted config and
    // the control could stop firing. Scoped to this file's process, which
    // `node --test` isolates.
    for (const k of Object.keys(process.env)) if (k.startsWith("GIT_")) delete process.env[k];
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  // `before` has stripped `GIT_*` from `process.env`, so spreading it carries
  // no shell git override; `NOSYSTEM`/`GLOBAL` keep the host's config out too.
  const plainEnv = (): NodeJS.ProcessEnv => ({
    ...process.env,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  });
  const plain = (cwd: string, args: string[]) =>
    execFileSync("git", args, { cwd, env: plainEnv(), encoding: "utf8" });

  function repoWithPlant(name: string): { repo: string; marker: string; prog: string } {
    const repo = path.join(root, name);
    fs.mkdirSync(repo);
    plain(repo, ["init", "-q", "-b", "main"]);
    plain(repo, ["config", "user.email", "a@b.c"]);
    plain(repo, ["config", "user.name", "a"]);
    fs.writeFileSync(path.join(repo, "f.txt"), "one\n");
    plain(repo, ["add", "-A"]);
    plain(repo, ["commit", "-q", "-m", "init"]);
    const marker = path.join(root, `${name}.ran`);
    const prog = path.join(root, `${name}.sh`);
    // Records that it ran and passes content through, so a filter that is not
    // neutralised succeeds *and* leaves the marker — the failure the test hunts.
    fs.writeFileSync(prog, `#!/bin/sh\necho "ran $*" >> ${marker}\ncat\n`, { mode: 0o755 });
    return { repo, marker, prog };
  }

  const attribute = (repo: string) => {
    fs.mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "info", "attributes"), "* filter=x\n");
  };

  it("commit.gpgSign + gpg.program: `git commit` signs with nothing", async () => {
    const { repo, marker, prog } = repoWithPlant("sign");
    plain(repo, ["config", "commit.gpgSign", "true"]);
    plain(repo, ["config", "gpg.program", prog]);
    fs.writeFileSync(path.join(repo, "f.txt"), "two\n");
    await git(repo, ["add", "-A"]);
    const res = await git(repo, ["commit", "-m", "x"]);

    assert.equal(res.ok, true, `commit failed: ${res.stderr}`);
    assert.equal(
      fs.existsSync(marker),
      false,
      `planted gpg.program ran: ${fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : ""}`,
    );
  });

  it("filter.<x>.clean named from .git/info/attributes: `git add -A` runs nothing", async () => {
    const { repo, marker, prog } = repoWithPlant("clean");
    plain(repo, ["config", "filter.x.clean", prog]);
    attribute(repo);
    fs.writeFileSync(path.join(repo, "f.txt"), "three\n");
    const res = await git(repo, ["add", "-A"]);

    assert.equal(res.ok, true, `add failed: ${res.stderr}`);
    assert.equal(
      fs.existsSync(marker),
      false,
      `planted clean filter ran: ${fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : ""}`,
    );
  });

  it("filter.<x>.smudge: `addWorktree` runs nothing on checkout", async () => {
    const { repo, marker, prog } = repoWithPlant("smudge");
    plain(repo, ["config", "filter.x.smudge", prog]);
    attribute(repo);
    const res = await addWorktree(repo, path.join(root, "smudge-wt"), "main", { newBranch: "uf/x" });

    assert.equal(res.ok, true, `worktree add failed: ${res.stderr}`);
    assert.equal(
      fs.existsSync(marker),
      false,
      `planted smudge filter ran: ${fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : ""}`,
    );
  });

  it("filter.<x>.clean: a working-tree `diff --name-only` runs nothing on a stat-dirty file", async () => {
    // `conflictedFiles`' call shape. `--name-only` opens no blob for a diff
    // driver, but deciding whether a stat-dirty file changed re-hashes it, and
    // that runs the clean filter (measured, 2.39).
    const { repo, marker, prog } = repoWithPlant("diffwt");
    plain(repo, ["config", "filter.x.clean", prog]);
    attribute(repo);
    const past = new Date("2001-01-01T00:00:00Z");
    fs.utimesSync(path.join(repo, "f.txt"), past, past);
    const res = await git(repo, ["diff", "--name-only", "-z"]);

    assert.equal(res.ok, true, `diff failed: ${res.stderr}`);
    assert.equal(
      fs.existsSync(marker),
      false,
      `planted clean filter ran: ${fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : ""}`,
    );
  });

  it("a dotted driver name keeps its case, so the override still matches", async () => {
    // git lower-cases the section and the key but preserves the subsection, so
    // `filter.Some.Name.clean` must be blanked with its case intact.
    const { repo, marker, prog } = repoWithPlant("dotted");
    plain(repo, ["config", "filter.Some.Name.clean", prog]);
    fs.mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "info", "attributes"), "* filter=Some.Name\n");
    fs.writeFileSync(path.join(repo, "f.txt"), "four\n");
    const res = await git(repo, ["add", "-A"]);

    assert.equal(res.ok, true, `add failed: ${res.stderr}`);
    assert.equal(
      fs.existsSync(marker),
      false,
      `planted dotted filter ran: ${fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : ""}`,
    );
  });

  it("control: the same plants fire under plain git", () => {
    const { repo, marker, prog } = repoWithPlant("control");
    plain(repo, ["config", "filter.x.clean", prog]);
    attribute(repo);
    fs.writeFileSync(path.join(repo, "f.txt"), "five\n");
    plain(repo, ["add", "-A"]);
    assert.equal(fs.existsSync(marker), true, "the planted clean filter did not fire on add");

    fs.rmSync(marker);
    const past = new Date("2001-01-01T00:00:00Z");
    fs.utimesSync(path.join(repo, "f.txt"), past, past);
    plain(repo, ["diff", "--name-only"]);
    assert.equal(fs.existsSync(marker), true, "the planted clean filter did not fire on diff");
  });
});

/**
 * git 2.54 added hooks defined in config (`hook.<name>.command` plus `.event`),
 * which `core.hooksPath=/dev/null` does not reach: before board task 6b4dccf3 a
 * pair a work cycle wrote into `.git/config` ran on this app's own `commit`,
 * `update-ref`, `branch -D` and `push`. Each case plants one and drives `git()`
 * through a call that fires its event, and asserts the marker never appears.
 *
 * A git that reads no `hook.*` key, the image's 2.39.5 among them, cannot run a
 * plant whatever this app does, so every case is skipped there rather than
 * passing having measured nothing. The control decides that, by planting the
 * same hook and committing under plain git.
 */
describe("the server's own git runs no hook a work cycle defined in .git/config", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-git-hook-")));
  let configHooksRun = false;

  const plainEnv = (): NodeJS.ProcessEnv => ({
    ...process.env,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  });
  const plain = (cwd: string, args: string[]) =>
    execFileSync("git", args, { cwd, env: plainEnv(), encoding: "utf8" });

  let count = 0;
  function repoWithHooks(events: string[], names = ["planted"]): { repo: string; marker: string } {
    const repo = path.join(root, `repo${count++}`);
    fs.mkdirSync(repo);
    plain(repo, ["init", "-q", "-b", "main"]);
    plain(repo, ["config", "user.email", "a@b.c"]);
    plain(repo, ["config", "user.name", "a"]);
    plain(repo, ["commit", "-q", "--allow-empty", "-m", "init"]);
    const marker = `${repo}.ran`;
    for (const name of names) {
      plain(repo, ["config", `hook.${name}.command`, `echo "${name} ran" >> '${marker}'`]);
      for (const event of events) plain(repo, ["config", "--add", `hook.${name}.event`, event]);
    }
    return { repo, marker };
  }

  const ranNothing = (marker: string) =>
    assert.equal(
      fs.existsSync(marker),
      false,
      `a planted hook ran: ${fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : ""}`,
    );

  before(() => {
    // As above: only `gitArgs`/`gitEnv` and the repository's config decide.
    for (const k of Object.keys(process.env)) if (k.startsWith("GIT_")) delete process.env[k];
    const { repo, marker } = repoWithHooks(["pre-commit"]);
    plain(repo, ["commit", "-q", "--allow-empty", "-m", "probe"]);
    configHooksRun = fs.existsSync(marker);
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  const skipped = "this git reads no hook defined in config, so there is nothing to switch off";

  /**
   * A repository where a `commit`'s automatic maintenance runs `gc --auto`,
   * which fires `pre-auto-gc` in that second git rather than in the one this
   * app spawned. git 2.54's default maintenance strategy runs no gc, so the
   * plant also sets `maintenance.strategy=gc`, as a work cycle could; two packs
   * against `gc.autoPackLimit=1` make the gc due without thousands of loose
   * objects.
   */
  function autoGcRepo(): { repo: string; marker: string } {
    const planted = repoWithHooks(["pre-auto-gc"]);
    const { repo, marker } = planted;
    plain(repo, ["repack", "-q"]);
    plain(repo, ["commit", "-q", "--allow-empty", "-m", "second"]);
    plain(repo, ["repack", "-q"]);
    plain(repo, ["config", "maintenance.strategy", "gc"]);
    plain(repo, ["config", "gc.autoPackLimit", "1"]);
    plain(repo, ["config", "gc.autoDetach", "false"]);
    plain(repo, ["config", "maintenance.autoDetach", "false"]);
    fs.rmSync(marker, { force: true });
    return planted;
  }

  /**
   * A superproject whose `push.recurseSubmodules=on-demand` makes `push` start a
   * second push inside its submodule, to the submodule's own remote, and whose
   * submodule's own configuration defines a `pre-push` hook. The submodule has
   * a commit its remote lacks, so the recursion has something to send.
   */
  function submodulePushRepo(): { repo: string; marker: string; subRemote: string } {
    const base = path.join(root, `sm${count++}`);
    fs.mkdirSync(base);
    const subRemote = path.join(base, "sub-remote.git");
    const superRemote = path.join(base, "super-remote.git");
    plain(base, ["init", "-q", "--bare", "-b", "main", subRemote]);
    plain(base, ["init", "-q", "--bare", "-b", "main", superRemote]);
    const sub = path.join(base, "sub");
    plain(base, ["init", "-q", "-b", "main", sub]);
    plain(sub, ["-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "s1"]);
    plain(sub, ["push", "-q", subRemote, "main"]);

    const repo = path.join(base, "super");
    plain(base, ["init", "-q", "-b", "main", repo]);
    plain(repo, ["config", "user.email", "a@b.c"]);
    plain(repo, ["config", "user.name", "a"]);
    plain(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", subRemote, "sm"]);
    plain(repo, ["commit", "-q", "-m", "add"]);
    plain(repo, ["remote", "add", "origin", superRemote]);
    const sm = path.join(repo, "sm");
    plain(sm, ["-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "s2"]);
    plain(repo, ["add", "sm"]);
    plain(repo, ["commit", "-q", "-m", "bump"]);
    plain(repo, ["config", "push.recurseSubmodules", "on-demand"]);

    const marker = `${base}.ran`;
    plain(sm, ["config", "hook.p.command", `echo "sm ran" >> '${marker}'`]);
    plain(sm, ["config", "hook.p.event", "pre-push"]);
    return { repo, marker, subRemote };
  }

  it("`commit`: a pre-commit hook named in config runs under neither git() nor gitSync()", async (t) => {
    if (!configHooksRun) return t.skip(skipped);
    const { repo, marker } = repoWithHooks(["pre-commit", "commit-msg", "post-commit"]);

    const viaGit = await git(repo, ["commit", "--allow-empty", "-m", "t"]);
    assert.equal(viaGit.ok, true, `commit failed: ${viaGit.stderr}`);
    const viaSync = gitSync(repo, ["commit", "--allow-empty", "-m", "t2"]);
    assert.equal(viaSync.ok, true, `commit failed: ${viaSync.stderr}`);
    ranNothing(marker);
  });

  it("`update-ref` and `branch -D`: no reference-transaction hook, though neither moves content", async (t) => {
    if (!configHooksRun) return t.skip(skipped);
    const { repo, marker } = repoWithHooks(["reference-transaction"]);

    const moved = await git(repo, ["update-ref", "refs/heads/moved", "HEAD"]);
    assert.equal(moved.ok, true, `update-ref failed: ${moved.stderr}`);
    const deleted = await git(repo, ["branch", "-D", "moved"]);
    assert.equal(deleted.ok, true, `branch -D failed: ${deleted.stderr}`);
    ranNothing(marker);
  });

  it("`push`: no pre-push hook", async (t) => {
    if (!configHooksRun) return t.skip(skipped);
    const { repo, marker } = repoWithHooks(["pre-push", "reference-transaction"]);
    const remote = `${repo}-remote.git`;
    plain(root, ["init", "-q", "--bare", remote]);
    plain(repo, ["remote", "add", "origin", remote]);

    const pushed = await git(repo, ["push", "origin", "HEAD:refs/heads/pushed"]);
    assert.equal(pushed.ok, true, `push failed: ${pushed.stderr}`);
    ranNothing(marker);
  });

  it("a hook's name is matched as git keeps it: dotted, mixed-case, spaced and holding `=`", async (t) => {
    // git keeps a subsection's case and every byte of it, and splits a `-c` at
    // its first `=`, so `-c hook.a=b.enabled=false` would set `hook.a` and
    // leave `a=b` running.
    if (!configHooksRun) return t.skip(skipped);
    const { repo, marker } = repoWithHooks(["pre-commit"], ["a.b", "MiXed", "sp ace", "a=b"]);

    const res = await git(repo, ["commit", "--allow-empty", "-m", "t"]);
    assert.equal(res.ok, true, `commit failed: ${res.stderr}`);
    ranNothing(marker);
  });

  it("a commit's automatic gc: no pre-auto-gc hook in the second git it starts", async (t) => {
    // The switch travels to that child in `GIT_CONFIG_PARAMETERS` with the rest
    // of the command line's configuration; before the change the hook ran there.
    if (!configHooksRun) return t.skip(skipped);
    const { repo, marker } = autoGcRepo();

    const res = await git(repo, ["commit", "--allow-empty", "-m", "t"]);
    assert.equal(res.ok, true, `commit failed: ${res.stderr}`);
    ranNothing(marker);
  });

  it("a push the repository asks to recurse: the submodule is not pushed and its pre-push hook does not run", async (t) => {
    // The recursion is a second push, to a remote no door here checked. Before
    // the change `push` was not probed, carried no `submodule.recurse=false`, and
    // pushed the submodule and ran its hook; from the command line that pin
    // outranks the repository's `push.recurseSubmodules` (measured, 2.54.0).
    if (!configHooksRun) return t.skip(skipped);
    const { repo, marker, subRemote } = submodulePushRepo();

    const pushed = await git(repo, ["push", "origin", "HEAD:refs/heads/pushed"]);
    assert.equal(pushed.ok, true, `push failed: ${pushed.stderr}`);
    ranNothing(marker);
    assert.equal(
      plain(subRemote, ["branch", "--list", "pushed"]).trim(),
      "",
      "the submodule was pushed to its own remote",
    );
  });

  it("control: the same plants fire under plain git", (t) => {
    if (!configHooksRun) return t.skip(skipped);
    const { repo, marker } = repoWithHooks(["pre-commit", "reference-transaction", "pre-push"], ["a=b"]);
    const remote = `${repo}-remote.git`;
    plain(root, ["init", "-q", "--bare", remote]);
    plain(repo, ["remote", "add", "origin", remote]);

    for (const args of [
      ["commit", "-q", "--allow-empty", "-m", "t"],
      ["update-ref", "refs/heads/moved", "HEAD"],
      ["push", "-q", "origin", "HEAD:refs/heads/pushed"],
    ]) {
      if (fs.existsSync(marker)) fs.rmSync(marker);
      plain(repo, args);
      assert.equal(fs.existsSync(marker), true, `the planted hook did not fire on ${args[0]}`);
    }

    const gc = autoGcRepo();
    plain(gc.repo, ["commit", "-q", "--allow-empty", "-m", "t"]);
    assert.equal(fs.existsSync(gc.marker), true, "the planted pre-auto-gc hook did not fire");

    const sm = submodulePushRepo();
    plain(sm.repo, ["push", "-q", "origin", "HEAD:refs/heads/pushed"]);
    assert.equal(fs.existsSync(sm.marker), true, "the submodule's planted pre-push hook did not fire");
    assert.equal(plain(sm.subRemote, ["branch", "--list", "pushed"]).trim(), "pushed");
  });
});
