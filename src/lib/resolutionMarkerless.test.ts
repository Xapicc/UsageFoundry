import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { ReviewRow } from "./review";

/**
 * What a conflict resolution does with a conflict git left no markers in.
 *
 * `after` accepts the resolver's work when no conflicted file still holds a
 * `<<<<<<< `/`>>>>>>> ` line, and that is evidence only about a file git wrote
 * markers into. A binary clash leaves the branch's bytes whole, and a
 * modify/delete or rename/delete leaves the surviving version whole, so the
 * check passed before the resolver had done anything — and it can do nothing
 * about either, since it edits text and may not run git. The app staged the
 * untouched files, committed the merge, recorded the resolution `completed`,
 * and Land fast-forwarded the target onto it: the target's own binary edit, or
 * its deletion, was undone on the target under an ordinary "Merged" message.
 * The merge queue's auto-resolve did the same with nobody present.
 *
 * Driven end to end for `resolutionBudget.test.ts`'s reason: the defect is in
 * what git leaves in a real checkout and what `after` concludes from it, and a
 * fixture stating git's output would be stating the very thing in question. A
 * real repository, `resolveConflicts` asked as the Resolve button asks it, a
 * stand-in `claude` that settles only `a.txt`'s markers, and then Land.
 *
 * Its own file, with `DATA_DIR` named before the first import, for
 * `loopMergeOwnership.test.ts`'s reason.
 */

let land: typeof import("./land");
let review: typeof import("./review");
let mergeQueue: typeof import("./mergeQueue");
let dbMod: typeof import("./db");
let root: string;

const MOUNT_DIR = "resolution-markerless-mount";
const repoRoot = () => path.join(root, MOUNT_DIR, "repo");
const spawnedFile = () => path.join(root, "claude-spawned");

const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: repoRoot(),
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();

/**
 * A `claude` that says it is done, having settled `a.txt`'s markers if it has
 * any and touched nothing else.
 *
 * So in every case but the content one it has edited nothing, which is the
 * resolver the defect needs: it cannot write a binary file's other bytes, and
 * cannot delete a file. It writes down that it was spawned, because a
 * resolution refused before the spawn is one nobody paid for.
 */
function writeStub(dir: string): string {
  const stub = path.join(dir, "claude-stub.js");
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(spawnedFile())}, process.cwd());
if (fs.existsSync("a.txt") && /^<<<<<<< /m.test(fs.readFileSync("a.txt", "utf8"))) {
  fs.writeFileSync("a.txt", "resolved\\n");
}
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "I cannot edit it, so I left it.", total_cost_usd: 0.42 }) + "\\n");
`,
    { mode: 0o755 },
  );
  return stub;
}

before(async () => {
  // `realpathSync`, which `resolveInMount` checks containment against.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-resolve-markerless-")));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  // `planUsage` looks for an OAuth token here, and a unit test must not send a
  // request on the operator's own credential.
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, MOUNT_DIR);
  process.env.WORKSPACE_ROOTS = "";
  process.env.CLAUDE_BIN = writeStub(root);
  fs.mkdirSync(path.join(root, "claude", "projects"), { recursive: true });

  fs.mkdirSync(repoRoot(), { recursive: true });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repoRoot(), "a.txt"), "one\n");
  // A NUL is what makes git call it binary and decline to merge it as text.
  fs.writeFileSync(path.join(repoRoot(), "logo.png"), Buffer.from([0x89, 0x50, 0, 1, 2]));
  fs.writeFileSync(path.join(repoRoot(), "old.txt"), "old\n");
  fs.writeFileSync(path.join(repoRoot(), "r.txt"), "r1\nr2\nr3\n");
  git("add", "-A");
  git("commit", "-q", "-m", "first");

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );
  assert.equal(config.CLAUDE_BIN, process.env.CLAUDE_BIN);

  dbMod = await import("./db");
  review = await import("./review");
  land = await import("./land");
  mergeQueue = await import("./mergeQueue");
});

after(() => {
  const open = (globalThis as { __ufDb?: { close(): void } }).__ufDb;
  open?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A finished run on `branch`, which `onBranch` changed one way and `onMain`
 * changed `main` another, each as one commit.
 */
function conflictingRun(branch: string, onBranch: () => void, onMain: () => void): string {
  const base = git("rev-parse", "main");
  git("checkout", "-q", "-b", branch, "main");
  onBranch();
  git("add", "-A");
  git("commit", "-q", "-m", `work on ${branch}`);
  git("checkout", "-q", "main");
  onMain();
  git("add", "-A");
  git("commit", "-q", "-m", `main moves under ${branch}`);

  const runId = `run-${Math.random().toString(36).slice(2, 10)}`;
  dbMod
    .db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                         created_at, finished_at, isolation, repo_root, worktree_branch,
                         worktree_base, worktree_base_branch)
       VALUES (?, ?, 'change things', 'completed', '{}', 1, 1, ?, ?, 'worktree', ?, ?, ?, 'main')`,
    )
    .run(runId, repoRoot(), Date.now(), Date.now(), repoRoot(), branch, base);
  return runId;
}

const write = (file: string, content: string | Buffer) => () =>
  fs.writeFileSync(path.join(repoRoot(), file), content);

/** Whether `file` is in `ref`'s tree. */
const existsOn = (ref: string, file: string) =>
  git("ls-tree", "--name-only", ref, "--", file) !== "";

/** Resolve as the button does, and wait for whatever it spawned to settle. */
async function resolveAndSettle(
  runId: string,
): Promise<{ reason: string | null; row: ReviewRow | null }> {
  fs.rmSync(spawnedFile(), { force: true });
  const started = await land.resolveConflicts(runId, null);
  if (!started.ok) return { reason: started.reason, row: null };
  const assistId = started.assistId;
  assert.ok(assistId, "the merge went through with no conflict, which the fixture should not allow");

  const deadline = Date.now() + 30_000;
  while (review.getAssist(assistId)?.status === "running") {
    assert.ok(Date.now() < deadline, "the resolution never settled");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { reason: null, row: review.getAssist(assistId) };
}

/**
 * The four things every marker-less case must leave true: nothing recorded as
 * resolved, nothing spent, the branch where it was, and a refusal naming the
 * path. Land is then pressed by the caller, which is where the target was lost.
 */
async function assertRefused(runId: string, branch: string, conflicted: string) {
  const tipBefore = git("rev-parse", branch);
  const { reason, row } = await resolveAndSettle(runId);

  assert.notEqual(
    row?.status,
    "completed",
    `a resolver that edited nothing was recorded as having resolved ${conflicted}`,
  );
  assert.equal(fs.existsSync(spawnedFile()), false, "a resolver was paid for a conflict it cannot settle");
  assert.equal(git("rev-parse", branch), tipBefore, `${branch} moved`);
  assert.ok(reason, "no refusal was given");
  assert.match(reason, new RegExp(conflicted.replace(".", "\\.")));
  // The queue fails this row and still tries the next branch's resolution:
  // the refusal is about this branch's conflict, not the operator's limits.
  assert.equal(mergeQueue.refusesEveryLaterResolution(reason), false);
  return reason;
}

describe("a conflict git left no markers in", () => {
  it("is refused for a binary clash, and Land then leaves main's file alone", async () => {
    const runId = conflictingRun(
      "uf/bin",
      write("logo.png", Buffer.from([0x89, 0x50, 0, 0xb, 0xb])),
      write("logo.png", Buffer.from([0x89, 0x50, 0, 0xa, 0xa])),
    );
    const mainLogo = git("rev-parse", "main:logo.png");

    const reason = await assertRefused(runId, "uf/bin", "logo.png");
    assert.match(reason, /Cannot merge binary files/, "git's own words are not in the refusal");

    const landed = await land.landRun(runId, "merge", null);
    assert.equal(landed.ok, false, "Land went ahead over the conflict");
    assert.equal(git("rev-parse", "main:logo.png"), mainLogo, "main's logo.png was replaced");
  });

  it("is refused for a modify/delete, and Land leaves the file deleted on main", async () => {
    const runId = conflictingRun("uf/md", write("old.txt", "old, edited on the branch\n"), () =>
      git("rm", "-q", "old.txt"),
    );

    const reason = await assertRefused(runId, "uf/md", "old.txt");
    assert.match(reason, /CONFLICT \(modify\/delete\)/, "git's own words are not in the refusal");

    const landed = await land.landRun(runId, "merge", null);
    assert.equal(landed.ok, false, "Land went ahead over the conflict");
    assert.equal(existsOn("main", "old.txt"), false, "main's deletion of old.txt was undone");
  });

  it("is refused for a rename/delete, and Land leaves the file deleted on main", async () => {
    const runId = conflictingRun(
      "uf/rd",
      () => git("mv", "r.txt", "r2.txt"),
      () => git("rm", "-q", "r.txt"),
    );

    await assertRefused(runId, "uf/rd", "r2.txt");

    const landed = await land.landRun(runId, "merge", null);
    assert.equal(landed.ok, false, "Land went ahead over the conflict");
    assert.equal(existsOn("main", "r.txt"), false, "main's deletion of r.txt was undone");
    assert.equal(existsOn("main", "r2.txt"), false, "the branch's rename of a file main deleted landed");
  });
});

describe("a conflict git left markers in", () => {
  // The control: the refusal above must not reach a clash the resolver can
  // settle. It passed before the fix and has to go on passing.
  it("is still committed once the resolver has removed them", async () => {
    const runId = conflictingRun("uf/text", write("a.txt", "branch\n"), write("a.txt", "main\n"));
    const tipBefore = git("rev-parse", "uf/text");

    const { reason, row } = await resolveAndSettle(runId);
    assert.equal(reason, null);
    assert.equal(row?.status, "completed", row?.error ?? "");
    assert.equal(fs.existsSync(spawnedFile()), true);

    const tip = git("rev-parse", "uf/text");
    assert.notEqual(tip, tipBefore);
    assert.equal(row?.resolved_commit, tip);
    assert.equal(git("show", "uf/text:a.txt"), "resolved");
    // `main` is now an ancestor, so the land that follows is a fast-forward.
    git("merge-base", "--is-ancestor", "main", "uf/text");
  });
});

describe("unsettleableByEditing", () => {
  const conflict = "<<<<<<< HEAD\nb\n=======\nm\n>>>>>>> main\n";
  const asked = (stages: number[], text: string | null) =>
    land.unsettleableByEditing({ stages: new Set(stages), text }, "uf/x", "main");

  it("lets through only a path both sides have and git wrote markers into", () => {
    assert.equal(asked([1, 2, 3], conflict), null);
    // An add/add has no base and is still a text merge.
    assert.equal(asked([2, 3], conflict), null);
  });

  // The cases the end-to-end ones above do not reach: the branch deleted what
  // the target changed, a file that cannot be read, and a surviving version
  // that holds marker-shaped lines of its own, which no edit makes a decision
  // about the side that has none.
  it("refuses whichever side is missing, whatever the surviving file holds", () => {
    assert.match(asked([1, 3], "kept\n") ?? "", /^uf\/x has no version/);
    assert.match(asked([1, 2], conflict) ?? "", /^main has no version/);
    assert.match(asked([1, 3], conflict) ?? "", /^uf\/x has no version/);
  });

  it("refuses a both-sides path with no markers or no readable file", () => {
    assert.notEqual(asked([1, 2, 3], "the branch's bytes\n"), null);
    assert.notEqual(asked([1, 2, 3], null), null);
    assert.notEqual(asked([1], conflict), null);
  });
});
