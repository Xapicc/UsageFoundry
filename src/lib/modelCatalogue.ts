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
 * MEASURED rather than reasoned: these are exactly the eight `[1m]` strings the
 * pinned CLI carries (`claude --version` 2.1.260), read out of the binary. The
 * suffix is a request for the 1M-context deployment of that model, so the list
 * is the CLI's to grow and not this build's to guess — `claude-fable-5-1[1m]`
 * looks like it should exist and the pinned CLI does not name it, which is
 * precisely why nothing here derives a variant from a base.
 *
 * `base` is a price-table key rather than a label, so a variant cannot end up
 * named after a model the price table has never heard of.
 */
const ONE_MEGA_VARIANTS: { id: string; base: string }[] = [
  { id: "claude-fable-5[1m]", base: "claude-fable-5" },
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
