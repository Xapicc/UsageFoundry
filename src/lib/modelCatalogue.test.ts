import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { knownModelIds } from "./pricing";
import {
  SEEDED_MODEL_CATALOGUE,
  adoptModelIds,
  enabledModels,
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
});
