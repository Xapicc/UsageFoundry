# External validator

**Question:** should a finished run get a second, adversarial reading — task text
against branch diff — that says *the work happened*, *it did not*, or *I cannot
tell*?

**State:** **shipped, in a shape this pitch recommends against.** `AssistKind`
is `"review" | "resolve" | "validate"`, `src/lib/validation.ts` is the module,
and `docs/agent/taskboard.md` carries its reasoning. Read that file before this
one if you are here to change the code; read this one for why the shape was
argued the other way.

Three differences, each of which this document names and declines:

- **The trigger is a run asking to close a task**, not every finished run. A
  task carries a brief written to be read by an agent with no other context and
  the close is an explicit claim, where `runs.prompt` is whatever somebody typed
  into a form. It reaches only runs with `taskboardForRuns` on, which is a
  narrower population than §15's decision 3 proposes.
- **The verdict acts.** §6 recommends notify-only and lists "reopen the run" as
  a failure mode: one billed cycle per false negative, systematically, at fleet
  scale. It is built anyway, bounded — `maxValidationCycles`, default 2, zero
  being this document's own recommendation expressed as a number — and every
  way of *not* getting a verdict closes the task, so the wrong answers that are
  free stay free.
- **§7's coupling rule was honoured rather than skipped.** The prompt's error
  preference was re-tuned in the same change that gave the verdict an action,
  because a wrong `not-finished` now costs a cycle. That means the shipped
  prompt is not the scored prompt: the 34-of-37 figure is inherited, and
  `docs/verification.md` says so by name.

What this document's §1 asks for first — carrying the `reported_done` split onto
the runs list and into the filter — is **still not done**, and is still hours of
work targeting the stratum that carries the whole measured defect.

Read in this order:

1. **[`validator-baseline.md`](validator-baseline.md)** — the measurement the
   pitch rests on: 40 labelled `completed` runs, how often one filed as
   `completed` did not carry out its task, and how many cannot be judged from the
   artefacts at all. It measures and proposes nothing. §3 carries a correction to
   two of its own labels.
2. **[`external-validator.md`](external-validator.md)** — the pitch: appetite,
   what a validator can see, where it attaches, kill criteria, and five decisions
   somebody has to answer.
3. **[`../../scripts/validator-spike/RESULT.md`](../../scripts/validator-spike/RESULT.md)**
   — what the offline harness returned when a model was actually asked. Where it
   and the two documents above disagree, it is the measurement.

Two things the spike settled that the pitch was written without: a model agrees
with the human labels **34 of 37** on the held-out set with **zero
false-finished**, at a median **$0.125** a verdict on an upper-bound transport;
and giving the validator the run's own final turn — decision 2's recommended
default — changed **zero of eight** verdicts on the stratum where the pitch
claimed it mattered.
