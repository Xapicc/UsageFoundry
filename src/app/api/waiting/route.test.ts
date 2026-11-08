import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { WaitingDTO } from "../../../lib/apiTypes";

/**
 * `GET /api/waiting` counts what the dashboard's strip will print, and each
 * count has to be the one its own page lists by.
 *
 * What goes wrong is silent in both directions: a run counted that the runs page
 * would not show, a claimed task counted as open, or a count that failed and
 * came back as 0 so the strip says nothing is waiting. The route answers 200 with
 * a plausible number whichever way it is wrong.
 *
 * Its own file with `DATA_DIR` named before the first import, for
 * `src/app/api/runs/route.test.ts`'s reason, and over a real git repository
 * because "ready to land" is git's answer about a branch, not a column.
 */

let root: string;
let get: () => Promise<WaitingDTO>;
let runSql: (sql: string, ...args: unknown[]) => void;

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...IDENTITY },
  }).trim();
}

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-waiting-route-")));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = workspace;
  process.env.WORKSPACE_ROOTS = `Scratch=${workspace}`;
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");

  const config = await import("../../../lib/config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );
  const { db } = await import("../../../lib/db");
  const { GET } = await import("./route");

  get = async () => {
    const res = await GET();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    return (await res.json()) as WaitingDTO;
  };
  runSql = (sql, ...args) => {
    db().prepare(sql).run(...args);
  };

  // A repository whose `main` is ahead of nothing and which holds three branches:
  // one a commit ahead of it (offered for landing), one already merged, and one
  // whose ref is not there at all.
  const repo = path.join(workspace, "repo");
  fs.mkdirSync(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  const base = git(repo, ["rev-parse", "main"]);
  git(repo, ["branch", "uf/merged"]);
  git(repo, ["checkout", "-q", "-b", "uf/ahead"]);
  fs.writeFileSync(path.join(repo, "a.txt"), "the run's line\n");
  git(repo, ["commit", "-qam", "the run's work"]);
  git(repo, ["checkout", "-q", "main"]);

  const insertBranchRun = (id: string, branch: string) =>
    runSql(
      `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, iterations,
                         created_at, finished_at, isolation, repo_root, worktree_branch,
                         worktree_base, worktree_base_branch)
       VALUES (?, ?, 'do the thing', 'completed', '{}', 1, 1, ?, ?, 'worktree', ?, ?, ?, 'main')`,
      id,
      repo,
      NOW - 3 * DAY,
      NOW - 3 * DAY,
      repo,
      branch,
      base,
    );
  insertBranchRun("run-ahead", "uf/ahead");
  insertBranchRun("run-merged", "uf/merged");
  insertBranchRun("run-gone", "uf/never-created");
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function insertRun(id: string, status: string, settledAt: number | null) {
  runSql(
    `INSERT INTO runs (id, folder, prompt, status, budget, max_iterations, created_at, finished_at)
     VALUES (?, ?, 'do the thing', ?, '{}', 1, ?, ?)`,
    id,
    path.join(root, "workspace"),
    status,
    NOW - 40 * DAY,
    settledAt,
  );
}

function insertTask(id: string, status: string, operatorOnly: number) {
  runSql(
    `INSERT INTO tasks (id, title, body, status, priority, origin, operator_only, created_at, updated_at)
     VALUES (?, ?, 'brief', ?, 'normal', 'operator', ?, 0, 0)`,
    id,
    id,
    status,
    operatorOnly,
  );
}

describe("GET /api/waiting", () => {
  it("counts each place the way its own page does, and leaves out what that page would not list", async () => {
    // Needs review: any age, since a person is still being asked.
    insertRun("nr-new", "needs-review", NOW - HOUR);
    insertRun("nr-old", "needs-review", NOW - 30 * DAY);
    // Failed: one inside the last 24 hours on either side of the middle of it,
    // one an hour outside, and a stopped run is not a failed one. Not placed on
    // the boundary itself — the route reads its own clock, a few ms after this.
    insertRun("f-recent", "failed", NOW - HOUR);
    insertRun("f-late", "failed", NOW - 23 * HOUR);
    insertRun("f-old", "failed", NOW - 25 * HOUR);
    insertRun("s-recent", "stopped", NOW - HOUR);
    insertRun("c-recent", "completed", NOW - HOUR);

    // Proposals: pending only, in any chat.
    runSql("INSERT INTO chat_sessions (id, created_at, updated_at) VALUES ('chat-1', 0, 0)");
    runSql("INSERT INTO chat_sessions (id, created_at, updated_at) VALUES ('chat-2', 0, 0)");
    const proposal = (id: string, chat: string, status: string) =>
      runSql(
        `INSERT INTO chat_proposals (id, chat_id, created_at, title, task, status)
         VALUES (?, ?, 0, 't', 'task', ?)`,
        id,
        chat,
        status,
      );
    proposal("p1", "chat-1", "pending");
    proposal("p2", "chat-2", "pending");
    proposal("p3", "chat-1", "approved");
    proposal("p4", "chat-1", "rejected");
    proposal("p5", "chat-2", "superseded");

    // Tasks: open and operator-only. Not claimed, not closed, not agent work.
    insertTask("t-open-op-1", "open", 1);
    insertTask("t-open-op-2", "open", 1);
    insertTask("t-open-agent", "open", 0);
    insertTask("t-claimed-op", "claimed", 1);
    insertTask("t-done-op", "done", 1);

    const waiting = await get();

    assert.deepEqual(waiting.needsReview, { state: "exact", count: 2 });
    assert.deepEqual(waiting.failedRecently, { state: "exact", count: 2 });
    assert.deepEqual(waiting.proposals, { state: "exact", count: 2 });
    assert.deepEqual(waiting.tasks, { state: "exact", count: 2 });
    assert.ok(Math.abs(waiting.failedSince - (NOW - DAY)) < 60_000, "the window is the last 24 hours");
  });

  it("counts only a branch the branches page would offer a tick box for", async () => {
    // One a commit ahead; `uf/merged` is on main already and `uf/never-created`
    // has no ref, so neither is offered.
    const { branches } = await get();
    assert.deepEqual(branches, { state: "exact", count: 1 });
  });

  it("names a count it could not read as unknown, and still answers for the others", async () => {
    // A table that cannot be read stands in for any read that fails. Dropped
    // last, since nothing after this needs proposals.
    runSql("DROP TABLE chat_proposals");

    const waiting = await get();

    assert.equal(waiting.proposals.state, "unknown");
    assert.ok("reason" in waiting.proposals && waiting.proposals.reason.length > 0);
    assert.deepEqual(waiting.needsReview, { state: "exact", count: 2 });
    assert.deepEqual(waiting.tasks, { state: "exact", count: 2 });
    assert.deepEqual(waiting.branches, { state: "exact", count: 1 });
  });
});
