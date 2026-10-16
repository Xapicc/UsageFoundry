# Verification: Run lifecycle — what a running cycle is inside

[← Verification index](../verification.md)

The open-call strip (`RunActivity`, fed by `tool_progress`) and the sub-agent
roster on `/runs/live` (`LiveSubagents`, folded by `liveSubagents.ts`): the two
live-only sets that are never rows. Split out of
[run-lifecycle.md](run-lifecycle.md) on 2026-10-16 with its two entries about
the strip moved here unchanged except where an item was cut to what is still
open.

## Verified

- **The live log's open-tool rows, rendered in isolation, 2026-09-11**:
  `renderToStaticMarkup` with the built CSS at 1280 and 390, both skins; the
  `sticky bottom-0` rows sit flush in both scroll states, jump-to-live paints
  over them, and 390px has no sideways scroll.

- **What the pinned CLI writes about a sub-agent, 2026-10-16.** Host `claude`
  2.1.280 as `claude -p --output-format stream-json --verbose
  --forward-subagent-text` under a clean `env -i` against a loopback stub of the
  Messages API with a fake key, nothing billed. A foreground `Agent` call
  (`run_in_background: false`) heartbeat at 30 s and 60 s as
  `tool_use_id: "<call>-heartbeat-<n>"`, `parent_tool_use_id: "<call>"`,
  `tool_name: "Agent"`, whole-second `elapsed_time_seconds`, and a main-thread
  `Read` beside it beat on its own clock. **A tool inside a sub-agent got no
  heartbeat**: a sub-agent's `Read` blocked 39 s on a FIFO produced only the
  `Agent` call's own, and the binary skips the timer inside an agent. Every
  `Agent` call, foreground or not, was filed as `task_started` with
  `task_type: "local_agent"`, the call's id as `tool_use_id`, `subagent_type`
  and `is_backgrounded`, and ended with `task_updated {status:"completed",
  end_time}` plus `task_notification` before the foreground `tool_result`. **A
  call that left `run_in_background` out was backgrounded**: its `tool_result`,
  "Async agent launched successfully", came 5 ms after `task_started`, no
  heartbeat followed in 35 s of work, and `background_tasks_changed` fired for
  background calls only. A sub-agent's API retry is a heartbeat with
  `subagent_retry` and `tool_use_id: "agent_<message id>"`, keyed on the
  call. Caveats: the model was the stub, and the CLI's own `Bash` cannot start
  in the sandbox this ran in, which is why the inner tool was a `Read`. These
  are the lines `liveSubagents.test.ts` folds.

- **The `/runs/live` sub-agent roster through the real run loop, 2026-10-16.**
  The built standalone server over a scratch `DATA_DIR`, auth off, one run
  created through `POST /api/runs` with `CLAUDE_BIN` a stub replaying the
  captured 2.1.280 lines on compressed timing: a background `Explore`
  delegation with no `run_in_background` at 0.2 s, a foreground `typescript`
  one at 0.6 s, a heartbeat of the measured shape for the foreground call at
  30.6 s, its end at 34 s, the background one's at 42 s, then `DONE`. In
  Chromium at 1280 and 390 the tile read "Sub-agents 2 running" with both rows
  named, described and marked background or foreground, counting from 8 s at
  t+9 s; the heartbeat put an `Agent` row on the open-call strip at the
  roster's own 32 s; a page opened at t+37 s read "1 running · 1 finished this
  work cycle" with the background row at 38 s, dated from the server's sighting
  rather than the page's; 390 px scrolled 0 px sideways; the run completed and
  its tile left; no console error. Caveat: a replay, so this is this app's
  wiring against the CLI's shapes and not a live CLI's timing.

## Not yet verified by hand

- **The live log's open-tool rows have never met a frame from a `claude` this
  app spawned against the real API**: the frame's shape, its 30-second
  restatement and its keying are measured (above), but not on a billed cycle,
  and the `aria-live` line was never listened to.

- **No sub-agent has been moved to the background mid-call.** `task_updated
  {patch:{is_backgrounded}}` is read from the binary, which sends it only under
  `CLAUDE_AUTO_BACKGROUND_TASKS` (120 s); the fold applies it, nothing has sent
  one. Settle: the stub-API recipe above with that variable set and a
  foreground sub-agent whose request is held past 120 s; the roster row should
  turn to background and outlive the call's `tool_result`.

- **The roster has never met a billed sub-agent.** Settle, on a host that is
  logged in: a cheap run whose prompt asks for one foreground and one
  background sub-agent of a minute each, with `/runs/live` open from before the
  run starts and a second tab opened mid-run.
