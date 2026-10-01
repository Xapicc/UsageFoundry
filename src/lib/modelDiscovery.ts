import { ANTHROPIC_API_BASE, ANTHROPIC_API_KEY, USER_AGENT } from "./config";
import { db, getJSON, setJSON } from "./db";
import {
  mergeDiscoveredModels,
  MODEL_DISCOVERY_KEY,
  type DiscoveredModel,
  type ModelCatalogueEntry,
} from "./modelCatalogue";
import { readAccessToken } from "./planUsage";
import { mayWriteDataDir } from "./serverLock";
import { getSettings, sameValue, saveSettings } from "./settings";
import type { ModelDiscoveryDTO } from "./apiTypes";

/**
 * Which models the credential runs use can reach, onto the operator's catalogue.
 *
 * The catalogue's own docblock gives the gap this closes: a list baked into a
 * build refuses whatever ships next week, and making the list the operator's
 * turned that into a settings edit — one somebody has to know to make. This asks
 * `GET /v1/models` instead, at boot and about once a day, and hands the answer to
 * `mergeDiscoveredModels`, which only ever adds. Everything that decides what
 * the operator keeps is there; this file is the network and the bookkeeping.
 *
 * **The credential is the one a work cycle bills against**, so the list it
 * fills is the list a run can reach: `ANTHROPIC_API_KEY` when the server has one
 * (`childEnv` passes it to every cycle, and the CLI prefers it), and Claude
 * Code's own OAuth token otherwise, read exactly as `planUsage.ts` reads it —
 * only from `CLAUDE_CONFIG_DIR`, never refreshed, expired counts as none. It is
 * sent from this process and nowhere else: no child is spawned here, and no
 * message, log line or response carries it, which `redact` makes true of the
 * provider's own error text as well.
 *
 * **The OAuth path is unmeasured.** Nobody has confirmed that `/v1/models`
 * accepts a subscription token, and this was not tested against a real one.
 * What is built is that a refusal is never quiet: the status code, the endpoint
 * and which credential was used reach Settings in one sentence, and the
 * catalogue is left exactly as it was. `docs/verification/` keeps the open item.
 *
 * **A failed check changes nothing.** The catalogue is only written after a
 * whole listing — every page — has been read and parsed, so a refusal on page
 * two cannot leave half a list behind.
 */

export type DiscoveryCredentialKind = "api_key" | "claude_code";

export interface DiscoveryCredential {
  kind: DiscoveryCredentialKind;
  secret: string;
}

/** What a person reads for each credential, in every sentence that names one. */
const CREDENTIAL_NAMES: Record<DiscoveryCredentialKind, string> = {
  api_key: "the API key",
  claude_code: "the Claude Code sign-in",
};

export class ModelDiscoveryError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ModelDiscoveryError";
  }
}

const MODELS_PATH = "/v1/models";
/** The documented maximum, so the ordinary answer is one page. */
const PAGE_LIMIT = 1000;
/**
 * A bound on a listing that never says it is done. At a thousand a page this is
 * far past any catalogue Anthropic has published; reaching it is a fault.
 */
const MAX_PAGES = 10;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_DETAIL_LENGTH = 200;
/** One refused id shown in full is enough to say what came back. */
const MAX_REFUSED_LENGTH = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The server's API key, else Claude Code's unexpired OAuth token, else none. */
export async function discoveryCredential(
  now = Date.now(),
): Promise<DiscoveryCredential | null> {
  if (ANTHROPIC_API_KEY) return { kind: "api_key", secret: ANTHROPIC_API_KEY };
  const token = await readAccessToken(now);
  return token ? { kind: "claude_code", secret: token } : null;
}

function headersFor(credential: DiscoveryCredential): Record<string, string> {
  const common = { "anthropic-version": "2023-06-01", "user-agent": USER_AGENT };
  return credential.kind === "api_key"
    ? { ...common, "x-api-key": credential.secret }
    : {
        ...common,
        authorization: `Bearer ${credential.secret}`,
        "anthropic-beta": "oauth-2025-04-20",
      };
}

/**
 * Take the credential out of a sentence before it goes anywhere.
 *
 * The provider's error text is quoted to the operator because it is usually
 * the most useful words available, and nothing promises it never echoes what
 * it was sent.
 */
function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join("[credential]") : text;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

interface ListedPage {
  ok: true;
  models: DiscoveredModel[];
  hasMore: boolean;
  lastId: string | null;
}

type ModelPage = ListedPage | { ok: false; error: string };

/**
 * One page of `GET /v1/models`, or why it is not one.
 *
 * Read against the documented shape (platform.claude.com's List Models page,
 * read 2026-10-01): `data`, `has_more`, `first_id`, `last_id`, and per item
 * `id` and `display_name` among others. An item without a string `id` refuses
 * the whole page rather than being skipped, because a listing this build cannot
 * read is one it should not be acting on in part.
 */
export function parseModelPage(body: unknown): ModelPage {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "not a JSON object" };
  }
  const page = body as { data?: unknown; has_more?: unknown; last_id?: unknown };
  if (!Array.isArray(page.data)) return { ok: false, error: "no data list" };

  const models: DiscoveredModel[] = [];
  for (const item of page.data) {
    if (!item || typeof item !== "object") {
      return { ok: false, error: "a listed model is not an object" };
    }
    const { id, display_name } = item as { id?: unknown; display_name?: unknown };
    if (typeof id !== "string") {
      return { ok: false, error: "a listed model has no id" };
    }
    models.push({ id, displayName: typeof display_name === "string" ? display_name : "" });
  }

  if (typeof page.has_more !== "boolean") {
    return { ok: false, error: "no has_more flag" };
  }
  const lastId = typeof page.last_id === "string" && page.last_id ? page.last_id : null;
  if (page.has_more && !lastId) {
    return { ok: false, error: "has_more without a last_id to continue from" };
  }
  return { ok: true, models, hasMore: page.has_more, lastId };
}

async function fetchPage(
  url: URL,
  credential: DiscoveryCredential,
  fetchImpl: typeof fetch,
): Promise<ListedPage> {
  const name = CREDENTIAL_NAMES[credential.kind];
  let res: Response;
  let text: string;
  try {
    res = await fetchImpl(url, {
      headers: headersFor(credential),
      // Next patches `fetch` and caches through it, and a listing served from
      // that cache would report models as current long after they were.
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    const why = timedOut
      ? `did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds`
      : `could not be reached (${err instanceof Error ? err.message : String(err)})`;
    throw new ModelDiscoveryError(
      redact(`${MODELS_PATH} ${why} with ${name}`, credential.secret),
      0,
    );
  }

  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!res.ok) {
    const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
    const detail =
      typeof message === "string" && message.trim()
        ? `: ${clip(message.trim(), MAX_DETAIL_LENGTH)}`
        : "";
    throw new ModelDiscoveryError(
      redact(`${res.status} from ${MODELS_PATH} with ${name}${detail}`, credential.secret),
      res.status,
    );
  }

  const page = parseModelPage(body);
  if (!page.ok) {
    throw new ModelDiscoveryError(
      `${MODELS_PATH} answered ${res.status} with ${name}, in a shape this build cannot read: ${page.error}`,
      res.status,
    );
  }
  return page;
}

/**
 * Every model the credential can see, across every page, newest first.
 *
 * Throws `ModelDiscoveryError` rather than returning what it had so far:
 * merging part of a listing would offer — and so use up — exactly the ids that
 * happened to be on the pages that loaded.
 */
export async function listModels(
  credential: DiscoveryCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveredModel[]> {
  const models: DiscoveredModel[] = [];
  let after: string | null = null;
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    const url = new URL(MODELS_PATH, ANTHROPIC_API_BASE);
    url.searchParams.set("limit", String(PAGE_LIMIT));
    if (after) url.searchParams.set("after_id", after);

    const page = await fetchPage(url, credential, fetchImpl);
    models.push(...page.models);
    if (!page.hasMore) return models;
    if (page.lastId === after) {
      throw new ModelDiscoveryError(
        `${MODELS_PATH} kept answering the same page after ${after}`,
        0,
      );
    }
    after = page.lastId;
  }
  throw new ModelDiscoveryError(
    `${MODELS_PATH} still said there was more after ${MAX_PAGES} pages`,
    0,
  );
}

/* ------------------------------------------------------------------ */
/* The record                                                          */
/* ------------------------------------------------------------------ */

interface DiscoverySuccess {
  at: number;
  credential: DiscoveryCredentialKind;
  listed: number;
  added: string[];
  refused: string[];
}

interface DiscoveryFailure {
  at: number;
  credential: DiscoveryCredentialKind | null;
  message: string;
}

/**
 * What discovery keeps, in its own `settings` row.
 *
 * `offered` and `added` are the merge's memory and only grow: `offered` is what
 * keeps a removed model removed, and `added` is what `settingsDefaults()` lays
 * over the seed for an install that has not pinned its list. The two results
 * are what Settings shows, and a success clears the failure, because the
 * sentence beside the list is about the latest attempt.
 */
interface DiscoveryRecord {
  offered: string[];
  added: ModelCatalogueEntry[];
  lastSuccess: DiscoverySuccess | null;
  lastFailure: DiscoveryFailure | null;
}

function readRecord(): DiscoveryRecord {
  const raw = getJSON<Partial<DiscoveryRecord> | null>(MODEL_DISCOVERY_KEY, null);
  return {
    offered: Array.isArray(raw?.offered)
      ? raw.offered.filter((id): id is string => typeof id === "string")
      : [],
    added: Array.isArray(raw?.added) ? raw.added : [],
    lastSuccess: raw?.lastSuccess ?? null,
    lastFailure: raw?.lastFailure ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* One check                                                           */
/* ------------------------------------------------------------------ */

export interface DiscoveryDeps {
  credential: (now: number) => Promise<DiscoveryCredential | null>;
  fetch: typeof fetch;
  now: () => number;
}

const DEFAULT_DEPS: DiscoveryDeps = {
  credential: discoveryCredential,
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
};

// Survives dev hot reload, like every other long-lived singleton here: a
// second interval per module evaluation would ask the API once a day per edit.
const state = ((globalThis as unknown as {
  __ufModelDiscovery?: {
    handle: NodeJS.Timeout | null;
    inflight: Promise<ModelDiscoveryDTO> | null;
  };
}).__ufModelDiscovery ??= { handle: null, inflight: null });

/**
 * Merge a whole listing in, synchronously.
 *
 * One transaction for the record and the catalogue, and no `await` inside it:
 * an operator's Save landing between the two would otherwise read the list
 * with the new ids already marked offered and not yet added, and write it back
 * that way — a model offered and never shown, which nothing would ever retry.
 */
function recordListing(
  credential: DiscoveryCredentialKind,
  listed: readonly DiscoveredModel[],
  at: number,
): ModelCatalogueEntry[] {
  return db().transaction(() => {
    const record = readRecord();
    const current = getSettings().modelCatalogue;
    const merge = mergeDiscoveredModels(current, listed, record.offered);

    setJSON(MODEL_DISCOVERY_KEY, {
      offered: merge.offered,
      added: [...record.added, ...merge.added],
      lastSuccess: {
        at,
        credential,
        listed: listed.length,
        added: merge.added.map((entry) => entry.id),
        refused: merge.refused.map((id) => clip(id, MAX_REFUSED_LENGTH)),
      },
      lastFailure: null,
    } satisfies DiscoveryRecord);

    // With the record written, an install still following its default already
    // reads the additions through `settingsDefaults()`, and this is equal and
    // writes nothing — which is what keeps that install unpinned. Only a list
    // the operator has stored needs them written into it.
    if (!sameValue(getSettings().modelCatalogue, merge.catalogue)) {
      saveSettings({ modelCatalogue: merge.catalogue });
    }
    return merge.added;
  })();
}

function recordFailure(
  credential: DiscoveryCredentialKind | null,
  message: string,
  at: number,
): void {
  const record = readRecord();
  setJSON(MODEL_DISCOVERY_KEY, {
    ...record,
    lastFailure: { at, credential, message },
  } satisfies DiscoveryRecord);
}

async function checkOnce(deps: DiscoveryDeps): Promise<void> {
  const at = deps.now();
  const credential = await deps.credential(at);
  if (!credential) {
    const message =
      "No credential: the server has no ANTHROPIC_API_KEY, and no unexpired Claude Code sign-in is in its config directory";
    recordFailure(null, message, at);
    console.warn(`[usagefoundry] model discovery: ${message}.`);
    return;
  }

  let listed: DiscoveredModel[];
  try {
    listed = await listModels(credential, deps.fetch);
  } catch (err) {
    const message =
      err instanceof ModelDiscoveryError
        ? err.message
        : redact(
            `${MODELS_PATH} failed with ${CREDENTIAL_NAMES[credential.kind]}: ${
              err instanceof Error ? err.message : String(err)
            }`,
            credential.secret,
          );
    recordFailure(credential.kind, message, at);
    console.warn(`[usagefoundry] model discovery: ${message}`);
    return;
  }

  const added = recordListing(credential.kind, listed, at);
  if (added.length > 0) {
    console.log(
      `[usagefoundry] model discovery added ${added.map((entry) => entry.id).join(", ")} to the model list.`,
    );
  }
}

/**
 * Ask now, merge what comes back, and say how it went.
 *
 * Never rejects: the timer has nobody to throw to, and the button wants the
 * sentence. Concurrent callers share one request, so a press during the boot
 * check waits for it rather than asking twice.
 */
export function checkForNewModels(
  deps: DiscoveryDeps = DEFAULT_DEPS,
): Promise<ModelDiscoveryDTO> {
  state.inflight ??= runCheck(deps);
  return state.inflight;
}

async function runCheck(deps: DiscoveryDeps): Promise<ModelDiscoveryDTO> {
  try {
    await checkOnce(deps);
  } catch (err) {
    // A fault in this app rather than at the provider — the database, most
    // likely — and still a failure the page has to be able to say.
    const message = `Model discovery failed inside this server: ${
      err instanceof Error ? err.message : String(err)
    }`;
    console.warn(`[usagefoundry] ${message}`);
    try {
      recordFailure(null, message, deps.now());
    } catch (recordErr) {
      // The store that just failed is likely the one this writes to, so the
      // log is the only place left to say it.
      console.warn(
        `[usagefoundry] model discovery could not record that failure either: ${
          recordErr instanceof Error ? recordErr.message : String(recordErr)
        }`,
      );
    }
  } finally {
    state.inflight = null;
  }
  return modelDiscoveryStatus();
}

/** What Settings shows beside the catalogue. Reads the record; asks nothing. */
export function modelDiscoveryStatus(): ModelDiscoveryDTO {
  const record = readRecord();
  const success = record.lastSuccess;
  const failure = record.lastFailure;
  return {
    lastSuccessAt: success ? new Date(success.at).toISOString() : null,
    credential: success?.credential ?? null,
    listed: success?.listed ?? null,
    added: success?.added ?? [],
    refused: success?.refused ?? [],
    error: failure?.message ?? null,
    errorAt: failure ? new Date(failure.at).toISOString() : null,
    errorCredential: failure?.credential ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* The clock                                                           */
/* ------------------------------------------------------------------ */

/**
 * Check at boot and then once a day.
 *
 * A day because models ship on a scale of weeks and the listing is free but not
 * nothing; the button is there for the day one ships. Started from
 * `instrumentation.ts` behind the same ownership gate as every other writer,
 * and re-asked on every tick for the retention sweeper's reason: the answer
 * moves after boot, and a process that has stood down must not write a
 * catalogue another process owns.
 */
export function startModelDiscovery(): void {
  if (state.handle) return;
  state.handle = setInterval(() => void tick(), DAY_MS);
  state.handle.unref?.();
  void tick();
}

export function stopModelDiscovery(): void {
  if (!state.handle) return;
  clearInterval(state.handle);
  state.handle = null;
}

async function tick(): Promise<void> {
  if (!mayWriteDataDir()) {
    stopModelDiscovery();
    return;
  }
  await checkForNewModels();
}
