import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  groupRunSpend,
  NO_REPOSITORY_LABEL,
  type RepoPlace,
  type RunSpendRow,
} from "./repoSpend";
import type { ConflictKey } from "./orchestrator";

/**
 * Covers the grouping and only the grouping.
 *
 * Three things about it are worth pinning, and each fails silently — a
 * plausible table of dollar figures says nothing about the money missing from
 * it. Two mounts onto one host directory are routine, not exotic:
 * `docker-compose.yml` defaults `UF_WORKSPACE_2..4` to `${UF_WORKSPACE}`, so
 * `/workspace/repo` and `/workspace3/repo` are the same repository with half the
 * money each if identity is the stored string. A run that was not in a git
 * repository has a null `repo_root` and would simply vanish, which is the
 * failure `groupBy()`'s explicit `(main thread)` / `(no skill)` buckets exist to
 * prevent one table over. And the columns have to add to the total over the same
 * span, or the report cannot be used to apportion anything.
 *
 * `identify` and `describe` are injected, so this needs no mounts and no
 * filesystem; the real caller passes `conflictKey` and `describeFolder`.
 */

/**
 * A stand-in for `conflictKey`: two host paths, and `/w3` is a second mount onto
 * the same directory as `/w1` — exactly what `mountTopology` resolves through
 * the inode.
 */
function identify(p: string): ConflictKey {
  const [, root, ...rest] = p.split("/");
  const rootKey = root === "w3" ? "dev:1" : root === "w1" ? "dev:1" : `path:/${root}`;
  return { rootKey, segs: rest.filter(Boolean) };
}

const describeFolder = (p: string): RepoPlace => ({ mountLabel: null, relPath: p });

const run = (
  id: string,
  repoRoot: string | null,
  spentUSD: number,
  spentEstUSD = 0,
): RunSpendRow => ({
  id,
  repoRoot,
  createdAt: 0,
  spentUSD,
  spentEstUSD,
  spentTokens: spentUSD * 1000,
  spentEstTokens: spentEstUSD * 1000,
  provider: null,
});

describe("groupRunSpend", () => {
  it("rolls two mounts onto one directory up as one repository", () => {
    const { rows } = groupRunSpend(
      [run("a", "/w1/api", 3), run("b", "/w3/api", 5)],
      identify,
      describeFolder,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].runCount, 2);
    assert.equal(rows[0].spentUSD, 8);
  });

  it("keeps two genuinely different repositories apart", () => {
    const { rows } = groupRunSpend(
      [run("a", "/w1/api", 3), run("b", "/w1/web", 5), run("c", "/w2/api", 1)],
      identify,
      describeFolder,
    );
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((r) => r.spentUSD),
      [5, 3, 1],
      "highest first",
    );
  });

  it("groups a case-differing path once, as the folder claim does", () => {
    // `overlaps` case-folds because the host may be case-insensitive, and
    // over-grouping is the direction to be wrong in when the alternative is one
    // repository reported as two half-priced ones.
    const { rows } = groupRunSpend(
      [run("a", "/w1/Api", 3), run("b", "/w1/api", 5)],
      identify,
      describeFolder,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].spentUSD, 8);
  });

  it("names two repositories with one mount-relative path apart, and only those", () => {
    // `/w1/api` and `/w2/api` are two repositories, each `api` within its mount.
    // The card used to label both rows "api", which apportions nothing; `web`
    // shares its name with no one and keeps the short form. A repository that is
    // its mount's root has an empty relative path and takes the mount's label.
    const place = (p: string): RepoPlace => {
      const [, root, ...rest] = p.split("/");
      return { mountLabel: root.toUpperCase(), relPath: rest.join("/") };
    };
    const { rows } = groupRunSpend(
      [run("a", "/w1/api", 3), run("b", "/w2/api", 5), run("c", "/w1/web", 1), run("d", "/w4", 2)],
      identify,
      place,
    );
    assert.deepEqual(
      rows.map((r) => r.label),
      ["W2 / api", "W1 / api", "W4", "web"],
    );
  });

  it("puts a run that was not in a repository in a bucket of its own", () => {
    const { rows } = groupRunSpend(
      [run("a", "/w1/api", 3), run("b", null, 4), run("c", null, 1)],
      identify,
      describeFolder,
    );
    const bucket = rows.find((r) => !r.isRepository);
    assert.ok(bucket, "a run with no repo_root must not be dropped");
    assert.equal(bucket.label, NO_REPOSITORY_LABEL);
    assert.equal(bucket.runCount, 2);
    assert.equal(bucket.spentUSD, 5);
  });

  it("adds up to the account total over the same span", () => {
    // The property the whole report rests on: every run lands in exactly one
    // bucket, so the column can be used to apportion what the span cost.
    const runs = [
      run("a", "/w1/api", 3, 0.5),
      run("b", "/w3/api", 5, 0),
      run("c", "/w1/web", 2, 1.25),
      run("d", "/w2/api", 1, 0),
      run("e", null, 4, 0.25),
    ];
    const { rows, totals } = groupRunSpend(runs, identify, describeFolder);

    assert.equal(totals.runCount, runs.length);
    assert.equal(
      rows.reduce((n, r) => n + r.runCount, 0),
      runs.length,
    );
    assert.equal(totals.spentUSD, 15);
    assert.equal(
      rows.reduce((n, r) => n + r.spentUSD, 0),
      15,
    );
    assert.equal(totals.spentEstUSD, 2);
    assert.equal(
      rows.reduce((n, r) => n + r.spentEstUSD, 0),
      2,
    );
    assert.equal(totals.spentTokens, 15_000);
  });

  it("carries the killed-cycle estimate beside the measured figure, never inside it", () => {
    // The display-versus-guard split, one table over: `spent_usd` is what the
    // CLI itself reported and `spent_usd_est` is reconciled from transcripts, and
    // a report that summed them would present an estimate as a measurement.
    const { rows, totals } = groupRunSpend(
      [run("a", "/w1/api", 2, 7)],
      identify,
      describeFolder,
    );
    assert.equal(rows[0].spentUSD, 2);
    assert.equal(rows[0].spentEstUSD, 7);
    assert.equal(totals.spentUSD, 2);
  });

  // A Codex run reports tokens and no cost. Folded into the dollar columns its
  // zero reads as a measured free run; folded into the token columns its
  // tokens are summed with Claude's, a figure no instrument produced.
  it("counts a Codex run in its own token column and in neither of Claude's", () => {
    const codex: RunSpendRow = {
      ...run("c", "/w1/api", 0),
      provider: "codex",
      spentTokens: 130_963,
      spentEstTokens: 37,
    };
    const { rows, totals } = groupRunSpend(
      [run("a", "/w1/api", 3), codex],
      identify,
      describeFolder,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].runCount, 2);
    assert.equal(rows[0].codexRunCount, 1);
    assert.equal(rows[0].codexTokens, 131_000);
    assert.equal(rows[0].spentTokens, 3000, "Claude's tokens alone");
    assert.equal(rows[0].spentUSD, 3);
    assert.equal(totals.codexTokens, 131_000);
    assert.equal(totals.spentTokens, 3000);
  });

  it("is empty rather than zero when the span holds no runs", () => {
    const { rows, totals } = groupRunSpend([], identify, describeFolder);
    assert.deepEqual(rows, []);
    assert.equal(totals.runCount, 0);
    assert.equal(totals.spentUSD, 0);
  });
});
