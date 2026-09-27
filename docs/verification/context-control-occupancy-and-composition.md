# Verification: Context control — the occupancy and composition series

[← Verification index](../verification.md)

## Verified

- **The context occupancy series has been written by real runs (2026-08-27).**
  198 rows across 10 runs at the default 60 s tick: 159 of 188 gaps are one
  tick, the widest 1,320 s while run `fc491479` sat in a sub-agent; every gap is
  a multiple of 60 s, so gaps are deduplication, not a late ticker. 16 rows
  carry `turns_exact` false.

- **`ContextOccupancy` rendered in headless Chromium, in isolation, on synthetic
  data.** Four states in a 336px box against the build's CSS, light and dark:
  token classes resolve, the sawtooth is legible with prune rules on the cliffs,
  the no-reading hatch is not a zero fill, the legend fits one line.

- **The context composition series, and the winnow pin it needed,
  2026-09-04.** The pin moved from `0384486` to `0421da5` (forty-three commits)
  because `winnow context` is an unknown command at the old one; all four
  spawned subcommands were re-read at the new pin against a real 8.7 MB
  transcript, and `docker compose build` completed.
  - In the image, `safe run -- context <path> --depth 1 --json` returned a body
    with stderr empty in ~0.12 s; `parseComposition` read window 433,331 and
    six bands summing to it exactly.
  - `python -m winnow context --help` outside `safe run` printed that it wired
    7 hooks into `~/.claude/settings.json`; every app spawn uses `safe run`.

- **A depth-3 `winnow context` body is 18–29 KB, 2026-09-04**: 72 to 110
  sub-nodes and at most 29 children under one parent over the four largest
  local transcripts (7.2–12.9 MB), so the 4 MB stdout bound holds. Against the
  real pinned winnow the tree round-tripped through `recordComposition`, which
  kept the newest reading's only, and `sweepRunEvents` removed it with its run.

- **The composition stack clipped because the parse floored a signed residual,
  2026-09-10.** On run `5b967a08` the eight stored readings summed past their
  windows after the first (324,569 against 243,678 at the last) with
  `unattributed` stored at 0; `winnow context --depth 2 --json` on the same
  transcript put it at −17,969, and `context.py` allows a negative residual.

- **Nothing was displaced on that run; the picture was the clip, 2026-09-10.**
  The prefix held at 14,392 tokens on all eight readings and standing
  configuration grew from 18,098 to 44,511.

- **The signed residual, end to end, 2026-09-10.** `parseComposition` keeps the
  sign (−81,822 on that transcript) and `migrate()` re-derives every stored
  residual on boot — idempotent on a scratch database first. After `docker
  compose up --build`: all eight readings sum to their windows, residuals −1 to
  −80,891, every band has height, the legend reads `unattributed −80.9k`.

- **The tick writes `context_compositions` on a real run, 2026-09-10.** Eight
  readings on run `5b967a08`, paced by growth, one taken a minute after the
  early-end cut at 30 minutes; `compositionSeries` draws the stored rows.

## Not yet verified by hand

- **Context series: fallback basis, cap, scan cost and sweep unmeasured.** 0 of
  198 rows use the `transcript` basis, no run reached `CONTEXT_SAMPLES_PER_RUN`
  (max 38), the scan is untimed, no sweep has removed a real row. The freshness
  line (container not rebuilt) and `guardScanDue` (needs
  `liveGuardIntervalSeconds` above 120) are unseen.

- **`ContextOccupancy` has never been seen on real rows or on the run page.**
  Its placement in `Against its limits`, its behaviour as the 3-second poll
  replaces the DTO, the one-column narrow layout and its caption length are
  unchecked.

- **The composition series' winnow/sample anchor divergence has never been
  measured while a sub-agent ran**; it is read from code (2026-09-04).

- **The depth-3 tree has been drawn only from hand-seeded rows, and
  `COMPOSITION_CHILDREN_PER_NODE` (64) has never fired on real output
  (2026-09-04)**; its test feeds 200 synthetic children.

- **`describeComposition`'s signed negative share has been seen only by the
  test build.** It went in after the container was rebuilt.
