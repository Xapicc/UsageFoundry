// Per-session list-price cost of the vault's sessions, and the same tokens
// re-priced on claude-haiku-5-5, priced with the repo's own src/lib/pricing.ts
// (imported, not copied) the way transcripts.ts prices them: one deduplicated
// request at a time, basis "request", resolvePrice(model, {at, speed}).
// window-share.mjs in LocalModelOffload is not reused because its price table
// has one Haiku row at Haiku 4.5's rate and no prompt-length tier.
//
//   node --experimental-strip-types vault-cost.mjs [projectsDir] [dirRegex] [sinceISO] [out.json]
//
// The re-pricing assumes Haiku takes the same turns and tokens as the model
// that ran — the assumption 11-validation.md exists to test.
import { readdirSync, readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePrice, costOf, guardCostOf, promptTokensOf } from "../../../src/lib/pricing.ts";

const ROOT = process.argv[2] ?? "/home/node/.claude/projects";
const DIR_RE = new RegExp(process.argv[3] ?? "^-workspace2");
const SINCE = process.argv[4] ?? "2026-09-01";
const HAIKU = resolvePrice("claude-haiku-5-5");

// Same as transcripts.ts readTokens.
function readTokens(usage) {
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const cc = usage.cache_creation ?? {};
  const d5 = num(cc.ephemeral_5m_input_tokens), d1 = num(cc.ephemeral_1h_input_tokens);
  const total = num(usage.cache_creation_input_tokens);
  return {
    input: num(usage.input_tokens), output: num(usage.output_tokens), cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite5m: d5, cacheWrite1h: d1, cacheWriteUnattributed: Math.max(0, total - d5 - d1),
  };
}

function firstUserText(rec) {
  if (rec.type !== "user" || rec.isMeta || rec.isSidechain) return null;
  const c = rec.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    if (c.some((b) => b.type === "tool_result")) return null;
    const t = c.find((b) => b.type === "text");
    return t?.text ?? null;
  }
  return null;
}

function readFile(file, seen, out, isMain) {
  let first = null, firstUser = null, cwd = null, entrypoint = null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.startsWith("{")) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.timestamp && (!first || rec.timestamp < first)) first = rec.timestamp;
    if (!cwd && rec.cwd) cwd = rec.cwd;
    if (!entrypoint && rec.entrypoint) entrypoint = rec.entrypoint;
    if (isMain && !firstUser) {
      const t = firstUserText(rec);
      if (t && !t.startsWith("<command-") && !t.startsWith("<local-command")) firstUser = t;
    }
    if (rec.type !== "assistant" || !rec.message?.usage) continue;
    const m = rec.message;
    const key = m.id && rec.requestId ? `${m.id}:${rec.requestId}` : `uuid:${rec.uuid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const model = m.model ?? "unknown";
    if (model === "<synthetic>") continue;
    const ts = Date.parse(rec.timestamp);
    const speed = typeof m.usage.speed === "string" ? m.usage.speed : undefined;
    const tokens = readTokens(m.usage);
    const price = resolvePrice(model, { at: ts, speed });
    out.push({
      model, speed, ts, tokens, sub: !isMain,
      cost: costOf(tokens, price, "request"),
      guard: guardCostOf(tokens, price, "request"),
      priced: !!price,
      prompt: promptTokensOf(tokens),
      haiku: costOf(tokens, HAIKU, "request"),
      haikuFlatLow: costOf(tokens, { input: 0.1, output: 0.5 }, "request"),
    });
  }
  return { first, firstUser, cwd, entrypoint };
}

const q = (xs, f) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(f * s.length))];
};

const sessions = [];
for (const dir of readdirSync(ROOT).filter((d) => DIR_RE.test(d))) {
  const base = join(ROOT, dir);
  for (const f of readdirSync(base).filter((f) => f.endsWith(".jsonl"))) {
    const seen = new Set();
    const reqs = [];
    const head = readFile(join(base, f), seen, reqs, true);
    let subFiles = 0;
    const subDir = join(base, f.replace(/\.jsonl$/, ""), "subagents");
    if (existsSync(subDir) && statSync(subDir).isDirectory()) {
      for (const s of readdirSync(subDir, { recursive: true }).filter((s) => s.endsWith(".jsonl"))) {
        subFiles++;
        readFile(join(subDir, s), seen, reqs, false);
      }
    }
    if (!head.first || head.first < SINCE) continue;
    const sum = (k) => reqs.reduce((a, r) => a + r.tokens[k], 0);
    const prompts = reqs.map((r) => r.prompt);
    const models = {};
    for (const r of reqs) models[r.model + (r.speed && r.speed !== "standard" ? `(${r.speed})` : "")] = (models[r.model + (r.speed && r.speed !== "standard" ? `(${r.speed})` : "")] ?? 0) + 1;
    const lastTs = reqs.reduce((a, r) => Math.max(a, r.ts), 0);
    sessions.push({
      dir, session: f.replace(/\.jsonl$/, ""), first: head.first, last: lastTs ? new Date(lastTs).toISOString() : null,
      cwd: head.cwd, entrypoint: head.entrypoint, subagentFiles: subFiles,
      models, requests: reqs.length, mainRequests: reqs.filter((r) => !r.sub).length,
      unpriced: reqs.filter((r) => !r.priced).length,
      input: sum("input"), cacheWrite5m: sum("cacheWrite5m"), cacheWrite1h: sum("cacheWrite1h"), cacheWriteUnattributed: sum("cacheWriteUnattributed"),
      cacheCreation: sum("cacheWrite5m") + sum("cacheWrite1h") + sum("cacheWriteUnattributed"),
      cacheRead: sum("cacheRead"), output: sum("output"),
      costUSD: reqs.reduce((a, r) => a + r.cost, 0),
      guardUSD: reqs.reduce((a, r) => a + r.guard, 0),
      subCostUSD: reqs.filter((r) => r.sub).reduce((a, r) => a + r.cost, 0),
      haikuUSD: reqs.reduce((a, r) => a + r.haiku, 0),
      haikuIfAllShortUSD: reqs.reduce((a, r) => a + r.haikuFlatLow, 0),
      promptMax: Math.max(0, ...prompts), promptP50: q(prompts, 0.5), promptP90: q(prompts, 0.9),
      over100k: prompts.filter((p) => p > 100_000).length,
      haikuCostFromOver100k: reqs.filter((r) => r.prompt > 100_000).reduce((a, r) => a + r.haiku, 0),
      mainPromptMax: Math.max(0, ...reqs.filter((r) => !r.sub).map((r) => r.prompt)),
      subPromptMax: Math.max(0, ...reqs.filter((r) => r.sub).map((r) => r.prompt)),
      tier: Object.fromEntries(["short", "long"].map((t) => {
        const rs = reqs.filter((r) => (t === "long") === (r.prompt > 100_000));
        const add = (k) => rs.reduce((a, r) => a + r.tokens[k], 0);
        return [t, { n: rs.length, input: add("input"), cw5m: add("cacheWrite5m"), cw1h: add("cacheWrite1h"), cwUn: add("cacheWriteUnattributed"), cr: add("cacheRead"), out: add("output"), haikuUSD: rs.reduce((a, r) => a + r.haiku, 0), actualUSD: rs.reduce((a, r) => a + r.cost, 0) }];
      })),
      firstUser: (head.firstUser ?? "").replace(/\s+/g, " ").slice(0, 400),
    });
  }
}
sessions.sort((a, b) => a.first.localeCompare(b.first));
if (process.argv[5]) writeFileSync(process.argv[5], JSON.stringify(sessions, null, 1));
for (const s of sessions) {
  console.log([s.first.slice(0, 16), s.session.slice(0, 8), s.dir === "-workspace2" ? "" : s.dir, Object.entries(s.models).map(([k, v]) => `${k}:${v}`).join(","), `req=${s.requests}(main ${s.mainRequests}, subfiles ${s.subagentFiles})`,
    `in=${s.input} cw=${s.cacheCreation}(5m ${s.cacheWrite5m}/1h ${s.cacheWrite1h}/un ${s.cacheWriteUnattributed}) cr=${s.cacheRead} out=${s.output}`,
    `$${s.costUSD.toFixed(2)} (sub $${s.subCostUSD.toFixed(2)})`, `prompt max=${s.promptMax} p50=${s.promptP50} p90=${s.promptP90}`,
    `>100k=${s.over100k}/${s.requests}`, `haiku=$${s.haikuUSD.toFixed(2)} (allShort $${s.haikuIfAllShortUSD.toFixed(2)})`, `unpriced=${s.unpriced}`].join(" | "));
}
