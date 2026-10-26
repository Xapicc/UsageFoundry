import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * What `git()` and `gitSync()` do when the driver probe itself fails, and what
 * the blanks it yields keep from running; each later `describe` says its own.
 *
 * Before a content subcommand the probe (`git config --get-regexp`) lists the
 * repository's filter and merge drivers so each can be blanked on the real call.
 * It exits 1 when there are none, which is the common case, and its status was
 * therefore never read: a probe killed by its clock, killed by a signal, or
 * refused by git read as "no filters", and the real call then ran *without* the
 * blanks, so a `filter.<x>.clean` a work cycle planted in `.git/config` ran in
 * this server's git (board task c032f10c). Only exit 1 with nothing on stdout is
 * "no filters"; anything else must fail the real call before it is spawned.
 *
 * The probe is made to fail with a `GIT_BIN` stub that recognises it by
 * `--get-regexp` and runs real git for every other call; the clock case is a
 * real hung child killed by a real `SIGKILL`. `GIT_BIN` is read when
 * `config.ts` loads, hence a file of its own.
 */

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-git-probe-")));
const modeFile = path.join(root, "mode");
/** The program the plant modes write into a repository's configuration. */
const plantFile = path.join(root, "plant");
const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const gitStub = path.join(root, "git");

for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}

fs.writeFileSync(
  gitStub,
  [
    "#!/bin/sh",
    `mode="$(cat '${modeFile}')"`,
    'for arg in "$@"; do',
    '  if [ "$arg" = "--get-regexp" ]; then',
    '    case "$mode" in',
    // `exec`, so the clock's SIGKILL reaches the process holding the pipes.
    "      hang) exec sleep 120 ;;",
    '      refused) echo "error: could not lock config file" >&2; echo "fatal: unable to read config file" >&2; exit 128 ;;',
    "      killed) kill -9 $$ ;;",
    '      output-with-one) echo "filter.x.clean"; exit 1 ;;',
    // The probe answers from the configuration as it was, and the driver is
    // written the moment after: the race a writer swapping `.git/config` wins.
    '      plant-after-probe) out="$(mktemp)"',
    `        '${realGit}' "$@" > "$out"; status=$?`,
    `        '${realGit}' config filter.x.clean "$(cat '${plantFile}')"`,
    '        cat "$out"; rm -f "$out"; exit $status ;;',
    "    esac",
    "  fi",
    // An included file written after the probe has named it, while the index
    // is listed.
    `  if [ "$arg" = "ls-files" ] && [ "$mode" = "plant-include" ]; then`,
    `    printf '[filter "x"]\\n\\tclean = %s\\n' "$(cat '${plantFile}')" > .git/evil.inc`,
    "  fi",
    "done",
    `exec '${realGit}' "$@"`,
    "",
  ].join("\n"),
  { mode: 0o755 },
);
process.env.GIT_BIN = gitStub;

const { addWorktree, git, gitSync } = require("./git") as typeof import("./git");
const { gitFailureLine, parseMergeTree } = require("./land") as typeof import("./land");

const setMode = (mode: string) => fs.writeFileSync(modeFile, mode);

// The fixture is built with plain git, never through the stub.
const plainEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: root,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
});
const plain = (cwd: string, args: string[]) =>
  execFileSync(realGit, args, { cwd, env: plainEnv(), encoding: "utf8" });

after(() => fs.rmSync(root, { recursive: true, force: true }));

let count = 0;

/** A repository whose planted clean filter `driver` would leave `marker` if it ran. */
function plantedRepo(driver = "x"): { repo: string; marker: string } {
  const name = `repo${count++}`;
  const repo = path.join(root, name);
  fs.mkdirSync(repo);
  plain(repo, ["init", "-q", "-b", "main"]);
  plain(repo, ["config", "user.email", "a@b.c"]);
  plain(repo, ["config", "user.name", "a"]);
  fs.writeFileSync(path.join(repo, "f.txt"), "one\n");
  plain(repo, ["add", "-A"]);
  plain(repo, ["commit", "-q", "-m", "init"]);
  const marker = path.join(root, `${name}.ran`);
  const prog = path.join(root, `${name}.sh`);
  fs.writeFileSync(prog, `#!/bin/sh\necho "ran $*" >> ${marker}\ncat\n`, { mode: 0o755 });
  plain(repo, ["config", `filter.${driver}.clean`, prog]);
  fs.mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "info", "attributes"), `* filter=${driver}\n`);
  fs.writeFileSync(path.join(repo, "f.txt"), "two\n");
  return { repo, marker };
}

/**
 * Two branches that change different lines of one file, so merging them is a
 * three-way content merge, which is where git hands a file to a merge driver.
 * The planted driver `driver` leaves `marker` if it runs.
 */
function plantedMergeRepo(driver = "evil"): { repo: string; marker: string } {
  const name = `repo${count++}`;
  const repo = path.join(root, name);
  const file = path.join(repo, "f.txt");
  fs.mkdirSync(repo);
  plain(repo, ["init", "-q", "-b", "main"]);
  plain(repo, ["config", "user.email", "a@b.c"]);
  plain(repo, ["config", "user.name", "a"]);
  fs.writeFileSync(file, "a\nb\nc\nd\ne\n");
  plain(repo, ["add", "-A"]);
  plain(repo, ["commit", "-q", "-m", "init"]);
  plain(repo, ["checkout", "-q", "-b", "side"]);
  fs.writeFileSync(file, "a\nB\nc\nd\ne\n");
  plain(repo, ["commit", "-q", "-am", "side"]);
  plain(repo, ["checkout", "-q", "main"]);
  fs.writeFileSync(file, "a\nb\nc\nd\nE\n");
  plain(repo, ["commit", "-q", "-am", "main"]);
  const marker = path.join(root, `${name}.ran`);
  const prog = path.join(root, `${name}.sh`);
  fs.writeFileSync(prog, `#!/bin/sh\necho "ran $*" >> ${marker}\n`, { mode: 0o755 });
  plain(repo, ["config", `merge.${driver}.driver`, `${prog} %O %A %B`]);
  fs.mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "info", "attributes"), `* merge=${driver}\n`);
  return { repo, marker };
}

const ranNothing = (marker: string) =>
  assert.equal(
    fs.existsSync(marker),
    false,
    `the planted program ran: ${fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : ""}`,
  );

describe("a filter probe that failed does not read as 'no filters'", () => {
  before(() => setMode("pass"));

  it("git(): a probe the repository's git refused fails the call and runs no driver", async () => {
    const { repo, marker } = plantedRepo();
    setMode("refused");
    const res = await git(repo, ["add", "-A"]);

    ranNothing(marker);
    assert.equal(res.ok, false, "the call went ahead on a probe that failed");
    assert.equal(res.code, null, "a call that never ran has no exit status of its own");
    assert.equal(res.timedOutAfterMs, null);
    assert.match(res.stderr, /filter probe/i);
    assert.match(res.stderr, /exited with status 128/);
    assert.match(res.stderr, /unable to read config file/, "git's own words must reach the reason");
    // `gitFailureLine` keeps one line of a failure's stderr, so a reason spread over
    // several would be cut to its tail.
    assert.equal(res.stderr.includes("\n"), false, res.stderr);
  });

  it("git(): a probe killed by a signal fails the call and runs no driver", async () => {
    const { repo, marker } = plantedRepo();
    setMode("killed");
    const res = await git(repo, ["add", "-A"]);

    ranNothing(marker);
    assert.equal(res.ok, false);
    assert.match(res.stderr, /filter probe/i);
    assert.match(res.stderr, /SIGKILL/);
  });

  it("git(): a probe that hangs is killed by the caller's clock, and the call fails", async () => {
    const { repo, marker } = plantedRepo();
    setMode("hang");
    // The probe takes the clock the caller gave the call, so that a landing
    // call with no clock has none on its probe either, and this one is quick.
    const res = await git(repo, ["add", "-A"], { timeoutMs: 400 });

    ranNothing(marker);
    assert.equal(res.ok, false);
    assert.equal(res.timedOutAfterMs, null, "the real call was never started, so it was not killed");
    assert.match(res.stderr, /filter probe/i);
    assert.match(res.stderr, /killed after/);
  });

  it("git(): exit 1 with output is not 'no filters'", async () => {
    const { repo, marker } = plantedRepo();
    setMode("output-with-one");
    const res = await git(repo, ["add", "-A"]);

    ranNothing(marker);
    assert.equal(res.ok, false);
    assert.match(res.stderr, /filter probe/i);
  });

  it("gitSync(): a probe the repository's git refused fails the call and runs no driver", () => {
    const { repo, marker } = plantedRepo();
    setMode("refused");
    const res = gitSync(repo, ["add", "-A"]);

    ranNothing(marker);
    assert.equal(res.ok, false, "the call went ahead on a probe that failed");
    assert.equal(res.code, null);
    assert.match(res.stderr, /filter probe/i);
    assert.match(res.stderr, /exited with status 128/);
  });

  it("gitSync(): a probe killed by a signal fails the call and runs no driver", () => {
    const { repo, marker } = plantedRepo();
    setMode("killed");
    const res = gitSync(repo, ["add", "-A"]);

    ranNothing(marker);
    assert.equal(res.ok, false);
    assert.match(res.stderr, /filter probe/i);
    assert.match(res.stderr, /SIGKILL/);
  });

  it("a repository with no filter drivers is the common case and still runs the call", async () => {
    // Real git's own answer to the probe: exit 1, nothing on stdout.
    setMode("pass");
    const repo = path.join(root, `repo${count++}`);
    fs.mkdirSync(repo);
    plain(repo, ["init", "-q", "-b", "main"]);
    fs.writeFileSync(path.join(repo, "f.txt"), "one\n");

    const viaGit = await git(repo, ["add", "-A"]);
    assert.equal(viaGit.ok, true, viaGit.stderr);
    fs.writeFileSync(path.join(repo, "f.txt"), "two\n");
    const viaSync = gitSync(repo, ["add", "-A"]);
    assert.equal(viaSync.ok, true, viaSync.stderr);
  });

  it("a read that is not a content subcommand never asks the probe, so a broken probe cannot fail it", async () => {
    const { repo } = plantedRepo();
    setMode("refused");

    const viaGit = await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
    assert.equal(viaGit.ok, true, viaGit.stderr);
    assert.equal(viaGit.stdout, "main");
    const viaSync = gitSync(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
    assert.equal(viaSync.ok, true, viaSync.stderr);
    assert.equal(viaSync.stdout, "main");
  });
});

/**
 * git splits a `-c` at its first `=`, so `-c filter.a=b.clean=` set a key
 * `filter.a` to `b.clean=` and left the planted `filter.a=b.clean` running on
 * every content subcommand (board task a9fde194). A driver name is the
 * repository's to choose, so the blank has to reach git by a carrier that
 * splits somewhere the name cannot reach.
 */
describe("a driver name the -c form cannot spell is still blanked", () => {
  before(() => setMode("pass"));

  it("git(): a clean filter named a=b runs nothing on add", async () => {
    const { repo, marker } = plantedRepo("a=b");
    const res = await git(repo, ["add", "-A"]);

    ranNothing(marker);
    assert.equal(res.ok, true, res.stderr);
  });

  it("gitSync(): a clean filter named a=b runs nothing on add", () => {
    const { repo, marker } = plantedRepo("a=b");
    const res = gitSync(repo, ["add", "-A"]);

    ranNothing(marker);
    assert.equal(res.ok, true, res.stderr);
  });

  it("control: the same plant runs under plain git", () => {
    const { repo, marker } = plantedRepo("a=b");
    plain(repo, ["add", "-A"]);
    assert.equal(fs.existsSync(marker), true, "the planted a=b filter did not fire, so the cases above measure nothing");
  });
});

/**
 * A `merge.<x>.driver` paired with `* merge=x` is a program git runs on every
 * three-way content merge of a file, and Land runs two: the `merge-tree` that
 * previews a land, which was not even probed, and the real `merge` (board task
 * a38856ec). An empty driver is what turns one off: git then runs nothing and
 * fails the merge, where `false` reads as a conflict whose file holds ours
 * without markers and `true` as a clean merge that dropped theirs (measured,
 * 2.39.5).
 */
describe("a planted merge driver runs in neither merge-tree nor merge", () => {
  before(() => setMode("pass"));

  it("git(): merge-tree --write-tree runs nothing and does not report a merge", async () => {
    const { repo, marker } = plantedMergeRepo();
    const res = await git(repo, ["merge-tree", "--write-tree", "-z", "main", "side"]);

    ranNothing(marker);
    assert.equal(res.ok, false, "a merge the driver was kept out of cannot have succeeded");
  });

  it("git(): merge runs nothing and fails", async () => {
    const { repo, marker } = plantedMergeRepo();
    const res = await git(repo, ["merge", "--no-edit", "side"]);

    ranNothing(marker);
    assert.equal(res.ok, false);
  });

  it("git(): a merge driver named a=b runs nothing either", async () => {
    const { repo, marker } = plantedMergeRepo("a=b");
    const res = await git(repo, ["merge-tree", "--write-tree", "-z", "main", "side"]);

    ranNothing(marker);
    assert.equal(res.ok, false);
  });

  it("control: the same plant runs under plain git's merge-tree", () => {
    const { repo, marker } = plantedMergeRepo();
    plain(repo, ["merge-tree", "--write-tree", "-z", "main", "side"]);
    assert.equal(fs.existsSync(marker), true, "the planted merge driver did not fire, so the cases above measure nothing");
  });

  // git's own words for a blanked driver are "cannot run : No such file or
  // directory", which names neither the driver nor why (board task adb9e828).
  it("Land's preview of a merge the blank failed names the driver and says why", async () => {
    const { repo } = plantedMergeRepo();
    const res = await git(repo, ["merge-tree", "--write-tree", "-z", "main", "side"]);
    const preview = parseMergeTree(res.stdout, res.stderr, res.code);

    assert.equal(preview.outcome, "unknown");
    const reason = preview.outcome === "unknown" ? preview.reason : "";
    assert.match(reason, /cannot run :/, "git's own line must still be there");
    assert.match(reason, /merge\.evil\.driver/);
    assert.match(reason, /does not run a repository's merge drivers/);

    const viaSync = gitSync(repo, ["merge-tree", "--write-tree", "-z", "main", "side"]);
    assert.match(viaSync.stderr.split("\n")[0], /merge\.evil\.driver/);
  });

  it("a merge the blank failed says so on the line gitFailureLine keeps", async () => {
    const { repo } = plantedMergeRepo();
    const res = await git(repo, ["merge", "--no-edit", "side"]);

    assert.equal(res.ok, false);
    const line = gitFailureLine(res.stderr);
    assert.match(line, /cannot run :/);
    assert.match(line, /does not run a repository's merge drivers/);
    assert.match(line, /merge\.evil\.driver/);
  });
});

/**
 * A repository whose filter `evil` is defined only in `.git/evil.inc`, pulled
 * in by `[includeIf "<condition>"]`, so whether git sees it depends on which
 * worktree is asking. Its smudge and clean both leave `marker` if they run.
 */
function includedFilterRepo(condition: (repo: string) => string): { repo: string; marker: string } {
  const name = `repo${count++}`;
  const repo = path.join(root, name);
  fs.mkdirSync(repo);
  plain(repo, ["init", "-q", "-b", "main"]);
  plain(repo, ["config", "user.email", "a@b.c"]);
  plain(repo, ["config", "user.name", "a"]);
  fs.writeFileSync(path.join(repo, "f.txt"), "one\n");
  plain(repo, ["add", "-A"]);
  plain(repo, ["commit", "-q", "-m", "init"]);
  const marker = path.join(root, `${name}.ran`);
  const prog = path.join(root, `${name}.sh`);
  fs.writeFileSync(prog, `#!/bin/sh\necho "ran $*" >> ${marker}\ncat\n`, { mode: 0o755 });
  fs.writeFileSync(
    path.join(repo, ".git", "evil.inc"),
    `[filter "evil"]\n\tsmudge = ${prog} %f\n\tclean = ${prog} %f\n`,
  );
  plain(repo, ["config", `includeIf.${condition(repo)}.path`, "evil.inc"]);
  fs.mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "info", "attributes"), "* filter=evil\n");
  return { repo, marker };
}

const CONDITIONS: [string, (repo: string) => string][] = [
  ["onbranch:", () => "onbranch:uf/**"],
  ["gitdir:", (repo) => `gitdir:${repo}/.git/worktrees/`],
];

/**
 * The probe reads configuration as git in the caller's checkout sees it, but
 * `worktree add` checks out in a child inside the new tree, and `worktree
 * remove` runs a `status` inside the tree it removes. Each re-reads
 * configuration with that tree's HEAD and git directory, so a filter behind
 * either include form was invisible to the probe and ran (board task
 * d8cae532): its smudge on every isolated run's `worktree add`, its clean on
 * retention's `worktree remove`.
 */
describe("a driver behind a conditional include is probed where the child reads it", () => {
  before(() => setMode("pass"));

  for (const [label, condition] of CONDITIONS) {
    it(`git(): worktree add runs no smudge (${label} include)`, async () => {
      const { repo, marker } = includedFilterRepo(condition);
      const slot = `${repo}-slot`;
      const res = await git(repo, ["worktree", "add", "-b", "uf/slot-1", slot, "main"]);

      ranNothing(marker);
      // The add is refused before it runs rather than run with a guess, so the
      // only way in is `addWorktree`, below.
      assert.equal(res.ok, false);
      assert.match(res.stderr, /addWorktree/);
    });

    it(`addWorktree(): the checkout is made and runs nothing (${label} include)`, async () => {
      const { repo, marker } = includedFilterRepo(condition);
      const slot = `${repo}-slot`;
      const res = await addWorktree(repo, slot, "main", { newBranch: "uf/slot-1" });

      ranNothing(marker);
      assert.equal(res.ok, true, res.stderr);
      assert.equal(fs.readFileSync(path.join(slot, "f.txt"), "utf8"), "one\n");
      assert.equal(plain(slot, ["status", "--porcelain"]), "", "the checkout is not whole");
      assert.equal(plain(slot, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "uf/slot-1");
      assert.doesNotMatch(plain(repo, ["worktree", "list", "--porcelain"]), /^locked/m);
    });

    it(`git(): worktree remove runs no clean filter (${label} include)`, async () => {
      const { repo, marker } = includedFilterRepo(condition);
      const slot = `${repo}-slot`;
      // Made with nothing able to run, then made stat-dirty, which is what has
      // the remove's `status` re-hash the file through its clean filter.
      plain(repo, ["worktree", "add", "-q", "--no-checkout", "-b", "uf/slot-1", slot, "main"]);
      plain(slot, ["-c", "filter.evil.smudge=", "-c", "filter.evil.clean=", "reset", "-q", "--hard"]);
      const past = new Date("2001-01-01T00:00:00Z");
      fs.utimesSync(path.join(slot, "f.txt"), past, past);
      fs.rmSync(marker, { force: true });
      const res = await git(repo, ["worktree", "remove", slot]);

      ranNothing(marker);
      assert.equal(res.ok, true, res.stderr);
      assert.equal(fs.existsSync(slot), false);
    });
  }

  it("gitSync(): a worktree add that would check out is refused too", () => {
    const { repo, marker } = includedFilterRepo(CONDITIONS[0][1]);
    const res = gitSync(repo, ["worktree", "add", "-b", "uf/slot-1", `${repo}-slot`, "main"]);

    ranNothing(marker);
    assert.equal(res.ok, false);
  });

  it("addWorktree(): a checkout that fails takes its tree with it and keeps the branch", async () => {
    // A required filter fails the checkout once its smudge is blanked, which is
    // the failure that reaches the third step.
    const { repo, marker } = plantedRepo("req");
    plain(repo, ["config", "filter.req.smudge", marker.replace(/\.ran$/, ".sh")]);
    plain(repo, ["config", "filter.req.required", "true"]);
    const slot = `${repo}-slot`;
    const res = await addWorktree(repo, slot, "main", { newBranch: "uf/slot-1" });

    ranNothing(marker);
    assert.equal(res.ok, false);
    assert.match(res.stderr, /smudge filter req failed/);
    assert.deepEqual(res.args.slice(0, 2), ["reset", "--hard"]);
    assert.equal(fs.existsSync(slot), false, "the half-made checkout was left behind");
    assert.doesNotMatch(plain(repo, ["worktree", "list", "--porcelain"]), new RegExp(slot));
    plain(repo, ["rev-parse", "--verify", "-q", "refs/heads/uf/slot-1"]);
  });

  it("control: the same plants run under plain git's worktree add and remove", () => {
    for (const [, condition] of CONDITIONS) {
      const { repo, marker } = includedFilterRepo(condition);
      const slot = `${repo}-slot`;
      plain(repo, ["worktree", "add", "-q", "-b", "uf/slot-1", slot, "main"]);
      assert.equal(fs.existsSync(marker), true, `${condition(repo)}: the smudge did not fire on add`);
      fs.rmSync(marker);
      const past = new Date("2001-01-01T00:00:00Z");
      fs.utimesSync(path.join(slot, "f.txt"), past, past);
      plain(repo, ["worktree", "remove", slot]);
      assert.equal(fs.existsSync(marker), true, `${condition(repo)}: the clean filter did not fire on remove`);
    }
  });
});

const longAgo = new Date("2001-01-01T00:00:00Z");
/** Stat-dirty, which is what has a `status` re-hash the file, or ask its submodule. */
const staleFile = (file: string) => fs.utimesSync(file, longAgo, longAgo);

/** A program that leaves a line in `<name>.ran` when it runs, and passes its input through. */
function plantProgram(name: string): { prog: string; marker: string } {
  const marker = path.join(root, `${name}.ran`);
  const prog = path.join(root, `${name}.sh`);
  fs.writeFileSync(prog, `#!/bin/sh\necho "ran $*" >> ${marker}\ncat\n`, { mode: 0o755 });
  return { prog, marker };
}

/** A repository with one committed file and a committer, at `dir`. */
function committedRepo(dir: string, file = "s.txt"): void {
  fs.mkdirSync(dir, { recursive: true });
  plain(dir, ["init", "-q", "-b", "main"]);
  plain(dir, ["config", "user.email", "a@b.c"]);
  plain(dir, ["config", "user.name", "a"]);
  fs.writeFileSync(path.join(dir, file), "s\n");
  plain(dir, ["add", "-A"]);
  plain(dir, ["commit", "-q", "-m", file]);
}

/** Plants filter `x` in a submodule's own git directory, where a probe in the superproject never reads. */
function plantInGitDir(gitDir: string, keys: [string, string][], attribute = "filter=x"): void {
  for (const [key, value] of keys) plain(gitDir, ["config", "-f", path.join(gitDir, "config"), key, value]);
  fs.mkdirSync(path.join(gitDir, "info"), { recursive: true });
  fs.writeFileSync(path.join(gitDir, "info", "attributes"), `* ${attribute}\n`);
}

/**
 * A superproject whose submodule `sm`, cloned the way `git submodule add` does,
 * has a clean filter planted in `.git/modules/sm/`, and a stat-dirty file.
 */
function submoduleRepo(): { repo: string; marker: string } {
  const name = `repo${count++}`;
  const repo = path.join(root, name);
  committedRepo(`${repo}-src`);
  committedRepo(repo, "top.txt");
  plain(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", `${repo}-src`, "sm"]);
  plain(repo, ["commit", "-q", "-m", "sm"]);
  const { prog, marker } = plantProgram(name);
  plantInGitDir(path.join(repo, ".git", "modules", "sm"), [["filter.x.clean", prog]]);
  staleFile(path.join(repo, "sm", "s.txt"));
  return { repo, marker };
}

/**
 * A repository holding repository `a`, which holds `b`, each added as a bare
 * gitlink that no `.gitmodules` names, with the filter planted in `b`'s own
 * `.git` two levels below the superproject.
 */
function nestedEmbeddedRepo(): { repo: string; marker: string } {
  const name = `repo${count++}`;
  const repo = path.join(root, name);
  committedRepo(repo, "top.txt");
  committedRepo(path.join(repo, "a"));
  committedRepo(path.join(repo, "a", "b"));
  plain(path.join(repo, "a"), ["-c", "advice.addEmbeddedRepo=false", "add", "b"]);
  plain(path.join(repo, "a"), ["commit", "-q", "-m", "b"]);
  plain(repo, ["-c", "advice.addEmbeddedRepo=false", "add", "a"]);
  plain(repo, ["commit", "-q", "-m", "a"]);
  const { prog, marker } = plantProgram(name);
  plantInGitDir(path.join(repo, "a", "b", ".git"), [["filter.x.clean", prog]]);
  staleFile(path.join(repo, "a", "b", "s.txt"));
  return { repo, marker };
}

/**
 * A checkout on `main`, which has no submodule, and a branch `evil` that adds
 * `sm`, with a smudge planted in `.git/modules/sm/` and the repository's
 * `submodule.recurse` on: switching the tree to `evil` checks `sm` out with a
 * child git the probe, listing `main`'s index, never reached.
 */
function addedSubmoduleRepo(): { repo: string; marker: string } {
  const name = `repo${count++}`;
  const repo = path.join(root, name);
  committedRepo(`${repo}-src`);
  committedRepo(repo, "top.txt");
  plain(repo, ["checkout", "-q", "-b", "evil"]);
  plain(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", `${repo}-src`, "sm"]);
  plain(repo, ["commit", "-q", "-m", "sm"]);
  const { prog, marker } = plantProgram(name);
  plantInGitDir(path.join(repo, ".git", "modules", "sm"), [
    ["filter.x.smudge", prog],
    ["filter.x.clean", prog],
  ]);
  plain(repo, ["-c", "submodule.recurse=false", "checkout", "-q", "main"]);
  fs.rmSync(path.join(repo, "sm"), { recursive: true, force: true });
  plain(repo, ["config", "submodule.recurse", "true"]);
  return { repo, marker };
}

/**
 * A checkout on `main` with a populated repository `sm` left in its tree that
 * `main`'s index does not list, and a branch `evil` whose index does: only the
 * report `checkout` prints after the switch asks `sm` anything.
 */
function leftoverGitlinkRepo(): { repo: string; marker: string } {
  const name = `repo${count++}`;
  const repo = path.join(root, name);
  committedRepo(repo, "top.txt");
  plain(repo, ["checkout", "-q", "-b", "evil"]);
  committedRepo(path.join(repo, "sm"));
  plain(repo, ["-c", "advice.addEmbeddedRepo=false", "add", "sm"]);
  plain(repo, ["commit", "-q", "-m", "sm"]);
  const { prog, marker } = plantProgram(name);
  plantInGitDir(path.join(repo, "sm", ".git"), [["filter.x.clean", prog]]);
  // git leaves a directory holding a repository where it stands.
  plain(repo, ["checkout", "-q", "main"]);
  staleFile(path.join(repo, "sm", "s.txt"));
  return { repo, marker };
}

/**
 * Two commits of a superproject that move submodule `sm`, a textconv planted
 * in `.git/modules/sm/` for every file in it, and the superproject's
 * `diff.submodule=diff`, which has a patch of that move made by a child `git
 * diff` inside `sm`.
 */
function submoduleTextconvRepo(): { repo: string; marker: string } {
  const name = `repo${count++}`;
  const repo = path.join(root, name);
  committedRepo(`${repo}-src`);
  committedRepo(repo, "top.txt");
  plain(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", `${repo}-src`, "sm"]);
  plain(repo, ["commit", "-q", "-m", "sm"]);
  const sm = path.join(repo, "sm");
  fs.appendFileSync(path.join(sm, "s.txt"), "t\n");
  plain(sm, ["-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-q", "-am", "t"]);
  plain(repo, ["commit", "-q", "-am", "move sm"]);
  const marker = path.join(root, `${name}.ran`);
  const prog = path.join(root, `${name}.sh`);
  fs.writeFileSync(prog, `#!/bin/sh\necho "ran $*" >> ${marker}\ncat "$1"\n`, { mode: 0o755 });
  plantInGitDir(path.join(repo, ".git", "modules", "sm"), [["diff.t.textconv", prog]], "diff=t");
  plain(repo, ["config", "diff.submodule", "diff"]);
  return { repo, marker };
}

/**
 * A content subcommand starts a child git inside a populated submodule, and
 * that child reads the submodule's own configuration and attributes, which
 * the probe in the superproject never read: a filter planted in
 * `.git/modules/<name>/` ran on this app's own `status` of the superproject
 * (board task a559b561). `add -A` is here because no flag or setting stops it
 * recursing; the rest are each a way the child is reached that probing the
 * index alone would miss.
 */
describe("a driver planted in a submodule's git directory runs in no child of this app's git", () => {
  before(() => setMode("pass"));

  it("git(): status of the superproject runs nothing", async () => {
    const { repo, marker } = submoduleRepo();
    const res = await git(repo, ["status", "--porcelain"], { trim: false });

    ranNothing(marker);
    assert.equal(res.ok, true, res.stderr);
  });

  it("gitSync(): status of the superproject runs nothing", () => {
    const { repo, marker } = submoduleRepo();
    const res = gitSync(repo, ["status", "--porcelain"]);

    ranNothing(marker);
    assert.equal(res.ok, true, res.stderr);
  });

  it("git(): status from a subdirectory of the superproject runs nothing", async () => {
    const { repo, marker } = submoduleRepo();
    const below = path.join(repo, "below");
    fs.mkdirSync(below);
    const res = await git(below, ["status", "--porcelain"], { trim: false });

    ranNothing(marker);
    assert.equal(res.ok, true, res.stderr);
  });

  it("git(): add -A, which nothing tells not to recurse, runs nothing", async () => {
    const { repo, marker } = submoduleRepo();
    const res = await git(repo, ["add", "-A"]);

    ranNothing(marker);
    assert.equal(res.ok, true, res.stderr);
  });

  it("git(): a submodule's own submodule is reached too", async () => {
    const { repo, marker } = nestedEmbeddedRepo();
    const res = await git(repo, ["status", "--porcelain"], { trim: false });

    ranNothing(marker);
    assert.equal(res.ok, true, res.stderr);
  });

  it("git(): read-tree -u onto a commit that adds a submodule does not recurse into it", async () => {
    const { repo, marker } = addedSubmoduleRepo();
    const res = await git(repo, ["read-tree", "-m", "-u", "HEAD", "evil"]);

    ranNothing(marker);
    assert.equal(res.ok, true, res.stderr);
  });

  it("git(): checkout onto a branch whose index alone lists a submodule runs nothing", async () => {
    const { repo, marker } = leftoverGitlinkRepo();
    const res = await git(repo, ["checkout", "evil"]);

    ranNothing(marker);
    assert.equal(res.ok, true, res.stderr);
    assert.equal(plain(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "evil");
  });

  it("git(): a patch of a submodule move runs none of the submodule's textconv", async () => {
    const { repo, marker } = submoduleTextconvRepo();
    const res = await git(repo, ["diff", "--no-ext-diff", "--no-textconv", "HEAD~1", "HEAD"]);

    ranNothing(marker);
    assert.equal(res.ok, true, res.stderr);
    assert.match(res.stdout, /Subproject commit/);
  });

  it("control: each plant runs under plain git", () => {
    const fired = (label: string, marker: string) => {
      assert.equal(fs.existsSync(marker), true, `${label}: the plant did not fire, so its case measures nothing`);
    };
    const status = submoduleRepo();
    plain(status.repo, ["status", "--porcelain"]);
    fired("status", status.marker);
    const add = submoduleRepo();
    plain(add.repo, ["-c", "diff.ignoreSubmodules=all", "-c", "submodule.sm.ignore=all", "add", "-A"]);
    fired("add -A, under every ignore setting", add.marker);
    const nested = nestedEmbeddedRepo();
    plain(nested.repo, ["status", "--porcelain"]);
    fired("nested status", nested.marker);
    const added = addedSubmoduleRepo();
    plain(added.repo, ["read-tree", "-m", "-u", "HEAD", "evil"]);
    fired("read-tree -u", added.marker);
    const leftover = leftoverGitlinkRepo();
    plain(leftover.repo, ["-c", "submodule.recurse=false", "checkout", "evil"]);
    fired("checkout", leftover.marker);
    const textconv = submoduleTextconvRepo();
    plain(textconv.repo, ["diff", "--no-ext-diff", "--no-textconv", "HEAD~1", "HEAD"]);
    fired("diff", textconv.marker);
  });
});

/**
 * The probe and the call each read configuration for themselves, so a writer
 * swapping `.git/config` between a version with a driver and one without had
 * the driver run whenever the probe read the clean one and the call the other
 * (board task 7d41bb25). The stub makes that race deterministic: it answers
 * the probe from the configuration as it was and writes the driver straight
 * after. Nothing on git 2.39 closes the race, and these pin what the
 * fingerprint of the configuration files now refuses: a file changed between
 * the moment before the probe and the moment before the call.
 */
describe("a driver written between the probe and the call is refused", () => {
  /** A repository whose attributes name filter `x`, which its configuration does not define yet. */
  function namedButUndefinedRepo(): { repo: string; marker: string } {
    const name = `repo${count++}`;
    const repo = path.join(root, name);
    committedRepo(repo, "f.txt");
    const { prog, marker } = plantProgram(name);
    fs.writeFileSync(plantFile, prog);
    fs.mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "info", "attributes"), "* filter=x\n");
    fs.writeFileSync(path.join(repo, "f.txt"), "two\n");
    return { repo, marker };
  }

  after(() => setMode("pass"));

  it("git(): .git/config rewritten after the probe refuses the call", async () => {
    const { repo, marker } = namedButUndefinedRepo();
    setMode("plant-after-probe");
    const res = await git(repo, ["add", "-A"]);
    setMode("pass");

    ranNothing(marker);
    assert.equal(res.ok, false, "the call ran on a configuration the probe never read");
    assert.equal(res.code, null);
    assert.match(res.stderr, /\.git\/config changed while the filter probe read it/);
    assert.equal(res.stderr.includes("\n"), false, res.stderr);
  });

  it("gitSync(): .git/config rewritten after the probe refuses the call", () => {
    const { repo, marker } = namedButUndefinedRepo();
    setMode("plant-after-probe");
    const res = gitSync(repo, ["add", "-A"]);
    setMode("pass");

    ranNothing(marker);
    assert.equal(res.ok, false);
    assert.match(res.stderr, /\.git\/config changed while the filter probe read it/);
  });

  it("git(): an included file written after the probe named it refuses the call", async () => {
    const { repo, marker } = namedButUndefinedRepo();
    plain(repo, ["config", "include.path", "evil.inc"]);
    setMode("plant-include");
    const res = await git(repo, ["add", "-A"]);
    setMode("pass");

    ranNothing(marker);
    assert.equal(res.ok, false);
    assert.match(res.stderr, /evil\.inc changed while the filter probe read it/);
  });

  it("control: what each plant leaves behind runs the driver", () => {
    const viaConfig = namedButUndefinedRepo();
    setMode("plant-after-probe");
    gitSync(viaConfig.repo, ["add", "-A"]);
    setMode("pass");
    plain(viaConfig.repo, ["add", "-A"]);
    assert.equal(fs.existsSync(viaConfig.marker), true, "the planted .git/config driver did not fire");

    // Written by hand: the stub writes it while the index is listed, a step
    // that exists only because submodules are probed.
    const viaInclude = namedButUndefinedRepo();
    plain(viaInclude.repo, ["config", "include.path", "evil.inc"]);
    fs.writeFileSync(
      path.join(viaInclude.repo, ".git", "evil.inc"),
      `[filter "x"]\n\tclean = ${fs.readFileSync(plantFile, "utf8")}\n`,
    );
    plain(viaInclude.repo, ["add", "-A"]);
    assert.equal(fs.existsSync(viaInclude.marker), true, "the planted included driver did not fire");
  });
});
