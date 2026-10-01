# Option A: change nothing, because the taskboard comment is already the channel

## 1. Its strongest case

The app already has a run-to-run channel that passes nearly every constraint in
[`01-constraints.md`](01-constraints.md), and it was designed for exactly this
job.

- `comment_on_task` is append-only and permanent.
- Authorship comes from the token, never from the text
  (`docs/agent/taskboard/comments.md:22`-`:30`).
- It reaches the holder of a task whole, at that run's next `list_my_tasks`
  (`docs/agent/taskboard/comments.md:72`-`:78`).
- It deliberately never rides the appended prompt
  (`docs/agent/taskboard/comments.md:63`-`:69`), so it costs no prefix and gives
  a sibling's text no system authority.
- It starts nothing (`src/app/api/mcp/route.ts:631`), and it survives a restart
  because it is a row.
- The doc's own example of why the tool exists is a cross-run note: "I have
  just changed the thing this task is about" is a note about a task the run does
  not hold (`docs/agent/taskboard/comments.md:92`-`:94`).

Add the measurement. No contradiction between live siblings was found in 600
runs ([`00-problem.md`](00-problem.md) §3). The duplicates that were found came
from state the runs could not see, not from words they could not send. A survey
that finds no need for a new channel should say so and build nothing.

## 2. Shape

None. Everything in [`02-what-already-talks.md`](02-what-already-talks.md)
stays as it is, **including §1**: every work cycle keeps `ListAgents` and
`SendMessage` and a socket inbox reachable by every Claude session in the
container.

## 3. When a message is read

A board note is read when the receiving agent calls `list_my_tasks`, at any tool
round. Nothing reminds it to. `TASKBOARD_NOTICE` names `list_my_tasks` but not
`comment_on_task` or `get_my_task` (`src/lib/cycleInvocation.ts:993`-`:1005`). A
CLI peer message is drained at the receiver's next tool round, with no consent
asked of the receiver.

## 4. Metering and guards

A board note is clean on C3 and C4: it starts, wakes and extends nothing and
widens nothing. **The CLI channel fails both.** A pending peer message makes a
live cycle take another turn, and a `plan` run's message is accepted by an
`acceptEdits` sibling ([`02-what-already-talks.md`](02-what-already-talks.md) §1).

## 5. Restart

Board notes survive, as rows. CLI messages do not, and nothing is lost that
anybody recorded, because nothing records them.

## 6. What the operator sees

Every board note is on the task page, forever. A CLI peer message is in the
sender's `run_events` as a clipped `tool` input. On the receiver it is most
likely nowhere the app shows: assumed, U1.

## 7. Isolation and injection

The board carries model-written free text between runs today, in task bodies and
notes. Its mitigations are authorship, permanence and pull. The CLI channel has
none of the three, and its reach is every session in the container, across
repositories (C1). Under C8 that is the worst topology there is: peer to peer,
forwardable, nothing in the receiver's log, and the sender can be any run that
has read anything.

## 8. Cost to build

Zero.

## 9. What would have to be true

That the CLI channel stays unused. It has been used zero times for a peer
message in 21 `SendMessage` calls (`python3 scripts/peer_usage.py`), and that is
the only evidence there is. It would also have to be true that no injected text
ever tells a run to use it. Nothing on this install can tell those two apart in
advance, because the first sign of the second is a message the receiver's log
probably does not carry.

## Verdict

**Rejected as stated, and its first half kept.** The board half of "change
nothing" is the right answer to the question the brief asks, and the
recommendation keeps it. The CLI half cannot stand. "Nothing" here means leaving
open a channel the app never chose, which no run has needed and which fails C3,
C4, C5 and C8 together. Option G is Option A with that half closed and the
board's measured blind spot repaired.
