import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  describeMcpServers,
  mcpServersOfInit,
  mcpToolPrefix,
  pluginMcpSightings,
  type CycleInit,
} from "./mcpStatus";

/**
 * Reading a cycle's `system:init` for its MCP servers. Every way this goes
 * wrong is quiet: a prefix that matches no tools reads as a server that
 * offered none, and a plugin matched to the wrong cycle reads as one that
 * started when it did not.
 *
 * The shapes below are cut down from real init events on CLI 2.1.280.
 */
const LOCAL_READER = "/workspace/LocalModelOffload/plugin";

function init(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "system",
    subtype: "init",
    tools: [
      "Bash",
      "mcp__uf__list_my_tasks",
      "mcp__uf__complete_task",
      "mcp__uf_local__local_scan",
      "mcp__plugin_local-reader_local__local_scan",
      "mcp__plugin_local-reader_local__local_explore",
      "mcp__claude_ai_Claude_Docs__batch",
    ],
    mcp_servers: [
      { name: "plugin:local-reader:local", status: "connected", source: "plugin" },
      { name: "daiveloper", status: "failed", source: "user" },
      { name: "uf_local", status: "connected", source: "dynamic" },
      { name: "uf", status: "connected", source: "dynamic" },
      { name: "claude.ai Claude Docs", status: "connected", source: "claudeai" },
      { name: "claude.ai Notion", status: "needs-auth", source: "claudeai" },
      { name: "claude.ai Box", status: "needs-auth", source: "claudeai" },
    ],
    plugins: [
      { name: "local-reader", path: LOCAL_READER, source: "local-reader@inline" },
      { name: "orient", path: "/workspace/orient", source: "orient@inline" },
    ],
    ...overrides,
  };
}

describe("mcpToolPrefix", () => {
  it("turns every character the CLI does not keep into an underscore", () => {
    assert.equal(mcpToolPrefix("uf"), "mcp__uf__");
    assert.equal(mcpToolPrefix("plugin:local-reader:local"), "mcp__plugin_local-reader_local__");
    assert.equal(mcpToolPrefix("claude.ai Claude Docs"), "mcp__claude_ai_Claude_Docs__");
  });
});

describe("mcpServersOfInit", () => {
  it("counts each server's own tools, and does not count uf_local's as uf's", () => {
    const servers = mcpServersOfInit(init());
    assert.deepEqual(
      servers?.map((s) => [s.name, s.status, s.tools]),
      [
        ["plugin:local-reader:local", "connected", 2],
        ["daiveloper", "failed", 0],
        ["uf_local", "connected", 1],
        ["uf", "connected", 2],
        ["claude.ai Claude Docs", "connected", 1],
        ["claude.ai Notion", "needs-auth", 0],
        ["claude.ai Box", "needs-auth", 0],
      ],
    );
  });

  it("is null for anything that is not an init with a server list", () => {
    assert.equal(mcpServersOfInit(undefined), null);
    assert.equal(mcpServersOfInit({ subtype: "init" }), null);
    assert.equal(mcpServersOfInit([]), null);
  });
});

describe("describeMcpServers", () => {
  it("names connected servers with their tools, failures by name, and sign-ins as a count", () => {
    assert.equal(
      describeMcpServers(mcpServersOfInit(init()) ?? []),
      "plugin:local-reader:local 2 tools · uf_local 1 tool · uf 2 tools · claude.ai Claude Docs 1 tool · failed: daiveloper · 2 need sign-in",
    );
  });

  it("says when a connected server listed no tools, which is the local reader with its model unloaded", () => {
    const servers = mcpServersOfInit(init({ tools: ["mcp__uf__list_my_tasks"] })) ?? [];
    assert.match(describeMcpServers(servers), /^plugin:local-reader:local no tools · /);
  });

  it("keeps a status it has no wording for", () => {
    assert.equal(describeMcpServers([{ name: "x", status: "pending", source: null, tools: 0 }]), "x pending");
    assert.equal(describeMcpServers([]), "none");
  });
});

describe("pluginMcpSightings", () => {
  const cycle = (runId: string, ts: number, raw: unknown): CycleInit => ({ runId, ts, raw });

  it("takes the newest cycle that loaded the plugin, and only that plugin's servers", () => {
    const withoutIt = init({ plugins: [{ name: "orient", path: "/workspace/orient" }] });
    const failed = init({
      tools: ["Bash"],
      mcp_servers: [{ name: "plugin:local-reader:local", status: "failed", source: "plugin" }],
    });
    const sightings = pluginMcpSightings([LOCAL_READER], [
      cycle("newest", 3, withoutIt),
      cycle("middle", 2, failed),
      cycle("oldest", 1, init()),
    ]);
    assert.deepEqual(sightings.get(LOCAL_READER), {
      runId: "middle",
      ts: 2,
      servers: [{ name: "plugin:local-reader:local", status: "failed", source: "plugin", tools: 0 }],
    });
  });

  it("leaves out a plugin no cycle loaded, rather than reporting it as failing", () => {
    const sightings = pluginMcpSightings(["/workspace/elsewhere"], [cycle("r", 1, init())]);
    assert.equal(sightings.has("/workspace/elsewhere"), false);
  });

  it("does not take another plugin's servers when names share a start", () => {
    const raw = init({
      mcp_servers: [
        { name: "plugin:local-reader-probe:local", status: "connected", source: "plugin" },
        { name: "plugin:local-reader:local", status: "connected", source: "plugin" },
      ],
    });
    const servers = pluginMcpSightings([LOCAL_READER], [cycle("r", 1, raw)]).get(LOCAL_READER)?.servers;
    assert.deepEqual(servers?.map((s) => s.name), ["plugin:local-reader:local"]);
  });
});
