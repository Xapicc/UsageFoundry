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
});
