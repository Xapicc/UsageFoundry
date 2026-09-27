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
 * repository under the test's own temporary directory**: `origin` reads as a
 * GitHub URL, which `planDelivery` requires, and `pushInsteadOf` sends the push
 * to the bare repository instead; every scene asserts that rewrite before it
 * presses. The pull request is opened by a stub standing in for `fetch`, so
 * nothing here reaches GitHub or its API.
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

const MOUNT_DIR = "deliver-mount";
const GITHUB_REMOTE = "https://github.com/acme/widget.git";
const PULLS_ENDPOINT = "https://api.github.com/repos/acme/widget/pulls";

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
  if (url !== PULLS_ENDPOINT) throw new Error(`the test's fetch stub refuses ${url}`);
  const body = JSON.parse(String(init?.body)) as { head: string; base: string; title: string };
  opened.push({ head: body.head, base: body.base, title: body.title });
  const number = 40 + opened.length;
  return new Response(
    JSON.stringify({ number, html_url: `https://github.com/acme/widget/pull/${number}` }),
    { status: 201, headers: { "content-type": "application/json" } },
  );
}) as typeof fetch;

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-deliver-")));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, MOUNT_DIR);
  process.env.WORKSPACE_ROOTS = "";
  // A credential `planDelivery` accepts. It never leaves this process: the push
  // goes to a local path, and the stub above answers the API call.
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
  /** The bare repository `origin`'s pushes are rewritten to. */
  remote: string;
}

/**
 * An isolated run with one commit on its branch, checked out in a slot where
 * `allocateSlotPath` would look for one, the operator's checkout on `main` and
 * clean, and `origin` reading as GitHub while pushing to a bare repository.
 */
function scene(name: string, status = "completed"): Scene {
  const repo = path.join(root, MOUNT_DIR, name);
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "shared.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "main").trim();

  const remote = path.join(root, "remotes", `${name}.git`);
  fs.mkdirSync(remote, { recursive: true });
  git(remote, "init", "-q", "--bare");
  git(repo, "remote", "add", "origin", GITHUB_REMOTE);
  git(repo, "config", `url.${remote}.pushInsteadOf`, GITHUB_REMOTE);
  // The guard every scene stands on: if the rewrite ever stopped applying, the
  // press below would aim at GitHub, so the test refuses to press at all.
  assert.equal(git(repo, "remote", "get-url", "--push", "origin").trim(), remote);
  assert.equal(git(repo, "remote", "get-url", "origin").trim(), GITHUB_REMOTE);

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
