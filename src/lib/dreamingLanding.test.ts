import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";

/**
 * Where a Dreaming night's notes go once the vault is a git repository.
 *
 * Every failure here is silent. A night that writes into the vault's own
 * checkout leaves modified and untracked notes there, and `land.ts` then refuses
 * every land of every other branch into the vault as "uncommitted changes". A
 * night that claims its signatures when the run starts, but works on a branch,
 * suppresses a signature for a note that a refused land never delivers, so the
 * note is never written and nothing says so. A branch nothing queues is a night
 * that wrote nothing into the vault while the pane reads "run started".
 *
 * Real repositories and the real merge worker, and no stand-in for either: what
 * is under test is the hand-off between the ledger, `runs`, `merge_queue` and git,
 * and a copy of any of them in a test would be the copy that stayed right. The
 * agent's own work is a commit made on the run's branch by hand, which is the one
 * thing a unit test cannot start, and `maxConcurrentRuns: 0` keeps the run itself
 * from being spawned.
 *
 * Its own file for `mountRootIsolation.test.ts`'s reasons: `config.ts` reads
 * `DATA_DIR` and `WORKSPACE_ROOTS` once at load, and it needs mounts that are
 * repositories, with a global git config of its own.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-dreaming-landing-")));
const vault = path.join(tmp, "vault");
const plain = path.join(tmp, "plain");
const unignored = path.join(tmp, "unignored");
for (const dir of [vault, plain, unignored, path.join(tmp, "claude", "projects")]) {
  fs.mkdirSync(dir, { recursive: true });
}

const globalConfig = path.join(tmp, "gitconfig");
fs.writeFileSync(globalConfig, "[user]\n\tname = Test\n\temail = test@example.invalid\n");
process.env.GIT_CONFIG_GLOBAL = globalConfig;
// An agent's shell carries git config in the environment, which outranks the file.
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_CONFIG_") && key !== "GIT_CONFIG_GLOBAL") delete process.env[key];
}

process.env.WORKSPACE_ROOTS = `Vault=${vault}|Plain=${plain}|Unignored=${unignored}`;
process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");
process.env.CLAUDE_BIN = path.join(tmp, "no-such-claude");

// `require`, not `import`: imports are hoisted above the environment above.
const config = require("./config") as typeof import("./config");
assert.equal(
  config.DATA_DIR,
  process.env.DATA_DIR,
  "config was already loaded by another test file in this process; refusing to run against the real database",
);

const { startDreamingWriter, runDreamingNight, tickDreaming } =
  require("./dreamingRun") as typeof import("./dreamingRun");
const { settleDreamingLandings } = require("./dreamingLanding") as typeof import("./dreamingLanding");
const { pendingLandings } = require("./dreamingLedger") as typeof import("./dreamingLedger");
const { isQueueActive, latestQueueRowFor } = require("./mergeQueue") as typeof import("./mergeQueue");
const { getSettings, saveSettings } = require("./settings") as typeof import("./settings");
const { WORKTREE_STORE_DIR } = require("./worktreeStoreDir") as typeof import("./worktreeStoreDir");
const { db } = require("./db") as typeof import("./db");

import type { SignatureRollup } from "./dreaming";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makeRepo(dir: string, gitignore: string | null): void {
  git(dir, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(dir, "README.md"), "seed\n");
  if (gitignore !== null) fs.writeFileSync(path.join(dir, ".gitignore"), gitignore);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "seed"]);
}

makeRepo(vault, `${WORKTREE_STORE_DIR}/\n`);
makeRepo(unignored, null);

saveSettings({ maxConcurrentRuns: 0, dreamingEnabled: true, dreamingMaxCostUSD: 2 });

const NIGHT = "2026-10-24";

const rollup = (signature: string): SignatureRollup => ({
  signature,
  sample: `sample of ${signature}`,
  days: ["2026-10-01", "2026-10-02"],
  instances: 3,
  sessions: ["s1"],
});

interface RunInfo {
  id: string;
  isolation: string | null;
  branch: string | null;
  base: string | null;
}

function runInfo(runId: string): RunInfo {
  return db()
    .prepare(
      "SELECT id, isolation, worktree_branch AS branch, worktree_base AS base FROM runs WHERE id = ?",
    )
    .get(runId) as RunInfo;
}

function startNight(mount: string, root: string, signatures: string[]) {
  const settings = { ...getSettings(), knowledgeBaseMountId: mount };
  return startDreamingWriter({
    night: NIGHT,
    now: Date.now(),
    origin: "form",
    root,
    settings,
    selected: signatures.map(rollup),
  });
}

/**
 * What the agent would have done: write a note on the run's branch and commit
 * it, then the run ends. The branch is cut by hand because the run never
 * started, and the vault's own checkout is left on `main` as it found it.
 */
function endRun(runId: string, opts: { note: string | null; status?: string }): void {
  const run = runInfo(runId);
  if (opts.note === null) {
    // A real run has its branch from the moment it starts, written to or not.
    git(vault, ["branch", run.branch!, run.base!]);
  } else {
    git(vault, ["checkout", "-q", "-b", run.branch!, run.base!]);
    fs.mkdirSync(path.join(vault, "Notes"), { recursive: true });
    fs.writeFileSync(path.join(vault, "Notes", opts.note), `# ${opts.note}\n`);
    git(vault, ["add", "-A"]);
    git(vault, ["commit", "-q", "-m", `note ${opts.note}`]);
    git(vault, ["checkout", "-q", "main"]);
  }
  db()
    .prepare("UPDATE runs SET status = ?, finished_at = ? WHERE id = ?")
    .run(opts.status ?? "completed", Date.now(), runId);
}

/** Wait until the worker owes the run's newest queue row nothing. */
async function queueSettles(runId: string, ms = 30_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const row = latestQueueRowFor(runId);
    if (row && !isQueueActive(row.status)) return row;
    if (Date.now() > deadline) return row;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const queueRowCount = (runId: string) =>
  (db().prepare("SELECT COUNT(*) AS n FROM merge_queue WHERE run_id = ?").get(runId) as { n: number }).n;
const claimed = (runId: string) =>
  db()
    .prepare("SELECT signature, prompt_item AS item FROM dreaming_notes WHERE run_id = ? ORDER BY prompt_item")
    .all(runId) as { signature: string; item: number }[];

afterEach(async () => {
  // A worker still draining a row would race the next case's reset.
  for (const row of db().prepare("SELECT DISTINCT run_id FROM merge_queue").all() as { run_id: string }[]) {
    await queueSettles(row.run_id);
  }
  for (const table of ["merge_queue", "dreaming_pending", "dreaming_notes", "dreaming_nights", "runs"]) {
    db().prepare(`DELETE FROM ${table}`).run();
  }
  git(vault, ["checkout", "-q", "-f", "main"]);
  git(vault, ["clean", "-fdq"]);
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("a night in a vault that can be isolated", () => {
  it("works on a branch and holds its signatures instead of claiming them", () => {
    const result = startNight("vault", vault, ["a", "b"]);

    assert.equal(result.outcome, "selected");
    const run = runInfo(result.runId!);
    assert.equal(run.isolation, "worktree");
    assert.ok(run.branch, "an isolated run has a branch");
    assert.deepEqual(
      pendingLandings().map((p) => [p.runId, p.night, p.selected.map((s) => s.signature)]),
      [[result.runId, NIGHT, ["a", "b"]]],
    );
    assert.deepEqual(claimed(result.runId!), [], "nothing is claimed before anything has landed");
  });

  it("queues the branch once its run has ended, lands it, and only then claims", async () => {
    const result = startNight("vault", vault, ["a", "b"]);
    const runId = result.runId!;

    // The run is still going: nothing to queue and nothing to claim.
    const early = await settleDreamingLandings({ revisit: false });
    assert.equal(early[0].result.kind, "waiting");
    assert.equal(queueRowCount(runId), 0);

    endRun(runId, { note: "Agent Error Memory.md" });
    const queued = await settleDreamingLandings({ revisit: false });
    assert.equal(queued[0].result.kind, "queued");
    assert.equal(queueRowCount(runId), 1);
    // Queued is not landed, so the ledger is still empty.
    assert.deepEqual(claimed(runId), []);

    const row = await queueSettles(runId);
    assert.equal(row?.status, "landed", row?.message ?? "");

    const done = await settleDreamingLandings({ revisit: false });
    assert.equal(done[0].result.kind, "claimed");
    assert.deepEqual(
      claimed(runId).map((c) => [c.signature, c.item]),
      [["a", 1], ["b", 2]],
      "each row keeps the place it had in the prompt, which reconcileDreamingNotes reads",
    );
    assert.deepEqual(pendingLandings(), []);

    // The point of the change: the note is in the vault and the checkout is clean.
    assert.ok(fs.existsSync(path.join(vault, "Notes", "Agent Error Memory.md")));
    assert.equal(git(vault, ["status", "--porcelain"]), "");
    assert.equal(queueRowCount(runId), 1, "a claimed night is not queued a second time");
  });

  it("claims nothing when the land is refused, and the next night tries again", async () => {
    const result = startNight("vault", vault, ["a"]);
    const runId = result.runId!;
    endRun(runId, { note: "Standing Failures.md" });

    // The operator's own uncommitted note, which is what makes a land refuse.
    fs.writeFileSync(path.join(vault, "Operator note.md"), "mid-sentence\n");

    assert.equal((await settleDreamingLandings({ revisit: false }))[0].result.kind, "queued");
    const refused = await queueSettles(runId);
    assert.notEqual(refused?.status, "landed");
    assert.deepEqual(claimed(runId), [], "a refused land must not mark the signature handled");
    assert.equal(pendingLandings().length, 1, "and must not lose the night's selection");

    // The minute tick does not retry a refusal.
    assert.equal((await settleDreamingLandings({ revisit: false }))[0].result.kind, "waiting");
    assert.equal(queueRowCount(runId), 1);

    // The next night does, and is refused while the branch is still out.
    saveSettings({ knowledgeBaseMountId: "vault" });
    const night = await runDreamingNight({ origin: "form" });
    assert.equal(night.outcome, "refused");
    assert.match(night.reason ?? "", /has not landed in the vault yet/);
    assert.equal(night.runId, runId);
    assert.equal(queueRowCount(runId), 2);
    await queueSettles(runId);

    // Once the operator's checkout is clean, the following night lands it.
    fs.rmSync(path.join(vault, "Operator note.md"));
    assert.equal((await settleDreamingLandings({ revisit: true }))[0].result.kind, "queued");
    assert.equal((await queueSettles(runId))?.status, "landed");
    assert.equal((await settleDreamingLandings({ revisit: false }))[0].result.kind, "claimed");
    assert.deepEqual(claimed(runId).map((c) => c.signature), ["a"]);
  });

  it("is queued by the nightly timer's tick, not only by the start of a night", async () => {
    const result = startNight("vault", vault, ["a"]);
    endRun(result.runId!, { note: "Tick.md" });

    await tickDreaming();

    assert.equal(queueRowCount(result.runId!), 1);
    assert.equal((await queueSettles(result.runId!))?.status, "landed");
  });

  it("claims for a night an operator landed by hand", async () => {
    const result = startNight("vault", vault, ["a"]);
    endRun(result.runId!, { note: "By hand.md" });
    db().prepare("UPDATE runs SET landed_at = ? WHERE id = ?").run(Date.now(), result.runId);

    assert.equal((await settleDreamingLandings({ revisit: false }))[0].result.kind, "claimed");
    assert.equal(queueRowCount(result.runId!), 0, "nothing was queued over a land that had happened");
  });

  it("claims for a night that wrote nothing, as a night always has", async () => {
    const result = startNight("vault", vault, ["a", "b"]);
    endRun(result.runId!, { note: null });

    assert.equal((await settleDreamingLandings({ revisit: false }))[0].result.kind, "claimed");
    assert.equal(claimed(result.runId!).length, 2);
    assert.equal(queueRowCount(result.runId!), 0);
  });

  it("leaves a night the operator stopped for them, and lets it go once the branch is purged", async () => {
    const result = startNight("vault", vault, ["a"]);
    const runId = result.runId!;
    endRun(runId, { note: "Half done.md", status: "stopped" });

    const stopped = await settleDreamingLandings({ revisit: true });
    assert.equal(stopped[0].result.kind, "waiting");
    assert.equal(queueRowCount(runId), 0, "a stopped night is not landed on the operator's behalf");
    assert.deepEqual(claimed(runId), []);

    git(vault, ["branch", "-D", runInfo(runId).branch!]);
    assert.equal((await settleDreamingLandings({ revisit: true }))[0].result.kind, "dropped");
    assert.deepEqual(pendingLandings(), []);
    assert.deepEqual(claimed(runId), [], "a purged night's signatures are free for a later night");
  });

  it("lets go of a night whose run has been deleted", async () => {
    const result = startNight("vault", vault, ["a"]);
    db().prepare("DELETE FROM runs WHERE id = ?").run(result.runId);

    assert.equal((await settleDreamingLandings({ revisit: false }))[0].result.kind, "dropped");
    assert.deepEqual(pendingLandings(), []);
  });
});

describe("a night in a vault that cannot be isolated", () => {
  it("works in the folder and claims at the start, as before, when it is not a repository", () => {
    const result = startNight("plain", plain, ["a", "b"]);

    assert.equal(result.outcome, "selected");
    const run = runInfo(result.runId!);
    assert.equal(run.isolation, "none");
    assert.equal(run.branch, null);
    assert.deepEqual(pendingLandings(), []);
    assert.deepEqual(
      claimed(result.runId!).map((c) => [c.signature, c.item]),
      [["a", 1], ["b", 2]],
    );
  });

  it("does the same for a repository at the mount root that does not ignore the checkout store", () => {
    const result = startNight("unignored", unignored, ["a"]);

    assert.equal(runInfo(result.runId!).isolation, "none");
    assert.deepEqual(pendingLandings(), []);
    assert.equal(claimed(result.runId!).length, 1);
  });
});
