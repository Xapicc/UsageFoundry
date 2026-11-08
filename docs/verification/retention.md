# Verification: Retention

[← Verification index](../verification.md)

## Verified

- **A transcript's filename is its session id under CLI 2.1.226**, checked
  against every `.jsonl` in a real `~/.claude/projects`.

- **A cached transcript record holds 153.1 bytes, and held 230.4 before the
  repeated strings were interned, 2026-09-13.** Measured against this install's
  own `~/.claude/projects` — 2.0 GB, 2,291 files, 219,991 turns and 135,701 tool
  calls — in a bare `node --expose-gc` holding only `transcripts.ts`: settled
  `heapUsed` with the cache populated, less settled `heapUsed` with the Map
  emptied. 81.90 MB over 355,403 records before, 54.47 MB over 355,669 after, a
  third off; five bounds from 40,000 to 600,000 records regress at 234.8 and
  157.0 bytes a record, the same figures by a second method. The shared table
  holds 1,676 distinct strings (1,313 session ids, 278 checkout paths, 85 the
  rest) in 62,928 characters. **This supersedes the `~330 bytes a turn, so the
  default is ~165 MB` that `config.ts`, `transcripts.ts` and `.env.example` all
  carried**, which was wrong in both terms and in opposite directions:
  `evictToBound` counts turns *and* tool calls against the one bound, so the
  500,000 default now holds ~77 MB where it claimed ~165. The caveat is that
  ~101 MB of this process's heap survives emptying the cache — unchanged across
  three consecutive scans, so a one-off cost of having read the tree rather than
  a growth term, and interning took it to ~71 MB as well.

## Not yet verified by hand

- **The retention sweep under a CLI that names transcripts differently.** On a
  moved pin, compare basenames with each file's first `sessionId`.

- **A pruned transcript's run being reopened, against a real CLI.** Both
  halves are unit tested; the whole sequence has not run.

- **The holdout export against this install's real database.** It was written and
  tested against scratch databases only, because a work cycle cannot read
  `/data`. After the first boot on the new build, `holdout.lastExport` in
  `settings` holds the counts per arm and `oldestEventTs`; check that
  `failed` is 0 and that `SELECT COUNT(*) FROM holdout_runs` is not zero, and
  compare `MIN(first_event_ts)` with the oldest `run_events.ts`:
  `sqlite3 "$DATA_DIR/usagefoundry.db" "SELECT value FROM settings WHERE key='holdout.lastExport'"`.
  Also open the first pass's wall time, which was never measured: it reads every
  considered run once.

- **The holdout readback against this install's real database.** Built and tested
  on scratch exports only, because a work cycle cannot read `/data`. Open the
  dashboard band *Does the prior-read pointer change what runs do*, or
  `GET /api/holdout-readback`, and record under *Verified* the date, each arm's
  runs read, its compliance pairs, and the runs left out by reason. Check that the
  two arms lose alike: a lopsided *No file to name* would mean the list is not
  dealt alike. The figure to copy for the sample size is `population.read`.
