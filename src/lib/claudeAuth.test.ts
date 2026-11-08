import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it, mock } from "node:test";

/**
 * `config.ts` fixes `CLAUDE_BIN` at module load, so the stub `beginLogin`
 * spawns is named before anything is required. The assertion after the require
 * is what stops this file from spawning a real `claude auth login` should
 * `config` ever be loaded ahead of it.
 *
 * The stub records its pid, prints a link carrying that pid, and holds stdin
 * open the way the real CLI does while it waits for a code. `STUB_HOLD`, read
 * at spawn time, makes it wait for that file before printing;
 * `STUB_EXIT_AFTER_LINK` makes it leave on its own once it has printed, the
 * way a CLI that hit a network error or crashed does. Every line it reads goes
 * into `received.log` against its pid; under `STUB_EXCHANGE` it redeems only
 * `code-<its own pid>` and fails anything else the way a verifier mismatch
 * does, with a 400 and an exit. Its argv goes into `argv.log`, one line per
 * start with the arguments split by `\u001f` so an empty one survives.
 */
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-claude-auth-")));
const pidsDir = path.join(tmp, "pids");
fs.mkdirSync(pidsDir);
const stub = path.join(tmp, "claude");
const receivedLog = path.join(tmp, "received.log");
const argvLog = path.join(tmp, "argv.log");
fs.writeFileSync(
  stub,
  [
    "#!/bin/sh",
    `echo $$ > "${pidsDir}/$$"`,
    `printf '%s\\037' "$@" >> "${argvLog}"; echo >> "${argvLog}"`,
    // `$4` is the subcommand: argv leads with the settings flag and its value.
    'if [ -n "$STUB_STATUS" ] && [ "$4" = "status" ]; then echo "$STUB_STATUS"; exit 0; fi',
    'if [ -n "$STUB_HOLD" ]; then while [ ! -e "$STUB_HOLD" ]; do sleep 0.02; done; fi',
    'echo "Open https://claude.ai/oauth/authorize?state=$$"',
    'if [ -n "$STUB_EXIT_AFTER_LINK" ]; then sleep 0.2; exit 0; fi',
    "while read line; do",
    `  echo "$$ got $line" >> "${receivedLog}"`,
    '  if [ -n "$STUB_EXCHANGE" ]; then',
    '    if [ "$line" = "code-$$" ]; then exit 0; fi',
    '    echo "Login failed: Request failed with status code 400"; exit 1',
    "  fi",
    "done",
    "",
  ].join("\n"),
  { mode: 0o755 },
);

process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude-home");
process.env.WORKSPACE_ROOT = path.join(tmp, "workspace");
delete process.env.WORKSPACE_ROOTS;
process.env.CLAUDE_BIN = stub;

const config = require("./config") as typeof import("./config");
assert.equal(
  config.CLAUDE_BIN,
  stub,
  "config was loaded before the stub was named — refusing to spawn a real `claude auth login`",
);

const {
  beginLogin,
  cancelLogin,
  extractLoginUrl,
  loginExpiryProblems,
  normalizeCode,
  parseAuthStatus,
  pendingLogin,
  readAuthStatus,
  signOut,
  submitCode,
} = require("./claudeAuth") as typeof import("./claudeAuth");
const { PINNED_CYCLE_ENV } = require("./cycleInvocation") as typeof import("./cycleInvocation");
const { loginExpiry, loginExpiryMessage } = require("./loginExpiry") as typeof import("./loginExpiry");

/**
 * Three parsers reading another program's console output, captured from the
 * pinned CLI rather than read from any spec — the same footing as the
 * `stream-json` parser and the OTLP shapes, and the same reason for tests:
 * every way each one can go wrong is silent, and two of them point the wrong
 * way.
 *
 * A URL this fails to find is a Sign in button that opens nothing, and the
 * operator's only evidence is that pressing it did not work. A status shape
 * that stops parsing renders as *signed out* unless the parser insists on the
 * field it keys off, which would put a Sign in button in front of somebody who
 * is already signed in and a Sign out button nowhere. And a code carrying a
 * newline answers the CLI's prompt with its first half and whatever the CLI
 * asks next with its second — the one place a pasted value reaches a child
 * process, so the one place a paste can mean two things.
 */

/** `claude auth login`, stdout, pipes — what the server actually reads. */
const LOGIN_PIPED = [
  "Opening browser to sign in…",
  "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=v51p27kLpQ0P2RkpczX5ORwN68Yxf9jhMMFVeLSijdc&code_challenge_method=S256&state=HwKeHYwuw3Ntm5XUxqw30mAh5oP2OEzUYNu2F9cRfD4",
  "Paste code here if prompted > ",
].join("\n");

const AUTHORIZE_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=v51p27kLpQ0P2RkpczX5ORwN68Yxf9jhMMFVeLSijdc&code_challenge_method=S256&state=HwKeHYwuw3Ntm5XUxqw30mAh5oP2OEzUYNu2F9cRfD4";

/**
 * The same line under a tty, where the CLI wraps the URL in an OSC 8 hyperlink
 * and so prints it twice — once as the escape's payload, once as the visible
 * label. We spawn with pipes, so this is defence against a CLI that decides
 * otherwise rather than a shape seen in production; it is here because the
 * payload copy ends at a control character, and a stripper that missed the
 * escape would hand the browser a URL truncated at `ESC`.
 */
const LOGIN_HYPERLINKED =
  "If the browser didn't open, visit: " +
  `\u001B]8;;${AUTHORIZE_URL}\u001B\\${AUTHORIZE_URL}\u001B]8;;\u001B\\`;

describe("extractLoginUrl", () => {
  it("finds the authorize URL in what the CLI prints down a pipe", () => {
    assert.equal(extractLoginUrl(LOGIN_PIPED), AUTHORIZE_URL);
  });

  it("takes the label rather than the escape's payload under a tty", () => {
    assert.equal(extractLoginUrl(LOGIN_HYPERLINKED), AUTHORIZE_URL);
  });

  it("has nothing to report before the URL is printed", () => {
    assert.equal(extractLoginUrl("Opening browser to sign in…\n"), null);
    assert.equal(extractLoginUrl(""), null);
  });

  /**
   * The one case worth a check rather than a comment: this string is rendered
   * as the link an operator is asked to enter Anthropic credentials on, so a
   * URL from anywhere else is refused outright and the caller reports the raw
   * line instead of presenting it.
   */
  it("refuses a URL that is not Anthropic's", () => {
    assert.equal(
      extractLoginUrl("visit: https://claude.com.evil.test/oauth/authorize"),
      null,
    );
    assert.equal(extractLoginUrl("visit: http://claude.com/oauth"), null);
  });

  it("skips a foreign URL to reach the real one", () => {
    const url = extractLoginUrl(
      `docs: https://example.test/help\nvisit: ${AUTHORIZE_URL}`,
    );
    assert.equal(url, AUTHORIZE_URL);
  });
});

describe("parseAuthStatus", () => {
  it("reads a signed-in subscription", () => {
    const res = parseAuthStatus(
      JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        email: "someone@example.test",
        orgId: "8e6be016-61f3-4138-b979-eb6ff8efa2ef",
        orgName: "NMS",
        subscriptionType: "team",
      }),
    );
    assert.equal(res.ok, true);
    assert.deepEqual(res.ok && res.value, {
      loggedIn: true,
      method: "claude.ai",
      email: "someone@example.test",
      organization: "NMS",
      plan: "team",
      apiKeySource: null,
      loginExpiresAt: null,
    });
  });

  it("reads a signed-out container", () => {
    const res = parseAuthStatus(
      '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}',
    );
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.value.loggedIn, false);
    assert.equal(res.ok && res.value.email, null);
  });

  /**
   * An `ANTHROPIC_API_KEY` in the environment reaches every work cycle, and the
   * CLI reports it as logged in with no identity at all. Carrying
   * `apiKeySource` through is what lets the page say which credential runs will
   * actually bill against, rather than showing a subscription nothing uses.
   */
  it("carries the API key source that outranks the login", () => {
    const res = parseAuthStatus(
      JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        apiKeySource: "ANTHROPIC_API_KEY",
        email: null,
        orgId: null,
        orgName: null,
        subscriptionType: null,
      }),
    );
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.value.apiKeySource, "ANTHROPIC_API_KEY");
    assert.equal(res.ok && res.value.email, null);
  });

  /**
   * `loginExpiresAt` is in the object for every credential and is a date only
   * for a stored claude.ai login (measured on 2.1.319): an API key, a helper and
   * `CLAUDE_CODE_OAUTH_TOKEN` answer `null` even with a stored login behind them.
   * A date is what a dashboard warning is made from, so reading it wrong in
   * either direction is silent: a wrong date warns for nothing or never warns.
   */
  it("reads the end of a stored sign-in as epoch ms", () => {
    const res = parseAuthStatus(
      JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        loginExpiresAt: "2026-12-08T20:06:50.145Z",
        subscriptionType: "max",
      }),
    );
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.value.loginExpiresAt, Date.UTC(2026, 11, 8, 20, 6, 50, 145));
  });

  it("treats a missing or null loginExpiresAt as unknown", () => {
    for (const status of [
      { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" },
      { loggedIn: true, authMethod: "claude.ai", loginExpiresAt: null },
      { loggedIn: true, authMethod: "api_key", loginExpiresAt: null, apiKeySource: "ANTHROPIC_API_KEY" },
      { loggedIn: true, authMethod: "api_key_helper", loginExpiresAt: null, apiKeySource: "apiKeyHelper" },
      { loggedIn: true, authMethod: "oauth_token", loginExpiresAt: null },
      { loggedIn: false, authMethod: "none", loginExpiresAt: null },
    ]) {
      const res = parseAuthStatus(JSON.stringify(status));
      assert.equal(res.ok, true, JSON.stringify(status));
      assert.equal(res.ok && res.value.loginExpiresAt, null, JSON.stringify(status));
    }
  });

  // The date is an addition to a status the panel needs whole: a CLI that
  // changes this one field's shape must not read as signed out or unreadable.
  it("treats a malformed loginExpiresAt as unknown and keeps the rest of the status", () => {
    for (const bad of ["soon", "", "2026-13-45", 1794168410139, {}, [], true]) {
      const res = parseAuthStatus(
        JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          email: "someone@example.test",
          loginExpiresAt: bad,
        }),
      );
      assert.equal(res.ok, true, JSON.stringify(bad));
      assert.equal(res.ok && res.value.loginExpiresAt, null, JSON.stringify(bad));
      assert.equal(res.ok && res.value.loggedIn, true, JSON.stringify(bad));
      assert.equal(res.ok && res.value.email, "someone@example.test", JSON.stringify(bad));
    }
  });

  it("parses past a warning line printed before the object", () => {
    const res = parseAuthStatus(
      'npm warn deprecated something\n{"loggedIn":false,"authMethod":"none"}',
    );
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.value.loggedIn, false);
  });

  /**
   * The silent-and-wrong-way case. A CLI that renames `loggedIn` must not read
   * as signed out — that is a Sign in button in front of somebody already
   * signed in, and a Sign out button they can no longer reach.
   */
  it("refuses a shape it does not recognise rather than reading it as signed out", () => {
    for (const raw of [
      '{"authenticated":true}',
      "{}",
      "null",
      "[]",
      "command not found: claude",
      "",
    ]) {
      const res = parseAuthStatus(raw);
      assert.equal(res.ok, false, `expected a refusal for ${JSON.stringify(raw)}`);
    }
  });
});

describe("normalizeCode", () => {
  it("accepts a pasted code with the whitespace a paste picks up", () => {
    const res = normalizeCode("  abc123#state-value\n");
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.value, "abc123#state-value");
  });

  /**
   * The CLI reads one line from stdin. A value with an interior newline would
   * answer this prompt and the next one, so it is refused rather than trimmed
   * to its first line — a paste that captured surrounding text is a mistake to
   * report, not one to silently reinterpret.
   */
  it("refuses a value carrying an interior newline", () => {
    assert.equal(normalizeCode("abc123\nyes").ok, false);
    assert.equal(normalizeCode("abc 123").ok, false);
  });

  it("refuses nothing, and refuses what cannot be a code", () => {
    assert.equal(normalizeCode("").ok, false);
    assert.equal(normalizeCode("   ").ok, false);
    assert.equal(normalizeCode(undefined).ok, false);
    assert.equal(normalizeCode(42).ok, false);
    assert.equal(normalizeCode("x".repeat(513)).ok, false);
  });
});

/** Captured before any test mocks the clock, so the stub still gets real time to print. */
const realSetTimeout = globalThis.setTimeout;
const realDelay = (ms: number) =>
  new Promise<void>((resolve) => realSetTimeout(resolve, ms));

function recordedPids(): number[] {
  return fs.readdirSync(pidsDir).map(Number);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Advance a mocked clock 100 ms at a time — the login's own poll interval —
 * with real time between steps for the stub to print, until `promise` settles.
 * Bounded inside the 30 s the login allows for its link.
 */
async function driveUntilSettled<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  for (let step = 0; !settled; step++) {
    assert.ok(step < 250, "the sign-in neither printed a link nor ended");
    await realDelay(20);
    if (!settled) mock.timers.tick(100);
  }
  return promise;
}

after(() => {
  cancelLogin();
  for (const pid of recordedPids()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone, which is what the tests want.
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** `PENDING_TIMEOUT_MS` in `claudeAuth.ts`. The last assertion below fails if it drifts. */
const PENDING_TIMEOUT_MS = 10 * 60_000;

/**
 * The one pending login is the bound this module rests on: the child holds the
 * PKCE verifier, so a second one is a process nothing can reach — not a code,
 * not Cancel, not Sign out — holding stdin open for as long as the server
 * lives. Two starts arriving together (two tabs, a script) used to both find
 * nothing to cancel, both spawn, and both store, the second overwriting the
 * first without killing it; and the first's still-armed timer later cancelled
 * whichever login was pending when it fired.
 *
 * Real subprocesses, for `settleOnExit`'s reason in `review.test.ts`: the fault
 * is a process left running, and nothing short of one shows it.
 */
describe("beginLogin, started twice at once", () => {
  it("leaves no child that cancelLogin cannot reach", async () => {
    const results = await Promise.all([beginLogin(), beginLogin()]);
    const pendingUrl = pendingLogin()?.url;

    cancelLogin();
    await realDelay(300);
    assert.ok(recordedPids().length >= 1, "no stub was ever started");
    assert.deepEqual(recordedPids().filter(alive), [], "a sign-in child outlived cancelLogin");

    // Only one link may be handed out: the other's verifier is gone, and a code
    // issued against it could never be redeemed.
    const handedOut = results.flatMap((r) => (r.ok ? [r.value.url] : []));
    assert.equal(handedOut.length, 1, `links handed out: ${JSON.stringify(results)}`);
    assert.equal(pendingUrl, handedOut[0]);
  });

  it("does not let a superseded login's timer cancel the live one", async () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
    try {
      const hold = path.join(tmp, "hold");
      const first = beginLogin();
      process.env.STUB_HOLD = hold;
      const second = beginLogin();
      delete process.env.STUB_HOLD;

      await driveUntilSettled(first);
      const firstSettledAt = Date.now();

      fs.writeFileSync(hold, "");
      const live = await driveUntilSettled(second);
      assert.ok(live.ok, JSON.stringify(live));
      const liveArmedAt = Date.now();
      // Without this the two would expire on the same tick and the first
      // assertion below could not tell them apart.
      assert.ok(liveArmedAt > firstSettledAt);

      // When the first start's own timer would be due, had it kept one.
      mock.timers.tick(firstSettledAt + PENDING_TIMEOUT_MS - Date.now());
      assert.equal(pendingLogin()?.url, live.value.url);

      // And the live login still expires on its own timer.
      mock.timers.tick(liveArmedAt + PENDING_TIMEOUT_MS - Date.now());
      assert.equal(pendingLogin(), null);
    } finally {
      cancelLogin();
      mock.timers.reset();
    }
  });
});

function pidOf(url: string): number {
  return Number(new URL(url).searchParams.get("state"));
}

/**
 * Every timer `setInterval` hands out while `run` is running, less the ones
 * cleared. Patched on `globalThis` because the leak is an interval nothing
 * holds a handle to, and that is the only place left to see it from.
 */
async function intervalsLeftBy(run: () => Promise<void>): Promise<number> {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const live = new Set<unknown>();
  const timers = globalThis as unknown as Record<"setInterval" | "clearInterval", unknown>;
  timers.setInterval = (...args: Parameters<typeof setInterval>) => {
    const handle = realSetInterval(...args);
    live.add(handle);
    return handle;
  };
  timers.clearInterval = (handle: Parameters<typeof clearInterval>[0]) => {
    live.delete(handle);
    realClearInterval(handle);
  };
  try {
    await run();
  } finally {
    timers.setInterval = realSetInterval;
    timers.clearInterval = realClearInterval;
    for (const handle of live) realClearInterval(handle as NodeJS.Timeout);
  }
  return live.size;
}

/**
 * The sign-in child is the one thing that knows whether a sign-in is still
 * alive, and this module used to act on its exit only inside a code submit: a
 * child that left on its own stayed "pending" for ten minutes behind a link
 * whose verifier was gone, and a submit ended by a kill left its rejection
 * poll firing every 100 ms for as long as the server lived.
 */
describe("the sign-in child's exit", () => {
  it("ends the pending login when the child leaves on its own", async () => {
    process.env.STUB_EXIT_AFTER_LINK = "1";
    const started = await beginLogin();
    delete process.env.STUB_EXIT_AFTER_LINK;
    try {
      assert.ok(started.ok, JSON.stringify(started));
      await realDelay(1000);
      assert.equal(alive(pidOf(started.value.url)), false, "the stub never left");
      assert.equal(pendingLogin(), null);
    } finally {
      cancelLogin();
    }
  });

  it("stops polling for a rejection once a cancel has ended the submit", async () => {
    const left = await intervalsLeftBy(async () => {
      const started = await beginLogin();
      assert.ok(started.ok, JSON.stringify(started));
      // The stub reads the code and says nothing, so only the cancel ends it.
      const submit = submitCode("code-whatever", started.value.loginId);
      await realDelay(300);
      cancelLogin();
      const outcome = await submit;
      assert.equal(outcome.ok, false);
    });
    assert.equal(left, 0, "an interval outlived the submit it was polling for");
  });
});

/**
 * A second start kills the first child and mints a new verifier, so a code
 * from the first link can be redeemed by nothing. Written to whichever child
 * was pending, it was spent on the newer sign-in's one exchange, which failed
 * on the mismatch and ended that sign-in too — both dead, and the error about
 * the one the operator was not using.
 */
describe("a code pasted from a superseded sign-in link", () => {
  it("is refused before any child reads it, and the newer sign-in stays live", async () => {
    process.env.STUB_EXCHANGE = "1";
    try {
      const first = await beginLogin();
      const second = await beginLogin();
      assert.ok(first.ok && second.ok, JSON.stringify([first, second]));
      const firstPid = pidOf(first.value.url);
      const secondPid = pidOf(second.value.url);

      const outcome = await submitCode(`code-${firstPid}`, first.value.loginId);
      const received = fs.existsSync(receivedLog) ? fs.readFileSync(receivedLog, "utf8") : "";
      assert.ok(
        !received.includes(`${secondPid} got`),
        `the newer sign-in's child was handed the stale link's code: ${received}`,
      );
      assert.equal(!outcome.ok && outcome.stillPending, true, JSON.stringify(outcome));
      assert.equal(pendingLogin()?.url, second.value.url);

      // And its own code still redeems it.
      const live = await submitCode(`code-${secondPid}`, second.value.loginId);
      assert.ok(live.ok, JSON.stringify(live));
    } finally {
      delete process.env.STUB_EXCHANGE;
      cancelLogin();
    }
  });
});

/**
 * A planted `$CLAUDE_CONFIG_DIR/settings.json` whose `env` names a proxy is
 * applied to the sign-in's own requests unless the child is told otherwise:
 * on 2.1.310 the token exchange of `auth login` went to the proxy, authorization
 * code and PKCE verifier in the body, and `auth logout` sent three CONNECTs to
 * it. Nothing but the argv tells the CLI to ignore the file, and a stub that
 * ignores its argv cannot show a missing flag, so these read what the child
 * was started with.
 *
 * The flags lead the argv because the CLI exits 1 with `unknown option` for
 * either one placed after `auth <subcommand>`. `auth status` takes the pins
 * rather than dropping the file: it answers for the credential runs get, and a
 * work cycle loads a user-scope `ANTHROPIC_API_KEY` that `--setting-sources ""`
 * would hide from it.
 */
describe("the settings flags an auth child starts with", () => {
  const SEPARATOR = "\u001f";

  function startsRecorded(subcommand: string): string[][] {
    const text = fs.existsSync(argvLog) ? fs.readFileSync(argvLog, "utf8") : "";
    return text
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.split(SEPARATOR).slice(0, -1))
      .filter((argv) => argv.includes(subcommand));
  }

  it("keeps a sign-in out of every settings file", async () => {
    fs.rmSync(argvLog, { force: true });
    const started = await beginLogin();
    try {
      assert.ok(started.ok, JSON.stringify(started));
      assert.deepEqual(startsRecorded("login"), [["--setting-sources", "", "auth", "login"]]);
    } finally {
      cancelLogin();
    }
  });

  it("keeps a sign-out out of every settings file", async () => {
    fs.rmSync(argvLog, { force: true });
    await signOut();
    assert.deepEqual(startsRecorded("logout"), [["--setting-sources", "", "auth", "logout"]]);
  });

  it("pins the status read's endpoint variables to the ones the server was started with", async () => {
    fs.rmSync(argvLog, { force: true });
    process.env.HTTPS_PROXY = "http://server-proxy.test:3128";
    delete process.env.ANTHROPIC_BASE_URL;
    try {
      await readAuthStatus();
    } finally {
      delete process.env.HTTPS_PROXY;
    }
    const [argv] = startsRecorded("status");
    assert.ok(argv, "no status child was started");
    assert.deepEqual([argv[0], argv[2], argv[3], argv[4]], ["--settings", "auth", "status", "--json"]);
    assert.equal(argv.length, 5);
    const overlay = JSON.parse(argv[1]) as { env: Record<string, string> };
    assert.deepEqual([...Object.keys(overlay.env)].sort(), [...PINNED_CYCLE_ENV].sort());
    assert.equal(overlay.env.HTTPS_PROXY, "http://server-proxy.test:3128");
    // A variable the server does not set is pinned to "", which is what stops
    // the planted file's value from standing.
    assert.equal(overlay.env.ANTHROPIC_BASE_URL, "");
  });

  // A user-file helper otherwise answers the read as signed in, as
  // `api_key_helper`, a credential no work cycle uses any more; `null` would not
  // stop it, and a second --settings would replace the pins.
  it("empties apiKeyHelper in the status read's one --settings", async () => {
    fs.rmSync(argvLog, { force: true });
    await readAuthStatus();
    const [argv] = startsRecorded("status");
    assert.ok(argv, "no status child was started");
    assert.equal(argv.filter((arg) => arg === "--settings").length, 1);
    const overlay = JSON.parse(argv[argv.indexOf("--settings") + 1]) as Record<string, unknown>;
    assert.deepEqual(Object.keys(overlay).sort(), ["apiKeyHelper", "env"]);
    assert.equal(overlay.apiKeyHelper, "");
  });
});

/**
 * The warning starts ten days out, inclusive, and a date at or before now is
 * "ended" rather than a negative count. Both edges move silently: an exclusive
 * boundary warns a day late on the one day that matters, and a past date read
 * as "ok" is the lapsed login the whole notice exists to catch.
 */
describe("loginExpiry", () => {
  const DAY = 86_400_000;
  const now = Date.UTC(2026, 10, 8, 12);

  it("is unknown, and so says nothing, without a date", () => {
    assert.equal(loginExpiry(null, now), null);
  });

  it("warns from exactly ten days out and not an instant before", () => {
    assert.equal(loginExpiry(now + 10 * DAY + 1, now)?.state, "ok");
    assert.deepEqual(loginExpiry(now + 10 * DAY, now), {
      state: "soon",
      endsAt: now + 10 * DAY,
      daysLeft: 10,
    });
  });

  it("rounds a part day up and calls a date at or before now ended", () => {
    assert.equal(loginExpiry(now + 1, now)?.daysLeft, 1);
    assert.equal(loginExpiry(now, now)?.state, "ended");
    assert.deepEqual(loginExpiry(now - 3 * DAY, now), {
      state: "ended",
      endsAt: now - 3 * DAY,
      daysLeft: 0,
    });
  });

  it("words a notice only for a sign-in that is ending or ended", () => {
    const far = loginExpiry(now + 30 * DAY, now);
    assert.ok(far);
    assert.equal(loginExpiryMessage(far), null);
    const soon = loginExpiry(now + 5 * DAY, now);
    assert.ok(soon);
    assert.match(loginExpiryMessage(soon) ?? "", /ends 2026-11-13 \(in 5 days\)/);
    const ended = loginExpiry(now - DAY, now);
    assert.ok(ended);
    assert.match(loginExpiryMessage(ended) ?? "", /ended 2026-11-07/);
  });
});

/**
 * What the dashboard's poll costs. The poll is every few seconds and a status
 * read is a spawned process, so the failure here is not a wrong answer but a
 * `claude` child per poll — nothing on the page would show it.
 */
describe("loginExpiryProblems", () => {
  const DAY = 86_400_000;
  const TTL = 10 * 60_000;
  const held = globalThis as typeof globalThis & { __ufClaudeLoginEndsAt?: unknown };

  function statusSpawns(): number {
    const text = fs.existsSync(argvLog) ? fs.readFileSync(argvLog, "utf8") : "";
    return text.split("\n").filter((line) => line.includes("\u001fstatus\u001f")).length;
  }

  it("answers without waiting, then reads the date once and warns from it", async () => {
    const now = Date.now();
    fs.rmSync(argvLog, { force: true });
    delete held.__ufClaudeLoginEndsAt;
    process.env.STUB_STATUS = JSON.stringify({
      loggedIn: true,
      authMethod: "claude.ai",
      loginExpiresAt: new Date(now + 5 * DAY).toISOString(),
    });
    try {
      // Nothing held yet: no warning, and the read it started is not awaited.
      assert.deepEqual(loginExpiryProblems(now), []);
      assert.deepEqual(loginExpiryProblems(now), []);
      await readAuthStatus();
      assert.equal(statusSpawns(), 1, "polls before the read finished must share one child");

      const [problem, ...rest] = loginExpiryProblems(now);
      assert.deepEqual(rest, []);
      assert.equal(problem.severity, "warn");
      assert.equal(problem.variable, "Claude account");
      assert.match(problem.message, /sign-in ends .* \(in 5 days\)/);
      assert.equal(statusSpawns(), 1, "a fresh answer starts no read");
    } finally {
      delete process.env.STUB_STATUS;
      delete held.__ufClaudeLoginEndsAt;
    }
  });

  it("asks a CLI that cannot answer once per interval, not once per poll", async () => {
    const now = Date.now();
    const slot = globalThis as typeof globalThis & { __ufClaudeAuthRead?: Promise<unknown> | null };
    fs.rmSync(argvLog, { force: true });
    delete held.__ufClaudeLoginEndsAt;
    try {
      // The stub prints a login link for `status`, which is not a status.
      for (let i = 0; i < 5; i++) assert.deepEqual(loginExpiryProblems(now + i), []);
      await readAuthStatus();
      assert.equal(statusSpawns(), 1);

      // A read in flight is what a started spawn looks like from here, and it
      // is visible the moment `loginExpiryProblems` returns.
      assert.deepEqual(loginExpiryProblems(now + TTL - 1), []);
      assert.ok(!slot.__ufClaudeAuthRead, "inside the interval no read may start");

      assert.deepEqual(loginExpiryProblems(now + TTL), []);
      assert.ok(slot.__ufClaudeAuthRead, "an interval later it asks again");
      await slot.__ufClaudeAuthRead;
      assert.equal(statusSpawns(), 2);
    } finally {
      delete held.__ufClaudeLoginEndsAt;
    }
  });
});
