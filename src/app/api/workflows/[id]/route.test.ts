import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type Database from "better-sqlite3";
import type { WorkflowInstanceDTO } from "../../../../lib/apiTypes";

/**
 * What `GET /api/workflows/[id]` answers when the caller asks for a *page* of
 * the history rather than for whatever the route felt like sending.
 *
 * This route returned `listInstances(id)`'s newest twenty and read no
 * `searchParams` at all, which made a workflow's own history the last twenty
 * presses of Run permanently — on the one surface that answers what a graph has
 * done. Nothing about that fails: the table renders, the newest run is on it,
 * and the twenty-first press is unreachable however the page above is written.
 * So what is pinned here is the wire rather than a pure half — a `findInstances`
 * that pages perfectly under a route that keeps calling it with no arguments is
 * exactly the defect this closes, and it typechecks.
 *
 * The second workflow is not scenery. `total` is a `COUNT(*)` beside the page's
 * own `WHERE`, and a count that lost that clause reports every instance in the
 * install as this graph's — a plausible number, on a pager whose last page is
 * then empty.
 *
 * `DATA_DIR` before the first import, and the assertion under it, for
 * `agents/route.test.ts`' reason: `config.ts` reads that variable once at module
 * load, so a file that imported anything at the top would bind itself to the
 * repository's own `.data` — which on a developer's machine is the real one.
 */

let route: typeof import("./route");
let dbMod: typeof import("../../../../lib/db");
let root: string;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-workflow-route-"));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, "workspace");
  process.env.WORKSPACE_ROOTS = "";
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  const config = await import("../../../../lib/config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );

  route = await import("./route");
  dbMod = await import("../../../../lib/db");
});

after(() => {
  const open = (globalThis as { __ufDb?: Database.Database }).__ufDb;
  open?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A graph with `count` presses of Run behind it, oldest first. */
function workflow(id: string, count: number): void {
  const now = Date.now();
  dbMod
    .db()
    .prepare(
      "INSERT INTO workflows (id, name, graph, created_at, updated_at)" +
        " VALUES (?, ?, '{\"nodes\":[],\"edges\":[]}', ?, ?)",
    )
    .run(id, id, now, now);

  for (let i = 0; i < count; i++) {
    dbMod
      .db()
      .prepare(
        `INSERT INTO workflow_instances
           (id, workflow_id, workflow_name, graph, created_at, status)
         VALUES (?, ?, ?, '{"nodes":[],"edges":[]}', ?, 'started')`,
      )
      // One millisecond apart, so "newest first" is a fact about the rows rather
      // than about the order they were inserted in.
      .run(`${id}-press-${i}`, id, id, now + i);
  }
}

type Page = {
  instances?: WorkflowInstanceDTO[];
  total?: number;
  offset?: number;
  limit?: number;
  error?: string;
};

async function get(id: string, query = ""): Promise<Page> {
  const res = await route.GET(
    new Request(`http://localhost/api/workflows/${id}${query}`),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(res.status, 200);
  return (await res.json()) as Page;
}

/** The ids of the page, as the operator reads them: newest first. */
function ids(page: Page): string[] {
  return (page.instances ?? []).map((i) => i.id);
}

describe("GET /api/workflows/[id] — the history is a page, not a ceiling", () => {
  before(() => {
    workflow("wf-paged", 45);
    // The neighbour `total` must not count, and whose instances must not appear.
    workflow("wf-other", 7);
  });

  it("answers the newest page and says what it is a slice of", async () => {
    const page = await get("wf-paged");
    assert.equal(page.total, 45, "the count is over every press, not over the page");
    assert.equal(page.offset, 0);
    assert.equal(page.limit, 20);
    assert.equal(ids(page).length, 20);
    assert.equal(ids(page)[0], "wf-paged-press-44");
    assert.equal(ids(page)[19], "wf-paged-press-25");
  });

  it("reaches past the newest page, without repeating or skipping a press", async () => {
    const first = await get("wf-paged");
    const second = await get("wf-paged", "?offset=20");
    const last = await get("wf-paged", "?offset=40");

    assert.equal(second.offset, 20);
    assert.equal(ids(second)[0], "wf-paged-press-24");
    assert.equal(ids(last).length, 5, "the last page is short, not empty");
    assert.equal(ids(last)[4], "wf-paged-press-0", "the oldest press is reachable");

    const seen = [...ids(first), ...ids(second), ...ids(last)];
    assert.equal(new Set(seen).size, 45, "every press appears exactly once");
  });

  it("takes a narrower page, and caps a wider one", async () => {
    const narrow = await get("wf-paged", "?limit=5&offset=10");
    assert.equal(narrow.limit, 5);
    assert.equal(ids(narrow).length, 5);
    assert.equal(ids(narrow)[0], "wf-paged-press-34");

    // The effective window, not the one asked for: it is what the page's own
    // Previous and Next step by.
    assert.equal((await get("wf-paged", "?limit=5000")).limit, 100);
  });

  it("reads an unusable limit as the ordinary page rather than the smallest one", async () => {
    // `normalizeRunListQuery`'s rule, one route over: these arrive off a query
    // string, and a one-row page is a far worse answer to a typo.
    for (const query of ["?limit=0", "?limit=-4", "?limit=twenty"]) {
      const page = await get("wf-paged", query);
      assert.equal(page.limit, 20, `${query} should answer with the default page`);
      assert.equal(ids(page).length, 20);
    }
  });

  it("clamps an offset past the end to the last page rather than an empty one", async () => {
    // What pressing Next on a list that shrank under you produces. An empty
    // page here reads as "this workflow has not been run".
    const page = await get("wf-paged", "?offset=900");
    assert.equal(page.offset, 44);
    assert.deepEqual(ids(page), ["wf-paged-press-0"]);
  });

  it("counts and lists only this workflow's presses", async () => {
    const other = await get("wf-other");
    assert.equal(other.total, 7);
    assert.ok(
      ids(other).every((id) => id.startsWith("wf-other-")),
      "a page carrying another graph's presses",
    );
  });
});
