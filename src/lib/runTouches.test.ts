import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { changedSetOf, reconcileTouches, touchActor, uncommittedPaths } from "./runTouches";
import type { RunDiffDTO, RunTouchDTO } from "./apiTypes";

/**
 * Covers the set difference and the merge, and only those.
 *
 * Every failure mode here is silent and every one of them produces a confident
 * wrong sentence rather than an error. A file on the wrong side of the
 * difference reads as "this run changed a file it never opened" — the one claim
 * on this card an operator would act on, by going and looking at a diff hunk
 * nothing wrote. A path that fails to merge shows one file as two with its
 * counts split between them, which is a run that read something half as often
 * as it did. And `distinctTouched` is not decoration: it is one of the two
 * numbers this slice exists to produce, and it is what the next decision about
 * drawing any of this is made from, so a miscount is a design decision taken
 * from a wrong figure.
 *
 * The database side is deliberately not tested. `scanTouches` is a query, and
 * the suite has no fixture database — what it would assert is SQLite's
 * behaviour rather than this app's.
 */

/** A touch, with the fields a test does not care about filled in. */
function touch(over: Partial<RunTouchDTO> & Pick<RunTouchDTO, "path">): RunTouchDTO {
  return {
    outside: false,
    tool: "Read",
    subagent: null,
    parentToolUseId: null,
    calls: 1,
    ...over,
  };
}

const paths = (rows: readonly { path: string }[]) => rows.map((r) => r.path);

/** An isolated run's diff, with nothing in it unless a test says so. */
function diff(over: Partial<RunDiffDTO> = {}): RunDiffDTO {
  return {
    kind: "range",
    reason: null,
    base: "main",
    branch: "uf/x",
    head: null,
    files: [],
    filesChanged: 0,
    added: 0,
    deleted: 0,
    omittedPatches: 0,
    uncommitted: [],
    caveat: null,
    ...over,
  };
}

const changedFiles = (list: string[]): RunDiffDTO["files"] =>
  list.map((path) => ({
    path,
    oldPath: null,
    status: "modified" as const,
    added: 1,
    deleted: 0,
    binary: false,
    patch: null,
    patchTruncated: false,
  }));

/** `reconcileTouches` the way both surfaces call it: through `changedSetOf`. */
function reconcileAgainst(touches: RunTouchDTO[], against: RunDiffDTO) {
  const set = changedSetOf(against);
  return set.known
    ? reconcileTouches(touches, set.changed, set.uncommitted)
    : reconcileTouches(touches, [], []);
}

describe("reconcileTouches", () => {
  it("splits touched and changed into the four groups", () => {
    const report = reconcileTouches(
      [
        touch({ path: "src/a.ts", tool: "Read" }),
        touch({ path: "src/b.ts", tool: "Edit" }),
      ],
      ["src/b.ts", "src/c.ts"],
      [],
    );

    assert.deepEqual(paths(report.changedNotTouched), ["src/c.ts"]);
    assert.deepEqual(paths(report.touchedAndChanged), ["src/b.ts"]);
    assert.deepEqual(paths(report.touchedNotChanged), ["src/a.ts"]);
    assert.deepEqual(report.outsideCheckout, []);
    assert.equal(report.distinctTouched, 2);
  });

  it("keeps a path outside the checkout out of the other three groups", () => {
    // The rows `readCountsFor` drops at its `ELSE NULL`. They cannot be
    // reconciled against a diff at all — nothing in the branch range can speak
    // for a file that is not in the checkout — so a group of their own is the
    // only honest place for them.
    const report = reconcileTouches(
      [
        touch({ path: "/tmp/scratch.txt", outside: true, tool: "Write" }),
        touch({ path: "src/a.ts" }),
      ],
      ["src/a.ts"],
      [],
    );

    assert.deepEqual(paths(report.outsideCheckout), ["/tmp/scratch.txt"]);
    assert.deepEqual(paths(report.touchedAndChanged), ["src/a.ts"]);
    assert.deepEqual(report.touchedNotChanged, []);
    assert.deepEqual(report.changedNotTouched, []);
    // Counted, because it *was* touched — the header's figure is about the
    // run's reach and a file outside the checkout is the most of it.
    assert.equal(report.distinctTouched, 2);
  });

  it("counts reads and writes apart, and sorts the busiest file first", () => {
    const report = reconcileTouches(
      [
        touch({ path: "src/quiet.ts", calls: 1 }),
        touch({ path: "src/busy.ts", tool: "Read", calls: 3 }),
        touch({ path: "src/busy.ts", tool: "Edit", calls: 1 }),
      ],
      [],
      [],
    );

    assert.deepEqual(paths(report.touchedNotChanged), ["src/busy.ts", "src/quiet.ts"]);
    const busy = report.touchedNotChanged[0];
    assert.equal(busy.reads, 3);
    assert.equal(busy.writes, 1);
  });

  it("names the caller, and falls back rather than claiming the main thread", () => {
    assert.equal(touchActor({ subagent: "Explore", parentToolUseId: "toolu_1" }), "Explore");
    // A delegated call whose `Task` was never seen: "some sub-agent" is true
    // where "the main thread" is not.
    assert.equal(touchActor({ subagent: null, parentToolUseId: "toolu_1" }), "delegated");
    assert.equal(touchActor({ subagent: null, parentToolUseId: null }), "main");

    const report = reconcileTouches(
      [touch({ path: "src/a.ts", subagent: "Explore", parentToolUseId: "toolu_1" })],
      [],
      [],
    );
    assert.deepEqual(report.touchedNotChanged[0].by, ["Explore"]);
  });

  it("lists every caller of one file, sorted", () => {
    // A file the main thread read and a sub-agent edited is the ordinary case
    // in this app, and showing one of the two would make the other disappear.
    const report = reconcileTouches(
      [
        touch({ path: "src/a.ts" }),
        touch({ path: "src/a.ts", tool: "Edit", subagent: "Explore", parentToolUseId: "t" }),
      ],
      [],
      [],
    );
    assert.deepEqual(report.touchedNotChanged[0].by, ["Explore", "main"]);
  });

  it("puts every touch in touchedNotChanged when nothing changed", () => {
    // A run whose branch has no commits on it. The empty side must not read as
    // "everything the run touched was also changed".
    const report = reconcileTouches([touch({ path: "src/a.ts" })], [], []);

    assert.deepEqual(report.changedNotTouched, []);
    assert.deepEqual(report.touchedAndChanged, []);
    assert.deepEqual(paths(report.touchedNotChanged), ["src/a.ts"]);
  });

  it("merges one path reached two ways into one row", () => {
    // The scan relativises against `work_dir` and then `folder`, so an isolated
    // run that reached the same file through both resolves to one string — but
    // as two rows, because the query also groups by tool and by caller. Merging
    // is this function's job and nothing else does it.
    const report = reconcileTouches(
      [
        touch({ path: "src/a.ts", tool: "Read", calls: 2 }),
        touch({ path: "src/a.ts", tool: "Write", calls: 1 }),
      ],
      [],
      [],
    );

    assert.equal(report.touchedNotChanged.length, 1);
    assert.equal(report.distinctTouched, 1);
    assert.equal(report.touchedNotChanged[0].reads, 2);
    assert.equal(report.touchedNotChanged[0].writes, 1);
  });

  it("orders a group with no counts by path rather than by arrival", () => {
    // `changedNotTouched` has no calls to rank by, and the diff's own order
    // varies between two reads of the same run.
    const report = reconcileTouches([], ["z.ts", "a.ts", "m.ts"], []);
    assert.deepEqual(paths(report.changedNotTouched), ["a.ts", "m.ts", "z.ts"]);
    assert.equal(report.distinctTouched, 0);
  });

  it("counts a tool it has never heard of as a read", () => {
    // The fallback is chosen so being wrong is cheap: one column understates
    // and the group the file lands in — the load-bearing part — is unaffected.
    const report = reconcileTouches(
      [touch({ path: "src/a.ts", tool: "SomeFutureTool", calls: 2 })],
      ["src/a.ts"],
      [],
    );
    assert.deepEqual(paths(report.touchedAndChanged), ["src/a.ts"]);
    assert.equal(report.touchedAndChanged[0].reads, 2);
    assert.equal(report.touchedAndChanged[0].writes, 0);
  });
});

describe("changedSetOf", () => {
  it("knows the changed set only for a range", () => {
    const set = changedSetOf(
      diff({ files: changedFiles(["src/a.ts"]), uncommitted: [" M src/b.ts"] }),
    );
    assert.deepEqual(set, { known: true, changed: ["src/a.ts"], uncommitted: ["src/b.ts"] });
  });

  it("gives a run that worked in the operator's checkout its own sentence", () => {
    // `worktreeDiff`'s `reason` says whether the folder is clean, which is no
    // answer to why nothing can be reconciled, and its `files` are empty by
    // construction, which is what read as "nothing changed".
    const set = changedSetOf(
      diff({ kind: "worktree", reason: "Nothing is uncommitted in this folder." }),
    );
    assert.equal(set.known, false);
    assert.match(set.known ? "" : (set.reason ?? ""), /worked directly in your checkout/);
  });

  it("passes the diff route's own reason on when there is no diff", () => {
    assert.deepEqual(changedSetOf(diff({ kind: "none", reason: "The branch is gone." })), {
      known: false,
      reason: "The branch is gone.",
    });
    assert.deepEqual(changedSetOf(null), { known: false, reason: null });
  });
});

describe("reconciling against a range diff with uncommitted work", () => {
  it("never files a touched, uncommitted file under not changed", () => {
    // The run edited `src/app.ts` and never committed it: the diff lists only
    // the branch, and the checkout's status line is the one place it shows.
    const report = reconcileAgainst(
      [
        touch({ path: "src/app.ts", tool: "Edit", calls: 3 }),
        touch({ path: "src/read.ts" }),
      ],
      diff({ uncommitted: [" M src/app.ts"] }),
    );

    assert.deepEqual(paths(report.touchedUncommitted), ["src/app.ts"]);
    assert.deepEqual(paths(report.touchedNotChanged), ["src/read.ts"]);
    assert.deepEqual(report.touchedAndChanged, []);
    // Not in "changed, never named" either: that group is the branch diff's.
    assert.deepEqual(report.changedNotTouched, []);
    assert.equal(report.touchedUncommitted[0].inDiff, false);
    assert.equal(report.touchedUncommitted[0].uncommitted, true);
  });

  it("keeps a committed file that was edited again with the branch", () => {
    const report = reconcileAgainst(
      [touch({ path: "src/a.ts", tool: "Edit" })],
      diff({ files: changedFiles(["src/a.ts"]), uncommitted: [" M src/a.ts"] }),
    );
    assert.deepEqual(paths(report.touchedAndChanged), ["src/a.ts"]);
    assert.deepEqual(report.touchedUncommitted, []);
  });

  it("covers every file under an untracked directory git listed once", () => {
    const report = reconcileAgainst(
      [
        touch({ path: "src/new/a.ts", tool: "Write" }),
        touch({ path: "src/new/deep/b.ts", tool: "Write" }),
        touch({ path: "src/newer.ts" }),
      ],
      diff({ uncommitted: ["?? src/new/"] }),
    );
    assert.deepEqual(paths(report.touchedUncommitted), ["src/new/a.ts", "src/new/deep/b.ts"]);
    // A sibling whose name only starts the same way is not under it.
    assert.deepEqual(paths(report.touchedNotChanged), ["src/newer.ts"]);
  });

  it("says nothing about uncommitted work outside the checkout", () => {
    const report = reconcileAgainst(
      [touch({ path: "/tmp/x.ts", outside: true, tool: "Write" })],
      diff({ uncommitted: ["?? /tmp/x.ts"] }),
    );
    assert.deepEqual(paths(report.outsideCheckout), ["/tmp/x.ts"]);
    assert.equal(report.outsideCheckout[0].uncommitted, false);
  });

  it("offers no changed set at all for a run that worked in the operator's checkout", () => {
    // Every group but the two the card keeps without a diff stays empty, so the
    // edit lands in the one the card relabels "named by a tool call".
    const report = reconcileAgainst(
      [touch({ path: "src/app.ts", tool: "Edit", calls: 3 })],
      diff({ kind: "worktree", uncommitted: [" M src/app.ts"] }),
    );
    assert.deepEqual(paths(report.touchedNotChanged), ["src/app.ts"]);
    assert.deepEqual(report.touchedUncommitted, []);
    assert.equal(report.touchedNotChanged[0].inDiff, false);
  });
});

describe("uncommittedPaths", () => {
  it("reads the path out of each status line", () => {
    assert.deepEqual(uncommittedPaths([" M src/a.ts", "M  src/b.ts", "?? notes.md", " D gone.ts"]), [
      "src/a.ts",
      "src/b.ts",
      "notes.md",
      "gone.ts",
    ]);
  });

  it("decodes the quoting git puts on a space, a quote and a non-ASCII byte", () => {
    // What git 2.39 printed in a scratch repository: each is quoted, and `ü` as
    // the two octal escapes of its UTF-8 bytes.
    assert.deepEqual(
      uncommittedPaths([' M "docs/a b.md"', '?? "q\\"x.txt"', '?? "docs/\\303\\274ber.md"']),
      ["docs/a b.md", 'q"x.txt', "docs/über.md"],
    );
  });

  it("returns both sides of a rename and only the target of a copy", () => {
    assert.deepEqual(uncommittedPaths(["R  old.ts -> new.ts"]), ["old.ts", "new.ts"]);
    assert.deepEqual(uncommittedPaths(['R  "a b.ts" -> "c d.ts"']), ["a b.ts", "c d.ts"]);
    assert.deepEqual(uncommittedPaths(["C  src.ts -> copy.ts"]), ["copy.ts"]);
  });

  it("keeps an untracked directory's trailing slash", () => {
    assert.deepEqual(uncommittedPaths(["?? src/new/"]), ["src/new/"]);
  });

  it("skips a line that is not a status record", () => {
    assert.deepEqual(uncommittedPaths(["", "M", '?? "unterminated']), []);
  });
});
