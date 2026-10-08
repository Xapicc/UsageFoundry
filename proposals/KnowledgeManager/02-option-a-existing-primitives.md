# Option A — no new code: a Haiku template, a one-block workflow, a schedule

## What it is in this app

Everything the operator can do from the UI today:

1. Switch `claude-haiku-5-5` on in Settings' model catalogue — it ships off
   (`src/lib/modelCatalogue.ts:163`–`:168`), and only after U1 says the pinned
   CLI runs it.
2. Save a template, "Knowledge Manager": mount `knowledgebase`, folder the vault
   root, *This folder* (isolation is unavailable anyway, C1), permission mode
   `bypassPermissions`, model `claude-haiku-5-5`, `maxRunCostUSD` $0.50,
   `maxIterations` 1, `maxDurationMinutes` 20 — one cycle, because a second
   resumes the first's whole context and crosses the price cliff (08 §3). A
   template carries all of these (`src/lib/templates.ts:69`–`:71`, model at
   `src/lib/templates.ts:98`–`:116`),
   and the template is the reliable place to pin a model: run beats template
   beats `defaultModel`, and an agent's model only fills a gap
   (`src/lib/templates.ts:47`–`:50`). `bypassPermissions` for the reason
   Dreaming uses it: a timer-started run has nobody to answer the prompt
   `acceptEdits` raises for `python3 _Meta/qc.py`
   (`docs/agent/dreaming/the-writer.md:35`–`:40`).
3. Save a workflow with one run block on that template and a workflow-wide
   limit of $1, because a schedule refuses a workflow without one
   (`src/lib/schedules.ts:537`–`:547`).
4. Schedule it weekly, at a time that is not Dreaming's 03:04.

The template's prompt is the whole design: read `CLAUDE.md` first, run
`python3 _Meta/qc.py --only KW` and the other Haiku-class families, fix at most
a handful of notes in place, bump `updated:`, re-run qc on each, regenerate the
index, stop.

## Its strongest case

- **It costs nothing to try and measures the one thing nobody has.** No line of
  code, and the first pass is a real measurement of Haiku 5.5 on this vault —
  ModelRouter closed on exactly that gap: whether a cheaper model completes any
  of this install's real tasks "the assumption the whole survey rests on,
  unmeasured" (`git show 'fab9fb5e^:proposals/notRecomended - ModelRouter/15-validation.md'`,
  lines 180–182).
- **Dreaming has already proven the shape.** An unattended, unisolated run in
  the vault root under `bypassPermissions` with a spend cap is how the vault's
  only writer works today (`src/lib/dreamingRun.ts:370`–`:397`).
- **Serialisation is free.** A run at the vault root holds the whole mount, so
  it queues behind Dreaming and Dreaming behind it (`docs/runs.md:534`–`:535`).
- **It is visible.** It is an ordinary run: on `/runs`, in `runs.spent_usd`,
  counted against the install limit
  (`docs/agent/dreaming/the-writer.md:7`–`:15`).

## The case against, in this install

- **No undo, and no check the model cannot skip.** The pre-image and the
  "qc must not get worse" rule exist only as sentences in a prompt (C2). A
  Haiku session that forgets one leaves a changed vault with no record but a
  tool-call log that does not see Bash edits.
- **The model is its own planner, and qc's report is large.** `qc.py`'s full
  output is 73,283 bytes — ~18k estimated tokens, a third of the room under
  the cliff (C3) — and all but 5 of its 418 findings, or 90 if the operator
  wants non-hub Related lists trimmed, are not Haiku's to fix (00 §3).
  Each pass either reads it and pays for the noise or trusts `--only` filters a
  prompt names.
- **Every fire starts a model**, even when there is nothing to do. On Haiku
  that is about a cent (08 §4); the cost is not money but an unattended write
  window each time.
- **It cannot take a board task.** Run blocks, templates and schedules cannot
  attach tasks; only `propose_run` and `emit_runs` can (C9). The three
  Haiku-class corpus tasks stay on the board.
- **The catalogue switch would not stop it.** Workflows never call
  `modelRefusal` (C4), so the switch is not a safety interlock for this path —
  only for the run form.

## What it costs

No build. Per pass, about $0.01 idle and $0.07–0.35 working; $0.30–1.70 a
month weekly or nightly ([`08-comparison.md`](08-comparison.md) §4).

## Verdict

**The right delivery for a trial, and the right shell for Option D's Haiku
half — not enough on its own.** It lacks a deterministic gate in front of the
model and an undo behind it, and both are cheap to add as vault-side code
([Option D](05-option-d-scripts-then-haiku.md)).
