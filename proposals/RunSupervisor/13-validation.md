# 13: Validation

§1 tests the recommendation before any of it is built. §2 says how to test the
supervisor before building it, should the overturning fact fire. §3 fixes every
threshold in advance. §4 lists what this survey measured and what it did not.

## 1. Test B before building it: do it by hand on the next decision

B's premise is that a decision answered to the run that asked costs less than one
answered to a fresh run, and that the operator would answer that way. Both can be
tried today with no code, because the pick-up route already exists.

1. **On the next `needs-review` ending whose reason is a decision** (a choice
   among options, a deployment call, a missing brief), press Resume on its page.
   Type the answer as the note, and raise its cycle limit by one. That is exactly
   what Phase 1 will do in one press.
2. **Read its next cycle's prompt** under the cycle row on the run page. It should
   be the note, verbatim. Then check that the cycle acted on it: its first actions
   should follow from the answer, not re-read what the asking cycle read.
3. **Compare** the resumed segment's spend and cycles with a fresh run on the same
   decision. The fresh run is either the last time a decision of that shape was
   briefed to a new run, or, if there is none, the run the operator would
   otherwise have started.

   ```sh
   docker exec -i usagefoundry sqlite3 -readonly /data/usagefoundry.db \
     "SELECT id, iterations, spent_usd, reopened_at FROM runs WHERE id IN ('<resumed>','<fresh>');"
   ```

   This gives cumulative spend. The resumed segment is the difference from the
   figure recorded at the ending, which the run page's spend breakdown shows per
   cycle.

**B is confirmed** if, on two such decisions, the resumed segment finished the
decided work in fewer cycles than a fresh run would have needed, and the operator
found the Resume-with-note path natural. **B is refuted**, and A is the answer,
if the operator would rather brief a fresh run anyway. In that case the box is
built for a habit nobody has.

## 2. Test D before building it, only if the overturning fact fires

A work cycle cannot call the Claude API (a nested `claude -p` answers "Not logged
in"), so this is the operator's to run.

1. Take the qualifying questions: the three or more that fired the threshold in
   §3.
2. For each, compose Tier 1's prompt **by hand** from what
   [D](06-option-d-tiered-supervisor.md) §2 lists:
   - the question, framed as untrusted;
   - the run's task text;
   - the operator's turns from the proposing chat, if any;
   - the repository's `CLAUDE.md`;
   - for an error, the matching `list_recurring_failures` entries, which the chat
     can fetch.
3. Run it from the operator's own shell in the vault gate's argv shape:

   ```sh
   claude -p --model claude-haiku-5-5 --tools "" --setting-sources "" \
     --strict-mcp-config --disable-slash-commands --max-budget-usd 0.10 \
     --output-format json < prompt.txt
   ```

4. Score each answer: correct, with a source that says so; wrong; or `escalate`.

**Build D only if** at least two of three are correct with sources and none is a
confident wrong answer. A confident wrong answer is the failure mode that makes a
supervisor worse than none, because the run takes it with the supervisor's
authority. Note: 2.1.280 did not know `claude-haiku-5-5` and priced it at a fallback rate;
the current pin, 2.1.310, does (`docs/agent/run-lifecycle/vault-pointer.md:25`).

## 3. Thresholds, fixed before anything is built

All are read from `scripts/readout.sql` (Phase 2), plus a hand classification of
reasons and notes by [`scripts/rules.txt`](scripts/rules.txt), over a four-week
window after Phase 1 ships.

| | Threshold | If it fires |
|---|---|---|
| **B's floor** | Fewer than 2 `needs-review` endings in the window | The box is moot, not wrong. Leave it, and measure again in a quarter |
| **B's kill criterion** | Of the first five decision-shaped `needs-review` endings after Phase 1 ships, **however long they take to arrive** (about five weeks at October's rate, so this one is not on the four-week window), the operator answers **at most one** through the box | Revert Phase 1. A is the answer |
| **C's trigger** | **Two or more** pick-ups in the window that `reopenRun` refused because another run took the worktree slot (`src/lib/orchestrator.ts:15893`-`:15901`). **The readout cannot count this.** The refusal sentence is returned in the 400 and shown once in the Resume form (`src/app/runs/[id]/page.tsx:1374`-`:1375`), and stored nowhere. `request_log` keeps only the status (`src/app/api/runs/[id]/reopen/route.ts:108`), and every reopen refusal is a 400. So the operator counts it, from the form | Build Phase 4 |
| **D's trigger (the overturning fact)** | **Three or more** MODEL-ANSWERABLE questions across `needs-review` reasons, notes given through the box, and decision tasks runs filed, of which **two** are not one recurring cause that a sentence in `CLAUDE.md` or a notice would fix | Run §2, then build Phase 3 if it passes |
| **D's floor, once built** | Fewer than 1 call per 50 runs over four weeks | Remove the tool. A channel found as rarely as `ask_operator` was is a standing tool cost for nothing |
| **D's kill criterion, once built** | More than 1 call per 5 runs, **or** more than half of calls NOT A QUESTION under `rules.txt` | Remove the tool. The operator questions survey set "more than about one turn in five" as its own removal bar (*UsageFoundry Operator Questions Proposal*, vault, `confidence: low`, `status: archived`); a call that asks what the run could read is the habituation surface C10 names |

**The confound to correct for.** More than half of briefs on this install say
nobody will answer (268 of 494, [`00-problem.md`](00-problem.md) §1). If the
operator drops that line once Phase 1 ships, the D trigger has to be read only
over runs whose briefs no longer say it. Otherwise the count is suppressed by the
very text the channel replaces.

## 4. What was verified, and what was not

**Measured.**

- The traffic: 494 runs, 2026-10-01 to 2026-10-27, by `scripts/measure-all.sh`.
  It was re-run independently for this survey, with identical figures.
- The classification: every instance in kinds (a), (c)-already-done and (d), a
  seeded sample of 25 for (c)-judgement-calls, and mechanical rules for (b). The
  labels and their evidence are in `scripts/labels/`.
- The chat's `ask_operator` recount: 3 calls in 142 operator turns.
- The pinned CLI's MCP limits:
  - 60 s for plain JSON;
  - 300 s idle for SSE;
  - progress extends the idle limit and not the hard one;
  - a per-server `timeout` raises both;
  - a `tool_progress` heartbeat every 30 s.

  Run once each by `scripts/mcp-wait-probe.sh`. The 60 s failure and the 90 s
  success under `"timeout": 120000` were re-run for this file and agreed.
- Codex 0.153.4's MCP limit: 300 s wall clock, silent meanwhile, moved by
  `tool_timeout_sec`. By `scripts/codex-mcp-timeout-probe.sh`.
- `--input-format stream-json`, by `scripts/live-turn-probe.sh` across 13 cases:
  - it folds into the turn at the next request;
  - it cannot release a pending tool;
  - cost is cumulative per `result`;
  - EOF ends the process;
  - the positional prompt is ignored;
  - `--replay-user-messages` frames carry `isReplay:true`;
  - `--resume` composes.

  The base fold was re-run for this file.
- `node scripts/check-citations.mjs` resolves every `path:line` at the commit that
  adds this directory, which proves only that the line exists. About 55 citations
  the argument rests on were then read back for content by an independent check,
  which found six that pointed at the wrong line or said less than claimed. Those
  are corrected. The rest were not each re-read.

**Assumed or not established.**

- **Whether the operator would use the answer box.** Zero pick-up notes in the
  window is the only evidence, and it cuts both ways. §1 tests it.
- **Whether a pick-up was ever refused for a taken slot.** Transcripts cannot show
  a refused HTTP request, and the app keeps the status of one and never its reason
  (C's trigger in §3), so this one rests on the operator noticing.
- **Codex mid-run input.** `codex queue` exists, but whether it reaches an `exec`
  turn is not established. The command that settles it is in
  [`02-what-already-asks.md`](02-what-already-asks.md) §7.
- **A resume of the chat session under `--tools ""` (U4).** Not run, because
  Option E is rejected without it.
- **What a Tier 1 call costs on this install's sources.** Assumed under $0.05 by
  analogy with the vault gate's $0.002. Not measured, because a work cycle has no
  credentials.
- **Codex and local runs' asking.** They leave no transcripts here, so the traffic
  is Claude runs only.
- **Anything before 2026-10-01.** No transcript survives.
- **The vault's "152 operator turns"** was not reproduced. This corpus's window
  differs, and its 3 calls agree.
