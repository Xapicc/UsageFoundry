"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { RunTaskDTO, RunTaskNotesDTO } from "@/lib/apiTypes";
import { TASK_STATUS_TONE, pollFailureMessage } from "@/lib/format";
import { jsonRequest } from "@/lib/jsonRequest";
import { TaskCommentRows } from "@/components/TaskThread";
import { Badge } from "@/components/ui/Badge";
import { Notice } from "@/components/ui/Notice";

/**
 * What has been said on the board about the brief this run was given.
 *
 * A run's work cycle can write a note on its own task, and until this block the
 * operator watching the run had to open `/tasks/[id]` to read it — on the one
 * page they were already on. So it draws the newest notes and nothing else: the
 * task's own page is where a thread is read whole, and it is one link away from
 * every line here.
 *
 * Three decisions, each of which `/tasks/[id]` settled the other way and neither
 * of which carries over on its own. They are written out in
 * `docs/agent/taskboard.md`.
 *
 * **No composer.** The operator writes on the task's own page. A second box on
 * this page would be a second draft to lose, on a page whose whole business is
 * something else — and it is the *reason* the two decisions below are available,
 * rather than a saving made beside them.
 *
 * **It polls, and only while the run can still write.** `/tasks/[id]` refuses to
 * because it is a form holding unsaved text, and that reason is spent here: with
 * no draft there is nothing a re-read could throw away. What it is watching is a
 * work cycle writing a note on its own task, which is a live event and the whole
 * reason the block exists — a note that appeared only on reload would miss it.
 * A run that has stopped cannot write another, so the interval ends with the run
 * rather than running for as long as the tab is open.
 *
 * **One request, never one per task.** A run may name up to `MAX_RUN_TASKS`
 * tasks, so a thread fetched per task would be twenty requests every poll.
 * `/api/runs/[id]/task-comments` answers for all of them at once, which is also
 * why this is keyed on the run id rather than on the ids of the tasks beside it.
 */

/**
 * Slower than the run page's own poll by more than a factor of three.
 *
 * The board's cadence, deliberately: a note is a row in the same table a board
 * asks about every ten seconds, and nothing here moves faster than somebody
 * finishing a sentence. The three-second row poll exists for a status and a
 * spend figure that change between one cycle and the next.
 */
const POLL_MS = 10_000;

export function RunTaskComments({
  runId,
  /** The board rows this run was started for, in the order they were named. */
  tasks,
  /** The run can still produce a note, so the thread can still change. */
  active,
}: {
  runId: string;
  tasks: readonly RunTaskDTO[];
  active: boolean;
}) {
  const [notes, setNotes] = useState<RunTaskNotesDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The instant these rows were read. Kept here rather than taken from the
  // page's `nowTick`, which reticks every second: a note's age is measured
  // against the read that produced it, so "2m ago" stays still between polls
  // instead of counting up against a thread nothing re-read.
  const [fetchedAt, setFetchedAt] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const res = await jsonRequest<{ tasks: RunTaskNotesDTO[] }>(
        `/api/runs/${runId}/task-comments`,
      );
      if (!alive) return;
      if (!res.ok) {
        // The last notes read stay on screen and the notice says the read
        // failed. Blanking them would turn "we could not look" into "nothing
        // has been said", which on a task a run is holding is the sentence an
        // operator would act on.
        setError(pollFailureMessage(res.status, res.error));
        return;
      }
      setNotes(res.data.tasks);
      setFetchedAt(Date.now());
      setError(null);
    };
    void load();
    if (!active) return () => void (alive = false);
    const t = setInterval(() => void load(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [runId, active]);

  const byTask = new Map(notes?.map((entry) => [entry.taskId, entry]) ?? []);

  return (
    <>
      {error && (
        <Notice tone="warn" quiet className="mb-2">
          {error}
        </Notice>
      )}

      {tasks.map((task, index) => {
        const thread = byTask.get(task.id) ?? null;
        return (
          <div
            key={task.id}
            // Written per row rather than as a `first:` variant, for the reason
            // `TaskCommentRows` gives: Tailwind emits nothing at all for a
            // variant spelling it does not know, and it does so silently.
            className={index === 0 ? "" : "mt-4 border-t border-line pt-4"}
          >
            <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
              {task.title === null ? (
                // Never a link: the row it would open is not there. The page's
                // own subtitle says the same thing about the same id, and both
                // have to, because a deleted task and a task with nothing said
                // about it are different facts.
                <span className="text-sm text-ink-muted">
                  A task since deleted
                </span>
              ) : (
                <Link href={`/tasks/${task.id}`} className="text-sm text-ink">
                  {task.title}
                </Link>
              )}
              {task.status && (
                <Badge tone={TASK_STATUS_TONE[task.status]}>{task.status}</Badge>
              )}
            </div>

            <TaskThreadSlice
              taskId={task.id}
              deleted={task.title === null}
              read={notes !== null}
              thread={thread}
              fetchedAt={fetchedAt}
            />
          </div>
        );
      })}
    </>
  );
}

/**
 * One task's newest notes, and the four ways of having none.
 *
 * The fourth is this surface's own and is the reason they are told apart here
 * rather than inside `TaskCommentRows`: a task the operator deleted has no
 * thread to read, so the request never asked for one. Drawing "nothing said yet"
 * against it would report an empty conversation about a row that is gone.
 */
function TaskThreadSlice({
  taskId,
  deleted,
  read,
  thread,
  fetchedAt,
}: {
  taskId: string;
  deleted: boolean;
  read: boolean;
  thread: RunTaskNotesDTO | null;
  fetchedAt: number;
}) {
  if (deleted) return null;

  // Before the first read lands, and after one that failed. Never "nothing said
  // yet": what is not known is whether anything was said.
  if (!read || thread === null) {
    return <p className="text-xs text-ink-faint">Reading the thread…</p>;
  }

  if (thread.total === 0) {
    return (
      <p className="text-xs text-ink-faint">
        Nothing said yet.{" "}
        <Link href={`/tasks/${taskId}`}>Add a note on the task</Link>
      </p>
    );
  }

  return (
    <>
      {/* Why this is not the task page's `warn` notice, though both say a
          reader is seeing part of a thread: there the route ran out of room
          and dropped the oldest end, which is a caveat. Here the block is
          drawing what it is for — the newest few — and the rest is a link
          away, which is a fact about where to find it. `total` covers both
          causes, since it is counted over the table either way. */}
      {thread.total > thread.newest.length && (
        <p className="mb-2 text-xs text-ink-faint">
          Newest {thread.newest.length} of {thread.total}.{" "}
          <Link href={`/tasks/${taskId}`}>Read the thread</Link>
        </p>
      )}
      <TaskCommentRows comments={thread.newest} fetchedAt={fetchedAt} />
    </>
  );
}
