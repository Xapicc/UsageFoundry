# Verification: Workflows and schedules — one workflow against several saved folders

[← Verification index](../verification.md)

## Verified

- **One workflow run against either of two saved folders, 2026-10-08**
  (production standalone build from this branch, scratch `DATA_DIR`, one mount
  holding two git repositories `alpha` and `beta`, a `CLAUDE_BIN` that exits 1,
  Chromium at 1280px): a run block set to follow the chosen folder, saved with
  both folders, POSTed 200. In the editor, *Move up* on the second folder and
  *Save changes* stored `["beta","alpha"]` and re-pointed the block's stored
  folder at `beta`. On the detail page the *Folder to run against* picker
  chose a folder and Run created a run whose folder was `…/workspace/beta`,
  the instance recorded `chosenFolder` `beta` and its page named it; an earlier
  pass chose `beta` while `alpha` was first, with the same result. A press with
  no body was refused 400 ("saved against 2 folders. Choose which one…"), and
  one naming `../` 400 ("not one of the folders saved on this workflow"). No
  console errors. Caveat: the workflow was first saved through the API with
  the body the editor sends, not by drawing the block; no agent ran, and a
  scheduled start's folder is covered by `runOrigin.test.ts` only.

- **Two presses of one workflow against two saved folders at once, 2026-10-08**
  (production standalone build of `b3905915`, scratch `DATA_DIR`, one mount
  holding plain folders `alpha`, `beta`, `gamma` and `tools`, a `CLAUDE_BIN`
  that does not exist, the new-work hold on so every run created stayed
  `queued` and live, Chromium at 1280px): with one block following the chosen
  folder and both folders saved, a press against `alpha` was 200, a second
  against `alpha` 400 ("…its “Build” works in scratch/alpha, where this
  press's “Build” would work too. Two presses of one workflow run at the same
  time only when they share no folder…"), and one against `beta` 200 with its
  run in `…/workspace/beta` — two instances live at once. Adding a block with
  its own folder `tools` made the `beta` press 400 ("“Tools” names its own
  folder, so every press of this workflow works there"), and a workflow with
  no folder list was refused its second press as before. On the detail page
  Run was disabled with that sentence and an "Open the one still going" link
  while the picker said `alpha`, enabled with no notice on `beta`, and
  disabled again on `alpha`; no console errors, no sideways scroll. Caveat:
  every press went through the API rather than a click, no agent ran, and the
  sentence names the mount by id where the picker names it by label.

- **Reopening a member of an older press is refused while a newer press works
  in its folder, 2026-10-17** (production standalone build of commit
  27622c80's tree, scratch `DATA_DIR`, mount `workspace` with `project` and
  `second`, a `CLAUDE_BIN` that does not exist, new work held): press 1 of a
  workflow of a run block and a deciding block, both following the chosen
  folder, was seeded idle (its run `failed` after one cycle, its turn
  `failed`), press 2 into `project` was admitted, and its deciding block
  stayed `waiting` across the server's boot (the `held` arm). `POST
  /api/runs/<press 1's run>/reopen` answered 400 "0 run(s) and 1 block(s)
  from another press of Run have not finished yet, … before picking this one
  up.", and the same call for a failed run outside any workflow answered
  200. This was the check that `reopenRun`'s `require("./workflows")`
  resolves in the shipped bundle (it compiles to webpack's own require of
  the module). Caveat: through the API rather than the run page's button,
  and the instance-page pick-ups were exercised by `orchestratorPickUp.test.ts`
  only.

## Not yet verified by hand

- **No two presses of one workflow have run agents side by side (2026-10-08).**
  Every run above stayed queued under the hold, so nothing has watched two
  instances of one workflow work, commit and land into two repositories at
  once, nor a nested or aliased folder refused outside `overlaps()`'s unit
  cases. Settle: lift the hold with a stub `CLAUDE_BIN` that commits once and
  exits, press `alpha` and `beta` on a graph ending in a merge block, and read
  both instance pages and both repositories' `git log`.

- **A schedule's overlap has not been driven per folder.** `overlapCount` in
  `schedules.ts` is read by no test. Settle: schedule a two-folder workflow,
  press Run by hand against the second folder, let a window come round — it
  must fire into the first — then with a press live against the first, the
  next window must record `overlap` with "shares a folder with this one".
