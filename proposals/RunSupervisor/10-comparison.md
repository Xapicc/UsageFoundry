# 10: The options side by side

## The facts

| | Who answers | Transport | Wakes or extends a run (C1) | Widens a guard (C2) | Hub or upward injection (C6) | Logged where the operator pages (C4) | Measured traffic it serves | Build |
|---|---|---|---|---|---|---|---|---|
| **A** nothing | operator, on the board | ask-and-end; a fresh run acts | no | no | no; a person reads it | task notes, forever | all of it, to a cold run | 0 |
| **B** answer the ending | operator, on the run page | ask-and-end; pick-up of the same run | only the operator's press, refund ≤ 3 | no | no | reason + answer on the run page | the 4 decision-shaped `needs-review` endings, to the run that asked | ½–1 d |
| **C** ask and park | operator | park at the cycle end | only the operator's press, refund ≤ 3 | no | no | question rows | the same 4, keeping the slot | 2–3 d |
| **D** tiered supervisor | server, then a tool-less model, then operator via B | blocking call, < 60 s | no; the answer lands in a live call | no; Tier 0 gates by kind | stateless and tool-less: no hub, no act | `run_supervisions` rows | **3** memory-directory writes, and half of one close-check dispute | 3–4 d |
| **E** the spawner | a fork of the proposing chat | blocking call or park | as D | as D | the chat's context; tool-less | as D | **0**; and `origin: chat` runs only | 2–3 d after D |
| **F** native messaging | whoever is live in the container | CLI inbox | **yes**: another turn | **yes**: `plan` ↔ `acceptEdits` | **yes**: peer, forwardable | **no**: not on the receiver's stream | 0; there is no live spawner | ~0, unscopable |
| **G** live turn | operator, or a model posing as one | stdin, folded at the next request | **yes**, if an answer after `result` is let through | no | the highest framing the app could give | only with a new flag | 0 that a turn was still live for | 3–5 d, and the cycle model changes |

Sources for every cell are in the option's own file. The traffic column is
[`00-problem.md`](00-problem.md) §2. The transport column's limits are
[`02-what-already-asks.md`](02-what-already-asks.md) §7.

## Which constraints are vetoes

**C1, C2 and C6 are vetoes, not weights**, for the reason CrossSessionCommunication
gave for its own three (`proposals/CrossSessionCommunication/10-comparison.md`).
Each one fails silently. A run woken by a model looks like a run that resumed. A
guard widened by a persuasive question looks like an operator's setting. An
answer steered by another run's text looks like an answer. And nothing in the
code would show any of them.

- **F fails all three** and is out.
- **G fails C1** unless the app closes stdin at the first `result`. Even then it
  frames a model's text as the operator's, which is C6 rule 4, so a model may
  never use it. That leaves G as an operator-only transport, and every measured
  operator question was raised at the end of a run, with no live turn to deliver
  into.
- **A, B, C, D and E pass.** D and E pass only because their supervisor is
  tool-less, stateless and gated by the server. A supervisor with tools, or with
  memory across questions, would fail C6 and join F.

## What dominates what, on the evidence

- **B dominates C on the measured traffic.** They serve the same four questions.
  C's extras are the slot kept, a structured question, and a non-ending status.
  None of those was seen to matter, and C costs three to five times the build and
  a second way to reach a person beside the one runs already use.
- **D dominates E.** E's one input, the operator's words in the proposing chat, is
  available to D as plain message rows, without resuming the most privileged
  child's session. No measured question needed it.
- **B weakly dominates A**, by one day of build against the cold start of a fresh
  run on four decisions a month. That is a small margin, and B's premise that the
  operator would use the box is unmeasured. So A is the runner-up, not a
  distant third.
- **D does not dominate B, and B does not dominate D.** They serve disjoint
  traffic. On October's figures D serves three questions and B four, and only B's
  are questions anyone needed answered. D's three were answered more cheaply by a
  sentence where runs already read: the operator's own memory note says the
  directory is Write-tool only.

## What the brief's forks came to

| Fork | Settled as |
|---|---|
| Who is on the other end | The operator. A model has nothing measured to say. The chat's conversation reaches a run through the brief already, and a block is gone before its runs exist |
| Transport | Ask-and-end (B) now. A blocking call under 60 s if a model is ever added (D). Never the CLI inbox, never stdin for a model |
| Authority | [`01-constraints.md`](01-constraints.md) C2's table, enforced by the server by kind before a model sees the question. A request for a guard, a press, an `operatorOnly` task or scope always goes to the operator unweighed |
| Spending with nobody present | B and C spend nothing until a person presses. D: ≤ $0.10 a call, ≤ 5 a run, refused by `assistRefusal`, its own concurrency bound, and a term in `installSpend` |
| Injection both ways | Stateless and tool-less, or nothing. F and G fail it |
| What the operator sees | Both halves on the run page. Notify only what waits on a person: `needs-review` already does, C's park would join `NOTIFY_PARKS`, D never notifies. In the morning, the `needs-review` filter, every row of which is an unanswered question |
| Providers | A and B work for all three. D works for Codex (300 s client limit) and costs a local run its schema on every request. F and G are Claude only |
| Too much vs too little | A floor and a kill criterion for each, fixed in [`13-validation.md`](13-validation.md) before anything is built |
