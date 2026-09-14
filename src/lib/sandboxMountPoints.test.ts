import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { PlaceholderStats } from "./sandboxMountPoints";
import {
  SANDBOX_CONFIG_DIR_NAMES,
  SANDBOX_CONFIG_DIR_REFUSED,
  SANDBOX_MOUNT_POINT_NAMES,
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

/**
 * Covers the three lists against the CLI that is actually installed, and nothing
 * else in that module.
 *
 * This is the only test here that reads something outside the repository, and it
 * earns that because the lists are a transcription of another program's private
 * decision. Every other test above asks whether this module does what it says;
 * this one asks whether what it says is still true. Both ways of being wrong are
 * silent in the way that costs most: a name the CLI **adds** is a mount point
 * nobody creates, which is a dead tool call attributed to anything but a CLI
 * upgrade — 423 of them here between 2026-09-04 and 2026-09-13 — and a name the
 * CLI **drops** is this app writing an empty file into somebody's repository or
 * config directory for no reason at all, forever, with nothing to notice it.
 *
 * It reads the sandbox construction out of the shipped single-file binary the
 * same way the lists were first written, and deliberately anchors on string
 * literals rather than on minified identifiers wherever a literal will do: the
 * identifiers change every release and the literals are the CLI's own data. The
 * two identifiers it cannot avoid — the config-directory accessor and the set
 * that marks which entries are files — are *discovered* from a literal anchor
 * rather than written down. When the shape changes past recognising, the
 * extraction throws and this test fails saying so, which is the right answer:
 * somebody has to go and read it again.
 *
 * Skipped, loudly, only when there is no CLI to read. That is a checkout outside
 * the image rather than a defect, and `npm test` is meant to run in one.
 */

const CLI_PATH = (() => {
  const configured = process.env.CLAUDE_BIN;
  const candidates = [
    ...(configured ? [configured] : []),
    "/usr/local/bin/claude",
    "/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
  ];
  for (const candidate of candidates) {
    try {
      const resolved = fs.realpathSync(candidate);
      // A test-suite stub is a few hundred bytes of JavaScript; the real thing
      // is a ~200 MB Bun binary. Reading a stub would extract nothing and fail
      // for the wrong reason, so it counts as "no CLI" rather than as a defect.
      if (fs.statSync(resolved).size > 50_000_000) return resolved;
    } catch {
      continue;
    }
  }
  return null;
})();

const NO_CLI = CLI_PATH
  ? false
  : "no Claude Code binary on this machine, so there is nothing to pin against";

/** Every `"..."` in one array or set literal, in source order. */
function literals(source: string): string[] {
  return [...source.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
}

function must(pattern: RegExp, haystack: string, what: string): RegExpExecArray {
  const found = pattern.exec(haystack);
  if (found === null) {
    throw new Error(
      `could not find ${what} in ${path.basename(CLI_PATH ?? "")}. The CLI's ` +
        `sandbox construction has changed shape; re-read it and update ` +
        `sandboxMountPoints.ts rather than loosening this.`,
    );
  }
  return found;
}

/**
 * What the CLI binds, read out of it.
 *
 * `latin1` and not `utf8` deliberately: this is a binary holding compressed
 * sections either way, the literals are ASCII, and a lossy multi-byte decode
 * would silently move the offsets the anchors are found at.
 */
function bindLists(cli: string): {
  treeRoot: string[];
  configDirFiles: string[];
  configDirDirs: string[];
} {
  const src = fs.readFileSync(cli, "latin1");

  // Two arrays declared together, and matched together for exactly that reason:
  // the dotfiles bound as files and the three directories beside them, of which
  // `.git` is filtered back out by the CLI itself. Anchoring on the pair rather
  // than on `.ripgreprc` alone matters — the CLI carries a second, much longer
  // array of project configuration files that also names it, and matching that
  // one instead reads 38 names off a list the sandbox never binds.
  const rootPair = must(
    /\[("\.gitconfig","\.gitmodules"[^\]]*)\],\w+=\[("\.git","\.vscode","\.idea")\]/,
    src,
    "the tree-root bind lists",
  );
  const rootFiles = literals(rootPair[1]);
  const rootDirs = literals(rootPair[2]);

  // The config directory's main list, and the accessor that turns a name in it
  // into a path. Both anchored on the list's own first two entries.
  const main = must(
    /for\(let (\w+) of(\["shell-snapshots","session-env"[^\]]*\])\)\{let \w+=\w+\(tl\((\w+)\(\),\1\)\)/,
    src,
    "the config-directory bind loop",
  );
  const configDir = main[3];

  // Which of the main list's entries are files. The rest take the CLI's
  // directory form, which on Windows is the same path with a trailing separator.
  const fileSet = new Set(
    literals(must(/new Set\(\["scheduled_tasks\.json"[^\]]*\]/, src, "the config-directory file set")[0]),
  );
  // The two signature names are spliced into both lists as template literals, so
  // they are read from the functions that build them rather than from the array.
  const suffixes = ["\\.signature\\.json", "\\.signature-iat\\.json"].map(
    (suffix) =>
      must(
        new RegExp(`function \\w+\\(\\w+\\)\\{return\`\\$\\{\\w+\\}(${suffix})\``),
        src,
        `the ${suffix.replace(/\\/g, "")} suffix`,
      )[1],
  );
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const name of literals(main[2])) {
    (fileSet.has(name) ? files : dirs).add(name);
    if (name === "policy-limits.json") for (const s of suffixes) files.add(name + s);
  }

  // Everything the CLI binds one name at a time rather than through that list.
  // Its binder takes the directory flag third, so the *call* is what says which
  // of the two a name is — and `SN(...)`, the trailing-separator wrapper, says
  // the same thing at the one site that pushes a path straight on.
  //
  // The call and not merely the path expression: `tl(cfg(),"plugins")` also
  // appears on the right of a `!==` deciding whether a plugin root was
  // redirected, and reading that as a bind puts `plugins` on both lists at once.
  // Hence four shapes, and a name matching none of them is left out rather than
  // guessed — it then fails the accounting assertion, which is where a reader
  // should find out that the CLI grew a fifth.
  const DIRECTORY_FLAG = String.raw`,\s*![01](,\s*!0)`;
  for (const found of src.matchAll(new RegExp(`tl\\(${configDir}\\(\\),"([^"]+)"\\)`, "g"))) {
    const name = found[1];
    const head = src.slice(Math.max(0, found.index - 48), found.index);
    const tail = src.slice(found.index + found[0].length, found.index + found[0].length + 400);

    // `SN(tl(…))` — pushed on as a path, in the CLI's directory spelling.
    if (head.endsWith("SN(")) {
      dirs.add(name);
      continue;
    }
    // `binder(tl(…), !x)` and `binder(tl(…), !x, !0)`.
    if (/\w+\($/.test(head)) {
      const direct = new RegExp(`^(?:${DIRECTORY_FLAG}?)\\)`).exec(tail);
      if (direct) {
        (direct[1] === undefined ? files : dirs).add(name);
        continue;
      }
    }
    // `v=tl(…)` first, bound a few statements later.
    const assigned = /(?:^|[,;{(\s])(\w+)=$/.exec(head);
    if (assigned) {
      const via = new RegExp(`\\w+\\(${assigned[1]}${DIRECTORY_FLAG}?\\)`).exec(tail);
      if (via) {
        (via[1] === undefined ? files : dirs).add(name);
        continue;
      }
    }
    // One of several paths collected into a set and bound in the loop's body.
    const iterated = new RegExp(String.raw`for\(let (\w+) of new Set\(\[$`).exec(head);
    if (iterated) {
      const via = new RegExp(`\\w+\\(${iterated[1]}${DIRECTORY_FLAG}?\\)`).exec(tail);
      if (via) (via[1] === undefined ? files : dirs).add(name);
    }
  }
  // …and the loops over a literal list of names, which carry the same flag once
  // for every name in them.
  const grouped = new RegExp(
    `for\\(let (\\w+) of(\\[(?:"[^"]*",)*"[^"]*"\\])\\)\\s*\\w+\\(tl\\(${configDir}\\(\\),\\1\\)${DIRECTORY_FLAG}?\\)`,
    "g",
  );
  for (const loop of src.matchAll(grouped)) {
    for (const name of literals(loop[2])) (loop[3] === undefined ? files : dirs).add(name);
  }
  // The two policy documents each have their signature pair bound beside them.
  for (const document of ["policy-limits.json", "remote-settings.json"]) {
    if (files.has(document)) for (const s of suffixes) files.add(document + s);
  }

  return {
    treeRoot: [...rootFiles, ...rootDirs.filter((name) => name !== ".git")].sort(),
    configDirFiles: [...files].sort(),
    configDirDirs: [...dirs].sort(),
  };
}

describe("the lists against the installed CLI", { skip: NO_CLI }, () => {
  const bound = bindLists(CLI_PATH ?? "");

  it("names every path the sandbox binds at the root of the checkout", () => {
    assert.deepEqual([...SANDBOX_TREE_ROOT_NAMES].sort(), bound.treeRoot);
  });

  it("accounts for every name the sandbox binds in the config directory", () => {
    // One or the other, never both and never neither: a name in neither is a
    // mount point nobody decided about, which is the dead tool call this exists
    // to turn into a failing test.
    assert.deepEqual(
      [...SANDBOX_CONFIG_DIR_NAMES, ...SANDBOX_CONFIG_DIR_REFUSED].sort(),
      [...bound.configDirFiles, ...bound.configDirDirs].sort(),
    );
    assert.deepEqual(
      SANDBOX_CONFIG_DIR_NAMES.filter((name) => SANDBOX_CONFIG_DIR_REFUSED.includes(name)),
      [],
    );
  });

  it("creates nothing the CLI wants as a directory", () => {
    // The harm the `.claude` list already names, one directory over: an empty
    // file at `projects` or `plugins` is the operator's own tree gone.
    assert.deepEqual(
      SANDBOX_CONFIG_DIR_NAMES.filter((name) => bound.configDirDirs.includes(name)),
      [],
    );
  });

  it("refuses only the three files it gives a reason for", () => {
    // Every other refusal must be a directory. A file quietly joining this list
    // is a failure left in place with the docblock's reasoning no longer
    // covering it.
    assert.deepEqual(
      SANDBOX_CONFIG_DIR_REFUSED.filter((name) => bound.configDirFiles.includes(name)),
      ["CLAUDE.md", "policy-limits.json", "remote-settings.json"],
    );
  });

  it("keeps the two lists apart: no config-directory name is a .claude name", () => {
    // They overlap by name — `scheduled_tasks.json` and `loop.md` are on both —
    // and they are bound in different places for different reasons. Asserted so
    // that a future edit does not merge them on the strength of the overlap.
    assert.equal(SANDBOX_MOUNT_POINT_NAMES.includes("policy-limits.json"), false);
    assert.equal(SANDBOX_CONFIG_DIR_NAMES.includes("settings.json"), false);
  });
});
