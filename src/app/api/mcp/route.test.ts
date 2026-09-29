import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Task } from "../../../lib/tasks";

/**
 * What a work cycle may read of the board through `/api/mcp`, from the wire.
 *
 * `get_my_task` is the one tool on the run surface that returns a brief whole,
 * and every way its scope can be wrong is silent: a run handed another
 * project's brief, or the brief another run is working from, reads it as the
 * truth about its own work and nothing throws, fails to typecheck or looks
 * wrong on a page. So the scope is pinned through the route rather than beside
 * `taskVisibleToRun`, because the run id it is keyed on is the capability
 * token's — a test of the predicate alone could not see a handler that took
 * the id off the call instead.
 *
 * The refusals are asserted to be **one sentence** across another folder's
 * task, another run's, a closed one and an id on no row, because the failure
 * that equality closes is a run probing the rest of the board for which ids
 * exist. And the tool lists are pinned for all three subjects, since the gate
 * in `callTool` is a membership test against the same `toolsFor` — a tool added
 * to the wrong list is reachable, not merely visible.
 *
 * `list_tasks`' folder filter is pinned here too, from a chat token: the schema
 * asks for a folder within the mount and the board stores the resolved absolute
 * path, and the two compared as sent answered zero for every project — the
 * reading that says a backlog is clear — with nothing thrown anywhere.
 *
 * `DATA_DIR`, `WORKSPACE_ROOTS` and the Claude paths are read at module load,
 * so they are set before anything is imported; the assertion in `before` is
 * what makes a change to that fail loudly rather than write into the
 * operator's own database.
 */

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-mcp-route-")));
const ws = path.join(root, "ws");
const HERE = path.join(ws, "RepoOne");
const ELSEWHERE = path.join(ws, "RepoTwo");
fs.mkdirSync(HERE, { recursive: true });
fs.mkdirSync(ELSEWHERE, { recursive: true });

process.env.WORKSPACE_ROOTS = `Main=${ws}`;
process.env.DATA_DIR = path.join(root, "data");
process.env.CLAUDE_HOME = path.join(root, "claude");
process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
// Nothing here spawns, and this is the second lock on that door.
process.env.CLAUDE_BIN = path.join(root, "no-such-claude");
process.env.CODEX_BIN = path.join(root, "no-such-codex");
process.env.CODEX_HOME = path.join(root, "codex");

/** The id is `slug(label)` and never the label — `parseMounts` in `config.ts`. */
const MOUNT = "main";

let route: typeof import("./route");
let tasks: typeof import("../../../lib/tasks");
let chat: typeof import("../../../lib/chat");
let comments: typeof import("../../../lib/taskComments");
let taskDeps: typeof import("../../../lib/taskDeps");
let db: typeof import("../../../lib/db").db;

before(async () => {
  const config = await import("../../../lib/config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );
  tasks = await import("../../../lib/tasks");
  chat = await import("../../../lib/chat");
  comments = await import("../../../lib/taskComments");
  taskDeps = await import("../../../lib/taskDeps");
  db = (await import("../../../lib/db")).db;
  route = await import("./route");
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

/**
 * A `runs` row with nothing on it but the columns the insert refuses to be
 * without, `tasks.test.ts`' reason: the route reads the run's folder and
 * nothing else, and reaching `createRun` would claim a folder and a slot to
 * answer a question about one column.
 */
function seedRun(folder: string): { runId: string; token: string } {
  const runId = randomUUID();
  db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, created_at, budget)
       VALUES (?, ?, 'seeded', 'running', ?, '{}')`,
    )
    .run(runId, folder, Date.now());
  return { runId, token: chat.mintRunCapability(runId) };
}

function file(folder: string, over: Record<string, unknown> = {}): Task {
  const parsed = tasks.normalizeTaskInput(
    { title: `Task ${randomUUID()}`, body: "the brief", mountId: MOUNT, folder, ...over },
    { origin: "operator", createdByRunId: null },
  );
  if (!parsed.ok) throw new Error(`fixture refused at the door: ${parsed.error}`);
  const created = tasks.createTask(parsed.value);
  if (!created.ok) throw new Error(`fixture refused by the store: ${created.error}`);
  return created.task;
}

function move(task: Task, status: "claimed" | "done", runId: string): void {
  const moved = tasks.updateTask(task.id, { status }, { kind: "run", runId });
  if (!moved.ok) throw new Error(`fixture move refused: ${moved.error}`);
}

async function rpc(token: string, method: string, params?: unknown) {
  const res = await route.POST(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  assert.equal(res.status, 200);
  return ((await res.json()) as { result: unknown }).result;
}

async function toolNames(token: string): Promise<string[]> {
  const result = (await rpc(token, "tools/list")) as { tools: { name: string }[] };
  return result.tools.map((t) => t.name);
}

async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const result = (await rpc(token, "tools/call", { name, arguments: args })) as {
    content: { text: string }[];
    isError: boolean;
  };
  return { text: result.content[0].text, isError: result.isError };
}

test("a work cycle is handed get_my_task, and neither orchestrator subject is", async () => {
  const { token } = seedRun(HERE);
  assert.deepEqual(await toolNames(token), [
    "list_my_tasks",
    "complete_task",
    "release_task",
    "create_task",
    "comment_on_task",
    "add_task_dependency",
    "get_my_task",
  ]);

  const chatToken = chat.mintCapability({ kind: "chat", chatId: randomUUID() });
  const blockToken = chat.mintCapability({
    kind: "block",
    instanceId: randomUUID(),
    nodeId: "decide",
  });
  for (const [who, orchestrator] of [
    ["chat", chatToken],
    ["block", blockToken],
  ] as const) {
    const names = await toolNames(orchestrator);
    assert.ok(names.includes("get_task"), `${who} still reads the board whole`);
    assert.ok(names.includes("list_tasks"), `${who} still lists the board`);
    assert.ok(!names.includes("get_my_task"), `${who} is not handed a run's view`);
    assert.ok(!names.includes("list_my_tasks"), `${who} is not handed a run's view`);

    // Refused at the gate rather than reaching the handler: the gate is the
    // same list, so what is not offered is not callable either.
    const asked = await callTool(orchestrator, "get_my_task", { taskId: randomUUID() });
    assert.equal(asked.isError, true);
    assert.match(asked.text, /is not available/);
  }
});

test("a run reads the whole brief of a task it holds", async () => {
  const { runId, token } = seedRun(HERE);
  const body = `${"The part of the brief past the preview. ".repeat(20)}The end.`;
  assert.ok(body.length > 200);
  const held = file(HERE, { body });
  move(held, "claimed", runId);
  const noted = comments.addTaskComment(
    held.id,
    { body: "A note from the operator." },
    { kind: "operator" },
  );
  assert.ok(noted.ok);

  // The list is still a clip — the rejected alternative was to stop clipping
  // it, and this is what says it did not happen.
  const listed = JSON.parse((await callTool(token, "list_my_tasks", {})).text);
  assert.equal(listed.held[0].taskId, held.id);
  assert.equal(listed.held[0].bodyClipped, true);

  const read = await callTool(token, "get_my_task", { taskId: held.id });
  assert.equal(read.isError, false);
  const task = JSON.parse(read.text);
  assert.equal(task.body, body, "the brief whole, not the preview");
  assert.equal(task.held, true);
  assert.equal(task.status, "claimed");
  assert.deepEqual(
    task.comments.map((c: { body: string }) => c.body),
    ["A note from the operator."],
  );
  assert.equal(task.commentsTotal, 1);
  assert.deepEqual(task.dependsOn, []);
  assert.match(task.dependencyNote, /advisory/);

  // A run that has completed its task can still read it, `held`'s rule.
  move(held, "done", runId);
  const after = JSON.parse((await callTool(token, "get_my_task", { taskId: held.id })).text);
  assert.equal(after.status, "done");
});

test("a run reads an open task filed in its own folder", async () => {
  const { token } = seedRun(HERE);
  const open = file(HERE, { body: "Written down where this run is working." });

  const read = await callTool(token, "get_my_task", { taskId: open.id });
  assert.equal(read.isError, false);
  const task = JSON.parse(read.text);
  assert.equal(task.taskId, open.id);
  assert.equal(task.body, "Written down where this run is working.");
  assert.equal(task.status, "open");
  assert.equal(task.held, false, "readable is not closeable");
});

test("a run is refused in one sentence for anything it may not read", async () => {
  const reader = seedRun(HERE);
  const other = seedRun(HERE);

  const elsewhere = file(ELSEWHERE, { title: "Another project's open task" });
  const claimedHere = file(HERE, { title: "Claimed by another run here" });
  move(claimedHere, "claimed", other.runId);
  const doneHere = file(HERE, { title: "Done by another run here" });
  move(doneHere, "claimed", other.runId);
  move(doneHere, "done", other.runId);
  const missing = randomUUID();

  const cases: [string, string][] = [
    ["an open task in another folder", elsewhere.id],
    ["a claimed task in its folder that it does not hold", claimedHere.id],
    ["a done task in its folder that it does not hold", doneHere.id],
    ["an id that is on no row", missing],
  ];
  const sentences = new Set<string>();
  for (const [what, taskId] of cases) {
    const refused = await callTool(reader.token, "get_my_task", { taskId });
    assert.equal(refused.isError, true, `${what} is refused`);
    assert.match(refused.text, /list_my_tasks/, "and says where the readable ids are");
    for (const task of [elsewhere, claimedHere, doneHere]) {
      assert.ok(!refused.text.includes(task.title), `${what} leaks no title`);
    }
    sentences.add(refused.text.replaceAll(taskId, "<id>"));
  }
  assert.equal(
    sentences.size,
    1,
    `"not yours" and "not there" must read the same, or the refusal is a probe: ${[...sentences].join(" | ")}`,
  );

  // The run id is the token's: naming the holder in the call reads nothing.
  const smuggled = await callTool(reader.token, "get_my_task", {
    taskId: claimedHere.id,
    runId: other.runId,
  });
  assert.equal(smuggled.isError, true);
});

test("a run with no folder reads what it holds and nothing else", async () => {
  // A run deleted mid-cycle is how `runFolder` comes to answer null for a
  // token that is still live — the case its own docblock names.
  const { runId, token } = seedRun(HERE);
  const held = file(HERE);
  move(held, "claimed", runId);
  const openHere = file(HERE);
  db().prepare("DELETE FROM runs WHERE id = ?").run(runId);

  const read = await callTool(token, "get_my_task", { taskId: held.id });
  assert.equal(read.isError, false, "what a run holds does not depend on a folder");
  assert.equal(JSON.parse(read.text).taskId, held.id);

  // "No folder" read as "no filter" is the widening this pins.
  const refused = await callTool(token, "get_my_task", { taskId: openHere.id });
  assert.equal(refused.isError, true);
  const missing = await callTool(token, "get_my_task", { taskId: "no-such-task" });
  assert.equal(
    refused.text.replaceAll(openHere.id, "<id>"),
    missing.text.replaceAll("no-such-task", "<id>"),
  );
});

test("a work cycle asking for get_task is pointed at get_my_task", async () => {
  const { runId, token } = seedRun(HERE);
  const held = file(HERE);
  move(held, "claimed", runId);

  const refused = await callTool(token, "get_task", { taskId: held.id });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /get_my_task/);
  assert.match(refused.text, /list_my_tasks/);
});

test("list_tasks narrows to a project by the folder within its mount", async () => {
  // `tasks.folder` holds the resolved absolute path and the schema asks for the
  // path within the mount; compared as sent, every project read back as an
  // empty backlog, which is the one answer that stops a loop and tells a chat
  // the work is done.
  const chatToken = chat.mintCapability({ kind: "chat", chatId: randomUUID() });
  const project = path.join(ws, "RepoThree");
  fs.mkdirSync(project);
  const waiting = file(project, { title: "Waits for the other" });
  const first = file(project, { title: "Goes first" });
  file(HERE, { title: "Another project's task" });
  assert.ok(taskDeps.addTaskDep(waiting.id, first.id).ok);

  const list = async (folder: string) =>
    JSON.parse((await callTool(chatToken, "list_tasks", { mountId: MOUNT, folder })).text);

  // `get_task`'s refs name a folder within the mount and `list_tasks`' rows name
  // the absolute one; a model sending either back reaches the same rows.
  const ref = JSON.parse((await callTool(chatToken, "get_task", { taskId: waiting.id })).text)
    .dependsOn[0];
  assert.equal(ref.folder, "RepoThree");
  const byRef = await list(ref.folder);
  const byRow = await list(byRef.tasks[0].folder);
  for (const [shape, listed] of [
    ["within the mount", byRef],
    ["absolute", byRow],
  ] as const) {
    assert.equal(listed.totalMatching, 2, `a ${shape} folder finds the project's tasks`);
    assert.deepEqual(
      listed.tasks.map((t: { taskId: string }) => t.taskId).sort(),
      [waiting.id, first.id].sort(),
    );
    assert.equal(listed.matchedFolder, project, "and says which path it compared");
    assert.equal(listed.matchedFolderNote, undefined);
  }
});

test("list_tasks still finds a folder that no longer resolves, and says so", async () => {
  const chatToken = chat.mintCapability({ kind: "chat", chatId: randomUUID() });
  const gone = path.join(ws, "RepoGone");
  fs.mkdirSync(gone);
  const filed = file(gone);
  fs.rmdirSync(gone);

  const listed = JSON.parse(
    (await callTool(chatToken, "list_tasks", { mountId: MOUNT, folder: "RepoGone" })).text,
  );
  assert.deepEqual(
    listed.tasks.map((t: { taskId: string }) => t.taskId),
    [filed.id],
  );
  assert.equal(listed.matchedFolder, gone);
  assert.match(listed.matchedFolderNote, /No such folder/);
});

test("list_tasks refuses a folder within a mount it has no root for", async () => {
  const chatToken = chat.mintCapability({ kind: "chat", chatId: randomUUID() });
  const refused = await callTool(chatToken, "list_tasks", {
    mountId: "no-such-mount",
    folder: "RepoOne",
  });
  assert.equal(refused.isError, true, "an unknown is not a clear backlog");
  assert.match(refused.text, /list_folders/);
});

/**
 * A chat to propose into, and a count of the rows it holds, because what the
 * proposal refusals below pin is that nothing reached the operator's panel:
 * a card a person approves is the only door these arguments have to a run.
 */
function proposingChat(): { chatId: string; token: string; proposals: () => number } {
  const chatId = chat.createChat().id;
  return {
    chatId,
    token: chat.mintCapability({ kind: "chat", chatId }),
    proposals: () =>
      (
        db()
          .prepare("SELECT COUNT(*) AS n FROM chat_proposals WHERE chat_id = ?")
          .get(chatId) as { n: number }
      ).n,
  };
}

test("a dependsOn that is not a list is refused by name and proposes nothing", async () => {
  // The list sent as a JSON string is the shape a model's array arguments
  // arrive in. Read as "no dependency", it was a card with no "starts after"
  // line and a run started on top of the one it was told to wait for.
  const { token, proposals } = proposingChat();
  const first = await callTool(token, "propose_run", {
    mountId: MOUNT,
    folder: "RepoOne",
    id: "first",
    title: "First",
    task: "Do the first thing.",
  });
  assert.equal(first.isError, false, first.text);
  const asString = JSON.stringify([{ id: "first", edge: "on-success" }]);

  const run = await callTool(token, "propose_run", {
    mountId: MOUNT,
    folder: "RepoOne",
    title: "Second",
    task: "Do the second thing, after the first.",
    dependsOn: asString,
  });
  assert.equal(run.isError, true, "propose_run refuses it");
  assert.match(run.text, /dependsOn is not a list/);

  const block = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    name: id.toUpperCase(),
    mountId: MOUNT,
    folder: "RepoOne",
    task: `Step ${id}.`,
    ...over,
  });
  const workflow = await callTool(token, "propose_workflow", {
    name: `Two steps ${randomUUID()}`,
    blocks: [
      block("a"),
      block("b", { dependsOn: JSON.stringify([{ id: "a", edge: "on-success" }]) }),
    ],
  });
  assert.equal(workflow.isError, true, "propose_workflow refuses it");
  assert.match(workflow.text, /“B” has a dependsOn that is not a list/);

  assert.equal(proposals(), 1, "only the first proposal was written");

  // Absent and null still mean "starts at once".
  const unordered = await callTool(token, "propose_run", {
    mountId: MOUNT,
    folder: "RepoOne",
    title: "Third",
    task: "Do the third thing whenever.",
    dependsOn: null,
  });
  assert.equal(unordered.isError, false, unordered.text);
});

test("propose_run refuses a mount with no folder, and a folder with no mount", async () => {
  const { token, proposals } = proposingChat();

  // An omitted folder is not `""`, and read as one it proposed the whole
  // mount — the folder claim that blocks every other run under it.
  const noFolder = await callTool(token, "propose_run", {
    mountId: MOUNT,
    title: "Somewhere",
    task: "Do a thing somewhere.",
  });
  assert.equal(noFolder.isError, true);
  assert.match(noFolder.text, /names a mount and no folder/);
  assert.match(noFolder.text, /list_folders/);

  // With a template naming its own folder, a folder sent without its mount was
  // dropped and the run proposed in the template's folder instead, under a
  // reply that never said so.
  const templateId = randomUUID();
  db()
    .prepare(
      `INSERT INTO run_templates (id, name, prompt, mount_id, folder, permission_mode,
         isolate, budget, created_at, updated_at)
       VALUES (?, ?, 'p', ?, 'RepoOne', 'plan', 0, '{}', 0, 0)`,
    )
    .run(templateId, `Template ${templateId}`, MOUNT);
  const noMount = await callTool(token, "propose_run", {
    templateId,
    folder: "RepoTwo",
    title: "Elsewhere",
    task: "Do a thing in the other repository.",
  });
  assert.equal(noMount.isError, true);
  assert.match(noMount.text, /needs mountId beside it/);
  assert.match(noMount.text, /list_folders/);

  assert.equal(proposals(), 0, "neither wrote a card");

  // The mount root is still a real answer, and the template's folder is still
  // what a proposal naming neither gets.
  for (const args of [
    { mountId: MOUNT, folder: "" },
    { templateId },
  ]) {
    const ok = await callTool(token, "propose_run", {
      ...args,
      title: `Fine ${randomUUID()}`,
      task: "Do a thing.",
    });
    assert.equal(ok.isError, false, ok.text);
  }
  assert.equal(proposals(), 2);
});

test("propose_workflow refuses a block whose folder is null, and takes \"\" as the mount root", async () => {
  const { token, proposals } = proposingChat();
  const propose = (folder: unknown) =>
    callTool(token, "propose_workflow", {
      name: `One step ${randomUUID()}`,
      blocks: [{ id: "a", name: "Somewhere", mountId: MOUNT, folder, task: "Do a thing." }],
    });

  // `null` is what a model sends for a field it has no value for, and
  // `normalizeWorkflowInput` reads it through `?? ""` as the mount root — the
  // folder claim that blocks every other run under it, on a card that looks
  // like any other.
  const nullFolder = await propose(null);
  assert.equal(nullFolder.isError, true, "propose_workflow refuses it");
  assert.match(nullFolder.text, /“Somewhere” names no folder/);
  assert.match(nullFolder.text, /list_folders/);
  assert.equal(proposals(), 0, "and wrote no card");

  const mountRoot = await propose("");
  assert.equal(mountRoot.isError, false, mountRoot.text);
  assert.equal(proposals(), 1);
});

/**
 * The chat can name the provider a proposed run is spawned as, which it could
 * not before: the tool had no field for it, so the orchestrator told the
 * operator it could not choose one. Pinned on what it must refuse, because each
 * refusal stands for a card that would otherwise say something false — a Codex
 * run nothing ends, a Codex card promising a Claude model, or one promising a
 * saved agent whose prompt never reaches it — and on the value reaching the row
 * the approval reads.
 */
test("propose_run carries a provider, and refuses a Codex card it could not honour", async () => {
  const { chatId, token, proposals } = proposingChat();
  const template = (budget: string) => {
    const id = randomUUID();
    db()
      .prepare(
        `INSERT INTO run_templates (id, name, prompt, mount_id, folder, permission_mode,
           isolate, budget, created_at, updated_at)
         VALUES (?, ?, 'p', ?, 'RepoOne', 'plan', 0, ?, 0, 0)`,
      )
      .run(id, `Template ${id}`, MOUNT, budget);
    return id;
  };
  const endless = template(JSON.stringify({ maxIterations: null }));
  const bounded = template(JSON.stringify({ maxIterations: 3 }));
  const propose = (over: Record<string, unknown>) =>
    callTool(token, "propose_run", {
      title: `Codex ${randomUUID()}`,
      task: "Do a thing.",
      ...over,
    });

  const unknown = await propose({ templateId: bounded, provider: "gemini" });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /Unknown provider "gemini"/);

  const noEnd = await propose({ templateId: endless, provider: "codex" });
  assert.equal(noEnd.isError, true);
  assert.match(noEnd.text, /needs a work-cycle limit or a time limit/);

  const agentId = randomUUID();
  db()
    .prepare(
      `INSERT INTO agents (id, name, description, prompt, created_at, updated_at)
       VALUES (?, ?, 'Reviews things.', 'You review.', 0, 0)`,
    )
    .run(agentId, `Agent ${agentId.slice(0, 8)}`);
  const asAgent = await propose({ templateId: bounded, provider: "codex", agentId });
  assert.equal(asAgent.isError, true);
  assert.match(asAgent.text, /cannot be started as a saved agent/);

  assert.equal(proposals(), 0, "no refusal wrote a card");

  const ok = await propose({ templateId: bounded, provider: "codex" });
  assert.equal(ok.isError, false, ok.text);
  assert.match(ok.text, /spawned as Codex/);
  const plain = await propose({ templateId: bounded });
  assert.equal(plain.isError, false, plain.text);

  const rows = db()
    .prepare("SELECT provider FROM chat_proposals WHERE chat_id = ? ORDER BY created_at")
    .all(chatId) as { provider: string | null }[];
  assert.deepEqual(
    rows.map((r) => r.provider),
    ["codex", null],
    "a named provider reaches the row, and an omitted one stays the ordinary run",
  );

  // The local provider: refused while nobody is signed in, and refused a model
  // off the list, which is Claude ids its server has never heard of.
  const signedOut = await propose({ templateId: bounded, provider: "local" });
  assert.equal(signedOut.isError, true);
  assert.match(signedOut.text, /local provider is signed out/);
  db()
    .prepare(
      `INSERT INTO local_provider (id, base_url, token, model, signed_in_at)
       VALUES (1, 'http://192.168.0.190:1234', NULL, 'qwen3', 0)`,
    )
    .run();
  const local = await propose({ templateId: bounded, provider: "local" });
  assert.equal(local.isError, false, local.text);
  assert.match(local.text, /spawned as Local model/);
  db().prepare("DELETE FROM local_provider").run();
});

/**
 * A body that is no JSON-RPC message at all. `null` used to throw on its first
 * property read, which was answered and audited as a 500 by the one door a
 * capability holder reaches; `5`, `"x"` and `[]` read as notifications and got
 * an empty 202, which tells the caller its request was accepted.
 */
type RpcError = { id: unknown; error: { code: number } };

async function postRaw(token: string, body: string): Promise<Response> {
  return route.POST(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body,
    }),
  );
}

test("a body that is not a message is an Invalid Request, not a 500 or an empty 202", async () => {
  const { token } = seedRun(HERE);

  for (const body of ["null", "[null]", "5", '"x"', "[]"]) {
    const res = await postRaw(token, body);
    const reply = (await res.json()) as RpcError | RpcError[];
    const replies = Array.isArray(reply) ? reply : [reply];

    // A batch keeps its envelope; anything that is not one is refused whole.
    assert.equal(res.status, body === "[null]" ? 200 : 400, `status for ${body}`);
    assert.equal(replies.length, 1, `one reply for ${body}`);
    assert.equal(replies[0].error.code, -32600, `${body} is an Invalid Request`);
    assert.equal(replies[0].id, null, `the id of ${body} cannot be read`);
  }
});

test("a batch answers a member that is not an object in its slot and keeps the rest", async () => {
  const { token } = seedRun(HERE);

  const res = await postRaw(token, JSON.stringify([7, { jsonrpc: "2.0", id: 2, method: "ping" }]));
  assert.equal(res.status, 200);
  const replies = (await res.json()) as { id: unknown; result?: unknown; error?: { code: number } }[];

  assert.equal(replies.length, 2);
  assert.equal(replies[0].error?.code, -32600);
  assert.equal(replies[1].id, 2);
  assert.deepEqual(replies[1].result, {});
});
