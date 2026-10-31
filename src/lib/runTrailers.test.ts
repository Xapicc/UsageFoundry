import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  hasRunTrailer,
  identityEnv,
  nightOf,
  parseCommitObject,
  stampBranchCommits,
  trailerFlags,
  trailerParagraph,
  trailersFor,
} from "./runTrailers";

/**
 * What a commit says about its run is the whole of the record "which run wrote
 * this" rests on, and every way it fails is silent: a trailer built from an
 * unchecked model id forges a second one, a stamp that moved the author breaks
 * every attribution the operator already reads, and a stamp that rewrote a
 * commit the target already has forks the target's history. None of it throws.
 */
describe("trailersFor writes the lines a run's commits carry", () => {
  it("orders the run, its tasks, the night and the model", () => {
    const got = trailersFor({
      runId: "run-1",
      taskIds: ["task-a", "task-b"],
      model: "claude-sonnet-5-5[1m]",
      night: "2026-10-31",
    });
    assert.deepEqual(got, [
      ["UF-Run", "run-1"],
      ["UF-Task", "task-a"],
      ["UF-Task", "task-b"],
      ["UF-Night", "2026-10-31"],
      ["Model", "claude-sonnet-5-5[1m]"],
    ]);
  });

  it("leaves out what the run does not have, rather than writing an empty line", () => {
    assert.deepEqual(trailersFor({ runId: "run-1", taskIds: [], model: null, night: null }), [
      ["UF-Run", "run-1"],
    ]);
  });

  it("leaves out a model or night that could not sit on one line, so none forges a second trailer", () => {
    const got = trailersFor({
      runId: "run-1",
      taskIds: ["ok", "bad\nUF-Run: forged"],
      model: "m\nUF-Run: forged",
      night: "tonight",
    });
    assert.deepEqual(got, [
      ["UF-Run", "run-1"],
      ["UF-Task", "ok"],
    ]);
    assert.throws(
      () => trailersFor({ runId: "a b", taskIds: [], model: null, night: null }),
      /cannot be written as a trailer/,
    );
  });

  it("reads the night off a Dreaming run's origin and no other", () => {
    assert.equal(nightOf("dreaming:2026-10-31"), "2026-10-31");
    assert.equal(nightOf("schedule:abc"), null);
    assert.equal(nightOf(null), null);
  });

  it("renders as git commit flags and as one paragraph", () => {
    const t = trailersFor({ runId: "r", taskIds: [], model: "m1", night: null });
    assert.deepEqual(trailerFlags(t), ["--trailer", "UF-Run: r", "--trailer", "Model: m1"]);
    assert.equal(trailerParagraph(t), "UF-Run: r\nModel: m1");
  });
});

describe("hasRunTrailer reads the last paragraph as git does", () => {
  it("is true for a stamped message and false for a plain one", () => {
    assert.equal(hasRunTrailer("subject\n\nbody\n\nUF-Run: r1\nModel: m\n"), true);
    assert.equal(hasRunTrailer("subject\n\nbody\n"), false);
  });

  it("does not count the word in the body, or a stamp that is not at the end", () => {
    assert.equal(hasRunTrailer("subject\n\nUF-Run: r1 was mentioned here\n\nmore text\n"), false);
    assert.equal(hasRunTrailer("subject\n\nUF-Run: r1\n\nand then prose\n"), false);
  });
});

describe("parseCommitObject refuses a commit it cannot re-make faithfully", () => {
  const base =
    "tree aaa\nparent bbb\nauthor A <a@x> 100 +0000\ncommitter C <c@x> 200 +0100\n";

  it("splits the four headers and keeps the message verbatim", () => {
    assert.deepEqual(parseCommitObject(`${base}\nsubject\n\nbody\n`), {
      tree: "aaa",
      parents: ["bbb"],
      author: "A <a@x> 100 +0000",
      committer: "C <c@x> 200 +0100",
      message: "subject\n\nbody\n",
    });
  });

  it("refuses a signed, tagged or re-encoded commit", () => {
    for (const extra of ["gpgsig -----BEGIN PGP SIGNATURE-----\n x\n", "encoding latin1\n", "mergetag object x\n"]) {
      assert.equal(parseCommitObject(`${base}${extra}\nsubject\n`), null, extra);
    }
  });
});

describe("identityEnv carries a name, address and time over exactly", () => {
  it("maps the header to the variables commit-tree reads", () => {
    assert.deepEqual(identityEnv("AUTHOR", "Ada Lovelace <ada@example.org> 1700000000 -0530"), {
      GIT_AUTHOR_NAME: "Ada Lovelace",
      GIT_AUTHOR_EMAIL: "ada@example.org",
      GIT_AUTHOR_DATE: "1700000000 -0530",
    });
  });

  it("is null for an empty address or a header it cannot read", () => {
    assert.equal(identityEnv("COMMITTER", "Ada <> 1 +0000"), null);
    assert.equal(identityEnv("COMMITTER", "no date here"), null);
  });
});

describe("stampBranchCommits stamps the run's commits and nothing else", () => {
  let root: string;
  const TRAILERS = trailersFor({ runId: "run-7", taskIds: ["task-9"], model: "claude-x", night: null });

  const sh = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_AUTHOR_NAME: "Agent",
        GIT_AUTHOR_EMAIL: "agent@example.org",
        GIT_COMMITTER_NAME: "Agent",
        GIT_COMMITTER_EMAIL: "agent@example.org",
        GIT_AUTHOR_DATE: "1700000000 +0200",
        GIT_COMMITTER_DATE: "1700000100 +0200",
      },
    }).trim();

  /** A repository on `main` with one base commit, and `uf/work` cut from it. */
  function scene(name: string): { repo: string; base: string } {
    const repo = path.join(root, name);
    fs.mkdirSync(repo);
    sh(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "base");
    sh(repo, "checkout", "-q", "-b", "uf/work");
    return { repo, base: sh(repo, "rev-parse", "main") };
  }

  const commit = (repo: string, file: string, message: string) => {
    fs.writeFileSync(path.join(repo, file), `${message}\n`);
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", message);
    return sh(repo, "rev-parse", "HEAD");
  };

  const stamp = (repo: string, landedTips: string[] = []) =>
    stampBranchCommits({ cwd: repo, branch: "uf/work", target: "main", landedTips, trailers: TRAILERS });

  before(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-trailers-")));
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it("adds the trailers to each commit, keeping tree, author, committer and dates", async () => {
    const { repo, base } = scene("plain");
    const first = commit(repo, "one.txt", "one");
    const second = commit(repo, "two.txt", "two");

    const outcome = await stamp(repo);

    assert.deepEqual(outcome, { ok: true, stamped: 2 });
    const log = sh(repo, "log", "--reverse", "--format=%H|%T|%an|%ae|%ad|%cn|%ce|%cd|%P", "--date=raw", `${base}..uf/work`)
      .split("\n")
      .map((l) => l.split("|"));
    assert.equal(log.length, 2);
    assert.equal(log[0][1], sh(repo, "rev-parse", `${first}^{tree}`), "the tree changed");
    assert.equal(log[1][1], sh(repo, "rev-parse", `${second}^{tree}`), "the tree changed");
    for (const row of log) {
      assert.deepEqual(row.slice(2, 8), ["Agent", "agent@example.org", "1700000000 +0200", "Agent", "agent@example.org", "1700000100 +0200"]);
    }
    assert.equal(log[0][8], base, "the first commit lost its parent");
    assert.equal(log[1][8], log[0][0], "the second commit does not sit on the stamped first");
    const trailers = sh(repo, "log", "-1", "--format=%(trailers:only,unfold)");
    assert.equal(trailers, "UF-Run: run-7\nUF-Task: task-9\nModel: claude-x");
    assert.match(sh(repo, "log", "-1", "--format=%s"), /^two$/);
    assert.equal(sh(repo, "status", "--porcelain"), "", "the checkout was disturbed");
    assert.notEqual(log[1][0], second);
  });

  it("is idempotent: a second pass finds every commit stamped and moves nothing", async () => {
    const { repo } = scene("again");
    commit(repo, "one.txt", "one");
    await stamp(repo);
    const tip = sh(repo, "rev-parse", "uf/work");

    assert.deepEqual(await stamp(repo), { ok: true, stamped: 0 });
    assert.equal(sh(repo, "rev-parse", "uf/work"), tip);
  });

  it("never touches a commit the target already has, including ones merged into the branch", async () => {
    const { repo } = scene("merged-in");
    commit(repo, "one.txt", "one");
    sh(repo, "checkout", "-q", "main");
    const mainTip = commit(repo, "main.txt", "on main");
    sh(repo, "checkout", "-q", "uf/work");
    sh(repo, "merge", "-q", "--no-edit", "main");
    const after = commit(repo, "after.txt", "after the merge");

    const outcome = await stamp(repo);

    assert.deepEqual(outcome, { ok: true, stamped: 3 });
    assert.equal(sh(repo, "rev-parse", "main"), mainTip, "main moved");
    const merge = sh(repo, "log", "--merges", "-1", "--format=%P", "uf/work").split(" ");
    assert.equal(merge[1], mainTip, "the merge no longer has the target's own commit as its second parent");
    assert.match(sh(repo, "log", "--merges", "-1", "--format=%(trailers:only)", "uf/work"), /UF-Run: run-7/);
    assert.equal(sh(repo, "log", "-1", "--format=%s", "uf/work"), "after the merge");
    assert.notEqual(sh(repo, "rev-parse", "uf/work"), after);
    assert.equal(sh(repo, "rev-list", "--count", "main..uf/work"), "3");
  });

  it("leaves a tip an earlier run landed, and everything under it, exactly as it was", async () => {
    const { repo } = scene("landed");
    const landed = commit(repo, "one.txt", "landed earlier");
    commit(repo, "two.txt", "this run's");

    const outcome = await stamp(repo, [landed]);

    assert.deepEqual(outcome, { ok: true, stamped: 1 });
    assert.equal(sh(repo, "merge-base", "--is-ancestor", landed, "uf/work") ?? "", "");
    assert.doesNotMatch(sh(repo, "log", "-1", "--format=%B", landed), /UF-Run/);
  });

  it("leaves another run's stamped commit alone and still stamps the ones above it", async () => {
    const { repo } = scene("chain");
    commit(repo, "one.txt", "first\n\nUF-Run: run-earlier");
    const theirs = sh(repo, "rev-parse", "HEAD");
    commit(repo, "two.txt", "second");

    const outcome = await stamp(repo);

    assert.deepEqual(outcome, { ok: true, stamped: 1 });
    assert.equal(sh(repo, "rev-parse", "uf/work~1"), theirs, "an earlier run's commit was rewritten");
    assert.match(sh(repo, "log", "-1", "--format=%(trailers:only)", "uf/work"), /UF-Run: run-7/);
  });

  it("changes nothing when a commit cannot be re-made with only its message changed", async () => {
    const { repo, base } = scene("signed");
    commit(repo, "one.txt", "one");
    const tree = sh(repo, "rev-parse", "HEAD^{tree}");
    // A commit object with a header this app does not carry over, written the
    // way a signed one would be.
    const raw = `tree ${tree}\nparent ${sh(repo, "rev-parse", "HEAD")}\nauthor A <a@x> 1 +0000\ncommitter A <a@x> 1 +0000\nencoding latin1\n\nodd\n`;
    const odd = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: repo, input: raw, encoding: "utf8" }).trim();
    sh(repo, "update-ref", "refs/heads/uf/work", odd);

    const outcome = await stamp(repo);

    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? "" : outcome.reason, /cannot be re-made/);
    assert.equal(sh(repo, "rev-parse", "uf/work"), odd, "the branch moved on a refused stamp");
    assert.equal(sh(repo, "rev-list", "--count", `${base}..uf/work`), "2");
  });

  it("says why when the target is not a local branch, and moves nothing", async () => {
    const { repo } = scene("no-target");
    commit(repo, "one.txt", "one");
    const tip = sh(repo, "rev-parse", "uf/work");

    const outcome = await stampBranchCommits({
      cwd: repo, branch: "uf/work", target: "gone", landedTips: [], trailers: TRAILERS,
    });

    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? "" : outcome.reason, /target gone is not a local branch/);
    assert.equal(sh(repo, "rev-parse", "uf/work"), tip);
  });

  it("does nothing for a branch with no commits of its own", async () => {
    const { repo } = scene("empty");
    assert.deepEqual(await stamp(repo), { ok: true, stamped: 0 });
  });

  it("ignores a landed tip the repository no longer has", async () => {
    const { repo } = scene("gone-tip");
    commit(repo, "one.txt", "one");
    assert.deepEqual(await stamp(repo, ["0".repeat(40)]), { ok: true, stamped: 1 });
  });
});
