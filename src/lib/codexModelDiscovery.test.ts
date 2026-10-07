import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { CodexListedModel, CodexReadResult } from "./codexAccount";
import type { CodexDiscoveryDeps } from "./codexModelDiscovery";

/**
 * Codex model discovery through the real store, `modelDiscovery.test.ts`'s
 * rule: the merge is `mergeDiscoveredModels` and has its own cases, so what
 * is pinned here is the wiring — and the one place the Codex list differs from
 * the Claude one, an empty default that the first listing must fill.
 *
 * Every failure here is quiet. A first listing that fills nothing leaves every
 * Codex picker on free text for ever with "Listed 4 models" beside it; one
 * that pins the stored blob stops the install following later listings; a
 * removed model coming back enabled at the next daily check; and a stored
 * empty list — the operator's "no list" — filled behind their back.
 *
 * Its own file with `DATA_DIR` named before the first import. The cases run in
 * order and build on each other.
 */

let root: string;
let discovery: typeof import("./codexModelDiscovery");
let settings: typeof import("./settings");

const listed = (...ids: string[]): CodexListedModel[] =>
  ids.map((id, i) => ({ id, displayName: `Display ${id}`, isDefault: i === 0 }));

function deps(result: CodexReadResult<CodexListedModel[]>): CodexDiscoveryDeps {
  return { list: async () => result, now: () => 1_800_000_000_000 };
}

function storedBlob(): Record<string, unknown> {
  return settings.isStoredSetting("codexModelCatalogue")
    ? { codexModelCatalogue: true }
    : {};
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-codex-discovery-"));
  process.env.DATA_DIR = root;
  const dbMod = await import("./db");
  discovery = await import("./codexModelDiscovery");
  settings = await import("./settings");
  dbMod.db();
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Codex model discovery through the store", () => {
  it("leaves the list empty and says why when Codex is signed out", async () => {
    const status = await discovery.checkForNewCodexModels(
      deps({ ok: false, error: "Codex is not signed in (Settings → Codex account)" }),
    );
    assert.deepEqual(settings.getSettings().codexModelCatalogue, []);
    assert.equal(status.error, "Codex is not signed in (Settings → Codex account)");
    assert.equal(status.lastSuccessAt, null);
  });

  it("fills the empty default on the first listing, without storing it", async () => {
    const status = await discovery.checkForNewCodexModels(
      deps({ ok: true, value: listed("gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-luna") }),
    );
    assert.deepEqual(
      settings.getSettings().codexModelCatalogue.map((e) => [e.id, e.label, e.enabled]),
      [
        ["gpt-6-astra", "Display gpt-6-astra", true],
        ["gpt-5.6-sol", "Display gpt-5.6-sol", true],
        ["gpt-5.6-luna", "Display gpt-5.6-luna", true],
      ],
    );
    // Following the default, so the stored blob carries no list — and a Save
    // of an unrelated key must not pin one either.
    assert.deepEqual(storedBlob(), {});
    settings.saveSettings({ includeSidechains: false });
    assert.deepEqual(storedBlob(), {});
    assert.equal(status.error, null);
    assert.deepEqual(status.added, ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-luna"]);
    assert.deepEqual(status.cliDefault, { id: "gpt-6-astra", label: "Display gpt-6-astra" });
  });

  it("refuses an id not shaped like a model slug, and reports it", async () => {
    const status = await discovery.checkForNewCodexModels(
      deps({ ok: true, value: listed("gpt-6-astra", "--dangerous", "GPT Upper") }),
    );
    assert.deepEqual(status.refused, ["--dangerous", "GPT Upper"]);
    assert.ok(
      !settings.getSettings().codexModelCatalogue.some((e) => e.id === "--dangerous"),
    );
  });

  it("writes a later listing's additions into a list the operator stored", async () => {
    const current = settings.getSettings().codexModelCatalogue;
    settings.saveSettings({
      codexModelCatalogue: current
        .filter((e) => e.id !== "gpt-5.6-sol")
        .map((e) => (e.id === "gpt-5.6-luna" ? { ...e, enabled: false } : e)),
    });
    assert.ok(settings.isStoredSetting("codexModelCatalogue"));

    await discovery.checkForNewCodexModels(
      deps({ ok: true, value: listed("gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-7") }),
    );
    // The removed model stays removed, the switched-off one stays off, and the
    // new one arrives enabled at the end.
    assert.deepEqual(
      settings.getSettings().codexModelCatalogue.map((e) => [e.id, e.enabled]),
      [
        ["gpt-6-astra", true],
        ["gpt-5.6-luna", false],
        ["gpt-7", true],
      ],
    );
  });

  it("leaves a stored empty list empty", async () => {
    settings.saveSettings({ codexModelCatalogue: [] });
    assert.ok(settings.isStoredSetting("codexModelCatalogue"));
    await discovery.checkForNewCodexModels(
      deps({ ok: true, value: listed("gpt-6-astra", "gpt-8") }),
    );
    assert.deepEqual(settings.getSettings().codexModelCatalogue, []);
  });
});
