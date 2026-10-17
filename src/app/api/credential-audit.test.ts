import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
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
let localProvider: typeof import("./local-provider/route");
let claudeAuth: typeof import("../../lib/claudeAuth");
let codexAuth: typeof import("../../lib/codexAuth");
let dbMod: typeof import("../../lib/db");

/**
 * A stand-in for each CLI, on the two paths `config.ts` reads.
 *
 * Node scripts with a shebang rather than shell, because the whole point of the
 * pair is that the credential reaches them on **stdin** and nothing about that
 * is testable through a mock of the module that spawns them.
 *
 * Each keeps its credential in a file, so a status read reports what the last
 * sign-in or sign-out actually did — and reads it at spawn, so a read held open
 * by `STUB_STATUS_DELAY_MS` answers with the state from before a change made
 * while it waited, which is what a status poll already in flight does.
 */
function writeStubs(dir: string): { claude: string; codex: string } {
  const claude = path.join(dir, "claude-stub.js");
  fs.writeFileSync(
    claude,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const state = process.env.CLAUDE_STUB_STATE;
const loggedIn = process.env.CLAUDE_STUB_LOGGED_IN === "1" || fs.existsSync(state);
if (args[0] === "auth" && args[1] === "status") {
  if (process.env.STUB_STATUS_FAIL === "1") {
    process.stdout.write("segfault-ish garbage\\n");
    process.exit(1);
  }
  setTimeout(() => {
    process.stdout.write(
      JSON.stringify({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none" }) + "\\n",
    );
    process.exit(0);
  }, Number(process.env.STUB_STATUS_DELAY_MS || 0));
  return;
}
if (args[0] === "auth" && args[1] === "logout") {
  if (process.env.CLAUDE_STUB_FAIL === "1") {
    process.stdout.write("Logout failed\\n");
    process.exit(1);
  }
  fs.rmSync(state, { force: true });
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
    if (!buffered.includes("\\n")) return;
    // An exchange that exits 0 having written nothing, for the check that a
    // sign-in is not reported over a status still saying signed out.
    if (process.env.CLAUDE_STUB_EXCHANGE !== "forget") fs.writeFileSync(state, "creds");
    process.exit(0);
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
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const file = path.join(process.env.CODEX_HOME, "auth.json");
if (args[0] === "login" && args[1] === "status") {
  const stored = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (process.env.STUB_STATUS_FAIL === "1") {
    process.stdout.write("Error checking login status: resource temporarily unavailable\\n");
    process.exit(1);
  }
  const answer =
    process.env.CODEX_STUB_STATUS ||
    (stored === null
      ? "Not logged in"
      : stored.includes("apikey")
        ? "Logged in using an API key - sk-proj-***12345"
        : "Logged in using ChatGPT");
  setTimeout(() => {
    process.stdout.write(answer + "\\n");
    process.exit(0);
  }, Number(process.env.STUB_STATUS_DELAY_MS || 0));
  return;
}
if (args[0] === "logout") {
  fs.rmSync(file, { force: true });
  process.stdout.write("Successfully logged out\\n");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "--with-api-key") {
  let buffered = "";
  process.stdin.on("data", (chunk) => (buffered += chunk.toString()));
  process.stdin.on("end", () => {
    if (buffered.trim() === "") {
      process.stdout.write("No API key provided via stdin.\\n");
      process.exit(0);
    }
    fs.writeFileSync(file, JSON.stringify({ auth_mode: "apikey" }));
    process.stdout.write("Saved\\n");
    process.exit(0);
  });
  return;
}
if (args[0] === "login" && args[1] === "--device-auth") {
  // The pinned CLI deletes the credential first and asks OpenAI for a code
  // second, so a start can sign the container out and still never print one.
  fs.rmSync(file, { force: true });
  if (process.env.CODEX_STUB_DEVICE === "unreachable") {
    process.stderr.write("Error logging in with device code: error sending request for url (https://auth.openai.com/api/accounts/deviceauth/usercode)\\n");
    process.exit(1);
  }
  if (process.env.CODEX_STUB_DEVICE === "stall") {
    setInterval(() => {}, 60_000);
    return;
  }
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
  process.env.CLAUDE_STUB_STATE = path.join(root, "claude-credential");
  // One proxy in front, so `post`'s header names an address: with none
  // declared, `sourceAddress` reads no forwarding header at all.
  process.env.UF_TRUSTED_PROXY_HOPS = "1";
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
  localProvider = await import("./local-provider/route");
  claudeAuth = await import("../../lib/claudeAuth");
  codexAuth = await import("../../lib/codexAuth");
  dbMod = await import("../../lib/db");
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  dbMod.db().prepare("DELETE FROM ops_events").run();
  dbMod.db().prepare("DELETE FROM request_log").run();
  delete process.env.CLAUDE_STUB_FAIL;
  delete process.env.CLAUDE_STUB_LOGGED_IN;
  delete process.env.CODEX_STUB_STATUS;
  delete process.env.CODEX_STUB_DEVICE;
  delete process.env.CLAUDE_STUB_EXCHANGE;
  delete process.env.STUB_STATUS_DELAY_MS;
  delete process.env.STUB_STATUS_FAIL;
  fs.rmSync(claudeCredential(), { force: true });
  fs.rmSync(path.join(process.env.CODEX_HOME as string, "auth.json"), { force: true });
});

function claudeCredential(): string {
  return process.env.CLAUDE_STUB_STATE as string;
}

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

/** A stored Codex credential for the stub to delete, and where it is. */
function storedCodexCredential(): string {
  const home = process.env.CODEX_HOME as string;
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, "auth.json");
  fs.writeFileSync(file, JSON.stringify({ auth_mode: "apikey" }));
  return file;
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Start a Claude sign-in and return the id its code has to be sent beside:
 * `login/code` refuses a code that names any sign-in but the pending one.
 */
async function startClaudeSignIn(): Promise<string> {
  const res = await claudeLogin.POST(post("http://localhost/api/claude-auth/login"));
  assert.equal(res.status, 200);
  return ((await res.json()) as { loginId: string }).loginId;
}

function post(url: string, body?: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // The left is what the client claimed; the right is what the proxy saw.
      "x-forwarded-for": "10.0.0.1, 203.0.113.9",
      cookie: "uf_session=v1.abc.123.def",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("a provider credential that changed leaves a durable row", () => {
  it("names the provider and the method a Claude sign-in landed", async () => {
    const loginId = await startClaudeSignIn();
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
      post("http://localhost/api/claude-auth/login/code", { code: CODE, loginId }),
    );
    assert.equal(res.status, 200);

    const signedIn = opsRows()[1];
    assert.equal(signedIn.event, "auth.provider_signed_in");
    assert.equal(signedIn.detail.provider, "claude");
    assert.equal(signedIn.detail.method, "claude.ai");
    // Who, as far as this install has one: the credential class and the
    // address the proxy vouches for, never the credential and never an
    // invented account.
    assert.equal(signedIn.detail.actor, "session");
    assert.equal(signedIn.detail.address, "203.0.113.9");
  });

  it("carries neither the authorize code nor the API key into either table", async () => {
    process.env.CLAUDE_STUB_LOGGED_IN = "1";
    const loginId = await startClaudeSignIn();
    await claudeCode.POST(
      post("http://localhost/api/claude-auth/login/code", { code: CODE, loginId }),
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

  /**
   * The two ways a Codex start ends without a link, after its CLI has already
   * deleted `auth.json`: measured against 0.153.4, the file goes ~20 ms after
   * spawn and the code arrives ~300 ms later, after a round trip to OpenAI.
   * Neither has a started row behind it, so its own row is the only one that
   * says the credential may have gone.
   */
  it("records a cancel that lands while a Codex start still waits for its link", async () => {
    process.env.CODEX_STUB_DEVICE = "stall";
    const credential = storedCodexCredential();
    const start = codexLogin.POST(post("http://localhost/api/codex-auth/login"));
    await until(() => !fs.existsSync(credential), "the stub to delete auth.json");

    await codexLogin.DELETE(
      new Request("http://localhost/api/codex-auth/login", { method: "DELETE" }),
    );
    assert.equal((await start).status, 409);

    const row = onlyOps();
    assert.equal(row.event, "auth.provider_login_cancelled");
    assert.equal(row.detail.provider, "codex");
    assert.equal(row.detail.may_have_cleared_credential, true);
    // `warn`, where a cancel over a pending login is `info`: there the
    // deletion is already the started row's, and here it is nobody else's.
    assert.equal(row.level, "warn");
  });

  it("records a Codex start whose CLI exited after deleting the credential", async () => {
    process.env.CODEX_STUB_DEVICE = "unreachable";
    const credential = storedCodexCredential();
    const res = await codexLogin.POST(post("http://localhost/api/codex-auth/login"));
    assert.equal(res.status, 502);
    assert.ok(!fs.existsSync(credential));

    // Field by field, and the CLI's own output is not one of them.
    assert.deepEqual(onlyOps(), {
      level: "warn",
      event: "auth.provider_login_failed",
      detail: {
        provider: "codex",
        may_have_cleared_credential: true,
        actor: "session",
        address: "203.0.113.9",
      },
    });
  });
});

/**
 * What `GET /api/{claude,codex}-auth` does first — a status read — spawned
 * before a change and still running after it: a second tab, a script, or the
 * Settings block's own reload. The stubs read their credential at spawn.
 */
async function readInFlight(
  read: () => Promise<unknown>,
): Promise<{ done: Promise<unknown> }> {
  process.env.STUB_STATUS_DELAY_MS = "1500";
  // Both modules spawn synchronously inside the call, so the delay is in this
  // child's environment and in no later one's.
  const done = read();
  delete process.env.STUB_STATUS_DELAY_MS;
  // Long enough for the child to boot and read its credential. Without it the
  // change can land first, and the read answers for the state after it.
  await new Promise((resolve) => setTimeout(resolve, 400));
  return { done };
}

/**
 * The mutation's own exit decides whether the credential changed, and a fresh
 * read decides what the page is told. Both used to come from one status read
 * that could join a read begun before the change, and so answer for the
 * credential as it was.
 */
describe("a status read already in flight does not answer for a change made after it began", () => {
  it("confirms a stored Codex key rather than refusing it", async () => {
    const poll = await readInFlight(() => codexAuth.readAuthStatus());
    const res = await codexApiKey.POST(
      post("http://localhost/api/codex-auth/api-key", { apiKey: API_KEY }),
    );
    await poll.done;
    assert.ok(fs.existsSync(path.join(process.env.CODEX_HOME as string, "auth.json")));
    assert.equal(res.status, 200);
    assert.deepEqual(
      opsRows().map((r) => [r.event, r.detail.method]),
      [["auth.provider_signed_in", "apikey"]],
    );
  });

  it("answers a Claude sign-in as signed in, and audits the method that landed", async () => {
    const loginId = await startClaudeSignIn();
    const poll = await readInFlight(() => claudeAuth.readAuthStatus());
    const res = await claudeCode.POST(
      post("http://localhost/api/claude-auth/login/code", { code: CODE, loginId }),
    );
    const body = (await res.json()) as { auth?: { loggedIn: boolean } };
    await poll.done;
    assert.ok(fs.existsSync(claudeCredential()));
    assert.equal(res.status, 200);
    assert.equal(body.auth?.loggedIn, true);
    assert.deepEqual(
      opsRows().map((r) => [r.event, r.detail.method ?? null]),
      [
        ["auth.provider_login_started", null],
        ["auth.provider_signed_in", "claude.ai"],
      ],
    );
  });

  it("answers a Codex sign-out as signed out", async () => {
    storedCodexCredential();
    const poll = await readInFlight(() => codexAuth.readAuthStatus());
    const res = await codexLogout.POST(post("http://localhost/api/codex-auth/logout"));
    const body = (await res.json()) as { auth?: { loggedIn: boolean } };
    await poll.done;
    assert.equal(res.status, 200);
    assert.equal(body.auth?.loggedIn, false);
  });

  it("answers a Claude sign-out as signed out, and so does a read begun after it", async () => {
    fs.writeFileSync(claudeCredential(), "creds");
    const poll = await readInFlight(() => claudeAuth.readAuthStatus());
    const res = await claudeLogout.POST(post("http://localhost/api/claude-auth/logout"));
    const body = (await res.json()) as { auth?: { loggedIn: boolean } };
    assert.equal(res.status, 200);
    assert.equal(body.auth?.loggedIn, false);
    // The page's next GET, arriving while the read from before the change is
    // still running, must not be handed that read either.
    const later = await claudeAuth.readAuthStatus();
    assert.ok(later.ok && !later.value.loggedIn, JSON.stringify(later));
    await poll.done;
  });
});

/**
 * The status child failing after the CLI already changed the credential — an
 * OOM kill, a timeout, `EAGAIN`. The change happened, so the durable row is
 * written; the read did not, so the answer says the change could not be
 * confirmed rather than that it failed.
 */
describe("a credential that changed is recorded even when the read confirming it fails", () => {
  it("records a Codex sign-out", async () => {
    const credential = storedCodexCredential();
    process.env.STUB_STATUS_FAIL = "1";
    const res = await codexLogout.POST(post("http://localhost/api/codex-auth/logout"));
    assert.ok(!fs.existsSync(credential));
    assertUnconfirmed(res.status, await res.json());
    assert.deepEqual(onlyOps(), {
      level: "warn",
      event: "auth.provider_signed_out",
      detail: { provider: "codex", unconfirmed: true, actor: "session", address: "203.0.113.9" },
    });
  });

  it("records a Claude sign-out", async () => {
    fs.writeFileSync(claudeCredential(), "creds");
    process.env.STUB_STATUS_FAIL = "1";
    const res = await claudeLogout.POST(post("http://localhost/api/claude-auth/logout"));
    assert.ok(!fs.existsSync(claudeCredential()));
    assertUnconfirmed(res.status, await res.json());
    assert.deepEqual(onlyOps(), {
      level: "warn",
      event: "auth.provider_signed_out",
      detail: { provider: "claude", unconfirmed: true, actor: "session", address: "203.0.113.9" },
    });
  });

  it("records a Claude sign-in", async () => {
    const loginId = await startClaudeSignIn();
    dbMod.db().prepare("DELETE FROM ops_events").run();
    process.env.STUB_STATUS_FAIL = "1";
    const res = await claudeCode.POST(
      post("http://localhost/api/claude-auth/login/code", { code: CODE, loginId }),
    );
    assert.ok(fs.existsSync(claudeCredential()));
    assertUnconfirmed(res.status, await res.json());
    // `warn` where a confirmed sign-in is `info`: a credential was written and
    // nothing has yet said what it is.
    assert.deepEqual(onlyOps(), {
      level: "warn",
      event: "auth.provider_signed_in",
      detail: {
        provider: "claude",
        method: null,
        unconfirmed: true,
        actor: "session",
        address: "203.0.113.9",
      },
    });
  });
});

/** "Changed, but could not confirm": a success, with no status and a reason. */
function assertUnconfirmed(status: number, body: unknown): void {
  assert.equal(status, 200, JSON.stringify(body));
  const answer = body as { auth?: unknown; error?: unknown };
  assert.equal(answer.auth, null);
  assert.match(String(answer.error), /could not confirm/);
}

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

  it("writes no durable row for a Codex start that never ran its CLI", async () => {
    // A `CODEX_HOME` that cannot be a directory fails the start before
    // anything is spawned, so nothing can have deleted the credential.
    const home = process.env.CODEX_HOME as string;
    fs.rmSync(home, { recursive: true, force: true });
    fs.writeFileSync(home, "");
    try {
      const res = await codexLogin.POST(post("http://localhost/api/codex-auth/login"));
      assert.equal(res.status, 502);
      assert.deepEqual(opsRows(), []);
      assert.equal(requestRows()[0].status, 502);
    } finally {
      fs.rmSync(home, { force: true });
    }
  });

  it("refuses a Claude sign-in whose fresh status still says signed out", async () => {
    // Codex's key store already refused this; Claude's code exchange reported
    // `ok` over whatever the read said, and audited a sign-in as `none`.
    // Set before the start: the child that does the exchange is spawned there.
    process.env.CLAUDE_STUB_EXCHANGE = "forget";
    const loginId = await startClaudeSignIn();
    dbMod.db().prepare("DELETE FROM ops_events").run();
    const res = await claudeCode.POST(
      post("http://localhost/api/claude-auth/login/code", { code: CODE, loginId }),
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: unknown; stillPending?: unknown };
    assert.equal(body.stillPending, false);
    assert.match(String(body.error), /signed out/);
    assert.deepEqual(opsRows(), []);
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

/**
 * A start superseded by a newer one is two presses overlapping, not a CLI that
 * failed, and the request line is where an operator tells those apart: a 502
 * there sends them looking for a broken CLI over a double press.
 */
describe("two overlapping sign-in starts", () => {
  for (const [provider, route] of [
    ["claude", () => claudeLogin],
    ["codex", () => codexLogin],
  ] as const) {
    it(`answer the older ${provider} start with a 409 and the newer with its link`, async () => {
      const url = `http://localhost/api/${provider}-auth/login`;
      try {
        // Not awaited between them: the second start takes the slot while the
        // first is still waiting on its stub for a link.
        const [older, newer] = await Promise.all([
          route().POST(post(url)),
          route().POST(post(url)),
        ]);
        assert.deepEqual([older.status, newer.status], [409, 200]);
        // The settings page shows this sentence as it stands, so it has to be
        // the server's own and not the page's fallback.
        const body = (await older.json()) as { error?: unknown };
        assert.match(String(body.error), /replaced by a newer one/);

        // The refused press is still a request line — the wrapper's half is
        // the one that records refusals — and only the start that minted a
        // link is a durable row.
        assert.deepEqual(
          requestRows().map((r) => r.status).sort(),
          [200, 409],
        );
        assert.deepEqual(
          opsRows().map((r) => [r.event, r.detail.provider]),
          [["auth.provider_login_started", provider]],
        );
      } finally {
        // The newer start's child is left waiting on its link otherwise.
        await route().DELETE(new Request(url, { method: "DELETE" }));
      }
    });
  }
});

describe("every one of the six leaves a request line", () => {
  it("records the method, the path and the outcome for each", async () => {
    process.env.CLAUDE_STUB_LOGGED_IN = "1";
    process.env.CODEX_STUB_STATUS = "Logged in using an API key - sk-proj-***4321";

    const loginId = await startClaudeSignIn();
    await claudeCode.POST(
      post("http://localhost/api/claude-auth/login/code", { code: CODE, loginId }),
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

/**
 * The local provider's sign-in, which is a seventh credential route with a
 * difference: the credential is kept by this app rather than by a CLI, so it
 * is also this app that could echo it back. A stub server stands in for the
 * local endpoint, because the route probes it before it saves anything.
 */
describe("the local provider's sign-in", () => {
  const TOKEN = "lm-studio-token-do-not-log";
  let server: http.Server;
  let baseUrl: string;
  let answer = 200;
  let sawAuth: string | undefined;

  before(async () => {
    server = http.createServer((req, res) => {
      sawAuth = req.headers.authorization;
      res.writeHead(answer, { "content-type": "application/json" });
      res.end(answer === 200 ? JSON.stringify({ type: "message", content: [] }) : "{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(() => server.close());

  beforeEach(() => {
    answer = 200;
    dbMod.db().prepare("DELETE FROM local_provider").run();
  });

  it("records the host and the model, never the token, in either table or the answer", async () => {
    const res = await localProvider.POST(
      post("http://localhost/api/local-provider", { baseUrl, token: TOKEN, model: "qwen3" }),
    );
    assert.equal(res.status, 200);
    const answerText = await res.text();
    assert.equal(sawAuth, `Bearer ${TOKEN}`);

    const row = onlyOps();
    assert.equal(row.event, "auth.provider_signed_in");
    assert.equal(row.detail.provider, "local");
    assert.equal(row.detail.model, "qwen3");

    const written = JSON.stringify(opsRows()) + JSON.stringify(requestRows()) + answerText;
    assert.ok(!written.includes(TOKEN), `the token was written out: ${written}`);
    assert.equal((JSON.parse(answerText) as { hasToken: boolean }).hasToken, true);
  });

  it("saves nothing and writes no durable row when the endpoint refuses", async () => {
    answer = 404;
    const res = await localProvider.POST(
      post("http://localhost/api/local-provider", { baseUrl, token: TOKEN, model: "qwen3" }),
    );
    assert.equal(res.status, 502);
    assert.deepEqual(opsRows(), []);
    assert.equal(
      (dbMod.db().prepare("SELECT COUNT(*) AS n FROM local_provider").get() as { n: number }).n,
      0,
    );
  });

  it("records a sign-out at warn", async () => {
    const res = await localProvider.DELETE(
      new Request("http://localhost/api/local-provider", { method: "DELETE" }),
    );
    assert.equal(res.status, 200);
    const row = onlyOps();
    assert.equal(row.event, "auth.provider_signed_out");
    assert.equal(row.level, "warn");
    assert.equal(row.detail.provider, "local");
  });
});
