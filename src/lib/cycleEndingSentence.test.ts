import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, describe, it } from "node:test";

/**
 * What a run says when its CLI ended a cycle with a sentence of its own.
 *
 * Two shapes measured on 2.1.319 (`docs/verification/run-lifecycle-hooks-and-
 * endings.md`, 2026-11-08) reached the exit branch of `startRun` and left the
 * sentence out of the stop reason:
 *
 * - a startup failure writes nothing to stdout, one sentence to stderr and
 *   exits 1, and on a picked-up run's first cycle `cycleDidNoWork` read that as
 *   a refused resume — one retry, then `resume_failed` and `claude --resume`,
 *   which fails the same way because the hand command does not carry the bad
 *   argv;
 * - a resume refused for a deferred call whose MCP server is missing is a
 *   `result` with `subtype: "success"` and `is_error: true`, which
 *   `handleStreamLine` never read, so the run ended on `exited with code 1`.
 *
 * Both are wiring: the sentence is read in the stream handler, the stderr tail
 * is a field of the cycle's result and the stop reason is chosen in the loop,
 * so this drives real segments through `startRun` and `reopenRun` against a
 * stubbed child, as `resumeMissingTranscript.test.ts` does, replaying the
 * captured bytes. The fixtures are the captured lines with the usage and
 * `modelUsage` blocks dropped, which nothing here reads.
 *
 * Its own file with the environment set before anything is required, for the
 * reason every database-backed test here needs it: `config.ts` fixes `DATA_DIR`
 * and `CLAUDE_HOME` at module load.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-ending-sentence-")));
fs.mkdirSync(path.join(tmp, "workspace", "project"), { recursive: true });

process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
// Pinned rather than left to fall back to CLAUDE_HOME, `orchestrator.test.ts`'s
// rule: an ambient one puts a real OAuth token within reach of anything here
// that reads plan usage.
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");
process.env.WORKSPACE_ROOT = path.join(tmp, "workspace");
delete process.env.WORKSPACE_ROOTS;
process.env.CLAUDE_BIN = path.join(tmp, "no-such-claude");

const config = require("./config") as typeof import("./config");
assert.equal(
  config.DATA_DIR,
  process.env.DATA_DIR,
  "config was already loaded by another test file in this process — refusing to " +
    "run against the real database",
);

const { createRun, getRun, reopenRun, exitStopReason } =
  require("./orchestrator") as typeof import("./orchestrator");
const { startupFailureSentence, CLI_SENTENCE_LIMIT } =
  require("./cycleInvocation") as typeof import("./cycleInvocation");

// A populated projects tree, so a resume is checked against a real listing: an
// empty one is answered as unknown, which resumes.
const projectDir = path.join(config.PROJECTS_DIR, "-workspace-project");
fs.mkdirSync(projectDir, { recursive: true });
fs.writeFileSync(path.join(projectDir, "unrelated-session.jsonl"), "");
const keepTranscript = (sessionId: string) =>
  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), "");

/** One child's bytes and exit, as `drive.mjs` captured them. */
type Replay = { stdout: string; stderr: string; code: number };
/** A cycle that works and finishes with this text, on whatever session it is on. */
type Scripted = Replay | string;

const jsonLines = (...events: unknown[]) => events.map((e) => `${JSON.stringify(e)}\n`).join("");

// 2.1.319, plan e5 (`scripts/cli-capture/plans.mjs`): no stdout, a sentence on
// stderr, exit 1.
const MCP_CONFIG_MISSING: Replay = {
  stdout: "",
  stderr:
    "Error: Invalid MCP configuration:\nMCP config file not found: /scratch/e5/nope/mcp.json\n",
  code: 1,
};
const SETTINGS_MISSING: Replay = {
  stdout: "",
  stderr: "Error: Settings file not found: /scratch/e5/ws/{bad json\n",
  code: 1,
};
const MCP_CONFIG_NOT_JSON: Replay = {
  stdout: "",
  stderr: "Error: Invalid MCP configuration:\nMCP config is not a valid JSON\n",
  code: 1,
};
/** A child that died before it wrote anything, with nothing to say about why. */
const SILENT_DEATH: Replay = { stdout: "", stderr: "", code: 1 };

// 2.1.319, plan e4. D1: a PreToolUse hook deferred an MCP call. Exit 0, a
// success result, an empty `result`, `stop_reason: "tool_deferred"`.
const DEFERRED_SESSION = "8583b3ea-b384-4666-827a-b8848b2c49b0";
const DEFERRED_CALL = { id: "toolu_stub_1", name: "mcp__dsrv__ping", input: {} };
const DEFERRAL: Replay = {
  stdout: jsonLines(
    {
      type: "system",
      subtype: "init",
      session_id: DEFERRED_SESSION,
      mcp_servers: [{ name: "dsrv", status: "connected", source: "dynamic" }],
    },
    {
      type: "assistant",
      message: {
        id: "msg_stub_1",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [{ type: "tool_use", ...DEFERRED_CALL }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      session_id: DEFERRED_SESSION,
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      stop_reason: "tool_deferred",
      terminal_reason: "tool_deferred",
      result: "",
      num_turns: 1,
      session_id: DEFERRED_SESSION,
      total_cost_usd: 0.000105,
      usage: { input_tokens: 10, output_tokens: 5 },
      permission_denials: [],
      deferred_tool_use: DEFERRED_CALL,
    },
  ),
  stderr: "",
  code: 0,
};
// D2/D3: the resume without that call's server. No `init`; exit 1; the same
// `result` twice with a `command_lifecycle` event around each.
const DEFERRED_SENTENCE =
  "mcp__dsrv__ping isn't available, so its deferred call didn't run. Reconnect the tool " +
  "and resume, or resume with a prompt and CLAUDE_CODE_DROP_UNAVAILABLE_DEFERRED_TOOL=1 " +
  "to drop the call and continue.";
const refusedResult = (turns: number) => ({
  type: "result",
  subtype: "success",
  is_error: true,
  stop_reason: "tool_deferred_unavailable",
  terminal_reason: "tool_deferred_unavailable",
  result: DEFERRED_SENTENCE,
  num_turns: turns,
  session_id: DEFERRED_SESSION,
  total_cost_usd: 0.000105,
  usage: { input_tokens: 0, output_tokens: 0 },
  permission_denials: [],
  deferred_tool_use: DEFERRED_CALL,
});
const lifecycle = (state: string, uuid: string) => ({
  type: "command_lifecycle",
  command_uuid: uuid,
  state,
  session_id: DEFERRED_SESSION,
});
const DEFERRAL_REFUSED: Replay = {
  stdout: jsonLines(
    lifecycle("started", "c9a0d30a"),
    refusedResult(16),
    lifecycle("cancelled", "c9a0d30a"),
    refusedResult(16),
  ),
  stderr: "",
  code: 1,
};

/** What each child the loop spawns says, in spawn order. */
let replies: Scripted[] = [];
/** What each child was asked to `--resume`, and the prompt it was handed. */
let spawns: Array<{ resumed: string | null; prompt: string }> = [];
let sessionsOpened = 0;

const childProcess = require("node:child_process") as Record<string, unknown>;
const realSpawn = childProcess.spawn as typeof import("node:child_process").spawn;

childProcess.spawn = (bin: string, args: readonly string[], options: unknown) => {
  // Only the work cycle is stubbed; anything else the loop starts is itself.
  if (bin !== config.CLAUDE_BIN) {
    return (realSpawn as (...a: unknown[]) => unknown)(bin, args, options);
  }
  const reply = replies[spawns.length];
  assert.ok(
    reply !== undefined,
    `the loop spawned work cycle ${spawns.length + 1}, and the script has ${replies.length}`,
  );
  const at = args.indexOf("--resume");
  const resumed = at >= 0 ? args[at + 1] : null;
  // `promptArgs` puts the prompt last, behind `--`.
  spawns.push({ resumed, prompt: args[args.length - 1] });

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    // No pid, so `signalTree` skips `process.kill(-pid)`.
    pid: undefined as number | undefined,
    kill: () => true,
  });

  let replay: Replay;
  if (typeof reply === "string") {
    const session = resumed ?? `session-${++sessionsOpened}`;
    replay = {
      stdout: jsonLines(
        { type: "system", subtype: "init", session_id: session },
        {
          type: "assistant",
          session_id: session,
          message: {
            id: `msg_${spawns.length}`,
            role: "assistant",
            content: [{ type: "text", text: reply }],
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        },
        {
          type: "result",
          subtype: "success",
          session_id: session,
          result: reply,
          num_turns: 1,
          total_cost_usd: 0.01,
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ),
      stderr: "",
      code: 0,
    };
  } else {
    replay = reply;
  }

  // Settled on `end`, so every line has been read before `close` says so.
  stdout.on("end", () => {
    child.emit("exit", replay.code, null);
    child.emit("close", replay.code, null);
  });
  setImmediate(() => {
    stderr.end(replay.stderr);
    stdout.end(replay.stdout);
  });
  return child;
};

after(() => {
  childProcess.spawn = realSpawn;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Wait for the segment in flight to end, however it ends. */
async function settled(id: string) {
  for (let i = 0; i < 1_000; i++) {
    const row = getRun(id)!;
    if (row.status !== "queued" && row.status !== "running") return row;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`run ${id} did not end`);
}

function start(script: Scripted[], maxIterations: number) {
  replies = script;
  spawns = [];
  return createRun({
    folder: "project",
    mountId: null,
    prompt: "do the thing",
    budget: { maxIterations },
    origin: "form",
  });
}

function pickUp(id: string, maxIterations: number) {
  const reopened = reopenRun(id, { maxIterations });
  assert.ok(reopened.ok, JSON.stringify(reopened));
}

describe("a cycle the CLI would not start", () => {
  for (const [what, capture, sentence] of [
    ["an --mcp-config file that is missing", MCP_CONFIG_MISSING, "MCP config file not found"],
    ["a --settings file that is missing", SETTINGS_MISSING, "Settings file not found"],
    ["an --mcp-config file that is not JSON", MCP_CONFIG_NOT_JSON, "MCP config is not a valid JSON"],
  ] as const) {
    it(`carries the CLI's sentence for ${what}`, async () => {
      const run = start([capture], 3);
      const row = await settled(run.id);

      assert.equal(spawns.length, 1, "a fresh run is not retried");
      assert.equal(row.status, "failed");
      assert.equal(row.ending_code, "exit_code");
      assert.ok(row.stop_reason?.includes("exited with code 1"), row.stop_reason ?? "");
      assert.ok(row.stop_reason?.includes(sentence), row.stop_reason ?? "");
    });
  }

  it("is not called a resume failure on a picked-up run's first cycle", async () => {
    // A third reply so that a retry, if the loop makes one, is an assertion
    // failing below rather than the stub running out of script.
    const run = start(["Still working.", MCP_CONFIG_MISSING, MCP_CONFIG_MISSING], 1);
    const first = await settled(run.id);
    assert.equal(first.status, "completed", first.stop_reason ?? "");
    assert.ok(first.session_id, "the fixture's first cycle must leave a session to resume");
    keepTranscript(first.session_id);

    pickUp(run.id, 2);
    const row = await settled(run.id);

    // The argv failed, not the session, so a second spawn would fail the same
    // way and the hand command would not carry the argv at all.
    assert.equal(spawns.length, 2, "one cycle before the pick-up and one after it, no retry");
    assert.equal(spawns[1].resumed, first.session_id);
    assert.equal(row.status, "failed");
    assert.equal(row.ending_code, "exit_code");
    assert.ok(row.stop_reason?.includes("MCP config file not found"), row.stop_reason ?? "");
    assert.ok(!row.stop_reason?.includes("claude --resume"), row.stop_reason ?? "");
    assert.ok(!row.stop_reason?.includes("Could not resume"), row.stop_reason ?? "");
  });

  it("is only a startup failure when nothing reached stdout", async () => {
    // A child that wrote its `init` and then died with a warning on stderr did
    // start, so the warning is not the CLI's complaint about its argv; on a
    // picked-up run's first cycle that is still the shape of a resume that went
    // wrong, with the retry and the command that resumes it by hand.
    const started: Replay = {
      stdout: jsonLines({ type: "system", subtype: "init", session_id: "s-warn" }),
      stderr: "(node:1) Warning: something unrelated\n",
      code: 1,
    };
    const run = start(["Still working.", started, started], 1);
    const first = await settled(run.id);
    assert.ok(first.session_id);
    keepTranscript(first.session_id);

    pickUp(run.id, 2);
    const row = await settled(run.id);

    assert.equal(spawns.length, 3, "retried once, as a resume that went wrong is");
    assert.equal(row.ending_code, "resume_failed");
  });

  it("still retries a picked-up run's silent death once, and names the command", async () => {
    // No stdout and no stderr is a child that died before it could say why,
    // which is the only evidence left for a resume that went wrong; the retry
    // and `claude --resume` stay for it.
    const run = start(["Still working.", SILENT_DEATH, SILENT_DEATH], 1);
    const first = await settled(run.id);
    assert.ok(first.session_id);
    keepTranscript(first.session_id);

    pickUp(run.id, 2);
    const row = await settled(run.id);

    assert.deepEqual(
      spawns.map((s) => s.resumed),
      [null, first.session_id, first.session_id],
      "the silent death is retried once on the same session",
    );
    assert.equal(row.ending_code, "resume_failed");
    assert.ok(row.stop_reason?.includes(`claude --resume ${first.session_id}`), row.stop_reason ?? "");
  });
});

describe("a resume refused for a deferred call whose tool is gone", () => {
  it("ends the run with the CLI's sentence, which names the tool and the two ways out", async () => {
    // The deferring cycle is a success with empty text, so the loop sends its
    // continuation into the session that holds the call; the CLI refuses that.
    const run = start([DEFERRAL, DEFERRAL_REFUSED], 3);
    const row = await settled(run.id);

    assert.deepEqual(
      spawns.map((s) => s.resumed),
      [null, DEFERRED_SESSION],
      "the refusal is deterministic, so it is not retried",
    );
    assert.equal(row.status, "failed");
    assert.equal(row.ending_code, "exit_code");
    assert.ok(row.stop_reason?.includes("mcp__dsrv__ping isn't available"), row.stop_reason ?? "");
    assert.ok(row.stop_reason?.includes("Reconnect the tool"), row.stop_reason ?? "");
    assert.ok(
      row.stop_reason?.includes("CLAUDE_CODE_DROP_UNAVAILABLE_DEFERRED_TOOL=1"),
      row.stop_reason ?? "",
    );
    // It has `num_turns: 16`, so it is a cycle that ran by `cycleDidNoWork`'s
    // reading and must not be sent to a hand-resume that would be refused too.
    assert.ok(!row.stop_reason?.includes("claude --resume"), row.stop_reason ?? "");
  });

  it("is refused again by a pick-up while the tool is still gone, once per press", async () => {
    const run = start([DEFERRAL, DEFERRAL_REFUSED, DEFERRAL_REFUSED], 3);
    const first = await settled(run.id);
    assert.equal(first.status, "failed");
    keepTranscript(DEFERRED_SESSION);

    pickUp(run.id, 6);
    const row = await settled(run.id);

    // Nothing re-enters the refusal on its own: the pick-up is the operator's
    // press, it costs one spawn, and it ends with the sentence that says what
    // to change before pressing again.
    assert.equal(spawns.length, 3);
    assert.equal(spawns[2].resumed, DEFERRED_SESSION);
    assert.equal(row.status, "failed");
    assert.equal(row.ending_code, "exit_code");
    assert.ok(row.stop_reason?.includes("mcp__dsrv__ping isn't available"), row.stop_reason ?? "");
  });

  it("does not read an error result's text as the provider refusing", async () => {
    // The decision about `apiError`: a success-subtype `is_error` result quotes
    // its sentence and nothing more. Text that reads like a rate limit must not
    // put the run on the 429 ladder, which backs off and respawns, nor park it
    // for an allowance; the provider's refusals reach `apiError` through the
    // `<synthetic>` message and a non-success subtype, as before.
    const sentence = "API Error: 429 rate_limit_error from a tool this cycle called";
    const run = start(
      [
        {
          stdout: jsonLines(
            { type: "system", subtype: "init", session_id: "s-err" },
            {
              type: "result",
              subtype: "success",
              is_error: true,
              result: sentence,
              num_turns: 3,
              session_id: "s-err",
              total_cost_usd: 0.01,
              usage: { input_tokens: 10, output_tokens: 5 },
            },
          ),
          stderr: "",
          code: 1,
        },
      ],
      3,
    );
    const row = await settled(run.id);

    assert.equal(spawns.length, 1, "not retried");
    assert.equal(row.status, "failed");
    assert.equal(row.ending_code, "exit_code");
    assert.ok(row.stop_reason?.includes(sentence), row.stop_reason ?? "");
  });
});

describe("startupFailureSentence", () => {
  const base = { exitCode: 1, sawResult: false, stdoutLines: 0, stderrTail: "Error: nope\n" };

  it("flattens the CLI's lines into one sentence", () => {
    assert.equal(
      startupFailureSentence({
        ...base,
        stderrTail: "Error: Invalid MCP configuration:\nMCP config is not a valid JSON\n",
      }),
      "Error: Invalid MCP configuration: MCP config is not a valid JSON",
    );
  });

  it("is clipped, with the clip marked", () => {
    const sentence = startupFailureSentence({ ...base, stderrTail: "x".repeat(5_000) });
    assert.equal(sentence?.length, CLI_SENTENCE_LIMIT);
    assert.ok(sentence?.endsWith("…"));
  });

  // Each of these is a cycle that is not a refusal to start, and mistaking one
  // for it costs the retry and the resume command that a silent death earns.
  for (const [what, change] of [
    ["a child that exited 0", { exitCode: 0 }],
    ["a child a signal killed", { exitCode: -1 }],
    ["a child that wrote a line to stdout", { stdoutLines: 1 }],
    ["a child that reported a result", { sawResult: true }],
    ["a child with nothing on stderr", { stderrTail: "" }],
    ["a child whose stderr is only whitespace", { stderrTail: " \n\t\n" }],
  ] as const) {
    it(`is null for ${what}`, () => {
      assert.equal(startupFailureSentence({ ...base, ...change }), null);
    });
  }
});

describe("exitStopReason with the CLI's sentence", () => {
  it("quotes it on the plain exit, for either CLI", () => {
    assert.equal(
      exitStopReason("claude", 1, null, "Error: Settings file not found: /x/y"),
      "Claude Code exited with code 1 and said: “Error: Settings file not found: /x/y”.",
    );
    assert.equal(
      exitStopReason("codex", 2, null, "boom"),
      "Codex exited with code 2 and said: “boom”.",
    );
  });

  it("is unchanged without one", () => {
    assert.equal(exitStopReason("claude", 1, null), "Claude Code exited with code 1.");
    assert.equal(exitStopReason("claude", 1, null, null), "Claude Code exited with code 1.");
  });

  it("leaves a failed resume naming the hand command alone", () => {
    assert.equal(
      exitStopReason("claude", 1, "sess-1", "ignored"),
      "Could not resume this run's Claude Code session (exit 1). Its work is still on disk; pick it up by hand with: claude --resume sess-1",
    );
  });
});
