# Verification: Run lifecycle — what a pinned CLI emits beyond `init` and `result`

[← Verification index](../verification.md)

What a work cycle's `stream-json` and its OTLP export carry besides the
`system:init` and `result` lines, and what this app's readers make of it:
`handleStreamLine` in `orchestrator.ts`, `readChatEvent` in `chatStream.ts`,
`parseLogsPayload` in `otlp.ts`. Opened on 2026-11-08 for the move of the pin
from 2.1.310 to 2.1.319. Compaction, background tasks, endings and
`credential_expires_at` are filed with their areas, and the entries below say
where.

The measurements were captured with `scripts/cli-capture/`. `drive.mjs` runs
the installed CLI against a loopback stub of the Messages API that also takes
OTLP/HTTP JSON, with a fake key and a scratch `HOME` and `CLAUDE_CONFIG_DIR`.
`plans.mjs` names each capture, e1 to e7. `replay.cjs` feeds the captured bytes
through `startRun` with `spawn` stubbed, or through the parsers directly. Every
entry shares two caveats. The answers are the stub's, not the real API's. And
the CLI's `Bash` cannot start inside this sandbox, so no command ran.

## Verified

- **`claude_code.api_request` still parses with the 2.1.317 `anthropic.*`
  attributes on it, 2026-11-08.** Measured on `claude` 2.1.319, the
  linux-arm64 build this container installs. The exporter was configured as
  `telemetryEnv` sets it (logs, `http/json`, `uf.run_id` as a resource
  attribute, a bearer header), plus metrics. Across e1 to e4 and e6 the CLI
  sent 31 `api_request` records, and `parseLogsPayload` returned 31 rows, each
  with a request id, run id, session id, model and cost. Every record carried
  `anthropic.provider: firstParty` and `anthropic.custom_base_url: true`
  (`ANTHROPIC_BASE_URL` pointed at the stub). `anthropic.plan: max` appeared
  only under a stored claude.ai sign-in. `anthropic.seat_type` never appeared.
  The metrics carried the same keys, but this app exports none. The parser
  reads none of the four, and nothing it does read was renamed. Caveats:
  `request_id` exists only because the stub sends a `request-id` header, and
  a record without one is dropped by design. `custom_base_url` should read
  false in a container that sets no base URL. No Team or Enterprise seat was
  tried.

- **Nothing here depends on `claude_code.safety_event` or on OTel `effort`,
  2026-11-08.** Same setup. Across 50 OTLP posts from e1 to e7 (25 of them
  logs) no safety event arrived, and
  no file under `src/` names one. The event names that did arrive were
  `api_request`, `user_prompt`, `assistant_response`, `tool_decision`,
  `tool_result`, `api_error`, `compaction`, `hook_*`, `mcp_server_connection`,
  `plugin_loaded` and `managed_settings_resolved`, and only `api_request` is
  read. `effort` appeared on `api_request` only when a level was in force:
  `--effort high` on `claude-opus-4-5` gave `high`, `--effort medium` on
  `claude-opus-5-5` gave `medium`, and `--effort low` on `claude-sonnet-4-5`
  gave nothing. `parseLogsPayload` stores the value in
  `telemetry_requests.effort`, and nothing reads that column. The usage page's
  effort breakdown comes from the transcripts' `effort` (`transcripts.ts`
  into `windows.ts`), and those recorded `high` and `medium` to match. Caveat:
  the case 2.1.312 fixed, an effort change partway through a task, was not
  exercised.

- **The stream readers parse JSON, and 2.1.311's `\uXXXX` escapes change no
  value they read, 2026-11-08.** Capture e1 put DEL, U+0085, U+009B, U+200B,
  U+200E, U+2028, U+2029, U+FEFF, U+00AD and U+2066 into a tool input and an
  assistant text. On `stream-json` every one of them was written as an escape,
  with no raw byte, while the transcript kept them raw. Replayed through
  `startRun` in three chunks cut at arbitrary byte offsets, `handleStreamLine`
  logged the tool call and the text with the characters decoded. It splits on
  `\n` after `setEncoding("utf8")` and then calls `JSON.parse`.
  `readChatEvent` read all 225 captured lines with `unreadable: 0`.
  `liveStream.ts` parses no CLI output at all: it reads stored rows.
  `vaultPointer.ts`, the one `--output-format json` caller, and `review.ts`
  parse with `JSON.parse` too. The only substring test is
  `parseCompactionBoundary`'s `'"compact_boundary"'`, which runs on transcripts
  and matches an ASCII key. Caveat: the replay stubs `spawn`, so the real
  child's pipe chunking was not exercised.

- **A resumed 2.1.319 session keeps its id, and one cycle can carry several
  `result` lines, 2026-11-08.** All 14 `--resume <id>` cycles reported the id
  they were given, and only that id. Those were the seven in e1 and e4 plus the
  seven of their re-run from the committed scripts. So `changedSessionNotice`
  is not expected to fire on this pin. In e1 and e7, each background task's
  notification opened another turn in the same process, with a second
  `system:init` and a second `result`. e7 had 11 of each in one cycle. Replayed, the loop
  costed every one of them. On cycles that resume a deferred tool call, it
  also logged two event types as unrecognised:
  - `command_lifecycle`, which carries a `command_uuid`, a `state` of `started`
    or `cancelled`, and the session id;
  - `attachment`, a `hook_success` record holding the hook's stdout and stderr.

  Neither carries a cost, a session change or a stop reason. They did not
  appear on an ordinary resumed cycle. Caveat: one hook, one MCP server, the
  stub's answers.

## Not yet verified by hand

- **None of this has come from the real API or the container's live run
  loop.** The shapes above are the CLI's, but the answers that produced them
  are the stub's, and the run loop read them from a replay rather than from a
  child it spawned. Settle with board task `d3c81e18` (operator-only): a
  multi-cycle run with live telemetry on, then its run page, its telemetry
  card and `select count(*), sum(cost_usd) from telemetry_requests where
  run_id = ?` against the run's own cost.
