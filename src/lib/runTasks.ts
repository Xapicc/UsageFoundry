/**
 * The background tasks a run started, read back out of the run's own log.
 *
 * Claude Code reports a backgrounded shell or agent through `system` events, and
 * `orchestrator.ts` already stores every one of them as a `log` event whose
 * message is `system:<subtype>` and whose `raw` is the CLI's whole event. Nothing
 * showed them: `logLine.ts` drops every `system:`-prefixed line from the feed on
 * purpose, so the task lifecycle was on every run's log and invisible on it at
 * the same time. This is the reader for those rows — the drop stays where it is,
 * because the feed is a transcript of the agent's turns and a task's five state
 * changes are a panel, not five more lines to scroll past.
 *
 * Derived here rather than recorded by the orchestrator for the reason
 * `cycles.ts` gives: the events are already on disk, so this reads a run that
 * finished before the panel existed.
 *
 * Pure and client-safe — no node builtins, and nothing imported but
 * `apiTypes.ts` — because it runs in the browser over the replayed event stream
 * and because `src/lib` is what `tsconfig.test.json` compiles.
 *
 * **Only backgrounded work is a row.** Claude Code 2.1.280 files every `Agent`
 * call as a task (`task_type: "local_agent"`), foreground ones too, and says in
 * `task_started` which kind it is through `is_backgrounded`. A task that says
 * `false` and is never later said to be in the background is left out of the
 * result: a foreground delegation is a turn of the run's own, already in the log
 * as `subagent` events and on `/runs/live`'s roster, and the panel above the log
 * is "what the run backgrounded". It is also what the next cycle is told about —
 * `stoppedTasksNotice` reduces with this function, and a cycle stopped inside a
 * foreground delegation measured `task_updated` `killed` and `task_notification`
 * `stopped` for it, which would have reached the agent as a stopped *background*
 * task when its own conversation records the call as interrupted. A task whose
 * kind was never stated — a pin older than `is_backgrounded`, or one the page
 * only met through a snapshot or an ending — stays, because dropping a live
 * backgrounded shell is the worse error.
 */

import type { RunEventDTO } from "./apiTypes";

/**
 * What the events said became of a task, and never what the run's own ending
 * implies about it.
 *
 * `ended` is the honest answer for a task the CLI reported finished in a word
 * this app has not seen: the outcome is terminal, the word is in `statusWord`,
 * and inventing a tone for it would be a claim about a status nobody here has
 * read. `running` means no ending was reported — on a run that is over, that is
 * a task whose ending never reached the log, which is a different fact from
 * "still running" and is why the panel says when the run has stopped.
 */
export type RunTaskState =
  | "running"
  | "completed"
  | "stopped"
  | "killed"
  | "ended";

export interface RunTask {
  /** The CLI's `task_id`. Stable across every event about the task. */
  id: string;
  description: string | null;
  /**
   * The CLI's own word for the kind of task — `local_bash` for a backgrounded
   * shell, `local_agent` for a backgrounded agent. An open set, kept verbatim:
   * a name this app has not seen is still the operator's best clue about what
   * ran, and a lookup table that fell back to "task" would hide it.
   */
  taskType: string | null;
  /** The tool call the task came from, for matching against the log below. */
  toolUseId: string | null;
  /**
   * When `task_started` arrived — null for a task recovered from a snapshot,
   * whose start this page never saw. Null is never filled with the first
   * sighting: a duration measured from when the browser joined is a smaller
   * number than the truth, presented in the same place as a measured one.
   */
  startedAt: number | null;
  /**
   * `patch.end_time` when the CLI stated one, otherwise when the terminal
   * notification arrived. Null on a task that never ended, and on one whose
   * ending carried no instant.
   */
  endedAt: number | null;
  state: RunTaskState;
  /** The CLI's own status word, when it said one. */
  statusWord: string | null;
  /** The notification's own account of the outcome. */
  summary: string | null;
  /**
   * Where the task's output was written, on the agent's filesystem. Never the
   * empty string: the CLI sends `""` for a task that wrote no file, and an
   * empty path rendered as a path is a file that does not exist.
   */
  outputFile: string | null;
  /**
   * The CLI said so through `is_backgrounded`, on `task_started` or in a patch.
   * False also for a task whose kind nothing stated.
   */
  backgrounded: boolean;
}

/**
 * The status words this app has read, and what each means for the row.
 *
 * `completed` and `stopped` are what `task_notification` sends; `killed` is what
 * `task_updated` patches in. All three are endings, and a word outside this map
 * ends a task only when something else says it ended — an `end_time` or a
 * notification — so an unrecognised in-flight status cannot retire a live task.
 */
const TERMINAL_STATUS: Record<string, RunTaskState> = {
  completed: "completed",
  stopped: "stopped",
  killed: "killed",
};

const SYSTEM_PREFIX = "system:";

/**
 * The stored `message` of every event `runTasks` reads, so a caller selecting
 * rows out of the database asks for these and not for the cycle's thousands of
 * others. Kept beside the `switch` below: a subtype added there and not here
 * is a reader that quietly never sees it.
 */
export const TASK_LIFECYCLE_MESSAGES = [
  "task_started",
  "background_tasks_changed",
  "task_updated",
  "task_notification",
].map((subtype) => `${SYSTEM_PREFIX}${subtype}`);

interface Draft extends RunTask {
  /** The first event mentioning this task, which is the list's order. */
  firstSeenAt: number;
  /** Event ts behind `statusWord`, so a later word replaces an earlier one. */
  statusSeenAt: number;
  /** Event ts behind `backgrounded`, for the same reason. */
  backgroundedSeenAt: number;
  /**
   * A live-tasks snapshot named it. The CLI sends that snapshot for background
   * tasks only, so a listing is the word that a task started in the foreground
   * has since been backgrounded, whatever order the events land in.
   */
  listed: boolean;
  /**
   * A `task_notification` arrived. Terminal on its own, whatever word it
   * carried and whether or not anything stated an instant.
   */
  notified: boolean;
}

/** A non-empty string, or nothing. Blank and absent are the same fact here. */
function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rec(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function draftFor(
  drafts: Map<string, Draft>,
  id: string,
  ts: number,
): Draft {
  const found = drafts.get(id);
  if (found) {
    // The earliest sighting keeps the row's place, so a replay that delivers
    // one task's events late does not shuffle the list under the reader.
    if (ts < found.firstSeenAt) found.firstSeenAt = ts;
    return found;
  }
  const draft: Draft = {
    id,
    description: null,
    taskType: null,
    toolUseId: null,
    startedAt: null,
    endedAt: null,
    state: "running",
    statusWord: null,
    summary: null,
    outputFile: null,
    backgrounded: false,
    firstSeenAt: ts,
    statusSeenAt: Number.NEGATIVE_INFINITY,
    backgroundedSeenAt: Number.NEGATIVE_INFINITY,
    listed: false,
    notified: false,
  };
  drafts.set(id, draft);
  return draft;
}

/** The latest statement wins, by arrival, so a replay in any order lands alike. */
function noteBackgrounded(draft: Draft, stated: unknown, ts: number): void {
  if (typeof stated !== "boolean" || ts < draft.backgroundedSeenAt) return;
  draft.backgrounded = stated;
  draft.backgroundedSeenAt = ts;
}

/** Stated foreground and never said otherwise; see the module header. */
function isForeground(draft: Draft): boolean {
  return (
    draft.backgroundedSeenAt !== Number.NEGATIVE_INFINITY &&
    !draft.backgrounded &&
    !draft.listed
  );
}

/** The word wins if it is terminal; otherwise an ending must come from elsewhere. */
function stateOf(draft: Draft): RunTaskState {
  const known = draft.statusWord ? TERMINAL_STATUS[draft.statusWord] : undefined;
  if (known) return known;
  if (draft.notified || draft.endedAt !== null) return "ended";
  return "running";
}

function toRow(draft: Draft): RunTask {
  const {
    firstSeenAt: _firstSeenAt,
    statusSeenAt: _statusSeenAt,
    backgroundedSeenAt: _backgroundedSeenAt,
    listed: _listed,
    notified: _notified,
    ...row
  } = draft;
  return { ...row, state: stateOf(draft) };
}

/**
 * Every background task this run's events mention, in the order they were first
 * seen. Nothing is dropped once it has been seen but a task the CLI stated was
 * in the foreground, and no row is ever ended by this app's own reasoning — only
 * by something the CLI said.
 */
export function runTasks(events: readonly RunEventDTO[]): RunTask[] {
  const drafts = new Map<string, Draft>();

  for (const event of events) {
    if (event.kind !== "log") continue;
    const message = event.payload?.message;
    if (typeof message !== "string" || !message.startsWith(SYSTEM_PREFIX)) {
      continue;
    }
    const raw = rec(event.payload?.raw);
    if (!raw) continue;

    switch (message.slice(SYSTEM_PREFIX.length)) {
      case "task_started": {
        const id = str(raw.task_id);
        if (!id) break;
        const draft = draftFor(drafts, id, event.ts);
        draft.description ??= str(raw.description);
        draft.taskType ??= str(raw.task_type);
        draft.toolUseId ??= str(raw.tool_use_id);
        noteBackgrounded(draft, raw.is_backgrounded, event.ts);
        // The event's arrival, because the CLI states no start instant here —
        // and the earliest of them, so a duplicate cannot shorten the run.
        draft.startedAt =
          draft.startedAt === null
            ? event.ts
            : Math.min(draft.startedAt, event.ts);
        break;
      }

      case "background_tasks_changed": {
        // A full snapshot of what is *still live*, read for one thing only:
        // recovering a task whose `task_started` never reached this page. A
        // task that has finished leaves the list, so a task missing from a
        // later snapshot has not been shown to have ended and nothing here
        // may retire it — absence is how success looks.
        const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
        for (const entry of tasks) {
          const task = rec(entry);
          if (!task) continue;
          const id = str(task.task_id);
          if (!id) continue;
          const draft = draftFor(drafts, id, event.ts);
          draft.description ??= str(task.description);
          draft.taskType ??= str(task.task_type);
          draft.listed = true;
        }
        break;
      }

      case "task_updated": {
        const id = str(raw.task_id);
        if (!id) break;
        // Opened before the patch is read: the event names a task, which is
        // enough to know the task exists even if it patches nothing this app
        // understands.
        const draft = draftFor(drafts, id, event.ts);
        // An open set. Every key this app knows is applied and the rest are
        // left alone, so a CLI that adds one is a field this panel does not
        // show rather than a row it gets wrong.
        const patch = rec(raw.patch);
        if (!patch) break;

        noteBackgrounded(draft, patch.is_backgrounded, event.ts);

        const word = str(patch.status);
        if (word && event.ts >= draft.statusSeenAt) {
          draft.statusWord = word;
          draft.statusSeenAt = event.ts;
        }

        // The CLI's own instant, which always beats an arrival time.
        const endTime = num(patch.end_time);
        if (endTime !== null) draft.endedAt = endTime;
        break;
      }

      case "task_notification": {
        const id = str(raw.task_id);
        if (!id) break;
        const draft = draftFor(drafts, id, event.ts);
        // Terminal whatever it says and whenever it arrives, so an out-of-order
        // update cannot put a finished task back on the live list.
        draft.notified = true;
        draft.toolUseId ??= str(raw.tool_use_id);

        // One message, so its three fields land together or not at all: a
        // summary kept from a superseded notification would describe an
        // outcome the badge beside it no longer claims.
        const word = str(raw.status);
        if (event.ts >= draft.statusSeenAt) {
          draft.statusSeenAt = event.ts;
          if (word) draft.statusWord = word;
          draft.summary = str(raw.summary);
          draft.outputFile = str(raw.output_file);
        }

        // Only when nothing stated a real one — see `endedAt`.
        draft.endedAt ??= event.ts;
        break;
      }

      // Every other `system:` subtype, and `task_progress` deliberately.
      //
      // It is progress and not state: 2.1.280 sends one for each tool call a
      // sub-agent makes, carrying the `task_id` and `tool_use_id` of a task
      // `task_started` has already opened and no `task_type`, no `status` and no
      // `is_backgrounded`. A row opened from one would admit a task whose kind
      // this reducer cannot tell — a foreground delegation as readily as a
      // backgrounded one, which is the scope the header draws — and nothing is
      // lost by ignoring it, because a task that was backgrounded still arrives
      // as `task_started` and progress is not state.
      default:
        break;
    }
  }

  return [...drafts.values()]
    .filter((draft) => !isForeground(draft))
    .sort((a, b) => a.firstSeenAt - b.firstSeenAt)
    .map(toRow);
}
