import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { knownModelIds } from "./pricing";
import {
  SEEDED_MODEL_CATALOGUE,
  adoptModelIds,
  defaultCatalogueWith,
  discoveredEntriesOf,
  enabledModels,
  isDiscoverableModelId,
  mergeDiscoveredModels,
  mergeSeededModels,
  modelRefusal,
  normalizeModelCatalogue,
} from "./modelCatalogue";

/**
 * The list every field that names a model is now validated against.
 *
 * Each case below is a wrong answer that produces a plausible page rather than
 * an error, which is this suite's bar. A model missing from the seed is a
 * picker one option short and nothing anywhere says so. A refusal that fires on
 * a blank is every run refused for naming no model, which is the ordinary case.
 * A refusal that fires on an empty list is an install where nothing can start
 * at all. A `[1m]` id that loses its brackets somewhere in here is a `--model`
 * the CLI rejects at a spawn nobody is watching.
 */
describe("the model catalogue", () => {
  it("seeds one entry per priced model, and nothing the price table lacks", () => {
    // `pricing.ts` is the one answer to which models exist. A seed that drifted
    // from it in either direction is silent: a missing entry is an option the
    // operator has to type by hand for no stated reason, and an invented one is
    // a picker offering an id nothing can price, which shows as $0.00 rather
    // than as a mistake.
    const seeded = SEEDED_MODEL_CATALOGUE.filter((e) => !e.id.endsWith("[1m]"));
    assert.deepEqual(
      seeded.map((e) => e.id).sort(),
      [...knownModelIds()].sort(),
    );
    for (const entry of SEEDED_MODEL_CATALOGUE) {
      assert.ok(entry.label.trim(), `${entry.id} has no label`);
    }
  });

  it("gives every priced model a declared label, not its own id", () => {
    // The other half of the agreement one case up, and the half that was
    // implied rather than asserted. `seedCatalogue` falls back to
    // `MODEL_LABELS[id] ?? id`, so a model added to `PRICES` and forgotten in
    // `MODEL_LABELS` seeds *fine* — one entry, enabled or not as the seed says,
    // wearing `claude-opus-5-5` where the picker beside it says "Claude Opus 5".
    // A label check that only asks for a non-blank string passes that, which
    // made the docblock's claim that this file is the loud channel for a
    // half-added model not quite true.
    for (const entry of SEEDED_MODEL_CATALOGUE) {
      if (entry.id.endsWith("[1m]")) continue; // derived: `${label} (1M context)`
      assert.notEqual(
        entry.label,
        entry.id,
        `${entry.id} is priced but has no entry in MODEL_LABELS`,
      );
    }
  });

  it("carries Claude Opus 5.5, its 1M variant, and both enabled on seed", () => {
    // Pinned by name because the three tables it has to appear in are in two
    // files and nothing joins them: `PRICES` decides what it costs,
    // `MODEL_LABELS` what it is called, `ONE_MEGA_VARIANTS` whether the 1M
    // deployment the pinned CLI names can be picked at all. Missing from the
    // last one is the quiet one — no error anywhere, just an option that is not
    // on the list, and an operator who types the id by hand gets a refusal from
    // a validator that is working exactly as written.
    const byId = new Map(SEEDED_MODEL_CATALOGUE.map((e) => [e.id, e]));
    assert.deepEqual(byId.get("claude-opus-5-5"), {
      id: "claude-opus-5-5",
      label: "Claude Opus 5.5",
      enabled: true,
    });
    assert.deepEqual(byId.get("claude-opus-5-5[1m]"), {
      id: "claude-opus-5-5[1m]",
      label: "Claude Opus 5.5 (1M context)",
      enabled: true,
    });
    // An addition and not a replacement: Opus 5 is listed legacy and still
    // served, so a transcript naming it still prices and a run may still start
    // on it.
    assert.equal(byId.get("claude-opus-5")?.enabled, true);
  });

  it("gives every [1m] variant a base the price table can resolve", () => {
    // The suffix is the CLI's and the base is the price table's, so a variant
    // whose base has been renamed prices at `UNKNOWN_MODEL_PRICE` — $10/$50 on
    // a model that may cost $1/$5 — while looking entirely ordinary on a picker.
    const bases = new Set(knownModelIds());
    for (const entry of SEEDED_MODEL_CATALOGUE) {
      if (!entry.id.endsWith("[1m]")) continue;
      const base = entry.id.slice(0, -"[1m]".length);
      assert.ok(
        [...bases].some((known) => base.startsWith(known)),
        `${entry.id} has no base in the price table`,
      );
    }
  });

  it("keeps at least one model enabled on a fresh install", () => {
    // A seed with nothing switched on refuses every run on an install nobody
    // has configured yet, which is every install on its first boot.
    assert.ok(enabledModels(SEEDED_MODEL_CATALOGUE).length > 0);
    assert.ok(
      enabledModels(SEEDED_MODEL_CATALOGUE).some((e) => e.id.endsWith("[1m]")),
      "no 1M variant is offered, which is the whole point of adding them",
    );
  });

  describe("modelRefusal", () => {
    const catalogue = [
      { id: "claude-opus-5", label: "Claude Opus 5", enabled: true },
      { id: "claude-opus-5[1m]", label: "Claude Opus 5 (1M)", enabled: true },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", enabled: false },
    ];

    it("passes an enabled id, brackets and all", () => {
      assert.equal(modelRefusal(catalogue, "claude-opus-5"), null);
      assert.equal(modelRefusal(catalogue, "claude-opus-5[1m]"), null);
      assert.equal(modelRefusal(catalogue, "  claude-opus-5[1m]  "), null);
    });

    it("passes every way of naming none", () => {
      // Null is the fallback rung — the agent's model, then the operator's
      // default, then the CLI's own — and a refusal here would take all three
      // away from the ordinary run that names nothing at all.
      for (const none of [null, undefined, "", "   "]) {
        assert.equal(modelRefusal(catalogue, none), null, JSON.stringify(none));
      }
    });

    it("refuses on an empty list only if the list is empty of *entries*", () => {
      // Empty means no list and refuses nothing; that is what keeps the free
      // text this replaced available to an operator who wants it back.
      assert.equal(modelRefusal([], "claude-opus-9"), null);
      // A list that exists and has nothing switched on would refuse everything,
      // which is why `normalizeModelCatalogue` will not store one.
      const allOff = catalogue.map((e) => ({ ...e, enabled: false }));
      assert.equal(modelRefusal(allOff, "claude-opus-5"), null);
    });

    it("names what was seen and what is available", () => {
      const refusal = modelRefusal(catalogue, "claude-opus-6");
      assert.ok(refusal);
      assert.match(refusal, /claude-opus-6/);
      assert.match(refusal, /claude-opus-5\[1m\]/);
    });

    it("says switched off rather than unknown for a disabled entry", () => {
      // Two different fixes: one is a switch, the other is typing an id. A
      // single wording would send the operator to the wrong one.
      const refusal = modelRefusal(catalogue, "claude-haiku-4-5");
      assert.ok(refusal);
      assert.match(refusal, /switched off/);
    });

    it("matches exactly, never by prefix or decoration", () => {
      // The question is "may this string reach `--model`". A provider-decorated
      // spelling prices fine and is not what the CLI takes, and a prefix match
      // would admit `claude-opus-5-1` on the strength of `claude-opus-5`.
      assert.ok(modelRefusal(catalogue, "us.anthropic.claude-opus-5"));
      assert.ok(modelRefusal(catalogue, "claude-opus-5-1"));
      assert.ok(modelRefusal(catalogue, "claude-opus-5[1m]x"));
    });
  });

  describe("normalizeModelCatalogue", () => {
    it("refuses a list with nothing enabled, and allows an empty one", () => {
      const allOff = normalizeModelCatalogue([
        { id: "claude-opus-5", label: "Claude Opus 5", enabled: false },
      ]);
      assert.ok("error" in allOff);
      const empty = normalizeModelCatalogue([]);
      assert.ok("catalogue" in empty);
      assert.deepEqual(empty.catalogue, []);
    });

    it("refuses a duplicate id and a blank one", () => {
      // Two rows for one id is a switch that appears to do nothing, because the
      // other row still answers for it.
      const dup = normalizeModelCatalogue([
        { id: "claude-opus-5", label: "a", enabled: true },
        { id: " claude-opus-5 ", label: "b", enabled: false },
      ]);
      assert.ok("error" in dup);
      assert.ok("error" in normalizeModelCatalogue([{ id: "  ", label: "x", enabled: true }]));
      assert.ok("error" in normalizeModelCatalogue("claude-opus-5"));
    });

    it("falls back to the id for a label and to off for a missing switch", () => {
      const result = normalizeModelCatalogue([
        { id: " claude-opus-5[1m] ", enabled: true },
        { id: "claude-opus-5", label: "  ", enabled: "yes" },
      ]);
      assert.ok("catalogue" in result);
      assert.deepEqual(result.catalogue, [
        { id: "claude-opus-5[1m]", label: "claude-opus-5[1m]", enabled: true },
        { id: "claude-opus-5", label: "claude-opus-5", enabled: false },
      ]);
    });
  });

  describe("adoptModelIds", () => {
    it("adds what is missing, enabled, and touches nothing that is there", () => {
      // The migration's half: an operator running on a model this build never
      // heard of keeps it. Dropping one would reset a working configuration
      // under a feature whose whole claim is that it protects one.
      const before = [
        { id: "claude-opus-5", label: "Claude Opus 5", enabled: false },
      ];
      const after = adoptModelIds(before, [
        "claude-opus-5",
        " claude-opus-9 ",
        "claude-opus-9",
        "",
      ]);
      assert.deepEqual(after, [
        { id: "claude-opus-5", label: "Claude Opus 5", enabled: false },
        { id: "claude-opus-9", label: "claude-opus-9", enabled: true },
      ]);
    });

    it("is idempotent, which is the only thing making it safe in migrate()", () => {
      const once = adoptModelIds(SEEDED_MODEL_CATALOGUE, ["claude-opus-9"]);
      assert.deepEqual(adoptModelIds(once, ["claude-opus-9"]), once);
    });
  });

  /**
   * What reaches an install that has already pinned its list.
   *
   * The settings page promises it in as many words — a seeded row has no Remove
   * button because "the seed comes back on the next release" — and until
   * `mergeSeededModels` nothing kept it. `saveSettings` pins `modelCatalogue`
   * the moment it differs from `DEFAULTS`, which one model switched off is
   * enough to do, and from then on every future seed addition was dead for that
   * install. Silent in the way that matters: the picker is simply one option
   * short, with nothing anywhere saying a model shipped.
   */
  describe("mergeSeededModels", () => {
    const SEED = [
      { id: "new-opus", label: "New Opus", enabled: true },
      { id: "old-opus", label: "Old Opus", enabled: true },
      { id: "retired", label: "Retired", enabled: false },
    ];

    it("adds what this release seeded and keeps every stored answer", () => {
      // `new-opus` shipped after this list was written. `old-opus` the operator
      // switched off and `retired` they switched on — both are their answers and
      // neither is the seed's to revisit, which is the difference between this
      // and re-running adoption.
      const stored = [
        { id: "old-opus", label: "Old Opus", enabled: false },
        { id: "retired", label: "Retired", enabled: true },
      ];
      assert.deepEqual(mergeSeededModels(stored, SEED), [
        { id: "new-opus", label: "New Opus", enabled: true },
        { id: "old-opus", label: "Old Opus", enabled: false },
        { id: "retired", label: "Retired", enabled: true },
      ]);
    });

    it("puts a new model where the seed declares it, not on the end", () => {
      // Declaration order is display order, so an id appended to the list would
      // read as older than everything above it — and the newest model is the one
      // an operator is looking for.
      const merged = mergeSeededModels(
        [{ id: "old-opus", label: "Old Opus", enabled: true }],
        SEED,
      );
      assert.equal(merged[0]?.id, "new-opus");
    });

    it("keeps the operator's own entries, after the seed and in their order", () => {
      // Theirs is the one kind of entry that can be removed, so it is also the
      // one kind this must never reorder or drop: it is not in the seed and
      // nothing here has an opinion about it.
      const merged = mergeSeededModels(
        [
          { id: "old-opus", label: "Old Opus", enabled: true },
          { id: "acme-one", label: "acme-one", enabled: true },
          { id: "acme-two", label: "acme-two", enabled: false },
        ],
        SEED,
      );
      assert.deepEqual(merged.slice(-2), [
        { id: "acme-one", label: "acme-one", enabled: true },
        { id: "acme-two", label: "acme-two", enabled: false },
      ]);
    });

    it("names a model the operator had typed in before it was seeded", () => {
      // `addModel` and `adoptModelIds` both write the raw id as the label,
      // because it is the only true thing known about a model the build has not
      // heard of. Once it is seeded the build has heard of it, and leaving the
      // id there puts `new-opus` on a picker under "Old Opus". Their `enabled`
      // is still untouched — a label gates nothing.
      const merged = mergeSeededModels(
        [{ id: "new-opus", label: "new-opus", enabled: false }],
        SEED,
      );
      assert.deepEqual(merged[0], {
        id: "new-opus",
        label: "New Opus",
        enabled: false,
      });
    });

    it("leaves a label the operator chose alone", () => {
      const merged = mergeSeededModels(
        [{ id: "new-opus", label: "My Opus", enabled: true }],
        SEED,
      );
      assert.equal(merged[0]?.label, "My Opus");
    });

    it("is idempotent, which is what makes it safe on every boot", () => {
      // `adoptModelsInUse` beside it has to run once, because re-adopting from
      // templates would switch a model back on the morning after the operator
      // switched it off. This one cannot: a seeded id has no Remove button, so
      // "absent" can only ever mean "shipped since", never "taken off".
      const once = mergeSeededModels([], SEED);
      assert.deepEqual(mergeSeededModels(once, SEED), once);
      assert.deepEqual(
        mergeSeededModels(SEEDED_MODEL_CATALOGUE),
        SEEDED_MODEL_CATALOGUE.map((entry) => ({ ...entry })),
      );
    });

    it("carries Claude Opus 5.5 onto a list written before it shipped", () => {
      // The case that found all of this: priced, labelled and seeded on, and
      // invisible on every picker of an install that had ever touched the list.
      const before = SEEDED_MODEL_CATALOGUE.filter(
        (entry) => !entry.id.startsWith("claude-opus-5-5"),
      );
      const after = mergeSeededModels(before);
      assert.deepEqual(
        after.filter((entry) => entry.id.startsWith("claude-opus-5-5")),
        [
          { id: "claude-opus-5-5", label: "Claude Opus 5.5", enabled: true },
          {
            id: "claude-opus-5-5[1m]",
            label: "Claude Opus 5.5 (1M context)",
            enabled: true,
          },
        ],
      );
      assert.equal(after.length, SEEDED_MODEL_CATALOGUE.length);
    });
  });

  /**
   * What a `/v1/models` listing may do to a list the operator owns.
   *
   * Every case is a way the operator's configuration changes with nothing on
   * any page saying it did, which is the one outcome this feature cannot have:
   * a label or switch rewritten by a fetch, a Remove that undoes itself the next
   * morning, a cleared list that turns itself back on, or a `[1m]` id dropped for
   * not being something the API would ever list.
   */
  describe("mergeDiscoveredModels", () => {
    const listing = (...ids: string[]) =>
      ids.map((id) => ({ id, displayName: `Name of ${id}` }));

    it("adds what was never offered, enabled and under the API's name, after everything", () => {
      const catalogue = [
        { id: "claude-opus-5", label: "Claude Opus 5", enabled: true },
        { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", enabled: false },
      ];
      const merge = mergeDiscoveredModels(
        catalogue,
        listing("claude-opus-6", "claude-opus-5"),
        [],
      );
      assert.deepEqual(merge.catalogue, [
        ...catalogue,
        { id: "claude-opus-6", label: "Name of claude-opus-6", enabled: true },
      ]);
      assert.deepEqual(merge.added.map((e) => e.id), ["claude-opus-6"]);
      assert.deepEqual(merge.offered, ["claude-opus-6", "claude-opus-5"]);
    });

    it("never touches an existing entry's label, switch or place", () => {
      // The API calls it something else and lists it first. Neither is a reason
      // to rename what the operator reads or move a row they know where to find,
      // and a model they switched off stays off however current it is.
      const catalogue = [
        { id: "acme-one", label: "acme-one", enabled: true },
        { id: "claude-opus-5", label: "My Opus", enabled: false },
      ];
      const merge = mergeDiscoveredModels(
        catalogue,
        [{ id: "claude-opus-5", displayName: "Claude Opus 5" }],
        [],
      );
      assert.deepEqual(merge.catalogue, catalogue);
      assert.equal(merge.catalogue[1], catalogue[1], "the entry was rebuilt");
      assert.deepEqual(merge.added, []);
    });

    it("keeps every entry the API does not list, [1m] and hand-added ids included", () => {
      // The `[1m]` ids are the CLI's construct and no listing will ever carry
      // one, so "unlisted means gone" would empty the 1M rows on the first
      // fetch. A hand-added id may be a model this credential cannot see.
      const catalogue = [
        { id: "claude-opus-5[1m]", label: "Claude Opus 5 (1M context)", enabled: true },
        { id: "acme-model-9", label: "acme-model-9", enabled: true },
      ];
      const merge = mergeDiscoveredModels(catalogue, listing("claude-opus-6"), []);
      assert.deepEqual(merge.catalogue.slice(0, 2), catalogue);
    });

    it("does not re-add an id it offered before and the operator removed", () => {
      // The whole of what keeps Remove removed. "Add whatever is missing" would
      // put it back at the next daily check, enabled.
      const first = mergeDiscoveredModels(
        [{ id: "claude-opus-5", label: "Claude Opus 5", enabled: true }],
        listing("claude-opus-6"),
        [],
      );
      const removed = first.catalogue.filter((e) => e.id !== "claude-opus-6");
      const second = mergeDiscoveredModels(removed, listing("claude-opus-6"), first.offered);
      assert.deepEqual(second.catalogue, removed);
      assert.deepEqual(second.added, []);
    });

    it("records a listed id already on the list as offered, so removing it later sticks too", () => {
      // An operator who typed an id in before discovery found it can still
      // remove it; were it not recorded, the next check would add it back.
      const merge = mergeDiscoveredModels(
        [{ id: "claude-opus-6", label: "claude-opus-6", enabled: true }],
        listing("claude-opus-6"),
        [],
      );
      assert.deepEqual(merge.offered, ["claude-opus-6"]);
      const afterRemove = mergeDiscoveredModels(
        [{ id: "claude-opus-5", label: "Claude Opus 5", enabled: true }],
        listing("claude-opus-6"),
        merge.offered,
      );
      assert.deepEqual(afterRemove.added, []);
    });

    it("leaves an empty list empty and records nothing as offered", () => {
      // Empty means no catalogue and nothing refused. Filling it would turn the
      // check back on behind the operator's back; and since nothing was put in
      // front of a list, a list they turn back on later is still offered these.
      const merge = mergeDiscoveredModels([], listing("claude-opus-6"), ["claude-opus-5"]);
      assert.deepEqual(merge.catalogue, []);
      assert.deepEqual(merge.added, []);
      assert.deepEqual(merge.offered, ["claude-opus-5"]);
    });

    it("refuses and reports what is not shaped like a model id", () => {
      // These reach `--model` on a spawned argv, and this is the first door
      // they arrive through unattended.
      const odd = [
        "--dangerously-skip-permissions",
        "claude-opus-6[1m]",
        "claude opus 6",
        "Claude-Opus-6",
        "gpt-5",
        "claude-",
        `claude-${"x".repeat(120)}`,
      ];
      const merge = mergeDiscoveredModels(
        [{ id: "claude-opus-5", label: "Claude Opus 5", enabled: true }],
        [...listing(...odd), ...listing("claude-sonnet-4-5-20250929")],
        [],
      );
      assert.deepEqual(merge.refused, odd);
      assert.deepEqual(merge.added.map((e) => e.id), ["claude-sonnet-4-5-20250929"]);
      assert.deepEqual(merge.offered, ["claude-sonnet-4-5-20250929"]);
    });

    it("matches exactly, so a dated snapshot is its own entry", () => {
      // `pricing.ts` prices the two the same; this list answers "may this
      // string reach --model", where they are different strings.
      const merge = mergeDiscoveredModels(
        [{ id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", enabled: true }],
        listing("claude-sonnet-4-5-20250929"),
        [],
      );
      assert.deepEqual(merge.added.map((e) => e.id), ["claude-sonnet-4-5-20250929"]);
    });

    it("cleans the display name, and falls back to the id when there is none", () => {
      const merge = mergeDiscoveredModels(
        [{ id: "claude-opus-5", label: "Claude Opus 5", enabled: true }],
        [
          { id: "claude-opus-6", displayName: "  Claude\nOpus\u0007 6  " },
          { id: "claude-opus-7", displayName: "   " },
        ],
        [],
      );
      assert.deepEqual(merge.added, [
        { id: "claude-opus-6", label: "Claude Opus 6", enabled: true },
        { id: "claude-opus-7", label: "claude-opus-7", enabled: true },
      ]);
    });

    it("keeps normalizeModelCatalogue's invariants true of what it returns", () => {
      const merge = mergeDiscoveredModels(
        [{ id: "claude-opus-5", label: "Claude Opus 5", enabled: true }],
        listing("claude-opus-6", "claude-opus-6", "claude-opus-5"),
        [],
      );
      const normalized = normalizeModelCatalogue(merge.catalogue);
      assert.ok("catalogue" in normalized, JSON.stringify(normalized));
      assert.deepEqual(normalized.catalogue, merge.catalogue);
    });
  });

  /**
   * The default an install that never edited its list follows.
   *
   * Read off a JSON row and onto `--model`, so it is a boundary in its own
   * right, and it is what decides whether such an install keeps reading as
   * unedited and keeps following the seed.
   */
  describe("discovered entries as a default", () => {
    it("drops a stored id that is not a model id, and every entry comes back enabled", () => {
      assert.deepEqual(
        discoveredEntriesOf({
          added: [
            { id: "claude-opus-6", label: "Claude Opus 6", enabled: false },
            { id: "--model", label: "x", enabled: true },
            { id: "claude-opus-6", label: "again", enabled: true },
            "claude-opus-7",
          ],
        }),
        [{ id: "claude-opus-6", label: "Claude Opus 6", enabled: true }],
      );
      assert.deepEqual(discoveredEntriesOf(null), []);
      assert.deepEqual(discoveredEntriesOf({ added: "nope" }), []);
    });

    it("is the seed untouched when discovery has added nothing", () => {
      assert.equal(defaultCatalogueWith([]), SEEDED_MODEL_CATALOGUE);
    });

    it("puts the seed first and discovery's additions after it", () => {
      const added = [{ id: "claude-opus-6", label: "Claude Opus 6", enabled: true }];
      const merged = defaultCatalogueWith(added);
      assert.deepEqual(merged.slice(0, SEEDED_MODEL_CATALOGUE.length), SEEDED_MODEL_CATALOGUE);
      assert.deepEqual(merged.slice(SEEDED_MODEL_CATALOGUE.length), added);
    });

    it("accepts every seeded id that is not a [1m] variant as discoverable", () => {
      // A sanity check on the shape against ids Anthropic actually published:
      // a pattern too strict to admit the seed would refuse next week's model.
      for (const entry of SEEDED_MODEL_CATALOGUE) {
        assert.equal(
          isDiscoverableModelId(entry.id),
          !entry.id.endsWith("[1m]"),
          entry.id,
        );
      }
    });
  });
});
