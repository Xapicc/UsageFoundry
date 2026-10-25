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
