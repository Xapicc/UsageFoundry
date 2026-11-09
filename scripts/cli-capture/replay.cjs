// Replays cycles drive.mjs captured (stdout bytes, stderr bytes, exit code)
// through this app's own run loop, by stubbing `spawn` the way
// src/lib/resumeMissingTranscript.test.ts does, and prints each run's ending
// and log. <capture-root> holds the e1..e8 directories plans.mjs names.
//   npx tsc -p tsconfig.test.json --outDir .test-build/capture --incremental false
//   node scripts/cli-capture/replay.cjs <capture-root> $PWD/.test-build/capture <scenario>
// Scenarios: deferred, startup-resumed, startup-fresh, config-file, longctx,
// multicycle, bg,
// and two that are not loops: otlp (every captured /v1/logs body through
// parseLogsPayload) and parsers (every stdout line through readChatEvent, and
// the captured transcripts through readCompactions and compactionNotice).
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");

const [root, build, scenario] = process.argv.slice(2);
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-e4e2-replay-")));
fs.mkdirSync(path.join(tmp, "workspace", "project"), { recursive: true });
process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");
process.env.WORKSPACE_ROOT = path.join(tmp, "workspace");
delete process.env.WORKSPACE_ROOTS;
process.env.CLAUDE_BIN = path.join(tmp, "no-such-claude");

const L = (m) => require(path.join(build, "lib", m));
const config = L("config.js");
const { createRun, getRun, reopenRun, runEvents } = L("orchestrator.js");

// A populated projects tree, so a resume is checked against a real listing.
const projectDir = path.join(config.PROJECTS_DIR, "-workspace-project");
fs.mkdirSync(projectDir, { recursive: true });
fs.writeFileSync(path.join(projectDir, "unrelated-session.jsonl"), "");
const keepTranscript = (sid) => fs.writeFileSync(path.join(projectDir, `${sid}.jsonl`), "");

const cap = (exp, i) => ({
  label: `${exp}/cycle${i}`,
  stdout: fs.readFileSync(path.join(root, exp, `cycle${i}.stdout`)),
  stderr: fs.readFileSync(path.join(root, exp, `cycle${i}.stderr`)),
  code: JSON.parse(fs.readFileSync(path.join(root, exp, `cycle${i}.meta.json`), "utf8")).code,
});

let replies = [];
const spawns = [];
const cp = require("node:child_process");
const realSpawn = cp.spawn;
cp.spawn = (bin, args, options) => {
  if (bin !== config.CLAUDE_BIN) return realSpawn(bin, args, options);
  const at = args.indexOf("--resume");
  const reply = replies.shift();
  spawns.push({ resumed: at >= 0 ? args[at + 1] : null, prompt: args[args.length - 1].slice(0, 80), replay: reply ? reply.label : "NONE-LEFT" });
  const stdout = new PassThrough(), stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdout, stderr, pid: undefined, kill: () => true });
  const r = reply ?? { stdout: Buffer.from(""), stderr: Buffer.from("replay: no capture left\n"), code: 1 };
  stdout.on("end", () => { child.emit("exit", r.code, null); child.emit("close", r.code, null); });
  setImmediate(() => {
    if (r.stderr.length) stderr.write(r.stderr);
    stderr.end();
    // Three chunks cut at arbitrary byte offsets, so line reassembly and
    // UTF-8 decoding across chunk edges are both exercised.
    const b = r.stdout, a1 = Math.floor(b.length / 3), a2 = Math.floor((2 * b.length) / 3) + 1;
    stdout.write(b.subarray(0, a1)); stdout.write(b.subarray(a1, a2)); stdout.write(b.subarray(a2));
    stdout.end();
  });
  return child;
};

async function settled(id) {
  for (let i = 0; i < 3000; i++) {
    const row = getRun(id);
    if (row.status !== "queued" && row.status !== "running") return row;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`run ${id} did not end`);
}

function report(tag, row) {
  const evs = runEvents(row.id).events;
  console.log(`--- ${tag}`);
  console.log(JSON.stringify({ status: row.status, ending_code: row.ending_code, stop_reason: row.stop_reason, iterations: row.iterations, session_id: row.session_id }, null, 1));
  for (const e of evs) {
    const p = e.payload ?? {};
    if (e.kind === "log") console.log(`  log${p.stream ? "/" + p.stream : ""}: ${String(p.message).slice(0, 260).replace(/\n/g, "⏎")}`);
    else if (e.kind === "status") console.log(`  status: ${JSON.stringify(p).slice(0, 200)}`);
    else if (e.kind === "result") console.log(`  result: ${JSON.stringify(p).slice(0, 260)}`);
    else console.log(`  ${e.kind}: ${JSON.stringify(p).slice(0, 160)}`);
  }
}

const base = { folder: "project", mountId: null, prompt: "do the thing", origin: "form" };

(async () => {
  try {
    if (scenario === "deferred") {
      keepTranscript(fs.readFileSync(path.join(root, "e4", "cycle0.sid"), "utf8").trim());
      replies = [cap("e4", 0), cap("e4", 1)];
      const run = createRun({ ...base, budget: { maxIterations: 6 } });
      report("segment 1: D1 defers (exit 0), D2 resumes without the server (exit 1)", await settled(run.id));
      replies = [cap("e4", 2)];
      assert.ok(reopenRun(run.id, { maxIterations: 8 }).ok);
      report("pick-up 1: D3, server still missing", await settled(run.id));
      replies = [cap("e4", 3), cap("e4", 4)];
      assert.ok(reopenRun(run.id, { maxIterations: 12 }).ok);
      report("pick-up 2: D4 server back, then D5 DONE", await settled(run.id));
    } else if (scenario === "startup-resumed") {
      replies = [cap("e1", 3)];
      const run = createRun({ ...base, budget: { maxIterations: 1 } });
      const first = await settled(run.id);
      report("segment 1: one DONE cycle", first);
      keepTranscript(first.session_id);
      replies = [cap("e5", 0), cap("e5", 0)];
      assert.ok(reopenRun(run.id, { maxIterations: 4 }).ok);
      report("pick-up: startup failure (missing --mcp-config file) twice", await settled(run.id));
    } else if (scenario === "startup-fresh") {
      replies = [cap("e5", 0)];
      report("fresh run: startup failure", await settled(createRun({ ...base, budget: { maxIterations: 3 } }).id));
      replies = [cap("e5", 1)];
      report("fresh run: --settings not found", await settled(createRun({ ...base, budget: { maxIterations: 3 } }).id));
    } else if (scenario === "config-file") {
      // e8: a good cycle, then the resume and a fresh start with a corrupt
      // `.claude.json`, which the CLI answers with a zero-turn result.
      replies = [cap("e8", 0)];
      const run = createRun({ ...base, budget: { maxIterations: 1 } });
      const first = await settled(run.id);
      report("segment 1: one DONE cycle", first);
      keepTranscript(first.session_id);
      replies = [cap("e8", 1), cap("e8", 1)];
      assert.ok(reopenRun(run.id, { maxIterations: 4 }).ok);
      const failed = await settled(run.id);
      report("pick-up: config_file_invalid result (a second capture queued, to show a retry)", failed);
      console.log(`session kept: ${failed.session_id === first.session_id}; spawns: ${spawns.length}`);
      replies = [cap("e8", 2)];
      report("fresh run: config_file_invalid result", await settled(createRun({ ...base, budget: { maxIterations: 3 } }).id));
    } else if (scenario === "longctx") {
      replies = [cap("e3", 5)];
      report("API key: long-context 429, exit 1", await settled(createRun({ ...base, budget: { maxIterations: 3 } }).id));
      replies = [cap("e3", 4), cap("e3", 2)];
      report("stored sign-in: long-context 429 then compaction, then DONE", await settled(createRun({ ...base, budget: { maxIterations: 3 } }).id));
    } else if (scenario === "bg") {
      replies = [cap("e7", 0), cap("e3", 0)];
      const row = await settled(createRun({ ...base, budget: { maxIterations: 3 } }).id);
      console.log(JSON.stringify({ status: row.status, ending_code: row.ending_code, iterations: row.iterations }));
      const { runTasks } = L("runTasks.js");
      const tasks = runTasks(runEvents(row.id).events);
      console.log("runTasks:", tasks.length, JSON.stringify(tasks.slice(0, 2)).slice(0, 700));
      console.log("states:", JSON.stringify(tasks.map((t) => t.status ?? t.state)));
      const taskRows = runEvents(row.id).events.filter((e) => /task_|background_tasks/.test(JSON.stringify(e.payload).slice(0, 200)));
      console.log("task rows:", taskRows.length, JSON.stringify(taskRows[0]).slice(0, 400));
    } else if (scenario === "otlp") {
      const { parseLogsPayload } = L("otlp.js");
      const names = {}, keys = new Set();
      let records = 0, rows = 0;
      for (const exp of ["e1", "e2", "e3", "e4", "e6"]) {
        const f = path.join(root, exp, "otlp.jsonl");
        if (!fs.existsSync(f)) continue;
        for (const l of fs.readFileSync(f, "utf8").split("\n").filter(Boolean)) {
          const p = JSON.parse(l);
          if (!p.url.startsWith("/v1/logs")) continue;
          for (const rl of p.body.resourceLogs ?? []) for (const sl of rl.scopeLogs ?? []) for (const r of sl.logRecords ?? []) {
            const a = Object.fromEntries((r.attributes ?? []).map((x) => [x.key, Object.values(x.value ?? {})[0]]));
            names[a["event.name"]] = (names[a["event.name"]] ?? 0) + 1;
            if (a["event.name"] !== "api_request") continue;
            records++;
            for (const k of Object.keys(a)) if (k.startsWith("anthropic.") || k === "effort") keys.add(`${k}=${a[k]}`);
          }
          rows += parseLogsPayload(p.body, Date.parse(p.t)).length;
        }
      }
      console.log(JSON.stringify({ eventNames: names, apiRequestRecords: records, parsedRows: rows, anthropicAndEffort: [...keys].sort() }, null, 1));
    } else if (scenario === "parsers") {
      const { newChatTurnAccumulator, readChatEvent } = L("chatStream.js");
      let lines = 0, unreadable = 0;
      for (const exp of ["e1", "e2", "e3", "e4", "e5", "e6", "e7"]) {
        const dir = path.join(root, exp);
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".stdout"))) {
          const acc = newChatTurnAccumulator();
          for (const l of fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean)) { lines++; readChatEvent(acc, l); }
          unreadable += acc.unreadable;
        }
      }
      console.log(JSON.stringify({ chatLines: lines, chatUnreadable: unreadable }));
      const { readCompactions } = L("transcripts.js");
      const { compactionNotice, injectionFates } = L("orchestrator.js");
      for (const [exp, cfg] of [["e1", "cfg"], ["e2", "c0"], ["e3", "c4"]]) {
        const src = path.join(root, exp, cfg, "projects");
        for (const d of fs.readdirSync(src)) {
          fs.mkdirSync(path.join(config.PROJECTS_DIR, d), { recursive: true });
          for (const f of fs.readdirSync(path.join(src, d)).filter((f) => f.endsWith(".jsonl"))) {
            fs.copyFileSync(path.join(src, d, f), path.join(config.PROJECTS_DIR, d, f));
            const found = await readCompactions(f.replace(/\.jsonl$/, ""), { from: 0, to: Date.now() });
            for (const b of found) console.log(JSON.stringify(b), "\n  ", compactionNotice(b, injectionFates(["-p"])).split("\n")[0]);
          }
        }
      }
    } else if (scenario === "multicycle") {
      replies = [cap("e1", 0), cap("e1", 1), cap("e1", 2), cap("e1", 3)];
      report("e1: bg task, resume, /compact, DONE", await settled(createRun({ ...base, budget: { maxIterations: 6 } }).id));
      replies = [cap("e2", 0), cap("e3", 0)];
      report("e2: auto compaction mid-cycle, then DONE", await settled(createRun({ ...base, budget: { maxIterations: 3 } }).id));
    }
    console.log("spawns:", JSON.stringify(spawns, null, 1));
  } catch (e) {
    console.log("DRIVER ERROR", e && e.stack);
  } finally {
    cp.spawn = realSpawn;
    fs.rmSync(tmp, { recursive: true, force: true });
    setTimeout(() => process.exit(0), 200);
  }
})();
