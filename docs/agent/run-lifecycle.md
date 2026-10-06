# A run's life: origin, parking, refusals, prompts, endings

> Extracted verbatim from `CLAUDE.md`, which grew past the size Claude Code will
> load into a session. Each paragraph records a correctness or safety decision
> whose violation is silent — nothing throws, nothing fails to typecheck.
> **Read before editing src/lib/orchestrator.ts, fleet.ts, requestLog.ts,
> notify.ts, stackRequests.ts.**

This file is an index. Each line below is the lead claim of one paragraph, and the paragraph itself is in the topic file its heading links to.

## [Origin, queue order and the request log](run-lifecycle/origin-queue-and-request-log.md)

- A run records the gate it came through, and a pick-up is not that gate.
- What the queue is allowed to consider besides age.
- Every mutating request leaves a line, and the line is a shape rather than a dump.

## [The fleet stop, the new-work hold and set-aside](run-lifecycle/fleet-stop-hold-and-set-aside.md)

- There is one install-wide stop, one install-wide hold, and neither is a new way for a run to end.
- The hold is a settings row of its own, and seven separate call sites read it.
- An orchestrator block's deciding turn is held at its claim, not refused at its emission.
- A control that acts on a set needs a per-run way to say no, and `runs.set_aside_at` is it.
- A refused run is still in the restart notice's count, so the answer to a press is drawn beside the button, never in place of it.

## [Parking, refusals and the rate-limit ladder](run-lifecycle/parking-and-refusals.md)

- A run parks on two triggers, and only one of them needs configuring.
- The refusal allowance is its own count, and only a refusal spends it.
- The run page names which trigger parked the run, off the event that parked it.
- …and says when it is no longer waiting for the window but for its folder.
- A refused run backs off; it does not trust the window boundary.
- …and every run's answer is spread, because every input to it is shared.
- A `<synthetic>` turn is not by itself a refusal — the cycle's own outcome decides.
- A refusal has three answers, not two, and the third one is not a park.
- …and a rate limit is a transient failure that is not the same transient failure, so it has its own ladder and its own ending.
- A paused run is reconsidered, not trusted.

## [Waiting for a stack](run-lifecycle/waiting-for-stack.md)

- A run has a third answer to a missing tool, and it is a question rather than an install.
- The park is read off the record at the cycle boundary, below the machine's rungs and above the task's.
- The cycle that asked is refunded, and the refund is bounded.
- It is a park in every column `paused` writes except `resume_at`.
- It survives every boot, and the boot is what releases it.
- The release is one pure decision, and it agrees with the tool about what is installed.
- What the resumed run is told travels in `follow_up`, and the grant needs nothing.
- An attachment means exactly "between asking and being answered".
- It notifies, because only a person ends it.
- Two things are deliberately thin.

## [Reopening, pick-ups and resumed sessions](run-lifecycle/reopen-and-resume.md)

- Reopening a finished run is an operator decision, not a resume.
- A reopened run carries one message, resolved at the door and consumed at the spawn.
- A run that asked for a person is picked up by name, never in bulk, and is told what to check first.
- A cycle the container killed is told so, above the branch that reads a stale column.
- A restart on top of existing work says so in the prompt.
- Whether a run can be continued is decided by `session_id`, so it is recorded the moment the stream names it — not when the cycle returns.
- A resume that comes back under a different id is logged, never treated as a failure.
- The first cycle of a resumed segment is the one that can fail without doing anything.
- A session whose transcript is gone is restarted before the cycle, not discovered by failing one.

## [How a run ends: the terminus, cancellation, DONE, needs-review and verdicts](run-lifecycle/endings.md)

- The UI says "work cycle", the code says "iteration".
- Every budget rule can be switched off, but the loop must always have a monotone terminus.
- `cancelled` is checked twice per cycle, and both matter.
- The first cycle is told how the run ends, and it is told in generated text.
- There is a fourth ending, the agent asks for it, and it is the only rung of the ladder that is about the task rather than the machine.
- The sentinel is taught on every prompt but the operator's own, and it is not gated on `endsOnDone`.
- `continueAfterDone` sends the agent back in after `DONE`, with a different prompt.
- A cycle boundary can now be held open by a verdict, and where that test sits in the ending ladder is the whole of its safety.
- The cycle a verdict buys carries the evidence, not a scolding, and `nextPrompt` ranks it above both standing prompts and below the operator's own words.

## [A cycle's CLI, argv and appended notices](run-lifecycle/cycle-argv-and-notices.md)

- Three flags ride *every* cycle's argv, not the opening one, and `--resume` restores none of them.
- Which CLI a cycle is, what argv it gets and how its stdout is read are one choice, made once per cycle.
- `runs.provider` records which CLI a run was admitted as, and `null` on it is a third answer rather than a default.
- An isolated run is told what its worktree does not isolate.
- A run is told to delegate, and the instruction has a floor in it.
- A run is told a browser is already here, because the command it reaches for from memory is the one thing that does not work.

## [What a work cycle does with background tasks](run-lifecycle/background-work.md)

- In `-p` mode the CLI keeps its process alive after the agent ends its turn for as long as a background sub-agent is running, and kills the lot when its own ceiling passes — so the ceiling is set per cycle, and it is a guard rather than a tuning knob.
- Which guards bind while the CLI sits idle waiting, under `between-cycles`, and which do not — measured where the table says so, otherwise read from code.
- When a cycle ends with background tasks the CLI stopped, the next cycle's prompt says so, names them, and gives their output files.
- What this does not do.

## [Outbound notifications](run-lifecycle/notifications.md)

- A run ending can leave the machine, and where that sink attaches is the whole of its data-minimisation argument.
- What is worth a notification is its own named constant and its own four-part filter, and every part of it is a decision about noise.
- One park notifies, and it is the one only a person can end.

## [What replaced `--autocompact`, and compaction notices](run-lifecycle/autocompact-and-compaction.md)

- `--autocompact` is gone, and `contextPruning.ts` is what replaced it.
- What the removal gave up is measured, and it is the strongest measurement in this repository.
- The two mechanisms are not the same operation, which is the case for the swap.
- Never run both.
- Every failure on this path is a log line and nothing else.
- When a compaction happens the run says what it took, and it says it from the vendor's table rather than from anything measured here.

## [The cycle-boundary prune](run-lifecycle/boundary-prune.md)

- A prune happens at two moments and only one of them is free.
- Two engines do the cutting, and which one is configured never labels a figure.
- A prune answers two questions and one subtraction cannot answer both.
- Tokens, never bytes, and the number is computed here rather than read from the tool.
- Every boundary writes down how it ended, and that is what makes an empty section honest.
- `PAYBACK_HORIZON_TURNS` and `CEILING_PAYBACK_HORIZON_TURNS` are one policy in two arithmetics, and sharing a number got it wrong.
- `paybackTurns` takes the suffix *before* the cut.
- `gentle` is not offered.
- Pruning and `startsFresh` are independent switches, and the one place they touch is a correction.

## [The live context ceiling](run-lifecycle/context-ceiling.md)

- The ceiling asks the engine that would do the cutting, and asking the other one silenced the feature for two days.
- A `treat` dry run is read in bytes and converted as a share, never through `BYTES_PER_TOKEN`.
- The ceiling has its own watch map, not `liveGuards`.
- The ceiling's growth mark dies with the conversation it measured.
- A `prune` interrupt is the one kind that does not end the run

## [Context samples and the tick's cadence](run-lifecycle/context-samples.md)

- `prunerState()` is shipped unconditionally, and `observePlan` is gated.
- The tick's reading is written down, and the one thing it is not gated on is pruning.
- When the number last moved and when it was last looked at are two facts, and the panel needs both.
- The read's cadence came off the budget's.

## [Context composition](run-lifecycle/context-composition.md)

- The tick reads what the window is *made of* as well as how full it is, and the two are not one measurement.
- Winnow's window and this app's are the same measure from different anchors, and nothing may subtract one from the other.
