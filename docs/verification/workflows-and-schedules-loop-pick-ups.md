# Verification: Workflows and schedules — a loop's pick-ups, and an in-folder tail's dirt

[← Verification index](../verification.md)

## Verified

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

- **An orchestrator tail's dirt, and a pick-up that spawns nothing, under
  `npm test` (2026-10-26, at `a177041e` plus this change).**
  `loopSection.test.ts` drives a landing section whose tail is an orchestrator
  on a flat template: its emitted runs leave an edit in the folder, and the loop
  fails at the boundary on the same sentence a run tail gets, with no pass-2
  row, where before it opened pass 2. Mutating the compiled `workflows.js` to
  read `member.run` alone fails that case; putting `loopPassDirt` back inside
  `loopPassRefusal` fails the case that counts `spawnSync` and `spawn` across
  `pickUpsOf`, which is 0 now; dropping `--branch` fails the sentence's ` M
  a.txt`, whose leading space `gitSync`'s trim used to take. The press over the
  dirty folder answers 409 with the sentence the loop failed on, and carries on
  once it is committed. Caveat: the repository is a plain `git init`, and spawns
  are counted at `child_process`'s `spawnSync` and `spawn`, so a git started
  another way would not be seen.

## Not yet verified by hand

- **The instance page's wording for a loop that failed before its first pass
  has not been rendered.** A loop with no pass is now offered "Carry on the
  loop", and the row's description and the confirmation sheet's body read
  "Failed before its first pass…" and "Its tasks are counted again…" for it
  rather than the pass-numbered text. The server side is driven under
  `npm test` (`loopSection.test.ts`); the strings typecheck and nothing has
  drawn them. Settle: seed an instance whose loop failed on a board folder
  removed before its release, serve a build over it, and read the row and the
  sheet at 390px and 1280px.

- **A pick-up that actually lands.** Leaving a run behind, retrying a merge
  and carrying a loop on have run against a database snapshot and in
  `loopSection.test.ts`'s repository, never against a real checkout with real
  branches. Settle it by picking a stuck loop up in the container and reading
  the merge queue's rows and the target branch afterwards.

- **A tail that leaves the folder dirty, and a guard switched mid-loop, on a
  built server.** The loop's refusal to open a pass over what an in-folder tail
  left (`tailLeftDirt`) and its refusal of a member whose guards no longer match
  its section (`sectionKindRefusal`) are driven under `npm test` against a real
  repository and the real merge queue (`loopMergeOwnership.test.ts`,
  `loopSection.test.ts`), and nothing else. Nothing has drawn the stop sentence
  on the instance page or the 409 a *Carry on* pressed over it returns, and the
  synchronous `git status --porcelain` at the pass boundary and at the press has
  not been timed on a large checkout. Settle: seed a two-pass landing section
  whose tail edits a tracked file, serve a build over it, read the failed loop's
  row and its pick-up at 390px and 1280px, press *Carry on* and read the error,
  commit the edit and press it again; then time
  `gitSync(folder, ["status", "--porcelain"])` on the largest repository in the
  mount.
