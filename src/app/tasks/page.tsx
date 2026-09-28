"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import {
  MAX_TASK_PAGE,
  type TaskDTO,
  type TaskDepRefDTO,
  type TaskDepsDTO,
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
import {
  actionFailureMessage,
  jsonRequest,
  type JsonFailure,
  type JsonResult,
} from "@/lib/jsonRequest";
import {
  ClosedTasksChart,
  OpenTasksChart,
  closedTaskSeries,
  openTaskSeries,
} from "@/components/OpenTasksChart";
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
 * **The whole board is read, one status at a time, and the project filter
 * narrows here.** Status is narrowed in the query, on
 * `docs/agent/conventions.md`'s rule: the board used to take the newest
 * `MAX_TASK_PAGE` rows across every status, and because the order is priority
 * first, old urgent work that was long done outranked today's normal work —
 * measured 2026-09-26, 649 closed tasks hid 77 of 154 open and 5 of 13 claimed,
 * while the notice spoke only of the total. Each status is now its own listing
 * with its own offset, paged to its end, so the size of the closed pile can no
 * longer decide what the open groups show. The project
 * filter stays in the browser because its options are built from the same rows
 * the board draws, so the select can never offer a project the board cannot
 * show or hide one it can; drawn from anywhere else they would need a mount
 * root joined to a relative path in the browser, which is the second, looser
 * resolver `docs/agent/taskboard.md` exists to prevent. The operator-only filter
 * sits beside it and follows it: in the browser, over the same rows, and not
 * kept in the URL, because the project filter is not.
 */

/**
 * The dashboard's cadence, and this poll does **not** stand down.
 *
 * A run's page gates its 3s interval on the row being live because a terminal
 * run cannot change on its own. A board has no such state: a row can be filed
 * or claimed by a door this page does not own — a chat turn, a work cycle —
 * whatever the board currently holds, and a board of nothing but closed work is
 * exactly when a newly filed task is the thing worth seeing. So there is no
 * gate to re-arm, and the cost is the whole board every ten seconds: a request
 * per status, plus one per `MAX_TASK_PAGE` rows a status holds beyond the first.
 */
const POLL_MS = 10_000;

/** Every status group the board draws, in the order it draws them. */
const OPEN_GROUPS = [
  {
    status: "claimed" as const,
    title: "Claimed",
    empty: "No task is being worked",
  },
  {
    status: "open" as const,
    title: "Open",
    empty: "Nothing open",
  },
];

const CLOSED_GROUPS = [
  { status: "done" as const, title: "Done" },
  { status: "dropped" as const, title: "Dropped" },
];

/** What the board asks for is exactly what it draws, in the order it draws it. */
const BOARD_STATUSES: TaskStatusDTO[] = [
  ...OPEN_GROUPS.map((group) => group.status),
  ...CLOSED_GROUPS.map((group) => group.status),
];

type BoardRead = { ok: true; tasks: TaskListItemDTO[] } | JsonFailure;

async function readPage(
  status: TaskStatusDTO,
  offset: number,
): Promise<JsonResult<TaskListDTO>> {
  const res = await jsonRequest<TaskListDTO>(
    `/api/tasks?status=${status}&limit=${MAX_TASK_PAGE}&offset=${offset}`,
  );
  if (res.ok && !Array.isArray(res.data.tasks)) {
    return { ok: false, status: 200, error: "no tasks in the response" };
  }
  return res;
}

/**
 * Every task in one status, in the route's order, however many pages it takes.
 *
 * The first page says how many there are, and the rest are asked for together
 * rather than one after another. The step is the first page's length rather
 * than its `limit`, so the loop is driven by rows that arrived and cannot spin
 * on a field `jsonRequest`'s cast never checked.
 */
async function readStatus(status: TaskStatusDTO): Promise<BoardRead> {
  const first = await readPage(status, 0);
  if (!first.ok) return first;
  const step = first.data.tasks.length;
  const offsets: number[] = [];
  for (let offset = step; step > 0 && offset < first.data.total; offset += step) {
    offsets.push(offset);
  }
  const rest = await Promise.all(offsets.map((offset) => readPage(status, offset)));

  const tasks: TaskListItemDTO[] = [];
  for (const page of [first, ...rest]) {
    if (!page.ok) return page;
    tasks.push(...page.data.tasks);
  }
  return { ok: true, tasks };
}

/**
 * The whole board, or the first reason it could not be read.
 *
 * All or nothing: a board missing one status would draw that group as empty,
 * which reads as a clear backlog rather than a failed read. A row can move
 * between the requests — closed while Done was being read, or bumped up a page
 * while the next was in flight — so it is kept once by id; one that slipped
 * between two pages is back on the next poll.
 */
async function readBoard(): Promise<BoardRead> {
  const reads = await Promise.all(BOARD_STATUSES.map(readStatus));
  const byId = new Map<string, TaskListItemDTO>();
  for (const read of reads) {
    if (!read.ok) return read;
    for (const task of read.tasks) {
      if (!byId.has(task.id)) byId.set(task.id, task);
    }
  }
  return { ok: true, tasks: [...byId.values()] };
}

/**
 * The project filter's two special values. Neither can collide with a real key:
 * `placeKey` below encodes a pair as JSON, so every project's key begins `["`.
 */
const EVERY_PROJECT = "";
const NO_PROJECT = "unassigned";

/**
 * Whose work a row is: the operator-only filter's three values.
 *
 * `operatorOnly` is a flag rather than a status, so this narrows across every
 * status group rather than being one — an operator-only task is still open.
 */
type Lane = "all" | "agent" | "operator";

const LANE_OPTIONS: ReadonlyArray<{ value: Lane; label: string; noun: string }> = [
  { value: "all", label: "All work", noun: "tasks" },
  { value: "agent", label: "Agent work", noun: "agent work" },
  { value: "operator", label: "Operator only", noun: "operator-only tasks" },
];

function inLane(task: TaskListItemDTO, lane: Lane): boolean {
  if (lane === "all") return true;
  return task.operatorOnly === (lane === "operator");
}

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
 * in it: the holder, the closer, and every run `run_tasks` links to it. They
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

/**
 * The one neighbour a line names, linked, or how many there are.
 *
 * **One, and it is a measurement rather than a preference.** This cell is
 * whatever six min-width columns leave — about 150px at 1280px with the shell
 * beside it — and what goes in it is task titles rather than words, so a title
 * is already two wrapped lines there. Two a side was measured at six lines under
 * a two-line heading: a paragraph, which is the shape the brief was taken out of
 * this cell for. The stacked layout at 390px would carry more, since a stacked
 * cell is the whole card width, and deliberately does not get it — a line that
 * named two neighbours on a phone and counted them on a laptop is two boards.
 *
 * `count` rather than `refs.length` decides: the lists on a `TaskDepsDTO` stop
 * at `MAX_TASK_DEP_LINKS` and the counts do not, so a row reading the list would
 * report a task waiting on fourteen things as one waiting on ten.
 */
function depNames(refs: readonly TaskDepRefDTO[], count: number): ReactNode {
  const only = count === 1 ? refs[0] : undefined;
  if (!only) return `${count} tasks`;
  return <Link href={`/tasks/${only.id}`}>{only.title}</Link>;
}

/**
 * What a row waits for and what waits for it, in one line, or nothing at all.
 *
 * **Nothing at all is the common case and is the point.** Most tasks have no
 * ordering, and a faint marker on every row saying so is what a board looks
 * like when every row answers a question nobody asked — the Runs cell's
 * decision one column over, and the comment count's in this cell.
 *
 * **The blocking half of `dependsOn` is its own front.** `depNeighbourhood`
 * partitions the list so that what is still open comes first and
 * `TaskDepsDTO` states it, so `slice(0, blockedByCount)` is exactly the
 * dependencies in the way. It is read off the count the server sent rather than
 * re-tested here: `depIsBlocking` is a server module, and a copy of "done
 * clears an edge and nothing else does" in the browser is a second answer to
 * when an ordering is satisfied.
 *
 * **Blocked is a reading and never a gate.** Nothing in this app refuses a
 * press on the strength of an edge, which is why this line sits under a title
 * and not beside the Move buttons: it describes the row, it does not qualify
 * what can be done to it.
 */
function DepLine({ deps }: { deps: TaskDepsDTO }) {
  if (deps.dependsOnCount === 0 && deps.dependentCount === 0) return null;

  const upstream =
    deps.blockedByCount > 0 ? (
      <>
        Blocked by{" "}
        {depNames(deps.dependsOn.slice(0, deps.blockedByCount), deps.blockedByCount)}
      </>
    ) : deps.dependsOnCount > 0 ? (
      // An ordering that has cleared is still an ordering, and a row that drew
      // nothing for it would say this task was never put behind anything.
      <>After {depNames(deps.dependsOn, deps.dependsOnCount)}</>
    ) : null;

  return (
    <span className="mt-0.5 block text-xs text-ink-faint">
      {upstream}
      {upstream && deps.dependentCount > 0 && " · "}
      {deps.dependentCount > 0 && (
        <>
          {upstream ? "blocks " : "Blocks "}
          {depNames(deps.dependents, deps.dependentCount)}
        </>
      )}
    </span>
  );
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<TaskListItemDTO[]>([]);
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
  const [lane, setLane] = useState<Lane>("all");

  const [actionError, setActionError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // The edge in flight, `id:status`, rather than the row: keyed on the row,
  // pressing Done lit Release and Drop as well, which reads as three presses.
  const [moving, setMoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await readBoard();
    if (!res.ok) {
      setPollError(pollFailureMessage(res.status, res.error));
      setLoaded(true);
      return;
    }
    setTasks(res.tasks);
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

  const inPlace = useMemo(
    () =>
      place.key === EVERY_PROJECT
        ? tasks
        : tasks.filter((t) => placeKey(t) === place.key),
    [tasks, place],
  );

  const visible = useMemo(
    () => inPlace.filter((t) => inLane(t, lane)),
    [inPlace, lane],
  );

  // Over the rows both selects narrow to and every status, so choosing a
  // project draws that project's lines; counted at `fetchedAt` for the reason
  // the relative ages are.
  const openSeries = useMemo(
    () => openTaskSeries(visible, fetchedAt),
    [visible, fetchedAt],
  );
  const closedSeries = useMemo(
    () => closedTaskSeries(visible, fetchedAt),
    [visible, fetchedAt],
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
  const boardIsEmpty = !unreadable && loaded && tasks.length === 0;
  const filterMatchedNone =
    !unreadable && loaded && tasks.length > 0 && visible.length === 0;

  /** What the empty state says was asked for, in the words the filters use. */
  const laneNoun = LANE_OPTIONS.find((option) => option.value === lane)!.noun;
  const nothingMatched =
    place.key === EVERY_PROJECT
      ? `No ${laneNoun} on the board`
      : `No ${lane === "all" ? "tasks" : laneNoun} in ${place.label}`;

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
            {/* Under the title rather than in the Priority cell beside the
                other badges: that cell is labelled "Priority" when the table
                stacks, and this is not a priority. Neutral, the rule
                `TASK_PRIORITY_TONE` states — told apart by the word, so the
                board does not gain a colour that competes with urgent. */}
            {task.operatorOnly && (
              <span className="mt-1 block">
                <Badge tone="neutral">operator only</Badge>
              </span>
            )}
            {/* Warn rather than neutral: it is set when a local model's work on
                the task was reviewed and turned down, which is worth seeing
                from the board. */}
            {task.needsFrontier && (
              <span className="mt-1 block">
                <Badge tone="warn">needs frontier</Badge>
              </span>
            )}
            {/* No brief here at all, which is a measurement rather than a
                preference. This cell is `w-full` over a table whose other six
                columns are min-widths, so it is whatever they leave: about
                190px on a 1280px window with the shell beside it. The brief
                wrapped to two muted lines under every title, and clipped to one
                it showed twenty-odd characters of two hundred — texture, not a
                sentence, and still a line per row. It is on the task's own page,
                which the title links to, and the width it gives up is the width
                the title reads in. */}
            {/* The ordering, in this cell and never a column of its own, on the
                comment count's grounds below and for its reason: a seventh
                `min-w` would come straight off the title for a line most rows
                do not draw at all. Above the provenance because it is about the
                work rather than about where the brief came from, and because
                `Blocked by` is the one thing in this cell somebody scanning the
                board is looking for. */}
            <DepLine deps={task.deps} />
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
            {/* The thread's size, in this cell and never a column of its own.
                A seventh `min-w` would come straight off the title — the Task
                column is `w-full` over six of them and is whatever they leave —
                for a figure that is zero on most rows. This cell is the one the
                board deliberately leaves unlabelled, being the headline the
                record is identified by, so a count here is the only placement
                that cannot be mislabelled when `stack` puts each field under
                its own name at 390px: "Priority urgent 3" and "Runs 3" both
                read as a fact about something else.

                Nothing at all at zero rather than a faint "0 comments", which
                is the same decision the Runs cell makes one column over: a
                column of the word none is what a board looks like when every
                row answers a question nobody asked. Not a link either, unlike
                the run count beside it — that one is the only handle its cell
                can give, where the title directly above this is already a link
                to the page the thread is on. */}
            {task.commentCount > 0 && (
              <span className="mt-0.5 block text-xs text-ink-faint">
                {task.commentCount}{" "}
                {task.commentCount === 1 ? "comment" : "comments"}
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
                // The count rather than the ids: `run_tasks` is unbounded and
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
            Filing a task costs nothing; starting the work is a separate press.
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
      {loaded && !unreadable && tasks.length > 0 && (
        <Card emphasis="quiet" className="mb-6">
          <div className="flex flex-wrap gap-x-4">
            <Field label="Project" htmlFor="task-place">
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
            <Field label="Who does it" htmlFor="task-lane">
              <div className="w-56">
                <Select
                  id="task-lane"
                  value={lane}
                  onChange={(e) => setLane(e.target.value as Lane)}
                >
                  {/* Counted within the chosen project, because that is the
                      set this select narrows. */}
                  {LANE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {`${option.label} (${inPlace.filter((t) => inLane(t, option.value)).length})`}
                    </option>
                  ))}
                </Select>
              </div>
            </Field>
            {/* One box, so the pair wraps and aligns as one rather than the
                second chart landing alone under the selects. */}
            <div className="flex min-w-0 max-w-full flex-wrap gap-x-4 xl:ml-auto">
              <OpenTasksChart series={openSeries} />
              <ClosedTasksChart series={closedSeries} />
            </div>
          </div>
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
              The orchestrator, a workflow block and a work cycle can each file
              one, and so can you.
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
            <div className="font-medium text-ink">{nothingMatched}</div>
            <div className="mt-3">
              <Button
                variant="secondary"
                onClick={() => {
                  pick(EVERY_PROJECT);
                  setLane("all");
                }}
              >
                Show every task
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
