import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PlaceholderStats } from "./sandboxMountPoints";
import {
  SANDBOX_TREE_ROOT_EXCLUDES,
  SANDBOX_TREE_ROOT_NAMES,
  isAbandonedMountPoint,
  sandboxMountPointDirs,
  sweepAbandonedMountPoints,
} from "./sandboxMountPoints";

/**
 * Covers which trees get placeholders, and nothing else in that module.
 *
 * It earns a test because both ways of being wrong are silent and point in
 * opposite directions. Return too few directories and the bwrap failures this
 * exists to remove carry on with the fix reporting success — the case that
 * matters is the *ancestor*, since the single most frequent failing path on
 * this install was `/workspace/.claude/settings.local.json` for a run whose
 * working directory was two levels below it. Return too many and this app
 * writes empty files into trees nobody pointed it at, which is why the ancestor
 * half is guarded on `.claude` already being there and the working directory is
 * the only one that may have one made.
 */

describe("sandboxMountPointDirs", () => {
  it("takes the working directory whether or not it has a .claude", () => {
    assert.deepEqual(sandboxMountPointDirs("/workspace/repo", () => false), [
      "/workspace/repo",
    ]);
  });

  it("takes an ancestor that already has one, and skips one that does not", () => {
    const dirs = sandboxMountPointDirs(
      "/workspace/.uf-worktrees/repo-1",
      (dir) => dir === "/workspace",
    );

    assert.deepEqual(dirs, ["/workspace/.uf-worktrees/repo-1", "/workspace"]);
  });

  it("walks to the root and stops there rather than looping on it", () => {
    const dirs = sandboxMountPointDirs("/a/b/c", () => true);

    assert.deepEqual(dirs, ["/a/b/c", "/a/b", "/a", "/"]);
  });

  it("never invents an ancestor for a working directory at the root", () => {
    assert.deepEqual(sandboxMountPointDirs("/", () => true), ["/", "/"]);
  });
});

/**
 * Covers which of the eleven root placeholders a sweep may take, and nothing
 * else in that module.
 *
 * It earns a test on the same grounds as its sibling above, with the stakes the
 * other way up. The sweep runs against the checkout an operator is about to
 * review, so being too eager deletes a file out of somebody's repository and
 * being too shy leaves the run handing back a tree holding eleven files no
 * agent wrote. Neither says anything at the time. The signature is the whole
 * containment argument — regular, empty, `0444`, which is what
 * `create_file(path, 0444)` leaves and what nothing a person edits looks like —
 * so it is the signature these cases are about.
 */

const stats = (
  over: { isFile?: boolean; size?: number; mode?: number } = {},
): PlaceholderStats => ({
  isFile: () => over.isFile ?? true,
  size: over.size ?? 0,
  mode: over.mode ?? 0o100444,
});

describe("isAbandonedMountPoint", () => {
  it("takes what bwrap leaves: a regular, empty, read-only file", () => {
    assert.equal(isAbandonedMountPoint(stats()), true);
  });

  it("leaves a file with anything in it, however it is spelled", () => {
    assert.equal(isAbandonedMountPoint(stats({ size: 1 })), false);
  });

  it("leaves a writable empty file, which nothing here made", () => {
    assert.equal(isAbandonedMountPoint(stats({ mode: 0o100644 })), false);
  });

  it("leaves a directory, which is what .idea and .vscode should be", () => {
    assert.equal(isAbandonedMountPoint(stats({ isFile: false, mode: 0o40444 })), false);
  });

  it("leaves a path that is not there", () => {
    assert.equal(isAbandonedMountPoint(null), false);
  });
});

describe("sweepAbandonedMountPoints", () => {
  it("removes every name the sandbox binds, and only under the given tree", () => {
    const removed: string[] = [];
    const swept = sweepAbandonedMountPoints(
      "/workspace/.uf-worktrees/repo-1",
      () => stats(),
      (target) => void removed.push(target),
    );

    assert.deepEqual(
      swept.removed,
      SANDBOX_TREE_ROOT_NAMES.map((name) => `/workspace/.uf-worktrees/repo-1/${name}`),
    );
    assert.deepEqual(removed, swept.removed);
    assert.deepEqual(swept.problems, []);
  });

  it("never unlinks a path whose signature is not bwrap's", () => {
    const removed: string[] = [];
    const swept = sweepAbandonedMountPoints(
      "/workspace/repo",
      // The shape of a checkout that keeps its own: a real `.gitconfig` with
      // content, and a `.vscode` directory.
      (target) =>
        target.endsWith(".gitconfig")
          ? stats({ size: 120 })
          : target.endsWith(".vscode")
            ? stats({ isFile: false, mode: 0o40755 })
            : null,
      (target) => void removed.push(target),
    );

    assert.deepEqual(removed, []);
    assert.deepEqual(swept.removed, []);
    assert.deepEqual(swept.problems, []);
  });

  it("records a mount a grandchild still holds, and sweeps the rest", () => {
    const swept = sweepAbandonedMountPoints(
      "/workspace/repo",
      () => stats(),
      (target) => {
        if (target.endsWith(".bashrc")) throw new Error("EBUSY: resource busy");
      },
    );

    assert.deepEqual(swept.problems, ["/workspace/repo/.bashrc: EBUSY: resource busy"]);
    assert.equal(swept.removed.length, SANDBOX_TREE_ROOT_NAMES.length - 1);
    assert.equal(swept.removed.includes("/workspace/repo/.bashrc"), false);
  });
});

/**
 * Covers the excludes body handed to a child's `core.excludesFile`, and nothing
 * else in that module.
 *
 * It earns a test because every way it can be wrong is silent and expensive. A
 * name missing from it puts the cycle back on `fatal: adding files failed`, in a
 * message naming a file the agent never touched, at the end of a run that has
 * work to commit — which is how a whole cycle's output is discarded with the
 * worktree. An entry that is *not* root-anchored is silent in the other
 * direction: a repository that tracks `docs/.gitconfig` would stop seeing a file
 * it has always tracked, and nothing in this app would ever say so.
 */

describe("SANDBOX_TREE_ROOT_EXCLUDES", () => {
  const lines = SANDBOX_TREE_ROOT_EXCLUDES.split("\n").filter(
    (line) => line !== "" && !line.startsWith("#"),
  );

  it("names every path the sandbox binds at the root of the checkout", () => {
    assert.deepEqual(lines, SANDBOX_TREE_ROOT_NAMES.map((name) => `/${name}`));
  });

  it("anchors every entry, so a nested file of the same name is still tracked", () => {
    for (const line of lines) {
      assert.equal(line.startsWith("/"), true, `${line} is not anchored`);
      // A second slash would anchor a path rather than a name, and there is no
      // path here to anchor: bwrap binds these at the top of the tree only.
      assert.equal(line.indexOf("/", 1), -1, `${line} names more than a root entry`);
    }
  });

  it("ends with a newline, which is what makes the last entry an entry", () => {
    assert.equal(SANDBOX_TREE_ROOT_EXCLUDES.endsWith("\n"), true);
  });

  it("says in the file itself what wrote it and why", () => {
    // Somebody will find this outside every repository with nothing to explain
    // it, and a file of bare paths would look like a mistake worth deleting.
    assert.equal(SANDBOX_TREE_ROOT_EXCLUDES.startsWith("#"), true);
    assert.equal(SANDBOX_TREE_ROOT_EXCLUDES.includes("UsageFoundry"), true);
  });
});
