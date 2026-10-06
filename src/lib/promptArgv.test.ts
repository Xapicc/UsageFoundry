import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

/**
 * A prompt that begins with `-`, as the CLI's own parser reads it, at each of
 * the three places this app spawns `claude` with one.
 *
 * In the CLI `-p` is `--print`, a boolean, and the prompt is the root command's
 * positional `[prompt]`. So the token after `-p` is parsed like any other, and
 * under commander a token longer than one character that starts with `-` is an
 * option unless a `--` came before it. A pasted bullet list — `- one\n- two` —
 * was therefore an unknown option: the CLI exits 1 naming the operator's own
 * text before it reads a prompt, and the cycle, chat turn or review fails
 * having done nothing. A prompt that happens to spell a real long option is
 * worse, because it is consumed as that option and no prompt is left. Nothing
 * in a typecheck or in an argv assertion that reads `args[1]` sees it.
 *
 * The stub is the half that makes this a test of the CLI's reading rather than
 * of this app's: `parseOptions` below is commander's, transcribed from the
 * pinned 2.1.280 bundle (`grep -a -o 'parseOptions([A-Za-z_$]*){.\{0,1600\}'`
 * over `claude.exe`) rather than imported, since commander is not a dependency
 * here, and its option table is the root command's declaration of every flag
 * the three spawn sites emit — `<value>` required, `<values...>` variadic,
 * `[value]` optional, none boolean — read from the same bundle. The root
 * command has no `.allowUnknownOption()` and no `.passThroughOptions()`, so an
 * unknown option is commander's `error: unknown option '<token>'` and exit 1,
 * which is what the stub does. It declares no subcommands, so it does not
 * model `enablePositionalOptions` stopping at one: that is a separate hazard,
 * and `--` does not change it.
 *
 * The children are real processes started by the real spawn sites, with
 * `CLAUDE_BIN` pointing at the stub, because two of the three argvs are built
 * inline at the spawn and nothing short of the spawn sees them. Its own file
 * with the environment set before anything is required, for the reason every
 * database-backed test here needs it: `config.ts` fixes `DATA_DIR` and
 * `CLAUDE_HOME` at module load.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-prompt-argv-")));
const project = path.join(tmp, "workspace", "project");
fs.mkdirSync(project, { recursive: true });
const receivedFile = path.join(tmp, "received.jsonl");

const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const OPTIONS = {
  "-p": "boolean", "--print": "boolean",
  "--output-format": "required",
  "--verbose": "boolean",
  "--model": "required",
  "--permission-mode": "required",
  "--forward-subagent-text": "boolean",
  "--effort": "required",
  "--agents": "required",
  "--agent": "required",
  "--allowedTools": "variadic", "--allowed-tools": "variadic",
  "--disallowedTools": "variadic", "--disallowed-tools": "variadic",
  "--append-system-prompt": "required",
  "--plugin-dir": "required",
  "--mcp-config": "variadic",
  "--strict-mcp-config": "boolean",
  "--add-dir": "variadic",
  "-r": "optional", "--resume": "optional",
  "--max-budget-usd": "required",
  "--settings": "required",
  "--setting-sources": "required",
};
const maybeOption = (arg) => arg.length > 1 && arg[0] === "-";
function parseOptions(argv) {
  const operands = [];
  const unknown = [];
  let dest = operands;
  const args = argv.slice();
  let variadic = false;
  while (args.length) {
    const arg = args.shift();
    if (arg === "--") {
      if (dest === unknown) dest.push(arg);
      dest.push(...args);
      break;
    }
    if (variadic && !maybeOption(arg)) continue;
    variadic = false;
    if (maybeOption(arg) && OPTIONS[arg]) {
      const kind = OPTIONS[arg];
      if (kind === "required" || kind === "variadic") {
        if (args.shift() === undefined) return { error: "option '" + arg + "' argument missing" };
      } else if (kind === "optional" && args.length > 0 && !maybeOption(args[0])) {
        args.shift();
      }
      variadic = kind === "variadic";
      continue;
    }
    if (arg.length > 2 && arg[0] === "-" && arg[1] !== "-" && OPTIONS["-" + arg[1]]) {
      if (OPTIONS["-" + arg[1]] === "boolean") args.unshift("-" + arg.slice(2));
      continue;
    }
    if (/^--[^=]+=/.test(arg)) {
      const kind = OPTIONS[arg.slice(0, arg.indexOf("="))];
      if (kind && kind !== "boolean") continue;
    }
    if (maybeOption(arg)) dest = unknown;
    dest.push(arg);
  }
  return { operands, unknown };
}
const parsed = parseOptions(process.argv.slice(2));
const error = parsed.error || (parsed.unknown.length > 0 ? "unknown option '" + parsed.unknown[0] + "'" : null);
fs.appendFileSync(${JSON.stringify(receivedFile)}, JSON.stringify(error ? { error } : { operands: parsed.operands }) + "\\n");
if (error) {
  process.stderr.write("error: " + error + "\\n");
  process.exit(1);
}
const session = "stub-session";
const usage = { input_tokens: 10, output_tokens: 5 };
for (const event of [
  { type: "system", subtype: "init", session_id: session },
  {
    type: "assistant",
    session_id: session,
    message: { id: "msg_1", role: "assistant", content: [{ type: "text", text: "Read it." }], usage },
  },
  {
    type: "result", subtype: "success", is_error: false, session_id: session,
    result: "Read it.", num_turns: 1, total_cost_usd: 0.01, usage,
  },
]) {
  process.stdout.write(JSON.stringify(event) + "\\n");
}
`;

const stub = path.join(tmp, "claude-parsing-stub.js");
fs.writeFileSync(stub, STUB, { mode: 0o755 });

process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
// Pinned rather than left to fall back to CLAUDE_HOME, `orchestrator.test.ts`'s
// rule: an ambient one puts a real OAuth token within reach of anything here
// that reads plan usage.
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");
process.env.WORKSPACE_ROOT = path.join(tmp, "workspace");
delete process.env.WORKSPACE_ROOTS;
process.env.CLAUDE_BIN = stub;

const config = require("./config") as typeof import("./config");
assert.equal(
  config.DATA_DIR,
  process.env.DATA_DIR,
  "config was already loaded by another test file in this process — refusing to " +
    "run against the real database",
);

const { createRun, getRun, reopenRun } =
  require("./orchestrator") as typeof import("./orchestrator");
const { saveSettings } = require("./settings") as typeof import("./settings");
const { createChat, getChat, sendChatMessage } = require("./chat") as typeof import("./chat");
const { listReviews, startAssist } = require("./review") as typeof import("./review");

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const BULLETS = "- one\n- two";

/** What each child the stub was spawned as read off its argv, in spawn order. */
function received(): Array<{ operands?: string[]; error?: string }> {
  if (!fs.existsSync(receivedFile)) return [];
  return fs
    .readFileSync(receivedFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Poll `done` until it answers, failing by name rather than hanging the suite. */
async function until<T>(what: string, done: () => T | null | undefined): Promise<T> {
  for (let i = 0; i < 1_000; i++) {
    const value = done();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`${what} did not settle`);
}

const settledRun = (id: string) =>
  until(`run ${id}`, () => {
    const row = getRun(id)!;
    return row.status !== "queued" && row.status !== "running" ? row : null;
  });

describe("a prompt that begins with a dash", () => {
  let runId = "";

  it("reaches a work cycle as its prompt, opening and resumed", async () => {
    saveSettings({ freshStartContextTokens: null });
    const before = received().length;
    const run = createRun({
      folder: "project",
      mountId: null,
      prompt: BULLETS,
      budget: { maxIterations: 1 },
      origin: "form",
    });
    runId = run.id;
    const first = await settledRun(run.id);

    // A fresh session's prompt opens on the task and carries the ending
    // contract after it, so the operator's text is its first characters.
    const opening = received()[before];
    assert.equal(opening?.error, undefined, `the CLI refused the opening cycle: ${opening?.error}`);
    const [prompt, ...extra] = opening.operands ?? [];
    assert.deepEqual(extra, []);
    assert.ok(prompt?.startsWith(`${BULLETS}\n\n`), prompt);
    assert.equal(first.session_id, "stub-session", first.stop_reason ?? "");

    // A follow-up on a resumed session is sent verbatim — the operator's words
    // and nothing else — so this is the argv token in full.
    const reopened = reopenRun(run.id, { maxIterations: 2 }, BULLETS);
    assert.ok(reopened.ok, JSON.stringify(reopened));
    await settledRun(run.id);
    assert.deepEqual(received()[before + 1], { operands: [BULLETS] });
  });

  it("reaches a chat turn as its message", async () => {
    const before = received().length;
    const chat = createChat();
    const sent = await sendChatMessage(chat.id, BULLETS);
    assert.ok(sent.ok, JSON.stringify(sent));
    await until(`chat ${chat.id}`, () => getChat(chat.id)?.status !== "thinking");

    // A chat's first message has no thread to replay, so it is the prompt whole.
    assert.deepEqual(received().slice(before), [{ operands: [BULLETS] }]);
  });

  it("reaches a review or validation child as its prompt", async () => {
    const before = received().length;
    const run = getRun(runId)!;
    const started = startAssist({
      run,
      kind: "review",
      cwd: project,
      permissionMode: "plan",
      prompt: BULLETS,
    });
    assert.ok(started.ok, JSON.stringify(started));
    await until("the review", () =>
      listReviews(run.id, "review").every((r) => r.status !== "running"),
    );

    assert.deepEqual(received().slice(before), [{ operands: [BULLETS] }]);
  });
});
