import { db } from "./db";
import { diffAsText, wholeCommitDiff } from "./diff";
import { git } from "./git";
import { RUN_TRAILER, TASK_TRAILER } from "./runTrailers";

/**
 * Work for a task that is already in a branch's history, found by the server.
 *
 * ## The case
 *
 * The validator judges a run from its branch's diff, and an empty diff against
 * a task that required a change reads as `not-finished`. A task whose fix
 * reached the branch another way — through the target it was updated from, or
 * because the run branched after the fix landed — leaves exactly that empty
 * diff, so "already done by someone else" and "did nothing" were the same
 * evidence (board task `17be140e`).
 *
 * ## What counts as evidence, and why the run's word is not in it
 *
 * A commit is evidence only if **the server wrote a trailer on it naming this
 * task and a run**, and **that run is one this install recorded as started for
 * this task**. Both halves are the server's: `stampBranchCommits` writes
 * `UF-Run` and `UF-Task` after the agent's process has exited, and `run_tasks`
 * is the table the board reads. A commit message that merely *mentions* the
 * task id is text another agent wrote and is not read, and neither is a commit
 * the judged run named in its final message.
 *
 * What a trailer says is "a run started for this task made this commit" and
 * nothing more: a run holding two tasks stamps both ids on every commit, so
 * this proves a commit exists, never that the task's deliverable is in it. The
 * judge is the one who reads the commits against the task; this only finds
 * them, and the wording that frames them says so.
 *
 * ## Every failure is "no evidence"
 *
 * A log that cannot be read, a commit whose diff cannot be read, a run row that
 * retention has since removed: each leaves the judge with the empty diff it
 * always had. Nothing here can close a task, and nothing here can hold one open
 * that would have closed.
 */

/** Commits the log is searched through, newest first. */
const SCAN_COMMITS = 40;

/** Commits shown to the judge. The oldest of a longer list is the one dropped. */
export const HISTORY_COMMITS_SHOWN = 5;

export interface HistoryCommit {
  sha: string;
  subject: string;
}

/** What the judge is shown beside an empty branch diff. */
export interface AlreadyDelivered {
  commits: HistoryCommit[];
  /** Each commit's heading, its diffstat and as much of its patch as the budget allowed. */
  text: string;
  /** True when a patch, or a whole commit, was left out of `text` for size. */
  truncated: boolean;
}

const FIELD = "\x1f";
const RECORD = "\x1e";

const LOG_FORMAT = [
  "%H",
  "%s",
  `%(trailers:key=${RUN_TRAILER},valueonly,separator=%x2C)`,
  `%(trailers:key=${TASK_TRAILER},valueonly,separator=%x2C)`,
].join("%x1f") + "%x1e";

/**
 * The commits in `git log --format=LOG_FORMAT` output that name `taskId`.
 *
 * Pure. `runStartedFor` is the install's record of which run was started for
 * which task, passed in so that the rule below can be tested without a
 * database: a commit counts only when it carries exactly one `UF-Run`, that run
 * is not `runId`, and `runStartedFor` says it was started for `taskId`. Exactly
 * one, because a second `UF-Run` line is a commit whose message was written by
 * something other than the stamp.
 *
 * The run being judged is left out because its own commits are already in the
 * diff it is judged by, and an empty diff means it has none that last.
 */
export function taskCommitsIn(
  raw: string,
  o: { taskId: string; runId: string; runStartedFor: (runId: string) => boolean },
): HistoryCommit[] {
  const out: HistoryCommit[] = [];
  for (const record of raw.split(RECORD)) {
    const fields = record.replace(/^\n/, "").split(FIELD);
    if (fields.length !== 4) continue;
    const [sha, subject, runs, tasks] = fields as [string, string, string, string];
    if (!/^[0-9a-f]{40,64}$/.test(sha)) continue;
    const runIds = runs.split(",").filter((id) => id !== "");
    if (runIds.length !== 1 || runIds[0] === o.runId) continue;
    if (!tasks.split(",").includes(o.taskId)) continue;
    if (!o.runStartedFor(runIds[0]!)) continue;
    out.push({ sha, subject });
  }
  return out;
}

/** Whether this install recorded `runId` as started for `taskId`. */
function runStartedFor(runId: string, taskId: string): boolean {
  return (
    db().prepare("SELECT 1 FROM run_tasks WHERE run_id = ? AND task_id = ?").get(runId, taskId) !==
    undefined
  );
}

/**
 * The commits already in `head`'s history that carry this task's trailer, with
 * their diffs, or null when there are none or any read failed.
 *
 * `repoRoot` is the caller's, already proved inside its mount (`repoPathFor`).
 * `budgetBytes` is shared by every commit's patch together.
 */
export async function alreadyDeliveredFor(o: {
  repoRoot: string;
  head: string;
  taskId: string;
  runId: string;
  budgetBytes: number;
}): Promise<AlreadyDelivered | null> {
  const log = await git(
    o.repoRoot,
    [
      "log",
      "--no-merges",
      `-n${SCAN_COMMITS}`,
      "--fixed-strings",
      `--grep=${o.taskId}`,
      `--format=${LOG_FORMAT}`,
      o.head,
      "--",
    ],
    { trim: false },
  );
  if (!log.ok) return null;

  const found = taskCommitsIn(log.stdout, {
    taskId: o.taskId,
    runId: o.runId,
    runStartedFor: (runId) => runStartedFor(runId, o.taskId),
  });
  if (found.length === 0) return null;

  const shown: HistoryCommit[] = [];
  const parts: string[] = [];
  let remaining = o.budgetBytes;
  let truncated = found.length > HISTORY_COMMITS_SHOWN;
  for (const commit of found.slice(0, HISTORY_COMMITS_SHOWN)) {
    const diff = await wholeCommitDiff(o.repoRoot, commit.sha);
    // A commit that changed nothing, or whose diff could not be read, is no
    // evidence of a deliverable and is left out rather than shown empty.
    if (!diff) continue;
    const { text, truncated: cut } = diffAsText(diff, Math.max(remaining, 0));
    remaining -= text.length;
    if (cut) truncated = true;
    shown.push(commit);
    parts.push(
      [
        `### ${commit.sha.slice(0, 8)}  ${commit.subject}`,
        `${diff.filesChanged} file(s) changed, +${diff.added} −${diff.deleted}.`,
        text,
      ].join("\n"),
    );
  }
  if (shown.length === 0) return null;
  return { commits: shown, text: parts.join("\n"), truncated };
}
