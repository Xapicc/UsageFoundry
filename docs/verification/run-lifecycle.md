# Verification: Run lifecycle

[← Verification index](../verification.md)

## Verified

- **Stop reaches `stopped` against a stub that ignores SIGTERM**, about 8s
  after the stop (5s escalation + 2s drain), instead of staying `running`
  forever; the iteration also settles on `exit`, since a grandchild can hold
  stdout open.

- **Operator stop records `stopped`**, not `failed`, with the interrupted-cost
  note in `stop_reason`.

- **Normal accounting survives the stop fix:** a stub `result` event records
  $0.42 / 35 tokens and completes on `DONE` with no interrupted-cost note.

- **Restart recovery:** a row left `running` closes as `failed` with
  `claude --resume <id>` in its stop reason, freeing the folder.

- **One real billed run, end to end:** 1 iteration, exit 0, stopped at the
  cap, $0.067 / 13,983 tokens accounted correctly.

- **Provider refusals, `npm test` 18 cases:** spend caps and credit balances
  fail as themselves while a 429 or an overload is transient;
  `refusalResumeAt` backs off 20/40/60 minutes, never re-spawns inside five
  and never holds a folder past six hours.

- **`acceptEdits` holds mutating git for an approval a `-p` child cannot get:**
  four runs ended with their change uncommitted. For $0.02, `--allowedTools
  "Bash(git add:*)" "Bash(git commit:*)"` committed while `git push` stayed
  refused, and proved additive outside `manual`.

- **Agents here have never had `Grep` or `Glob`:** CLI 2.1.226 drops both when
  `Bash` is present, and 0 of 469 `system:init` events since 2026-08-10
  carried `Grep`.

- **The outbound webhook delivers and its signature verifies, 2026-08-23.**
  The compiled `notifyLifecycle` at a local listener: four events, two POSTs
  (`needs-review`; `stopped` after a `budget` verdict), six-key UTF-8 body,
  `sha256=` header matched by `openssl` and Python's `hmac`. A real POST to
  httpbin got 200, but byte fidelity is proved over loopback only.

- **An assist's `stream-json` stdout against the pin, 2026-09-09**: CLI
  `2.1.260`, `spawnAssist`'s whole flag set, exit 0, eight lines. The
  `tool_use` came on an `assistant` event in the shape `assistToolUses` reads;
  `parseReviewOutput` read `completed`, $0.206351, 64,437 tokens.
  - argv: `-p … --output-format stream-json --verbose --permission-mode plan
    --max-budget-usd 0.30 --allowedTools Grep Glob Read`
  - lines: three `system`, two `assistant`, one each of `rate_limit_event`,
    `user` and `result`

- **The live log's open-tool rows, rendered in isolation, 2026-09-11**:
  `renderToStaticMarkup` with the built CSS at 1280 and 390, both skins; the
  `sticky bottom-0` rows sit flush in both scroll states, jump-to-live paints
  over them, and 390px has no sideways scroll.

- **Every flag `buildArgs` and `sessionAgentArgs` emit is in `claude --help` on
  2.1.260**, checked before the 2026-09-04 bump, so a run will at least start.

- **Every flag `buildArgs` and `sessionAgentArgs` emit is in the 2.1.280 binary,
  2026-09-24**, checked before that day's bump from 2.1.260. Sixteen flags
  grepped out of `@anthropic-ai/claude-code-linux-arm64@2.1.280`'s own strings
  rather than out of `claude --help` — `--add-dir`, `--agent`, `--agents`,
  `--allowedTools`, `--append-system-prompt`, `--disallowedTools`,
  `--forward-subagent-text`, `--max-budget-usd`, `--mcp-config`, `--model`,
  `--output-format`, `--permission-mode`, `--plugin-dir`, `--resume`,
  `--settings`, `--verbose`, every one present. So a run will at least start,
  an unknown flag being the one failure here that is loud.
  `cycleInvocation.ts:1525`'s `--output-last-message` matches **zero** bytes of
  2.1.280 — but zero of the installed 2.1.260 as well, both greps run the same
  afternoon against the two binaries side by side, so that is how the binary
  stores the literal and not a flag that went away.

- **The failed `tool_result` shape comes from real CLI 2.1.226 transcripts.**
  Both the string and the array-of-blocks `content` carry `is_error: true`.

- **The `<synthetic>` refusal marker**, from a real record on this machine;
  the only refusal seen here is `Not logged in · Please run /login`.

- **`Connection closed mid-response`, seen in a real run** (then filed
  `failed`); one of five `isTransientApiError` sentences from the binary.

- **A new run takes a parked run's folder straight away**, reproduced against
  the live container.

- **The refusals around resuming a finished run** (an exhausted cycle or spend
  limit, a taken checkout), checked against the live container.

- **The column a follow-up pick-up reads is written end to end**, against a
  stub CLI printing the two `stream-json` events the loop reads.

- **`Grep`/`Glob` on `--allowedTools` restore both tools, on four `system:init`
  events.** Two with only those names (throwaway container; real image, live
  container), one with two `Bash(git …:*)` grants in front, one also under
  `--permission-mode plan`. None was a spawn from this app; `SEARCH_TOOLS` on
  every spawn's argv is unit-tested only.

- **The `needs-review` matcher, precedence, prompt composition, loop stop and
  edge semantics are unit-tested.**

## Not yet verified by hand

- **What `--allowedTools Grep Glob` does to a real work cycle is unmeasured.**

- **No real validation, review or conflict resolution has run since assists
  began streaming (2026-09-09)**, so `logAssistTools`' rows and the `check ›`
  prefix are unexercised.

- **The live log's open-tool rows have never met a real `tool_progress`
  frame**: arrival, the 30-second restatement and clearing on `tool_result`
  are untested, and the `aria-live` line was never listened to.

- **Never a real Home Assistant, ntfy topic or other operator receiver.** The
  `docs/install.md` automation was never loaded, so `trigger.json.*`,
  `allowed_methods` and `local_only` are unconfirmed. Only `completed` has come
  from a real run; the other endings' events were constructed. No run has gone
  all the way to Discord, and the mention and one 429 retry are unexercised.

- **The audit trail has not been read off a running install.** The five
  creation paths and the request wrapper pass under `npm test` only, and no run
  page has shown its origin line. Settle with `SELECT origin, count(*) FROM
  runs GROUP BY origin;` and the last 20 `request_log` rows on a real database.

- **No install-wide control has met a live child or a browser.** `stopFleet`
  and the hold are unit-tested, but no real `claude` was signalled (the test
  answers `cancelled`, not `signalled`) and the Fleet card never rendered.
  Settle: **Stop everything** on two or three cheap runs, then **Hold new
  work** and **Resume new work**.

- **Setting a run aside has never been done in a browser or on a live
  child.** `fleet.test.ts` drives all three doors; the mark-then-signal order
  has only been read. Settle: **Stop and set aside** a cheap run, check the
  Fleet count and restart notice exclude it, then **Resume** it.

- **The work-cycle deadline has never met a real hanging `claude`.**
  `cycleDeadline.test.ts` pins the mechanism on a silent child. Unknown: does
  `SIGINT` reap a hung `claude` and keep its `result` event, or only `SIGKILL`
  eight seconds later; the 120-minute default is reasoned. Settle with a
  `sleep 100000` task under a five-minute **Silent cycle limit**.

- **No live `stream-json` failure has reached the run page.** A forwarded
  message's `parent_tool_use_id` is still assumed, and no `tool_error` row has
  rendered. Settle: a run whose `git push` fails should log one danger row, a
  clean run none.

- **"The agent's own report" was never compiled, tested or rendered.** Its run
  had no `npm` and no `gh`: `cycles.ts`, `Markdown.tsx`, `RunOutput.tsx` and
  their tests were read by hand only, and the issue it follows was never read.
  Run typecheck, test and build and open a finished run first.

- **Whether `claude -p` flushes its `result` event on `SIGINT`.** If so, an
  interrupted cycle keeps its measured cost; reconciliation becomes a fallback.

- **What a subscription-limit refusal actually says.** `isUsageLimit()`'s
  wording is from the binary's strings, never seen on the wire.

- **Whether a refusal ever arrives on stderr alone** rather than as a
  `<synthetic>` turn. `refusalInStderr` covers that case but has never fired.

- **What a dropped stream does to the cycle around it.** Which path that run
  took, and whether `--resume` accepts a drop-truncated session, is unwatched.

- **Whether `claude --resume` accepts a session truncated by a mid-turn
  kill.** The ladder retries once, then stops rather than start fresh.

- **Which session id `claude -p --resume <id>` reports back.** A differing id
  is adopted and logged; no real resume has been watched.

- **Whether a session id from an `init` event killed seconds later is
  resumable.** It is persisted, relying on the first user turn being flushed.

- **A run parking and resuming across a real 5-hour boundary**, in the same
  worktree, on the same branch, with its commits intact.

- **A paused run surviving `docker compose restart`**, and a stale one being
  closed out once past `resumeGraceHours`.

- **A parked run taking its folder back** within a sweep of the run that took
  it finishing, and staying parked until then.

- **Resuming a finished run into a real agent**: `--resume` picking the
  session up, an isolated one back in its own checkout on its own branch.

- **Picking a `completed` run back up with a follow-up, through a real
  `claude`**: the note as the next turn, DONE pushback only after a real `DONE`.

- **A run a real `docker compose stop` cut off mid-cycle, picked up
  (2026-09-27).** `shutdown.test.ts` pins `restart_cut_cycle` against a stubbed
  child only; no container has been stopped with a real cycle in flight.
  Settle: `docker compose stop usagefoundry` mid-tool-call, then `SELECT id,
  status, restart_cut_cycle FROM runs WHERE restart_closed = 1` should read
  `stopped`, 1; pick it up with no note and its next `iteration` event's
  `prompt` should begin "Your last work cycle did not finish".

- **`detached: true`**: that Ctrl-C during `npm run dev` still kills the agent
  (via `instrumentation.ts`) and any long command it started.

- **The in-flight cycle line on a real run.** `fmtCycleInFlight` is unit
  tested; no run started through a server has been watched.

- **`SEARCH_TOOLS` on a real spawn from this app is unwatched.** Unknown:
  whether the mixed list still grants its two git commands, whether the tools
  appear in a `bypassPermissions` chat turn, and whether `--resume` keeps them
  at cycle 2. Check: `Grep` in the latest `system:init` payload in `run_events`.

- **Whether a real agent says `NEEDS_REVIEW` when it should, and only then.**
  Reasoned from `COMPLETION_NOTICE`'s precedent (251 runs), not measured.
  Under-use burns the cycle cap; cheap use turns completions into questions
  for a person. A task quoting the token ending in one cycle is unmeasured too.

- **No `claude` child has reported `NEEDS_REVIEW` to this app.** Unrendered:
  the amber badge and glyph, the **Needs review** filter, the reason under the
  state card, the warn log line. Unexercised on a database: freeing the folder,
  continuing the branch, Resume, the bulk pick-ups, Land/Delete/Purge. No
  `docker compose up --build` has been run against it.
