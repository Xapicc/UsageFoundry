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
