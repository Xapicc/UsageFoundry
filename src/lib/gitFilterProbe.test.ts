import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
/**
 * Where `plant-include` and `rewrite` write, what `make-dir` makes, what the
 * `move-away` modes move and the link `repoint-link` re-points, absolute.
 */
const writeTarget = path.join(root, "write-target");
/** What `rewrite` writes there, and where `repoint-link` points the link. */
const rewriteContent = path.join(root, "rewrite-content");
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
    // Every git child this app spawns, one argv a line.
    `if [ "$mode" = "log-calls" ]; then printf '%s\\n' "$*" >> '${root}/calls'; fi`,
    'for arg in "$@"; do',
    '  if [ "$arg" = "--get-regexp" ]; then',
    '    case "$mode" in',
    // `exec`, so the clock's SIGKILL reaches the process holding the pipes.
    "      hang) exec sleep 120 ;;",
    '      refused) echo "error: could not lock config file" >&2; echo "fatal: unable to read config file" >&2; exit 128 ;;',
    "      killed) kill -9 $$ ;;",
    '      output-with-one) echo "filter.x.clean"; exit 1 ;;',
    // `<writeTarget>` is away only while the probe reads, and back before the
    // probe exits, so a fingerprint taken on either side sees it where it was.
    // The `-marker-included` form first has the repository enclosing the one
    // `<writeTarget>` is in include the file the probe's marker comes from.
    `      move-away-while-probing*) target="$(cat '${writeTarget}')"`,
    '        if [ "$mode" = "move-away-while-probing-marker-included" ]; then',
    `          '${realGit}' config -f "$target/../../../.git/config" include.path "$USAGEFOUNDRY_PROBE_MARKER"`,
    "        fi",
    '        mv "$target" "$target.away"',
    `        echo "$target" >> '${root}/moved'`,
    `        '${realGit}' "$@"; status=$?; mv "$target.away" "$target"; exit $status ;;`,
    // The probe answers from the configuration as it was, and the driver is
    // written the moment after: the race a writer swapping `.git/config` wins.
    '      plant-after-probe) out="$(mktemp)"',
    `        '${realGit}' "$@" > "$out"; status=$?`,
    `        '${realGit}' config filter.x.clean "$(cat '${plantFile}')"`,
    '        cat "$out"; rm -f "$out"; exit $status ;;',
    "    esac",
    "  fi",
    // What the probe read, changed after it while the index is listed: an
    // included file written, HEAD moved, or any other file rewritten.
    // `move-away` moves once the listing is done, because the listing, pinned
    // to the git directory, fails on one without it and would refuse the call
    // before the watch is reached; `move-away-while-listing` moves it around
    // the listing alone.
    `  if [ "$arg" = "ls-files" ]; then`,
    '    case "$mode" in',
    `      plant-include) printf '[filter "x"]\\n\\tclean = %s\\n' "$(cat '${plantFile}')" > "$(cat '${writeTarget}')" ;;`,
    `      flip-head) '${realGit}' symbolic-ref HEAD refs/heads/uf/x ;;`,
    `      rewrite) cat '${rewriteContent}' > "$(cat '${writeTarget}')" ;;`,
    `      make-dir) mkdir -p "$(cat '${writeTarget}')" ;;`,
    // `-n`, so the link is replaced rather than followed into the directory it names.
    `      repoint-link) ln -sfn "$(cat '${rewriteContent}')" "$(cat '${writeTarget}')" ;;`,
    `      move-away) '${realGit}' "$@"; status=$?; mv "$(cat '${writeTarget}')" "$(cat '${writeTarget}').away"; exit $status ;;`,
    `      move-away-while-listing) target="$(cat '${writeTarget}')"; mv "$target" "$target.away"; echo "$target" >> '${root}/moved'`,
    `        '${realGit}' "$@"; status=$?; mv "$target.away" "$target"; exit $status ;;`,
    // Real git with the arguments in a file, for a write that is not a file's: a ref update in a reftable.
    `      run-git) '${realGit}' $(cat '${root}/run-git-args') ;;`,
    "    esac",
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

  it("every ref-moving call asks the probe, since each can fire a hook defined in config", async () => {
    // `branch -D`, `update-ref`, `fetch` and `push` each fired
    // `reference-transaction` under `gitArgs` on git 2.54, and none of them
    // moves content, so a gate listing only the content subcommands let them
    // run with no hook switched off. A probe that fails is how the gate is seen
    // on any git, the image's 2.39.5 included: asked, it fails the call.
    const { repo } = plantedRepo();
    plain(repo, ["branch", "doomed"]);
    plain(repo, ["remote", "add", "origin", repo]);
    setMode("refused");

    const calls = [
      ["branch", "-D", "doomed"],
      ["update-ref", "refs/heads/moved", "HEAD"],
      ["fetch", "--no-prune", "--recurse-submodules=no", "--end-of-options", "origin"],
      ["push", "origin", "HEAD:refs/heads/pushed"],
      ["remote", "rename", "origin", "renamed"],
      // An unmeasured subcommand is probed rather than trusted.
      ["tag", "t1"],
    ];
    for (const args of calls) {
      const viaGit = await git(repo, args);
      assert.equal(viaGit.ok, false, `git ${args.join(" ")} ran without the probe`);
      assert.match(viaGit.stderr, /filter probe/i, `git ${args.join(" ")}: ${viaGit.stderr}`);
      const viaSync = gitSync(repo, args);
      assert.equal(viaSync.ok, false, `gitSync ${args.join(" ")} ran without the probe`);
      assert.match(viaSync.stderr, /filter probe/i, `gitSync ${args.join(" ")}: ${viaSync.stderr}`);
    }
    assert.equal(plain(repo, ["branch", "--list", "doomed"]).trim(), "doomed", "branch -D ran");
  });

  it("a read behind a leading `-c` pair, and `remote`'s read forms, never ask the probe", async () => {
    // The subcommand is found past the `-c` pairs `commit-tree` and
    // `check-ignore` are called with; read off `args[0]`, both were taken for
    // a subcommand nobody listed and every land's `commit-tree` paid a probe.
    const { repo } = plantedRepo();
    plain(repo, ["remote", "add", "origin", repo]);
    setMode("refused");

    const calls = [
      ["-c", "user.name=U", "-c", "user.email=u@l", "commit-tree", "--no-gpg-sign", "HEAD^{tree}", "-m", "t"],
      ["-c", "core.excludesFile=", "check-ignore", "-q", "--", "f.txt"],
      ["remote"],
      ["remote", "get-url", "--all", "--end-of-options", "origin"],
    ];
    for (const args of calls) {
      const res = await git(repo, args);
      assert.doesNotMatch(res.stderr, /filter probe/i, `git ${args.join(" ")} asked the probe`);
    }
    assert.equal((await git(repo, ["remote"])).stdout, "origin");
  });

  it("a read behind a leading `--git-dir=` never asks the probe, so a broken probe cannot fail it", async () => {
    // `readGitDir`'s listing, as `gitDirRead.ts` makes it: read off `args[0]`,
    // the flag was taken for an unlisted subcommand and every reading paid the
    // probe, and failed with it.
    const { repo } = plantedRepo();
    const gitDir = path.join(repo, ".git");
    setMode("refused");

    const args = [`--git-dir=${gitDir}`, "config", "--list", "--show-scope", "--show-origin", "-z", "--includes"];
    const viaGit = await git(gitDir, args, { trim: false });
    const viaSync = gitSync(gitDir, args);
    setMode("pass");
    for (const [via, res] of [["git", viaGit], ["gitSync", viaSync]] as const) {
      assert.equal(res.ok, true, `${via}(): ${res.stderr}`);
      assert.match(res.stdout, /(?:^|\0)local\0file:[^\0]*\.git\/config\0filter\.x\.clean\n/, `${via}(): ${res.stdout}`);
    }
  });

  it("a content subcommand behind a leading `--git-dir=` is probed in that git directory, not cwd's", async () => {
    // The call reads the repository the flag names, so a probe of the one cwd
    // finds blanked nothing that repository defines.
    for (const viaSync of [false, true]) {
      const { repo, marker } = plantedRepo();
      const elsewhere = path.join(root, `repo${count++}`);
      committedRepo(elsewhere);
      fs.writeFileSync(path.join(elsewhere, "s.txt"), "two\n");
      const args = [`--git-dir=${path.join(repo, ".git")}`, "add", "-A"];

      setMode("pass");
      const res = viaSync ? gitSync(elsewhere, args) : await git(elsewhere, args);
      ranNothing(marker);
      assert.equal(res.ok, true, `${viaSync ? "gitSync" : "git"}(): ${res.stderr}`);

      setMode("refused");
      const refused = viaSync ? gitSync(elsewhere, args) : await git(elsewhere, args);
      setMode("pass");
      ranNothing(marker);
      assert.equal(refused.ok, false, `${viaSync ? "gitSync" : "git"}() ran without the probe`);
      assert.match(refused.stderr, /filter probe failed in .*, so git add was not run/, refused.stderr);
    }
  });

  it("control: under plain git, a content subcommand behind `--git-dir=` runs that git directory's driver", () => {
    const { repo, marker } = plantedRepo();
    const elsewhere = path.join(root, `repo${count++}`);
    committedRepo(elsewhere);
    fs.writeFileSync(path.join(elsewhere, "s.txt"), "two\n");
    plain(elsewhere, [`--git-dir=${path.join(repo, ".git")}`, "add", "-A"]);
    assert.equal(fs.existsSync(marker), true, "the named git directory's driver did not run");
  });

  /** A call from `cwd` that reads `repo` instead, by `-C` or by `--git-dir` and `--work-tree` as two words each. */
  const otherRepositoryShapes = (repo: string): [string, string[]][] => [
    ["-C", ["-C", repo, "add", "-A"]],
    ["--git-dir", ["--git-dir", path.join(repo, ".git"), "--work-tree", repo, "add", "-A"]],
  ];

  it("a content subcommand behind `-C <dir>` or a two-word `--git-dir <dir>` is refused before any git runs", async () => {
    // Either makes the call read a repository other than the one the probe
    // reads in cwd, so that one's drivers were never listed and ran unblanked
    // (board task c011fcd1).
    const calls = path.join(root, "calls");
    for (const viaSync of [false, true]) {
      const via = viaSync ? "gitSync" : "git";
      const { repo, marker } = plantedRepo();
      const elsewhere = path.join(root, `repo${count++}`);
      committedRepo(elsewhere);
      fs.writeFileSync(path.join(elsewhere, "s.txt"), "two\n");
      for (const [option, args] of otherRepositoryShapes(repo)) {
        fs.rmSync(calls, { force: true });
        setMode("log-calls");
        const res = viaSync ? gitSync(elsewhere, args) : await git(elsewhere, args);
        setMode("pass");

        ranNothing(marker);
        assert.equal(res.ok, false, `${via}() ran git ${args.join(" ")}`);
        assert.ok(res.stderr.includes(`${option} ahead of the subcommand`), `${via}(): ${res.stderr}`);
        const spawned = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "";
        assert.equal(spawned, "", `${via}() spawned git before refusing git ${args.join(" ")}`);
      }
    }
  });

  it("control: under plain git, `-C <dir>` and a two-word `--git-dir <dir>` each run that repository's driver", () => {
    for (const index of [0, 1]) {
      const { repo, marker } = plantedRepo();
      const elsewhere = path.join(root, `repo${count++}`);
      committedRepo(elsewhere);
      fs.writeFileSync(path.join(elsewhere, "s.txt"), "two\n");
      const [option, args] = otherRepositoryShapes(repo)[index];
      plain(elsewhere, args);
      assert.equal(fs.existsSync(marker), true, `${option}: the other repository's driver did not run`);
    }
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
 * git reports `[filter ""]` as the key `filter..clean`, and the probe's
 * patterns wanted at least one character between the dots, so a driver with
 * an empty name was never blanked and an attributes line `* filter=` (or
 * `* merge=`) ran its program on this app's `add`, `merge-tree` and `merge`
 * (board task 582bceef). `[hook ""]` has the same key shape and git 2.56.0
 * runs it (measured); a git that reads no `hook.*` key skips that case, as
 * `git.test.ts`'s hook cases do.
 */
describe("a driver or hook with an empty name is still blanked", () => {
  /** A repository whose `[hook ""]` leaves `marker` on every commit. */
  function emptyHookRepo(): { repo: string; marker: string } {
    const name = `repo${count++}`;
    const repo = path.join(root, name);
    committedRepo(repo, "f.txt");
    const marker = path.join(root, `${name}.ran`);
    plain(repo, ["config", "hook..command", `echo ran >> '${marker}'`]);
    plain(repo, ["config", "hook..event", "pre-commit"]);
    return { repo, marker };
  }

  let configHooksRun = false;
  before(() => {
    setMode("pass");
    const { repo, marker } = emptyHookRepo();
    plain(repo, ["commit", "-q", "--allow-empty", "-m", "probe"]);
    configHooksRun = fs.existsSync(marker);
  });

  it("git(): a clean filter with an empty name runs nothing on add", async () => {
    const { repo, marker } = plantedRepo("");
    const res = await git(repo, ["add", "-A"]);

    ranNothing(marker);
    assert.equal(res.ok, true, res.stderr);
  });

  it("gitSync(): a clean filter with an empty name runs nothing on add", () => {
    const { repo, marker } = plantedRepo("");
    const res = gitSync(repo, ["add", "-A"]);

    ranNothing(marker);
    assert.equal(res.ok, true, res.stderr);
  });

  it("git(): a merge driver with an empty name runs in neither merge-tree nor merge", async () => {
    const { repo, marker } = plantedMergeRepo("");
    const preview = await git(repo, ["merge-tree", "--write-tree", "-z", "main", "side"]);
    const merged = await git(repo, ["merge", "--no-edit", "side"]);

    ranNothing(marker);
    assert.equal(preview.ok, false, "a merge the driver was kept out of cannot have succeeded");
    assert.equal(merged.ok, false);
  });

  it("gitSync(): a merge driver with an empty name runs nothing in merge-tree", () => {
    const { repo, marker } = plantedMergeRepo("");
    const res = gitSync(repo, ["merge-tree", "--write-tree", "-z", "main", "side"]);

    ranNothing(marker);
    assert.equal(res.ok, false);
  });

  it("git() and gitSync(): a pre-commit hook with an empty name runs on neither commit", async (t) => {
    if (!configHooksRun) return t.skip("this git reads no hook defined in config, so there is nothing to switch off");
    const { repo, marker } = emptyHookRepo();

    const viaGit = await git(repo, ["commit", "--allow-empty", "-m", "t"]);
    assert.equal(viaGit.ok, true, viaGit.stderr);
    const viaSync = gitSync(repo, ["commit", "--allow-empty", "-m", "t2"]);
    assert.equal(viaSync.ok, true, viaSync.stderr);
    ranNothing(marker);
  });

  it("control: the filter and merge plants run under plain git", () => {
    const filter = plantedRepo("");
    plain(filter.repo, ["add", "-A"]);
    assert.equal(fs.existsSync(filter.marker), true, "the planted empty-name filter did not fire");

    const merge = plantedMergeRepo("");
    plain(merge.repo, ["merge-tree", "--write-tree", "-z", "main", "side"]);
    assert.equal(fs.existsSync(merge.marker), true, "the planted empty-name merge driver did not fire");
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
 * A superproject in `within` whose submodule `sm`, cloned the way `git
 * submodule add` does, has a clean filter planted in `.git/modules/sm/`, and a
 * stat-dirty file.
 */
function submoduleRepo(within = root): { repo: string; marker: string } {
  const name = `repo${count++}`;
  const repo = path.join(within, name);
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
 * A linked worktree `<repo>-wt` whose branch adds a repository `e` as a gitlink
 * no `.gitmodules` names, with the filter planted in `e`'s own `.git`: the
 * worktree's index lists it and the main checkout's does not.
 */
function worktreeEmbeddedRepo(): { tree: string; marker: string } {
  const name = `repo${count++}`;
  const repo = path.join(root, name);
  committedRepo(repo, "top.txt");
  const tree = `${repo}-wt`;
  plain(repo, ["worktree", "add", "-q", "-b", "wt", tree]);
  committedRepo(path.join(tree, "e"));
  plain(tree, ["-c", "advice.addEmbeddedRepo=false", "add", "e"]);
  plain(tree, ["commit", "-q", "-m", "e"]);
  const { prog, marker } = plantProgram(name);
  plantInGitDir(path.join(tree, "e", ".git"), [["filter.x.clean", prog]]);
  staleFile(path.join(tree, "e", "s.txt"));
  return { tree, marker };
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

  it("git() and gitSync(): status from a subdirectory spelled through a symlink runs nothing", async () => {
    // `../sm` folded onto the link named no submodule.
    for (const viaSync of [false, true]) {
      const { repo, marker } = submoduleRepo();
      fs.mkdirSync(path.join(repo, "below"));
      fs.symlinkSync(path.join(repo, "below"), `${repo}-link`);
      const args = ["status", "--porcelain"];
      const res = viaSync ? gitSync(`${repo}-link`, args) : await git(`${repo}-link`, args);

      ranNothing(marker);
      assert.equal(res.ok, true, `${viaSync ? "gitSync" : "git"}(): ${res.stderr}`);
    }
  });

  /** `nestedEmbeddedRepo` with `core.worktree` naming its top, and a directory outside it. */
  function nestedEmbeddedWorkTree(): { repo: string; elsewhere: string; marker: string } {
    const { repo, marker } = nestedEmbeddedRepo();
    plain(repo, ["config", "core.worktree", repo]);
    const elsewhere = `${repo}-elsewhere`;
    fs.mkdirSync(elsewhere);
    return { repo, elsewhere, marker };
  }

  it("git() and gitSync(): add -A behind `--git-dir=`, from outside the core.worktree it names, runs nothing", async () => {
    // From outside the work tree git prints the index's paths from its top,
    // and resolved against the cwd they named no submodule (board task
    // b934c65b). A fixture each, since a call that ran the filter once would
    // leave nothing stat-dirty for the next.
    for (const viaSync of [false, true]) {
      for (const outside of [false, true]) {
        const { repo, elsewhere, marker } = nestedEmbeddedWorkTree();
        const cwd = outside ? elsewhere : repo;
        const args = [`--git-dir=${path.join(repo, ".git")}`, "add", "-A"];
        const res = viaSync ? gitSync(cwd, args) : await git(cwd, args);

        ranNothing(marker);
        assert.equal(res.ok, true, `${viaSync ? "gitSync" : "git"}() from ${cwd}: ${res.stderr}`);
      }
    }
  });

  it("git() and gitSync(): status in a linked worktree runs nothing of a repository only its index lists", async () => {
    // The index is the worktree's own git directory's, not the common one's.
    for (const viaSync of [false, true]) {
      const { tree, marker } = worktreeEmbeddedRepo();
      const args = ["status", "--porcelain"];
      const res = viaSync ? gitSync(tree, args) : await git(tree, args);

      ranNothing(marker);
      assert.equal(res.ok, true, `${viaSync ? "gitSync" : "git"}(): ${res.stderr}`);
    }
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
    const linked = submoduleRepo();
    fs.mkdirSync(path.join(linked.repo, "below"));
    fs.symlinkSync(path.join(linked.repo, "below"), `${linked.repo}-link`);
    plain(`${linked.repo}-link`, ["status", "--porcelain"]);
    fired("status through a symlink", linked.marker);
    const outside = nestedEmbeddedWorkTree();
    const gitDir = `--git-dir=${path.join(outside.repo, ".git")}`;
    assert.equal(plain(outside.elsewhere, [gitDir, "rev-parse", "--show-cdup"]).trim(), outside.repo);
    assert.match(plain(outside.elsewhere, [gitDir, "ls-files", "--stage"]), /^160000 \S+ 0\ta$/m);
    plain(outside.elsewhere, [gitDir, "add", "-A"]);
    fired("add -A behind --git-dir= from outside its core.worktree", outside.marker);
    const worktree = worktreeEmbeddedRepo();
    plain(worktree.tree, ["status", "--porcelain"]);
    fired("status in a linked worktree", worktree.marker);
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

  /**
   * This process's user and a writable directory under the home the user
   * database gives it, which is where git places `~<user>/`, or null where
   * there is none; a sandbox may allow writes below a home and not in it.
   */
  function userHome(): { user: string; home: string; dir: string } | null {
    try {
      const { username, homedir } = os.userInfo();
      const dir = path.join(homedir, ".cache");
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return { user: username, home: homedir, dir };
    } catch {
      return null;
    }
  }
  const noUserHome = "this user has no home in the user database it can write below";

  const homeFiles: string[] = [];
  const homeTarget = (home: { dir: string }) => {
    const target = path.join(home.dir, `uf-git-probe-${process.pid}-${count++}.inc`);
    homeFiles.push(target);
    return target;
  };

  after(() => {
    setMode("pass");
    for (const file of homeFiles) fs.rmSync(file, { force: true });
  });

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
    fs.writeFileSync(writeTarget, path.join(repo, ".git", "evil.inc"));
    setMode("plant-include");
    const res = await git(repo, ["add", "-A"]);
    setMode("pass");

    ranNothing(marker);
    assert.equal(res.ok, false);
    assert.match(res.stderr, /evil\.inc changed while the filter probe read it/);
  });

  // From a subdirectory of a checkout git names `.git/config` relative to the
  // top, not to the directory it ran in, and the watch resolved the include
  // against the subdirectory (board task 10264b6b).
  it("git() and gitSync(): from a subdirectory, an included file written after the probe refuses the call", async () => {
    for (const viaSync of [false, true]) {
      const { repo, marker } = namedButUndefinedRepo();
      const sub = path.join(repo, "sub");
      fs.mkdirSync(sub);
      plain(repo, ["config", "include.path", "evil.inc"]);
      fs.writeFileSync(writeTarget, path.join(repo, ".git", "evil.inc"));
      setMode("plant-include");
      const res = viaSync ? gitSync(sub, ["add", "-A"]) : await git(sub, ["add", "-A"]);
      setMode("pass");

      ranNothing(marker);
      assert.equal(res.ok, false, `${viaSync ? "gitSync" : "git"}() ran the call`);
      assert.match(res.stderr, /\.git\/evil\.inc changed while the filter probe read it/);
    }
  });

  // git joins an include onto the directory of the file naming it and lets the
  // kernel follow `sub` before it applies `..`, and the watch folded `..` first:
  // it watched `.git/evil.inc`, which stays absent, while git read the file
  // beside the symlink's target (board task bbbe1aff).
  it("git() and gitSync(): an include whose `..` follows a symlink, written after the probe, refuses the call", async () => {
    for (const viaSync of [false, true]) {
      const { repo, marker } = namedButUndefinedRepo();
      const elsewhere = path.join(root, `elsewhere${count++}`);
      fs.mkdirSync(path.join(elsewhere, "dir"), { recursive: true });
      fs.symlinkSync(path.join(elsewhere, "dir"), path.join(repo, ".git", "sub"));
      plain(repo, ["config", "include.path", "sub/../evil.inc"]);
      fs.writeFileSync(writeTarget, path.join(elsewhere, "evil.inc"));
      setMode("plant-include");
      const res = viaSync ? gitSync(repo, ["add", "-A"]) : await git(repo, ["add", "-A"]);
      setMode("pass");

      ranNothing(marker);
      assert.equal(res.ok, false, `${viaSync ? "gitSync" : "git"}() ran the call`);
      assert.match(res.stderr, /\.git\/sub\/\.\.\/evil\.inc changed while the filter probe read it/);
      assert.equal(fs.existsSync(path.join(repo, ".git", "evil.inc")), false, "the plant went where the old watch looked");
    }
  });

  // A relative include inside a file reached that way is joined onto that
  // file's unfolded directory too, which is the origin git prints for it.
  it("git() and gitSync(): an include nested in a file reached through a symlink's `..` refuses the call", async () => {
    for (const viaSync of [false, true]) {
      const { repo, marker } = namedButUndefinedRepo();
      const elsewhere = path.join(root, `elsewhere${count++}`);
      fs.mkdirSync(path.join(elsewhere, "dir"), { recursive: true });
      fs.symlinkSync(path.join(elsewhere, "dir"), path.join(repo, ".git", "sub"));
      fs.writeFileSync(path.join(elsewhere, "outer.inc"), "[include]\n\tpath = inner.inc\n");
      plain(repo, ["config", "include.path", "sub/../outer.inc"]);
      fs.writeFileSync(writeTarget, path.join(elsewhere, "inner.inc"));
      setMode("plant-include");
      const res = viaSync ? gitSync(repo, ["add", "-A"]) : await git(repo, ["add", "-A"]);
      setMode("pass");

      ranNothing(marker);
      assert.equal(res.ok, false, `${viaSync ? "gitSync" : "git"}() ran the call`);
      assert.match(res.stderr, /\.git\/sub\/\.\.\/inner\.inc changed while the filter probe read it/);
    }
  });

  // `~/` is git's HOME with the rest appended as written, `..` and all.
  it("git() and gitSync(): an include under `~/` whose `..` follows a symlink refuses the call", async () => {
    const savedHome = process.env.HOME;
    try {
      for (const viaSync of [false, true]) {
        const { repo, marker } = namedButUndefinedRepo();
        const home = path.join(root, `home${count++}`);
        const elsewhere = path.join(root, `elsewhere${count++}`);
        fs.mkdirSync(path.join(elsewhere, "dir"), { recursive: true });
        fs.mkdirSync(home);
        fs.symlinkSync(path.join(elsewhere, "dir"), path.join(home, "sub"));
        plain(repo, ["config", "include.path", "~/sub/../evil.inc"]);
        fs.writeFileSync(writeTarget, path.join(elsewhere, "evil.inc"));
        process.env.HOME = home;
        setMode("plant-include");
        const res = viaSync ? gitSync(repo, ["add", "-A"]) : await git(repo, ["add", "-A"]);
        setMode("pass");

        ranNothing(marker);
        assert.equal(res.ok, false, `${viaSync ? "gitSync" : "git"}() ran the call`);
        assert.match(res.stderr, /\/sub\/\.\.\/evil\.inc changed while the filter probe read it/);
      }
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });

  it("control: git reads an include's `..` after following the symlink before it", () => {
    const { repo, marker } = namedButUndefinedRepo();
    const elsewhere = path.join(root, `elsewhere${count++}`);
    fs.mkdirSync(path.join(elsewhere, "dir"), { recursive: true });
    fs.symlinkSync(path.join(elsewhere, "dir"), path.join(repo, ".git", "sub"));
    plain(repo, ["config", "include.path", "sub/../evil.inc"]);
    fs.writeFileSync(path.join(elsewhere, "evil.inc"), `[filter "x"]\n\tclean = ${fs.readFileSync(plantFile, "utf8")}\n`);
    plain(repo, ["add", "-A"]);
    assert.equal(fs.existsSync(marker), true, "the driver included through the symlink did not fire");
  });

  // git places `~<user>/` through the user database, and the watch read it as
  // a path relative to `.git` (board task 10264b6b).
  it("git() and gitSync(): an include under `~<user>/` written after the probe refuses the call", async (t) => {
    const home = userHome();
    if (home === null) return t.skip(noUserHome);
    for (const viaSync of [false, true]) {
      const { repo, marker } = namedButUndefinedRepo();
      const target = homeTarget(home);
      plain(repo, ["config", "include.path", `~${home.user}/${path.relative(home.home, target)}`]);
      fs.writeFileSync(writeTarget, target);
      setMode("plant-include");
      const res = viaSync ? gitSync(repo, ["add", "-A"]) : await git(repo, ["add", "-A"]);
      setMode("pass");

      ranNothing(marker);
      assert.equal(res.ok, false, `${viaSync ? "gitSync" : "git"}() ran the call`);
      assert.match(res.stderr, new RegExp(`${path.basename(target).replace(/\./g, "\\.")} changed while the filter probe read it`));
    }
  });

  // git places `~<user>/` and leaves the rest as written, so a symlink below the
  // home is followed before `..` there too (board task bbbe1aff).
  it("git() and gitSync(): an include under `~<user>/` whose `..` follows a symlink refuses the call", async (t) => {
    const home = userHome();
    if (home === null) return t.skip(noUserHome);
    for (const viaSync of [false, true]) {
      const { repo, marker } = namedButUndefinedRepo();
      const elsewhere = path.join(root, `elsewhere${count++}`);
      fs.mkdirSync(path.join(elsewhere, "dir"), { recursive: true });
      const link = homeTarget(home);
      fs.symlinkSync(path.join(elsewhere, "dir"), link);
      plain(repo, ["config", "include.path", `~${home.user}/${path.relative(home.home, link)}/../evil.inc`]);
      fs.writeFileSync(writeTarget, path.join(elsewhere, "evil.inc"));
      setMode("plant-include");
      const res = viaSync ? gitSync(repo, ["add", "-A"]) : await git(repo, ["add", "-A"]);
      setMode("pass");

      ranNothing(marker);
      assert.equal(res.ok, false, `${viaSync ? "gitSync" : "git"}() ran the call`);
      assert.match(res.stderr, /\.inc\/\.\.\/evil\.inc changed while the filter probe read it/);
    }
  });

  it("control: an include under `~<user>/` is read from that user's home", (t) => {
    const home = userHome();
    if (home === null) return t.skip(noUserHome);
    const { repo, marker } = namedButUndefinedRepo();
    const target = homeTarget(home);
    plain(repo, ["config", "include.path", `~${home.user}/${path.relative(home.home, target)}`]);
    fs.writeFileSync(target, `[filter "x"]\n\tclean = ${fs.readFileSync(plantFile, "utf8")}\n`);
    plain(repo, ["add", "-A"]);
    assert.equal(fs.existsSync(marker), true, "the driver included from the user's home did not fire");
  });

  /**
   * An `include.path` under `%(prefix)/` and where git places it, in its own
   * install prefix, or null where this process cannot write there: the image's
   * git is under /usr.
   */
  const prefixFiles: string[] = [];
  function prefixInclude(): { value: string; target: string } | null {
    const value = `%(prefix)/uf-git-probe-${process.pid}-${count++}.inc`;
    const placed = plain(root, ["config", "--file", "/dev/null", "--type=path", "-z", "--default", value, "--get", "usagefoundry.include"]);
    const target = placed.replace(/\0$/, "");
    try {
      fs.accessSync(path.dirname(target), fs.constants.W_OK);
    } catch {
      return null;
    }
    prefixFiles.push(target);
    return { value, target };
  }
  const noWritablePrefix = "this git's install prefix is not writable here, so nothing can be planted in it";
  after(() => {
    for (const file of prefixFiles) fs.rmSync(file, { force: true });
  });

  // git expands `%(prefix)/` to its own install prefix, and the watch read it
  // as a path relative to `.git` (board task 12d0e24c).
  it("git() and gitSync(): an include under `%(prefix)/` written after the probe refuses the call", async (t) => {
    for (const viaSync of [false, true]) {
      const include = prefixInclude();
      if (include === null) return t.skip(noWritablePrefix);
      const { repo, marker } = namedButUndefinedRepo();
      plain(repo, ["config", "include.path", include.value]);
      fs.writeFileSync(writeTarget, include.target);
      setMode("plant-include");
      const res = viaSync ? gitSync(repo, ["add", "-A"]) : await git(repo, ["add", "-A"]);
      setMode("pass");

      ranNothing(marker);
      assert.equal(res.ok, false, `${viaSync ? "gitSync" : "git"}() ran the call`);
      assert.match(res.stderr, new RegExp(`${path.basename(include.target).replace(/\./g, "\\.")} changed while the filter probe read it`));
    }
  });

  // git expands `%(prefix)/` and appends the rest as written (board task bbbe1aff).
  it("git() and gitSync(): an include under `%(prefix)/` whose `..` follows a symlink refuses the call", async (t) => {
    for (const viaSync of [false, true]) {
      const include = prefixInclude();
      if (include === null) return t.skip(noWritablePrefix);
      const { repo, marker } = namedButUndefinedRepo();
      const elsewhere = path.join(root, `elsewhere${count++}`);
      fs.mkdirSync(path.join(elsewhere, "dir"), { recursive: true });
      fs.symlinkSync(path.join(elsewhere, "dir"), include.target);
      plain(repo, ["config", "include.path", `${include.value}/../evil.inc`]);
      fs.writeFileSync(writeTarget, path.join(elsewhere, "evil.inc"));
      setMode("plant-include");
      const res = viaSync ? gitSync(repo, ["add", "-A"]) : await git(repo, ["add", "-A"]);
      setMode("pass");

      ranNothing(marker);
      assert.equal(res.ok, false, `${viaSync ? "gitSync" : "git"}() ran the call`);
      assert.match(res.stderr, /\.inc\/\.\.\/evil\.inc changed while the filter probe read it/);
    }
  });

  it("control: an include under `%(prefix)/` is read from git's install prefix", (t) => {
    const include = prefixInclude();
    if (include === null) return t.skip(noWritablePrefix);
    const { repo, marker } = namedButUndefinedRepo();
    plain(repo, ["config", "include.path", include.value]);
    fs.writeFileSync(include.target, `[filter "x"]\n\tclean = ${fs.readFileSync(plantFile, "utf8")}\n`);
    plain(repo, ["add", "-A"]);
    assert.equal(fs.existsSync(marker), true, "the driver included from git's install prefix did not fire");
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

/**
 * In a reftable repository `$GIT_DIR/HEAD` is a stub (`ref: refs/heads/.invalid`)
 * and the real HEAD is in `reftable/`, so a fingerprint of the files backend's
 * HEAD sees nothing move when `symbolic-ref` flips an `onbranch:` include
 * (board task 4c645539). Needs a git of 2.45 or later; the image's 2.39.5 cannot
 * open such a repository, so the cases skip there.
 */
describe("an onbranch: include flipped in a reftable repository", () => {
  const makesReftable = (() => {
    const dir = fs.mkdtempSync(path.join(root, "reftable-probe-"));
    try {
      execFileSync(realGit, ["init", "-q", "--ref-format=reftable"], { cwd: dir, env: plainEnv(), stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  const noReftable = "this git cannot make a reftable repository, so there is no stub HEAD to watch";

  function reftableRepo(): { repo: string; marker: string } {
    const name = `repo${count++}`;
    const repo = path.join(root, name);
    fs.mkdirSync(repo);
    plain(repo, ["init", "-q", "-b", "main", "--ref-format=reftable"]);
    plain(repo, ["config", "user.email", "a@b.c"]);
    plain(repo, ["config", "user.name", "a"]);
    fs.writeFileSync(path.join(repo, "f.txt"), "one\n");
    plain(repo, ["add", "-A"]);
    plain(repo, ["commit", "-q", "-m", "init"]);
    plain(repo, ["branch", "uf/x"]);
    const { prog, marker } = plantProgram(name);
    fs.writeFileSync(path.join(repo, ".git", "evil.inc"), `[filter "x"]\n\tclean = ${prog}\n`);
    plain(repo, ["config", "includeIf.onbranch:uf/**.path", "evil.inc"]);
    fs.mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "info", "attributes"), "* filter=x\n");
    fs.writeFileSync(path.join(repo, "f.txt"), "two\n");
    return { repo, marker };
  }

  after(() => setMode("pass"));

  it("control: HEAD is a stub and the flip runs the driver under plain git", (t) => {
    if (!makesReftable) return t.skip(noReftable);
    const { repo, marker } = reftableRepo();
    assert.equal(fs.readFileSync(path.join(repo, ".git", "HEAD"), "utf8").trim(), "ref: refs/heads/.invalid");
    plain(repo, ["add", "-A"]);
    assert.equal(fs.existsSync(marker), false, "the onbranch: include held before HEAD moved");
    plain(repo, ["symbolic-ref", "HEAD", "refs/heads/uf/x"]);
    fs.writeFileSync(path.join(repo, "f.txt"), "three\n");
    plain(repo, ["add", "-A"]);
    assert.equal(fs.existsSync(marker), true, "HEAD on uf/x did not run the driver");
  });

  const add = async (repo: string, viaSync: boolean) =>
    viaSync ? gitSync(repo, ["add", "-A"]) : await git(repo, ["add", "-A"]);

  it("git() and gitSync(): HEAD moved onto a branch an onbranch: include matches refuses the call", async (t) => {
    if (!makesReftable) return t.skip(noReftable);
    for (const viaSync of [false, true]) {
      const { repo, marker } = reftableRepo();
      setMode("flip-head");
      const res = await add(repo, viaSync);
      setMode("pass");

      ranNothing(marker);
      assert.equal(res.ok, false, `${viaSync ? "gitSync" : "git"}() ran the call`);
      assert.match(res.stderr, /reftable\/tables\.list changed while the filter probe read it/);
    }
  });

  // A linked worktree's HEAD is in a stack of its own, `worktrees/<id>/reftable`,
  // which the flip changes and the common stack does not (measured, 2.56.0).
  it("git() and gitSync(): a linked worktree's HEAD moved onto a branch an onbranch: include matches refuses the call", async (t) => {
    if (!makesReftable) return t.skip(noReftable);
    for (const viaSync of [false, true]) {
      const { repo, marker } = reftableRepo();
      const tree = `${repo}-w`;
      plain(repo, ["worktree", "add", "-q", "-b", "wb", tree]);
      fs.writeFileSync(path.join(tree, "f.txt"), "three\n");
      setMode("flip-head");
      const res = await add(tree, viaSync);
      setMode("pass");

      ranNothing(marker);
      assert.equal(res.ok, false, `${viaSync ? "gitSync" : "git"}() ran the call`);
      assert.match(res.stderr, /worktrees\/[^/]+\/reftable\/tables\.list changed while the filter probe read it/);
    }
  });

  it("git() and gitSync(): the branch HEAD names made a symbolic ref to one onbranch: matches refuses the call", async (t) => {
    if (!makesReftable) return t.skip(noReftable);
    for (const viaSync of [false, true]) {
      const { repo, marker } = reftableRepo();
      fs.writeFileSync(path.join(root, "run-git-args"), "symbolic-ref refs/heads/main refs/heads/uf/x");
      setMode("run-git");
      const res = await add(repo, viaSync);
      setMode("pass");

      ranNothing(marker);
      assert.equal(res.ok, false, `${viaSync ? "gitSync" : "git"}() ran the call`);
      assert.match(res.stderr, /reftable\/tables\.list changed while the filter probe read it/);
    }
  });

  // The cost of watching `tables.list` and not HEAD: nothing in a reftable says
  // which ref an update was to, so a commit refuses the call it overlaps. Said
  // here so that a change that lifts it is made knowing what it must still stop.
  it("git() and gitSync(): a commit between the probe and the call refuses it, and says a ref update did", async (t) => {
    if (!makesReftable) return t.skip(noReftable);
    for (const viaSync of [false, true]) {
      const { repo, marker } = reftableRepo();
      fs.writeFileSync(path.join(root, "run-git-args"), "commit -q --allow-empty -m x");
      setMode("run-git");
      const res = await add(repo, viaSync);
      setMode("pass");

      ranNothing(marker);
      assert.equal(res.ok, false, `${viaSync ? "gitSync" : "git"}() ran the call`);
      assert.match(res.stderr, /A ref update in a reftable repository changes this file/);
    }
  });

  it("git() and gitSync(): a call that overlaps no ref update runs", async (t) => {
    if (!makesReftable) return t.skip(noReftable);
    for (const viaSync of [false, true]) {
      const { repo, marker } = reftableRepo();
      const res = await add(repo, viaSync);

      assert.equal(res.ok, true, res.stderr);
      ranNothing(marker);
    }
  });
});

/**
 * An `includeIf` condition is evaluated by the call as well as by the probe,
 * and what it reads is not configuration: `onbranch:` reads the branch HEAD
 * names, through any symbolic ref behind it, and `gitdir:` the git directory
 * found from where git runs. A flip of either between the probe and the call
 * made live in the call a driver the probe never saw (board task 9d44342d:
 * 41 of 200 calls against a checkout loop, 2.39.5). The stub flips each while
 * the index is listed, so the race is deterministic.
 */
describe("an include condition flipped between the probe and the call is refused", () => {
  /**
   * A repository whose filter `x` is defined only behind
   * `includeIf "<condition>"`, which does not hold yet, with a stat-dirty file
   * its clean filter would be run on.
   */
  function conditionalRepo(condition: (repo: string) => string): { repo: string; marker: string } {
    const name = `repo${count++}`;
    const repo = path.join(root, name);
    committedRepo(repo, "f.txt");
    plain(repo, ["branch", "uf/x"]);
    const { prog, marker } = plantProgram(name);
    fs.writeFileSync(path.join(repo, ".git", "evil.inc"), `[filter "x"]\n\tclean = ${prog}\n`);
    plain(repo, ["config", `includeIf.${condition(repo)}.path`, "evil.inc"]);
    fs.mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "info", "attributes"), "* filter=x\n");
    fs.writeFileSync(path.join(repo, "f.txt"), "two\n");
    return { repo, marker };
  }

  /**
   * Two linked worktrees of a repository whose filter is included only for
   * the second one's git directory; the call runs in the first, whose `.git`
   * file `pointAtOther` would aim at the second's.
   */
  function twoWorktrees(): { tree: string; pointAtOther: string; marker: string } {
    let other = "";
    const { repo, marker } = conditionalRepo((repo) => {
      other = path.join(repo, ".git", "worktrees", `${path.basename(repo)}-w2`);
      return `gitdir:${other}`;
    });
    const tree = `${repo}-w1`;
    plain(repo, ["worktree", "add", "-q", "--detach", tree]);
    plain(repo, ["worktree", "add", "-q", "--detach", `${repo}-w2`]);
    fs.writeFileSync(path.join(tree, "f.txt"), "two\n");
    return { tree, pointAtOther: `gitdir: ${other}\n`, marker };
  }

  const add =async (cwd: string, viaSync: boolean) =>
    viaSync ? gitSync(cwd, ["add", "-A"]) : await git(cwd, ["add", "-A"]);

  after(() => setMode("pass"));

  it("git() and gitSync(): HEAD moved onto a branch an onbranch: include matches refuses the call", async () => {
    for (const viaSync of [false, true]) {
      const { repo, marker } = conditionalRepo(() => "onbranch:uf/**");
      setMode("flip-head");
      const res = await add(repo, viaSync);
      setMode("pass");

      ranNothing(marker);
      assert.equal(res.ok, false, `${viaSync ? "gitSync" : "git"}() ran the call`);
      assert.match(res.stderr, /\.git\/HEAD changed while the filter probe read it/);
    }
  });

  it("git() and gitSync(): the branch HEAD names made a symbolic ref to one onbranch: matches refuses the call", async () => {
    for (const viaSync of [false, true]) {
      const { repo, marker } = conditionalRepo(() => "onbranch:uf/**");
      fs.writeFileSync(writeTarget, path.join(repo, ".git", "refs", "heads", "main"));
      fs.writeFileSync(rewriteContent, "ref: refs/heads/uf/x\n");
      setMode("rewrite");
      const res = await add(repo, viaSync);
      setMode("pass");

      ranNothing(marker);
      assert.equal(res.ok, false, `${viaSync ? "gitSync" : "git"}() ran the call`);
      assert.match(res.stderr, /refs\/heads\/main changed while the filter probe read it/);
    }
  });

  it("git() and gitSync(): a worktree's .git pointed at a git directory a gitdir: include matches refuses the call", async () => {
    for (const viaSync of [false, true]) {
      const { tree, pointAtOther, marker } = twoWorktrees();
      fs.writeFileSync(writeTarget, path.join(tree, ".git"));
      fs.writeFileSync(rewriteContent, pointAtOther);
      setMode("rewrite");
      const res = await add(tree, viaSync);
      setMode("pass");

      ranNothing(marker);
      assert.equal(res.ok, false, `${viaSync ? "gitSync" : "git"}() ran the call`);
      assert.match(res.stderr, /-w1\/\.git changed while the filter probe read it/);
    }
  });

  it("control: each flip runs the driver under plain git, and nothing runs before it", () => {
    const head = conditionalRepo(() => "onbranch:uf/**");
    plain(head.repo, ["add", "-A"]);
    assert.equal(fs.existsSync(head.marker), false, "the onbranch: include held before HEAD moved");
    plain(head.repo, ["symbolic-ref", "HEAD", "refs/heads/uf/x"]);
    fs.writeFileSync(path.join(head.repo, "f.txt"), "three\n");
    plain(head.repo, ["add", "-A"]);
    assert.equal(fs.existsSync(head.marker), true, "HEAD on uf/x did not run the driver");

    const ref = conditionalRepo(() => "onbranch:uf/**");
    fs.writeFileSync(path.join(ref.repo, ".git", "refs", "heads", "main"), "ref: refs/heads/uf/x\n");
    plain(ref.repo, ["add", "-A"]);
    assert.equal(fs.existsSync(ref.marker), true, "main as a symbolic ref to uf/x did not run the driver");

    const worktrees = twoWorktrees();
    plain(worktrees.tree, ["add", "-A"]);
    assert.equal(fs.existsSync(worktrees.marker), false, "the gitdir: include held in the first worktree");
    fs.writeFileSync(path.join(worktrees.tree, ".git"), worktrees.pointAtOther);
    fs.writeFileSync(path.join(worktrees.tree, "f.txt"), "three\n");
    plain(worktrees.tree, ["add", "-A"]);
    assert.equal(fs.existsSync(worktrees.marker), true, "the first worktree aimed at the second's git directory did not run the driver");
  });
});

/**
 * A linked worktree's git directory holds a `commondir` file naming the
 * repository's common directory, which is where git reads `config` and the
 * branches from. Rewritten to another repository's `.git` between the probe
 * and the call, it made the call read a configuration the probe never did,
 * and run a filter defined only there (board task 2290ab7a, measured, 2.39.5).
 */
describe("a worktree's commondir rewritten between the probe and the call is refused", () => {
  /**
   * A linked worktree with a stat-dirty file, and a clone of its repository
   * whose `.git/config` alone defines filter `x`. Both name it in
   * `info/attributes`, which git reads from the common directory.
   */
  function worktreeAndOtherCommon(): { tree: string; commondir: string; other: string; marker: string } {
    const name = `repo${count++}`;
    const repo = path.join(root, name);
    committedRepo(repo, "f.txt");
    const otherRepo = `${repo}-other`;
    plain(root, ["clone", "-q", repo, otherRepo]);
    const { prog, marker } = plantProgram(name);
    plantInGitDir(path.join(otherRepo, ".git"), [["filter.x.clean", prog]]);
    fs.mkdirSync(path.join(repo, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "info", "attributes"), "* filter=x\n");
    const tree = `${repo}-w1`;
    plain(repo, ["worktree", "add", "-q", "--detach", tree]);
    fs.writeFileSync(path.join(tree, "f.txt"), "two\n");
    return {
      tree,
      commondir: path.join(repo, ".git", "worktrees", path.basename(tree), "commondir"),
      other: `${path.join(otherRepo, ".git")}\n`,
      marker,
    };
  }

  after(() => setMode("pass"));

  it("git() and gitSync(): commondir pointed at another repository refuses the call", async () => {
    for (const viaSync of [false, true]) {
      const { tree, commondir, other, marker } = worktreeAndOtherCommon();
      fs.writeFileSync(writeTarget, commondir);
      fs.writeFileSync(rewriteContent, other);
      setMode("rewrite");
      const res = viaSync ? gitSync(tree, ["add", "-A"]) : await git(tree, ["add", "-A"]);
      setMode("pass");

      ranNothing(marker);
      assert.equal(res.ok, false, `${viaSync ? "gitSync" : "git"}() ran the call`);
      assert.match(res.stderr, /-w1\/commondir changed while the filter probe read it/);
    }
  });

  it("control: commondir pointed at another repository runs its driver under plain git, and nothing runs before it", () => {
    const { tree, commondir, other, marker } = worktreeAndOtherCommon();
    plain(tree, ["add", "-A"]);
    assert.equal(fs.existsSync(marker), false, "the driver ran from the worktree's own repository");
    fs.writeFileSync(commondir, other);
    fs.writeFileSync(path.join(tree, "f.txt"), "three\n");
    plain(tree, ["add", "-A"]);
    assert.equal(fs.existsSync(marker), true, "the worktree aimed at the other repository did not run its driver");
  });
});

/**
 * At each level on its way up where `<at>/.git` is absent, git asks whether
 * `<at>` is itself a git directory (a valid `HEAD`, and `objects/` and `refs/`
 * in the directory its `commondir` names, or in it), and where `<at>/.git` is
 * a directory, whether that is one. A subdirectory made one between the probe
 * and the call is found first, and with `core.worktree` naming the real top
 * the call reads its `config`, which the probe never did (board task fbd6d8dd,
 * measured, 2.39.5). Each case makes the last missing piece while the index is
 * listed.
 */
describe("a subdirectory made a git directory between the probe and the call is refused", () => {
  /**
   * A committed repository whose tracked subdirectory `sub` (or `sub/.git`)
   * holds everything a git directory needs but `missing`, with a `config` that
   * names the repository as its work tree and defines filter `x`, which the
   * repository's own configuration does not.
   */
  function almostGitDir(
    candidate: (sub: string) => string,
    missing: "HEAD" | "objects" | "common objects",
  ): { repo: string; sub: string; last: string; marker: string } {
    const name = `repo${count++}`;
    const repo = path.join(root, name);
    committedRepo(repo, "f.txt");
    const sub = path.join(repo, "sub");
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, "s.txt"), "s\n");
    plain(repo, ["add", "-A"]);
    plain(repo, ["commit", "-q", "-m", "sub"]);
    fs.writeFileSync(path.join(sub, "s.txt"), "two\n");
    const { prog, marker } = plantProgram(name);
    const dir = candidate(sub);
    // With a `commondir`, git takes `core.worktree` only from `config.worktree`.
    const common = missing === "common objects" ? `${repo}-common` : dir;
    fs.mkdirSync(path.join(common, "refs", "heads"), { recursive: true });
    fs.mkdirSync(path.join(common, "info"), { recursive: true });
    fs.writeFileSync(path.join(common, "info", "attributes"), "* filter=x\n");
    if (missing === "common objects") {
      fs.writeFileSync(path.join(dir, "commondir"), `${common}\n`);
      fs.writeFileSync(path.join(dir, "config.worktree"), `[core]\n\tworktree = ${repo}\n`);
      fs.writeFileSync(
        path.join(common, "config"),
        `[core]\n\trepositoryformatversion = 1\n[extensions]\n\tworktreeConfig = true\n[filter "x"]\n\tclean = ${prog}\n`,
      );
    } else {
      // Without `repositoryformatversion` git discards `core.worktree` here
      // and finds no work tree, so the call fails rather than runs.
      fs.writeFileSync(
        path.join(dir, "config"),
        `[core]\n\trepositoryformatversion = 0\n\tworktree = ${repo}\n[filter "x"]\n\tclean = ${prog}\n`,
      );
    }
    if (missing !== "HEAD") fs.writeFileSync(path.join(dir, "HEAD"), "ref: refs/heads/main\n");
    if (missing === "HEAD") fs.mkdirSync(path.join(common, "objects"), { recursive: true });
    const last = missing === "HEAD" ? path.join(dir, "HEAD") : path.join(common, "objects");
    return { repo, sub, last, marker };
  }

  const ways = [
    { says: "the subdirectory given a HEAD", candidate: (sub: string) => sub, missing: "HEAD" as const },
    { says: "an empty .git directory in it given a HEAD", candidate: (sub: string) => path.join(sub, ".git"), missing: "HEAD" as const },
    { says: "the subdirectory, HEAD already there, given objects/", candidate: (sub: string) => sub, missing: "objects" as const },
    { says: "the subdirectory, HEAD and commondir already there, given the common directory's objects/", candidate: (sub: string) => sub, missing: "common objects" as const },
  ];

  /** Makes what `almostGitDir` left missing, as the stub does. */
  const complete = (last: string) =>
    path.basename(last) === "HEAD" ? fs.writeFileSync(last, "ref: refs/heads/main\n") : fs.mkdirSync(last);

  after(() => setMode("pass"));

  for (const way of ways) {
    it(`git() and gitSync(): ${way.says} refuses a call from the subdirectory`, async () => {
      for (const viaSync of [false, true]) {
        const { sub, last, marker } = almostGitDir(way.candidate, way.missing);
        fs.writeFileSync(writeTarget, last);
        fs.writeFileSync(rewriteContent, "ref: refs/heads/main\n");
        setMode(path.basename(last) === "HEAD" ? "rewrite" : "make-dir");
        const res = viaSync ? gitSync(sub, ["add", "-A"]) : await git(sub, ["add", "-A"]);
        setMode("pass");

        ranNothing(marker);
        assert.equal(res.ok, false, `${viaSync ? "gitSync" : "git"}() ran the call`);
        const named = last.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        assert.match(res.stderr, new RegExp(`${named} changed while the filter probe read it`));
      }
    });
  }

  /**
   * A cwd two levels below `sub`, spelled through a link to the level between:
   * folded onto the link, the way back up to the top passes no `sub`.
   */
  const linkedBelow = (repo: string, sub: string) => {
    fs.mkdirSync(path.join(sub, "d", "x"), { recursive: true });
    fs.symlinkSync(path.join(sub, "d"), `${repo}-link`);
    return path.join(`${repo}-link`, "x");
  };

  it("git() and gitSync(): each way, made above a cwd spelled through a symlink, refuses the call", async () => {
    // `--show-cdup` counts physical parents, and folded onto the link the walk
    // from cwd never reached `sub` (board task cdf5ae4b).
    for (const way of ways) {
      for (const viaSync of [false, true]) {
        const via = `${viaSync ? "gitSync" : "git"}(), ${way.says}`;
        const { repo, sub, last, marker } = almostGitDir(way.candidate, way.missing);
        const cwd = linkedBelow(repo, sub);
        fs.writeFileSync(writeTarget, last);
        fs.writeFileSync(rewriteContent, "ref: refs/heads/main\n");
        setMode(path.basename(last) === "HEAD" ? "rewrite" : "make-dir");
        const res = viaSync ? gitSync(cwd, ["add", "-A"]) : await git(cwd, ["add", "-A"]);
        setMode("pass");

        ranNothing(marker);
        assert.equal(res.ok, false, `${via} ran the call`);
        assert.ok(res.stderr.includes(`${last} changed while the filter probe read it`), `${via}: ${res.stderr}`);
      }
    }
  });

  it("git() and gitSync(): a call from a subdirectory with nothing made there still runs", async () => {
    for (const viaSync of [false, true]) {
      const { repo, sub, marker } = almostGitDir((dir) => dir, "HEAD");
      for (const cwd of [sub, linkedBelow(repo, sub)]) {
        const res = viaSync ? gitSync(cwd, ["add", "-A"]) : await git(cwd, ["add", "-A"]);
        ranNothing(marker);
        assert.equal(res.ok, true, `${viaSync ? "gitSync" : "git"}() in ${cwd}: ${res.stderr}`);
      }
    }
  });

  it("control: each subdirectory made a git directory runs its driver under plain git, and nothing runs before it", () => {
    for (const way of ways) {
      const { sub, last, marker } = almostGitDir(way.candidate, way.missing);
      plain(sub, ["add", "-A"]);
      assert.equal(fs.existsSync(marker), false, `${way.says}: the driver ran before the last piece was made`);
      complete(last);
      assert.equal(plain(sub, ["rev-parse", "--absolute-git-dir"]).trim(), way.candidate(sub), way.says);
      plain(sub, ["add", "-A"]);
      assert.equal(fs.existsSync(marker), true, `${way.says}: the driver did not run`);
    }
  });

  it("control: from a cwd spelled through a symlink, each runs its driver under plain git", () => {
    for (const way of ways) {
      const { repo, sub, last, marker } = almostGitDir(way.candidate, way.missing);
      const cwd = linkedBelow(repo, sub);
      plain(cwd, ["add", "-A"]);
      assert.equal(fs.existsSync(marker), false, `${way.says}: the driver ran before the last piece was made`);
      assert.equal(plain(cwd, ["rev-parse", "--show-cdup"]).trim(), "../../../", way.says);
      complete(last);
      assert.equal(plain(cwd, ["rev-parse", "--absolute-git-dir"]).trim(), way.candidate(sub), way.says);
      plain(cwd, ["add", "-A"]);
      assert.equal(fs.existsSync(marker), true, `${way.says}: the driver did not run`);
    }
  });
});

/**
 * git's discovery takes a directory for a git directory only while it has a
 * `HEAD`, `objects/` and `refs/`, so the one the probe found stops being one
 * when its `objects/` or `refs/` is moved away, and git climbs past it to the
 * next repository up and reads that one's configuration, which the probe never
 * did (board task 9ef321d6, measured, 2.39.5). Each case moves one away while
 * the index is listed.
 */
describe("a git directory the probe found that stops being one is refused", () => {
  /**
   * A repository `outer` whose configuration defines filter `x` for every path,
   * and inside it a separate committed repository `inner`, with a modified file
   * and no driver of its own.
   */
  function nestedRepo(): { inner: string; outer: string; marker: string } {
    const name = `repo${count++}`;
    const outer = path.join(root, name);
    committedRepo(outer, "f.txt");
    const { prog, marker } = plantProgram(name);
    plantInGitDir(path.join(outer, ".git"), [["filter.x.clean", prog]]);
    const inner = path.join(outer, "r");
    committedRepo(inner);
    fs.writeFileSync(path.join(inner, "s.txt"), "two\n");
    return { inner, outer, marker };
  }

  /** A file whose blob would be the first object in its fan-out directory, so writing it changes `objects/` itself. */
  function blobInNewFanOut(inner: string): string {
    for (let n = 0; ; n++) {
      const content = `blob ${n}\n`;
      const id = createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0${content}`).digest("hex");
      if (fs.existsSync(path.join(inner, ".git", "objects", id.slice(0, 2)))) continue;
      const file = path.join(root, `${path.basename(path.dirname(inner))}.blob`);
      fs.writeFileSync(file, content);
      return file;
    }
  }

  after(() => setMode("pass"));

  for (const part of ["objects", "refs"]) {
    it(`git() and gitSync(): its ${part}/ moved away refuses the call`, async () => {
      for (const viaSync of [false, true]) {
        const { inner, marker } = nestedRepo();
        const moved = path.join(inner, ".git", part);
        fs.writeFileSync(writeTarget, moved);
        setMode("move-away");
        const res = viaSync ? gitSync(inner, ["add", "-A"]) : await git(inner, ["add", "-A"]);
        setMode("pass");

        ranNothing(marker);
        assert.equal(fs.existsSync(moved), false, "the stub did not move it");
        assert.equal(res.ok, false, `${viaSync ? "gitSync" : "git"}() ran the call`);
        const named = moved.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        assert.match(res.stderr, new RegExp(`${named} changed while the filter probe read it`));
      }
    });
  }

  it("git() and gitSync(): a ref or an object written straight into them still runs the call", async () => {
    // Every commit writes inside both, and `git stash` writes `refs/stash` in
    // `refs/` itself, so a watch on their ctime would refuse each call that
    // overlapped either. The fixture checks that the write did move the ctime.
    for (const viaSync of [false, true]) {
      for (const part of ["refs", "objects"]) {
        const { inner, marker } = nestedRepo();
        const dir = path.join(inner, ".git", part);
        const write = part === "refs" ? "update-ref refs/stash HEAD" : `hash-object -w ${blobInNewFanOut(inner)}`;
        fs.writeFileSync(path.join(root, "run-git-args"), write);
        const ctime = fs.statSync(dir, { bigint: true }).ctimeNs;
        setMode("run-git");
        const res = viaSync ? gitSync(inner, ["add", "-A"]) : await git(inner, ["add", "-A"]);
        setMode("pass");

        ranNothing(marker);
        assert.notEqual(fs.statSync(dir, { bigint: true }).ctimeNs, ctime, `${write} left ${part}/ as it was`);
        assert.equal(res.ok, true, `${viaSync ? "gitSync" : "git"}() after ${write}: ${res.stderr}`);
      }
    }
  });

  /**
   * `nestedRepo` the other way round: the inner repository defines filter `x`
   * and the enclosing one defines no driver, so a probe that climbs past the
   * inner one lists nothing to blank.
   */
  function drivenInnerRepo(): { inner: string; marker: string } {
    const name = `repo${count++}`;
    const outer = path.join(root, name);
    committedRepo(outer, "f.txt");
    const inner = path.join(outer, "r");
    committedRepo(inner);
    const { prog, marker } = plantProgram(name);
    plantInGitDir(path.join(inner, ".git"), [["filter.x.clean", prog]]);
    fs.writeFileSync(path.join(inner, "s.txt"), "two\n");
    return { inner, marker };
  }

  for (const part of ["objects", "refs"]) {
    it(`git() and gitSync(): its ${part}/ moved away only while the probe reads refuses the call`, async () => {
      // A rename away and back keeps the inode, so the fingerprint reads the
      // same at both ends while the probe lists the enclosing repository's
      // drivers and not this one's (board task f3122092).
      const moves = path.join(root, "moved");
      for (const viaSync of [false, true]) {
        const via = viaSync ? "gitSync" : "git";
        const { inner, marker } = drivenInnerRepo();
        const moved = path.join(inner, ".git", part);
        fs.writeFileSync(writeTarget, moved);
        fs.rmSync(moves, { force: true });
        setMode("move-away-while-probing");
        const res = viaSync ? gitSync(inner, ["add", "-A"]) : await git(inner, ["add", "-A"]);
        setMode("pass");

        ranNothing(marker);
        assert.equal(fs.readFileSync(moves, "utf8"), `${moved}\n`, `${via}(): the stub did not move it once`);
        assert.equal(fs.existsSync(moved), true, "the stub did not move it back");
        assert.equal(res.ok, false, `${via}() ran the call`);
        assert.ok(res.stderr.includes(`did not read ${path.join(inner, ".git")}`), `${via}(): ${res.stderr}`);
      }
    });
  }

  /** `submoduleRepo` inside a repository with no driver and no gitlink of its own. */
  function submoduleWithin(): { repo: string; marker: string } {
    const outer = path.join(root, `repo${count++}`);
    committedRepo(outer, "f.txt");
    return submoduleRepo(outer);
  }

  for (const part of ["objects", "refs"]) {
    it(`git() and gitSync(): its ${part}/ moved away only while the index is listed refuses the call`, async () => {
      // By discovery the listing read the enclosing repository's index, which
      // names no gitlink, so the submodule was never probed (board task
      // 8e9fe2ed).
      const moves = path.join(root, "moved");
      for (const viaSync of [false, true]) {
        const via = viaSync ? "gitSync" : "git";
        const { repo, marker } = submoduleWithin();
        const moved = path.join(repo, ".git", part);
        fs.writeFileSync(writeTarget, moved);
        fs.rmSync(moves, { force: true });
        setMode("move-away-while-listing");
        const res = viaSync ? gitSync(repo, ["status", "--porcelain"]) : await git(repo, ["status", "--porcelain"]);
        setMode("pass");

        ranNothing(marker);
        assert.equal(fs.readFileSync(moves, "utf8"), `${moved}\n`, `${via}(): the stub did not move it once`);
        assert.equal(fs.existsSync(moved), true, "the stub did not move it back");
        assert.equal(res.ok, false, `${via}() ran the call`);
        assert.match(res.stderr, /so git status was not run: git --git-dir=\S+ ls-files .*not a git repository/, `${via}(): ${res.stderr}`);
      }
    });
  }

  it("git() and gitSync(): an enclosing repository that includes the probe's marker file itself is still refused", async () => {
    // The marker it lists is in its own scope, not the command line's.
    for (const viaSync of [false, true]) {
      const via = viaSync ? "gitSync" : "git";
      const { inner, marker } = drivenInnerRepo();
      fs.writeFileSync(writeTarget, path.join(inner, ".git", "objects"));
      setMode("move-away-while-probing-marker-included");
      const res = viaSync ? gitSync(inner, ["add", "-A"]) : await git(inner, ["add", "-A"]);
      setMode("pass");

      ranNothing(marker);
      const included = plain(path.dirname(inner), ["config", "include.path"]).trim();
      assert.match(fs.readFileSync(included, "utf8"), /probed = true/, `${via}(): the stub did not include the marker`);
      assert.equal(res.ok, false, `${via}() ran the call`);
      assert.ok(res.stderr.includes(`did not read ${path.join(inner, ".git")}`), `${via}(): ${res.stderr}`);
    }
  });

  it("git() and gitSync(): a marker file that cannot be written fails the call rather than throwing", async () => {
    const state = (globalThis as unknown as { __ufGitProbeMarker: { file?: string } }).__ufGitProbeMarker;
    const tmpdir = process.env.TMPDIR;
    const restoreTmpdir = () => {
      if (tmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = tmpdir;
    };
    const { inner, marker } = drivenInnerRepo();
    await git(inner, ["status", "--porcelain"]);
    try {
      for (const viaSync of [false, true]) {
        // A cached file that is gone, and nowhere to make another.
        state.file = path.join(root, "no-such-dir", "marker");
        process.env.TMPDIR = path.join(root, "no-such-tmp");
        const res = viaSync ? gitSync(inner, ["add", "-A"]) : await git(inner, ["add", "-A"]);
        restoreTmpdir();
        ranNothing(marker);
        assert.equal(res.ok, false, `${viaSync ? "gitSync" : "git"}() ran the call`);
        assert.match(res.stderr, /marker file could not be written/, res.stderr);
      }
    } finally {
      restoreTmpdir();
      state.file = undefined;
    }
  });

  it("control: under plain git, either moved away only while config is read hides the inner driver from it, and add -A runs it", () => {
    for (const part of ["objects", "refs"]) {
      const { inner, marker } = drivenInnerRepo();
      const listing = ["config", "--get-regexp", "^filter\\."];
      assert.match(plain(inner, listing), /^filter\.x\.clean /, part);
      const moved = path.join(inner, ".git", part);
      fs.renameSync(moved, `${moved}.away`);
      assert.throws(
        () => plain(inner, listing),
        (err: { status?: number; stdout?: string }) => err.status === 1 && err.stdout === "",
        `${part}: the inner driver was still listed`,
      );
      fs.renameSync(`${moved}.away`, moved);
      plain(inner, ["add", "-A"]);
      assert.equal(fs.existsSync(marker), true, `${part}: the inner repository's driver did not run`);
    }
  });

  it("control: under plain git, either moved away has the superproject's listing name no gitlink, and status runs the submodule's driver", () => {
    for (const part of ["objects", "refs"]) {
      const { repo, marker } = submoduleWithin();
      const listing = ["ls-files", "--stage", "--", ":/"];
      assert.match(plain(repo, listing), /^160000 \S+ 0\tsm$/m, part);
      const moved = path.join(repo, ".git", part);
      fs.renameSync(moved, `${moved}.away`);
      const listed = plain(repo, listing);
      assert.doesNotMatch(listed, /^160000 /m, `${part}: the listing still named a gitlink`);
      assert.match(listed, /\t\.\.\/f\.txt$/m, `${part}: the listing did not read the enclosing repository`);
      fs.renameSync(`${moved}.away`, moved);
      assert.equal(fs.existsSync(marker), false, `${part}: the driver ran before status`);
      plain(repo, ["status", "--porcelain"]);
      assert.equal(fs.existsSync(marker), true, `${part}: the submodule's driver did not run`);
    }
  });

  it("control: under plain git, either moved away sends add -A to the enclosing repository and its driver", () => {
    for (const part of ["objects", "refs"]) {
      const { inner, outer, marker } = nestedRepo();
      plain(inner, ["add", "-A"]);
      assert.equal(fs.existsSync(marker), false, `${part}: the driver ran before anything moved`);
      fs.renameSync(path.join(inner, ".git", part), path.join(inner, ".git", `${part}.away`));
      assert.equal(plain(inner, ["rev-parse", "--show-toplevel"]).trim(), outer, part);
      plain(inner, ["add", "-A"]);
      assert.equal(fs.existsSync(marker), true, `${part}: the enclosing repository's driver did not run`);
    }
  });
});

/**
 * A cwd spelled through a symlink, whose link is re-pointed at another
 * repository once the probe has read the one it named. Every path the probe
 * watched was physical, so nothing it read changed, and the call chdir'd
 * through the link into a repository the probe never read and ran its driver
 * (board task 9e508616, measured, 2.39.5). Replacing a cwd that is not spelled
 * through a link was already refused, because the physical paths watched
 * resolve through whatever stands there.
 */
describe("a cwd spelled through a symlink re-pointed between the probe and the call is refused", () => {
  /**
   * `<clean>-link`, a link to a repository with no driver, and a repository
   * with a planted clean filter it can be re-pointed at, which leaves `marker`
   * if it runs; each has a `d/`, for a cwd with the link above its leaf.
   */
  function linkedPair(): { link: string; planted: string; marker: string } {
    const clean = path.join(root, `repo${count++}`);
    committedRepo(clean, "f.txt");
    fs.writeFileSync(path.join(clean, "f.txt"), "two\n");
    const { repo: planted, marker } = plantedRepo();
    for (const repo of [clean, planted]) fs.mkdirSync(path.join(repo, "d"));
    const link = `${clean}-link`;
    fs.symlinkSync(clean, link);
    return { link, planted, marker };
  }

  after(() => setMode("pass"));

  it("git() and gitSync(): the link re-pointed while the index is listed refuses the call, naming the cwd", async () => {
    for (const viaSync of [false, true]) {
      for (const below of ["", "d"]) {
        const { link, planted, marker } = linkedPair();
        const cwd = below ? path.join(link, below) : link;
        fs.writeFileSync(writeTarget, link);
        fs.writeFileSync(rewriteContent, planted);
        setMode("repoint-link");
        const res = viaSync ? gitSync(cwd, ["add", "-A"]) : await git(cwd, ["add", "-A"]);
        setMode("pass");

        const via = `${viaSync ? "gitSync" : "git"}() in ${cwd}`;
        ranNothing(marker);
        assert.equal(fs.realpathSync(link), planted, `${via}: the listing did not re-point the link`);
        assert.equal(res.ok, false, `${via} ran the call`);
        assert.equal(res.code, null);
        assert.ok(res.stderr.includes(`${cwd} changed while the filter probe read it`), `${via}: ${res.stderr}`);
      }
    }
  });

  it("git() and gitSync(): a call through a link nobody re-points runs, with the drivers where it leads blanked", async () => {
    // Refusing every cwd spelled through a link would pass the case above.
    for (const viaSync of [false, true]) {
      const { repo, marker } = plantedRepo();
      fs.mkdirSync(path.join(repo, "d"));
      const link = `${repo}-link`;
      fs.symlinkSync(repo, link);
      for (const cwd of [link, path.join(link, "d")]) {
        fs.writeFileSync(path.join(repo, "f.txt"), `${cwd}\n`);
        const res = viaSync ? gitSync(cwd, ["add", "-A"]) : await git(cwd, ["add", "-A"]);
        ranNothing(marker);
        assert.equal(res.ok, true, `${viaSync ? "gitSync" : "git"}() in ${cwd}: ${res.stderr}`);
      }
    }
  });

  it("control: under plain git, the cwd re-pointed runs the driver of the repository it now names", () => {
    for (const below of ["", "d"]) {
      const { link, planted, marker } = linkedPair();
      const cwd = below ? path.join(link, below) : link;
      plain(cwd, ["add", "-A"]);
      assert.equal(fs.existsSync(marker), false, `${cwd}: the driver ran before the link was re-pointed`);
      fs.unlinkSync(link);
      fs.symlinkSync(planted, link);
      plain(cwd, ["add", "-A"]);
      assert.equal(fs.existsSync(marker), true, `${cwd}: the driver did not run`);
    }
  });
});
