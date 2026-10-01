# Option D: allow Claude Code's native session messaging, and log it

## 1. Its strongest case

It exists, it costs nothing to build, and it is the vendor's design. Anthropic
gave it a permission-parity model, an inbound setting (`crossSessionInbound`:
`accept`, `hold`, `refuse`) and a cross-machine approval switch
(`isolatePeerMachines`). The tool description is 4,259 characters of
instructions on how to use it well. Messages land "at the receiver's next tool
round", which is mid-cycle: sooner than any app-built option can deliver, since
those wait for a tool call the receiver chooses to make.
[`02-what-already-talks.md`](02-what-already-talks.md) §1 has the evidence. All
that is missing is that this app does not see it, and logging fixes that.

## 2. Shape

- Keep `ListAgents` and `SendMessage` on every cycle.
- Pass `--replay-user-messages`, so the receiving cycle's `stream-json` echoes
  the injected turn, and store that echo as a new `run_events` kind.
  `--replay-user-messages` is assumed to cover peer messages, which is U1.
- Set `crossSessionInbound` per run through `--settings`. That has to go through
  the one settings composer, never a second `--settings` flag
  (`proposals/ContinuousImprovement/01-constraints.md:50`-`:60`).
- Scope delivery to the project. The CLI cannot: discovery is every record in
  `~/.claude/sessions/` whose socket connects. The only lever is a per-repository
  `XDG_RUNTIME_DIR`, which moves the socket. But the record names the socket's
  path, and every run has the same uid and the same `/tmp`, so a run on another
  repository can still connect to it. **Scoping is not achievable from outside
  the CLI.**

## 3. When a message is read

At the receiver's next tool round, pushed. The receiver did not ask, and it
cannot decline below the setting. A message pending when the turn ends makes the
print loop take another turn. This was read from the binary and not run (U1).

## 4. Metering and guards

**It fails C3 by construction.** A message can make a live cycle longer by a
turn. That turn is bounded by `--max-budget-usd` (`src/lib/cycleInvocation.ts:1347`)
and the silence deadline, but it is spend that exists only because another agent
sent text.

**It fails C4 by construction.** `plan`, `default` and `acceptEdits` share the
"prompting" parity class, so a read-only run's message is accepted by a writing
run. Holding cross-class messages does not help a headless host: "every parity
hold ends this way", `expired`.

## 5. Restart

Nothing survives, and nothing is queued for an ended session. The app's own
record would survive only if the logging half were built.

## 6. What the operator sees

Today the sender's clipped `tool` event, and probably nothing on the receiver.
With the logging half, both sides. But only on the two runs' own logs: there is
no view of "every message on this repository" without building one.

## 7. Isolation and injection

- **Reach.** The whole container: every run on every repository, every assist,
  and any interactive session in the container. 23 of 39 measured listings
  included a session on another repository or one that was not a run.
- **Topology.** Peer to peer and forwardable.
- **Authorship.** The receiver gets `from="<session name>"`. Any process that can
  write the socket can send, and every cycle's Bash child cannot (the sandbox
  refuses `AF_UNIX`). The `claude` process itself, and any MCP server it runs,
  can.

It is *Prompt Infection*'s setting, under a vendor's name.

## 8. Cost to build

Logging: about a day, plus the U1 experiment. Scoping: not available at any
price from this side.

## 9. What would have to be true

Runs would have to need mid-cycle delivery, and the CLI would have to scope by
project. Neither holds. Zero peer messages have been sent in the corpus, and the
scope is the container.

## Verdict

**Rejected, and the channel should be closed rather than left as it is.** It is
the only option that fails C3 and C4 by construction, and the only one whose
reach the app cannot narrow. Closing it costs one environment variable on the
spawn env. `CLAUDE_CODE_HARBOR_KITE=0` removes `ListAgents`, refuses peer
addresses in `SendMessage` and never opens the inbox, while keeping
`SendMessage` for the run's own sub-agents, which is every measured use of it
(Option G1).
