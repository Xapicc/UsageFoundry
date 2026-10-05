import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  EDGE_CHIP_LABEL,
  EDGE_OPTION_LABEL,
  fmtCycleInFlight,
  fmtCycles,
  fmtLiveCycle,
  fmtTokens,
  guardBadge,
  landingSummary,
  passRuns,
  passesOf,
  pollFailureMessage,
  resolveLiveModel,
  runPageNotes,
  storedFolderState,
} from "./format";
import type {
  TaskCommentDTO,
  WorkflowInstanceBlockDTO,
  WorkflowInstanceNodeDTO,
} from "./apiTypes";
import type { RunDTO } from "./apiTypes";

/**
 * What a running run says about the work cycle it has open.
 *
 * It earns a test on the same grounds as the rest of this repo's short list:
 * the failure is silent, typechecks, and is expensive to the reader. `iterations`
 * counts cycles that *finished*, so a run tens of minutes into cycle 1 reads
 * `0/N` — bit-for-bit what a run that was marked running and never started
 * reads, which is the exact question an operator opens the page to answer. The
 * two ways of getting this wrong are saying nothing (the bug) and trusting the
 * column on a row that is no longer running (a finished run that claims to be
 * working, which is the same lie pointing the other way).
 */

const RUNNING: Pick<RunDTO, "status" | "max_iterations" | "active_iteration"> = {
  status: "running",
  max_iterations: 2,
  active_iteration: 1,
};

test("a run in its first cycle names that cycle rather than reading zero", () => {
  const said = fmtCycleInFlight(RUNNING);
  assert.equal(said, "cycle 1 of 2 in flight");
  // The count beside it is still the completed one, and the two must not be
  // readable as the same quantity — "in flight" is what keeps them apart.
  assert.equal(fmtCycles(0, 2), "0/2");
  assert.match(said!, /in flight/);
});

test("no cycle in flight means nothing is claimed", () => {
  // Between cycles: the pre-cycle transcript scan takes seconds and no child
  // exists, so naming the cycle that just returned would be a live spinner over
  // finished work.
  assert.equal(fmtCycleInFlight({ ...RUNNING, active_iteration: null }), null);
  // Rows written before the column existed, and a run that has not spawned yet.
  assert.equal(
    fmtCycleInFlight({ ...RUNNING, active_iteration: undefined }),
    null,
  );
});

test("a stale value on a run that is no longer running is not trusted", () => {
  // Nothing clears the row when the container dies mid-cycle: `reconcileOnBoot`
  // marks the run failed and the number stays behind it.
  for (const status of ["failed", "stopped", "completed", "paused"] as const) {
    assert.equal(
      fmtCycleInFlight({ ...RUNNING, status, active_iteration: 3 }),
      null,
      `${status} must not report a cycle in flight`,
    );
  }
});

test("an uncapped run names the cycle without inventing a limit", () => {
  // 0 is the stored sentinel for "no cap"; "cycle 3 of 0" would read as spent.
  assert.equal(
    fmtCycleInFlight({ status: "running", max_iterations: 0, active_iteration: 3 }),
    "cycle 3 in flight",
  );
  // A grant cannot widen a cap that is not there.
  assert.equal(
    fmtCycleInFlight({
      status: "running",
      max_iterations: 0,
      active_iteration: 3,
      validation_cycles: 1,
    }),
    "cycle 3 in flight",
  );
});

test("the cycle a task check granted is counted against the widened cap", () => {
  // Capped at 1 and sent back once: the guard admits a second cycle, and the
  // line drawn from `max_iterations` alone read "cycle 2 of 1" — over the
  // limit, on a run doing exactly what it was allowed.
  assert.equal(
    fmtCycleInFlight({
      status: "running",
      max_iterations: 1,
      active_iteration: 2,
      validation_cycles: 1,
    }),
    "cycle 2 of 2 in flight",
  );
  // No grant reads as it always did, whether the column is 0 or absent.
  assert.equal(
    fmtCycleInFlight({ ...RUNNING, validation_cycles: 0 }),
    "cycle 1 of 2 in flight",
  );
});

/**
 * The one thing in `format.ts` whose failure is silence.
 *
 * Every other helper here is wrong loudly — a mis-rounded percentage is on the
 * screen to be read. This one is rendered as `{message && <Notice…>}`, so a
 * return of `""` puts nothing on the page at all, which is precisely the defect
 * it was written for: the chat page discarded every failed poll and left a
 * thread frozen on "Thinking…", indistinguishable from a turn still working.
 * A blank message reinstates that, throws nothing, and typechecks.
 */

test("a rejected fetch says the server was not reached, never a status", () => {
  const msg = pollFailureMessage(null, "Failed to fetch");
  assert.match(msg, /could not be reached/);
  assert.match(msg, /Failed to fetch/, "the cause is the operator's only clue");
  assert.doesNotMatch(msg, /answered/, "there was no answer to report");
});

test("a 401 names the one failure the operator can clear", () => {
  const msg = pollFailureMessage(401, "Unauthorized");
  assert.match(msg, /[Ss]ign in again/);
});

test("the server's own error text is carried through", () => {
  assert.match(pollFailureMessage(500, "no such chat"), /no such chat/);
  assert.match(pollFailureMessage(500, "no such chat"), /500/);
});

test("a status with no error text still names the status", () => {
  assert.match(pollFailureMessage(404), /404/);
});

test("every failure produces a sentence, whatever the body carried", () => {
  // A blank message renders as no Notice at all, which is the swallowed poll
  // this function replaced. `{"error":""}` and a whitespace-only body are both
  // reachable from a server that means to say something and fails to.
  for (const detail of [undefined, null, "", "   "]) {
    for (const status of [null, 401, 404, 500, 502]) {
      const msg = pollFailureMessage(status, detail);
      assert.ok(msg.trim().length > 0, `blank message for ${status}/${detail}`);
      assert.doesNotMatch(msg, /\(\s*\)|—\s*\./, "no empty slot left where the cause would go");
    }
  }
});

test("the message says the page is no longer current", () => {
  // Without this the notice reads as one bad request rather than as a page
  // that has stopped tracking the thread, which is what the operator acts on.
  assert.match(pollFailureMessage(500, "boom"), /out of date/);
  assert.match(pollFailureMessage(401, "Unauthorized"), /out of date/);
});

/**
 * Which guard set a block runs under, and the state that is neither present
 * nor absent.
 *
 * The failure this pins is silent and typechecks: with two states, the list a
 * page has not read yet is indistinguishable from a list with nothing in it, so
 * every templated block on the workflow page wore a red "template deleted" —
 * permanently when the request failed, and for a frame on every cold load. That
 * badge is the one thing on the page that says the workflow will not run, and
 * it was untrue; Run worked. The deleted case has to stay loud for the opposite
 * reason, because `planNode` really does refuse such a node by name.
 */

const TEMPLATES = [
  { id: "t1", name: "Careful guards" },
  { id: "t2", name: "Cheap guards" },
];

test("an unread list is not an empty one", () => {
  assert.deepEqual(guardBadge("t1", null), {
    text: "guards not read",
    tone: "neutral",
  });
  // The same id against a list that really has been read and does not hold it.
  assert.deepEqual(guardBadge("t1", []), {
    text: "template deleted",
    tone: "danger",
  });
});

test("a template that is there is named, and says nothing alarming", () => {
  assert.deepEqual(guardBadge("t2", TEMPLATES), {
    text: "Cheap guards",
    tone: "neutral",
  });
});

test("a block naming no template takes the untemplated set, read or not", () => {
  // `null` here is the operator's own choice — Settings guards — and must not
  // be confused with the unread list, which is the other null in this call.
  for (const templates of [null, [], TEMPLATES]) {
    assert.deepEqual(guardBadge(null, templates), {
      text: "Settings guards",
      tone: "neutral",
    });
  }
});

test("only a template that is genuinely absent is called deleted", () => {
  const deleted = guardBadge("gone", TEMPLATES);
  assert.equal(deleted.tone, "danger");
  // Nothing else may reach the danger tone: it is what an operator reads as
  // "this graph will be refused at Run".
  for (const badge of [
    guardBadge("gone", null),
    guardBadge(null, null),
    guardBadge("t1", TEMPLATES),
  ]) {
    assert.equal(badge.tone, "neutral");
  }
});

/**
 * Whether the task editor warns that a task's folder has left the scan.
 *
 * `guardBadge`'s failure one page over, and it shipped the same way: the scan
 * started as an empty list, so every task with a project opened under a warning
 * that its folder was not in the workspace scan — until `/api/folders` answered,
 * and for good when it failed. `absent` is the only state that draws the
 * warning, and it must stay reachable, because a folder deleted under a task is
 * refused at the next save and this is where the operator sees that first.
 */

const SCAN = [
  { mountId: "m1", path: "app" },
  { mountId: "m2", path: "site" },
];

test("an unread scan is not a scan without the folder", () => {
  assert.equal(storedFolderState("m1", "app", null), "unread");
  // The same pair against a scan that really has answered and does not hold it.
  assert.equal(storedFolderState("m1", "app", []), "absent");
});

test("a folder the scan offers under the task's own mount is listed", () => {
  assert.equal(storedFolderState("m1", "app", SCAN), "listed");
  // The path alone is not the folder: the same name under another mount is a
  // different directory, and the task's is not among them.
  assert.equal(storedFolderState("m2", "app", SCAN), "absent");
});

test("a task with no project has nothing to keep, read or not", () => {
  for (const scan of [null, [], SCAN]) {
    assert.equal(storedFolderState("", "", scan), "none");
    // Half a pair is what the mount select's own change leaves behind — the
    // folder is cleared whenever the mount moves — and is nothing to warn of.
    assert.equal(storedFolderState("m1", "", scan), "none");
  }
});

/**
 * The unanswered edge, which is a real option and reads as an oversight.
 *
 * These two maps replaced three that lived in three files, and consolidating
 * them puts every surface that names a link condition behind one object — so
 * the tidy-up that looks obvious here ("a picker should not offer a blank") is
 * now one edit away from pre-selecting a condition on every drawn link in the
 * app. That failure is silent in the direction that costs the most: the graph
 * saves, the canvas draws a chosen edge, and `on-success` quietly terminates a
 * chain the operator meant to run regardless — or `on-finish` starts a run on
 * top of a dependency that crashed. Nothing throws and nothing typechecks
 * differently, because the key is optional to *use* and mandatory to *offer*.
 *
 * The `Record` type already forces all three keys to exist; what it cannot say
 * is that each carries words a person can act on, which is what an empty string
 * or a placeholder would take away while still compiling.
 */

test("both edge maps offer the unanswered state as a real option", () => {
  for (const map of [EDGE_OPTION_LABEL, EDGE_CHIP_LABEL]) {
    assert.deepEqual(Object.keys(map), [
      "",
      "on-success",
      "on-finish",
      "repeats",
    ]);
    for (const [edge, label] of Object.entries(map)) {
      assert.ok(label.trim().length > 0, `\`${edge}\` renders as nothing`);
    }
  }
});

test("the unanswered state reads as unanswered rather than as a condition", () => {
  // The words matter as much as the key: an empty option labelled "—" is a
  // picker that looks broken rather than one asking a question, and the two
  // real answers must stay distinguishable from it and from each other.
  assert.notEqual(EDGE_OPTION_LABEL[""], EDGE_OPTION_LABEL["on-success"]);
  assert.notEqual(EDGE_OPTION_LABEL[""], EDGE_OPTION_LABEL["on-finish"]);
  assert.notEqual(EDGE_CHIP_LABEL[""], EDGE_CHIP_LABEL["on-success"]);
  assert.notEqual(EDGE_CHIP_LABEL[""], EDGE_CHIP_LABEL["on-finish"]);
});

test("containment does not read as a third way of waiting", () => {
  // `repeats` is the one value here that is not a condition on starting: the
  // block it names is created once per pass by the loop and nothing ever waits
  // for it. Worded as a condition it would be read as one, and the arrow on the
  // canvas would be understood backwards.
  for (const map of [EDGE_OPTION_LABEL, EDGE_CHIP_LABEL]) {
    assert.match(map.repeats, /repeat/i);
    assert.notEqual(map.repeats, map["on-success"]);
    assert.notEqual(map.repeats, map["on-finish"]);
    assert.notEqual(map.repeats, map[""]);
  }
});

/**
 * A deficit is a token figure like any other in the column it sits in.
 *
 * The composition legend prints the residual beside five positive bands, and
 * the residual is negative on any reading whose estimates over-explain the
 * window. The unsigned formatter fell through every threshold on a negative
 * and printed the raw integer: `-81822` under `182.2k`, a figure in a different
 * unit on the same list, with nothing to say it was.
 */
test("a negative token figure is scaled and signed like a positive one", () => {
  assert.equal(fmtTokens(-81_822), "−81.8k");
  assert.equal(fmtTokens(-1_500_000), "−1.50M");
  assert.equal(fmtTokens(-5), "−5");
  assert.equal(fmtTokens(0), "0");
  assert.equal(fmtTokens(81_822), "81.8k");
});

/**
 * A pass drawn as the wrong shape.
 *
 * The instance page reads spend, status and the landing off these groups, so a
 * row folded into the pass beside it is listed under work it was not part of —
 * and the failure is silent, because every row is still on the page and the
 * totals still add up. Three things in particular fail without a mark:
 *
 * A run an orchestrator **member** started is named `<memberId>#<specId>`, so
 * it carries the pass too. Read off `emittedBy` alone it lands in the flat
 * table at the foot of the page, and the pass whose fan-out paid for it reports
 * a cost that does not include it — which is the figure the operator is reading
 * to decide whether to let the loop carry on.
 *
 * The order within a pass comes from the loop's own `bodyNodeIds`, because
 * position is two sequences here — one for runs, one for ledger rows — and
 * interleaving by it draws the merge member ahead of the runs it landed.
 *
 * And the landing may not be stated before the merge member has run: "landed 0
 * of 0" on a pass still working is a claim that the next pass starts from
 * nothing.
 */

const member = (loopNodeId: string, pass: number, bodyNodeId: string) => ({
  loopNodeId,
  pass,
  bodyNodeId,
});

const passRun = (
  nodeId: string,
  passMember: ReturnType<typeof member> | null,
  over: Partial<WorkflowInstanceNodeDTO> = {},
): WorkflowInstanceNodeDTO => ({
  nodeId,
  nodeName: nodeId,
  position: 0,
  runId: `run-${nodeId}`,
  run: null,
  waitsFor: [],
  emittedBy: null,
  passMember,
  leftBehind: false,
  ...over,
});

const passBlock = (
  nodeId: string,
  kind: WorkflowInstanceBlockDTO["kind"],
  passMember: ReturnType<typeof member> | null,
  over: Partial<WorkflowInstanceBlockDTO> = {},
): WorkflowInstanceBlockDTO => ({
  nodeId,
  nodeName: nodeId,
  position: 0,
  kind,
  status: "emitted",
  startedAt: null,
  finishedAt: null,
  costUSD: null,
  costUnknown: false,
  emitted: 0,
  started: 0,
  decided: false,
  reply: null,
  notes: [],
  branchesLanded: 0,
  branchesFailed: 0,
  reviewItems: [],
  error: null,
  waitsFor: [],
  bodyNodeIds: [],
  maxPasses: null,
  maxLoopCostUSD: null,
  passMember,
  ...over,
});

/** A loop framing `a` then `m`, which is the shape every case below uses. */
const nightly = passBlock("loop", "loop", null, { bodyNodeIds: ["a", "m"] });

test("a pass holds its members in the section's own order", () => {
  // Deliberately the wrong way round by position, which is what an interleave
  // on that field would produce: the merge member ahead of the run it lands.
  const passes = passesOf(nightly, {
    nodes: [passRun("loop#pass-1#a", member("loop", 1, "a"), { position: 7 })],
    blocks: [
      passBlock("loop#pass-1#m", "merge", member("loop", 1, "m"), {
        position: 0,
      }),
    ],
  });
  assert.equal(passes.length, 1);
  assert.deepEqual(
    passes[0].members.map((m) => m.key),
    ["loop#pass-1#a", "loop#pass-1#m"],
  );
});

test("passes are numbered off their members and ordered by that number", () => {
  const passes = passesOf(nightly, {
    nodes: [
      passRun("loop#pass-2#a", member("loop", 2, "a")),
      passRun("loop#pass-1#a", member("loop", 1, "a")),
    ],
    blocks: [],
  });
  assert.deepEqual(
    passes.map((p) => p.pass),
    [1, 2],
  );
  assert.equal(passes[0].members.length, 1);
});

test("a run a member decided on sits under that member, and in its pass", () => {
  const decider = passBlock(
    "loop#pass-1#a",
    "orchestrator",
    member("loop", 1, "a"),
  );
  const emitted = passRun("loop#pass-1#a#spec-1", member("loop", 1, "a#spec-1"), {
    emittedBy: "loop#pass-1#a",
  });
  const passes = passesOf(passBlock("loop", "loop", null, { bodyNodeIds: ["a"] }), {
    nodes: [emitted],
    blocks: [decider],
  });
  assert.equal(passes.length, 1);
  // One member, not two: the run it decided on is drawn under it rather than
  // beside it, which is also what keeps it out of the flat table.
  assert.equal(passes[0].members.length, 1);
  const only = passes[0].members[0];
  assert.equal(only.kind, "block");
  assert.deepEqual(
    only.kind === "block" ? only.emitted.map((n) => n.nodeId) : [],
    ["loop#pass-1#a#spec-1"],
  );
  // And a fan-out is exactly the part of a pass's cost nobody approved one by
  // one, so it has to be in the figure beside the pass.
  assert.deepEqual(
    passRuns(passes[0]).map((n) => n.nodeId),
    ["loop#pass-1#a#spec-1"],
  );
});

test("a member run released by the loop is still a member of its pass", () => {
  // Every member run names its loop in `emittedBy`: that is what released it.
  // Read as "something decided on this", the run is folded under the loop and
  // disappears off the page — an agent that spent money with nothing on screen
  // saying it ran. Only a *member* of the pass can be a decider.
  const passes = passesOf(nightly, {
    nodes: [
      passRun("loop#pass-1#a", member("loop", 1, "a"), { emittedBy: "loop" }),
    ],
    blocks: [passBlock("loop#pass-1#m", "merge", member("loop", 1, "m"))],
  });
  assert.deepEqual(
    passes[0].members.map((m) => m.key),
    ["loop#pass-1#a", "loop#pass-1#m"],
  );
});

test("a member outside the section's order sorts last rather than vanishing", () => {
  const passes = passesOf(nightly, {
    nodes: [
      passRun("loop#pass-1#zz", member("loop", 1, "zz")),
      passRun("loop#pass-1#a", member("loop", 1, "a")),
    ],
    blocks: [],
  });
  // `zz` is not in `bodyNodeIds` — an instance whose graph was written before
  // that field existed reads every member that way. It is still a billed run.
  assert.deepEqual(
    passes[0].members.map((m) => m.key),
    ["loop#pass-1#a", "loop#pass-1#zz"],
  );
});

test("the landing is stated once the merge member has run, and not before", () => {
  const landed = (over: Partial<WorkflowInstanceBlockDTO>) =>
    passesOf(nightly, {
      nodes: [],
      blocks: [passBlock("loop#pass-1#m", "merge", member("loop", 1, "m"), over)],
    })[0];

  assert.equal(
    landingSummary(landed({ status: "thinking" }).landing),
    null,
    "a merge still working has landed nothing yet, which is not the same as landing nothing",
  );
  assert.match(
    landingSummary(landed({ branchesLanded: 2 }).landing) ?? "",
    /2 branches/,
  );
  assert.match(
    landingSummary(landed({ branchesLanded: 1, branchesFailed: 2 }).landing) ?? "",
    /1 of 3/,
  );
  assert.match(
    landingSummary(landed({}).landing) ?? "",
    /landed nothing/,
    "a pass that landed nothing is what leaves the next one where this one started",
  );
  assert.equal(landingSummary(null), null);
});

test("a graph with no loop groups nothing, and its runs stay where they were", () => {
  assert.deepEqual(
    passesOf(passBlock("plain", "run", null), {
      nodes: [passRun("a", null)],
      blocks: [passBlock("b", "merge", null)],
    }),
    [],
  );
});

/**
 * The run page hides the notes its own run wrote and says so in one line, and
 * every way that line can be wrong is a well-formed sentence: "nothing said yet"
 * over a task the run just reported on, a count of this run's notes over a
 * thread the route only sent the newest three of, or "Newest 3 of 7" above one
 * row. `authorRunId` is the whole test for "this run's", so a note by another
 * run is the control that the filter is not on `author`.
 */
const NOW = Date.UTC(2026, 8, 26, 12, 0);
const RUN = "run-self";

function note(
  id: string,
  minutesAgo: number,
  author: TaskCommentDTO["author"],
  authorRunId: string | null = null,
): TaskCommentDTO {
  return {
    id,
    taskId: "task-1",
    author,
    authorRunId,
    body: `body of ${id}`,
    createdAt: NOW - minutesAgo * 60_000,
  };
}

test("a thread holding only this run's note draws no row and still says it was written", () => {
  const { drawn, line } = runPageNotes(
    { taskId: "task-1", newest: [note("a", 3, "run", RUN)], total: 1 },
    RUN,
    NOW,
  );
  assert.deepEqual(drawn, []);
  assert.deepEqual(line, { text: "This run left 1 note, 3m ago.", link: "Read it on the task" });
});

test("the operator and another run keep their rows beside this run's counted notes", () => {
  const { drawn, line } = runPageNotes(
    {
      taskId: "task-1",
      newest: [note("a", 9, "run", RUN), note("b", 5, "run", "run-other"), note("c", 2, "run", RUN)],
      total: 3,
    },
    RUN,
    NOW,
  );
  assert.deepEqual(drawn.map((n) => n.id), ["b"]);
  // The age is the newest of this run's notes, not the slice's oldest.
  assert.deepEqual(line, {
    text: "This run left 2 notes, the latest 2m ago.",
    link: "Read them on the task",
  });

  const theirs = runPageNotes(
    { taskId: "task-1", newest: [note("a", 4, "operator"), note("b", 1, "run", "run-other")], total: 2 },
    RUN,
    NOW,
  );
  assert.deepEqual(theirs.drawn.map((n) => n.id), ["a", "b"]);
  assert.equal(theirs.line, null);
});

test("past the slice, the count is only claimed over the newest notes", () => {
  const { drawn, line } = runPageNotes(
    {
      taskId: "task-1",
      newest: [note("e", 6, "run", RUN), note("f", 4, "operator"), note("g", 1, "run", RUN)],
      total: 7,
    },
    RUN,
    NOW,
  );
  assert.deepEqual(drawn.map((n) => n.id), ["f"]);
  assert.deepEqual(line, {
    text: "Newest 3 of 7, 2 of them by this run, the latest 1m ago.",
    link: "Read the thread",
  });

  const all = runPageNotes(
    {
      taskId: "task-1",
      newest: [note("e", 6, "run", RUN), note("f", 4, "run", RUN), note("g", 1, "run", RUN)],
      total: 7,
    },
    RUN,
    NOW,
  );
  assert.deepEqual(all.drawn, []);
  assert.equal(all.line?.text, "Newest 3 of 7, all by this run, the latest 1m ago.");
});

test("a clipped thread with none of this run's notes reads as it did before", () => {
  const { drawn, line } = runPageNotes(
    {
      taskId: "task-1",
      newest: [note("e", 6, "operator"), note("f", 4, "chat"), note("g", 1, "run", "run-other")],
      total: 9,
    },
    RUN,
    NOW,
  );
  assert.equal(drawn.length, 3);
  assert.deepEqual(line, { text: "Newest 3 of 9.", link: "Read the thread" });
});

/**
 * The cycle a `/runs/live` tile names, against the cap the guard enforces.
 *
 * Granted cycles are part of that cap (`budget.ts`), and a tile that drew the
 * cap without them would read "work cycle 4 of 3" on a run doing exactly what
 * it was allowed — the over-limit reading `grantedCycles` exists to prevent on
 * the run page, arriving one page over.
 */
const liveRun = (
  over: Partial<
    Pick<RunDTO, "iterations" | "active_iteration" | "max_iterations" | "validation_cycles">
  > = {},
) => ({
  iterations: 3,
  active_iteration: 4,
  max_iterations: 3,
  validation_cycles: 0,
  ...over,
});

test("a tile counts granted cycles into the cap and says so", () => {
  assert.equal(fmtLiveCycle(liveRun({ validation_cycles: 2 })), "work cycle 4 of 5 (2 granted)");
});

test("a tile with no grant names the cycle against the plain cap", () => {
  assert.equal(fmtLiveCycle(liveRun({ max_iterations: 6 })), "work cycle 4 of 6");
});

test("a grant cannot widen a run with no cap", () => {
  assert.equal(
    fmtLiveCycle(liveRun({ max_iterations: 0, validation_cycles: 2 })),
    "work cycle 4",
  );
});

/**
 * Which model a `/runs/live` tile names. Every branch typechecks and renders,
 * so a precedence that drifted from `orchestrator.ts`'s spawn would put a model
 * on the tile that the run is not on — and the one visible case, a local run
 * drawn as "Claude Code's own default", names a provider the run never reached.
 */
const modelOf = (
  over: Partial<Parameters<typeof resolveLiveModel>[0]> = {},
) =>
  resolveLiveModel({
    model: null,
    provider: "claude",
    agentModel: null,
    localModel: null,
    ...over,
  });

test("a run's own model outranks the local sign-in and the agent's", () => {
  assert.deepEqual(
    modelOf({ model: "claude-opus-5-5", provider: "local", agentModel: "claude-haiku-4-5", localModel: "qwen3" }),
    { label: "claude-opus-5-5", source: "run" },
  );
  assert.deepEqual(
    modelOf({ model: "claude-opus-5-5", agentModel: "claude-haiku-4-5" }),
    { label: "claude-opus-5-5", source: "run" },
  );
});

test("a local run with no model of its own is on the sign-in's, never the agent's", () => {
  assert.deepEqual(modelOf({ provider: "local", localModel: "qwen3", agentModel: "claude-haiku-4-5" }), {
    label: "qwen3",
    source: "local",
  });
  assert.deepEqual(modelOf({ provider: "local", localModel: null, agentModel: "claude-haiku-4-5" }), {
    label: "local model, signed out",
    source: "default",
  });
});

test("a run that named no model falls back to its agent's and says so", () => {
  assert.deepEqual(modelOf({ agentModel: "claude-sonnet-5" }), {
    label: "claude-sonnet-5",
    source: "agent",
  });
  assert.deepEqual(modelOf({ provider: "codex", agentModel: "gpt-5" }), {
    label: "gpt-5",
    source: "agent",
  });
});

test("with nothing named, the provider's own default is said in words", () => {
  assert.deepEqual(modelOf(), { label: "Claude Code's own default", source: "default" });
  assert.deepEqual(modelOf({ provider: "codex" }), { label: "Codex's own default", source: "default" });
});

test("a run with no recorded provider is never drawn as Claude Code", () => {
  assert.deepEqual(modelOf({ provider: null }), { label: "model not recorded", source: "default" });
  assert.deepEqual(modelOf({ provider: null, model: "claude-opus-5-5" }), {
    label: "claude-opus-5-5",
    source: "run",
  });
});

test("between cycles a tile counts what finished rather than claiming one open", () => {
  assert.equal(
    fmtLiveCycle(liveRun({ active_iteration: null, validation_cycles: 1 })),
    "3 of 4 work cycles done (1 granted)",
  );
  assert.equal(
    fmtLiveCycle(liveRun({ active_iteration: null, max_iterations: 0 })),
    "3 work cycles done",
  );
});
