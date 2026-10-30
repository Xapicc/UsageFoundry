// Loopback stand-in for the Anthropic Messages API, so the real pinned CLI can
// be driven with no credentials and nothing billed. Prints "PORT <n>" once
// listening. Every request is appended to <logdir>/requests.jsonl with a wall
// clock stamp; every main-loop request body is kept whole as main-<n>.json.
//
//   node stub-api.mjs <logdir> <scenario> [key=value ...]
//
// Scenarios (main-loop = a request carrying more than five tools):
//   text       every main-loop request answers a short end_turn text.
//   mcp-ask    request 0 -> tool_use of tool=<name> (default
//              mcp__sup__ask_supervisor) with {question}; every later request
//              -> end_turn text "ANSWER_SEEN: <the tool_result text it carried>".
//   fifo       request 0 -> tool_use Read of fifo=<path> (blocks until a writer
//              fills the FIFO); every later request -> end_turn text.
//   slowstream request 0 -> a text answer streamed in two parts with gap=<ms>
//              between them (the model is "mid-stream" for that long); later
//              requests -> end_turn text.
//
// Token usage is deterministic so a cumulative `result` figure can be told from
// a per-turn one: request n reports input_tokens 1000+100n, output_tokens 50+n.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const [logDir, scenario = "text", ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.map((a) => a.split(/=(.*)/s).slice(0, 2)));
fs.mkdirSync(logDir, { recursive: true });
let mainCount = 0;
let seq = 0;

function userTexts(body) {
  const out = [];
  // role "system" inside messages[] is where the CLI puts a message that was
  // injected mid-turn ("The user sent a new message while you were working"),
  // so it is reported too, tagged.
  for (const m of body.messages ?? []) {
    if (m.role !== "user" && m.role !== "system") continue;
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    for (const b of blocks) {
      if (b.type === "text") out.push((m.role === "system" ? "[role:system] " : "") + b.text.slice(0, 200));
      if (b.type === "tool_result") {
        const c = typeof b.content === "string" ? b.content : (b.content ?? []).map((x) => x.text ?? `[${x.type}]`).join(" | ");
        out.push(`[tool_result ${b.is_error ? "ERROR " : ""}${c.slice(0, 600)}]`);
      }
    }
  }
  return out;
}

function lastToolResultText(body) {
  const msgs = body.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const c = msgs[i].content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b.type !== "tool_result") continue;
      const text = typeof b.content === "string" ? b.content : (b.content ?? []).map((x) => x.text ?? "").join("\n");
      return (b.is_error ? "ERROR: " : "") + text;
    }
  }
  return "(no tool_result)";
}

function decide(step, body) {
  const text = (t, extra = {}) => ({ kind: "text", text: t, ...extra });
  const tool = (name, input) => ({ kind: "tool", name, input });
  if (scenario === "mcp-ask") {
    return step === 0
      ? tool(opt.tool ?? "mcp__sup__ask_supervisor", { question: "QUESTION_FOR_SUPERVISOR" })
      : text("ANSWER_SEEN: " + lastToolResultText(body).slice(0, 400));
  }
  if (scenario === "fifo") return step === 0 ? tool("Read", { file_path: opt.fifo }) : text(`DONE-${step}`);
  if (scenario === "slowstream") return step === 0 ? text("PART-ONE then ", { gap: Number(opt.gap ?? 20000), tail: "PART-TWO" }) : text(`DONE-${step}`);
  return text("ok");
}

function frame(e) { return `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function respond(res, body, action, step) {
  const id = "msg_stub_" + ++seq;
  const usage = { input_tokens: 1000 + 100 * step, output_tokens: 50 + step, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const stop = action.kind === "tool" ? "tool_use" : "end_turn";
  const block = action.kind === "tool"
    ? { type: "tool_use", id: "toolu_stub_" + seq, name: action.name, input: action.input }
    : { type: "text", text: action.text + (action.tail ?? "") };
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id, type: "message", role: "assistant", model: body.model, content: [block], stop_reason: stop, stop_sequence: null, usage }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.write(frame({ type: "message_start", message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } }));
  if (action.kind === "tool") {
    res.write(frame({ type: "content_block_start", index: 0, content_block: { ...block, input: {} } }));
    res.write(frame({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(action.input) } }));
  } else {
    res.write(frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    res.write(frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: action.text } }));
    if (action.tail) {
      await sleep(action.gap);
      res.write(frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: action.tail } }));
    }
  }
  res.write(frame({ type: "content_block_stop", index: 0 }));
  res.write(frame({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } }));
  res.write(frame({ type: "message_stop" }));
  res.end();
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    const url = req.url ?? "";
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const isMain = url.startsWith("/v1/messages") && !url.includes("count_tokens") && tools.length > 5;
    const entry = { t: new Date().toISOString(), method: req.method, url, isMain, stream: body.stream, nTools: tools.length };
    const log = () => fs.appendFileSync(path.join(logDir, "requests.jsonl"), JSON.stringify(entry) + "\n");
    if (url.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 10 }));
      return log();
    }
    if (!url.startsWith("/v1/messages")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "stub" } }));
      return log();
    }
    let action = { kind: "text", text: "ok" };
    let step = 0;
    if (isMain) {
      step = mainCount++;
      action = decide(step, body);
      entry.step = step;
      entry.userBlocks = userTexts(body);
      entry.mcpToolsOffered = tools.map((t) => t.name).filter((n) => n.startsWith("mcp__"));
      fs.writeFileSync(path.join(logDir, `main-${step}.json`), raw);
    }
    entry.answer = action.kind === "tool" ? `tool_use ${action.name}` : `text ${action.text}`;
    log();
    await respond(res, body, action, step);
    if (isMain) fs.appendFileSync(path.join(logDir, "requests.jsonl"), JSON.stringify({ t: new Date().toISOString(), step, event: "response-finished" }) + "\n");
  });
});
server.listen(0, "127.0.0.1", () => console.log("PORT " + server.address().port));
