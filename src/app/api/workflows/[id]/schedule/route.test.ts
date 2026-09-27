import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type Database from "better-sqlite3";

/**
 * What `PATCH /api/workflows/[id]/schedule` does with a `paused` that is not a
 * boolean: nothing, with a 400.
 *
 * It read `body.paused === true` off a body whose parse failure became `{}`,
 * under a comment saying a string off the wire "must fail towards not starting
 * them". Pause and resume are one switch, though, and `false` there is
 * **resume**, the direction that starts unattended agents. So `"true"`, `1`,
 * `{}`, a missing field and a body that is not JSON each resumed a paused
 * schedule and answered 200. The card always sends a boolean, so only a script
 * or another client reaches this, and it gets a success for a press it never
 * made.
 *
 * `DATA_DIR` before the first import, and the assertion under it, for
 * `../route.test.ts`' reason: `config.ts` reads that variable once at module
 * load, so a file that imported anything at the top would bind itself to the
 * repository's own `.data`, which on a developer's machine is the real one.
 */

let route: typeof import("./route");
let schedules: typeof import("../../../../../lib/schedules");
let workflows: typeof import("../../../../../lib/workflows");
let root: string;
let workflowId: string;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-schedule-route-"));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, "workspace");
  process.env.WORKSPACE_ROOTS = "";
  // A resume starts the timer and nothing else, but a regression that got as
  // far as a spawn should be a failed test rather than a billed one.
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  const config = await import("../../../../../lib/config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );

  route = await import("./route");
  schedules = await import("../../../../../lib/schedules");
  workflows = await import("../../../../../lib/workflows");

  // Budgeted, so `scheduleRefusal` passes and a resume is a thing this route
  // would actually do: an unbudgeted workflow refuses every resume with a 400
  // already, and a case against one would pass whatever `paused` said.
  workflowId = workflows.createWorkflow({
    name: "Nightly",
    graph: { nodes: [], edges: [] },
    instanceBudget: {
      maxInstanceCostUSD: 5,
      maxSessionFraction: null,
      maxWeeklyFraction: null,
    },
  }).id;
  schedules.putSchedule(workflowId, { kind: "daily", minutes: 540 }, "UTC");
});

after(() => {
  const open = (globalThis as { __ufDb?: Database.Database }).__ufDb;
  open?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  schedules.pauseSchedule(workflowId, true);
});

async function patch(body: string): Promise<{ status: number; error?: string }> {
  const res = await route.PATCH(
    new Request(`http://localhost/api/workflows/${workflowId}/schedule`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body,
    }),
    { params: Promise.resolve({ id: workflowId }) },
  );
  const json = (await res.json()) as { error?: string };
  return { status: res.status, error: json.error };
}

function isPaused(): boolean | undefined {
  return schedules.getSchedule(workflowId)?.paused;
}

describe("PATCH /api/workflows/[id]/schedule", () => {
  for (const [label, body] of [
    ['the string "true"', JSON.stringify({ paused: "true" })],
    ["the number 1", JSON.stringify({ paused: 1 })],
    ["null", JSON.stringify({ paused: null })],
    ["an object", JSON.stringify({ paused: {} })],
    ["a body with no paused field", JSON.stringify({})],
    ["a body that is not JSON", "paused=true"],
    ["a body that is JSON null", "null"],
  ] as const) {
    it(`refuses ${label} and leaves the schedule paused`, async () => {
      const answer = await patch(body);

      assert.equal(answer.status, 400);
      assert.ok(answer.error, "a refusal has to say what to send instead");
      assert.equal(isPaused(), true, "a malformed press resumed an unattended schedule");
    });
  }

  it("still pauses on true and resumes on false", async () => {
    // The control: without it the cases above pass against a route that
    // refuses everything.
    assert.equal((await patch(JSON.stringify({ paused: false }))).status, 200);
    assert.equal(isPaused(), false);
    assert.equal((await patch(JSON.stringify({ paused: true }))).status, 200);
    assert.equal(isPaused(), true);
  });
});
