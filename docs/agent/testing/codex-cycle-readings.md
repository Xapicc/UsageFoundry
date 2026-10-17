# What a Codex cycle's stream and exit are read as

[← testing index](../testing.md)

Read before adding or editing `orchestrator.test.ts` cases for `handleCodexStreamLine`'s notices and agent messages or for `exitStopReason`. The parser's argv and tool-item cases are in [stream-parsers-and-webhook.md](stream-parsers-and-webhook.md).

The three decisions below are each a Codex cycle that did its work and was filed, or logged, as though it had not. Each is silent: nothing throws, the run page renders, and every case was written first and watched fail on the tree it was filed against (2026-10-17).

`handleCodexStreamLine`'s reconnect case feeds the sequence a flaky connection produces — a "Reconnecting… 1/5" `error`, an `agent_message` ending in `DONE`, an error item, `turn.completed`, and a late notice — and asserts that `apiError` is null, `sawResult` is true and the notices are still on the log. It earns its place because the run loop reads `apiError` as the cycle's refusal before it reads `DONE`, and `recovered` matches only Claude's wordings, so the unfixed parser ended a finished run `failed` with "Codex refused the request: Reconnecting… 1/5". Its control is the case beside it: an allowance sentence or a content refusal stays latched even on a completed turn, because a wall that exits 0 must still stop the run, and a fix that cleared everything on `turn.completed` would pass the first case while letting that through. The existing `turn.failed` case still pins the other direction — the real reason overwrites the notices — and is not weakened.
