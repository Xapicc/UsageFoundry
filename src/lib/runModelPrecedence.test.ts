import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import type { AgentDefinition } from "./agents";

/**
 * Covers which model `createRun` freezes onto `runs.model` when a run names
 * none and is started as an agent that does.
 *
 * Settings says the Default model is used "when neither the run, its template
 * nor its agent names one", and the model decider stands aside for an agent's
 * model as the operator's answer for that role. `createRun` froze
 * `settings.defaultModel` first, and the CLI's explicit `--model` outranks the
 * agent's, so a run started as a Haiku agent with the form's model blank ran on
 * the install's default at the default's price. Nothing throws and the run page
 * shows `runs.model`, which read as chosen either way.
 *
 * Through the real `createRun` because the function is right in isolation and
 * the fault was what the call site handed it. `maxConcurrentRuns: 0` and an
 * unspawnable `CLAUDE_BIN` keep anything from starting; the environment is set
 * before anything is required, for `config.ts`'s reason.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-runmodel-")));
fs.mkdirSync(path.join(tmp, "main", "notes"), { recursive: true });
fs.mkdirSync(path.join(tmp, "claude", "projects"), { recursive: true });

process.env.WORKSPACE_ROOTS = `Main=${path.join(tmp, "main")}`;
process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");
process.env.CLAUDE_BIN = path.join(tmp, "no-such-claude");

// `require`, not `import`: imports are hoisted above the environment above.
const config = require("./config") as typeof import("./config");
assert.equal(
  config.DATA_DIR,
  process.env.DATA_DIR,
  "config was already loaded by another test file in this process — refusing to run against the real database",
);

const { createRun } = require("./orchestrator") as typeof import("./orchestrator");
const { getSettings, saveSettings } = require("./settings") as typeof import("./settings");

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const [DEFAULT, AGENT_MODEL, OWN] = getSettings()
  .modelCatalogue.filter((entry) => entry.enabled)
  .map((entry) => entry.id);
assert.ok(OWN, "the seeded catalogue has fewer than three enabled models");

const reviewer: AgentDefinition = {
  name: "reviewer",
  description: "Reads a diff.",
  prompt: "You review code.",
  model: AGENT_MODEL,
};

function admit(over: { model?: string | null; agent?: AgentDefinition | null; provider?: "claude" | "codex" | null }) {
  return createRun({
    folder: "notes",
    mountId: "main",
    isolate: false,
    prompt: "pin the model rung",
    budget: { maxIterations: 1 },
    origin: "form",
    ...over,
  });
}

describe("the model createRun freezes for a run started as an agent", () => {
  saveSettings({ maxConcurrentRuns: 0, defaultModel: DEFAULT });

  it("takes the agent's model over the install's default when the run names none", () => {
    assert.equal(admit({ agent: reviewer }).model, AGENT_MODEL);
  });

  it("takes the run's own model over the agent's", () => {
    assert.equal(admit({ agent: reviewer, model: OWN }).model, OWN);
  });

  it("falls to the default for an agent that names no model, or no agent at all", () => {
    assert.equal(admit({ agent: { ...reviewer, model: null } }).model, DEFAULT);
    assert.equal(admit({ agent: { ...reviewer, model: "  " } }).model, DEFAULT);
    assert.equal(admit({}).model, DEFAULT);
  });

  // The agent's model is a Claude id, and `codex exec -m` is a spawn that fails
  // on one — `frozenRunModel`'s reason for keeping the two defaults apart.
  it("never hands a Codex run the agent's Claude id", () => {
    assert.notEqual(admit({ agent: reviewer, provider: "codex" }).model, AGENT_MODEL);
  });
});
