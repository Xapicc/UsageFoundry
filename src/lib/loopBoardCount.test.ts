import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * Covers the one silent failure in a loop block's board condition: the folder
 * it counts against has to be canonicalised the way the board's own writer
 * canonicalises the folder it stores.
 *
 * `tasks.folder` holds the absolute path `resolveTaskFolder` proved when the
 * task was filed, and `listTasks` matches that column **exactly** —
 * `normalizeTaskListQuery` deliberately does not re-resolve, because every
 * other reader is already holding a canonical path the board handed it. A
 * workflow node is not: it holds a path *within* its mount, exactly as the
 * folder it runs in does. Compare the two unresolved and `repos/app` never
 * equals `/workspace/repos/app`, the count is zero for every project for ever,
 * and every loop with a condition stops before its first pass.
 *
 * Nothing about that throws, nothing fails to typecheck, and the failure looks
 * precisely like a backlog that is already clear — which is a legitimate answer
 * and the one the operator asked the condition to detect. So the defect
 * presents as the feature working, on the run it was supposed to save.
 *
 * It therefore opens a database and a real directory tree rather than testing
 * the comparison alone: the bug lives in the gap between two resolvers, and a
 * fake for either one is a place to reproduce the mistake rather than catch it.
 * A task goes in through `normalizeTaskInput` and `createTask` — the pair every
 * real door is — and is counted back through `loopBoardCount` off a node
 * spelled the way a saved graph spells one.
 *
 * Its own file, with `DATA_DIR` and the workspace root named before the first
 * import, for `assistBudget.test.ts`'s reason — `config.ts` fixes both at
 * module load, and the assertion in `before` is what keeps a change to that
 * from running against the operator's own board.
 */

let tasks: typeof import("./tasks");
let workflows: typeof import("./workflows");
let workflowGraph: typeof import("./workflowGraph");
let root: string;
let mountId: string;

/** The workspace directory's basename, which is also the mount's id. */
const MOUNT_DIR = "board-mount";

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "uf-loop-board-"));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.CLAUDE_HOME = path.join(root, "claude");
  process.env.WORKSPACE_ROOT = path.join(root, MOUNT_DIR);
  // Cleared, not overridden: `WORKSPACE_ROOTS` wins whenever it is set, so an
  // operator's own mounts inherited from the shell would otherwise be the ones
  // this counts against — `fleet.test.ts` clears it for the same reason.
  process.env.WORKSPACE_ROOTS = "";
  process.env.CLAUDE_BIN = path.join(root, "no-such-claude");
  // Real directories, because `resolveTaskFolder` resolves against the
  // filesystem and a path that is not there is refused rather than counted.
  // `backlogWeb` is the subtree trap's other half: its canonical path is
  // `backlog`'s with three more characters on it, so a prefix match written
  // without the separator counts its tasks as `backlog`'s.
  for (const folder of ["backlog", "backlog/docs", "backlogWeb", "elsewhere"]) {
    fs.mkdirSync(path.join(root, MOUNT_DIR, folder), { recursive: true });
  }

  const config = await import("./config");
  assert.equal(
    config.DATA_DIR,
    process.env.DATA_DIR,
    "config was already loaded by another test file in this process — refusing " +
      "to run against the real database",
  );
  mountId = config.WORKSPACE_MOUNTS[0].id;
  assert.equal(mountId, MOUNT_DIR, "the temp workspace is the only mount");

  await import("./db");
  tasks = await import("./tasks");
  workflowGraph = await import("./workflowGraph");
  workflows = await import("./workflows");
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const OPERATOR = { kind: "operator" } as const;

let seq = 0;

/**
 * A task filed the way the board's own doors file one.
 *
 * Through `normalizeTaskInput` and not straight into `createTask`, because the
 * resolution under test happens *there*: `createTask` writes the folder it is
 * handed, and every real door hands it the absolute path this returns. A
 * fixture that skipped it would store `backlog`, which is exactly the spelling
 * the defect compares against — the test would pass on the broken reader.
 */
function fileTask(
  folder: string,
  priority: import("./apiTypes").TaskPriorityDTO = "normal",
): string {
  const input = tasks.normalizeTaskInput(
    {
      title: `Task ${(seq += 1)}`,
      body: "Something for a loop to work through.",
      mountId,
      folder,
      priority,
    },
    { origin: "operator", createdByRunId: null },
  );
  if (!input.ok) throw new Error(input.error);
  const created = tasks.createTask(input.value);
  if (!created.ok) throw new Error(created.error);
  return created.task.id;
}

/**
 * A loop node as a saved graph carries one: the folder the condition counts is
 * inside the mount, and the loop itself is told nothing — it frames the section
 * beside it, which is the smallest one a graph may carry.
 */
function loopNode(
  condition: Partial<import("./workflowGraph").LoopBoardCondition> | null,
): import("./workflowGraph").WorkflowNode {
  const value = workflowGraph.normalizeWorkflowInput(
    {
      name: `Loop ${(seq += 1)}`,
      graph: {
        nodes: [
          {
            id: "a",
            name: "Chip away at it",
            kind: "loop",
            maxPasses: 3,
            stopWhenTasks: condition && {
              mountId,
              folder: "backlog",
              statuses: ["open"],
              thresholds: [{ priority: "any", atMost: 0 }],
              ...condition,
            },
          },
          {
            id: "b",
            name: "Take one off the board",
            mountId,
            folder: "backlog",
            task: "work",
          },
          { id: "m", name: "Land it", kind: "merge", mergeStrategy: "merge" },
        ],
        edges: [
          { from: "a", to: "b", edge: "repeats", continueBranch: false },
          { from: "b", to: "m", edge: "on-success", continueBranch: false },
        ],
      },
    },
    {
      templates: new Map(),
      mountIds: [mountId],
      defaultIsolate: true,
      agents: new Map(),
    },
  );
  // Through the normalizer rather than hand-built, so the node under test is
  // the one a save would have written and not a shape only this file makes.
  if (!value.ok) throw new Error(value.error);
  return value.value.graph.nodes[0];
}

function counts(
  condition: Partial<import("./workflowGraph").LoopBoardCondition> | null,
): import("./workflows").LoopBoardCounts | null {
  const reading = workflows.loopBoardCount(loopNode(condition));
  if (!reading.ok) throw new Error(reading.error);
  return reading.counts;
}

/** The project's whole count, which is what an `any` threshold reads. */
function count(
  condition: Partial<import("./workflowGraph").LoopBoardCondition> | null,
): number | null {
  return counts(condition)?.total ?? null;
}

/* ------------------------------------------------------------------ */
/* The tests                                                           */
/* ------------------------------------------------------------------ */

describe("loopBoardCount — counting a project's board from a node", () => {
  it("counts a task the ordinary door filed against that folder", () => {
    // The whole defect, in one assertion: the node says `backlog` and the row
    // says the absolute path under the mount. Compared unresolved this is 0.
    const before = count({}) ?? 0;
    fileTask("backlog");
    assert.equal(count({}), before + 1);
  });

  it("counts nothing for a sibling folder in the same mount", () => {
    // The other half of the same claim. A reader that resolved neither side
    // would also return 0 here, so this passes only beside the one above it.
    const before = count({ folder: "elsewhere" }) ?? 0;
    fileTask("backlog");
    assert.equal(count({ folder: "elsewhere" }), before);
  });

  it("counts the mount root, which a node spells as the empty folder", () => {
    // `""` is a folder and not an absence, and it is the one the board writes
    // for a run working at the top of a workspace.
    const before = count({ folder: "" }) ?? 0;
    fileTask(".");
    assert.equal(count({ folder: "" }), before + 1);
    // And it is not a wildcard: a task one level down is a different project.
    fileTask("backlog");
    assert.equal(count({ folder: "" }), before + 1);
  });

  it("sums the named statuses and reads no page to do it", () => {
    const openOnly = count({}) ?? 0;
    const both = count({ statuses: ["open", "claimed"] }) ?? 0;

    const id = fileTask("backlog");
    const claimed = tasks.updateTask(
      id,
      { status: "claimed", claimRunId: "run-for-this-task" },
      OPERATOR,
    );
    assert.equal(claimed.ok, true, claimed.ok ? "" : claimed.error);

    // A claim moves the task between the two counts rather than into both:
    // the statuses are disjoint, which is what makes summing them safe.
    assert.equal(count({}), openOnly);
    assert.equal(count({ statuses: ["open", "claimed"] }), both + 1);
  });

  it("does not count a task that was closed", () => {
    // `done` is the reason the two terminal statuses are refused at save: this
    // count falls, and the growing one it would have to be read against does
    // not. Counting only the open states is what makes "at most N" mean
    // anything.
    const before = count({}) ?? 0;
    const id = fileTask("backlog");
    assert.equal(count({}), before + 1);
    const closed = tasks.updateTask(id, { status: "done" }, OPERATOR);
    assert.equal(closed.ok, true, closed.ok ? "" : closed.error);
    assert.equal(count({}), before);
  });

  it("reads null, and touches the board at all, only for a loop that set one", () => {
    const reading = workflows.loopBoardCount(loopNode(null));
    assert.equal(reading.ok && reading.counts, null);
  });

  it("counts each priority beside the total, and all four of them", () => {
    // Every priority rather than the ones the thresholds name, so the reading
    // and `planLoopPass` cannot go out of step: a threshold with no figure
    // could only be skipped, and a skipped threshold is a loop that runs on
    // past the ending somebody wrote.
    const before = counts({})!;
    fileTask("backlog", "urgent");
    fileTask("backlog", "normal");
    fileTask("backlog", "normal");

    const after = counts({})!;
    assert.equal(after.total, before.total + 3);
    assert.equal(after.byPriority.urgent, before.byPriority.urgent + 1);
    assert.equal(after.byPriority.normal, before.byPriority.normal + 2);
    assert.equal(after.byPriority.high, before.byPriority.high);
    assert.equal(after.byPriority.low, before.byPriority.low);
  });

  it("counts a subfolder's tasks only when asked to", () => {
    const exact = count({}) ?? 0;
    const subtree = count({ includeSubfolders: true }) ?? 0;
    fileTask("backlog/docs");

    // The board groups a project by its own folder, and that is the default
    // here: `backlog` and `backlog/docs` are two backlogs on that page.
    assert.equal(count({}), exact);
    assert.equal(count({ includeSubfolders: true }), subtree + 1);
  });

  it("does not count a sibling whose name merely starts the same way", () => {
    // The whole of why the prefix carries the separator. `backlogWeb`'s
    // canonical path is `backlog`'s with three characters on the end, so
    // `LIKE '…/backlog%'` counts its tasks — silently, and in the direction
    // that keeps a loop running, because a project counted too full never
    // reaches the number it was told to stop at.
    const subtree = count({ includeSubfolders: true }) ?? 0;
    fileTask("backlogWeb");
    assert.equal(count({ includeSubfolders: true }), subtree);
    // And it is still its own project, which is what says the row was written.
    assert.equal(
      count({ folder: "backlogWeb", includeSubfolders: true }),
      1,
    );
  });

  it("counts the mount root's subtree as the whole workspace", () => {
    // `""` is a folder and not an absence, so the widened match is anchored on
    // the mount's own path — every task in every project under it.
    const root = count({ folder: "", includeSubfolders: true }) ?? 0;
    fileTask("elsewhere");
    assert.equal(count({ folder: "", includeSubfolders: true }), root + 1);
  });

  it("counts a condition saved as one number exactly as it always did", () => {
    // Nothing re-normalises a stored graph, so the single-number shape reaches
    // this reader intact. It must count the same project it counted before —
    // one folder, its own tasks only.
    const legacy = {
      id: "a",
      name: "Chip away at it",
      kind: "loop" as const,
      mountId,
      folder: "backlog",
      task: "work",
      maxPasses: 3,
      stopWhenTasks: {
        mountId,
        folder: "backlog",
        statuses: ["open"],
        atMost: 0,
      },
    } as unknown as import("./workflowGraph").WorkflowNode;

    const exact = count({}) ?? 0;
    const reading = workflows.loopBoardCount(legacy);
    assert.equal(reading.ok, true, reading.ok ? "" : reading.error);
    assert.equal(reading.ok && reading.counts?.total, exact);
  });

  it("refuses a folder it cannot resolve rather than calling it clear", () => {
    const reading = workflows.loopBoardCount(loopNode({ folder: "no-such" }));
    // Zero is the one answer that ends a loop, so a project this app cannot
    // find must not be able to produce it.
    assert.equal(reading.ok, false);
    assert.match(reading.ok ? "" : reading.error, /no-such/);
  });
});
