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
 * before anything is imported, and nothing here reaches a spawn: every request
 * below is refused before the handler looks at anything but its body.
 */

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-json-body-")));
fs.mkdirSync(path.join(root, "ws"), { recursive: true });

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
