import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { HoldoutArmDTO, HoldoutLookDTO } from "./apiTypes";
import * as inference from "./holdoutInference";

/**
 * Covers the three parts of the holdout's analysis plan the readback computes
 * beyond an arm-against-arm difference: the repository-stratified primary with
 * its permutation p-value, the two looks on fixed boundaries, and the
 * interference check.
 *
 * It earns a test because each of them returns a plausible number in the right
 * units when it is wrong. A weight taken from the wrong stratum, a variance
 * summed without squaring the weight, a look taken from today's runs rather than
 * the runs there were when the smaller arm reached the planned size, or a slope
 * taken before repositories are centred, each still renders an interval, and the
 * operator decides whether to build the gate hook from it. Every expected value
 * below is worked by hand in the comment beside it.
 *
 * Pure: no database and no `config`, so no `DATA_DIR` guard.
 */

const near = (actual: number | null, expected: number, eps = 1e-6) => {
  assert.ok(actual !== null && Math.abs(actual - expected) < eps, `expected ${expected}, got ${actual}`);
};

let counter = 0;
const run = (arm: HoldoutArmDTO, stratum: string, y: number, settledAt = 0): inference.InferenceRun => ({
  runId: `r${counter++}`,
  arm,
  stratum,
  y,
  settledAt,
});
const runs = (arm: HoldoutArmDTO, stratum: string, values: number[]) => values.map((y) => run(arm, stratum, y));

describe("the stratified difference", () => {
  it("is Welch's difference and interval inside one repository", () => {
    // Pointer 4, 6, 8: mean 6, variance (4+0+4)/2 = 4. Held out 1, 2, 3: mean 2,
    // variance 1. Difference 4; variance 4/3 + 1/3 = 5/3, se 1.2909944.
    const got = inference.stratifiedDifference([...runs("pointer", "a", [4, 6, 8]), ...runs("holdout", "a", [1, 2, 3])]);
    near(got.difference, 4);
    near(got.low, 4 - 1.96 * 1.2909944);
    near(got.high, 4 + 1.96 * 1.2909944);
    near(got.z, 4 / 1.2909944);
    assert.deepEqual(got.runs, { pointer: 3, holdout: 3 });
    assert.equal(got.strata, 1);
  });

  it("weights each repository by its share of the runs, not by how the arms were dealt", () => {
    // A: pointer 2, 4 (mean 3, variance 2); held out 1, 3, 1, 3 (mean 2, variance
    // 4/3). Difference 1, variance 2/2 + (4/3)/4 = 4/3, six runs.
    // B: pointer 10, 14 (mean 12, variance 8); held out 6, 10 (mean 8, variance
    // 8). Difference 4, variance 8/2 + 8/2 = 8, four runs.
    // Weights 0.6 and 0.4: difference 0.6 + 1.6 = 2.2; variance
    // 0.36 * 4/3 + 0.16 * 8 = 0.48 + 1.28 = 1.76, se 1.3266499. The pooled
    // difference of the same ten runs is 7.5 - 4 = 3.5, which is what a repository
    // dealt unevenly towards its arm would have produced.
    const got = inference.stratifiedDifference([
      ...runs("pointer", "a", [2, 4]),
      ...runs("holdout", "a", [1, 3, 1, 3]),
      ...runs("pointer", "b", [10, 14]),
      ...runs("holdout", "b", [6, 10]),
    ]);
    near(got.difference, 2.2);
    near(got.low, 2.2 - 1.96 * 1.3266499);
    near(got.z, 2.2 / 1.3266499);
    assert.equal(got.strata, 2);
  });

  it("sets aside a repository where an arm holds fewer than two runs, and says how many runs that was", () => {
    // C has one pointer run, so no variance for that arm: its three runs are out
    // and the estimate is A and B's alone.
    const got = inference.stratifiedDifference([
      ...runs("pointer", "a", [2, 4]),
      ...runs("holdout", "a", [1, 3, 1, 3]),
      ...runs("pointer", "b", [10, 14]),
      ...runs("holdout", "b", [6, 10]),
      ...runs("pointer", "c", [5]),
      ...runs("holdout", "c", [6, 7]),
    ]);
    near(got.difference, 2.2);
    assert.equal(got.setAside, 3);
    assert.deepEqual(got.runs, { pointer: 4, holdout: 6 });

    const none = inference.stratifiedDifference(runs("pointer", "c", [5]));
    assert.deepEqual([none.difference, none.low, none.high, none.z, none.setAside], [null, null, null, null, 1]);
  });
});

describe("the permutation p-value", () => {
  it("counts every assignment when there are few enough, and the observed one counts itself", () => {
    // 1, 2, 3 against 4, 5, 6: twenty ways to pick the pointer arm. Only the
    // observed split and its mirror reach |t| = 3 / 0.8165 = 3.674; the next
    // largest (1, 2, 4 against 3, 5, 6) is 1.87. So 2 / 20.
    const got = inference.permutationTest([...runs("pointer", "a", [1, 2, 3]), ...runs("holdout", "a", [4, 5, 6])]);
    assert.deepEqual(got, { p: 0.1, assignments: 20, exact: true });
  });

  it("is one when nothing differs at all, which is no spread and no difference", () => {
    const got = inference.permutationTest([...runs("pointer", "a", [3, 3]), ...runs("holdout", "a", [3, 3])]);
    assert.deepEqual(got, { p: 1, assignments: 6, exact: true });
  });

  it("re-deals within each repository, so two repositories multiply their assignments", () => {
    // C(4,2) = 6 in each of two repositories, 36 in all.
    const got = inference.permutationTest([
      ...runs("pointer", "a", [1, 2]),
      ...runs("holdout", "a", [8, 9]),
      ...runs("pointer", "b", [11, 12]),
      ...runs("holdout", "b", [18, 19]),
    ]);
    assert.equal(got.assignments, 36);
    assert.equal(got.exact, true);
    // The observed split puts the low values in the pointer arm in both; the only
    // assignment as extreme in the other direction is its mirror, and no split
    // that mixes them is: 2 / 36.
    assert.equal(got.p, 2 / 36);
  });

  it("samples when there are too many, as (1 + at least as extreme) / (1 + draws), and the same every time", () => {
    // 1..10 against 11..20 has 184,756 assignments. Two of them are as extreme as
    // the one observed, so 999 draws find none and the p-value is 1 / 1000.
    const separated = [...runs("pointer", "a", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), ...runs("holdout", "a", [11, 12, 13, 14, 15, 16, 17, 18, 19, 20])];
    const options = { exactLimit: 1000, draws: 999 };
    const got = inference.permutationTest(separated, options);
    assert.deepEqual(got, { p: 0.001, assignments: 999, exact: false });
    assert.deepEqual(inference.permutationTest(separated, options), got, "a reload must not be a fresh draw");

    // Interleaved values: t = -1 / 2.569 = -0.39, and about 70% of assignments are
    // at least that far from zero.
    const mixed = [
      ...runs("pointer", "a", [1, 3, 5, 7, 9, 11, 13, 15, 17, 19]),
      ...runs("holdout", "a", [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]),
    ];
    const p = inference.permutationTest(mixed, options).p!;
    assert.ok(p > 0.6 && p < 0.8, `expected about 0.7, got ${p}`);
  });

  it("has no p-value without a repository to compare inside", () => {
    assert.deepEqual(inference.permutationTest(runs("pointer", "a", [1, 2])), { p: null, assignments: 0, exact: false });
  });
});

describe("the two looks", () => {
  const plan = { interimPerArm: 2, finalPerArm: 4 };
  /** Alternating arms, settling at 1, 2, 3…, one repository. */
  const settling = (values: number[]) =>
    values.map((y, i) => ({ ...run(i % 2 === 0 ? "pointer" : "holdout", "a", y), settledAt: i + 1 }));

  it("takes the interim from the runs there were when the smaller arm reached the plan, and the final likewise", () => {
    // Settled 1 to 4: pointer 3, 5 and held out 2, 4. Both arms hold two at the
    // fourth. Difference 4 - 3 = 1, variance 2/2 + 2/2 = 2, z = 0.7071.
    // Settled 1 to 8 adds pointer 4, 6 and held out 5, 3: pointer mean 4.5,
    // held out 3.5, both variances 5/3, so variance (5/3 + 5/3) / 4 = 5/6 and
    // z = 1 / 0.91287 = 1.0954.
    const values = [3, 2, 5, 4, 4, 5, 6, 3];
    const got = inference.sequentialOf(settling(values), plan);
    const [interim, final] = got.looks;
    assert.equal(interim.reachedAt, 4);
    assert.deepEqual(interim.runs, { pointer: 2, holdout: 2 });
    near(interim.z, 1 / Math.sqrt(2));
    assert.equal(interim.crossed, false);
    assert.equal(final.reachedAt, 8);
    near(final.z, 1 / Math.sqrt(5 / 6));
    assert.equal(final.crossed, false);
    assert.equal(got.verdict, "none-at-final");

    // Runs that settle afterwards, however extreme, are the reading to date and
    // are in neither look.
    const later = inference.sequentialOf(
      [...settling(values), { ...run("pointer", "a", 100), settledAt: 9 }, { ...run("holdout", "a", 0), settledAt: 10 }],
      plan,
    );
    assert.deepEqual(later.looks, got.looks);
  });

  it("orders by when runs settled, not by the order they are given", () => {
    const values = [3, 2, 5, 4, 4, 5, 6, 3];
    assert.deepEqual(inference.sequentialOf(settling(values).reverse(), plan), inference.sequentialOf(settling(values), plan));
  });

  it("crosses the strict interim boundary and stops there, whatever the final says", () => {
    // Pointer 10, 12 against held out 2, 4: difference 8, variance 2, z = 5.657
    // against 2.797.
    const got = inference.sequentialOf(settling([10, 2, 12, 4, 14, 3, 11, 5]), plan);
    assert.equal(got.looks[0].crossed, true);
    assert.equal(got.looks[1].crossed, true);
    assert.equal(got.verdict, "difference-at-interim");
  });

  it("reports what each arm holds so far, and calls nothing, before a look is reached", () => {
    const got = inference.sequentialOf(settling([3, 2, 5]), plan);
    assert.deepEqual(got.looks.map((l) => [l.reachedAt, l.z, l.crossed, l.runs.pointer, l.runs.holdout]), [
      [null, null, null, 2, 1],
      [null, null, null, 2, 1],
    ]);
    assert.equal(got.verdict, "before-interim");
  });

  it("plans the interim at half the final, rounded up, on the plan's boundaries", () => {
    assert.deepEqual(inference.lookPlan(410), { interimPerArm: 205, finalPerArm: 410 });
    assert.deepEqual(inference.lookPlan(5), { interimPerArm: 3, finalPerArm: 5 });
    assert.deepEqual(inference.OBRIEN_FLEMING, { interim: 2.797, final: 1.977 });
    const got = inference.sequentialOf([], inference.lookPlan());
    assert.deepEqual(got.looks.map((l) => [l.stage, l.perArm, l.boundary]), [
      ["interim", 205, 2.797],
      ["final", 410, 1.977],
    ]);
  });

  it("reads a final that crosses its own, lower, boundary", () => {
    const look = (stage: "interim" | "final", crossed: boolean | null): HoldoutLookDTO => ({
      stage,
      perArm: 1,
      boundary: 1,
      reachedAt: crossed === null ? null : 1,
      runs: { pointer: 0, holdout: 0 },
      z: null,
      crossed,
    });
    assert.equal(inference.verdictOf([look("interim", false), look("final", true)]), "difference-at-final");
    assert.equal(inference.verdictOf([look("interim", false), look("final", null)]), "continue");
    assert.equal(inference.verdictOf([look("interim", true), look("final", false)]), "difference-at-interim");
    assert.equal(inference.verdictOf([look("interim", null), look("final", null)]), "before-interim");
  });
});

describe("the slope within repositories", () => {
  it("is the least-squares slope of the centred values, with its HC2 error", () => {
    // x 0, 1, 2, 3 and y 1, 3, 2, 6: centred x -1.5, -0.5, 0.5, 1.5 and y -2, 0,
    // -1, 3. Sxy 7, Sxx 5, slope 1.4. Residuals 0.1, 0.7, -1.7, 0.9; leverage
    // 1/4 + x²/5 = 0.7, 0.3, 0.3, 0.7. HC2: sum x² e² / (1 - h) =
    // 0.075 + 0.175 + 1.032143 + 6.075 = 7.357143, over Sxx² = 25, se 0.542481.
    const got = inference.withinSlope([0, 1, 2, 3].map((x, i) => ({ stratum: "a", x, y: [1, 3, 2, 6][i] })));
    near(got.slope, 1.4);
    near(got.se, 0.542481);
    near(got.exposureSd, Math.sqrt(5 / 3));
    assert.equal(got.runs, 4);
  });

  it("centres each repository first, and drops one with a single run", () => {
    // The second repository reads a hundred files more and has a very different
    // treated share; centred, its points are x -1, 1 and y -2, 2. Sxx 5 + 2 = 7,
    // Sxy 7 + 4 = 11.
    const got = inference.withinSlope([
      ...[0, 1, 2, 3].map((x, i) => ({ stratum: "a", x, y: [1, 3, 2, 6][i] })),
      { stratum: "b", x: 10, y: 100 },
      { stratum: "b", x: 12, y: 104 },
      { stratum: "c", x: 5, y: 5 },
    ]);
    near(got.slope, 11 / 7);
    assert.equal(got.runs, 6);
  });

  it("has no slope when the exposure never varies", () => {
    const got = inference.withinSlope([
      { stratum: "a", x: 0.5, y: 1 },
      { stratum: "a", x: 0.5, y: 3 },
    ]);
    assert.deepEqual([got.slope, got.se], [null, null]);
  });
});

describe("the interference check", () => {
  const subject = (stratum: string, y: number, neighbours: string[] | null) => ({ stratum, y, neighbours });
  const arms = (entries: Array<[string, HoldoutArmDTO]>) => new Map(entries);
  const never = () => {
    throw new Error("no re-deal expected");
  };

  it("takes the treated share over neighbours of known arm only, and sets aside a run with none", () => {
    // s1's neighbours a, b, c are pointer, held out, pointer: share 2/3. s2's are
    // d (pointer) and z, whose arm is unknown: share 1, not 1/2. s3 recorded no
    // set and s4 has only z. Centred x -1/6, 1/6 and y -2, 2: slope
    // (1/3 + 1/3) / (2/36) = 12.
    const got = inference.interferenceOf(
      [
        subject("r", 1, ["a", "b", "c"]),
        subject("r", 5, ["d", "z"]),
        subject("r", 9, null),
        subject("r", 9, ["z"]),
      ],
      arms([
        ["a", "pointer"],
        ["b", "holdout"],
        ["c", "pointer"],
        ["d", "pointer"],
      ]),
      () => "holdout",
      1,
    );
    near(got.slope, 12);
    assert.equal(got.runs, 2);
    assert.equal(got.setAside, 2);
  });

  it("counts the re-dealt assignments at least as extreme, with the observed one's equal counting", () => {
    // Four runs reading 1, 2, 5, 6 with one neighbour each, dealt held out,
    // held out, pointer, pointer: x 0, 0, 1, 1, slope 4, HC2 se sqrt(0.5).
    // Four re-deals, as the arms of n1..n4: P H H P gives slope 0; P P H H gives
    // -4; H H P P gives 4; H P H P gives 1. Two reach |4|: (1 + 2) / (1 + 4).
    const deals: Record<number, HoldoutArmDTO[]> = {
      0: ["pointer", "holdout", "holdout", "pointer"],
      1: ["pointer", "pointer", "holdout", "holdout"],
      2: ["holdout", "holdout", "pointer", "pointer"],
      3: ["holdout", "pointer", "holdout", "pointer"],
    };
    const got = inference.interferenceOf(
      [subject("r", 1, ["n1"]), subject("r", 2, ["n2"]), subject("r", 5, ["n3"]), subject("r", 6, ["n4"])],
      arms([
        ["n1", "holdout"],
        ["n2", "holdout"],
        ["n3", "pointer"],
        ["n4", "pointer"],
      ]),
      (replicate, id) => deals[replicate][Number(id.slice(1)) - 1],
      4,
    );
    near(got.slope, 4);
    near(got.low, 4 - 1.96 * Math.sqrt(0.5));
    near(got.high, 4 + 1.96 * Math.sqrt(0.5));
    assert.equal(got.p, 0.6);
    assert.equal(got.draws, 4);
  });

  it("reports no slope, and re-deals nothing, when every neighbour was dealt the same arm", () => {
    const got = inference.interferenceOf(
      [subject("r", 1, ["a"]), subject("r", 3, ["b"])],
      arms([
        ["a", "pointer"],
        ["b", "pointer"],
      ]),
      never,
      50,
    );
    assert.deepEqual([got.slope, got.low, got.high, got.p], [null, null, null, null]);
  });
});

describe("the seeded generator", () => {
  it("gives one sequence per seed, inside [0, 1)", () => {
    const a = inference.seededRandom(7);
    const b = inference.seededRandom(7);
    const first = [a(), a(), a()];
    assert.deepEqual([b(), b(), b()], first);
    assert.ok(first.every((v) => v >= 0 && v < 1));
    assert.notDeepEqual([inference.seededRandom(8)(), 0, 0], [first[0], 0, 0]);
  });
});
