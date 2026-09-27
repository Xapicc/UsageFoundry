# Verification: Workflows and schedules — a loop's repeated section: frames, marking, passes and pick-ups

[← Verification index](../verification.md)

## Verified

- **A pass as a section, 2026-09-21, `npm test` and `npm run typecheck` from
  the repo root:** 2964 assertions green, typecheck clean. What was measured is
  the pass runtime driven through the real creation path against a real git
  repository and a real SQLite database — `loopSection.test.ts`, 15 cases: two
  passes of a section that fans out to two members and merges produced exactly
  six run members and two merge members with the pass in every id, every
  dependency row carried `continue_branch = 0`, pass 2's entry was created with
  an empty dependency list and at or after the instant pass 1's merge block
  finished, and a pass whose third member's branch had never been cut settled
  its merge `failed` and stopped the loop without taking a second pass. DONE was
  read from both sides: every run member reporting it stopped the loop on pass
  1, and only the section's entry reporting it did not. An orchestrator member
  driven through `emitBlockRuns`/`settleBlock` put both its runs under the
  member's own id prefix, held the pass open while they were queued, and its
  $0.25 turn plus their $2.00 each tripped a $3.00 loop cap reporting 4.25. A
  block behind the loop was not created between two passes and, once the last
  pass's merge had settled, was created with an empty dependency list.
  Caveat: **nothing spawned and nothing merged.** `CLAUDE_BIN` names a file that
  does not exist, members are held at `queued` by a concurrency cap of 1, and
  every merge resolved to "nothing to land" because each branch sits at its own
  base — so git's own answer for a branch that has commits on it, and the next
  pass seeing them, is still unmeasured. See the open item below.

- **A loop block's repeated section round-trips through the save door and the
  validate route, 2026-09-21.** Against this branch: a graph whose loop carries
  `bodyNodeIds: ["a","b"]` through `normalizeWorkflowInput` → `createWorkflow`
  → `getWorkflow` → `workflowDTO` came back with the list intact, and feeding
  that DTO straight back in kept it — which is what the editor does on every
  Save. The same function answers the validate route, and a body left in two
  pieces was refused there by name ("The 2 blocks “L” repeats are not in one
  order"). Caveat: the validate route handler itself was not invoked, because
  `tsconfig.test.json` does not build `src/app`; what was exercised is the one
  function that route hands its parsed body to.

- **`npm run build` and `npm run smoke-pages` are green with the section in,
  2026-09-21.** 92/92 page loads clean across 23 pages, two skins and two
  widths, served from `.next/standalone/server.js` — the shipped artifact, not
  the `next start` fallback. `npm run typecheck` and `npm test` (2898 tests)
  are clean from the repo root.

- **A section of two blocks ran three passes end to end on one branch,
  2026-09-21.** Against the built standalone server on a throwaway `DATA_DIR`,
  a stub `CLAUDE_BIN` emitting one `stream-json` cycle, and a git repository
  under `WORKSPACE_ROOTS`: a loop capped at 3 passes over `Build → Test`
  produced six member runs — `Build — pass 1`, `Test — pass 1`, … `Test — pass
  3` — each completing in order, and `/api/branches` reported **one** branch
  for the whole instance (`heldByRuns: 1`), not one per run and not one per
  pass. That is "every pass is one branch, handed from each block to the next
  and carried into the next pass", measured. Caveats: the agent was a stub, so
  the branch carries no commits and nothing here says content accumulates
  along it; and it never printed DONE, so the loop stopped on its pass cap
  rather than on the last member's report.

- **The instance page draws those passes as passes, 2026-09-21.** Same run,
  Chromium at 1440px and 390px: the loop's own row read `REPEATING` and `3
  pass(es)` — passes, not the six runs — and a *Passes of Grind* card carried
  three group headings (`Pass 1  2 runs · $1.68`, `Pass 2  2 runs · $1.68`,
  `Pass 3  2 runs · $0.63`) with each pass's two runs beneath it in body
  order, with their own status, cycles and spend. No console error at either
  width. A workflow whose loop has no section kept the flat table it has
  today, which is `groupPasses` returning null.

- **Both routes into a section were driven in a browser, 2026-09-21.** Same
  harness, 1440px: dragging a loop card's Repeat handle onto `Build` put it in
  the section — the region appeared and `Build`'s accessible name gained
  "Repeated by Grind" — dragging onto it again took it out, two presses
  (handle, then block) did the same, and pressing Enter on a block while the
  handle was armed added it. Escape stopped the mode and the next click only
  selected. Marking a third block that did not chain drew the server's own
  refusal under the canvas ("The 3 blocks “Grind” repeats are not in one
  order"), which is the contract: the client restates none of them. Worth
  knowing before writing the next scripted drag — arming the mode inserts the
  strip above the sheet and moves everything under it about 30px, so a script
  that reads its target's box *before* the press releases above the card it
  aimed at and the gesture only arms. A hand watching the canvas follows the
  shift; the measurement re-reads the box mid-drag.

- **The section's new tests were checked against three mutants, 2026-09-21.**
  Chaining a pass onto the *first* run of the one before rather than the last
  (2 failures), dropping the member from a pass member's id (7), and dropping
  `continueBranch` inside a pass (4). Each mutant was reverted and the suite
  returned to 2898 passing. Caveat: this says the tests bite, not that the
  feature works against a live agent — see below.

- **A loop drawn as a frame, real build, stub CLI, 2026-09-21:** a workflow
  whose loop frames `triage → decide → land`, seeded through `/api/workflows`
  and opened in the built standalone bundle at 2400px and 390px. The frame is
  drawn round the three members with no card of its own, its strip reads
  *3 blocks in order · at most 3 passes · stops on $12 across them*, the
  members are marked *starts a pass* / *2 of 3* / *lands the pass · merge*, and
  no containment arrow is drawn. The inspector on the loop holds only the name,
  the stated kind, the read-only section, the two caps and the board condition
  — no task, workspace, template, agent or prompt-override control — and
  `BlockStatement` reads *up to 12 runs — a deciding member's fan-out is spent
  again on every pass*, which is 3 × (1 run + 3 fan-out). No console error at
  either width, `scrollWidth === clientWidth`, and no box wider than a
  non-scrolling parent. Caveat: one section shape, and the 12 is checked against
  the arithmetic rather than against a run that actually created 12 runs.

- **The Repeat gesture end to end, real build, 2026-09-21:** in a graph with no
  loop at all, Repeat is disabled with nothing marked and enabled after one
  click on a card; pressing it draws a frame round the marked block and
  everything linked after it, and opens the inspector on the new loop's Name.
  **Put in** then armed and took `spare` into the frame — linked beside the
  section so the merge block still lands it, badge *3 of 4*, strip *4 blocks in
  order* — and a second press on the same card spliced it back out, returning
  the graph to 3 blocks and 3 links. A link drawn from outside onto a member was
  refused at the release with *"work is repeated by block-1, so nothing outside
  can start it. Link to block-1 instead — that runs before the whole loop."*
  Save reached the server and was refused only by the un-named loop
  (*"Block 5 needs a name"*), which is the refusal any freshly added block gets.
  Caveat: driven by clicks rather than by pointer drags, so the drag route
  through `resolveLinkRelease` is exercised only by its unit tests.

- **Marking a block, every route into it, real build, 2026-09-21:** driven with
  real input events against `.next/standalone/server.js` on `/workflows/new`,
  two blocks from the palette. Before the fix, a Shift-click anywhere on a
  card's body left Repeat disabled and nothing outlined, and a plain click on
  the body selected without marking — only the name button marked at all, which
  is what the footer and every card's `aria-label` promised of the whole card.
  After it, a plain press on the body marks exactly that block and selects it, a
  Shift-click on a second reads *Repeat 2 blocks* with both outlined, a third
  Shift-click on the same card takes it back out, ⌘-click extends the same way,
  and a 30px drag moved the card and left the marks alone. A press on the bare
  surface cleared the marks with the selection. The name button's own routes are
  unchanged and fire once — Shift-click on it and Shift+Enter on it each toggled
  one block, so the card's captured pointer sequence does not also reach the
  button beneath it. With Link armed on one card, a press on another card's body
  drew the link and marked nothing. Shift-clicking a frame's name now marks the
  frame, which it draws with the card's own outline, and Repeat then answers
  *"block-3 is a loop, and a loop cannot be inside another one."* — a refusal
  `resolveRepeat` has always carried and no route could reach. At 390px the list
  route is unchanged: a tap marks one row, Repeat frames it. No console error in
  any of it. Caveat: one browser (Chromium) and a two-block graph, and the
  modifier chord was exercised with Shift and ⌘ but not ctrl.

- **A pass drawn as its members, real build, stub CLI that completes a cycle,
  2026-09-21:** one press of Run on the framed workflow above, with a stub
  `CLAUDE_BIN` that prints an init event, a `DONE` reply and a cost. Pass 1 drew
  all three members under one heading — `triage — pass 1` completed at $0.42,
  `decide — pass 1` failed, `land — pass 1` blocked — in section order, with the
  pass's own figure *3 blocks · $0.42*. Before the `emittedBy` fix the member
  run was folded under the loop and drawn nowhere; that is what
  `format.test.ts`'s decider case now holds. Caveat: the orchestrator member
  failed under the stub, so an orchestrator member's emitted runs drawn beneath
  it, and a pass's landing clause, are covered by unit tests and not by this
  measurement.

- **A frame drawn in the editor, saved and run, 2026-09-21:** on a graph with
  no loop in it, one click on a card and Repeat drew a frame; a pointer **drag**
  from the frame's Put in handle onto a fourth card took it in — strip *4 blocks
  in order*, four drawn links — and the saved graph read
  `block-1:loop[plan,work,spare,land]`, the section in pass order with the merge
  block last. Run on that graph instantiated a pass of four: the instance page
  drew *Pass 1 · 4 blocks · $1.50 · landed nothing — the next pass saw no new
  work* with `plan`, `work`, `spare` and `land` under it, and the loop stopped
  on *"nightly" reported the work complete on pass 1*. No console error through
  any of it. This is what found the frame's handles sitting at its far right,
  off the pane for any section wider than it, now moved beside the name. Caveat:
  the stub commits nothing, so the landing is the nothing-landed reading.

- **A section at 390px, drawn and run, 2026-09-21:** the same chain through the
  narrow list, where the canvas is rows rather than a sheet and there is no
  modifier to hold. Tapping `plan` and pressing Repeat framed it — the rows then
  read *repeated by block-1, starts a pass* / *2 of 4* / *3 of 4* / *lands the
  pass* — and the row's own two-press **Put in** took `spare` in. Saved clean,
  the graph read `block-1:loop[plan,work,spare,land]`, and Run drew all four
  members under Pass 1 at $1.50. `scrollWidth === clientWidth` throughout and no
  console error.

- **An orchestrator member that actually emits, 2026-09-21:** a section of
  `triage (run) → decide (orchestrator, fan-out 3) → land (merge)`, with a stub
  `CLAUDE_BIN` that reads its own `--mcp-config`, calls `initialize` and then
  `tools/call` for `emit_runs` with two specs. The instance page drew Pass 1 as
  `triage — pass 1` completed $0.25, `decide — pass 1` *decided · started 2
  run(s)*, **`First slice` and `Second slice` beneath it**, each *started by
  decide — pass 1* at $0.25, then `land — pass 1`. The heading read *Pass 1 · 3
  blocks · $0.75* — the three runs, with the deciding turn on its own row and
  not in the sum, which is what `passRuns` is written to do. No console error.
  **This is what found the landing defect filed as a task:** the heading's
  clause read *landed 0 of 3 branches — the next pass did not see the rest*,
  because `loopStillRepeating` refuses a pass's own merge member. The pass group
  itself is what was being measured and it is correct; the figure in its landing
  clause is the product defect showing through.

- **A loop that repeats a section saves with no task of its own, and three
  doors say so, 2026-09-21.** `normalizeWorkflowInput` accepted a two-block
  graph whose loop carries a `repeats` link and `task: ""`. The same input
  against a build of the parent commit was refused with *“Repeat
  Orchestrator Loop” has no task to repeat. A loop with nothing to do is a
  billed run per pass that spends a work cycle finding that out.* — the
  operator's own report. A section-less loop with no task was refused by both
  builds, character for character the same sentence.

- **The three doors a section loop's task is drawn at were read against the
  built standalone server, 2026-09-21.** A graph carrying a section *and* a
  leftover task was accepted with the task stored verbatim, seeded into a
  scratch `DATA_DIR` and read back: `/workflows/<id>` drew *Its own task is
  not read while it repeats a section* on the loop's row and the ordinary task
  text on a section-less loop beside it; the editor's own panel, with the loop
  selected, gave the Task row the hint *Not read while this block repeats a
  section — each block in it has its own task* and a `BlockStatement` reading
  *Repeats 2 blocks each pass, in this order: Plan the slice, then Do it …* with
  no mention of the loop's own task, workspace or guards. `npm run smoke-pages`
  was 92/92 against the standalone bundle. Caveat: no agent ran and no instance
  was started — `CLAUDE_BIN` pointed at `/bin/false` — so this says what the
  three pages state about a saved graph, not what a pass does. The instance page
  was read by grep rather than rendered: it draws no block task at all, so there
  was nothing there to correct.

- **On the two entries above: the door they measured is not the door this tree
  has.** They are kept because a measurement is never amended in place, and they
  are true of the build they were taken against — one in which a loop's own task
  was optional and a leftover one was kept and labelled at three doors. A loop is
  now a frame that is told nothing: `normalizeNode` refuses the task **by name**
  with the workspace, folder, template, agent and prompt override, so there is no
  loop task to store, no Task row in the inspector to hint beside, and none on
  `/workflows/[id]`'s loop row. What still holds from them is the half that
  became the rule — a loop that repeats a section is saved with no task of its
  own — and the frame entries higher up this section are the current readings of
  every surface those two name.

- **A loop stopped on a pass is picked up from the instance page, against a
  copy of the live database (2026-09-25, at `3276ef9` plus this change).** A
  snapshot of the container's database under `next dev` with a `CLAUDE_BIN`
  that cannot spawn. The Sep 25 run of "Dockrac - Taskboard sweep" had stopped
  at pass 2 on a needs-review run that was since resumed and completed on its
  own page; `pickUpsOf` offered "Carry on the loop", the press reopened the
  loop, and pass 2's merge was released with all nine branches — then failed
  because the branches do not exist on the host, and the loop stopped again
  naming that and offering "Retry merge". The two Sep 21 runs each offered
  "Retry merge" for a pass-1 merge that had failed. With the loop's board
  folder missing the pick-up was refused by name and wrote nothing. Caveat:
  nothing landed; see the open item below.

## Not yet verified by hand

- **The three loop panels changed with the runtime have not been opened in a
  browser.** A pass is no longer a chain, and three places in the editor and the
  instance page said it was: the section list called its last member "last — its
  DONE ends the loop" and now marks every run member "its DONE counts"; the
  intra-section link panel stated one branch handed from block to block and now
  states per link whether it carries the predecessor's branch or cuts its own;
  and the instance page's two loop hints said each pass carries on the previous
  run's branch and now say each pass lands its own work. All three typecheck and
  none has been rendered. Settle: `npm run build && npm run smoke-pages` for the
  load assertions, then a dev server, a workflow with a loop over a section that
  forks, and a look at the section list, a link inside the section, and a
  started instance's two hints.

- **No loop has repeated a section against a live agent.** Everything about a
  multi-member pass is unit-tested or driven with the members held at `queued`:
  `loopSection.test.ts` caps concurrency at 1 so nothing is released, and writes
  the branch columns a release would have written, because they are filled in at
  release and a pass's merge block refuses a branch that is not on the disk. Two
  things are still open, and the second is new since a pass stopped being a
  chain on one ref. **No run of a section has committed anything**: the stub
  agent that drove the earlier hand-over does not commit, so no branch of a pass
  has ever carried a commit. And **no pass has landed for real**: the merges in
  `loopSection.test.ts` all resolve to "nothing to land", because every branch
  sits at its own base, so the path from a pass's merge block through
  `mergeQueue.ts` into the operator's checkout — and the next pass's runs cutting
  fresh branches that can *see* that landing — has been driven by nothing.
  Settle both together: give the stub a `git commit` per cycle, run a two-member
  section for two passes, then read `git log --oneline main` in the mount and
  check that pass 2's branches are cut from a commit that carries pass 1's
  work.

- **No pass has landed a branch against a built server.** The refusal that made
  it impossible is gone and a pass landing its own branch is now driven under
  `npm test` — `loopMergeOwnership.test.ts`, recorded above — but by hand the
  landing clause has still only been seen at *landed nothing* and at *landed 0
  of 3 branches*, and no loop has taken a second pass in a browser. Settle: run
  the same emitting fixture against a built server and read pass 2 for members
  that start from what pass 1 landed.

- **A pick-up that actually lands.** Leaving a run behind, retrying a merge
  and carrying a loop on have run against a database snapshot and in
  `loopSection.test.ts`'s repository, never against a real checkout with real
  branches. Settle it by picking a stuck loop up in the container and reading
  the merge queue's rows and the target branch afterwards.
