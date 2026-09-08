"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  FoldersResponse,
  TaskDTO,
  TaskPriorityDTO,
  WorkspaceFolderDTO,
  WorkspaceMountDTO,
} from "@/lib/apiTypes";
import { actionFailureMessage, jsonRequest } from "@/lib/jsonRequest";
import { Button, ButtonRow } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { Hint } from "@/components/ui/Hint";
import { Notice } from "@/components/ui/Notice";
import { Sheet } from "@/components/ui/Sheet";

/**
 * The task form, on both of the board's editing routes.
 *
 * One component rather than one per route because filing a task and editing one
 * differ by the method and the URL and nothing else — the same fields, the same
 * validation on the far side, the same refusal rendered verbatim. Written twice
 * they would be two copies to keep in step about a pair of fields the door
 * refuses half of.
 *
 * **Never filled from a board row.** The list clips the brief at
 * `MAX_LIST_TASK_BODY` and marks the clip with an ellipsis, so a form seeded
 * from a row and saved writes 200 characters and a `…` over the one field a
 * future agent is handed with nothing else to go on — destroyed by an edit to
 * the title. The `task` prop is the whole task as `GET /api/tasks/[id]`
 * answered it, and the page above does not mount this component until it holds
 * one.
 *
 * **Nothing here decides whether a save is allowed.** `normalizeTaskPatch` and
 * the folder resolver behind the route are the whole of that rule and they are
 * server modules; a refusal comes back as a sentence naming a field or a mount
 * and is shown as it arrived, which is the taskboard's rule for every press.
 */

const PRIORITIES: readonly TaskPriorityDTO[] = [
  "urgent",
  "high",
  "normal",
  "low",
];

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

function draftFrom(task: TaskDTO | null): TaskDraft {
  if (!task) return EMPTY_DRAFT;
  return {
    title: task.title,
    body: task.body,
    priority: task.priority,
    mountId: task.mountId ?? "",
    folder: task.relPath ?? "",
  };
}

/** The pair travels together, which is what the door refuses half of. */
function projectPayload(draft: TaskDraft) {
  return draft.mountId && draft.folder
    ? { mountId: draft.mountId, folder: draft.folder }
    : { mountId: null, folder: null };
}

export function TaskEditor({
  task,
  onSaved,
}: {
  /** The whole task, or `null` to file a new one. */
  task: TaskDTO | null;
  /**
   * A saved edit, so the page around the form is not left drawing the old
   * title, priority or project beside the new ones. Not called for a creation:
   * that navigates to the task it just made.
   */
  onSaved?: (task: TaskDTO) => void;
}) {
  const router = useRouter();
  // Seeded once, from the whole task the page read. Never re-seeded from the
  // prop: the page re-reads the row after every save and after every move, and
  // an effect syncing this back would throw away whatever is being typed the
  // moment one of those landed.
  const [draft, setDraft] = useState<TaskDraft>(() => draftFrom(task));
  const [mounts, setMounts] = useState<WorkspaceMountDTO[]>([]);
  const [folders, setFolders] = useState<WorkspaceFolderDTO[]>([]);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // The picker's own list, read once: a mount going away does not move a task,
  // and a form that stopped offering folders because a mount is briefly
  // unavailable is the failure the list route refuses on the same grounds.
  useEffect(() => {
    void (async () => {
      const res = await jsonRequest<FoldersResponse>("/api/folders");
      if (!res.ok) return;
      setMounts(res.data.mounts ?? []);
      setFolders(res.data.folders ?? []);
    })();
  }, []);

  const folderOptions = folders.filter((f) => f.mountId === draft.mountId);
  // A stored folder the scan no longer offers — a deleted directory, a mount
  // that is not there today — would otherwise be dropped by the select on the
  // next render and saved away without anybody pressing anything.
  const folderMissing =
    draft.mountId !== "" &&
    draft.folder !== "" &&
    !folderOptions.some((f) => f.path === draft.folder);

  async function save() {
    if (saving) return;
    setSaving(true);
    setActionError(null);

    const body = {
      title: draft.title,
      body: draft.body,
      priority: draft.priority,
      ...projectPayload(draft),
    };
    const res = await jsonRequest<{ task: TaskDTO }>(
      task ? `/api/tasks/${task.id}` : "/api/tasks",
      { method: task ? "PATCH" : "POST", body },
    );

    if (!res.ok) {
      setSaving(false);
      // Whatever the server said, verbatim: every refusal on this path names a
      // field or a mount and says what would have been stored, and replacing
      // that with "Could not save" sends the operator back to the same form
      // with the same text in it.
      setActionError(actionFailureMessage(res, "Could not save the task."));
      return;
    }

    if (!task) {
      // Straight to the task that was just filed, which is where the brief,
      // its provenance and the moves are. `saving` is deliberately left on:
      // the route change is what ends this form, and clearing it first flips
      // the button back to idle for the frame before the page goes.
      router.push(`/tasks/${res.data.task.id}`);
      return;
    }
    setSaving(false);
    setNote(`Updated “${res.data.task.title}”`);
    onSaved?.(res.data.task);
  }

  async function remove() {
    if (!task || deleting) return;
    setDeleting(true);
    const res = await jsonRequest<{ ok: true }>(`/api/tasks/${task.id}`, {
      method: "DELETE",
    });
    setDeleting(false);
    setConfirmDelete(false);

    if (!res.ok) {
      setActionError(actionFailureMessage(res, "Could not delete the task."));
      return;
    }
    // Back to the board rather than to a page about a row that is gone.
    router.push("/tasks");
  }

  return (
    <>
      <div role="alert">
        {actionError && <Notice tone="danger">{actionError}</Notice>}
      </div>
      {note && (
        <Notice tone="info" live>
          {note}
        </Notice>
      )}

      <Card emphasis="primary" className="mb-6">
        <Field
          label="Title"
          htmlFor="task-title"
          hint="What the work is, in a line"
        >
          <Input
            id="task-title"
            value={draft.title}
            autoFocus
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
        </Field>

        <Field
          label="Brief"
          htmlFor="task-body"
          hint="What an agent picking this up is handed, and nothing else"
        >
          {/* Taller than the board's editor was: this page exists because the
              brief is the field with something to read in it, and a box that
              shows seven lines of it is what made the inline card hard to work
              with. */}
          <Textarea
            id="task-body"
            value={draft.body}
            rows={16}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
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
                setDraft({ ...draft, mountId: e.target.value, folder: "" })
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
              onChange={(e) => setDraft({ ...draft, folder: e.target.value })}
            >
              <option value="">— pick a folder —</option>
              {/* A stored folder the scan does not offer stays selectable, or
                  the select would silently resolve to the first option and an
                  unrelated save would move the task to it. */}
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
          // On a wrapper, because `Hint` states its own `mt-1.5` and Tailwind
          // emits a numeric utility ascending — a `-mt-2` on the component
          // itself loses to the larger value it wrote.
          <div className="-mt-2">
            <Hint tone="warn" className="mb-3.5">
              This folder is not in the workspace scan right now. Saving
              re-proves it, and an absent mount refuses the save rather than
              clearing the task’s project
            </Hint>
          </div>
        )}

        <ButtonRow className="justify-between">
          <div>
            {task && (
              <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            )}
          </div>
          <ButtonRow>
            {/* A button rather than a link, so it can be held while a save is
                in flight: leaving the page mid-request is how a refusal ends
                up on a screen nobody is looking at. */}
            <Button
              variant="secondary"
              onClick={() => router.push("/tasks")}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void save()} busy={saving}>
              {task ? "Save changes" : "File task"}
            </Button>
          </ButtonRow>
        </ButtonRow>
      </Card>

      <Sheet
        open={confirmDelete}
        onDismiss={() => setConfirmDelete(false)}
        title={`Delete “${task?.title ?? ""}”?`}
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
