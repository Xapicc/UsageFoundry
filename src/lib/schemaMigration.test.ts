import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type Database from "better-sqlite3";

/**
 * Covers what a migration leaves behind: an *interrupted* one, and a column
 * added to a `CREATE TABLE IF NOT EXISTS` after the table had already shipped.
 *
 * The rebuild that drops the NOT NULL from `chat_proposals.template_id` ran as
 * four autocommitted statements. A crash, an OOM kill or a `docker compose
 * down` after the first one left every row in `chat_proposals_old`, which no
 * query in this app reads — and the next boot recreated `chat_proposals` empty
 * from the same `CREATE TABLE IF NOT EXISTS`, so the guard that makes the
 * migration idempotent (`template_id` is already nullable, return) was also
 * what made the loss permanent. The app started cleanly, reported nothing, and
 * the record of every proposal the operator ever approved was on disk and
 * unreachable.
 *
 * The second case is the quieter one and has the same shape as the first: a
 * guard that makes a migration idempotent is also what stops it running. `IF
 * NOT EXISTS` skips the whole statement, so a column added to it later never
 * reaches an install that already has the table, and the only symptom is a
 * write failing somewhere that catches its own errors.
 *
 * It earns its own file for `bootBlocks.test.ts`'s two reasons. `DATA_DIR` and
 * `CLAUDE_HOME` are set before the first import because `config.ts` reads them
 * at module load and `db.ts` pulls it in statically, so a file that imported
 * either at the top would be bound to the repository's own `.data` — which on a
 * developer's machine is the real one. And it closes and reopens the database
 * to force a second boot, which would take any other file's fixtures with it.
 *
 * What is *not* here is a real SIGKILL. An interruption's whole observable
 * content is whether the intermediate statements committed, and a throw inside
 * `db.transaction` produces the same on-disk outcome as a process death does —
 * both end at a ROLLBACK. Injecting the throw is what makes "interrupted after
 * statement k" a case rather than a race.
 */

let root: string;
let dbMod: typeof import("./db");
let lockMod: typeof import("./serverLock");

/** The new-shape CREATE, read back from the database `migrate` just built. */
let proposalsCreateSql: string;

const OLD_SHAPE = `
  CREATE TABLE chat_proposals (
    id          TEXT PRIMARY KEY,
    chat_id     TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    template_id TEXT NOT NULL,
    title       TEXT NOT NULL,
    task        TEXT NOT NULL,
    mount_id    TEXT,
    folder      TEXT,
    status      TEXT NOT NULL DEFAULT 'pending',
    run_id      TEXT,
    decided_at  INTEGER,
    error       TEXT
  );`;

const INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_chat_proposals_chat
  ON chat_proposals(chat_id, created_at)`;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-schema-"));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, "workspace");
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );

  dbMod = await import("./db");
  lockMod = await import("./serverLock");

  const created = dbMod
    .db()
    .prepare("SELECT sql FROM sqlite_master WHERE name = 'chat_proposals'")
    .get() as { sql: string };
  proposalsCreateSql = created.sql;
});

after(() => {
  (globalThis as { __ufDb?: Database.Database }).__ufDb?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A chat to hang proposals off, and five proposals in whatever shape is there. */
function seed(db: Database.Database, count = 5, orphanLast = false) {
  db.prepare(
    `INSERT OR IGNORE INTO chat_sessions (id, created_at, updated_at, status)
     VALUES ('c1', 1, 1, 'idle')`,
  ).run();
  // The orphan is written with enforcement off, which is the only way to put
  // one there — and it is a state a real file can be in, since the constraint
  // is only checked as rows are written.
  if (orphanLast) db.pragma("foreign_keys = OFF");
  try {
    for (let i = 1; i <= count; i += 1) {
      db.prepare(
        `INSERT INTO chat_proposals
           (id, chat_id, created_at, template_id, title, task, status)
         VALUES (?, ?, ?, 't1', ?, 'do the thing', 'approved')`,
      ).run(
        `p${i}`,
        orphanLast && i === count ? "gone" : "c1",
        i,
        `Fix ${i}`,
      );
    }
  } finally {
    if (orphanLast) db.pragma("foreign_keys = ON");
  }
}

function rows(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT count(*) c FROM ${table}`).get() as { c: number }).c;
}

function exists(db: Database.Database, table: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(table) !== undefined
  );
}

function templateIdIsNotNull(db: Database.Database): boolean {
  const col = (
    db.prepare("PRAGMA table_info(chat_proposals)").all() as {
      name: string;
      notnull: number;
    }[]
  ).find((c) => c.name === "template_id");
  return col?.notnull === 1;
}

/** Put the table back to the shape `migrate` produces, whatever a case left. */
function resetProposals() {
  const db = dbMod.db();
  db.exec("DROP TABLE IF EXISTS chat_proposals_old");
  db.exec("DROP TABLE IF EXISTS chat_proposals");
  db.exec(proposalsCreateSql);
  db.exec(INDEX_SQL);
  db.exec("DELETE FROM chat_sessions");
}

/** Give the table the pre-rebuild shape, populated. */
function oldShape(orphanLast = false) {
  const db = dbMod.db();
  resetProposals();
  db.exec("DROP TABLE chat_proposals");
  db.exec(OLD_SHAPE);
  db.exec(INDEX_SQL);
  seed(db, 5, orphanLast);
  assert.equal(templateIdIsNotNull(db), true);
  return db;
}

/**
 * Reopen the database, which is what a restart does: `open()` runs `migrate`
 * again from scratch against whatever is on disk.
 */
function reboot(): Database.Database {
  const g = globalThis as { __ufDb?: Database.Database };
  g.__ufDb?.close();
  delete g.__ufDb;
  return dbMod.db();
}

beforeEach(() => {
  resetProposals();
});

describe("an interrupted chat_proposals rebuild", () => {
  it("is recovered on the next boot rather than starting empty", () => {
    // Exactly what the old code left after a crash between the RENAME and the
    // INSERT: the rows under the old name, and — because `migrate`'s own
    // CREATE TABLE IF NOT EXISTS runs before the rebuild — an empty new-shape
    // table beside them.
    let db = oldShape();
    db.exec("ALTER TABLE chat_proposals RENAME TO chat_proposals_old");
    db.exec(proposalsCreateSql);
    assert.equal(rows(db, "chat_proposals"), 0);
    assert.equal(rows(db, "chat_proposals_old"), 5);

    db = reboot();

    assert.equal(rows(db, "chat_proposals"), 5);
    assert.equal(exists(db, "chat_proposals_old"), false);
    assert.equal(templateIdIsNotNull(db), false);
    // The rebuild recreates the table from the base columns alone, so every
    // column added since has to arrive from the `addColumn` calls that run
    // after it in the same `migrate`. `guards_json` is the one `createProposal`
    // names in its INSERT, so a boot that rebuilt and did not re-add it is an
    // install where the chat cannot record a proposal at all.
    assert.equal(hasColumn(db, "chat_proposals", "guards_json"), true);
    // The rename took the index with it and the DROP took it away again, so a
    // recovery that does not put it back leaves the thread query unindexed
    // until some later boot happens to rebuild something.
    assert.notEqual(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_chat_proposals_chat'",
        )
        .get(),
      undefined,
    );
  });

  it("recovers rows the interrupted INSERT had already copied, without duplicating them", () => {
    // The other interruption point: after the INSERT and before the DROP, both
    // tables hold the same five rows. Re-running has to be a no-op, not a
    // primary-key failure that stops every boot from here on.
    const db = dbMod.db();
    seed(db);
    db.exec(
      "CREATE TABLE chat_proposals_old AS SELECT * FROM chat_proposals",
    );
    assert.equal(rows(db, "chat_proposals"), 5);

    const after = reboot();
    assert.equal(rows(after, "chat_proposals"), 5);
    assert.equal(exists(after, "chat_proposals_old"), false);
  });

  it("leaves a leftover it cannot read alone rather than dropping it", () => {
    const db = dbMod.db();
    db.exec("CREATE TABLE chat_proposals_old (id TEXT PRIMARY KEY, junk TEXT)");
    db.prepare("INSERT INTO chat_proposals_old VALUES ('x', 'y')").run();

    const after = reboot();
    // Present, untouched, and reported — a table this build cannot read is not
    // one it may drop, and refusing to boot would strand the whole install.
    assert.equal(exists(after, "chat_proposals_old"), true);
    assert.equal(rows(after, "chat_proposals_old"), 1);
    after.exec("DROP TABLE chat_proposals_old");
  });
});

describe("relaxProposalTemplate", () => {
  it("leaves the database exactly as it was when a step fails", () => {
    // Fault injection with a real fault: the pre-rebuild table has no foreign
    // key, the rebuilt one does, so a proposal whose chat is gone makes the
    // INSERT..SELECT fail half way through — statement three of five. Before
    // this was one transaction the first two had already committed, which is
    // the strand this whole file is about.
    const db = oldShape(true);

    assert.throws(() => dbMod.relaxProposalTemplate(db), /FOREIGN KEY/);

    assert.equal(rows(db, "chat_proposals"), 5);
    assert.equal(exists(db, "chat_proposals_old"), false);
    assert.equal(templateIdIsNotNull(db), true);
  });

  it("preserves every row when interrupted after each statement in turn", () => {
    // A Proxy that throws on the k-th `exec`. What an interruption is, on disk,
    // is whether the statements before it committed — a throw out of
    // `db.transaction` and a process death both answer that with a ROLLBACK.
    for (let stopAfter = 1; stopAfter <= 5; stopAfter += 1) {
      const db = oldShape();

      let seen = 0;
      const interrupted = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === "exec") {
            return (sql: string) => {
              seen += 1;
              if (seen > stopAfter) throw new Error("interrupted");
              return target.exec(sql);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          // Bound to the real connection: better-sqlite3's methods reach
          // internal state through `this`, and a Proxy is not it.
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Database.Database;

      // Five statements, so the last k completes rather than throwing.
      if (stopAfter >= 5) {
        dbMod.relaxProposalTemplate(interrupted);
        assert.equal(templateIdIsNotNull(db), false, "k=5 should complete");
      } else {
        assert.throws(
          () => dbMod.relaxProposalTemplate(interrupted),
          /interrupted/,
          `k=${stopAfter}`,
        );
        assert.equal(templateIdIsNotNull(db), true, `k=${stopAfter} shape`);
      }

      assert.equal(rows(db, "chat_proposals"), 5, `k=${stopAfter} rows`);
      assert.equal(
        exists(db, "chat_proposals_old"),
        false,
        `k=${stopAfter} orphan`,
      );
    }
  });
});

describe("schema version", () => {
  it("is stamped on the file once migrate has returned", () => {
    const found = Number(
      dbMod.db().pragma("user_version", { simple: true }),
    );
    assert.equal(found, dbMod.SCHEMA_VERSION);
  });

  it("names what an older build is looking at", () => {
    // The case that cannot be produced by running this build: a rollback to an
    // older image after a failed deploy, which had no defined behaviour and
    // nothing to detect it with.
    assert.equal(dbMod.schemaVerdict(0, 1), "unversioned");
    assert.equal(dbMod.schemaVerdict(1, 1), "current");
    assert.equal(dbMod.schemaVerdict(1, 2), "upgrade");
    assert.equal(dbMod.schemaVerdict(2, 1), "downgrade");
  });
});

describe("migrate and the data-directory claim", () => {
  it("leaves the schema alone while another live process holds the directory", () => {
    // pid 1 is alive in every container and is never this process. A signal to
    // it from an unprivileged uid answers EPERM, which `ownerAlive` reads as
    // alive on purpose — a pid we may not signal is still a pid.
    const lockFile = path.join(process.env.DATA_DIR as string, "server.lock");
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: 1,
        ownerId: "someone-else",
        startedAt: Date.now(),
        heartbeatAt: Date.now(),
      }),
    );
    assert.equal(lockMod.heldByAnotherProcess(), true);

    try {
      dbMod.db().exec("DROP TABLE agents");
      const held = reboot();
      // `open()` ran, the connection works, and nothing was rebuilt: a second
      // server pointed at this directory by an inherited DATA_DIR does not get
      // to write the schema of a database somebody else owns.
      assert.equal(exists(held, "agents"), false);
    } finally {
      fs.rmSync(lockFile, { force: true });
    }

    assert.equal(lockMod.heldByAnotherProcess(), false);
    const owned = reboot();
    assert.equal(exists(owned, "agents"), true);
  });

  it("still builds a schema when there is none, however the lock reads", () => {
    // The exception that keeps the gate from being a new failure: a process
    // that owns nothing and finds a file with nothing in it has nothing to
    // destroy, and refusing there would leave it with no tables and every query
    // throwing until a restart.
    const lockFile = path.join(process.env.DATA_DIR as string, "server.lock");
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: 1,
        ownerId: "someone-else",
        startedAt: Date.now(),
        heartbeatAt: Date.now(),
      }),
    );

    try {
      const db = dbMod.db();
      db.exec("DROP TABLE agents");
      // `settings` is the sentinel for "this file has a schema at all".
      db.exec("DROP TABLE settings");

      const rebuilt = reboot();
      assert.equal(exists(rebuilt, "settings"), true);
      assert.equal(exists(rebuilt, "agents"), true);
    } finally {
      fs.rmSync(lockFile, { force: true });
      reboot();
    }
  });
});

const FORK_ATTEMPTS_PRE_SUFFIX = `
  CREATE TABLE fork_attempts (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                INTEGER NOT NULL,
    run_id            TEXT NOT NULL,
    source_session_id TEXT,
    new_session_id    TEXT,
    written           INTEGER NOT NULL,
    refused_by        TEXT,
    reason            TEXT,
    removed_bytes     INTEGER NOT NULL,
    net_bytes         INTEGER NOT NULL,
    break_even_turns  REAL,
    cold_age_seconds  REAL,
    min_cold_age      INTEGER,
    resumed           INTEGER
  );`;

/** `recordForkAttempt`'s own INSERT, which is what has to prepare. */
const FORK_ATTEMPT_INSERT = `
  INSERT INTO fork_attempts
    (ts, run_id, source_session_id, new_session_id, written, refused_by,
     reason, removed_bytes, net_bytes, suffix_bytes, break_even_turns,
     cold_age_seconds, min_cold_age)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function hasColumn(db: Database.Database, table: string, col: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .some((c) => c.name === col);
}

/** Every `schema.fault` row on the file, oldest first, with `detail` parsed. */
function faults(db: Database.Database): Array<{
  level: string;
  detail: Record<string, unknown>;
}> {
  return (
    db
      .prepare(
        "SELECT level, detail FROM ops_events WHERE event = 'schema.fault' ORDER BY id",
      )
      .all() as Array<{ level: string; detail: string }>
  ).map((r) => ({
    level: r.level,
    detail: JSON.parse(r.detail) as Record<string, unknown>,
  }));
}

/**
 * Everything `migrate()` finds wrong with the file it has just opened used to
 * be a `console.error` and nothing else, which in a container is a scrollback
 * buffer that the next restart destroys — and a restart is exactly when an
 * operator comes looking for what the last boot said. These assert the durable
 * half: a row per finding, written on the connection the migration already
 * holds, because `db()` cannot be called from inside the `open()` that is
 * still running.
 */
describe("what migrate finds wrong with the database it just opened", () => {
  beforeEach(() => {
    dbMod.db().exec("DELETE FROM ops_events");
  });

  it("records a rollback to an older image rather than only printing it", () => {
    // The one case that cannot be produced by running this build forwards.
    let db = dbMod.db();
    db.pragma(`user_version = ${dbMod.SCHEMA_VERSION + 5}`);

    db = reboot();

    assert.deepEqual(faults(db), [
      {
        level: "error",
        detail: {
          finding: "downgrade",
          fileVersion: dbMod.SCHEMA_VERSION + 5,
          buildVersion: dbMod.SCHEMA_VERSION,
        },
      },
    ]);
  });

  it("records a leftover table it cannot read, naming the columns it wanted", () => {
    let db = dbMod.db();
    db.exec("CREATE TABLE chat_proposals_old (id TEXT PRIMARY KEY, junk TEXT)");

    db = reboot();

    try {
      // Two findings, and both matter: the recovery could not run, and the
      // sweep at the end of `migrate` still sees the table nobody reads.
      assert.deepEqual(
        faults(db).map((f) => f.detail.finding),
        ["proposals_unreadable", "orphan_table"],
      );
      const unreadable = faults(db)[0];
      assert.equal(unreadable.detail.table, "chat_proposals_old");
      assert.match(String(unreadable.detail.missing), /template_id/);
    } finally {
      db.exec("DROP TABLE chat_proposals_old");
    }
  });

  it("records the residue of an interrupted rebuild it did complete", () => {
    let db = dbMod.db();
    db.exec("ALTER TABLE chat_proposals RENAME TO chat_proposals_old");
    db.exec(proposalsCreateSql);

    db = reboot();

    assert.deepEqual(faults(db), [
      {
        level: "warn",
        detail: {
          finding: "proposals_stranded",
          table: "chat_proposals_old",
          recovered: 0,
        },
      },
    ]);
  });

  it("records any other orphan, and the row outlives the restart that found it", () => {
    let db = dbMod.db();
    db.exec("CREATE TABLE runs_old (id TEXT PRIMARY KEY)");

    db = reboot();

    try {
      assert.deepEqual(faults(db), [
        { level: "error", detail: { finding: "orphan_table", table: "runs_old" } },
      ]);
      db.exec("DROP TABLE runs_old");
      // The point of the row rather than the line: the next boot finds nothing
      // and prints nothing, and what the last one found is still readable.
      db = reboot();
      assert.equal(faults(db).length, 1);
    } finally {
      dbMod.db().exec("DROP TABLE IF EXISTS runs_old");
    }
  });

  it("reports only this boot's findings to /api/status, so a monitor de-latches", () => {
    let db = dbMod.db();
    db.exec("CREATE TABLE runs_old (id TEXT PRIMARY KEY)");

    db = reboot();
    assert.deepEqual(
      dbMod.schemaFaultsThisBoot().map((f) => f.detail.finding),
      ["orphan_table"],
    );

    db.exec("DROP TABLE runs_old");
    reboot();

    // The archive still holds it; the field the status endpoint reads does not.
    assert.equal(faults(dbMod.db()).length, 1);
    assert.deepEqual(dbMod.schemaFaultsThisBoot(), []);
  });
});

describe("a fork_attempts table created before suffix_bytes existed", () => {
  it("gains the column on the next boot, keeping the rows already in it", () => {
    let db = dbMod.db();
    db.exec("DROP TABLE IF EXISTS fork_attempts");
    db.exec(FORK_ATTEMPTS_PRE_SUFFIX);
    db.prepare(
      `INSERT INTO fork_attempts
         (ts, run_id, written, removed_bytes, net_bytes, refused_by)
       VALUES (1, 'r1', 0, 0, 0, 'cold-age')`,
    ).run();
    assert.equal(hasColumn(db, "fork_attempts", "suffix_bytes"), false);

    db = reboot();

    assert.equal(hasColumn(db, "fork_attempts", "suffix_bytes"), true);
    assert.equal(rows(db, "fork_attempts"), 1);
    // NOT NULL with a default, so the row that predates the column reads as 0
    // rather than null — which is what `forkCutFromRow` expects to arithmetic on.
    assert.equal(
      (db.prepare("SELECT suffix_bytes s FROM fork_attempts").get() as { s: number }).s,
      0,
    );
  });

  it("lets recordForkAttempt's insert prepare, which it could not before", () => {
    const db = dbMod.db();
    db.exec("DROP TABLE IF EXISTS fork_attempts");
    db.exec(FORK_ATTEMPTS_PRE_SUFFIX);
    // The failure the fix is for: the statement names a column the table does
    // not have, and `recordForkAttempt` catches this and returns null, so the
    // engine reports nothing and the operator sees an empty table.
    assert.throws(
      () => db.prepare(FORK_ATTEMPT_INSERT),
      /suffix_bytes/,
    );

    const migrated = reboot();

    migrated.prepare(FORK_ATTEMPT_INSERT).run(
      2, "r2", "s-old", "s-new", 1, null, null, 4096, 3072, 81920, 18.5, 4.2, 0,
    );
    assert.equal(rows(migrated, "fork_attempts"), 1);
  });
});

/** The table as every install that ran a build before the drop has it. */
const PLAN_OBSERVATIONS = `
  CREATE TABLE plan_observations (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    ts               INTEGER NOT NULL,
    run_id           TEXT NOT NULL,
    session_id       TEXT,
    tier             TEXT NOT NULL,
    tool_calls       INTEGER NOT NULL,
    stripped         INTEGER NOT NULL,
    removed_bytes    INTEGER NOT NULL,
    pointer_overhead INTEGER NOT NULL,
    net_bytes        INTEGER NOT NULL,
    suffix_bytes     INTEGER NOT NULL,
    break_even_turns REAL,
    pruned           INTEGER NOT NULL
  );
  CREATE INDEX idx_plan_observations_ts ON plan_observations(ts);
  CREATE INDEX idx_plan_observations_run ON plan_observations(run_id, ts);`;

describe("a plan_observations table left by an install that predates the drop", () => {
  it("is gone after the next boot, indices with it", () => {
    // The whole of what the drop has to do, and the only way to find out that it
    // did not: the table took a row at every cycle boundary and every early end,
    // nothing ever read one, and nothing swept it. A boot that skipped the DROP
    // leaves an install growing a store with no reader and no horizon — which
    // looks exactly like a healthy one, because no page renders it either.
    let db = dbMod.db();
    // Dropped first on `fork_attempts`' reasoning: the case has to start from
    // the old shape whatever the boot above left, or a build where the DROP was
    // never added fails here at the CREATE rather than at the assertion.
    db.exec("DROP TABLE IF EXISTS plan_observations");
    db.exec(PLAN_OBSERVATIONS);
    db.prepare(
      `INSERT INTO plan_observations
         (ts, run_id, tier, tool_calls, stripped, removed_bytes,
          pointer_overhead, net_bytes, suffix_bytes, break_even_turns, pruned)
       VALUES (1, 'r1', 'CB', 183, 9, 40960, 4096, 36864, 819200, 18.5, 0)`,
    ).run();
    assert.equal(exists(db, "plan_observations"), true);

    db = reboot();

    assert.equal(exists(db, "plan_observations"), false);
    // `resume_probes` is the same shape one table over and the difference is the
    // whole reason only one of them was dropped: it *is* read, as the control
    // group `boundaryInvalidation` needs. A drop that took both would leave the
    // arithmetic that compares pruned boundaries to clean ones with no clean
    // ones — and that reads as "no evidence yet", not as a fault.
    assert.equal(exists(db, "resume_probes"), true);
  });

  it("does not make a boot that never had it throw", () => {
    // `IF EXISTS`, and it carries every boot after the first one. Without it the
    // second start of a fresh install dies in `migrate` before any table is
    // reachable, which is a failure mode with no rows in it to notice.
    assert.equal(exists(dbMod.db(), "plan_observations"), false);
    const again = reboot();
    assert.equal(exists(again, "plan_observations"), false);
    assert.equal(exists(again, "settings"), true);
  });
});
