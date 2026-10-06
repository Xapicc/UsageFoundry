import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import {
  passMemberId,
  passMemberIn,
  passMemberOf,
  passNumberOf,
  passPrefix,
} from "./passIds";
import {
  addBlockSpend,
  blockSettlement,
  blockSpendReading,
  blockTurnSpend,
  bootBlockPlan,
  memberSpendReading,
  sumMemberSpend,
  emittedFolderRefusal,
  haltPlan,
  instanceStatus,
  loopBody,
  mergeBlockOutcome,
  queuedBranchOutcome,
  normalizeWorkflowInput,
  pickDuplicateName,
  planEmission,
  planEmittedRun,
  groupPasses,
  planInstanceStep,
  planNode,
  planLoopPass,
  planWorkflowProposal,
  summarizeProposedGraph,
  type BlockStatus,
  type BranchOutcome,
  type EmissionLimits,
  type HaltCause,
  type HaltMember,
  type InstanceNodeState,
  type LoopBoardCounts,
  type LoopDecision,
  type LoopPass,
  type LoopPassInput,
  type LoopPassMember,
  type LoopRunState,
  type MemberSpendRow,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowInstanceStatus,
  type WorkflowKnowledge,
  type WorkflowNode,
} from "./workflows";
import type { LoopBoardCondition } from "./workflowGraph";
import { topologicalOrder, type RunStatus } from "./orchestrator";
import { readTaskLinks } from "./tasks";
import type { QueueStatus } from "./mergeQueue";
import {
  MAX_WORKFLOW_NAME,
  type RunProviderDTO,
  type TaskPriorityDTO,
} from "./apiTypes";
import type { TurnResult } from "./chat";
import type { RunGuards } from "./settings";
import type { RunTemplate } from "./templates";

/**
 * The three decisions a workflow makes with nothing spawned yet: whether the
 * graph can run at all, in what order its blocks become runs, and — once they
 * are runs — which of them a halt takes down and what each becomes.
 *
 * All three clear the bar the rest of `npm test` sets — pure functions whose
 * failure modes are silent and expensive. A wrong order starts an agent *before
 * the work it extends exists*: the run is admitted, its dependency list names
 * runs that have not been created, and what the operator sees is a run that
 * started on an empty branch and did the first thing its task said. A graph that
 * validates when it should not is the same failure one step earlier — a loop
 * instantiated into rows that sit `waiting` for ever, because `releasableRuns`
 * reaches a fixed point and leaves them alone, which is precisely the row this
 * whole design has none of. And a halt is silent in both directions at once: a
 * member the selection misses goes on spending under a workflow the operator
 * has been told is stopped, while a `completed` member rewritten as stopped
 * destroys the record of work that landed, with nothing on the page afterwards
 * to say it ever happened.
 *
 * Nothing here opens the database or touches the filesystem. Resolving a folder
 * against a mount is the one step that would, and it is injected — so the
 * decision built on top of it is pinned here while the syscall itself stays
 * with the routes.
 */

const KNOWN: WorkflowKnowledge = {
  templates: new Map([
    ["t-iso", { name: "Isolated", isolate: true }],
    ["t-flat", { name: "In place", isolate: false }],
  ]),
  mountIds: ["work", "other"],
  defaultIsolate: true,
  // The registry as a saved graph is measured against it. `a-broken` is the row
  // that has decayed into something the CLI would drop in silence — `rowToAgent`
  // reports rather than repairs, so a graph naming it has to be refused here
  // too, or the block starts as an agent the CLI cannot resolve.
  agents: new Map([
    ["a-rev", { name: "Reviewer", usable: true }],
    ["a-broken", { name: "Half a thing", usable: false }],
  ]),
};

/** A block with everything filled in, so a case states only what it varies. */
function node(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id.toUpperCase(),
    templateId: "t-iso",
    mountId: "work",
    folder: "repo",
    task: `Do ${id}`,
    promptOverride: null,
    ...extra,
  };
}

/** An orchestrator block, with the cap a saved graph must carry. */
function decider(id: string, extra: Record<string, unknown> = {}) {
  return node(id, { kind: "orchestrator", fanOut: 3, ...extra });
}

/** A merge block, with the strategy a saved graph must carry. */
function merger(id: string, extra: Record<string, unknown> = {}) {
  return node(id, { kind: "merge", mergeStrategy: "merge", ...extra });
}

/**
 * A loop block, with the pass cap a saved graph must carry and **nothing else**.
 *
 * Not built on `node` like the other three, and that is the rule under test
 * rather than tidiness: a loop is a region, it starts no run of its own, and
 * every field that describes one is refused by name. A helper that carried a
 * task and a template would make every case below assert against a graph no
 * door would accept.
 */
function repeater(id: string, extra: Record<string, unknown> = {}) {
  return { id, name: id.toUpperCase(), kind: "loop", maxPasses: 3, ...extra };
}

/** The link that states containment, as a graph carries it. */
function repeats(from: string, to: string) {
  return edge(from, to, { edge: "repeats" });
}

/**
 * A link that hands its branch along.
 *
 * Ordinary now rather than the one kind a section's links could be: the chain
 * rule went when a pass started landing its own work, so a link inside a
 * section is judged by the same rules as one anywhere else. It is still how a
 * section is usually drawn, which is why it has a name here.
 */
function inside(from: string, to: string) {
  return edge(from, to, { edge: "on-success", continueBranch: true });
}

/**
 * A loop around the smallest legal section: one run block, landed by a merge.
 *
 * Every rule about a loop's own fields has to be asked of a graph that is
 * otherwise savable, and a loop with no section is no longer one — so this is
 * what "a loop block" means to a case that is about something else. `nodes[0]`
 * is the loop.
 */
function looped(extra: Record<string, unknown> = {}, id = "l") {
  return graph(
    [repeater(id, extra), node(`${id}a`), merger(`${id}m`)],
    [repeats(id, `${id}a`), edge(`${id}a`, `${id}m`)],
  );
}

/**
 * A legal outer section with a loop block sitting in it, which is the one kind
 * of block a section may not hold.
 *
 * Every other rule has to pass or the refusal under test is not the one that
 * answers: “M” needs a producer that is not the inner loop — a loop lands each
 * pass's work itself and contributes no branch — and the inner loop needs its
 * own section, because a loop that frames nothing is refused before this.
 */
function nested() {
  return graph(
    [
      repeater("l"),
      node("a"),
      repeater("k"),
      merger("m"),
      node("z"),
      merger("n"),
    ],
    [
      repeats("l", "a"),
      edge("a", "k"),
      edge("a", "m"),
      edge("k", "m"),
      repeats("k", "z"),
      edge("z", "n"),
    ],
  );
}

function edge(
  from: string,
  to: string,
  opts: { edge?: WorkflowEdge["edge"]; continueBranch?: boolean } = {},
): WorkflowEdge {
  return {
    from,
    to,
    edge: opts.edge ?? "on-success",
    continueBranch: opts.continueBranch ?? false,
  };
}

function graph(nodes: unknown[], edges: unknown[] = []) {
  return { name: "Nightly", graph: { nodes, edges } };
}

/** Unwrap a normalization that is expected to succeed. */
function value(raw: unknown) {
  const res = normalizeWorkflowInput(raw, KNOWN);
  assert.ok(res.ok, `expected ok, got: ${res.ok ? "" : res.error}`);
  return res.value;
}

/** The refusal for input expected to be rejected. */
function error(raw: unknown): string {
  const res = normalizeWorkflowInput(raw, KNOWN);
  assert.ok(!res.ok, "expected a refusal");
  return res.error;
}

/* ------------------------------------------------------------------ */
/* Order                                                               */
/* ------------------------------------------------------------------ */

describe("topologicalOrder — every block after what it waits for", () => {
  it("orders a chain regardless of how it was declared", () => {
    // Declared tail-first, which is what an editor produces when a block is
    // inserted above another. The run for `c` must still be created last.
    const g = {
      nodes: [node("c"), node("b"), node("a")],
      edges: [edge("a", "b"), edge("b", "c")],
    };
    const { order, unplaced } = topologicalOrder(g);
    assert.deepEqual(order, ["a", "b", "c"]);
    assert.deepEqual(unplaced, []);
  });

  it("keeps independent blocks in the order they were written", () => {
    // Three roots is the parallel case, and it is not a separate concept — it
    // falls out of a graph with no edges. The order still has to be stable:
    // runs are admitted oldest-first and a queued run reserves its folder
    // against everything younger, so two presses of Run on one graph must not
    // produce two different queues.
    const g = { nodes: [node("x"), node("y"), node("z")], edges: [] };
    assert.deepEqual(topologicalOrder(g).order, ["x", "y", "z"]);
  });

  it("places a fan-in after both of its dependencies", () => {
    const g = {
      nodes: [node("join"), node("left"), node("right")],
      edges: [edge("left", "join"), edge("right", "join")],
    };
    const { order } = topologicalOrder(g);
    assert.equal(order.at(-1), "join");
    assert.deepEqual(order.slice(0, 2).sort(), ["left", "right"]);
  });

  it("counts a repeated edge once", () => {
    // Counted twice, the dependent's indegree never reaches zero and a healthy
    // graph is reported as a loop.
    const g = {
      nodes: [node("a"), node("b")],
      edges: [edge("a", "b"), edge("a", "b")],
    };
    assert.deepEqual(topologicalOrder(g).order, ["a", "b"]);
  });

  it("ignores an edge naming a block that is not in the graph", () => {
    const g = { nodes: [node("a")], edges: [edge("ghost", "a")] };
    assert.deepEqual(topologicalOrder(g).order, ["a"]);
  });

  it("leaves a loop unplaced rather than guessing an order", () => {
    const g = {
      nodes: [node("a"), node("b")],
      edges: [edge("a", "b"), edge("b", "a")],
    };
    const { order, unplaced } = topologicalOrder(g);
    assert.deepEqual(order, []);
    assert.deepEqual(unplaced.sort(), ["a", "b"]);
  });

  it("leaves everything downstream of a loop unplaced too", () => {
    // The unreachable case: `c` is not in the loop and is not in trouble on its
    // own, but nothing will ever satisfy it.
    const g = {
      nodes: [node("a"), node("b"), node("c"), node("free")],
      edges: [edge("a", "b"), edge("b", "a"), edge("b", "c")],
    };
    const { order, unplaced } = topologicalOrder(g);
    assert.deepEqual(order, ["free"]);
    assert.deepEqual(unplaced.sort(), ["a", "b", "c"]);
  });
});

/* ------------------------------------------------------------------ */
/* Identity and substance                                              */
/* ------------------------------------------------------------------ */

describe("pickDuplicateName — the name a copy is saved under", () => {
  /** Duplicates `source` `times` times, each copy taking its name. */
  function duplicateRepeatedly(source: string, times: number): string[] {
    const taken = [source];
    for (let i = 0; i < times; i++) {
      taken.push(pickDuplicateName(source, taken));
    }
    return taken.slice(1);
  }

  it("keeps a short name whole and numbers the copies after the first", () => {
    assert.deepEqual(duplicateRepeatedly("Nightly", 3), [
      "Nightly copy",
      "Nightly copy 2",
      "Nightly copy 3",
    ]);
  });

  it("makes every copy of a name at or near the limit, each free and in bounds", () => {
    for (const length of [75, 76, 77, 79, MAX_WORKFLOW_NAME]) {
      const source = "x".repeat(length);
      const copies = duplicateRepeatedly(source, 3);
      assert.equal(
        new Set([source, ...copies]).size,
        4,
        `${length}: ${JSON.stringify(copies)}`,
      );
      for (const copy of copies) {
        assert.ok(copy.length <= MAX_WORKFLOW_NAME, `${length}: ${copy}`);
      }
    }
  });

  it("compares names the way the unique index does: ASCII case folded, nothing else", () => {
    assert.equal(pickDuplicateName("Nightly", ["NIGHTLY COPY"]), "Nightly copy 2");
    // `COLLATE NOCASE` accepts this beside "ÉTÉ COPY", so skipping it would
    // be a fold that is not the index's.
    assert.equal(pickDuplicateName("été", ["ÉTÉ COPY"]), "été copy");
  });

  it("does not split a surrogate pair, which SQLite would store as something else", () => {
    // The cut for " copy" lands between the halves of the emoji.
    const source = "a".repeat(74) + "😀" + "b".repeat(4);
    const name = pickDuplicateName(source, [source]);
    assert.equal(Buffer.from(name, "utf8").toString("utf8"), name);
    assert.equal(name, "a".repeat(74) + " copy");
  });

  it("does not leave a space the cut landed after in front of the suffix", () => {
    const source = "a".repeat(74) + " " + "b".repeat(5);
    assert.equal(pickDuplicateName(source, [source]), "a".repeat(74) + " copy");
  });
});

describe("normalizeWorkflowInput — name and blocks", () => {
  it("requires a name", () => {
    assert.match(error({ ...graph([node("a")]), name: "  " }), /needs a name/);
  });

  it("requires at least one block", () => {
    assert.match(error(graph([])), /at least one block/);
  });

  it("requires a task on every block", () => {
    assert.match(error(graph([node("a", { task: "   " })])), /no task/);
  });

  it("requires a name on every block", () => {
    assert.match(error(graph([node("a", { name: "" })])), /needs a name/);
  });

  it("refuses two blocks with one id", () => {
    assert.match(
      error(graph([node("a"), node("a", { name: "Second" })])),
      /share the id/,
    );
  });

  it("reads a block with no kind as a run block", () => {
    // Every graph saved before orchestrator blocks existed says nothing here,
    // and the other reading would turn one of them into a graph that starts
    // agents nobody wrote.
    const v = value(graph([node("a")]));
    assert.equal(v.graph.nodes[0].kind, "run");
    assert.equal(v.graph.nodes[0].fanOut, null);
  });

  it("refuses an orchestrator block with no fan-out cap", () => {
    // The `no_terminus` rule, applied where it bites hardest: this is the one
    // block whose runs start with nothing between the decision and the spawn,
    // so a missing limit is an unbounded number of billed agents from one
    // press of Run. Refused at *save*, so it fails in the form that caused it.
    for (const bad of [undefined, null, "", 0, -1, 2.5]) {
      assert.match(
        error(graph([decider("a", { fanOut: bad })])),
        /needs a limit on how many runs it may start/,
        `fanOut ${String(bad)} should be refused`,
      );
    }
  });

  it("refuses a fan-out cap past the limit, and keeps one below it", () => {
    assert.match(error(graph([decider("a", { fanOut: 99 })])), /at most 10 runs/);
    assert.equal(value(graph([decider("a", { fanOut: 4 })])).graph.nodes[0].fanOut, 4);
  });

  it("refuses a branch hand-over at either end of an orchestrator block", () => {
    // It decides rather than works, so it has no checkout and no branch. Said
    // by name rather than left to the isolation test, which would claim its
    // guards work directly in the folder — true of nothing here.
    assert.match(
      error(
        graph(
          [decider("a"), node("b")],
          [edge("a", "b", { continueBranch: true })],
        ),
      ),
      /no branch to hand over or carry on/,
    );
    assert.match(
      error(
        graph(
          [node("a"), decider("b")],
          [edge("a", "b", { continueBranch: true })],
        ),
      ),
      /no branch to hand over or carry on/,
    );
  });

  it("requires a brief on an orchestrator block, in its own words", () => {
    assert.match(
      error(graph([decider("a", { task: "  " })])),
      /nothing to decide/,
    );
  });

  it("trims the task but keeps the mount root as a folder", () => {
    // "" is the mount root — the one selection that blocks every other run in
    // the tree — so it must survive as a real answer rather than read as "no
    // folder recorded".
    const v = value(graph([node("a", { task: "  tidy up  ", folder: "" })]));
    assert.equal(v.graph.nodes[0].task, "tidy up");
    assert.equal(v.graph.nodes[0].folder, "");
  });

  it("keeps a prompt override and normalises a blank one to null", () => {
    const v = value(
      graph([
        node("a", { promptOverride: " Read first. " }),
        node("b", { promptOverride: "   " }),
      ]),
    );
    assert.equal(v.graph.nodes[0].promptOverride, "Read first.");
    assert.equal(v.graph.nodes[1].promptOverride, null);
  });

  it("refuses a prompt override that is not a string, naming the block and the field", () => {
    // `String()` read `{}` as "[object Object]" and a block was saved whose
    // every run was started under exactly that as its standing instructions.
    for (const promptOverride of [{ text: "Be brief." }, ["Be", "brief."], 42, true]) {
      for (const make of [node, decider]) {
        const refusal = error(graph([make("a", { promptOverride })]));
        assert.match(refusal, /“A”/, JSON.stringify(promptOverride));
        assert.match(refusal, /"promptOverride" has to be a string when it is given/);
        assert.doesNotMatch(refusal, /\[object Object\]/);
      }
    }
    // Absent and null keep their meaning, and a merge block, which starts no
    // run and drops the field unread, is not refused for a value it never reads.
    assert.equal(value(graph([node("a", { promptOverride: undefined })])).graph.nodes[0].promptOverride, null);
    const merged = value(
      graph([node("a"), merger("m", { promptOverride: { text: "x" } })], [edge("a", "m")]),
    );
    assert.equal(merged.graph.nodes[1].promptOverride, null);
  });

  it("refuses a workflow name, block name or task that is not a string, naming the field", () => {
    // `String()` saved a workflow, or a block, named "[object Object]", and a
    // block whose every run was briefed with exactly that — non-empty, so the
    // blank-field refusals passed it.
    for (const wrong of [{ text: "x" }, ["x"], 42]) {
      const label = JSON.stringify(wrong);
      assert.match(error({ ...graph([node("a")]), name: wrong }), /"name" has to be a string when it is given/, label);
      assert.match(error(graph([node("a", { name: wrong })])), /Block 1: "name" has to be a string/, label);
      for (const make of [node, decider]) {
        const refusal = error(graph([make("a", { task: wrong })]));
        assert.match(refusal, /“A”: "task" has to be a string when it is given/, label);
        assert.doesNotMatch(refusal, /\[object Object\]/);
      }
    }
    // A merge block starts no run and drops its task unread, so it is not
    // refused for a value it never reads.
    const merged = value(graph([node("a"), merger("m", { task: { text: "x" } })], [edge("a", "m")]));
    assert.equal(merged.graph.nodes[1].task, "");
  });

  it("carries the workflow-wide limits, and reads a blank field as off", () => {
    // The one guard a workflow itself holds, and the only value on this form
    // that is not about *what work to do*. It earns its place here rather than
    // on a node because it bounds something no per-block guard can see: ten
    // blocks under a $5 block limit is a $50 workflow.
    const set = value({
      ...graph([node("a")]),
      instanceBudget: {
        maxInstanceCostUSD: "12.5",
        maxSessionFraction: 80,
        maxWeeklyFraction: "",
      },
    });
    assert.deepEqual(set.instanceBudget, {
      maxInstanceCostUSD: 12.5,
      // Typed as a percentage, stored as a fraction — the same conversion a
      // run's guards make, because the form asks the same question.
      maxSessionFraction: 0.8,
      maxWeeklyFraction: null,
    });

    // Absent is every limit off. A workflow saved before this existed reads the
    // same way, which is the behaviour it had.
    assert.deepEqual(value(graph([node("a")])).instanceBudget, {
      maxInstanceCostUSD: null,
      maxSessionFraction: null,
      maxWeeklyFraction: null,
    });
  });

  it("does not refuse a fraction guard at save for want of a ceiling", () => {
    // The one place this file's "refuse at save what Run refuses" rule does not
    // apply. A ceiling is a Settings value that can be typed at any moment, so
    // a graph saved without one is not unstartable — only unstartable today,
    // and `startWorkflow` says so with a real snapshot in hand.
    const v = value({
      ...graph([node("a")]),
      instanceBudget: { maxWeeklyFraction: 60 },
    });
    assert.equal(v.instanceBudget.maxWeeklyFraction, 0.6);
  });
});

/* ------------------------------------------------------------------ */
/* Guards come from something a person wrote                           */
/* ------------------------------------------------------------------ */

describe("normalizeWorkflowInput — templates and mounts", () => {
  it("refuses a template that no longer exists, by block name", () => {
    const message = error(graph([node("a", { templateId: "gone" })]));
    assert.match(message, /“A”/);
    assert.match(message, /no longer exists/);
  });

  it("accepts no template at all, which means the guards in Settings", () => {
    const v = value(graph([node("a", { templateId: null })]));
    assert.equal(v.graph.nodes[0].templateId, null);
  });

  it("reads an empty template id as none rather than as a missing template", () => {
    assert.equal(value(graph([node("a", { templateId: "" })])).graph.nodes[0]
      .templateId, null);
  });

  it("refuses a workspace that is not mounted", () => {
    assert.match(error(graph([node("a", { mountId: "elsewhere" })])), /not mounted/);
  });

  it("refuses a block naming no workspace", () => {
    assert.match(error(graph([node("a", { mountId: "" })])), /names no workspace/);
  });
});

/* ------------------------------------------------------------------ */
/* Agents                                                              */
/* ------------------------------------------------------------------ */

/**
 * What a block's own child *is*, which is not what that child may do.
 *
 * Every failure here is the one this app's whole agent registry exists to end,
 * arriving from a saved graph rather than from the CLI: a block given
 * an agent it does not have is bit-for-bit a block that was never given one,
 * and nothing downstream can tell them apart — not the event log, not the cost,
 * not the transcript's own attribution. So a name that resolves to nothing is
 * refused rather than dropped, and it is refused *at save*, where a person is
 * looking, as well as at every Run afterwards.
 *
 * The merge case is the same fault in its cheapest form. That block spawns no
 * child at all, so an agent named on it has nothing to be —
 * accepting it silently would be this app performing the CLI's own silent drop
 * at the one door built to stop it.
 */
/**
 * A block's provider and a review block, as a saved graph states them.
 *
 * The provider is on the node because nothing a model emits may name one, so a
 * value accepted here is a value every emitted run starts as; one accepted on a
 * block that starts no run is a choice no process acts on. A review block's fix
 * rounds are billed runs per branch, so they are capped where the graph is
 * saved rather than discovered on the bill.
 */
describe("normalizeWorkflowInput — providers and review blocks", () => {
  const reviewer = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: id.toUpperCase(),
    kind: "review",
    fixRounds: 2,
    ...extra,
  });

  it("keeps a provider on a run block and on an orchestrator block", () => {
    const saved = value(
      graph([node("a", { provider: "local" }), decider("d", { provider: "codex" })]),
    );
    assert.equal(saved.graph.nodes[0].provider, "local");
    assert.equal(saved.graph.nodes[1].provider, "codex");
    assert.equal(value(graph([node("a")])).graph.nodes[0].provider, null);
  });

  it("refuses a provider nothing can run and one on a block that starts no run", () => {
    assert.match(error(graph([node("a", { provider: "gemini" })])), /no adapter for: gemini/);
    assert.match(
      error(graph([node("a"), merger("m", { provider: "local" })], [edge("a", "m")])),
      /starts no run of its own/,
    );
  });

  it("refuses a Codex run block started as a saved agent", () => {
    assert.match(
      error(graph([node("a", { provider: "codex", agentId: "a-rev" })])),
      /runs on Codex, which a saved agent's prompt does not reach/,
    );
  });

  it("saves a review block with its fix rounds and nothing else", () => {
    const saved = value(
      graph(
        [node("a"), reviewer("r", { task: "ignored", mountId: "work" }), merger("m")],
        [edge("a", "r"), edge("r", "m")],
      ),
    );
    const r = saved.graph.nodes.find((n) => n.id === "r")!;
    assert.equal(r.fixRounds, 2);
    assert.equal(r.task, "");
    assert.equal(r.mountId, "");
  });

  it("caps a review block's fix rounds", () => {
    assert.match(
      error(graph([node("a"), reviewer("r", { fixRounds: 4 })], [edge("a", "r")])),
      /0 to 3 fix rounds/,
    );
  });

  it("refuses a review block with nothing in front of it that cuts a branch", () => {
    assert.match(error(graph([reviewer("r")])), /no block in front of it whose branches it could review/);
    assert.match(
      error(graph([node("a", { templateId: "t-flat" }), reviewer("r")], [edge("a", "r")])),
      /leaves no branch for “R” to review/,
    );
  });

  it("refuses an agent on a review block and a branch carried through one", () => {
    assert.match(
      error(graph([node("a"), reviewer("r", { agentId: "a-rev" })], [edge("a", "r")])),
      /frontier model this app chooses/,
    );
    assert.match(
      error(
        graph(
          [node("a"), reviewer("r"), node("b")],
          [edge("a", "r"), edge("r", "b", { continueBranch: true })],
        ),
      ),
      /no branch of its own to hand over/,
    );
  });
});

describe("normalizeWorkflowInput — the agent a block's child is started as", () => {
  it("carries an agent the registry has", () => {
    const v = value(graph([node("a", { agentId: "a-rev" })]));
    assert.equal(v.graph.nodes[0].agentId, "a-rev");
  });

  it("reads no agent, an empty one and a blank one all as none", () => {
    // `""` is the picker's own empty option rather than a missing answer, the
    // same absence `templateId` collapses one field up.
    assert.equal(value(graph([node("a")])).graph.nodes[0].agentId, null);
    assert.equal(
      value(graph([node("a", { agentId: "" })])).graph.nodes[0].agentId,
      null,
    );
    assert.equal(
      value(graph([node("a", { agentId: "   " })])).graph.nodes[0].agentId,
      null,
    );
  });

  it("refuses an agent that has been deleted, by block name and by refusal", () => {
    // The same sentence the run door and the template door give, so an operator
    // who meets it in three places meets one wording. Never a fallback to none:
    // the graph says "and hand the review to the reviewer".
    const message = error(graph([node("a", { agentId: "a-gone" })]));
    assert.match(message, /“A”/);
    assert.match(message, /no longer exists/);
    assert.match(message, /a-gone/, "and names the id that resolved to nothing");
  });

  it("refuses one that has decayed into what the CLI will not register", () => {
    // `rowToAgent` reports rather than repairs, so an unusable row reaches here
    // as a row that exists. Accepted, it would produce a block whose run is
    // started as an agent the CLI cannot resolve, which fails at the spawn.
    const message = error(graph([node("a", { agentId: "a-broken" })]));
    assert.match(message, /Half a thing/);
    assert.match(message, /will not register/);
  });

  it("lets an orchestrator block name one for its own deciding turn", () => {
    const v = value(graph([decider("a", { agentId: "a-rev" })]));
    assert.equal(v.graph.nodes[0].agentId, "a-rev");
  });

  it("refuses one on a merge block, which spawns no child to hand it to", () => {
    // Refused rather than dropped, unlike the template on the same block: a
    // template there decides nothing because no agent runs under it, where a
    // agent named here is one the operator believes is in play.
    const message = error(
      graph([node("a"), merger("m", { agentId: "a-rev" })], [edge("a", "m")]),
    );
    assert.match(message, /“M”/);
    assert.match(message, /starts no agent of its own/);
  });

  it("still accepts a merge block that names none", () => {
    const v = value(graph([node("a"), merger("m")], [edge("a", "m")]));
    assert.equal(v.graph.nodes[1].agentId, null);
  });
});

/* ------------------------------------------------------------------ */
/* Edges                                                               */
/* ------------------------------------------------------------------ */

describe("normalizeWorkflowInput — links", () => {
  it("requires a condition rather than defaulting one", () => {
    // Either default is wrong half the time and silent both times: on-success
    // ends a chain the operator meant to run regardless, on-finish starts a run
    // on top of a dependency that crashed.
    // Written out rather than built by the helper: the point of the case is a
    // value the type does not allow, arriving off the wire.
    assert.match(
      error(
        graph(
          [node("a"), node("b")],
          [{ from: "a", to: "b", continueBranch: false }],
        ),
      ),
      /needs a condition/,
    );
    assert.match(
      error(
        graph(
          [node("a"), node("b")],
          [{ from: "a", to: "b", edge: "on-done", continueBranch: false }],
        ),
      ),
      /needs a condition/,
    );
  });

  it("accepts both conditions", () => {
    const v = value(
      graph(
        [node("a"), node("b"), node("c")],
        [edge("a", "b", { edge: "on-finish" }), edge("b", "c")],
      ),
    );
    assert.equal(v.graph.edges[0].edge, "on-finish");
    assert.equal(v.graph.edges[1].edge, "on-success");
  });

  it("refuses a link to a block that is not in the workflow", () => {
    assert.match(
      error(graph([node("a")], [edge("ghost", "a")])),
      /not in this workflow/,
    );
  });

  it("refuses a block set to start after itself", () => {
    assert.match(
      error(graph([node("a")], [edge("a", "a")])),
      /start after itself/,
    );
  });

  it("refuses the same pair twice, which states two conditions for one wait", () => {
    assert.match(
      error(
        graph(
          [node("a"), node("b")],
          [edge("a", "b"), edge("a", "b", { edge: "on-finish" })],
        ),
      ),
      /twice/,
    );
  });

  it("names the blocks in a loop, in the order they wait", () => {
    const message = error(
      graph(
        [node("a"), node("b"), node("c")],
        [edge("a", "b"), edge("b", "c"), edge("c", "a")],
      ),
    );
    assert.match(message, /loop/);
    assert.match(message, /A/);
    assert.match(message, /B/);
    assert.match(message, /C/);
  });
});

/* ------------------------------------------------------------------ */
/* Carrying a branch over                                              */
/* ------------------------------------------------------------------ */

describe("normalizeWorkflowInput — continuing a branch", () => {
  it("accepts one hand-over per block", () => {
    const v = value(
      graph(
        [node("a"), node("b")],
        [edge("a", "b", { continueBranch: true })],
      ),
    );
    assert.equal(v.graph.edges[0].continueBranch, true);
  });

  it("reads anything but true as false, so a wire value fails safe", () => {
    const v = value(
      graph(
        [node("a"), node("b")],
        [{ from: "a", to: "b", edge: "on-success", continueBranch: "true" }],
      ),
    );
    assert.equal(v.graph.edges[0].continueBranch, false);
  });

  it("refuses a block set to carry on two branches", () => {
    assert.match(
      error(
        graph(
          [node("a"), node("b"), node("c")],
          [
            edge("a", "c", { continueBranch: true }),
            edge("b", "c", { continueBranch: true }),
          ],
        ),
      ),
      /only continue one/,
    );
  });

  it("refuses two blocks carrying on one branch", () => {
    // Two runs on one ref is a branch git will not check out twice, and it
    // leaves the landing rules with no last link to name.
    assert.match(
      error(
        graph(
          [node("a"), node("b"), node("c")],
          [
            edge("a", "b", { continueBranch: true }),
            edge("a", "c", { continueBranch: true }),
          ],
        ),
      ),
      /cannot extend one branch/,
    );
  });

  it("refuses a hand-over from guards that work in the folder", () => {
    // The predecessor has no branch to give: its template turns isolation off.
    assert.match(
      error(
        graph(
          [node("a", { templateId: "t-flat" }), node("b")],
          [edge("a", "b", { continueBranch: true })],
        ),
      ),
      /no branch to hand/,
    );
  });

  it("refuses a hand-over to guards that work in the folder", () => {
    assert.match(
      error(
        graph(
          [node("a"), node("b", { templateId: "t-flat" })],
          [edge("a", "b", { continueBranch: true })],
        ),
      ),
      /cannot carry on/,
    );
  });

  it("takes an untemplated block's isolation from the settings guard set", () => {
    const flat: WorkflowKnowledge = { ...KNOWN, defaultIsolate: false };
    const res = normalizeWorkflowInput(
      graph(
        [node("a", { templateId: null }), node("b")],
        [edge("a", "b", { continueBranch: true })],
      ),
      flat,
    );
    assert.ok(!res.ok, "expected a refusal");
    assert.match(res.error, /no branch to hand/);
  });
});

/* ------------------------------------------------------------------ */
/* Merge blocks                                                        */
/* ------------------------------------------------------------------ */

/**
 * A merge block writes into the operator's own checkout and can bill for a
 * conflict resolution, so what it may be saved as is worth the same care as an
 * orchestrator block's fan-out cap — and for the same reason, which is that both
 * refusals are only available at *save*.
 *
 * The two that matter most are the ones a graph cannot recover from later. A
 * merge block with nothing in front of it that runs anything is a block that
 * reaches the front of the graph and can only report that it was pointless; one
 * behind runs whose guards work directly in the folder finds every predecessor
 * branchless an hour in, having already spent the work. Both are answerable from
 * the guards a person has already chosen, which is exactly the case this file's
 * "refuse at save what instantiation refuses" rule exists for.
 */
describe("normalizeWorkflowInput — merge blocks", () => {
  it("needs a block in front of it that runs something", () => {
    assert.match(
      error(graph([merger("land")])),
      /no block in front of it whose work it could land/,
    );
  });

  it("does not count another merge block as something to land", () => {
    // Sequencing one merge behind another is legal — it contributes no
    // branches, which is the whole point — but it cannot be the *only* thing in
    // front of one, or the second block has nothing to do.
    assert.match(
      error(graph([node("a"), merger("one"), merger("two")], [
        edge("a", "one"),
        edge("one", "two"),
      ])),
      /no block in front of it whose work it could land/,
    );
  });

  it("accepts a merge block behind a merge block when a run also feeds it", () => {
    const g = value(
      graph([node("a"), node("b"), merger("one"), merger("two")], [
        edge("a", "one"),
        edge("one", "two"),
        edge("b", "two"),
      ]),
    );
    assert.equal(g.graph.nodes.length, 4);
  });

  it("refuses a predecessor whose guards leave no branch", () => {
    assert.match(
      error(
        graph([node("a", { templateId: "t-flat" }), merger("land")], [
          edge("a", "land"),
        ]),
      ),
      /leaves no branch for “LAND” to land/,
    );
  });

  it("takes an untemplated predecessor's isolation from the settings guards", () => {
    const flat: WorkflowKnowledge = { ...KNOWN, defaultIsolate: false };
    const res = normalizeWorkflowInput(
      graph([node("a", { templateId: null }), merger("land")], [
        edge("a", "land"),
      ]),
      flat,
    );
    assert.ok(!res.ok, "expected a refusal");
    assert.match(res.error, /leaves no branch/);
  });

  it("requires a strategy, so the graph records what the operator was shown", () => {
    assert.match(
      error(
        graph([node("a"), merger("land", { mergeStrategy: "" })], [
          edge("a", "land"),
        ]),
      ),
      /how it lands a branch/,
    );
  });

  it("refuses a merge block at either end of a branch hand-over", () => {
    // It has no checkout of its own: it writes into somebody else's and cuts
    // nothing. Named rather than left to the isolation test, which would say
    // something true of neither end.
    const asSource = error(
      graph([node("a"), merger("land"), node("b")], [
        edge("a", "land"),
        edge("land", "b", { continueBranch: true }),
      ]),
    );
    assert.match(asSource, /lands other blocks' branches/);
    const asTarget = error(
      graph([node("a"), merger("land")], [
        edge("a", "land", { continueBranch: true }),
      ]),
    );
    assert.match(asTarget, /lands other blocks' branches/);
  });

  it("holds no task, template, workspace, folder or prompt", () => {
    // Every one of them decides something about an agent, and this block starts
    // none. Dropped rather than refused, because the editor sends whatever the
    // block was carrying before the kind was switched.
    const g = value(
      graph(
        [
          node("a"),
          merger("land", {
            task: "merge everything please",
            templateId: "t-iso",
            mountId: "work",
            folder: "repo",
            promptOverride: "be careful",
          }),
        ],
        [edge("a", "land")],
      ),
    );
    const land = g.graph.nodes[1];
    assert.equal(land.task, "");
    assert.equal(land.templateId, null);
    assert.equal(land.mountId, "");
    assert.equal(land.folder, "");
    assert.equal(land.promptOverride, null);
    assert.equal(land.fanOut, null);
  });

  it("authorises a resolution only on a literal true", () => {
    // It is billed spend with nobody watching, so a string off the wire fails
    // safe — the reading `continueBranch` and `auto_resolve` both take.
    const on = value(
      graph([node("a"), merger("land", { mergeAutoResolve: true })], [
        edge("a", "land"),
      ]),
    );
    assert.equal(on.graph.nodes[1].mergeAutoResolve, true);

    for (const wire of ["true", 1, "yes", null, undefined]) {
      const off = value(
        graph([node("a"), merger("land", { mergeAutoResolve: wire })], [
          edge("a", "land"),
        ]),
      );
      assert.equal(
        off.graph.nodes[1].mergeAutoResolve,
        false,
        `${JSON.stringify(wire)} must not authorise spend`,
      );
    }
  });

  it("carries no merge settings on a block that is not one", () => {
    const g = value(
      graph([node("a", { mergeStrategy: "squash", mergeAutoResolve: true })]),
    );
    assert.equal(g.graph.nodes[0].mergeStrategy, null);
    assert.equal(g.graph.nodes[0].mergeAutoResolve, false);
  });
});

/**
 * What a merge block reports, and therefore whether the blocks behind it start.
 *
 * Both ways of being wrong are silent. Read as failed, a chain that landed
 * cleanly stops with nothing left to do; read as succeeded, a follow-up run
 * starts on a target that never received the work it was written against.
 *
 * The distinction that carries the weight is skipped-versus-failed. A branch
 * with nothing on it and a branch already on its target both leave the operator
 * with what they asked for, so stopping a graph over either would refuse work
 * for the sake of a merge that had none to do — while a predecessor that should
 * have had a branch and has none is isolation having degraded at run time, which
 * is the one case where saying nothing leaves someone believing work landed.
 */
describe("mergeBlockOutcome — what a merge block reports", () => {
  const landed = (branch: string): BranchOutcome => ({
    branch,
    result: "landed",
    reason: null,
  });

  it("says nothing when every branch landed", () => {
    const out = mergeBlockOutcome([landed("uf/a"), landed("uf/b")]);
    assert.equal(out.ok, true);
    assert.equal(out.note, null, "silence means the plain thing happened");
  });

  it("succeeds with a note when a branch had nothing to land", () => {
    const out = mergeBlockOutcome([
      landed("uf/a"),
      { branch: "uf/b", result: "skipped", reason: "it left no commits of its own" },
    ]);
    assert.equal(out.ok, true, "nothing to land is not a failure");
    assert.match(out.note ?? "", /uf\/b — it left no commits/);
  });

  it("fails when a branch that should have landed did not", () => {
    const out = mergeBlockOutcome([
      landed("uf/a"),
      { branch: "uf/b", result: "failed", reason: "it conflicts" },
    ]);
    assert.equal(out.ok, false);
    assert.match(out.note ?? "", /Landed 1 of 2/);
    assert.match(out.note ?? "", /uf\/b — it conflicts/);
  });

  it("counts the skipped branches out of the denominator", () => {
    // "Landed 1 of 2" is about the branches that had work on them. Counting a
    // branch with nothing on it as one this block failed to land would report a
    // shortfall that does not exist.
    const out = mergeBlockOutcome([
      landed("uf/a"),
      { branch: "uf/b", result: "skipped", reason: "already on main" },
      { branch: "uf/c", result: "failed", reason: "it conflicts" },
    ]);
    assert.equal(out.ok, false);
    assert.match(out.note ?? "", /Landed 1 of 2/);
  });

  it("names a few failures and counts the rest", () => {
    const out = mergeBlockOutcome(
      Array.from({ length: 7 }, (_, i) => ({
        branch: `uf/${i}`,
        result: "failed" as const,
        reason: "it conflicts",
      })),
    );
    assert.equal(out.ok, false);
    assert.match(out.note ?? "", /and 3 more/);
  });

  it("treats no branches at all as nothing to do", () => {
    const out = mergeBlockOutcome([]);
    assert.equal(out.ok, true);
    assert.match(out.note ?? "", /no branch to land/);
  });
});

/**
 * How a merge block reads one row of the batch it queued.
 *
 * The queue writes `skipped` for a branch it never attempted because the
 * checkout stopped that repository, and `already-landed` for one whose work
 * was on its target by its turn. Only the second is the block's skip: the first
 * is a branch that did not get where it was going, and reading it as nothing
 * to land starts the blocks behind a merge on a target that never received the
 * work.
 */
describe("queuedBranchOutcome — what a merge block makes of a queue row", () => {
  const row = (status: QueueStatus, message: string | null) => ({ status, message });

  it("counts a branch already on its target as having nothing to land", () => {
    const out = queuedBranchOutcome(
      row("already-landed", "Already in main — there is nothing left to land."),
      "uf/a",
    );
    assert.deepEqual(out, {
      branch: "uf/a",
      result: "skipped",
      reason: "Already in main — there is nothing left to land.",
    });
  });

  it("fails a branch the queue never attempted because the repository halted", () => {
    const out = queuedBranchOutcome(
      row("skipped", "Not attempted — The checkout has uncommitted changes."),
      "uf/a",
    );
    assert.equal(out.result, "failed");
    assert.match(out.reason ?? "", /uncommitted changes/);
  });

  it("fails a branch still in the queue when the workflow was stopped", () => {
    for (const status of ["queued", "landing", "resolving"] as const) {
      const out = queuedBranchOutcome(row(status, null), "uf/a");
      assert.equal(out.result, "failed", status);
      assert.match(out.reason ?? "", /still in the merge queue/);
    }
  });

  it("lands a landed row and fails a failed one", () => {
    assert.equal(queuedBranchOutcome(row("landed", "Merged."), "uf/a").result, "landed");
    assert.equal(queuedBranchOutcome(row("failed", "It conflicts."), "uf/a").result, "failed");
    assert.equal(queuedBranchOutcome(row("cancelled", null), "uf/a").result, "failed");
  });
});

/* ------------------------------------------------------------------ */
/* Loop blocks: what a saved graph may say                             */
/* ------------------------------------------------------------------ */

describe("normalizeWorkflowInput — loop blocks", () => {
  it("keeps both caps on a loop block", () => {
    const v = value(looped({ maxLoopCostUSD: 12.5 }));
    assert.equal(v.graph.nodes[0].kind, "loop");
    assert.equal(v.graph.nodes[0].maxPasses, 3);
    assert.equal(v.graph.nodes[0].maxLoopCostUSD, 12.5);
  });

  it("refuses a loop with no pass cap", () => {
    // The `no_terminus` rule read one level up: a loop decides for itself
    // whether to start another billed run, so without a quantity that only goes
    // up there is nothing that has to end.
    assert.match(
      error(looped({ maxPasses: null })),
      /how many times it may repeat/,
    );
    assert.match(error(looped({ maxPasses: 0 })), /how many times it may repeat/);
    assert.match(
      error(looped({ maxPasses: 2.5 })),
      /how many times it may repeat/,
    );
  });

  it("refuses a pass cap past the limit", () => {
    assert.match(error(looped({ maxPasses: 99 })), /at most 20/);
  });

  it("reads a blank, zero or negative spending cap as no cap", () => {
    // The rule every budget field in this app follows: a limit nobody typed is
    // not a limit, and there is no default to restore.
    for (const raw of ["", 0, -5, null, undefined]) {
      const v = value(looped({ maxLoopCostUSD: raw }));
      assert.equal(v.graph.nodes[0].maxLoopCostUSD, null, `for ${String(raw)}`);
    }
  });

  it("refuses every field a loop is not told, by name", () => {
    // A loop is a region: it frames the blocks it repeats and starts no run of
    // its own, so each of these describes a run that does not exist. Refused
    // rather than coerced away, which is the treatment an agent on a merge
    // block gets — a choice the operator made that no process would ever act
    // on is exactly what this door exists to answer out loud.
    const told: Array<[Record<string, unknown>, RegExp]> = [
      [{ task: "Do the thing" }, /no task for it to do/],
      [{ templateId: "t-iso" }, /no guards for it to run under/],
      [{ agentId: "a-rev" }, /nothing for that agent to be/],
      [{ mountId: "work" }, /no workspace for it to work in/],
      [{ folder: "repo" }, /no folder for it to work in/],
      [{ promptOverride: "Be brief" }, /no standing instructions/],
    ];
    for (const [field, says] of told) {
      const refusal = error(looped(field));
      assert.match(refusal, says, JSON.stringify(field));
      assert.match(refusal, /starts no run of its own/, JSON.stringify(field));
    }
  });

  it("keeps a loop's own fields empty once it has been read", () => {
    // Nothing is *coerced* in — the refusals above are what keeps these empty —
    // but a reader is entitled to the same shape a merge block has, because
    // `planNode`, `folderRefusal` and `guardsFor` are all skipped on the
    // strength of it.
    const loop = value(looped()).graph.nodes[0];
    assert.equal(loop.task, "");
    assert.equal(loop.templateId, null);
    assert.equal(loop.agentId, null);
    assert.equal(loop.mountId, "");
    assert.equal(loop.folder, "");
    assert.equal(loop.promptOverride, null);
  });

  it("leaves both caps null on every other kind", () => {
    // A `maxPasses` on a run block would be a number nothing reads, which is
    // worse than a refusal: it looks like a limit.
    const v = value(
      graph(
        [
          node("a", { maxPasses: 4, maxLoopCostUSD: 9 }),
          decider("b", { maxPasses: 4, maxLoopCostUSD: 9 }),
          merger("m", { maxPasses: 4, maxLoopCostUSD: 9 }),
        ],
        [edge("a", "m")],
      ),
    );
    assert.deepEqual(
      v.graph.nodes.map((n) => [n.maxPasses, n.maxLoopCostUSD]),
      [
        [null, null],
        [null, null],
        [null, null],
      ],
    );
  });

  it("refuses a hand-over at either end of a loop, by name", () => {
    // A loop used to be a legal end of one, when its passes were runs on a
    // shared ref. Each pass now lands its own work through the section's exit,
    // so the loop block holds no ref at all — and the sentence has to say that
    // rather than the isolation test's "its guards work directly in the
    // folder", which is about a checkout a loop does not have.
    const out = error(
      graph(
        [repeater("l"), node("a"), merger("m"), node("z")],
        [
          repeats("l", "a"),
          edge("a", "m"),
          edge("l", "z", { continueBranch: true }),
        ],
      ),
    );
    assert.match(out, /frames the blocks it repeats and each pass lands/);
    const into = error(
      graph(
        [repeater("l"), node("a"), merger("m"), node("z")],
        [
          repeats("l", "a"),
          edge("a", "m"),
          edge("z", "l", { continueBranch: true }),
        ],
      ),
    );
    assert.match(into, /frames the blocks it repeats and each pass lands/);
  });

  it("lets a loop hand on without a branch", () => {
    const v = value(
      graph(
        [repeater("l"), node("a"), merger("m"), node("z")],
        [repeats("l", "a"), edge("a", "m"), edge("l", "z")],
      ),
    );
    assert.equal(v.graph.edges[2].continueBranch, false);
  });
});

/* ------------------------------------------------------------------ */
/* Loop blocks: the section a loop repeats                             */
/* ------------------------------------------------------------------ */

/**
 * Every refusal that makes a repeated *section* safe, and the arithmetic a
 * press of Run is approved against.
 *
 * All of them fail silently or late. A section naming a block that is not
 * there, or a block two loops both claim, is a run created twice on one folder
 * by two things that each believe they own it. A loop inside a loop multiplies
 * one pass cap by another, which is a number nobody can work out from the two
 * they typed. A run member whose guards do not isolate loses every pass's work
 * into a folder with no branch under it. An edge across the boundary gives
 * "when is this released" two answers. A section that ends anywhere but at a
 * merge block leaves the next pass working from a branch that cannot see what
 * the last one did — silent, and paid for a pass at a time. And the limit is
 * the arithmetic nobody does: an orchestrator member spends its fan-out cap
 * again on every pass, so 20 passes over a section holding one is not 20 runs.
 */
describe("normalizeWorkflowInput — the blocks a loop repeats", () => {
  it("refuses a loop that frames nothing", () => {
    // The end of the body-less loop, and the reason it has to be a refusal
    // rather than a reading: a loop holds no work of its own now, so one with
    // no section is a block that could only ever report that it had nothing
    // to do — after a save, and on the page.
    assert.match(error(graph([repeater("l")])), /has nothing to repeat/);
    assert.match(error(graph([repeater("l")])), /Draw a “repeats” link/);
  });

  it("refuses a section stated as a list with no link to match", () => {
    // Its own sentence, because the caller said what it wanted and is owed the
    // half that is missing rather than "nothing to repeat" — which is false of
    // a graph carrying the list. This is the reading that used to be the
    // compatibility path; nothing on this machine was saved that way.
    const refusal = error(
      graph(
        [repeater("l", { bodyNodeIds: ["a", "m"] }), node("a"), merger("m")],
        [edge("a", "m")],
      ),
    );
    assert.match(refusal, /names the blocks it repeats but is not linked/);
    assert.match(refusal, /a list on its own no longer says it/);
  });

  it("keeps a section on a loop and an empty one on every other kind", () => {
    const v = value(
      graph(
        [repeater("l"), node("a"), node("b"), merger("m")],
        [repeats("l", "a"), inside("a", "b"), edge("b", "m")],
      ),
    );
    assert.deepEqual(v.graph.nodes[0].bodyNodeIds, ["a", "b", "m"]);
    assert.deepEqual(v.graph.nodes[1].bodyNodeIds, []);
  });

  it("refuses a body on a block that has no passes to repeat it in", () => {
    // Refused rather than dropped, `stopWhenTasks`' treatment one field over: a
    // section nobody repeats is work this app would quietly have run once.
    for (const make of [node, decider, merger]) {
      assert.match(
        error(graph([make("x", { bodyNodeIds: ["a"] }), node("a")])),
        /only a repeating block/,
      );
    }
  });

  it("refuses a block two loops both repeat, naming both", () => {
    // The one claim question the derivation leaves open: two `repeats` links
    // into one block make two sections that both own it, and each pass of each
    // loop would create it again on one folder.
    const refusal = error(
      graph(
        [repeater("l"), repeater("k"), node("a"), merger("m")],
        [repeats("l", "a"), repeats("k", "a"), edge("a", "m")],
      ),
    );
    assert.match(refusal, /“A” is in the section repeated by both/);
    assert.match(refusal, /can only be repeated by one loop/);
  });

  it("holds a run block, an orchestrator block and a merge block", () => {
    // The three refusals that used to name them are gone. An orchestrator
    // block's fan-out is now spent per pass and stated in the arithmetic
    // below; a merge block is what a section *ends* at.
    const v = value(
      graph(
        [repeater("l"), node("a"), decider("d"), merger("m")],
        [repeats("l", "a"), edge("a", "d"), edge("d", "m"), edge("a", "m")],
      ),
    );
    assert.deepEqual(v.graph.nodes[0].bodyNodeIds, ["a", "d", "m"]);
  });

  it("refuses a loop inside a loop, as the one kind left out", () => {
    const refusal = error(nested());
    assert.match(refusal, /multiplies one pass cap by another/);
    assert.match(refusal, /the one kind of block a section may not hold/);
  });

  it("refuses a run member whose guards work directly in the folder", () => {
    // Per member and for the section's own reason: every pass has to land what
    // it produced, and guards that work in the folder leave nothing to land.
    // The flat block sits behind another run block rather than in front of the
    // merge, so it is *this* rule that answers rather than the merge's own
    // "leaves no branch for me to land".
    assert.match(
      error(
        graph(
          [
            repeater("l"),
            node("a", { templateId: "t-flat" }),
            node("b"),
            merger("m"),
          ],
          [repeats("l", "a"), edge("a", "b"), edge("b", "m")],
        ),
      ),
      /needs a checkout of its own/,
    );
  });

  it("exempts an orchestrator member from that test, by name", () => {
    // By name rather than by passing a test written about a checkout: an
    // orchestrator spends nothing on disk, so "its guards work directly in the
    // folder" would be a sentence about a folder it never works in. It names
    // the flat template here, which is exactly what the run member above is
    // refused for — and it sits behind a run block rather than in front of the
    // merge, because a *merge's* own producers are a rule of their own.
    const v = value(
      graph(
        [
          repeater("l"),
          node("a"),
          decider("d", { templateId: "t-flat" }),
          node("b"),
          merger("m"),
        ],
        [
          repeats("l", "a"),
          edge("a", "d"),
          edge("d", "b"),
          edge("b", "m"),
          edge("a", "m"),
        ],
      ),
    );
    // Sorted, because the link that lands “A” puts “M” earlier in the walk.
    assert.deepEqual([...v.graph.nodes[0].bodyNodeIds].sort(), ["a", "b", "d", "m"]);
  });

  it("exempts a merge member from that test on a machine with no default", () => {
    // Separate from the orchestrator's case because it is only *observable*
    // where the untemplated guard set does not isolate: a merge block names no
    // template, `isolatedTemplate(null)` asks `defaultIsolate`, and `KNOWN`
    // says yes — so on that machine the exemption and the test agree and the
    // case proves nothing. Here they disagree, and without the exemption the
    // block a section has to end at would be the thing refusing it.
    const flat = { ...KNOWN, defaultIsolate: false };
    const res = normalizeWorkflowInput(
      graph(
        [repeater("l"), node("a"), merger("m")],
        [repeats("l", "a"), edge("a", "m")],
      ),
      flat,
    );
    assert.ok(res.ok, res.ok ? "" : res.error);
    assert.deepEqual(res.value.graph.nodes[0].bodyNodeIds, ["a", "m"]);
  });

  it("refuses a link into a section from outside it", () => {
    assert.match(
      error(
        graph(
          [repeater("l"), node("a"), merger("m"), node("z")],
          [repeats("l", "a"), edge("a", "m"), edge("z", "a")],
        ),
      ),
      /the “repeats” link is the only way in/,
    );
  });

  it("absorbs a link drawn out of a section rather than refusing it", () => {
    // There is no way *out* to refuse: membership is the forward closure of the
    // entry, so a block linked after the section's exit joins the section. What
    // answers is the exit rule — the section now ends at “Z”, which lands
    // nothing — and that is the sentence the operator can act on.
    assert.match(
      error(
        graph(
          [repeater("l"), node("a"), merger("m"), node("z")],
          [repeats("l", "a"), edge("a", "m"), edge("m", "z")],
        ),
      ),
      /ends at “Z”, which is not a merge block/,
    );
  });

  it("refuses the loop's own ordinary edges to and from its members", () => {
    // Both used to be accepted and inert, which is the defect the `repeats`
    // condition replaced: an operator who drew the arrow they could see was
    // told nothing, and the section came from a switch somewhere else. Each
    // names the link to draw instead.
    assert.match(
      error(
        graph(
          [repeater("l"), node("a"), merger("m")],
          [repeats("l", "a"), edge("a", "m"), edge("l", "m")],
        ),
      ),
      /A loop has one way in: the “repeats” link/,
    );
    assert.match(
      error(
        graph(
          [repeater("l"), node("a"), merger("m")],
          [repeats("l", "a"), edge("a", "m"), edge("m", "l")],
        ),
      ),
      /linked from the loop block, not from inside the section/,
    );
  });

  it("lets a section fork and meet again at its merge block", () => {
    // The chain rule, gone. Two members off one predecessor is a diamond, and
    // what makes it safe is that only one of them carries the branch: “B”
    // carries on “A”'s, “C” cuts its own, and the section's exit lands both.
    const v = value(
      graph(
        [repeater("l"), node("a"), node("b"), node("c"), merger("m")],
        [
          repeats("l", "a"),
          inside("a", "b"),
          edge("a", "c"),
          edge("b", "m"),
          edge("c", "m"),
        ],
      ),
    );
    assert.deepEqual(v.graph.nodes[0].bodyNodeIds.length, 4);
  });

  it("refuses a section that ends in more than one place", () => {
    // One sentence for two defects, because they are one fact: “B” has no path
    // to the block that lands the pass, and where it stops instead is the
    // second end. Its work would sit on a branch nothing ever lands.
    const refusal = error(
      graph(
        [repeater("l"), node("a"), node("b"), merger("m")],
        [repeats("l", "a"), edge("a", "m"), edge("a", "b")],
      ),
    );
    assert.match(refusal, /ends in 2 places: “M”, “B”|ends in 2 places: “B”, “M”/);
    assert.match(refusal, /committed on a branch nothing ever lands/);
  });

  it("refuses a run member whose branch reaches the exit by path alone", () => {
    // A fan-in: “J” can carry on one of the two branches that meet at it, and a
    // merge block lands only the runs directly in front of it — so “B” has a
    // path to “M” through “J” and its work still lands nowhere. The sentence
    // names the link that would land it.
    const fanIn = error(
      graph(
        [
          repeater("l"),
          node("e"),
          node("a"),
          node("b"),
          node("j"),
          merger("m"),
        ],
        [
          repeats("l", "e"),
          inside("e", "a"),
          edge("e", "b"),
          inside("a", "j"),
          edge("b", "j"),
          edge("j", "m"),
        ],
      ),
    );
    assert.match(fanIn, /Nothing lands “B”'s branch in the section “L” repeats/);
    assert.match(fanIn, /Link “B” to “M” as well/);

    // An orchestrator member hands no branch on either, whatever it decides.
    assert.match(
      error(
        graph(
          [repeater("l"), node("a"), decider("d"), merger("m")],
          [repeats("l", "a"), edge("a", "d"), edge("d", "m")],
        ),
      ),
      /Nothing lands “A”'s branch.*Link “A” to “M” as well/,
    );
  });

  it("saves a fan-in whose second branch is linked to the exit", () => {
    const v = value(
      graph(
        [
          repeater("l"),
          node("e"),
          node("a"),
          node("b"),
          node("j"),
          merger("m"),
        ],
        [
          repeats("l", "e"),
          inside("e", "a"),
          edge("e", "b"),
          inside("a", "j"),
          edge("b", "j"),
          edge("j", "m"),
          edge("b", "m"),
        ],
      ),
    );
    assert.equal(v.graph.nodes[0].bodyNodeIds.length, 5);
  });

  it("refuses an orchestrator member whose runs reach the exit through a run", () => {
    // “O” resolves to its emitted runs without their branches, so “J” starts
    // fresh, “M” lands “J” alone, and whatever “O” started lands nowhere.
    // `e → m` is there so that “E”, whose only other way on is “O”, is not the
    // member refused first. The same shape with a flat-template “O” saves:
    // that is "exempts an orchestrator member from that test, by name" above.
    const nodes = [repeater("l"), node("e"), decider("o"), node("j"), merger("m")];
    const links = [
      repeats("l", "e"),
      edge("e", "o"),
      edge("o", "j"),
      edge("j", "m"),
      edge("e", "m"),
    ];
    const refusal = error(graph(nodes, links));
    assert.match(refusal, /Nothing lands the runs “O” starts in the section “L” repeats/);
    assert.match(refusal, /Link “O” to “M” as well/);

    const v = value(graph(nodes, [...links, edge("o", "m")]));
    assert.deepEqual([...v.graph.nodes[0].bodyNodeIds].sort(), ["e", "j", "m", "o"]);
  });

  it("refuses a review member whose approved branches reach the exit through a run", () => {
    // Always asked of a review, unlike an orchestrator: it reviews only work
    // that was cut on a branch, and hands on what it approved without it.
    const nodes = [
      repeater("l"),
      node("e"),
      { id: "v", name: "V", kind: "review", fixRounds: 1 },
      node("j"),
      merger("m"),
    ];
    const links = [repeats("l", "e"), edge("e", "v"), edge("v", "j"), edge("j", "m")];
    const refusal = error(graph(nodes, links));
    assert.match(refusal, /Nothing lands the branches “V” approves in the section “L” repeats/);
    assert.match(refusal, /Link “V” to “M” as well/);

    const v = value(graph(nodes, [...links, edge("v", "m")]));
    assert.deepEqual([...v.graph.nodes[0].bodyNodeIds].sort(), ["e", "j", "m", "v"]);
  });

  it("refuses a section that does not end at a merge block", () => {
    const refusal = error(
      graph(
        [repeater("l"), node("a"), node("b")],
        [repeats("l", "a"), inside("a", "b")],
      ),
    );
    assert.match(refusal, /ends at “B”, which is not a merge block/);
    assert.match(refusal, /add a merge block at the end of the section/);
  });

  it("refuses a loop whose worst case is more runs than anyone agreed to", () => {
    // Every factor named, because a cap on the product alone is a number the
    // operator cannot act on. Four run blocks and a merge, 20 passes: 80.
    const refusal = error(
      graph(
        [
          repeater("l", { maxPasses: 20 }),
          node("a"),
          node("b"),
          node("c"),
          node("d"),
          merger("m"),
        ],
        [
          repeats("l", "a"),
          inside("a", "b"),
          inside("b", "c"),
          inside("c", "d"),
          edge("d", "m"),
        ],
      ),
    );
    assert.match(refusal, /repeats 5 block\(s\) up to 20 time\(s\)/);
    assert.match(refusal, /Each pass is 4 run\(s\)/);
    assert.match(refusal, /which is 80 runs/);
    assert.match(refusal, /at most 60/);
  });

  it("charges an orchestrator member's fan-out again on every pass", () => {
    // The arithmetic the operator chose, and the whole cost of letting one into
    // a section: a fan-out cap is what that block may start each time it is
    // reached, and a section reaches it once a pass. One run block, one decider
    // with a cap of 3 and a merge is 1 + 1 + 3 = 5 a pass, so 20 passes is 100.
    const refusal = error(
      graph(
        [repeater("l", { maxPasses: 20 }), node("a"), decider("d"), merger("m")],
        [repeats("l", "a"), edge("a", "d"), edge("d", "m"), edge("a", "m")],
      ),
    );
    assert.match(refusal, /repeats 3 block\(s\) up to 20 time\(s\)/);
    assert.match(refusal, /Each pass is 5 run\(s\)/);
    assert.match(refusal, /“D” the deciding turn plus the 3 runs/);
    assert.match(refusal, /spent again on every pass/);
    assert.match(refusal, /which is 100 runs/);
  });

  it("allows a section whose worst case is exactly the limit", () => {
    // The boundary the arithmetic is decided on. Three run blocks and a merge
    // is 3 runs a pass, and 20 × 3 is 60, which is allowed — the merge block
    // is not a run and is not counted.
    const v = value(
      graph(
        [
          repeater("l", { maxPasses: 20 }),
          node("a"),
          node("b"),
          node("c"),
          merger("m"),
        ],
        [
          repeats("l", "a"),
          inside("a", "b"),
          inside("b", "c"),
          edge("c", "m"),
        ],
      ),
    );
    assert.deepEqual(v.graph.nodes[0].bodyNodeIds, ["a", "b", "c", "m"]);
  });
});

/* ------------------------------------------------------------------ */
/* Loop blocks: the link that says what a loop repeats                 */
/* ------------------------------------------------------------------ */

/**
 * What an operator *draws* is what a loop repeats, and every way of getting
 * that wrong is silent or expensive.
 *
 * The derivation is the whole mechanism: read short it drops a block out of
 * every pass, read long it puts one in that nobody meant to repeat — and
 * either way the graph saves, the region draws, and the sentence a press of Run
 * is approved against states the wrong section. A `repeats` link taken for a
 * dependency is worse still: `releasableRuns` would leave the loop waiting for
 * a run only the loop creates, and the instance would never finish with nothing
 * on the page to say why.
 *
 * The link is the *only* thing that states a section now. A list sent beside it
 * is a cross-check and a list sent without one is refused, which is what ended
 * the loop that repeated its own task.
 */
describe("normalizeWorkflowInput — the link that makes a section", () => {
  it("derives the section from the link and everything after it", () => {
    const v = value(
      graph(
        [repeater("l"), node("a"), node("b"), node("c"), merger("m")],
        [
          repeats("l", "a"),
          inside("a", "b"),
          inside("b", "c"),
          edge("c", "m"),
        ],
      ),
    );
    assert.deepEqual(v.graph.nodes[0].bodyNodeIds, ["a", "b", "c", "m"]);
    // And the link survives the round trip: the editor redraws the graph from
    // it, so dropping it here would lose the section on the next save.
    assert.equal(
      v.graph.edges.filter((e) => e.edge === "repeats").length,
      1,
    );
  });

  it("refuses two “repeats” links out of one loop, naming both targets", () => {
    // Both named, because the operator has to choose between them and a
    // refusal that says only "two" leaves them hunting for the second.
    const refusal = error(
      graph(
        [repeater("l"), node("a"), node("b")],
        [repeats("l", "a"), repeats("l", "b")],
      ),
    );
    assert.match(refusal, /“A” and “B”/);
    assert.match(refusal, /A loop repeats one section/);
  });

  it("refuses a “repeats” link out of a block that has no passes", () => {
    for (const make of [node, decider, merger]) {
      assert.match(
        error(graph([make("x"), node("a")], [repeats("x", "a")])),
        /Only a repeating block has a “repeats” link/,
      );
    }
  });

  it("refuses a “repeats” link set to hand over a branch", () => {
    assert.match(
      error(
        graph(
          [repeater("l"), node("a")],
          [edge("l", "a", { edge: "repeats", continueBranch: true })],
        ),
      ),
      /says what is inside the loop, not what starts after it/,
    );
  });

  it("refuses a link and a list that disagree, naming both sections", () => {
    // Resolved in favour of neither. A caller that sent both meant something by
    // each, and dropping half of it in silence is what this door exists to
    // stop — the operator would get a workflow repeating a section they can see
    // they did not ask for.
    const refusal = error(
      graph(
        [repeater("l", { bodyNodeIds: ["a"] }), node("a"), merger("m")],
        [repeats("l", "a"), edge("a", "m")],
      ),
    );
    assert.match(refusal, /says twice what it repeats, and the two disagree/);
    assert.match(refusal, /makes a section of “A”, “M”/);
  });

  it("accepts a link and a list that agree", () => {
    const v = value(
      graph(
        [repeater("l", { bodyNodeIds: ["m", "a"] }), node("a"), merger("m")],
        [repeats("l", "a"), edge("a", "m")],
      ),
    );
    // Stored in the order a pass creates them, whichever order the list was in.
    assert.deepEqual(v.graph.nodes[0].bodyNodeIds, ["a", "m"]);
  });

  it("lets a link inside a section say either condition", () => {
    // The chain rule went, and this went with it: "every link inside a section
    // is on-success and carries the branch" was that rule stated a second way,
    // because a section whose every link carries the branch cannot fork —
    // `graphRefusal` refuses two runs extending one ref everywhere. A section
    // is now judged by its two ends, and the links in between are ordinary.
    const v = value(
      graph(
        [repeater("l"), node("a"), node("b"), merger("m")],
        [
          repeats("l", "a"),
          edge("a", "b", { edge: "on-finish", continueBranch: true }),
          edge("b", "m"),
        ],
      ),
    );
    assert.deepEqual(v.graph.nodes[0].bodyNodeIds, ["a", "b", "m"]);
  });

  it("names the exit before the condition on a section still being drawn", () => {
    // Order between two refusals, and it is the useful one: a section still
    // being assembled has no merge block at the end of it yet, and that is the
    // sentence that gets the operator to the next step.
    assert.match(
      error(
        graph(
          [repeater("l"), node("a"), node("b"), node("c")],
          [repeats("l", "a"), edge("a", "b"), edge("a", "c")],
        ),
      ),
      /ends in 2 places/,
    );
  });

  it("refuses a member linked back to its own loop", () => {
    // The back edge, drawn. Named by the boundary rule rather than reported as
    // a cycle, because "these blocks wait for each other" is true of nothing
    // here — a `repeats` link is not a wait.
    assert.match(
      error(
        graph(
          [repeater("l"), node("a"), merger("m")],
          [repeats("l", "a"), edge("a", "m"), edge("m", "l")],
        ),
      ),
      /linked from the loop block, not from inside the section/,
    );
  });

  it("lets the loop hand on to what comes after the section", () => {
    const v = value(
      graph(
        [repeater("l"), node("a"), merger("m"), node("z")],
        [repeats("l", "a"), edge("a", "m"), edge("l", "z")],
      ),
    );
    assert.deepEqual(v.graph.nodes[0].bodyNodeIds, ["a", "m"]);
  });

  it("stops the walk at the next loop's own “repeats” link", () => {
    // Two loops one after the other, which is legal and is the shape that
    // catches a walk following the wrong arrow: “K” is linked after “L”, so a
    // walk that took its `repeats` link would swallow “K”'s section into “L”'s
    // and refuse the graph for a nesting nobody drew.
    const v = value(
      graph(
        [
          repeater("l"),
          node("a"),
          merger("m"),
          repeater("k"),
          node("z"),
          merger("n"),
        ],
        [
          repeats("l", "a"),
          edge("a", "m"),
          edge("l", "k"),
          repeats("k", "z"),
          edge("z", "n"),
        ],
      ),
    );
    assert.deepEqual(v.graph.nodes[0].bodyNodeIds, ["a", "m"]);
    assert.deepEqual(v.graph.nodes[3].bodyNodeIds, ["z", "n"]);
  });

  it("orders the section the way a pass creates it", () => {
    // `loopBody` reads the same section off the same edges, so a graph that
    // normalized and a walk of it cannot disagree about which block is last —
    // which is the block whose `DONE` a pass is read off.
    const v = value(
      graph(
        [repeater("l"), node("a"), node("b"), merger("m")],
        [repeats("l", "a"), inside("a", "b"), edge("b", "m")],
      ),
    );
    assert.deepEqual(
      loopBody(v.graph, v.graph.nodes[0]).map((n) => n.id),
      ["a", "b", "m"],
    );
  });
});

/* ------------------------------------------------------------------ */
/* Loop blocks: the board condition                                    */
/* ------------------------------------------------------------------ */

/** The condition as a saved graph carries it, so a case varies one field. */
function board(over: Record<string, unknown> = {}) {
  return {
    mountId: "work",
    folder: "repo",
    statuses: ["open"],
    thresholds: [{ priority: "any", atMost: 0 }],
    ...over,
  };
}

describe("normalizeWorkflowInput — a loop's board condition", () => {
  it("keeps a condition a loop block set", () => {
    const v = value(looped({ stopWhenTasks: board() }, "a"));
    assert.deepEqual(v.graph.nodes[0].stopWhenTasks, {
      mountId: "work",
      folder: "repo",
      includeSubfolders: false,
      statuses: ["open"],
      thresholds: [{ priority: "any", atMost: 0 }],
    });
  });

  it("reads nothing, null and the empty string as off", () => {
    // The whole of what makes a graph saved before this field existed keep
    // working: every one of them says nothing here, and the other reading would
    // turn each into a graph refused at save for a condition nobody wrote.
    for (const raw of [undefined, null, ""]) {
      const v = value(looped({ stopWhenTasks: raw }, "a"));
      assert.equal(v.graph.nodes[0].stopWhenTasks, null, `for ${String(raw)}`);
    }
  });

  it("refuses the condition on every kind but a loop", () => {
    // Refused rather than dropped, which is where this parts company with the
    // two caps: a cap on a run block is a number nothing reads, where this is an
    // ending the operator wrote down against a block that has no passes to end.
    for (const make of [node, decider, merger]) {
      assert.match(
        error(graph([make("a", { stopWhenTasks: board() })])),
        /only a repeating block has passes to stop/,
      );
    }
  });

  it("refuses a workspace that is not mounted", () => {
    assert.match(
      error(looped({ stopWhenTasks: board({ mountId: "gone" }) }, "a")),
      /not mounted: gone/,
    );
    assert.match(
      error(looped({ stopWhenTasks: board({ mountId: "" }) }, "a")),
      /names no workspace to count them in/,
    );
  });

  it("refuses a terminal status by name", () => {
    // The silent one. `done` and `dropped` only ever grow, so "at most 0"
    // against either holds the first time it is asked — the loop would stop
    // before its first pass and nothing would say why.
    for (const status of ["done", "dropped"]) {
      assert.match(
        error(
          looped({ stopWhenTasks: board({ statuses: [status] }) }, "a"),
        ),
        new RegExp(`counts ${status} tasks, and that count only ever grows`),
        status,
      );
    }
  });

  it("refuses a status the board does not have, and an empty list", () => {
    assert.match(
      error(
        looped({ stopWhenTasks: board({ statuses: ["parked"] }) }, "a"),
      ),
      /a state the board does not have: parked/,
    );
    assert.match(
      error(looped({ stopWhenTasks: board({ statuses: [] }) }, "a")),
      /names no task states to count/,
    );
  });

  it("keeps both countable statuses, once each", () => {
    const v = value(
      looped({
          stopWhenTasks: board({ statuses: ["open", "claimed", "open"] }),
        }, "a"),
    );
    assert.deepEqual(v.graph.nodes[0].stopWhenTasks?.statuses, [
      "open",
      "claimed",
    ]);
  });

  it("refuses a fractional, negative or unreadable number to stop at", () => {
    for (const atMost of [1.5, -1, null, undefined, "", "many", Number.NaN]) {
      assert.match(
        error(
          looped({
              stopWhenTasks: board({ thresholds: [{ priority: "any", atMost }] }),
            }, "a"),
        ),
        /whole number of tasks to stop at/,
        String(atMost),
      );
    }
  });

  it("keeps zero, which is the whole point of the condition", () => {
    const v = value(
      looped({
          stopWhenTasks: board({ thresholds: [{ priority: "any", atMost: 0 }] }),
        }, "a"),
    );
    assert.deepEqual(v.graph.nodes[0].stopWhenTasks?.thresholds, [
      { priority: "any", atMost: 0 },
    ]);
  });

  it("reads a condition saved as one number as one “any” threshold", () => {
    // The compatibility rule of the whole change, asked at the door a saved
    // workflow comes back through: every re-save and every validate keystroke
    // hands the stored blob back to this function, and a graph written before
    // thresholds existed has to come out meaning what it meant.
    const v = value(
      looped({
          stopWhenTasks: {
            mountId: "work",
            folder: "repo",
            statuses: ["open"],
            atMost: 7,
          },
        }, "a"),
    );
    assert.deepEqual(v.graph.nodes[0].stopWhenTasks, {
      mountId: "work",
      folder: "repo",
      includeSubfolders: false,
      statuses: ["open"],
      thresholds: [{ priority: "any", atMost: 7 }],
    });
  });

  it("refuses a condition that names no number at all", () => {
    // Not read as "stop at zero": zero is the strictest legal setting, so the
    // coercion would be this app choosing "until the board is clear" for
    // somebody who cleared the field.
    for (const thresholds of [[], null, undefined]) {
      assert.match(
        error(looped({ stopWhenTasks: board({ thresholds }) }, "a")),
        /names no number to stop at/,
        String(thresholds),
      );
    }
  });

  it("refuses a priority the board does not have", () => {
    assert.match(
      error(
        looped({
            stopWhenTasks: board({
              thresholds: [{ priority: "blocker", atMost: 1 }],
            }),
          }, "a"),
      ),
      /a priority the board does not have: blocker/,
    );
  });

  it("refuses one priority named twice", () => {
    // The quiet one: the condition still works, and the lower of the two
    // numbers is a line the operator wrote that can never fire.
    assert.match(
      error(
        looped({
            stopWhenTasks: board({
              thresholds: [
                { priority: "normal", atMost: 5 },
                { priority: "normal", atMost: 2 },
              ],
            }),
          }, "a"),
      ),
      /names normal twice/,
    );
  });

  it("refuses more numbers than a condition may carry", () => {
    assert.match(
      error(
        looped({
            stopWhenTasks: board({
              thresholds: [
                { priority: "any", atMost: 1 },
                { priority: "urgent", atMost: 1 },
                { priority: "high", atMost: 1 },
                { priority: "normal", atMost: 1 },
                { priority: "low", atMost: 1 },
                { priority: "any", atMost: 2 },
              ],
            }),
          }, "a"),
      ),
      /may stop on at most 5 numbers/,
    );
  });

  it("keeps several thresholds, in the order they were written", () => {
    const v = value(
      looped({
          stopWhenTasks: board({
            thresholds: [
              { priority: "any", atMost: 10 },
              { priority: "normal", atMost: 5 },
            ],
          }),
        }, "a"),
    );
    assert.deepEqual(v.graph.nodes[0].stopWhenTasks?.thresholds, [
      { priority: "any", atMost: 10 },
      { priority: "normal", atMost: 5 },
    ]);
  });

  it("reads a threshold with no priority on it as the project whole", () => {
    const v = value(
      looped({ stopWhenTasks: board({ thresholds: [{ atMost: 3 }] }) }, "a"),
    );
    assert.deepEqual(v.graph.nodes[0].stopWhenTasks?.thresholds, [
      { priority: "any", atMost: 3 },
    ]);
  });

  it("reads anything but true as not counting subfolders", () => {
    // The board's own grouping is one folder to one project, and a condition
    // saved before this field existed says nothing here. Widening it in silence
    // would count a backlog the operator was never shown.
    for (const raw of [undefined, null, "", 0, "true"]) {
      const v = value(
        looped({ stopWhenTasks: board({ includeSubfolders: raw }) }, "a"),
      );
      assert.equal(
        v.graph.nodes[0].stopWhenTasks?.includeSubfolders,
        false,
        String(raw),
      );
    }
    const on = value(
      looped({ stopWhenTasks: board({ includeSubfolders: true }) }, "a"),
    );
    assert.equal(on.graph.nodes[0].stopWhenTasks?.includeSubfolders, true);
  });

  it("keeps the mount root as a folder rather than as an absence", () => {
    // `""` is the workspace root, the same real selection it is on the block's
    // own folder — the reader canonicalises it through the board's resolver.
    const v = value(looped({ stopWhenTasks: board({ folder: "" }) }, "a"));
    assert.equal(v.graph.nodes[0].stopWhenTasks?.folder, "");
  });
});

/* ------------------------------------------------------------------ */
/* Halting                                                             */
/* ------------------------------------------------------------------ */

/**
 * One instance holding every kind of member at once.
 *
 * `Review` waits behind `Build`, which is the case that decides the ordering
 * inside the halt: stopping `Build` releases its dependents, so a waiting member
 * left until last would be admitted, promoted and spawned *because* the workflow
 * was stopped.
 */
const MEMBERS: HaltMember[] = [
  { runId: "r-build", nodeName: "Build", status: "running" },
  { runId: "r-test", nodeName: "Test", status: "queued" },
  { runId: "r-docs", nodeName: "Docs", status: "paused" },
  { runId: "r-review", nodeName: "Review", status: "waiting" },
  { runId: "r-landed", nodeName: "Landed", status: "completed" },
  { runId: "r-broken", nodeName: "Broken", status: "failed" },
];

const OPERATOR: HaltCause = { kind: "operator" };
const GUARD: HaltCause = {
  kind: "guard",
  detail: "This workflow has spent $12.40 of its $10.00 limit.",
};

function plan(
  status: WorkflowInstanceStatus = "started",
  members: readonly HaltMember[] = MEMBERS,
  cause: HaltCause = OPERATOR,
  liveBlocks = 0,
) {
  return haltPlan(
    { status, workflowName: "Nightly", liveBlocks },
    members,
    cause,
  );
}

/** What the halt decided about one member, by run id. */
function step(decision: ReturnType<typeof plan>, runId: string) {
  const found = decision.steps.find((s) => s.runId === runId);
  assert.ok(found, `no step for ${runId}`);
  return found;
}

describe("haltPlan — which members a stop selects, and what each becomes", () => {
  it("covers every member exactly once", () => {
    // The silent half of getting this wrong is a member nobody decided about:
    // it is not stopped, it is not reported, and it goes on spending under a
    // workflow the page says is stopped.
    const decision = plan();
    assert.equal(decision.act, true);
    assert.deepEqual(
      decision.steps.map((s) => s.runId),
      MEMBERS.map((m) => m.runId),
    );
  });

  it("sends the three live statuses through stopRun", () => {
    // One action for all three, because `stopRun` is the one path that signals a
    // child and it re-reads the row itself: a queued member promoted to running
    // by an earlier stop in the same pass still lands on the right branch.
    const decision = plan();
    assert.equal(step(decision, "r-build").action, "stop");
    assert.equal(step(decision, "r-test").action, "stop");
    assert.equal(step(decision, "r-docs").action, "stop");
  });

  it("blocks a waiting member rather than stopping it", () => {
    // `blocked` is the true thing to say: nothing ran and nothing was spent. It
    // also keeps the run out of REOPENABLE, which is honest — picking one link
    // of a halted chain back up would start it on work that never happened.
    const waiting = step(plan(), "r-review");
    assert.equal(waiting.action, "block");
    assert.match(waiting.reason ?? "", /waiting for another run\.$/);
  });

  it("leaves a finished member exactly as it is", () => {
    // Rewriting a completed run as stopped destroys the record of work that
    // landed, and nothing on the page afterwards says it ever happened.
    for (const id of ["r-landed", "r-broken"]) {
      const settled = step(plan(), id);
      assert.equal(settled.action, "leave");
      assert.equal(settled.reason, null);
    }
  });

  it("leaves a member whose run row has gone", () => {
    // Beside a live one, because an instance with nothing live is a no-op —
    // this is about the deleted row, not about whether the halt runs at all.
    const gone = step(
      plan("started", [
        MEMBERS[0],
        { runId: "r-gone", nodeName: "Gone", status: null },
      ]),
      "r-gone",
    );
    assert.equal(gone.action, "leave");
    assert.equal(gone.reason, null);
  });
});

describe("haltPlan — telling the three ways a run can be stopped apart", () => {
  it("names the workflow and the operator", () => {
    const decision = plan();
    assert.equal(
      decision.cause,
      "Stopped by the operator with all of workflow “Nightly”",
    );
  });

  it("names the workflow and the guard", () => {
    const decision = plan("started", MEMBERS, GUARD);
    assert.equal(
      decision.cause,
      "Stopped by the budget guard on workflow “Nightly”",
    );
  });

  it("differs from what a run stopped on its own page says", () => {
    // `stopRun`'s own default is "Stopped by operator", with no workflow in it.
    // The three sentences have to be distinguishable on sight, or ten rows read
    // as ten unrelated decisions.
    for (const cause of [OPERATOR, GUARD]) {
      const { cause: attribution } = plan("started", MEMBERS, cause);
      assert.notEqual(attribution, "Stopped by operator");
      assert.match(attribution, /workflow “Nightly”/);
    }
  });

  it("keeps the attribution a fragment, because stopRun completes it", () => {
    // Each of `stopRun`'s branches appends the clause saying what the run was
    // doing — "… before it started." A sentence here would punctuate mid-line.
    for (const cause of [OPERATOR, GUARD]) {
      assert.doesNotMatch(plan("started", MEMBERS, cause).cause, /[.!?]$/);
    }
  });

  it("keeps a guard's verdict off the member rows", () => {
    // It is one fact about one instance and is recorded there. Copied onto ten
    // rows it reads as ten separate findings.
    const decision = plan("started", MEMBERS, GUARD);
    for (const s of decision.steps) {
      assert.doesNotMatch(s.reason ?? "", /\$12\.40/);
    }
  });
});

describe("haltPlan — a stop that arrives when there is nothing to do", () => {
  it("is a no-op on an instance already stopping", () => {
    // Idempotence: a second press must not run a second kill ladder over
    // children that are already dying.
    const decision = plan("stopping");
    assert.equal(decision.act, false);
    assert.deepEqual(decision.steps, []);
    assert.match(decision.note ?? "", /already stopping/);
  });

  it("is a no-op on an instance whose members have all finished stopping", () => {
    const decision = plan("stopped");
    assert.equal(decision.act, false);
    assert.deepEqual(decision.steps, []);
    assert.match(decision.note ?? "", /already been stopped/);
  });

  it("is a no-op on a graph that was rolled back at creation", () => {
    // `failed` means every run it did create was stopped again in the same pass.
    const decision = plan("failed");
    assert.equal(decision.act, false);
    assert.deepEqual(decision.steps, []);
    assert.match(decision.note ?? "", /never started/);
  });

  it("is a no-op when every block has already finished", () => {
    // Members are created once and these have all settled, so none of them can
    // move again — there is no door to close. Marking the instance stopped would
    // put "stopped by the operator" on a workflow run that finished on its own.
    const decision = plan(
      "started",
      MEMBERS.filter((m) => m.status === "completed" || m.status === "failed"),
    );
    assert.equal(decision.act, false);
    assert.match(decision.note ?? "", /already finished/);
  });

  it("selects only the blocks that exist, mid-instantiation", () => {
    // A stop cannot land inside the creating pass — it holds the event-loop turn
    // from its first createRun to its last — so what it can see is whatever the
    // instance's run table already holds. A block whose run has not been created
    // is not a member, is not selected, and is never created either.
    const decision = plan("started", MEMBERS.slice(0, 2));
    assert.deepEqual(
      decision.steps.map((s) => s.runId),
      ["r-build", "r-test"],
    );
  });

  it("is a no-op on a graph that reached its end, in the word it now reads as", () => {
    // The same instance as the case above, seen through `instanceStatus`: with
    // nothing live it is `finished` rather than `started`, and this is the one
    // place a halt can meet that word. Reading it as "not started" would answer
    // "this run is already stopping" over a graph that stopped on its own.
    const decision = plan(
      "finished",
      MEMBERS.filter((m) => m.status === "completed" || m.status === "failed"),
    );
    assert.equal(decision.act, false);
    assert.match(decision.note ?? "", /already finished/);
  });
});

/* ------------------------------------------------------------------ */
/* Which of the six readings one instance row is                       */
/* ------------------------------------------------------------------ */

/**
 * `instanceStatus` — what a press of Run is reported as.
 *
 * Every way of being wrong here typechecks, throws nothing and renders a page,
 * which is exactly how the defect this pins survived: `started` was the word for
 * every unhalted row, so a graph that finished an hour ago, one whose tail was
 * written off behind a block that decided nothing, and one with a billed agent
 * working in it right now were one green badge between them. That word is what
 * an operator reads to decide whether to wait for it, to go and look at why a
 * block never ran, or to press Run again — and the third of those is money.
 */
describe("instanceStatus — a graph that ended is not a graph still working", () => {
  const tally = (live: number, blocked = 0) => ({ live, blocked });

  it("reads a member still going as started", () => {
    assert.equal(instanceStatus("started", tally(1)), "started");
  });

  it("reads a graph with nothing left to do as finished", () => {
    assert.equal(instanceStatus("started", tally(0)), "finished");
  });

  it("reads a graph whose tail was written off as blocked", () => {
    // The half a `finished` badge would hide: these blocks never ran, because
    // the one in front of them satisfied nothing, and nothing will ever wake
    // them. Reported as finished it reads as a workflow that did its work.
    assert.equal(instanceStatus("started", tally(0, 2)), "blocked");
  });

  it("reads a branch that died beside one still running as started", () => {
    // A blocked member does not end the instance: the rest of the graph is
    // still spending, and `started` is what says the page is worth refreshing.
    assert.equal(instanceStatus("started", tally(1, 1)), "started");
  });

  it("keeps the halt above whatever the members say", () => {
    // Who ended it is the headline. A member written off by the halt itself
    // must not turn "you stopped this" into "a block stopped it".
    assert.equal(instanceStatus("stopping", tally(2, 1)), "stopping");
    assert.equal(instanceStatus("stopping", tally(0, 1)), "stopped");
    assert.equal(instanceStatus("failed", tally(0, 3)), "failed");
    assert.equal(instanceStatus("failed", tally(2)), "failed");
  });

  it("reads an unrecognised stored value off the members", () => {
    // The forgiving default the graph blob gets, for the same reason: this is a
    // record and it has to keep rendering. A row written by another version
    // still says whether anything is live.
    assert.equal(instanceStatus("kicked-off", tally(1)), "started");
    assert.equal(instanceStatus("", tally(0)), "finished");
  });
});

/* ------------------------------------------------------------------ */
/* What an orchestrator block may emit                                 */
/* ------------------------------------------------------------------ */

/**
 * The two decisions that stand between a model's answer and N billed agents.
 *
 * These clear the bar the rest of `npm test` sets by a wider margin than
 * anything else in this file, because there is no person in the loop at all.
 * Every other route that starts a run has one: the run form, the chat's Approve
 * button, the press of Run on a graph a person wrote. Here the graph was
 * approved months ago and what starts is whatever the block decided a minute
 * ago — so a cap read one too high is an agent nobody agreed to, a folder check
 * that passes is an agent in a repository the block was never pointed at, and a
 * block that emits nothing leaves the runs behind it either started on absent
 * work or asleep for ever with nothing on the page to say why.
 */

/** Everything a block is measured against, so a case states only what it varies. */
function limits(over: Partial<EmissionLimits> = {}): EmissionLimits {
  return {
    blockName: "Pick the work",
    fanOut: 3,
    // Stands in for `resolveWorkspaceFolder` against the block's own mount:
    // "outside" is the one path this fixture refuses.
    folderRefusal: (folder) =>
      folder.startsWith("..") ? "It is outside the workspace." : null,
    // The registry as the turn was shown it. Data rather than an injected
    // function, unlike the folder above: one is a syscall and this is a list.
    agents: [
      { name: "Reviewer", usable: true },
      { name: "Half a thing", usable: false },
    ],
    // A function rather than a list, unlike the agents above, for the reason the
    // field gives: the board is unbounded where the registry is curated. The
    // real rule over a fixture board, so the wiring is what is under test.
    taskLinks: (fields, text) => readTaskLinks(fields, text, EMISSION_BOARD),
    ...over,
  };
}

// Shaped like real ids because `readTaskLinks` refuses a malformed one for its
// shape before it looks the board up.
const TASK_KNOWN = "5d2c7a10-3b84-4e9f-a1c6-0f8e2b7d4a31";
const TASK_OTHER = "b83e90c4-17d5-4a62-9c0b-6e4f1a2d8c57";
const TASK_GONE = "e1f40a97-62cb-4d38-8b15-3c9a7d0e5f26";

const EMISSION_BOARD = new Map([
  [TASK_KNOWN, { title: "The known task on the board", status: "open" as const, operatorOnly: false, needsFrontier: false, claimedByOperator: false }],
  [TASK_OTHER, { title: "Another open task the brief quotes", status: "open" as const, operatorOnly: false, needsFrontier: false, claimedByOperator: false }],
]);

/** One emitted spec with everything filled in. */
function spec(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    title: id.toUpperCase(),
    task: `Do ${id}`,
    folder: "repo",
    ...over,
  };
}

/** Unwrap an emission expected to be accepted. */
function emitted(raw: unknown, over: Partial<EmissionLimits> = {}) {
  const res = planEmission(raw, limits(over));
  assert.ok(res.ok, `expected ok, got: ${res.ok ? "" : res.reason}`);
  return res.specs;
}

/** The refusal for an emission expected to be rejected. */
function refused(raw: unknown, over: Partial<EmissionLimits> = {}): string {
  const res = planEmission(raw, limits(over));
  assert.ok(!res.ok, "expected a refusal");
  return res.reason;
}

/* ------------------------------------------------------------------ */
/* One node becomes one run                                            */
/* ------------------------------------------------------------------ */

/** A run block as `planNode` takes one, fully typed. */
const RUN_BLOCK: WorkflowNode = {
  id: "b1",
  name: "Fix the flake",
  kind: "run",
  templateId: "t1",
  mountId: "work",
  folder: "repo",
  task: "Fix the flaky auth test.",
  promptOverride: null,
  agentId: null,
  fanOut: null,
  mergeStrategy: null,
  mergeAutoResolve: false,
  maxPasses: null,
  maxLoopCostUSD: null,
  stopWhenTasks: null,
  bodyNodeIds: [],
  provider: null,
  fixRounds: null,
};

/** A template as `planNode` takes one, with every field it reads different. */
const BLOCK_TEMPLATE: RunTemplate = {
  id: "t1",
  name: "Careful",
  prompt: "Work carefully and commit as you go.",
  mountId: "elsewhere",
  folder: "not/this",
  isolate: true,
  permissionMode: "acceptEdits",
  agentId: null,
  model: "claude-sonnet-5",
  budget: {
    maxIterations: 4,
    maxDurationMinutes: 60,
    maxRunCostUSD: 5,
    maxRunCostFactor: null,
    maxRunTokens: null,
    maxWeeklyFraction: null,
    maxSessionFraction: null,
    enforcement: "between-cycles",
    continueAfterDone: false,
  },
  createdAt: 0,
  updatedAt: 0,
};

/** The untemplated set, different from the template's in every field. */
const BLOCK_DEFAULTS: RunGuards = {
  permissionMode: "plan",
  isolate: false,
  budget: {
    maxIterations: 1,
    maxDurationMinutes: 30,
    maxRunCostUSD: 2,
    maxRunCostFactor: null,
    maxRunTokens: null,
    maxWeeklyFraction: null,
    maxSessionFraction: null,
    enforcement: "live",
    continueAfterDone: false,
  },
};

/**
 * What a block inherits from the template it names, and what it does not.
 *
 * The model is the one worth a test rather than a comment, because its failure
 * is silent in the direction that costs money: a template that saved a model,
 * named by a block, quietly starting every one of that block's runs on
 * `settings.defaultModel` instead — the right task at a different price, with
 * nothing on the instance page saying so. The guards beside it are asserted in
 * the same case so a passing model assertion cannot be one read off the wrong
 * record.
 */
/**
 * A block's provider reaching its run, and the two things planNode settles for
 * one that is not Claude: a template's Claude model is never handed to it, and
 * guards with no work-cycle or time limit refuse it — the run form's rule — at
 * the moment the run would be created, since a template's guards are live.
 */
describe("planNode — a block that names a provider", () => {
  it("starts the run as the block's provider, without the template's Claude model", () => {
    for (const provider of ["codex", "local"] as const) {
      const plan = planNode({ ...RUN_BLOCK, provider }, BLOCK_TEMPLATE, BLOCK_DEFAULTS, null);
      assert.ok(plan.ok, provider);
      if (!plan.ok) continue;
      assert.equal(plan.input.provider, provider);
      assert.equal(plan.input.model, null, provider);
    }
    const ordinary = planNode(RUN_BLOCK, BLOCK_TEMPLATE, BLOCK_DEFAULTS, null);
    assert.equal(ordinary.ok && ordinary.input.provider, null);
  });

  it("refuses a Codex or local block whose guards would never end its run", () => {
    const endless = {
      ...BLOCK_TEMPLATE,
      budget: { ...BLOCK_TEMPLATE.budget, maxIterations: null, maxDurationMinutes: null },
    };
    const plan = planNode({ ...RUN_BLOCK, provider: "local" }, endless, BLOCK_DEFAULTS, null);
    assert.equal(plan.ok, false);
    assert.match(plan.ok ? "" : plan.reason, /needs a work-cycle limit or a time limit/);
    assert.equal(planNode(RUN_BLOCK, endless, BLOCK_DEFAULTS, null).ok, true);
  });
});

/**
 * The model decider's pick on an emitted run, and the one rung above it.
 *
 * Silent in money both ways: a decider pick that outranked the block's
 * template would replace the price the operator saved with one a classifier
 * chose, and a pick that reached a Codex or local run would hand a Claude id to
 * a CLI that does not serve it. The template is read when the run is created,
 * so one given a model after the emission was decided on must still win.
 */
describe("planEmittedRun — the decider's pick against the block's template", () => {
  const ORCHESTRATOR: WorkflowNode = { ...RUN_BLOCK, kind: "orchestrator", fanOut: 3 };
  const SPEC = {
    id: "s1",
    title: "Fix the flake",
    task: "Make the retry test deterministic.",
    folder: "",
    agent: null,
    taskIds: [],
    dependsOn: [],
    decidedModel: "claude-haiku-4-5",
  };

  it("runs on the decider's pick where the template names no model", () => {
    const input = planEmittedRun(ORCHESTRATOR, SPEC, { ...BLOCK_TEMPLATE, model: null }, BLOCK_DEFAULTS, null);
    assert.equal(input.model, "claude-haiku-4-5");
    assert.equal(planEmittedRun(ORCHESTRATOR, SPEC, null, BLOCK_DEFAULTS, null).model, "claude-haiku-4-5");
  });

  it("lets the template's model outrank the pick", () => {
    assert.equal(planEmittedRun(ORCHESTRATOR, SPEC, BLOCK_TEMPLATE, BLOCK_DEFAULTS, null).model, "claude-sonnet-5");
  });

  it("drops the pick for a Codex or local block", () => {
    for (const provider of ["codex", "local"] as const) {
      assert.equal(planEmittedRun({ ...ORCHESTRATOR, provider }, SPEC, null, BLOCK_DEFAULTS, null).model, null, provider);
    }
  });

  it("leaves the model to createRun when nothing decided one", () => {
    const { decidedModel: _, ...undecided } = SPEC;
    assert.equal(planEmittedRun(ORCHESTRATOR, undecided, null, BLOCK_DEFAULTS, null).model, null);
  });
});

describe("planNode — what a block takes from its template", () => {
  it("runs a block on its template's model", () => {
    const plan = planNode(RUN_BLOCK, BLOCK_TEMPLATE, BLOCK_DEFAULTS, null);
    assert.ok(plan.ok);
    assert.equal(plan.input.model, "claude-sonnet-5");
    // Beside the two it already inherited, so the model is reaching the run by
    // the same route rather than by a new one.
    assert.equal(plan.input.permissionMode, "acceptEdits");
    assert.ok(plan.input.prompt.startsWith("Work carefully and commit as you go."));
  });

  it("leaves the model to createRun when the template names none", () => {
    const plan = planNode(
      RUN_BLOCK,
      { ...BLOCK_TEMPLATE, model: null },
      BLOCK_DEFAULTS,
      null,
    );
    assert.ok(plan.ok);
    // Null rather than a default read here: `input.model ?? settings.defaultModel`
    // in `createRun` is the one place that fallback is applied.
    assert.equal(plan.input.model, null);
  });

  it("names no model for a block that names no template", () => {
    // `settings.chatDefaultGuards` is a guard set and holds no model, so a
    // block under the untemplated guards has nothing to inherit.
    const plan = planNode(
      { ...RUN_BLOCK, templateId: null },
      null,
      BLOCK_DEFAULTS,
      null,
    );
    assert.ok(plan.ok);
    assert.equal(plan.input.model, null);
    assert.equal(plan.input.permissionMode, "plan");
  });

  it("still takes the mount and folder off the node, not the template", () => {
    // The asymmetry the model does *not* join: a template edited months later
    // must not move a saved block's run to another repository.
    const plan = planNode(RUN_BLOCK, BLOCK_TEMPLATE, BLOCK_DEFAULTS, null);
    assert.ok(plan.ok);
    assert.equal(plan.input.mountId, "work");
    assert.equal(plan.input.folder, "repo");
  });
});

describe("planWorkflowProposal — a graph a model wrote becomes a saved workflow", () => {
  const proposal = (nodes: unknown[], edges: unknown[] = []) => ({
    title: "Nightly sweep",
    graph: JSON.stringify({ nodes, edges }),
  });

  it("takes the workflow's name from the title the operator approved", () => {
    const plan = planWorkflowProposal(proposal([node("a")]), KNOWN);
    assert.ok(plan.ok);
    assert.equal(plan.input.name, "Nightly sweep");
  });

  it("saves no instance budget, because a budget is not a thing a model may set", () => {
    // Not an oversight and not a default: there is no field on the tool, no
    // column on the row and no argument here that could carry one. A workflow
    // with no budget runs by hand and refuses to be scheduled, which is the
    // cost, and the card says so.
    const plan = planWorkflowProposal(proposal([node("a")]), KNOWN);
    assert.ok(plan.ok);
    assert.deepEqual(plan.input.instanceBudget, {
      maxInstanceCostUSD: null,
      maxSessionFraction: null,
      maxWeeklyFraction: null,
    });
  });

  it("refuses the same graphs the save route refuses, in the same words", () => {
    // The whole point of going through `normalizeWorkflowInput`: a second set
    // of rules about what a workflow may be would be confidently wrong about
    // what approval does the day one of them changed.
    const noCap = planWorkflowProposal(
      proposal([node("a", { kind: "orchestrator" })]),
      KNOWN,
    );
    assert.ok(!noCap.ok);
    assert.equal(
      noCap.reason,
      error(graph([node("a", { kind: "orchestrator" })])),
    );
  });

  it("refuses a template deleted since the proposal was written, rather than falling back", () => {
    const gone: WorkflowKnowledge = { ...KNOWN, templates: new Map() };
    const plan = planWorkflowProposal(proposal([node("a")]), gone);
    assert.ok(!plan.ok);
    assert.match(plan.reason, /names a template that no longer exists/);
  });

  it("refuses a proposal carrying no graph, or one that cannot be read", () => {
    const empty = planWorkflowProposal({ title: "x", graph: null }, KNOWN);
    assert.ok(!empty.ok);
    assert.match(empty.reason, /carries no workflow/);

    const broken = planWorkflowProposal({ title: "x", graph: "{oh dear" }, KNOWN);
    assert.ok(!broken.ok);
    assert.match(broken.reason, /could not be read/);
  });

  it("keeps the edges, so an approved graph runs in the order it was proposed in", () => {
    const plan = planWorkflowProposal(
      proposal([node("a"), node("b")], [edge("a", "b", { continueBranch: true })]),
      KNOWN,
    );
    assert.ok(plan.ok);
    assert.deepEqual(plan.input.graph.edges, [
      { from: "a", to: "b", edge: "on-success", continueBranch: true },
    ]);
  });

  it("keeps a block's agent, and takes no guard from it", () => {
    // The chat may name what the block's child is. It may not name what that
    // child is allowed to do — so the saved node carries the agent and every
    // guard beside it is still the template's id and nothing else.
    const plan = planWorkflowProposal(
      proposal([node("a", { agentId: "a-rev" })]),
      KNOWN,
    );
    assert.ok(plan.ok);
    assert.equal(plan.input.graph.nodes[0].agentId, "a-rev");
    assert.equal(plan.input.graph.nodes[0].templateId, "t-iso");
  });

  it("refuses an agent deleted since the proposal was written, by name", () => {
    // The template's rule one field over, and the same window: the model wrote
    // the card, the operator tidied the registry, then clicked. Falling back to
    // no agent would start the run the card described as the reviewer's
    // with nothing to say it had not been.
    const gone: WorkflowKnowledge = { ...KNOWN, agents: new Map() };
    const plan = planWorkflowProposal(
      proposal([node("a", { agentId: "a-rev" })]),
      gone,
    );
    assert.ok(!plan.ok);
    assert.match(plan.reason, /no longer exists/);
  });

  it("refuses an agent the CLI would drop, and one named on a merge block", () => {
    // Both are the same failure arriving from different directions: a block
    // whose agent the CLI will not register, and a block with no child for
    // an agent to be at all.
    const decayed = planWorkflowProposal(
      proposal([node("a", { agentId: "a-broken" })]),
      KNOWN,
    );
    assert.ok(!decayed.ok);
    assert.match(decayed.reason, /Half a thing/);

    const onMerge = planWorkflowProposal(
      proposal([node("a"), merger("m", { agentId: "a-rev" })], [edge("a", "m")]),
      KNOWN,
    );
    assert.ok(!onMerge.ok);
    assert.match(onMerge.reason, /starts no agent/);
  });
});

describe("summarizeProposedGraph — what the approval card has to show", () => {
  const untemplated = "acceptEdits · own checkout · 1 cycle";

  it("names the template each block's guards come from", () => {
    const [a] = summarizeProposedGraph(
      value(graph([node("a")])).graph,
      KNOWN,
      untemplated,
    );
    assert.equal(a.guardsLabel, "Isolated");
  });

  it("spells the untemplated guard set out, since there is nothing to go and read", () => {
    const [a] = summarizeProposedGraph(
      value(graph([node("a", { templateId: null })])).graph,
      KNOWN,
      untemplated,
    );
    assert.equal(a.guardsLabel, untemplated);
  });

  it("carries the fan-out cap, which is the number the operator is agreeing to", () => {
    // The one figure on the card that bounds agents nobody approves
    // individually. Absent, the decision moves to a canvas that may never be
    // opened.
    const [d] = summarizeProposedGraph(
      value(graph([decider("d", { fanOut: 4 })])).graph,
      KNOWN,
      untemplated,
    );
    assert.equal(d.fanOut, 4);
  });

  it("says a merge block may pay to reconcile, and names no folder for it", () => {
    const summary = summarizeProposedGraph(
      value(
        graph(
          [node("a"), merger("m", { mergeAutoResolve: true })],
          [edge("a", "m")],
        ),
      ).graph,
      KNOWN,
      untemplated,
    );
    const m = summary.find((b) => b.kind === "merge")!;
    assert.equal(m.mergeAutoResolve, true);
    assert.equal(m.folderLabel, null);
    assert.deepEqual(m.after, ["A"]);
  });

  it("reports a template deleted since, the same fact approval will refuse on", () => {
    const [a] = summarizeProposedGraph(
      value(graph([node("a")])).graph,
      { ...KNOWN, templates: new Map() },
      untemplated,
    );
    assert.equal(a.guardsLabel, "template deleted");
  });

  it("names the agent a block's child is started as, apart from its guards", () => {
    // Two fields rather than one string, because an agent bounds nothing: read
    // inside the guard clause it would claim to narrow what the block may do,
    // which is the one thing about an agent that is not true.
    const [a] = summarizeProposedGraph(
      value(graph([node("a", { agentId: "a-rev" })])).graph,
      KNOWN,
      untemplated,
    );
    assert.equal(a.agentLabel, "Reviewer");
    assert.equal(a.guardsLabel, "Isolated");
  });

  it("says nothing about an agent where none was named", () => {
    const [a] = summarizeProposedGraph(
      value(graph([node("a")])).graph,
      KNOWN,
      untemplated,
    );
    assert.equal(a.agentLabel, null);
  });

  it("reports an agent deleted since, the same fact approval will refuse on", () => {
    const [a] = summarizeProposedGraph(
      value(graph([node("a", { agentId: "a-rev" })])).graph,
      { ...KNOWN, agents: new Map() },
      untemplated,
    );
    assert.equal(a.agentLabel, "agent deleted");
  });
});

describe("planEmission — which specs become runs", () => {
  it("accepts a plain list and keeps every field the spec may set", () => {
    const specs = emitted([spec("a"), spec("b", { folder: "repo/api" })]);
    assert.deepEqual(
      specs.map((s) => [s.id, s.title, s.task, s.folder]),
      [
        ["a", "A", "Do a", "repo"],
        ["b", "B", "Do b", "repo/api"],
      ],
    );
    // And nothing else. A spec that could carry a guard would be a route to
    // --permission-mode reached by a model with nobody reading the result.
    // `agent` is on this list and is not one of those: a saved agent holds no
    // tool list and no permission mode, so naming one decides who does a piece
    // of the work exactly as the task text decides what the work is.
    // `taskIds` is further from that line again: it decides nothing about the
    // run's guards, folder or identity — it records what prompted the work, and
    // the board keeps deciding its own status.
    assert.deepEqual(Object.keys(specs[0]).sort(), [
      "agent",
      "dependsOn",
      "folder",
      "id",
      "task",
      "taskIds",
      "title",
    ]);
    assert.equal(specs[0].agent, null, "a spec that names none carries none");
    assert.deepEqual(specs[0].taskIds, [], "a spec that names none carries none");
  });

  it("refuses a task id that is not on the board, and takes every one that is", () => {
    // `agentRefusal`'s rule reached from the door where nobody is looking. The
    // failure it closes is the quiet one: a run emitted "for the flaky-auth
    // task" that silently carried no task is afterwards indistinguishable from
    // one that named none, and the operator reads a board row nothing was ever
    // started for.
    const named = emitted([spec("a", { taskIds: [TASK_KNOWN, TASK_OTHER] })]);
    assert.deepEqual(named[0].taskIds, [TASK_KNOWN, TASK_OTHER]);

    const refused = planEmission([spec("a", { taskIds: [TASK_GONE] })], limits());
    assert.equal(refused.ok, false);
    // The whole emission, not the one spec — `planEmission`'s all-or-nothing
    // rule: a partial list is a workflow that did some of what it decided.
    assert.match(refused.ok ? "" : refused.reason, new RegExp(TASK_GONE));
    assert.match(refused.ok ? "" : refused.reason, /No task with id/);
  });

  it("refuses an id cut to its first eight characters for its shape, not as missing", () => {
    // The mistake the briefs make: a task copied out of a brief that abbreviated
    // it. Looked up as written it is on no row, and "not on the board" would
    // send the block's model to re-read a list whose ids were never the problem.
    for (const field of ["taskIds", "relatedTaskIds"]) {
      const refused = planEmission(
        [spec("a", { [field]: [TASK_KNOWN.slice(0, 8)] })],
        limits(),
      );
      assert.equal(refused.ok, false, field);
      const reason = refused.ok ? "" : refused.reason;
      assert.match(reason, new RegExp(`${field}: "${TASK_KNOWN.slice(0, 8)}" is 8 characters`));
      assert.match(reason, /list_tasks/, "a block has list_tasks");
      assert.doesNotMatch(reason, /No task with id/, `${field}: no lookup was made`);
    }
  });

  it("refuses a spec whose text names a task it does not link, saying which spec", () => {
    // The bundling failure: the run does the work for both, can close only the
    // one it was linked to, and the other stays open with nothing saying why.
    const bundled = spec("b", {
      title: "Two fixes",
      task: "Fix “The known task on the board” and “Another open task the brief quotes”.",
      taskIds: [TASK_KNOWN],
    });
    const refused = planEmission([spec("a"), bundled], limits());
    assert.equal(refused.ok, false);
    const reason = refused.ok ? "" : refused.reason;
    assert.match(reason, /^“Two fixes”:/);
    assert.match(reason, new RegExp(TASK_OTHER));

    assert.deepEqual(
      emitted([{ ...bundled, taskIds: [TASK_KNOWN, TASK_OTHER] }])[0].taskIds,
      [TASK_KNOWN, TASK_OTHER],
    );
  });

  it("takes the mount root as a real answer", () => {
    // `""` is the workspace root on a node and on a template, so it is one
    // here too: collapsing it into "no folder named" would silently promote a
    // deliberate choice into something else.
    assert.equal(emitted([spec("a", { folder: "" })])[0].folder, "");
  });

  it("accepts an empty emission", () => {
    // "There is nothing worth doing" is an answer, and the alternative is a
    // block that has to invent work in order to say so.
    assert.deepEqual(emitted([]), []);
  });

  it("refuses one more than the cap, naming both numbers", () => {
    // The cap is the whole of what the operator agreed to when they saved the
    // graph, and it is the one refusal the model can act on by emitting fewer —
    // so it says how many it may have and how many it asked for.
    const reason = refused([spec("a"), spec("b"), spec("c"), spec("d")]);
    assert.match(reason, /at most 3 run\(s\)/);
    assert.match(reason, /asks for 4/);
    assert.match(reason, /cannot be raised from here/);
  });

  it("accepts exactly the cap", () => {
    // Off by one in the other direction is a block that can never use its last
    // slot, which is a quiet, permanent underuse nothing would report.
    assert.equal(emitted([spec("a"), spec("b"), spec("c")]).length, 3);
  });

  it("refuses a folder the mount check rejects, naming the run", () => {
    // Containment is decided per mount by `resolveInMount`, twice. What this
    // pins is that the refusal reaches the model as a sentence it can act on
    // rather than as a run started somewhere nobody pointed it at.
    const reason = refused([spec("a", { folder: "../elsewhere" })]);
    assert.match(reason, /“A” names a folder that cannot be used/);
    assert.match(reason, /outside the workspace/);
    assert.match(reason, /use a folder exactly as list_folders gives it/i);
  });

  it("refuses the whole emission when one spec's folder is refused", () => {
    // Not "start the three that are fine": the block decided on a set, and
    // silently dropping one leaves it reporting work that is not happening.
    assert.match(
      refused([spec("a"), spec("b", { folder: "../out" }), spec("c")]),
      /“B” names a folder that cannot be used/,
    );
  });

  it("refuses a spec with no title or no task", () => {
    assert.match(refused([spec("a", { title: "  " })]), /needs a title/);
    assert.match(refused([spec("a", { task: "" })]), /has no task/);
  });

  it("refuses two specs sharing an id", () => {
    assert.match(
      refused([spec("a"), spec("a")]),
      /Two runs share the id “a”/,
    );
  });

  it("refuses anything that is not a list", () => {
    assert.match(refused(undefined), /has to be a list/);
    assert.match(refused({ a: 1 }), /has to be a list/);
  });

  it("orders the specs so each is created after what it waits for", () => {
    // The property `startWorkflow` needs of a graph, for the same reason:
    // `createRun` names the runs a spec depends on, so one created too early
    // would name a run that does not exist yet.
    const specs = emitted([
      spec("c", { dependsOn: [{ id: "b", edge: "on-success" }] }),
      spec("b", { dependsOn: [{ id: "a", edge: "on-finish" }] }),
      spec("a"),
    ]);
    assert.deepEqual(
      specs.map((s) => s.id),
      ["a", "b", "c"],
    );
    assert.deepEqual(specs[1].dependsOn, [{ id: "a", edge: "on-finish" }]);
  });

  it("names the loop rather than leaving createRun to refuse a missing run", () => {
    // This is where "acyclic by construction" stops being the argument. Each
    // insert still mints its id after reading its edges, but the graph being
    // inserted is one a model wrote — and a cyclic set has no creation order at
    // all, so the first spec would be refused for naming a run that does not
    // exist rather than for the loop it is part of.
    const reason = refused([
      spec("a", { dependsOn: [{ id: "b", edge: "on-success" }] }),
      spec("b", { dependsOn: [{ id: "a", edge: "on-success" }] }),
    ]);
    assert.match(reason, /wait for each other in a loop/);
    assert.match(reason, /A|B/);
  });

  it("refuses a dependency on anything outside this emission", () => {
    // A block orders the runs it is emitting against each other and nothing
    // else. An edge onto a run it did not create is an edge into a graph it
    // cannot see, and it is how a block would reach work another block owns.
    assert.match(
      refused([spec("a", { dependsOn: [{ id: "r-other", edge: "on-success" }] })]),
      /not one of the runs being emitted/,
    );
  });

  it("refuses a dependency with no condition", () => {
    // Required rather than defaulted, the treatment every other edge in this
    // app gets: `on-success` terminates work the operator meant to run
    // regardless, `on-finish` starts a run on top of one that crashed.
    assert.match(
      refused([spec("b", { dependsOn: [{ id: "a" }] }), spec("a")]),
      /needs a condition for starting after/,
    );
  });

  it("refuses a self-dependency", () => {
    assert.match(
      refused([spec("a", { dependsOn: [{ id: "a", edge: "on-finish" }] })]),
      /start after itself|loop/,
    );
  });

  it("refuses a dependsOn that is not a list rather than starting the run at once", () => {
    // The list sent as a JSON string is the shape a model's array arguments
    // arrive in, and read as "no dependency" it was a run started at once on
    // top of the one it was told to wait for, with nobody reading the emission.
    const asString = JSON.stringify([{ id: "a", edge: "on-success" }]);
    for (const dependsOn of [asString, { id: "a", edge: "on-success" }]) {
      assert.match(
        refused([spec("a"), spec("b", { dependsOn })]),
        /“B” has a dependsOn that is not a list/,
      );
    }
    // Absent still means none.
    assert.deepEqual(
      emitted([spec("a", { dependsOn: null }), spec("b")]).map((s) => s.dependsOn),
      [[], []],
    );
  });

  it("refuses a dependsOn entry whose id or edge is not a string rather than reading what is inside it", () => {
    // `["a"]` read through `String()` is `a` and `["on-finish"]` is `on-finish`:
    // a run told to wait on something other than what the turn wrote, by a
    // condition other than the one it wrote, with nobody reading the emission.
    for (const [link, field] of [
      [{ id: ["a"], edge: "on-success" }, "id"],
      [{ id: { name: "a" }, edge: "on-success" }, "id"],
      [{ id: "a", edge: ["on-finish"] }, "edge"],
      [{ id: "a", edge: 1 }, "edge"],
    ] as const) {
      assert.match(
        refused([spec("a"), spec("b", { dependsOn: [link] })]),
        new RegExp(`^“B” dependsOn entry 1: "${field}" has to be a string`),
        JSON.stringify(link),
      );
    }
    // Absent and null are still what they were: a missing condition is refused
    // for that, not for its type.
    assert.match(
      refused([spec("a"), spec("b", { dependsOn: [{ id: "a", edge: null }] })]),
      /needs a condition for starting after/,
    );
  });

  /* ---------------------------------------------------------------- */
  /* …and who each of them is started as                              */
  /* ---------------------------------------------------------------- */

  it("accepts an agent the registry has, in the registry's own spelling", () => {
    // The name is the key of the object `--agents` takes and the string a
    // transcript attributes a delegated turn to, so what reaches the run is
    // what the operator saved rather than the turn's approximation of it.
    assert.equal(emitted([spec("a", { agent: "reviewer" })])[0].agent, "Reviewer");
  });

  it("refuses an agent this install does not have, by the name it asked for", () => {
    // Refused rather than dropped, beside the cap and the loop and for the same
    // reason: there is no person between this answer and the spawn, and a run
    // emitted "as the reviewer" that starts without one cannot be told
    // afterwards from a run that named none.
    const reason = refused([spec("a", { agent: "Auditor" })]);
    assert.match(reason, /“A”/);
    assert.match(reason, /does not have/);
    assert.match(reason, /Auditor/);
  });

  it("refuses one the CLI would drop, rather than emitting a run without it", () => {
    const reason = refused([spec("a", { agent: "Half a thing" })]);
    assert.match(reason, /missing its description or its prompt/);
  });

  it("takes no agent as the ordinary run", () => {
    assert.equal(emitted([spec("a")])[0].agent, null);
    assert.equal(emitted([spec("a", { agent: "" })])[0].agent, null);
  });

  /* ---------------------------------------------------------------- */
  /* …and where those runs may work                                    */
  /* ---------------------------------------------------------------- */

  /**
   * The bound the block's own prompt promises, which for a while nothing
   * enforced: the folder check read the *mount* and never `node.folder`, so a
   * block saved on `projectA` could emit a run in `projectB` — or in `""`, the
   * mount root, which `conflictKey`/`overlaps` treats as containing every other
   * folder and so blocks every other run in the tree. Silent in the worst way
   * available here: an unattended, file-writing agent in a repository nobody
   * pointed it at, started from a graph that names one folder and a prompt that
   * says so in words.
   *
   * `resolve` is injected, so this needs no filesystem — the same reason
   * `EmissionLimits.folderRefusal` is a function rather than a call.
   */
  const MOUNT = "/w";
  /** Folders the mount does not have, for the two "not there" cases. */
  const MISSING = new Set(["gone", "vanished"]);
  /** A symlink inside the block's folder pointing at a sibling's insides. */
  const LINKS: Record<string, string> = { "projectA/vendor": "/w/projectB/src" };

  /** Stands in for `resolveWorkspaceFolder` against the block's own mount. */
  function resolveInFakeMount(folder: string): string {
    const abs = path.posix.resolve(MOUNT, folder);
    if (abs !== MOUNT && !abs.startsWith(`${MOUNT}/`)) {
      throw new Error(`Folder is outside the "work" mount: ${folder}`);
    }
    const rel = path.posix.relative(MOUNT, abs);
    if (MISSING.has(rel)) {
      throw new Error(`No such folder in the "work" mount: ${folder}`);
    }
    // Resolved, as `resolveInMount` returns it: a link inside the block's
    // folder that points at a sibling reads as the sibling.
    return LINKS[rel] ?? abs;
  }

  /** The whole folder check one block would supply, with the syscall stubbed. */
  const bounded = (blockFolder: string): Partial<EmissionLimits> => ({
    folderRefusal: (folder) =>
      emittedFolderRefusal(blockFolder, folder, resolveInFakeMount),
  });

  it("refuses a sibling of the block's own folder, naming that folder", () => {
    // The regression. Accepted before the block's folder was checked at all,
    // and what it starts is an agent writing files in another repository.
    const reason = refused([spec("a", { folder: "projectB" })], bounded("projectA"));
    assert.match(reason, /“A” names a folder that cannot be used/);
    assert.match(reason, /outside “projectA”/);
    assert.match(reason, /projectB/);
  });

  it("accepts the block's own folder and anything under it", () => {
    const specs = emitted(
      [spec("a", { folder: "projectA" }), spec("b", { folder: "projectA/api" })],
      bounded("projectA"),
    );
    assert.deepEqual(
      specs.map((s) => s.folder),
      ["projectA", "projectA/api"],
    );
  });

  it("refuses the mount root from a block that is not on it", () => {
    // `""` is a real answer on a node and stays one here — but it is the one
    // folder that overlaps every other, so a block held to `projectA` reaching
    // for it is the escape that costs the most.
    const reason = refused([spec("a", { folder: "" })], bounded("projectA"));
    assert.match(reason, /outside “projectA”/);
  });

  it("refuses a folder that only lexically looks inside the block's", () => {
    // Two ways to read as inside and not be: climbing back out, and a symlink
    // the mount check resolves. Containment is decided on the resolved path
    // for the second one, which is why the first is not the whole test.
    assert.match(
      refused([spec("a", { folder: "projectA/../projectB" })], bounded("projectA")),
      /outside “projectA”/,
    );
    assert.match(
      refused([spec("a", { folder: "projectA/vendor" })], bounded("projectA")),
      /outside “projectA”/,
    );
  });

  it("takes the whole mount as the bound when the block sits on the root", () => {
    // What that block's own prompt says, so it is what it gets: `folder: ""`
    // names no narrower bound, and refusing a sibling there would be refusing
    // the block the operator saved.
    const specs = emitted(
      [spec("a", { folder: "projectB" }), spec("b", { folder: "" })],
      bounded(""),
    );
    assert.deepEqual(
      specs.map((s) => s.folder),
      ["projectB", ""],
    );
  });

  it("passes the mount refusal through, from either block", () => {
    // The containment guarantee is unchanged and still first: a folder outside
    // the mount is refused in the same words whatever the block's own folder.
    assert.match(
      refused([spec("a", { folder: "../elsewhere" })], bounded("projectA")),
      /outside the "work" mount/,
    );
    assert.match(
      refused([spec("a", { folder: "gone" })], bounded("")),
      /No such folder in the "work" mount/,
    );
  });

  it("refuses everything when the block's own folder has gone", () => {
    // Nothing can be shown to be inside a folder that is not there, and the
    // turn still runs — `safeFolder` lets it — so this is reachable. Refusing
    // is the direction that cannot start an agent somewhere unintended.
    const reason = refused([spec("a", { folder: "projectA" })], bounded("vanished"));
    assert.match(reason, /“vanished”/);
    assert.match(reason, /cannot be found any more/);
  });
});

/* ------------------------------------------------------------------ */
/* What a finished turn leaves behind                                  */
/* ------------------------------------------------------------------ */

/**
 * The evidence a deciding block leaves, which is the only thing standing
 * between the operator and a graph that ended for no visible reason.
 *
 * Every failure here is silent and each one costs the same thing: an
 * orchestrator block that starts nothing stops every block behind it, so a row
 * saying `emitted`, zero runs and nothing else is a whole workflow that ran,
 * billed, and ended with no account of why. Three different endings arrive at
 * that row — the turn said there was nothing worth doing, this app refused the
 * runs it asked for, or the turn failed — and telling them apart is the whole
 * job of the three fields this returns. Dropping the reply, folding a refusal
 * into the failure, or recording `failed` on a turn whose runs are about to
 * start all typecheck and all look identical on the page.
 */
describe("blockSettlement — what a finished turn is recorded as", () => {
  const settled = (result: TurnResult, emitted = 0, notes: string[] = []) =>
    blockSettlement(result, emitted, notes);

  it("keeps the turn's reply, which is its account of what it did not start", () => {
    const out = settled({ status: "idle", text: "Nothing to do: the tests pass." });
    assert.equal(out.status, "emitted");
    assert.equal(out.reply, "Nothing to do: the tests pass.");
    assert.equal(out.error, null);
  });

  it("has no reply for a turn that said nothing", () => {
    // Null rather than "", so the page can leave the panel out entirely instead
    // of drawing an empty one that reads as an answer.
    assert.equal(settled({ status: "idle", text: "   " }).reply, null);
    assert.equal(settled({ status: "idle" }).reply, null);
  });

  it("records a failed turn as failed, with the failure and no reply", () => {
    // `parseTurnOutput` puts the text in `error` when the turn failed, so a
    // reply here would be the same sentence twice under two different headings.
    const out = settled({ status: "failed", error: "The CLI exited 1." });
    assert.equal(out.status, "failed");
    assert.equal(out.error, "The CLI exited 1.");
    assert.equal(out.reply, null);
  });

  it("does not record a failed turn that emitted as failed", () => {
    // The specs were accepted while the child was alive and are about to become
    // runs. `failed` blocks every node behind this one, which would strand the
    // very runs this turn started.
    const out = settled({ status: "failed", error: "It exited 1 afterwards." }, 2);
    assert.equal(out.status, "emitted");
    assert.equal(out.error, "It exited 1 afterwards.", "the failure is still recorded");
  });

  it("carries forward what was recorded while the turn was running", () => {
    // The refusals and the unreadable guard are written to the row as they
    // happen, and this write used to replace them with the turn's own error —
    // which is null on a turn that succeeded, so they vanished.
    const out = settled({ status: "idle", text: "I gave up." }, 0, [
      "It tried to emit runs and was refused: over the cap",
    ]);
    assert.deepEqual(out.notes, ["It tried to emit runs and was refused: over the cap"]);
    assert.equal(out.reply, "I gave up.");
  });

  it("records tool calls the CLI declined, deduplicated", () => {
    // "I was not allowed to look" reads exactly like "there was nothing to
    // find" on a block that emitted nothing, and only one is worth acting on.
    const out = settled({ status: "idle", denials: ["Bash", "Bash", "WebFetch"] });
    assert.equal(out.notes.length, 1);
    assert.match(out.notes[0], /Bash, WebFetch/);
  });

  it("has no notes when nothing happened worth recording", () => {
    // Empty rather than a reassuring line: the page draws every note, and a
    // standing "no problems" would train the eye past the ones that matter.
    assert.deepEqual(settled({ status: "idle", text: "Started one." }, 1).notes, []);
  });
});

/**
 * Which of a settled turn's three cost columns each reading goes in.
 *
 * The failure this pins was silent in three places at once. `turnResultOf`
 * returns a failure shape with no `costUSD` whenever the child produced no
 * readable `result` event — killed, crashed or timed out — and it carries the
 * tokens precisely because they were billed. Banking that as `costUSD ?? 0`
 * put a measurement nobody made in the column `instanceSpend` sums into both
 * the shown figure and the guard's: the block's Spent cell read `$0.00`, the
 * instance total omitted the whole of every crashed turn, and
 * `enforceInstanceBudget` compared `maxInstanceCostUSD` against a number short
 * by exactly the money the operator set the cap to bound.
 *
 * Splitting it is the fix and the split is what has to hold: the measured
 * column may only ever take a figure a CLI reported, the estimate must reach
 * the guard, and a turn that reported nothing must stay distinguishable from
 * one that cost nothing even when both estimates are 0.
 */
describe("blockTurnSpend — a turn's cost, measured apart from estimated", () => {
  it("banks a reported cost as measured, with nothing to estimate", () => {
    assert.deepEqual(blockTurnSpend({ status: "idle", costUSD: 1.5, tokens: 10 }), {
      costUSD: 1.5,
      costGuardUSD: 0,
      unreported: 0,
    });
  });

  it("banks a reported $0 as a measurement, because it is one", () => {
    // A turn the CLI priced at zero is a reading, not a gap. It must not be
    // mistaken for the killed turn below or the row would claim an estimate it
    // has no usage for.
    assert.deepEqual(blockTurnSpend({ status: "idle", costUSD: 0 }), {
      costUSD: 0,
      costGuardUSD: 0,
      unreported: 0,
    });
  });

  it("keeps a killed turn's tokens out of the measured column and in the guard's", () => {
    // The shape `turnResultOf` returns when no `result` event ever arrived: an
    // error, the tokens the stream did report, our own price for them, and no
    // `costUSD` at all.
    const killed = blockTurnSpend({
      status: "failed",
      error: "The chat produced no readable output (exit null).",
      tokens: 120_000,
      costGuardUSD: 0.42,
    });
    assert.equal(killed.costUSD, 0, "nothing measured this turn");
    assert.equal(killed.costGuardUSD, 0.42, "the guard prices what it streamed");
    assert.equal(killed.unreported, 1);
    assert.ok(
      killed.costUSD + killed.costGuardUSD > killed.costUSD,
      "the guard's total exceeds the measured floor",
    );
  });

  it("still records a turn that died before its first token as unreported", () => {
    // Both figures are 0 and neither is a reading. Without the count the row is
    // bit-for-bit a block that ran and cost nothing, which is the whole reason
    // `cost_unreported` is a column rather than a test for a zero.
    const dead = blockTurnSpend({ status: "failed", error: "exit 137", tokens: 0 });
    assert.equal(dead.costUSD, 0);
    assert.equal(dead.costGuardUSD, 0);
    assert.equal(dead.unreported, 1, "the cost is unknown, not zero");
  });
});

/**
 * The other half of the same defect: where those three columns land once they
 * are summed, and what the cell above them is allowed to say.
 *
 * `addBlockSpend` is the line `enforceInstanceBudget` acts on. An estimate that
 * failed to reach `spentGuardUSD` leaves the cap short by every crashed turn;
 * one that reached `spentUSD` as well would put our own price in the figure the
 * page calls measured, which is the failure the whole shown-versus-guard split
 * exists to prevent. Both typecheck and neither shows on the page.
 */
describe("addBlockSpend — which figure a block's columns may reach", () => {
  const noMembers = { spentUSD: 0, spentGuardUSD: 0, subjects: 0, unmeasured: 0 };

  it("puts a killed turn's estimate in the guard's figure and not the shown one", () => {
    const spend = addBlockSpend(noMembers, {
      spent: 0,
      est: 0.42,
      unreported: 1,
      paying: 1,
    });
    assert.equal(spend.spentUSD, 0, "nothing measured, so nothing to show");
    assert.ok(
      spend.spentGuardUSD > spend.spentUSD,
      "the guard reads more than the measured floor",
    );
    assert.equal(spend.spentGuardUSD, 0.42);
    assert.equal(spend.unmeasured, 1);
  });

  it("puts a reported cost in both figures", () => {
    const spend = addBlockSpend(noMembers, {
      spent: 1.25,
      est: 0,
      unreported: 0,
      paying: 1,
    });
    assert.equal(spend.spentUSD, 1.25);
    assert.equal(spend.spentGuardUSD, 1.25);
    assert.equal(spend.unmeasured, 0);
  });

  it("adds to what the members already spent rather than replacing it", () => {
    const spend = addBlockSpend(
      { spentUSD: 2, spentGuardUSD: 3, subjects: 4, unmeasured: 1 },
      { spent: 1, est: 0.5, unreported: 2, paying: 3 },
    );
    assert.deepEqual(spend, {
      spentUSD: 3,
      spentGuardUSD: 4.5,
      subjects: 7,
      unmeasured: 3,
    });
  });
});

/**
 * The same rule on the other half of an instance: a member whose CLI reports no
 * cost at all.
 *
 * `codex exec` returns token counts and no money, so the run loop deliberately
 * withholds its `+=` and `runs.spent_usd` stays at 0 — a null in disguise, and
 * every other surface in this app already refuses to print it: the runs list
 * draws `—`, the run page says the provider does not report spend, the MCP
 * tools answer `null`. `sumMemberSpend` read the column raw, so an instance of
 * Codex members reported `$0.00` as a total it had measured, and the count is
 * the only thing that separates that from a graph which genuinely cost nothing.
 */
describe("sumMemberSpend — a member whose provider reports no cost", () => {
  const member = (
    provider: RunProviderDTO | null,
    spent: number,
    est = 0,
  ): MemberSpendRow => ({
    id: `run-${provider}-${spent}`,
    status: "completed",
    provider,
    spent,
    est,
    cycleStartedAt: null,
  });

  it("counts a Codex member as unmeasured rather than adding its zero", () => {
    const spend = sumMemberSpend([member("claude", 2), member("codex", 0)]);
    assert.equal(spend.spentUSD, 2, "only the member that reported is in the total");
    assert.equal(spend.spentGuardUSD, 2, "and the guard has nothing more to add");
    assert.equal(spend.unmeasured, 1, "the Codex member is flagged, not summed");
    assert.equal(spend.subjects, 2);
  });

  it("tells that apart from two members that genuinely cost nothing", () => {
    // The defect in one line: both instances used to return 2.00 with no way to
    // ask which of them had been measured.
    const spend = sumMemberSpend([member("claude", 2), member("claude", 0)]);
    assert.equal(spend.spentUSD, 2);
    assert.equal(spend.unmeasured, 0);
  });

  it("treats a row from before the column as the Claude run it must be", () => {
    const spend = sumMemberSpend([member(null, 1.5, 0.25)]);
    assert.equal(spend.spentUSD, 1.5);
    assert.equal(spend.spentGuardUSD, 1.75, "its estimate still reaches the guard");
    assert.equal(spend.unmeasured, 0);
  });
});

describe("memberSpendReading — what a member's Spent cell may claim", () => {
  it("has no figure for a provider that reports none", () => {
    assert.equal(memberSpendReading({ provider: "codex", spent_usd: 0 }), null);
  });

  it("keeps a measured zero from a provider that does", () => {
    assert.equal(memberSpendReading({ provider: "claude", spent_usd: 0 }), 0);
    assert.equal(memberSpendReading({ provider: null, spent_usd: 0 }), 0);
  });

  it("keeps a measured figure", () => {
    assert.equal(memberSpendReading({ provider: "claude", spent_usd: 2 }), 2);
  });
});

describe("blockSpendReading — what a block's Spent cell may claim", () => {
  it("has no figure for a block nothing measured", () => {
    // `$0.00` here is the claim the runs list already refuses to make: a turn
    // that died before reporting spent money, and the cell must say so by
    // saying nothing.
    assert.equal(blockSpendReading({ costUSD: 0, costUnknown: true }), null);
  });

  it("keeps a measured zero, which is an answer", () => {
    assert.equal(blockSpendReading({ costUSD: 0, costUnknown: false }), 0);
  });

  it("keeps what the block's other turns reported", () => {
    // A floor rather than the bill — `costUnknown` beside it is what says so —
    // but money that was measured is not thrown away to signal the gap.
    assert.equal(blockSpendReading({ costUSD: 1.5, costUnknown: true }), 1.5);
  });
});

/* ------------------------------------------------------------------ */
/* What the instance does next                                         */
/* ------------------------------------------------------------------ */

/** A run node's state: the run it became, as its row stands now. */
function ran(
  id: string,
  status: RunStatus,
  iterations = 1,
): InstanceNodeState {
  return { run: { id, status, iterations, refundedCycles: 0 }, block: null };
}

/** An orchestrator block's ledger row, with the runs it started. */
function decided(
  status: BlockStatus,
  emittedRuns: Array<[string, RunStatus, number?]> = [],
  error: string | null = null,
): InstanceNodeState {
  return {
    run: null,
    block: {
      status,
      emitted: emittedRuns.map(([id, s, i]) => ({
        id,
        status: s,
        iterations: i ?? 1,
        refundedCycles: 0,
      })),
      error,
    },
  };
}

/** A `WorkflowNode` with everything filled in, so a case states what it varies. */
function graphNode(
  id: string,
  name: string,
  extra: Partial<WorkflowNode> = {},
): WorkflowNode {
  return {
    id,
    name,
    kind: "run",
    templateId: null,
    mountId: "work",
    folder: "repo",
    task: name,
    promptOverride: null,
    agentId: null,
    fanOut: null,
    mergeStrategy: null,
    mergeAutoResolve: false,
    maxPasses: null,
    maxLoopCostUSD: null,
    stopWhenTasks: null,
    bodyNodeIds: [],
    provider: null,
    fixRounds: null,
    ...extra,
  };
}

/** A graph of one orchestrator block feeding one run block. */
const FAN: WorkflowGraph = {
  nodes: [
    graphNode("pick", "Pick the work", {
      kind: "orchestrator",
      task: "Decide",
      fanOut: 3,
    }),
    graphNode("review", "Review it", { task: "Review" }),
  ],
  edges: [edge("pick", "review", { edge: "on-finish" })],
};

function stepOf(state: Record<string, InstanceNodeState>, g = FAN) {
  return planInstanceStep(g, new Map(Object.entries(state)));
}

describe("planInstanceStep — what an instance may do next", () => {
  it("starts a block with nothing in front of it", () => {
    const step = stepOf({ pick: decided("waiting") });
    assert.deepEqual(step.spawn, ["pick"]);
    // And nothing behind it: the block has not decided, so there is nothing
    // for the run block to be created against.
    assert.deepEqual(step.create, []);
    assert.deepEqual(step.block, []);
  });

  it("leaves a block alone while its turn is in flight", () => {
    // The claim is a guarded UPDATE, but every terminal run transition in the
    // app triggers an advance — so a second pass that re-selected a thinking
    // block would be racing the claim on every one of them.
    assert.deepEqual(stepOf({ pick: decided("thinking") }).spawn, []);
  });

  it("holds the block behind it until every emitted run has settled", () => {
    // Not "until it emitted": the run block is there to follow the work, and
    // created while that work is still running it would start on a branch
    // nothing has been committed to yet.
    const step = stepOf({
      pick: decided("emitted", [
        ["r-1", "completed"],
        ["r-2", "running"],
      ]),
    });
    assert.deepEqual(step.create, []);
    assert.deepEqual(step.block, []);
  });

  it("creates the block behind it depending on every run that was emitted", () => {
    // The fan-in nobody could write down: the graph says "after Pick the work"
    // and what that resolves to is however many runs it turned out to emit.
    const step = stepOf({
      pick: decided("emitted", [
        ["r-1", "completed"],
        ["r-2", "failed"],
      ]),
    });
    assert.deepEqual(step.create, [
      {
        nodeId: "review",
        dependsOn: [
          { runId: "r-1", edge: "on-finish", continueBranch: false },
          { runId: "r-2", edge: "on-finish", continueBranch: false },
        ],
      },
    ]);
  });

  it("blocks what is behind an empty emission, naming the block", () => {
    // The decision this feature has to make explicitly. A block behind a
    // fan-out exists to review, land or follow up on what the fan-out
    // produced; started with nothing in front of it, it spends a billed cycle
    // discovering that. `edgeSatisfied`'s rule one level up: a dependency that
    // did no work satisfies nothing.
    const step = stepOf({ pick: decided("emitted", []) });
    assert.deepEqual(step.create, []);
    assert.equal(step.block.length, 1);
    assert.equal(step.block[0].nodeId, "review");
    assert.match(step.block[0].reason, /“Pick the work” decided there was nothing to start/);
  });

  it("blocks what is behind an emission none of which could be started, saying so", () => {
    // Still blocked — there is nothing to follow — but the model decided to
    // start work and this app failed to, and a sentence blaming its decision
    // sends the operator to read a reply that was right.
    const pick = decided("emitted", []);
    pick.block!.decided = 1;
    pick.block!.notes = [
      "“E3” could not be started: No such folder in the \"Scratch\" mount: project/sub",
    ];
    const step = stepOf({ pick });
    assert.equal(step.block.length, 1);
    assert.equal(step.block[0].nodeId, "review");
    assert.doesNotMatch(step.block[0].reason, /decided there was nothing/);
    assert.match(step.block[0].reason, /“Pick the work” decided on 1 run\(s\), but none of them could be started/);
    assert.match(step.block[0].reason, /“E3” could not be started: No such folder/);
  });

  it("blocks what is behind a turn that failed, carrying its reason", () => {
    const step = stepOf({
      pick: decided("failed", [], "This block produced nothing for 15 minutes and was stopped."),
    });
    assert.match(step.block[0].reason, /could not decide what to start/);
    assert.match(step.block[0].reason, /produced nothing for 15 minutes/);
  });

  it("blocks what is behind a run that ended without qualifying", () => {
    const step = stepOf({
      pick: decided("emitted", [
        ["r-1", "completed"],
        ["r-2", "failed"],
      ]),
    }, {
      ...FAN,
      edges: [edge("pick", "review", { edge: "on-success" })],
    });
    assert.deepEqual(step.create, []);
    assert.match(step.block[0].reason, /one of them ended failed/);
  });

  it("cascades a block's verdict to everything behind it, one sentence each", () => {
    // The fixed point is the cascade. Every run in the chain names the block in
    // front of *it* rather than one shared verdict about a block at the head it
    // never heard of — the rule `releasableRuns` already follows.
    const chain: WorkflowGraph = {
      ...FAN,
      nodes: [
        ...FAN.nodes,
        graphNode("land", "Land it", { task: "Land" }),
      ],
      edges: [...FAN.edges, edge("review", "land", { edge: "on-success" })],
    };
    const step = stepOf({ pick: decided("emitted", []) }, chain);
    assert.deepEqual(
      step.block.map((b) => b.nodeId),
      ["review", "land"],
    );
    assert.match(step.block[0].reason, /decided there was nothing to start/);
    assert.match(step.block[1].reason, /“Review it”, which never ran/);
  });

  it("creates a run block that is holding a waiting ledger row", () => {
    // Every node behind an orchestrator block gets one of those at
    // instantiation — it is what puts the block on the page as pending and what
    // makes the instance visible to the advance query at all. Read as "already
    // decided", the whole subgraph behind a fan-out would never be created and
    // nothing would say why.
    const step = stepOf({
      pick: decided("emitted", [["r-1", "completed"]]),
      review: decided("waiting"),
    });
    assert.deepEqual(step.create, [
      {
        nodeId: "review",
        dependsOn: [{ runId: "r-1", edge: "on-finish", continueBranch: false }],
      },
    ]);
  });

  it("waits for a run block that has not been created yet", () => {
    // A `waiting` ledger row on a *predecessor* is "behind a decision that has
    // not been made", not "never ran". Read as the second, a chain of two
    // blocks behind one fan-out would block itself at the first advance.
    const chain: WorkflowGraph = {
      ...FAN,
      nodes: [
        ...FAN.nodes,
        graphNode("land", "Land it", { task: "Land" }),
      ],
      edges: [...FAN.edges, edge("review", "land", { edge: "on-success" })],
    };
    const step = stepOf(
      {
        pick: decided("thinking"),
        review: decided("waiting"),
        land: decided("waiting"),
      },
      chain,
    );
    assert.deepEqual(step.create, []);
    assert.deepEqual(step.block, []);
  });

  it("never re-creates a node that is already a run", () => {
    // Both passes see the same graph, and this runs after every terminal run
    // transition in the app. A node selected twice is a second agent in the
    // same folder from one press of Run.
    const step = stepOf({
      pick: decided("emitted", [["r-1", "completed"]]),
      review: ran("r-review", "queued", 0),
    });
    assert.deepEqual(step.create, []);
    assert.deepEqual(step.block, []);
  });

  it("never re-decides a node that has already been written off", () => {
    const step = stepOf({
      pick: decided("emitted", []),
      review: decided("blocked", [], "Already written off."),
    });
    assert.deepEqual(step.block, []);
    assert.deepEqual(step.create, []);
  });

  it("waits for a run block in front of a block before deciding", () => {
    // An orchestrator block is there to decide *after* the earlier work
    // happened. Started before it, it decides against a repository in the state
    // the workflow began in, which is the one thing it exists not to do.
    const g: WorkflowGraph = {
      nodes: [graphNode("build", "Build"), FAN.nodes[0]],
      edges: [edge("build", "pick", { edge: "on-success" })],
    };
    assert.deepEqual(
      stepOf({ build: ran("r-build", "running", 0), pick: decided("waiting") }, g)
        .spawn,
      [],
    );
    assert.deepEqual(
      stepOf({ build: ran("r-build", "completed"), pick: decided("waiting") }, g)
        .spawn,
      ["pick"],
    );
    // And a dependency that can never satisfy it ends the block rather than
    // leaving it waiting on a row that is already terminal.
    const dead = stepOf(
      { build: ran("r-build", "failed"), pick: decided("waiting") },
      g,
    );
    assert.deepEqual(dead.spawn, []);
    assert.match(dead.block[0].reason, /“Build”, which ended failed/);
  });
});

/**
 * A review block between the work and the merge: it hands on the branches a
 * frontier review approved — the last link of each, which after a fix round is
 * the fix run — and nothing it set aside.
 *
 * Every case here is silent when wrong. A merge handed the run the review began
 * with, rather than the fix it approved, lands the rejected attempt. A merge
 * blocked behind a review that set everything aside stops a loop the operator
 * asked to carry on. A merge released behind a review that failed lands work
 * nobody judged.
 */
describe("planInstanceStep — a review block between the work and the merge", () => {
  const REVIEWED: WorkflowGraph = {
    nodes: [
      graphNode("build", "Build it"),
      graphNode("check", "Check it", { kind: "review", task: "", fixRounds: 1 }),
      graphNode("land", "Land it", {
        kind: "merge",
        task: "",
        mergeStrategy: "merge",
      }),
    ],
    edges: [
      edge("build", "check", { edge: "on-success" }),
      edge("check", "land", { edge: "on-success" }),
    ],
  };
  const step = (state: Record<string, InstanceNodeState>) => stepOf(state, REVIEWED);

  it("starts reviewing once the work in front of it has finished", () => {
    const s = step({ build: ran("r-1", "completed"), check: decided("waiting") });
    assert.deepEqual(s.review, [{ nodeId: "check", runIds: ["r-1"] }]);
    assert.deepEqual(s.merge, []);
  });

  it("holds the merge while the review is in flight", () => {
    const s = step({ build: ran("r-1", "completed"), check: decided("thinking") });
    assert.deepEqual(s.merge, []);
    assert.deepEqual(s.block, []);
  });

  it("lands what the review approved — the fix run, not the attempt it rejected", () => {
    const s = step({
      build: ran("r-1", "completed"),
      check: decided("emitted", [["r-fix", "completed"]]),
      land: decided("waiting"),
    });
    assert.deepEqual(s.merge, [{ nodeId: "land", runIds: ["r-fix"] }]);
  });

  it("hands on an approved branch whose last run asked for review", () => {
    const s = step({
      build: ran("r-1", "completed"),
      check: decided("emitted", [["r-1", "needs-review"]]),
      land: decided("waiting"),
    });
    assert.deepEqual(s.merge, [{ nodeId: "land", runIds: ["r-1"] }]);
  });

  it("lets the merge settle with nothing to land when every branch was set aside", () => {
    const s = step({
      build: ran("r-1", "completed"),
      check: decided("emitted", []),
      land: decided("waiting"),
    });
    assert.deepEqual(s.merge, [{ nodeId: "land", runIds: [] }]);
    assert.deepEqual(s.block, []);
  });

  it("blocks the merge behind a review that failed, on either condition", () => {
    const s = step({
      build: ran("r-1", "completed"),
      check: decided("failed", [], "The server restarted while this block was reviewing branches."),
      land: decided("waiting"),
    });
    assert.deepEqual(s.merge, []);
    assert.equal(s.block[0]?.nodeId, "land");
    assert.match(s.block[0]?.reason ?? "", /could not review what was in front of it/);
  });
});

/**
 * A run the operator left behind — `leaveRunBehind`.
 *
 * Silent in both directions, which is what earns these: a waiver the scheduler
 * ignores leaves the pick-up doing nothing and the workflow stuck exactly as it
 * was, and one it honours by *resolving through* the run lands the branch of the
 * run the operator chose not to land.
 */
describe("planInstanceStep — a run left behind", () => {
  const MERGE_AFTER: WorkflowGraph = {
    nodes: [
      graphNode("pick", "Pick the work", { kind: "orchestrator", fanOut: 3 }),
      graphNode("land", "Land it", { kind: "merge", mergeStrategy: "merge" }),
    ],
    edges: [edge("pick", "land", { edge: "on-success" })],
  };

  it("releases the merge behind it, without the branch it left behind", () => {
    const pick = decided("emitted", [["r-1", "completed"]]);
    pick.block!.leftBehind = 1;
    const step = stepOf({ pick, land: decided("waiting") }, MERGE_AFTER);
    assert.deepEqual(step.block, []);
    assert.deepEqual(step.merge, [{ nodeId: "land", runIds: ["r-1"] }]);
  });

  it("releases it with nothing to land when every run was left behind", () => {
    // Not "decided there was nothing to start": it did start work, and the
    // operator chose to carry on without all of it.
    const pick = decided("emitted", []);
    pick.block!.leftBehind = 2;
    const step = stepOf({ pick, land: decided("waiting") }, MERGE_AFTER);
    assert.deepEqual(step.block, []);
    assert.deepEqual(step.merge, [{ nodeId: "land", runIds: [] }]);
  });

  it("satisfies an on-success edge from a run block, resolving to no run", () => {
    const chain: WorkflowGraph = {
      nodes: [
        graphNode("build", "Build"),
        graphNode("land", "Land it", { kind: "merge", mergeStrategy: "merge" }),
      ],
      edges: [edge("build", "land", { edge: "on-success" })],
    };
    const build: InstanceNodeState = {
      run: { id: "r-b", status: "needs-review", iterations: 1, refundedCycles: 0 },
      block: null,
    };
    const stuck = stepOf({ build, land: decided("waiting") }, chain);
    assert.match(stuck.block[0].reason, /“Build”, which ended needs-review/);

    const waived = stepOf(
      { build: { ...build, leftBehind: true }, land: decided("waiting") },
      chain,
    );
    assert.deepEqual(waived.block, []);
    assert.deepEqual(waived.merge, [{ nodeId: "land", runIds: [] }]);
  });
});

/* ------------------------------------------------------------------ */
/* A “repeats” link is never a dependency                              */
/* ------------------------------------------------------------------ */

/**
 * The one reading that would undo the whole design, held here rather than left
 * to a comment.
 *
 * A `repeats` link points from a loop to a block the loop itself creates, once
 * per pass. Read as a dependency it is a back edge: `planInstanceStep` would
 * hold the loop `waiting` for a run only the loop can make, `releasableRuns`
 * would reach a fixed point with it still waiting, and the instance would never
 * finish — with nothing on the page saying why. Nothing typechecks that away,
 * because the field it sits in is the same field a dependency uses.
 *
 * And the same graph stated the old way — a list on the loop and no link —
 * has to plan identically, which is what makes every workflow saved before this
 * go on doing exactly what it did.
 */
describe("planInstanceStep — the link that says what a loop repeats", () => {
  const loopNode = (bodyNodeIds: string[]) =>
    graphNode("l", "Nightly", { kind: "loop", maxPasses: 3, bodyNodeIds });

  /** The section drawn: a “repeats” link in, a chain along, a link out. */
  const DRAWN: WorkflowGraph = {
    nodes: [
      loopNode(["a", "b"]),
      graphNode("a", "A"),
      graphNode("b", "B"),
      graphNode("z", "Z"),
    ],
    edges: [
      edge("l", "a", { edge: "repeats" }),
      edge("a", "b", { edge: "on-success", continueBranch: true }),
      edge("l", "z", { edge: "on-success" }),
    ],
  };

  it("starts the loop with nothing in front of it, link and all", () => {
    const step = stepOf(
      { l: decided("waiting"), z: decided("waiting") },
      DRAWN,
    );
    assert.deepEqual(
      step.loop.map((l) => l.nodeId),
      ["l"],
      "the loop waits for nothing: the link out of it is not one",
    );
    assert.deepEqual(
      step.loop[0].dependsOn,
      [],
      "and the section is not a run it depends on",
    );
    assert.deepEqual(step.create, [], "a member is never created here");
    assert.deepEqual(step.block, [], "and never blocked either");
  });

  it("plans a section stated as a list exactly as one stated as a link", () => {
    const asList: WorkflowGraph = {
      nodes: DRAWN.nodes,
      edges: DRAWN.edges.filter((e) => e.edge !== "repeats"),
    };
    const state = { l: decided("waiting"), z: decided("waiting") };
    assert.deepEqual(stepOf(state, DRAWN), stepOf(state, asList));
  });

  it("releases what is behind the loop off the loop's own link", () => {
    // The other half of "the loop block is the way out": Z waits for the loop
    // and not for a member, which is a run it has never heard of.
    const step = stepOf(
      {
        l: decided("emitted", [
          ["r-pass-1", "completed"],
          ["r-pass-2", "completed"],
        ]),
        z: decided("waiting"),
      },
      DRAWN,
    );
    assert.deepEqual(
      step.create.map((c) => c.nodeId),
      ["z"],
    );
    // **No run at all**, exactly as a successor of a merge block gets. Every
    // pass landed its own work through the section's own exit, so by the time
    // the loop hands on there is no branch of its own left and nothing for Z to
    // be put behind: it is an ordinary queued run, started after the landing.
    // Handed the last pass's run instead, Z would carry on a ref that pass had
    // already landed and may since have deleted.
    assert.deepEqual(step.create[0].dependsOn, []);
  });

  it("holds what is behind it back while a pass is still running", () => {
    // `looping` is pending rather than settled, and that is what stops a
    // successor being created between two passes: the block can still commit a
    // whole further pass to the folders behind it.
    const step = stepOf(
      { l: decided("looping"), z: decided("waiting") },
      DRAWN,
    );
    assert.deepEqual(step.create, []);
    assert.deepEqual(step.block, []);
  });

  it("starts an on-finish successor after a loop that stopped on a bad pass", () => {
    // "Clean up after it however it went" and "only once every pass landed"
    // are both things a person writes, and the condition on the edge decides —
    // `edgeVerdict`'s own reading of a merge block one kind along.
    const cleanup: WorkflowGraph = {
      ...DRAWN,
      edges: [
        ...DRAWN.edges.filter((e) => e.to !== "z"),
        edge("l", "z", { edge: "on-finish" }),
      ],
    };
    const step = stepOf(
      { l: decided("failed"), z: decided("waiting") },
      cleanup,
    );
    assert.deepEqual(
      step.create.map((c) => c.nodeId),
      ["z"],
    );
    assert.deepEqual(step.create[0].dependsOn, []);

    // And `on-success` is not satisfied by it, which is the only reading under
    // which "after the loop succeeded" means what it says.
    const strict = stepOf({ l: decided("failed"), z: decided("waiting") }, DRAWN);
    assert.deepEqual(strict.create, []);
    assert.match(strict.block[0].reason, /did not finish what it repeats/);
  });
});

/* ------------------------------------------------------------------ */
/* Merge blocks in the schedule                                         */
/* ------------------------------------------------------------------ */

/**
 * Which runs a merge block is handed, and what an edge out of one means.
 *
 * The first is the whole reason `runIds` comes off `edgeVerdict`'s own
 * `dependsOn` rather than being re-derived from the graph: which runs an
 * orchestrator block turned out to emit is a fact only that pass holds, and a
 * second reading of it is a second chance to land a different set of branches
 * than the one the graph waited for.
 *
 * The second is the edge condition doing real work. A merge block creates no
 * run, so nothing about `edgeSatisfied` applies to it — but "review it whether
 * or not it landed" and "only once it is on main" are both things a person
 * writes, and reading a failed merge as satisfying either would start a run on a
 * target that never received the work.
 */
function mergeNode(id: string, name: string): WorkflowNode {
  return graphNode(id, name, {
    kind: "merge",
    mountId: "",
    folder: "",
    task: "",
    mergeStrategy: "merge",
  });
}

describe("planInstanceStep — merge blocks", () => {
  /** Two run blocks feeding one merge block, with a run block behind it. */
  const LAND: WorkflowGraph = {
    nodes: [
      { ...FAN.nodes[1], id: "left", name: "Left" },
      { ...FAN.nodes[1], id: "right", name: "Right" },
      mergeNode("land", "Land it"),
      { ...FAN.nodes[1], id: "after", name: "After" },
    ],
    edges: [
      edge("left", "land"),
      edge("right", "land"),
      edge("land", "after"),
    ],
  };

  it("hands a merge block every branch its satisfied edges resolved to", () => {
    const step = stepOf(
      {
        left: ran("r-left", "completed"),
        right: ran("r-right", "completed"),
        land: decided("waiting"),
      },
      LAND,
    );
    assert.deepEqual(step.merge, [
      { nodeId: "land", runIds: ["r-left", "r-right"] },
    ]);
    assert.deepEqual(step.spawn, [], "a merge block spawns no agent");
    assert.deepEqual(step.create, [], "and it is never created as a run");
  });

  it("waits for every predecessor before landing anything", () => {
    // Landing half the work and then landing the rest is two merges into a base
    // that moved in between, which is the case the queue exists to re-decide —
    // but the block was written as one step and has to behave as one.
    const step = stepOf(
      {
        left: ran("r-left", "completed"),
        right: ran("r-right", "running", 0),
        land: decided("waiting"),
      },
      LAND,
    );
    assert.deepEqual(step.merge, []);
  });

  it("takes every run an orchestrator block emitted", () => {
    const g: WorkflowGraph = {
      nodes: [FAN.nodes[0], mergeNode("land", "Land it")],
      edges: [edge("pick", "land", { edge: "on-success" })],
    };
    const step = stepOf(
      {
        pick: decided("emitted", [
          ["r-1", "completed"],
          ["r-2", "completed"],
        ]),
        land: decided("waiting"),
      },
      g,
    );
    assert.deepEqual(step.merge, [
      { nodeId: "land", runIds: ["r-1", "r-2"] },
    ]);
  });

  it("names a run once when two edges resolve to it", () => {
    // The diamond: two paths out of one run meet again at the merge block.
    // `enqueue` refuses a run that is already queued and refuses the *whole*
    // batch when it does, so a duplicate here is a merge that never happens.
    const diamond: WorkflowGraph = {
      nodes: [
        { ...FAN.nodes[1], id: "build", name: "Build" },
        mergeNode("land", "Land it"),
      ],
      edges: [
        edge("build", "land", { edge: "on-success" }),
        // A second edge cannot be written in the editor — `normalizeWorkflowInput`
        // refuses a repeated pair — so this is the shape an orchestrator block
        // emitting one run into two paths produces.
        { from: "build", to: "land", edge: "on-finish", continueBranch: false },
      ],
    };
    const step = stepOf(
      { build: ran("r-build", "completed"), land: decided("waiting") },
      diamond,
    );
    assert.deepEqual(step.merge, [{ nodeId: "land", runIds: ["r-build"] }]);
  });

  it("releases what is behind it with no dependency on a run", () => {
    // A merge block created nothing, so a successor of it depends on no run
    // through that edge — it is an ordinary queued run meaning "once the work
    // has landed".
    const step = stepOf(
      {
        left: ran("r-left", "completed"),
        right: ran("r-right", "completed"),
        land: decided("emitted"),
      },
      LAND,
    );
    assert.deepEqual(step.create, [{ nodeId: "after", dependsOn: [] }]);
  });

  it("stops an on-success successor when the merge did not land everything", () => {
    const step = stepOf(
      {
        left: ran("r-left", "completed"),
        right: ran("r-right", "completed"),
        land: decided("failed", [], "Landed 1 of 2 branch(es)."),
      },
      LAND,
    );
    assert.deepEqual(step.create, []);
    assert.match(step.block[0].reason, /did not land everything/);
  });

  it("releases an on-finish successor of a failed merge", () => {
    const g: WorkflowGraph = {
      ...LAND,
      edges: [
        edge("left", "land"),
        edge("right", "land"),
        edge("land", "after", { edge: "on-finish" }),
      ],
    };
    const step = stepOf(
      {
        left: ran("r-left", "completed"),
        right: ran("r-right", "completed"),
        land: decided("failed", [], "Landed 1 of 2 branch(es)."),
      },
      g,
    );
    assert.deepEqual(step.create, [{ nodeId: "after", dependsOn: [] }]);
  });

  it("blocks behind a merge that never ran, whatever the condition", () => {
    // `blocked` is "nothing happened", which satisfies nothing — the same
    // distinction `edgeSatisfied` draws between a run that did a cycle and one
    // that did not.
    for (const condition of ["on-success", "on-finish"] as const) {
      const g: WorkflowGraph = {
        ...LAND,
        edges: [
          edge("left", "land"),
          edge("right", "land"),
          edge("land", "after", { edge: condition }),
        ],
      };
      const step = stepOf(
        {
          left: ran("r-left", "completed"),
          right: ran("r-right", "completed"),
          land: decided("blocked", [], "The workflow was stopped."),
        },
        g,
      );
      assert.deepEqual(step.create, [], condition);
      assert.match(step.block[0].reason, /never ran/);
    }
  });

  it("holds a successor while the merge is still running", () => {
    const step = stepOf(
      {
        left: ran("r-left", "completed"),
        right: ran("r-right", "completed"),
        land: decided("thinking"),
      },
      LAND,
    );
    assert.deepEqual(step.create, []);
    assert.deepEqual(step.merge, [], "and it does not claim it twice");
    assert.deepEqual(step.block, []);
  });
});

/* ------------------------------------------------------------------ */
/* What a restart leaves waiting                                        */
/* ------------------------------------------------------------------ */

/**
 * `bootBlockPlan` decides which instances' `waiting` blocks a restart writes
 * off, and it is the one decision in this file whose wrong answer is invisible
 * for weeks. `reconcileOnBoot` keeps a `paused` member inside its grace period
 * on purpose; closing out the blocks behind it destroys the tail of a graph
 * that is still working and records a sentence about a predecessor that is not
 * true. Sparing one nothing survived in is the opposite error and just as
 * silent — a block that sits `waiting` for ever, because nothing is left that
 * could ever reach `advanceInstances` on its behalf.
 */
function instances(
  ...entries: Array<[string, WorkflowInstanceStatus, ...RunStatus[]]>
) {
  return entries.map(([id, status, ...memberStatuses]) => ({
    id,
    status,
    memberStatuses,
    restartClosedMember: false,
  }));
}

describe("bootBlockPlan — which waiting blocks a restart closes out", () => {
  it("spares an instance a member survived the boot in", () => {
    // The exception this exists for: `reconcileOnBoot` kept that run, so its
    // successors are waiting on something that is genuinely still coming.
    const plan = bootBlockPlan(instances(["i", "started", "completed", "paused"]), false);
    assert.deepEqual(plan.spared, ["i"]);
    assert.deepEqual(plan.abandoned, []);
    assert.deepEqual(plan.settled, []);
  });

  it("reads every live status as a survivor, not just a pause", () => {
    // `paused` is the only one that can reach this point in the boot today, but
    // by way of a rule in `reconcileOnBoot` — restating it here as a test for
    // one status would make this the second place that decides what survives.
    for (const status of ["waiting", "queued", "running", "paused"] as const) {
      const plan = bootBlockPlan(instances(["i", "started", status]), false);
      assert.deepEqual(plan.spared, ["i"], status);
    }
  });

  it("closes out an instance whose members all ended", () => {
    const plan = bootBlockPlan(
      instances(["i", "started", "completed", "failed", "stopped", "blocked"]),
      false,
    );
    assert.deepEqual(plan.abandoned, ["i"]);
    assert.deepEqual(plan.spared, []);
  });

  it("closes out an instance with no members at all", () => {
    // A graph deferred behind an orchestrator block the same boot has just
    // failed: nothing was ever created, so there is nothing to wait for.
    const plan = bootBlockPlan(instances(["i", "started"]), false);
    assert.deepEqual(plan.abandoned, ["i"]);
  });

  it("closes out an instance that is not started, however live its members", () => {
    // The bound the halt needs: `stopInstance` had already decided this graph
    // was over, and a `failed` one is `startWorkflow`'s own rollback, which
    // wrote every other block off in the same pass. Reviving half of either is
    // the failure the positive test for `started` exists to have none of.
    for (const status of ["stopping", "stopped", "failed"] as const) {
      const plan = bootBlockPlan(instances(["i", status, "running", "paused"]), false);
      assert.deepEqual(plan.settled, ["i"], status);
      assert.deepEqual(plan.spared, [], status);
    }
  });

  it("decides every instance exactly once", () => {
    // Three lists and one pass: an instance that fell between two branches is a
    // block nothing writes and nothing wakes, which reads on the page exactly
    // like one that is about to run.
    const given = instances(
      ["live", "started", "paused"],
      ["dead", "started", "failed"],
      ["halted", "stopping", "running"],
      ["empty", "started"],
      ["held", "started", "completed"],
    );
    given[1].restartClosedMember = true;
    const plan = bootBlockPlan(given, true);
    const decided = [...plan.abandoned, ...plan.settled, ...plan.spared, ...plan.held];
    assert.equal(decided.length, given.length);
    assert.deepEqual([...decided].sort(), given.map((i) => i.id).sort());
  });

  it("leaves an instance the restart closed nothing of to the lift, while new work is held", () => {
    // Lifting the hold calls `releaseDependents`, so these blocks have
    // something that wakes them, and it is a person. Closing them out wrote
    // off the work the operator held the fleet across the restart to keep.
    const plan = bootBlockPlan(
      instances(["empty", "started"], ["finished", "started", "completed", "failed"]),
      true,
    );
    assert.deepEqual(plan.held, ["empty", "finished"]);
    assert.deepEqual(plan.abandoned, []);
  });

  it("still closes out an instance whose member a restart closed out, held or not", () => {
    // `on-finish` is satisfied by a cycle that died with the container, so a
    // block behind it would be released by the lift onto work nobody finished.
    const [closed] = instances(["closed", "started", "stopped"]);
    closed.restartClosedMember = true;
    for (const held of [true, false]) {
      const plan = bootBlockPlan([closed], held);
      assert.deepEqual(plan.abandoned, ["closed"], `held: ${held}`);
      assert.deepEqual(plan.held, [], `held: ${held}`);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Loop blocks: whether there is another pass                          */
/* ------------------------------------------------------------------ */

/**
 * The decision a loop makes over and over, with nothing else in the picture.
 *
 * It earns a test on the same grounds as `releasableRuns` and `landRefusal`,
 * sharpened by what a *pass* costs: it is not a work cycle, it is a whole run
 * with its own cycles and its own spend. A loop that never terminates bills one
 * of those per pass for ever; a loop that stops one pass early is silent, in the
 * shape a finished-looking branch with the last piece of work missing.
 */

/** One run member of a pass, stated as the status its run ended in. */
function runMember(
  nodeId: string,
  status: RunStatus,
  opts: {
    done?: boolean;
    iterations?: number;
    name?: string;
    pass?: number;
  } = {},
): LoopPassMember {
  return {
    memberId: passMemberId("loop", opts.pass ?? 1, nodeId),
    nodeId,
    name: opts.name ?? nodeId,
    kind: "run",
    run: {
      id: `r-${opts.pass ?? 1}-${nodeId}`,
      status,
      iterations: opts.iterations ?? 1,
      refundedCycles: 0,
      reportedDone: opts.done ?? false,
    },
    block: null,
    emitted: [],
    workSetAside: 0,
  };
}

/** One member of a pass that is a ledger row: an orchestrator or a merge. */
function blockMember(
  nodeId: string,
  kind: "orchestrator" | "merge",
  status: BlockStatus,
  opts: {
    error?: string;
    emitted?: LoopRunState[];
    name?: string;
    pass?: number;
  } = {},
): LoopPassMember {
  return {
    memberId: passMemberId("loop", opts.pass ?? 1, nodeId),
    nodeId,
    name: opts.name ?? nodeId,
    kind,
    run: null,
    block: { status, error: opts.error ?? null },
    emitted: opts.emitted ?? [],
    workSetAside: 0,
  };
}

/** One pass, stated as the status its single run member ended in. */
function pass(
  n: number,
  status: RunStatus,
  opts: { done?: boolean; iterations?: number } = {},
): LoopPass {
  return { pass: n, members: [runMember("body", status, { ...opts, pass: n })] };
}

function loopOf(
  passes: LoopPass[],
  extra: Partial<LoopPassInput> = {},
): LoopDecision {
  return planLoopPass({
    blockName: "Chip away at it",
    passes,
    maxPasses: 3,
    maxCostUSD: null,
    spentGuardUSD: 0,
    // Null together, which is the condition switched off — every case below
    // this line is the loop as it behaved before the board could end one.
    stopWhenTasks: null,
    boardCounts: null,
    ...extra,
  });
}

describe("planLoopPass — whether a loop takes another pass", () => {
  it("takes the first pass when nothing has run yet", () => {
    assert.deepEqual(loopOf([]), { kind: "pass", pass: 1 });
  });

  it("waits while the last pass is still working", () => {
    // Every other test here reads the outcome of a pass, and there is none yet.
    // Unrolling ahead of it is also what would put two runs on one predecessor's
    // branch, which admission refuses — so the symptom would be a throw rather
    // than a decision.
    for (const status of ["waiting", "queued", "running", "paused"] as const) {
      assert.deepEqual(loopOf([pass(1, status)]), { kind: "wait" }, status);
    }
  });

  it("takes another pass after one that completed without reporting done", () => {
    // The ordinary case, and the one the whole feature exists for: `completed`
    // is also what a run that merely used up its cycle cap is written as.
    assert.deepEqual(loopOf([pass(1, "completed")]), { kind: "pass", pass: 2 });
  });

  it("stops when the agent reported the work complete", () => {
    // Read off `reported_done`, never off the status. `maxIterations` defaults
    // to 1, so a loop keyed on `completed` would stop after every first pass —
    // a loop that does not loop.
    const d = loopOf([pass(1, "completed", { done: true })]);
    assert.equal(d.kind, "stop");
    assert.equal(d.kind === "stop" && d.code, "done");
    assert.match(
      d.kind === "stop" ? d.reason : "",
      /reported the work complete on pass 1/,
    );
  });

  it("prefers done to the pass cap on the last pass", () => {
    // Both hold at once on the final pass. "It finished" is the truer sentence,
    // and the one that tells the operator not to raise the cap.
    const d = loopOf([
      pass(1, "completed"),
      pass(2, "completed"),
      pass(3, "completed", { done: true }),
    ]);
    assert.equal(d.kind === "stop" && d.code, "done");
  });

  it("stops when a run in the body did not complete, rather than trying again", () => {
    // A loop is not a retry mechanism: the transient-error retries and the
    // refusal backoff already sit inside one run, so a fault that got past them
    // is one the next pass would meet too.
    for (const status of ["failed", "stopped", "blocked"] as const) {
      const d = loopOf([pass(1, "completed"), pass(2, status)]);
      assert.equal(d.kind === "stop" && d.code, "failed", status);
      assert.match(
        d.kind === "stop" ? d.reason : "",
        new RegExp(`Pass 2 .*ended ${status}`),
      );
    }
  });

  it("stops on a pass whose run reported it could not finish", () => {
    // Two failures in one, and the first is the expensive one. `needs-review` is
    // terminal, so the rung above must not read it as a pass still working — a
    // loop block that waits for ever holds everything behind it with nothing on
    // any page to say why, and that is exactly what a missing `TERMINAL_STATUSES`
    // entry produces. Given that, the stop is the right answer for the reason
    // every non-completed status is: a loop is not a retry mechanism, and handing
    // the next pass the same wall costs a whole run rather than a work cycle.
    const d = loopOf([pass(1, "completed"), pass(2, "needs-review")]);
    assert.notEqual(d.kind, "wait");
    assert.equal(d.kind === "stop" && d.code, "failed");
    assert.match(d.kind === "stop" ? d.reason : "", /Pass 2 .*ended needs-review/);
  });

  it("reports the stop rather than the completion when the pass did both", () => {
    // The `reportedDone` rung is below this one, so a last pass that did the work
    // *and* asked for review says it stopped. Same precedence as the cycle-outcome
    // ladder, for the same reason: the ending that asks for a person is the one
    // that can be taken back.
    const d = loopOf([pass(1, "needs-review", { done: true })]);
    assert.equal(d.kind === "stop" && d.code, "failed");
  });

  it("stops at the pass cap", () => {
    const d = loopOf([
      pass(1, "completed"),
      pass(2, "completed"),
      pass(3, "completed"),
    ]);
    assert.equal(d.kind === "stop" && d.code, "passes");
    assert.match(d.kind === "stop" ? d.reason : "", /limit of 3 pass\(es\)/);
  });

  it("takes exactly one pass when the cap is one", () => {
    // A cap of 1 is a loop that does not repeat, and it has to be a legal
    // setting rather than an off-by-one: the first pass still happens.
    assert.deepEqual(loopOf([], { maxPasses: 1 }), { kind: "pass", pass: 1 });
    const after = loopOf([pass(1, "completed")], { maxPasses: 1 });
    assert.equal(after.kind === "stop" && after.code, "passes");
  });

  it("stops when the passes have spent their own limit", () => {
    const d = loopOf([pass(1, "completed")], {
      maxCostUSD: 5,
      spentGuardUSD: 5,
    });
    assert.equal(d.kind === "stop" && d.code, "cost");
    assert.match(d.kind === "stop" ? d.reason : "", /5\.00 of its 5\.00 limit/);
  });

  it("carries on below the spending limit, and ignores a null one", () => {
    assert.deepEqual(
      loopOf([pass(1, "completed")], { maxCostUSD: 5, spentGuardUSD: 4.99 }),
      { kind: "pass", pass: 2 },
    );
    assert.deepEqual(
      loopOf([pass(1, "completed")], { maxCostUSD: null, spentGuardUSD: 900 }),
      { kind: "pass", pass: 2 },
    );
  });

  it("stops on a pass that produced no members at all", () => {
    // The hot loop. A pass whose rows have since been deleted, or a loop from
    // before a section was required, has nothing to carry on from — and another
    // pass would be created the same way and fail the same way, for ever, one
    // billed attempt at a time.
    const d = loopOf([{ pass: 1, members: [] }]);
    assert.equal(d.kind === "stop" && d.code, "empty");
    assert.match(d.kind === "stop" ? d.reason : "", /started nothing/);
  });

  it("reads the empty pass before the caps, so the sentence names the cause", () => {
    const d = loopOf([{ pass: 1, members: [] }], {
      maxPasses: 1,
      maxCostUSD: 1,
      spentGuardUSD: 99,
    });
    assert.equal(d.kind === "stop" && d.code, "empty");
  });
});

/** A reading, as `loopBoardCount` answers one: a total and all four priorities. */
function counts(
  total: number,
  byPriority: Partial<Record<TaskPriorityDTO, number>> = {},
): LoopBoardCounts {
  return {
    total,
    byPriority: { urgent: 0, high: 0, normal: 0, low: 0, ...byPriority },
  };
}

/**
 * A member the operator left behind, as `planLoopPass` reads it.
 *
 * The pick-up reopens the pass and then asks this function again, so a member
 * it still reads as unfinished stops the loop a second time with the same
 * sentence — the button would do nothing, visibly — and one it reads as DONE
 * would end a loop on work nobody finished.
 */
describe("planLoopPass — a member left behind", () => {
  it("does not stop the loop, so the next pass is taken", () => {
    const stuck = runMember("b", "needs-review");
    const waived: LoopPassMember = {
      ...stuck,
      run: { ...stuck.run!, leftBehind: true },
    };
    const members = [runMember("a", "completed"), waived];
    assert.equal(loopOf([{ pass: 1, members: [runMember("a", "completed"), stuck] }]).kind, "stop");
    assert.deepEqual(loopOf([{ pass: 1, members }]), { kind: "pass", pass: 2 });
  });

  it("is not asked whether the work is done", () => {
    // Every member still waited on said DONE; the waived one said nothing,
    // and must not be the reason the loop carries on or stops.
    const waived = runMember("b", "needs-review");
    waived.run = { ...waived.run!, leftBehind: true };
    const decision = loopOf([
      { pass: 1, members: [runMember("a", "completed", { done: true }), waived] },
    ]);
    assert.equal(decision.kind, "stop");
    assert.match(decision.kind === "stop" ? decision.reason : "", /reported the work complete/);
  });
});

/** A settled review member, stated as what it approved and what it turned down. */
function reviewMember(
  nodeId: string,
  opts: { approved?: LoopRunState[]; workSetAside?: number } = {},
): LoopPassMember {
  return {
    memberId: passMemberId("loop", 1, nodeId),
    nodeId,
    name: nodeId,
    kind: "review",
    run: null,
    block: { status: "emitted", error: null },
    // `loopPasses`' reading: the approved branches' last links, and nothing
    // the review set aside.
    emitted: opts.approved ?? [],
    workSetAside: opts.workSetAside ?? 0,
  };
}

/**
 * A review member turning work down, as the DONE rung reads it.
 *
 * Silent both ways and on the operator's own `on-success` link: a pass whose
 * review turned the work down that reads as done ends the loop claiming work
 * nothing landed and starts what follows on a folder without it, and a pass
 * whose branch merely had nothing in it that does not read as done runs every
 * reviewed loop to its pass cap, billed, with a stop sentence that is false.
 */
describe("planLoopPass — a review member", () => {
  const reviewed = (review: LoopPassMember): LoopPass => ({
    pass: 1,
    members: [
      runMember("a", "completed", { done: true }),
      review,
      blockMember("m", "merge", "emitted"),
    ],
  });

  it("takes another pass when the review set the DONE branch aside", () => {
    // The pass from the report: the run said DONE, the review turned its
    // branch down, and the merge settled with nothing to land.
    assert.deepEqual(loopOf([reviewed(reviewMember("v", { workSetAside: 1 }))]), {
      kind: "pass",
      pass: 2,
    });
  });

  it("takes another pass when the review turned down only some of the work", () => {
    // Read per pass: the branch set aside need not be traceable to a member.
    const decision = loopOf([
      {
        pass: 1,
        members: [
          runMember("a", "completed", { done: true }),
          runMember("b", "completed", { done: true }),
          reviewMember("v", {
            approved: [{ id: "r-1-a", status: "completed", iterations: 1, refundedCycles: 0, reportedDone: true }],
            workSetAside: 1,
          }),
          blockMember("m", "merge", "emitted"),
        ],
      },
    ]);
    assert.deepEqual(decision, { kind: "pass", pass: 2 });
  });

  it("stops done when the review approved the branch", () => {
    const approved = { id: "r-1-a", status: "completed" as const, iterations: 1, refundedCycles: 0, reportedDone: true };
    const decision = loopOf([reviewed(reviewMember("v", { approved: [approved] }))]);
    assert.equal(decision.kind === "stop" && decision.code, "done");
  });

  it("stops done when the branch it set aside committed nothing", () => {
    // `loopPasses` leaves such a branch out of `workSetAside`: a run that found
    // nothing left to do and said so is how a reviewed loop ends.
    const decision = loopOf([reviewed(reviewMember("v"))]);
    assert.equal(decision.kind === "stop" && decision.code, "done");
  });
});

/** A board condition and a reading of it, as `advanceLoop` supplies the pair. */
function boardOf(
  count: number,
  atMost = 0,
  over: Partial<LoopBoardCondition> = {},
): Partial<LoopPassInput> {
  return {
    stopWhenTasks: {
      mountId: "work",
      folder: "backlog",
      includeSubfolders: false,
      statuses: ["open"],
      thresholds: [{ priority: "any", atMost }],
      ...over,
    },
    boardCounts: counts(count),
  };
}

describe("planLoopPass — the board condition", () => {
  it("stops before the first pass when the board is already clear", () => {
    // Most of what the condition is for, and the one thing the two caps cannot
    // do: they are read off a pass that settled, so a loop pointed at a backlog
    // that is already empty would bill a whole run to find that out.
    const d = loopOf([], boardOf(0));
    assert.equal(d.kind === "stop" && d.code, "tasks");
  });

  it("names the count, the number it was compared against and the project", () => {
    const d = loopOf([pass(1, "completed")], boardOf(2, 5));
    const reason = d.kind === "stop" ? d.reason : "";
    assert.match(reason, /at most 5 open task\(s\) left/);
    assert.match(reason, /work \/ backlog/);
    assert.match(reason, /It has 2\./);
  });

  it("carries on while the board is above the number", () => {
    assert.deepEqual(loopOf([], boardOf(1)), { kind: "pass", pass: 1 });
    assert.deepEqual(loopOf([pass(1, "completed")], boardOf(6, 5)), {
      kind: "pass",
      pass: 2,
    });
  });

  it("prefers what the agent said to a board that has not caught up", () => {
    // The ordering that decides which sentence the operator reads. An agent
    // that replied DONE finished the work; the board is a record of it that may
    // be one `complete_task` behind, and reporting the board would tell somebody
    // to go and look at a backlog that is about to be clear.
    const d = loopOf([pass(1, "completed", { done: true })], boardOf(0));
    assert.equal(d.kind === "stop" && d.code, "done");
  });

  it("prefers a broken or empty pass to a met condition", () => {
    // Both rungs above it, and for the reason they are above the caps too: a
    // pass that failed is what somebody has to act on, and a board that happens
    // to be clear at that moment does not make the failure a completion.
    const broken = loopOf([pass(1, "failed")], boardOf(0));
    assert.equal(broken.kind === "stop" && broken.code, "failed");
    const empty = loopOf([{ pass: 1, members: [] }], boardOf(0));
    assert.equal(empty.kind === "stop" && empty.code, "empty");
  });

  it("still waits on an unsettled pass, whatever the board says", () => {
    assert.deepEqual(loopOf([pass(1, "running")], boardOf(0)), { kind: "wait" });
  });

  it("outranks both caps, because a clear board is finishing rather than running out", () => {
    // The operator reads the stop reason to decide whether to raise a cap. A
    // loop that emptied its backlog on its last pass must not tell them to.
    const d = loopOf([pass(1, "completed")], {
      ...boardOf(0),
      maxPasses: 1,
      maxCostUSD: 1,
      spentGuardUSD: 99,
    });
    assert.equal(d.kind === "stop" && d.code, "tasks");
  });

  it("changes nothing at all when no condition is set", () => {
    // The reading is null together with the condition, so a count that would
    // otherwise be met cannot reach the test — which is what makes every saved
    // graph above this line behave exactly as it did.
    assert.deepEqual(loopOf([], { boardCounts: counts(0) }), {
      kind: "pass",
      pass: 1,
    });
    assert.deepEqual(loopOf([pass(1, "completed")], { boardCounts: counts(0) }), {
      kind: "pass",
      pass: 2,
    });
    const capped = loopOf([pass(1, "completed")], {
      boardCounts: counts(0),
      maxPasses: 1,
    });
    assert.equal(capped.kind === "stop" && capped.code, "passes");
  });

  it("stops on any one of its thresholds, not on all of them", () => {
    // The operator's own "or", and the safe direction: a loop still billing a
    // whole run per pass has to be endable by the first line that comes true.
    // An all-of reading holds this one open on a board nobody called full.
    const d = loopOf([pass(1, "completed")], {
      ...boardOf(40, 10, {
        thresholds: [
          { priority: "any", atMost: 10 },
          { priority: "normal", atMost: 5 },
        ],
      }),
      boardCounts: counts(40, { normal: 4 }),
    });
    assert.equal(d.kind === "stop" && d.code, "tasks");
    // The one that was met, with its priority and both numbers on it: five
    // lines in and "the board is clear enough" is unreadable a day later.
    const reason = d.kind === "stop" ? d.reason : "";
    assert.match(reason, /at most 5 normal-priority open task\(s\) left/);
    assert.match(reason, /It has 4\./);
  });

  it("carries on while every threshold is above its number", () => {
    assert.deepEqual(
      loopOf([pass(1, "completed")], {
        ...boardOf(40, 10, {
          thresholds: [
            { priority: "any", atMost: 10 },
            { priority: "normal", atMost: 5 },
          ],
        }),
        boardCounts: counts(40, { normal: 6 }),
      }),
      { kind: "pass", pass: 2 },
    );
  });

  it("reads a priority threshold against that priority's count alone", () => {
    // The whole of what a priority threshold is: a project with forty tasks on
    // it stops a loop whose line is about the three urgent ones.
    const d = loopOf([pass(1, "completed")], {
      ...boardOf(40, 0, {
        thresholds: [{ priority: "urgent", atMost: 3 }],
      }),
      boardCounts: counts(40, { urgent: 3, normal: 37 }),
    });
    assert.equal(d.kind === "stop" && d.code, "tasks");
    assert.match(d.kind === "stop" ? d.reason : "", /at most 3 urgent-priority/);
  });

  it("reads a condition saved as one number as one “any” threshold", () => {
    // No saved workflow may change meaning. Nothing re-normalises a stored
    // graph — `rowToWorkflow` and `rowToInstance` both hand back the blob as it
    // was written — so the single-number shape reaches this function intact,
    // and `thresholds` is not merely empty on it but absent.
    const legacy = {
      mountId: "work",
      folder: "backlog",
      statuses: ["open"],
      atMost: 5,
    } as unknown as LoopBoardCondition;

    const met = loopOf([pass(1, "completed")], {
      stopWhenTasks: legacy,
      boardCounts: counts(5),
    });
    assert.equal(met.kind === "stop" && met.code, "tasks");
    assert.match(
      met.kind === "stop" ? met.reason : "",
      /at most 5 open task\(s\) left/,
    );

    assert.deepEqual(
      loopOf([pass(1, "completed")], {
        stopWhenTasks: legacy,
        boardCounts: counts(6),
      }),
      { kind: "pass", pass: 2 },
    );
  });

  it("says when the project it counted was the folder and everything under it", () => {
    // Two counts can wear one project's name, and the sentence has to say which
    // of them ended the loop — a backlog counted with its subfolders is a wider
    // one than the board draws under that heading.
    const d = loopOf([], boardOf(0, 0, { includeSubfolders: true }));
    assert.match(
      d.kind === "stop" ? d.reason : "",
      /work \/ backlog and everything under it/,
    );
  });

  it("carries on when the condition is set and the count could not be read", () => {
    // `advanceLoop` ends the loop itself when the reader refuses, so a null
    // count beside a condition never reaches here from that caller. It must
    // still not read as a clear board, which is the one answer that stops it.
    assert.deepEqual(
      loopOf([], { ...boardOf(0), boardCounts: null }),
      { kind: "pass", pass: 1 },
    );
  });
});

describe("planInstanceStep — a loop block among the others", () => {
  /** One loop block, with a run block set to follow it. */
  const LOOP: WorkflowGraph = {
    nodes: [
      graphNode("chip", "Chip away at it", { kind: "loop", maxPasses: 3 }),
      graphNode("review", "Review it"),
    ],
    edges: [edge("chip", "review", { edge: "on-success", continueBranch: true })],
  };

  it("asks for a loop's first pass rather than creating it as a run", () => {
    const step = stepOf({ chip: decided("waiting") }, LOOP);
    assert.deepEqual(step.loop, [{ nodeId: "chip", dependsOn: [] }]);
    assert.deepEqual(step.create, []);
    assert.deepEqual(step.spawn, []);
  });

  it("holds everything behind a loop while it is still repeating", () => {
    // The window that matters: between two passes there is no unsettled run on
    // the branch at all, so a successor released here would review and land a
    // ref that is about to move.
    const step = stepOf(
      { chip: decided("looping", [["r-1", "completed"]]) },
      LOOP,
    );
    assert.deepEqual(step.create, []);
    assert.deepEqual(step.block, []);
  });

  it("creates the block behind it after the last pass, pushing no run", () => {
    // Every pass landed its own work through the section's own exit, so by the
    // time the loop hands on there is no branch of its own left and no run to
    // wait for: a successor of a loop is a successor of a *landing*, exactly as
    // a successor of a merge block is.
    const step = stepOf(
      {
        chip: decided("emitted", [
          ["r-1", "completed"],
          ["r-2", "completed"],
        ]),
      },
      LOOP,
    );
    assert.deepEqual(step.create, [{ nodeId: "review", dependsOn: [] }]);
  });

  it("does not read the last pass's run at all", () => {
    // The defect this replaced: handed the last pass's run, a successor would
    // carry on a ref that pass had already landed and may since have deleted —
    // and which member of a section that fans out was "the last" was a question
    // with no answer. A pass whose runs all failed is a pass the loop already
    // stopped on, and `settleLoop` is what wrote that onto the block row.
    const step = stepOf(
      {
        chip: decided("emitted", [
          ["r-1", "completed"],
          ["r-2", "failed"],
        ]),
      },
      LOOP,
    );
    assert.deepEqual(step.create, [{ nodeId: "review", dependsOn: [] }]);
  });

  it("blocks what is behind a loop that stopped on a pass that failed", () => {
    // The block row is the only thing left to read, which is why `settleLoop`
    // writes `failed` rather than `emitted` for one of those. See
    // `loopStopStatus`.
    const step = stepOf({ chip: decided("failed", []) }, LOOP);
    assert.deepEqual(step.create, []);
    assert.match(step.block[0].reason, /did not finish what it repeats/);
  });

  it("never asks for a first pass twice", () => {
    // Every terminal run transition in the app triggers an advance, so a loop
    // selected again while it is repeating is a second run in the same folder.
    assert.deepEqual(stepOf({ chip: decided("looping") }, LOOP).loop, []);
    assert.deepEqual(stepOf({ chip: decided("emitted") }, LOOP).loop, []);
    assert.deepEqual(stepOf({ chip: decided("failed") }, LOOP).loop, []);
  });

  it("waits for what is in front of a loop before its first pass", () => {
    const g: WorkflowGraph = {
      nodes: [graphNode("build", "Build"), ...LOOP.nodes],
      edges: [edge("build", "chip", { edge: "on-success" }), ...LOOP.edges],
    };
    assert.deepEqual(
      stepOf(
        { build: ran("r-build", "running", 0), chip: decided("waiting") },
        g,
      ).loop,
      [],
    );
    assert.deepEqual(
      stepOf({ build: ran("r-build", "completed"), chip: decided("waiting") }, g)
        .loop,
      [
        {
          nodeId: "chip",
          dependsOn: [
            { runId: "r-build", edge: "on-success", continueBranch: false },
          ],
        },
      ],
    );
  });
});

/* ------------------------------------------------------------------ */
/* A pass's member ids, and the passes read back out of them           */
/* ------------------------------------------------------------------ */

/**
 * The format a pass names its rows in, and the grouping read back out of it.
 *
 * Earned twice over. The string is written in one place and parsed in three —
 * `loopPasses` groups on it, `land.ts` names the pass holding a branch from it,
 * and the instance DTO shows a pass number off it — so a format and a parser
 * that drifted apart is a loop reporting one pass of six where there were three
 * passes of two, which trips the pass cap four passes early and reports it as
 * running out. And the grouping is what `planLoopPass` reads its whole decision
 * off: six passes read as one never trips the cap at all.
 */
describe("passMemberId", () => {
  it("round-trips the loop, the pass and the block", () => {
    const id = passMemberId("loop-1", 3, "body-2");
    assert.deepEqual(passMemberOf(id), {
      loopNodeId: "loop-1",
      pass: 3,
      bodyNodeId: "body-2",
    });
    assert.equal(passNumberOf(id), 3);
  });

  it("puts every row a loop causes under one prefix", () => {
    // The prefix is the whole of "is this row ours" — for a member, and for a
    // run an orchestrator member decided on, which `createEmitted` names under
    // the member rather than under the loop. `loopSpend` sums on it, so a run
    // outside it is money a pass spent and its cap cannot see.
    const member = passMemberId("loop-1", 2, "body-2");
    assert.ok(member.startsWith(passPrefix("loop-1")));
    assert.ok(`${member}#spec-7`.startsWith(passPrefix("loop-1")));
    assert.equal(passNumberOf(`${member}#spec-7`), 2);
  });

  it("reads a loop's own id back off a member from before sections", () => {
    // An instance carries a copy of the graph it was started from, so a loop
    // that has been repeating since it held a task of its own is still read
    // back — and its rows are `<loop>#pass-N`, naming no block. Null rather
    // than a guess, and it reads as the loop's own block, which is what it was.
    assert.deepEqual(passMemberOf("loop-1#pass-4"), {
      loopNodeId: "loop-1",
      pass: 4,
      bodyNodeId: null,
    });
  });

  it("says a plain node id carries no pass", () => {
    // What tells a graph's own block from a pass's member, at every reader.
    assert.equal(passMemberOf("body-2"), null);
    assert.equal(passNumberOf("body-2"), null);
  });

  it("reads the loop's own pass when a block or a spec is itself named pass-N", () => {
    // `pass-2` is a legal block id and a legal spec id, so the id carries the
    // spelling twice. Read off the last one, a member of pass 1 was filed under
    // a loop called `L#pass-1` that does not exist: `passState` never saw it,
    // and every step of the pass created it again — 64 runs from one press of
    // Run, none of them members, so no stop and no cap reached them.
    for (const [id, bodyNodeId] of [
      [passMemberId("L", 1, "pass-2"), "pass-2"],
      [`${passMemberId("L", 1, "o")}#pass-2`, "o#pass-2"],
    ] as const) {
      assert.deepEqual(passMemberOf(id), { loopNodeId: "L", pass: 1, bodyNodeId }, id);
      assert.equal(passNumberOf(id), passMemberOf(id)?.pass, id);
    }
  });

  it("reads `o#pass-2` as a pass only when the graph's `o` is a loop", () => {
    // Outside every loop, an orchestrator block `o` that decides on spec
    // `pass-2` names the run `o#pass-2` — the body-less spelling of a loop's
    // pass 2. Read as one, the stuck run was offered no pick-up and leaving it
    // behind was refused for a loop that is not there.
    const withO = (kind: string) => ({
      nodes: [
        { id: "L", kind: "loop" },
        { id: "o", kind },
      ],
    });
    assert.equal(passMemberIn(withO("orchestrator"), "o#pass-2"), null);
    assert.deepEqual(passMemberIn(withO("loop"), "o#pass-2"), passMemberOf("o#pass-2"));
    const inPass = `${passMemberId("L", 1, "o")}#pass-2`;
    assert.deepEqual(passMemberIn(withO("orchestrator"), inPass), passMemberOf(inPass));
    assert.equal(passMemberIn(withO("orchestrator"), "body-2"), null);
  });
});

describe("groupPasses", () => {
  it("groups a pass's several members together", () => {
    // The whole point of a section: one pass is a fan-out and a merge, not one
    // run. Read as three passes it would trip a cap of 2 on its first.
    const grouped = groupPasses([
      runMember("a", "completed"),
      runMember("b", "completed"),
      blockMember("m", "merge", "emitted"),
    ]);
    assert.equal(grouped.length, 1);
    assert.deepEqual(
      grouped[0].members.map((m) => m.nodeId),
      ["a", "b", "m"],
    );
  });

  it("splits on the pass number the ids carry, not on a count", () => {
    const grouped = groupPasses([
      runMember("a", "completed", { pass: 1 }),
      runMember("m", "completed", { pass: 1 }),
      runMember("a", "running", { pass: 2 }),
    ]);
    assert.deepEqual(
      grouped.map((p) => [p.pass, p.members.length]),
      [
        [1, 2],
        [2, 1],
      ],
    );
  });

  it("keeps a pass whose rows are gone as an empty slot", () => {
    // Pass 2's members were deleted. The number comes off the ids that are
    // left, so pass 3 is still pass 3 — where counting would call it pass 2 and
    // the cap would be read one pass short for the rest of the loop.
    const grouped = groupPasses([
      runMember("a", "completed", { pass: 1 }),
      runMember("a", "running", { pass: 3 }),
    ]);
    assert.deepEqual(
      grouped.map((p) => p.pass),
      [1, 3],
    );
  });

  it("gives a member with no pass in its id a pass of its own", () => {
    // The safe direction: an extra entry can only stop a loop early, where a
    // member folded into the pass beside it changes which rows every exit
    // condition is read off.
    const grouped = groupPasses([
      { ...runMember("a", "completed"), memberId: "odd-one" },
      runMember("b", "completed", { pass: 1 }),
    ]);
    assert.deepEqual(
      grouped.map((p) => p.members.map((m) => m.memberId)),
      [["odd-one"], [passMemberId("loop", 1, "b")]],
    );
  });
});
