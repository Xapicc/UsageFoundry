import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { continuationRival, edgesExclude, type Continuer } from "./branchRival";

/**
 * The one-continuer rule's pure half. Both mistakes are silent and point
 * opposite ways: too strict, and a success branch and its fixer cannot both be
 * drawn, which is the gap this exists to close; too loose, and two runs commit
 * to one ref with the landing rules left unable to name a last link.
 */

const continuer = (over: Partial<Continuer> = {}): Continuer => ({
  id: "rival",
  edge: "on-success",
  holdsBranch: true,
  isPending: true,
  ...over,
});

describe("edgesExclude", () => {
  it("is true for on-success against on-failure, in both orders, and nothing else", () => {
    const edges = ["on-success", "on-finish", "on-failure", null] as const;
    for (const a of edges) {
      for (const b of edges) {
        const exclusive =
          (a === "on-success" && b === "on-failure") || (a === "on-failure" && b === "on-success");
        assert.equal(edgesExclude(a, b), exclusive, `${a} / ${b}`);
      }
    }
  });
});

describe("continuationRival", () => {
  it("is nothing when no run continues the branch", () => {
    assert.equal(continuationRival("on-success", []), null);
  });

  it("lets the opposite condition through while the rival is only waiting", () => {
    assert.equal(continuationRival("on-failure", [continuer({ edge: "on-success" })]), null);
    assert.equal(continuationRival("on-success", [continuer({ edge: "on-failure" })]), null);
  });

  it("names a rival waiting on the same condition, or on on-finish", () => {
    for (const edge of ["on-success", "on-finish"] as const) {
      const rival = continuer({ edge });
      assert.equal(continuationRival("on-success", [rival]), rival, edge);
    }
    const finish = continuer({ edge: "on-finish" });
    assert.equal(continuationRival("on-failure", [finish]), finish);
  });

  it("names a rival that has been released, whatever it waited on", () => {
    // Released means its condition was met: the opposite one will not be, but
    // only so long as the dependency is not picked up again, and the rival is
    // on the branch either way.
    const released = continuer({ edge: "on-success", isPending: false });
    assert.equal(continuationRival("on-failure", [released]), released);
  });

  it("does not count a rival that holds nothing", () => {
    // A dependent blocked behind a failure put no commit on the branch.
    assert.equal(
      continuationRival("on-success", [continuer({ holdsBranch: false, isPending: false })]),
      null,
    );
  });

  it("counts a rival with no recorded edge, since nothing exempts it", () => {
    const orphan = continuer({ edge: null });
    assert.equal(continuationRival("on-failure", [orphan]), orphan);
  });

  it("finds the third run behind an exempt pair", () => {
    const success = continuer({ id: "success", edge: "on-success" });
    const fixer = continuer({ id: "fixer", edge: "on-failure" });
    // Asked for by a run waiting on the same condition as the first: the
    // exempt one is skipped and the one it overlaps is named, whichever is
    // read first.
    assert.equal(continuationRival("on-success", [fixer, success])?.id, "success");
    assert.equal(continuationRival("on-failure", [success, fixer])?.id, "fixer");
    assert.equal(continuationRival("on-finish", [success, fixer])?.id, "success");
  });
});
