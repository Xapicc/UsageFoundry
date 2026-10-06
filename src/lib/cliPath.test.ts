import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, before, describe, it } from "node:test";

/**
 * Which file a `CLAUDE_BIN` or `CODEX_BIN` spawn runs, and that the child's
 * `PATH` has no say in it.
 *
 * Every child that spawns either is handed the agents' `PATH`, whose first
 * entries a work cycle can write, and Node looks a bare command up on the
 * `PATH` of the `env` it is given. So a `claude` left in
 * `/home/node/pytools/bin` was what every later spawn ran, the chat child with
 * `UF_CHAT_GID` among them (board task `af2a031b`). Nothing about that is
 * visible: a planted copy that forwards to the real one passes every other
 * test in the suite and every page.
 *
 * The configuration is fixed at import, so it is set here before `config` is
 * loaded: `claude` is the default's name, found on this server's `PATH` as an
 * `env node` script the way the image's `codex` is, and `uf-absent-codex` is a
 * name this server's `PATH` does not have. The agents' `PATH` has a planted
 * copy of all three names first, and of `git`, which "the chat child's own
 * lookups" below has the chat child run by name.
 */

let scratch: string;
let serverDir: string;
let agentDir: string;
let config: typeof import("./config");
let claudeAuth: typeof import("./claudeAuth");
let codexAuth: typeof import("./codexAuth");
let chat: typeof import("./chat");
let stacks: typeof import("./stacks");

const SAVED = ["PATH", "UF_AGENT_PATH", "CLAUDE_BIN", "CODEX_BIN", "CLAUDE_HOME", "CODEX_HOME", "DATA_DIR"].map(
  (key) => [key, process.env[key]] as const,
);

function makeDir(...parts: string[]): string {
  const dir = path.join(...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeExecutable(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

const marker = (name: string) => path.join(scratch, `${name}-ran`);

before(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "uf-cli-path-"));
  serverDir = makeDir(scratch, "server-bin");
  agentDir = makeDir(scratch, "agent-bin");

  writeExecutable(
    serverDir,
    "claude",
    `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(marker("server-claude"))}, "");
process.stdout.write(JSON.stringify({ loggedIn: false, authMethod: "none" }) + "\\n");
`,
  );
  writeExecutable(serverDir, "git", `#!/bin/sh\n: > "${marker("server-git")}"\n`);
  for (const name of ["claude", "node", "uf-absent-codex", "git"]) {
    writeExecutable(
      agentDir,
      name,
      `#!/bin/sh\n: > "${marker(`planted-${name}`)}"\necho '{"loggedIn":true,"authMethod":"claude.ai"}'\n`,
    );
  }

  process.env.PATH = `${serverDir}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.UF_AGENT_PATH = `${agentDir}${path.delimiter}${process.env.PATH}`;
  process.env.CLAUDE_BIN = "claude";
  process.env.CODEX_BIN = "uf-absent-codex";
  process.env.CLAUDE_HOME = path.join(scratch, "claude-home");
  process.env.CODEX_HOME = path.join(scratch, "codex-home");
  process.env.DATA_DIR = path.join(scratch, "data");

  // An unresolvable `CODEX_BIN` must not stop this import: a throw here is a
  // boot refused over an optional CLI.
  config = await import("./config");
  assert.equal(
    config.CLAUDE_BIN,
    path.join(serverDir, "claude"),
    "config was already loaded in this process, so the configuration above is not what it read",
  );
  claudeAuth = await import("./claudeAuth");
  codexAuth = await import("./codexAuth");
  chat = await import("./chat");
  stacks = await import("./stacks");
});

after(() => {
  for (const [key, value] of SAVED) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("CLAUDE_BIN and CODEX_BIN", () => {
  it("runs the claude this server's PATH found, not one planted first on the child's PATH", async () => {
    const status = await claudeAuth.readAuthStatus();
    assert.equal(fs.existsSync(marker("planted-claude")), false, "the claude planted on the agents' PATH ran");
    assert.equal(
      fs.existsSync(marker("planted-node")),
      false,
      "`env node` found the node planted on the agents' PATH",
    );
    assert.equal(fs.existsSync(marker("server-claude")), true, "the claude on this server's PATH did not run");
    assert.deepEqual(status.ok && status.value.loggedIn, false);
  });

  it("refuses a name this server's PATH does not have, rather than letting the child's PATH find it", async () => {
    const status = await codexAuth.readAuthStatus();
    assert.equal(
      fs.existsSync(marker("planted-uf-absent-codex")),
      false,
      "the codex planted on the agents' PATH ran",
    );
    assert.equal(status.ok, false);
    assert.match(status.ok ? "" : status.error, /CODEX_BIN is `uf-absent-codex`, which is on none of this server's PATH/);
  });

  it("boots without that name and puts it in the boot log with the PATH it searched", () => {
    assert.equal(config.CODEX_BIN, "uf-absent-codex");
    const warnings = config.unresolvedExecutableWarnings();
    assert.equal(warnings.length, 1, warnings.join("\n"));
    assert.match(warnings[0], /^CODEX_BIN is `uf-absent-codex`/);
    assert.ok(warnings[0].includes(serverDir), "the warning does not name the PATH it searched");
  });
});

describe("resolveExecutable", () => {
  it("keeps an absolute path as the operator wrote it, whether or not anything is there", () => {
    assert.equal(config.resolveExecutable("/nowhere/claude", serverDir, "/"), "/nowhere/claude");
  });

  it("resolves a relative path against this server's cwd, never a child's", () => {
    assert.equal(config.resolveExecutable("bin/claude", serverDir, "/srv/app"), "/srv/app/bin/claude");
  });

  it("finds a bare name at the first executable file on the PATH it is given", () => {
    const [relative, notExecutable, aDirectory, first, second] = [
      "relative",
      "not-executable",
      "a-directory",
      "first",
      "second",
    ].map((name) => makeDir(scratch, "lookup", name));
    writeExecutable(relative, "tool", "#!/bin/sh\n");
    fs.writeFileSync(path.join(notExecutable, "tool"), "#!/bin/sh\n", { mode: 0o644 });
    fs.mkdirSync(path.join(aDirectory, "tool"));
    writeExecutable(first, "tool", "#!/bin/sh\n");
    writeExecutable(second, "tool", "#!/bin/sh\n");

    // A relative entry would be resolved against the lookup's own directory,
    // which for a child is its worktree, so it is skipped even when it holds one.
    const searchPath = ["", path.relative(process.cwd(), relative), notExecutable, aDirectory, first, second].join(
      path.delimiter,
    );
    assert.equal(config.resolveExecutable("tool", searchPath, "/"), path.join(first, "tool"));
  });

  it("has nothing for a bare name on none of the PATH", () => {
    assert.equal(config.resolveExecutable("uf-absent-tool", serverDir, "/"), null);
  });
});

describe("spawnCommand", () => {
  it("spawns a binary, or a script naming its interpreter by path, as written", () => {
    assert.deepEqual(config.spawnCommand(process.execPath, ["-v"], serverDir), {
      command: process.execPath,
      args: ["-v"],
    });
    const script = writeExecutable(scratch, "by-path", "#!/bin/sh\necho hi\n");
    assert.deepEqual(config.spawnCommand(script, ["a"], serverDir), { command: script, args: ["a"] });
  });

  it("resolves an env interpreter on this server's PATH and hands it the script", () => {
    const interpreter = writeExecutable(serverDir, "uf-interp", "#!/bin/sh\n");
    const plain = writeExecutable(scratch, "env-plain", "#!/usr/bin/env uf-interp\n");
    assert.deepEqual(config.spawnCommand(plain, ["a"], serverDir), {
      command: interpreter,
      args: [plain, "a"],
    });
    const split = writeExecutable(scratch, "env-split", "#! /usr/bin/env -S uf-interp --flag\r\n");
    assert.deepEqual(config.spawnCommand(split, ["a"], serverDir), {
      command: interpreter,
      args: ["--flag", split, "a"],
    });
  });

  it("refuses an env interpreter this server's PATH does not have", () => {
    const script = writeExecutable(scratch, "env-missing", "#!/usr/bin/env uf-absent-interp\n");
    assert.throws(() => config.spawnCommand(script, [], serverDir), /`uf-absent-interp` is on none of this server's PATH/);
  });

  it("refuses a bare name, naming the variable to set", () => {
    assert.throws(() => config.spawnCommand("claude", [], serverDir), /CLAUDE_BIN is `claude`/);
    assert.throws(() => config.spawnCommand("uf-absent-codex", [], serverDir), /CODEX_BIN is `uf-absent-codex`/);
  });
});

/**
 * What the chat and block child runs by name once it has started, which
 * `spawnCommand` does not reach (board task `6f85c72a`).
 *
 * That child holds `UF_CHAT_GID`, the group the chat's capability file is
 * handed to, and runs `bypassPermissions`. Its own `Bash` calls run `git`,
 * `ls` and `python3` by name, and a plugin hook is often an `env node` script,
 * so a file a work cycle left in a directory on its `PATH` ran as that child,
 * with that gid, the next time a turn ran it. These spawn through `chatEnv()`,
 * which is what the spawn site passes, with the same planted directory first
 * on the agents' `PATH` as above.
 */
describe("the chat child's own lookups", () => {
  it("runs a name from its own Bash on this server's PATH, not one planted first on the agents'", () => {
    const result = spawnSync("/bin/sh", ["-c", "git"], { env: chat.chatEnv(), encoding: "utf8" });
    assert.equal(result.error, undefined);
    assert.equal(fs.existsSync(marker("planted-git")), false, "the chat child ran the git planted on the agents' PATH");
    assert.equal(fs.existsSync(marker("server-git")), true, "the chat child did not run the git on this server's PATH");
  });

  it("finds an `env node` hook's interpreter on this server's PATH, not one planted first on the agents'", () => {
    fs.rmSync(marker("planted-node"), { force: true });
    const hook = writeExecutable(
      scratch,
      "hook.js",
      `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker("hook-ran"))}, "");\n`,
    );
    const result = spawnSync(hook, [], { env: chat.chatEnv(), encoding: "utf8" });
    assert.equal(result.error, undefined);
    assert.equal(fs.existsSync(marker("planted-node")), false, "`env node` in the chat child found the planted node");
    assert.equal(fs.existsSync(marker("hook-ran")), true, "the hook did not run under a real node");
  });

  it("keeps the stacks' toolbox and this server's own directories, in the agents' order", () => {
    // The toolbox is the one directory kept that root's PATH does not have:
    // dropping it would take every stack the operator declared away from the
    // chat. An empty or relative entry is the child's cwd, an operator's
    // repository, so it goes even when the server's PATH has it too.
    const toolbox = stacks.STACKS_BIN_DIR;
    const agents = [toolbox, agentDir, "", "relative", serverDir, "/usr/bin"].join(path.delimiter);
    const server = ["/usr/bin", "", "relative", serverDir].join(path.delimiter);
    assert.equal(stacks.chatPath(agents, server), [toolbox, serverDir, "/usr/bin"].join(path.delimiter));
  });
});

/**
 * What the chat and block child loads from a file a work cycle can write, once
 * started (board task `7dd5f973`).
 *
 * Each case plants a marker-writing command where a work cycle could put one —
 * the agents' `HOME`, which the chat inherited as the server's, and a
 * repository's `.git` — runs what the chat would with `chatEnv()`, and asserts
 * the command did not run. Each also runs the same thing with the channel open,
 * so a plant that never fires cannot pass as one that was closed. `chatHome()`
 * is null in this process, which is not separated, so the chat's own home is
 * handed in as a scratch directory. git is the real one, found on the `PATH`
 * this file started with, because the server `PATH` above has a stub `git`.
 */
describe("the chat child's own configuration", () => {
  let agentsHome: string;
  let chatHome: string;
  let repo: string;
  let realGit: string;
  let userSite: string | null;
  const savedHome = process.env.HOME;

  const run = (command: string, args: string[], env: NodeJS.ProcessEnv) =>
    spawnSync(command, args, { cwd: repo, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
  const ran = (name: string) => fs.existsSync(marker(name));
  const forget = (...names: string[]) => names.forEach((name) => fs.rmSync(marker(name), { force: true }));
  const command = (name: string) => writeExecutable(scratch, `${name}.sh`, `#!/bin/sh\n: > "${marker(name)}"\n`);

  before(() => {
    const startPath = SAVED.find(([key]) => key === "PATH")?.[1] ?? "";
    const gitOnStartPath = startPath
      .split(path.delimiter)
      .filter((dir) => path.isAbsolute(dir))
      .map((dir) => path.join(dir, "git"))
      .find((file) => fs.existsSync(file));
    assert.ok(gitOnStartPath, "no git on this process's PATH");
    realGit = gitOnStartPath;

    agentsHome = makeDir(scratch, "agents-home");
    chatHome = makeDir(scratch, "chat-home");
    fs.writeFileSync(path.join(agentsHome, ".gitconfig"), `[diff]\n\texternal = ${command("home-gitconfig")}\n`);
    fs.writeFileSync(path.join(agentsHome, ".bashrc"), `: > "${marker("home-bashrc")}"\n`);
    fs.writeFileSync(path.join(agentsHome, ".profile"), `: > "${marker("home-profile")}"\n`);
    const site = spawnSync("python3", ["-m", "site", "--user-site"], {
      env: { ...process.env, HOME: agentsHome },
      encoding: "utf8",
    });
    userSite = site.status === 0 ? site.stdout.trim() : null;
    if (userSite) {
      makeDir(userSite);
      fs.writeFileSync(
        path.join(userSite, "usercustomize.py"),
        `open(${JSON.stringify(marker("home-usercustomize"))}, "w").close()\n`,
      );
    }

    // Built with an empty HOME and no hooks, then planted: what a work cycle
    // with a checkout of this repository could leave in its `.git`.
    repo = makeDir(scratch, "repo");
    const setup = { ...process.env, HOME: chatHome };
    fs.writeFileSync(path.join(repo, "f.txt"), "one\n");
    for (const args of [
      ["init", "-q"],
      ["add", "f.txt"],
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "one"],
      ["config", "core.fsmonitor", command("repo-fsmonitor")],
    ]) {
      assert.equal(run(realGit, args, setup).status, 0, `git ${args.join(" ")} failed`);
    }
    const hooks = makeDir(repo, ".git", "hooks");
    fs.copyFileSync(command("repo-post-checkout"), path.join(hooks, "post-checkout"));
    fs.copyFileSync(command("repo-reference-transaction"), path.join(hooks, "reference-transaction"));
    fs.writeFileSync(path.join(repo, "f.txt"), "two\n");

    process.env.HOME = agentsHome;
  });

  after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  it("does not read the agents' ~/.gitconfig", () => {
    forget("home-gitconfig");
    run(realGit, ["diff"], chat.chatEnv(null));
    assert.equal(ran("home-gitconfig"), true, "the planted diff.external never ran, so this measures nothing");

    forget("home-gitconfig");
    const result = run(realGit, ["diff"], chat.chatEnv(chatHome));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(ran("home-gitconfig"), false, "git in the chat child ran a command from the agents' ~/.gitconfig");
  });

  it("does not run the agents' ~/.bashrc or ~/.profile when its Bash tool snapshots the shell", () => {
    // The pinned CLI's snapshot, as read out of 2.1.280: `bash -c -l` over a
    // script that sources the rc file it resolved from `HOME`.
    const snapshot = ["-c", "-l", '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"; true'];
    forget("home-bashrc", "home-profile");
    run("bash", snapshot, chat.chatEnv(null));
    assert.equal(ran("home-bashrc") && ran("home-profile"), true, "the planted rc files never ran");

    forget("home-bashrc", "home-profile");
    run("bash", snapshot, chat.chatEnv(chatHome));
    assert.equal(ran("home-bashrc"), false, "the chat child's shell ran the agents' ~/.bashrc");
    assert.equal(ran("home-profile"), false, "the chat child's login shell ran the agents' ~/.profile");
  });

  it("does not run a usercustomize from the agents' Python user site", (t) => {
    if (!userSite) return t.skip("no python3 here");
    forget("home-usercustomize");
    run("python3", ["-c", "pass"], chat.chatEnv(null));
    assert.equal(ran("home-usercustomize"), true, "the planted usercustomize never ran");

    forget("home-usercustomize");
    run("python3", ["-c", "pass"], chat.chatEnv(chatHome));
    assert.equal(ran("home-usercustomize"), false, "python3 in the chat child ran the agents' usercustomize.py");
  });

  it("clears a repository's core.fsmonitor and hooks for every git it runs", () => {
    const repoMarkers = ["repo-fsmonitor", "repo-post-checkout", "repo-reference-transaction"];
    // The same environment with its git block switched off is the channel open.
    forget(...repoMarkers);
    run(realGit, ["status"], { ...chat.chatEnv(chatHome), GIT_CONFIG_COUNT: "0" });
    run(realGit, ["checkout", "-q", "-b", "open"], { ...chat.chatEnv(chatHome), GIT_CONFIG_COUNT: "0" });
    assert.deepEqual(repoMarkers.filter(ran), repoMarkers, "a planted repository command never ran");

    forget(...repoMarkers);
    const status = run(realGit, ["status"], chat.chatEnv(chatHome));
    const checkout = run(realGit, ["checkout", "-q", "-b", "closed"], chat.chatEnv(chatHome));
    assert.equal(status.status, 0, status.stderr);
    assert.equal(checkout.status, 0, checkout.stderr);
    assert.deepEqual(repoMarkers.filter(ran), [], "git in the chat child ran a command from the repository's .git");
  });

  it("drops every variable naming a path in the agents' HOME, and keeps the Claude config directory", () => {
    const env = chat.chatHomeEnv(
      {
        NODE_ENV: "test",
        HOME: "/home/agent/",
        GOCACHE: "/home/agent/go/build-cache",
        UV_TOOL_DIR: "/home/agent/pytools/tools",
        PYTHONPATH: "/opt/lib:/home/agent/lib",
        XDG_CONFIG_HOME: "/home/agent",
        SIBLING: "/home/agent2/x",
        PLAIN: "1",
        PATH: "/home/agent/bin:/usr/bin",
        CLAUDE_CONFIG_DIR: "/home/agent/.claude",
        CLAUDE_HOME: "/home/agent/.claude",
      },
      "/run/chat-home",
    );
    assert.deepEqual(env, {
      NODE_ENV: "test",
      HOME: "/run/chat-home",
      SIBLING: "/home/agent2/x",
      PLAIN: "1",
      // `chatPath()`'s to decide, and a list rule would take the whole of it.
      PATH: "/home/agent/bin:/usr/bin",
      CLAUDE_CONFIG_DIR: "/home/agent/.claude",
      CLAUDE_HOME: "/home/agent/.claude",
    });
  });

  it("points the CLI at the old Claude home when nothing names it, and treats a HOME of / as naming nothing", () => {
    // Unset, the CLI would look under the new HOME and find no credential.
    const filled = chat.chatHomeEnv({ NODE_ENV: "test", HOME: "/home/agent" }, "/run/chat-home");
    assert.equal(filled.CLAUDE_CONFIG_DIR, "/home/agent/.claude");
    assert.deepEqual(chat.chatHomeEnv({ NODE_ENV: "test", HOME: "/", LIB: "/usr/lib" }, "/run/chat-home"), {
      NODE_ENV: "test",
      HOME: "/run/chat-home",
      LIB: "/usr/lib",
      CLAUDE_CONFIG_DIR: "/.claude",
    });
  });

  it("loads no settings from its cwd and no hooks, in the one --settings the CLI keeps", () => {
    // The CLI keeps only the last `--settings`, so a second flag for the hook
    // switch would silently drop the sandbox write set, or the reverse.
    const allowWrite = ["/workspace"];
    for (const overlay of [null, { sandbox: { filesystem: { allowWrite } } }]) {
      const args = chat.chatSettingsArgs(overlay);
      assert.equal(args[args.indexOf("--setting-sources") + 1], "user");
      assert.equal(args.filter((arg) => arg === "--settings").length, 1);
      assert.deepEqual(JSON.parse(args[args.indexOf("--settings") + 1]), {
        ...overlay,
        disableAllHooks: true,
      });
    }
  });
});
