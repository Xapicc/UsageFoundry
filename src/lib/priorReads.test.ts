import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { inHoldout, priorReadRanking, repoRelative, type PriorReadRow } from "./priorReads";

/**
 * Covers the prior-read pointer's ranking, its holdout and the relativisation
 * under both.
 *
 * Each fails silently. A wrong relativisation returns absolute paths, or
 * another checkout's, that look plausible in a prompt and name nothing in this
 * run's tree. A ranking whose decay runs the wrong way names last month's files
 * in a block nobody reads closely. And a holdout that is not a pure function of
 * the id leaves the whole experiment unanalysable after the fact: nothing would
 * say which runs were shown the block except prompts the retention sweep is
 * already deleting.
 */

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

  it("refuses another run's slot when the store is inside the base", () => {
    // A repository at the mount root holds the checkout store, so the slot is
    // under the base by prefix and is still somebody else's tree.
    assert.equal(repoRelative("/w/.uf-worktrees/r-2/src/a.ts", "/w"), null);
    assert.equal(repoRelative("/w/.uf-worktrees-notes/a.ts", "/w"), ".uf-worktrees-notes/a.ts");
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

const read = (runId: string, runCreatedAt: number, rel: string, base = "/w/R"): PriorReadRow => ({
  runId,
  runCreatedAt,
  filePath: `${base}/${rel}`,
  base,
});

describe("priorReadRanking", () => {
  it("weights the newest run's reads above an older run's, ×0.9 per run back", () => {
    // old.ts: three reads by the oldest of three runs, 3 × 0.81 = 2.43.
    // new.ts: two reads by the newest, 2 × 1 = 2. mid.ts: one read each by the
    // two older runs, 0.81 + 0.9 = 1.71. Raw frequency would rank old.ts first
    // too, and distinct runs mid.ts first; the decay alone puts new.ts second.
    const rows = [
      read("A", 1, "old.ts"),
      read("A", 1, "old.ts"),
      read("A", 1, "old.ts"),
      read("A", 1, "mid.ts"),
      read("B", 2, "mid.ts"),
      read("C", 3, "new.ts"),
      read("C", 3, "new.ts"),
    ];
    assert.deepEqual(priorReadRanking(rows), [
      { path: "old.ts", runs: 1 },
      { path: "new.ts", runs: 1 },
      { path: "mid.ts", runs: 2 },
    ]);
    // Two runs later the same three reads of old.ts are worth 3 × 0.9^4 = 1.97,
    // and new.ts, read again by the newest run, leads at 2 × 0.81 + 2 = 3.62.
    const later = [...rows, read("D", 4, "other.ts"), read("E", 5, "new.ts"), read("E", 5, "new.ts")];
    assert.equal(priorReadRanking(later)[0].path, "new.ts");
  });

  it("orders runs by when they were created, whatever order the rows come in", () => {
    const rows = [read("C", 3, "new.ts"), read("A", 1, "old.ts"), read("A", 1, "old.ts")];
    // old.ts: 2 × 0.9 = 1.8 against new.ts's 1, from the same rows in any order.
    assert.deepEqual(
      priorReadRanking(rows).map((r) => r.path),
      ["old.ts", "new.ts"],
    );
    assert.deepEqual(priorReadRanking([...rows].reverse()), priorReadRanking(rows));
  });

  it("names repository-relative paths, and never one outside the run's own base", () => {
    const rows: PriorReadRow[] = [
      // One file, read through two checkouts and the repository itself.
      { runId: "A", runCreatedAt: 1, filePath: "/w/.uf-worktrees/r-1/src/a.ts", base: "/w/.uf-worktrees/r-1" },
      { runId: "B", runCreatedAt: 2, filePath: "/w/.uf-worktrees/r-2/src/a.ts", base: "/w/.uf-worktrees/r-2" },
      { runId: "C", runCreatedAt: 3, filePath: "/w/R/src/a.ts", base: "/w/R" },
      // Another checkout's copy, a scratch file and a climb out of the base.
      { runId: "C", runCreatedAt: 3, filePath: "/w/.uf-worktrees/r-2/src/b.ts", base: "/w/.uf-worktrees/r-1" },
      { runId: "C", runCreatedAt: 3, filePath: "/tmp/scratch.txt", base: "/w/R" },
      { runId: "C", runCreatedAt: 3, filePath: "/w/R/../S/c.ts", base: "/w/R" },
    ];
    assert.deepEqual(priorReadRanking(rows), [{ path: "src/a.ts", runs: 3 }]);
  });

  it("fills its limit past candidates `keep` refuses, in rank order", () => {
    const rows = ["a", "b", "c", "d", "e"].flatMap((name, i) =>
      Array.from({ length: 5 - i }, () => read("A", 1, `${name}.ts`)),
    );
    const asked: string[] = [];
    const ranked = priorReadRanking(rows, {
      limit: 2,
      keep: (rel) => {
        asked.push(rel);
        return rel !== "a.ts" && rel !== "c.ts";
      },
    });
    assert.deepEqual(
      ranked.map((r) => r.path),
      ["b.ts", "d.ts"],
    );
    assert.deepEqual(asked, ["a.ts", "b.ts", "c.ts", "d.ts"], "and stops asking once it has enough");
  });

  it("breaks ties by path, so one history always ranks one way", () => {
    const rows = [read("A", 1, "z.ts"), read("A", 1, "m.ts"), read("A", 1, "a.ts")];
    assert.deepEqual(
      priorReadRanking(rows).map((r) => r.path),
      ["a.ts", "m.ts", "z.ts"],
    );
  });

  it("has nothing to name for a repository with no earlier reads", () => {
    assert.deepEqual(priorReadRanking([]), []);
  });
});

describe("inHoldout", () => {
  it("gives a run the arm it was given before, pinned against four fixed ids", () => {
    // Recomputed on every cycle and in any later analysis, so a change to the
    // hash or to its preimage silently re-deals the arm of every run already
    // in the log. These values were taken when the holdout shipped.
    assert.equal(inHoldout("aaaaaaaa-0000-4000-8000-000000000000"), true);
    assert.equal(inHoldout("aaaaaaaa-0000-4000-8000-000000000003"), true);
    assert.equal(inHoldout("aaaaaaaa-0000-4000-8000-000000000001"), false);
    assert.equal(inHoldout("aaaaaaaa-0000-4000-8000-000000000002"), false);
  });

  it("is a function of the id alone", () => {
    const id = randomUUID();
    const first = inHoldout(id);
    for (let i = 0; i < 20; i++) assert.equal(inHoldout(id), first);
  });

  it("holds out about half of random ids", () => {
    // 4,000 draws: a fair split lands inside 47–53% with probability above
    // 0.9999, so a failure here is a biased split rather than bad luck.
    let held = 0;
    for (let i = 0; i < 4000; i++) if (inHoldout(randomUUID())) held += 1;
    assert.ok(held > 1880 && held < 2120, `${held} of 4000 held out`);
  });

  it("draws a split of its own, not the one a bare id hashes to", () => {
    // Two experiments on bare ids would put the same runs in the same arms.
    const bare = (id: string) =>
      createHash("sha256").update(id).digest().readUInt32BE(0) < 0x8000_0000;
    let agree = 0;
    for (let i = 0; i < 4000; i++) {
      const id = randomUUID();
      if (inHoldout(id) === bare(id)) agree += 1;
    }
    assert.ok(agree > 1880 && agree < 2120, `${agree} of 4000 agree`);
  });
});
