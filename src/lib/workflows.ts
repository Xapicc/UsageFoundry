import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { db } from "./db";
import {
  CHAT_IDLE_TIMEOUT_MS,
  composeTask,
  getProposal,
  markProposal,
  mintCapability,
  revokeCapability,
  runOrchestratorChild,
  type ChatProcess,
  type TurnResult,
} from "./chat";
import {
  assistBudgetFull,
  assistChild,
  getAssist,
  startReview,
  windowRefusal,
} from "./review";
import {
  afterFixRun,
  fixRunPrompt,
  nextReviewStep,
  reviewBlockSummary,
} from "./reviewBlock";
import { addTaskComment } from "./taskComments";
import { installBudgetRefusal } from "./installBudget";
import {
  DEPENDENCY_EDGES,
  blockWaitingRun,
  clampRunOffset,
  createRun,
  currentSnapshot,
  dependencyCycle,
  describeFolder,
  edgeSatisfied,
  getRun,
  isShuttingDown,
  probeIsolation,
  promoteQueued,
  refundedCyclesSql,
  releaseDependents,
  resolveWorkspaceFolder,
  revivableDependents,
  signalTree,
  stopRun,
  TERMINAL_STATUSES,
  topologicalOrder,
  RUN_ORIGINS,
  type CreateRunInput,
  type RunOrigin,
  type RunRow,
  type DependencyEdge,
  type DependencyLink,
  type DependencyState,
  type RunStatus,
} from "./orchestrator";
import {
  batchRows,
  cancelQueuedFor,
  enqueue,
  isQueueActive,
  type QueueRow,
} from "./mergeQueue";
import { landState, type LandStrategy } from "./land";
import {
  INSTANCE_ENFORCEABLE_CODES,
  evaluateInstanceBudget,
  instanceBudgetIsOff,
  normalizeInstanceBudget,
  type BudgetVerdict,
  type InstanceBudgetPolicy,
  type InstanceProgress,
  normalizePolicy,
  providerTerminusRefusal,
} from "./budget";
import { getLocalSignIn } from "./localProvider";
import { deciderApplies, type DeciderWork, type ModelDecision } from "./modelDecider";
import {
  agentDefinition,
  agentKnowledgeOf,
  agentRefusal,
  currentAgentKnowledge,
  getAgent,
  parseRunAgent,
  getAgentByName,
  listAgents,
  type AgentDefinition,
  type AgentFacts,
  type AgentKnowledge,
  type RegistryAgent,
} from "./agents";
import {
  TASK_PRIORITIES,
  currentTaskKnowledge,
  listTasks,
  readTaskLinks,
  reopenRejectedTask,
  resolveTaskFolder,
  tasksLinkedToRun,
  updateTask,
  type TaskLinkReading,
} from "./tasks";
import { telemetrySpendSince } from "./otlp";
import type { UsageSnapshot } from "./windows";
import {
  chatGuards,
  getSettings,
  newWorkPaused,
  type PermissionMode,
  type RunGuards,
} from "./settings";
import { getTemplate, listTemplates, type RunTemplate } from "./templates";
import { WORKSPACE_MOUNTS, mountById } from "./config";
import { dataDirRefusal } from "./serverLock";
import {
  passMemberId,
  passMemberIn,
  passMemberName,
  passMemberOf,
  passNumberOf,
  passPrefix,
} from "./passIds";
import {
  MAX_FAN_OUT,
  MAX_LOOP_PASSES,
  MAX_LOOP_RUNS,
  MAX_WORKFLOW_NAME,
  MAX_WORKFLOW_NODES,
  boardThresholds,
  providerReportsSpend,
  type LoopBoardCountsDTO,
  type LoopBoardReadingDTO,
  type RunProviderDTO,
  type TaskPriorityDTO,
  type WorkflowNodeKind,
} from "./apiTypes";

/** What a project's board holds, in the terms a threshold names. See the DTO. */
export type LoopBoardCounts = LoopBoardCountsDTO;

/**
 * A saved, re-runnable graph of run blocks.
 *
 * The third thing in this app that is **form input, never a run** — after
 * `run_templates` and `chat_proposals`, and it follows both of them exactly. A
 * workflow holds no folder claim, consumes no concurrency slot, and nothing
 * derived from `activeRuns()` can see it. Pressing Run is what turns it into
 * runs, and from that moment the runs carry every value themselves: editing or
 * deleting the workflow afterwards cannot reach them.
 *
 * **A node holds the work, and something a person wrote holds the guards.** A
 * node names a template for its budget, permission mode and isolation, or names
 * none and takes `settings.chatDefaultGuards` — which is `planProposal`'s rule,
 * reused rather than restated. Nothing on a node sets a guard, and there is
 * deliberately no `permissionMode` column here: `--permission-mode` is narrowed
 * three times in this codebase already, `reopenRun` refuses to become a third
 * route to it, and a workflow node would be a fourth. A node naming a template
 * that has since been deleted is refused **by name** at instantiation rather
 * than falling back to the untemplated guard set, for the reason a proposal is:
 * the operator saved a graph that said "under these guards", and a run started
 * under different ones is what this gate exists to prevent.
 *
 * What a node *does* hold is the work — the mount, the folder, the task, and an
 * optional prompt override. The mount and folder are on the node rather than
 * inherited from the template, unlike a proposal's: a proposal is approved
 * minutes after it is written, where a workflow is saved once and run for
 * months, and a template edited in between would silently move a node's run to
 * a different repository with nothing in the graph changing.
 *
 * **A node can also decide what the next runs should be, and they start without
 * an approval.** An orchestrator block is a short agent turn — the chat's child,
 * invoked without a thread — whose only tool that writes anything emits run
 * specs: a title, a task, a folder inside the block's own mount, and the
 * dependency edges among the runs it is emitting. The server creates them and
 * they enter the queue. Nothing is proposed and nobody clicks Approve, and the
 * reason that is defensible is that the approval moved rather than disappeared:
 * a person saved a graph naming this block's folder, its guard set and the
 * largest number of runs it may ever start. What has *not* moved is the rule
 * every other route here follows — **no value the model emits sets a budget, a
 * permission mode or an isolation choice.** Those come from the block's named
 * template, or from `settings.chatDefaultGuards` when it names none, exactly as
 * `planProposal` and `planNode` resolve them. The orchestrator *chat* still
 * proposes and still starts nothing; this is a different thing with a different
 * gate in front of it.
 *
 * **And a node can land what the nodes in front of it built.** A merge block
 * spawns no agent and holds no task: it takes the branches its predecessors' runs
 * left behind and puts each one onto the target that run recorded when it cut its
 * branch — never a target named here, for the reason `landState` never assumes
 * one. It goes through `mergeQueue.enqueue`, so it inherits every protection the
 * Branches page has and adds none of its own: one merge in flight, each item
 * re-previewed against git at *its* turn, a conflict reconciled on the run's own
 * branch in a throwaway checkout, and the operator's own checkout refusing the
 * whole repository if it is dirty or standing on the wrong branch. That last one
 * is the honest cost of an unattended merge and is not weakened here — landing
 * onto the wrong branch is the one mistake in this app with no undo.
 *
 * Its one expense is optional and is authorised the same way an orchestrator
 * block's runs are: `mergeAutoResolve` on the saved graph is a person agreeing,
 * once, that a conflict may be reconciled by a model. It is on the node rather
 * than in settings for `merge_queue.auto_resolve`'s reason — configuration that
 * could change under a graph already running is not authorisation.
 *
 * **A node can also repeat itself, and it repeats by unrolling rather than by
 * pointing backwards.** A loop block is the obvious place to reach for a back
 * edge in `run_deps`, and a back edge is precisely the row nothing ever wakes:
 * `dependencyCycle` refuses one at admission because `releasableRuns` reaches a
 * fixed point and leaves a cyclic set alone. So the loop lives here, in the
 * workflow layer, and `run_deps` never learns about it — each pass is a fresh
 * run depending on the previous pass's, so the run graph stays a DAG and every
 * rule written against one still holds. What decides whether there is another
 * pass is `planLoopPass`, and it is pure for `releasableRuns`' reason: a loop
 * that never terminates is billed, and one that stops a pass early is silent.
 */

/* ------------------------------------------------------------------ */
/* Shape and validation — re-exported from ./workflowGraph             */
/* ------------------------------------------------------------------ */

export {
  REPEATS_EDGE,
  WORKFLOW_EDGE_CONDITIONS,
  currentKnowledge,
  folderRefusal,
  isDependencyEdge,
  loopBody,
  normalizeWorkflowInput,
  type TemplateFacts,
  type WorkflowEdgeCondition,
  type Workflow,
  type WorkflowDependencyEdge,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowInput,
  type WorkflowKnowledge,
  type WorkflowNode,
  type WorkflowNormalization,
} from "./workflowGraph";

import {
  NODE_ID,
  REPEATS_EDGE,
  currentKnowledge,
  folderRefusal,
  isDependencyEdge,
  loopBody,
  loopBodyOwners,
  normalizeBoardCondition,
  normalizeWorkflowInput,
  type TemplateFacts,
  type WorkflowDependencyEdge,
  type Workflow,
  type LoopBoardCondition,
  type LoopBoardThreshold,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowInput,
  type WorkflowKnowledge,
  type WorkflowNode,
} from "./workflowGraph";


/* ------------------------------------------------------------------ */
/* A workflow the chat wrote                                           */
/* ------------------------------------------------------------------ */

/**
 * How a graph the chat proposed reads on the card the operator approves.
 *
 * Everything here is a *guard-shaped* fact — where a block runs, what it may
 * do, how many agents it may start, whether it may spend on a conflict — and it
 * is assembled here rather than in the page for `defaultGuardsLabel`'s reason:
 * an approval gate that does not show what is being approved is a gate that
 * gets clicked through, and the guards are not on the graph, they are on the
 * templates it names.
 */
export interface ProposedBlockSummary {
  name: string;
  kind: WorkflowNodeKind;
  /** The template's name, or what the untemplated guard set permits. */
  guardsLabel: string;
  /**
   * The agent this block's child is started as, by name, or null for none.
   *
   * Separate from `guardsLabel` rather than folded into it, which is the same
   * separation `BlockStatement` makes in the editor and for the same reason: an
   * agent bounds nothing, so a phrase inside the guard clause would claim it
   * does. `"agent deleted"` when the id names nothing, which is what
   * `guardsLabel` already says one field over about a template — approval
   * refuses it by name either way.
   */
  agentLabel: string | null;
  /** Where it runs, as the folder picker words it. Null on a merge block. */
  folderLabel: string | null;
  /** How many runs a deciding block may start. Null on every other kind. */
  fanOut: number | null;
  /** Whether a merge block may pay a model to reconcile a conflict. */
  mergeAutoResolve: boolean;
  /** The blocks it starts after, by name. */
  after: string[];
}

export type WorkflowProposalPlan =
  | { ok: true; input: WorkflowInput }
  | { ok: false; reason: string };

/**
 * Turn a proposed graph into the workflow it asks for, or say why not.
 *
 * `planProposal` one level up, and the same division of labour: the chat says
 * what work to do and something a person wrote says what an agent may do. Every
 * guard in the graph comes from a block's named template or from
 * `settings.chatDefaultGuards`, exactly as `planNode` resolves them — there is
 * no permission mode, budget, isolation choice or model anywhere on a node for
 * a model to reach, which is what makes a graph safe to let one write.
 *
 * **Approving it saves a workflow and starts nothing.** That is deliberate and
 * is the whole reason this is allowed at all: an orchestrator block's runs start
 * with nobody looking *because a person fixed its folder, its guard set and its
 * fan-out cap when they saved the graph*, and a graph a model wrote has no such
 * person in it. Saving rather than starting puts one back — the operator reads
 * the card, then opens the canvas, then presses Run — so by the time an agent
 * exists, two separate human decisions stand behind every number in it.
 *
 * The instance budget is **not** carried from the proposal, and there is
 * nothing on the wire that could carry it: it is a limit on billed spend, which
 * is the one class of value no route here lets a model set. `startWorkflow`
 * still refuses a fraction guard with no ceiling, and a schedule still refuses a
 * workflow whose budget sets nothing, so what an approved proposal produces is a
 * workflow that runs by hand and cannot yet be scheduled. The card says so.
 *
 * Re-normalized rather than trusted: the graph was checked when it was
 * proposed, and the templates and mounts it names can be gone by the time
 * anyone clicks — the same window `planProposal`'s missing-template refusal
 * covers, and refused the same way rather than falling back to guards nobody
 * chose.
 */
export function planWorkflowProposal(
  proposal: { title: string; graph: string | null },
  known: WorkflowKnowledge,
): WorkflowProposalPlan {
  if (!proposal.graph) {
    return { ok: false, reason: "This proposal carries no workflow to save." };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(proposal.graph);
  } catch {
    return { ok: false, reason: "This proposal's workflow could not be read." };
  }

  const parsed = normalizeWorkflowInput(
    // The name is the proposal's title, so what the operator approved and what
    // appears in the workflow list are the same string.
    { name: proposal.title, graph: raw, instanceBudget: null },
    known,
  );
  if (!parsed.ok) return { ok: false, reason: parsed.error };
  return { ok: true, input: parsed.value };
}

/** What the chat proposed, in the terms the card has to show. */
export function summarizeProposedGraph(
  graph: WorkflowGraph,
  known: WorkflowKnowledge,
  untemplatedLabel: string,
): ProposedBlockSummary[] {
  const names = new Map(graph.nodes.map((n) => [n.id, n.name]));
  return graph.nodes.map((node) => ({
    name: node.name,
    kind: node.kind,
    guardsLabel:
      node.kind === "merge" || node.kind === "review"
        ? "no agent"
        : node.templateId === null
          ? untemplatedLabel
          : (known.templates.get(node.templateId)?.name ?? "template deleted"),
    // The registry's own spelling rather than the graph's id, because the id is
    // a thing only this app's forms hold and the card is read by a person.
    agentLabel: node.agentId
      ? (known.agents.get(node.agentId)?.name ?? "agent deleted")
      : null,
    folderLabel:
      node.kind === "merge" || node.kind === "review"
        ? null
        : `${mountById(node.mountId)?.label ?? node.mountId}${
            node.folder ? `/${node.folder}` : " (mount root)"
          }`,
    fanOut: node.fanOut,
    mergeAutoResolve: node.mergeAutoResolve,
    // Dependencies only. A `repeats` link names the loop that *contains* this
    // block, which is not something it waits for — one pass creates it.
    after: graph.edges
      .filter((e) => e.to === node.id && isDependencyEdge(e))
      .map((e) => names.get(e.from) ?? e.from),
  }));
}

export type WorkflowApproval =
  | { ok: true; workflowId: string; name: string }
  | { ok: false; reason: string };

/**
 * Save the workflow a proposal asks for, and record what it became.
 *
 * Synchronous like `approveProposal`, though nothing here claims a folder: it
 * runs inside the same pass, and a route that is synchronous throughout is one
 * that cannot grow an `await` between two approvals of the same folder later.
 */
export function approveWorkflowProposal(id: string): WorkflowApproval {
  const proposal = getProposal(id);
  if (!proposal) return { ok: false, reason: "No such proposal." };
  if (proposal.kind !== "workflow") {
    return { ok: false, reason: "This proposal is a run, not a workflow." };
  }

  const plan = planWorkflowProposal(proposal, currentKnowledge());
  if (!plan.ok) {
    markProposal(id, "failed", { error: plan.reason });
    return { ok: false, reason: plan.reason };
  }

  // The folder check the save route runs, for the reason it runs it there: a
  // block's folder is what its run will use and nothing asks about it again.
  const missing = folderRefusal(plan.input.graph);
  if (missing) {
    markProposal(id, "failed", { error: missing });
    return { ok: false, reason: missing };
  }

  try {
    const workflow = createWorkflow(plan.input);
    markProposal(id, "approved", { workflowId: workflow.id });
    return { ok: true, workflowId: workflow.id, name: workflow.name };
  } catch (err) {
    // A duplicate name arrives here as the sentence the form would show.
    const reason = err instanceof Error ? err.message : String(err);
    markProposal(id, "failed", { error: reason });
    return { ok: false, reason };
  }
}

/* ------------------------------------------------------------------ */
/* One node becomes one run                                            */
/* ------------------------------------------------------------------ */

export type NodePlan =
  | { ok: true; input: Omit<CreateRunInput, "dependsOn" | "origin"> }
  | { ok: false; reason: string };

/**
 * Turn one node into the run it asks for, or say why not.
 *
 * `planProposal` with the folder moved onto the node — same division of labour,
 * same refusal for a template that has gone, same `composeTask` so the standing
 * instructions and the specific task are joined identically wherever a run is
 * started from something other than the form. Pure: it takes the template and
 * the untemplated guard set rather than reading either.
 *
 * The branch that matters is the one that is not here. No value off a node sets
 * a budget, a permission mode or an isolation choice. The agent is not one of
 * those and never becomes one: it is resolved by the caller for the reason the
 * template is — this function stays pure — and it reaches the run as a
 * definition rather than as a capability.
 */
export function planNode(
  node: WorkflowNode,
  template: RunTemplate | null,
  defaults: RunGuards,
  agent: RegistryAgent | null,
): NodePlan {
  if (node.templateId !== null && !template) {
    return {
      ok: false,
      reason:
        `“${node.name}” names a template that no longer exists, so there are ` +
        "no guards to start it under. Edit the workflow to pick another, or " +
        "none, which uses the guards in Settings.",
    };
  }

  // Refused by name for the template's reason and the registry's own: a run
  // that was to be started as an agent and is started as nobody is bit-for-bit
  // a run that was never given one, and nothing downstream can tell them apart
  // — not the event log, not the cost, not the transcript's own attribution.
  // Under `--agent` the other half is louder: a decayed definition reaches the
  // argv and the spawn fails, every cycle, with the reason only in stderr.
  //
  // Read as truthy rather than against null, unlike the template above it: a
  // graph blob copied onto an instance before this field existed has no key
  // here at all, and `undefined !== null` would refuse every block of every
  // instance still in flight across the upgrade.
  if (node.agentId) {
    const refusal = agentRefusal(node.agentId, agentKnowledgeOf(agent));
    if (refusal) return { ok: false, reason: `“${node.name}”: ${refusal}` };
  }

  const task = node.task.trim();
  if (!task) return { ok: false, reason: `“${node.name}” has no task.` };

  const guards = guardsFor(template, defaults);
  const base = node.promptOverride?.trim() || template?.prompt || null;

  // Truthy for `agentId`'s reason: a graph blob copied onto an instance before
  // the field existed has no key here. The terminus rule is the run form's and
  // the chat's, asked of the guards this run will actually start under.
  const provider = node.provider || null;
  const terminus = providerTerminusRefusal(provider, guards.budget);
  if (terminus) return { ok: false, reason: `“${node.name}”: ${terminus}` };

  return {
    ok: true,
    input: {
      folder: node.folder,
      mountId: node.mountId,
      prompt: composeTask(base, task),
      // Every one of these comes from the template or from settings, and none
      // of them from the node.
      permissionMode: guards.permissionMode,
      isolate: guards.isolate,
      budget: guards.budget,
      // And this one comes from the node and from nowhere else, because it is
      // work rather than permission — see `WorkflowNode.agentId`. Frozen onto
      // the run by `createRun`, so the row keeps what it was started with.
      agent: node.agentId && agent ? agentDefinition(agent) : null,
      // The template's, with the prompt and the guards and not with the agent
      // above it. `planProposal` states the asymmetry and it holds here for the
      // same reason: a node names its own agent and has no model of its own, so
      // the template is where the question was asked. A node deliberately does
      // not grow one — it names a template for the model exactly as it does for
      // the guards, which is what `db.ts`'s "no model on a node" now means.
      //
      // Never on a Codex or local run, whose CLI or server knows none of the
      // Claude ids a template holds: Codex runs its own default, and a local
      // run is given the sign-in's model by `localReady`.
      model: provider === "codex" || provider === "local" ? null : (template?.model ?? null),
      provider,
    },
  };
}

/**
 * A planned run, finished for the local provider: the sign-in's model frozen
 * onto it, or a refusal naming the block when nobody is signed in.
 *
 * Impure, which is why it is not in `planNode`: the sign-in is a row. Read when
 * the run is created, as the run form's door reads it, so a block created an
 * hour into an instance is refused by name rather than started on nothing.
 */
function localReady(
  input: Omit<CreateRunInput, "dependsOn" | "origin">,
  blockName: string,
): NodePlan {
  if (input.provider !== "local") return { ok: true, input };
  const signIn = getLocalSignIn();
  if (!signIn) {
    return {
      ok: false,
      reason:
        `“${blockName}” runs on the local model, and the local provider is ` +
        "signed out. Sign in under Settings and start it again.",
    };
  }
  return { ok: true, input: { ...input, model: input.model ?? signIn.model } };
}

/**
 * The guards a block's runs go under: its template's, or the operator's own.
 *
 * One function rather than the same three-field literal in three places,
 * because the *absence* of a fourth field is what the whole design rests on.
 * `planProposal` states it, `planNode` states it, and an orchestrator block's
 * emitted runs now state it too — and a fourth copy of a spread is a fourth
 * chance for a value off the wire to join it.
 */
function guardsFor(
  template: RunTemplate | null,
  defaults: RunGuards,
): RunGuards {
  return template
    ? {
        permissionMode: template.permissionMode,
        isolate: template.isolate,
        budget: template.budget,
      }
    : defaults;
}

/**
 * Turn one emitted spec into the run it asks for.
 *
 * `planNode` with the *task and folder* coming off the spec instead of off the
 * node — which is exactly and only what an orchestrator block's turn is allowed
 * to decide. Everything else is read from the block a person saved: the mount,
 * the standing instructions, and every guard.
 *
 * There is deliberately no branch in here that reads a guard, a permission mode
 * or an isolation choice off the spec, for the reason `planProposal` has none:
 * `--permission-mode` is not a thing a model should be able to reach for, and
 * this is the one path in the app where nobody looks at the answer before it
 * becomes a process.
 *
 * The **agent is the third thing the turn decides** — who the emitted run *is*
 * — and it belongs with the task and the folder rather than with the guards: an
 * agent is a description and a prompt, it carries no tool list and no permission
 * mode, and every guard below still comes off the block a person saved. It is
 * resolved by
 * the caller — `planEmission` has already refused a name the registry does not
 * have, and this takes the definition that name resolved to.
 */
export function planEmittedRun(
  node: WorkflowNode,
  spec: RunSpec,
  template: RunTemplate | null,
  defaults: RunGuards,
  agent: AgentDefinition | null,
): Omit<CreateRunInput, "dependsOn" | "origin"> {
  const guards = guardsFor(template, defaults);
  const base = node.promptOverride?.trim() || template?.prompt || null;
  return {
    folder: spec.folder,
    mountId: node.mountId,
    prompt: composeTask(base, spec.task),
    permissionMode: guards.permissionMode,
    isolate: guards.isolate,
    budget: guards.budget,
    agent,
    // `planNode`'s inheritance, for its reason, then the model decider's pick
    // where the template named none. The template is read again at this
    // moment, so one given a model after the emission was decided on still
    // wins: a person's answer outranks the decider's. The turn itself still
    // has no way to name a model — `decidedModel` is written by this app, see
    // `RunSpec`. Dropped for Codex and local, `planNode`'s rule.
    model:
      node.provider === "codex" || node.provider === "local"
        ? null
        : (template?.model ?? spec.decidedModel ?? null),
    // The block's, never the spec's: a person saved it, and `emit_runs` has no
    // field that could carry one.
    provider: node.provider || null,
  };
}

/* ------------------------------------------------------------------ */
/* What an orchestrator block may emit — pure                          */
/* ------------------------------------------------------------------ */

/**
 * One run an orchestrator block asks for.
 *
 * Five fields, and the list is the boundary rather than a starting point: a
 * title, the brief, a folder, an agent, and which of its siblings it starts
 * after. There is no template id, no budget, no permission mode, no isolation
 * choice and no model, because the block's own template already answered all of
 * those and a spec that could answer them again would be a fifth route to
 * `--permission-mode` reached by a model with nobody reading the result. The
 * model is the one of those the template answers rather than merely bounds, and
 * the turn still cannot name one. It used to stay off for the reason that a
 * model choosing what a run costs is a choice with nobody in the loop; the
 * operator overruled that on 2026-10-05 for the model decider, which may pick
 * one unattended — see `modelDecider.ts`. So a spec can carry a model, in
 * `decidedModel`, but only one this app wrote after the emission was accepted,
 * never one read off `emit_runs`.
 *
 * The agent is not one of those and cannot become one. An agent is a description
 * and a prompt — the registry refuses a tool list at the door and has no column
 * for a permission mode — so naming one is the same class of act as writing the
 * task text beside it: it decides who the run *is*, and every guard still comes
 * from the block a person saved.
 */
export interface RunSpec {
  /** Stable within one emission; the edges below name it. */
  id: string;
  /** Short label, shown on the instance page in place of a block name. */
  title: string;
  /** The whole brief for the agent, appended to the block's standing prompt. */
  task: string;
  /** Path within the *block's* own folder. `""` is the mount root. */
  folder: string;
  /**
   * A saved agent to start this run **as**, by **name**, or null.
   *
   * A name rather than an id because a name is what the turn was shown — see
   * `blockSystemPrompt` — and it is the registry's own spelling of it rather
   * than the turn's, because the name is the key of the object `--agents` takes
   * *and* the word `--agent` is handed to select it. A misspelling that reached
   * the argv would not be quietly ignored; it would fail the spawn.
   */
  agent: string | null;
  /**
   * The tasks on the board this run is for, by id, in the order named; empty
   * for none.
   *
   * A **record of what prompted the run** and not a sixth field on the list
   * above: it decides nothing about the run — not the guards, not the folder,
   * not who it is. The run claims these when it starts and closes each with its
   * own `complete_task`; the emission itself moves nothing on the board. It is
   * on the spec rather than on the *node* for the reason the task text and the
   * folder are: a saved graph is a shape a person agreed to, and which backlog
   * items a particular pass is working is a decision the turn makes when it
   * gets there.
   */
  taskIds: string[];
  /** Siblings in this same emission that must settle first. */
  dependsOn: Array<{ id: string; edge: DependencyEdge }>;
  /**
   * The model decider's pick, written by `recordEmittedModels` after the
   * emission is stored and never by `normalizeSpec`, which builds a spec field
   * by field so nothing on the wire can reach this. Absent or null takes the
   * template's model, then the operator's default.
   */
  decidedModel?: string | null;
}

export type EmissionPlan =
  | { ok: true; specs: RunSpec[] }
  | { ok: false; reason: string };

/** What a block is measured against when it emits. Injected, so this is pure. */
export interface EmissionLimits {
  blockName: string;
  /** The cap a person saved. Never null — `normalizeWorkflowInput` sees to it. */
  fanOut: number;
  /**
   * Why this folder cannot be used, or null when it can.
   *
   * Injected rather than called, for the reason `WorkflowKnowledge` is: the
   * containment decision is a syscall (`resolveWorkspaceFolder`, run against the
   * block's own mount and no other), and everything else here has to stay
   * testable without one.
   */
  folderRefusal: (folder: string) => string | null;
  /**
   * The registry, as the turn was shown it.
   *
   * Data rather than an injected function, unlike `folderRefusal` beside it:
   * containment is a syscall and this is a list, which is the same split
   * `WorkflowKnowledge` makes between its templates and `folderRefusal`. Only
   * the two fields a refusal is written from — a spec that names an agent gets
   * the whole definition later, from the registry, at the moment its run is
   * created.
   */
  agents: readonly AgentFacts[];
  /**
   * Read a spec's `taskIds` and `relatedTaskIds` against its brief.
   *
   * Injected as a **function** where `agents` beside it is data, and the reason
   * is neither of that field's: the registry is a list somebody curated and the
   * board is a backlog nothing expires, so the board stays behind this call
   * rather than being copied onto a type every test has to fill. `tasks.ts` owns
   * the rule and the wording — `readTaskLinks` — so an unknown id, and a brief
   * naming a task its run is not linked to, read the same here as in a chat.
   */
  taskLinks: (
    fields: { taskIds?: unknown; relatedTaskIds?: unknown; taskId?: unknown },
    text: string,
  ) => TaskLinkReading;
}

/** How many characters of a spec's own fields are worth keeping. */
const MAX_SPEC_TITLE = 80;

/**
 * Read what a block emitted, refusing anything that could not be started.
 *
 * Pure and unit-tested, and it earns that harder than anything else in this
 * file: it is the step where text a model wrote becomes N processes with write
 * access to a directory, with **no person between the two**. Every branch here
 * is silent when it is wrong — a spec past the cap is an agent the operator
 * never agreed to, a folder outside the block's own is an agent in a repository
 * this block was never pointed at, and a loop among the specs is a set of runs
 * that would sit `waiting` for each other for ever.
 *
 * The cap is checked before anything else about the specs, because it is the
 * one refusal the model can act on by emitting fewer.
 *
 * An empty emission is **legal**: "there is nothing to do" is a real answer and
 * the alternative is a block that has to invent work to say so. What it means
 * for the blocks behind it is a separate decision, and `planInstanceStep` makes
 * it.
 */
export function planEmission(raw: unknown, limits: EmissionLimits): EmissionPlan {
  const list = Array.isArray(raw) ? raw : null;
  if (!list) {
    return {
      ok: false,
      reason: "runs has to be a list of run specs, even if it is empty.",
    };
  }

  if (list.length > limits.fanOut) {
    return {
      ok: false,
      reason:
        `“${limits.blockName}” may start at most ${limits.fanOut} run(s) and ` +
        `this asks for ${list.length}. That limit was set when the workflow ` +
        "was saved and cannot be raised from here. Emit the most important " +
        `${limits.fanOut} and say what you left out.`,
    };
  }

  const specs: RunSpec[] = [];
  const byId = new Map<string, RunSpec>();

  for (const [index, entry] of list.entries()) {
    const spec = normalizeSpec(entry, index, limits, byId);
    if (!spec.ok) return spec;
    specs.push(spec.value);
    byId.set(spec.value.id, spec.value);
  }

  const seenPairs = new Set<string>();
  for (const [index, entry] of list.entries()) {
    const e = (entry ?? {}) as Record<string, unknown>;
    const spec = specs[index];
    // Absent is "starts at once"; anything else that is not a list is refused
    // rather than read as absent, because the likeliest other shape is the list
    // sent as a JSON string, and a run told to wait and started at once is
    // bit-for-bit a run that was never told — with nobody reading the emission.
    if (e.dependsOn !== undefined && e.dependsOn !== null && !Array.isArray(e.dependsOn)) {
      return {
        ok: false,
        reason:
          `“${spec.title}” has a dependsOn that is not a list. It has to be a ` +
          "list of {id, edge} objects naming runs in this emission, or left " +
          "out for a run that starts at once.",
      };
    }
    const links = Array.isArray(e.dependsOn) ? e.dependsOn : [];

    for (const link of links) {
      const l = (link ?? {}) as Record<string, unknown>;
      const from = String(l.id ?? "");
      const target = byId.get(from);
      if (!target) {
        return {
          ok: false,
          reason:
            `“${spec.title}” is set to start after “${from}”, which is not one ` +
            "of the runs being emitted. A run can only wait for its siblings " +
            "in this same emission.",
        };
      }
      if (from === spec.id) {
        return { ok: false, reason: `“${spec.title}” is set to start after itself.` };
      }
      const pair = `${from} ${spec.id}`;
      if (seenPairs.has(pair)) {
        return {
          ok: false,
          reason: `“${spec.title}” is set to start after “${target.title}” twice, so it is unclear which condition applies.`,
        };
      }
      seenPairs.add(pair);

      const edge = String(l.edge ?? "");
      if (!(DEPENDENCY_EDGES as readonly string[]).includes(edge)) {
        return {
          ok: false,
          reason: `“${spec.title}” needs a condition for starting after “${target.title}”: ${DEPENDENCY_EDGES.join(" or ")}.`,
        };
      }
      spec.dependsOn.push({ id: from, edge: edge as DependencyEdge });
    }
  }

  // The same detector the run graph and the saved graph use, given the spec ids.
  //
  // This is where "acyclic by construction" stops being an argument. `createRun`
  // mints a run's id *after* reading its edges, so nothing can already point at
  // it — which was the whole reason a cycle was impossible. That still holds for
  // each individual insert, but the graph being inserted is now one a **model**
  // wrote, and creating a cyclic set in topological order is not possible at
  // all: the first spec would name a run that does not exist yet and
  // `createRun` would refuse it as a missing run rather than as the loop it is.
  // So the loop is named here, before anything is created, and
  // `admitDependencies` re-runs the same check over the live graph at every one
  // of those inserts.
  const loop = dependencyCycle(
    specs.flatMap((s) =>
      s.dependsOn.map((d) => ({ runId: s.id, dependsOn: d.id, edge: d.edge })),
    ),
  );
  if (loop) {
    return {
      ok: false,
      reason:
        "These runs wait for each other in a loop, so none of them could ever " +
        `start: ${loop.map((id) => byId.get(id)?.title ?? id).join(" → ")}.`,
    };
  }

  // Returned in the order they will be created, so every spec is created after
  // everything it waits for — the property `startWorkflow` needs of a graph, for
  // the identical reason.
  const { order } = topologicalOrder({
    nodes: specs,
    edges: specs.flatMap((s) => s.dependsOn.map((d) => ({ from: d.id, to: s.id }))),
  });
  return { ok: true, specs: order.map((id) => byId.get(id)!) };
}

type SpecNormalization =
  | { ok: true; value: RunSpec }
  | { ok: false; reason: string };

/**
 * Read one emitted spec, refusing anything that could not be started.
 *
 * `normalizeNode`'s shape one layer over, and deliberately: the two doors admit
 * the same kinds of thing and a refusal one of them makes and the other does not
 * is the gap this file exists to close. `taken` is the ids already accepted from
 * this same emission, for that function's reason — two specs sharing an id makes
 * a dependsOn naming it name both, which is only visible from outside.
 */
function normalizeSpec(
  entry: unknown,
  index: number,
  limits: EmissionLimits,
  taken: ReadonlyMap<string, RunSpec>,
): SpecNormalization {
  const e = (entry ?? {}) as Record<string, unknown>;
  const where = `Run ${index + 1}`;
    const id = String(e.id ?? "").trim();
    if (!NODE_ID.test(id)) {
      return {
        ok: false,
        reason: `${where} has no usable id. An id is 1–64 letters, digits, hyphens or underscores, and the dependsOn entries name it.`,
      };
    }
    if (taken.has(id)) {
      return {
        ok: false,
        reason: `Two runs share the id “${id}”, so a dependsOn naming it names both.`,
      };
    }

    const title = String(e.title ?? "").trim();
    if (!title) return { ok: false, reason: `${where} needs a title.` };

    const task = String(e.task ?? "").trim();
    if (!task) {
      return {
        ok: false,
        reason: `“${title}” has no task. It is the whole brief the agent gets, and it cannot ask a follow-up question.`,
      };
    }

    // `""` is the mount root and a real answer, exactly as it is on a node — so
    // it is never collapsed into "no folder named".
    const folder = String(e.folder ?? "");
    const refusal = limits.folderRefusal(folder);
    if (refusal) {
      return {
        ok: false,
        reason:
          `“${title}” names a folder that cannot be used: ${refusal} A run ` +
          `this block starts has to be inside “${limits.blockName}”'s own ` +
          "workspace; use a folder exactly as list_folders gives it.",
      };
    }

    // The agent, checked here beside the cap and the folder because this is the
    // last moment before these become processes. Refused by name rather than
    // dropped, which is `agentRefusal`'s rule reached from the one door where
    // nobody is looking: a run emitted "as the reviewer" and started as nobody
    // is indistinguishable afterwards from a run that named none.
    const namedAgent = String(e.agent ?? "").trim();
    let agent: string | null = null;
    if (namedAgent !== "") {
      // Case-folded because `idx_agents_name` is, so the name the turn typed
      // and the name the operator saved are one agent here too.
      const match = limits.agents.find(
        (a) => a.name.toLowerCase() === namedAgent.toLowerCase(),
      );
      if (!match) {
        return {
          ok: false,
          reason:
            `“${title}” asks for an agent this install does not have: ` +
            `${namedAgent}. Name one of the agents listed in your instructions, ` +
            "or leave it out — a run started as no agent is the ordinary run.",
        };
      }
      if (!match.usable) {
        return {
          ok: false,
          reason:
            `“${title}” asks for the “${match.name}” agent, which is missing ` +
            "its description or its prompt. Claude Code will not register such " +
            "an agent, so the run would fail the moment it spawned. Name " +
            "another, or leave it out.",
        };
      }
      // The registry's spelling, not the turn's — see `RunSpec.agent`.
      agent = match.name;
    }

    // The board rows this run came off, refused by name rather than dropped —
    // `agentRefusal`'s rule, reached from the door where nobody is looking. A
    // run emitted "for the flaky-auth task" that silently carried no task is
    // indistinguishable afterwards from one that named none, and the operator
    // then reads a board row nothing was ever started for.
    //
    // And a brief that names a task the spec does not link is refused too,
    // which is the failure that made this a list: the run does the work, can
    // close only what it was linked to, and the rest stays open with nothing
    // saying why. A *closed* task is accepted as a link and never counts as a
    // mention — naming finished work is context.
    const links = limits.taskLinks(e, `${title}\n${task}`);
    if (!links.ok) {
      // The spec named rather than the sentence wrapped: what a whole-emission
      // refusal has to add is *which run in the list* carried it, or a model
      // rewrites the wrong one.
      return { ok: false, reason: `“${title}”: ${links.reason}` };
    }

  return {
    ok: true,
    value: {
          id,
          title: title.slice(0, MAX_SPEC_TITLE),
          task,
          folder,
          agent,
          taskIds: links.taskIds,
          dependsOn: [],
    },
  };
}

/* ------------------------------------------------------------------ */
/* Whether a loop takes another pass — pure                            */
/* ------------------------------------------------------------------ */

/** One run of a loop's body, and the one extra fact the loop reads off it. */
export interface LoopRunState extends DependencyState {
  /**
   * Whether the agent actually replied `DONE`.
   *
   * Read instead of the status, and the difference is the whole exit condition:
   * `completed` is written both for that reply *and* for a run that merely used
   * up its cycle cap, and `maxIterations` defaults to 1 — so a loop keyed on the
   * status would stop after its first pass every time, which is a loop that does
   * not loop. `runs.reported_done` is what the agent said.
   */
  reportedDone: boolean;
  /**
   * The operator picked the workflow up past this run — see `leaveRunBehind`.
   * Optional so a state built before the column existed reads as not.
   */
  leftBehind?: boolean;
}

/**
 * One member of one pass — one block of the section, as that pass ran it.
 *
 * A pass is the section instantiated, so its members are of the section's own
 * three kinds, and a reading that knew only about runs would be blind to two of
 * them: an orchestrator member is a ledger row plus the runs it emitted, and a
 * merge member is a ledger row plus whether it landed everything. Either can be
 * the reason a pass is still going, and either can be the reason it stopped.
 *
 * `run` and `block` are alternatives rather than a pair. A member starts life as
 * a `waiting` ledger row; a run member's row is deleted the moment its run
 * exists, so from then on the run is the whole record, and a member that never
 * became a run keeps the row because the row is what carries the reason. Both
 * null is a member whose run row has since been deleted, which `planLoopPass`
 * reads as settled and not completed.
 */
export interface LoopPassMember {
  /** `workflow_instance_runs.node_id`, or the block row's. Carries the pass. */
  memberId: string;
  /** Which block of the section it is, as the instance's own graph names it. */
  nodeId: string;
  /** What the page calls it, for the sentence naming what stopped the loop. */
  name: string;
  /** Which of the section's three kinds it is. */
  kind: WorkflowNodeKind;
  /** The run this member became, or null when it is a block or has gone. */
  run: LoopRunState | null;
  /** The ledger row, for a member that is not a run or has not become one. */
  block: Pick<
    NonNullable<InstanceNodeState["block"]>,
    "status" | "error" | "decided" | "notes"
  > | null;
  /** The runs an orchestrator member started, as their rows stand now. */
  emitted: readonly LoopRunState[];
  /**
   * How many branches with work on them a review member set aside, and 0 for
   * every other kind. `emitted` cannot answer it: it holds what the review
   * approved and says nothing about what it was given.
   */
  workSetAside: number;
}

/** One pass of a loop's section: every member of it, in creation order. */
export interface LoopPass {
  /** 1-based, and the number the page shows. */
  pass: number;
  /**
   * Empty is a real state, not a missing one: a pass whose rows have since been
   * deleted, or a loop from before a section was required, produced nothing. It
   * is the case that would otherwise loop for ever creating nothing at all.
   */
  members: readonly LoopPassMember[];
}

export interface LoopPassInput {
  blockName: string;
  /** Every pass so far, oldest first. */
  passes: readonly LoopPass[];
  /** The cap a person saved. Never null — `normalizeWorkflowInput` sees to it. */
  maxPasses: number;
  /** What the passes may spend together, or null when no cap was set. */
  maxCostUSD: number | null;
  /**
   * What they have spent, the guard's figure: each pass's measured cost plus the
   * reconciled estimate for a cycle killed before it could report. The same
   * `*Guard*` reading `evaluateInstanceBudget` acts on, and for the same reason
   * — a floor would let a loop run on past its cap on cycles that never
   * reported.
   */
  spentGuardUSD: number;
  /**
   * The board condition this loop was saved with, or null when it set none.
   *
   * Null together with `boardCounts` below — the pair `maxCostUSD` and
   * `spentGuardUSD` already are, one field apart: the condition says what to
   * compare and the reading says what was found, and either one missing is the
   * test switched off rather than a comparison against nothing.
   */
  stopWhenTasks: LoopBoardCondition | null;
  /**
   * What the board holds for that project right now, or null when there is no
   * condition to read one for.
   *
   * An input for `spentGuardUSD`'s reason: this function is the decision and
   * the reader is the caller's, so the whole of it stays pure and the one thing
   * that can go silently wrong in the reading — a folder compared against the
   * board unresolved, which matches nothing for ever — is tested where it
   * happens rather than here.
   */
  boardCounts: LoopBoardCounts | null;
}

/** Why a loop stopped, in a word the caller can branch on. */
export type LoopStopCode =
  | "done"
  | "failed"
  | "passes"
  | "cost"
  | "empty"
  | "tasks";

export type LoopDecision =
  /** Create pass `pass`. Nothing else has to be true for it to go ahead. */
  | { kind: "pass"; pass: number }
  /** The last pass has not settled; carry it on, and ask again when it does. */
  | { kind: "wait" }
  | { kind: "stop"; code: LoopStopCode; reason: string };

/**
 * Whether a loop takes another pass, and if not, why it stopped.
 *
 * **The loop unrolls; it is not a back edge.** `dependencyCycle` refuses a
 * cyclic run graph at admission, and the reason is not tidiness:
 * `releasableRuns` reaches a fixed point and leaves a cyclic set alone, so an
 * edge from a pass back to its own block would be precisely the row nothing ever
 * wakes. So each pass is a *fresh* instantiation of the section, the run graph
 * stays a DAG, and every rule written against one — release, folder claim,
 * landing, halt — holds unchanged. `run_deps` never learns that a loop exists.
 * The next reader will reach for the back edge first; this is why there is not
 * one.
 *
 * Pure and unit-tested for `releasableRuns`' reason, sharpened by what a loop
 * costs: a loop that never terminates is billed a whole pass per pass, for ever
 * — and a loop that stops one pass early is silent, because a pass that was
 * going to finish the job simply never happens and the branch looks finished.
 *
 * The order of the tests is load-bearing:
 *
 *   1. **An unsettled pass waits.** Nothing else can be read off a pass that is
 *      still working, and starting the next one on top of it would put two
 *      passes into the same folders at once.
 *   2. **A pass that produced nothing stops it.** Another pass would be created
 *      exactly the same way and fail exactly the same way, which is a hot loop
 *      rather than a retry.
 *   3. **A member that did not complete stops it**, rather than trying again. A
 *      loop is not a retry mechanism: `MAX_TRANSIENT_RETRIES` and the refusal
 *      backoff already sit inside a single run, so a fault that got past them is
 *      one the next pass would meet too. Over members of all three kinds, and
 *      the **merge** member is the one with a sentence of its own: a merge block
 *      that failed still *finished*, so a pass whose merge landed only some of
 *      what it produced looks complete from every other angle. It is not — the
 *      next pass's runs cut fresh branches from the folder, so what was left
 *      behind is invisible to them and they would do it again, billed, in
 *      silence. Stopping names what did not land.
 *   4. **DONE is every run member of the pass reporting it**, not one of them.
 *      A section may run blocks side by side and there is no last-run-of-a-chain
 *      left to read, so one member finishing is not the section finishing. The
 *      alternative considered and rejected was marking one member as the one
 *      whose DONE counts: that is a second control over a fact the members
 *      already carry, it has to be kept in step with the graph as the section
 *      is edited, and every way of setting it wrong ends the loop early and
 *      silently. A pass with **no** run members never reports done — an
 *      orchestrator and a merge alone say nothing about whether the work is
 *      finished, and reading "all of none" as done would stop such a loop after
 *      its first pass, which is a loop that does not loop.
 *      Nor does a pass whose **review** member set aside a branch with work on
 *      it, whichever member's branch it was: that work was turned down and will
 *      not land, so "complete" would be false, and `reviewVerdict`'s contract is
 *      that the loop carries on and the next pass gets another go at it. It is
 *      read per pass rather than traced to the member whose branch it was,
 *      because a branch cannot always be traced — after a fix round its last
 *      link is the fix run, and a review may be handed an orchestrator's runs
 *      or another review's — and since DONE needs every run member, discounting
 *      one is the same answer wherever a trace exists. A branch set aside
 *      because its run committed nothing does not count: it lost no work, and
 *      that run's DONE is the ordinary way such a loop ends, so counting it
 *      would run every loop with a review in it to its pass cap.
 *      It outranks the two caps, so a loop that got there on its last pass says
 *      it finished rather than that it ran out.
 *   5. **The board condition**, below the agent's own word and above the caps.
 *      An agent that said the work is done outranks a board that has not caught
 *      up with it; a board that is clear is the loop *finishing* rather than
 *      running out, so it must not be reported as a cap. It is also the one
 *      test read **before the first pass**: the other four are facts about a
 *      pass that ended, where this is a fact about the board at this moment, so
 *      a loop pointed at a backlog that is already clear starts no run at all —
 *      which is most of what the condition is for.
 *   6. **The caps.** The pass cap before the spend cap: it is the one a person
 *      always set, and the one that has to hold when nothing else does.
 */
/**
 * The project a board condition counts for, as the graph spells it.
 *
 * The mount **id** rather than its label, because this function is pure and a
 * label is a thing only `config.ts` holds — and the id is what the operator
 * picked in the editor, so the sentence names something they can find. The
 * mount root reads as the workspace alone, which is what it is.
 */
function boardProject(condition: LoopBoardCondition): string {
  const place = condition.folder
    ? `${condition.mountId} / ${condition.folder}`
    : condition.mountId;
  // Said out loud rather than left to the graph, because it is the difference
  // between two counts of the same name: a project that counts its subfolders
  // is a wider backlog than the one the board draws under that heading.
  return condition.includeSubfolders ? `${place} and everything under it` : place;
}

/**
 * How a threshold's priority reads in the sentence that names it.
 *
 * `"any"` says nothing, which is the sentence the condition had before it could
 * name a priority at all — "at most 5 open task(s)" rather than "at most 5
 * any-priority open task(s)".
 */
function thresholdPriorityWord(priority: LoopBoardThreshold["priority"]): string {
  return priority === "any" ? "" : `${priority}-priority `;
}

/**
 * Whether one member of a pass can still do anything.
 *
 * Three readings rather than one, because a pass holds three kinds of row and
 * the statuses are different vocabularies — `TERMINAL_STATUSES` for a run,
 * `BlockStatus` for a ledger row. An orchestrator member is settled only once
 * the runs it emitted are too: the member's own row says `emitted` the moment
 * the turn ends, and taking that as the end of it would let the next pass start
 * while a run this one decided on was still working in the folder.
 */
function memberSettled(member: LoopPassMember): boolean {
  if (member.emitted.some((r) => !TERMINAL_STATUSES.includes(r.status))) {
    return false;
  }
  if (member.run) return TERMINAL_STATUSES.includes(member.run.status);
  if (member.block) return !LIVE_BLOCK_STATUSES.includes(member.block.status);
  // Neither row: the run was created and its row has since been deleted. It can
  // never move again, which is what this question asks.
  return true;
}

/**
 * `planLoopPass`'s first rung, on its own because `advanceLoop` asks it before
 * it reads anything else the decision needs — see there.
 */
function passSettled(pass: LoopPass): boolean {
  return pass.members.every(memberSettled);
}

/**
 * Whether one member did the thing it was created to do.
 *
 * The runs an orchestrator member emitted are deliberately **not** read here.
 * They are not members: what to start was the model's decision, and what a
 * failure among them means for the section is stated on the section's own links
 * — the block behind them is released by `on-finish` and not by `on-success`,
 * which is a choice the operator made and this must not overrule.
 */
function memberCompleted(member: LoopPassMember): boolean {
  // A run the operator left behind is waived rather than done: the pass is
  // judged on the members it is still waiting for, which is what leaving one
  // behind asked for.
  if (member.run) return member.run.status === "completed" || member.run.leftBehind === true;
  if (member.block) return member.block.status === "emitted";
  return false;
}

/** How a member ended, in the word the stop sentence uses. */
function memberEnding(member: LoopPassMember): string {
  if (member.run) return member.run.status;
  if (member.block) return member.block.status;
  return "with its run deleted";
}

export function planLoopPass(input: LoopPassInput): LoopDecision {
  const last = input.passes.at(-1);

  if (last) {
    if (!passSettled(last)) return { kind: "wait" };

    if (last.members.length === 0) {
      return {
        kind: "stop",
        code: "empty",
        reason:
          `Pass ${last.pass} of “${input.blockName}” started nothing, so there ` +
          "is nothing to carry on from. Another pass would be created the same " +
          "way.",
      };
    }

    const broken = last.members.find((m) => !memberCompleted(m));
    if (broken) {
      return {
        kind: "stop",
        code: "failed",
        reason:
          broken.kind === "merge"
            ? `Pass ${last.pass} of “${input.blockName}” did not land ` +
              `everything it produced: ${
                broken.block?.error ?? `“${broken.name}” ended ${memberEnding(broken)}.`
              } The next pass would start from a folder that cannot see this ` +
              "pass's work and would do it again, so the loop stopped."
            : `Pass ${last.pass} of “${input.blockName}” did not finish: ` +
              `“${broken.name}” ended ${memberEnding(broken)}. The loop ` +
              "stopped rather than repeating on top of it.",
      };
    }

    // Every run member, and there has to be one — see the docblock. A member
    // left behind says nothing either way about whether the work is done, so it
    // is not asked; a pass whose every run member was left behind claims nothing.
    const runMembers = last.members.filter(
      (m) => m.kind === "run" && m.run?.leftBehind !== true,
    );
    // Work a review turned down is work that will not land, whatever the run
    // that did it said about it — see the docblock.
    const workTurnedDown = last.members.some((m) => m.workSetAside > 0);
    if (
      !workTurnedDown &&
      runMembers.length > 0 &&
      runMembers.every((m) => m.run?.reportedDone === true)
    ) {
      return {
        kind: "stop",
        code: "done",
        reason: `“${input.blockName}” reported the work complete on pass ${last.pass}.`,
      };
    }
  }

  const board = input.stopWhenTasks;
  const counts = input.boardCounts;
  if (board && counts) {
    // **Any of them**, and the first one met is the one the sentence names.
    // That is the operator's own "or", and it is the safe direction: a
    // condition that stops earlier ends a loop that is still billing a whole
    // pass per pass, where an all-of reading would keep one going on a board
    // nobody thought was full.
    for (const threshold of boardThresholds(board)) {
      const left =
        threshold.priority === "any"
          ? counts.total
          : counts.byPriority[threshold.priority];
      if (left > threshold.atMost) continue;
      return {
        kind: "stop",
        code: "tasks",
        // Both numbers and the priority, because "the board is clear enough" is
        // unreadable a day later: the operator has to be able to tell which of
        // up to five lines they wrote is the one that ended the loop.
        reason:
          `“${input.blockName}” was set to repeat until ${boardProject(board)} ` +
          `had at most ${threshold.atMost} ` +
          `${thresholdPriorityWord(threshold.priority)}` +
          `${board.statuses.join(" or ")} task(s) left. It has ${left}.`,
      };
    }
  }

  if (input.passes.length >= input.maxPasses) {
    return {
      kind: "stop",
      code: "passes",
      reason:
        `“${input.blockName}” reached its limit of ${input.maxPasses} pass(es) ` +
        "without reporting the work complete.",
    };
  }

  if (input.maxCostUSD !== null && input.spentGuardUSD >= input.maxCostUSD) {
    return {
      kind: "stop",
      code: "cost",
      reason:
        `“${input.blockName}” has spent ${input.spentGuardUSD.toFixed(2)} of its ` +
        `${input.maxCostUSD.toFixed(2)} limit across ${input.passes.length} pass(es).`,
    };
  }

  return { kind: "pass", pass: input.passes.length + 1 };
}

/**
 * How a loop's ending reads to the block behind it.
 *
 * Pure, tiny and exported because it is the whole of what a successor of a loop
 * can see. A loop used to resolve to the last run of its last pass, so whether
 * the *work* went well was a fact the successor read off that run's status. A
 * pass now lands its own work and the loop hands on no run at all, so the block
 * row is the only thing left to carry it — and a stop code that ended up on the
 * wrong side of this function is an `on-success` successor started after a pass
 * that failed, or one withheld after a loop that finished.
 *
 * Running out of passes or of money is `emitted`: the passes that happened
 * completed, and "it did not get there in time" is what the caps are for. A
 * failed pass and a pass that produced nothing are `failed`, which is the only
 * reading under which `on-success` after a loop means what it says.
 */
export function loopStopStatus(code: LoopStopCode): "emitted" | "failed" {
  return code === "failed" || code === "empty" ? "failed" : "emitted";
}

/**
 * The passes a loop has taken, grouped out of its member rows in creation order.
 *
 * Pure for `planLoopPass`' reason and tested beside it, because the grouping is
 * what that function reads its whole decision off: one pass of six read as six
 * passes of one trips the pass cap five passes early and reports it as running
 * out, and six read as one never trips it at all.
 *
 * The pass number comes off the member id rather than out of a count, and that
 * is what makes a member whose `runs` row has been deleted an **empty slot
 * rather than a missing pass** — the `workflow_instance_runs` row is still
 * there and still says which pass it belongs to, where counting would shorten
 * every pass after it by one.
 *
 * `members` must be in `position` order, which is creation order. A pass's rows
 * are contiguous in it because a pass is only ever started once the one before
 * it has settled, and `nextPosition` only goes up.
 */
export function groupPasses(
  members: readonly LoopPassMember[],
): LoopPass[] {
  const passes: Array<{ key: string; pass: number; members: LoopPassMember[] }> =
    [];
  for (const member of members) {
    const number = passNumberOf(member.memberId);
    // Grouped on a key rather than on the number, so that a member id carrying
    // no pass at all cannot be folded into the pass beside it: it becomes a
    // pass of its own, which is the safe direction. An extra entry in the count
    // can only ever stop a loop early, where a member folded into the wrong
    // pass changes which rows every exit condition is read off.
    const key = number === null ? `id:${member.memberId}` : `pass:${number}`;
    const current = passes.at(-1);
    if (!current || current.key !== key) {
      passes.push({
        key,
        pass: number ?? (current ? current.pass + 1 : 1),
        members: [],
      });
    }
    passes.at(-1)!.members.push(member);
  }
  return passes.map(({ pass, members: of }) => ({ pass, members: of }));
}

/* ------------------------------------------------------------------ */
/* What the instance does next — pure                                  */
/* ------------------------------------------------------------------ */

/**
 * Where one non-run block of an instance has got to.
 *
 * A lifecycle rather than an orchestrator's vocabulary, which is why a merge
 * block reuses it verbatim instead of adding two statuses of its own: `thinking`
 * is "a child of this block is in flight", `emitted` is "it finished and did its
 * thing". Every liveness query, every halt and every boot reconciler keys on
 * those two words, and a fourth and fifth would be five more places to remember
 * — one of them missed being a merge running under an instance the page says is
 * stopped. The page says "merging" and "merged" for a merge block; the column
 * says what the machinery reads.
 *
 * `looping` is the one exception, and it is an exception rather than a
 * precedent. A loop block is not a child in flight: between passes it has no
 * child at all and is still not settled, because it may yet commit another pass
 * to the branch — so `thinking` would be a lie for the gap and `emitted` would
 * release the block behind it into a branch the loop is still writing to. It
 * therefore counts as live everywhere `thinking` does, and every one of the
 * places this docblock warns about has to name it too.
 */
export type BlockStatus =
  | "waiting"
  | "thinking"
  | "looping"
  | "emitted"
  | "failed"
  | "blocked";

/**
 * The three statuses a block has not settled in, as one list.
 *
 * Named because `planLoopPass` asks the question of a member it cannot write a
 * SQL literal for, and the list has to be the same one the queries around it
 * spell out — `looping` included, which is the whole of what the docblock above
 * warns about.
 */
const LIVE_BLOCK_STATUSES: readonly BlockStatus[] = [
  "waiting",
  "thinking",
  "looping",
];

/** One node of an instance as the scheduler sees it. */
export interface InstanceNodeState {
  /** The run this node became, or null when it has not been created. */
  run: DependencyState | null;
  /**
   * The operator picked the workflow up past `run` — see `leaveRunBehind`. Its
   * successors stop waiting on it and resolve to no run through it, so a merge
   * behind it does not land its branch.
   */
  leftBehind?: boolean;
  /**
   * The ledger row: an orchestrator block's turn, or a run block that was
   * never created because nothing in front of it could hand it any work.
   */
  block: {
    status: BlockStatus;
    /**
     * The runs an orchestrator block started, as their rows stand now — less
     * any the operator left behind, which are counted in `leftBehind` instead.
     */
    emitted: readonly DependencyState[];
    /** How many of the block's runs were left behind, and so are not above. */
    leftBehind?: number;
    /**
     * How many runs its turn decided on — the accepted emission, whether or not
     * each could then be created. Absent reads as none.
     */
    decided?: number;
    /** This app's notes on the turn, which say why a decided run never started. */
    notes?: readonly string[];
    /** Why it ended this way, for the sentence its successors carry. */
    error: string | null;
  } | null;
}

/** One node that may now be created, with the edges it resolves to. */
export interface InstanceCreation {
  nodeId: string;
  dependsOn: Array<{
    runId: string;
    edge: DependencyEdge;
    continueBranch: boolean;
  }>;
}

/** One merge block that may now run, with the runs whose branches it lands. */
export interface InstanceMerge {
  nodeId: string;
  /**
   * The runs its satisfied edges resolved to, in the order the graph declared
   * them — which becomes the queue's `position`, so two presses of Run on one
   * graph land the same branches in the same order.
   *
   * Taken from the same `dependsOn` a run block would have been created with,
   * rather than re-derived from the edges: which runs an orchestrator block
   * turned out to emit is a fact only `edgeVerdict` has, and a second reading of
   * it is a second chance to land a different set.
   */
  runIds: string[];
}

export interface InstanceStep {
  /** Orchestrator blocks whose turn may start now. */
  spawn: string[];
  /** Merge blocks whose branches may now be queued. */
  merge: InstanceMerge[];
  /**
   * Review blocks whose branches may now be reviewed, in `InstanceMerge`'s
   * shape and for its reason: which runs an orchestrator block turned out to
   * emit is a fact only `edgeVerdict` has.
   */
  review: InstanceMerge[];
  /** Run blocks that may now be created. */
  create: InstanceCreation[];
  /**
   * Loop blocks whose first pass may now be created. Only the first: every pass
   * after it is decided by `planLoopPass` off the pass before it, which is what
   * keeps the unrolling one link at a time.
   */
  loop: InstanceCreation[];
  /** Nodes that can never start, each with the sentence naming what stopped it. */
  block: Array<{ nodeId: string; reason: string }>;
}

/** What an edge into a node says about whether that node may go ahead. */
type EdgeVerdict =
  | { kind: "satisfied" }
  | { kind: "pending" }
  | { kind: "blocked"; reason: string };

const PENDING: EdgeVerdict = { kind: "pending" };
const SATISFIED: EdgeVerdict = { kind: "satisfied" };

/**
 * What an instance may do right now: which turns to start, which blocks to
 * create, and which can never happen at all.
 *
 * Pure and unit-tested, and it is `releasableRuns` for the half of a graph that
 * is not runs yet — with the same two silent failures. A block released too
 * early is an agent started on work that has not happened; a block neither
 * released nor terminated is a row that sits `waiting` for ever, which for an
 * orchestrator block means the whole subgraph behind it never starts and
 * nothing on the page says why.
 *
 * **An orchestrator block that emitted nothing blocks what is behind it.** That
 * is a decision rather than a fallout, and it is `edgeSatisfied`'s rule read one
 * level up: a dependency that ran no work cycle satisfies nothing, because the
 * successor's whole reason for existing is work that did not happen. A block
 * behind a fan-out is there to review it, land it, or follow it up; started with
 * nothing in front of it, it spends a billed cycle discovering that. Blocked
 * costs nothing and says which block decided there was nothing to do.
 *
 * A node is considered only when every edge into it is *satisfied* rather than
 * merely resolvable, which is why the runs an orchestrator block emitted have to
 * finish before the block behind them is created. That costs nothing — a node
 * that has not been created holds no folder, no checkout and no place in the
 * queue, which is exactly what `waiting` was invented for — and it means the
 * edges are recorded on a run that `admitDependencies` then re-checks.
 *
 * The pass repeats to a fixed point, and that loop is the cascade: a node
 * blocked here is a settled predecessor that produced nothing, so everything
 * behind it blocks on the next pass with its own sentence naming the node in
 * front of it rather than one shared verdict about a block it never heard of.
 */
export function planInstanceStep(
  graph: WorkflowGraph,
  state: ReadonlyMap<string, InstanceNodeState>,
): InstanceStep {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  // The blocks some loop repeats. They are not nodes this function may act on:
  // a body member becomes one run **per pass**, created by the loop, so a
  // member created here as well would be an extra run on the same folder that
  // nothing ever repeats and nothing counts against the pass cap. Skipped
  // rather than blocked, because `blocked` is a sentence about work that will
  // not happen and this work happens on every pass.
  const inABody = loopBodyOwners(graph);
  const incoming = new Map<string, WorkflowDependencyEdge[]>();
  for (const e of graph.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    // A `repeats` link states containment and is **never** a dependency. Read
    // as one it is the back edge this whole design is built to avoid:
    // `releasableRuns` would leave the loop `waiting` for a run that is only
    // ever created by the loop, and the instance would never finish. Dropped by
    // its own condition rather than left to the membership test below, because
    // that is the fact the drop rests on and a test holds it here.
    if (!isDependencyEdge(e)) continue;
    // The same for every other edge touching a body member, which after the
    // boundary rule is only the loop's own link to whatever runs after it.
    if (inABody.has(e.from) || inABody.has(e.to)) continue;
    const list = incoming.get(e.to);
    if (list) list.push(e);
    else incoming.set(e.to, [e]);
  }

  // A working copy, so a node blocked in one pass is a blocked *predecessor* in
  // the next without writing anything.
  const live = new Map<string, InstanceNodeState>();
  for (const node of graph.nodes) {
    live.set(node.id, state.get(node.id) ?? { run: null, block: null });
  }

  const step: InstanceStep = {
    spawn: [],
    merge: [],
    review: [],
    create: [],
    loop: [],
    block: [],
  };
  const decided = new Set<string>();

  for (;;) {
    let changed = false;

    for (const node of graph.nodes) {
      if (decided.has(node.id)) continue;
      if (inABody.has(node.id)) continue;
      const own = live.get(node.id)!;
      // Already a run, or a block that has started or settled: not this
      // function's business any more. `releasableRuns` owns a created run from
      // here on, and a `thinking` block owns itself until its child returns.
      // A `waiting` ledger row is the *only* state that is still open, and it
      // means the same thing for both kinds — nothing has happened yet.
      if (own.run || (own.block && own.block.status !== "waiting")) continue;

      let stopper: string | null = null;
      let pending = false;
      const dependsOn: InstanceCreation["dependsOn"] = [];

      for (const edge of incoming.get(node.id) ?? []) {
        const from = byId.get(edge.from)!;
        const verdict = edgeVerdict(from, live.get(from.id)!, edge, dependsOn);
        if (verdict.kind === "blocked") {
          stopper = verdict.reason;
          break;
        }
        if (verdict.kind === "pending") pending = true;
      }

      if (stopper !== null) {
        step.block.push({ nodeId: node.id, reason: stopper });
        live.set(node.id, {
          run: null,
          block: { status: "blocked", emitted: [], error: stopper },
        });
      } else if (pending) {
        continue;
      } else if (node.kind === "orchestrator") {
        step.spawn.push(node.id);
      } else if (node.kind === "merge") {
        // Deduplicated, because two edges can resolve to one run: a diamond
        // whose branches meet again at the merge block. Queueing a branch twice
        // is refused by `enqueue` anyway, which would refuse the *whole* merge.
        step.merge.push({
          nodeId: node.id,
          runIds: [...new Set(dependsOn.map((d) => d.runId))],
        });
      } else if (node.kind === "review") {
        // Deduplicated for the merge block's reason: a diamond meeting again
        // here would review one branch twice, and the item table would refuse
        // the second.
        step.review.push({
          nodeId: node.id,
          runIds: [...new Set(dependsOn.map((d) => d.runId))],
        });
      } else if (node.kind === "loop") {
        step.loop.push({ nodeId: node.id, dependsOn });
      } else {
        step.create.push({ nodeId: node.id, dependsOn });
      }
      decided.add(node.id);
      changed = true;
    }

    if (!changed) return step;
  }
}

/**
 * What one edge says, and — when it says "go ahead" — which runs it resolves to.
 *
 * The four kinds of predecessor answer differently, and the differences are the
 * whole point of the three that are not runs. A run block is one run, decided
 * when the graph was written. An orchestrator block is however many runs it
 * turned out to emit, and a successor waits for *all* of them, which is
 * `admitDependencies`' fan-in rule applied to a fan-in nobody could write down.
 * A merge block resolves to **no runs at all** — it created none — so it can
 * only sequence what follows it, which is exactly what a block set to run "after
 * the work has landed" is asking for. A loop block resolves to none either, and
 * for the *same* reason one kind along: each of its passes lands its own work
 * through the section's own exit, so by the time it hands on there is no branch
 * left to carry and nothing to wait for but the landing. See `loopVerdict`.
 *
 * One reader, and a pass of a loop is what makes that load-bearing rather than
 * tidy: a pass is the section run as a graph through this same function, so a
 * second reading of what an edge means would be a second answer to "may this
 * member go now" — and the member left waiting for ever would be one of the two
 * that answered differently.
 */
function edgeVerdict(
  from: WorkflowNode,
  state: InstanceNodeState,
  edge: WorkflowDependencyEdge,
  dependsOn: InstanceCreation["dependsOn"],
): EdgeVerdict {
  if (from.kind === "merge") {
    const block = state.block;
    if (!block || block.status === "waiting" || block.status === "thinking") {
      return PENDING;
    }
    if (block.status === "blocked") {
      return {
        kind: "blocked",
        reason: `“${from.name}” never ran: ${block.error ?? "no reason recorded."}`,
      };
    }
    // A merge block that failed still *finished*, having tried, which is what
    // separates it from one that never ran — the same distinction
    // `edgeSatisfied` draws between a run that did a cycle and a run that did
    // not. So `on-finish` is satisfied by it and `on-success` is not, and the
    // condition on the edge decides rather than one blanket rule: "review it
    // whether or not it landed" and "only once it is on main" are both things a
    // person writes, and there is no defensible default between them.
    if (block.status === "failed" && edge.edge === "on-success") {
      return {
        kind: "blocked",
        reason: `“${from.name}” did not land everything it was given: ${block.error ?? "the merge failed."}`,
      };
    }
    // Nothing is pushed onto `dependsOn`: a merge block created no run, so a
    // successor of it depends on no run through this edge. A successor with no
    // other predecessor is created with an empty dependency list, which is an
    // ordinary queued run — "start once the work has landed".
    return SATISFIED;
  }

  if (from.kind === "loop") return loopVerdict(from, state, edge);

  if (from.kind === "review") return reviewVerdict(from, state, edge, dependsOn);

  if (from.kind === "run") {
    if (!state.run) {
      // Not created yet. Still `waiting` means it is behind a decision that has
      // not been made; anything else means it never will be, which is the
      // cascade one link along.
      if (state.block && state.block.status !== "waiting") {
        return {
          kind: "blocked",
          reason: `Set to start after “${from.name}”, which never ran: ${state.block.error ?? "no reason recorded."}`,
        };
      }
      return PENDING;
    }
    // Waived: nothing waits on it and nothing is resolved through it, whatever
    // the edge's condition. No `dependsOn` entry, so a merge behind it leaves
    // its branch where it is and a successor starts fresh rather than on it.
    if (state.leftBehind) return SATISFIED;
    if (edgeSatisfied(state.run, edge.edge)) {
      dependsOn.push({
        runId: state.run.id,
        edge: edge.edge,
        continueBranch: edge.continueBranch,
      });
      return SATISFIED;
    }
    if (TERMINAL_STATUSES.includes(state.run.status)) {
      return {
        kind: "blocked",
        reason: `Set to start after “${from.name}”, which ended ${state.run.status}.`,
      };
    }
    return PENDING;
  }

  const block = state.block;
  if (!block || block.status === "waiting" || block.status === "thinking") {
    return PENDING;
  }
  if (block.status === "failed") {
    return {
      kind: "blocked",
      reason: `“${from.name}” could not decide what to start: ${block.error ?? "the turn failed."}`,
    };
  }
  if (block.status === "blocked") {
    return {
      kind: "blocked",
      reason: `“${from.name}” never ran: ${block.error ?? "no reason recorded."}`,
    };
  }

  // Emitted. Nothing to follow is the deliberate refusal — see `planInstanceStep`.
  // A block whose every run was left behind is not that: it did start work, and
  // the operator chose to carry on without it, so it resolves to no run at all.
  if (block.emitted.length === 0 && !block.leftBehind) {
    // Blocked either way, since there is nothing to follow — but a block that
    // decided on runs this app then failed to create is this app's failure, not
    // the model's decision, and the sentence is how an operator tells the two
    // apart. The notes are where `createEmitted` wrote why.
    const decided = block.decided ?? 0;
    if (decided > 0) {
      const notes = (block.notes ?? []).join(" ");
      return {
        kind: "blocked",
        reason:
          `“${from.name}” decided on ${decided} run(s), but none of them could ` +
          `be started, so there is no work for this block to follow. ${
            notes || "No reason was recorded."
          }`,
      };
    }
    return {
      kind: "blocked",
      reason:
        `“${from.name}” decided there was nothing to start, so there is no ` +
        "work for this block to follow.",
    };
  }

  let pending = false;
  for (const run of block.emitted) {
    if (edgeSatisfied(run, edge.edge)) continue;
    if (TERMINAL_STATUSES.includes(run.status)) {
      return {
        kind: "blocked",
        reason: `Set to start after every run “${from.name}” started; one of them ended ${run.status} without qualifying.`,
      };
    }
    pending = true;
  }
  if (pending) return PENDING;

  for (const run of block.emitted) {
    dependsOn.push({ runId: run.id, edge: edge.edge, continueBranch: false });
  }
  return SATISFIED;
}

/**
 * What a loop block says to the block behind it.
 *
 * It resolves to **no runs at all**, exactly as a merge block does, and for the
 * same reason: by the time a loop hands on, every pass has landed its own work
 * through the section's own exit, so there is no branch of its own left and no
 * run for a successor to be told to start after. A successor of a loop is a
 * successor of a landing — "start once the work is on the target" — which is an
 * ordinary queued run with an empty dependency list when nothing else is in
 * front of it. A `continueBranch` link out of a loop is refused at save for the
 * other half of that fact: the ref a successor would carry on was landed and may
 * since have been deleted.
 *
 * So the block row is the only thing left to read, which is why `settleLoop`
 * writes `failed` rather than `emitted` for a loop that stopped on a pass that
 * did not finish — see `loopStopStatus`. `on-finish` is satisfied by either and
 * `on-success` only by `emitted`, which is `edgeVerdict`'s own reading of a
 * merge block one kind over.
 *
 * `looping` is pending rather than settled, and that is what stops a successor
 * being created between two passes: the block can still commit another whole
 * pass to the folders behind it.
 */
function loopVerdict(
  from: WorkflowNode,
  state: InstanceNodeState,
  edge: WorkflowDependencyEdge,
): EdgeVerdict {
  const block = state.block;
  if (
    !block ||
    block.status === "waiting" ||
    block.status === "looping" ||
    block.status === "thinking"
  ) {
    return PENDING;
  }
  // A loop that stopped on a pass that did not finish still *took* passes, which
  // is what separates it from one that never ran — the distinction `edgeVerdict`
  // already draws for a merge block, and the condition on the edge decides
  // rather than one blanket rule. "Clean up after it however it went" and "only
  // once every pass landed" are both things a person writes, and there is no
  // defensible default between them. One sentence for both ways a loop is
  // `failed` — a pass that did not finish, and the machinery around it giving up
  // — because the operator reads the reason rather than the classification.
  if (block.status === "failed" && edge.edge === "on-success") {
    return {
      kind: "blocked",
      reason: `“${from.name}” did not finish what it repeats: ${block.error ?? "the block failed."}`,
    };
  }
  if (block.status === "blocked") {
    return {
      kind: "blocked",
      reason: `“${from.name}” never ran: ${block.error ?? "no reason recorded."}`,
    };
  }
  // Emitted. Nothing is pushed onto `dependsOn` — see above.
  return SATISFIED;
}

/**
 * What a review block says to the block behind it: the branches it approved,
 * and nothing it set aside.
 *
 * It resolves to the **approved** runs — each one the last link of its branch,
 * which after a fix round is the fix run rather than the run the review began
 * with — and a successor depends on those, so a merge block behind it lands
 * exactly what a frontier model signed off on. A branch it set aside is simply
 * not in the list: that is the outcome the operator asked for, "ignored by the
 * merge", and it is why a block that set everything aside is satisfied with no
 * runs rather than blocked — the merge behind it then settles with nothing to
 * land, and a loop around it carries on instead of stopping on a pass whose
 * work was reviewed and turned down. `edgeSatisfied` is not asked of an
 * approved run: the review is the verdict on it, and a branch whose last run
 * asked for review is still one a frontier model approved.
 *
 * A review block that **failed** — the machinery around it rather than a
 * verdict, a restart mid-review for instance — resolves to nothing either way,
 * blocked on both conditions: nothing it was given has been judged, and
 * landing unjudged work is the one thing this block exists to prevent.
 */
function reviewVerdict(
  from: WorkflowNode,
  state: InstanceNodeState,
  edge: WorkflowDependencyEdge,
  dependsOn: InstanceCreation["dependsOn"],
): EdgeVerdict {
  const block = state.block;
  if (!block || block.status === "waiting" || block.status === "thinking") {
    return PENDING;
  }
  if (block.status === "blocked") {
    return {
      kind: "blocked",
      reason: `“${from.name}” never ran: ${block.error ?? "no reason recorded."}`,
    };
  }
  if (block.status === "failed") {
    return {
      kind: "blocked",
      reason: `“${from.name}” could not review what was in front of it: ${block.error ?? "the block failed."}`,
    };
  }
  for (const run of block.emitted) {
    dependsOn.push({ runId: run.id, edge: edge.edge, continueBranch: false });
  }
  return SATISFIED;
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

interface WorkflowRow {
  id: string;
  name: string;
  graph: string;
  created_at: number;
  updated_at: number;
  instance_budget: string | null;
}

const WORKFLOW_COLUMNS =
  "id, name, graph, created_at, updated_at, instance_budget";

/**
 * A stored budget blob as a policy. Null, unparseable and `{}` all read the
 * same: every limit off, which is what a workflow saved before this column
 * existed had.
 */
function parseInstanceBudget(raw: string | null): InstanceBudgetPolicy {
  if (!raw) return normalizeInstanceBudget(null);
  try {
    return normalizeInstanceBudget(JSON.parse(raw));
  } catch {
    return normalizeInstanceBudget(null);
  }
}

/**
 * A stored row as the rest of the app sees it.
 *
 * An unreadable blob yields an empty graph rather than throwing: the list page
 * has to keep rendering, and a workflow with no blocks is refused by every
 * route that would start it.
 */
function rowToWorkflow(row: WorkflowRow): Workflow {
  let graph: WorkflowGraph = { nodes: [], edges: [] };
  try {
    const parsed = JSON.parse(row.graph) as Partial<WorkflowGraph>;
    graph = {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
    };
  } catch {
    /* left empty — see above */
  }
  return {
    id: row.id,
    name: row.name,
    graph,
    instanceBudget: parseInstanceBudget(row.instance_budget),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Turn SQLite's unique-index violation into the sentence the form shows. */
function withNameConflict<T>(name: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    const code = String((err as { code?: unknown } | null)?.code ?? "");
    if (code.startsWith("SQLITE_CONSTRAINT")) {
      throw new Error(
        `A workflow called “${name}” already exists. Rename this one, or ` +
          `open that workflow and edit it.`,
      );
    }
    throw err;
  }
}

export function listWorkflows(): Workflow[] {
  const rows = db()
    .prepare(
      `SELECT ${WORKFLOW_COLUMNS} FROM workflows ORDER BY name COLLATE NOCASE`,
    )
    .all() as WorkflowRow[];
  return rows.map(rowToWorkflow);
}

export function getWorkflow(id: string): Workflow | null {
  const row = db()
    .prepare(`SELECT ${WORKFLOW_COLUMNS} FROM workflows WHERE id = ?`)
    .get(id) as WorkflowRow | undefined;
  return row ? rowToWorkflow(row) : null;
}

export function createWorkflow(input: WorkflowInput): Workflow {
  const id = randomUUID();
  const now = Date.now();
  withNameConflict(input.name, () =>
    db()
      .prepare(
        `INSERT INTO workflows (id, name, graph, instance_budget, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        JSON.stringify(input.graph),
        JSON.stringify(input.instanceBudget),
        now,
        now,
      ),
  );
  return getWorkflow(id)!;
}

/** Null when there is no such workflow — the caller answers 404. */
export function updateWorkflow(
  id: string,
  input: WorkflowInput,
): Workflow | null {
  if (!getWorkflow(id)) return null;
  withNameConflict(input.name, () =>
    db()
      .prepare(
        "UPDATE workflows SET name = ?, graph = ?, instance_budget = ?," +
          " updated_at = ? WHERE id = ?",
      )
      .run(
        input.name,
        JSON.stringify(input.graph),
        JSON.stringify(input.instanceBudget),
        Date.now(),
        id,
      ),
  );
  return getWorkflow(id);
}

/**
 * The name a copy of `sourceName` is saved under: `"<name> copy"`, then
 * `"<name> copy 2"`, …, the first that none of `takenNames` already holds.
 *
 * The name is bounded, and the suffix pushes a long one over the limit. The
 * original is trimmed to make room rather than the copy refused — a duplicate
 * that cannot be made because the name is long is a dead end on a button with
 * one job — and it is trimmed *before* the candidate is tested, because a name
 * cut after the test is never tested: an 80-character workflow's copy came out
 * as the original's own name, and a 77-character one's second copy as its first.
 */
export function pickDuplicateName(
  sourceName: string,
  takenNames: readonly string[],
): string {
  // The unique index on `workflows.name` is `COLLATE NOCASE`, which folds the
  // 26 ASCII capitals and nothing else. A wider fold only skips names the
  // index would accept; a locale-dependent one (Turkish "I") would pass a name
  // it refuses.
  const fold = (name: string) =>
    name.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const taken = new Set(takenNames.map(fold));
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? " copy" : ` copy ${n}`;
    const candidate =
      trimForSuffix(sourceName, MAX_WORKFLOW_NAME - suffix.length) + suffix;
    if (!taken.has(fold(candidate))) return candidate;
  }
}

function trimForSuffix(name: string, room: number): string {
  let cut = name.slice(0, room);
  // Half a surrogate pair is written to SQLite as replacement characters, so
  // the stored name would differ from the candidate tested here, and the next
  // copy would pass the test and collide.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  // A cut that lands just after a space would otherwise read "…x  copy".
  return cut.trimEnd();
}

/**
 * A copy, named so it can be saved beside the original.
 *
 * Node ids are kept: they are unique within a graph and nothing outside one
 * refers to them, so renaming them would only make the copy diff differently
 * from the original for no benefit.
 */
export function duplicateWorkflow(id: string): Workflow | null {
  const source = getWorkflow(id);
  if (!source) return null;

  return createWorkflow({
    name: pickDuplicateName(
      source.name,
      listWorkflows().map((w) => w.name),
    ),
    graph: source.graph,
    instanceBudget: source.instanceBudget,
  });
}

/**
 * Deleting a workflow takes its instance records with it and touches no run.
 *
 * The runs it started carry their own prompt, guards and history, exactly as a
 * template's do — so nothing becomes unreadable and no work is lost. What goes
 * is this workflow's own record of having been pressed, which is the relation
 * `chat_proposals` has to `chat_sessions`.
 */
export function deleteWorkflow(id: string): boolean {
  const res = db().prepare("DELETE FROM workflows WHERE id = ?").run(id);
  return res.changes > 0;
}

/* ------------------------------------------------------------------ */
/* Instances                                                           */
/* ------------------------------------------------------------------ */

/**
 * Where one press of Run has got to.
 *
 * Four of the six are read off the members rather than stored, for one reason:
 * `workflow_instances.status` records what has been *done to* an instance — it
 * was rolled back, or a halt closed its door — and never what its members have
 * got to, which is a fact about the runs and the blocks. Nothing would write
 * that second fact: a signalled child takes seconds to die, and a graph whose
 * last member settles has nobody left to run a closing pass at all, least of
 * all after a restart.
 *
 * So `stopping` and `stopped` are one halted row, told apart by whether a
 * member is still live; and `started`, `finished` and `blocked` are one unhalted
 * row, told apart by whether anything is still live and whether anything was
 * written off. `finished` says the graph reached its end, not that every member
 * succeeded — how a member ended is on the member's own row, and a word here
 * that claimed otherwise would be this app reporting a failed run as work that
 * landed.
 */
export type WorkflowInstanceStatus =
  | "started"
  | "finished"
  | "blocked"
  | "failed"
  | "stopping"
  | "stopped";

/**
 * Whether anything may still happen to this instance.
 *
 * The three unhalted readings are one fact to everything that *acts* on an
 * instance: nobody has stopped it, so it may still create runs, spend, and be
 * stopped. Each of those sites tested `status === "started"` when that was the
 * only word for an unhalted row, and each would have quietly closed a door that
 * is open the moment `finished` and `blocked` were split out of it — a stop
 * answering "this run is already stopping" over a graph that had finished on
 * its own, a deferred block never created behind a member that had settled.
 * Named rather than repeated, so widening the vocabulary again is one edit.
 */
function instanceIsOpen(status: WorkflowInstanceStatus): boolean {
  return status === "started" || status === "finished" || status === "blocked";
}

/** What halted an instance. `null` on an instance nobody has stopped. */
export type HaltCauseKind = "operator" | "guard" | "fleet";

export interface WorkflowInstanceNode {
  nodeId: string;
  nodeName: string;
  position: number;
  runId: string;
  /** The orchestrator block that started this run, or null for a saved block. */
  emittedBy: string | null;
  /** When the workflow was picked up past this run — see `leaveRunBehind`. */
  leftBehindAt?: number | null;
}

/** One block of an instance that is not a run. See `workflow_instance_blocks`. */
export interface WorkflowInstanceBlock {
  nodeId: string;
  nodeName: string;
  position: number;
  kind: WorkflowNodeKind;
  status: BlockStatus;
  startedAt: number | null;
  finishedAt: number | null;
  /** The turn's own spend. Never a run's, never a meter's. */
  costUSD: number;
  /**
   * True when a turn of this block ended without the CLI reporting a cost.
   * `costUSD` is then a floor over the turns that *did* report, and 0 means
   * nothing was measured rather than that nothing was spent.
   */
  costUnknown: boolean;
  tokens: number;
  /**
   * What it decided on: an orchestrator block's accepted specs, a loop's
   * passes. 0 is an answer, not "not yet". Not how many runs exist — see
   * `started`.
   */
  emitted: number;
  /**
   * How many runs name this block as the one that created them — for an
   * orchestrator block, how many of `emitted` became runs. Fewer is a decided
   * spec `createEmitted` could not create, and its note says why.
   */
  started: number;
  /**
   * Whether the turn ever called `emit_runs`. What separates the two ways a
   * block starts nothing: one decided there was nothing worth doing, the other
   * never got as far as deciding. Both read `emitted: 0`.
   */
  decided: boolean;
  /** What the turn replied, verbatim. Null on a turn that failed or said nothing. */
  reply: string | null;
  /** This app's own record of the turn — a refusal, a denial. Never the model's. */
  notes: string[];
  /** Branches a merge block put onto their target. 0 on every other kind. */
  branchesLanded: number;
  /**
   * Branches a merge block did not land, including the ones the queue never
   * attempted because the checkout stopped that repository. Counted apart from
   * `branchesLanded` rather than subtracted, because "landed three of four" and
   * "landed three of three" are different facts and only one needs attention.
   */
  branchesFailed: number;
  error: string | null;
}

export interface WorkflowInstance {
  id: string;
  workflowId: string;
  /** The workflow's name when Run was pressed. */
  workflowName: string;
  /** The graph as it was then, so a later edit cannot rewrite the record. */
  graph: WorkflowGraph;
  createdAt: number;
  status: WorkflowInstanceStatus;
  error: string | null;
  /** When the halt closed the door — not when the last child died. */
  stoppedAt: number | null;
  stopCause: HaltCauseKind | null;
  /** A guard's verdict in full. Null for an operator's stop, which needs none. */
  stopReason: string | null;
  /** Members that have not finished. Non-zero under `stopping`. */
  liveRunCount: number;
  /**
   * Members that never ran, because something in front of them did not satisfy
   * its edge. What separates a graph that reached its end from one whose tail
   * was written off — both have nothing live, and only this says which.
   */
  blockedCount: number;
  /**
   * The limits this press of Run was started under — a copy taken then, never
   * the live workflow's. Editing the workflow must not move the guard an
   * instance is already being measured against, which is the rule the `graph`
   * blob beside it already follows.
   */
  instanceBudget: InstanceBudgetPolicy;
  /**
   * Which press of Run started it, and what authorised that press. Copied onto
   * every member's own `runs.origin`, and read again when a deferred node
   * becomes a run hours later. Null on instances written before the column.
   */
  origin: RunOrigin | null;
  originRef: string | null;
  /** What its blocks have spent: a measured floor and the guard's figure. */
  spend: InstanceSpend;
  nodes: WorkflowInstanceNode[];
  /** Orchestrator turns, and blocks that never became runs. */
  blocks: WorkflowInstanceBlock[];
}

interface InstanceRow {
  id: string;
  workflow_id: string;
  workflow_name: string;
  graph: string;
  created_at: number;
  status: string;
  error: string | null;
  stopped_at: number | null;
  stop_cause: string | null;
  stop_reason: string | null;
  instance_budget: string | null;
  origin: string | null;
  origin_ref: string | null;
}

/**
 * What one press of Run has spent, in the two figures a budget decision needs.
 *
 * `spentUSD` is the sum of what each member's own CLI measured and reported
 * through its `result` event — a **floor**, because a cycle in flight has
 * reported nothing and contributes zero for its whole duration. `spentGuardUSD`
 * adds the two readings that exist precisely for that gap:
 *
 *  - `spent_usd_est`, a member's reconciled estimate for cycles that were
 *    killed before they could report, and
 *  - `telemetrySpendSince(runId, active_started_at)` for the cycle a member has
 *    in flight right now — the only reading in this app that moves *during* a
 *    cycle.
 *
 * That second one is a deliberate widening of the telemetry door. It was one
 * run reading its own current cycle for its own live guard; it is now also an
 * instance reading each member's current cycle for the instance guard. Same
 * function, same per-run and per-cycle bound, same destination — a `*Guard*`
 * figure that no display and no meter ever sees. Nothing here reaches
 * `runs.spent_usd`, `buildSnapshot()` or the dashboard.
 *
 * Bounded to `running` members for the telemetry half, for the reason
 * `fmtCycleInFlight` refuses the column on any other status: nothing clears
 * `active_started_at` when the container dies mid-cycle, so a `failed` row can
 * still name a cycle that ended hours ago.
 */
/** What one member row contributes to a spend figure, and nothing else. */
export interface MemberSpendRow {
  id: string;
  status: string;
  /**
   * Which CLI this member ran as, because `spent` alone cannot say whether its
   * zero is a reading. Null is a row that predates the column, and those are
   * all Claude runs by construction.
   */
  provider: RunProviderDTO | null;
  spent: number;
  est: number;
  cycleStartedAt: number | null;
}

/**
 * The two figures a set of member runs adds up to, and how much of the graph
 * neither of them could account for.
 *
 * `unmeasured` is a count of members and blocks whose spend was never measured
 * at all — not members that spent nothing. Both totals above are complete over
 * everything that reported and silent about everything that did not, and
 * without this count those two states are one number.
 */
export interface InstanceSpend extends InstanceProgress {
  /**
   * Members and blocks that could have reported a cost at all — the
   * denominator, so a count of gaps can be read as coverage rather than as a
   * bare number the operator has nothing to size against.
   */
  subjects: number;
  /** How many of those reported none. */
  unmeasured: number;
}

/** What one instance's block rows sum to, straight off the three columns. */
export interface BlockSpendTotals {
  /** `cost_usd`: what the blocks' own CLIs reported. */
  spent: number;
  /** `cost_usd_est`: our price for the turns none of them reported. */
  est: number;
  /** How many blocks have a turn that ended without reporting a cost. */
  unreported: number;
  /** Blocks that pay for a turn of their own, reported or not. */
  paying: number;
}

/**
 * Fold what an instance's blocks spent into what its members did.
 *
 * Pure, and separate from the two queries that feed it, because the whole of
 * the decision is which figure each column may reach and getting it wrong is
 * invisible: `est` is our own price for a turn that was killed before it could
 * report, so it belongs in the guard's figure beside `spent_usd_est` and the
 * telemetry reading, and it must never widen the figure the page calls
 * measured. `spent` is in both — a turn that reported measured itself.
 */
export function addBlockSpend(
  members: InstanceSpend,
  blocks: BlockSpendTotals,
): InstanceSpend {
  return {
    spentUSD: members.spentUSD + blocks.spent,
    spentGuardUSD: members.spentGuardUSD + blocks.spent + blocks.est,
    subjects: members.subjects + blocks.paying,
    unmeasured: members.unmeasured + blocks.unreported,
  };
}

/**
 * What a block's Spent cell may claim, from the two columns behind it.
 *
 * `null` is "nothing measured this block", which the cell draws as `—` on the
 * rule the runs list already states: `$0.00` down a column is a measurement
 * claim nobody made. A block whose *other* turns reported keeps its figure —
 * that money was measured — and `costUnknown` beside it is what says the figure
 * is a floor.
 */
export function blockSpendReading(block: {
  costUSD: number;
  costUnknown: boolean;
}): number | null {
  return block.costUnknown && block.costUSD === 0 ? null : block.costUSD;
}

/**
 * What a member's Spent cell may claim, from the row behind it.
 *
 * `blockSpendReading` one column over, and the same rule: `runs.spent_usd`
 * holds 0 for a provider whose CLI reports no cost, because the run loop
 * withholds its `+=` rather than adding an unmeasured zero, and every other
 * surface in this app — the runs list, the run page, the MCP tools — already
 * answers `null` for it. This page was the last one formatting it as `$0.00`.
 *
 * A null `provider` is a row that predates the column and is a Claude run by
 * construction, which is `providerReportsSpend`'s own reading of it.
 */
export function memberSpendReading(run: {
  provider: RunProviderDTO | null;
  spent_usd: number;
}): number | null {
  return providerReportsSpend(run.provider) ? run.spent_usd : null;
}

/**
 * The two figures a set of member runs adds up to.
 *
 * One summation rather than two, because a loop block asks the same question of
 * its own passes that an instance asks of every member, and a second copy of
 * "which of these three readings goes in which figure" is a second chance to put
 * a `*Guard*` reading somewhere it must never be.
 */
export function sumMemberSpend(rows: readonly MemberSpendRow[]): InstanceSpend {
  let spentUSD = 0;
  let spentGuardUSD = 0;
  let unmeasured = 0;
  for (const row of rows) {
    // Skipped rather than added, and the arithmetic being identical is the
    // whole reason this has to be explicit. `codex exec` reports token counts
    // and no money, so the run loop withholds its `+=` and `runs.spent_usd`
    // stays at 0 — a null in disguise, which every other surface already
    // refuses to print as `$0.00`. Adding it here would put that null into two
    // figures the page calls a total, and counting it is what lets the page say
    // the total is missing a member instead.
    if (!providerReportsSpend(row.provider)) {
      unmeasured += 1;
      continue;
    }
    spentUSD += row.spent;
    spentGuardUSD += row.spent + row.est;
    if (row.status === "running" && row.cycleStartedAt !== null) {
      spentGuardUSD += telemetrySpendSince(row.id, row.cycleStartedAt).costUSD;
    }
  }
  return { spentUSD, spentGuardUSD, subjects: rows.length, unmeasured };
}

const MEMBER_SPEND_COLUMNS =
  `SELECT r.id AS id, r.status AS status, r.provider AS provider,
          r.spent_usd AS spent,
          r.spent_usd_est AS est, r.active_started_at AS cycleStartedAt
     FROM workflow_instance_runs w
     JOIN runs r ON r.id = w.run_id`;

export function instanceSpend(instanceId: string): InstanceSpend {
  const members = sumMemberSpend(
    db()
      .prepare(`${MEMBER_SPEND_COLUMNS} WHERE w.instance_id = ?`)
      .all(instanceId) as MemberSpendRow[],
  );

  // What this instance's orchestrator blocks spent deciding.
  //
  // `cost_usd` is in **both** figures rather than neither, and that is a
  // deliberate reading of "a block's spend is not a run's". It is not: it never
  // touches `runs.spent_usd`, it is never summed into `buildSnapshot()` and no
  // dashboard meter sees it. But it is money this press of Run spent, measured
  // by the same `total_cost_usd` the CLI reports for a work cycle, and leaving
  // it out would give a graph with several deciding blocks a total that quietly
  // understates itself against the one limit meant to bound the whole thing.
  //
  // `cost_usd_est` is in the guard's figure only, which is the same rule one
  // step along rather than an exception to it: `cost_usd` is measured because a
  // turn that *reported* measured it, and a turn killed before its `result`
  // event reported nothing at all. Our own price for the usage it did stream is
  // an estimate, and an estimate belongs where every other one does — beside
  // `spent_usd_est` and the telemetry reading above, in the figure the guard
  // acts on and in no figure a meter calls measured.
  const blocks = db()
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS spent,
              COALESCE(SUM(cost_usd_est), 0) AS est,
              COALESCE(SUM(CASE WHEN cost_unreported > 0 THEN 1 ELSE 0 END), 0)
                AS unreported,
              -- The kinds that pay a model of their own — a deciding turn, a
              -- resolution, a review — which is the same list the Spent column
              -- draws a figure for. A loop block spends nothing — every pass is
              -- a run, counted above — so including it would size the coverage
              -- against blocks that were never going to report anything.
              COALESCE(SUM(CASE WHEN kind IN ('orchestrator', 'merge', 'review')
                                THEN 1 ELSE 0 END), 0) AS paying
         FROM workflow_instance_blocks WHERE instance_id = ?`,
    )
    .get(instanceId) as BlockSpendTotals;
  return addBlockSpend(members, blocks);
}

/** What an instance's members are doing, in the two counts a reading needs. */
export interface InstanceMemberTally {
  /** Runs still going, plus blocks still deciding or still waiting to. */
  live: number;
  /** Members written off because something in front of them satisfied nothing. */
  blocked: number;
}

/**
 * What one loop block's passes have spent so far.
 *
 * `instanceSpend` narrowed to the rows one block caused, and it reads the
 * **guard** figure for that function's reason: a cycle killed before it reported
 * contributes nothing to `spent_usd`, so a loop measured on the floor alone
 * would take another pass on money it had already spent. It is never added to
 * `runs.spent_usd`, never to `buildSnapshot()` and never to a meter — the loop's
 * cap is the only thing that reads it, and the instance's own guard still reads
 * every member including these.
 *
 * **Every run a pass caused, not only its members**, and the prefix is what says
 * so: an orchestrator member decides on runs of its own, and a cap that could
 * not see them would let a loop whose passes fan out spend without bound and
 * report a fraction of it. A pass's blocks are counted beside them for the same
 * reason `instanceSpend` counts an instance's — an orchestrator member's turn
 * and a merge member's conflict resolution are money this loop spent — and
 * `addBlockSpend` is what decides which figure each column may reach, once,
 * rather than twice.
 */
function loopSpend(instanceId: string, nodeId: string): number {
  const prefix = passPrefix(nodeId);
  const members = sumMemberSpend(
    db()
      .prepare(
        `${MEMBER_SPEND_COLUMNS} WHERE w.instance_id = ? AND substr(w.node_id, 1, ?) = ?`,
      )
      .all(instanceId, prefix.length, prefix) as MemberSpendRow[],
  );
  const blocks = db()
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS spent,
              COALESCE(SUM(cost_usd_est), 0) AS est,
              COALESCE(SUM(CASE WHEN cost_unreported > 0 THEN 1 ELSE 0 END), 0)
                AS unreported,
              COALESCE(SUM(CASE WHEN kind IN ('orchestrator', 'merge')
                                THEN 1 ELSE 0 END), 0) AS paying
         FROM workflow_instance_blocks
        WHERE instance_id = ? AND substr(node_id, 1, ?) = ?`,
    )
    .get(instanceId, prefix.length, prefix) as BlockSpendTotals;
  return addBlockSpend(members, blocks).spentGuardUSD;
}

/** A board condition read, or why this app could not read one. */
export type LoopBoardReading =
  | { ok: true; counts: LoopBoardCounts | null }
  | { ok: false; error: string };

/**
 * How many tasks the board holds for a loop's project, or null for no condition.
 *
 * **The folder is canonicalised through the board's own writer, and that is the
 * one thing here that fails silently.** `tasks.folder` holds the absolute path
 * `resolveTaskFolder` proved when the task was filed, and `listTasks` matches it
 * *exactly* — `normalizeTaskListQuery` deliberately does not re-resolve, because
 * the folder a reader filters on is the canonical one the board already handed
 * it. A node holds a path **within its mount**, so passing it straight through
 * would compare `repos/app` against `/workspace/repos/app`, count zero for ever,
 * and stop every loop on its first check with no error anywhere.
 *
 * `includeSubfolders` widens that exact match to a prefix, and the prefix
 * carries the separator — see `listTasks`, where the reason is written out.
 * Without it `…/UsageFoundryWeb` is counted for `…/UsageFoundry`.
 *
 * `total` once per named status rather than a page, and summed: the count is the
 * whole answer and the rows are never read, so a project with a thousand open
 * tasks still costs `COUNT(*)`s alone. The statuses are a closed pair that
 * cannot overlap, so summing them cannot double-count a row. **Every priority is
 * counted, not the ones the thresholds name**: the alternative is a reading that
 * can be missing a figure the decision needs, and a decision that can only skip
 * a threshold it has no number for is a loop that runs on past its own ending.
 *
 * A folder that will not resolve is an **error rather than a zero**, which is
 * the same choice `advanceLoop` already makes about a block that has left the
 * graph: zero is "the backlog is clear", the one answer that ends the loop, and
 * an absent mount is not a finished project.
 *
 * Exported for `loopBoardCount.test.ts` and for the validate route, on `land.ts`'s
 * grounds: the resolution above is the whole defect, it is invisible in a type
 * and it is two `advanceLoops` and a spawned run away from any door.
 */
export function loopBoardCount(node: WorkflowNode): LoopBoardReading {
  const condition = node.stopWhenTasks;
  if (!condition) return { ok: true, counts: null };
  return countBoardCondition(condition);
}

/** The same reading off a condition alone, for a draft that has no node yet. */
export function countBoardCondition(
  condition: LoopBoardCondition,
): LoopBoardReading {
  // `"."` rather than `""` for the mount root: `resolveTaskFolder` refuses a
  // mount with no folder beside it, and the root is a folder — it is the path a
  // run working there files its own tasks against. Going round that resolver to
  // spell the root ourselves is what would put a second folder resolver in this
  // app, which `tasks.ts` exists to prevent.
  const resolved = resolveTaskFolder(condition.mountId, condition.folder || ".");
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const where = {
    mountId: resolved.mountId,
    folder: resolved.folder,
    includeSubfolders: condition.includeSubfolders,
    // Agent work only. An operator-only task is `open` and no run may claim
    // it, so no pass can bring it down: counted, a loop told to run until at
    // most N are open would run for ever — or to its pass cap, spending every
    // pass — once the operator's own lane held more than N.
    operatorOnly: false,
    // The count is the whole answer; the smallest page keeps the rows this
    // never reads off the wire.
    limit: 1,
  };

  let total = 0;
  const byPriority: Record<TaskPriorityDTO, number> = {
    urgent: 0,
    high: 0,
    normal: 0,
    low: 0,
  };
  for (const status of condition.statuses) {
    total += listTasks({ ...where, status }).total;
    for (const priority of TASK_PRIORITIES) {
      byPriority[priority] += listTasks({ ...where, status, priority }).total;
    }
  }
  return { ok: true, counts: { total, byPriority } };
}

/**
 * What each loop's board condition counts today, for the editor's picker.
 *
 * Read off the wire graph **a node at a time**, deliberately not through
 * `normalizeWorkflowInput`: a graph being drawn is invalid for most of the time
 * somebody is drawing one — a block with no task yet, a link not drawn — and a
 * figure that blanked until every *other* block was finished would be an absence
 * exactly where the number is the point. Each condition still goes through the
 * one normaliser that decides what a condition may be, so nothing here is a
 * second opinion about that.
 */
export function boardReadings(
  body: Record<string, unknown>,
  known: WorkflowKnowledge,
): LoopBoardReadingDTO[] {
  const graph = (body.graph ?? {}) as { nodes?: unknown };
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const readings: LoopBoardReadingDTO[] = [];

  for (const raw of nodes) {
    const node = (raw ?? {}) as Record<string, unknown>;
    if (node.kind !== "loop" || !node.stopWhenTasks) continue;
    const nodeId = String(node.id ?? "");
    const name = String(node.name ?? "").trim() || "This block";

    const condition = normalizeBoardCondition(node.stopWhenTasks, name, known);
    if (!condition.ok) {
      readings.push({ nodeId, counts: null, error: condition.error });
      continue;
    }
    if (!condition.value) continue;

    const reading = countBoardCondition(condition.value);
    readings.push(
      reading.ok
        ? { nodeId, counts: reading.counts, error: null }
        : { nodeId, counts: null, error: reading.error },
    );
  }
  return readings;
}

/**
 * How much of this instance has not finished, and how much of it never ran.
 *
 * The block half of `live` is not decorative. `stopped` is derived from "nothing
 * is live", so a halt that left an orchestrator turn running would read as
 * *stopped* while a billed child was still deciding what to start — and
 * `startWorkflow`'s refusal of a second press reads the same count.
 *
 * `blocked` is counted over both halves for the same reason, one status along:
 * a dependency that did no work satisfies nothing, and either half of the graph
 * can be written off for it — a run by `releasableRuns`, a node still in the
 * ledger by `planInstanceStep`. An instance that counted only one of them would
 * report a graph missing its tail as a graph that reached its end.
 * A `looping` block is live for the same reason one step along: it has another
 * pass to start. And a review block's reviewer still running is live for the
 * first reason over again: a halt writes the block off at once and signals the
 * child, which takes seconds to die and bills until it does.
 */
function memberTally(instanceId: string): InstanceMemberTally {
  const runs = db()
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN r.status IN
                (${LIVE_STATUSES.map(() => "?").join(",")})
              THEN 1 ELSE 0 END), 0) AS live,
              COALESCE(SUM(CASE WHEN r.status = 'blocked' THEN 1 ELSE 0 END), 0)
                AS blocked
         FROM workflow_instance_runs w
         JOIN runs r ON r.id = w.run_id
        WHERE w.instance_id = ?`,
    )
    .get(...LIVE_STATUSES, instanceId) as InstanceMemberTally;
  const blocks = db()
    .prepare(
      // `looping` sits in the live set beside `thinking`: between passes a loop
      // has no child in flight and is still not finished, so an instance that
      // counted only `thinking` would read as stopped with a pass still to come.
      "SELECT COALESCE(SUM(CASE WHEN status IN ('waiting','thinking','looping')" +
        " THEN 1 ELSE 0 END), 0) AS live," +
        " COALESCE(SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END), 0)" +
        " AS blocked" +
        " FROM workflow_instance_blocks WHERE instance_id = ?",
    )
    .get(instanceId) as InstanceMemberTally;
  return {
    live: runs.live + blocks.live + runningReviewsOf(instanceId).length,
    blocked: runs.blocked + blocks.blocked,
  };
}

/**
 * Which of the six readings a stored row is, given what its members are doing.
 *
 * Pure and unit-tested for `haltPlan`'s reason: every way of being wrong here
 * typechecks, throws nothing and renders. A graph that finished an hour ago, one
 * whose tail was written off, and one with an agent working in it right now were
 * one word between them until this split, and that word is the whole of what an
 * operator reads to decide whether to wait, to look at a block, or to press Run
 * again.
 *
 * A halt outranks the members: an instance stopped with a member already written
 * off is `stopped`, because what ended it is the headline and the member says
 * the rest on its own row. An unrecognised stored value reads as an unhalted
 * one, the same forgiving default the graph blob gets — this is a record, and it
 * has to keep rendering.
 */
export function instanceStatus(
  stored: string,
  members: InstanceMemberTally,
): WorkflowInstanceStatus {
  if (stored === "failed") return "failed";
  if (stored === "stopping") return members.live > 0 ? "stopping" : "stopped";
  if (members.live > 0) return "started";
  return members.blocked > 0 ? "blocked" : "finished";
}

/** Every non-run block of one instance, in the order the graph declared them. */
export function blocksOf(instanceId: string): WorkflowInstanceBlock[] {
  const rows = db()
    .prepare(
      `SELECT node_id AS nodeId, node_name AS nodeName, position, kind, status,
              started_at AS startedAt, finished_at AS finishedAt,
              cost_usd AS costUSD, cost_unreported AS unreported,
              tokens, emitted_specs AS specs, error,
              merge_batch_id AS batchId, reply, notes,
              -- Read back off the queue's own rows rather than counted into the
              -- block as it went: those rows carry git's answer for each branch,
              -- and a copy on the block would be a second thing to keep in step
              -- with a worker that re-decides every item at its own turn.
              (SELECT COUNT(*) FROM merge_queue q
                WHERE q.batch_id = b.merge_batch_id AND q.status = 'landed')
                AS branchesLanded,
              -- Neither count takes a branch already on its target by its
              -- turn, which is the block's skip (see queuedBranchOutcome) and
              -- is counted nowhere, like one skipped before it was queued.
              (SELECT COUNT(*) FROM merge_queue q
                WHERE q.batch_id = b.merge_batch_id
                  AND q.status NOT IN ('landed', 'already-landed'))
                AS branchesFailed,
              -- The mapping rows rather than the runs they point at: a run
              -- deleted since was still started, and "started fewer than it
              -- decided on" must mean a spec that never became a run.
              (SELECT COUNT(*) FROM workflow_instance_runs w
                WHERE w.instance_id = b.instance_id AND w.emitted_by = b.node_id)
                AS started
         FROM workflow_instance_blocks b
        WHERE instance_id = ? ORDER BY position`,
    )
    .all(instanceId) as Array<
    Omit<
      WorkflowInstanceBlock,
      "emitted" | "decided" | "notes" | "costUnknown"
    > & {
      specs: string | null;
      batchId: string | null;
      notes: string | null;
      unreported: number;
    }
  >;
  // A loop block emits nothing — it repeats — so its count is the **passes** it
  // has taken, read once for the whole instance rather than per row. Counted
  // distinct rather than as rows, because a loop that repeats a *section* makes
  // one pass out of several members: `COUNT(*)` would report a three-pass loop
  // over a two-block body as six, which is the block's own cap stated in a unit
  // it was never set in. The orchestrator block's count stays the *specs* it
  // accepted: a spec whose `createRun` was refused is still something it
  // decided on, and `createEmitted` records that failure separately.
  //
  // Read off the **member ids of both tables** rather than off `emitted_by`,
  // and the difference is a whole kind of section: a pass of a section with no
  // run block in it — one deciding turn and the merge behind it — leaves no row
  // whose `emitted_by` is the loop at all, because its members are ledger rows
  // and the runs its orchestrator member decided on name that member. Counted
  // that way the loop reports 0 passes for ever, having taken several.
  // `passMemberOf` is the one parser, as it is in `loopPasses`.
  const passKeys = new Map<string, Set<string>>();
  const countMember = (memberId: string) => {
    const member = passMemberOf(memberId);
    if (!member) return;
    const seen = passKeys.get(member.loopNodeId) ?? new Set<string>();
    seen.add(String(member.pass));
    passKeys.set(member.loopNodeId, seen);
  };
  for (const row of db()
    .prepare(
      "SELECT node_id AS memberId FROM workflow_instance_runs WHERE instance_id = ?" +
        " UNION SELECT node_id AS memberId FROM workflow_instance_blocks WHERE instance_id = ?",
    )
    .all(instanceId, instanceId) as Array<{ memberId: string }>) {
    countMember(row.memberId);
  }
  const passes = new Map(
    [...passKeys].map(([nodeId, seen]) => [nodeId, seen.size] as const),
  );

  return rows.map(({ specs, batchId, notes, unreported, ...row }) => ({
    ...row,
    costUnknown: unreported > 0,
    emitted:
      row.kind === "loop"
        ? (passes.get(row.nodeId) ?? 0)
        : parseSpecs(specs).length,
    // The column itself, not its contents: `[]` is a turn that called the tool
    // and named nothing, which is a decision, and null is a turn that never
    // reached one.
    decided: specs !== null,
    notes: splitNotes(notes),
    // A block with no batch has no branches either way, and the correlated
    // counts above answer 0 for it — but only because `merge_batch_id` is null
    // and nothing matches. Stated rather than relied on.
    branchesLanded: batchId ? row.branchesLanded : 0,
    branchesFailed: batchId ? row.branchesFailed : 0,
  }));
}

/** Stored notes as lines. One per fact, in the order they happened. */
function splitNotes(raw: string | null): string[] {
  return raw ? raw.split("\n").filter((line) => line.trim() !== "") : [];
}

/** Stored specs as a list. Unreadable and absent both read as "emitted none". */
function parseSpecs(raw: string | null): RunSpec[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as RunSpec[]) : [];
  } catch {
    return [];
  }
}

/**
 * Is that run one of this instance's blocks?
 *
 * The block half of what `/api/mcp` scopes `get_run_diff` by; `chatOwnsRun` is
 * the other and carries the reasoning. This is the shape a deciding block
 * actually needs — "the block before me produced this, what did it change" — so
 * scoping costs it nothing, while a capability read out of a sibling's config
 * file no longer reaches the patches of runs in other workflows.
 */
export function instanceOwnsRun(instanceId: string, runId: string): boolean {
  return (
    db()
      .prepare(
        "SELECT 1 FROM workflow_instance_runs WHERE instance_id = ? AND run_id = ? LIMIT 1",
      )
      .get(instanceId, runId) !== undefined
  );
}

function rowToInstance(row: InstanceRow): WorkflowInstance {
  let graph: WorkflowGraph = { nodes: [], edges: [] };
  try {
    const parsed = JSON.parse(row.graph) as Partial<WorkflowGraph>;
    graph = {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
    };
  } catch {
    /* an unreadable snapshot still lists its runs */
  }

  const nodes = db()
    .prepare(
      `SELECT node_id AS nodeId, node_name AS nodeName, position, run_id AS runId,
              emitted_by AS emittedBy, left_behind_at AS leftBehindAt
         FROM workflow_instance_runs WHERE instance_id = ? ORDER BY position`,
    )
    .all(row.id) as WorkflowInstanceNode[];

  const members = memberTally(row.id);

  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    graph,
    createdAt: row.created_at,
    origin: (RUN_ORIGINS as readonly string[]).includes(row.origin ?? "")
      ? (row.origin as RunOrigin)
      : null,
    originRef: row.origin_ref,
    // Four of the six are read off the members — see `instanceStatus`, which is
    // the whole of that decision and is pure so it can be tested.
    status: instanceStatus(row.status, members),
    error: row.error,
    stoppedAt: row.stopped_at,
    stopCause:
      row.stop_cause === "operator" || row.stop_cause === "guard" || row.stop_cause === "fleet"
        ? row.stop_cause
        : null,
    stopReason: row.stop_reason,
    liveRunCount: members.live,
    blockedCount: members.blocked,
    instanceBudget: parseInstanceBudget(row.instance_budget),
    spend: instanceSpend(row.id),
    nodes,
    blocks: blocksOf(row.id),
  };
}

// Keyed on `InstanceRow` so a column the row type declares and the SELECT
// leaves out fails to typecheck: the `as InstanceRow` casts that read these
// rows cannot see it, and the column then reads as null. For `origin` that is
// silent — every run a scheduled instance creates after it started would be
// recorded as a press of Run.
const INSTANCE_COLUMN_NAMES: Record<keyof InstanceRow, true> = {
  id: true,
  workflow_id: true,
  workflow_name: true,
  graph: true,
  created_at: true,
  status: true,
  error: true,
  stopped_at: true,
  stop_cause: true,
  stop_reason: true,
  instance_budget: true,
  origin: true,
  origin_ref: true,
};

const INSTANCE_COLUMNS = Object.keys(INSTANCE_COLUMN_NAMES).join(", ");

/** Statuses a run has not finished in — it will spend, or is waiting to. */
const LIVE_STATUSES: readonly RunStatus[] = [
  "waiting",
  "queued",
  "running",
  "paused",
  "waiting-for-stack",
];

/** The widest page `findInstances` will answer with, whatever it was asked for. */
export const INSTANCE_PAGE_MAX = 100;

/** What it answers with when nothing legible was asked for — the old whole. */
const INSTANCE_PAGE_DEFAULT = 20;

/**
 * One page of a workflow's presses of Run, newest first, with the count it is a
 * slice of.
 *
 * The twenty this replaces was the whole of the history a graph could show, and
 * the surface it capped is the one that answers *what has this workflow done* —
 * so a graph that runs nightly answered that question with a fortnight of itself
 * and said nothing about the rest. `total` is counted over every row rather than
 * over the page, for `listRunsPage`'s reason: a count that is itself truncated
 * cannot say an instance has fallen out of reach.
 *
 * The page is also what bounds the work, which no other list here has to think
 * about: `rowToInstance` parses each instance's graph snapshot and reads its
 * node, block and spend rows, so a limit off a query string is a limit on how
 * much of that one request may do.
 *
 * `id DESC` behind `created_at DESC` carries `listRunsPage`'s reasoning rather
 * than its measurement: the stamp is milliseconds, and two rows that may order
 * differently between two requests mean one instance appears on both pages and
 * another on neither.
 *
 * A limit that is missing, zero, negative or unreadable is the default page and
 * not the smallest legal one, which is `normalizeRunListQuery`'s rule verbatim:
 * these arrive off a query string, and a one-row page is a far worse answer to a
 * typo than the ordinary one.
 */
export function findInstances(o: {
  workflowId: string;
  limit?: number;
  offset?: number;
}): {
  instances: WorkflowInstance[];
  total: number;
  offset: number;
  limit: number;
} {
  const asked = Math.floor(Number(o.limit));
  const limit =
    Number.isFinite(asked) && asked > 0
      ? Math.min(INSTANCE_PAGE_MAX, asked)
      : INSTANCE_PAGE_DEFAULT;

  const total = (
    db()
      .prepare("SELECT COUNT(*) AS n FROM workflow_instances WHERE workflow_id = ?")
      .get(o.workflowId) as { n: number }
  ).n;
  // The same rule the runs list pages by, and the same reason it is a clamp
  // rather than a refusal — see `clampRunOffset`.
  const offset = clampRunOffset(o.offset ?? 0, total);

  const rows = db()
    .prepare(
      `SELECT ${INSTANCE_COLUMNS} FROM workflow_instances
        WHERE workflow_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(o.workflowId, limit, offset) as InstanceRow[];

  return { instances: rows.map(rowToInstance), total, offset, limit };
}

/**
 * When this workflow was last started, or null.
 *
 * Its own query rather than the first row of `findInstances`: the list page asks
 * it once per workflow, and building a whole instance — parsing its graph
 * snapshot and reading its node rows — to take one timestamp off it is work per
 * row that nothing on that page displays.
 */
export function lastRunAt(workflowId: string): number | null {
  const row = db()
    .prepare(
      "SELECT MAX(created_at) AS at FROM workflow_instances WHERE workflow_id = ?",
    )
    .get(workflowId) as { at: number | null } | undefined;
  return row?.at ?? null;
}

export function getInstance(id: string): WorkflowInstance | null {
  const row = db()
    .prepare(`SELECT ${INSTANCE_COLUMNS} FROM workflow_instances WHERE id = ?`)
    .get(id) as InstanceRow | undefined;
  return row ? rowToInstance(row) : null;
}

/**
 * Runs this workflow started that have not finished.
 *
 * Both gates read it: starting a second instance while the first is still going
 * would aim the same nodes at the same folders, and deleting a workflow while
 * its runs are in flight throws away the only record of where they came from.
 */
export function liveRunsOf(
  workflowId: string,
): Array<{ runId: string; status: RunStatus; instanceId: string }> {
  return db()
    .prepare(
      `SELECT w.run_id AS runId, r.status AS status, w.instance_id AS instanceId
         FROM workflow_instance_runs w
         JOIN workflow_instances i ON i.id = w.instance_id
         JOIN runs r ON r.id = w.run_id
        WHERE i.workflow_id = ?
          AND r.status IN (${LIVE_STATUSES.map(() => "?").join(",")})
        ORDER BY w.position`,
    )
    .all(workflowId, ...LIVE_STATUSES) as Array<{
    runId: string;
    status: RunStatus;
    instanceId: string;
  }>;
}

/**
 * Blocks of this workflow that have not settled.
 *
 * The other half of "is anything from this workflow still going", and it is not
 * covered by the runs: a block still deciding has started nothing yet and is
 * about to start several. A second press of Run while one is thinking would
 * point the same blocks at the same folders and put two deciding turns on one
 * repository, which is the collision `liveRunsOf` exists to refuse one step
 * earlier than it can see.
 *
 * A pass's members are rows in this table too, which is what makes a loop that
 * is between two passes — no child in flight, no live run anywhere — still a
 * workflow that is going: `looping` is in the list, and the next pass it is
 * about to create is exactly the "started nothing yet and about to start
 * several" case one kind along.
 */
export function liveBlocksOf(workflowId: string): number {
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS n
         FROM workflow_instance_blocks b
         JOIN workflow_instances i ON i.id = b.instance_id
        WHERE i.workflow_id = ?
          AND b.status IN (${LIVE_BLOCK_STATUSES.map(() => "?").join(",")})`,
    )
    .get(workflowId, ...LIVE_BLOCK_STATUSES) as { n: number };
  return row.n;
}

/* ------------------------------------------------------------------ */
/* Instantiating                                                       */
/* ------------------------------------------------------------------ */

export type StartOutcome =
  | { ok: true; instance: WorkflowInstance }
  | { ok: false; reason: string };

/**
 * Who pressed Run.
 *
 * A discriminated union rather than an optional schedule id, so the two cases
 * cannot both be absent and a caller cannot claim a schedule without naming
 * one. It carries authorisation and nothing else — no guard, no permission
 * mode, no budget — which is what keeps "a schedule is the same
 * `startWorkflow`" true.
 */
export type WorkflowTrigger =
  | { kind: "manual" }
  | { kind: "schedule"; scheduleId: string };

/**
 * Turn a workflow into runs — every block, in one synchronous pass.
 *
 * Synchronous from the first `createRun` to the last, with no `await` between
 * them, and that is a correctness requirement rather than a style: `createRun`'s
 * folder claim is only atomic because one event-loop turn covers deciding a
 * folder is free and recording that it was taken. The chat's approval route
 * batches for the same reason.
 *
 * **All or nothing.** Everything that can be checked is checked before anything
 * is created — the graph against the templates and mounts that exist right now,
 * every folder through the same `resolveWorkspaceFolder` the run will use, and
 * every node's guards — so a failure in the middle should be unreachable. If one
 * happens anyway the runs already created are stopped and the instance is
 * recorded `failed` with the reason, because half a graph is not a smaller
 * workflow: its successors were never created, so what is left running is a
 * prefix nobody asked for. The runs are *stopped* rather than deleted — one may
 * already hold a checkout and a child process, and the row is what the kill path
 * and `reconcileOnBoot` need.
 *
 * **`snapshot` is the only argument, and the instance budget is not among
 * them.** It is read off the saved workflow and nowhere else. There is no field
 * on the wire, no override on this function and no route that writes an
 * instance's copy of it, which is the strongest form of "nothing a model emits
 * may set it": an orchestrator block cannot raise its own instance's budget
 * because there is nothing to raise it *with*. The saved workflow is a person's
 * form, and the copy taken here is what the guard measures against for the life
 * of the instance, so editing the workflow mid-run cannot move it either.
 *
 * The snapshot is passed in rather than read, because this function is
 * synchronous from entry to the last `createRun` and `currentSnapshot()` is not
 * — the route awaits it and hands it over. It is used once, at the door: a
 * fraction guard with no ceiling behind it is refused here, where there is an
 * error channel, rather than tripping at the first block's guard check and
 * halting a graph that never should have started.
 *
 * `trigger` records *which* press of Run this was, and it grants nothing: there
 * is still no field on it that can reach a guard, a permission mode or an
 * isolation choice, so a schedule remains "the same `startWorkflow`, with
 * nobody present" rather than a second way of starting work. It is copied onto
 * the instance so a node created hours later, behind an orchestrator block's
 * decision, records the trigger the instance actually had.
 */
export function startWorkflow(
  id: string,
  snapshot: UsageSnapshot,
  trigger: WorkflowTrigger = { kind: "manual" },
): StartOutcome {
  // Before the instance row exists. `createRun` refuses too, but that refusal
  // would arrive mid-pass and take the rollback path — an instance recorded
  // `failed` and a graph half built — where this one is a sentence beside the
  // button, which is what every other reason a press of Run cannot happen gets.
  const notOwner = dataDirRefusal();
  if (notOwner) return { ok: false, reason: notOwner };

  const workflow = getWorkflow(id);
  if (!workflow) return { ok: false, reason: "No such workflow." };

  // A second instance would aim the same blocks at the same folders: the runs
  // would queue behind the first instance's on the folder claim, and a block
  // set to carry on a branch would be refused by `admitDependencies` because
  // the first instance's run already continues it. Refused here as a sentence,
  // rather than discovered four nodes into the pass.
  const live = liveRunsOf(id);
  const liveBlocks = liveBlocksOf(id);
  if (live.length + liveBlocks > 0) {
    return {
      ok: false,
      reason:
        `${live.length} run(s) and ${liveBlocks} block(s) from an earlier press ` +
        "of Run have not finished yet. Starting this workflow again would point " +
        "the same blocks at the same folders. Wait for them, or stop that run of " +
        "the workflow.",
    };
  }

  // The install's spend limit, before anything else about this workflow is
  // decided. `createRun` refuses every member individually, which would abort
  // the pass part-way and record the instance `failed` — a rollback in the
  // record for a limit that has nothing to do with this graph. Refused here it
  // is one sentence and no instance at all.
  const installRefusal = installBudgetRefusal();
  if (installRefusal) return { ok: false, reason: installRefusal };

  const known = currentKnowledge();
  const checked = normalizeWorkflowInput(workflow, known);
  if (!checked.ok) {
    return {
      ok: false,
      reason: `This workflow cannot be started as saved: ${checked.error}`,
    };
  }
  const graph = checked.value.graph;
  const instanceBudget = checked.value.instanceBudget;

  // The workflow-wide guard, read once before anything exists. Nothing has been
  // spent yet, so the only two verdicts reachable are the ones that are about
  // the *configuration* and the *window* rather than about this instance:
  //
  //   `no_ceiling` — a fraction guard with nothing behind it. Refused, not
  //   ignored, which is this app's standing rule: silently passing would leave
  //   the operator believing a guard is active. Refused *here* because this is
  //   the moment with an error channel; leaving it to the first block's check
  //   would create every run, spend a transcript scan, and then halt the whole
  //   graph with a sentence nobody was waiting for.
  //
  //   `weekly_fraction` / `session_fraction` — the window is already past the
  //   guard. Starting would create N runs and halt them before the first one
  //   worked, which is a workflow instance in the record for no reason.
  if (!instanceBudgetIsOff(instanceBudget)) {
    const verdict = evaluateInstanceBudget(instanceBudget, snapshot, {
      spentUSD: 0,
      spentGuardUSD: 0,
    });
    if (!verdict.allowed) {
      return {
        ok: false,
        reason: `This workflow's own limits will not let it start: ${verdict.reason}`,
      };
    }
  }

  // Planned in full before anything is created. A refusal here costs nothing;
  // the same refusal three nodes into the pass costs a rollback.
  //
  // An orchestrator block is planned too, even though it becomes no run: what
  // `planNode` refuses for it — a template that has been deleted — is refused
  // for the runs it will *emit*, which take their guards from that same
  // template, and finding that out an hour into the graph would mean a turn
  // billed for a decision nothing can act on.
  //
  // A merge block and a loop are the two kinds that are not, and there is
  // nothing left to plan for either: neither names a template, a mount, a
  // folder or a task, so every refusal `planNode` has is about a field they do
  // not hold. A loop frames the blocks it repeats and each of those is planned
  // on its own account, which is where the guards a pass runs under come from.
  const defaults = chatGuards();
  const plans = new Map<string, Omit<CreateRunInput, "dependsOn" | "origin">>();
  for (const node of graph.nodes) {
    if (node.kind === "merge" || node.kind === "loop" || node.kind === "review") continue;
    const plan = planNode(
      node,
      node.templateId ? getTemplate(node.templateId) : null,
      defaults,
      // Resolved to a definition here and frozen onto the run by `createRun`,
      // so an agent deleted while this instance is working cannot reach a run
      // that has already started. `normalizeWorkflowInput` above has refused a
      // graph naming one that is already gone; this is the same refusal for the
      // row that goes between the two reads.
      node.agentId ? getAgent(node.agentId) : null,
    );
    if (!plan.ok) return { ok: false, reason: plan.reason };
    // An orchestrator block's plan is only asked for its refusals — its runs
    // are planned again when it emits — so the sign-in is read for run blocks.
    const ready = node.kind === "run" ? localReady(plan.input, node.name) : plan;
    if (!ready.ok) return { ok: false, reason: ready.reason };
    plans.set(node.id, ready.input);
  }

  // The same resolution `createRun` performs, run early so a folder that has
  // been moved or deleted since the workflow was saved names its block instead
  // of aborting a half-built graph.
  const missing = folderRefusal(graph);
  if (missing) return { ok: false, reason: missing };

  // The one remaining thing that can only be answered by looking at the disk: a
  // hand-over needs a *branch* at both ends, and whether a folder can have one
  // is `probeIsolation`'s answer rather than the guards'. Its failures are
  // ordinary — a subdirectory of a repository, submodules, no commits yet — and
  // every one of them would otherwise surface as a throw part-way through the
  // creating pass. Read-only, so asking early costs a few git processes.
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  // Every **run** member of a section, and nothing else about a loop. A pass
  // commits and then lands what it committed, so each run member is on a branch
  // for the same reason either end of a hand-over is. The loop block itself is
  // not asked: it frames the section and names no folder at all, so resolving
  // one for it would be resolving `""` against no mount. Its orchestrator and
  // merge members are not asked either — neither works in a checkout, which is
  // the same exemption `graphRefusal` gives them by name one file over.
  // `graphRefusal` has already established that the run members' *guards*
  // isolate; this is the other half, which only the disk can answer.
  const inSomeBody = loopBodyOwners(graph);
  const needBranch = new Set<WorkflowNode>(
    graph.nodes.filter((n) => n.kind === "run" && inSomeBody.has(n.id)),
  );
  for (const link of graph.edges.filter((e) => e.continueBranch)) {
    needBranch.add(nodeById.get(link.from)!);
    needBranch.add(nodeById.get(link.to)!);
  }
  for (const node of needBranch) {
    const probe = probeIsolation(
      resolveWorkspaceFolder(node.folder, node.mountId),
    );
    if (probe.mode !== "worktree") {
      return {
        ok: false,
        reason: inSomeBody.has(node.id)
          ? `“${node.name}” is repeated, and every pass has to land what it ` +
            `produced, which needs a checkout of its own. ${probe.reason ?? "It cannot have one."}`
          : `“${node.name}” is part of a branch hand-over, which needs a ` +
            `checkout of its own. ${probe.reason ?? "It cannot have one."}`,
      };
    }
  }

  // The dependencies alone decide the creation order: a `repeats` link names a
  // block this pass never creates, and every reader below is already filtered
  // to the same set. `graphRefusal` has established the order is total.
  const { order } = topologicalOrder({
    nodes: graph.nodes,
    edges: graph.edges.filter(isDependencyEdge),
  });
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, WorkflowDependencyEdge[]>();
  for (const e of graph.edges) {
    // Containment, not a dependency — and the one edge here whose `edge` is not
    // a value `createRun` may store on a `run_deps` row.
    if (!isDependencyEdge(e)) continue;
    const list = incoming.get(e.to);
    if (list) list.push(e);
    else incoming.set(e.to, [e]);
  }

  const instanceId = randomUUID();
  const now = Date.now();
  // A schedule firing and a person pressing Run are the same instantiation with
  // different authorisation behind them, which is the whole of what `origin`
  // records. The reference is the schedule, because "which schedule started
  // this" is the question a scheduled instance raises and the instance id
  // answers nothing.
  const origin: RunOrigin = trigger.kind === "schedule" ? "schedule" : "workflow";
  const originRef = trigger.kind === "schedule" ? trigger.scheduleId : instanceId;
  db()
    .prepare(
      `INSERT INTO workflow_instances
         (id, workflow_id, workflow_name, graph, instance_budget, created_at,
          status, error, origin, origin_ref)
       VALUES (?, ?, ?, ?, ?, ?, 'started', NULL, ?, ?)`,
    )
    .run(
      instanceId,
      id,
      workflow.name,
      JSON.stringify(graph),
      // The copy, taken once. Everything after this reads the instance's own,
      // so an edit to the workflow cannot move the guard under a running graph
      // — the same reason the graph blob is copied rather than joined to.
      JSON.stringify(instanceBudget),
      now,
      origin,
      originRef,
    );

  const addBlock = db().prepare(
    `INSERT INTO workflow_instance_blocks
       (instance_id, node_id, node_name, position, kind, status)
     VALUES (?, ?, ?, ?, ?, 'waiting')`,
  );

  // Which nodes cannot be created yet: every node with a block that is not a run
  // somewhere behind it. Its dependency edges name runs that do not exist — a
  // model has not decided on them, or a merge block will create none at all — so
  // it is created when they do, by `advanceInstances`. Everything else is
  // created here, in the one synchronous pass, exactly as before.
  const deferred = deferredNodes(graph);

  const runIds = new Map<string, string>();
  try {
    for (const [position, nodeId] of order.entries()) {
      const node = byId.get(nodeId)!;
      // A block some loop repeats gets **no row of its own**, which is the one
      // node here that is neither a run nor a ledger entry. Its work happens
      // once per pass under the loop's `emitted_by`, so the loop's row is its
      // record; a `waiting` row beside it would be counted live by
      // `liveBlocksOf` and never settled by anything, leaving the instance
      // unfinishable and a second press of Run refused for ever.
      if (inSomeBody.has(nodeId)) continue;
      // A block that is not a run gets a ledger row rather than a run: an
      // orchestrator block has a decision to make first, a merge block lands
      // what is already there, and a loop block has a pass to create rather
      // than being one.
      if (node.kind !== "run" || deferred.has(nodeId)) {
        addBlock.run(instanceId, nodeId, node.name, position, node.kind);
        continue;
      }
      const dependsOn = (incoming.get(nodeId) ?? []).map((e) => ({
        // Every predecessor is earlier in the topological order, so its run
        // already exists. That is the whole reason the order is computed.
        runId: runIds.get(e.from)!,
        edge: e.edge,
        continueBranch: e.continueBranch,
      }));
      const run = createRun({ ...plans.get(nodeId)!, dependsOn, origin, originRef });
      runIds.set(nodeId, run.id);
      recordMember(instanceId, {
        nodeId,
        nodeName: node.name,
        position,
        runId: run.id,
        emittedBy: null,
      });
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Newest first, so a run is stopped before the one it was told to start
    // after — otherwise stopping the dependency releases the dependent into the
    // queue on its way out. The attribution says which of the three stops this
    // was: not the operator, not a guard, but a graph that could not be built.
    const rolledBack = `Stopped because workflow “${workflow.name}” could not be started in full`;
    for (const runId of [...runIds.values()].reverse()) {
      stopRun(runId, rolledBack);
    }
    // The blocks too: nothing has spawned yet, so every one of them is
    // `waiting`, and a row left saying so under a `failed` instance is a block
    // the page reports as about to happen and nothing will ever pick up.
    db()
      .prepare(
        "UPDATE workflow_instance_blocks SET status='blocked', finished_at=?, error=?" +
          " WHERE instance_id=? AND status='waiting'",
      )
      .run(Date.now(), `${rolledBack}.`, instanceId);
    db()
      .prepare(
        "UPDATE workflow_instances SET status = 'failed', error = ? WHERE id = ?",
      )
      .run(reason, instanceId);
    return {
      ok: false,
      reason:
        `${reason} Nothing from this workflow is left running — the ` +
        `${runIds.size} run(s) already created were stopped.`,
    };
  }

  // `createRun` promotes after each admission; this is what starts whatever the
  // last one made startable, exactly as the chat's approval route relies on.
  promoteQueued();

  // And the other half of "start whatever can start": an orchestrator block or
  // a loop block with nothing in front of it is ready the moment the graph
  // exists. Outside the creating pass, because the first of those spawns.
  advanceInstances();
  return { ok: true, instance: getInstance(instanceId)! };
}

/** One block's run, recorded against the instance it belongs to. */
function recordMember(instanceId: string, node: WorkflowInstanceNode): void {
  db()
    .prepare(
      `INSERT INTO workflow_instance_runs
         (instance_id, node_id, node_name, position, run_id, emitted_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      instanceId,
      node.nodeId,
      node.nodeName,
      node.position,
      node.runId,
      node.emittedBy,
    );
}

/**
 * Nodes that cannot be created until a block in front of them has finished.
 *
 * Everything reachable *from* a block that is not a run, transitively. A node
 * here has at least one dependency that is not a run — an orchestrator block's
 * decision that may turn out to be several runs, a merge block that creates none
 * at all, or a loop block that may turn out to be however many passes it takes —
 * so there is nothing for `createRun` to name, and admitting it as `waiting`
 * with no edges would release it immediately: a run started ahead of the
 * decision that was supposed to shape it, ahead of the merge it was meant to
 * follow, or ahead of the passes it was meant to come after.
 *
 * Costing nothing is what makes the deferral safe: a node that has not been
 * created holds no folder, no checkout slot and no place in the queue, which is
 * the same property `waiting` was invented for one level down.
 */
function deferredNodes(graph: WorkflowGraph): Set<string> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    // A loop's section is never created by this pass at all, so the link that
    // says what is in it cannot defer anything.
    if (!isDependencyEdge(e)) continue;
    const list = out.get(e.from);
    if (list) list.push(e.to);
    else out.set(e.from, [e.to]);
  }

  const deferred = new Set<string>();
  const queue = graph.nodes
    .filter((n) => n.kind !== "run")
    .flatMap((n) => out.get(n.id) ?? []);
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (deferred.has(id)) continue;
    deferred.add(id);
    queue.push(...(out.get(id) ?? []));
  }
  return deferred;
}

/* ------------------------------------------------------------------ */
/* Halting — one door, whatever state the instance is in               */
/* ------------------------------------------------------------------ */

/**
 * Why an instance is being halted.
 *
 * The one thing an operator's stop and a tripped guard differ by. Everything
 * else about the halt — which members it selects, what each becomes, what it
 * refuses to touch — is identical, which is why there is one function and not
 * two: a second implementation is a second chance to forget a member, and a
 * missed member goes on spending.
 */
export type HaltCause =
  | { kind: "operator" }
  /** The guard's verdict, in full. Recorded on the instance, once. */
  | { kind: "guard"; detail: string }
  /**
   * Taken down with everything else, by one install-wide stop.
   *
   * A third kind rather than `operator` with different words, because the
   * question it answers afterwards is a different one: an operator who finds
   * twenty-five stopped runs needs to know whether somebody stopped *this*
   * workflow or reached for the switch that stops everything, and only the
   * stored cause can say so once the sentence has scrolled off.
   */
  | { kind: "fleet" };

/** One member as the decision sees it: an id, a name, and a status. */
export interface HaltMember {
  runId: string;
  nodeName: string;
  /** Null when the run row has gone — the mapping is a historical record. */
  status: RunStatus | null;
}

/**
 * What happens to one member, and what gets written on it.
 *
 * Three actions, and each is a decision this app has already made once:
 *
 *   `stop` hands it to `stopRun`. A run with a child in flight gets the kill
 *   ladder — `SIGINT` first, so a CLI that handles it can still print `result`
 *   and have its cycle *measured* rather than reconciled — and a run that has
 *   not spawned takes one of that function's pre-spawn branches. There is
 *   deliberately no second way to signal a child anywhere in this app.
 *
 *   `block` is for a member that never started and now never will: `blocked`,
 *   with nothing spent. `stopRun` would write `stopped` here, which is right
 *   when the operator is stopping *that run* — but a halted member was not
 *   singled out and it never ran, and `blocked` is what this app already writes
 *   for a run refused before its first work cycle. It also keeps it out of
 *   `REOPENABLE`, which is the honest answer: reopening one link of a chain
 *   whose predecessors were just stopped would start it on work that never
 *   happened.
 *
 *   `leave` is a member already terminal, or one whose run row has gone.
 *   Rewriting a `completed` member as stopped destroys the record of work that
 *   landed, which is the silent half of getting this wrong.
 *
 * A union rather than an optional field, so a member left alone cannot carry a
 * reason and a member being ended cannot lack one. For `block` the reason is the
 * whole sentence; for `stop` it is the attribution handed to `stopRun`, which
 * appends the clause saying what the run was doing when the halt landed.
 */
export type HaltStepOf<T> =
  | (T & { action: "stop" | "block"; reason: string })
  | (T & { action: "leave"; reason: null });

export type HaltStep = HaltStepOf<HaltMember>;

/** What a halt does to one member, for a caller that wants to name it. */
export type HaltAction = HaltStep["action"];

export interface HaltDecision {
  /** False when there is nothing to do: already stopping, or never started. */
  act: boolean;
  /** Why not, in the operator's words. Null when `act` is true. */
  note: string | null;
  /** The attribution every stopped member carries. */
  cause: string;
  /** Empty when `act` is false — an instance is halted once. */
  steps: HaltStep[];
}

/**
 * Who stopped this run, in the words that go on the row.
 *
 * A **fragment**, because `stopRun` completes it with the clause naming what the
 * run was doing ("… before it started."). Three endings have to be tellable
 * apart on sight, and these are two of them; the third is `stopRun`'s own
 * default, `Stopped by operator`, which is what a run stopped on its own page
 * says. A guard's verdict is deliberately *not* pasted in here — it is one fact
 * about one instance and lives on the instance row, rather than repeated across
 * ten member rows where it would read as ten separate findings.
 */
export function haltCause(cause: HaltCause, workflowName: string): string {
  if (cause.kind === "fleet") {
    return `Stopped by the operator with every run in flight, workflow “${workflowName}” among them`;
  }
  return cause.kind === "operator"
    ? `Stopped by the operator with all of workflow “${workflowName}”`
    : `Stopped by the budget guard on workflow “${workflowName}”`;
}

/**
 * What a halt does to each member — the whole decision, and nothing that writes.
 *
 * Pure and unit-tested for the reason `releasableRuns` and `selectPromotable`
 * are: both ways of being wrong are silent and expensive. A member the selection
 * misses goes on spending under a workflow the operator believes is stopped; a
 * `completed` member rewritten as stopped destroys the record of work that
 * landed, and there is nothing on the page afterwards to say it ever happened.
 *
 * `members` is the instance's run list *as it stands*, which is what makes a
 * stop arriving mid-instantiation a non-event: a block whose `createRun` has not
 * happened is not in the table, so it is not selected — and it is never created
 * either, because `startWorkflow` holds the event-loop turn from its first
 * `createRun` to its last and a rolled-back pass leaves the instance `failed`,
 * which this refuses.
 */
export function haltPlan(
  instance: {
    status: WorkflowInstanceStatus;
    workflowName: string;
    /**
     * Orchestrator blocks still deciding, or still waiting to. Counted here
     * because "nothing is live, so there is nothing to halt" must not be
     * answered from the runs alone: a graph whose only remaining member is a
     * block with a billed child in flight would otherwise be told it had
     * already finished, and the child would go on to start runs.
     */
    liveBlocks: number;
  },
  members: readonly HaltMember[],
  cause: HaltCause,
): HaltDecision {
  const attribution = haltCause(cause, instance.workflowName);

  // Idempotence, stated as a decision rather than left to the UPDATE that
  // enforces it: a second stop must be a no-op, not a second kill ladder run
  // over children that are already dying.
  if (!instanceIsOpen(instance.status)) {
    const note =
      instance.status === "failed"
        ? "This workflow run never started — its blocks were rolled back when it was created."
        : instance.status === "stopped"
          ? "This workflow run has already been stopped."
          : "This workflow run is already stopping.";
    return { act: false, note, cause: attribution, steps: [] };
  }

  // Nothing is live, so there is no door to close: every member has settled and
  // no block is left to create another, so nothing can move again. Recording a
  // halt here would put "stopped by the operator" on a run of a workflow that
  // finished on its own, which is a false thing to say about work that landed.
  if (
    instance.liveBlocks === 0 &&
    !members.some((m) => m.status && LIVE_STATUSES.includes(m.status))
  ) {
    return {
      act: false,
      note: "Every block of this workflow run has already finished.",
      cause: attribution,
      steps: [],
    };
  }

  return {
    act: true,
    note: null,
    cause: attribution,
    steps: haltSteps(members, attribution),
  };
}

/**
 * What happens to each row, given the attribution it will be recorded under.
 *
 * Generic over the row, and exported, because "which rows does this take down"
 * now has a second caller: an install-wide stop covers runs that belong to no
 * workflow at all. A second copy of these three branches would be a second
 * chance to rewrite a `completed` row as stopped, or to hand `stopRun` a member
 * that never ran and record it as though it had — and both are silent.
 */
export function haltSteps<T extends { status: RunStatus | null }>(
  members: readonly T[],
  attribution: string,
): Array<HaltStepOf<T>> {
  return members.map((member): HaltStepOf<T> => {
    if (member.status === null) {
      return { ...member, action: "leave" as const, reason: null };
    }
    if (member.status === "waiting") {
      return {
        ...member,
        action: "block" as const,
        reason: `${attribution} while it was waiting for another run.`,
      };
    }
    if (LIVE_STATUSES.includes(member.status)) {
      return { ...member, action: "stop" as const, reason: attribution };
    }
    return { ...member, action: "leave" as const, reason: null };
  });
}

/** Statuses a run has not finished in — it will spend, or is waiting to. */
export { LIVE_STATUSES };

/** What a halt did, per member, for the caller to report. */
export interface HaltReport {
  instanceId: string;
  workflowName: string;
  /** False when nothing was done; `note` says why. */
  acted: boolean;
  note: string | null;
  /** Members whose child got the kill ladder. */
  signalled: string[];
  /** Members closed out before they could spawn. */
  cancelled: string[];
  /** Members that were still waiting, now `blocked`. */
  blocked: string[];
  /** Members already finished, or whose row has gone. */
  untouched: string[];
  /** Orchestrator blocks written off: waiting ones, and turns in flight. */
  blocksHalted: number;
  /** Queued merges belonging to these runs, cancelled. */
  mergesCancelled: number;
}

export type HaltOutcome =
  | { ok: true; report: HaltReport }
  | { ok: false; reason: string };

/**
 * Halt a whole workflow instance, whatever state each of its members is in.
 *
 * **The one door.** An operator control and a tripped instance guard both call
 * this, and differ only in the `cause` recorded — the alternative is two
 * implementations of a selection whose failure modes are silent.
 *
 * **The door is closed before anything is signalled.** The instance is marked
 * `stopping` first, by an UPDATE guarded on `status='started'`, and from there
 * to the last member there is **no `await`** — the property `createRun`'s folder
 * claim documents, for the same reason: one event-loop turn is what makes a
 * check-then-act atomic here, and a member that starts after the stop began is
 * exactly the bug the ordering prevents. The guarded UPDATE is also the
 * idempotence: a second stop changes no rows and does nothing.
 *
 * **Waiting members are blocked before any of the others are touched.** Stopping
 * a run releases its dependents, and a dependent released a moment before the
 * halt reaches it would be admitted, promoted and spawned — a member starting
 * *because* the workflow was stopped. Blocked first, there is nothing left to
 * release.
 *
 * Stopping a queued member can still promote another queued member into
 * `running` inside this same turn, since `stopRun` frees the folder reservation
 * and `promoteQueued` acts on it. That is harmless and deliberately not designed
 * around: `stopRun` re-reads the row, so it takes the `running` branch and
 * registers an interrupt, and `startRun`'s pre-spawn checkpoint sees it before
 * any child is spawned. The cost is a transcript scan, not a billed work cycle.
 *
 * What it does **not** do: it never removes a checkout, never touches a branch,
 * and never commits. Work an agent left uncommitted stays in its slot with its
 * own branch checked out, where `slotIsDirty` keeps the next run out of it and
 * the run page's Commit — which goes through `commitRefusal`, the function that
 * already settled whose work is in a slot — is the way it reaches the branch.
 * Committing ten runs from here would need ten `await`s in the middle of the one
 * stretch that must not have any.
 */
/** Every member of one instance, with the status its run row has now. */
function membersOf(instanceId: string): HaltMember[] {
  return db()
    .prepare(
      `SELECT w.run_id AS runId, w.node_name AS nodeName, r.status AS status
         FROM workflow_instance_runs w
         LEFT JOIN runs r ON r.id = w.run_id
        WHERE w.instance_id = ? ORDER BY w.position`,
    )
    .all(instanceId) as HaltMember[];
}

export function stopInstance(instanceId: string, cause: HaltCause): HaltOutcome {
  const instance = getInstance(instanceId);
  if (!instance) return { ok: false, reason: "No such workflow run." };

  const members = membersOf(instanceId);
  const liveBlocks = instance.blocks.filter((b) =>
    LIVE_BLOCK_STATUSES.includes(b.status),
  ).length;
  const plan = haltPlan({ ...instance, liveBlocks }, members, cause);
  const report: HaltReport = {
    instanceId,
    workflowName: instance.workflowName,
    acted: plan.act,
    note: plan.note,
    signalled: [],
    cancelled: [],
    blocked: [],
    untouched: [],
    blocksHalted: 0,
    mergesCancelled: 0,
  };
  if (!plan.act) return { ok: true, report };

  // The door. Guarded on the status the plan was decided from, so the decision
  // and the write cannot disagree — nothing in this process can interleave with
  // the read above, and the guard is what makes that a statement rather than an
  // assumption. Zero changes means another writer got here first, which is the
  // second stop this is idempotent against.
  const claimed = db()
    .prepare(
      `UPDATE workflow_instances
          SET status='stopping', stopped_at=?, stop_cause=?, stop_reason=?
        WHERE id=? AND status='started'`,
    )
    .run(
      Date.now(),
      cause.kind,
      cause.kind === "guard" ? cause.detail : null,
      instanceId,
    );
  if (claimed.changes !== 1) {
    return {
      ok: true,
      report: {
        ...report,
        acted: false,
        note: "This workflow run is already stopping.",
      },
    };
  }

  walkMembers(plan.steps, plan.cause, report, instanceId);
  return { ok: true, report };
}

/**
 * Carry out a plan: the writes, in the order the halt needs them.
 *
 * Synchronous from the first member to the last, and separated from
 * `stopInstance` only so a restart that caught a halt part-way can finish the
 * same walk rather than a second version of it.
 */
function walkMembers(
  steps: readonly HaltStep[],
  cause: string,
  report: HaltReport,
  instanceId: string,
): void {
  // Blocks before anything else, and for a sharper version of the reason
  // waiting members go before running ones: a block does not merely get
  // *released* by a stop, it creates runs. One left `thinking` while the walk
  // ran could emit into a workflow that is being taken down, and every run it
  // started would be a member the halt had already walked past.
  report.blocksHalted = haltBlocks(instanceId, cause);

  // Waiting first — see `stopInstance`. Nothing between here and the end of the
  // walk yields to the event loop.
  for (const step of steps) {
    if (step.action !== "block") continue;
    if (blockWaitingRun(step.runId, step.reason)) report.blocked.push(step.runId);
    else report.untouched.push(step.runId);
  }

  for (const step of steps) {
    if (step.action !== "stop") continue;
    const outcome = stopRun(step.runId, cause);
    if (outcome === "signalled") report.signalled.push(step.runId);
    else if (outcome === "cancelled") report.cancelled.push(step.runId);
    else report.untouched.push(step.runId);
  }

  for (const step of steps) {
    if (step.action === "leave") report.untouched.push(step.runId);
  }

  // A merge already in flight is left alone, exactly as cancelling a batch
  // leaves it: it is a multi-step write into the operator's own checkout, and
  // stopping half way through is worse than the second it takes to finish.
  report.mergesCancelled = cancelQueuedFor(
    steps.map((s) => s.runId),
    `${cause}.`,
  );

  // A run outside this instance may have been told to start after one of these.
  // `stopRun`'s pre-spawn branches call both already; blocking a waiting member
  // does not, and neither runs at all when every member had a child in flight.
  releaseDependents();
  promoteQueued();
}

/**
 * Take down every block of an instance that has not settled.
 *
 * `blocked` for a block that never started — the status this app already writes
 * for work refused before it cost anything, and the true thing to say — and
 * `failed` for one whose child was in flight or whose passes had begun, because
 * that work was billed and saying it never ran would hide the spend already
 * recorded against it. All three are written *before* the child is signalled, so
 * the guarded UPDATE in `emitBlockRuns`, the one in `settleBlock` and the one in
 * `settleLoop` all refuse whatever the dying block still tries to do — a loop in
 * particular, because a `looping` row is the only thing standing between a
 * settling pass and the creation of the next one.
 *
 * The signal ladder is the one every other child here gets, `SIGINT` first.
 */
function haltBlocks(instanceId: string, cause: string): number {
  const now = Date.now();
  // The wording is per kind and the statement is not: what a block was doing is
  // what the operator needs to read, but *which* blocks come down is one rule,
  // and two statements per status would be two chances to add a kind to one and
  // not the other.
  const halted =
    db()
      .prepare(
        "UPDATE workflow_instance_blocks SET status='blocked', finished_at=?," +
          " error = CASE kind WHEN 'merge' THEN ? WHEN 'review' THEN ? ELSE ? END" +
          " WHERE instance_id=? AND status='waiting'",
      )
      .run(
        now,
        `${cause} before it landed anything.`,
        `${cause} before it reviewed anything.`,
        `${cause} before it started deciding.`,
        instanceId,
      ).changes +
    db()
      .prepare(
        "UPDATE workflow_instance_blocks SET status='failed', finished_at=?," +
          " error = CASE kind WHEN 'merge' THEN ? WHEN 'review' THEN ? ELSE ? END" +
          " WHERE instance_id=? AND status='thinking'",
      )
      .run(
        now,
        // The merges already queued are cancelled by `walkMembers` a moment
        // later; one in flight is left to finish, exactly as `cancelBatch` has
        // it, so the batch's own rows stay the record of which branches landed.
        `${cause} while it was landing branches.`,
        `${cause} while it was reviewing branches.`,
        `${cause} while it was deciding what to start.`,
        instanceId,
      ).changes +
    // A separate statement rather than a third arm of the CASE above, because
    // this one selects a different status: a loop between passes has no child
    // in flight and is `looping`, not `thinking`.
    db()
      .prepare(
        "UPDATE workflow_instance_blocks SET status='failed', finished_at=?, error=?" +
          " WHERE instance_id=? AND status='looping'",
      )
      .run(now, `${cause} while it was repeating its task.`, instanceId).changes;

  for (const [key, child] of blockTurns) {
    if (!key.startsWith(`${instanceId}:`)) continue;
    blockTurns.delete(key);
    signalLadder(child);
  }

  // A review block's reviewers too: each is a billed child this instance
  // started, and left alone it ran to its answer under a page already reading
  // the workflow as stopped. Its row settles as the child exits, and
  // `memberTally` counts it live until then. `driveReviewItem` banks whatever
  // it reported on the way out.
  for (const reviewId of runningReviewsOf(instanceId)) {
    const child = assistChild(reviewId);
    if (child) signalLadder(child);
  }

  return halted;
}

/** The ladder every child here is stopped with, `SIGINT` first so it may report its cost. */
function signalLadder(child: ChildProcess): void {
  const running = () => child.exitCode === null && child.signalCode === null;
  signalTree(child, "SIGINT");
  setTimeout(() => {
    if (running()) signalTree(child, "SIGTERM");
  }, 3_000).unref?.();
  setTimeout(() => {
    if (running()) signalTree(child, "SIGKILL");
  }, 8_000).unref?.();
}

/**
 * The reviews this instance's review blocks have in flight.
 *
 * Only an item's current `review_id` can be running: a branch is reviewed one
 * round at a time, and an earlier round's row settled before the next began.
 */
function runningReviewsOf(instanceId: string): string[] {
  return (
    db()
      .prepare(
        `SELECT rv.id AS id FROM workflow_review_items i
           JOIN run_reviews rv ON rv.id = i.review_id
          WHERE i.instance_id = ? AND rv.status = 'running'`,
      )
      .all(instanceId) as Array<{ id: string }>
  ).map((r) => r.id);
}

/**
 * Finish a halt the process died in the middle of.
 *
 * The walk holds its event-loop turn from the first member to the last, so this
 * needs a crash *inside* that block — but the residue is a member of a stopped
 * workflow that goes on spending, which is the one outcome the halt exists to
 * have none of. `reconcileOnBoot` closes out `running` and `queued` rows
 * already, and the `waiting` rows behind them; what it deliberately spares is a
 * recently `paused` one and whatever still waits on something live or held, and
 * the sweeper would then re-queue the paused one, or a later release pass admit
 * the waiting one, under a workflow the page says is stopped.
 *
 * Runs **after** `reconcileOnBoot`, so what is left is only that residue, and it
 * re-uses the recorded cause rather than inventing one: the halt was the
 * operator's or the guard's, and a restart is neither.
 */
export function reconcileHaltsOnBoot(): void {
  const rows = db()
    .prepare(
      "SELECT id, workflow_name, stop_cause FROM workflow_instances WHERE status = 'stopping'",
    )
    .all() as Array<{ id: string; workflow_name: string; stop_cause: string | null }>;

  for (const row of rows) {
    const members = membersOf(row.id);
    // `looping` among them, the reading `stopInstance` and `BlockStatus` both
    // insist on: between two passes a loop has no child in flight and no live
    // member, so an instance whose only residue is a loop would be read as
    // having finished on its own — and left `looping` under a `stopping` row it
    // would commit a whole further pass the operator had already stopped.
    const liveBlocks = blocksOf(row.id).filter((b) =>
      LIVE_BLOCK_STATUSES.includes(b.status),
    ).length;
    if (
      liveBlocks === 0 &&
      !members.some((m) => m.status && LIVE_STATUSES.includes(m.status))
    ) {
      continue;
    }
    const cause = haltCause(
      row.stop_cause === "guard"
        ? { kind: "guard", detail: "" }
        : row.stop_cause === "fleet"
          ? { kind: "fleet" }
          : { kind: "operator" },
      row.workflow_name,
    );
    walkMembers(
      haltSteps(members, cause),
      cause,
      {
        instanceId: row.id,
        workflowName: row.workflow_name,
        acted: true,
        note: null,
        signalled: [],
        cancelled: [],
        blocked: [],
        untouched: [],
        blocksHalted: 0,
        mergesCancelled: 0,
      },
      row.id,
    );
  }
}

/* ------------------------------------------------------------------ */
/* The workflow-wide guard                                             */
/* ------------------------------------------------------------------ */

/**
 * The instance a run belongs to, if any, with everything the guard reads.
 *
 * Null for a run started any other way, which is every run in this app except a
 * workflow's. One indexed lookup on the join table, and it is the first thing
 * the guard does, so the ordinary case costs one query and stops.
 */
function guardedInstanceOf(runId: string): {
  instanceId: string;
  status: string;
  budget: InstanceBudgetPolicy;
} | null {
  const row = db()
    .prepare(
      `SELECT i.id AS instanceId, i.status AS status,
              i.instance_budget AS budget
         FROM workflow_instance_runs w
         JOIN workflow_instances i ON i.id = w.instance_id
        WHERE w.run_id = ?`,
    )
    .get(runId) as
    | { instanceId: string; status: string; budget: string | null }
    | undefined;
  if (!row) return null;

  const budget = parseInstanceBudget(row.budget);
  if (instanceBudgetIsOff(budget)) return null;
  return { instanceId: row.instanceId, status: row.status, budget };
}

/**
 * Stop the whole workflow if this member is about to push it past its limits.
 *
 * **Between nodes, not during one.** Called from `startRun`'s pre-cycle guard,
 * off the snapshot that check has just read, at the one moment a member is
 * about to commit to spending and nothing has been spawned yet. For the default
 * `maxIterations: 1` a run has exactly one cycle boundary — its start — so this
 * is literally "before the next block starts work"; for a multi-cycle block it
 * is every boundary, which is tighter and never looser.
 *
 * There is deliberately **no live mode**. `liveGuardTick` reads one run's policy
 * against that run's own progress and interrupts that one child, and every code
 * on `LIVE_ENFORCEABLE_CODES` is a fact about a run; extending it to halt a
 * whole instance would kill every member mid-cycle, turning each one's measured
 * `result` cost into a reconciled estimate, in exchange for a bound that is
 * already one cycle in the ordinary case. What that costs is stated rather than
 * hidden: a block already working keeps working until some block reaches a cycle
 * boundary, so the total can overshoot by up to one work cycle for each block
 * running at the time — and several blocks at once multiply it. The instance
 * page says exactly that, in those words.
 *
 * Returns what happened, so the caller can put it in this run's log; null when
 * there was nothing to check or the guard passed. It does not signal this run
 * itself: `stopInstance` is the one door a halt goes through and it stops every
 * member including this one, which `startRun`'s pre-spawn checkpoint then sees
 * as an ordinary interrupt.
 */
export type InstanceGuardOutcome = {
  /**
   * `halted` — the workflow is being taken down, this run with it.
   * `unenforceable` — the verdict is real but is not one an instance may be
   * halted on. See `INSTANCE_ENFORCEABLE_CODES`; today that is `no_ceiling`
   * alone, and the caller says so in the log rather than acting on it.
   */
  kind: "halted" | "unenforceable";
  verdict: BudgetVerdict & { allowed: false };
};

export function enforceInstanceBudget(
  runId: string,
  snapshot: UsageSnapshot,
): InstanceGuardOutcome | null {
  const instance = guardedInstanceOf(runId);
  if (!instance) return null;
  return guardInstance(instance.instanceId, instance.status, instance.budget, snapshot);
}

/**
 * The same guard, at the boundary the three above cannot see: a member has
 * just **finished spending**.
 *
 * Every other call site is "before something spends", and for the ordinary
 * graph that is not a boundary at all. A member with `maxIterations: 1` — which
 * is what `normalizePolicy` answers when a template says nothing, and the run
 * form's own default — reaches `startRun`'s pre-cycle guard exactly once,
 * before its only cycle; the pass that would have seen that cycle's cost is
 * refused on `iterations` and `break`s out *ahead* of the instance check. So a
 * graph of single-cycle blocks released together checked the instance budget N
 * times, all of them against a total of zero, and never again. The
 * workflow-wide limit could not fire at all — `CLAUDE.md` named that as the
 * limiting case, and at 25 nodes with a 25-way concurrency cap it is the
 * ordinary one.
 *
 * Called from `startRun`'s `finally`, after the status write has put this
 * member's spend on its row, so `instanceSpend` reads it. That turns "the guard
 * never fires" into "the guard fires one cycle late", which is the bound the
 * documentation already claims and the same bound the pre-cycle check gives a
 * multi-cycle block.
 *
 * Async only because the window fractions need a reading, and a member settling
 * is a far rarer event than a cycle boundary — the transcript scan is paid once
 * per finished run, not once per cycle. `guardedInstanceOf` is one indexed
 * lookup and answers null for every run that is not a member and every instance
 * whose budget is off, so an install with no workflows pays a single query.
 */
export async function enforceInstanceBudgetAfterMember(
  runId: string,
): Promise<InstanceGuardOutcome | null> {
  const instance = guardedInstanceOf(runId);
  if (!instance) return null;
  // Asked before the snapshot rather than left to `guardInstance`: a halted or
  // rolled-back instance has nothing to decide, and a full transcript scan to
  // find that out is the one cost worth avoiding here.
  if (instance.status !== "started") return null;
  return guardInstance(
    instance.instanceId,
    instance.status,
    instance.budget,
    await currentSnapshot(),
  );
}

/**
 * The same guard, at the other kind of block boundary.
 *
 * An orchestrator block is about to spend and is not a member run, so the check
 * above — which hangs off `startRun`'s pre-cycle guard — cannot see it. Left
 * out, a graph of nothing but deciding blocks would have a workflow-wide limit
 * that never fires, and a graph past its limit could still pay for one more
 * decision before the first run it started reached a cycle boundary.
 *
 * Deliberately the same door and the same verdict vocabulary: an instance limit
 * with its own words for "no ceiling configured" would be a second set of budget
 * rules to keep in step.
 */
export function enforceInstanceBudgetForBlock(
  instanceId: string,
  snapshot: UsageSnapshot,
): InstanceGuardOutcome | null {
  const row = db()
    .prepare(
      "SELECT status, instance_budget AS budget FROM workflow_instances WHERE id = ?",
    )
    .get(instanceId) as { status: string; budget: string | null } | undefined;
  if (!row) return null;

  const budget = parseInstanceBudget(row.budget);
  if (instanceBudgetIsOff(budget)) return null;
  return guardInstance(instanceId, row.status, budget, snapshot);
}

function guardInstance(
  instanceId: string,
  status: string,
  budget: InstanceBudgetPolicy,
  snapshot: UsageSnapshot,
): InstanceGuardOutcome | null {
  // `started` only. A `stopping` instance is already being taken down and a
  // second halt would run a second kill ladder; a `failed` one was rolled back.
  if (status !== "started") return null;

  const verdict = evaluateInstanceBudget(
    budget,
    snapshot,
    instanceSpend(instanceId),
  );
  if (verdict.allowed) return null;
  if (!INSTANCE_ENFORCEABLE_CODES.includes(verdict.code)) {
    return { kind: "unenforceable", verdict };
  }

  // The halt function, called rather than re-implemented: an operator's stop
  // and this differ only in the cause recorded, and a second selection of "which
  // members does this take down" is a second chance to miss one.
  stopInstance(instanceId, { kind: "guard", detail: verdict.reason });
  return { kind: "halted", verdict };
}

/* ------------------------------------------------------------------ */
/* Orchestrator blocks: deciding, then starting what was decided        */
/* ------------------------------------------------------------------ */

/**
 * A block turn that has produced nothing for this long is not going to.
 *
 * The chat's bound, not a second one: it is the same child doing the same kind
 * of work, and a separate number here would be a second thing to keep in step
 * with a bound that already exists. That includes what the number now
 * *measures* — silence rather than duration — and the argument carries over
 * whole: a block asked to decide across a repository is a long turn rather than
 * a stuck one, and there is nobody watching this one to notice it was killed
 * for being thorough.
 */
const BLOCK_IDLE_TIMEOUT_MS = CHAT_IDLE_TIMEOUT_MS;

const BLOCK_TIMED_OUT =
  `This block produced nothing for ${BLOCK_IDLE_TIMEOUT_MS / 60_000} minutes and was stopped.`;

/**
 * The block turns this process can still signal.
 *
 * The row says a turn is in flight; this says whether anything is still there to
 * stop. On `globalThis` for the reason `chat.ts`'s registry is — a dev hot
 * reload would otherwise lose the handle on a live, billed child and leave a
 * halt with nothing to signal.
 */
const blockTurns = ((globalThis as unknown as {
  __ufBlockTurns?: Map<string, ChatProcess>;
}).__ufBlockTurns ??= new Map<string, ChatProcess>());

const turnKey = (instanceId: string, nodeId: string) => `${instanceId}:${nodeId}`;

/** One block's row, as the scheduler and the emit tool read it. */
interface BlockRow {
  instance_id: string;
  node_id: string;
  node_name: string;
  position: number;
  kind: WorkflowNodeKind;
  status: BlockStatus;
  cost_usd: number;
  emitted_specs: string | null;
  error: string | null;
  notes: string | null;
}

function getBlock(instanceId: string, nodeId: string): BlockRow | null {
  return (
    (db()
      .prepare(
        "SELECT * FROM workflow_instance_blocks WHERE instance_id = ? AND node_id = ?",
      )
      .get(instanceId, nodeId) as BlockRow | undefined) ?? null
  );
}

/**
 * Add one line to what this app recorded about a turn.
 *
 * Appended rather than set, because these arrive one at a time from four places
 * across the life of a turn — the guard before it spawns, each `emit_runs` this
 * app refuses while it runs, `settleBlock` when it ends, and `createEmitted`
 * after that for each decided run it could not create — and the operator is
 * reading them to find out why nothing started. A note that overwrote the last
 * one would answer that question with whichever refusal happened to be last.
 */
function noteBlock(instanceId: string, nodeId: string, line: string): void {
  db()
    .prepare(
      "UPDATE workflow_instance_blocks" +
        " SET notes = TRIM(COALESCE(notes || char(10), '') || ?)" +
        " WHERE instance_id=? AND node_id=?",
    )
    .run(line, instanceId, nodeId);
}

/**
 * Put every deferred node blocked behind `roots` back to `waiting`, so the next
 * advance pass decides it again on what is true now.
 *
 * `reviveBlockedDependents` for the half of a graph that is not runs yet, and it
 * exists for that function's reason exactly: a `blocked` ledger row is a
 * sentence about an ending that reopening a run has just undone, and nothing
 * else in this app would ever revisit it. `planInstanceStep` skips any node
 * whose row is not `waiting`, and this is the only writer that puts one back —
 * so without it a node deferred behind an orchestrator or a merge block is
 * skipped for ever once anything writes it off, the instance reaches the end of
 * its graph with the tail missing, and the row still names a failure the
 * operator has since reversed.
 *
 * Deliberately not a release, the same way the run half is not: this reopens the
 * *question*. `advanceInstance` still answers it, creating the node if the
 * dependency now satisfies its edge and blocking it again — with a sentence
 * about the current ending — if it does not. So the worst this can do is
 * rewrite a stale reason.
 *
 * The halt exclusion is the membership condition and it is stated positively:
 * only an instance still `started` is walked. A `stopping` one is left alone,
 * whose every open block `haltBlocks` has just written off, and so is a `failed`
 * one, rolled back as it was created. There is no way back into a halted
 * workflow through a member, and this must not become one.
 *
 * Reachability is `revivableDependents` over the graph's own edges rather than
 * over `run_deps`: a deferred node has no run, so it has no dependency rows yet.
 * It walks only through the rows it is reviving, for that function's reason. A
 * root that is an *emitted* run enters the graph at the block that emitted it —
 * `emitted_by` — because that block's node is what the edges behind it were
 * drawn from; the emitted run's own `node_id` names no node in the graph.
 */
export function reviveBlockedBlocks(roots: readonly string[]): number {
  if (roots.length === 0) return 0;

  const rows = db()
    .prepare(
      `SELECT w.instance_id AS instanceId, w.node_id AS memberId,
              COALESCE(w.emitted_by, w.node_id) AS nodeId
         FROM workflow_instance_runs w
         JOIN workflow_instances i ON i.id = w.instance_id
        WHERE i.status = 'started'
          AND w.run_id IN (${roots.map(() => "?").join(",")})`,
    )
    .all(...roots) as Array<{ instanceId: string; memberId: string; nodeId: string }>;
  if (rows.length === 0) return 0;

  const byInstance = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byInstance.get(row.instanceId);
    if (list) list.push(row);
    else byInstance.set(row.instanceId, [row]);
  }

  let revived = 0;
  for (const [instanceId, members] of byInstance) {
    const instance = getInstance(instanceId);
    if (!instance) continue;
    revived += reviveGraphDependents(
      instance,
      members.map((m) => m.nodeId),
    );
    // A root inside a pass has no node of the graph to walk from — its id is
    // the pass's, not the section's — so what its ending wrote off is the rest
    // of its pass and, when that pass stopped the loop, the loop itself. A
    // refusal here is not the reopen's business: the run is picked up either
    // way, and the instance page offers the same question with its answer.
    for (const pass of passRootsOf(instance, members.map((m) => m.memberId))) {
      if (loopPassRefusal(instance, pass.loopNodeId, pass.pass) !== null) continue;
      revived += db().transaction(() =>
        reopenLoopPass(instance, pass.loopNodeId, pass.pass),
      )();
    }
  }
  return revived;
}

/**
 * Put every blocked node of one instance reachable from `nodeIds` back to
 * `waiting` — the graph half of `reviveBlockedBlocks`, and of every pick-up.
 */
function reviveGraphDependents(
  instance: WorkflowInstance,
  nodeIds: readonly string[],
): number {
  const candidates = instance.blocks
    .filter((b) => b.status === "blocked")
    .map((b) => b.nodeId);
  if (candidates.length === 0 || nodeIds.length === 0) return 0;

  const links = instance.graph.edges
    .filter(isDependencyEdge)
    .map((e) => ({
      runId: e.to,
      dependsOn: e.from,
      edge: e.edge as DependencyEdge,
    }));
  const reopen = db().prepare(
    "UPDATE workflow_instance_blocks SET status='waiting', error=NULL, finished_at=NULL" +
      " WHERE instance_id=? AND node_id=? AND status='blocked'",
  );
  let revived = 0;
  for (const nodeId of revivableDependents(nodeIds, candidates, links)) {
    // Guarded on `blocked` for `upsertBlock`'s reason: a row that settled
    // between the read and the write keeps its own answer.
    revived += reopen.run(instance.id, nodeId).changes;
  }
  return revived;
}

/** The distinct passes a set of member ids belongs to. */
function passRootsOf(
  instance: WorkflowInstance,
  memberIds: readonly string[],
): Array<{ loopNodeId: string; pass: number }> {
  const seen = new Map<string, { loopNodeId: string; pass: number }>();
  for (const id of memberIds) {
    const member = passMemberIn(instance.graph, id);
    if (member) seen.set(`${member.loopNodeId}#${member.pass}`, member);
  }
  return [...seen.values()];
}

/**
 * The first block behind `nodeId` that has already left `waiting`, by name, or
 * null.
 *
 * What makes reopening a settled block safe to offer at all. Its successors
 * were decided on its ending — an `on-finish` one may have started on it — and
 * reopening it underneath one that has would put new work in front of a block
 * that has already acted on the old ending: another pass landing on top of the
 * cleanup that followed the loop, or a merge retried after the review that
 * followed it. Only the direct successors are asked, because everything further
 * down depends on one of them and cannot have started first.
 */
function startedBehind(instance: WorkflowInstance, nodeId: string): string | null {
  for (const edge of instance.graph.edges) {
    if (edge.from !== nodeId || !isDependencyEdge(edge)) continue;
    const run = instance.nodes.find((n) => n.nodeId === edge.to);
    if (run) return run.nodeName;
    const block = instance.blocks.find((b) => b.nodeId === edge.to);
    if (block && block.status !== "waiting" && block.status !== "blocked") {
      return block.nodeName;
    }
  }
  return null;
}

/**
 * Why pass `pass` of a loop cannot be carried on, or null when it can.
 *
 * Pure over the instance as read, so a pick-up asks it before writing anything
 * and refuses with the sentence rather than half-reopening. A loop still
 * `looping` is always fine: the pass is live, and reviving its members is the
 * whole of what there is to do.
 */
function loopPassRefusal(
  instance: WorkflowInstance,
  loopNodeId: string,
  pass: number,
): string | null {
  const loop = instance.blocks.find(
    (b) => b.nodeId === loopNodeId && b.kind === "loop",
  );
  if (!loop) return "That loop is not part of this workflow run.";
  const latest = loopPasses(instance.id, loopNodeId).at(-1)?.pass ?? 0;
  if (pass !== latest) {
    return (
      `Pass ${pass} of “${loop.nodeName}” is not its latest — pass ${latest} ` +
      "has started since, so there is nothing of it left to carry on."
    );
  }
  if (loop.status === "looping") return null;
  // `emitted` is a loop that ended on its own terms — done, a limit reached, or
  // the board condition met. Carrying one on past its caps is a new press of
  // Run, and the monotone terminus the caps are is not this door's to lift.
  if (loop.status !== "failed") {
    return (
      `“${loop.nodeName}” ended on its own terms, so there is no stuck pass ` +
      "to pick up — run the workflow again for more passes."
    );
  }
  const started = startedBehind(instance, loopNodeId);
  if (started) {
    return (
      `“${started}” has already started after “${loop.nodeName}” ended, so ` +
      "the loop cannot take more passes in front of it."
    );
  }
  // Asked here because a pick-up is for letting the loop carry on, and one
  // whose board cannot be counted cannot: `advanceLoop` would carry the
  // reopened pass to its landing and then fail the loop again on this same
  // sentence. Refused up front, the operator is told what to fix before a pass
  // is billed rather than after.
  const node = instance.graph.nodes.find((n) => n.id === loopNodeId);
  if (node?.kind === "loop") {
    const board = loopBoardCount(node);
    if (!board.ok) return `Its tasks could not be counted: ${board.error}`;
  }
  return null;
}

/**
 * Reopen pass `pass` of a loop: its blocked members back to `waiting`, a
 * stopped loop back to `looping`, and whatever its stop wrote off behind it
 * back to `waiting` too. Writes only — the caller has asked `loopPassRefusal`,
 * holds the transaction and advances afterwards.
 *
 * The next advance decides everything again on what is true now, exactly as
 * `reviveBlockedBlocks` does for a node: `stepPass` re-plans the members, and
 * `planLoopPass` still reads every rung, so a pass that is stuck for the same
 * reason stops the loop again with the same sentence and a loop at its pass cap
 * stops at its cap. The worst this can do is rewrite a stale reason.
 */
function reopenLoopPass(
  instance: WorkflowInstance,
  loopNodeId: string,
  pass: number,
): number {
  const prefix = `${passPrefix(loopNodeId)}${pass}#`;
  let revived = db()
    .prepare(
      "UPDATE workflow_instance_blocks SET status='waiting', error=NULL, finished_at=NULL" +
        " WHERE instance_id=? AND status='blocked' AND substr(node_id, 1, ?) = ?",
    )
    .run(instance.id, prefix.length, prefix).changes;
  const loop = db()
    .prepare(
      "UPDATE workflow_instance_blocks SET status='looping', error=NULL, finished_at=NULL" +
        " WHERE instance_id=? AND node_id=? AND status='failed'",
    )
    .run(instance.id, loopNodeId);
  if (loop.changes > 0) {
    revived += loop.changes + reviveGraphDependents(instance, [loopNodeId]);
  }
  return revived;
}

/** A run ending that can hold a workflow up, as the pick-up list offers it. */
const STUCK_RUN_STATUSES: readonly RunStatus[] = ["needs-review", "failed", "stopped"];

/** One thing holding a workflow run up, and whether it can be stepped past. */
export type PickUp =
  | {
      kind: "run";
      runId: string;
      nodeName: string;
      status: RunStatus;
      /** Why `leaveRunBehind` would refuse it, or null when it would not. */
      leaveBehindRefusal: string | null;
    }
  | {
      kind: "merge";
      nodeId: string;
      nodeName: string;
      error: string | null;
      /** Why `retryMergeBlock` would refuse it, or null when it would not. */
      retryRefusal: string | null;
    }
  | {
      /**
       * A stopped loop whose latest pass would now go through: what blocked
       * its members has since cleared — most often a run resumed and completed
       * on its own page before resuming a run could reopen a pass.
       */
      kind: "loop";
      nodeId: string;
      nodeName: string;
      pass: number;
      /** Why `resumeLoop` would refuse it, or null when it would not. */
      refusal: string | null;
    };

/**
 * What is holding this workflow run up — each run whose ending wrote off
 * something behind it, and each merge block that failed — for the page to offer
 * one at a time.
 *
 * Answered here rather than on the page, because "did this ending write
 * anything off" is the revive's own reachability and the refusals are the
 * pick-ups' own: a page that re-derived either would offer a button the route
 * then refuses, or hide one it would have honoured.
 *
 * Inside a loop only the pass that stopped it counts: an earlier pass has been
 * carried past already, and nothing it did is holding anything up now.
 */
export function pickUpsOf(instance: WorkflowInstance): PickUp[] {
  if (!instanceIsOpen(instance.status)) return [];

  const blockedNodes = [
    ...instance.blocks.filter((b) => b.status === "blocked").map((b) => b.nodeId),
    ...instance.nodes
      .filter((n) => getRun(n.runId)?.status === "blocked")
      .map((n) => n.nodeId),
  ];
  const links = instance.graph.edges.filter(isDependencyEdge).map((e) => ({
    runId: e.to,
    dependsOn: e.from,
    edge: e.edge as DependencyEdge,
  }));
  const stoppedPasses = new Map<string, number>();
  for (const loop of instance.blocks) {
    if (loop.kind !== "loop" || loop.status !== "failed") continue;
    const last = loopPasses(instance.id, loop.nodeId).at(-1)?.pass;
    if (last !== undefined) stoppedPasses.set(loop.nodeId, last);
  }
  const holdsUp = (memberId: string, graphNodeId: string): boolean => {
    const pass = passMemberIn(instance.graph, memberId);
    if (pass) return stoppedPasses.get(pass.loopNodeId) === pass.pass;
    return revivableDependents([graphNodeId], blockedNodes, links).length > 0;
  };
  const passRefusal = (memberId: string): string | null => {
    const pass = passMemberIn(instance.graph, memberId);
    return pass ? loopPassRefusal(instance, pass.loopNodeId, pass.pass) : null;
  };

  const out: PickUp[] = [];
  for (const node of instance.nodes) {
    if (node.leftBehindAt) continue;
    const run = getRun(node.runId);
    if (!run || !STUCK_RUN_STATUSES.includes(run.status)) continue;
    if (!holdsUp(node.nodeId, node.emittedBy ?? node.nodeId)) continue;
    const waitedOn = db()
      .prepare(
        `SELECT COUNT(*) AS n FROM run_deps d JOIN runs r ON r.id = d.run_id
          WHERE d.depends_on = ? AND r.status IN ('waiting','blocked')`,
      )
      .get(node.runId) as { n: number };
    out.push({
      kind: "run",
      runId: node.runId,
      nodeName: node.nodeName,
      status: run.status,
      leaveBehindRefusal:
        waitedOn.n > 0
          ? "Another run is chained directly behind it, so resuming it is the way through."
          : passRefusal(node.nodeId),
    });
  }
  for (const block of instance.blocks) {
    if (block.kind !== "merge" || block.status !== "failed") continue;
    const pass = passMemberIn(instance.graph, block.nodeId);
    if (pass && stoppedPasses.get(pass.loopNodeId) !== pass.pass) continue;
    const started = pass ? null : startedBehind(instance, block.nodeId);
    out.push({
      kind: "merge",
      nodeId: block.nodeId,
      nodeName: block.nodeName,
      error: block.error,
      retryRefusal: pass
        ? passRefusal(block.nodeId)
        : started
          ? `“${started}” has already started after it failed.`
          : null,
    });
  }
  for (const loop of instance.blocks) {
    const pass = stoppedPasses.get(loop.nodeId);
    if (pass === undefined) continue;
    // Only once nothing above is offered for this pass: a stuck run or a failed
    // merge is the obstacle to name, and carrying the loop on underneath one
    // would stop it again on the same sentence.
    const named = out.some((p) => {
      const id = p.kind === "run"
        ? instance.nodes.find((n) => n.runId === p.runId)?.nodeId
        : p.kind === "merge" ? p.nodeId : undefined;
      const member = id ? passMemberIn(instance.graph, id) : null;
      return member?.loopNodeId === loop.nodeId && member.pass === pass;
    });
    if (named || !passWouldProceed(instance, loop.nodeId, pass)) continue;
    out.push({
      kind: "loop",
      nodeId: loop.nodeId,
      nodeName: loop.nodeName,
      pass,
      refusal: loopPassRefusal(instance, loop.nodeId, pass),
    });
  }
  return out;
}

/**
 * Whether reopening pass `pass` would let its blocked members go now, rather
 * than blocking them again on the same sentence.
 *
 * The scheduler itself, dry: `planInstanceStep` over the section with every
 * blocked member of the pass put back to `waiting`, which is exactly what
 * `reopenLoopPass` writes. A pass with nothing blocked is not a stuck pass.
 */
function passWouldProceed(
  instance: WorkflowInstance,
  loopNodeId: string,
  pass: number,
): boolean {
  const node = instance.graph.nodes.find((n) => n.id === loopNodeId);
  if (!node || node.kind !== "loop") return false;
  const row = loopPasses(instance.id, loopNodeId).find((p) => p.pass === pass);
  const blocked = (row?.members ?? []).filter((m) => m.block?.status === "blocked");
  if (blocked.length === 0) return false;

  const state = passState(row);
  for (const member of blocked) {
    const own = state.get(member.nodeId);
    if (own?.block) state.set(member.nodeId, { ...own, block: { ...own.block, status: "waiting" } });
  }
  const step = planInstanceStep(loopSection(instance.graph, node).graph, state);
  const reblocked = new Set(step.block.map((b) => b.nodeId));
  return blocked.every((m) => !reblocked.has(m.nodeId));
}

/**
 * Carry a stopped loop on from its latest pass, once what stopped that pass has
 * cleared — `pickUpsOf` offers it only when a dry run of the scheduler says the
 * pass would now go through. Every rung of `planLoopPass` is still read after
 * it, so the caps end the loop where they always would have.
 */
export function resumeLoop(instanceId: string, loopNodeId: string): PickUpOutcome {
  const opened = openInstanceFor(instanceId);
  if ("refusal" in opened) return opened.refusal;
  const { instance } = opened;

  const loop = instance.blocks.find((b) => b.nodeId === loopNodeId && b.kind === "loop");
  if (!loop) {
    return { ok: false, status: 404, error: "That loop is not part of this workflow run." };
  }
  const pass = loopPasses(instanceId, loopNodeId).at(-1)?.pass;
  if (pass === undefined || loop.status !== "failed") {
    return {
      ok: false,
      status: 409,
      error: `“${loop.nodeName}” is ${loop.status}, so there is no stopped pass to carry on from.`,
    };
  }
  const refusal = loopPassRefusal(instance, loopNodeId, pass);
  if (refusal) return { ok: false, status: 409, error: refusal };

  db().transaction(() => {
    reopenLoopPass(instance, loopNodeId, pass);
    noteBlock(instanceId, loopNodeId, `Picked up at pass ${pass}: carried on.`);
  })();

  advanceInstances();
  return { ok: true };
}

/** What a pick-up said. `status` is the HTTP answer a refusal maps to. */
export type PickUpOutcome =
  | { ok: true }
  | { ok: false; status: 404 | 409; error: string };

/** The instance a pick-up may act on, or the refusal. */
function openInstanceFor(
  instanceId: string,
): { instance: WorkflowInstance } | { refusal: PickUpOutcome } {
  const instance = getInstance(instanceId);
  if (!instance) {
    return { refusal: { ok: false, status: 404, error: "No such workflow run." } };
  }
  // A halted workflow is halted whole, `reviveBlockedDependents`' rule: waking
  // part of it would put agents back to work under an instance the page reports
  // as stopped, where its budget guard no longer acts.
  if (!instanceIsOpen(instance.status)) {
    return {
      refusal: {
        ok: false,
        status: 409,
        error: `This workflow run is ${instance.status}, so nothing in it can be picked up. Run the workflow again instead.`,
      },
    };
  }
  return { instance };
}

/**
 * Carry a workflow run on past one of its runs rather than through it.
 *
 * For a run that ended without completing — most often `needs-review` — whose
 * ending stopped what was behind it. The run is left exactly as it is: its
 * status, its branch and the question it asked stay on its own page for later,
 * and only this workflow stops waiting on it. `left_behind_at` is the whole
 * record, and every reader of the graph's state honours it the same way — a
 * successor resolves to no run through it, so a merge behind it does **not**
 * land its branch, and a pass is judged on the members it is still waiting for.
 *
 * Refused for a run another *run* waits on through `run_deps`: that edge is
 * `releasableRuns`', which knows nothing of workflows, and a waiver that half
 * the scheduler honoured would leave the other half blocking on it. Resuming
 * the run is the way through there, and the refusal says so.
 *
 * Synchronous from the checks to the advance, for `createRun`'s reason: the
 * advance creates runs, and the state it reads must be the state just written.
 */
export function leaveRunBehind(instanceId: string, runId: string): PickUpOutcome {
  const opened = openInstanceFor(instanceId);
  if ("refusal" in opened) return opened.refusal;
  const { instance } = opened;

  const member = db()
    .prepare(
      `SELECT node_id AS memberId, node_name AS name,
              COALESCE(emitted_by, node_id) AS nodeId, left_behind_at AS leftBehindAt
         FROM workflow_instance_runs WHERE instance_id=? AND run_id=?`,
    )
    .get(instanceId, runId) as
    | { memberId: string; name: string; nodeId: string; leftBehindAt: number | null }
    | undefined;
  if (!member) {
    return { ok: false, status: 404, error: "That run is not part of this workflow run." };
  }

  const run = getRun(runId);
  if (!run || !TERMINAL_STATUSES.includes(run.status) || run.status === "completed") {
    return {
      ok: false,
      status: 409,
      error:
        `“${member.name}” is ${run?.status ?? "gone"}. Only a run that ended ` +
        "without completing can be left behind.",
    };
  }

  const waitedOn = db()
    .prepare(
      `SELECT COUNT(*) AS n FROM run_deps d JOIN runs r ON r.id = d.run_id
        WHERE d.depends_on = ? AND r.status IN ('waiting','blocked')`,
    )
    .get(runId) as { n: number };
  if (waitedOn.n > 0) {
    return {
      ok: false,
      status: 409,
      error:
        `Another run is chained directly behind “${member.name}”, so it cannot ` +
        "be left behind here. Resume it instead, from its own page.",
    };
  }

  const pass = passMemberIn(instance.graph, member.memberId);
  if (pass) {
    const refusal = loopPassRefusal(instance, pass.loopNodeId, pass.pass);
    if (refusal) return { ok: false, status: 409, error: refusal };
  }

  db().transaction(() => {
    db()
      .prepare(
        "UPDATE workflow_instance_runs SET left_behind_at=?" +
          " WHERE instance_id=? AND run_id=? AND left_behind_at IS NULL",
      )
      .run(Date.now(), instanceId, runId);
    if (pass) {
      reopenLoopPass(instance, pass.loopNodeId, pass.pass);
      noteBlock(
        instanceId,
        pass.loopNodeId,
        `Picked up at pass ${pass.pass}: “${member.name}” was left behind.`,
      );
    } else {
      reviveGraphDependents(instance, [member.nodeId]);
    }
  })();

  advanceInstances();
  return { ok: true };
}

/**
 * Run a merge block that failed again, landing whatever of its branches is not
 * on the target yet.
 *
 * Safe to repeat for the reason a merge is safe at all: every branch is
 * previewed against git at its own turn in the queue, and one already on its
 * target is skipped as having nothing to land. So the usual way through a
 * conflict — resolve it on the run's branch, or land that one branch by hand
 * from Branches — ends with a retry that lands the rest and settles the block.
 *
 * The runs it lands are resolved again from its edges rather than recalled, so
 * a run left behind since the failure is not landed now.
 */
export function retryMergeBlock(instanceId: string, nodeId: string): PickUpOutcome {
  const opened = openInstanceFor(instanceId);
  if ("refusal" in opened) return opened.refusal;
  const { instance } = opened;

  const block = instance.blocks.find((b) => b.nodeId === nodeId && b.kind === "merge");
  if (!block) {
    return { ok: false, status: 404, error: "That merge block is not part of this workflow run." };
  }
  if (block.status !== "failed") {
    return {
      ok: false,
      status: 409,
      error: `“${block.nodeName}” is ${block.status}, so there is no failed merge to retry.`,
    };
  }

  const pass = passMemberIn(instance.graph, nodeId);
  const refusal = pass
    ? loopPassRefusal(instance, pass.loopNodeId, pass.pass)
    : startedBehind(instance, nodeId) === null
      ? null
      : `“${startedBehind(instance, nodeId)}” has already started after “${block.nodeName}” failed, so retrying it now would land work behind a block that has moved on.`;
  if (refusal) return { ok: false, status: 409, error: refusal };

  db().transaction(() => {
    db()
      .prepare(
        "UPDATE workflow_instance_blocks SET status='waiting', error=NULL, finished_at=NULL" +
          " WHERE instance_id=? AND node_id=? AND status='failed'",
      )
      .run(instanceId, nodeId);
    if (pass) {
      reopenLoopPass(instance, pass.loopNodeId, pass.pass);
      noteBlock(
        instanceId,
        pass.loopNodeId,
        `Picked up at pass ${pass.pass}: “${block.nodeName}” was retried.`,
      );
    } else {
      reviveGraphDependents(instance, [nodeId]);
    }
  })();

  advanceInstances();
  return { ok: true };
}

/**
 * Move every started instance as far as it can go, right now.
 *
 * Synchronous from end to end, and that is the same requirement `createRun`'s
 * folder claim imposes everywhere else: this creates runs, and one `await` in
 * the middle would let two passes both decide a folder was free. The turns it
 * starts are the exception and are deliberately fire-and-forget — a turn claims
 * its block with a guarded UPDATE *before* anything asynchronous happens, so a
 * second pass arriving a millisecond later finds the block `thinking` and leaves
 * it alone.
 *
 * Called from three places: the end of `startWorkflow` (a block with nothing in
 * front of it is ready immediately), `releaseDependents` (every terminal run
 * transition in the app, which is where a block's dependencies settle), and the
 * settling of a block turn (which may release the next one).
 *
 * `looping` joins `waiting` in the selection because a loop's next pass hangs
 * off exactly the same signal: the pass in front of it reaching a terminal
 * status, which is what `releaseDependents` fires on.
 */
export function advanceInstances(): void {
  const rows = db()
    .prepare(
      `SELECT DISTINCT b.instance_id AS id
         FROM workflow_instance_blocks b
         JOIN workflow_instances i ON i.id = b.instance_id
        WHERE b.status IN ('waiting','looping') AND i.status = 'started'`,
    )
    .all() as Array<{ id: string }>;
  for (const row of rows) advanceInstance(row.id);
}

/** One instance: apply whatever `planInstanceStep` says can happen now. */
function advanceInstance(instanceId: string): void {
  // Loops first, so a loop that settles here is already settled when the plan
  // below is computed and what is behind it is released in this pass rather
  // than one advance later. It cannot go the other way round: a loop that takes
  // another pass writes nothing the plan reads, since a `looping` block is
  // pending to everything behind it either way.
  advanceLoops(instanceId);

  const instance = getInstance(instanceId);
  if (!instance || !instanceIsOpen(instance.status)) return;

  const step = planInstanceStep(instance.graph, instanceState(instance));

  // Blocked first, for `stopInstance`'s reason turned around: a node written
  // off here is a settled predecessor, and doing it before anything is created
  // means the cascade has already reached the bottom of the chain when the
  // creations happen rather than one pass later.
  for (const { nodeId, reason } of step.block) {
    const node = instance.graph.nodes.find((n) => n.id === nodeId);
    upsertBlock(instanceId, node, "blocked", reason);
  }

  const defaults = chatGuards();
  for (const creation of step.create) {
    const node = instance.graph.nodes.find((n) => n.id === creation.nodeId);
    if (!node) continue;
    const plan = planNode(
      node,
      node.templateId ? getTemplate(node.templateId) : null,
      defaults,
      // Read now rather than at `startWorkflow`: this node is being created
      // hours later, behind a decision, so the registry is asked again and an
      // agent that has gone since blocks this one block by name instead of
      // starting a run that is quietly not the thing the graph named.
      node.agentId ? getAgent(node.agentId) : null,
    );
    const ready = plan.ok ? localReady(plan.input, node.name) : plan;
    if (!ready.ok) {
      upsertBlock(instanceId, node, "blocked", ready.reason);
      continue;
    }
    try {
      const run = createRun({
        ...ready.input,
        dependsOn: creation.dependsOn,
        // The instance's own, not this moment's: a node created hours after the
        // press of Run that authorised it belongs to that press, and a
        // scheduled instance's late nodes are still the schedule's. Rows from
        // before the column existed read as a manual press, which is what every
        // instance was until schedules arrived.
        origin: instance.origin ?? "workflow",
        originRef: instance.originRef ?? instanceId,
      });
      // The ledger row held this node's place while it was waiting on a
      // decision, so it carries the position the graph gave it; the row itself
      // goes, because a node in both tables is a block shown twice on the page
      // and counted as live for ever.
      const held = getBlock(instanceId, node.id);
      db()
        .prepare(
          "DELETE FROM workflow_instance_blocks WHERE instance_id=? AND node_id=?",
        )
        .run(instanceId, node.id);
      recordMember(instanceId, {
        nodeId: node.id,
        nodeName: node.name,
        position: held?.position ?? nextPosition(instanceId),
        runId: run.id,
        emittedBy: null,
      });
    } catch (err) {
      // `createRun` refuses a folder that has gone and a dependency graph it
      // cannot satisfy. Either way this block will never run, and a row saying
      // so is the difference between that and a block that quietly vanished.
      upsertBlock(
        instanceId,
        node,
        "blocked",
        `It could not be started: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // A loop's first pass. Claimed and created in the same event-loop turn, so a
  // second advance arriving afterwards finds the block `looping` with a pass in
  // flight and `planLoopPass` tells it to wait — which is the same guarded-UPDATE
  // shape `claimBlock` uses, without the spawn that made that one asynchronous.
  //
  // Through `advanceLoop` rather than straight to a first pass, so the first
  // pass is decided by the same function every later one is: a board condition
  // that is already met has to be able to stop a loop before it bills anything,
  // and that is the whole of what this indirection buys. The claim goes first
  // for the reason it always did, and it is also what makes the instance read
  // `started` on the very next line.
  for (const creation of step.loop) {
    if (!instance.graph.nodes.some((n) => n.id === creation.nodeId)) continue;
    if (!claimLoop(instanceId, creation.nodeId)) continue;
    advanceLoop(instanceId, creation.nodeId, creation.dependsOn);
  }

  // Claimed synchronously, spawned after. The claim is what makes this
  // re-entrant safe; the spawn is what makes it worth doing.
  //
  // The budget is asked before each claim rather than once for the batch,
  // because the claim itself is what fills it: `claimBlock` writes `thinking`,
  // which is the row `liveAssistChildren` counts, so the next question already
  // knows about the last answer. A block over the budget is left `waiting` and
  // not written off — this is a shortage of memory rather than a decision about
  // the work, and `blocked` here would end the branch of the graph behind it for
  // a condition that clears in minutes. Whatever frees a slot advances again.
  //
  // A shutdown leaves it `waiting` for the same reason, and what decides it then
  // is `reconcileBlocksOnBoot`, which already has a rule for a `waiting` block.
  //
  // So does the install-wide hold. `emitBlockRuns` refuses a held emission
  // anyway, so a turn claimed here would be billed for a decision nothing can
  // act on — the hold is pressed to stop new spending, and this is the turn's
  // spending. Lifting it reaches this loop again through `releaseDependents`.
  const claimed: string[] = [];
  for (const nodeId of step.spawn) {
    if (assistBudgetFull() || isShuttingDown() || newWorkPaused()) break;
    if (claimBlock(instanceId, nodeId)) claimed.push(nodeId);
  }
  for (const nodeId of claimed) {
    void startBlockTurn(instanceId, nodeId).catch((err) => {
      settleBlock(instanceId, nodeId, {
        status: "failed",
        error: `The block could not be started: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    });
  }

  // The same shape for the merges, and the same claim: `startMergeBlock` reads
  // git and awaits the queue, so two advance passes arriving together would
  // otherwise both queue the same branches — which `enqueue` refuses as a whole
  // rather than half.
  for (const merge of step.merge) {
    if (!claimBlock(instanceId, merge.nodeId)) continue;
    void startMergeBlock(instanceId, merge.nodeId, merge.runIds).catch((err) => {
      finishMergeBlock(instanceId, merge.nodeId, {
        ok: false,
        note: `This block could not start merging: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    });
  }

  // The merge's shape and its claim, for its reason: the block awaits reviews
  // and runs, and two advances arriving together would otherwise both review
  // the same branches.
  for (const review of step.review) {
    if (!claimBlock(instanceId, review.nodeId)) continue;
    void startReviewBlock(instanceId, review.nodeId, review.runIds).catch((err) => {
      finishMergeBlock(instanceId, review.nodeId, {
        ok: false,
        note: `This block could not start reviewing: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    });
  }
}

/** Every node of an instance, in the terms `planInstanceStep` reads. */
function instanceState(
  instance: WorkflowInstance,
): Map<string, InstanceNodeState> {
  const state = new Map<string, InstanceNodeState>();

  const runs = db()
    .prepare(
      `SELECT w.node_id AS nodeId, w.emitted_by AS emittedBy, r.id AS id,
              r.status AS status, r.iterations AS iterations,
              ${refundedCyclesSql("r")} AS refundedCycles,
              w.left_behind_at AS leftBehindAt
         FROM workflow_instance_runs w
         LEFT JOIN runs r ON r.id = w.run_id
        WHERE w.instance_id = ?
        ORDER BY w.position`,
    )
    .all(instance.id) as Array<{
    nodeId: string;
    emittedBy: string | null;
    id: string | null;
    status: RunStatus | null;
    iterations: number | null;
    refundedCycles: number | null;
    leftBehindAt: number | null;
  }>;

  // Ordered by position, which for a loop block's members is pass order and,
  // within a pass, the order the section's blocks were created in. Nothing
  // reads the *last* of them any more — a loop hands on no run at all, because
  // every pass lands its own work — but the order is what `loopPasses` groups
  // on, and this is the query that establishes it.
  const emitted = new Map<string, DependencyState[]>();
  const emittedLeftBehind = new Map<string, number>();
  for (const row of runs) {
    // A row whose run has been deleted is treated as gone rather than as
    // finished, the same reading `releasableRuns` gives a missing dependency:
    // "not found" is not "settled", and a block released on the strength of one
    // would start on work nobody can show.
    if (!row.id || !row.status) continue;
    const run: DependencyState = {
      id: row.id,
      status: row.status,
      iterations: row.iterations ?? 0,
      refundedCycles: row.refundedCycles ?? 0,
    };
    if (row.emittedBy) {
      if (row.leftBehindAt !== null) {
        emittedLeftBehind.set(
          row.emittedBy,
          (emittedLeftBehind.get(row.emittedBy) ?? 0) + 1,
        );
        continue;
      }
      const list = emitted.get(row.emittedBy);
      if (list) list.push(run);
      else emitted.set(row.emittedBy, [run]);
    } else {
      state.set(row.nodeId, {
        run,
        block: null,
        leftBehind: row.leftBehindAt !== null,
      });
    }
  }

  for (const block of blocksOf(instance.id)) {
    state.set(block.nodeId, {
      run: null,
      block: {
        status: block.status,
        // A review block hands on what it approved, which is not the runs it
        // started — those are its fix runs — so it is read from its items.
        emitted:
          block.kind === "review"
            ? approvedRunsOf(instance.id, block.nodeId)
            : (emitted.get(block.nodeId) ?? []),
        leftBehind: block.kind === "review" ? 0 : (emittedLeftBehind.get(block.nodeId) ?? 0),
        // `blocksOf` counts an orchestrator block's accepted specs as `emitted`
        // and a loop's passes under the same name; only the first is a decision.
        decided: block.kind === "orchestrator" ? block.emitted : 0,
        notes: block.notes,
        error: block.error,
      },
    });
  }

  return state;
}

/** Where a run created after the graph was instantiated sits in the list. */
function nextPosition(instanceId: string): number {
  const row = db()
    .prepare(
      `SELECT MAX(p) AS n FROM (
         SELECT MAX(position) AS p FROM workflow_instance_runs WHERE instance_id = ?
         UNION ALL
         SELECT MAX(position) AS p FROM workflow_instance_blocks WHERE instance_id = ?
       )`,
    )
    .get(instanceId, instanceId) as { n: number | null };
  return (row.n ?? -1) + 1;
}

/**
 * Record a block's ending, creating the row if the node never had one.
 *
 * A deferred *run* block has no row until something writes it off — that is the
 * whole reason `workflow_instance_blocks` holds two kinds — so this is an upsert
 * rather than an update. Guarded on the status it is leaving, so a block that
 * settled between the plan and the write keeps its own answer.
 */
function upsertBlock(
  instanceId: string,
  node: WorkflowNode | undefined,
  status: BlockStatus,
  reason: string,
): void {
  const now = Date.now();
  const changed = db()
    .prepare(
      "UPDATE workflow_instance_blocks SET status=?, error=?, finished_at=?" +
        " WHERE instance_id=? AND node_id=? AND status IN ('waiting','thinking','looping')",
    )
    .run(status, reason, now, instanceId, node?.id ?? "").changes;
  if (changed > 0 || !node) return;

  db()
    .prepare(
      `INSERT OR IGNORE INTO workflow_instance_blocks
         (instance_id, node_id, node_name, position, kind, status, finished_at, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      instanceId,
      node.id,
      node.name,
      nextPosition(instanceId),
      node.kind,
      status,
      now,
      reason,
    );
}

/**
 * Take a block's turn, or return false because something else already has.
 *
 * A conditional UPDATE whose `changes` count decides, exactly as `claimTurn`
 * claims a chat and `startRun` claims a queued run. Two overlapping advance
 * passes are ordinary here — every terminal run transition triggers one — and
 * without this each would spawn its own billed child for the same block.
 */
function claimBlock(instanceId: string, nodeId: string): boolean {
  return (
    db()
      .prepare(
        "UPDATE workflow_instance_blocks SET status='thinking', started_at=?," +
          " error=NULL, reply=NULL, notes=NULL" +
          " WHERE instance_id=? AND node_id=? AND status='waiting'",
      )
      .run(Date.now(), instanceId, nodeId).changes === 1
  );
}

/**
 * Put a claimed block back to `waiting`, for a turn that gave up before it
 * spawned anything.
 *
 * Guarded on `thinking`, so a halt that wrote the block off in the meantime
 * keeps its own answer. `started_at` goes too, because nothing started, and the
 * next claim writes its own.
 */
function releaseBlockClaim(instanceId: string, nodeId: string): void {
  db()
    .prepare(
      "UPDATE workflow_instance_blocks SET status='waiting', started_at=NULL" +
        " WHERE instance_id=? AND node_id=? AND status='thinking'",
    )
    .run(instanceId, nodeId);
}

/* ------------------------------------------------------------------ */
/* Loop blocks: one pass at a time, unrolled                            */
/* ------------------------------------------------------------------ */

/**
 * Open a loop, or return false because another pass already has.
 *
 * `claimBlock`'s shape, for the status a loop lives in. It is what stops two
 * overlapping advances both creating pass 1 — after which one of them would be a
 * second run continuing the same predecessor, which admission refuses, so the
 * symptom would be a throw in a place with nobody to show it to.
 */
function claimLoop(instanceId: string, nodeId: string): boolean {
  return (
    db()
      .prepare(
        "UPDATE workflow_instance_blocks SET status='looping', started_at=?, error=NULL" +
          " WHERE instance_id=? AND node_id=? AND status='waiting'",
      )
      .run(Date.now(), instanceId, nodeId).changes === 1
  );
}

/**
 * Record how a loop ended, once.
 *
 * Guarded on `looping`, which is the same latch `settleBlock` puts on `thinking`
 * and for the same reason: a halt that got here first keeps its own wording, and
 * a second settle changes nothing. `emitted` is the ordinary ending whatever
 * stopped it — the block did what it was asked, and whether the *work* finished
 * is a fact about its last pass that `loopVerdict` reads off that run's status.
 * `failed` is reserved for the loop machinery itself failing.
 */
function settleLoop(
  instanceId: string,
  nodeId: string,
  status: "emitted" | "failed",
  reason: string,
): void {
  db()
    .prepare(
      "UPDATE workflow_instance_blocks SET status=?, finished_at=?, error=?" +
        " WHERE instance_id=? AND node_id=? AND status='looping'",
    )
    .run(status, Date.now(), reason, instanceId, nodeId);
}

/**
 * Every pass a loop block has taken, oldest first.
 *
 * **Both member tables**, because a pass is the section instantiated and a
 * section holds run, orchestrator and merge blocks: reading the runs alone would
 * report a pass as having settled while its merge block was still landing, and
 * the next pass would start from a folder that cannot see this one's work.
 *
 * Every row a loop causes is named under `passPrefix`, which is what makes one
 * prefix test the whole of "is this ours" — a member's own row, and the runs an
 * orchestrator member emitted, which `createEmitted` names under the member.
 * `emitted_by` is what tells the two apart: a member's row names the **loop**,
 * an emitted run names the member that decided on it.
 *
 * `LEFT JOIN`, so a member whose run row has been deleted is a member with no
 * run rather than a member that is silently missing — which `planLoopPass` reads
 * as settled and not completed, rather than waiting on a row that can never
 * move.
 *
 * `position` is creation order, which is what makes each pass's rows contiguous:
 * a pass is only started once the one before it has settled, and `nextPosition`
 * only goes up.
 */
function loopPasses(instanceId: string, nodeId: string): LoopPass[] {
  const prefix = passPrefix(nodeId);
  const runRows = db()
    .prepare(
      `SELECT w.node_id AS memberId, w.node_name AS name,
              w.emitted_by AS emittedBy, w.position AS position,
              r.id AS id, r.status AS status, r.iterations AS iterations,
              ${refundedCyclesSql("r")} AS refundedCycles,
              r.reported_done AS reportedDone, w.left_behind_at AS leftBehindAt
         FROM workflow_instance_runs w
         LEFT JOIN runs r ON r.id = w.run_id
        WHERE w.instance_id = ? AND substr(w.node_id, 1, ?) = ?
        ORDER BY w.position`,
    )
    .all(instanceId, prefix.length, prefix) as Array<{
    memberId: string;
    name: string;
    emittedBy: string | null;
    position: number;
    id: string | null;
    status: RunStatus | null;
    iterations: number | null;
    refundedCycles: number | null;
    reportedDone: number | null;
    leftBehindAt: number | null;
  }>;

  const blockRows = db()
    .prepare(
      `SELECT node_id AS memberId, node_name AS name, position AS position,
              kind AS kind, status AS status, error AS error,
              emitted_specs AS specs, notes AS notes
         FROM workflow_instance_blocks
        WHERE instance_id = ? AND substr(node_id, 1, ?) = ?
        ORDER BY position`,
    )
    .all(instanceId, prefix.length, prefix) as Array<{
    memberId: string;
    name: string;
    position: number;
    kind: WorkflowNodeKind;
    status: BlockStatus;
    error: string | null;
    specs: string | null;
    notes: string | null;
  }>;

  const runOf = (row: (typeof runRows)[number]): LoopRunState | null =>
    row.id && row.status
      ? {
          id: row.id,
          status: row.status,
          iterations: row.iterations ?? 0,
          refundedCycles: row.refundedCycles ?? 0,
          reportedDone: !!row.reportedDone,
          leftBehind: row.leftBehindAt !== null,
        }
      : null;

  const emitted = new Map<string, LoopRunState[]>();
  const rows: Array<{ position: number; member: LoopPassMember }> = [];
  for (const row of runRows) {
    if (row.emittedBy !== nodeId) {
      // A run one of this pass's orchestrator members decided on. It is not a
      // member, but it is this loop's spend and this loop's liveness.
      const run = runOf(row);
      if (!run || !row.emittedBy) continue;
      const list = emitted.get(row.emittedBy);
      if (list) list.push(run);
      else emitted.set(row.emittedBy, [run]);
      continue;
    }
    rows.push({
      position: row.position,
      member: {
        memberId: row.memberId,
        nodeId: passMemberOf(row.memberId)?.bodyNodeId ?? nodeId,
        name: row.name,
        // A member that became a run is a run block: the other two kinds never
        // do, which is why the kind is not on the row.
        kind: "run",
        run: runOf(row),
        block: null,
        emitted: [],
        workSetAside: 0,
      },
    });
  }
  for (const row of blockRows) {
    rows.push({
      position: row.position,
      member: {
        memberId: row.memberId,
        nodeId: passMemberOf(row.memberId)?.bodyNodeId ?? nodeId,
        name: row.name,
        kind: row.kind,
        run: null,
        block: {
          status: row.status,
          error: row.error,
          // Only an orchestrator member ever writes `emitted_specs`, so every
          // other kind reads as having decided on nothing, which it did.
          decided: parseSpecs(row.specs).length,
          notes: splitNotes(row.notes),
        },
        emitted: [],
        workSetAside:
          row.kind === "review" ? workSetAsideOf(instanceId, row.memberId) : 0,
      },
    });
  }

  rows.sort((a, b) => a.position - b.position);
  return groupPasses(
    rows.map(({ member }) => ({
      ...member,
      // `instanceState`'s reading, one loop along: a review member hands on
      // what it approved rather than the fix runs it started.
      emitted:
        member.kind === "review"
          ? approvedRunsOf(instanceId, member.memberId)
          : (emitted.get(member.memberId) ?? []),
    })),
  );
}

/** Every loop of one instance that has another pass to decide on. */
function advanceLoops(instanceId: string): void {
  const rows = db()
    .prepare(
      "SELECT node_id AS nodeId FROM workflow_instance_blocks" +
        " WHERE instance_id = ? AND kind = 'loop' AND status = 'looping'" +
        " ORDER BY position",
    )
    .all(instanceId) as Array<{ nodeId: string }>;
  for (const row of rows) advanceLoop(instanceId, row.nodeId);
}

/**
 * How many times one advance may re-decide a loop before it gives up.
 *
 * Every turn of the loop in `advanceLoop` needs `stepPass` to have written
 * something, and each of those writes is one-way — a member is created once,
 * blocked once, claimed once, and a pass is started once — so the sequence is
 * finite by construction, bounded by the members `MAX_LOOP_RUNS` already caps.
 * The bound is stated anyway, because the alternative to being wrong about that
 * is a request that never returns and a loop nothing can stop.
 */
const MAX_LOOP_STEPS = 4 * MAX_LOOP_RUNS;

/**
 * Decide whether one loop takes another pass, and act on the answer.
 *
 * The writing half of `planLoopPass`, and it is synchronous end to end for
 * `createRun`'s reason — one event-loop turn covers reading the passes,
 * deciding, and claiming folders for the next one.
 *
 * **The first pass comes through here too**, carrying the edges the graph gave
 * the block, and that is what makes the board condition reachable before any
 * run exists: a loop pointed at a backlog that is already clear must start
 * nothing, where the two caps are only ever read after a pass has settled.
 *
 * It asks again after every step it took, rather than waiting to be advanced.
 * A step that blocks the last live member of a pass has *settled* that pass,
 * and nothing else would ever notice: no run was started, so no terminal run
 * transition will trigger another advance and the loop would sit `looping` for
 * ever with a pass that finished. Each turn requires a write — see
 * `MAX_LOOP_STEPS`.
 */
function advanceLoop(
  instanceId: string,
  nodeId: string,
  /** What pass 1's first member starts after. Empty on every advance after it. */
  firstPassDependsOn: InstanceCreation["dependsOn"] = [],
): void {
  const instance = getInstance(instanceId);
  if (!instance || instance.status !== "started") return;

  const node = instance.graph.nodes.find((n) => n.id === nodeId);
  if (!node || node.kind !== "loop") {
    settleLoop(
      instanceId,
      nodeId,
      "failed",
      "This block is no longer in the workflow this run was started from.",
    );
    return;
  }

  // The section, off the instance's **own** frozen graph rather than the
  // workflow's: a section edited between two passes would otherwise change what
  // this loop repeats half way through.
  const section = loopSection(instance.graph, node);

  for (let step = 0; step < MAX_LOOP_STEPS; step += 1) {
    const passes = loopPasses(instanceId, nodeId);
    const latest = passes.at(-1);

    // A pass still working is carried on before anything only the decision
    // reads is looked at: the pass cap and the board below can each end the
    // loop, and ending it now would end it mid-pass. The block behind it would
    // be decided on a loop whose runs are still in its folders, and the members
    // not yet released would stay `waiting` with nothing ever to step them — a
    // pass that never lands, holding the instance open until somebody stops
    // it. `planLoopPass` asks the same question first; asking it here too keeps
    // a failed read from ever being acted on ahead of that rung.
    if (latest && !passSettled(latest)) {
      if (!stepPass(instance, node, section, latest.pass, [])) return;
      continue;
    }

    // `typeof` rather than `!== null`, and that is the difference between a
    // loop that ends and one that does not: an instance blob written before
    // this column existed, or by anything but `normalizeWorkflowInput`, carries
    // `undefined` here — and `passes.length >= undefined` is false for ever.
    //
    // Its own sentence rather than the missing-block one above: the block is
    // still in the graph, and an operator told it is not goes looking for a
    // deletion that never happened.
    if (typeof node.maxPasses !== "number") {
      settleLoop(
        instanceId,
        nodeId,
        "failed",
        "This loop has no pass cap in the copy of the workflow this run was " +
          "started from, so nothing says how many passes it may take. Start " +
          "the workflow again: Run copies its saved graph afresh, and refuses " +
          "a loop without a cap.",
      );
      return;
    }

    // Read before every decision, including the one in front of the first
    // pass. A condition this app cannot count for ends the loop `failed` rather
    // than being treated as a clear board: zero is the answer that stops it,
    // and a mount that has gone is not a finished project.
    const board = loopBoardCount(node);
    if (!board.ok) {
      settleLoop(
        instanceId,
        nodeId,
        "failed",
        `Its tasks could not be counted: ${board.error}`,
      );
      return;
    }

    const decision = planLoopPass({
      blockName: node.name,
      passes,
      maxPasses: node.maxPasses,
      maxCostUSD: node.maxLoopCostUSD,
      spentGuardUSD: loopSpend(instanceId, nodeId),
      stopWhenTasks: node.stopWhenTasks,
      boardCounts: board.counts,
    });

    if (decision.kind === "stop") {
      settleLoop(
        instanceId,
        nodeId,
        loopStopStatus(decision.code),
        decision.reason,
      );
      return;
    }

    // `wait` needs no branch: an unsettled pass is stepped above, so this
    // decision is only ever asked about a settled one or about none.
    if (decision.kind === "pass") {
      // A loop that repeats nothing cannot take another pass. Not reachable
      // from a graph saved today — `resolveSections` refuses a loop with no
      // `repeats` link — but an instance carries a copy of the graph it was
      // started from, and one saved when a loop held a task of its own and
      // repeated *that* is read back from it. There is no honest way to carry
      // such a loop on: the mode it needs is gone, and inventing a pass here
      // would bill an agent for work the current rules say this block does not
      // do.
      //
      // Asked **here** rather than on the way in, which is the difference
      // between closing out a legacy loop and killing one mid-pass: a pass of
      // it that was still running when the section requirement arrived is a
      // live agent in somebody's folder, and it is the decision above — not the
      // shape of the graph — that establishes there is nothing left in flight.
      if (section.nodes.length === 0) {
        settleLoop(
          instanceId,
          nodeId,
          "failed",
          "This block repeats no section. It was saved when a loop held a " +
            "task of its own; a loop now frames the blocks it repeats, so " +
            "start this workflow again from its saved graph.",
        );
        return;
      }
      // Every member of the pass, `waiting`, before anything is released. The
      // shape `instantiate` gives a whole graph, at the scale of one pass, and
      // it is what makes "the pass has not finished unfolding" a fact on the
      // rows rather than a count somebody has to keep: a pass whose entry run
      // has been created and whose merge block does not exist yet would
      // otherwise read as settled.
      openPass(instanceId, node, section, decision.pass);
      // Pass 1's entry starts after whatever released the loop; nothing is
      // carried between passes at all — see `stepPass`. Tested on the number
      // rather than on this being the first time round, which is an invariant
      // that holds today only because a pass cannot settle in the same call
      // that created it.
      if (
        !stepPass(
          instance,
          node,
          section,
          decision.pass,
          decision.pass === 1 ? firstPassDependsOn : [],
        )
      ) {
        return;
      }
    }
  }

  settleLoop(
    instanceId,
    nodeId,
    "failed",
    `This block was still deciding what to do after ${MAX_LOOP_STEPS} steps in ` +
      "one pass of the scheduler, so it was stopped rather than left to spin.",
  );
}

/** The blocks one loop repeats, as a graph of their own. */
interface LoopSection {
  /** In the order the section's own edges give. Empty for a body-less loop. */
  nodes: readonly WorkflowNode[];
  /** Those nodes and the edges between them, and nothing else. */
  graph: WorkflowGraph;
  /**
   * The block each pass starts at — the `repeats` link's target, which is the
   * only member with nothing in front of it inside the section.
   */
  entryId: string | null;
}

function loopSection(graph: WorkflowGraph, loop: WorkflowNode): LoopSection {
  const nodes = loopBody(graph, loop);
  const members = new Set(nodes.map((n) => n.id));
  return {
    nodes,
    graph: {
      nodes,
      edges: graph.edges.filter(
        (e) => members.has(e.from) && members.has(e.to),
      ),
    },
    // The topological order's first entry: every member is reachable from the
    // `repeats` link's target and the section is acyclic, so that target is the
    // one member with no incoming edge and sorts first.
    entryId: nodes[0]?.id ?? null,
  };
}

/**
 * Write down every member of a pass before any of them is released.
 *
 * `waiting` rows, in the section's own order, so each member has a position and
 * a name from the moment the pass exists. Two things rest on it. The page shows
 * the whole pass rather than one row at a time; and `planLoopPass` can read "has
 * this pass finished" off the rows, where a pass that wrote a row only when a
 * member was created would be indistinguishable from a settled one for as long
 * as its first member was the only one in the table.
 *
 * `INSERT OR IGNORE`, so a pass re-opened by an advance that raced another is a
 * no-op rather than a throw. The claim on the loop block makes that a belt
 * rather than a brace.
 */
function openPass(
  instanceId: string,
  loop: WorkflowNode,
  section: LoopSection,
  pass: number,
): void {
  const insert = db().prepare(
    `INSERT OR IGNORE INTO workflow_instance_blocks
       (instance_id, node_id, node_name, position, kind, status)
     VALUES (?, ?, ?, ?, ?, 'waiting')`,
  );
  for (const member of section.nodes) {
    insert.run(
      instanceId,
      passMemberId(loop.id, pass, member.id),
      passMemberName(member.name, pass),
      nextPosition(instanceId),
      member.kind,
    );
  }
}

/**
 * Carry one pass forward: whatever the section can do now, done.
 *
 * **There is one scheduler.** A pass is the section instantiated, so what may go
 * now is `planInstanceStep` over the section's own nodes and edges with this
 * pass's own member rows — the same function that releases run blocks, spawns
 * orchestrator turns, waits for every run one emitted, and queues a merge block
 * with the runs its incoming edges resolved to. A second reading of "which
 * member may go now" would be a second place for a member to be left waiting for
 * ever, and it would be a reading nothing else in this file is tested against.
 *
 * **Nothing is manufactured.** Members carry each other's branches exactly as
 * the section's own links say — `edgeVerdict` resolves them and `createRun`
 * records them — and the pass's merge block lands what its predecessors left.
 * Nothing is carried between passes either: pass N+1 does not continue pass N's
 * branch, its runs cut fresh ones in their folders, and what makes the previous
 * pass visible to them is that it **landed**.
 *
 * Synchronous from the first `createRun` to the last, `startWorkflow`'s rule at
 * the scale of one step: the folder claim is atomic only inside one event-loop
 * turn, so every `planNode` is done before the first creation and nothing
 * between them reads the clock or the disk. Turns and merges are claimed
 * synchronously and dispatched after, exactly as `advanceInstance` does it.
 *
 * A member that cannot be created is **blocked**, not rolled back. A pass used
 * to be a chain created in one go, where half of it was a branch left in a state
 * nobody asked for; a pass is now a graph released a member at a time, so a
 * member that cannot start is a settled predecessor and `planInstanceStep`'s own
 * cascade writes off what was behind it in the same call. The loop then stops
 * because the pass did not complete, which is where that decision belongs.
 *
 * Returns whether anything was written — see `advanceLoop`.
 */
function stepPass(
  instance: WorkflowInstance,
  loop: WorkflowNode,
  section: LoopSection,
  pass: number,
  /** What the section's entry starts after. Empty for every pass after the first. */
  carry: InstanceCreation["dependsOn"],
): boolean {
  const instanceId = instance.id;
  const memberId = (nodeId: string) => passMemberId(loop.id, pass, nodeId);
  const step = planInstanceStep(
    section.graph,
    passState(loopPasses(instanceId, loop.id).find((p) => p.pass === pass)),
  );
  let wrote = false;

  // Blocked first, `advanceInstance`'s order and for its reason: a node written
  // off here is a settled predecessor, so the cascade has already reached the
  // bottom of the section when the creations happen rather than one step later.
  for (const { nodeId, reason } of step.block) {
    const node = section.nodes.find((n) => n.id === nodeId);
    upsertBlock(instanceId, passNode(node, pass, memberId(nodeId)), "blocked", reason);
    wrote = true;
  }

  const defaults = chatGuards();
  // Every plan before any creation, for the reason above: a member refused half
  // way through would leave a `createRun` un-run in a turn that has already
  // yielded nothing.
  const plans: Array<{
    nodeId: string;
    input: Omit<CreateRunInput, "dependsOn" | "origin">;
    dependsOn: InstanceCreation["dependsOn"];
  }> = [];
  const recorded = db().prepare(
    "SELECT 1 FROM workflow_instance_runs WHERE instance_id = ? AND node_id = ?",
  );
  for (const creation of step.create) {
    const node = section.nodes.find((n) => n.id === creation.nodeId);
    if (!node) continue;
    // A member is created once. A pass whose state missed a row it has — a
    // member id misread, or a member whose run row has gone — would otherwise
    // be answered with another run each step, every one of them outside the
    // membership that stops, budgets and caps are read off. Skipped without a
    // write, so `advanceLoop` does not ask again on the strength of it.
    if (recorded.get(instanceId, memberId(node.id))) continue;
    const plan = planNode(
      node,
      node.templateId ? getTemplate(node.templateId) : null,
      defaults,
      // Asked again for every pass, `planInstanceStep`'s reason one loop along:
      // a pass is created minutes or hours after the one before it, so an agent
      // deleted in between blocks this member by name rather than quietly
      // starting a run that is not the thing the graph named.
      node.agentId ? getAgent(node.agentId) : null,
    );
    const ready = plan.ok ? localReady(plan.input, node.name) : plan;
    if (!ready.ok) {
      upsertBlock(instanceId, passNode(node, pass, memberId(node.id)), "blocked", ready.reason);
      wrote = true;
      continue;
    }
    plans.push({
      nodeId: node.id,
      input: ready.input,
      // The section's entry is the only member with nothing in front of it, so
      // it is the only one that can carry what released the loop. Every pass
      // after the first carries nothing: its entry is an ordinary queued run,
      // started once the pass before it landed.
      dependsOn:
        node.id === section.entryId
          ? [...carry, ...creation.dependsOn]
          : creation.dependsOn,
    });
  }

  for (const plan of plans) {
    const node = section.nodes.find((n) => n.id === plan.nodeId)!;
    let runId: string;
    try {
      runId = createRun({
        ...plan.input,
        dependsOn: plan.dependsOn,
        // The instance's own, exactly as a deferred node takes it. A pass is not
        // an `orchestrator-block` run: no model decided it — `planLoopPass` did,
        // off the pass before it — and the press of Run that authorised the
        // graph authorised every pass its cap allows.
        // `?? "workflow"` for the column's own nullability rather than for the
        // instance's: `runs.origin` predates this and an instance written before
        // it carries null, where every pass of it is a workflow's.
        origin: instance.origin ?? "workflow",
        originRef: instance.originRef ?? instanceId,
      }).id;
    } catch (err) {
      // `createRun` refuses a folder that has gone and a dependency graph it
      // cannot satisfy. Either way this member will never run, and a row saying
      // so is the difference between that and a member that quietly vanished.
      upsertBlock(
        instanceId,
        passNode(node, pass, memberId(node.id)),
        "blocked",
        `It could not be started: ${err instanceof Error ? err.message : String(err)}`,
      );
      wrote = true;
      continue;
    }
    try {
      // The ledger row held this member's place while it was waiting, so it
      // carries the position `openPass` gave it; the row itself goes, because a
      // member in both tables is a member shown twice on the page and counted as
      // live for ever.
      const held = getBlock(instanceId, memberId(node.id));
      db()
        .prepare(
          "DELETE FROM workflow_instance_blocks WHERE instance_id=? AND node_id=?",
        )
        .run(instanceId, memberId(node.id));
      recordMember(instanceId, {
        // `passMemberId` owns the spelling, because `loopPasses` reads the pass
        // number and the block back out of it.
        nodeId: memberId(node.id),
        nodeName: passMemberName(node.name, pass),
        position: held?.position ?? nextPosition(instanceId),
        runId,
        // The **loop**, whatever block's work this is — the column an
        // orchestrator block's runs already use — so the instance budget guard,
        // `stopInstance`, the second-press refusal and the instance page cover a
        // pass with no new code.
        emittedBy: loop.id,
      });
      wrote = true;
    } catch (err) {
      // A run that is no member is one no stop, budget or cap can see, so it is
      // stopped here — `startWorkflow`'s rollback, for the same gap. And it is
      // **not** a write: `advanceLoop` steps again only on progress, and a
      // member that cannot be recorded would be created again on that step.
      const reason = err instanceof Error ? err.message : String(err);
      stopRun(
        runId,
        `Stopped because workflow “${instance.workflowName}” could not record it as one of its runs`,
      );
      upsertBlock(
        instanceId,
        passNode(node, pass, memberId(node.id)),
        "blocked",
        `Its run could not be recorded as part of this workflow, so it was stopped: ${reason}`,
      );
    }
  }

  // Claimed synchronously, spawned after — `advanceInstance`'s shape, including
  // its budget question per claim: the claim itself is what fills the budget, so
  // the next question already knows about the last answer, and a member left
  // `waiting` for want of a slot is not written off. Whatever frees one advances
  // again. Its shutdown and hold questions too.
  const claimed: string[] = [];
  for (const nodeId of step.spawn) {
    if (assistBudgetFull() || isShuttingDown() || newWorkPaused()) break;
    if (claimBlock(instanceId, memberId(nodeId))) claimed.push(memberId(nodeId));
  }
  for (const id of claimed) {
    wrote = true;
    void startBlockTurn(instanceId, id).catch((err) => {
      settleBlock(instanceId, id, {
        status: "failed",
        error: `The block could not be started: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    });
  }

  for (const merge of step.merge) {
    const id = memberId(merge.nodeId);
    if (!claimBlock(instanceId, id)) continue;
    wrote = true;
    void startMergeBlock(instanceId, id, merge.runIds).catch((err) => {
      finishMergeBlock(instanceId, id, {
        ok: false,
        note: `This block could not start merging: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    });
  }

  for (const review of step.review) {
    const id = memberId(review.nodeId);
    if (!claimBlock(instanceId, id)) continue;
    wrote = true;
    void startReviewBlock(instanceId, id, review.runIds).catch((err) => {
      finishMergeBlock(instanceId, id, {
        ok: false,
        note: `This block could not start reviewing: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    });
  }

  return wrote;
}

/**
 * One block of a section, as the member of a pass that it is.
 *
 * The same node with the row's own id and name on it, and that is what lets
 * every function written against a block — `upsertBlock`, `claimBlock`,
 * `planNode`, `startBlockTurn`, `startMergeBlock` — work on a pass's member
 * without learning that passes exist. The alternative was a second id argument
 * threaded through all of them, which is five signatures and five chances to
 * pass the graph's id where the row's was meant: the row would be looked up,
 * not found, and the write would silently do nothing.
 */
function passNode(
  node: WorkflowNode | undefined,
  pass: number,
  memberId: string,
): WorkflowNode | undefined {
  if (!node) return undefined;
  return { ...node, id: memberId, name: passMemberName(node.name, pass) };
}

/**
 * The block one ledger row is, whether it is a graph node or a pass's member.
 *
 * Every block that spawns something looks its node up by the row's id, and for a
 * pass's member that id names the pass rather than the graph. One resolver, so
 * "which block is this row" has a single answer: a second one that forgot the
 * pass spelling would answer `undefined` and settle a live member as no longer
 * part of its workflow.
 */
function blockNode(
  instance: WorkflowInstance,
  nodeId: string,
): WorkflowNode | undefined {
  const own = instance.graph.nodes.find((n) => n.id === nodeId);
  if (own) return own;
  const member = passMemberIn(instance.graph, nodeId);
  if (!member?.bodyNodeId) return undefined;
  return passNode(
    instance.graph.nodes.find((n) => n.id === member.bodyNodeId),
    member.pass,
    nodeId,
  );
}

/** One pass's members, in the terms `planInstanceStep` reads. */
function passState(
  pass: LoopPass | undefined,
): Map<string, InstanceNodeState> {
  const state = new Map<string, InstanceNodeState>();
  for (const member of pass?.members ?? []) {
    // Split the way `instanceState` splits them, so a pass and the graph around
    // it read a left-behind run identically.
    const kept = member.emitted.filter((r) => r.leftBehind !== true);
    state.set(member.nodeId, {
      run: member.run,
      leftBehind: member.run?.leftBehind === true,
      block: member.block
        ? {
            ...member.block,
            emitted: kept,
            leftBehind: member.emitted.length - kept.length,
          }
        : null,
    });
  }
  return state;
}

/**
 * Spawn one block's turn.
 *
 * The gate in front of it is a chat turn's, and one thing more: the host
 * process budget — taken at `advanceInstance`'s claim rather than here, so a
 * shortage defers this turn instead of failing it — `windowRefusal()`, the
 * operator's own configured ceiling already spent, `installBudgetRefusal()`,
 * the install-wide rolling-day limit this is the fifth door of, and
 * `isShuttingDown()`, asked at the claim and again before the spawn. The one
 * thing more is the install-wide hold, asked at the same two places, which a
 * chat turn does not ask because a person is typing into it and nobody is
 * typing into this. There is deliberately no `evaluateBudget` here — this is
 * not a work cycle and inventing a per-block
 * fraction would be a threshold nobody set — and the instance's own budget is
 * checked where every other instance-wide decision is, at a member's cycle
 * boundary. What bounds the spend is `settings.chatTurnBudgetUSD`, inside the
 * CLI, for the reason a chat turn's is: it is the same child answering the same
 * kind of question.
 */
async function startBlockTurn(instanceId: string, nodeId: string): Promise<void> {
  const instance = getInstance(instanceId);
  const node = instance ? blockNode(instance, nodeId) : undefined;
  // Every refusal below settles with `costUSD: 0`, because nothing has been
  // spawned and $0 is a fact rather than a gap: left out, `blockTurnSpend`
  // reads it as a turn that died without reporting, and the block's Spent cell
  // and the instance total both lose the word "measured" over a turn never paid.
  if (!instance || !node || node.kind !== "orchestrator" || node.fanOut === null) {
    settleBlock(instanceId, nodeId, {
      status: "failed",
      error: "This block is no longer in the workflow this run was started from.",
      costUSD: 0,
    });
    return;
  }

  // The agent this turn itself *is* — the block's own child, so its own field.
  // Asked before anything is spent and refused by name rather than dropped:
  // failing here costs nothing and says what happened, where a turn deciding as
  // something other than the agent the operator gave it is the one failure
  // shape nothing downstream can report.
  const own = node.agentId ? getAgent(node.agentId) : null;
  if (node.agentId) {
    const missing = agentRefusal(node.agentId, agentKnowledgeOf(own));
    if (missing) {
      settleBlock(instanceId, nodeId, { status: "failed", error: missing, costUSD: 0 });
      return;
    }
  }

  // The runs this turn would emit, asked before it is paid for. A Codex or
  // local run needs a work-cycle or time limit from the guards it starts under,
  // and a local one needs somebody signed in; a turn that decided on runs
  // which could then never start would be a billed decision nothing acts on.
  if (node.provider === "codex" || node.provider === "local") {
    const guards = guardsFor(
      node.templateId ? getTemplate(node.templateId) : null,
      chatGuards(),
    );
    const terminus = providerTerminusRefusal(node.provider, guards.budget);
    if (terminus) {
      settleBlock(instanceId, nodeId, { status: "failed", error: terminus, costUSD: 0 });
      return;
    }
    if (node.provider === "local" && !getLocalSignIn()) {
      settleBlock(instanceId, nodeId, {
        status: "failed",
        error:
          "The runs this block emits go to the local model, and the local " +
          "provider is signed out. Sign in under Settings and start it again.",
        costUSD: 0,
      });
      return;
    }
  }

  // `windowRefusal` and not `assistRefusal`: the process budget gated this turn
  // at `advanceInstance`'s claim, and this block's own row has been `thinking`
  // — and so counted — ever since. Asking the budget again here would have a
  // block refuse itself whenever it was the one that filled it.
  //
  // The install's spend limit is the other half and is *not* deferred by that
  // claim: it bounds what the whole install spends in a rolling day rather than
  // how many children exist, so nothing upstream has already asked it on this
  // block's behalf and a block holding its slot must still be refused by it.
  const refusal = (await windowRefusal()) ?? installBudgetRefusal();
  if (refusal) {
    settleBlock(instanceId, nodeId, { status: "failed", error: refusal, costUSD: 0 });
    return;
  }

  // The workflow-wide guard, at the other kind of block boundary. This is the
  // one moment before a deciding block spends, and it is exactly what
  // `enforceInstanceBudget` is for a member run's cycle boundary — same door,
  // same verdict, and the halt it triggers takes this block down with the rest.
  const guard = enforceInstanceBudgetForBlock(instanceId, await currentSnapshot());
  if (guard?.kind === "halted") return;
  if (guard?.kind === "unenforceable") {
    // Logged rather than acted on, the answer this app already gives a live
    // spending limit whose telemetry never arrived: `no_ceiling` on a stock
    // install means the provider's percentage was not readable this minute, and
    // halting every fraction-guarded workflow over an unreachable host is worse
    // than the guard being unenforceable for one block boundary.
    //
    // A note rather than an error, because it is neither the turn failing nor
    // anything the turn said — and because `error` is what `settleBlock` writes
    // when the turn ends, which is where this used to go and where it was wiped
    // by every turn that did not itself fail.
    noteBlock(
      instanceId,
      nodeId,
      `Its workflow has a limit that could not be read here: ${guard.verdict.reason}`,
    );
  }

  // Re-read after the awaits: a halt may have closed the door while the
  // transcript scan above was running, and a turn that starts into a stopping
  // instance is a billed child deciding work for a workflow that is being
  // taken down.
  const fresh = getInstance(instanceId);
  if (!fresh || !instanceIsOpen(fresh.status)) {
    // Written off rather than settled: nothing was spawned and nothing spent,
    // which is what `blocked` says and `failed` would not. `upsertBlock`'s
    // guard also means a halt that got here first keeps its own wording.
    upsertBlock(
      instanceId,
      node,
      "blocked",
      "The workflow was stopped before this block could start deciding.",
    );
    return;
  }

  // The same question of the process. The claim's own shutdown check ran before
  // the scans above, so a shutdown that began during them would otherwise spawn
  // a billed child that the exit is about to kill. Written off as `blocked` for
  // the reason the branch above gives: nothing was spawned and nothing spent.
  if (isShuttingDown()) {
    upsertBlock(
      instanceId,
      node,
      "blocked",
      "The server shut down before this block could start deciding.",
    );
    return;
  }

  // And of the hold, for the same reason: the claim asked before the scans, and
  // a hold pressed during them would otherwise be a billed turn whose emission
  // is refused. Handed back to `waiting` rather than written off, the claim's
  // own answer to a held install, so the lift decides it.
  if (newWorkPaused()) {
    releaseBlockClaim(instanceId, nodeId);
    return;
  }

  const template = node.templateId ? getTemplate(node.templateId) : null;
  const settings = getSettings();
  const key = turnKey(instanceId, nodeId);

  runOrchestratorChild({
    subject: { kind: "block", instanceId, nodeId },
    prompt: node.task,
    appendSystemPrompt: blockSystemPrompt(
      node,
      template,
      instance.workflowName,
      own,
      // What it may start an *emitted* run as, which is a different question
      // from the line above — that one is what this turn itself is — and is
      // answered by the same registry. Read here so the prompt and
      // `emitBlockRuns`' own check describe one list.
      listAgents(),
    ),
    cwd: safeFolder(node),
    // What this deciding turn *is*, not a specialist it may call on: the node's
    // agent is selected with `--agent`, so the saved prompt is the turn's own.
    // Everything bounding this child — its tool surface, its capability token,
    // `--max-budget-usd`, and `blockSystemPrompt` above, which still reaches a
    // session started this way — is unchanged by it. The runs this block emits
    // name their own agent per spec, which is the opposite way round from
    // `promptOverride` and stays that way.
    agent: own ? agentDefinition(own) : null,
    maxBudgetUSD: settings.chatTurnBudgetUSD,
    idleTimeoutMs: BLOCK_IDLE_TIMEOUT_MS,
    timedOutMessage: BLOCK_TIMED_OUT,
    onSpawn: (child) => blockTurns.set(key, child),
    onSettle: (result) => {
      blockTurns.delete(key);
      settleBlock(instanceId, nodeId, result);
    },
  });
}

/** The block's folder on disk, or null when it cannot be resolved any more. */
function safeFolder(node: WorkflowNode): string | undefined {
  try {
    return resolveWorkspaceFolder(node.folder, node.mountId);
  } catch {
    // The turn still runs — it decides rather than works — and
    // `runOrchestratorChild` falls back to the first mount. Its emitted specs
    // go through `resolveWorkspaceFolder` again and would be refused there.
    return undefined;
  }
}

/** What one settled orchestrator turn leaves on its row. */
export interface BlockSettlement {
  status: Extract<BlockStatus, "emitted" | "failed">;
  /** The model's own words. */
  reply: string | null;
  /** This app's, one per line. */
  notes: string[];
  /** Set only when the turn itself failed. */
  error: string | null;
}

/**
 * What a finished turn is recorded as.
 *
 * Pure and unit-tested because every way of being wrong here is silent, and the
 * one this app shipped with was the worst of them: the turn's reply was read off
 * stdout, handed to this function's caller and dropped. A block that spent money
 * and started nothing left `emitted`, zero runs and no sentence — identical, on
 * the page, to a block that decided there was nothing to do, and identical again
 * to one whose every `emit_runs` call this app refused. All three end the branch
 * of the graph behind them, and only one of them is the model's fault.
 *
 * So the three voices stay three fields. `reply` is what the turn said, which is
 * the answer to "why did it start nothing" whenever the turn had a reason;
 * `notes` is what this app did to it, which is the answer whenever it did not;
 * `error` is the turn failing, which is neither. Folding any two together loses
 * exactly the distinction the operator is reading for.
 *
 * `failed` is reserved for a turn that failed **and** emitted nothing: specs
 * accepted while the child was alive are a decision it took deliberately, and a
 * CLI that errored on its way out afterwards says nothing about them — but a
 * block recorded `failed` blocks what is behind it, so a turn whose runs are
 * about to start must not be.
 */
export function blockSettlement(
  result: TurnResult,
  emitted: number,
  priorNotes: readonly string[],
): BlockSettlement {
  const notes = [...priorNotes];

  // The chat surfaces these for the reason a block needs them more: it runs
  // with no allowlist, so a denial is the CLI declining on its own — and "I was
  // not allowed to look" reads exactly like "there was nothing to find" to
  // someone reading a block that emitted nothing.
  const denied = [...new Set(result.denials ?? [])];
  if (denied.length > 0) {
    notes.push(
      `The CLI declined these tool calls: ${denied.join(", ")}. Nothing here ` +
        "restricts its tools, so that was its own decision.",
    );
  }

  return {
    status: result.status === "failed" && emitted === 0 ? "failed" : "emitted",
    reply: result.text?.trim() || null,
    notes,
    error: result.error ?? null,
  };
}

/** What a settled block turn adds to each of the row's three cost columns. */
export interface BlockTurnSpend {
  /** The CLI's own figure. 0 when it never reported one — never a stand-in. */
  costUSD: number;
  /** Our price for a turn that reported nothing. Guard-only, and 0 otherwise. */
  costGuardUSD: number;
  /** 1 for a turn that ended without a cost, so a zero can be told from a gap. */
  unreported: number;
}

/**
 * What a turn's verdict says it cost, split into the figure that was measured
 * and the figure that was not.
 *
 * `turnResultOf` returns a failure shape with **no** `costUSD` whenever the
 * child produced no readable `result` event — killed, crashed or timed out —
 * and banking that as `costUSD ?? 0` wrote a measurement nobody made: the
 * tokens were real, the money was spent, and both the block's Spent cell and
 * the instance cap read zero for the whole of it. The run loop has always
 * reconciled a killed cycle into `runs.spent_usd_est` and left `spent_usd`
 * alone; this is the same split one level up.
 *
 * Pure, and exported for the test that pins it: the three columns it feeds are
 * summed by two different queries into two different figures, and getting the
 * split wrong is silent in both.
 */
export function blockTurnSpend(result: TurnResult): BlockTurnSpend {
  if (result.costUSD !== undefined) {
    return { costUSD: result.costUSD, costGuardUSD: 0, unreported: 0 };
  }
  // `costGuardUSD` is itself absent on a turn that died before its first
  // assistant event: there is no usage to price, and 0 here is "we could not
  // tell", which is what `unreported` is carried to say.
  return { costUSD: 0, costGuardUSD: result.costGuardUSD ?? 0, unreported: 1 };
}

/**
 * Record what a turn said and cost, then start what it asked for.
 *
 * The emission is honoured even when the turn itself came back `failed` — see
 * `blockSettlement`, which decides that. The one thing that does withdraw the
 * specs is the instance no longer being `started`: a halt closed the door, and a
 * block that started runs into a stopping workflow is the member the halt would
 * then have to chase.
 *
 * Latched on `status='thinking'`, so a settle arriving after a halt already
 * wrote the block off changes nothing the operator reads — the same shape
 * `finishTurn` uses on a chat row, and for the same reason: the answer that got
 * there first is the one the operator was shown. **The money is not latched.**
 * A halt writes a deciding block `failed` before it signals the child, so the
 * settle that carries the dying turn's cost always arrives after the latch has
 * closed; behind it, every halted turn left `$0.00` on its row and the instance
 * total called that a complete measurement.
 *
 * Exported for `sweepPaused`'s reason and no other: this is the only door to
 * `createEmitted`, and its other end is a real child process exiting. Without a
 * way in, what a block's emission actually writes onto a run cannot be pinned
 * at all.
 */
export function settleBlock(
  instanceId: string,
  nodeId: string,
  result: TurnResult,
): void {
  const row = getBlock(instanceId, nodeId);
  const specs = parseSpecs(row?.emitted_specs ?? null);
  // Read back and written whole rather than left alone, because everything
  // recorded during the turn lives in this column: a refused emission, and the
  // guard `startBlockTurn` could not read. This used to write `error` flat,
  // which wiped that guard note on every turn that did not itself fail.
  const settlement = blockSettlement(result, specs.length, splitNotes(row?.notes ?? null));
  const spend = blockTurnSpend(result);
  const settled = db().transaction((): boolean => {
    db()
      .prepare(
        `UPDATE workflow_instance_blocks
            SET cost_usd = cost_usd + ?, cost_usd_est = cost_usd_est + ?,
                cost_unreported = cost_unreported + ?, tokens = tokens + ?
          WHERE instance_id=? AND node_id=?`,
      )
      .run(
        spend.costUSD,
        spend.costGuardUSD,
        spend.unreported,
        result.tokens ?? 0,
        instanceId,
        nodeId,
      );
    return (
      db()
        .prepare(
          `UPDATE workflow_instance_blocks
              SET status=?, finished_at=?, error=?, session_id=COALESCE(?, session_id),
                  reply=?, notes=?
            WHERE instance_id=? AND node_id=? AND status='thinking'`,
        )
        .run(
          settlement.status,
          Date.now(),
          settlement.error,
          result.sessionId ?? null,
          settlement.reply,
          settlement.notes.join("\n") || null,
          instanceId,
          nodeId,
        ).changes > 0
    );
  })();
  if (!settled) return;

  // `instanceIsOpen` rather than a test for `started`, and the difference is
  // load-bearing here in a way it is nowhere else: the UPDATE above has just
  // settled this block, so if it was the last live member the instance reads
  // `finished` on this very line. A halt is the only thing that may stop the
  // runs it decided on from being created.
  const instance = getInstance(instanceId);
  if (instance && instanceIsOpen(instance.status) && specs.length > 0) {
    createEmitted(instanceId, nodeId, specs);
  }

  promoteQueued();
  advanceInstances();
}

/* ------------------------------------------------------------------ */
/* Merge blocks: landing what the blocks in front of them built         */
/* ------------------------------------------------------------------ */

/**
 * The rows are written by the worker, not by us, so this is a poll.
 *
 * There is no deadline beside it, deliberately. A merge block waits for its
 * branches for as long as merging them takes — the worker is one sequential
 * loop for the whole process, so this block's rows can sit behind somebody
 * else's batch and a conflict resolution takes as long as it takes, and none of
 * that is a reason to stop watching. It used to give up at an hour, or fifteen
 * minutes a branch, and what that bought was a block reporting its branches as
 * not landed while the queue was still landing them — a graph that carried on
 * past a merge it said had failed.
 *
 * What the limit was actually protecting against is a block stuck `thinking`
 * for ever, and that has an answer that is somebody's decision rather than a
 * clock's: `stopInstance` writes the block off, which this loop tests on every
 * pass, and the queue's own Cancel takes the batch. A clock could not tell the
 * difference between a wedged block and a large merge; an operator can.
 */
const MERGE_POLL_MS = 2_000;

/** What became of one branch a merge block was handed. */
export interface BranchOutcome {
  /** The branch, or the run's short id when it never had one to name. */
  branch: string;
  /**
   * `landed` — it is on its target. `skipped` — there was nothing to put there,
   * which is not a failure. `failed` — there was, and it did not get there.
   */
  result: "landed" | "skipped" | "failed";
  reason: string | null;
}

/** How many branches a summary names before it starts counting them instead. */
const MAX_NAMED_BRANCHES = 4;

/**
 * Whether a merge block succeeded, and the sentence that says what happened.
 *
 * Pure and unit-tested, for `landRefusal`'s reason one level up: this decides
 * whether the blocks *behind* a merge start, and both ways of being wrong are
 * silent. Read as failed, a chain that landed cleanly stops with nothing left to
 * do; read as succeeded, a follow-up run starts on a target that never received
 * the work it was written against.
 *
 * **A branch with nothing to land is a success.** A run that completed and
 * committed nothing, and a branch already on its target, both leave the operator
 * with exactly what they asked for — the work is where it belongs — so calling
 * either a failure would stop a graph over a merge that had no work to do. What
 * is *not* a success is a predecessor that should have had a branch and has
 * none: that is the isolation this block was saved against having quietly
 * degraded, and reporting it as fine is the "a run that looks like it did
 * nothing" failure this app keeps meeting.
 *
 * The note is null only when every branch landed and none was skipped — silence
 * means the plain thing happened, and anything else is written down.
 */
export function mergeBlockOutcome(branches: readonly BranchOutcome[]): {
  ok: boolean;
  note: string | null;
} {
  if (branches.length === 0) {
    return { ok: true, note: "There was no branch to land." };
  }

  const failed = branches.filter((b) => b.result === "failed");
  const skipped = branches.filter((b) => b.result === "skipped");
  const landed = branches.filter((b) => b.result === "landed");

  if (failed.length > 0) {
    const named = failed
      .slice(0, MAX_NAMED_BRANCHES)
      .map((b) => `${b.branch} — ${b.reason ?? "no reason recorded"}`);
    const rest = failed.length - named.length;
    return {
      ok: false,
      note:
        `Landed ${landed.length} of ${branches.length - skipped.length} branch(es). ` +
        named.join("; ") +
        (rest > 0 ? `; and ${rest} more` : "") +
        ".",
    };
  }

  if (skipped.length === 0) return { ok: true, note: null };
  const named = skipped
    .slice(0, MAX_NAMED_BRANCHES)
    .map((b) => `${b.branch} — ${b.reason ?? "nothing to land"}`);
  const rest = skipped.length - named.length;
  return {
    ok: true,
    note:
      `Landed ${landed.length} branch(es); ${skipped.length} had nothing to land: ` +
      named.join("; ") +
      (rest > 0 ? `; and ${rest} more` : "") +
      ".",
  };
}

/**
 * Land the branches the blocks in front of this one left behind.
 *
 * Everything that decides whether a branch may be landed is
 * `mergeQueue`/`land.ts`'s and is deliberately not restated here: one merge in
 * flight for the whole process, every item re-previewed against git at its own
 * turn, a conflict reconciled on the run's own branch in a throwaway checkout,
 * and a dirty operator checkout — or one standing on the wrong branch — refusing
 * every branch in that repository. This function's whole job is choosing *which*
 * runs go into the queue and reading back what happened.
 *
 * The two awaits before the queue matter and are ordered the way `startBlockTurn`
 * orders its own: the instance is re-read after them, because a halt may have
 * closed the door while git was being asked, and queueing into a stopping
 * workflow is a write into somebody's checkout for a workflow being taken down.
 */
async function startMergeBlock(
  instanceId: string,
  nodeId: string,
  runIds: readonly string[],
): Promise<void> {
  const instance = getInstance(instanceId);
  const node = instance ? blockNode(instance, nodeId) : undefined;
  if (!instance || !node || node.kind !== "merge" || !node.mergeStrategy) {
    finishMergeBlock(instanceId, nodeId, {
      ok: false,
      note: "This block is no longer in the workflow this run was started from.",
    });
    return;
  }

  // The workflow-wide guard, at this kind of block boundary — but only when the
  // block can actually spend. A merge with no resolution authorised costs
  // nothing, and halting a graph at a free step would leave the work it already
  // paid for unlanded for the sake of a limit this block cannot move. The blocks
  // *behind* it are still checked at their own cycle boundary, so nothing
  // escapes the guard by standing behind a merge.
  let guardNote: string | null = null;
  if (node.mergeAutoResolve) {
    const guard = enforceInstanceBudgetForBlock(
      instanceId,
      await currentSnapshot(),
    );
    if (guard?.kind === "halted") return;
    if (guard?.kind === "unenforceable") {
      // Logged rather than acted on, the same answer `startBlockTurn` gives.
      guardNote = `Its workflow has a limit that could not be read here: ${guard.verdict.reason}`;
    }
  }

  const candidates: BranchOutcome[] = [];
  const queueable: string[] = [];
  for (const runId of runIds) {
    const verdict = await branchVerdict(runId);
    if (verdict.result === "queue") queueable.push(runId);
    else candidates.push(verdict.outcome);
  }

  const fresh = getInstance(instanceId);
  if (!fresh || !instanceIsOpen(fresh.status)) {
    upsertBlock(
      instanceId,
      node,
      "blocked",
      "The workflow was stopped before this block could land anything.",
    );
    return;
  }

  if (queueable.length === 0) {
    finishMergeBlock(instanceId, nodeId, {
      ...withNote(mergeBlockOutcome(candidates), guardNote),
    });
    return;
  }

  // Recorded before the rows exist rather than after `enqueue` returns, which
  // is why the id is minted here. Two things rest on it, and only the first
  // used to: a restart or a halt leaves the block pointing at the rows that say
  // what happened to each branch — and, since the doors in `land.ts` read this
  // column to tell the pass's own merge block from a person reaching in behind
  // it, the tie is also this block's *identity*. `enqueue` starts the worker,
  // so a row drained before the tie was written would be refused by the very
  // guard the tie exists to lift, and a pass would land nothing for want of a
  // statement a microtask away.
  const batchId = randomUUID();
  db()
    .prepare(
      "UPDATE workflow_instance_blocks SET merge_batch_id=?" +
        " WHERE instance_id=? AND node_id=? AND status='thinking'",
    )
    .run(batchId, instanceId, nodeId);

  const queued = enqueue(queueable, {
    strategy: node.mergeStrategy,
    autoResolve: node.mergeAutoResolve,
    batchId,
  });
  if (!queued.ok) {
    // Nothing was queued, so the id names no rows. Cleared rather than left,
    // because a block pointing at a batch that does not exist reads on the
    // instance page as a merge whose rows have been swept.
    db()
      .prepare(
        "UPDATE workflow_instance_blocks SET merge_batch_id=NULL" +
          " WHERE instance_id=? AND node_id=? AND merge_batch_id=?",
      )
      .run(instanceId, nodeId, batchId);
    finishMergeBlock(instanceId, nodeId, {
      ok: false,
      note: `Its branches could not be queued: ${queued.reason}`,
    });
    return;
  }

  const rows = await awaitBatch(queued.batchId, instanceId, nodeId);
  for (const row of rows) {
    candidates.push(queuedBranchOutcome(row, branchLabel(row.run_id)));
  }

  finishMergeBlock(instanceId, nodeId, {
    ...withNote(mergeBlockOutcome(candidates), guardNote),
    costUSD: rows.reduce((sum, r) => sum + r.resolve_cost, 0),
  });
}

/**
 * What one row of the batch a merge block queued means for that block.
 *
 * Pure and exported for a test, for `mergeBlockOutcome`'s reason: both ways of
 * reading a row wrong are silent. `already-landed` is `branchVerdict`'s skip
 * reached at the branch's turn rather than before the queue — its work got to
 * the target some other way, a successor in the same batch or a merge by hand
 * — and failing it stops a graph over a merge that had nothing to do. The
 * queue's own `skipped` is not that: it is a branch never attempted because
 * the checkout stopped its repository, and reading it as nothing to land
 * starts the blocks behind this one on a target that never received the work.
 */
export function queuedBranchOutcome(
  row: Pick<QueueRow, "status" | "message">,
  branch: string,
): BranchOutcome {
  if (row.status === "landed") return { branch, result: "landed", reason: null };
  if (row.status === "already-landed") {
    return { branch, result: "skipped", reason: row.message ?? "already on its target" };
  }
  return {
    branch,
    result: "failed",
    // Nothing here stops waiting on a clock any more, so a row still active is
    // the workflow having been halted out from under it — not a verdict, but a
    // branch that is not on its target, which is the only question a
    // successor's condition asks.
    reason: isQueueActive(row.status)
      ? "still in the merge queue when this workflow was stopped"
      : (row.message ?? row.status),
  };
}

/** A note the block has to carry regardless of how the merge itself went. */
function withNote(
  outcome: { ok: boolean; note: string | null },
  extra: string | null,
): { ok: boolean; note: string | null } {
  if (!extra) return outcome;
  return {
    ok: outcome.ok,
    note: outcome.note ? `${outcome.note} ${extra}` : extra,
  };
}

/**
 * Whether one predecessor run has a branch worth queueing.
 *
 * Two answers, carrying three things that can be true of a finished run, and
 * only one of them is the block's problem. `queue` is a branch with commits on
 * it. `settled` is the other two, already in the words the report uses:
 * `skipped` is a branch with nothing on it, or one already on its target —
 * the work is where the operator wanted it, so there is nothing to do and
 * nothing wrong. `failed` is a run that was supposed to leave a branch and did
 * not: `normalizeWorkflowInput` refuses a merge block whose predecessors' guards
 * do not isolate, so reaching this means the isolation *degraded* at run time —
 * `resolveIsolation` falls back to working in the folder when a folder turns out
 * not to be a repository — and that is exactly the case where saying nothing
 * leaves an operator believing work landed that never did.
 */
async function branchVerdict(
  runId: string,
): Promise<{ result: "queue" } | { result: "settled"; outcome: BranchOutcome }> {
  const label = branchLabel(runId);
  const skip = (reason: string) => ({
    result: "settled" as const,
    outcome: { branch: label, result: "skipped" as const, reason },
  });
  const fail = (reason: string) => ({
    result: "settled" as const,
    outcome: { branch: label, result: "failed" as const, reason },
  });

  let state: Awaited<ReturnType<typeof landState>>;
  try {
    // No asker, and **nothing below may read `state.blocked`**. This runs
    // before the batch exists, so there is no asker to give; a caller here that
    // started refusing on `blocked` would refuse every branch of a live pass —
    // its own — before the queue ever saw them, which is the defect the asker
    // exists to close, one step earlier where no door is looking. The four
    // questions asked below are about the branch and about git alone.
    state = await landState(runId);
  } catch (err) {
    return fail(
      `its branch could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!state) {
    return fail(
      "it worked directly in the folder rather than on a branch of its own, so " +
        "there is no branch to land",
    );
  }
  if (!state.branchExists) return fail("its branch no longer exists");
  if (state.merged || state.landedUnchanged) {
    return skip(`already on ${state.target ?? "its target"}`);
  }
  if (state.ahead === 0) return skip("it left no commits of its own");
  return { result: "queue" };
}

/** How a branch is named in a report, falling back to the run's short id. */
function branchLabel(runId: string): string {
  return getRun(runId)?.worktree_branch ?? runId.slice(0, 8);
}

/**
 * Wait for one batch to drain.
 *
 * Two ways out, and neither of them is a clock. Every row terminal is the merge
 * having finished, which is the answer this exists to wait for however long it
 * takes. The block no longer `thinking` is a halt, which has already written
 * the row and whose answer wins — `finishMergeBlock`'s guarded status write
 * would refuse ours anyway. A halt still waits out the one row in flight,
 * because the halt leaves that merge to finish and its resolution is billed:
 * returning before it reports would leave its cost off the block, which is the
 * only place the instance total reads it from.
 */
async function awaitBatch(
  batchId: string,
  instanceId: string,
  nodeId: string,
): Promise<QueueRow[]> {
  for (;;) {
    const rows = batchRows(batchId);
    if (!rows.some((r) => isQueueActive(r.status))) return rows;
    if (
      getBlock(instanceId, nodeId)?.status !== "thinking" &&
      !rows.some((r) => r.status === "landing" || r.status === "resolving")
    ) {
      return rows;
    }
    await new Promise((resolve) => setTimeout(resolve, MERGE_POLL_MS).unref?.());
  }
}

/**
 * Record what a merge block did.
 *
 * `settleBlock`'s shape and its latch: guarded on `status='thinking'`, so a halt
 * that wrote the block off while the queue was draining keeps its own wording.
 * `emitted` for a success and `failed` for anything else, reusing the vocabulary
 * every liveness query and every reconciler already reads — see `BlockStatus`.
 * The cost is outside the latch for `settleBlock`'s reason: a resolution billed
 * before the halt was still billed.
 */
function finishMergeBlock(
  instanceId: string,
  nodeId: string,
  result: { ok: boolean; note: string | null; costUSD?: number },
): void {
  const settled = db().transaction((): boolean => {
    db()
      .prepare(
        "UPDATE workflow_instance_blocks SET cost_usd = cost_usd + ?" +
          " WHERE instance_id=? AND node_id=?",
      )
      .run(result.costUSD ?? 0, instanceId, nodeId);
    return (
      db()
        .prepare(
          `UPDATE workflow_instance_blocks SET status=?, finished_at=?, error=?
            WHERE instance_id=? AND node_id=? AND status='thinking'`,
        )
        .run(result.ok ? "emitted" : "failed", Date.now(), result.note, instanceId, nodeId)
        .changes > 0
    );
  })();
  if (!settled) return;

  promoteQueued();
  advanceInstances();
}

/* ------------------------------------------------------------------ */
/* Review blocks                                                       */
/* ------------------------------------------------------------------ */

/** A review block's branches, as they stand. The instance page reads these. */
interface ReviewItemRow {
  origin_run_id: string;
  run_id: string;
  position: number;
  round: number;
  status: "reviewing" | "fixing" | "approved" | "set-aside";
  review_id: string | null;
  note: string | null;
  cost_usd: number;
  /** 1 when it was set aside because its run committed nothing — see `workSetAsideOf`. */
  committed_nothing: number;
}

export function reviewItemsOf(instanceId: string, blockId: string): ReviewItemRow[] {
  return db()
    .prepare(
      `SELECT origin_run_id, run_id, position, round, status, review_id, note, cost_usd,
              committed_nothing
         FROM workflow_review_items
        WHERE instance_id = ? AND block_id = ?
        ORDER BY position`,
    )
    .all(instanceId, blockId) as ReviewItemRow[];
}

/**
 * The runs a review block hands on: each approved branch's last link.
 *
 * `LoopRunState`'s shape because a loop pass reads it as well as the top level,
 * and a pass also asks whether a run reported done.
 */
function approvedRunsOf(instanceId: string, blockId: string): LoopRunState[] {
  const rows = db()
    .prepare(
      `SELECT r.id AS id, r.status AS status, r.iterations AS iterations,
              ${refundedCyclesSql("r")} AS refundedCycles,
              r.reported_done AS reportedDone
         FROM workflow_review_items i
         JOIN runs r ON r.id = i.run_id
        WHERE i.instance_id = ? AND i.block_id = ? AND i.status = 'approved'
        ORDER BY i.position`,
    )
    .all(instanceId, blockId) as Array<{
    id: string;
    status: RunStatus;
    iterations: number;
    refundedCycles: number;
    reportedDone: number | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    iterations: row.iterations,
    refundedCycles: row.refundedCycles,
    reportedDone: !!row.reportedDone,
    leftBehind: false,
  }));
}

/**
 * How many branches a review block set aside with work on them: every
 * set-aside except one whose run committed nothing, which lost nothing.
 */
function workSetAsideOf(instanceId: string, blockId: string): number {
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS n
         FROM workflow_review_items
        WHERE instance_id = ? AND block_id = ? AND status = 'set-aside'
          AND committed_nothing = 0`,
    )
    .get(instanceId, blockId) as { n: number };
  return row.n;
}

function updateReviewItem(
  instanceId: string,
  blockId: string,
  originRunId: string,
  patch: Partial<
    Pick<ReviewItemRow, "run_id" | "round" | "status" | "review_id" | "note" | "committed_nothing">
  > & {
    addCost?: number;
  },
): void {
  const row = db()
    .prepare(
      "SELECT * FROM workflow_review_items WHERE instance_id=? AND block_id=? AND origin_run_id=?",
    )
    .get(instanceId, blockId, originRunId) as ReviewItemRow | undefined;
  if (!row) return;
  db()
    .prepare(
      `UPDATE workflow_review_items
          SET run_id=?, round=?, status=?, review_id=?, note=?, committed_nothing=?,
              cost_usd = cost_usd + ?, updated_at=?
        WHERE instance_id=? AND block_id=? AND origin_run_id=?`,
    )
    .run(
      patch.run_id ?? row.run_id,
      patch.round ?? row.round,
      patch.status ?? row.status,
      patch.review_id === undefined ? row.review_id : patch.review_id,
      patch.note === undefined ? row.note : patch.note,
      patch.committed_nothing ?? row.committed_nothing,
      patch.addCost ?? 0,
      Date.now(),
      instanceId,
      blockId,
      originRunId,
    );
}

/** Whether the block is still the one this loop is driving — a halt ends it. */
function reviewStillOpen(instanceId: string, blockId: string): boolean {
  if (isShuttingDown()) return false;
  return getBlock(instanceId, blockId)?.status === "thinking";
}

const pause = () =>
  new Promise((resolve) => setTimeout(resolve, MERGE_POLL_MS).unref?.());

/**
 * Review every branch in front of this block, send the rejected ones back for
 * fixes, and hand on the ones a frontier model approved.
 *
 * `startMergeBlock`'s shape: one async function per block, claimed `thinking`
 * by the caller, polling what it waits on and giving up the moment the block is
 * no longer `thinking` — which is how a halt reaches it — and settling through
 * the same latch. The branches are driven side by side, each through
 * `reviewBlock.ts`'s decisions, because one slow fix run must not hold the
 * reviews of the others.
 *
 * Its fix runs are this instance's runs — registered under this block — so the
 * instance budget, a halt and the page all cover them with no new code, and
 * each review's cost lands on the block's own row as the review ends, which is
 * what the instance total and its guard read.
 */
// Exported for `reviewBlockRun.test.ts` and nothing else: the scheduler is
// the only caller, and the alternative seam is a whole instance of billed runs.
export async function startReviewBlock(
  instanceId: string,
  nodeId: string,
  runIds: readonly string[],
): Promise<void> {
  const instance = getInstance(instanceId);
  const node = instance ? blockNode(instance, nodeId) : undefined;
  if (!instance || !node || node.kind !== "review") {
    finishMergeBlock(instanceId, nodeId, {
      ok: false,
      note: "This block is no longer in the workflow this run was started from.",
    });
    return;
  }
  const fixRounds = node.fixRounds ?? 0;

  // The workflow-wide guard, at this kind of block boundary — and always,
  // where the merge block's is conditional: every branch handed to this block
  // is a billed review, so there is no free case to let through.
  let guardNote: string | null = null;
  const guard = enforceInstanceBudgetForBlock(instanceId, await currentSnapshot());
  if (guard?.kind === "halted") return;
  if (guard?.kind === "unenforceable") {
    // Logged rather than acted on, the same answer `startBlockTurn` gives.
    guardNote = `Its workflow has a limit that could not be read here: ${guard.verdict.reason}`;
  }
  // Re-read after the snapshot: a halt that closed the door meanwhile has
  // already written this block off, and seeding its branches would draw a
  // review on the page that never happened.
  if (!reviewStillOpen(instanceId, nodeId)) return;

  // Seeded once. `INSERT OR IGNORE` because a retried block finds its rows.
  const now = Date.now();
  runIds.forEach((runId, position) => {
    db()
      .prepare(
        `INSERT OR IGNORE INTO workflow_review_items
           (instance_id, block_id, origin_run_id, run_id, position, round, status, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, 'reviewing', ?)`,
      )
      .run(instanceId, nodeId, runId, runId, position, now);
  });

  await Promise.all(
    runIds.map((runId) =>
      driveReviewItem(instance, node, nodeId, runId, fixRounds).catch((err) => {
        updateReviewItem(instanceId, nodeId, runId, {
          status: "set-aside",
          note: `this app could not carry on reviewing it: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }),
    ),
  );

  if (!reviewStillOpen(instanceId, nodeId)) return;
  const items = reviewItemsOf(instanceId, nodeId);
  // No cost here: `bankReviewSpend` put each review's on the row as it ended.
  finishMergeBlock(
    instanceId,
    nodeId,
    withNote(
      {
        ok: true,
        note: reviewBlockSummary(
          items.map((item) => ({
            branch: branchLabel(item.origin_run_id),
            status: item.status,
            note: item.note,
          })),
        ),
      },
      guardNote,
    ),
  );
}

/**
 * Put one settled review's cost on its block's row, the moment it is known.
 *
 * As it lands rather than when the block ends, because the block row is all
 * the instance total and its guard read: a review counted only at the end was
 * invisible to both for as long as the block worked, so fix runs and blocks
 * started meanwhile were guarded against a figure missing it — and lost
 * outright when a halt ended the block first. Unlatched, for `settleBlock`'s
 * reason. A failed review that reported nothing is a gap and not a zero, so it
 * is counted in `cost_unreported`, as a deciding turn that died silent is.
 */
function bankReviewSpend(
  instanceId: string,
  blockId: string,
  review: { status: string; cost_usd: number },
): void {
  db()
    .prepare(
      `UPDATE workflow_instance_blocks
          SET cost_usd = cost_usd + ?, cost_unreported = cost_unreported + ?
        WHERE instance_id=? AND node_id=?`,
    )
    .run(
      review.cost_usd,
      review.status === "failed" && review.cost_usd === 0 ? 1 : 0,
      instanceId,
      blockId,
    );
}

/** One review's row once it has stopped running, or null if it is gone. */
async function reviewSettled(reviewId: string): Promise<ReturnType<typeof getAssist>> {
  let review = getAssist(reviewId);
  while (review?.status === "running") {
    await pause();
    review = getAssist(reviewId);
  }
  return review;
}

/** One branch, from its first review to approved or set aside. */
async function driveReviewItem(
  instance: WorkflowInstance,
  node: WorkflowNode,
  blockId: string,
  originRunId: string,
  fixRounds: number,
): Promise<void> {
  const instanceId = instance.id;
  const item = () =>
    reviewItemsOf(instanceId, blockId).find((i) => i.origin_run_id === originRunId);
  // Asked after every `await` below, because each one is a moment a halt can
  // land in, and everything after it starts or judges something. Asked only at
  // the top of each poll, a rejection read after a halt started a fix run into
  // the stopped workflow, as a member nothing would ever stop.
  const open = () => reviewStillOpen(instanceId, blockId);

  for (;;) {
    const current = item();
    if (!current || current.status === "approved" || current.status === "set-aside") return;
    if (!open()) return;

    // Waited for rather than refused: a full assist queue is a shortage that
    // clears in minutes, and a branch set aside over it would be judged by the
    // queue rather than by a review.
    if (assistBudgetFull()) {
      await pause();
      continue;
    }
    const started = await startReview(current.run_id, {
      requireVerdict: true,
      stillWanted: open,
    });
    if (!started.ok) {
      // A halt while the review was being prepared: `stillWanted` refused it
      // before anything was spawned, and it is no verdict on the branch.
      if (!open()) return;
      // Nothing committed is a fact about the run — the model did nothing
      // worth merging — and anything else is this app unable to review at this
      // moment. Neither is a frontier verdict, so neither marks the tasks.
      updateReviewItem(instanceId, blockId, originRunId, {
        status: "set-aside",
        note: started.nothingToReview
          ? "it committed nothing to review"
          : `it could not be reviewed: ${started.reason}`,
        committed_nothing: started.nothingToReview ? 1 : 0,
      });
      return;
    }
    updateReviewItem(instanceId, blockId, originRunId, { review_id: started.id });
    // A halt in the turn between the gate and the line above found no
    // `review_id` to signal, so it is signalled here instead.
    if (!open()) {
      const child = assistChild(started.id);
      if (child) signalLadder(child);
    }

    // Waited out whatever the block's state, halted or not: the halt signals
    // the reviewer rather than abandoning it, and what it reports on its way
    // out is still this instance's money.
    const review = await reviewSettled(started.id);
    if (!review) return;
    updateReviewItem(instanceId, blockId, originRunId, { addCost: review.cost_usd });
    bankReviewSpend(instanceId, blockId, review);
    // Nothing awaits between this and `createRun` below, so this is also the
    // check immediately before the fix run is created.
    if (!open()) return;

    const step = nextReviewStep(
      { status: review.status === "completed" ? "completed" : "failed", text: review.text, error: review.error },
      current.round,
      fixRounds,
    );
    if (step.kind === "approve") {
      updateReviewItem(instanceId, blockId, originRunId, { status: "approved", note: null });
      return;
    }
    if (step.kind === "set-aside") {
      setAside(instanceId, blockId, originRunId, current.run_id, step.reason, step.needsFrontier, node.name);
      return;
    }

    // A fix round: the same branch carried on, on the same provider and model,
    // under the guards the run it continues was started with — never wider —
    // briefed with the review it has to answer.
    const prev = getRun(current.run_id);
    if (!prev) {
      updateReviewItem(instanceId, blockId, originRunId, {
        status: "set-aside",
        note: "the run it would carry on has been deleted",
      });
      return;
    }
    const stored = JSON.parse(prev.budget) as { permissionMode?: PermissionMode };
    let fix: RunRow;
    try {
      fix = createRun({
        folder: prev.folder,
        prompt: fixRunPrompt(prev.prompt, review.text ?? "", step.round, fixRounds),
        model: prev.model,
        provider: prev.provider,
        permissionMode: stored.permissionMode,
        isolate: true,
        agent: parseRunAgent(prev.agent),
        budget: normalizePolicy(stored),
        dependsOn: [{ runId: prev.id, edge: "on-finish", continueBranch: true }],
        origin: instance.origin ?? "workflow",
        originRef: instance.originRef ?? instanceId,
      });
    } catch (err) {
      updateReviewItem(instanceId, blockId, originRunId, {
        status: "set-aside",
        note: `its fix run could not be started: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    recordMember(instanceId, {
      nodeId: `${blockId}#fix-${fix.id.slice(0, 8)}`,
      nodeName: `${node.name} · fix ${step.round}`,
      position: nextPosition(instanceId),
      runId: fix.id,
      emittedBy: blockId,
    });
    updateReviewItem(instanceId, blockId, originRunId, {
      status: "fixing",
      round: step.round,
      note: `fix round ${step.round} of ${fixRounds}: ${fix.id.slice(0, 8)}`,
    });

    let run = getRun(fix.id);
    while (run && !TERMINAL_STATUSES.includes(run.status)) {
      if (!open()) return;
      await pause();
      run = getRun(fix.id);
    }
    if (!run || !open()) return;
    const after = afterFixRun(run.status, run.iterations);
    if (after.kind === "set-aside") {
      setAside(instanceId, blockId, originRunId, run.id, after.reason, after.needsFrontier, node.name);
      return;
    }
    updateReviewItem(instanceId, blockId, originRunId, {
      status: "reviewing",
      run_id: run.id,
    });
  }
}

/**
 * Set one branch aside, and — when a frontier model turned it down — mark every
 * task it was for as needs-frontier, reopen it, and say why on each.
 *
 * Reopened because the claim or the tick the rejected run left on it is now
 * false: nobody is working it and the work was never merged. Only through
 * `reopenRejectedTask`, which moves a task back only when the run holding it is
 * one of the rejected ones — a task another run holds or closed, or one the
 * operator dropped, is left alone and the note says so.
 */
function setAside(
  instanceId: string,
  blockId: string,
  originRunId: string,
  lastRunId: string,
  reason: string,
  needsFrontier: boolean,
  blockName: string,
): void {
  updateReviewItem(instanceId, blockId, originRunId, {
    status: "set-aside",
    run_id: lastRunId,
    note: needsFrontier ? `${reason} — its tasks are marked needs-frontier` : reason,
  });
  if (!needsFrontier) return;
  const actor = { kind: "block" as const };
  // The runs whose work was turned down: the one the branch began with, which
  // is the one that claimed its tasks, and the last link, in case it was the
  // one that closed them.
  const rejected = [...new Set([originRunId, lastRunId])];
  for (const task of tasksLinkedToRun(originRunId)) {
    if (!task.status) continue;
    // The mark before the reopen, so the task is never open and unmarked — a
    // local pass reading the board in between would take it straight back.
    updateTask(task.id, { needsFrontier: true }, actor);
    const reopened = reopenRejectedTask(task.id, rejected);
    const state =
      reopened.ok && reopened.reopened
        ? "so this task is open again"
        : reopened.ok
          ? `and this task was left ${reopened.task.status} because ${reopened.why}`
          : "and this task could not be read back";
    addTaskComment(
      task.id,
      {
        body:
          `“${blockName}” set run ${originRunId.slice(0, 8)}'s branch aside: ${reason}. ` +
          `Its work was not merged, ${state}. It is marked needs-frontier, so no ` +
          "local-model run will take it on until the mark is cleared.",
      },
      actor,
    );
  }
}

/**
 * Create the runs a block emitted, in one synchronous pass.
 *
 * `startWorkflow`'s pass, for a graph a model wrote rather than a person: no
 * `await` from the first `createRun` to the last, because the folder claim is
 * only atomic inside one event-loop turn, and the specs arrive already in
 * topological order so every one is created after everything it waits for.
 *
 * It is **not** all-or-nothing, and that is the one place it diverges. A graph
 * that half exists is a prefix nobody asked for, so `startWorkflow` rolls back;
 * here each spec is an independent piece of work that a block decided on
 * separately, and throwing away four runs because a fifth named a folder that
 * has since gone would lose the whole point of the block. A spec that cannot be
 * created is noted against the block instead — including for the specs behind
 * it, whose edges now name a run that does not exist.
 */
function createEmitted(
  instanceId: string,
  nodeId: string,
  specs: readonly RunSpec[],
): void {
  const instance = getInstance(instanceId)!;
  const node = blockNode(instance, nodeId);
  if (!node) return;

  const template = node.templateId ? getTemplate(node.templateId) : null;
  const defaults = chatGuards();
  const runIds = new Map<string, string>();
  const failures: string[] = [];

  for (const spec of specs) {
    const missing = spec.dependsOn.filter((d) => !runIds.has(d.id));
    if (missing.length > 0) {
      failures.push(
        `“${spec.title}” was not started: the run(s) it waits for could not be started either.`,
      );
      continue;
    }
    // Resolved now rather than when the spec was accepted, for the reason the
    // template beside it is read at this moment: a row can go between a turn
    // ending and its runs being created. That spec fails by name — a run
    // started as nobody when it was emitted "as the reviewer" is the silent
    // drop this app refuses at every other door — and the others still start,
    // which is this pass's whole difference from `startWorkflow`'s.
    let agent: AgentDefinition | null = null;
    if (spec.agent) {
      const saved = getAgentByName(spec.agent);
      if (!saved || !saved.usable) {
        failures.push(
          `“${spec.title}” was not started: the “${spec.agent}” agent it was ` +
            "emitted with is no longer usable, and a run that is not the agent " +
            "it was emitted as cannot be told from one that never named one.",
        );
        continue;
      }
      agent = agentDefinition(saved);
    }

    try {
      // Every one of these edges names a run created moments ago in this same
      // pass, whose id was minted after its own edges were read — so no insert
      // here can close a loop. `admitDependencies` re-runs `dependencyCycle`
      // over the whole live graph regardless, which is what keeps acyclicity a
      // property of the data now that a graph written by a model reaches it;
      // `planEmission` has already refused a cyclic emission by name.
      const ready = localReady(
        planEmittedRun(node, spec, template, defaults, agent),
        node.name,
      );
      if (!ready.ok) {
        failures.push(`“${spec.title}” was not started: ${ready.reason}`);
        continue;
      }
      const run = createRun({
        ...ready.input,
        dependsOn: spec.dependsOn.map((d) => ({
          runId: runIds.get(d.id)!,
          edge: d.edge,
        })),
        // Not the instance's origin, even inside a scheduled one: what
        // authorised *this* run is a model's decision taken moments ago, which
        // is the one origin here that no person chose run by run. The block's
        // node is the reference, matching `workflow_instance_runs.emitted_by`
        // and readable without that join.
        origin: "orchestrator-block",
        originRef: nodeId,
        // The links, carried from the spec onto the run — through the door
        // rather than written after it, because `createRun` may start the run
        // before it returns and the run's own claim reads them. Written
        // whatever became of the rows, unlike the agent above it, and the
        // difference is what each one decides: a run that is not the agent it
        // was emitted as is a different run, where a run whose task has since
        // been deleted is the same run with a record of where it came from.
        //
        // Not a completion. The run claims these when it starts; nothing closes
        // one when it ends — a run can complete and still not have done the
        // thing, and `taskTransitionRefusal` is where that stays decided.
        taskIds: spec.taskIds,
      });
      runIds.set(spec.id, run.id);
      recordMember(instanceId, {
        nodeId: `${nodeId}#${spec.id}`,
        nodeName: spec.title,
        position: nextPosition(instanceId),
        runId: run.id,
        emittedBy: nodeId,
      });
    } catch (err) {
      failures.push(
        `“${spec.title}” could not be started: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Notes, not `error`: the turn did not fail — it decided, and this app could
  // not do what it decided. `error` is the one voice kept for the turn itself,
  // and a failure written there reads as the model's.
  for (const failure of failures) noteBlock(instanceId, nodeId, failure);
}

export type EmissionOutcome =
  | { ok: true; accepted: number }
  | { ok: false; reason: string };

/**
 * Why an emitted folder cannot be used by this block, or null when it can.
 *
 * Two bounds, not one, and the second is the one a person actually set. The
 * mount is the containment guarantee — `resolveInMount`, twice, before and after
 * the symlink is resolved — and it is deliberately no narrower than a mount,
 * because widening or narrowing it would change what every other caller of
 * `resolveWorkspaceFolder` is permitted to touch. But a mount holds every
 * repository on it, and what the operator saved on this block was a *folder*.
 * This is the one place that knows which block is asking, so it is the only
 * place that check can be made — and it is the same bound `blockSystemPrompt`
 * promises the model in words, which until now nothing enforced.
 *
 * A block saved on the mount root (`folder === ""`) is bounded by its mount and
 * nothing narrower, which is what its own prompt tells it.
 *
 * `resolve` is injected for the reason `EmissionLimits.folderRefusal` is: it is
 * a syscall, and the decision it feeds has to stay testable without one.
 * Containment is decided on the *resolved* paths, so a symlink inside the
 * block's folder that points at a sibling is refused rather than read as inside.
 */
export function emittedFolderRefusal(
  blockFolder: string,
  folder: string,
  resolve: (folder: string) => string,
): string | null {
  let resolved: string;
  try {
    resolved = resolve(folder);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  if (blockFolder === "") return null;

  let root: string;
  try {
    root = resolve(blockFolder);
  } catch {
    // The block's own folder has gone since the graph was saved. Nothing can be
    // shown to be inside it, so nothing is — refusing is the direction that
    // cannot start an agent in a repository nobody pointed it at.
    return `This block works in “${blockFolder}”, which cannot be found any more, so no folder can be shown to be inside it.`;
  }

  // The `resolveInMount` idiom, applied one level in. Compared exactly rather
  // than case-folded, unlike `overlaps`: over-refusing costs a sentence the
  // model can act on, where case-folding on a case-sensitive filesystem would
  // accept a genuinely different sibling directory.
  const rel = path.relative(root, resolved);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return null;
  const named = folder === "" ? "The workspace root" : `Folder “${folder}”`;
  return `${named} is outside “${blockFolder}”, which is where this block works.`;
}

/**
 * The one tool an orchestrator block has that writes anything.
 *
 * It **records** the specs rather than creating the runs, and they are created
 * when the turn ends. Two reasons, and both are about the shape rather than the
 * timing: `createRun` has to run in one uninterrupted event-loop turn and a tool
 * call is in the middle of an HTTP handler, and a block that started runs
 * half-way through its own thinking would leave the operator watching agents
 * appear from a decision that had not been made yet.
 *
 * Exactly one successful call per block. A refused call records nothing, so a
 * turn told its list was too long can emit a shorter one; an accepted one closes
 * the tool, because a second list is a second decision and the cap bounds a
 * decision rather than a call.
 */
export function emitBlockRuns(
  instanceId: string,
  nodeId: string,
  raw: unknown,
): EmissionOutcome {
  const instance = getInstance(instanceId);
  if (!instance) return { ok: false, reason: "This workflow run no longer exists." };
  if (!instanceIsOpen(instance.status)) {
    return {
      ok: false,
      reason:
        "This workflow run is being stopped, so nothing further can be started from it.",
    };
  }

  const block = getBlock(instanceId, nodeId);
  const node = blockNode(instance, nodeId);
  if (!block || !node || node.fanOut === null) {
    return { ok: false, reason: "This block is not part of this workflow run." };
  }
  if (block.status !== "thinking") {
    return { ok: false, reason: "This block's turn has already ended." };
  }
  // The install-wide hold, at this block's door rather than inside
  // `planEmission`: it is a fact about the machine and not about the specs, the
  // same class of refusal as the two above it. Recorded through `noteBlock` for
  // the reason a rejected emission is, and the turn is told plainly — a model
  // that reads "refused" with no cause tries again in a different shape.
  if (newWorkPaused()) {
    noteBlock(
      instanceId,
      nodeId,
      "It tried to emit runs while new work was held across the install, and was refused.",
    );
    return {
      ok: false,
      reason:
        "New work is held across this install, so nothing can be started from " +
        "here. Say in your reply what you would have started.",
    };
  }
  if (block.emitted_specs !== null) {
    noteBlock(
      instanceId,
      nodeId,
      "It called emit_runs a second time and was refused — a block emits once.",
    );
    return {
      ok: false,
      reason:
        "This block has already emitted its runs. Say what else you would have " +
        "started in your reply instead.",
    };
  }

  // Before the plan rather than inside it: `planEmission` is shared with every
  // provider, and this is the one where naming an agent is a spec that would
  // start as nobody. Refused whole, as `planEmission` refuses, so the turn can
  // emit again without the names.
  if (
    node.provider === "codex" &&
    Array.isArray(raw) &&
    raw.some(
      (spec) =>
        spec !== null &&
        typeof spec === "object" &&
        String((spec as { agent?: unknown }).agent ?? "").trim() !== "",
    )
  ) {
    const reason =
      "Every run this block emits goes to Codex, which a saved agent's prompt " +
      "does not reach. Emit the runs again without `agent`.";
    noteBlock(instanceId, nodeId, `It tried to emit runs and was refused: ${reason}`);
    return { ok: false, reason };
  }

  const plan = planEmission(raw, {
    blockName: node.name,
    fanOut: node.fanOut,
    // Against **this block's own mount** and no other, which is what makes "a
    // folder inside the block's mount" mean something: containment is decided
    // per mount by `resolveInMount`, twice, before and after the symlink is
    // resolved. And then against the block's own folder, which is the bound the
    // operator actually set and the one its prompt states.
    folderRefusal: (folder) =>
      emittedFolderRefusal(node.folder, folder, (f) =>
        resolveWorkspaceFolder(f, node.mountId),
      ),
    // The whole registry, which is exactly the list `blockSystemPrompt` showed
    // this turn — two fields of it, because that is all a refusal is written
    // from. An emitted run may name any saved agent for the reason it may write
    // any task: an agent carries no capability, and every guard still comes off
    // the block a person saved.
    agents: listAgents().map((a) => ({ name: a.name, usable: a.usable })),
    // The board behind a call rather than on the type — see the field. The
    // knowledge is read once for the emission so a task filed mid-call cannot
    // make two specs in one list disagree about what exists.
    taskLinks: (() => {
      const knowledge = currentTaskKnowledge();
      // A block whose runs go to the local model may not link a task a
      // frontier review already turned the local model down on — the
      // needs-frontier mark a review block leaves — and is told so by name.
      const localRun = node.provider === "local";
      return (fields, text) => readTaskLinks(fields, text, knowledge, { localRun });
    })(),
  });
  if (!plan.ok) {
    // The one refusal that most needs recording. Everything above is a turn
    // arriving too late or twice; this is a turn that decided what to run and
    // had it rejected — a fan-out over the cap, a folder outside the block's
    // own, a loop among the specs. The model is told why and may well give up
    // without saying so, and then this is the only trace that it ever meant to
    // start anything at all.
    noteBlock(instanceId, nodeId, `It tried to emit runs and was refused: ${plan.reason}`);
    return { ok: false, reason: plan.reason };
  }

  // Guarded on `thinking` again: the halt between the read above and here would
  // otherwise have its written-off block quietly re-armed with an emission.
  const stored = db()
    .prepare(
      "UPDATE workflow_instance_blocks SET emitted_specs=? WHERE instance_id=? AND node_id=? AND status='thinking'",
    )
    .run(JSON.stringify(plan.specs), instanceId, nodeId).changes;
  if (stored === 0) {
    return { ok: false, reason: "This block's turn ended while it was emitting." };
  }
  return { ok: true, accepted: plan.specs.length };
}

/**
 * The emitted runs the model decider should be asked about, read back from the
 * stored emission.
 *
 * Sync, and the asking happens in the `emit_runs` handler between this and
 * `recordEmittedModels` — never inside `emitBlockRuns`, whose check that the
 * block has not emitted and its write of the emission must stay in one
 * event-loop turn, or two concurrent calls could both be accepted.
 */
export function emittedModelWork(
  instanceId: string,
  nodeId: string,
): Array<{ specId: string; work: DeciderWork }> {
  const instance = getInstance(instanceId);
  const block = getBlock(instanceId, nodeId);
  const node = instance ? blockNode(instance, nodeId) : null;
  if (!node || block?.status !== "thinking") return [];

  const template = node.templateId ? getTemplate(node.templateId) : null;
  return parseSpecs(block.emitted_specs).flatMap((spec) => {
    const agent = spec.agent ? getAgentByName(spec.agent) : null;
    const applies = deciderApplies({
      provider: node.provider,
      named: null,
      templateModel: template?.model,
      agentModel: agent?.model,
    });
    if (!applies) return [];
    return [
      {
        specId: spec.id,
        work: { task: `${spec.title}\n\n${spec.task}`, agent: spec.agent, template: template?.name ?? null },
      },
    ];
  });
}

/**
 * Write the decider's picks onto the stored emission, and say each one on the
 * block — a pick, an abstention and an unreachable decider alike, because a
 * run that took the default reads the same in all three otherwise.
 *
 * Latched on `thinking`, `emitBlockRuns`' own write's latch: a turn killed
 * while the decider was answering has already been settled and its runs
 * created on the template's model or the default, so a pick arriving after
 * that changes nothing, and the note says it came too late rather than
 * implying it was used.
 */
export function recordEmittedModels(
  instanceId: string,
  nodeId: string,
  picks: ReadonlyArray<{ specId: string; decision: ModelDecision }>,
): void {
  if (picks.length === 0) return;
  const block = getBlock(instanceId, nodeId);
  if (!block) return;
  const bySpec = new Map(picks.map((pick) => [pick.specId, pick.decision]));
  const specs = parseSpecs(block.emitted_specs);
  const decided = specs.map((spec) => {
    const model = bySpec.get(spec.id)?.model;
    return model ? { ...spec, decidedModel: model } : spec;
  });

  const stored =
    db()
      .prepare(
        "UPDATE workflow_instance_blocks SET emitted_specs=? WHERE instance_id=? AND node_id=? AND status='thinking'",
      )
      .run(JSON.stringify(decided), instanceId, nodeId).changes > 0;

  for (const spec of specs) {
    const decision = bySpec.get(spec.id);
    if (!decision) continue;
    const late =
      !stored && decision.model
        ? " It arrived after the turn had ended, so the run did not use it."
        : "";
    noteBlock(instanceId, nodeId, `“${spec.title}”: ${decision.note}${late}`);
  }
}

/**
 * What the block is, in the absence of a mechanism that makes it so.
 *
 * The chat's system prompt states a role because its allowlist was removed; this
 * one states a role because the *consequences* were removed. Nothing here waits
 * for a person: what this turn emits starts. So the paragraph that matters is
 * not "you may not" but "these will run, under these guards, in this folder,
 * and there are at most N of them" — the facts it needs to make a decision it
 * cannot take back.
 *
 * The mount, the folder, the guard set and the cap are generated rather than
 * left to a prompt an operator can edit, for the reason `continuedWorkNotice`'s
 * facts are: a placeholder that can be deleted is a notice that can silently
 * stop saying the true thing.
 *
 * Which is also the test for what belongs here at all. `emit_runs`' schema in
 * `src/app/api/mcp/route.ts` reaches this turn in the same request, and it
 * already says what a title, a task, a folder, an `agent` and a `dependsOn`
 * edge are — so restating them here bought a second copy per turn, maintained
 * by hand, of the text the model reads at the moment it makes the call. What
 * stays is what no schema can hold: the numbers and names above, which are
 * facts about *this* block, and the consequences of emitting nothing, which are
 * facts about the graph the tool knows nothing about.
 */
function blockSystemPrompt(
  node: WorkflowNode,
  template: RunTemplate | null,
  workflowName: string,
  own: RegistryAgent | null,
  registry: readonly RegistryAgent[],
): string {
  const guards = template
    ? `the “${template.name}” template`
    : "the operator's default guard set in Settings";

  // The agents an emitted run may be started as, named because a name is what
  // `emit_runs` takes — and what `--agent` itself takes, so a name that got
  // through here and is not in the registry would fail that run's spawn.
  // Descriptions are shortened for the reason `MAX_AGENT_DESCRIPTION` exists at
  // all — every one of them rides in this turn's context — and the whole of one
  // reaches the run that names it, on its own argv, when it spawns. An unusable
  // row is left out: the CLI will not register it, so offering it would be
  // offering a run that cannot start.
  // A Codex run cannot be started as a saved agent — the prompt reaches Claude
  // Code's `--agent` only — so the list is not offered to a block whose runs go
  // to Codex, and `emit_runs` refuses a name there.
  const choices = node.provider === "codex" ? [] : registry.filter((a) => a.usable);
  const agentChoices =
    choices.length === 0
      ? []
      : [
          "",
          "Agents you may start a run as, by name in `agent` — the agent's prompt",
          "becomes that run's own. This changes who a run is and never what it may",
          "do, and leaving it out is the ordinary run:",
          ...choices.map(
            (a) =>
              `- ${a.name} — ${
                a.description.length > 200
                  ? `${a.description.slice(0, 200)}…`
                  : a.description
              }`,
          ),
        ];
  // Exactly the bound `emittedFolderRefusal` enforces for this block and no
  // other. A block saved on a folder is held to that folder, the workspace root
  // included — so "" is a refusal there rather than the bad idea it is for a
  // block whose own folder really is the root.
  const folderBounds =
    node.folder === ""
      ? [
          `- Every run works in the “${node.mountId}” workspace, anywhere in it.`,
          "  A folder outside it is refused. Call list_folders and use a path",
          '  exactly as it gives one; "" is the workspace root, which blocks every',
          "  other run in the tree and is almost never what you want.",
        ]
      : [
          `- Every run works in the “${node.mountId}” workspace, at or under`,
          `  ${node.folder}. A folder outside that one is refused, and so is "" —`,
          "  that is the workspace root, which is outside it. Call list_folders",
          "  and use a path exactly as it gives one.",
        ];
  return [
    "You are an orchestrator block inside UsageFoundry, a tool that runs",
    "unattended Claude Code agents against folders on this machine. You are one",
    `step of the workflow “${workflowName}”, and nobody is reading this turn.`,
    "",
    "Your job is to decide which runs should happen next and to emit them with",
    "emit_runs. What you emit **starts immediately**. There is no approval step,",
    "no proposal card and no operator between your answer and a billed agent",
    "writing files. Decide as if you were the last person to look at it, because",
    "you are.",
    "",
    "The bounds you are working inside, none of which you can change:",
    `- At most ${node.fanOut} run(s). emit_runs refuses more, and the limit was`,
    "  set when the workflow was saved.",
    ...folderBounds,
    `- Every run gets its guards — budget, work-cycle limit, permission mode,`,
    `  whether it works in a checkout of its own — from ${guards}.`,
    ...(node.provider === "local"
      ? [
          "- Every run you emit goes to a local model, not to Claude. Pick work it",
          "  can finish unsupervised, and never a task marked needsFrontier: a",
          "  frontier review already turned the local model down on it, and",
          "  emit_runs refuses it in taskIds.",
        ]
      : node.provider === "codex"
        ? [
            "- Every run you emit runs on Codex, not Claude Code. It cannot be",
            "  started as a saved agent, so leave `agent` out.",
          ]
        : []),
    ...(own
      ? [
          `- You are the “${own.name}” agent: the operator gave this block that`,
          "  role, and its prompt is your own. It says who you are and changes",
          "  none of the bounds above, which still apply exactly as written.",
        ]
      : []),
    ...agentChoices,
    "",
    "Emitting — emit_runs' own field descriptions say the rest:",
    "- One run per unit of work. Name the file, the issue number and the URL in",
    "  each task.",
    "- A run that works board tasks lists every one of them in taskIds: it can",
    "  close only those, and a task named in its text but left out is refused.",
    "  A task marked operatorOnly needs the operator and no run may claim it:",
    "  it goes in relatedTaskIds if the brief mentions it, never in taskIds.",
    "  So does a task with claimedByOperator set: the operator is doing it.",
    "- Name every board task by its full id, all 36 characters exactly as",
    "  list_tasks gives it — in taskIds and in the brief's own text. The run",
    "  that reads the brief looks a task up whole and cannot expand the first",
    "  eight characters; a shortened id is refused, and a worker run has no",
    "  list_tasks to find the rest from.",
    "- Runs with no dependsOn link between them start in parallel.",
    "- Emitting nothing is a real answer when there is nothing worth doing — say",
    "  so plainly, and know that any block set to start after this one will be",
    "  stopped rather than run with nothing to work on.",
    "",
    "Before you emit, look. You have every tool the CLI offers and you are",
    "trusted with them because your job is to decide, not to build: read files,",
    "grep, run read-only commands, read issues and CI logs with `gh`, read",
    "history with `git log`. Do not do the work yourself — do not edit, stage,",
    "commit, push or act on GitHub. The runs you emit are what does the work.",
    "",
    "Reply with a short list of what you emitted and what you deliberately left",
    "out. Nobody will answer you.",
  ].join("\n");
}

/** One instance a restart found holding at least one `waiting` block. */
export interface BootBlockInstance {
  id: string;
  status: WorkflowInstanceStatus;
  /** Its member runs, as this same boot's run reconciler has just left them. */
  memberStatuses: readonly RunStatus[];
  /** Whether a restart or a shutdown closed out any of those runs. */
  restartClosedMember: boolean;
}

/** What a restart does with each instance's `waiting` blocks. */
export interface BootBlockPlan {
  /** Nothing of this instance survived the boot: its blocks are closed out. */
  abandoned: string[];
  /** Stopping or failed before the restart: closed out, and told so. */
  settled: string[];
  /** A member survived the boot, so the blocks behind it are left waiting. */
  spared: string[];
  /**
   * New work is held and the restart closed out none of its members, so its
   * blocks are left waiting for the lift.
   */
  held: string[];
}

/**
 * Which instances a restart leaves nothing that could ever wake a `waiting`
 * block, and which it leaves something.
 *
 * The whole of `reconcileBlocksOnBoot`'s new question, pure for the reason
 * `haltPlan` is: every way of getting it wrong typechecks, throws nothing, and
 * is invisible until a graph settles with its tail missing weeks later. Both
 * errors are silent and each is expensive in the opposite direction — a block
 * spared where nothing survived sits `waiting` for ever, and a block closed out
 * where something did survive destroys the tail of a workflow that was still
 * working, under a sentence about a predecessor that is not true.
 *
 * A member is what decides it, because a member is the only thing that can
 * still reach `releaseDependents` and so `advanceInstances`. `LIVE_STATUSES` is
 * the same reading `liveMemberCount` and `reconcileHaltsOnBoot` take, rather
 * than a test for `paused` or `waiting`, which are the only statuses that can be
 * live at this point in the boot, by way of rules in `reconcileOnBoot` that this
 * function must not restate.
 *
 * An instance that is not `started` is closed out however live its members are.
 * Its blocks have no future either way: a `stopping` one is being taken down
 * and `reconcileHaltsOnBoot` runs behind this on the strength of its members
 * alone, and a `failed` one is `startWorkflow`'s own rollback, which wrote
 * every other block off already. Reviving half a graph nobody finished building
 * is the failure the positive test for `started` exists to have none of.
 *
 * **The hold is the other thing that wakes a block.** Lifting it calls
 * `releaseDependents`, so under the hold a block nothing of its own instance
 * will wake is still woken — by a person, which answers the closing-out rule's
 * other premise as well, re-deciding unattended. And the hold keeps a deciding
 * turn unclaimed, so a block that is ready and held is the usual shape a
 * restart finds, and the restart is the usual reason the hold was pressed:
 * closing it out wrote off the very work the operator held the fleet to keep,
 * where the run half keeps a `waiting` run that is ready and held. It is
 * spared only when the restart closed out **none** of its members, read off
 * `restart_closed`: a block behind a run the restart ended is behind a cycle
 * that died with the container, `on-finish` would release it on that, and
 * that is the queued-run rule's case under the hold as without it.
 */
export function bootBlockPlan(
  instances: readonly BootBlockInstance[],
  /** Whether new work is held across the install as this boot runs. */
  newWorkHeld: boolean,
): BootBlockPlan {
  const plan: BootBlockPlan = { abandoned: [], settled: [], spared: [], held: [] };
  for (const instance of instances) {
    if (instance.status !== "started") plan.settled.push(instance.id);
    else if (instance.memberStatuses.some((s) => LIVE_STATUSES.includes(s)))
      plan.spared.push(instance.id);
    else if (newWorkHeld && !instance.restartClosedMember) plan.held.push(instance.id);
    else plan.abandoned.push(instance.id);
  }
  return plan;
}

/**
 * Close out block turns a restart left mid-flight.
 *
 * `reconcileOnBoot`'s rule for a `waiting` run, applied one level up and for the
 * identical reason. A `thinking` block's child died with the process that
 * started it, so the row is a decision that will never arrive. A `waiting` block
 * is waiting on rows this same boot has just failed or stopped, so nothing will
 * ever wake it — and re-deciding unattended, hours later, is spend nobody is
 * present to want, which is the queued-run rule arrived at from the other side.
 *
 * Every `waiting` row of such an instance goes, not only the ones directly
 * behind a `thinking` one, and that is what keeps this consistent with the
 * queued-run rule rather than merely similar to it. A block behind a fan-out
 * whose runs the same boot has just failed could otherwise be released by the
 * next advance — `on-finish` is satisfied by a run that did a cycle and then
 * died with the container — and what that starts is an unattended agent nobody
 * is present to have wanted. Closed out, there is nothing left for a pass to
 * release.
 *
 * **Unless a member survived the same boot**, which is `reconcileOnBoot`'s own
 * exception rather than a second one: a `paused` run inside
 * `settings.resumeGraceHours` is kept, because it is a run the operator started
 * in a mode chosen precisely so it would carry on across a restart, and the
 * sweeper resumes it. Every premise above fails for the blocks behind it —
 * nothing it waits for has been closed out, something *will* wake it, and the
 * agent the next advance starts is the one the operator is already paying for
 * and waiting on. Closing them out anyway wrote off the tail of a live graph
 * and recorded a sentence about the paused run that was not true. So the
 * question is asked per instance, and this pass mirrors that grace rather than
 * overriding it; the block itself is decided later by `planInstanceStep`, off
 * what is actually true when the member settles.
 *
 * **Or unless new work is held and the restart closed out none of its members**,
 * the run half's ready-and-held row one level up: lifting the hold is what
 * wakes it, and `bootBlockPlan` says why that is not the unattended decision
 * the rule above refuses.
 *
 * Ordering makes that readable rather than guessed at: `src/instrumentation.ts`
 * runs `reconcileOnBoot` first, so a run row that is still live here is one that
 * boot decided to keep.
 */
export function reconcileBlocksOnBoot(): void {
  const now = Date.now();
  const thinking = db()
    .prepare(
      "UPDATE workflow_instance_blocks SET status='failed', finished_at=?," +
        " error = CASE kind WHEN 'merge' THEN ? WHEN 'review' THEN ? ELSE ? END," +
        // A turn the restart killed was billed and never reported, so it is
        // counted the way `blockTurnSpend` counts one killed any other way: a
        // deciding block's own child always, and a review block's when a
        // review of its was still unsettled — `driveReviewItem` banks each one
        // only as it lands, and this one never will. A merge's resolution is
        // a queue row's, which `reconcileMergeQueueOnBoot` answers for.
        " cost_unreported = cost_unreported + CASE" +
        " WHEN kind = 'orchestrator' THEN 1" +
        " WHEN kind = 'review' AND EXISTS (SELECT 1 FROM workflow_review_items i" +
        "   JOIN run_reviews rv ON rv.id = i.review_id" +
        "  WHERE i.instance_id = workflow_instance_blocks.instance_id" +
        "    AND i.block_id = workflow_instance_blocks.node_id" +
        "    AND i.status = 'reviewing' AND rv.status <> 'completed') THEN 1" +
        " ELSE 0 END" +
        " WHERE status='thinking'",
    )
    .run(
      now,
      // `reconcileMergeQueueOnBoot` has already cancelled this batch's queued
      // rows and failed whatever was mid-merge, for the reason a queued run is
      // never resumed: a server coming back up must not merge into a checkout
      // somebody works in. So the block really is finished, however far it got.
      "The server restarted while this block was landing branches. Its queued merges were cancelled — check the branches before queueing them again.",
      // A review block's reviews and fix runs are reconciled by their own
      // tables' boot passes; what is lost is the loop driving them, and nothing
      // behind it may land work it had not finished judging — `reviewVerdict`
      // blocks on a failed review block for that reason.
      "The server restarted while this block was reviewing branches, so nothing it had not yet approved was handed on. Review the branches on their run pages, or run the workflow again.",
      "The server restarted while this block was deciding what to start.",
    ).changes;

  // Read after the sweep above, so a block that was deciding counts as the
  // decision that will never arrive rather than as something still to come —
  // and before the `looping` sweep below, which is the other thing it decides,
  // so a loop is still `looping` here.
  // One row per member; instances with neither status are not asked about.
  const rows = db()
    .prepare(
      `SELECT i.id AS id, i.status AS status, r.status AS memberStatus,
              r.restart_closed AS restartClosed
         FROM workflow_instances i
         LEFT JOIN workflow_instance_runs w ON w.instance_id = i.id
         LEFT JOIN runs r ON r.id = w.run_id
        WHERE EXISTS (SELECT 1 FROM workflow_instance_blocks b
                       WHERE b.instance_id = i.id
                         AND b.status IN ('waiting', 'looping'))`,
    )
    .all() as Array<{
    id: string;
    status: WorkflowInstanceStatus;
    memberStatus: RunStatus | null;
    restartClosed: number | null;
  }>;
  const gathered = new Map<
    string,
    {
      status: WorkflowInstanceStatus;
      memberStatuses: RunStatus[];
      restartClosedMember: boolean;
    }
  >();
  for (const row of rows) {
    let entry = gathered.get(row.id);
    if (!entry) {
      entry = { status: row.status, memberStatuses: [], restartClosedMember: false };
      gathered.set(row.id, entry);
    }
    if (row.memberStatus) entry.memberStatuses.push(row.memberStatus);
    if (row.restartClosed) entry.restartClosedMember = true;
  }
  const plan = bootBlockPlan(
    [...gathered].map(([id, entry]) => ({ id, ...entry })),
    newWorkPaused(),
  );
  // Both kinds of survivor are left alone by both sweeps below.
  const kept = [...plan.spared, ...plan.held];

  // A loop is closed out for the queued-run reason rather than the `thinking`
  // one: its passes were failed by the same boot, so another pass would be an
  // unattended agent started hours after anyone asked for it — and `failed`
  // rather than `blocked` because the passes it already took were billed.
  //
  // Both premises are the instance's rather than this row's, so a spared one is
  // spared here for the reason its `waiting` blocks are below: the pass this
  // loop is on is a run the same boot decided to keep, nothing was failed under
  // it, and the pass the next advance would start is the one the operator is
  // already paying for. Left `looping`, `advanceLoops` picks the row up again
  // and `planLoopPass` decides it off that pass when it settles. A held one is
  // spared for its own reason: the restart closed out none of its members, its
  // passes' included, so neither premise holds, and its next step is the lift's.
  const keptClause =
    kept.length === 0
      ? ""
      : ` AND instance_id NOT IN (${kept.map(() => "?").join(",")})`;
  const looping = db()
    .prepare(
      "UPDATE workflow_instance_blocks SET status='failed', finished_at=?," +
        " error='The server restarted while this block was repeating its task, and the pass it was working on was closed out by the same restart.'" +
        " WHERE status='looping'" +
        keptClause,
    )
    .run(now, ...kept).changes;

  const closeOut = (ids: readonly string[], error: string): number => {
    if (ids.length === 0) return 0;
    return db()
      .prepare(
        "UPDATE workflow_instance_blocks SET status='blocked', finished_at=?, error=?" +
          ` WHERE status='waiting' AND instance_id IN (${ids.map(() => "?").join(",")})`,
      )
      .run(now, error, ...ids).changes;
  };
  const waiting =
    closeOut(
      plan.abandoned,
      "The server restarted while this block was waiting for earlier work, and everything this workflow still had in flight was closed out by the same restart.",
    ) +
    closeOut(
      plan.settled,
      "The server restarted while this block was waiting for earlier work, and its workflow was no longer running.",
    );

  if (thinking + waiting + looping > 0) {
    console.warn(
      `[usagefoundry] Closed out ${thinking + waiting + looping} workflow block(s) interrupted by a restart.`,
    );
  }
  if (kept.length > 0) {
    // Every `waiting` and `looping` row left is one of theirs, all three
    // statements above having run — so this is counted rather than carried
    // through the plan.
    const left = db()
      .prepare(
        "SELECT COUNT(*) AS n FROM workflow_instance_blocks" +
          " WHERE status IN ('waiting', 'looping')",
      )
      .get() as { n: number };
    const why = [
      plan.spared.length > 0
        ? `${plan.spared.length} with a run that survived the restart, decided when it settles`
        : null,
      plan.held.length > 0
        ? `${plan.held.length} held with the rest of new work, decided when the hold is lifted`
        : null,
    ].filter(Boolean);
    console.warn(
      `[usagefoundry] Left ${left.n} workflow block(s) waiting or repeating in ` +
        `${kept.length} instance(s): ${why.join("; ")}.`,
    );
  }
}

/**
 * A run's live state for the instance view, or null when the row has gone.
 *
 * `activeIteration` and `startedAt` are here for the reason `fmtCycleInFlight`
 * exists: `iterations` counts cycles that *returned*, so a run tens of minutes
 * into its first one reads `0/N` and `$0.00`, which is bit-for-bit what a run
 * that was marked running and never started reads. On this page that matters
 * more than on the runs list, because a run an orchestrator block started is one
 * nobody clicked Create on and this is the only place it is listed against the
 * decision that made it.
 *
 * The folder is split the same way `/api/runs` splits it — a run a block emitted
 * took its folder from the model's own spec within the block's mount, so where
 * it is working is not derivable from the graph the operator saved.
 */
export function runStateOf(runId: string): {
  status: RunStatus;
  stopReason: string | null;
  iterations: number;
  maxIterations: number;
  validationCycles: number;
  activeIteration: number | null;
  startedAt: number | null;
  mountLabel: string | null;
  relPath: string;
  spentUSD: number | null;
} | null {
  const run = getRun(runId);
  if (!run) return null;
  const { mountLabel, relPath } = describeFolder(run.folder);
  return {
    status: run.status,
    stopReason: run.stop_reason,
    iterations: run.iterations,
    maxIterations: run.max_iterations,
    validationCycles: run.validation_cycles,
    activeIteration: run.active_iteration,
    startedAt: run.started_at,
    mountLabel,
    relPath,
    spentUSD: memberSpendReading(run),
  };
}
