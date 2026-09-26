#!/usr/bin/env node
// Where this install's runs spend their window: main loop against sub-agents,
// by model, by sub-agent type, and whether each sub-agent ever wrote anything.
//
//   node proposals/LocalModelOffload/scripts/window-share.mjs [projectsDir] [dirRegex] [--json]
//
// Defaults: ~/.claude/projects and /^-workspace--uf-worktrees-/, which selects
// transcripts of runs that had a worktree of their own. A run with isolation
// off writes under its folder's own directory, next to anything else that ran
// there, so it is left out rather than guessed at.
//
// The weight is API list price including cache multipliers, copied from
// src/lib/pricing.ts. That is the proxy the vault's Local Offload Economics
// uses; the subscription formula is unpublished, so a share here is a share of
// list-price weight and not of the five-hour window.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2).filter((a) => a !== "--json");
const asJson = process.argv.includes("--json");
const ROOT = args[0] ?? join(homedir(), ".claude", "projects");
const DIR_RE = new RegExp(args[1] ?? "^-workspace--uf-worktrees-");

// src/lib/pricing.ts:28-30 (multipliers) and :63-103 (per-MTok rates).
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2.0;
const PRICES = [
  ["claude-fable-5-1", 10, 50, 0.025],
  ["claude-fable-5", 10, 50, 0.1],
  ["claude-opus-5-5", 4, 20, 0.05],
  ["claude-opus-5", 5, 25, 0.1],
  ["claude-opus-4", 5, 25, 0.1],
  ["claude-sonnet", 2, 10, 0.1],
  ["claude-haiku", 1, 5, 0.1],
];
const priceOf = (model) => PRICES.find(([p]) => model.startsWith(p));

// What a tool call does, for the "did this sub-agent only read" question.
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead", "WebFetch", "WebSearch", "TodoWrite", "ToolSearch"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_BASH = /^\s*(cd\s+\S+\s*&&\s*)?(cat|sed -n|head|tail|grep|rg|find|ls|wc|awk|git (log|show|diff|status|grep|ls-files|ls-tree|blame|rev-parse|branch)|nl|file|stat|du|tree|jq)\b/;

function classifyTool(block) {
  const name = block.name;
  if (WRITE_TOOLS.has(name)) return "write";
  if (READ_TOOLS.has(name)) return "read";
  if (name === "Bash") return READ_BASH.test(block.input?.command ?? "") ? "read" : "bash";
  if (name === "Agent" || name === "Task") return "agent";
  if (name.startsWith("mcp__")) return "mcp";
  return "other";
}

function weigh(usage, model) {
  const p = priceOf(model);
  if (!p) return null;
  const [, input, output, cacheRead] = p;
  const cc = usage.cache_creation ?? {};
  const w5 = cc.ephemeral_5m_input_tokens ?? 0;
  const w1 = cc.ephemeral_1h_input_tokens ?? 0;
  // Anything not split by TTL is priced at the 5m floor, as costOf does.
  const wRest = Math.max(0, (usage.cache_creation_input_tokens ?? 0) - w5 - w1);
  return (
    ((usage.input_tokens ?? 0) * input +
      (w5 + wRest) * input * CACHE_WRITE_5M +
      w1 * input * CACHE_WRITE_1H +
      (usage.cache_read_input_tokens ?? 0) * input * cacheRead +
      (usage.output_tokens ?? 0) * output) /
    1e6
  );
}

// One transcript file → its requests, deduplicated by request id, since every
// content block of one response is its own line carrying the same usage.
function readRequests(file) {
  const seen = new Map();
  const tools = [];
  let first = null, last = null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.timestamp) {
      if (!first || e.timestamp < first) first = e.timestamp;
      if (!last || e.timestamp > last) last = e.timestamp;
    }
    if (e.type !== "assistant" || !e.message?.usage) continue;
    const key = e.requestId ?? e.message.id;
    if (!seen.has(key)) seen.set(key, { model: e.message.model ?? "", usage: e.message.usage, sidechain: !!e.isSidechain, tools: [] });
    for (const c of e.message.content ?? []) {
      if (c.type !== "tool_use") continue;
      const kind = classifyTool(c);
      tools.push(kind);
      seen.get(key).tools.push(kind);
    }
  }
  return { requests: [...seen.values()], tools, first, last };
}

const totals = {
  weight: 0, unpriced: 0, requests: 0,
  main: 0, subagent: 0,
  byModel: {}, byAgentType: {}, byKind: { readOnly: 0, readAndBash: 0, wrote: 0 },
  mainByTool: {}, mainByStep: {}, mainContexts: [], mainToolTurns: 0, mainCacheRead: 0, mainReadStepCacheRead: 0, mainReadStepWeight: 0, mainMultiToolTurns: 0, mainMultiReadTurns: 0, subagents: [], sessions: 0, dirs: 0, first: null, last: null,
};
const add = (obj, k, v) => { obj[k] = (obj[k] ?? 0) + v; };
const span = (f, l) => {
  if (f && (!totals.first || f < totals.first)) totals.first = f;
  if (l && (!totals.last || l > totals.last)) totals.last = l;
};

// byStep: a request's weight goes to what that step did, split evenly across
// its tool calls, "text" when it called none -- the vault's attribution.
function tally(requests, bucket, agentType, byStep) {
  let w = 0, fresh = 0, out = 0, peak = 0;
  for (const r of requests) {
    const x = weigh(r.usage, r.model);
    if (x === null) { totals.unpriced++; continue; }
    totals.requests++;
    w += x;
    if (byStep) {
      if (!r.tools.length) add(byStep, "text", x);
      else for (const t of r.tools) add(byStep, t, x / r.tools.length);
    }
    fresh += (r.usage.input_tokens ?? 0) + (r.usage.cache_creation_input_tokens ?? 0);
    out += r.usage.output_tokens ?? 0;
    if (bucket === "main") {
      const [, input, , cacheRead] = priceOf(r.model);
      totals.mainCacheRead += ((r.usage.cache_read_input_tokens ?? 0) * input * cacheRead) / 1e6;
      if (r.tools.some((t) => t === "read")) totals.mainReadStepCacheRead += ((r.usage.cache_read_input_tokens ?? 0) * input * cacheRead) / 1e6;
      if (r.tools.some((t) => t === "read")) totals.mainReadStepWeight += x;
    }
    if (bucket === "main" && r.tools.length) { totals.mainToolTurns++; if (r.tools.length > 1) totals.mainMultiToolTurns++; if (r.tools.filter((t) => t === "read").length > 1) totals.mainMultiReadTurns++; }
    if (bucket === "main") totals.mainContexts.push((r.usage.input_tokens ?? 0) + (r.usage.cache_creation_input_tokens ?? 0) + (r.usage.cache_read_input_tokens ?? 0));
    peak = Math.max(peak, (r.usage.input_tokens ?? 0) + (r.usage.cache_creation_input_tokens ?? 0) + (r.usage.cache_read_input_tokens ?? 0));
    add(totals.byModel, r.model, x);
    if (agentType) add(totals.byAgentType, agentType, x);
  }
  totals.weight += w;
  totals[bucket] += w;
  return { w, fresh, out, peak, n: requests.length };
}

for (const dir of readdirSync(ROOT).filter((d) => DIR_RE.test(d) && statSync(join(ROOT, d)).isDirectory())) {
  totals.dirs++;
  const base = join(ROOT, dir);
  for (const f of readdirSync(base).filter((f) => f.endsWith(".jsonl"))) {
    totals.sessions++;
    const main = readRequests(join(base, f));
    span(main.first, main.last);
    // Older CLIs wrote a sub-agent's turns inline, marked isSidechain.
    tally(main.requests.filter((r) => !r.sidechain), "main", undefined, totals.mainByStep);
    tally(main.requests.filter((r) => r.sidechain), "subagent", "(inline sidechain)");
    for (const t of main.tools) add(totals.mainByTool, t, 1);

    const subDir = join(base, f.replace(/\.jsonl$/, ""), "subagents");
    if (!existsSync(subDir) || !statSync(subDir).isDirectory()) continue;
    // Recursive: a workflow's sub-agents sit one level down, under
    // subagents/workflows/<run id>/, and are a third of the vault's figure.
    for (const s of readdirSync(subDir, { recursive: true }).filter((s) => s.endsWith(".jsonl"))) {
      const metaFile = join(subDir, s.replace(/\.jsonl$/, ".meta.json"));
      const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, "utf8")) : {};
      const sub = readRequests(join(subDir, s));
      span(sub.first, sub.last);
      const type = meta.agentType ?? "(unknown)";
      const t = tally(sub.requests, "subagent", type);
      const kind = sub.tools.includes("write") ? "wrote" : sub.tools.includes("bash") || sub.tools.includes("mcp") || sub.tools.includes("agent") ? "readAndBash" : "readOnly";
      totals.byKind[kind] += t.w;
      totals.subagents.push({ type, kind, weight: t.w, requests: t.n, freshTokens: t.fresh, outputTokens: t.out, peakContext: t.peak, toolCalls: sub.tools.length });
    }
  }
}

const pct = (x) => (totals.weight ? ((100 * x) / totals.weight).toFixed(1) + "%" : "n/a");
const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const subs = totals.subagents;
const dist = (key, filter = () => true) => {
  const xs = subs.filter(filter).map((s) => s[key]);
  return { n: xs.length, p25: quantile(xs, 0.25), p50: quantile(xs, 0.5), p75: quantile(xs, 0.75), p90: quantile(xs, 0.9) };
};

const report = {
  projectsDir: ROOT, dirRegex: String(DIR_RE), dirs: totals.dirs, sessions: totals.sessions,
  window: [totals.first, totals.last], pricedRequests: totals.requests, unpricedRequests: totals.unpriced,
  listPriceUSD: +totals.weight.toFixed(2),
  share: { main: pct(totals.main), subagent: pct(totals.subagent) },
  subagentShareByKind: Object.fromEntries(Object.entries(totals.byKind).map(([k, v]) => [k, pct(v)])),
  subagentShareByType: Object.fromEntries(Object.entries(totals.byAgentType).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, pct(v)])),
  shareByModel: Object.fromEntries(Object.entries(totals.byModel).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, pct(v)])),
  mainLoopToolCallCounts: Object.fromEntries(Object.entries(totals.mainByTool).sort((a, b) => b[1] - a[1])),
  mainLoopWeightByStep: Object.fromEntries(Object.entries(totals.mainByStep).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, pct(v)])),
  // The prefix every main-loop request re-reads: what one avoided turn saves.
  mainLoopContextPerRequest: { p25: quantile(totals.mainContexts, 0.25), p50: quantile(totals.mainContexts, 0.5), p75: quantile(totals.mainContexts, 0.75), p90: quantile(totals.mainContexts, 0.9) },
  // How often the main loop already batches: a turn with several tool calls
  // pays for one prefix re-read, which is what a delegated call would save.
  mainLoopToolTurns: { withTools: totals.mainToolTurns, withSeveral: totals.mainMultiToolTurns, withSeveralReads: totals.mainMultiReadTurns },
  // How much of the main loop is re-reading its cached prefix, overall and in
  // the requests that emitted a read: the bytes a local reader would not touch.
  mainLoopCacheReadShare: { ofMainLoop: pct(totals.mainCacheRead * totals.weight / Math.max(totals.main, 1e-9)), ofReadSteps: pct(totals.mainReadStepCacheRead * totals.weight / Math.max(totals.mainReadStepWeight, 1e-9)) },
  subagentCount: subs.length,
  meanReadOnlySubagentUSD: +(totals.byKind.readOnly / Math.max(1, subs.filter((s) => s.kind === "readOnly").length)).toFixed(2),
  subagentCountByKind: { readOnly: subs.filter((s) => s.kind === "readOnly").length, readAndBash: subs.filter((s) => s.kind === "readAndBash").length, wrote: subs.filter((s) => s.kind === "wrote").length },
  // freshTokens (uncached input + cache writes) is what a local server with a
  // working prefix cache would have to prefill; outputTokens is what it decodes.
  perSubagent: {
    requests: dist("requests"),
    freshTokens: dist("freshTokens"),
    outputTokens: dist("outputTokens"),
    freshTokensReadOnly: dist("freshTokens", (s) => s.kind === "readOnly"),
    outputTokensReadOnly: dist("outputTokens", (s) => s.kind === "readOnly"),
    // The largest single request: the window a local server would have to hold.
    peakContext: dist("peakContext"),
    peakContextReadOnly: dist("peakContext", (s) => s.kind === "readOnly"),
  },
};

if (asJson) console.log(JSON.stringify(report, null, 2));
else for (const [k, v] of Object.entries(report)) console.log(`${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
