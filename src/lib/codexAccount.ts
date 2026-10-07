import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CODEX_BIN, CODEX_HOME, spawnCommand } from "./config";
import { REFRESH_MS, MAX_STALE_MS } from "./planUsage";
import { childCredentials } from "./privsep";
import { agentEnvironment } from "./stacks";
import { buildSnapshot, type PlanUsage, type PlanWindow, type UsageSnapshot } from "./windows";

/**
 * What the signed-in Codex account has used, and which models it may pick —
 * both asked of the Codex CLI's own app server rather than of OpenAI directly.
 *
 * `planUsage.ts` reads Anthropic's usage endpoint with a token it never
 * refreshes. The same move here would mean this server reading `auth.json`,
 * holding a ChatGPT access token and choosing headers for an undocumented
 * backend. `codex app-server` already does all three for the CLI's own
 * `/status` screen: `account/rateLimits/read` and `model/list` are JSON-RPC
 * methods on its stdio, it refreshes the token itself and writes the refreshed
 * one as the uid it runs as, and this process never sees the credential.
 * Measured against `codex-cli 0.153.4` on 2026-10-07 with a ChatGPT team
 * sign-in: `initialize` answered in ~140 ms, the rate-limit read in ~700 ms,
 * the model list in ~150 ms, and the child exited 0 on stdin's EOF.
 *
 * The child starts no agent: no prompt, no thread, no cost and no row
 * anywhere, the `codexAuth.ts` kind rather than a work cycle's. It runs as the
 * agent uid (`childCredentials`) because a token refresh rewrites `auth.json`,
 * and a copy written with the server's authority is one no cycle can open —
 * the reason `codexAuth.ts` gives for its own drop.
 *
 * Every read is a value, never an exception that reaches a page: a Codex
 * install that is signed out, mid-upgrade or offline is an ordinary state, and
 * the dashboard and Settings say so in words.
 */

/** How long one app-server conversation may take, start to finish. */
const APP_SERVER_TIMEOUT_MS = 20_000;
/** A model list is ~30 KB; this bounds a child that never sends a newline. */
const MAX_BUFFERED_CHARS = 8 * 1024 * 1024;
const STDERR_LIMIT = 4_096;
/** Pages of `model/list` read before giving up on a cursor that never ends. */
const MAX_MODEL_PAGES = 10;

export type CodexReadResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Whether there is a stored Codex sign-in to ask about.
 *
 * Existence only, never the contents: the app server is what reads the file.
 * Checked first so that an install that has never signed Codex in — most of
 * them — spawns nothing on a dashboard poll.
 */
export function codexSignInStored(): boolean {
  return fs.existsSync(path.join(CODEX_HOME, "auth.json"));
}

/**
 * The environment the app-server child runs with.
 *
 * A copy of `codexAuthEnv` (`codexAuth.ts`), the eighth copy of the child
 * denylist that `docs/agent/security/child-uid-and-credentials.md` asks for
 * rather than a shared module, and identical to that one for its reason: this
 * child must answer about the credential a work cycle actually gets, which is
 * `$CODEX_HOME/auth.json` with `CODEX_ACCESS_TOKEN` withheld.
 */
function codexAccountEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...agentEnvironment(),
    FORCE_COLOR: "0",
    CODEX_HOME,
  };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("UF_") ||
      key.startsWith("OTEL_") ||
      key === "ANTHROPIC_ADMIN_KEY" ||
      key === "CODEX_ACCESS_TOKEN" ||
      key === "CLAUDE_CODE_ENABLE_TELEMETRY" ||
      key === "DATA_DIR" ||
      key === "NODE_OPTIONS"
    ) {
      delete env[key];
    }
  }
  return env;
}

type RpcCall = (method: string, params?: unknown) => Promise<unknown>;

interface PendingCall {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * One conversation with a fresh `codex app-server`: `initialize`, then
 * whatever `work` asks, then stdin's EOF, which is how the child is told to
 * exit.
 *
 * A child per conversation rather than one kept alive, because the readers
 * here run every few minutes at most and a resident child is ~30 MB doing
 * nothing in between. One deadline covers the whole conversation; it kills the
 * child and fails every call still waiting.
 */
async function withAppServer<T>(work: (call: RpcCall) => Promise<T>): Promise<T> {
  let child: ChildProcess;
  try {
    const cli = spawnCommand(CODEX_BIN, ["app-server"]);
    child = spawn(cli.command, cli.args, {
      env: codexAccountEnv(),
      ...childCredentials(),
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    throw new Error(
      `Could not run \`${CODEX_BIN} app-server\`: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const pending = new Map<number, PendingCall>();
  let nextId = 1;
  let buffered = "";
  let stderr = "";
  let failure: Error | null = null;

  const failAll = (err: Error) => {
    if (failure) return;
    failure = err;
    for (const call of pending.values()) call.reject(err);
    pending.clear();
  };
  const stderrTail = () => {
    // The pinned CLI prints an arg0 clean-up warning on every start; it says
    // nothing about why a conversation failed.
    const text = stderr
      .split("\n")
      .filter((line) => line.trim() && !line.includes("stale arg0 temp dirs"))
      .join(" ")
      .trim();
    return text ? `: ${text.slice(-500)}` : "";
  };

  const onLine = (line: string) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    // Notifications carry a method and no id; a request *from* the server
    // carries both. Neither is an answer to anything asked here.
    if (typeof message.id !== "number" || "method" in message) return;
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    const error = message.error as { message?: unknown } | undefined;
    if (error) {
      const text = typeof error.message === "string" ? error.message : JSON.stringify(error);
      call.reject(new Error(`\`${call.method}\` was refused: ${text}`));
    } else {
      call.resolve(message.result);
    }
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    if (buffered.length > MAX_BUFFERED_CHARS) {
      failAll(new Error("`codex app-server` sent more than 8 MB without a line break"));
      child.kill("SIGKILL");
      return;
    }
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.trim()) onLine(line);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < STDERR_LIMIT) stderr += chunk.toString("utf8");
  });
  // A write after the child died is reported by `close` below, with its stderr.
  child.stdin?.on("error", () => {});
  child.on("error", (err) =>
    failAll(new Error(`Could not run \`${CODEX_BIN} app-server\`: ${err.message}`)),
  );
  child.on("close", (code, signal) =>
    failAll(
      new Error(
        `\`${CODEX_BIN} app-server\` exited (${signal ?? `code ${code}`}) before answering${stderrTail()}`,
      ),
    ),
  );

  const deadline = setTimeout(() => {
    failAll(
      new Error(
        `\`${CODEX_BIN} app-server\` did not answer within ${APP_SERVER_TIMEOUT_MS / 1000}s${stderrTail()}`,
      ),
    );
    child.kill("SIGKILL");
  }, APP_SERVER_TIMEOUT_MS);
  deadline.unref?.();

  const send = (message: Record<string, unknown>) => {
    child.stdin?.write(`${JSON.stringify(message)}\n`);
  };
  const call: RpcCall = (method, params) => {
    if (failure) return Promise.reject(failure);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { method, resolve, reject });
      send(params === undefined ? { id, method } : { id, method, params });
    });
  };

  try {
    await call("initialize", {
      clientInfo: { name: "usagefoundry", title: "UsageFoundry", version: "0" },
      capabilities: null,
    });
    send({ method: "initialized" });
    return await work(call);
  } finally {
    clearTimeout(deadline);
    failAll(new Error("conversation closed"));
    child.stdin?.end();
    // EOF is the measured way out; this is the backstop for a child that
    // ignores it, and is a no-op on one that has already gone.
    const reaper = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 2_000);
    reaper.unref?.();
  }
}

/* ------------------------------------------------------------------ */
/* Rate limits                                                         */
/* ------------------------------------------------------------------ */

/**
 * The provider's reading, in the shape the Claude meters already take, plus
 * what only Codex says.
 *
 * `session` is the backend's *primary* window and `weekly` its *secondary*,
 * which on the measured account were 300 and 10,080 minutes. The lengths are
 * carried rather than assumed so a plan whose windows differ is labelled by
 * what it reported, not by what this file expected.
 */
export interface CodexPlanUsage extends PlanUsage {
  sessionMinutes: number | null;
  weeklyMinutes: number | null;
  /** `plus`, `pro`, `team`… as the backend names it, or null. */
  planType: string | null;
  /** The backend's own word for a wall it says has been hit, or null. */
  limitReached: string | null;
}

function finiteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * One window off the wire, or null.
 *
 * `usedPercent` is a percentage and `resetsAt` is **epoch seconds** — both
 * measured; the Claude endpoint answers an ISO string, so this is not that
 * parser with a rename. No coercion, for `planUsage.ts`'s reason: `Number(null)`
 * is 0, and an unreadable window must never render as an empty one.
 */
function codexWindowOf(raw: unknown): { window: PlanWindow; minutes: number | null } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const percent = finiteNumber(o.usedPercent);
  if (percent === null) return null;
  const resetsAtSeconds = finiteNumber(o.resetsAt);
  return {
    // Floored at zero and never capped: over the wall is a real reading.
    window: {
      utilization: Math.max(0, percent / 100),
      resetsAt: resetsAtSeconds === null ? null : resetsAtSeconds * 1000,
    },
    minutes: finiteNumber(o.windowDurationMins),
  };
}

/**
 * Parse `account/rateLimits/read`'s result. Pure, and the part under test.
 *
 * The `codex` bucket of `rateLimitsByLimitId` is preferred over the top-level
 * `rateLimits`, which the protocol calls a backward-compatible single-bucket
 * view: if the two ever differ, the one named for this product is the one a
 * Codex cycle is metered against. A payload naming neither window is a shape
 * this build does not understand, not an account at 0%.
 */
export function parseCodexRateLimits(raw: unknown, fetchedAt: number): CodexPlanUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const byId = o.rateLimitsByLimitId as Record<string, unknown> | null | undefined;
  const snapshot = (byId && typeof byId === "object" ? byId.codex : undefined) ?? o.rateLimits;
  if (!snapshot || typeof snapshot !== "object") return null;
  const s = snapshot as Record<string, unknown>;

  const primary = codexWindowOf(s.primary);
  const secondary = codexWindowOf(s.secondary);
  if (!primary && !secondary) return null;

  return {
    session: primary?.window ?? null,
    weekly: secondary?.window ?? null,
    scopedWeekly: [],
    fetchedAt,
    sessionMinutes: primary?.minutes ?? null,
    weeklyMinutes: secondary?.minutes ?? null,
    planType: typeof s.planType === "string" && s.planType ? s.planType : null,
    limitReached:
      typeof s.rateLimitReachedType === "string" && s.rateLimitReachedType
        ? s.rateLimitReachedType
        : null,
  };
}

async function fetchCodexUsage(now: number): Promise<CodexPlanUsage | null> {
  if (!codexSignInStored()) return null;
  const result = await withAppServer((call) => call("account/rateLimits/read"));
  return parseCodexRateLimits(result, now);
}

interface CodexUsageCache {
  attemptedAt: number;
  value: CodexPlanUsage | null;
  /** Why the latest attempt read nothing, for the dashboard's one line. */
  error: string | null;
}

// A new key rather than `planUsage.ts`'s, whose shape this is not.
const usageCache = ((globalThis as unknown as {
  __ufCodexUsage?: { v?: CodexUsageCache; inflight?: Promise<CodexPlanUsage | null> | null };
}).__ufCodexUsage ??= {});

/** `planUsage.ts`'s back-off after a failure, for the same reason. */
const ERROR_BACKOFF_MS = 60_000;

/**
 * The Codex account's reading, cached on `planUsage.ts`'s terms: refreshed at
 * most every five minutes, a failure keeps the last good value, and nothing
 * older than an hour is shown as current.
 *
 * Never rejects. Null means "no reading", which the dashboard renders as an
 * absent or hatched meter and never as 0%.
 */
export async function codexUsage(now = Date.now()): Promise<CodexPlanUsage | null> {
  const hit = usageCache.v;
  const value = hit?.value ?? null;
  const fresh = value !== null && now - value.fetchedAt < REFRESH_MS;
  const justTried = hit !== undefined && now - hit.attemptedAt < ERROR_BACKOFF_MS;
  if (fresh || justTried) return usableCodexUsage(value, now);

  usageCache.inflight ??= fetchCodexUsage(now)
    .then(
      (read) => ({ read, error: null as string | null }),
      (err: unknown) => ({
        read: null,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    .then(({ read, error }) => {
      usageCache.v = {
        attemptedAt: now,
        value: read ?? usageCache.v?.value ?? null,
        error: read ? null : error,
      };
      return usableCodexUsage(usageCache.v.value, now);
    })
    .finally(() => {
      usageCache.inflight = null;
    });
  return usageCache.inflight;
}

/** Why the latest Codex usage read came back empty, or null. */
export function codexUsageError(): string | null {
  return usageCache.v?.error ?? null;
}

function usableCodexUsage(value: CodexPlanUsage | null, now: number): CodexPlanUsage | null {
  if (!value) return null;
  return now - value.fetchedAt <= MAX_STALE_MS ? value : null;
}

/** Drop the cache — used by tests and after a sign-in changes. */
export function invalidateCodexUsage(): void {
  usageCache.v = undefined;
}

/** No typed ceiling: a Codex window has only the provider's own percentage. */
const NO_CEILINGS = {
  sessionCostLimit: null,
  weeklyCostLimit: null,
  sessionTokenLimit: null,
  weeklyTokenLimit: null,
  weeklyAnchor: null,
};

/**
 * The windows a Codex run's fraction guards read: the Codex account's own,
 * as a snapshot `evaluateBudget` takes unchanged.
 *
 * `buildSnapshot` over no transcript entries and no ceilings, so every
 * fraction is the provider's percentage or nothing — the Claude transcripts
 * and the Claude price table describe a population a Codex cycle is not in.
 * Its reset instants bound the windows, so a park on a full 5-hour window
 * waits for Codex's reset rather than Claude's. With no reading the windows
 * read unknown, which the guard treats as it treats Claude's: refused at the
 * door, never acted on afterwards.
 *
 * The session window is drawn five hours long whatever the backend reported;
 * the measured plan's is 300 minutes, and `sessionMinutes` is carried on the
 * reading for the day one is not.
 */
export async function codexGuardSnapshot(now = Date.now()): Promise<UsageSnapshot> {
  const plan = codexSignInStored() ? await codexUsage(now) : null;
  return buildSnapshot([], NO_CEILINGS, now, null, plan);
}

/* ------------------------------------------------------------------ */
/* Models                                                              */
/* ------------------------------------------------------------------ */

/** A model as `model/list` names it, reduced to what a catalogue entry carries. */
export interface CodexListedModel {
  /** The slug `codex exec -m` takes. */
  id: string;
  displayName: string;
  /** Whether the CLI marks it as its own default. */
  isDefault: boolean;
}

/**
 * Parse one page of `model/list`. Pure, and under test.
 *
 * `model` is the slug `-m` takes and is preferred over `id`, which names the
 * picker entry; the two were equal for every model on the measured account,
 * and if they ever part it is the slug a cycle needs. Hidden models are
 * dropped here as well as by the request's `includeHidden: false`, because a
 * hidden entry on the measured account was `codex-auto-review` — the CLI's own
 * approval reviewer, not something to start work on.
 */
export function parseCodexModelPage(
  raw: unknown,
): { models: CodexListedModel[]; nextCursor: string | null } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.data)) return null;
  const models: CodexListedModel[] = [];
  for (const entry of o.data) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (e.hidden === true) continue;
    const slug = typeof e.model === "string" && e.model ? e.model : e.id;
    if (typeof slug !== "string" || !slug) continue;
    models.push({
      id: slug,
      displayName: typeof e.displayName === "string" ? e.displayName : "",
      isDefault: e.isDefault === true,
    });
  }
  return {
    models,
    nextCursor: typeof o.nextCursor === "string" && o.nextCursor ? o.nextCursor : null,
  };
}

/**
 * Every model the signed-in account may pick, as the CLI's own picker lists it.
 *
 * Refuses to answer for a signed-out CLI rather than returning its bundled
 * list: `model/list` answers without an account, and what it answers then is
 * this binary's catalogue rather than what the account can reach — the same
 * line `modelDiscovery.ts` draws between a listing and a guess.
 */
export async function listCodexModels(): Promise<CodexReadResult<CodexListedModel[]>> {
  if (!codexSignInStored()) {
    return { ok: false, error: "Codex is not signed in (Settings → Codex account)" };
  }
  try {
    return await withAppServer(async (call) => {
      const account = (await call("account/read", { refreshToken: false })) as {
        account?: unknown;
      } | null;
      if (!account?.account) {
        return { ok: false, error: "Codex is not signed in (Settings → Codex account)" } as const;
      }

      const models: CodexListedModel[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_MODEL_PAGES; page++) {
        const raw = await call("model/list", {
          includeHidden: false,
          ...(cursor ? { cursor } : {}),
        });
        const parsed = parseCodexModelPage(raw);
        if (!parsed) {
          return { ok: false, error: "`model/list` answered in a shape this build does not read" } as const;
        }
        models.push(...parsed.models);
        cursor = parsed.nextCursor;
        if (!cursor) return { ok: true, value: models } as const;
      }
      return {
        ok: false,
        error: `\`model/list\` was still paging after ${MAX_MODEL_PAGES} pages`,
      } as const;
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
