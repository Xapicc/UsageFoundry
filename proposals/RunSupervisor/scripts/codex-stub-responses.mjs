// Loopback stand-in for the OpenAI Responses API, enough for `codex exec` to
// make one MCP tool call and finish. Prints "PORT <n>" once listening.
//
//   node codex-stub-responses.mjs <logdir>
//
// Request 0 -> a function_call of the MCP tool (Codex 0.153 exposes a server's
// tools as a "namespace" tool, so the call carries namespace + name); any later request -> an assistant
// message "ANSWER_SEEN: <function_call_output>". Each request body is saved as
// <logdir>/req-<n>.json and logged with a wall-clock stamp in requests.jsonl.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const [logDir] = process.argv.slice(2);
fs.mkdirSync(logDir, { recursive: true });
let n = 0;
const sse = (res, events) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
};
const completed = (id) => ({ type: "response.completed", response: { id, object: "response", status: "completed", usage: { input_tokens: 10, input_tokens_details: null, output_tokens: 5, output_tokens_details: null, total_tokens: 15 } } });

http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    const entry = { t: new Date().toISOString(), method: req.method, url: req.url };
    if (!req.url.includes("/responses") || req.method !== "POST") {
      fs.appendFileSync(path.join(logDir, "requests.jsonl"), JSON.stringify(entry) + "\n");
      res.writeHead(404, { "content-type": "application/json" });
      return res.end("{}");
    }
    const i = n++;
    fs.writeFileSync(path.join(logDir, `req-${i}.json`), raw);
    let body = {};
    try { body = JSON.parse(raw); } catch { /* logged raw */ }
    const outputs = (body.input ?? []).filter((x) => x.type === "function_call_output");
    entry.step = i;
    entry.toolNames = (body.tools ?? []).map((t) => t.name ?? t.type).filter((x) => /mcp|sup/.test(x ?? ""));
    entry.functionCallOutput = outputs.length ? JSON.stringify(outputs.at(-1).output).slice(0, 600) : null;
    fs.appendFileSync(path.join(logDir, "requests.jsonl"), JSON.stringify(entry) + "\n");
    const id = "resp_stub_" + i;
    if (outputs.length === 0) {
      sse(res, [
        { type: "response.created", response: { id, object: "response", status: "in_progress" } },
        { type: "response.output_item.done", item: { type: "function_call", namespace: "mcp__sup", name: "ask_supervisor", arguments: JSON.stringify({ question: "QUESTION_FOR_SUPERVISOR" }), call_id: "call_stub_1" } },
        completed(id),
      ]);
    } else {
      sse(res, [
        { type: "response.created", response: { id, object: "response", status: "in_progress" } },
        { type: "response.output_item.done", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ANSWER_SEEN: " + JSON.stringify(outputs.at(-1).output).slice(0, 400) }] } },
        completed(id),
      ]);
    }
  });
}).listen(0, "127.0.0.1", function () { console.log("PORT " + this.address().port); });
