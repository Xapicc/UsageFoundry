import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

/**
 * Covers a repository that is its mount's root, whose checkout store
 * `<mount>/.uf-worktrees` is therefore inside the working tree it serves.
 *
 * Every failure here is silent. Refused, the repository's runs work in the
 * operator's own checkout one at a time, which reads as a scheduling note.
 * Admitted without the repository ignoring the store, the operator's
 * `git status` holds a full copy of the repository per slot. Admitted, it puts
 * live slots under the folder Land merges into, so every land in the
 * repository waits for every isolated run; a slot that lost its `.git` file
 * resolves to the operator's checkout, so a git read meant for the slot answers
 * for the operator's branch; and the run's file history counts another run's
 * slot as its own tree.
 *
 * The store is just as much inside a mount-root repository when the run is on a
 * repository *nested* below it, and there the failure is the same silent one
 * seen from the other side: the outer repository's `git status` lists every
 * slot, and Land of an outer-repository run is refused as dirty.
 *
 * Its own file because it needs mounts that are repositories, which
 * `orchestrator.test.ts`'s fixed layout is not, and a global git config of its
 * own. `DATA_DIR`, `CLAUDE_HOME` and `GIT_CONFIG_GLOBAL` are set before anything
 * is required, for `config.ts`'s reason; `maxConcurrentRuns: 0` and an
 * unspawnable `CLAUDE_BIN` keep anything from starting.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-mountroot-")));
const vault = path.join(tmp, "vault");
const plain = path.join(tmp, "plain");
const globalOnly = path.join(tmp, "global");
const notes = path.join(tmp, "notes");
// A mount root that is a repository with a repository nested below it, once with
// and once without a rule for the store.
const outer = path.join(tmp, "outer");
const covered = path.join(tmp, "covered");
// A mount root that is not a repository, inside one that is, and a mount root
// whose `.git` git cannot use.
const aboveRepo = path.join(tmp, "above");
const aboveMount = path.join(aboveRepo, "mount");
const broken = path.join(tmp, "broken");
for (const dir of [vault, plain, globalOnly, notes, path.join(tmp, "claude", "projects")]) {
  fs.mkdirSync(dir, { recursive: true });
}

// An excludes file that ignores the store, read only through this process's
// global config: the container's own git would honour it, the operator's git on
// the host would not.
const globalExcludes = path.join(tmp, "global-excludes");
fs.writeFileSync(globalExcludes, ".uf-worktrees/\n");
const globalConfig = path.join(tmp, "gitconfig");
fs.writeFileSync(globalConfig, `[core]\n\texcludesFile = ${globalExcludes}\n`);
process.env.GIT_CONFIG_GLOBAL = globalConfig;
// An agent's shell, which is where this suite is often run, carries config in
// the environment, `core.excludesFile` among it, and that outranks the global
// file above.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_CONFIG_") && key !== "GIT_CONFIG_GLOBAL") delete process.env[key];
}

process.env.WORKSPACE_ROOTS =
  `Vault=${vault}|Plain=${plain}|Global=${globalOnly}|Notes=${notes}|Outer=${outer}` +
  `|Covered=${covered}|Above=${aboveMount}|Broken=${broken}`;
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
  "config was already loaded by another test file in this process; refusing to run against the real database",
);

const { createRun, probeIsolation } = require("./orchestrator") as typeof import("./orchestrator");
const { checkoutHeld } = require("./land") as typeof import("./land");
const { gitSync } = require("./git") as typeof import("./git");
const { scanTouches } = require("./runTouchScan") as typeof import("./runTouchScan");
const { scanWorkspace } = require("./workspace") as typeof import("./workspace");
const { saveSettings } = require("./settings") as typeof import("./settings");
const { WORKTREE_STORE_DIR } = require("./worktreeStoreDir") as typeof import("./worktreeStoreDir");
const { db } = require("./db") as typeof import("./db");

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function fixtureGit(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
}

function makeRepo(dir: string, gitignore: string | null): void {
  fixtureGit(dir, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(dir, "README.md"), "seed\n");
  if (gitignore !== null) fs.writeFileSync(path.join(dir, ".gitignore"), gitignore);
  fixtureGit(dir, ["add", "-A"]);
  fixtureGit(dir, ["commit", "-q", "-m", "seed"]);
}

makeRepo(vault, `${WORKTREE_STORE_DIR}/\n`);
makeRepo(plain, null);
makeRepo(globalOnly, null);

// The outer repository is committed before the nested one exists, so the nested
// one is a plain untracked directory to it and not a gitlink in its history.
for (const [root, gitignore] of [
  [outer, null],
  [covered, `${WORKTREE_STORE_DIR}/\n`],
  [aboveRepo, null],
] as const) {
  fs.mkdirSync(root, { recursive: true });
  makeRepo(root, gitignore);
}
fs.mkdirSync(aboveMount, { recursive: true });
// What a checkout made on the host leaves under a container mount: a `.git` file
// naming a gitdir that is not there, which is a repository to the operator and
// not to git here.
fs.mkdirSync(broken, { recursive: true });
fs.writeFileSync(path.join(broken, ".git"), `gitdir: ${path.join(tmp, "no-such-gitdir")}\n`);
for (const root of [outer, covered, aboveMount, broken]) {
  const nested = path.join(root, "app");
  fs.mkdirSync(nested, { recursive: true });
  makeRepo(nested, null);
}

const store = path.join(vault, WORKTREE_STORE_DIR);

interface Admitted {
  id: string;
  isolation: string | null;
  worktree_path: string | null;
  work_dir: string | null;
}

/** Admit a run on a mount's root as the form would. */
function admitRoot(mountId: string, isolate: boolean): Admitted {
  const run = createRun({
    folder: ".",
    mountId,
    isolate,
    prompt: "work on the whole workspace",
    budget: { maxIterations: 1 },
    origin: "form",
  });
  return db()
    .prepare("SELECT id, isolation, worktree_path, work_dir FROM runs WHERE id = ?")
    .get(run.id) as Admitted;
}

describe("a repository at the mount root", () => {
  saveSettings({ maxConcurrentRuns: 0 });

  it("is isolated when its own .gitignore ignores the checkout store", () => {
    db().prepare("DELETE FROM runs").run();
    assert.equal(probeIsolation(vault).mode, "worktree");

    const run = admitRoot("vault", true);
    assert.equal(run.isolation, "worktree");
    assert.ok(run.worktree_path?.startsWith(`${store}/`), `slot ${run.worktree_path}`);
    assert.equal(run.work_dir, run.worktree_path, "the run works in its slot, not in the root");
  });

  it("is refused when it does not, and the reason names the line that would allow it", () => {
    const plan = probeIsolation(plain);
    assert.equal(plan.mode, "none");
    assert.match(plan.reason ?? "", /\.gitignore/);
    assert.ok(plan.reason?.includes(`"${WORKTREE_STORE_DIR}/"`), plan.reason);
    assert.ok(plan.reason?.includes(path.join(plain, ".gitignore")), plan.reason);
  });

  it("is refused when only this container's own excludes file ignores the store", () => {
    // The control: git as this process configures it does call the store
    // ignored, so the refusal below is the probe declining that answer.
    assert.equal(
      fixtureGit(globalOnly, ["check-ignore", "--", `${WORKTREE_STORE_DIR}/`]),
      `${WORKTREE_STORE_DIR}/`,
    );
    assert.equal(probeIsolation(globalOnly).mode, "none");
  });
});

describe("a repository nested below a mount root that is itself a repository", () => {
  it("is refused when the outer repository does not ignore the store, and the reason names its .gitignore", () => {
    const plan = probeIsolation(path.join(outer, "app"));
    assert.equal(plan.mode, "none");
    assert.equal(plan.repository, path.join(outer, "app"));
    assert.ok(plan.reason?.includes(path.join(outer, ".gitignore")), plan.reason);
    assert.ok(plan.reason?.includes(`"${WORKTREE_STORE_DIR}/"`), plan.reason);
  });

  it("is isolated when the outer repository ignores it", () => {
    const plan = probeIsolation(path.join(covered, "app"));
    assert.equal(plan.mode, "worktree");
    assert.equal(plan.repoRoot, path.join(covered, "app"));
  });

  it("is not asked about a repository above the mount root", () => {
    // The control: git run from the mount root does find a repository, the one
    // above it, and that repository does not ignore the store. A lookup that
    // asked git rather than the mount root itself would refuse here.
    assert.equal(fixtureGit(aboveMount, ["rev-parse", "--show-toplevel"]), aboveRepo);
    assert.equal(probeIsolation(path.join(aboveMount, "app")).mode, "worktree");
  });

  it("is not refused over a mount root whose .git git cannot use", () => {
    // The refusal's remedy is a line in a `.gitignore` that git here cannot read
    // either way, so refusing would be a refusal nothing the operator does here
    // clears.
    assert.equal(probeIsolation(path.join(broken, "app")).mode, "worktree");
  });
});

describe("git inside a store that is inside a repository", () => {
  it("never climbs out of a slot directory into the repository holding the store", () => {
    const slot = path.join(store, "by-hand-1");
    fixtureGit(vault, ["worktree", "add", "-q", "--detach", slot, "HEAD"]);
    const orphan = path.join(store, "orphan-1", "notes");
    fs.mkdirSync(orphan, { recursive: true });

    const fromSlot = gitSync(slot, ["rev-parse", "--show-toplevel"]);
    assert.equal(fromSlot.ok, true);
    assert.equal(fromSlot.stdout, slot);
    // Without the ceiling this answers with the vault itself, and every read of
    // a broken slot is a read of the operator's checkout.
    assert.equal(gitSync(orphan, ["rev-parse", "--show-toplevel"]).ok, false);
  });

  it("does not hand out a slot directory that is not a checkout", () => {
    db().prepare("DELETE FROM runs").run();
    const first = admitRoot("vault", true).worktree_path!;
    db().prepare("DELETE FROM runs").run();
    // Left behind with no `.git`: the vault's status, read through it, is clean.
    fs.mkdirSync(first, { recursive: true });
    fs.writeFileSync(path.join(first, "left-behind.md"), "not a checkout\n");

    const next = admitRoot("vault", true);
    assert.equal(next.isolation, "worktree");
    assert.notEqual(next.worktree_path, first);
  });
});

describe("the operator's checkout of a repository at the mount root", () => {
  it("is not held by a run working in a slot inside it, and is by one working in it", () => {
    db().prepare("DELETE FROM runs").run();
    admitRoot("vault", true);
    assert.equal(checkoutHeld(vault), false);

    const direct = admitRoot("vault", false);
    assert.equal(direct.isolation, "none");
    assert.equal(checkoutHeld(vault), true);
  });
});

describe("a run's touched files, when its folder holds the store", () => {
  it("counts a file in another run's slot as outside, not as a path in its own tree", () => {
    db().prepare("DELETE FROM runs").run();
    const run = admitRoot("vault", true);
    const slot = run.worktree_path!;
    const sibling = path.join(store, "someone-else-9");
    const addTouch = db().prepare(
      "INSERT INTO run_events (run_id, ts, kind, payload) VALUES (?, ?, 'tool', ?)",
    );
    for (const file of [
      path.join(slot, "notes", "a.md"),
      path.join(sibling, "notes", "a.md"),
      path.join(vault, "README.md"),
    ]) {
      addTouch.run(run.id, Date.now(), JSON.stringify({ name: "Read", input: { file_path: file } }));
    }

    const outside = Object.fromEntries(scanTouches(run.id).map((t) => [t.path, t.outside]));
    assert.deepEqual(outside, {
      "notes/a.md": false,
      [path.join(sibling, "notes", "a.md")]: true,
      "README.md": false,
    });
  });
});

describe("the folder listing of a mount whose root is a repository", () => {
  it("says the root is a repository and lists no slot as a folder", async () => {
    assert.ok(fs.readdirSync(store).length > 0, "the store holds slots for this to be about");
    const { mounts, folders } = await scanWorkspace();
    const isGitRepo = Object.fromEntries(mounts.map((m) => [m.id, m.isGitRepo]));
    assert.deepEqual(isGitRepo, {
      vault: true,
      plain: true,
      global: true,
      notes: false,
      outer: true,
      covered: true,
      above: false,
      broken: true,
    });
    assert.deepEqual(
      folders.filter((f) => f.path.split(path.sep).includes(WORKTREE_STORE_DIR)),
      [],
    );
  });
});
