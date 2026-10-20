# Verification: Run lifecycle — a work cycle's wait for background tasks

[← Verification index](../verification.md)

## Verified

- **`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` is milliseconds, `0` waits without
  limit, and the clock is the one the binary says it is, 2026-10-05.** Host
  `claude` 2.1.280, run as `claude -p --output-format stream-json` against a
  local stub Messages server with a fake key and a clean `env -i`, a background
  `Agent` sub-agent whose scripted work took about 30 s. At `10000` the main
  turn ended at 0.22 s, stderr printed `Background tasks still running after
  10s; terminating. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait
  indefinitely.` at 10.38 s, `task_updated {status:"killed"}` and
  `task_notification {status:"stopped"}` followed, then one `result`
  (`success`, exit 0): the kill lands about 0.2 s past the nominal value, and
  `task_progress` at 5 s and 10 s did not move it. At `0` the CLI waited 30 s,
  the sub-agent completed and woke the agent, and the cycle emitted **two
  `result` events** at 30.54 s — the first is not written when the main turn
  ends but after the whole wait, which is the two-`result` cycle
  `cycleCostAfterResult` records. With `8000` and a second, shorter sub-agent
  that finished at 5.3 s and woke the agent, the longer one was killed 8.2 s
  after the wake rather than 8.4 s after the first turn: **the clock restarts
  on every wake**. Caveats: the model was the stub, not a billed one; the
  sub-agent made `Read` calls because the CLI's Bash tool cannot start inside
  the sandbox this ran in (`EPERM` listening on a unix socket under managed
  `sandbox.failIfUnavailable`); the binary's own reading (default `600000`, no
  upper clamp) was read, not run.

- **The ceiling's parser is not what it first looked like, 2026-10-05.** Same
  stub, `10s` and `1.5` and `1` all killed the sub-agent 0.2 s after the main
  turn ended (stderr says `after 0s`), `1e4` waited 10 s, `3000` waited 3 s,
  and `abc`, an empty string and `-5` did **not** kill it in 25 s, so they fall
  back to the 600 s default without an error. This is why
  `backgroundWaitCeiling` only ever emits a bare integer and never `0` while a
  time limit is set. A reading from the binary said `parseInt`; `1e4` waiting
  10 s says it is closer to `parseFloat`, so that reading was wrong in one
  detail.

- **What the CLI emits for a task it stops, 2026-10-05.** From the same stub
  runs, a ceiling kill and a budget kill are each three `system` events in one
  millisecond — `background_tasks_changed`, `task_updated {task_id,
  patch:{status:"killed", end_time}}`, `task_notification {task_id,
  tool_use_id, status:"stopped", output_file, summary}` — and `summary` equals
  the task's `description` on a kill (the sub-agent's last text on completion),
  `task_updated` carries no description, and `output_file` was **0 bytes** after
  a kill. Those are the shapes `runTasks.ts` reduces and the next cycle's note
  is built from.

- **A stopped task reaches the next cycle's prompt through the real run loop,
  2026-10-05.** `createRun` and `startRun` from the compiled test build over a
  scratch `DATA_DIR`, `CLAUDE_BIN` a stub that emitted the three events above
  for a `bg sleeper` sub-agent in cycle 1 and `DONE` in cycle 2. With
  `maxDurationMinutes` 30 the stub's environment held
  `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` 1799991 and then 1799975; with no time
  limit, `0`; with the variable set on the harness to `123456`, `123456` in both
  cycles and a log row naming it; and cycle 2 resumed `sess-e2e` with a prompt
  that began with the note, naming `bg sleeper` and its output file, followed by
  the continuation and the needs-review notice, identical in the `iteration`
  event and in argv. A control whose task `completed` got no note. Caveat: a
  stub CLI, so this measures this app's wiring and not a real model's reading of
  the note.

- **A background sub-agent inside one long tool call is silence to the work-cycle
  watchdog, 2026-10-20.** `runIteration` driven directly (its `silenceMs` is
  taken raw; the 5-minute floor is `cycleSilenceMs`'s, applied by the run loop)
  from the compiled test build over a scratch `DATA_DIR`, `CLAUDE_BIN` a sh
  wrapper around the real `claude` 2.1.280 with `ANTHROPIC_BASE_URL` on a
  loopback stub of `/v1/messages`, a scratch `CLAUDE_CONFIG_DIR`, nothing billed.
  The stub answered the main thread with an `Agent` call (no
  `run_in_background`, so backgrounded by default), then the main thread's
  acknowledgement with `end_turn`; the sub-agent's first request got a `Read` of
  a FIFO in the workspace that a writer opened after a set delay. With
  `silenceMs` 20000 and the FIFO released at 70 s, the CLI printed its last line
  (`task_progress`, `last_tool_name: "Read"`) at 0.3 s and **nothing after it**;
  the watchdog ended the cycle at 20.3 s (`exitCode` 0,
  `sawResult` false, recorded interrupt `deadline`, "No output from Claude Code
  for 20s"), with the sub-agent healthy and blocked, not hung. The control, same
  run with `silenceMs` 200000 and the FIFO released at 45 s: the sub-agent
  finished at 45.1 s, the main thread was woken and answered `DONE`, two
  `result` events, no interrupt, so the 44.8 s of silence was a healthy cycle.
  Caveat: the sub-agent's blocking call was a `Read` of a FIFO because the CLI's
  Bash tool cannot start in this sandbox; a real build is the same shape (a tool
  running inside an agent gets no `tool_progress` heartbeat) but was not run.

- **While a background sub-agent runs the deadline is the default, and a hung one
  still ends, 2026-10-20.** The same driver after `quietDeadlineMs` was wired
  into `onSilence` (`orchestrator.ts`). At `silenceMs` 20000 and the FIFO
  released at 70 s the cycle was **not** ended: the sub-agent finished at 70.1 s,
  the main thread answered `DONE` at 70.2 s, `exitCode` 0, `sawResult` true, no
  interrupt, 69.8 s of silence against a 20 s deadline. For the bound, the
  FIFO was never released and a scratch copy of the compiled `orchestrator.js`
  had `FALLBACK_CYCLE_SILENCE_MINUTES` edited from 120 to 0.5, so the allowance
  was 30 s against a 10 s configured deadline: the cycle was ended at 30.4 s
  with "No output from Claude Code for 30s with 1 background sub-agent running
  (which print nothing inside one tool call, …)". Not measured: the real
  120-minute allowance waited out.

- **A foreground `Agent` call is a task too, and a Stop inside it files the same
  endings as a stopped background one, 2026-10-20.** The same driver with the
  `Agent` call carrying `run_in_background: false`, the FIFO never released, and
  `stopRun` after 8 s. `task_started` read `task_type: "local_agent"`,
  `is_backgrounded: false`, `spawn_depth: 1`; `task_progress` carried `task_id`,
  `tool_use_id`, `description`, `subagent_type`, `usage` and `last_tool_name` and
  no `task_type`, no `status`, no `is_backgrounded`; the Stop then produced
  `task_updated {patch:{status:"killed", end_time}}` and
  `task_notification {status:"stopped", output_file, summary}` — the pair
  `stoppedTasksNotice` names a task from. That is why `runTasks` leaves out a
  task stated foreground: the next cycle would otherwise have been told a
  foreground delegation was a stopped background task. Not measured: whether the
  CLI ever sends `is_backgrounded: false` on `task_started` for a shell the agent
  started with `run_in_background: true` (the Bash tool cannot start here);
  `runTasks` keeps such a task anyway when a `background_tasks_changed` snapshot
  lists it or a patch says `is_backgrounded: true`.

## Not yet verified by hand

- **A real, billed cycle with a background sub-agent has not met the ceiling.**
  The measurements above are against a stub server. Settle, on a host that is
  logged in: `claude -p --model claude-haiku-4-5-20251001 --output-format
  stream-json --verbose` asked to start one background sub-agent that runs
  `sleep 60` and then end its turn, once with
  `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=10000` (expect a kill at about 10 s) and
  once with `0` (expect a wake-up turn after about 60 s), under $0.10.

- **A background Bash shell's five-second grace is read, not measured.** The
  binary's wind-down kills a shell-only wait after `5000` ms whatever the ceiling
  is (read from the pinned binary), so a run whose only background work is a
  shell would not hold its cycle. The CLI's Bash tool could not start inside the
  sandbox this was investigated in. Settle: the same `claude -p` with a
  `run_in_background` Bash `sleep 30` and the ceiling at `0`; the process should
  exit about 5 s after the main turn.

- **Whether a real sub-agent's partial work is in its `output_file` after a
  kill is unmeasured.** The stub's was 0 bytes. The next cycle's note says
  "whatever they wrote" and promises nothing; settle with the real run above and
  `wc -c` on the path the `task_notification` names.
