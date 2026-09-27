# Verification: Isolation and landing

[← Verification index](../verification.md)

## Verified

- **Isolation, real repo with uncommitted work and a gitignored `.env`:** two
  runs start in separate slots on their own `uf/…` branches with `.env`
  seeded; the operator's modified file and branch are untouched.

- **Review and land, real scratch repos, stub CLI (unbilled):** diffs survive
  a rename, a binary and a tab-named file; land refuses a dirty or wrong-branch
  checkout and leaves HEAD unmoved on conflict; a stub resolver faking success
  is caught and rolled back, cost still recorded. Also driven in a browser.

- **Merge queue, five-branch scratch repo, live dev server, stub resolver:**
  branches landed in queue order, the $0.07 resolution on the queue row not
  the run; with the resolver off the next branch still landed; a dirty
  checkout skipped both queued branches without paying to resolve.

- **Conflict display, git 2.50, a content and a modify/delete conflict:** real
  `merge-tree --write-tree -z` through `parseMergeTree` lists each file once
  with its type and `<<<<<<<` block, and the run page renders both.

- **Resolution display, from a seeded `run_reviews` row, never a real
  agent's:** `GET /api/runs/<id>/land` returns the resolution's own diff over
  the conflicted paths and the run page renders it.

- **The Land verify field in a browser, 2026-09-07**, standalone bundle:
  settings search found it inside the closed *Isolated runs* fold and focused
  it; `npm test && npm run typecheck` drew the argv warning on blur, before any
  Save; "Checks a conflict resolution may run" sits beneath it.

- **Conflicts map (`/runs/[id]/conflicts`) seen against real `merge-tree`
  output.** `next dev`, eight planted runs on built repos, 1280×1100, light
  theme: 21 paths (12 unopened, drawn hollow and dashed), three of four fills,
  the inspector, five empty states, n=1, one link in. A binary conflict reads
  `contents`, as `parseMergeTree` takes the last record.

- **A live loop pass's own merge block may land the pass's branches; nobody
  else may.** 2026-09-21, `src/lib/loopMergeOwnership.test.ts`, 11 assertions
  over a real git repository and a real merge queue. Before the change, a pass
  driven through `advanceInstances` onto a branch carrying a commit reported
  `Landed 0 of 1 branch(es). uf/… — Pass 1 of the workflow block “Chip away” is
  still running on this branch and lands it at its own merge block … Stop that
  run of the workflow first.` — verbatim the sentence the Dockrac install
  produced on ten branches. After it, the commit is in the operator's `main`,
  `runs.landed_at`/`landed_into` are written and `blocksOf` reports
  `branchesLanded: 1`. `loopStillRepeating` now takes the asker, resolved from
  `workflow_instance_blocks.merge_batch_id` back to the block that queued the
  batch, and exempts the owning pass alone: a later pass of the same loop, a
  merge block of another instance, and a batch nothing queued are each still
  refused with the unchanged sentence, as are a person's Land, Delete, Purge
  and Resolve. Caveat: the exemption is keyed on (instance, loop node, pass),
  so a section that itself holds a loop leaves the *outer* hold standing over
  an inner pass's merge — conservative, untested, and not reachable through the
  editor today.

- **A pass that genuinely cannot land still fails with the reason it has.**
  Same file and date: the same fixture with an untracked file in the operator's
  checkout halts the repository on `The checkout has uncommitted changes`, the
  merge block settles `failed`, and `blocksOf` reports `branchesFailed: 1`.
  This run changed who may land, not what a failure to land means.

- **A resolution's longest silence is minutes, not an hour.** Measured
  2026-09-27 over every transcript under `~/.claude/projects` whose first prompt
  is `resolvePrompt`'s: 79 (8 in `-resolve-` checkouts, 71 in runs' own
  worktrees), 8 repositories, 2026-08-28 to 2026-09-26, CLI 2.1.226, 2.1.260
  and 2.1.280. The largest gap between consecutive timestamped entries per
  transcript ran 3.7s to 193.5s, median 32.0s, p90 115.3s; three of the top
  four (176s to 184s) were the CLI's API retries ending in a synthetic `API
  Error` and an exit of its own. None hung; the longest of 161 `Bash` calls
  took 20.3s. `RESOLVE_SILENCE_MS`'s hour rests on this. Caveat: an entry
  stands in for a stdout line, and no long verify command was in the sample.

- **A merge queue drain stops at the next row once a shutdown starts,
  2026-09-27**, a scratch script over the compiled modules, two `queued` rows
  in one repository whose runs have no branch. `shutdownRuns` called while the
  first row was inside `landState`: `45f85c2` answered both rows, `4c8a20b`
  answered the first and left the second `queued` for the boot. Called before
  `startWorker`: `45f85c2` answered both, `4c8a20b` started no drain. With no
  shutdown both answered both. Caveat: the rows fail at "no branch", so no
  real `git merge` into a checkout ran, and the script is not in the tree.

- **The Land card offers no Commit on a checkout a resolution holds or left
  mid-merge, 2026-09-27**, a standalone build of this change served against a
  scratch `DATA_DIR`, one seeded run, and `GET /api/runs/<id>` and `/land`
  intercepted by Playwright at 390px and 1280px. An ordinary pending path drew
  Commit and Purge; a `UU` path with `merging` drew a warn hint and Purge but
  no Commit; a `running` resolution drew neither, with the hint in Commit's
  place. No console error, no sideways scroll. Caveat: the DTOs were written
  by hand, so this is the render and not `landState` producing them, and
  neither skin but the standard light one was looked at.

## Not yet verified by hand

- **The Land verify field was never saved**, so its check covers the form, not
  the round trip; the other four controls added 2026-09-06 were not looked at.

- **Neither three-valued reading has been seen on a real install**: the branch
  row's unread checkout (smoke-pages' `/branches` held no branches) and
  `run.guard_unreadable` (no run has hit `no_ceiling`). `heldByCheckout`
  matching the `MAX_PENDING_PROBES` skips is by construction. Settle: past the
  cap on one repo, rows must say "checkout could not be read" and offer Commit.

- **Two conflict resolutions in one repository have never run at once.**
  Only the checkout collision is tested (`resolveCheckout.test.ts`, two real
  `git worktree add`s, no `claude` child); the merge queue resolving one while
  the operator resolves the other, and each `run_reviews` row describing its
  own work, need Docker and two billed children.

- **Conflicts map unseen in the shipped image, dark theme, 390px, reduced motion
  or folding.** No `docker compose up`; nobody watched a CPU meter; the grey
  `untyped` fill (unit-tested only) and `none-named` need records the git on
  hand will not produce; folding needs a few-hundred-path conflict or a lowered
  `MAX_DRAWN_FILES`.

- **No run has met a real exhausted checkout store.** `resolveIsolation`'s
  refusal is unit-tested only. Dirty `<mount>/.uf-worktrees/<slug>-1` … `-64`,
  confirm Branches shows `0 of 64` free and an isolated run is refused with the
  sentence; which of its four counts it prints has only been unit-tested.

- **The branches filter and pager have never run on a real inventory past 400
  runs.** `selectBranchCandidates` is unit-tested; unchanged git cost rests on
  the cap. Settle with `curl -s 'localhost:3000/api/branches?offset=60' | jq
  '.branches | length, .total, .notShown'` over sixty-plus branches.

- **The multi-repository sweep (#77, #76, #70, #67) has met neither Docker nor
  a second repository.** Unrun: compose interpolating `UF_UNMOUNTED_WORKSPACES`
  for a fifth slot, a nested seed pattern reaching a real checkout, a
  per-repository GitHub token pushing, and two repositories landing at once.

- **Landing inside the container, on git 2.39** rather than 2.50. Conflict
  types come from `-z` records captured on 2.50; a 2.39 that differs loses type
  and explanation but still lists every file.

- **The resolution silence deadline has never fired against a real `claude`.**
  `resolutionSilence.test.ts` drives it with a stand-in child and faked time.
  Settle by pressing Resolve with the child's `ANTHROPIC_BASE_URL` pointed at
  a listener that accepts and never answers (`nc -lk 127.0.0.1 9999`), then
  reading the `run_reviews` row and `git worktree list` after the hour. The CLI
  may give up by itself first, which is worth knowing too.

- **No real restart has been taken during a real resolution.** The boot's
  `abortInterruptedResolutions` is driven by `mergeQueueDrain.test.ts` over a
  slot stranded by hand, and Commit and Purge refusing a live one are pure
  tests plus the render above. Settle in the container: Resolve with Claude on
  a run whose slot still holds its branch, `docker compose restart` while the
  child works, then confirm the boot log's "Rolled back the merge" line, a clean
  `git status` in the slot, and no Commit on the card.

- **The uncounted Purge, the moved-since-landed Land card and the kept
  strategy pick have not been rendered** (2026-09-27, `b69e36c`, `b44df6c`,
  `4418cba`). Each decision is unit-tested in `landView.test.ts` and
  `land.test.ts`; no browser drew them. Settle by driving `/runs/[id]` per the
  run-page-states recipe with a `GET /api/runs/<id>/land` of `ahead: null` and
  of `landedAt` set with `merged: false`, and on `/branches` pick Squash, press
  a row's Commit, then read the queue POST body for `strategy: "squash"`.
