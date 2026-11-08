import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { DEFAULTS, type Settings } from "./settings";
import {
  denyListToSeed,
  TOKENECONOMIZER_HOME,
  TOKENECONOMIZER_PLUGIN_DIR,
  tokenEconomizerEnv,
  tokenEconomizerFor,
} from "./tokenEconomizer";

/**
 * What a work cycle's TokenEconomizer hooks are given. Both failures here are
 * silent and one of them costs money: a mechanism left out of the environment
 * falls through to the plugin's config files, which any cycle can write, and
 * then to the plugin's own default — `nudge` for the loop guard, whose judge is
 * a billed `claude -p` that writes no transcript and so reaches no meter here.
 */

const on = (over: Partial<Settings> = {}): Settings => ({
  ...DEFAULTS,
  tokenEconomizer: true,
  ...over,
});

describe("tokenEconomizerEnv", () => {
  it("names every mechanism, an `off` one included", () => {
    const env = tokenEconomizerEnv(on());
    assert.equal(env.TE_TOOLPRUNE, "auto");
    assert.equal(env.TE_MICROSKILLS, "off");
    assert.equal(env.TE_LOOPGUARD, "off");
  });

  it("spells this app's `on` out rather than passing the plugin's word for it", () => {
    assert.equal(
      tokenEconomizerEnv(on({ tokenEconomizerMicroskills: "on" })).TE_MICROSKILLS,
      "envfacts+distiller",
    );
    assert.equal(
      tokenEconomizerEnv(on({ tokenEconomizerMicroskills: "envfacts" })).TE_MICROSKILLS,
      "envfacts",
    );
  });

  it("pins the interpreter and the state root rather than leaving them to PATH and HOME", () => {
    // The agent PATH puts an agent-writable directory first, and the launcher
    // runs the first `python3` it finds.
    const env = tokenEconomizerEnv(on());
    assert.equal(env.TE_PYTHON, "/usr/bin/python3");
    assert.equal(env.TOKENECONOMIZER_HOME, TOKENECONOMIZER_HOME);
    assert.equal(env.TE_MODE, "headless");
  });

  it("passes the quiet period as a whole number of minutes", () => {
    assert.equal(tokenEconomizerEnv(on()).TE_TOOLPRUNE_QUIET_MINUTES, "60");
    assert.equal(
      tokenEconomizerEnv(on({ tokenEconomizerQuietMinutes: 0 })).TE_TOOLPRUNE_QUIET_MINUTES,
      "0",
    );
  });
});

/**
 * What one worktree slot is given so it matches the rest of its repository.
 * Wrong one way, a run carries tools its repository never uses; wrong the
 * other, a tool somebody gave back with `toolprune restore` disappears again,
 * or a permission pattern planted in the plugin's state reaches every new slot.
 */
describe("denyListToSeed", () => {
  const slotA = "/workspace/.uf-worktrees/repo-1/.claude/settings.local.json";
  const slotB = "/workspace/.uf-worktrees/repo-2/.claude/settings.local.json";

  it("takes the union of what the plugin applied in every checkout", () => {
    assert.deepEqual(
      denyListToSeed({
        appliedByPath: { [slotA]: ["NotebookEdit", "WebFetch"], [slotB]: ["TodoWrite"] },
        keptByPath: {},
        alreadyHere: [],
      }),
      ["NotebookEdit", "TodoWrite", "WebFetch"],
    );
  });

  it("leaves out what this checkout already has", () => {
    assert.deepEqual(
      denyListToSeed({
        appliedByPath: { [slotA]: ["NotebookEdit", "WebFetch"] },
        keptByPath: {},
        alreadyHere: ["NotebookEdit"],
      }),
      ["WebFetch"],
    );
  });

  it("never seeds a tool somebody gave back in any checkout", () => {
    assert.deepEqual(
      denyListToSeed({
        appliedByPath: { [slotA]: ["NotebookEdit", "WebFetch"] },
        keptByPath: { [slotB]: ["WebFetch"] },
        alreadyHere: [],
      }),
      ["NotebookEdit"],
    );
  });

  it("carries tool names and never a permission pattern", () => {
    // The state file is writable by every work cycle; a pattern copied from it
    // would be this app writing a permission rule into every new checkout.
    assert.deepEqual(
      denyListToSeed({
        appliedByPath: {
          [slotA]: ["Bash(rm:*)", "Read(//**)", "mcp__github__create_issue", "not a tool", "Grep"],
        },
        keptByPath: {},
        alreadyHere: [],
      }),
      ["Grep", "mcp__github__create_issue"],
    );
  });

  it("reads a record of any other shape as having nothing to seed", () => {
    for (const appliedByPath of [undefined, null, [], "x", { [slotA]: "NotebookEdit" }, { [slotA]: [1, null] }]) {
      assert.deepEqual(denyListToSeed({ appliedByPath, keptByPath: null, alreadyHere: [] }), []);
    }
  });
});

describe("tokenEconomizerFor", () => {
  it("loads nothing while the switch is off, whatever the modes say", () => {
    assert.deepEqual(tokenEconomizerFor({ ...DEFAULTS, tokenEconomizerLoopguard: "nudge" }, "claude"), {
      kind: "off",
    });
  });

  it("loads nothing into a Codex or local-model cycle", () => {
    // A local cycle is spawned through Claude Code, so nothing about the argv
    // would stop it: the plugin's judge would ask the local server for `haiku`.
    assert.deepEqual(tokenEconomizerFor(on(), "codex"), { kind: "off" });
    assert.deepEqual(tokenEconomizerFor(on(), "local"), { kind: "off" });
  });

  it("says it is unavailable rather than loading a directory that is not there", () => {
    const present = fs.existsSync(
      path.join(TOKENECONOMIZER_PLUGIN_DIR, ".claude-plugin", "plugin.json"),
    );
    for (const provider of ["claude", null] as const) {
      const cycle = tokenEconomizerFor(on(), provider);
      assert.equal(cycle.kind, present ? "ready" : "unavailable");
      if (cycle.kind === "ready") assert.equal(cycle.pluginDir, TOKENECONOMIZER_PLUGIN_DIR);
    }
  });
});
