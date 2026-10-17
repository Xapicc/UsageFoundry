import {
  DEPENDENCY_EDGES,
  dependencyCycle,
  overlaps,
  resolveWorkspaceFolder,
  topologicalOrder,
  type ConflictKey,
  type DependencyEdge,
  type DependencyLink,
} from "./orchestrator";
import { edgesExclude } from "./branchRival";
import type { LandStrategy } from "./land";
import {
  normalizeInstanceBudget,
  type InstanceBudgetPolicy,
} from "./budget";
import {
  agentRefusal,
  currentAgentKnowledge,
  type AgentKnowledge,
} from "./agents";
import { jsonKind, notStringRefusal } from "./http";
import { parseVerifyCommand } from "./verifyCommand";
import { chatGuards } from "./settings";
import { listTemplates } from "./templates";
import { WORKSPACE_MOUNTS } from "./config";
import {
  MAX_FAN_OUT,
  MAX_LOOP_BOARD_THRESHOLDS,
  MAX_LOOP_PASSES,
  MAX_LOOP_RUNS,
  MAX_REVIEW_FIX_ROUNDS,
  MAX_TURN_RETRIES,
  MAX_WORKFLOW_NAME,
  MAX_WORKFLOW_NODES,
  REVIEW_VERDICT_KINDS,
  type ReviewVerdictSourceDTO,
  boardThresholds,
  type LoopBoardConditionDTO,
  type LoopBoardThresholdDTO,
  RUN_PROVIDERS,
  type RunProviderDTO,
  type TaskPriorityDTO,
  type TaskStatusDTO,
  type WorkflowNodeKind,
} from "./apiTypes";
import { worstCaseRuns } from "./canvasGraph";

/**
 * What a workflow graph *is*, and every refusal that can be decided without
 * touching the disk.
 *
 * Split out of `workflows.ts` because it is the half with no state in it: the
 * shape a graph has on the wire, and `normalizeWorkflowInput`, which is the one
 * authority on whether a saved graph could ever be started. Nothing here reads
 * the database, spawns anything or writes a row, and nothing in here depends on
 * the execution half — which is what makes "refuse at save what instantiation
 * refuses" checkable by reading one file rather than six thousand lines.
 *
 * `workflows.ts` re-exports all of it, so this split is invisible to importers.
 */

/* ------------------------------------------------------------------ */
/* Shape                                                               */
/* ------------------------------------------------------------------ */

/** One block of work: a task, where it runs, and the guards it runs under. */
export interface WorkflowNode {
  /**
   * Stable within this graph and referenced by every edge. Supplied by the
   * editor rather than minted here, because the edges are written against it in
   * the same form submission.
   */
  id: string;
  /** What the operator calls this step. Shown wherever a node is named. */
  name: string;
  /**
   * A fixed run, a turn that decides what runs to start, or a merge of what the
   * blocks in front of it built. See `WorkflowNodeKind` and the two notes above.
   */
  kind: WorkflowNodeKind;
  /**
   * The template supplying every guard, or null for `chatDefaultGuards`. Null
   * on the two kinds that start no child of their own — a merge block and a
   * loop — because guards decide what an agent may do and neither has one.
   */
  templateId: string | null;
  /**
   * The workspace this block works in. `""` on a merge block, which works in
   * whichever repository each branch it lands came from — recorded on the run
   * that cut the branch, and never named here — and `""` on a loop, which works
   * nowhere: each block of the section it frames names its own.
   */
  mountId: string;
  /** Path within the mount. `""` is the mount root, and is a real answer. */
  folder: string;
  /**
   * True when this block works in the folder a press of Run chose from the
   * workflow's saved `folders`, rather than in a folder of its own.
   *
   * Absent is false, and it has to be: every graph saved before this existed
   * names its own folder on every block, and no reading may move one. Only a
   * run or orchestrator block may carry it — the other kinds name no folder to
   * replace. Such a block still *stores* a concrete `mountId`/`folder`, the
   * first saved folder, written by `normalizeWorkflowInput` and never typed by
   * anybody: every reader of a saved graph that is not instantiation then sees
   * a folder a person saved, never `""`, which is the mount root.
   */
  followsChosenFolder?: boolean;
  /**
   * What this block is asked to do, or to decide. `""` on a merge block and on
   * a loop, neither of which is asked anything — see `LOOP_IS_TOLD_NOTHING`.
   */
  task: string;
  /**
   * Standing instructions this node's task is appended to, replacing the
   * template's prompt for this one node. Prompt text is the half of a run that
   * is *work* rather than permission, which is why this is here and a budget
   * is not — the same split `chat_proposals.prompt_override` makes.
   *
   * On an orchestrator block it is the prompt every run it emits starts with,
   * for the same reason: the emitted task is the specific instance and this is
   * what stands above it.
   */
  promptOverride: string | null;
  /**
   * A saved agent this block's own child is started **as**, or null.
   *
   * On the **work** side of the node — beside the mount, the folder, the task
   * and the prompt override — and deliberately not on the guard side. That
   * placement was re-decided when the flag became `--agent` rather than carried
   * over: the child now *is* this agent, which makes the field a larger fact
   * and not a different kind of one. An agent still carries no capability at
   * all — it holds no tool list and no permission mode — so what it changes is
   * who the child is and never what the block may do. The three narrowings of
   * `--permission-mode` stay three, the two routes to it stay two, and
   * `guardsFor` still returns the same three fields.
   *
   * **It is the node's own and is never inherited from its template**, which is
   * the mount and folder's rule rather than the prompt's. What decides it is
   * what a template answers *here*: the run form applies one as a seed for every
   * field, where a node reads one for exactly three things — its guards, the
   * standing instructions `promptOverride` replaces, and the model. The model
   * joined that list when `run_templates` grew one, and it belongs there on the
   * ground that keeps it off this field: it moves cost and never capability, and
   * a node has no model of its own for it to override. It supplies neither the
   * mount nor the folder, for the stated reason that a template edited months
   * later would silently move a saved block's run to another repository, and an
   * agent is the same shape of change one field over: it decides who does the
   * work, it points into a registry that is edited somewhere else entirely, and
   * a saved graph whose agent moved with nothing in the graph changing is
   * exactly that surprise. The canvas states this field in the sentence a press
   * of Run is approved against, which it could not do honestly for a value that
   * lives on another record.
   *
   * An **id** rather than a copy, which is `run_templates.agent_id`'s rule and
   * the opposite of `runs.agent`'s, for that pair's reason: a saved graph is
   * form input applied again and again, so an operator who fixes their
   * reviewer's prompt expects the next press of Run to use the fixed one. The
   * copy is taken where it always is — `createRun` freezes the whole definition
   * onto the run — so an agent deleted between two blocks of one instance
   * cannot reach a run that has already started.
   *
   * Which child it is differs by kind, and the field does not. On a run block it
   * is what that run itself is started as. On an orchestrator block it is the
   * **deciding turn's**, because that turn is the child this block spawns; the runs it
   * emits name their own, one per spec, which is the only per-run answer
   * available to a block that has not decided on them yet. That is the opposite
   * way round from `promptOverride`, which an orchestrator block holds on behalf
   * of the runs it emits — standing instructions are what a run is *asked*, and
   * the deciding turn is asked by `blockSystemPrompt` instead. A merge block
   * spawns no child at all, so one named there is refused rather than dropped;
   * see `normalizeWorkflowInput`.
   */
  agentId: string | null;
  /**
   * How many runs an orchestrator block may start. Null on a run block.
   *
   * Never null on an orchestrator block, and that is enforced at *save* rather
   * than at Run — the reasoning `normalizeTemplateInput` applies to the
   * `no_terminus` pair, with more at stake: this is the one block whose runs
   * start with nothing between the decision and the spawn, so a missing limit
   * is an unbounded number of billed agents from one press of Run.
   */
  fanOut: number | null;
  /**
   * How many times an orchestrator block's deciding turn is started again when
   * the turn itself failed having decided nothing, 0 to `MAX_TURN_RETRIES`.
   * Null on every other kind.
   *
   * Optional, and absent is 0: every graph saved before the field existed — and
   * every instance started from one — says nothing here, and reading that as
   * anything but "never" would bill turns nobody agreed to. It is on the node
   * for `fanOut`'s reason: it is spend with nobody looking, so the number is
   * the one a person fixed when they saved the graph, and nothing a model emits
   * can raise it.
   */
  turnRetries?: number | null;
  /**
   * How a merge block puts each branch onto its target. Null on every other
   * kind, never null on a merge one.
   *
   * Recorded on the graph rather than read from `settings.landStrategy` when the
   * block runs, which is the treatment the mount and folder already get and for
   * the same reason: a workflow is saved once and run for months, and a setting
   * edited in between would silently change what a saved graph does to a
   * repository with nothing in the graph changing.
   */
  mergeStrategy: LandStrategy | null;
  /**
   * Whether a merge block may pay a model to reconcile a conflict. False on
   * every other kind.
   *
   * The one thing a merge block can spend, and it is authorised here for
   * `merge_queue.auto_resolve`'s reason: queueing with the box ticked is the
   * authorisation, recorded next to the work it authorises rather than read from
   * configuration that could have changed since. Saving a graph with this on is
   * the same act, one level up.
   */
  mergeAutoResolve: boolean;
  /**
   * How many passes a loop block may take. Null on every other kind.
   *
   * Never null on a loop block, refused at save for `fanOut`'s reason read one
   * level along: a loop manufactures its own next unit of work, so it needs a
   * quantity that moves one way and keeps moving — the same argument that makes
   * `maxIterations` and `maxDurationMinutes` nullable only as a pair. Nothing
   * else here qualifies. Spend can be refunded, a window fraction can fall, and
   * an agent can report `DONE` for ever.
   */
  maxPasses: number | null;
  /**
   * Everything this loop's passes may spend together, or null for no cap.
   *
   * The one number on a node that reads like a budget, and it is not one. A
   * guard decides what an agent *may do* — `--permission-mode`, an isolation
   * choice, a per-run limit — and every one of those still comes from the
   * block's template or from `settings.chatDefaultGuards`, exactly as they do
   * for every other kind of block. This is a **terminus**, the same kind of
   * number `fanOut` is: it bounds how many times a block repeats and can only
   * ever end the loop earlier. It cannot raise a run's budget, it is unreachable
   * from anything a model emits, and it never widens the workflow-wide limit —
   * `evaluateInstanceBudget` does not read it, and that guard still halts the
   * whole instance at every member's cycle boundary whatever this says.
   */
  maxLoopCostUSD: number | null;
  /**
   * The board condition: repeat until one project's task count has fallen to
   * `atMost`. Null on every other kind, and null when the condition is off.
   *
   * A **terminus**, the third on this node and the same kind of number the two
   * above are: it can only ever end the loop earlier, it reaches no guard, and
   * `evaluateInstanceBudget` does not read it either. It is the one ending that
   * is a fact about the *board* rather than about a pass, which is why it is
   * checked before the first pass as well as between them — a loop pointed at a
   * backlog that is already clear must start no run at all, and the two caps
   * are only ever read after a pass has settled.
   *
   * Absent is off, and that reading is load-bearing: every graph saved before
   * this field existed says nothing here, exactly as it says nothing about
   * `kind`.
   */
  stopWhenTasks: LoopBoardCondition | null;
  /**
   * The blocks this loop repeats. Empty on every other kind, and **never empty
   * on a loop**: a loop holds no work of its own, so one that frames nothing is
   * refused rather than read as a block that repeats itself.
   *
   * **Derived from the loop's `repeats` link**, by `resolveSections`, which is
   * the only thing that states a section. A list may arrive beside it and is
   * then a cross-check: one that disagrees with the links is refused by name,
   * and one that arrives with no link at all is refused too. What is stored is
   * this list either way, so every rule below and every runtime reader is
   * written against one field and not two.
   *
   * Each pass creates one run per member that runs — see the arithmetic in
   * `loopBodyRefusal`, which is where an orchestrator member's fan-out is
   * charged per pass — in the order the section's own edges give, and the
   * section's exit lands what the pass produced.
   *
   * Validated in `graphRefusal` rather than here, and that is not a placement
   * detail: every question worth asking about a section is a question about the
   * *graph* — whether those ids are blocks at all, whether one of them is in
   * another section, whether an edge crosses the boundary, whether the members
   * have one way out. `normalizeNode` sees one block and could answer none of
   * them.
   */
  bodyNodeIds: string[];
  /**
   * Which agent CLI does the work — a run block's run, or every run an
   * orchestrator block emits — or null for the ordinary Claude run.
   *
   * On the node for the reason the fan-out cap is: an orchestrator block's runs
   * start with nobody looking, so what they run as is fixed by the person who
   * saved the graph, and `emit_runs` has no field for it. The deciding turn
   * itself stays Claude Code either way; this is about the runs, not the planner.
   */
  provider: RunProviderDTO | null;
  /**
   * How many fix rounds a review block gives a rejected branch. Null on every
   * other kind, and never null on a review block.
   */
  fixRounds: number | null;
  /**
   * Where a review block's verdict on each branch comes from. Null on every
   * other kind, and set on every review block a save produced.
   *
   * Optional because a graph saved before the field existed — and every
   * instance started from one — carries nothing here, and that reads as
   * `model`: the frontier review those graphs were saved to pay for. A reader
   * asks `?.kind === "status"` and never the reverse.
   */
  verdictSource?: ReviewVerdictSource | null;
}

/** Where a review block's verdict comes from. See the DTO. */
export type ReviewVerdictSource = ReviewVerdictSourceDTO;

/** Which tasks a loop counts, and the numbers it stops at. See the DTO. */
export type LoopBoardCondition = LoopBoardConditionDTO;

/** One of that condition's numbers, and what it counts. See the DTO. */
export type LoopBoardThreshold = LoopBoardThresholdDTO;

/**
 * What a threshold may count: each priority, and the whole project.
 *
 * Its own list rather than a read of `TASK_PRIORITIES` in `tasks.ts`, for
 * `COUNTABLE_TASK_STATUSES` below's reason one field along — this module reads
 * no database and must not pull the board's storage in to validate a word off
 * the wire. `"any"` is first because it is the default and the one the old
 * single-number shape reads as.
 */
const THRESHOLD_PRIORITIES: readonly (TaskPriorityDTO | "any")[] = [
  "any",
  "urgent",
  "high",
  "normal",
  "low",
];

/**
 * The task states a loop may count, and the two it may not.
 *
 * `done` and `dropped` are refused **by name** rather than dropped from the
 * list: both counts only ever grow, so "at most N" against one is true the
 * first time it is asked and would stop the loop before its first pass — an
 * operator who asked to work a backlog would get a workflow that did nothing,
 * with no error anywhere.
 */
const COUNTABLE_TASK_STATUSES: readonly TaskStatusDTO[] = ["open", "claimed"];
const GROWING_TASK_STATUSES: readonly TaskStatusDTO[] = ["done", "dropped"];

/**
 * The one condition on a link that is not a dependency: containment.
 *
 * A link out of a loop block carrying this states *what the loop repeats* — its
 * target is the first block of the section, and the section is that target plus
 * everything linked after it. It is **never** a run dependency: read as one it
 * would be the back edge the whole repeated-section design exists to avoid,
 * because the run it names is created once per pass by the loop itself and
 * nothing outside a pass ever waits for it. `planInstanceStep` drops it by name
 * for that reason, and a test holds the drop in place.
 *
 * A separate value of the same field rather than a flag beside it, because the
 * operator answers one question about a link — what does this arrow mean —
 * and two controls for one answer is how the mechanism this replaced ended up
 * with a silent override on one side and an inert link on the other.
 */
export const REPEATS_EDGE = "repeats";

/**
 * Every answer a link may carry: the three dependency conditions and
 * containment.
 *
 * Deliberately *not* added to `DEPENDENCY_EDGES`, which is what a `runs` row
 * stores and what `admitDependencies` reads. Widening that would put "repeats"
 * on a live dependency, which is the one thing it may never be.
 */
export const WORKFLOW_EDGE_CONDITIONS = [
  ...DEPENDENCY_EDGES,
  REPEATS_EDGE,
] as const;
export type WorkflowEdgeCondition = DependencyEdge | typeof REPEATS_EDGE;

/**
 * "Start `to` after `from` has settled" — or, for `repeats`, "`from` repeats
 * `to` and everything linked after it".
 */
export interface WorkflowEdge {
  from: string;
  to: string;
  edge: WorkflowEdgeCondition;
  /** Whether `to` carries on `from`'s branch instead of cutting a new one. */
  continueBranch: boolean;
}

/** A link that really is "start `to` after `from`", narrowed for the readers. */
export interface WorkflowDependencyEdge extends WorkflowEdge {
  edge: DependencyEdge;
}

/**
 * Whether this link states a dependency rather than what a loop contains.
 *
 * A type guard rather than a predicate, so that every reader which turns an
 * edge into a `run_deps` row has to filter through it first — `edge` on a
 * `WorkflowEdge` is not a value `createRun` may store, and the compiler is what
 * makes that unmissable rather than a comment somebody has to find.
 */
export function isDependencyEdge(
  edge: WorkflowEdge,
): edge is WorkflowDependencyEdge {
  return edge.edge !== REPEATS_EDGE;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface WorkflowInput {
  name: string;
  graph: WorkflowGraph;
  /**
   * Limits on the whole press of Run, as against a node's.
   *
   * The **one** thing on a workflow that is a guard, and it is here rather than
   * on a node for the reason the node-level ones are on a template: it bounds
   * something no per-run limit can see. Ten blocks under a $5 run limit is a $50
   * workflow, and nothing before this stood between the operator and that
   * number. It is still not a fourth route to `--permission-mode`, holds no
   * permission mode, no isolation choice and no model, and nothing a model
   * emits can reach it — see `startWorkflow`.
   */
  instanceBudget: InstanceBudgetPolicy;
  /**
   * The folders a press of Run may choose among, in the order a person saved
   * them; the first is the one a schedule uses. Absent or empty on every
   * workflow saved before this existed, and on one whose blocks each name
   * their own — Run then asks nothing, as it always did.
   *
   * Every entry is a folder a person saved here, so Run is a choice among
   * saved answers and never a path off the wire.
   */
  folders?: WorkflowFolder[];
}

/** One folder a workflow is saved against: a mount and a path within it. */
export interface WorkflowFolder {
  mountId: string;
  /** `""` is the mount root, as on a node. */
  folder: string;
}

/** At most this many saved folders, so the Run control stays a short list. */
export const MAX_WORKFLOW_FOLDERS = 20;

export interface Workflow extends WorkflowInput {
  id: string;
  createdAt: number;
  updatedAt: number;
}

/** What a node's template contributes to validation, and nothing else. */
export interface TemplateFacts {
  name: string;
  isolate: boolean;
}

/**
 * Everything `normalizeWorkflowInput` compares a graph against.
 *
 * Injected rather than read, for the reason `planProposal` takes its template as
 * an argument: the whole decision is then pure and testable, and the two callers
 * — the save route and the instantiation — pass the *same* knowledge read at
 * two different moments, which is what makes "saved but no longer startable" a
 * sentence rather than a surprise.
 */
export interface WorkflowKnowledge {
  templates: ReadonlyMap<string, TemplateFacts>;
  mountIds: readonly string[];
  /** Whether `settings.chatDefaultGuards` isolates — a node naming no template. */
  defaultIsolate: boolean;
  /**
   * The agent registry, for a node that names an agent.
   *
   * Injected like the templates and for the identical reason, and read through
   * the same `agentRefusal` the run door and the template door read — so a
   * saved graph, a saved template and a started run all say the same sentence
   * about an agent that has gone.
   */
  agents: AgentKnowledge;
}


export type WorkflowNormalization =
  | { ok: true; value: WorkflowInput }
  | { ok: false; error: string };

/** Node ids travel in messages and are React keys; keep them readable. */
export const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The kinds a block may be, as a value rather than three literal comparisons.
 *
 * One list, so adding a kind cannot leave the wire gate accepting a value the
 * scheduler has no branch for — the `as const` makes every reader exhaustive
 * against `WorkflowNodeKind` at the same time.
 */
const NODE_KINDS = ["run", "orchestrator", "merge", "deliver", "loop", "review", "gate"] as const satisfies readonly WorkflowNodeKind[];

const MAX_NODE_NAME = 60;

/* ------------------------------------------------------------------ */
/* Validation — pure                                                   */
/* ------------------------------------------------------------------ */


/**
 * Whether a block's guards give it a checkout of its own — so whether there is
 * ever a branch to hand over, carry on, or land.
 *
 * Read off the guards rather than off the node, because that is where the
 * answer lives: a node names a template or names none and takes
 * `chatDefaultGuards`. It holds for an orchestrator block too — the runs it
 * emits take that same guard set, which is the whole of `guardsFor`'s point.
 *
 * Asked from four places — a loop block, whose passes hand a branch along;
 * either end of a hand-over edge; and a merge block's predecessors — so it is
 * resolved once, including while a node is still being normalised and has only
 * a template id.
 */
function isolatedTemplate(
  templateId: string | null,
  known: WorkflowKnowledge,
): boolean {
  return templateId === null
    ? known.defaultIsolate
    : (known.templates.get(templateId)?.isolate ?? false);
}

/**
 * Read a workflow off the wire, refusing anything that could not be run.
 *
 * Never throws, and every refusal names something the operator can change —
 * usually by the node's own name, because a graph is read as a list of steps and
 * "node 3" is a thing only the editor can see. It is deliberately as strict as
 * instantiation: a workflow that can be saved and never started fails weeks
 * away from the form that caused it, which is the reasoning
 * `normalizeTemplateInput` already applies to the `no_terminus` pair.
 *
 * The one check it does *not* do is whether the folder is there — that is a
 * syscall, and this is pure. The save route runs `resolveWorkspaceFolder` for
 * every node immediately after this, which is the same call `createRun` will
 * make.
 */
export function normalizeWorkflowInput(
  raw: unknown,
  known: WorkflowKnowledge,
): WorkflowNormalization {
  const o = (raw ?? {}) as Record<string, unknown>;

  const notName = notStringRefusal("name", o.name);
  if (notName) return { ok: false, error: notName };
  const name = String(o.name ?? "").trim();
  if (!name) return { ok: false, error: "A workflow needs a name." };
  if (name.length > MAX_WORKFLOW_NAME) {
    return {
      ok: false,
      error: `A workflow name is at most ${MAX_WORKFLOW_NAME} characters.`,
    };
  }

  const rawGraph = (o.graph ?? {}) as Record<string, unknown>;
  const rawNodes = Array.isArray(rawGraph.nodes) ? rawGraph.nodes : [];
  const rawEdges = Array.isArray(rawGraph.edges) ? rawGraph.edges : [];

  if (rawNodes.length === 0) {
    return { ok: false, error: "A workflow needs at least one block of work." };
  }
  if (rawNodes.length > MAX_WORKFLOW_NODES) {
    return {
      ok: false,
      error:
        `A workflow runs at most ${MAX_WORKFLOW_NODES} blocks; this one has ` +
        `${rawNodes.length}. Every block becomes a run in one pass, and each ` +
        "one claims a folder.",
    };
  }

  // Before the nodes, because a block that follows the chosen folder stores
  // the first of these as its own.
  const folders = normalizeWorkflowFolders(o.folders, known);
  if (!folders.ok) return folders;

  const nodes: WorkflowNode[] = [];
  const byId = new Map<string, WorkflowNode>();

  for (const [index, entry] of rawNodes.entries()) {
    const node = normalizeNode(entry, index, known, byId, folders.value[0] ?? null);
    if (!node.ok) return node;
    nodes.push(node.value);
    byId.set(node.value.id, node.value);
  }

  // A list nothing follows is a question Run would ask whose answer moves no
  // block — a choice no process acts on — so it is refused rather than kept.
  if (folders.value.length > 0 && !nodes.some(followsTheChoice)) {
    return {
      ok: false,
      error:
        "This workflow saves folders to choose from at Run, but no block " +
        "follows the chosen folder, so the choice would move nothing. Set a " +
        "run or orchestrator block, or a loop's board condition, to follow " +
        "it, or remove the folders.",
    };
  }

  const edges: WorkflowEdge[] = [];
  const seenPairs = new Set<string>();
  /** The one dependency each node takes its branch from, by node id. */
  const branchFrom = new Map<string, string>();

  for (const [index, entry] of rawEdges.entries()) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const where = `Link ${index + 1}`;
    // Asked before the `String(…)` that reads each: `["a"]` was the block `a`
    // and `["on-finish"]` the condition `on-finish`, a link joining or
    // conditioned on something other than what was written.
    for (const field of ["from", "to", "edge"]) {
      const notString = notStringRefusal(field, e[field]);
      if (notString) return { ok: false, error: `${where}: ${notString}` };
    }
    const from = String(e.from ?? "");
    const to = String(e.to ?? "");

    const source = byId.get(from);
    const target = byId.get(to);
    if (!source || !target) {
      return {
        ok: false,
        error: `${where} joins a block that is not in this workflow.`,
      };
    }
    if (from === to) {
      return {
        ok: false,
        error: `“${source.name}” is set to start after itself.`,
      };
    }
    const pair = `${from} ${to}`;
    if (seenPairs.has(pair)) {
      return {
        ok: false,
        error:
          `“${target.name}” is set to start after “${source.name}” twice, so ` +
          "it is unclear which condition applies.",
      };
    }
    seenPairs.add(pair);

    // Required rather than defaulted, the same treatment `POST /api/runs` gives
    // it: `on-success` terminates a chain the operator meant to run regardless,
    // `on-finish` starts a run on top of a dependency that crashed, and a silent
    // default is wrong half the time in both directions.
    const edge = String(e.edge ?? "");
    if (!(WORKFLOW_EDGE_CONDITIONS as readonly string[]).includes(edge)) {
      return {
        ok: false,
        error:
          `“${target.name}” needs a condition for starting after “${source.name}”: ` +
          `${DEPENDENCY_EDGES.join(" or ")}${
            source.kind === "loop" ? `, or ${REPEATS_EDGE}` : ""
          }.`,
      };
    }
    // Offered only where it means something. Every other block starts one run
    // and has no passes to repeat anything in, so a `repeats` link out of one
    // would be a containment nothing could ever act on — accepted and inert,
    // which is exactly the defect this condition was added to remove.
    if (edge === REPEATS_EDGE && source.kind !== "loop") {
      return {
        ok: false,
        error:
          `“${source.name}” does not repeat anything, so it has no section for ` +
          `“${target.name}” to be the start of. Only a repeating block has a ` +
          "“repeats” link.",
      };
    }
    // Only a run block's ending is read as a failure. Every other kind settles
    // in words of its own — a merge that did not land everything, a turn that
    // decided nothing, a review that set work aside, a loop that stopped on a
    // pass — and which of those a fixer should start on is a decision nobody
    // has made, so it is refused by name rather than given a meaning here.
    if (edge === "on-failure" && source.kind !== "run") {
      return {
        ok: false,
        error:
          `“${target.name}” is set to start only if “${source.name}” fails, ` +
          "and only a run block's failure can start anything. Set this link " +
          "to on-success or on-finish.",
      };
    }
    // Refused rather than ignored, this file's standing treatment of a field
    // that would otherwise be read by nothing: a `repeats` link hands over no
    // branch, because it starts no run. What a pass does with the branch is
    // `stepPass`', and it is stated on the section's own links.
    if (edge === REPEATS_EDGE && e.continueBranch === true) {
      return {
        ok: false,
        error:
          `“${source.name}” repeats “${target.name}” rather than handing it a ` +
          "branch: a “repeats” link says what is inside the loop, not what " +
          "starts after it.",
      };
    }

    // `=== true` for the reason `POST /api/runs` reads it that way: it decides
    // which branch a billed agent commits to, so a string off the wire fails
    // safe.
    const continueBranch = e.continueBranch === true;
    if (continueBranch) {
      // A run block has a checkout of its own. The other three do not, each for
      // its own reason, and each is refused by name at either end rather than
      // left to the isolation test below — which would say "its guards work
      // directly in the folder", true of none of them and misleading about what
      // would have to change. An orchestrator block decides and spends nothing
      // on disk. A merge block writes into somebody else's checkout and cuts no
      // branch. A loop used to be the exception here, when its passes were runs
      // on one shared ref it could hand on; now each pass lands its own work
      // through the section's exit, so the loop block itself never holds a ref
      // — it has no template, no folder and no run, and the next thing along
      // starts from what the last pass landed rather than from a branch.
      for (const node of [source, target]) {
        if (node.kind === "run") continue;
        return {
          ok: false,
          error:
            node.kind === "orchestrator"
              ? `“${node.name}” decides what to run rather than working in a ` +
                "checkout, so it has no branch to hand over or carry on."
              : node.kind === "loop"
                ? `“${node.name}” frames the blocks it repeats and each pass ` +
                  "lands its own work, so it holds no branch to hand over or " +
                  "carry on — the last one it had was landed, and may since " +
                  "have been deleted. Start after it without carrying a branch."
                : node.kind === "review"
                  ? `“${node.name}” reviews other blocks' branches and hands on ` +
                    "the ones it approves, so it has no branch of its own to hand " +
                    "over or carry on. Start after it without carrying a branch."
                  : node.kind === "deliver"
                    ? `“${node.name}” pushes other blocks' branches and opens a ` +
                      "pull request for each, so it has no branch of its own to " +
                      "hand over or carry on."
                    : node.kind === "gate"
                      ? `“${node.name}” only waits for a person to continue and ` +
                        "works in no checkout, so it has no branch to hand over or " +
                        "carry on. Start after it without carrying a branch."
                      : `“${node.name}” lands other blocks' branches rather than ` +
                        "working in a checkout of its own, so it has no branch to " +
                        "hand over or carry on.",
        };
      }

      const rival = branchFrom.get(to);
      if (rival) {
        return {
          ok: false,
          error:
            `“${target.name}” is set to carry on two branches — ` +
            `“${byId.get(rival)!.name}”'s and “${source.name}”'s. It can only continue one.`,
        };
      }
      branchFrom.set(to, from);

      // Both ends need a checkout of their own: the predecessor has to have a
      // branch to hand over and the successor has to be able to hold one.
      // Refused here rather than left to `admitDependencies`, which would throw
      // half way through creating the graph.
      if (!isolatedTemplate(source.templateId, known)) {
        return {
          ok: false,
          error:
            `“${source.name}” has no branch to hand to “${target.name}” — its ` +
            "guards work directly in the folder rather than in a checkout of " +
            "their own.",
        };
      }
      if (!isolatedTemplate(target.templateId, known)) {
        return {
          ok: false,
          error:
            `“${target.name}” cannot carry on “${source.name}”'s branch: its ` +
            "guards work directly in the folder rather than in a checkout of " +
            "their own.",
        };
      }
    }

    edges.push({ from, to, edge: edge as WorkflowEdgeCondition, continueBranch });
  }

  // Before `graphRefusal`, because every rule it holds about a section reads
  // `bodyNodeIds` and this is what puts the drawn answer there.
  const sections = resolveSections(nodes, edges, byId);
  if (!sections.ok) return sections;

  const refusal = graphRefusal(nodes, edges, byId, known);
  if (refusal) return { ok: false, error: refusal };

  // Total, never a refusal: `null`/`""`/`0` all mean off, and a fraction guard
  // with no ceiling behind it is refused at *Run* rather than at Save. That is
  // the one place this file's "refuse at save what instantiation refuses" rule
  // does not apply, and deliberately: a ceiling is a Settings value that can be
  // typed at any time, so a graph saved without one is not unstartable — it is
  // unstartable *today*. The editor says so beside the field.
  const instanceBudget = normalizeInstanceBudget(o.instanceBudget);

  return {
    ok: true,
    value: { name, graph: { nodes, edges }, instanceBudget, folders: folders.value },
  };
}

type FoldersNormalization =
  | { ok: true; value: WorkflowFolder[] }
  | { ok: false; error: string };

/**
 * A workflow's saved folders off the wire, or the sentence refusing them.
 *
 * Absent and null are none, which is every workflow saved before the field.
 * Each entry is held to a node's own rule — a mounted workspace and a string
 * path — and whether it resolves on disk is `listedFolderRefusal`'s, the
 * syscall half, as `folderRefusal` is for a node's. A duplicate is refused:
 * two entries naming one folder would be two answers at Run that do the same.
 */
export function normalizeWorkflowFolders(
  raw: unknown,
  known: WorkflowKnowledge,
): FoldersNormalization {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, error: "folders: expected a list of folders." };
  }
  if (raw.length > MAX_WORKFLOW_FOLDERS) {
    return {
      ok: false,
      error: `A workflow saves at most ${MAX_WORKFLOW_FOLDERS} folders to choose from; this one has ${raw.length}.`,
    };
  }
  const value: WorkflowFolder[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const where = `Folder ${index + 1}`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: `${where} is not a workspace and a folder.` };
    }
    const e = entry as Record<string, unknown>;
    for (const field of ["mountId", "folder"]) {
      const notString = notStringRefusal(field, e[field]);
      if (notString) return { ok: false, error: `${where}: ${notString}` };
    }
    const mountId = String(e.mountId ?? "");
    if (!mountId) {
      return { ok: false, error: `${where} names no workspace.` };
    }
    if (!known.mountIds.includes(mountId)) {
      return {
        ok: false,
        error: `${where} names a workspace that is not mounted: ${mountId}.`,
      };
    }
    const folder = String(e.folder ?? "");
    const key = `${mountId}\u0000${folder}`;
    if (seen.has(key)) {
      return {
        ok: false,
        error: `${where} is already on the list: ${mountId}/${folder}.`,
      };
    }
    seen.add(key);
    value.push({ mountId, folder });
  }
  return { ok: true, value };
}

/** Whether two saved folders are the same one — exact, as they were saved. */
export function sameFolder(a: WorkflowFolder, b: WorkflowFolder): boolean {
  return a.mountId === b.mountId && a.folder === b.folder;
}

/** Who pressed Run, as far as choosing a folder is concerned. */
export type FolderChooser =
  | { kind: "manual"; folder?: WorkflowFolder | null }
  | { kind: "schedule" };

export type FolderChoice =
  | { ok: true; folder: WorkflowFolder | null }
  | { ok: false; reason: string };

/**
 * Which saved folder this press of Run works in, or the sentence refusing it.
 *
 * Pure and unit-tested because both ways of being wrong are silent: a folder
 * accepted off the wire that nobody saved is an agent started in a repository
 * nobody pointed it at, and a schedule reading the wrong entry is the same
 * thing with nobody present. The rule:
 *
 * - No saved folders: nothing to choose, and a choice sent anyway is refused —
 *   the workflow behaves exactly as it did before the list existed.
 * - A schedule has nobody to ask and takes the **first** saved folder. There is
 *   no field on a schedule that could name another.
 * - A person's choice must be **exactly** a saved entry. None sent is the one
 *   entry when there is one, and refused when there are several, because
 *   picking one for them is guessing which repository they meant.
 */
export function chooseFolder(
  folders: readonly WorkflowFolder[],
  by: FolderChooser,
): FolderChoice {
  const requested = by.kind === "manual" ? (by.folder ?? null) : null;
  if (folders.length === 0) {
    if (requested) {
      return {
        ok: false,
        reason:
          "This workflow saves no folders to choose from — each block names " +
          "its own — so a press of Run cannot name one.",
      };
    }
    return { ok: true, folder: null };
  }
  if (by.kind === "schedule") return { ok: true, folder: folders[0] };
  if (requested) {
    const saved = folders.find((f) => sameFolder(f, requested));
    if (!saved) {
      return {
        ok: false,
        reason:
          `${requested.mountId}/${requested.folder} is not one of the folders ` +
          "saved on this workflow. Run chooses among the folders saved on it " +
          "and nothing else; add it in the editor first.",
      };
    }
    return { ok: true, folder: saved };
  }
  if (folders.length === 1) return { ok: true, folder: folders[0] };
  return {
    ok: false,
    reason:
      `This workflow is saved against ${folders.length} folders. Choose ` +
      "which one this press of Run works in.",
  };
}

/**
 * The graph with every block that follows the chosen folder pointed at it.
 *
 * Pure. Applied once, at instantiation, to the graph the instance copies — so
 * every later reader of that copy (a deferred block, every loop pass, an
 * orchestrator block's bounds and the runs it emits) reads the choice off the
 * instance and never off the workflow, which may have been edited since. A
 * block without the flag is returned as it was, and a null choice returns the
 * graph unchanged.
 */
export function withChosenFolder(
  graph: WorkflowGraph,
  chosen: WorkflowFolder | null,
): WorkflowGraph {
  if (!chosen) return graph;
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      // A loop names no folder of its own, so only its condition moves; a
      // loop's `mountId`/`folder` are `""` and must stay so.
      if (n.stopWhenTasks?.followsChosenFolder) {
        return {
          ...n,
          stopWhenTasks: {
            ...n.stopWhenTasks,
            mountId: chosen.mountId,
            folder: chosen.folder,
          },
        };
      }
      return n.followsChosenFolder
        ? { ...n, mountId: chosen.mountId, folder: chosen.folder }
        : n;
    }),
  };
}

/**
 * Whether a choice at Run moves anything about this block: it works in the
 * chosen folder, or it is a loop counting the chosen folder's board.
 */
function followsTheChoice(node: WorkflowNode): boolean {
  return (
    node.followsChosenFolder === true ||
    node.stopWhenTasks?.followsChosenFolder === true
  );
}

/**
 * Where a folder is, as the folder claim compares folders — or why that could
 * not be worked out, which `sharedFolderRefusal` reads as sharing every folder.
 */
export type FolderIdentity =
  | { ok: true; key: ConflictKey }
  | { ok: false; error: string };

/** One block of a press of Run, and the folder it works in. */
export interface BlockFolder {
  nodeName: string;
  folder: WorkflowFolder;
  /** True when the block works in the folder that press chose. */
  followsChoice: boolean;
  identity: FolderIdentity;
}

/** A press of Run of the same workflow that still has something going. */
export interface LivePress {
  instanceId: string;
  liveRuns: number;
  liveBlocks: number;
  /** Null when the graph the press was started from cannot be read. */
  blocks: BlockFolder[] | null;
}

/** The earlier press a new one would share a folder with, and the sentence. */
export interface SharedFolder {
  instanceId: string;
  /** Its runs and blocks that have not finished. */
  liveCount: number;
  reason: string;
}

/**
 * The blocks of a graph that work in a folder, and the folder each works in.
 *
 * Every kind but the five `folderRefusal` passes over — so a node stored before
 * `kind` existed counts, as it must. An orchestrator block's own folder covers
 * the runs it emits, which are held inside it.
 */
export function workingFolders(
  graph: WorkflowGraph,
): Array<Omit<BlockFolder, "identity">> {
  return graph.nodes
    .filter(
      (n) =>
        n.kind !== "merge" &&
        n.kind !== "deliver" &&
        n.kind !== "loop" &&
        n.kind !== "review" &&
        n.kind !== "gate",
    )
    .map((n) => ({
      nodeName: n.name,
      folder: { mountId: n.mountId, folder: n.folder },
      followsChoice: n.followsChosenFolder === true,
    }));
}

function folderWords(entry: WorkflowFolder): string {
  return entry.folder ? `${entry.mountId}/${entry.folder}` : `${entry.mountId} (mount root)`;
}

function blocksShareFolder(a: BlockFolder, b: BlockFolder): boolean {
  if (!a.identity.ok || !b.identity.ok) return true;
  return overlaps(a.identity.key, b.identity.key);
}

/**
 * Why a press of Run may not start beside the presses of the same workflow
 * still going, or null when it shares no folder with any of them.
 *
 * Pure and unit-tested because this decides where unattended agents may work at
 * the same time, and both ways of being wrong are silent: refusing too little
 * puts two copies of one block in one repository — queued behind each other on
 * the folder claim, or, isolated, two agents doing one job side by side — and
 * refusing too much keeps one workflow saved against several folders from
 * standing in for one workflow per folder, which is what the list is for.
 *
 * "Share" is the folder claim's own reading, `overlaps` over `conflictKey`, and
 * not path equality, for the three reasons that claim gives: a folder holds the
 * ones under it, two mounts can be one directory, and a host can fold case. So
 * a block with its own folder, which every press of the workflow works in, is
 * shared with every other press by construction and keeps the refusal standing
 * whichever folder is chosen. A folder that cannot be placed, and a press whose
 * graph cannot be read, are read as sharing everything: this is a gate, and
 * the direction to be wrong in is the old one, one press at a time.
 *
 * `live` is newest first, so the press named is the one worth opening. A
 * block with its own folder is asked first, because when one of those is
 * shared, choosing another folder cannot help and the sentence must not say it
 * could.
 *
 * `incoming` is what would start beside them, and only the sentence reads it:
 * a pick-up brings back a press that may be the *older* one, and its folder was
 * chosen when it was pressed, so "an earlier press" and "choose a folder" are
 * both untrue of it.
 */
export function sharedFolderRefusal(
  live: readonly LivePress[],
  next: readonly BlockFolder[],
  incoming: "press" | "pick-up" = "press",
): SharedFolder | null {
  const ownFirst = [
    ...next.filter((b) => !b.followsChoice),
    ...next.filter((b) => b.followsChoice),
  ];
  for (const press of live) {
    const liveCount = press.liveRuns + press.liveBlocks;
    const going =
      `${press.liveRuns} run(s) and ${press.liveBlocks} block(s) from ` +
      `${incoming === "press" ? "an earlier" : "another"} press of Run have not finished yet`;
    const stop =
      incoming === "press"
        ? "Wait for it, or stop that run of the workflow."
        : "Wait for it, or stop that run of the workflow, before picking this one up.";
    if (press.blocks === null) {
      return {
        instanceId: press.instanceId,
        liveCount,
        reason:
          `${going}, and the graph it was started from cannot be read, so ` +
          `whether the two would work in the same folder cannot be told. ${stop}`,
      };
    }
    for (const mine of ownFirst) {
      const theirs = press.blocks.find((b) => blocksShareFolder(mine, b));
      if (!theirs) continue;
      const unplaced = !mine.identity.ok ? mine : !theirs.identity.ok ? theirs : null;
      if (unplaced && !unplaced.identity.ok) {
        return {
          instanceId: press.instanceId,
          liveCount,
          reason:
            `${going}, and “${unplaced.nodeName}”'s folder ` +
            `${folderWords(unplaced.folder)} cannot be placed ` +
            `(${unplaced.identity.error}), so whether the two would work in ` +
            `the same folder cannot be told. ${stop}`,
        };
      }
      const where = sameFolder(mine.folder, theirs.folder)
        ? `${folderWords(theirs.folder)}, where this press's “${mine.nodeName}” would work too`
        : `${folderWords(theirs.folder)}, which overlaps ${folderWords(mine.folder)}, ` +
          `where this press's “${mine.nodeName}” would work`;
      const way = !mine.followsChoice
        ? `“${mine.nodeName}” names its own folder, so every press of this ` +
          `workflow works there. ${stop}`
        : incoming === "press"
          ? "Choose a folder it is not working in, wait for it, or stop that run of the workflow."
          : stop;
      return {
        instanceId: press.instanceId,
        liveCount,
        reason:
          `${going}, and its “${theirs.nodeName}” works in ${where}. Two ` +
          `presses of one workflow run at the same time only when they share ` +
          `no folder. ${way}`,
      };
    }
  }
  return null;
}

type NodeNormalization =
  | { ok: true; value: WorkflowNode }
  | { ok: false; error: string };

/**
 * What a loop block may not be told, and what each field would have decided.
 *
 * A loop is a **region**: a frame round the blocks it repeats. It starts no
 * child of its own, so every field here describes a run that does not exist —
 * each member of the section names its own task, workspace, folder, guards and
 * agent, and there is nothing left over for the frame to hold.
 *
 * Refused **by name** rather than coerced away, which is the treatment `agentId`
 * on a merge block gets and the reason is the same one: each of these is a
 * choice the operator made that no process would ever act on, and dropping it
 * in silence is what this door exists to stop. What a loop does keep —
 * `maxPasses`, `maxLoopCostUSD`, `stopWhenTasks` — is on the other side of that
 * line: each of them bounds the repetition rather than describing a run.
 *
 * A table rather than six branches because the sentences differ only in their
 * nouns, and somebody checking that the list is complete should be able to read
 * it as a list. The keys are the **wire's**: this is what arrived, before any of
 * it has been coerced.
 */
const LOOP_IS_TOLD_NOTHING = [
  { key: "task", missing: "no task for it to do", instead: "Put it on a block inside the section." },
  { key: "templateId", missing: "no guards for it to run under", instead: "Put the template on the blocks inside the section." },
  { key: "agentId", missing: "nothing for that agent to be", instead: "Put it on a block inside the section." },
  { key: "mountId", missing: "no workspace for it to work in", instead: "Each block inside the section names its own." },
  { key: "folder", missing: "no folder for it to work in", instead: "Each block inside the section names its own." },
  { key: "promptOverride", missing: "no standing instructions for it to stand above", instead: "Put them on the blocks inside the section." },
] as const;

/**
 * What a gate may not be told, and what each field would have decided.
 *
 * `LOOP_IS_TOLD_NOTHING`'s treatment and for its reason, shorter because every
 * field has one answer: a gate holds the workflow for a person and starts
 * nothing, so a task, a template, an agent, a workspace, a folder and a prompt
 * each describe a run that will not exist. The keys are the wire's.
 */
const GATE_IS_TOLD_NOTHING = [
  { key: "task", missing: "no task for it to do" },
  { key: "templateId", missing: "no guards for it to run under" },
  { key: "agentId", missing: "nothing for that agent to be" },
  { key: "mountId", missing: "no workspace for it to work in" },
  { key: "folder", missing: "no folder for it to work in" },
  { key: "promptOverride", missing: "no standing instructions for it to stand above" },
] as const;

/** Whether a node says nothing at all about a board condition. */
function boardConditionIsOff(raw: unknown): boolean {
  return raw === null || raw === undefined || String(raw) === "";
}

/**
 * Why a cap that has to be a number when it is given is some other type, or
 * null when it is a number, a string or absent (`null` counts as absent).
 *
 * `notStringRefusal`'s counterpart for the fields read through `Number()`,
 * which reads `["3"]` as 3 and `true` as 1, and `[]` and `false` as 0 — a legal
 * count of fix rounds, a spending cap that is off, and the strictest board
 * threshold there is. A string is let through for the checks behind this one,
 * because a form field holds one; what `Number()` makes of it is theirs.
 */
function notNumberRefusal(key: string, value: unknown): string | null {
  if (
    value === undefined ||
    value === null ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return null;
  }
  return `"${key}" has to be a number when it is given; got ${jsonKind(value)}.`;
}

export type BoardConditionNormalization =
  | { ok: true; value: LoopBoardCondition | null }
  | { ok: false; error: string };

/**
 * Read a loop's board condition off the wire, or say why it could not run.
 *
 * Every refusal names the block, the neighbours' rule, and every one of them is
 * a thing the operator can change. The silent failures this stands in front of
 * are the reason it refuses rather than coerces: a terminal status, an empty
 * status list and a negative number to stop at each produce a condition that is
 * already met the first time it is asked, which is a loop that never starts a
 * run and says nothing about why. A duplicate priority is the same failure one
 * step quieter — the condition still works, and one of the two lines the
 * operator wrote can never fire.
 *
 * Exported for the validate route, which reads a loop's condition on its own so
 * the editor can show what it counts today while the rest of the graph is still
 * half-drawn. Nothing else may call it: `normalizeWorkflowInput` is the
 * authority on what a whole graph may be, and a second door into one of its
 * refusals is a rule with two places to change.
 */
export function normalizeBoardCondition(
  raw: unknown,
  nodeName: string,
  known: WorkflowKnowledge,
  firstSavedFolder: WorkflowFolder | null,
): BoardConditionNormalization {
  if (boardConditionIsOff(raw)) return { ok: true, value: null };
  if (typeof raw !== "object") {
    return {
      ok: false,
      error: `“${nodeName}” carries a board condition this app could not read.`,
    };
  }
  const o = raw as Record<string, unknown>;

  // `followsChosenFolder`'s rule on a block, one object along: asked before
  // the project below is read, because a condition that follows has its
  // `mountId`/`folder` dropped unread — whatever the editor kept on the draft
  // for turning the switch off again must not be able to refuse a save.
  const rawFollows = o.followsChosenFolder;
  if (rawFollows !== undefined && rawFollows !== null && typeof rawFollows !== "boolean") {
    return {
      ok: false,
      error: `“${nodeName}”: stopWhenTasks.followsChosenFolder is true or false; got ${JSON.stringify(rawFollows)}.`,
    };
  }
  if (rawFollows === true && !firstSavedFolder) {
    return {
      ok: false,
      error:
        `“${nodeName}” counts the board of the folder chosen at Run, but this ` +
        "workflow saves no folders to choose from. Add one, or name a project " +
        "for the condition.",
    };
  }
  const following = rawFollows === true ? firstSavedFolder : null;

  // Asked before the `String(…)` that reads each one: `["work"]` was the
  // workspace `work`, and a list-wrapped folder a project nobody named.
  for (const field of following ? [] : ["mountId", "folder"]) {
    const notString = notStringRefusal(`stopWhenTasks.${field}`, o[field]);
    if (notString) return { ok: false, error: `“${nodeName}”: ${notString}` };
  }
  const mountId = following ? following.mountId : String(o.mountId ?? "").trim();
  if (!mountId) {
    return {
      ok: false,
      error:
        `“${nodeName}” counts tasks to decide when to stop, but names no ` +
        "workspace to count them in.",
    };
  }
  if (!known.mountIds.includes(mountId)) {
    return {
      ok: false,
      error:
        `“${nodeName}” counts its tasks in a workspace that is not mounted: ` +
        `${mountId}.`,
    };
  }

  const rawStatuses = Array.isArray(o.statuses) ? o.statuses : [];
  const statuses: TaskStatusDTO[] = [];
  for (const [at, entry] of rawStatuses.entries()) {
    // `["open"]` was the status `open`, for `String()`'s reason above.
    const notString = notStringRefusal(`stopWhenTasks.statuses[${at}]`, entry);
    if (notString) return { ok: false, error: `“${nodeName}”: ${notString}` };
    const status = String(entry ?? "").trim();
    if (GROWING_TASK_STATUSES.includes(status as TaskStatusDTO)) {
      return {
        ok: false,
        error:
          `“${nodeName}” counts ${status} tasks, and that count only ever ` +
          "grows — “at most” against it holds the first time it is asked, so " +
          "the loop would stop before its first pass. Count open tasks, or " +
          "open and claimed.",
      };
    }
    if (!COUNTABLE_TASK_STATUSES.includes(status as TaskStatusDTO)) {
      return {
        ok: false,
        error:
          `“${nodeName}” counts tasks in a state the board does not have: ` +
          `${status || "(blank)"}.`,
      };
    }
    if (!statuses.includes(status as TaskStatusDTO)) {
      statuses.push(status as TaskStatusDTO);
    }
  }
  if (statuses.length === 0) {
    return {
      ok: false,
      error:
        `“${nodeName}” names no task states to count, so the count would be ` +
        "zero before any work was done and the loop would never take a pass.",
    };
  }

  // Read through `boardThresholds` rather than off `o.thresholds`, so the one
  // place that knows the single-number shape is the one every other reader
  // uses. A graph saved before thresholds existed arrives here on every
  // re-save and every validate keystroke, and must come back out meaning what
  // it meant: one threshold over the project whole. Typed back to `unknown` on
  // the way out, because what that function was handed is wire data wearing the
  // DTO's type and every field below still has to be read as if somebody had
  // typed it — which is what this function is for.
  const rawThresholds: readonly unknown[] = boardThresholds(
    o as unknown as LoopBoardCondition,
  );
  if (rawThresholds.length === 0) {
    return {
      ok: false,
      error:
        `“${nodeName}” counts tasks to decide when to stop, but names no ` +
        "number to stop at.",
    };
  }
  if (rawThresholds.length > MAX_LOOP_BOARD_THRESHOLDS) {
    return {
      ok: false,
      error:
        `“${nodeName}” may stop on at most ${MAX_LOOP_BOARD_THRESHOLDS} ` +
        `numbers; it names ${rawThresholds.length}.`,
    };
  }

  const thresholds: LoopBoardThreshold[] = [];
  for (const [at, entry] of rawThresholds.entries()) {
    const raw = (entry ?? {}) as Record<string, unknown>;
    // Missing is `any` rather than a refusal: that is what the single-number
    // shape meant, and it is the only reading a threshold with no priority on
    // it could have. A list-wrapped one is neither, and was read as the
    // priority inside it.
    const notString = notStringRefusal(
      `stopWhenTasks.thresholds[${at}].priority`,
      raw.priority,
    );
    if (notString) return { ok: false, error: `“${nodeName}”: ${notString}` };
    const priority = String(raw.priority ?? "any").trim() || "any";
    if (!THRESHOLD_PRIORITIES.includes(priority as TaskPriorityDTO)) {
      return {
        ok: false,
        error:
          `“${nodeName}” stops on a priority the board does not have: ` +
          `${priority}.`,
      };
    }
    // Refused rather than merged or last-one-wins. Two numbers for one
    // priority is an "or" between them, so the larger silently decides and the
    // other is a line the operator wrote that never fires.
    if (thresholds.some((t) => t.priority === priority)) {
      return {
        ok: false,
        error:
          `“${nodeName}” names ${priority} twice. The numbers are an “or”, so ` +
          "the lower one would never be reached.",
      };
    }

    const notNumber = notNumberRefusal(
      `stopWhenTasks.thresholds[${at}].atMost`,
      raw.atMost,
    );
    if (notNumber) return { ok: false, error: `“${nodeName}”: ${notNumber}` };

    // Missing and blank are refused rather than coerced, which is the one place
    // this field parts company with the spending cap above: `Number(null)` and
    // `Number("")` are both 0, and 0 here is the *strictest* legal setting —
    // "until there are none left" — so the usual "blank means off" reading would
    // turn a cleared field into a condition nobody chose.
    const atMost =
      raw.atMost === null ||
      raw.atMost === undefined ||
      String(raw.atMost).trim() === ""
        ? Number.NaN
        : Number(raw.atMost);
    if (!Number.isInteger(atMost) || atMost < 0) {
      return {
        ok: false,
        error:
          `“${nodeName}” needs a whole number of tasks to stop at, and not a ` +
          "negative one. Zero is “until there are none left”.",
      };
    }

    thresholds.push({ priority: priority as TaskPriorityDTO | "any", atMost });
  }

  return {
    ok: true,
    // The folder is kept as given, mount root and all, for the reason a node's
    // own folder is: `""` is the mount root and a real selection rather than a
    // missing one. The reader canonicalises it before it counts.
    value: {
      mountId,
      folder: following ? following.folder : String(o.folder ?? ""),
      // Absent rather than false when off, so a graph saved before the field
      // existed goes back exactly as it was read.
      ...(following ? { followsChosenFolder: true } : {}),
      // `=== true` rather than truthiness, so a condition saved before this
      // field existed reads as the board's own grouping — one folder is one
      // project — instead of picking up a wider count nobody asked for.
      includeSubfolders: o.includeSubfolders === true,
      statuses,
      thresholds,
    },
  };
}

/**
 * Read one block off the wire, refusing anything that could not be run.
 *
 * Every refusal names the block — by its own name once it has one, and by its
 * position until then — because a graph is read as a list of steps and "block
 * 3" is a thing only the editor can see.
 *
 * `taken` is the ids already accepted from this same graph, and it is the one
 * thing here that is not about a single block: two blocks sharing an id makes
 * every edge naming it name both, and that can only be seen from outside.
 */
function normalizeNode(
  entry: unknown,
  index: number,
  known: WorkflowKnowledge,
  taken: ReadonlyMap<string, WorkflowNode>,
  firstSavedFolder: WorkflowFolder | null,
): NodeNormalization {
  const n = (entry ?? {}) as Record<string, unknown>;
  const position = `Block ${index + 1}`;
    // Asked before the `String(…)` that reads it: `["a"]` was the id `a`. The
    // chat's door asks the same of `id`, `kind` and `name` first, but the
    // workflow routes (create, update, validate) read a graph through here with
    // nothing in front of it.
    const notId = notStringRefusal("id", n.id);
    if (notId) return { ok: false, error: `${position}: ${notId}` };
    const id = String(n.id ?? "");
    if (!NODE_ID.test(id)) {
      return {
        ok: false,
        error: `${position} has no usable id. An id is 1–64 letters, digits, hyphens or underscores.`,
      };
    }
    if (taken.has(id)) {
      return {
        ok: false,
        error: `Two blocks share the id “${id}”, so an edge naming it names both.`,
      };
    }

    const notName = notStringRefusal("name", n.name);
    if (notName) return { ok: false, error: `${position}: ${notName}` };
    const nodeName = String(n.name ?? "").trim();
    if (!nodeName) {
      return { ok: false, error: `${position} needs a name.` };
    }
    if (nodeName.length > MAX_NODE_NAME) {
      return {
        ok: false,
        error: `A block name is at most ${MAX_NODE_NAME} characters (“${nodeName.slice(0, 20)}…”).`,
      };
    }

    // Absent is `run`, and it has to be: every graph saved before orchestrator
    // blocks existed says nothing here, and the other reading would turn a saved
    // workflow into one that starts agents nobody wrote.
    const notKind = notStringRefusal("kind", n.kind);
    if (notKind) return { ok: false, error: `“${nodeName}”: ${notKind}` };
    const rawKind = String(n.kind ?? "run");
    if (!(NODE_KINDS as readonly string[]).includes(rawKind)) {
      return {
        ok: false,
        error: `“${nodeName}” is not a kind of block this app has: ${rawKind}.`,
      };
    }
    const kind = rawKind as WorkflowNodeKind;

    // A loop is told nothing, and every field it is told anyway is refused by
    // name. See `LOOP_IS_TOLD_NOTHING` for why each of them describes a run a
    // loop block does not have.
    if (kind === "loop") {
      // Type first: `String([])` is `""`, so an empty list passed as nothing
      // told, and an object was refused in the sentence for a loop that had
      // been given a task.
      for (const field of LOOP_IS_TOLD_NOTHING) {
        const notString = notStringRefusal(field.key, n[field.key]);
        if (notString) return { ok: false, error: `“${nodeName}”: ${notString}` };
      }
      const told = LOOP_IS_TOLD_NOTHING.find(
        (field) => String(n[field.key] ?? "").trim() !== "",
      );
      if (told) {
        return {
          ok: false,
          error:
            `“${nodeName}” frames the blocks it repeats and starts no run of ` +
            `its own, so there is ${told.missing}. ${told.instead}`,
        };
      }
    }

    // A gate is told nothing either, and for the loop's reason: it waits for a
    // person and starts no run, so each of these describes a run it does not
    // have. Refused by name rather than coerced away, because a template or an
    // agent chosen for a block that never starts anything is a choice no
    // process will act on, and this is the door built to answer one out loud.
    if (kind === "gate") {
      for (const field of GATE_IS_TOLD_NOTHING) {
        const notString = notStringRefusal(field.key, n[field.key]);
        if (notString) return { ok: false, error: `“${nodeName}”: ${notString}` };
      }
      const told = GATE_IS_TOLD_NOTHING.find(
        (field) => String(n[field.key] ?? "").trim() !== "",
      );
      if (told) {
        return {
          ok: false,
          error:
            `“${nodeName}” waits for a person to continue and starts no run of ` +
            `its own, so there is ${told.missing}. Put it on the block that does the work.`,
        };
      }
    }

    // The two kinds that start no child of their own hold none of the fields
    // that describe one. They get there differently — a merge block has these
    // coerced away, a loop has them refused by name above — and past this point
    // the two are the same block: nothing to run, and nowhere to run it.
    // A review block is the third: its reviews and its fix runs are this app's,
    // started on branches the blocks in front of it cut, and it names no
    // workspace, template, task or agent of its own.
    const startsNoRun =
      kind === "merge" ||
      kind === "deliver" ||
      kind === "loop" ||
      kind === "review" ||
      kind === "gate";

    // A merge block is told nothing. What it lands is whatever the blocks in
    // front of it left on a branch, and where each branch belongs was recorded
    // when its run cut it — so there is no task here for a person to write and
    // an empty one is the right answer rather than a missing one.
    //
    // A loop is not asked either, and it is the one kind that arrives here with
    // the question already settled twice over: a task it carried was refused by
    // name above, and a task it did not carry was never owed, because every run
    // of a pass is a *member's* and each member carries its own. Requiring one
    // here is what made the single block whose text is sent to no agent the
    // single block that could not be saved without writing some, and the only
    // way past that refusal was words nothing would read.
    // Asked only where the task is read, `promptOverride`'s rule below: `{}`
    // was a block whose every run was briefed with "[object Object]".
    const notTask = startsNoRun ? null : notStringRefusal("task", n.task);
    if (notTask) return { ok: false, error: `“${nodeName}”: ${notTask}` };
    const task = startsNoRun ? "" : String(n.task ?? "").trim();
    if (!startsNoRun && !task) {
      return {
        ok: false,
        error:
          kind === "orchestrator"
            ? `“${nodeName}” has nothing to decide. An orchestrator block with no brief is a billed turn that starts whatever it feels like.`
            : `“${nodeName}” has no task. A block with nothing to do is a run that spends a work cycle finding that out.`,
      };
    }

    // The fan-out cap: required on an orchestrator block, refused on a run one.
    //
    // Refused at *save* rather than at Run, and this is the sharpest case of
    // that rule in the file. Every other block puts one agent on the machine,
    // written out by a person. This one starts as many as it decides to, with
    // nothing between the decision and the spawn — so the number a person
    // agreed to has to exist before the graph can be saved at all, exactly as
    // the run loop refuses a policy with no monotone terminus.
    let fanOut: number | null = null;
    if (kind === "orchestrator") {
      const notNumber = notNumberRefusal("fanOut", n.fanOut);
      if (notNumber) return { ok: false, error: `“${nodeName}”: ${notNumber}` };
      const raw = Number(n.fanOut);
      if (!Number.isInteger(raw) || raw < 1) {
        return {
          ok: false,
          error:
            `“${nodeName}” needs a limit on how many runs it may start. It is ` +
            "the only block whose runs start with no approval, so a missing " +
            "limit is an unbounded number of agents from one press of Run.",
        };
      }
      if (raw > MAX_FAN_OUT) {
        return {
          ok: false,
          error:
            `“${nodeName}” may start at most ${MAX_FAN_OUT} runs; it is set to ` +
            `${raw}.`,
        };
      }
      fanOut = raw;
    }

    // How many times a failed deciding turn is started again, on an orchestrator
    // block and nowhere else. Absent and null are 0, which is what every graph
    // saved before the field says. Only a whole JS number is accepted: this
    // authorises billed turns, so `true` (which `Number` reads as 1) and a
    // numeric string must fail loudly rather than quietly become a setting.
    let turnRetries: number | null = null;
    if (kind === "orchestrator") {
      const given: unknown = n.turnRetries ?? 0;
      if (
        typeof given !== "number" ||
        !Number.isInteger(given) ||
        given < 0 ||
        given > MAX_TURN_RETRIES
      ) {
        return {
          ok: false,
          error:
            `“${nodeName}” may start a failed deciding turn again 0 to ` +
            `${MAX_TURN_RETRIES} times, as a whole number; it is set to ` +
            `${typeof given === "number" ? given : jsonKind(given)}.`,
        };
      }
      turnRetries = given;
    }

    // How a merge block lands, and whether it may pay for a resolution.
    //
    // The strategy is required rather than defaulted to `settings.landStrategy`
    // — see `WorkflowNode.mergeStrategy` — and the editor pre-fills the picker
    // from that setting so the graph records what the operator was shown.
    // `=== true` for the reason `continueBranch` is read that way: it authorises
    // billed spend, so a string off the wire must fail safe.
    let mergeStrategy: LandStrategy | null = null;
    let mergeAutoResolve = false;
    if (kind === "merge") {
      // `["squash"]` was the strategy inside the list.
      const notStrategy = notStringRefusal("mergeStrategy", n.mergeStrategy);
      if (notStrategy) return { ok: false, error: `“${nodeName}”: ${notStrategy}` };
      const raw = String(n.mergeStrategy ?? "");
      if (raw !== "merge" && raw !== "squash") {
        return {
          ok: false,
          error: `“${nodeName}” needs to say how it lands a branch: merge or squash.`,
        };
      }
      mergeStrategy = raw;
      mergeAutoResolve = n.mergeAutoResolve === true;
    }

    // A review block's fix rounds: required, for the fan-out cap's reason —
    // every round is a billed fix run and a billed review per branch — and
    // small, because a branch a frontier model rejects three times is one the
    // local model is not going to get past it.
    let fixRounds: number | null = null;
    if (kind === "review") {
      // `true` was one billed fix round per rejected branch.
      const notNumber = notNumberRefusal("fixRounds", n.fixRounds);
      if (notNumber) return { ok: false, error: `“${nodeName}”: ${notNumber}` };
      const raw = Number(n.fixRounds ?? 0);
      if (!Number.isInteger(raw) || raw < 0 || raw > MAX_REVIEW_FIX_ROUNDS) {
        return {
          ok: false,
          error:
            `“${nodeName}” may send a rejected branch back for 0 to ` +
            `${MAX_REVIEW_FIX_ROUNDS} fix rounds; it is set to ${String(n.fixRounds)}.`,
        };
      }
      fixRounds = raw;
    }

    // Where a review block's verdict comes from, read on a review block and
    // dropped unread on every other kind, `promptOverride`'s rule.
    let verdictSource: ReviewVerdictSource | null = null;
    if (kind === "review") {
      const read = normalizeVerdictSource(n.verdictSource, nodeName);
      if (!read.ok) return read;
      verdictSource = read.value;
      // Refused rather than coerced to 0: rounds the operator set are billed
      // runs they expect, and a status verdict has no review for one to answer.
      // Nor does a command's, yet: a fix run briefed with its failing output is
      // a later decision, and rounds saved now would be rounds nothing starts.
      if (verdictSource.kind !== "model" && fixRounds !== 0) {
        return {
          ok: false,
          error:
            (verdictSource.kind === "status"
              ? `“${nodeName}” judges each branch by how its run ended, so there is ` +
                "no review for a fix round to answer."
              : `“${nodeName}” judges each branch by its verify command, and a ` +
                "branch that fails it is set aside rather than sent back for a fix.") +
            " Set its fix rounds to 0, or have a frontier model review the branches.",
        };
      }
    }

    // Which CLI does the work, on the two kinds whose work is runs. Refused by
    // name anywhere else, on `agentId`'s grounds below: a provider named on a
    // block that starts no run is a choice no process will ever act on. Typed
    // on every kind for that reason: every kind reads it, if only to refuse it.
    const notProvider = notStringRefusal("provider", n.provider);
    if (notProvider) return { ok: false, error: `“${nodeName}”: ${notProvider}` };
    const rawProvider =
      n.provider === null || n.provider === undefined ? "" : String(n.provider).trim();
    if (rawProvider && !(RUN_PROVIDERS as readonly string[]).includes(rawProvider)) {
      return {
        ok: false,
        error: `“${nodeName}” names a provider this app has no adapter for: ${rawProvider}.`,
      };
    }
    const provider = (rawProvider || null) as RunProviderDTO | null;
    if (provider !== null && kind !== "run" && kind !== "orchestrator") {
      return {
        ok: false,
        error:
          `“${nodeName}” starts no run of its own, so there is nothing for a ` +
          "provider to run. Put it on the block that does the work.",
      };
    }

    // The pass cap and the loop's own spending cap, on a loop block and nowhere
    // else. The first is required for `fanOut`'s reason one level along: this is
    // the block that manufactures its own next unit of work, so without a
    // quantity that only goes up it has no terminus at all — the run loop's own
    // rule, and the reason `maxIterations` may only be null alongside
    // `maxDurationMinutes`. The second is optional because the first already
    // terminates it, and `null`/`""`/`0` all mean off, this app's standing rule
    // for a number that bounds spending.
    let maxPasses: number | null = null;
    let maxLoopCostUSD: number | null = null;
    let stopWhenTasks: LoopBoardCondition | null = null;
    let bodyNodeIds: string[] = [];
    if (kind === "loop") {
      const notPasses = notNumberRefusal("maxPasses", n.maxPasses);
      if (notPasses) return { ok: false, error: `“${nodeName}”: ${notPasses}` };
      const raw = Number(n.maxPasses);
      if (!Number.isInteger(raw) || raw < 1) {
        return {
          ok: false,
          error:
            `“${nodeName}” needs a limit on how many times it may repeat. A ` +
            "loop decides for itself whether to start another run, so without " +
            "one it has nothing that has to end.",
        };
      }
      if (raw > MAX_LOOP_PASSES) {
        return {
          ok: false,
          error:
            `“${nodeName}” may take at most ${MAX_LOOP_PASSES} passes; it is ` +
            `set to ${raw}.`,
        };
      }
      maxPasses = raw;

      // Before the "off" readings below, because an object is `NaN` and `NaN`
      // is off: a cap the caller tried to set would be dropped without a word.
      const notCost = notNumberRefusal("maxLoopCostUSD", n.maxLoopCostUSD);
      if (notCost) return { ok: false, error: `“${nodeName}”: ${notCost}` };
      const cost = Number(n.maxLoopCostUSD);
      maxLoopCostUSD =
        n.maxLoopCostUSD === null ||
        n.maxLoopCostUSD === undefined ||
        String(n.maxLoopCostUSD) === "" ||
        !Number.isFinite(cost) ||
        cost <= 0
          ? null
          : cost;

      const board = normalizeBoardCondition(
        n.stopWhenTasks,
        nodeName,
        known,
        firstSavedFolder,
      );
      if (!board.ok) return board;
      stopWhenTasks = board.value;

      // Absent, null and a non-array all read as "this loop repeats its own
      // task", which is what every graph saved before the field existed says.
      // Nothing more is decided here: whether these ids name blocks, and
      // whether the blocks they name can be a body, is `graphRefusal`'s — once
      // each is an id: `["a"]` was the block `a`.
      const rawBody: unknown[] = Array.isArray(n.bodyNodeIds) ? n.bodyNodeIds : [];
      for (const [at, entry] of rawBody.entries()) {
        const notString = notStringRefusal(`bodyNodeIds[${at}]`, entry);
        if (notString) return { ok: false, error: `“${nodeName}”: ${notString}` };
      }
      bodyNodeIds = rawBody.map((entry) => String(entry ?? "").trim());
    } else if (Array.isArray(n.bodyNodeIds) && n.bodyNodeIds.length > 0) {
      // Refused rather than dropped, on `stopWhenTasks`' grounds one field
      // over: a body is a section of the graph the operator said to repeat, and
      // a block with no passes has nothing to repeat it in — so discarding it
      // would leave somebody watching for blocks to run again and again that
      // this app had quietly decided to run once.
      return {
        ok: false,
        error:
          `“${nodeName}” names blocks to repeat, and only a repeating block ` +
          "has passes to repeat them in. Make it a loop, or clear the list.",
      };
    }
    if (kind !== "loop" && !boardConditionIsOff(n.stopWhenTasks)) {
      // Refused rather than dropped, which is where this parts company with the
      // two caps above it. A cap on a run block is a number nothing reads; a
      // board condition is an *ending* the operator wrote down, and a block with
      // no passes has nothing for it to end — so silently discarding it would
      // leave somebody waiting for a workflow to stop on a backlog nothing was
      // ever going to count. `agentId` on a merge block is refused on the same
      // grounds, and the editor sends this field only for a loop for that
      // reason.
      return {
        ok: false,
        error:
          `“${nodeName}” stops on a count of tasks, and only a repeating ` +
          "block has passes to stop. Make it a loop, or drop the condition.",
      };
    }

    // Null is "no template — use the guards in Settings", which is a real
    // answer rather than a missing one. Anything else has to exist now: a
    // graph naming a template nobody can find is one that can be saved and
    // never started.
    //
    // A merge block names none and can name none: guards decide what an agent
    // may do, this block starts no agent, and the one child it can cause —
    // `resolveConflicts`' — runs under that function's own fixed mode. A loop
    // names none for the same reason, so `guardsFor` is never asked about one;
    // the guards a pass runs under are each member's own.
    //
    // Typed only where it is read, `promptOverride`'s rule, and the same for
    // the workspace and folder below: on a block that starts no run all three
    // are dropped unread, and a loop's were asked above.
    //
    // A block that follows the folder chosen at Run has its workspace and
    // folder dropped unread too, and stores the first saved folder instead —
    // see `WorkflowNode.followsChosenFolder` for why a concrete one is stored.
    const rawFollows = n.followsChosenFolder;
    if (rawFollows !== undefined && rawFollows !== null && typeof rawFollows !== "boolean") {
      return {
        ok: false,
        error: `“${nodeName}”: followsChosenFolder is true or false; got ${JSON.stringify(rawFollows)}.`,
      };
    }
    const followsChosenFolder = rawFollows === true;
    if (followsChosenFolder && kind !== "run" && kind !== "orchestrator") {
      return {
        ok: false,
        error:
          `“${nodeName}” is a ${kind} block, which names no folder of its ` +
          "own, so it has none for the folder chosen at Run to replace.",
      };
    }
    if (followsChosenFolder && !firstSavedFolder) {
      return {
        ok: false,
        error:
          `“${nodeName}” follows the folder chosen at Run, but this workflow ` +
          "saves no folders to choose from. Add one, or give the block a " +
          "folder of its own.",
      };
    }
    const following = followsChosenFolder ? firstSavedFolder : null;
    for (const field of ["templateId", "mountId", "folder"]) {
      const unread = startsNoRun || (following !== null && field !== "templateId");
      const notString = unread ? null : notStringRefusal(field, n[field]);
      if (notString) return { ok: false, error: `“${nodeName}”: ${notString}` };
    }
    const templateId =
      startsNoRun ||
      n.templateId === null ||
      n.templateId === undefined ||
      String(n.templateId) === ""
        ? null
        : String(n.templateId);
    if (templateId !== null && !known.templates.has(templateId)) {
      return {
        ok: false,
        error:
          `“${nodeName}” names a template that no longer exists, so there are ` +
          "no guards to start it under. Pick another, or none, which uses the " +
          "guards in Settings.",
      };
    }

    // A merge block works in whichever repository each branch came from, so it
    // names no workspace at all rather than one it would never read. Requiring
    // one would make a block refusable — at save and at every Run — over a mount
    // that decides nothing about it. A loop names none for the same shape of
    // reason: its members each name their own, and the frame round them works
    // nowhere.
    const mountId = startsNoRun
      ? ""
      : following
        ? following.mountId
        : String(n.mountId ?? "");
    if (!startsNoRun) {
      if (!mountId) {
        return {
          ok: false,
          error: `“${nodeName}” names no workspace, so there is nowhere to start it.`,
        };
      }
      if (!known.mountIds.includes(mountId)) {
        return {
          ok: false,
          error: `“${nodeName}” names a workspace that is not mounted: ${mountId}.`,
        };
      }
    }

    // Only on a block that starts a run: on the two kinds that start none the
    // field is dropped unread, so there is no prompt for a wrong type to become.
    const notPrompt = startsNoRun ? null : notStringRefusal("promptOverride", n.promptOverride);
    if (notPrompt) return { ok: false, error: `“${nodeName}”: ${notPrompt}` };
    const promptOverride = startsNoRun
      ? ""
      : String(n.promptOverride ?? "").trim();

    // The agent this block's own child is started as.
    //
    // Refused rather than dropped on a merge block, and that is the one place
    // this loop's habit of coercing a field the kind does not hold stops. A
    // template on a merge block decides nothing, because no agent runs under
    // it; an agent named on a block that spawns no child at all is a choice the
    // operator made that no process will ever act on — which is the exact shape
    // `agents.ts` exists to refuse, and dropping it here would be this app
    // discarding it in silence at the one door built to end that. The sentence
    // changed shape with the flag and the refusal did not: under `--agents` the
    // objection was that there was nobody to hand the subtask to, and under
    // `--agent` it is that there is no child for the agent to *be*. Both ends
    // of a `continueBranch` edge are refused by name below on the same grounds.
    //
    // Typed on the kinds that read it — the two whose child is started as it,
    // and the two that refuse it by name — since `["a-rev"]` was the agent
    // inside the list. A loop's was asked above.
    const readsAgent =
      kind === "run" || kind === "orchestrator" || kind === "merge" || kind === "review";
    const notAgent = readsAgent ? notStringRefusal("agentId", n.agentId) : null;
    if (notAgent) return { ok: false, error: `“${nodeName}”: ${notAgent}` };
    const namedAgent =
      n.agentId === null || n.agentId === undefined || String(n.agentId).trim() === ""
        ? null
        : String(n.agentId).trim();
    if (namedAgent !== null && (kind === "merge" || kind === "review")) {
      return {
        ok: false,
        error:
          kind === "merge"
            ? `“${nodeName}” lands the branches in front of it and starts no agent ` +
              "of its own, so there is nothing for that agent to be. Remove it, or " +
              "put it on the block that does the work."
            : `“${nodeName}” ${
                verdictSource?.kind === "status"
                  ? "judges the branches in front of it by how their runs ended"
                  : verdictSource?.kind === "command"
                    ? "judges the branches in front of it by its verify command"
                    : "reviews the branches in front of it with a frontier model this app chooses"
              }, so there is nothing for that agent to be. ` +
              "Remove it, or put it on the block that does the work.",
      };
    }
    if (namedAgent !== null && kind === "deliver") {
      return {
        ok: false,
        error:
          `“${nodeName}” pushes the branches in front of it and starts no agent ` +
          "of its own, so there is nothing for that agent to be. Remove it, or " +
          "put it on the block that does the work.",
      };
    }
    // A saved agent's prompt reaches Claude Code's `--agent` and nothing else,
    // so a Codex run block "as the reviewer" would be a run that is not the
    // reviewer — the silent drop the agent door refuses everywhere.
    if (namedAgent !== null && kind === "run" && provider === "codex") {
      return {
        ok: false,
        error:
          `“${nodeName}” runs on Codex, which a saved agent's prompt does not ` +
          "reach. Remove the agent, or the provider.",
      };
    }
    const agentId = startsNoRun ? null : namedAgent;
    if (agentId !== null) {
      // The same wording the run door and the template door give, prefixed with
      // the block — a graph is read as a list of steps, so every refusal here
      // names the one it is about.
      const refusal = agentRefusal(agentId, known.agents);
      if (refusal) return { ok: false, error: `“${nodeName}”: ${refusal}` };
    }

  return {
    ok: true,
    value: {
          id,
          name: nodeName,
          kind,
          templateId,
          agentId,
          mountId,
          // The empty string is the mount root — the one selection that blocks
          // every other run in the tree — so it is kept rather than collapsed into
          // "no folder", exactly as a template's is.
          folder: startsNoRun
            ? ""
            : following
              ? following.folder
              : String(n.folder ?? ""),
          // Absent rather than false when off, so a graph saved before the
          // field is stored back byte for byte.
          ...(following ? { followsChosenFolder: true } : {}),
          task,
          promptOverride: promptOverride || null,
          fanOut,
          turnRetries,
          mergeStrategy,
          mergeAutoResolve,
          maxPasses,
          maxLoopCostUSD,
          stopWhenTasks,
          bodyNodeIds,
          provider,
          fixRounds,
          verdictSource,
    },
  };
}

/**
 * A review block's verdict source off the wire, or the sentence refusing it.
 *
 * Absent and null are `model`, and have to be: every review block saved before
 * the field existed was saved to pay for a frontier review, and any other
 * reading would hand on branches nobody looked at. A bare word is refused
 * rather than read as the kind it names, so the one shape on the wire is the
 * one a source with settings of its own needs.
 *
 * A `command` is held to `parseVerifyCommand`, the rule `landVerifyCommand` is
 * held to and the one `runVerify` applies again before it spawns: argv split
 * on whitespace, and every shell metacharacter refused rather than escaped. It
 * is refused here, at the save, because a command that could not run would
 * otherwise be found a pass in, as every branch of it set aside. Kept as typed
 * rather than as the argv, so what the person reads back is what they wrote.
 */
function normalizeVerdictSource(
  raw: unknown,
  nodeName: string,
): { ok: true; value: ReviewVerdictSource } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, value: { kind: "model" } };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      error:
        `“${nodeName}”: "verdictSource" has to be an object when it is given; ` +
        `got ${jsonKind(raw)}.`,
    };
  }
  const o = raw as Record<string, unknown>;
  const notString = notStringRefusal("verdictSource.kind", o.kind);
  if (notString) return { ok: false, error: `“${nodeName}”: ${notString}` };
  const kind = String(o.kind ?? "").trim();
  if (!(REVIEW_VERDICT_KINDS as readonly string[]).includes(kind)) {
    return {
      ok: false,
      error:
        `“${nodeName}” takes its verdict from a source this app does not ` +
        `have: ${kind || "(blank)"}. It is ${REVIEW_VERDICT_KINDS.join(" or ")}.`,
    };
  }
  if (kind === "command") {
    const notCommandString = notStringRefusal("verdictSource.command", o.command);
    if (notCommandString) return { ok: false, error: `“${nodeName}”: ${notCommandString}` };
    const command = String(o.command ?? "").trim();
    const parsed = parseVerifyCommand(command);
    if (!parsed.ok) {
      return {
        ok: false,
        error: `“${nodeName}” judges each branch by a verify command, and ${parsed.reason}.`,
      };
    }
    return { ok: true, value: { kind: "command", command } };
  }
  return { ok: true, value: kind === "status" ? { kind: "status" } : { kind: "model" } };
}

/**
 * Why a graph a model wrote may not be saved because a review block in it runs
 * a verify command, or null when none does.
 *
 * The command is a program this app spawns in every branch's checkout, with no
 * approval at the moment it runs: the approval is the save. So it is a person's
 * to write, in the workflow editor, and never a model's — asked of
 * `propose_workflow`'s graph and again of the proposal as it is approved,
 * because a card reads "no agent" for a review block and a person approving it
 * would not be shown a command at all. Asked of the normalized graph rather
 * than of the model's text, so no spelling `normalizeVerdictSource` accepts can
 * slip past it.
 */
export function commandVerdictRefusal(graph: WorkflowGraph): string | null {
  const node = graph.nodes.find(
    (n) => n.kind === "review" && n.verdictSource?.kind === "command",
  );
  if (!node) return null;
  return (
    `“${node.name}” judges branches by a verify command, and only a person may ` +
    "save one: it is a program this app runs in every branch's checkout. Give " +
    "the review a frontier-model or run-status verdict, and tell the operator " +
    "to set the command in the workflow editor if they want one."
  );
}

/**
 * The blocks one loop repeats, in the order its pass will create them.
 *
 * Empty for a loop that repeats its own task, which is every loop saved before
 * `bodyNodeIds` existed — so a caller that walks this list gets today's
 * behaviour with no branch of its own for the compatible case.
 *
 * Ordered by the body's **own** edges through the same `topologicalOrder` the
 * instantiation uses, so "the order the body's edges give" has one definition
 * and the same tie-break. The order is a topological one rather than a total
 * one, because a section may fork: what it guarantees is that a member comes
 * after everything the section's links put in front of it, and `stepPass` needs
 * exactly that much — the entry sorts first, which is what it reads off this,
 * and it releases the rest through `planInstanceStep` rather than in order.
 */
export function loopBody(
  graph: WorkflowGraph,
  loop: WorkflowNode,
): WorkflowNode[] {
  const ids = bodyOf(loop);
  if (ids.length === 0) return [];
  const members = new Set(ids);
  const nodes = graph.nodes.filter((n) => members.has(n.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const { order } = topologicalOrder({
    nodes,
    edges: graph.edges.filter(
      (e) => members.has(e.from) && members.has(e.to),
    ),
  });
  return order.map((id) => byId.get(id)!);
}

/**
 * Every block that is inside some loop's body, and which loop claims it.
 *
 * One walk shared by the refusal below and by the two runtime readers, because
 * "is this node a body member" is asked in three places and a second answer
 * would be a node instantiated *and* repeated — a run started once by the graph
 * and again by every pass, on the same folder.
 */
export function loopBodyOwners(
  graph: WorkflowGraph,
): Map<string, WorkflowNode> {
  const owner = new Map<string, WorkflowNode>();
  for (const node of graph.nodes) {
    if (node.kind !== "loop") continue;
    for (const memberId of bodyOf(node)) {
      if (!owner.has(memberId)) owner.set(memberId, node);
    }
  }
  return owner;
}

/**
 * One loop's body, from a node that may predate the field.
 *
 * **Every read of `bodyNodeIds` outside `normalizeNode` goes through here**, and
 * that is the compatibility rule of the whole feature rather than defensive
 * habit: an instance carries a *copy* of its graph taken when it was created, so
 * a loop that has been repeating since before this field existed is read back
 * from a blob with no `bodyNodeIds` at all — `undefined`, which a `for…of`
 * throws on and `.length` reads as a crash in the middle of an advance. The
 * trap `advanceLoop` records one field over for `maxPasses`, and it fails the
 * same way: nothing typechecks it away, because the type says the field is
 * there and the blob was written by an older build that agreed.
 *
 * A node carrying anything but an array reads as an empty body, which is what a
 * loop has always meant.
 */
function bodyOf(loop: WorkflowNode): readonly string[] {
  return Array.isArray(loop.bodyNodeIds) ? loop.bodyNodeIds : [];
}

/**
 * What a loop's `repeats` link makes a section of: its target, and everything
 * linked after that target along ordinary links.
 *
 * The walk skips `repeats` links, so a second loop drawn *inside* a section
 * contributes its own members to its own section and not to this one — the
 * nesting is then refused by name in `loopBodyRefusal` rather than silently
 * flattened into one body.
 *
 * The loop itself is never a member, however the links run. A member linked
 * back to its own loop is a mistake with its own sentence in
 * `loopBodyRefusal`'s boundary rule, and swallowing the loop into its own body
 * here would answer it with a different one.
 *
 * Bounded by the node count rather than run to a fixed point, for
 * `longestPathRank`'s reason one file over: the operator can draw a cycle, this
 * runs before the cycle check, and a walk that did not terminate would hang the
 * request rather than refuse the graph.
 */
function sectionFrom(
  loopId: string,
  firstId: string,
  edges: readonly WorkflowEdge[],
): string[] {
  const members: string[] = [];
  const seen = new Set<string>([loopId]);
  const queue = [firstId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    members.push(id);
    for (const e of edges) {
      if (e.from !== id || e.edge === REPEATS_EDGE) continue;
      queue.push(e.to);
    }
  }
  return members;
}

/**
 * Put what each loop's `repeats` link says on the loop, and refuse a graph that
 * says it twice.
 *
 * **The section is derived from a link and never kept as a second list.** What
 * the operator draws is the whole statement: the `repeats` link says where the
 * section starts, the section's own links say what is in it and in what order.
 * `bodyNodeIds` stays exactly what it was — the field every rule, every runtime
 * reader and every saved graph is already written against — so this is a change
 * to the door and not to the machinery behind it.
 *
 * **The link is now required.** A loop with none is refused, and that is what
 * ended the body-less loop — the mode where a loop held a task and repeated it.
 * A region frames work; it does not do any, so a loop that names no section has
 * nothing to repeat at all. The list alone no longer states one either: it is a
 * cross-check on what the links say and never a second way of saying it.
 *
 * A graph that carries both and disagrees is refused by *name* rather than
 * resolved in favour of one: a caller who sent both meant something by each, and
 * dropping half of it in silence is what this app's doors exist to stop. The
 * editor sends both and derives the list from the link, so it cannot produce the
 * disagreement.
 */
function resolveSections(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  byId: ReadonlyMap<string, WorkflowNode>,
): { ok: true } | { ok: false; error: string } {
  const named = (id: string) => byId.get(id)?.name ?? id;

  for (const loop of nodes) {
    if (loop.kind !== "loop") continue;
    const doors = edges.filter(
      (e) => e.from === loop.id && e.edge === REPEATS_EDGE,
    );
    if (doors.length > 1) {
      // Both targets named, because the operator has to choose between them and
      // a refusal that says only "two" leaves them hunting for the second.
      return {
        ok: false,
        error:
          `“${loop.name}” is linked to two sections — “${named(doors[0].to)}” ` +
          `and “${named(doors[1].to)}”. A loop repeats one section, so it has ` +
          "one “repeats” link: the one to the block its pass starts at.",
      };
    }
    if (doors.length === 0) {
      // Two sentences, because there are two ways to arrive here and only one
      // of them is "you have not drawn it yet". A caller that sent the list on
      // its own said what it wanted and is told which half is missing; an
      // operator with a bare loop block is told what a loop is for.
      return {
        ok: false,
        error:
          bodyOf(loop).length > 0
            ? `“${loop.name}” names the blocks it repeats but is not linked to ` +
              "them. A section is stated by a “repeats” link to the block each " +
              "pass starts at, and a list on its own no longer says it."
            : `“${loop.name}” has nothing to repeat. Draw a “repeats” link from ` +
              "it to the first block of the section it frames — a loop holds no " +
              "work of its own.",
      };
    }

    const derived = sectionFrom(loop.id, doors[0].to, edges);
    const declared = bodyOf(loop);
    if (declared.length > 0) {
      const same =
        declared.length === derived.length &&
        new Set(derived).size === derived.length &&
        declared.every((id) => derived.includes(id));
      if (!same) {
        const list = (ids: readonly string[]) =>
          ids.length === 0
            ? "nothing"
            : ids.map((id) => `“${named(id)}”`).join(", ");
        return {
          ok: false,
          error:
            `“${loop.name}” says twice what it repeats, and the two disagree. ` +
            `Its “repeats” link makes a section of ${list(derived)}; the list ` +
            `it carries names ${list(declared)}. Send one of them.`,
        };
      }
    }
    loop.bodyNodeIds = derived;
  }

  return { ok: true };
}

/**
 * Why a loop's body could not be repeated, or null when every body can be.
 *
 * Each one stands in front of a failure that is silent or arrives mid-instance.
 * A body is a *section* of the graph repeated whole, so the questions are about
 * the graph rather than about a block, which is why none of this is in
 * `normalizeNode`.
 *
 * Every sentence here names the link to draw rather than only the one that is
 * wrong. Membership is stated by a `repeats` link and an order by the section's
 * own links, so "this is not allowed" is only half an answer: the other half is
 * which of the two kinds of link the operator meant.
 *
 * Read after the cycle and ordering checks above, and the exit test below leans
 * on that: a section is any acyclic subgraph, so it has a sink, and a section
 * that is *not* acyclic is refused there by the same sentence any other cyclic
 * set gets.
 */
function loopBodyRefusal(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  byId: ReadonlyMap<string, WorkflowNode>,
  known: WorkflowKnowledge,
): string | null {
  const loops = nodes.filter((n) => n.kind === "loop" && bodyOf(n).length > 0);
  if (loops.length === 0) return null;

  /** Which loop claimed each block, so a block in two bodies can name both. */
  const owner = new Map<string, WorkflowNode>();

  // Three questions that used to be asked here are not asked any more, and
  // `resolveSections` is why: a section is **derived** from the `repeats` link
  // and a list sent without one is refused, so a member is a node in this graph
  // by construction, is never the loop itself — `sectionFrom` seeds its walk
  // with the loop's own id — and is never named twice, because the walk is a
  // visited set. They were reachable only through the list, and the list is now
  // a cross-check on the links rather than a second way of stating a section.
  for (const loop of loops) {
    for (const memberId of bodyOf(loop)) {
      const member = byId.get(memberId)!;
      // Two sections *can* still overlap: two loops with a `repeats` link into
      // the same block derive two sections that both claim it, and each pass of
      // each loop would create it again on one folder.
      const claimed = owner.get(memberId);
      if (claimed) {
        return `“${member.name}” is in the section repeated by both “${claimed.name}” and “${loop.name}”. A block can only be repeated by one loop.`;
      }
      owner.set(memberId, loop);

      // A loop inside a loop is the **one** kind of block a section may not
      // hold, and it is left out for a reason none of the others share: one
      // pass cap multiplying another is a number no operator can hold in their
      // head. An orchestrator block is in, because its fan-out cap is spent per
      // pass and that is stated at Save in the arithmetic below rather than
      // discovered on the bill. A merge block is in, because a section *ends*
      // in one — each pass lands what it produced.
      // A deliver block is the other kind a section may not hold, and for the
      // opposite reason: it multiplies nothing, it *publishes*. Each pass would
      // push its branches and open pull requests with nobody pressing anything,
      // up to the pass cap, and a pass does not even need the push — it lands
      // its own work through the section's merge block.
      if (member.kind === "deliver") {
        return (
          `“${member.name}” is repeated by “${loop.name}”, and a deliver block ` +
          "pushes branches and opens a pull request every time it is reached — " +
          "once per pass, with nobody pressing anything. A section lands its own " +
          "work through its merge block, and what a loop hands on afterwards is " +
          "already on its target, so there is no branch left to deliver."
        );
      }
      if (member.kind === "loop") {
        return (
          `“${member.name}” is itself a loop, and a loop inside a section ` +
          "multiplies one pass cap by another — a number nobody can work out " +
          "from the two they typed. It is the one kind of block a section may " +
          "not hold. Repeat one section, not a section that repeats."
        );
      }

      // Guards that isolate, asked of the members that work in a checkout and
      // of no others.
      //
      // A run member needs one because it commits: a pass whose guards work
      // directly in the folder leaves no branch for the section's own merge
      // block to land, so the work of every pass would go into the operator's
      // checkout with nothing recording which pass put it there. An
      // orchestrator member spends nothing on disk — it decides, and the runs
      // it emits carry their own guards — and a merge block has no guards at
      // all. Both are exempt **by name** rather than by passing a test written
      // about a checkout, which would answer them with a sentence about a
      // folder neither of them works in.
      //
      // Refused here rather than at the first pass, where it would be a throw
      // in the middle of an instance that had already started.
      if (member.kind === "run" && !isolatedTemplate(member.templateId, known)) {
        return (
          `“${member.name}” is repeated by “${loop.name}”, and every pass has ` +
          "to land what it produced — which needs a checkout of its own. Its " +
          "guards work directly in the folder instead."
        );
      }
    }
  }

  for (const loop of loops) {
    const members = new Set(bodyOf(loop));

    // The `repeats` link is the only door in, and the loop block is the only
    // door out. Anything else makes "when is this block released" a question
    // with two answers: the block behind a member would be waiting on a run
    // that is created again on every pass, and the block in front of one would
    // release a member the loop also creates.
    //
    // Three sentences rather than one, because there are three mistakes here
    // and only one of them is "you linked the wrong block". Each says what to
    // draw instead: a refusal that only names what is wrong leaves the operator
    // to guess which of the two link kinds they wanted.
    for (const e of edges) {
      const inFrom = members.has(e.from);
      const inTo = members.has(e.to);
      if (inFrom === inTo) continue;
      const outside = inFrom ? e.to : e.from;
      const inside = byId.get(inFrom ? e.from : e.to)!;
      if (outside === loop.id) {
        if (e.edge === REPEATS_EDGE) continue;
        return inFrom
          ? `“${inside.name}” is inside the section “${loop.name}” repeats and ` +
              `is linked back to “${loop.name}”. What runs after the loop is ` +
              "linked from the loop block, not from inside the section."
          : `“${loop.name}” is linked to “${inside.name}”, which is already ` +
              `inside the section it repeats. A loop has one way in: the ` +
              "“repeats” link to the block its pass starts at.";
      }
      return (
        `“${byId.get(outside)!.name}” is linked to “${inside.name}”, ` +
        `which is inside the section “${loop.name}” repeats. Link it to ` +
        `“${loop.name}” instead — the “repeats” link is the only way in, and ` +
        "the loop block is what hands on to whatever comes after."
      );
    }

    // **One way in and one way out**, and the way out has to land.
    //
    // A section used to have to be a *chain*, because a pass was one branch
    // handed from each member to the next and two members continuing one
    // predecessor is two runs on one ref. That is what "a pass lands its own
    // work" replaced: the section ends in a merge block, each pass lands what it
    // produced, and the next pass starts from the landed branch rather than
    // carrying a ref along. So the shape is free — any acyclic subgraph — and
    // what is fixed is its two ends.
    //
    // The way in is the `repeats` link's target, which is what `sectionFrom`
    // walked from. The way out is the section's single **sink**, and the two
    // refusals below are the whole of what is left of the chain rule.
    //
    // A second sink is the same defect as a member with no path to the exit,
    // and it is answered by one sentence rather than two because it *is* one
    // fact: a member whose work nothing lands ends the section somewhere, and
    // where it ends is that second sink. (The section is acyclic by the time
    // this runs, and every member is reachable from the entry, so "one sink"
    // and "every member reaches it" are the same statement.) The sentence says
    // both halves — what is wrong and what the work would cost — because "the
    // section ends in two places" on its own is a shape complaint and the
    // reason it matters is a branch nobody lands.
    const within = edges.filter((e) => members.has(e.from) && members.has(e.to));
    const sinks = [...members].filter(
      (id) => !within.some((e) => e.from === id),
    );
    if (sinks.length > 1) {
      return (
        `The section “${loop.name}” repeats ends in ${sinks.length} places: ` +
        `${sinks.map((id) => `“${byId.get(id)!.name}”`).join(", ")}. A ` +
        "section has one way out, and what it ends at is what lands the pass " +
        "— so link each of these on towards the block that does, or its work " +
        "is committed on a branch nothing ever lands."
      );
    }
    const exit = byId.get(sinks[0])!;
    if (exit.kind !== "merge") {
      return (
        `The section “${loop.name}” repeats ends at “${exit.name}”, which is ` +
        "not a merge block. Every pass has to land what it produced, because " +
        "the next one starts from the landed branch: add a merge block at the " +
        `end of the section and link “${exit.name}” to it.`
      );
    }

    // A path to the exit is not a branch to it. A merge block lands the runs
    // **directly** in front of it, and a run whose way on carries no branch
    // leaves its commits where they are: its successor starts fresh. So a
    // fan-in — `a` and `b` meeting at `j`, which can carry on only one of the
    // two — reaches the exit through `j` and still lands only `a`'s work, and
    // the path test above cannot tell. Each run member has to hand its branch
    // to something that takes it: a run that carries it on, which this same
    // rule then asks about in turn, or a merge or review block right behind
    // it. A review block counts because what it sets aside it sets aside on
    // purpose.
    //
    // An orchestrator or review member hands on branches it did not cut — the
    // runs it emitted, the runs it approved — and resolves them to its
    // successors with `continueBranch: false` whatever the link says, so only a
    // merge or review block right behind it takes them. An orchestrator's runs
    // take its guards, so it is asked only when those isolate: a template that
    // works in the folder cuts no branch, and requiring the link to the exit
    // there would trip the merge rule's "leaves no branch to land". A review is
    // always asked, since it reviews only isolated work.
    //
    // Refused here rather than mended in the editor, because the editor is one
    // of three doors a graph is saved through, and because the exit may not be
    // drawn yet when the fan-in link is. The sentence names the link to draw.
    const handsOnBranches = (member: WorkflowNode) =>
      member.kind === "run" ||
      member.kind === "review" ||
      (member.kind === "orchestrator" && isolatedTemplate(member.templateId, known));
    const unlanded = [...members]
      .map((id) => byId.get(id)!)
      .find(
        (member) =>
          handsOnBranches(member) &&
          !within.some(
            (e) =>
              e.from === member.id &&
              (e.continueBranch ||
                byId.get(e.to)!.kind === "merge" ||
                byId.get(e.to)!.kind === "review"),
          ),
      );
    if (unlanded) {
      const where = `in the section “${loop.name}” repeats`;
      const fix =
        `Link “${unlanded.name}” to “${exit.name}” as well, or that work is ` +
        "committed on branches nothing ever lands.";
      if (unlanded.kind === "orchestrator") {
        return (
          `Nothing lands the runs “${unlanded.name}” starts ${where}: a block ` +
          "after it starts fresh rather than carrying their branches on, and " +
          `no link out of it leads to a merge block. ${fix}`
        );
      }
      if (unlanded.kind === "review") {
        return (
          `Nothing lands the branches “${unlanded.name}” approves ${where}: a ` +
          "block after it starts fresh rather than carrying them on, and no " +
          `link out of it leads to a merge block. ${fix}`
        );
      }
      return (
        `Nothing lands “${unlanded.name}”'s branch ${where}: no link out of it ` +
        `carries that branch on, and none leads to a merge block. Link ` +
        `“${unlanded.name}” to “${exit.name}” as well, or its work is ` +
        "committed on a branch nothing ever lands."
      );
    }

    // What one press of Run would put on the machine over the life of this
    // block, with every factor named: a cap on the product alone is a number
    // the operator cannot act on.
    //
    // **An orchestrator block's fan-out is spent per pass**, which is the whole
    // of what letting one into a section costs and the reason the worst case is
    // no longer passes × members. A fan-out cap is what that block may start
    // *each time it is reached*, and a section reaches it once a pass — so a
    // pass is one run for each run member, plus for each orchestrator member the
    // deciding turn and every run it is allowed to emit. A merge block is
    // neither: it creates no run and spawns no agent of its own.
    //
    // The product is `worstCaseRuns`'s, the function the editor's statement and
    // `/workflows/[id]`'s loop row print, and never a copy of it here: a refusal
    // computed apart from the figure the operator was shown is how the editor
    // came to state "up to 60 runs" over a graph this refused at 72.
    //
    // It is null only through a broken invariant — `normalizeNode` refuses a
    // loop with no pass cap and an orchestrator with no fan-out, and has
    // already run on every node here — and null lets the graph through on
    // purpose, rather than refusing an operator over a number this file would
    // have had to invent.
    const membership = [...members].map((id) => byId.get(id)!);
    const worst = worstCaseRuns(loop.maxPasses, membership);
    if (worst !== null && worst > MAX_LOOP_RUNS) {
      const perPass = worstCaseRuns(1, membership);
      // A review member's rounds are named beside the fan-outs because they
      // are the other factor in a pass: left out, two run blocks were stated
      // as "8 run(s) — one for each block that runs", a sum nobody could redo.
      const extras = membership
        .flatMap((m) => {
          if (m.kind === "orchestrator") {
            return [
              `for “${m.name}” the deciding turn plus the ${m.fanOut} runs ` +
                "its fan-out cap allows, spent again on every pass",
            ];
          }
          if (m.kind === "review" && (m.fixRounds ?? 0) > 0) {
            return [
              `for “${m.name}” up to ${m.fixRounds} fix run(s) on every ` +
                "branch the pass cuts, one for each fix round",
            ];
          }
          return [];
        })
        .join(", ");
      return (
        `“${loop.name}” repeats ${members.size} block(s) up to ${loop.maxPasses} ` +
        `time(s). Each pass is ${perPass} run(s) — one for each block that ` +
        `runs${extras ? `, and ${extras}` : ""} — which is ${worst} runs ` +
        `from one press of Run. A loop may start at most ${MAX_LOOP_RUNS}.`
      );
    }
  }

  return null;
}

/**
 * What to add to a "nothing in front of it to land, push or review" refusal
 * when a gate is what is in front of it. A gate hands on no branches, so the
 * operator who drew `run → gate → merge` has drawn a block that holds the merge
 * and gives it nothing to land — and the refusal alone does not say what to
 * draw instead.
 */
function gateHint(sources: readonly WorkflowNode[], node: WorkflowNode): string {
  return sources.some((s) => s.kind === "gate")
    ? " A gate holds what is behind it but hands on no branches, so link the " +
        `block that built them straight to “${node.name}” as well as to the gate.`
    : "";
}

/**
 * Why a graph as a whole could never run, or null when nothing is wrong with it.
 *
 * The checks a single block or a single link cannot see: two links carrying on
 * one branch, a merge block with nothing in front of it to land, the two
 * orderings, and everything about a loop's repeated section. Separated from
 * `normalizeWorkflowInput` because it is the phase that reads the finished
 * graph rather than the wire, and it is the one that grows as the kinds of
 * block do.
 *
 * Shaped like `folderRefusal` — a sentence or null — for the same reason: a
 * refusal here is something the operator can change.
 */
function graphRefusal(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  byId: ReadonlyMap<string, WorkflowNode>,
  known: WorkflowKnowledge,
): string | null {
  // Two runs on one ref is a branch git will not check out twice, and it leaves
  // the landing rules with no last link to name. `admitDependencies` refuses it
  // between live runs; this is the same rule inside one graph, where both would
  // be created in the same pass. The exception is the pair `edgesExclude` names,
  // one on-success and one on-failure: only one of them can ever start, so a
  // fixer can carry on the branch its sibling would have.
  const continuing = new Map<string, WorkflowEdge[]>();
  for (const e of edges) {
    if (!e.continueBranch) continue;
    const earlier = continuing.get(e.from) ?? [];
    if (earlier.some((other) => !edgesExclude(other.edge, e.edge))) {
      const source = byId.get(e.from)!;
      const takers = edges
        .filter((other) => other.continueBranch && other.from === e.from)
        .map((other) => `“${byId.get(other.to)!.name}”`);
      return (
        `${takers.join(" and ")} are both set to carry on “${source.name}”'s ` +
        "branch. Two runs cannot extend one branch, unless one starts only on " +
        "success and the other only on failure."
      );
    }
    continuing.set(e.from, [...earlier, e]);
  }

  // A pass runs its section as a graph of its own, and a member that was not
  // needed is a reading `planLoopPass`' exit conditions do not have — neither
  // unfinished nor DONE — so a pass whose fixer was passed over would neither
  // stop nor carry on. Refused rather than given one. A link *into* the loop
  // block is outside every section, and is a run block's like any other.
  const owners = loopBodyOwners({ nodes: [...nodes], edges: [...edges] });
  for (const e of edges) {
    if (e.edge !== "on-failure") continue;
    const loop = owners.get(e.from) ?? owners.get(e.to);
    if (!loop) continue;
    return (
      `“${byId.get(e.to)!.name}” is set to start only if “${byId.get(e.from)!.name}” ` +
      `fails, inside what “${loop.name}” repeats. A pass has no reading for a ` +
      "block that was not needed, so links inside a loop start on-success or " +
      "on-finish."
    );
  }

  // A merge block lands what is in front of it, so what is in front of it has to
  // exist and has to have left a branch.
  //
  // Both halves are refused at *save* rather than at Run, which is this file's
  // standing rule and bites in the usual way: a merge block with nothing to land
  // is a block that reaches the front of the graph and can only report that it
  // was pointless, and a merge block behind runs that work directly in the
  // operator's folder is one that will find every predecessor branchless an hour
  // in. Both are answerable now, from the guards a person already chose.
  //
  // A merge block *may* sit behind another merge block — that is sequencing, and
  // it contributes no branches — so the requirement is one predecessor that
  // produces runs, not one predecessor. A loop block is the second kind that
  // contributes none: each of its passes lands its own work through the
  // section's own exit, so by the time the loop hands on there is no branch of
  // its own left to land.
  // A review block reviews branches, so it needs a block in front of it that
  // cuts one — the merge rule below, asked of the review's own sources — and
  // every such source has to work in a checkout of its own: a review is judged
  // against the branch tip it was shown, and a run that worked in the folder
  // has none, so it could never be approved and every pass would set it aside.
  for (const node of nodes) {
    if (node.kind !== "review") continue;
    const sources = edges
      .filter((e) => e.to === node.id && isDependencyEdge(e))
      .map((e) => byId.get(e.from)!);
    const producers = sources.filter(
      (s) => s.kind === "run" || s.kind === "orchestrator" || s.kind === "review",
    );
    if (producers.length === 0) {
      return (
        `“${node.name}” has no block in front of it whose branches it could ` +
        "review. A review block reviews what its predecessors built, so it " +
        `needs at least one predecessor that runs something.${gateHint(sources, node)}`
      );
    }
    const bare = producers.find(
      (s) => s.kind !== "review" && !isolatedTemplate(s.templateId, known),
    );
    if (bare) {
      return (
        `“${bare.name}” leaves no branch for “${node.name}” to review — its ` +
        "guards work directly in the folder rather than in a checkout of " +
        "their own."
      );
    }
    // A status verdict sets aside a run that did not complete, so it has to be
    // handed those runs. Behind an on-success link the first one blocks the
    // whole block instead — the stop this verdict exists to remove — and a Run
    // would find that out a pass in rather than here.
    if (node.verdictSource?.kind === "status") {
      const strict = edges.find(
        (e) => e.to === node.id && isDependencyEdge(e) && e.edge !== "on-finish",
      );
      if (strict) {
        return (
          `“${node.name}” judges each branch by how its run ended, so it has ` +
          `to be handed the runs that did not complete as well. Behind an ` +
          `on-success link from “${byId.get(strict.from)!.name}”, the first ` +
          "of them blocks it instead. Set that link to on-finish."
        );
      }
    }
  }

  // A deliver block pushes what is in front of it, so the merge block's two
  // halves apply to it unchanged: something has to be there, and it has to have
  // cut a branch. `continueBranch` is the one rule that does not carry over as
  // written — it is refused on the edge, where it is drawn — and neither does
  // the landing exit: a pass is landed by its merge block, and a deliver block
  // is not allowed in a section at all.
  //
  // A merge block, a loop and another deliver block are the three that hand on
  // no runs (see `edgeVerdict`), so none of them counts as something to push. A
  // deliver block whose only predecessor is a merge block would have nothing to
  // be handed; and what a merge landed is on its target, where a pull request
  // from it has no commits to show.
  for (const node of nodes) {
    if (node.kind !== "deliver") continue;
    const sources = edges
      .filter((e) => e.to === node.id && isDependencyEdge(e))
      .map((e) => byId.get(e.from)!);
    const producers = sources.filter(
      (s) =>
        s.kind !== "merge" &&
        s.kind !== "loop" &&
        s.kind !== "deliver" &&
        s.kind !== "gate",
    );
    if (producers.length === 0) {
      return (
        `“${node.name}” has no block in front of it whose branches it could ` +
        "push. A deliver block pushes what its predecessors built, so it needs " +
        "at least one predecessor that runs something — a merge block lands its " +
        `branches on their target and hands none on.${gateHint(sources, node)}`
      );
    }
    // A review is not asked about a template it does not have; its own sources
    // are held to this rule by the review rule above.
    const bare = producers.find(
      (s) => s.kind !== "review" && !isolatedTemplate(s.templateId, known),
    );
    if (bare) {
      return (
        `“${bare.name}” leaves no branch for “${node.name}” to push — its ` +
        "guards work directly in the folder rather than in a checkout of " +
        "their own."
      );
    }
  }

  for (const node of nodes) {
    if (node.kind !== "merge") continue;
    const sources = edges
      .filter((e) => e.to === node.id)
      .map((e) => byId.get(e.from)!);
    const producers = sources.filter(
      (s) =>
        s.kind !== "merge" &&
        s.kind !== "deliver" &&
        s.kind !== "loop" &&
        s.kind !== "gate",
    );
    if (producers.length === 0) {
      return (
        `“${node.name}” has no block in front of it whose work it could ` +
        "land. A merge block lands the branches its predecessors left, so it " +
        `needs at least one predecessor that runs something.${gateHint(sources, node)}`
      );
    }
    // A review block produces branches too — the approved ones in front of it —
    // and its own sources are held to this rule by the review rule below, so it
    // is not asked about a template it does not have.
    const bare = producers.find(
      (s) => s.kind !== "review" && !isolatedTemplate(s.templateId, known),
    );
    if (bare) {
      return (
        `“${bare.name}” leaves no branch for “${node.name}” to land — its ` +
        "guards work directly in the folder rather than in a checkout of " +
        "their own."
      );
    }
  }

  // A gate holds what is behind it, so it needs something behind it. One with
  // no link out would stop the instance for a person to press Continue and then
  // release nothing — a pause with no purpose, which on a scheduled workflow is
  // also the only thing that ever holds the next window up.
  for (const node of nodes) {
    if (node.kind !== "gate") continue;
    if (!edges.some((e) => e.from === node.id && isDependencyEdge(e))) {
      return (
        `“${node.name}” is a gate with nothing after it, so there is nothing ` +
        "for it to hold. Link the blocks that should wait for it, or remove it."
      );
    }
  }

  // The same loop detector the run graph uses, given the node ids in place of
  // run ids — so "what counts as a cycle" has one definition and one test.
  // A `repeats` link is not a wait, so it is not an arrow this detector may
  // follow: the block it names is created once per pass by the loop and never
  // waits for it. Left in, a section whose last block was linked back to its
  // loop would be reported as "these blocks wait for each other" rather than by
  // the boundary rule below, which says which link to draw instead.
  const links: DependencyLink[] = edges.filter(isDependencyEdge).map((e) => ({
    runId: e.to,
    dependsOn: e.from,
    edge: e.edge,
  }));
  const loop = dependencyCycle(links);
  if (loop) {
    return (
      "These blocks wait for each other in a loop, so none of them could " +
      `ever start: ${loop.map((id) => byId.get(id)?.name ?? id).join(" → ")}.`
    );
  }

  // Belt and braces: the order the instantiation uses has to be total, and the
  // cycle check above is the only thing that can make it not be. A graph that
  // reached here with an unplaceable node would be instantiated into runs that
  // sit `waiting` for ever.
  //
  // Over the dependencies alone, for the reason above it: a `repeats` link is
  // not a wait, and `instantiate` skips every block a loop repeats anyway. Left
  // in, a section whose last block was linked back to its loop would be
  // reported here rather than by the boundary rule, which names the link to
  // draw instead of the three blocks it is between.
  const { unplaced } = topologicalOrder({
    nodes,
    edges: edges.filter(isDependencyEdge),
  });
  if (unplaced.length > 0) {
    return (
      "These blocks could never start, because what they wait for can never " +
      `settle: ${unplaced.map((id) => byId.get(id)!.name).join(", ")}.`
    );
  }

  const taskless = emptyLoopTaskRefusal(nodes);
  if (taskless) return taskless;

  // Last, so the chain test inside it may assume an acyclic body.
  return loopBodyRefusal(nodes, edges, byId, known);
}

/**
 * Why a loop that frames nothing has nothing to do, or null.
 *
 * `normalizeNode` refuses an empty task on a `run` and an `orchestrator` block
 * and deliberately does not on a `loop`, because whether a loop's own task would
 * ever be read is a fact about the whole graph: a loop with a section runs its
 * *members*, each of which carries its own task, and the frame's own text is
 * sent to no agent. The section is derived from the `repeats` link in
 * `resolveSections`, after every node has been normalized, so `normalizeNode`
 * could only have asked it of one block at a time — which made the one block
 * whose text is never read the one block forced to carry some.
 *
 * **Belt and braces as the file now stands, and that is worth knowing before
 * editing it.** `resolveSections` refuses a loop with no `repeats` link, so
 * every loop reaching here has a section and this answers null; and a task that
 * arrived is refused by name against `LOOP_IS_TOLD_NOTHING`, so the field is
 * empty whatever was sent. It is the answer for a loop that frames nothing, and
 * the day such a loop can be saved again is the day it fires — rather than the
 * day a body-less loop reaches a pass with nothing to run.
 */
function emptyLoopTaskRefusal(nodes: readonly WorkflowNode[]): string | null {
  for (const node of nodes) {
    if (node.kind !== "loop") continue;
    if (bodyOf(node).length > 0) continue;
    if (node.task) continue;
    return (
      `“${node.name}” has no task to repeat. A loop with nothing to do is a ` +
      "billed run per pass that spends a work cycle finding that out."
    );
  }
  return null;
}


/**
 * What a graph is validated against right now.
 *
 * One reader, so the save route and the instantiation cannot be comparing a
 * graph against two different pictures of the same install.
 */
export function currentKnowledge(): WorkflowKnowledge {
  return {
    templates: new Map(
      listTemplates().map((t) => [t.id, { name: t.name, isolate: t.isolate }]),
    ),
    mountIds: WORKSPACE_MOUNTS.map((m) => m.id),
    defaultIsolate: chatGuards().isolate,
    agents: currentAgentKnowledge(),
  };
}

/**
 * Why a block's folder cannot be worked in, or null when every one resolves.
 *
 * Not part of `normalizeWorkflowInput`, which is pure — this is the filesystem
 * check, and it is the same `resolveWorkspaceFolder` call `createRun` makes. It
 * runs at *save* as well as at instantiation, which is a deliberate divergence
 * from `run_templates`: a template records a folder as a preference that the
 * run form asks about again, where a workflow block's folder is what the run
 * will use and is never asked about a second time.
 */
export function folderRefusal(graph: WorkflowGraph): string | null {
  for (const node of graph.nodes) {
    // A merge block names no workspace: it works in whichever repository each
    // branch it lands came from, which `landRun` reads off that branch's own
    // run. A loop names none either — it frames the blocks it repeats and each
    // of those resolves its own, so asking here would be resolving `""` against
    // no mount at all and refusing the graph over a folder nobody chose.
    if (
      node.kind === "merge" ||
      node.kind === "deliver" ||
      node.kind === "loop" ||
      node.kind === "review" ||
      node.kind === "gate"
    ) {
      continue;
    }
    try {
      resolveWorkspaceFolder(node.folder, node.mountId);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return `“${node.name}” cannot start: ${detail}`;
    }
  }
  return null;
}

/**
 * Why a saved folder cannot be worked in, or null when every one resolves.
 *
 * `folderRefusal`'s check for the folders a workflow saves to choose from, and
 * asked at every save door beside it for that function's reason: a folder that
 * could be saved and never chosen fails weeks away from the form that saved it.
 * Run does not ask it — only the chosen folder has to resolve then, and
 * `folderRefusal` asks that one, off the blocks that follow it.
 */
export function listedFolderRefusal(
  folders: readonly WorkflowFolder[] | undefined,
): string | null {
  for (const [index, entry] of (folders ?? []).entries()) {
    try {
      resolveWorkspaceFolder(entry.folder, entry.mountId);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return `Folder ${index + 1} cannot be worked in: ${detail}`;
    }
  }
  return null;
}
