import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  extractDeviceLogin,
  normalizeApiKey,
  parseCodexStatus,
  redactSecrets,
} from "./codexAuth";

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
