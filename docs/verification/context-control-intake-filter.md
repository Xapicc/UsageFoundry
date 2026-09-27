# Verification: Context control — the intake filter and its ledger

[← Verification index](../verification.md)

## Verified

- **Intake-filter/prune overlap is 4.06% of pruned tokens, an upper bound,
  2026-08-24.** Corpus-weighted over this install's ten largest transcripts;
  3.07% unweighted, 0.00-9.92% spread. The context card adds the two figures
  and does not print the bound. No correction today: no ledger line carries a
  `tool_use_id` (15 of 15 results on the fallback key).

- **The filter ledger's live readout nets `+$0.0660675`, a floor,
  2026-08-24T21:12Z.** 125 lines held 15 distinct results, 15,144 tokens, so
  summing the file would overstate 24.8×, a factor that grows with session
  length. A floor because 82 of 125 requests joined no main-thread turn and
  only 6 of 15 results were priced.

- **`intakeFilter.ts` read a dead ledger path from 2026-08-25, as `missing`.**
  The ledger had moved to `/data/winnow/filter.jsonl`; `GET /api/usage` showed
  every figure zero while it held 212 lines. At the real path 215 of 217
  request ids joined, all main-thread: how much of a ledger joins depends on
  what the fleet was doing.

- **The fixed prompt carried 17,229 tokens of the intake filter, 2026-08-27.**
  A custom `ANTHROPIC_BASE_URL` turns the CLI's tool deferral off: the live
  argv replayed gave 30,845 prompt tokens direct and 48,074 through the proxy.
  `docker-entrypoint.sh` now exports `ENABLE_TOOL_SEARCH=1` (30,849). Sessions
  step up at 2026-08-24T14:05:19, when `WINNOW_FILTER=1` was first switched on.

- **The intake filter held streamed responses back in 8 KB blocks, killing
  long generations, 2026-09-11.** `proxy.py` relayed with `read(8192)`, which
  on a chunked body reads until 8 KB arrive. Run `b511c547` lost one turn
  twelve times across two processes, nine of them ending 300.0–300.6 s after
  the attempt began — the floor CLI 2.1.260 puts under
  `CLAUDE_STREAM_IDLE_TIMEOUT_MS`. winnow `4b1b7b1` relays with `read1`; a
  held-upstream test fails before it and passes after. Reopened on it, the
  run's first Write carried 32,827 bytes in a 2 min 53 s response, no retry.

- **Reading winnow's ledger incrementally took a TTL-crossing poll from ~181 MB
  of `heapUsed` to 0, 2026-09-11.** The operator measured the defect on the real
  `/var/lib/winnow/filter.jsonl` at 101,929,100 bytes / 54,145 lines: one poll
  crossing `LEDGER_TTL_MS` raised next-server's `heapUsed` by ~214 MB and its RSS
  to ~700 MB. That file is 0620 `nobody:node` and an agent worktree's uid
  cannot open it, so the figures below are against a synthesised ledger of
  101,957,288 bytes / 54,145 lines (0.03% over) carrying the three record shapes
  `winnow/filter.py` writes, not against the real one;
  the process is a bare `node --expose-gc` holding only this module, which is why
  its old-path number is ~181 MB rather than ~214 MB. Five runs each, stable to
  0.2 MB on the poll figure. `readFileSync` + `parseLedger`: 181.1-181.2 MB of `heapUsed` per poll,
  peak RSS 365-368 MB, ~300 ms. `readLedgerAppended` with one request appended
  since the last poll: 0.0 MB, peak RSS 181-184 MB, ~1 ms. Both paths returned
  the same 45,013 rows, which is the accuracy half of the claim. The cold read a
  process pays once fell from 181.6-185.3 MB to 83.5-90.0 MB, chunking being what
  bounds it. **The caveat is retention:** the rows kept for the offset hold 79.5
  MB for this file and grow ~1.7 KB per agent request for the life of the
  process, where the old path freed them between polls, so this bounds the churn
  and the peak but not the growth. Nothing sweeps the file, and a horizon on it
  is task `fb3b65e3`.

- **The ledger's horizon takes 142.6 MB of file to 48 MiB in 12-16 ms, and the
  reader's permanent retention with it, 2026-09-13.** The live
  `/var/lib/winnow/filter.jsonl` reached **141,916,052 bytes** on this install:
  ~16 MB/day averaged against the 101,929,100 recorded on 2026-09-11, but 130
  MB/day over a five-minute sample with the fleet busy and 243 over the busiest
  minute of it — so a horizon stated in days moves with the load, and 48 MiB is
  three days of the average against about nine hours of the busy rate. It is still 0620 `nobody:node` on a mount an agent
  worktree sees read-only, so as with that entry the figures are against a
  **stand-in**: 142,623,364 bytes / 83,698 lines carrying the three record
  shapes `winnow/filter.py` writes, mean line 1,704 bytes against the real
  file's ~1,882, so it packs about 10% more lines into the same size and
  retains 1.196 heap bytes per file byte where the real one recorded ~0.90 —
  it overstates the heap by roughly a third and the ratio below not at all.
  Reading it whole held **170.5 MB** of `heapUsed` (2,047 bytes a row over
  83,280 rows). `compactLedger` cut it to 50,331,136 bytes — 92.3 MB off the
  head — in **12-16 ms** at a peak of **254-322 KB** of heap over idle, which is
  the 1 MiB copy buffer and not the file; reading the result held **60.1 MB**,
  so the horizon gives back **110.4 MB** of server heap that nothing was
  bounding. 29,536 lines survived and **0** of them failed to parse, which is
  the half a byte count cannot show. Two runs, identical to the byte.
  **The caveat is what it does to the card:** the 5-hour window is covered
  whole at either rate and the weekly one becomes a floor past the horizon —
  and no ceiling fixes that, since a week of the busy rate is ~900 MB of file
  and about as much heap. What is bounded is the ceiling plus one six-hourly
  sweep interval's growth, up to ~33 MB more at that rate, rather than the
  ceiling. And a line appended in the two
  syscalls between the last size the compaction reads and its `truncate` is
  lost — winnow takes no lock this process could take as well, so nothing
  closes that window; it errs low, which is the direction that figure already
  errs in.

- **The intake-filter card's markup caught a defect.** Of 24
  `renderToStaticMarkup` cases (eight filter states, both components, both
  pruning states), one printed `Net +$0.00` on a fully unpriced read; the money
  rows are now omitted there. The reader has run on the real ledger and
  transcripts, its arithmetic under 13 unit tests.

## Not yet verified by hand

- **The intake-filter figures have no independent check and were never seen
  in a browser.** `winnow savings --json` does not exist at `f9f8e4b`; checked
  only against unit tests and the ledger recounted in Python. The windowed
  `session`/`weekly` halves and the corrected path have typecheck and tests
  only; check that the 5-hour figure is not permanently `—`.

- **No response over 300 s has been seen to finish through the fixed filter.**
  Run `b511c547` was told to write in sections when it was reopened, so it
  shows the path works, not that a long silent generation now survives —
  which needs the API to send pings for `read1` to pass. Settled by a run
  event log with a main-thread gap over 300 s and no `api_retry` in it.

- **The `ENABLE_TOOL_SEARCH=1` fix has not been through a rebuild.** Check
  that a real run's first request lands near 30,800 rather than 48,000 and
  that `WebSearch`/`WebFetch` still reach through `ToolSearch`. The 17,229
  added tokens are not netted against the filter's saving anywhere.

- **The intake-filter card has never been displayed.** No browser has shown it,
  every DTO was hand-written, the throwaway harness is not in the tree, and
  `readFilterSavings`' TTL and single-flight have not been raced.
