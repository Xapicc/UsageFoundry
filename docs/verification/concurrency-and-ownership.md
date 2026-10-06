# Verification: Concurrency and ownership

[← Verification index](../verification.md)

## Verified

- **Folder collision, `npm test` 8 cases:** self, parent/child both ways, a
  second workspace's alias and a case-only difference collide, a sibling does
  not; isolated checkouts collide only with a whole-workspace run.

- **Concurrency, real database, stub agent:** a second run on one folder
  queues and is promoted when the first ends, another folder starts at once,
  and a workspace-root run queues behind both without starving.

- **Concurrency limit 1:** runs on two further idle folders queue rather than
  being refused, one promoted per freed slot; a run whose agent leaves a
  grandchild holding its output still terminates.

- **The `chat_proposals` rebuild keeps rows, index and cascade**, against
  SQLite directly and under a throw after each statement
  (`schemaMigration.test.ts`).

- **A process that does not own the data directory no longer closes the
  owner's runs on exit**: `shutdownRuns` is gated on `mayWriteDataDir()`. A new
  `shutdown.test.ts` case (a lock naming a live foreign pid, then
  `claimDataDir()`) failed on the unfixed function: `closed: 1, recovered: 1`,
  the row's `restart_closed`, `active_started_at`, `spent_usd_est` rewritten.

- **What a migration finds now outlives stdout, 2026-09-07**: all four
  findings, driven against a real SQLite file by reopening it, write one
  `ops_events` row each under `schema.fault`. `schemaMigration.test.ts`'s five
  cases fail with the write removed (`# fail 5`, then `# pass 16`), and the row
  survives the fault clearing.

- **A queued run now names the cap rather than its folder, 2026-09-12**: driven
  against the built standalone bundle with `maxConcurrentRuns: 1`, a
  `CLAUDE_BIN` that sleeps, and three runs — one running in `alpha`, one queued
  in `beta`, one queued in `alpha`. All three routes agreed:
  `{"kind":"cap","cap":1,"running":1}` for `beta` and
  `{"kind":"folder","ahead":0}` for the second `alpha` run, on the admission
  response, the list and the single-run route; `queuePosition` was 0 for both,
  which is the reading the old copy was built on. Rendered at 1280px, `beta`
  reads "waiting for a slot — 1 of 1 running" on the list and "Waiting for a run
  slot / 1 of 1 running. Its folder is free …" on its own page, and the second
  `alpha` run is unchanged. Holding new work through `POST /api/fleet` turned
  both into `{"kind":"paused"}`. Caveat: the new-run form's own notice was not
  driven through the browser — the blocker's presence on the admission response
  was checked, and the sentence is a pure function of it.

- **A review or a chat turn no longer outlives the server, 2026-09-27**: on
  the built standalone bundle with a stub `CLAUDE_BIN` that records its pid and
  sleeps, a review child and a chat-turn child under `killProcessGroup` each
  led their own session and **survived** the server's exit, both to `SIGINT`
  sent to the server's whole process group (what a terminal's Ctrl-C does) and
  to `SIGTERM` sent to the server alone. With the setting off, the group
  `SIGINT` reached the child directly. After `trackAssistChild` and the
  shutdown's ladder, none of the four cases left anything alive. Caveat: the
  stub exits on its first signal, so the `SIGTERM` and `SIGKILL` rungs were not
  exercised, the real `claude` was not run, and `npm run dev` was not driven
  (it cannot compile CSS here); dev runs the same `instrumentation.ts` handler.

- **Next's own signal handler cuts the shutdown's grace short, 2026-09-27**,
  Next 15.5.24: in the same harness the server exited 0.1s after the signal
  and left the review row `running` and the chat row `thinking`, with or
  without the fix above. `next/dist/server/lib/start-server.js` installs a
  `SIGINT`/`SIGTERM` handler that calls `process.exit(0)` once the HTTP server
  has closed unless `NEXT_MANUAL_SIG_HANDLE` is set, and nothing here sets it.
  With `NEXT_MANUAL_SIG_HANDLE=1` in the server's environment the same
  shutdown took 0.2s and both rows got their endings from the child's own
  settle (`failed`, "produced no readable output (exit 143)"). Caveat: the
  standalone bundle only, not `docker compose`, and no work cycle was in
  flight, where the same race would skip `reconcileInterruptedCycles`.

- **A work cycle in flight at SIGTERM is reconciled once Next's handler is
  off, 2026-09-27**, Next 15.5.24, standalone bundle at `8e4e847` and at
  `25d9ca7`, stub `CLAUDE_BIN` that writes one $0.60 transcript turn
  (100k in, 20k out, `claude-sonnet-4-5`), never prints `result` and ignores
  `SIGINT`. Without the variable the server exited 0.02s after `SIGTERM`
  with the run `running`, `spent_usd_est` 0, `active_started_at` still set,
  `server.lock` left behind and the stub still alive. With
  `NEXT_MANUAL_SIG_HANDLE=1` it exited at 3.04s, the `SIGTERM` rung: run
  `stopped`, $0.60 and 120,000 tokens reconciled, the column cleared, the lock
  released. A stub ignoring `SIGTERM` too was killed by the `SIGKILL` rung and
  the server exited at 8.14s, reconciled; one exiting on `SIGINT`, as the CLI
  does, at 0.13s; an idle server at once. The stub's environment held the
  variable at `8e4e847` and not at `25d9ca7`, which deletes it after Next has
  read it. Caveat: the loop settled every cycle itself, so
  `reconcileInterruptedCycles` found nothing to do; not `docker compose`.

- **A repeated signal no longer ends the shutdown, 2026-09-27**, same
  harness: with the variable set, `8e4e847`'s `process.once` left a second
  `SIGTERM` 10ms after the first to Node's default action, exit 143 at 0.02s
  with nothing reconciled. At `25d9ca7` a second `SIGTERM`, or `SIGINT` then
  `SIGTERM`, 1s apart, logged one "ignored" line and ended like the single
  signal (3.08s, $0.60 reconciled), and the stub got one `SIGINT` where
  `8e4e847` had sent it two from two shutdowns.

- **`npm run dev` needs `NEXT_EXIT_TIMEOUT_MS` as well, 2026-09-27**, same
  stub, `SIGINT` to the whole process group: `next dev`'s parent forwards the
  signal and `SIGKILL`s its server 100ms later by default, so with
  `NEXT_MANUAL_SIG_HANDLE=1` alone the server died at 0.13s, unreconciled.
  Every Ctrl-C there also delivers `SIGINT` twice (the group's and the
  parent's), and the handler logged the second as ignored. Through the
  `dev` script at `25d9ca7` it exited at 3.10s with $0.60 reconciled, the
  column cleared and the lock released, but the row was still `running` with
  no stop reason: the shutdown stops waiting once the child is gone and
  `active_started_at` is cleared, which can come before the loop writes the
  run's ending. Caveat: one run each; the standalone runs above all won that
  race.

- **The shutdown gate with two live processes, 2026-09-27**, `25d9ca7`,
  same harness: a second standalone server on the owner's `DATA_DIR` came
  up read-only and exited 0.02s after `SIGTERM`, leaving the owner's run
  `running` with its cycle open and `restart_closed` 0, the owner's lock in
  place and the stub alive; the owner's own `SIGTERM` then reconciled the
  cycle as above. Caveat: a stub, not a real billed agent.

- **The shutdown waits for each interrupted loop to write its ending,
  2026-09-27**, Next 15.5.24, `bb20fc5` against its parent `45f85c2`, the
  stub above with 150 MB of `user` lines appended to its transcript, so the
  transcript read between the post-cycle UPDATE and the status write
  outlasts the wait's 100ms poll. At `45f85c2` every run lost the race:
  through the `dev` script with `SIGINT` to the group, 6 of 6 exited at 3.2s
  with $0.60 reconciled and the row `running` with no stop reason, and on
  the standalone bundle with `SIGTERM`, 4 of 4. At `bb20fc5`, which waits on
  the loop rather than on the row, 6 of 6 and 4 of 4 exited at 3.3s
  `stopped` with the shutdown's stop reason. Unpadded, both wrote `stopped`
  (6 of 6 dev at `45f85c2`; 6 dev and 9 standalone at `bb20fc5`). Caveat: a
  stub, not `docker compose`; the padding widens the gap rather than finding
  it, and a run caught before its cycle began is pinned by
  `shutdown.test.ts`, not measured here.

- **The shutdown's log line counts the cycles the loop recovered,
  2026-09-27**, same harness and pins: at `45f85c2` the line read "recovered
  the spend of 0 interrupted work cycle(s)" in all 16 runs above, each row
  carrying the $0.60 its own loop had reconciled; at `bb20fc5` it read 1 in
  all 25. Caveat: one cycle per shutdown, and never one the mop-up
  recovered, so a sum of the two paths was not measured.

- **An assist that passed its door before a shutdown spawns nothing,
  2026-09-27**, `shutdown.test.ts` against its stubbed `spawn`: with
  `shutdownRuns` already called, `startAssist` for a resolution at `45f85c2`
  spawned the child and the row was still `running` when the 2s wait gave up;
  at `39b06aa` nothing was spawned, `after` ran once with `SHUTDOWN_REFUSAL`,
  and the row ended `failed` with that sentence. Caveat: the shutdown began
  before `startAssist` rather than inside `reviewCwd` or a resolution's merge,
  which is the state those awaits end in rather than the race itself, and no
  built server was signalled.

- **The shutdown waits for a merge the queue has in flight, 2026-09-27**,
  Next 15.5.24, standalone bundle on the host, `c3df39d` against `14d68c9`
  with only `land.ts`, `mergeQueue.ts` and `orchestrator.ts` swapped. A
  `GIT_BIN` stub held the queue's `git merge` until a release file appeared;
  SIGTERM while it was held, the release 1s later. At `14d68c9` 5 of 5 exited
  at 0.00s with the row `landing` and `landed_at` unset, and the orphaned
  merge then finished: the branch was in `main` with nothing recording it. At
  `c3df39d` 5 of 5 exited 0.08s to 0.16s after the release with the row
  `landed` and `landed_at` set. Never released, `c3df39d` exited at 10.05s
  and left the row `landing` for the boot. Caveat: not `docker compose`, so
  a merge killed part-way with PID 1 was not seen; the stub holds before git
  starts, so no half-written `MERGE_HEAD` was produced; the harness is not in
  the tree.

- **The boot recovers what a hard-killed cycle spent, and counts it,
  2026-10-06**, `shutdown.test.ts`'s fifth case, a `running` row with its
  cycle open and its transcript on disk inserted by hand: at `50d60d8`
  `reconcileOnBoot` left it `failed` with `iterations` 0, `spent_usd_est` 0
  and nothing on its log; with the reconciliation ahead of the UPDATE that
  nulls the pair, `spent_usd_est` above zero, `iterations` 1 and a log line
  naming the dollars. The task's own reproduction, given an `await`, passed
  too. Caveat: no process was killed; see the open item below.

- **A run that finishes during a shutdown is no longer offered by the
  restart notice, 2026-10-06**, `shutdown.test.ts`'s eleventh case, a stub
  child replying DONE and a `running` validation row: at `50d60d8` the run
  ended `completed` with `restart_closed` 1; with the flag written by the
  loop's own ending, `completed` and 0, and the task's own reproduction read
  a count of 0 and `{"reopened":0}`. Caveat: no built server was signalled,
  and a guard's refusal reached in the pre-cycle scan during a shutdown was
  reasoned about, not reproduced.

- **A land that meets a held `index.lock` says so, and this app's `git
  status` no longer takes one, 2026-10-06**, git 2.39.5 against temporary
  repositories, `9a4d301`. With `.git/index.lock` present a fast-forward
  merge or squash exits 1 with `error: Unable to create '…/index.lock': File
  exists.` and writes nothing, the operator's report word for word; one that
  is not a fast-forward prints `error: Unable to write index.` instead, writes
  `MERGE_HEAD` over an untouched tree, and its `merge --abort` fails on the
  same lock, which `unwind` reported as restored. `GIT_OPTIONAL_LOCKS=0` left
  a stat-dirty checkout's index unwritten by `status` and not by `git diff`
  against the working tree. The five new cases in `git.test.ts` and
  `landAfterVerify.test.ts` failed before the change and pass after. Caveat:
  what held the lock in the operator's checkout was never caught; the Land
  cards' `status` polls are the likely holder, inferred rather than seen.

## Not yet verified by hand

- **The `chat_proposals` rebuild on a real upgraded volume**, in a running
  container; the first `docker compose up` on an existing `.data` is the test.

- **The server lock with two live processes**: two servers on one `DATA_DIR`,
  and an owner stalled past `STALE_MS`. Unit tests cover the verdicts and
  `claimDataDir` against a temporary directory.

- **`STALE_MS` against a measured stall.** Its multiplier of six is reasoned;
  nothing has been timed under 25 concurrent runs.

- **The shutdown reconciling its cycles under a real `docker compose
  restart`.** The standalone bundle does, with a stub (Verified above).
  Still open: that the image's `ENV NEXT_MANUAL_SIG_HANDLE=1` reaches the
  server through tini and the entrypoint, the real CLI against the ladder, and
  whether 30s suffices for many cycles at once. Settle: `docker compose stop
  usagefoundry` with a cycle in flight, then `docker compose logs
  usagefoundry | grep 'run(s) on SIGTERM'` should print the line the handler
  writes only once it has finished, and the run's total should include the
  interrupted cycle's spend.

- **The shutdown gate against a real billed agent**: the two-process
  reproduction (Verified above) used a stub, and no container was built.

- **A land in flight at a real `docker compose stop`.** The standalone
  bundle waits for it (Verified above); what a merge cut off by PID 1's exit
  leaves in the operator's checkout, when the grace runs out first, has not
  been seen. Settle: hold `git merge` with a `GIT_BIN` stub mounted into the
  container, `docker compose stop usagefoundry` without releasing it, then
  `git status` and `ls .git/MERGE_HEAD .git/index.lock` in the checkout.

- **A migration finding has not been seen on a real boot (2026-09-07).**
  Settle: set `user_version = 99` via `docker compose exec app node -e`, run
  `docker compose restart app`, and `GET /api/status`'s `.schemaFaults` should
  hold one `downgrade` naming 99, its line in `docker compose logs`; a second
  restart clears it.

- **The boot's reconciliation after a real hard death (2026-10-06).** The
  fifth `shutdown.test.ts` case inserts the row a `SIGKILL` leaves; nothing
  has killed a container mid-cycle and read the row back, or timed the boot's
  transcript scan on a large `~/.claude`. Settle: start a run, `docker kill
  usagefoundry` during its first cycle, `docker compose up -d`, then the
  run's log should say the server stopped "without shutting down cleanly"
  with a dollar figure, its work cycles should read 1, and `docker compose
  logs usagefoundry | grep 'Reconciled the spend'` should print one line.

- **The `index.lock` refusals in the image, against a mounted checkout
  (2026-10-06).** Nothing above ran in a container, so whether the refusals
  the operator saw stop has not been seen. Settle: queue several branches
  into one checkout with each run's page open, and none should be refused
  naming `index.lock`; then `touch .git/index.lock` in that checkout and
  press Land, and the card should say another git process was using it, with
  `git status` there clean and no `.git/MERGE_HEAD`; remove the file, press
  Land again, and it should land. A lock left by a merge cut off at shutdown,
  the open item above, would now be named by the same refusal.
