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
