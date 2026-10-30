# Option F: turn the CLI's own messaging back on, so a run can reach the session that spawned it

## 1. Its strongest case

It is the feature the operator saw. Claude Code already has a channel in which a
session sends to another by name and the receiver takes the message at its next
tool round. It costs this app nothing to build: delete one key from four env
builders (`src/lib/orchestrator.ts:7816`, `src/lib/chat.ts:4771`,
`src/lib/review.ts:1473`, `src/lib/claudeAuth.ts:299`). And it is the CLI's own
code, maintained upstream, not this app's.

## 2. Who would be on the other end

**Nobody the operator means.** Reaching the spawner requires it to be a live
session with an inbox, and none is.

- A chat turn ends when it proposes, and approval is a separate press.
- A block's turn ends before its runs exist.
- The server that calls `createRun` is not a Claude session at all
  ([`02-what-already-asks.md`](02-what-already-asks.md) §6).

What *is* live while a run works, and reachable on this channel, is what
CrossSessionCommunication measured:

- every sibling run;
- every assist;
- interactive sessions in the container.

That is 23 of 39 `ListAgents` calls listing another live session, across
repositories (`proposals/CrossSessionCommunication/README.md`). The channel's
scope is "same config directory and same `/tmp`, same uid", not "my spawner".

So F does not deliver the vertical channel. It re-opens the horizontal one, and
the operator would be one more possible receiver only if an interactive `claude`
were running in the container when the run asked.

## 3. Meeting G1's reasons

G1 closed the channel for four constraint failures
(`proposals/CrossSessionCommunication/02-what-already-talks.md` §1). Each one, and
whether a supervisor use changes it:

| G1's reason | Does a vertical use change it? |
|---|---|
| **C1, scope:** the container, not the project | No. There is no per-recipient scope to set. `crossSessionInbound` is `accept` / `hold` / `refuse` for the receiver, not an allowlist of senders |
| **C3, extension:** a message arriving before a cycle exits makes it take another turn | No. A supervisor's answer is exactly such a message. It would be delivered by extending the cycle, which [`01-constraints.md`](01-constraints.md) C1 forbids, unless the answer arrives while the run is still inside its own turn, in which case a tool result is the simpler carrier |
| **C4, widening:** `plan` and `acceptEdits` accept from each other | Worse. A supervisor that can message runs can message any run in the container, and a run that can message its supervisor can message its siblings |
| **C5, logging:** the receiver's `stream-json` most likely carries no frame for the message without `--replay-user-messages` | No. The app would have to add that flag to see answers at all, and it would then see every peer message too |

The board task that closed it recorded the measurement: with
`CLAUDE_CODE_HARBOR_KITE=0`, `ListAgents` is gone and
"`[uds-messaging] Skipped: cross-session messaging gate off`" (board task
`dd0c0b1d`, comment of 2026-10-01). Nothing in this survey's question is served
by the gate being on that is not served better by a tool result the app writes
and logs.

## 4. The rest of the forks, briefly

- **Transport.** A queued prompt drained at the next tool round, or another turn
  at the turn's end. Unbounded by the app.
- **Authority, injection, visibility.** Unenforceable. The channel is free text,
  peer to peer, forwardable, and unlogged on the receiving side: C6's rules 1, 3,
  4 and 6 fail at once.
- **Spend.** The extra turn is billed to the receiver.
- **Providers.** Claude only. Codex and local runs are not on it.
- **Build.** None, which is its whole case.

## Verdict

**Rejected.** It has no spawner to reach, and what it reaches instead is the peer
channel G1 closed, for reasons a supervisor use leaves intact or makes worse. G1
stays as it is. The variable is set after the extras "so no caller can turn it
back on" (`src/lib/orchestrator.ts:7689`-`:7700`), and this survey adds no reason
to let one.
