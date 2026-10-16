import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

/**
 * What Push sends from the operator's own checkout, and what the inventory
 * lists beside it, driven for real.
 *
 * `projects.test.ts` pins the decision; this pins that the decision is what
 * stands between the press and the remote, which no fixture can state. A push
 * that left with the wrong commit, or left when it should have been refused, or
 * wrote an upstream into `.git/config`, is invisible until somebody reads the
 * remote — so every scene reads it.
 *
 * Every remote is `https://github.com/acme/<name>.git`, written as git will
 * use it, and **git's https transport is replaced** for this process:
 * `GIT_EXEC_PATH` names a copy of git's own exec directory whose
 * `git-remote-https` is a stand-in that answers the remote-helper protocol with
 * `connect` and hands the connection to the local bare repository
 * `<root>/remotes/<name>.git`. Nothing reaches GitHub and no credential is ever
 * asked for, and the URL the decision reads is a real GitHub one. It has to be
 * done this way: every way of pointing a GitHub-looking URL at a local path
 * (`insteadOf`, `pushInsteadOf`, a path spelled `git@github.com/…`) is a way the
 * push check now refuses, because each is how a repository's own config could
 * send the token somewhere else.
 *
 * The process's own git configuration and credentials are cleared before the
 * first import: an agent's shell carries a `GIT_CONFIG_COUNT` block and a real
 * token, and neither may reach a test of the call that sends one.
 *
 * Its own file, with `DATA_DIR` and the token named before the first import,
 * for `loopMergeOwnership.test.ts`' reason: `config.ts` is read at module load.
 */

let projects: typeof import("./projects");
let land: typeof import("./land");
let dbMod: typeof import("./db");
let config: typeof import("./config");
let delivery: typeof import("./delivery");
let pushRoute: typeof import("../app/api/projects/push/route");
let root: string;
let mount: string;
let remotes: string;

for (const key of Object.keys(process.env)) {
  if (/^(GIT_|GH_|GITHUB_)/.test(key)) delete process.env[key];
}

const AUTHOR = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  // The operator's global config is not this test's: `init.defaultBranch`,
  // `push.followTags` or a hook path there would change what is measured.
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...AUTHOR } }).trim();

const gitMay = (cwd: string, ...args: string[]) => {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
};

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-projects-")));
  mount = path.join(root, "mount");
  fs.mkdirSync(mount);
  remotes = path.join(root, "remotes");
  fs.mkdirSync(remotes);
  process.env.GIT_EXEC_PATH = standInTransport();
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = mount;
  process.env.WORKSPACE_ROOTS = "";
  // A credential `planPush` accepts. It never leaves this process: every
  // remote here is a local path, which no credential helper is asked about.
  process.env.UF_GITHUB_TOKEN = "test-token-not-a-real-credential";
  process.env.UF_GITHUB_TOKENS = "";
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");
  // The app's own git children read the same configuration as the harness's.
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: AUTHOR.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: AUTHOR.GIT_CONFIG_NOSYSTEM,
  });

  config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );
  dbMod = await import("./db");
  land = await import("./land");
  projects = await import("./projects");
  delivery = await import("./delivery");
  pushRoute = await import("../app/api/projects/push/route");
});

/**
 * A copy of git's exec directory whose `git-remote-https` serves
 * `<remotes>/<name>.git` for any `https://…/<name>.git`. See the header.
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
  const open = (globalThis as { __ufDb?: { close(): void } }).__ufDb;
  open?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  dbMod.db().prepare("DELETE FROM runs").run();
});

interface Scene {
  name: string;
  repo: string;
  remote: string;
  ref: { mountId: string; folder: string };
}

/**
 * A checkout on `main` with one commit, its upstream `origin/main` in a bare
 * repository that has that commit, and nothing ahead or behind.
 */
function scene(name: string): Scene {
  const repo = path.join(mount, name);
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "shared.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");

  const url = urlOf(name);
  const remote = path.join(remotes, `${name}.git`);
  git(root, "init", "-q", "--bare", remote);
  git(repo, "remote", "add", "origin", url);
  git(repo, "push", "-q", "origin", "main:refs/heads/main");
  git(repo, "branch", "-q", "--set-upstream-to=origin/main", "main");

  // The guard every press stands on: the URL the decision reads is GitHub's,
  // and what reached the remote is the bare repository, so the stand-in
  // transport is what carried it.
  assert.equal(git(repo, "remote", "get-url", "--push", "origin"), url);
  assert.deepEqual(delivery.parseRemote(url), { owner: "acme", repo: name });
  assert.equal(git(remote, "rev-parse", "refs/heads/main"), head({ repo } as Scene));

  return { name, repo, remote, ref: { mountId: config.WORKSPACE_MOUNTS[0].id, folder: name } };
}

const urlOf = (name: string) => `https://github.com/acme/${name}.git`;

/** What the page showed for `s` on `branch` at `sha`, as the push route takes it. */
const shownAt = (sha: string, branch = "main") => ({
  branch,
  sha,
  remote: "origin",
  remoteRef: `refs/heads/${branch}`,
});

function commit(repo: string, file: string, content: string, message = file): string {
  fs.writeFileSync(path.join(repo, file), content);
  git(repo, "add", file);
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

const remoteMain = (s: Scene) => gitMay(s.remote, "rev-parse", "refs/heads/main");
const head = (s: Scene) => git(s.repo, "rev-parse", "HEAD");

async function project(s: Scene) {
  const inventory = await projects.projectInventory();
  const found = inventory.projects.find((p) => p.folder === s.name);
  assert.ok(found, `${s.name} is listed`);
  return found;
}

describe("Push sends what was shown, as a fast-forward, and nothing else", () => {
  it("pushes a branch ahead of its upstream: the sha shown, and only that", async () => {
    const s = scene("ahead");
    const sha = commit(s.repo, "a.txt", "a\n");
    fs.writeFileSync(path.join(s.repo, "draft.txt"), "not committed\n");
    const configBefore = fs.readFileSync(path.join(s.repo, ".git", "config"), "utf8");

    const before = await project(s);
    assert.equal(before.ahead, 1);
    assert.equal(before.behind, 0);
    assert.equal(before.uncommitted, 1);
    assert.deepEqual(before.push, { possible: true, code: null, reason: null });
    assert.deepEqual(before.unpushed, [{ sha, subject: "a.txt" }]);

    const pushed = await projects.pushProject(s.ref, shownAt(sha));

    assert.equal(pushed.ok, true, pushed.ok ? "" : pushed.reason);
    assert.equal(remoteMain(s), sha);
    // The uncommitted file stayed home, and the answer says so.
    assert.equal(gitMay(s.remote, "cat-file", "-e", `${sha}:draft.txt`), null);
    assert.match((pushed as { note: string }).note, /1 uncommitted path was not included/);
    // The local tracking ref moved with it, so the row reads level at once.
    assert.equal(git(s.repo, "rev-parse", "refs/remotes/origin/main"), sha);
    assert.equal(pushed.project.ahead, 0);
    assert.equal(pushed.project.push.code, "nothing-to-push");
    // No upstream was set or changed, and nothing else in the config moved.
    assert.equal(fs.readFileSync(path.join(s.repo, ".git", "config"), "utf8"), configBefore);
  });

  it("sends the sha shown even when a tag points into it, and never the tag", async () => {
    const s = scene("tags");
    const sha = commit(s.repo, "t.txt", "t\n");
    git(s.repo, "tag", "-a", "-m", "release", "v1", sha);
    git(s.repo, "config", "push.followTags", "true");

    const pushed = await projects.pushProject(s.ref, shownAt(sha));

    assert.equal(pushed.ok, true, pushed.ok ? "" : pushed.reason);
    assert.equal(remoteMain(s), sha);
    assert.equal(gitMay(s.remote, "rev-parse", "--verify", "-q", "refs/tags/v1"), null);
  });

  it("refuses a branch behind its upstream, after a fetch shows it", async () => {
    const s = scene("behind");
    // Somebody else's push, from a second clone.
    const other = path.join(root, "other-behind");
    git(root, "clone", "-q", "-b", "main", urlOf(s.name), other);
    const theirs = commit(other, "theirs.txt", "theirs\n");
    git(other, "push", "-q", "origin", "main");

    const stale = await project(s);
    assert.equal(stale.behind, 0, "before a fetch nothing local knows about it");
    assert.equal(stale.fetchedAt, null);

    const fetched = await projects.fetchProject(s.ref);
    assert.equal(fetched.ok, true, fetched.ok ? "" : fetched.reason);
    assert.equal(fetched.project.behind, 1);
    assert.ok(fetched.project.fetchedAt !== null && fetched.project.fetchedAt > 0);

    const mine = commit(s.repo, "mine.txt", "mine\n");
    const pushed = await projects.pushProject(s.ref, shownAt(mine));

    assert.equal(pushed.ok, false);
    assert.equal((pushed as { code: string }).code, "behind");
    assert.equal((pushed as { status: number }).status, 409);
    assert.equal(remoteMain(s), theirs, "nothing was pushed");
  });

  it("refuses when HEAD moved off the sha that was sent", async () => {
    const s = scene("moved");
    const shown = commit(s.repo, "one.txt", "1\n");
    commit(s.repo, "two.txt", "2\n");

    const pushed = await projects.pushProject(s.ref, shownAt(shown));

    assert.equal(pushed.ok, false);
    assert.equal((pushed as { code: string }).code, "moved");
    assert.notEqual(remoteMain(s), shown);
    assert.equal(remoteMain(s), git(s.repo, "rev-parse", "HEAD~2"), "nothing was pushed");
  });

  it("refuses when HEAD is another branch at the sha that was sent", async () => {
    const s = scene("switched");
    const sha = commit(s.repo, "one.txt", "1\n");
    git(s.repo, "switch", "-q", "-c", "elsewhere");

    const pushed = await projects.pushProject(s.ref, shownAt(sha));

    assert.equal((pushed as { code: string }).code, "moved");
    assert.notEqual(remoteMain(s), sha);
  });

  it("refuses mid-merge, naming the merge", async () => {
    const s = scene("merging");
    git(s.repo, "switch", "-q", "-c", "side");
    commit(s.repo, "shared.txt", "side\n");
    git(s.repo, "switch", "-q", "main");
    const sha = commit(s.repo, "shared.txt", "main\n");
    assert.equal(gitMay(s.repo, "merge", "-q", "side"), null, "the merge stops on its conflict");
    assert.ok(fs.existsSync(path.join(s.repo, ".git", "MERGE_HEAD")));

    const row = await project(s);
    assert.equal(row.operation, "merge");
    assert.equal(row.push.code, "operation");

    const pushed = await projects.pushProject(s.ref, shownAt(sha));

    assert.equal((pushed as { code: string }).code, "operation");
    assert.match((pushed as { reason: string }).reason, /merge/);
    assert.notEqual(remoteMain(s), sha);
  });

  it("refuses while a land holds the checkout, and pushes once it lets go", async () => {
    const s = scene("claimed");
    const sha = commit(s.repo, "c.txt", "c\n");
    const release = land.claimLanding(s.repo);
    assert.ok(release, "nothing else holds it");

    const refused = await projects.pushProject(s.ref, shownAt(sha));
    assert.equal((refused as { code: string }).code, "busy");
    assert.notEqual(remoteMain(s), sha);

    release!();
    const pushed = await projects.pushProject(s.ref, shownAt(sha));
    assert.equal(pushed.ok, true, pushed.ok ? "" : pushed.reason);
    assert.equal(remoteMain(s), sha);
  });

  it("refuses a push URL that is not GitHub even when the fetch URL is", async () => {
    const s = scene("pushurl");
    const sha = commit(s.repo, "p.txt", "p\n");
    const elsewhere = path.join(root, "elsewhere.git");
    git(root, "init", "-q", "--bare", elsewhere);
    git(s.repo, "remote", "set-url", "--push", "origin", elsewhere);

    const pushed = await projects.pushProject(s.ref, shownAt(sha));

    assert.equal((pushed as { code: string }).code, "not-github");
    assert.equal(gitMay(elsewhere, "rev-parse", "refs/heads/main"), null);
    assert.notEqual(remoteMain(s), sha);
  });

  it("refuses a branch deleted on the remote rather than creating it again", async () => {
    const s = scene("deleted");
    const sha = commit(s.repo, "d.txt", "d\n");
    git(s.remote, "update-ref", "-d", "refs/heads/main");

    const row = await project(s);
    assert.equal(row.push.possible, true, "the stale tracking ref still counts it ahead");

    const pushed = await projects.pushProject(s.ref, shownAt(sha));
    assert.equal((pushed as { code: string }).code, "upstream-gone");
    assert.equal(remoteMain(s), null, "nothing was created");
  });

  it("refuses when the remote moved and nothing has fetched it", async () => {
    const s = scene("unfetched");
    const other = path.join(root, "other-unfetched");
    git(root, "clone", "-q", "-b", "main", urlOf(s.name), other);
    const theirs = commit(other, "theirs.txt", "theirs\n");
    git(other, "push", "-q", "origin", "main");
    const mine = commit(s.repo, "mine.txt", "mine\n");

    assert.equal((await project(s)).push.possible, true, "the counts are as of the last fetch");
    const pushed = await projects.pushProject(s.ref, shownAt(mine));

    assert.equal((pushed as { code: string }).code, "behind");
    assert.match((pushed as { reason: string }).reason, /moved since the last fetch/);
    assert.equal(remoteMain(s), theirs);
  });

  it("refuses a remote with a second URL, which git would push to as well", async () => {
    const s = scene("two-urls");
    const sha = commit(s.repo, "u.txt", "u\n");
    const second = path.join(root, "second.git");
    git(root, "init", "-q", "--bare", second);
    git(s.repo, "config", "--add", "remote.origin.url", second);

    const pushed = await projects.pushProject(s.ref, shownAt(sha));

    assert.equal((pushed as { code: string }).code, "not-github");
    assert.equal(gitMay(second, "rev-parse", "refs/heads/main"), null);
    assert.notEqual(remoteMain(s), sha);
  });

  it("refuses a run's branch even with an upstream, because Deliver is its exit", async () => {
    const s = scene("run-branch");
    git(s.repo, "switch", "-q", "-c", "uf/run-branch-1-abcdef12");
    const sha = commit(s.repo, "r.txt", "r\n");
    git(s.repo, "push", "-q", "--set-upstream", "origin", "uf/run-branch-1-abcdef12");
    const more = commit(s.repo, "r2.txt", "r2\n");

    const row = await project(s);
    assert.equal(row.push.code, "run-branch");
    const pushed = await projects.pushProject(s.ref, shownAt(more, "uf/run-branch-1-abcdef12"));

    assert.equal((pushed as { code: string }).code, "run-branch");
    assert.equal(gitMay(s.remote, "rev-parse", "refs/heads/uf/run-branch-1-abcdef12"), sha);
  });

  it("acts only on a folder the inventory lists", async () => {
    const hidden = path.join(mount, ".hidden");
    fs.mkdirSync(hidden);
    git(hidden, "init", "-q", "-b", "main");
    const mountId = config.WORKSPACE_MOUNTS[0].id;

    const fetched = await projects.fetchProject({ mountId, folder: ".hidden" });
    assert.equal((fetched as { status: number }).status, 404);
    const pushed = await projects.pushProject(
      { mountId, folder: ".hidden" },
      shownAt("a".repeat(40)),
    );
    assert.equal((pushed as { status: number }).status, 404);
    fs.rmSync(hidden, { recursive: true });
  });

  it("answers a malformed body with a 400 before anything runs", async () => {
    const s = scene("route");
    const sha = commit(s.repo, "r.txt", "r\n");
    const post = (body: string) =>
      pushRoute.POST(
        new Request("http://localhost/api/projects/push", { method: "POST", body }),
      );

    for (const body of ["null", "{}", JSON.stringify({ ...s.ref, ...shownAt(sha), sha: "HEAD" })]) {
      const res = await post(body);
      assert.equal(res.status, 400, body);
    }
    assert.notEqual(remoteMain(s), sha);

    const res = await post(JSON.stringify({ ...s.ref, ...shownAt(sha) }));
    assert.equal(res.status, 200);
    assert.equal(remoteMain(s), sha);
  });
});

describe("the inventory lists every git folder and every unmerged branch", () => {
  it("lists a folder whose git fails with its error, beside the ones that read", async () => {
    const s = scene("healthy");
    const broken = path.join(mount, "broken-worktree");
    fs.mkdirSync(broken);
    fs.writeFileSync(path.join(broken, ".git"), "gitdir: /nowhere/.git/worktrees/broken\n");

    const inventory = await projects.projectInventory();
    const row = inventory.projects.find((p) => p.folder === "broken-worktree");

    assert.ok(row, "the broken folder is listed, not dropped");
    assert.match(row.error ?? "", /not a git repository/);
    assert.equal(row.push.code, "unreadable");
    assert.equal(row.fetch.code, "unreadable");
    assert.equal(inventory.projects.find((p) => p.folder === s.name)?.error, null);
    fs.rmSync(broken, { recursive: true });
  });

  it("splits unmerged branches into a run's and the rest, and leaves out a squash-landed one", async () => {
    const s = scene("branches");
    const base = head(s);

    // A run's branch still open, a run's branch squash-landed into main, and a
    // branch no run recorded.
    git(s.repo, "switch", "-q", "-c", "uf/open-1");
    commit(s.repo, "open.txt", "open\n");
    git(s.repo, "switch", "-q", "-c", "uf/squashed-2", "main");
    const squashedTip = commit(s.repo, "squashed.txt", "squashed\n");
    git(s.repo, "switch", "-q", "-c", "by-hand", "main");
    commit(s.repo, "h1.txt", "1\n");
    commit(s.repo, "h2.txt", "2\n");
    git(s.repo, "switch", "-q", "main");
    git(s.repo, "merge", "-q", "--squash", "uf/squashed-2");
    git(s.repo, "commit", "-q", "-m", "squash");
    const squashCommit = head(s);

    const insert = dbMod.db().prepare(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                         created_at, finished_at, isolation, repo_root, work_dir,
                         worktree_branch, worktree_base, worktree_base_branch,
                         landed_strategy, landed_tip, landed_commit, landed_at)
       VALUES (?, ?, ?, 'completed', '{}', 1, 1, ?, ?, 'worktree', ?, ?, ?, ?, 'main', ?, ?, ?, ?)`,
    );
    insert.run("run-open", s.repo, "Open work\nmore", Date.now(), Date.now(), s.repo, s.repo,
      "uf/open-1", base, null, null, null, null);
    insert.run("run-squashed", s.repo, "Squashed work", Date.now(), Date.now(), s.repo, s.repo,
      "uf/squashed-2", base, "squash", squashedTip, squashCommit, Date.now());

    const row = await project(s);

    assert.deepEqual(
      row.runBranches.map((b) => ({ branch: b.branch, runId: b.runId, task: b.task, ahead: b.ahead })),
      [{ branch: "uf/open-1", runId: "run-open", task: "Open work", ahead: 1 }],
    );
    assert.deepEqual(
      row.otherBranches.map((b) => ({ branch: b.branch, ahead: b.ahead })),
      [{ branch: "by-hand", ahead: 2 }],
    );
    assert.equal(row.branchesNotRead, 0);

    // The control: undo the squash, and the same branch is unmerged again.
    git(s.repo, "reset", "-q", "--hard", "HEAD~1");
    const undone = await project(s);
    assert.deepEqual(
      undone.runBranches.map((b) => b.branch).sort(),
      ["uf/open-1", "uf/squashed-2"],
    );
  });

  it("names the newest unpushed commits up to the cap, and counts the rest in ahead", async () => {
    const s = scene("many-ahead");
    const over = projects.MAX_UNPUSHED_LISTED + 2;
    const shas = Array.from({ length: over }, (_, i) => commit(s.repo, `m${i}.txt`, `${i}\n`, `change ${i}`));
    // A commit on a branch the push does not send, which must not be listed.
    git(s.repo, "switch", "-q", "-c", "elsewhere");
    commit(s.repo, "elsewhere.txt", "x\n");
    git(s.repo, "switch", "-q", "main");

    const row = await project(s);
    assert.equal(row.ahead, over);
    assert.deepEqual(
      row.unpushed,
      shas
        .slice(-projects.MAX_UNPUSHED_LISTED)
        .reverse()
        .map((sha) => ({ sha, subject: `change ${shas.indexOf(sha)}` })),
    );

    // Level with its upstream, nothing is listed.
    git(s.repo, "push", "-q", "origin", "main");
    assert.deepEqual((await project(s)).unpushed, []);
  });

  it("reads the upstream of a branch with no commits, and lets it fetch", async () => {
    const s = scene("seed-for-unborn");
    const repo = path.join(mount, "unborn");
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "remote", "add", "origin", urlOf(s.name));
    git(repo, "config", "branch.main.remote", "origin");
    git(repo, "config", "branch.main.merge", "refs/heads/main");

    const inventory = await projects.projectInventory();
    const row = inventory.projects.find((p) => p.folder === "unborn")!;
    assert.equal(row.head, null);
    assert.equal(row.upstream?.remoteRef, "refs/heads/main");
    assert.equal(row.fetch.possible, true, row.fetch.reason ?? "");
    assert.equal(row.push.code, "nothing-to-push");

    const fetched = await projects.fetchProject({ ...s.ref, folder: "unborn" });
    assert.equal(fetched.ok, true, fetched.ok ? "" : fetched.reason);
    assert.equal(git(repo, "rev-parse", "refs/remotes/origin/main"), remoteMain(s));
  });

  it("says a repository has no remote at all, apart from a branch with no upstream", async () => {
    const repo = path.join(mount, "no-remote");
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    commit(repo, "only.txt", "only\n");

    const inventory = await projects.projectInventory();
    const row = inventory.projects.find((p) => p.folder === "no-remote")!;
    assert.equal(row.error, null);
    assert.equal(row.upstream, null);
    assert.deepEqual(row.remotes, []);
    // An upstream names the remote, so the list is not read.
    assert.equal((await project(scene("with-remote"))).remotes, null);
  });

  it("never shows the credentials a remote URL was written with", async () => {
    const s = scene("secret-url");
    git(s.repo, "remote", "set-url", "origin", "https://x-access-token:not-a-real-secret@github.com/acme/secret-url.git");

    const row = await project(s);
    const wire = JSON.stringify(row);
    assert.doesNotMatch(wire, /not-a-real-secret|x-access-token/);
    assert.equal(row.upstream?.url, urlOf(s.name));
    assert.equal(row.upstream?.github, "acme/secret-url");
  });

  it("refuses Fetch and Push without an upstream, and never sets one", async () => {
    const s = scene("no-upstream");
    git(s.repo, "branch", "-q", "--unset-upstream", "main");
    const sha = commit(s.repo, "n.txt", "n\n");

    const row = await project(s);
    assert.equal(row.upstream, null);
    assert.deepEqual(row.remotes, ["origin"], "a remote is there; only the upstream is missing");
    assert.equal(row.ahead, null);
    assert.equal(row.push.code, "no-upstream");
    assert.equal(row.fetch.code, "no-upstream");

    const pushed = await projects.pushProject(s.ref, shownAt(sha));
    assert.equal((pushed as { code: string }).code, "moved", "the upstream on screen is gone");
    assert.equal(gitMay(s.repo, "config", "branch.main.remote"), null);
    assert.notEqual(remoteMain(s), sha);
  });
});
