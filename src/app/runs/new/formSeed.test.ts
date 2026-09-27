import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { RunDTO } from "@/lib/apiTypes";
import { seedFromRun } from "./formSeed";

/**
 * What *Start another like this* copies, pinned where copying it wrong is
 * silent.
 *
 * The isolation case is the one this file exists for. `createRun` writes a
 * null `isolation` for a run that asked for a worktree and never had its
 * workspace planned, and the orchestrator reads that null as "isolate" at
 * release. Seeded as `isolation === "worktree"`, the copy landed on "This
 * folder" on a git repository: an agent in the operator's own checkout with no
 * mark on the form, since the seed's own value is never an override.
 */

/** A run that finished in a worktree; each case moves one field off it. */
const RUN: RunDTO = {
  id: "0123456789abcdef",
  folder: "/workspace/app",
  mountId: "workspace",
  relPath: "app",
  prompt: "Update dependencies and fix what breaks.",
  model: "claude-sonnet-5",
  provider: "claude",
  status: "completed",
  budget: {
    maxWeeklyFraction: null,
    maxSessionFraction: null,
    maxRunCostUSD: 5,
    maxRunCostFactor: null,
    maxRunTokens: null,
    maxIterations: 5,
    maxDurationMinutes: null,
    enforcement: "between-cycles",
    continueAfterDone: false,
    permissionMode: "acceptEdits",
  },
  max_iterations: 5,
  iterations: 3,
  created_at: 0,
  started_at: 0,
  finished_at: 0,
  stop_reason: null,
  exit_code: 0,
  spent_usd: 1,
  spent_tokens: 1000,
  isolation: "worktree",
};

test("a run whose workspace was never planned is copied as isolated", () => {
  assert.equal(seedFromRun({ ...RUN, isolation: null }).isolate, true);
});

test("a worktree is copied as isolated, and a run that worked in place is not", () => {
  assert.equal(seedFromRun(RUN).isolate, true);
  // "none" is what the run did — including one that asked for a worktree on a
  // folder that was not a repository — and the copy is of that arrangement.
  assert.equal(seedFromRun({ ...RUN, isolation: "none" }).isolate, false);
});

test("a run whose mount is gone carries no folder, rather than one relative to nothing", () => {
  const seed = seedFromRun({ ...RUN, mountId: null, relPath: undefined });
  assert.equal(seed.mountId, null);
  assert.equal(seed.folder, null);
  // The mount root is a real answer, and distinct from "no folder".
  assert.equal(seedFromRun({ ...RUN, relPath: "" }).folder, "");
});
