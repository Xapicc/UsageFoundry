# Isolation, branch chains, landing and the merge queue

> Extracted verbatim from `CLAUDE.md`, which grew past the size Claude Code will
> load into a session. Each paragraph records a correctness or safety decision
> whose violation is silent — nothing throws, nothing fails to typecheck.
> **Read before editing src/lib/land.ts, mergeQueue.ts, and resolveIsolation/ensureWorktree in orchestrator.ts.**

Each paragraph now lives in the topic file its heading links to: find the rule by its claim below and open that one file. A line number cited elsewhere as `docs/agent/isolation-and-landing.md:N` counts lines of this file before it was split on 2026-09-27; each entry ends with the line its paragraph started on at the split, and a citation older than that may be off by a few lines.

## [Worktrees, seeding and branch chains](isolation-and-landing/worktrees-and-branch-chains.md)

- An isolated run works on a branch, and a worktree contains committed work only. (was line 20)
- The merge target is recorded, never assumed. (was line 58)
- Work an agent left uncommitted goes onto its own branch, and nowhere else. (was line 62)
- A run can be told to carry on the branch its dependency was working on, and what it claims is the branch rather than the checkout. (was line 8)
- A continued branch takes the chain's base, never the predecessor's tip. (was line 10)
- The chain claims a branch, not a slot, and that is what makes an unrelated run taking the checkout harmless. (was line 12)
- A handed-over checkout keeps what the predecessor left uncommitted, and says how much. (was line 14)
- A continuing agent is told whose commits it is standing on. (was line 18)
- A null `isolation` means isolated-but-not-yet-planned, and every reader of the column takes it that way.
- `repo_root` is the repository a checkout was cut from, and is null on a run that was not given one.

## [Land, the verify gate and Deliver](isolation-and-landing/land-verify-and-deliver.md)

- The tool does now merge, and every protection the old "never merges" rule bought is a check in `land.ts` rather than a caveat. (was line 22)
- One branch, one Land button: the last run on it, and only once nothing behind it can still commit. (was line 16)
- A branch a live pass of a workflow loop is working on may be landed by that pass's own merge block and by nothing else, and every other refusal names the pass. (was line 52)
- The check in front of Land, and what an empty one means. (was lines 69–81)
- Which tree the check runs in is the whole of whether it checks anything. (was lines 83–97)
- The other exit. `deliverRun` pushes a run's branch and opens a pull request on the checkout's GitHub remote. (was lines 99–124)
- The Land card offers it once, and states every refusal instead of discovering one. (was lines 149–165)

## [Merge previews, the conflicts map and conflict resolution](isolation-and-landing/conflicts-and-resolution.md)

- Finding out whether a merge works must cost the operator nothing. (was line 26)
- What conflicts comes from the stage records; why comes from the messages, and only the first is trusted. (was line 28)
- The map at `/runs/[id]/conflicts` draws the preview the land card already fetched, and is allowed to claim less than the list beside it, never more. (was line 30)
- A conflict is resolved on the run's branch, never in the operator's checkout. (was line 66)
- No marker left is evidence only about a file git wrote markers into, so a conflict it left none in is refused before the spawn.
- While a resolution holds the run's checkout nothing else writes to it, and a restart does not hand it back open.
- The hold is the branch's, never the pressed run's, because a chain shares the checkout it protects.
- A resolution is shown as what it did, not only as what it said. (was line 32)

## [Clocks on the landing path](isolation-and-landing/landing-timeouts.md)

- Nothing on the landing path has a clock on its duration, and that is a rule rather than an omission. (was line 54)
- A resolution's child has one deadline, and it is an hour of silence rather than any length of run. (was line 56)

## [The merge queue](isolation-and-landing/merge-queue.md)

- Several branches are a queue, never a batch, and the queue re-decides at every turn. (was line 34)
- The repository is the unit of serialisation, not the process. (was line 36)
- Every outstanding batch is on the page, because the worker has never known what a batch is. (was line 38)
- A queue tells a branch's problem apart from the checkout's. (was line 40)
- Auto-resolution is authorised per batch and recorded per row. (was line 42)
- The worker answers the row it took, including when this app is the thing that broke. (was line 44)
- `git()` never rejects, and that is a contract rather than an observation. (was line 46)
- The queue panel polls whatever it last said. (was line 48)
- A queued merge is cancelled on boot, never resumed. (was line 50)

## [Branch inventory, squashes and deleting a branch](isolation-and-landing/branch-inventory-and-deletion.md)

- Every branch this app produced is reachable, and the cap is on the page rather than on the set. (was line 24)
- A squash is landed work that git cannot see. (was line 60)
- Delete deletes the exact tip it proved, and proves it against the target, never against whatever the operator has checked out.
- Getting rid of a branch is two doors, and only the careful one is called Delete. (was line 64)
- The other doors are claimed too, and by a *second* claim, because they are not about that folder. (was lines 126–147)
