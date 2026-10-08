# 08 — Comparison, trigger, write safety and cost

## 1. The options side by side

| | A — primitives only | B — third half of Dreaming | C — separate feature | D — scripts, then Haiku | E — local model | F — no debt at source |
|---|---|---|---|---|---|---|
| **Who does the deterministic part** | the model, from qc's 73 KB report | the model, from tonight's `NOTE` lines | a model run (the app may not run qc.py, C10) | `housekeeping.py`, no model | as D | nobody needs to |
| **An idle pass** | starts a model (~$0.01) | starts a model on nights Dreaming writes | starts a model | one short session that reads an empty plan | starts the Mac's model | nothing runs |
| **Undo** | none | none | app-side changeset; restore needs a write path the app refused | pre-images and a hash-guarded `revert`, vault-side | none | n/a |
| **Write set, cap, qc gate** | prompt only | prompt only | detected after the fact by a hash the session cannot reach | `verify`, code with tests, reverting on its own; *calling* it is the prompt's, and it runs inside the session it judges | prompt only | n/a |
| **Collides with Dreaming** | no; queues behind it (C6) | yes: ledger, retraction, switch (C5) | no | no | no | edits Dreaming's prompt |
| **Covers debt Dreaming did not make** | yes | no, unless it outgrows its name | yes | yes | yes | no |
| **Takes board tasks** | no (C9) | no | could, with code | no; files at most one | no | no |
| **Build** | none | ~1–2 d (**assumed**) | ~4–6 d (**assumed**) | one or two vault frontier runs (**assumed** $12–32) + a few app lines | as D | a prompt paragraph and one decision |
| **Per pass** | $0.01 idle, $0.07–0.35 working | a working pass, on nights Dreaming writes (**assumed**) | as A | as A | $0 | under a cent, on Opus |
| **Verdict** | the trial's shell | **no** | **not now** | **recommended** | **no** | **do regardless** |

Sources: each option's own file; §4 for the money.

There is no weighted score, for the reason LocalModelOffload gave
(`proposals/LocalModelOffload/08-comparison.md:25`–`:37`): the quantity that
decides between "build D" and "build nothing" — whether Haiku 5.5 follows the
write rules on this vault — is exactly the one nobody has measured (U4). A
weighted total would encode a guess about it.

## 2. Trigger

The inflow depends on one operator decision (00 §6). Without non-hub Related
trims it is a few jobs a week: five keyword findings today, four Inbox captures
since 2026-08-16, three Haiku-class board tasks filed between 2026-09-30 and
10-08. With them, add a stock of 85 and roughly ten new ones a week.

| Trigger | Fits that inflow | Cost of getting it wrong — too often | — too rarely |
|---|---|---|---|
| **Nightly** | only with trims on | ~$0.29 a month of idle sessions (§4), and thirty unattended write windows a month on a store with no undo; at 03:04 it would queue behind Dreaming (C6) | none |
| **Weekly** | yes, without trims: one session's five notes | an idle week costs a cent | with trims on, ten a week outrun one session and the stock never drains |
| **After a vault-writing run** | yes — the debt is made there | nothing in the app reacts to what a run wrote (C7), so it is code; 19 research runs and 18 Dreaming nights in the month since 2026-09-08 ([`scripts/vault-cost.mjs`](scripts/vault-cost.mjs)) would be dozens of tiny passes | none |
| **qc regression** | partly | qc's counts rise with research debt — every new note citing an unsourced URL adds a `CONF/ungraded` WARN — so a regression trigger fires on work the manager must not do; and a poll still needs a clock (C7) | debt the trigger's families do not count waits |
| **On demand** | yes | none | the work waits for somebody to remember; the three Haiku-class board tasks have waited up to eight days, at `priority: low` |

**Weekly, plus on demand**, scheduled a couple of hours after Dreaming's night —
and **daily** (the schedule's every-24-hours choice, `src/lib/schedules.ts:53`–`:68`)
if the operator turns non-hub trims on, until the stock is gone. An empty pass
costs a cent, and the operator can press Run whenever a board task asks for it.
Getting it wrong towards "too rarely" costs a week's delay on low-priority
upkeep; towards "too often" costs unattended exposure for no work. Revisit when
four plans (U5) say otherwise.

## 3. Write safety

**What undo exists today: none.** No git, no `.trash/`, no backup plugin, no
snapshot convention; the app's diff, review, land and validation all switch off
for a run in this folder (C1). Obsidian's File Recovery is Mac-side and
**assumed** blind to edits made from the container (U6). The only record of a
vault run's writes is the touch scan, which does not see Bash edits (C2).

**What this design adds**, in Option D's form:

1. **A whole-vault pre-image before the first write.** `snapshot` tars every
   `.md` — measured at 0.5 s and 6.66 MB compressed — plus everything under
   `_Meta/` and `.obsidian/`, into `_Meta/.housekeeping/pending/`, so nothing
   the session does, by any tool, is unrecoverable.
2. **A changeset, not a log.** `verify` keeps only the pre-images of files that
   changed, in a tarball beside a manifest of path, before hash, after hash, job
   and reason. Nothing it keeps is a `.md` file, so no walker — qc.py's, the
   index's, the app's, **assumed** Obsidian's — reads a pre-image as a note.
3. **`revert` that never overwrites a person.** A pre-image goes back only if
   the live file still hashes to the post-image; anything edited since is
   reported, not restored (C12).
4. **qc must not get worse.** For every changed file, qc's findings after the
   pass must be a subset of those before it; one new finding fails the pass, and
   `verify` reverts it.
5. **Propose-only for everything that is not an in-place edit.** Create,
   delete, move, rename, merge, every Inbox outcome and every reversal of a
   recorded decision go into the pass's report, and at most one board task per
   pass, deduplicated with `list_my_tasks`' `query` — never done.
6. **An edit cap measured, not chosen** — in the way Dreaming's recurrence
   threshold was measured (`docs/agent/dreaming/halves-and-write-policy.md:30`–`:40`),
   and unlike its per-night cap of five (`src/lib/settings.ts:1163`), which was
   reasoned from a first night's 77 signatures rather than measured
   (`src/lib/settings.ts:944`–`:953`). The cap is the cliff:
   - the highest first-request floor on a vault session is **47,363** tokens,
     which leaves **52,637** under 100,000;
   - the pass's own plan, command output and replies need part of that —
     reserved at **12,637**, **assumed** from the one housekeeping session, whose
     prompt grew by about 50k over 57 requests while fixing eleven findings;
   - that leaves a packing budget of **40,000**; a p90 note read once and
     written once is 2 × 3,855 = **7,710**; **40,000 / 7,710 = 5.2, so five
     notes per session**, and `plan` also stops packing at 40,000 estimated
     tokens;
   - a note over 20,000 — half the budget — is packed alone, and one over
     40,000 (`Standing Failures in This Install.md`, 42.4k) gets a reading list
     of its headings and abstract instead of its body;
   - the template does **not** tell the session to open `CLAUDE.md`: the floor
     already holds it (**assumed**, C3), and a second read is 5.3k of the room.

   One pass is one work cycle (`maxIterations` 1), because a second cycle
   resumes the same session with all of the first one's context and would cross
   the cliff — ModelRouter's warning that `maxIterations` 1 starves a cheap
   model (`git show 'fab9fb5e^:proposals/notRecomended - ModelRouter/13-recommendation.md'`,
   lines 95–100) is here the point: unfinished jobs return in the next plan.

**What the manager may never do:**

- create, delete, move or rename a note — or touch `_to_delete/`, `.obsidian/`
  or anything that is not a note, outside its own `_Meta/.housekeeping/`;
- change `confidence`, `status`, `evidence`, `peer_reviewed`, `type`, `title`,
  `created` or `sources:`, or any sentence of a note's body outside the
  abstract callout, `## Related` and a hub's log section — that is, a claim;
- edit its own judge: `qc.py`, `vaultlib.py`, `build_index.py`,
  `housekeeping.py`, or any other `_Meta/` script — the one rule `verify`
  cannot enforce on itself (Option D, "The case against");
- edit `CLAUDE.md`, `AGENTS.md`, `_Templates/`, or `2 Areas/Engineering Standards/`
  (installed into every session's rules, `/workspace2/AGENTS.md:102`);
- edit `_Meta/Tag Index.md` except to append a definition under an existing
  subtree for a tag a note already uses and the index has not rejected;
- read `INDEX.md`, or either MOC whole — a MOC edit is a `Grep` and an `Edit`;
- edit a note modified in the last hour by anyone else.

## 4. Cost

**Prices** (`src/lib/pricing.ts:167`–`:171`, $/MTok, below and above a
100,000-token prompt): input 0.10 / 0.50, 1-hour cache write 0.20 / 1.00, cache
read 0.01 / 0.05, output 0.50 / 2.50.

**An idle pass** — `plan` finds nothing: one session of about three requests.
The first writes its ~47,363-token prefix to the cache:
47,363 × $0.20 / 1e6 = **$0.0095**; two more read it back and write ~1.5k each,
2 × (47,363 × $0.01 + 1,500 × $0.20) / 1e6 = $0.0015; ~1,000 output tokens,
$0.0005. **About $0.011.**

**A working pass**, modelled on the one past housekeeping session that did this
kind of work — `6fd8d400`, eleven qc ERRORs fixed on Opus 5, 57 requests, first
request 34,398, peak 84,670, never over the cliff — with its tokens re-priced on
Haiku 5.5: 39,739 × 0.10 + 87,415 × 0.20 + 3,497,094 × 0.01 + 28,558 × 0.50 =
$0.00397 + $0.01748 + $0.03497 + $0.01428 = **$0.0707**. That is the low end.
Started from the 47,363 floor instead, and with Haiku taking twice the turns —
**assumed**, ModelRouter's "honest prior is that it would emit more"
(`git show 'fab9fb5e^:proposals/notRecomended - ModelRouter/13-recommendation.md'`,
lines 29–33) — the session would cross 100k and pay five times for most of
its requests: the high end is five times the low, **$0.35**. The cap in §3
exists to keep passes at the low end; the spike measures where they land.

**A month.** Weekly: 4.35 × $0.07–0.35 = **$0.30–1.52**. Nightly, with four
working passes and 26 idle: 26 × $0.011 + 4 × $0.07–0.35 = $0.29 + $0.28–1.40 =
**$0.57–1.69**. With non-hub trims on: the 85-note stock is 17 sessions of five,
17 × $0.07–0.35 = **$1.19–5.95 once**, and ten new a week is two sessions a week,
8.7 a month × $0.07–0.35 = **$0.61–3.05 a month** on top.

**Against frontier runs doing the same work.** The same `6fd8d400` tokens cost
$3.54 on Opus 5 as run, **$2.13 on Opus 5.5** at today's rates
(39,739 × 4 + 87,415 × 8 + 3,497,094 × 0.20 + 28,558 × 20, `src/lib/pricing.ts:107`)
and $1.41 on Sonnet 5 — so weekly upkeep by Opus 5.5 would be 4.35 × $2.13 =
**$9.27 a month** against Haiku's **$0.30–1.52**.

**Against what the vault costs.** All vault sessions since 2026-09-01 cost
$514.61 at list price; research runs $336.21 (19 sessions, $8.91–$37.30),
Dreaming $123.38 (18 nights, $2.79–$14.26), vault tooling $51.28, and
housekeeping **$3.75** — two sessions, $0.21 and $3.54
([`scripts/vault-cost.mjs`](scripts/vault-cost.mjs), sessions grouped by hand
from the first prompt each one's JSON record carries; a session is **assumed**
to be a run, since later cycles resume the same file). The "$15–$38 per vault
run" in the brief is true of research runs (10 of 19 fall in it) and of no
housekeeping or Dreaming session. Spend here is recorded from the CLI's own
`total_cost_usd` (`src/lib/orchestrator.ts:9566`), not recomputed; the figures
above are list price from transcripts, and no `runs.spent_usd` row could be read
(`/data` is denied to a work cycle).

**So money is not the argument.** A Haiku manager saves about $8–9 a month
against the same upkeep on Opus 5.5 — and in practice nobody does that upkeep,
so it saves nothing and gets the work done. The cliff matters more than the
headline rate: the 2026-10-08 Dreaming night re-priced on Haiku is $0.94 as
run, against $6.32 on Opus 5.5 — 6.7 times cheaper, not forty — and $0.22 had
none of its requests crossed 100k; 63 of its 75 did.

**One-off costs.** `housekeeping.py` by a frontier run: vault tooling sessions
measured $4.48–$15.96, median $12.16, so one or two runs is **assumed**
$12–32. The spike in [`11-validation.md`](11-validation.md): 18 Haiku sessions
at $0.05–0.15, 9 Opus 5.5 control sessions at $1–2 and a reviewer at $3–6 —
**assumed** $13–27 in all.

## 5. What dominates what

- **D dominates A**: the same delivery — template, workflow, schedule — with a
  gate in front of the model and an undo behind it.
- **F dominates B** on the debt Dreaming makes, without a second writer; B's
  remaining scope is C's.
- **D dominates E**: E saves cents and loses the editor quality and the one
  review gate weaker models get.
- **C has one thing D lacks** — a check the session cannot reach, so cannot
  skip or rewrite — and it is worth more around Dreaming than around a manager.
