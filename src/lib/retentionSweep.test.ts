import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type Database from "better-sqlite3";

/**
 * Covers what the retention sweep deletes from the database, and what it must
 * leave exactly as it found it.
 *
 * `run_events` grew monotonically — every assistant block, every tool call with
 * its whole input, every stderr chunk, ~13 MB per thousand tool events — into a
 * named volume with no size limit, and there was not one `DELETE` for growth
 * anywhere in the codebase. When such a volume fills, every SQLite write fails
 * at once: no run is admitted, no status is written, and `promoteQueued`
 * swallows the rejection, so runs simply stop starting with nothing on any page
 * saying why.
 *
 * It earns a test on the same grounds `mergeQueueOrder.test.ts` does: the
 * decision *is* the SQL. A predicate written beside the query would be a second
 * copy of the rule, and the copy is the one that would stay right — while both
 * ways of getting the real one wrong are silent and expensive in opposite
 * directions. Delete too little and the store is still unbounded; delete too
 * much and a run's own spend record, or the log of a run whose page somebody is
 * reading right now, goes with it.
 *
 * Its own file for that file's reason: `config.ts` reads `DATA_DIR` at module
 * load, so the throwaway directory has to be named before anything that reaches
 * the database is imported — otherwise the path is bound to the repository's
 * own `.data`, which on a developer's machine is the real one.
 */

let retention: typeof import("./retention");
let dbMod: typeof import("./db");
let settings: typeof import("./settings");
let pruning: typeof import("./contextPruning");
let orchestrator: typeof import("./orchestrator");
let root: string;

const MOUNT_DIR = "sweep-mount";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_786_470_000_000;

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-retention-")));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  // The checkout sweep re-proves every stored repository path inside a mount
  // before it runs git there, so the chain case below needs a real one.
  process.env.WORKSPACE_ROOT = path.join(root, MOUNT_DIR);
  process.env.WORKSPACE_ROOTS = "";
  fs.mkdirSync(path.join(root, MOUNT_DIR), { recursive: true });
  // Nothing here reaches a spawn, and a `claude` that does not exist makes a
  // regression that somehow got that far a failed test rather than a billed one.
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );

  retention = await import("./retention");
  dbMod = await import("./db");
  settings = await import("./settings");
  pruning = await import("./contextPruning");
  orchestrator = await import("./orchestrator");
});

after(() => {
  const open = (globalThis as { __ufDb?: Database.Database }).__ufDb;
  open?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A run with spend on it, and `n` events spread either side of the horizon. */
function seed(o: {
  id: string;
  status: string;
  oldEvents: number;
  freshEvents: number;
}): void {
  dbMod
    .db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, created_at,
                         spent_usd, spent_tokens, iterations, stop_reason)
       VALUES (?, '/workspace/repo', 'task', ?, '{}', ?, 12.5, 4000, 3, 'done')`,
    )
    .run(o.id, o.status, NOW - 90 * DAY);

  const event = dbMod
    .db()
    .prepare(
      "INSERT INTO run_events (run_id, ts, kind, payload) VALUES (?, ?, 'tool', '{}')",
    );
  const telemetry = dbMod
    .db()
    .prepare(
      `INSERT INTO otlp_requests (request_id, ts, run_id, cost_usd)
       VALUES (?, ?, ?, 0.25)`,
    );

  for (let i = 0; i < o.oldEvents; i++) {
    event.run(o.id, NOW - 60 * DAY);
    telemetry.run(`${o.id}-old-${i}`, NOW - 60 * DAY, o.id);
  }
  for (let i = 0; i < o.freshEvents; i++) {
    event.run(o.id, NOW - 1 * DAY);
    telemetry.run(`${o.id}-new-${i}`, NOW - 1 * DAY, o.id);
  }
}

const eventCount = (runId: string) =>
  (
    dbMod
      .db()
      .prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?")
      .get(runId) as { n: number }
  ).n;

const telemetryCount = (runId: string) =>
  (
    dbMod
      .db()
      .prepare("SELECT COUNT(*) AS n FROM otlp_requests WHERE run_id = ?")
      .get(runId) as { n: number }
  ).n;

describe("run_events retention", () => {
  before(() => {
    settings.saveSettings({ eventRetentionDays: 30 });
    seed({ id: "done-run", status: "completed", oldEvents: 5, freshEvents: 2 });
    seed({ id: "failed-run", status: "failed", oldEvents: 3, freshEvents: 0 });
    // The run whose page somebody could be reading right now. Its events are as
    // old as the settled runs' — age is not what protects them.
    seed({ id: "live-run", status: "running", oldEvents: 4, freshEvents: 1 });
    seed({ id: "parked-run", status: "paused", oldEvents: 6, freshEvents: 0 });
  });

  it("discards a settled run's events past the horizon and keeps the rest", () => {
    const swept = retention.sweepRunEvents(NOW);

    assert.equal(eventCount("done-run"), 2, "the fresh events should survive");
    assert.equal(eventCount("failed-run"), 0);
    assert.equal(swept.events, 8, "five from one settled run and three from the other");
  });

  it("leaves a run still in flight untouched", () => {
    // The acceptance criterion this whole sweep is bounded by: a `running` row
    // and a `paused` one keep every line, however far past the horizon they
    // are. The alternative is a log losing rows under the reader, and a parked
    // run coming back hours later to a history with a hole in it.
    assert.equal(eventCount("live-run"), 5);
    assert.equal(eventCount("parked-run"), 6);
    assert.equal(telemetryCount("live-run"), 5);
    assert.equal(telemetryCount("parked-run"), 6);
  });

  it("never touches the run row or what it spent", () => {
    const rows = dbMod
      .db()
      .prepare(
        "SELECT id, spent_usd, spent_tokens, iterations, stop_reason, status FROM runs ORDER BY id",
      )
      .all() as Array<Record<string, unknown>>;

    assert.equal(rows.length, 4, "no run may be deleted by a retention sweep");
    for (const row of rows) {
      assert.equal(row.spent_usd, 12.5, `${row.id} lost its spend`);
      assert.equal(row.spent_tokens, 4000);
      assert.equal(row.iterations, 3);
      assert.equal(row.stop_reason, "done");
    }
  });

  it("discards the telemetry rows beside them, on the same horizon", () => {
    assert.equal(telemetryCount("done-run"), 2);
    assert.equal(telemetryCount("failed-run"), 0);
  });

  it("keeps everything when the horizon is blank", () => {
    settings.saveSettings({ eventRetentionDays: null });
    seed({ id: "no-horizon", status: "completed", oldEvents: 4, freshEvents: 0 });

    const swept = retention.sweepRunEvents(NOW);
    // Deep-equal rather than three field checks, and that is the point of the
    // case: a store added to this sweep later must be named here or it is one
    // this blank horizon does not cover, which is a silent deletion on an
    // install that asked to keep everything.
    assert.deepEqual(swept, {
      events: 0,
      telemetry: 0,
      samples: 0,
      compositions: 0,
    });
    assert.equal(eventCount("no-horizon"), 4);
  });

  it("records what it did, so the page can say when it last ran", async () => {
    settings.saveSettings({ eventRetentionDays: 30 });
    const result = await retention.runRetentionSweep(NOW);

    assert.equal(result.at, NOW);
    assert.equal(result.events, 4, "the run seeded under a blank horizon");
    assert.deepEqual(retention.lastSweep(), result);

    // The one store this sweep reaches that a test cannot point somewhere
    // harmless: `LEDGER_PATH` is a literal in `intakeFilter.ts`, copied from
    // `docker-entrypoint.sh`, and everything else here runs against a temporary
    // `DATA_DIR` and `CLAUDE_HOME`. A uid that may not open that file, and a
    // machine where it is not there, both answer `undefined` — so this
    // assertion is what turns "the suite quietly compacted a live ledger" from
    // something nobody would notice into a red test.
    assert.equal(
      result.ledgerBytes,
      undefined,
      "this test just cut bytes off a real winnow ledger",
    );
  });
});

/**
 * The one store on the read side of this sweep that is not run-scoped.
 *
 * `prune_decisions` is read by `/api/usage` over a span and sliced into the
 * dashboard's session and weekly windows, so it answers a weekly KPI exactly as
 * `prune_receipts` does. It rode the `run_events` horizon anyway, which made the
 * weekly boundary count a figure whose evidence a shorter horizon could delete
 * out from under it — and there is nothing on the card that would say so. The
 * failure is a *smaller number*, beside a savings figure over the full week,
 * reading as pruning having stopped happening.
 */
describe("prune_decisions is not on the run-log horizon", () => {
  before(() => {
    // Accepted by the settings route, which clamps at `Math.max(1, …)`.
    settings.saveSettings({ eventRetentionDays: 1 });
    dbMod
      .db()
      .prepare(
        `INSERT INTO runs (id, folder, prompt, status, budget, created_at)
         VALUES ('pruned-run', '/workspace/repo', 'task', 'completed', '{}', ?)`,
      )
      .run(NOW - 90 * DAY);
    const decision = dbMod
      .db()
      .prepare(
        `INSERT INTO prune_decisions (ts, run_id, trigger, engine, outcome)
         VALUES (?, 'pruned-run', 'boundary', 'legacy', 'cut')`,
      );
    // One a day across the window the card prints, so all but the newest are
    // past a one-day horizon.
    for (let day = 0; day < 7; day++) decision.run(NOW - day * DAY);
  });

  it("keeps a week of boundaries under a one-day horizon", () => {
    retention.sweepRunEvents(NOW);

    const weekly = pruning.pruneActivity({ from: NOW - 7 * DAY, to: NOW });
    assert.equal(
      weekly?.boundaries,
      7,
      "the weekly count now covers fewer days than the savings figure beside it",
    );
    assert.equal(weekly?.cut, 7);
  });

  it("does not report a count for a store it no longer sweeps", () => {
    // Deep-equal for the reason the blank-horizon case above uses one: a store
    // added back to this sweep has to be named here, and a `decisions` key
    // reappearing is this table being put back on the run-log horizon.
    assert.deepEqual(Object.keys(retention.sweepRunEvents(NOW)).sort(), [
      "compositions",
      "events",
      "samples",
      "telemetry",
    ]);
  });
});

describe("retentionCutoff", () => {
  it("reads a blank horizon as keep-for-ever rather than as now", () => {
    // The reading that matters: a zero falling through as a cutoff of `now`
    // would delete every settled run's log the first time somebody typed one.
    assert.equal(retention.retentionCutoff(null, NOW), null);
    assert.equal(retention.retentionCutoff(0, NOW), null);
    assert.equal(retention.retentionCutoff(-5, NOW), null);
    assert.equal(retention.retentionCutoff(30, NOW), NOW - 30 * DAY);
  });
});

/**
 * The one sweep in this app that deletes, against a directory it may not own.
 *
 * `startRetentionSweeper` was gated on ownership once, at boot, inside
 * `instrumentation.ts`'s `if (ownsDataDir())`. The answer moves after that:
 * `heartbeat` returns `lost` when the directory changes hands and a `writeLock`
 * that throws stands the process down as well, and in both cases the interval
 * kept its handle. Six hours later a stood-down process ran the whole sweep —
 * `DELETE FROM run_events`, `git worktree remove` on checkouts in the mounts,
 * `unlink` on transcripts in `~/.claude/projects`, `UPDATE runs SET session_id =
 * NULL` — against a database and mounts another process now owns, beside that
 * owner's own sweeper. The single-flight latch is a module variable and cannot
 * see the other process at all.
 *
 * There is nothing to observe when it goes wrong: the rows are gone, and the
 * owner's next sweep would have taken most of them anyway.
 *
 * Refused for real rather than through a stubbed `mayWriteDataDir`, on
 * `shutdown.test.ts`'s grounds — a lock file naming a live pid that is not ours,
 * then `claimDataDir()`. What has to be distinguished is `held` from the
 * `unclaimed` every other case in this file runs under, and a stub proves only
 * that a branch exists.
 */
describe("the retention sweeper's ownership", () => {
  let lockFile: string;

  before(async () => {
    lockFile = path.join(process.env.DATA_DIR as string, "server.lock");
    settings.saveSettings({ eventRetentionDays: 30 });
    seed({ id: "not-ours", status: "completed", oldEvents: 6, freshEvents: 0 });

    // `process.ppid` because it is alive and can never be our own pid — which
    // `lockVerdict` reads as this server's predecessor across a restart and
    // claims outright.
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: process.ppid,
        ownerId: "the-process-that-owns-this-directory",
        startedAt: Date.now(),
        heartbeatAt: Date.now(),
      }),
    );
    assert.equal(
      await (await import("./serverLock")).claimDataDir(),
      false,
      "the fixture must leave this process refused, or the case proves nothing",
    );
  });

  after(() => retention.stopRetentionSweeper());

  it("deletes nothing once the directory has changed hands", async () => {
    const sweepBefore = retention.lastSweep();

    retention.startRetentionSweeper();
    // `sweepRunEvents` is the first statement of `runRetentionSweep` and runs
    // synchronously off the tick, so an ungated sweeper has already deleted by
    // here. The wait is for `LAST_SWEEP_KEY`, which is two awaits further on.
    assert.equal(eventCount("not-ours"), 6);
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(eventCount("not-ours"), 6, "a stood-down process deleted rows");
    assert.deepEqual(retention.lastSweep(), sweepBefore, "it recorded a sweep");
  });

  it("stops its own timer rather than refusing every six hours", async () => {
    // `sweepPaused`'s rule: nothing here will ever be this process's to decide
    // again, so a boot hook arming it a second time under a standing refusal
    // must not leave a timer behind either.
    retention.startRetentionSweeper();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(eventCount("not-ours"), 6);
  });

  it("leaves the owner's sweep exactly as it was", async () => {
    fs.rmSync(lockFile, { force: true });
    assert.equal(
      await (await import("./serverLock")).claimDataDir(),
      true,
      "this process has to own the directory for the control to mean anything",
    );

    retention.startRetentionSweeper();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(eventCount("not-ours"), 0, "the owner's own sweep did not run");
  });
});

/**
 * Which tip a squash recorded, and on which run, when the checkout is a later
 * link's.
 *
 * `landRun` writes `landed_tip` on the run that landed, which on a
 * `continueBranch` chain is the owner at the time. A link that continues it
 * afterwards takes the same slot (`planWorkspace`'s `inheritedSlot`) and the same
 * branch, so it is the newest run recorded there — the row `newestRunPerSlot`
 * hands `branchIsSettled` — with a `landed_tip` of its own that is null. Read for
 * that one run, a squashed branch was never landed, git's ancestry test cannot
 * call a squash merged either, and the checkout was kept for ever. The miss is
 * conservative, which is why nothing throws: it is only a slot that is never
 * given back.
 *
 * Driven against real git because both readings of the branch are git's
 * answers — a fixture stating them would state the thing in question. The case
 * that must stay a keep is the same chain with a commit added after the
 * squash: the tip no longer matches what landed, and removing that checkout is
 * the one outcome the sweep exists never to produce.
 */
describe("checkout reclaim across a continueBranch chain", () => {
  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    }).trim();

  /**
   * A repository whose branch carries one commit, squash-landed on `main`, with
   * the checkout it was made in. Two runs are recorded in that slot: the owner,
   * which landed, and a link that continues it and added nothing.
   */
  function chain(name: string): { repo: string; slot: string; branch: string } {
    const repo = path.join(root, MOUNT_DIR, name);
    fs.mkdirSync(repo);
    gitIn(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "shared.txt"), "base\n");
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "-q", "-m", "base");
    const base = gitIn(repo, "rev-parse", "main");

    const branch = `uf/${name}`;
    const slot = path.join(
      orchestrator.worktreeStore(repo)!,
      `${orchestrator.repoSlug(repo)}-1`,
    );
    gitIn(repo, "worktree", "add", "-q", "-b", branch, slot);
    fs.writeFileSync(path.join(slot, "shared.txt"), "branch\n");
    gitIn(slot, "commit", "-qam", "the run's work");
    const tip = gitIn(repo, "rev-parse", branch);

    gitIn(repo, "merge", "-q", "--squash", branch);
    gitIn(repo, "commit", "-qm", "squash-landed");
    const squash = gitIn(repo, "rev-parse", "main");

    const insert = dbMod.db().prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                         created_at, finished_at, isolation, repo_root, worktree_path,
                         worktree_branch, worktree_base, worktree_base_branch,
                         continues_run, landed_at, landed_strategy, landed_tip, landed_commit)
       VALUES (?, ?, 'task', 'completed', '{}', 1, ?, ?, ?, 'worktree', ?, ?, ?, ?, 'main',
               ?, ?, ?, ?, ?)`,
    );
    const finished = NOW - 30 * DAY;
    insert.run(
      `${name}-owner`, repo, 1, finished - DAY, finished, repo, slot, branch, base,
      null, finished, "squash", tip, squash,
    );
    insert.run(
      `${name}-link`, repo, 0, finished, finished, repo, slot, branch, base,
      `${name}-owner`, null, null, null, null,
    );
    return { repo, slot, branch };
  }

  before(() => {
    settings.saveSettings({ checkoutRetentionDays: 7 });
  });

  beforeEach(() => {
    dbMod.db().prepare("DELETE FROM runs").run();
  });

  it("reclaims the slot of the run that landed it, which is what the chain case is measured against", async () => {
    const c = chain("owner-only");
    dbMod.db().prepare("DELETE FROM runs WHERE id = 'owner-only-link'").run();

    const swept = await retention.sweepCheckouts(NOW);

    assert.equal(swept.removed, 1, "the control did not reach a removal, so the chain case below proves nothing");
    assert.equal(fs.existsSync(c.slot), false);
  });

  it("reclaims the slot of a link that continues a squash-landed branch", async () => {
    const c = chain("squashed-chain");
    assert.equal(fs.existsSync(c.slot), true);

    const swept = await retention.sweepCheckouts(NOW);

    assert.equal(swept.removed, 1);
    assert.equal(fs.existsSync(c.slot), false, "the slot was kept");
    assert.equal(
      gitIn(c.repo, "rev-parse", "--verify", `refs/heads/${c.branch}`).length > 0,
      true,
      "reclaiming a checkout must never take the branch with it",
    );
  });

  it("keeps it once the branch has a commit that was not landed", async () => {
    const c = chain("moved-chain");
    fs.writeFileSync(path.join(c.slot, "shared.txt"), "after the squash\n");
    gitIn(c.slot, "commit", "-qam", "added after the land");

    const swept = await retention.sweepCheckouts(NOW);

    assert.equal(swept.removed, 0);
    assert.equal(fs.existsSync(c.slot), true, "a checkout with unlanded commits went");
  });
});

/**
 * A pick-up that lands while the transcript sweep is unlinking.
 *
 * `reopenRun` resumes whatever `runs.session_id` holds, and the sweep used to
 * clear that column only after its whole unlink loop, and only on rows that were
 * still terminal by then. A run picked up inside the loop had its transcript
 * deleted and its id kept: the first cycle `--resume`d a file that was gone,
 * ended `failed` telling the operator to run `claude --resume` against it, and
 * no later sweep ever cleared the id, because a sweep clears only the ids of
 * files it lists and that file no longer exists. Every pick-up after that failed
 * the same way. Nothing throws on the way — the row looks like any other
 * finished run — so the only place the order is checked is here.
 *
 * Driven through the real `reopenRun`, called from inside a patched
 * `fs/promises.unlink` at the moment the sweep reaches that run's file, because
 * the window is the sweep's own `await` and a fixture that set the row's status
 * by hand would state the outcome rather than reach it.
 */
describe("sweepTranscripts against a run picked up mid-sweep", () => {
  const sessionOf = (id: string) => `bbbbbbbb-0000-4000-8000-${id.padStart(12, "0")}`;
  let projects: string;
  const realUnlink = fsp.unlink;

  /** A run that finished 40 days ago, and the transcript its session left. */
  function seedFinished(runId: string, sessionNo: string): string {
    const now = Date.now();
    const folder = path.join(root, MOUNT_DIR, "proj");
    fs.mkdirSync(folder, { recursive: true });
    dbMod
      .db()
      .prepare(
        `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                           created_at, started_at, finished_at, stop_reason, session_id)
         VALUES (?, ?, 'task', 'completed', '{"maxIterations":2}', 2, 2, ?, ?, ?, 'done', ?)`,
      )
      .run(runId, folder, now - 41 * DAY, now - 41 * DAY, now - 40 * DAY, sessionOf(sessionNo));
    const dir = path.join(projects, `-${MOUNT_DIR}-proj`);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sessionOf(sessionNo)}.jsonl`);
    fs.writeFileSync(file, '{"type":"user"}\n');
    const t = (now - 40 * DAY) / 1000;
    fs.utimesSync(file, t, t);
    return file;
  }

  const row = (id: string) =>
    dbMod.db().prepare("SELECT status, session_id FROM runs WHERE id = ?").get(id) as {
      status: string;
      session_id: string | null;
    };

  /** Runs this file picks up have a `CLAUDE_BIN` that cannot spawn: they end `failed`. */
  async function untilTerminal(id: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (orchestrator.TERMINAL_STATUSES.includes(row(id).status as never)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(`${id} never settled; it is ${row(id).status}`);
  }

  /** Runs `body` with `fsp.unlink` replaced, and puts the real one back whatever happens. */
  async function withUnlink<T>(
    unlink: (p: fs.PathLike) => Promise<void>,
    body: () => Promise<T>,
  ): Promise<T> {
    (fsp as { unlink: typeof fsp.unlink }).unlink = unlink as typeof fsp.unlink;
    try {
      return await body();
    } finally {
      (fsp as { unlink: typeof fsp.unlink }).unlink = realUnlink;
    }
  }

  before(() => {
    projects = path.join(process.env.CLAUDE_HOME as string, "projects");
    settings.saveSettings({ transcriptRetentionDays: 30 });
  });

  beforeEach(() => {
    dbMod.db().prepare("DELETE FROM runs").run();
    fs.rmSync(projects, { recursive: true, force: true });
  });

  it("leaves no run holding a session whose transcript the sweep deleted", async () => {
    const pickedFile = seedFinished("run-picked", "1");
    seedFinished("run-control", "2");

    let reopened: unknown = null;
    await withUnlink(
      async (p) => {
        if (p === pickedFile && reopened === null) {
          reopened = orchestrator.reopenRun("run-picked", { maxIterations: 3 });
        }
        return realUnlink(p);
      },
      () => retention.sweepTranscripts(Date.now()),
    );
    assert.deepEqual(reopened, { ok: true }, "the pick-up has to have happened mid-sweep");

    await untilTerminal("run-picked");
    await retention.sweepTranscripts(Date.now());

    assert.equal(row("run-control").session_id, null, "control: a swept terminal run's session is cleared");
    assert.equal(fs.existsSync(pickedFile), false);
    assert.equal(
      row("run-picked").session_id,
      null,
      "the picked-up run will --resume a transcript the sweep just deleted",
    );
  });

  it("keeps the session of a file it could not delete, and clears one that was already gone", async () => {
    const stuck = seedFinished("run-stuck", "3");
    const vanished = seedFinished("run-vanished", "4");

    const swept = await withUnlink(
      async (p) => {
        if (p === stuck) throw Object.assign(new Error("read-only file system"), { code: "EROFS" });
        // Removed between the walk and the unlink, as the CLI's own cleanup does.
        if (p === vanished) fs.rmSync(p);
        return realUnlink(p);
      },
      () => retention.sweepTranscripts(Date.now()),
    );

    assert.equal(swept.removed, 0, "nothing here was this sweep's to remove");
    assert.equal(fs.existsSync(stuck), true);
    assert.equal(
      row("run-stuck").session_id,
      sessionOf("3"),
      "a transcript that is still on disk is still what the run resumes into",
    );
    assert.equal(row("run-vanished").session_id, null);
  });
});

/**
 * The one store here nothing in this app writes.
 *
 * Its failure mode is the silent kind: an unreadable directory reported as a
 * count of zero tells an operator "no backups have been taken" when the truth
 * is "this process could not look" — a missing bind mount, or a directory
 * Docker created as root under a server running as somebody else. The two need
 * opposite actions and they render identically if the reading collapses them.
 */
describe("backupStore", () => {
  it("separates an unreadable directory from an empty one", async () => {
    const empty = path.join(root, "backups-empty");
    fs.mkdirSync(empty, { recursive: true });

    const there = await retention.backupStore(empty);
    assert.equal(there.readable, true);
    assert.equal(there.count, 0);
    assert.equal(there.newestAt, null);

    const missing = await retention.backupStore(path.join(root, "no-such-dir"));
    assert.equal(missing.readable, false);
    assert.equal(missing.count, 0);
  });

  it("counts snapshots whatever they are named, and takes the newest mtime", async () => {
    const dir = path.join(root, "backups-full");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "usagefoundry-20260101T030000Z.db"), "aa");
    // `--dest` takes any path ending in `.db`, so matching only the generated
    // name would report zero for an operator who names their own snapshots.
    fs.writeFileSync(path.join(dir, "before-the-upgrade.db"), "bbbb");
    // And nothing else in the directory is a snapshot — the cron in
    // `docs/backup-and-restore.md` writes its log beside them.
    fs.writeFileSync(path.join(dir, "backup.log"), "x".repeat(64));
    fs.utimesSync(path.join(dir, "usagefoundry-20260101T030000Z.db"), 1000, 1000);
    fs.utimesSync(path.join(dir, "before-the-upgrade.db"), 2000, 2000);

    const store = await retention.backupStore(dir);
    assert.equal(store.readable, true);
    assert.equal(store.count, 2);
    assert.equal(store.bytes, 6);
    assert.equal(store.newestAt, 2_000_000);
    assert.equal(store.partial, false);
  });
});
