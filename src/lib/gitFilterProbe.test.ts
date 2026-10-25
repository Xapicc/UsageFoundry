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
const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const gitStub = path.join(root, "git");

for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) delete process.env[key];
}

fs.writeFileSync(
  gitStub,
  [
    "#!/bin/sh",
    'for arg in "$@"; do',
    '  if [ "$arg" = "--get-regexp" ]; then',
    `    case "$(cat '${modeFile}')" in`,
    // `exec`, so the clock's SIGKILL reaches the process holding the pipes.
    "      hang) exec sleep 120 ;;",
    '      refused) echo "error: could not lock config file" >&2; echo "fatal: unable to read config file" >&2; exit 128 ;;',
    "      killed) kill -9 $$ ;;",
    '      output-with-one) echo "filter.x.clean"; exit 1 ;;',
    "    esac",
    "  fi",
    "done",
    `exec '${realGit}' "$@"`,
    "",
  ].join("\n"),
  { mode: 0o755 },
);
process.env.GIT_BIN = gitStub;

const { git, gitSync } = require("./git") as typeof import("./git");

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
});
