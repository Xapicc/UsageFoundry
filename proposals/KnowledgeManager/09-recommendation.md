# 09 — Recommendation

## In one line

**Build no Knowledge Manager feature in the app. Make Dreaming keep its own
hubs current (Option F) now; run the spike in [`11-validation.md`](11-validation.md)
on a copy of the vault; and if Haiku 5.5 passes, ship Option D — a vault-side
`_Meta/housekeeping.py` written once by a frontier run, driven by a
Haiku-pinned template that a one-block scheduled workflow runs weekly and the
operator runs on demand.**

This is **against** a third half of Dreaming, **against** a separate in-app
feature with its own clock, ledger and pane, and **for** a cheap Haiku pass on
one measured condition.

## The case

1. **The premise holds for price and fails for volume.** Haiku 5.5 would have
   done the one past housekeeping session for $0.07 instead of $3.54
   ([`08-comparison.md`](08-comparison.md) §4). But of qc.py's 418 findings, six
   are Haiku's and about 23 a script's; the rest is research debt and WARNs the
   vault keeps on purpose. Of fourteen open vault tasks on the board, one is
   mechanical and three are Haiku-class
   ([`00-problem.md`](00-problem.md) §3–§4). A few jobs a week do not need a
   feature; they need a pass that is safe and cheap.
2. **Most of what is Haiku-shaped is debt Dreaming leaves on its own hubs.** Two
   of the three Haiku-class tasks are a batch not yet logged and an abstract
   its batches outgrew, and all three were filed by Dreaming nights. Telling the
   writer that already has the hub open costs a paragraph of prompt; a second
   writer to tidy after it costs a second unattended authority (Option F).
3. **The danger is the store, not the model's price.** The vault has no undo,
   and a run there gets none of the app's — no diff, review, land or validation
   ([`01-constraints.md`](01-constraints.md) C1), with nothing but the prompt
   bounding where it writes (C2). Option D adds the undo as code with tests:
   a whole-vault pre-image before the first write (0.5 s, 6.66 MB), a changeset
   of what changed, a `revert` that never overwrites a person, and a qc gate.
   It runs inside the run's sandbox and leaves the vault owning its own
   definition of wrong (C10).
4. **The app already has the delivery.** A template pins the model, the
   folder, the permission mode and the guards; a one-block workflow with a
   limit can be scheduled weekly (C7). The folder claim queues the pass behind
   Dreaming for free (C6).
5. **The cliff is handled by construction, not by hope.** Reading lists of
   neighbours' abstracts keep a job's context at p99 14.6k; six notes a session
   is the measured room under 100k after a 47k floor; one work cycle per pass,
   because a second resumes the first's context (08 §3).

## The shape to build, if the spike passes

- **Vault side, one frontier vault task:** `_Meta/housekeeping.py` with `plan`,
  `snapshot`, `fix --mechanical`, `verify`, `revert`; `unittest` tests beside
  `test_retrieval.py`; `housekeeping` added to `vaultlib.SKIP_DIRS`.
- **Operator side, no code:** switch `claude-haiku-5-5` on in the catalogue
  after U1; save the "Knowledge Manager" template (vault root, *This folder*,
  `bypassPermissions`, `claude-haiku-5-5`, $0.50, one work cycle, 20 minutes);
  a one-block workflow with a $1 limit; a weekly schedule two hours after
  Dreaming's night.
- **App side, a few lines:** the vault skill's "exactly one job … writes here"
  (`src/lib/vaultSkill.ts:316`) and Dreaming's "only setting … that authorises
  an unattended write" (`docs/agent/dreaming/halves-and-write-policy.md:13`) are
  rewritten to name the second writer; Option F's paragraph in
  `buildDreamingPrompt` (`src/lib/dreamingRun.ts:135`) with an assertion beside
  the existing ones in `src/lib/dreaming.test.ts:172`.
- **The board:** the pass takes no task — templates and run blocks cannot
  attach one (C9). It files at most one task per pass for findings outside its
  scope. A Haiku-class board task is run on demand through the chat's
  `propose_run` with the template. `needsFrontier` is **not** the routing
  signal as it stands (C8); [`10-implementation-sketch.md`](10-implementation-sketch.md)
  §6 sketches the change that would make it one, if the operator wants the
  guard.

## Refused by name

- **A third half of Dreaming (B).** Its ledger is keyed on error signatures
  and its retraction reads a moved file as a person's deletion (C5).
- **A separate in-app feature (C)**, for now — its clock, tables and pane are
  sized for a backlog the measurement did not find.
- **A local model (E).** Cents saved; a weaker editor; no review gate for a
  non-git folder.
- **Any write path in the app** — a Fix button on `/knowledge`, an app-side
  restore (C10).
- **Haiku as its own reviewer, or as a completion validator.** "A wrong 'done'
  from a weaker judge closes a task nobody reopens"
  (`proposals/LocalModelOffload/09-recommendation.md:69`–`:70`), and the app
  already says Haiku is not frontier (`src/lib/localCertification.ts:112`–`:116`).
- **Haiku on research debt** — source notes, quotes, confidence, seeds, claims
  ([`00-problem.md`](00-problem.md) §5).
- **A nightly cadence**, until four weekly plans show the inflow needs one
  (U5).

## What else would change it

- **The pinned CLI cannot run `claude-haiku-5-5` (U1).** Nothing here ships
  until the pin moves; Option F and the deterministic half of D still do.
- **The spike shows a skipped `snapshot` or `verify`.** Then the envelope has
  to move out of the model's hands: build Option C's app-side changeset, around
  Dreaming as well, before any Haiku pass runs unattended.
- **Four weekly plans show more than one session's cap of Haiku jobs a week.**
  Then go nightly, and the cap — not the cadence — is what stays measured.

## The fact that would overturn it

**One edit, in the spike, in which Haiku 5.5 changes or misstates a claim
that `verify` cannot see.** qc and the write set catch structure; a rewritten
abstract that says something its note does not is caught only by the frontier
reviewer, and in production there is none. If the spike finds one, the Haiku
half is not built: the deterministic half of D ships alone, and the judgement
jobs stay frontier board tasks, run on demand.
