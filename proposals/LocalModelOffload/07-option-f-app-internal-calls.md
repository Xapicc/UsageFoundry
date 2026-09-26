# Option F — move specific app-internal calls to a local model

The app's own model calls, outside any run: the orchestrator chat, workflow
orchestrator blocks, review, task-completion validation, conflict resolution
([`00-problem.md`](00-problem.md) §2, items 4–8). Dreaming is a run (item 9)
and is Option D's question, not this one.

## Which calls could move, by task class

| Call | Task class | Local tier on the vault's evidence | Movable? |
|---|---|---|---|
| Chat turn (`src/lib/chat.ts:3077`) | conversation and planning, with tools, `bypassPermissions` | unmeasured; vault step 0 keeps "planning" on Claude | **no** |
| Orchestrator block (`src/lib/workflows.ts:5823`) | planning/classifying which runs to emit | as chat | **no** |
| Review (`src/lib/review.ts:816`) | reading and summarising a diff, `plan` mode, 60 KB cap (`src/lib/review.ts:65`) | **at parity or better** as a writer of summaries (Vectara, `vendor`) | in principle |
| Validation (`src/lib/validation.ts:567`) | a judge: does this diff do this task? | **worse as a judge** of summaries (same row of *Local Model Quality by Agent Task*) | **no** |
| Conflict resolution (`src/lib/land.ts:1582`) | editing | behind by 8+ points (EDIT-Bench, `peer-reviewed`) | **no** |

There are no title, summary, brief or report writers to move: the app generates
none with a model (the inventory found none), and the intake filter and winnow
make no model calls.

## Its strongest case

**Review is the one app-internal call whose task the local tier does as well
as Claude**, and it is tool-light: `plan` mode with `Grep`/`Glob`
(`src/lib/review.ts:269`), a capped diff. Of all the options it is the one where
the vault's best evidence and this app's code line up without a loop, a
permission question or a new MCP surface. It would also free the review from
the run's frontier model — today it runs at `--model run.model`
(`src/lib/review.ts:754`), i.e. Opus for an Opus run.

## The case against

- **The spend is tiny and fires on click.** App-internal calls outside runs are
  bounded per call ($2 a chat turn, $1 a validation) and rare; the chat's whole
  recorded spend is $60.63 at list price over 22 sessions ([`00-problem.md`](00-problem.md)
  §1). Review and validation children run in the run's checkout, so their
  transcripts are inside the worktree figures and could not be separated here;
  their share is **unmeasured**, and bounded above by what the chat's shows is
  plausible — small.
- **Review is where the operator's time is most expensive.** Its reader is the
  operator deciding whether to land. The vault's warning is that when "the
  check is a human reading the output, it dominates everything above" (*Local
  Offload Economics*). A review that is cheaper and wrong one time in twenty
  costs more than it saves.
- **The call shape does not match.** Review is a Claude Code child with tools;
  a local review would be a one-shot request over the diff (Option B's client),
  a different code path with a different failure surface, for a click.

## What it costs

~2 days for a local review behind a setting, reusing Option B's client —
cheaper if Option B exists.

## Verdict

**No**, on size. If Option B's client is ever built, a local "summarise this
diff" on the run page is a small add-on worth offering as a *second* reading
beside the Claude review, never instead of it.
