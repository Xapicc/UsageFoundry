# Option G: deliver the answer into the live turn through the CLI's stdin

## 1. Its strongest case

It is the only transport in which an answer reaches a cycle **without the cycle
having asked for it at that moment**. The run asks with a non-blocking tool
(`ask` returns "recorded; carry on with what you can"), keeps working, and the
answer arrives inside the same turn when it is ready. The answer can come from
the operator typing on the run page or from a model. Nothing parks, nothing is
refunded, and the run's context is never cold. The pinned CLI supports it:
[`02-what-already-asks.md`](02-what-already-asks.md) §7, Fact 2, measured a
second stdin message folded into the running turn as "The user sent a new message
while you were working".

It is also the closest thing to what the operator saw in Claude Code. An
interactive session takes a message typed mid-turn the same way.

## 2. Shape

Every cycle is spawned with stdin piped instead of `"ignore"`
(`src/lib/orchestrator.ts:8527`), and `--input-format stream-json` and
`--replay-user-messages` are added to the argv.

- The first prompt moves from the argv's `-- <prompt>`
  (`src/lib/cycleInvocation.ts:1150`-`:1152`) to the first stdin line, because a
  positional prompt is ignored under this input format (measured, `posprompt`).
- An answer is written to the live child's stdin as a user message.
- The cycle ends when the app closes stdin. The obvious moment is the first
  `result` frame, because the process otherwise stays alive with stdin open.
- Each `result`'s `total_cost_usd` is cumulative, so the parser keeps the
  **last** one rather than summing.

## 3. The forks

| Fork | Where G stands |
|---|---|
| **Who** | The operator from the run page, or a model. G is a transport and works for either |
| **Transport, and when** | Non-blocking ask, and the answer is folded in at the **next model request after it arrives**. If the run is blocked in a tool, the answer waits for that tool. If the run has already produced its `result`, the answer is either dropped or starts **another turn** (measured, `midstream`: a second `result`) |
| **Folder claim** | Held. The cycle is live |
| **`maxDurationMinutes`** | Worked minutes, unchanged |
| **`maxIterations`** | Unchanged for an answer folded into the running turn. **An answer arriving after the `result` that is let through is an extra turn in the same cycle**, which `maxIterations` does not count and `--max-turns` counts per message. That is exactly CrossSessionCommunication's C3 failure for the CLI inbox, rebuilt by this app: a message that makes a cycle last longer than it would have |
| **`reconcileOnBoot`** | A restart kills the child, and an answer not yet written is lost unless it is also a row |
| **Authority** | The transport carries text with **the operator's voice**: the CLI frames it as "The user sent a new message". A model's answer delivered this way is a model speaking as the operator, which C2 and C6 rule 4 forbid. Only the operator may use it |
| **Spend** | No new spend for the operator's own words. A model answering through it is D's spend |
| **Injection** | The highest authority framing this app could give any text, inside the turn. Acceptable for the operator's own typing; not for anything a model wrote |
| **What the operator sees** | The replayed frame (`isReplay:true`) in the run log, if `--replay-user-messages` is passed, which it is not today |
| **Providers** | Claude only. Codex's `exec` has no input format, and whether `codex queue` reaches it is not established (§7). A local run is a Claude child and would carry it |
| **Too much, too little** | Nothing bounds how often the operator types into a live turn |

## 4. What it costs

Everything about how a cycle is spawned, metered and ended changes at once:

- the spawn's stdio;
- where the prompt goes on the argv, which every adapter test pins;
- the parser's cost arithmetic, which is load-bearing for every spending guard;
- what ends a cycle, which every interrupt and the silence watchdog assume is the
  child exiting by itself.

The heartbeat measurement shows the CLI keeps printing while a tool waits, but
nothing was measured about a cycle whose child never exits because stdin was
left open by a bug. **That is a cycle with no end**, which no guard in this app
was written for.

## 5. What it buys over the alternatives

- **For a model's answer, nothing.** A blocking tool call ([D](06-option-d-tiered-supervisor.md))
  lands the answer at the same point, the next model request after the call, with
  the tool-result framing C6 wants, a log row the app writes, and no change to
  the cycle model. G's one advantage, that the run keeps working while it waits,
  is worth a 45-second wait only if questions are frequent, and they are not.
- **For the operator's answer**, the right comparison is [B](04-option-b-answer-the-ending.md)
  and [C](05-option-c-ask-and-park.md). G would let an operator who happens to be
  watching answer within the turn. Every measured question needing the operator
  was raised by a run that had finished its work and was ending: a Mac check, a
  deployment decision. There was no live turn left for the answer to steer.

## Verdict

**Rejected as the channel for answers.** It cannot release a blocked call. It
frames whatever it carries as the operator. And it changes the cycle model in the
four places every spending guard rests on. Separately, an operator who wants to
**steer** a live run ("stop touching the migrations") is a real feature, and G is
how it would be built. That is outside this survey's question, which is about the
run asking. It is not filed, because nothing measured here shows the operator
wants it.
