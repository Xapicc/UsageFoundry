import type { TaskDTO, TaskDepRefDTO, TaskDepsDTO, TaskStatusDTO } from "./apiTypes";
import { linkKey } from "./canvasGraph";
import { fmtTaskPlace, fmtTaskRefPlace } from "./format";

/**
 * One task's neighbourhood as a graph: which tasks to draw and which arrows.
 *
 * Here rather than beside the component that draws it, on `canvasView.ts`'s
 * grounds and for its reason: **a graph assembled wrongly draws a plausible
 * picture.** An arrow the wrong way round, a node quietly dropped, a second
 * level that reached back and pulled in half the board — none of those throws,
 * none fails a typecheck, and every one of them reads as an ordering somebody
 * wrote down. `src/lib` is what `tsconfig.test.json` compiles, so the assembly
 * is assertable and the component is left with nothing but pixels.
 *
 * **Pure, and the reads are the caller's.** Everything here is derived from
 * `TaskDepsDTO`s the caller already has: the anchor's own, which rides its
 * `TaskDTO`, and one per level-one neighbour, which is what
 * `GET /api/tasks/[id]/deps` answers. Nothing in this file fetches, and a
 * neighbour whose read failed is simply absent from `beyond` — the graph is
 * then one level deep on that side and the caller says so, rather than this
 * function inventing a reading for it.
 *
 * ## Which way the arrow points
 *
 * `from` happens first and `to` waits for it, which is the reverse of the way a
 * `TaskDepsDTO` lists things: `dependsOn` names the tasks in *front* of its
 * owner, so each becomes `{ from: ref.id, to: owner }`. The direction is the
 * whole readability of the drawing — `autoLayout` layers by longest path from a
 * node with nothing in front of it, so with the arrows this way round
 * everything left of a node is what it is waiting on. Flipped, the layout is
 * still a valid picture of a different claim, and nothing anywhere would say so.
 *
 * ## Why the second level only goes outwards
 *
 * A dependency contributes its own `dependsOn` and a dependent its own
 * `dependents`. Expanding both ways at level one would pull in every *sibling*
 * — the other tasks that happen to wait for the same thing — and those are not
 * this task's neighbourhood in any sense a reader is asking about; on a
 * dependency that half the board waits for, it is most of the board. The cone
 * that is left answers the two questions the page is for: what is in front of
 * this, and what is behind it.
 *
 * Edges are kept **both** ways regardless, as long as both ends are already on
 * the graph. Two of this task's dependencies with an ordering between them is a
 * real edge between two nodes that are being drawn anyway, and leaving it out
 * would draw them as unrelated.
 */

/** A task on the graph, with everything a reader needs to identify it. */
export interface TaskDepGraphNode {
  id: string;
  title: string;
  status: TaskStatusDTO;
  /**
   * The project, or null when it is the one the anchor is in.
   *
   * Null rather than the string, because the page already states the anchor's
   * project above the graph and repeating it on every node spends the one line
   * a node has on the fact that nothing crosses a boundary. An edge that *does*
   * cross one is the case the whole field exists for, and it is the one that
   * renders.
   */
  place: string | null;
}

/** `from` happens first. The arrowhead belongs at `to`, which is what waits. */
export interface TaskDepGraphEdge {
  from: string;
  to: string;
}

export interface TaskDepGraphDTO {
  /** The anchor first, then the order the neighbourhoods named them in. */
  nodes: TaskDepGraphNode[];
  edges: TaskDepGraphEdge[];
  /**
   * Whether any neighbourhood this graph was built from had more edges than it
   * carried refs for.
   *
   * `TaskDepsDTO`'s lists stop at `MAX_TASK_DEP_LINKS` and its counts do not,
   * and its own docblock says anything drawing the graph must check that rather
   * than treat a list as the edge set. A drawing that is missing nodes and says
   * nothing is the failure worth naming here: unlike a clipped list of links,
   * an incomplete picture of an ordering does not look incomplete.
   */
  clipped: boolean;
}

/** Whether a neighbourhood carried fewer refs than it counted edges. */
function isClipped(deps: TaskDepsDTO): boolean {
  return (
    deps.dependsOnCount > deps.dependsOn.length ||
    deps.dependentCount > deps.dependents.length
  );
}

/**
 * The neighbourhood of `task`, two levels out, from reads the caller has made.
 *
 * `beyond` is keyed by task id and holds the neighbourhood of each level-one
 * neighbour. Anything else in it is ignored rather than trusted: an entry for a
 * task that is not on the graph can only contribute edges to nodes that are,
 * and a caller that over-fetched should not be able to widen the drawing by
 * accident.
 */
export function taskNeighbourhoodGraph(
  task: Pick<TaskDTO, "id" | "title" | "status" | "folder" | "mountLabel" | "relPath" | "deps">,
  beyond: ReadonlyMap<string, TaskDepsDTO>,
): TaskDepGraphDTO {
  const here = fmtTaskPlace(task);
  const nodes = new Map<string, TaskDepGraphNode>([
    [task.id, { id: task.id, title: task.title, status: task.status, place: null }],
  ]);

  const addNode = (ref: TaskDepRefDTO) => {
    // First naming wins, so a task reached both as a dependency and as
    // somebody else's dependent is one node rather than the second read's
    // version of it.
    if (nodes.has(ref.id)) return;
    const place = fmtTaskRefPlace(ref);
    nodes.set(ref.id, {
      id: ref.id,
      title: ref.title,
      status: ref.status,
      place: place === here ? null : place,
    });
  };

  for (const ref of task.deps.dependsOn) addNode(ref);
  for (const ref of task.deps.dependents) addNode(ref);
  // Outwards only; see the header. A neighbour that was not read contributes
  // nothing and the graph is one level deep on that side.
  for (const ref of task.deps.dependsOn) {
    for (const far of beyond.get(ref.id)?.dependsOn ?? []) addNode(far);
  }
  for (const ref of task.deps.dependents) {
    for (const far of beyond.get(ref.id)?.dependents ?? []) addNode(far);
  }

  const edges = new Map<string, TaskDepGraphEdge>();
  const addEdge = (from: string, to: string) => {
    // An edge to a node that is not being drawn would be an arrow into empty
    // space, which is what the level-two cone leaves at its rim.
    if (!nodes.has(from) || !nodes.has(to) || from === to) return;
    edges.set(linkKey({ from, to }), { from, to });
  };
  const edgesOf = (ownerId: string, deps: TaskDepsDTO) => {
    for (const ref of deps.dependsOn) addEdge(ref.id, ownerId);
    for (const ref of deps.dependents) addEdge(ownerId, ref.id);
  };

  edgesOf(task.id, task.deps);
  for (const [ownerId, deps] of beyond) {
    if (nodes.has(ownerId)) edgesOf(ownerId, deps);
  }

  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    clipped:
      isClipped(task.deps) ||
      [...beyond.entries()].some(([id, deps]) => nodes.has(id) && isClipped(deps)),
  };
}
