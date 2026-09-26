#!/usr/bin/env node
// What one delegated read job costs the *calling* session, in list-price
// weight, three ways: the main loop reads the files itself, it hands the job
// to a local agent, or it hands it to a Claude sub-agent. A model of the
// frontier side only. It is not a measured saving -- the vault's seed "Does a
// Local Sub-Agent Cost the Main Loop More Than It Saves" is exactly the
// measurement nobody has made -- and every input below is either measured by
// window-share.mjs or labelled as assumed.
//
//   node proposals/LocalModelOffload/scripts/delegation-cost.mjs [--json]

// claude-opus-5, which carried ~90% of run weight (window-share.mjs);
// src/lib/pricing.ts:80 and :28-30 -- $5 in, $25 out, 0.10x read, 2.00x 1h write.
const P = { input: 5, output: 25, cacheRead: 0.1, cacheWrite: 2.0 };
const usd = (t, rate) => (t * rate) / 1e6;
const read = (t) => usd(t, P.input * P.cacheRead);
const write = (t) => usd(t, P.input * P.cacheWrite);
const out = (t) => usd(t, P.output);

// Measured (window-share.mjs, 2026-09-26): median main-loop request context
// 116,217 tokens; mean read-only sub-agent $1.47.
const C = 116_217;
const SUBAGENT_USD = 1.47;

// Assumed: the job is k reads of r tokens each, the main loop spends o tokens
// per tool call, the local answer is a tokens, the brief b tokens, and the
// appended material then rides N more main-loop turns before the cycle ends.
const k = 6, r = 2_000, o = 120, a = 800, b = 300;

function self(N) {
  let cost = 0;
  for (let i = 0; i < k; i++) cost += read(C + i * r) + write(r) + out(o);
  return cost + N * read(k * r);
}
// One turn to brief the tool, the answer appended and carried.
const delegated = (N) => read(C) + out(b) + write(a) + N * read(a);
// v of the k reads redone by the main loop to check the answer.
function verified(N, v) {
  let cost = delegated(N);
  const redo = Math.round(v * k);
  for (let i = 0; i < redo; i++) cost += read(C + a + i * r) + write(r) + out(o);
  return cost + N * read(redo * r);
}

const rows = [];
for (const N of [10, 30, 60]) {
  const s = self(N), d = delegated(N), dv = verified(N, 1 / 3), fail = d + self(N);
  // Break-even local pass rate p, where failures are caught and redone in
  // full: p*(s - dv) = (1-p)*(fail - s)  =>  p = (fail - s) / ((fail - s) + (s - dv)).
  const pBreakEven = (fail - s) / (fail - s + (s - dv));
  rows.push({
    turnsAfter: N,
    selfUSD: +s.toFixed(3),
    localUSD: +d.toFixed(3),
    localVerifiedThirdUSD: +dv.toFixed(3),
    localFailedRedoneUSD: +fail.toFixed(3),
    claudeSubagentUSD: +(d + SUBAGENT_USD).toFixed(3),
    breakEvenPassRate: +pBreakEven.toFixed(2),
  });
}

if (process.argv.includes("--json")) console.log(JSON.stringify({ C, k, r, rows }, null, 2));
else {
  console.log(`main-loop context C=${C} (measured median), job k=${k} reads of r=${r} tokens (assumed)`);
  console.log("| turns after N | main loop reads itself | local, trusted | local, a third re-read | local failed, redone | Claude sub-agent (mean $1.47) | break-even local pass rate |");
  console.log("|---:|---:|---:|---:|---:|---:|---:|");
  for (const x of rows) console.log(`| ${x.turnsAfter} | $${x.selfUSD} | $${x.localUSD} | $${x.localVerifiedThirdUSD} | $${x.localFailedRedoneUSD} | $${x.claudeSubagentUSD} | ${x.breakEvenPassRate} |`);
}
