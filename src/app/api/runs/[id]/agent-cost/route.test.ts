import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, it } from "node:test";

/**
 * What a run's "Agent work" card is told about a run whose turns are not where
 * this reading looks.
 *
 * The route reads Claude Code's transcripts under `PROJECTS_DIR` and keeps the
 * session's own turns. A local cycle writes its transcripts under its own config
 * directory, which is deliberately outside every meter (`local-provider.md`), so
 * for a local run that did work the filter found nothing and the route answered
 * a reading of zero turns — which the card draws as "No turns were recorded for
 * this run", a false statement about an unattended agent. Nothing throws and the
 * answer typechecks; unknown has to be `null`, never zero (`metering.md`).
 *
 * The environment has to be configured before the modules load: `config.ts`
 * reads it once at import.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-agent-cost-")));
fs.mkdirSync(path.join(tmp, "claude", "projects"), { recursive: true });
process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
// Pinned rather than left to fall back: `LOCAL_CLAUDE_CONFIG_DIR` is its
// sibling, and the ambient agent walk reads under it.
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");
process.env.WORKSPACE_ROOT = path.join(tmp, "workspace");
fs.mkdirSync(process.env.WORKSPACE_ROOT, { recursive: true });
process.env.WORKSPACE_ROOTS = "";
process.env.CLAUDE_BIN = path.join(tmp, "no-such-claude");

// `require`, not `import`: imports are hoisted above the environment setup.
const config = require("../../../../../lib/config") as typeof import("../../../../../lib/config");
assert.equal(
  config.DATA_DIR,
  process.env.DATA_DIR,
  "config was already loaded — refusing to run against the real database",
);
const { db } = require("../../../../../lib/db") as typeof import("../../../../../lib/db");
const { GET } = require("./route") as typeof import("./route");

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let seq = 0;

function insertRun(provider: string | null, sessionId: string, finishedAt: number): string {
  const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, created_at, provider,
                         session_id, iterations, finished_at, work_dir)
       VALUES (?, ?, 'task', 'completed', '{"maxIterations":3}', ?, ?, ?, 3, ?, ?)`,
    )
    .run(
      id,
      process.env.WORKSPACE_ROOT,
      Date.now() - 60_000,
      provider,
      sessionId,
      finishedAt,
      process.env.WORKSPACE_ROOT,
    );
  return id;
}

/** `turns` priced assistant turns of one session, in one project directory. */
function writeTranscript(projectsDir: string, sessionId: string, turns: number, ts: number): void {
  const dir = path.join(projectsDir, "-workspace");
  fs.mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: turns }, (_, n) =>
    JSON.stringify({
      type: "assistant",
      sessionId,
      requestId: `req_${sessionId}_${n}`,
      timestamp: new Date(ts + n).toISOString(),
      message: {
        id: `msg_${sessionId}_${n}`,
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [{ type: "text", text: "working" }],
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    }),
  );
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.join("\n") + "\n");
}

async function agentCost(id: string) {
  const res = await GET(new Request("http://localhost/"), {
    params: Promise.resolve({ id }),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as {
    spend: { entryCount: number } | null;
    reason?: string;
  };
}

it("answers a local run that worked as unknown, never as zero turns", async () => {
  const now = Date.now();
  const claudeRun = insertRun(null, "claude-sess", now + 60_000);
  const localRun = insertRun("local", "local-sess", now + 60_000);
  writeTranscript(config.PROJECTS_DIR, "claude-sess", 3, now - 30_000);
  writeTranscript(
    path.join(config.LOCAL_CLAUDE_CONFIG_DIR, "projects"),
    "local-sess",
    3,
    now - 30_000,
  );

  const claude = await agentCost(claudeRun);
  assert.equal(claude.spend?.entryCount, 3, "control: the Claude run's turns are counted");

  const local = await agentCost(localRun);
  assert.ok(
    local.spend === null || local.spend.entryCount > 0,
    `a local run with 3 turns was answered as a reading of zero: ${JSON.stringify(local.spend)}`,
  );
  assert.match(local.reason ?? "", /local/, "and the answer says why there is no reading");
});
