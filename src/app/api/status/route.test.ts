import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StatusReport } from "../../../lib/status";

/**
 * The one route in this app whose reader is not a person.
 *
 * Two things about it can be wrong in a way nothing else notices. The counts
 * can disagree with the rows — a monitor thresholding queue depth then never
 * fires, which is bit-for-bit what a queue that never backs up looks like. And
 * the payload can grow a field it must not carry: this is polled by whatever
 * the operator runs, retained there and forwarded, so a folder path or a prompt
 * on it leaks what this install works on into a system with a different
 * lifetime and a different audience. Neither throws and both typecheck.
 *
 * The read-only credential is the third: `middleware.ts` exempts this path only
 * while `UF_STATUS_TOKEN` is set, so if the check here ever stops matching that
 * condition the exemption is an open route. The two are asserted together for
 * `/api/mcp`'s reason.
 *
 * It opens a throwaway database and names `CLAUDE_HOME` as well, because the
 * report walks the transcript tree for a byte count and must not be pointed at
 * the operator's own.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-status-"));
process.env.DATA_DIR = path.join(root, "data");
process.env.CLAUDE_HOME = path.join(root, "claude");
process.env.WORKSPACE_ROOT = path.join(root, "workspace");
// Both, and this one matters more than it looks: `WORKSPACE_ROOTS` wins over
// `WORKSPACE_ROOT`, and a shell that has it set — which is any container this
// app ships in — would point the checkout-store walk at the real mounts and
// measure the machine this test is running on.
//
// Three slots, because `docker-compose.yml` defaults `UF_WORKSPACE_2..4` to
// `${UF_WORKSPACE}` and so one host directory can sit behind several slots:
// `Alias` is `Scratch` through a symlink, and `Nested` is a different directory
// inside the same tree, whose store is a store of its own. Created here rather
// than in `before`, because `WORKSPACE_MOUNTS` is fixed when `config` loads.
fs.mkdirSync(path.join(root, "workspace", "nested"), { recursive: true });
fs.symlinkSync(path.join(root, "workspace"), path.join(root, "workspace-alias"));
process.env.WORKSPACE_ROOTS = [
  `Scratch=${path.join(root, "workspace")}`,
  `Alias=${path.join(root, "workspace-alias")}`,
  `Nested=${path.join(root, "workspace", "nested")}`,
].join("|");

after(() => {
  delete process.env.UF_STATUS_TOKEN;
  delete process.env.WORKSPACE_ROOTS;
  fs.rmSync(root, { recursive: true, force: true });
});

before(async () => {
  const config = await import("../../../lib/config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );
  fs.mkdirSync(path.join(root, "workspace"), { recursive: true });

  // The report reads the same snapshot the guard does, and that snapshot asks
  // the provider for its own utilisation. There is no network here and the
  // request waits out its timeout, so the setting that governs it is turned off
  // — the derived reading is what every other test in this repo works against,
  // and this file is about the payload rather than about the figure.
  const { saveSettings } = await import("../../../lib/settings");
  saveSettings({ planUsageFromApi: false });
});

/**
 * A real ENOENT, whose message names the worktree it was asked to read — the
 * shape of what a sweep throws when a checkout is removed under it.
 */
function folderNamingFailure(): unknown {
  try {
    fs.readdirSync(
      path.join(root, "workspace", "secret-project", ".uf-worktrees", "secret-project-3"),
    );
  } catch (err) {
    return err;
  }
  throw new Error("expected the made-up folder to be missing");
}

async function get(headers: Record<string, string> = {}) {
  const { GET } = await import("./route");
  const res = await GET(new Request("http://localhost/api/status", { headers }));
  return { status: res.status, body: (await res.json()) as StatusReport };
}

test("reports the rows it was seeded with, by status", async () => {
  const { db } = await import("../../../lib/db");
  const insert = db().prepare(
    "INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, created_at)" +
      " VALUES (?, ?, 'do the thing', ?, '{}', 1, ?)",
  );
  const long_ago = Date.now() - 90_000;
  insert.run("s-run", "/workspace/secret-project", "running", Date.now());
  insert.run("s-q1", "/workspace/secret-project", "queued", long_ago);
  insert.run("s-q2", "/workspace/secret-project", "queued", Date.now());
  insert.run("s-wait", "/workspace/secret-project", "waiting", Date.now());
  insert.run("s-done", "/workspace/secret-project", "completed", Date.now());
  // What `createRun` stamps on a row it writes `queued`, and what the queue's
  // age is read from.
  db().prepare("UPDATE runs SET queued_at = created_at WHERE status = 'queued'").run();

  const { status, body } = await get();

  assert.equal(status, 200);
  assert.equal(body.runs.running, 1);
  assert.equal(body.runs.queued, 2);
  assert.equal(body.runs.waiting, 1);
  assert.equal(body.runs.completed, 1);

  // Queue depth is admitted-and-not-started, which is both statuses: a chain of
  // waiting runs is work the operator is expecting to see happen.
  assert.equal(body.queue.depth, 3);
  assert.ok(
    body.queue.oldestQueuedAgeSeconds !== null &&
      body.queue.oldestQueuedAgeSeconds >= 89,
    `the oldest queued run's age must be the oldest one: ${body.queue.oldestQueuedAgeSeconds}`,
  );
});

test("carries every documented key", async () => {
  const { body } = await get();

  for (const key of [
    "now",
    "uptimeSeconds",
    "dataDirOwned",
    "runs",
    "queue",
    "windows",
    "stores",
    "sweeper",
    "liveGuard",
    "webhook",
    "lastBootReconcile",
    "restartClosedOutstanding",
    "tools",
    "schemaFaults",
  ]) {
    assert.ok(key in body, `the status payload lost "${key}"`);
  }
  for (const w of [body.windows.session, body.windows.weekly]) {
    assert.equal(typeof w.startsAt, "number");
    assert.equal(typeof w.costUSD, "number");
    assert.equal(typeof w.costGuardUSD, "number");
    // A window with no ceiling and no provider reading is null, never 0 — an
    // unknown fraction reported as zero is a guard that reads as wide open.
    assert.ok(w.fraction === null || typeof w.fraction === "number");
  }
  assert.equal(typeof body.tools.declared, "number");
  assert.equal(typeof body.tools.notOk, "number");
  assert.equal(typeof body.stores.databaseBytes, "number");
  assert.equal(typeof body.stores.checkoutsBytes, "number");
  assert.equal(typeof body.stores.transcriptsBytes, "number");
  assert.equal(body.stores.partial, false);
  assert.ok(body.stores.databaseBytes > 0, "the database file has a size");

  // The fourth store, minus the one thing this payload may not carry. An
  // unreadable directory reports `readable: false` rather than a count of zero,
  // and neither of those is a path.
  assert.equal(typeof body.stores.backups.readable, "boolean");
  assert.equal(typeof body.stores.backups.count, "number");
  assert.equal(typeof body.stores.backups.bytes, "number");
  assert.ok(
    body.stores.backups.newestAgeSeconds === null ||
      typeof body.stores.backups.newestAgeSeconds === "number",
  );
  assert.equal(
    "path" in (body.stores.backups as Record<string, unknown>),
    false,
    "the backup directory's path must not reach a monitor's retained payload",
  );
});

test("measures a checkout store's bytes, and says when it stopped early", async () => {
  const { statusReport } = await import("../../../lib/status");
  const store = path.join(root, "workspace", ".uf-worktrees", "repo-1");
  fs.mkdirSync(path.join(store, "nested"), { recursive: true });
  fs.writeFileSync(path.join(store, "a.bin"), Buffer.alloc(4096));
  fs.writeFileSync(path.join(store, "nested", "b.bin"), Buffer.alloc(2048));

  // The cached measurement from the tests above has to be stepped past: it is a
  // five-minute cache, deliberately, because this walk is the costliest thing
  // on the route.
  const later = Date.now() + 10 * 60_000;
  const body = await statusReport(later);

  assert.equal(
    body.stores.checkoutsBytes,
    6144,
    "the checkout store's own bytes, walked and added up",
  );
  assert.equal(body.stores.partial, false);
});

test("measures one checkout store once however many slots name its directory", async () => {
  const { statusReport } = await import("../../../lib/status");
  const store = path.join(root, "workspace", ".uf-worktrees");
  // Self-contained, so the figure below is this fixture's and not the sum of
  // whatever an earlier case left in the same directory.
  fs.rmSync(store, { recursive: true, force: true });
  fs.mkdirSync(path.join(store, "repo-1"), { recursive: true });
  fs.writeFileSync(path.join(store, "repo-1", "a.bin"), Buffer.alloc(10_000));
  const nestedStore = path.join(root, "workspace", "nested", ".uf-worktrees", "repo-1");
  fs.mkdirSync(nestedStore, { recursive: true });
  fs.writeFileSync(path.join(nestedStore, "b.bin"), Buffer.alloc(300));

  const body = await statusReport(Date.now() + 20 * 60_000);

  // `Scratch` and `Alias` are one directory, so 10,000 and not 20,000; a monitor
  // thresholding this field fires at half the real size otherwise. `Nested` is
  // inside the same tree but its store is another directory, so it is added —
  // the opposite error, a store dropped, understates and reads as headroom.
  assert.equal(body.stores.checkoutsBytes, 10_300);
});

test("counts the delivery attempts since the webhook last succeeded", async () => {
  // The one number on this payload that reports on a *sink* rather than on this
  // app, and the reason the delivery table exists: an outbound webhook is
  // fire-and-forget, so a receiver that has been refusing every POST since
  // Tuesday looks exactly like a quiet fleet. Derived from the rows rather than
  // counted in memory, so a restart does not reset the answer — which is what
  // this seeds and asserts.
  const { db } = await import("../../../lib/db");
  const insert = db().prepare(
    "INSERT INTO webhook_deliveries (ts, run_id, event, http_status, ok, error)" +
      " VALUES (?, ?, ?, ?, ?, ?)",
  );
  const now = Date.now();
  insert.run(now - 5_000, "s-run", "run.blocked", 0, 0, "the failure before the success");
  insert.run(now - 4_000, "s-run", "run.needs_review", 204, 1, null);
  insert.run(now - 3_000, "s-run", "run.failed", 0, 0, "getaddrinfo ENOTFOUND hooks.example.invalid");
  insert.run(now - 2_000, "s-run", "run.blocked", 502, 0, "HTTP 502");

  const { body } = await get();

  assert.equal(
    body.webhook.consecutiveFailures,
    2,
    "since the last success, not every failure ever retained",
  );
  assert.ok(
    body.webhook.lastAttemptAgeSeconds !== null &&
      body.webhook.lastAttemptAgeSeconds >= 1,
    `an attempt was made, so its age is a number: ${body.webhook.lastAttemptAgeSeconds}`,
  );
  // Nothing in this process set `UF_WEBHOOK_URL`, and the flag is what tells a
  // monitor that a zero count means "delivering" rather than "never tried".
  assert.equal(body.webhook.configured, false);
  assert.ok(
    !JSON.stringify(body).includes("hooks.example.invalid"),
    "a fetch failure names the receiver's host, and this endpoint is scraped and " +
      "retained elsewhere — the message stays on stdout and in the table",
  );
});

test("carries no prompt, no folder path, no setting and no credential", async () => {
  process.env.UF_AUTH_TOKEN = "master-token-value";
  process.env.UF_STATUS_TOKEN = "monitor-token-value";
  // A declared tool is a settings value in everything but the table it is
  // stored in, and its resolved path is a mount path. Both are refused by this
  // payload's rule, and nothing else in this list would have noticed one: every
  // other forbidden string here is one this file seeded, and a tool name is a
  // string it had never heard of.
  process.env.UF_PY_TOOLS = "a-declared-python-tool==1.0";
  process.env.UF_GH_EXTENSIONS = "an-owner/gh-a-declared-extension";
  // The two fields whose content a thrower wrote rather than this file. Their
  // class is the reading, and is asserted so the absence below is not vacuous.
  const { noteLiveTickFailure, noteSweepFailure } = await import("../../../lib/ops");
  noteSweepFailure(folderNamingFailure());
  noteLiveTickFailure(folderNamingFailure());
  try {
    const { body } = await get({ authorization: "Bearer monitor-token-value" });
    const serialised = JSON.stringify(body);

    for (const forbidden of [
      "do the thing", // a run's prompt
      "secret-project", // a folder path
      "/workspace", // any path at all
      "master-token-value",
      "monitor-token-value",
      "hooks.example.invalid", // a webhook receiver's host, from the rows above
      "a-declared-python-tool", // what this install was told to install
      "a-declared-extension",
      root,
    ]) {
      assert.ok(
        !serialised.includes(forbidden),
        `the status payload must not carry "${forbidden}"`,
      );
    }
    assert.equal(body.sweeper.lastError, "ENOENT");
    assert.equal(body.liveGuard.lastError, "ENOENT");
  } finally {
    delete process.env.UF_AUTH_TOKEN;
    delete process.env.UF_STATUS_TOKEN;
    // node:test runs this file in one process and `after()` below clears only
    // the two tokens, so a value left here would reach every test after it.
    delete process.env.UF_PY_TOOLS;
    delete process.env.UF_GH_EXTENSIONS;
  }
});

test("refuses a caller with no credential once a read-only token exists", async () => {
  // The middleware exemption is conditional on this variable, so this check is
  // the whole of the gate whenever it is set. Wrong, and the exemption above it
  // makes the route public.
  process.env.UF_STATUS_TOKEN = "monitor-token-value";
  try {
    assert.equal((await get()).status, 401);
    assert.equal((await get({ authorization: "Bearer wrong" })).status, 401);
    assert.equal(
      (await get({ authorization: "Bearer monitor-token-value" })).status,
      200,
    );

    // And the operator's own session still reads it, so nobody has to find the
    // monitor's credential to look at the same numbers.
    //
    // A *real* cookie, minted the way the login route mints one. This used to
    // be a raw `uf_session=master-token-value`, which is the shape the cookie
    // had before it became a signed handle — so the assertion passed while the
    // branch it covers could not be satisfied by anything this app is able to
    // issue. Changed deliberately: the old expectation was the defect.
    process.env.UF_AUTH_TOKEN = "master-token-value";
    const { mintSessionCookie, newSessionId, SESSION_TTL_MS } = await import(
      "../../../lib/sessionToken"
    );
    const cookie = await mintSessionCookie(
      newSessionId(),
      Date.now() + SESSION_TTL_MS,
      "master-token-value",
    );
    assert.equal((await get({ cookie: `uf_session=${cookie}` })).status, 200);
    // The token itself in the jar is not a session and never was one after the
    // change — it is the one thing the old assertion accepted.
    assert.equal(
      (await get({ cookie: "uf_session=master-token-value" })).status,
      401,
    );
  } finally {
    delete process.env.UF_AUTH_TOKEN;
    delete process.env.UF_STATUS_TOKEN;
  }
});

// The master token is accepted here as well as at the gate, on a path the gate
// exempts, so it was a third place to guess it with no budget at all.
test("the master bearer here is charged to the sign-in budget, and not compared once it is spent", async () => {
  process.env.UF_STATUS_TOKEN = "monitor-token-value";
  process.env.UF_AUTH_TOKEN = "master-token-value";
  const attempts = await import("../../../lib/loginAttempts");
  const { DEFAULT_LIMITER } = await import("../../../lib/loginLimiter");
  const { db } = await import("../../../lib/db");
  db().prepare("DELETE FROM login_attempts").run();
  try {
    assert.equal((await get({ authorization: "Bearer wrong-0" })).status, 401);
    assert.equal(attempts.loginFailureSummary().failures, 1);
    // A right one is not a failure, and is not charged as one.
    assert.equal((await get({ authorization: "Bearer master-token-value" })).status, 200);
    assert.equal(attempts.loginFailureSummary().failures, 1);

    for (let i = 1; i < DEFAULT_LIMITER.maxGlobalFailures; i++) {
      await get({ authorization: `Bearer wrong-${i}` });
    }
    assert.equal(attempts.loginFailureSummary().lockedGlobally, true);

    // Inside the lock the master token gets the wrong token's answer…
    assert.equal((await get({ authorization: "Bearer master-token-value" })).status, 401);
    // …and the monitor's own credential, which guesses at nothing, still reads
    // the page: a lock any caller can trip must not blind the monitor.
    assert.equal((await get({ authorization: "Bearer monitor-token-value" })).status, 200);
  } finally {
    db().prepare("DELETE FROM login_attempts").run();
    delete process.env.UF_AUTH_TOKEN;
    delete process.env.UF_STATUS_TOKEN;
  }
});

test("counts the restart-closed runs still waiting, and clears as they go", async () => {
  const { db } = await import("../../../lib/db");
  const insert = db().prepare(
    "INSERT INTO runs (id, folder, prompt, status, budget, max_iterations," +
      " created_at, restart_closed) VALUES (?, ?, 'do the thing', 'failed', '{}', 1, ?, 1)",
  );
  insert.run("s-rc1", "/workspace/secret-project", Date.now());
  insert.run("s-rc2", "/workspace/secret-project", Date.now());

  assert.equal((await get()).body.restartClosedOutstanding, 2);

  // The field `lastBootReconcile.closed` cannot do: picking one up moves it.
  db().prepare("UPDATE runs SET restart_closed = 0 WHERE id = 's-rc1'").run();
  assert.equal((await get()).body.restartClosedOutstanding, 1);

  // And a run held back from the bulk pick-ups is not outstanding either, or
  // the alert would be one nobody could ever clear.
  db()
    .prepare("UPDATE runs SET set_aside_at = ? WHERE id = 's-rc2'")
    .run(Date.now());
  assert.equal((await get()).body.restartClosedOutstanding, 0);
});

test("retains a restart's reconciliation count rather than only logging it", async () => {
  const { recordOpsEvent } = await import("../../../lib/ops");
  recordOpsEvent("warn", "boot.reconciled", { closed: 25, kept: 3 });

  const { body } = await get();
  assert.deepEqual(
    body.lastBootReconcile && {
      closed: body.lastBootReconcile.closed,
      kept: body.lastBootReconcile.kept,
    },
    { closed: 25, kept: 3 },
  );
});

test("ages a re-queued run from when it rejoined the queue, not from when it was created", async () => {
  const { db } = await import("../../../lib/db");
  const { getSettings, saveSettings } = await import("../../../lib/settings");
  const { resumeRun } = await import("../../../lib/orchestrator");

  // The gauge is a minimum over the install, so the first test's queued rows
  // would answer for this one.
  db().prepare("DELETE FROM runs WHERE status = 'queued'").run();

  // A full fleet, so the resumed run is still `queued` when the report reads
  // it — the state the README's alert is about.
  const { maxConcurrentRuns } = getSettings();
  saveSettings({ maxConcurrentRuns: 0 });
  try {
    const now = Date.now();
    const threeDaysAgo = now - 3 * 24 * 3600_000;
    db()
      .prepare(
        "INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations," +
          " created_at, started_at, paused_at, resume_at)" +
          " VALUES ('s-parked', ?, 'do the thing', 'paused', '{}', 5, 2, ?, ?, ?, ?)",
      )
      .run(path.join(root, "workspace"), threeDaysAgo, threeDaysAgo, now - 600_000, now - 60_000);

    assert.equal(resumeRun("s-parked"), "requeued");
    const row = db().prepare("SELECT status FROM runs WHERE id = 's-parked'").get() as {
      status: string;
    };
    assert.equal(row.status, "queued", "a cap of 0 must leave the resumed run in the queue");

    // Three days is what this reported before: a run that had already worked
    // two cycles, read as "queued and never started" the second it rejoined.
    const age = (await get()).body.queue.oldestQueuedAgeSeconds;
    assert.ok(age !== null && age < 60, `a run re-queued just now has waited ${age}s`);
  } finally {
    saveSettings({ maxConcurrentRuns });
  }
});
