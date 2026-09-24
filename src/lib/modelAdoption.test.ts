import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { ModelCatalogueEntry } from "./modelCatalogue";

/**
 * What `migrate()` does to an install that was already naming models when
 * `settings.modelCatalogue` arrived.
 *
 * Driven through the real boot rather than asserted about it, `runOrigin`'s
 * rule: `adoptModelIds` is a pure function with its own cases in
 * `modelCatalogue.test.ts`, and a test that called it here would pin this
 * file's own argument and nothing about what a boot actually writes.
 *
 * Both failures are silent and neither is recoverable by the operator.
 *
 * Adopt too little and an install running on a model this build's seed never
 * heard of finds every door refusing it — the settings default, the run form,
 * the chat — with a working configuration reset by an upgrade nobody asked for
 * anything from. Adopt too often and the reverse: a model the operator
 * deliberately switched off comes back on the next restart, because a template
 * still names it, and it comes back *enabled*. Nothing throws either way, both
 * pages look right, and the second one only shows up as a run that started on a
 * model somebody had retired.
 *
 * Its own file with `DATA_DIR` named before the first import, for
 * `runOrigin.test.ts`'s reason: `config.ts` is read at module load.
 */

let root: string;
let dbMod: typeof import("./db");
let agents: typeof import("./agents");

/** The blob `getSettings()` reads, straight off the row. */
function storedSettings(): Record<string, unknown> {
  const raw = dbMod.getSetting("settings");
  return raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
}

function storedCatalogue(): ModelCatalogueEntry[] | undefined {
  return storedSettings().modelCatalogue as ModelCatalogueEntry[] | undefined;
}

/**
 * Close the handle so the next `db()` re-opens the same file and migrates it
 * again — which is the only way to ask "what does the *second* boot do".
 */
function reboot(): void {
  const held = globalThis as unknown as { __ufDb?: { close(): void } };
  held.__ufDb?.close();
  delete held.__ufDb;
  dbMod.db();
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-model-adoption-"));
  process.env.DATA_DIR = root;
  dbMod = await import("./db");
  agents = await import("./agents");
  dbMod.db();
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("adopting the models an install already runs on", () => {
  it("writes nothing when there is nothing to adopt", () => {
    // The ordinary install. Leaving the key absent is what keeps it following
    // `DEFAULTS`, so a model added to the seed in a later release reaches it.
    assert.equal(storedCatalogue(), undefined);
  });

  it("adopts the operator's default, a template's and an agent's, enabled", () => {
    dbMod.setJSON("settings", { defaultModel: "acme-opus", maxConcurrentRuns: 3 });
    agents.createAgent({
      name: "adoption-probe",
      description: "reads diffs",
      prompt: "You review.",
      model: "acme-haiku",
    });
    dbMod
      .db()
      .prepare(
        `INSERT INTO run_templates (id, name, prompt, permission_mode, isolate,
           budget, model, created_at, updated_at)
         VALUES ('t-adopt', 'probe', 'p', 'plan', 0, '{}', 'acme-sonnet', 0, 0)`,
      )
      .run();

    reboot();

    const catalogue = storedCatalogue();
    assert.ok(catalogue, "the boot wrote no catalogue at all");
    for (const id of ["acme-opus", "acme-haiku", "acme-sonnet"]) {
      const entry: ModelCatalogueEntry | undefined = catalogue.find(
        (e) => e.id === id,
      );
      assert.ok(entry, `${id} was dropped`);
      assert.equal(entry.enabled, true, `${id} was adopted switched off`);
    }
    // Beside the seed rather than instead of it.
    assert.ok(catalogue.some((e) => e.id === "claude-opus-5[1m]"));
    // And nothing else on the blob was disturbed.
    assert.equal(storedSettings().maxConcurrentRuns, 3);
  });

  it("never runs again once a list is stored", () => {
    // `acme-sonnet` is still on the template. The operator has now switched it
    // off, which is the whole reason the gate is "has this install a list" and
    // not "is there anything missing from it".
    const kept = (storedCatalogue() ?? []).map((e) =>
      e.id === "acme-sonnet" ? { ...e, enabled: false } : e,
    );
    dbMod.setJSON("settings", { ...storedSettings(), modelCatalogue: kept });

    reboot();

    const reread: ModelCatalogueEntry[] | undefined = storedCatalogue();
    assert.ok(reread);
    assert.equal(reread.find((e) => e.id === "acme-sonnet")?.enabled, false);

    // And a model added to a template after the list exists is not adopted
    // either: that door refuses at the run, in front of the person starting it.
    dbMod
      .db()
      .prepare(
        `INSERT INTO run_templates (id, name, prompt, permission_mode, isolate,
           budget, model, created_at, updated_at)
         VALUES ('t-later', 'later', 'p', 'plan', 0, '{}', 'acme-later', 0, 0)`,
      )
      .run();
    reboot();
    assert.equal(
      (storedCatalogue() ?? []).some((e) => e.id === "acme-later"),
      false,
    );
  });

  /**
   * The other half, and the one an upgrade depends on: a model added to the
   * seed **does** reach an install that has pinned its list.
   *
   * Driven through the real boot for this file's stated reason —
   * `mergeSeededModels` has its own cases in `modelCatalogue.test.ts` and
   * calling it here would pin this file's own argument rather than what a boot
   * writes. What a boot writes is the whole question: the pure function was
   * correct and unreachable until `migrate()` called it, and the symptom of that
   * is a picker one option short with nothing anywhere saying why.
   */
  it("brings a newly seeded model onto a list the install already stores", () => {
    // Exactly the state an upgrade arrives at, built from what this install
    // actually stores — the seed plus the three `acme-*` entries the cases above
    // adopted — with the Opus 5.5 rows taken back out. Derived rather than
    // written down so it keeps meaning "a list from before the newest model"
    // when the newest model is no longer this one.
    const withoutNewest = (storedCatalogue() ?? [])
      .filter((e) => !e.id.startsWith("claude-opus-5-5"))
      .map((e) => ({ ...e }));
    assert.ok(
      withoutNewest.length > 0 && withoutNewest.some((e) => e.id === "acme-opus"),
      "the fixture did not inherit the adopted list from the cases above",
    );
    // One seeded model switched off, to prove the merge is not a reset: that is
    // the operator's answer, and re-running adoption is what would undo it.
    const retired = withoutNewest.find((e) => e.id === "claude-opus-5");
    assert.ok(retired, "the fixture no longer names claude-opus-5");
    retired.enabled = false;

    dbMod.setJSON("settings", {
      ...storedSettings(),
      modelCatalogue: withoutNewest,
    });

    reboot();

    const after = storedCatalogue();
    assert.ok(after, "the boot dropped the catalogue");
    assert.deepEqual(
      after.filter((e) => e.id.startsWith("claude-opus-5-5")),
      [
        { id: "claude-opus-5-5", label: "Claude Opus 5.5", enabled: true },
        {
          id: "claude-opus-5-5[1m]",
          label: "Claude Opus 5.5 (1M context)",
          enabled: true,
        },
      ],
      "the newly seeded model did not reach a stored list",
    );
    // The switch the operator threw is still thrown, and their own adopted
    // entries from the cases above survived the merge.
    assert.equal(after.find((e) => e.id === "claude-opus-5")?.enabled, false);
    for (const id of ["acme-opus", "acme-haiku", "acme-sonnet"]) {
      assert.ok(after.some((e) => e.id === id), `${id} was lost in the merge`);
    }

    // And a second boot is a no-op rather than a second write.
    const snapshot = JSON.stringify(after);
    reboot();
    assert.equal(JSON.stringify(storedCatalogue()), snapshot);
  });
});
