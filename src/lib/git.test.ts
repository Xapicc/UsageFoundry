import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { git, gitArgs, gitEnv, gitSync } from "./git";
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
