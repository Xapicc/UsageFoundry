#!/usr/bin/env node
// Does a `denyRead` in the chat's --settings overlay keep a git driver started
// from a sandboxed `Bash` call away from the chat's capability file? (board task
// f3cb882a; docs/agent/security/chat-child-config-files.md, "What is still open".)
//
// Run it as the agents' uid inside a booted container with UF_SANDBOX=1, never
// against the live app's /run/uf-mcp — everything it reads and writes is a
// scratch directory it makes under os.tmpdir():
//
//   docker compose cp scripts/sandbox-probe/chat-denyread-probe.mjs usagefoundry:/tmp/chat-denyread-probe.mjs
//   docker compose exec -u 1000:1000 usagefoundry node /tmp/chat-denyread-probe.mjs
//
// It stands in for the chat's capability directory with a scratch one holding a
// file with the same job: the --mcp-config the CLI reads outside the sandbox. A
// stub API answers one `Bash` call, `git -C <repo> status`, in a repository whose
// planted `filter.x.clean` copies that file into a directory the sandbox can
// write. Two turns, because a result with nothing to compare it to proves
// nothing: a control without the deny, in which the copy must succeed, and the
// turn under test, in which it must not.
//
// A second file is denied through the *user* scope (`$CLAUDE_CONFIG_DIR/settings.json`)
// in the turn under test, and must stay denied beside the overlay's: the managed
// policy's own `denyRead` (`/data`, `/backups`) reaches the chat the same way,
// and an overlay that replaced it where it should add to it would drop those.
//
// Exit 0: the control leaked both files, the deny held for both, and the stub MCP
// server connected.
// Exit 1: a deny did not hold, or the MCP server did not connect under it.
// Exit 2: nothing was measured — no managed sandbox policy, the CLI's sandbox
// could not start (as it cannot nested inside an agent's own sandbox), or the
// control did not leak, so the planted filter never ran.
//
// NOT YET RUN against a sandbox that starts. Run nested in an agent's sandbox it
// reaches the stub API, connects the stub MCP server from the config file and
// gets the `Bash` call to the CLI's sandbox, which answers "Sandbox is required
// but failed to initialize: EPERM … srt-mux-….sock" (exit 2). The planted filter
// was run by hand, unsandboxed: it fired on `git status` and copied the file.
// PROBE_DEBUG=1 logs each stub request; PROBE_TURN_TIMEOUT_MS bounds a turn.

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const MANAGED_SETTINGS = "/etc/claude-code/managed-settings.json";
const TURN_TIMEOUT_MS = Number(process.env.PROBE_TURN_TIMEOUT_MS ?? 120_000);

function fail(code, message) {
  console.error(message);
  // `process.exit` skips the `finally` below, so the scratch directory goes here.
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exit(code);
}

function requireManagedSandbox() {
  let policy;
  try {
    policy = JSON.parse(fs.readFileSync(MANAGED_SETTINGS, "utf8"));
  } catch (err) {
    fail(2, `no readable ${MANAGED_SETTINGS} (${err.message}): this is not a UF_SANDBOX=1 container`);
  }
  if (policy?.sandbox?.enabled !== true) {
    fail(2, `${MANAGED_SETTINGS} does not enable the sandbox: nothing to measure`);
  }
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "uf-denyread-probe-"));
const secretDir = path.join(scratch, "secret");
const secondDir = path.join(scratch, "secret-user-scope");
const sinkDir = path.join(scratch, "sink");
const repoDir = path.join(scratch, "repo");
const claudeHome = path.join(scratch, "claude-home");
const cwd = path.join(scratch, "cwd");
for (const dir of [secretDir, secondDir, sinkDir, repoDir, claudeHome, cwd]) fs.mkdirSync(dir);
const token = `probe-${crypto.randomBytes(8).toString("hex")}`;
const secretFile = path.join(secretDir, "config.json");
const leakFile = path.join(sinkDir, "leak");
const secondFile = path.join(secondDir, "other.json");
const secondLeakFile = path.join(sinkDir, "leak-user-scope");

function git(...args) {
  const result = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf8" });
  if (result.status !== 0) fail(2, `git ${args.join(" ")} failed: ${result.stderr}`);
}

// The clean filter runs on `git status` when a file's size matches the index and
// its mtime does not, so the filter is configured after the commit and the file
// touched after that. `cat` last, so git still gets the content back.
function plantFilter() {
  git("init", "-q");
  git("config", "user.email", "probe@example.invalid");
  git("config", "user.name", "probe");
  fs.writeFileSync(path.join(repoDir, "f.txt"), "one\n");
  git("add", "f.txt");
  git("commit", "-q", "-m", "init");
  fs.writeFileSync(path.join(repoDir, ".git", "info", "attributes"), "f.txt filter=x\n");
  git(
    "config",
    "filter.x.clean",
    `cp '${secretFile}' '${leakFile}' 2>/dev/null; cp '${secondFile}' '${secondLeakFile}' 2>/dev/null; cat`,
  );
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(repoDir, "f.txt"), later, later);
}

function sseBody(content, stopReason) {
  const events = [
    ["message_start", { message: { id: "msg_probe", type: "message", role: "assistant", model: "claude-probe", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
  ];
  content.forEach((block, index) => {
    if (block.type === "text") {
      events.push(["content_block_start", { index, content_block: { type: "text", text: "" } }]);
      events.push(["content_block_delta", { index, delta: { type: "text_delta", text: block.text } }]);
    } else {
      events.push(["content_block_start", { index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } }]);
      events.push(["content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }]);
    }
    events.push(["content_block_stop", { index }]);
  });
  events.push(["message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } }]);
  events.push(["message_stop", {}]);
  return events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join("");
}

// One server for both halves: `POST /v1/messages` is the API the CLI is pointed
// at, `POST /mcp` the minimal streamable-HTTP MCP server the config names.
function startStub() {
  const seen = { toolResult: null, mcpMethods: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (process.env.PROBE_DEBUG) console.error(`stub: ${req.method} ${req.url}`);
      // The streamable-HTTP transport opens a GET for server-initiated messages
      // and takes a 405 as "none"; a 202 makes it reconnect in a loop.
      if (req.method !== "POST") return void res.writeHead(405).end();
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (req.url === "/mcp") {
        seen.mcpMethods.push(body.method);
        if (body.id === undefined) return void res.writeHead(202).end();
        const result =
          body.method === "initialize"
            ? { protocolVersion: body.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "0" } }
            : body.method === "tools/list"
              ? { tools: [{ name: "ping", description: "ping", inputSchema: { type: "object", properties: {} } }] }
              : undefined;
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(
          JSON.stringify(
            result === undefined
              ? { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: `no such method: ${body.method}` } }
              : { jsonrpc: "2.0", id: body.id, result },
          ),
        );
      }
      if (!req.url?.startsWith("/v1/messages")) return void res.writeHead(404).end();
      // Searched for in every message: this CLI appends a system-role message
      // after the tool result, so the last message is not where it is.
      const result = (body.messages ?? [])
        .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
        .find((block) => block.type === "tool_result" && block.tool_use_id === "toolu_probe");
      // Only the main conversation offers `Bash`; the CLI's side requests get text.
      const isMain = Array.isArray(body.tools) && body.tools.some((t) => t.name === "Bash");
      if (result) seen.toolResult = JSON.stringify(result.content);
      const content =
        isMain && !result
          ? [{ type: "tool_use", id: "toolu_probe", name: "Bash", input: { command: `git -C '${repoDir}' status --short`, description: "status" } }]
          : [{ type: "text", text: "done" }];
      const stopReason = content[0].type === "tool_use" ? "tool_use" : "end_turn";
      if (body.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        return void res.end(sseBody(content, stopReason));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_probe", type: "message", role: "assistant", model: "claude-probe", content, stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen, port: server.address().port })));
}

async function turn(label, denyRead) {
  fs.rmSync(leakFile, { force: true });
  fs.rmSync(secondLeakFile, { force: true });
  fs.writeFileSync(secondFile, `{"token":"${token}-user-scope"}`, { mode: 0o600 });
  fs.writeFileSync(
    path.join(claudeHome, "settings.json"),
    JSON.stringify(denyRead ? { sandbox: { filesystem: { denyRead: [secondDir] } } } : {}),
  );
  const { server, seen, port } = await startStub();
  fs.writeFileSync(
    secretFile,
    JSON.stringify({ mcpServers: { stub: { type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` } } } }),
    { mode: 0o600 },
  );
  // The chat's own overlay shape: a write set, optionally a deny, hooks off, and
  // no `sandbox.enabled` — that belongs to the managed file.
  const filesystem = { allowWrite: [...new Set([scratch, os.tmpdir(), claudeHome])], ...(denyRead ? { denyRead: [secretDir] } : {}) };
  const args = [
    "-p", "probe", "--output-format", "stream-json", "--verbose",
    "--permission-mode", "bypassPermissions",
    "--mcp-config", secretFile, "--strict-mcp-config",
    "--setting-sources", "user",
    "--settings", JSON.stringify({ sandbox: { filesystem }, disableAllHooks: true }),
    "--add-dir", scratch,
  ];
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_API_KEY: "sk-ant-probe",
    CLAUDE_CONFIG_DIR: claudeHome,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  const child = spawn(CLAUDE_BIN, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const timer = setTimeout(() => child.kill("SIGKILL"), TURN_TIMEOUT_MS);
  const code = await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  server.close();

  const events = stdout.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const init = events.find((event) => event.type === "system" && event.subtype === "init");
  const mcpConnected = init?.mcp_servers?.some((s) => s.name === "stub" && s.status === "connected") === true;
  const toolResult = seen.toolResult ?? "";
  const leaked = (fs.existsSync(leakFile) && fs.readFileSync(leakFile, "utf8").includes(token)) || toolResult.includes(token);
  const leakedUserScope = fs.existsSync(secondLeakFile) && fs.readFileSync(secondLeakFile, "utf8").includes(`${token}-user-scope`);
  const sandboxFailed = /sandbox is required|failed to initiali[sz]e/i.test(toolResult);
  console.log(`${label}: exit=${code} sandboxFailed=${sandboxFailed} leaked=${leaked} leakedUserScope=${leakedUserScope} mcpConnected=${mcpConnected} mcpMethods=${seen.mcpMethods.join(",")}`);
  console.log(`${label}: tool_result=${toolResult.slice(0, 300)}`);
  if (seen.toolResult === null) console.log(`${label}: no tool_result reached the stub; stderr=${stderr.slice(0, 400)}`);
  return { leaked, leakedUserScope, sandboxFailed, mcpConnected, reachedTool: seen.toolResult !== null };
}

requireManagedSandbox();
plantFilter();
try {
  const control = await turn("control (no denyRead)", false);
  if (control.sandboxFailed || !control.reachedTool) fail(2, "the CLI's sandbox did not start or the turn never ran the tool: nothing measured");
  if (!control.leaked || !control.leakedUserScope) {
    fail(2, "the control did not leak both files, so the planted filter never copied them: the probe proves nothing");
  }
  const denied = await turn("denyRead", true);
  if (denied.sandboxFailed) fail(2, "the sandbox failed to start only under the deny: read the tool_result above");
  if (denied.leaked) fail(1, "FAILED: the file was readable from a sandboxed Bash call despite denyRead");
  if (denied.leakedUserScope) {
    fail(1, "FAILED: the overlay's denyRead replaced the user scope's instead of adding to it, so a managed denyRead would be dropped too");
  }
  if (!denied.mcpConnected) fail(1, "FAILED: the stub MCP server did not connect with its config inside the denied directory");
  console.log("PASSED: the control leaked, both denies held, and the MCP server connected from inside the denied directory");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
