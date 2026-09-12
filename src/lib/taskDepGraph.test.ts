import { strict as assert } from "node:assert";
import { test } from "node:test";
import { taskNeighbourhoodGraph } from "./taskDepGraph";
import type { TaskDepRefDTO, TaskDepsDTO, TaskStatusDTO } from "./apiTypes";

/**
 * What the dependency graph on a task's page is a picture of.
 *
 * This is the bar this repository's suite was built to: **every failure here
 * draws a plausible picture.** An arrow the wrong way round is a readable graph
 * of the opposite ordering; a second level expanded the wrong way pulls in every
 * task that happens to share a dependency and reads as a neighbourhood; an edge
 * kept to a node nobody drew is an arrow into empty space, and one dropped
 * between two nodes that *are* drawn says they are unrelated. None of them
 * throws, none fails a typecheck, and the operator is looking at an ordering
 * they believe somebody wrote down.
 *
 * Nothing here reaches the database or an environment: the builder is a total
 * function of one task and the neighbourhoods its caller has already read, which
 * is why it is in `src/lib` at all rather than beside the component.
 */

/** A neighbour as the wire sends one. Same project as the anchor unless said. */
function ref(id: string, over: Partial<TaskDepRefDTO> = {}): TaskDepRefDTO {
  return {
    id,
    title: `Task ${id}`,
    status: "open",
    mountId: "Main",
    mountLabel: "Main",
    relPath: "RepoOne",
    ...over,
  };
}

/** A neighbourhood with its counts derived, which is what an unclipped read is. */
function hood(
  dependsOn: TaskDepRefDTO[],
  dependents: TaskDepRefDTO[],
  over: Partial<TaskDepsDTO> = {},
): TaskDepsDTO {
  return {
    dependsOn,
    dependsOnCount: dependsOn.length,
    dependents,
    dependentCount: dependents.length,
    blockedByCount: dependsOn.filter((d) => d.status !== "done").length,
    ...over,
  };
}

function anchorTask(deps: TaskDepsDTO) {
  return {
    id: "anchor",
    title: "The task being looked at",
    status: "open" as TaskStatusDTO,
    folder: "/ws/RepoOne",
    mountLabel: "Main",
    relPath: "RepoOne",
    deps,
  };
}

/** The edges as `from>to` strings, which is what an assertion about direction reads as. */
function arrows(graph: { edges: { from: string; to: string }[] }): string[] {
  return graph.edges.map((e) => `${e.from}>${e.to}`).sort();
}

/* ------------------------------------------------------------------ */
/* Which way the arrow points                                          */
/* ------------------------------------------------------------------ */

test("a dependency points at the task that waits, and a dependent points away", () => {
  const graph = taskNeighbourhoodGraph(
    anchorTask(hood([ref("before")], [ref("after")])),
    new Map(),
  );

  // `autoLayout` layers by longest path from a node with nothing in front of
  // it, so this direction is what puts everything the task waits on to the left
  // of it. Reversed, the drawing is a valid picture of the opposite claim and
  // nothing anywhere would say so.
  assert.deepEqual(arrows(graph), ["anchor>after", "before>anchor"]);
  assert.deepEqual(
    graph.nodes.map((n) => n.id),
    ["anchor", "before", "after"],
    "the anchor is the first node, so a reader of the list meets it first",
  );
});

/* ------------------------------------------------------------------ */
/* How far out it goes, and in which direction                         */
/* ------------------------------------------------------------------ */

test("the second level goes outwards only, and a sibling is not a neighbour", () => {
  const graph = taskNeighbourhoodGraph(
    anchorTask(hood([ref("before")], [ref("after")])),
    new Map([
      // `before` is waited on by a task that has nothing to do with the anchor,
      // and waits for one of its own.
      ["before", hood([ref("far-before")], [ref("sibling")])],
      ["after", hood([ref("co-blocker")], [ref("far-after")])],
    ]),
  );

  const ids = graph.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ["after", "anchor", "before", "far-after", "far-before"]);
  // A dependency that half the board waits for would otherwise bring most of
  // the board with it, and none of it is an answer to what is in front of this
  // task or behind it.
  assert.ok(!ids.includes("sibling"), "a dependency's other dependents are not drawn");
  assert.ok(!ids.includes("co-blocker"), "a dependent's other dependencies are not drawn");
  assert.deepEqual(arrows(graph), [
    "after>far-after",
    "anchor>after",
    "before>anchor",
    "far-before>before",
  ]);
});

test("an edge is kept only when both ends are being drawn", () => {
  const graph = taskNeighbourhoodGraph(
    anchorTask(hood([ref("before")], [])),
    new Map([
      ["before", hood([ref("far-before")], [])],
      // Read but never asked for: a caller that over-fetched must not be able to
      // widen the drawing by accident.
      ["stranger", hood([ref("nobody")], [ref("nobody-else")])],
    ]),
  );

  assert.deepEqual(
    graph.nodes.map((n) => n.id).sort(),
    ["anchor", "before", "far-before"],
  );
  assert.deepEqual(arrows(graph), ["before>anchor", "far-before>before"]);
});

test("an ordering between two of this task's own dependencies is drawn", () => {
  // Both are in front of the anchor and one is in front of the other. Dropping
  // that edge would draw two unrelated things where there is a chain.
  const graph = taskNeighbourhoodGraph(
    anchorTask(hood([ref("first"), ref("second")], [])),
    new Map([["second", hood([ref("first")], [])]]),
  );

  assert.deepEqual(arrows(graph), ["first>anchor", "first>second", "second>anchor"]);
});

test("a task reached from both sides is one node, and a repeated edge is one edge", () => {
  const graph = taskNeighbourhoodGraph(
    anchorTask(hood([ref("before")], [])),
    // `before` says the same edge back, which is what reading both directions
    // of one table gives you.
    new Map([["before", hood([], [ref("anchor"), ref("anchor")])]]),
  );

  assert.deepEqual(graph.nodes.map((n) => n.id), ["anchor", "before"]);
  assert.deepEqual(arrows(graph), ["before>anchor"]);
});

test("a neighbour whose read failed leaves the graph a level short rather than throwing", () => {
  const graph = taskNeighbourhoodGraph(
    anchorTask(hood([ref("before")], [ref("after")])),
    // Only one of the two was answered; the other is simply absent.
    new Map([["after", hood([], [ref("far-after")])]]),
  );

  assert.deepEqual(
    graph.nodes.map((n) => n.id).sort(),
    ["after", "anchor", "before", "far-after"],
  );
});

/* ------------------------------------------------------------------ */
/* What a node says about itself                                       */
/* ------------------------------------------------------------------ */

test("a node names its project only when it differs from the anchor's", () => {
  const graph = taskNeighbourhoodGraph(
    anchorTask(
      hood(
        [ref("same"), ref("elsewhere", { relPath: "RepoTwo" }), ref("nowhere", {
          mountId: null,
          mountLabel: null,
          relPath: null,
        })],
        [],
      ),
    ),
    new Map(),
  );
  const place = (id: string) => graph.nodes.find((n) => n.id === id)?.place;

  // An edge across projects is the case this field exists for; the same project
  // written on every node spends the one line a node has saying nothing.
  assert.equal(place("same"), null);
  assert.equal(place("elsewhere"), "Main / RepoTwo");
  assert.equal(place("nowhere"), "Unassigned");
  assert.equal(place("anchor"), null);
});

/* ------------------------------------------------------------------ */
/* When the picture is not the whole ordering                          */
/* ------------------------------------------------------------------ */

test("a neighbourhood with more edges than refs marks the graph clipped", () => {
  const whole = taskNeighbourhoodGraph(
    anchorTask(hood([ref("before")], [])),
    new Map([["before", hood([], [])]]),
  );
  assert.equal(whole.clipped, false);

  // `TaskDepsDTO` caps its lists at ten and does not cap its counts, and says
  // that anything drawing the graph must check. An incomplete drawing of an
  // ordering does not look incomplete, which is the whole reason the flag is
  // on the shape rather than left to the reader.
  const anchorClipped = taskNeighbourhoodGraph(
    anchorTask(hood([ref("before")], [], { dependentCount: 12 })),
    new Map(),
  );
  assert.equal(anchorClipped.clipped, true);

  const beyondClipped = taskNeighbourhoodGraph(
    anchorTask(hood([ref("before")], [])),
    new Map([["before", hood([], [], { dependsOnCount: 12 })]]),
  );
  assert.equal(beyondClipped.clipped, true);

  // A neighbourhood nobody asked for cannot make the drawing claim to be
  // missing something, for the same reason it cannot add a node to it.
  const strangerClipped = taskNeighbourhoodGraph(
    anchorTask(hood([ref("before")], [])),
    new Map([
      ["before", hood([], [])],
      ["stranger", hood([], [], { dependsOnCount: 40 })],
    ]),
  );
  assert.equal(strangerClipped.clipped, false);
});
