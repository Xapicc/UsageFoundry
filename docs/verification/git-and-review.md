# Verification: Git and review

[← Verification index](../verification.md)

## Verified

- **Diff and land parsers, `npm test` 24 assertions:** NUL-separated numstat
  and name-status incl. renames and tabs, patch splitting that ignores `diff
  --git` inside a hunk, `merge-tree` on an old git, every `landRefusal` branch.

- **GitHub credential block, real git 2.39.5:** `credential fill` returns the
  token past a repo-configured missing helper (`osxkeychain`), SSH GitHub
  remotes rewrite to HTTPS, and `gitlab.com` fails without prompting. Six
  `npm test` assertions.

- **git 2.39.5 formats behind Delete and Purge:** `status --porcelain -z`
  needs its leading space, so `.trim()` drops an unstaged file (hence `trim:
  false`); `worktree remove` needs `--force` on a dirty checkout, and `branch
  -d` refuses an unmerged branch where `-D` deletes it.

- **Delivery opened a real pull request, 2026-09-06**, the app's first:
  throwaway `Xapicc/uf-deliver-smoke`, branch unpushed, seeded worktree run,
  `UF_GITHUB_TOKEN`. The app pushed and opened #1 `uf/deliver-smoke` → `main`;
  it refused a non-GitHub remote with no credential, and a second request, 400.

- **The Land card over a branch that moved after its pull request, and over one
  under a resolution, 2026-10-20 (git 2.39.5, the standalone build).** Five runs
  seeded into a scratch `DATA_DIR` from the compiled test build. Behind its
  pull request the card read "Opened … — pull request #41, behind this branch"
  and offered "Push to pull request #41", its sentence naming #41 and "No second
  one is opened"; at the pushed tip, "Delivered …" and no button; undelivered
  under a `running` resolve row, no "Open pull request" and the refusal under
  the buttons (`GET /api/runs/<id>/land`: `branchResolving` true,
  `delivery.possible` false); delivered, behind and resolving, the link and the
  refusal and no push. Caveat: nothing was pressed (the press is
  `deliverRun.test.ts`', on a local bare repository), and boot reconciliation
  fails a seeded `running` row, so it was set after the server was up.

- **Review and conflict-resolution spawn, flags, JSON shape and accounting**,
  with a stub `result`; a bad conflict resolution cannot be committed.

- **The Files tab's touched/changed scan returns what the design claims, on
  real SQLite** (in-memory `better-sqlite3`, ten hand-written tool payloads, a
  throwaway script): worktree and checkout paths collapse to one row, `/tmp`
  counts as outside, a command-only `Bash` and a directory `Grep` are excluded.
  `runTouches.test.ts` covers only the pure reconciliation, nine cases.

- **A type change no longer blanks every patch, 2026-09-27, git 2.39.5.** `rm
  f; ln -s g f; echo y >> g` gives 3 numstat entries and 4 `diff --git`
  chunks, `f`'s two under one header; the real `runDiff` (orchestrator, config
  and privsep stubbed) now returns all three patches. Scratch repository only.

- **The byte budget keeps the small file's patch, 2026-09-27, git 2.39.5.**
  Through the real `runDiff`: a 4.2 MB one-line `dist.min.js` beside a
  one-line `small.ts` edit gives `small.ts` its patch and `omittedPatches: 1`.
  2.1M blank lines beside `small.ts` overflowed the read when charged the file
  alone, reported as `patchFailure`; the per-line marker charge leaves them out.

- **After a merge of the target the diff is the run's own, 2026-09-27, git
  2.39.5.** One run commit, one unrelated `main` commit, `main` merged into the
  branch: 4 files +6 −2 from the base, `run.txt +2` and `shared +1 −1` from
  `measuredFrom.commit`. A later merge of another branch keeps it at the base.

- **The card's new sentences render, 2026-09-27**, standalone build, a seeded
  run that failed at the spawn, `/api/runs/<id>/diff` answered by Playwright
  with a `measuredFrom` and a `patchFailure` payload: hint, both notices and
  the row sentence paint, no console error. 1280px only; not a server's diff.

- **A linked worktree inside its own main worktree, the store ignored
  (2026-10-24, git 2.39.5, a scratch repository, by hand):** with
  `.uf-worktrees/` in `.gitignore` and a slot added under it, the main
  checkout's `status --porcelain` is empty and `add -A` stages nothing; `status
  --ignored` shows `!! .uf-worktrees/`; `clean -fdx` skips the slot as a
  repository and `clean -ffdx` would remove the whole store. git run in the
  store directory, or in a slot directory without `.git`, resolves to the main
  repository; with `GIT_CEILING_DIRECTORIES` naming the store the second says
  "not a git repository" while a slot and a directory inside one still resolve.
  `check-ignore -- .uf-worktrees/` answers 0 for a `/.uf-worktrees/*` rule even
  with a `!` line re-including a slot that `status` then lists, and `-c
  core.excludesFile=` drops a global excludes file and one set through
  `GIT_CONFIG_COUNT`. Caveat: never the operator's host git or the real vault;
  the ceiling and the excludes half are now in `mountRootIsolation.test.ts`.

- **A reused slot's `status` and `checkout -b` ran under `git()`'s 20 s and
  failed with an empty reason, 2026-10-25**, git 2.39.5, scratch repositories
  under `$TMPDIR` on `a9b61621`, `checkoutGitClock.test.ts` built into its
  own `--outDir`: a `GIT_BIN` stub hanging the reuse path's one call, and
  `mock.timers` advanced 20,001 ms. Before the change the run failed at once
  with `Could not start branch uf/…: ` ending at the colon (`checkout -b`) and
  `Checkout … still has uncommitted work` (`status`); after it both calls were
  still running, and at 30 minutes failed with `git … in <slot> was killed
  after 30m 0s without finishing`. A real `index.lock` in the slot's git
  directory gave git's `fatal: Unable to create '…/index.lock': File exists.`
  in the run's reason, unaltered, before and after. Caveat: the slowness is a
  stub's. That a vault's evicted iCloud files make `status` or `checkout` pass
  20 s is the nightly failure's likely cause and is not measured.

## Not yet verified by hand

- **That an evicted iCloud checkout is what outlasted 20 s.** Reported from a
  read-only look at the failed run's slot, not repeated here: `git status
  --porcelain` did not finish in 60 s and 100 s there and takes 0.02 s in the
  main checkout, and a zero-byte `index.lock` from 03:05 was in its git
  directory. Unmeasured: whether the files were placeholders, and whether the
  new thirty minutes is enough. To
  settle it, on the host, `time git -C <slot> status --porcelain` with the
  `.uf-worktrees` store's files evicted, then again once downloaded, and
  compare; the stale lock is the operator's to clear first.

- **A resolution made through the app, then "What changed".** The range was
  measured on a hand-made merge; `resolveConflicts`' own merge, the review it
  then bills and the Files tab over it are unwatched. Settles on a resolved
  run whose card names `measuredFrom` and lists only the run's files.

- **What the 2026-09-06 delivery does not establish**: an agent committing to
  the branch (the run was seeded), the verify gate (`landVerifyCommand` empty),
  a real run id in the PR body (the fixture's read `deliver-`).

- **Deliver's run-state refusal, body check and per-branch link have not met
  GitHub, 2026-09-27.** `deliverRun.test.ts` pushes to a local bare repository
  and stubs `fetch`; unseen are a refused press on a real card and the link
  surviving a real sweep. Settles on the smoke repository above: press on a
  paused run (400, `git ls-remote` empty), then deliver, set
  `eventRetentionDays` to 1 and wait a day past the sweep.

- **A push-only update of an open pull request has not reached GitHub,
  2026-10-20.** `deliverRun.test.ts` pushes the moved tip to a local bare
  repository and stubs `fetch`; unseen are GitHub taking the second push and the
  pull request listing the new commit, and what a branch pushed again after its
  pull request was *closed* now gets (an update, not the new pull request the
  press used to open). Settles on the smoke repository above: deliver, commit on
  the branch, press "Push to pull request #N", then `git ls-remote` and the
  pull request's commit list.

- **A review or conflict resolution against the real CLI.** Review quality,
  `plan` mode in print mode and `acceptEdits` resolutions are unconfirmed.

- **A repository large enough to hit the diff's size budget in the wild.**

- **Committing and purging through the app itself.** Git formats confirmed on
  2.39.5, decisions unit tested; never done through a running server.

- **A real agent using the token**: a `git push` of a run's branch, and a `gh`
  call that needs authentication. The credential block itself was driven into
  a real git; what has not been watched is the CLI's own git picking it up out
  of the environment mid-run.

- **The Files tab's *What it touched* card has been rendered but never
  walked.** The 2026-09-14 label-clamp entry above drew it at 390px in all four
  states against a seeded `run_events` fixture, so the card and its graph are
  known to paint; nothing below it was read. To walk at 1280px and 390px:
  - write down the header's distinct-file and work-cycle counts: the deferred
    file-by-cycle grid in `git show a74a1bb:"proposals/implemented - SessionFlow/"` waits on them;
  - a gone branch (`kind: "none"`) drops to two groups with a warn notice and
    neither "changed, never named" nor "named, and not changed" — the item
    most likely to be wrong;
  - `/api/runs/[id]/touched` is fetched once per tab open, never on the poll.
