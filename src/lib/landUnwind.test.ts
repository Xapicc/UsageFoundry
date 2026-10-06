import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { conflictedFiles, unwind } from "./land";

/**
 * What a failed squash's undo does to the operator's own checkout.
 *
 * `unwind` followed a failed `git merge --squash` with `merge --abort`, which
 * fails because a squash never writes MERGE_HEAD, and then `reset --hard HEAD`.
 * git refuses a squash precisely *because* the checkout holds changes it would
 * overwrite, so that undo destroyed every uncommitted edit in the tree — the one
 * the squash would have overwritten and every unrelated one beside it — and the
 * land card said "rolled back". `landRun` now re-reads the checkout before the
 * merge, but that read and git's are two moments, and the squash's commit runs
 * the operator's hooks; this pins what the undo does when git still finds a
 * change.
 *
 * A real repository for `conflictedPaths.test.ts`' reason: the fault is in what
 * git does to a working tree, and a fixture that stated it would be stating the
 * very thing in question. Nothing here opens the database or spawns `claude`.
 */

let root: string;

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

/** The exit status of a git command expected to fail, which `execFileSync` throws on. */
const gitStatus = (cwd: string, ...args: string[]): number => {
  try {
    git(cwd, ...args);
    return 0;
  } catch (err) {
    return (err as { status: number }).status;
  }
};

const read = (repo: string, file: string) => fs.readFileSync(path.join(repo, file), "utf8");
const write = (repo: string, file: string, text: string) =>
  fs.writeFileSync(path.join(repo, file), text);

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-unwind-")));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A checkout on `main` and a branch `uf/run` that changes `shared.txt` and adds
 * `added.txt`. With `conflict`, `main` has since changed `shared.txt` too.
 */
function fixture(name: string, opts: { conflict?: boolean } = {}): string {
  const repo = path.join(root, name);
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  for (const file of ["shared.txt", "other.txt", "staged.txt"]) write(repo, file, "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");

  git(repo, "checkout", "-q", "-b", "uf/run");
  write(repo, "shared.txt", "branch\n");
  write(repo, "added.txt", "branch\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "run");
  git(repo, "checkout", "-q", "main");

  if (opts.conflict) {
    write(repo, "shared.txt", "main\n");
    git(repo, "commit", "-qam", "main moved");
  }
  return repo;
}

describe("unwind after a squash git refused", () => {
  it("leaves every edit in the checkout where it was", async () => {
    const repo = fixture("refused");
    // One the squash would overwrite, one it has nothing to do with, and one
    // staged — the last is the one `reset --merge` would also have taken, so it
    // is what makes "no undo at all" the answer rather than a gentler undo.
    write(repo, "shared.txt", "operator edit\n");
    write(repo, "other.txt", "operator unrelated\n");
    write(repo, "staged.txt", "operator staged\n");
    git(repo, "add", "staged.txt");

    assert.notEqual(gitStatus(repo, "merge", "--squash", "uf/run"), 0, "git let the squash through");
    const conflicts = await conflictedFiles(repo);
    assert.deepEqual(conflicts, [], "a refused squash is not a conflicted one");

    assert.equal(await unwind(repo, "squash", conflicts.length > 0), "restored");

    assert.equal(read(repo, "shared.txt"), "operator edit\n");
    assert.equal(read(repo, "other.txt"), "operator unrelated\n");
    assert.equal(read(repo, "staged.txt"), "operator staged\n");
    assert.equal(git(repo, "diff", "--cached", "--name-only").trim(), "staged.txt");
    assert.equal(fs.existsSync(path.join(repo, "added.txt")), false);
  });
});

describe("unwind after a squash that wrote", () => {
  it("rolls a conflicted squash back and keeps an edit it did not touch", async () => {
    const repo = fixture("conflicted", { conflict: true });
    // Made between the land's last read and git's: the squash does not refuse
    // over a file it does not change, so this edit is in the tree it unwinds.
    write(repo, "other.txt", "operator unrelated\n");

    assert.notEqual(gitStatus(repo, "merge", "--squash", "uf/run"), 0);
    const conflicts = await conflictedFiles(repo);
    assert.deepEqual(conflicts, ["shared.txt"]);

    assert.equal(await unwind(repo, "squash", conflicts.length > 0), "restored");

    assert.deepEqual(await conflictedFiles(repo), []);
    assert.equal(read(repo, "shared.txt"), "main\n");
    assert.equal(fs.existsSync(path.join(repo, "added.txt")), false);
    assert.equal(read(repo, "other.txt"), "operator unrelated\n");
    assert.equal(git(repo, "status", "--porcelain"), " M other.txt\n");
  });

  it("rolls back a squash whose commit was refused", async () => {
    const repo = fixture("uncommitted");
    assert.equal(gitStatus(repo, "merge", "--squash", "uf/run"), 0);
    assert.notEqual(git(repo, "status", "--porcelain"), "", "the squash staged nothing");

    assert.equal(await unwind(repo, "squash", true), "restored");

    assert.equal(git(repo, "status", "--porcelain"), "");
    assert.equal(read(repo, "shared.txt"), "base\n");
  });

  it("says so rather than overwriting an edit tangled with what it staged", async () => {
    // A pre-commit hook rewriting a staged file, or a person editing one while
    // the hook runs: `reset --merge` cannot tell that edit from the squash's and
    // refuses, and the caller must then say the checkout was not restored.
    const repo = fixture("tangled");
    assert.equal(gitStatus(repo, "merge", "--squash", "uf/run"), 0);
    write(repo, "shared.txt", "branch\nand an edit on top\n");

    assert.equal(await unwind(repo, "squash", true), "changed");

    assert.equal(read(repo, "shared.txt"), "branch\nand an edit on top\n");
  });
});

describe("unwind after a fast-forward git wrote and could not record", () => {
  /**
   * Another process holding `main`'s ref lock: git writes the branch's tree
   * into the index and the working tree, then refuses to move `main`, leaving
   * no MERGE_HEAD for `merge --abort` to work from.
   */
  function refusedAtTheRef(name: string): string {
    const repo = fixture(name);
    fs.writeFileSync(path.join(repo, ".git", "refs", "heads", "main.lock"), "");
    assert.notEqual(gitStatus(repo, "merge", "--no-edit", "uf/run"), 0, "git moved main");
    assert.notEqual(git(repo, "status", "--porcelain"), "", "the fast-forward wrote nothing");
    return repo;
  }

  it("takes it back out while the lock is still held", async () => {
    const repo = refusedAtTheRef("ff-ref-lock");

    assert.equal(await unwind(repo, "merge", false), "restored");

    assert.equal(git(repo, "status", "--porcelain"), "");
    assert.equal(read(repo, "shared.txt"), "base\n");
    assert.equal(fs.existsSync(path.join(repo, "added.txt")), false);
  });

  it("says so rather than overwriting an edit tangled with what it wrote", async () => {
    const repo = refusedAtTheRef("ff-ref-lock-tangled");
    write(repo, "shared.txt", "branch\nand an edit on top\n");

    assert.equal(await unwind(repo, "merge", false), "changed");

    assert.equal(read(repo, "shared.txt"), "branch\nand an edit on top\n");
  });
});
