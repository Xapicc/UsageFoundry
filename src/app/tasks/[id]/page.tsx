"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { TaskDTO, TaskStatusDTO } from "@/lib/apiTypes";
import {
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
import { Notice } from "@/components/ui/Notice";
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
 * to know.
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
