import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it, mock } from "node:test";

/**
 * `claudeAuth.test.ts`'s arrangement: `config.ts` fixes `CODEX_BIN` and
 * `CODEX_HOME` at module load, so the stub is named before anything is
 * required, and the assertion after the require refuses to go on if a real
 * `codex login --device-auth` could be what `beginLogin` spawns.
 *
 * The stub records its pid and prints a link and a one-time code carrying it,
 * then polls the way the real CLI does — by sitting there, since `beginLogin`
 * closes its stdin. `STUB_HOLD`, read at spawn time, makes it wait for that file
 * before printing. Every start appends its arguments to `argv.log`, one start
 * per line split on `\u001f`. Started as `app-server` it exits before
 * answering; past any leading `-c` pairs, `login status`, `login
 * --with-api-key` and `logout` answer as a signed-out CLI does and exit. Over
 * a `$CODEX_HOME/config.toml` that starts `[[[`, every command past the pairs
 * prints the line 0.153.4 printed over one and exits 1.
 */
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-codex-auth-")));
const pidsDir = path.join(tmp, "pids");
fs.mkdirSync(pidsDir);
const argvLog = path.join(tmp, "argv.log");
const stub = path.join(tmp, "codex");
fs.writeFileSync(
  stub,
  [
    "#!/bin/sh",
    `printf '%s\\037' "$@" >> "${argvLog}"; echo >> "${argvLog}"`,
    'if [ "$1" = app-server ]; then exit 0; fi',
    'while [ "$1" = -c ]; do shift 2; done',
    `if [ "$(head -c 3 "$CODEX_HOME/config.toml" 2>/dev/null)" = '[[[' ]; then`,
    "  printf 'Error loading configuration: %s/config.toml:1:3: unquoted keys cannot be empty, expected letters, numbers, `-`, `_`\\n' \"$CODEX_HOME\"; exit 1",
    "fi",
    'if [ "$1 $2" = "login status" ]; then echo "Not logged in"; exit 1; fi',
    'if [ "$1 $2" = "login --with-api-key" ]; then read -r line; exit 0; fi',
    'if [ "$1" = logout ]; then echo "Not logged in"; exit 0; fi',
    `echo $$ > "${pidsDir}/$$"`,
    'if [ -n "$STUB_HOLD" ]; then while [ ! -e "$STUB_HOLD" ]; do sleep 0.02; done; fi',
    "echo '1. Open this link in your browser and sign in to your account'",
    "echo '   https://auth.openai.com/codex/device'",
    "echo '2. Enter this one-time code'",
    "printf '   CODE-%06d\\n' $(($$ % 1000000))",
    "exec sleep 600",
    "",
  ].join("\n"),
  { mode: 0o755 },
);

process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude-home");
process.env.WORKSPACE_ROOT = path.join(tmp, "workspace");
delete process.env.WORKSPACE_ROOTS;
process.env.CODEX_HOME = path.join(tmp, "codex-home");
process.env.CODEX_BIN = stub;

const config = require("./config") as typeof import("./config");
assert.equal(
  config.CODEX_BIN,
  stub,
  "config was loaded before the stub was named — refusing to spawn a real `codex login`",
);

const {
  beginLogin,
  cancelLogin,
  extractDeviceLogin,
  lastLoginFailure,
  normalizeApiKey,
  parseCodexStatus,
  pendingLogin,
  readAuthStatus,
  redactSecrets,
  signOut,
  submitApiKey,
} = require("./codexAuth") as typeof import("./codexAuth");
const { listCodexModels } = require("./codexAccount") as typeof import("./codexAccount");

/**
 * `claudeAuth.test.ts`'s argument for the other provider, with one addition it
 * does not have to make.
 *
 * Three of these read another program's console output, captured from
 * `codex-cli 0.153.4` in this image rather than from any spec, and each fails
 * silently: a device pair this cannot find is a Sign in button that opens
 * nothing; a status line that stops parsing is an install reported as *signed
 * out* by a panel whose Sign in button then deletes the credential it already
 * had, since a Codex device flow clears the stored login the moment it starts.
 *
 * The addition is `redactSecrets`, and it earns a test on both directions at
 * once. Too loose and the CLI's own masked hint — the only thing telling two
 * API-key installs apart — is blanked out of the page; too tight and a future
 * CLI that echoes a key writes it into an HTTP body. There is no error either
 * way and nothing on the page that looks wrong.
 */

/**
 * `codex login --device-auth`, stdout, pipes, with `NO_COLOR=1` and
 * `FORCE_COLOR=0` set — measured, and the colour is there anyway, which is why
 * the escapes are in this fixture rather than assumed away.
 */
const DEVICE_PIPED = [
  "",
  "Welcome to Codex [v\u001B[90m0.153.4\u001B[0m]",
  "\u001B[90mOpenAI's command-line coding agent\u001B[0m",
  "",
  "Follow these steps to sign in with ChatGPT using device code authorization:",
  "",
  "1. Open this link in your browser and sign in to your account",
  "   \u001B[94mhttps://auth.openai.com/codex/device\u001B[0m",
  "",
  "2. Enter this one-time code \u001B[90m(expires in 15 minutes)\u001B[0m",
  "   \u001B[94mW0B1-99ZLZ\u001B[0m",
  "",
  "\u001B[90mContinue only if you started this login in Codex. If a website or another person gave you this code, cancel.\u001B[0m",
  "",
].join("\n");

/**
 * Every run of the CLI in this container prints this first, on stderr, because
 * it cannot write helper binaries into a read-only path. It is captured into the
 * same buffer as stdout, so every parser here has to read past it.
 */
const PATH_WARNING =
  'WARNING: proceeding, even though we could not create PATH aliases: Read-only file system (os error 30)';

describe("extractDeviceLogin", () => {
  it("finds the link and the code in what the CLI prints", () => {
    assert.deepEqual(extractDeviceLogin(DEVICE_PIPED), {
      url: "https://auth.openai.com/codex/device",
      code: "W0B1-99ZLZ",
    });
  });

  it("reads past the PATH warning the container always prints", () => {
    const found = extractDeviceLogin(`${PATH_WARNING}\n${DEVICE_PIPED}`);
    assert.equal(found?.code, "W0B1-99ZLZ");
  });

  it("returns nothing until the code has arrived", () => {
    // The banner and the link land in one write and the code in the next, so a
    // poll that accepted the link alone would open a sheet with no code in it —
    // a link the operator opens, on a page that asks for something the app has
    // not shown them.
    const half = DEVICE_PIPED.slice(
      0,
      DEVICE_PIPED.indexOf("2. Enter this one-time code"),
    );
    assert.equal(extractDeviceLogin(half), null);
  });

  it("refuses a link that is not OpenAI's", () => {
    const spoofed = DEVICE_PIPED.replace(
      "https://auth.openai.com/codex/device",
      "https://auth.openai.com.attacker.example/codex/device",
    );
    assert.equal(extractDeviceLogin(spoofed), null);
  });

  it("takes the code from after the link, not from the banner above it", () => {
    // A version whose header carries a code-shaped token — a build id, a plan
    // name — would otherwise hand the operator that to type into OpenAI, and
    // nothing downstream can tell a wrong code from a right one.
    const noisy = DEVICE_PIPED.replace(
      "Welcome to Codex",
      "Welcome to Codex BUILD-2Z9QX",
    );
    assert.equal(extractDeviceLogin(noisy)?.code, "W0B1-99ZLZ");
  });

  it("finds nothing in output that carries no link at all", () => {
    assert.equal(extractDeviceLogin("error: connection refused"), null);
  });
});

describe("parseCodexStatus", () => {
  it("reads a signed-out install", () => {
    // Exit 1, which is why nothing here is gated on the exit code: the error
    // case below exits 1 too.
    assert.deepEqual(parseCodexStatus(`${PATH_WARNING}\nNot logged in\n`), {
      ok: true,
      value: { loggedIn: false, method: null, apiKeyHint: null },
    });
  });

  it("reads a subscription login", () => {
    assert.deepEqual(
      parseCodexStatus(`${PATH_WARNING}\nLogged in using ChatGPT\n`),
      {
        ok: true,
        value: { loggedIn: true, method: "chatgpt", apiKeyHint: null },
      },
    );
  });

  it("reads an API-key login and keeps the CLI's own mask", () => {
    assert.deepEqual(
      parseCodexStatus(
        `${PATH_WARNING}\nLogged in using an API key - sk-proj-***67890\n`,
      ),
      {
        ok: true,
        value: {
          loggedIn: true,
          method: "apikey",
          apiKeyHint: "sk-proj-***67890",
        },
      },
    );
  });

  it("does not report an unreadable credential as signed out", () => {
    // The whole reason this is a result union. Both of these exit 1, and
    // collapsing them puts a Sign in button — which deletes the stored
    // credential the moment it is pressed — in front of somebody whose problem
    // is a corrupt auth.json.
    const res = parseCodexStatus(
      `${PATH_WARNING}\nError checking login status: invalid ID token format at line 1 column 269\n`,
    );
    assert.equal(res.ok, false);
    assert.match(res.ok ? "" : res.error, /invalid ID token format/);
  });

  it("quotes the CLI rather than the warning every run prints", () => {
    const res = parseCodexStatus(`${PATH_WARNING}\nsomething unexpected\n`);
    assert.equal(res.ok, false);
    assert.match(res.ok ? "" : res.error, /something unexpected/);
    assert.doesNotMatch(res.ok ? "x" : res.error, /PATH aliases/);
  });

  it("says the CLI answered nothing rather than inventing a state", () => {
    const res = parseCodexStatus("");
    assert.equal(res.ok, false);
    assert.match(res.ok ? "" : res.error, /answered nothing/);
  });
});

describe("normalizeApiKey", () => {
  it("accepts a pasted key with the whitespace a paste picks up", () => {
    assert.deepEqual(normalizeApiKey("  sk-proj-abc123  \n"), {
      ok: true,
      value: "sk-proj-abc123",
    });
  });

  it("refuses a value carrying a line break", () => {
    // The CLI reads exactly one line from stdin, so an embedded newline presents
    // the first half as the key and leaves the rest in the pipe.
    const res = normalizeApiKey("sk-proj-abc\n123");
    assert.equal(res.ok, false);
  });

  it("refuses a blank paste", () => {
    assert.equal(normalizeApiKey("   ").ok, false);
    assert.equal(normalizeApiKey("").ok, false);
  });

  it("refuses something that is not a string", () => {
    assert.equal(normalizeApiKey(undefined).ok, false);
    assert.equal(normalizeApiKey(42).ok, false);
  });

  it("never quotes the value back in a refusal", () => {
    // An error message is the one part of a failed request that gets kept.
    for (const bad of ["sk-proj-secret value", "sk-proj-secret\nvalue"]) {
      const res = normalizeApiKey(bad);
      assert.equal(res.ok, false);
      assert.doesNotMatch(res.ok ? "" : res.error, /secret/);
    }
  });
});

describe("redactSecrets", () => {
  it("blanks a whole key", () => {
    assert.equal(
      redactSecrets("stored sk-proj-WITHNEWLINE99999 ok"),
      "stored sk-[redacted] ok",
    );
  });

  it("leaves the CLI's own mask readable", () => {
    // The hint is the only thing distinguishing two API-key installs on the
    // page, and a redaction that swallowed it would be silent: the row would
    // still render, saying less than it did.
    const line = "Logged in using an API key - sk-proj-***67890";
    assert.equal(redactSecrets(line), line);
  });
});

/** Captured before any test mocks the clock, so the stub still gets real time to print. */
const realSetTimeout = globalThis.setTimeout;
const realDelay = (ms: number) =>
  new Promise<void>((resolve) => realSetTimeout(resolve, ms));

function recordedPids(): number[] {
  return fs.readdirSync(pidsDir).map(Number);
}

/** Every start the stub logged since `argv.log` was last removed, one array each. */
function loggedStarts(): string[][] {
  return fs
    .readFileSync(argvLog, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split("\u001f").slice(0, -1));
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
 * Bounded inside the 30 s the login allows for its link and code.
 */
async function driveUntilSettled<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  for (let step = 0; !settled; step++) {
    assert.ok(step < 250, "the sign-in neither printed a link and code nor ended");
    await realDelay(20);
    if (!settled) mock.timers.tick(100);
  }
  return promise;
}

/** `SIGN_IN_CONFIG_PINS` in `codexAuth.ts`, which the app server carries too. */
const SIGN_IN_PINS = [
  "-c",
  'cli_auth_credentials_store="file"',
  "-c",
  "forced_chatgpt_workspace_id=[]",
];

/**
 * `claudeAuth.test.ts`'s `the settings flags an auth child starts with`, for
 * the one Codex child a planted `$CODEX_HOME/config.toml` was measured to
 * steer: `codexAccount.ts`'s app server, which sent the stored ChatGPT bearer
 * wherever the file's `chatgpt_base_url`, `openai_base_url` or
 * `model_provider` pointed, and started `git` against the host a planted
 * `[marketplaces.*]` named. Drop an override and every read still works and
 * the stub's output is the same, so only the argv shows it. The exact array is
 * asserted because each value is the one measured to send the child where the
 * unplanted CLI sends it, and a changed value is a new measurement.
 */
describe("the config overrides the app-server child starts with", () => {
  it("pins every key a planted config.toml was measured to move traffic with", async () => {
    fs.mkdirSync(config.CODEX_HOME, { recursive: true });
    fs.writeFileSync(path.join(config.CODEX_HOME, "auth.json"), "{}");
    fs.rmSync(argvLog, { force: true });
    try {
      const read = await listCodexModels();
      assert.equal(read.ok, false, "the stub exits before answering, so the read must fail");
    } finally {
      fs.rmSync(path.join(config.CODEX_HOME, "auth.json"), { force: true });
    }
    assert.deepEqual(loggedStarts(), [
      [
        "app-server",
        "-c",
        'chatgpt_base_url="https://chatgpt.com/backend-api/"',
        "-c",
        'openai_base_url=""',
        "-c",
        'model_provider="openai"',
        "-c",
        'otel.exporter="none"',
        "-c",
        'otel.trace_exporter="none"',
        "-c",
        'otel.metrics_exporter="none"',
        "-c",
        "features.plugins=false",
        ...SIGN_IN_PINS,
      ],
    ]);
  });
});

/**
 * The same case for the four sign-in children, whose file keys deny or lose a
 * sign-in rather than move a connection: a planted `"ephemeral"` store let a
 * login answer `Successfully logged in` and save nothing, and a planted
 * workspace read a stored login as signed out. Without the pins the stub
 * answers identically, so again only the argv shows it. The pins lead, ahead
 * of the subcommand, because that is the position measured.
 */
describe("the config overrides every sign-in child starts with", () => {
  it("leads status, both logins and logout with the sign-in pins", async () => {
    fs.rmSync(argvLog, { force: true });
    try {
      await readAuthStatus();
      await submitApiKey("sk-proj-fakefakefakefake");
      await signOut();
      const login = await beginLogin();
      assert.ok(login.ok, JSON.stringify(login));
    } finally {
      cancelLogin();
    }
    assert.deepEqual(loggedStarts(), [
      [...SIGN_IN_PINS, "login", "status"],
      [...SIGN_IN_PINS, "login", "--with-api-key"],
      [...SIGN_IN_PINS, "login", "status"],
      [...SIGN_IN_PINS, "logout"],
      [...SIGN_IN_PINS, "login", "status"],
      [...SIGN_IN_PINS, "login", "--device-auth"],
    ]);
  });
});

/**
 * Any work cycle can put a directory at `$CODEX_HOME/config.toml`, and on
 * 0.153.4 every one of these children then exited 1 with `Error loading
 * configuration: … is not a file`, the sign-out and the device login
 * included, which is all the panel had to quote. The stub never reads the
 * file, so what shows the check is that nothing was started and every answer
 * names the path.
 */
describe("a directory at config.toml", () => {
  it("is named by status, both sign-ins and the sign-out, and none of them starts a child", async () => {
    const file = path.join(config.CODEX_HOME, "config.toml");
    fs.mkdirSync(file, { recursive: true });
    fs.rmSync(argvLog, { force: true });
    try {
      const answers = [
        await readAuthStatus(),
        await submitApiKey("sk-proj-fakefakefakefake"),
        await signOut(),
        await beginLogin(),
      ];
      for (const answer of answers) {
        assert.equal(answer.ok, false, JSON.stringify(answer));
        const error = answer.ok ? "" : answer.error;
        assert.equal(error.includes(`${file} is a directory`), true, error);
      }
      assert.equal(fs.existsSync(argvLog), false, "a child was started over it");
    } finally {
      cancelLogin();
      fs.rmdirSync(file);
    }
  });
});

/**
 * Board task `93f1c142`: a regular `config.toml` Codex cannot parse or read
 * passes the check above, and on 0.153.4 each child then exited 1 with one
 * `Error loading configuration: …:1:3: unquoted keys cannot be empty…` or
 * `… Permission denied (os error 13)` line, which is all the panel had to
 * quote.
 */
describe("a config.toml Codex cannot parse or read", () => {
  const file = () => path.join(config.CODEX_HOME, "config.toml");

  it("is named in a sentence by status and the sign-out, not in the CLI's words", async () => {
    fs.mkdirSync(config.CODEX_HOME, { recursive: true });
    fs.writeFileSync(file(), "[[[ not toml\n");
    try {
      for (const answer of [await readAuthStatus(), await signOut()]) {
        assert.equal(answer.ok, false, JSON.stringify(answer));
        const error = answer.ok ? "" : answer.error;
        assert.match(error, /^Codex cannot load its configuration \(/);
        assert.equal(error.includes(`${file()}:1:3: unquoted keys cannot be empty`), true, error);
        assert.match(error, /work cycles each write a config\.toml of their own/);
      }
    } finally {
      fs.rmSync(file(), { force: true });
    }
  });

  it(
    "names one this uid cannot read without starting a child",
    { skip: process.getuid?.() === 0 ? "root reads any file" : false },
    async () => {
      fs.mkdirSync(config.CODEX_HOME, { recursive: true });
      fs.writeFileSync(file(), "");
      fs.chmodSync(file(), 0o000);
      fs.rmSync(argvLog, { force: true });
      try {
        const answer = await readAuthStatus();
        const error = answer.ok ? "" : answer.error;
        assert.equal(error.includes(`${file()} cannot be read by this server's uid`), true, error);
        assert.equal(fs.existsSync(argvLog), false, "a child was started over it");
      } finally {
        fs.rmSync(file(), { force: true });
      }
    },
  );
});

/** `PENDING_TIMEOUT_MS` in `codexAuth.ts`. The last assertions below fail if it drifts. */
const PENDING_TIMEOUT_MS = 16 * 60_000;

/**
 * `claudeAuth.test.ts`'s case for the device flow, where the orphan is worse:
 * a child nothing can reach is still polling OpenAI, and if somebody approves
 * its code it writes `auth.json` behind whatever this app last showed. The
 * superseded login's timer also wrote "not approved in time" over the live
 * flow as it killed it.
 */
describe("beginLogin, started twice at once", () => {
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

  it("leaves no child that cancelLogin cannot reach", async () => {
    const results = await Promise.all([beginLogin(), beginLogin()]);
    const pendingCode = pendingLogin()?.code;

    cancelLogin();
    await realDelay(300);
    assert.ok(recordedPids().length >= 1, "no stub was ever started");
    assert.deepEqual(recordedPids().filter(alive), [], "a sign-in child outlived cancelLogin");

    // Only one code may be handed out: the child behind the other is gone, so
    // approving it in the browser would sign nothing in.
    const handedOut = results.flatMap((r) => (r.ok ? [r.value.code] : []));
    assert.equal(handedOut.length, 1, `codes handed out: ${JSON.stringify(results)}`);
    assert.equal(pendingCode, handedOut[0]);
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
      // Without this the two would expire on the same tick and the assertions
      // below could not tell them apart.
      assert.ok(liveArmedAt > firstSettledAt);

      // When the first start's own timer would be due, had it kept one.
      mock.timers.tick(firstSettledAt + PENDING_TIMEOUT_MS - Date.now());
      assert.equal(pendingLogin()?.code, live.value.code);
      assert.equal(lastLoginFailure(), null);

      // And the live login still expires on its own timer, saying so.
      mock.timers.tick(liveArmedAt + PENDING_TIMEOUT_MS - Date.now());
      assert.equal(pendingLogin(), null);
      assert.match(lastLoginFailure() ?? "", /not approved in time/);
    } finally {
      cancelLogin();
      mock.timers.reset();
    }
  });
});
