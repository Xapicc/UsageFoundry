// The capture plans drive.mjs ran on 2026-11-08 against claude 2.1.319, by
// name. Prints one plan as JSON: node plans.mjs <e1..e10> <outdir>
// Every HOME and CLAUDE_CONFIG_DIR is a scratch directory under <outdir>, and
// every credential is made up.
import path from "node:path";

const [name, outArg] = process.argv.slice(2);
if (!name || !outArg) throw new Error("usage: node plans.mjs <e1..e10> <outdir>");
const O = path.resolve(outArg);
const here = path.dirname(new URL(import.meta.url).pathname);
const STD = ["--permission-mode", "acceptEdits", "--model", "claude-sonnet-4-5"];
const dirs = (n = "") => ({ home: `${O}/h${n}`, config: `${O}/c${n}`, cwd: `${O}/ws` });
const notes = { [`${O}/ws/notes.txt`]: "hello" };

// A stored claude.ai sign-in, with and without the refresh token's expiry that
// `credential_expires_at` is read from.
const now = Date.now();
const oauth = (withRefreshExpiry) => ({
  claudeAiOauth: {
    accessToken: "sk-ant-oat01-fake-access",
    refreshToken: "sk-ant-ort01-fake-refresh",
    expiresAt: now + 8 * 3600_000,
    ...(withRefreshExpiry ? { refreshTokenExpiresAt: now + 20 * 86400_000 } : {}),
    scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
  },
});

const plans = {
  // Two cycles and more on one session: a background Bash task, a resume, a
  // manual /compact, and a DONE.
  e1: [
    { label: "fresh + background Bash", ...dirs(), files: notes, args: STD, prompt: "SCN_BG start a background task" },
    { label: "resume + 190K reported", ...dirs(), args: STD, resumeFrom: 0, prompt: "SCN_COMPACT read a file" },
    { label: "resume + /compact", ...dirs(), args: STD, resumeFrom: 1, prompt: "/compact" },
    { label: "resume + DONE", ...dirs(), args: STD, resumeFrom: 2, prompt: "SCN_DONE finish" },
  ],
  // What it takes to make the CLI auto-compact at 190K on an API key.
  e2: [
    { label: "window 200000", ...dirs(0), files: notes, args: STD, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000" }, prompt: "SCN_COMPACT read notes" },
    { label: "pct override 50", ...dirs(1), args: STD, env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "50" }, prompt: "SCN_COMPACT read notes" },
    { label: "haiku-4-5 plain", ...dirs(2), args: ["--permission-mode", "acceptEdits", "--model", "claude-haiku-4-5"], prompt: "SCN_COMPACT read notes" },
    { label: "sonnet-4-5 plain", ...dirs(3), args: STD, prompt: "SCN_COMPACT read notes" },
  ],
  // credential_expires_at per credential type, and the long-context 429.
  e3: [
    { label: "api key", ...dirs(0), files: notes, args: STD, prompt: "SCN_DONE x" },
    { label: "CLAUDE_CODE_OAUTH_TOKEN", ...dirs(1), args: STD, apiKey: false, env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-fake-envtoken" }, prompt: "SCN_DONE x" },
    { label: "stored sign-in, refresh expiry", ...dirs(2), args: STD, apiKey: false, files: { [`${O}/c2/.credentials.json`]: oauth(true) }, prompt: "SCN_DONE x" },
    { label: "stored sign-in, no refresh expiry", ...dirs(3), args: STD, apiKey: false, files: { [`${O}/c3/.credentials.json`]: oauth(false) }, prompt: "SCN_DONE x" },
    { label: "stored sign-in, long-context 429", ...dirs(4), args: STD, apiKey: false, files: { [`${O}/c4/.credentials.json`]: oauth(true) }, prompt: "SCN_LONGCTX read notes", timeoutS: 120 },
    { label: "api key, long-context 429", ...dirs(5), args: STD, prompt: "SCN_LONGCTX read notes", timeoutS: 120 },
  ],
  // A PreToolUse hook defers an MCP call; the session is then resumed without
  // the server, again without it, with it back, and once more.
  e4: (() => {
    const A = [...STD, "--allowedTools", "mcp__dsrv__ping"];
    const MCP = ["--mcp-config", `${O}/mcp-on.json`];
    const files = {
      [`${O}/c/settings.json`]: { hooks: { PreToolUse: [{ matcher: "mcp__dsrv__ping", hooks: [{ type: "command", command: `${here}/defer-hook.sh` }] }] } },
      [`${O}/mcp-on.json`]: { mcpServers: { dsrv: { command: "node", args: [`${here}/mcp-ping-server.mjs`] } } },
    };
    return [
      { label: "D1 fresh, hook defers", files, ...dirs(), args: [...A, ...MCP], env: { DEFER_ON: "1" }, prompt: "SCN_DEFER ping it" },
      { label: "D2 resume, server gone", ...dirs(), args: A, env: { DEFER_ON: "1" }, resumeFrom: 0, prompt: "continue the task" },
      { label: "D3 resume, server still gone", ...dirs(), args: A, env: { DEFER_ON: "1" }, resumeFrom: 0, prompt: "continue again" },
      { label: "D4 resume, server back", ...dirs(), args: [...A, ...MCP], env: { DEFER_ON: "0" }, resumeFrom: 0, prompt: "continue with server" },
      { label: "D5 resume, DONE", ...dirs(), args: [...A, ...MCP], env: { DEFER_ON: "0" }, resumeFrom: 0, prompt: "SCN_DONE wrap up" },
    ];
  })(),
  // Startup failures, on stream-json.
  e5: [
    { label: "--mcp-config file missing", ...dirs(0), args: [...STD, "--mcp-config", `${O}/nope/mcp.json`], prompt: "SCN_DONE x" },
    { label: "--settings file missing", ...dirs(1), args: [...STD, "--settings", "{bad json"], prompt: "SCN_DONE x" },
    { label: "--resume of an unknown id", ...dirs(2), args: [...STD, "--resume", "00000000-0000-4000-8000-000000000000"], prompt: "SCN_DONE x" },
    { label: "CLAUDE_CONFIG_DIR is a file", ...dirs(3), config: `${O}/cfgfile`, files: { [`${O}/cfgfile`]: "not a dir" }, args: STD, prompt: "SCN_DONE x" },
    { label: "--mcp-config not JSON", ...dirs(4), args: [...STD, "--mcp-config", `${O}/bad-mcp.json`], files: { [`${O}/bad-mcp.json`]: "{nope" }, prompt: "SCN_DONE x" },
  ],
  // What reaches stdout before the first API request: the stub holds its answer
  // for three seconds, so a line that only appeared with the answer would show
  // as `firstStdoutAt` after the request's `t` by about that long. A startup
  // failure that is told by an empty stdout (`startupFailureSentence`) is read as
  // a cycle that made no API call only while that ordering holds.
  // One cycle per way the CLI is given its credential, since a sign-in may do
  // work before its first line that an API key does not.
  e9: [
    { label: "api key", ...dirs(0), files: notes, args: STD, prompt: "SCN_HOLD x" },
    { label: "CLAUDE_CODE_OAUTH_TOKEN", ...dirs(1), args: STD, apiKey: false, env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-fake-envtoken" }, prompt: "SCN_HOLD x" },
    { label: "stored sign-in", ...dirs(2), args: STD, apiKey: false, files: { [`${O}/c2/.credentials.json`]: oauth(true) }, prompt: "SCN_HOLD x" },
  ],
  // The OTel `effort` attribute.
  e6: [
    { label: "opus-4-5 high", ...dirs(0), args: ["--model", "claude-opus-4-5", "--effort", "high"], prompt: "SCN_DONE x" },
    { label: "sonnet-4-5 low", ...dirs(1), args: ["--model", "claude-sonnet-4-5", "--effort", "low"], prompt: "SCN_DONE x" },
    { label: "opus-5-5 medium", ...dirs(2), args: ["--model", "claude-opus-5-5", "--effort", "medium"], prompt: "SCN_DONE x" },
  ],
  // A background Bash task re-issued until the nested sandbox lets one start
  // (none did in 10 tries on 2026-11-08).
  e7: [{ label: "background Bash, retried", ...dirs(), args: STD, prompt: "SCN_BGRETRY start", timeoutS: 150 }],
  // A startup failure that arrives as a `result` with `startup_failure_reason`
  // set: the global config file is not JSON. One of the three reasons the CLI
  // writes to every stream-json run; the other two (org_config_required_unavailable,
  // org_config_refused) need a claude.ai sign-in whose organization requires its
  // settings, which a made-up credential does not give.
  e8: [
    { label: "good cycle", ...dirs(), args: STD, prompt: "SCN_DONE x" },
    { label: "resume, global config corrupt", ...dirs(), files: { [`${O}/c/.claude.json`]: "{nope" }, args: STD, resumeFrom: 0, prompt: "continue" },
    { label: "fresh, global config corrupt", ...dirs(), args: STD, prompt: "SCN_DONE x" },
  ],
  // What makes the CLI refuse a `--resume` whose transcript is still on disk
  // under its own name, which is the only resume `startRun` lets through
  // (`sessionTranscriptPresence`). Each cause gets its own session: one good
  // cycle, then the transcript (or the folder) is damaged and the session
  // resumed. Last, a second child resumes a session a first one is still
  // answering in.
  e10: (() => {
    const out = [];
    // An op with no `path` acts on the good cycle's transcript.
    const onGood = (ops, good) => ops?.map((m) => (m.path ? m : { ...m, of: good }));
    const cause = (label, mutate, extra = {}) => {
      const d = { ...dirs(out.length / 2), ...(extra.cwd ? { cwd: extra.cwd } : {}) };
      out.push({ label: `good cycle for: ${label}`, ...d, ...(out.length === 0 ? { files: notes } : {}), args: STD, prompt: "SCN_DONE x" });
      const good = out.length - 1;
      out.push({ label, ...d, args: STD, resumeFrom: good, prompt: "continue", mutate: onGood(mutate, good), undo: onGood(extra.undo, good) });
    };
    cause("last line torn in half", [{ op: "tail" }]);
    cause("transcript is not JSON", [{ op: "replace", content: "this is not a transcript\n" }]);
    cause("transcript is empty", [{ op: "replace", content: "" }]);
    cause("no user or assistant line left", [{ op: "dropTypes", types: ["user", "assistant"] }]);
    cause("written by an older CLI (version 1.0.0)", [{ op: "replaceAll", from: '"version":"2.1.319"', to: '"version":"1.0.0"' }]);
    cause("written by a newer CLI (version 9.0.0)", [{ op: "replaceAll", from: '"version":"2.1.319"', to: '"version":"9.0.0"' }]);
    cause("transcript unreadable (mode 000)", [{ op: "chmod", mode: 0o000 }], { undo: [{ op: "chmod", mode: 0o600 }] });
    cause("transcript is a symlink", [{ op: "symlink" }]);
    cause("transcript is a directory", [{ op: "dir" }]);
    cause("working directory unreadable (mode 311)", [{ op: "chmod", path: `${O}/wsl`, mode: 0o311 }], { cwd: `${O}/wsl`, undo: [{ op: "chmod", path: `${O}/wsl`, mode: 0o755 }] });
    // The line `markSessionEndedByModel` appends when the model calls
    // EndConversation, a tool behind a server flag a fake key never gets.
    cause("ended-by-model marker appended", [{ op: "endedByModel" }]);
    const d = dirs(out.length / 2);
    out.push({ label: "good cycle for: session held by a live child", ...d, args: STD, prompt: "SCN_DONE x" });
    const good = out.length - 1;
    out.push({ label: "first child, still answering", ...d, args: STD, resumeFrom: good, prompt: "SCN_LONGHOLD go on", detach: true, afterMs: 4000 });
    out.push({ label: "second child, same session", ...d, args: STD, resumeFrom: good, prompt: "continue" });
    return out;
  })(),
};

if (!plans[name]) throw new Error(`no plan ${name}; have ${Object.keys(plans).join(", ")}`);
console.log(JSON.stringify({ cycles: plans[name] }));
