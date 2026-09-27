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

- **`core.excludesFile` via `GIT_CONFIG_*` lets `git add -A` pass the bound
  dotfiles, 2026-09-09.** git 2.39.5: exit 0, none staged, a nested
  `.gitconfig` still staged; `agentGitEnv` keeps the GitHub pairs in the same
  block. Only the `os.tmpdir()` path was written; 2590 tests pass.

- **Delivery opened a real pull request, 2026-09-06**, the app's first:
  throwaway `Xapicc/uf-deliver-smoke`, branch unpushed, seeded worktree run,
  `UF_GITHUB_TOKEN`. The app pushed and opened #1 `uf/deliver-smoke` → `main`;
  it refused a non-GitHub remote with no credential, and a second request, 400.

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

## Not yet verified by hand

- **A resolution made through the app, then "What changed".** The range was
  measured on a hand-made merge; `resolveConflicts`' own merge, the review it
  then bills and the Files tab over it are unwatched. Settles on a resolved
  run whose card names `measuredFrom` and lists only the run's files.

- **No work cycle has been spawned by the `core.excludesFile` code,
  2026-09-09.** Unseen: the write to `/run/uf-git`, the block reaching a
  child's environment, the `EEXIST` path. Settles on a cycle whose `git add -A
  && git status --porcelain` exits 0 where `main` fails.

- **What the 2026-09-06 delivery does not establish**: an agent committing to
  the branch (the run was seeded), the verify gate (`landVerifyCommand` empty),
  a real run id in the PR body (the fixture's read `deliver-`).

- **Deliver's run-state refusal, body check and per-branch link have not met
  GitHub, 2026-09-27.** `deliverRun.test.ts` pushes to a local bare repository
  and stubs `fetch`; unseen are a refused press on a real card and the link
  surviving a real sweep. Settles on the smoke repository above: press on a
  paused run (400, `git ls-remote` empty), then deliver, set
  `eventRetentionDays` to 1 and wait a day past the sweep.

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
    file-by-cycle grid in `proposals/SessionFlow/` waits on them;
  - a gone branch (`kind: "none"`) drops to two groups with a warn notice and
    neither "changed, never named" nor "named, and not changed" — the item
    most likely to be wrong;
  - `/api/runs/[id]/touched` is fetched once per tab open, never on the poll.
