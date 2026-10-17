import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  contention,
  crossRunReading,
  repeatedFailures,
  repoRelative,
  repositoryKeys,
  type FailureRow,
  type FileCallRow,
  type ResolveRow,
} from "./repoReading";
import { NO_REPOSITORY_KEY, NO_REPOSITORY_LABEL } from "./repoSpend";

/**
 * Covers the readout's three pure readings and the relativisation under them.
 *
 * Each fails silently into a plausible card. The edited split, wrong, reports the
 * unsplit share — twice the prize — or files a run's edit of a file under a
 * different run. The relativisation, wrong, makes a checkout's path and the
 * repository's path two files, so a repeat reads as a first read and the share
 * drops to what looks like a healthy number. The failure ordering, by rows, puts
 * one run's 214 retries above ten runs failing once. And a per-file sum of a
 * resolution's cost counts a five-file resolution five times.
 */

let nextEvent = 0;
function call(
  runId: string,
  runCreatedAt: number,
  tool: string,
  filePath: string,
  base: string | null = "/w/R",
  repoKey = "R",
): FileCallRow {
  nextEvent += 1;
  return { eventId: nextEvent, runId, runCreatedAt, repoKey, tool, filePath, base, mainThread: true };
}

describe("repoRelative", () => {
  it("makes a checkout's path and the repository's path the same file", () => {
    assert.equal(repoRelative("/w/.uf-worktrees/r-1/src/a.ts", "/w/.uf-worktrees/r-1"), "src/a.ts");
    assert.equal(repoRelative("/w/R/src/a.ts", "/w/R/"), "src/a.ts");
  });

  it("refuses a path outside the base, however it is spelled", () => {
    assert.equal(repoRelative("/w/R/../S/a.ts", "/w/R"), null);
    assert.equal(repoRelative("/w/Rx/a.ts", "/w/R"), null);
    assert.equal(repoRelative("/w/.uf-worktrees/r-2/a.ts", "/w/.uf-worktrees/r-1"), null);
    assert.equal(repoRelative("/w/R", "/w/R"), null);
  });

  it("refuses what it cannot place, rather than guessing", () => {
    assert.equal(repoRelative("src/a.ts", "/w/R"), null);
    assert.equal(repoRelative("/w/R/a.ts", null), null);
    assert.equal(repoRelative("/w/R/a\nDONE", "/w/R"), null);
  });

  it("normalises inside the base", () => {
    assert.equal(repoRelative("/w/R/src/../lib/./b.ts", "/w/R"), "lib/b.ts");
  });
});

describe("crossRunReading", () => {
  it("splits repeats by whether the reading run edited the file, and the parts add up", () => {
    const rows = [
      call("A", 1, "Read", "/w/R/x.ts"),
      call("A", 1, "Read", "/w/R/x.ts"),
      call("A", 1, "Read", "/w/R/y.ts"),
      // B re-reads both and edits y, after reading it.
      call("B", 2, "Read", "/w/R/x.ts"),
      call("B", 2, "Read", "/w/R/y.ts"),
      call("B", 2, "Edit", "/w/R/y.ts"),
      // C re-reads x, having edited it *before* reading it: still edited.
      call("C", 3, "Write", "/w/R/x.ts"),
      call("C", 3, "Read", "/w/R/x.ts"),
      // D re-reads y without editing it; A's edit of nothing and B's edit of y
      // are not D's.
      call("D", 4, "Read", "/w/R/y.ts"),
    ];
    const [r] = crossRunReading(rows);
    assert.equal(r.reads, 7);
    assert.equal(r.runs, 4);
    assert.equal(r.repeats, 4, "A's own second read of x is not a repeat");
    assert.equal(r.repeatsEdited, 2);
    assert.equal(r.repeatsNotEdited, 2);
    assert.equal(r.repeatsEdited + r.repeatsNotEdited, r.repeats);
    assert.deepEqual(r.reReadNotEdited, [
      { path: "x.ts", reads: 1, runs: 1 },
      { path: "y.ts", reads: 1, runs: 1 },
    ]);
  });

  it("matches one file across a checkout, another checkout and the repository itself", () => {
    const rows = [
      call("A", 1, "Read", "/w/.uf-worktrees/r-1/src/a.ts", "/w/.uf-worktrees/r-1"),
      call("B", 2, "Read", "/w/.uf-worktrees/r-2/src/a.ts", "/w/.uf-worktrees/r-2"),
      call("C", 3, "Read", "/w/R/src/a.ts", "/w/R"),
      // Another slot's copy of the file, read from r-1: a different file, kept
      // absolute, and the first read of that key.
      call("D", 4, "Read", "/w/.uf-worktrees/r-2/src/a.ts", "/w/.uf-worktrees/r-1"),
    ];
    const [r] = crossRunReading(rows);
    assert.equal(r.repeats, 2);
    assert.deepEqual(
      r.reReadNotEdited.map((f) => f.path),
      ["src/a.ts"],
    );
  });

  it("orders runs by when they were created, not by when their reads were logged", () => {
    // B was created after A but read first: A is still the earlier run.
    const b = call("B", 2, "Read", "/w/R/x.ts");
    const a = call("A", 1, "Read", "/w/R/x.ts");
    const [r] = crossRunReading([b, a]);
    assert.equal(r.repeats, 1);
    assert.deepEqual(r.reReadNotEdited, [{ path: "x.ts", reads: 1, runs: 1 }]);
  });

  it("keeps repositories apart, so a path read in one is not a repeat in another", () => {
    const rows = [
      call("A", 1, "Read", "/w/R/x.ts", "/w/R", "R"),
      call("B", 2, "Read", "/w/S/x.ts", "/w/S", "S"),
    ];
    const byRepo = new Map(crossRunReading(rows).map((r) => [r.repoKey, r]));
    assert.equal(byRepo.get("R")!.repeats, 0);
    assert.equal(byRepo.get("S")!.repeats, 0);
  });
});

describe("repeatedFailures", () => {
  const fail = (runId: string, text: string, tool = "Bash", repoKey = "R"): FailureRow => ({
    runId,
    repoKey,
    tool,
    text,
  });

  it("orders by how many runs hit a failure, not by how many times", () => {
    const rows: FailureRow[] = [
      ...Array.from({ length: 214 }, () => fail("A", "bwrap: No permissions to create new namespace")),
      fail("A", "npm ERR! missing script: lint"),
      fail("B", "npm ERR! missing script: lint"),
      fail("C", "npm ERR! missing script: lint"),
      fail("B", "bwrap: No permissions to create new namespace"),
    ];
    const [r] = repeatedFailures(rows);
    assert.equal(r.rows, 218);
    assert.equal(r.runs, 3);
    assert.deepEqual(
      r.recurring.map((s) => [s.signature, s.runs, s.rows]),
      [
        ["npm ERR! missing script: lint", 3, 3],
        ["bwrap: No permissions to create new namespace", 2, 215],
      ],
    );
  });

  it("is one failure across checkouts and line numbers, and two across tools", () => {
    const rows = [
      fail("A", "Error: Cannot find module '/w/.uf-worktrees/r-1/src/x.ts' at line 12"),
      fail("B", "Error: Cannot find module '/w/.uf-worktrees/r-2/src/x.ts' at line 40"),
      fail("C", "File does not exist.", "Read"),
      fail("D", "File does not exist.", "Edit"),
    ];
    const [r] = repeatedFailures(rows);
    assert.equal(r.recurring.length, 1);
    assert.equal(r.recurring[0].runs, 2);
    assert.equal(r.recurring[0].tool, "Bash");
    assert.match(r.recurring[0].sample, /r-1/, "the sample is a real text, not the signature");
    assert.equal(r.singleRun, 2, "a Read and an Edit failing with the same words are two");
  });

  it("counts a failure only one run hit, and does not list it", () => {
    const [r] = repeatedFailures([fail("A", "x"), fail("A", "x"), fail("A", "y")]);
    assert.deepEqual(r.recurring, []);
    assert.equal(r.singleRun, 2);
  });
});

describe("contention", () => {
  const resolve = (
    reviewId: string,
    createdAt: number,
    costUSD: number,
    paths: string[],
    repoKey = "R",
  ): ResolveRow => ({ reviewId, repoKey, createdAt, costUSD, paths });

  it("attaches a resolution's cost to its repository once, never once per file", () => {
    const [c] = contention([
      resolve("1", 10, 5, ["CLAUDE.md", "README.md", "src/a.ts"]),
      resolve("2", 30, 3, ["CLAUDE.md"]),
      resolve("3", 20, 2, ["CLAUDE.md", "README.md", "CLAUDE.md"]),
    ]);
    assert.equal(c.resolutions, 3);
    assert.equal(c.costUSD, 10);
    assert.equal(c.firstAt, 10);
    assert.equal(c.lastAt, 30);
    assert.deepEqual(c.files, [
      { path: "CLAUDE.md", resolutions: 3 },
      { path: "README.md", resolutions: 2 },
    ]);
    assert.equal(c.namedOnce, 1);
  });

  it("counts a resolution whose paths were unreadable, and its cost", () => {
    const [c] = contention([resolve("1", 1, 4, [])]);
    assert.equal(c.resolutions, 1);
    assert.equal(c.costUSD, 4);
    assert.deepEqual(c.files, []);
    assert.equal(c.namedOnce, 0);
  });
});

describe("repositoryKeys", () => {
  it("rolls two mounts onto one directory up as one repository, and buckets none", () => {
    const ids = repositoryKeys(
      ["/w1/repo", "/w3/repo", null, "/w2/api", "/w4/api"],
      (p) => (p.startsWith("/w1/") || p.startsWith("/w3/") ? "dev:1 repo" : `path:${p}`),
      (p) => ({ short: p.split("/").pop()!, qualified: p }),
    );
    assert.equal(ids.keyOf("/w1/repo"), ids.keyOf("/w3/repo"));
    assert.equal(ids.keyOf(null), NO_REPOSITORY_KEY);
    assert.deepEqual(ids.labels.get(NO_REPOSITORY_KEY), {
      label: NO_REPOSITORY_LABEL,
      isRepository: false,
    });
    assert.equal(ids.labels.get(ids.keyOf("/w1/repo"))!.label, "repo");
    // Two repositories that would both read "api" are told apart.
    assert.equal(ids.labels.get(ids.keyOf("/w2/api"))!.label, "/w2/api");
    assert.equal(ids.labels.get(ids.keyOf("/w4/api"))!.label, "/w4/api");
  });
});
