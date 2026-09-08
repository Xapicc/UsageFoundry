"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  MAX_TASK_PAGE,
  type FoldersResponse,
  type TaskDTO,
  type TaskListDTO,
  type TaskListItemDTO,
  type TaskPriorityDTO,
  type TaskStatusDTO,
  type WorkspaceFolderDTO,
  type WorkspaceMountDTO,
} from "@/lib/apiTypes";
import {
  fmtRelative,
  pollFailureMessage,
  shortId,
  type BadgeTone,
} from "@/lib/format";
import { actionFailureMessage, jsonRequest } from "@/lib/jsonRequest";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonRow } from "@/components/ui/Button";
import { Card, CardTitle, Empty, SkeletonText } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { Hint } from "@/components/ui/Hint";
import { Notice } from "@/components/ui/Notice";
import { Sheet } from "@/components/ui/Sheet";
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

/**
 * The four words, with the two that mean "get to it" carrying a tone.
 *
 * `normal` and `low` share `neutral` and are told apart by the word rather than
 * by a colour: a backlog where every row is tinted is a backlog with no
 * emphasis in it, which is the thing `urgent` is for.
 */
const PRIORITY_TONE: Record<TaskPriorityDTO, BadgeTone> = {
  urgent: "danger",
  high: "warn",
  normal: "neutral",
  low: "neutral",
};

const PRIORITIES: readonly TaskPriorityDTO[] = [
  "urgent",
  "high",
  "normal",
  "low",
];

/** What a closed row's status is called where the group heading cannot say it. */
const CLOSED_TONE: Record<"done" | "dropped", BadgeTone> = {
  done: "ok",
  dropped: "neutral",
};

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

/** What a row says about where its work is. */
function placeLabel(task: TaskListItemDTO): string {
  if (task.folder === null) return "Unassigned";
  // `describeFolder` answers `mountLabel: null` and the whole stored path when
  // no configured mount contains the folder — a workspace removed from config
  // since the task was filed. The `mountId` is *not* a stand-in for the label
  // there: printing it would name a workspace that is not on this install, and
  // the path is the only true thing left to say.
  if (task.mountLabel === null) return task.relPath ?? task.folder;
  // A task on a mount root has an empty `relPath`, which reads as a missing
  // value rather than as the root — so the mount's own name stands alone.
  return task.relPath ? `${task.mountLabel} / ${task.relPath}` : task.mountLabel;
}

/** Who put this on the board, in a phrase rather than a column of enum words. */
function originPhrase(origin: TaskListItemDTO["origin"]): string {
  if (origin === "operator") return "Filed by hand";
  if (origin === "chat") return "Filed by the orchestrator";
  if (origin === "block") return "Filed by a workflow block";
  return "Filed by a run";
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

/** A form's whole state, which is the DTO's editable half and nothing else. */
interface TaskDraft {
  title: string;
  body: string;
  priority: TaskPriorityDTO;
  mountId: string;
  /** Relative to the mount, which is what the folder picker offers. */
  folder: string;
}

const EMPTY_DRAFT: TaskDraft = {
  title: "",
  body: "",
  priority: "normal",
  mountId: "",
  folder: "",
};

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

  const [mounts, setMounts] = useState<WorkspaceMountDTO[]>([]);
  const [folders, setFolders] = useState<WorkspaceFolderDTO[]>([]);

  // `null` is the editor closed; an id is an edit and `null` inside it a
  // creation, which is what the two routes differ by and nothing else.
  // `ready` is the second half and it is load-bearing — see `openEdit`.
  const [editing, setEditing] = useState<{
    id: string | null;
    ready: boolean;
  } | null>(null);
  const [draft, setDraft] = useState<TaskDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TaskListItemDTO | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
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

  // The picker's own list, read once: a mount going away does not move a task,
  // and a board that stopped listing because a mount is briefly unavailable is
  // the failure the list route refuses on the same grounds.
  useEffect(() => {
    void (async () => {
      const res = await jsonRequest<FoldersResponse>("/api/folders");
      if (!res.ok) return;
      setMounts(res.data.mounts ?? []);
      setFolders(res.data.folders ?? []);
    })();
  }, []);

  /** Every project the board actually names, newest label wins. */
  const places = useMemo(() => {
    const seen = new Map<string, string>();
    for (const task of tasks) {
      if (task.folder === null) continue;
      seen.set(placeKey(task), placeLabel(task));
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

  function openNew() {
    setEditing({ id: null, ready: true });
    setDraft(EMPTY_DRAFT);
    setActionError(null);
    setNote(null);
  }

  /**
   * Open one task for editing, reading the *whole* brief first.
   *
   * **The form is never filled from the row.** The list clips the body at
   * `MAX_LIST_TASK_BODY` and marks the clip with an ellipsis, so a form seeded
   * from a row and saved writes 200 characters and a `…` over the brief — the
   * one field a future agent is handed with nothing else to go on, destroyed by
   * an edit to the title. So the draft is set only from the route that has the
   * whole task, `ready` gates Save until it lands, and a failed read leaves the
   * editor open with the reason and no way to write the clip.
   */
  async function openEdit(row: TaskListItemDTO) {
    setEditing({ id: row.id, ready: false });
    setActionError(null);
    setNote(null);

    const res = await jsonRequest<{ task: TaskDTO }>(`/api/tasks/${row.id}`);
    if (!res.ok) {
      setActionError(
        actionFailureMessage(res, "Could not read the whole brief."),
      );
      return;
    }
    const task = res.data.task;
    setDraft({
      title: task.title,
      body: task.body,
      priority: task.priority,
      mountId: task.mountId ?? "",
      folder: task.relPath ?? "",
    });
    setEditing({ id: row.id, ready: true });
  }

  function closeEditor() {
    setEditing(null);
    setActionError(null);
  }

  /** The pair travels together, which is what the door refuses half of. */
  function projectPayload(next: TaskDraft) {
    return next.mountId && next.folder
      ? { mountId: next.mountId, folder: next.folder }
      : { mountId: null, folder: null };
  }

  async function save() {
    if (!editing || !editing.ready || saving) return;
    setSaving(true);
    setActionError(null);

    const body = {
      title: draft.title,
      body: draft.body,
      priority: draft.priority,
      ...projectPayload(draft),
    };
    const res = await jsonRequest<{ task: TaskDTO }>(
      editing.id ? `/api/tasks/${editing.id}` : "/api/tasks",
      { method: editing.id ? "PATCH" : "POST", body },
    );
    setSaving(false);

    if (!res.ok) {
      // Whatever the server said, verbatim: every refusal on this path names a
      // field or a mount and says what would have been stored, and replacing
      // that with "Could not save" sends the operator back to the same form
      // with the same text in it.
      setActionError(actionFailureMessage(res, "Could not save the task."));
      return;
    }

    setNote(
      editing.id
        ? `Updated “${res.data.task.title}”`
        : `Filed “${res.data.task.title}”`,
    );
    setEditing(null);
    await load();
  }

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

  async function remove() {
    const task = confirmDelete;
    if (!task || deleting) return;
    setDeleting(true);
    const res = await jsonRequest<{ ok: true }>(`/api/tasks/${task.id}`, {
      method: "DELETE",
    });
    setDeleting(false);
    setConfirmDelete(null);

    if (!res.ok) {
      setActionError(actionFailureMessage(res, "Could not delete the task."));
      return;
    }
    setNote(`Deleted “${task.title}”`);
    setEditing(null);
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

  const folderOptions = folders.filter((f) => f.mountId === draft.mountId);
  // A stored folder the scan no longer offers — a deleted directory, a mount
  // that is not there today — would otherwise be dropped by the select on the
  // next render and saved away without anybody pressing anything.
  const folderMissing =
    draft.mountId !== "" &&
    draft.folder !== "" &&
    !folderOptions.some((f) => f.path === draft.folder);

  function taskRows(rows: TaskListItemDTO[], withStatus: boolean) {
    return rows.map((task) => (
      <Tr key={task.id}>
        <Td className="w-full max-w-0 align-top max-md:max-w-none">
          <button
            type="button"
            onClick={() => void openEdit(task)}
            className="cursor-pointer text-left font-medium text-ink hover:text-accent max-md:inline-flex max-md:min-h-11 max-md:items-center"
          >
            {task.title}
          </button>
          {task.body && (
            <span className="mt-0.5 block max-w-[80ch] text-ink-muted">
              {task.body}
            </span>
          )}
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
              {placeLabel(task)}
            </span>
          )}
        </Td>
        <Td
          label="From"
          labelPlacement="above"
          className="align-top text-ink-muted"
        >
          <span className="block">{originPhrase(task.origin)}</span>
          {task.createdByRunId && (
            <RunLink label="by run" runId={task.createdByRunId} />
          )}
          {task.claimedByRunId && (
            <RunLink label="held by run" runId={task.claimedByRunId} />
          )}
          {task.completedByRunId && (
            <RunLink label="closed by run" runId={task.completedByRunId} />
          )}
          {/* Runs started *for* this task, which is the one link here the board
              did not write about itself — the three above are records this page
              keeps and this is `runs.task_id` read back. Drawn last and worded
              "started for", because none of them says the work happened: a run
              named here can have completed without doing the thing, which is
              exactly why nothing closes this task when one ends. */}
          {task.runIds.map((runId) => (
            <RunLink key={runId} label="started for it" runId={runId} />
          ))}
          {/* Named rather than left to be inferred from a list that stops at
              `MAX_TASK_RUN_LINKS`, the rule a shortened diff follows: a row
              showing three of eleven and saying nothing reports a task worked
              eleven times as one worked three times. */}
          {task.runCount > task.runIds.length && (
            <span className="block text-ink-faint">
              and {task.runCount - task.runIds.length} more
            </span>
          )}
        </Td>
        <Td label="Priority" className="align-top">
          <span className="flex flex-wrap gap-1.5">
            <Badge tone={PRIORITY_TONE[task.priority]}>{task.priority}</Badge>
            {withStatus &&
              task.status !== "open" &&
              task.status !== "claimed" && (
                <Badge tone={CLOSED_TONE[task.status]}>{task.status}</Badge>
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
    ));
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
              <Th scope="col" className="min-w-[150px]">
                From
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
        {!editing && (
          <Button variant="primary" onClick={openNew}>
            New task
          </Button>
        )}
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

      {editing && (
        <>
          <CardTitle>{editing.id ? "Edit task" : "New task"}</CardTitle>
          {/* The one thing the page is about while it is open, so it takes the
              emphasis and the board below gives it up. */}
          <Card emphasis="primary" className="mb-6">
            {!editing.ready ? (
              <div aria-busy="true">
                <span className="sr-only">Reading the whole brief…</span>
                <SkeletonText lines={5} />
                <ButtonRow className="mt-4 justify-end">
                  <Button variant="secondary" onClick={closeEditor}>
                    Cancel
                  </Button>
                </ButtonRow>
              </div>
            ) : (
              <>
                <Field
                  label="Title"
                  htmlFor="task-title"
                  hint="What the work is, in a line"
                >
                  <Input
                    id="task-title"
                    value={draft.title}
                    autoFocus
                    onChange={(e) =>
                      setDraft({ ...draft, title: e.target.value })
                    }
                  />
                </Field>

                <Field
                  label="Brief"
                  htmlFor="task-body"
                  hint="What an agent picking this up is handed, and nothing else"
                >
                  <Textarea
                    id="task-body"
                    value={draft.body}
                    rows={7}
                    onChange={(e) =>
                      setDraft({ ...draft, body: e.target.value })
                    }
                  />
                </Field>

                <Field label="Priority" htmlFor="task-priority">
                  <div className="w-48">
                    <Select
                      id="task-priority"
                      value={draft.priority}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          priority: e.target.value as TaskPriorityDTO,
                        })
                      }
                    >
                      {PRIORITIES.map((priority) => (
                        <option key={priority} value={priority}>
                          {priority}
                        </option>
                      ))}
                    </Select>
                  </div>
                </Field>

                <Field
                  label="Workspace"
                  htmlFor="task-mount"
                  hint="A mount and a folder together, or neither"
                >
                  <div className="w-64">
                    <Select
                      id="task-mount"
                      value={draft.mountId}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          mountId: e.target.value,
                          folder: "",
                        })
                      }
                    >
                      <option value="">— no project —</option>
                      {mounts.map((mount) => (
                        <option key={mount.id} value={mount.id}>
                          {mount.label}
                          {mount.available ? "" : "  (not mounted)"}
                        </option>
                      ))}
                    </Select>
                  </div>
                </Field>

                <Field
                  label="Folder"
                  htmlFor="task-folder"
                  hint={
                    draft.mountId
                      ? "Proved against the mount when the task is saved"
                      : "Pick a workspace first"
                  }
                >
                  <div className="w-72">
                    <Select
                      id="task-folder"
                      value={draft.folder}
                      disabled={!draft.mountId}
                      onChange={(e) =>
                        setDraft({ ...draft, folder: e.target.value })
                      }
                    >
                      <option value="">— pick a folder —</option>
                      {/* A stored folder the scan does not offer stays selectable,
                      or the select would silently resolve to the first option
                      and an unrelated save would move the task to it. */}
                      {folderMissing && (
                        <option value={draft.folder}>{draft.folder}</option>
                      )}
                      {folderOptions.map((folder) => (
                        <option key={folder.path} value={folder.path}>
                          {folder.path}
                          {folder.isGitRepo ? "  (git)" : ""}
                        </option>
                      ))}
                    </Select>
                  </div>
                </Field>
                {folderMissing && (
                  // On a wrapper, because `Hint` states its own `mt-1.5` and
                  // Tailwind emits a numeric utility ascending — a `-mt-2` on the
                  // component itself loses to the larger value it wrote.
                  <div className="-mt-2">
                    <Hint tone="warn" className="mb-3.5">
                      This folder is not in the workspace scan right now. Saving
                      re-proves it, and an absent mount refuses the save rather
                      than clearing the task’s project
                    </Hint>
                  </div>
                )}

                <ButtonRow className="justify-between">
                  <div>
                    {editing.id && (
                      <Button
                        variant="danger"
                        onClick={() =>
                          setConfirmDelete(
                            tasks.find((t) => t.id === editing.id) ?? null,
                          )
                        }
                      >
                        Delete
                      </Button>
                    )}
                  </div>
                  <ButtonRow>
                    <Button
                      variant="secondary"
                      onClick={closeEditor}
                      disabled={saving}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      onClick={() => void save()}
                      busy={saving}
                    >
                      {editing.id ? "Save changes" : "File task"}
                    </Button>
                  </ButtonRow>
                </ButtonRow>
              </>
            )}
          </Card>
        </>
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
              <Button variant="secondary" onClick={openNew}>
                File one
              </Button>
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
                    it leads, and the editor above outranks both while it is
                    open. */}
                <Card
                  emphasis={
                    !editing && index === 0 && rows.length > 0
                      ? "primary"
                      : "default"
                  }
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
                        <Badge tone={CLOSED_TONE[group.status]}>
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

      <Sheet
        open={confirmDelete !== null}
        onDismiss={() => setConfirmDelete(null)}
        title={`Delete “${confirmDelete?.title ?? ""}”?`}
        confirmLabel="Delete"
        confirmVariant="danger"
        busy={deleting}
        onConfirm={() => void remove()}
      >
        <p>
          The brief goes with it and there is no undo. Nothing running is
          affected — a task holds no folder, no concurrency slot and no child
          process.
        </p>
        <p className="mt-2">
          If the work should simply not happen, drop it instead: a dropped task
          stays on the board where somebody can disagree with it.
        </p>
      </Sheet>
    </>
  );
}
