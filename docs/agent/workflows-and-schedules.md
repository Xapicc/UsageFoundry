# Workflows, orchestrator blocks, merge blocks and schedules

> Extracted verbatim from `CLAUDE.md`, which grew past the size Claude Code will
> load into a session. Each paragraph records a correctness or safety decision
> whose violation is silent — nothing throws, nothing fails to typecheck.
> **Read before editing src/lib/workflows.ts, schedules.ts, canvasGraph.ts.**

The paragraphs themselves live in `docs/agent/workflows-and-schedules/`, one topic file per heading below. Find the rule by its lead claim and open the file its heading links to.

## [Workflow nodes and instantiation](workflows-and-schedules/nodes-and-instantiation.md)

- A workflow is the third thing here that is form input, and it is not the fourth route to `--permission-mode`.
- A workflow is instantiated in topological order, in one synchronous pass, all or nothing.
- A block that emits nothing blocks what is behind it, and that is a decision rather than a fallout.

## [Orchestrator blocks and merge blocks](workflows-and-schedules/orchestrator-and-merge-blocks.md)

- A block can decide what runs next, and those runs start with no approval — because the approval moved to the graph rather than disappearing.
- And what the turn said is kept, in three fields that are three voices.
- `taskIds` on an emitted spec is not a sixth field on the list `emit_runs` refuses to grow, and it is not on the node at all.
- Acyclicity stops being a property of who wrote the graph, so it is checked as a property of the data.
- A block can land what the blocks in front of it built, and every protection that made `land.ts` safe stays where it is.

## [Halting, status and pick-ups of a workflow instance](workflows-and-schedules/instance-lifecycle.md)

- A workflow instance is halted through one door, and the door is closed before anything is signalled.
- Four of an instance's six readings are derived, and `started` is not a word for a press of Run that is over.
- A stuck workflow run is picked up one named obstacle at a time, and never through a halt.

## [The instance budget and the instance total](workflows-and-schedules/instance-budget.md)

- A workflow instance carries its own budget, and it is checked between blocks rather than during one.
- The instance total is a fourth reading, and the door telemetry reaches it through is the same one, widened by one caller.
- A person sets an instance budget, and there is nothing on the wire that could.

## [Schedules](workflows-and-schedules/schedules.md)

- A schedule is the first thing here that starts an agent with no person present at all, and every property that makes that defensible is somewhere else.
- A missed window is not made up, an overlap is skipped rather than queued, and both are on the page.
- The zone is stored with the schedule, and an unknown one is refused rather than replaced.
- One timer per process, `globalThis`-pinned, lazily started and stopped.

## [Loop blocks and their sections](workflows-and-schedules/loop-sections.md)

- A section repeats by unrolling — the back edge is the thing that must not exist.
- A loop is told nothing, and the next reader will try to give it work.
- Membership is derived from a marked link, and the link is the *only* thing that states a section.
- A `repeats` link is never a run dependency.
- A loop's `bodyNodeIds` is derived from its `repeats` link and is never empty.
- A section is one way in and one way out, and the way out has to land.
- A path to the exit is not a branch to it, so every run member has to hand its branch to something that takes it.
- An orchestrator or review member is asked the same question about the branches it hands on, and only a link straight to a merge or review block answers it.
- A loop's own task and an intra-section link's condition were each answered a different way before the frame, and both of those answers are still findable in the tree.
- A body member is the one node here that is neither a run nor a ledger row.

## [When a loop stops: exit conditions, caps and the board condition](workflows-and-schedules/loop-termination.md)

- A loop's exit conditions are four, and the first of them is what the agents said rather than what a row says.
- A pass that reported it could not finish ends the loop, and the rung above it is why that works at all.
- A loop's two caps are termini, not guards, and that is why they are allowed on a node at all.
- A loop's board condition is a third terminus and the only one that is not a fact about a pass, which is why it alone is read before the first pass and never while one is still working.
- The condition's numbers are an `or`, its project is one folder unless told otherwise, and a condition saved as one number is read in exactly one place.

## [Loop passes: scheduling, run counts, members and `looping`](workflows-and-schedules/loop-passes.md)

- A pass is the section instantiated, and there is one scheduler.
- `MAX_LOOP_RUNS` is the arithmetic nobody does, and an orchestrator member's fan-out is spent per pass.
- Nothing is manufactured within a pass, and nothing at all is carried between passes.
- The instance page draws a pass as the group of members it is, and `passesOf` is the one reader that decides what is in one.
- `passMemberId` owns the spelling of a member id and `passNumberOf` is the only thing that reads one back.
- `looping` is the one exception to "a block adds no status", and it is an exception rather than a precedent.

## [The workflow canvas and block layout](workflows-and-schedules/canvas-and-layout.md)

- A workflow is drawn on a canvas, and where a block sits is not part of it.
- Containment is never derived from where a block sits, and the frame is where an operator sees it.
- The client orders a body by the body's own edges, and it has to be the same order the server will run it in.

## [Editing loops on the canvas: frames, gestures, inspector and Run page](workflows-and-schedules/loop-editing.md)

- A loop is made by framing blocks and unmade by deleting the frame, which is why it is in no palette and in no kind picker.
- Taking a block out of a frame splices rather than cuts, and that is the whole of `linksWithoutMember`.
- A loop's inspector holds what a loop has and nothing else, because a control for a refused field is a trap.
- A loop's six fields are hidden rather than disabled, on the inspector, the canvas card and `/workflows/[id]` alike, and nothing has to come back.
- Put in is the link tool's own two gestures over a second relation, down to `resolveLinkRelease` deciding both releases.
- The Repeat gesture is a mark and a press, and marking is canvas state rather than the editor's selection.
- The one refusal this surface states in its own words is the link drawn into a frame, and it is stated at the release.
- `/workflows/[id]` is the page Run is pressed from, so its loop row must state the same number the editor's statement does.

## [Review blocks and a block's provider](workflows-and-schedules/review-blocks-and-providers.md)

- A run block and an orchestrator block may name the provider their runs use, and only a person saving the graph can.
- A review block hands on the branches a frontier model approved, and nothing it set aside.
- A set-aside branch marks its tasks needs-frontier, and only when a frontier model turned it down.
- Its fix runs are the instance's runs and its reviews' cost is the block's.
- It is one async function per block, the merge block's shape.
