# 11: Recommendation

## In one line

**Build no supervising model. Make the one question runs do ask, the
`NEEDS_REVIEW` ending, cheap to answer to the run that asked (Option B).**

## The case

1. **The need is small, and it is the operator's.** 494 runs in 27 days:
   - 74 handed something to the operator, of which 60 were physical (a Mac, a
     host shell, root) and 13 decisions;
   - **0** of those were anything a model could answer;
   - 7 ended `NEEDS_REVIEW`, 0 called `request_stack`, and 0 were picked up with
     a note ([`00-problem.md`](00-problem.md) §2).
2. **The model-answerable traffic is three questions, and they share one cause.**
   Runs tried to write a memory note with a shell redirect into a directory that
   only the Write tool can reach. A supervisor would have said what the operator's
   own memory note already says. Errors were otherwise solved by the runs in a
   median of one message, and task questions by reading.
3. **The safest supervisor this install could build (D) has nothing to say.** It
   would be tool-less, stateless, server-gated and inside a call that wakes
   nothing. *Ask or Assume*'s 16 points were recovered with a user who held the
   missing specification. No document here holds a specification a run cannot
   read, and the operator's chat words already reach the run as a 4,946-character
   median brief.
4. **What does cost something is answering a decision to a stranger.** A run that
   wrote five costed options and stopped is answered today by the operator
   filing or briefing a **fresh** run, which re-derives the reading. The pick-up
   route avoids that, and is unused. On a one-cycle run it cannot be taken without
   editing the run's budget first
   ([`02-what-already-asks.md`](02-what-already-asks.md) §1).
5. **B removes exactly that friction, with a mechanism already built and
   bounded.** An answer box on the reason, and the asking cycle refunded at most
   three times per run on a never-reset count. That is the stack park's terminus
   argument, applied to the ending runs already know. No model, no new status, no
   new tool. Every answer is a person's press, which is C1.

## The order

1. **Phase 1, B**, which is useful on its own
   ([`12-implementation-sketch.md`](12-implementation-sketch.md)).
2. **A readout**, so the falsifier below can be checked: a monthly count of
   `needs-review` endings, answers given through the box, and decision tasks
   filed. The SQL is in [`13-validation.md`](13-validation.md) §3, because a
   work cycle cannot read the database.
3. **Nothing else until a threshold in [`13-validation.md`](13-validation.md)
   fires.**

## Refused, by name

- **D, a tool-less tiered supervisor.** The right shape and the wrong month.
  Three to four days to say three things. Kept as the build if the overturning
  fact arrives.
- **C, a general ask-and-park.** The same four questions as B at three to five
  times the build, and a second way to reach a person beside the ending runs
  already use. Built if pick-ups start failing for a taken slot.
- **E, the spawner answers.** A block has ended before its runs exist. A chat
  fork's only input is the operator's words, which the brief already carries,
  and which D could read from message rows without resuming the chat.
- **F, native messaging.** There is no live spawner to reach, and it re-opens the
  peer channel G1 closed, failing all of G1's reasons.
- **G, live-turn delivery.** It cannot release a blocked call, it frames whatever
  it carries as the operator, and it changes the four things every spending guard
  rests on.

## What would overturn it

**Three or more questions in four weeks, after Phase 1 ships, that a read-only
model could have answered from something the asking run had not read.** They are
classified by [`scripts/rules.txt`](scripts/rules.txt), as in
[`00-problem.md`](00-problem.md), across `needs-review` reasons, answers given
through the box, and decision tasks runs file. And **two of them must be about
something other than one recurring cause** that a sentence in `CLAUDE.md` or a
notice would fix. That is the gap a supervisor fills and a document does not: a
fact that exists somewhere the run would not think to look.

If it fires, build D as specified in
[`06-option-d-tiered-supervisor.md`](06-option-d-tiered-supervisor.md), as Phase 3
of the sketch. Its escalation path is B, which will already exist.

## The runner-up

**Option A, build nothing.** It differs from B by a day of build and by whether a
decision reaches the run that asked or a fresh one. B rests on an unmeasured
premise, that the operator would use the box: zero pick-up notes in the window
means either the route was too dear or it is not how they work. If the box goes
unused for the first five decision-shaped endings after it ships, revert it, and A
is the answer ([`13-validation.md`](13-validation.md) §3).

## If the operator wants a supervisor anyway

Build D, exactly as its file specifies. That means:

- Tier 0 matching C2's escalation kinds in the server;
- a tool-less small model with a 45-second clock, under the 60 s the pinned CLI
  gives a plain-JSON reply;
- stateless, with nothing from another run in its context;
- `run_supervisions` rows on the run page;
- a term in `installSpend`;
- escalation into B.

Do not give it tools. Do not let it remember. Do not deliver its answers through
stdin or the CLI inbox. Those three lines are what keep it vertical, and they are
the line between this survey and CrossSessionCommunication.
