"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { MAX_TASK_PAGE } from "@/lib/apiTypes";
import type {
  TaskDTO,
  TaskDepRefDTO,
  TaskDepsDTO,
  TaskListDTO,
} from "@/lib/apiTypes";
import { TASK_STATUS_TONE, fmtTaskPlace, fmtTaskRefPlace } from "@/lib/format";
import { actionFailureMessage, jsonRequest } from "@/lib/jsonRequest";
import { taskNeighbourhoodGraph } from "@/lib/taskDepGraph";
import { Badge } from "@/components/ui/Badge";
import { Button, ButtonRow } from "@/components/ui/Button";
import { Card, CardTitle, Empty } from "@/components/ui/Card";
import { Field, Select } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Notice";
import { TaskDepGraph } from "@/components/TaskDepGraph";

/**
 * What this task waits for and what waits for it: the drawing, the two lists
 * and the one door that writes.
 *
 * **An edge is advisory and this pane has to keep saying so.** Nothing in this
 * app reads `task_deps` when a task is claimed, started or closed —
 * `taskTransitionRefusal` has never heard of it — so a task drawn as blocked is
 * one somebody wrote an ordering for, not one the board is holding back. The
 * word *blocked* is what a reader will take for a gate, which is why the
 * sentence saying it is not sits beside it rather than in `docs/`.
 *
 * **The canvas draws and this form writes.** Adding is a press with two choices
 * in front of it and removing is a press against a named edge; neither is a
 * gesture on the drawing, because a canvas that could delete an ordering would
 * put the one write on this board that no agent may make behind a drag which
 * leaves nothing behind. It is also what keeps the pane usable at 390px, where
 * the drawing is hidden and these lists are the whole of it.
 *
 * **Removal reaches the other task's door, and that is the one thing here that
 * is not symmetrical with what it draws.** `DELETE /api/tasks/[id]/deps` takes
 * the *waiting* task in the path, so taking away an edge into this one is a
 * request against the dependent. Both are the operator's and both are this
 * route; what would be wrong is a page that could only cut the edges it happens
 * to be the near end of.
 *
 * **Nothing here decides what may be written.** The self-edge and the loop are
 * `taskDepRefusal`'s, in a server module a `"use client"` file may not import,
 * and the loop refusal *names the loop it found* — the sentence that says which
 * edge to break. It is rendered exactly as it arrived. The only thing the
 * browser declines to send is a picker nobody has answered, and the one task
 * the picker does not offer is the page it is on: a self-edge is refused by
 * name at the door and stays refused there, but offering the press is an
 * interface asking for something it knows is not an ordering.
 *
 * **It reads on arrival and after every write, and it does not poll.** The page
 * around it refuses to for the reason its own docblock gives, and this pane
 * holds the same kind of state: a half-made choice across two selects. What it
 * reads is each level-one neighbour's own neighbourhood, which is how the
 * drawing gets a second level without a route that answers for one.
 */

/** What the two selects add up to. The wire has one direction; the page has two. */
type Direction = "waits-for" | "blocks";

/** One end of an edge, and the press that takes it away. */
function DepRow({
  dep,
  removing,
  onRemove,
}: {
  dep: TaskDepRefDTO;
  removing: boolean;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-1.5">
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <Link href={`/tasks/${dep.id}`} className="font-medium">
          {dep.title}
        </Link>
        <Badge tone={TASK_STATUS_TONE[dep.status]}>{dep.status}</Badge>
        <span className="text-xs text-ink-faint">{fmtTaskRefPlace(dep)}</span>
      </span>
      <Button
        variant="ghost"
        size="compact"
        onClick={onRemove}
        busy={removing}
        // The title, not "Remove": every row on this pane draws the same word,
        // and a screen reader moving between them would hear one button four
        // times.
        aria-label={`Remove the ordering with ${dep.title}`}
      >
        Remove
      </Button>
    </div>
  );
}

/** A named half of the neighbourhood, or nothing at all when it is empty. */
function DepList({
  heading,
  refs,
  total,
  children,
}: {
  heading: string;
  refs: TaskDepRefDTO[];
  total: number;
  children: (dep: TaskDepRefDTO) => ReactNode;
}) {
  if (total === 0) return null;
  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="mb-1 text-xs font-medium text-ink-muted">{heading}</div>
      {refs.map((dep, index) => (
        // The hairline is written per row rather than as a `first:` variant,
        // the thread's rule one card up: Tailwind emits nothing at all for a
        // variant it does not know, silently. It earns its place below the
        // breakpoint, where a row's Remove wraps under its title and the next
        // row begins with nothing between them.
        <div key={dep.id} className={index === 0 ? "" : "border-t border-line"}>
          {children(dep)}
        </div>
      ))}
      {/* Named rather than left to be inferred, the rule a shortened diff
          follows: a list showing ten of fourteen and saying nothing reports an
          ordering four edges short of itself as a whole one. */}
      {total > refs.length && (
        <div className="text-xs text-ink-faint">
          and {total - refs.length} more, not shown
        </div>
      )}
    </div>
  );
}

export function TaskDependencies({
  task,
  onChanged,
}: {
  task: TaskDTO;
  onChanged: () => Promise<void>;
}) {
  /** Each level-one neighbour's own neighbourhood: the graph's second level. */
  const [beyond, setBeyond] = useState<ReadonlyMap<string, TaskDepsDTO>>(new Map());
  const [beyondError, setBeyondError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<TaskListDTO | null>(null);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  const [direction, setDirection] = useState<Direction>("waits-for");
  const [other, setOther] = useState("");
  // Keyed on the edge rather than on the pane: keyed on the pane, one Remove
  // lights every other one, which reads as every edge going at once. The
  // board's own rule about its Move column.
  const [writing, setWriting] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const deps = task.deps;

  /**
   * The level-one ids as one string, which is what the read below is keyed on.
   *
   * `task.deps` is a fresh object on every read of the row, and the row is
   * re-read after every press that moves the task — so an effect keyed on it
   * would re-issue up to twenty requests each time a status changed. The ids
   * are what the answer actually depends on.
   */
  const neighbourKey = useMemo(
    () =>
      [...new Set([...deps.dependsOn, ...deps.dependents].map((d) => d.id))]
        .sort()
        .join(" "),
    [deps],
  );

  useEffect(() => {
    const ids = neighbourKey === "" ? [] : neighbourKey.split(" ");
    if (ids.length === 0) {
      setBeyond(new Map());
      setBeyondError(null);
      return;
    }
    let alive = true;
    void (async () => {
      const answers = await Promise.all(
        ids.map(
          async (id) =>
            [id, await jsonRequest<TaskDepsDTO>(`/api/tasks/${id}/deps`)] as const,
        ),
      );
      if (!alive) return;
      const read = new Map<string, TaskDepsDTO>();
      let failed = false;
      for (const [id, res] of answers) {
        if (res.ok) read.set(id, res.data);
        else failed = true;
      }
      setBeyond(read);
      // Never a failed read drawn as a rim: what a reader would otherwise take
      // for the end of the ordering is the request stopping, and the two look
      // exactly alike on a graph.
      setBeyondError(
        failed
          ? "One of the neighbouring tasks could not be read, so the graph stops a level short on that side."
          : null,
      );
    })();
    return () => {
      alive = false;
    };
  }, [neighbourKey]);

  const loadCandidates = useCallback(async () => {
    const res = await jsonRequest<TaskListDTO>(`/api/tasks?limit=${MAX_TASK_PAGE}`);
    if (!res.ok) {
      // Not `pollFailureMessage`: nothing here refreshes, and what has gone
      // wrong is that the picker has nothing in it rather than that the page is
      // stale.
      setCandidateError(
        actionFailureMessage(res, "The tasks to choose from could not be read."),
      );
      return;
    }
    setCandidates(res.data);
    setCandidateError(null);
  }, []);

  useEffect(() => {
    void loadCandidates();
  }, [loadCandidates]);

  const graph = useMemo(() => taskNeighbourhoodGraph(task, beyond), [task, beyond]);

  /**
   * One edge written or removed, answering with whether it landed.
   *
   * `waiterId` is the task in the path, which is always the one that waits:
   * that is the whole of what the route's `id` means, in both directions and
   * for both methods.
   */
  async function write(
    key: string,
    method: "POST" | "DELETE",
    waiterId: string,
    dependencyId: string,
    said: string,
  ): Promise<boolean> {
    if (writing) return false;
    setWriting(key);
    setWriteError(null);
    setNote(null);
    const res = await jsonRequest<{ created?: boolean }>(
      `/api/tasks/${waiterId}/deps`,
      { method, body: { dependsOn: dependencyId } },
    );
    setWriting(null);

    if (!res.ok) {
      // Verbatim. A loop refusal names the loop it found and a removal that
      // found nothing says the edge has already gone; both are sentences the
      // operator acts on, and a line of this page's own would throw away the
      // only thing that says which edge to break.
      setWriteError(actionFailureMessage(res, "Could not change the ordering."));
      return false;
    }
    // `created: false` is the door saying the edge was already there. Told
    // apart because a press answered with nothing cannot be told from one that
    // did nothing.
    setNote(res.data.created === false ? "That ordering was already recorded." : said);
    await onChanged();
    return true;
  }

  async function add() {
    if (other === "") return;
    const waits = direction === "waits-for";
    const landed = await write(
      "add",
      "POST",
      waits ? task.id : other,
      waits ? other : task.id,
      waits ? "Recorded: this task now waits for it" : "Recorded: this task now blocks it",
    );
    if (landed) setOther("");
  }

  const nothing = deps.dependsOnCount === 0 && deps.dependentCount === 0;

  return (
    <>
      <CardTitle>Dependencies</CardTitle>
      <Card className="mb-6">
        <div role="alert">
          {beyondError && <Notice tone="warn">{beyondError}</Notice>}
          {candidateError && <Notice tone="warn">{candidateError}</Notice>}
          {writeError && <Notice tone="danger">{writeError}</Notice>}
        </div>
        {note && (
          <Notice tone="info" live>
            {note}
          </Notice>
        )}

        {nothing ? (
          // Not an empty canvas: a surface with nothing on it says the drawing
          // failed as readily as it says there is nothing to draw, and most
          // tasks on this board have no ordering at all.
          <Empty>
            <div className="font-medium text-ink">No ordering recorded</div>
            <div className="mx-auto mt-1 max-w-[52ch]">
              Nothing waits for this task and it waits for nothing. An ordering
              is shown rather than enforced: a task with an open dependency is
              drawn as blocked and can still be claimed, worked and closed by
              everything that could before.
            </div>
          </Empty>
        ) : (
          <>
            <p className="mb-3 max-w-[80ch] text-sm text-ink-muted">
              {deps.blockedByCount > 0
                ? `${deps.blockedByCount} of ${deps.dependsOnCount} ${
                    deps.dependsOnCount === 1 ? "dependency is" : "dependencies are"
                  } still open.`
                : deps.dependsOnCount > 0
                  ? "Everything this task waits for is done."
                  : "This task waits for nothing."}{" "}
              Nothing is held back either way: an ordering is drawn, never
              enforced.
            </p>
            <TaskDepGraph anchorId={task.id} nodes={graph.nodes} edges={graph.edges} />
            {graph.clipped && (
              <Notice tone="warn">
                A task here has more edges than the board sends neighbours for,
                so the graph is missing nodes.
              </Notice>
            )}
          </>
        )}

        <DepList heading="Waits for" refs={deps.dependsOn} total={deps.dependsOnCount}>
          {(dep) => (
            <DepRow
              dep={dep}
              removing={writing === `${task.id} ${dep.id}`}
              onRemove={() =>
                void write(`${task.id} ${dep.id}`, "DELETE", task.id, dep.id, "Removed")
              }
            />
          )}
        </DepList>

        <DepList heading="Blocks" refs={deps.dependents} total={deps.dependentCount}>
          {(dep) => (
            <DepRow
              dep={dep}
              removing={writing === `${dep.id} ${task.id}`}
              onRemove={() =>
                void write(`${dep.id} ${task.id}`, "DELETE", dep.id, task.id, "Removed")
              }
            />
          )}
        </DepList>

        <div className="mt-4 border-t border-line pt-4">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="This task" htmlFor="dep-direction">
              <Select
                id="dep-direction"
                value={direction}
                onChange={(e) => setDirection(e.target.value as Direction)}
              >
                <option value="waits-for">waits for</option>
                <option value="blocks">blocks</option>
              </Select>
            </Field>
            {/* No hint. Both branches above already say that an ordering is
                shown rather than enforced — the paragraph over the graph, or
                the empty state where there is no graph — and a third copy
                under the picker only buys a field that ends lower than the one
                beside it. */}
            <Field label="Task" htmlFor="dep-other">
              <Select
                id="dep-other"
                value={other}
                onChange={(e) => setOther(e.target.value)}
              >
                <option value="">Choose a task…</option>
                {(candidates?.tasks ?? [])
                  // Every task but this one. What this drops is an option that
                  // is never a thing to press; the door's own refusal for a
                  // self-edge is untouched and still answers anything else.
                  .filter((candidate) => candidate.id !== task.id)
                  .map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.title} · {fmtTaskPlace(candidate)}
                    </option>
                  ))}
              </Select>
            </Field>
            <ButtonRow>
              <Button
                variant="secondary"
                onClick={() => void add()}
                busy={writing === "add"}
                // Not the door's rule restated — an empty `dependsOn` is still
                // refused there — but the press declining to spend a request on
                // a picker the operator can see is unanswered.
                disabled={other === ""}
              >
                Add
              </Button>
              {candidateError && (
                <Button variant="ghost" onClick={() => void loadCandidates()}>
                  Try again
                </Button>
              )}
            </ButtonRow>
          </div>
          {candidates !== null && candidates.total > candidates.tasks.length && (
            <p className="mt-2 text-xs text-ink-faint">
              {candidates.tasks.length} of {candidates.total} tasks are offered
              here. One that is not on the list can name this task from its own
              page.
            </p>
          )}
        </div>
      </Card>
    </>
  );
}
