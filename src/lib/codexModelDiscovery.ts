import { listCodexModels, type CodexListedModel, type CodexReadResult } from "./codexAccount";
import { db, getJSON, setJSON } from "./db";
import {
  CODEX_MODEL_DISCOVERY_KEY,
  isCodexModelId,
  mergeDiscoveredModels,
  type ModelCatalogueEntry,
} from "./modelCatalogue";
import { mayWriteDataDir } from "./serverLock";
import { getSettings, isStoredSetting, sameValue, saveSettings } from "./settings";
import type { CodexModelDiscoveryDTO } from "./apiTypes";

/**
 * `modelDiscovery.ts` for the Codex catalogue: which models the signed-in
 * Codex account may pick, onto `settings.codexModelCatalogue`.
 *
 * Every rule about what an operator keeps is `mergeDiscoveredModels`', shared
 * rather than restated — adds and never edits, offered once so a Remove stays
 * removed, a stored empty list stays empty — and this file is the source and
 * the bookkeeping. The source is the Codex CLI's own `model/list`
 * (`codexAccount.ts`), asked as the agent uid with the sign-in a cycle uses,
 * so the list is the list a Codex run can reach.
 *
 * One difference from the Claude list, and `fillEmpty` is all of it: there is
 * no seed, so an install that has stored no Codex list follows an empty
 * default until the first listing, and that empty is "nothing listed yet"
 * rather than an operator's answer.
 */

interface CodexDiscoverySuccess {
  at: number;
  listed: number;
  added: string[];
  refused: string[];
  /** The model the CLI marks as its own default, for the Inherit option. */
  cliDefault: { id: string; label: string } | null;
}

interface CodexDiscoveryRecord {
  offered: string[];
  added: ModelCatalogueEntry[];
  lastSuccess: CodexDiscoverySuccess | null;
  lastFailure: { at: number; message: string } | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_REFUSED_LENGTH = 100;

function readRecord(): CodexDiscoveryRecord {
  const raw = getJSON<Partial<CodexDiscoveryRecord> | null>(CODEX_MODEL_DISCOVERY_KEY, null);
  return {
    offered: Array.isArray(raw?.offered)
      ? raw.offered.filter((id): id is string => typeof id === "string")
      : [],
    added: Array.isArray(raw?.added) ? raw.added : [],
    lastSuccess: raw?.lastSuccess ?? null,
    lastFailure: raw?.lastFailure ?? null,
  };
}

export interface CodexDiscoveryDeps {
  list: () => Promise<CodexReadResult<CodexListedModel[]>>;
  now: () => number;
}

const DEFAULT_DEPS: CodexDiscoveryDeps = {
  list: listCodexModels,
  now: () => Date.now(),
};

// A new key, not `modelDiscovery.ts`'s: two clocks, two in-flight checks.
const state = ((globalThis as unknown as {
  __ufCodexModelDiscovery?: {
    handle: NodeJS.Timeout | null;
    inflight: Promise<CodexModelDiscoveryDTO> | null;
  };
}).__ufCodexModelDiscovery ??= { handle: null, inflight: null });

/**
 * Merge a whole listing in, synchronously, in one transaction with the record
 * — `modelDiscovery.ts`'s `recordListing` and its reason: a Save landing
 * between "offered" and "added" would be a model offered and never shown.
 */
function recordListing(listed: readonly CodexListedModel[], at: number): ModelCatalogueEntry[] {
  return db().transaction(() => {
    const record = readRecord();
    const following = !isStoredSetting("codexModelCatalogue");
    const current = getSettings().codexModelCatalogue;
    const merge = mergeDiscoveredModels(
      current,
      listed.map((model) => ({ id: model.id, displayName: model.displayName })),
      record.offered,
      { isDiscoverable: isCodexModelId, fillEmpty: following },
    );
    const cliDefault = listed.find((model) => model.isDefault && isCodexModelId(model.id));

    setJSON(CODEX_MODEL_DISCOVERY_KEY, {
      offered: merge.offered,
      added: [...record.added, ...merge.added],
      lastSuccess: {
        at,
        listed: listed.length,
        added: merge.added.map((entry) => entry.id),
        refused: merge.refused.map((id) =>
          id.length > MAX_REFUSED_LENGTH ? `${id.slice(0, MAX_REFUSED_LENGTH - 1)}…` : id,
        ),
        cliDefault: cliDefault
          ? {
              id: cliDefault.id,
              label:
                merge.catalogue.find((entry) => entry.id === cliDefault.id)?.label ??
                cliDefault.id,
            }
          : null,
      },
      lastFailure: null,
    } satisfies CodexDiscoveryRecord);

    // An install following its default now reads the additions through
    // `settingsDefaults()` and this writes nothing; only a stored list needs
    // them written into it.
    if (!following && !sameValue(getSettings().codexModelCatalogue, merge.catalogue)) {
      saveSettings({ codexModelCatalogue: merge.catalogue });
    }
    return merge.added;
  })();
}

function recordFailure(message: string, at: number): void {
  const record = readRecord();
  setJSON(CODEX_MODEL_DISCOVERY_KEY, {
    ...record,
    lastFailure: { at, message },
  } satisfies CodexDiscoveryRecord);
}

async function checkOnce(deps: CodexDiscoveryDeps): Promise<void> {
  const at = deps.now();
  const listed = await deps.list();
  if (!listed.ok) {
    recordFailure(listed.error, at);
    console.warn(`[usagefoundry] Codex model discovery: ${listed.error}`);
    return;
  }
  const added = recordListing(listed.value, at);
  if (added.length > 0) {
    console.log(
      `[usagefoundry] Codex model discovery added ${added.map((entry) => entry.id).join(", ")} to the Codex model list.`,
    );
  }
}

/**
 * Ask now, merge what comes back, and say how it went. Never rejects, and
 * concurrent callers share one check.
 */
export function checkForNewCodexModels(
  deps: CodexDiscoveryDeps = DEFAULT_DEPS,
): Promise<CodexModelDiscoveryDTO> {
  state.inflight ??= runCheck(deps);
  return state.inflight;
}

async function runCheck(deps: CodexDiscoveryDeps): Promise<CodexModelDiscoveryDTO> {
  try {
    await checkOnce(deps);
  } catch (err) {
    const message = `Codex model discovery failed inside this server: ${
      err instanceof Error ? err.message : String(err)
    }`;
    console.warn(`[usagefoundry] ${message}`);
    try {
      recordFailure(message, deps.now());
    } catch (recordErr) {
      console.warn(
        `[usagefoundry] Codex model discovery could not record that failure either: ${
          recordErr instanceof Error ? recordErr.message : String(recordErr)
        }`,
      );
    }
  } finally {
    state.inflight = null;
  }
  return codexModelDiscoveryStatus();
}

/** What Settings shows beside the Codex list. Reads the record; asks nothing. */
export function codexModelDiscoveryStatus(): CodexModelDiscoveryDTO {
  const record = readRecord();
  const success = record.lastSuccess;
  const failure = record.lastFailure;
  return {
    lastSuccessAt: success ? new Date(success.at).toISOString() : null,
    listed: success?.listed ?? null,
    added: success?.added ?? [],
    refused: success?.refused ?? [],
    cliDefault: success?.cliDefault ?? null,
    error: failure?.message ?? null,
    errorAt: failure ? new Date(failure.at).toISOString() : null,
  };
}

/**
 * Check at boot and once a day, behind `instrumentation.ts`'s ownership gate
 * and re-asking it on every tick, `startModelDiscovery`'s terms exactly.
 */
export function startCodexModelDiscovery(): void {
  if (state.handle) return;
  state.handle = setInterval(() => void tick(), DAY_MS);
  state.handle.unref?.();
  void tick();
}

export function stopCodexModelDiscovery(): void {
  if (!state.handle) return;
  clearInterval(state.handle);
  state.handle = null;
}

async function tick(): Promise<void> {
  if (!mayWriteDataDir()) {
    stopCodexModelDiscovery();
    return;
  }
  await checkForNewCodexModels();
}
