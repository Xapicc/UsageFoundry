# Verification: Run lifecycle — a cycle the CLI refused to start or to resume

[← Verification index](../verification.md)

What a run records when the pinned CLI declines a cycle with a sentence of its
own: a startup failure written to stderr alone, one written as a `result`
carrying `startup_failure_reason`, and a `--resume` refused because a deferred
tool call's server is gone (`startupFailureSentence`, `refusedWithoutApiCall`
and `IterationResult.errorText` in `src/lib/cycleInvocation.ts` and
`handleStreamLine`). Split out of
[run-lifecycle-hooks-and-endings.md](run-lifecycle-hooks-and-endings.md) on
2026-11-09, which had reached the size ceiling; the entries below up to the
first dated 2026-11-09 were moved verbatim.

## Verified

- **A resumed 2.1.319 cycle refused for a deferred MCP call ends the run on a
  bare exit code, and every pick-up repeats it, 2026-11-08.** Board task
  `872651ef`. Captured with `scripts/cli-capture/` plan e4: a stub API, a fake
  key, one stdio MCP server, and a user-scope `PreToolUse` hook that returned
  `permissionDecision: "defer"` for that server's tool.
  - **The deferring cycle** exited 0 with a `result` of `subtype: "success"`,
    `stop_reason: "tool_deferred"`, `deferred_tool_use` set and an empty
    `result`.
  - **`--resume` with a prompt and no `--mcp-config`** exited 1 with no
    `init`. It emitted `command_lifecycle` and a `result` of `subtype:
    "success"`, `is_error: true`, `terminal_reason:
    "tool_deferred_unavailable"`, whose text was `mcp__dsrv__ping isn't
    available, so its deferred call didn't run. Reconnect the tool and resume,
    or resume with a prompt and CLAUDE_CODE_DROP_UNAVAILABLE_DEFERRED_TOOL=1 to
    drop the call and continue.` The pair came twice.
  - **A second resume** was refused the same way.
  - **With the server back,** the call ran, then the prompt, and the session
    carried on.

  Replayed through `startRun` and `reopenRun`: the deferral went unnoticed
  (empty text, so the continuation prompt was resumed into it). The next cycle
  ended the run `failed` with `ending_code: exit_code` and `Claude Code exited
  with code 1.` Each pick-up resumed the same session and ended identically,
  and the CLI's sentence was in neither the stop reason nor the log. The cause
  is that `handleStreamLine` sets `isError` and `apiError` only for a
  non-success subtype and never reads `is_error`. The run ends; it does not
  loop. Neither this app's hooks nor TokenEconomizer's return `defer`, so this
  needs an operator hook. Caveat: a replay, one hook, one server.

- **A 2.1.319 startup failure on `stream-json` is exit 1, nothing on stdout
  and one sentence on stderr, and a picked-up run files it as a failed
  resume, 2026-11-08.** Board task `3a49f892`. Plan e5. Three startup
  failures each exited 1 with an empty stdout and a stderr sentence such as
  `Error: Invalid MCP configuration: MCP config file not found: <path>`: a
  missing `--mcp-config` file, an `--mcp-config` file that is not JSON, and a
  missing `--settings` file. `--resume` of an unknown id is not that shape. It
  wrote one `result` (`error_during_execution`, `num_turns: 0`, `errors:
  ["No conversation found with session ID: …"]`) and exited 1.
  Replayed through `startRun`:
  - **A fresh run** ended `failed` with `exit_code` and `Claude Code exited
    with code 1.` plus the understated-spend sentence. The stderr sentence
    reached the log only.
  - **The first cycle of a picked-up run** passed `cycleDidNoWork`, was
    retried once, and ended `resume_failed` with `Could not resume this run's
    Claude Code session (exit 1) … claude --resume <id>`. That is wrong: the
    session was fine and the argv was not.

  A `CLAUDE_CONFIG_DIR` that is a regular file exited 0 with a normal result
  and no error, though no transcript could be written. Caveat: a replay, and
  only the startup failures listed.

- **A resumed 2.1.319 cycle refused for a deferred MCP call now ends the run
  with the CLI's sentence, and the long-context 429 still ends `refusal`,
  2026-11-08.** Board task `872651ef`; the entry above has the behaviour it
  replaces. Plan e4 was re-driven (`claude --version` 2.1.319, stub API, fake
  key) and replayed through `startRun` and `reopenRun` with
  `scripts/cli-capture/replay.cjs deferred`:
  - **Segment 1** (D1 defers, exit 0; the loop resumes into it; D2 is
    refused) ended `failed`, `ending_code: exit_code`, with `Claude Code
    exited with code 1 and said: “mcp__dsrv__ping isn't available, so its
    deferred call didn't run. Reconnect the tool and resume, or resume with a
    prompt and CLAUDE_CODE_DROP_UNAVAILABLE_DEFERRED_TOOL=1 to drop the call
    and continue.”.` Two spawns, no retry.
  - **A pick-up with the server still missing** (D3) ended the same way, one
    spawn per press, and nothing re-entered on its own.
  - **A pick-up with the server back** (D4, then D5 `DONE`) completed with
    `ending_code: done`.
  - **The API-key long-context 429** (plan e3, cycle 5 re-captured) is exit 1,
    a `<synthetic>` assistant message, and a `result` of `subtype: "success"`,
    `is_error: true`, `terminal_reason: "api_error"`, `num_turns: 2`. It is
    the same `is_error` shape. Replayed with `replay.cjs longctx` it still
    ended `failed` with `ending_code: refusal`, because the sentence is read
    as `errorText` and `apiError` is unchanged.

  `src/lib/cycleEndingSentence.test.ts` replays the captured lines (usage and
  `modelUsage` blocks dropped) and failed first on every case that asserts the
  sentence. Caveat: a replay, one hook and one server, and the exit code is 1
  on both `is_error` shapes seen, so what an exit-0 `is_error` result does is
  unmeasured.

- **A 2.1.319 startup failure now ends with the CLI's stderr sentence and is
  not called a failed resume, 2026-11-08.** Board task `3a49f892`; the entry
  above has the behaviour it replaces. Plan e5 was re-driven and its
  `--mcp-config`-missing and `--settings`-missing captures replayed with
  `replay.cjs startup-fresh`: both ended `failed`, `ending_code: exit_code`,
  with `Claude Code exited with code 1 and said: “Error: Invalid MCP
  configuration: MCP config file not found: <path>”.` and the
  understated-spend sentence after it, and the sentence still in the log under
  `stream: stderr`. The picked-up shape was not run through `replay.cjs`
  (`startup-resumed` needs plan e1's DONE cycle, which was not re-driven);
  `cycleEndingSentence.test.ts` pins it with the captured stderr bytes, a
  kept transcript and `reopenRun`: two spawns rather than three, `exit_code`
  rather than `resume_failed`, no `claude --resume` in the reason. A child
  that dies with nothing on stderr still retries once and ends `resume_failed`.

- **A 2.1.319 startup failure can arrive as a `result`, and then it was filed
  as a refused resume and its session id replaced the run's, 2026-11-09.**
  Board task `4237ea22`. Read out of the binary first: the error variant of
  `result` has an optional `startup_failure_reason`, and `config_file_invalid`,
  `org_config_required_unavailable` and `org_config_refused` are the three
  written to every stream-json run. Only the first was driven. New plan e8
  (`scripts/cli-capture/plans.mjs`): a stub API, a fake key, a scratch `HOME`
  and `CLAUDE_CONFIG_DIR`, one good `DONE` cycle, then `$CLAUDE_CONFIG_DIR/
  .claude.json` overwritten with `{nope` and the session resumed, and once more
  as a fresh start.
  - **Both exited 1 with one line on stdout**, a `result` of `subtype:
    "error_during_execution"`, `is_error: true`, `num_turns: 0`,
    `duration_api_ms: 0`, `total_cost_usd: 0`, `startup_failure_reason:
    "config_file_invalid"`, `result_index: 0` and `errors` holding one string:
    `Configuration error in <dir>/.claude.json: JSON Parse error: Expected
    '}'`, a line naming the backup file, and the `cp -f` command that restores
    it. Stderr carried the same text, beginning with a line saying the file was
    corrupted and, on the first start only, where the corrupted copy was backed
    up to.
  - **Its `session_id` is not the one `--resume` was given** and nothing was
    written under it: the config directory's `projects/` held the good cycle's
    transcript and no other.
  - **Not driven: `org_config_required_unavailable` and `org_config_refused`.**
    The gate is applied to a stored claude.ai sign-in whose organization
    requires its settings, behind a flag the server delivers; plan e3's made-up
    stored sign-ins ran normally against the stub. They need an organization.

  Replayed through `startRun` and `reopenRun` before the change (the new cases
  in `cycleEndingSentence.test.ts` failed first): the pick-up spawned three
  times, retried once and ended `resume_failed` naming `claude --resume`, and
  the fresh run stored the result's made-up `session_id` (the pick-up's row was
  not read before the change). Inferred from `startRun`'s transcript check and
  not run: a pick-up after the operator repaired the file would have found no
  transcript under that id and started the task over. After it, `scripts/cli-capture/replay.cjs
  config-file` on the captured bytes: the pick-up spawned twice and ended
  `failed`, `ending_code: exit_code`, with `Claude Code exited with code 1 and
  said: “Configuration error in <dir>/.claude.json: JSON Parse error: Expected
  '}' A backup file exists at: … You can manually restore it by running: cp -f
  …”.`; its `session_id` was still the good cycle's and the fresh run's was
  null. Caveat: a replay with a stubbed `spawn`, Claude Code only, and one of
  the three reasons.

- **The CLI's refusal of a resumed deferred call makes no API call, and the
  cycle it was charged is now handed back, 2026-11-09.** Board task
  `588c9b5a`. Plan e4 re-driven (2.1.319, stub API, fake key), reading the
  fields the first capture did not look at. D1, the deferring cycle:
  `duration_api_ms: 55`, `total_cost_usd: 0.000105`. D2 and D3, the refusals,
  each written twice with a `command_lifecycle` frame around it: `terminal_reason:
  "tool_deferred_unavailable"`, `duration_api_ms: 0`, every `usage` count 0,
  `total_cost_usd: 0.000105` (D1's total, unchanged), exit 1, and `num_turns`
  16 on D2 and 18 on D3, so each press adds two turns to the session it
  refused. The loop charged each one a work cycle, so a pick-up at an unchanged
  cap was refused at the door ("already used N work cycles") for a reason that
  was not the operator's to fix.

  `refusedWithoutApiCall` refunds it when the reason is exactly that one, the
  API time is reported and zero, no tokens were counted and the cycle's cost
  did not move; a refusal that fails any of those stays charged. Pinned in
  `cycleEndingSentence.test.ts`: the pick-up at the cap the first segment
  used, three presses in a row, `iterations` 1 throughout; six refusals that
  each change one field and stay charged; and the predicate alone. Loosening
  the compiled predicate to the reason alone failed the four cases that carry
  an API call, a missing duration, a moved cost or tokens. Not counted in
  `worked_refunds`: it spent nothing, so `ranWorkCycle` still reads it as a
  cycle in which nothing happened. Caveat: a replay, one hook and one server;
  the zero holds for this refusal only, and what an exit-0 `is_error` result
  reports is unmeasured. The two other options on the task (a per-pick-up
  opt-in that sets `CLAUDE_CODE_DROP_UNAVAILABLE_DEFERRED_TOOL=1`, and putting
  the refusal's reason on the `result` event for a warning at the door) were
  not driven or built.

- **A startup failure's spawn makes no API call on 2.1.319, and the cycle it
  was charged is now handed back, 2026-11-09.** Board task `61431eba`. Driven
  with `scripts/cli-capture/` against the stub API, a fake key, and every
  request the stub saw counted against the cycle whose start and duration
  (`cycleN.meta.json`) contain it.
  - **Said on stderr alone (plan e5).** `--mcp-config` file missing (exit 1,
    0.5 s), `--settings` file missing (0.2 s) and `--mcp-config` not JSON
    (0.3 s): no stdout line, one sentence on stderr, and **no request of any
    kind** in all three. The control in the same plan, `CLAUDE_CONFIG_DIR`
    pointed at a file, is not a startup failure on this pin: it exited 0 and
    made one request, so the count does see a request when there is one.
  - **Said as a `result` (plan e8).** Both corrupt-`.claude.json` cycles, the
    resume and the fresh start: `startup_failure_reason: "config_file_invalid"`,
    `duration_api_ms: 0`, `total_cost_usd: 0`, every `usage` count 0,
    `num_turns: 0`, exit 1, and no request; the good cycle before them made
    one.
  - **What lets an empty stdout stand for "no request" (plan e9, new).** The
    stub held its reply three seconds. The first stdout line, `system:init`,
    reached the pipe 78 ms (API key), 56 ms (`CLAUDE_CODE_OAUTH_TOKEN`) and 52
    ms (stored sign-in) before the first `/v1/messages` request, each cycle
    made exactly one request, and the line was not waiting on the reply. A
    child that wrote no line had not reached its first request.

  Before the change, `scripts/cli-capture/replay.cjs` on those captured bytes
  (through `startRun` and `reopenRun`, `spawn` stubbed): `startup-fresh` left
  `iterations: 1` on both fresh runs and added "this run's spend is
  understated" to the stop reason; `startup-resumed` ended the pick-up at
  `iterations: 2` against a cap of 4; `config-file` ended the pick-up at 2 and
  the fresh run at 1. After it: 0 and 0, with the stop reason ending "This work
  cycle did not call the API, so it was not counted against the run's limit."
  and no understated sentence; 1; and 1 and 0. `startup-resumed` replayed e8's
  good cycle as its first segment, because e1 was not driven.

  `refusedWithoutApiCall` gained an arm for each shape. The result-shaped arm
  needs the figures the deferred refusal's does (API time reported and zero, no
  tokens, cost not moved) and a loop that took the cycle for a startup failure;
  the stderr-only arm needs the loop to have taken it for one and `stdoutLines`
  0, because it has no figure and the three it does carry are zero only for
  want of anything said. Pinned in `cycleEndingSentence.test.ts`, which failed
  first on its six cases that expect a refund: for stderr alone a fresh run,
  the pick-up at the failed press's own cap and a second press; for the result
  a second press; and the predicate's two "holds" cases. Each arm's other
  conditions are cases that stay charged (a timed or unreported duration,
  tokens, a moved cost, no startup reason, a line on stdout, a loop that did
  not take it for a startup failure). Four mutations of the compiled predicate
  each failed the cases that carry them: the tokens-and-cost test removed (10
  cases), the result arm's duration test replaced by `true` (4), the startup
  gate removed (2) and `stdoutLines === 0` replaced by `true` (2). Not counted in
  `worked_refunds`. Caveat: a stub API and a replay with a stubbed `spawn`;
  Claude Code only (a Codex run keeps the cycle charged); three stderr
  sentences and one result reason driven, so the stderr arm's reach to every
  other empty-stdout exit rests on the e9 ordering and not on a driven case.

## Not yet verified by hand

- **What `CLAUDE_CODE_DROP_UNAVAILABLE_DEFERRED_TOOL=1` does is the CLI's
  claim.** The stop reason quotes the sentence that offers it; no cycle was
  driven with it set, so that it drops the call and the session carries on is
  unverified, as is whether it reaches a cycle through this app's child
  environment. Settle with plan e4: add a cycle after D2 with
  `env: { CLAUDE_CODE_DROP_UNAVAILABLE_DEFERRED_TOOL: "1" }`, the server
  missing, and a prompt, then read its `result`.

- **A Codex startup failure is unmeasured.** `startupFailureSentence` is not
  asked for a Codex run, which keeps its retry and `codex resume <id>`. Settle
  by running `codex exec --json` with a missing `-c` config path under a
  scratch `CODEX_HOME` and reading what reaches stdout and stderr.

- **`org_config_required_unavailable` and `org_config_refused` have not been
  seen.** Both are written to every stream-json run as a zeroed result carrying
  `startup_failure_reason`, and `startupFailureSentence` treats any reason as a
  refusal to start on the strength of `config_file_invalid` alone. Their cycles
  are refunded on the figures their result reports, as `config_file_invalid`'s
  is, so a result that reports no `duration_api_ms` or a nonzero one stays
  charged; what is open is whether either reports zero. Settle on an
  account whose organization requires its managed settings: sign the container
  out of that organization (or block the settings endpoint) and run one
  `claude -p --output-format stream-json` cycle, then read the `result` line.

- **The first-line-before-first-request ordering is measured on 2.1.319 only.**
  The stderr-only refund depends on it, so a pin bump must re-run plan e9 and
  see `firstStdoutAt` before the request's `t` for all three credential
  routes, before the refund is trusted on the new pin: `node
  scripts/cli-capture/plans.mjs e9 <outdir> > plan.json && node
  scripts/cli-capture/drive.mjs <outdir> plan.json`, then compare each
  `cycleN.meta.json`'s `firstStdoutAt` with `requests.jsonl`. Also open: a
  nested-sandbox or OAuth-refresh cycle that hits the network before its first
  line (e9's three routes did not, but their sign-ins were made up).
