import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
// Type-only, so they are erased rather than hoisted above the environment setup
// below — `taskComments.test.ts`' reason, and the same reason the values come
// through `require`.
import type { TaskActor } from "./tasks";
import type { TaskDepRefDTO, TaskStatusDTO } from "./apiTypes";

/**
 * What a dependency refuses to be, and what "blocked" is counted over.
 *
 * Two pure rules, and both fail in the way this repository's test bar names —
 * nothing throws, nothing fails to typecheck, and the board looks right.
 *
 * **The loop refusal** is the load-bearing one and the reason a second walker
 * was not written: a self-edge stores happily and reads back as a task waiting
 * for itself, and a longer loop is worse and quieter — every task in it shows as
 * blocked for ever, each pointing at the next, with no surface anywhere in a
 * position to notice that the set as a whole can never clear. The diamond is the
 * other half of the same assertion: a walker that called *any* re-visit a cycle
 * would refuse the ordinary shape of "two things, then the thing after both",
 * which is the most common real ordering an operator draws.
 *
 * **The blocked count** is the one derived reading on this feature and is
 * counted over **every** edge before the lists are capped. Counted over the
 * capped list instead, a task waiting on twelve things with the first ten done
 * would report itself ready — a number drawn on a row, wrong, with nothing
 * saying so. The order the cap drops in is asserted for the same reason: a
 * clipped list of finished dependencies beside a non-zero count names nothing a
 * reader can act on.
 *
 * The last section reaches the database, on the grounds `taskComments.test.ts`'
 * own writes earned: three of this feature's decisions are not in a pure
 * function and no pure function can reach them. A repeated write must be
 * idempotent rather than an error, an edge must not move either task, and an
 * edge outliving a deleted task is an ordering pointing at nothing.
 */

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uf-task-deps-")));
const ws = path.join(tmp, "ws");
fs.mkdirSync(path.join(ws, "RepoOne"), { recursive: true });

process.env.WORKSPACE_ROOTS = `Main=${ws}`;
process.env.DATA_DIR = path.join(tmp, "data");
process.env.CLAUDE_HOME = path.join(tmp, "claude");
// Pinned rather than left to fall back to CLAUDE_HOME, `tasks.test.ts`' reason:
// an ambient CLAUDE_CONFIG_DIR holding an OAuth token would make a unit test
// talk to Anthropic on the operator's own credential.
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");
// Nothing here spawns, and this is the second lock on that door.
process.env.CLAUDE_BIN = path.join(tmp, "no-such-claude");
process.env.CODEX_BIN = path.join(tmp, "no-such-codex");
process.env.CODEX_HOME = path.join(tmp, "codex");

// `require`, not `import`: imports are hoisted above the environment setup
// above, and `orchestrator.ts` — which this module takes its folder splitting
// and its loop detector from — reads WORKSPACE_ROOTS once at load.
const {
  addTaskDep,
  depIsBlocking,
  depNeighbourhood,
  depsForTask,
  depsForTasks,
  removeTaskDep,
  taskDepRefusal,
} = require("./taskDeps") as typeof import("./taskDeps");
const { createTask, deleteTask, getTask } = require("./tasks") as typeof import("./tasks");
const { db } = require("./db") as typeof import("./db");

const OPERATOR: TaskActor = { kind: "operator" };

/** An edge list in the shape the refusal reads, written the way it reads. */
function edges(...pairs: [string, string][]) {
  return pairs.map(([taskId, dependsOn]) => ({ taskId, dependsOn }));
}

/* ------------------------------------------------------------------ */
/* The loop refusal                                                    */
/* ------------------------------------------------------------------ */

test("a task cannot depend on itself, and the refusal says so in its own words", () => {
  const refusal = taskDepRefusal("a", "a", []);
  assert.ok(refusal, "a self-edge must be refused");
  // Refused *by name* rather than falling out of the loop walker, because the
  // sentence a person has to act on is different: there is no edge to break
  // somewhere else, there is one press that was wrong.
  assert.ok(
    refusal.includes("itself"),
    `the self-edge refusal must name what it is: ${refusal}`,
  );
});

test("a two-node loop is refused and the refusal names the loop", () => {
  // b already waits for a. Making a wait for b closes it.
  const refusal = taskDepRefusal("a", "b", edges(["b", "a"]));
  assert.ok(refusal, "a → b → a must be refused");
  assert.ok(refusal.includes("a") && refusal.includes("b"), refusal);
  // The whole reason the refusal carries the path: an operator told only "that
  // would make a loop" on a board of sixty tasks has nothing to go and fix.
  assert.ok(refusal.includes("→"), `the refusal must draw the loop: ${refusal}`);
});

test("a longer loop is refused, through edges the new one never names", () => {
  // b→c and c→d exist; adding d→b closes a three-node loop, and neither end of
  // the new edge is where a reader would look first.
  const refusal = taskDepRefusal("d", "b", edges(["b", "c"], ["c", "d"]));
  assert.ok(refusal, "b → c → d → b must be refused");
  for (const id of ["b", "c", "d"]) {
    assert.ok(refusal.includes(id), `the loop must name ${id}: ${refusal}`);
  }
});

test("a diamond is not a loop, and is allowed", () => {
  // d waits for b and c; both wait for a. `a` is reached twice and that is the
  // ordinary shape of "two things, then the thing after both" — a walker that
  // called any re-visit a cycle would refuse the most common ordering there is.
  const existing = edges(["b", "a"], ["c", "a"], ["d", "b"]);
  assert.equal(taskDepRefusal("d", "c", existing), null);
});

test("an edge already on the board is not a loop and is not refused", () => {
  // The primary key makes the write idempotent; the refusal must not be what
  // answers a repeat, or a caller restating something true would be told it had
  // made a loop out of one edge.
  assert.equal(taskDepRefusal("b", "a", edges(["b", "a"])), null);
});

test("the loop refusal names the tasks as the caller describes them", () => {
  const refusal = taskDepRefusal("a", "b", edges(["b", "a"]), (id) =>
    id === "a" ? "“Ship it”" : "“Write it”",
  );
  assert.ok(refusal);
  // Ids are not names. The door passes titles precisely because a loop drawn
  // out of four UUIDs is a sentence nobody can act on.
  assert.ok(refusal.includes("Ship it") && refusal.includes("Write it"), refusal);
});

/* ------------------------------------------------------------------ */
/* The blocked reading                                                 */
/* ------------------------------------------------------------------ */

function ref(id: string, status: TaskStatusDTO): TaskDepRefDTO {
  return { id, title: id, status, mountId: null, mountLabel: null, relPath: null };
}

test("only done clears a dependency, and dropped deliberately does not", () => {
  assert.equal(depIsBlocking("done"), false);
  for (const status of ["open", "claimed", "dropped"] as const) {
    // `dropped` is the one worth asserting: reading it as satisfied would mark
    // a dependent ready on the strength of work nobody did, and the reading is
    // drawn as a word rather than stored, so nothing anywhere would say so.
    assert.equal(depIsBlocking(status), true, `${status} should still block`);
  }
});

test("a task blocked by something already done reads as ready", () => {
  const view = depNeighbourhood([ref("a", "done")], []);
  assert.equal(view.blockedByCount, 0, "a done dependency blocks nothing");
  // The edge is still there and still reported: "ready" is a reading over the
  // statuses, never a claim that the ordering was removed.
  assert.equal(view.dependsOnCount, 1);
  assert.deepEqual(view.dependsOn.map((d) => d.id), ["a"]);
});

test("blocked is counted over every edge, not over the list a cap left", () => {
  // Twelve dependencies, the first ten done: counted over the capped list this
  // task reports itself ready while two things it waits on are open.
  const deps = [
    ...Array.from({ length: 10 }, (_, n) => ref(`done-${n}`, "done")),
    ref("open-a", "open"),
    ref("open-b", "claimed"),
  ];
  const view = depNeighbourhood(deps, [], 10);

  assert.equal(view.blockedByCount, 2, "both unfinished dependencies must count");
  assert.equal(view.dependsOnCount, 12, "the count is over every edge");
  assert.equal(view.dependsOn.length, 10, "the list is what the cap left");
  // And what survived the cap is what a reader can act on: the unfinished ones
  // lead, so a list beside a non-zero count names the things in the way.
  assert.deepEqual(view.dependsOn.slice(0, 2).map((d) => d.id), ["open-a", "open-b"]);
});

test("the partition is stable and dependents are not re-ordered", () => {
  const deps = [ref("x", "open"), ref("y", "done"), ref("z", "open")];
  const dependents = [ref("p", "done"), ref("q", "open")];
  const view = depNeighbourhood(deps, dependents);

  // Within each half the caller's order — the order the edges were drawn — is
  // kept, so a board redrawn twice does not shuffle its own rows.
  assert.deepEqual(view.dependsOn.map((d) => d.id), ["x", "z", "y"]);
  // Nothing about one task waiting for this one is more urgent than another,
  // so the edge's own age is the only ordering here that is not an opinion.
  assert.deepEqual(view.dependents.map((d) => d.id), ["p", "q"]);
  assert.equal(view.dependentCount, 2);
});

test("a cap of zero leaves the counts standing", () => {
  const view = depNeighbourhood([ref("a", "open")], [ref("b", "open")], 0);
  assert.deepEqual(view.dependsOn, []);
  assert.deepEqual(view.dependents, []);
  // The lists are what a cap bounds; the counts are what stops a bounded list
  // being read as the whole of it.
  assert.equal(view.dependsOnCount, 1);
  assert.equal(view.dependentCount, 1);
  assert.equal(view.blockedByCount, 1);
});

/* ------------------------------------------------------------------ */
/* The four the pure functions cannot reach                            */
/* ------------------------------------------------------------------ */

function seedTask(title: string): string {
  const created = createTask({
    title,
    body: "the brief",
    priority: "normal",
    origin: "operator",
    mountId: null,
    folder: null,
    createdByRunId: null,
    parentTaskId: null,
  });
  assert.ok(created.ok, "seed task should be created");
  return created.task.id;
}

test("a repeated edge is idempotent and the answer says it was already there", () => {
  const waiter = seedTask("second");
  const blocker = seedTask("first");

  const first = addTaskDep(waiter, blocker);
  assert.ok(first.ok);
  assert.equal(first.created, true);

  const again = addTaskDep(waiter, blocker);
  assert.ok(again.ok, "a repeated write is not an error");
  // The distinction the primary key cannot make on its own: a caller told
  // nothing cannot tell "I drew this" from "this was already drawn", and a
  // model retrying a tool call needs to.
  assert.equal(again.created, false);
  assert.equal(depsForTask(waiter).dependsOnCount, 1, "and there is still one edge");
});

test("an edge against a task that is not there is missing, not an SQLite error", () => {
  const waiter = seedTask("present");

  const noBlocker = addTaskDep(waiter, "no-such-id");
  assert.equal(noBlocker.ok, false);
  // Refused as a sentence rather than dying on the foreign key, which is what
  // lets a door turn it into a 404 naming something the caller can change.
  assert.equal(!noBlocker.ok && noBlocker.kind, "missing");

  const noWaiter = addTaskDep("no-such-id", waiter);
  assert.equal(noWaiter.ok, false);
  assert.equal(!noWaiter.ok && noWaiter.kind, "missing");
});

test("an edge does not move either task, and in particular does not bump updated_at", () => {
  const waiter = seedTask("unmoved");
  const blocker = seedTask("unmoved too");
  const before = getTask(waiter)!;

  // Rolled back rather than waited out: `updated_at` is milliseconds, so a
  // same-millisecond write would pass this test whatever the code did.
  db().prepare("UPDATE tasks SET updated_at = ? WHERE id IN (?, ?)").run(1, waiter, blocker);

  assert.ok(addTaskDep(waiter, blocker).ok);

  const after = getTask(waiter)!;
  // The board sorts on `updated_at`, so an edge that touched it would reorder
  // the board and read as somebody having worked on the task.
  assert.equal(after.updatedAt, 1, "an edge must not bump updated_at");
  assert.equal(getTask(blocker)!.updatedAt, 1, "nor on the other end");
  assert.equal(after.status, before.status);
  assert.equal(after.claimedByRunId, before.claimedByRunId);
});

test("the loop refusal is enforced at the door, over the stored edges", () => {
  const a = seedTask("a");
  const b = seedTask("b");
  const c = seedTask("c");
  assert.ok(addTaskDep(b, a).ok);
  assert.ok(addTaskDep(c, b).ok);

  const loop = addTaskDep(a, c);
  assert.equal(loop.ok, false);
  assert.equal(!loop.ok && loop.kind, "refused");
  // The titles rather than the ids, which is what the door passes `describe`
  // for and the only form of the sentence an operator can act on.
  assert.ok(!loop.ok && loop.error.includes("“a”"), !loop.ok ? loop.error : "");

  const self = addTaskDep(a, a);
  assert.equal(self.ok, false);
  assert.equal(!self.ok && self.kind, "refused");
});

test("both ends are read, and a page is answered in one pass", () => {
  const first = seedTask("first of three");
  const middle = seedTask("middle of three");
  const last = seedTask("last of three");
  assert.ok(addTaskDep(middle, first).ok);
  assert.ok(addTaskDep(last, middle).ok);

  const page = depsForTasks([first, middle, last]);

  // "What is this waiting for" and "what is waiting for this" are two reads of
  // the same table and the board draws both off one request.
  assert.deepEqual(page.get(middle)!.dependsOn.map((d) => d.id), [first]);
  assert.deepEqual(page.get(middle)!.dependents.map((d) => d.id), [last]);
  assert.equal(page.get(first)!.dependsOnCount, 0);
  assert.equal(page.get(first)!.dependentCount, 1);

  // A task with no edges either way is absent rather than present as zeroes,
  // which is what lets the caller's default be written in exactly one place.
  const lonely = seedTask("lonely");
  assert.equal(depsForTasks([lonely]).has(lonely), false);
  assert.equal(depsForTask(lonely).dependsOnCount, 0);
});

test("a deleted task takes its edges with it, both ways, and leaves the rest", () => {
  const doomed = seedTask("doomed");
  const waiter = seedTask("waits for the doomed one");
  const blocker = seedTask("the doomed one waits for this");
  const bystander = seedTask("bystander");
  const other = seedTask("bystander's dependency");

  assert.ok(addTaskDep(waiter, doomed).ok);
  assert.ok(addTaskDep(doomed, blocker).ok);
  assert.ok(addTaskDep(bystander, other).ok);

  assert.ok(deleteTask(doomed, OPERATOR).ok);

  // The one way an edge goes away without a press — `ON DELETE CASCADE`, which
  // is inert unless `PRAGMA foreign_keys` is on, and that is what this asserts.
  // Both directions, because the two columns are two separate foreign keys and
  // a table declared with one of them would leave half the edges behind as
  // orderings pointing at nothing.
  assert.equal(depsForTask(waiter).dependsOnCount, 0, "the edge into it is gone");
  assert.equal(depsForTask(blocker).dependentCount, 0, "and the edge out of it");
  assert.equal(depsForTask(bystander).dependsOnCount, 1, "and nothing else moved");
});

test("removing an edge that is not there is missing rather than a silent success", () => {
  const waiter = seedTask("waiter");
  const blocker = seedTask("blocker");
  assert.ok(addTaskDep(waiter, blocker).ok);

  assert.ok(removeTaskDep(waiter, blocker).ok);
  assert.equal(depsForTask(waiter).dependsOnCount, 0);

  const again = removeTaskDep(waiter, blocker);
  assert.equal(again.ok, false);
  // The asymmetry with a repeated *add*, and it is deliberate: a repeated add
  // is a caller restating something true, where a remove that found nothing
  // means the row the press was drawn against has changed underneath it.
  assert.equal(!again.ok && again.kind, "missing");
});
