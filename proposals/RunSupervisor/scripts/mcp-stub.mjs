// A minimal streamable-HTTP MCP server whose one tool, ask_supervisor, answers
// only after a delay. It matches the shape of the app's own server
// (src/app/api/mcp/route.ts): stateless, no Mcp-Session-Id, GET and DELETE
// answered 405, a bearer header expected. Prints "PORT <n>" once listening.
//
//   node mcp-stub.mjs <logdir> <mode> <delaySec> [tickSec=30]
//
// Modes for the tools/call POST:
//   json            hold the connection open, then answer with application/json.
//   sse             answer 200 text/event-stream at once, write nothing, then send
//                   the result as one SSE message event after the delay.
//   sse-keepalive   as sse, but write an SSE comment (": keepalive") every tickSec.
//   sse-progress    as sse, but send a JSON-RPC notifications/progress message
//                   every tickSec, using the progressToken the client sent in
//                   params._meta (logged as "progressToken: none" if it sent none).
//
// <logdir>/mcp.jsonl gets one line per HTTP request and per call event, with a
// wall-clock stamp and, for the call, the seconds since it arrived. The line
// "call-connection-closed-by-client" is the evidence that the CLI gave up.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const [logDir, mode = "json", delaySecArg = "5", tickArg = "30"] = process.argv.slice(2);
const delayMs = Number(delaySecArg) * 1000;
const tickMs = Number(tickArg) * 1000;
fs.mkdirSync(logDir, { recursive: true });
const log = (o) => fs.appendFileSync(path.join(logDir, "mcp.jsonl"), JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n");

const TOOL = {
  name: "ask_supervisor",
  description: "Ask the supervisor a question and wait for the answer.",
  inputSchema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
};

function handleCall(msg, req, res) {
  const started = Date.now();
  const elapsed = () => Math.round((Date.now() - started) / 100) / 10;
  const token = msg.params?._meta?.progressToken;
  log({ ev: "call-start", mode, delaySec: delayMs / 1000, progressToken: token ?? "none", meta: msg.params?._meta ?? null });
  const result = { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `SUPERVISOR_ANSWER after ${delayMs / 1000}s (mode ${mode})` }] } };
  let finished = false;
  const timers = [];
  res.on("close", () => {
    if (!finished) log({ ev: "call-connection-closed-by-client", afterSec: elapsed() });
    timers.forEach(clearInterval);
  });
  if (mode !== "json") res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }), res.flushHeaders();
  let n = 0;
  if (mode === "sse-keepalive") timers.push(setInterval(() => { res.write(": keepalive\n\n"); log({ ev: "keepalive", atSec: elapsed() }); }, tickMs));
  if (mode === "sse-progress") {
    timers.push(setInterval(() => {
      n += 1;
      const note = { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token ?? "stub-token", progress: n, total: 100, message: `waiting ${elapsed()}s` } };
      res.write(`event: message\ndata: ${JSON.stringify(note)}\n\n`);
      log({ ev: "progress", n, atSec: elapsed() });
    }, tickMs));
  }
  setTimeout(() => {
    finished = true;
    timers.forEach(clearInterval);
    if (mode === "json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } else {
      res.write(`event: message\ndata: ${JSON.stringify(result)}\n\n`);
      res.end();
    }
    log({ ev: "call-answered", atSec: elapsed() });
  }, delayMs);
}

http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const auth = req.headers.authorization ? "present" : "absent";
    if (req.method !== "POST") {
      log({ ev: "http", method: req.method, status: 405 });
      res.writeHead(405, { "content-type": "application/json" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32601, message: "No server stream" } }));
    }
    let msg;
    try { msg = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { res.writeHead(400); return res.end(); }
    log({ ev: "http", method: msg.method, id: msg.id, auth, accept: req.headers.accept });
    if (msg.method === "initialize") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stub-supervisor", version: "0" } } }));
    }
    if (msg.method === "tools/list") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [TOOL] } }));
    }
    if (msg.method === "tools/call") return handleCall(msg, req, res);
    if (msg.id === undefined) { res.writeHead(202); return res.end(); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } }));
  });
}).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
