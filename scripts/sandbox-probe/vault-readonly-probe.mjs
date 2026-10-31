#!/usr/bin/env node
// Is the knowledge vault read-only to a run that is not working on it, and still
// writable to one that is? (docs/agent/security/vault-write-boundary.md.)
//
// Run it as the agents' uid inside a booted container with UF_SANDBOX=1. It
// touches no real vault — everything it reads and writes is a scratch directory
// it makes under os.tmpdir():
//
//   docker compose cp scripts/sandbox-probe/vault-readonly-probe.mjs usagefoundry:/tmp/vault-readonly-probe.mjs
//   docker compose exec -u 1000:1000 usagefoundry node /tmp/vault-readonly-probe.mjs
//
// A stub API drives the real CLI through the tool calls a reader that ignored its
// skill would make, with the vault flags `buildArgs` emits (asserted in
// `orchestrator.test.ts`): `--add-dir <vault>`, an `Edit(//<vault>/**)` deny on
// `--disallowedTools`, and `denyWrite: [<vault>]` beside the write set in the
// `--settings` overlay. The scratch vault's name has a space in it, as the
// operator's does. Four turns: a reader with the argv it had before the deny,
// whose writes must land; the reader under `acceptEdits`; the same reader under
// `bypassPermissions`; and a run in a worktree under the vault's own
// `.uf-worktrees/`, given the writable argv, which must still write. Every write
// is judged by the file afterwards, never by what the tool said.
//
// Exit 0: the reader read the vault and searched it, every write into it failed
// — Write, Edit, NotebookEdit, and through Bash `touch`, `>`, `sed -i` and a
// Python `open` — and the controls, the reader with no deny and the vault run
// wrote.
// Exit 1: a write into the vault succeeded, a read failed, or a control did not
// write.
// Exit 2: nothing that was measured failed, but some Bash step never was: the
// CLI's sandbox did not start for it, and a write refused by a sandbox that
// never started proves nothing. Nested inside an agent's own sandbox bwrap
// starts only when its child lands on a pid that sandbox's /proc shows, so each
// Bash call that dies at `bwrap:` is asked again, up to PROBE_BASH_ATTEMPTS —
// and since every attempt spends pids and only low ones can coincide, a nested
// run is best done one step at a time: PROBE_ONLY=<label> keeps only the step
// with that label, as printed, and PROBE_TURN=<label> only that turn, so each
// can start in a fresh pid namespace.
// PROBE_BWRAP_ARGV=1 also shows what the CLI asked bwrap to do with the vault,
// by logging each bwrap argv through a shim on PATH.
// PROBE_DEBUG=1 logs every tool result; PROBE_TURN_TIMEOUT_MS bounds a turn.

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const TURN_TIMEOUT_MS = Number(process.env.PROBE_TURN_TIMEOUT_MS ?? 300_000);
const BASH_ATTEMPTS = Number(process.env.PROBE_BASH_ATTEMPTS ?? 6);
const ONLY = process.env.PROBE_ONLY ?? "";
const TURN = process.env.PROBE_TURN ?? "";
// What a Bash result says when bwrap itself failed, before the command ran.
const SANDBOX_DID_NOT_START = /^Exit code \d+\s+bwrap: /;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "uf-vault-ro-probe-"));
const vault = path.join(scratch, "Knowledge Vault");
const work = path.join(scratch, "work");
const vaultWorktree = path.join(vault, ".uf-worktrees", "Knowledge Vault-1");
const home = path.join(scratch, "home");
const configDir = path.join(home, ".claude");
const tmp = path.join(scratch, "tmp");
const shimDir = path.join(scratch, "shim");
for (const dir of [path.join(vault, "_Meta"), work, vaultWorktree, configDir, tmp, shimDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

const NOTE_BODY = "VAULT-NOTE-BODY";
function plantVault() {
  for (const f of ["new.md", "touched", "redirected", "opened"]) fs.rmSync(path.join(vault, f), { force: true });
  fs.writeFileSync(path.join(vault, "note.md"), `---\nconfidence: high\n---\n${NOTE_BODY}\n`);
  fs.writeFileSync(
    path.join(vault, "n.ipynb"),
    JSON.stringify({ cells: [{ cell_type: "code", id: "c1", metadata: {}, source: ["1"], outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 }),
  );
  // A search shaped like the real one: a script that imports a sibling module,
  // so that the one write the real script makes — that module's bytecode — is
  // the one this one would make too.
  fs.writeFileSync(path.join(vault, "_Meta", "vaultlib.py"), "HIT = 'note.md'\n");
  fs.writeFileSync(
    path.join(vault, "_Meta", "vault_search.py"),
    "import json, sys\nfrom pathlib import Path\nsys.path.insert(0, str(Path(__file__).resolve().parent))\n" +
      "from vaultlib import HIT\nprint(json.dumps({'hits': [{'path': HIT}]}))\n",
  );
  fs.rmSync(path.join(vault, "_Meta", "__pycache__"), { recursive: true, force: true });
}

const q = (p) => `'${p.replaceAll("'", "'\\''")}'`;
const inVault = (f) => path.join(vault, f);

// Each step is one tool call and the check that decides it, read off the disk.
function readerSteps() {
  return [
    { label: "Read a note", name: "Read", input: { file_path: inVault("note.md") }, expect: "read", check: (r) => r.includes(NOTE_BODY) },
    { label: "search the vault", name: "Bash", bash: true, input: { command: `python3 -B ${q(inVault("_Meta/vault_search.py"))} --json "x"`, description: "search" }, expect: "read", check: (r) => r.includes('"note.md"') },
    { label: "Write a new note", name: "Write", input: { file_path: inVault("new.md"), content: "planted" }, expect: "refused", check: () => !fs.existsSync(inVault("new.md")) },
    { label: "Edit a note", name: "Edit", input: { file_path: inVault("note.md"), old_string: NOTE_BODY, new_string: "EDITED" }, expect: "refused", check: () => fs.readFileSync(inVault("note.md"), "utf8").includes(NOTE_BODY) },
    // Read first: `NotebookEdit` refuses a notebook it has not read, and that
    // refusal says nothing about the deny.
    { label: "Read a notebook", name: "Read", input: { file_path: inVault("n.ipynb") }, expect: "read", check: (r) => !r.includes("tool_use_error") },
    { label: "NotebookEdit a notebook", name: "NotebookEdit", input: { notebook_path: inVault("n.ipynb"), cell_id: "c1", new_source: "2", edit_mode: "replace" }, expect: "refused", check: () => fs.readFileSync(inVault("n.ipynb"), "utf8").includes('["1"]') },
    { label: "Bash touch", name: "Bash", bash: true, input: { command: `touch ${q(inVault("touched"))}`, description: "touch" }, expect: "refused", check: () => !fs.existsSync(inVault("touched")) },
    { label: "Bash redirect", name: "Bash", bash: true, input: { command: `echo planted > ${q(inVault("redirected"))}`, description: "redirect" }, expect: "refused", check: () => !fs.existsSync(inVault("redirected")) },
    { label: "Bash sed -i", name: "Bash", bash: true, input: { command: `sed -i s/${NOTE_BODY}/SEDDED/ ${q(inVault("note.md"))}`, description: "sed" }, expect: "refused", check: () => fs.readFileSync(inVault("note.md"), "utf8").includes(NOTE_BODY) },
    { label: "Bash python open", name: "Bash", bash: true, input: { command: `python3 -c "open('${inVault("opened")}', 'w').write('x')"`, description: "python" }, expect: "refused", check: () => !fs.existsSync(inVault("opened")) },
    // Without `-B`, so that the script's one write is attempted: it must still
    // answer, and the bytecode must not land in the vault.
    { label: "search without -B, bytecode refused", name: "Bash", bash: true, input: { command: `python3 ${q(inVault("_Meta/vault_search.py"))} --json "x"`, description: "search" }, expect: "read", check: (r) => r.includes('"note.md"') && !fs.existsSync(path.join(vault, "_Meta", "__pycache__")) },
    { label: "control: Write in the workspace", name: "Write", input: { file_path: path.join(work, "ok.md"), content: "control" }, expect: "control", check: () => fs.existsSync(path.join(work, "ok.md")) },
    { label: "control: Bash touch in the workspace", name: "Bash", bash: true, input: { command: `touch ${q(path.join(work, "ok-bash"))}`, description: "touch" }, expect: "control", check: () => fs.existsSync(path.join(work, "ok-bash")) },
  ];
}

// The argv every reader had before the deny: the same writes must land, or a
// refusal in the turns above proves nothing about the deny.
function beforeSteps() {
  return [
    { label: "control: Write into the vault", name: "Write", input: { file_path: inVault("new.md"), content: "planted" }, expect: "control", check: () => fs.existsSync(inVault("new.md")) },
    { label: "control: Read a notebook", name: "Read", input: { file_path: inVault("n.ipynb") }, expect: "read", check: (r) => !r.includes("tool_use_error") },
    { label: "control: NotebookEdit into the vault", name: "NotebookEdit", input: { notebook_path: inVault("n.ipynb"), cell_id: "c1", new_source: "2", edit_mode: "replace" }, expect: "control", check: () => !fs.readFileSync(inVault("n.ipynb"), "utf8").includes('["1"]') },
    { label: "control: Bash touch into the vault", name: "Bash", bash: true, input: { command: `touch ${q(inVault("touched"))}`, description: "touch" }, expect: "control", check: () => fs.existsSync(inVault("touched")) },
  ];
}

function vaultRunSteps() {
  return [
    { label: "Write in its worktree", name: "Write", input: { file_path: path.join(vaultWorktree, "a.md"), content: "own work" }, expect: "control", check: () => fs.existsSync(path.join(vaultWorktree, "a.md")) },
    { label: "Bash touch in its worktree", name: "Bash", bash: true, input: { command: `touch ${q(path.join(vaultWorktree, "b"))}`, description: "touch" }, expect: "control", check: () => fs.existsSync(path.join(vaultWorktree, "b")) },
  ];
}

function sse(content, stopReason) {
  const events = [["message_start", { message: { id: "msg_probe", type: "message", role: "assistant", model: "claude-probe", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }]];
  content.forEach((block, index) => {
    if (block.type === "text") {
      events.push(["content_block_start", { index, content_block: { type: "text", text: "" } }]);
      events.push(["content_block_delta", { index, delta: { type: "text_delta", text: block.text } }]);
    } else {
      events.push(["content_block_start", { index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } }]);
      events.push(["content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }]);
    }
    events.push(["content_block_stop", { index }]);
  });
  events.push(["message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } }]);
  events.push(["message_stop", {}]);
  return events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join("");
}

// The latest answer to step `i`, and how many times it was asked.
function lastResult(results, i) {
  let attempts = 0;
  while (results.has(`toolu_${i}_${attempts}`)) attempts += 1;
  return { attempts, result: attempts === 0 ? null : results.get(`toolu_${i}_${attempts - 1}`) };
}

// Answers the main conversation with the next step's tool call — the first
// step not yet answered, or a Bash step whose sandbox did not start, again —
// and every side request with text.
function startStub(calls, results) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end("{}");
      }
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        return void res.writeHead(400).end();
      }
      const isMain = Array.isArray(body.tools) && body.tools.some((t) => t.name === "Bash");
      const blocks = (body.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : []));
      for (const b of blocks) {
        if (b.type === "tool_result") results.set(b.tool_use_id, typeof b.content === "string" ? b.content : JSON.stringify(b.content));
      }
      const next = !isMain
        ? -1
        : calls.findIndex((call, i) => {
            const { attempts, result } = lastResult(results, i);
            return attempts === 0 || (call.bash && SANDBOX_DID_NOT_START.test(result) && attempts < BASH_ATTEMPTS);
          });
      const id = next === -1 ? null : `toolu_${next}_${lastResult(results, next).attempts}`;
      const content = next === -1 ? [{ type: "text", text: "done" }] : [{ type: "tool_use", id, name: calls[next].name, input: calls[next].input }];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse(content, next === -1 ? "end_turn" : "tool_use"));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

function shimPath() {
  if (!process.env.PROBE_BWRAP_ARGV) return process.env.PATH;
  const real = (process.env.PATH ?? "").split(":").map((d) => path.join(d, "bwrap")).find((p) => fs.existsSync(p));
  if (!real) return process.env.PATH;
  fs.writeFileSync(path.join(shimDir, "bwrap"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${shimDir}/argv.$$"\nexec "${real}" "$@"\n`, { mode: 0o755 });
  return `${shimDir}:${process.env.PATH}`;
}

// The vault's mount operations in each logged bwrap argv, in order.
function vaultMounts() {
  return fs
    .readdirSync(shimDir)
    .filter((f) => f.startsWith("argv."))
    .map((f) => fs.readFileSync(path.join(shimDir, f), "utf8").split("\n"))
    .map((argv) => argv.flatMap((a, i) => (a === vault && argv[i - 1]?.startsWith("--") ? [argv[i - 1]] : [])))
    .filter((ops) => ops.length > 0);
}

async function turn(label, { cwd, permissionMode, writable, steps: all }) {
  const steps = TURN === "" || TURN === label ? all.filter((s) => ONLY === "" || s.label === ONLY) : [];
  if (steps.length === 0) return [];
  plantVault();
  for (const f of fs.readdirSync(shimDir)) if (f.startsWith("argv.")) fs.rmSync(path.join(shimDir, f));
  const results = new Map();
  const { server, port } = await startStub(steps, results);
  const allowWrite = [cwd, configDir, tmp];
  const args = [
    "-p", "--output-format", "stream-json", "--verbose",
    "--permission-mode", permissionMode,
    "--disallowedTools", "Bash(pkill:*)", "Bash(killall:*)", ...(writable ? [] : [`Edit(/${vault}/**)`]),
    "--add-dir", vault,
    "--settings", JSON.stringify({ sandbox: { filesystem: writable ? { allowWrite } : { allowWrite, denyWrite: [vault] } } }),
    "--", "go",
  ];
  const code = await new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd,
      env: {
        PATH: shimPath(),
        HOME: home,
        CLAUDE_CONFIG_DIR: configDir,
        TMPDIR: tmp,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_API_KEY: "sk-ant-probe",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), TURN_TIMEOUT_MS);
    child.on("close", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  server.close();
  console.log(`\n${label} (exit ${code})`);
  const outcomes = steps.map((s, i) => {
    const { attempts, result: answered } = lastResult(results, i);
    const result = answered ?? "(never answered)";
    // null is "not measured": a Bash call whose every attempt died in bwrap.
    const held = s.bash && SANDBOX_DID_NOT_START.test(result) ? null : s.check(result);
    const mark = held === null ? "n/a " : held ? "ok  " : "FAIL";
    const tries = s.bash && attempts > 1 ? ` (${attempts} attempts)` : "";
    console.log(`  ${mark} ${s.label}${tries}${held ? "" : `: ${result.slice(0, 160).replaceAll("\n", " | ")}`}`);
    if (process.env.PROBE_DEBUG) {
      for (let a = 0; a < attempts; a += 1) console.log(`       [${a}] ${results.get(`toolu_${i}_${a}`).slice(0, 300).replaceAll("\n", " | ")}`);
    }
    return { ...s, held };
  });
  for (const ops of vaultMounts()) console.log(`  bwrap mounts of the vault: ${ops.join(" then ")}`);
  return outcomes;
}

let exitCode = 0;
try {
  const all = [
    ...(await turn("reader with no deny, acceptEdits", { cwd: work, permissionMode: "acceptEdits", writable: true, steps: beforeSteps() })),
    ...(await turn("reader, acceptEdits", { cwd: work, permissionMode: "acceptEdits", writable: false, steps: readerSteps() })),
    ...(await turn("reader, bypassPermissions", { cwd: work, permissionMode: "bypassPermissions", writable: false, steps: readerSteps() })),
    ...(await turn("vault run, acceptEdits, writable argv", { cwd: vaultWorktree, permissionMode: "acceptEdits", writable: true, steps: vaultRunSteps() })),
  ];
  const unmeasured = all.filter((s) => s.held === null);
  if (all.some((s) => s.held === false)) exitCode = 1;
  else if (unmeasured.length > 0) {
    exitCode = 2;
    console.log(`\nNot measured — the CLI's sandbox never started for: ${unmeasured.map((s) => s.label).join(", ")}.`);
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.exit(exitCode);
