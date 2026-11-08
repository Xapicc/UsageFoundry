import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  TOKENECONOMIZER_LOOPGUARD,
  TOKENECONOMIZER_MICROSKILLS,
  TOKENECONOMIZER_TOOLPRUNE,
  type RunProviderDTO,
  type TokenEconomizerLoopguard,
  type TokenEconomizerRepoReportDTO,
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
 *
 * `TE_TOOLPRUNE_QUIET_MINUTES` is pinned for the mechanisms' reason, and it is
 * the operator's because it trades one cost against another: below the prompt
 * cache's lifetime, a deny list can land between two cycles of a conversation
 * that is still warm, and its next resume pays to write the whole prefix again.
 */
export function tokenEconomizerEnv(
  s: Pick<
    Settings,
    | "tokenEconomizerToolprune"
    | "tokenEconomizerMicroskills"
    | "tokenEconomizerLoopguard"
    | "tokenEconomizerQuietMinutes"
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
    TE_TOOLPRUNE_QUIET_MINUTES: String(s.tokenEconomizerQuietMinutes),
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

async function refreshCatalog(
  env: NodeJS.ProcessEnv,
  credentials: { uid?: number; gid?: number },
): Promise<void> {
  const res = await runTe(["--host", "claude", "toolprune", "refresh-catalog"], {
    env,
    credentials,
    cwd: "/",
    timeoutMs: CATALOG_TIMEOUT_MS,
  });
  const detail = {
    ok: res.code === 0,
    code: res.code,
    signal: res.signal,
    error: res.error,
    stderr: res.stderr.trim().slice(0, 500) || null,
  };
  if (detail.ok) opsLog("info", "token_economizer.catalog_refreshed", detail);
  else recordOpsEvent("warn", "token_economizer.catalog_failed", detail);
}

/** What one run of the plugin's `te` command line came back with. */
interface TeResult {
  code: number | null;
  signal: string | null;
  /** Spawn failure, or null when the process started. */
  error: string | null;
  stdout: string;
  stderr: string;
}

/** Enough for `status --json` on a repository with a long history, and no more. */
const TE_OUTPUT_MAX_BYTES = 1_000_000;

/**
 * The plugin's own command line, as the agent uid and never through a shell.
 * Never rejects: every caller is on the run loop's path and treats a failure as
 * "the plugin did not do it", which it then says.
 */
function runTe(
  args: string[],
  o: {
    env: NodeJS.ProcessEnv;
    credentials: { uid?: number; gid?: number };
    cwd: string;
    timeoutMs: number;
  },
): Promise<TeResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(IMAGE_PYTHON, [BOOTSTRAP, "cli", ...args], {
      env: o.env,
      ...o.credentials,
      cwd: o.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), o.timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < TE_OUTPUT_MAX_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 2_000) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, error: err.message, stdout, stderr });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, error: null, stdout, stderr });
    });
  });
}

/* ------------------------------------------------------------------ */
/* Seeding a worktree slot with the repository's deny list             */
/* ------------------------------------------------------------------ */

/**
 * A tool name a seed may carry: a built-in tool or an MCP tool, never a
 * permission pattern.
 *
 * The names come from the plugin's state file, which every work cycle can
 * write. A planted `Bash(rm:*)` or `Read(//**)` is a permission rule rather
 * than a tool, and this app would be the one copying it into every new
 * checkout. A planted bare name such as `Grep` still gets through — that is the
 * same reach the plugin's own pending list already has, and
 * `docs/agent/security/token-economizer.md` records it.
 */
const SEEDABLE_TOOL = /^(?:[A-Z][A-Za-z0-9]*|mcp__[A-Za-z0-9_-]+)$/;

/**
 * The tools to deny in one checkout so it matches the rest of its repository.
 *
 * The plugin records, per settings file, what it added (`by_path`) and what the
 * person gave back with `toolprune restore` (`kept`), and applies a proposal
 * only to the checkout whose session produced it. This app runs a repository's
 * work across a dozen or more reused worktree slots, so without this a slot
 * waits for its own proposal and its own hour of quiet, one slot at a time.
 *
 * A tool given back anywhere is not seeded anywhere: a restore is the person
 * saying they want the tool, and nothing in the record says the reason was
 * specific to one checkout. Pure, and tested, because every way it can be
 * wrong is a tool silently missing from a run or silently left in it.
 */
export function denyListToSeed(o: {
  appliedByPath: unknown;
  keptByPath: unknown;
  alreadyHere: readonly string[];
}): string[] {
  const names = (byPath: unknown): Set<string> => {
    const out = new Set<string>();
    if (!byPath || typeof byPath !== "object" || Array.isArray(byPath)) return out;
    for (const tools of Object.values(byPath as Record<string, unknown>)) {
      if (!Array.isArray(tools)) continue;
      for (const tool of tools) if (typeof tool === "string") out.add(tool);
    }
    return out;
  };
  const kept = names(o.keptByPath);
  const here = new Set(o.alreadyHere);
  return [...names(o.appliedByPath)]
    .filter((tool) => SEEDABLE_TOOL.test(tool) && !kept.has(tool) && !here.has(tool))
    .sort();
}

/** What seeding one slot did. */
export type SlotSeed =
  | { kind: "seeded"; tools: string[] }
  | { kind: "nothing" }
  | { kind: "failed"; reason: string };

/** Each `te` call reads a few small JSON files; a minute means it is stuck. */
const SEED_STEP_TIMEOUT_MS = 60_000;

/**
 * One seed at a time, install-wide. The plugin's record is a read-modify-write
 * of one JSON file per repository, and two slots of one repository seeded at
 * once could each drop the other's entry — after which the plugin would read
 * that slot's deny rules as the person's and never take them back.
 */
const seedQueue = ((globalThis as unknown as {
  __ufTokenEconomizerSeedQueueV1?: { tail: Promise<unknown> };
}).__ufTokenEconomizerSeedQueueV1 ??= { tail: Promise.resolve() });

/**
 * Copy the repository's TokenEconomizer deny list into a worktree slot, through
 * the plugin's own `toolprune apply`, before a new session opens there.
 *
 * Through the plugin rather than by editing `.claude/settings.local.json`
 * directly, so its record of what it added to that file stays true: its
 * `toolprune restore` then takes these entries back like any other, and its
 * next fold sees the session ran under them. Only before a *new* session,
 * because a resumed conversation that met a changed tool list would pay to
 * write its whole cached prefix again — the cost the plugin's own quiet period
 * exists to avoid.
 *
 * Never fails a cycle: a seed that cannot be taken leaves the slot as the
 * plugin alone would have it, and the run's log says so.
 */
export function seedTokenEconomizerSlot(o: {
  slot: string;
  env: NodeJS.ProcessEnv;
  credentials: { uid?: number; gid?: number };
}): Promise<SlotSeed> {
  const next = seedQueue.tail.then(() => seedSlot(o));
  seedQueue.tail = next.catch(() => undefined);
  return next;
}

async function seedSlot(o: {
  slot: string;
  env: NodeJS.ProcessEnv;
  credentials: { uid?: number; gid?: number };
}): Promise<SlotSeed> {
  const status = await readTeStatus(o.slot, o);
  if (!status.ok) return { kind: "failed", reason: status.reason };
  const record = readAppliedRecord(status.state);
  if (!record.ok) return { kind: "failed", reason: record.reason };
  if (record.record === null) return { kind: "nothing" };
  const applied = (status.json.toolprune as { applied?: unknown } | undefined)?.applied;
  const tools = denyListToSeed({
    appliedByPath: record.record.by_path,
    keptByPath: record.record.kept,
    alreadyHere: Array.isArray(applied)
      ? applied.filter((t): t is string => typeof t === "string")
      : [],
  });
  if (tools.length === 0) return { kind: "nothing" };

  const apply = await runTe(["--cwd", o.slot, "--host", "claude", "toolprune", "apply", ...tools], {
    env: o.env,
    credentials: o.credentials,
    cwd: o.slot,
    timeoutMs: SEED_STEP_TIMEOUT_MS,
  });
  if (apply.code !== 0) return { kind: "failed", reason: teFailure("toolprune apply", apply) };
  return { kind: "seeded", tools };
}

/**
 * `te status --json` for one checkout, run as the agent uid, with the state
 * directory it names proved to be under the state root. That path comes out of
 * a child the agent uid runs, and this process reads files under it.
 *
 * Asking settles the checkout in the plugin's index, as any session there
 * would: the plugin keys a repository by its remote or main checkout, so a
 * repository no session has used gets an empty state directory and nothing
 * more.
 */
export async function readTeStatus(
  checkout: string,
  o: { env: NodeJS.ProcessEnv; credentials: { uid?: number; gid?: number } },
): Promise<{ ok: true; state: string; json: Record<string, unknown> } | { ok: false; reason: string }> {
  const res = await runTe(["--cwd", checkout, "--host", "claude", "status", "--json"], {
    env: o.env,
    credentials: o.credentials,
    cwd: checkout,
    timeoutMs: SEED_STEP_TIMEOUT_MS,
  });
  if (res.code !== 0) return { ok: false, reason: teFailure("status", res) };
  let json: unknown;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    return { ok: false, reason: "`te status --json` did not print JSON" };
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, reason: "`te status --json` did not print an object" };
  }
  const state = (json as { state?: unknown }).state;
  if (typeof state !== "string" || !isInside(TOKENECONOMIZER_HOME, state)) {
    return { ok: false, reason: "`te status --json` named no state directory under the state root" };
  }
  return { ok: true, state, json: json as Record<string, unknown> };
}

/**
 * The plugin's record of what it added to which checkout's settings file and
 * what was given back — `untool_applied.json`, read because no command reports
 * it across checkouts. Null when the plugin has applied nothing yet.
 */
export function readAppliedRecord(
  state: string,
): { ok: true; record: { by_path?: unknown; kept?: unknown } | null } | { ok: false; reason: string } {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(state, "untool_applied.json"), "utf8"),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: "the plugin's record of applied tools is not an object" };
    }
    return { ok: true, record: parsed as { by_path?: unknown; kept?: unknown } };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, record: null };
    return { ok: false, reason: "the plugin's record of applied tools could not be read" };
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function teFailure(what: string, res: TeResult): string {
  if (res.error) return `\`te ${what}\` could not start (${res.error})`;
  if (res.signal) return `\`te ${what}\` was stopped by ${res.signal}`;
  const said = (res.stdout.trim() || res.stderr.trim()).split("\n").pop()?.slice(0, 200);
  return `\`te ${what}\` exited ${res.code}${said ? `: ${said}` : ""}`;
}

/* ------------------------------------------------------------------ */
/* The Project manager's record of one repository                      */
/* ------------------------------------------------------------------ */

/**
 * `te status --json` and the applied-tools record, as the page's DTO.
 *
 * Pure and tested because every misread is silent: a field read off the wrong
 * key renders as a zero, and a zero here reads as "it did nothing", which is a
 * claim about the plugin rather than about this app's parsing. Every value is
 * checked for type, because the record is in a directory every work cycle can
 * write.
 */
export function repoReportOf(
  status: Record<string, unknown>,
  record: { by_path?: unknown; kept?: unknown } | null,
): TokenEconomizerRepoReportDTO {
  const obj = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const count = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  const names = (v: unknown): string[] =>
    Array.isArray(v) ? [...new Set(v.filter((t): t is string => typeof t === "string"))].sort() : [];
  const lists = (byPath: unknown): string[][] =>
    Object.values(obj(byPath)).map(names).filter((l) => l.length > 0);

  const toolprune = obj(status.toolprune);
  const microskills = obj(status.microskills);
  const loopguard = obj(status.loopguard);
  const ledger = obj(status.ledger);
  const config = obj(status.config);

  const applied = lists(record?.by_path);
  const givenBack = [...new Set(lists(record?.kept).flat())].sort();
  const toolMode = obj(config.toolprune).toolprune ?? toolprune.mode;
  const skillMode = obj(config.microskills).microskills ?? microskills.profile;
  const guardMode = obj(config.loopguard).loopguard ?? loopguard.mode;
  const overhead = ledger.overhead_frac;

  return {
    sessions: count(ledger.sessions),
    toolprune: {
      mode: isTokenEconomizerToolprune(toolMode) ? toolMode : "off",
      leftOut: [...new Set(applied.flat())].sort(),
      checkouts: applied.length,
      proposed: names(toolprune.proposal),
      givenBack,
    },
    microskills: {
      // The plugin's `envfacts+distiller` is what this app calls `on`.
      mode:
        skillMode === "envfacts+distiller" || skillMode === "distiller"
          ? "on"
          : isTokenEconomizerMicroskills(skillMode)
            ? skillMode
            : "off",
      facts: count(microskills.injected_lines),
      injectedSessions: count(ledger.injected_sessions),
    },
    loopguard: {
      // `stop` is read by the plugin and acts as `nudge`.
      mode: guardMode === "stop" ? "nudge" : isTokenEconomizerLoopguard(guardMode) ? guardMode : "off",
      redirects: count(ledger.nudges),
      stillStuck: count(ledger.aborts),
    },
    overheadShare:
      count(ledger.priced_sessions) > 0 && typeof overhead === "number" && Number.isFinite(overhead)
        ? Math.min(Math.max(overhead, 0), 1)
        : null,
  };
}
