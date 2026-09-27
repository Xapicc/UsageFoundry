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
 * identifiers it cannot avoid (the path join, the config-directory accessor,
 * the set that marks which entries are files, the directory spelling and the
 * functions naming a policy file's sidecars) are all *discovered* from the one
 * statement that binds the main list rather than written down. Two of them used
 * to be written down, which is why 2.1.280, renaming every one, failed this at
 * the extraction rather than at the name it added. When the shape changes past
 * recognising, the extraction throws and this test fails saying so, which is
 * the right answer: somebody has to go and read it again.
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
 * The bundle module a match sits in.
 *
 * The CLI is a Bun bundle of a few hundred modules, each opening with a
 * `// @bun` header, and the minifier names identifiers per module: at 2.1.280
 * `nt` is `path.resolve` in the sandbox module and something else in the next
 * one. A pattern built from identifiers discovered in one module therefore only
 * means something inside it. Without the header the scope is the whole binary,
 * which is what this read before 2.1.280; a wider scope can only add matches,
 * and a name added that way fails the accounting assertion rather than passing.
 */
function moduleAround(src: string, index: number): string {
  const start = src.lastIndexOf("// @bun", index);
  const end = src.indexOf("// @bun", index);
  return src.slice(start === -1 ? 0 : start, end === -1 ? src.length : end);
}

/** The `{…}` block opening at `open`. The loop bodies read with it hold no string with a brace in it. */
function blockAt(src: string, open: number): string {
  let depth = 0;
  for (let at = open; at < src.length; at++) {
    if (src[at] === "{") depth++;
    else if (src[at] === "}" && --depth === 0) return src.slice(open, at + 1);
  }
  throw new Error(`no end to the block opening at offset ${open} of ${path.basename(CLI_PATH ?? "")}`);
}

/**
 * What one of the sidecar-naming functions appends to a policy file's path.
 *
 * Each is `function f(e){return`${e}.signature.json`}`, or since 2.1.280 the
 * same with the suffix in a constant of its own module (`${e}${Ee}` beside
 * `Ee=".stamp.json"`). A minified name can be defined in more than one module,
 * so every definition of that shape must agree, or this throws rather than
 * choosing between them.
 */
function sidecarSuffix(src: string, fn: string): string {
  const found = new Set<string>();
  const definition = new RegExp(`function ${fn}\\(\\w+\\)\\{return\`\\$\\{\\w+\\}(?:([^\`$]+)|\\$\\{(\\w+)\\})\`\\}`, "g");
  for (const def of src.matchAll(definition)) {
    if (def[1] !== undefined) {
      found.add(def[1]);
      continue;
    }
    const constant = new RegExp(`[,;\\s]${def[2]}="([^"]+)"`).exec(moduleAround(src, def.index));
    if (constant) found.add(constant[1]);
  }
  if (found.size !== 1) {
    throw new Error(
      `${fn} names a policy file's sidecar in ${path.basename(CLI_PATH ?? "")}, and ` +
        `${found.size === 0 ? "no definition of it was readable" : `its definitions disagree: ${[...found].join(", ")}`}.`,
    );
  }
  return [...found][0];
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

  // The config directory's main list, and the statement around it, which is
  // matched whole because every identifier the rest needs is read off it: the
  // sidecar list spread into it, the set marking its files, the path join, the
  // config-directory accessor and the directory spelling. Anchored on the
  // literals, and on the loop's own shape, `name → path → file ? path :
  // dir(path)`, which is the decision this test transcribes.
  const main = must(
    new RegExp(
      String.raw`(?<sidecars>\w+)=\[(?<sidecarCalls>(?:\w+\("policy-limits\.json"\),?)+)\],` +
        String.raw`(?<fileSet>\w+)=new Set\((?<fileSetBody>\["scheduled_tasks\.json"[^\]]*\])\);` +
        String.raw`for\(let (?<name>\w+) of(?<list>\["shell-snapshots","session-env"[^\]]*\])\)` +
        String.raw`\{let (?<path>\w+)=\w+\((?<join>\w+)\((?<configDir>\w+)\(\),\k<name>\)\);` +
        String.raw`\w+\.push\(\k<fileSet>\.has\(\k<name>\)\?\k<path>:(?<directory>\w+)\(\k<path>\)\)\}`,
    ),
    src,
    "the config-directory bind loop",
  );
  // Every group is outside any `?` or `|`, so a match has all of them.
  const { sidecars, sidecarCalls, fileSetBody, list, join, configDir, directory } =
    main.groups as Record<string, string>;
  const scope = moduleAround(src, main.index);

  // `policy-limits.json`'s sidecars: one call per suffix, spread into both the
  // list and the file set. Any other spread is contents this does not know.
  const suffixOf = new Map(
    [...sidecarCalls.matchAll(/(\w+)\("policy-limits\.json"\)/g)].map((call) => [
      call[1],
      sidecarSuffix(src, call[1]),
    ]),
  );
  const expand = (array: string): string[] => {
    const names = literals(array);
    for (const spread of array.matchAll(/\.\.\.(\w+)/g)) {
      if (spread[1] !== sidecars) {
        throw new Error(`the config-directory list spreads ${spread[1]}, which this does not model`);
      }
      for (const suffix of suffixOf.values()) names.push(`policy-limits.json${suffix}`);
    }
    return names;
  };
  const fileSet = new Set(expand(fileSetBody));
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const name of expand(list)) (fileSet.has(name) ? files : dirs).add(name);

  // Everything the CLI binds one name at a time rather than through that list.
  // Its binder takes the directory flag third, so the *call* is what says which
  // of the two a name is, and the directory spelling, wrapped round a path
  // pushed straight on, says the same thing at the one site that does that.
  //
  // The call and not merely the path expression: `join(cfg(),"plugins")` also
  // appears on the right of a `!==` deciding whether a plugin root was
  // redirected, and reading that as a bind puts `plugins` on both lists at once.
  // Hence four shapes, and a name matching none of them is left out rather than
  // guessed — it then fails the accounting assertion, which is where a reader
  // should find out that the CLI grew a fifth.
  const DIRECTORY_FLAG = String.raw`,\s*![01](,\s*!0)`;
  for (const found of scope.matchAll(new RegExp(`${join}\\(${configDir}\\(\\),"([^"]+)"\\)`, "g"))) {
    const name = found[1];
    const head = scope.slice(Math.max(0, found.index - 48), found.index);
    const tail = scope.slice(found.index + found[0].length, found.index + found[0].length + 400);

    // `directory(join(…))`: pushed on as a path, in the CLI's directory spelling.
    if (head.endsWith(`${directory}(`)) {
      dirs.add(name);
      continue;
    }
    // `binder(join(…), !x)` and `binder(join(…), !x, !0)`.
    if (/\w+\($/.test(head)) {
      const direct = new RegExp(`^(?:${DIRECTORY_FLAG}?)\\)`).exec(tail);
      if (direct) {
        (direct[1] === undefined ? files : dirs).add(name);
        continue;
      }
    }
    // `v=join(…)` first, bound a few statements later.
    const assigned = /(?:^|[,;{(\s])(\w+)=$/.exec(head);
    if (assigned) {
      const via = new RegExp(`\\w+\\(${assigned[1]}${DIRECTORY_FLAG}?\\)`).exec(tail);
      if (via) {
        (via[1] === undefined ? files : dirs).add(name);
        continue;
      }
    }
    // One of several paths collected into a set and bound in the loop's body,
    // which is also where `remote-settings.json` gets its sidecars. They are
    // read off the body's own calls rather than assumed to be those of
    // `policy-limits.json`, because at 2.1.280 they are not: it takes two of
    // the three.
    const iterated = new RegExp(String.raw`for\(let (\w+) of new Set\(\[$`).exec(head);
    if (iterated) {
      const body = blockAt(scope, scope.indexOf("{", found.index));
      const via = new RegExp(`\\w+\\(${iterated[1]}${DIRECTORY_FLAG}?\\)`).exec(body);
      if (via) (via[1] === undefined ? files : dirs).add(name);
      for (const bound of body.matchAll(new RegExp(`\\w+\\((\\w+)\\(${iterated[1]}\\)${DIRECTORY_FLAG}?\\)`, "g"))) {
        const suffix = suffixOf.get(bound[1]) ?? sidecarSuffix(src, bound[1]);
        (bound[2] === undefined ? files : dirs).add(name + suffix);
      }
    }
  }
  // …and the loops over a literal list of names, which carry the same flag once
  // for every name in them.
  const grouped = new RegExp(
    `for\\(let (\\w+) of(\\[(?:"[^"]*",)*"[^"]*"\\])\\)\\s*\\w+\\(${join}\\(${configDir}\\(\\),\\1\\)${DIRECTORY_FLAG}?\\)`,
    "g",
  );
  for (const loop of scope.matchAll(grouped)) {
    for (const name of literals(loop[2])) (loop[3] === undefined ? files : dirs).add(name);
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

  it("refuses only the four files it gives a reason for", () => {
    // Every other refusal must be a directory. A file quietly joining this list
    // is a failure left in place with the docblock's reasoning no longer
    // covering it.
    assert.deepEqual(
      SANDBOX_CONFIG_DIR_REFUSED.filter((name) => bound.configDirFiles.includes(name)),
      ["CLAUDE.md", "policy-limits.json", "policy-limits.json.stamp.json", "remote-settings.json"],
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
