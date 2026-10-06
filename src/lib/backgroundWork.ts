/**
 * What a work cycle does with the background tasks it starts.
 *
 * Two decisions live here and neither can fail loudly. Claude Code in `-p` mode
 * keeps its process alive after the agent ends its turn for as long as a
 * background sub-agent is running, and kills the lot when its own wait ceiling
 * passes; this module sets that ceiling for a run's children, and tells the next
 * cycle when something was killed anyway. Get the first wrong and a cycle either
 * outlives a limit the operator set or loses work that was nearly done; get the
 * second wrong and an agent resumes into a conversation that still believes its
 * sub-agents are working, waits on them, and spends a cycle on nothing — which is
 * what run `350ef202` did, at $24.45.
 *
 * Pure, and free of node builtins, for `runTasks.ts`'s reason and so the tests
 * can run the decisions without a database or a child process.
 */

import type { RunEventDTO } from "./apiTypes";
import { workedMs } from "./budget";
import { runTasks, type RunTask } from "./runTasks";

/**
 * The CLI's own name for the wait, read out of the pinned 2.1.280 binary and
 * measured against it (`docs/verification/run-lifecycle-background-work.md`): milliseconds, and
 * `0` is unbounded. It is the CLI's internal name, so a pin bump re-checks it.
 */
export const BACKGROUND_WAIT_ENV = "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS";

/**
 * The shortest ceiling this app will ask for. Never `0`, which is the CLI's
 * spelling of "no ceiling": a run with a time limit and a rounding error in its
 * remainder must not turn into one that waits for ever. A second is also the
 * least that lets the CLI finish the turn it was in before it starts killing.
 */
const MIN_CEILING_MS = 1_000;

/**
 * The server's own value for the variable, or null when there is none. Blank is
 * unset, `contextShapingEnv`'s rule and for its reason: compose renders an
 * unset optional variable as the empty string, and the CLI reads an empty one as
 * its own 600-second default, so a blank must not shadow the rule below.
 */
export function operatorBackgroundWait(
  env: Record<string, string | undefined>,
): string | null {
  const value = env[BACKGROUND_WAIT_ENV];
  return value === undefined || value.trim() === "" ? null : value;
}

export type BackgroundWaitSource = "operator" | "duration" | "unbounded";

/**
 * How long the child of a work cycle may wait, after its agent ends its turn, for
 * the background sub-agents it started — as the value for `BACKGROUND_WAIT_ENV`,
 * or `null` to leave the child's own environment alone.
 *
 * **The CLI's default is 600 seconds, and it was costing work rather than
 * guarding anything.** Run `350ef202` started four sub-agents, ended its turn,
 * and had them killed at ten minutes with 210k–250k tokens each spent and
 * nothing written down. Nothing the operator configured asked for that bound.
 * What does have to bound the wait is the guards the operator *did* set, and
 * which of them still bind while the CLI sits idle is not the same as which are
 * configured:
 *
 *  - `maxDurationMinutes` does not, under `between-cycles`: it is read before a
 *    cycle starts, so with the ceiling unbounded a cycle could outlive it by as
 *    long as its sub-agents run. It is the one this function exists to carry,
 *    which is why the ceiling is what is *left* of it.
 *  - `--max-budget-usd` does, measured: the CLI checks sub-agent spend while it
 *    waits, stops them at the cap and ends the cycle.
 *  - the cycle-silence deadline does, for a wait in which nothing is printed.
 *  - the 5-hour and weekly windows and `maxRunTokens` do not under
 *    `between-cycles`, which is that mode's documented overshoot of one cycle,
 *    and a foreground `Task` call overshoots them the same way.
 *
 * So: the operator's own value when the server has one (reported, never
 * overridden — `contextShapingEnv`'s ground: it is their configuration to
 * make); otherwise what remains of the run's time limit, measured on the same
 * clock the guard reads (`workedMs`); otherwise `0`, because with no time limit
 * there is nothing for a number to be derived from and the deadline on silence
 * already ends a cycle that has hung.
 *
 * What this does not do, and cannot from a value fixed at spawn: the CLI's clock
 * restarts each time a finished sub-agent wakes the agent and it goes idle
 * again, so a cycle that keeps being woken can run past the remainder. That is
 * ordinary work, not a wait, and is bounded by the same things a foreground
 * cycle is.
 */
export function backgroundWaitCeiling(o: {
  operatorValue: string | null;
  maxDurationMinutes: number | null;
  startedAt: number | null;
  pausedMs: number;
  now: number;
}): { value: string | null; source: BackgroundWaitSource } {
  if (o.operatorValue !== null) return { value: null, source: "operator" };

  const limit = o.maxDurationMinutes;
  if (limit === null || !Number.isFinite(limit)) {
    return { value: "0", source: "unbounded" };
  }
  const remainingMs = limit * 60_000 - workedMs(o.startedAt, o.pausedMs, o.now);
  const ceilingMs = Math.min(
    Math.max(MIN_CEILING_MS, Math.ceil(remainingMs)),
    Number.MAX_SAFE_INTEGER,
  );
  return { value: String(ceilingMs), source: "duration" };
}

/**
 * How many stopped tasks the note names before it says "and N more". A cycle
 * that fanned out forty background shells would otherwise put forty lines at the
 * top of the next turn, and the agent needs to know *that* work was lost and
 * where to look, not to be handed an inventory.
 */
export const MAX_LISTED_TASKS = 12;

/**
 * Longest description kept on a line. Model-authored text has no bound. The
 * output path is not put through this: it is the CLI's, and clipped or with its
 * whitespace folded it names a file that does not exist.
 */
const MAX_FIELD_CHARS = 200;

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_FIELD_CHARS
    ? flat
    : `${flat.slice(0, MAX_FIELD_CHARS - 1)}…`;
}

/**
 * The CLI's own `task_type`, in the words the agent used for the thing. An
 * unrecognised type is passed through rather than flattened to "task": it is
 * the one clue to what ran that this app has.
 */
function kindOf(task: RunTask): string {
  if (task.taskType === "local_agent") return "sub-agent";
  if (task.taskType === "local_bash") return "shell command";
  return task.taskType ?? "task";
}

function lineFor(task: RunTask): string {
  const label = oneLine(task.description ?? task.summary ?? task.id);
  const where = task.outputFile
    ? `partial output: ${task.outputFile}`
    : "it wrote no output file";
  return `- ${kindOf(task)} "${label}" — ${where}`;
}

/**
 * The note a cycle opens with when the cycle before it ended with background
 * tasks stopped, or null when there is nothing to say.
 *
 * `events` are the previous cycle's, and the caller owns that boundary: this
 * reads whatever it is handed, so a task from three cycles ago would be
 * reported again by a caller that passed the whole run.
 *
 * **Only tasks the CLI reported ending as `killed` or `stopped`.** A task still
 * `running` when the log stops is not named, though a child that is gone cannot
 * be running one: `runTasks` is explicit that a finished task simply leaves the
 * CLI's snapshot, so "no ending seen" is also what a task that completed
 * quietly looks like, and a note telling an agent that finished work was lost
 * would send it to redo it. The cost of that choice is a cycle that was
 * hard-killed mid-wait, which says nothing; it is the lesser error. `ended`, a
 * terminal word this app has not read, is left out for the same reason.
 *
 * The wording is true whoever stopped the task. An agent that stopped one of
 * its own on purpose is told about it too, and the last sentence says that is
 * ignorable; telling it nothing about a task the CLI killed at its ceiling is
 * the failure this exists for, and distinguishing the two would mean this app
 * guessing which instant the main turn ended.
 */
export function stoppedTasksNotice(
  events: readonly RunEventDTO[],
): string | null {
  const stopped = runTasks(events).filter(
    (task) => task.state === "killed" || task.state === "stopped",
  );
  if (stopped.length === 0) return null;

  const lines = stopped.slice(0, MAX_LISTED_TASKS).map(lineFor);
  const more = stopped.length - MAX_LISTED_TASKS;
  if (more > 0) lines.push(`- and ${more} more`);

  return [
    "Background tasks from the previous work cycle were stopped before it ended. " +
      "They are not running and will not report back, so do not wait for them:",
    lines.join("\n"),
    "Read the output files for whatever they wrote before they stopped. A " +
      "background task lives only as long as the work cycle that started it, and " +
      "a cycle does not wait for its sub-agents for ever. If you still need what one of them was doing, do it in the " +
      "foreground, or wait for it within this turn, and commit what you have " +
      "before you end your turn. If you stopped one of these yourself, ignore " +
      "this for that one.",
  ].join("\n\n");
}
