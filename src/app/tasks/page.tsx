"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  MAX_TASK_PAGE,
  type TaskDTO,
  type TaskListDTO,
  type TaskListItemDTO,
  type TaskStatusDTO,
} from "@/lib/apiTypes";
import {
  TASK_ORIGIN_WORD,
  TASK_PRIORITY_TONE,
  TASK_STATUS_TONE,
  fmtRelative,
  fmtTaskPlace,
  pollFailureMessage,
  shortId,
} from "@/lib/format";
import { actionFailureMessage, jsonRequest } from "@/lib/jsonRequest";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonLink, ButtonRow } from "@/components/ui/Button";
import { Card, CardTitle, Empty, SkeletonText } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { Field, Select } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Notice";
import {
  TBody,
  THead,
  Table,
  TableWrap,
  Td,
  Th,
  Tr,
} from "@/components/ui/Table";

/**
 * The taskboard: every brief on the install, across every mount.
 *
 * **Nothing here decides who may move a task.** `taskTransitionRefusal` in
 * `tasks.ts` is the whole of that rule and it is a server module — a `"use
 * client"` file may not import it, and a second copy of it in the browser would
 * be a second set to keep in step, confidently wrong about what a press does
 * the day one of them changed. So every move on this page is a `PATCH` and the
 * refusal it may come back with is rendered verbatim, which is the agents
 * page's rule for `normalizeAgentInput` and `/api/workflows/validate`'s for a
 * graph. What this file *does* decide is which controls to draw, and that is a
 * smaller claim than the rule: the operator's own rows of the edge table, with
 * no Claim among them, because a claim names the run that will hold it and the
 * operator is not a run. A row that moved under the page between a poll and a
 * press is exactly when the server's sentence matters, and it is shown rather
 * than swallowed.
 *
 * **The editor is not here.** Opening a task is a route — `tasks/[id]`, and
 * `tasks/new` for filing one — on `runs/[id]`'s precedent, because the brief is
 * the field with something to read in it and it used to be a seven-line box in
 * a card wedged above a table that went on polling and moving underneath it.
 * What is left on this page is a list: it draws rows, narrows them, counts them
 * and offers the moves.
 *
 * **The whole board arrives in one request and the narrowing happens here**,
 * which is the one place this page departs from `docs/agent/conventions.md`'s
 * "narrow in the query" rule, deliberately and for two reasons that are
 * specific to a board. The board draws every status group at once, so a
 * server-side narrowing would be one request per group with an offset that cuts
 * across them — page two of a priority-ordered list is half of Open and half of
 * Claimed. And the project filter's options are built from the same answer the
 * rows are, so the select can never offer a project the board cannot show or
 * hide one it can; drawn from anywhere else they would need a mount root joined
 * to a relative path in the browser, which is the second, looser resolver
 * `docs/agent/taskboard.md` exists to prevent. The cap is real and the board
 * says so: `MAX_TASK_PAGE` rows are asked for and a `total` above what came
 * back is a notice naming what the filter therefore could not reach.
 */

/**
 * The dashboard's cadence, and this poll does **not** stand down.
 *
 * A run's page gates its 3s interval on the row being live because a terminal
 * run cannot change on its own. A board has no such state: a row can be filed
 * or claimed by a door this page does not own — a chat turn, a work cycle —
 * whatever the board currently holds, and a board of nothing but closed work is
 * exactly when a newly filed task is the thing worth seeing. So there is no
 * gate to re-arm, and the cost is one small request every ten seconds.
 */
const POLL_MS = 10_000;

/** Every status group the board draws, in the order it draws them. */
const OPEN_GROUPS = [
  {
    status: "open" as const,
    title: "Open",
    empty: "Nothing open",
  },
  {
    status: "claimed" as const,
    title: "Claimed",
    empty: "No task is being worked",
  },
];

const CLOSED_GROUPS = [
  { status: "done" as const, title: "Done" },
  { status: "dropped" as const, title: "Dropped" },
];

/**
 * The project filter's two special values. Neither can collide with a real key:
 * `placeKey` below encodes a pair as JSON, so every project's key begins `["`.
 */
const EVERY_PROJECT = "";
const NO_PROJECT = "unassigned";

/**
 * One project, as a `<select>` value.
 *
 * The pair rather than the folder alone, because two mounts may hold the same
 * relative path and a filter keyed on the path would show both under one name.
 * JSON rather than a joined string: a separator has to be a character neither
 * half can contain, and a mount label is operator-supplied config — there is no
 * such character to pick, only one nobody has typed yet.
 */
function placeKey(task: TaskListItemDTO): string {
  return task.folder === null
    ? NO_PROJECT
    : JSON.stringify([task.mountId, task.folder]);
}

/** A run id as a link to the run, which is the only handle the board can give. */
function RunLink({ label, runId }: { label: string; runId: string }) {
  return (
    <span className="block">
      {label}{" "}
      <Link href={`/runs/${runId}`} className="mono">
        {shortId(runId)}
      </Link>
    </span>
  );
}

/**
 * The one run a row names — the run that acted on *this* task — or nothing.
 *
 * Three records used to compete for a single 150px column and stacked four deep
 * in it: the holder, the closer, and every run `runs.task_id` points at. They
 * are not equally worth a row. The holder and the closer each say what happened
 * to the task; a run merely started for it can have ended without touching it,
 * which is exactly why nothing closes a task when a run ends. So the row draws
 * the one that acted and the count stands in for the rest, and the whole list is
 * on the task's own page — which the count links to, and the title beside it
 * already does.
 *
 * "Held by" is gated on the status rather than on the column alone, because a
 * re-open is the only thing that clears `claimed_by_run_id`: a task closed by
 * hand keeps the id of the run that last held it, and drawing that on a Done row
 * reports finished work as work in progress.
 */
function actingRun(
  task: TaskListItemDTO,
): { label: string; runId: string } | null {
  if (task.completedByRunId) {
    return { label: "Closed by", runId: task.completedByRunId };
  }
  if (task.status === "claimed" && task.claimedByRunId) {
    return { label: "Held by", runId: task.claimedByRunId };
  }
  return null;
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<TaskListItemDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [pollError, setPollError] = useState<string | null>(null);
  // The instant the rows on screen were read. Every relative phrase below is
  // measured against it rather than against `Date.now()`, because an age cannot
  // change without the rows changing and recomputing one per row per paint is
  // the second clock `docs/agent/conventions.md` warns about.
  const [fetchedAt, setFetchedAt] = useState(() => Date.now());

  /**
   * The project filter, carrying the label it was chosen by.
   *
   * The label cannot be looked back up from the rows: the state the heading is
   * for is a filter that now matches nothing, and by then the row the label came
   * from is gone — so the derived version read "No tasks in that project"
   * always, and the named case was unreachable in exactly the case it exists
   * for. Taken at the press, where the row is still on the board.
   */
  const [place, setPlace] = useState<{ key: string; label: string }>({
    key: EVERY_PROJECT,
    label: "",
  });

  const [actionError, setActionError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // The edge in flight, `id:status`, rather than the row: keyed on the row,
  // pressing Done lit Release and Drop as well, which reads as three presses.
  const [moving, setMoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await jsonRequest<TaskListDTO>(
      `/api/tasks?limit=${MAX_TASK_PAGE}`,
    );
    if (!res.ok || !Array.isArray(res.data.tasks)) {
      setPollError(
        pollFailureMessage(
          res.ok ? 200 : res.status,
          res.ok ? "no tasks in the response" : res.error,
        ),
      );
      setLoaded(true);
      return;
    }
    setTasks(res.data.tasks);
    setTotal(res.data.total);
    setFetchedAt(Date.now());
    setPollError(null);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(poll);
  }, [load]);

  /** Every project the board actually names, newest label wins. */
  const places = useMemo(() => {
    const seen = new Map<string, string>();
    for (const task of tasks) {
      if (task.folder === null) continue;
      seen.set(placeKey(task), fmtTaskPlace(task));
    }
    return [...seen].sort((a, b) => a[1].localeCompare(b[1]));
  }, [tasks]);

  const unassignedCount = tasks.filter((t) => t.folder === null).length;

  const visible = useMemo(
    () =>
      place.key === EVERY_PROJECT
        ? tasks
        : tasks.filter((t) => placeKey(t) === place.key),
    [tasks, place],
  );

  const byStatus = useCallback(
    // The route already answers in the board's order — priority first, then the
    // most recently moved — so a group is a filter over that and never a second
    // sort, which would be this file deciding what `TASK_PRIORITIES` decides.
    (status: TaskStatusDTO) => visible.filter((t) => t.status === status),
    [visible],
  );

  const closed = useMemo(
    () => visible.filter((t) => t.status === "done" || t.status === "dropped"),
    [visible],
  );

  const truncated = total > tasks.length;

  /**
   * One move, decided by the server.
   *
   * The button set below is the operator's own edges, but the row it is pressed
   * against may have moved since the poll drew it — so the refusal is rendered
   * rather than assumed away, and the board is re-read either way.
   */
  async function move(task: TaskListItemDTO, to: TaskStatusDTO, verb: string) {
    if (moving) return;
    setMoving(`${task.id}:${to}`);
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

  const parentTitle = (id: string) =>
    tasks.find((t) => t.id === id)?.title ?? null;

  /** The three ways of having nothing, told apart before anything is drawn. */
  const unreadable = pollError !== null && tasks.length === 0;
  const boardIsEmpty = !unreadable && loaded && total === 0;
  const filterMatchedNone =
    !unreadable && loaded && total > 0 && visible.length === 0;

  /** What the select's options are, so a press can keep the label it chose. */
  function pick(key: string) {
    if (key === EVERY_PROJECT) return setPlace({ key, label: "" });
    if (key === NO_PROJECT) {
      return setPlace({ key, label: "tasks with no project" });
    }
    setPlace({
      key,
      label: places.find(([candidate]) => candidate === key)?.[1] ?? key,
    });
  }

  function taskRows(rows: TaskListItemDTO[], withStatus: boolean) {
    return rows.map((task) => {
      const acted = actingRun(task);
      const hasRunFact = acted !== null || task.runCount > 0;
      return (
        <Tr key={task.id}>
          <Td className="w-full max-w-0 align-top max-md:max-w-none">
            {/* The task's own page, rather than a card this page opened above
                itself. A link and not a button: the row is a destination, so
                ⌘-click opens the brief beside the board instead of replacing
                it. */}
            <Link
              href={`/tasks/${task.id}`}
              className="font-medium text-ink no-underline hover:text-accent max-md:inline-flex max-md:min-h-11 max-md:items-center"
            >
              {task.title}
            </Link>
            {/* No brief here at all, which is a measurement rather than a
                preference. This cell is `w-full` over a table whose other six
                columns are min-widths, so it is whatever they leave: about
                190px on a 1280px window with the shell beside it. The brief
                wrapped to two muted lines under every title, and clipped to one
                it showed twenty-odd characters of two hundred — texture, not a
                sentence, and still a line per row. It is on the task's own page,
                which the title links to, and the width it gives up is the width
                the title reads in. */}
            {task.parentTaskId && (
              <span className="mt-0.5 block text-xs text-ink-faint">
                Filed under{" "}
                {parentTitle(task.parentTaskId) ? (
                  `“${parentTitle(task.parentTaskId)}”`
                ) : (
                  <span className="mono">{shortId(task.parentTaskId)}</span>
                )}
              </span>
            )}
          </Td>
          <Td
            label="Project"
            labelPlacement="above"
            className="align-top text-ink-muted"
          >
            {task.folder === null ? (
              <span className="text-ink-faint">Unassigned</span>
            ) : (
              <span className="block max-w-[36ch] max-md:break-all">
                {fmtTaskPlace(task)}
              </span>
            )}
          </Td>
          {/* Who filed it, and only that: one noun, and the filing run's id
              after it when there is one. The verb the sentence on a task's own
              page carries is this column's heading here. `labelPlacement` goes
              back to the default with the stack — `above` is for a value that is
              prose or a list, and this is a reading again. */}
          <Td label="From" className="align-top whitespace-nowrap text-ink-muted">
            {task.createdByRunId ? (
              <RunLink
                label={TASK_ORIGIN_WORD[task.origin]}
                runId={task.createdByRunId}
              />
            ) : (
              TASK_ORIGIN_WORD[task.origin]
            )}
          </Td>
          <Td
            // No value, no field name. `Td` draws its label only below the
            // breakpoint, so a task nothing has run against would otherwise
            // carry a "Runs" heading over an empty line where the desktop column
            // is simply blank. The alternative — a faint "None" on every open
            // row — is a column of the word none.
            label={hasRunFact ? "Runs" : undefined}
            className="align-top whitespace-nowrap text-ink-muted"
          >
            {acted ? (
              <RunLink label={acted.label} runId={acted.runId} />
            ) : (
              task.runCount > 0 && (
                // The count rather than the ids: `runs.task_id` is unbounded and
                // its links are what stacked this column, and `runCount` is the
                // true total where `runIds` stops at `MAX_TASK_RUN_LINKS`. A
                // link and not a figure, so the runs behind it stay one press
                // away — on the page that lists every one of them.
                <Link href={`/tasks/${task.id}`} className="block">
                  {task.runCount} {task.runCount === 1 ? "run" : "runs"}
                </Link>
              )
            )}
          </Td>
          <Td label="Priority" className="align-top">
            <span className="flex flex-wrap gap-1.5">
              <Badge tone={TASK_PRIORITY_TONE[task.priority]}>
                {task.priority}
              </Badge>
              {withStatus &&
                task.status !== "open" &&
                task.status !== "claimed" && (
                  <Badge tone={TASK_STATUS_TONE[task.status]}>
                    {task.status}
                  </Badge>
                )}
            </span>
          </Td>
          <Td
            label="Updated"
            className="align-top whitespace-nowrap text-ink-muted tabular-nums"
          >
            {fmtRelative(task.updatedAt, fetchedAt)}
          </Td>
          <Td label="Move" className="align-top">
            {/* No `gap` of its own: `ButtonRow` states `gap-2` and Tailwind emits
                a numeric utility's values ascending, so a caller's smaller gap on
                the same element is a no-op that reads as a decision. */}
            <ButtonRow className="justify-end">
              {task.status === "claimed" && (
                <Button
                  variant="ghost"
                  size="compact"
                  onClick={() => void move(task, "open", "release")}
                  busy={moving === `${task.id}:open`}
                >
                  Release
                </Button>
              )}
              {(task.status === "open" || task.status === "claimed") && (
                <>
                  <Button
                    variant="secondary"
                    size="compact"
                    onClick={() => void move(task, "done", "complete")}
                    busy={moving === `${task.id}:done`}
                  >
                    Done
                  </Button>
                  <Button
                    variant="ghost"
                    size="compact"
                    onClick={() => void move(task, "dropped", "drop")}
                    busy={moving === `${task.id}:dropped`}
                  >
                    Drop
                  </Button>
                </>
              )}
              {(task.status === "done" || task.status === "dropped") && (
                <Button
                  variant="ghost"
                  size="compact"
                  onClick={() => void move(task, "open", "re-open")}
                  busy={moving === `${task.id}:open`}
                >
                  Re-open
                </Button>
              )}
            </ButtonRow>
          </Td>
        </Tr>
      );
    });
  }

  function taskTable(
    rows: TaskListItemDTO[],
    caption: string,
    withStatus = false,
  ) {
    return (
      <TableWrap>
        <Table stack>
          <caption className="sr-only">{caption}</caption>
          <THead>
            <tr>
              <Th scope="col" className="w-full">
                Task
              </Th>
              <Th scope="col" className="min-w-[160px]">
                Project
              </Th>
              {/* Two columns rather than one, so neither has to stack: "From"
                  is who filed the task and "Runs" is what has acted on it
                  since, and one column holding both was a cell taller than the
                  title beside it. Both floors are set to their own longest
                  reading and no wider — "Orchestrator" and "Closed by" with a
                  short id — because the Task column is `w-full` over these and
                  every pixel written here is one taken off the title. */}
              <Th scope="col" className="min-w-[104px]">
                From
              </Th>
              <Th scope="col" className="min-w-[128px]">
                Runs
              </Th>
              <Th scope="col" className="min-w-[92px]">
                Priority
              </Th>
              <Th scope="col" className="min-w-[104px]">
                Updated
              </Th>
              {/* Wide enough for the three a claimed row draws — Release,
                  Done and Drop — which otherwise wrap into a ragged block that
                  reads as two groups of controls. */}
              <Th scope="col" className="min-w-[232px]">
                Move
              </Th>
            </tr>
          </THead>
          <TBody>{taskRows(rows, withStatus)}</TBody>
        </Table>
      </TableWrap>
    );
  }

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="mb-1 text-xl font-semibold tracking-tight">
            Taskboard
          </h1>
          <p className="max-w-[68ch] text-ink-muted">
            A <strong className="font-semibold text-ink">task</strong> is a
            brief nobody has started — the text an agent would be handed, and
            the folder it belongs to. Writing one down costs nothing; starting
            the work is a separate press.
          </p>
        </div>
        <ButtonLink href="/tasks/new" variant="primary">
          New task
        </ButtonLink>
      </div>

      <div role="alert">
        {pollError && <Notice tone="danger">{pollError}</Notice>}
        {actionError && <Notice tone="danger">{actionError}</Notice>}
      </div>
      {note && (
        <Notice tone="info" live>
          {note}
        </Notice>
      )}
      {truncated && (
        <Notice tone="warn">
          Showing {tasks.length} of {total} tasks — the newest {MAX_TASK_PAGE}{" "}
          by priority. The groups and the project filter below reach only these.
        </Notice>
      )}

      {loaded && !unreadable && total > 0 && (
        <Card emphasis="quiet" className="mb-6">
          <Field
            label="Project"
            htmlFor="task-place"
            hint="Every mount by default"
          >
            <div className="w-80">
              <Select
                id="task-place"
                value={place.key}
                onChange={(e) => pick(e.target.value)}
              >
                <option value={EVERY_PROJECT}>
                  Every project ({tasks.length})
                </option>
                {unassignedCount > 0 && (
                  <option value={NO_PROJECT}>
                    Unassigned ({unassignedCount})
                  </option>
                )}
                {places.map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </Select>
            </div>
          </Field>
          {/* The list is replaced without anything moving focus, so the count
              is announced rather than only drawn. */}
          <span className="sr-only" aria-live="polite">
            {visible.length} of {tasks.length} tasks shown
          </span>
        </Card>
      )}

      {!loaded ? (
        <Card emphasis="primary">
          <div aria-busy="true">
            <span className="sr-only">Reading the board…</span>
            <SkeletonText lines={4} />
          </div>
        </Card>
      ) : unreadable ? (
        // The first of the three nothings, and the one that must never render
        // as an empty board: nothing here says the backlog is clear, because
        // nobody knows whether it is. The notice above carries the reason.
        <Card emphasis="quiet">
          <Empty>
            <div className="font-medium text-ink">
              The board could not be read
            </div>
            <div className="mx-auto mt-1 max-w-[52ch]">
              This is a failed request rather than an empty backlog — nothing
              here says whether there is work waiting.
            </div>
            <div className="mt-3">
              <Button variant="secondary" onClick={() => void load()}>
                Try again
              </Button>
            </div>
          </Empty>
        </Card>
      ) : boardIsEmpty ? (
        <Card emphasis="primary">
          <Empty>
            <div className="font-medium text-ink">Nothing on the board</div>
            <div className="mx-auto mt-1 max-w-[52ch]">
              A task is a brief somebody writes down so it is not lost — the
              orchestrator, a workflow block and a work cycle can each file one,
              and so can you.
            </div>
            <div className="mt-3">
              <ButtonLink href="/tasks/new" variant="secondary">
                File one
              </ButtonLink>
            </div>
          </Empty>
        </Card>
      ) : filterMatchedNone ? (
        <Card emphasis="primary">
          <Empty>
            <div className="font-medium text-ink">No tasks in {place.label}</div>
            <div className="mx-auto mt-1 max-w-[52ch]">
              The board holds {tasks.length}
              {truncated ? ` of ${total}` : ""}, and this filter matched none of
              them.
            </div>
            <div className="mt-3">
              <Button
                variant="secondary"
                onClick={() => pick(EVERY_PROJECT)}
              >
                Show every project
              </Button>
            </div>
          </Empty>
        </Card>
      ) : (
        <>
          {OPEN_GROUPS.map((group, index) => {
            const rows = byStatus(group.status);
            return (
              <div key={group.status}>
                <CardTitle>
                  {group.title}
                  <Badge tone="neutral">{rows.length}</Badge>
                </CardTitle>
                {/* One `primary` per screen: the first group with anything in
                    it leads. */}
                <Card
                  emphasis={index === 0 && rows.length > 0 ? "primary" : "default"}
                  className="mb-6"
                >
                  {rows.length === 0 ? (
                    <Empty>{group.empty}</Empty>
                  ) : (
                    taskTable(rows, `${group.title} tasks, most urgent first`)
                  )}
                </Card>
              </div>
            );
          })}

          {closed.length > 0 && (
            // Folded rather than dropped: closed work is what says a backlog is
            // moving, and it is evidence rather than something to act on —
            // which is what a `Disclosure` is for here.
            <Disclosure summary="Closed" count={closed.length} className="mb-6">
              <div className="mt-3">
                {CLOSED_GROUPS.map((group) => {
                  const rows = byStatus(group.status);
                  if (rows.length === 0) return null;
                  return (
                    <div key={group.status}>
                      <CardTitle>
                        {group.title}
                        <Badge tone={TASK_STATUS_TONE[group.status]}>
                          {rows.length}
                        </Badge>
                      </CardTitle>
                      <Card emphasis="quiet" className="mb-4">
                        {taskTable(
                          rows,
                          `${group.title} tasks, most urgent first`,
                        )}
                      </Card>
                    </div>
                  );
                })}
              </div>
            </Disclosure>
          )}
        </>
      )}
    </>
  );
}
