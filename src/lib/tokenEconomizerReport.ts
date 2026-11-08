import type { ProjectTokenEconomizerDTO, TokenEconomizerSwitchDTO } from "./apiTypes";
import { childEnv } from "./orchestrator";
import { childCredentials } from "./privsep";
import { getSettings } from "./settings";
import {
  readAppliedRecord,
  readTeStatus,
  repoReportOf,
  tokenEconomizerAvailable,
  tokenEconomizerEnv,
} from "./tokenEconomizer";

/**
 * What the Project manager shows of TokenEconomizer: per repository, what the
 * plugin recorded doing.
 *
 * **Records, never savings.** The plugin's published saving came from running
 * the same benchmark tasks with and without it; a live install never runs a
 * task twice, so nothing here is compared against anything, and the page says
 * so rather than letting a count read as a result. Its own model calls are the
 * one cost it records, and they are shown as what they are.
 *
 * Read per project on demand, never per page: one `te status` is a Python
 * child, and the Project manager lists up to a page of repositories that it
 * reads only on load, after a press and on Refresh.
 */

export function tokenEconomizerSwitch(): TokenEconomizerSwitchDTO {
  if (!tokenEconomizerAvailable()) return "unavailable";
  return getSettings().tokenEconomizer ? "on" : "off";
}

export async function projectTokenEconomizer(dir: string): Promise<ProjectTokenEconomizerDTO> {
  const state = tokenEconomizerSwitch();
  if (state !== "on") return { state };
  const env = childEnv(tokenEconomizerEnv(getSettings()));
  const status = await readTeStatus(dir, { env, credentials: childCredentials() });
  if (!status.ok) return { state: "failed", reason: status.reason };
  const record = readAppliedRecord(status.state);
  if (!record.ok) return { state: "failed", reason: record.reason };
  return { state: "ready", report: repoReportOf(status.json, record.record) };
}
