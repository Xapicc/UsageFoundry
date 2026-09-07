import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * What the six credential routes leave behind when a credential changes.
 *
 * All six take, replace or destroy a credential — `claude auth login` writes the
 * OAuth credential every billed child runs against, the Codex pair writes an API
 * key — and none of them recorded anything at all. `POST /api/login` was
 * wrapped, so a sign-in was a line and a provider credential being replaced was
 * not: an operator reading the trail after an incident saw who got in and never
 * saw who changed what they got in with.
 *
 * Two halves, and this file drives both because they fail differently:
 *
 *  - the **request** line, in `request_log`, which the wrapper writes for every
 *    outcome including the refusals;
 *  - the **durable** line, in `ops_events`, which only a mutation that actually
 *    happened writes. That table is not evicted by ordinary traffic, which is
 *    the whole reason a credential rotation goes there — `request_log` is a
 *    20,000-row window trimmed on every insert, so the row saying the container
 *    was signed out is the first thing an ordinary week deletes.
 *
 * It also asserts the negative that matters more than either: the API key posted
 * to `/api/codex-auth/api-key` and the authorize code posted to
 * `/api/claude-auth/login/code` appear in no row of either table. Adding a field
 * is the dangerous direction here, and nothing about doing it would fail — it
 * would typecheck, and be discovered by whoever reads the logs.
 *
 * The CLIs are stubs on `CLAUDE_BIN`/`CODEX_BIN` rather than mocks, so the
 * routes run their real modules end to end: the sign-in row below is written
 * behind `submitApiKey`'s status read, which is the check that stops a sign-in
 * being reported over an unchanged install.
 *
 * Its own temp `DATA_DIR` set before the first import, for `runOrigin.test.ts`'s
 * reason.
 */

const CODE = "authorize-code-3fd91b";
const API_KEY = "sk-proj-do-not-log-this-anywhere";

let root: string;
let claudeLogin: typeof import("./claude-auth/login/route");
let claudeCode: typeof import("./claude-auth/login/code/route");
let claudeLogout: typeof import("./claude-auth/logout/route");
let codexApiKey: typeof import("./codex-auth/api-key/route");
let codexLogin: typeof import("./codex-auth/login/route");
let codexLogout: typeof import("./codex-auth/logout/route");
let dbMod: typeof import("../../lib/db");

/**
 * A stand-in for each CLI, on the two paths `config.ts` reads.
 *
 * Node scripts with a shebang rather than shell, because the whole point of the
 * pair is that the credential reaches them on **stdin** and nothing about that
 * is testable through a mock of the module that spawns them.
 */
function writeStubs(dir: string): { claude: string; codex: string } {
  const claude = path.join(dir, "claude-stub.js");
  fs.writeFileSync(
    claude,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const loggedIn = process.env.CLAUDE_STUB_LOGGED_IN === "1";
if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(
    JSON.stringify({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none" }) + "\\n",
  );
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "logout") {
  if (process.env.CLAUDE_STUB_FAIL === "1") {
    process.stdout.write("Logout failed\\n");
    process.exit(1);
  }
  process.stdout.write("Signed out\\n");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "login") {
  if (process.env.CLAUDE_STUB_FAIL === "1") {
    process.stdout.write("Could not reach the authorization server\\n");
    process.exit(1);
  }
  process.stdout.write("Open this URL to sign in:\\n");
  process.stdout.write("https://claude.ai/oauth/authorize?code=challenge\\n");
  let buffered = "";
  process.stdin.on("data", (chunk) => {
    buffered += chunk.toString();
    if (buffered.includes("\\n")) process.exit(0);
  });
  return;
}
process.exit(0);
`,
    { mode: 0o755 },
  );

  const codex = path.join(dir, "codex-stub.js");
  fs.writeFileSync(
    codex,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "login" && args[1] === "status") {
  process.stdout.write((process.env.CODEX_STUB_STATUS || "Not logged in") + "\\n");
  process.exit(0);
}
if (args[0] === "logout") {
  process.stdout.write("Successfully logged out\\n");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "--with-api-key") {
  let buffered = "";
  process.stdin.on("data", (chunk) => (buffered += chunk.toString()));
  process.stdin.on("end", () => {
    process.stdout.write(buffered.trim() === "" ? "No API key provided via stdin.\\n" : "Saved\\n");
    process.exit(0);
  });
  return;
}
if (args[0] === "login" && args[1] === "--device-auth") {
  process.stdout.write("Open https://auth.openai.com/device to continue\\n");
  process.stdout.write("ABCD-1234\\n");
  // Stays alive polling, which is what the real device flow does and what the
  // cancel route exists to kill.
  setInterval(() => {}, 60_000);
  return;
}
process.exit(0);
`,
    { mode: 0o755 },
  );

  return { claude, codex };
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-credential-audit-"));
  const stubs = writeStubs(root);
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.CODEX_HOME = path.join(root, "codex");
  process.env.WORKSPACE_ROOT = path.join(root, "workspace");
  process.env.CLAUDE_BIN = stubs.claude;
  process.env.CODEX_BIN = stubs.codex;

  const config = await import("../../lib/config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );
  assert.equal(config.CLAUDE_BIN, stubs.claude);
  assert.equal(config.CODEX_BIN, stubs.codex);

  claudeLogin = await import("./claude-auth/login/route");
  claudeCode = await import("./claude-auth/login/code/route");
  claudeLogout = await import("./claude-auth/logout/route");
  codexApiKey = await import("./codex-auth/api-key/route");
  codexLogin = await import("./codex-auth/login/route");
  codexLogout = await import("./codex-auth/logout/route");
  dbMod = await import("../../lib/db");
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  dbMod.db().prepare("DELETE FROM ops_events").run();
  dbMod.db().prepare("DELETE FROM request_log").run();
  delete process.env.CLAUDE_STUB_FAIL;
  delete process.env.CLAUDE_STUB_LOGGED_IN;
  delete process.env.CODEX_STUB_STATUS;
});

interface OpsRow {
  level: string;
  event: string;
  detail: Record<string, unknown>;
}

function opsRows(): OpsRow[] {
  const rows = dbMod
    .db()
    .prepare("SELECT level, event, detail FROM ops_events ORDER BY id")
    .all() as Array<{ level: string; event: string; detail: string }>;
  return rows.map((r) => ({
    level: r.level,
    event: r.event,
    detail: JSON.parse(r.detail) as Record<string, unknown>,
  }));
}

function requestRows(): Array<Record<string, unknown>> {
  return dbMod
    .db()
    .prepare("SELECT * FROM request_log ORDER BY id")
    .all() as Array<Record<string, unknown>>;
}

/** The one durable row, when exactly one is expected. */
function onlyOps(): OpsRow {
  const rows = opsRows();
  assert.equal(rows.length, 1, `expected one durable row, got ${JSON.stringify(rows)}`);
  return rows[0];
}

function post(url: string, body?: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.9, 10.0.0.1",
      cookie: "uf_session=v1.abc.123.def",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("a provider credential that changed leaves a durable row", () => {
  it("names the provider and the method a Claude sign-in landed", async () => {
    assert.equal(
      (await claudeLogin.POST(post("http://localhost/api/claude-auth/login"))).status,
      200,
    );
    // The link and the code are two presses that may be minutes apart, so they
    // are two rows: a trail with only the completion cannot say when the link
    // was minted or how many were.
    assert.deepEqual(
      opsRows().map((r) => r.event),
      ["auth.provider_login_started"],
    );
    assert.equal(opsRows()[0].detail.provider, "claude");

    process.env.CLAUDE_STUB_LOGGED_IN = "1";
    const res = await claudeCode.POST(
      post("http://localhost/api/claude-auth/login/code", { code: CODE }),
    );
    assert.equal(res.status, 200);

    const signedIn = opsRows()[1];
    assert.equal(signedIn.event, "auth.provider_signed_in");
    assert.equal(signedIn.detail.provider, "claude");
    assert.equal(signedIn.detail.method, "claude.ai");
    // Who, as far as this install has one: the credential class and the first
    // hop, never the credential and never an invented account.
    assert.equal(signedIn.detail.actor, "session");
    assert.equal(signedIn.detail.address, "203.0.113.9");
  });

  it("carries neither the authorize code nor the API key into either table", async () => {
    process.env.CLAUDE_STUB_LOGGED_IN = "1";
    await claudeLogin.POST(post("http://localhost/api/claude-auth/login"));
    await claudeCode.POST(
      post("http://localhost/api/claude-auth/login/code", { code: CODE }),
    );

    process.env.CODEX_STUB_STATUS = "Logged in using an API key - sk-proj-***here";
    await codexApiKey.POST(
      post("http://localhost/api/codex-auth/api-key", { apiKey: API_KEY }),
    );

    const written = JSON.stringify(opsRows()) + JSON.stringify(requestRows());
    assert.ok(!written.includes(CODE), `the trail carries the authorize code: ${written}`);
    assert.ok(!written.includes(API_KEY), `the trail carries the API key: ${written}`);
    // Not even the CLI's own mask of the stored key, which is a prefix and a
    // suffix of the secret and is on the page rather than in a kept row.
    assert.ok(!written.includes("sk-proj-***here"), written);
  });

  it("records a Claude sign-out at warn, because every run in flight will fail", async () => {
    const res = await claudeLogout.POST(post("http://localhost/api/claude-auth/logout"));
    assert.equal(res.status, 200);

    const row = onlyOps();
    assert.equal(row.event, "auth.provider_signed_out");
    assert.equal(row.detail.provider, "claude");
    assert.equal(row.level, "warn");
  });

  it("records a Codex sign-out and an API-key sign-in against their own provider", async () => {
    process.env.CODEX_STUB_STATUS = "Not logged in";
    assert.equal(
      (await codexLogout.POST(post("http://localhost/api/codex-auth/logout"))).status,
      200,
    );
    assert.deepEqual(onlyOps(), {
      level: "warn",
      event: "auth.provider_signed_out",
      detail: { provider: "codex", actor: "session", address: "203.0.113.9" },
    });

    dbMod.db().prepare("DELETE FROM ops_events").run();
    process.env.CODEX_STUB_STATUS = "Logged in using an API key - sk-proj-***4321";
    const res = await codexApiKey.POST(
      post("http://localhost/api/codex-auth/api-key", { apiKey: API_KEY }),
    );
    assert.equal(res.status, 200);

    const row = onlyOps();
    assert.equal(row.event, "auth.provider_signed_in");
    assert.equal(row.detail.provider, "codex");
    assert.equal(row.detail.method, "apikey");
  });

  it("records a Codex device login as the credential deletion it also is", async () => {
    const res = await codexLogin.POST(post("http://localhost/api/codex-auth/login"));
    assert.equal(res.status, 200);

    const row = onlyOps();
    assert.equal(row.event, "auth.provider_login_started");
    assert.equal(row.detail.provider, "codex");
    // The CLI clears `auth.json` the moment a device flow begins, before anybody
    // has approved anything, so this press is a sign-out that may not be
    // followed by a sign-in — and an operator working out when Codex stopped
    // being signed in has only this row to find.
    assert.equal(row.detail.cleared_existing_credential, true);
    assert.equal(row.level, "warn");

    // Cancelling kills the polling child, which is a fact about a login rather
    // than about a credential, and gets its own row.
    dbMod.db().prepare("DELETE FROM ops_events").run();
    await codexLogin.DELETE(
      new Request("http://localhost/api/codex-auth/login", { method: "DELETE" }),
    );
    assert.equal(onlyOps().event, "auth.provider_login_cancelled");
  });
});

describe("what a credential route records when nothing changed", () => {
  it("writes the request line and no durable row when the CLI refuses", async () => {
    process.env.CLAUDE_STUB_FAIL = "1";
    const res = await claudeLogout.POST(post("http://localhost/api/claude-auth/logout"));
    assert.equal(res.status, 502);

    // The refusal is the line an audit most wants and the wrapper is what
    // catches it — but nothing was signed out, so the durable channel, whose
    // whole subject is what changed, stays empty.
    assert.deepEqual(opsRows(), []);
    const [row] = requestRows();
    assert.equal(row.status, 502);
    assert.equal(row.path, "/api/claude-auth/logout");
    assert.equal(row.actor, "session");
    assert.equal(row.address, "203.0.113.9");
  });

  it("writes no durable row for a cancel over no pending login", async () => {
    await claudeLogin.DELETE(
      new Request("http://localhost/api/claude-auth/login", { method: "DELETE" }),
    );
    // A closed dialog over nothing is not an event, and `ops_events` keeps 500
    // rows: a row per no-op press is a row that evicts a real one.
    assert.deepEqual(opsRows(), []);
    assert.equal(requestRows().length, 1);
  });

  it("writes no durable row for a rejected authorize code", async () => {
    const res = await claudeCode.POST(
      post("http://localhost/api/claude-auth/login/code", { code: "has a space" }),
    );
    assert.equal(res.status, 400);
    assert.deepEqual(opsRows(), []);
    assert.equal(requestRows()[0].status, 400);
  });
});

describe("every one of the six leaves a request line", () => {
  it("records the method, the path and the outcome for each", async () => {
    process.env.CLAUDE_STUB_LOGGED_IN = "1";
    process.env.CODEX_STUB_STATUS = "Logged in using an API key - sk-proj-***4321";

    await claudeLogin.POST(post("http://localhost/api/claude-auth/login"));
    await claudeCode.POST(
      post("http://localhost/api/claude-auth/login/code", { code: CODE }),
    );
    await claudeLogout.POST(post("http://localhost/api/claude-auth/logout"));
    await codexLogin.POST(post("http://localhost/api/codex-auth/login"));
    await codexApiKey.POST(
      post("http://localhost/api/codex-auth/api-key", { apiKey: API_KEY }),
    );
    await codexLogout.POST(post("http://localhost/api/codex-auth/logout"));

    assert.deepEqual(
      requestRows().map((r) => r.path),
      [
        "/api/claude-auth/login",
        "/api/claude-auth/login/code",
        "/api/claude-auth/logout",
        "/api/codex-auth/login",
        "/api/codex-auth/api-key",
        "/api/codex-auth/logout",
      ],
    );
    for (const row of requestRows()) {
      assert.equal(row.method, "POST");
      assert.equal(row.status, 200);
      assert.equal(typeof row.duration_ms, "number");
    }
  });
});
