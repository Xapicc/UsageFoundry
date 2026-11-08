import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  TOKENECONOMIZER_LOOPGUARD,
  TOKENECONOMIZER_MICROSKILLS,
  TOKENECONOMIZER_TOOLPRUNE,
  type RunProviderDTO,
  type TokenEconomizerLoopguard,
  type TokenEconomizerMicroskills,
  type TokenEconomizerToolprune,
} from "./apiTypes";
import { opsLog, recordOpsEvent, type OpsFields } from "./ops";
import type { Settings } from "./settings";

/**
 * Microsoft's TokenEconomizer, loaded into Claude Code work cycles as a plugin.
 *
 * It is a set of Claude Code hooks over a stdlib-only Python package
 * (github.com/microsoft/TokenEconomizer, Apache-2.0). It learns from a
 * repository's finished sessions and acts on later ones through three
 * mechanisms: tool pruning (a `permissions.deny` list in the checkout's
 * `.claude/settings.local.json` for tools the repository's sessions never use),
 * micro-skills (short repository facts injected at session start) and a loop
 * guard (a judge model that redirects a turn stuck in a failing loop).
 *
 * ## How it reaches a cycle
 *
 * As one more `--plugin-dir`, per cycle, for `plugins.ts`' reason: the CLI's own
 * plugin registry lives in the bind-mounted `~/.claude` and records absolute
 * paths, so installing it there would break the host's copy or the
 * container's. The code is in the image, root-owned and world-readable, so no
 * agent can rewrite what every agent's hooks run.
 *
 * ## What it is given, and why each one is pinned
 *
 * Its settings arrive as `TE_*` environment variables, which outrank both of
 * its config files. Those files live in the state root, which the hooks write
 * as the agent uid, so any work cycle can write them; the three mechanisms the
 * operator chose in Settings are therefore the ones in force whatever a cycle
 * planted there. `TE_PYTHON` names the image's interpreter because the agent
 * `PATH` puts the agent-writable `/home/node/pytools/bin` first, and the
 * launcher otherwise runs the first `python3` it finds.
 *
 * The state root is a named volume (`docker-compose.yml`): what the plugin has
 * learned about a repository is the whole of its value, and the writable layer
 * loses it on every rebuild.
 */

export const TOKENECONOMIZER_ROOT = "/opt/tokeneconomizer";
export const TOKENECONOMIZER_HOME = "/home/node/.tokeneconomizer";
export const TOKENECONOMIZER_PLUGIN_DIR = path.join(TOKENECONOMIZER_ROOT, "plugin");

/** The image's own interpreter, never one found on the agent `PATH`. */
const IMAGE_PYTHON = "/usr/bin/python3";

const PLUGIN_MANIFEST = path.join(TOKENECONOMIZER_PLUGIN_DIR, ".claude-plugin", "plugin.json");
const BOOTSTRAP = path.join(TOKENECONOMIZER_PLUGIN_DIR, "scripts", "te_bootstrap.py");

/**
 * How long an availability answer is reused. It is asked on every cycle and
 * on the settings page's poll, and can only change with a rebuild.
 */
const PROBE_TTL_MS = 60_000;

const probe = ((globalThis as unknown as {
  __ufTokenEconomizerProbeV1?: { at: number; ok: boolean };
}).__ufTokenEconomizerProbeV1 ??= { at: 0, ok: false });

/**
 * Whether the image carries the plugin. False on a build with
 * `TOKENECONOMIZER_REF` empty and under `npm run dev` on a host.
 */
export function tokenEconomizerAvailable(): boolean {
  const now = Date.now();
  if (now - probe.at < PROBE_TTL_MS) return probe.ok;
  let ok: boolean;
  try {
    ok = fs.statSync(PLUGIN_MANIFEST).isFile() && fs.statSync(BOOTSTRAP).isFile();
  } catch {
    ok = false;
  }
  probe.at = now;
  probe.ok = ok;
  return ok;
}

export const TOKENECONOMIZER_MISSING_REASON =
  `TokenEconomizer is not installed at ${TOKENECONOMIZER_ROOT} — this image was built with TOKENECONOMIZER_REF empty`;

export function isTokenEconomizerToolprune(value: unknown): value is TokenEconomizerToolprune {
  return (TOKENECONOMIZER_TOOLPRUNE as readonly unknown[]).includes(value);
}

export function isTokenEconomizerMicroskills(value: unknown): value is TokenEconomizerMicroskills {
  return (TOKENECONOMIZER_MICROSKILLS as readonly unknown[]).includes(value);
}

export function isTokenEconomizerLoopguard(value: unknown): value is TokenEconomizerLoopguard {
  return (TOKENECONOMIZER_LOOPGUARD as readonly unknown[]).includes(value);
}

/**
 * The environment a cycle's hooks read their settings from.
 *
 * Every mechanism is named explicitly, `off` included: a mechanism left out
 * would fall through to the state root's config files, which a cycle can
 * write, and then to the plugin's own default — `nudge` for the loop guard,
 * whose judge is a billed call no meter here sees.
 *
 * `on` for micro-skills is spelled out as the plugin's `envfacts+distiller`
 * rather than passed as `on`, so what this app's switch means cannot move with
 * the plugin's idea of `on`.
 *
 * `TE_MODE=headless` because nobody is at a work cycle's terminal: the plugin
 * then delivers a loop-guard notice in the turn's reply rather than to a UI.
 */
export function tokenEconomizerEnv(
  s: Pick<
    Settings,
    "tokenEconomizerToolprune" | "tokenEconomizerMicroskills" | "tokenEconomizerLoopguard"
  >,
): Record<string, string> {
  return {
    TOKENECONOMIZER_HOME,
    TE_PYTHON: IMAGE_PYTHON,
    TE_MODE: "headless",
    TE_TOOLPRUNE: s.tokenEconomizerToolprune,
    TE_MICROSKILLS:
      s.tokenEconomizerMicroskills === "on" ? "envfacts+distiller" : s.tokenEconomizerMicroskills,
    TE_LOOPGUARD: s.tokenEconomizerLoopguard,
  };
}

/** What one cycle gets. */
export type TokenEconomizerCycle =
  | { kind: "off" }
  | { kind: "unavailable"; reason: string }
  | { kind: "ready"; pluginDir: string; env: Record<string, string> };

/**
 * Whether a cycle of this provider loads the plugin, and with what.
 *
 * Claude runs only. A Codex cycle is a different CLI with a different plugin
 * mechanism. A local-model cycle is spawned through Claude Code, but the
 * plugin's own model calls (the loop guard's judge, the micro-skill proposer)
 * would inherit its endpoint and ask a local server for `haiku`, and its turns
 * would teach the repository's Claude history a different model's turn length.
 */
export function tokenEconomizerFor(
  s: Settings,
  provider: RunProviderDTO | null,
): TokenEconomizerCycle {
  if (!s.tokenEconomizer) return { kind: "off" };
  if (provider === "codex" || provider === "local") return { kind: "off" };
  if (!tokenEconomizerAvailable()) {
    return { kind: "unavailable", reason: TOKENECONOMIZER_MISSING_REASON };
  }
  return { kind: "ready", pluginDir: TOKENECONOMIZER_PLUGIN_DIR, env: tokenEconomizerEnv(s) };
}

/**
 * `te toolprune refresh-catalog` once per server process, before the first
 * cycle that loads the plugin.
 *
 * Tool pruning can only propose tools it knows a session loaded, and a session
 * transcript does not record the tool list; without the snapshot this writes,
 * only deferred tools are ever proposed. The probe is a `claude -p` the plugin
 * kills at its `init` event, before anything is sent to the model, so it bills
 * nothing. Once per process because the CLI only changes with the image, and a
 * new image is a new process — which is the "again after Claude Code updates"
 * the plugin's README asks for.
 *
 * Never fails a cycle. A refresh that does not finish leaves pruning working
 * on less evidence, which is said in the operations log and nowhere else.
 */
export function ensureTokenEconomizerCatalog(
  env: NodeJS.ProcessEnv,
  credentials: { uid?: number; gid?: number },
): Promise<void> {
  catalog.pending ??= refreshCatalog(env, credentials);
  return catalog.pending;
}

const catalog = ((globalThis as unknown as {
  __ufTokenEconomizerCatalogV1?: { pending: Promise<void> | null };
}).__ufTokenEconomizerCatalogV1 ??= { pending: null });

/** The probe waits up to 60 s for the init event; this bounds the rest. */
const CATALOG_TIMEOUT_MS = 90_000;

function refreshCatalog(
  env: NodeJS.ProcessEnv,
  credentials: { uid?: number; gid?: number },
): Promise<void> {
  return new Promise((resolve) => {
    let stderr = "";
    const child = spawn(
      IMAGE_PYTHON,
      [BOOTSTRAP, "cli", "--host", "claude", "toolprune", "refresh-catalog"],
      { env, ...credentials, cwd: "/", stdio: ["ignore", "ignore", "pipe"] },
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), CATALOG_TIMEOUT_MS);
    timer.unref?.();
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 2_000) stderr += chunk.toString("utf8");
    });
    const finish = (detail: OpsFields & { ok: boolean }) => {
      clearTimeout(timer);
      if (detail.ok) opsLog("info", "token_economizer.catalog_refreshed", detail);
      else recordOpsEvent("warn", "token_economizer.catalog_failed", detail);
      resolve();
    };
    child.on("error", (err) => finish({ ok: false, error: err.message }));
    child.on("close", (code, signal) =>
      finish({ ok: code === 0, code, signal, stderr: stderr.trim().slice(0, 500) || null }),
    );
  });
}
