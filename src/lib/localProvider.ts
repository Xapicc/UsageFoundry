import fs from "node:fs";
import path from "node:path";
import { CLAUDE_CONFIG_DIR, LOCAL_CLAUDE_CONFIG_DIR } from "./config";
import { db } from "./db";
import { chownForChild } from "./privsep";

/**
 * The local provider: a model behind an Anthropic-compatible API that the
 * operator runs themselves, signed into from Settings.
 *
 * **It is Claude Code pointed somewhere else, and nothing more.** A local run's
 * work cycles are spawned as `CLAUDE_BIN` with the argv and the stream parser
 * every Claude run gets; the whole difference is the environment
 * `localCycleEnv` builds. That keeps every guarantee the Claude path carries —
 * the process-kill denial on argv, the appended system prompt, plugins, the
 * taskboard — which a third CLI would each have had to earn again.
 *
 * **Winnow's intake proxy is bypassed for these children and only these.** The
 * entrypoint exports `ANTHROPIC_BASE_URL` at a loopback proxy that relays to
 * api.anthropic.com, and `childEnv` hands that to every agent. A local cycle's
 * base URL is overwritten after `childEnv` has run, so its requests go straight
 * to the local server and never through the filter, while every Claude run in
 * flight beside it keeps going through it. Stopping the proxy instead would
 * take the API away from those runs, which the entrypoint's own comment
 * records. Winnow's pruner goes quiet for the same child by a second route: it
 * finds transcripts under `PROJECTS_DIR`, and a local cycle writes none there.
 *
 * **Spend is unknown, not zero.** Claude Code prices a model it does not know
 * by a table it does not show, so `total_cost_usd` for a local model is not a
 * reading of anything. `providerReportsSpend` says so, and the loop withholds
 * the `+=` exactly as it does for Codex.
 */

/** What the operator signed in with. The token never leaves the server. */
export interface LocalSignIn {
  /** Scheme, host, port and any path prefix; no trailing slash, no `/v1`. */
  baseUrl: string;
  /** Sent as `ANTHROPIC_AUTH_TOKEN`. Null when the server wants none. */
  token: string | null;
  /** Handed to `--model` and to every model role Claude Code has. */
  model: string;
  /**
   * The model's context window, sent as `CLAUDE_CODE_MAX_CONTEXT_TOKENS`. Null
   * leaves the CLI assuming 200,000 for a model it does not know.
   */
  contextTokens: number | null;
  signedInAt: number;
}

/**
 * The smallest context window the sign-in takes.
 *
 * The pinned CLI compacts 33,000 tokens short of the window (20,000 held for
 * output, 13,000 for the summary), and a local cycle's first request is about
 * 28,500 tokens, every tool's schema included — measured off two local
 * transcripts on 2026-09-28. Below about 62,000 it would compact on every turn.
 */
export const MIN_LOCAL_CONTEXT_TOKENS = 65_536;
/** The largest window the pinned CLI resolves for any model. */
export const MAX_LOCAL_CONTEXT_TOKENS = 1_000_000;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Read the sign-in form, refusing anything that would fail at the spawn instead. */
export function parseLocalSignIn(input: {
  baseUrl?: unknown;
  token?: unknown;
  model?: unknown;
  contextTokens?: unknown;
}): Parsed<Omit<LocalSignIn, "signedInAt">> {
  const rawUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";
  if (!rawUrl) return { ok: false, error: "A base URL is required." };
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: `Not a URL: ${rawUrl}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: `The base URL must be http or https, not ${url.protocol}` };
  }
  // In the URL a credential would reach the child's environment as part of the
  // base URL, and the page reads the base URL back — so it would be on screen.
  if (url.username || url.password) {
    return { ok: false, error: "Put the credential in the token field, not in the URL." };
  }
  if (url.search || url.hash) {
    return { ok: false, error: "The base URL cannot carry a query string or a fragment." };
  }
  const baseUrl = url.toString().replace(/\/+$/, "");
  // Claude Code appends `/v1/messages` itself, so a pasted `…/v1` is a request
  // to `/v1/v1/messages` — a 404 at the first cycle that names nothing.
  if (/\/v1$/i.test(baseUrl)) {
    return {
      ok: false,
      error: "Leave /v1 off the base URL — Claude Code appends /v1/messages itself.",
    };
  }

  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (!model) return { ok: false, error: "A model id is required." };
  // It reaches argv as the value of `--model`; one starting with a dash would
  // be read as a flag of its own.
  if (model.startsWith("-") || /[\s\u0000-\u001f]/.test(model) || model.length > 200) {
    return { ok: false, error: `Not a model id this can pass on a command line: ${model}` };
  }

  const rawToken = typeof input.token === "string" ? input.token.trim() : "";
  if (/[\r\n\u0000]/.test(rawToken) || rawToken.length > 4096) {
    return { ok: false, error: "The token cannot contain line breaks." };
  }

  const contextTokens = parseContextTokens(input.contextTokens);
  if (!contextTokens.ok) return contextTokens;

  return {
    ok: true,
    value: { baseUrl, token: rawToken || null, model, contextTokens: contextTokens.value },
  };
}

/** Blank is no window; anything else has to be a whole number the CLI can use. */
function parseContextTokens(raw: unknown): Parsed<number | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (text === "") return { ok: true, value: null };
  const n = Number(text);
  if (!Number.isInteger(n)) {
    return { ok: false, error: `The context window has to be a whole number of tokens, not ${text}.` };
  }
  if (n < MIN_LOCAL_CONTEXT_TOKENS || n > MAX_LOCAL_CONTEXT_TOKENS) {
    return {
      ok: false,
      error: `The context window has to be between ${MIN_LOCAL_CONTEXT_TOKENS} and ${MAX_LOCAL_CONTEXT_TOKENS} tokens, not ${n}.`,
    };
  }
  return { ok: true, value: n };
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

interface LocalProviderRow {
  base_url: string;
  token: string | null;
  model: string;
  context_tokens: number | null;
  signed_in_at: number;
}

/**
 * The sign-in, or null when signed out.
 *
 * In the database rather than a file in the agents' home, which is the opposite
 * of Codex's choice and for the opposite reason: Codex's CLI reads its own
 * credential file, so the agent uid has to be able to open it. This one is read
 * by the server and handed to one child at a time through its environment, so
 * it can stay under `/data`, which no agent can traverse.
 */
export function getLocalSignIn(): LocalSignIn | null {
  const row = db()
    .prepare(
      "SELECT base_url, token, model, context_tokens, signed_in_at FROM local_provider WHERE id = 1",
    )
    .get() as LocalProviderRow | undefined;
  if (!row) return null;
  return {
    baseUrl: row.base_url,
    token: row.token,
    model: row.model,
    contextTokens: row.context_tokens,
    signedInAt: row.signed_in_at,
  };
}

export function saveLocalSignIn(value: Omit<LocalSignIn, "signedInAt">): LocalSignIn {
  const signedInAt = Date.now();
  db()
    .prepare(
      `INSERT INTO local_provider (id, base_url, token, model, context_tokens, signed_in_at)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET base_url = excluded.base_url,
         token = excluded.token, model = excluded.model,
         context_tokens = excluded.context_tokens,
         signed_in_at = excluded.signed_in_at`,
    )
    .run(value.baseUrl, value.token, value.model, value.contextTokens, signedInAt);
  return { ...value, signedInAt };
}

export function clearLocalSignIn(): void {
  db().prepare("DELETE FROM local_provider WHERE id = 1").run();
}

/**
 * Every local-provider run that has worked on this branch, oldest first.
 *
 * By the ref rather than by walking `continues_run`, because the question is
 * whether a local model ever committed here, and a chain is one way of sharing
 * a ref rather than the only one. Branch names carry a random suffix, so two
 * unrelated runs do not meet on one.
 */
export function localRunsOnBranch(repoRoot: string, branch: string): string[] {
  const rows = db()
    .prepare(
      `SELECT id FROM runs
        WHERE repo_root = ? AND worktree_branch = ? AND provider = 'local'
        ORDER BY created_at`,
    )
    .all(repoRoot, branch) as { id: string }[];
  return rows.map((r) => r.id);
}

/* ------------------------------------------------------------------ */
/* Signing in                                                          */
/* ------------------------------------------------------------------ */

/**
 * How long the probe waits. A local server commonly loads the model on its
 * first request, and a large one takes most of a minute off a cold disk.
 */
const PROBE_TIMEOUT_MS = 120_000;

/**
 * Ask the endpoint for one token, the way a work cycle will ask it.
 *
 * `POST /v1/messages` rather than a model list, because that is the one route
 * Claude Code calls, and a server that speaks only the OpenAI dialect answers a
 * model list perfectly well and then fails every cycle. The answer has to be an
 * Anthropic `message`, not merely a 200. Null when it is; otherwise one sentence
 * saying what came back.
 */
export async function probeLocalEndpoint(
  value: Omit<LocalSignIn, "signedInAt">,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  let res: Response;
  try {
    res = await fetchImpl(`${value.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        authorization: `Bearer ${value.token ?? LOCAL_TOKEN_PLACEHOLDER}`,
      },
      body: JSON.stringify({
        model: value.model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    const reason = cause ?? (err as Error).message;
    return `Could not reach ${value.baseUrl}: ${reason}.`;
  }
  const body = await res.text().catch(() => "");
  if (!res.ok) {
    return `${value.baseUrl} answered ${res.status}: ${body.slice(0, 300) || res.statusText}`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return `${value.baseUrl} answered 200 with something that is not JSON, so it is not an Anthropic-compatible API.`;
  }
  if ((parsed as { type?: unknown } | null)?.type !== "message") {
    return `${value.baseUrl} answered 200 but not with an Anthropic message, so Claude Code could not read it.`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The child                                                           */
/* ------------------------------------------------------------------ */

/**
 * What `ANTHROPIC_AUTH_TOKEN` carries when the local server wants no token.
 *
 * Never left unset, and not because the server needs it: unset, Claude Code
 * falls back through `ANTHROPIC_API_KEY` to the operator's OAuth login and sends
 * that subscription credential to whatever the base URL names. The pinned CLI
 * ranks this variable above the OAuth login ("ANTHROPIC_AUTH_TOKEN is set, so
 * this session is using API-key auth"), so any value closes that path.
 */
export const LOCAL_TOKEN_PLACEHOLDER = "local-provider";

/**
 * Removed from a local cycle's environment before anything is set.
 *
 * Each would send this cycle somewhere other than the local server or send an
 * Anthropic credential to it: the two keys and the OAuth token are the account's
 * own, the custom headers can carry a gateway's credential, the two provider
 * switches make the CLI ignore the base URL entirely, and the telemetry
 * variables would report Claude Code's price for a model it cannot price to the
 * OTLP receiver that attributes spend to runs.
 */
const LOCAL_STRIPPED = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_ENABLE_TELEMETRY",
] as const;

/**
 * Every variable through which Claude Code picks a model for itself.
 *
 * `--model` covers the main loop only. The CLI also calls a small model for
 * housekeeping and its own model for a sub-agent, and each of those would reach
 * the local server under a Claude id it has never heard of. All six are in the
 * pinned 2.1.280 binary.
 */
const LOCAL_MODEL_ROLES = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
] as const;

/**
 * How long a local cycle's request may go without a byte before the CLI gives
 * up on it and retries from scratch.
 *
 * A local server is silent while it reads the prompt, and a local cycle's prompt
 * carries every tool's schema (see `ENABLE_TOOL_SEARCH` below); a run queued
 * behind another on the same server is silent too. The CLI reads both as a dead
 * connection. Two variables, because either alone leaves a shorter bound in
 * force — read out of the pinned 2.1.280 binary: `CLAUDE_STREAM_IDLE_TIMEOUT_MS`
 * replaces the three-minute default between bytes and is also the default wait
 * for the first one, but that first wait is capped a second short of
 * `API_TIMEOUT_MS`, which defaults to ten minutes.
 */
const LOCAL_IDLE_TIMEOUT_MS = 15 * 60_000;

/**
 * A work cycle's environment, turned from a Claude cycle's into a local one's.
 *
 * Applied to what `childEnv` built rather than instead of it, so every strip
 * that list carries still applies; this only removes more and sets the rest.
 * `CLAUDE_CONFIG_DIR` is the one that keeps the run's transcripts out of the
 * meters — see `LOCAL_CLAUDE_CONFIG_DIR`.
 */
export function localCycleEnv(
  base: NodeJS.ProcessEnv,
  signIn: Pick<LocalSignIn, "baseUrl" | "token" | "contextTokens">,
  model: string,
  configDir: string = LOCAL_CLAUDE_CONFIG_DIR,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) {
    if (key.startsWith("OTEL_") || (LOCAL_STRIPPED as readonly string[]).includes(key)) {
      delete env[key];
    }
  }
  env.ANTHROPIC_BASE_URL = signIn.baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = signIn.token ?? LOCAL_TOKEN_PLACEHOLDER;
  env.CLAUDE_CONFIG_DIR = configDir;
  for (const key of LOCAL_MODEL_ROLES) env[key] = model;
  // Update checks, error reporting and the like, all of which go to Anthropic.
  // A run the operator pointed at their own machine has no business there.
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  // The other half of winnow, and the half the base URL does not undo. The
  // entrypoint exports `ENABLE_TOOL_SEARCH=1` beside the proxy, because a
  // non-Anthropic base URL turns tool deferral off and the proxy forwards
  // `tool_reference` blocks. A local server does not: LM Studio answered the
  // first `ToolSearch` result with "400 request.messages.3.content.0.content.0
  // .type: Invalid literal value, expected \"text\"" and the run ended there.
  // Off, every tool's schema rides every request, which is what a server that
  // cannot resolve a reference needs.
  env.ENABLE_TOOL_SEARCH = "false";
  env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = String(LOCAL_IDLE_TIMEOUT_MS);
  env.API_TIMEOUT_MS = String(LOCAL_IDLE_TIMEOUT_MS);
  // For a model id it does not know the CLI assumes a 200,000-token window and
  // compacts 33,000 short of it, which a smaller server never lets a
  // conversation reach: one local session here got to 127,833 tokens of
  // Splash's 131,072 without compacting. Set, the CLI compacts at the same
  // distance from the real window. Nothing else is overridden: at the CLI's
  // default output ceiling a request at that point asks for 1,000 tokens less
  // than the window, so even a server that refuses an oversized `max_tokens`
  // takes it.
  if (signIn.contextTokens !== null) {
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(signIn.contextTokens);
  }
  return env;
}

/**
 * The operator's own instructions, carried into the local config directory.
 *
 * A separate `CLAUDE_CONFIG_DIR` keeps a local run's transcripts out of the
 * meters, and it also took away everything else the CLI reads from the
 * operator's one: the first rejected local run loaded the repository's
 * `CLAUDE.md` and none of the five rule files a Claude run gets, and three of
 * the frontier review's four findings were those rules broken — a default that
 * hides a missing argument, a comment that says something false, a change the
 * commit did not report. Instructions only: `settings.json` stays out, because
 * its hooks and its `env` are the operator's Claude setup rather than rules for
 * the work, and an `env` there could point the CLI back at Anthropic.
 */
export const LOCAL_SHARED_INSTRUCTIONS = ["CLAUDE.md", "rules"] as const;

/**
 * Create the local config directory for the agent uid, if it is not there, and
 * link the operator's instructions into it.
 *
 * Throws rather than degrading on the directory: one the child cannot write is
 * a CLI that dies at its first write, which the loop would read as a cycle that
 * said nothing. The links are symlinks so an edit to a rule reaches the next
 * cycle, and an entry that is really there — a file rather than a link — is
 * somebody's own and is left alone.
 */
export function ensureLocalConfigDir(
  dir: string = LOCAL_CLAUDE_CONFIG_DIR,
  source: string = CLAUDE_CONFIG_DIR,
): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  chownForChild(dir);
  for (const name of LOCAL_SHARED_INSTRUCTIONS) {
    const target = path.join(source, name);
    const link = path.join(dir, name);
    if (!fs.existsSync(target)) continue;
    let existing: fs.Stats | null = null;
    try {
      existing = fs.lstatSync(link);
    } catch {
      existing = null;
    }
    if (existing && !existing.isSymbolicLink()) continue;
    if (existing && fs.readlinkSync(link) === target) continue;
    if (existing) fs.unlinkSync(link);
    fs.symlinkSync(target, link);
  }
  return dir;
}
