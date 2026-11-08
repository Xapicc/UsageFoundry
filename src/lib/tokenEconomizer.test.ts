import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { DEFAULTS, type Settings } from "./settings";
import {
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
