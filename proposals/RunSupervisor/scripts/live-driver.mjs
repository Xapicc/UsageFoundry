// Drives the pinned CLI with --input-format stream-json against stub-api.mjs and
// injects a second user message while the first turn is still in flight.
// Nothing is billed. Run through live-turn-probe.sh, which names the cases.
//
//   node live-driver.mjs <outdir> <case>
//
// Timeline of a case (all instants are logged to <outdir>/timeline.txt):
//   t0       spawn the CLI, write user message 1 on stdin
//   t1       the stub has answered request 0 (a Read of a FIFO, or a slow text
//            stream for the midstream case) -- the first turn is now "live"
//   t1+inject  write user message 2 ("INJECTED_MSG") on stdin
//   t2       release the FIFO so the Read returns (not for midstream)
//   then     watch stdout until quiet, test whether the process is still alive
//            with stdin open, then close stdin (EOF) and wait for the exit.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [outdir, caseName] = process.argv.slice(2);
const CASES = {
  // flags: extra CLI flags; inject: seconds after the stub answered request 0
  // before message 2 is written (null = never); release: seconds after that
  // before the FIFO is filled; quiet: seconds of stdout silence that end the watch
  base:         { flags: [], inject: 3, release: 6 },
  replay:       { flags: ["--replay-user-messages"], inject: 3, release: 6 },
  maxturns2:    { flags: ["--max-turns", "2"], inject: 3, release: 6 },
  budget:       { flags: ["--max-budget-usd", process.env.BUDGET ?? "0.02"], inject: 3, release: 6 },
  single:       { flags: [], inject: null, release: 3 },           // no injection: the baseline result figures
  eofduring:    { flags: [], inject: null, release: 8, eofAfterFirst: true }, // EOF while the tool is pending
  // late: seconds after the first `result` before message 2 is written (a plain
  // second turn on an idle process -- the baseline for per-turn vs cumulative figures)
  sequential:   { flags: ["--replay-user-messages"], inject: null, release: 3, late: 5 },
  sequentialnr: { flags: [], inject: null, release: 3, late: 5 },
  // midstream: the stub streams a text answer in two parts 20 s apart; message 2
  // goes in 6 s after the request ARRIVED, i.e. while the model is mid-stream.
  midstream:    { flags: ["--replay-user-messages"], inject: 6, release: null, scenario: "slowstream", liveWhen: "arrival" },
  // positional: the first message is the argv prompt (`-- "<prompt>"`, as the app
  // passes it today) and stdin carries only what is injected afterwards
  posprompt:    { flags: [], inject: 3, release: 6, positional: true },
  // a 75 s Read, to see whether a non-MCP tool is heartbeated on stdout too
  slowread:     { flags: [], inject: 10, release: 65 },
  // do --max-turns / --max-budget-usd bound the process or each user message?
  // The stub's request costs 0.005 (turn 1 = two requests = 0.01042 in total).
  maxturnsseq:  { flags: ["--max-turns", "2"], inject: null, release: 3, late: 5 },
  budgetseq:    { flags: ["--max-budget-usd", "0.012"], inject: null, release: 3, late: 5 },
};
const RESUME = process.env.RESUME_SESSION; // set to add --resume <id>
const c = CASES[caseName];
if (!c) { console.error("unknown case " + caseName + "; known: " + Object.keys(CASES).join(", ")); process.exit(2); }

// A --resume run reuses the previous run's config dir and cwd (the session file
// lives under CLAUDE_CONFIG_DIR/projects/<cwd>), so only the logs are cleared.
if (RESUME) {
  for (const f of ["api", "timeline.txt", "stdout.stamped", "stderr.txt", "cwd/pipe.fifo"]) fs.rmSync(path.join(outdir, f), { recursive: true, force: true });
} else {
  fs.rmSync(outdir, { recursive: true, force: true });
}
for (const d of ["cfg", "home", "cwd", "tmp", "api"]) fs.mkdirSync(path.join(outdir, d), { recursive: true });
const fifo = path.join(outdir, "cwd", "pipe.fifo");
execFileSync("mkfifo", [fifo]);
const t0 = Date.now();
const stamp = () => new Date().toISOString();
const timeline = (s) => { fs.appendFileSync(path.join(outdir, "timeline.txt"), `${stamp()} +${((Date.now() - t0) / 1000).toFixed(1)}s ${s}\n`); };

const scenario = c.scenario ?? "fifo";
const stub = spawn("node", [path.join(HERE, "stub-api.mjs"), path.join(outdir, "api"), scenario, `fifo=${fifo}`, "gap=20000"], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise((res) => stub.stdout.on("data", (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) res(m[1]); }));

const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-hook-events", ...c.flags];
if (RESUME) args.push("--resume", RESUME);
if (c.positional) args.push("--", "FIRST_MSG: please read the pipe");
const child = spawn("claude", args, {
  cwd: path.join(outdir, "cwd"),
  env: { HOME: path.join(outdir, "home"), PATH: process.env.PATH, TERM: "dumb", TMPDIR: path.join(outdir, "tmp"), CLAUDE_CONFIG_DIR: path.join(outdir, "cfg"),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: "sk-ant-fake", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_HARBOR_KITE: "0" },
  stdio: ["pipe", "pipe", "pipe"],
});
timeline("spawned claude " + args.join(" "));
let exited = null;
child.on("exit", (code, sig) => { exited = { code, sig, at: Date.now() }; timeline(`claude exited code=${code} signal=${sig}`); });
child.stderr.on("data", (d) => fs.appendFileSync(path.join(outdir, "stderr.txt"), d));

let lastOut = Date.now();
let buf = "";
let resultCount = 0;
child.stdout.on("data", (d) => {
  lastOut = Date.now();
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line) continue;
    fs.appendFileSync(path.join(outdir, "stdout.stamped"), `${stamp()} ${line}\n`);
    try { const j = JSON.parse(line); if (j.type === "result") resultCount += 1; timeline(`stdout ${j.type}/${j.subtype ?? ""}${j.type === "result" ? " total_cost_usd=" + j.total_cost_usd : ""}`); } catch { timeline("stdout (non-json) " + line.slice(0, 80)); }
  }
});

const userLine = (text) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stubLog = () => { try { return fs.readFileSync(path.join(outdir, "api", "requests.jsonl"), "utf8"); } catch { return ""; } };

if (!c.positional) {
  child.stdin.write(userLine("FIRST_MSG: please read the pipe"));
  timeline("wrote user message 1");
}
if (c.eofAfterFirst) { child.stdin.end(); timeline("closed stdin (EOF) right after message 1"); }

const liveRe = c.liveWhen === "arrival" ? /"isMain":true,"stream":true,"nTools":\d+,"step":0/ : /"step":0,"event":"response-finished"/;
for (let i = 0; i < 300 && !liveRe.test(stubLog()); i++) await sleep(100);
timeline(c.liveWhen === "arrival" ? "stub received request 0 (it will stream slowly)" : "stub finished answering request 0 (turn 1 is live: tool pending)");

if (c.inject !== null) {
  await sleep(c.inject * 1000);
  child.stdin.write(userLine("INJECTED_MSG: also say the word pineapple"));
  timeline("wrote user message 2 (INJECTED_MSG)");
}
if (c.release !== null) {
  await sleep(c.release * 1000);
  spawn("sh", ["-c", 'printf "FIFO-CONTENT-FROM-SUPERVISOR\\n" > "$1"', "sh", fifo], { stdio: "ignore" });
  timeline("released FIFO (Read can return)");
}

if (c.late != null) {
  for (let i = 0; i < 600 && resultCount < 1; i++) await sleep(100);
  await sleep(c.late * 1000);
  child.stdin.write(userLine("LATE_MSG: second turn, after the first result"));
  timeline("wrote user message 2 (LATE_MSG) after the first result");
}

// Watch until the CLI has been quiet for 20 s (or exited).
const quietMs = 20000;
while (!exited && Date.now() - lastOut < quietMs) await sleep(500);
if (!exited) {
  timeline(`stdin still open, no stdout for ${quietMs / 1000}s, process alive=${!exited}`);
  if (!c.eofAfterFirst) { child.stdin.end(); timeline("closed stdin (EOF)"); }
  const eofAt = Date.now();
  for (let i = 0; i < 400 && !exited; i++) await sleep(100);
  if (exited) timeline(`exit ${((exited.at - eofAt) / 1000).toFixed(1)}s after EOF`); else { timeline("still alive 40s after EOF; killing the child handle"); child.kill("SIGKILL"); }
} else {
  timeline("process exited on its own before the quiet window ended");
}
await sleep(300);
stub.kill();
process.exit(0);
