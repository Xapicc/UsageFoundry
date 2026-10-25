# Verification: Run lifecycle — what a resume finds in the session transcript

[← Verification index](../verification.md)

The pinned CLI's 30-day transcript sweep, a `--resume` whose transcript is
gone, one truncated mid-turn, and a cycle the API refused, whose prompt is
already in the transcript. Split out of [run-lifecycle.md](run-lifecycle.md) on
2026-10-25 with its four entries about them, and the one item they leave open,
moved here unchanged.

## Verified

- **The pinned CLI deletes a transcript last written more than 30 days ago, on
  any `claude -p` startup** (2026-10-06, `claude` 2.1.280). A scratch
  `CLAUDE_CONFIG_DIR` with no settings file held `.jsonl` files whose mtimes
  `touch -d` set to 25, 29, 31, 35 and 40 days back, plus a fresh one; one
  `claude -p -- hello` against a dead `ANTHROPIC_BASE_URL`, killed by `timeout`,
  left the 25-day, 29-day and fresh files and removed the other three. Nothing in
  this app sets `cleanupPeriodDays`. Caveat: the default only, ages set by
  `touch` rather than lived, and whether the sweep runs before the first request
  was not separated.

- **A `--resume` whose transcript is gone exits 1 with a `result` event and no
  API call, so the loop never took it for a failed resume** (2026-10-06, `claude`
  2.1.280). `claude -p --output-format stream-json --verbose --resume <new uuid>`
  in a scratch config directory printed `No conversation found with session ID:
  <id>` on stderr and one stdout line: `result`, `error_during_execution`,
  `is_error: true`, `num_turns: 0`, `duration_api_ms: 0`, the same id, that
  sentence in `errors`; it wrote no transcript. Those lines replayed through
  `startRun` by a stubbed child: a `result` arrived, so `looksLikeResumeFailure`
  is false, and before the transcript check each pick-up was charged a cycle and
  ended `failed` with "Claude Code exited with code 1."; with it, the pick-up
  restarts on a new session and carries on. Caveat: the replay fed the measured
  lines to a stub, not the real CLI under the loop.

- **A `--resume` of a session truncated mid-turn is not refused: the pinned CLI
  pairs the dangling `tool_use` with a synthetic result and calls the API**
  (2026-10-06, `claude` 2.1.280). A transcript the CLI wrote in a scratch
  `CLAUDE_CONFIG_DIR` against a stub API, cut by hand after its first assistant
  line (a `Bash` `tool_use`), resumed with `-p --output-format stream-json
  --verbose --resume <id>`: the CLI appended a `tool_result` *[Request
  interrupted by user for tool use]* (`is_error`), a meta *Continue from where
  you left off.* and a synthetic *No response requested.*, the one request the
  stub got carried the `tool_use` followed by that result, and it exited 0 with
  `success`, `num_turns: 1`. Against a dead `ANTHROPIC_BASE_URL` the same resume
  retried 10 times over 178 s and ended `subtype: success`, `is_error: true`,
  `num_turns: 1`, `terminal_reason: api_error`, exit 1 — not the zero-turn
  refusal `cycleDidNoWork` now counts, which a missing transcript still produces
  (re-measured: no `init`, no `result` text). Caveat: a stub accepts any message
  list, and the cut was at a line boundary rather than by a kill.

- **A cycle the API refuses with a transient error has already written its
  prompt to the session transcript, so the retry needs no `handBack`**
  (2026-10-25, `claude` 2.1.310). Against a loopback stub API, with a fake key
  and a scratch `CLAUDE_CONFIG_DIR` and `HOME` under `$TMPDIR`: a session
  created while the stub answered normally, then `claude -p --output-format
  stream-json --verbose --resume <id> -- <distinctive prompt>` while it refused
  every request. Eight runs, one per refusal: 529 (twice, and once at the
  default retry count), 503, 500 (default count), 429, a destroyed socket, and
  a fresh `--session-id` cycle refused on its first request. Each exited 1 with
  a `result` of `success`, `is_error: true`, `num_turns: 1`, `terminal_reason:
  api_error` after one `system:api_retry` event, or ten at the default count
  (182 s and 184 s for 529 and 500). In all eight the session `.jsonl` held the
  prompt as a user turn and ended on a synthetic `assistant` line flagged
  `isApiErrorMessage` (the file grew by 10 KB with one retry, 27 KB with ten).
  In the seven that went on, the next `--resume` against a stub that answered
  normally sent a request body containing the prompt. The `system:init` event
  names the session before the refusal, which is what `adoptSession` reads, so
  the retry resumes the same file. Caveat: the stub's body is `Overloaded` for
  every status, `CLAUDE_CODE_MAX_RETRIES=1` stood in for the default in six of
  the eight, and the refusal came on the first request after a clean session,
  not after tool use.

## Not yet verified by hand

- **Whether the real API accepts what the CLI sends for a session truncated
  by a mid-turn kill.** The CLI's repair is measured against a stub only, and a
  transcript cut mid-line by the kill was not tried. Settle: kill a cheap real
  run during a long `Bash` call, then pick it up and read the cycle's ending.
