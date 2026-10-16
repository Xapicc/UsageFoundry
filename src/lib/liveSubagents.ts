import type { LiveSubagentDTO, LiveSubagentsDTO } from "./apiTypes";

/**
 * The sub-agents one work cycle has running, folded out of Claude Code's own
 * `stream-json` lines as `handleStreamLine` reads them.
 *
 * **Why this exists rather than reading what is already there.** A live tile
 * had three places a sub-agent could appear and each missed a different set:
 * the open-call strip learns of a call from its first `tool_progress`, 30
 * seconds in, so a foreground delegation is invisible for half a minute and
 * one that answers sooner is never drawn at all; a background one is never on
 * it, because 2.1.280 sends no heartbeat for it and answers its `tool_result`
 * — the launch acknowledgement — within milliseconds, and an `Agent` call that
 * says nothing about the background is backgrounded by default; and the
 * forwarded `subagent` lines scroll out of a 50-event tail that a page opened
 * mid-run cannot rebuild. So the roster is folded here, on the server, from
 * every line of the cycle — the `tool_use` that opens a delegation,
 * `task_started` saying which kind it is, the `tool_result` that ends a
 * foreground one, and the `system:task_*` endings that are the only word that
 * a background one has finished.
 *
 * Pure, and its own module rather than more of `orchestrator.ts`, because
 * every way of being wrong here is silent: a sub-agent that is not on the tile
 * reads as a run that delegated nothing, one that never leaves it reads as a
 * delegation still working, and an inner tool counted as a second sub-agent is
 * a run that looks twice as busy as it is.
 *
 * What it never does is date a start from its own first sighting of a call it
 * did not see begin — `runTasks.ts`'s `startedAt` rule. A duration counted
 * from when this process happened to hear of a sub-agent is a smaller number
 * than the truth, drawn where a measured one would be.
 */

/** One running sub-agent, with the task the CLI filed it under once it says. */
interface Entry extends LiveSubagentDTO {
  taskId: string | null;
}

export interface SubagentFold {
  /** Running sub-agents, keyed on the `Agent` call's own block id. */
  readonly running: ReadonlyMap<string, Entry>;
  /**
   * Every call that has left `running`, so that the second of two statements
   * that it ended — a foreground call's `tool_result` and a later
   * `task_notification` about the same delegation — neither counts it twice
   * nor opens it again.
   */
  readonly ended: ReadonlySet<string>;
  /** Delegations that ended this cycle, a refused launch among them. */
  readonly finished: number;
}

export const NO_SUBAGENTS: SubagentFold = {
  running: new Map(),
  ended: new Set(),
  finished: 0,
};

/**
 * The CLI's names for the delegation tool. `Agent` is what 2.1.280 calls it on
 * the `tool_use` block and on every heartbeat; `Task` is the older spelling,
 * still what `toolProgressReading` is written against, kept so a pin that moves
 * back or a resumed old transcript does not lose its sub-agents.
 */
const DELEGATION_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);

/**
 * The CLI's `task_type` for a backgrounded agent. A `local_bash` task is a
 * backgrounded shell, which is not a sub-agent and is the run page's
 * `RunTasks` panel's to draw.
 */
const AGENT_TASK_TYPE = "local_agent";

/** `runTasks.ts`'s three terminal words, and only those. */
const TERMINAL_STATUS: ReadonlySet<string> = new Set([
  "completed",
  "stopped",
  "killed",
]);

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function rec(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function blocksOf(ev: Record<string, unknown>): Record<string, unknown>[] {
  const content = rec(ev.message)?.content;
  return Array.isArray(content)
    ? content.flatMap((b) => {
        const block = rec(b);
        return block ? [block] : [];
      })
    : [];
}

/** A copy of `state` with `entry` running. */
function withRunning(state: SubagentFold, entry: Entry): SubagentFold {
  const running = new Map(state.running);
  running.set(entry.toolUseId, entry);
  return { ...state, running };
}

/** `id` has stopped running, and is counted once whichever word said so. */
function withEnded(state: SubagentFold, id: string): SubagentFold {
  if (!state.running.has(id)) return state;
  const running = new Map(state.running);
  running.delete(id);
  const ended = new Set(state.ended);
  ended.add(id);
  return { running, ended, finished: state.finished + 1 };
}

/** The running call a task is about, by its own `tool_use_id` or the link. */
function callOfTask(
  state: SubagentFold,
  raw: Record<string, unknown>,
): string | null {
  const own = str(raw.tool_use_id);
  if (own !== null) return own;
  const taskId = str(raw.task_id);
  if (taskId === null) return null;
  for (const entry of state.running.values()) {
    if (entry.taskId === taskId) return entry.toolUseId;
  }
  return null;
}

function onAssistant(
  state: SubagentFold,
  ev: Record<string, unknown>,
  now: number,
): SubagentFold {
  let next = state;
  for (const b of blocksOf(ev)) {
    if (b.type !== "tool_use" || !DELEGATION_TOOLS.has(String(b.name))) continue;
    const id = str(b.id);
    if (id === null || next.running.has(id) || next.ended.has(id)) continue;
    const input = rec(b.input);
    next = withRunning(next, {
      toolUseId: id,
      agentType: str(input?.subagent_type),
      description: str(input?.description),
      // A first guess only, until `task_started` says — see there.
      background: input?.run_in_background === true,
      // The call was seen being made, which is the one start this fold can
      // date for itself: the tool runs from here.
      startedAt: now,
      taskId: null,
    });
  }
  return next;
}

/**
 * A `tool_result` ends a foreground delegation and only acknowledges a
 * background one. The background launch's result comes back at once and says
 * the agent is working, so ending it here would retire every background agent
 * the instant it started — which is the open-call strip's failure this module
 * exists to correct. A launch that came back an error has nothing left to
 * wait for, so it ends here too.
 */
function onUser(state: SubagentFold, ev: Record<string, unknown>): SubagentFold {
  let next = state;
  for (const b of blocksOf(ev)) {
    if (b.type !== "tool_result") continue;
    const id = str(b.tool_use_id);
    const entry = id === null ? undefined : next.running.get(id);
    if (entry === undefined) continue;
    if (entry.background && b.is_error !== true) continue;
    next = withEnded(next, entry.toolUseId);
  }
  return next;
}

/**
 * A heartbeat is never a sub-agent of its own unless it names the delegation
 * tool. The CLI restates every open call, a sub-agent's inner `Bash` among
 * them, and a roster that opened a row per heartbeat it did not recognise
 * would count each of those as one more sub-agent.
 *
 * For a delegation this fold did not see begin, the CLI's own elapsed figure
 * is the start, and with no figure there is no start: see the module's last
 * paragraph.
 */
function onHeartbeat(
  state: SubagentFold,
  ev: Record<string, unknown>,
  now: number,
): SubagentFold {
  const parent = str(ev.parent_tool_use_id) ?? "";
  const own = (str(ev.tool_use_id) ?? "").replace(/-heartbeat-\d+$/, "");
  const id = parent || own;
  if (!id || state.running.has(id) || state.ended.has(id)) return state;
  if (!DELEGATION_TOOLS.has(String(ev.tool_name))) return state;
  const elapsed = Number(ev.elapsed_time_seconds);
  return withRunning(state, {
    toolUseId: id,
    agentType: str(ev.subagent_type),
    description: null,
    background: false,
    startedAt:
      Number.isFinite(elapsed) && elapsed > 0 ? now - elapsed * 1_000 : null,
    taskId: null,
  });
}

/**
 * The CLI filing a delegation as a task, which on 2.1.280 it does for every
 * `Agent` call, foreground or not, a few milliseconds after the `tool_use` and
 * before the `tool_result`.
 *
 * **`is_backgrounded` here is what decides whether the `tool_result` is the
 * end**, never the call's own `run_in_background`. Measured: a call that left
 * the flag out was backgrounded all the same, and its result read "Async agent
 * launched successfully" four milliseconds later — so a fold that trusted the
 * input would have ended the commonest kind of sub-agent at its launch.
 */
function onTaskStarted(
  state: SubagentFold,
  raw: Record<string, unknown>,
  now: number,
): SubagentFold {
  const taskId = str(raw.task_id);
  const id = str(raw.tool_use_id);
  if (taskId === null || id === null || state.ended.has(id)) return state;
  const backgrounded =
    typeof raw.is_backgrounded === "boolean" ? raw.is_backgrounded : null;
  const entry = state.running.get(id);
  if (entry !== undefined) {
    if (entry.taskId === taskId) return state;
    return withRunning(state, {
      ...entry,
      agentType: entry.agentType ?? str(raw.subagent_type),
      description: entry.description ?? str(raw.description),
      background: backgrounded ?? entry.background,
      startedAt: entry.startedAt ?? now,
      taskId,
    });
  }
  if (raw.task_type !== AGENT_TASK_TYPE) return state;
  return withRunning(state, {
    toolUseId: id,
    agentType: str(raw.subagent_type),
    description: str(raw.description),
    // Before `is_backgrounded` existed only a backgrounded agent was a task.
    background: backgrounded ?? true,
    // `task_started` is the CLI saying the task begins now — the one other
    // start this fold may date for itself.
    startedAt: now,
    taskId,
  });
}

function onTaskUpdated(
  state: SubagentFold,
  raw: Record<string, unknown>,
): SubagentFold {
  const id = callOfTask(state, raw);
  const entry = id === null ? undefined : state.running.get(id);
  const patch = rec(raw.patch);
  if (entry === undefined || patch === null) return state;
  const word = str(patch.status);
  if ((word !== null && TERMINAL_STATUS.has(word)) || typeof patch.end_time === "number") {
    return withEnded(state, entry.toolUseId);
  }
  if (typeof patch.is_backgrounded === "boolean" && patch.is_backgrounded !== entry.background) {
    return withRunning(state, { ...entry, background: patch.is_backgrounded });
  }
  return state;
}

function onSystem(
  state: SubagentFold,
  ev: Record<string, unknown>,
  now: number,
): SubagentFold {
  switch (ev.subtype) {
    case "task_started":
      return onTaskStarted(state, ev, now);
    case "task_updated":
      return onTaskUpdated(state, ev);
    case "task_notification": {
      const id = callOfTask(state, ev);
      return id === null ? state : withEnded(state, id);
    }
    default:
      return state;
  }
}

/**
 * One stream line folded in. Returns `state` itself when the line changed
 * nothing, which is how the caller knows there is nothing to publish — most
 * lines of a cycle are not about a sub-agent.
 */
export function foldSubagentEvent(
  state: SubagentFold,
  ev: Record<string, unknown>,
  now: number,
): SubagentFold {
  switch (ev.type) {
    case "assistant":
      return onAssistant(state, ev, now);
    case "user":
      return onUser(state, ev);
    case "tool_progress":
      return onHeartbeat(state, ev, now);
    case "system":
      return onSystem(state, ev, now);
    default:
      return state;
  }
}

/**
 * What a tile draws: the running ones longest-running first, an undated one
 * after every dated one, and how many have finished.
 */
export function subagentSummary(state: SubagentFold): LiveSubagentsDTO {
  const running = [...state.running.values()]
    .map(({ taskId: _taskId, ...dto }) => dto)
    .sort((a, b) =>
      a.startedAt === null || b.startedAt === null
        ? Number(a.startedAt === null) - Number(b.startedAt === null)
        : a.startedAt - b.startedAt,
    );
  return { running, finished: state.finished };
}
