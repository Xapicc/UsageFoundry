import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * The local provider's sign-in form and the environment a local cycle gets.
 *
 * `localCycleEnv` is the one place a local cycle stops being a Claude cycle,
 * and both of its failures are silent. Leave `ANTHROPIC_BASE_URL` alone and the
 * cycle goes to winnow's proxy and on to Anthropic; leave an Anthropic
 * credential in place — or leave `ANTHROPIC_AUTH_TOKEN` unset, so the CLI falls
 * back to the OAuth login — and the operator's subscription credential is sent
 * to whatever server the base URL names. Neither throws, and the first looks
 * like a local run that happens to be very good.
 *
 * The probe is pinned on what it must refuse: a server that answers the model
 * list and not `/v1/messages` is the common OpenAI-only case, and a sign-in
 * that accepted it would fail every cycle of every run started on it.
 *
 * Its own `DATA_DIR` before the first import, `runOrigin.test.ts`'s reason:
 * `localProvider.ts` imports `db.ts`, and `config.ts` is read at load.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-local-provider-")));
process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");

let mod: typeof import("./localProvider");

before(async () => {
  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );
  mod = await import("./localProvider");
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("parseLocalSignIn", () => {
  it("keeps a LAN address and drops a trailing slash", () => {
    const res = mod.parseLocalSignIn({
      baseUrl: " http://192.168.0.190:1234/ ",
      model: "qwen3-coder-30b",
      token: "",
    });
    assert.deepEqual(res, {
      ok: true,
      value: { baseUrl: "http://192.168.0.190:1234", token: null, model: "qwen3-coder-30b" },
    });
  });

  it("refuses a base URL Claude Code would append a second /v1 to", () => {
    const res = mod.parseLocalSignIn({ baseUrl: "http://host:1234/v1/", model: "m" });
    assert.equal(res.ok, false);
    assert.match(res.ok ? "" : res.error, /Leave \/v1 off/);
  });

  it("refuses a credential in the URL, another scheme, and a query string", () => {
    for (const baseUrl of [
      "http://user:secret@host:1234",
      "ftp://host",
      "http://host:1234?key=x",
      "not a url",
      "",
    ]) {
      assert.equal(mod.parseLocalSignIn({ baseUrl, model: "m" }).ok, false, baseUrl);
    }
  });

  it("refuses a model id that would not survive argv", () => {
    for (const model of ["", "--dangerously-skip-permissions", "two words", "a\nb"]) {
      assert.equal(mod.parseLocalSignIn({ baseUrl: "http://h", model }).ok, false, model);
    }
  });
});

describe("localCycleEnv", () => {
  const claudeCycle: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    PATH: "/usr/bin",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:8789",
    ANTHROPIC_API_KEY: "sk-ant-account-key",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
    ANTHROPIC_CUSTOM_HEADERS: "x-gateway-key: secret",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:3000/api/otlp",
    CLAUDE_CONFIG_DIR: "/home/node/.claude",
  };

  it("points the cycle at the local server, past winnow's proxy", () => {
    const env = mod.localCycleEnv(
      claudeCycle,
      { baseUrl: "http://192.168.0.190:1234", token: "lm-studio" },
      "qwen3",
      "/home/node/.claude-local",
    );
    assert.equal(env.ANTHROPIC_BASE_URL, "http://192.168.0.190:1234");
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "lm-studio");
    assert.equal(env.CLAUDE_CONFIG_DIR, "/home/node/.claude-local");
    assert.equal(env.PATH, "/usr/bin");
  });

  it("carries no Anthropic credential and no route around the base URL", () => {
    const env = mod.localCycleEnv(claudeCycle, { baseUrl: "http://h", token: "t" }, "m", "/c");
    for (const key of [
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_CUSTOM_HEADERS",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_ENABLE_TELEMETRY",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
    ]) {
      assert.equal(env[key], undefined, key);
    }
  });

  it("turns off the tool search winnow switched on, whose references a local server rejects", () => {
    const env = mod.localCycleEnv(
      { ...claudeCycle, ENABLE_TOOL_SEARCH: "1" },
      { baseUrl: "http://h", token: "t" },
      "m",
      "/c",
    );
    assert.equal(env.ENABLE_TOOL_SEARCH, "false");
  });

  it("sets a token even when the server wants none, so the OAuth login is never the fallback", () => {
    const env = mod.localCycleEnv(claudeCycle, { baseUrl: "http://h", token: null }, "m", "/c");
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, mod.LOCAL_TOKEN_PLACEHOLDER);
  });

  it("names the local model for every role Claude Code picks a model for", () => {
    const env = mod.localCycleEnv(claudeCycle, { baseUrl: "http://h", token: "t" }, "qwen3", "/c");
    for (const key of [
      "ANTHROPIC_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_SMALL_FAST_MODEL",
      "CLAUDE_CODE_SUBAGENT_MODEL",
    ]) {
      assert.equal(env[key], "qwen3", key);
    }
  });

  it("leaves the Claude cycle's own environment untouched", () => {
    mod.localCycleEnv(claudeCycle, { baseUrl: "http://h", token: "t" }, "m", "/c");
    assert.equal(claudeCycle.ANTHROPIC_API_KEY, "sk-ant-account-key");
    assert.equal(claudeCycle.ANTHROPIC_BASE_URL, "http://127.0.0.1:8789");
  });
});

describe("probeLocalEndpoint", () => {
  const signIn = { baseUrl: "http://h:1234", token: "tok", model: "m" };
  const answering =
    (status: number, body: string, seen?: { url?: string; auth?: string | null }) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      if (seen) {
        seen.url = String(url);
        seen.auth = new Headers(init?.headers).get("authorization");
      }
      return new Response(body, { status });
    }) as typeof fetch;

  it("accepts an Anthropic message from /v1/messages, asked the way a cycle asks", async () => {
    const seen: { url?: string; auth?: string | null } = {};
    const res = await mod.probeLocalEndpoint(
      signIn,
      answering(200, JSON.stringify({ type: "message", content: [] }), seen),
    );
    assert.equal(res, null);
    assert.equal(seen.url, "http://h:1234/v1/messages");
    assert.equal(seen.auth, "Bearer tok");
  });

  it("refuses a 200 that is not an Anthropic message", async () => {
    const openAiShaped = JSON.stringify({ object: "chat.completion", choices: [] });
    assert.match((await mod.probeLocalEndpoint(signIn, answering(200, openAiShaped))) ?? "", /not with an Anthropic message/);
    assert.match((await mod.probeLocalEndpoint(signIn, answering(200, "<html>"))) ?? "", /not JSON/);
  });

  it("names the status and the server's own words on a refusal", async () => {
    const res = await mod.probeLocalEndpoint(signIn, answering(404, "Unexpected endpoint"));
    assert.match(res ?? "", /answered 404: Unexpected endpoint/);
  });

  it("names the network error when nothing answers", async () => {
    const unreachable = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "EHOSTUNREACH" } });
    }) as typeof fetch;
    assert.match((await mod.probeLocalEndpoint(signIn, unreachable)) ?? "", /EHOSTUNREACH/);
  });
});

describe("ensureLocalConfigDir", () => {
  it("links the operator's rules and CLAUDE.md in, and nothing else", () => {
    const source = path.join(tmp, "claude-home");
    const dir = path.join(tmp, "claude-local");
    fs.mkdirSync(path.join(source, "rules"), { recursive: true });
    fs.writeFileSync(path.join(source, "rules", "coding-principles.md"), "fail loudly");
    fs.writeFileSync(path.join(source, "CLAUDE.md"), "memory");
    fs.writeFileSync(path.join(source, "settings.json"), "{}");

    mod.ensureLocalConfigDir(dir, source);
    assert.equal(
      fs.readFileSync(path.join(dir, "rules", "coding-principles.md"), "utf8"),
      "fail loudly",
    );
    assert.equal(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), "memory");
    assert.equal(fs.existsSync(path.join(dir, "settings.json")), false);

    // Idempotent per cycle, and a stale link is repointed.
    mod.ensureLocalConfigDir(dir, source);
    fs.unlinkSync(path.join(dir, "CLAUDE.md"));
    fs.symlinkSync(path.join(tmp, "nowhere"), path.join(dir, "CLAUDE.md"));
    mod.ensureLocalConfigDir(dir, source);
    assert.equal(fs.readlinkSync(path.join(dir, "CLAUDE.md")), path.join(source, "CLAUDE.md"));
  });

  it("leaves an entry that is really there alone", () => {
    const source = path.join(tmp, "claude-home-2");
    const dir = path.join(tmp, "claude-local-2");
    fs.mkdirSync(path.join(source, "rules"), { recursive: true });
    fs.mkdirSync(path.join(dir, "rules"), { recursive: true });
    fs.writeFileSync(path.join(dir, "rules", "own.md"), "mine");
    mod.ensureLocalConfigDir(dir, source);
    assert.equal(fs.lstatSync(path.join(dir, "rules")).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(dir, "rules", "own.md"), "utf8"), "mine");
  });
});
