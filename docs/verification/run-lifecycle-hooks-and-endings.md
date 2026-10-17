# Verification: Run lifecycle — hooks, a cycle's prompt, the prior-read pointer and how a run ended

[← Verification index](../verification.md)

What a cycle reports about the hooks that ran in it (`--include-hook-events`,
`hookInjection` and the storage filter in `handleStreamLine`), the prompt fold
on a work cycle's log row, the prior-read pointer and its holdout
(`priorReads.ts`), and `runs.ending_code`. Opened on 2026-10-17 with
Phase 0 and Phase 2 of `proposals/ContinuousImprovement/`, because
[run-lifecycle.md](run-lifecycle.md) had no room.

## Verified

- **What `--include-hook-events` adds, CLI 2.1.280 against a stub API,
  2026-10-17, $0.00.** `claude -p --output-format stream-json --verbose`
  under `env -i` with a scratch `HOME` and `CLAUDE_CONFIG_DIR` and
  `ANTHROPIC_BASE_URL` on a loopback server answering three `Read` calls and
  then `DONE`. Without the flag: one `hook_started` and one `hook_response`,
  both `SessionStart`, and none for the `UserPromptSubmit`, `PreToolUse` and
  `PostToolUse` hooks that ran. With it: one of each per hook per firing, for
  every event, `Stop` included; no `hook_progress` from hooks this short.
  `stdout` and `stderr` are each the hook's own stream, and `output` is both
  together in arrival order. Logged per request, what reached the model: a
  JSON `hookSpecificOutput.additionalContext` from `PreToolUse` and from
  `PostToolUse`, plain stdout from `SessionStart` and `UserPromptSubmit`, and
  **not** a `PostToolUse` hook's plain stdout, any hook's stderr, or the
  stdout of a `SessionStart` hook that exited 1 (`outcome: "error"`). A JSON
  reply with stderr beside it still injected, which a reader of `output`
  would have missed.
  Under this container's own `settings.json` hooks (whose `winnow` binary is
  absent, so they print nothing but the `SessionStart` line) the same cycle went
  from 11 stdout lines to 19.

- **What that would have cost unfiltered, 2026-10-17.** Over the 486
  main-thread transcripts under `~/.claude/projects` for this repository's
  worktrees: a median of 52 tool calls per session, 28,971 calls against 5,810
  text blocks in all. This install's catch-all `PostToolUse` hook therefore
  adds two rows per call, about 2.7 times a cycle's current `run_events` rows,
  every one of them a `system:` row the feed does not draw. Caveat: a count of
  transcript blocks standing in for stored rows; `/data` is not readable here.

- **The flag, the filter, the injection line, the prompt fold and
  `ending_code` through the real run loop, 2026-10-17.** The built standalone
  server over a scratch `DATA_DIR`, `CLAUDE_BIN` a wrapper exec'ing the real
  2.1.280 at the stub API above, scratch hooks of four kinds: a `SessionStart`
  echo, a silent `PreToolUse`, a `PostToolUse` replying `additionalContext`
  with a warning on stderr, and a silent `PostToolUse`. One run through `POST /api/runs`: the argv carried
  `--include-hook-events`; the run ended `completed` with
  `ending_code = 'done'` on the row, the run DTO and the list DTO. Its
  `run_events` held one `hook_response` for `SessionStart` and three for the
  injecting `PostToolUse`, where the CLI wrote twenty hook lines, and four
  "… hook added this to the agent's context" lines, all drawn on the run page.
  In Chromium at 1280 the cycle row offered a "Prompt" fold holding the 682
  characters the cycle was sent, under the cycle's label; the state block read
  "Ending: reported the task complete" and `/runs` "reported the task
  complete" under the status. With every `ending_code` in the answers rewritten
  to null at 390 px, they read "Ending: unknown" and "ending unknown". No
  console error. The warning was in each stored row's `output` and in no
  logged line, measured at `4388e6dc`, where the line is read off `stdout`.
  `npm run smoke-pages` against that build: 100 of 100 page loads clean,
  serving `.next/standalone/server.js`.

- **The prior-read pointer through the real run loop, 2026-10-17, branch
  `uf/usagefoundry-721638d11c0b-22`, stub child, $0.00.** A scratch script
  built a real git repository under a scratch `DATA_DIR`, seeded two earlier
  runs' `tool` events, and drove `createRun` and `startRun` with
  `child_process.spawn` stubbed for the work cycle only. The seeded reads were:
  `src/a.ts` twice and `src/b.ts` once in the older run, and `src/b.ts` once in
  the newer. The rest were each a case to drop: a read of a deleted file, a
  symlink to `/etc/hostname`, a `../outside.txt`, a sub-agent's read and
  `/tmp/scratch.txt`. Three runs went through isolated checkouts. Both
  pointer-arm runs' first prompts carried the block directly after the
  checkout notice and before the task, naming `src/b.ts (2 runs)` then
  `src/a.ts (1 run)` and nothing else (1.9 against 1.8 at ×0.9). The holdout
  run's prompt went straight from the checkout notice to the task. Each
  `iteration` event recorded `priorReads: { arm, paths: 2 }`, and every arm
  matched `inHoldout(id)`. Caveat: a stub reads only the argv, so this proves
  what the CLI was handed and nothing about what an agent does with it.

- **The pointer on the run page, standalone build, 2026-10-17, seeded state.**
  The two runs above, served by `.next/standalone/server.js` over their
  scratch `DATA_DIR` and opened in Chromium at 1280 and 390px. The pointer
  run's *Prompt* fold drew the block between the checkout notice and the
  task, its two paths indented on lines of their own. The holdout run's
  cycle row read "files earlier runs read held back, for the holdout", and
  its fold went from the checkout notice to the task. No console error at
  either width. `npm run smoke-pages` against the same build (`fb9c8617`):
  100 of 100 page loads clean, serving `.next/standalone/server.js`.

- **`priorReads.test.ts`, 14 cases, and the slot case in `orchestrator.test.ts`,
  2026-10-17.** Mutations of the compiled module that reversed the decay,
  dropped the experiment name from the hash's preimage and removed the base
  check each failed (1, 2 and 1 cases).

## Not yet verified by hand

- **No billed cycle has run with the flag.** The stub API proves the shapes
  and the filter; what a real cycle with the operator's real hooks stores is
  inferred from tool-call counts. Settle on a logged-in host:
  `select json_extract(payload,'$.message'), count(*) from run_events where
  run_id = ? group by 1` on one ordinary run after this lands, against one
  before it.

- **A hook's deny, block and exit-2 reasons are kept but not read.** A
  `PreToolUse` deny's `permissionDecisionReason`, a `PostToolUse` block's
  `reason` and an exit-2 hook's stderr reach the agent by the CLI's docs, and
  their raw rows are stored, but `hookInjection` reads only `additionalContext`
  and plain text, so none of them gets a readable line, and none was driven.
  Settle with the stub-API recipe and one hook of each kind, logging which
  marker reaches `/v1/messages`.

- **A hook's stored row holds what it printed twice.** `output` repeats
  `stdout` and `stderr`, and `raw` is stored whole, so a chatty hook firing on
  every tool call costs that much per call. Unmeasured on any real hook.

- **`ending_code` has met the real CLI on one ending, `done`.** The others are
  pinned by the loop tests with a stubbed spawn, and the twenty pre-column rows
  `proposals/ContinuousImprovement/` counted have not been seen to render
  "ending unknown" on the install that holds them.

- **Whether naming the files changes what a run reads.** That is the
  holdout's question, and it cannot be read before about two weeks of runs
  have gone through both arms. `03-experiment-holdout.md` sizes it: 62.3%
  to 77.3% compliance needs 372 named-path pairs, about 8 days, and a halving
  of file-opens 115 runs a side, about 13 days. Its first reading is due
  around 2026-10-31. To settle it, join each `iteration` event's
  `$.priorReads.arm` with that run's later `tool` events, as
  `03-experiment-holdout.md`'s compliance query does. Do it before
  `eventRetentionDays` sweeps the first fortnight's logs.

- **The pointer has not met a billed cycle or the real CLI.** It rides the
  prompt after `--`, like every other notice, so nothing about the argv is
  new. But no real run has yet opened with it: the run pages above were
  seeded through a stub child.
