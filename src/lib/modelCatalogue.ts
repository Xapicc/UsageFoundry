/**
 * The models this install may start work on, as one operator-defined list.
 *
 * Every field that named a model was free text until this file existed, and the
 * reason was written down twice: a list *this build* knows would refuse
 * whatever ships next week, so a typo was stored verbatim and a model id this
 * machine does not have became a run that failed when it started. This list
 * answers that objection rather than overruling it — the operator adds an
 * entry, so a new model needs a settings edit and never a release.
 *
 * **It is validation and never a guard.** A model moves what a run costs and
 * never what it may do, which is the same line `agents.ts` draws when it
 * refuses `tools` by name. Nothing here may reach a budget, a work-cycle limit,
 * a permission mode or an isolation choice, and an entry carries no field that
 * could: an id, what a person reads, and whether it may be picked today.
 *
 * ## What matching means here
 *
 * Exact, against the trimmed string. The question this list answers is "may
 * this string reach `--model`", not "which model is this" — the second question
 * is `pricing.ts`'s, it has its own canonicalisation for the provider-decorated
 * spellings, and the two are deliberately orthogonal: an enabled model may be
 * unpriced (and must still banner as unpriced), and a priced model may be
 * disabled. Canonicalising here would let a spelling the operator never listed
 * through to argv on the strength of one they did.
 *
 * ## The empty list
 *
 * An empty catalogue means *no catalogue* — nothing is refused — rather than
 * "no model is allowed". That is the same trade `metering.md` makes for a
 * ceiling nobody set, and it is what keeps the free-text premise available to
 * an operator who wants it back: clearing the list turns the whole check off.
 * A *non-empty* list with nothing enabled is the state that would refuse every
 * run, and `normalizeModelCatalogue` refuses it at the door instead.
 *
 * ## What discovery may do to it
 *
 * The list being the operator's closed the gap a build-time list leaves from
 * one side: a model shipped next week is a settings edit. `modelDiscovery.ts`
 * closes it from the other, by asking `/v1/models` what the credential runs use
 * can reach and adding what this install has never been offered. It is held to
 * one rule, and `mergeDiscoveredModels` is where it lives: **it adds and never
 * edits.** No existing entry's id, label, switch or position moves; nothing is
 * removed for being unlisted, because the `[1m]` ids are the CLI's and the API
 * never lists one; an id discovery has offered once is never offered again, so
 * an operator's Remove stays removed; and an empty list stays empty. What it
 * adds arrives enabled under the API's display name, unpriced if `pricing.ts`
 * has never heard of it, which is the same footing as a hand-added entry.
 *
 * What it adds moves the install's *default* rather than its setting:
 * `settingsDefaults()` is the seed plus discovery's additions, so an install
 * that never touched the list keeps following every future seed and keeps
 * reading as unedited. See `docs/agent/agents-and-templates/` for why that and
 * not writing the merged list back.
 */

import { knownModelIds } from "./pricing";

export interface ModelCatalogueEntry {
  /**
   * The id exactly as the Claude Code CLI takes it, square brackets included.
   *
   * `[1m]` is a CLI construct and not an Anthropic API one — on the API the
   * current models already carry a 1M window and there is no `[1m]` id — so
   * nothing on the path to `--model` may normalise the suffix away.
   */
  id: string;
  /** What a person reads on a picker. */
  label: string;
  enabled: boolean;
}

/**
 * What a person reads, for every key `pricing.ts` prices.
 *
 * Declaration order is display order. This table says nothing about *which*
 * models exist — `knownModelIds()` is the only answer to that, and the seed
 * below walks it — so a model added to `PRICES` and forgotten here still
 * appears, wearing its raw id. `modelCatalogue.test.ts` asserts the two agree,
 * which is the loud channel for that mistake; a picker that quietly dropped a
 * priced model would not be.
 */
const MODEL_LABELS: Record<string, string> = {
  "claude-fable-5-1": "Claude Fable 5.1",
  "claude-mythos-5-1": "Claude Mythos 5.1",
  "claude-fable-5": "Claude Fable 5",
  "claude-mythos-5": "Claude Mythos 5",
  "claude-mythos-preview": "Claude Mythos Preview",

  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-opus-5": "Claude Opus 5",
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-opus-4-7": "Claude Opus 4.7",
  "claude-opus-4-6": "Claude Opus 4.6",
  "claude-opus-4-5": "Claude Opus 4.5",
  "claude-opus-4-1": "Claude Opus 4.1",
  "claude-opus-4-0": "Claude Opus 4",
  "claude-3-opus": "Claude 3 Opus",

  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-sonnet-4-5": "Claude Sonnet 4.5",
  "claude-sonnet-4-0": "Claude Sonnet 4",
  "claude-3-7-sonnet": "Claude 3.7 Sonnet",
  "claude-3-5-sonnet": "Claude 3.5 Sonnet",

  "claude-haiku-4-5": "Claude Haiku 4.5",
  "claude-3-5-haiku": "Claude 3.5 Haiku",
  "claude-3-haiku": "Claude 3 Haiku",
};

/**
 * The `[1m]` ids, and the price-table key each sits under.
 *
 * MEASURED rather than reasoned: these are exactly the nine `claude-…[1m]`
 * strings the pinned CLI carries (2.1.280, the `CLAUDE_CLI_VERSION` in
 * `Dockerfile`), read out of `@anthropic-ai/claude-code-linux-arm64`'s binary.
 * The suffix is a request for the 1M-context deployment of that model, so the
 * list is the CLI's to grow and not this build's to guess —
 * `claude-fable-5-1[1m]` looks like it should exist and the pinned CLI does not
 * name it, which is precisely why nothing here derives a variant from a base.
 *
 * Re-measuring it is one grep, and the count to expect is nine rather than what
 * that grep prints: the binary also carries the CLI's short aliases
 * (`opus[1m]`, `sonnet-4-6[1m]`, `opusplan[1m]` and four more), which are not
 * model ids and are not this list's business.
 *
 * `base` is a price-table key rather than a label, so a variant cannot end up
 * named after a model the price table has never heard of.
 */
const ONE_MEGA_VARIANTS: { id: string; base: string }[] = [
  { id: "claude-fable-5[1m]", base: "claude-fable-5" },
  { id: "claude-opus-5-5[1m]", base: "claude-opus-5-5" },
  { id: "claude-opus-5[1m]", base: "claude-opus-5" },
  { id: "claude-opus-4-8[1m]", base: "claude-opus-4-8" },
  { id: "claude-opus-4-7[1m]", base: "claude-opus-4-7" },
  { id: "claude-opus-4-6[1m]", base: "claude-opus-4-6" },
  { id: "claude-sonnet-5[1m]", base: "claude-sonnet-5" },
  { id: "claude-sonnet-4-6[1m]", base: "claude-sonnet-4-6" },
  // The one dated id in the set: the CLI names `claude-sonnet-4-5-20250929[1m]`
  // and no undated `claude-sonnet-4-5[1m]`. It prices through the undated
  // prefix like every other snapshot.
  { id: "claude-sonnet-4-5-20250929[1m]", base: "claude-sonnet-4-5" },
];

/**
 * Enabled on a fresh install: the pinned CLI names the id, and the model is
 * both current-generation and generally available.
 *
 * That rule is why the Mythos pair is seeded switched off despite being current
 * and priced — it is offered to one access programme, so an install that has it
 * says so rather than every install offering it. The legacy and deprecated
 * entries are off for the ordinary reason: they are in the price table because
 * a transcript may still name one, which is not a reason to start new work on
 * one. Every one of them is one switch away.
 */
const ENABLED_ON_SEED: ReadonlySet<string> = new Set([
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-fable-5[1m]",
  "claude-opus-5-5",
  "claude-opus-5-5[1m]",
  "claude-opus-5",
  "claude-opus-5[1m]",
  "claude-opus-4-8",
  "claude-opus-4-8[1m]",
  "claude-opus-4-7",
  "claude-opus-4-7[1m]",
  "claude-opus-4-6",
  "claude-opus-4-6[1m]",
  "claude-sonnet-5",
  "claude-sonnet-5[1m]",
  "claude-sonnet-4-6",
  "claude-sonnet-4-6[1m]",
  "claude-haiku-4-5",
]);

const LABEL_ORDER = Object.keys(MODEL_LABELS);

function seedCatalogue(): ModelCatalogueEntry[] {
  const variantsByBase = new Map<string, { id: string; base: string }[]>();
  for (const variant of ONE_MEGA_VARIANTS) {
    const list = variantsByBase.get(variant.base) ?? [];
    list.push(variant);
    variantsByBase.set(variant.base, list);
  }

  // `knownModelIds()` is longest-prefix-first, which is the order the price
  // table needs to resolve and the worst order to read. Sorted back into this
  // file's declared one, with anything it has no opinion on kept behind the
  // rest in the price table's own order rather than dropped.
  const ids = [...knownModelIds()].sort((a, b) => {
    const ra = LABEL_ORDER.indexOf(a);
    const rb = LABEL_ORDER.indexOf(b);
    return (ra < 0 ? LABEL_ORDER.length : ra) - (rb < 0 ? LABEL_ORDER.length : rb);
  });

  const entries: ModelCatalogueEntry[] = [];
  for (const id of ids) {
    const label = MODEL_LABELS[id] ?? id;
    entries.push({ id, label, enabled: ENABLED_ON_SEED.has(id) });
    for (const variant of variantsByBase.get(id) ?? []) {
      entries.push({
        id: variant.id,
        label: `${label} (1M context)`,
        enabled: ENABLED_ON_SEED.has(variant.id),
      });
    }
  }
  return entries;
}

/** What a fresh install ships with, and what `DEFAULTS` holds. */
export const SEEDED_MODEL_CATALOGUE: ModelCatalogueEntry[] = seedCatalogue();

export function enabledModels(
  catalogue: readonly ModelCatalogueEntry[],
): ModelCatalogueEntry[] {
  return catalogue.filter((entry) => entry.enabled);
}

/**
 * Why this model may not be used, in one wording for every door.
 *
 * `agentRefusal`'s shape, and for its reason: a model told only "no" reaches
 * for the next id it can think of, so the sentence names what was seen, what is
 * available, and where an operator adds the missing one. Null means the value
 * is fine — including a value that names none, which every door must keep
 * meaning "fall through to the next rung" rather than refusing.
 */
export function modelRefusal(
  catalogue: readonly ModelCatalogueEntry[],
  model: string | null | undefined,
): string | null {
  const seen = typeof model === "string" ? model.trim() : "";
  if (!seen) return null;

  const enabled = enabledModels(catalogue);
  if (enabled.length === 0) return null;
  if (enabled.some((entry) => entry.id === seen)) return null;

  const disabled = catalogue.find((entry) => entry.id === seen);
  const available = enabled.map((entry) => entry.id).join(", ");
  return disabled
    ? `Model "${seen}" is switched off for this install. Enabled models: ${available}. Switch it back on under Settings → Models.`
    : `Model "${seen}" is not on this install's list. Enabled models: ${available}. Add it under Settings → Models.`;
}

/**
 * Read an operator's submitted list off the wire.
 *
 * Refuses rather than repairs, `agentRefusal`'s rule again: an operator who
 * disabled every entry and got a saved list that quietly kept one on would
 * believe they had narrowed this install when they had not.
 */
export function normalizeModelCatalogue(
  input: unknown,
): { catalogue: ModelCatalogueEntry[] } | { error: string } {
  if (!Array.isArray(input)) {
    return { error: "The model list must be a list of entries." };
  }

  const catalogue: ModelCatalogueEntry[] = [];
  const seenIds = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== "object" || raw === null) {
      return { error: "Every model entry must name an id." };
    }
    const entry = raw as Partial<ModelCatalogueEntry>;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) return { error: "A model entry has a blank id." };
    if (seenIds.has(id)) {
      return { error: `The model list names "${id}" twice.` };
    }
    seenIds.add(id);
    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    catalogue.push({ id, label: label || id, enabled: entry.enabled === true });
  }

  if (catalogue.length > 0 && !catalogue.some((entry) => entry.enabled)) {
    return {
      error:
        "At least one model must stay enabled. Clear the whole list instead if you want no list at all.",
    };
  }
  return { catalogue };
}

/**
 * Add ids the catalogue does not already carry, enabled.
 *
 * The migration's half of the bargain: an install running on a model this
 * build's seed never heard of has an operator who chose it, and a list that
 * arrived and dropped it would reset a working configuration in silence — the
 * one failure that would make this feature worse than the free text it
 * replaces. Adopted entries wear the raw id as their label because that is the
 * only true thing known about them.
 */
export function adoptModelIds(
  catalogue: readonly ModelCatalogueEntry[],
  ids: readonly string[],
): ModelCatalogueEntry[] {
  const adopted = [...catalogue];
  const known = new Set(adopted.map((entry) => entry.id));
  for (const raw of ids) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id || known.has(id)) continue;
    known.add(id);
    adopted.push({ id, label: id, enabled: true });
  }
  return adopted;
}

/**
 * Models this release added to the seed, onto a list an install already stores.
 *
 * **The settings page already promises this and nothing was keeping it.** A
 * seeded row has no Remove button, and the comment on that button says why in
 * so many words: an operator's own entry never comes back, "the seed comes back
 * on the next release". It did not. `adoptModelsInUse` runs at most once per
 * install, `saveSettings` pins `modelCatalogue` into the stored blob the moment
 * it differs from `DEFAULTS` — one model switched off is enough — and from then
 * on the shipped seed was dead for that install. Claude Opus 5.5 is what found
 * it: priced, labelled and seeded on, and invisible on every picker of any
 * install that had ever touched the list.
 *
 * Safe to run on every boot, and that is the whole design rather than a risk
 * taken. `adoptModelsInUse` must run once because re-adopting from templates
 * and agents would switch a model back on the morning after the operator
 * switched it off. This cannot do that: it only ever adds an id the stored list
 * does **not** carry, and a seeded id is one the operator has no way to remove —
 * the switch retires it in place, and a retired entry is present and `enabled:
 * false`, so it is not missing and is not touched. What they *can* remove is
 * their own typed entry, which is by definition not in the seed. So "absent from
 * a stored list" means "shipped after that list was written", which is exactly
 * the case this exists for.
 *
 * **Except for a list with nothing in it.** That argument needs an entry to be
 * absent *from*; an empty list is the operator's answer that there is no list
 * — nothing is refused, and `normalizeModelCatalogue` tells them to clear the
 * whole list to get exactly that — and every seeded id is "absent" from it
 * without having been shipped since anything. Filling it would turn the model
 * check back on at the next boot, behind their back, which is the rule
 * `mergeDiscoveredModels` already keeps under "Empty stays empty".
 *
 * Order is the seed's, because declaration order is display order and a model
 * inserted at the end of the list would read as older than everything above it.
 * Entries the seed does not name — the operator's own, and whatever
 * `adoptModelsInUse` took off their templates — keep their relative order and
 * follow, which is where both already sat.
 *
 * Every stored entry is otherwise returned untouched: `enabled` is the
 * operator's answer and this never has an opinion on it. The one exception is a
 * label that is still the raw id, which is what both `addModel` and
 * `adoptModelIds` write for a model the build did not know — once it is seeded
 * the build does know, and keeping the id there would leave `claude-opus-5-5` on
 * a picker under "Claude Opus 5". A label is cosmetic and gates nothing.
 */
export function mergeSeededModels(
  stored: readonly ModelCatalogueEntry[],
  seed: readonly ModelCatalogueEntry[] = SEEDED_MODEL_CATALOGUE,
): ModelCatalogueEntry[] {
  if (stored.length === 0) return [];

  const byId = new Map(stored.map((entry) => [entry.id, entry]));
  const seedIds = new Set(seed.map((entry) => entry.id));

  const merged = seed.map((seeded) => {
    const held = byId.get(seeded.id);
    if (!held) return { ...seeded };
    return held.label === held.id && seeded.label !== seeded.id
      ? { ...held, label: seeded.label }
      : held;
  });

  return [...merged, ...stored.filter((entry) => !seedIds.has(entry.id))];
}

/**
 * A model as `/v1/models` lists it, reduced to what an entry can carry.
 *
 * The API also says how large a model's window is and what it can do, and none
 * of it is kept: an entry may carry nothing that could reach a guard, and a
 * context size copied in here would be one refactor from becoming one.
 */
export interface DiscoveredModel {
  id: string;
  displayName: string;
}

/**
 * The shape an id from the network must have before it may become an entry.
 *
 * Every entry is a string that reaches `--model` on a spawned argv, and until
 * discovery every one of them was typed by the operator or shipped in a build.
 * This is the first that arrives unattended, so it is held to the shape every id
 * Anthropic has published has had — `claude-`, then lowercase letters and
 * digits in runs joined by `-` or `.` — which refuses a leading dash a CLI
 * parser could take for a flag, whitespace, brackets (`[1m]` is the CLI's
 * construct and the API never lists one), and anything a person could not tell
 * from a model id at a glance. A model named some other way is refused and
 * reported rather than admitted; the operator can still type it in.
 */
const DISCOVERED_ID = /^claude-[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const MAX_DISCOVERED_ID_LENGTH = 100;
const MAX_DISCOVERED_LABEL_LENGTH = 80;

export function isDiscoverableModelId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length <= MAX_DISCOVERED_ID_LENGTH &&
    DISCOVERED_ID.test(id)
  );
}

/**
 * The API's display name, made safe to put on a picker, or the id.
 *
 * A label gates nothing, but it is still text from outside on every page that
 * names a model, so control characters and runs of whitespace go and the length
 * is bounded. Blank falls back to the id, which is what a hand-added entry wears.
 */
function discoveredLabel(displayName: unknown, id: string): string {
  const label =
    typeof displayName === "string"
      ? displayName
          .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      : "";
  if (!label) return id;
  return label.length > MAX_DISCOVERED_LABEL_LENGTH
    ? `${label.slice(0, MAX_DISCOVERED_LABEL_LENGTH - 1)}…`
    : label;
}

export interface DiscoveryMerge {
  /** Every existing entry untouched and in place, then this pass's additions. */
  catalogue: ModelCatalogueEntry[];
  /** What this pass added, in the order the API listed it. */
  added: ModelCatalogueEntry[];
  /** Every id discovery has offered, the record it was given included. */
  offered: string[];
  /** What the API listed that is not the shape of a model id, as listed. */
  refused: string[];
}

/**
 * What a `/v1/models` listing adds to a catalogue, and nothing else.
 *
 * **Adds, never edits.** Existing entries come back as the same objects in the
 * same order, whatever the API says about them: their switch and label are the
 * operator's answer, and their absence from the listing proves nothing — the
 * `[1m]` ids are the CLI's and are never listed, and an operator's own entry may
 * name a model this credential cannot see.
 *
 * **Offered once.** `offered` is every id discovery has already put in front of
 * this list, and an id on it is never added again — that is what keeps a
 * Remove removed, where "add whatever is missing" would undo it at the next
 * fetch. Every listed id is recorded, including one already on the list: an
 * operator's typed entry that the API also lists is then just as removable.
 *
 * **Empty stays empty.** An empty catalogue means no catalogue, and filling it
 * would turn the check back on behind the operator's back. Nothing is recorded
 * as offered either, because nothing was: if they later turn the list back on,
 * the next listing offers what it has.
 *
 * Matching is exact, as everywhere in this file — `claude-sonnet-4-5-20250929`
 * is not `claude-sonnet-4-5` here, whatever `pricing.ts` makes of the two.
 */
export function mergeDiscoveredModels(
  catalogue: readonly ModelCatalogueEntry[],
  discovered: readonly DiscoveredModel[],
  offered: readonly string[],
): DiscoveryMerge {
  const refused: string[] = [];
  const listed: DiscoveredModel[] = [];
  for (const model of discovered) {
    if (isDiscoverableModelId(model.id)) listed.push(model);
    else refused.push(model.id);
  }

  if (catalogue.length === 0) {
    return { catalogue: [], added: [], offered: [...offered], refused };
  }

  const present = new Set(catalogue.map((entry) => entry.id));
  const seen = new Set(offered);
  const nextOffered = [...offered];
  const added: ModelCatalogueEntry[] = [];
  for (const model of listed) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    nextOffered.push(model.id);
    if (present.has(model.id)) continue;
    present.add(model.id);
    added.push({
      id: model.id,
      label: discoveredLabel(model.displayName, model.id),
      enabled: true,
    });
  }

  return {
    catalogue: [...catalogue, ...added],
    added,
    offered: nextOffered,
    refused,
  };
}

/**
 * The `settings` row discovery keeps its record under, beside the blob.
 *
 * Its own row rather than a key of `Settings`, because `saveSettings` rebuilds
 * that blob from `SETTINGS_KEYS` and the page PUTs every key back — so a record
 * kept there would be one any Save could overwrite with what the page loaded.
 */
export const MODEL_DISCOVERY_KEY = "modelDiscovery";

/**
 * What discovery has added, off its stored record, for the default to follow.
 *
 * Read again at this boundary rather than trusted, because the row is JSON on
 * disk and these ids reach `--model`: anything that is not a well-formed id is
 * dropped, every label is re-cleaned, and every entry is enabled, which is the
 * only way discovery ever adds one.
 */
export function discoveredEntriesOf(record: unknown): ModelCatalogueEntry[] {
  if (!record || typeof record !== "object") return [];
  const added = (record as { added?: unknown }).added;
  if (!Array.isArray(added)) return [];

  const entries: ModelCatalogueEntry[] = [];
  const seen = new Set<string>();
  for (const raw of added) {
    if (!raw || typeof raw !== "object") continue;
    const { id, label } = raw as { id?: unknown; label?: unknown };
    if (!isDiscoverableModelId(id) || seen.has(id)) continue;
    seen.add(id);
    entries.push({ id, label: discoveredLabel(label, id), enabled: true });
  }
  return entries;
}

/**
 * The list an install that never edited its own follows: the seed, then what
 * discovery added.
 *
 * `mergeSeededModels` with discovery's additions in the stored list's place,
 * so a model discovery found first and a later release seeds lands where the
 * seed declares it and keeps discovery's switch — exactly what the boot merge
 * does to an install that *has* pinned its list, so the two cannot disagree.
 */
export function defaultCatalogueWith(
  added: readonly ModelCatalogueEntry[],
): ModelCatalogueEntry[] {
  return added.length === 0
    ? SEEDED_MODEL_CATALOGUE
    : mergeSeededModels(added, SEEDED_MODEL_CATALOGUE);
}
