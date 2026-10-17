import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * What `deliverRun` pushes, and what the card remembers afterwards.
 *
 * Three faults, each silent until somebody looks at GitHub. Deliver pushed the
 * branch of a run that could still commit, a running one or one with a link
 * queued up behind it, and opened a pull request on half the work: its only
 * guards were the folder overlap and the `landing` claim, and an isolated run
 * works in `.uf-worktrees`, which overlaps nothing. Its route cast the body, so
 * `null` or a title that was not a string threw after `git push` had already
 * published the branch. And the pull request it opened was remembered only by
 * the run's newest `deliver` event, which `sweepRunEvents` deletes after
 * `eventRetentionDays`, and only on the run that pressed, so either the sweep
 * or a chain made the card offer the press again.
 *
 * Driven for real, a database, a repository, the run's own checkout and a
 * remote, because what is pinned is what reaches the remote and what the card
 * reads back, and no fixture can state either. The remote is a **local bare
 * repository under the test's own temporary directory**, reached the way
 * `projectPush.test.ts` reaches its own: `origin` is a genuine
 * `https://github.com/acme/<name>.git`, which `planDelivery` requires of every
 * push URL, and **git's https transport is replaced** for this process by a
 * `git-remote-https` that hands the connection to `<root>/remotes/<name>.git`.
 * It used to be `pushInsteadOf`, which is exactly the rewrite Deliver now
 * refuses, because it is how a repository's own config could send the push and
 * its token somewhere else. Every scene's first push of `main` goes through
 * the stand-in before anything presses. The pull request is opened by a stub
 * standing in for `fetch`, so nothing here reaches GitHub or its API.
 *
 * The process's own git configuration and credentials are cleared before the
 * first import, for `projectPush.test.ts`' reason: an agent's shell carries a
 * `GIT_CONFIG_COUNT` block and a real token, and neither may reach a test of
 * the call that sends one.
 *
 * Its own file, with `DATA_DIR` and the token named before the first import,
 * for `loopMergeOwnership.test.ts`' reason: `config.ts` is read at module load.
 */

let land: typeof import("./land");
let dbMod: typeof import("./db");
let settings: typeof import("./settings");
let orchestrator: typeof import("./orchestrator");
let retention: typeof import("./retention");
let route: typeof import("../app/api/runs/[id]/deliver/route");
let root: string;
let remotes: string;

const MOUNT_DIR = "deliver-mount";
/** `origin` for the scene named `name`; the stand-in serves `<remotes>/<name>.git` for it. */
const githubRemote = (name: string) => `https://github.com/acme/${name}.git`;
const PULLS_ENDPOINT = /^https:\/\/api\.github\.com\/repos\/acme\/([^/]+)\/pulls$/;

for (const key of Object.keys(process.env)) {
  if (/^(GIT_|GH_|GITHUB_)/.test(key)) delete process.env[key];
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });

/** `git`, or null where it fails. */
const gitMay = (cwd: string, ...args: string[]) => {
  try {
    return git(cwd, ...args).trim();
  } catch {
    return null;
  }
};

/** Every pull request the stub was asked to open, in order. */
let opened: Array<{ head: string; base: string; title: string }> = [];
let realFetch: typeof fetch;

/**
 * The one endpoint `openPullRequest` calls, answered here. Anything else is
 * refused rather than forwarded, so a regression that reached for another URL
 * fails the test instead of the network.
 */
const stubFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const repo = PULLS_ENDPOINT.exec(url)?.[1];
  if (!repo) throw new Error(`the test's fetch stub refuses ${url}`);
  const body = JSON.parse(String(init?.body)) as { head: string; base: string; title: string };
  opened.push({ head: body.head, base: body.base, title: body.title });
  const number = 40 + opened.length;
  return new Response(
    JSON.stringify({ number, html_url: `https://github.com/acme/${repo}/pull/${number}` }),
    { status: 201, headers: { "content-type": "application/json" } },
  );
}) as typeof fetch;

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-deliver-")));
  remotes = path.join(root, "remotes");
  fs.mkdirSync(remotes);
  process.env.GIT_EXEC_PATH = standInTransport();
  // The operator's global config is not this test's: a URL rewrite or a hook
  // path there would change what is measured. The app's git reads the same.
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  // `commitPending` commits through the app's own git, which with no global
  // config has no identity to commit as.
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  });
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  // `planUsage` looks for an OAuth token here, and Resolve asks it before a
  // spawn: a unit test must not send a request on the operator's own credential.
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, MOUNT_DIR);
  process.env.WORKSPACE_ROOTS = "";
  // A credential `planDelivery` accepts. It never leaves this process: the
  // stand-in transport asks for none, and the stub above answers the API call.
  process.env.UF_GITHUB_TOKEN = "test-token-not-a-real-credential";
  process.env.UF_GITHUB_TOKENS = "";
  // Nothing here should reach a spawn of `claude`; one that does fails rather
  // than bills.
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");
  fs.mkdirSync(path.join(root, MOUNT_DIR), { recursive: true });

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );
  dbMod = await import("./db");
  land = await import("./land");
  settings = await import("./settings");
  orchestrator = await import("./orchestrator");
  retention = await import("./retention");
  route = await import("../app/api/runs/[id]/deliver/route");

  realFetch = globalThis.fetch;
  globalThis.fetch = stubFetch;
});

/**
 * A copy of git's exec directory whose `git-remote-https` serves
 * `<remotes>/<name>.git` for any `https://…/<name>.git`: `projectPush.test.ts`'
 * stand-in, copied because every test file here carries its own harness.
 */
function standInTransport(): string {
  const real = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
  const dir = path.join(root, "git-exec");
  fs.mkdirSync(dir);
  for (const entry of fs.readdirSync(real)) {
    if (entry !== "git-remote-https") fs.symlinkSync(path.join(real, entry), path.join(dir, entry));
  }
  fs.writeFileSync(
    path.join(dir, "git-remote-https"),
    [
      "#!/bin/sh",
      'repo=$(basename "$2" .git)',
      "while read -r line; do",
      '  case "$line" in',
      "    capabilities) printf 'connect\\n\\n' ;;",
      `    "connect "*) printf '\\n'; exec \${line#connect } "${remotes}/$repo.git" ;;`,
      "    *) exit 1 ;;",
      "  esac",
      "done",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return dir;
}

after(() => {
  globalThis.fetch = realFetch;
  const open = (globalThis as { __ufDb?: { close(): void } }).__ufDb;
  open?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  dbMod.db().prepare("DELETE FROM runs").run();
  settings.saveSettings({ landVerifyCommand: "", eventRetentionDays: 30 });
  opened = [];
});

interface Scene {
  runId: string;
  repo: string;
  slot: string;
  branch: string;
  /** The bare repository the stand-in transport serves for `origin`. */
  remote: string;
}

/**
 * An isolated run with one commit on its branch, checked out in a slot where
 * `allocateSlotPath` would look for one, the operator's checkout on `main` and
 * clean, and `origin` a GitHub URL the stand-in serves from a bare repository.
 */
function scene(
  name: string,
  status = "completed",
  /** More files the base commit tracks, by repository-relative path. */
  baseFiles: Record<string, string> = {},
): Scene {
  const repo = path.join(root, MOUNT_DIR, name);
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "shared.txt"), "base\n");
  for (const [file, content] of Object.entries(baseFiles)) {
    fs.writeFileSync(path.join(repo, file), content);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "main").trim();

  const remote = path.join(remotes, `${name}.git`);
  git(root, "init", "-q", "--bare", remote);
  const url = githubRemote(name);
  git(repo, "remote", "add", "origin", url);
  // The guard every scene stands on: the push URL is GitHub's, and a push to it
  // reached the bare repository, so the stand-in is what carries the press
  // below. If it ever stopped applying, this push would aim at GitHub and the
  // test refuses to press at all.
  assert.equal(git(repo, "remote", "get-url", "--push", "--all", "origin").trim(), url);
  git(repo, "push", "-q", "origin", "main:refs/heads/main");
  assert.equal(git(remote, "rev-parse", "refs/heads/main").trim(), base);

  const branch = `uf/${name}`;
  const slot = path.join(
    orchestrator.worktreeStore(repo)!,
    `${orchestrator.repoSlug(repo)}-1`,
  );
  git(repo, "worktree", "add", "-q", "-b", branch, slot);
  fs.writeFileSync(path.join(slot, "shared.txt"), "branch\n");
  git(slot, "commit", "-qam", "the run's work");

  const runId = `run-${name}`;
  dbMod
    .db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                         created_at, finished_at, isolation, repo_root, work_dir,
                         worktree_path, worktree_branch, worktree_base, worktree_base_branch)
       VALUES (?, ?, 'do the thing', ?, '{}', 1, 1, ?, ?, 'worktree', ?, ?, ?, ?, ?, 'main')`,
    )
    // `work_dir` is the slot, as admission records it for an isolated run, and
    // it is why the folder-overlap guard never saw a running one: the slot is a
    // sibling of the operator's checkout, not inside it.
    .run(runId, repo, status, Date.now(), Date.now(), repo, slot, slot, branch, base);

  return { runId, repo, slot, branch, remote };
}

/** A second run carrying `s`'s branch on, as admission records one. */
function continuation(s: Scene, status: string, iterations: number): string {
  const runId = `${s.runId}-next`;
  dbMod
    .db()
    .prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                         created_at, isolation, repo_root, work_dir, worktree_path,
                         worktree_branch, worktree_base_branch, continues_run)
       VALUES (?, ?, 'carry it on', ?, '{}', 1, ?, ?, 'worktree', ?, ?, ?, ?, 'main', ?)`,
    )
    .run(
      runId,
      s.repo,
      status,
      iterations,
      Date.now() + 1,
      s.repo,
      // A `waiting` link has no isolation recorded yet; a started one has the
      // branch and the slot it inherited.
      status === "waiting" ? null : s.slot,
      status === "waiting" ? null : s.slot,
      status === "waiting" ? null : s.branch,
      s.runId,
    );
  return runId;
}

/** The branch as the remote has it, or null when nothing was pushed. */
function remoteTip(s: Scene): string | null {
  const refs = git(s.remote, "for-each-ref", "--format=%(refname) %(objectname)").trim();
  const line = refs.split("\n").find((l) => l.startsWith(`refs/heads/${s.branch} `));
  return line ? line.split(" ")[1] : null;
}

function deliverEvents(runId: string): number {
  const row = dbMod
    .db()
    .prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND kind = 'deliver'")
    .get(runId) as { n: number };
  return row.n;
}

describe("deliverRun refuses a branch something can still commit to, and pushes nothing", () => {
  it("delivers a finished run's branch: one push, one pull request", async () => {
    // The control: without it every refusal below could be the harness.
    const s = scene("control");

    const delivered = await land.deliverRun(s.runId);

    assert.equal(delivered.ok, true, delivered.ok ? "" : delivered.reason);
    assert.equal(remoteTip(s), git(s.slot, "rev-parse", "HEAD").trim());
    assert.deepEqual(
      opened.map(({ head, base }) => ({ head, base })),
      [{ head: s.branch, base: "main" }],
    );
  });

  it("refuses a running run's branch in unsettledBranchRefusal's sentence", async () => {
    const s = scene("running", "running");

    const delivered = await land.deliverRun(s.runId);

    assert.equal(delivered.ok, false);
    assert.equal(
      delivered.ok ? "" : delivered.reason,
      "This run is still active. It can commit again at any moment, so anything " +
        "delivered now would be half its work.",
    );
    // Before the fix both of these happened: the branch was on the remote and a
    // pull request was open on half the work.
    assert.equal(remoteTip(s), null);
    assert.deepEqual(opened, []);
  });

  it("refuses while a run behind it is set to carry the branch on", async () => {
    const s = scene("chained");
    const next = continuation(s, "waiting", 0);

    const delivered = await land.deliverRun(s.runId);

    assert.equal(delivered.ok, false);
    assert.match(delivered.ok ? "" : delivered.reason, new RegExp(`^Run ${next.slice(0, 8)} `));
    assert.equal(remoteTip(s), null);
    assert.deepEqual(opened, []);
  });

  it("states the same refusal on the card, so the button is not offered", async () => {
    const s = scene("card");
    continuation(s, "waiting", 0);

    const state = await land.deliveryState(s.runId);
    const pressed = await land.deliverRun(s.runId);

    assert.equal(state.possible, false);
    assert.equal(state.reason, pressed.ok ? "" : pressed.reason);
  });
});

/**
 * Where the push goes, which is not always where `origin` fetches from.
 *
 * Measured before the fix, 2026-10-17 in this harness: `deliveryState` and
 * `deliverRun` decided on `git remote get-url origin`, the fetch URL, so the
 * card offered every configuration below. The `pushurl`, the local
 * `pushInsteadOf`, the second URL and the rewrite the verify command planted
 * each pushed the branch to the other repository and opened a pull request;
 * the SSH spelling ran the repository's `core.sshCommand` in the push's
 * environment, which carries the token. Each is a line in `.git/config`, which
 * a work cycle can write, and the last is written by the verify command
 * itself, which runs the branch's own code after the first read.
 */
describe("Deliver decides on every URL the push goes to, not on the fetch URL", () => {
  /** An empty bare repository, for a push that must not arrive. */
  function elsewhere(name: string): string {
    const dir = path.join(root, "elsewhere", `${name}.git`);
    git(root, "init", "-q", "--bare", dir);
    return dir;
  }

  const branchIn = (dir: string, s: Scene) =>
    gitMay(dir, "rev-parse", "--verify", "-q", `refs/heads/${s.branch}`);

  /** The card and the press refuse in one sentence, and nothing is pushed or opened. */
  async function assertRefused(s: Scene, reason: RegExp): Promise<void> {
    const state = await land.deliveryState(s.runId);
    const pressed = await land.deliverRun(s.runId);

    assert.equal(state.possible, false, "the card offered the press");
    assert.match(state.reason ?? "", reason);
    assert.equal(pressed.ok, false, "the press delivered");
    assert.equal(pressed.ok ? "" : pressed.reason, state.reason);
    assert.equal(remoteTip(s), null);
    assert.deepEqual(opened, []);
  }

  it("refuses a pushurl that is not GitHub while origin fetches from GitHub", async () => {
    const s = scene("pushurl");
    const away = elsewhere("pushurl");
    git(s.repo, "remote", "set-url", "--push", "origin", away);

    await assertRefused(s, /is not a GitHub remote/);
    assert.equal(branchIn(away, s), null);
  });

  it("refuses a pushInsteadOf that sends GitHub's pushes to a local path", async () => {
    const s = scene("push-instead");
    const away = elsewhere("push-instead");
    git(s.repo, "config", `url.${away}.pushInsteadOf`, githubRemote("push-instead"));

    await assertRefused(s, /is not a GitHub remote/);
    assert.equal(branchIn(away, s), null);
  });

  it("refuses a pushInsteadOf to GitHub's SSH spelling, whose core.sshCommand gets the token", async () => {
    const s = scene("push-ssh");
    // `parseRemote` reads `git@github.com:` as GitHub, and the push would go
    // over ssh through whatever program the repository names.
    const leaked = path.join(root, "push-ssh-leaked");
    const command = path.join(root, "push-ssh-command.sh");
    fs.writeFileSync(command, `#!/bin/sh\nprintf '%s' "$GH_TOKEN" > ${leaked}\nexit 1\n`, {
      mode: 0o755,
    });
    git(s.repo, "config", "url.git@github.com:.pushInsteadOf", "https://github.com/");
    git(s.repo, "config", "core.sshCommand", command);

    await assertRefused(s, /is not a GitHub remote/);
    assert.equal(fs.existsSync(leaked), false, "core.sshCommand ran with the token in its environment");
  });

  it("refuses a second url on origin, which git pushes to as well", async () => {
    const s = scene("two-urls");
    const away = elsewhere("two-urls");
    git(s.repo, "config", "--add", "remote.origin.url", away);

    await assertRefused(s, /pushes to 2 URLs/);
    assert.equal(branchIn(away, s), null);
  });

  it("refuses a pushInsteadOf the verify command writes, after the card offered the press", async () => {
    const s = scene("planted");
    const away = elsewhere("planted");
    // Run in the run's own tree, a worktree sharing the checkout's config.
    const plant = path.join(root, "plant.js");
    fs.writeFileSync(
      plant,
      `require("node:child_process").execFileSync("git", ` +
        `["config", "url.${away}.pushInsteadOf", "${githubRemote("planted")}"]);\n`,
    );
    settings.saveSettings({ landVerifyCommand: `${process.execPath} ${plant}` });

    const state = await land.deliveryState(s.runId);
    assert.equal(state.possible, true, state.reason ?? "");
    const pressed = await land.deliverRun(s.runId);

    assert.equal(pressed.ok, false, "the press delivered");
    assert.match(pressed.ok ? "" : pressed.reason, /is not a GitHub remote/);
    assert.equal(
      git(s.repo, "remote", "get-url", "--push", "origin").trim(),
      away,
      "the check wrote the rewrite this case is about",
    );
    assert.equal(branchIn(away, s), null);
    assert.equal(remoteTip(s), null);
    assert.deepEqual(opened, []);
  });
});

const OPERATORS_ENV = "API_KEY=the-operators-own-key\n";

/**
 * `s` with the operator's `.env` in their checkout and a copy in the run's
 * slot, which is what `seedWorktree` leaves under the default
 * `isolationCopyGlobs`. Copied here rather than by `ensureWorktree`, because
 * what is pinned is what the exits do with a branch that took it in.
 */
function seedEnv(s: Scene): void {
  fs.writeFileSync(path.join(s.repo, ".env"), OPERATORS_ENV);
  fs.copyFileSync(path.join(s.repo, ".env"), path.join(s.slot, ".env"));
}

/** A scene whose `.gitignore` names `.env`, its `.env` seeded and committed with `git add -f`. */
function forcedEnvScene(name: string): Scene {
  const s = scene(name, "completed", { ".gitignore": ".env\n" });
  seedEnv(s);
  // git's own refusal, whose hint is the `-f` below.
  assert.throws(() => git(s.slot, "add", ".env"));
  git(s.slot, "add", "-f", ".env");
  git(s.slot, "commit", "-qm", "track .env");
  return s;
}

/** The handoff card `s`'s run ends with, as the event the page replays. */
async function handoffOf(s: Scene): Promise<{ merge: string | null; mergeBlocked: string | null }> {
  await orchestrator.emitHandoff(s.runId, orchestrator.getRun(s.runId)!, s.slot);
  const rows = dbMod
    .db()
    .prepare("SELECT payload FROM run_events WHERE run_id = ? AND kind = 'handoff'")
    .all(s.runId) as Array<{ payload: string }>;
  assert.equal(rows.length, 1);
  return JSON.parse(rows[0].payload);
}

/**
 * The operator's own configuration leaving by either exit.
 *
 * Measured before the fix, 2026-10-06 on git 2.39.5, in this harness: with the
 * seeded `.env` committed by `git add -f`, `deliveryState` offered Deliver and
 * `deliverRun` pushed the operator's key to the remote; `landRun` refused only
 * on the operator's copy being in the way, and once it was moved aside as that
 * sentence advised, landed it into `main`. `commitPending` stages a seeded file
 * the repository does not ignore, since its `add -A` skips only ignored ones.
 */
describe("neither exit nor the handoff lets a file seeding copied in leave on the branch", () => {
  it("refuses on the card and at the press a seeded .env committed with git add -f, pushing nothing", async () => {
    const s = forcedEnvScene("seeded-forced");

    const state = await land.deliveryState(s.runId);
    const pressed = await land.deliverRun(s.runId);

    assert.equal(state.possible, false);
    assert.equal(pressed.ok, false);
    const reason = pressed.ok ? "" : pressed.reason;
    assert.equal(state.reason, reason);
    assert.match(reason, /^uf\/seeded-forced carries \.env, which this app copies into every checkout from yours/);
    assert.match(reason, /a push cannot be taken back/);
    assert.equal(remoteTip(s), null);
    assert.deepEqual(opened, []);
  });

  it("refuses a branch whose later commit deleted it, because the push carries the one that added it", async () => {
    const s = forcedEnvScene("seeded-deleted");
    git(s.slot, "rm", "-q", "--cached", ".env");
    git(s.slot, "commit", "-qm", "untrack .env");
    assert.equal(git(s.slot, "ls-tree", "--name-only", "HEAD", ".env").trim(), "");

    const pressed = await land.deliverRun(s.runId);

    assert.match(pressed.ok ? "" : pressed.reason, /^uf\/seeded-deleted carries \.env,/);
    assert.equal(remoteTip(s), null);
  });

  it("still reads a branch whose recorded base commit no longer exists", async () => {
    // A base the target was rewritten past and git collected: refused as
    // unreadable, the run could never leave by either exit.
    const s = forcedEnvScene("seeded-gone-base");
    dbMod
      .db()
      .prepare("UPDATE runs SET worktree_base = ? WHERE id = ?")
      .run("0123456789abcdef0123456789abcdef01234567", s.runId);

    const pressed = await land.deliverRun(s.runId);

    assert.match(pressed.ok ? "" : pressed.reason, /^uf\/seeded-gone-base carries \.env,/);
    assert.equal(remoteTip(s), null);
  });

  it("refuses what the card's Commit button commits from a repository that does not ignore it", async () => {
    const s = scene("seeded-unignored");
    seedEnv(s);
    fs.writeFileSync(path.join(s.slot, "more.txt"), "left uncommitted\n");

    const committed = await land.commitPending(s.runId, "leftovers");
    assert.equal(committed.ok, true, committed.ok ? "" : committed.reason);
    assert.match(git(s.slot, "show", "--name-only", "--format=", "HEAD"), /^\.env$/m);

    const pressed = await land.deliverRun(s.runId);

    assert.match(pressed.ok ? "" : pressed.reason, /^uf\/seeded-unignored carries \.env,/);
    assert.equal(remoteTip(s), null);
  });

  it("refuses the land, and still refuses it once the operator's copy is moved aside", async () => {
    const s = forcedEnvScene("seeded-land");
    const base = git(s.repo, "rev-parse", "main").trim();

    const state = await land.landState(s.runId);
    const landed = await land.landRun(s.runId, "merge");
    // `overwriteRefusal`'s advice, taken.
    fs.renameSync(path.join(s.repo, ".env"), path.join(root, "seeded-land.env"));
    const again = await land.landRun(s.runId, "merge");

    assert.match(state?.blocked ?? "", /^uf\/seeded-land carries \.env, .*into main's history/);
    assert.equal(landed.ok ? "" : landed.reason, state?.blocked);
    assert.equal(again.ok ? "" : again.reason, state?.blocked);
    assert.equal(git(s.repo, "rev-parse", "main").trim(), base);
    assert.equal(git(s.repo, "ls-tree", "--name-only", "main", ".env").trim(), "");
  });

  it("buys no resolution of a conflicting branch that carries one", async () => {
    // Read from the code on 2026-10-06: the conflict is `blocked`, so the card
    // offered Resolve, which spawned and billed a resolution `landRun` then
    // refused on the file. The merge queue already declined it.
    const s = forcedEnvScene("seeded-resolve");
    fs.writeFileSync(path.join(s.repo, "shared.txt"), "main\n");
    git(s.repo, "commit", "-qam", "main moves under the branch");
    const tip = git(s.repo, "rev-parse", s.branch).trim();

    const state = await land.landState(s.runId);
    const pressed = await land.resolveConflicts(s.runId);

    assert.equal(state?.preview.outcome, "conflict");
    assert.match(state?.blocked ?? "", /^Merging into main conflicts in 1 file/);
    assert.match(state?.resolveBlocked ?? "", /^uf\/seeded-resolve carries \.env, .*into main's history/);
    assert.equal(pressed.ok ? "" : pressed.reason, state?.resolveBlocked);
    // `startAssist` writes this row before it spawns, and it is the only spawn
    // on this path.
    const resolves = dbMod
      .db()
      .prepare("SELECT COUNT(*) AS n FROM run_reviews WHERE run_id = ? AND kind = 'resolve'")
      .get(s.runId) as { n: number };
    assert.equal(resolves.n, 0, "a resolution was started");
    assert.equal(git(s.repo, "rev-parse", s.branch).trim(), tip);
    assert.throws(() => git(s.slot, "rev-parse", "-q", "--verify", "MERGE_HEAD"), "a merge was opened");
  });

  it("withholds the handoff's merge command in the land's sentence", async () => {
    // The third door, and the one walked through by hand: git refuses the
    // copyable merge only because the operator's ignored copy is in the way.
    const control = scene("handoff-control");
    const s = forcedEnvScene("seeded-handoff");

    const offered = await handoffOf(control);
    const handoff = await handoffOf(s);
    const state = await land.landState(s.runId);

    assert.equal(offered.merge, "git merge --no-overwrite-ignore uf/handoff-control");
    assert.equal(offered.mergeBlocked, null);
    assert.equal(handoff.merge, null);
    assert.match(handoff.mergeBlocked ?? "", /^uf\/seeded-handoff carries \.env, .*into main's history/);
    assert.equal(handoff.mergeBlocked, state?.blocked);
  });

  it("names the seeded file on the handoff over a dirty checkout, since the card is never read again", async () => {
    const s = forcedEnvScene("seeded-handoff-dirty");
    fs.writeFileSync(path.join(s.repo, "scratch.txt"), "the operator's own work\n");

    const handoff = await handoffOf(s);

    assert.equal(handoff.merge, null);
    assert.match(handoff.mergeBlocked ?? "", /^uf\/seeded-handoff-dirty carries \.env,/);
  });

  it("offers no handoff merge when there is no branch to read the files against", async () => {
    const s = forcedEnvScene("seeded-handoff-detached");
    git(s.repo, "checkout", "-q", "--detach");
    dbMod.db().prepare("UPDATE runs SET worktree_base_branch = NULL WHERE id = ?").run(s.runId);

    const handoff = await handoffOf(s);

    assert.equal(handoff.merge, null);
    assert.match(handoff.mergeBlocked ?? "", /^Your checkout has no branch checked out and this run recorded none/);
  });

  it("delivers a branch that edits a .env.development the repository tracks", async () => {
    // The control for the subtraction: seeding copies only what a checkout
    // lacks, so a tracked file matching `.env.*` is the repository's own.
    const s = scene("seeded-tracked", "completed", { ".env.development": "API_URL=dev\n" });
    fs.writeFileSync(path.join(s.slot, ".env.development"), "API_URL=staging\n");
    git(s.slot, "commit", "-qam", "point dev at staging");

    const delivered = await land.deliverRun(s.runId);

    assert.equal(delivered.ok, true, delivered.ok ? "" : delivered.reason);
    assert.equal(remoteTip(s), git(s.slot, "rev-parse", "HEAD").trim());
  });

  it("delivers the same branch once this repository's seeding list no longer names the file", async () => {
    // The refusal's other way out, and the proof the list read is this
    // repository's rather than only the install-wide one.
    const s = forcedEnvScene("seeded-unlisted");
    settings.saveSettings({ isolationCopyGlobsByRepo: { [s.repo]: ["config/local.json"] } });
    try {
      const delivered = await land.deliverRun(s.runId);

      assert.equal(delivered.ok, true, delivered.ok ? "" : delivered.reason);
      assert.equal(git(s.remote, "show", `${s.branch}:.env`), OPERATORS_ENV);
    } finally {
      settings.saveSettings({ isolationCopyGlobsByRepo: {} });
    }
  });
});

/** One press of the card's button, through the route and its body check. */
function press(runId: string, body: string): Promise<Response> {
  return route.POST(
    new Request(`http://localhost/api/runs/${runId}/deliver`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
    { params: Promise.resolve({ id: runId }) },
  );
}

describe("the deliver route refuses a malformed body before any git runs", () => {
  it("delivers on the card's own body, {}", async () => {
    // The control, for the reason the first describe has one.
    const s = scene("route-control");

    const res = await press(s.runId, "{}");

    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    assert.equal(remoteTip(s), git(s.slot, "rev-parse", "HEAD").trim());
  });

  it("answers 400 with a sentence for null and for a title that is not a string", async () => {
    // Before the fix both reached `.trim()` after `git push`: the branch was on
    // the remote, the answer was a 500, and no record of the push was written.
    for (const [name, body, sentence] of [
      ["route-null", "null", /^The body has to be a JSON object; got null\.$/],
      ["route-title", '{"title": 5}', /^"title" has to be a string when it is given; got a number\./],
      ["route-garbled", "{title", /did not parse as JSON/],
    ] as const) {
      const s = scene(name);

      const res = await press(s.runId, body);

      assert.equal(res.status, 400, name);
      assert.match(((await res.json()) as { error: string }).error, sentence, name);
      assert.equal(remoteTip(s), null, `${name} pushed the branch`);
      assert.equal(deliverEvents(s.runId), 0, name);
    }
    assert.deepEqual(opened, []);
  });

  it("answers 400 with the run-state sentence for an active run, on a well-formed body", async () => {
    // The press a card left open across a Reopen makes: the body is fine and
    // the run is not.
    const s = scene("route-paused", "paused");

    const res = await press(s.runId, "{}");

    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /^This run is still active\./);
    assert.equal(remoteTip(s), null);
    assert.deepEqual(opened, []);
  });
});

describe("the delivered pull request outlives the event sweep and belongs to the branch", () => {
  it("still withdraws the button once the deliver event has been swept", async () => {
    const s = scene("swept");
    const delivered = await land.deliverRun(s.runId);
    assert.equal(delivered.ok, true, delivered.ok ? "" : delivered.reason);
    assert.equal(deliverEvents(s.runId), 1);

    settings.saveSettings({ eventRetentionDays: 1 });
    retention.sweepRunEvents(Date.now() + 3 * 86_400_000);

    // The sweep did what it is for, so what follows is not the event surviving.
    assert.equal(deliverEvents(s.runId), 0);
    const state = await land.deliveryState(s.runId);
    assert.deepEqual(
      state.delivered && { url: state.delivered.url, number: state.delivered.number },
      delivered.ok ? { url: delivered.url, number: delivered.number } : null,
    );
  });

  it("shows a link pressed from one link on the card of the link that carries it on", async () => {
    const s = scene("carried");
    const delivered = await land.deliverRun(s.runId);
    assert.equal(delivered.ok, true, delivered.ok ? "" : delivered.reason);

    const next = continuation(s, "completed", 1);
    const state = await land.deliveryState(next);

    assert.equal(state.delivered?.url, delivered.ok ? delivered.url : "");
    assert.equal(state.delivered?.number, delivered.ok ? delivered.number : -1);
  });
});

describe("migrate carries a pull request delivered before the column existed", () => {
  /** A restart: `open()` runs `migrate` again against what is on disk. */
  function reboot(): void {
    const g = globalThis as { __ufDb?: { close(): void } };
    g.__ufDb?.close();
    delete g.__ufDb;
    dbMod.db();
  }

  it("backfills from the newest deliver event, and boots past a payload it cannot read", () => {
    const db = dbMod.db();
    const insertRun = db.prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                         created_at, isolation, repo_root, worktree_branch)
       VALUES (?, '/r', 'p', 'completed', '{}', 1, 1, ?, 'worktree', '/r', ?)`,
    );
    const insertEvent = db.prepare(
      "INSERT INTO run_events (run_id, ts, kind, payload) VALUES (?, ?, 'deliver', ?)",
    );
    insertRun.run("run-old", 1, "uf/old");
    insertEvent.run("run-old", 100, JSON.stringify({ url: "https://x/pull/1", number: 1 }));
    insertEvent.run("run-old", 200, JSON.stringify({ url: "https://x/pull/2", number: 2 }));
    insertRun.run("run-garbled", 2, "uf/garbled");
    insertEvent.run("run-garbled", 300, "{not json");
    insertRun.run("run-unnumbered", 3, "uf/unnumbered");
    insertEvent.run("run-unnumbered", 400, JSON.stringify({ url: "https://x/pull/3", number: "3" }));
    // The database as it was before the migration step existed.
    for (const col of ["delivered_pr_url", "delivered_pr_number", "delivered_at"]) {
      db.exec(`ALTER TABLE runs DROP COLUMN ${col}`);
    }

    reboot();

    const read = (id: string) =>
      dbMod
        .db()
        .prepare(
          "SELECT delivered_pr_url AS url, delivered_pr_number AS number, delivered_at AS at" +
            " FROM runs WHERE id = ?",
        )
        .get(id);
    assert.deepEqual(read("run-old"), { url: "https://x/pull/2", number: 2, at: 200 });
    assert.deepEqual(read("run-garbled"), { url: null, number: null, at: null });
    assert.deepEqual(read("run-unnumbered"), { url: null, number: null, at: null });
  });
});

/**
 * A SIGTERM that arrives while two deliveries are in flight.
 *
 * `landRun` reads `isShuttingDown()` and registers with `trackLand`, and
 * Deliver did neither: the shutdown did not wait for a push it had started, so
 * the process could exit with the branch published and the pull request never
 * opened, and it let a delivery whose check was still running go on to push
 * during the grace. One is held at the pull request, the other in its check.
 *
 * Held with a gate and a release file rather than timed with sleeps, so the
 * shutdown is certain to begin inside both. Last in the file because
 * `shutdownRuns` sets a flag nothing clears, and every case after it would run
 * in a process that is going down.
 */
describe("deliverRun on a checkout a later run reused, with a verify command set", () => {
  /** A later run's branch cut in the run's slot, as `allocateSlotPath` hands a clean one out. */
  function reuse(s: Scene): string {
    const later = `${s.branch}-later`;
    git(s.slot, "checkout", "-q", "-b", later, "main");
    return later;
  }

  /** A command that records which branch and which `shared.txt` it ran against. */
  function recordingCommand(name: string): string {
    const signals = path.join(root, "signals", name);
    fs.mkdirSync(signals, { recursive: true });
    const probe = path.join(root, `record-${name}.js`);
    fs.writeFileSync(
      probe,
      `const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const head = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" });
fs.writeFileSync(path.join(process.argv[2], "head"), head.trim());
fs.writeFileSync(path.join(process.argv[2], "shared"), fs.readFileSync("shared.txt", "utf8"));
`,
    );
    return `${process.execPath} ${probe} ${signals}`;
  }

  it("switches it to the run's branch for the check, pushes that branch and puts the slot back", async () => {
    const s = scene("reused-ok");
    const later = reuse(s);
    settings.saveSettings({ landVerifyCommand: recordingCommand("reused-ok") });

    const delivered = await land.deliverRun(s.runId);

    assert.equal(delivered.ok, true, delivered.ok ? "" : delivered.reason);
    const signals = path.join(root, "signals", "reused-ok");
    assert.equal(fs.readFileSync(path.join(signals, "head"), "utf8"), s.branch);
    assert.equal(fs.readFileSync(path.join(signals, "shared"), "utf8"), "branch\n");
    assert.equal(remoteTip(s), git(s.repo, "rev-parse", s.branch).trim());
    assert.equal(git(s.slot, "rev-parse", "--abbrev-ref", "HEAD").trim(), later);
  });

  it("refuses in Deliver's words while the later run's work is uncommitted, and pushes nothing", async () => {
    const s = scene("reused-dirty");
    const later = reuse(s);
    fs.writeFileSync(path.join(s.slot, "scratch.txt"), "the later run's\n");
    settings.saveSettings({ landVerifyCommand: recordingCommand("reused-dirty") });

    const delivered = await land.deliverRun(s.runId);

    assert.equal(delivered.ok, false);
    const reason = delivered.ok ? "" : delivered.reason;
    assert.ok(
      reason.includes(
        `It was not switched back to ${s.branch} for the check, because it holds 1 uncommitted ` +
          `path(s) from ${later}: scratch.txt. Nothing was delivered.`,
      ),
      reason,
    );
    assert.equal(remoteTip(s), null);
    assert.equal(opened.length, 0);
    assert.equal(git(s.slot, "rev-parse", "--abbrev-ref", "HEAD").trim(), later);
  });
});

describe("deliverRun at a shutdown", () => {
  it("finishes the delivery that has pushed, and pushes nothing for the one still in its check", async () => {
    const pushing = scene("pushing");
    const checking = scene("checking");
    const signals = path.join(root, "signals");
    fs.mkdirSync(signals, { recursive: true });
    const probe = path.join(root, "wait-probe.js");
    fs.writeFileSync(
      probe,
      `const fs = require("node:fs");
const path = require("node:path");
const dir = process.argv[2];
fs.writeFileSync(path.join(dir, "started"), "");
const deadline = Date.now() + 20000;
while (!fs.existsSync(path.join(dir, "go"))) {
  if (Date.now() > deadline) process.exit(3);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
`,
    );

    let releasePullRequest!: () => void;
    const gate = new Promise<void>((resolve) => {
      releasePullRequest = resolve;
    });
    let reachedPullRequest = false;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      reachedPullRequest = true;
      await gate;
      return stubFetch(input, init);
    }) as typeof fetch;

    try {
      // Pushed, and waiting on the API for its pull request. No command, so
      // nothing but the push stands between the press and that call.
      const pushed = land.deliverRun(pushing.runId);
      const deadline = Date.now() + 20_000;
      while (!reachedPullRequest) {
        if (Date.now() > deadline) assert.fail("the first delivery never reached its pull request");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(remoteTip(pushing), git(pushing.slot, "rev-parse", "HEAD").trim());

      // In its check: the command is read after the claim, so setting it now
      // reaches only the second press.
      settings.saveSettings({ landVerifyCommand: `${process.execPath} ${probe} ${signals}` });
      const held = land.deliverRun(checking.runId);
      while (!fs.existsSync(path.join(signals, "started"))) {
        if (Date.now() > deadline) assert.fail("the second delivery's check never started");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      let returned = false;
      const shutdown = orchestrator.shutdownRuns("SIGTERM").finally(() => {
        returned = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(returned, false, "the shutdown returned with a pushed branch and no pull request");

      releasePullRequest();
      const delivered = await pushed;
      assert.equal(delivered.ok, true, delivered.ok ? "" : delivered.reason);
      const row = dbMod
        .db()
        .prepare("SELECT delivered_pr_url AS url FROM runs WHERE id = ?")
        .get(pushing.runId) as { url: string | null };
      assert.equal(row.url, delivered.ok ? delivered.url : "");
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(returned, false, "the shutdown returned with a delivery still in its check");

      fs.writeFileSync(path.join(signals, "go"), "");
      const refused = await held;
      await shutdown;

      assert.equal(refused.ok, false);
      assert.equal(
        refused.ok ? "" : refused.reason,
        "The server is shutting down, so nothing was pushed and no pull request was opened. " +
          "Try again once it has restarted.",
      );
      assert.equal(remoteTip(checking), null);
      assert.deepEqual(
        opened.map(({ head }) => head),
        [pushing.branch],
      );
    } finally {
      globalThis.fetch = stubFetch;
      releasePullRequest();
    }
  });
});
