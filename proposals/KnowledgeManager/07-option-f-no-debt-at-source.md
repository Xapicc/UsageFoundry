# Option F — no manager: stop the debt where it is made

## What it is in this app

Three changes, none of which adds a writer:

1. **Dreaming keeps its own hubs current.** Its writer prompt
   (`src/lib/dreamingRun.ts:163`–`:205`) gains a paragraph: when you add a batch
   to a hub, add the batch's log entry and update the abstract's count in the
   same edit, and bump `updated:`.
2. **The operator settles the Inbox.** Six of qc.py's seven ERRORs are two
   untriaged captures whose template has no Related section by design (00 §3).
   Either qc.py exempts `3 Resources/Questions/Inbox/` from `BODY/related`,
   `LINK/*` and `SEED/parent` — a convention change, written down in
   `_Meta/Vault Conventions.md` — or triage gets a cadence. Both are the
   operator's call (`4e67ffc1` names both).
3. **The stock is cleared once**, on demand: the nine mechanical findings, the
   five keyword findings, and `11b1e89d`'s ten tag replacements outside the
   Inbox, as one run.

## Its strongest case

- **It answers the inflow, not the symptoms.** Two of the three Haiku-class
  corpus tasks are leftovers of Dreaming's own nightly hub edits, and six of the
  seven ERRORs are one missing qc.py policy (00 §3–§4). Fix those two sources
  and the Haiku-class inflow is a keyword slip now and then and an occasional
  capture — plus the non-hub Related lists, if the operator wants them trimmed.
- **Nearly free.** Dreaming already has the hub open when it adds a batch, so
  the extra work is a few hundred output tokens a night — 300 at Opus 5.5's
  $20/MTok (`src/lib/pricing.ts:107`) is $0.006 — plus a re-read of the hub if
  it has left the cache, **assumed** rare within one pass.
- **No second unattended writer.** Every sentence C5 lists stays true, and the
  objections ContinuousImprovement raised against an automatic, billed,
  model-authored writer — that "spend nobody asked for is spend nobody
  authorised" and that "the write side and the read side must not have the
  same author" (`proposals/ContinuousImprovement/10-option-retrospective.md:362`–`:369`,
  `proposals/ContinuousImprovement/01-constraints.md:107`–`:118`) — never arise.

## The case against, in this install

- **It does nothing for debt nobody owns.** Research runs leave keyword slips,
  unexplained Related links, Related lists that outgrow eight, and abstracts
  that drift as notes grow; they do not come back to them. It is small, but it
  is not zero, and it grows with the vault.
- **It puts upkeep on the expensive model.** The writer passes no model, so it
  runs on the operator's default (`src/lib/dreamingRun.ts:370`–`:397`) — Opus 5.5
  in every Dreaming transcript since 2026-09-26, by the model column of
  [`scripts/vault-cost.mjs`](scripts/vault-cost.mjs)'s output — and its upkeep
  costs forty times Haiku's rate below the cliff, and 6.7 times on a night like
  2026-10-08's, most of whose requests were over it (08 §4).
- **It is not what the operator asked for**, and the stock still needs one pass.

## What it costs

A paragraph of prompt in `dreamingRun.ts`, one operator decision, one on-demand
run for the stock.

## Verdict

**Do it regardless.** It is the companion to Option D, not its rival: it takes
the debt Dreaming makes off the manager's list, so the manager's list is what
nobody owns. If the spike fails, F alone is the honest "build nothing".
