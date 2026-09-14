"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { TaskCommentDTO, TaskCommentListDTO } from "@/lib/apiTypes";
import {
  TASK_COMMENT_AUTHOR_WORD,
  fmtRelative,
  pollFailureMessage,
  shortId,
} from "@/lib/format";
import { actionFailureMessage, jsonRequest } from "@/lib/jsonRequest";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonRow } from "@/components/ui/Button";
import { Card, CardTitle, Empty, SkeletonText } from "@/components/ui/Card";
import { Field, Textarea } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Notice";

/**
 * A task's notes, and the one drawing of them.
 *
 * Two surfaces read this thread — the task's own page and the inspector on
 * `/runs/[id]` — and `TaskCommentRows` is why there is one copy of what a note
 * looks like rather than two. What must not diverge is named in the task that
 * asked for the second surface: the author labelling, the run link beside it,
 * and how a body is drawn. Each of those is a decision about whether a reader
 * can tell who said something and act on it, and two copies are two answers.
 *
 * What does differ between the two is the chrome and the fetch, and both belong
 * to the surface: the task page reads one thread whole and writes to it, the run
 * page reads every thread its run is linked to in one request and writes to
 * none. `RunTaskComments` holds that half.
 */

/**
 * The notes themselves, oldest first.
 *
 * **A body is drawn as the characters it is** — `whitespace-pre-wrap`, no
 * markdown — because the task's brief is drawn in a `Textarea` on the page that
 * owns it, which is the same text unrendered. A thread that rendered headings
 * and links above a brief shown raw would claim a fidelity the field it answers
 * does not have, and would do it on the one surface whose whole point is that a
 * run reads back exactly what somebody wrote.
 */
export function TaskCommentRows({
  comments,
  /**
   * When the rows on screen were read, which is never `Date.now()`: an age
   * measured against render would retick under a poll that changed nothing.
   */
  fetchedAt,
}: {
  comments: readonly TaskCommentDTO[];
  fetchedAt: number;
}) {
  return (
    <>
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
            {/* The author, and never the run id beside it: the pairing is what
                `taskComments.ts` records and this is where it is read back, so
                the word says who wrote the note and the id is a handle on the
                run that did. */}
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
    </>
  );
}

/**
 * The thread on one task: what three parties have said about a brief without
 * changing it.
 *
 * **It reads on arrival and after every post it makes, and nothing here polls.**
 * The page around it refuses to for the reason its own docblock gives, and this
 * component holds a *second* draft — so an interval re-reading the thread would
 * be a second way of losing typed text on a page that already declines the
 * first. What that costs is a note written at another door while this page is
 * open, and the trade is the page's own: the row and the thread are both read on
 * arrival and again after every press that changed one of them, and neither
 * claims to know what happened meanwhile. The run page's copy holds no draft,
 * which is exactly why it may poll and does.
 *
 * **Nothing here decides who may write.** `normalizeTaskCommentInput` and the
 * route's own `OPERATOR` constant are the whole of that rule and both are server
 * modules a `"use client"` file may not import; a refusal comes back naming the
 * field it refused — `author`, `authorRunId` and `createdAt` are all refused by
 * name — and is rendered as it arrived, which is this page's rule for every
 * other press. The blank-draft guard on the button is not a second copy of that
 * rule: it is the button declining to send an empty box, and a body that reaches
 * the door empty by any other route is still refused there.
 *
 * **A clipped thread says so.** `MAX_TASK_COMMENTS` is what the route sends and
 * `total` is counted over the table, so a thread longer than the cap is missing
 * its **oldest** end — see `listTaskComments` for why that end and not the
 * other — and a reader shown the tail of a conversation without being told reads
 * a thread that begins where it does not.
 */
export function TaskThread({ taskId }: { taskId: string }) {
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

        <TaskCommentRows comments={comments} fetchedAt={fetchedAt} />

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
