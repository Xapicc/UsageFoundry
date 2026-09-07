import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_REMOTES_READ,
  folderKey,
  selectRemoteReads,
} from "./workspace";

/**
 * Covers which repositories a chat's `list_folders` can name, and only that.
 *
 * The cap this selects under is a spend of processes and is not going away, so
 * what has to hold is that it is a *page*: every repository must be reachable
 * by some call, and the ones a given call did not read must be nameable by the
 * caller rather than merely counted. Both halves fail silently and fail as the
 * same thing. A repository past the cap comes back with no `owner/name`, which
 * is byte-for-byte how a folder that is not on GitHub comes back — so the chat
 * says "I cannot identify that repository", for ever, for the same folders,
 * and an operator with twenty-six repositories reads a working one as broken.
 * Nothing throws and nothing is red; the only way to see it is to count what
 * the selection returns at the boundary.
 *
 * Pure, so it is asserted here rather than through `githubRemotes`, which forks
 * a git child per folder it selects.
 */

interface Folder {
  mountId: string;
  path: string;
  isGitRepo: boolean;
}

/** `n` git repositories in scan order, named so the order is readable. */
function repos(n: number, mountId = "w1"): Folder[] {
  return Array.from({ length: n }, (_, i) => ({
    mountId,
    path: `repo-${String(i + 1).padStart(2, "0")}`,
    isGitRepo: true,
  }));
}

describe("selectRemoteReads", () => {
  it("reads the cap and reports the remainder at the boundary", () => {
    const selection = selectRemoteReads(repos(MAX_REMOTES_READ + 1));

    assert.equal(selection.read.length, MAX_REMOTES_READ);
    assert.equal(selection.gitRepos, MAX_REMOTES_READ + 1);
    assert.equal(selection.matching, MAX_REMOTES_READ + 1);
    assert.equal(selection.offset, 0);
    assert.equal(selection.notRead, 1);
    assert.equal(selection.read[0].path, "repo-01");
    assert.equal(
      selection.read[MAX_REMOTES_READ - 1].path,
      `repo-${MAX_REMOTES_READ}`,
    );
  });

  it("reaches the repository past the cap by offset", () => {
    const all = repos(MAX_REMOTES_READ + 1);
    const first = selectRemoteReads(all);
    const rest = selectRemoteReads(all, { offset: first.read.length });

    assert.deepEqual(
      rest.read.map((f) => f.path),
      [`repo-${MAX_REMOTES_READ + 1}`],
    );
    assert.equal(rest.matching, MAX_REMOTES_READ + 1);
    assert.equal(rest.offset, MAX_REMOTES_READ);
    // Everything not on this page, the earlier page included — the caller pairs
    // it with `offset` and `matching`, which say which side of the page it is.
    assert.equal(rest.notRead, MAX_REMOTES_READ);

    // The union of the two pages is every repository: no folder is unreachable
    // by any call, which is the whole property.
    assert.equal(
      new Set([...first.read, ...rest.read].map(folderKey)).size,
      MAX_REMOTES_READ + 1,
    );
  });

  it("does not spend the cap on folders that are not git repositories", () => {
    const folders: Folder[] = [
      ...repos(3),
      { mountId: "w1", path: "notes", isGitRepo: false },
      { mountId: "w1", path: "scratch", isGitRepo: false },
    ];
    const selection = selectRemoteReads(folders);

    assert.equal(selection.gitRepos, 3);
    assert.equal(selection.notRead, 0);
    assert.deepEqual(
      selection.read.map((f) => f.path),
      ["repo-01", "repo-02", "repo-03"],
    );
  });

  it("reads exactly the named folders, wherever they sit in the scan", () => {
    const all = repos(MAX_REMOTES_READ + 5);
    const selection = selectRemoteReads(all, {
      folders: ["w1:repo-30", "w1:repo-02"],
    });

    // Scan order, not the order they were asked in: the caller renders these
    // against the folder list, which is in scan order.
    assert.deepEqual(
      selection.read.map((f) => f.path),
      ["repo-02", "repo-30"],
    );
    assert.equal(selection.matching, 2);
    assert.equal(selection.notRead, 0);
    // Counted over the unfiltered scan, so a filter cannot hide how much it
    // excluded from the caller that would widen it.
    assert.equal(selection.gitRepos, MAX_REMOTES_READ + 5);
    assert.deepEqual(selection.unmatched, []);
  });

  it("names a key that matched nothing instead of reading nothing", () => {
    const selection = selectRemoteReads(repos(3), {
      folders: ["w1:repo-01", "w1:repo-99", "w2:repo-01"],
    });

    assert.deepEqual(
      selection.read.map((f) => f.path),
      ["repo-01"],
    );
    assert.deepEqual(selection.unmatched, ["w1:repo-99", "w2:repo-01"]);
  });

  it("clamps an offset past the end rather than returning nothing", () => {
    const selection = selectRemoteReads(repos(3), { offset: 99 });

    assert.equal(selection.offset, 2);
    assert.deepEqual(
      selection.read.map((f) => f.path),
      ["repo-03"],
    );
    assert.equal(selection.matching, 3);
  });

  it("treats an unreadable offset as the first page", () => {
    for (const offset of [Number.NaN, -4, 0.5]) {
      const selection = selectRemoteReads(repos(3), { offset });
      assert.equal(selection.offset, 0, `offset ${offset}`);
      assert.equal(selection.read.length, 3, `offset ${offset}`);
    }
  });
});
