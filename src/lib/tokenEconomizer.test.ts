import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { DEFAULTS, type Settings } from "./settings";
import {
  denyListToSeed,
  repoReportOf,
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

  it("protects this app's own MCP tools from pruning", () => {
    // `request_stack`, `release_task` and `add_task_dependency` are rarely
    // called, so tool pruning reads them as unused. The server key `uf` is
    // pinned by `writeMcpConfig`'s own test in chat.test.ts, and the CLI names
    // its tools `mcp__uf__*`; this is the third spelling of the same name.
    assert.equal(tokenEconomizerEnv(on()).TE_TOOLPRUNE_PROTECT, "mcp__uf__*");
    assert.equal(
      tokenEconomizerEnv(on({ tokenEconomizerToolprune: "off" })).TE_TOOLPRUNE_PROTECT,
      "mcp__uf__*",
    );
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

  it("never seeds this app's own MCP tools, and still seeds every other tool", () => {
    // `untool_applied.json` can still list one from before the protection, or
    // one a cycle planted, and the plugin's fold only cleans the checkout it
    // folds.
    assert.deepEqual(
      denyListToSeed({
        appliedByPath: {
          [slotA]: ["mcp__uf__complete_task", "mcp__github__create_issue", "NotebookEdit"],
          [slotB]: ["mcp__uf__request_stack"],
        },
        keptByPath: {},
        alreadyHere: [],
      }),
      ["NotebookEdit", "mcp__github__create_issue"],
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

/**
 * The Project manager's record of one repository, off `te status --json` and
 * the applied-tools record. A field read off the wrong key renders as 0, and a
 * 0 there reads as "the plugin did nothing" — a claim about the plugin that is
 * really a misread here.
 */
describe("repoReportOf", () => {
  /** `te status --json` as the plugin at `cb42207` prints it, trimmed to what is read. */
  const status = {
    config: {
      toolprune: { toolprune: "auto" },
      microskills: { microskills: "envfacts+distiller" },
      loopguard: { loopguard: "nudge" },
    },
    microskills: { profile: "envfacts+distiller", injected_lines: 3 },
    toolprune: { mode: "auto", proposal: ["TodoWrite", "NotebookEdit"], applied: ["NotebookEdit"] },
    loopguard: { mode: "nudge" },
    ledger: {
      sessions: 14,
      priced_sessions: 12,
      overhead_frac: 0.021,
      nudges: 2,
      aborts: 1,
      injected_sessions: 9,
    },
  };
  const record = {
    by_path: {
      "/w/.uf-worktrees/r-1/.claude/settings.local.json": ["NotebookEdit", "WebFetch"],
      "/w/.uf-worktrees/r-2/.claude/settings.local.json": ["NotebookEdit"],
      "/w/.uf-worktrees/r-3/.claude/settings.local.json": [],
    },
    kept: { "/w/r/.claude/settings.local.json": ["WebSearch"] },
  };

  it("reads every figure off the key the plugin writes it under", () => {
    assert.deepEqual(repoReportOf(status, record), {
      sessions: 14,
      toolprune: {
        mode: "auto",
        leftOut: ["NotebookEdit", "WebFetch"],
        // A checkout whose list is empty carries nothing it wrote.
        checkouts: 2,
        proposed: ["NotebookEdit", "TodoWrite"],
        givenBack: ["WebSearch"],
      },
      // The plugin's `envfacts+distiller` is this app's `on`.
      microskills: { mode: "on", facts: 3, injectedSessions: 9 },
      loopguard: { mode: "nudge", redirects: 2, stillStuck: 1 },
      overheadShare: 0.021,
    });
  });

  it("reads an empty repository as nothing done, with no overhead figure at all", () => {
    const report = repoReportOf({ ledger: { sessions: 0, priced_sessions: 0, overhead_frac: 0 } }, null);
    assert.equal(report.sessions, 0);
    assert.deepEqual(report.toolprune.leftOut, []);
    assert.equal(report.toolprune.checkouts, 0);
    // No priced session is no figure, which is not the same claim as 0%.
    assert.equal(report.overheadShare, null);
    assert.equal(report.toolprune.mode, "off");
  });

  it("takes nothing of the wrong type from a state file any cycle can write", () => {
    const report = repoReportOf(
      {
        ledger: { sessions: "14", nudges: -3, aborts: Number.NaN, priced_sessions: 1, overhead_frac: 7 },
        toolprune: { proposal: "TodoWrite" },
        microskills: { injected_lines: null },
        config: { loopguard: { loopguard: "stop" } },
      },
      { by_path: { a: "NotebookEdit", b: [1, "Grep"] }, kept: [] },
    );
    assert.equal(report.sessions, 0);
    assert.equal(report.loopguard.redirects, 0);
    assert.equal(report.loopguard.stillStuck, 0);
    assert.deepEqual(report.toolprune.proposed, []);
    assert.deepEqual(report.toolprune.leftOut, ["Grep"]);
    assert.equal(report.microskills.facts, 0);
    // A share is a fraction: anything past 1 is clamped rather than drawn as 700%.
    assert.equal(report.overheadShare, 1);
    // `stop` is read by the plugin and acts as `nudge`.
    assert.equal(report.loopguard.mode, "nudge");
  });
});
