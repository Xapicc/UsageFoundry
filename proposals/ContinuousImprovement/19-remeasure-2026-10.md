# Re-measure, 2026-10-17: not run, because the database was not reachable

**Nothing in this file is a new figure.** The four headline measurements were to
be re-run against this install's current database before any product code. The
run that wrote this file could not open that database, so it committed the
measurement as a script for the operator to run and continued on the 2026-08
figures, as its brief said to. Every 2026-08 figure below is quoted from
[00-problem.md](00-problem.md) and [06-option-prior-read-pointer.md](06-option-prior-read-pointer.md),
not re-derived.

## Why it was not run

`src/lib/config.ts` puts the database at `DATA_DIR/usagefoundry.db`, and
`docker-compose.yml` sets `DATA_DIR: /data` on a named volume that is root-owned
`0700`. A work cycle's sandbox lists `/data` and `/backups` among the paths it may
not read. Inside it, `/data` is an empty directory owned by the sandbox (`ls -la
/data` lists nothing; `readdirSync("/data")` succeeds and returns `[]`), so there is
no file there to open read-only or otherwise. No other copy of `usagefoundry.db`
was found on the readable filesystem. The 2026-08 survey reached the database
with `docker exec -i usagefoundry sqlite3 -readonly /data/usagefoundry.db`,
which is the operator's shell and not a work cycle's.

## The script

[`scripts/remeasure.mjs`](scripts/remeasure.mjs) computes all four figures in one
pass and prints each one beside its 2026-08 value, the range it covers, the gate,
and how long each query took. It opens the database with better-sqlite3
`readonly: true, fileMustExist: true` and writes nothing. Inside the container,
where the database is:

```sh
docker exec -i -w /app usagefoundry node --input-type=module - /data/usagefoundry.db \
  < proposals/ContinuousImprovement/scripts/remeasure.mjs
```

Add `--json` after the database path for the full per-repository breakdown.

**Verified, 2026-10-17, against a scratch database only.** A database was built
through the app's own `migrate()` (`.test-build/.../lib/db.js` under a scratch
`DATA_DIR`), seeded with four runs and 13 events whose figures were worked out by
hand. These were: one repository reached three ways (a checkout, no checkout, a
row with only `repo_root`), one sub-agent read, one read outside the run's
checkout, one non-repository folder, and four OTLP rows either side of the first
edit. Every printed figure matched the hand computation: 3 repeats of 11 reads,
1 edited, 18.2% addressable, 10.0% addressable on the main thread, 3 of 6
opening reads covered (2 of 5 on the main thread), and $3.00 of $15.00 before
the first edit (30.0% sdk-only). The piped-on-stdin form printed the same
output as running the file. This shows the SQL runs against the current schema
and the arithmetic does what it says. It says nothing about the install.

## The four figures

The **Range** column is what the script prints as `run_events` and
`otlp_requests` first and last `ts`. It can be no wider than
`eventRetentionDays` (default 30), because both tables are swept at that
horizon. The 2026-08 corpus was eleven days, so a figure that differs may differ
because of the window.

| # | Figure | Definition used by the script | 2026-08 | 2026-10 | Range |
|---|---|---|---|---|---|
| 1 | Share of `Read` calls hitting a path an earlier run on the same repository had read | `run_events` `kind='tool'`, `$.name='Read'`. A read is a repeat when its run is not the first, by `runs.created_at` then event id, to read that path on that repository | 73.2%, 4,284 of 5,856 | not measured | — |
| 2 | Repeats the same run edited, and the addressable share (repeats not edited ÷ all reads) | Same run called `Edit`, `Write`, `MultiEdit` or `NotebookEdit` on the path at any point | 50.6% of repeats; **36.1%** addressable | not measured | — |
| 3 | Prequential top-20 coverage of a run's opening 8 `Read`s, ×0.9 decay per earlier run | For each run with an earlier run on its repository: a top-20 from strictly earlier runs only, weighted 0.9^k for a run k back, scored against the run's first 8 `Read` calls. Micro-averaged: hits ÷ opening reads | **45.0%** (42.3% raw frequency, 39.2% distinct runs) | not measured | — |
| 4 | OTLP spend before a run's first edit | `otlp_requests.cost_usd` with `ts` before the run's first `Edit`/`Write`/`MultiEdit`/`NotebookEdit` event, ÷ the run's OTLP total, over runs with an `sdk` request and an edit. All query sources, with `sdk` alone beside it; printed for every repository and for the largest | 20.9%, median run 24.4% (177 UsageFoundry runs) | not measured | — |

Where the script's definition differs from the 2026-08 one, it differs on
purpose. Each difference can move a figure without the install having changed:

- **The repository key is `COALESCE(folder_repo, repo_root)`.** It was
  `COALESCE(NULLIF(repo_root,''),'(no repo)')`, which put 51 runs from
  unrelated directories in one bucket. Repeats inside that bucket counted, and
  its 594 reads were scored. Runs with neither column set are still reported
  under `(no repo)`, but are never scored for coverage. That bucket is every
  non-repository folder in one, and the pointer never fires there.
- **Paths are relativised against the run's checkout, else its repository, else
  its folder.** It was checkout, else `work_dir`, else folder. For a run without
  a checkout on a subfolder of a repository, the old key was relative to the
  subfolder. Paths outside the base stay absolute and are their own key, as
  before.
- **`MultiEdit` and `NotebookEdit` (via `$.input.notebook_path`) count as
  edits.** The 2026-08 `edits` CTE named `Edit`, `Write` and `NotebookEdit`.
  Its `p` CTE filtered on `$.input.file_path IS NOT NULL`, so a `NotebookEdit`
  could never have matched.
- **Ties in a top-K are broken by path.** They were broken arbitrarily, which
  06 measured as moving the figure by about 0.2 points between runs of the
  scorer.
- **Coverage's "first 8 `Read` calls" counts calls, not distinct paths, and
  includes sub-agent reads on both sides.** That was 00's wording. The
  main-thread-only variant, 06's 46.5% in 2026-08, is printed beside it. The
  pointer itself uses main-thread reads only.

## The gate

**Set by the orchestrator that started this run. It is recorded here as the
operator's to revise.** If the re-measured addressable share (figure 2) is below
15% of reads, or the ×0.9 top-20 coverage (figure 3) is below 25%, build the
readout and stop: do not build the pointer.

**Applied to the 2026-08 figures, because no 2026-10 ones exist:** 36.1% ≥ 15%
and 45.0% ≥ 25%. **The gate passes, and the pointer was built behind its
holdout.** That decision rests on a measurement two months old, on a different
repository key. The script prints the gate's verdict on its last line but one,
so the first thing to do with its output is check that line. If it says
`STOPS the pointer`, the pointer should be switched off by reverting its commit,
which [README.md](README.md) names. It has no setting, so a revert is the only
way.

## When the script is run

Record the output as a new dated section below this one. Do not edit the table
above: it says what was known on 2026-10-17, and a reader comparing the holdout
against the measurement it was gated on needs both.
