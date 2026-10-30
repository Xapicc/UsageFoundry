# Option D: a tiered supervisor, where a tool-less model answers what it can inside the call and hands the rest to the operator

## 1. Its strongest case

This is the operator's idea built as safely as this install allows. A run that is
stuck on something a document already settles gets the document's answer in
seconds, inside the cycle it is in, without a person. Anything that is the
operator's goes to the operator by the route they already read. The literature is
not against it:

- *Ask or Assume (Edwards and Schuster 2026)* (vault, `confidence: medium`,
  `status: growing`) found that an agent able to ask recovered almost all of the
  16 points that underspecification cost: 54.80% → 70.40%, against 70.80% fully
  specified.
- *UnderSpecBench (Ji et al 2026)* (`confidence: medium`, `status: growing`)
  found that agents faced with a vague instruction "guess", at 55.8–67.8% of runs
  crossing a boundary.
- *Orchestration Topologies* (`confidence: medium`, `status: growing`): "centralized
  verification" is the variable that separates topologies that help from ones
  that propagate errors.

A supervisor is a centralised check that runs **before** the guess.

## 2. Shape

**A run tool, `ask_supervisor`**, with a `question` (≤ 2,000 characters, the
chat's cap) and a `kind`: `fact`, `error`, `task`, or `decision`.

**Tier 0: the server, before any model.**

- `decision`, and any question that matches C2's escalation list by keyword
  (budget, limit, permission, isolation, push, land, fetch, `operatorOnly`,
  delete, force), gets a fixed reply. The run is told to write what it needs into
  its report and end with `NEEDS_REVIEW`, which [B](04-option-b-answer-the-ending.md)
  makes answerable. This keeps a single route to the operator.
- A question past the run's bound is refused the same way. The bound is
  `MAX_SUPERVISOR_QUESTIONS_PER_RUN` = 5 on a never-reset column.

**Tier 1: a tool-less model, handed what the server selects.** The shape is the
vault pointer's gate (`docs/agent/run-lifecycle/vault-pointer.md:23`):
`claude -p --tools "" --setting-sources "" --strict-mcp-config --disable-slash-commands`,
as the agents' uid, a small model, `--max-budget-usd 0.10`, and a 45-second
clock. The clock sits under the 60 s the pinned CLI gives a plain-JSON MCP reply
([`02-what-already-asks.md`](02-what-already-asks.md) §7), so D needs no change to
the route's transport. Its prompt is composed by the server from:

1. the question, framed as untrusted input in `validation.ts`'s words
   (`src/lib/validation.ts:362`-`:367`);
2. the run's task text and the brief of the task it holds;
3. for an `origin: chat` run, **the operator's own messages** in the proposing
   conversation, read from the chat's message rows with no resume
   ([E](07-option-e-the-spawner-answers.md)'s part);
4. the repository's `CLAUDE.md`;
5. for `error`, the matching signatures from `list_recurring_failures`, a tool
   runs do not have today (`src/app/api/mcp/route.ts:516`, `:1928`), and the
   vault notes Dreaming wrote about them.

Nothing from any other run's questions or answers is ever in it. That is C6 rule
1, and it removes the hub.

It answers JSON: `{answer, sources[], escalate}`. `escalate` routes to Tier 0's
reply. The tool returns the answer with its sources, or the escalation sentence.

**Rows.** `run_supervisions` records the question, kind, tier, answer, sources,
escalated, cost and duration, on the run's horizon. The run page draws them. The
tool result is not in `run_events` ([`01-constraints.md`](01-constraints.md) C4),
so these rows are owed.

## 3. The forks

| Fork | Where D stands |
|---|---|
| **Who** | Tier 0: the server. Tier 1: a new least-privileged model with no tools. Tier 2: the operator, through `NEEDS_REVIEW` |
| **Transport, and when** | **A blocking tool call.** The answer lands in the live turn as the tool result. Measured: the pinned CLI waits 60 s for a plain-JSON reply, and heartbeats stdout every 30 s meanwhile ([`02-what-already-asks.md`](02-what-already-asks.md) §7). The 45-second clock sits under that. A slower tier would need a `timeout` on the run's server entry in `writeMcpConfig` |
| **Folder claim** | Held. The run is mid-cycle |
| **`maxDurationMinutes`** | The wait is worked minutes. Only a park writes `paused_at`. At most 5 × 45 s per run |
| **`maxIterations`** | Untouched. No park, no refund, no wake |
| **`reconcileOnBoot`** | A restart kills the cycle and the call with it (`failed`, `restart_closed`). The row records the question with no answer, and the run page says so |
| **Authority** | C2's left column for Tier 1. Tier 0 matches the right column before a model sees the question. The model is told the line too, but nothing depends on it obeying, because it has no tool that could cross it |
| **Spend with nobody present** | ≤ $0.10 a call and ≤ 5 calls a run, on the per-call flag and the row's count. The call is refused if `assistRefusal`'s install and window checks refuse (`src/lib/review.ts:767`-`:781`). Recorded on its own rows and **added to `installSpend`**, a sixth place it reads, so the daily limit binds it. It has its own concurrency bound, as the vault gate has `GATE_CONCURRENCY` = 2 (`src/lib/vaultPointer.ts:614`), so a supervisor can never take the operator's chat slot |
| **Injection** | Upward: the question can make Tier 1 *say* anything, and nothing more. Downward: the answer arrives as a tool result labelled with its sources. Across: none, because each call is stateless. The residual risk is a persuasive wrong answer, which is what sources are for |
| **What the operator sees** | Every question and answer on the run page, its cost in the run's spend breakdown, and a count on the runs list. Nothing notifies, because nothing waits. In the morning: escalations are `needs-review` endings, as in B |
| **Providers** | Codex gets the tool through the same token, and its client waits 300 s by default, well over the 45-second clock ([`02-what-already-asks.md`](02-what-already-asks.md) §7). A local run carries the tool's full schema on every request (`docs/agent/local-provider.md:9`) |
| **Too much, too little** | The tool would be deferred and found rarely ([`02-what-already-asks.md`](02-what-already-asks.md) §3) unless the cycle's notices name it, which costs prefix on every run. Named, the Ask-or-Assume arm "asked once" on nearly every task. Floor and kill criterion: [`13-validation.md`](13-validation.md) §4 |

## 4. What it costs

- **Build.** Three to four days:
  - a tool;
  - Tier 0's matcher;
  - a composer;
  - a sixth child kind that has to be argued against
    `docs/agent/architecture/run-loop-and-child-processes.md:7`;
  - a table, an `installSpend` term, a page section;
  - tests for the matcher and the composer, which are pure and fail silently.
- **Per question.** A tool-less small-model call over a few thousand tokens. The
  vault gate's comparable call costs "about $0.002 a run"
  (`docs/agent/run-lifecycle/vault-pointer.md:25`). A composer that includes
  `CLAUDE.md` and a conversation is larger. Assumed under $0.05, not measured.
- **Standing.** A deferred tool's name in every run, and its schema on every local
  request.

## 5. What it would have answered

On the measured month ([`00-problem.md`](00-problem.md) §2):

- **3 questions**: runs that tried to write a memory note with a shell redirect.
- **One half-question**: why the board's close check read an empty diff when the
  fix was already on main (`5e95e960`).
- **Zero** of the 13 decisions, the 60 physical hand-offs, the 18 stale briefs the
  runs settled by reading, or the 22 `tsc: not found` they fixed in one message.

The 16-point recovery in *Ask or Assume* was bought with a simulated user who
"answers optimally" and holds the missing specification. Tier 1 holds no
specification the run cannot read, except the operator's chat turns, and no
measured question needed those.

## 6. What would have to be true

That runs on this install meet questions a document answers and the run did not
find, often enough to beat a deferred tool's near-silence and a fourth way to
reach the operator. It was not true in October: 3 in 494 runs, all one filesystem
rule.

## Verdict

**Not recommended now, and the shape to build if the overturning fact arrives.**
It is the only option whose design meets C1, C2 and C6 with a model on the other
end: tool-less, stateless, server-gated, inside a call that wakes nothing. On the
measured traffic it would have spent three to four days of build to say three
things. [`11-recommendation.md`](11-recommendation.md) names the measurement that
would change that.
