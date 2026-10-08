import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

/**
 * A turn's stream is read whether or not anybody is watching it.
 *
 * `runOrchestratorChild` folds every stdout line into the turn's accumulator,
 * and the verdict — the reply, the session id, the reported cost — is read off
 * that accumulator when the child exits. The fold used to be an argument of the
 * optional `onProgress` call, so it ran only for a caller that passed one. The
 * chat does; a workflow's orchestrator block does not, and every block turn
 * measured in this install (53 that emitted runs, 2026-09-21 to 2026-10-07)
 * settled `The chat produced no readable output (exit 0).` with no reply and
 * `cost_unreported` set, over a child that had printed a valid `result`. The
 * only existing test that starts a real block child, `blockStartupGit.test.ts`,
 * stubs a valid stream and then asserts about the argv alone, which is how it
 * passed.
 *
 * Its own file with the environment set before anything is required, for
 * `promptArgv.test.ts`'s reason: `config.ts` fixes `DATA_DIR` and `CLAUDE_BIN`
 * at module load.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-block-turn-reading-")));

const SESSION = "stub-session-reading";

const STUB = `#!/usr/bin/env node
const session = ${JSON.stringify(SESSION)};
const usage = { input_tokens: 10, output_tokens: 5 };
for (const event of [
  { type: "system", subtype: "init", session_id: session },
  { type: "assistant", session_id: session, message: { id: "msg_1", role: "assistant", content: [{ type: "text", text: "Started two runs." }], usage } },
  { type: "result", subtype: "success", is_error: false, session_id: session, result: "Started two runs.", num_turns: 1, total_cost_usd: 0.37, usage },
]) {
  process.stdout.write(JSON.stringify(event) + "\\n");
}
`;

const stub = path.join(tmp, "claude-reading-stub.js");
fs.writeFileSync(stub, STUB, { mode: 0o755 });

process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
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

const { runOrchestratorChild } = require("./chat") as typeof import("./chat");
type TurnResult = import("./chat").TurnResult;
type ChatTurnAccumulator = import("./chatStream").ChatTurnAccumulator;

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function turn(onProgress?: (acc: ChatTurnAccumulator) => void): Promise<TurnResult> {
  return new Promise<TurnResult>((resolve) =>
    runOrchestratorChild({
      subject: { kind: "block", instanceId: "instance", nodeId: "node" },
      prompt: "Decide what to run.",
      appendSystemPrompt: "You are an orchestrator block.",
      maxBudgetUSD: null,
      idleTimeoutMs: 30_000,
      timedOutMessage: "The stub went silent.",
      onProgress,
      onSettle: resolve,
    }),
  );
}

describe("a child turn's verdict, read off its stream", () => {
  it("is the result's reply, session and cost when nobody watches the turn", async () => {
    const result = await turn();
    assert.equal(result.status, "idle", `settled ${JSON.stringify(result)}`);
    assert.equal(result.text, "Started two runs.");
    assert.equal(result.sessionId, SESSION);
    assert.equal(result.costUSD, 0.37, "the CLI's own figure, not the unreported shape");
    assert.equal(result.tokens, 15);
  });

  it("is the same when a caller does watch, and each line is read once", async () => {
    const seen: string[] = [];
    const result = await turn((acc) => seen.push(acc.text));
    assert.equal(result.status, "idle", `settled ${JSON.stringify(result)}`);
    assert.equal(result.text, "Started two runs.");
    assert.equal(result.costUSD, 0.37);
    // Three stream lines, one call each, and the assistant text appended once:
    // a line folded twice (once to read it, once more to hand it over) would
    // double the text, which `result.text` above is read off the `result` event
    // and so would not show.
    assert.equal(seen.length, 3);
    assert.equal(seen.at(-1), "Started two runs.");
  });
});
