import type {
  WorkflowDTO,
  WorkflowInstanceBlockDTO,
  WorkflowInstanceDTO,
  WorkflowInstanceNodeDTO,
  WorkflowInstanceWaitDTO,
  WorkflowListItemDTO,
  WorkflowScheduleDTO,
} from "../../../lib/apiTypes";
import { getSchedule, scheduleView, type ScheduleView } from "../../../lib/schedules";
import { passMemberIn } from "../../../lib/passIds";
import { isDependencyEdge, type WorkflowEdge } from "../../../lib/workflowGraph";
import {
  blockSpendReading,
  lastRunAt,
  liveBlocksOf,
  liveInstanceIdOf,
  liveRunsOf,
  pickUpsOf,
  reviewItemsOf,
  runStateOf,
  type Workflow,
  type WorkflowInstance,
} from "../../../lib/workflows";

/**
 * The wire shapes, in one place so the five routes cannot disagree about them.
 *
 * The same job `src/app/api/chat/dto.ts` does, and shaped the same way: the
 * server types carry a nested `graph`, the DTO flattens it, and the client
 * never imports a module that opens SQLite.
 */

export function scheduleDTO(view: ScheduleView): WorkflowScheduleDTO {
  return {
    spec: view.spec,
    timeZone: view.timeZone,
    paused: view.paused,
    description: view.description,
    nextFireAt: view.nextFireAt,
    lastCode: view.lastCode,
    lastReason: view.lastReason,
    lastAt: view.lastAt,
    lastFireAt: view.lastFireAt,
    lastInstanceId: view.lastInstanceId,
    streak: view.streak,
    streakSince: view.streakSince,
    refusal: view.refusal,
  };
}

export function workflowDTO(workflow: Workflow): WorkflowDTO {
  const schedule = getSchedule(workflow.id);
  return {
    id: workflow.id,
    name: workflow.name,
    nodes: workflow.graph.nodes,
    edges: workflow.graph.edges,
    instanceBudget: workflow.instanceBudget,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    liveRunCount: liveRunsOf(workflow.id).length + liveBlocksOf(workflow.id),
    liveInstanceId: liveInstanceIdOf(workflow.id),
    lastRunAt: lastRunAt(workflow.id),
    schedule: schedule ? scheduleDTO(scheduleView(schedule, workflow)) : null,
  };
}

/**
 * The same workflow without its graph, for the two readers that only count it.
 *
 * A second, narrower shape beside `workflowDTO` rather than a weakening of it —
 * `WorkflowListItemDTO` argues that out, and the detail route, the editor and
 * the duplicate route all still need the whole graph. Derived from `workflowDTO`
 * rather than restated so the fields the two shapes share cannot drift apart:
 * what this drops is the graph and the instance budget, and nothing else.
 */
export function workflowListDTO(workflow: Workflow): WorkflowListItemDTO {
  const {
    nodes,
    edges: _edges,
    instanceBudget: _instanceBudget,
    ...rest
  } = workflowDTO(workflow);
  return { ...rest, nodeCount: nodes.length };
}

/**
 * What each member of an instance starts after, and on what condition, read off
 * the graph the instance was started from.
 *
 * Pure and exported for the reason `instanceStatus` is: the condition is the
 * half of an edge that decides whether the member starts at all, and a wait that
 * kept the name and dropped the condition reads as "after Build" where the
 * truth is "after Build, but only if it completes" — nothing throws, and the
 * page looks right. The condition is carried as the edge states it and is never
 * re-derived: whether it is *met* stays `edgeSatisfied`'s, in the run loop.
 *
 * `edge` is null on a wait that has no edge behind it — a run an orchestrator
 * block decided on, or the entry of a pass, which the loop created. Those wait
 * for the block that made them to decide, which is a fact about who created the
 * member and not a condition anyone saved, so no condition is claimed for it.
 */
export function instanceWaiter(graph: {
  nodes: ReadonlyArray<{ id: string; kind: string }>;
  edges: ReadonlyArray<WorkflowEdge>;
}): (nodeId: string, createdBy: string | null) => WorkflowInstanceWaitDTO[] {
  const waits = new Map<string, WorkflowInstanceWaitDTO[]>();
  for (const edge of graph.edges) {
    // A `repeats` link names the loop a block is *inside*, which is not
    // something it waits for: the loop creates it, once per pass.
    if (!isDependencyEdge(edge)) continue;
    const entry = { nodeId: edge.from, edge: edge.edge };
    const list = waits.get(edge.to);
    if (list) list.push(entry);
    else waits.set(edge.to, [entry]);
  }

  /**
   * What one row waited for, as node ids the name map can resolve.
   *
   * A pass's member is keyed on an id that names the pass, so the graph's own
   * edges miss it — and a section may fan out now, so "waits for the loop" is
   * no longer even nearly right: a member of a section that forks waits for its
   * own predecessors *within its pass*, which is the thing an operator reading
   * a stalled pass needs. Resolved through the block the member is of, so the
   * names shown are the section's own; the pass is already on the row's name.
   *
   * The section's entry is the one member with no predecessor inside it, and it
   * falls back to whatever created it — the loop for a member, the block for a
   * run an orchestrator emitted.
   */
  return (nodeId, createdBy) => {
    const member = passMemberIn(graph, nodeId);
    const own = waits.get(member?.bodyNodeId ?? nodeId) ?? [];
    if (own.length > 0) return own;
    return createdBy ? [{ nodeId: createdBy, edge: null }] : [];
  };
}

export function instanceDTO(instance: WorkflowInstance): WorkflowInstanceDTO {
  // Read off the instance's own graph snapshot, not the live workflow: the
  // blocks may have been renamed or rewired since, and this is a record of what
  // ran.
  const waitsForRow = instanceWaiter(instance.graph);

  const nodes: WorkflowInstanceNodeDTO[] = instance.nodes.map((n) => ({
    nodeId: n.nodeId,
    nodeName: n.nodeName,
    position: n.position,
    runId: n.runId,
    run: runStateOf(n.runId),
    // A run an orchestrator block emitted is in no edge of the saved graph — it
    // did not exist when the graph was written — so what it waits for is read
    // off the block that started it instead.
    waitsFor: waitsForRow(n.nodeId, n.emittedBy),
    emittedBy: n.emittedBy,
    // Read here rather than on the page, because the member id's format is
    // `passMemberId`'s and a second parser of it is how a three-pass loop over
    // a two-block section comes to be drawn as six passes. `passMemberIn` is
    // the one reader, and it lives beside the writer.
    passMember: passMemberIn(instance.graph, n.nodeId),
    leftBehind: !!n.leftBehindAt,
  }));

  const blocks: WorkflowInstanceBlockDTO[] = instance.blocks.map((b) => {
    const snapshot = instance.graph.nodes.find((n) => n.id === b.nodeId);
    return {
      nodeId: b.nodeId,
      nodeName: b.nodeName,
      position: b.position,
      kind: b.kind,
      status: b.status,
      startedAt: b.startedAt,
      finishedAt: b.finishedAt,
      costUSD: blockSpendReading(b),
      costUnknown: b.costUnknown,
      emitted: b.emitted,
      started: b.started,
      decided: b.decided,
      reply: b.reply,
      notes: b.notes,
      branchesLanded: b.branchesLanded,
      branchesFailed: b.branchesFailed,
      // Read here rather than carried on the block row, because it is a table
      // of its own and only a review block has rows in it.
      reviewItems:
        b.kind === "review"
          ? reviewItemsOf(instance.id, b.nodeId).map((i) => ({
              originRunId: i.origin_run_id,
              runId: i.run_id,
              status: i.status,
              round: i.round,
              note: i.note,
              reviewId: i.review_id,
            }))
          : [],
      error: b.error,
      // A block can be a member of a pass too, now that a loop repeats a section
      // rather than a task: an orchestrator member and the merge block every
      // section ends at are ledger rows, not runs. The loop is what created it
      // when it is the section's entry.
      waitsFor: waitsForRow(b.nodeId, passMemberIn(instance.graph, b.nodeId)?.loopNodeId ?? null),
      // Off the instance's own graph snapshot, so a pass that already ran keeps
      // the order it ran in however the workflow has been rewired since.
      bodyNodeIds: snapshot?.bodyNodeIds ?? [],
      maxPasses: snapshot?.kind === "loop" ? snapshot.maxPasses : null,
      maxLoopCostUSD: snapshot?.kind === "loop" ? snapshot.maxLoopCostUSD : null,
      passMember: passMemberIn(instance.graph, b.nodeId),
    };
  });

  return {
    id: instance.id,
    workflowId: instance.workflowId,
    workflowName: instance.workflowName,
    createdAt: instance.createdAt,
    status: instance.status,
    error: instance.error,
    stoppedAt: instance.stoppedAt,
    stopCause: instance.stopCause,
    stopReason: instance.stopReason,
    liveRunCount: instance.liveRunCount,
    blockedCount: instance.blockedCount,
    instanceBudget: instance.instanceBudget,
    spentUSD: instance.spend.spentUSD,
    spentGuardUSD: instance.spend.spentGuardUSD,
    spentUnmeasured: instance.spend.unmeasured,
    spentSubjects: instance.spend.subjects,
    nodes,
    blocks,
    pickUps: pickUpsOf(instance),
  };
}
