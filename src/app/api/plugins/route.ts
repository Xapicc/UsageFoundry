import { NextResponse } from "next/server";
// Relative rather than aliased, which is what every route with a test here
// does: `node --test` runs the compiled output, and nothing resolves `@/` there.
import type { PluginsReportDTO } from "../../../lib/apiTypes";
import { recentCycleInits } from "../../../lib/db";
import { readJsonObject } from "../../../lib/http";
import { pluginMcpSightings } from "../../../lib/mcpStatus";
import { discoverPlugins, setPluginEnabled } from "../../../lib/plugins";
import { auditMutation } from "../../../lib/requestLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Claude Code plugins found in the workspace mounts, and which are switched on.
 *
 * There is no install step and deliberately so: `plugins.ts` records why the
 * CLI's own registry cannot be written from in here without breaking the
 * operator's host sessions. What this route toggles is a list this app owns,
 * which becomes `--plugin-dir` on every work cycle's argv.
 *
 * `problems` travels beside `plugins` for the reason `/api/agents` answers with
 * `ambient`: the failures worth knowing about are the ones where something is
 * *absent* — a malformed manifest, an enabled plugin whose repository has been
 * unmounted — and a list that simply omits them is a page that cannot explain
 * why the plugin an operator is looking at is not there.
 */
export async function GET() {
  return NextResponse.json(report());
}

/**
 * How many recent work cycles to search for a plugin's MCP servers. Fifty
 * cycles is hours of work on a busy install and days on a quiet one; a plugin
 * none of them loaded is shown as not loaded recently, not as failing.
 */
const INITS_SEARCHED = 50;

/**
 * Discovery, plus what each plugin's MCP servers did in the newest cycle that
 * loaded it. A plugin can be switched on and still fail to start its server,
 * and nothing else in this app would say so: the CLI reports it in the cycle's
 * `system:init` and nowhere else.
 */
function report(): PluginsReportDTO {
  const { plugins, problems } = discoverPlugins();
  const withServers = plugins.filter((p) => p.components.includes("mcp")).map((p) => p.path);
  const sightings =
    withServers.length > 0 ? pluginMcpSightings(withServers, recentCycleInits(INITS_SEARCHED)) : new Map();
  return {
    plugins: plugins.map((p) => ({ ...p, mcp: sightings.get(p.path) ?? null })),
    problems,
  };
}

async function postHandler(req: Request) {
  const read = await readJsonObject(req);
  if (!read.ok) return read.response;
  const body = read.body;

  const dir = typeof body.path === "string" ? body.path.trim() : "";
  if (!dir) {
    return NextResponse.json({ error: "A plugin directory path is required." }, { status: 400 });
  }
  // Narrowed against the literal rather than coerced: `Boolean(body.enabled)`
  // would read a missing field as "switch it off", so a malformed request would
  // silently disable a plugin instead of being refused.
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { error: "`enabled` must be true or false." },
      { status: 400 },
    );
  }

  try {
    setPluginEnabled(dir, body.enabled);
  } catch (err) {
    // Only switching on can land here — switching off proves nothing, so a
    // plugin whose folder or manifest has gone can always be turned off.
    // Containment failures and malformed manifests both arrive as a sentence
    // naming the directory, because the page has to show it.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }

  return NextResponse.json(report());
}

/** Wrapped so the request that changed what every agent loads is on the audit log. */
export const POST = auditMutation(postHandler);
