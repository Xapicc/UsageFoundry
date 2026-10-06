import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * The `fork_attempts` row, written and read back against a real database.
 *
 * This file exists because of a bug the arithmetic tests could not see. The
 * INSERT listed twelve columns and bound thirteen values; better-sqlite3
 * rejects that at bind time, `recordForkAttempt` catches and returns null, and
 * the whole feature went quiet — no fork was ever recorded, `forkSavings`
 * summed an empty table, and `resumed` (which is milestone 2's acceptance
 * criterion) could never be written. Nothing threw, nothing logged, and the
 * savings panel showed $0, which reads as "the fork engine did nothing".
 *
 * `parseFork` and `forkCutFromRow` were both tested. The defect sat between
 * them, in the one step that needs a driver and a schema, so it survived. That
 * is the argument for this file: the arity of a prepared statement is not
 * checked by the type system, and a mock would have accepted it.
 *
 * The fixture's numbers are deliberately all different from one another. An
 * all-zeros row passes even when two columns are transposed; distinct values
 * catch an off-by-one shift as well as the arity error that prompted this.
 */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "uf-fork-attempts-"));

before(() => {
  process.env.DATA_DIR = path.join(TMP, ".data");
  process.env.CLAUDE_HOME = path.join(TMP, "claude");
  fs.mkdirSync(path.join(TMP, "claude", "projects"), { recursive: true });
});

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const WRITTEN = {
  written: true,
  newSessionId: "4356069f-3111-569c-842e-a766dbbfbeab",
  out: "/tmp/x/4356069f.jsonl",
  refusedBy: null,
  reason: null,
  removedBytes: 24_029,
  netBytes: 22_725,
  suffixBytes: 122_902,
  breakEvenTurns: 82.8,
  coldAgeSeconds: 12.5,
};

const REFUSED = {
  written: false,
  newSessionId: null,
  out: null,
  refusedBy: "cold-age",
  reason: "this session's last request finished 0s ago",
  removedBytes: 24_029,
  netBytes: 22_725,
  suffixBytes: 122_902,
  breakEvenTurns: 82.8,
  coldAgeSeconds: 0.1,
};

describe("recordForkAttempt", () => {
  it("writes a row at all, and every column lands where it belongs", async () => {
    const { recordForkAttempt } = await import("./contextPruning.js");
    const { db } = await import("./db.js");

    const rowId = recordForkAttempt(
      "run-a",
      "src-session",
      WRITTEN,
      300,
      "boundary",
      180_000,
      201_500,
    );
    assert.notEqual(
      rowId,
      null,
      "a null row id is the shape of a silently refused insert",
    );

    const row = db()
      .prepare("SELECT * FROM fork_attempts WHERE id = ?")
      .get(rowId) as Record<string, unknown>;
    assert.equal(row.run_id, "run-a");
    assert.equal(row.source_session_id, "src-session");
    assert.equal(row.new_session_id, WRITTEN.newSessionId);
    assert.equal(row.written, 1);
    assert.equal(row.removed_bytes, 24_029);
    assert.equal(row.net_bytes, 22_725);
    // The column whose absence from the INSERT list caused the failure.
    assert.equal(row.suffix_bytes, 122_902);
    assert.equal(row.break_even_turns, 82.8);
    assert.equal(row.cold_age_seconds, 12.5);
    assert.equal(row.min_cold_age, 300);
    assert.equal(row.resumed, null, "a fork has no verdict until one resumes it");
    // The two that decide how the cut is priced rather than merely describing
    // it. Without the trigger every fork read as a free boundary cut; without
    // the conversation size the rewrite was estimated off the suffix, which is
    // a third of it.
    assert.equal(row.trigger, "boundary");
    assert.equal(row.context_tokens_after, 180_000);
    // The one reading only this moment can take. The run moves off the source
    // session as soon as the fork is adopted, so a window not written here is
    // gone; and without it the removal is credited on transcript bytes, which
    // is the thing five measured forks say does not reach the API at all.
    assert.equal(row.api_context_before, 201_500);
    assert.equal(
      row.api_context_after,
      null,
      "the other half is the resume's, and no cycle has resumed this yet",
    );
  });

  it("puts a fork in front of the dashboard, not only its own run's page", async () => {
    // The two views disagreed. A run's page goes through `pruneSavings`, which
    // reads both tables; the dashboard reached for `priceReceipts(readReceipts)`
    // directly, which is the legacy table alone — so a fork showed a figure on
    // one screen and was absent from the other. `pricedCuts` is the seam both
    // now share, and this asserts it can see a fork at all.
    const { recordForkAttempt, pricedCuts } = await import("./contextPruning.js");

    recordForkAttempt(
      "run-dash",
      "src-session",
      WRITTEN,
      0,
      "early-end",
      180_000,
      null,
    );
    const cuts = await pricedCuts({ runId: "run-dash" });
    assert.equal(
      cuts.length,
      1,
      "a written fork has to appear in the list the dashboard sums, or the " +
        "card reports $0 for work that happened",
    );
    assert.equal(cuts[0].row.trigger, "early-end");
    assert.equal(cuts[0].row.tokensAfter, 180_000);
  });

  it("records a refusal, because that is the common outcome at a boundary", async () => {
    // At winnow's default cold age every boundary refuses. An operator who
    // switched the engine on and saw nothing happen has to be able to read
    // forty cold-age rows rather than find an empty table and conclude the
    // feature is broken.
    const { recordForkAttempt } = await import("./contextPruning.js");
    const { db } = await import("./db.js");

    const rowId = recordForkAttempt(
      "run-b",
      "src-session",
      REFUSED,
      3600,
      "early-end",
      null,
      null,
    );
    assert.notEqual(rowId, null);

    const row = db()
      .prepare("SELECT * FROM fork_attempts WHERE id = ?")
      .get(rowId) as Record<string, unknown>;
    assert.equal(row.written, 0);
    assert.equal(row.new_session_id, null, "nothing was written, so nothing is named");
    assert.equal(row.refused_by, "cold-age");
    assert.equal(row.min_cold_age, 3600);
  });

  it("carries the verdict a resume gives it, in both directions", async () => {
    const { recordForkAttempt, markForkResumed } = await import("./contextPruning.js");
    const { db } = await import("./db.js");
    const read = (id: number) =>
      db()
        .prepare(
          "SELECT resumed, api_context_after FROM fork_attempts WHERE id = ?",
        )
        .get(id) as { resumed: number | null; api_context_after: number | null };

    const good = recordForkAttempt("run-c", "s", WRITTEN, 0, "boundary", null, 200_000)!;
    markForkResumed(good, true, 199_400);
    assert.equal(read(good).resumed, 1);
    // The second half of the removal measurement, settled at the same moment
    // and by the same call because that is when it becomes true: the window the
    // resume was asked to carry.
    assert.equal(read(good).api_context_after, 199_400);

    // The kill condition. It has to be writable, or milestone 2's guardrail
    // cannot fail — which is worse than failing it.
    const bad = recordForkAttempt("run-d", "s", WRITTEN, 0, "boundary", null, 200_000)!;
    markForkResumed(bad, false);
    assert.equal(read(bad).resumed, 0);
    // A rollback measures nothing, and an omitted reading must stay omitted
    // rather than land as a zero — a zero here says the resume carried an empty
    // conversation, which would credit the fork with removing the whole window.
    assert.equal(read(bad).api_context_after, null);
  });

  it("finds a fork a parked run came back holding, and only that one", async () => {
    const { recordForkAttempt, markForkResumed, pendingForkFor } = await import(
      "./contextPruning.js"
    );

    const rowId = recordForkAttempt(
      "run-e",
      "before-the-fork",
      WRITTEN,
      0,
      "boundary",
      null,
      null,
    )!;
    const found = pendingForkFor("run-e", WRITTEN.newSessionId);
    assert.equal(found?.rowId, rowId);
    assert.equal(found?.fallbackSessionId, "before-the-fork");

    // Not a fork the run has already moved off.
    assert.equal(pendingForkFor("run-e", "some-other-session"), null);
    // Not one that already has a verdict.
    markForkResumed(rowId, true);
    assert.equal(pendingForkFor("run-e", WRITTEN.newSessionId), null);
  });

  it("turns a recorded fork into a saving, which is the point of recording it", async () => {
    // Ties the row to the symptom. Before the INSERT was fixed this returned
    // zero for every install, and a zero on that panel reads as the engine
    // having done nothing rather than as nothing having been written down.
    const { recordForkAttempt, markForkResumed, forkSavings } = await import(
      "./contextPruning.js"
    );
    const { db } = await import("./db.js");
    db()
      .prepare(
        "INSERT OR REPLACE INTO runs (id, folder, prompt, status, budget, created_at, model) VALUES (?,?,?,?,?,?,?)",
      )
      .run("run-f", "/x", "t", "completed", 10, Date.now() - 1000, "claude-opus-5");

    // Measured on both sides, because that is now what a credit takes. The
    // window fell 6,000 tokens across the resume; `net_bytes` claims 22,725
    // bytes came out of the file and has no bearing on the figure below.
    const rowId = recordForkAttempt("run-f", "s", WRITTEN, 0, "boundary", null, 206_000)!;
    markForkResumed(rowId, true, 200_000);
    const savings = await forkSavings({ runId: "run-f" });
    assert.equal(savings.prunes, 1);
    assert.equal(
      savings.tokensRemoved,
      6_000,
      "the credited removal is the API window's own fall, not net_bytes ÷ 3.6",
    );
  });

  it("weighs the ceiling's cut against what forks here have measured", async () => {
    // The figure the expensive gate divides by. `ceilingCut` used to hand it
    // `plan.netBytes / BYTES_PER_TOKEN`, a quantity of file, to decide whether
    // to spend ~$1.80 manufacturing a boundary. It now asks the table what
    // forks on this install have actually taken off the API's window.
    //
    // The per-row floor is the part that fails silently. A resume carrying more
    // than the cut left is a fork that removed nothing — which is what all five
    // measured forks did — and letting its negative pay for another fork's
    // positive would net two unrelated conversations against each other and
    // reopen the gate on arithmetic nobody intended.
    const { recordForkAttempt, markForkResumed, measuredForkRemoval } = await import(
      "./contextPruning.js"
    );
    const { db } = await import("./db.js");

    // The figure is install-wide by design — what forking is worth here is a
    // property of the pinned CLI and not of one run — so a case about having no
    // evidence has to own the table. Every assertion after this one in the file
    // is scoped to its own run id.
    db().exec("DELETE FROM fork_attempts");
    assert.equal(
      measuredForkRemoval(),
      null,
      "no settled fork is unknown, and unknown declines rather than reading zero",
    );

    // Removed 4,000. Measured.
    markForkResumed(
      recordForkAttempt("run-m1", "s", WRITTEN, 0, "boundary", null, 200_000)!,
      true,
      196_000,
    );
    // Grew by 3,000 across the resume: removed nothing, and may not subtract
    // from the one above.
    markForkResumed(
      recordForkAttempt("run-m2", "s", WRITTEN, 0, "boundary", null, 200_000)!,
      true,
      203_000,
    );
    // Never measured, so not evidence either way and not a zero in the mean.
    recordForkAttempt("run-m3", "s", WRITTEN, 0, "boundary", null, null);

    assert.deepEqual(measuredForkRemoval(), { removed: 2_000, forks: 2 });
  });

  it("credits nothing for a fork nobody measured against the API", async () => {
    // The defect this pair exists to close. `winnow fork` rewrites
    // `message.content` and leaves `toolUseResult`, which the resumed CLI
    // rebuilds its tool results from — so bytes leave the file whether or not
    // they leave the request. On all five forks this install wrote before the
    // two columns existed, the API window after the resume was *higher* than
    // before the cut while `net_bytes` claimed 4,678–17,594 tokens removed.
    // A row with no reading is unknown, and unknown may not be priced.
    const { recordForkAttempt, forkSavings } = await import("./contextPruning.js");
    const { db } = await import("./db.js");
    db()
      .prepare(
        "INSERT OR REPLACE INTO runs (id, folder, prompt, status, budget, created_at, model) VALUES (?,?,?,?,?,?,?)",
      )
      .run("run-g", "/x", "t", "completed", 10, Date.now() - 1000, "claude-opus-5");

    recordForkAttempt("run-g", "s", WRITTEN, 0, "boundary", null, null);
    const savings = await forkSavings({ runId: "run-g" });
    assert.equal(savings.prunes, 1, "the cut still happened and is still counted");
    assert.equal(savings.tokensRemoved, 0);
    assert.equal(
      savings.cacheSavedUSD,
      0,
      "a saving is a claim about the request, so an unread request earns none",
    );
  });
});

describe("pricing a cut beside other cuts", () => {
  it("prices a boundary prune the same on the runs list, its page and the dashboard", async () => {
    // Here rather than in the pure suite because the defect was in which
    // probes were read, not in any arithmetic: the control group started at
    // the earliest cut in whatever batch was being priced. The dashboard's
    // batch reached back past an older run's cut and saw five clean probes;
    // the runs list and the run's own page started at this cut and saw none.
    // One boundary prune, charged on one screen and free on the other two —
    // measured on this install as a session net of −$0.95 beside two runs
    // that both read positive.
    const { pruneSavingsByRun, pruneSavings, pricedCuts, sumPruneSavings } =
      await import("./contextPruning.js");
    const { db } = await import("./db.js");

    const now = Date.now();
    const HOUR = 3_600_000;
    const older = now - 10 * HOUR;
    const cutAt = now - HOUR;
    const projectDir = path.join(TMP, "claude", "projects", "-workspace-ctl");
    fs.mkdirSync(projectDir, { recursive: true });
    const turn = (
      sessionId: string,
      ts: number,
      cacheRead: number,
      cacheWrite1h: number,
    ) =>
      JSON.stringify({
        type: "assistant",
        uuid: `u-${sessionId}-${ts}`,
        requestId: `req_${sessionId}_${ts}`,
        timestamp: new Date(ts).toISOString(),
        sessionId,
        cwd: "/workspace/ctl",
        message: {
          id: `msg_${sessionId}_${ts}`,
          model: "claude-opus-5",
          usage: {
            input_tokens: 10,
            output_tokens: 200,
            cache_read_input_tokens: cacheRead,
            cache_creation_input_tokens: cacheWrite1h,
            cache_creation: { ephemeral_1h_input_tokens: cacheWrite1h },
          },
        },
      });
    const writeSession = (sessionId: string, lines: string[]) =>
      fs.writeFileSync(
        path.join(projectDir, `${sessionId}.jsonl`),
        `${lines.join("\n")}\n`,
      );

    // Five clean boundaries, all before the cut, and every one resumed warm:
    // on this install the prefix outlives a boundary, so a cold resume after a
    // prune is the prune's doing.
    for (let k = 1; k <= 5; k++) {
      const probeAt = older + k * HOUR;
      db()
        .prepare(
          "INSERT INTO resume_probes (ts, run_id, session_id, pruned, tokens_before) VALUES (?,?,?,0,?)",
        )
        .run(probeAt, `run-probe-${k}`, `s-probe-${k}`, 100_000);
      writeSession(`s-probe-${k}`, [turn(`s-probe-${k}`, probeAt + 60_000, 100_000, 1_000)]);
    }

    // The cut under test, and the resume after it that came back cold.
    db()
      .prepare(
        "INSERT OR REPLACE INTO runs (id, folder, prompt, status, budget, created_at, model, session_id) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run("run-ctl", "/x", "t", "completed", 10, cutAt - HOUR, "claude-opus-5", "s-ctl");
    const receipt = db().prepare(
      `INSERT INTO prune_receipts (ts, run_id, trigger, tier, tokens_before, tokens_after, tokens_removed, model)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    receipt.run(cutAt, "run-ctl", "boundary", "standard", 120_000, 70_000, 50_000, "claude-opus-5");
    writeSession("s-ctl", [
      turn("s-ctl", cutAt + 60_000, 16_000, 90_000),
      turn("s-ctl", cutAt + 120_000, 106_000, 0),
    ]);
    // Another run's older cut, which is all it took to widen the dashboard's
    // batch past the probes.
    receipt.run(older, "run-ctl-older", "early-end", "standard", 80_000, 40_000, 40_000, "claude-opus-5");

    const runsList = (await pruneSavingsByRun(["run-ctl"])).get("run-ctl");
    const runPage = await pruneSavings({ runId: "run-ctl" });
    const dashboard = sumPruneSavings(
      (await pricedCuts({ from: older, to: now })).filter(
        (p) => p.row.runId === "run-ctl",
      ),
    );

    assert.equal(
      runsList?.unsettledPrunes,
      0,
      "clean probes from before the cut are evidence about this install, " +
        "whichever other cuts are priced beside it",
    );
    assert.ok(dashboard.netUSD < 0, "the fixture is a prune that lost money");
    assert.equal(runsList?.netUSD, dashboard.netUSD);
    assert.equal(runPage.netUSD, dashboard.netUSD);
  });
});

describe("what a cut is priced at, and over which turns", () => {
  const HOUR = 3_600_000;
  const cutAt = Date.now() - HOUR;
  const projectDir = path.join(TMP, "claude", "projects", "-workspace-money");
  const turn = (sessionId: string, ts: number, cacheRead: number, cacheWrite1h: number) =>
    JSON.stringify({
      type: "assistant",
      uuid: `u-${sessionId}-${ts}`,
      requestId: `req_${sessionId}_${ts}`,
      timestamp: new Date(ts).toISOString(),
      sessionId,
      cwd: "/workspace/money",
      message: {
        id: `msg_${sessionId}_${ts}`,
        model: "claude-opus-5",
        usage: {
          input_tokens: 10,
          output_tokens: 200,
          cache_read_input_tokens: cacheRead,
          cache_creation_input_tokens: cacheWrite1h,
          cache_creation: { ephemeral_1h_input_tokens: cacheWrite1h },
        },
      },
    });
  const writeSession = (sessionId: string, lines: string[]) => {
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), `${lines.join("\n")}\n`);
  };
  const addRun = async (id: string, model: string | null, sessionId: string | null) => {
    const { db } = await import("./db.js");
    db()
      .prepare(
        "INSERT OR REPLACE INTO runs (id, folder, prompt, status, budget, created_at, model, session_id) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(id, "/x", "t", "running", 10, cutAt - HOUR, model, sessionId);
  };
  const addReceipt = async (runId: string, model: string | null) => {
    const { db } = await import("./db.js");
    db()
      .prepare(
        `INSERT INTO prune_receipts (ts, run_id, trigger, tier, tokens_before, tokens_after, tokens_removed, model)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(cutAt, runId, "early-end", "standard", 120_000, 70_000, 50_000, model);
  };
  // A fork taken at `cutAt` into a session of its own, measured to have
  // removed `apiBefore - apiAfter` tokens, or unmeasured when `apiAfter` is null.
  const addFork = async (runId: string, newSessionId: string, apiAfter: number | null) => {
    const { recordForkAttempt } = await import("./contextPruning.js");
    const { db } = await import("./db.js");
    recordForkAttempt(runId, "src", { ...WRITTEN, newSessionId }, 0, "early-end", 180_000, 200_000);
    db()
      .prepare("UPDATE fork_attempts SET ts = ?, api_context_after = ? WHERE run_id = ?")
      .run(cutAt, apiAfter, runId);
  };

  it("prices a cut at the model its later turns ran on when the run names none", async () => {
    // `runs.model` is NULL for every run started on Claude Code's own default,
    // which is the stock install (`defaultModel: null`, a blank form field), and
    // for a run whose model came from its agent. Pricing at that column left
    // every prune and fork on such a run unpriced, and the run page blamed the
    // price table for a model that has a price. The transcript names the model
    // the resume actually billed at.
    const { pruneSavingsByRun } = await import("./contextPruning.js");
    for (const [id, model] of [
      ["money-null", null],
      ["money-named", "claude-opus-5"],
    ] as const) {
      await addRun(id, model, `s-${id}`);
      await addReceipt(id, model);
      writeSession(`s-${id}`, [
        turn(`s-${id}`, cutAt + 60_000, 16_000, 90_000),
        turn(`s-${id}`, cutAt + 120_000, 106_000, 0),
        turn(`s-${id}`, cutAt + 180_000, 108_000, 0),
      ]);
      await addFork(id, `fk-${id}`, 150_000);
      writeSession(`fk-${id}`, [
        turn(`fk-${id}`, cutAt + 60_000, 16_000, 160_000),
        turn(`fk-${id}`, cutAt + 120_000, 170_000, 0),
      ]);
    }
    // And a receipt with no turn after it yet, whose only reading of the model
    // is the run's: a prune made a moment ago must not read as unpriced.
    await addRun("money-pending", "claude-opus-5", "s-money-pending");
    await addReceipt("money-pending", "claude-opus-5");

    const byRun = await pruneSavingsByRun(["money-null", "money-named", "money-pending"]);
    const named = byRun.get("money-named");
    assert.equal(named?.pricedPrunes, 2, "the fixture's twin is priced on both engines");
    assert.ok((named?.netUSD ?? 0) !== 0, "so the equality below is not zero against zero");
    assert.deepEqual(byRun.get("money-null"), named);
    assert.equal(byRun.get("money-pending")?.pricedPrunes, 1);
  });

  it("counts only the turns that billed something as turns the cut saved on", async () => {
    // The CLI writes a `<synthetic>` record at a restart or an API error, with
    // a usage block that is entirely zero. It read nothing, so it avoided no
    // re-read — counting it credited one more turn's saving per frame, always
    // in the flattering direction.
    const { pruneSavingsByRun } = await import("./contextPruning.js");
    const synthetic = (sessionId: string, ts: number) =>
      JSON.stringify({
        type: "assistant",
        uuid: `u-syn-${sessionId}-${ts}`,
        timestamp: new Date(ts).toISOString(),
        sessionId,
        cwd: "/workspace/money",
        message: {
          id: `syn-${sessionId}-${ts}`,
          model: "<synthetic>",
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      });
    const billedAroundAFrame = (sessionId: string) => [
      turn(sessionId, cutAt + 60_000, 16_000, 90_000),
      synthetic(sessionId, cutAt + 90_000),
      turn(sessionId, cutAt + 120_000, 106_000, 0),
    ];
    await addRun("money-synth", "claude-opus-5", "s-money-synth");
    await addReceipt("money-synth", "claude-opus-5");
    writeSession("s-money-synth", billedAroundAFrame("s-money-synth"));
    await addRun("money-synth-fk", "claude-opus-5", "fk-money-synth");
    await addFork("money-synth-fk", "fk-money-synth", 150_000);
    writeSession("fk-money-synth", billedAroundAFrame("fk-money-synth"));

    const byRun = await pruneSavingsByRun(["money-synth", "money-synth-fk"]);
    assert.deepEqual(
      {
        inPlace: byRun.get("money-synth")?.turnsAfter,
        fork: byRun.get("money-synth-fk")?.turnsAfter,
      },
      { inPlace: 2, fork: 2 },
    );
  });
});

describe("pricing a page of runs", () => {
  it("prices both engines in one pass and gives each run its own page's figure", async (t) => {
    // `/api/runs/live` asks this every five seconds for every running run. The
    // fork engine's half used to be `forkSavings` once per run, and each awaited
    // call that found a fork started a scan of its own — scans only coalesce
    // when they overlap — so the cost of a poll grew with the number of runs
    // that had forked, and nothing else about the answer changed.
    const transcripts = await import("./transcripts.js");
    const { pruneSavingsByRun, pruneSavings, recordForkAttempt } = await import(
      "./contextPruning.js"
    );
    const { db } = await import("./db.js");

    const ids = ["pg-legacy", "pg-fork-a", "pg-fork-b", "pg-fork-c", "pg-both", "pg-none"];
    const now = Date.now();
    for (const id of ids) {
      db()
        .prepare(
          "INSERT OR REPLACE INTO runs (id, folder, prompt, status, budget, created_at, model) VALUES (?,?,?,?,?,?,?)",
        )
        .run(id, "/x", "t", "running", 10, now - 1000, "claude-opus-5");
    }
    for (const id of ["pg-legacy", "pg-both"]) {
      db()
        .prepare(
          `INSERT INTO prune_receipts (ts, run_id, trigger, tier, tokens_before, tokens_after, tokens_removed, model)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(now - 500, id, "early-end", "standard", 120_000, 70_000, 50_000, "claude-opus-5");
    }
    for (const id of ["pg-fork-a", "pg-fork-b", "pg-fork-c", "pg-both"]) {
      recordForkAttempt(id, "s", WRITTEN, 0, "early-end", 60_000, 120_000);
      db()
        .prepare("UPDATE fork_attempts SET api_context_after = 70000 WHERE run_id = ?")
        .run(id);
    }

    const scans = t.mock.method(transcripts, "scanUsage");
    const byRun = await pruneSavingsByRun(ids);
    assert.ok(
      scans.mock.callCount() <= 2,
      `one scan per engine however many runs forked, saw ${scans.mock.callCount()}`,
    );

    assert.equal(byRun.has("pg-none"), false, "a run that never pruned is absent, not zero");
    for (const id of ids.filter((x) => x !== "pg-none")) {
      assert.deepEqual(byRun.get(id), await pruneSavings({ runId: id }), id);
    }
    // Both engines on one run are added, as `pruneSavings` adds them.
    assert.equal(byRun.get("pg-both")?.prunes, 2);
    assert.ok(
      (byRun.get("pg-fork-a")?.invalidationUSD ?? 0) > 0,
      "the fixture's early end is charged, so the equality above is not zero against zero",
    );
  });
});
