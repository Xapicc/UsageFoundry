import type { McpServerStatusDTO, PluginMcpDTO } from "./apiTypes";

/**
 * Which MCP servers a work cycle actually got, read from the CLI's own
 * `system:init` event.
 *
 * This app writes one server into a cycle's config (`uf`) and lets the rest
 * arrive on their own — the operator's `~/.claude`, enabled plugins — because a
 * run's MCP config is deliberately not strict (`cycleInvocation.ts`). So the
 * only complete account of what a cycle could call is the one the CLI gives as
 * it starts: every server with its status, and every tool by name. Every
 * cycle's init is already stored whole (`handleStreamLine`); this reads it.
 *
 * Client-safe: `logLine.ts` renders it in the browser from the replayed event,
 * and the plugins route runs `pluginMcpSightings` over rows `db.ts` reads.
 */

/**
 * The prefix the CLI gives a server's tools: `mcp__<name>__`, with every
 * character outside `[A-Za-z0-9_-]` replaced by `_`. Observed on CLI 2.1.280:
 * `plugin:local-reader:local` → `mcp__plugin_local-reader_local__`, and
 * `claude.ai Claude Docs` → `mcp__claude_ai_Claude_Docs__`.
 *
 * A wrong prefix counts no tools and says nothing, which reads exactly like a
 * server that offered none — hence its own tests.
 */
export function mcpToolPrefix(server: string): string {
  return `mcp__${server.replace(/[^A-Za-z0-9_-]/g, "_")}__`;
}

/** The servers of one `system:init` event, or null for anything else. */
export function mcpServersOfInit(raw: unknown): McpServerStatusDTO[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.mcp_servers)) return null;
  const tools = Array.isArray(raw.tools)
    ? raw.tools.filter((tool): tool is string => typeof tool === "string")
    : [];
  const servers: McpServerStatusDTO[] = [];
  for (const entry of raw.mcp_servers) {
    if (!isRecord(entry) || typeof entry.name !== "string") continue;
    const prefix = mcpToolPrefix(entry.name);
    servers.push({
      name: entry.name,
      status: typeof entry.status === "string" ? entry.status : "unknown",
      source: typeof entry.source === "string" ? entry.source : null,
      tools: tools.filter((tool) => tool.startsWith(prefix)).length,
    });
  }
  return servers;
}

/**
 * The run log's line for one cycle: connected servers with their tool counts,
 * the failed ones by name, then a count of those waiting for a sign-in.
 *
 * The last are mostly claude.ai connectors nobody has authorised — thirty on
 * the install this was written against — and naming each would bury the
 * servers the line is for.
 */
export function describeMcpServers(servers: readonly McpServerStatusDTO[]): string {
  const parts: string[] = [];
  for (const server of servers) {
    if (server.status !== "connected") continue;
    parts.push(`${server.name} ${toolCount(server.tools)}`);
  }
  const failed = servers.filter((server) => server.status === "failed").map((server) => server.name);
  if (failed.length > 0) parts.push(`failed: ${failed.join(", ")}`);
  const signIn = servers.filter((server) => server.status === "needs-auth").length;
  if (signIn > 0) parts.push(`${signIn} need${signIn === 1 ? "s" : ""} sign-in`);
  const other = servers.filter((server) => !["connected", "failed", "needs-auth"].includes(server.status));
  for (const server of other) parts.push(`${server.name} ${server.status}`);
  return parts.length > 0 ? parts.join(" · ") : "none";
}

/** `6 tools`, `1 tool`, or `no tools`: a connected server can list none. */
export function toolCount(tools: number): string {
  if (tools === 0) return "no tools";
  return `${tools} tool${tools === 1 ? "" : "s"}`;
}

/** A stored `system:init`, newest first, as `recentCycleInits` returns them. */
export interface CycleInit {
  runId: string;
  ts: number;
  raw: unknown;
}

/**
 * For each plugin path, its MCP servers in the newest cycle that loaded it.
 *
 * Matched on the path the init lists for the plugin, which is the path this app
 * passed as `--plugin-dir` and therefore the enabled path itself; its servers
 * are the ones the CLI named `plugin:<the manifest's name>:<server>`. A plugin
 * in none of `inits` is absent from the result, and the page says "not loaded
 * by a recent cycle" rather than showing a status it does not have.
 */
export function pluginMcpSightings(
  paths: readonly string[],
  inits: readonly CycleInit[],
): Map<string, PluginMcpDTO> {
  const found = new Map<string, PluginMcpDTO>();
  for (const init of inits) {
    if (found.size === paths.length) break;
    if (!isRecord(init.raw) || !Array.isArray(init.raw.plugins)) continue;
    const servers = mcpServersOfInit(init.raw);
    if (!servers) continue;
    for (const plugin of init.raw.plugins) {
      if (!isRecord(plugin) || typeof plugin.path !== "string" || typeof plugin.name !== "string") continue;
      if (!paths.includes(plugin.path) || found.has(plugin.path)) continue;
      const prefix = `plugin:${plugin.name}:`;
      found.set(plugin.path, {
        runId: init.runId,
        ts: init.ts,
        servers: servers.filter((server) => server.name.startsWith(prefix)),
      });
    }
  }
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
