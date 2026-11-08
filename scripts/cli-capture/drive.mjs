// Drives the installed `claude` CLI against a loopback stand-in for the
// Messages API that also takes OTLP/HTTP JSON, so what a pinned CLI emits can be
// captured with a dummy key and nothing billed. Derived from
// proposals/CrossSessionCommunication/scripts/stub.mjs (same SSE shape), plus:
// a `request-id` header (otlp.ts drops an api_request without one), OTLP
// capture, per-prompt scenarios keyed on an `SCN_<NAME>` marker, an answer for
// a compaction request, and a one-shot long-context 429.
//
//   node scripts/cli-capture/plans.mjs <name> <outdir> > plan.json
//   node scripts/cli-capture/drive.mjs <outdir> plan.json
//
// Server and CLI must share one process (one Bash call here: each call gets its
// own network namespace). Every cycle runs with a scratch HOME and
// CLAUDE_CONFIG_DIR from the plan and a fake key; never point either at a real
// ~/.claude. Writes per cycle: cycleN.stdout, .stderr, .meta.json, .sid; and
// requests.jsonl, otlp.jsonl, req-NNN.json for the whole plan.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const [outDir, planFile] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
fs.mkdirSync(outDir, { recursive: true });
const here = path.dirname(new URL(import.meta.url).pathname);
let seq = 0;
const log = (f, o) => fs.appendFileSync(path.join(outDir, f), JSON.stringify(o) + "\n");

const WEIRD = "ctl[\u007f][\u0085][\u009b][​][‎][ ][ ][﻿][­][⁦]end";

function userText(m) {
  if (typeof m.content === "string") return m.content;
  return (m.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}
// The last user message carrying a scenario marker, and how many assistant
// turns have followed it.
function scenarioOf(body) {
  const msgs = body.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== "user") continue;
    const m = userText(msgs[i]).match(/SCN_([A-Z0-9]+)/);
    if (m) return { name: m[1], step: msgs.slice(i + 1).filter((x) => x.role === "assistant").length };
  }
  return { name: "NONE", step: 0 };
}
function isCompaction(body) {
  const msgs = body.messages ?? [];
  const last = msgs[msgs.length - 1];
  const t = last ? userText(last) : "";
  return /create a detailed summary|summary of the conversation so far/i.test(t) && !/SCN_|<task-notification>/.test(t);
}
const bigUsage = { input_tokens: 5, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 190000 };

function decide(body) {
  const { name, step } = scenarioOf(body);
  const text = (t, extra = {}) => ({ kind: "text", text: t, ...extra });
  const tool = (n, input, extra = {}) => ({ kind: "tool", name: n, input, ...extra });
  switch (name) {
    case "BGRETRY": {
      const msgs = body.messages ?? [];
      const lastText = JSON.stringify(msgs[msgs.length - 1] ?? {});
      globalThis.__bgAttempts = globalThis.__bgAttempts ?? 0;
      const failed = /<status>failed<\/status>|bwrap:/.test(lastText);
      if ((step === 0 || failed) && globalThis.__bgAttempts < 10) {
        globalThis.__bgAttempts++;
        return tool("Bash", { command: "sleep 4; echo bg-out-" + globalThis.__bgAttempts, description: "bg attempt " + globalThis.__bgAttempts, run_in_background: true });
      }
      return text("bg turn " + step + " attempts=" + globalThis.__bgAttempts);
    }
    case "BG":
      if (step === 0) return tool("Bash", { command: "sleep 3; echo bg-out", description: "bg " + WEIRD, run_in_background: true });
      if (step === 1) return text("Started it. " + WEIRD + "\nwaiting");
      return text("bg turn " + step + " " + WEIRD);
    case "COMPACT":
      if (step === 0) return tool("Read", { file_path: "notes.txt" }, { usage: globalThis.__bigUsage ?? bigUsage });
      return text("after compaction step " + step);
    case "LONGCTX":
      if (step === 0) return tool("Read", { file_path: "notes.txt" }, { usage: bigUsage });
      if (step === 1 && !globalThis.__longctxSent) { globalThis.__longctxSent = true; return { kind: "error429" }; }
      return text("after long-context step " + step);
    case "DEFER":
      if (step === 0) return tool("mcp__dsrv__ping", {});
      return text("pinged, step " + step);
    case "DONE":
      return text("all good\nDONE");
    default:
      return text("ok " + name + " " + step);
  }
}

function sse(res, headers, events) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...headers });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}

function respond(res, body, action) {
  const id = "msg_stub_" + ++seq;
  const headers = { "request-id": "req_stub_" + Date.now() + "_" + seq };
  if (action.kind === "error429") {
    res.writeHead(429, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Extra usage is required for long context requests." } }));
    return;
  }
  const usage = action.usage ?? { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const block = action.kind === "tool"
    ? { type: "tool_use", id: "toolu_stub_" + seq, name: action.name, input: action.input }
    : { type: "text", text: action.text };
  const stop = action.kind === "tool" ? "tool_use" : "end_turn";
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify({ id, type: "message", role: "assistant", model: body.model, content: [block], stop_reason: stop, stop_sequence: null, usage }));
    return;
  }
  const start = action.kind === "tool" ? { ...block, input: {} } : { type: "text", text: "" };
  const delta = action.kind === "tool"
    ? { type: "input_json_delta", partial_json: JSON.stringify(action.input) }
    : { type: "text_delta", text: action.text };
  sse(res, headers, [
    { type: "message_start", message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } },
    { type: "content_block_start", index: 0, content_block: start },
    { type: "content_block_delta", index: 0, delta },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } },
    { type: "message_stop" },
  ]);
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = { unparsed: raw.slice(0, 200) }; }
    const url = req.url ?? "";
    if (url.startsWith("/v1/logs") || url.startsWith("/v1/metrics") || url.startsWith("/v1/traces")) {
      log("otlp.jsonl", { t: new Date().toISOString(), url, auth: req.headers.authorization ?? null, ctype: req.headers["content-type"], body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const entry = { t: new Date().toISOString(), method: req.method, url, model: body.model, ntools: tools.length,
      deferredTools: tools.filter((t) => t.defer_loading).map((t) => t.name), auth: (req.headers.authorization ?? "").slice(0, 14) || null, xkey: req.headers["x-api-key"] ? "set" : null };
    if (url.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 10 }));
      log("requests.jsonl", entry);
      return;
    }
    if (!url.startsWith("/v1/messages")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "stub" } }));
      log("requests.jsonl", entry);
      return;
    }
    fs.writeFileSync(path.join(outDir, `req-${String(seq + 1).padStart(3, "0")}.json`), raw);
    entry.reqFile = `req-${String(seq + 1).padStart(3, "0")}.json`;
    let action;
    if (isCompaction(body)) {
      action = { kind: "text", text: "<analysis>stub</analysis>\n<summary>STUB SUMMARY: the user asked for a file read; it was done.</summary>" };
      entry.compaction = true;
    } else if (tools.length > 5) {
      action = decide(body);
      entry.scenario = scenarioOf(body);
      const msgs = body.messages ?? [];
      entry.lastUser = msgs.length ? userText(msgs[msgs.length - 1]).slice(0, 200) : null;
    } else {
      action = { kind: "text", text: "side answer" };
      const msgs = body.messages ?? [];
      entry.side = msgs.length ? userText(msgs[msgs.length - 1]).slice(0, 160) : null;
    }
    entry.answer = action.kind === "tool" ? { tool: action.name } : action.kind === "text" ? { text: action.text.slice(0, 60) } : action;
    log("requests.jsonl", entry);
    respond(res, body, action);
  });
});

function runCli(port, c, i) {
  return new Promise((resolve) => {
    const env = {
      PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, LANG: "C.UTF-8",
      HOME: c.home, CLAUDE_CONFIG_DIR: c.config,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_LOGS_EXPORTER: "otlp", OTEL_METRICS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
      OTEL_LOGS_EXPORT_INTERVAL: "1000", OTEL_METRIC_EXPORT_INTERVAL: "1000",
      OTEL_RESOURCE_ATTRIBUTES: "uf.run_id=run-e4e2b51f",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer ingest-token-fake",
      HOOK_LOG: path.join(outDir, "hook.log"),
      ...(c.env ?? {}),
    };
    if (c.apiKey !== false) env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY ?? "sk-ant-api03-fake-e4e2b51f";
    for (const k of Object.keys(env)) if (env[k] === null) delete env[k];
    const args = ["-p", "--output-format", "stream-json", "--verbose", ...(c.args ?? [])];
    if (c.resumeFrom !== undefined) args.push("--resume", fs.readFileSync(path.join(outDir, `cycle${c.resumeFrom}.sid`), "utf8").trim());
    args.push("--", c.prompt);
    const t0 = Date.now();
    const child = spawn("claude", args, { cwd: c.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const out = fs.createWriteStream(path.join(outDir, `cycle${i}.stdout`));
    const err = fs.createWriteStream(path.join(outDir, `cycle${i}.stderr`));
    child.stdout.pipe(out); child.stderr.pipe(err);
    const killer = setTimeout(() => child.kill("SIGKILL"), (c.timeoutS ?? 90) * 1000);
    child.on("close", (code, signal) => {
      clearTimeout(killer);
      const lines = fs.readFileSync(path.join(outDir, `cycle${i}.stdout`), "utf8").split("\n").filter(Boolean);
      let sid = null;
      for (const l of lines) { try { const e = JSON.parse(l); if (e.session_id) sid = e.session_id; } catch {} }
      if (sid) fs.writeFileSync(path.join(outDir, `cycle${i}.sid`), sid);
      const meta = { i, label: c.label, args, code, signal, ms: Date.now() - t0, lines: lines.length, sid };
      fs.writeFileSync(path.join(outDir, `cycle${i}.meta.json`), JSON.stringify(meta, null, 1));
      log("cycles.jsonl", meta);
      resolve(meta);
    });
  });
}

server.listen(0, "127.0.0.1", async () => {
  const port = server.address().port;
  for (let i = 0; i < plan.cycles.length; i++) {
    const c = plan.cycles[i];
    for (const [f, content] of Object.entries(c.files ?? {})) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, typeof content === "string" ? content : JSON.stringify(content, null, 1));
    }
    for (const f of c.remove ?? []) fs.rmSync(f, { force: true });
    fs.mkdirSync(c.home, { recursive: true }); if (!fs.existsSync(c.config)) fs.mkdirSync(c.config, { recursive: true }); fs.mkdirSync(c.cwd, { recursive: true });
    globalThis.__longctxSent = false;
    const meta = await runCli(port, c, i);
    console.log(JSON.stringify(meta));
    await new Promise((r) => setTimeout(r, c.afterMs ?? 2500)); // let the OTLP batch land
  }
  server.close();
  process.exit(0);
});
