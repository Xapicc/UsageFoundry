import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { DiscoveryCredential, DiscoveryDeps } from "./modelDiscovery";
import type { ModelCatalogueEntry } from "./modelCatalogue";

/**
 * Model discovery against a stubbed `/v1/models`, and through the real store.
 *
 * The listing half earns its cases because every way it goes wrong is quiet: a
 * second page never asked for is a model never offered, a credential echoed in
 * an error lands in a log and on a page, and a body read in part offers — and so
 * uses up — whatever was on the pages that loaded.
 *
 * The store half is driven through `getSettings`/`saveSettings` and a real boot
 * rather than asserted about, `modelAdoption.test.ts`'s rule: the merge is pure
 * and has its own cases in `modelCatalogue.test.ts`, and what can go wrong here
 * is the wiring around it — an install that never touched its list getting
 * pinned by a fetch, a Save undoing what discovery added, a boot dropping it.
 *
 * Its own file with `DATA_DIR` named before the first import, because
 * `config.ts` is read at module load. The store cases run in order and build
 * on each other, as that file's do.
 */

let root: string;
let dbMod: typeof import("./db");
let discovery: typeof import("./modelDiscovery");
let settings: typeof import("./settings");
let catalogueMod: typeof import("./modelCatalogue");

const API_KEY: DiscoveryCredential = { kind: "api_key", secret: "sk-ant-test-secret" };
const SIGN_IN: DiscoveryCredential = { kind: "claude_code", secret: "oat-test-token" };

type Reply = { status?: number; body: unknown } | Error;

/** A `fetch` that answers from a script and records what it was asked. */
function stubFetch(replies: Reply[]) {
  const calls: { url: URL; headers: Record<string, string> }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: new URL(String(input)),
      headers: { ...(init?.headers as Record<string, string>) },
    });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (reply instanceof Error) throw reply;
    const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return new Response(text, { status: reply.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
}

function page(ids: string[], more: { hasMore?: boolean; lastId?: string | null } = {}) {
  return {
    data: ids.map((id) => ({
      type: "model",
      id,
      display_name: `Display ${id}`,
      created_at: "2026-09-01T00:00:00Z",
    })),
    has_more: more.hasMore ?? false,
    first_id: ids[0] ?? null,
    last_id: more.lastId === undefined ? (ids.at(-1) ?? null) : more.lastId,
  };
}

function deps(credential: DiscoveryCredential | null, replies: Reply[]): {
  deps: DiscoveryDeps;
  calls: ReturnType<typeof stubFetch>["calls"];
} {
  const { impl, calls } = stubFetch(replies);
  return {
    deps: { credential: async () => credential, fetch: impl, now: () => Date.UTC(2026, 9, 1) },
    calls,
  };
}

/** The blob `getSettings()` reads, straight off the row. */
function storedSettings(): Record<string, unknown> {
  const raw = dbMod.getSetting("settings");
  return raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
}

function ids(catalogue: readonly ModelCatalogueEntry[]): string[] {
  return catalogue.map((entry) => entry.id);
}

/** Close the handle so the next `db()` re-opens and migrates — a second boot. */
function reboot(): void {
  const held = globalThis as unknown as { __ufDb?: { close(): void } };
  held.__ufDb?.close();
  delete held.__ufDb;
  dbMod.db();
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-model-discovery-"));
  process.env.DATA_DIR = root;
  dbMod = await import("./db");
  discovery = await import("./modelDiscovery");
  settings = await import("./settings");
  catalogueMod = await import("./modelCatalogue");
  dbMod.db();
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("listing /v1/models", () => {
  it("walks every page, continuing from each page's last_id", async () => {
    const { impl, calls } = stubFetch([
      { body: page(["claude-opus-6", "claude-sonnet-6"], { hasMore: true }) },
      { body: page(["claude-haiku-6"]) },
    ]);
    const models = await discovery.listModels(API_KEY, impl);

    assert.deepEqual(
      models.map((m) => m.id),
      ["claude-opus-6", "claude-sonnet-6", "claude-haiku-6"],
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url.pathname, "/v1/models");
    assert.equal(calls[0].url.searchParams.get("limit"), "1000");
    assert.equal(calls[0].url.searchParams.get("after_id"), null);
    assert.equal(calls[1].url.searchParams.get("after_id"), "claude-sonnet-6");
    assert.equal(models[0].displayName, "Display claude-opus-6");
  });

  it("sends the API key as x-api-key, and the sign-in as a bearer token with the OAuth beta", async () => {
    const key = stubFetch([{ body: page([]) }]);
    await discovery.listModels(API_KEY, key.impl);
    assert.equal(key.calls[0].headers["x-api-key"], API_KEY.secret);
    assert.equal(key.calls[0].headers["anthropic-version"], "2023-06-01");
    assert.equal(key.calls[0].headers.authorization, undefined);

    const oauth = stubFetch([{ body: page([]) }]);
    await discovery.listModels(SIGN_IN, oauth.impl);
    assert.equal(oauth.calls[0].headers.authorization, `Bearer ${SIGN_IN.secret}`);
    assert.equal(oauth.calls[0].headers["anthropic-beta"], "oauth-2025-04-20");
    assert.equal(oauth.calls[0].headers["x-api-key"], undefined);
  });

  it("says which status, endpoint and credential refused it, and never the credential itself", async () => {
    const { impl } = stubFetch([
      {
        status: 401,
        body: {
          type: "error",
          error: { type: "authentication_error", message: `invalid token ${SIGN_IN.secret}` },
        },
      },
    ]);
    await assert.rejects(discovery.listModels(SIGN_IN, impl), (err: Error) => {
      assert.equal(
        err.message,
        "401 from /v1/models with the Claude Code sign-in: invalid token [credential]",
      );
      return true;
    });
  });

  it("refuses a body it cannot read rather than acting on any of it", async () => {
    const malformed: unknown[] = [
      "<html>gateway</html>",
      { models: [] },
      { data: [{ display_name: "No id" }], has_more: false },
      { data: [], has_more: true, last_id: null },
      { data: [] },
    ];
    for (const body of malformed) {
      const { impl } = stubFetch([{ body }]);
      await assert.rejects(
        discovery.listModels(API_KEY, impl),
        /shape this build cannot read/,
        JSON.stringify(body),
      );
    }

    // A good first page does not survive a bad second one.
    const { impl } = stubFetch([
      { body: page(["claude-opus-6"], { hasMore: true }) },
      { body: { data: "nope" } },
    ]);
    await assert.rejects(discovery.listModels(API_KEY, impl), /no data list/);
  });

  it("stops a listing that never ends, and says the provider could not be reached", async () => {
    const loop = stubFetch([{ body: page(["claude-opus-6"], { hasMore: true }) }]);
    await assert.rejects(discovery.listModels(API_KEY, loop.impl), /same page/);

    const down = stubFetch([new TypeError("fetch failed")]);
    await assert.rejects(
      discovery.listModels(API_KEY, down.impl),
      /^ModelDiscoveryError: \/v1\/models could not be reached \(fetch failed\) with the API key$/,
    );
  });
});

describe("a check, through the real store", () => {
  it("with no credential, changes nothing and says so", async () => {
    const { deps: d, calls } = deps(null, [{ body: page(["claude-opus-6"]) }]);
    const status = await discovery.checkForNewModels(d);

    assert.equal(calls.length, 0);
    assert.match(status.error ?? "", /^No credential/);
    assert.equal(status.errorCredential, null);
    assert.equal(status.lastSuccessAt, null);
    assert.deepEqual(
      settings.getSettings().modelCatalogue,
      catalogueMod.SEEDED_MODEL_CATALOGUE,
    );
  });

  it("on a refusal, changes nothing and names the refusal", async () => {
    const { deps: d } = deps(API_KEY, [{ status: 401, body: { error: { message: "nope" } } }]);
    const status = await discovery.checkForNewModels(d);

    assert.equal(status.error, "401 from /v1/models with the API key: nope");
    assert.equal(status.errorCredential, "api_key");
    assert.deepEqual(
      settings.getSettings().modelCatalogue,
      catalogueMod.SEEDED_MODEL_CATALOGUE,
    );
    assert.equal(storedSettings().modelCatalogue, undefined);
  });

  it("asks once for callers that arrive together", async () => {
    const { deps: d, calls } = deps(API_KEY, [{ body: page([]) }]);
    await Promise.all([discovery.checkForNewModels(d), discovery.checkForNewModels(d)]);
    assert.equal(calls.length, 1);
  });

  it("adds to an install that never edited its list without pinning it", async () => {
    // The install that keeps following the seed. If the additions were written
    // into the stored blob it would stop, and the page would call its list
    // edited when nobody touched it.
    const { deps: d } = deps(API_KEY, [
      { body: page(["claude-opus-6", "claude-sonnet-6", "claude-opus-5"]) },
    ]);
    const status = await discovery.checkForNewModels(d);

    assert.equal(status.error, null);
    assert.equal(status.credential, "api_key");
    assert.equal(status.listed, 3);
    assert.deepEqual(status.added, ["claude-opus-6", "claude-sonnet-6"]);

    const catalogue = settings.getSettings().modelCatalogue;
    assert.deepEqual(ids(catalogue).slice(-2), ["claude-opus-6", "claude-sonnet-6"]);
    assert.deepEqual(catalogue.at(-1), {
      id: "claude-sonnet-6",
      label: "Display claude-sonnet-6",
      enabled: true,
    });
    assert.equal(storedSettings().modelCatalogue, undefined);

    // And saving anything else does not pin it either, which is the
    // comparison against the moved default rather than the build's.
    settings.saveSettings({ maxConcurrentRuns: 3 });
    assert.equal(storedSettings().modelCatalogue, undefined);
    assert.equal(storedSettings().maxConcurrentRuns, 3);
  });

  it("is not undone at boot by a template naming one discovered model", () => {
    // Boot adoption runs while the list is unstored. Onto the bare seed it
    // would pin seed-plus-this-one and drop every other discovered model, and
    // since none is ever offered twice, drop them for good.
    dbMod
      .db()
      .prepare(
        `INSERT INTO run_templates (id, name, prompt, permission_mode, isolate,
           budget, model, created_at, updated_at)
         VALUES ('t-discovered', 'probe', 'p', 'plan', 0, '{}', 'claude-opus-6', 0, 0)`,
      )
      .run();
    reboot();

    assert.equal(storedSettings().modelCatalogue, undefined);
    assert.deepEqual(
      ids(settings.getSettings().modelCatalogue).slice(-2),
      ["claude-opus-6", "claude-sonnet-6"],
    );
  });

  it("writes into a list the operator stored, keeping every switch and label", async () => {
    const own = settings.getSettings().modelCatalogue.map((entry) =>
      entry.id === "claude-opus-5" ? { ...entry, enabled: false, label: "Old Opus" } : entry,
    );
    settings.saveSettings({ modelCatalogue: own });
    assert.ok(storedSettings().modelCatalogue, "the fixture did not pin the list");

    const { deps: d } = deps(SIGN_IN, [{ body: page(["claude-opus-7", "claude-opus-6"]) }]);
    const status = await discovery.checkForNewModels(d);

    assert.equal(status.credential, "claude_code");
    assert.deepEqual(status.added, ["claude-opus-7"]);
    const stored = storedSettings().modelCatalogue as ModelCatalogueEntry[];
    assert.deepEqual(stored, [
      ...own,
      { id: "claude-opus-7", label: "Display claude-opus-7", enabled: true },
    ]);
  });

  it("does not bring back a discovered model the operator removed", async () => {
    const without = settings
      .getSettings()
      .modelCatalogue.filter((entry) => entry.id !== "claude-opus-7");
    settings.saveSettings({ modelCatalogue: without });

    const { deps: d } = deps(API_KEY, [{ body: page(["claude-opus-7"]) }]);
    const status = await discovery.checkForNewModels(d);

    assert.deepEqual(status.added, []);
    assert.equal(ids(settings.getSettings().modelCatalogue).includes("claude-opus-7"), false);
  });

  it("leaves an empty list empty", async () => {
    settings.saveSettings({ modelCatalogue: [] });

    const { deps: d } = deps(API_KEY, [{ body: page(["claude-opus-8"]) }]);
    const status = await discovery.checkForNewModels(d);

    assert.equal(status.error, null);
    assert.deepEqual(status.added, []);
    assert.deepEqual(settings.getSettings().modelCatalogue, []);
    assert.deepEqual(storedSettings().modelCatalogue, []);
  });
});
