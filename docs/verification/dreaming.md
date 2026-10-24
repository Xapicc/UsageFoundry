# Verification: Dreaming

[← Verification index](../verification.md)

## Verified

- **A Dreaming night in a vault that can be isolated puts its notes in the vault
  before its signatures are claimed, 2026-10-24**, at `8d39cff1`, by
  `dreamingLanding.test.ts` against a real repository at a mount root that
  ignores `.uf-worktrees/` and the real merge worker. After the run's branch
  (a note committed by hand on it) lands through the merge queue the note is in
  the vault, `git status --porcelain` there is empty, and the two signatures are
  in `dreaming_notes` with `prompt_item` 1 and 2; with an uncommitted note of the
  operator's in the checkout the land is refused, nothing is claimed and
  `dreaming_pending` still holds the night. A mount that is not a repository, and
  a mount-root repository that does not ignore the store, still get a run in the
  folder that claims at the start. Caveat: the agent's commit is made by the test,
  not by a Claude run, and the vault is a fixture, so nothing here says that a
  real night's agent commits on its branch, reports paths relative to its slot, or
  that the vault's own `.gitignore` leaves its checkout clean while Obsidian is open.

- **Dreaming's nightly timer fired unattended at its default time on 16 days,
  2026-10-08**, at `9bf2ef8c`, read from the session transcripts under
  `~/.claude/projects/-workspace2/`. Nineteen sessions open with
  `buildDreamingPrompt`'s first sentence, "You are writing into this knowledge
  vault, which is your working directory." Sixteen of them have a first record
  between 03:04:09 and 03:05:05 UTC, on sixteen distinct days from 2026-09-09
  to 2026-10-08 — the `DEFAULTS` fire time (`dreamingMinutes` 3 × 60 + 4 in
  `dreamingTimeZone` `"UTC"`, `src/lib/settings.ts`) to the minute, with the
  seconds scattered as a 60-second interval timer's phase scatters them. The
  other three start at 03:20:53 on 2026-09-14, 11:46:06 on 2026-09-17 and
  03:33:27 on 2026-09-19. Caveat: this infers the timer from the clock time of
  the prompt and does not read `runs.origin` or `dreaming_nights`, which sit
  under `/data` and are unreadable from a work cycle. It also says nothing
  about the other 14 of those 30 days: a quiet or refused night starts no run
  and leaves no transcript, so a missing session cannot tell a quiet night from
  a timer that did not fire.

- **The dreaming pane's cold read, streamed rather than read whole,
  2026-09-11**, at `8b7f1e2` on Node 22.23.2 over a real 1.91 GiB corpus (2,260
  `.jsonl` files). A fresh `next start` per run was asked for `/api/usage` and
  then `/api/dreaming`, in that order, with the peak read out of
  `/proc/self/status` by a `--require` preload; three runs each way at each heap
  cap. At the shipped `--max-old-space-size=2048`, VmHWM **1,478-1,552 MB before
  against 1,252-1,316 MB after**; at this install's 1,024, **898-949 MB against
  687-697 MB**. The readout is identical in all twelve runs — 2,260 walked,
  3,341 instances, 1,549 signatures, 128 recurring — and the cold scan is a
  little slower, 6.4-6.5 s before against 6.6-7.8 s after. Caveat: VmHWM is a
  high-water mark of RSS under a lazy collector rather than a live-set figure, so
  the saving moves with the heap cap and is not a fixed number of megabytes.

- **Dreaming end to end, 2026-09-02**, built app over the real corpus: the
  readout matches `git show a74a1bb:"proposals/implemented - Dreaming/"` (77 signatures, 1,260 of 2,553
  instances); warm scan 21 ms, 0 files re-read. One night ($9.40) wrote notes
  passing `_Meta/qc.py`'s ERROR gate for nine of twelve signatures, and found
  the scan double-counting the 5.1% of records resumes rewrite.

- **The Nights tab shows how a night's run ended, 2026-10-08**, standalone build
  at this change's commit, served over a scratch `DATA_DIR` seeded with eleven
  nights over runs in every state and read in Chromium at 1280px and 390px:
  `failed`, `completed`, `stopped` and `needs-review` each drew a second badge
  beside `run started`; a night whose run was `running` or `paused`, one whose
  run row was deleted, and a night with no run drew none. Two runs on one night
  showed the later one's `completed`. Caveat: seeded rows, not a real night; the
  boot sweep rewrote the seeded `running` and `paused` runs to `failed` and
  `stopped` the moment the server started, so those two states were set after
  boot with an `UPDATE` through a second connection.

## Not yet verified by hand

- **No real Dreaming night has landed through the merge queue**: the code that
  queues a night's branch and claims after it (`dreamingLanding.ts`) has run only
  against fixtures. Unseen on the real vault at `/workspace2`: that the agent
  commits on its branch (it is granted `git commit` and told to, and
  `commitPending` is the fallback, which has never run on a real night's slot),
  that the land is not refused by the operator's own uncommitted Obsidian files
  (the one open question, filed as its own board task), and that the pane's
  paths for the landed notes read as present. Settle, after the first night
  Dreaming runs on a build that carries it, from a shell that can read
  `DATA_DIR`: `git -C /workspace2 status --porcelain` should print nothing;
  `SELECT run_id, night, attempted_at FROM dreaming_pending` should return no
  rows once the land finished, or one row whose night's last
  `SELECT status, message FROM merge_queue WHERE run_id = <it> ORDER BY
  created_at DESC LIMIT 1` says why; and `git -C /workspace2 log --oneline -3`
  should show the merge. A night refused with "has not landed in the vault yet"
  is that last case.

- **Dreaming's timer has not been read off a live install, and nothing has
  shown a restart leaving it armed**: the 16 fires above are inferred from
  transcript times, the 14 days without a 03:04 session cannot be told apart
  as quiet, refused or never fired, and the three off-time sessions are
  unexplained. `reconcileDreamingOnBoot` and `armDreaming` have not been seen
  to run across a restart; two faults a press cannot expose were found only by
  reading the code. Nothing enforces that an agent reads `CLAUDE.md` first.
  Settle, from a shell that can read `DATA_DIR`: `SELECT night, outcome,
  run_id FROM dreaming_nights ORDER BY night` and `SELECT origin, started_at
  FROM runs WHERE origin_ref LIKE 'dreaming:%'` in `usagefoundry.db`, then
  compare each night with the data directory's restart times.

- **`repairDreamingNotePaths` has not been run against a real ledger**: it
  re-derives `note_path` once per install for rows attached while the parser
  kept the last line of an item's report, which in the 19 transcripts read on
  2026-10-08 was a hub for 45 of 49 multi-file items. It was written without
  `/data` readable, so the number of live rows holding a hub, and what they hold,
  are unknown, and it has been exercised only on seeded rows in
  `dreamingLedger.test.ts`. Settle, from a shell that can read `DATA_DIR`,
  before and after one boot of the build that carries it: `SELECT signature,
  note_path FROM dreaming_notes WHERE note_path LIKE '%MOC.md' OR note_path LIKE
  '%Standing Failures%'` in `usagefoundry.db` should return rows before and none
  after, `SELECT value FROM settings WHERE key = 'dreaming.notePathsRederivedAt'`
  should hold an instant after, and the boot log should say how many notes it
  repointed. Rows still listing a hub afterwards belong to a run whose events
  retention has deleted, or whose report never listed the note first, and are
  the ones to `forgetNote` or fix by hand.
