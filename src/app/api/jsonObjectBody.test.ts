import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

/**
 * A body that parses to something other than a JSON object, at every route that
 * used to read one as `(await req.json().catch(() => ({}))) as Record<…>`.
 *
 * The `.catch` covered a body that does not parse and not one that parses to
 * `null`: the next property read threw, and the route answered — and audited —
 * a 500 for what was the caller's mistake. `readJsonObject` in `http.ts` is the
 * one place that is now decided; this pins that each door actually goes through
 * it, because a route that kept its own copy of the old line looks identical to
 * one that did not until somebody sends it `null`.
 *
 * `DATA_DIR` and the Claude paths are read at module load, so they are set
 * before anything is imported, and nothing here reaches a spawn: the fleet is
 * paused, so even a run that a regression lets through is never promoted.
 *
 * The run doors get a second half, because `readJsonObject` checks the top level
 * only. A `budget` that is not an object reached `normalizePolicy`, whose `in`
 * test threw — the same 500 one level down — and a `prompt` that is not a string
 * went through `String()` and started a billed run whose task was
 * "[object Object]". Those cases need a body that passes every other check, so
 * they post against a real mount and folder.
 *
 * Not every such door is here. `POST /api/tasks`, `POST /api/tasks/[id]/comments`,
 * `POST /api/agents`, `PUT /api/agents/[id]`, `POST /api/templates`,
 * `PUT /api/templates/[id]`, `POST /api/workflows`, `PUT /api/workflows/[id]` and
 * `PUT /api/workflows/[id]/schedule` kept the old line because the normaliser
 * behind each reads `raw ?? {}` and refuses what it finds with a 400. `/api/login`
 * and `/api/logout` are answerable without a credential and answer `null` their
 * own way, which `login/route.test.ts` pins.
 */

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-json-body-")));
fs.mkdirSync(path.join(root, "ws", "project"), { recursive: true });

process.env.WORKSPACE_ROOTS = `Main=${path.join(root, "ws")}`;
process.env.DATA_DIR = path.join(root, "data");
process.env.CLAUDE_HOME = path.join(root, "claude");
process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
process.env.CLAUDE_BIN = path.join(root, "no-such-claude");
process.env.CODEX_BIN = path.join(root, "no-such-codex");
process.env.CODEX_HOME = path.join(root, "codex");

after(() => fs.rmSync(root, { recursive: true, force: true }));

type Ctx = { params: Promise<{ id: string }> };
type Handler = (req: Request, ctx: Ctx) => Promise<Response>;

let chatId: string;
let taskId: string;
let runId: string;

before(async () => {
  const config = await import("../../lib/config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );
  const chat = await import("../../lib/chat");
  const tasks = await import("../../lib/tasks");
  (await import("../../lib/fleet")).setFleetPaused(true);

  // Real rows, so a refusal below cannot be a 404 that happened to arrive first.
  chatId = chat.createChat().id;
  const parsed = tasks.normalizeTaskInput(
    { title: "A task", body: "the brief" },
    { origin: "operator", createdByRunId: null },
  );
  if (!parsed.ok) throw new Error(`fixture refused at the door: ${parsed.error}`);
  const created = tasks.createTask(parsed.value);
  if (!created.ok) throw new Error(`fixture refused by the store: ${created.error}`);
  taskId = created.task.id;

  const { db } = await import("../../lib/db");
  runId = "run-json-body";
  db()
    .prepare(
      "INSERT INTO runs (id, folder, prompt, status, budget, created_at)" +
        " VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(runId, path.join(root, "ws"), "task", "stopped", "{}", Date.now());
});

async function send(
  handler: Handler,
  method: string,
  url: string,
  id: string,
  body: string,
): Promise<{ status: number; error: unknown }> {
  const res = await handler(
    new Request(`http://localhost${url}`, {
      method,
      headers: { "content-type": "application/json" },
      body,
    }),
    { params: Promise.resolve({ id }) },
  );
  const json = (await res.json()) as { error?: unknown };
  return { status: res.status, error: json.error };
}

const DOORS: {
  name: string;
  method: string;
  load: () => Promise<Handler>;
  url: () => string;
  id: () => string;
}[] = [
  {
    name: "POST /api/chat/[id]/message",
    method: "POST",
    load: async () => (await import("./chat/[id]/message/route")).POST,
    url: () => `/api/chat/${chatId}/message`,
    id: () => chatId,
  },
  {
    name: "POST /api/chat/[id]/proposals",
    method: "POST",
    load: async () => (await import("./chat/[id]/proposals/route")).POST,
    url: () => `/api/chat/${chatId}/proposals`,
    id: () => chatId,
  },
  {
    name: "POST /api/chat/[id]/questions",
    method: "POST",
    load: async () => (await import("./chat/[id]/questions/route")).POST,
    url: () => `/api/chat/${chatId}/questions`,
    id: () => chatId,
  },
  {
    name: "POST /api/tasks/[id]/deps",
    method: "POST",
    load: async () => (await import("./tasks/[id]/deps/route")).POST,
    url: () => `/api/tasks/${taskId}/deps`,
    id: () => taskId,
  },
  {
    name: "PATCH /api/tasks/[id]",
    method: "PATCH",
    load: async () => (await import("./tasks/[id]/route")).PATCH,
    url: () => `/api/tasks/${taskId}`,
    id: () => taskId,
  },
  {
    name: "DELETE /api/tasks/[id]/deps",
    method: "DELETE",
    load: async () => (await import("./tasks/[id]/deps/route")).DELETE,
    url: () => `/api/tasks/${taskId}/deps`,
    id: () => taskId,
  },
  {
    name: "POST /api/runs",
    method: "POST",
    load: async () => (await import("./runs/route")).POST,
    url: () => "/api/runs",
    id: () => "",
  },
  {
    name: "POST /api/runs/[id]/land",
    method: "POST",
    load: async () => (await import("./runs/[id]/land/route")).POST,
    url: () => `/api/runs/${runId}/land`,
    id: () => runId,
  },
  {
    name: "POST /api/runs/[id]/reopen",
    method: "POST",
    load: async () => (await import("./runs/[id]/reopen/route")).POST,
    url: () => `/api/runs/${runId}/reopen`,
    id: () => runId,
  },
  {
    name: "POST /api/branches/queue",
    method: "POST",
    load: async () => (await import("./branches/queue/route")).POST,
    url: () => "/api/branches/queue",
    id: () => "",
  },
  {
    name: "DELETE /api/branches/queue",
    method: "DELETE",
    load: async () => (await import("./branches/queue/route")).DELETE,
    url: () => "/api/branches/queue",
    id: () => "",
  },
  {
    name: "POST /api/fleet",
    method: "POST",
    load: async () => (await import("./fleet/route")).POST,
    url: () => "/api/fleet",
    id: () => "",
  },
  {
    name: "PUT /api/settings",
    method: "PUT",
    load: async () => (await import("./settings/route")).PUT,
    url: () => "/api/settings",
    id: () => "",
  },
  {
    name: "POST /api/plugins",
    method: "POST",
    load: async () => (await import("./plugins/route")).POST,
    url: () => "/api/plugins",
    id: () => "",
  },
  {
    name: "POST /api/knowledge/skill",
    method: "POST",
    load: async () => (await import("./knowledge/skill/route")).POST,
    url: () => "/api/knowledge/skill",
    id: () => "",
  },
  {
    name: "POST /api/workflows/validate",
    method: "POST",
    load: async () => (await import("./workflows/validate/route")).POST,
    url: () => "/api/workflows/validate",
    id: () => "",
  },
  {
    name: "POST /api/claude-auth/login/code",
    method: "POST",
    load: async () => (await import("./claude-auth/login/code/route")).POST,
    url: () => "/api/claude-auth/login/code",
    id: () => "",
  },
  {
    name: "POST /api/codex-auth/api-key",
    method: "POST",
    load: async () => (await import("./codex-auth/api-key/route")).POST,
    url: () => "/api/codex-auth/api-key",
    id: () => "",
  },
  {
    name: "POST /api/local-provider",
    method: "POST",
    load: async () => (await import("./local-provider/route")).POST,
    url: () => "/api/local-provider",
    id: () => "",
  },
];

for (const door of DOORS) {
  test(`${door.name} refuses a null body with a 400 and a sentence`, async () => {
    const handler = await door.load();
    const reply = await send(handler, door.method, door.url(), door.id(), "null");

    assert.equal(reply.status, 400);
    assert.match(String(reply.error), /has to be a JSON object; got null/);
  });
}

// `{}` is "change nothing" on this route and answers 200, so a garbled body read
// as one told the operator an edit had landed.
test("PATCH /api/tasks/[id] refuses a body that does not parse rather than reading it as {}", async () => {
  const { PATCH } = await import("./tasks/[id]/route");
  const reply = await send(PATCH, "PATCH", `/api/tasks/${taskId}`, taskId, "{not json");

  assert.equal(reply.status, 400);
  assert.match(String(reply.error), /has to be a JSON object; this one did not parse/);
});

/** A start request every check in `POST /api/runs` passes. */
const START = {
  mountId: "main",
  folder: "project",
  prompt: "do it",
  budget: { maxIterations: 1 },
};

async function runCount(): Promise<number> {
  const { db } = await import("../../lib/db");
  return (db().prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n;
}

async function runStatus(id: string): Promise<string> {
  const { db } = await import("../../lib/db");
  return (db().prepare("SELECT status FROM runs WHERE id = ?").get(id) as { status: string })
    .status;
}

test("POST /api/runs admits the start request the cases below each break one field of", async () => {
  const { POST } = await import("./runs/route");
  const reply = await send(POST, "POST", "/api/runs", "", JSON.stringify(START));

  assert.equal(reply.status, 200, String(reply.error));
});

const WRONG_FIELDS: { field: string; got: string; body: Record<string, unknown> }[] = [
  { field: "budget", got: "a string", body: { ...START, budget: "lots" } },
  { field: "budget", got: "a number", body: { ...START, budget: 5 } },
  { field: "budget", got: "an array", body: { ...START, budget: [] } },
  { field: "prompt", got: "an object", body: { ...START, prompt: { task: "fix the bug" } } },
  { field: "prompt", got: "an array", body: { ...START, prompt: ["fix", "the bug"] } },
  { field: "folder", got: "an object", body: { ...START, folder: { path: "project" } } },
  { field: "mountId", got: "a number", body: { ...START, mountId: 5 } },
  // Codex, because its model ids are not checked against a list: `String()`
  // made this `-m [object Object]` on a run that was admitted.
  {
    field: "model",
    got: "an object",
    body: { ...START, provider: "codex", model: { id: "gpt-5" } },
  },
];

for (const { field, got, body } of WRONG_FIELDS) {
  test(`POST /api/runs refuses a ${field} that is ${got}, and writes no run`, async () => {
    const { POST } = await import("./runs/route");
    const before = await runCount();
    const reply = await send(POST, "POST", "/api/runs", "", JSON.stringify(body));

    assert.equal(reply.status, 400, String(reply.error));
    assert.match(String(reply.error), new RegExp(`"${field}" has to be .*; got ${got}`));
    assert.equal(await runCount(), before, "a refused start wrote a run row anyway");
  });
}

test("POST /api/runs/[id]/reopen refuses a budget that is not an object", async () => {
  const { POST } = await import("./runs/[id]/reopen/route");
  const reply = await send(
    POST,
    "POST",
    `/api/runs/${runId}/reopen`,
    runId,
    JSON.stringify({ budget: 5 }),
  );

  assert.equal(reply.status, 400, String(reply.error));
  assert.match(String(reply.error), /"budget" has to be an object when it is given; got a number/);
  assert.equal(await runStatus(runId), "stopped");
});

// The follow-up is what the reopened run is told next, so it is a prompt.
test("POST /api/runs/[id]/reopen refuses a follow-up that is not a string", async () => {
  const { POST } = await import("./runs/[id]/reopen/route");
  const reply = await send(
    POST,
    "POST",
    `/api/runs/${runId}/reopen`,
    runId,
    JSON.stringify({ budget: { maxIterations: 1 }, followUp: { note: "keep going" } }),
  );

  assert.equal(reply.status, 400, String(reply.error));
  assert.match(String(reply.error), /"followUp" has to be a string when it is given; got an object/);
  assert.equal(await runStatus(runId), "stopped");
});
