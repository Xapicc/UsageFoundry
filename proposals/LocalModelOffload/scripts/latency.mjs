#!/usr/bin/env node
// Per-call wall clock of a local call in each loop shape, from the vault's
// prefill and decode figures. Arithmetic, not a measurement: nothing here ran
// on the operator's machine, which is not visible from this container.
//
//   node proposals/LocalModelOffload/scripts/latency.mjs [--json]
//
// Every constant names the vault note it comes from and that note's grade.
// Prefill rates are a 32k fill's average, which *understates* the rate for a
// short prompt (prefill slows with depth), so short-prompt rows err slow.

// "Local Decode and Prefill Speed" (confidence: medium; the TTFT rows are
// `blog`, the maintainer's gpt-oss-20b runs): seconds to prefill 32k tokens.
const PREFILL_32K_SECONDS = {
  "M3 Ultra": 24,
  "M2 Ultra": 27,
  "M4 Max 36 GB": 58,
  "RTX 4090": 6.4,
};
// Same note: "M3 Ultra, MLX, dense 32B at Q4: 121 s" against gpt-oss-20b's 24 s
// on the same chip (`anecdote`). Used as the dense-model slowdown everywhere,
// which is an assumption the vault does not make.
const DENSE_PREFILL_FACTOR = 121 / 24;

// Decode, tokens per second. Dense 27B at Q4_K_M is the vault's *prediction*
// (bound x typical efficiency) in "Local Decode and Prefill Speed"; the sparse
// figures are measurements in "Sparse Models on Local Hardware" (Qwen3-30B-A3B
// 113 tok/s on a 64 GB M4 Max under MLX; gpt-oss-20b 130 tok/s on M2 Ultra).
// Sparse on M3 Ultra and RTX 4090 are not in the vault and are left out.
const PROFILES = [
  { name: "M4 Max, sparse ~3B active", hw: "M4 Max 36 GB", dense: false, decode: 113 },
  { name: "M2 Ultra, sparse ~3B active", hw: "M2 Ultra", dense: false, decode: 130 },
  { name: "M4 Max, dense 27B", hw: "M4 Max 36 GB", dense: true, decode: 21.5 },
  { name: "M3 Ultra, dense 27B", hw: "M3 Ultra", dense: true, decode: 25 },
  { name: "RTX 4090, dense 27B", hw: "RTX 4090", dense: true, decode: 40 },
];

const prefillRate = (p) => (32768 / PREFILL_32K_SECONDS[p.hw]) / (p.dense ? DENSE_PREFILL_FACTOR : 1);

// A call is a first prompt, then `turns` tool turns that each append `result`
// tokens and emit `step` tokens, then a final answer. With the prefix reused
// (every runtime in "Choosing a Local Inference Runtime" does this by default,
// one slot), a turn prefills only what is new.
function seconds(p, shape) {
  const prefillTokens = shape.first + shape.turns * (shape.result + shape.step);
  const decodeTokens = shape.turns * shape.step + shape.answer;
  const peak = prefillTokens + shape.answer;
  return {
    prefill: prefillTokens / prefillRate(p),
    decode: decodeTokens / p.decode,
    total: prefillTokens / prefillRate(p) + decodeTokens / p.decode,
    peak,
  };
}

// The first prompt sizes are the load-bearing numbers:
//  - one-shot: an instruction plus the material, nothing else (vault step 4).
//  - minimal loop: a ~1.5k system prompt and four tool schemas, assumed, since
//    nothing is built; the brief is ~500 tokens.
//  - Claude Code: 16.7k observed in "Plumbing Check of Claude Code Against
//    llama-server"; 12k-70k reported in "What Breaks When Claude Code Runs on
//    a Local Model". 45k is a mid-range reported value.
//  - Aider: ~0.5-1.5k plus a repository map ("Agent Harnesses for Local
//    Models"); the 1k map is Aider's default budget, assumed.
//  - OpenCode ~6k, same note.
//  - measured: the median read-only sub-agent in this install's worktree runs
//    (scripts/window-share.mjs): 84,166 fresh tokens, 3,483 output. Replayed
//    as if prefilled once with perfect reuse, so it is a floor.
const READ_JOB = { turns: 6, result: 2000, step: 150, answer: 800 };
const SHAPES = [
  { name: "one-shot summarise, 8k of material", first: 8300, turns: 0, result: 0, step: 0, answer: 400 },
  { name: "minimal loop, 6 reads", first: 2500, ...READ_JOB },
  { name: "Aider-sized harness, 6 reads", first: 3000, ...READ_JOB },
  { name: "OpenCode-sized harness, 6 reads", first: 6500, ...READ_JOB },
  { name: "Claude Code 16.7k, 6 reads", first: 17200, ...READ_JOB },
  { name: "Claude Code 45k, 6 reads", first: 45500, ...READ_JOB },
  { name: "this install's median read-only sub-agent", first: 84166, turns: 0, result: 0, step: 0, answer: 3483 },
];

// Contention: one server, one slot ("Recommended Local and Claude Hybrid
// Setup" step 3, `-np 1`). Calls queue; the n-th of n simultaneous calls waits
// for the n-1 before it.
const queued = (t, n) => n * t;

const rows = [];
for (const s of SHAPES) {
  for (const p of PROFILES) {
    const r = seconds(p, s);
    rows.push({ shape: s.name, profile: p.name, peakTokens: r.peak, prefillS: Math.round(r.prefill), decodeS: Math.round(r.decode), totalS: Math.round(r.total), thirdOfThreeS: Math.round(queued(r.total, 3)) });
  }
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ denseFactor: DENSE_PREFILL_FACTOR, rows }, null, 2));
} else {
  console.log(`dense prefill factor (anecdote): ${DENSE_PREFILL_FACTOR.toFixed(2)}`);
  console.log("| shape | profile | peak tokens | prefill s | decode s | total s | 3rd of 3 queued s |");
  console.log("|---|---|---:|---:|---:|---:|---:|");
  for (const r of rows) console.log(`| ${r.shape} | ${r.profile} | ${r.peakTokens} | ${r.prefillS} | ${r.decodeS} | ${r.totalS} | ${r.thirdOfThreeS} |`);
}
