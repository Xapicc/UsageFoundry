import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

/**
 * Covers which repository admission files a run under, as `repoSpend` reads it.
 *
 * `repoSpend.test.ts` pins the grouping with every input injected; this pins the
 * input. The grouping was right and the card still filed most of a repository's
 * money under "(not a repository)", because it grouped on `runs.repo_root`, and
 * that column is written only when a run got a checkout of its own. A run with
 * isolation off, one in a repository that is the mount root, and one in a
 * monorepo's package are all in a git repository and none of them gets a
 * checkout — so on a single-repository mount every run went in the bucket, and
 * nothing looked wrong: a plausible table that adds up to the right total.
 *
 * It admits through the real `createRun` against real repositories because the
 * defect was in what admission recorded, which nothing pure reaches. It also
 * holds `repo_root` to null for those runs, since `land.ts`, `checkoutClaim.ts`,
 * the merge queue and the sandbox all read that column as "the repository a
 * checkout was cut from". `maxConcurrentRuns: 0` and an unspawnable `CLAUDE_BIN`
 * keep anything from starting; the environment is set before anything is
 * required, for `config.ts`'s reason.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-repospend-")));
const main = path.join(tmp, "main");
const solo = path.join(tmp, "solo");
for (const dir of [main, solo, path.join(tmp, "claude", "projects")]) {
  fs.mkdirSync(dir, { recursive: true });
}

process.env.WORKSPACE_ROOTS = `Main=${main}|Solo=${solo}`;
process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
// Pinned rather than left to fall back to the ambient one: `planUsage` looks for
// an OAuth token in this directory, and a unit test must not send a request on
// the operator's own credential.
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");
process.env.CLAUDE_BIN = path.join(tmp, "no-such-claude");

// `require`, not `import`: imports are hoisted above the environment above, and
// these modules read `WORKSPACE_ROOTS` and `DATA_DIR` once at load.
const config = require("./config") as typeof import("./config");
assert.equal(
  config.DATA_DIR,
  process.env.DATA_DIR,
  "config was already loaded by another test file in this process — refusing to run against the real database",
);

const { createRun } = require("./orchestrator") as typeof import("./orchestrator");
const { saveSettings } = require("./settings") as typeof import("./settings");
const { repoSpend, NO_REPOSITORY_LABEL } = require("./repoSpend") as typeof import("./repoSpend");
const { db } = require("./db") as typeof import("./db");

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fixtureGit(cwd: string, args: string[]): void {
  execFileSync(
    "git",
    ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", ...args],
    { cwd, stdio: "ignore" },
  );
}

function makeRepo(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fixtureGit(dir, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(dir, "README.md"), "seed\n");
  fixtureGit(dir, ["add", "-A"]);
  fixtureGit(dir, ["commit", "-q", "-m", "seed"]);
}

makeRepo(path.join(main, "app"));
makeRepo(path.join(main, "mono"));
fs.mkdirSync(path.join(main, "mono", "packages", "web"), { recursive: true });
// A single-repository mount: the repository is the mount root, so there is no
// "beside" for a checkout store and no run here is ever isolated.
makeRepo(solo);
fs.mkdirSync(path.join(main, "notes"), { recursive: true });

interface Admitted {
  id: string;
  isolation: string | null;
  repo_root: string | null;
}

/** Admit a run as the form would and charge it `usd`, as its cycles would have. */
function admit(folder: string, mountId: string, isolate: boolean, usd: number): Admitted {
  const run = createRun({
    folder,
    mountId,
    isolate,
    prompt: "measure where its spend is filed",
    budget: { maxIterations: 1 },
    origin: "form",
  });
  db().prepare("UPDATE runs SET spent_usd = ? WHERE id = ?").run(usd, run.id);
  return db()
    .prepare("SELECT id, isolation, repo_root FROM runs WHERE id = ?")
    .get(run.id) as Admitted;
}

describe("repository spend, as admission records it", () => {
  saveSettings({ maxConcurrentRuns: 0 });

  it("files a run in a git repository under it, with a checkout or without", () => {
    db().prepare("DELETE FROM runs").run();
    const isolated = admit("app", "main", true, 3);
    const isolationOff = admit("app", "main", false, 5);
    const mountRoot = admit(".", "solo", true, 7);
    const subfolder = admit("mono/packages/web", "main", true, 11);
    const plainFolder = admit("notes", "main", true, 13);

    // The control, so the cases below are known to have reached the plan they
    // are about rather than some other refusal.
    assert.equal(isolated.isolation, "worktree");
    for (const run of [isolationOff, mountRoot, subfolder, plainFolder]) {
      assert.equal(run.isolation, "none");
      assert.equal(run.repo_root, null, "repo_root names a checkout's source, and these have none");
    }

    const rows = repoSpend(0).rows;
    const spentBy = Object.fromEntries(rows.map((r) => [r.label, r.spentUSD]));
    assert.deepEqual(spentBy, {
      app: 8,
      mono: 11,
      Solo: 7,
      [NO_REPOSITORY_LABEL]: 13,
    });
  });

  it("keeps filing a checkout's run under its repository on a row from before the column", () => {
    db().prepare("DELETE FROM runs").run();
    const isolated = admit("app", "main", true, 3);
    db().prepare("UPDATE runs SET folder_repo = NULL WHERE id = ?").run(isolated.id);

    const rows = repoSpend(0).rows;
    assert.deepEqual(
      rows.map((r) => [r.label, r.spentUSD]),
      [["app", 3]],
    );
  });
});
