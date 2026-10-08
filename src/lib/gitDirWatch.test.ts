import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  attributesFileOf,
  commandClassOf,
  compareGitDir,
  watchedConfigOf,
  type GitDirBaseline,
  type GitDirFinding,
  type GitDirReport,
  type GitDirSnapshot,
  type HookEntry,
} from "./gitDirWatch";

/**
 * Covers the decision behind the warning a run's page gives when its
 * repository's git directory changed: which keys run a command, and what two
 * readings of the directory add up to.
 *
 * Both directions fail silently. A key missing from the list is a planted
 * command the operator's own `git status` runs on the host with nothing on
 * the page to say so — the whole reason the check exists. A key that should
 * not be there is a warning on every run, because this app's own git writes
 * `.git/config` on every isolated run (branches, remotes, worktree
 * bookkeeping), and a warning that always fires is one nobody reads. So there
 * is one case per class of command-bearing key, each failing with that class
 * taken off the list, and one case of everything this app writes legitimately.
 */

const COMMON = "/workspace/repo/.git";
const CONFIG = `${COMMON}/config`;

type Line = [scope: string, origin: string, key: string, value: string | null];

/** `git config --list --show-scope --show-origin -z`, as git writes it. */
function listing(lines: Line[]): string {
  return lines
    .map(
      ([scope, origin, key, value]) =>
        `${scope}\0file:${origin}\0${value === null ? key : `${key}\n${value}`}\0`,
    )
    .join("");
}

/** What a fresh `git init` and this app's own git leave in `.git/config`. */
const ORDINARY: Line[] = [
  ["system", "/etc/gitconfig", "safe.directory", "*"],
  ["local", CONFIG, "core.repositoryformatversion", "0"],
  ["local", CONFIG, "core.filemode", "true"],
  ["local", CONFIG, "core.bare", "false"],
  ["local", CONFIG, "remote.origin.url", "https://github.com/example/repo.git"],
  ["local", CONFIG, "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
  ["local", CONFIG, "branch.main.remote", "origin"],
  ["local", CONFIG, "branch.main.merge", "refs/heads/main"],
  ["command", "", "core.fsmonitor", ""],
  ["command", "", "core.hookspath", "/dev/null"],
];

function snapshot(
  lines: Line[],
  hooks: HookEntry[] = [],
  attributes: string | null = null,
): GitDirSnapshot {
  return {
    config: watchedConfigOf(listing(lines)),
    hooks,
    attributes: attributes === null ? null : attributesFileOf(attributes),
  };
}

function baseline(snap: GitDirSnapshot): GitDirBaseline {
  return { ok: true, takenAt: 1_000, commonDir: COMMON, snapshot: snap };
}

function compare(before: GitDirSnapshot, after: GitDirSnapshot, concurrent: string[] = []) {
  return compareGitDir(baseline(before), { ok: true, snapshot: after }, concurrent, 2_000);
}

function findingsOf(report: GitDirReport): GitDirFinding[] {
  assert.equal(report.state, "changed", `expected a change, got ${JSON.stringify(report)}`);
  return report.state === "changed" ? report.findings : [];
}

/** Each key added to an ordinary config, compared alone, as the one finding of its class. */
function assertEachFound(
  added: Array<[key: string, value: string | null]>,
  commandClass: string,
  origin = CONFIG,
) {
  for (const [key, value] of added) {
    const findings = findingsOf(
      compare(snapshot(ORDINARY), snapshot([...ORDINARY, ["local", origin, key, value]])),
    );
    assert.deepEqual(
      findings.map((f) => (f.kind === "config" ? [f.key, f.commandClass, f.change] : f.kind)),
      [[key, commandClass, "added"]],
      `${key}=${value}`,
    );
  }
}

describe("what this app's own git writes", () => {
  it("is not a finding: branches, remotes, worktree bookkeeping and the extension", () => {
    const after = snapshot([
      ...ORDINARY,
      ["local", CONFIG, "remote.origin.url", "https://github.com/example/moved.git"],
      ["local", CONFIG, "branch.uf/repo-3-ab12cd.remote", "origin"],
      ["local", CONFIG, "branch.uf/repo-3-ab12cd.merge", "refs/heads/uf/repo-3-ab12cd"],
      ["local", CONFIG, "extensions.worktreeconfig", "true"],
      ["local", CONFIG, "core.sparsecheckout", "false"],
      ["local", CONFIG, "user.name", "Somebody"],
      ["local", CONFIG, "submodule.lib.update", "checkout"],
      ["local", CONFIG, "submodule.lib.url", "https://github.com/example/lib.git"],
      ["worktree", `${COMMON}/config.worktree`, "core.sparsecheckout", "true"],
      // Not the repository's: global and the command line are never compared.
      ["global", "/home/node/.gitconfig", "core.fsmonitor", "evil"],
      ["command", "", "credential.helper", ""],
    ]);
    const report = compare(snapshot(ORDINARY), after);
    assert.equal(report.state, "unchanged", JSON.stringify(report));
  });

  it("is unchanged when nothing moved, and says since when", () => {
    const report = compare(snapshot(ORDINARY), snapshot(ORDINARY));
    assert.deepEqual(report, {
      state: "unchanged",
      commonDir: COMMON,
      since: 1_000,
      checkedAt: 2_000,
    });
  });
});

describe("one case per class of key that runs a command", () => {
  it("core.fsmonitor, which runs on git status, diff and blame", () => {
    assertEachFound([["core.fsmonitor", "touch /tmp/ran #"]], "fsmonitor");
    // A bare boolean key is still a value, and a different one from empty.
    assertEachFound([["core.fsmonitor", null]], "fsmonitor");
  });

  it("core.hooksPath, which chooses which hooks run", () => {
    assertEachFound([["core.hookspath", "/tmp/elsewhere"]], "hooks-path");
  });

  it("a filter, diff or merge driver an attributes file can name", () => {
    assertEachFound(
      [
        ["filter.x.clean", "sh -c evil"],
        ["filter.x.smudge", "sh -c evil"],
        ["filter.x.process", "sh -c evil"],
        ["diff.x.textconv", "sh -c evil"],
        ["diff.x.command", "sh -c evil"],
        ["merge.x.driver", "sh -c evil %O %A %B"],
        // A driver name may contain dots, and keeps its case.
        ["filter.Some.Name.clean", "sh -c evil"],
      ],
      "attribute-driver",
    );
  });

  it("diff.external, which runs on git diff", () => {
    assertEachFound([["diff.external", "sh -c evil"]], "external-diff");
  });

  it("what fetch, push, clone and submodule update run", () => {
    assertEachFound(
      [
        ["credential.helper", "!sh -c evil"],
        ["credential.https://github.com.helper", "!sh -c evil"],
        ["core.askpass", "/tmp/askpass"],
        ["core.sshcommand", "sh -c evil"],
        ["core.gitproxy", "sh -c evil"],
        ["core.alternaterefscommand", "sh -c evil"],
        ["remote.origin.uploadpack", "sh -c evil"],
        ["remote.origin.receivepack", "sh -c evil"],
        ["remote.origin.vcs", "evil"],
        ["remote.extra.url", "ext::sh -c evil"],
        ["remote.extra.pushurl", "EXT::sh -c evil"],
        ["url.ext::sh -c evil #.insteadof", "https://github.com/"],
        ["protocol.allow", "always"],
        ["protocol.ext.allow", "always"],
        ["submodule.lib.update", "!sh -c evil"],
      ],
      "remote",
    );
  });

  it("what signs or checks a signature", () => {
    assertEachFound(
      [
        ["gpg.program", "sh -c evil"],
        ["gpg.x509.program", "sh -c evil"],
        ["gpg.ssh.program", "sh -c evil"],
        ["gpg.ssh.defaultkeycommand", "sh -c evil"],
      ],
      "signing",
    );
  });

  it("what runs when the operator pages, edits or opens a tool", () => {
    assertEachFound(
      [
        ["core.pager", "sh -c evil"],
        ["pager.log", "sh -c evil"],
        ["core.editor", "sh -c evil"],
        ["sequence.editor", "sh -c evil"],
        ["interactive.difffilter", "sh -c evil"],
        ["difftool.x.cmd", "sh -c evil"],
        ["mergetool.x.cmd", "sh -c evil"],
        ["browser.x.cmd", "sh -c evil"],
        ["man.x.cmd", "sh -c evil"],
      ],
      "interactive",
    );
  });

  it("an alias, which outranks the operator's own of the same name", () => {
    assertEachFound([["alias.st", "!sh -c evil"]], "alias");
  });

  it("an include, which pulls another file's settings in", () => {
    assertEachFound(
      [
        ["include.path", "evil.inc"],
        ["includeif.onbranch:main.path", "evil.inc"],
      ],
      "include",
    );
  });

  it("a key set in an included file or in config.worktree, under that file", () => {
    assertEachFound([["filter.x.clean", "sh -c evil"]], "attribute-driver", `${COMMON}/evil.inc`);
    const findings = findingsOf(
      compare(
        snapshot(ORDINARY),
        snapshot([...ORDINARY, ["worktree", `${COMMON}/config.worktree`, "diff.external", "evil"]]),
      ),
    );
    assert.deepEqual(findings, [
      {
        kind: "config",
        commandClass: "external-diff",
        key: "diff.external",
        change: "added",
        now: [{ scope: "worktree", origin: `${COMMON}/config.worktree`, shown: "evil" }],
      },
    ]);
  });

  it("a hook added, rewritten, made executable or removed", () => {
    const hook = (identity: string, executable = true): HookEntry => ({
      name: "post-checkout",
      identity,
      executable,
    });
    const hooksOf = (before: HookEntry[], after: HookEntry[]) =>
      findingsOf(compare(snapshot(ORDINARY, before), snapshot(ORDINARY, after)));

    assert.deepEqual(hooksOf([], [hook("file:a")]), [
      { kind: "hook", name: "post-checkout", change: "added", executable: true },
    ]);
    assert.deepEqual(hooksOf([hook("file:a")], [hook("file:b")]), [
      { kind: "hook", name: "post-checkout", change: "changed", executable: true },
    ]);
    assert.deepEqual(hooksOf([hook("file:a", false)], [hook("file:a", true)]), [
      { kind: "hook", name: "post-checkout", change: "changed", executable: true },
    ]);
    assert.deepEqual(hooksOf([hook("file:a")], []), [
      { kind: "hook", name: "post-checkout", change: "removed", executable: false },
    ]);
    assert.equal(
      compare(snapshot(ORDINARY, [hook("file:a")]), snapshot(ORDINARY, [hook("file:a")])).state,
      "unchanged",
    );
  });

  it("info/attributes added or changed, with the lines that name a driver", () => {
    const findings = findingsOf(
      compare(
        snapshot(ORDINARY, [], "*.md text\n"),
        snapshot(ORDINARY, [], "*.md text\n# filter=commented\n* filter=x diff=y\n*.bin merge=z\n"),
      ),
    );
    assert.deepEqual(findings, [
      {
        kind: "attributes",
        change: "changed",
        driverLines: ["* filter=x diff=y", "*.bin merge=z"],
      },
    ]);
    assert.equal(
      findingsOf(compare(snapshot(ORDINARY), snapshot(ORDINARY, [], "* filter=x\n")))[0].kind,
      "attributes",
    );
  });
});

describe("how a watched key's change is reported", () => {
  it("says removed, and changed — including two values swapping order", () => {
    const withHelpers = (...values: string[]) =>
      snapshot([
        ...ORDINARY,
        ...values.map((v): Line => ["local", CONFIG, "credential.helper", v]),
      ]);
    const [removed] = findingsOf(compare(withHelpers("store"), withHelpers()));
    assert.equal(removed.kind === "config" && removed.change, "removed");
    const [changed] = findingsOf(compare(withHelpers("store"), withHelpers("store", "!evil")));
    assert.equal(changed.kind === "config" && changed.change, "changed");
    // For a single-valued key the last one wins, so order is a change.
    const swapped = compare(withHelpers("a", "b"), withHelpers("b", "a"));
    assert.equal(swapped.state, "changed");
  });

  it("never keeps a credential helper's text, and keeps other values cut short", () => {
    const [helper] = watchedConfigOf(
      listing([["local", CONFIG, "credential.helper", "!echo password=secret"]]),
    );
    assert.equal(helper.shown, null);
    const [long] = watchedConfigOf(listing([["local", CONFIG, "core.pager", "x".repeat(500)]]));
    assert.equal(long.shown?.length, 200);
  });

  it("classifies a value-dependent key from the full value it was read with", () => {
    // `shown` is cut at 200 characters; the `ext::` prefix must not be needed
    // from it, and a long URL must not stop being watched.
    const url = `ext::${"x".repeat(400)}`;
    const [entry] = watchedConfigOf(listing([["local", CONFIG, "remote.o.url", url]]));
    assert.equal(entry.commandClass, "remote");
  });

  it("reads a multi-line value whole", () => {
    const [entry] = watchedConfigOf(
      listing([["local", CONFIG, "alias.x", "!f() {\n  evil\n}; f"]]),
    );
    assert.equal(entry.shown, "!f() {\n  evil\n}; f");
  });

  it("compares section and variable without case, and the subsection with it", () => {
    assert.equal(commandClassOf("Core.FSMonitor", "x"), "fsmonitor");
    assert.equal(commandClassOf("FILTER.x.Clean", "x"), "attribute-driver");
    assert.equal(commandClassOf("url.EXT::sh.insteadOf", "x"), "remote");
    assert.equal(commandClassOf("core", "x"), null);
    assert.equal(commandClassOf("core.", "x"), null);
    assert.equal(commandClassOf("remote.origin.url", "https://example.com"), null);
  });
});

describe("what the report says around its findings", () => {
  it("names the other runs in the same repository, sorted", () => {
    const report = compare(
      snapshot(ORDINARY),
      snapshot([...ORDINARY, ["local", CONFIG, "core.fsmonitor", "x"]]),
      ["run-b", "run-a"],
    );
    assert.equal(report.state, "changed");
    assert.deepEqual(report.state === "changed" && report.concurrentRunIds, ["run-a", "run-b"]);
  });

  it("is unreadable, never unchanged, when either reading failed", () => {
    const failedStart: GitDirBaseline = {
      ok: false,
      takenAt: 1_000,
      commonDir: null,
      reason: "git could not name it",
    };
    const fromStart = compareGitDir(failedStart, { ok: true, snapshot: snapshot([]) }, [], 2_000);
    assert.equal(fromStart.state, "unreadable");
    assert.match(fromStart.state === "unreadable" ? fromStart.reason : "", /start: git could not/);

    const fromEnd = compareGitDir(
      baseline(snapshot(ORDINARY)),
      { ok: false, reason: "gone" },
      [],
      2_000,
    );
    assert.deepEqual(fromEnd, {
      state: "unreadable",
      commonDir: COMMON,
      reason: "At the run's end: gone",
      checkedAt: 2_000,
    });
  });
});
