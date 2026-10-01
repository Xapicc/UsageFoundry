// Local stand-in for the Anthropic Messages API, so the real CLI can be driven
// with no credentials and nothing billed. Usage:
//   node stub.mjs <logdir> <scenario>   (prints "PORT <n>" on stdout once listening)
// Scenarios:
//   text      every main-loop request is answered with a short end_turn text
//   list      first main-loop request -> tool_use ListAgents, then end_turn
//   pair      session A (prompt contains ROLE_A): ListAgents, then a 25s-slow
//             ListAgents, then a 12s-slow end_turn text; session B (ROLE_B):
//             ListAgents, then SendMessage to A's name (parsed from B's listing),
//             then end_turn. ROLE_C / ROLE_D behave like B; the harness starts D
//             during A's last (slow) request and C after A has exited.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const [logDir, scenario = "text"] = process.argv.slice(2);
fs.mkdirSync(logDir, { recursive: true });
const steps = new Map(); // role -> number of main-loop requests answered
let seq = 0;

function roleOf(bodyText) {
  for (const r of ["ROLE_A", "ROLE_B", "ROLE_C", "ROLE_D"]) if (bodyText.includes(r)) return r;
  return "OTHER";
}

function lastToolResultText(body) {
  const msgs = body.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const c = msgs[i].content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b.type === "tool_result") {
        if (typeof b.content === "string") return b.content;
        if (Array.isArray(b.content)) return b.content.map((x) => x.text ?? "").join("\n");
      }
    }
  }
  return "";
}

function decide(role, step, body) {
  const text = (t, delay = 0) => ({ kind: "text", text: t, delay });
  const tool = (name, input, delay = 0) => ({ kind: "tool", name, input, delay });
  if (scenario === "text") return text("ok");
  if (scenario === "list") return step === 0 ? tool("ListAgents", {}) : text("listed");
  if (scenario === "pair") {
    if (role === "ROLE_A") {
      if (step === 0) return tool("ListAgents", {});
      if (step === 1) return tool("ListAgents", {}, 25000);
      if (step === 2) return text("A finishing", 12000);
      return text("A extra turn " + step);
    }
    if (role === "ROLE_B" || role === "ROLE_C" || role === "ROLE_D") {
      if (step === 0) return tool("ListAgents", {});
      if (step === 1) {
        const listing = lastToolResultText(body);
        const m = listing.match(/\b(cwda-[a-z0-9-]+)/i);
        const to = m ? m[1] : "cwda-NOT-LISTED";
        return tool("SendMessage", { to, message: `PING from ${role} at ${new Date().toISOString()}` });
      }
      return text(role + " done");
    }
  }
  return text("ok");
}

function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}

function respond(res, body, action) {
  const id = "msg_stub_" + ++seq;
  const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const block =
    action.kind === "tool"
      ? { type: "tool_use", id: "toolu_stub_" + seq, name: action.name, input: action.input }
      : { type: "text", text: action.text };
  const stop = action.kind === "tool" ? "tool_use" : "end_turn";
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id, type: "message", role: "assistant", model: body.model, content: [block], stop_reason: stop, stop_sequence: null, usage }));
    return;
  }
  const start = action.kind === "tool" ? { ...block, input: {} } : { type: "text", text: "" };
  const delta =
    action.kind === "tool"
      ? { type: "input_json_delta", partial_json: JSON.stringify(action.input) }
      : { type: "text_delta", text: action.text };
  sse(res, [
    { type: "message_start", message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } },
    { type: "content_block_start", index: 0, content_block: start },
    { type: "content_block_delta", index: 0, delta },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ]);
}

function summarizeMessages(body) {
  return (body.messages ?? []).map((m) => ({
    role: m.role,
    blocks: (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content).map((b) => ({
      type: b.type,
      name: b.name,
      text: (b.text ?? (typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((x) => x.text ?? `[${x.type}]`).join(" | ") : undefined))?.slice(0, 1500),
      input: b.input,
    })),
  }));
}

const server = http.createServer((req, res) => {
  let chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = { unparsed: raw.slice(0, 200) }; }
    const url = req.url ?? "";
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const isMain = url.startsWith("/v1/messages") && !url.includes("count_tokens") && tools.length > 5;
    const role = roleOf(JSON.stringify(body.messages ?? []));
    const entry = {
      t: new Date().toISOString(), method: req.method, url, role, isMain, model: body.model,
      toolNames: tools.map((t) => t.name + (t.defer_loading ? "(deferred)" : "")),
      sessionHeader: req.headers["x-claude-code-session-id"],
    };
    if (url.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 10 }));
      fs.appendFileSync(path.join(logDir, "requests.jsonl"), JSON.stringify(entry) + "\n");
      return;
    }
    if (!url.startsWith("/v1/messages")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "stub" } }));
      fs.appendFileSync(path.join(logDir, "requests.jsonl"), JSON.stringify(entry) + "\n");
      return;
    }
    let action = { kind: "text", text: "ok", delay: 0 };
    if (isMain) {
      const step = steps.get(role) ?? 0;
      steps.set(role, step + 1);
      action = decide(role, step, body);
      entry.step = step;
      entry.messages = summarizeMessages(body);
      fs.writeFileSync(path.join(logDir, `main-${role}-${step}.json`), raw);
    }
    entry.answer = action;
    fs.appendFileSync(path.join(logDir, "requests.jsonl"), JSON.stringify(entry) + "\n");
    if (action.delay) await new Promise((r) => setTimeout(r, action.delay));
    respond(res, body, action);
  });
});
server.listen(0, "127.0.0.1", () => console.log("PORT " + server.address().port));
