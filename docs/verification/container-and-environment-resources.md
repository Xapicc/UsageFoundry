# Verification: Container and environment — memory, CPU, cgroup limits, OOM and the filter launcher

[← Verification index](../verification.md)

## Verified

- **`MALLOC_ARENA_MAX=2` is not the lever; the mmap and trim thresholds are, 2026-09-16.**
  The running server could not be used for this — it serves this install — so the
  measurement is a second server built from the same tree and started beside it on a free
  port, against the real 1.9 GiB transcript corpus under the shipped
  `--max-old-space-size=1024`, driven through repeated cold scans of `/api/usage`,
  `/api/repo-spend`, `/api/calibrate`, `/api/storage` and `/api/status` and then left
  idle. `/proc/<pid>/smaps` sampled at boot, hot, and 90 s and 210 s into idle; the
  parser was checked against the raw `Rss:` sum and `VmRSS` on a throwaway process first.
  Three variants, **n=3 each**. At 210 s idle: baseline **296 MB** (263-313), `[heap]`
  40 MB (8-57); `MALLOC_ARENA_MAX=2` **294 MB** (268-316), `[heap]` 54 MB (28-74);
  `MALLOC_ARENA_MAX=2` plus `MALLOC_MMAP_THRESHOLD_=131072 MALLOC_TRIM_THRESHOLD_=131072`
  **247 MB** (246-250), `[heap]` 9 MB (9-11). A fourth variant run afterwards to isolate
  the thresholds from the arena count, same n: the two thresholds **alone** give
  **250 MB** (245-257), `[heap]` 8 MB (7-8). So **the arena count on its own is worth
  −2 MB**, which is nothing against baseline's own 50 MB spread, it *raises* the main
  arena rather than shrinking it — the opposite of what it was proposed for — and adding
  it to the thresholds changes nothing they do not already do. The thresholds are worth
  **−46 MB** on their own, and they also collapse the run-to-run spread from 50 MB to
  12 MB, which is the more useful half: the sbrk heap stops ratcheting because
  buffers over 128 KB become their own mappings and go back to the OS when freed. No
  scan-time cost from any of them — cold scan 7.25 s baseline against 6.96 s, 6.84 s and
  7.08 s. The thresholds are now set in `docker-compose.yml`, `MALLOC_ARENA_MAX` is not,
  and the reasoning for both sits there beside `NODE_OPTIONS` and again at
  `docs/agent/environment.md`. **Nothing measurable is lost by letting children inherit them**, which they
  would: none of `childEnv`, `chatEnv`, `reviewEnv`, `gitEnv` or `authEnv` touches
  `MALLOC_*` (read, all five), and a compose `environment:` entry was confirmed to reach
  an agent child by reading `VITEST_MAX_WORKERS=3` back out of a running cycle's own
  shell. Measured on the two heaviest things a cycle starts: `npm test` 823 and 833 MB of
  peak tree RSS with nothing set against 777 and 820 MB with the thresholds (n=2 each);
  `next build` 1,725 MB against 1,630 MB (n=1 each, and four unrelated builds the same
  afternoon spanned 1,710-1,759 MB, so that 95 MB is inside the noise rather than a
  saving); wall time identical to a tenth of a second throughout. And
  the CLI is indifferent, as expected of a Bun single-file binary carrying mimalloc:
  `claude --help` peaks at 144.3-144.8 MB of RSS by `getrusage` across all three
  variants, n=3 each. Caveats: the −90 to −110 MB this was filed on was a projection from
  a cold-scan process and is **not** what the server does; the load exercised is the
  transcript-read path plus this repository's own test and build commands, not the SSE,
  SQLite-write or agent-spawn paths; and what a server several days old would do is still
  open — see *Container and environment* under *Not yet verified by hand*.

- **What a work cycle actually weighs, 2026-09-16** — n is **one cycle**, the run that
  wrote this entry, so these are a range and not a distribution. Method: `VmRSS` out of
  `/proc/<pid>/status` for the cycle's own `claude` process and every descendant, every
  20 s for the life of the run, against the `api` context size read off the session
  transcript (`input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens`
  on the last assistant message); tool phases sampled twice a second over the subtree
  rooted at the call that started them — rooted there rather than found by pid, because every
  Bash call in this container gets its own pid namespace while `/proc` is the host's, so a host
  pid read back out of `/proc` cannot be signalled or even matched from the next call.
  **Context is not what makes a cycle heavy.**
  `claude` held **325-407 MB** of RSS while its context grew from 69k to 281k tokens —
  a slope near 0.4 KB per token, the wrong order of magnitude to explain a 1.5 GiB
  budget. What the cycle *starts* is: `npm run build` peaked at **1,749 MB over 23
  processes** in 37 s, `npm run smoke-pages` at **981 MB over 12** in 194 s, `npm test`
  at **784 and 815 MB over 16**. So a cycle sitting still is ~0.4 GiB and a cycle inside
  `next build` is ~2.0 GiB; `docker-compose.yml` keeps 1.5 GiB as a mixed-fleet budget
  with the worst case now written down beside it. Two figures the previous notes had
  wrong, both corrected in place: `claude --help` peaks at **144.6 MB** of RSS by
  `getrusage` (n=3), not 309 MB, and this container exposes **10** CPUs, not 12.
  Caveats, and they matter: the highest context this cycle reached was 281k tokens,
  well short of the 604k a run has reached on this install, so the top of the curve is
  unmeasured and the slope is only measured over 69k-281k; the tool peaks are this
  repository's own commands, and another repository's build is another number; and five
  concurrent cycles plus the server sat at 6.1-8.0 GiB of `memory.current` throughout,
  so none of it was measured on an idle machine.

- **What a cpuset would and would not bound, 2026-09-16.** Measured with `taskset -c 0-2`
  standing in for `cpuset: "0-2"`, against the same commands, on 10 CPUs. A cpuset does
  move what the kernel reports — `nproc` and `os.availableParallelism()` both fall to 3 —
  but **`os.cpus().length` ignores CPU affinity and still reports 10**, and that split is
  the whole result. `npm test`, on node's own runner, followed it: **815 → 707 MB** and
  **16 → 5 processes**, at a cost of 3-4 s on a 20 s run. `next build` did not move at
  all: **1,749 MB / 23 processes / 36.9 s** unrestricted against **1,759 MB / 23
  processes / 33.7 s** on three CPUs. Nor did `npm run smoke-pages`, which drives one
  browser sequentially: **981 → 986 MB**, 193.6 → 194.3 s. Since the phase the per-cycle
  budget is sized against is the one a cpuset cannot bound, it was not shipped as a knob;
  the reasoning sits beside `cpus` in `docker-compose.yml`. Two facts collected on the
  way: `VITEST_MAX_WORKERS=3`, a compose `environment:` entry, **was read back out of a
  running work cycle's own shell**, so a compose variable does reach an agent child
  unstripped, while `NODE_OPTIONS` and `DATA_DIR` were absent as `childEnv` intends; and
  no `.bin/jest` exists in any checkout under `/workspace` or `/workspace2` (searched to
  depth 6), so the jest worker counts some notes assume are not a load this container
  actually carries.

- **The container's cgroup limits are in force, 2026-09-16**, read from inside a
  running install (`/sys/fs/cgroup/*`, cgroup v2): `memory.max` 12884901888 (12 GiB),
  `memory.swap.max` 0, `pids.max` 2048, `cpu.max` `max 100000` — no CPU quota — and
  `cpuset.cpus` empty with `cpuset.cpus.effective` `0-9`. So `mem_limit`,
  `memswap_limit` and `pids_limit` do reach the kernel, and the shipped `UF_CPUS=0`
  default does leave the container uncapped on CPU. Caveat: this install's `.env`
  sets none of the `UF_MEM_LIMIT`/`UF_CPUS` variables and `memory.max` is not
  compose's `9g` default, so what is confirmed is that Docker applies the limits,
  not that these particular numbers came from this repository's `docker-compose.yml`.
  Two more figures off the same read: `nproc` is **10** here, not the 12 that several
  notes assume, and `memory.current` sat between 6.6 and 8.0 GiB with five concurrent
  work cycles and the server running.

- **How full the transcript cache actually gets on this install, 2026-09-13**,
  counted rather than modelled: a pass over `/home/node/.claude/projects` — 2,286
  `.jsonl` files, 1.74 GiB, 548,963 lines — found **219,599 records carrying both
  a `message.usage` and a `message.id`**, which is what `transcripts.ts` retains
  before its cross-file dedupe. That is **44% of the 500,000-record bound**, so
  `TRANSCRIPT_CACHE_MAX_ENTRIES` has never evicted anything here and the heap
  measurements taken on this corpus were taken at a **partly full** cache. At the
  ~330 B/turn the comments assume, the cache held ~72 MB of the peaks recorded
  under *Dreaming* above, against the ~165 MB the bound permits. Caveat, and it
  is the whole reason the figure is worth having: the corpus grows, so the same
  measurement on a fuller one is not this one, and the ~93 MB between here and
  the bound is heap that the 1,024 MiB ceiling shipped in `docker-compose.yml`
  has not yet been observed carrying. The per-turn figure it is multiplied by is
  itself an estimate, not a measurement.

- **The intake filter's launcher, and the container's memory at rest,
  2026-09-10.** Idle four minutes after boot: `docker stats` 576 MiB,
  `next-server` 441 MB RSS (transcript cache 168 MB), the filter's `uv run`
  parent 199 MB beside a 23 MB filter; an hour later, still idle, `docker
  stats` read 1.35 GiB, the difference virtiofs slab from the bind mounts.
  - The entrypoint now runs `uv sync`, then the venv's `python -m winnow
    filter`. On the rebuilt container the filter runs at uid 1000, 23 MB, with
    no `uv`; the proxy answers on 8789; the ledger's 54,145 lines are intact.
  - cgroup `anon` fell from 578 MB to 390 MB and `docker stats` to ~410 MiB
    after a cold scan. A plain `docker restart` wrapper held only ~29 MB, so
    the saving is the `compose up --build` one.
  - Same day: the +214 MB poll spike is `intakeFilter.ts` reading its 102 MB
    ledger whole; the 1,531 MB high-water mark is the dreaming pane's cold read
    (1,268 MB at a 2048 MB heap, 656 MB at 1024, in a throwaway container).
  - This install now sets `UF_NODE_HEAP_MB=1024`, `UF_MEM_LIMIT=6g` and
    `maxConcurrentRuns` 2; the shipped defaults are unchanged.

## Not yet verified by hand

- **Whether a long-lived server's glibc arenas respond to `MALLOC_*`.** The reading the
  question was filed on — `/proc/7/smaps` showing ~135 MB of arenas, 108 MB of `[heap]`
  and 27 MB non-main, against ~16 MB of live native content — could not be re-read on
  2026-09-16: from inside an agent sandbox the server's `smaps`, `environ` and `cwd` are
  uid 65534, so only `VmRSS` (612 MB, 11 threads, 3.3 days up) was readable. A server
  built and started beside it for the measurement never reached that state — under the
  shipped `--max-old-space-size=1024` its `[heap]` stayed at 8 MB however hard it was
  scanned — so what several days of mixed work does to the arenas is still open, and it
  cannot be settled without restarting the process that serves this install.
  ```bash
  # from the host, not from inside a work cycle
  docker compose stop usagefoundry
  # add MALLOC_ARENA_MAX=2 to the service's environment:, then
  docker compose up -d usagefoundry
  # and after a day of ordinary use:
  docker exec usagefoundry sh -c 'grep -c . /proc/7/smaps; grep VmRSS /proc/7/status'
  ```

- **Nothing has been measured at a full transcript cache under the 1,024 MiB
  heap the compose file now ships.** The *Dreaming* entry's 898-949 MB at 1,024
  was measured when 1,024 was this install's `.env` and 2,048 was the shipped
  default; that has since inverted, and the entry is left as written because an
  entry is never amended in place. What it does not cover is the bound: the
  cache was 44% full at the time (measured, above), so ~93 MB of what
  `TRANSCRIPT_CACHE_MAX_ENTRIES` permits has never been resident during a
  measurement. Settling it: set `UF_TRANSCRIPT_CACHE_MAX_ENTRIES=219000` — just
  under what this corpus actually produces — and repeat the *Dreaming* entry's
  procedure, which forces the eviction path rather than the retention one; then
  grow the corpus or lower the bound further until a run evicts, and read the
  header strip's at-bound indicator. Until then the headroom between a 44%-full
  cache and a full one is arithmetic over an estimated per-turn size, not a
  reading.

- **No child's `oom_score_adj` has been read back, and no cgroup OOM has been
  made to choose.** `deprioritiseChildForOom` writes
  `/proc/<pid>/oom_score_adj` one line after each long-lived spawn, and what is
  measured of it is only that the raise direction needs no privilege: writing
  500 to `/proc/self/oom_score_adj` as uid 1000 succeeds on kernel
  6.12.76-linuxkit, 2026-09-13. The cross-process write — a root server
  adjusting a child at `UF_AGENT_UID` — could not be exercised from a work
  cycle, whose sandbox mounts a `/proc` in which no other pid resolves at all,
  so both halves of the claim are reasoned: that the write lands, and that a
  grandchild (an agent's `npm test`, which is what actually holds the memory)
  inherits it. Settling it: `docker compose up --build`, start a run, then
  `docker exec usagefoundry sh -c 'for p in /proc/[0-9]*; do printf "%s %s %s\n"
  "$p" "$(cat $p/oom_score_adj)" "$(tr "\0" " " <$p/cmdline | cut -c1-60)"; done'`
  and read next-server's 0 against each `claude` child's 500. What that still
  does not settle is which one the kernel picks: that needs a container driven
  over `mem_limit` with `dmesg` read for the `Memory cgroup out of memory` line
  naming the victim.

- **The OOM kill itself is unexercised.** That the limits reach the kernel is now
  measured — see *Container and environment* above, 2026-09-16: cgroup v2, `memory.max`
  12 GiB, `memory.swap.max` 0, `pids.max` 2048, no CPU quota — and README's per-child
  memory figures are measurements rather than estimates as of the same date. What is
  still open is the behaviour at the ceiling: nothing has driven the container into an
  OOM kill and watched `reconcileOnBoot` come back from it, and nothing has confirmed
  from the host side that the kill names the container rather than a host process.
  ```bash
  docker inspect --format '{{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.PidsLimit}} {{.HostConfig.NanoCpus}}' usagefoundry
  docker exec usagefoundry node -e 'const a=[];for(;;)a.push(Buffer.alloc(1<<26))'
  docker inspect -f '{{.State.OOMKilled}}' usagefoundry   # expect true
  dmesg | tail                                            # expect no host process named
  ```

- **The launcher's `/opt/winnow/src` branch was not booted, a sync failure's
  retry is unexercised, and no work cycle has run through the rebuilt filter
  (2026-09-10)**; routing rests on the boot line and the proxy answering. The
  1024 MB server heap figure is derived, not seen on a dreaming cold scan.
