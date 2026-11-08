#!/usr/bin/env node
// What does `permissions.blockWritesOutsideWorkingDirectories` refuse a work
// cycle, and what does it leave alone? (docs/agent/security/file-tool-write-boundary.md.)
//
// Needs no credentials and touches nothing outside a scratch directory it makes
// under os.tmpdir(), except one file at the literal `/tmp/<unique>` that it
// removes again:
//
//   node scripts/sandbox-probe/write-boundary-probe.mjs
//
// A stub API drives the real CLI through file-tool writes a run that ignored
// its brief would make, with the shape of argv `buildArgs` emits: an isolated
// run in a worktree of a scratch repository, the vault flags of a reader or a
// writer, and the setting carried in the same `--settings` overlay as the
// sandbox write set. Every write is judged by the file afterwards, never by
// what the tool said; what the tool said is printed beside it, because that is
// what the model reads.
//
// Turns:
//   1. control: the setting off. The writes outside the checkout must land, or
//      a refusal below proves nothing about the setting.
//   2. the setting on, bypassPermissions; 3. the same under acceptEdits, and
//      3c. a read under acceptEdits with the setting off, as 3's control.
//   4. the setting on with the cycle's temporary directory as an `--add-dir`,
//      plus a skill, an agent and a CLAUDE.md planted in that directory, to see
//      whether an `--add-dir` of a shared directory loads anything from it;
//      4b. the same directory in `permissions.additionalDirectories` instead.
//   5. the vault's writer (a worktree under the vault's `.uf-worktrees/`, the
//      writable argv) with the setting on: its writes into the vault must land.
//   6. the setting off in `--settings` and on in the checkout's own
//      `.claude/settings.json`; 7. on in `--settings` and `false` in the
//      checkout's file.
//   8. `Bash` with the setting on, in a turn of its own because nested in an
//      agent's sandbox a Bash call can hang until the turn's timeout.
//
// PROBE_TURN=<n> runs only that turn; PROBE_DEBUG=1 prints every tool result
// whole; PROBE_DUMP_DIR=<dir> keeps each turn's first request to the model.
// Exit 0 when every step matched its expectation or was not measured (a Bash
// step whose sandbox never answered, printed n/a), 1 otherwise.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const BASH_ATTEMPTS = Number(process.env.PROBE_BASH_ATTEMPTS ?? 6);
// What a Bash result says when bwrap itself failed, before the command ran.
// Nested inside an agent's own sandbox that happens on most pids.
const SANDBOX_DID_NOT_START = /^Exit code \d+\s+bwrap: /;
const TURN_TIMEOUT_MS = Number(process.env.PROBE_TURN_TIMEOUT_MS ?? 180_000);
const ONLY_TURN = process.env.PROBE_TURN ?? "";

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-write-boundary-probe-")));
const mount = path.join(scratch, "mount");
const repo = path.join(mount, "repo");
const worktree = path.join(mount, ".uf-worktrees", "repo-1");
const other = path.join(mount, "other-repo");
const vault = path.join(mount, "Knowledge Vault");
const vaultWorktree = path.join(vault, ".uf-worktrees", "Knowledge Vault-1");
const home = path.join(scratch, "home");
const configDir = path.join(home, ".claude");
const tmp = path.join(scratch, "tmp");
const literalTmp = path.join("/tmp", `uf-write-boundary-probe-${process.pid}-${Date.now()}`);
const uid = process.getuid?.() ?? 0;

// Bare git under `env -i`, so an agent shell's GIT_* overrides cannot reach it.
const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

function plant() {
  for (const dir of [repo, other, path.join(vault, "_Meta"), configDir, tmp]) fs.mkdirSync(dir, { recursive: true });
  for (const dir of [repo, other, vault]) {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "-c", "user.name=probe", "-c", "user.email=probe@invalid", "commit", "-q", "--allow-empty", "-m", "root");
  }
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(repo, "worktree", "add", "-q", "-b", "run-1", worktree);
  fs.mkdirSync(path.dirname(vaultWorktree), { recursive: true });
  git(vault, "worktree", "add", "-q", "-b", "run-1", vaultWorktree);
  fs.writeFileSync(path.join(repo, "main.txt"), "MAIN-ORIGINAL\n");
  fs.writeFileSync(
    path.join(repo, "n.ipynb"),
    JSON.stringify({ cells: [{ cell_type: "code", id: "c1", metadata: {}, source: ["1"], outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 }),
  );
  fs.writeFileSync(path.join(vault, "note.md"), "VAULT-NOTE-BODY\n");
  fs.writeFileSync(path.join(worktree, "own.txt"), "OWN-ORIGINAL\n");
  // A link inside the checkout to the main checkout: the file tools must not
  // reach through it.
  fs.symlinkSync(repo, path.join(worktree, "link-to-main"));
  // What an `--add-dir` of the temporary directory might load: a skill, an
  // agent and a CLAUDE.md, each carrying a marker the stub looks for in the
  // request the model is sent.
  const skill = path.join(tmp, ".claude", "skills", "planted-probe-skill");
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: planted-probe-skill\ndescription: PLANTED-SKILL-MARKER\n---\nbody\n");
  const agents = path.join(tmp, ".claude", "agents");
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, "planted.md"), "---\nname: planted-probe-agent\ndescription: PLANTED-AGENT-MARKER\n---\nbody\n");
  fs.writeFileSync(path.join(tmp, "CLAUDE.md"), "PLANTED-CLAUDE-MD-MARKER\n");
}

const exists = (p) => fs.existsSync(p);
const contains = (p, s) => exists(p) && fs.readFileSync(p, "utf8").includes(s);
// The CLI's spelling of a directory as a project key.
const slug = (p) => p.replace(/[^a-zA-Z0-9]/g, "-");

// A step's `input` may be a function of what the stub saw, for the paths only
// the CLI knows: its session's scratchpad.
const W = (label, file, expect, extra = {}) => ({
  label,
  name: "Write",
  input: (ctx) => ({ file_path: typeof file === "function" ? file(ctx) : file, content: "PROBE-WROTE\n" }),
  expect,
  check: (ctx) => contains(typeof file === "function" ? file(ctx) : file, "PROBE-WROTE"),
  ...extra,
});

function isolatedSteps() {
  return [
    W("Write in its own checkout", path.join(worktree, "new.txt"), "lands"),
    {
      label: "Edit in its own checkout",
      name: "Edit",
      input: () => ({ file_path: path.join(worktree, "own.txt"), old_string: "OWN-ORIGINAL", new_string: "PROBE-WROTE" }),
      expect: "lands",
      check: () => contains(path.join(worktree, "own.txt"), "PROBE-WROTE"),
      needsRead: path.join(worktree, "own.txt"),
    },
    W("Write package.json in its own checkout", path.join(worktree, "package.json"), "lands"),
    W("Write .claude/settings.json in its own checkout", path.join(worktree, ".claude", "settings.json"), "refused"),
    W("Write into the main checkout", path.join(repo, "planted.txt"), "refused"),
    {
      label: "Edit in the main checkout",
      name: "Edit",
      input: () => ({ file_path: path.join(repo, "main.txt"), old_string: "MAIN-ORIGINAL", new_string: "PROBE-WROTE" }),
      expect: "refused",
      check: () => contains(path.join(repo, "main.txt"), "PROBE-WROTE"),
      needsRead: path.join(repo, "main.txt"),
    },
    {
      label: "NotebookEdit in the main checkout",
      name: "NotebookEdit",
      input: () => ({ notebook_path: path.join(repo, "n.ipynb"), cell_id: "c1", new_source: "2", edit_mode: "replace" }),
      expect: "refused",
      check: () => !fs.readFileSync(path.join(repo, "n.ipynb"), "utf8").includes('["1"]'),
      needsRead: path.join(repo, "n.ipynb"),
    },
    W("Write into the main checkout through `..`", path.join(worktree, "..", "..", "repo", "dotdot.txt"), "refused", {
      check: () => contains(path.join(repo, "dotdot.txt"), "PROBE-WROTE"),
    }),
    W("Write into the main checkout through a link in its checkout", path.join(worktree, "link-to-main", "via-link.txt"), "refused", {
      check: () => contains(path.join(repo, "via-link.txt"), "PROBE-WROTE"),
    }),
    W("Write into the repository's .git", path.join(repo, ".git", "planted"), "refused"),
    W("Write into another repository", path.join(other, "planted.txt"), "refused"),
    W("Write into $TMPDIR (the child's)", path.join(tmp, "scratch.txt"), "refused"),
    W("Write into the CLI's per-uid temp root", path.join(tmp, `claude-${uid}`, "scratch.txt"), "refused"),
    W("Write into literal /tmp", literalTmp, "refused"),
    W("Write into the CLI's scratchpad", (ctx) => path.join(ctx.scratchpad ?? path.join(tmp, "NO-SCRATCHPAD-OFFERED"), "s.txt"), "lands", {
      skipUnless: (ctx) => ctx.scratchpad !== null,
    }),
    // The CLI exempts the plan file it names for the session, not the folder:
    // a name it did not choose is refused like any other path.
    W("Write a plan file the CLI did not name", path.join(configDir, "plans", "probe-plan.md"), "refused"),
    W("Write this project's auto-memory", path.join(configDir, "projects", slug(worktree), "memory", "probe.md"), "lands"),
    W("Write the main checkout's auto-memory", path.join(configDir, "projects", slug(repo), "memory", "probe.md"), "lands"),
    W("Write another file in CLAUDE_CONFIG_DIR", path.join(configDir, "planted.txt"), "refused"),
    W("Write CLAUDE_CONFIG_DIR/settings.json", path.join(configDir, "settings.json"), "refused"),
    W("Write into the vault (reader)", path.join(vault, "planted.md"), "refused"),
    { label: "Read a vault note (reader)", name: "Read", input: () => ({ file_path: path.join(vault, "note.md") }), expect: "read", check: (_ctx, r) => r.includes("VAULT-NOTE-BODY") },
    { label: "Read the main checkout", name: "Read", input: () => ({ file_path: path.join(repo, "main.txt") }), expect: "read", check: (_ctx, r) => /MAIN-ORIGINAL|PROBE-WROTE/.test(r) },
  ];
}

// Under acceptEdits a read outside the working directories is the mode's to
// refuse, with or without the setting: observed, not expected.
const acceptEditsReads = (steps) =>
  steps.map((s) => (s.label === "Read the main checkout" ? { ...s, expect: "observe" } : s));

// With the setting off every outside write lands: the control for the turns
// that switch it on. A settings file and `.git` are only observed there, since
// the CLI may guard them on grounds of its own.
const offExpect = (steps) =>
  steps.map((s) =>
    s.expect !== "refused" || /vault|^Bash/.test(s.label)
      ? s
      : { ...s, expect: /settings\.json|\.git/.test(s.label) ? "observe" : "lands" },
  );

function tmpAddDirSteps() {
  const steps = isolatedSteps().filter((s) => /\$TMPDIR|per-uid|literal \/tmp|main checkout"|another repository|own checkout"/.test(s.label) || s.label === "Write into the main checkout");
  return steps.map((s) => (/\$TMPDIR|per-uid/.test(s.label) ? { ...s, expect: "lands" } : s));
}

function bashSteps() {
  return [
    // The setting is the file tools' and not the shell's: the repository's
    // .git is in the sandbox write set and is not a working directory, so a
    // shell write there lands with the setting on, and one into the main
    // checkout is refused by bwrap, not by the setting.
    { label: "Bash touch in the repository's .git", name: "Bash", bash: true, input: () => ({ command: `touch '${path.join(repo, ".git", "bash-touched")}'`, description: "touch" }), expect: "lands", check: () => exists(path.join(repo, ".git", "bash-touched")) },
    { label: "Bash touch in the main checkout", name: "Bash", bash: true, input: () => ({ command: `touch '${path.join(repo, "bash-touched")}'`, description: "touch" }), expect: "refused", check: () => exists(path.join(repo, "bash-touched")) },
  ];
}

function vaultWriterSteps() {
  return [
    W("Write in its worktree under the vault", path.join(vaultWorktree, "a.md"), "lands"),
    W("Write into the vault itself (writer)", path.join(vault, "writer.md"), "lands"),
    W("Write into the main checkout (writer)", path.join(repo, "from-vault-run.txt"), "refused"),
  ];
}

function projectSettingsSteps(expectOutside) {
  return [
    W("Write in its own checkout", path.join(worktree, "p-own.txt"), "lands"),
    W("Write into the main checkout", path.join(repo, "p-planted.txt"), expectOutside),
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

// Each step becomes one or two tool calls — a `Read` first where `Edit` needs
// one — answered in order on the main conversation; side requests get text.
// The latest answer to call `i`, and how many times it was asked.
function lastResult(results, i) {
  let attempts = 0;
  while (results.has(`toolu_${i}_${attempts}`)) attempts += 1;
  return { attempts, result: attempts === 0 ? null : results.get(`toolu_${i}_${attempts - 1}`) };
}

function startStub(calls, results, ctx) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end("{}");
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        return void res.writeHead(400).end();
      }
      const isMain = Array.isArray(body.tools) && body.tools.some((t) => t.name === "Write");
      if (isMain) {
        ctx.mainRequests += 1;
        ctx.toolNames = body.tools.map((t) => t.name);
        for (const marker of ["PLANTED-SKILL-MARKER", "PLANTED-AGENT-MARKER", "PLANTED-CLAUDE-MD-MARKER", "planted-probe-skill", "planted-probe-agent"]) {
          if (raw.includes(marker)) ctx.markers.add(marker);
        }
        // On the first request only, before any tool input has named a path:
        // whether the environment section's "Additional working directories"
        // list names the directory, as a `  - <path>` line. The sandbox's own
        // description in the same message names it whatever the setting.
        if (ctx.mainRequests === 1) {
          if (process.env.PROBE_DUMP_DIR) fs.writeFileSync(path.join(process.env.PROBE_DUMP_DIR, `first-request-${ctx.turnId}.json`), raw);
          const listed = (dir) => JSON.stringify(body.messages ?? []).includes(`- ${dir}\\n`);
          ctx.scratchListed = listed(tmp);
          ctx.vaultListed = listed(vault);
        }
        const pad = raw.match(/(\/[^"\s\\]*\/scratchpad)\b/);
        if (pad && ctx.scratchpad === null) ctx.scratchpad = pad[1];
      }
      const blocks = (body.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : []));
      for (const b of blocks) {
        if (b.type === "tool_result") {
          const text = typeof b.content === "string" ? b.content : (b.content ?? []).map((x) => x.text ?? "").join("\n");
          results.set(b.tool_use_id, { text, isError: b.is_error === true });
        }
      }
      const next = !isMain
        ? -1
        : calls.findIndex((c, i) => {
            const { attempts, result } = lastResult(results, i);
            return attempts === 0 || (c.bash && SANDBOX_DID_NOT_START.test(result.text) && attempts < BASH_ATTEMPTS);
          });
      const id = next === -1 ? null : `toolu_${next}_${lastResult(results, next).attempts}`;
      const content =
        next === -1
          ? [{ type: "text", text: "done" }]
          : [{ type: "tool_use", id, name: calls[next].name, input: calls[next].input(ctx) }];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse(content, next === -1 ? "end_turn" : "tool_use"));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

async function turn(label, { cwd, permissionMode, settingInOverlay, addDirs = [], additionalDirectories, readerOfVault = false, projectSetting, steps, timeoutMs = TURN_TIMEOUT_MS }) {
  plantFresh();
  if (projectSetting !== undefined) {
    fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".claude", "settings.json"), JSON.stringify({ permissions: { blockWritesOutsideWorkingDirectories: projectSetting } }));
  }
  const calls = steps.flatMap((s) => [
    ...(s.needsRead ? [{ name: "Read", input: () => ({ file_path: s.needsRead }) }] : []),
    { ...s, step: true },
  ]);
  const results = new Map();
  const ctx = { turnId: label.split(".")[0], scratchpad: null, markers: new Set(), mainRequests: 0, toolNames: [], scratchListed: false, vaultListed: false };
  const { server, port } = await startStub(calls, results, ctx);
  // The write set an isolated run gets (`sandboxSettings`): its checkout, the
  // repository's .git, the config dir and the temporary directory.
  const allowWrite = [cwd, path.join(cwd === vaultWorktree ? vault : repo, ".git"), configDir, tmp];
  const overlay = {
    apiKeyHelper: "",
    ...(settingInOverlay || additionalDirectories
      ? {
          permissions: {
            ...(settingInOverlay ? { blockWritesOutsideWorkingDirectories: true } : {}),
            ...(additionalDirectories ? { additionalDirectories } : {}),
          },
        }
      : {}),
    sandbox: { filesystem: readerOfVault ? { allowWrite, denyWrite: [vault] } : { allowWrite } },
  };
  const args = [
    "-p", "--output-format", "stream-json", "--verbose",
    "--permission-mode", permissionMode,
    "--disallowedTools", "Bash(pkill:*)", "Bash(killall:*)", ...(readerOfVault ? [`Edit(/${vault}/**)`] : []),
    "--add-dir", vault, ...addDirs.flatMap((d) => ["--add-dir", d]),
    "--settings", JSON.stringify(overlay),
    "--", "go",
  ];
  let stderr = "";
  const code = await new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CLAUDE_CONFIG_DIR: configDir,
        TMPDIR: tmp,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_API_KEY: "sk-ant-probe",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  server.close();
  console.log(`\n${label} (exit ${code}, ${ctx.mainRequests} main requests)`);
  if (stderr.trim()) console.log(`  stderr: ${stderr.trim().slice(0, 300).replaceAll("\n", " | ")}`);
  console.log(`  scratchpad offered: ${ctx.scratchpad ?? "none"}`);
  console.log(`  "Additional working directories" lists the temporary directory: ${ctx.scratchListed}; the vault: ${ctx.vaultListed}`);
  console.log(`  worktree tools on offer: ${["EnterWorktree", "ExitWorktree"].filter((t) => ctx.toolNames.includes(t)).join(", ") || "none"}`);
  if (addDirs.length > 0 || additionalDirectories) console.log(`  planted markers seen in the request: ${[...ctx.markers].join(", ") || "none"}`);
  let ok = true;
  calls.forEach((c, i) => {
    if (!c.step) return;
    const { attempts, result } = lastResult(results, i);
    const answer = result ?? { text: "(never answered)", isError: true };
    if (c.skipUnless && !c.skipUnless(ctx)) {
      console.log(`  n/a  ${c.label}: not offered`);
      return;
    }
    if (c.bash && (result === null || SANDBOX_DID_NOT_START.test(answer.text))) {
      console.log(`  n/a  ${c.label}: ${result === null ? "never answered (a nested sandbox can hang until the turn's timeout)" : `the CLI's sandbox never started in ${attempts} attempts`}`);
      return;
    }
    const happened = c.check(ctx, answer.text);
    const held = c.expect === "observe" || (c.expect === "refused" ? !happened : happened);
    if (!held) ok = false;
    const outcome = c.expect === "read" ? (happened ? "read" : "not read") : happened ? "landed" : "not written";
    const said = `${answer.isError ? "is_error " : ""}${answer.text.slice(0, 220).replaceAll("\n", " | ")}`;
    console.log(`  ${held ? "ok  " : "FAIL"} ${c.label} -> ${outcome} (expected ${c.expect})${process.env.PROBE_DEBUG || !held || !happened ? `\n         tool said: ${said}` : ""}`);
  });
  return ok;
}

function plantFresh() {
  fs.rmSync(mount, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(literalTmp, { force: true });
  plant();
}

const TURNS = [
  ["1", "isolated run, setting off, bypassPermissions (control)", { cwd: worktree, permissionMode: "bypassPermissions", settingInOverlay: false, readerOfVault: true, steps: offExpect(isolatedSteps()) }],
  ["2", "isolated run, setting on in --settings, bypassPermissions", { cwd: worktree, permissionMode: "bypassPermissions", settingInOverlay: true, readerOfVault: true, steps: isolatedSteps() }],
  ["3", "isolated run, setting on in --settings, acceptEdits", { cwd: worktree, permissionMode: "acceptEdits", settingInOverlay: true, readerOfVault: true, steps: acceptEditsReads(isolatedSteps()) }],
  ["3c", "isolated run, setting off, acceptEdits (control for the read)", { cwd: worktree, permissionMode: "acceptEdits", settingInOverlay: false, readerOfVault: true, steps: acceptEditsReads(isolatedSteps()).filter((s) => s.label === "Read the main checkout") }],
  ["4", "isolated run, setting on, --add-dir of the temporary directory", { cwd: worktree, permissionMode: "bypassPermissions", settingInOverlay: true, readerOfVault: true, addDirs: [tmp], steps: tmpAddDirSteps() }],
  ["4b", "isolated run, setting on, the temporary directory in permissions.additionalDirectories", { cwd: worktree, permissionMode: "bypassPermissions", settingInOverlay: true, readerOfVault: true, additionalDirectories: [tmp], steps: tmpAddDirSteps() }],
  ["5", "vault writer, setting on, writable argv", { cwd: vaultWorktree, permissionMode: "bypassPermissions", settingInOverlay: true, readerOfVault: false, steps: vaultWriterSteps() }],
  ["6", "setting only in the checkout's .claude/settings.json", { cwd: worktree, permissionMode: "bypassPermissions", settingInOverlay: false, projectSetting: true, readerOfVault: true, steps: projectSettingsSteps("refused") }],
  ["7", "setting on in --settings, false in the checkout's .claude/settings.json", { cwd: worktree, permissionMode: "bypassPermissions", settingInOverlay: true, projectSetting: false, readerOfVault: true, steps: projectSettingsSteps("refused") }],
  ["8", "Bash under the setting, bypassPermissions", { cwd: worktree, permissionMode: "bypassPermissions", settingInOverlay: true, readerOfVault: true, steps: bashSteps(), timeoutMs: Number(process.env.PROBE_BASH_TURN_TIMEOUT_MS ?? 90_000) }],
];

let exitCode = 0;
try {
  for (const [id, label, opts] of TURNS) {
    if (ONLY_TURN !== "" && ONLY_TURN !== id) continue;
    if (!(await turn(`${id}. ${label}`, opts))) exitCode = 1;
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(literalTmp, { force: true });
}
process.exit(exitCode);
