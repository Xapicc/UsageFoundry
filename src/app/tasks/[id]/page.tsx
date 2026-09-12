"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type {
  TaskCommentDTO,
  TaskCommentListDTO,
  TaskDTO,
  TaskStatusDTO,
} from "@/lib/apiTypes";
import {
  TASK_COMMENT_AUTHOR_WORD,
  TASK_PRIORITY_TONE,
  TASK_STATUS_TONE,
  fmtDateTime,
  fmtRelative,
  fmtTaskOrigin,
  fmtTaskPlace,
  pollFailureMessage,
  shortId,
} from "@/lib/format";
import { actionFailureMessage, jsonRequest } from "@/lib/jsonRequest";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonLink, ButtonRow } from "@/components/ui/Button";
import { Card, CardTitle, Empty, SkeletonText } from "@/components/ui/Card";
import { Field, Textarea } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Notice";
import { TaskDependencies } from "@/components/TaskDependencies";
import { TaskEditor } from "@/components/TaskEditor";

/**
 * One task, on a page of its own.
 *
 * `runs/[id]` for a task: the board says enough of a brief to tell two of them
 * apart and this route has the rest. The editor used to be a card the board
 * opened above itself, which put a sixteen-line brief in a box beside a table
 * that was still polling and still moving under it — the whole reason this
 * route exists.
 *
 * **This page does not poll, and that is the one place it departs from the
 * board.** A board has no state that would make standing down safe, so it asks
 * every ten seconds. This page is a form with unsaved text in it: a poll that
 * re-read the row could not touch the draft without throwing away what is being
 * typed, and could not leave it alone without drawing a title beside a field
 * that disagrees with it. So the row is read on arrival and again after every
 * press that changed it — which is every way this page can move a task — and
 * anything a *different* door did meanwhile is not something this page pretends
 * to know. `TaskThread` below holds a **second** draft and follows the same
 * rule for the same reason; the two reads are independent, and neither is a
 * timer.
 *
 * **Nothing here decides who may move a task.** `taskTransitionRefusal` in
 * `tasks.ts` is the whole of that rule and it is a server module. Every move is
 * a `PATCH` and its refusal is rendered verbatim, which is the board's rule and
 * for the same reason: a row that moved under the page is exactly when the
 * server's sentence matters.
 */

/** A run this task names, as the one handle a task page can give. */
function RunLine({ label, runId }: { label: string; runId: string }) {
  return (
    <div>
      <span className="text-ink-faint">{label}</span>{" "}
      <Link href={`/runs/${runId}`} className="mono">
        {shortId(runId)}
      </Link>
    </div>
  );
}

/**
 * The thread on one task: what three parties have said about a brief without
 * changing it.
 *
 * **It reads on arrival and after every post it makes, and nothing here polls
 * either.** The page around it refuses to for the reason its own docblock
 * gives, and this component holds a *second* draft — so an interval re-reading
 * the thread would be a second way of losing typed text on a page that already
 * declines the first. What that costs is a note written at another door while
 * this page is open, and the trade is the page's own: the row and the thread
 * are both read on arrival and again after every press that changed one of
 * them, and neither claims to know what happened meanwhile.
 *
 * **Nothing here decides who may write.** `normalizeTaskCommentInput` and the
 * route's own `OPERATOR` constant are the whole of that rule and both are
 * server modules a `"use client"` file may not import; a refusal comes back
 * naming the field it refused — `author`, `authorRunId` and `createdAt` are all
 * refused by name — and is rendered as it arrived, which is this page's rule
 * for every other press. The blank-draft guard on the button is not a second
 * copy of that rule: it is the button declining to send an empty box, and a
 * body that reaches the door empty by any other route is still refused there.
 *
 * **A body is drawn as the characters it is** — `whitespace-pre-wrap`, no
 * markdown — because the task's own brief on this page is drawn in a
 * `Textarea`, which is the same text unrendered. A thread that rendered
 * headings and links above a brief shown raw would claim a fidelity the field
 * it answers does not have, and would do it on the one surface whose whole
 * point is that a run reads back exactly what somebody wrote.
 *
 * **A clipped thread says so.** `MAX_TASK_COMMENTS` is what the route sends and
 * `total` is counted over the table, so a thread longer than the cap is missing
 * its **oldest** end — see `listTaskComments` for why that end and not the
 * other — and a reader shown the tail of a conversation without being told
 * reads a thread that begins where it does not.
 */
function TaskThread({ taskId }: { taskId: string }) {
  const [thread, setThread] = useState<TaskCommentListDTO | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  // The instant *these* rows were read, kept apart from the page's own: the two
  // reads are independent and a note's age measured against when the task row
  // was fetched would drift by however long the operator spent typing.
  const [fetchedAt, setFetchedAt] = useState(() => Date.now());

  const load = useCallback(async () => {
    const res = await jsonRequest<TaskCommentListDTO>(
      `/api/tasks/${taskId}/comments`,
    );
    if (!res.ok) {
      // The same sentence every failed read in this app carries, including the
      // one the page above draws for the task row. Its "stopped refreshing"
      // clause is the true half here rather than the awkward one: nothing
      // re-reads this thread on its own, so what is on screen is exactly as old
      // as the last successful read, and the retry beside it is the only way
      // forward. A 404 is not told apart from the rest — the task going away
      // between the page's read and this one is a race the page's own next read
      // reports, and an empty thread drawn for it would say the conversation is
      // over rather than that the task is gone.
      setLoadError(pollFailureMessage(res.status, res.error));
      return;
    }
    setThread(res.data);
    setFetchedAt(Date.now());
    setLoadError(null);
  }, [taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** One note, decided by the server, and the thread re-read on success only. */
  async function post() {
    if (posting) return;
    setPosting(true);
    setPostError(null);
    const res = await jsonRequest<{ comment: TaskCommentDTO }>(
      `/api/tasks/${taskId}/comments`,
      { method: "POST", body: { body: draft } },
    );
    setPosting(false);

    if (!res.ok) {
      // Verbatim, and the draft is left in the box: every refusal on this path
      // names something the operator can change, and clearing the field would
      // take away the text the sentence is about.
      setPostError(actionFailureMessage(res, "Could not add the comment."));
      return;
    }
    setDraft("");
    // The thread and nothing else. The note did not move the task — no status,
    // no priority, and deliberately not `updated_at` — so re-reading the row
    // would redraw a heading nothing changed.
    await load();
  }

  const comments = thread?.comments ?? [];
  const clipped = thread !== null && thread.total > comments.length;
  /** The three ways of having nothing, told apart before anything is drawn. */
  const unreadable = thread === null && loadError !== null;
  const threadIsEmpty = thread !== null && comments.length === 0;

  return (
    <>
      <CardTitle>
        Comments
        {thread && <Badge tone="neutral">{thread.total}</Badge>}
      </CardTitle>
      <Card className="mb-6">
        <div role="alert">
          {loadError && <Notice tone="warn">{loadError}</Notice>}
          {postError && <Notice tone="danger">{postError}</Notice>}
        </div>

        {thread === null && !loadError && (
          <div aria-busy="true">
            <span className="sr-only">Reading the thread…</span>
            <SkeletonText lines={3} />
          </div>
        )}

        {unreadable && (
          // Never an empty thread: a failed read rendered as one says nobody
          // has commented, which on a task a run is holding is the sentence an
          // operator would act on.
          <Empty>
            <div className="font-medium text-ink">
              The comments could not be read
            </div>
            <div className="mx-auto mt-1 max-w-[52ch]">
              This is a failed request rather than an empty thread — nothing
              here says whether anything has been said about this task.
            </div>
            <ButtonRow className="mt-3 justify-center">
              <Button variant="secondary" onClick={() => void load()}>
                Try again
              </Button>
            </ButtonRow>
          </Empty>
        )}

        {threadIsEmpty && (
          <Empty>
            Nothing said yet. A comment is a note on the brief — the operator,
            the orchestrator and a run working this task can each add one, and
            none of them can change or remove it afterwards.
          </Empty>
        )}

        {clipped && (
          <Notice tone="warn">
            Showing the newest {comments.length} of {thread.total} comments. The
            oldest are not on this page.
          </Notice>
        )}

        {comments.map((comment, index) => (
          <div
            key={comment.id}
            // The hairline is written per row rather than as a `first:` variant
            // because Tailwind emits nothing at all for a variant spelling it
            // does not know, silently — and a separator that quietly failed to
            // appear is a thread that reads as one long note.
            className={index === 0 ? "" : "mt-3 border-t border-line pt-3"}
          >
            <div className="mb-1 flex flex-wrap items-baseline gap-x-2 text-xs text-ink-faint">
              {/* The author, and never the run id beside it: the pairing is
                  what `taskComments.ts` records and this is where it is read
                  back, so the word says who wrote the note and the id is a
                  handle on the run that did. The link is `RunLine`'s above,
                  written out rather than reused because there the run *is* the
                  line and here it annotates a name that has to read the same
                  whichever of the four wrote it. */}
              <span className="font-medium text-ink">
                {TASK_COMMENT_AUTHOR_WORD[comment.author]}
              </span>
              {comment.authorRunId && (
                <Link href={`/runs/${comment.authorRunId}`} className="mono">
                  {shortId(comment.authorRunId)}
                </Link>
              )}
              <span>{fmtRelative(comment.createdAt, fetchedAt)}</span>
            </div>
            <div className="max-w-[80ch] text-sm whitespace-pre-wrap text-ink">
              {comment.body}
            </div>
          </div>
        ))}

        <div className="mt-4 border-t border-line pt-4">
          <Field
            label="Add a comment"
            htmlFor="task-comment"
            hint="Nobody can edit or delete it afterwards"
          >
            <Textarea
              id="task-comment"
              value={draft}
              rows={4}
              onChange={(e) => setDraft(e.target.value)}
            />
          </Field>
          <ButtonRow className="justify-end">
            <Button
              variant="secondary"
              onClick={() => void post()}
              busy={posting}
              // Not the server's rule restated — the door's own refusal for an
              // empty body still stands — but the press declining to spend a
              // request on a box the operator can see is empty.
              disabled={draft.trim() === ""}
            >
              Add comment
            </Button>
          </ButtonRow>
        </div>
      </Card>
    </>
  );
}

export default function TaskDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [task, setTask] = useState<TaskDTO | null>(null);
  // A 404 and a failed read are different answers and must never render the
  // same way: one says the task is not on the board, the other says nobody
  // knows — the board's own rule about its three ways of having nothing.
  const [gone, setGone] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // The edge in flight, `status`, rather than a bare boolean: keyed on the
  // task, pressing Done lit Release and Drop as well, which reads as three
  // presses.
  const [moving, setMoving] = useState<TaskStatusDTO | null>(null);
  // The instant the row on screen was read, which every relative phrase below
  // is measured against rather than against `Date.now()` — an age cannot change
  // without the row changing.
  const [fetchedAt, setFetchedAt] = useState(() => Date.now());
  /**
   * The parent's title, read separately because a task carries only the id.
   *
   * `null` inside a set pair is a parent that is no longer there: the child
   * keeps the id, which is `RunTaskDTO`'s rule — provenance outlives the row it
   * points at, and the short id is the only true thing left to say.
   */
  const [parent, setParent] = useState<{
    id: string;
    title: string | null;
  } | null>(null);

  const load = useCallback(async () => {
    const res = await jsonRequest<{ task: TaskDTO }>(`/api/tasks/${id}`);
    if (!res.ok) {
      if (res.status === 404) {
        setGone(true);
        return;
      }
      setLoadError(pollFailureMessage(res.status, res.error));
      return;
    }
    setTask(res.data.task);
    setFetchedAt(Date.now());
    setGone(false);
    setLoadError(null);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const parentTaskId = task?.parentTaskId ?? null;
  useEffect(() => {
    if (parentTaskId === null) {
      setParent(null);
      return;
    }
    let alive = true;
    void (async () => {
      const res = await jsonRequest<{ task: TaskDTO }>(
        `/api/tasks/${parentTaskId}`,
      );
      if (!alive) return;
      setParent({
        id: parentTaskId,
        title: res.ok ? res.data.task.title : null,
      });
    })();
    return () => {
      alive = false;
    };
  }, [parentTaskId]);

  /** One move, decided by the server and re-read either way. */
  async function move(to: TaskStatusDTO, verb: string) {
    if (!task || moving) return;
    setMoving(to);
    setActionError(null);
    const res = await jsonRequest<{ task: TaskDTO }>(`/api/tasks/${task.id}`, {
      method: "PATCH",
      body: { status: to },
    });
    setMoving(null);

    if (!res.ok) {
      setActionError(actionFailureMessage(res, `Could not ${verb} the task.`));
      await load();
      return;
    }
    setNote(`“${res.data.task.title}” is now ${to}`);
    await load();
  }

  if (gone) {
    return (
      <Card emphasis="primary">
        <Empty>
          <div className="font-medium text-ink">
            That task is not on the board
          </div>
          <div className="mx-auto mt-1 max-w-[52ch]">
            It was deleted, or this link names a task this install never held.
            Deleting one affects nothing that is running.
          </div>
          <div className="mt-3">
            <ButtonLink href="/tasks" variant="secondary">
              Back to the taskboard
            </ButtonLink>
          </div>
        </Empty>
      </Card>
    );
  }

  if (!task) {
    if (loadError) {
      return (
        <>
          <div role="alert">
            <Notice tone="danger">{loadError}</Notice>
          </div>
          <Card emphasis="quiet">
            <Empty>
              <div className="font-medium text-ink">
                The task could not be read
              </div>
              <div className="mx-auto mt-1 max-w-[52ch]">
                This is a failed request rather than a deleted task — nothing
                here says whether it is still on the board.
              </div>
              <ButtonRow className="mt-3 justify-center">
                <Button variant="secondary" onClick={() => void load()}>
                  Try again
                </Button>
                <ButtonLink href="/tasks">Back to the taskboard</ButtonLink>
              </ButtonRow>
            </Empty>
          </Card>
        </>
      );
    }
    return (
      <Card emphasis="primary">
        <div aria-busy="true">
          <span className="sr-only">Reading the whole brief…</span>
          <SkeletonText lines={6} />
        </div>
      </Card>
    );
  }

  const open = task.status === "open" || task.status === "claimed";

  return (
    <>
      <div className="mb-1 flex flex-wrap items-start justify-between gap-3">
        <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
          {/* The *saved* title, not the draft: a heading that re-wrote itself
              on every keystroke would say the task is already called something
              nothing has stored yet. */}
          {task.title}
          <Badge tone={TASK_PRIORITY_TONE[task.priority]}>{task.priority}</Badge>
          <Badge tone={TASK_STATUS_TONE[task.status]}>{task.status}</Badge>
        </h1>
        {/* The operator's own rows of the edge table, with no Claim among them:
            a claim names the run that will hold the task, and the operator is
            not a run. */}
        <ButtonRow>
          {task.status === "claimed" && (
            <Button
              variant="ghost"
              onClick={() => void move("open", "release")}
              busy={moving === "open"}
            >
              Release
            </Button>
          )}
          {open && (
            <>
              <Button
                variant="secondary"
                onClick={() => void move("done", "complete")}
                busy={moving === "done"}
              >
                Done
              </Button>
              <Button
                variant="ghost"
                onClick={() => void move("dropped", "drop")}
                busy={moving === "dropped"}
              >
                Drop
              </Button>
            </>
          )}
          {!open && (
            <Button
              variant="ghost"
              onClick={() => void move("open", "re-open")}
              busy={moving === "open"}
            >
              Re-open
            </Button>
          )}
        </ButtonRow>
      </div>
      <p className="mb-5 max-w-[80ch] text-sm text-ink-muted">
        {fmtTaskPlace(task)} · filed {fmtDateTime(task.createdAt)} · updated{" "}
        {fmtRelative(task.updatedAt, fetchedAt)}
        {task.closedAt ? ` · closed ${fmtDateTime(task.closedAt)}` : ""} ·{" "}
        <Link href="/tasks">Back to the taskboard</Link>
      </p>

      <div role="alert">
        {loadError && <Notice tone="warn">{loadError}</Notice>}
        {actionError && <Notice tone="danger">{actionError}</Notice>}
      </div>
      {note && (
        <Notice tone="info" live>
          {note}
        </Notice>
      )}

      <TaskEditor task={task} onSaved={() => void load()} />

      {/* Between the brief and the thread, which is where an ordering sits in
          the reading: what the task asks for, then what has to happen around
          it, then what has been said about it. It takes `load` rather than
          holding a read of its own — a write there changes this row's
          neighbourhood, which arrives on the task — and this page still does
          not poll, so the graph is as old as the last press. */}
      <TaskDependencies task={task} onChanged={load} />

      {/* Below the brief and above its provenance, which is the order the three
          are read in: the brief is what the task asks for, the thread is what
          has been said about it since, and where it came from is the footnote
          neither of the other two needs. It reads the thread itself rather than
          taking it as a prop — the row above carries a `commentCount` for the
          board's sake and a count is not a thread. */}
      <TaskThread taskId={task.id} />

      <CardTitle>Where this came from</CardTitle>
      <Card emphasis="quiet" className="mb-6">
        <div className="text-sm text-ink-muted">
          <div>{fmtTaskOrigin(task.origin)}</div>
          {parent && (
            <div>
              <span className="text-ink-faint">Filed under</span>{" "}
              {parent.title === null ? (
                <span className="mono">{shortId(parent.id)}</span>
              ) : (
                <Link href={`/tasks/${parent.id}`}>{parent.title}</Link>
              )}
            </div>
          )}
          {task.createdByRunId && (
            <RunLine label="Filed by run" runId={task.createdByRunId} />
          )}
          {task.claimedByRunId && (
            <RunLine label="Held by run" runId={task.claimedByRunId} />
          )}
          {task.completedByRunId && (
            <RunLine label="Closed by run" runId={task.completedByRunId} />
          )}
          {/* Runs started *for* this task, which is the one link here the board
              did not write about itself — the three above are records the board
              keeps and this is `runs.task_id` read back. Drawn last and worded
              "started for", because none of them says the work happened: a run
              named here can have completed without doing the thing, which is
              exactly why nothing closes this task when one ends. */}
          {task.runIds.map((runId) => (
            <RunLine key={runId} label="Started for it" runId={runId} />
          ))}
          {/* Named rather than left to be inferred from a list that stops at
              `MAX_TASK_RUN_LINKS`, the rule a shortened diff follows: showing
              three of eleven and saying nothing reports a task worked eleven
              times as one worked three times. */}
          {task.runCount > task.runIds.length && (
            <div className="text-ink-faint">
              and {task.runCount - task.runIds.length} more
            </div>
          )}
        </div>
      </Card>
    </>
  );
}
